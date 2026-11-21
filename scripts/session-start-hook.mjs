#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { getConfig } from "./lib/state-store.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function main() {
  const input = readHookInput();
  const conversationId = input.conversationId ?? "";
  const transcriptPath = input.transcriptPath ?? "";
  const cwd = input.cwd || input.workspacePaths?.[0] || process.cwd();

  const lines = [];
  if (conversationId || transcriptPath) {
    lines.push(
      `[codex-bridge] conversationId=${conversationId || "unknown"} transcriptPath=${transcriptPath || "unknown"}`
    );
  }

  try {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const config = getConfig(workspaceRoot);
    if (config.stopReviewGate) {
      lines.push(
        "[codex-bridge] Stop-time Codex review gate is enabled for this workspace. Use /codex-setup to disable it if not needed."
      );
    }
  } catch {
    // Non-fatal: workspace may not exist yet.
  }

  if (lines.length === 0) {
    process.stdout.write("{}\n");
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: lines.join("\n")
          }
        }
      ]
    })}\n`
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`[codex-bridge] SessionStart hook error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stdout.write("{}\n");
}
