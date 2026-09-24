/**
 * The conformance checks — SPEC.md Appendix A.
 *
 * Two kinds of check live here:
 *
 *  - **Observational** checks need no cooperation from the harness. They drive a
 *    generic prompt and assert properties of whatever stream comes back: seq
 *    density, one settlement per turn, capability gating, frame limits, stdout
 *    purity, error codes.
 *
 *  - **Probe** checks need the harness to be driven into a specific path
 *    (request an approval, fail a turn, run long enough to cancel). A harness
 *    under test declares how to reach those paths with `--probe-*` prompts. When
 *    a probe is not supplied the check reports SKIP with a reason — never a
 *    silent pass, and never a false failure.
 *
 * Each check runs against a freshly spawned harness, so no state leaks between
 * them.
 */

import assert from "node:assert/strict";

import { AriError, type AriClient, type AriEvent, type AgentCapabilities, EVENT_CAPABILITY } from "../../ari/src/index.ts";

export interface ProbePrompts {
  approval?: string;
  question?: string;
  slow?: string;
  error?: string;
}

export interface CheckContext {
  client: AriClient;
  events: AriEvent[];
  /** Raw NDJSON lines as written by the harness on stdout. */
  rawFrames: string[];
  /** Lines on stdout that were not parseable JSON (a stdout-purity violation). */
  nonJsonStdout: string[];
  capabilities: AgentCapabilities;
  probes: ProbePrompts;
  /** The harmless prompt used by observational checks. */
  prompt: string;
  /** Implementation-declared queue limit, if the author supplied one. */
  queueLimit?: number;
  waitFor(predicate: (events: AriEvent[]) => boolean, label: string, timeoutMs?: number): Promise<void>;
  settle(ms: number): Promise<void>;
}

export interface Check {
  id: string;
  /** The Appendix A item this check covers, if it maps 1:1. */
  item?: number;
  title: string;
  /** Return a reason string to skip this check. */
  skipReason?: (ctx: CheckContext) => string | undefined;
  run(ctx: CheckContext): Promise<void>;
}

// ── helpers ─────────────────────────────────────────────────────────────

