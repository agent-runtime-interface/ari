/**
 * ZCode-side client — speaks the ZCode Agent CLI wire protocol
 * (ZCode Protocol V4 over the child's stdio) as the client end.
 *
 * This half of the adapter is deliberately hand-written on the framing
 * primitives: `AriHarness` is for harness authors (server side, ARI), and the
 * ZCode CLI is not an ARI harness — it is the private protocol being
 * translated. Transport rules mirrored here (see the upstream
 * `packages/services/src/zcode-agent/zcodeStdioTransport.ts` and
 * `packages/shared/src/zcode-protocol/index.ts`): frames are one JSON value
 * per line, LF-terminated; the envelope is JSON-RPC-*shaped* but carries **no
 * `jsonrpc` member** — `{id, method, params?}` requests, `{id, result}`
 * responses, `{id, error{code, message, data?}}` errors, `{method, params?}`
 * notifications; the CLI exits on stdin EOF (its normal shutdown boundary).
 *
 * The structural difference from the other two adapter wires: the CLI pushes
 * the conversation as **topic frames** (`v4/conversation/frame` notifications
 * wrapping snapshot/delta projections) instead of per-fact notifications, and
 * it has **no server→client request channel in V4** — approvals and questions
 * are data (`pendingInteractions`), not callbacks. The legacy interaction
 * reverse requests (`interaction/*`) can still appear; the client surfaces
 * them for logging and deliberately never answers them (an adapter response
 * could win the broker race and pre-empt a pending permission with a bogus
 * decision — the V4 deferred must win instead; unanswered requests simply
 * time out on the CLI side). Legacy **configuration** reverse requests are
 * the exception: `session/requestRuntimePreferences` blocks runtime creation
 * upstream and has no V4 counterpart, so the adapter answers it with the
 * desktop's own fallback values (the CLI only falls back on its own for
 * "method not found"/"no client", not for a timeout).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createFrameWriter, readFramesSafe } from "../../ari/src/index.ts";
import type { ZcodeWireFrame } from "./translate.ts";

export interface ZcodeChildSpec {
  command: string;
  args: string[];
}

interface PendingZcodeRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** An unanswered legacy server→client request, with the callback that answers it. */
export interface IncomingZcodeRequest {
  id: unknown;
  method: string;
  params: Record<string, unknown>;
  /** Answers the reverse request; a no-op once answered or the child died. */
  respond: (result: unknown) => void;
}

export interface ZcodeClientOptions {
  spec: ZcodeChildSpec;
  cwd: string;
  /** stderr of the CLI is forwarded here (never to stdout — SPEC §4.1). */
  log: (message: string) => void;
  /** Server→client notifications (`v4/conversation/frame`, telemetry, …). */
  onNotification: (method: string, params: unknown) => void;
  /**
   * Legacy reverse requests (`session/requestRuntimePreferences` must be
   * answered; `interaction/*` must not — see the file header).
   */
  onServerRequest?: (request: IncomingZcodeRequest) => void;
  /** The child exited or its stream ended. */
  onClose: () => void;
}

/** One live connection to a ZCode Agent CLI process. */
export class ZcodeClient {
  /** The underlying child, for the boot gate in the adapter (spawn/close). */
  readonly child: ChildProcessWithoutNullStreams;
  private readonly write: (message: unknown) => Promise<void>;
  private readonly pending = new Map<string, PendingZcodeRequest>();
  private readonly openServerRequests = new Map<string, (result: unknown) => void>();
  private readonly fragments = new Map<
    string,
    { count: number; received: number; parts: Map<number, string> }
  >();
  private nextId = 1;
  private closed = false;

