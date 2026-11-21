#!/usr/bin/env node

import process from "node:process";

import { CodexJobManager } from "./lib/job-manager.mjs";

const SERVER_INFO = {
  name: "codex-bridge-runtime",
  version: "0.1.0"
};

const SUPPORTED_PROTOCOL_VERSION = "2025-03-26";

const TOOL_DEFINITIONS = [
  {
    name: "codex_review",
    description:
      "Run a read-only local Codex code review (native standard review or structured adversarial audit) against working-tree changes or a branch diff.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Absolute path inside the target Git repository." },
        mode: { type: "string", enum: ["standard", "adversarial"], default: "standard" },
        scope: { type: "string", enum: ["auto", "working-tree", "branch"], default: "auto" },
        baseRef: { type: "string", description: "Optional base branch/ref for branch scope reviews." },
        focus: { type: "string", description: "Custom review focus text (requires mode='adversarial')." },
        model: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        conversationId: { type: "string" }
      }
    }
  },
  {
    name: "codex_run",
    description:
      "Delegate a coding, debugging, or analysis task to local Codex and return the final structured outcome upon completion (persists thread for follow-up).",
    inputSchema: {
      type: "object",
      required: ["cwd", "prompt"],
      properties: {
        cwd: { type: "string", description: "Absolute working directory path." },
        prompt: { type: "string", description: "Clear task instructions and verification criteria." },
        sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "workspace-write" },
        threadId: { type: "string", description: "Resume an existing Codex thread ID." },
        resumeLast: { type: "boolean", default: false },
        model: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        outputSchema: { type: "object", description: "Optional JSON Schema for structured final output." },
        worktree: { type: "string", enum: ["none", "create"], default: "none" },
        ephemeral: { type: "boolean", default: false },
        conversationId: { type: "string" }
      }
    }
  },
  {
    name: "codex_task_start",
    description:
      "Start an asynchronous Codex task and immediately return jobId and threadId for concurrent orchestration, mid-flight steering, or approval handling.",
    inputSchema: {
      type: "object",
      required: ["cwd", "prompt"],
      properties: {
        cwd: { type: "string" },
        prompt: { type: "string" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "workspace-write" },
        approvalPolicy: { type: "string", enum: ["never", "on-request"], default: "never" },
        threadId: { type: "string" },
        resumeLast: { type: "boolean", default: false },
        model: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        outputSchema: { type: "object" },
        worktree: { type: "string", enum: ["none", "create"], default: "none" },
        ephemeral: { type: "boolean", default: false },
        conversationId: { type: "string" }
      }
    }
  },
  {
    name: "codex_status",
    description:
      "List active and recent Codex jobs in a workspace, or fetch the full result, changed files, and optional log tail for a specific jobId.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string" },
        jobId: { type: "string", description: "When set, returns detailed results for this job." },
        conversationId: { type: "string" },
        includeCompleted: { type: "boolean", default: true },
        includeRawLogTailLines: { type: "integer", minimum: 0, maximum: 200 }
      }
    }
  },
  {
    name: "codex_wait",
    description:
      "Wait on one or more asynchronous Codex jobs with a bounded timeout (up to 120s), returning early when any/all finish or await input.",
    inputSchema: {
      type: "object",
      required: ["jobIds"],
      properties: {
        cwd: { type: "string" },
        jobIds: { type: "array", items: { type: "string" }, minItems: 1 },
        waitMode: { type: "string", enum: ["any", "all"], default: "any" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 60000 }
      }
    }
  },
  {
    name: "codex_steer",
    description:
      "Inject mid-flight guidance into a running Codex turn via turn/steer without restarting the thread.",
    inputSchema: {
      type: "object",
      required: ["guidance"],
      properties: {
        jobId: { type: "string" },
        threadId: { type: "string" },
        guidance: { type: "string" }
      }
    }
  },
  {
    name: "codex_interrupt",
    description:
      "Interrupt a running Codex turn via turn/interrupt and optionally remove a plugin-managed isolated git worktree.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        jobId: { type: "string" },
        threadId: { type: "string" },
        cleanupWorktree: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "codex_setup",
    description:
      "Inspect local Codex CLI availability, version, authentication status, and configure workspace stop-time review gate settings.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: {
        cwd: { type: "string" },
        enableReviewGate: { type: "boolean" },
        disableReviewGate: { type: "boolean" },
        blockStopWhileJobsRunning: { type: "boolean" },
        strictStopGate: { type: "boolean" }
      }
    }
  },
  {
    name: "codex_respond",
    description:
      "Respond to a pending server-initiated approval or user input request on a job in awaiting_input status.",
    inputSchema: {
      type: "object",
      required: ["jobId", "requestId"],
      properties: {
        jobId: { type: "string" },
        requestId: { type: "string" },
        decision: { type: "string" },
        answer: { type: "string" },
        result: { type: "object" }
      }
    }
  },
  {
    name: "codex_thread_fork",
    description:
      "Fork an existing Codex thread into a new branch thread via thread/fork to explore an alternative approach.",
    inputSchema: {
      type: "object",
      required: ["cwd", "threadId"],
      properties: {
        cwd: { type: "string" },
        threadId: { type: "string" },
        prompt: { type: "string", description: "Optional prompt to immediately start a turn on the forked thread." },
        worktree: { type: "string", enum: ["none", "create"], default: "none" }
      }
    }
  },
  {
    name: "codex_transfer",
    description:
      "Extract a bounded structured handoff from an Antigravity transcript.jsonl into a persisted Codex thread and return `codex resume <threadId>`.",
    inputSchema: {
      type: "object",
      required: ["cwd", "transcriptPath"],
      properties: {
        cwd: { type: "string" },
        transcriptPath: { type: "string" },
        focus: { type: "string" },
        model: { type: "string" },
        conversationId: { type: "string" }
      }
    }
  }
];

function writeJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  writeJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data = undefined) {
  writeJsonRpc({
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data }
  });
}

function formatToolResult(payload, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload,
    isError
  };
}

export function createMcpDispatcher(manager) {
  async function dispatchTool(name, args = {}) {
    switch (name) {
      case "codex_setup":
        return manager.setup(args);
      case "codex_review":
        return manager.runReview(args);
      case "codex_run":
        return manager.runTask(args);
      case "codex_task_start":
        return manager.startTask(args);
      case "codex_status":
        return manager.getStatus(args);
      case "codex_wait":
        return manager.waitForJobs(args);
      case "codex_steer":
        return manager.steerJob(args);
      case "codex_interrupt":
        return manager.interruptJob(args);
      case "codex_respond":
        return manager.respondToJob(args);
      case "codex_thread_fork":
        return manager.forkThread(args);
      case "codex_transfer":
        return manager.transferSession(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return;
    }

    const { id, method, params } = msg;

    // Notifications have no id.
    if (id === undefined) {
      return;
    }

    try {
      switch (method) {
        case "initialize": {
          const requestedVersion = params?.protocolVersion ?? SUPPORTED_PROTOCOL_VERSION;
          sendResult(id, {
            protocolVersion: requestedVersion,
            capabilities: {
              tools: { listChanged: false }
            },
            serverInfo: SERVER_INFO
          });
          return;
        }
        case "ping":
          sendResult(id, {});
          return;
        case "tools/list":
          sendResult(id, { tools: TOOL_DEFINITIONS });
          return;
        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments ?? {};
          try {
            const result = await dispatchTool(toolName, toolArgs);
            sendResult(id, formatToolResult(result, false));
          } catch (toolErr) {
            sendResult(
              id,
              formatToolResult(
                {
                  error: toolErr instanceof Error ? toolErr.message : String(toolErr)
                },
                true
              )
            );
          }
          return;
        }
        default:
          sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      sendError(id, -32603, err instanceof Error ? err.message : String(err));
    }
  };
}

function startStdioServer() {
  const manager = new CodexJobManager({
    allowedTranscriptRoots: process.env.CODEX_BRIDGE_ALLOWED_TRANSCRIPT_ROOTS
      ? process.env.CODEX_BRIDGE_ALLOWED_TRANSCRIPT_ROOTS.split(":").filter(Boolean)
      : []
  });
  const handleMessage = createMcpDispatcher(manager);

  let buffer = "";
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await manager.close().catch(() => {});
    process.exit(0);
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          process.stderr.write(`[codex-bridge] Malformed JSON-RPC input: ${err.message}\n`);
          nl = buffer.indexOf("\n");
          continue;
        }
        Promise.resolve(handleMessage(parsed)).catch((err) => {
          process.stderr.write(`[codex-bridge] Unhandled dispatch error: ${err instanceof Error ? err.stack : String(err)}\n`);
        });
      }
      nl = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startStdioServer();
