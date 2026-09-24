# ARI 1.0 Specification

> ARI = **Agent Runtime Interface**. This document is the **normative specification** for ARI.
> For the research basis and trade-off analysis, see [ARI-RESEARCH-REPORT.md](ARI-RESEARCH-REPORT.md) and [research/](research/).

---

## 0. Status and Normative Language

This document uses RFC 2119 keywords, defined as follows:

- **MUST**: an absolute requirement. Violation means non-conformance with ARI 1.0.
- **MUST NOT**: an absolute prohibition.
- **SHOULD**: a strong recommendation. There may exist valid reasons to deviate, but the full implications must be understood.
- **SHOULD NOT**: a strong discouragement.
- **MAY**: optional.

`protocolVersion` is the integer **1** (MAJOR-only, see §5). This document describes ARI **1.0**.

---

## 1. Scope and Non-Goals

### 1.1 Scope

ARI is an **interface specification**: it defines the contract between a Shell and a Harness, while a protocol binding (such as JSON-RPC/NDJSON, §4) defines how that contract is transported.

ARI defines the **runtime contract between Shell and Harness**: session lifecycle, event stream, turn settlement, tool-call lifecycle, human-in-the-loop interaction, cancellation, usage and compaction notifications, error semantics, and capability negotiation.

- **Shell**: the client that drives the agent (IDE plugin, TUI, Web UI, automation script).
- **Harness**: the runtime that implements the agent loop (DSH, Codex, ZCode, OpenCode, Pi, or in-house).

ARI's goal is that a Shell need not know which Harness it is connected to.

### 1.2 Non-Goals

ARI does **not** specify the following, and conforming implementations **MUST NOT** assume them:

- **Tool bodies and tool schemas** — tool integration is handled by external mechanisms such as MCP. ARI specifies only the event shape of tool calls.
- **Models and providers** — no specification of model selection, routing, retry policy, or backoff algorithm.
- **UI and rendering** — events are semantics, not rendering. `meta` is opaque to the Shell.
- **Harness internals** — compaction algorithms and thresholds, PTC/sandboxed execution, storage formats and migration, iteration limits, loop detection, context assembly.
- **Security models beyond transport** — see §13.
- **client tools inversion** (the Shell providing fs/terminal tools to the Harness). This design was removed in ACP v1→v2 (inconsistent implementations); ARI does not adopt it.
- **PTY/terminal passthrough** — exposing the terminal lifecycle through tool events is sufficient.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Session** | One continuous conversation. Identified by an opaque `sessionId`. The event ledger is isolated per session. |
| **Event** | An immutable fact produced by the Harness and belonging to a session. Carries a monotonic `seq`. |
| **Turn** | A unit of work: from claiming input to settlement. Within a session, `turn` increases monotonically from 1. |
| **Step** | One model call. **ARI does not expose step**; it is a Harness-internal concept. |
| **ToolCall** | One tool call, identified by an opaque `callId`; for the state machine see §9.2. |
| **Interaction** | A pending item requiring a Shell answer: a closed-form approval or an open-ended question. |
| **pending-input queue** | A per-session FIFO queue holding prompts that have been accepted but not yet claimed by a turn. |
| **watermark** | `nextSeq`, the sequence number of the session's next event. |

---

## 3. Architecture and Positioning

```
  Shell A ─┐
  Shell B ─┤   ARI (this specification)
  Shell C ─┘        │
              ┌─────┴─────┐
              │  Harness  │
              ├───────────┤
              │ DSH       │
              │ Codex     │
              │ OpenCode  │
              │ in-house  │
              └───────────┘
```

**Communication model**: ARI 1.0 **uses only two kinds of messages**:

1. **client → server request** (has `id`, has a response)
2. **server → client notification** (no `id`, no response)

ARI 1.0 **does not use server → client requests**. Human-in-the-loop interaction uses the one-way pattern "Harness emits an event → Shell calls a respond method", rather than ACP's `session/request_permission` reverse request. Rationale: the Shell need not implement a request router, and the event stream remains a single ordered channel.

---

## 4. Transport Binding

The core data model is decoupled from transport. Binding A is **normative**; Binding B is **informative** (the data model is the same; only the transport mapping differs).

### 4.1 Binding A (normative): JSON-RPC 2.0 over stdio, newline-delimited

