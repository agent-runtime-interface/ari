/**
 * Adapter tests — the ZCode → ARI translator, end to end.
 *
 * Every protocol-level test drives the real adapter as a subprocess
 * (`node packages/adapter-zcode/src/main.ts`) with the ZCode-protocol fake
 * (`fake-zcode.ts`) behind it, using the reference `AriClient`. Cross-process
 * is deliberate: the interesting failures of a translator (framing, ordering,
 * attribution) only exist between processes (see the repository handoff, §7).
 *
 * Run: node --test packages/adapter-zcode/test/
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AriClient, AriError } from "../../ari/src/index.ts";
import type { AriEvent } from "../../ari/src/index.ts";
import {
  mapApprovalOptions,
  mapCompactionMarker,
  mapQuestionAnswerOut,
  mapQuestionSpecs,
  mapSubagentStatus,
  mapTurnEnd,
  mapUsage,
  permissionOptionIdFor,
} from "../src/translate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const ADAPTER = path.join(root, "packages/adapter-zcode/src/main.ts");
const FAKE = path.join(root, "packages/adapter-zcode/test/fake-zcode.ts");
const SHELL = path.join(root, "packages/shell/src/main.ts");

interface Started {
  client: AriClient;
  events: AriEvent[];
  stderrLines: string[];
  close(): void;
}

function startAdapter(extraArgs: readonly string[] = []): Started {
  const events: AriEvent[] = [];
  const stderrLines: string[] = [];
  const client = AriClient.spawn({
    command: "node",
    args: [ADAPTER, ...extraArgs, "--zcode", "node", FAKE],
    cwd: root,
    requestTimeoutMs: 8_000,
    onStderr: (line: string) => stderrLines.push(line),
  });
  client.onEvent((event) => events.push(event));
  return { client, events, stderrLines, close: () => client.close() };
}

async function waitFor(
  events: AriEvent[],
  predicate: (events: AriEvent[]) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(events)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}; saw [${events.map((event) => event.type).join(", ")}]`);
}

const ofType = (events: AriEvent[], type: string): AriEvent[] =>
  events.filter((event) => event.type === type);

interface StartedAndInitialized extends Started {
  sessionId: string;
}

/** Initialize and open one session — the shared preamble of most tests. */
async function startWithSession(extraArgs: readonly string[] = []): Promise<StartedAndInitialized> {
  const started = startAdapter(extraArgs);
  await started.client.initialize();
  const { sessionId } = await started.client.newSession();
  return { ...started, sessionId };
}

async function expectError(fn: () => Promise<unknown>, code: number, what: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    const actual = error instanceof AriError ? error.code : Number.NaN;
    assert.equal(actual, code, `${what}: expected ${code}, got ${String(actual)} (${String(error)})`);
  }
  assert.ok(threw, `${what}: expected error ${code}, but the call succeeded`);
}

function assertDenseSeq(events: AriEvent[], what: string): void {
  const seqs = events.map((event) => event.seq);
  for (let i = 0; i < seqs.length; i += 1) {
    assert.equal(seqs[i], i + 1, `${what}: seq must be dense from 1; got ${seqs.join(",")}`);
  }
}

/** The full assistant answer of a turn: the deltas stream in pieces. */
function streamedText(events: AriEvent[]): string {
  return ofType(events, "message/delta")
    .map((event) => (event as unknown as { text: string }).text)
    .join("");
}

// ── handshake and gating ────────────────────────────────────────────────

test("initialize declares exactly the capabilities the ZCode wire can deliver", async () => {
  const started = startAdapter();
  try {
    const result = await started.client.initialize();
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo.name, "zcode", "agentInfo names the real runtime");
    assert.deepEqual(result.agentCapabilities, {
      reasoning: true,
      question: true,
      approvalEditInput: false,
      usage: true,
      compactionEvents: true,
      replay: true,
      fileChanges: false,
      subagents: true,
      backgroundTasks: false,
      fork: true,
      sessionList: false,
    });
  } finally {
    started.close();
  }
});

test("a method before initialize is -32002, a duplicate initialize is -32006", async () => {
  const started = startAdapter();
  try {
    await expectError(() => started.client.rawRequest("session/new", {}), -32002, "session/new before initialize");
    await started.client.initialize();
    await expectError(
      () => started.client.rawRequest("initialize", { protocolVersion: 1 }),
      -32006,
      "second initialize",
    );
  } finally {
    started.close();
  }
});

