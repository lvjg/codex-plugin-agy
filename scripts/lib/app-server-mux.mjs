import { spawn } from "node:child_process";
import process from "node:process";

import { resolveCodexBinary } from "./codex-env.mjs";
import { terminateProcessTree } from "./process.mjs";
import {
  applyTurnNotification,
  createTurnCaptureState,
  extractThreadId,
  failTurn,
  registerThread
} from "./turn-capture.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLIENT_INFO = {
  title: "Codex Bridge",
  name: "Antigravity",
  version: "0.1.0"
};

const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function createProtocolError(message, data = undefined) {
  const err = new Error(message);
  err.data = data;
  if (data && typeof data.code === "number") {
    err.rpcCode = data.code;
  }
  return err;
}

export class MuxAppServerClient {
  constructor(workspaceRoot, options = {}) {
    this.workspaceRoot = workspaceRoot;
    this.codexBin = options.codexBin ?? resolveCodexBinary();
    this.env = options.env ?? process.env;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;

    this.child = null;
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.lineBuffer = "";
    this.stderr = "";
    this.closed = false;
    this.initialized = false;
    this.lastActivityAt = Date.now();

    // Many-to-one reverse index: Map<rootOrChildThreadId, CaptureRegistration>
    this.threadToCapture = new Map();
    this.activeCaptures = new Set();
    // Server-initiated requests awaiting host approval/input (approvalPolicy: "on-request")
    this.pendingServerRequests = new Map();
    this.onServerRequest = options.onServerRequest ?? null;
  }

  static async connect(workspaceRoot, options = {}) {
    const client = new MuxAppServerClient(workspaceRoot, options);
    await client.start();
    return client;
  }

  get activeCaptureCount() {
    return this.activeCaptures.size;
  }

  async start() {
    if (!this.codexBin) {
      throw new Error("Codex CLI binary not found. Install `@openai/codex` or set CODEX_BIN.");
    }

    const child = spawn(this.codexBin, ["app-server"], {
      cwd: this.workspaceRoot,
      env: this.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => this.#handleStdoutChunk(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 64 * 1024) {
        this.stderr = this.stderr.slice(-32 * 1024);
      }
    });

