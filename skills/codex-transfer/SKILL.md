---
name: codex-transfer
description: >-
  Transfer the current Antigravity conversation context into a persistent local
  Codex thread that can be resumed via `codex resume <threadId>`.
disable-model-invocation: true
---

# Codex Transfer

Hand off the active Antigravity session into a persistent local Codex thread (`ephemeral: false`).

## Workflow

1. Obtain `transcriptPath` from the `[codex-bridge] conversationId=... transcriptPath=...` system message injected by `SessionStart` (or from an explicit user-supplied `--source` path).
2. Call `codex_transfer` with `cwd`, `transcriptPath`, and any optional `focus` instruction the user gave.
3. Present the returned `threadId`, the exact `codex resume <threadId>` command, and the handoff summary verbatim so the user can continue seamlessly in Codex CLI or Desktop.