test("an unsupported MAJOR is -32008 with supportedVersions, and initialize can retry", async () => {
  const started = startAdapter();
  try {
    let caught: AriError | undefined;
    try {
      await started.client.rawRequest("initialize", { protocolVersion: 99 });
    } catch (error) {
      if (error instanceof AriError) caught = error;
    }
    assert.ok(caught, "initialize with MAJOR 99 must fail");
    assert.equal(caught?.code, -32008);
    assert.deepEqual((caught?.data as { supportedVersions?: number[] }).supportedVersions, [1]);
    const retry = await started.client.initialize();
    assert.equal(retry.protocolVersion, 1);
  } finally {
    started.close();
  }
});

test("an unknown method is -32601", async () => {
  const started = await startWithSession();
  try {
    await expectError(
      () => started.client.rawRequest("conformance/not-a-method", {}),
      -32601,
      "unknown method",
    );
  } finally {
    started.close();
  }
});

test("methods and parameters the wire cannot support answer the ARI codes", async () => {
  const started = await startWithSession();
  try {
    const { sessionId, client } = started;
    await expectError(
      () =>
        client.respondApproval({
          sessionId,
          approvalId: "ap_x",
          decision: "allow_once",
          amendedInput: { command: "true" },
        }),
      -32003,
      "amendedInput gated",
    );
    await expectError(
      () => client.rawRequest("session/list", {}),
      -32003,
      "session/list gated (V4 lists through a topic, not a query)",
    );
    await expectError(
      () => client.respondApproval({ sessionId, approvalId: "ap_missing", decision: "deny" }),
      -32007,
      "unknown approval id",
    );
    await expectError(
      () => client.respondQuestion({ sessionId, questionId: "q_missing", answers: [] }),
      -32007,
      "unknown question id",
    );
    await expectError(() => client.prompt("s_does_not_exist", "hi"), -32001, "unknown session is not auto-created");
    await expectError(
      () => client.resumeSession({ sessionId, since: 100_000 }),
      -32602,
      "since beyond the watermark",
    );
  } finally {
    started.close();
  }
});

test("--minimal declares every capability false and suppresses gated events", async () => {
  const started = startAdapter(["--minimal"]);
  try {
    const { client, events, sessionId } = started;
    const handshake = await client.initialize();
    assert.deepEqual(
      Object.values(handshake.agentCapabilities).filter((on) => on),
      [],
      "minimal mode declares nothing",
    );
    const { sessionId: sid } = await client.newSession();
    void sessionId;
    await client.prompt(sid, "usage");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    assert.deepEqual(
      ofType(events, "usage/updated"),
      [],
      "a gated event must never surface while its capability is false",
    );
    assert.ok(ofType(events, "message/delta").length > 0, "required events still stream");
  } finally {
    started.close();
  }
});

// ── a full turn, and the paths around it ────────────────────────────────

test("a turn keeps every ordering invariant the shell relies on", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    const receipt = await client.prompt(sessionId, "hello adapter");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const types = events.map((event) => event.type);
    assert.equal(types[0], "turn/started", "the turn opens the stream");
    assert.ok(types.indexOf("message/delta") > 0, "the answer streams");
    assert.equal(types.at(-1), "session/status", "the stream closes on idle");
    assert.equal((events.at(-1) as unknown as { status: string }).status, "idle");

    const startedEvent = events[0] as unknown as { turn: number; messageIds: string[] };
    assert.equal(startedEvent.turn, 1, "ARI turns are adapter-assigned from 1");
    assert.ok(
      startedEvent.messageIds.includes(receipt.messageId),
      "turn/started must claim the receipt the shell holds despite the wire's notification-first ordering",
    );

    const completed = ofType(events, "turn/completed")[0] as unknown as { turn: number; stopReason: string };
    assert.equal(completed.stopReason, "end_turn");
    assert.deepEqual(ofType(events, "turn/completed").length, ofType(events, "turn/started").length);

    assertDenseSeq(events, "one full turn");
  } finally {
    started.close();
  }
});