- Messages are **JSON-RPC 2.0** objects.
- Framing: **one complete JSON per line**, terminated by a single `\n` (U+000A). **Newlines MUST NOT be embedded within JSON** (that is, pretty-print is prohibited).
- **stdout purity**: the Harness's stdout **MUST** contain only ARI messages. All logs, debug output, and progress information **MUST** be written to stderr.
- Encoding is UTF-8.
- Closing stdin indicates termination on the Shell side; the Harness **SHOULD** shut down gracefully in response.

### 4.2 Frame Limit

- A single line **MUST** be ≤ **1,048,576 bytes** (1 MiB, UTF-8, excluding the trailing newline).
- A payload exceeding the limit **MUST** be split at the **event layer**; JSON values **MUST NOT** be split.
- Large tool output **MUST** first be streamed in chunks via `tool/updated.outputDelta` (each chunk ≤ 1 MiB); in that case `tool/completed.output` **SHOULD** be empty or a summary, with the full payload placed in `meta`.

### 4.3 Backpressure

The write side **MUST** apply backpressure (blocking writes) and **MUST NOT** buffer without bound. The read side **SHOULD** consume promptly to avoid blocking the peer.

### 4.4 Binding B (informative): HTTP + SSE

- Method = `POST /ari/<method>`; the request body is a JSON-RPC request object and the response body is a JSON-RPC response object.
- Events = the SSE stream from `GET /ari/events`, where `data:` is the JSON of an `event` notification.
- The core data model, `seq` semantics, and error codes are identical to Binding A.
- The frame limit and backpressure are handled by the HTTP layer.

---

## 5. Handshake and Version Negotiation

### 5.1 initialize

```jsonc
// client → server
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
  "protocolVersion": 1,
  "clientInfo": { "name": "mini-shell", "version": "0.0.1" },
  "clientCapabilities": { "replay": true }
}}
```

```jsonc
// server → client
{ "jsonrpc": "2.0", "id": 1, "result": {
  "protocolVersion": 1,
  "agentInfo": { "name": "SimpleAgent", "version": "0.1.0" },
  "agentCapabilities": {
    "reasoning": true,
    "question": false,
    "approvalEditInput": false,
    "usage": true,
    "compactionEvents": true,
    "replay": true,
    "fileChanges": false,
    "subagents": false,
    "backgroundTasks": false,
    "fork": false,
    "sessionList": false
  }
}}
```

### 5.2 Rules

- `protocolVersion` is a **MAJOR-only integer**.
- The Harness supports the requested MAJOR ⇒ it **MUST** respond normally (returning its own MAJOR).
- Unsupported ⇒ it **MUST** return `-32008`, with `data.supportedVersions` listing the available MAJORs. **The connection remains usable**, and the Shell **MAY** retry `initialize` **once** with a supported MAJOR.
- Before `initialize` is successfully answered, every method other than `initialize` ⇒ `-32002`.
- A second `initialize` on an already-initialized connection ⇒ `-32006` (no renegotiation; renegotiation **MUST** reconnect).
- The Shell **SHOULD** then send the `initialized` notification. That notification **does not participate in gating**: after `initialize` is successfully answered, the Harness **MUST** accept the remaining methods, and a missing `initialized` **MUST NOT** produce an error.

### 5.3 Capability Semantics

For every capability in `agentCapabilities` that is `false`, the corresponding method/event/parameter **MUST NOT** be used:

| Capability | Unlocks when `true` | Default |
|---|---|---|
| `reasoning` | `reasoning/delta` event | `false` |
| `question` | `question/requested`, `question/resolved` events; `question/respond` method | `false` |
| `approvalEditInput` | the `amendedInput` parameter of `approval/respond` | `false` |
| `usage` | `usage/updated` event | `false` |
| `compactionEvents` | `compaction/performed` event | `false` |
| `replay` | the `since` parameter of `session/resume` | `false` |
| `fileChanges` | `file/changed` event | `false` |
| `subagents` | `subagent/started`, `subagent/finished` events | `false` |
| `backgroundTasks` | `background/started`, `background/updated`, `background/finished` events | `false` |
| `fork` | `session/fork` method | `false` |
| `sessionList` | `session/list` method | `false` |

- The Harness **MUST NOT** emit events corresponding to a capability not declared `true`.
- A Shell calling a method gated by `false`, or passing a gated parameter ⇒ `-32003`.
- The Shell **MUST** ignore unknown capability keys (forward compatibility).

---

## 6. Method Overview

ARI 1.0 has **10 request methods** in total, plus the `initialized` notification and the `event` event channel:

