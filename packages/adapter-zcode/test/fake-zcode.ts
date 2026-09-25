/**
 * fake-zcode — a ZCode Protocol V4 wire-protocol test double.
 *
 * This file deliberately does **not** use any ARI library: it is the other end
 * of the adapter, speaking the ZCode Agent CLI wire exactly as the upstream
 * stdio carrier defines it (newline-delimited JSON-RPC-*shaped* frames with no
 * `jsonrpc` member; `v4/command` requests answering `CommandAck`s;
 * `v4/conversation/subscribe` answering an ACK-only result with the initial
 * snapshot delivered as post-response `v4/conversation/frame` notifications;
 * conversation state as Row/Delta/StatePatch projections). It exists so the
 * adapter can be exercised — and judged by the conformance suite — without a
 * ZCode install, the same way `mock-harness` serves the conformance suite
 * directly.
 *
 * Faithful wire behaviours worth keeping exact:
 *  - `sendText` for an idle session emits the `turnHeader` (running) row and
 *    the user-input row **before** the ack response is written. Upstream the
 *    admission ACK explicitly does not wait for TurnStarted, and the CLI
 *    funnels responses and projection frames through one outbound queue — the
 *    ordering the adapter's notification gate exists for.
 *  - Approvals and questions are **data**: they appear as
 *    `state.updated {pendingInteractions}` patches and are answered through
 *    the `resolveInteraction` command (first-come-first-served; a late one is
 *    a `noop` ack, not an error).
 *  - `stop` settles the open turn by upserting its header to
 *    `completedInterrupted` — the same row transition a natural completion
 *    uses — and any pending interaction vanishes in the next
 *    `pendingInteractions` patch.
 *  - Physical frames fragment when they exceed the max frame bytes: the
 *    logical frame is UTF-8 byte-split, base64-wrapped, and crc32-stamped
 *    (`wireVersion`, `kind:"fragment"`, fragmentIndex/Count, logicalBytes),
 *    exactly the upstream `TopicWireFrame` shape.
 *  - A snapshot's rows are history: subscribing to a forked child delivers
 *    the copied conversation rows in the initial frame, settled.
 *  - The legacy interaction reverse requests (`interaction/*`) still occur on
 *    a real CLI; the double sends one for the `foreign` prompt and asserts by
 *    stderr complaint that the adapter never answers it.
 *  - Session creation **blocks on the legacy `session/requestRuntimePreferences`
 *    reverse request**, exactly as the real CLI blocks runtime creation on it
 *    (and only self-falls-back on "method not found"/"no client" — a timeout
 *    is a hard failure there). The double withholds the `createSession` ack
 *    until the adapter answers the request, so every session-creating test
 *    exercises this path; answering an *interaction* reverse request remains
 *    a stderr-flagged adapter bug.
 *  - Session ids, turn ids, row ids, tool call ids, and interaction ids are
 *    opaque; rows carry `entityId` (fork targeting needs it).
 *
 * Behaviour is keyword-driven on the prompt text (same spirit as
 * `mock-harness`):
 *
 *   echo <text>    plain reply (default for anything unknown)
 *   reasoning <t>  reasoning row streaming deltas, then a reply
 *   tool <cmd>     toolCall row: inputStreaming → running → output delta → success
 *   toolfail       toolCall row ending error (error.code/message)
 *   toolcancel     toolCall row ending cancelled
 *   mcp            toolCall row with a structured input and text output
 *   bigoutput      tool output streamed as ~700 KiB of deltas (forces wire
 *                  fragmentation at the fake's 256 KiB physical cap)
 *   usage          state.updated usage patch (cumulative counters)
 *   approval       toolCall + permission pendingInteraction; decision-driven
 *                  (the `approve` alias drives the same path)
 *   question       AskUserQuestion-shaped userInput interaction; the answer
 *                  is echoed back
 *   questiontext   free-text userInput interaction; the text is echoed back
 *   vanishing      a permission interaction that auto-resolves unanswered
 *   subagent       subagent row bracket with a childSessionId
 *   compact        timelineMarker row (compact success)
 *   retryerror     control.apiRetry patches, then completes (SPEC §8-I4)
 *   fail           control.lastError patch, then the header settles failed
 *   removed        starts a tool, then row.removed erases the branch
 *   coalesced      emits a whole settled bracket as appends (no upserts)
 *   foreign        a frame for an unknown session + a legacy reverse request
 *   failack        the sendText command is rejected (proto guard)
 *   slow [ms]      hold the turn open (default 10000 ms)
 *
 * Usage: node packages/adapter-zcode/test/fake-zcode.ts
 */

