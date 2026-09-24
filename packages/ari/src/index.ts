/**
 * ARI 1.0 reference protocol library.
 *
 * - `types`   — protocol types: methods, events, capabilities, error codes
 * - `errors`  — ARI error codes and the `AriError` boundary type
 * - `jsonrpc` — JSON-RPC 2.0 message predicates
 * - `framing` — NDJSON framing, the 1 MiB cap, backpressure
 * - `client`  — Shell-side client
 * - `harness` — Harness-side helper that enforces the SPEC §8 invariants
 *
 * The normative definition of all of this is SPEC.md.
 */

export * from "./types.ts";
export * from "./errors.ts";
export * from "./jsonrpc.ts";
export * from "./framing.ts";
export * from "./client.ts";
export * from "./harness.ts";