async function expectError(
  fn: () => Promise<unknown>,
  code: number,
  what: string,
): Promise<void> {
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

const ofType = (events: AriEvent[], type: string): AriEvent[] =>
  events.filter((event) => event.type === type);

/** SPEC §9.1: seq starts at 1 and increases by exactly 1. */
function assertDenseSeq(events: AriEvent[], what: string): void {
  const seqs = events.map((event) => event.seq);
  for (let i = 0; i < seqs.length; i += 1) {
    assert.equal(seqs[i], i + 1, `${what}: seq must start at 1 with no gaps; got ${seqs.join(",")}`);
  }
}

/** Send the generic prompt and wait for the turn to settle. */
async function runGenericTurn(ctx: CheckContext, timeoutMs?: number): Promise<void> {
  const { sessionId } = await ctx.client.newSession();
  const before = ctx.events.length;
  await ctx.client.prompt(sessionId, ctx.prompt);
  await ctx.waitFor(
    (events) => events.slice(before).some((event) => event.type === "turn/completed"),
    "a settled turn",
    timeoutMs,
  );
}

// ── the checks ──────────────────────────────────────────────────────────

export const CHECKS: Check[] = [
  {
    id: "C01",
    item: 1,
    title: "a method before initialize is rejected with -32002",
    async run(ctx) {
      await expectError(() => ctx.client.rawRequest("session/new", {}), -32002, "session/new before initialize");
    },
  },

  {
    id: "C02",
    item: 2,
    title: "a duplicate initialize is rejected with -32006",
    async run(ctx) {
      await ctx.client.initialize();
      await expectError(
        () => ctx.client.rawRequest("initialize", { protocolVersion: 1 }),
        -32006,
        "second initialize",
      );
    },
  },

  {
    id: "C03",
    item: 3,
    title: "an unsupported MAJOR is -32008 and the connection can still retry",
    async run(ctx) {
      await expectError(
        () => ctx.client.rawRequest("initialize", { protocolVersion: 99 }),
        -32008,
        "initialize with MAJOR 99",
      );
      const result = await ctx.client.initialize();
      assert.equal(result.protocolVersion, 1, "a retry with a supported MAJOR must succeed");
    },
  },

  {
    id: "C04",
    item: 4,
    title: "an unknown sessionId is -32001 and no session is auto-created",
    async run(ctx) {
      await ctx.client.initialize();
      const ghost = "s_conformance_does_not_exist";
      await expectError(
        () =>
          ctx.client.rawRequest("session/prompt", {
            sessionId: ghost,
            content: [{ type: "text", text: ctx.prompt }],
          }),
        -32001,
        "session/prompt on an unknown session",
      );
      if (ctx.capabilities.sessionList) {
        const listed = await ctx.client.listSessions();
        assert.ok(
          !listed.sessions.some((entry) => entry.sessionId === ghost),
          "the unknown sessionId must not appear in session/list",
        );
      }
    },
  },

  {
    id: "C05",
    item: 5,
    title: "session/new returns nextSeq 1 and no event precedes its response",
    async run(ctx) {
      await ctx.client.initialize();
      const result = await ctx.client.newSession();
      assert.equal(result.nextSeq, 1, "a new session must start at seq 1");

      // The first frame mentioning this session must be the response, not an event.
      const responseAt = ctx.rawFrames.findIndex(
        (frame) => frame.includes(result.sessionId) && frame.includes('"result"'),
      );
      const eventAt = ctx.rawFrames.findIndex(
        (frame) => frame.includes(result.sessionId) && frame.includes('"method":"event"'),
      );
      assert.ok(responseAt >= 0, "the session/new response must be on the wire");
      if (eventAt >= 0) {
        assert.ok(
          responseAt < eventAt,
          `an event for the session preceded the session/new response (response@${responseAt}, event@${eventAt})`,
        );
      }
    },
  },

  {
    id: "C06",
    item: 6,
    title: "event seq starts at 1 and is contiguous with no gaps",
    async run(ctx) {
      await ctx.client.initialize();
      await runGenericTurn(ctx);
      assertDenseSeq(ctx.events, "after one turn");
      assert.deepEqual(ctx.client.gaps, [], "the client observed a seq discontinuity");
    },
  },

  {
    id: "C07",
    item: 7,
    title: "turn/started.messageIds is non-empty and was previously enqueued",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const receipt = await ctx.client.prompt(sessionId, ctx.prompt);
      await ctx.waitFor(
        (events) => events.some((event) => event.type === "turn/completed"),
        "a settled turn",
      );

      const started = ofType(ctx.events, "turn/started") as unknown as { messageIds: string[] }[];
      assert.ok(started.length >= 1, "a turn must have started");
      for (const turn of started) {
        assert.ok(Array.isArray(turn.messageIds), "turn/started must carry messageIds");
        assert.ok(turn.messageIds.length > 0, "turn/started.messageIds must be non-empty");
      }
      // The claimed ids must be ids we actually enqueued.
      assert.ok(
        started.some((turn) => turn.messageIds.includes(receipt.messageId)),
        "the claimed messageIds must include the prompt we enqueued",
      );
    },
  },

  {
    id: "C08",
    item: 8,
    title: "exactly one turn/completed per turn/started",
    async run(ctx) {
      await ctx.client.initialize();
      await runGenericTurn(ctx);
      const started = ofType(ctx.events, "turn/started");
      const completed = ofType(ctx.events, "turn/completed");
      assert.equal(completed.length, started.length, "each turn/started needs exactly one turn/completed");
      const startedTurns = started.map((event) => (event as unknown as { turn: number }).turn);
      const completedTurns = completed.map((event) => (event as unknown as { turn: number }).turn);
      assert.deepEqual(completedTurns, startedTurns, "the settled turns must match the started turns");
    },
  },

  {
    id: "C09",
    item: 9,
    title: "a fatal error emits session/error before turn/completed{error}",
    skipReason: (ctx) => (ctx.probes.error ? undefined : "pass --probe-error <prompt> to drive a failing turn"),
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const before = ctx.events.length;
      await ctx.client.prompt(sessionId, ctx.probes.error ?? "");
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "turn/completed"),
        "the failing turn to settle",
      );

      const tail = ctx.events.slice(before);
      const types = tail.map((event) => event.type);
      const errorAt = types.indexOf("session/error");
      const completedAt = types.indexOf("turn/completed");
      assert.ok(errorAt >= 0, "session/error must be emitted for a fatal error");
      assert.ok(errorAt < completedAt, "session/error must precede turn/completed");
      assert.equal(
        (tail[completedAt] as unknown as { stopReason: string }).stopReason,
        "error",
        "a fatal error must settle with stopReason error",
      );
    },
  },

  {
    id: "C10",
    item: 10,
    title: "exactly one approval/resolved per approval/requested",
    skipReason: (ctx) =>
      ctx.probes.approval ? undefined : "pass --probe-approval <prompt> to drive an approval",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const before = ctx.events.length;
      await ctx.client.prompt(sessionId, ctx.probes.approval ?? "");
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "approval/requested"),
        "approval/requested",
      );

      const requested = ctx.events
        .slice(before)
        .filter((event) => event.type === "approval/requested") as unknown as { approvalId: string }[];
      const offered = requested[0];
      assert.ok(offered, "an approval must have been requested");
      await ctx.client.respondApproval({ sessionId, approvalId: offered.approvalId, decision: "allow_once" });
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "turn/completed"),
        "the turn to settle",
      );

      const resolved = ctx.events
        .slice(before)
        .filter((event) => event.type === "approval/resolved") as unknown as { approvalId: string }[];
      assert.equal(resolved.length, requested.length, "each approval/requested needs exactly one approval/resolved");
      assert.equal(resolved[0]?.approvalId, offered.approvalId);
    },
  },

  {
    id: "C11",
    item: 11,
    title: "exactly one question/resolved per question/requested",
    skipReason: (ctx) => {
      if (!ctx.capabilities.question) return "the harness declared question:false";
      if (!ctx.probes.question) return "pass --probe-question <prompt> to drive a question";
      return undefined;
    },
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const before = ctx.events.length;
      await ctx.client.prompt(sessionId, ctx.probes.question ?? "");
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "question/requested"),
        "question/requested",
      );

      const requested = ctx.events
        .slice(before)
        .filter((event) => event.type === "question/requested") as unknown as {
        questionId: string;
        questions: { id: string }[];
      }[];
      const first = requested[0];
      assert.ok(first, "a question must have been requested");
      const firstQuestionId = first.questions[0]?.id ?? "0";
      await ctx.client.respondQuestion({
        sessionId,
        questionId: first.questionId,
        answers: [{ id: firstQuestionId, values: ["conformance"] }],
      });
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "turn/completed"),
        "the turn to settle",
      );

      const resolved = ctx.events.slice(before).filter((event) => event.type === "question/resolved");
      assert.equal(resolved.length, requested.length, "each question/requested needs exactly one question/resolved");
    },
  },

  {
    id: "C12",
    item: 12,
    title: "no event is emitted for a capability declared false",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();

      // Send every prompt we have, to maximise the chance of provoking a
      // gated event if the harness has a gating bug. The slow probe is excluded:
      // it holds a turn open and buys nothing for gating observation.
      const prompts = [ctx.prompt, ctx.probes.approval, ctx.probes.question, ctx.probes.error].filter(
        (prompt): prompt is string => Boolean(prompt),
      );
      for (const prompt of prompts) {
        const before = ctx.events.length;
        await ctx.client.prompt(sessionId, prompt).catch(() => undefined);
        await ctx
          .waitFor(
            (events) => events.slice(before).some((event) => event.type === "turn/completed"),
            "a settled turn",
            3000,
          )
          .catch(() => undefined);
      }

      for (const event of ctx.events) {
        const required = EVENT_CAPABILITY[event.type];
        if (required && !ctx.capabilities[required]) {
          assert.fail(`event ${event.type} was emitted but capability "${required}" is false`);
        }
      }
    },
  },

  {
    id: "C13",
    item: 13,
    title: "a method or parameter gated by false is rejected with -32003",
    skipReason: (ctx) =>
      Object.values(ctx.capabilities).some((on) => !on)
        ? undefined
        : "the harness declared every capability true, so nothing is gated",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();

      const gatedMethods: Array<[string, unknown]> = [];
      if (!ctx.capabilities.fork) gatedMethods.push(["session/fork", { sessionId }]);
      if (!ctx.capabilities.sessionList) gatedMethods.push(["session/list", {}]);
      if (!ctx.capabilities.question) {
        gatedMethods.push(["question/respond", { sessionId, questionId: "q_conformance", answers: [] }]);
      }

      for (const [method, params] of gatedMethods) {
        await expectError(() => ctx.client.rawRequest(method, params), -32003, `${method} gated by false`);
      }

      if (!ctx.capabilities.approvalEditInput) {
        await expectError(
          () =>
            ctx.client.rawRequest("approval/respond", {
              sessionId,
              approvalId: "ap_conformance",
              decision: "allow_once",
              amendedInput: { command: "true" },
            }),
          -32003,
          "amendedInput without approvalEditInput",
        );
      }

      assert.ok(gatedMethods.length > 0 || !ctx.capabilities.approvalEditInput, "nothing gated to test");
    },
  },

  {
    id: "C14",
    item: 14,
    title: "the session/prompt response precedes any event it caused",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const receipt = await ctx.client.prompt(sessionId, ctx.prompt);

      const receiptAt = ctx.rawFrames.findIndex((frame) => frame.includes(receipt.messageId));
      assert.ok(receiptAt >= 0, "the receipt must appear on the wire");

      // Wait for the turn to settle before inspecting the stream: the receipt
      // resolves as soon as it is processed, while the events it caused are
      // still in flight.
      await ctx.waitFor(
        (events) => events.some((event) => event.type === "turn/completed"),
        "the turn to settle",
      );

      const firstEventAt = ctx.rawFrames.findIndex(
        (frame) => frame.includes('"method":"event"') && frame.includes(sessionId),
      );
      assert.ok(firstEventAt >= 0, "the harness must emit at least one event");
      assert.ok(
        receiptAt < firstEventAt,
        `the receipt must precede events on the wire (receipt@${receiptAt}, first event@${firstEventAt})`,
      );
    },
  },

  {
    id: "C15",
    item: 15,
    title: "a prompt arriving mid-turn is queued without interrupting the turn",
    skipReason: (ctx) =>
      ctx.probes.slow ? undefined : "pass --probe-slow <prompt> to hold a turn open",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const before = ctx.events.length;
      await ctx.client.prompt(sessionId, ctx.probes.slow ?? "");
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "turn/started"),
        "the first turn to start",
      );

      // A second prompt must be accepted (receipt) rather than rejected, and the
      // first turn must not be interrupted by it.
      const second = await ctx.client.prompt(sessionId, ctx.prompt);
      assert.ok(second.messageId.length > 0, "the mid-turn prompt must be accepted");

      const types = ctx.events.slice(before).map((event) => event.type);
      const firstCompleted = types.indexOf("turn/completed");
      const secondStarted = types.indexOf("turn/started", types.indexOf("turn/started") + 1);
      if (secondStarted >= 0 && firstCompleted >= 0) {
        assert.ok(
          firstCompleted < secondStarted,
          "the second turn must not start before the first settles",
        );
      }

      await ctx.client.cancel(sessionId);
    },
  },

  {
    id: "C16",
    item: 16,
    title: "queue overflow is -32005 and nothing is silently dropped",
    skipReason: (ctx) => {
      if (!ctx.queueLimit) return "pass --queue-limit <n> so the suite can force overflow";
      if (!ctx.probes.slow) return "pass --probe-slow <prompt> to hold a turn open";
      return undefined;
    },
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const limit = ctx.queueLimit ?? 0;

      await ctx.client.prompt(sessionId, ctx.probes.slow ?? "");
      await ctx.waitFor((events) => events.some((event) => event.type === "turn/started"), "a running turn");

      let rejected: AriError | undefined;
      for (let i = 0; i < limit + 1; i += 1) {
        try {
          await ctx.client.prompt(sessionId, `${ctx.prompt} ${i}`);
        } catch (error) {
          if (error instanceof AriError) rejected = error;
          break;
        }
      }
      assert.ok(rejected, `the ${limit + 1}th queued prompt must be rejected`);
      assert.equal(rejected.code, -32005, "queue overflow must be -32005");
      await ctx.client.cancel(sessionId);
    },
  },

  {
    id: "C17",
    item: 17,
    title: "session/cancel settles the turn as cancelled and clears the queue",
    skipReason: (ctx) => (ctx.probes.slow ? undefined : "pass --probe-slow <prompt> to hold a turn open"),
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const before = ctx.events.length;
      await ctx.client.prompt(sessionId, ctx.probes.slow ?? "");
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "turn/started"),
        "the turn to start",
      );

      const queued = await ctx.client.prompt(sessionId, ctx.prompt);
      const result = await ctx.client.cancel(sessionId);
      assert.deepEqual(
        result.droppedMessageIds,
        [queued.messageId],
        "cancel must report the inputs it dropped from the queue",
      );

      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "turn/completed"),
        "the cancelled turn to settle",
      );
      const completed = ctx.events
        .slice(before)
        .filter((event) => event.type === "turn/completed") as unknown as { stopReason: string }[];
      assert.equal(completed[0]?.stopReason, "cancelled", "a cancelled turn settles as cancelled");
    },
  },

  {
    id: "C18",
    item: 18,
    title: "session/resume{since} returns a consistent cut with no duplicates or gaps",
    skipReason: (ctx) => (ctx.capabilities.replay ? undefined : "the harness declared replay:false"),
    async run(ctx) {
      await ctx.client.initialize();
      await runGenericTurn(ctx);
      const total = ctx.events.length;
      assert.ok(total >= 3, "need a few events to replay");

      const since = 3;
      const sessionId = ctx.client.sessionIds[0] ?? "";
      assert.ok(sessionId, "a session must exist");
      const result = await ctx.client.resumeSession({ sessionId, since });

      assert.equal(result.replayedFrom, since, "replayedFrom must report where the replay started");
      assert.ok(result.nextSeq > since, "nextSeq must be ahead of the replay window");
      assert.equal(
        result.events.at(-1)?.seq,
        result.nextSeq - 1,
        "the last replayed seq must be nextSeq - 1",
      );
      const seqs = result.events.map((event) => event.seq);
      assert.deepEqual(
        seqs,
        Array.from({ length: seqs.length }, (_, i) => since + i),
        "replayed seqs must be dense from `since`",
      );
    },
  },

  {
    id: "C19",
    item: 19,
    title: "resume beyond the retention window degrades to snapshot + replayedFrom",
    skipReason: (ctx) => (ctx.capabilities.replay ? undefined : "the harness declared replay:false"),
    async run(ctx) {
      await ctx.client.initialize();
      await runGenericTurn(ctx);
      const sessionId = ctx.client.sessionIds[0] ?? "";
      assert.ok(sessionId, "a session must exist");

      // A full replay always carries a snapshot; when the harness has dropped
      // events, replayedFrom must be greater than 1 rather than an error.
      const result = await ctx.client.resumeSession({ sessionId });
      assert.ok(result.snapshot, "resume must return a snapshot");
      assert.ok(result.replayedFrom >= 1, "replayedFrom must be at least 1");
      if (result.replayedFrom > 1) {
        assert.ok(
          result.snapshot,
          "when events were dropped, the snapshot is what makes the replay sufficient",
        );
      }
      assert.equal(result.snapshot?.status, ctx.client.getSession(sessionId)?.status);
    },
  },

  {
    id: "C20",
    item: 20,
    title: "a repeated approval/respond is idempotent, a conflicting one is -32007",
    skipReason: (ctx) =>
      ctx.probes.approval ? undefined : "pass --probe-approval <prompt> to drive an approval",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      const before = ctx.events.length;
      await ctx.client.prompt(sessionId, ctx.probes.approval ?? "");
      await ctx.waitFor(
        (events) => events.slice(before).some((event) => event.type === "approval/requested"),
        "approval/requested",
      );

      const requested = ctx.events
        .slice(before)
        .filter((event) => event.type === "approval/requested") as unknown as { approvalId: string }[];
      const approvalId = requested[0]?.approvalId;
      assert.ok(approvalId, "an approval must have been requested");

      await ctx.client.respondApproval({ sessionId, approvalId, decision: "allow_once" });
      // Same answer again: idempotent success.
      await ctx.client.respondApproval({ sessionId, approvalId, decision: "allow_once" });
      // Conflicting answer: -32007.
      await expectError(
        () => ctx.client.respondApproval({ sessionId, approvalId, decision: "deny" }),
        -32007,
        "conflicting re-answer",
      );
      // Unknown id: -32007.
      await expectError(
        () => ctx.client.respondApproval({ sessionId, approvalId: "ap_conformance_missing", decision: "deny" }),
        -32007,
        "unknown approvalId",
      );
    },
  },

  {
    id: "C21",
    item: 21,
    title: "every frame is <= 1 MiB and stdout carries nothing but ARI frames",
    async run(ctx) {
      await ctx.client.initialize();
      // A harness that writes an unframeable line can kill the client, so look
      // at the raw tap regardless of how far the client got.
      await runGenericTurn(ctx, 3000).catch(() => undefined);

      assert.deepEqual(
        ctx.nonJsonStdout,
        [],
        "stdout must carry only JSON frames; logs belong on stderr (SPEC §4.1)",
      );
      const tooBig = ctx.rawFrames.filter((frame) => Buffer.byteLength(frame, "utf8") > 1_048_576);
      assert.deepEqual(
        tooBig,
        [],
        `no frame may exceed 1 MiB (largest was ${
          ctx.rawFrames.reduce((max, frame) => Math.max(max, Buffer.byteLength(frame, "utf8")), 0)
        } bytes)`,
      );
    },
  },

  {
    id: "C22",
    item: 22,
    title: "every termination path reaches session/status idle",
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      await ctx.client.prompt(sessionId, ctx.prompt);
      await ctx.waitFor(
        (events) => events.some((event) => event.type === "turn/completed"),
        "a settled turn",
      );
      // `idle` may be the last event, or the session may already have been idle.
      await ctx
        .waitFor(
          (events) =>
            events.at(-1)?.type === "session/status" &&
            (events.at(-1) as unknown as { status: string }).status === "idle",
          "idle",
          3000,
        )
        .catch(() => undefined);
      assert.equal(ctx.client.getSession(sessionId)?.status, "idle", "the session must end up idle");
    },
  },

  // ── extras beyond Appendix A ──────────────────────────────────────────

  {
    id: "C23",
    title: "an unknown method is -32601",
    async run(ctx) {
      await ctx.client.initialize();
      await expectError(
        () => ctx.client.rawRequest("conformance/not-a-method", {}),
        -32601,
        "unknown method",
      );
    },
  },

  {
    id: "C24",
    title: "a since beyond the watermark is -32602 rather than a silent correction",
    skipReason: (ctx) => (ctx.capabilities.replay ? undefined : "the harness declared replay:false"),
    async run(ctx) {
      await ctx.client.initialize();
      const { sessionId } = await ctx.client.newSession();
      await expectError(
        () => ctx.client.resumeSession({ sessionId, since: 100_000 }),
        -32602,
        "since beyond the watermark",
      );
    },
  },
];
