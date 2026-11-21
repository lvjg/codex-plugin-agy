import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const MAX_JOBS = 50;
const MAX_DIFF_HASH_ENTRIES = 100;
const DEFAULT_FALLBACK_ROOT = path.join(os.tmpdir(), "codex-bridge-agy");

function nowIso() {
  return new Date().toISOString();
}

export function getPluginDataRoot() {
  const envDir = process.env.PLUGIN_DATA?.trim();
  return envDir ? path.resolve(envDir) : DEFAULT_FALLBACK_ROOT;
}

export function getWorkspaceKey(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const slugSource = path.basename(root) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return { workspaceRoot: root, slug, hash, key: `${slug}-${hash}` };
}

export function resolveStateDir(cwd) {
  const { key } = getWorkspaceKey(cwd);
  return path.join(getPluginDataRoot(), "state", key);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveWorktreesDir(cwd) {
  const { hash } = getWorkspaceKey(cwd);
  return path.join(getPluginDataRoot(), "worktrees", hash);
}

export function getJobLogPath(cwd, jobId) {
  const safeId = String(jobId).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(resolveJobsDir(cwd), `${safeId}.log`);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      blockStopWhileJobsRunning: false,
      strictStopGate: false
    },
    lastReviewedDiffHash: {},
    jobs: []
  };
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      lastReviewedDiffHash:
        parsed.lastReviewedDiffHash && typeof parsed.lastReviewedDiffHash === "object"
          ? parsed.lastReviewedDiffHash
          : {},
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function pruneJobs(jobs, cwd) {
  const sorted = [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const kept = sorted.slice(0, MAX_JOBS);
  const dropped = sorted.slice(MAX_JOBS);
  for (const job of dropped) {
    if (job?.logPath && fs.existsSync(job.logPath)) {
      try {
        fs.unlinkSync(job.logPath);
      } catch {
        // Ignore stale log cleanup errors.
      }
    } else if (job?.jobId) {
      const p = getJobLogPath(cwd, job.jobId);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // Ignore stale log cleanup errors.
        }
      }
    }
  }
  return kept;
}

function pruneDiffHashes(map) {
  const entries = Object.entries(map ?? {});
  if (entries.length <= MAX_DIFF_HASH_ENTRIES) {
    return map ?? {};
  }
  const sorted = entries.sort((a, b) => String(b[1]?.updatedAt ?? "").localeCompare(String(a[1]?.updatedAt ?? "")));
  return Object.fromEntries(sorted.slice(0, MAX_DIFF_HASH_ENTRIES));
}

export function saveState(cwd, nextState) {
  ensureStateDir(cwd);
  const normalized = {
    ...defaultState(),
    ...nextState,
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(nextState.config ?? {})
    },
    lastReviewedDiffHash: pruneDiffHashes(nextState.lastReviewedDiffHash),
    jobs: pruneJobs(Array.isArray(nextState.jobs) ? nextState.jobs : [], cwd)
  };
  atomicWriteJson(resolveStateFile(cwd), normalized);
  return normalized;
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function setConfig(cwd, patch) {
  const state = loadState(cwd);
  const next = saveState(cwd, {
    ...state,
    config: {
      ...state.config,
      ...patch
    }
  });
  return next.config;
}

export function upsertJob(cwd, jobRecord) {
  const state = loadState(cwd);
  const timestamp = nowIso();
  const idx = state.jobs.findIndex((j) => j.jobId === jobRecord.jobId);
  const merged = {
    ...(idx >= 0 ? state.jobs[idx] : { createdAt: timestamp }),
    ...jobRecord,
    updatedAt: timestamp
  };
  const jobs = [...state.jobs];
  if (idx >= 0) {
    jobs[idx] = merged;
  } else {
    jobs.unshift(merged);
  }
  saveState(cwd, { ...state, jobs });
  return merged;
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function getJob(cwd, jobId) {
  return loadState(cwd).jobs.find((j) => j.jobId === jobId) ?? null;
}

export function getLastReviewedDiffHash(cwd, conversationId) {
  if (!conversationId) {
    return null;
  }
  const state = loadState(cwd);
  const entry = state.lastReviewedDiffHash[conversationId];
  return typeof entry === "string" ? entry : entry?.hash ?? null;
}

export function setLastReviewedDiffHash(cwd, conversationId, hash) {
  if (!conversationId || !hash) {
    return;
  }
  const state = loadState(cwd);
  saveState(cwd, {
    ...state,
    lastReviewedDiffHash: {
      ...state.lastReviewedDiffHash,
      [conversationId]: { hash, updatedAt: nowIso() }
    }
  });
}

export function appendJobLog(logPath, line) {
  if (!logPath) {
    return;
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stamped = `[${nowIso()}] ${String(line).replace(/\r?\n$/, "")}\n`;
  fs.appendFileSync(logPath, stamped, "utf8");
}

export function readLogTail(logPath, maxLines = 40) {
  if (!logPath || !fs.existsSync(logPath)) {
    return [];
  }
  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(200, Number(maxLines) || 40)));
}

export function generateJobId(prefix = "codex") {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(3).toString("hex");
  return `${prefix}-${stamp}-${rand}`;
}
