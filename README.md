# Codex Bridge for Antigravity (`codex-plugin-agy`)

An Antigravity-native plugin that delegates code reviews, adversarial audits, and autonomous coding tasks to your local OpenAI Codex `app-server`, built on the architecture of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) and upgraded for Antigravity's plugin runtime.

## Highlights

- **Zero runtime dependencies** (pure Node.js >= 18.18 ESM) — installs directly from GitHub via `agy plugin install` with no `npm install` step.
- **Antigravity-managed Stdio MCP Server** (`mcp_config.json`) — automatically starts/stops with the plugin, avoiding orphan broker daemons.
- **Per-workspace pooled multi-thread multiplexer** — supports concurrent Codex threads (including Codex internal `collabAgentToolCall` child threads and `reviewThreadId`), removing single-stream broker locks.
- **Dual execution tracks**:
  - Fire-and-wait tools (`codex_review`, `codex_run`) use Antigravity's native `background: "always"` MCP execution (zero polling loops, visible in `/tasks`).
  - Handle-based tools (`codex_task_start`, `codex_wait`, `codex_steer`, `codex_interrupt`, `codex_respond`, `codex_thread_fork`) support mid-flight steering, bidirectional approvals, and multi-thread coordination.
- **Antigravity-native Hooks & Subagents**:
  - `SessionStart` injects per-conversation `conversationId` / `transcriptPath` metadata (preventing cross-session races).
  - Opt-in `Stop` review gate (`stopReviewGate: false` by default) uses git content-hash deduplication and `terminationReason` short-circuiting.
  - Bundled `codex-rescue` and read-only `codex-reviewer` custom subagents (`model: flash`, `subagent: true`).

## Prerequisites

- **Node.js** >= 18.18
- **Git**
- **OpenAI Codex CLI** (`npm install -g @openai/codex`) authenticated via `codex login` or `OPENAI_API_KEY` (or set `CODEX_BIN` to an existing `codex` binary path)

## Installation & Updates

Install directly with the Antigravity CLI:

```bash
agy plugin install https://github.com/lvjg/codex-plugin-agy
```

Verify installation:

```bash
agy plugin list
```

Update to the latest version from GitHub:

```bash
agy plugin uninstall codex-bridge
agy plugin install https://github.com/lvjg/codex-plugin-agy
```

After installation, run `/codex-setup` inside Antigravity to verify your local `codex` binary, authentication, and workspace stop-gate settings.

## Included Components

### Skills (Slash Commands)

| Command | Purpose |
| :--- | :--- |
| `/codex-review` | Standard read-only Codex review (`review/start`) on working tree or branch diff |
| `/codex-adversarial-review` | Structured adversarial review (`review-output.schema.json`) with optional custom focus |
| `/codex-rescue` | Hand off debugging or implementation to a persistent Codex thread (`ephemeral: false`) |
| `/codex-status` | List active/recent Codex jobs or inspect a specific `jobId` result and log tail |
| `/codex-cancel` | Interrupt a running turn (`turn/interrupt`) and optionally remove isolated worktrees |
| `/codex-setup` | Check CLI/auth health and toggle workspace `stopReviewGate` |
| `/codex-transfer` | Compress and transfer an Antigravity `transcript.jsonl` into a resumable Codex thread |
| `codex-prompting` | Reference skill for shaping clear prompts for Codex subagents |

### Custom Subagents

- `codex-rescue` (`model: flash`, `subagent: true`): thin wrapper around `codex_run` / `codex_task_start`, compatible with Antigravity `invoke_subagent(..., workspace="share")`.
- `codex-reviewer` (`model: flash`, `subagent: true`, `commandExecutionPolicy: off`): read-only reviewer routing to `codex_review`.

### MCP Tools (`codex-bridge_runtime`)

- **Eager (always visible)**: `codex_review`, `codex_run`, `codex_task_start`, `codex_status`
- **Lazy-loaded**: `codex_wait`, `codex_steer`, `codex_interrupt`, `codex_setup`, `codex_respond`, `codex_thread_fork`, `codex_transfer`

## Local Development & Verification

```bash
# Run automated unit, MCP stdio, multi-thread mux, and hook tests
npm test

# Validate plugin manifest, MCP config, skills, agents, rules, and hooks
agy plugin validate --strict .
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
