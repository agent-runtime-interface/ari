# ARI Preliminary Technical Research Report

> ARI = **Agent Runtime Interface** — a runtime contract for coding agent harnesses.
> Method: **source code and real protocol implementations** are the primary evidence (every key conclusion carries a `path` + `symbol`-level citation, see `research/01…08`); product documentation is used only as a supplement and is labeled as such.
> This report answers one question: across the harnesses of today's mainstream coding agents, which are the **genuinely shared runtime abstractions** — what ARI should standardize, and what it should not touch.

---

# Part A: Survey of Existing Implementations

Detailed surveys (2000+ characters per subject, full citations) live in the `research/` directory; this section is a conclusions-level summary.

## A1. DSH (DeepSeek Harness) — [research/01-dsh.md]

**Form**: open-source monorepo (github.com/deepseek-ai/deepseek-harness, v0.1.7-alpha.1), "everything is a plugin", built on Cordis. Out-of-the-box profiles: `web / headless / sdk / sdk-minimal / acp` (docs/architecture.md:19).

**Core abstractions**:
- **Session = append-only `SessionEvent` log** (`ctx.sessions`): the "Model-visible means logged" runtime invariant — anything that enters a model request must be reconstructible from the log (architecture.md:125). Persistent event vocabulary: `turn/start|end`, `step/start|end`, `user/message`, `developer/message`, `system/message`, `assistant/message` (embedding the full timed raw stream + usage), `assistant/attempt` (failed/cancelled attempt, log-only), `tool/call` (raw unresolved arguments), `tool/result` (+ tool-private `meta`), `request/header|context`, `session/end-seed` (packages/core/session/src/types.ts; docs/subsystems/session.md:27-174). Plugin-merged extensions: `compaction/*`, `approval/asked|decided`, `todo/write`, `goal/*`, `tool/ptc-dispatch*`, etc.
- **Three event domains**: durable session events / live `agent/*` extension points (pre-step, request, assistant-stream, inbox) / capability seams (`fs/*`, `tools/*`).
- **Turn-flow state machine** (architecture.md:88-113): `turn/start → claim input → agent/pre-step(waterfall) → step/start → agent/request → streaming llm/stream → tool/call* → tools/pre|execute|post-execute → step/end → (outstanding tool calls or new input → next step) → agent/turn-stopping → turn/end`. Retries happen at `agent/request-error` (llm-retry); loop detection is the `repeat-tool-reminder` plugin; parallel tools require explicit opt-in via `isConcurrencySafe`.
- **External protocol surfaces (4)**: ① SDK JSON-RPC over stdio (newline-delimited; methods only `initialize`, `session/prompt` → durable receipt, `shutdown`; notifications `session.event`/`session.status`/`subagent.started|finished`; explicitly no cancel/version negotiation, packages/sdk/protocol/README.md:113-115); ② **ACP automation-only server** (packages/acp); ③ Web GUI (HTTP + the `/api` typed Remote layer + SSE streams, the api/ controller family); ④ Webhook (fire-and-forget session creation).
- **Approval**: closed-form `ApprovalOutcome = allowed-once | rejected | cancelled | unavailable` (fail-closed, no allow-always), per-session policy `ask | never`; `ApprovalRequest` deliberately carries no arguments (it correlates with the already-streamed tool call via `callId`); open-ended questions go through the separate `user-questions` seam (`ask_user_question`, intents such as `plan-review`).
- **Compaction**: three log-only events + the summary lands on disk as exactly one surface change (`user/message` + `surfaceOp:replace`); triggers are `pressure | context-overflow`; optional tool-result trimming, image offload; a crash leaves a detectable orphan lock.
- **PTC**: `ctx.ptcRuntime` (sandboxed JS programs + host bindings); under the `run_code` tool, **every bridged sub-call emits `tool/ptc-dispatch-start|dispatch` events and re-enters the full tool pipeline** (tool-catalog.md:22).
- **Subagent**: pluggable providers (in-process / dsh-sdk / acp bridge), the `subagent|subagent_fork` tools + the `send_message/interrupt_agent/list_agents` control tools; experimental Agent Teams (roster/task board/mailbox).

## A2. ZCode — [research/02-zcode.md]

**Form**: zai-org/ZCode (TS pnpm monorepo). The runtime is the `apps/zcode-cli` sub-monorepo; a client goes through `zcodeProtocolClient` (stdio transport) → the bootstrap protocol service (v4-bridge) → `AgentRuntime`.

**Client protocol "Protocol V4"** (`packages/shared/src/zcode-protocol-v4/`, `V4_WIRE_PROTOCOL_VERSION=3`, self-described as **not frozen**): two sides = **JSON-RPC commands + topic pub/sub**. The handshake negotiates `clientMode` (desktop-continuous | web-remote-replayable) and `HostCapabilities`; subscriptions carry a **watermark `{logEpoch, seq}`** → after the ack, delivery proceeds in `snapshot | resume` mode; frames >1MiB are fragmented + crc32; ~35 `v4/*` RPCs (conversation subscribe/resync/fileChanges/usage…); commands carry idempotency keys and baseRevision CAS.
**The most important design decision**: **the client only ever sees projections** — `ConversationRow` (9 kinds: turnHeader/userInput/assistantText/reasoning/toolCall/artifact/subagent/hookInvocation/timelineMarker) + exactly **5 delta operations** (row.appended/upserted/removed, row.delta, state.updated) + a closed `StatePatch` (~20 keys: usage, queue, pendingInteractions, backgroundWorks, subagents, goal, plan…). Internally the runtime is event sourcing (~90 SessionEventType kinds) + SQLite; the invariant is `reduce(transcript) ≡ reduce(events)`.
**Approval**: `pendingInteractions {kind: permission|userInput|workspaceHookReview}` + the `resolveInteraction` command; **the runtime side supports `modifiedInput` argument rewriting** (unique); options are allowOnce/allowAlways/deny/custom.
**The rest**: two-layer compaction (auto+micro), PAUSABLE tool timeouts, `repeatedToolCallSignature` loop detection, parallel dispatch with maxConcurrency 10, subagents get an independent sessionId + drill-down + event mirroring (the `tool_subagent` prefix), semi-native PTC (persistent NodeRepl + the DynamicWorkflow script engine).

## A3. Codex CLI (codex-rs) — [research/03-codex-cli.md]

