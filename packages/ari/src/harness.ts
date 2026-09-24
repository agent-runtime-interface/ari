/**
 * ARI 1.0 Harness-side helper — SPEC.md §3, §4, §5, §7, §8, §9, §10, §11.
 *
 * The point of this helper is to make the settlement invariants *structural*
 * rather than conventional. A harness built on it cannot, by construction:
 *
 *   - emit an event for a capability it declared `false`        (SPEC §5.3)
 *   - leave a gap in the per-session `seq`                      (SPEC §9.1)
 *   - start a turn without claiming `messageIds`                (SPEC §7.3)
 *   - run two turns at once, or settle one twice                (SPEC §8-I1)
 *   - finish a turn without a settlement event                  (SPEC §8-I1)
 *   - let `session/error` stand in for `turn/completed`          (SPEC §8-I2/I3)
 *   - leave an interaction unresolved, or resolve one twice      (SPEC §8-I7)
 *   - send a prompt response after the events it caused          (SPEC §7.9)
 *   - reach `idle` while a turn is still open                    (SPEC §8-I6)
 *
 * Violations throw {@link AriInvariantError} at the offending call site instead
 * of producing a non-conformant stream.
 *
 * The harness author implements {@link HarnessDelegate.handleTurn}; everything
 * else (framing, gating, sequencing, queueing, settlement, replay, interactions)
 * is handled here.
 */

import { randomUUID } from "node:crypto";
import { AriError, AriErrorCode, ariErrors } from "./errors.ts";
import { createFrameWriter, encodeFrame, readFramesSafe } from "./framing.ts";
import { isJsonRpcNotification, isJsonRpcRequest, type JsonRpcRequest } from "./jsonrpc.ts";
import {
  EVENT_CAPABILITY,
  METHOD_CAPABILITY,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ApprovalDecision,
  type ApprovalOption,
  type ApprovalResolution,
  type AriEvent,
  type AriEventType,
  type BackgroundRunStatus,
  type CompactionTrigger,
  type ContentBlock,
  type FileChangeKind,
  type PeerInfo,
  type PendingApproval,
  type PendingQuestion,
  type QuestionAnswer,
  type QuestionOutcome,
  type QuestionSpec,
  type QueuedInput,
  type SessionListEntry,
  type SessionResumeResult,
  type SessionSnapshot,
  type SessionStatus,
  type StopReason,
  type SubagentResultStatus,
  type ToolResultStatus,
  type ToolRunStatus,
  type UsageInfo,
} from "./types.ts";

/** Thrown when a harness tries to produce a stream that would violate SPEC §8. */
export class AriInvariantError extends Error {
  constructor(message: string) {
    super(`ARI invariant violated: ${message}`);
    this.name = "AriInvariantError";
  }
}

/** Internal sentinel: `ctx.fail()` has already emitted and settled the turn. */
class TurnSettled extends Error {
  constructor() {
    super("turn settled by ctx.fail()");
    this.name = "TurnSettled";
  }
}

const STOP_REASONS: readonly StopReason[] = [
  "end_turn",
  "max_tokens",
  "cancelled",
  "refusal",
  "error",
];

const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: "allow_once", label: "Allow once" },
  { id: "allow_always", label: "Allow for this session" },
  { id: "deny", label: "Deny" },
];

// ── delegate surface ────────────────────────────────────────────────────

/**
 * Everything a turn is allowed to do. Every method is turn-scoped: once the turn
 * has settled, calling any of them throws (so a late tool completion cannot
 * appear after `turn/completed`).
 */
export interface TurnContext {
  readonly sessionId: string;
  readonly turn: number;
  /** The inputs this turn claimed from the pending-input queue (≥1). */
  readonly messages: readonly QueuedInput[];
  /** Aborted when `session/cancel` targets this turn. */
  readonly signal: AbortSignal;
  /** True once `session/cancel` has targeted this turn. */
  readonly cancelled: boolean;

  messageDelta(text: string): void;
  reasoningDelta(text: string): void;

  /** Registers and starts a tool call. Returns the `callId` (generated if omitted). */
  toolStarted(input: { callId?: string; name: string; input?: unknown }): string;
  toolUpdated(input: { callId: string; status?: ToolRunStatus; title?: string; outputDelta?: string }): void;
  toolCompleted(input: { callId: string; status: ToolResultStatus; output?: string; meta?: unknown }): void;

  /** Blocks until answered. Resolves with the decision, or "expired"/"cancelled". */
  requestApproval(input?: {
    toolCallId?: string;
    toolName?: string;
    reason?: string;
    options?: ApprovalOption[];
  }): Promise<ApprovalResolution>;

  /** Blocks until answered. `answers: []` is an explicit decline (SPEC §10.2). */
  requestQuestion(input: { questions: QuestionSpec[] }): Promise<{
    questionId: string;
    outcome: QuestionOutcome;
    answers: QuestionAnswer[];
  }>;

