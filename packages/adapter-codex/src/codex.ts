/**
 * Codex-side client — speaks the Codex app-server wire protocol
 * (newline-delimited JSON-RPC 2.0 over the child's stdio) as the client end.
 *
 * This half of the adapter is deliberately hand-written on the framing
 * primitives: `AriHarness` is for harness authors (server side, ARI), and the
 * Codex app-server is not an ARI harness — it is the private protocol being
 * translated. Transport rules mirrored here (see
 * `codex-rs/app-server-transport/src/transport/stdio.rs` upstream): frames
 * are one JSON value per line; a frame with `id` + `method` is a request,
 * `id` alone is a response, `method` alone is a notification; malformed lines
 * are ignored.
 *
 * The structural difference from the DSH wire: the app-server sends
 * **server→client requests** (approvals, user input, dynamic tools). Each is
 * surfaced through `onServerRequest` together with a one-shot `respond`
 * callback; the request stays pending until the adapter answers it or the
 * child dies.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createFrameWriter, readFramesSafe } from "../../ari/src/index.ts";
import type { CodexInitializeResult, CodexTurnStartResult } from "./translate.ts";

export interface CodexChildSpec {
  command: string;
  args: string[];
}

interface PendingCodexRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** An unanswered server→client request, with the callback that answers it. */
export interface IncomingCodexRequest {
  /** The JSON-RPC request id; echo it verbatim when responding. */
  id: unknown;
  method: string;
  params: Record<string, unknown>;
  respond: (result: unknown) => void;
}

export interface CodexClientOptions {
  spec: CodexChildSpec;
  cwd: string;
  /** stderr of the app-server is forwarded here (never to stdout — SPEC §4.1). */
  log: (message: string) => void;
  /** Server→client notifications (`turn/*`, `item/*`, `thread/*`, …). */
  onNotification: (method: string, params: unknown) => void;
  /** Server→client requests (approvals, `item/tool/requestUserInput`, …). */
  onServerRequest: (request: IncomingCodexRequest) => void;
  /** The child exited or its stream ended. */
  onClose: () => void;
}

/** One live connection to a Codex app-server process. */
export class CodexClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly write: (message: unknown) => Promise<void>;
  private readonly pending = new Map<string, PendingCodexRequest>();
  private readonly openServerRequests = new Map<string, (result: unknown) => void>();
  private nextId = 1;
  private closed = false;

  private constructor(options: CodexClientOptions, child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.write = createFrameWriter(child.stdin);

    void this.pump(options);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") options.log(`[codex] ${line}`);
      }
    });
    child.on("close", () => {
      this.closed = true;
      this.failAll(new Error("Codex app-server closed"));
      options.onClose();
    });
  }

  /** Spawn the app-server and attach the wire. Does not handshake. */
  static spawn(options: CodexClientOptions): CodexClient {
    const child = spawn(options.spec.command, options.spec.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", (error) => options.log(`failed to start Codex app-server: ${String(error)}`));
    return new CodexClient(options, child);
  }

  /** Codex handshake, then the lone `initialized` client notification. */
  async initialize(): Promise<CodexInitializeResult> {
    const result = (await this.request(
      "initialize",
      { clientInfo: { name: "ari-adapter-codex", version: "1.0.0" } },
    )) as CodexInitializeResult;
    await this.notify("initialized", {});
    return result;
  }

  /** Start one turn; resolves with `{ turn }` (the durable receipt is ARI-side). */
  async turnStart(threadId: string, text: string, clientUserMessageId: string): Promise<CodexTurnStartResult> {
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      clientUserMessageId,
    });
    return result as CodexTurnStartResult;
  }

  /** Interrupt one turn. Codex settles it with a `turn/completed{interrupted}`. */
  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  /** Fork through `lastTurnId` (inclusive); resolves with the new thread. */
  async threadFork(threadId: string, lastTurnId?: string): Promise<{ thread: { id: string } }> {
    const params: Record<string, unknown> = { threadId };
    if (lastTurnId !== undefined) params["lastTurnId"] = lastTurnId;
    const result = await this.request("thread/fork", params);
    return result as { thread: { id: string } };
  }

  async threadList(): Promise<{ data: unknown[] }> {
    const result = await this.request("thread/list", {});
    return result as { data: unknown[] };
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) throw new Error(`Codex app-server is not running (cannot ${method})`);
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });
    await this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  /** Answer a server→client request. Unknown or answered ids are ignored. */
  respondToServerRequest(id: unknown, result: unknown): void {
    const key = String(id);
    const respond = this.openServerRequests.get(key);
    if (respond === undefined) return;
    this.openServerRequests.delete(key);
    void this.write({ jsonrpc: "2.0", id, result }).catch(() => undefined);
  }

  /** SIGTERM, then SIGKILL after a grace period. Fails every pending exchange. */
  kill(graceMs = 2_000): void {
    if (this.closed) return;
    const child = this.child;
    child.kill();
    const force = setTimeout(() => {
      if (!child.killed || child.exitCode === null) child.kill("SIGKILL");
    }, graceMs);
    force.unref();
  }

  private async pump(options: CodexClientOptions): Promise<void> {
    try {
      for await (const frame of readFramesSafe(this.child.stdout)) {
        if (!frame.ok) {
          options.log(`unparseable frame from Codex: ${frame.error.message}`);
          continue;
        }
        this.handleFrame(frame.value, options);
      }
    } catch (error) {
      options.log(`Codex stdout failed: ${String(error)}`);
    }
  }

  private handleFrame(frame: unknown, options: CodexClientOptions): void {
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
          new Error(`Codex ${String(err["message"] ?? "request failed")} (code ${String(err["code"] ?? "?")})`),
        );
      } else {
        entry.resolve(message["result"]);
      }
      return;
    }

    if (message["id"] === undefined) {
      // A notification.
      options.onNotification(String(message["method"]), message["params"]);
      return;
    }

    // A server→client request: the approval / user-input channel.
    const key = String(message["id"]);
    const request: IncomingCodexRequest = {
      id: message["id"],
      method: String(message["method"]),
      params: (message["params"] ?? {}) as Record<string, unknown>,
      respond: (result: unknown) => this.respondToServerRequest(key, result),
    };
    this.openServerRequests.set(key, request.respond);
    options.onServerRequest(request);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    // Unanswered server→client requests simply die with the wire; the
    // adapter resolves the ARI interactions it owes (SPEC §8-I7) from its own
    // pending-interaction state when the close lands.
    this.openServerRequests.clear();
  }
}
