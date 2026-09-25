/**
 * Codex → ARI adapter core.
 *
 * Role (see the repository handoff): the adapter is **not** a harness and does
 * not use `AriHarness`. It is a translator — it plays the ARI *server* toward
 * the shell and the Codex app-server *client* toward the real runtime.
 *
 * What this file owns (state the pure mapper must not know about):
 *
 *  - **Session identity.** ARI session ids **are** Codex thread ids. Codex
 *    allocates durable, opaque thread ids at `thread/start`, so — unlike the
 *    DSH adapter, which had to re-key lazily-created runtime sessions — no
 *    id-mapping table is needed. (SPEC §9.1 recommends `s_` + ULID; it is a
 *    recommendation, and ids stay opaque.) Threads returned by `session/list`
 *    become promptable sessions by *adoption*: their ids enter the adoptable
 *    set, and the first prompt creates adapter state for them.
 *  - **Renumbering.** ARI `seq` (from 1, dense) and `turn` (from 1) are
 *    adapter-assigned; Codex coordinates (`turn_id`, `item_id`) never pass
 *    through as such — turns live in a per-session table, items ride ARI's
 *    opaque `callId`.
 *  - **The notification gate.** The app-server writes responses and
 *    notifications through one outbound queue, and a turn can start (and emit
 *    `turn/started`) before the `turn/start` response reaches the wire. ARI
 *    forbids that ordering (the response MUST precede any event it caused,
 *    SPEC §7.9). While a `thread/start` or `turn/start` forward is
 *    outstanding, every inbound frame for that thread — notifications *and*
 *    server→client requests — is parked in a per-session FIFO and processed
 *    only after the response lands and the ARI receipt has been written.
 *  - **The pending-input queue.** Codex's `turn/start` *steers* a running
 *    turn; steering is explicitly not ARI 1.0 semantics (SPEC §12). So the
 *    adapter owns a per-session queue: prompts arriving while a turn is open
 *    (or while a start is in flight) are enqueued with a receipt, and the
 *    next queued prompt is forwarded only after the current turn settles.
 *    Each forward carries exactly one message, so `turn/started.messageIds`
 *    attributes exactly the receipt the shell holds (SPEC §7.3).
 *  - **Cancellation by interruption.** Unlike DSH, Codex has a real cancel:
 *    ARI `session/cancel` maps to `turn/interrupt`, the queue is dropped into
 *    `droppedMessageIds`, and the wire's `turn/completed{interrupted}`
 *    settles the turn as `cancelled`. No process is killed; the runtime and
 *    the session survive.
 *  - **Interactions over server→client requests.** Approvals
 *    (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)
 *    and questions (`item/tool/requestUserInput`) arrive as JSON-RPC requests
 *    from the runtime. The adapter parks them behind the same gate, surfaces
 *    them as `approval/requested` / `question/requested`, answers the runtime
 *    when the shell responds, keeps the idempotency table SPEC §10.3 requires,
 *    and resolves them as `cancelled`/`expired` when the runtime aborts them
 *    (`serverRequest/resolved`) or dies (SPEC §8-I7).
 *  - **Replay from the ledger.** The adapter records every emitted event per
 *    session. `session/resume{since}` replays that cut (SPEC §7.2) with a
 *    derived snapshot — the same in-memory contract the reference mock
 *    harness offers. A `since` beyond the watermark is -32602 (SPEC §7.2).
 *    The ledger lives exactly as long as the adapter process: after a
 *    restart the Codex thread survives, but this process has no events for
 *    it, so `session/resume` of a pre-restart session is -32001. The
 *    supported continuity path is `session/list` adoption with a fresh seq
 *    space; replay across restarts would need a documented -32004 or a
 *    `thread/resume`-backed ledger rebuild, not a pretend continuity.
 *  - **Capability honesty.** The declared capability set (translate.ts) is
 *    exactly what the wire can deliver; the emit path additionally drops any
 *    gated event whose capability is `false` (SPEC §5.3).
 */

import type { Writable } from "node:stream";

import {
  AriError,
  ariErrors,
  createFrameWriter,
  EVENT_CAPABILITY,
  METHOD_CAPABILITY,
} from "../../ari/src/index.ts";
import type { AgentCapabilities, SessionCancelResult } from "../../ari/src/index.ts";
import { CodexClient, type CodexChildSpec, type IncomingCodexRequest } from "./codex.ts";
import {
  CODEX_AGENT_CAPABILITIES,
  COMMAND_APPROVAL_OPTIONS,
  isRecord,
  mapAnswersOut,
  mapApprovalDecisionOut,
  mapApprovalResolutionOut,
  mapCommandExecutionItem,
  mapCompactionTrigger,
  mapFileChangeItem,
  mapMcpToolCallItem,
  mapQuestions,
  mapSessionStatus,
  mapSubagentStatus,
  mapTurnEnd,
  mapUsage,
  TOOL_OUTPUT_STREAM_AT,
  TOOL_OUTPUT_SUMMARY_CHARS,
  type CodexCommandApprovalParams,
  type CodexFileChangeApprovalParams,
  type CodexItem,
  type CodexThread,
  type CodexUserInputParams,
} from "./translate.ts";
import type { AriEventDraft } from "./drafts.ts";

