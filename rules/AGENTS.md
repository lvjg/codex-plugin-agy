# Codex Bridge Routing Rules

- Delegate to Codex only when the user invokes a `/codex-*` skill, asks for an independent second-engine code review, or faces a substantial debugging or implementation task that benefits from local Codex delegation. Handle simple, bounded tasks directly.
- Prefer native background tools (`codex_review`, `codex_run`) for fire-and-wait work instead of polling loops. Use `codex_task_start` with `codex_wait`, `codex_steer`, or `codex_interrupt` when mid-flight steering, approval responses, or coordinated multi-thread execution is required.
- When `SessionStart` injects `[codex-bridge] conversationId=... transcriptPath=...`, forward those values to `codex_run`, `codex_task_start`, `codex_review`, and `codex_transfer` so job ownership and session transfer stay isolated across concurrent conversations.
- Report Codex findings faithfully: preserve `jobId`, `threadId`, severity, file paths, and line ranges without softening blocking issues.
