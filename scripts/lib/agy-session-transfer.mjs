import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process.mjs";

const MAX_SUMMARY_BYTES = 12 * 1024;
const MAX_LINE_EXCERPT = 500;

function getAllowedBrainRoots(extraRoots = []) {
  const home = os.homedir();
  const defaults = [
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain")
  ];
  return [...defaults, ...extraRoots].filter(Boolean);
}

export function validateTranscriptPath(transcriptPath, options = {}) {
  if (!transcriptPath || typeof transcriptPath !== "string") {
    throw new Error(
      "Missing `transcriptPath`. Pass the path injected by SessionStart or supply an explicit Antigravity transcript.jsonl path."
    );
  }

  const expanded = transcriptPath.startsWith("~/")
    ? path.join(os.homedir(), transcriptPath.slice(2))
    : path.resolve(transcriptPath);

  if (path.extname(expanded) !== ".jsonl") {
    throw new Error(`Transcript must be a .jsonl file: ${expanded}`);
  }

  let realSource;
  try {
    realSource = fs.realpathSync(expanded);
  } catch {
    throw new Error(`Transcript file not found: ${expanded}`);
  }

  const allowedRoots = getAllowedBrainRoots(options.allowedRoots ?? []);
  const withinAllowed = allowedRoots.some((root) => {
    try {
      const realRoot = fs.realpathSync(root);
      const rel = path.relative(realRoot, realSource);
      return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    } catch {
      return false;
    }
  });

  if (!withinAllowed) {
    throw new Error(`Transcript path is outside allowed Antigravity brain directories: ${realSource}`);
  }

  return realSource;
}

function truncateText(text, maxChars = MAX_LINE_EXCERPT) {
  const clean = String(text ?? "").trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, maxChars - 3)}...`;
}

export function extractAntigravityHandoff(cwd, transcriptPath, options = {}) {
  const validPath = validateTranscriptPath(transcriptPath, options);
  const raw = fs.readFileSync(validPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const userInputs = [];
  const plannerResponses = [];
  const errors = [];
  const touchedFiles = new Set();

  for (const line of lines) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    if (step.type === "USER_INPUT" && step.content) {
      userInputs.push(truncateText(step.content, 600));
    }

    if (step.type === "PLANNER_RESPONSE" && step.content) {
      plannerResponses.push(truncateText(step.content, 800));
    }

    if (step.status === "ERROR" && step.content) {
      errors.push(truncateText(step.content, 300));
    }

    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const args = tc?.args ?? tc?.arguments ?? {};
        for (const key of ["Path", "path", "file", "TargetFile"]) {
          if (typeof args[key] === "string" && args[key].trim()) {
            touchedFiles.add(args[key].trim());
          }
        }
      }
    }
  }

  const gitStatus = runCommand("git", ["status", "--short"], { cwd }).stdout?.trim() ?? "";
  const gitDiffStat = runCommand("git", ["diff", "--stat", "HEAD"], { cwd }).stdout?.trim() ?? "";

  const sections = [
    "# Antigravity Session Handoff",
    `Workspace: ${cwd}`,
    `Source transcript: ${validPath}`
  ];

  if (options.focus?.trim()) {
    sections.push("", "## Immediate Focus", options.focus.trim());
  }

  if (userInputs.length > 0) {
    sections.push("", "## User Goals & Requests");
    for (const req of userInputs.slice(-8)) {
      sections.push(`- ${req}`);
    }
  }

  if (touchedFiles.size > 0) {
    sections.push("", "## Referenced / Modified Files");
    for (const file of [...touchedFiles].slice(0, 30)) {
      sections.push(`- ${file}`);
    }
  }

  if (errors.length > 0) {
    sections.push("", "## Recent Errors Observed");
    for (const err of errors.slice(-5)) {
      sections.push(`- ${err}`);
    }
  }

  if (plannerResponses.length > 0) {
    sections.push("", "## Recent Assistant Findings (Last 3 Turns)");
    for (const resp of plannerResponses.slice(-3)) {
      sections.push(`---\n${resp}`);
    }
  }

  if (gitStatus || gitDiffStat) {
    sections.push("", "## Current Git State");
    if (gitStatus) {
      sections.push("```text\n" + gitStatus + "\n```");
    }
    if (gitDiffStat) {
      sections.push("```text\n" + gitDiffStat + "\n```");
    }
  }

  let summary = sections.join("\n");
  if (Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES) {
    summary = `${summary.slice(0, MAX_SUMMARY_BYTES - 80)}\n\n[Handoff truncated to 12KB budget]`;
  }

  const prompt = [
    "You are receiving a structured handoff from an active Antigravity session.",
    "Acknowledge the goal, current state, and key open items concisely. Do not edit files until the user follows up in this Codex thread.",
    "",
    summary
  ].join("\n");

  return {
    transcriptPath: validPath,
    summaryPreview: truncateText(summary, 500),
    prompt
  };
}