/** How long session/cancel waits for an in-flight start forward to land. */
const CANCEL_FORWARD_WAIT_MS = 3_000;

export interface AdapterOptions {
  /** How to start the Codex app-server (e.g. `codex app-server` or the fake). */
  codex: CodexChildSpec;
  /** Working directory handed to the app-server and used for thread/start. */
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
  codexTurnId: string;
  /** A fatal `error` notification already announced for this turn (SPEC §8-I3). */
  errorAnnounced: boolean;
}

interface PendingApproval {
  sessionId: string;
  requestId: unknown;
  respond: (result: unknown) => void;
  decision: "allow_once" | "allow_always" | "deny";
}

interface PendingQuestion {
  sessionId: string;
  requestId: unknown;
  respond: (result: unknown) => void;
  answers: { id: string; values: string[] }[];
}

interface ParkedInbound {
  /** Server→client request (answered after the drain) vs notification. */
  request?: IncomingCodexRequest;
  method: string;
  params: Record<string, unknown>;
}

interface AriSession {
  ariId: string;
  /** Last assigned ARI seq; the next event uses `seq + 1`. */
  seq: number;
  nextTurn: number;
  /** ARI turn → Codex turn id, for `session/fork{atTurn}`. */
  turns: Map<number, string>;
  openTurn?: OpenTurn;
  /** Prompts accepted but not yet claimed, FIFO. */
  queue: QueuedPrompt[];
  /** The receipt whose `turn/start` forward is in flight, if any. */
  forwardReceipt?: string;
  /** Outstanding `thread/start`/`turn/start` forwards (the notification gate). */
  pendingReceipts: number;
  /** Inbound frames parked while `pendingReceipts > 0`, in arrival order. */
  pendingRaw: ParkedInbound[];
  /** Resolvers waiting for `pendingReceipts` to reach 0 (session/cancel). */
  forwardWaiters: (() => void)[];
  /** Items with `tool/started` but no `tool/completed`, for the snapshot. */
  openTools: Map<string, { name: string }>;
  /** Item ids whose agent text streamed as deltas (fallback suppression). */
  streamedMessages: Set<string>;
  /** Output bytes already streamed per command item (double-stream guard). */
  streamedToolOutput: Map<string, number>;
  /** Codex turn id whose compaction already produced an ARI event. */
  lastCompactionTurn?: string;
  /** Last usage observed, for the resume snapshot. */
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; reasoningTokens?: number };
  /** Every event emitted for this session, in seq order (the ledger). */
  ledger: Record<string, unknown>[];
}

export class CodexAriAdapter {
  private readonly options: AdapterOptions;
  private readonly log: (message: string) => void;
  private readonly write: (message: unknown) => Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  private initialized = false;
  private shuttingDown = false;

  private codex: CodexClient | undefined;
  private codexBoot: Promise<void> | undefined;
  private codexAgentVersion = "unknown";
  /** Deliberate kill (shutdown) vs an unexpected runtime death. */
  private killingCodex = false;

  private readonly sessions = new Map<string, AriSession>();
  /** Thread ids offered through `session/list`, promptable by adoption. */
  private readonly adoptable = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly resolvedApprovals = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly resolvedQuestions = new Map<string, PendingQuestion>();
  private nextMessageId = 1;

  constructor(options: AdapterOptions, output: Writable) {
    this.options = options;
    this.write = createFrameWriter(output);
    this.log = options.log ?? (() => undefined);
  }

  get capabilities(): AgentCapabilities {
    if (this.options.minimal === true) {
      const none: AgentCapabilities = { ...CODEX_AGENT_CAPABILITIES };
      for (const key of Object.keys(none) as (keyof AgentCapabilities)[]) none[key] = false;
      return none;
    }
    return CODEX_AGENT_CAPABILITIES;
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
    let body: Record<string, unknown> = { ...(draft as Record<string, unknown>), sessionId: session.ariId, seq };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1_048_576) {
      this.log(`dropped event ${draft.type}: exceeds the 1 MiB frame cap even after chunking`);
      return;
    }

