---
name: codex-rescue
description: >-
  Hand off a substantial debugging investigation, root-cause diagnosis, or
  implementation task to local OpenAI Codex as a persistent subagent thread.
  Use when the user invokes /codex-rescue or asks Codex to investigate or fix
  a complex issue.
---

# Codex Rescue

Delegate a write-capable or read-only rescue task to local Codex.

## Workflow

1. Check routing intent from the user request:
   - Default `sandbox: "workspace-write"`; switch to `"read-only"` when the user only asks for diagnosis or research without edits.
   - Preserve explicit `model` or `effort` requests; leave both unset otherwise.
   - If the user did not specify `--resume` or `--fresh`, check `codex_status(cwd, conversationId)` first. If a prior persistent task thread exists for this workspace/conversation, use `ask_question` once to ask whether to continue that thread (`resumeLast: true` / `threadId`) or start a fresh thread.
2. Choose execution mode:
   - **Standard fire-and-wait**: call `codex_run` (executes natively as an Antigravity background task and wakes up on completion).
   - **Parallel workspace edit**: delegate via `invoke_subagent(TypeName="codex-rescue", Workspace="share", ...)` so Antigravity isolates the git workspace automatically, and keep `worktree: "none"` inside the subagent.
   - **Steerable / multi-turn interactive run**: call `codex_task_start` to get `jobId` + `threadId` immediately, then coordinate with `codex_wait`, `codex_steer`, `codex_respond`, or `codex_interrupt`.
3. Present Codex's final message, `filesChanged`, `jobId`, `threadId`, `worktreePath` (if any), and `logPath`.
4. If Codex is missing or unauthenticated, stop and direct the user to run `/codex-setup`.