**Form**: the Rust implementation inside openai/codex (HEAD 44b857c00e).
**Three-layer message model**: `ResponseItem` (model wire) → `ResponseEvent` (SSE decoding) → `EventMsg` (**the client-facing ~60-variant enum**, protocol.rs:1341). New naming: `TurnStarted/TurnComplete`, `Op::TurnInput`, `AgentMessageContentDelta`, `ReasoningContentDelta`; the submit wrapper has been removed (`CodexThread::submit(Op)->String`).
**Session**: append-only JSONL at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid7>.jsonl` (`RolloutLine{timestamp, ordinal, item}`); `codex resume [id|--last|--all]`; fork = `InitialHistory::Forked` + `forked_from_id`; crash recovery = reopen + a reverse JSONL scan + printing a resume hint; SQLite state db.
**Loop**: the `run_turn → run_pre_sampling_compact → build_prompt → try_run_sampling_request` streaming loop; **parallel tools = in_flight `FuturesOrdered`** (turn.rs:2502); retries back off 5s→60s + `StreamError` events; `Op::Interrupt → CancellationToken → TurnAborted{Interrupted|Replaced|ReviewEnded|BudgetLimited}`; no max_turns.
**Approval**: `AskForApproval{UnlessTrusted, OnRequest(default), Granular{5 toggles}, Never}` + `SandboxPolicy`; `request_command_approval` puts a oneshot into `TurnState.pending_approvals` and emits `ExecApprovalRequest` (**no response ⇒ Abort**); `ReviewDecision` has 8 variants, including `ApprovedForSession`, `ApprovedExecpolicyAmendment`, `NetworkPolicyAmendment`.
**Transport**: `codex proto` **no longer exists** — ① in-process async_channel (TUI); ② `codex exec --json` one-way JSONL; ③ app-server bidirectional JSON-RPC.
**Native subagents** (spawn_agent/send_message/wait_agent/close_agent/resume_agent, real thread + parent_thread_id) and **native PTC** (Code Mode: a V8 JS runtime; tool TS types generated from JSON Schema; nested tool calls routed back through ToolRouter).

## A4. OpenCode — [research/04-opencode.md]

**Form**: client/server architecture (origin anomalyco/opencode, v1.18.32). TUI/App/CLI are all HTTP/SSE clients; `packages/schema` (Effect Schema contracts) ← `packages/protocol` ← `packages/core` (SQLite/drizzle + EventV2) ← `packages/opencode` (instance runtime + Effect HttpApi server). The V1 loop and the V2 durable runtime coexist.
**Message model**: 12 kinds of Part (text/reasoning/file/agent/subtask/tool/step-start/step-finish/snapshot/patch/retry/compaction); **the tool-part state machine is `pending→running→completed|error` (no cancelled; abort → error)**. Event names (verified real): `session.created/updated`, `message.updated`, `message.part.updated/delta{field,delta}`, `session.idle`, `session.compacted`, `permission.asked/replied`, `question.asked/replied/rejected`, `file.edited`, `file.watcher.updated`, `pty.*`, `todo.updated`, V2 `session.next.*` (~30).
**Loop**: `SessionPrompt.loop` is a while(true) with one `llm.stream` per turn; the exit condition is finish ∉ {tool-calls, unknown} and no pending tools; `agent.steps ?? Infinity`; overflow triggers auto-compaction; parallel tools are settled via ai-sdk callID-keyed settlement; retry = status+RetryPart; no global timeout/budget.
**Permissions**: a ruleset (agent+session merged) of `allow/ask/deny` + patterns; `permission.asked` → a blocking Deferred → the reply is `once | always | reject` (**reject carries the user's feedback text back into the model**; always auto-releases other pending requests of the same kind); no argument rewriting.
**Distinctive**: PTY as a first-class citizen (`/api/pty` CRUD + `pty.*` events); git shadow snapshot rollback; subagents = **real child sessions** (parentID, depth limit 1, **events are not forwarded — the client subscribes on its own via the tool part's `metadata.sessionId`**); PTC is experimental (code-mode `execute`, MCP tools only); completion semantics = `session.idle` + `/wait`.
**Transport**: REST + SSE `/api/event` (`{id: evt_, type, properties}`, 10s heartbeat, filtered by workspace).

## A5. Pi (badlogic/pi-mono) — [research/05-pi.md]

**Form**: the package layout differs from what one would expect: `agent` (runtime core), `ai` (provider layer), `coding-agent` (CLI), `tui`, `chord`, `protocol/server/client` (experimental multi-client CBOR), `durable`; plus a partially implemented next-gen durable harness (Lanes + durable Tasks).
**Exactly 10 runtime events** (agent/src/types.ts:485-500): agent_start/end, turn_start/end, message_start/update/end, tool_execution_start/update/end; the product layer adds `agent_settled` ("no more automatic work: retries/overflow recovery/queues are all finished" — ARI needs this semantics), `queue_update`, `compaction_start/end`, `auto_retry_*`, etc.
**Message model**: 4 roles + extendable custom roles (declaration merging + the `convertToLlm` boundary); **SystemMessage carries the prompt + the incremental deltas of tool loading** (sections + toolsAdded/toolsRemoved); persistence and the wire use the same mechanism.
**Session**: an append-only JSONL **tree** (entries `{id,parentId}`; leaf = the last entry; branching = moving the leaf pointer; fork = copying the path to a new file; `ContextEditEntry` append-style rewrites); crash tolerance = skipping bad lines + deferring file creation.
**Key trade-offs**: **no built-in permission system** (the README says so explicitly) — an extension's `tool_call` hook returns `{block,reason}` + a generic UI dialog (RPC `extension_ui_request/response`); **no max iterations / loop detection / PTC / built-in subagents**; `stopReason==="length"` fails **all** tool calls of that message (so truncated arguments are safe); tool results are dual-channel `content(model)/details(UI)`.
**Transport**: TUI/print/json/RPC (strict-LF JSONL, ~30 commands, backpressure-aware, closed stdin = graceful shutdown) / in-process SDK / experimental CBOR multi-client.

## A6. ACP (Agent Client Protocol) — [research/06-acp.md]

**Form**: Zed Industries' public standard (agentclientprotocol.com). **Client (editor) ↔ Agent subprocess**; one connection, many sessions.
**Transport**: JSON-RPC 2.0 over stdio, **newline-delimited** (not Content-Length), with stdout purity rules; the protocol claims to be transport-agnostic (HTTP/WS is an RFD draft); integer protocolVersion, MAJOR-only + capability bits; **the wire version is decoupled from the SDK/schema artifact versions**.
**Sessions**: `session/new|load|resume|close|list|delete|prompt|cancel|set_config_option`; `session/load` **replays the full history** via session/update before answering; in v1 the **response to `session/prompt` is the end of the turn** (`stopReason: end_turn|max_tokens|max_turn_requests|refusal|cancelled`) — the v2 draft decouples this (`state_update running|idle|requires_action`).
**Stream**: 11 stable `session/update` kinds (agent_message_chunk, agent_thought_chunk, tool_call(+update, 10 kinds, pending→in_progress→completed|failed, content=content|diff|terminal, rawInput/rawOutput), plan, usage_update{used,size,cost?}…) + unstable ones (compaction, etc.).
**Client-tool inversion**: v1 makes the client the tool provider (fs/read_text_file, fs/write_text_file, terminal/create|output|kill…, elicitation/create) — **the v2 draft removed the entire client-side execution surface** ("implementations are inconsistent outside a few IDEs"), replaced by clients injecting tools through MCP servers. **This is direct evidence that ARI should not copy that design.**
**Approval**: `session/request_permission {toolCall, options[{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}]}` → `{outcome: selected|cancelled}`; **no argument rewriting**; two-level cancellation (`session/cancel` + `$/cancel_request`/-32800).
**Not covered**: subagents, background tasks (only appear in the v2 draft, "beyond the turn"), per-turn tokens (Draft RFD), compaction (unstable), PTC.

## A7. Codex App Server — [research/07-codex-app-server.md]

**Form**: `codex-rs/app-server` inside openai/codex — the JSON-RPC API through which IDE extensions/external clients drive Codex (this checkout is on the **v2 `thread.*` naming**; the legacy `newConversation/codex/event/*` no longer exists).
**Transport**: line-delimited JSON over stdio + a unix control socket + websocket + remote-control; **bidirectional**: 9 kinds of server→client request; multi-connection fan-out.
**Scale**: ~150 client→server methods (`thread/*`, `turn/*`, `fs/*`, `process/*`, `plugin/*`, `queue/*`…) + ~110 notifications (`item/*`, `thread/*`, `turn/*`, `account/*`). **A three-level coordinate envelope: almost every notification carries `thread_id/turn_id/item_id`**.
**A unified item abstraction**: 16 kinds of ThreadItem, with `item/*Delta` bracketed by `item/started|completed`.
**Approval**: the closed decision enum `Accept | AcceptForSession | AcceptWithExecpolicyAmendment | ApplyNetworkPolicyAmendment | Decline | Cancel` (item.rs:66); **the command cannot be modified**, but policy amendments can be attached; `available_decisions` is declared by the server; `approvals_reviewer=auto_review` lets a server-side subagent approve on the client's behalf.
**Client-tools inversion exists**: `thread/start.dynamic_tools` → the runtime issues `item/tool/call` requests → results flow back into core.
**Usage**: `thread/tokenUsage/updated` (cached/cache_write/reasoning_output broken out) + a dual-channel rateLimits.
**Coverage corrections**: compaction exists (`thread/compact/start`, not parameterizable); terminal support is quite complete (command/exec, process/*, backgroundTerminals); subagents have only an event surface (SubAgentActivity/CollabAgentToolCall items) with no orchestration API; the file diff is a file-level unified diff (FileUpdateChange); the raw model stream requires opting in via experimentalRawEvents.

## A8. Secondary subjects: Claude Code and Gemini CLI — [research/08-related.md]

**Claude Code**: the CLI is closed-source (no binary audit was performed); the authoritative protocol surface is the `sdk.d.ts` (9451 lines) of the npm package `@anthropic-ai/claude-agent-sdk`. `SDKMessage` has 38 members + **control frames multiplexed on the same JSON-Lines channel** `control_request/response/cancel_request` (37 subtypes, sender-chosen request_id, KeepAlive); the `initialize` response carries `pending_permission_requests` (**mid-join replay of pending approvals**) and `capabilities[]` string-based capability negotiation; `can_use_tool` → `allow{updatedInput!}/deny{interrupt}` (**approvals can rewrite arguments**); 6 permission modes; 33 hook events; `stream_event` wraps raw API deltas; `compact_boundary{trigger, pre_tokens, post_tokens, preserved_messages}`; a background-task event family + `stop_task`; `rewind_files`; interrupt receipt (`interrupt_receipt_v1`).
**Gemini CLI**: open source. Core event `ServerGeminiStreamEvent` (18 GeminiEventType kinds, including `LoopDetected`, `MaxSessionTurns`, `ContextWindowWillOverflow`); the de facto wire format = `--output-format stream-json` (init/message/tool_use/tool_result/error/result); a 7-state scheduler state machine (validating→awaiting_approval→executing→…); `ToolConfirmationOutcome` has 7 values (including `modify_with_editor`); **a confirmed ACP adapter** (packages/cli/src/acp/); compaction is visible (`ChatCompressed`, 0.5 threshold); no fork, no interrupt receipt, no background-task notification family.

---

# Part B: Common Runtime Model (abstracted from the implementations)

Every concept below has direct evidence from at least 3 implementations; the strongest evidence source is cited.

**B1. Session = immutable event ledger + identity + resume.**
DSH: append-only SessionEvent log, generations are never rewritten [01]; Pi: append-only JSONL tree (branching = moving the leaf) [05]; Codex: rollout JSONL (append-only + ordinal) [03]; ZCode: SQLite + event sourcing + `reduce(transcript)≡reduce(events)` [02]; OpenCode: SQLite + EventV2 [04]; Claude: SessionStore/rewind [08]. **No implementation implements a "session" as a mutable message array.**

**B2. What the client sees is a "projected event stream", not model messages.**
ZCode is the most deliberate implementation (the client sees only ConversationRow + 5 kinds of delta operations + StatePatch [02]); DSH uses SurfaceEventType/surfaceOp to separate the model surface from the log surface [01]; Codex EventMsg is independent of ResponseItem [03]; OpenCode Part/event system [04]; ACP session/update [06]. **The separation of "model API messages" from "harness runtime events" is a structure common to all implementations** — what ARI should standardize is the latter.

**B3. Turn = unit of work; Step = one model call.**
DSH turn/step two-layer events [01]; Codex turn/step [03]; OpenCode step-start/step-finish Part [04]; Pi turn_start/end [05]; ZCode turnHeader row [02]; Gemini MaxSessionTurns [08]. A turn has an ID/ordinal and an outcome (see B4).

**B4. Submission and completion are decoupled: a prompt receipt ≠ the turn outcome.**
DSH `session/prompt` returns a durable enqueue receipt `messageId` [01]; Pi `agent_settled` vs `agent_end` [05]; OpenCode `session.idle` + `/wait` [04]; Claude `user_message_uuid` binding + `result` message [08]; ZCode command idempotency key + queue/state patch [02]; ACP v2 `state_update` [06]. **ARI must define "accepted" and "done" as two distinct semantics.**

**B5. Tool call lifecycle = correlation id + closed state machine.**
callID correlation: all implementations. State machines: OpenCode `pending→running→completed|error` (no cancelled) [04]; ACP `pending→in_progress→completed|failed` [06]; ZCode toolCallRow with 7 states (including pendingApproval/backgrounded) [02]; Pi start/update/end + isError [05]; Codex Begin/End [03]. Convergent shape: **started → (progress*) → completed|error**.

**B6. Human interaction has two distinct channels: closed-form approval + open-ended question.**
Closed-form (decision-only): DSH ApprovalOutcome [01], Codex ReviewDecision [03], ACP permission options [06], OpenCode once/always/reject [04], ZCode permission [02], Gemini ToolConfirmationOutcome [08].
Open-ended (free-form answer): DSH user-questions [01], OpenCode question.asked [04], ZCode userInput [02], Gemini ask_user confirmation [08], the Claude AskUserQuestion tool.
**Merging the two into one is a design error** (DSH explicitly separates the seams).

**B7. Streaming = ordered incremental events + settlement.**
Text deltas: 8/8. Reasoning deltas: 7/8 (Claude is partial). Tool output streaming: DSH (none)/ZCode (row.delta)/Codex (ExecCommandOutputDelta)/OpenCode (metadata per chunk)/Pi (partialResult)/Gemini/Claude — **granularity differs, but the two-layer structure of "increments + final settlement" is consistent** (DSH: transient chunk + durable settlement [01]; Pi: message_update + message_end [05]).

**B8. Cancellation is an explicit intent, and it carries a cause.**
DSH `cancel(cause)` [01]; Codex TurnAborted{4 reasons} [03]; ZCode stop [02]; OpenCode fiber cancel [04]; Pi abort [05]; ACP session/cancel plus request-level `$/cancel_request` [06]; Claude interrupt + receipt [08].

**B9. Usage is part of the protocol surface.**
8/8 have token metering; granularity diverges (per message [01][05], per turn [07][08], session-level [06]) plus rate limits (Codex/Claude).

**B10. Compaction is a Runtime-internal behavior, but it produces visible events.**
Claude compact_boundary, OpenCode session.compacted, Pi compaction_start/end, DSH compaction/* events, Codex ContextCompacted, Gemini ChatCompressed, ZCode Compact*. ACP is the only one without them (unstable). **Consensus: the algorithm is private, the events are public.**

**B11. Capability negotiation + versioning.**
ACP protocolVersion + capability bits [06]; Claude capabilities[] [08]; ZCode HostCapabilities/clientMode [02]; DSH's lack of version negotiation is itself a cautionary counterexample (a known limitation [01]).

**B12. Mid-join / replay.**
ACP session/load full replay [06]; ZCode watermark snapshot|resume [02]; DSH projection snapshot + full session/event forwarding [01]; Claude pending_permission_requests replay [08]; Codex rollout replay [03].

**B13. The tool set is a Runtime asset, not a protocol asset.**
No protocol standardizes the tool set (ACP only declares promptCapabilities; Codex App Server lists tools but does not define their semantics; ZCode uses a per-turn disallowlist). MCP is the de facto standard for tool integration (8/8 integrate it). **ARI does not define tools; it only defines the event shape of tool calls.**

**Minimal concept set** (the "noun list" of a modern Coding Agent Runtime):
`Session`, `Event(seq)`, `Turn`, `Step(implicit)`, `Message delta`, `ToolCall(call_id, status)`, `Approval(decision)`, `Question(answer)`, `Cancellation(cause)`, `Usage`, `Compaction(event)`, `Capability/Version`.

---

# Part C: Divergence (differences and trade-offs)

## C1. Must standardize (present in all implementations, and semantics can be unified)

| Concept | Evidence |
|---|---|
| JSON-RPC envelope + NDJSON framing (recommended binding) | ACP/DSH SDK/Codex App Server/ZCode/Pi RPC/Claude are all line-delimited; the only HTTP outlier is OpenCode |
| initialize + protocolVersion + capabilities | ACP/Claude/ZCode; DSH's lack of it is a documented limitation |
| session/new, resume, (list) | 8/8 |
| prompt → receipt; status/idle → completion | B4 |
| turn.started/completed + stop_reason | B3/B4 |
| message/reasoning delta | B7 |
| tool started/updated/completed (call_id) | B5 |
| approval.requested/respond (closed-form enum) | B6 |
| session/cancel | B8 |
| error events (with stream/retry semantics) | Codex StreamError, Pi auto_retry, Claude api_retry, Gemini InvalidStream/Retry |
| per-session monotonic seq + replay semantics | B12 |

## C2. Should standardize (present in most, shapes slightly differ; unify within v0.x)

- **usage/updated**: granularity should be "per turn + session cumulative" (Codex [07], Claude [08], DSH [01]).
- **compaction/performed event**: notification only (trigger + optional token before/after values, like Claude compact_boundary [08]).
- **question/requested/respond**: open-ended questions (strong evidence from DSH/OpenCode/ZCode).
- **Session-level memory for approvals**: `allow_always` (ACP kind, OpenCode always, Codex ApprovedForSession, Claude updatedPermissions).
- **Approval-time argument rewriting**: `amended_input` (Claude updatedInput!, ZCode modifiedInput) — as a capability flag (`approval.edit_input`), off by default.
- **replay/mid-join parameters**: `session/resume {since}` (evidence from ZCode/ACP/Claude).
- **fork**: Claude forkSession [08], Codex fork [03], DSH fork-at-turn-boundary [01], Pi fork [05], ZCode forkAssistant [02], OpenCode fork [04]; Gemini/ACP have none. **Already in ARI 1.0** as `session/fork` (cap `fork`).

## C3. Can be a capability (presence diverges strongly; mandating it would break the "small protocol")

- **subagent**: Codex native [03] / DSH provider [01] / ZCode child session + mirroring [02] / OpenCode child session self-subscribing [04] / Claude Task [08] vs Pi and ACP explicitly not doing it [05][06]. → The ARI 1.0 event surface (`subagent/started`, `subagent/finished` + optional child session attach).
- **background task**: DSH unified jobs [01], Codex RunUserShellCommand [03], ZCode backgroundWorks [02], Claude task_* [08] vs OpenCode/Pi weak, ACP none. → capability.
- **terminal/PTY bridge**: OpenCode `/api/pty` [04], DSH terminals [01], Codex process/* [07] vs **ACP v1 client-exec was removed in v2** [06]. → Not in core; the terminal lifecycle only needs to be exposed via tool call events.
- **Structured file change events**: OpenCode file.edited + patch part [04], Codex PatchApply/TurnDiff [03], DSH fs/* + changes feed [01] vs Pi only details.diff [05]. → Provided in ARI 1.0 as capability `fileChanges` (event `file/changed`).
- **client tools inversion** (the client acts as the tool provider): deleted in ACP v1→v2 (counter-evidence) [06]; Codex dynamic_tools exists [07]. → Not in ARI 1.0.
- **PTC**: see C4.

## C4. Should stay entirely inside the Runtime (evidence supports "should not be protocolized")

- **Context assembly / deriveMessages / system prompt composition**: all private (DSH system-prompt seam [01], ZCode projection [02], OpenCode system=env+AGENTS.md… [04]).
- **Compaction algorithms/thresholds**: private; the protocol only carries events (B10). DSH's shadowedSeqs bookkeeping, Pi's firstKeptEntryId, and OpenCode PRUNE_MINIMUM/PROTECT are all internal details.
- **Model routing/retry policies/backoff**: private (Codex 5s→60s [03], Pi 3 times at 2s [05], OpenCode RetryPart [04]). The protocol only requires `error{retryable?}` semantics.
- **Sandbox and tool execution world**: private (Codex SandboxPolicy [03], DSH ctx.sandbox [01]). Invisible to the protocol.
- **PTC execution**: the verdict = **Runtime implementation detail**. Evidence: DSH's bridged sub-call re-enters the normal tool pipeline and emits an ordinary `tool/ptc-dispatch` event [01]; Codex Code Mode nested calls return to the ordinary event stream via ToolRouter [03]; OpenCode code-mode only orchestrates MCP tools [04]. **The shell does not need to know that "a program is running"; it only needs to see the (already existing) tool call events** — at most, add an optional `program_started/finished` event (an extension, not in core).
- **Session storage format/generation/migration**: private (DSH vN [01], Codex rollout [03], ZCode SQLite [02]).
- **Iteration limits/loop detection**: divergent (Gemini MaxSessionTurns/LoopDetected [08], ZCode signature streak [02], OpenCode agent.steps [04], DSH repeat-tool-reminder [01], Codex/Pi none) — semantically this is Runtime self-protection, not a contract the shell cares about.

---

# Part D: The ARI 1.0 Proposal (research conclusions)

> This part is the proposal derived from the survey; **the normative version is [SPEC.md](SPEC.md)**, and where the two conflict, SPEC.md prevails.

> The design order follows: source code → behavioral model (Part A) → shared abstractions (Part B) → required capabilities (Part C) → and only then this section.
> Goal: **implementable by a single independent developer within days**. The entirety of the ARI 1.0 core = **10 request methods + 21 event types + 1 handshake**.
> (Count corrections: the draft said 13, but the D6 table actually lists 14 rows — if the derivable `file/changed` is excluded, the core is exactly 13; after this round adds `approval/resolved` and `question/resolved`, it is **16 rows / core 15**. The method count "9" includes the `initialized` notification; the request-method count is 8, see D3/D4/D5.)

## D1. Principles

1. Protocol decoupled from Transport: the core = method names + payload schemas + ordering/replay guarantees.
2. Standardize only the shared abstractions of B1–B12; C3 always becomes a capability; C4 is never touched.
3. Do not define tool schemas, do not define the UI, do not define the Model Provider, do not prescribe Harness internals (including compaction/PTC/sandbox).
4. Extensibility follows ACP/MCP: free-form `_meta` fields + the reserved `_` prefix; unknown events/fields must be ignored (a compromise between ZCode's closed projection and ACP's open worlds: **enumerations closed within ARI 1.0, maps open via _meta**).

## D2. Transport binding

- **Normative binding A (recommended)**: **JSON-RPC 2.0 over stdio, newline-delimited** (embedded newlines forbidden; stdout purity). Evidence: 6.5/8 subjects do this (ACP [06], DSH SDK [01], Codex App Server [07], ZCode V4 command surface [02], Pi RPC [05], Claude JSON-Lines [08]).
- **Informative binding B**: HTTP + SSE (the OpenCode shape [04]): methods = POST routes, events = SSE stream. The core data model is unchanged.
- Not prescribed: Content-Length framing (used by neither ACP nor Codex), WebSocket, Unix socket (possible future bindings).

## D3. Handshake

```jsonc
// client → server
{ "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
  "protocolVersion": 1,
  "clientInfo": { "name":"mini-shell", "version":"0.0.1" },
  "clientCapabilities": { "replay": true }            // optional capability bit
}}
// server → client
{ "jsonrpc":"2.0", "id":1, "result":{
  "protocolVersion": 1,                                // integer, MAJOR-only (ACP evidence [06])
  "agentInfo": { "name":"SimpleAgent", "version":"0.1.0" },
  "agentCapabilities": {
    "reasoning": true,          // will emit reasoning/delta
    "question": false,          // supports open-ended questions
    "approvalEditInput": false, // approvals may carry amended_input (Claude/ZCode evidence)
    "usage": true,
    "compactionEvents": true,
    "replay": true,             // session/resume supports since
    "fileChanges": false,       // structured file/changed events
    "subagents": false,         // cap: subagent/* events
    "backgroundTasks": false,   // cap: background/* events
    "fork": false,              // session/fork
    "sessionList": false        // session/list
  }
}}
```
**Version negotiation failure** (server does not support the requested MAJOR):

```jsonc
{ "jsonrpc":"2.0", "id":1, "error":{ "code":-32008, "message":"unsupported protocol version",
  "data":{ "supportedVersions":[1] } } }
```

- `protocolVersion` is a **MAJOR-only integer** (ACP evidence [06]); if the server supports the requested MAJOR ⇒ normal response (returning its own MAJOR).
- Not supported ⇒ `-32008` + `data.supportedVersions`; **the connection remains usable**, and the client may **retry initialize once** with a supported MAJOR.
- Before the successful response, every method other than `initialize` → `-32002` (likewise within the version-retry window).
- initialize again on an already-initialized connection ⇒ `-32006` (no renegotiation; renegotiation requires a reconnect).
- The client then sends the `initialized` notification (aligned with ACP/Codex App Server); **this notification does not participate in gating** — the server must accept the remaining methods as soon as it has sent the successful initialize response, and a missing `initialized` is not an error (avoiding a pointless failure mode introduced merely to align with ACP).

## D4. Session lifecycle (client → server, 7 methods)

```jsonc
session/new     { cwd?, meta? }                        → { sessionId, nextSeq }   // nextSeq = the seq the next event will use; 1 for a new session (draft used the field name `seq`; unified with resume as `nextSeq`)
session/resume  { sessionId, since? }                  → { sessionId, replayedFrom, nextSeq, events[], snapshot? }
session/prompt  { sessionId, content: ContentBlock[] } → { messageId }        // durable enqueue receipt, ≠ turn outcome (B4)
session/cancel  { sessionId, cause? }                  → { cancelledTurn?, droppedMessageIds: string[] }
session/fork    { sessionId, atTurn? }                 → { sessionId, nextSeq, forkedFrom }   // cap: fork
session/list    { cwd? }                               → { sessions[] }                        // cap: sessionList
shutdown        {}                                     → {}
```
- **Concurrent prompts = enqueue; never rejected, never implicitly interrupted.** A `session/prompt` received while a turn is running is always accepted and appended to that session's **pending-input FIFO queue**. The scope of the `messageId` promise is strictly "**durably enqueued**" — it means neither that the turn has started nor that the model has seen it. Evidence: the ZCode input queue (`sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem/setAutoDrain`, `TurnMachine.queuePendingInput/drainPendingInputs` [02]); the DSH inbox's `nextTurn`+`nextStep` dual ordered queues and claim semantics [01].
- **Correlation obligation**: `turn/started` must carry `messageIds: string[]` (the messages that turn claimed from the queue; may be ≥1 — a single DSH claim can take multiple [01]). Without it, the receipt cannot be correlated on the wire with any event, and "enqueued" is unverifiable.
- **Queue limit**: implementations may set an internal cap; when it is exceeded, that prompt must be rejected with JSON-RPC error `-32005`, **never silently dropped**.
- **Mid-turn steering (steer/inject) is not in ARI 1.0**: DSH `steer()` (consumed at the nearest step boundary)/`followup()`/`inject()` and ZCode's guide-vs-queue split diverge too much [01][02] → goes through extensions (SPEC §12).
- Omitted `since` = replay from the beginning. **`since` beyond the retention window is not an error**: the server must degrade to "`snapshot` + all `events` from the retention baseline", marking the baseline with `replayedFrom` (in ZCode the server chooses between `snapshot | resume` modes [02]). `-32004` is returned only when the server has no log at all (`replay:false`).
- `since` > the current watermark (a future seq) ⇒ `-32602` (a client bug; not silently corrected).
- **Conformance seam of resume**: the last seq among the response's `events` < `nextSeq`; live events for the same session thereafter have seq ≥ `nextSeq`, **no gaps and no duplicates** (watermark semantics, ZCode [02]).
- **The `snapshot` schema** (the minimal projection for rebuilding the live UI after a reconnect; isomorphic to ZCode StatePatch / Claude SessionState [02][08]):

```jsonc
{ "status":"running"|"idle", "nextTurn":2,
  "queue":[{"messageId":"m_1","content":[{"type":"text","text":"…"}]}],
  "pendingApprovals":[{"approvalId":"ap_1","toolCallId":"t_1","toolName":"shell","reason":"…","options":[…]?}],
  "pendingQuestions":[{"questionId":"q_1","questions":[…]}],
  "openToolCalls":[{"callId":"t_1","name":"shell","status":"running"}],
  "usage":{ "inputTokens":0, "outputTokens":0 } }
```

- **Subscription model (ARI 1.0 = implicit subscription)**: a connection is automatically subscribed to `event` for "every session whose `session/new` or `session/resume` succeeded on this connection", **with no subscribe method**; the only unsubscribe = closing the connection. Multiple connections per session are allowed (Codex App Server multi-connection fan-out [07]): events are broadcast to all subscribed connections, and `approval/respond` on any connection takes effect across all of them.
- **Ordering guarantee**: the response to `session/prompt` must be emitted before "any event caused by that prompt" (otherwise the Shell cannot attribute events); events from other sources (previously enqueued messages, background work) may interleave with them. Across sessions there is no ordering, but the same session is delivered in seq order consistently on all connections.
- **cancel semantics**: acts only on the **current in-flight turn** and **clears the pending-input queue of not-yet-claimed messages** — i.e., a real stop; otherwise the queue would immediately restart work and Ctrl-C would be an empty gesture. A cancelled turn must settle as `turn/completed{stopReason:"cancelled"}`; dropped enqueued messages are observable via the response's `droppedMessageIds` and `snapshot.queue`, with no extra events. With no in-flight turn, cancel is an idempotent no-op. `cause` is an optional opaque string; ARI 1.0 defines no closed-form enumeration for it (Codex's 4 reasons are runtime-internal [03]).
- `shutdown`: a client→server request; after the response the server **must not emit any more events** and abandons the in-flight turn outright — this is the **only exemption** from the D9-I1 settlement invariant — and it should exit within finite time.
- In ARI 1.0 `ContentBlock` is only `{"type":"text","text":string}`; `image` etc. are capability extensions (the same lesson as ACP/MCP: keep the baseline minimal).
- `session/list` (capability `sessionList`) and `session/fork` (capability `fork`) are covered in SPEC §7.5–7.6.

## D5. Human-in-the-loop interactions (2 methods)

```jsonc
approval/respond { sessionId, approvalId,
  decision: "allow_once" | "allow_always" | "deny",
  amendedInput? }                                    → {}   // amendedInput only when agentCapabilities.approvalEditInput
question/respond { sessionId, questionId,
  answers: [{ id, values: string[] }] }              → {}   // only when agentCapabilities.question
```
The decision enumeration is the intersection across all parties: `allow_once` (DSH allowed-once [01], ACP allow_once [06], OpenCode once [04]), `allow_always` (ACP/OpenCode/Codex ApprovedForSession [03][06]), `deny` (all). Parameter rewriting (Claude updatedInput [08], ZCode modifiedInput [02]) and "deny + feedback text" (OpenCode [04]) do not enter the ARI 1.0 enumeration — the former goes through a capability; for the latter the Shell can simply send another prompt itself.

**Shapes and constraints** (closing the gaps the review pointed out: "options had no schema, questions had no way to decline, validity across disconnects"):

- `approval/requested.options` (default = the three-value enumeration above): `[{ id:"allow_once"|"allow_always"|"deny", label: string }]`. **The client must not send a decision that does not appear in options** (if the server does not want `allow_always`, it simply omits it — no new capability bit needed); violation ⇒ `-32602`.
- `question/requested.questions`: `[{ id, question, detail?, options?: [{ id, label, detail? }], multiSelect?: boolean }]`; `options` omitted = free-text answering (`values` is an array of strings). **`answers: []` = an explicit overall decline to answer**; a question absent from `answers` is treated as skipped — this adds the "decline/skip" representation missing from the draft.
- **Idempotence and finality**: each `approval/requested`/`question/requested` is terminated by **exactly one** `*/resolved` event (D6/D9-I7). The server must remember the last final outcome for each id: **same id + same decision resent ⇒ idempotent return of `{}`** (safe under network retries); **same id + a different decision, or a nonexistent id ⇒ `-32007`**.
- **Validity across disconnects (the landing of B12)**: pending interactions **remain valid across disconnects for as long as the session lives, and keep their id** — the `approval/requested` replayed after a reconnect is the same live request as before the disconnect, so the Shell just deduplicates by id; the runtime **must not silently expire** them, and if it applies its own fallback (timeout, fail-closed on disconnect) it must emit `approval/resolved{decision:"expired"|"cancelled"}` (on the question side, `outcome:"expired"`). The pending set after a reconnect is given separately by `snapshot.pendingApprovals/pendingQuestions` (D4); the two channels must agree on the same id. Evidence: Claude `initialize` replays `pending_permission_requests` [08]; ZCode `pendingInteractions` + `resolveInteraction` [02]; DSH fail-closed `unavailable` [01].

## D6. Event stream (server → client, 1 notification channel)

Unified envelope (aligned with the ZCode projection + DSH session.event + Codex's three-level coordinates):

```jsonc
{ "jsonrpc":"2.0", "method":"event",
  "params": { "sessionId": string, "seq": integer, "type": string, ...payload } }
