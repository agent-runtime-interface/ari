/**
 * fake-dsh — a DSH SDK wire-protocol test double.
 *
 * This file deliberately does **not** use any ARI library: it is the other end
 * of the adapter, speaking the DeepSeek Harness SDK protocol exactly as the
 * upstream wire defines it (three requests, four notifications, newline-
 * delimited JSON-RPC 2.0). It exists so the adapter can be exercised — and
 * judged by the conformance suite — without a DeepSeek API key, the same way
 * `mock-harness` serves the conformance suite directly.
 *
 * Faithful wire behaviours worth keeping exact:
 *  - `session/prompt` for an idle session appends `turn/start` (+ status,
 *    + user/message) **before** the response is written — the upstream server
 *    runs `followup()` synchronously inside the handler. This is the ordering
 *    the adapter's notification gate exists for.
 *  - A prompt arriving mid-turn is queued and answered immediately; its turn
 *    starts only after the current turn ends.
 *  - Session event seqs are per-session and **0-based** (DSH's own space,
 *    which the adapter renumbers away), and include log-only events.
 *
 * Behaviour is keyword-driven on the prompt text (same spirit as
 * `mock-harness`):
 *
 *   echo <text>     plain reply (default for anything unknown)
 *   reasoning <t>   reasoning-chunks + text-chunks in the settled stream
 *   tool <cmd>      tool/call → tool/result → reply
 *   toolerror       tool/result with isError + failure facts
 *   bigoutput       tool result with a 300 KiB text payload
 *   usage           assistant/message with TokenUsage
 *   subagent        subagent.started / subagent.finished notifications
 *   compact         compaction/start → summary → end (auto trigger)
 *   compact-manual  compaction lifecycle with sourceCommandId (manual trigger)
 *   foreign         also emits a session.event for a session never created
 *   slow [ms]       hold the turn open (default 10000 ms)
 *   fail            turn ends with reason error (LlmFailure embedded)
 *   blocked         turn ends with reason blocked
 *   maxtokens       turn ends with reason max-tokens
 *
 * Usage: node packages/adapter-dsh/test/fake-dsh.ts
 */

interface FakeSession {
  /** DSH seq of the last appended session event (0-based space). */
  seq: number;
  /** DSH turn number of the current/last turn. */
  turn: number;
  open: boolean;
  queue: string[];
}

const sessions = new Map<string, FakeSession>();

function sessionOf(sessionId: string): FakeSession {
  let session = sessions.get(sessionId);
  if (session === undefined) {
    session = { seq: -1, turn: 0, open: false, queue: [] };
    sessions.set(sessionId, session);
  }
  return session;
}

