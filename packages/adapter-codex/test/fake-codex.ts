/**
 * fake-codex — a Codex app-server wire-protocol test double.
 *
 * This file deliberately does **not** use any ARI library: it is the other end
 * of the adapter, speaking the Codex app-server protocol exactly as the
 * upstream wire defines it (client→server requests, server→client
 * notifications, and — critically — **server→client requests** for approvals
 * and user input, all newline-delimited JSON-RPC 2.0). It exists so the
 * adapter can be exercised — and judged by the conformance suite — without an
 * OpenAI account, the same way `mock-harness` serves the conformance suite
 * directly.
 *
 * Faithful wire behaviours worth keeping exact:
 *  - `turn/start` for an idle thread emits `turn/started` (+ thread status)
 *    **before** the response is written. The real app-server funnels
 *    responses and notifications through one outbound queue and the turn can
 *    begin before the response reaches the wire — the ordering the adapter's
 *    notification gate exists for. The body then runs asynchronously, and the
 *    response lands right after the notifications, as upstream does. The
 *    politer the double, the more real adapter defects it hides.
 *  - Approvals and questions are **server→client requests**: the double
 *    sends `item/commandExecution/requestApproval` /
 *    `item/tool/requestUserInput` with a request id and blocks the turn until
 *    the client answers.
 *  - `turn/interrupt` settles the turn with `turn/completed{interrupted}` —
 *    the same notification a natural completion uses — and aborts any pending
 *    server request with `serverRequest/resolved` (no response frame is sent
 *    for it, matching upstream's `abort_pending_server_requests`).
 *  - `turn/start` on a running turn is **steered** (upstream's
 *    `start_or_steer_turn`): the response echoes the active turn and no new
 *    turn starts. A correct adapter never triggers this path — it queues.
 *  - Threads, turns, and items carry opaque ids; notifications carry the
 *    three-level `threadId`/`turnId`/`itemId` coordinates.
 *
 * Behaviour is keyword-driven on the prompt text (same spirit as
 * `mock-harness`):
 *
 *   echo <text>    plain reply (default for anything unknown)
 *   reasoning <t>  reasoning textDelta + summaryTextDelta, then a reply
 *   tool <cmd>     commandExecution item: started → outputDelta → completed
 *   toolfail       commandExecution that ends failed (exit code 1)
 *   tooldeclined   commandExecution that ends declined
 *   mcp            mcpToolCall item with a text result
 *   bigoutput      command output streamed as ~300 KiB of deltas
 *   usage          thread/tokenUsage/updated with a full breakdown
 *   approval       commandExecution + an approval request; decision-driven
 *                  (the `approve` alias drives the same path)
 *   question       requestUserInput; the answer is echoed back
 *   filechange     fileChange item completed with two FileUpdateChanges
 *   subagent       SubAgentActivity item bracket
 *   compact        ContextCompaction item bracket
 *   foreign        also emits a notification for a thread never created
 *   retryerror     session-level error with willRetry:true, then completes
 *   fail           turn ends failed (TurnError embedded)
 *   slow [ms]      hold the turn open (default 10000 ms)
 *
 * Usage: node packages/adapter-codex/test/fake-codex.ts
 */

interface FakeThread {
  id: string;
  turn: number;
  open: boolean;
  items: number;
  /** Pending server→client request blocking this thread's turn, if any. */
  pendingRequestId: string | null;
  createdAt: number;
}

const threads = new Map<string, FakeThread>();
let nextId = 1;

function threadOf(threadId: string): FakeThread {
  let thread = threads.get(threadId);
  if (thread === undefined) {
    thread = {
      id: threadId,
      turn: 0,
      open: false,
      items: 0,
      pendingRequestId: null,
      createdAt: Math.floor(Date.now() / 1000),
    };
    threads.set(threadId, thread);
  }
  return thread;
}

function freshThreadId(): string {
  return `thr_${String(nextId++).padStart(4, "0")}`;
}