```
- **ID / sequence types (undefined in the draft)**: `sessionId`/`messageId`/`callId`/`approvalId`/`questionId` = **opaque strings** (recommended: `s_`/`m_`/`t_`/`ap_`/`q_` + ULID); `seq` = integer, **starting at 1**, monotonic +1 per session, no gaps; `turn` = integer, **starting at 1**, monotonic +1 per session (DSH/Codex ordinal semantics [01][03]).
- **seq starts at 1**: the first event of a new session has seq=1; the `seq` returned by `session/new` is "the seq the next event will use" (1 for a new session). **Replayed events and live events share the same seq space**, so the `since` semantics of Example 3 are unambiguous.
- **Per-frame limit (binding A)**: any NDJSON line ≤ **1 MiB** (1,048,576 bytes, excluding the newline). Oversized payloads must be split at the **event layer**, never by cutting a JSON value: large tool output is first streamed in chunks via `tool/updated.outputDelta` (each chunk ≤1 MiB), `tool/completed.output` is then empty or a summary, and the full payload goes into `meta`/`outputRef`. Evidence: ZCode >1MiB frame splitting [02], Pi's backpressure awareness [05]. The writing side must apply backpressure (blocking writes) rather than unbounded buffering (Pi [05]).
- Event types (the full ARI 1.0 set, 21 = 10 required + 11 capability-gated):

| type | payload essentials | corresponding evidence |
|---|---|---|
| `session/status` | `status: "running"\|"idle"`; idle is Pi's `agent_settled` semantics (retries/queue all finished) | [01][04][05] |
| `turn/started` | `turn, messageIds: string[]` (the enqueued messages claimed by that turn, the D4 correlation obligation) | [01][03][05] |
| `turn/completed` | `turn, stopReason: end_turn\|max_tokens\|cancelled\|refusal\|error` | [03][06][08] |
| `message/delta` | `turn?, text` (assistant text deltas) | 8/8 |
| `reasoning/delta` | `turn?, text` (cap: reasoning) | 7/8 |
| `tool/started` | `turn?, callId, name, input?` | B5 |
| `tool/updated` | `callId, status: "pending"\|"running", title?, outputDelta?` | [02][04][05] |
| `tool/completed` | `callId, status: "success"\|"error", output?, meta?` (meta opaque, a UI payload) | [01][05] |
| `approval/requested` | `approvalId, toolCallId?, toolName?, reason?, options?` (options omitted = the three-value enumeration) | B6 |
| `approval/resolved` | `approvalId, decision: "allow_once"\|"allow_always"\|"deny"\|"expired"\|"cancelled"` (exactly **one** per requested) | [02][03][06] |
| `question/requested` | `questionId, questions[{id, question, detail?, options?, multiSelect?}]` (cap: question) | [01][04] |
| `question/resolved` | `questionId, outcome: "answered"\|"declined"\|"expired"` (cap: question; exactly **one** per requested) | [01][04] |
| `usage/updated` | `turn?, usage{inputTokens, outputTokens, cachedTokens?, reasoningTokens?, cost?}` | B9 |
| `compaction/performed` | `trigger: "manual"\|"auto"\|"overflow", preTokens?, postTokens?` (cap: compactionEvents) | B10 |
| `file/changed` | `path, kind: "create"\|"modify"\|"delete"\|"rename", diff?` (cap: fileChanges) | C3 |
| `subagent/started` | `callId?, childSessionId?, name?` (cap: subagents; only the event surface is standardized — orchestration is not in the protocol. **The field must not be named `sessionId`** — it would shadow the envelope's same-named field) | [01][02][03][04][08] |
| `subagent/finished` | `callId?, childSessionId?, status: "success"\|"error"\|"cancelled", summary?` (cap: subagents) | same as above |
| `background/started` | `taskId, title?` (cap: backgroundTasks; no control API) | [01][02][03][08] |
| `background/updated` | `taskId, status: "running"\|"pending", title?, outputDelta?` (cap: backgroundTasks) | same as above |
| `background/finished` | `taskId, status: "success"\|"error"\|"cancelled", output?` (cap: backgroundTasks) | same as above |
| `session/error` | `error{ code, message, retryable? }` | B8/C2 |

- **Ordering**: strictly by seq within a single session; unordered across sessions. The same session is delivered in seq order consistently on all subscribed connections (the D4 subscription model).
- **Pending state is derivable**: an `approval/requested` with no corresponding `approval/resolved` = waiting; after a reconnect the current pending set is given by `snapshot.pendingApprovals/pendingQuestions` (isomorphic to Claude SessionState `requires_action` [08] and ACP v2; can be added later). **The draft's claim that "no extra state bit is needed" holds only for a single connection that never reconnects** — it is precisely the `*/resolved` events (+ snapshot) that make this hold in the disconnect scenario too, which is also why they are the only event types added this round (see D9-I7).

## D7. Explicitly excluded from ARI 1.0 (with reasons)

| Excluded item | Reason (evidence) |
|---|---|
| Tool schemas/schema standardization | B13; MCP already solved tool integration, do not duplicate it |
| client tools inversion (fs/terminal callbacks) | ACP v2 removed that surface [06]; Codex keeps dynamic_tools in-house [07] |
| PTC events/control | C4: runtime detail; bridged calls are already ordinary tool events [01][03] |
| subagent orchestration | C3: the greatest divergence; 1.0 standardizes only the event surface, orchestration goes through extensions |
| background task control | C3: 1.0 standardizes only the event surface, control goes through extensions |
| terminal bridge (PTY passthrough/output subscription) | C3: counter-evidence from ACP v2; the runtime has its own UI channel [04][01] |
| compaction control (manual trigger/parameters) | even the Codex App Server is "not parameterizable" [07]; DSH has a manual command but it is a human command, not protocol [01] |
| approval policy amendment (execpolicy amendment) | Codex-specific [03][07]; does not fit a closed enumeration; goes through extensions (SPEC §12) |
| model/permission-mode settings | Claude set_permission_mode/set_model [08] and ZCode switchCollaborationMode [02] are product surface; a one-time declaration via `session/new meta` suffices |

## D8. The "implementable in days" self-check

The minimal obligations of an ARI 1.0-conformant Runtime: stdin JSONL parsing (~50 lines) + initialize/the three session methods/the two respond methods (~100 lines) + mapping its own loop events onto the 21 event types (~100 lines) + cancel. **A SimpleAgent with no ledger, no compaction, and no subagents can still conform** — as long as it declares its capabilities truthfully (publishes no compaction events, `compactionEvents:false`). Reverse self-check: mapping the existing protocol surfaces of DSH/Codex/ZCode onto ARI 1.0 is everywhere at the level of "change the envelope, not the semantics" (see Example 4).

## D9. Settlement invariants and error codes (answering "which event to listen to when wrapping up")

### D9.1 Turn settlement invariants

- **I1 (settlement)**: within the same session, every `turn/started` is **eventually matched by exactly one** `turn/completed` — regardless of an error, cancel, approval denial, or tool failure along the way. **The only exemption**: connection/process termination (`shutdown` or crash), in which case the in-flight turn is no longer settled and the Shell takes connection closure as final (D4).
- **I2 (error does not replace settlement)**: `session/error` is an **out-of-band diagnostic** and never substitutes for `turn/completed`. Even a fatal error must end with `turn/completed{stopReason:"error"}`. This is the item most missing from the draft: implementers should listen to `turn/completed` for wrap-up and to `session/error` for diagnostics; the two must not stand in for each other.
- **I3 (ordering)**: on a fatal error, emit `session/error` first, immediately followed by `turn/completed{stopReason:"error"}` — then even a minimal Shell that listens only to `turn/completed` (the SimpleAgent of D8 is exactly this case) wraps up correctly.
- **I4 (retryable errors do not end the turn)**: `session/error{retryable:true}` means the runtime will retry on its own and **does not require** the turn to end; several may occur within the same turn. Codex `StreamError` with 5s→60s backoff [03], Pi `auto_retry_*` [05], Claude `api_retry` [08], and Gemini `InvalidStream/Retry` [08] all have this shape.
- **I5 (error without a turn)**: `session/error.turn?` may be omitted — errors can occur before any turn (prompt validation failure, model unreachable, etc.). When `session/error` carries no `turn`, the Shell must not assume an in-flight turn exists.
- **I6 (never stuck in running)**: after any termination path the session must reach `session/status:"idle"`; idle is Pi's `agent_settled` semantics (retries/queue all finished) [05], and the Shell uses it to conclude that "no more work will happen on its own".
- **I7 (interaction finality)**: each `approval/requested`/`question/requested` gets exactly one `*/resolved` (D5).

### D9.2 Error code table

| code | Name | Trigger | Retryable |
|---|---|---|---|
| -32700 / -32600 / -32601 / -32602 / -32603 | JSON-RPC standard | parse / request / method / params / internal | as applicable |
| -32001 | `session_not_found` | `sessionId` unknown (consistent across prompt/resume/cancel/respond; **no automatic session creation**) | No |
| -32002 | `not_initialized` | any method called before the successful initialize response (including within the version-retry window) | Yes (initialize first) |
| -32003 | `unsupported_capability` | using a method/parameter declared false in agentCapabilities (e.g. `amendedInput`, `question/respond`) | No |
| -32004 | `replay_unavailable` | `replay:false`, or the server has no log to replay at all | No |
| -32005 | `queue_full` | the pending-input queue exceeds the implementation's cap (**never silently dropped**) | Yes (resend later) |
| -32006 | `already_initialized` | initialize again on an already-initialized connection (renegotiation requires a reconnect) | No |
| -32007 | `unknown_interaction` | `approvalId`/`questionId` does not exist, or **answering again with a different decision** an already-final interaction | No |
| -32008 | `unsupported_protocol_version` | the MAJOR requested by initialize is unsupported (`data.supportedVersions`) | Yes (retry once with another version) |

Note: ACP's `-32800` (`$/cancel_request`) does not apply in ARI 1.0 — cancellation is a first-class method, `session/cancel`, so the error surface needs no request-level cancellation code [06].

---

# Part E: Examples

## Example 1 — A minimal Shell connecting to a Runtime

```
Shell                          Runtime                        Model/Tools
  │ initialize ────────────────▶│
  │◀──────────────── result ────│
  │ initialized (notification)▶│
  │ session/new ───────────────▶│
  │◀──────────────── result ────│
  │ session/prompt "list files" ─▶│──▶ LLM stream
  │◀──────────── { messageId } ──│
  │◀─ event seq1 session/status running                        │
  │◀─ event seq2 turn/started {turn:1, messageIds:["m_01JA"]}   │  ← which enqueued messages were claimed
  │◀─ event seq3 message/delta "Let me look at the directory…"  │
  │◀─ event seq4 tool/started {callId:t1, name:"shell"} ───────▶│ execute
  │◀─ event seq5 tool/completed {callId:t1, status:"success"} ◀─│
  │◀─ event seq6 message/delta "The directory has a.txt, b.md"  │
  │◀─ event seq7 turn/completed {stopReason:"end_turn"}        │
  │◀─ event seq8 session/status idle                            │
