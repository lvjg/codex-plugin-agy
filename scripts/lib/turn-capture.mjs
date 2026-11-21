function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

export function extractThreadId(message) {
  return message?.params?.threadId ?? message?.params?.thread?.id ?? null;
}

export function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

export function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges ?? []) {
    for (const change of fileChange.changes ?? []) {
      if (change?.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }
  return [];
}

function mergeReasoningSections(existing, next) {
  const merged = [...existing];
  for (const s of next) {
    const norm = s.replace(/\s+/g, " ").trim();
    if (norm && !merged.includes(norm)) {
      merged.push(norm);
    }
  }
  return merged;
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

export function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }
  const isNew = !state.threadIds.has(threadId);
  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
  if (isNew && typeof state.onThreadRegistered === "function") {
    state.onThreadRegistered(threadId);
  }
}

function emitProgress(state, message, phase = null) {
  if (!message) {
    return;
  }
  if (phase) {
    state.phase = phase;
  }
  state.lastEvent = message;
  state.onProgress?.({ message, phase: state.phase });
}

function describeStartedItem(state, item) {
  switch (item?.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${shorten(item.review, 72)}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${(item.changes ?? []).length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((id) => labelForThread(state, id) ?? id);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item?.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      return {
        message: `Command ${item.status ?? "completed"}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status ?? "completed"}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status ?? "completed"}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status ?? "completed"}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((id) => labelForThread(state, id) ?? id);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status ?? "completed"}.`
          : `Collaboration tool ${item.tool} ${item.status ?? "completed"}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

export function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId && turn.id) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: options.status ?? "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state, "Turn completion inferred after main final answer and subagent drain.", "finalizing");
  }

  state.resolveCompletion(state);
}

export function failTurn(state, error) {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  state.completed = true;
  state.error = error instanceof Error ? { message: error.message } : error;
  state.finalTurn = { id: state.turnId ?? "failed-turn", status: "failed" };
  emitProgress(state, `Failed: ${error instanceof Error ? error.message : String(error)}`, "failed");
  state.resolveCompletion(state);
}

export function cancelTurn(state, reason = "Interrupted by caller.") {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  state.completed = true;
  state.finalTurn = { id: state.turnId ?? "cancelled-turn", status: "interrupted" };
  emitProgress(state, reason, "cancelled");
  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }
  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, state.inferredCompletionDelayMs);
  state.completionTimer.unref?.();
}

export function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    phase: "starting",
    lastEvent: "Initializing turn.",
    completion,
    resolveCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    inferredCompletionDelayMs: options.inferredCompletionDelayMs ?? 250,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null,
    onThreadRegistered: options.onThreadRegistered ?? null
  };
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (!item || typeof item !== "object") {
    return;
  }

  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId || threadId === state.rootThreadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
    return;
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      threadId,
      text: item.text ?? ""
    });
    if (item.text && (!threadId || threadId === state.threadId || threadId === state.rootThreadId)) {
      state.lastAgentMessage = item.text;
      if (lifecycle === "completed" && item.phase === "final_answer") {
        state.finalAnswerSeen = true;
        scheduleInferredCompletion(state);
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const sections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, sections);
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

export function applyTurnNotification(state, message) {
  if (!message?.method || state.completed) {
    return;
  }

  const msgThreadId = extractThreadId(message);

  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params?.thread?.id, {
        threadName: message.params?.thread?.name,
        agentNickname: message.params?.thread?.agentNickname,
        agentRole: message.params?.thread?.agentRole
      });
      break;

    case "thread/name/updated":
      registerThread(state, message.params?.threadId, {
        threadName: message.params?.threadName ?? null
      });
      break;

    case "turn/started":
      registerThread(state, msgThreadId);
      if (msgThreadId && message.params?.turn?.id) {
        state.threadTurnIds.set(msgThreadId, message.params.turn.id);
      }
      if (msgThreadId && msgThreadId !== state.threadId && msgThreadId !== state.rootThreadId) {
        state.activeSubagentTurns.add(msgThreadId);
      } else if (message.params?.turn?.id && !state.turnId) {
        state.turnId = message.params.turn.id;
      }
      emitProgress(state, `Turn started (${message.params?.turn?.id ?? "unknown"}).`, "starting");
      break;

    case "item/started": {
      recordItem(state, message.params?.item, "started", msgThreadId);
      const update = describeStartedItem(state, message.params?.item);
      if (update) {
        emitProgress(state, update.message, update.phase);
      }
      break;
    }

    case "item/completed": {
      recordItem(state, message.params?.item, "completed", msgThreadId);
      const update = describeCompletedItem(state, message.params?.item);
      if (update) {
        emitProgress(state, update.message, update.phase);
      }
      break;
    }

    case "error":
      state.error = message.params?.error ?? { message: "Unknown Codex app-server error." };
      emitProgress(state, `Codex error: ${state.error.message ?? JSON.stringify(state.error)}`, "failed");
      break;

    case "turn/completed":
      if (msgThreadId && msgThreadId !== state.threadId && msgThreadId !== state.rootThreadId) {
        state.activeSubagentTurns.delete(msgThreadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state,
        `Turn ${message.params?.turn?.status ?? "completed"}.`,
        message.params?.turn?.status === "completed" ? "finalizing" : "failed"
      );
      completeTurn(state, message.params?.turn ?? { id: state.turnId ?? "turn", status: "completed" });
      break;

    default:
      break;
  }
}