| Method | Direction | Gating | Description |
|---|---|---|---|
| `initialize` | C→S | — | Handshake and capability negotiation (§5) |
| `initialized` | C→S | — | Notification, not part of gating (§5.2) |
| `session/new` | C→S | — | Create a session (§7.1) |
| `session/resume` | C→S | — | Replay and reconnect (§7.2) |
| `session/prompt` | C→S | — | Submit input, enqueue (§7.3) |
| `session/cancel` | C→S | — | Cancel the in-flight turn (§7.4) |
| `session/fork` | C→S | `fork` | Fork from a turn boundary (§7.5) |
| `session/list` | C→S | `sessionList` | List sessions (§7.6) |
| `shutdown` | C→S | — | Shut down (§7.7) |
| `approval/respond` | C→S | — | Answer an approval (§10.1) |
| `question/respond` | C→S | `question` | Answer a question (§10.2) |
| `event` | S→C | — | The sole notification channel (§9) |

---

## 7. Session Lifecycle

### 7.1 session/new

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":2, "method":"session/new", "params":{ "cwd":"/repo", "meta":{} } }
// S→C
{ "jsonrpc":"2.0", "id":2, "result":{ "sessionId":"s_01J9", "nextSeq":1 } }
```

- `cwd?`: working-directory hint. The Harness **MUST** validate it itself and **MUST NOT** trust it unconditionally.
- A new session's initial status is **`idle`** and `nextSeq` = **1**.
- The Harness **MUST NOT** emit any event for the session before the `session/new` response.
- The initial `idle` status is part of the definition; a `session/status` event is **not required**.

### 7.2 session/resume

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":9, "method":"session/resume", "params":{ "sessionId":"s_01J9", "since":12 } }
// S→C
{ "jsonrpc":"2.0", "id":9, "result":{
  "sessionId":"s_01J9", "replayedFrom":12, "nextSeq":14,
  "events":[ {"seq":12,"type":"message/delta","turn":1,"text":"…"} ],
  "snapshot": { "status":"idle", "nextTurn":2, "queue":[],
                "pendingApprovals":[], "pendingQuestions":[],
                "openToolCalls":[], "usage":{"inputTokens":0,"outputTokens":0} }
}}
```

- `since` omitted ⇒ replay from the beginning.
- A `since` beyond the retention window **is not an error**: the Harness **MUST** degrade to "`snapshot` + all `events` from the retention base point" and indicate the base point with `replayedFrom`. It returns `-32004` only when there is no log at all to replay (`replay:false`).
- `since` > the current watermark ⇒ `-32602` (a Shell-side bug; **MUST NOT** be silently corrected).
- Unknown `sessionId` ⇒ `-32001`. A session **MUST NOT** be created automatically.
- **Consistency cut**: in the response, the last `seq` of `events` < `nextSeq`; thereafter, live events for the same session **MUST** have `seq` ≥ `nextSeq`, with **no duplicates and no gaps**.

`snapshot` schema:

```jsonc
{ "status": "running" | "idle",
  "nextTurn": 2,
  "queue": [ { "messageId":"m_1", "content":[{"type":"text","text":"…"}] } ],
  "pendingApprovals": [ { "approvalId":"ap_1", "toolCallId":"t_1", "toolName":"shell", "reason":"…", "options":[…]? } ],
  "pendingQuestions": [ { "questionId":"q_1", "questions":[…] } ],
  "openToolCalls": [ { "callId":"t_1", "name":"shell", "status":"running" } ],
  "usage": { "inputTokens":0, "outputTokens":0 } }
```

### 7.3 session/prompt

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":3, "method":"session/prompt", "params":{
  "sessionId":"s_01J9", "content":[{"type":"text","text":"list the files in the current directory"}] } }
// S→C
{ "jsonrpc":"2.0", "id":3, "result":{ "messageId":"m_01JA" } }
```

- **A concurrent prompt is enqueued; it is neither rejected nor implicitly interrupted.** When `session/prompt` arrives while a turn is running, the Harness **MUST** accept it and append it to that session's pending-input FIFO queue.
- The guarantee scope of `messageId` is **strictly** "**durably enqueued**" — it means neither that a turn has started nor that the model has seen it.
- **Correlation obligation**: `turn/started` **MUST** carry `messageIds: string[]`, namely the messages the turn claimed from the queue (may be ≥1). Otherwise the receipt is unverifiable on the wire.
- **Queue limit**: an implementation **MAY** set an internal limit; when exceeded, it **MUST** reject that prompt with `-32005` and **MUST NOT** silently drop it.
- `content` is a `ContentBlock[]`. ARI 1.0 defines only `{"type":"text","text":string}`; other types are introduced by the extension mechanism (§12).
- Unknown `sessionId` ⇒ `-32001`.

### 7.4 session/cancel

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":4, "method":"session/cancel", "params":{ "sessionId":"s_01J9", "cause":"user" } }
// S→C
{ "jsonrpc":"2.0", "id":4, "result":{ "cancelledTurn":1, "droppedMessageIds":["m_01JB"] } }
```