```

An example on the wire (one JSON per line):

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s_01J9","content":[{"type":"text","text":"list the files in the current directory"}]}}
{"jsonrpc":"2.0","id":3,"result":{"messageId":"m_01JA"}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":2,"type":"turn/started","turn":1,"messageIds":["m_01JA"]}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":4,"type":"tool/started","turn":1,"callId":"t_01","name":"shell","input":{"command":"ls"}}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":5,"type":"tool/completed","callId":"t_01","status":"success","output":"a.txt\nb.md"}}
```

## Example 2 — Approval

```json
// The Runtime decides approval is needed (the tool call is already streamed for display; parameters correlate via callId, not duplicated — DSH evidence [01])
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":9,"type":"approval/requested",
 "approvalId":"ap_01","toolCallId":"t_02","toolName":"shell","reason":"command matches rm -rf pattern"}}
// The Shell replies (three closed-form decisions; amendedInput may be attached under the approvalEditInput capability)
{"jsonrpc":"2.0","id":7,"method":"approval/respond","params":{"sessionId":"s_01J9","approvalId":"ap_01","decision":"allow_once"}}
{"jsonrpc":"2.0","id":7,"result":{}}
// The finality event for the decision: exactly one per approval/requested (D9-I7). If the Shell disappears/times out/declines, the Runtime applies its own fallback,
// and must still close out this way (decision:"cancelled"/"expired") — Codex: no answer ⇒ Abort [03]; DSH fail-closed [01]
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":10,"type":"approval/resolved","approvalId":"ap_01","decision":"allow_once"}}
// The tool then settles normally
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":11,"type":"tool/completed","callId":"t_02","status":"error","output":"permission denied"}}
```

