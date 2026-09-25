/**
 * DSH → ARI adapter core.
 *
 * Role (see the repository handoff): the adapter is **not** a harness and does
 * not use `AriHarness`. It is a translator — it plays the ARI *server* toward
 * the shell and the DSH SDK *client* toward the real DeepSeek Harness runtime.
 *
 * What this file owns (state the pure mapper must not know about):
 *
 *  - **Renumbering.** ARI `seq` (from 1, dense) and `turn` (from 1) are
 *    adapter-assigned. DSH's own seq space includes log-only events and its
 *    turn counter restarts when the runtime process is recreated, so both are
 *    discarded on translation.
 *  - **The notification gate.** DSH appends `turn/start` synchronously inside
 *    `session/prompt`, so its notification reaches this adapter *before* the
 *    prompt response that carries the receipt. ARI forbids that ordering (the
 *    response MUST precede any event it caused, SPEC §7.9). While a prompt
 *    receipt is outstanding, every DSH notification for that session is
 *    parked in a per-session FIFO and processed only after the receipt lands.
 *  - **Receipt attribution.** DSH's `turn/start` carries no message ids, but
 *    ARI requires `turn/started.messageIds` (SPEC §7.3 correlation
 *    obligation). Each parked notification snapshots the claim window at
 *    arrival: every receipt already enqueued plus every receipt whose
 *    `session/prompt` is still outstanding. `turn/started` then claims exactly
 *    that window. This is exact for the sequential prompting ARI clients do;
 *    two prompts racing into one turn boundary cannot be distinguished on a
 *    wire that never says which messages a turn claimed — the window is the
 *    best reading the DSH SDK protocol offers. DSH only starts turns on
 *    client-driven prompts over this wire (injected context never wakes a
 *    turn), with a synthesized id as a safety net for anything else.
 *  - **Cancellation by process replacement.** The DSH SDK wire has no cancel
 *    method; a turn is abandoned by closing the runtime process (documented
 *    DSH limitation). The adapter maps ARI `session/cancel` to exactly that:
 *    kill the runtime, settle every open turn as `cancelled`, report dropped
 *    queue entries, emit `idle`, and lazily spawn a fresh runtime generation
 *    on the next prompt. Because one runtime hosts every session, a cancel
 *    settles all of them — the honest cost of DSH's process-wide idiom.
 *  - **Capability honesty.** The declared capability set (translate.ts) is
 *    exactly what the SDK wire can deliver; the emit path additionally drops
 *    any gated event whose capability is `false` (SPEC §5.3).
 */

import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import {
  AriError,
  ariErrors,
  createFrameWriter,
  EVENT_CAPABILITY,
  METHOD_CAPABILITY,
} from "../../ari/src/index.ts";
import type { AgentCapabilities, SessionCancelResult } from "../../ari/src/index.ts";
import { DshClient, type DshChildSpec } from "./dsh.ts";
import {
  compactionMemoFromStart,
  DSH_AGENT_CAPABILITIES,
  expandAssistantStream,
  isRecord,
  mapSubagentStatus,
  mapSubagentSummary,
  mapToolInput,
  mapToolResult,
  mapTurnEndReason,
  mapUsage,
  type DshSessionEvent,
} from "./translate.ts";
import type { AriEventDraft } from "./drafts.ts";

/** Drop `meta` from an event whose serialized size would approach the 1 MiB cap. */
const META_SIZE_GUARD = 700_000;
/** Stream tool output through `tool/updated` deltas above this size (SPEC §4.2). */
const TOOL_OUTPUT_STREAM_AT = 200_000;

export interface AdapterOptions {
  /** How to start the DSH runtime (e.g. `dsh --profile sdk` or the fake). */
  dsh: DshChildSpec;
  /** Working directory recorded by the DSH runtime at initialize. */
  cwd?: string;
  /** Provider/model route for DSH-created agents (DSH's own defaults when omitted). */
  provider?: string;
  model?: string;
  /** Pending-input queue limit; prompts beyond it are rejected -32005 (SPEC §7.3). */
  queueLimit?: number;
  /** Declare every capability false and suppress all gated events (conformance aid). */
  minimal?: boolean;
  log?: (message: string) => void;
  /** Called after the write queue drains following a shutdown response. */
  exit?: (code: number) => void;
}

