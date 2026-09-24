/**
 * ARI 1.0 protocol types — SPEC.md §2 / §5.3 / §7 / §9 / §10.
 *
 * Events are **flat** on the wire: the envelope is { sessionId, seq, type, ...payload },
 * so each member of the union type carries its payload fields directly (no nesting).
 */

export const PROTOCOL_VERSION = 1;

// ── Enum values (const objects rather than enum, to keep syntax erasable) ──────────────────

export type SessionStatus = "running" | "idle";
export type StopReason = "end_turn" | "max_tokens" | "cancelled" | "refusal" | "error";
export type ToolRunStatus = "pending" | "running";
export type ToolResultStatus = "success" | "error";
export type ApprovalDecision = "allow_once" | "allow_always" | "deny";
export type ApprovalResolution = ApprovalDecision | "expired" | "cancelled";
export type QuestionOutcome = "answered" | "declined" | "expired";
export type FileChangeKind = "create" | "modify" | "delete" | "rename";
export type CompactionTrigger = "manual" | "auto" | "overflow";
export type SubagentResultStatus = "success" | "error" | "cancelled";
export type BackgroundRunStatus = "running" | "pending";

// ── Content blocks ────────────────────────────────────────────────────────────

export interface TextContentBlock {
  type: "text";
  text: string;
}

/** ARI 1.0 defines only text; other types are introduced by the extension mechanism (SPEC §12). */
export type ContentBlock = TextContentBlock;

// ── Capabilities (SPEC §5.3) ─────────────────────────────────────────────────

export interface AgentCapabilities {
  reasoning: boolean;
  question: boolean;
  approvalEditInput: boolean;
  usage: boolean;
  compactionEvents: boolean;
  replay: boolean;
  fileChanges: boolean;
  subagents: boolean;
  backgroundTasks: boolean;
  fork: boolean;
  sessionList: boolean;
}

export const CAPABILITY_KEYS = [
  "reasoning",
  "question",
  "approvalEditInput",
  "usage",
  "compactionEvents",
  "replay",
  "fileChanges",
  "subagents",
  "backgroundTasks",
  "fork",
  "sessionList",
] as const satisfies readonly (keyof AgentCapabilities)[];

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const NO_CAPABILITIES: AgentCapabilities = {
  reasoning: false,
  question: false,
  approvalEditInput: false,
  usage: false,
  compactionEvents: false,
  replay: false,
  fileChanges: false,
  subagents: false,
  backgroundTasks: false,
  fork: false,
  sessionList: false,
};

export const ALL_CAPABILITIES: AgentCapabilities = {
  reasoning: true,
  question: true,
  approvalEditInput: true,
  usage: true,
  compactionEvents: true,
  replay: true,
  fileChanges: true,
  subagents: true,
  backgroundTasks: true,
  fork: true,
  sessionList: true,
};

export interface ClientCapabilities {
  /** Whether the shell will call session/resume after a disconnect. */
  replay?: boolean;
}

export interface PeerInfo {
  name: string;
  version: string;
}

// ── Method params and results ────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number;
  clientInfo?: PeerInfo;
  clientCapabilities?: ClientCapabilities;
}

export interface InitializeResult {
  protocolVersion: number;
  agentInfo: PeerInfo;
  agentCapabilities: AgentCapabilities;
}

export interface SessionNewParams {
  cwd?: string;
  meta?: Record<string, unknown>;
}

export interface SessionNewResult {
  sessionId: string;
  /** The seq the next event will use; 1 for a new session. */
  nextSeq: number;
}

export interface SessionResumeParams {
  sessionId: string;
  /** Omitted = replay from the beginning. */
  since?: number;
}

export interface SessionResumeResult {
  sessionId: string;
  replayedFrom: number;
  nextSeq: number;
  events: AriEvent[];
  snapshot?: SessionSnapshot;
}

export interface SessionPromptParams {
  sessionId: string;
  content: ContentBlock[];
}

export interface SessionPromptResult {
  /** Durable enqueue receipt; ≠ turn outcome (SPEC §7.3). */
  messageId: string;
}

export interface SessionCancelParams {
  sessionId: string;
  cause?: string;
}

export interface SessionCancelResult {
  cancelledTurn?: number;
  droppedMessageIds: string[];
}

export interface SessionForkParams {
  sessionId: string;
  /** Omitted = the current turn boundary. */
  atTurn?: number;
}

export interface SessionForkResult {
  sessionId: string;
  nextSeq: number;
  forkedFrom: { sessionId: string; turn: number };
}

export interface SessionListParams {
  cwd?: string;
}

export interface SessionListEntry {
  sessionId: string;
  status: SessionStatus;
  cwd?: string;
  title?: string;
  createdAt?: string;
}

export interface SessionListResult {
  sessions: SessionListEntry[];
}

export interface ApprovalRespondParams {
  sessionId: string;
  approvalId: string;
  decision: ApprovalDecision;
  /** Only when agentCapabilities.approvalEditInput is true. */
  amendedInput?: unknown;
}

export interface QuestionAnswer {
  id: string;
  values: string[];
}

export interface QuestionRespondParams {
  sessionId: string;
  questionId: string;
  /** `[]` = explicitly decline to answer as a whole (SPEC §10.2). */
  answers: QuestionAnswer[];
}

export type ShutdownParams = Record<string, never>;
export type EmptyResult = Record<string, never>;

// ── snapshot (SPEC §7.2) ─────────────────────────────────────────────

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cost?: number;
}

export interface QueuedInput {
  messageId: string;
  content: ContentBlock[];
}

export interface ApprovalOption {
  id: ApprovalDecision;
  label: string;
}

