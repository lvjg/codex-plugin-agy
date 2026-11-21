#!/usr/bin/env node

import process from "node:process";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.99.0-fake\n");
  process.exit(0);
}

if (args[0] === "app-server" && args[1] === "--help") {
  process.stdout.write("Fake Codex app-server\n");
  process.exit(0);
}

if (args[0] !== "app-server") {
  process.stderr.write(`Unsupported fake codex args: ${args.join(" ")}\n`);
  process.exit(1);
}

let seq = 1;
const threads = new Map();
const activeTimers = new Map();
const pendingApprovals = new Map();
const steeredPrompts = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  send({ id, result });
}

function sendError(id, code, message) {
  send({ id, error: { code, message } });
}

function handleRequest(msg) {
  const { id, method, params = {} } = msg;

  switch (method) {
    case "initialize":
      sendResult(id, { serverInfo: { name: "fake-codex", version: "0.99.0" } });
      return;

    case "account/read":
      sendResult(id, {
        account: process.env.FAKE_CODEX_UNAUTH === "1" ? null : { type: "chatgpt", email: "dev@example.com" },
        requiresOpenaiAuth: true
      });
      return;

    case "config/read":
      sendResult(id, { config: { model_provider: "openai" } });
      return;

    case "thread/start": {
      const threadId = `thr_${seq++}`;
      threads.set(threadId, {
        id: threadId,
        cwd: params.cwd,
        sandbox: params.sandbox,
        ephemeral: params.ephemeral,
        name: null
      });
      sendResult(id, { thread: { id: threadId } });
      return;
    }

    case "thread/resume": {
      const threadId = params.threadId;
      if (!threads.has(threadId)) {
        threads.set(threadId, { id: threadId, cwd: params.cwd, sandbox: params.sandbox });
      }
      sendResult(id, { thread: { id: threadId } });
      return;
    }

    case "thread/name/set": {
      const t = threads.get(params.threadId);
      if (t) {
        t.name = params.name;
      }
      sendResult(id, {});
      return;
    }

    case "thread/list":
      sendResult(id, { data: [...threads.values()] });
      return;

    case "thread/fork": {
      if (process.env.FAKE_CODEX_NO_FORK === "1") {
        sendError(id, -32601, "Method not found: thread/fork");
        return;
      }
      const newId = `thr_fork_${seq++}`;
      threads.set(newId, { id: newId, cwd: params.cwd, forkedFrom: params.threadId });
      sendResult(id, { thread: { id: newId } });
      return;
    }

    case "review/start": {
      const turnId = `turn_${seq++}`;
      const reviewThreadId = params.delivery === "detached" ? `thr_rev_${seq++}` : params.threadId;
      const emitReview = () => {
        const lines = [
          { method: "turn/started", params: { threadId: reviewThreadId, turn: { id: turnId } } },
          {
            method: "item/started",
            params: { threadId: reviewThreadId, item: { id: "rev1", type: "enteredReviewMode", review: "standard" } }
          },
          {
            method: "item/completed",
            params: {
              threadId: reviewThreadId,
              item: {
                id: "rev1",
                type: "exitedReviewMode",
                review: `Standard review ok for target=${params.target?.type ?? "unknown"}`
              }
            }
          },
          {
            method: "turn/completed",
            params: { threadId: reviewThreadId, turn: { id: turnId, status: "completed" } }
          }
        ];
        return lines.map((m) => JSON.stringify(m)).join("\n") + "\n";
      };

      if (process.env.FAKE_CODEX_SYNC_REVIEW_BURST === "1") {
        // Emit response and all detached reviewThreadId notifications in ONE single write chunk.
        process.stdout.write(`${JSON.stringify({ id, result: { turn: { id: turnId }, reviewThreadId } })}\n${emitReview()}`);
        return;
      }

      sendResult(id, { turn: { id: turnId }, reviewThreadId });
      setTimeout(() => {
        process.stdout.write(emitReview());
      }, 25);
      return;
    }

    case "turn/start": {
      const threadId = params.threadId;
      const turnId = `turn_${seq++}`;
      const prompt = params.input?.[0]?.text ?? "";
      if (prompt.includes("[FAIL_TURN_START]")) {
        sendError(id, -32000, "Simulated turn/start failure");
        return;
      }
      sendResult(id, { turn: { id: turnId } });

      send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });

      if (prompt.includes("[CRASH]")) {
        setTimeout(() => process.exit(42), 20);
        return;
      }

      if (prompt.includes("[APPROVAL]")) {
        const reqId = `srv_${seq++}`;
        pendingApprovals.set(reqId, { threadId, turnId });
        setTimeout(() => {
          send({
            id: reqId,
            method: "item/commandExecution/requestApproval",
            params: { threadId, turnId, command: "npm test" }
          });
        }, 20);
        return;
      }

      const slowMatch = prompt.match(/\[SLOW:(\d+)\]/);
      const delayMs = slowMatch ? Number(slowMatch[1]) : 35;

      const finish = () => {
        activeTimers.delete(threadId);
        const steerText = steeredPrompts.get(threadId);

        if (prompt.includes("[COLLAB]")) {
          const childThreadId = `thr_child_${seq++}`;
          const childTurnId = `turn_child_${seq++}`;
          send({
            method: "item/started",
            params: {
              threadId,
              item: { id: "collab1", type: "collabAgentToolCall", tool: "spawn_agent", status: "inProgress", receiverThreadIds: [childThreadId] }
            }
          });
          send({ method: "turn/started", params: { threadId: childThreadId, turn: { id: childTurnId } } });
          send({
            method: "item/completed",
            params: {
              threadId: childThreadId,
              item: { id: "fc1", type: "fileChange", status: "completed", changes: [{ path: "src/child.js" }] }
            }
          });
          send({ method: "turn/completed", params: { threadId: childThreadId, turn: { id: childTurnId, status: "completed" } } });
          send({
            method: "item/completed",
            params: {
              threadId,
              item: { id: "collab1", type: "collabAgentToolCall", tool: "spawn_agent", status: "completed", receiverThreadIds: [childThreadId] }
            }
          });
        }

        let answer = `DONE:${threadId}:${prompt.slice(0, 80)}${steerText ? ` | STEERED:${steerText}` : ""}`;
        if (prompt.includes("[ADVERSARIAL]") || params.outputSchema) {
          answer = JSON.stringify({
            verdict: "needs-attention",
            summary: "Found one high-severity guard gap.",
            findings: [
              {
                severity: "high",
                title: "Missing input validation",
                body: "Unchecked parameter can throw at runtime.",
                file: "src/app.js",
                line_start: 1,
                line_end: 5,
                confidence: 0.92,
                recommendation: "Validate before use."
              }
            ],
            next_steps: ["Add guard and unit test."]
          });
        } else if (process.env.FAKE_CODEX_STOP_VERDICT === "BLOCK" || prompt.includes("[STOP_BLOCK]")) {
          answer = "BLOCK: Missing null check on auth token.";
        } else if (process.env.FAKE_CODEX_STOP_VERDICT === "ALLOW" || prompt.includes("[STOP_ALLOW]")) {
          answer = "ALLOW: Changes look safe.";
        }

        send({
          method: "item/completed",
          params: {
            threadId,
            item: { id: `msg_${seq++}`, type: "agentMessage", phase: "final_answer", text: answer }
          }
        });

        if (!prompt.includes("[INFER_COMPLETE]")) {
          send({
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "completed" } }
          });
        }
      };

      const timer = setTimeout(finish, delayMs);
      activeTimers.set(threadId, { timer, turnId });
      return;
    }

    case "turn/steer": {
      if (process.env.FAKE_CODEX_NO_STEER === "1") {
        sendError(id, -32601, "Method not found: turn/steer");
        return;
      }
      steeredPrompts.set(params.threadId, params.input?.[0]?.text ?? "");
      sendResult(id, { ok: true });
      return;
    }

    case "turn/interrupt": {
      const active = activeTimers.get(params.threadId);
      if (active) {
        clearTimeout(active.timer);
        activeTimers.delete(params.threadId);
      }
      sendResult(id, {});
      send({
        method: "turn/completed",
        params: { threadId: params.threadId, turn: { id: params.turnId ?? "turn", status: "interrupted" } }
      });
      return;
    }

    default:
      sendError(id, -32601, `Unknown method: ${method}`);
  }
}

function handleClientResponse(msg) {
  const pending = pendingApprovals.get(msg.id);
  if (!pending) {
    return;
  }
  pendingApprovals.delete(msg.id);
  const decision = msg.result?.decision ?? "unknown";
  send({
    method: "item/completed",
    params: {
      threadId: pending.threadId,
      item: { id: `msg_${seq++}`, type: "agentMessage", phase: "final_answer", text: `APPROVED:${decision}` }
    }
  });
  send({
    method: "turn/completed",
    params: { threadId: pending.threadId, turn: { id: pending.turnId, status: "completed" } }
  });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      const msg = JSON.parse(line);
      if (msg.method && msg.id !== undefined) {
        handleRequest(msg);
      } else if (msg.id !== undefined && !msg.method) {
        handleClientResponse(msg);
      }
    }
    nl = buf.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));
