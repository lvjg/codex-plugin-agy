import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    input: options.input
  });
}

export function formatCommandFailure(result, command = "command") {
  if (result.error) {
    return `${command} failed: ${result.error.message}`;
  }
  const stderr = String(result.stderr ?? "").trim();
  const stdout = String(result.stdout ?? "").trim();
  const detail = stderr || stdout || `exit code ${result.status ?? "unknown"}`;
  return `${command} exited with status ${result.status ?? "unknown"}: ${detail}`;
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(formatCommandFailure(result, command));
  }
  return result;
}

export function binaryAvailable(command, args = ["--version"], options = {}) {
  const result = runCommand(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    timeout: options.timeout ?? 10_000
  });

  if (result.error) {
    return {
      available: false,
      detail: result.error.code === "ENOENT" ? `binary not found: ${command}` : result.error.message
    };
  }

  if (result.status !== 0) {
    return {
      available: false,
      detail: formatCommandFailure(result, command)
    };
  }

  const output = String(result.stdout || result.stderr || "").trim();
  return {
    available: true,
    detail: output.split(/\r?\n/, 1)[0] || "ok"
  };
}

export function terminateProcessTree(pid, options = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }

  const signal = options.signal ?? "SIGTERM";
  if (process.platform === "win32") {
    const res = runCommand("taskkill", ["/PID", String(numericPid), "/T", "/F"], { timeout: 5_000 });
    return res.status === 0;
  }

  let signaled = false;
  try {
    process.kill(-numericPid, signal);
    signaled = true;
  } catch {
    // Fall back to direct PID kill when process is not a group leader.
  }

  if (!signaled) {
    try {
      process.kill(numericPid, signal);
      signaled = true;
    } catch {
      return false;
    }
  }
  return signaled;
}