- Scope = the **current in-flight turn**, and it **clears the not-yet-claimed pending-input queue** (a real stop). Otherwise the queue would immediately restart work and cancellation would be a no-op in effect.
- A cancelled turn **MUST** settle as `turn/completed{stopReason:"cancelled"}` (§8-I1).
- Dropped enqueued messages are observable via `droppedMessageIds` and `snapshot.queue`; no separate event is emitted.
- With no in-flight turn, cancel is an **idempotent no-op**.
- `cause` is an optional opaque string; ARI 1.0 does **not** define a closed enumeration (each Harness's cancellation reasons are an internal concept).
- Unknown `sessionId` ⇒ `-32001`.

### 7.5 session/fork (cap: `fork`)

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":5, "method":"session/fork", "params":{ "sessionId":"s_01J9", "atTurn":3 } }
// S→C
{ "jsonrpc":"2.0", "id":5, "result":{
  "sessionId":"s_01J9b", "nextSeq":1, "forkedFrom":{ "sessionId":"s_01J9", "turn":3 } } }
```

- Semantics: create a **new independent session** based on the source session's history up to the `atTurn` boundary.
- `atTurn` omitted ⇒ the current turn boundary is used.
- The new session **MUST** have a brand-new `sessionId`, initial status `idle`, and `nextSeq` = 1; the source session's `seq` space **MUST NOT** be reused.
- The source session is **unaffected** (fork is not move).
- `atTurn` does not exist or is not a turn boundary ⇒ `-32602`.
- Called while the capability is `false` ⇒ `-32003`.

### 7.6 session/list (cap: `sessionList`)

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":6, "method":"session/list", "params":{ "cwd":"/repo" } }
// S→C
{ "jsonrpc":"2.0", "id":6, "result":{ "sessions":[
  { "sessionId":"s_01J9", "status":"idle", "cwd":"/repo", "title":"Fix login", "createdAt":"2026-09-24T12:00:00Z" }
]}}
```

- Returns only sessions accessible to the caller. `status` is `running|idle`.
- Called while the capability is `false` ⇒ `-32003`.

### 7.7 shutdown

```jsonc
{ "jsonrpc":"2.0", "id":7, "method":"shutdown", "params":{} }   // → { "result": {} }
```

- After the response, the Harness **MUST NOT** emit any further events.
- The in-flight turn is **abandoned outright** — this is the **sole exemption** from the §8-I1 settlement invariant.
- The Harness **SHOULD** exit within a bounded time.

### 7.8 Subscription Model

- **Implicit subscription**: a connection is automatically subscribed to `event` for every session that `session/new` or `session/resume` succeeds for on that connection. There is **no** subscribe method; the only unsubscribe is closing the connection.
- Multiple connections for the same session are **allowed**: events **MUST** be broadcast to all subscribed connections; an `approval/respond` on any one connection takes effect for all.
- Events are unordered across sessions; **within one session, delivery MUST be consistent by `seq` across all connections**.

### 7.9 Ordering Guarantees

- The response to `session/prompt` **MUST** be sent before any event caused by that prompt. Otherwise the Shell cannot attribute events.
- Events from other sources (previously enqueued messages, background work) **MAY** interleave with it.
- Within a single session, events **MUST** be delivered in strictly increasing `seq` order.

---

## 8. Turn Settlement Invariants

The following invariants **MUST** hold:

- **I1 (settlement)**: within a session, every `turn/started` **ultimately corresponds to exactly one** `turn/completed` — regardless of an intervening error, cancel, approval denial, or tool failure.
  **Sole exemption**: connection/process termination (`shutdown` or a crash), in which case the in-flight turn is no longer settled and the Shell treats connection close as authoritative.
- **I2 (error does not replace settlement)**: `session/error` is **out-of-band diagnostics** and **MUST NOT** replace `turn/completed`. Even a fatal error **MUST** be concluded with `turn/completed{stopReason:"error"}`.
- **I3 (ordering)**: for a fatal error, `session/error` **MUST** be emitted first, immediately followed by `turn/completed{stopReason:"error"}`. A minimal Shell that listens only for `turn/completed` can still conclude correctly.
- **I4 (retryable errors do not end the turn)**: `session/error{retryable:true}` means the Harness will retry on its own and does **not require** the turn to end; multiple such errors **MAY** occur in the same turn.
- **I5 (error without a turn)**: `session/error.turn` **MAY** be absent — an error can occur before any turn. When absent, the Shell **MUST NOT** assume an in-flight turn exists.
- **I6 (never stuck in running)**: after any termination path, the session **MUST** reach `session/status:"idle"`.
- **I7 (interaction finality)**: every `approval/requested` / `question/requested` corresponds to **exactly one** `*/resolved`.

**Shell implementation guidance**: use `turn/completed` to determine the end of a single turn; use `session/status:"idle"` to determine that "no further work will happen automatically"; use `session/error` for diagnostics. The three MUST NOT substitute for one another.

---

## 9. Event Stream

### 9.1 Envelope and Types

```jsonc
{ "jsonrpc":"2.0", "method":"event",
  "params": { "sessionId": "s_01J9", "seq": 4, "type": "tool/started", "...payload" } }
```

| Field | Type | Rule |
|---|---|---|
| `sessionId` | string | Opaque. `s_` + ULID recommended |
| `seq` | integer | **Starts at 1**, monotonic +1 per session, **no gaps**. Replay and live share the same space |
| `type` | string | Event type, see §9.2 / §9.3 |
| `turn` | integer? | **Starts at 1**, monotonic +1 per session |
| `messageId` / `callId` / `approvalId` / `questionId` / `taskId` | string | Opaque. Prefix `m_` / `t_` / `ap_` / `q_` / `bg_` + ULID recommended |

- **The envelope fields `sessionId`, `seq` and `type` are reserved.** A payload **MUST NOT** contain a field of the same name, and a Harness **MUST** reject such an event rather than let it shadow the envelope. (This is not hypothetical: a child-session identifier in a `subagent/*` payload is named `childSessionId` for exactly this reason — see §9.3.)

### 9.2 Required Events (10)

| type | payload | Description |
|---|---|---|
| `session/status` | `status:"running"\|"idle"` | Emitted on status **change**; `idle` means "retries/queue have all finished" |
| `turn/started` | `turn, messageIds:string[]` | which enqueued messages were claimed |
| `turn/completed` | `turn, stopReason:"end_turn"\|"max_tokens"\|"cancelled"\|"refusal"\|"error"` | exactly one per started |
| `message/delta` | `turn?, text` | assistant text delta |
| `tool/started` | `turn?, callId, name, input?` | tool call begins |
| `tool/updated` | `callId, status:"pending"\|"running", title?, outputDelta?` | progress and output delta |
| `tool/completed` | `callId, status:"success"\|"error", output?, meta?` | `meta` is opaque, for UI use |
| `approval/requested` | `approvalId, toolCallId?, toolName?, reason?, options?` | `options` absent = the three enumerations (§10.1) |
| `approval/resolved` | `approvalId, decision:"allow_once"\|"allow_always"\|"deny"\|"expired"\|"cancelled"` | exactly one per requested |
| `session/error` | `error{ code, message, retryable? }, turn?` | out-of-band diagnostics |

The tool state machine converges to: **`started → (updated*) → completed`**. `tool/completed` is the only terminal event.

### 9.3 Capability Events (11)

| type | Gating | payload |
|---|---|---|
| `reasoning/delta` | `reasoning` | `turn?, text` |
| `question/requested` | `question` | `questionId, questions[{id, question, detail?, options?, multiSelect?}]` |
| `question/resolved` | `question` | `questionId, outcome:"answered"\|"declined"\|"expired"` |
| `usage/updated` | `usage` | `turn?, usage{inputTokens, outputTokens, cachedTokens?, reasoningTokens?, cost?}` |
| `compaction/performed` | `compactionEvents` | `trigger:"manual"\|"auto"\|"overflow", preTokens?, postTokens?` |
| `file/changed` | `fileChanges` | `path, kind:"create"\|"modify"\|"delete"\|"rename", diff?` |
| `subagent/started` | `subagents` | `callId?, childSessionId?, name?` |
| `subagent/finished` | `subagents` | `callId?, childSessionId?, status:"success"\|"error"\|"cancelled", summary?` |
| `background/started` | `backgroundTasks` | `taskId, title?` |
| `background/updated` | `backgroundTasks` | `taskId, status:"running"\|"pending", title?, outputDelta?` |
| `background/finished` | `backgroundTasks` | `taskId, status:"success"\|"error"\|"cancelled", output?` |

**On subagents**: ARI 1.0 standardizes only the **event surface** — "a child agent is running / has finished". Child-agent **orchestration** (spawn/send/wait/close) is **not** part of ARI. If the Harness exposes a child session, `subagent/started.childSessionId` gives its `sessionId`, and the Shell **MAY** attach to that child session via `session/resume`; when not exposed, the field is absent and the Shell **MUST NOT** assume it can attach.

Note that the field is named `childSessionId`, **not** `sessionId`: every event envelope already carries the `sessionId` of the session the event belongs to (SPEC §9.1), and a payload field **MUST NOT** shadow an envelope field.

**On background**: likewise only the event surface is standardized; no control API (start/stop/query) is provided. Scenarios that need control use the extension mechanism (§12).

### 9.4 Ordering and Replay

- Within a single session, ordering **MUST** be strictly by `seq`; across sessions it is unordered.
- `session/resume{since}` uses it to fill gaps (§7.2).
- **pending state is derivable**: an `approval/requested` with no corresponding `approval/resolved` received = waiting; after reconnecting, the current pending set is given by `snapshot.pendingApprovals` / `snapshot.pendingQuestions`.

---

## 10. Human-in-the-Loop Interaction

### 10.1 approval/respond

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":7, "method":"approval/respond", "params":{
  "sessionId":"s_01J9", "approvalId":"ap_01",
  "decision":"allow_once", "amendedInput": null } }
