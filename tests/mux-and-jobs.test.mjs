import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractAntigravityHandoff } from "../scripts/lib/agy-session-transfer.mjs";
import { collectReviewContext } from "../scripts/lib/git.mjs";
import { CodexJobManager } from "../scripts/lib/job-manager.mjs";
import { runCommand, runCommandChecked } from "../scripts/lib/process.mjs";
import { resolveWorktreesDir } from "../scripts/lib/state-store.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, "..");
const FAKE_CODEX = path.join(TEST_DIR, "fake-codex.mjs");

function createTempGitRepo(name = "repo") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-agy-${name}-`));
  runCommandChecked("git", ["init", "-b", "main"], { cwd: dir });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  runCommandChecked("git", ["config", "user.name", "Test User"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "app.js"), "export const x = 1;\n", "utf8");
  runCommandChecked("git", ["add", "."], { cwd: dir });
  runCommandChecked("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

test("concurrent multi-thread routing, child collabAgentToolCall, and inferred completion", async () => {
  const repo = createTempGitRepo("mux");
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-data-"));
  process.env.PLUGIN_DATA = pluginData;

  const manager = new CodexJobManager({
    pluginRoot: PLUGIN_ROOT,
    codexBin: FAKE_CODEX,
    inferredCompletionDelayMs: 60
  });

  try {
    const [j1, j2] = await Promise.all([
      manager.startTask({ cwd: repo, prompt: "[COLLAB] [SLOW:80] task one", conversationId: "conv-1" }),
      manager.startTask({ cwd: repo, prompt: "[INFER_COMPLETE] [SLOW:40] task two", conversationId: "conv-1" })
    ]);

    assert.notEqual(j1.threadId, j2.threadId);

    const waited = await manager.waitForJobs({
      cwd: repo,
      jobIds: [j1.jobId, j2.jobId],
      waitMode: "all",
      timeoutMs: 5_000
    });

    assert.equal(waited.timedOut, false);
    assert.equal(waited.completed.length, 2);

    const r1 = waited.completed.find((c) => c.jobId === j1.jobId);
    const r2 = waited.completed.find((c) => c.jobId === j2.jobId);
    assert.equal(r1.status, "completed");
    assert.match(r1.finalMessage, /task one/);
    assert.deepEqual(r1.filesChanged, ["src/child.js"]);

    assert.equal(r2.status, "completed");
    assert.match(r2.finalMessage, /task two/);
  } finally {
    await manager.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("standard review, adversarial review schema parsing, and focus guard", async () => {
  const repo = createTempGitRepo("review");
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-data-"));
  process.env.PLUGIN_DATA = pluginData;
  fs.writeFileSync(path.join(repo, "app.js"), "export const x = 2;\n", "utf8");

  const manager = new CodexJobManager({ pluginRoot: PLUGIN_ROOT, codexBin: FAKE_CODEX });

  try {
    await assert.rejects(
      () => manager.runReview({ cwd: repo, mode: "standard", focus: "check auth" }),
      /does not support custom `focus`/
    );

    const standard = await manager.runReview({ cwd: repo, mode: "standard", delivery: "detached" });
    assert.equal(standard.status, "completed");
    assert.match(standard.reviewText, /uncommittedChanges/);

    const adv = await manager.runReview({ cwd: repo, mode: "adversarial", focus: "check input validation" });
    assert.equal(adv.status, "completed");
    assert.equal(adv.structuredReview.verdict, "needs-attention");
    assert.equal(adv.structuredReview.findings.length, 1);
  } finally {
    await manager.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("steer, -32601 capability fallback, approval bridge, worktree isolation, and crash recovery", async () => {
  const repo = createTempGitRepo("control");
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-data-"));
  process.env.PLUGIN_DATA = pluginData;

  const manager = new CodexJobManager({ pluginRoot: PLUGIN_ROOT, codexBin: FAKE_CODEX });

  try {
    // 1. Steer mid-flight
    const started = await manager.startTask({ cwd: repo, prompt: "[SLOW:200] steer target" });
    const steerRes = await manager.steerJob({ jobId: started.jobId, guidance: "use v2 schema" });
    assert.equal(steerRes.ok, true);
    const waitedSteer = await manager.waitForJobs({ cwd: repo, jobIds: [started.jobId], waitMode: "all", timeoutMs: 5_000 });
    assert.match(waitedSteer.completed[0].finalMessage, /STEERED:use v2 schema/);

    // 2. Approval bridge (approvalPolicy: on-request)
    const approvalJob = await manager.startTask({
      cwd: repo,
      prompt: "[APPROVAL] run tests",
      approvalPolicy: "on-request"
    });
    const waitApproval = await manager.waitForJobs({ cwd: repo, jobIds: [approvalJob.jobId], timeoutMs: 5_000 });
    assert.equal(waitApproval.awaitingInput.length, 1);
    const reqId = waitApproval.awaitingInput[0].pendingRequest.requestId;

    const respondRes = await manager.respondToJob({ jobId: approvalJob.jobId, requestId: reqId, decision: "accept" });
    assert.equal(respondRes.ok, true);

    const afterApprove = await manager.waitForJobs({ cwd: repo, jobIds: [approvalJob.jobId], waitMode: "all", timeoutMs: 5_000 });
    assert.equal(afterApprove.completed[0].finalMessage, "APPROVED:accept");

    // 3. Worktree creation, re-entry guard, and interrupt cleanup
    const wtJob = await manager.startTask({ cwd: repo, prompt: "[SLOW:2000] isolated edit", worktree: "create" });
    assert.ok(wtJob.worktreePath && fs.existsSync(wtJob.worktreePath));

    // Nested worktree must be rejected
    await assert.rejects(
      () => manager.startTask({ cwd: wtJob.worktreePath, prompt: "nested", worktree: "create" }),
      /Refusing to create a nested git worktree/
    );

    const cancelRes = await manager.interruptJob({ cwd: repo, jobId: wtJob.jobId, cleanupWorktree: true });
    assert.equal(cancelRes.status, "cancelled");
    assert.equal(cancelRes.worktreeCleaned, true);
    assert.equal(fs.existsSync(wtJob.worktreePath), false);

    // 4. Crash recovery: crashed app-server marks job failed, next run transparently reconnects
    const crashed = await manager.runTask({ cwd: repo, prompt: "[CRASH] boom" });
    assert.equal(crashed.status, "failed");

    const recovered = await manager.runTask({ cwd: repo, prompt: "after crash" });
    assert.equal(recovered.status, "completed");
    assert.match(recovered.finalMessage, /after crash/);
  } finally {
    await manager.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }

  // 5. -32601 graceful degradation when steer/fork unsupported
  const repo2 = createTempGitRepo("no-steer");
  const pluginData2 = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-data2-"));
  process.env.PLUGIN_DATA = pluginData2;
  const managerNoSteer = new CodexJobManager({
    pluginRoot: PLUGIN_ROOT,
    codexBin: FAKE_CODEX,
    env: { ...process.env, FAKE_CODEX_NO_STEER: "1", FAKE_CODEX_NO_FORK: "1" }
  });
  try {
    const job = await managerNoSteer.startTask({ cwd: repo2, prompt: "[SLOW:300] no steer" });
    const steerRes = await managerNoSteer.steerJob({ jobId: job.jobId, guidance: "redirect" });
    assert.equal(steerRes.ok, false);
    assert.equal(steerRes.unsupportedCapability, "turn/steer");

    const forkRes = await managerNoSteer.forkThread({ cwd: repo2, threadId: job.threadId });
    assert.equal(forkRes.ok, false);
    assert.equal(forkRes.unsupportedCapability, "thread/fork");

    await managerNoSteer.interruptJob({ cwd: repo2, jobId: job.jobId });
  } finally {
    await managerNoSteer.close();
    fs.rmSync(repo2, { recursive: true, force: true });
    fs.rmSync(pluginData2, { recursive: true, force: true });
  }
});

test("session transfer validates brain root and creates persistent resumable thread", async () => {
  const repo = createTempGitRepo("transfer");
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-data-"));
  const fakeBrain = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-brain-"));
  const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.jsonl`);
  fs.writeFileSync(outsideFile, "{}\n", "utf8");

  const transcriptPath = path.join(fakeBrain, "conv-123", "transcript.jsonl");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "USER_INPUT", content: "Fix flaky login timeout in auth.ts" }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        content: "Identified stale token refresh lock in src/auth.ts",
        tool_calls: [{ name: "read_file", args: { Path: "src/auth.ts" } }]
      })
    ].join("\n") + "\n",
    "utf8"
  );

  process.env.PLUGIN_DATA = pluginData;
  const manager = new CodexJobManager({
    pluginRoot: PLUGIN_ROOT,
    codexBin: FAKE_CODEX,
    allowedTranscriptRoots: [fakeBrain]
  });

  try {
    await assert.rejects(
      () => manager.transferSession({ cwd: repo, transcriptPath: outsideFile }),
      /outside allowed Antigravity brain directories/
    );

    const res = await manager.transferSession({ cwd: repo, transcriptPath, focus: "Finish auth lock fix" });
    assert.match(res.resumeCommand, /^codex resume thr_/);
    assert.match(res.summaryPreview, /Fix flaky login timeout/);
  } finally {
    await manager.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(fakeBrain, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
});

