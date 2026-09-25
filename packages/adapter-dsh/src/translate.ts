/**
 * DSH → ARI translation — the pure mapping layer of the DSH adapter.
 *
 * DSH here means the wire protocol of the DeepSeek Harness SDK runtime
 * (`@deepseek-ai/dsh-sdk-protocol`, newline-delimited JSON-RPC 2.0 over stdio):
 * three client→server requests (`initialize`, `session/prompt`, `shutdown`) and
 * four server→client notifications (`session.event`, `session.status`,
 * `subagent.started`, `subagent.finished`). The session-event vocabulary is the
 * one carried by `dsh-session`'s `SessionEvent` envelope.
 *
 * The mapping principle is the one SPEC Appendix B states: **change the
 * envelope, not the semantics**. Nothing here decides policy — the adapter owns
 * state (seq/turn renumbering, receipt attribution, capability suppression);
 * these functions only know how one vocabulary becomes the other.
 *
 * Wire facts this file encodes (verified against the DSH checkout, v0.1.7-era
 * `packages/sdk/protocol/src/types.ts`, `packages/core/session/src/types.ts`,
 * `packages/llm/llm/src/{types,assistant-stream}.ts`):
 *
 *  - A DSH session event is `{ type, seq, time, data }`; its `seq` space is
 *    DSH-internal (0-based, includes log-only events). The adapter renumbers,
 *    so DSH seqs are deliberately discarded here.
 *  - Assistant text arrives **at settlement**, embedded in
 *    `assistant/message.data.stream` as compact records (`text-chunks`,
 *    `reasoning-chunks`, `tool-call-chunks`, raw `chunk`). The DSH SDK wire has
 *    no live delta notifications, so deltas are synthesized from those records.
 *  - `turn/end.data.reason` is a `TurnEndReason` sum (`completed | aborted |
 *    blocked | error | max-tokens | interrupted | forked`).
 *  - Token usage rides on `assistant/message.data.usage` (`TokenUsage`).
 */

import type { StopReason, SubagentResultStatus, UsageInfo } from "../../ari/src/index.ts";
import type { AriEventDraft } from "./drafts.ts";

/** Maximum text carried by one synthesized delta event (stays far under the 1 MiB frame cap). */
export const MAX_DELTA_CHARS = 200_000;

// ── DSH wire shapes (structural minimums; never imported from DSH) ──────────

/** `session.event` params: one session-log event, streamed as it is recorded. */
export interface DshSessionEventNotification {
  sessionId: string;
  event: DshSessionEvent;
}

/** The DSH session-log event envelope (`dsh-session` `SessionEvent`). */
export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  ignorable?: true;
}

/** `session.status` params: whole-agent lifecycle state. */
export interface DshStatusNotification {
  sessionId: string;
  status: "running" | "idle";
}

/** `subagent.started` params. */
export interface DshSubagentStartedNotification {
  parentSessionId: string;
  childSessionId: string;
}

/** `subagent.finished` params. */
export interface DshSubagentFinishedNotification {
  provider: string;
  agentId: string;
  parentSessionId: string;
  childSessionId: string;
  status: "ok" | "error";
  stopReason: string;
  lastAssistantMessage?: unknown;
}

/** `initialize` result of the DSH SDK runtime. */
export interface DshInitializeResult {
  serverInfo: { name: string; version: string };
}

interface DshTextBlock {
  type: "text";
  text: string;
}

/**
 * Capabilities the adapter declares for DSH over the SDK wire.
 *
 * `true` only where the wire can actually deliver the semantics:
 *  - `reasoning` / `usage` ride on `assistant/message`;
 *  - `compactionEvents` ride on the plugin `compaction/*` session events that
 *    flow through `session.event`;
 *  - `subagents` ride on the `subagent.*` notifications.
 *
 * `false` because the SDK wire genuinely cannot: it has no approval or
 * question channel (server→client requests are a dead capability in DSH), no
 * cancel method (a turn is abandoned by closing the process), no replay
 * (`session/prompt` with a new runtime lazily creates — history is not
 * forwarded), no fork, no session list, no file-change or background-task
 * notifications.
 */
export const DSH_AGENT_CAPABILITIES = {
  reasoning: true,
  question: false,
  approvalEditInput: false,
  usage: true,
  compactionEvents: true,
  replay: false,
  fileChanges: false,
  subagents: true,
  backgroundTasks: false,
  fork: false,
  sessionList: false,
} as const;

// ── turn settlement ──────────────────────────────────────────────────────

export interface MappedTurnEnd {
  stopReason: StopReason;
  /** Present when the turn must conclude with `session/error` first (SPEC §8-I3). */
  error?: { code: number; message: string };
}