import { createHash } from "node:crypto";

/** The fake's physical frame cap (the real limit is 1 MiB; scaled for tests). */
const MAX_FRAME_BYTES = 256 * 1024;

interface FakeSession {
  id: string;
  workspaceId: string;
  logEpoch: string;
  revision: number;
  rowId: number;
  turnCount: number;
  openTurn: { turnId: string; headerRowId: number; aborted: boolean } | null;
  pendingInteraction: {
    interactionId: string;
    kind: "permission" | "userInput";
    resolve: (answer: Record<string, unknown>) => void;
  } | null;
  rows: Record<string, unknown>[];
  subscriber: { subscriptionId: string } | null;
}

const sessions = new Map<string, FakeSession>();
let nextSessionId = 1;
let nextRowId = 1;
let nextTurnId = 1;
let nextInteractionId = 1;
let nextFrameOrdinal = 1;
let nextReverseRequestId = 1;
const ackedByInteraction = new Set<string>();
/** Reverse requests awaiting the client's response frame (preferences only). */
const pendingReverseRequests = new Map<string, () => void>();

function newSession(workspaceId: string): FakeSession {
  const session: FakeSession = {
    id: `sess_${String(nextSessionId++).padStart(4, "0")}`,
    workspaceId,
    logEpoch: `epoch_${String(nextSessionId).padStart(4, "0")}`,
    revision: 0,
    rowId: 0,
    turnCount: 0,
    openTurn: null,
    pendingInteraction: null,
    rows: [],
    subscriber: null,
  };
  sessions.set(session.id, session);
  return session;
}

