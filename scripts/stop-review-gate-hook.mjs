#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { MuxAppServerClient } from "./lib/app-server-mux.mjs";
import { getCodexAvailability } from "./lib/codex-env.mjs";
import { computeWorkingTreeFingerprint, ensureGitRepository } from "./lib/git.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  getConfig,
  getLastReviewedDiffHash,
  listJobs,
  setLastReviewedDiffHash
} from "./lib/state-store.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: "Stop-time Codex review returned no output."
    };
  }
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: firstLine.slice("ALLOW:".length).trim() };
  }
  if (firstLine.startsWith("BLOCK:")) {
    return {
      ok: false,
      reason: firstLine.slice("BLOCK:".length).trim() || text
    };
  }
  return {
    ok: false,
    reason: `Unexpected stop-time review output: ${firstLine}`
  };
}

async function runEphemeralStopReview(workspaceRoot, input) {
  const client = await MuxAppServerClient.connect(workspaceRoot, {
    codexBin: process.env.CODEX_BIN ?? null
  });
  try {
    const started = await client.request("thread/start", {
      cwd: workspaceRoot,
      model: null,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "antigravity_codex_bridge_stop_gate",
      ephemeral: true
    });
    const threadId = started?.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server returned no thread.id for stop-gate review.");
    }

    const template = loadPromptTemplate(PLUGIN_ROOT, "stop-review-gate");
    const lastUserInput = String(input.lastUserInput ?? "").trim();
    const responseBlock = lastUserInput ? `Latest user request:\n${lastUserInput}` : "";
    const prompt = interpolateTemplate(template, {
      HOST_RESPONSE_BLOCK: responseBlock
    });

    const entry = client.registerCapture(threadId, {
      jobId: "stop-review-gate",
      approvalPolicy: "never"
    });

    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: null,
      effort: null,
      outputSchema: null
    });

    const state = await entry.capture.completion;
    if (state.error || state.finalTurn?.status === "failed") {
      throw new Error(state.error?.message ?? "Stop-gate review turn failed.");
    }
    return parseStopReviewOutput(state.lastAgentMessage);
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const input = readHookInput();

  // 1. Short-circuit on any abnormal termination.
  if (input.terminationReason && input.terminationReason !== "NO_TOOL_CALL") {
    emit({});
    return;
  }

  const cwd = input.cwd || input.workspacePaths?.[0] || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const conversationId = input.conversationId || null;

  // 2. Optionally keep agent alive while jobs strictly belonging to THIS conversation are running.
  if (config.blockStopWhileJobsRunning && conversationId) {
    const activeJob = listJobs(workspaceRoot).find(
      (job) =>
        job.conversationId === conversationId &&
        (job.status === "running" || job.status === "awaiting_input")
    );
    if (activeJob) {
      emit({
        decision: "continue",
        reason: `Codex background job ${activeJob.jobId} (${activeJob.status}) for this conversation is still active. Wait for completion or cancel with /codex-cancel.`
      });
      return;
    }
  }

  // 3. Opt-in gate disabled -> immediate allow.
  if (!config.stopReviewGate) {
    emit({});
    return;
  }

  // 4. Compute working-tree content fingerprint (handles git repo check & dedup).
  let diffHash = null;
  try {
    ensureGitRepository(workspaceRoot);
    diffHash = computeWorkingTreeFingerprint(workspaceRoot);
  } catch {
    emit({});
    return;
  }

  if (!diffHash) {
    emit({});
    return;
  }

  if (input.continuationActive && conversationId) {
    const previousHash = getLastReviewedDiffHash(workspaceRoot, conversationId);
    if (previousHash === diffHash) {
      emit({});
      return;
    }
  }

  // 5. Verify Codex availability before blocking.
  const availability = getCodexAvailability(workspaceRoot);
  if (!availability.available) {
    process.stderr.write(`[codex-bridge] Stop review gate skipped: ${availability.detail}\n`);
    emit(
      config.strictStopGate
        ? {
            decision: "continue",
            reason: `Codex stop-time review gate failed: ${availability.detail}`
          }
        : {}
    );
    return;
  }

  try {
    const verdict = await runEphemeralStopReview(workspaceRoot, input);
    if (conversationId) {
      setLastReviewedDiffHash(workspaceRoot, conversationId, diffHash);
    }
    if (verdict.ok) {
      emit({});
      return;
    }
    emit({
      decision: "continue",
      reason: `Codex stop-time review found issues to address before stopping: ${verdict.reason}`
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[codex-bridge] Stop review gate error: ${detail}\n`);
    emit(
      config.strictStopGate
        ? {
            decision: "continue",
            reason: `Codex stop-time review gate failed in strict mode: ${detail}`
          }
        : {}
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[codex-bridge] Fatal stop hook error: ${err instanceof Error ? err.message : String(err)}\n`);
  emit({});
});