/**
 * Map a DSH `TurnEndReason` to the ARI stop reason.
 *
 *  - `completed` → `end_turn`; `max-tokens` → `max_tokens`; `aborted` and
 *    `interrupted` (the crash-orphaned closer) → `cancelled`.
 *  - `blocked` (the runtime rejected the input before any step) → `refusal`.
 *  - `error` → `error`, carrying a `session/error` payload built from the
 *    embedded `LlmFailure` (its `code` is a provider string; ARI event errors
 *    are numeric, so the failure is reported as an internal error).
 *  - `forked` only ever closes fork-seed turns, which the adapter never
 *    drives; it is mapped to `end_turn` for safety.
 */
export function mapTurnEndReason(reason: unknown): MappedTurnEnd {
  const record = isRecord(reason) ? reason : {};
  const kind = String(record["kind"] ?? "");
  switch (kind) {
    case "completed":
      return { stopReason: "end_turn" };
    case "max-tokens":
      return { stopReason: "max_tokens" };
    case "aborted":
    case "interrupted":
      return { stopReason: "cancelled" };
    case "blocked":
      return { stopReason: "refusal" };
    case "error": {
      const failure = isRecord(record["error"]) ? record["error"] : {};
      const code = String(failure["code"] ?? "UNKNOWN");
      const message = String(failure["message"] ?? "DSH turn failed");
      return {
        stopReason: "error",
        error: { code: -32603, message: `${code}: ${message}` },
      };
    }
    case "forked":
      return { stopReason: "end_turn" };
    default:
      return {
        stopReason: "error",
        error: { code: -32603, message: `DSH turn ended with unknown reason: ${kind || "(none)"}` },
      };
  }
}

// ── assistant streams ────────────────────────────────────────────────────

export interface ExpandedAssistant {
  reasoningDeltas: string[];
  textDeltas: string[];
}

/**
 * Expand a DSH `AssistantStreamRecord[]` (or, as a fallback, the assembled
 * message content) into ARI deltas. `tool-call-chunks` are skipped: the
 * `tool/call` session event already carries the call.
 */
export function expandAssistantStream(
  stream: unknown,
  content: unknown,
): ExpandedAssistant {
  const reasoning: string[] = [];
  const text: string[] = [];

  const pushText = (value: string): void => {
    for (const piece of splitForFrame(value)) text.push(piece);
  };
  const pushReasoning = (value: string): void => {
    for (const piece of splitForFrame(value)) reasoning.push(piece);
  };

  if (Array.isArray(stream)) {
    for (const record of stream) {
      if (!isRecord(record)) continue;
      if (record["type"] === "text-chunks" && Array.isArray(record["texts"])) {
        for (const t of record["texts"] as unknown[]) if (typeof t === "string") pushText(t);
      } else if (record["type"] === "reasoning-chunks" && Array.isArray(record["texts"])) {
        for (const t of record["texts"] as unknown[]) if (typeof t === "string") pushReasoning(t);
      } else if (record["type"] === "chunk" && isRecord(record["chunk"])) {
        const chunk = record["chunk"];
        if (chunk["type"] === "text-delta" && typeof chunk["text"] === "string") pushText(chunk["text"]);
        if (chunk["type"] === "reasoning-delta" && typeof chunk["text"] === "string") pushReasoning(chunk["text"]);
      }
      // `tool-call-chunks` and any other raw chunk types: covered by tool/call.
    }
  }

  // Fallback: a settled message with no usable stream records still carries
  // its assembled content. Deltas must reflect every delivered character.
  if (text.length === 0 && Array.isArray(content)) {
    for (const block of content as unknown[]) {
      if (isTextBlock(block)) pushText(block.text);
    }
  }

  return { reasoningDeltas: reasoning, textDeltas: text };
}

/** Split one text into pieces that each serialize well under the frame cap. */
function splitForFrame(value: string): string[] {
  if (value.length <= MAX_DELTA_CHARS) return [value];
  const pieces: string[] = [];
  for (let at = 0; at < value.length; at += MAX_DELTA_CHARS) {
    pieces.push(value.slice(at, at + MAX_DELTA_CHARS));
  }
  return pieces;
}

// ── usage ────────────────────────────────────────────────────────────────

/** Map a DSH `TokenUsage` to the ARI usage object (field renames only). */
export function mapUsage(usage: unknown): UsageInfo | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = usage["inputTokens"];
  const outputTokens = usage["outputTokens"];
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  const mapped: UsageInfo = { inputTokens, outputTokens };
  if (typeof usage["cacheReadTokens"] === "number") mapped.cachedTokens = usage["cacheReadTokens"];
  if (typeof usage["reasoningTokens"] === "number") mapped.reasoningTokens = usage["reasoningTokens"];
  return mapped;
}

