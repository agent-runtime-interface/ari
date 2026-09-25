/**
 * ZCode → ARI adapter core.
 *
 * Role (see the repository handoff): the adapter is **not** a harness and does
 * not use `AriHarness`. It is a translator — it plays the ARI *server* toward
 * the shell and the ZCode Agent CLI *client* toward the real runtime.
 *
 * What this file owns (state the pure mapper must not know about):
 *
 *  - **Session identity.** ARI session ids **are** ZCode session ids. The
 *    runtime allocates them at `createSession`, so no re-keying table is
 *    needed. Sessions returned by `session/fork` become promptable by
 *    *adoption*: their ids enter the adoptable set, the first prompt
 *    subscribes and creates adapter state for them.
 *  - **The projection is the event source.** The CLI does not stream facts —
 *    it streams conversation *topics*: an initial snapshot frame followed by
 *    delta frames (`row.appended/upserted/removed`, `row.delta`,
 *    `state.updated`). Snapshot rows are **history**: they reconstruct the
 *    adapter's row/turn bookkeeping (and open live work such as a running
 *    turn or a running tool) but emit no events for settled content — a
 *    shell that adopted a session must not see its past replayed as new
 *    deltas. Live deltas reduce into ARI events: `turnHeader` rows are the
 *    turn bracket (`running` → completed*; a header coalesced straight to a
 *    terminal state opens and closes the turn in the same breath),
 *    `assistantText` / `reasoning` rows stream `message/delta` /
 *    `reasoning/delta` via `row.delta` text appends (a settled row that never
 *    streamed is delivered whole — the DSH adapter's synthesized-delta
 *    honesty), `toolCall` rows drive the `tool/*` state machine, `subagent`
 *    rows bracket `subagent/started|finished`, and compact `timelineMarker`
 *    rows become `compaction/performed`.
 *  - **Renumbering.** ARI `seq` (from 1, dense) and `turn` (from 1) are
 *    adapter-assigned; ZCode coordinates (`turnId`, `rowId`, `toolCallId`)
 *    never pass through as such — `toolCallId` rides ARI's opaque `callId`,
 *    and row bookkeeping (kept for fork targeting and branch removal) stays
 *    internal.
 *  - **The notification gate.** Frames for a session can outrun the
 *    `sendText` ack on the CLI's single outbound queue (upstream: the
 *    admission ACK explicitly does not wait for TurnStarted). ARI forbids
 *    that ordering (the response MUST precede any event it caused, SPEC
 *    §7.9). While a prompt forward is outstanding, every inbound frame for
 *    that session is parked in a FIFO; the ack lands, the ARI receipt is
 *    *enqueued on the shared outbound chain*, and only then are the parked
 *    frames processed — the FIFO makes the wire order right even though the
 *    events were built after the receipt.
 *  - **The pending-input queue.** ZCode's own queue has product semantics
 *    (auto-drain pausing, held/choice routing) that ARI 1.0 does not absorb,
 *    so the adapter owns a per-session queue: prompts arriving while a turn
 *    is open are enqueued with a receipt, and the next queued prompt is
 *    forwarded (with `requestedDelivery:"startNow"`) only after the current
 *    turn settles. Each forward carries exactly one message, so
 *    `turn/started.messageIds` attributes exactly the receipt the shell holds
 *    (SPEC §7.3); turns nobody prompted for (background results, goal
 *    continuations) get synthesized ids.
 *  - **Cancellation by command.** ARI `session/cancel` maps to the `stop`
 *    command; the queue is dropped into `droppedMessageIds`, and the runtime's
 *    `completedInterrupted` header settles the turn as `cancelled`. If the
 *    stop itself cannot reach the runtime, the adapter settles locally.
 *  - **Interactions as data.** Approvals and questions hang off the
 *    StatePatch `pendingInteractions[]` (whole-key replacement). New entries
 *    surface as `approval/requested` / `question/requested`; entries answered
 *    by the shell go out as `resolveInteraction` commands; entries that
 *    vanish without the shell's answer (auto-resolution, another client)
 *    resolve as `cancelled` / `expired` and are NOT recorded as shell
 *    decisions (a later answer is -32007, SPEC §10.3). The adapter keeps the
 *    §10.3 idempotency table itself — an upstream late `resolveInteraction`
 *    is a noop, not a distinct answer.
 *  - **Fork through the stable row target.** `session/fork{atTurn}` maps to
 *    the `forkAssistant` command, which targets the *last assistantText row*
 *    of the turn and carries optimistic-concurrency `baseRevision`/
 *    `baseLogEpoch` — the adapter tracks both from the projection it already
 *    reduces.
 *  - **Replay from the ledger.** The adapter records every emitted event per
 *    session. `session/resume{since}` replays that cut (SPEC §7.2) with a
 *    derived snapshot. A `since` beyond the watermark is -32602 (SPEC §7.2).
 *    The ledger lives exactly as long as the adapter process; after a
 *    restart, `session/resume` of a pre-restart session is -32001.
 *  - **Capability honesty.** The declared capability set (translate.ts) is
 *    exactly what the wire can deliver; the emit path additionally drops any
 *    gated event whose capability is `false` (SPEC §5.3).
 */

import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import {
  AriError,
  ariErrors,
  createFrameWriter,
  EVENT_CAPABILITY,
} from "../../ari/src/index.ts";
import type { AgentCapabilities, SessionCancelResult } from "../../ari/src/index.ts";
import { ZcodeClient, type ZcodeChildSpec, type IncomingZcodeRequest } from "./zcode.ts";
import {
  isRecord,
  mapApprovalOptions,
  mapCompactionMarker,
  mapFreeTextAnswerOut,
  mapQuestionAnswerOut,
  mapQuestionOutcome,
  mapQuestionSpecs,
  mapSubagentStatus,
  mapTurnEnd,
  mapUsage,
  permissionOptionIdFor,
  questionIdAt,
  ZCODE_AGENT_CAPABILITIES,
  type ZcodeCommandAck,
  type ZcodeDelta,
  type ZcodeInteraction,
  type ZcodeRow,
  type ZcodeSnapshot,
  type ZcodeStatePatch,
  type ZcodeTopicFrame,
} from "./translate.ts";
import type { AriEventDraft } from "./drafts.ts";

/** How long session/cancel waits for an in-flight prompt forward to land. */
const CANCEL_FORWARD_WAIT_MS = 3_000;

export interface AdapterOptions {
  /** How to start the ZCode CLI (e.g. `zcode app-server --stdio` or the fake). */
  zcode: ZcodeChildSpec;
  /** Working directory handed to the CLI and used as the createSession workspace. */
  cwd?: string;
  /** Pending-input queue limit; prompts beyond it are rejected -32005 (SPEC §7.3). */
  queueLimit?: number;
  /** Declare every capability false and suppress all gated events (conformance aid). */
  minimal?: boolean;
  log?: (message: string) => void;
  /** Called after the write queue drains following a shutdown response. */
  exit?: (code: number) => void;
}

interface QueuedPrompt {
  messageId: string;
  text: string;
}

interface OpenTurn {
  ariTurn: number;
  turnId: string;
  headerRowId: number;
  /** A fatal diagnostic already announced for this turn (SPEC §8-I3). */
  errorAnnounced: boolean;
}

interface TurnRecord {
  turnId: string;
}

interface PendingApprovalState {
  sessionId: string;
  options?: { optionId: string; label: string; kind: string }[];
}

interface PendingQuestionState {
  sessionId: string;
  payload: Extract<ZcodeInteraction["payload"], { kind: "userInput" }>;
}

