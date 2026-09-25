/**
 * ZCode → ARI translation — the pure mapping layer of the ZCode adapter.
 *
 * ZCode here means the wire of the ZCode Agent CLI (`zcode app-server --stdio`,
 * ZCode Protocol V4): newline-delimited JSON-RPC-style frames **without** the
 * `jsonrpc` member, client→server requests (`v4/command`, `v4/conversation/*`),
 * and server→client notifications (`v4/conversation/frame`) carrying topic
 * frames of Row/Delta/StatePatch projections. The V4 data model is declared
 * "not frozen" upstream (`packages/shared/src/zcode-protocol-v4/core.ts`);
 * this file encodes one vintage of it, verified against checkout version
 * 3.14.0 (`V4_WIRE_PROTOCOL_VERSION = 3`).
 *
 * The mapping principle is the one SPEC Appendix B states: **change the
 * envelope, not the semantics**. Nothing here decides policy — the adapter
 * owns state (seq/turn renumbering, the notification gate, the pending-input
 * queue, the replay ledger, the pending-interaction set); these functions only
 * know how one vocabulary becomes the other.
 *
 * Wire facts this file encodes (verified against the ZCode checkout,
 * `packages/shared/src/zcode-protocol-v4/{command,rows,delta,snapshot,toolDisplay}.ts`
 * and `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/{server,v4-bridge}.ts`):
 *
 *  - **Turn settlement is a row state, not a notification.** A turn opens when
 *    a `turnHeader` row (`state:"running"`) is appended and settles when that
 *    row is upserted to `completedSuccess | completedInterrupted | failed`.
 *    There is no refusal or max-tokens state on this wire — those ARI stop
 *    reasons are unreachable here (a documented limitation, not a guess).
 *  - **Streaming is row-shaped**: `row.delta {path:"text"}` appends into a
 *    streaming `assistantText`/`reasoning` row; `path:"output.text"` streams
 *    tool output. Structural changes ride `row.upserted` (whole row) or —
 *    rarely, on edit/retry branches — `row.removed {fromRowId}`.
 *  - **Interactions are data, not reverse requests**: approvals and questions
 *    hang off the StatePatch `pendingInteractions[]` and are answered through
 *    the `resolveInteraction` command. The broker's legacy interaction reverse
 *    requests may still appear on the wire; the adapter declines to answer
 *    them (the V4 deferred wins the broker race; an adapter response could
 *    pre-empt a pending permission with a bogus decision). The one legacy
 *    request the adapter DOES answer is `session/requestRuntimePreferences` —
 *    it blocks runtime creation and has no V4 counterpart.
 *  - **Permission options carry a `kind`** (`allowOnce|allowAlways|deny|
 *    custom`) and their own `optionId`; the answer must echo the *optionId*
 *    of the option whose kind matches the ARI decision. `custom` options
 *    (full-access) have no ARI representation and are never offered.
 *  - **AskUserQuestion answers ride `action`/`content`**, the same path the
 *    desktop's elicitation dialog uses: `content.answers` keyed by question
 *    text, valued by option `value` (or free text); `action:"decline"` for
 *    an explicit refusal.
 *  - **Usage arrives as whole-key StatePatch replacements**
 *    (`usage.cumulative.{inputTokens,outputTokens,cacheReadTokens,
 *    cacheWriteTokens}`); compaction leaves traces as `timelineMarker` rows
 *    with `marker.type === "compact"`.
 */

import type {
  AgentCapabilities,
  ApprovalOption,
  ApprovalDecision,
  CompactionTrigger,
  QuestionAnswer,
  QuestionSpec,
  StopReason,
  SubagentResultStatus,
  UsageInfo,
} from "../../ari/src/index.ts";
import type { AriEventDraft } from "./drafts.ts";

// ── ZCode wire shapes (structural minimums; never imported from ZCode) ──────

/** A `ConversationRow` as received in snapshots and deltas. The full upstream
 * type is a 9-kind discriminated union; the adapter reads only the members it
 * translates, so a structural minimum suffices. */
export interface ZcodeRow {
  kind: string;
  rowId: number;
  turnId: string;
  /** Canonical row identity; new CLIs always send it (fork targeting needs it). */
  entityId?: string;
  // turnHeader
  origin?: string;
  state?: string;
  // userInput / assistantText / reasoning
  text?: string;
  // toolCall
  toolCallId?: string;
  toolName?: string;
  status?: string;
  inputText?: string;
  input?: unknown;
  output?: { text?: string; truncated?: { totalBytes: number; ref: string } } | null;
  error?: { code?: string; message?: string } | null;
  approvalInteractionId?: string;
  // subagent
  parentToolCallId?: string;
  subagentType?: string;
  summaryText?: string;
  childSessionId?: string;
  // timelineMarker
  marker?: {
    type: string;
    origin?: string;
    status?: string;
    tokensBefore?: number;
    tokensAfter?: number;
  };
}