// ── tool results ─────────────────────────────────────────────────────────

export interface MappedToolResult {
  callId?: string;
  status: "success" | "error";
  output?: string;
  meta?: unknown;
}

/**
 * Map a DSH `tool/result` payload to a `tool/completed` body.
 *
 * The model-facing result content is joined into the ARI `output` summary; the
 * tool-private `meta` presentation payload passes through untouched (SPEC
 * §9.2: `meta` is opaque, for UI use).
 */
export function mapToolResult(data: Record<string, unknown>): MappedToolResult {
  const message = isRecord(data["message"]) ? data["message"] : {};
  const mapped: MappedToolResult = {
    status: message["isError"] === true ? "error" : "success",
  };
  if (typeof message["toolCallId"] === "string") mapped.callId = message["toolCallId"];

  const parts: string[] = [];
  if (Array.isArray(message["content"])) {
    for (const block of message["content"] as unknown[]) {
      if (isTextBlock(block)) parts.push(block.text);
    }
  }
  let output = parts.join("\n");

  const failure = isRecord(data["error"]) ? data["error"] : undefined;
  if (failure && mapped.status === "error") {
    const code = String(failure["code"] ?? "UNKNOWN");
    const name = String(failure["name"] ?? "tool error");
    const reason = typeof failure["reason"] === "string" ? failure["reason"] : undefined;
    const line = reason !== undefined && reason !== "" ? `${code}: ${reason}` : `${code} (${name})`;
    output = output === "" ? line : `${output}\n${line}`;
  }

  if (output !== "") mapped.output = output;
  if (data["meta"] !== undefined) mapped.meta = data["meta"];
  return mapped;
}

/** Extract a tool-call input from the raw DSH `arguments` JSON string. */
export function mapToolInput(argumentsRaw: unknown): unknown {
  if (typeof argumentsRaw !== "string" || argumentsRaw.trim() === "") return undefined;
  try {
    return JSON.parse(argumentsRaw);
  } catch {
    return argumentsRaw; // keep the raw text rather than fabricating structure
  }
}

// ── subagents ────────────────────────────────────────────────────────────

/**
 * Map `subagent.finished` (`status: ok|error` + provider stop reason) to the
 * ARI result status. `aborted` is a cancellation; `refusal` is a declined
 * task, reported as `cancelled` because ARI has no refused-subagent state.
 */
export function mapSubagentStatus(status: string, stopReason: string): SubagentResultStatus {
  if (status === "error") {
    return stopReason === "aborted" ? "cancelled" : "error";
  }
  return stopReason === "aborted" ? "cancelled" : "success";
}

/** Flatten `lastAssistantMessage` content blocks into a summary string. */
export function mapSubagentSummary(lastAssistantMessage: unknown): string | undefined {
  if (!Array.isArray(lastAssistantMessage)) return undefined;
  const parts: string[] = [];
  for (const block of lastAssistantMessage as unknown[]) {
    if (isTextBlock(block)) parts.push(block.text);
  }
  const summary = parts.join("\n");
  return summary === "" ? undefined : summary;
}

// ── compaction ───────────────────────────────────────────────────────────

export interface CompactionMemo {
  trigger: "manual" | "auto";
  preTokens?: number;
}

/**
 * Remember what a `compaction/start` + `compaction/summary` pair contributes
 * to the eventual `compaction/performed` (emitted when `compaction/end` lands).
 *
 * `sourceCommandId` (or a standalone `turn: null` transaction) means a human
 * command compacted; otherwise DSH compacted on pressure — both `pressure` and
 * `context-overflow` are automatic from the shell's perspective. The token
 * count DSH exposes for the compacted range is `shadowedTokenCount`.
 */
export function compactionMemoFromStart(start: Record<string, unknown>, summary: Record<string, unknown>): CompactionMemo {
  const manual = start["sourceCommandId"] !== undefined || start["turn"] === null;
  const memo: CompactionMemo = { trigger: manual ? "manual" : "auto" };
  if (typeof summary["shadowedTokenCount"] === "number") memo.preTokens = summary["shadowedTokenCount"];
  return memo;
}

// ── small shared helpers ─────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is DshTextBlock {
  return isRecord(value) && value["type"] === "text" && typeof value["text"] === "string";
}

/** Draft re-export kept next to its consumers for readable imports. */
export type { AriEventDraft };