  usage(usage: UsageInfo): void;
  compactionPerformed(input: { trigger: CompactionTrigger; preTokens?: number; postTokens?: number }): void;
  fileChanged(input: { path: string; kind: FileChangeKind; diff?: string }): void;

  subagentStarted(input?: { callId?: string; childSessionId?: string; name?: string }): void;
  subagentFinished(input: {
    callId?: string;
    childSessionId?: string;
    status: SubagentResultStatus;
    summary?: string;
  }): void;

  backgroundStarted(input: { taskId: string; title?: string }): void;
  backgroundUpdated(input: {
    taskId: string;
    status: BackgroundRunStatus;
    title?: string;
    outputDelta?: string;
  }): void;
  backgroundFinished(input: { taskId: string; status: SubagentResultStatus; output?: string }): void;

  /** Out-of-band diagnostics that do NOT end the turn (SPEC §8-I4). */
  error(input: { code: number; message: string; retryable?: boolean }): void;

  /**
   * Emit `session/error` and end the turn with `stopReason: "error"`
   * (SPEC §8-I2/I3). Never returns — it throws to unwind the turn.
   */
  fail(input: { code: number; message: string; retryable?: boolean }): never;
}

export interface HarnessDelegate {
  /** Run one turn. Honour `ctx.signal` so `session/cancel` settles promptly. */
  handleTurn(ctx: TurnContext): Promise<StopReason>;

  /**
   * Required when `capabilities.fork` is true. Copy the harness's own
   * model-visible history up to `atTurn` into the newly created session.
   */
  onFork?(input: { sourceSessionId: string; newSessionId: string; atTurn: number }): Promise<void> | void;

  /** Optional override for `session/list`. Defaults to the helper's own registry. */
  onList?(input: { cwd?: string }): Promise<SessionListEntry[]> | SessionListEntry[];
}

export interface AriHarnessOptions {
  agentInfo: PeerInfo;
  capabilities: AgentCapabilities;
  delegate: HarnessDelegate;
  /** Pending-input queue depth per session. Exceeding it ⇒ `-32005`. Default 1000. */
  queueLimit?: number;
  /** Events kept per session for replay. Older events are dropped. Default 10000. */
  replayBufferLimit?: number;
  /** Expire an unanswered interaction after this long. Default: never (0). */
  interactionTimeoutMs?: number;
  /**
   * If a cancelled turn's delegate has not settled after this long, settle it
   * anyway so SPEC §7.4 holds even for a delegate that ignores `ctx.signal`.
   * Default 5000 ms; set to 0 to disable.
   */
  cancelGraceMs?: number;
}

// ── internal state ──────────────────────────────────────────────────────

interface PendingInteraction {
  id: string;
  kind: "approval" | "question";
  sessionId: string;
  turn: number;
  options?: ApprovalOption[];
  /** The payload as requested, for `snapshot.pendingApprovals`. */
  approval?: PendingApproval;
  question?: PendingQuestion;
  timer?: NodeJS.Timeout;
  resolve: (value: never) => void;
}

interface TurnState {
  turn: number;
  messageIds: string[];
  messages: QueuedInput[];
  cancelled: boolean;
  settled: boolean;
  controller: AbortController;
  tools: Set<string>;
  graceTimer?: NodeJS.Timeout;
}

interface SessionState {
  sessionId: string;
  /** The seq the next event will carry (SPEC §9.1: starts at 1). */
  seq: number;
  status: SessionStatus;
  nextTurn: number;
  queue: QueuedInput[];
  current?: TurnState;
  /** False until the session/new (or resume/fork) response has been sent. */
  ready: boolean;
  log: AriEvent[];
  openToolCalls: Map<string, { name: string; status: ToolRunStatus }>;
  pending: Map<string, PendingInteraction>;
  /** id ⇒ signature of the final answer, for idempotent re-answers (§10.3). */
  resolved: Map<string, string>;
  usage?: UsageInfo;
  cwd?: string;
  title?: string;
  createdAt: string;
}

interface MethodOutcome {
  result: unknown;
  /** Runs after the response has been flushed — used to preserve §7.9 ordering. */
  after?: () => void | Promise<void>;
}

// ── the harness ─────────────────────────────────────────────────────────

export class AriHarness {
  private readonly agentInfo: PeerInfo;
  private readonly capabilities: AgentCapabilities;
  private readonly delegate: HarnessDelegate;
  private readonly queueLimit: number;
  private readonly replayBufferLimit: number;
  private readonly interactionTimeoutMs: number;
  private readonly cancelGraceMs: number;

  private readonly sessions = new Map<string, SessionState>();
  private writer: ((message: unknown) => Promise<void>) | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: Error | undefined;
  private initialized = false;
  private shuttingDown = false;

