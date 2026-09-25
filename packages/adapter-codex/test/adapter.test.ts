/**
 * Adapter tests — the Codex → ARI translator, end to end.
 *
 * Every protocol-level test drives the real adapter as a subprocess
 * (`node packages/adapter-codex/src/main.ts`) with the Codex-protocol fake
 * (`fake-codex.ts`) behind it, using the reference `AriClient`. Cross-process
 * is deliberate: the interesting failures of a translator (framing, ordering,
 * attribution) only exist between processes (see the repository handoff, §7).
 *
 * Run: node --test packages/adapter-codex/test/
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AriClient, AriError } from "../../ari/src/index.ts";
import type { AriEvent } from "../../ari/src/index.ts";
import {
  mapAnswersOut,
  mapApprovalDecisionOut,
  mapApprovalResolutionOut,
  mapCommandExecutionItem,
  mapFileChangeItem,
  mapQuestions,
  mapSubagentStatus,
  mapTurnEnd,
  mapUsage,
} from "../src/translate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const ADAPTER = path.join(root, "packages/adapter-codex/src/main.ts");
const FAKE = path.join(root, "packages/adapter-codex/test/fake-codex.ts");
const SHELL = path.join(root, "packages/shell/src/main.ts");

interface Started {
  client: AriClient;
  events: AriEvent[];
  close(): void;
}

function startAdapter(extraArgs: readonly string[] = []): Started {
  const events: AriEvent[] = [];
  const client = AriClient.spawn({
    command: "node",
    args: [ADAPTER, ...extraArgs, "--codex", "node", FAKE],
    cwd: root,
    requestTimeoutMs: 8_000,
    onStderr: () => undefined,
  });
  client.onEvent((event) => events.push(event));
  return { client, events, close: () => client.close() };
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

// ── handshake and gating ────────────────────────────────────────────────

test("initialize declares exactly the capabilities the Codex wire can deliver", async () => {
  const started = startAdapter();
  try {
    const result = await started.client.initialize();
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo.name, "codex", "agentInfo names the real runtime");
    assert.deepEqual(result.agentCapabilities, {
      reasoning: true,
      question: true,
      approvalEditInput: false,
      usage: true,
      compactionEvents: true,
      replay: true,
      fileChanges: true,
      subagents: true,
      backgroundTasks: false,
      fork: true,
      sessionList: true,
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
      () => client.respondApproval({ sessionId, approvalId: "ap_missing", decision: "deny" }),
      -32007,
      "unknown approval id",
    );
    await expectError(
      () => client.respondQuestion({ sessionId, questionId: "q_missing", answers: [] }),
      -32007,
      "unknown question id",
    );
    await expectError(
      () => client.prompt("s_does_not_exist", "hi"),
      -32001,
      "unknown session is not auto-created",
    );
    await expectError(
      () => client.resumeSession({ sessionId, since: 100_000 }),
      -32602,
      "since beyond the watermark",
    );
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

test("tool calls translate with lifecycle, output, and completion", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "tool ls -la");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const startedTool = ofType(events, "tool/started")[0] as unknown as { callId: string; name: string; input: unknown };
    assert.equal(startedTool.name, "shell");
    assert.deepEqual(startedTool.input, { command: "ls -la", cwd: "/repo" });

    const updated = ofType(events, "tool/updated")[0] as unknown as { callId: string; outputDelta: string };
    assert.equal(updated.outputDelta, "ran: ls -la", "output deltas stream");

    const completedTool = ofType(events, "tool/completed")[0] as unknown as { callId: string; status: string; output: string };
    assert.equal(completedTool.status, "success");
    assert.equal(completedTool.output, "ran: ls -la", "a small streamed output is summarized once, not duplicated");
    assert.equal(completedTool.callId, startedTool.callId);
  } finally {
    started.close();
  }
});

test("failed and declined tools carry the failure facts", async () => {
  const failed = await startWithSession();
  try {
    const { client, events, sessionId } = failed;
    await client.prompt(sessionId, "toolfail");
    await waitFor(events, (list) => list.some((event) => event.type === "tool/completed"), "the tool to complete");
    const completed = ofType(events, "tool/completed")[0] as unknown as { status: string; output: string };
    assert.equal(completed.status, "error");
    assert.match(completed.output, /command not found/);
  } finally {
    failed.close();
  }

  const declined = await startWithSession();
  try {
    const { client, events, sessionId } = declined;
    await client.prompt(sessionId, "tooldeclined");
    await waitFor(events, (list) => list.some((event) => event.type === "tool/completed"), "the tool to complete");
    const completed = ofType(events, "tool/completed")[0] as unknown as { status: string; output: string };
    assert.equal(completed.status, "error");
    assert.match(completed.output, /declined by user/);
  } finally {
    declined.close();
  }
});

test("reasoning and usage stream from their deltas", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "reasoning think hard");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const reasoning = ofType(events, "reasoning/delta") as unknown as { text: string }[];
    assert.ok(reasoning.some((delta) => delta.text === "considering: think hard"));
    assert.ok(reasoning.some((delta) => delta.text === "summary: think"), "summary deltas stream too");
    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("reasoning/delta") < types.indexOf("message/delta"), "reasoning precedes the answer");
  } finally {
    started.close();
  }

  const counted = await startWithSession();
  try {
    const { client, events, sessionId } = counted;
    await client.prompt(sessionId, "usage");
    await waitFor(events, (list) => list.some((event) => event.type === "usage/updated"), "usage");
    const usage = ofType(events, "usage/updated")[0] as unknown as { usage: { inputTokens: number; cachedTokens?: number } };
    assert.equal(usage.usage.inputTokens, 1234);
    assert.equal(usage.usage.cachedTokens, 100, "cachedInputTokens maps to cachedTokens");
  } finally {
    counted.close();
  }
});

test("subagent, compaction, and file-change items map onto their ARI events", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "subagent");
    await waitFor(events, (list) => list.some((event) => event.type === "subagent/finished"), "the subagent to finish");
    const child = ofType(events, "subagent/started")[0] as unknown as { callId: string; name?: string };
    assert.ok(child.callId.length > 0);
    assert.equal(child.name, "researcher");
    const finished = ofType(events, "subagent/finished")[0] as unknown as { callId: string; status: string };
    assert.equal(finished.status, "success");
    assert.equal(events[0]?.sessionId, sessionId, "subagent events ride the parent session");
  } finally {
    started.close();
  }

  const compacted = await startWithSession();
  try {
    const { client, events, sessionId } = compacted;
    await client.prompt(sessionId, "compact");
    await waitFor(events, (list) => list.some((event) => event.type === "compaction/performed"), "compaction");
    const performed = ofType(events, "compaction/performed")[0] as unknown as { trigger: string };
    assert.equal(performed.trigger, "auto", "pressure compaction is automatic");
  } finally {
    compacted.close();
  }

  const files = await startWithSession();
  try {
    const { client, events, sessionId } = files;
    await client.prompt(sessionId, "filechange");
    await waitFor(events, (list) => list.some((event) => event.type === "file/changed"), "file changes");
    const changed = ofType(events, "file/changed") as unknown as { path: string; kind: string }[];
    assert.deepEqual(changed.map((entry) => entry.kind), ["create", "delete"]);
  } finally {
    files.close();
  }
});

test("events for threads the adapter did not create are dropped", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "foreign");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    for (const event of events) {
      assert.equal(event.sessionId, sessionId, "every event belongs to the ARI session");
      assert.ok(!JSON.stringify(event).includes("stray"), "foreign content never reaches the shell");
    }
    assertDenseSeq(events, "foreign events must not punch holes in seq");
  } finally {
    started.close();
  }
});

// ── approvals and questions (the server→client request channel) ─────────

test("an approval loops through the runtime request and resolves exactly once", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "approval yes");
    await waitFor(events, (list) => list.some((event) => event.type === "approval/requested"), "the approval request");

    const requested = ofType(events, "approval/requested")[0] as unknown as {
      approvalId: string;
      toolCallId: string;
      toolName: string;
      reason?: string;
    };
    assert.equal(requested.toolName, "shell");
    assert.match(requested.reason ?? "", /wants to run/);

    await client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "allow_once" });
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const resolved = ofType(events, "approval/resolved") as unknown as { approvalId: string; decision: string }[];
    assert.equal(resolved.length, 1, "exactly one resolution");
    assert.equal(resolved[0].decision, "allow_once");
    assert.equal(resolved[0].approvalId, requested.approvalId);

    // Idempotency and conflict (SPEC §10.3).
    await client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "allow_once" });
    await expectError(
      () => client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "deny" }),
      -32007,
      "conflicting re-answer",
    );
  } finally {
    started.close();
  }
});

test("a question loops through the runtime request; declining is explicit", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "question");
    await waitFor(events, (list) => list.some((event) => event.type === "question/requested"), "the question request");

    const requested = ofType(events, "question/requested")[0] as unknown as {
      questionId: string;
      questions: { id: string; question: string; options?: { id: string }[] }[];
    };
    assert.equal(requested.questions[0].question, "Which option do you want?");
    assert.equal(requested.questions[0].options?.[0].id, "A");

    await client.respondQuestion({
      sessionId,
      questionId: requested.questionId,
      answers: [{ id: "which", values: ["B"] }],
    });
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const resolved = ofType(events, "question/resolved") as unknown as { questionId: string; outcome: string }[];
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].outcome, "answered");
    const reply = ofType(events, "message/delta").map((event) => (event as unknown as { text: string }).text).join("");
    assert.match(reply, /you chose B/);
  } finally {
    started.close();
  }

  const declining = await startWithSession();
  try {
    const { client, events, sessionId } = declining;
    await client.prompt(sessionId, "question");
    await waitFor(events, (list) => list.some((event) => event.type === "question/requested"), "the question request");
    const requested = ofType(events, "question/requested")[0] as unknown as { questionId: string };
    await client.respondQuestion({ sessionId, questionId: requested.questionId, answers: [] });
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const resolved = ofType(events, "question/resolved")[0] as unknown as { outcome: string };
    assert.equal(resolved.outcome, "declined", "an empty answer array is an explicit decline");
  } finally {
    declining.close();
  }
});

// ── error settlement ────────────────────────────────────────────────────

test("a failed turn emits session/error before turn/completed{error}", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "fail");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const types = events.map((event) => event.type);
    const errorAt = types.indexOf("session/error");
    const completedAt = types.indexOf("turn/completed");
    assert.ok(errorAt >= 0, "session/error must be emitted");
    assert.ok(errorAt < completedAt, "session/error must precede turn/completed");
    const completed = events[completedAt] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "error");
    const diagnostic = events[errorAt] as unknown as { error: { message: string } };
    assert.match(diagnostic.error.message, /RATE/, "the provider facts survive the mapping");
  } finally {
    started.close();
  }
});

test("a retryable error is diagnostics only; the turn still settles end_turn", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "retryerror");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const errorEvent = ofType(events, "session/error")[0] as unknown as { error: { retryable?: boolean } };
    assert.equal(errorEvent.error.retryable, true, "willRetry maps to a retryable diagnostic");
    const completed = ofType(events, "turn/completed")[0] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "end_turn", "a retried turn is not an error turn");
  } finally {
    started.close();
  }
});

// ── cancellation (interrupt, not process replacement) ────────────────────

test("cancel interrupts the turn, settles cancelled, reports dropped, and the runtime survives", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "slow 8000");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/started"), "the turn to start");

    const queued = await client.prompt(sessionId, "second message");
    const result = await client.cancel(sessionId);
    assert.deepEqual(result.droppedMessageIds, [queued.messageId], "only the unclaimed receipt is dropped");
    assert.equal(result.cancelledTurn, 1);

    await waitFor(
      events,
      (list) =>
        list.some((event) => event.type === "turn/completed") &&
        (ofType(events, "turn/completed")[0] as unknown as { stopReason: string }).stopReason === "cancelled",
      "the cancelled turn to settle",
    );
    await waitFor(events, (list) => list.at(-1)?.type === "session/status", "idle");
    const status = events.at(-1) as unknown as { status: string };
    assert.equal(status.status, "idle", "a cancelled session must reach idle");

    // The runtime was never killed: the next turn keeps the same session.
    await client.prompt(sessionId, "hello again");
    await waitFor(
      events,
      (list) => ofType(list, "turn/completed").length === 2,
      "the post-cancel turn to settle",
    );
    const secondTurn = ofType(events, "turn/completed")[1] as unknown as { turn: number; stopReason: string };
    assert.equal(secondTurn.turn, 2, "turn numbering continues after an interrupt");
    assert.equal(secondTurn.stopReason, "end_turn");
    assertDenseSeq(events, "the interrupt must not disturb seq");
  } finally {
    started.close();
  }
});

test("cancel with nothing in flight is an idempotent no-op", async () => {
  const started = await startWithSession();
  try {
    const result = await started.client.cancel(started.sessionId);
    assert.deepEqual(result.droppedMessageIds, []);
    assert.equal(result.cancelledTurn, undefined);
  } finally {
    started.close();
  }
});

test("queue overflow is -32005 and nothing is silently dropped", async () => {
  const started = await startWithSession(["--queue-limit", "2"]);
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "slow 8000");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/started"), "a running turn");

    await client.prompt(sessionId, "queued 1");
    await client.prompt(sessionId, "queued 2");
    await expectError(() => client.prompt(sessionId, "queued 3"), -32005, "the third queued prompt");

    await client.cancel(sessionId);
  } finally {
    started.close();
  }
});

// ── replay, fork, and the session list ──────────────────────────────────

test("session/resume returns a consistent cut from the ledger", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "hello replay");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const result = await client.resumeSession({ sessionId, since: 3 });
    assert.equal(result.replayedFrom, 3);
    assert.ok(result.nextSeq > 3, "nextSeq must be ahead of the replay window");
    assert.equal(result.events.at(-1)?.seq, result.nextSeq - 1);
    const seqs = result.events.map((event) => event.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => 3 + i), "replayed seqs dense from since");
    assert.ok(result.snapshot, "a snapshot accompanies the replay");
    assert.equal(result.snapshot?.status, "idle");
  } finally {
    started.close();
  }
});

test("resume without since replays everything; a beyond-watermark since is -32602", async () => {
  const started = await startWithSession();
  try {
    const { client, sessionId } = started;
    await client.prompt(sessionId, "hello");
    const full = await client.resumeSession({ sessionId });
    assert.equal(full.replayedFrom, 1);
    assert.ok(full.snapshot, "a full replay carries a snapshot");
  } finally {
    started.close();
  }

  const second = await startWithSession();
  try {
    await expectError(
      () => second.client.resumeSession({ sessionId: second.sessionId, since: 50_000 }),
      -32602,
      "since beyond the watermark",
    );
  } finally {
    second.close();
  }
});

test("session/fork forks at a turn boundary into a fresh session", async () => {
  const started = await startWithSession();
  try {
    const { client, sessionId } = started;
    await client.prompt(sessionId, "first");
    const forked = await client.forkSession(sessionId, 1);
    assert.notEqual(forked.sessionId, sessionId, "the fork is a brand-new session");
    assert.equal(forked.nextSeq, 1);
    assert.deepEqual(forked.forkedFrom, { sessionId, turn: 1 });
    await expectError(() => client.forkSession(sessionId, 9), -32602, "an unknown turn boundary");
  } finally {
    started.close();
  }
});

test("session/list lists threads and a listed thread is promptable", async () => {
  const started = await startWithSession();
  try {
    const { client, sessionId, events } = started;
    await client.prompt(sessionId, "warm up");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const listed = await client.listSessions();
    const entry = listed.sessions.find((candidate) => candidate.sessionId === sessionId);
    assert.ok(entry, "the live thread is listed");
    assert.equal(entry?.status, "idle");

    // Adoption: a listed thread id (not created via session/new) is promptable.
    await client.prompt(sessionId, "adopted and answered");
    await waitFor(events, (list) => ofType(list, "turn/completed").length >= 2, "the adopted turn to settle");

    await expectError(() => client.prompt("thr_never_listed", "hi"), -32001, "an unlisted thread is not adoptable");
  } finally {
    started.close();
  }
});

// ── frame discipline ────────────────────────────────────────────────────

test("oversized tool output streams as deltas and every frame stays under 1 MiB", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "bigoutput");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const deltas = ofType(events, "tool/updated") as unknown as { outputDelta: string }[];
    assert.ok(deltas.length >= 3, "a 300 KiB result must stream in more than one delta");
    const streamed = deltas.map((delta) => delta.outputDelta).join("");
    assert.equal(streamed.length, 300_000, "the deltas carry the whole output");

    const completed = ofType(events, "tool/completed")[0] as unknown as { output: string };
    assert.match(completed.output, /streamed in deltas/, "the completion carries a summary, not the payload twice");

    for (const event of events) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(event), "utf8") <= 1_048_576,
        "no event may approach or cross the frame cap",
      );
    }
  } finally {
    started.close();
  }
});

// ── the whole point: one shell, any harness ─────────────────────────────

function runShell(args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [SHELL, ...args], { cwd: root });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
}

test("the reference shell drives Codex (via the adapter) without knowing what it is", { timeout: 20_000 }, async () => {
  const { code, stdout } = await runShell([
    "--prompt",
    "tool ls -la",
    "--",
    "node",
    ADAPTER,
    "--codex",
    "node",
    FAKE,
  ]);

  assert.equal(code, 0, "a one-shot run must exit cleanly");
  assert.match(stdout, /ran: ls -la/, "the tool output reaches the user");
  assert.ok(!stdout.includes("adapter-codex"), "the shell output names no adapter plumbing");
  assert.ok(!stdout.includes("fake-codex"), "the shell output names no test double");
});

// ── pure translation units ──────────────────────────────────────────────

test("mapTurnEnd covers the Codex vocabulary and refuses to guess", () => {
  assert.deepEqual(mapTurnEnd({ id: "t", status: "completed" }), { stopReason: "end_turn" });
  assert.deepEqual(mapTurnEnd({ id: "t", status: "interrupted" }), { stopReason: "cancelled" });

  const failed = mapTurnEnd({ id: "t", status: "failed", error: { message: "RATE: boom" } });
  assert.equal(failed.stopReason, "error");
  assert.match(failed.error?.message ?? "", /RATE: boom/);

  const contradictory = mapTurnEnd({ id: "t", status: "inProgress" });
  assert.equal(contradictory.stopReason, "error", "an inProgress settlement is a wire contradiction");
});

test("mapCommandExecutionItem maps status and folds exit codes into the output", () => {
  const ok = mapCommandExecutionItem({ type: "commandExecution", id: "i", status: "completed", aggregatedOutput: "out", exitCode: 0 }, "i");
  assert.equal(ok["status"], "success");
  assert.equal(ok["output"], "out");

  const failed = mapCommandExecutionItem({ type: "commandExecution", id: "i", status: "failed", aggregatedOutput: "boom", exitCode: 2 }, "i");
  assert.equal(failed["status"], "error");
  assert.match(String(failed["output"]), /boom/);
  assert.match(String(failed["output"]), /exit code 2/);

  const declined = mapCommandExecutionItem({ type: "commandExecution", id: "i", status: "declined", aggregatedOutput: null, exitCode: null }, "i");
  assert.equal(declined["status"], "error");
  assert.match(String(declined["output"]), /declined by user/);
});

test("mapFileChangeItem maps patch kinds and skips unapplied changes", () => {
  const drafts = mapFileChangeItem({
    type: "fileChange",
    id: "i",
    status: "completed",
    changes: [
      { path: "a", kind: { type: "add" }, diff: "+a" },
      { path: "b", kind: { type: "delete" }, diff: "-b" },
      { path: "c", kind: { type: "update" }, diff: "~c" },
      { path: "d", kind: { type: "update", movePath: "e" }, diff: ">e" },
    ],
  });
  assert.deepEqual(
    drafts.map((draft) => [draft["path"], draft["kind"]]),
    [["a", "create"], ["b", "delete"], ["c", "modify"], ["d", "rename"]],
  );
  assert.deepEqual(mapFileChangeItem({ type: "fileChange", id: "i", status: "declined", changes: [] }), []);
});

test("mapSubagentStatus and mapUsage rename honestly", () => {
  assert.equal(mapSubagentStatus("completed"), "success");
  assert.equal(mapSubagentStatus("interrupted"), "cancelled");
  assert.equal(mapSubagentStatus("started"), "success");
  assert.equal(mapSubagentStatus("mystery"), "error");

  assert.deepEqual(mapUsage({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 1 }), {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 3,
    reasoningTokens: 1,
  });
  assert.equal(mapUsage({ inputTokens: 10 }), undefined, "outputTokens is mandatory");
  assert.equal(mapUsage("junk"), undefined);
});

test("approval decisions map onto the closed Codex enum and back", () => {
  assert.equal(mapApprovalDecisionOut("allow_once"), "accept");
  assert.equal(mapApprovalDecisionOut("allow_always"), "acceptForSession");
  assert.equal(mapApprovalDecisionOut("deny"), "decline");
  assert.equal(mapApprovalResolutionOut("accept"), "allow_once");
  assert.equal(mapApprovalResolutionOut("acceptForSession"), "allow_always");
  assert.equal(mapApprovalResolutionOut("cancel"), "cancelled");
  assert.equal(mapApprovalResolutionOut("decline"), "deny");
});

test("questions map with options and answers pass through as the wire expects", () => {
  const specs = mapQuestions([
    { id: "which", header: "Choice", question: "Which?", options: [{ label: "A", description: "first" }] },
    { id: "free", question: "Free text?" },
  ]);
  assert.equal(specs[0].options?.[0].id, "A");
  assert.equal(specs[0].detail, "Choice");
  assert.equal(specs[1].options, undefined);

  assert.deepEqual(mapAnswersOut([]), { answers: {} }, "an empty answer array declines");
  assert.deepEqual(mapAnswersOut([{ id: "which", values: ["A"] }]), { answers: { which: { answers: ["A"] } } });
});
