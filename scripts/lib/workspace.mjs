import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";

export function canonicalizePath(targetPath) {
  const resolved = path.resolve(targetPath || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  const startDir = canonicalizePath(cwd);
  const gitTop = runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDir,
    timeout: 5_000
  });
  if (!gitTop.error && gitTop.status === 0 && gitTop.stdout.trim()) {
    return canonicalizePath(gitTop.stdout.trim());
  }
  return startDir;
}
