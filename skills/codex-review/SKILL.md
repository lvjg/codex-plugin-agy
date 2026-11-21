---
name: codex-review
description: >-
  Run a read-only local Codex code review against working-tree changes or a
  branch diff. Use when the user invokes /codex-review or asks Codex for a
  standard second-opinion review.
---

# Codex Review

Delegate a read-only code review to the local Codex `app-server` via the `codex_review` MCP tool.

## Workflow

1. Determine `cwd` (the active repository root) and review scope:
   - Default `scope: "auto"` (reviews working tree if dirty, otherwise compares against the repository default branch).
   - If the user provides a base ref (e.g. `main`), pass `baseRef` and `scope: "branch"`.
   - If the user provides custom focus instructions, tell them standard native review does not accept custom focus text and switch to `mode: "adversarial"` with `focus`.
2. Call `codex_review` with `mode: "standard"` (runs natively in background via Antigravity MCP background execution), forwarding `conversationId` if injected by `SessionStart`.
3. If `codex_review` reports Codex is missing or unauthenticated, direct the user to run `/codex-setup`.
4. Present the Codex review output faithfully, preserving `jobId`, `threadId`, and `logPath`.