export interface PendingApproval {
  approvalId: string;
  toolCallId?: string;
  toolName?: string;
  reason?: string;
  options?: ApprovalOption[];
}

export interface QuestionOption {
  id: string;
  label: string;
  detail?: string;
}

export interface QuestionSpec {
  id: string;
  question: string;
  detail?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestion {
  questionId: string;
  questions: QuestionSpec[];
}

export interface OpenToolCall {
  callId: string;
  name: string;
  status: ToolRunStatus;
}

export interface SessionSnapshot {
  status: SessionStatus;
  nextTurn: number;
  queue: QueuedInput[];
  pendingApprovals: PendingApproval[];
  pendingQuestions: PendingQuestion[];
  openToolCalls: OpenToolCall[];
  usage?: UsageInfo;
}

// ── Events (SPEC §9.2 / §9.3) ──────────────────────────────────────────

/** Envelope fields common to all events. */
export interface EventEnvelope {
  sessionId: string;
  seq: number;
}

/** Required events (10). */
export type RequiredEvent =
  | (EventEnvelope & { type: "session/status"; status: SessionStatus })
  | (EventEnvelope & { type: "turn/started"; turn: number; messageIds: string[] })
  | (EventEnvelope & { type: "turn/completed"; turn: number; stopReason: StopReason })
  | (EventEnvelope & { type: "message/delta"; turn?: number; text: string })
  | (EventEnvelope & { type: "tool/started"; turn?: number; callId: string; name: string; input?: unknown })
  | (EventEnvelope & { type: "tool/updated"; callId: string; status: ToolRunStatus; title?: string; outputDelta?: string })
  | (EventEnvelope & { type: "tool/completed"; callId: string; status: ToolResultStatus; output?: string; meta?: unknown })
  | (EventEnvelope & {
      type: "approval/requested";
      approvalId: string;
      toolCallId?: string;
      toolName?: string;
      reason?: string;
      options?: ApprovalOption[];
    })
  | (EventEnvelope & { type: "approval/resolved"; approvalId: string; decision: ApprovalResolution })
  | (EventEnvelope & { type: "session/error"; error: AriEventError; turn?: number });

/** Capability-gated events (11). */
export type CapabilityEvent =
  | (EventEnvelope & { type: "reasoning/delta"; turn?: number; text: string })
  | (EventEnvelope & { type: "question/requested"; questionId: string; questions: QuestionSpec[] })
  | (EventEnvelope & { type: "question/resolved"; questionId: string; outcome: QuestionOutcome })
  | (EventEnvelope & { type: "usage/updated"; turn?: number; usage: UsageInfo })
  | (EventEnvelope & { type: "compaction/performed"; trigger: CompactionTrigger; preTokens?: number; postTokens?: number })
  | (EventEnvelope & { type: "file/changed"; path: string; kind: FileChangeKind; diff?: string })
  | (EventEnvelope & { type: "subagent/started"; callId?: string; childSessionId?: string; name?: string })
  | (EventEnvelope & { type: "subagent/finished"; callId?: string; childSessionId?: string; status: SubagentResultStatus; summary?: string })
  | (EventEnvelope & { type: "background/started"; taskId: string; title?: string })
  | (EventEnvelope & { type: "background/updated"; taskId: string; status: BackgroundRunStatus; title?: string; outputDelta?: string })
  | (EventEnvelope & { type: "background/finished"; taskId: string; status: SubagentResultStatus; output?: string });

export type AriEvent = RequiredEvent | CapabilityEvent;

export type AriEventType = AriEvent["type"];

export interface AriEventError {
  code: number;
  message: string;
  retryable?: boolean;
}

/** Event type → its required capability (required events do not appear in this table). */
export const EVENT_CAPABILITY: Partial<Record<AriEventType, CapabilityKey>> = {
  "reasoning/delta": "reasoning",
  "question/requested": "question",
  "question/resolved": "question",
  "usage/updated": "usage",
  "compaction/performed": "compactionEvents",
  "file/changed": "fileChanges",
  "subagent/started": "subagents",
  "subagent/finished": "subagents",
  "background/started": "backgroundTasks",
  "background/updated": "backgroundTasks",
  "background/finished": "backgroundTasks",
};

export const REQUIRED_EVENT_TYPES = [
  "session/status",
  "turn/started",
  "turn/completed",
  "message/delta",
  "tool/started",
  "tool/updated",
  "tool/completed",
  "approval/requested",
  "approval/resolved",
  "session/error",
] as const;

/** Method name → its required capability (methods without gating do not appear). */
export const METHOD_CAPABILITY: Record<string, CapabilityKey> = {
  "session/fork": "fork",
  "session/list": "sessionList",
  "question/respond": "question",
};

// ── Method table (for typed calls) ────────────────────────────────────────────

export interface AriMethods {
  initialize: { params: InitializeParams; result: InitializeResult };
  "session/new": { params: SessionNewParams; result: SessionNewResult };
  "session/resume": { params: SessionResumeParams; result: SessionResumeResult };
  "session/prompt": { params: SessionPromptParams; result: SessionPromptResult };
  "session/cancel": { params: SessionCancelParams; result: SessionCancelResult };
  "session/fork": { params: SessionForkParams; result: SessionForkResult };
  "session/list": { params: SessionListParams; result: SessionListResult };
  "approval/respond": { params: ApprovalRespondParams; result: EmptyResult };
  "question/respond": { params: QuestionRespondParams; result: EmptyResult };
  shutdown: { params: ShutdownParams; result: EmptyResult };
}

export type AriMethodName = keyof AriMethods;
