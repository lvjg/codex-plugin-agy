import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { extractAntigravityHandoff } from "./agy-session-transfer.mjs";
import { WorkspaceAppServerPool } from "./app-server-mux.mjs";
import { getCodexAuthStatusFromClient, getCodexAvailability } from "./codex-env.mjs";
import { buildNativeReviewTarget, collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./git.mjs";
import { interpolateTemplate, loadPromptTemplate, readJsonSchema } from "./prompts.mjs";
import {
  appendJobLog,
  generateJobId,
  getConfig,
  getJob,
  getJobLogPath,
  listJobs,
  readLogTail,
  setConfig,
  upsertJob
} from "./state-store.mjs";
import { cancelTurn, collectTouchedFiles } from "./turn-capture.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { createIsolatedWorktree, removeIsolatedWorktree } from "./worktree.mjs";

const SERVICE_NAME = "antigravity_codex_bridge";
const TASK_THREAD_PREFIX = "Codex Bridge Task";
const MAX_RETURN_MESSAGE_BYTES = 16 * 1024;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(LIB_DIR, "../..");

function buildTurnInput(prompt) {
  return [{ type: "text", text: String(prompt), text_elements: [] }];
}

function buildThreadName(prompt) {
  const clean = String(prompt ?? "").trim().replace(/\s+/g, " ");
  if (!clean) {
    return TASK_THREAD_PREFIX;
  }
  const excerpt = clean.length <= 56 ? clean : `${clean.slice(0, 53)}...`;
  return `${TASK_THREAD_PREFIX}: ${excerpt}`;
}

function truncateReturnText(text, maxBytes = MAX_RETURN_MESSAGE_BYTES) {
  const str = String(text ?? "");
  if (Buffer.byteLength(str, "utf8") <= maxBytes) {
    return { text: str, truncated: false };
  }
  let end = Math.min(str.length, maxBytes);
  while (end > 0 && Buffer.byteLength(str.slice(0, end), "utf8") > maxBytes - 120) {
    end -= 128;
  }
  const clipped = str.slice(0, Math.max(0, end));
  return {
    text: `${clipped}\n\n[Output truncated at 16KB. Read full output from logPath.]`,
    truncated: true
  };
}

function isUnsupportedMethodError(error) {
  const code = error?.rpcCode ?? error?.data?.code;
  const msg = String(error?.message ?? error ?? "");
  return (
    code === -32601 ||
    /method not found|unknown method|unknown variant|unsupported/i.test(msg)
  );
}

function parseJsonSafe(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

export class CodexJobManager {
  constructor(options = {}) {
    this.pluginRoot = options.pluginRoot ?? process.env.PLUGIN_ROOT ?? DEFAULT_PLUGIN_ROOT;
    this.codexBin = options.codexBin ?? null;
    this.allowedTranscriptRoots = options.allowedTranscriptRoots ?? [];
    this.inferredCompletionDelayMs = options.inferredCompletionDelayMs ?? 250;

    this.liveJobs = new Map(); // jobId -> LiveJob
    this.threadToJobId = new Map(); // threadId -> jobId
    this.waiters = new Set(); // Set<() => void>

    this.pool = new WorkspaceAppServerPool({
      codexBin: this.codexBin,
      env: options.env ?? process.env,
      idleTtlMs: options.idleTtlMs,
      onServerRequest: (req) => this.#handleIncomingServerRequest(req)
    });
  }

  #notifyWaiters() {
    for (const wake of [...this.waiters]) {
      wake();
    }
  }

  #evictLiveJob(live) {
    if (!live) {
      return;
    }
    this.liveJobs.delete(live.jobId);
    for (const [tid, jid] of this.threadToJobId.entries()) {
      if (jid === live.jobId) {
        this.threadToJobId.delete(tid);
      }
    }
  }

  #handleIncomingServerRequest(req) {
    const live = req.jobId ? this.liveJobs.get(req.jobId) : null;
    if (!live) {
      return;
    }
    live.status = "awaiting_input";
    live.updatedAt = new Date().toISOString();
    live.pendingRequest = {
      requestId: req.requestId,
      method: req.method,
      params: req.params,
      threadId: req.threadId,
      createdAt: req.createdAt
    };
    appendJobLog(live.logPath, `Awaiting host response for ${req.method} (${req.requestId})`);
    upsertJob(live.workspaceRoot, this.#serializeJobRecord(live));
    this.#notifyWaiters();
  }

  #serializeJobRecord(live) {
    return {
      jobId: live.jobId,
      kind: live.kind,
      mode: live.mode ?? null,
      status: live.status,
      phase: live.capture?.phase ?? live.phase ?? null,
      lastEvent: live.capture?.lastEvent ?? live.lastEvent ?? null,
      workspaceRoot: live.workspaceRoot,
      cwd: live.cwd,
      conversationId: live.conversationId ?? null,
      threadId: live.threadId ?? null,
      sourceThreadId: live.sourceThreadId ?? null,
      turnId: live.capture?.turnId ?? live.turnId ?? null,
      worktreePath: live.worktreePath ?? null,
      branchName: live.branchName ?? null,
      logPath: live.logPath,
      startedAt: live.startedAt,
      updatedAt: live.updatedAt ?? live.startedAt,
      completedAt: live.completedAt ?? null,
      filesChanged: live.filesChanged ?? [],
      finalMessage: live.finalMessage ?? null,
      reviewText: live.reviewText ?? null,
      structuredReview: live.structuredReview ?? null,
      structuredOutput: live.structuredOutput ?? null,
      pendingRequest: live.pendingRequest ?? null,
      error: live.error ?? null
    };
  }

  #buildJobResultPayload(record, includeRawLogTailLines = 0) {
    const base = {
      jobId: record.jobId,
      kind: record.kind,
      mode: record.mode ?? undefined,
      status: record.status,
      phase: record.phase,
      threadId: record.threadId,
      turnId: record.turnId,
      worktreePath: record.worktreePath ?? undefined,
      branchName: record.branchName ?? undefined,
      filesChanged: record.filesChanged ?? [],
      logPath: record.logPath,
      error: record.error ?? undefined
    };

    if (record.pendingRequest) {
      base.pendingRequest = record.pendingRequest;
    }

    if (record.kind === "review") {
      if (record.mode === "adversarial") {
        base.structuredReview = record.structuredReview ?? undefined;
        if (!record.structuredReview && record.finalMessage) {
          const { text, truncated } = truncateReturnText(record.finalMessage);
          base.finalMessage = text;
          if (truncated) {
            base.truncated = true;
          }
        }
      } else {
        const { text, truncated } = truncateReturnText(record.reviewText || record.finalMessage || "");
        base.reviewText = text;
        if (truncated) {
          base.truncated = true;
        }
      }
    } else if (record.finalMessage != null) {
      const { text, truncated } = truncateReturnText(record.finalMessage);
      base.finalMessage = text;
      if (truncated) {
        base.truncated = true;
      }
      if (record.structuredOutput !== undefined && record.structuredOutput !== null) {
        base.structuredOutput = record.structuredOutput;
      }
    }

    if (includeRawLogTailLines > 0) {
      base.logTail = readLogTail(record.logPath, includeRawLogTailLines);
    }

    return base;
  }

  async setup(args = {}) {
    const cwd = args.cwd || process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);

    if (args.enableReviewGate === true && args.disableReviewGate === true) {
      throw new Error("Cannot pass both `enableReviewGate: true` and `disableReviewGate: true`.");
    }

    const configPatch = {};
    if (args.enableReviewGate === true) {
      configPatch.stopReviewGate = true;
    }
    if (args.disableReviewGate === true) {
      configPatch.stopReviewGate = false;
    }
    if (typeof args.blockStopWhileJobsRunning === "boolean") {
      configPatch.blockStopWhileJobsRunning = args.blockStopWhileJobsRunning;
    }
    if (typeof args.strictStopGate === "boolean") {
      configPatch.strictStopGate = args.strictStopGate;
    }

    const config = Object.keys(configPatch).length > 0 ? setConfig(workspaceRoot, configPatch) : getConfig(workspaceRoot);
    const availability = getCodexAvailability(workspaceRoot, { codexBin: this.codexBin });

    if (!availability.available) {
      return {
        available: false,
        binaryPath: availability.binaryPath,
        version: availability.version,
        authenticated: false,
        capabilities: { steer: false, fork: false },
        config,
        diagnostics: availability.detail
      };
    }

    let auth = { loggedIn: false, authMethod: null, provider: null, detail: "not checked" };
    try {
      const client = await this.pool.getClient(workspaceRoot);
      auth = await getCodexAuthStatusFromClient(client, workspaceRoot);
    } catch (err) {
      auth = {
        loggedIn: false,
        authMethod: null,
        provider: null,
        detail: err instanceof Error ? err.message : String(err)
      };
    }

    return {
      available: true,
      binaryPath: availability.binaryPath,
      version: availability.version,
      authenticated: auth.loggedIn,
      authMethod: auth.authMethod,
      provider: auth.provider,
      capabilities: {
        steer: "probed_on_call",
        fork: "probed_on_call"
      },
      config,
      diagnostics: auth.detail
    };
  }

  async #ensureClient(workspaceRoot) {
    const availability = getCodexAvailability(workspaceRoot, { codexBin: this.codexBin });
    if (!availability.available) {
      throw new Error(
        `${availability.detail} Run /codex-setup after installing Codex CLI.`
      );
    }
    return this.pool.getClient(workspaceRoot);
  }

  async #startOrResumeThread(client, targetCwd, options = {}) {
    const sandbox = options.sandbox ?? "workspace-write";
    const approvalPolicy = options.approvalPolicy ?? "never";
    const stateWorkspaceRoot = options.stateWorkspaceRoot ?? targetCwd;
    let threadId = options.threadId ?? null;

    if (!threadId && options.resumeLast) {
      const jobs = listJobs(stateWorkspaceRoot).filter(
        (j) => j.kind === "task" && j.threadId && (!options.conversationId || j.conversationId === options.conversationId)
      );
      if (jobs[0]?.threadId) {
        threadId = jobs[0].threadId;
      } else {
        const listed = await client.request("thread/list", {
          cwd: stateWorkspaceRoot,
          limit: 10,
          sortKey: "updated_at",
          sourceKinds: ["appServer"],
          searchTerm: TASK_THREAD_PREFIX
        });
        threadId = listed?.data?.[0]?.id ?? listed?.threads?.[0]?.id ?? null;
      }
    }

    if (threadId) {
      const resumed = await client.request("thread/resume", {
        threadId,
        cwd: targetCwd,
        model: options.model ?? null,
        approvalPolicy,
        sandbox
      });
      return resumed?.thread?.id ?? threadId;
    }

    const started = await client.request("thread/start", {
      cwd: targetCwd,
      model: options.model ?? null,
      approvalPolicy,
      sandbox,
      serviceName: SERVICE_NAME,
      ephemeral: options.ephemeral ?? false
    });
    const newThreadId = started?.thread?.id;
    if (!newThreadId) {
      throw new Error("codex app-server thread/start returned no thread.id.");
    }

    if (options.threadName) {
      try {
        await client.request("thread/name/set", {
          threadId: newThreadId,
          name: options.threadName
        });
      } catch (err) {
        if (!isUnsupportedMethodError(err)) {
          throw err;
        }
      }
    }

    return newThreadId;
  }

  async #launchTask(args = {}, { waitForCompletion = false } = {}) {
    const rawCwd = args.cwd || process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(rawCwd);
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) {
      throw new Error("`prompt` is required.");
    }

    const jobId = generateJobId("task");
    const logPath = getJobLogPath(workspaceRoot, jobId);
    const sandbox = args.sandbox === "read-only" ? "read-only" : "workspace-write";
    const approvalPolicy = args.approvalPolicy === "on-request" ? "on-request" : "never";
    const ephemeral = typeof args.ephemeral === "boolean" ? args.ephemeral : false;

    const client = await this.#ensureClient(workspaceRoot);

    let effectiveCwd = rawCwd;
    let worktreePath = null;
    let branchName = null;

    if (args.worktree === "create") {
      const wt = createIsolatedWorktree(workspaceRoot, jobId);
      effectiveCwd = wt.worktreePath;
      worktreePath = wt.worktreePath;
      branchName = wt.branchName;
    }

    let threadId;
    try {
      threadId = await this.#startOrResumeThread(client, effectiveCwd, {
        stateWorkspaceRoot: workspaceRoot,
        threadId: args.threadId,
        resumeLast: Boolean(args.resumeLast),
        conversationId: args.conversationId,
        model: args.model,
        sandbox,
        approvalPolicy,
        ephemeral,
        threadName: buildThreadName(prompt)
      });
    } catch (err) {
      if (worktreePath) {
        try {
          removeIsolatedWorktree(workspaceRoot, worktreePath, branchName);
        } catch {
          // Best-effort rollback of freshly created worktree.
        }
      }
      throw err;
    }

    const now = new Date().toISOString();
    const live = {
      jobId,
      kind: "task",
      mode: sandbox,
      status: "running",
      workspaceRoot,
      cwd: effectiveCwd,
      conversationId: args.conversationId ?? null,
      threadId,
      turnId: null,
      worktreePath,
      branchName,
      logPath,
      client,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      filesChanged: [],
      finalMessage: null,
      structuredOutput: null,
      pendingRequest: null,
      error: null,
      capture: null
    };

    const entry = client.registerCapture(threadId, {
      jobId,
      approvalPolicy,
      inferredCompletionDelayMs: this.inferredCompletionDelayMs,
      onProgress: ({ message, phase }) => {
        live.updatedAt = new Date().toISOString();
        appendJobLog(logPath, `[${phase ?? "progress"}] ${message}`);
      }
    });
    live.capture = entry.capture;
    this.liveJobs.set(jobId, live);
    this.threadToJobId.set(threadId, jobId);

    appendJobLog(logPath, `Started task job=${jobId} thread=${threadId} sandbox=${sandbox} cwd=${effectiveCwd}`);
    upsertJob(workspaceRoot, this.#serializeJobRecord(live));

    try {
      const turnRes = await client.request("turn/start", {
        threadId,
        input: buildTurnInput(prompt),
        model: args.model ?? null,
        effort: args.effort ?? null,
        outputSchema: args.outputSchema ?? null
      });
      live.turnId = turnRes?.turn?.id ?? entry.capture.turnId ?? null;
      if (live.turnId && !entry.capture.turnId) {
        entry.capture.turnId = live.turnId;
      }
      live.updatedAt = new Date().toISOString();
      upsertJob(workspaceRoot, this.#serializeJobRecord(live));
    } catch (err) {
      live.status = "failed";
      live.error = err instanceof Error ? err.message : String(err);
      live.completedAt = new Date().toISOString();
      live.updatedAt = live.completedAt;
      entry.cleanup();
      if (worktreePath) {
        try {
          removeIsolatedWorktree(workspaceRoot, worktreePath, branchName);
          live.worktreePath = null;
          live.branchName = null;
        } catch {
          // Best-effort rollback of freshly created worktree.
        }
      }
      upsertJob(workspaceRoot, this.#serializeJobRecord(live));
      this.#evictLiveJob(live);
      this.#notifyWaiters();
      throw err;
    }

    const finalizePromise = entry.capture.completion.then((state) => {
      live.turnId = state.turnId ?? live.turnId;
      live.filesChanged = collectTouchedFiles(state.fileChanges);
      live.finalMessage = state.lastAgentMessage || "";
      if (args.outputSchema) {
        live.structuredOutput = parseJsonSafe(live.finalMessage);
      }
      live.pendingRequest = null;
      live.completedAt = new Date().toISOString();
      live.updatedAt = live.completedAt;

      if (live.status !== "cancelled") {
        const failed = state.finalTurn?.status === "failed" || Boolean(state.error);
        const interrupted = state.finalTurn?.status === "interrupted";
        if (interrupted) {
          live.status = "cancelled";
        } else if (failed) {
          live.status = "failed";
          live.error = state.error?.message ?? "Codex turn failed.";
        } else {
          live.status = "completed";
        }
      }

      appendJobLog(logPath, `Finished status=${live.status}\n${live.finalMessage}`);
      const persisted = upsertJob(workspaceRoot, this.#serializeJobRecord(live));
      this.#evictLiveJob(live);
      this.#notifyWaiters();
      return persisted;
    });

    live.finalizePromise = finalizePromise;

    if (waitForCompletion) {
      const finished = await finalizePromise;
      return this.#buildJobResultPayload(finished);
    }

    return {
      jobId,
      threadId,
      turnId: live.turnId,
      status: live.status,
      worktreePath: worktreePath ?? undefined,
      branchName: branchName ?? undefined,
      logPath
    };
  }

  async runTask(args = {}) {
    return this.#launchTask(args, { waitForCompletion: true });
  }

  async startTask(args = {}) {
    return this.#launchTask(args, { waitForCompletion: false });
  }

  async runReview(args = {}) {
    const rawCwd = args.cwd || process.cwd();
    const workspaceRoot = ensureGitRepository(rawCwd);
    const mode = args.mode === "adversarial" ? "adversarial" : "standard";
    const focus = String(args.focus ?? "").trim();

    if (mode === "standard" && focus) {
      throw new Error(
        "Standard native review (`mode: \"standard\"`) does not support custom `focus` text. Retry with `mode: \"adversarial\"` and pass `focus`."
      );
    }

    const target = resolveReviewTarget(workspaceRoot, {
      scope: args.scope ?? "auto",
      baseRef: args.baseRef
    });

    const jobId = generateJobId(mode === "adversarial" ? "adv-review" : "review");
    const logPath = getJobLogPath(workspaceRoot, jobId);
    const client = await this.#ensureClient(workspaceRoot);

    // Reviews are strictly read-only and ephemeral by default.
    const sourceThreadId = await this.#startOrResumeThread(client, workspaceRoot, {
      model: args.model,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      threadName: `Codex ${mode === "adversarial" ? "Adversarial " : ""}Review`
    });

    const live = {
      jobId,
      kind: "review",
      mode,
      status: "running",
      workspaceRoot,
      cwd: workspaceRoot,
      conversationId: args.conversationId ?? null,
      threadId: sourceThreadId,
      sourceThreadId,
      turnId: null,
      logPath,
      client,
      startedAt: new Date().toISOString(),
      completedAt: null,
      filesChanged: [],
      finalMessage: null,
      reviewText: null,
      structuredReview: null,
      pendingRequest: null,
      error: null,
      capture: null
    };

    const entry = client.registerCapture(sourceThreadId, {
      jobId,
      approvalPolicy: "never",
      inferredCompletionDelayMs: this.inferredCompletionDelayMs,
      onProgress: ({ message, phase }) => {
        appendJobLog(logPath, `[${phase ?? "review"}] ${message}`);
      }
    });
    live.capture = entry.capture;
    this.liveJobs.set(jobId, live);
    this.threadToJobId.set(sourceThreadId, jobId);

    appendJobLog(logPath, `Started ${mode} review job=${jobId} thread=${sourceThreadId} target=${target.label}`);
    upsertJob(workspaceRoot, this.#serializeJobRecord(live));

    try {
      if (mode === "standard") {
        const nativeTarget = buildNativeReviewTarget(target);
        const delivery = args.delivery ?? "inline";
        const res = await client.request(
          "review/start",
          {
            threadId: sourceThreadId,
            delivery,
            target: nativeTarget
          },
          {
            onResultSync: (syncRes) => {
              if (syncRes?.reviewThreadId) {
                client.bindExtraThread(entry, syncRes.reviewThreadId, delivery === "detached");
                this.threadToJobId.set(syncRes.reviewThreadId, jobId);
                if (delivery === "detached") {
                  live.threadId = syncRes.reviewThreadId;
                }
              }
            }
          }
        );
        live.turnId = res?.turn?.id ?? entry.capture.turnId ?? null;
        if (live.turnId && !entry.capture.turnId) {
          entry.capture.turnId = live.turnId;
        }
      } else {
        const schema = readJsonSchema(this.pluginRoot, "review-output.schema.json");
        const template = loadPromptTemplate(this.pluginRoot, "adversarial-review");
        const reviewContext = collectReviewContext(workspaceRoot, target);
        const focusGuidance = focus ? `User focus area:\n${focus}\n` : "";
        const prompt = interpolateTemplate(template, {
          REVIEW_COLLECTION_GUIDANCE: focusGuidance,
          REVIEW_INPUT: reviewContext
        });

        const res = await client.request("turn/start", {
          threadId: sourceThreadId,
          input: buildTurnInput(prompt),
          model: args.model ?? null,
          effort: args.effort ?? null,
          outputSchema: schema
        });
        live.turnId = res?.turn?.id ?? entry.capture.turnId ?? null;
        if (live.turnId && !entry.capture.turnId) {
          entry.capture.turnId = live.turnId;
        }
      }
      live.updatedAt = new Date().toISOString();
      upsertJob(workspaceRoot, this.#serializeJobRecord(live));
    } catch (err) {
      live.status = "failed";
      live.error = err instanceof Error ? err.message : String(err);
      live.completedAt = new Date().toISOString();
      live.updatedAt = live.completedAt;
      entry.cleanup();
      upsertJob(workspaceRoot, this.#serializeJobRecord(live));
      this.#evictLiveJob(live);
      this.#notifyWaiters();
      throw err;
    }

    const state = await entry.capture.completion;
    live.turnId = state.turnId ?? live.turnId;
    live.completedAt = new Date().toISOString();
    live.updatedAt = live.completedAt;
    live.reviewText = state.reviewText || "";
    live.finalMessage = state.lastAgentMessage || "";

    if (mode === "adversarial") {
      live.structuredReview = parseJsonSafe(live.finalMessage);
    }

    const failed = state.finalTurn?.status === "failed" || Boolean(state.error);
    if (live.status !== "cancelled") {
      live.status = failed ? "failed" : "completed";
      if (failed) {
        live.error = state.error?.message ?? "Codex review failed.";
      }
    }

    appendJobLog(logPath, `Finished review status=${live.status}\n${live.reviewText || live.finalMessage}`);
    const persisted = upsertJob(workspaceRoot, this.#serializeJobRecord(live));
    this.#evictLiveJob(live);
    this.#notifyWaiters();
    return this.#buildJobResultPayload(persisted);
  }

  getStatus(args = {}) {
    const cwd = args.cwd || process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);

    if (args.jobId) {
      const live = this.liveJobs.get(args.jobId);
      const record = live ? this.#serializeJobRecord(live) : getJob(workspaceRoot, args.jobId);
      if (!record) {
        throw new Error(`Job not found: ${args.jobId}`);
      }
      return this.#buildJobResultPayload(record, Number(args.includeRawLogTailLines) || 0);
    }

    const persisted = listJobs(workspaceRoot);
    const mergedMap = new Map();
    for (const job of persisted) {
      mergedMap.set(job.jobId, job);
    }
    for (const live of this.liveJobs.values()) {
      if (live.workspaceRoot === workspaceRoot) {
        mergedMap.set(live.jobId, this.#serializeJobRecord(live));
      }
    }

    let jobs = [...mergedMap.values()].sort((a, b) =>
      String(b.updatedAt ?? b.startedAt ?? "").localeCompare(String(a.updatedAt ?? a.startedAt ?? ""))
    );

    if (args.conversationId) {
      jobs = jobs.filter((j) => j.conversationId === args.conversationId);
    }
    if (args.includeCompleted === false) {
      jobs = jobs.filter((j) => j.status === "queued" || j.status === "running" || j.status === "awaiting_input");
    }

    const now = Date.now();
    const summaries = jobs.map((j) => {
      const startMs = j.startedAt ? Date.parse(j.startedAt) : now;
      const endMs = j.completedAt ? Date.parse(j.completedAt) : now;
      return {
        jobId: j.jobId,
        kind: j.kind,
        mode: j.mode,
        status: j.status,
        phase: j.phase,
        threadId: j.threadId,
        turnId: j.turnId,
        conversationId: j.conversationId,
        elapsedMs: Math.max(0, endMs - startMs),
        lastEvent: j.lastEvent,
        worktreePath: j.worktreePath ?? undefined,
        logPath: j.logPath
      };
    });

    const activeCount = summaries.filter((s) => s.status === "running" || s.status === "awaiting_input").length;
    return {
      poolStatus: this.pool.getStatus(workspaceRoot),
      activeCount,
      jobs: summaries
    };
  }

  async waitForJobs(args = {}) {
    const jobIds = Array.isArray(args.jobIds) ? args.jobIds.filter(Boolean) : [];
    if (jobIds.length === 0) {
      throw new Error("`jobIds` must be a non-empty array.");
    }

    const cwd = args.cwd || process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const waitMode = args.waitMode === "all" ? "all" : "any";
    const timeoutMs = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(100, Number(args.timeoutMs) || DEFAULT_WAIT_TIMEOUT_MS)
    );
    const deadline = Date.now() + timeoutMs;

    const snapshot = () => {
      const completed = [];
      const awaitingInput = [];
      const running = [];
      const now = Date.now();

      for (const id of jobIds) {
        const live = this.liveJobs.get(id);
        const rec = live ? this.#serializeJobRecord(live) : getJob(workspaceRoot, id);
        if (!rec) {
          completed.push({ jobId: id, status: "not_found", error: `Unknown jobId: ${id}` });
          continue;
        }
        if (rec.status === "awaiting_input") {
          awaitingInput.push({
            jobId: rec.jobId,
            threadId: rec.threadId,
            status: rec.status,
            pendingRequest: rec.pendingRequest
          });
        } else if (rec.status === "running" || rec.status === "queued") {
          const startMs = rec.startedAt ? Date.parse(rec.startedAt) : now;
          running.push({
            jobId: rec.jobId,
            threadId: rec.threadId,
            status: rec.status,
            phase: rec.phase,
            lastEvent: rec.lastEvent,
            elapsedMs: Math.max(0, now - startMs)
          });
        } else {
          completed.push(this.#buildJobResultPayload(rec));
        }
      }

      const ready =
        waitMode === "all"
          ? running.length === 0
          : completed.length > 0 || awaitingInput.length > 0 || running.length === 0;

      return { completed, awaitingInput, running, ready };
    };

    let snap = snapshot();
    while (!snap.ready && Date.now() < deadline) {
      const remaining = Math.max(10, deadline - Date.now());
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          resolve();
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
      snap = snapshot();
    }

    return {
      completed: snap.completed,
      awaitingInput: snap.awaitingInput,
      running: snap.running,
      timedOut: !snap.ready
    };
  }

  #resolveLiveJob(args = {}) {
    if (args.jobId && this.liveJobs.has(args.jobId)) {
      return this.liveJobs.get(args.jobId);
    }
    if (args.threadId && this.threadToJobId.has(args.threadId)) {
      const id = this.threadToJobId.get(args.threadId);
      if (this.liveJobs.has(id)) {
        return this.liveJobs.get(id);
      }
    }
    return null;
  }

  async steerJob(args = {}) {
    const guidance = String(args.guidance ?? "").trim();
    if (!guidance) {
      throw new Error("`guidance` is required.");
    }

    const live = this.#resolveLiveJob(args);
    if (!live || live.status !== "running") {
      throw new Error("Target job is not currently running; cannot steer.");
    }
    const turnId = live.capture?.turnId ?? live.turnId;
    if (!turnId) {
      throw new Error("Target job has no active turnId yet; retry once the turn starts.");
    }

    try {
      await live.client.request("turn/steer", {
        threadId: live.threadId,
        turnId,
        input: buildTurnInput(guidance)
      });
      live.updatedAt = new Date().toISOString();
      appendJobLog(live.logPath, `[steer] ${guidance}`);
      return {
        ok: true,
        jobId: live.jobId,
        threadId: live.threadId,
        turnId
      };
    } catch (err) {
      if (isUnsupportedMethodError(err)) {
        return {
          ok: false,
          unsupportedCapability: "turn/steer",
          jobId: live.jobId,
          threadId: live.threadId,
          detail:
            "The local codex app-server does not support `turn/steer`. Use `codex_interrupt` and start a follow-up turn with the same `threadId` instead."
        };
      }
      throw err;
    }
  }

  async interruptJob(args = {}) {
    const live = this.#resolveLiveJob(args);
    const cwd = args.cwd || live?.workspaceRoot || process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);

    if (live) {
      live.status = "cancelled";
      live.completedAt = new Date().toISOString();
      if (live.threadId && live.turnId && !live.client.closed) {
        try {
          await live.client.request("turn/interrupt", {
            threadId: live.threadId,
            turnId: live.turnId
          });
        } catch {
          // Best-effort interrupt; capture is still cancelled locally.
        }
      }
      cancelTurn(live.capture, "Interrupted via codex_interrupt.");

      let worktreeCleaned = false;
      if (args.cleanupWorktree && live.worktreePath) {
        const res = removeIsolatedWorktree(live.workspaceRoot, live.worktreePath, live.branchName);
        worktreeCleaned = res.removed;
      }

      upsertJob(live.workspaceRoot, this.#serializeJobRecord(live));
      this.#evictLiveJob(live);
      this.#notifyWaiters();
      return {
        ok: true,
        jobId: live.jobId,
        threadId: live.threadId,
        status: "cancelled",
        worktreeCleaned
      };
    }

    // Fallback: cleanup worktree for an already-persisted job.
    const persisted = args.jobId ? getJob(workspaceRoot, args.jobId) : null;
    if (!persisted) {
      throw new Error("No matching active or persisted job found to interrupt.");
    }

    let worktreeCleaned = false;
    if (args.cleanupWorktree && persisted.worktreePath) {
      const res = removeIsolatedWorktree(workspaceRoot, persisted.worktreePath, persisted.branchName);
      worktreeCleaned = res.removed;
    }

    return {
      ok: true,
      jobId: persisted.jobId,
      threadId: persisted.threadId,
      status: persisted.status,
      worktreeCleaned
    };
  }

  async respondToJob(args = {}) {
    const live = this.#resolveLiveJob(args);
    if (!live) {
      throw new Error(`No live job found for jobId=${args.jobId ?? "unknown"}.`);
    }
    if (!args.requestId) {
      throw new Error("`requestId` is required.");
    }

    const resultPayload = args.result ?? {
      decision: args.decision,
      answer: args.answer
    };
    live.client.respondToServerRequest(args.requestId, {
      result: resultPayload,
      error: args.error ?? null
    });

    live.status = "running";
    live.pendingRequest = null;
    appendJobLog(live.logPath, `[respond] Sent response for ${args.requestId}`);
    upsertJob(live.workspaceRoot, this.#serializeJobRecord(live));
    this.#notifyWaiters();

    return {
      ok: true,
      jobId: live.jobId,
      threadId: live.threadId,
      status: "running"
    };
  }

  async forkThread(args = {}) {
    if (!args.threadId) {
      throw new Error("`threadId` is required.");
    }
    const cwd = args.cwd || process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const client = await this.#ensureClient(workspaceRoot);

    let newThreadId;
    try {
      const forked = await client.request("thread/fork", {
        threadId: args.threadId,
        cwd
      });
      newThreadId = forked?.thread?.id ?? forked?.threadId ?? null;
    } catch (err) {
      if (isUnsupportedMethodError(err)) {
        return {
          ok: false,
          unsupportedCapability: "thread/fork",
          detail: "The local codex app-server does not support `thread/fork`."
        };
      }
      throw err;
    }

    if (!newThreadId) {
      throw new Error("codex app-server thread/fork returned no thread ID.");
    }

    if (args.prompt?.trim()) {
      const started = await this.startTask({
        ...args,
        cwd,
        threadId: newThreadId
      });
      return {
        ok: true,
        newThreadId,
        jobId: started.jobId,
        worktreePath: started.worktreePath
      };
    }

    return {
      ok: true,
      newThreadId
    };
  }

  async transferSession(args = {}) {
    const cwd = args.cwd || process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const handoff = await extractAntigravityHandoff(workspaceRoot, args.transcriptPath, {
      focus: args.focus,
      allowedRoots: this.allowedTranscriptRoots
    });

    const result = await this.runTask({
      cwd: workspaceRoot,
      prompt: handoff.prompt,
      sandbox: "read-only",
      ephemeral: false,
      model: args.model,
      conversationId: args.conversationId
    });

    if (result.status !== "completed") {
      throw new Error(
        `Session transfer failed (${result.status}): ${result.error ?? "Codex did not acknowledge the handoff."}`
      );
    }

    return {
      jobId: result.jobId,
      threadId: result.threadId,
      resumeCommand: `codex resume ${result.threadId}`,
      summaryPreview: handoff.summaryPreview,
      codexAcknowledgement: result.finalMessage,
      logPath: result.logPath
    };
  }

  async close() {
    await this.pool.closeAll();
  }
}
