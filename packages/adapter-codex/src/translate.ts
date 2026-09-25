/**
 * Codex → ARI translation — the pure mapping layer of the Codex adapter.
 *
 * Codex here means the wire protocol of the Codex app-server
 * (`codex-rs/app-server` + `codex-rs/app-server-protocol`, newline-delimited
 * JSON-RPC 2.0 over stdio): client→server requests (`initialize`, `thread/*`,
 * `turn/*`, …), server→client notifications (≈110, domain-prefixed), and —
 * unlike the DSH wire — **server→client requests** for approvals and user
 * input, which the adapter must answer.
 *
 * The mapping principle is the one SPEC Appendix B states: **change the
 * envelope, not the semantics**. Nothing here decides policy — the adapter
 * owns state (seq/turn renumbering, the notification gate, the pending-input
 * queue, the replay ledger); these functions only know how one vocabulary
 * becomes the other.
 *
 * Wire facts this file encodes (verified against the Codex checkout,
 * `app-server-protocol/src/protocol/v2/{thread,turn,item}.rs` and
 * `protocol/common.rs`):
 *
 *  - Codex notifications carry a **three-level coordinate envelope**
 *    (`thread_id` / `turn_id` / `item_id`). ARI's envelope carries only
 *    `sessionId` + `seq`; the coordinates collapse into ARI's payload
 *    correlation fields (`turn`, `callId`) and the adapter's own tables.
 *  - A turn settles via `turn/completed{turn:{status, error?}}` where status
 *    is `completed | interrupted | failed | inProgress`. There is **no**
 *    refusal or max-tokens status on this wire — those ARI stop reasons are
 *    unreachable here (a documented limitation, not a translation guess).
 *  - Streaming is item-shaped: `item/started` → deltas → `item/completed`
 *    bracket one `ThreadItem`. Agent text streams through
 *    `item/agentMessage/delta`; reasoning through
 *    `item/reasoning/{textDelta,summaryTextDelta}`; command output through
 *    `item/commandExecution/outputDelta`.
 *  - Usage arrives as `thread/tokenUsage/updated{tokenUsage:{total,last}}`
 *    with a six-field breakdown; ARI's usage maps onto `total`.
 *  - Approval responses are **decision-only** (`{decision}`) — the client
 *    cannot amend a command, so `approvalEditInput` is honestly false.
 */

import type {
  AgentCapabilities,
  ApprovalDecision,
  ApprovalOption,
  CompactionTrigger,
  FileChangeKind,
  StopReason,
  SubagentResultStatus,
  UsageInfo,
} from "../../ari/src/index.ts";
import type { AriEventDraft } from "./drafts.ts";

/** Stream tool output through `tool/updated` deltas above this size (SPEC §4.2). */
export const TOOL_OUTPUT_STREAM_AT = 200_000;
/** Truncate a `tool/completed.output` summary to this many characters. */
export const TOOL_OUTPUT_SUMMARY_CHARS = 400;

// ── Codex wire shapes (structural minimums; never imported from Codex) ──────

/** `thread/start` / `thread/resume` / `thread/fork` response `thread` member. */
export interface CodexThread {
  id: string;
  status?: CodexThreadStatus;
  name?: string | null;
  preview?: string | null;
  createdAt?: number | null;
  cwd?: string | null;
  forkedFromId?: string | null;
}

/** `ThreadStatus`: tagged `notLoaded | idle | systemError | active`. */
export interface CodexThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: string[];
}

/** `Turn` as embedded in turn notifications and the `turn/start` response. */
export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message?: string } | null;
}

/** `initialize` result of the Codex app-server. */
export interface CodexInitializeResult {
  userAgent?: string;
}

/** `turn/start` response. */
export interface CodexTurnStartResult {
  turn: CodexTurn;
}

/** `thread/list` response page. */
export interface CodexThreadListResult {
  data: CodexThread[];
}

/**
 * A `ThreadItem` as received in `item/started` / `item/completed`. The full
 * upstream type is a 16-variant tagged enum; the adapter reads only the
 * members it translates, so a structural minimum suffices.
 */