## Example 3 — Streaming (reconnect = replay)

```json
// Normal stream: delta sequence + settlement
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":12,"type":"message/delta","turn":1,"text":"The directory has "}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":13,"type":"message/delta","turn":1,"text":"a.txt and b.md"}}
// The Shell crashes and reconnects: resume from seq 12 — the server replays the missing events (ZCode watermark [02] / ACP load [06] semantics)
{"jsonrpc":"2.0","id":9,"method":"session/resume","params":{"sessionId":"s_01J9","since":12}}
{"jsonrpc":"2.0","id":9,"result":{"sessionId":"s_01J9","replayedFrom":12,"nextSeq":14,"events":[
  {"seq":12,"type":"message/delta","turn":1,"text":"The directory has "},
  {"seq":13,"type":"message/delta","turn":1,"text":"a.txt and b.md"}]}}
// Note: if since falls outside the retention window, the server does not error; it returns snapshot + events from the retention baseline, marked by replayedFrom (D4)
```

## Example 4 — Two very different Runtime implementations of ARI

**(a) DSH → ARI (an adapter ≈ changing the envelope)**: DSH already has all the semantics; the mapping is nearly one-to-one:

| ARI 1.0 | Existing DSH mechanism [01] |
|---|---|
| initialize/capabilities | DSH SDK `initialize` (adding version negotiation — its known limitation) |
| session/new / resume / prompt (receipt) | `agents.create/resume`; SDK `session/prompt`→`messageId` |
| the `event` channel | `session.event` (forwarding the full SessionEvent) + `session.status` |
| message/delta | `agent/assistant-stream` chunks (remote consumers already exist) |
| tool/started|completed | `tool/call` / `tool/result` (meta passed through verbatim) |
| approval/requested ↔ respond | `approval/request` waterfall ↔ remotes/ACP answerer |
| question ↔ respond | `user-questions/request` waterfall |
| compaction/performed | `compaction/*` event folding |
| turn/completed stopReason | `turn/end.reason` (TurnEndReason) |