test("regression: sync detached review burst, liveJobs eviction, close() settles captures, worktree rollback & resumeLast", async () => {
  const repo = createTempGitRepo("regressions");
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-reg-data-"));
  process.env.PLUGIN_DATA = pluginData;
  fs.writeFileSync(path.join(repo, "app.js"), "export const x = 99;\n", "utf8");

  const manager = new CodexJobManager({
    pluginRoot: PLUGIN_ROOT,
    codexBin: FAKE_CODEX,
    env: { ...process.env, FAKE_CODEX_SYNC_REVIEW_BURST: "1" }
  });

  try {
    // Bug 1: detached reviewThreadId notifications emitted in the SAME stdout chunk as review/start response
    const syncReview = await manager.runReview({ cwd: repo, mode: "standard", delivery: "detached" });
    assert.equal(syncReview.status, "completed");
    assert.match(syncReview.reviewText, /uncommittedChanges/);
    // Bug 2a: terminal jobs evicted from liveJobs
    assert.equal(manager.liveJobs.size, 0);

    // Bug 8: conflicting setup flags throw
    await assert.rejects(
      () => manager.setup({ cwd: repo, enableReviewGate: true, disableReviewGate: true }),
      /Cannot pass both/
    );

    // Bug 3: worktree rollback when turn/start fails
    await assert.rejects(
      () => manager.startTask({ cwd: repo, prompt: "[FAIL_TURN_START]", worktree: "create" }),
      /Simulated turn\/start failure/
    );
    const wtBase = resolveWorktreesDir(repo);
    const remainingWorktrees = fs.existsSync(wtBase) ? fs.readdirSync(wtBase) : [];
    assert.equal(remainingWorktrees.length, 0);
    const codexBranches = runCommand("git", ["branch", "--list", "codex-bridge/*"], { cwd: repo }).stdout.trim();
    assert.equal(codexBranches, "");

    // Bug 4: resumeLast=true with worktree=create still finds prior thread from main repo state
    const first = await manager.runTask({ cwd: repo, prompt: "initial persistent task", conversationId: "conv-wt" });
    assert.equal(first.status, "completed");
    const resumedInWt = await manager.runTask({
      cwd: repo,
      prompt: "continue in isolated worktree",
      resumeLast: true,
      worktree: "create",
      conversationId: "conv-wt"
    });
    assert.equal(resumedInWt.threadId, first.threadId);
    await manager.interruptJob({ cwd: repo, jobId: resumedInWt.jobId, cleanupWorktree: true });

    // Bug 2b: closing pool settles any in-flight capture instead of hanging forever
    const inFlight = await manager.startTask({ cwd: repo, prompt: "[SLOW:5000] will be closed" });
    const waitPromise = manager.waitForJobs({ cwd: repo, jobIds: [inFlight.jobId], waitMode: "all", timeoutMs: 5_000 });
    await manager.close();
    const afterClose = await waitPromise;
    assert.equal(afterClose.timedOut, false);
    assert.equal(afterClose.completed[0].status, "failed");
  } finally {
    await manager.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("regression: large diff ENOBUFS + unborn HEAD in collectReviewContext, CJK UTF-8 byte budget, and failed transfer", async () => {
  // Bug 5: unborn HEAD (no commits yet) + >250KB staged diff triggers ENOBUFS fallback cleanly
  const unbornRepo = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-unborn-"));
  const fakeBrain = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-cjkbrain-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-cjkdata-"));
  process.env.PLUGIN_DATA = pluginData;

  try {
    runCommandChecked("git", ["init", "-b", "main"], { cwd: unbornRepo });
    fs.writeFileSync(path.join(unbornRepo, "big.txt"), `${"A".repeat(120)}\n`.repeat(2500), "utf8");
    runCommandChecked("git", ["add", "big.txt"], { cwd: unbornRepo });

    const ctx = collectReviewContext(unbornRepo, { mode: "working-tree", label: "working tree diff" });
    assert.match(ctx, /Diff exceeds inline limit; stat summary:/);
    assert.match(ctx, /big\.txt/);

    // Bug 6: CJK UTF-8 byte truncation respects 12KB byte budget
    const cjkTranscript = path.join(fakeBrain, "conv-cjk", "transcript.jsonl");
    fs.mkdirSync(path.dirname(cjkTranscript), { recursive: true });
    const lines = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push(JSON.stringify({ type: "USER_INPUT", content: `中文需求描述${i}：` + "修复鉴权超时问题并补充回归测试".repeat(30) }));
      lines.push(JSON.stringify({ type: "PLANNER_RESPONSE", content: `中文分析结论${i}：` + "定位到锁竞争与重试退避缺陷".repeat(40) }));
    }
    fs.writeFileSync(cjkTranscript, lines.join("\n") + "\n", "utf8");

    const handoff = await extractAntigravityHandoff(unbornRepo, cjkTranscript, { allowedRoots: [fakeBrain] });
    // Summary portion inside prompt must respect the 12KB UTF-8 budget (prompt header is < 250 bytes)
    assert.ok(Buffer.byteLength(handoff.prompt, "utf8") <= 12 * 1024 + 300);

    // Bug 6: failed transferSession throws instead of returning fake resumeCommand
    const repo = createTempGitRepo("transfer-fail");
    const manager = new CodexJobManager({
      pluginRoot: PLUGIN_ROOT,
      codexBin: FAKE_CODEX,
      allowedTranscriptRoots: [fakeBrain]
    });
    try {
      await assert.rejects(
        () => manager.transferSession({ cwd: repo, transcriptPath: cjkTranscript, focus: "[CRASH]" }),
        /Session transfer failed/
      );
    } finally {
      await manager.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(unbornRepo, { recursive: true, force: true });
    fs.rmSync(fakeBrain, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});