function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: unknown, result: unknown): void {
  writeFrame({ jsonrpc: "2.0", id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  writeFrame({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  writeFrame({ jsonrpc: "2.0", method, params });
}

function emitEvent(sessionId: string, type: string, data: Record<string, unknown>): void {
  const session = sessionOf(sessionId);
  session.seq += 1;
  notify("session.event", {
    sessionId,
    event: { type, seq: session.seq, time: Date.now(), data },
  });
}

function log(message: string): void {
  process.stderr.write(`[fake-dsh] ${message}\n`);
}

function textOf(contentBlocks: unknown): string {
  if (!Array.isArray(contentBlocks)) return "";
  const parts: string[] = [];
  for (const block of contentBlocks) {
    if (typeof block === "object" && block !== null) {
      const record = block as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
    }
  }
  return parts.join("\n");
}

// ── the agent loop, faked ────────────────────────────────────────────────

function startTurn(sessionId: string, text: string): void {
  const session = sessionOf(sessionId);
  session.turn += 1;
  session.open = true;
  emitEvent(sessionId, "turn/start", { turn: session.turn });
  notify("session.status", { sessionId, status: "running" });
  emitEvent(sessionId, "user/message", {
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function endTurn(sessionId: string, reason: Record<string, unknown>): void {
  const session = sessionOf(sessionId);
  emitEvent(sessionId, "turn/end", { turn: session.turn, reason });
  notify("session.status", { sessionId, status: "idle" });
  session.open = false;
}

function emitAssistant(
  sessionId: string,
  reply: string,
  extra?: { reasoning?: string[]; usage?: Record<string, number> },
): void {
  const session = sessionOf(sessionId);
  const stream: unknown[] = [];
  if (extra?.reasoning !== undefined) {
    stream.push({ type: "reasoning-chunks", time0: 0, index: 0, dt: [1], texts: extra.reasoning });
  }
  stream.push({ type: "text-chunks", time0: 1, index: 0, dt: [1], texts: [reply] });
  emitEvent(sessionId, "assistant/message", {
    turn: session.turn,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text: reply }] },
    stream,
    ...(extra?.usage !== undefined ? { usage: extra.usage } : {}),
  });
}

function emitToolCall(sessionId: string, callId: string, args: Record<string, unknown>): void {
  const session = sessionOf(sessionId);
  emitEvent(sessionId, "tool/call", {
    turn: session.turn,
    step: 1,
    callId,
    name: "shell",
    arguments: JSON.stringify(args),
  });
}

function emitToolResult(
  sessionId: string,
  callId: string,
  output: string,
  failure?: { isError: boolean; error: { name: string; code: string; reason?: string } },
): void {
  const session = sessionOf(sessionId);
  emitEvent(sessionId, "tool/result", {
    turn: session.turn,
    step: 1,
    message: {
      role: "tool",
      toolCallId: callId,
      isError: failure?.isError,
      content: [{ type: "text", text: output }],
    },
    ...(failure !== undefined ? { error: failure.error } : {}),
  });
}

const REASON_COMPLETED = { kind: "completed" };
const REASON_FAILED = { kind: "error", error: { message: "provider exploded", code: "PROVIDER" } };
const REASON_BLOCKED = { kind: "blocked" };
const REASON_MAX_TOKENS = { kind: "max-tokens" };

/** Run one turn body; returns the DSH turn-end reason it settles with. */
async function runTurnBody(sessionId: string, text: string): Promise<Record<string, unknown>> {
  const [command = "", ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  const session = sessionOf(sessionId);

  switch (command) {
    case "reasoning": {
      emitAssistant(sessionId, arg, { reasoning: [`considering: ${arg}`] });
      return REASON_COMPLETED;
    }
    case "tool": {
      emitToolCall(sessionId, "t_1", { command: arg || "ls" });
      emitToolResult(sessionId, "t_1", `ran: ${arg || "ls"}`);
      emitAssistant(sessionId, "tool finished");
      return REASON_COMPLETED;
    }
    case "toolerror": {
      emitToolCall(sessionId, "t_1", { command: "false" });
      emitToolResult(sessionId, "t_1", "tool failed", {
        isError: true,
        error: { name: "ShellError", code: "EXIT_1", reason: "exit code 1" },
      });
      emitAssistant(sessionId, "the tool failed");
      return REASON_COMPLETED;
    }
    case "bigoutput": {
      emitToolCall(sessionId, "t_1", { command: "yes" });
      emitToolResult(sessionId, "t_1", "x".repeat(300_000));
      emitAssistant(sessionId, "big output streamed");
      return REASON_COMPLETED;
    }
    case "usage": {
      emitAssistant(sessionId, "counted", {
        usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 100, reasoningTokens: 10 },
      });
      return REASON_COMPLETED;
    }
    case "subagent": {
      notify("subagent.started", { parentSessionId: sessionId, childSessionId: "dsh_child_1" });
      emitAssistant(sessionId, "delegated");
      notify("subagent.finished", {
        provider: "in-process",
        agentId: "dsh_child_1",
        parentSessionId: sessionId,
        childSessionId: "dsh_child_1",
        status: "ok",
        stopReason: "completed",
        lastAssistantMessage: [{ type: "text", text: "child done" }],
      });
      return REASON_COMPLETED;
    }
    case "compact":
    case "compact-manual": {
      const manual = command === "compact-manual";
      emitEvent(sessionId, "compaction/start", {
        compactionId: "c_1",
        ...(manual ? { sourceCommandId: "cmd_1" } : {}),
        turn: manual ? null : session.turn,
      });
      emitEvent(sessionId, "compaction/summary", {
        compactionId: "c_1",
        summary: [{ type: "text", text: "a summary of everything so far" }],
        shadowedRange: { start: 0, end: 5 },
        shadowedSeqs: [0, 1, 2, 3, 4, 5],
        shadowedTokenCount: 90_000,
        provider: "deepseek-official",
        model: "deepseek-official",
        usage: { inputTokens: 200, outputTokens: 80 },
      });
      emitEvent(sessionId, "compaction/end", { compactionId: "c_1", turn: session.turn });
      emitAssistant(sessionId, "compacted");
      return REASON_COMPLETED;
    }
    case "foreign": {
      // An event for a session the adapter never created: must be dropped.
      const stray = sessionOf("s_foreign_never_created");
      stray.seq += 1;
      notify("session.event", {
        sessionId: "s_foreign_never_created",
        event: { type: "user/message", seq: stray.seq, time: Date.now(), data: { content: [{ type: "text", text: "stray" }] } },
      });
      emitAssistant(sessionId, "foreign noise ignored");
      return REASON_COMPLETED;
    }
    case "slow": {
      const ms = Number(arg) || 10_000;
      await sleep(ms);
      emitAssistant(sessionId, "finally woke");
      return REASON_COMPLETED;
    }
    case "fail":
      return REASON_FAILED;
    case "blocked":
      return REASON_BLOCKED;
    case "maxtokens":
      return REASON_MAX_TOKENS;
    default:
      emitAssistant(sessionId, text === "" ? "(empty prompt)" : text);
      return REASON_COMPLETED;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drive one turn to settlement, then the queue behind it. */
async function driveTurn(sessionId: string, text: string): Promise<void> {
  const reason = await runTurnBody(sessionId, text);
  endTurn(sessionId, reason);
  const next = sessionOf(sessionId).queue.shift();
  if (next !== undefined) {
    startTurn(sessionId, next);
    await driveTurn(sessionId, next);
  }
}

// ── the DSH wire server ──────────────────────────────────────────────────

async function handleRequest(method: string, params: Record<string, unknown>, id: unknown): Promise<void> {
  switch (method) {
    case "initialize": {
      if (typeof params["cwd"] !== "string" || params["cwd"] === "") {
        respondError(id, -32602, "fake-dsh: initialize needs cwd");
        return;
      }
      log(`initialized: cwd=${String(params["cwd"])} provider=${String(params["provider"])} model=${String(params["model"])}`);
      respond(id, { serverInfo: { name: "fake-dsh-runtime", version: "0.0.1" } });
      return;
    }
    case "session/prompt": {
      const sessionId = String(params["sessionId"] ?? "");
      const text = textOf(params["contentBlocks"]);
      const session = sessionOf(sessionId);
      const messageId = `m_${sessionId}_${session.seq + 1}`;
      if (!session.open) {
        // Faithful ordering: the runtime appends turn/start inside the handler,
        // so the notifications hit the wire BEFORE the enqueue receipt.
        startTurn(sessionId, text);
        respond(id, { messageId });
        void driveTurn(sessionId, text);
      } else {
        session.queue.push(text);
        respond(id, { messageId });
      }
      return;
    }
    case "shutdown": {
      respond(id, {});
      log("shutdown; exiting");
      setTimeout(() => process.exit(0), 20);
      return;
    }
    default:
      respondError(id, -32601, `fake-dsh: unknown method ${method}`);
      return;
  }
}

void (async () => {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newlineAt = buffer.indexOf("\n");
    while (newlineAt >= 0) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      if (line.trim() === "") continue;
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (typeof frame["method"] === "string" && frame["id"] !== undefined) {
          const params = (frame["params"] ?? {}) as Record<string, unknown>;
          await handleRequest(frame["method"], params, frame["id"]);
        }
      } catch (error) {
        log(`unparseable frame: ${String(error)}`);
      }
      newlineAt = buffer.indexOf("\n");
    }
  }
  process.exit(0);
})();

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
