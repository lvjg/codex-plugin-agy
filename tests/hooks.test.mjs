import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCommand, runCommandChecked } from "../scripts/lib/process.mjs";
import { setConfig, upsertJob } from "../scripts/lib/state-store.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, "..");
const SESSION_START_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-start-hook.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const FAKE_CODEX = path.join(TEST_DIR, "fake-codex.mjs");

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-hooks-"));
  runCommandChecked("git", ["init", "-b", "main"], { cwd: dir });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  runCommandChecked("git", ["config", "user.name", "Test User"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "main.js"), "export const v = 1;\n", "utf8");
  runCommandChecked("git", ["add", "."], { cwd: dir });
  runCommandChecked("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function runHook(scriptPath, payload, env) {
  const res = runCommand(process.execPath, [scriptPath], {
    cwd: PLUGIN_ROOT,
    env,
    input: JSON.stringify(payload)
  });
  assert.equal(res.status, 0, `Hook failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

test("SessionStart injects conversationId, transcriptPath, and active stop-gate warning", () => {
  const repo = createTempRepo();
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-hookdata-"));
  process.env.PLUGIN_DATA = pluginData;

  try {
    setConfig(repo, { stopReviewGate: true });
    const out = runHook(
      SESSION_START_HOOK,
      {
        conversationId: "conv-abc",
        transcriptPath: "/Users/test/.gemini/antigravity/brain/conv-abc/transcript.jsonl",
        cwd: repo,
        hookEventName: "SessionStart"
      },
      { ...process.env, PLUGIN_DATA: pluginData }
    );

    const msg = out.injectSteps?.[0]?.systemMessage?.systemMessage ?? "";
    assert.match(msg, /conversationId=conv-abc/);
    assert.match(msg, /transcriptPath=\/Users\/test\/\.gemini\/antigravity\/brain\/conv-abc\/transcript\.jsonl/);
    assert.match(msg, /Stop-time Codex review gate is enabled/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("Stop hook respects terminationReason, conversation isolation, content-hash dedup, and BLOCK/ALLOW", () => {
  const repo = createTempRepo();
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-hookdata-"));
  process.env.PLUGIN_DATA = pluginData;

  const baseEnv = {
    ...process.env,
    PLUGIN_DATA: pluginData,
    CODEX_BIN: FAKE_CODEX
  };

  try {
    // Dirty working tree
    fs.writeFileSync(path.join(repo, "main.js"), "export const v = 2;\n", "utf8");
    setConfig(repo, { stopReviewGate: true, blockStopWhileJobsRunning: true });

    // 1. Abnormal termination -> immediate allow
    const canceled = runHook(
      STOP_HOOK,
      { cwd: repo, conversationId: "conv-1", terminationReason: "USER_CANCELED", continuationActive: false },
      { ...baseEnv, FAKE_CODEX_STOP_VERDICT: "BLOCK" }
    );
    assert.deepEqual(canceled, {});

    // 2. Running job in conv-OTHER must NOT block conv-1 (strict conversation isolation)
    upsertJob(repo, {
      jobId: "task-other",
      kind: "task",
      status: "running",
      conversationId: "conv-OTHER",
      workspaceRoot: repo
    });
    const isolated = runHook(
      STOP_HOOK,
      { cwd: repo, conversationId: "conv-1", terminationReason: "NO_TOOL_CALL", continuationActive: false },
      { ...baseEnv, FAKE_CODEX_STOP_VERDICT: "ALLOW" }
    );
    assert.deepEqual(isolated, {});

    // 3. BLOCK verdict stops termination and records diff hash
    const blocked = runHook(
      STOP_HOOK,
      { cwd: repo, conversationId: "conv-2", terminationReason: "NO_TOOL_CALL", continuationActive: false },
      { ...baseEnv, FAKE_CODEX_STOP_VERDICT: "BLOCK" }
    );
    assert.equal(blocked.decision, "continue");
    assert.match(blocked.reason, /Missing null check/);

    // 4. continuationActive=true with UNCHANGED diff -> deduplicated, allows stop (prevents infinite loop)
    const deduped = runHook(
      STOP_HOOK,
      { cwd: repo, conversationId: "conv-2", terminationReason: "NO_TOOL_CALL", continuationActive: true },
      { ...baseEnv, FAKE_CODEX_STOP_VERDICT: "BLOCK" }
    );
    assert.deepEqual(deduped, {});

    // 5. Edit SAME file again -> content hash changes, so continuationActive=true DOES re-review!
    fs.writeFileSync(path.join(repo, "main.js"), "export const v = 3;\n", "utf8");
    const reReviewed = runHook(
      STOP_HOOK,
      { cwd: repo, conversationId: "conv-2", terminationReason: "NO_TOOL_CALL", continuationActive: true },
      { ...baseEnv, FAKE_CODEX_STOP_VERDICT: "BLOCK" }
    );
    assert.equal(reReviewed.decision, "continue");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});