export interface CodexItem {
  type: string;
  id: string;
  // commandExecution
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  // agentMessage
  text?: string;
  // reasoning
  summary?: string[];
  content?: string[];
  // fileChange
  changes?: CodexFileUpdateChange[];
  // mcpToolCall
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown[] } | null;
  error?: { message?: string } | null;
  // subAgentActivity
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
}

export interface CodexFileUpdateChange {
  path: string;
  kind: { type: "add" | "delete" | "update"; movePath?: string | null };
  diff?: string;
}

/** `item/commandExecution/requestApproval` params (server→client request). */
export interface CodexCommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  kind?: string;
}

/** `item/fileChange/requestApproval` params (server→client request). */
export interface CodexFileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
}

/** `item/tool/requestUserInput` params (server→client request). */
export interface CodexUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: {
    id: string;
    header?: string;
    question: string;
    options?: { label: string; description?: string }[] | null;
  }[];
  isBlocking?: boolean;
}

/**
 * Capabilities the adapter declares for the Codex app-server wire.
 *
 * `true` only where the wire can actually deliver the semantics:
 *  - `reasoning` rides on `item/reasoning/{textDelta,summaryTextDelta}`;
 *  - `usage` rides on `thread/tokenUsage/updated`;
 *  - `compactionEvents` ride on the `ContextCompaction` item (and the
 *    deprecated `thread/compacted` notification);
 *  - `fileChanges` ride on completed `FileChange` items;
 *  - `subagents` ride on `SubAgentActivity` item brackets (event surface
 *    only — child sessions are not attachable through this adapter);
 *  - `question` rides on the `item/tool/requestUserInput` server→client
 *    request answered through `question/respond`;
 *  - `replay` is served from the adapter's own event ledger, the same
 *    in-memory contract the reference mock harness offers (the ledger lives
 *    and dies with the adapter process);
 *  - `fork` rides on `thread/fork` (at-turn boundary = `lastTurnId`);
 *  - `sessionList` rides on `thread/list`; listed thread ids act as ARI
 *    session ids and may be prompted (adoption).
 *
 * `false` because the wire genuinely cannot: `approvalEditInput` (approval
 * responses are decision-only), `backgroundTasks` (no general background
 * framework — only queued turns and PTYs, which this adapter does not use).
 */
export const CODEX_AGENT_CAPABILITIES: AgentCapabilities = {
  reasoning: true,
  question: true,
  approvalEditInput: false,
  usage: true,
  compactionEvents: true,
  replay: true,
  fileChanges: true,
  subagents: true,
  backgroundTasks: false,
  fork: true,
  sessionList: true,
};

// ── turn settlement ──────────────────────────────────────────────────────

export interface MappedTurnEnd {
  stopReason: StopReason;
  /** Present when the turn must conclude with `session/error` first (SPEC §8-I3). */
  error?: { code: number; message: string };
}

/**
 * Map a settled Codex turn (`turn/completed.turn`) to the ARI stop reason.
 *
 *  - `completed` → `end_turn`; `interrupted` → `cancelled`.
 *  - `failed` → `error`, carrying the embedded `TurnError.message` as the
 *    `session/error` payload (I2/I3 ordering is the adapter's job).
 *  - `inProgress` on a settlement notification is a wire contradiction and
 *    is reported as an error rather than guessed.
 */
export function mapTurnEnd(turn: { id: string; status: string; error?: { message?: string } | null }): MappedTurnEnd {
  switch (turn.status) {
    case "completed":
      return { stopReason: "end_turn" };
    case "interrupted":
      return { stopReason: "cancelled" };
    case "failed": {
      const message = String(turn.error?.message ?? "Codex turn failed");
      return {
        stopReason: "error",
        error: { code: -32603, message },
      };
    }
    default:
      return {
        stopReason: "error",
        error: { code: -32603, message: `Codex turn settled with unexpected status: ${turn.status}` },
      };
  }
}

// ── items → ARI events ───────────────────────────────────────────────────