interface AriSession {
  ariId: string;
  /** Last assigned ARI seq; the next event uses `seq + 1`. */
  seq: number;
  nextTurn: number;
  /** ARI turn → the ZCode turn it mapped to. */
  turns: Map<number, TurnRecord>;
  openTurn?: OpenTurn;
  /** Prompts accepted but not yet claimed, FIFO. */
  queue: QueuedPrompt[];
  /** The receipt whose `sendText` forward is in flight, if any. */
  forwardReceipt?: string;
  /** Outstanding prompt forwards (the notification gate). */
  pendingReceipts: number;
  /** Inbound frames parked while `pendingReceipts > 0`, in arrival order. */
  pendingRaw: ZcodeTopicFrame[];
  /** Resolvers waiting for `pendingReceipts` to reach 0 (session/cancel). */
  forwardWaiters: (() => void)[];
  /** Rows by rowId, for fork targeting and branch-removal handling. */
  rows: Map<number, ZcodeRow>;
  /** Tool callIds with `tool/started` but no `tool/completed`, with their names. */
  openTools: Map<string, { name: string }>;
  /** Last `tool/updated` status emitted per callId (dedupes status upserts). */
  toolStatuses: Map<string, string>;
  /** Tool callIds already observed at all (coalesced-bracket detection). */
  seenTools: Set<string>;
  /** Text chars already streamed per rowId (the coalescer merges the rest). */
  streamedTextLength: Map<number, number>;
  /** Text rows whose settled text has been delivered (upstream re-announces). */
  settledTextRows: Set<number>;
  /** Live `subagent` brackets keyed by ARI callId → rowId. */
  openSubagents: Map<string, number>;
  /** Subagent rowIds already observed at all. */
  seenSubagents: Set<number>;
  /** The pending-interaction ids this session has surfaced. */
  pendingInteractions: Set<string>;
  /** Last api-retry attempt announced (dedupes I4 events per attempt). */
  lastRetryAttempt: number;
  /** Last seen projection revision and log epoch (fork CAS inputs). */
  revision: number;
  logEpoch: string;
  /** Last usage observed, for the resume snapshot. */
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  /** The conversation subscription, once ready to stream. */
  subscriptionReady: boolean;
  /** Every event emitted for this session, in seq order (the ledger). */
  ledger: Record<string, unknown>[];
}

export class ZcodeAriAdapter {
  private readonly options: AdapterOptions;
  private readonly log: (message: string) => void;
  private readonly write: (message: unknown) => Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly clientId: string;

  private initialized = false;
  private shuttingDown = false;

  private zcode: ZcodeClient | undefined;
  private zcodeBoot: Promise<void> | undefined;
  /** Deliberate kill (shutdown) vs an unexpected runtime death. */
  private killingZcode = false;

  private readonly sessions = new Map<string, AriSession>();
  /** Session ids offered by `session/fork`, promptable by adoption. */
  private readonly adoptable = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApprovalState>();
  private readonly resolvedApprovals = new Map<string, PendingApprovalState & { decision: string }>();
  private readonly pendingQuestions = new Map<string, PendingQuestionState>();
  private readonly resolvedQuestions = new Map<string, PendingQuestionState & { answers: unknown }>();

  constructor(options: AdapterOptions, output: Writable) {
    this.options = options;
    this.write = createFrameWriter(output);
    this.log = options.log ?? (() => undefined);
    this.clientId = randomUUID();
  }

  get capabilities(): AgentCapabilities {
    if (this.options.minimal === true) {
      const none: AgentCapabilities = { ...ZCODE_AGENT_CAPABILITIES };
      for (const key of Object.keys(none) as (keyof AgentCapabilities)[]) none[key] = false;
      return none;
    }
    return ZCODE_AGENT_CAPABILITIES;
  }

  // ── write plumbing (single FIFO queue: responses and events share it) ────

  private enqueueWrite(message: unknown): void {
    this.writeChain = this.writeChain
      .then(() => this.write(message))
      .catch((error) => this.log(`write failed: ${String(error)}`));
  }

  private async drainWrites(): Promise<void> {
    await this.writeChain;
  }

