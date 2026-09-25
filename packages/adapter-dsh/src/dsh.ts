/**
 * DSH-side client — speaks the DeepSeek Harness SDK wire protocol
 * (newline-delimited JSON-RPC 2.0 over the child's stdio) as the client end.
 *
 * This half of the adapter is deliberately hand-written on the framing
 * primitives: `AriHarness` is for harness authors (server side, ARI), and DSH
 * is not an ARI harness — it is the private protocol being translated. The
 * DSH transport rules mirrored here (see `dsh-sdk-protocol/src/transport.ts`
 * upstream): a frame with `id` + `method` is a request, `id` alone is a
 * response, `method` alone is a notification; malformed lines are ignored by
 * DSH and are ignored here too; handler failures answer `-32603`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createFrameWriter, readFramesSafe } from "../../ari/src/index.ts";
import type { DshInitializeResult } from "./translate.ts";

export interface DshChildSpec {
  command: string;
  args: string[];
}

interface PendingDshRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DshClientOptions {
  spec: DshChildSpec;
  cwd: string;
  provider: string;
  model: string;
  /** stderr of the DSH runtime is forwarded here (never to stdout — SPEC §4.1). */
  log: (message: string) => void;
  /** DSH notifications (`session.event`, `session.status`, `subagent.*`). */
  onNotification: (method: string, params: unknown) => void;
  /** The child exited or its stream ended. */
  onClose: () => void;
}

/** One live connection to a DSH SDK runtime process ("generation"). */
export class DshClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly write: (message: unknown) => Promise<void>;
  private readonly pending = new Map<number, PendingDshRequest>();
  private nextId = 1;
  private closed = false;

  private constructor(options: DshClientOptions, child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.write = createFrameWriter(child.stdin);

    void this.pump(options);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") options.log(`[dsh] ${line}`);
      }
    });
    child.on("close", () => {
      this.closed = true;
      this.failAll(new Error("DSH runtime closed"));
      options.onClose();
    });
  }

  /** Spawn a DSH runtime and attach the wire. Does not handshake. */
  static spawn(options: DshClientOptions): DshClient {
    const child = spawn(options.spec.command, options.spec.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", (error) => options.log(`failed to start DSH runtime: ${String(error)}`));
    return new DshClient(options, child);
  }

  /** DSH handshake. Must succeed before any prompt is accepted by the runtime. */
  async initialize(cwd: string, provider: string, model: string): Promise<DshInitializeResult> {
    const result = await this.request("initialize", { cwd, provider, model });
    return result as DshInitializeResult;
  }

  /** Enqueue one user turn; resolves with the durable receipt `{ messageId }`. */
  async prompt(sessionId: string, contentBlocks: unknown[]): Promise<{ messageId: string }> {
    const result = await this.request("session/prompt", { sessionId, contentBlocks });
    return result as { messageId: string };
  }

  /** Ask the runtime to quiesce. DSH disposes its agents; the app then exits. */
  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", {}, 5_000);
    } catch {
      // Best-effort by design: a runtime that already died takes the same
      // path as a graceful one, and the caller's kill below is authoritative.
    }
  }

  async request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) throw new Error(`DSH runtime is not running (cannot ${method})`);
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  /** SIGTERM, then SIGKILL after a grace period. Cancels every pending request. */
  kill(graceMs = 2_000): void {
    if (this.closed) return;
    const child = this.child;
    child.kill();
    const force = setTimeout(() => {
      if (!child.killed || child.exitCode === null) child.kill("SIGKILL");
    }, graceMs);
    force.unref();
  }

  private async pump(options: DshClientOptions): Promise<void> {
    try {
      for await (const frame of readFramesSafe(this.child.stdout)) {
        if (!frame.ok) {
          options.log(`unparseable frame from DSH: ${frame.error.message}`);
          continue;
        }
        this.handleFrame(frame.value, options);
      }
    } catch (error) {
      options.log(`DSH stdout failed: ${String(error)}`);
    }
  }

  private handleFrame(frame: unknown, options: DshClientOptions): void {
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as Record<string, unknown>;

    if (message["method"] === undefined) {
      // A response: correlate by id.
      const id = typeof message["id"] === "number" ? message["id"] : Number(message["id"]);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      const error = message["error"];
      if (typeof error === "object" && error !== null) {
        const err = error as Record<string, unknown>;
        entry.reject(
          new Error(`DSH ${String(err["message"] ?? "request failed")} (code ${String(err["code"] ?? "?")})`),
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

    // A server→client request: a documented dead capability of the DSH wire.
    options.log(`ignoring unexpected DSH server→client request: ${String(message["method"])}`);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