function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: unknown, result: unknown): void {
  writeFrame({ id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  writeFrame({ id, error: { code, message } });
}

function log(message: string): void {
  process.stderr.write(`[fake-zcode] ${message}\n`);
}

function crc32(bytes: Buffer): string {
  // Match the upstream checksum field shape (crc32, hex) — the value is not
  // verified by the adapter, but the field must be present and shaped.
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * Encode one logical topic frame into physical wire frames and send it as the
 * `v4/conversation/frame` notification the real gateway emits (the wire frame
 * rides in `params`). Complete when it fits, byte-fragmented + base64 + crc32
 * when it does not (the upstream `encodeTopicWireFrames` shape, scaled to the
 * fake's cap).
 */
function emitFrame(session: FakeSession, deliveryKind: "initial" | "online", payload: unknown): void {
  const frame = {
    topic: `conversation/${session.id}`,
    subscriptionId: session.subscriber?.subscriptionId ?? "sub_none",
    fromSeq: 0,
    toSeq: nextFrameOrdinal,
    sentAt: Date.now(),
    payload,
  };
  const wireBase = {
    wireVersion: 3,
    deliveryKind,
    logicalFrameId: `lf_${nextFrameOrdinal++}`,
    logicalFrameOrdinal: nextFrameOrdinal,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
  };
  const logical = Buffer.from(JSON.stringify(frame), "utf8");
  if (logical.byteLength <= MAX_FRAME_BYTES) {
    writeFrame({ method: "v4/conversation/frame", params: { ...wireBase, kind: "complete", frame } });
    return;
  }
  const fragmentCount = Math.ceil(logical.byteLength / MAX_FRAME_BYTES);
  const checksum = { algorithm: "crc32" as const, value: crc32(logical) };
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const slice = logical.subarray(fragmentIndex * MAX_FRAME_BYTES, (fragmentIndex + 1) * MAX_FRAME_BYTES);
    writeFrame({
      method: "v4/conversation/frame",
      params: {
        ...wireBase,
        kind: "fragment",
        fragmentIndex,
        fragmentCount,
        logicalBytes: logical.byteLength,
        checksum,
        dataBase64: slice.toString("base64"),
      },
    });
  }
}

function emitSnapshot(session: FakeSession): void {
  emitFrame(session, "initial", {
    kind: "snapshot",
    snapshot: {
      protocolVersion: 1,
      sessionId: session.id,
      logEpoch: session.logEpoch,
      seq: nextFrameOrdinal,
      revision: session.revision,
      control: {
        phase: session.openTurn !== null ? "running" : "completedSuccess",
        sessionEnded: false,
        canStop: session.openTurn !== null,
        stopState: session.openTurn !== null ? "stoppable" : "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
        lastError: null,
        apiRetry: null,
      },
      availability: {},
      inputRouting: { mode: "startNow" },
      meta: { title: "", titleSource: "default" },
      config: { mode: "build" },
      modelTransition: null,
      usage: {
        contextWindow: null,
        cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      queue: { items: [], autoDrain: true },
      pendingInteractions: [],
      pendingCommands: [],
      backgroundWorks: [],
      goal: null,
      plan: null,
      workspaceHookAdmission: null,
      rows: { window: session.rows, totalCount: session.rows.length, firstRowId: session.rows[0]?.rowId ?? null },
    },
  });
}

function emitDeltas(session: FakeSession, deltas: Record<string, unknown>[]): void {
  if (deltas.length === 0) return;
  // Every projection commit publishes its new revision as a trailing patch —
  // the invariant that makes baseRevision CAS knowable from the stream.
  session.revision += 1;
  emitFrame(session, "online", {
    kind: "deltas",
    deltas: [...deltas, { op: "state.updated", patch: { revision: session.revision } }],
  });
}

function rowAppended(session: FakeSession, row: Record<string, unknown>): void {
  session.rowId += 1;
  const full = { rowId: session.rowId, turnId: `turn_${session.turnCount}`, entityId: `ent_${session.rowId}`, createdAt: Date.now(), createdAtSeq: nextFrameOrdinal, ...row };
  session.rows.push(full);
  emitDeltas(session, [{ op: "row.appended", row: full }]);
}

function rowUpserted(session: FakeSession, rowId: number, patch: Record<string, unknown>): void {
  const index = session.rows.findIndex((row) => row.rowId === rowId);
  if (index < 0) return;
  const updated = { ...session.rows[index], ...patch };
  session.rows[index] = updated;
  emitDeltas(session, [{ op: "row.upserted", row: updated }]);
}

function statePatched(session: FakeSession, patch: Record<string, unknown>): void {
  emitDeltas(session, [{ op: "state.updated", patch }]);
}

function rowBase(session: FakeSession): Record<string, unknown> {
  return { turnId: `turn_${session.turnCount}` };
}

function makeHeader(session: FakeSession, state: string): Record<string, unknown> {
  return {
    ...rowBase(session),
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state,
    startedAt: Date.now(),
    ...(state === "running" ? {} : { endedAt: Date.now() }),
  };
}

// ── the agent loop, faked ────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait out an in-flight turn body's abort, then settle it interrupted. */
async function abortableSleep(session: FakeSession, ms: number): Promise<void> {
  const step = 20;
  for (let waited = 0; waited < ms; waited += step) {
    if (session.openTurn?.aborted === true) return;
    await sleep(step);
  }
}

/** Ask a pendingInteraction and wait for the client's resolveInteraction. */
function requestInteraction(
  session: FakeSession,
  kind: "permission" | "userInput",
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const interactionId = `int_${nextInteractionId++}`;
    session.pendingInteraction = { interactionId, kind, resolve };
    statePatched(session, {
      pendingInteractions: [
        { interactionId, kind, anchorRowId: null, createdAt: Date.now(), payload },
      ],
    });
  });
}

/** Remove the interaction from the projection once it is answered or gone. */
function clearInteraction(session: FakeSession): void {
  statePatched(session, { pendingInteractions: [] });
}

function rowDelta(session: FakeSession, rowId: number, path: string, append: string): void {
  emitDeltas(session, [{ op: "row.delta", rowId, path, append }]);
}

/** Stream text into a row: append deltas while streaming, then settle whole. */
async function streamTextRow(
  session: FakeSession,
  kind: "assistantText" | "reasoning",
  text: string,
): Promise<void> {
  rowAppended(session, { ...rowBase(session), kind, text: "", state: "streaming" });
  const rowId = session.rowId;
  const first = Math.ceil(text.length / 2);
  rowDelta(session, rowId, "text", text.slice(0, first));
  rowDelta(session, rowId, "text", text.slice(first));
  rowUpserted(session, rowId, { text, state: kind === "reasoning" ? "complete" : "complete" });
}

async function runTurnBody(session: FakeSession, text: string): Promise<void> {
  const [command = "", ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");

  switch (command) {
    case "reasoning": {
      await streamTextRow(session, "reasoning", `considering: ${arg}`);
      await streamTextRow(session, "assistantText", arg);
      return;
    }
    case "tool": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "toolCall",
        toolCallId: `call_${session.rowId + 1}`,
        toolName: "Bash",
        status: "inputStreaming",
        inputText: arg || "ls",
        output: null,
      });
      const callId = `call_${session.rowId}`;
      const rowId = session.rowId;
      rowUpserted(session, rowId, { status: "running" });
      rowDelta(session, rowId, "output.text", `ran: ${arg || "ls"}`);
      rowUpserted(session, rowId, {
        status: "success",
        output: { text: `ran: ${arg || "ls"}` },
        endedAt: Date.now(),
      });
      void callId;
      await streamTextRow(session, "assistantText", "tool finished");
      return;
    }
    case "toolfail": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "toolCall",
        toolCallId: `call_${session.rowId + 1}`,
        toolName: "Bash",
        status: "running",
        inputText: "false",
        output: null,
      });
      rowUpserted(session, session.rowId, {
        status: "error",
        error: { code: "tool.exit", message: "command not found" },
        output: { text: "command not found" },
        endedAt: Date.now(),
      });
      await streamTextRow(session, "assistantText", "the tool failed");
      return;
    }
    case "toolcancel": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "toolCall",
        toolCallId: `call_${session.rowId + 1}`,
        toolName: "Bash",
        status: "running",
        inputText: "sleep 100",
        output: null,
      });
      rowUpserted(session, session.rowId, {
        status: "cancelled",
        output: { text: "" },
        endedAt: Date.now(),
      });
      await streamTextRow(session, "assistantText", "cancelled");
      return;
    }
    case "mcp": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "toolCall",
        toolCallId: `call_${session.rowId + 1}`,
        toolName: "mcp__fs__read_file",
        status: "running",
        input: { path: "README.md" },
        output: null,
      });
      rowUpserted(session, session.rowId, {
        status: "success",
        output: { text: "file contents here" },
        endedAt: Date.now(),
      });
      await streamTextRow(session, "assistantText", "mcp tool finished");
      return;
    }
    case "bigoutput": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "toolCall",
        toolCallId: `call_${session.rowId + 1}`,
        toolName: "Bash",
        status: "running",
        inputText: "yes",
        output: null,
      });
      const rowId = session.rowId;
      const chunk = "x".repeat(120_000);
      for (let i = 0; i < 6; i += 1) {
        rowDelta(session, rowId, "output.text", chunk);
        if (session.openTurn?.aborted === true) return;
      }
      rowUpserted(session, rowId, {
        status: "success",
        output: { text: "x".repeat(720_000) },
        endedAt: Date.now(),
      });
      await streamTextRow(session, "assistantText", "big output streamed");
      return;
    }
    case "usage": {
      statePatched(session, {
        usage: {
          contextWindow: { usedTokens: 1300, maxTokens: 272_000, autoCompactThresholdTokens: null },
          cumulative: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 100, cacheWriteTokens: 0 },
        },
      });
      await streamTextRow(session, "assistantText", "counted");
      return;
    }
    case "approval":
    case "approve": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "toolCall",
        toolCallId: `call_${session.rowId + 1}`,
        toolName: "Bash",
        status: "running",
        inputText: arg || "yes",
        output: null,
      });
      const toolRowId = session.rowId;
      const answer = await requestInteraction(session, "permission", {
        kind: "permission",
        toolCallId: `call_${toolRowId}`,
        toolName: "Bash",
        summary: "the command wants to run",
        options: [
          { optionId: "opt_once", label: "Allow once", kind: "allowOnce" },
          { optionId: "opt_always", label: "Allow always", kind: "allowAlways" },
          { optionId: "opt_deny", label: "Deny", kind: "deny" },
        ],
      });
      if (session.openTurn?.aborted === true) return;
      clearInteraction(session);
      const optionId = typeof answer["optionId"] === "string" ? answer["optionId"] : "";
      const accepted = optionId === "opt_once" || optionId === "opt_always";
      rowUpserted(session, toolRowId, {
        status: accepted ? "success" : "error",
        output: { text: accepted ? "ran under supervision" : "" },
        endedAt: Date.now(),
      });
      await streamTextRow(session, "assistantText", accepted ? "approved and ran" : "declined");
      return;
    }
    case "question": {
      const answer = await requestInteraction(session, "userInput", {
        kind: "userInput",
        prompt: "Pick one",
        freeText: false,
        toolName: "AskUserQuestion",
        questions: [
          {
            question: "Which option do you want?",
            header: "Choice",
            options: [
              { value: "A", label: "A label", description: "the first option" },
              { value: "B", label: "B label", description: "the second option" },
            ],
            multiSelect: false,
          },
        ],
      });
      if (session.openTurn?.aborted === true) return;
      clearInteraction(session);
      const content = (answer["content"] ?? {}) as { answers?: Record<string, string> };
      const chosen = content.answers?.["Which option do you want?"] ?? "(declined)";
      await streamTextRow(session, "assistantText", `you chose ${chosen}`);
      return;
    }
    case "questiontext": {
      const answer = await requestInteraction(session, "userInput", {
        kind: "userInput",
        prompt: "Say something",
        freeText: true,
      });
      if (session.openTurn?.aborted === true) return;
      clearInteraction(session);
      const freeText = typeof answer["freeText"] === "string" ? answer["freeText"] : "(declined)";
      await streamTextRow(session, "assistantText", `you said ${freeText}`);
      return;
    }
    case "vanishing": {
      const interaction = requestInteraction(session, "permission", {
        kind: "permission",
        toolCallId: "call_vanishing",
        toolName: "Bash",
        summary: "auto-resolves unanswered",
        options: [{ optionId: "opt_once", label: "Allow once", kind: "allowOnce" }],
      });
      await sleep(150);
      const pending = session.pendingInteraction;
      session.pendingInteraction = null;
      clearInteraction(session);
      // The broker times the interaction out on its own; nobody resolves it.
      pending.resolve({});
      await streamTextRow(session, "assistantText", "the ask vanished");
      await interaction;
      return;
    }
    case "subagent": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "subagent",
        parentToolCallId: `call_${session.rowId + 1}`,
        subagentType: "Explore",
        status: "running",
        summaryText: "",
        childSessionId: "sess_child_0001",
      });
      const rowId = session.rowId;
      rowUpserted(session, rowId, {
        status: "success",
        summaryText: "explored the repo",
        endedAt: Date.now(),
      });
      await streamTextRow(session, "assistantText", "delegated");
      return;
    }
    case "compact": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "timelineMarker",
        marker: { type: "compact", origin: "auto", status: "success", tokensBefore: 100_000, tokensAfter: 20_000 },
      });
      await streamTextRow(session, "assistantText", "compacted");
      return;
    }
    case "retryerror": {
      statePatched(session, {
        control: {
          phase: "running",
          sessionEnded: false,
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "assistant",
          activeWorks: [],
          lastError: null,
          apiRetry: { attempt: 1, maxAttempts: 3, nextRetryAt: Date.now() + 100, reasonCode: "provider_busy" },
        },
      });
      await sleep(60);
      statePatched(session, {
        control: {
          phase: "running",
          sessionEnded: false,
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "assistant",
          activeWorks: [],
          lastError: null,
          apiRetry: null,
        },
      });
      await streamTextRow(session, "assistantText", "recovered");
      return;
    }
    case "fail": {
      statePatched(session, {
        control: {
          phase: "running",
          sessionEnded: false,
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "assistant",
          activeWorks: [],
          lastError: { code: "fault.provider", message: "RATE: provider exploded", recoverable: false, at: Date.now(), source: "provider" },
          apiRetry: null,
        },
      });
      // Throwing settles the header as failed (the caller's catch path).
      throw new Error("RATE: provider exploded");
    }
    case "removed": {
      rowAppended(session, {
        ...rowBase(session),
        kind: "toolCall",
        toolCallId: `call_${session.rowId + 1}`,
        toolName: "Bash",
        status: "running",
        inputText: "doomed",
        output: null,
      });
      const doomedRowId = session.rowId;
      emitDeltas(session, [{ op: "row.removed", fromRowId: doomedRowId }]);
      session.rows = session.rows.filter((row) => row.rowId < doomedRowId);
      await streamTextRow(session, "assistantText", "branch rewritten");
      return;
    }
    case "coalesced": {
      // A whole settled bracket arrives as appends (the coalescer collapsed
      // every upsert, including the running header): the header is already
      // terminal when the adapter first sees it.
      session.turnCount += 1;
      session.rows.push({
        rowId: ++session.rowId,
        turnId: `turn_${session.turnCount}`,
        entityId: `ent_${session.rowId}`,
        createdAt: Date.now(),
        createdAtSeq: nextFrameOrdinal,
        kind: "assistantText",
        text: "coalesced reply",
        state: "complete",
      });
      session.rows.push({
        rowId: ++session.rowId,
        turnId: `turn_${session.turnCount}`,
        entityId: `ent_${session.rowId}`,
        createdAt: Date.now(),
        createdAtSeq: nextFrameOrdinal,
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
      emitDeltas(
        session,
        session.rows.slice(-2).map((row) => ({ op: "row.appended", row })),
      );
      return;
    }
    case "foreign": {
      // A frame for a session the adapter never created, plus the legacy
      // reverse request a real CLI still sends — both must be dropped, and
      // the reverse request must never be answered.
      emitFrame(
        { ...session, id: "sess_foreign_never_created", subscriber: null },
        "online",
        { kind: "deltas", deltas: [] },
      );
      writeFrame({ id: "srv_legacy_1", method: "interaction/requestPermission", params: { requestId: "legacy" } });
      setTimeout(() => {
        log("legacy reverse request was never answered (correct)");
      }, 300);
      await streamTextRow(session, "assistantText", "foreign noise ignored");
      return;
    }
    case "slow": {
      await abortableSleep(session, Number(arg) || 10_000);
      if (session.openTurn?.aborted === true) return;
      await streamTextRow(session, "assistantText", "finally woke");
      return;
    }
    default: {
      await streamTextRow(session, "assistantText", text === "" ? "(empty prompt)" : text);
      return;
    }
  }
}

