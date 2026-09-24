/**
 * A deliberately non-conformant ARI harness, used to prove that the conformance
 * suite actually detects violations.
 *
 * It does **not** use `AriHarness`, because that helper makes most of these
 * violations impossible by construction — which is the point. This file speaks
 * NDJSON by hand so it can break the rules on purpose.
 *
 *   node packages/conformance/test/broken-harness.ts --violate=<name>
 *
 * Violations:
 *   gap              skip a seq, leaving a hole in the stream
 *   double-settle    emit two turn/completed for one turn/started
 *   gated            emit reasoning/delta while declaring reasoning:false
 *   no-messageids    turn/started without messageIds
 *   late-receipt     emit the turn's events before the prompt response
 *   never-idle       never reach session/status idle
 *   stdout-noise     write a non-JSON line to stdout
 *   oversized        emit a single frame above 1 MiB
 *   bad-error-order  turn/completed{error} with no session/error
 */

import { ALL_CAPABILITIES, NO_CAPABILITIES, type AgentCapabilities } from "../../ari/src/index.ts";

const violate = (process.argv.find((arg) => arg.startsWith("--violate=")) ?? "--violate=").slice(
  "--violate=".length,
);

// Declare reasoning:false so that `gated` is a real violation.
const capabilities: AgentCapabilities = {
  ...ALL_CAPABILITIES,
  reasoning: violate === "gated" ? false : ALL_CAPABILITIES.reasoning,
};
void NO_CAPABILITIES;

const sessionId = "s_broken";
let seq = 1;
let turn = 1;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function event(payload: Record<string, unknown>): void {
  write({ jsonrpc: "2.0", method: "event", params: { sessionId, seq: seq++, ...payload } });
}

function status(value: "running" | "idle"): void {
  event({ type: "session/status", status: value });
}

function emitTurn(messageId: string): void {
  status("running");

  event({
    type: "turn/started",
    turn,
    ...(violate === "no-messageids" ? {} : { messageIds: [messageId] }),
  });

  if (violate === "gap") seq += 1; // leave a hole

  if (violate === "gated") {
    event({ type: "reasoning/delta", turn, text: "this capability is declared false" });
  }

  if (violate === "oversized") {
    event({ type: "tool/completed", callId: "t_1", status: "success", output: "x".repeat(1_100_000) });
  }

  event({ type: "message/delta", turn, text: "hello" });

  if (violate === "bad-error-order") {
    event({ type: "turn/completed", turn, stopReason: "error" });
  } else {
    event({ type: "turn/completed", turn, stopReason: "end_turn" });
  }

  if (violate === "double-settle") {
    event({ type: "turn/completed", turn, stopReason: "end_turn" });
  }

  if (violate !== "never-idle") status("idle");

  if (violate === "stdout-noise") {
    // A log line on stdout violates SPEC §4.1.
    process.stdout.write("just a log line, not a frame\n");
  }

  turn += 1;
}

function handle(message: Record<string, unknown>): void {
  const id = message["id"];
  const method = message["method"];

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "BrokenHarness", version: "1.0.0" },
        agentCapabilities: capabilities,
      },
    });
    return;
  }

  if (method === "session/new") {
    write({ jsonrpc: "2.0", id, result: { sessionId, nextSeq: seq } });
    return;
  }

  if (method === "session/prompt") {
    const messageId = `m_${turn}`;
    if (violate === "late-receipt") {
      emitTurn(messageId);
      write({ jsonrpc: "2.0", id, result: { messageId } });
      return;
    }
    write({ jsonrpc: "2.0", id, result: { messageId } });
    emitTurn(messageId);
    return;
  }

  if (method === "session/cancel") {
    write({ jsonrpc: "2.0", id, result: { droppedMessageIds: [] } });
    return;
  }

  if (method === "shutdown") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${String(method)}` } });
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  let newlineAt = buffered.indexOf("\n");
  while (newlineAt >= 0) {
    const line = buffered.slice(0, newlineAt);
    buffered = buffered.slice(newlineAt + 1);
    if (line.trim() !== "") handle(JSON.parse(line) as Record<string, unknown>);
    newlineAt = buffered.indexOf("\n");
  }
});
