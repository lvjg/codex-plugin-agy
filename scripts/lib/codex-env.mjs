import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { binaryAvailable } from "./process.mjs";

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function collectCandidatePaths() {
  const home = os.homedir();
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = [];

  if (process.env.CODEX_BIN?.trim()) {
    candidates.push(process.env.CODEX_BIN.trim());
  }

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    candidates.push(path.join(dir, exe));
    if (process.platform === "win32") {
      candidates.push(path.join(dir, "codex.cmd"));
    }
  }

  const commonDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/Applications/Codex.app/Contents/Resources"
  ];

  for (const dir of commonDirs) {
    candidates.push(path.join(dir, exe));
  }

  // Probe latest nvm node version if present.
  const nvmDir = path.join(home, ".nvm", "versions", "node");
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const ver of versions.slice(0, 5)) {
        candidates.push(path.join(nvmDir, ver, "bin", exe));
      }
    } catch {
      // Ignore unreadable nvm directory.
    }
  }

  return [...new Set(candidates)];
}

export function resolveCodexBinary(overridePath = null) {
  if (overridePath?.trim()) {
    const explicit = path.resolve(overridePath.trim());
    return isExecutableFile(explicit) ? explicit : overridePath.trim();
  }

  for (const candidate of collectCandidatePaths()) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function getCodexAvailability(cwd = process.cwd(), options = {}) {
  const binaryPath = resolveCodexBinary(options.codexBin ?? null);
  if (!binaryPath) {
    return {
      available: false,
      binaryPath: null,
      version: null,
      detail: "Codex CLI binary not found in CODEX_BIN, PATH, or common install locations. Install with `npm install -g @openai/codex` or set CODEX_BIN."
    };
  }

  const versionStatus = binaryAvailable(binaryPath, ["--version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    return {
      available: false,
      binaryPath,
      version: null,
      detail: versionStatus.detail
    };
  }

  const appServerStatus = binaryAvailable(binaryPath, ["app-server", "--help"], { cwd, env: options.env });
  if (!appServerStatus.available) {
    return {
      available: false,
      binaryPath,
      version: versionStatus.detail,
      detail: `${versionStatus.detail}; \`codex app-server\` is unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    binaryPath,
    version: versionStatus.detail,
    detail: versionStatus.detail
  };
}

export function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const config = configResponse?.config;
  const providerId = typeof config?.model_provider === "string" && config.model_provider.trim()
    ? config.model_provider.trim()
    : null;
  const providerLabel = BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId ?? "The active provider";

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return {
      loggedIn: true,
      authMethod: "chatgpt",
      provider: providerId,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active"
    };
  }

  if (account?.type === "apiKey") {
    return {
      loggedIn: true,
      authMethod: "apiKey",
      provider: providerId,
      detail: "API key configured"
    };
  }

  if (requiresOpenaiAuth === false) {
    return {
      loggedIn: true,
      authMethod: "provider",
      provider: providerId,
      detail: `${providerLabel} is configured without OpenAI login`
    };
  }

  return {
    loggedIn: false,
    authMethod: null,
    provider: providerId,
    detail: `${providerLabel} requires authentication; run \`codex login\`.`
  };
}

export async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", { includeLayers: false, cwd });
    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return {
      loggedIn: false,
      authMethod: null,
      provider: null,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
