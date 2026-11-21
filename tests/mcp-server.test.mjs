import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCommandChecked } from "../scripts/lib/process.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, "..");
const MCP_SERVER = path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs");
const FAKE_CODEX = path.join(TEST_DIR, "fake-codex.mjs");

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-mcp-"));
  runCommandChecked("git", ["init", "-b", "main"], { cwd: dir });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  runCommandChecked("git", ["config", "user.name", "Test User"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "index.js"), "console.log('hi');\n", "utf8");
  runCommandChecked("git", ["add", "."], { cwd: dir });
  runCommandChecked("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

test("stdio MCP server handles initialize, tools/list, tools/call, and clean EOF shutdown", async () => {
  const repo = createTempRepo();
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agy-mcp-data-"));

  const child = spawn(process.execPath, [MCP_SERVER], {
    env: {
      ...process.env,
      PLUGIN_ROOT,
      PLUGIN_DATA: pluginData,
      CODEX_BIN: FAKE_CODEX
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
      nl = buf.indexOf("\n");
    }
  });

  let nextId = 1;
  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "test", version: "1.0" } });
    assert.equal(init.result.serverInfo.name, "codex-bridge-runtime");

    const listed = await rpc("tools/list");
    const toolNames = listed.result.tools.map((t) => t.name);
    assert.equal(toolNames.length, 11);
    assert.ok(toolNames.includes("codex_review"));
    assert.ok(toolNames.includes("codex_run"));
    assert.ok(toolNames.includes("codex_steer"));

    const setup = await rpc("tools/call", { name: "codex_setup", arguments: { cwd: repo } });
    assert.equal(setup.result.isError, false);
    assert.equal(setup.result.structuredContent.available, true);
    assert.equal(setup.result.structuredContent.authenticated, true);

    const runRes = await rpc("tools/call", {
      name: "codex_run",
      arguments: { cwd: repo, prompt: "verify mcp run", conversationId: "conv-mcp" }
    });
    assert.equal(runRes.result.isError, false);
    assert.equal(runRes.result.structuredContent.status, "completed");

    const statusRes = await rpc("tools/call", {
      name: "codex_status",
      arguments: { cwd: repo, jobId: runRes.result.structuredContent.jobId, includeRawLogTailLines: 10 }
    });
    assert.equal(statusRes.result.isError, false);
    assert.equal(statusRes.result.structuredContent.jobId, runRes.result.structuredContent.jobId);
    assert.ok(statusRes.result.structuredContent.logTail.length > 0);

    // Failed codex_run should report MCP isError: true while retaining structured payload
    const failedRun = await rpc("tools/call", {
      name: "codex_run",
      arguments: { cwd: repo, prompt: "[CRASH] fail mcp run", conversationId: "conv-mcp" }
    });
    assert.equal(failedRun.result.isError, true);
    assert.equal(failedRun.result.structuredContent.status, "failed");
    assert.ok(failedRun.result.structuredContent.jobId);

    // Close stdin and verify clean exit
    const exitPromise = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    child.stdin.end();
    const exitCode = await exitPromise;
    assert.equal(exitCode, 0);
  } finally {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});