interface AriSession {
  ariId: string;
  /** DSH session id for the current generation; allocated lazily on first prompt. */
  dshId?: string;
  generation: number;
  /** Last assigned ARI seq; the next event uses `seq + 1`. */
  seq: number;
  /** Next ARI turn number to hand out. */
  nextTurn: number;
  /** The in-flight ARI turn, if any. */
  openTurn?: number;
  /** Prompt receipts enqueued but not yet claimed by a turn. */
  inFlight: string[];
  /** Outstanding `session/prompt` forwards to DSH (the notification-gate counter). */
  pendingReceipts: number;
  /** DSH notifications parked while `pendingReceipts > 0`, in arrival order. */
  pendingRaw: ParkedNotification[];
  /** Remembered compaction data between `compaction/start` and `compaction/end`. */
  compaction?: { trigger: "manual" | "auto"; preTokens?: number };
}

interface ParkedNotification {
  method: string;
  params: Record<string, unknown>;
  /** Receipts claimable by a `turn/start`: enqueued + outstanding at arrival. */
  claimUpTo: number;
}

export class DshAriAdapter {
  private readonly options: AdapterOptions;
  private readonly log: (message: string) => void;
  private readonly write: (message: unknown) => Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  private initialized = false;
  private shuttingDown = false;

  private dsh: DshClient | undefined;
  private generation = 0;
  private dshServerInfo: { name: string; version: string } | undefined;
  private dshBoot: Promise<void> | undefined;
  /** Deliberate kill (cancel/shutdown) vs an unexpected runtime death. */
  private killingDsh = false;

  private readonly sessions = new Map<string, AriSession>();
  /** DSH session id → ARI session id, current generation only. */
  private readonly dshIndex = new Map<string, string>();

  constructor(options: AdapterOptions, output: Writable) {
    this.options = options;
    this.write = createFrameWriter(output);
    this.log = options.log ?? (() => undefined);
  }

  get capabilities(): AgentCapabilities {
    if (this.options.minimal === true) {
      const none: AgentCapabilities = { ...DSH_AGENT_CAPABILITIES };
      for (const key of Object.keys(none) as (keyof AgentCapabilities)[]) none[key] = false;
      return none;
    }
    return DSH_AGENT_CAPABILITIES;
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

    let body: Record<string, unknown> = { ...(draft as Record<string, unknown>) };
    if (body["meta"] !== undefined && body["meta"] !== null) {
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > META_SIZE_GUARD) {
        this.log(`dropped oversized tool meta on ${draft.type}`);
        delete body["meta"];
      }
    }

