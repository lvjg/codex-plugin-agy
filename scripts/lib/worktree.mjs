import fs from "node:fs";
import path from "node:path";

import { ensureGitRepository, isLinkedWorktree } from "./git.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";
import { resolveWorktreesDir } from "./state-store.mjs";

export function createIsolatedWorktree(cwd, jobId) {
  const repoRoot = ensureGitRepository(cwd);
  if (isLinkedWorktree(repoRoot)) {
    throw new Error(
      `Refusing to create a nested git worktree inside an already isolated linked worktree (${repoRoot}). Pass \`worktree: "none"\` instead.`
    );
  }

  const safeId = String(jobId).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const baseDir = resolveWorktreesDir(repoRoot);
  fs.mkdirSync(baseDir, { recursive: true });

  const worktreePath = path.join(baseDir, safeId);
  const branchName = `codex-bridge/${safeId}`;

  runCommandChecked("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
    cwd: repoRoot
  });

  return {
    repoRoot,
    worktreePath,
    branchName
  };
}

export function removeIsolatedWorktree(repoRoot, worktreePath, branchName = null) {
  if (!worktreePath) {
    return { removed: false, detail: "no worktree path recorded" };
  }

  const root = ensureGitRepository(repoRoot);
  const removeRes = runCommand("git", ["worktree", "remove", "--force", worktreePath], { cwd: root });
  if (removeRes.status !== 0 && fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    runCommand("git", ["worktree", "prune"], { cwd: root });
  }

  if (branchName && branchName.startsWith("codex-bridge/")) {
    runCommand("git", ["branch", "-D", branchName], { cwd: root });
  }

  return {
    removed: true,
    detail: `Removed worktree ${worktreePath}`
  };
}
