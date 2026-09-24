/**
 * ARI 1.0 Shell-side client — SPEC.md §3, §5, §7, §9, §10.
 *
 * This is what a Shell (IDE plugin, TUI, web UI, script) uses to drive a Harness.
 * It owns the transport, request/response correlation, per-session sequence
 * tracking, reconnect bookkeeping, and pending-interaction state.
 *
 * Design notes:
 *  - ARI uses client→server requests and server→client notifications only.
 *    There are no server→client requests, so this client needs no request router.
 *  - Capability gating is enforced by the Harness, not here. The client exposes
 *    `capabilities` so callers can avoid sending gated methods/params; if they
 *    send them anyway the Harness answers -32003 (SPEC §5.3).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AriError, ariErrors } from "./errors.ts";
import { createFrameWriter, readFrames } from "./framing.ts";
import {
  isEventNotification,
  isJsonRpcFailure,
  isJsonRpcResponse,
  type EventNotificationParams,
  type JsonRpcMessage,
} from "./jsonrpc.ts";
import {
  NO_CAPABILITIES,
  type AgentCapabilities,
  type AriEvent,
  type AriEventType,
  type AriMethodName,
  type AriMethods,
  type ApprovalDecision,
  type ContentBlock,
  type EmptyResult,
  type InitializeParams,
  type InitializeResult,
  type OpenToolCall,
  type PeerInfo,
  type PendingApproval,
  type PendingQuestion,
  type QuestionAnswer,
  type QueuedInput,
  type SessionCancelResult,
  type SessionForkResult,
  type SessionListParams,
  type SessionListResult,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptResult,
  type SessionResumeParams,
  type SessionResumeResult,
  type SessionSnapshot,
  type SessionStatus,
  type UsageInfo,
} from "./types.ts";

export interface AriClientOptions {
  /** Command to spawn (e.g. "node", "my-harness"). */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientInfo?: PeerInfo;
  /** Per-request timeout. Default 30000 ms. */
  requestTimeoutMs?: number;
  /** Harness logs go to stderr (SPEC §4.1); receive them here. */
  onStderr?: (chunk: string) => void;
}

/** Client-side view of a session, maintained from the event stream. */
export interface ClientSessionState {
  sessionId: string;
  /** The seq the next event is expected to carry. */
  nextSeq: number;
  status: SessionStatus;
  /** Currently open turn, if any. */
  turn?: number;
  nextTurn: number;
  queue: QueuedInput[];
  pendingApprovals: Map<string, PendingApproval>;
  pendingQuestions: Map<string, PendingQuestion>;
  openToolCalls: Map<string, OpenToolCall>;
  usage?: UsageInfo;
}

/** A sequence discontinuity observed on the wire. Recorded, never thrown. */
export interface SeqGap {
  sessionId: string;
  expected: number;
  received: number;
}