test("a mid-turn prompt is queued and runs as its own turn", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "slow 1500");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/started"), "the first turn to start");

    // Arrives mid-turn: enqueued, never steered.
    const queued = await client.prompt(sessionId, "second message");
    await waitFor(events, (list) => ofType(list, "turn/completed").length >= 2, "both turns to settle");

    const startedEvents = ofType(events, "turn/started") as unknown as { turn: number; messageIds: string[] }[];
    assert.equal(startedEvents.length, 2, "the queued prompt started its own turn");
    assert.ok(startedEvents[1].messageIds.includes(queued.messageId), "the second turn claims its receipt");
    assert.deepEqual(
      ofType(events, "turn/completed").map((event) => (event as unknown as { turn: number }).turn),
      [1, 2],
      "turns are sequential, never steered",
    );
    assertDenseSeq(events, "queue then turn");
  } finally {
    started.close();
  }
});

test("a rejected sendText is an error for the prompt and the session stays usable", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    // Warm the subscription up: a prompt racing the subscribe window is
    // legitimately queued (SPEC §7.3), and a queued forward's failure is
    // out-of-band (SPEC §8-I5) — the direct path is what answers -32603.
    await client.prompt(sessionId, "warmup");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the warmup turn to settle");
    await expectError(() => client.prompt(sessionId, "failack"), -32603, "a guard-rejected sendText");
    await client.prompt(sessionId, "recovered");
    await waitFor(events, (list) => ofType(list, "turn/completed").length === 2, "the next turn to settle");
    assert.equal(ofType(events, "turn/completed").length, 2, "no dangling turn events from the failed forward");
  } finally {
    started.close();
  }
});

test("queue overflow is -32005 and nothing is silently dropped", async () => {
  const started = await startWithSession(["--queue-limit", "2"]);
  try {
    const { client, sessionId } = started;
    await client.prompt(sessionId, "slow 3000");
    await client.prompt(sessionId, "queued 1");
    await client.prompt(sessionId, "queued 2");
    await expectError(() => client.prompt(sessionId, "queued 3"), -32005, "the overflow prompt");
    await client.cancel(sessionId);
  } finally {
    started.close();
  }
});

test("session/cancel settles the turn as cancelled and reports the dropped queue", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "slow 8000");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/started"), "the turn to start");
    const queued = await client.prompt(sessionId, "doomed");
    const result = await client.cancel(sessionId);
    assert.deepEqual(result.droppedMessageIds, [queued.messageId], "the queued prompt is dropped");
    assert.equal(result.cancelledTurn, 1, "the in-flight turn is reported cancelled");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const completed = ofType(events, "turn/completed")[0] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "cancelled");
    assert.equal(
      (events.at(-1) as unknown as { status: string }).status,
      "idle",
      "no session may stick in running (SPEC §8-I6)",
    );
  } finally {
    started.close();
  }
});

// ── the projection vocabulary ───────────────────────────────────────────

test("tool calls translate with lifecycle, output deltas, and completion", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "tool ls -la");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const startedTool = ofType(events, "tool/started")[0] as unknown as { callId: string; name: string; input: unknown };
    assert.equal(startedTool.name, "Bash", "the tool name rides ARI's opaque name field");
    assert.deepEqual(startedTool.input, { inputText: "ls -la" });

    const running = ofType(events, "tool/updated").filter(
      (event) => (event as unknown as { status: string }).status === "running",
    );
    assert.ok(running.length >= 1, "the running state surfaces");

    const deltas = ofType(events, "tool/updated") as unknown as { callId: string; outputDelta?: string }[];
    assert.ok(
      deltas.some((event) => event.outputDelta === "ran: ls -la"),
      "output.text row deltas stream as tool/updated outputDelta",
    );

    const completedTool = ofType(events, "tool/completed")[0] as unknown as { callId: string; status: string; output: string };
    assert.equal(completedTool.status, "success");
    assert.equal(completedTool.output, "ran: ls -la");
    assert.equal(completedTool.callId, startedTool.callId, "the toolCallId is the end-to-end correlation key");
  } finally {
    started.close();
  }
});