    child.on("error", (error) => {
      this.#handleExit(createProtocolError(`codex app-server spawn error: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (!this.closed) {
        const detail = this.stderr.trim() ? ` (${this.stderr.trim().slice(-400)})` : "";
        this.#handleExit(
          createProtocolError(
            `codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})${detail}`
          )
        );
      }
    });

    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: this.capabilities
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  #sendMessage(message) {
    if (this.closed || !this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("codex app-server transport is closed.");
    }
    this.lastActivityAt = Date.now();
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, options = {}) {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client is closed."));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve,
        reject,
        method,
        onResultSync: typeof options.onResultSync === "function" ? options.onResultSync : null
      });
      try {
        this.#sendMessage({ id, method, params });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.#sendMessage({ method, params });
  }

  respondToServerRequest(requestId, { result, error }) {
    const entry = this.pendingServerRequests.get(requestId);
    if (!entry) {
      throw new Error(`No pending server request found for requestId=${requestId}.`);
    }
    this.pendingServerRequests.delete(requestId);
    if (error) {
      this.#sendMessage({ id: entry.rawId, error });
    } else {
      this.#sendMessage({ id: entry.rawId, result: result ?? {} });
    }
    return entry;
  }

  registerCapture(rootThreadId, options = {}) {
    const capture = createTurnCaptureState(rootThreadId, {
      ...options,
      onThreadRegistered: (childThreadId) => {
        this.threadToCapture.set(childThreadId, entry);
      }
    });

    const entry = {
      capture,
      approvalPolicy: options.approvalPolicy ?? "never",
      jobId: options.jobId ?? null,
      cleanup: () => {
        this.activeCaptures.delete(entry);
        for (const tid of capture.threadIds) {
          if (this.threadToCapture.get(tid) === entry) {
            this.threadToCapture.delete(tid);
          }
        }
      }
    };

    this.activeCaptures.add(entry);
    this.threadToCapture.set(rootThreadId, entry);

    // Ensure cleanup once capture finishes.
    capture.completion.finally(() => {
      entry.cleanup();
    });

    return entry;
  }

  bindExtraThread(entry, extraThreadId, makePrimary = false) {
    if (!extraThreadId) {
      return;
    }
    registerThread(entry.capture, extraThreadId);
    this.threadToCapture.set(extraThreadId, entry);
    if (makePrimary) {
      entry.capture.threadId = extraThreadId;
    }
  }

  #handleStdoutChunk(chunk) {
    this.lineBuffer += chunk;
    let nl = this.lineBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.lineBuffer.slice(0, nl);
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      this.#handleLine(line);
      nl = this.lineBuffer.indexOf("\n");
    }
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      this.#handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${err.message}`, { line: trimmed }));
      return;
    }

    this.lastActivityAt = Date.now();

    // 1. Server-initiated JSON-RPC request (approvals / user input)
    if (message.id !== undefined && message.method) {
      this.#handleServerRequest(message);
      return;
    }

    // 2. Response to our client request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(
          createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error)
        );
      } else {
        const result = message.result ?? {};
        try {
          pending.onResultSync?.(result);
        } catch (syncErr) {
          pending.reject(syncErr);
          return;
        }
        pending.resolve(result);
      }
      return;
    }

    // 3. Server notification: route via many-to-one thread index
    if (message.method) {
      this.#routeNotification(message);
    }
  }

  #routeNotification(message) {
    const threadId = extractThreadId(message);
    if (threadId) {
      const entry = this.threadToCapture.get(threadId);
      if (entry) {
        applyTurnNotification(entry.capture, message);
        return;
      }
    }

    // Broadcast thread metadata events only when a single capture is active or thread belongs to none yet.
    if (message.method === "thread/started" && this.activeCaptures.size === 1) {
      const [only] = this.activeCaptures;
      applyTurnNotification(only.capture, message);
    }
  }

  #handleServerRequest(message) {
    const threadId = extractThreadId(message);
    const entry = threadId ? this.threadToCapture.get(threadId) : null;

    if (entry && entry.approvalPolicy === "on-request" && typeof this.onServerRequest === "function") {
      const requestId = `req-${String(message.id)}`;
      const record = {
        requestId,
        rawId: message.id,
        method: message.method,
        params: message.params ?? {},
        threadId,
        jobId: entry.jobId,
        createdAt: new Date().toISOString()
      };
      this.pendingServerRequests.set(requestId, record);
      this.onServerRequest(record);
      return;
    }

    this.#sendMessage({
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported server request in non-interactive mode: ${message.method}`
      }
    });
  }

  #handleExit(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const entry of [...this.activeCaptures]) {
      failTurn(entry.capture, error);
    }
    this.activeCaptures.clear();
    this.threadToCapture.clear();
    this.pendingServerRequests.clear();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const closeError = new Error("codex app-server client closed.");
    for (const pending of this.pendingRequests.values()) {
      pending.reject(closeError);
    }
    this.pendingRequests.clear();

    for (const entry of [...this.activeCaptures]) {
      failTurn(entry.capture, closeError);
    }
    this.activeCaptures.clear();
    this.threadToCapture.clear();
    this.pendingServerRequests.clear();

    if (this.child) {
      const child = this.child;
      const pid = child.pid;
      this.child = null;
      try {
        child.stdin?.end();
      } catch {
        // Ignore stdin close failure.
      }
      terminateProcessTree(pid, { signal: "SIGTERM" });
      if (process.platform !== "win32" && pid) {
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            terminateProcessTree(pid, { signal: "SIGKILL" });
          }
        }, 2_000);
        killTimer.unref?.();
      }
    }
  }
}

export class WorkspaceAppServerPool {
  constructor(options = {}) {
    this.options = options;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.clients = new Map();
    this.connecting = new Map();
    this.reaperTimer = setInterval(() => this.reapIdleClients(), Math.min(60_000, Math.max(5_000, this.idleTtlMs / 3)));
    this.reaperTimer.unref?.();
  }

  async getClient(cwd, perCallOptions = {}) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const existing = this.clients.get(workspaceRoot);
    if (existing && !existing.closed) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    if (existing?.closed) {
      this.clients.delete(workspaceRoot);
    }

    if (this.connecting.has(workspaceRoot)) {
      return this.connecting.get(workspaceRoot);
    }

    const promise = MuxAppServerClient.connect(workspaceRoot, {
      ...this.options,
      ...perCallOptions
    })
      .then((client) => {
        this.clients.set(workspaceRoot, client);
        this.connecting.delete(workspaceRoot);
        return client;
      })
      .catch((err) => {
        this.connecting.delete(workspaceRoot);
        throw err;
      });

    this.connecting.set(workspaceRoot, promise);
    return promise;
  }

  getStatus(cwd) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const client = this.clients.get(workspaceRoot);
    return {
      workspaceRoot,
      alive: Boolean(client && !client.closed),
      activeCaptures: client && !client.closed ? client.activeCaptureCount : 0,
      pooledWorkspaces: this.clients.size
    };
  }

  reapIdleClients() {
    const now = Date.now();
    for (const [workspaceRoot, client] of this.clients.entries()) {
      if (client.closed) {
        this.clients.delete(workspaceRoot);
        continue;
      }
      if (client.activeCaptureCount === 0 && now - client.lastActivityAt > this.idleTtlMs) {
        this.clients.delete(workspaceRoot);
        client.close().catch(() => {});
      }
    }
  }

  async closeAll() {
    clearInterval(this.reaperTimer);
    const closes = [];
    for (const client of this.clients.values()) {
      closes.push(client.close().catch(() => {}));
    }
    this.clients.clear();
    this.connecting.clear();
    await Promise.all(closes);
  }
}
