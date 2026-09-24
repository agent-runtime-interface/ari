/**
 * Invariant tests for the Harness-side helper — SPEC.md §8 (I1–I7), §5.3, §7, §9.1, §10.
 *
 * These drive a real harness through a real Shell client over in-memory streams,
 * so they exercise framing, gating, sequencing and settlement together.
 *
 * Run: node --test packages/ari/test/
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";

import { AriClient } from "../src/client.ts";
import { AriError } from "../src/errors.ts";
import { AriHarness, type HarnessDelegate, type TurnContext } from "../src/harness.ts";
import {
  ALL_CAPABILITIES,
  type AgentCapabilities,
  type AriEvent,
  type StopReason,
} from "../src/types.ts";

// ── a controllable harness ──────────────────────────────────────────────

type Mode = "simple" | "gated" | "approval" | "cancel" | "danglingTool" | "question" | "throw";

interface Rig {
  client: AriClient;
  harness: AriHarness;
  events: AriEvent[];
  /** Raw NDJSON frames as written by the harness, in wire order. */
  rawFrames: string[];
  setMode(mode: Mode): void;
  /** Wait until `predicate` holds for the collected events. */
  waitFor(predicate: (events: AriEvent[]) => boolean, label: string): Promise<void>;
}

function makeRig(options?: {
  capabilities?: Partial<AgentCapabilities>;
  interactionTimeoutMs?: number;
}): Rig {
  const capabilities: AgentCapabilities = { ...ALL_CAPABILITIES, ...options?.capabilities };
  let mode: Mode = "simple";
  const events: AriEvent[] = [];

  const delegate: HarnessDelegate = {
    // Required because the default capability set enables `fork`; the helper
    // rejects a `fork: true` harness that cannot actually fork.
    onFork: () => {
      /* nothing to copy in this in-memory harness */
    },
    async handleTurn(ctx: TurnContext): Promise<StopReason> {
      switch (mode) {
        case "simple": {
          ctx.messageDelta("looking…");
          const callId = ctx.toolStarted({ name: "shell", input: { command: "ls" } });
          ctx.toolUpdated({ callId, status: "running", outputDelta: "a.txt" });
          ctx.toolCompleted({ callId, status: "success", output: "a.txt\nb.md" });
          ctx.usage({ inputTokens: 10, outputTokens: 5 });
          ctx.messageDelta("two files");
          return "end_turn";
        }
        case "gated": {
          // `reasoning` is declared false in this mode: this must throw.
          ctx.reasoningDelta("should not be allowed");
          return "end_turn";
        }
        case "approval": {
          const decision = await ctx.requestApproval({ toolName: "shell", reason: "rm -rf pattern" });
          ctx.messageDelta(`decision=${decision}`);
          return "end_turn";
        }
        case "question": {
          const answer = await ctx.requestQuestion({
            questions: [{ id: "which", question: "Which one?", options: [{ id: "A", label: "A" }] }],
          });
          ctx.messageDelta(`outcome=${answer.outcome}`);
          return "end_turn";
        }
        case "cancel": {
          await new Promise<never>((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted by cancel")));
          });
          return "end_turn";
        }
        case "danglingTool": {
          ctx.toolStarted({ name: "leaky" });
          return "end_turn";
        }
        case "throw": {
          throw new AriError(-32000, "delegate exploded");
        }
        default:
          return "end_turn";
      }
    },
  };

  const harness = new AriHarness({
    agentInfo: { name: "TestHarness", version: "1.0.0" },
    capabilities,
    delegate,
    cancelGraceMs: 250,
    ...(options?.interactionTimeoutMs !== undefined
      ? { interactionTimeoutMs: options.interactionTimeoutMs }
      : {}),
  });

  const toHarness = new PassThrough();
  const harnessOut = new PassThrough();
  const clientIn = new PassThrough();

  // Tap the harness→client direction so wire ordering can be asserted directly
  // (SPEC §7.9 is a statement about the stream, not about promise timing).
  const rawFrames: string[] = [];
  let buffered = "";
  harnessOut.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newlineAt = buffered.indexOf("\n");
    while (newlineAt >= 0) {
      const line = buffered.slice(0, newlineAt);
      buffered = buffered.slice(newlineAt + 1);
      if (line.trim() !== "") rawFrames.push(line);
      newlineAt = buffered.indexOf("\n");
    }
    clientIn.write(chunk);
  });

  void harness.serve(toHarness, harnessOut);

  const client = AriClient.attach({ input: clientIn, output: toHarness });
  client.onEvent((event) => events.push(event));

  return {
    client,
    harness,
    events,
    rawFrames,
    setMode(next: Mode) {
      mode = next;
    },
    async waitFor(predicate, label) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (predicate(events)) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}; got ${events.map((e) => e.type).join(",")}`);
    },
  };
}

const seqsOf = (events: AriEvent[]): number[] => events.map((e) => e.seq);
const ofType = (events: AriEvent[], type: string): AriEvent[] => events.filter((e) => e.type === type);

/** SPEC §9.1: seq starts at 1, increases by exactly 1, no gaps. */
function assertContiguousSeq(events: AriEvent[]): void {
  const seqs = seqsOf(events);
  assert.deepEqual(
    seqs,
    Array.from({ length: seqs.length }, (_, i) => i + 1),
    `seq must start at 1 and have no gaps; got ${seqs.join(",")}`,
  );
}

// ── handshake (§5) ──────────────────────────────────────────────────────

test("methods before initialize are rejected with -32002", async () => {
  const rig = makeRig();
  await assert.rejects(
    () => rig.client.rawRequest("session/new", {}),
    (error: unknown) => error instanceof AriError && error.code === -32002,
  );
  rig.client.close();
});

test("initialize echoes capabilities and version", async () => {
  const rig = makeRig();
  const result = await rig.client.initialize();
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.agentInfo.name, "TestHarness");
  assert.equal(rig.client.capabilities.sessionList, true);
  rig.client.close();
});

test("a second initialize is rejected with -32006", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  await assert.rejects(
    () => rig.client.rawRequest("initialize", { protocolVersion: 1 }),
    (error: unknown) => error instanceof AriError && error.code === -32006,
  );
  rig.client.close();
});

test("an unsupported MAJOR is rejected with -32008 and the connection stays usable", async () => {
  const rig = makeRig();
  await assert.rejects(
    () => rig.client.rawRequest("initialize", { protocolVersion: 2 }),
    (error: unknown) => error instanceof AriError && error.code === -32008,
  );
  // Still able to negotiate a supported version afterwards (SPEC §5.2).
  const result = await rig.client.initialize();
  assert.equal(result.protocolVersion, 1);
  rig.client.close();
});

// ── I1 / I2 / I3: settlement ────────────────────────────────────────────

test("a simple turn produces contiguous seq, claims messageIds, and settles once", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId, nextSeq } = await rig.client.newSession();
  assert.equal(nextSeq, 1);

  const receipt = await rig.client.prompt(sessionId, "list files");
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  const started = ofType(rig.events, "turn/started");
  assert.equal(started.length, 1);
  assert.deepEqual((started[0] as { messageIds: string[] }).messageIds, [receipt.messageId]);

  const completed = ofType(rig.events, "turn/completed");
  assert.equal(completed.length, 1, "exactly one turn/completed per turn/started (I1)");
  assert.equal((completed[0] as { stopReason: string }).stopReason, "end_turn");

  assertContiguousSeq(rig.events);
  rig.client.close();
});

test("the prompt receipt precedes every event it caused (SPEC §7.9)", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();

  const order: string[] = [];
  rig.client.onEvent((event) => order.push(event.type));
  const receipt = await rig.client.prompt(sessionId, "hi");
  assert.ok(receipt.messageId.startsWith("m_"));

  // Wire-level check: the receipt frame must be written before any event frame.
  const receiptAt = rig.rawFrames.findIndex((frame) => frame.includes('"messageId"'));
  const firstEventAt = rig.rawFrames.findIndex((frame) => frame.includes('"method":"event"'));
  assert.ok(receiptAt >= 0, "the receipt must appear on the wire");
  assert.ok(firstEventAt >= 0, "events must appear on the wire");
  assert.ok(
    receiptAt < firstEventAt,
    `the receipt must precede events on the wire (receipt@${receiptAt}, first event@${firstEventAt})`,
  );

  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");
  assert.equal(order[0], "session/status");
  rig.client.close();
});

test("a throwing delegate still settles: session/error then turn/completed{error} (I2/I3)", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("throw");

  await rig.client.prompt(sessionId, "boom");
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  const types = rig.events.map((e) => e.type);
  const errorAt = types.indexOf("session/error");
  const completedAt = types.indexOf("turn/completed");
  assert.ok(errorAt >= 0, "session/error must be emitted");
  assert.ok(errorAt < completedAt, "session/error must precede turn/completed (I3)");
  assert.equal((rig.events[completedAt] as { stopReason: string }).stopReason, "error");
  assertContiguousSeq(rig.events);
  rig.client.close();
});

test("a dangling tool is closed before the turn settles", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("danglingTool");

  await rig.client.prompt(sessionId, "leak a tool");
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  const types = rig.events.map((e) => e.type);
  assert.ok(
    types.indexOf("tool/completed") < types.indexOf("turn/completed"),
    "no tool may remain open when the turn settles",
  );
  rig.client.close();
});

test("the session reaches idle after every termination path (I6)", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("throw");

  await rig.client.prompt(sessionId, "boom");
  await rig.waitFor(
    (events) => events.at(-1)?.type === "session/status" && (events.at(-1) as { status: string }).status === "idle",
    "idle",
  );
  assert.equal(rig.client.getSession(sessionId)?.status, "idle");
  rig.client.close();
});

// ── capability gating (§5.3) ────────────────────────────────────────────

test("an event for a capability declared false never reaches the wire", async () => {
  const rig = makeRig({ capabilities: { reasoning: false } });
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("gated");

  await rig.client.prompt(sessionId, "try reasoning");
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  assert.equal(ofType(rig.events, "reasoning/delta").length, 0, "gated event must not be emitted");
  // The violation surfaces as a turn error rather than a non-conformant stream.
  assert.equal(ofType(rig.events, "session/error").length, 1);
  assert.equal((ofType(rig.events, "turn/completed")[0] as { stopReason: string }).stopReason, "error");
  assertContiguousSeq(rig.events);
  rig.client.close();
});

test("a gated method is rejected with -32003", async () => {
  const rig = makeRig({ capabilities: { fork: false, sessionList: false } });
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();

  await assert.rejects(
    () => rig.client.rawRequest("session/fork", { sessionId }),
    (error: unknown) => error instanceof AriError && error.code === -32003,
  );
  await assert.rejects(
    () => rig.client.rawRequest("session/list", {}),
    (error: unknown) => error instanceof AriError && error.code === -32003,
  );
  rig.client.close();
});

test("amendedInput is rejected with -32003 when approvalEditInput is false", async () => {
  const rig = makeRig({ capabilities: { approvalEditInput: false } });
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();

  await assert.rejects(
    () =>
      rig.client.rawRequest("approval/respond", {
        sessionId,
        approvalId: "ap_nope",
        decision: "allow_once",
        amendedInput: { command: "ls" },
      }),
    (error: unknown) => error instanceof AriError && error.code === -32003,
  );
  rig.client.close();
});

// ── I7: interactions (§10) ──────────────────────────────────────────────

test("approval round-trip resolves exactly once, and re-answers are idempotent", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("approval");

  await rig.client.prompt(sessionId, "do something risky");
  await rig.waitFor((events) => ofType(events, "approval/requested").length === 1, "approval/requested");

  const requested = ofType(rig.events, "approval/requested")[0] as { approvalId: string };
  await rig.client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "allow_once" });
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  assert.equal(ofType(rig.events, "approval/resolved").length, 1, "exactly one resolved per requested (I7)");
  assert.equal(
    (ofType(rig.events, "approval/resolved")[0] as { decision: string }).decision,
    "allow_once",
  );

  // Same answer again ⇒ idempotent success (SPEC §10.3).
  await rig.client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "allow_once" });

  // A conflicting answer ⇒ -32007.
  await assert.rejects(
    () => rig.client.respondApproval({ sessionId, approvalId: requested.approvalId, decision: "deny" }),
    (error: unknown) => error instanceof AriError && error.code === -32007,
  );

  // An unknown id ⇒ -32007.
  await assert.rejects(
    () => rig.client.respondApproval({ sessionId, approvalId: "ap_missing", decision: "deny" }),
    (error: unknown) => error instanceof AriError && error.code === -32007,
  );
  rig.client.close();
});

test("an unanswered approval is expired when the turn settles", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("approval");

  await rig.client.prompt(sessionId, "risky");
  await rig.waitFor((events) => ofType(events, "approval/requested").length === 1, "approval/requested");

  // Cancel: the pending approval must still reach a terminal event (I7).
  await rig.client.cancel(sessionId);
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  const resolved = ofType(rig.events, "approval/resolved");
  assert.equal(resolved.length, 1);
  assert.equal((resolved[0] as { decision: string }).decision, "cancelled");
  assert.equal((ofType(rig.events, "turn/completed")[0] as { stopReason: string }).stopReason, "cancelled");
  assertContiguousSeq(rig.events);
  rig.client.close();
});

test("a question round-trip reports answered, and [] declines", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("question");

  await rig.client.prompt(sessionId, "ask me");
  await rig.waitFor((events) => ofType(events, "question/requested").length === 1, "question/requested");

  const requested = ofType(rig.events, "question/requested")[0] as { questionId: string };
  await rig.client.respondQuestion({
    sessionId,
    questionId: requested.questionId,
    answers: [{ id: "which", values: ["A"] }],
  });
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  const resolved = ofType(rig.events, "question/resolved");
  assert.equal(resolved.length, 1);
  assert.equal((resolved[0] as { outcome: string }).outcome, "answered");
  rig.client.close();
});

// ── §7.4 cancel ─────────────────────────────────────────────────────────

test("cancel settles the in-flight turn as cancelled and drops queued inputs", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("cancel");

  await rig.client.prompt(sessionId, "long running");
  await rig.waitFor((events) => ofType(events, "turn/started").length === 1, "turn/started");

  const queued = await rig.client.prompt(sessionId, "queued behind it");
  const cancelResult = await rig.client.cancel(sessionId);
  assert.deepEqual(cancelResult.droppedMessageIds, [queued.messageId]);

  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");
  assert.equal((ofType(rig.events, "turn/completed")[0] as { stopReason: string }).stopReason, "cancelled");
  // A cancellation is not an error.
  assert.equal(ofType(rig.events, "session/error").length, 0);
  assertContiguousSeq(rig.events);
  rig.client.close();
});

test("cancel with no in-flight turn is an idempotent no-op", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  const result = await rig.client.cancel(sessionId);
  assert.deepEqual(result.droppedMessageIds, []);
  assert.equal(result.cancelledTurn, undefined);
  rig.client.close();
});

// ── §7.3 queueing ───────────────────────────────────────────────────────

test("a prompt arriving mid-turn is queued, not rejected and not interleaved", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  rig.setMode("cancel");

  const first = await rig.client.prompt(sessionId, "first");
  await rig.waitFor((events) => ofType(events, "turn/started").length === 1, "first turn/started");
  const second = await rig.client.prompt(sessionId, "second");

  await rig.client.cancel(sessionId);
  // The queue is cleared by cancel, so start the second turn explicitly.
  rig.setMode("simple");
  const third = await rig.client.prompt(sessionId, "third");
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 2, "two settled turns");

  const starts = ofType(rig.events, "turn/started") as { messageIds: string[] }[];
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0]?.messageIds, [first.messageId]);
  assert.deepEqual(starts[1]?.messageIds, [third.messageId]);
  assert.ok(!starts.some((s) => s.messageIds.includes(second.messageId)), "dropped input must not start a turn");
  assertContiguousSeq(rig.events);
  rig.client.close();
});

// ── §7.2 replay ─────────────────────────────────────────────────────────

test("resume replays from since with a consistent cut and a snapshot", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  await rig.client.prompt(sessionId, "hi");
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  const total = rig.events.length;
  const result = await rig.client.resumeSession({ sessionId, since: 3 });
  assert.equal(result.replayedFrom, 3);
  assert.equal(result.nextSeq, total + 1, "nextSeq is the watermark");
  assert.equal(result.events.length, total - 2, "events from seq 3 onward");
  assert.ok(result.events.every((event) => event.seq >= 3));
  assert.ok(result.snapshot, "snapshot accompanies the replay");
  assert.equal(result.snapshot?.status, "idle");
  rig.client.close();
});

test("resume with a since beyond the watermark is -32602", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  await assert.rejects(
    () => rig.client.resumeSession({ sessionId, since: 999 }),
    (error: unknown) => error instanceof AriError && error.code === -32602,
  );
  rig.client.close();
});

test("resume is -32004 when the harness declared replay false", async () => {
  const rig = makeRig({ capabilities: { replay: false } });
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  await assert.rejects(
    () => rig.client.resumeSession({ sessionId }),
    (error: unknown) => error instanceof AriError && error.code === -32004,
  );
  rig.client.close();
});

// ── §11 errors ──────────────────────────────────────────────────────────

test("an unknown sessionId is -32001 and never auto-creates a session", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  await assert.rejects(
    () => rig.client.rawRequest("session/prompt", { sessionId: "s_nope", content: [{ type: "text", text: "x" }] }),
    (error: unknown) => error instanceof AriError && error.code === -32001,
  );
  assert.equal(rig.harness.sessionIds.length, 0, "no session may be created implicitly");
  rig.client.close();
});

test("an unknown method is -32601 and a malformed frame is -32700", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  await assert.rejects(
    () => rig.client.rawRequest("no/such/method", {}),
    (error: unknown) => error instanceof AriError && error.code === -32601,
  );
  rig.client.close();
});

// ── §7.5 fork ───────────────────────────────────────────────────────────

test("fork creates an independent session with a fresh seq space", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  await rig.client.prompt(sessionId, "hi");
  await rig.waitFor((events) => ofType(events, "turn/completed").length === 1, "turn/completed");

  const forked = await rig.client.forkSession(sessionId, 1);
  assert.notEqual(forked.sessionId, sessionId);
  assert.equal(forked.nextSeq, 1, "the fork gets its own seq space (SPEC §7.5)");
  assert.deepEqual(forked.forkedFrom, { sessionId, turn: 1 });

  // The source session is unaffected.
  assert.equal(rig.client.getSession(sessionId)?.nextSeq, rig.events.length + 1);
  rig.client.close();
});

test("fork at a non-boundary turn is -32602", async () => {
  const rig = makeRig();
  await rig.client.initialize();
  const { sessionId } = await rig.client.newSession();
  await assert.rejects(
    () => rig.client.forkSession(sessionId, 7),
    (error: unknown) => error instanceof AriError && error.code === -32602,
  );
  rig.client.close();
});