test("failed and cancelled tools carry the failure facts", async () => {
  const failed = await startWithSession();
  try {
    const { client, events, sessionId } = failed;
    await client.prompt(sessionId, "toolfail");
    await waitFor(events, (list) => list.some((event) => event.type === "tool/completed"), "the tool to complete");
    const completed = ofType(events, "tool/completed")[0] as unknown as { status: string; output: string; meta?: unknown };
    assert.equal(completed.status, "error");
    assert.match(completed.output, /command not found/);
    assert.deepEqual((completed.meta as { message?: string }).message, "command not found");
  } finally {
    failed.close();
  }

  const cancelled = await startWithSession();
  try {
    const { client, events, sessionId } = cancelled;
    await client.prompt(sessionId, "toolcancel");
    await waitFor(events, (list) => list.some((event) => event.type === "tool/completed"), "the tool to complete");
    const completed = ofType(events, "tool/completed")[0] as unknown as { status: string; meta?: { cancelled?: boolean } };
    // ARI has no cancelled tool outcome: the machine must converge to completed.
    assert.equal(completed.status, "error");
    assert.equal(completed.meta?.cancelled, true);
  } finally {
    cancelled.close();
  }
});

test("reasoning and usage stream from their projection patches", async () => {
  const reasoning = await startWithSession();
  try {
    const { client, events, sessionId } = reasoning;
    await client.prompt(sessionId, "reasoning think hard");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const reasoningDeltas = ofType(events, "reasoning/delta") as unknown as { text: string }[];
    assert.equal(
      reasoningDeltas.map((delta) => delta.text).join(""),
      "considering: think hard",
      "the reasoning text streams in deltas",
    );
    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("reasoning/delta") < types.indexOf("message/delta"), "reasoning precedes the answer");
  } finally {
    reasoning.close();
  }

  const counted = await startWithSession();
  try {
    const { client, events, sessionId } = counted;
    await client.prompt(sessionId, "usage");
    await waitFor(events, (list) => list.some((event) => event.type === "usage/updated"), "usage");
    const usage = ofType(events, "usage/updated")[0] as unknown as {
      turn: number;
      usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
    };
    assert.equal(usage.usage.inputTokens, 1234);
    assert.equal(usage.usage.outputTokens, 56);
    assert.equal(usage.usage.cachedTokens, 100, "cacheReadTokens maps to cachedTokens");
    assert.equal(usage.turn, 1, "usage carries the open turn");
  } finally {
    counted.close();
  }
});

test("compaction markers become compaction/performed with the token facts", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "compact");
    await waitFor(events, (list) => list.some((event) => event.type === "compaction/performed"), "compaction");
    const compaction = ofType(events, "compaction/performed")[0] as unknown as {
      trigger: string;
      preTokens?: number;
      postTokens?: number;
    };
    assert.equal(compaction.trigger, "auto");
    assert.equal(compaction.preTokens, 100_000);
    assert.equal(compaction.postTokens, 20_000);
  } finally {
    started.close();
  }
});

test("subagent brackets carry the child session and the summary", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "subagent");
    await waitFor(events, (list) => list.some((event) => event.type === "subagent/finished"), "the subagent to finish");
    const startedSub = ofType(events, "subagent/started")[0] as unknown as {
      callId: string;
      name?: string;
      childSessionId?: string;
    };
    assert.equal(startedSub.name, "Explore");
    assert.equal(startedSub.childSessionId, "sess_child_0001");
    const finished = ofType(events, "subagent/finished")[0] as unknown as {
      callId: string;
      status: string;
      summary?: string;
    };
    assert.equal(finished.status, "success");
    assert.equal(finished.summary, "explored the repo");
    assert.equal(finished.callId, startedSub.callId);
  } finally {
    started.close();
  }
});

test("a large tool output streams through reassembled wire fragments", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "bigoutput");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const deltas = ofType(events, "tool/updated") as unknown as { outputDelta?: string }[];
    const streamed = deltas.reduce((total, event) => total + (event.outputDelta?.length ?? 0), 0);
    assert.ok(streamed >= 720_000, "the output streamed in deltas");
    const completed = ofType(events, "tool/completed")[0] as unknown as { status: string; output: string };
    assert.equal(completed.status, "success");
    assert.equal(completed.output.length, 720_000, "the settled row arrived through fragment reassembly");
  } finally {
    started.close();
  }
});

// ── human interaction over pendingInteractions ──────────────────────────

