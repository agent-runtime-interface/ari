/**
 * JSON-RPC 2.0 消息类型与判定 —— SPEC.md §4.1。
 *
 * ARI 只使用两种消息：client→server 请求、server→client 通知。
 * 不使用 server→client 请求（SPEC §3）。
 */

import type { AriEventError } from "./types.ts";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isObject(value) &&
    value["jsonrpc"] === "2.0" &&
    typeof value["method"] === "string" &&
    (typeof value["id"] === "number" || typeof value["id"] === "string")
  );
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return (
    isObject(value) &&
    value["jsonrpc"] === "2.0" &&
    typeof value["method"] === "string" &&
    value["id"] === undefined
  );
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isObject(value) || value["jsonrpc"] !== "2.0") return false;
  if (typeof value["id"] !== "number" && typeof value["id"] !== "string") return false;
  return "result" in value || "error" in value;
}

export function isJsonRpcFailure(value: JsonRpcResponse): value is JsonRpcFailure {
  return "error" in value;
}

/** `event` 通知的 params（SPEC §9.1）。 */
export interface EventNotificationParams {
  sessionId: string;
  seq: number;
  type: string;
  [key: string]: unknown;
}

export function isEventNotification(
  value: unknown,
): value is JsonRpcNotification & { params: EventNotificationParams } {
  if (!isJsonRpcNotification(value) || value.method !== "event") return false;
  const params = value.params;
  return (
    isObject(params) &&
    typeof params["sessionId"] === "string" &&
    typeof params["seq"] === "number" &&
    typeof params["type"] === "string"
  );
}

/** 从事件 payload 中取出 error 字段（仅 session/error 有意义）。 */
export function readEventError(params: EventNotificationParams): AriEventError | undefined {
  const err = params["error"];
  if (!isObject(err) || typeof err["code"] !== "number" || typeof err["message"] !== "string") {
    return undefined;
  }
  return {
    code: err["code"],
    message: err["message"],
    ...(typeof err["retryable"] === "boolean" ? { retryable: err["retryable"] } : {}),
  };
}
