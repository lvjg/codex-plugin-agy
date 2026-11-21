---
name: codex-prompting
description: >-
  Structure clear, high-signal task prompts for local OpenAI Codex subagents.
  Use when shaping a complex debugging, refactoring, or verification brief
  before calling codex_run or codex_task_start.
---

# Codex Prompting Guidelines

When tightening a prompt for Codex, preserve the user's goal and constraints while making execution unambiguous:

1. **Lead with the concrete goal and completion criteria**: state what must work and what command/check proves it.
2. **Name known entrypoints, files, and error outputs**: avoid making Codex re-discover symptoms already observed in the parent conversation.
3. **Separate constraints from preferences**: state hard boundaries (public API compatibility, no destructive migrations, read-only vs workspace-write) upfront.
4. **Avoid micromanaging step-by-step**: give Codex the invariant and verification target, not a rigid line-by-line script.
5. **Keep output actionable**: ask for changed files, verification commands run, and any remaining risks or unverified edge cases.