Unchanged: the compaction algorithm, ptc-runtime, the tool pipeline, the storage format — **all stay inside the Runtime**.

**(b) SimpleAgent → ARI (a conformant Runtime in ≈200 lines)**: no ledger, no compaction, no subagents:
```jsonc
// The initialize response declares truthfully
{"agentCapabilities":{"reasoning":false,"question":false,"approvalEditInput":false,
                      "usage":false,"compactionEvents":false,"replay":false,
                      "fileChanges":false,"subagents":false,"backgroundTasks":false}}
// On receiving session/prompt → return the messageId receipt, then just emit seq events:
// session/status running → turn/started{turn, messageIds:[that messageId]} → (call the LLM/tools yourself, emitting message/delta and tool/*)
// → turn/completed → session/status idle
// If an error occurs midway: session/error first, then turn/completed{stopReason:"error"} (D9-I3); likewise for cancel.
// Emit no events at all for capabilities you lack — the protocol is tailored neither to DSH nor to SimpleAgent.
```
The two implementations share the same schema and the same acceptance criteria: **event seqs start at 1 and are continuous with no gaps**; the prompt receipt precedes that turn's events and is correlatable via `turn/started.messageIds`; **each `turn/started` gets exactly one `turn/completed` (the error/cancel paths included, D9-I1/I3)**; each `approval/requested` gets exactly one `approval/resolved`; after `session/resume` the seqs have no gaps and no duplicates; error codes are returned per D9.2.

