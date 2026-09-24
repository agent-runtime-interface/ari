/**
 * ARI 1.0 error codes — SPEC.md §11.
 *
 * ARI 复用 JSON-RPC 2.0 标准码，并在其保留区间 -32000…-32099 内定义自有码。
 */

export const AriErrorCode = {
  // JSON-RPC 2.0 标准
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // ARI 自有
  SessionNotFound: -32001,
  NotInitialized: -32002,
  UnsupportedCapability: -32003,
  ReplayUnavailable: -32004,
  QueueFull: -32005,
  AlreadyInitialized: -32006,
  UnknownInteraction: -32007,
  UnsupportedProtocolVersion: -32008,
} as const;

export type AriErrorCodeValue = (typeof AriErrorCode)[keyof typeof AriErrorCode];

const NAMES: Record<number, string> = {
  [-32700]: "parse_error",
  [-32600]: "invalid_request",
  [-32601]: "method_not_found",
  [-32602]: "invalid_params",
  [-32603]: "internal_error",
  [-32001]: "session_not_found",
  [-32002]: "not_initialized",
  [-32003]: "unsupported_capability",
  [-32004]: "replay_unavailable",
  [-32005]: "queue_full",
  [-32006]: "already_initialized",
  [-32007]: "unknown_interaction",
  [-32008]: "unsupported_protocol_version",
};

/** 错误码的规范名称（SPEC §11.1）。 */
export function errorName(code: number): string {
  return NAMES[code] ?? `error_${code}`;
}

/** 可在协议边界安全抛出的错误；会被映射为 JSON-RPC error 对象。 */
export class AriError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AriError";
    this.code = code;
    this.data = data;
  }
}

export function isAriError(value: unknown): value is AriError {
  return value instanceof AriError;
}

/** 便捷构造器。 */
export const ariErrors = {
  sessionNotFound: (sessionId: string) =>
    new AriError(AriErrorCode.SessionNotFound, `unknown session: ${sessionId}`),
  notInitialized: (method: string) =>
    new AriError(AriErrorCode.NotInitialized, `initialize required before ${method}`),
  unsupportedCapability: (what: string) =>
    new AriError(AriErrorCode.UnsupportedCapability, `capability not declared: ${what}`),
  replayUnavailable: (sessionId: string) =>
    new AriError(AriErrorCode.ReplayUnavailable, `no replay log for session: ${sessionId}`),
  queueFull: (depth: number, limit: number) =>
    new AriError(AriErrorCode.QueueFull, `pending-input queue full (${depth}/${limit})`, { depth, limit }),
  alreadyInitialized: () =>
    new AriError(AriErrorCode.AlreadyInitialized, "connection already initialized"),
  unknownInteraction: (id: string) =>
    new AriError(AriErrorCode.UnknownInteraction, `unknown or already-resolved interaction: ${id}`),
  unsupportedProtocolVersion: (requested: number, supported: number[]) =>
    new AriError(AriErrorCode.UnsupportedProtocolVersion, `unsupported protocolVersion: ${requested}`, {
      supportedVersions: supported,
    }),
  invalidParams: (detail: string) => new AriError(AriErrorCode.InvalidParams, detail),
  internal: (detail: string) => new AriError(AriErrorCode.InternalError, detail),
};