test("approvals map ARI decisions onto the offered option kinds", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "approve");
    await waitFor(events, (list) => list.some((event) => event.type === "approval/requested"), "the approval");
    const requested = ofType(events, "approval/requested")[0] as unknown as {
      approvalId: string;
      toolCallId?: string;
      toolName?: string;
      reason?: string;
      options?: { id: string; label: string }[];
    };
    assert.equal(requested.toolName, "Bash");
    assert.equal(requested.reason, "the command wants to run");
    assert.deepEqual(
      requested.options?.map((option) => option.id),
      ["allow_once", "allow_always", "deny"],
      "only ARI-representable option kinds are offered",
    );

    await client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "allow_once" });
    await waitFor(events, (list) => list.some((event) => event.type === "approval/resolved"), "the resolution");
    const resolved = ofType(events, "approval/resolved")[0] as unknown as { approvalId: string; decision: string };
    assert.equal(resolved.decision, "allow_once");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    assert.match(streamedText(events), /approved and ran/, "the runtime honored the approval");
  } finally {
    started.close();
  }
});

test("a repeated approval is idempotent, a conflicting one is -32007", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "approve");
    await waitFor(events, (list) => list.some((event) => event.type === "approval/requested"), "the approval");
    const requested = ofType(events, "approval/requested")[0] as unknown as { approvalId: string };
    await client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "allow_once" });
    // Same answer again: idempotent success (SPEC §10.3).
    await client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "allow_once" });
    // Conflicting answer: -32007.
    await expectError(
      () => client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "deny" }),
      -32007,
      "conflicting re-answer",
    );
    await client.cancel(sessionId);
  } finally {
    started.close();
  }
});

test("questions answer through the elicitation path, free text and options alike", async () => {
  const options = await startWithSession();
  try {
    const { client, events, sessionId } = options;
    await client.prompt(sessionId, "question");
    await waitFor(events, (list) => list.some((event) => event.type === "question/requested"), "the question");
    const requested = ofType(events, "question/requested")[0] as unknown as {
      questionId: string;
      questions: { id: string; question: string; options?: { id: string; label: string }[] }[];
    };
    assert.equal(requested.questions[0].question, "Which option do you want?");
    assert.deepEqual(requested.questions[0].options?.map((option) => option.id), ["A", "B"]);
    await client.respondQuestion({
      sessionId,
      questionId: requested.questionId,
      answers: [{ id: "0", values: ["A"] }],
    });
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const resolved = ofType(events, "question/resolved")[0] as unknown as { outcome: string };
    assert.equal(resolved.outcome, "answered");
    assert.match(streamedText(events), /you chose A/, "the answer reached the runtime as the option value");
  } finally {
    options.close();
  }

  const freeText = await startWithSession();
  try {
    const { client, events, sessionId } = freeText;
    await client.prompt(sessionId, "questiontext");
    await waitFor(events, (list) => list.some((event) => event.type === "question/requested"), "the question");
    const requested = ofType(events, "question/requested")[0] as unknown as { questionId: string };
    await client.respondQuestion({
      sessionId,
      questionId: requested.questionId,
      answers: [{ id: "0", values: ["hello there"] }],
    });
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    assert.match(streamedText(events), /you said hello there/, "free text rides answer.freeText");
  } finally {
    freeText.close();
  }
});

test("an interaction that vanishes resolves cancelled, and a late answer is -32007", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "vanishing");
    await waitFor(events, (list) => list.some((event) => event.type === "approval/resolved"), "the resolution");
    const resolved = ofType(events, "approval/resolved")[0] as unknown as { approvalId: string; decision: string };
    assert.equal(resolved.decision, "cancelled", "the runtime resolved it without the shell");
    await expectError(
      () => client.respondApproval({ sessionId, approvalId: resolved.approvalId, decision: "allow_once" }),
      -32007,
      "a late answer to a vanished interaction",
    );
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
  } finally {
    started.close();
  }
});

// ── errors, cancellation, and dirty branches ────────────────────────────

test("a retryable api error keeps the turn open (SPEC §8-I4)", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "retryerror");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const errors = ofType(events, "session/error") as unknown as { error: { retryable?: boolean; message: string } }[];
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.retryable, true, "the api retry surfaces as retryable");
    assert.match(errors[0].error.message, /attempt 1\/3/);
    const completed = ofType(events, "turn/completed")[0] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "end_turn", "the retry resolved and the turn still ended normally");
  } finally {
    started.close();
  }
});