```

- Decision enumeration: `allow_once` | `allow_always` | `deny`.
- `approval/requested.options` (absent = the three enumerations above): `[{ "id":"allow_once"|"allow_always"|"deny", "label": string }]`.
- The Shell **MUST NOT** send a decision that does not appear in `options` (if the Harness does not want `allow_always`, it simply does not offer it). Violation ⇒ `-32602`.
- `amendedInput` is available only when `agentCapabilities.approvalEditInput` is `true`; otherwise ⇒ `-32003`.
- **fail-closed**: the Shell disappearing or timing out MUST NOT be interpreted as an allow. When the Harness falls back on its own, it **MUST** emit `approval/resolved{decision:"expired"|"cancelled"}`.

### 10.2 question/respond (cap: `question`)

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":8, "method":"question/respond", "params":{
  "sessionId":"s_01J9", "questionId":"q_01",
  "answers":[ { "id":"which", "values":["A"] } ] } }
```

- `question/requested.questions`: `[{ id, question, detail?, options?:[{id,label,detail?}], multiSelect? }]`.
- `options` absent = free-text answers (`values` is an array of strings).
- **`answers: []` = explicitly declining to answer as a whole**; a question not appearing in `answers` is treated as skipped.
- Finality: `question/resolved{outcome:"answered"|"declined"|"expired"}`.

