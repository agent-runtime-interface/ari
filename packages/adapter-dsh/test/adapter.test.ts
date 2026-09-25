/**
 * Adapter tests — the DSH → ARI translator, end to end.
 *
 * Every protocol-level test drives the real adapter as a subprocess
 * (`node packages/adapter-dsh/src/main.ts`) with the DSH-protocol fake
 * (`fake-dsh.ts`) behind it, using the reference `AriClient`. Cross-process
 * is deliberate: the interesting failures of a translator (framing, ordering,
 * attribution) only exist between processes (see the repository handoff, §7).
 *
 * Run: node --test packages/adapter-dsh/test/
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AriClient, AriError } from "../../ari/src/index.ts";
import type { AriEvent } from "../../ari/src/index.ts";
import {
  expandAssistantStream,
  mapTurnEndReason,
  mapToolInput,
  mapToolResult,
  mapUsage,
} from "../src/translate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const ADAPTER = path.join(root, "packages/adapter-dsh/src/main.ts");
const FAKE = path.join(root, "packages/adapter-dsh/test/fake-dsh.ts");
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
    args: [ADAPTER, ...extraArgs, "--dsh", "node", FAKE],
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

test("initialize declares exactly the capabilities the DSH SDK wire can deliver", async () => {
  const started = startAdapter();
  try {
    const result = await started.client.initialize();
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo.name, "deepseek-harness", "agentInfo names the real runtime");
    assert.deepEqual(result.agentCapabilities, {
      reasoning: true,
      question: false,
      approvalEditInput: false,
      usage: true,
      compactionEvents: true,
      replay: false,
      fileChanges: false,
      subagents: true,
      backgroundTasks: false,
      fork: false,
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

test("methods and parameters the DSH wire cannot support answer the ARI codes", async () => {
  const started = await startWithSession();
  try {
    const { sessionId } = started;
    await expectError(() => started.client.forkSession(sessionId), -32003, "session/fork gated");
    await expectError(() => started.client.listSessions(), -32003, "session/list gated");
    await expectError(
      () => started.client.respondQuestion({ sessionId, questionId: "q_x", answers: [] }),
      -32003,
      "question/respond gated",
    );
    await expectError(
      () =>
        started.client.respondApproval({
          sessionId,
          approvalId: "ap_x",
          decision: "allow_once",
          amendedInput: { command: "true" },
        }),
      -32003,
      "amendedInput gated",
    );
    await expectError(
      () => started.client.respondApproval({ sessionId, approvalId: "ap_x", decision: "deny" }),
      -32007,
      "no approval ids exist over this wire",
    );
    await expectError(
      () => started.client.resumeSession({ sessionId }),
      -32004,
      "no replay log over this wire",
    );
    await expectError(
      () => started.client.resumeSession({ sessionId, since: 3 }),
      -32003,
      "since is gated by replay:false",
    );
    await expectError(
      () => started.client.prompt("s_does_not_exist", "hi"),
      -32001,
      "unknown session is not auto-created",
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
      "turn/started must claim the receipt the shell holds",
    );

    const completed = ofType(events, "turn/completed")[0] as unknown as { turn: number; stopReason: string };
    assert.equal(completed.stopReason, "end_turn");
    assert.deepEqual(ofType(events, "turn/completed").length, ofType(events, "turn/started").length);

    assertDenseSeq(events, "one full turn");
  } finally {
    started.close();
  }
});

test("tool calls translate with parsed input and completed results", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "tool ls -la");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const startedTool = ofType(events, "tool/started")[0] as unknown as { callId: string; name: string; input: unknown };
    assert.equal(startedTool.name, "shell");
    assert.deepEqual(startedTool.input, { command: "ls -la" }, "the raw DSH arguments JSON is decoded");

    const completedTool = ofType(events, "tool/completed")[0] as unknown as { callId: string; status: string; output: string };
    assert.equal(completedTool.status, "success");
    assert.equal(completedTool.output, "ran: ls -la");
    assert.equal(completedTool.callId, startedTool.callId);

    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("tool/started") < types.indexOf("tool/completed"), "tool lifecycle order");
    assert.ok(types.indexOf("tool/completed") < types.indexOf("turn/completed"), "tools close before settlement");
  } finally {
    started.close();
  }
});

test("a failed tool carries the failure facts", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "toolerror");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const completed = ofType(events, "tool/completed")[0] as unknown as { status: string; output: string };
    assert.equal(completed.status, "error");
    assert.match(completed.output, /EXIT_1/, "the DSH failure code reaches the shell");
    assert.match(completed.output, /exit code 1/, "the user-facing reason reaches the shell");
  } finally {
    started.close();
  }
});

test("reasoning and usage are synthesized from the settled stream", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "reasoning think hard");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const reasoning = ofType(events, "reasoning/delta")[0] as unknown as { text: string; turn: number };
    assert.equal(reasoning.text, "considering: think hard");
    const text = ofType(events, "message/delta")[0] as unknown as { text: string };
    assert.equal(text.text, "think hard");
    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("reasoning/delta") < types.indexOf("message/delta"), "reasoning precedes the answer");
  } finally {
    started.close();
  }

  const second = await startWithSession();
  try {
    const { client, events, sessionId } = second;
    await client.prompt(sessionId, "usage");
    await waitFor(events, (list) => list.some((event) => event.type === "usage/updated"), "usage");
    const usage = ofType(events, "usage/updated")[0] as unknown as { usage: { inputTokens: number; cachedTokens?: number } };
    assert.equal(usage.usage.inputTokens, 1234);
    assert.equal(usage.usage.cachedTokens, 100, "DSH cacheReadTokens maps to cachedTokens");
  } finally {
    second.close();
  }
});

test("subagent notifications map onto the parent session", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "subagent");
    await waitFor(events, (list) => list.some((event) => event.type === "subagent/finished"), "the subagent to finish");

    const child = ofType(events, "subagent/started")[0] as unknown as { childSessionId: string };
    assert.equal(child.childSessionId, "dsh_child_1");
    const finished = ofType(events, "subagent/finished")[0] as unknown as {
      childSessionId: string;
      status: string;
      summary?: string;
    };
    assert.equal(finished.status, "success");
    assert.equal(finished.summary, "child done");
    assert.equal(events[0]?.sessionId, sessionId, "subagent events ride the parent session");
  } finally {
    started.close();
  }
});

test("compaction maps to compaction/performed with the right trigger", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "compact");
    await waitFor(events, (list) => list.some((event) => event.type === "compaction/performed"), "compaction");

    const performed = ofType(events, "compaction/performed")[0] as unknown as {
      trigger: string;
      preTokens?: number;
    };
    assert.equal(performed.trigger, "auto", "pressure/overflow compaction is automatic");
    assert.equal(performed.preTokens, 90_000, "shadowedTokenCount is the pre-compaction size");
  } finally {
    started.close();
  }

  const manual = await startWithSession();
  try {
    const { client, events, sessionId } = manual;
    await client.prompt(sessionId, "compact-manual");
    await waitFor(events, (list) => list.some((event) => event.type === "compaction/performed"), "compaction");
    const performed = ofType(events, "compaction/performed")[0] as unknown as { trigger: string };
    assert.equal(performed.trigger, "manual", "a command-driven compaction is manual");
  } finally {
    manual.close();
  }
});

test("events for sessions the adapter did not create are dropped", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "foreign");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    await waitFor(events, (list) => list.at(-1)?.type === "session/status", "idle");

    for (const event of events) {
      assert.equal(event.sessionId, sessionId, "every event belongs to the ARI session");
      assert.ok(!JSON.stringify(event).includes("stray"), "foreign content never reaches the shell");
    }
    assertDenseSeq(events, "foreign events must not punch holes in seq");
  } finally {
    started.close();
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
    assert.match(diagnostic.error.message, /PROVIDER/, "the DSH failure code is preserved");
  } finally {
    started.close();
  }
});

test("blocked and max-tokens turns map to their ARI stop reasons", async () => {
  const blocked = await startWithSession();
  try {
    const { client, events, sessionId } = blocked;
    await client.prompt(sessionId, "blocked");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const completed = ofType(events, "turn/completed")[0] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "refusal", "a runtime-blocked turn is a refusal");
    assert.equal(ofType(events, "session/error").length, 0, "a refusal is not an error");
  } finally {
    blocked.close();
  }

  const capped = await startWithSession();
  try {
    const { client, events, sessionId } = capped;
    await client.prompt(sessionId, "maxtokens");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");
    const completed = ofType(events, "turn/completed")[0] as unknown as { stopReason: string };
    assert.equal(completed.stopReason, "max_tokens");
  } finally {
    capped.close();
  }
});

// ── cancellation and the queue ──────────────────────────────────────────

test("cancel kills the runtime, settles cancelled, reports dropped, and stays usable", async () => {
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

    // The runtime process is gone; the next prompt must transparently start a
    // fresh generation and keep the ARI session (and its turn numbering) alive.
    await client.prompt(sessionId, "hello again");
    await waitFor(
      events,
      (list) => ofType(list, "turn/completed").length === 2,
      "the post-restart turn to settle",
    );
    const secondTurn = ofType(events, "turn/completed")[1] as unknown as { turn: number; stopReason: string };
    assert.equal(secondTurn.turn, 2, "turn numbering continues across the runtime restart");
    assert.equal(secondTurn.stopReason, "end_turn");
    assertDenseSeq(events, "the restart must not disturb seq");
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

// ── frame discipline ────────────────────────────────────────────────────

test("oversized tool output streams as deltas and every frame stays under 1 MiB", async () => {
  const started = await startWithSession();
  try {
    const { client, events, sessionId } = started;
    await client.prompt(sessionId, "bigoutput");
    await waitFor(events, (list) => list.some((event) => event.type === "turn/completed"), "the turn to settle");

    const deltas = ofType(events, "tool/updated") as unknown as { outputDelta: string }[];
    assert.ok(deltas.length >= 2, "a 300 KiB result must stream in more than one delta");
    const streamed = deltas.map((delta) => delta.outputDelta).join("");
    assert.equal(streamed.length, 300_000, "the deltas carry the whole output");

    const completed = ofType(events, "tool/completed")[0] as unknown as { output: string };
    assert.match(completed.output, /streamed in deltas/, "the completion carries a summary, not the payload");

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

test("the reference shell drives DSH (via the adapter) without knowing what it is", { timeout: 20_000 }, async () => {
  const { code, stdout } = await runShell([
    "--prompt",
    "tool ls -la",
    "--",
    "node",
    ADAPTER,
    "--dsh",
    "node",
    FAKE,
  ]);

  assert.equal(code, 0, "a one-shot run must exit cleanly");
  assert.match(stdout, /⚙ shell|shell/, "the tool call is rendered");
  assert.match(stdout, /ran: ls -la/, "the tool output reaches the user");
  assert.ok(!stdout.includes("dsh"), "the shell output names no harness");
});

// ── pure translation units ──────────────────────────────────────────────

test("mapTurnEndReason covers the DSH vocabulary and refuses to guess", () => {
  assert.deepEqual(mapTurnEndReason({ kind: "completed" }), { stopReason: "end_turn" });
  assert.deepEqual(mapTurnEndReason({ kind: "max-tokens" }), { stopReason: "max_tokens" });
  assert.deepEqual(mapTurnEndReason({ kind: "aborted", reason: { kind: "user" } }), { stopReason: "cancelled" });
  assert.deepEqual(mapTurnEndReason({ kind: "interrupted" }), { stopReason: "cancelled" });
  assert.deepEqual(mapTurnEndReason({ kind: "blocked" }), { stopReason: "refusal" });
  assert.deepEqual(mapTurnEndReason({ kind: "forked" }), { stopReason: "end_turn" });

  const failed = mapTurnEndReason({ kind: "error", error: { message: "boom", code: "RATE" } });
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.error?.code, -32603);
  assert.match(failed.error?.message ?? "", /RATE: boom/, "the provider facts survive the mapping");

  const unknown = mapTurnEndReason({ kind: "something-new" });
  assert.equal(unknown.stopReason, "error", "an unknown reason must not silently claim success");
  assert.match(unknown.error?.message ?? "", /something-new/);
});

test("expandAssistantStream falls back to assembled content when records are missing", () => {
  const fromRecords = expandAssistantStream(
    [
      { type: "reasoning-chunks", time0: 0, index: 0, dt: [1], texts: ["hmm"] },
      { type: "text-chunks", time0: 1, index: 0, dt: [1], texts: ["he", "llo"] },
      { type: "tool-call-chunks", time0: 2, index: 0, dt: [1], id: "t_1", args: ["{}"] },
    ],
    [],
  );
  assert.deepEqual(fromRecords, { reasoningDeltas: ["hmm"], textDeltas: ["he", "llo"] });

  const fromContent = expandAssistantStream(undefined, [
    { type: "text", text: "fallback text" },
    { type: "image", attachment: "x" },
  ]);
  assert.deepEqual(fromContent, { reasoningDeltas: [], textDeltas: ["fallback text"] });
});

test("mapToolInput keeps unparseable arguments as raw text", () => {
  assert.deepEqual(mapToolInput('{"command":"ls"}'), { command: "ls" });
  assert.equal(mapToolInput("{oops"), "{oops");
  assert.equal(mapToolInput(undefined), undefined);
});

test("mapToolResult joins text, appends failures, and passes meta through", () => {
  const success = mapToolResult({
    message: { toolCallId: "t_1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    meta: { diff: "@@ -1 +1 @@" },
  });
  assert.equal(success.status, "success");
  assert.equal(success.output, "a\nb");
  assert.deepEqual(success.meta, { diff: "@@ -1 +1 @@" });

  const failed = mapToolResult({
    message: { toolCallId: "t_2", isError: true, content: [] },
    error: { name: "ShellError", code: "EXIT_2", reason: "no such file" },
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.output, "EXIT_2: no such file");
});

test("mapUsage renames DSH fields and drops what it cannot read", () => {
  assert.deepEqual(mapUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }), {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 3,
  });
  assert.equal(mapUsage({ inputTokens: 10 }), undefined, "outputTokens is mandatory");
  assert.equal(mapUsage("junk"), undefined);
});