  private constructor(options: ZcodeClientOptions, child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.write = createFrameWriter(child.stdin);

    void this.pump(options);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") options.log(`[zcode] ${line}`);
      }
    });
    child.on("close", () => {
      this.closed = true;
      this.failAll(new Error("ZCode CLI closed"));
      options.onClose();
    });
  }

  /** Spawn the CLI and attach the wire. Does not subscribe to anything. */
  static spawn(options: ZcodeClientOptions): ZcodeClient {
    const child = spawn(options.spec.command, options.spec.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", (error) => options.log(`failed to start ZCode CLI: ${String(error)}`));
    return new ZcodeClient(options, child);
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) throw new Error(`ZCode CLI is not running (cannot ${method})`);
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`ZCode request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });
    await this.write({ id, method, params });
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.write({ method, params });
  }

  /** Answer a legacy reverse request. Unknown or already-answered ids are ignored. */
  respondToServerRequest(id: string, result: unknown): void {
    const respond = this.openServerRequests.get(id);
    if (respond === undefined) return;
    this.openServerRequests.delete(id);
    void this.write({ id, result }).catch(() => undefined);
  }

  /** Close stdin — the CLI's normal exit boundary — then SIGTERM fallback. */
  kill(graceMs = 2_000): void {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      // The child may already be gone; the SIGTERM fallback below still runs.
    }
    const child = this.child;
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, graceMs);
    force.unref();
    // The adapter owes the runtime no graceful drain once the ARI shutdown
    // response is out (SPEC §7.7): EOF first, SIGTERM right behind it.
    child.kill();
  }

  private async pump(options: ZcodeClientOptions): Promise<void> {
    try {
      for await (const frame of readFramesSafe(this.child.stdout)) {
        if (!frame.ok) {
          options.log(`unparseable frame from ZCode: ${frame.error.message}`);
          continue;
        }
        this.handleFrame(frame.value, options);
      }
    } catch (error) {
      options.log(`ZCode stdout failed: ${String(error)}`);
    }
  }

  private handleFrame(frame: unknown, options: ZcodeClientOptions): void {
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as Record<string, unknown>;

    if (message["method"] === undefined) {
      // A response to one of our requests: correlate by id.
      const key = String(message["id"]);
      const entry = this.pending.get(key);
      if (!entry) return;
      this.pending.delete(key);
      clearTimeout(entry.timer);
      const error = message["error"];
      if (typeof error === "object" && error !== null) {
        const err = error as Record<string, unknown>;
        entry.reject(
          new Error(`ZCode ${String(err["message"] ?? "request failed")} (code ${String(err["code"] ?? "?")})`),
        );
      } else {
        entry.resolve(message["result"]);
      }
      return;
    }

    const method = String(message["method"]);
    const params = message["params"] ?? {};

    if (message["id"] !== undefined) {
      // A legacy server→client request. Surfaced with a respond callback; the
      // adapter decides which classes to answer (configuration requests must
      // be answered, interaction requests must not — see the file header).
      const key = String(message["id"]);
      const request: IncomingZcodeRequest = {
        id: message["id"],
        method,
        params: params as Record<string, unknown>,
        respond: (result: unknown) => this.respondToServerRequest(key, result),
      };
      this.openServerRequests.set(key, request.respond);
      options.onServerRequest?.(request);
      return;
    }

    // A notification. Wire frames may arrive fragmented; reassemble them.
    if (method === "v4/conversation/frame" && isWireFrame(params)) {
      const logical = this.takeWireFrame(params, options);
      if (logical !== undefined) options.onNotification(method, logical.frame);
      return;
    }
    options.onNotification(method, params);
  }

  /**
   * Assemble a physical wire frame into its logical topic frame. Complete
   * frames pass through; fragments accumulate by `logicalFrameId` until the
   * declared count arrives (UTF-8 byte fragments of one JSON value, in order).
   */
  private takeWireFrame(wire: ZcodeWireFrame, options: ZcodeClientOptions):
    | { frame: unknown }
    | undefined {
    if (wire.kind === "complete") return { frame: wire.frame };
    if (wire.kind !== "fragment") {
      options.log(`dropping unknown ZCode wire frame kind: ${String((wire as { kind?: string }).kind)}`);
      return undefined;
    }
    const index = wire.fragmentIndex;
    const count = wire.fragmentCount;
    const data = wire.dataBase64;
    if (
      typeof index !== "number" ||
      typeof count !== "number" ||
      count < 1 ||
      index < 0 ||
      index >= count ||
      typeof data !== "string"
    ) {
      options.log(`dropping malformed ZCode wire fragment for ${wire.logicalFrameId}`);
      return undefined;
    }
    let entry = this.fragments.get(wire.logicalFrameId);
    if (entry === undefined || entry.count !== count) {
      entry = { count, received: 0, parts: new Map() };
      this.fragments.set(wire.logicalFrameId, entry);
    }
    if (!entry.parts.has(index)) {
      entry.parts.set(index, data);
      entry.received += 1;
    }
    if (entry.received < count) return undefined;
    this.fragments.delete(wire.logicalFrameId);
    try {
      // Each fragment carries its own padded base64 of one byte slice, so they
      // decode individually before being concatenated (concatenating padded
      // base64 strings silently drops everything after the first padding).
      const encoded = Array.from({ length: count }, (_, at) => entry.parts.get(at));
      if (encoded.some((part) => part === undefined)) {
        options.log(`dropping incomplete ZCode wire frame ${wire.logicalFrameId}`);
        return undefined;
      }
      const bytes = Buffer.concat(encoded.map((part) => Buffer.from(part as string, "base64")));
      return { frame: JSON.parse(bytes.toString("utf8")) };
    } catch (error) {
      options.log(`dropping unparseable ZCode wire frame ${wire.logicalFrameId}: ${String(error)}`);
      return undefined;
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.fragments.clear();
    // Unanswered reverse requests die with the wire.
    this.openServerRequests.clear();
  }
}

function isWireFrame(value: unknown): value is ZcodeWireFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { logicalFrameId?: unknown }).logicalFrameId === "string" &&
    ((value as { kind?: unknown }).kind === "complete" || (value as { kind?: unknown }).kind === "fragment")
  );
}