  constructor(options: AriHarnessOptions) {
    this.agentInfo = options.agentInfo;
    this.capabilities = options.capabilities;
    this.delegate = options.delegate;
    this.queueLimit = options.queueLimit ?? 1000;
    this.replayBufferLimit = options.replayBufferLimit ?? 10_000;
    this.interactionTimeoutMs = options.interactionTimeoutMs ?? 0;
    this.cancelGraceMs = options.cancelGraceMs ?? 5000;

    // Fail fast rather than at the first request.
    if (this.capabilities.fork && !this.delegate.onFork) {
      throw new AriInvariantError("capabilities.fork is true but delegate.onFork is missing");
    }
  }

  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  get agentCapabilities(): AgentCapabilities {
    return this.capabilities;
  }

  /** Emit an out-of-band error with no turn attached (SPEC §8-I5). */
  emitSessionError(sessionId: string, error: { code: number; message: string; retryable?: boolean }): void {
    const session = this.#require(sessionId);
    this.#emit(session, { type: "session/error", error });
  }

  /**
   * Serve ARI over the given streams (Binding A). Resolves when the input ends.
   * The caller owns stdout purity (SPEC §4.1): logs belong on stderr.
   */
  async serve(input: AsyncIterable<Uint8Array | string>, output: NodeJS.WritableStream): Promise<void> {
    this.writer = createFrameWriter(output as never);

    for await (const frame of readFramesSafe(input)) {
      if (!frame.ok) {
        // A malformed or oversized frame must not kill the connection (SPEC §11.1).
        const code = frame.error.name === "FrameTooLargeError" ? -32000 : AriErrorCode.ParseError;
        this.#write({
          jsonrpc: "2.0",
          id: null,
          error: { code, message: frame.error.message },
        });
        await this.#flushQuiet();
        continue;
      }
      await this.#dispatch(frame.value);
      if (this.shuttingDown) break;
    }
  }

  // ── dispatch ──────────────────────────────────────────────────────────

  async #dispatch(message: unknown): Promise<void> {
    if (isJsonRpcNotification(message)) {
      // `initialized` is advisory and not gated (SPEC §5.2). Unknown
      // notifications are ignored, per the forward-compatibility rule (§12).
      return;
    }

    if (!isJsonRpcRequest(message)) {
      this.#write({
        jsonrpc: "2.0",
        id: null,
        error: { code: AriErrorCode.InvalidRequest, message: "not a JSON-RPC 2.0 request" },
      });
      await this.#flushQuiet();
      return;
    }

    const request: JsonRpcRequest = message;
    let outcome: MethodOutcome;
    try {
      outcome = await this.#call(request.method, request.params);
    } catch (error) {
      const ari =
        error instanceof AriError
          ? error
          : new AriError(AriErrorCode.InternalError, error instanceof Error ? error.message : String(error));
      this.#write({ jsonrpc: "2.0", id: request.id, error: { code: ari.code, message: ari.message, ...(ari.data !== undefined ? { data: ari.data } : {}) } });
      await this.#flushQuiet();
      return;
    }

    // The response must reach the peer before anything it causes (SPEC §7.9).
    try {
      this.#write({ jsonrpc: "2.0", id: request.id, result: outcome.result });
    } catch {
      // A response too large to frame is an internal fault, not a dead connection.
      this.#write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: AriErrorCode.InternalError, message: "response exceeds the 1 MiB frame cap" },
      });
    }
    await this.#flush();
    if (outcome.after) await outcome.after();
  }

  async #call(method: string, params: unknown): Promise<MethodOutcome> {
    if (method !== "initialize" && !this.initialized) throw ariErrors.notInitialized(method);

    const gated = METHOD_CAPABILITY[method];
    if (gated && !this.capabilities[gated]) throw ariErrors.unsupportedCapability(gated);

    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case "initialize":
        return { result: this.#initialize(p) };
      case "session/new":
        return this.#sessionNew(p);
      case "session/resume":
        return this.#sessionResume(p);
      case "session/prompt":
        return this.#sessionPrompt(p);
      case "session/cancel":
        return this.#sessionCancel(p);
      case "session/fork":
        return this.#sessionFork(p);
      case "session/list":
        return { result: await this.#sessionList(p) };
      case "approval/respond":
        return this.#approvalRespond(p);
      case "question/respond":
        return this.#questionRespond(p);
      case "shutdown":
        return { result: {}, after: () => { this.shuttingDown = true; } };
      default:
        throw new AriError(AriErrorCode.MethodNotFound, `unknown method: ${method}`);
    }
  }

  // ── handshake (§5) ────────────────────────────────────────────────────

  #initialize(params: Record<string, unknown>): unknown {
    if (this.initialized) throw ariErrors.alreadyInitialized();
    const requested = params["protocolVersion"];
    if (typeof requested !== "number" || !Number.isInteger(requested)) {
      throw ariErrors.invalidParams("protocolVersion must be an integer");
    }
    if (requested !== PROTOCOL_VERSION) {
      throw ariErrors.unsupportedProtocolVersion(requested, [PROTOCOL_VERSION]);
    }
    this.initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: this.agentInfo,
      agentCapabilities: this.capabilities,
    };
  }

  // ── session lifecycle (§7) ────────────────────────────────────────────

  #sessionNew(params: Record<string, unknown>): MethodOutcome {
    const session = this.#createSession({
      ...(typeof params["cwd"] === "string" ? { cwd: params["cwd"] } : {}),
    });
    // `ready` flips only after the response is on the wire, so no event can
    // precede it (SPEC §7.1).
    return { result: { sessionId: session.sessionId, nextSeq: 1 }, after: () => { session.ready = true; } };
  }

  #sessionResume(params: Record<string, unknown>): MethodOutcome {
    const session = this.#require(params["sessionId"]);
    const since = params["since"];

    if (since !== undefined) {
      if (!this.capabilities.replay) throw ariErrors.unsupportedCapability("replay");
      if (typeof since !== "number" || !Number.isInteger(since)) {
        throw ariErrors.invalidParams("since must be an integer");
      }
    } else if (!this.capabilities.replay) {
      // No log retained at all: nothing to replay (SPEC §7.2).
      throw ariErrors.replayUnavailable(session.sessionId);
    }

    const result = this.#replay(session, since as number | undefined);
    return { result, after: () => { session.ready = true; } };
  }

  #sessionPrompt(params: Record<string, unknown>): MethodOutcome {
    const session = this.#require(params["sessionId"]);
    const content = params["content"];
    if (!Array.isArray(content) || content.length === 0) {
      throw ariErrors.invalidParams("content must be a non-empty ContentBlock[]");
    }
    for (const block of content) {
      if (typeof block !== "object" || block === null || (block as ContentBlock).type !== "text") {
        throw ariErrors.invalidParams('ARI 1.0 defines only {"type":"text"} content blocks');
      }
    }
    if (session.queue.length >= this.queueLimit) {
      throw ariErrors.queueFull(session.queue.length, this.queueLimit);
    }

    const messageId = newId("m_");
    session.queue.push({ messageId, content: content as ContentBlock[] });

    // The receipt promises only "durably enqueued" (SPEC §7.3). The turn starts
    // after the receipt has been flushed.
    return {
      result: { messageId },
      after: () => {
        void this.#drain(session.sessionId);
      },
    };
  }

  #sessionCancel(params: Record<string, unknown>): MethodOutcome {
    const session = this.#require(params["sessionId"]);
    const droppedMessageIds = session.queue.splice(0).map((m) => m.messageId);
    const current = session.current;

    if (current && !current.settled) {
      current.cancelled = true;
      current.controller.abort();
      if (this.cancelGraceMs > 0) {
        current.graceTimer = setTimeout(() => {
          if (!current.settled) this.#settleTurn(session, current, "cancelled");
        }, this.cancelGraceMs);
        current.graceTimer.unref?.();
      }
    }

    return {
      result: {
        ...(current ? { cancelledTurn: current.turn } : {}),
        droppedMessageIds,
      },
    };
  }

  #sessionFork(params: Record<string, unknown>): MethodOutcome {
    const source = this.#require(params["sessionId"]);
    const lastTurn = source.nextTurn - 1;
    const atTurn = params["atTurn"] === undefined ? lastTurn : params["atTurn"];

    if (typeof atTurn !== "number" || !Number.isInteger(atTurn) || atTurn < 1 || atTurn > lastTurn) {
      throw ariErrors.invalidParams(`atTurn must be a turn boundary in [1, ${lastTurn}]`);
    }

    const forked = this.#createSession({
      ...(source.cwd !== undefined ? { cwd: source.cwd } : {}),
    });
    const onFork = this.delegate.onFork;

    return {
      result: {
        sessionId: forked.sessionId,
        nextSeq: 1,
        forkedFrom: { sessionId: source.sessionId, turn: atTurn },
      },
      after: async () => {
        // onFork is guaranteed present: the constructor rejects capabilities.fork
        // without it.
        if (onFork) await onFork({ sourceSessionId: source.sessionId, newSessionId: forked.sessionId, atTurn });
        forked.ready = true;
      },
    };
  }

  async #sessionList(params: Record<string, unknown>): Promise<unknown> {
    if (this.delegate.onList) {
      const listed = await this.delegate.onList({
        ...(typeof params["cwd"] === "string" ? { cwd: params["cwd"] } : {}),
      });
      return { sessions: listed };
    }
    const cwd = typeof params["cwd"] === "string" ? params["cwd"] : undefined;
    const sessions: SessionListEntry[] = [...this.sessions.values()]
      .filter((s) => s.ready && (cwd === undefined || s.cwd === cwd))
      .map((s) => ({
        sessionId: s.sessionId,
        status: s.status,
        createdAt: s.createdAt,
        ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
        ...(s.title !== undefined ? { title: s.title } : {}),
      }));
    return { sessions };
  }

  // ── interactions (§10) ────────────────────────────────────────────────

  #approvalRespond(params: Record<string, unknown>): MethodOutcome {
    const session = this.#require(params["sessionId"]);
    const approvalId = params["approvalId"];
    if (typeof approvalId !== "string") throw ariErrors.invalidParams("approvalId must be a string");

    const amended = params["amendedInput"];
    if (amended !== undefined && amended !== null && !this.capabilities.approvalEditInput) {
      throw ariErrors.unsupportedCapability("approvalEditInput");
    }

    const decision = params["decision"];
    if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") {
      throw ariErrors.invalidParams("decision must be allow_once | allow_always | deny");
    }

    const pending = session.pending.get(approvalId);
    if (!pending) {
      // Idempotent re-send of the same answer is safe; a conflicting one is not
      // (SPEC §10.3).
      const previous = session.resolved.get(approvalId);
      if (previous === undefined) throw ariErrors.unknownInteraction(approvalId);
      if (previous === decision) return { result: {} };
      throw ariErrors.unknownInteraction(approvalId);
    }
    if (pending.kind !== "approval") throw ariErrors.unknownInteraction(approvalId);

    const offered = pending.options ?? DEFAULT_APPROVAL_OPTIONS;
    if (!offered.some((option) => option.id === decision)) {
      throw ariErrors.invalidParams(`decision "${decision}" is not among the offered options`);
    }

    this.#resolveApproval(session, approvalId, decision);
    return { result: {} };
  }

  #questionRespond(params: Record<string, unknown>): MethodOutcome {
    const session = this.#require(params["sessionId"]);
    const questionId = params["questionId"];
    if (typeof questionId !== "string") throw ariErrors.invalidParams("questionId must be a string");

    const answers = params["answers"];
    if (!Array.isArray(answers)) throw ariErrors.invalidParams("answers must be an array");
    for (const answer of answers) {
      if (
        typeof answer !== "object" ||
        answer === null ||
        typeof (answer as QuestionAnswer).id !== "string" ||
        !Array.isArray((answer as QuestionAnswer).values)
      ) {
        throw ariErrors.invalidParams("each answer needs { id: string, values: string[] }");
      }
    }

    const signature = JSON.stringify(answers);
    const pending = session.pending.get(questionId);
    if (!pending) {
      const previous = session.resolved.get(questionId);
      if (previous === undefined) throw ariErrors.unknownInteraction(questionId);
      if (previous === signature) return { result: {} };
      throw ariErrors.unknownInteraction(questionId);
    }
    if (pending.kind !== "question") throw ariErrors.unknownInteraction(questionId);

    this.#resolveQuestion(session, questionId, answers.length === 0 ? "declined" : "answered", answers as QuestionAnswer[]);
    return { result: {} };
  }

  #resolveApproval(session: SessionState, approvalId: string, decision: ApprovalResolution): void {
    const pending = session.pending.get(approvalId);
    if (!pending) throw new AriInvariantError(`approval ${approvalId} is not pending`);
    // Emit before mutating: if the frame is refused the interaction stays
    // answerable rather than half-resolved. Emitting before resolving also keeps
    // the delegate's follow-up events after the resolved event (SPEC §10.3).
    this.#emit(session, { type: "approval/resolved", approvalId, decision });
    if (pending.timer) clearTimeout(pending.timer);
    session.pending.delete(approvalId);
    session.resolved.set(approvalId, decision);
    pending.resolve(decision as never);
  }

  #resolveQuestion(
    session: SessionState,
    questionId: string,
    outcome: QuestionOutcome,
    answers: QuestionAnswer[],
  ): void {
    const pending = session.pending.get(questionId);
    if (!pending) throw new AriInvariantError(`question ${questionId} is not pending`);
    this.#emit(session, { type: "question/resolved", questionId, outcome });
    if (pending.timer) clearTimeout(pending.timer);
    session.pending.delete(questionId);
    session.resolved.set(questionId, JSON.stringify(answers));
    pending.resolve({ questionId, outcome, answers } as never);
  }

  // ── turn machinery (§8) ───────────────────────────────────────────────

  async #drain(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.current || this.shuttingDown) return;

    while (session.queue.length > 0 && !this.shuttingDown) {
      const messages = session.queue.splice(0, session.queue.length);
      const turn = session.nextTurn++;
      const state: TurnState = {
        turn,
        messageIds: messages.map((m) => m.messageId),
        messages,
        cancelled: false,
        settled: false,
        controller: new AbortController(),
        tools: new Set(),
      };
      session.current = state;

      this.#setStatus(session, "running");
      this.#emit(session, { type: "turn/started", turn, messageIds: state.messageIds });

      let stopReason: StopReason = "end_turn";
      try {
        const returned = await this.delegate.handleTurn(this.#turnContext(session, state));
        if (!STOP_REASONS.includes(returned)) {
          throw new AriInvariantError(`handleTurn returned an unknown stopReason: ${String(returned)}`);
        }
        stopReason = returned;
      } catch (error) {
        if (error instanceof TurnSettled) {
          stopReason = "error";
        } else if (!state.cancelled) {
          // I2/I3: diagnostics first, then the settlement event. A cancellation
          // is not an error, so an abort-induced rejection reports nothing.
          stopReason = "error";
          this.#emit(session, {
            type: "session/error",
            turn,
            error: {
              code: error instanceof AriError ? error.code : AriErrorCode.InternalError,
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            },
          });
        }
      }

      if (!state.settled) {
        this.#settleTurn(session, state, state.cancelled ? "cancelled" : stopReason);
      }
      await this.#flushQuiet();
    }

    if (!session.current) this.#setStatus(session, "idle");
    await this.#flushQuiet();
  }

  /** The single place a turn may end — so it can never end twice or silently. */
  #settleTurn(session: SessionState, state: TurnState, stopReason: StopReason): void {
    if (state.settled) throw new AriInvariantError(`turn ${state.turn} settled twice`);
    if (state.graceTimer) {
      clearTimeout(state.graceTimer);
      state.graceTimer = undefined;
    }

    // Close dangling tool calls before settling, so no tool is left open (SPEC §9.2).
    for (const callId of [...state.tools]) {
      session.openToolCalls.delete(callId);
      this.#emit(session, {
        type: "tool/completed",
        callId,
        status: "error",
        output: "aborted: turn settled",
      });
    }
    state.tools.clear();

    // Every requested interaction must reach exactly one resolved event (I7).
    for (const pending of [...session.pending.values()]) {
      if (pending.turn !== state.turn) continue;
      if (pending.kind === "approval") {
        this.#resolveApproval(session, pending.id, stopReason === "cancelled" ? "cancelled" : "expired");
      } else {
        this.#resolveQuestion(session, pending.id, "expired", []);
      }
    }

    this.#emit(session, { type: "turn/completed", turn: state.turn, stopReason });
    state.settled = true;
    session.current = undefined;
  }

  #setStatus(session: SessionState, status: SessionStatus): void {
    if (session.status === status) return;
    session.status = status;
    this.#emit(session, { type: "session/status", status });
  }

  #turnContext(session: SessionState, state: TurnState): TurnContext {
    const live = (): void => {
      if (state.settled) {
        throw new AriInvariantError(
          `turn ${state.turn} has already settled; no event may follow its turn/completed`,
        );
      }
    };
    const turn = state.turn;
    const sessionId = session.sessionId;

    const requestApproval = (input?: {
      toolCallId?: string;
      toolName?: string;
      reason?: string;
      options?: ApprovalOption[];
    }): Promise<ApprovalResolution> => {
      live();
      const approvalId = newId("ap_");
      const approval: PendingApproval = {
        approvalId,
        ...(input?.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        ...(input?.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input?.reason !== undefined ? { reason: input.reason } : {}),
        ...(input?.options !== undefined ? { options: input.options } : {}),
      };
      const promise = new Promise<ApprovalResolution>((resolve) => {
        session.pending.set(approvalId, {
          id: approvalId,
          kind: "approval",
          sessionId,
          turn,
          approval,
          ...(input?.options !== undefined ? { options: input.options } : {}),
          resolve: resolve as (value: never) => void,
        });
      });
      this.#emit(session, { type: "approval/requested", ...approval });
      this.#armInteractionTimeout(session, approvalId);
      return promise;
    };

    const requestQuestion = (input: { questions: QuestionSpec[] }): Promise<{
      questionId: string;
      outcome: QuestionOutcome;
      answers: QuestionAnswer[];
    }> => {
      live();
      if (!this.capabilities.question) throw ariErrors.unsupportedCapability("question");
      const questionId = newId("q_");
      const question: PendingQuestion = { questionId, questions: input.questions };
      const promise = new Promise<{ questionId: string; outcome: QuestionOutcome; answers: QuestionAnswer[] }>(
        (resolve) => {
          session.pending.set(questionId, {
            id: questionId,
            kind: "question",
            sessionId,
            turn,
            question,
            resolve: resolve as (value: never) => void,
          });
        },
      );
      this.#emit(session, { type: "question/requested", ...question });
      this.#armInteractionTimeout(session, questionId);
      return promise;
    };

    return {
      sessionId,
      turn,
      messages: state.messages,
      signal: state.controller.signal,
      get cancelled(): boolean {
        return state.cancelled;
      },

      messageDelta: (text) => {
        live();
        this.#emit(session, { type: "message/delta", turn, text });
      },
      reasoningDelta: (text) => {
        live();
        this.#emit(session, { type: "reasoning/delta", turn, text });
      },

      toolStarted: (input) => {
        live();
        const callId = input.callId ?? newId("t_");
        if (session.openToolCalls.has(callId)) {
          throw new AriInvariantError(`tool ${callId} is already open`);
        }
        // Emit before mutating: a refused frame must not leave the Shell
        // believing a tool is open that it was never told about.
        this.#emit(session, {
          type: "tool/started",
          turn,
          callId,
          name: input.name,
          ...(input.input !== undefined ? { input: input.input } : {}),
        });
        session.openToolCalls.set(callId, { name: input.name, status: "running" });
        state.tools.add(callId);
        return callId;
      },
      toolUpdated: (input) => {
        live();
        const open = session.openToolCalls.get(input.callId);
        if (!open) throw new AriInvariantError(`tool ${input.callId} is not open`);
        const nextStatus = input.status ?? open.status;
        this.#emit(session, {
          type: "tool/updated",
          callId: input.callId,
          status: nextStatus,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.outputDelta !== undefined ? { outputDelta: input.outputDelta } : {}),
        });
        open.status = nextStatus;
      },
      toolCompleted: (input) => {
        live();
        if (!session.openToolCalls.has(input.callId)) {
          throw new AriInvariantError(`tool ${input.callId} is not open`);
        }
        this.#emit(session, {
          type: "tool/completed",
          callId: input.callId,
          status: input.status,
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.meta !== undefined ? { meta: input.meta } : {}),
        });
        session.openToolCalls.delete(input.callId);
        state.tools.delete(input.callId);
      },

      requestApproval,
      requestQuestion,

      usage: (usage) => {
        live();
        session.usage = usage;
        this.#emit(session, { type: "usage/updated", turn, usage });
      },
      compactionPerformed: (input) => {
        live();
        this.#emit(session, {
          type: "compaction/performed",
          trigger: input.trigger,
          ...(input.preTokens !== undefined ? { preTokens: input.preTokens } : {}),
          ...(input.postTokens !== undefined ? { postTokens: input.postTokens } : {}),
        });
      },
      fileChanged: (input) => {
        live();
        this.#emit(session, {
          type: "file/changed",
          path: input.path,
          kind: input.kind,
          ...(input.diff !== undefined ? { diff: input.diff } : {}),
        });
      },

      subagentStarted: (input) => {
        live();
        this.#emit(session, {
          type: "subagent/started",
          ...(input?.callId !== undefined ? { callId: input.callId } : {}),
          ...(input?.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
          ...(input?.name !== undefined ? { name: input.name } : {}),
        });
      },
      subagentFinished: (input) => {
        live();
        this.#emit(session, {
          type: "subagent/finished",
          status: input.status,
          ...(input.callId !== undefined ? { callId: input.callId } : {}),
          ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
        });
      },

      backgroundStarted: (input) => {
        live();
        this.#emit(session, {
          type: "background/started",
          taskId: input.taskId,
          ...(input.title !== undefined ? { title: input.title } : {}),
        });
      },
      backgroundUpdated: (input) => {
        live();
        this.#emit(session, {
          type: "background/updated",
          taskId: input.taskId,
          status: input.status,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.outputDelta !== undefined ? { outputDelta: input.outputDelta } : {}),
        });
      },
      backgroundFinished: (input) => {
        live();
        this.#emit(session, {
          type: "background/finished",
          taskId: input.taskId,
          status: input.status,
          ...(input.output !== undefined ? { output: input.output } : {}),
        });
      },

      error: (input) => {
        live();
        this.#emit(session, {
          type: "session/error",
          turn,
          error: {
            code: input.code,
            message: input.message,
            ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
          },
        });
      },
      fail: (input) => {
        live();
        this.#emit(session, {
          type: "session/error",
          turn,
          error: {
            code: input.code,
            message: input.message,
            ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
          },
        });
        this.#settleTurn(session, state, "error");
        throw new TurnSettled();
      },
    };
  }

  #armInteractionTimeout(session: SessionState, id: string): void {
    if (this.interactionTimeoutMs <= 0) return;
    const pending = session.pending.get(id);
    if (!pending) return;
    pending.timer = setTimeout(() => {
      if (!session.pending.has(id)) return;
      if (pending.kind === "approval") this.#resolveApproval(session, id, "expired");
      else this.#resolveQuestion(session, id, "expired", []);
    }, this.interactionTimeoutMs);
    pending.timer.unref?.();
  }

  // ── state, events, replay ─────────────────────────────────────────────

  #createSession(init: { cwd?: string; title?: string }): SessionState {
    const session: SessionState = {
      sessionId: newId("s_"),
      seq: 1,
      status: "idle",
      nextTurn: 1,
      queue: [],
      ready: false,
      log: [],
      openToolCalls: new Map(),
      pending: new Map(),
      resolved: new Map(),
      createdAt: new Date().toISOString(),
      ...(init.cwd !== undefined ? { cwd: init.cwd } : {}),
      ...(init.title !== undefined ? { title: init.title } : {}),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  #require(sessionId: unknown): SessionState {
    if (typeof sessionId !== "string") throw ariErrors.invalidParams("sessionId must be a string");
    const session = this.sessions.get(sessionId);
    if (!session) throw ariErrors.sessionNotFound(sessionId);
    return session;
  }

  /**
   * Assign a seq, validate capability gating and envelope-level invariants, then
   * queue the frame. Seq assignment is synchronous, so the stream can never
   * contain a gap regardless of write timing.
   */
  #emit(session: SessionState, payload: { type: AriEventType } & Record<string, unknown>): void {
    if (!session.ready) {
      throw new AriInvariantError(`event ${payload.type} emitted before the session was established`);
    }

    const capability = EVENT_CAPABILITY[payload.type];
    if (capability && !this.capabilities[capability]) {
      throw new AriInvariantError(
        `event ${payload.type} requires capability "${capability}", which this harness declared false`,
      );
    }

    if (payload.type === "session/status" && payload["status"] === "idle" && session.current) {
      throw new AriInvariantError("session/status idle emitted while a turn is still open (SPEC §8-I6)");
    }
    if (payload.type === "turn/started") {
      if (!session.current || session.current.turn !== payload["turn"]) {
        throw new AriInvariantError("turn/started does not match the open turn");
      }
    }
    if (payload.type === "turn/completed") {
      if (!session.current || session.current.turn !== payload["turn"]) {
        throw new AriInvariantError("turn/completed does not match the open turn");
      }
    }

    // The envelope owns these three names; a payload must never shadow them
    // (SPEC §9.1). This is what a child-session id in a subagent payload would
    // otherwise do, silently retargeting the event at another session.
    for (const reserved of ["sessionId", "seq"] as const) {
      if (payload[reserved] !== undefined) {
        throw new AriInvariantError(
          `event payload for ${payload.type} may not set the reserved envelope field "${reserved}"`,
        );
      }
    }

    // Size-check before committing anything. A refused frame must not consume a
    // seq, otherwise the stream develops a gap (SPEC §4.2 + §9.1).
    // Envelope fields are spread last so they always win.
    const event = { ...payload, sessionId: session.sessionId, seq: session.seq } as unknown as AriEvent;
    const frame = { jsonrpc: "2.0", method: "event", params: event };
    encodeFrame(frame);

    session.seq += 1;

    if (this.capabilities.replay) {
      session.log.push(event);
      if (session.log.length > this.replayBufferLimit) {
        session.log.splice(0, session.log.length - this.replayBufferLimit);
      }
    }

    this.#enqueue(frame);
  }

  #replay(session: SessionState, since: number | undefined): SessionResumeResult {
    const base = session.log[0]?.seq ?? session.seq;
    let from = since ?? base;

    if (from > session.seq) {
      throw ariErrors.invalidParams(`since ${from} is beyond the current watermark ${session.seq}`);
    }
    // Falling behind the retention window degrades to snapshot + retained
    // events rather than failing (SPEC §7.2).
    if (from < base) from = base;

    return {
      sessionId: session.sessionId,
      replayedFrom: from,
      nextSeq: session.seq,
      events: session.log.filter((event) => event.seq >= from),
      snapshot: this.#snapshot(session),
    };
  }

  #snapshot(session: SessionState): SessionSnapshot {
    const pendingApprovals: PendingApproval[] = [];
    const pendingQuestions: PendingQuestion[] = [];
    for (const pending of session.pending.values()) {
      if (pending.kind === "approval" && pending.approval) pendingApprovals.push(pending.approval);
      if (pending.kind === "question" && pending.question) pendingQuestions.push(pending.question);
    }
    return {
      status: session.status,
      nextTurn: session.nextTurn,
      queue: session.queue.map((q) => ({ messageId: q.messageId, content: q.content })),
      pendingApprovals,
      pendingQuestions,
      openToolCalls: [...session.openToolCalls].map(([callId, value]) => ({
        callId,
        name: value.name,
        status: value.status,
      })),
      ...(session.usage !== undefined ? { usage: session.usage } : {}),
    };
  }

  // ── writing ───────────────────────────────────────────────────────────

  /**
   * Size-check synchronously (so an oversized message fails at its call site)
   * and then enqueue it.
   */
  #write(message: unknown): void {
    encodeFrame(message);
    this.#enqueue(message);
  }

  /** Append to the serialized write chain, without a size check. */
  #enqueue(message: unknown): void {
    this.writeChain = this.writeChain
      .then(() => this.writer?.(message))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.writeError ??= error instanceof Error ? error : new Error(String(error));
      });
  }

  /** Wait for the write chain, surfacing any write failure. */
  async #flush(): Promise<void> {
    await this.writeChain;
    if (this.writeError) {
      const error = this.writeError;
      this.writeError = undefined;
      throw error;
    }
  }

  /** Wait for the write chain, swallowing failures (used on paths already replying). */
  async #flushQuiet(): Promise<void> {
    await this.writeChain;
    this.writeError = undefined;
  }
}

// ── ids ─────────────────────────────────────────────────────────────────

/** Opaque, prefixed, ULID-ish identifier (SPEC §9.1). */
function newId(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
}