test("a fatal error emits session/error first, then turn/completed{error}", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "fail");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const types = events.map((event) => event.type);
    const errorAt = types.indexOf("session/error");
    const completedAt = types.indexOf("turn/completed");
    assert.ok(errorAt >= 0, "session/error must be emitted");
    assert.ok(errorAt < completedAt, "the diagnostic must precede the settlement (SPEC §8-I3)");
    const diagnostic = events[errorAt] as unknown as { error: { message: string }; turn: number };
    assert.equal(diagnostic.error.message, "RATE: provider exploded", "the runtime's own message rides through");
    const completed = ofType(events, "turn/completed")[0] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "error");
  } finally {
    started.close();
  }
});

test("a removed branch converges its open brackets and settles the turn", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "removed");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const completed = ofType(events, "turn/completed")[0] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "end_turn", "the surviving branch finishes the turn");
    const orphanedTool = ofType(events, "tool/completed")[0] as unknown as { status: string; meta?: { removed?: boolean } };
    assert.equal(orphanedTool.status, "error", "the open tool cannot report success from a removed branch");
    assert.equal(orphanedTool.meta?.removed, true);
    assert.equal((events.at(-1) as unknown as { status: string }).status, "idle");
  } finally {
    started.close();
  }
});

test("a coalesced bracket still opens and settles exactly one turn", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "coalesced");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    assert.equal(ofType(events, "turn/started").length, 1);
    assert.equal(ofType(events, "turn/completed").length, 1);
    const completed = ofType(events, "turn/completed")[0] as unknown as { turn: number; stopReason: string };
    assert.equal(completed.turn, 1);
    assert.equal(completed.stopReason, "end_turn");
    assert.match(streamedText(events), /coalesced reply/, "the settled text row is delivered whole");
    assertDenseSeq(events, "coalesced turn");
  } finally {
    started.close();
  }
});

test("foreign sessions and legacy reverse requests never break the stream", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId, stderrLines, close } = started;
    void close;
    await client.prompt(sessionId, "foreign");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    assert.ok(
      events.every((event) => event.sessionId === sessionId),
      "no event may leak from a session the adapter never created",
    );
    assert.ok(
      !stderrLines.some((line) => line.includes("unexpected client response frame")),
      "the adapter must never answer the runtime's legacy reverse requests",
    );
  } finally {
    started.close();
  }
});

// ── replay, fork, and the reference shell ───────────────────────────────

test("session/resume replays the adapter ledger with a consistent cut", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "hello replay");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const total = events.length;

    const cut = await client.resumeSession({ sessionId, since: 3 });
    assert.equal(cut.replayedFrom, 3);
    assert.equal(cut.nextSeq, total + 1);
    assert.equal(cut.events.at(-1)?.seq, cut.nextSeq - 1);
    const seqs = cut.events.map((event) => event.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => 3 + i), "replay is dense from since");
    assert.ok(cut.snapshot, "a replay always carries a snapshot");
    assert.equal(cut.snapshot?.status, "idle");

    const full = await client.resumeSession({ sessionId });
    assert.equal(full.replayedFrom, 1, "without since, the replay starts at the beginning");
    assert.equal(full.snapshot?.nextTurn, 2);
  } finally {
    started.close();
  }
});

test("session/fork forks at a turn boundary and the child is promptable", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "hello parent");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the parent turn to settle");

    const forked = await client.forkSession(sessionId);
    assert.equal(forked.forkedFrom.sessionId, sessionId);
    assert.equal(forked.forkedFrom.turn, 1);
    assert.equal(forked.nextSeq, 1, "the child's seq space is fresh (SPEC §7.5)");
    assert.notEqual(forked.sessionId, sessionId);

    // The child's snapshot carries the copied conversation rows; they are
    // history and must not replay as new deltas.
    const receipt = await client.prompt(forked.sessionId, "hello child");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/started" && event.sessionId === forked.sessionId), "the child turn to start");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed" && event.sessionId === forked.sessionId), "the child turn to settle");
    const childEvents = events.filter((event) => event.sessionId === forked.sessionId);
    assert.equal(
      childEvents.filter((event) => event.type === "message/delta").length,
      2,
      "only the child's own answer streams, never its copied history",
    );
    assert.match(streamedText(childEvents), /hello child/);
    const childStarted = childEvents[0] as unknown as { messageIds: string[] };
    assert.ok(childStarted.messageIds.includes(receipt.messageId));
    assertDenseSeq(childEvents, "the adopted child");
  } finally {
    started.close();
  }
});