function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: unknown, result: unknown): void {
  writeFrame({ jsonrpc: "2.0", id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  writeFrame({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  writeFrame({ jsonrpc: "2.0", method, params });
}

function log(message: string): void {
  process.stderr.write(`[fake-codex] ${message}\n`);
}

function textOf(input: unknown): string {
  if (!Array.isArray(input)) return "";
  const parts: string[] = [];
  for (const block of input) {
    if (typeof block === "object" && block !== null) {
      const record = block as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
    }
  }
  return parts.join("\n");
}

// ── the agent loop, faked ────────────────────────────────────────────────

function itemNotification(
  thread: FakeThread,
  turnId: string,
  phase: "started" | "completed",
  item: Record<string, unknown>,
): void {
  const itemId = typeof item["id"] === "string" ? item["id"] : `item_${thread.items + 1}`;
  if (typeof item["id"] !== "string") thread.items += 1;
  notify(phase === "started" ? "item/started" : "item/completed", {
    item: { ...item, id: itemId },
    threadId: thread.id,
    turnId,
    ...(phase === "started" ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() }),
  });
}

function statusNotification(thread: FakeThread, status: Record<string, unknown>): void {
  notify("thread/status/changed", { threadId: thread.id, status });
}

function turnObject(thread: FakeThread, turnId: string, status: string, error?: { message: string }): Record<string, unknown> {
  return {
    id: turnId,
    items: [],
    itemsView: "notLoaded",
    status,
    error: error ?? null,
    startedAt: status === "inProgress" ? Math.floor(Date.now() / 1000) : null,
    completedAt: status === "inProgress" ? null : Math.floor(Date.now() / 1000),
    durationMs: null,
  };
}

function emitReply(thread: FakeThread, turnId: string, text: string, id: string): void {
  itemNotification(thread, turnId, "started", { type: "agentMessage", id, text: "" });
  notify("item/agentMessage/delta", { threadId: thread.id, turnId, itemId: id, delta: text });
  itemNotification(thread, turnId, "completed", { type: "agentMessage", id, text });
}

/** Send a server→client request and wait for the client's response frame. */
function requestFromClient(
  thread: FakeThread,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve) => {
    const requestId = `srv_${nextId++}`;
    thread.pendingRequestId = requestId;
    pendingServerRequests.set(requestId, (result) => {
      thread.pendingRequestId = null;
      resolve(result);
    });
    writeFrame({ jsonrpc: "2.0", id: requestId, method, params });
  });
}

const pendingServerRequests = new Map<string, (result: unknown) => void>();

/** Settle the open turn; a no-op when the turn was already settled. */
function endTurn(thread: FakeThread, status: "completed" | "interrupted" | "failed", error?: { message: string }): void {
  if (!thread.open) return;
  thread.open = false;
  const turnId = `turn_${thread.id}_${thread.turn}`;
  notify("turn/completed", { threadId: thread.id, turn: turnObject(thread, turnId, status, error) });
  statusNotification(thread, { type: "idle" });
}

/** Run one turn body; the turn must already be open. */
async function runTurnBody(thread: FakeThread, turnId: string, text: string): Promise<void> {
  const [command = "", ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  // Stable per-logical-item ids: started / delta / completed must agree.
  let itemCount = 0;
  const itemId = (name: string): string => `${name}_${turnId}_${++itemCount}`;
  const reId = itemId("re");
  const msgId = itemId("msg");
  const ceId = itemId("ce");
  const mcpId = itemId("mcp");
  const uiId = itemId("ui");
  const fcId = itemId("fc");
  const subId = itemId("sub");
  const ccId = itemId("cc");

  switch (command) {
    case "reasoning": {
      notify("item/reasoning/textDelta", { threadId: thread.id, turnId, itemId: reId, delta: `considering: ${arg}`, contentIndex: 0 });
      notify("item/reasoning/summaryTextDelta", { threadId: thread.id, turnId, itemId: reId, delta: "summary: think", summaryIndex: 0 });
      emitReply(thread, turnId, arg, msgId);
      return;
    }
    case "tool": {
      itemNotification(thread, turnId, "started", {
        type: "commandExecution",
        id: ceId,
        command: arg || "ls",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      });
      notify("item/commandExecution/outputDelta", { threadId: thread.id, turnId, itemId: ceId, delta: `ran: ${arg || "ls"}` });
      itemNotification(thread, turnId, "completed", {
        type: "commandExecution",
        id: ceId,
        command: arg || "ls",
        cwd: "/repo",
        status: "completed",
        aggregatedOutput: `ran: ${arg || "ls"}`,
        exitCode: 0,
      });
      emitReply(thread, turnId, "tool finished", msgId);
      return;
    }
    case "toolfail": {
      itemNotification(thread, turnId, "started", {
        type: "commandExecution",
        id: ceId,
        command: "false",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      });
      itemNotification(thread, turnId, "completed", {
        type: "commandExecution",
        id: ceId,
        command: "false",
        cwd: "/repo",
        status: "failed",
        aggregatedOutput: "command not found",
        exitCode: 1,
      });
      emitReply(thread, turnId, "the tool failed", msgId);
      return;
    }
    case "tooldeclined": {
      itemNotification(thread, turnId, "started", {
        type: "commandExecution",
        id: ceId,
        command: "rm -rf /tmp/fake-sandbox",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      });
      itemNotification(thread, turnId, "completed", {
        type: "commandExecution",
        id: ceId,
        command: "rm -rf /tmp/fake-sandbox",
        cwd: "/repo",
        status: "declined",
        aggregatedOutput: "",
        exitCode: null,
      });
      emitReply(thread, turnId, "declined", msgId);
      return;
    }
    case "mcp": {
      itemNotification(thread, turnId, "started", {
        type: "mcpToolCall",
        id: mcpId,
        server: "fs",
        tool: "read_file",
        status: "inProgress",
        arguments: { path: "README.md" },
        result: null,
        error: null,
      });
      itemNotification(thread, turnId, "completed", {
        type: "mcpToolCall",
        id: mcpId,
        server: "fs",
        tool: "read_file",
        status: "completed",
        arguments: { path: "README.md" },
        result: { content: [{ type: "text", text: "file contents here" }] },
        error: null,
      });
      emitReply(thread, turnId, "mcp tool finished", msgId);
      return;
    }
    case "bigoutput": {
      const chunk = "x".repeat(100_000);
      itemNotification(thread, turnId, "started", {
        type: "commandExecution",
        id: ceId,
        command: "yes",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      });
      for (let i = 0; i < 3; i += 1) {
        notify("item/commandExecution/outputDelta", { threadId: thread.id, turnId, itemId: ceId, delta: chunk });
      }
      itemNotification(thread, turnId, "completed", {
        type: "commandExecution",
        id: ceId,
        command: "yes",
        cwd: "/repo",
        status: "completed",
        aggregatedOutput: "x".repeat(300_000),
        exitCode: 0,
      });
      emitReply(thread, turnId, "big output streamed", msgId);
      return;
    }
    case "usage": {
      const breakdown = {
        totalTokens: 1300,
        inputTokens: 1234,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 0,
        outputTokens: 56,
        reasoningOutputTokens: 10,
      };
      notify("thread/tokenUsage/updated", {
        threadId: thread.id,
        turnId,
        tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 272_000 },
      });
      emitReply(thread, turnId, "counted", msgId);
      return;
    }
    case "approval":
    case "approve": {
      itemNotification(thread, turnId, "started", {
        type: "commandExecution",
        id: ceId,
        command: arg || "yes",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      });
      const decision = await requestFromClient(thread, "item/commandExecution/requestApproval", {
        kind: "command",
        threadId: thread.id,
        turnId,
        itemId: ceId,
        startedAtMs: Date.now(),
        approvalId: null,
        reason: "the command wants to run",
        command: arg || "yes",
        cwd: "/repo",
      });
      if (decision === null || !thread.open) return; // aborted by an interrupt
      const accepted = decision === "accept" || decision === "acceptForSession";
      itemNotification(thread, turnId, "completed", {
        type: "commandExecution",
        id: ceId,
        command: arg || "yes",
        cwd: "/repo",
        status: accepted ? "completed" : "declined",
        aggregatedOutput: accepted ? "ran under supervision" : "",
        exitCode: accepted ? 0 : null,
      });
      if (decision === "cancel") {
        endTurn(thread, "interrupted", { message: "cancelled by approval decision" });
        return;
      }
      emitReply(thread, turnId, accepted ? "approved and ran" : "declined", msgId);
      return;
    }
    case "question": {
      const answer = await requestFromClient(thread, "item/tool/requestUserInput", {
        threadId: thread.id,
        turnId,
        itemId: uiId,
        questions: [
          {
            id: "which",
            header: "Choice",
            question: "Which option do you want?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "A", description: "the first option" },
              { label: "B", description: "the second option" },
            ],
          },
        ],
        isBlocking: true,
      });
      if (answer === null || !thread.open) return; // aborted by an interrupt
      const mapped = answer as { answers?: Record<string, { answers?: string[] }> };
      const answers = mapped.answers ?? {};
      const chosen = answers["which"]?.answers?.join(",") ?? "(declined)";
      emitReply(thread, turnId, `you chose ${chosen}`, msgId);
      return;
    }
    case "filechange": {
      itemNotification(thread, turnId, "started", {
        type: "fileChange",
        id: fcId,
        changes: [],
        status: "inProgress",
      });
      itemNotification(thread, turnId, "completed", {
        type: "fileChange",
        id: fcId,
        changes: [
          { path: "/repo/src/new.ts", kind: { type: "add" }, diff: "--- /dev/null\n+++ b/src/new.ts" },
          { path: "/repo/src/old.ts", kind: { type: "delete" }, diff: "--- a/src/old.ts\n+++ /dev/null" },
        ],
        status: "completed",
      });
      emitReply(thread, turnId, "files changed", msgId);
      return;
    }
    case "subagent": {
      itemNotification(thread, turnId, "started", {
        type: "subAgentActivity",
        id: subId,
        kind: "started",
        agentThreadId: "thr_child_0001",
        agentPath: "researcher",
      });
      itemNotification(thread, turnId, "completed", {
        type: "subAgentActivity",
        id: subId,
        kind: "completed",
        agentThreadId: "thr_child_0001",
        agentPath: "researcher",
      });
      emitReply(thread, turnId, "delegated", msgId);
      return;
    }
    case "compact": {
      itemNotification(thread, turnId, "started", { type: "contextCompaction", id: ccId });
      itemNotification(thread, turnId, "completed", { type: "contextCompaction", id: ccId });
      emitReply(thread, turnId, "compacted", msgId);
      return;
    }
    case "foreign": {
      // A notification for a thread the adapter never created: must be dropped.
      notify("item/started", {
        item: { type: "userMessage", id: "item_stray", content: [{ type: "text", text: "stray" }] },
        threadId: "thr_foreign_never_created",
        turnId: "turn_stray",
        startedAtMs: Date.now(),
      });
      emitReply(thread, turnId, "foreign noise ignored", msgId);
      return;
    }
    case "retryerror": {
      notify("error", {
        error: { message: "transient upstream failure" },
        willRetry: true,
        threadId: thread.id,
        turnId,
      });
      emitReply(thread, turnId, "recovered", msgId);
      return;
    }
    case "fail": {
      notify("error", {
        error: { message: "RATE: provider exploded" },
        willRetry: false,
        threadId: thread.id,
        turnId,
      });
      endTurn(thread, "failed", { message: "RATE: provider exploded" });
      return;
    }
    case "slow": {
      const ms = Number(arg) || 10_000;
      await sleep(ms);
      emitReply(thread, turnId, "finally woke", msgId);
      return;
    }
    default: {
      emitReply(thread, turnId, text === "" ? "(empty prompt)" : text, msgId);
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── the Codex wire server ────────────────────────────────────────────────

function handleRequest(method: string, params: Record<string, unknown>, id: unknown): void {
  switch (method) {
    case "initialize": {
      if (typeof params["clientInfo"] !== "object" || params["clientInfo"] === null) {
        respondError(id, -32602, "fake-codex: initialize needs clientInfo");
        return;
      }
      log("initialized");
      respond(id, {
        userAgent: "codex_app_server/0.0.1 (test double)",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "test",
      });
      return;
    }
    case "thread/start": {
      const threadId = freshThreadId();
      const thread = threadOf(threadId);
      log(`thread/start -> ${threadId}`);
      respond(id, {
        thread: {
          id: threadId,
          status: { type: "idle" },
          name: null,
          preview: "",
          ephemeral: false,
          createdAt: thread.createdAt,
          cwd: typeof params["cwd"] === "string" ? params["cwd"] : "/repo",
          forkedFromId: null,
        },
        model: "fake-model",
        modelProvider: "fake-provider",
        disabledPluginIds: [],
        cwd: typeof params["cwd"] === "string" ? params["cwd"] : "/repo",
      });
      return;
    }
    case "turn/start": {
      const threadId = String(params["threadId"] ?? "");
      const text = textOf(params["input"]);
      const thread = threadOf(threadId);
      if (thread.open) {
        // Faithful: upstream steers a running turn instead of queueing it.
        const turnId = `turn_${thread.id}_${thread.turn}`;
        respond(id, { turn: turnObject(thread, turnId, "inProgress") });
        return;
      }
      thread.turn += 1;
      thread.open = true;
      const turnId = `turn_${thread.id}_${thread.turn}`;
      // Faithful ordering: turn/started (+ status) BEFORE the response.
      notify("turn/started", { threadId: thread.id, turn: turnObject(thread, turnId, "inProgress") });
      statusNotification(thread, { type: "active", activeFlags: [] });
      respond(id, { turn: turnObject(thread, turnId, "inProgress") });
      void runTurnBody(thread, turnId, text)
        .then(() => endTurn(thread, "completed"))
        .catch((error) => {
          log(`turn body failed: ${String(error)}`);
          endTurn(thread, "failed", { message: String(error) });
        });
      return;
    }
    case "turn/interrupt": {
      const threadId = String(params["threadId"] ?? "");
      const thread = threadOf(threadId);
      if (!thread.open) {
        respondError(id, -32602, `fake-codex: no open turn on ${threadId}`);
        return;
      }
      if (thread.pendingRequestId !== null) {
        const requestId = thread.pendingRequestId;
        const waiter = pendingServerRequests.get(requestId);
        pendingServerRequests.delete(requestId);
        thread.pendingRequestId = null;
        notify("serverRequest/resolved", { threadId: thread.id, requestId });
        if (waiter !== undefined) waiter(null);
      }
      respond(id, {});
      endTurn(thread, "interrupted", { message: "interrupted by user" });
      return;
    }
    case "thread/fork": {
      const sourceId = String(params["threadId"] ?? "");
      const newId = freshThreadId();
      const thread = threadOf(newId);
      log(`thread/fork ${sourceId} -> ${newId}`);
      respond(id, {
        thread: {
          id: newId,
          status: { type: "idle" },
          name: null,
          preview: "",
          ephemeral: false,
          createdAt: thread.createdAt,
          cwd: "/repo",
          forkedFromId: sourceId,
        },
        model: "fake-model",
        modelProvider: "fake-provider",
        disabledPluginIds: [],
        cwd: "/repo",
      });
      return;
    }
    case "thread/list": {
      const data = [...threads.values()].map((thread) => ({
        id: thread.id,
        status: thread.open ? { type: "active", activeFlags: [] } : { type: "idle" },
        name: null,
        preview: "a thread",
        ephemeral: false,
        createdAt: thread.createdAt,
        cwd: "/repo",
        forkedFromId: null,
      }));
      respond(id, { data, nextCursor: null, backwardsCursor: null });
      return;
    }
    default:
      respondError(id, -32601, `fake-codex: unknown method ${method}`);
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
          const params = (frame["params"] ?? {}) as Record<string, unknown>;
          handleRequest(frame["method"], params, frame["id"]);
        } else if (typeof frame["method"] === "string") {
          // The lone client notification: `initialized`.
          log(`client notification: ${frame["method"]}`);
        } else if (frame["id"] !== undefined) {
          // A response to one of our server→client requests.
          const key = String(frame["id"]);
          const waiter = pendingServerRequests.get(key);
          if (waiter !== undefined) {
            pendingServerRequests.delete(key);
            waiter(frame["result"] ?? null);
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
