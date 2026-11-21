import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_INLINE_DIFF_BYTES = 200 * 1024;
const MAX_FINGERPRINT_UNTRACKED_BYTES = 256 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      return false;
    }
  }
  return true;
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error(`Not inside a Git repository: ${cwd}`);
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return ensureGitRepository(cwd);
}

export function isLinkedWorktree(cwd) {
  const gitDirRes = git(cwd, ["rev-parse", "--git-dir"]);
  const commonDirRes = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (gitDirRes.status !== 0 || commonDirRes.status !== 0) {
    return false;
  }
  const gitDir = path.resolve(cwd, gitDirRes.stdout.trim());
  const commonDir = path.resolve(cwd, commonDirRes.stdout.trim());
  return gitDir !== commonDir;
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect default branch. Specify `baseRef` or use `scope: \"working-tree\"`.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.baseRef ?? options.base ?? null;
  const state = getWorkingTreeState(cwd);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (requestedScope !== "auto") {
    throw new Error(`Unsupported review scope: ${requestedScope}. Use auto, working-tree, or branch.`);
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

export function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }
  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }
  return null;
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const branch = getCurrentBranch(repoRoot);
  const parts = [`Repository: ${repoRoot}`, `Branch: ${branch}`, `Review target: ${target.label}`];

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    const status = gitChecked(repoRoot, ["status", "--short"]).stdout.trim();
    parts.push("", "Working tree status:", status || "(clean)");

    const stagedRes = git(repoRoot, ["diff", "--cached"], { maxBuffer: MAX_INLINE_DIFF_BYTES + 4096 });
    const unstagedRes = git(repoRoot, ["diff"], { maxBuffer: MAX_INLINE_DIFF_BYTES + 4096 });
    const stagedOk = !stagedRes.error && stagedRes.status === 0;
    const unstagedOk = !unstagedRes.error && unstagedRes.status === 0;
    const combinedDiff = stagedOk && unstagedOk ? [stagedRes.stdout ?? "", unstagedRes.stdout ?? ""].filter(Boolean).join("\n") : "";

    if (stagedOk && unstagedOk && Buffer.byteLength(combinedDiff, "utf8") <= MAX_INLINE_DIFF_BYTES) {
      if (combinedDiff.trim()) {
        parts.push("", "Diff:", combinedDiff.trim());
      }
    } else {
      const hasHead = git(repoRoot, ["rev-parse", "--verify", "HEAD"]).status === 0;
      const stat = hasHead
        ? (git(repoRoot, ["diff", "--stat", "HEAD"]).stdout ?? "").trim()
        : [
            (git(repoRoot, ["diff", "--cached", "--stat"]).stdout ?? "").trim(),
            (git(repoRoot, ["diff", "--stat"]).stdout ?? "").trim()
          ]
            .filter(Boolean)
            .join("\n");
      parts.push(
        "",
        "Diff exceeds inline limit; stat summary:",
        stat || "(summary unavailable)",
        "Inspect exact files directly in the repository."
      );
    }

    if (state.untracked.length > 0) {
      parts.push("", "Untracked files:");
      for (const rel of state.untracked.slice(0, 15)) {
        const abs = path.join(repoRoot, rel);
        try {
          const buf = fs.readFileSync(abs);
          if (buf.length <= MAX_UNTRACKED_BYTES && isProbablyText(buf)) {
            parts.push(`--- ${rel} ---`, buf.toString("utf8"));
          } else {
            parts.push(`- ${rel} (${buf.length} bytes, omitted)`);
          }
        } catch {
          parts.push(`- ${rel} (unreadable)`);
        }
      }
    }
    return parts.join("\n");
  }

  const mergeBase = gitChecked(repoRoot, ["merge-base", "HEAD", target.baseRef]).stdout.trim();
  const range = `${mergeBase}..HEAD`;
  const logSummary = gitChecked(repoRoot, ["log", "--oneline", range]).stdout.trim();
  const stat = gitChecked(repoRoot, ["diff", "--stat", range]).stdout.trim();
  parts.push("", `Commits (${range}):`, logSummary || "(none)", "", "Diff stat:", stat || "(empty)");

  const diffRes = git(repoRoot, ["diff", range], { maxBuffer: MAX_INLINE_DIFF_BYTES + 4096 });
  if (!diffRes.error && diffRes.status === 0 && Buffer.byteLength(diffRes.stdout, "utf8") <= MAX_INLINE_DIFF_BYTES) {
    if (diffRes.stdout.trim()) {
      parts.push("", "Diff:", diffRes.stdout.trim());
    }
  } else {
    parts.push("", "Full diff omitted due to size; inspect the changed files directly in the repository.");
  }

  return parts.join("\n");
}

/**
 * Computes a deterministic content fingerprint of the working tree
 * (staged + unstaged diffs + untracked file names/contents).
 * Returns null if the repository has no working-tree changes.
 */
export function computeWorkingTreeFingerprint(cwd) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(repoRoot);
  if (!state.isDirty) {
    return null;
  }

  const hasher = createHash("sha256");

  // Handle repositories with or without an initial commit.
  const hasHead = git(repoRoot, ["rev-parse", "--verify", "HEAD"]).status === 0;
  if (hasHead) {
    const diffHead = git(repoRoot, ["diff", "HEAD"], { maxBuffer: 32 * 1024 * 1024 });
    hasher.update("DIFF_HEAD:\n");
    hasher.update(diffHead.stdout ?? "");
  } else {
    const staged = git(repoRoot, ["diff", "--cached"], { maxBuffer: 32 * 1024 * 1024 });
    const unstaged = git(repoRoot, ["diff"], { maxBuffer: 32 * 1024 * 1024 });
    hasher.update("DIFF_NO_HEAD:\n");
    hasher.update(staged.stdout ?? "");
    hasher.update(unstaged.stdout ?? "");
  }

  hasher.update("\nUNTRACKED:\n");
  for (const rel of [...state.untracked].sort()) {
    hasher.update(`${rel}\0`);
    const abs = path.join(repoRoot, rel);
    try {
      const stat = fs.statSync(abs);
      hasher.update(`${stat.size}:${stat.mtimeMs}\0`);
      if (stat.isFile() && stat.size <= MAX_FINGERPRINT_UNTRACKED_BYTES) {
        hasher.update(fs.readFileSync(abs));
      }
    } catch {
      hasher.update("unreadable\0");
    }
    hasher.update("\n");
  }

  return hasher.digest("hex");
}