test("session/fork rejects turn boundaries the wire cannot target", async () => {
  const started = await startWithSession();
  try {
    const { client, sessionId } = started;
    await expectError(() => client.forkSession(sessionId, 0), -32602, "atTurn below the range");
    await expectError(() => client.forkSession(sessionId, 9), -32602, "atTurn beyond the range");
    await client.prompt(sessionId, "fail");
    await client.prompt(sessionId, "watcher");
    // Turn 1 failed with no assistant row: not a forkable boundary.
    await expectError(() => client.forkSession(sessionId, 1), -32602, "a boundaryless turn");
  } finally {
    started.close();
  }
});

test("the reference shell drives the adapter with no harness knowledge", async () => {
  const shell = spawn("node", [SHELL, "--policy", "allow", "--prompt", "hello shell", "--", "node", ADAPTER, "--zcode", "node", FAKE], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  shell.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve) => shell.on("close", (exitCode) => resolve(exitCode)));
  assert.equal(code, 0, "a one-shot run must exit cleanly");
  assert.match(stdout, /hello shell/, "the shell rendered the answer");
  assert.ok(!stdout.includes("adapter-zcode"), "the shell output names no adapter plumbing");
  assert.ok(!stdout.includes("fake-zcode"), "the shell output names no test double");
});

// ── the pure mapping table ──────────────────────────────────────────────

test("translate.ts maps the wire vocabulary without policy", () => {
  assert.deepEqual(mapTurnEnd("completedSuccess").stopReason, "end_turn");
  assert.deepEqual(mapTurnEnd("completedInterrupted").stopReason, "cancelled");
  assert.deepEqual(mapTurnEnd("failed").stopReason, "error");
  assert.deepEqual(mapTurnEnd("running").stopReason, "error", "an unexpected state is an error, not a guess");

  assert.deepEqual(
    mapUsage({ cumulative: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 } }),
    { inputTokens: 10, outputTokens: 2, cachedTokens: 4 },
  );
  assert.equal(mapUsage({}), undefined, "usage without cumulative counters maps to nothing");

  assert.deepEqual(mapSubagentStatus("success"), "success");
  assert.deepEqual(mapSubagentStatus("cancelled"), "cancelled");
  assert.deepEqual(mapSubagentStatus("failed"), "error");

  const options = [
    { optionId: "opt_once", label: "Allow once", kind: "allowOnce" },
    { optionId: "opt_full", label: "Full access", kind: "custom" },
    { optionId: "opt_deny", label: "Deny", kind: "deny" },
  ];
  assert.deepEqual(
    mapApprovalOptions(options).map((option) => option.id),
    ["allow_once", "deny"],
    "custom kinds have no ARI representation",
  );
  assert.equal(permissionOptionIdFor(options, "allow_once"), "opt_once");
  assert.equal(permissionOptionIdFor(options, "allow_always"), undefined, "a decision that was not offered maps nowhere");
  assert.equal(permissionOptionIdFor(undefined, "allow_once"), "allowOnce", "the reducer's synthesized default idiom");

  const marker = { type: "compact", origin: "manual", status: "success", tokensBefore: 5, tokensAfter: 1 };
  assert.deepEqual(mapCompactionMarker(marker), {
    type: "compaction/performed",
    trigger: "manual",
    preTokens: 5,
    postTokens: 1,
  });
  assert.equal(mapCompactionMarker({ type: "compact", origin: "auto", status: "cancelled" }), undefined);

  const questions = [
    { question: "Which?", header: "Choice", options: [{ value: "A", label: "A label" }], multiSelect: true },
  ];
  const specs = mapQuestionSpecs(questions);
  assert.equal(specs[0].id, "0");
  assert.equal(specs[0].multiSelect, true);
  assert.deepEqual(
    mapQuestionAnswerOut(questions, [{ id: "0", values: ["A", "B"] }]),
    { answer: { action: "accept", content: { answers: { "Which?": "A, B" } } } },
    "multi-select joins with the desktop's own idiom",
  );
  assert.deepEqual(mapQuestionAnswerOut(questions, []), { answer: { action: "decline" } });
});
