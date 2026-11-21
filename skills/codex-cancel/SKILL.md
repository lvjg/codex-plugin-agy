---
name: codex-cancel
description: >-
  Interrupt a running Codex Bridge turn cleanly via turn/interrupt and
  optionally clean up any plugin-managed git worktree.
disable-model-invocation: true
---

# Codex Cancel

1. If the user did not supply a `jobId` or `threadId`, call `codex_status(cwd)` to identify active running jobs. If multiple jobs are running, ask which one to cancel unless the user asked to cancel all.
2. Call `codex_interrupt` with `jobId` (or `threadId`) and `cleanupWorktree: true` when the user wants temporary worktree cleanup (default `false` if worktree may contain edits worth inspecting).
3. Report the cancellation outcome and whether any worktree was removed.
