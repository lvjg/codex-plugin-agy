---
name: codex-status
description: >-
  Inspect active and recent Codex Bridge background jobs for the current
  workspace, or fetch the full result and log tail for a specific jobId.
disable-model-invocation: true
---

# Codex Status & Results

1. Call `codex_status` with the active workspace `cwd`:
   - If the user specified a `jobId` (or asked for the latest job result), pass `jobId` (or resolve the newest job from `codex_status`) and `includeRawLogTailLines: 40`.
   - Otherwise call `codex_status(cwd, includeCompleted: true)` to show the compact status table.
2. Render a concise table with `jobId`, `kind`, `status`, `phase`, `threadId`, `elapsedMs`, and `logPath`.
3. When returning a specific job result, include `finalMessage` (or `structuredReview` / `reviewText`), `filesChanged`, and note if output was truncated with a clickable link to `logPath`.