/** The concrete shape of a mapped `tool/completed` body. */
export interface MappedToolCompletion {
  type: "tool/completed";
  callId: string;
  status: "success" | "error";
  output?: string;
  meta?: unknown;
}

/** Map a completed `CommandExecution` item to a `tool/completed` body. */
export function mapCommandExecutionItem(item: CodexItem, callId: string): MappedToolCompletion {
  const status = item.status ?? "completed";
  let toolStatus: "success" | "error";
  let output = item.aggregatedOutput ?? "";
  if (status === "completed") {
    toolStatus = "success";
  } else if (status === "declined") {
    toolStatus = "error";
    output = output === "" ? "declined by user" : `${output}\ndeclined by user`;
  } else {
    toolStatus = "error";
    if (item.exitCode !== null && item.exitCode !== undefined) {
      output = output === "" ? `exit code ${item.exitCode}` : `${output}\nexit code ${item.exitCode}`;
    }
  }
  return {
    type: "tool/completed",
    callId,
    status: toolStatus,
    ...(output !== "" ? { output } : {}),
    ...(item.exitCode !== null && item.exitCode !== undefined ? { meta: { exitCode: item.exitCode } } : {}),
  };
}

/** Map a completed `McpToolCall` item to a `tool/completed` body. */
export function mapMcpToolCallItem(item: CodexItem, callId: string): MappedToolCompletion {
  const failed = item.status === "failed";
  const parts: string[] = [];
  if (Array.isArray(item.result?.content)) {
    for (const block of item.result.content) {
      if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"]);
    }
  }
  let output = parts.join("\n");
  if (failed && typeof item.error?.message === "string" && item.error.message !== "") {
    output = output === "" ? item.error.message : `${output}\n${item.error.message}`;
  }
  return {
    type: "tool/completed",
    callId,
    status: failed ? "error" : "success",
    ...(output !== "" ? { output } : {}),
  };
}

/**
 * Drafts produced from a completed `FileChange` item: one `file/changed` per
 * applied `FileUpdateChange`. Declined or failed patches changed nothing, so
 * they produce no file events (the approval flow carries the outcome).
 */
export function mapFileChangeItem(item: CodexItem): AriEventDraft[] {
  if (item.status !== "completed" || !Array.isArray(item.changes)) return [];
  const drafts: AriEventDraft[] = [];
  for (const change of item.changes) {
    if (typeof change?.path !== "string") continue;
    drafts.push({
      type: "file/changed",
      path: change.path,
      kind: mapPatchChangeKind(change.kind),
      ...(typeof change.diff === "string" && change.diff !== "" ? { diff: change.diff } : {}),
    });
  }
  return drafts;
}

function mapPatchChangeKind(kind: CodexFileUpdateChange["kind"] | undefined): FileChangeKind {
  if (kind === undefined) return "modify";
  if (kind.type === "add") return "create";
  if (kind.type === "delete") return "delete";
  if (kind.type === "update" && typeof kind.movePath === "string" && kind.movePath !== "") return "rename";
  return "modify";
}

/** Map a completed `SubAgentActivity` item to the ARI result status. */
export function mapSubagentStatus(kind: string | undefined): SubagentResultStatus {
  if (kind === "interrupted") return "cancelled";
  if (kind === "completed" || kind === "started" || kind === "interacted") return "success";
  return "error";
}

// ── usage ────────────────────────────────────────────────────────────────

/** Map a Codex `TokenUsageBreakdown` to the ARI usage object. */
export function mapUsage(breakdown: unknown): UsageInfo | undefined {
  if (!isRecord(breakdown)) return undefined;
  const inputTokens = breakdown["inputTokens"];
  const outputTokens = breakdown["outputTokens"];
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  const mapped: UsageInfo = { inputTokens, outputTokens };
  if (typeof breakdown["cachedInputTokens"] === "number") mapped.cachedTokens = breakdown["cachedInputTokens"];
  if (typeof breakdown["reasoningOutputTokens"] === "number") mapped.reasoningTokens = breakdown["reasoningOutputTokens"];
  return mapped;
}