type EventListener = (event: AriEvent) => void;
type AnyListener = (params: EventNotificationParams) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AriClient {
  private readonly requestTimeoutMs: number;
  private write: ((message: unknown) => Promise<void>) | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly typedListeners = new Map<AriEventType, Set<AnyListener>>();
  private readonly sessions = new Map<string, ClientSessionState>();
  private readonly seqGaps: SeqGap[] = [];
  private closed = false;

  private agentCapabilitiesValue: AgentCapabilities = NO_CAPABILITIES;
  private agentInfoValue: PeerInfo | undefined;
  private initializedValue = false;
  private onStderrHandler: ((chunk: string) => void) | undefined;

  private constructor(options: { requestTimeoutMs: number; onStderr?: (chunk: string) => void }) {
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onStderrHandler = options.onStderr;
  }

  // ── construction ────────────────────────────────────────────────────

  /** Spawn a Harness process and speak ARI over its stdin/stdout (Binding A). */
  static spawn(options: AriClientOptions): AriClient {
    const client = new AriClient({
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    });

    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    client.child = child;
    client.write = createFrameWriter(child.stdin);
    client.pump(child.stdout);
    if (options.onStderr) child.stderr.setEncoding("utf8").on("data", options.onStderr);

    return client;
  }

  /**
   * Attach to an already-established pair of streams. Useful for in-process
   * Harness instances and for tests.
   */
  static attach(streams: {
    input: AsyncIterable<Uint8Array | string>;
    output: { write(chunk: string): boolean; once(e: string, cb: (...a: unknown[]) => void): unknown; off(e: string, cb: (...a: unknown[]) => void): unknown };
    requestTimeoutMs?: number;
    onStderr?: (chunk: string) => void;
  }): AriClient {
    const client = new AriClient({
      requestTimeoutMs: streams.requestTimeoutMs ?? 30_000,
      ...(streams.onStderr ? { onStderr: streams.onStderr } : {}),
    });
    client.write = createFrameWriter(streams.output as never);
    client.pump(streams.input);
    return client;
  }

  private async pump(source: AsyncIterable<Uint8Array | string>): Promise<void> {
    try {
      for await (const message of readFrames(source)) {
        this.handleMessage(message);
      }
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.closed = true;
      this.failAll(new AriError(-32000, "transport closed"));
    }
  }

  // ── observation ─────────────────────────────────────────────────────

  get capabilities(): AgentCapabilities {
    return this.agentCapabilitiesValue;
  }

  get agentInfo(): PeerInfo | undefined {
    return this.agentInfoValue;
  }

  get isInitialized(): boolean {
    return this.initializedValue;
  }

  /** Sequence discontinuities observed so far. Conformance asserts this is empty. */
  get gaps(): readonly SeqGap[] {
    return this.seqGaps;
  }

  getSession(sessionId: string): ClientSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Subscribe to every event, in wire order. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on(type: AriEventType, listener: AnyListener): () => void {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  // ── lifecycle ───────────────────────────────────────────────────────

  async initialize(overrides?: Partial<InitializeParams>): Promise<InitializeResult> {
    const params: InitializeParams = {
      protocolVersion: 1,
      clientInfo: overrides?.clientInfo ?? { name: "ari-shell", version: "1.0.0" },
      clientCapabilities: overrides?.clientCapabilities ?? { replay: true },
    };
    const result = await this.request("initialize", params);
    this.agentCapabilitiesValue = result.agentCapabilities;
    this.agentInfoValue = result.agentInfo;
    this.initializedValue = true;
    await this.notify("initialized");
    return result;
  }

  async newSession(params: SessionNewParams = {}): Promise<SessionNewResult> {
    const result = await this.request("session/new", params);
    this.sessions.set(result.sessionId, {
      sessionId: result.sessionId,
      nextSeq: result.nextSeq,
      status: "idle",
      nextTurn: 1,
      queue: [],
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      openToolCalls: new Map(),
    });
    return result;
  }

  /** Replay from `since` (or from the beginning) and adopt the returned snapshot. */
  async resumeSession(params: SessionResumeParams): Promise<SessionResumeResult> {
    const result = await this.request("session/resume", params);
    const state: ClientSessionState = {
      sessionId: result.sessionId,
      nextSeq: result.nextSeq,
      status: result.snapshot?.status ?? "idle",
      nextTurn: result.snapshot?.nextTurn ?? 1,
      queue: result.snapshot?.queue ?? [],
      pendingApprovals: new Map((result.snapshot?.pendingApprovals ?? []).map((a) => [a.approvalId, a])),
      pendingQuestions: new Map((result.snapshot?.pendingQuestions ?? []).map((q) => [q.questionId, q])),
      openToolCalls: new Map((result.snapshot?.openToolCalls ?? []).map((t) => [t.callId, t])),
      ...(result.snapshot?.usage ? { usage: result.snapshot.usage } : {}),
    };
    this.sessions.set(result.sessionId, state);
    return result;
  }

  /** Submit input. The receipt means "durably enqueued", never "turn finished". */
  async prompt(sessionId: string, content: ContentBlock[] | string): Promise<SessionPromptResult> {
    const blocks: ContentBlock[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    return this.request("session/prompt", { sessionId, content: blocks });
  }

  async cancel(sessionId: string, cause?: string): Promise<SessionCancelResult> {
    return this.request("session/cancel", cause === undefined ? { sessionId } : { sessionId, cause });
  }

  async forkSession(sessionId: string, atTurn?: number): Promise<SessionForkResult> {
    const result = await this.request(
      "session/fork",
      atTurn === undefined ? { sessionId } : { sessionId, atTurn },
    );
    this.sessions.set(result.sessionId, {
      sessionId: result.sessionId,
      nextSeq: result.nextSeq,
      status: "idle",
      nextTurn: 1,
      queue: [],
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      openToolCalls: new Map(),
    });
    return result;
  }

  async listSessions(params: SessionListParams = {}): Promise<SessionListResult> {
    return this.request("session/list", params);
  }

  async respondApproval(params: {
    sessionId: string;
    approvalId: string;
    decision: ApprovalDecision;
    amendedInput?: unknown;
  }): Promise<EmptyResult> {
    return this.request("approval/respond", params);
  }

  async respondQuestion(params: {
    sessionId: string;
    questionId: string;
    answers: QuestionAnswer[];
  }): Promise<EmptyResult> {
    return this.request("question/respond", params);
  }

  async shutdown(): Promise<EmptyResult> {
    const result = await this.request("shutdown", {});
    this.close();
    return result;
  }

  close(): void {
    this.closed = true;
    this.child?.kill();
    this.failAll(new AriError(-32000, "client closed"));
  }

  // ── raw access ──────────────────────────────────────────────────────

  /**
   * Send an arbitrary request. Conformance uses this to exercise paths the typed
   * helpers deliberately do not expose (unknown sessions, gated params, …).
   */
  async request<M extends AriMethodName>(
    method: M,
    params: AriMethods[M]["params"],
  ): Promise<AriMethods[M]["result"]> {
    return (await this.rawRequest(method, params)) as AriMethods[M]["result"];
  }

  async rawRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new AriError(-32000, "client is closed");
    const write = this.write;
    if (!write) throw new AriError(-32000, "client has no transport");

    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AriError(-32000, `request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    await write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const write = this.write;
    if (!write) throw new AriError(-32000, "client has no transport");
    await write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  // ── inbound ─────────────────────────────────────────────────────────

  private handleMessage(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      this.pending.delete(Number(message.id));
      clearTimeout(entry.timer);
      if (isJsonRpcFailure(message)) {
        const { code, message: text, data } = message.error;
        entry.reject(new AriError(code, text, data));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (isEventNotification(message)) {
      this.handleEvent(message.params);
      return;
    }

    // A server→client request is a protocol violation: ARI 1.0 does not use them.
    if (
      typeof message === "object" &&
      message !== null &&
      (message as JsonRpcMessage & { method?: unknown }).method !== undefined
    ) {
      void this.notify("x-ari/violation", { kind: "unexpected-notification" });
    }
  }

  private handleEvent(params: EventNotificationParams): void {
    const state = this.sessions.get(params.sessionId);
    if (state) {
      if (params.seq !== state.nextSeq) {
        this.seqGaps.push({
          sessionId: params.sessionId,
          expected: state.nextSeq,
          received: params.seq,
        });
      }
      state.nextSeq = params.seq + 1;
      this.applyEvent(state, params);
    }

    const event = params as unknown as AriEvent;
    for (const listener of this.eventListeners) listener(event);
    const typed = this.typedListeners.get(params.type as AriEventType);
    if (typed) for (const listener of typed) listener(params);
  }

  /** Fold an event into client-side session state. */
  private applyEvent(state: ClientSessionState, params: EventNotificationParams): void {
    switch (params.type) {
      case "session/status": {
        const status = params["status"];
        if (status === "running" || status === "idle") state.status = status;
        break;
      }
      case "turn/started": {
        const turn = params["turn"];
        if (typeof turn === "number") {
          state.turn = turn;
          state.nextTurn = turn + 1;
          state.status = "running";
        }
        break;
      }
      case "turn/completed": {
        state.turn = undefined;
        break;
      }
      case "tool/started": {
        const callId = params["callId"];
        const name = params["name"];
        if (typeof callId === "string" && typeof name === "string") {
          state.openToolCalls.set(callId, { callId, name, status: "running" });
        }
        break;
      }
      case "tool/updated": {
        const callId = params["callId"];
        const status = params["status"];
        const existing = typeof callId === "string" ? state.openToolCalls.get(callId) : undefined;
        if (existing && (status === "pending" || status === "running")) existing.status = status;
        break;
      }
      case "tool/completed": {
        const callId = params["callId"];
        if (typeof callId === "string") state.openToolCalls.delete(callId);
        break;
      }
      case "approval/requested": {
        const approvalId = params["approvalId"];
        if (typeof approvalId === "string") {
          state.pendingApprovals.set(approvalId, {
            approvalId,
            ...(typeof params["toolCallId"] === "string" ? { toolCallId: params["toolCallId"] } : {}),
            ...(typeof params["toolName"] === "string" ? { toolName: params["toolName"] } : {}),
            ...(typeof params["reason"] === "string" ? { reason: params["reason"] } : {}),
            ...(Array.isArray(params["options"]) ? { options: params["options"] as PendingApproval["options"] } : {}),
          });
        }
        break;
      }
      case "approval/resolved": {
        const approvalId = params["approvalId"];
        if (typeof approvalId === "string") state.pendingApprovals.delete(approvalId);
        break;
      }
      case "question/requested": {
        const questionId = params["questionId"];
        const questions = params["questions"];
        if (typeof questionId === "string" && Array.isArray(questions)) {
          state.pendingQuestions.set(questionId, {
            questionId,
            questions: questions as PendingQuestion["questions"],
          });
        }
        break;
      }
      case "question/resolved": {
        const questionId = params["questionId"];
        if (typeof questionId === "string") state.pendingQuestions.delete(questionId);
        break;
      }
      case "usage/updated": {
        const usage = params["usage"];
        if (typeof usage === "object" && usage !== null) state.usage = usage as UsageInfo;
        break;
      }
      default:
        break;
    }
  }

  /** Apply a snapshot to client-side state (used after resume). */
  applySnapshot(sessionId: string, snapshot: SessionSnapshot): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.status = snapshot.status;
    state.nextTurn = snapshot.nextTurn;
    state.queue = snapshot.queue;
    state.pendingApprovals = new Map(snapshot.pendingApprovals.map((a) => [a.approvalId, a]));
    state.pendingQuestions = new Map(snapshot.pendingQuestions.map((q) => [q.questionId, q]));
    state.openToolCalls = new Map(snapshot.openToolCalls.map((t) => [t.callId, t]));
    if (snapshot.usage) state.usage = snapshot.usage;
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