### 10.3 Idempotency and Validity Across Disconnects

- Every `*/requested` terminates with **exactly one** `*/resolved`.
- The Harness **MUST** remember the last final outcome for each interaction id:
  - same id + same decision resent ⇒ **idempotently returns `{}`** (safe for network retries)
  - same id + a **different** decision, or an id that does not exist ⇒ `-32007`
- While the session is alive, a pending interaction **remains valid across disconnects and keeps its id**. A replayed `*/requested` is the same live request as before the disconnect; the Shell need only deduplicate by id.
- The Harness **MUST NOT** expire silently; when it falls back on its own it **MUST** emit `*/resolved`.
- After reconnection, the pending set is additionally given by `snapshot.pendingApprovals` / `snapshot.pendingQuestions`; the two channels **MUST** agree for the same id.

---

## 11. Errors

### 11.1 Error Codes

| code | Name | Trigger | Retryable |
|---|---|---|---|
| -32700 | `parse_error` | JSON parse failure | No |
| -32600 | `invalid_request` | invalid JSON-RPC object | No |
| -32601 | `method_not_found` | method does not exist | No |
| -32602 | `invalid_params` | invalid parameters (including `since` out of range, decision not in options, `atTurn` not a boundary) | No |
| -32603 | `internal_error` | internal error | Depends |
| -32001 | `session_not_found` | unknown `sessionId` (a session **MUST NOT** be created automatically) | No |
| -32002 | `not_initialized` | any method called before `initialize` is successfully answered | Yes (initialize first) |
| -32003 | `unsupported_capability` | using a method/parameter gated by a capability declared `false` | No |
| -32004 | `replay_unavailable` | no log available to replay (`replay:false`) | No |
| -32005 | `queue_full` | pending-input queue over its limit (it **MUST NOT** be silently dropped) | Yes (resend later) |
| -32006 | `already_initialized` | a second initialize on an already-initialized connection | No |
| -32007 | `unknown_interaction` | interaction id does not exist, or a repeat answer with a different decision | No |
| -32008 | `unsupported_protocol_version` | requested MAJOR unsupported (`data.supportedVersions`) | Yes (retry once with another version) |