    // Envelope fields are applied LAST so a payload can never shadow them.
    const seq = session.seq + 1;
    body = { ...body, sessionId: session.ariId, seq };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1_048_576) {
      this.log(`dropped event ${draft.type}: exceeds the 1 MiB frame cap even after chunking`);
      return;
    }

    session.seq = seq;
    this.enqueueWrite({ jsonrpc: "2.0", method: "event", params: body });
  }

  private sessionByDshId(dshSessionId: unknown): AriSession | undefined {
    if (typeof dshSessionId !== "string") return undefined;
    const ariId = this.dshIndex.get(dshSessionId);
    return ariId === undefined ? undefined : this.sessions.get(ariId);
  }

  // ── DSH lifecycle ───────────────────────────────────────────────────────

  /** Spawn (or reuse) the current DSH generation and complete its handshake. */
  private ensureDsh(): Promise<void> {
    if (this.dsh !== undefined && this.dshBoot !== undefined) return this.dshBoot;
    this.killingDsh = false;
    this.generation += 1;
    const generation = this.generation;
    const spec = this.options.dsh;
    this.log(`starting DSH runtime generation ${generation}: ${spec.command} ${spec.args.join(" ")}`);

    const client = DshClient.spawn({
      spec,
      cwd: this.options.cwd ?? process.cwd(),
      provider: this.options.provider ?? "deepseek-official",
      model: this.options.model ?? "deepseek-official",
      log: (message) => this.log(message),
      onNotification: (method, params) => this.onDshNotification(generation, method, params),
      onClose: () => this.onDshClosed(generation),
    });
    this.dsh = client;
    this.dshBoot = client
      .initialize(
        this.options.cwd ?? process.cwd(),
        this.options.provider ?? "deepseek-official",
        this.options.model ?? "deepseek-official",
      )
      .then((result) => {
        this.dshServerInfo = result.serverInfo;
        this.log(`DSH handshake complete: ${result.serverInfo.name} ${result.serverInfo.version}`);
      })
      .catch((error) => {
        // Leave the connection uninitialized so the shell MAY retry initialize.
        this.dsh = undefined;
        this.dshBoot = undefined;
        throw error;
      });
    return this.dshBoot;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation && this.dsh !== undefined;
  }

  private killDsh(): void {
    if (this.dsh === undefined) return;
    this.killingDsh = true;
    this.dsh.kill();
    this.dsh = undefined;
    this.dshBoot = undefined;
    this.dshIndex.clear();
  }

  /**
   * The DSH runtime died. A deliberate kill was already settled by the cancel
   * or shutdown path; an unexpected death is settled here so no turn stays
   * open (SPEC §8-I1) and no session sticks in `running` (§8-I6).
   */
  private onDshClosed(generation: number): void {
    if (generation !== this.generation) return;
    this.dsh = undefined;
    this.dshBoot = undefined;
    this.dshIndex.clear();
    if (this.killingDsh) {
      this.killingDsh = false;
      return;
    }
    this.log("DSH runtime closed unexpectedly; settling open turns as errors");
    for (const session of this.sessions.values()) {
      session.pendingRaw = [];
      if (session.openTurn === undefined) {
        session.inFlight = [];
        continue;
      }
      const turn = session.openTurn;
      session.openTurn = undefined;
      this.emit(session, {
        type: "session/error",
        error: { code: -32603, message: "DSH runtime closed unexpectedly" },
        turn,
      });
      this.emit(session, { type: "turn/completed", turn, stopReason: "error" });
      session.inFlight = [];
      this.emit(session, { type: "session/status", status: "idle" });
    }
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

  private requireInitialized(method: string): void {
    if (!this.initialized) throw ariErrors.notInitialized(method);
  }

  /** A frame that never decoded: answer -32700 with a null id and keep serving. */
  handleParseFailure(): void {
    this.enqueueWrite({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error: the frame was not a valid JSON value" },
    });
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
        this.handleSessionNew(id);
        return;
      case "session/prompt":
        this.requireInitialized(method);
        await this.handlePrompt(params, id);
        return;
      case "session/cancel":
        this.requireInitialized(method);
        this.handleCancel(params, id);
        return;
      case "session/resume":
        this.requireInitialized(method);
        this.handleResume(params, id);
        return;
      case "approval/respond":
        this.requireInitialized(method);
        this.handleApprovalRespond(params, id);
        return;
      case "shutdown":
        this.requireInitialized(method);
        await this.handleShutdown(id);
        return;
      case "session/fork":
      case "session/list":
      case "question/respond": {
        // SPEC §5.3 / §7.5 / §7.6 / §10.2: a method gated by a false
        // capability is -32003, before any session validation.
        this.requireInitialized(method);
        throw ariErrors.unsupportedCapability(METHOD_CAPABILITY[method] ?? method);
      }
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
    // The DSH handshake decides whether this adapter can serve at all; a
    // failure surfaces here (the shell MAY retry initialize).
    await this.ensureDsh();
    this.initialized = true;
    const version = this.dshServerInfo?.version ?? "unknown";
    this.respond(id, {
      protocolVersion: 1,
      agentInfo: { name: "deepseek-harness", version },
      agentCapabilities: this.capabilities,
    });
  }

  private handleSessionNew(id: unknown): void {
    // DSH creates sessions lazily on first prompt, so there is nothing to
    // create yet — and crucially nothing that could emit before the response
    // (SPEC Appendix A item 5). The DSH id is allocated per generation.
    const sessionId = `s_${randomUUID()}`;
    this.sessions.set(sessionId, {
      ariId: sessionId,
      generation: this.generation,
      seq: 0,
      nextTurn: 1,
      inFlight: [],
      pendingReceipts: 0,
      pendingRaw: [],
    });
    this.respond(id, { sessionId, nextSeq: 1 });
  }

  private async handlePrompt(params: unknown, id: unknown): Promise<void> {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/prompt requires params");
    const session = this.sessionOrThrow(params["sessionId"]);
    const content = params["content"];
    if (!Array.isArray(content)) throw ariErrors.invalidParams("content must be an array of blocks");

    const limit = this.options.queueLimit;
    if (limit !== undefined && session.inFlight.length >= limit) {
      throw ariErrors.queueFull(session.inFlight.length, limit);
    }

    await this.ensureDsh();
    const client = this.dsh;
    if (client === undefined) throw ariErrors.internal("DSH runtime is not running");

    // A fresh generation needs a fresh DSH session id: reusing the old one
    // would collide with the runtime's persisted log for that id.
    if (session.dshId === undefined || session.generation !== this.generation) {
      session.dshId = `dsh_${randomUUID()}`;
      session.generation = this.generation;
      this.dshIndex.set(session.dshId, session.ariId);
    }

    // Gate: DSH may append turn/start before answering, so no notification for
    // this session may be translated until the receipt has been queued.
    session.pendingReceipts += 1;
    try {
      const receipt = await client.prompt(session.dshId, content);
      session.inFlight.push(receipt.messageId);
      this.respond(id, { messageId: receipt.messageId });
    } catch (error) {
      this.respondError(
        id,
        ariErrors.internal(`DSH session/prompt failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    } finally {
      session.pendingReceipts -= 1;
      this.drainParked(session);
    }
  }

  private handleCancel(params: unknown, id: unknown): void {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/cancel requires params");
    const session = this.sessionOrThrow(params["sessionId"]);

    if (session.openTurn === undefined && session.inFlight.length === 0 && session.pendingReceipts === 0) {
      // Idempotent no-op (SPEC §7.4).
      this.respond(id, { droppedMessageIds: [] } satisfies SessionCancelResult);
      return;
    }

    const cancelledTurn = session.openTurn;
    const dropped = [...session.inFlight];

    // DSH's documented cancellation idiom is closing the runtime process, and
    // one runtime hosts every session — so all of them settle now.
    this.killDsh();
    for (const other of this.sessions.values()) {
      other.pendingRaw = [];
      this.settleCancelled(other);
    }

    const result: SessionCancelResult = {
      droppedMessageIds: dropped,
      ...(cancelledTurn !== undefined ? { cancelledTurn } : {}),
    };
    this.respond(id, result);
  }

  /** Settle one session as cancelled: close the turn, drop the queue, go idle. */
  private settleCancelled(session: AriSession): void {
    const turn = session.openTurn;
    if (turn !== undefined) {
      session.openTurn = undefined;
      this.emit(session, { type: "turn/completed", turn, stopReason: "cancelled" });
    }
    session.inFlight = [];
    this.emit(session, { type: "session/status", status: "idle" });
  }

  private handleResume(params: unknown, id: unknown): void {
    if (!isRecord(params)) throw ariErrors.invalidParams("session/resume requires params");
    const session = this.sessionOrThrow(params["sessionId"]);
    // `since` is gated by `replay` (SPEC §5.3); without it there is still no
    // log to replay over this wire, which is exactly -32004 (SPEC §11.1).
    if (params["since"] !== undefined) {
      throw ariErrors.unsupportedCapability("session/resume.since (replay is false)");
    }
    throw ariErrors.replayUnavailable(session.ariId);
  }

  private handleApprovalRespond(params: unknown, id: unknown): void {
    if (!isRecord(params)) throw ariErrors.invalidParams("approval/respond requires params");
    // The gated parameter is checked before anything else (SPEC §10.1).
    if (params["amendedInput"] !== undefined && !this.capabilities.approvalEditInput) {
      throw ariErrors.unsupportedCapability("approval/respond.amendedInput (approvalEditInput is false)");
    }
    // The SDK wire carries no approval requests, so no id can ever be valid.
    const approvalId = typeof params["approvalId"] === "string" ? params["approvalId"] : "(missing)";
    throw ariErrors.unknownInteraction(approvalId);
  }

  private async handleShutdown(id: unknown): Promise<void> {
    this.shuttingDown = true;
    // Graceful first: DSH's shutdown disposes its agents and the app exits.
    // The kill that follows is only authoritative cleanup if it lingered.
    const client = this.dsh;
    if (client !== undefined) await client.shutdown();
    this.killDsh();
    this.respond(id, {});
    await this.drainWrites();
    this.log("shutdown complete");
    this.options.exit?.(0);
  }

  // ── DSH inbound ─────────────────────────────────────────────────────────

  private onDshNotification(generation: number, method: string, params: unknown): void {
    if (generation !== this.generation) return;
    if (!isRecord(params)) return;

    switch (method) {
      case "session.event": {
        const event = (params as { event?: unknown }).event;
        if (!isRecord(event)) return;
        const session = this.sessionByDshId(params["sessionId"]);
        if (session === undefined) {
          // `session.event` is unfiltered across the whole runtime (upstream
          // README): sessions the adapter did not create are not ours to show.
          return;
        }
        this.parkOrProcess(session, method, params, event["type"] === "turn/start");
        return;
      }
      case "session.status": {
        const session = this.sessionByDshId(params["sessionId"]);
        if (session === undefined) return;
        this.parkOrProcess(session, method, params, false);
        return;
      }
      case "subagent.started":
      case "subagent.finished": {
        const session = this.sessionByDshId(params["parentSessionId"]);
        if (session === undefined) return;
        this.parkOrProcess(session, method, params, false);
        return;
      }
      default:
        this.log(`ignoring unknown DSH notification: ${method}`);
        return;
    }
  }

  /** Park a notification while a receipt is outstanding; process otherwise. */
  private parkOrProcess(
    session: AriSession,
    method: string,
    params: Record<string, unknown>,
    isTurnStart: boolean,
  ): void {
    const parked: ParkedNotification = {
      method,
      params,
      // Receipts already enqueued plus receipts whose prompt response is still
      // in flight: every message DSH could have claimed when it opened a turn.
      claimUpTo: isTurnStart ? session.inFlight.length + session.pendingReceipts : 0,
    };
    if (session.pendingReceipts > 0) {
      session.pendingRaw.push(parked);
      return;
    }
    this.processDshNotification(session, parked);
  }

  /** Process parked notifications in arrival order until none are gated. */
  private drainParked(session: AriSession): void {
    while (session.pendingReceipts === 0 && session.pendingRaw.length > 0) {
      const parked = session.pendingRaw.shift();
      if (parked === undefined) break;
      this.processDshNotification(session, parked);
    }
  }

  private processDshNotification(session: AriSession, parked: ParkedNotification): void {
    const params = parked.params;
    switch (parked.method) {
      case "session.event": {
        const event = (params as { event?: unknown }).event;
        if (isRecord(event)) this.translateSessionEvent(session, event as unknown as DshSessionEvent, parked.claimUpTo);
        return;
      }
      case "session.status": {
        const status = params["status"] === "running" ? "running" : "idle";
        this.emit(session, { type: "session/status", status });
        return;
      }
      case "subagent.started": {
        const draft: AriEventDraft = { type: "subagent/started" };
        if (typeof params["childSessionId"] === "string") draft.childSessionId = params["childSessionId"];
        this.emit(session, draft);
        return;
      }
      case "subagent.finished": {
        const status = mapSubagentStatus(String(params["status"] ?? "error"), String(params["stopReason"] ?? ""));
        const draft: AriEventDraft = { type: "subagent/finished", status };
        if (typeof params["childSessionId"] === "string") draft.childSessionId = params["childSessionId"];
        const summary = mapSubagentSummary(params["lastAssistantMessage"]);
        if (summary !== undefined) draft.summary = summary;
        this.emit(session, draft);
        return;
      }
      default:
        return;
    }
  }

  /** Translate one DSH session-log event into zero or more ARI events. */
  private translateSessionEvent(session: AriSession, event: DshSessionEvent, claimUpTo: number): void {
    const data = isRecord(event.data) ? event.data : {};
    const turn = session.openTurn;
    switch (event.type) {
      case "turn/start": {
        // Claim the snapshotted window (SPEC §7.3 correlation obligation).
        const claimed = session.inFlight.slice(0, claimUpTo);
        session.inFlight = session.inFlight.slice(claimed.length);
        const messageIds = claimed.length > 0 ? claimed : [`m_adapted_${session.nextTurn}`];
        const newTurn = session.nextTurn++;
        session.openTurn = newTurn;
        this.emit(session, { type: "turn/started", turn: newTurn, messageIds });
        return;
      }

      case "turn/end": {
        if (turn === undefined) {
          // A settlement without a start would violate I1's bookkeeping; DSH
          // only emits turn/end inside a live turn over this wire.
          this.log(`dropping turn/end without an open turn (dsh turn ${String(data["turn"])})`);
          return;
        }
        session.openTurn = undefined;
        const mapped = mapTurnEndReason(data["reason"]);
        if (mapped.error !== undefined) {
          // I2/I3: diagnostics first, settlement second, every time.
          this.emit(session, { type: "session/error", error: mapped.error, turn });
        }
        this.emit(session, { type: "turn/completed", turn, stopReason: mapped.stopReason });
        return;
      }

      case "assistant/message": {
        const { reasoningDeltas, textDeltas } = expandAssistantStream(data["stream"], data["message"]);
        for (const text of reasoningDeltas) {
          this.emit(session, turnTurned({ type: "reasoning/delta", text }, turn));
        }
        for (const text of textDeltas) {
          this.emit(session, turnTurned({ type: "message/delta", text }, turn));
        }
        const usage = mapUsage(data["usage"]);
        if (usage !== undefined) {
          this.emit(session, turnTurned({ type: "usage/updated", usage }, turn));
        }
        return;
      }

      case "tool/call": {
        const callId = data["callId"];
        if (typeof callId !== "string") return;
        this.emit(
          session,
          turnTurned(
            {
              type: "tool/started",
              callId,
              name: String(data["name"] ?? "unknown"),
              ...(data["arguments"] !== undefined ? { input: mapToolInput(data["arguments"]) } : {}),
            },
            turn,
          ),
        );
        return;
      }

      case "tool/result": {
        const mapped = mapToolResult(data);
        const callId = mapped.callId;
        if (callId === undefined) return;
        // SPEC §4.2: large tool output is streamed in deltas, with a summary
        // (or nothing) on the completion event.
        if (mapped.output !== undefined && mapped.output.length > TOOL_OUTPUT_STREAM_AT) {
          const output = mapped.output;
          for (let at = 0; at < output.length; at += TOOL_OUTPUT_STREAM_AT) {
            this.emit(
              session,
              {
                type: "tool/updated",
                callId,
                status: "running",
                outputDelta: output.slice(at, at + TOOL_OUTPUT_STREAM_AT),
              },
            );
          }
          const summary = `${output.slice(0, 400)}… [${output.length} chars, streamed in deltas]`;
          this.emitToolCompleted(session, callId, mapped.status, summary, mapped.meta);
          return;
        }
        this.emitToolCompleted(session, callId, mapped.status, mapped.output, mapped.meta);
        return;
      }

      case "compaction/start": {
        session.compaction = compactionMemoFromStart(data, {});
        return;
      }

      case "compaction/summary": {
        const memo = session.compaction ?? { trigger: "auto" as const };
        const updated = compactionMemoFromStart({}, data);
        session.compaction = { trigger: memo.trigger, ...(updated.preTokens !== undefined ? { preTokens: updated.preTokens } : {}) };
        return;
      }

      case "compaction/end": {
        const memo = session.compaction;
        session.compaction = undefined;
        if (data["error"] !== undefined || memo === undefined) return; // failed compaction: diagnostics only
        const draft: AriEventDraft = { type: "compaction/performed", trigger: memo.trigger };
        if (memo.preTokens !== undefined) draft.preTokens = memo.preTokens;
        this.emit(session, draft);
        return;
      }

      // Runtime-internal or log-only vocabulary (SPEC §1.2 non-goals): step
      // boundaries, prompt assembly, failed attempts, fork markers, injected
      // context. None of it changes what a shell must know.
      default:
        return;
    }
  }

  private emitToolCompleted(
    session: AriSession,
    callId: string,
    status: "success" | "error",
    output: string | undefined,
    meta: unknown,
  ): void {
    this.emit(session, {
      type: "tool/completed",
      callId,
      status,
      ...(output !== undefined && output !== "" ? { output } : {}),
      ...(meta !== undefined ? { meta } : {}),
    });
  }

  /** Kill the runtime and drop all state; used when the ARI side goes away. */
  dispose(): void {
    this.killDsh();
  }
}

/** Attach the currently open ARI turn to a draft, when there is one. */
function turnTurned<T extends AriEventDraft>(draft: T, turn: number | undefined): T {
  return turn === undefined ? draft : ({ ...draft, turn } as T);
}