---

# Appendix: Evidence and Limitations

- Local source code: DSH (v0.1.7-alpha.1 @ c36a83ff6b), codex (openai/codex @ 44b857c00e), opencode (anomalyco/opencode @ v1.18.32), ZCode (zai-org/ZCode @ "feat: open source"), pi-mono and agent-client-protocol (shallow clones @ survey date); Gemini CLI and claude-agent-sdk were obtained via clone/npm by the sub-surveys.
- **Limitations (recorded faithfully)**: ① the Claude Code CLI is closed-source; no binary audit was performed — the protocol surface was taken from the npm `sdk.d.ts` + bundle inspection (noted in [08]); ② ZCode Protocol V4 describes itself as "not frozen"; ③ opencode's origin is anomalyco/opencode (the current repo of the historical sst/opencode); ④ the local ACP clone is the restructured repo (schema crate + docs); the TS/Rust SDKs live in separate repos (corroborated via raw fetch); ⑤ pi-mono's package layout differs from older material (no packages/pi, see [05]); ⑥ DSH's docs/ are generated, verified in-repo documentation, noted as such when cited.
- During the survey, 5 subagents exhausted their context or were interrupted; all were completed with the retry strategy of "incremental writes to disk + narrowed scope"; all reports were written to disk under `research/`.

## Final principles self-check (items 1–10 of the original task list)

1. Not tailored to DSH — counterexample in Example 4(b); 2. not tailored to ZCode — same; 3. no copying ACP — client-tool inversion, turn=response lifetime, and the dual-track modes are all explicitly rejected (D7); 4. no copying MCP — tools stay out of the protocol (D7); 5. no prescribing Harness internals — C4; 6. no prescribing the Model Provider — initialize has no provider field; 7. no prescribing the UI — events are semantics, not rendering (meta is opaque); 8. no prescribing specific Tools — B13; 9. no designing ahead for future features — subagent/background/fork/PTY are all moved out and extension points are given (SPEC §12); 10. implementability — the D8 self-check: 10 methods + 21 events, and SimpleAgent can conform in 200 lines.