/** Settle the open turn; a no-op when the turn was already settled. */
function endTurn(session: FakeSession, state: string): void {
  const open = session.openTurn;
  if (open === null) return;
  session.openTurn = null;
  rowUpserted(session, open.headerRowId, { state, endedAt: Date.now() });
}

function startTurn(session: FakeSession): void {
  session.turnCount += 1;
  rowAppended(session, makeHeader(session, "running"));
  const headerRowId = session.rowId;
  session.openTurn = { turnId: `turn_${session.turnCount}`, headerRowId, aborted: false };
}

// ── the ZCode wire server ────────────────────────────────────────────────

function handleRequest(method: string, params: Record<string, unknown>, id: unknown): void {
  switch (method) {
    case "v4/command": {
      const type = String(params["type"] ?? "");
      const payload = (params["payload"] ?? {}) as Record<string, unknown>;
      const commandId = String(params["commandId"] ?? "");
      const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : null;
      switch (type) {
        case "createSession": {
          const session = newSession(String(payload["workspaceId"] ?? "/repo"));
          log(`createSession -> ${session.id}`);
          // Faithful: runtime creation blocks on the legacy preferences
          // reverse request; the CLI only self-falls-back on "method not
          // found"/"no client", not on a timeout — so the adapter must
          // answer it for session/new to work at all.
          const requestId = `srv_${nextReverseRequestId++}`;
          writeFrame({
            id: requestId,
            method: "session/requestRuntimePreferences",
            params: { sessionId: session.id, scope: "runtime-create" },
          });
          const ack = {
            commandId,
            status: "accepted",
            revisionAtDecision: session.revision,
            result: { type: "createSession", sessionId: session.id },
          };
          pendingReverseRequests.set(requestId, () => respond(id, ack));
          return;
        }
        case "sendText": {
          const session = sessions.get(sessionId ?? "");
          if (session === undefined) {
            respond(id, {
              commandId,
              status: "rejected",
              reasonCode: "guard.noRecord",
              message: "unknown session",
              revisionAtDecision: 0,
            });
            return;
          }
          if (String(payload["text"] ?? "") === "failack") {
            respond(id, {
              commandId,
              status: "rejected",
              reasonCode: "proto.invalidPayload",
              message: "input rejected by guard",
              revisionAtDecision: session.revision,
            });
            return;
          }
          if (session.openTurn !== null) {
            // Faithful: upstream steers/queues; the adapter never does this.
            log("sendText while a turn is open (the adapter should have queued)");
            respond(id, {
              commandId,
              status: "accepted",
              revisionAtDecision: session.revision,
              result: { type: "inputAccepted", delivery: "queue", inputId: commandId },
            });
            return;
          }
          const body = String(payload["text"] ?? "");
          const coalesced = body.startsWith("coalesced");
          if (!coalesced) {
            startTurn(session);
            rowAppended(session, { ...rowBase(session), kind: "userInput", origin: "realUser", text: body });
          }
          // Faithful ordering: the projection frames go out BEFORE the ack.
          respond(id, {
            commandId,
            status: "accepted",
            revisionAtDecision: session.revision,
            result: { type: "inputAccepted", delivery: "startNow", inputId: commandId },
          });
          void runTurnBody(session, body)
            .then(() => {
              // A coalesced bracket arrived already settled; nothing to close.
              if (!coalesced) endTurn(session, "completedSuccess");
            })
            .catch((error) => {
              log(`turn body failed: ${String(error)}`);
              endTurn(session, "failed");
            });
          return;
        }
        case "stop": {
          const session = sessions.get(sessionId ?? "");
          if (session === undefined) {
            respond(id, { commandId, status: "rejected", reasonCode: "guard.noRecord", message: "unknown session", revisionAtDecision: 0 });
            return;
          }
          if (session.openTurn !== null) session.openTurn.aborted = true;
          const pending = session.pendingInteraction;
          session.pendingInteraction = null;
          clearInteraction(session);
          if (pending !== null) pending.resolve({});
          endTurn(session, "completedInterrupted");
          respond(id, { commandId, status: "accepted", revisionAtDecision: session.revision });
          return;
        }
        case "resolveInteraction": {
          const session = sessions.get(sessionId ?? "");
          const interactionId = String(payload["interactionId"] ?? "");
          if (session === undefined || session.pendingInteraction?.interactionId !== interactionId) {
            // First-come-first-served; a late resolve is a noop, not an error.
            respond(id, {
              commandId,
              status: ackedByInteraction.has(interactionId) ? "noop" : "rejected",
              reasonCode: "proto.alreadyResolved",
              revisionAtDecision: session?.revision ?? 0,
            });
            return;
          }
          ackedByInteraction.add(interactionId);
          const pending = session.pendingInteraction;
          session.pendingInteraction = null;
          respond(id, {
            commandId,
            status: "accepted",
            revisionAtDecision: session.revision,
            result: { type: "resolveInteraction", resolvedBy: { clientId: String(params["clientId"] ?? "") } },
          });
          pending.resolve((payload["answer"] ?? {}) as Record<string, unknown>);
          return;
        }
        case "forkAssistant": {
          const session = sessions.get(sessionId ?? "");
          const target = payload["target"] as { rowId?: number; entityId?: string } | undefined;
          if (session === undefined || typeof target?.rowId !== "number") {
            respond(id, { commandId, status: "rejected", reasonCode: "guard.noRecord", message: "unknown session", revisionAtDecision: 0 });
            return;
          }
          if (params["baseRevision"] !== session.revision || params["baseLogEpoch"] !== session.logEpoch) {
            respond(id, {
              commandId,
              status: "stale",
              reasonCode: "guard.staleBase",
              message: "base revision is stale",
              revisionAtDecision: session.revision,
            });
            return;
          }
          const source = session.rows.find((row) => row.rowId === target.rowId);
          if (
            source === undefined ||
            source.kind !== "assistantText" ||
            source.entityId !== target.entityId
          ) {
            respond(id, {
              commandId,
              status: "rejected",
              reasonCode: "fault.command.executionFailed",
              message: `forkAssistant targetRowId ${target.rowId} is not a stable assistant row`,
              revisionAtDecision: session.revision,
            });
            return;
          }
          const forked = newSession(session.workspaceId);
          // The fork copies the conversation up to the target row: the child's
          // initial snapshot carries settled history rows.
          forked.rows = session.rows
            .filter((row) => row.rowId <= target.rowId)
            .map((row) => ({ ...row }));
          forked.rowId = forked.rows.length;
          log(`forkAssistant ${session.id} -> ${forked.id}`);
          respond(id, {
            commandId,
            status: "accepted",
            revisionAtDecision: session.revision,
            result: { type: "forkAssistant", sessionId: forked.id },
          });
          return;
        }
        default:
          respond(id, {
            commandId,
            status: "rejected",
            reasonCode: "proto.notImplemented",
            message: `fake-zcode: unknown command ${type}`,
            revisionAtDecision: 0,
          });
          return;
      }
    }
    case "v4/conversation/subscribe": {
      const topic = String(params["topic"] ?? "");
      const sessionId = topic.startsWith("conversation/") ? topic.slice("conversation/".length) : "";
      const session = sessions.get(sessionId);
      if (session === undefined) {
        respondError(id, -32603, `fake-zcode: unknown conversation topic ${topic}`);
        return;
      }
      const subscriptionId = `sub_${session.id}`;
      session.subscriber = { subscriptionId };
      respond(id, { ack: { subscriptionId, mode: "snapshot", logEpoch: session.logEpoch } });
      emitSnapshot(session);
      return;
    }
    case "v4/conversation/unsubscribe": {
      respond(id, {});
      return;
    }
    default:
      respondError(id, -32601, `fake-zcode: unknown method ${method}`);
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
          handleRequest(frame["method"], (frame["params"] ?? {}) as Record<string, unknown>, frame["id"]);
        } else if (typeof frame["method"] === "string") {
          log(`client notification ignored: ${frame["method"]}`);
        } else if (frame["id"] !== undefined) {
          // A response to a legacy reverse request. The preferences request
          // registered a waiter (the adapter must answer it); a response with
          // no waiter means the adapter answered an interaction request —
          // exactly what it must never do.
          const key = String(frame["id"]);
          const deliver = pendingReverseRequests.get(key);
          if (deliver !== undefined) {
            pendingReverseRequests.delete(key);
            deliver();
          } else {
            log(`unexpected client response frame: ${key} (the adapter answered a reverse request!)`);
          }
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