// ── approvals ────────────────────────────────────────────────────────────

/** The ARI decisions a command approval can carry, in presentation order. */
export const COMMAND_APPROVAL_OPTIONS: ApprovalOption[] = [
  { id: "allow_once", label: "Allow once" },
  { id: "allow_always", label: "Allow for this session" },
  { id: "deny", label: "Deny" },
];

/**
 * Map an ARI approval decision to the Codex decision object
 * (`CommandExecutionApprovalDecision`, externally tagged camelCase).
 * ARI has no amendment or cancel decisions: `deny` maps to `decline`; a
 * shell that wants the turn gone calls `session/cancel` instead.
 */
export function mapApprovalDecisionOut(decision: ApprovalDecision): unknown {
  if (decision === "allow_once") return "accept";
  if (decision === "allow_always") return "acceptForSession";
  return "decline";
}

/** Map the `kind` of a completed approval back to the ARI resolution. */
export function mapApprovalResolutionOut(decision: unknown): "allow_once" | "allow_always" | "deny" | "cancelled" {
  if (decision === "acceptForSession") return "allow_always";
  if (decision === "accept") return "allow_once";
  if (decision === "cancel") return "cancelled";
  return "deny";
}

// ── questions ────────────────────────────────────────────────────────────

export interface MappedQuestionSpec {
  id: string;
  question: string;
  detail?: string;
  options?: { id: string; label: string; detail?: string }[];
}

/** Map Codex `ToolRequestUserInputQuestion[]` to ARI question specs. */
export function mapQuestions(questions: CodexUserInputParams["questions"]): MappedQuestionSpec[] {
  const mapped: MappedQuestionSpec[] = [];
  for (const question of questions) {
    if (!isRecord(question) || typeof question["id"] !== "string" || typeof question["question"] !== "string") {
      continue;
    }
    const spec: MappedQuestionSpec = { id: question["id"], question: question["question"] };
    if (typeof question["header"] === "string" && question["header"] !== "") spec.detail = question["header"];
    if (Array.isArray(question["options"])) {
      const options: { id: string; label: string; detail?: string }[] = [];
      for (const option of question["options"]) {
        if (isRecord(option) && typeof option["label"] === "string") {
          options.push({
            id: option["label"],
            label: option["label"],
            ...(typeof option["description"] === "string" && option["description"] !== ""
              ? { detail: option["description"] }
              : {}),
          });
        }
      }
      if (options.length > 0) spec.options = options;
    }
    mapped.push(spec);
  }
  return mapped;
}

/**
 * Map ARI `answers` to the Codex response payload
 * (`{answers: Map<questionId, {answers: string[]}>}`). An empty ARI answer
 * array is an explicit decline: respond with an empty map.
 */
export function mapAnswersOut(answers: { id: string; values: string[] }[]): { answers: Record<string, { answers: string[] }> } {
  const mapped: Record<string, { answers: string[] }> = {};
  for (const answer of answers) {
    if (isRecord(answer) && typeof answer["id"] === "string" && Array.isArray(answer["values"])) {
      mapped[answer["id"]] = { answers: answer["values"].filter((value): value is string => typeof value === "string") };
    }
  }
  return { answers: mapped };
}

/** Canonical ARI outcome for a question the shell answered. */
export function mapQuestionOutcome(declined: boolean): "answered" | "declined" {
  return declined ? "declined" : "answered";
}

// ── session list ─────────────────────────────────────────────────────────

/** Map a Codex thread status to the ARI session status (SPEC §7.6). */
export function mapSessionStatus(status: CodexThreadStatus | undefined): "running" | "idle" {
  return status?.type === "active" ? "running" : "idle";
}

// ── compaction ───────────────────────────────────────────────────────────

/**
 * The ARI compaction trigger for Codex compaction. Codex compacts on
 * pressure (or via `thread/compact/start`, which this adapter never calls),
 * so from the shell's perspective it is always automatic.
 */
export function mapCompactionTrigger(): CompactionTrigger {
  return "auto";
}

// ── small shared helpers ─────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