/** The five-op `ConversationDelta` union (a closed set upstream). */
export type ZcodeDelta =
  | { op: "row.appended"; row: ZcodeRow }
  | { op: "row.upserted"; row: ZcodeRow }
  | { op: "row.removed"; fromRowId: number }
  | { op: "row.delta"; rowId: number; path: string; append: string }
  | { op: "state.updated"; patch: ZcodeStatePatch };

/** Whole-key `StatePatch` replacement; the adapter reads the keys it maps. */
export interface ZcodeStatePatch {
  revision?: number;
  control?: {
    phase?: string;
    stopState?: string;
    lastError?: { code?: string; message?: string } | null;
    apiRetry?: { attempt?: number; maxAttempts?: number; reasonCode?: string } | null;
  } | null;
  usage?: ZcodeUsageState | null;
  pendingInteractions?: ZcodeInteraction[];
  meta?: { title?: string; titleSource?: string };
}

export interface ZcodeUsageState {
  contextWindow?: { usedTokens?: number; maxTokens?: number } | null;
  cumulative?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/** A `pendingInteraction`: approvals and questions are state, not callbacks. */
export interface ZcodeInteraction {
  interactionId: string;
  kind: "permission" | "userInput" | "workspaceHookReview";
  anchorRowId: number | null;
  payload:
    | {
        kind: "permission";
        toolCallId?: string;
        toolName?: string;
        summary?: string;
        options?: { optionId: string; label: string; kind: string }[];
      }
    | {
        kind: "userInput";
        prompt?: string;
        freeText?: boolean;
        toolName?: string;
        toolCallId?: string;
        options?: { optionId: string; label: string }[];
        questions?: {
          question: string;
          header?: string;
          options?: { value: string; label: string; description?: string }[];
          multiSelect?: boolean;
        }[];
      }
    | { kind: "workspaceHookReview" };
}

/** The `conversation/<sessionId>` topic frame (logical; before wire framing). */
export interface ZcodeTopicFrame {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  payload:
    | { kind: "snapshot"; snapshot: ZcodeSnapshot }
    | { kind: "deltas"; deltas: ZcodeDelta[] };
}

/** The physical `TopicWireFrame` notification params: complete or fragmented. */
export interface ZcodeWireFrame {
  wireVersion?: number;
  kind: "complete" | "fragment";
  deliveryKind?: string;
  logicalFrameId: string;
  logicalFrameOrdinal?: number;
  topic?: string;
  subscriptionId?: string;
  frame?: ZcodeTopicFrame;
  // fragments only
  fragmentIndex?: number;
  fragmentCount?: number;
  logicalBytes?: number;
  dataBase64?: string;
}

/** The `CommandAck` response of `v4/command`. */
export interface ZcodeCommandAck {
  commandId: string;
  status: "accepted" | "rejected" | "stale" | "duplicate" | "noop" | "failed";
  reasonCode?: string;
  message?: string;
  revisionAtDecision: number;
  result?: {
    type: string;
    sessionId?: string;
    input?: { delivery?: string; inputId?: string; messageId?: string };
    delivery?: string;
    inputId?: string;
  };
}

/** The snapshot carried by the initial (or resync) conversation frame. */
export interface ZcodeSnapshot {
  sessionId?: string;
  logEpoch?: string;
  revision?: number;
  control?: ZcodeStatePatch["control"];
  usage?: ZcodeUsageState;
  pendingInteractions?: ZcodeInteraction[];
  rows?: { window?: ZcodeRow[]; totalCount?: number; firstRowId?: number | null };
}

/**
 * Capabilities the adapter declares for the ZCode Protocol V4 wire.
 *
 * `true` only where the wire can actually deliver the semantics:
 *  - `reasoning` rides the `reasoning` row and its `row.delta` text appends;
 *  - `question` rides `userInput` pending interactions answered through
 *    `resolveInteraction` (including AskUserQuestion multi-question payloads);
 *  - `usage` rides the `usage` StatePatch key;
 *  - `compactionEvents` ride `timelineMarker` rows with `marker.type:"compact"`;
 *  - `subagents` ride `subagent` row brackets (event surface only — child
 *    sessions are surfaced with their `childSessionId`, not managed);
 *  - `fork` rides the `forkAssistant` command (a stable row target with
 *    baseRevision/baseLogEpoch CAS);
 *  - `replay` is served from the adapter's own event ledger, the same
 *    in-memory contract the reference mock harness offers (the ledger lives
 *    and dies with the adapter process).
 *
 * `false` because the wire genuinely cannot (or maps only through a surface
 * ARI 1.0 does not absorb):
 *  - `approvalEditInput` — `resolveInteraction` answers are decision-shaped
 *    (`optionId`/`freeText`/`action`); argument rewriting happens runtime-side;
 *  - `fileChanges` — file modifications project through tool rows and a
 *    turn-level aggregate (`turnHeader.fileChanges`); the protocol carries no
 *    per-path file-change event stream (research/02-zcode.md §8);
 *  - `backgroundTasks` — `backgroundWorks` entries vanish on result delivery
 *    without an ARI-mappable terminal status, and ARI 1.0 deliberately has no
 *    background control API (SPEC §9.3);
 *  - `sessionList` — V4's listing surface is the `sessions-index/*` *topic
 *    subscription*, not a queryable RPC, and the coexisting legacy
 *    `session/list` method is the deprecated namespace this adapter does not
 *    bridge (SPEC Appendix B maps ZCode's session/list to "—").
 */
export const ZCODE_AGENT_CAPABILITIES: AgentCapabilities = {
  reasoning: true,
  question: true,
  approvalEditInput: false,
  usage: true,
  compactionEvents: true,
  replay: true,
  fileChanges: false,
  subagents: true,
  backgroundTasks: false,
  fork: true,
  sessionList: false,
};

// ── turn settlement ──────────────────────────────────────────────────────

export interface MappedTurnEnd {
  stopReason: StopReason;
}

/**
 * Map a settled `turnHeader.state` to the ARI stop reason.
 *
 *  - `completedSuccess` → `end_turn`; `completedInterrupted` → `cancelled`.
 *  - `failed` → `error` (the diagnostic is announced separately, from
 *    `control.lastError`, before the settlement — SPEC §8-I3 is the
 *    adapter's job, so this mapping carries no error payload).
 *  - Any other state on a settlement observation is a wire contradiction and
 *    is reported as an error rather than guessed.
 */
export function mapTurnEnd(state: string): MappedTurnEnd {
  if (state === "completedSuccess") return { stopReason: "end_turn" };
  if (state === "completedInterrupted") return { stopReason: "cancelled" };
  if (state === "failed") return { stopReason: "error" };
  return { stopReason: "error" };
}

// ── usage ────────────────────────────────────────────────────────────────

/** Map a ZCode `usage` StatePatch key to the ARI usage object. */
export function mapUsage(usage: ZcodeUsageState | undefined | null): UsageInfo | undefined {
  const cumulative = usage?.cumulative;
  const inputTokens = cumulative?.inputTokens;
  const outputTokens = cumulative?.outputTokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  const mapped: UsageInfo = { inputTokens, outputTokens };
  if (typeof cumulative?.cacheReadTokens === "number") mapped.cachedTokens = cumulative.cacheReadTokens;
  return mapped;
}

// ── compaction ───────────────────────────────────────────────────────────

/**
 * The draft for a settled compact marker, or undefined when the marker does
 * not represent a compaction that happened (`running`, `cancelled`, `failed`,
 * `noop` mark attempts, not performed compactions).
 */
export function mapCompactionMarker(marker: NonNullable<ZcodeRow["marker"]>): AriEventDraft | undefined {
  if (marker.type !== "compact" || marker.status !== "success") return undefined;
  const trigger: CompactionTrigger = marker.origin === "manual" ? "manual" : "auto";
  return {
    type: "compaction/performed",
    trigger,
    ...(typeof marker.tokensBefore === "number" ? { preTokens: marker.tokensBefore } : {}),
    ...(typeof marker.tokensAfter === "number" ? { postTokens: marker.tokensAfter } : {}),
  };
}

// ── subagents ────────────────────────────────────────────────────────────

/** Map a settled `subagent` row status to the ARI result status. */
export function mapSubagentStatus(status: string | undefined): SubagentResultStatus {
  if (status === "success") return "success";
  if (status === "cancelled") return "cancelled";
  return "error";
}

// ── approvals ────────────────────────────────────────────────────────────

/**
 * Map a permission payload's options to the ARI option list. Options of kind
 * `custom` (full access) have no ARI decision representation and are dropped;
 * the remaining kinds map one-to-one onto the ARI decision enum.
 */
export function mapApprovalOptions(
  options: NonNullable<Extract<ZcodeInteraction["payload"], { kind: "permission" }>["options"]>,
): ApprovalOption[] {
  const mapped: ApprovalOption[] = [];
  for (const option of options) {
    if (option.kind === "allowOnce") mapped.push({ id: "allow_once", label: option.label });
    else if (option.kind === "allowAlways") mapped.push({ id: "allow_always", label: option.label });
    else if (option.kind === "deny") mapped.push({ id: "deny", label: option.label });
  }
  return mapped;
}

/**
 * The ZCode `optionId` an ARI decision maps to: the offered option whose kind
 * matches, or the reducer-synthesized default idiom when the payload offered
 * no options (upstream answers literal `allowOnce`/`allowAlways` ids there).
 */
export function permissionOptionIdFor(
  options: NonNullable<Extract<ZcodeInteraction["payload"], { kind: "permission" }>["options"]> | undefined,
  decision: ApprovalDecision,
): string | undefined {
  const kind = decision === "allow_once" ? "allowOnce" : decision === "allow_always" ? "allowAlways" : "deny";
  const matched = options?.find((option) => option.kind === kind);
  if (matched !== undefined) return matched.optionId;
  if (options === undefined) return kind;
  return undefined;
}

// ── questions ────────────────────────────────────────────────────────────

/** The adapter's question-id convention: ARI ids are the question's index. */
export function questionIdAt(index: number): string {
  return String(index);
}

/** The index of an adapter question id, or undefined when it is not ours. */
export function questionIndexFor(id: string): number | undefined {
  const index = Number(id);
  return Number.isInteger(index) && index >= 0 && String(index) === id ? index : undefined;
}

/**
 * Map a `userInput` payload's `questions[]` to ARI question specs. Option ids
 * are the ZCode option **values** — the same identity the elicitation answer
 * path carries back (`content.answers[questionText] = option.value`).
 */
export function mapQuestionSpecs(
  questions: NonNullable<Extract<ZcodeInteraction["payload"], { kind: "userInput" }>["questions"]>,
): QuestionSpec[] {
  const mapped: QuestionSpec[] = [];
  for (const [index, question] of questions.entries()) {
    const spec: QuestionSpec = {
      id: questionIdAt(index),
      question: question.question,
      ...(question.header !== undefined && question.header !== "" ? { detail: question.header } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    };
    if (Array.isArray(question.options) && question.options.length > 0) {
      spec.options = question.options.map((option) => ({
        id: option.value,
        label: option.label,
        ...(option.description !== undefined && option.description !== "" ? { detail: option.description } : {}),
      }));
    }
    mapped.push(spec);
  }
  return mapped;
}

/**
 * Map ARI `answers` to the `resolveInteraction` answer for a `userInput`
 * interaction — the desktop elicitation path: multi-question answers ride
 * `action:"accept"` + `content.answers` keyed by question text, option
 * choices carry the option value, free-text questions carry the text, and
 * multi-select choices join with ", " (the desktop's own custom-answer
 * idiom). An empty ARI answer array is an explicit decline
 * (`action:"decline"`, SPEC §10.2).
 */
export function mapQuestionAnswerOut(
  questions: NonNullable<Extract<ZcodeInteraction["payload"], { kind: "userInput" }>["questions"]>,
  answers: QuestionAnswer[],
): { answer: { action: "accept" | "decline"; content?: { answers: Record<string, string> } } } {
  if (answers.length === 0) return { answer: { action: "decline" } };
  const content: Record<string, string> = {};
  for (const answer of answers) {
    const index = questionIndexFor(answer.id);
    const question = index !== undefined ? questions[index] : undefined;
    if (question === undefined || !Array.isArray(answer.values) || answer.values.length === 0) continue;
    const value = answer.values
      .filter((entry): entry is string => typeof entry === "string")
      .join(", ");
    if (value !== "") content[question.question] = value;
  }
  if (Object.keys(content).length === 0) return { answer: { action: "decline" } };
  return { answer: { action: "accept", content: { answers: content } } };
}

/**
 * Map ARI `answers` to the `resolveInteraction` answer for a plain free-text
 * `userInput` interaction (no `questions[]`): the joined text, or an explicit
 * decline when nothing is answered.
 */
export function mapFreeTextAnswerOut(
  answers: QuestionAnswer[],
): { answer: { freeText?: string; action?: "decline" } } {
  const parts: string[] = [];
  for (const answer of answers) {
    if (Array.isArray(answer.values)) {
      for (const value of answer.values) {
        if (typeof value === "string" && value !== "") parts.push(value);
      }
    }
  }
  if (parts.length === 0) return { answer: { action: "decline" } };
  return { answer: { freeText: parts.join("\n") } };
}

/** Canonical ARI outcome for a question the shell answered. */
export function mapQuestionOutcome(declined: boolean): "answered" | "declined" {
  return declined ? "declined" : "answered";
}

// ── small shared helpers ─────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