- `-32000`…`-32099` is the range reserved for ARI/JSON-RPC.
- No request-level cancellation code (such as ACP's `-32800`) is defined: cancellation is the first-class method `session/cancel`.

### 11.2 Errors in Events

The `error` object of `session/error` reuses `{ code, message, retryable? }`, with `code` taking the values above. An error in an event does **not** terminate the connection.

---

## 12. Extension Mechanism

ARI 1.0 accommodates non-standardized capabilities through **extensions** rather than version promises.

- **`_meta`**: any object **MAY** carry free-form `_meta` fields. The Shell **MUST** ignore its contents.
- **Reserved prefix**: field names beginning with `_` are reserved for the specification; implementations **MUST NOT** use them on their own.
- **Extension events**: extension event types **MUST** begin with `x-` (e.g. `x-vendor/pty-resized`). The Shell **MUST** ignore unknown `type`.
- **Extension methods**: extension method names **MUST** begin with `x-` (e.g. `x-vendor/task/stop`).
- **Unknown fields**: the Shell and the Harness **MUST** ignore fields and capability keys they do not recognize in each other (forward compatibility).

The following are explicitly **not** in ARI 1.0, and can be provided by extensions without a version promise: tool schema standardization, client tools inversion, PTC events, compaction control, mid-flight steering (steer/inject), approval policy amendment, model and permission-mode settings, PTY/terminal passthrough, child-agent orchestration API, background-task control API.

---

## 13. Security Considerations

- **Trust boundary**: ARI gives the Shell the ability to trigger tool execution in the user's environment. Under Binding A, transport is stdio between processes of the same user; implementations **MUST NOT** expose it beyond a trusted boundary (network, cross-user) without authentication.
- **Approval fail-closed**: any uncertainty (timeout, disconnect, parse failure) **MUST** be interpreted as a denial and **MUST NOT** be interpreted as an allow.
- **Resource limits**: the 1 MiB frame limit and the queue limit are **mandatory** DoS protections and MUST NOT be treated as mere recommendations.
- **`cwd` and paths**: the Harness **MUST** validate `session/new.cwd` and paths in tool arguments and **MUST NOT** assume they are already inside a sandbox.
- **Replay**: `session/resume` replays historical events, which may contain sensitive content. The Harness **SHOULD** bind session visibility to connection identity.
- **`meta` and `_meta`**: security decisions **MUST NOT** be based on these two fields.

---

## Appendix A: Conformance Checklist

Harness side (testable item by item):

1. Calling any method before `initialize` ⇒ `-32002`.
2. A duplicate `initialize` ⇒ `-32006`.
3. An unsupported MAJOR ⇒ `-32008`, and the connection can still retry.
4. An unknown `sessionId` ⇒ `-32001`; no session is created automatically.
5. No events for the session before the `session/new` response; `nextSeq` = 1.
6. Event `seq` starts at 1 and is contiguous with no gaps; replay and live share the same space.
7. `turn/started.messageIds` is non-empty, and its messages were previously enqueued.
8. Exactly one `turn/completed` per `turn/started` (including error / cancel paths).
9. A fatal error emits `session/error` first, then `turn/completed{stopReason:"error"}`.
10. Exactly one `approval/resolved` per `approval/requested`.
11. Exactly one `question/resolved` per `question/requested` (when the `question` capability is true).
12. No events are emitted for a capability not declared `true`.
13. A method/parameter gated by `false` ⇒ `-32003`.
14. The `session/prompt` response precedes any event caused by that prompt.
15. While a turn is running, `session/prompt` is accepted and queued without interrupting the in-flight turn.
16. Queue over its limit ⇒ `-32005`; nothing is silently dropped.
17. `session/cancel` settles the in-flight turn as `cancelled` and clears the unclaimed queue.
18. For `session/resume{since}`, the last `seq` of `events` < `nextSeq`, and live events afterward ≥ `nextSeq`, with no duplicates and no gaps.
19. A `since` beyond the retention window ⇒ returns `snapshot` + `replayedFrom` rather than an error.
20. A repeated `approval/respond` with the same id and same decision ⇒ `{}`; a different decision ⇒ `-32007`.
21. Any event is ≤ 1 MiB after serialization, and stdout contains no extraneous output.
22. Any termination path ultimately reaches `session/status:"idle"` (except connection termination).

Shell side:

23. Ignores unknown event `type`, unknown fields, and unknown capability keys.
24. Does not send a decision that does not appear in `options`.
25. After a disconnect, rebuilds state with `session/resume` and restores pending interactions from `snapshot`.

---

## Appendix B: Mapping to Existing Implementations

| ARI | DSH | Codex CLI / App Server | ZCode | OpenCode | Pi | ACP |
|---|---|---|---|---|---|---|
| `initialize` | SDK `initialize` (adds version negotiation) | app-server `initialize` | V4 handshake + `HostCapabilities` | — | RPC handshake | `initialize` |
| `session/new` | `agents.create` | `thread/start` | `createSession` | `session.create` | create agent | `session/new` |
| `session/resume` | `agents.resume` + event forwarding | rollout replay | subscribe watermark | `/api/event` reconnect | — | `session/load` |
| `session/prompt` | SDK `session/prompt`→`messageId` | `turn/start` | `sendText` | `session.prompt` | `prompt` | `session/prompt` |
| `session/cancel` | `cancel(cause)` | `Op::Interrupt` | `stop` | fiber cancel | `abort` | `session/cancel` |
| `session/fork` | fork-at-turn-boundary | `InitialHistory::Forked` | `forkAssistant` | fork | fork | — |
| `session/list` | `list_agents`-like | `thread/list` | — | — | — | `session/list` |
| `event` | `session.event` + `session.status` | notification (three-level coordinate envelope) | projection + delta | EventV2 / SSE | runtime events | `session/update` |
| `message/delta` | `agent/assistant-stream` | `AgentMessageContentDelta` | `row.delta` | `message.part.updated` | `message_update` | `agent_message_chunk` |
| `reasoning/delta` | streaming reasoning | `ReasoningContentDelta` | reasoning row | reasoning part | — | `agent_thought_chunk` |
| `tool/started\|updated\|completed` | `tool/call` / `tool/result` | `item/started\|completed` | `toolCall` row | tool part state machine | `tool_execution_*` | `tool_call(_update)` |
| `approval/*` | `approval/request` waterfall | `ExecApprovalRequest` + `ReviewDecision` | `pendingInteractions` + `resolveInteraction` | `permission.asked/replied` | no built-in permissions | `session/request_permission` |
| `question/*` | `user-questions` seam | — | `userInput` | `question.asked/replied` | extension UI dialog | `elicitation/create` |
| `usage/updated` | usage event | `thread/tokenUsage/updated` | `usage` StatePatch | usage part | usage | `usage_update` |
| `compaction/performed` | `compaction/*` | `ContextCompacted` | `Compact*` | `session.compacted` | `compaction_*` | unstable |
| `subagent/*` | provider + control tools | SubAgentActivity item | child session + mirror | child session (self-subscribing) | none | none |
| `background/*` | jobs | `RunUserShellCommand` | `backgroundWorks` | weak | none | none |
| `session/error` | `agent/request-error` | `StreamError` | error state | `RetryPart` | `auto_retry_*` | — |

Mapping principle: **change the envelope, not the semantics**. The Harness's internal compaction algorithms, PTC, tool pipeline, and storage formats do **not** change in order to adapt to ARI.

---

## Appendix C: Relationship to ACP / MCP

- **MCP** solves **tool integration** (Harness ↔ tools). ARI does not duplicate it; ARI specifies only the event shape of tool **calls**. The two are orthogonal and can be used together.
- **ACP** solves the **editor ↔ agent** session protocol, which overlaps with ARI's goal. ARI's differences:
  1. **No server→client requests** (§3) — interaction goes through "event + respond method", and the Shell needs no request router.
  2. **prompt receipt ≠ turn outcome**: `session/prompt` promises only enqueueing; turn settlement is carried by `turn/completed`. In ACP v1, the `session/prompt` response itself was the end of the turn.
  3. **client tools inversion is not adopted**: the ACP v2 draft has removed the entire client execution surface.
  4. **Interactions have a final event** (`*/resolved`), and pending state is derivable after reconnect.
