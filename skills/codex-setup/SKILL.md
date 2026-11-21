---
name: codex-setup
description: >-
  Check local Codex CLI installation, app-server capabilities, and login status,
  and optionally toggle the workspace stop-time review gate.
disable-model-invocation: true
---

# Codex Setup

1. Call `codex_setup` with the current workspace `cwd` and any requested toggle (`enableReviewGate`, `disableReviewGate`, `blockStopWhileJobsRunning`).
2. If `available` is `false`:
   - Show the exact diagnostics from `codex_setup`.
   - Ask the user whether they want to install `@openai/codex` (`npm install -g @openai/codex`) or point `CODEX_BIN` to an existing binary. Only run installation if the user confirms.
3. If `available` is `true` and `authenticated` is `false`:
   - Tell the user to authenticate locally by running `codex login` (or setting `OPENAI_API_KEY`) and rerun `/codex-setup`.
4. Display detected `binaryPath`, `version`, `capabilities` (`steer`, `fork`), authentication status, and current `stopReviewGate` configuration.