    session.seq = seq;
    session.ledger.push(body);
    this.enqueueWrite({ jsonrpc: "2.0", method: "event", params: body });
  }

  // ── Codex lifecycle ─────────────────────────────────────────────────────

  /** Spawn (or reuse) the app-server and complete its handshake. */
  private ensureCodex(): Promise<void> {
    if (this.codex !== undefined && this.codexBoot !== undefined) return this.codexBoot;
    this.killingCodex = false;
    const spec = this.options.codex;
    this.log(`starting Codex app-server: ${spec.command} ${spec.args.join(" ")}`);

    const client = CodexClient.spawn({
      spec,
      cwd: this.options.cwd ?? process.cwd(),
      log: (message) => this.log(message),
      onNotification: (method, params) => this.onCodexNotification(method, params),
      onServerRequest: (request) => this.onCodexServerRequest(request),
      onClose: () => this.onCodexClosed(),
    });
    this.codex = client;
    this.codexBoot = client
      .initialize()
      .then((result) => {
        this.codexAgentVersion = String(result.userAgent ?? "unknown");
        this.log(`Codex handshake complete: ${this.codexAgentVersion}`);
      })
      .catch((error) => {
        // Leave the connection uninitialized so the shell MAY retry initialize.
        this.codex = undefined;
        this.codexBoot = undefined;
        throw error;
      });
    return this.codexBoot;
  }

  private killCodex(): void {
    if (this.codex === undefined) return;
    this.killingCodex = true;
    this.codex.kill();
    this.codex = undefined;
    this.codexBoot = undefined;
  }

  /**
   * The app-server died. A deliberate kill was already settled by the
   * shutdown path; an unexpected death is settled here so no turn stays open
   * (SPEC §8-I1), no interaction stays pending (§8-I7), and no session sticks
   * in `running` (§8-I6).
   */
  private onCodexClosed(): void {
    this.codex = undefined;
    this.codexBoot = undefined;
    if (this.killingCodex) return;
    this.log("Codex app-server closed unexpectedly; settling open turns as errors");
    for (const session of this.sessions.values()) {
      session.pendingRaw = [];
      session.pendingReceipts = 0;
      this.releaseForwardWaiters(session);
      if (session.openTurn !== undefined) {
        const turn = session.openTurn.ariTurn;
        session.openTurn = undefined;
        this.emit(session, {
          type: "session/error",
          error: { code: -32603, message: "Codex app-server closed unexpectedly" },
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
          error: { code: -32603, message: "Codex app-server closed unexpectedly" },
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
        await this.handleFork(params, id);
        return;
      case "session/list":
        this.requireInitialized(method);
        await this.handleSessionList(id);
        return;
      case "approval/respond":
        this.requireInitialized(method);
        this.handleApprovalRespond(params, id);
        return;
      case "question/respond":
        this.requireInitialized(method);
        this.handleQuestionRespond(params, id);
        return;
      case "shutdown":
        this.requireInitialized(method);
        await this.handleShutdown(id);
        return;
      default:
        throw new AriError(-32601, `method not found: ${method}`);
    }
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
    // The Codex handshake decides whether this adapter can serve at all; a
    // failure surfaces here (the shell MAY retry initialize).
    await this.ensureCodex();
    this.initialized = true;
    this.respond(id, {
      protocolVersion: 1,
      agentInfo: { name: "codex", version: this.codexAgentVersion },
      agentCapabilities: this.capabilities,
    });
  }


  private async handleSessionNew(params: unknown, id: unknown): Promise<void> {
    const cwd = isRecord(params) && typeof params["cwd"] === "string" ? params["cwd"] : this.options.cwd;
    const client = await this.requireCodex();
    const session = this.blankSession("pending");
    // Gate: the app-server may emit thread/started (or anything else for this
    // thread) before the response; park it until the ARI response is queued.
    session.pendingReceipts += 1;
    try {
      const result = await client.request("thread/start", {
        ...(cwd !== undefined ? { cwd } : {}),
      });
      const thread = (isRecord(result) ? result["thread"] : undefined) as unknown as CodexThread | undefined;
      if (thread === undefined || typeof thread["id"] !== "string") {
        throw ariErrors.internal("Codex thread/start returned no thread id");
      }
      session.ariId = thread["id"];
      this.sessions.set(session.ariId, session);
      this.adoptable.add(session.ariId);
      this.respond(id, { sessionId: session.ariId, nextSeq: 1 });
    } catch (error) {
      throw error instanceof AriError
        ? error
        : ariErrors.internal(`Codex thread/start failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      session.pendingReceipts -= 1;
      this.drainParked(session);
    }
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

    const messageId = `m_${this.nextMessageId++}`;
    const limit = this.options.queueLimit;
    if (limit !== undefined && session.queue.length >= limit && !this.canForwardNow(session)) {
      throw ariErrors.queueFull(session.queue.length, limit);
    }

    if (this.canForwardNow(session)) {
      // Idle: forward immediately, behind the notification gate.
      session.pendingReceipts += 1;
      session.forwardReceipt = messageId;
      let failed = false;
      try {
        await this.forwardTurnStart(session, text, messageId);
        this.respond(id, { messageId });
      } catch (error) {
        failed = true;
        this.respondError(
          id,
          ariErrors.internal(`Codex turn/start failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      } finally {
        session.pendingReceipts -= 1;
        // On success the parked turn/started still needs the receipt to
        // claim; only a failed forward gives it up (onTurnStarted clears it).
        if (failed) session.forwardReceipt = undefined;
        this.releaseForwardWaiters(session);
        this.drainParked(session);
      }
      return;
    }

    // A turn is running (or starting): enqueue without interrupting it
    // (SPEC §7.3); steering is not an ARI semantic.
    session.queue.push({ messageId, text });
    this.respond(id, { messageId });
  }

  /** True when a `turn/start` may be forwarded right now. */
  private canForwardNow(session: AriSession): boolean {
    return session.openTurn === undefined && session.pendingReceipts === 0 && session.queue.length === 0;
  }

  /** `session/prompt` on a thread offered by `session/list` adopts it. */
  private sessionOrPromptable(ariId: unknown): AriSession {
    if (typeof ariId !== "string") throw ariErrors.invalidParams("sessionId must be a string");
    const known = this.sessions.get(ariId);
    if (known !== undefined) return known;
    if (this.adoptable.has(ariId)) {
      const adopted = this.blankSession(ariId);
      this.sessions.set(ariId, adopted);
      return adopted;
    }
    throw ariErrors.sessionNotFound(ariId);
  }

  private async forwardTurnStart(session: AriSession, text: string, messageId: string): Promise<void> {
    const client = await this.requireCodex();
    await client.turnStart(session.ariId, text, messageId);
  }

  private async requireCodex() {
    await this.ensureCodex();
    const client = this.codex;
    if (client === undefined) throw ariErrors.internal("Codex app-server is not running");
    return client;
  }

  private async handleCancel(params: unknown, id: unknown): Promise<void> {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/cancel requires params");
    const session = this.sessionOrThrow(params["sessionId"]);

    // A start forward in flight means the turn is about to exist; wait for it
    // to land so the interrupt (or the no-op) sees the truth.
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
      const client = this.codex;
      if (client !== undefined) {
        // Codex settles the turn itself: turn/completed{interrupted} arrives
        // on the wire and is translated to stopReason "cancelled".
        await client.turnInterrupt(session.ariId, session.openTurn.codexTurnId).catch(async (error) => {
          this.log(`turn/interrupt failed: ${String(error)}; settling locally`);
          this.settleInterruptedLocally(session);
        });
      } else {
        this.settleInterruptedLocally(session);
      }
    }

    const result: SessionCancelResult = {
      droppedMessageIds: dropped,
      ...(cancelledTurn !== undefined ? { cancelledTurn } : {}),
    };
    this.respond(id, result);
  }

  /** Fallback when the interrupt itself cannot reach the runtime. */
  private settleInterruptedLocally(session: AriSession): void {
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
    const codexTurnId = session.turns.get(atTurn);
    if (codexTurnId === undefined) {
      throw ariErrors.invalidParams(`atTurn ${atTurn} is not a known turn boundary`);
    }

    const client = await this.requireCodex();
    try {
      const result = await client.threadFork(session.ariId, codexTurnId);
      const threadId = result.thread.id;
      this.sessions.set(threadId, this.blankSession(threadId));
      this.adoptable.add(threadId);
      this.respond(id, {
        sessionId: threadId,
        nextSeq: 1,
        forkedFrom: { sessionId: session.ariId, turn: atTurn },
      });
    } catch (error) {
      throw ariErrors.internal(`Codex thread/fork failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleSessionList(id: unknown): Promise<void> {
    const client = await this.requireCodex();
    try {
      const result = await client.threadList();
      const sessions: Record<string, unknown>[] = [];
      for (const entry of result.data) {
        if (!isRecord(entry)) continue;
        const thread = entry as unknown as CodexThread;
        if (typeof thread.id !== "string") continue;
        this.adoptable.add(thread.id);
        sessions.push({
          sessionId: thread.id,
          status: mapSessionStatus(thread.status),
          ...(typeof thread.cwd === "string" && thread.cwd !== "" ? { cwd: thread.cwd } : {}),
          ...(typeof thread.name === "string" && thread.name !== "" ? { title: thread.name } : {}),
          ...(typeof thread.createdAt === "number"
            ? { createdAt: new Date(thread.createdAt * 1000).toISOString() }
            : {}),
        });
      }
      this.respond(id, { sessions });
    } catch (error) {
      throw ariErrors.internal(`Codex thread/list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleApprovalRespond(params: unknown, id: unknown): void {
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

    this.pendingApprovals.delete(approvalId);
    this.resolvedApprovals.set(approvalId, { ...pending, decision });
    pending.respond(mapApprovalDecisionOut(decision));
    this.respond(id, {});
    const session = this.sessions.get(pending.sessionId);
    if (session !== undefined) {
      this.emit(session, { type: "approval/resolved", approvalId, decision });
    }
  }

  private handleQuestionRespond(params: unknown, id: unknown): void {
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
    this.pendingQuestions.delete(questionId);
    this.resolvedQuestions.set(questionId, { ...pending, answers: mapped });
    pending.respond(mapAnswersOut(mapped));
    this.respond(id, {});
    const session = this.sessions.get(pending.sessionId);
    if (session !== undefined) {
      this.emit(session, {
        type: "question/resolved",
        questionId,
        outcome: mapped.length === 0 ? "declined" : "answered",
      });
    }
  }

  private async handleShutdown(id: unknown): Promise<void> {
    this.shuttingDown = true;
    // The app-server wire has no shutdown method; SIGTERM is the upstream
    // goodbye (the transport carries a 45 s drain deadline).
    this.killCodex();
    this.respond(id, {});
    await this.drainWrites();
    this.log("shutdown complete");
    this.options.exit?.(0);
  }

  // ── Codex inbound: notifications ────────────────────────────────────────

  private onCodexNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    const threadId = params["threadId"];
    if (typeof threadId !== "string") {
      this.log(`ignoring Codex notification without a threadId: ${method}`);
      return;
    }
    const session = this.sessions.get(threadId);
    if (session === undefined) {
      // Threads the adapter did not create (or adopt) are not ours to show.
      return;
    }
    if (session.pendingReceipts > 0) {
      session.pendingRaw.push({ method, params });
      return;
    }
    this.processNotification(session, method, params);
  }

  /** Process parked inbound frames in arrival order until none are gated. */
  private drainParked(session: AriSession): void {
    while (session.pendingReceipts === 0 && session.pendingRaw.length > 0) {
      const parked = session.pendingRaw.shift();
      if (parked === undefined) break;
      if (parked.request !== undefined) {
        this.processServerRequest(parked.request, session);
      } else {
        this.processNotification(session, parked.method, parked.params);
      }
    }
  }

  private processNotification(session: AriSession, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "turn/started":
        this.onTurnStarted(session, params);
        return;
      case "turn/completed":
        this.onTurnCompleted(session, params);
        return;
      case "item/started":
        this.onItemStarted(session, params);
        return;
      case "item/completed":
        this.onItemCompleted(session, params);
        return;
      case "item/agentMessage/delta":
        this.onAgentMessageDelta(session, params);
        return;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        this.onReasoningDelta(session, params);
        return;
      case "item/commandExecution/outputDelta":
        this.onCommandOutputDelta(session, params);
        return;
      case "thread/tokenUsage/updated":
        this.onTokenUsage(session, params);
        return;
      case "error":
        this.onErrorNotification(session, params);
        return;
      case "thread/compacted":
        this.onThreadCompacted(session, params);
        return;
      case "serverRequest/resolved":
        this.onServerRequestResolved(params);
        return;
      default:
        // Out of ARI's vocabulary (plan updates, diffs, realtime, warnings…):
        // runtime-internal or presentational (SPEC §1.2 non-goals).
        return;
    }
  }

  private onTurnStarted(session: AriSession, params: Record<string, unknown>): void {
    const turn = params["turn"] as { id?: string } | undefined;
    const codexTurnId = typeof turn?.["id"] === "string" ? turn["id"] : `codex_${session.nextTurn}`;
    // Claim the receipt the in-flight (or just-landed) forward carried; a turn
    // nobody prompted for gets a synthesized id (SPEC §7.3 obligation).
    const claimed = session.forwardReceipt ?? `m_adapted_${session.nextTurn}`;
    session.forwardReceipt = undefined;
    const ariTurn = session.nextTurn++;
    session.turns.set(ariTurn, codexTurnId);
    session.openTurn = { ariTurn, codexTurnId, errorAnnounced: false };
    this.emit(session, { type: "turn/started", turn: ariTurn, messageIds: [claimed] });
    this.emit(session, { type: "session/status", status: "running" });
  }

  private onTurnCompleted(session: AriSession, params: Record<string, unknown>): void {
    const open = session.openTurn;
    const turn = params["turn"] as { id?: string; status?: string; error?: { message?: string } } | undefined;
    if (open === undefined || turn === undefined || turn["id"] !== open.codexTurnId) {
      this.log(`dropping turn/completed without a matching open turn (codex turn ${String(turn?.["id"])})`);
      return;
    }
    session.openTurn = undefined;
    const mapped = mapTurnEnd({
      id: open.codexTurnId,
      status: typeof turn["status"] === "string" ? turn["status"] : "completed",
      error: turn["error"],
    });
    if (mapped.error !== undefined && !open.errorAnnounced) {
      // I2/I3: diagnostics first, settlement second, every time.
      this.emit(session, { type: "session/error", error: mapped.error, turn: open.ariTurn });
    }
    this.emit(session, { type: "turn/completed", turn: open.ariTurn, stopReason: mapped.stopReason });
    this.emit(session, { type: "session/status", status: "idle" });
    this.startQueuedTurn(session);
  }

  /** Start the next queued prompt, if the session is idle again. */
  private startQueuedTurn(session: AriSession): void {
    if (session.openTurn !== undefined || session.queue.length === 0 || session.pendingReceipts > 0) return;
    const next = session.queue.shift();
    if (next === undefined) return;
    void (async () => {
      session.pendingReceipts += 1;
      session.forwardReceipt = next.messageId;
      let failed = false;
      try {
        await this.forwardTurnStart(session, next.text, next.messageId);
      } catch (error) {
        failed = true;
        this.log(`queued turn/start failed: ${String(error)}`);
      } finally {
        session.pendingReceipts -= 1;
        if (failed) session.forwardReceipt = undefined;
        this.releaseForwardWaiters(session);
        this.drainParked(session);
      }
    })();
  }

  private onItemStarted(session: AriSession, params: Record<string, unknown>): void {
    const item = params["item"] as CodexItem | undefined;
    if (item === undefined || typeof item["id"] !== "string") return;
    const callId = item["id"];
    const turn = session.openTurn?.ariTurn;
    if (item["type"] === "commandExecution") {
      session.openTools.set(callId, { name: "shell" });
      session.streamedToolOutput.set(callId, 0);
      this.emit(
        session,
        withTurn(
          {
            type: "tool/started",
            callId,
            name: "shell",
            ...(typeof item["command"] === "string"
              ? { input: { command: item["command"], ...(typeof item["cwd"] === "string" ? { cwd: item["cwd"] } : {}) } }
              : {}),
          },
          turn,
        ),
      );
      return;
    }
    if (item["type"] === "mcpToolCall") {
      const name = `${String(item["server"] ?? "mcp")}.${String(item["tool"] ?? "tool")}`;
      session.openTools.set(callId, { name });
      this.emit(session, withTurn({ type: "tool/started", callId, name, input: item["arguments"] }, turn));
      return;
    }
    if (item["type"] === "subAgentActivity") {
      const draft: AriEventDraft = { type: "subagent/started", callId };
      if (typeof item["agentPath"] === "string" && item["agentPath"] !== "") draft.name = item["agentPath"];
      this.emit(session, draft);
      return;
    }
  }

  private onItemCompleted(session: AriSession, params: Record<string, unknown>): void {
    const item = params["item"] as CodexItem | undefined;
    if (item === undefined || typeof item["id"] !== "string") return;
    const callId = item["id"];
    const turn = session.openTurn?.ariTurn;
    switch (item["type"]) {
      case "commandExecution": {
        session.openTools.delete(callId);
        const streamed = session.streamedToolOutput.get(callId) ?? 0;
        session.streamedToolOutput.delete(callId);
        const mapped = mapCommandExecutionItem(item, callId);
        // The wire already streamed the payload in deltas (SPEC §4.2), so the
        // completion carries a summary for a large output — but a small one
        // is its own summary and rides the completion whole. A payload that
        // never streamed (history, odd runtimes) is streamed here instead.
        if (mapped.output !== undefined && mapped.output.length > TOOL_OUTPUT_STREAM_AT) {
          if (streamed === 0) {
            for (let at = 0; at < mapped.output.length; at += TOOL_OUTPUT_STREAM_AT) {
              this.emit(session, {
                type: "tool/updated",
                callId,
                status: "running",
                outputDelta: mapped.output.slice(at, at + TOOL_OUTPUT_STREAM_AT),
              });
            }
          }
          this.emit(session, {
            type: "tool/completed",
            callId,
            status: mapped.status,
            output: `${mapped.output.slice(0, TOOL_OUTPUT_SUMMARY_CHARS)}… [${mapped.output.length} chars, streamed in deltas]`,
          });
        } else if (streamed > 0 && mapped.output !== undefined && mapped.output.length > TOOL_OUTPUT_SUMMARY_CHARS) {
          this.emit(session, {
            type: "tool/completed",
            callId,
            status: mapped.status,
            output: `${mapped.output.slice(0, TOOL_OUTPUT_SUMMARY_CHARS)}… [${mapped.output.length} chars streamed in deltas]`,
          });
        } else {
          this.emit(session, mapped);
        }
        return;
      }
      case "mcpToolCall":
        session.openTools.delete(callId);
        this.emit(session, mapMcpToolCallItem(item, callId));
        return;
      case "fileChange":
        for (const draft of mapFileChangeItem(item)) this.emit(session, draft);
        return;
      case "subAgentActivity":
        this.emit(session, {
          type: "subagent/finished",
          callId,
          status: mapSubagentStatus(item["kind"]),
        });
        return;
      case "contextCompaction": {
        const codexTurnId = typeof params["turnId"] === "string" ? params["turnId"] : undefined;
        if (codexTurnId !== undefined) session.lastCompactionTurn = codexTurnId;
        this.emit(session, { type: "compaction/performed", trigger: mapCompactionTrigger() });
        return;
      }
      case "agentMessage": {
        // Deltas usually carried the text; a settled message with none is
        // still delivered (the DSH adapter's synthesized-delta honesty).
        const alreadyStreamed = session.streamedMessages.delete(callId);
        const text = item["text"];
        if (!alreadyStreamed && typeof text === "string" && text !== "") {
          this.emit(session, withTurn({ type: "message/delta", text }, turn));
        }
        return;
      }
      default:
        return;
    }
  }

  private onAgentMessageDelta(session: AriSession, params: Record<string, unknown>): void {
    const itemId = params["itemId"];
    const delta = params["delta"];
    if (typeof delta !== "string" || delta === "") return;
    if (typeof itemId === "string") session.streamedMessages.add(itemId);
    this.emit(session, withTurn({ type: "message/delta", text: delta }, session.openTurn?.ariTurn));
  }

  private onReasoningDelta(session: AriSession, params: Record<string, unknown>): void {
    const delta = params["delta"];
    if (typeof delta !== "string" || delta === "") return;
    this.emit(session, withTurn({ type: "reasoning/delta", text: delta }, session.openTurn?.ariTurn));
  }

  private onCommandOutputDelta(session: AriSession, params: Record<string, unknown>): void {
    const callId = params["itemId"];
    const delta = params["delta"];
    if (typeof callId !== "string" || typeof delta !== "string" || delta === "") return;
    session.streamedToolOutput.set(callId, (session.streamedToolOutput.get(callId) ?? 0) + delta.length);
    this.emit(session, {
      type: "tool/updated",
      callId,
      status: "running",
      outputDelta: delta,
    });
  }

  private onTokenUsage(session: AriSession, params: Record<string, unknown>): void {
    const tokenUsage = params["tokenUsage"];
    const total = isRecord(tokenUsage) ? tokenUsage["total"] : undefined;
    const usage = mapUsage(total);
    if (usage === undefined) return;
    session.usage = usage;
    this.emit(session, withTurn({ type: "usage/updated", usage }, session.openTurn?.ariTurn));
  }

  private onErrorNotification(session: AriSession, params: Record<string, unknown>): void {
    const error = isRecord(params["error"]) ? params["error"] : {};
    const message = String(error["message"] ?? "Codex error");
    const willRetry = params["willRetry"] === true;
    const turn = session.openTurn?.ariTurn;
    if (willRetry) {
      // I4: retryable errors do not end the turn.
      this.emit(session, { type: "session/error", error: { code: -32603, message, retryable: true }, turn });
      return;
    }
    if (session.openTurn !== undefined) session.openTurn.errorAnnounced = true;
    this.emit(session, { type: "session/error", error: { code: -32603, message }, turn });
  }

  private onThreadCompacted(session: AriSession, params: Record<string, unknown>): void {
    const codexTurnId = params["turnId"];
    if (typeof codexTurnId === "string" && codexTurnId === session.lastCompactionTurn) return;
    session.lastCompactionTurn = typeof codexTurnId === "string" ? codexTurnId : session.lastCompactionTurn;
    this.emit(session, { type: "compaction/performed", trigger: mapCompactionTrigger() });
  }

  // ── Codex inbound: server→client requests ───────────────────────────────

  private onCodexServerRequest(request: IncomingCodexRequest): void {
    const threadId = request.params["threadId"];
    if (typeof threadId !== "string") {
      this.log(`declining Codex server request without a threadId: ${request.method}`);
      this.declineServerRequest(request);
      return;
    }
    const session = this.sessions.get(threadId);
    if (session === undefined) {
      this.log(`declining Codex server request for an unknown thread: ${request.method}`);
      this.declineServerRequest(request);
      return;
    }
    if (session.pendingReceipts > 0) {
      session.pendingRaw.push({ request, method: request.method, params: request.params });
      return;
    }
    this.processServerRequest(request, session);
  }

  private declineServerRequest(request: IncomingCodexRequest): void {
    request.respond({ error: { code: -32603, message: `adapter does not handle ${request.method}` } });
  }

  private processServerRequest(request: IncomingCodexRequest, session: AriSession): void {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        this.onCommandApprovalRequest(request, session);
        return;
      case "item/fileChange/requestApproval":
        this.onFileChangeApprovalRequest(request, session);
        return;
      case "item/tool/requestUserInput":
        this.onUserInputRequest(request, session);
        return;
      default:
        // Dynamic tool calls, MCP elicitations, auth refreshes: the adapter
        // registers no dynamic tools and serves none of these.
        this.log(`declining unhandled Codex server request: ${request.method}`);
        this.declineServerRequest(request);
        return;
    }
  }

  private onCommandApprovalRequest(request: IncomingCodexRequest, session: AriSession): void {
    const params = request.params as unknown as CodexCommandApprovalParams;
    const approvalId = typeof params["approvalId"] === "string" && params["approvalId"] !== ""
      ? params["approvalId"]
      : `ap_${String(request.id)}`;
    this.pendingApprovals.set(approvalId, {
      sessionId: session.ariId,
      requestId: request.id,
      respond: request.respond,
      decision: "allow_once",
    });
    this.emit(session, {
      type: "approval/requested",
      approvalId,
      ...(typeof params["itemId"] === "string" ? { toolCallId: params["itemId"] } : {}),
      toolName: "shell",
      ...(typeof params["reason"] === "string" && params["reason"] !== "" ? { reason: params["reason"] } : {}),
      options: COMMAND_APPROVAL_OPTIONS,
    });
  }

  private onFileChangeApprovalRequest(request: IncomingCodexRequest, session: AriSession): void {
    const params = request.params as unknown as CodexFileChangeApprovalParams;
    const approvalId = `ap_${String(request.id)}`;
    this.pendingApprovals.set(approvalId, {
      sessionId: session.ariId,
      requestId: request.id,
      respond: request.respond,
      decision: "allow_once",
    });
    this.emit(session, {
      type: "approval/requested",
      approvalId,
      ...(typeof params["itemId"] === "string" ? { toolCallId: params["itemId"] } : {}),
      toolName: "apply_patch",
      ...(typeof params["reason"] === "string" && params["reason"] !== "" ? { reason: params["reason"] } : {}),
      options: COMMAND_APPROVAL_OPTIONS,
    });
  }

  private onUserInputRequest(request: IncomingCodexRequest, session: AriSession): void {
    const params = request.params as unknown as CodexUserInputParams;
    const questionId = `q_${String(request.id)}`;
    const questions = mapQuestions(params["questions"] ?? []);
    this.pendingQuestions.set(questionId, {
      sessionId: session.ariId,
      requestId: request.id,
      respond: request.respond,
      answers: [],
    });
    this.emit(session, {
      type: "question/requested",
      questionId,
      questions,
    });
  }

  /** The runtime resolved a pending request itself (turn changed, aborted…). */
  private onServerRequestResolved(params: Record<string, unknown>): void {
    const requestId = params["requestId"];
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (sameRequestId(pending.requestId, requestId)) {
        // The interaction no longer exists (SPEC §10.3: a later answer is
        // -32007), so it is not recorded as a shell decision.
        this.pendingApprovals.delete(approvalId);
        const session = this.sessions.get(pending.sessionId);
        if (session !== undefined) {
          this.emit(session, { type: "approval/resolved", approvalId, decision: "cancelled" });
        }
        return;
      }
    }
    for (const [questionId, pending] of this.pendingQuestions) {
      if (sameRequestId(pending.requestId, requestId)) {
        this.pendingQuestions.delete(questionId);
        const session = this.sessions.get(pending.sessionId);
        if (session !== undefined) {
          this.emit(session, { type: "question/resolved", questionId, outcome: "expired" });
        }
        return;
      }
    }
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
      openTools: new Map(),
      streamedMessages: new Set(),
      streamedToolOutput: new Map(),
      ledger: [],
    };
  }

  /** Kill the runtime and drop all state; used when the ARI side goes away. */
  dispose(): void {
    this.killCodex();
  }
}

/** Attach the currently open ARI turn to a draft, when there is one. */
function withTurn<T extends AriEventDraft>(draft: T, turn: number | undefined): T {
  return turn === undefined ? draft : ({ ...draft, turn } as T);
}

function sameAnswers(a: { id: string; values: string[] }[], b: unknown): boolean {
  if (!Array.isArray(b)) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameRequestId(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}