  private respond(id: unknown, result: unknown): void {
    this.enqueueWrite({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: unknown, error: AriError): void {
    const body: Record<string, unknown> = { code: error.code, message: error.message };
    if (error.data !== undefined) body["data"] = error.data;
    this.enqueueWrite({ jsonrpc: "2.0", id, error: body });
  }

  // ── event emission ──────────────────────────────────────────────────────

  private emit(session: AriSession, draft: AriEventDraft): void {
    if (this.shuttingDown) return;

    // Capability gating (SPEC §5.3): a capability declared false must never
    // surface its events, even when the upstream vocabulary would deliver one.
    const gated = EVENT_CAPABILITY[draft.type];
    if (gated !== undefined && !this.capabilities[gated]) return;

    // Envelope fields are applied LAST so a payload can never shadow them.
    const seq = session.seq + 1;
    const body: Record<string, unknown> = { ...(draft as Record<string, unknown>), sessionId: session.ariId, seq };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1_048_576) {
      this.log(`dropped event ${draft.type}: exceeds the 1 MiB frame cap`);
      return;
    }

    session.seq = seq;
    session.ledger.push(body);
    this.enqueueWrite({ jsonrpc: "2.0", method: "event", params: body });
  }

  // ── ZCode lifecycle ─────────────────────────────────────────────────────

  /** Spawn (or reuse) the CLI. The stdio carrier has no handshake step. */
  private ensureZcode(): Promise<void> {
    if (this.zcode !== undefined && this.zcodeBoot !== undefined) return this.zcodeBoot;
    this.killingZcode = false;
    const spec = this.options.zcode;
    this.log(`starting ZCode CLI: ${spec.command} ${spec.args.join(" ")}`);

    const client = ZcodeClient.spawn({
      spec,
      cwd: this.options.cwd ?? process.cwd(),
      log: (message) => this.log(message),
      onNotification: (method, params) => this.onZcodeNotification(method, params),
      onServerRequest: (request) => this.onZcodeServerRequest(request),
      onClose: () => this.onZcodeClosed(),
    });
    this.zcode = client;
    // The carrier has no initialize: "booted" means the child actually
    // spawned. A binary that cannot spawn surfaces here (the shell MAY retry
    // initialize) or on the first request.
    this.zcodeBoot = new Promise<void>((resolve, reject) => {
      const child = client.child;
      child.once("spawn", () => resolve());
      child.once("close", () => reject(new Error("ZCode CLI closed before use")));
    }).catch((error) => {
      // Leave the connection uninitialized so the shell MAY retry initialize.
      this.zcode = undefined;
      this.zcodeBoot = undefined;
      throw error;
    });
    return this.zcodeBoot;
  }

  private killZcode(): void {
    if (this.zcode === undefined) return;
    this.killingZcode = true;
    this.zcode.kill();
    this.zcode = undefined;
    this.zcodeBoot = undefined;
  }

  /**
   * The CLI died. A deliberate kill was already settled by the shutdown path;
   * an unexpected death is settled here so no turn stays open (SPEC §8-I1),
   * no interaction stays pending (§8-I7), and no session sticks in `running`
   * (§8-I6).
   */
  private onZcodeClosed(): void {
    this.zcode = undefined;
    this.zcodeBoot = undefined;
    if (this.killingZcode) return;
    this.log("ZCode CLI closed unexpectedly; settling open turns as errors");
    for (const session of this.sessions.values()) {
      session.pendingRaw = [];
      session.pendingReceipts = 0;
      this.releaseForwardWaiters(session);
      if (session.openTurn !== undefined) {
        const turn = session.openTurn.ariTurn;
        session.openTurn = undefined;
        this.emit(session, {
          type: "session/error",
          error: { code: -32603, message: "ZCode CLI closed unexpectedly" },
          turn,
        });
        this.emit(session, { type: "turn/completed", turn, stopReason: "error" });
        session.queue = [];
        this.emit(session, { type: "session/status", status: "idle" });
      } else if (session.queue.length > 0) {
        // Queued receipts would otherwise never settle: report and drop (§8-I5).
        session.queue = [];
        this.emit(session, {
          type: "session/error",
          error: { code: -32603, message: "ZCode CLI closed unexpectedly" },
        });
        this.emit(session, { type: "session/status", status: "idle" });
      }
    }
    for (const [approvalId, pending] of this.pendingApprovals) {
      const session = this.sessions.get(pending.sessionId);
      if (session !== undefined) {
        this.emit(session, { type: "approval/resolved", approvalId, decision: "cancelled" });
      }
    }
    this.pendingApprovals.clear();
    for (const [questionId, pending] of this.pendingQuestions) {
      const session = this.sessions.get(pending.sessionId);
      if (session !== undefined) {
        this.emit(session, { type: "question/resolved", questionId, outcome: "expired" });
      }
    }
    this.pendingQuestions.clear();
  }

  // ── ARI inbound ─────────────────────────────────────────────────────────

  /** Handle one decoded ARI frame. Malformed frames never reach here. */
  async handleMessage(value: unknown): Promise<void> {
    if (typeof value !== "object" || value === null) return;
    const message = value as Record<string, unknown>;

    if (typeof message["method"] === "string" && message["id"] === undefined) {
      // The only ARI client→server notification is `initialized` (SPEC §5.2).
      return;
    }
    if (typeof message["method"] !== "string") return;

    try {
      await this.dispatch(message["method"], message["params"], message["id"]);
    } catch (error) {
      const ariError =
        error instanceof AriError
          ? error
          : ariErrors.internal(error instanceof Error ? error.message : String(error));
      this.log(`method ${message["method"]} failed: ${ariError.message}`);
      this.respondError(message["id"], ariError);
    }
  }

  /** A frame that never decoded: answer -32700 with a null id and keep serving. */
  handleParseFailure(): void {
    this.enqueueWrite({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error: the frame was not a valid JSON value" },
    });
  }

  private requireInitialized(method: string): void {
    if (!this.initialized) throw ariErrors.notInitialized(method);
  }

  private sessionOrThrow(ariId: unknown): AriSession {
    if (typeof ariId !== "string") throw ariErrors.invalidParams("sessionId must be a string");
    const session = this.sessions.get(ariId);
    if (session === undefined) throw ariErrors.sessionNotFound(ariId);
    return session;
  }

  private async dispatch(method: string, params: unknown, id: unknown): Promise<void> {
    switch (method) {
      case "initialize":
        await this.handleInitialize(params, id);
        return;
      case "session/new":
        this.requireInitialized(method);
        await this.handleSessionNew(params, id);
        return;
      case "session/prompt":
        this.requireInitialized(method);
        await this.handlePrompt(params, id);
        return;
      case "session/cancel":
        this.requireInitialized(method);
        await this.handleCancel(params, id);
        return;
      case "session/resume":
        this.requireInitialized(method);
        this.handleResume(params, id);
        return;
      case "session/fork":
        this.requireInitialized(method);
        this.requireCapability("fork", "session/fork");
        await this.handleFork(params, id);
        return;
      case "session/list":
        this.requireInitialized(method);
        this.requireCapability("sessionList", "session/list");
        this.respond(id, { sessions: [] });
        return;
      case "approval/respond":
        this.requireInitialized(method);
        await this.handleApprovalRespond(params, id);
        return;
      case "question/respond":
        this.requireInitialized(method);
        this.requireCapability("question", "question/respond");
        await this.handleQuestionRespond(params, id);
        return;
      case "shutdown":
        this.requireInitialized(method);
        await this.handleShutdown(id);
        return;
      default:
        throw new AriError(-32601, `method not found: ${method}`);
    }
  }

  private requireCapability(capability: keyof AgentCapabilities, what: string): void {
    if (!this.capabilities[capability]) throw ariErrors.unsupportedCapability(what);
  }

  private async handleInitialize(params: unknown, id: unknown): Promise<void> {
    if (this.initialized) throw ariErrors.alreadyInitialized();
    const requested = isRecord(params) ? params["protocolVersion"] : undefined;
    if (requested !== 1) {
      throw ariErrors.unsupportedProtocolVersion(
        typeof requested === "number" ? requested : Number.NaN,
        [1],
      );
    }
    // Spawning the CLI decides whether this adapter can serve at all; a
    // failure surfaces here (the shell MAY retry initialize).
    await this.ensureZcode();
    this.initialized = true;
    this.respond(id, {
      protocolVersion: 1,
      agentInfo: { name: "zcode", version: "unknown" },
      agentCapabilities: this.capabilities,
    });
  }

  private async handleSessionNew(params: unknown, id: unknown): Promise<void> {
    const cwd = isRecord(params) && typeof params["cwd"] === "string" ? params["cwd"] : this.options.cwd;
    const client = await this.requireZcode();
    const ack = await this.sendCommand(client, null, "createSession", {
      workspaceId: cwd ?? process.cwd(),
    });
    const result = commandResult(ack, "createSession");
    const sessionId = typeof result["sessionId"] === "string" ? result["sessionId"] : undefined;
    if (sessionId === undefined || sessionId === "") {
      throw ariErrors.internal("ZCode createSession returned no session id");
    }
    const session = this.blankSession(sessionId);
    this.sessions.set(sessionId, session);
    // The response is enqueued before the subscription is even requested, and
    // every event shares its FIFO — no frame can precede it on the wire
    // (SPEC §7.9 / Appendix A item 5).
    this.respond(id, { sessionId, nextSeq: 1 });
    void this.subscribeSession(session).catch((error) => {
      this.log(`conversation subscribe failed for ${sessionId}: ${String(error)}`);
    });
  }

  private async handlePrompt(params: unknown, id: unknown): Promise<void> {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/prompt requires params");
    const session = this.sessionOrPromptable(params["sessionId"]);
    const content = params["content"];
    if (!Array.isArray(content)) throw ariErrors.invalidParams("content must be an array of blocks");
    const text = content
      .map((block) => (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : ""))
      .filter((part) => part !== "")
      .join("\n");
    if (text === "") throw ariErrors.invalidParams("content must carry at least one text block");

    const messageId = `m_${randomUUID()}`;
    const limit = this.options.queueLimit;
    if (limit !== undefined && session.queue.length >= limit && !this.canForwardNow(session)) {
      throw ariErrors.queueFull(session.queue.length, limit);
    }

    if (this.canForwardNow(session)) {
      // Idle and subscribed: forward immediately, behind the notification gate.
      await this.forwardPrompt(session, text, messageId, id);
      return;
    }

    // A turn is running (or starting): enqueue without interrupting it
    // (SPEC §7.3); ZCode's own queue semantics are not an ARI surface.
    session.queue.push({ messageId, text });
    this.respond(id, { messageId });
  }

  /** True when a `sendText` may be forwarded right now. */
  private canForwardNow(session: AriSession): boolean {
    return (
      session.openTurn === undefined &&
      session.pendingReceipts === 0 &&
      session.queue.length === 0 &&
      session.subscriptionReady
    );
  }

  /** `session/prompt` on a session offered by `session/fork` adopts it. */
  private sessionOrPromptable(ariId: unknown): AriSession {
    if (typeof ariId !== "string") throw ariErrors.invalidParams("sessionId must be a string");
    const known = this.sessions.get(ariId);
    if (known !== undefined) return known;
    if (this.adoptable.has(ariId)) {
      const adopted = this.blankSession(ariId);
      this.sessions.set(ariId, adopted);
      void this.subscribeSession(adopted).catch((error) => {
        this.log(`conversation subscribe failed for ${ariId}: ${String(error)}`);
      });
      return adopted;
    }
    throw ariErrors.sessionNotFound(ariId);
  }

  /**
   * Forward one prompt through the notification gate: park frames, send
   * `sendText`, enqueue the ARI receipt (or the failure), and only then drain.
   * The `turnHeader` row the prompt causes may arrive before or after the ack
   * (upstream: the admission ACK does not wait for TurnStarted) — the gate
   * plus the shared FIFO hide that race. Returns whether the receipt was
   * granted. `replyId` is the ARI request to answer, or undefined for a
   * queued-forward retry (whose receipt the shell already holds — a failure
   * is out-of-band then, SPEC §8-I5).
   */
  private async forwardPrompt(
    session: AriSession,
    text: string,
    messageId: string,
    replyId: unknown,
  ): Promise<boolean> {
    const client = await this.requireZcode();
    session.pendingReceipts += 1;
    session.forwardReceipt = messageId;
    let failed = false;
    try {
      const ack = await this.sendCommand(client, session.ariId, "sendText", {
        text,
        requestedDelivery: "startNow",
      });
      if (ack.status !== "accepted") {
        failed = true;
        this.failPrompt(
          session,
          replyId,
          `ZCode sendText was not accepted (${ack.status}${ack.reasonCode ? `: ${ack.reasonCode}` : ""})`,
        );
        return false;
      }
      // The receipt precedes every event the prompt causes (SPEC §7.9): it is
      // enqueued on the shared FIFO before the parked frames drain.
      if (replyId !== undefined) this.respond(replyId, { messageId });
      return true;
    } catch (error) {
      failed = true;
      this.failPrompt(
        session,
        replyId,
        `ZCode sendText failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      // On success the parked turnHeader still needs the receipt to claim;
      // only a failed forward gives it up (openTurnFor clears it).
      if (failed) session.forwardReceipt = undefined;
      session.pendingReceipts -= 1;
      this.releaseForwardWaiters(session);
      this.drainParked(session);
      if (failed) this.startQueuedTurn(session);
    }
  }

  /** A prompt failed before any turn exists: answer or surface it (§8-I5). */
  private failPrompt(session: AriSession, replyId: unknown, message: string): void {
    if (replyId !== undefined) {
      this.respondError(replyId, ariErrors.internal(message));
      return;
    }
    this.emit(session, { type: "session/error", error: { code: -32603, message } });
    this.emit(session, { type: "session/status", status: "idle" });
  }

  private async requireZcode() {
    await this.ensureZcode();
    const client = this.zcode;
    if (client === undefined) throw ariErrors.internal("ZCode CLI is not running");
    return client;
  }

  /** One `v4/command` round trip. The ack itself is the caller's business. */
  private async sendCommand(
    client: ZcodeClient,
    sessionId: string | null,
    type: string,
    payload: Record<string, unknown>,
    cas?: { baseRevision: number; baseLogEpoch: string },
  ): Promise<ZcodeCommandAck> {
    const commandId = randomUUID();
    const params: Record<string, unknown> = {
      commandId,
      clientId: this.clientId,
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
      ...(cas !== undefined ? { baseRevision: cas.baseRevision, baseLogEpoch: cas.baseLogEpoch } : {}),
    };
    const raw = await client.request("v4/command", params);
    if (!isRecord(raw)) throw ariErrors.internal("ZCode v4/command returned no ack");
    const ack = raw as unknown as ZcodeCommandAck;
    if (typeof ack.status !== "string") {
      throw ariErrors.internal("ZCode v4/command returned a malformed ack");
    }
    return ack;
  }

  /** Subscribe the conversation topic; the initial snapshot arrives framed. */
  private async subscribeSession(session: AriSession): Promise<void> {
    const client = await this.requireZcode();
    const raw = await client.request("v4/conversation/subscribe", {
      topic: `conversation/${session.ariId}`,
      connectionId: this.clientId,
      clientMode: "desktop-continuous",
    });
    const ack = extractSubscribeAck(raw);
    if (ack === undefined) throw ariErrors.internal("ZCode conversation subscribe returned no ack");
    session.logEpoch = ack.logEpoch;
    session.subscriptionReady = true;
    // An adopted session may have queued prompts waiting for the snapshot.
    this.startQueuedTurn(session);
  }

  private async handleCancel(params: unknown, id: unknown): Promise<void> {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/cancel requires params");
    const session = this.sessionOrThrow(params["sessionId"]);

    // A prompt forward in flight means the turn is about to exist; wait for it
    // to land so the stop (or the no-op) sees the truth.
    if (session.pendingReceipts > 0) await this.waitForForward(session);

    if (session.openTurn === undefined && session.queue.length === 0 && session.pendingReceipts === 0) {
      // Idempotent no-op (SPEC §7.4).
      this.respond(id, { droppedMessageIds: [] } satisfies SessionCancelResult);
      return;
    }

    const cancelledTurn = session.openTurn?.ariTurn;
    const dropped = session.queue.map((entry) => entry.messageId);
    session.queue = [];

    if (session.openTurn !== undefined) {
      const client = this.zcode;
      if (client !== undefined) {
        // ZCode settles the turn itself: the header upserts to
        // completedInterrupted and is translated to stopReason "cancelled".
        try {
          await this.sendCommand(client, session.ariId, "stop", {});
        } catch (error) {
          this.log(`stop command failed: ${String(error)}; settling locally`);
          this.settleCancelledLocally(session);
        }
      } else {
        this.settleCancelledLocally(session);
      }
    }

    const result: SessionCancelResult = {
      droppedMessageIds: dropped,
      ...(cancelledTurn !== undefined ? { cancelledTurn } : {}),
    };
    this.respond(id, result);
  }

  /** Fallback when the stop command itself cannot reach the runtime. */
  private settleCancelledLocally(session: AriSession): void {
    const turn = session.openTurn;
    if (turn === undefined) return;
    session.openTurn = undefined;
    this.emit(session, { type: "turn/completed", turn: turn.ariTurn, stopReason: "cancelled" });
    this.emit(session, { type: "session/status", status: "idle" });
    this.startQueuedTurn(session);
  }

  private waitForForward(session: AriSession): Promise<void> {
    if (session.pendingReceipts === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, CANCEL_FORWARD_WAIT_MS);
      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
      session.forwardWaiters.push(finish);
    });
  }

  private releaseForwardWaiters(session: AriSession): void {
    const waiters = session.forwardWaiters;
    session.forwardWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private handleResume(params: unknown, id: unknown): void {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/resume requires params");
    const session = this.sessionOrThrow(params["sessionId"]);
    const watermark = session.seq + 1;

    let since = 1;
    if (params["since"] !== undefined) {
      if (typeof params["since"] !== "number" || !Number.isInteger(params["since"]) || params["since"] < 1) {
        throw ariErrors.invalidParams("since must be a positive integer");
      }
      if (params["since"] > watermark) {
        throw ariErrors.invalidParams(`since ${params["since"]} is beyond the watermark ${watermark}`);
      }
      since = params["since"];
    }

    this.respond(id, {
      sessionId: session.ariId,
      replayedFrom: since,
      nextSeq: watermark,
      events: session.ledger.slice(since - 1),
      snapshot: this.snapshotOf(session),
    });
  }

  private snapshotOf(session: AriSession): Record<string, unknown> {
    return {
      status: session.openTurn !== undefined ? "running" : "idle",
      nextTurn: session.nextTurn,
      queue: session.queue.map((entry) => ({
        messageId: entry.messageId,
        content: [{ type: "text", text: entry.text }],
      })),
      pendingApprovals: [...this.pendingApprovals.entries()]
        .filter(([, pending]) => pending.sessionId === session.ariId)
        .map(([approvalId]) => ({ approvalId })),
      pendingQuestions: [...this.pendingQuestions.entries()]
        .filter(([, pending]) => pending.sessionId === session.ariId)
        .map(([questionId]) => ({ questionId })),
      openToolCalls: [...session.openTools.entries()].map(([callId, tool]) => ({
        callId,
        name: tool.name,
        status: "running",
      })),
      ...(session.usage !== undefined ? { usage: session.usage } : {}),
    };
  }

  private async handleFork(params: unknown, id: unknown): Promise<void> {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/fork requires params");
    const session = this.sessionOrThrow(params["sessionId"]);
    const lastTurn = session.nextTurn - 1;
    const atTurn = params["atTurn"] === undefined ? lastTurn : params["atTurn"];
    if (typeof atTurn !== "number" || !Number.isInteger(atTurn) || atTurn < 1 || atTurn > lastTurn) {
      throw ariErrors.invalidParams(`atTurn must be a turn boundary in [1, ${lastTurn}]`);
    }
    const turn = session.turns.get(atTurn);
    if (turn === undefined) {
      throw ariErrors.invalidParams(`atTurn ${atTurn} is not a known turn boundary`);
    }

    // forkAssistant targets the turn's last assistantText row; a turn with no
    // assistant output is not a forkable boundary on this wire.
    let target: { rowId: number; entityId: string } | undefined;
    for (const row of session.rows.values()) {
      if (row.kind !== "assistantText" || row.turnId !== turn.turnId) continue;
      if (typeof row.entityId !== "string" || row.entityId === "") continue;
      if (target === undefined || row.rowId > target.rowId) {
        target = { rowId: row.rowId, entityId: row.entityId };
      }
    }
    if (target === undefined) {
      throw ariErrors.invalidParams(`atTurn ${atTurn} has no forkable assistant boundary`);
    }

    const client = await this.requireZcode();
    const ack = await this.sendCommand(
      client,
      session.ariId,
      "forkAssistant",
      { target },
      { baseRevision: session.revision, baseLogEpoch: session.logEpoch },
    );
    const result = commandResult(ack, "forkAssistant");
    const forkedSessionId = typeof result["sessionId"] === "string" ? result["sessionId"] : undefined;
    if (forkedSessionId === undefined || forkedSessionId === "") {
      throw ariErrors.internal("ZCode forkAssistant returned no session id");
    }
    const forked = this.blankSession(forkedSessionId);
    this.sessions.set(forkedSessionId, forked);
    this.adoptable.add(forkedSessionId);
    this.respond(id, {
      sessionId: forkedSessionId,
      nextSeq: 1,
      forkedFrom: { sessionId: session.ariId, turn: atTurn },
    });
    void this.subscribeSession(forked).catch((error) => {
      this.log(`conversation subscribe failed for ${forkedSessionId}: ${String(error)}`);
    });
  }

  private async handleApprovalRespond(params: unknown, id: unknown): Promise<void> {
    if (!isRecord(params)) throw ariErrors.invalidParams("approval/respond requires params");
    // The gated parameter is checked before anything else (SPEC §10.1).
    if (params["amendedInput"] !== undefined && !this.capabilities.approvalEditInput) {
      throw ariErrors.unsupportedCapability("approval/respond.amendedInput (approvalEditInput is false)");
    }
    if (typeof params["sessionId"] !== "string") throw ariErrors.invalidParams("sessionId must be a string");
    const approvalId = typeof params["approvalId"] === "string" ? params["approvalId"] : "";
    const decision = params["decision"];
    if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") {
      throw ariErrors.invalidParams("decision must be allow_once, allow_always, or deny");
    }

    const pending = this.pendingApprovals.get(approvalId);
    if (pending === undefined) {
      const resolved = this.resolvedApprovals.get(approvalId);
      if (resolved !== undefined && resolved.decision === decision) {
        // Same answer again: idempotent success (SPEC §10.3).
        this.respond(id, {});
        return;
      }
      throw ariErrors.unknownInteraction(approvalId || "(missing)");
    }

    // The decision must be one the interaction actually offered (SPEC §10.1):
    // it maps onto a ZCode permission option of the matching kind.
    const optionId = permissionOptionIdFor(pending.options, decision);
    if (optionId === undefined) {
      throw ariErrors.invalidParams(`decision ${decision} was not offered by approval ${approvalId}`);
    }

    const client = await this.requireZcode();
    const ack = await this.sendCommand(client, pending.sessionId, "resolveInteraction", {
      interactionId: approvalId,
      answer: { optionId },
    });
    if (ack.status !== "accepted") {
      // The interaction no longer exists upstream (auto-resolved, answered on
      // another client): a late answer is -32007, not a fresh decision.
      throw ariErrors.unknownInteraction(approvalId);
    }

    this.pendingApprovals.delete(approvalId);
    this.resolvedApprovals.set(approvalId, { ...pending, decision });
    this.respond(id, {});
    const session = this.sessions.get(pending.sessionId);
    if (session !== undefined) {
      session.pendingInteractions.delete(approvalId);
      this.emit(session, { type: "approval/resolved", approvalId, decision });
    }
  }

  private async handleQuestionRespond(params: unknown, id: unknown): Promise<void> {
    if (!isRecord(params)) throw ariErrors.invalidParams("question/respond requires params");
    if (typeof params["sessionId"] !== "string") throw ariErrors.invalidParams("sessionId must be a string");
    const questionId = typeof params["questionId"] === "string" ? params["questionId"] : "";
    const answers = params["answers"];
    if (!Array.isArray(answers)) throw ariErrors.invalidParams("answers must be an array");

    const pending = this.pendingQuestions.get(questionId);
    if (pending === undefined) {
      const resolved = this.resolvedQuestions.get(questionId);
      if (resolved !== undefined && sameAnswers(resolved.answers, answers)) {
        this.respond(id, {});
        return;
      }
      throw ariErrors.unknownInteraction(questionId || "(missing)");
    }

    const mapped = answers.filter(
      (answer): answer is { id: string; values: string[] } =>
        isRecord(answer) && typeof answer["id"] === "string" && Array.isArray(answer["values"]),
    );
    const declined = mapped.length === 0;
    const answer =
      pending.payload.questions !== undefined
        ? mapQuestionAnswerOut(pending.payload.questions, mapped)
        : mapFreeTextAnswerOut(mapped);

    const client = await this.requireZcode();
    const ack = await this.sendCommand(client, pending.sessionId, "resolveInteraction", {
      interactionId: questionId,
      answer: answer.answer,
    });
    if (ack.status !== "accepted") {
      throw ariErrors.unknownInteraction(questionId);
    }

    this.pendingQuestions.delete(questionId);
    this.resolvedQuestions.set(questionId, { ...pending, answers: mapped });
    this.respond(id, {});
    const session = this.sessions.get(pending.sessionId);
    if (session !== undefined) {
      session.pendingInteractions.delete(questionId);
      this.emit(session, {
        type: "question/resolved",
        questionId,
        outcome: mapQuestionOutcome(declined),
      });
    }
  }

  private async handleShutdown(id: unknown): Promise<void> {
    this.shuttingDown = true;
    // The wire's goodbye is stdin EOF (the upstream transport's normal exit
    // boundary); the client follows with SIGTERM for runtimes that miss it.
    this.killZcode();
    this.respond(id, {});
    await this.drainWrites();
    this.log("shutdown complete");
    this.options.exit?.(0);
  }

  // ── ZCode inbound: conversation frames ──────────────────────────────────

  /**
   * Legacy reverse requests split into two classes on this wire:
   *
   *  - `session/requestRuntimePreferences` **blocks runtime creation** and has
   *    no V4 counterpart, so it must be answered. The adapter returns the same
   *    values the desktop host falls back to (upstream only self-falls-back on
   *    "method not found"/"no client", not on a timeout).
   *  - `interaction/*` requests race the V4 `pendingInteractions` deferred;
   *    answering one could pre-empt a pending permission with a bogus
   *    decision, so they stay unanswered and time out on the CLI side.
   */
  private onZcodeServerRequest(request: IncomingZcodeRequest): void {
    if (request.method === "session/requestRuntimePreferences") {
      request.respond({
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
      });
      return;
    }
    this.log(`ignoring ZCode server request (unanswered by design): ${request.method}`);
  }

  private onZcodeNotification(method: string, params: unknown): void {
    if (method !== "v4/conversation/frame") {
      // Out of ARI's vocabulary (telemetry facts, ttft, legacy chatter,
      // notifications without a conversation topic): runtime-internal or
      // presentational (SPEC §1.2 non-goals).
      return;
    }
    const frame = params as ZcodeTopicFrame | undefined;
    const topic = typeof frame?.topic === "string" ? frame.topic : "";
    const sessionId = topic.startsWith("conversation/") ? topic.slice("conversation/".length) : "";
    if (sessionId === "" || !isRecord(frame) || !isRecord(frame["payload"])) {
      this.log("ignoring ZCode frame without a conversation topic or payload");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      // Sessions the adapter did not create (or adopt) are not ours to show.
      return;
    }
    if (session.pendingReceipts > 0) {
      session.pendingRaw.push(frame as ZcodeTopicFrame);
      return;
    }
    this.processFrame(session, frame as ZcodeTopicFrame);
  }

  /** Process parked inbound frames in arrival order until none are gated. */
  private drainParked(session: AriSession): void {
    while (session.pendingReceipts === 0 && session.pendingRaw.length > 0) {
      const parked = session.pendingRaw.shift();
      if (parked === undefined) break;
      this.processFrame(session, parked);
    }
  }

  private processFrame(session: AriSession, frame: ZcodeTopicFrame): void {
    if (frame.payload.kind === "snapshot") {
      this.processSnapshot(session, frame.payload.snapshot);
      return;
    }
    if (frame.payload.kind === "deltas" && Array.isArray(frame.payload.deltas)) {
      for (const delta of frame.payload.deltas) {
        this.processDelta(session, delta);
      }
    }
  }

  /**
   * The initial (or resync) snapshot is history: it reconstructs row/turn
   * bookkeeping and opens anything still live, but emits no events for
   * settled content (a shell that adopted a session must not see its past
   * replayed as new deltas).
   */
  private processSnapshot(session: AriSession, snapshot: ZcodeSnapshot): void {
    if (typeof snapshot.revision === "number") session.revision = snapshot.revision;
    if (typeof snapshot.logEpoch === "string" && snapshot.logEpoch !== "") session.logEpoch = snapshot.logEpoch;
    const rows = Array.isArray(snapshot.rows?.window) ? (snapshot.rows?.window as ZcodeRow[]) : [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.rowId !== "number") continue;
      session.rows.set(row.rowId, row);
      switch (row.kind) {
        case "turnHeader":
          if (row.state === "running" && session.openTurn === undefined) {
            this.openTurnFor(session, row);
          } else if (row.state !== "running") {
            this.recordHistoricalTurn(session, row);
          }
          break;
        case "toolCall":
          if (isLiveToolStatus(row.status)) this.onToolCall(session, row, undefined);
          break;
        case "subagent":
          if (row.status === "running") this.onSubagent(session, row, undefined);
          break;
        default:
          break;
      }
    }
    const interactions = Array.isArray(snapshot.pendingInteractions)
      ? (snapshot.pendingInteractions as ZcodeInteraction[])
      : [];
    this.reconcileInteractions(session, interactions);
    const usage = mapUsage(snapshot.usage);
    if (usage !== undefined) session.usage = usage;
  }

  private processDelta(session: AriSession, delta: ZcodeDelta): void {
    if (!isRecord(delta) || typeof delta.op !== "string") return;
    switch (delta.op) {
      case "row.appended":
        this.onRowAppended(session, delta.row);
        return;
      case "row.upserted":
        this.onRowUpserted(session, delta.row);
        return;
      case "row.removed":
        this.onRowRemoved(session, Number(delta.fromRowId));
        return;
      case "row.delta":
        this.onRowDelta(session, delta);
        return;
      case "state.updated":
        this.onStateUpdated(session, delta.patch);
        return;
      default:
        return;
    }
  }

  private onRowAppended(session: AriSession, row: ZcodeRow): void {
    if (!isRecord(row) || typeof row.rowId !== "number") return;
    session.rows.set(row.rowId, row);
    this.onRowContent(session, row, undefined);
  }

  private onRowUpserted(session: AriSession, row: ZcodeRow): void {
    if (!isRecord(row) || typeof row.rowId !== "number") return;
    const previous = session.rows.get(row.rowId);
    session.rows.set(row.rowId, row);
    this.onRowContent(session, row, previous);
  }

  /**
   * One live row fact (appended or upserted), dispatched by kind. `previous`
   * is the row as last seen — transition detection reads it, never the wire
   * order; a row that arrives already terminal still gets its opening event
   * first (the coalescer can collapse a whole bracket between flush windows).
   */
  private onRowContent(session: AriSession, row: ZcodeRow, previous: ZcodeRow | undefined): void {
    switch (row.kind) {
      case "turnHeader":
        this.onTurnHeader(session, row, previous);
        return;
      case "assistantText":
      case "reasoning":
        this.onStreamedText(session, row, previous);
        return;
      case "toolCall":
        this.onToolCall(session, row, previous);
        return;
      case "subagent":
        this.onSubagent(session, row, previous);
        return;
      case "timelineMarker":
        if (previous === undefined && row.marker !== undefined) {
          const draft = mapCompactionMarker(row.marker);
          if (draft !== undefined) this.emit(session, draft);
        }
        return;
      default:
        return;
    }
  }

  private onTurnHeader(session: AriSession, row: ZcodeRow, previous: ZcodeRow | undefined): void {
    const state = typeof row.state === "string" ? row.state : "running";

    if (previous === undefined && state === "running") {
      if (session.openTurn === undefined) this.openTurnFor(session, row);
      else this.log(`ignoring second running turnHeader (row ${row.rowId}) while a turn is open`);
      return;
    }
    if (previous === undefined && state !== "running") {
      // A whole bracket coalesced into one append: open and settle in the
      // same breath so every started turn settles exactly once (SPEC §8-I1).
      if (session.openTurn !== undefined) {
        this.log(`ignoring coalesced turnHeader (row ${row.rowId}) while another turn is open`);
        return;
      }
      this.openTurnFor(session, row);
      this.settleTurn(session, state);
      return;
    }

    const open = session.openTurn;
    if (open === undefined || open.turnId !== turnIdOf(session, row)) return;
    if (state === "running") return;
    this.settleTurn(session, state);
  }

  private openTurnFor(session: AriSession, row: ZcodeRow): void {
    const turnId = turnIdOf(session, row);
    // Claim the receipt the in-flight (or just-landed) forward carried; a turn
    // nobody prompted for gets a synthesized id (SPEC §7.3 obligation).
    const claimed = session.forwardReceipt ?? `m_adapted_${session.nextTurn}`;
    session.forwardReceipt = undefined;
    const ariTurn = session.nextTurn++;
    session.turns.set(ariTurn, { turnId });
    session.openTurn = { ariTurn, turnId, headerRowId: row.rowId, errorAnnounced: false };
    this.emit(session, { type: "turn/started", turn: ariTurn, messageIds: [claimed] });
    this.emit(session, { type: "session/status", status: "running" });
  }

  /** Count a settled historical header without emitting a bracket. */
  private recordHistoricalTurn(session: AriSession, row: ZcodeRow): void {
    session.turns.set(session.nextTurn, { turnId: turnIdOf(session, row) });
    session.nextTurn += 1;
  }

  private settleTurn(session: AriSession, state: string): void {
    const open = session.openTurn;
    if (open === undefined) return;
    session.openTurn = undefined;
    const mapped = mapTurnEnd(state);
    if (mapped.stopReason === "error" && !open.errorAnnounced) {
      // I2/I3: diagnostics first, settlement second, every time.
      this.emit(session, {
        type: "session/error",
        error: { code: -32603, message: "ZCode turn failed" },
        turn: open.ariTurn,
      });
    }
    this.emit(session, { type: "turn/completed", turn: open.ariTurn, stopReason: mapped.stopReason });
    this.emit(session, { type: "session/status", status: "idle" });
    this.startQueuedTurn(session);
  }

  /**
   * A streaming row appended (first observation). Deltas carry the rest; a
   * row that arrives already settled delivers its text whole; a row that
   * settles after streaming delivers whatever the coalescer merged into the
   * final row beyond the deltas that already streamed (the upstream flush
   * window can swallow every delta — seen live).
   */
  private onStreamedText(session: AriSession, row: ZcodeRow, previous: ZcodeRow | undefined): void {
    if (row.state === "streaming") return;
    // A settled row's text is one fact: upstream may re-announce the row on
    // later projection commits, and the delivery must not repeat (seen live).
    if (session.settledTextRows.has(row.rowId)) return;
    const text = typeof row.text === "string" ? row.text : "";
    const draftFor = (body: string): AriEventDraft | undefined => {
      if (body === "") return undefined;
      return row.kind === "reasoning"
        ? { type: "reasoning/delta", text: body }
        : { type: "message/delta", text: body };
    };
    if (previous === undefined) {
      session.settledTextRows.add(row.rowId);
      const draft = draftFor(text);
      if (draft !== undefined) this.emit(session, withTurn(draft, session));
      return;
    }
    const streamed = session.streamedTextLength.get(row.rowId) ?? 0;
    session.streamedTextLength.delete(row.rowId);
    session.settledTextRows.add(row.rowId);
    if (text.length <= streamed) return;
    const draft = draftFor(text.slice(streamed));
    if (draft !== undefined) this.emit(session, withTurn(draft, session));
  }

  private onToolCall(session: AriSession, row: ZcodeRow, previous: ZcodeRow | undefined): void {
    const callId = typeof row.toolCallId === "string" && row.toolCallId !== "" ? row.toolCallId : `t_${row.rowId}`;
    const name = typeof row.toolName === "string" && row.toolName !== "" ? row.toolName : "tool";
    const status = typeof row.status === "string" ? row.status : "running";
    const terminal = !isLiveToolStatus(status);
    const wasLive = session.openTools.has(callId);

    if (previous === undefined && !wasLive && !session.seenTools.has(callId)) {
      // First observation (fresh or coalesced): the bracket opens first.
      session.seenTools.add(callId);
      this.emit(
        session,
        withTurn(
          {
            type: "tool/started",
            callId,
            name,
            ...(row.input !== undefined
              ? { input: row.input }
              : typeof row.inputText === "string" && row.inputText !== ""
                ? { input: { inputText: row.inputText } }
                : {}),
          },
          session,
        ),
      );
      if (!terminal) {
        session.openTools.set(callId, { name });
        session.toolStatuses.set(callId, status);
        if (status !== "inputStreaming") {
          this.emit(session, {
            type: "tool/updated",
            callId,
            status: status === "running" ? "running" : "pending",
          });
        }
        return;
      }
    } else if (!terminal) {
      // Non-terminal transition: surface it once per status change (SPEC §9.2).
      if (previous !== undefined && previous.status === status) return;
      if (session.toolStatuses.get(callId) === status) return;
      session.toolStatuses.set(callId, status);
      if (status === "running" && !wasLive) session.openTools.set(callId, { name });
      this.emit(session, {
        type: "tool/updated",
        callId,
        status: status === "running" ? "running" : "pending",
      });
      return;
    }

    if (!terminal) return;

    // Settlement.
    session.openTools.delete(callId);
    session.toolStatuses.delete(callId);
    const output = typeof row.output?.text === "string" && row.output.text !== "" ? row.output.text : undefined;
    const draft: AriEventDraft =
      status === "success"
        ? {
            type: "tool/completed",
            callId,
            status: "success",
            ...(output !== undefined ? { output } : {}),
          }
        : {
            type: "tool/completed",
            callId,
            status: "error",
            ...(output !== undefined ? { output } : {}),
            ...(status === "cancelled"
              ? { meta: { cancelled: true } }
              : row.error?.message
                ? { meta: { code: row.error.code ?? "error", message: row.error.message } }
                : {}),
          };
    this.emit(session, draft);
  }

  private onSubagent(session: AriSession, row: ZcodeRow, previous: ZcodeRow | undefined): void {
    const callId =
      typeof row.parentToolCallId === "string" && row.parentToolCallId !== ""
        ? row.parentToolCallId
        : `t_${row.rowId}`;
    const status = typeof row.status === "string" ? row.status : "running";

    if (previous === undefined && !session.seenSubagents.has(row.rowId)) {
      session.seenSubagents.add(row.rowId);
      if (status === "running") {
        session.openSubagents.set(callId, row.rowId);
        this.emit(session, this.subagentStartedDraft(row, callId));
        return;
      }
      // A whole bracket coalesced into one append: open and close it.
      this.emit(session, this.subagentStartedDraft(row, callId));
      this.emit(session, this.subagentFinishedDraft(row, callId));
      return;
    }

    if (status !== "running" && session.openSubagents.has(callId)) {
      session.openSubagents.delete(callId);
      this.emit(session, this.subagentFinishedDraft(row, callId));
    }
  }

  private subagentStartedDraft(row: ZcodeRow, callId: string): AriEventDraft {
    const draft: AriEventDraft = { type: "subagent/started", callId };
    if (typeof row.childSessionId === "string" && row.childSessionId !== "") {
      draft.childSessionId = row.childSessionId;
    }
    if (typeof row.subagentType === "string" && row.subagentType !== "") draft.name = row.subagentType;
    return draft;
  }

  private subagentFinishedDraft(row: ZcodeRow, callId: string): AriEventDraft {
    const status = typeof row.status === "string" ? row.status : "failed";
    return {
      type: "subagent/finished",
      callId,
      status: mapSubagentStatus(status),
      ...(typeof row.summaryText === "string" && row.summaryText !== "" ? { summary: row.summaryText } : {}),
    };
  }

  private onRowRemoved(session: AriSession, fromRowId: number): void {
    // Branch removal (edit/retry): everything from fromRowId is gone. Any
    // open bracket inside the removed range can never report again, so it
    // converges here (SPEC §9.2: tool/completed is the only terminal event).
    for (const [rowId, row] of [...session.rows.entries()]) {
      if (rowId < fromRowId) continue;
      session.rows.delete(rowId);
      session.streamedTextLength.delete(rowId);
      if (row.kind === "toolCall") {
        const callId = typeof row.toolCallId === "string" && row.toolCallId !== "" ? row.toolCallId : `t_${row.rowId}`;
        if (session.openTools.delete(callId)) {
          session.toolStatuses.delete(callId);
          this.emit(session, {
            type: "tool/completed",
            callId,
            status: "error",
            ...(typeof row.output?.text === "string" && row.output.text !== ""
              ? { output: row.output.text }
              : {}),
            meta: { removed: true },
          });
        }
      }
      if (row.kind === "subagent") {
        const callId =
          typeof row.parentToolCallId === "string" && row.parentToolCallId !== ""
            ? row.parentToolCallId
            : `t_${row.rowId}`;
        if (session.openSubagents.delete(callId)) {
          this.emit(session, { type: "subagent/finished", callId, status: "cancelled" });
        }
      }
    }

    // A removed range that covers the open turn's header ends that turn: the
    // branch it was running on no longer exists.
    const open = session.openTurn;
    if (open !== undefined && open.headerRowId >= fromRowId) {
      session.openTurn = undefined;
      this.emit(session, { type: "turn/completed", turn: open.ariTurn, stopReason: "cancelled" });
      this.emit(session, { type: "session/status", status: "idle" });
      this.startQueuedTurn(session);
    }
  }

  private onRowDelta(session: AriSession, delta: Extract<ZcodeDelta, { op: "row.delta" }>): void {
    const row = session.rows.get(delta.rowId);
    if (row === undefined || typeof delta.append !== "string" || delta.append === "") return;
    if (delta.path === "text") {
      if (row.kind !== "assistantText" && row.kind !== "reasoning") return;
      session.streamedTextLength.set(row.rowId, (session.streamedTextLength.get(row.rowId) ?? 0) + delta.append.length);
      const draft: AriEventDraft =
        row.kind === "reasoning"
          ? { type: "reasoning/delta", text: delta.append }
          : { type: "message/delta", text: delta.append };
      this.emit(session, withTurn(draft, session));
      return;
    }
    if (delta.path === "output.text" && row.kind === "toolCall") {
      const callId = typeof row.toolCallId === "string" && row.toolCallId !== "" ? row.toolCallId : `t_${row.rowId}`;
      this.emit(session, {
        type: "tool/updated",
        callId,
        status: "running",
        outputDelta: delta.append,
      });
      return;
    }
    // "inputText" and "summaryText" appends are presentational on this wire.
  }

  private onStateUpdated(session: AriSession, patch: ZcodeStatePatch): void {
    if (typeof patch.revision === "number") session.revision = patch.revision;

    const control = patch.control;
    if (control !== undefined && control !== null) {
      // I4: an api-retry in flight is a retryable diagnostic; the turn stays
      // open. Announce once per attempt.
      const retry = control.apiRetry;
      if (retry !== null && retry !== undefined && typeof retry.attempt === "number") {
        if (retry.attempt !== session.lastRetryAttempt) {
          session.lastRetryAttempt = retry.attempt;
          this.emit(session, {
            type: "session/error",
            error: {
              code: -32603,
              message: `ZCode api retry (attempt ${retry.attempt}${retry.maxAttempts ? `/${retry.maxAttempts}` : ""}): ${retry.reasonCode ?? "transient"}`,
              retryable: true,
            },
            ...(session.openTurn !== undefined ? { turn: session.openTurn.ariTurn } : {}),
          });
        }
      } else if (retry === null || retry === undefined) {
        session.lastRetryAttempt = 0;
      }

      // A new lastError is a fatal diagnostic for the open turn (I3: it must
      // precede the settlement, which arrives with the header upsert).
      const lastError = control.lastError;
      if (
        lastError !== null &&
        lastError !== undefined &&
        typeof lastError.message === "string" &&
        lastError.message !== "" &&
        session.openTurn !== undefined &&
        !session.openTurn.errorAnnounced
      ) {
        session.openTurn.errorAnnounced = true;
        this.emit(session, {
          type: "session/error",
          error: { code: -32603, message: lastError.message },
          turn: session.openTurn.ariTurn,
        });
      }
    }

    if (patch.usage !== undefined && patch.usage !== null) {
      const usage = mapUsage(patch.usage);
      if (usage !== undefined) {
        session.usage = usage;
        this.emit(session, withTurn({ type: "usage/updated", usage }, session));
      }
    }

    if (Array.isArray(patch.pendingInteractions)) {
      this.reconcileInteractions(session, patch.pendingInteractions as ZcodeInteraction[]);
    }
  }

  /**
   * Whole-key `pendingInteractions` replacement: new entries surface as
   * requests, vanished entries resolve without the shell's answer.
   */
  private reconcileInteractions(session: AriSession, interactions: ZcodeInteraction[]): void {
    const seen = new Set<string>();
    for (const interaction of interactions) {
      if (!isRecord(interaction) || typeof interaction.interactionId !== "string") continue;
      const id = interaction.interactionId;
      seen.add(id);
      if (session.pendingInteractions.has(id)) continue;
      if (interaction.kind === "permission") {
        const payload = interaction.payload as Extract<ZcodeInteraction["payload"], { kind: "permission" }>;
        session.pendingInteractions.add(id);
        this.pendingApprovals.set(id, {
          sessionId: session.ariId,
          ...(Array.isArray(payload.options) ? { options: payload.options } : {}),
        });
        const options = Array.isArray(payload.options) ? mapApprovalOptions(payload.options) : [];
        this.emit(session, {
          type: "approval/requested",
          approvalId: id,
          ...(typeof payload.toolCallId === "string" && payload.toolCallId !== ""
            ? { toolCallId: payload.toolCallId }
            : {}),
          ...(typeof payload.toolName === "string" && payload.toolName !== ""
            ? { toolName: payload.toolName }
            : {}),
          ...(typeof payload.summary === "string" && payload.summary !== ""
            ? { reason: payload.summary }
            : {}),
          ...(options.length > 0 ? { options } : {}),
        });
        continue;
      }
      if (interaction.kind === "userInput") {
        const payload = interaction.payload as Extract<ZcodeInteraction["payload"], { kind: "userInput" }>;
        session.pendingInteractions.add(id);
        this.pendingQuestions.set(id, { sessionId: session.ariId, payload });
        const questions =
          payload.questions !== undefined
            ? mapQuestionSpecs(payload.questions)
            : [
                {
                  id: questionIdAt(0),
                  question:
                    typeof payload.prompt === "string" && payload.prompt !== ""
                      ? payload.prompt
                      : "Input requested",
                },
              ];
        this.emit(session, { type: "question/requested", questionId: id, questions });
        continue;
      }
      // workspaceHookReview has no ARI surface; it stays a runtime concern.
    }

    // Vanished without the shell's answer: not recorded as a decision.
    for (const id of [...session.pendingInteractions]) {
      if (seen.has(id)) continue;
      session.pendingInteractions.delete(id);
      if (this.pendingApprovals.delete(id)) {
        this.emit(session, { type: "approval/resolved", approvalId: id, decision: "cancelled" });
      } else if (this.pendingQuestions.delete(id)) {
        this.emit(session, { type: "question/resolved", questionId: id, outcome: "expired" });
      }
    }
  }

  /** Start the next queued prompt, if the session is idle again. */
  private startQueuedTurn(session: AriSession): void {
    if (session.openTurn !== undefined || session.queue.length === 0 || session.pendingReceipts > 0) return;
    if (!session.subscriptionReady) return;
    const next = session.queue.shift();
    if (next === undefined) return;
    void (async () => {
      try {
        await this.forwardPrompt(session, next.text, next.messageId, undefined);
      } catch (error) {
        this.log(`queued forward failed: ${String(error)}`);
        this.emit(session, { type: "session/error", error: { code: -32603, message: String(error) } });
        this.emit(session, { type: "session/status", status: "idle" });
      }
    })();
  }

  // ── construction helpers ────────────────────────────────────────────────

  private blankSession(ariId: string): AriSession {
    return {
      ariId,
      seq: 0,
      nextTurn: 1,
      turns: new Map(),
      queue: [],
      pendingReceipts: 0,
      pendingRaw: [],
      forwardWaiters: [],
      rows: new Map(),
      openTools: new Map(),
      toolStatuses: new Map(),
      seenTools: new Set(),
      streamedTextLength: new Map(),
      settledTextRows: new Set(),
      openSubagents: new Map(),
      seenSubagents: new Set(),
      pendingInteractions: new Set(),
      lastRetryAttempt: 0,
      revision: 0,
      logEpoch: "",
      subscriptionReady: false,
      ledger: [],
    };
  }

  /** Kill the runtime and drop all state; used when the ARI side goes away. */
  dispose(): void {
    this.killZcode();
  }
}

function isLiveToolStatus(status: string | undefined): boolean {
  return status === "inputStreaming" || status === "pendingApproval" || status === "running";
}

function turnIdOf(session: AriSession, row: ZcodeRow): string {
  return typeof row.turnId === "string" && row.turnId !== "" ? row.turnId : `turn_${row.rowId}`;
}

/** Attach the currently open ARI turn to a draft, when there is one. */
function withTurn<T extends AriEventDraft>(draft: T, session: AriSession): T {
  return session.openTurn === undefined
    ? draft
    : ({ ...draft, turn: session.openTurn.ariTurn } as T);
}

function extractSubscribeAck(raw: unknown): { subscriptionId: string; mode: string; logEpoch: string } | undefined {
  const ack = isRecord(raw) && isRecord(raw["ack"]) ? (raw["ack"] as Record<string, unknown>) : undefined;
  if (ack === undefined) return undefined;
  return {
    subscriptionId: String(ack["subscriptionId"] ?? ""),
    mode: String(ack["mode"] ?? ""),
    logEpoch: String(ack["logEpoch"] ?? ""),
  };
}

function commandResult(ack: ZcodeCommandAck, type: string): Record<string, unknown> {
  if (ack.status !== "accepted") {
    throw new AriError(
      -32603,
      `ZCode ${type} was not accepted (${ack.status}${ack.reasonCode ? `: ${ack.reasonCode}` : ""})`,
    );
  }
  return isRecord(ack.result) ? ack.result : {};
}

function sameAnswers(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
