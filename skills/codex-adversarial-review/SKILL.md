---
name: codex-adversarial-review
description: >-
  Run a grounded adversarial Codex code review that challenges design
  assumptions, failure modes, race conditions, and security boundaries with
  structured JSON findings. Use when the user invokes /codex-adversarial-review
  or asks for a tough, focused audit.
---

# Codex Adversarial Review

Delegate a structured adversarial code review to local Codex via `codex_review` (`mode: "adversarial"`).

## Workflow

1. Determine `cwd`, optional `scope` (`"auto"`, `"working-tree"`, or `"branch"`), optional `baseRef`, and any user-provided `focus` text.
2. Call `codex_review` with `mode: "adversarial"`, passing `focus`, `model`, `effort`, and `conversationId` when available.
3. Present the returned `structuredReview`:
   - Lead with `verdict` (`approve` or `needs-attention`) and `summary`.
   - List each finding with `severity`, `file:line_start-line_end`, `title`, `body`, `confidence`, and `recommendation`.
   - Include `next_steps`, `jobId`, `threadId`, and `logPath`.
4. Do not soften or omit `critical` or `high` findings.
