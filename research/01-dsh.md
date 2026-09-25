# 01 · DeepSeek Harness (DSH) source-level survey

> Survey subject: the `deepseek-harness` monorepo (github.com/deepseek-ai/deepseek-harness), local checkout v0.1.7-alpha.1 (commit c36a83ff6b).
> Evidence markers: [source] = verified directly against source/generated directories; [docs] = in-repo docs/ (generated documentation kept in sync with the source, high confidence); line numbers are positions at reading time, for later lookup.

## 0. Overall architecture

- **Everything is a plugin**: DSH is built on [Cordis](https://github.com/cordiverse/cordis); plugins contribute services, typed events, and reversible effects to a shared Context; model adapters, the tool registry, the session log, and the agent loop itself are all plugins (docs/architecture.md:9-13).
- **Profiles/Bundles**: the runtime is composed from ordered layers: `web`, `headless`, `sdk`, `sdk-minimal`, `acp` are the factory profiles (architecture.md:19). `dsh-base` is the shared base (model adaptation, tools, persistence, sandbox and approval policies, settings, credentials, telemetry); `dsh-sdk-app` adds the **SDK JSON-RPC server**; `dsh-acp-app` adds the **automation-only ACP server** (architecture.md:25).
- Core packages and ctx keys (architecture.md:61-70): `core/session`→`ctx.sessions` (append-only `SessionEvent` log), `core/system-prompt`→`ctx.systemPrompt`, `core/tools`→`ctx.tools` (scoped tool registry + guarded execution pipeline), `core/agent`→`ctx.agents` (Agent interface + active registry + `agent/*` events), `core/agent-loop`→`ctx.agentLoop`, `llm/llm`→`ctx.llm` (message/stream vocabulary + adapter seam).
- **Three event domains** (architecture.md:74-78): (1) Session events = durable facts appended to the log, broadcast via `session/event`; (2) Agent events (`agent/*`) = live in-process extension points (inbox, step, status, request, validation, continuation); (3) Capability events (`fs/*`, `tools/*`, `telemetry/*`) = attach policies/adapters to a seam. Waterfall-type events require the listener to call `next()` to delegate (architecture.md:109).

## 1. Session

- **Creation**: `ctx.agents.create()` establishes session + agent in one call (the caller provides `SessionId`); `ctx.agents.resume()` first loads the persisted session (docs/subsystems/core.md:24). `AgentHandle` is exposed only to its creator (owner-only disposer, core.md:29-47). Creation options include `parentAgent`, meta (cwd, fork lineage, delegation depth, agentPreset), `seed` (the fork replay prefix), and per-agent `AgentOptions` (provider/model/reasoningEffort/maxTokens) (core.md:49-51).
- **Persistence**: the session log is the source of truth; the JSONL provider handles physical framing, compression (`session.jsonl[.zstd]` / `session.vN.jsonl[.zstd]`), generation selection and exclusive publication; committed generation paths are never renamed/replaced/deleted; adjacent migrations do only one `vN → vN+1` step at a time (architecture.md:123). The checkpoint policy belongs to `dsh-session-checkpoint-policy` (session.md:38-41).
- **Resume / crash recovery**: `resume()` + header-only `stat`/`list` re-scan the directory to select the highest generation; historical versions go through the explicit migration chain (architecture.md:123); repairing an unsealed tail is the consumer's responsibility (architecture.md:123).
- **Fork**: `ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })`, forking only at turn boundaries; `inheritedEventCount` records the exact split point; `session/end-seed { inherited?: true }` marks the inherited-prefix boundary (session.md:149-173; architecture.md:160).
- **Multi-client**: multiple plugins in one process share the same session; remote multi-client goes through the web `session-controller` + `session/event` broadcast (see §13). On the SDK side the `session.event` notification is "every session in the runtime, unfiltered" (packages/sdk/protocol/README.md:43).
- **Interrupt/Cancel**: `Agent.cancel(cause, { keepInbox })` clears the queue and aborts the active turn; a no-op when nothing is active (core.md:82-84). `TurnEndReason` is recorded in `turn/end` (session.md:43).
- **Webhook entry**: external systems can fire-and-forget-create an ordinary root Session (`WebhookSessionRequest`: workspacePath/title/prompt/agent preset/permission preset/model); the follow-up is a user message with `source.kind: "webhook"` (docs/subsystems/webhook.md:17-29).

## 2. Message model (`SessionEventMap`)

Source: docs/subsystems/session.md:27-174 (types verified for equivalence against packages/core/session/src/types.ts). **Persistent event vocabulary**:

| Event | Payload essentials |
|---|---|
| `turn/start` / `turn/end` | `{ turn }` / `{ turn, reason: TurnEndReason }` |
| `step/start` / `step/end` | `{ turn, step }` — a step = one model call + its tool executions |
| `user/message` | `UserMessage`; `source` distinguishes human prompt / `agent.inject()` injection / goal continuation round (session.md:48-55) |
| `developer/message` | **incremental agent session changes** (turn/step locators) + references `request/header` (session.md:56-63) |
| `system/message` | the rendered system prompt, appended as surface node 0; an empty render clears all active system nodes (session.md:64-76) |
| `assistant/message` | the assembled assistant message + the **embedded complete timed raw stream** `AssistantStreamRecord[]` + `usage?` + `interrupted?` (session.md:87-95) |
| `assistant/attempt` | a model attempt with no surface message (failure/retry/cancel/stream error), log-only (session.md:100-101) |
| `tool/call` | `{ turn, step, callId, name, arguments }` — arguments is the **raw unresolved JSON string** produced by the model (session.md:107) |
| `tool/result` | `ToolResultMessage` + `error?{name,code,reason}` (model-invisible) + `meta?` (tool-private presentation payload, e.g. the at-result diff from dsh-tool-fs) (session.md:121-131) |
| `request/header` | the full header of the next request (tool set etc.), log-only (session.md:136-141) |
| `request/context` | routing metadata (recorded when route/capacity/system-prompt update mode changes) (session.md:147-148) |
| `session/end-seed` | fork boundary marker (session.md:173) |

Plugin-merged extensions (declaration merging): `compaction/start|summary|end` (log-only), `hook/invoked|result` (log-only), `image/offload`, `approval/asked|decided` (log-only audit), `todo/write`, `goal/change`, `schedule/change`, `team/*`, `deliverables/presented`, `tool/ptc-dispatch(-start)` (persistence-catalog.md:1078,1101), `workflow/*`.

**LLM vocabulary** (docs/subsystems/llm-streaming.md:24-35): `ContentBlockMap = text | reasoning | image | file | tool-call | tool-addition | tool-removal`; `ToolResultMessage` is a first-class message (toolCallId + content + isError). `MessageSourceMap` (llm-streaming.md:86-91): `user | model | tool | system-prompt` (merge-extensible; a producer declares its own kind).

**Model-API messages vs harness events**: DSH's separation is very clean — whatever is model-visible must be reconstructible from the log (the "Model-visible means logged" runtime invariant, architecture.md:125); only the `SurfaceEventType` subset (carrying `surfaceOp`) participates in the surface projection; the rest is log-only. The harness's own events (approval, compaction, hooks, goal, todo, ...) do not enter model history unless they become a `user/message` via `agent.inject()`.

## 3. Agent Loop (turn flow)

docs/architecture.md:88-113 gives the authoritative control flow:

```
turn/start
  claim next-step input + one queued message
  assemble prompt sections + tool schemas; project runtime context
  → agent/pre-step (waterfall)          # decides which inputs to accept; may rewrite/reject
     step/start
     agent/request → prepareCall        # resolves provider/model routing; on cancel, commit nothing
     reconcile system/message; append user/message; record request/header|context
     derive + freeze model history from the log
     streaming call → llm/stream (waterfall) → agent/assistant-stream start
       chunk* → assistant/message | assistant/attempt → end
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
     outstanding tools for the next request, or new next-step input → claim → next step
  → agent/turn-stopping (serial)
turn/end
```

- **Model call**: via the `llm/stream` waterfall on `ctx.llm` (llm-deepseek / llm-pi-ai adapters); retries are attached by `llm-retry` on `agent/request-error` (event-producer-consumer.md:21).
- **Parallel tools**: `ToolDefinition.isConcurrencySafe(args)` is explicit opt-in; the concurrency contract is in the .agents note 2026-07-10 (tools.md:61-74).
- **Interrupt**: `agent.cancel(cause)`; cancelling mid-stream fixes the already-delivered text/reasoning prefix into `assistant/message { interrupted: true }`; undelivered tool calls do not exist (session.md:82-85).
- **Timeout**: per-tool `timeoutMs` is enforced by `dsh-tool-call-timeout-policy` (the tools/execute wrapper) and is never sent to the model (tools.md:54-59).
- **Loop detection**: `repeat-tool-reminder` (packages/guard) hooks `tools/post-execute` (event-producer-consumer.md:73).
- **Budget/iteration**: no explicit max-iteration cap seen [not found in docs]; token pressure goes to compaction (see §9).
- **Steering/Followup/Inject**: `Agent.send(message, target, wakeup)`, `followup()` (exclusively claims the next turn), `steer()` (consumed at the nearest step boundary), `inject()` (injected at the next pre-step, does not wake) (core.md:114-140). The Inbox is two ordered queues, `nextTurn` + `nextStep`, as a durable projection (core.md:213-247).
- **AgentStatus**: only `idle | running`; dispose is not a third state (core.md:152).

## 4. Tool Runtime

- **Unified abstraction** `ToolDefinition` (tools.md:26-93): `ToolSchema` (name/description/parameters, model-visible) + `output: ToolOutputDefinition` (canonical JSON schema + `render(args,value)→ContentBlock[]` + `presentationMeta?`) + `execute(args, exec: ToolRunContext)` + `finalizeContent?` + `timeoutMs?` + `isConcurrencySafe?` + `presentCall?(args)→ToolCallView` + `presentResult?(args,result)→ToolResultView`. `schemas()` uses an explicit allowlist to keep execution fields from leaking to the model (tools.md:11).
- **Execution pipeline**: `tools/pre-execute → tools/execute → tools/post-execute` (waterfall) + `tools/result` (emit). Mounted by: timeout-policy, session-checkpoint-policy, auto-review, hooks-claude-code/codex, tool-jobs, workspace-changes, repeat-tool-reminder, spill-policy, tool-fs-search, browser-use, computer-use (event-producer-consumer.md:72-76).
- **Result representation**: canonical JSON value + model content produced by render + optional `meta` (a UI presentation payload; must be JSON-serializable, validated at runtime by Session.append) (session.md:109-131).
- **Cancellation**: `exec.signal` (AbortSignal) is forwarded cooperatively; the registry preserves caller cancellation via around-dispatch signal replacement (tools.md:32-38).
- **Streaming return**: tools themselves do not stream (the result is a single canonical value once settled); live incremental display belongs to the assistant stream. bash output goes through job observation (§8).
- **Built-in tools** (docs/tool-catalog.md:16-47, generated catalog): `bash`, `pwsh`, bash/pwsh-persistent (PTY), `read`, `read_image`, `write`, `edit`, `str_replace_editor`, `glob`, `grep`, `web_search`, `web_fetch`, `terminal_open/read/send/signal/list/close`, `job_list/output/kill`, `subagent` (+`subagent_fork` alias), `list_subagent_models`, `send_message`, `interrupt_agent`, `list_agents`, `ask_user_question`, `exit_plan_mode`, `todo_write`, `skill`, `create_goal/get_goal/update_goal`, `schedule_create/delete/list`, `workflow`, `ralph`, `run_code` (PTC), `lsp`, `present`, `plugin_manager`, `session_search/trace` and 5 others, 3 MCP resources, 6 stagehand_* (browser), `load_workspace_dependencies`, `cordis_inspect_*`.
- **MCP**: the `mcp-client` package + MCP resource tools; tools are added/removed dynamically via `tools/change` (`tool-addition/tool-removal` blocks are recorded into developer/message).
- **What the shell must see**: tool/call (name + raw args + callId), tool/result (model content + meta + error overview), the pending/completed pair of views (presentCall/presentResult are pure functions, replayable). The execution world (sandbox details, subprocesses, timeout policies) stays in the runtime.

## 5. Human-in-the-loop

- **Approval seam** (docs/subsystems/approval.md): `ctx.approval`; `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` (**closed, fail-closed**, no allow-always); per-session `ApprovalPolicy = 'ask' | 'never'` (the last approval/policy entry in the session log wins; `never` is intercepted inside the service and cannot be bypassed by the answerer) (approval.md:21-47,86).
- **Request shape**: `ApprovalRequest { agent, toolName, callId?, reason?, signal? }` — **deliberately excludes tool arguments**: the UI pins the prompt onto the already-streamed tool call via `callId` (approval.md:53-81). `signal` abort → `cancelled`.
- **Dispatch and audit**: `ctx.approval.request(req)` appends `approval/asked` → waterfall (`approval/request`) where the first answer decides → `approval/decided`; the audit is log-only and does not enter model history (approval.md:86-88). `request` requires the session to be inside an open turn (approval.md:119-120).
- **Answerer**: UI channels can register human answerers; **the ACP automation bridge provides one-shot machine decisions**; on the web side, `remotes` listens to `approval/request` (event-producer-consumer.md:30).
- **User question seam** (docs/subsystems/user-questions.md): the `ask_user_question` tool → `AskUserQuestionRequest { questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }] }`; an intent such as `{ kind: 'plan-review', approve: '<label>', callId? }` only changes presentation, not the protocol (user-questions.md:35-47); answers are filled back in by id. **`remotes` forwards the waterfall to connected Web clients to answer** (user-questions.md:5; event-producer-consumer.md:77).
- **Parameter modification**: the approval protocol itself does not support modifying parameters (closed outcomes); "modification" works by rejecting and letting the model re-send [inferred from the closed enum].
- **Permission presets**: `permission-presets` (catalog-changed event → remotes) + the `ctx.sandbox` backend (SandboxMode) provide rule-based control; the `plugin_manager` tool requires danger-full-access or an approval for this instance (tool-catalog.md:55).
- **How a client knows it should wait**: the `approval/request`, `user-questions/request` waterfall events (forwarded remotely via remotes) + `agent/status`.

## 6. File / Diff

- **fs event domain**: `fs/observed` (reads/existence/post-change), `fs/write-intent`, `fs/edit-intent` (pre-change waterfall; can be intercepted by `fs-observation-policy` to implement read-before-write policies) (event-producer-consumer.md:45-47).
- **Structured diff**: `tool/result.meta` carries the tool-private presentation payload; dsh-tool-fs puts its at-result contextual diff there (session.md:117-119).
- **Workspace changes feed**: the `workspace-files` controller provides an "instrumented-operation `changes` feed" + stat/read/list (packages/api/README.md:36); `deliverables/workspace-changes` tracks changes on `tools/pre-execute`, `agent/turn-stopping`, `session/disposed` (event-producer-consumer.md:23,74,60).
- **Presentation**: the `present` tool + the `deliverables/presented` event push files to the Web UI as deliverables (tool-catalog.md:25).
- Assessment: DSH belongs to the "**structured events + clients read files on demand**" hybrid school: the runtime emits structured facts at the fs seam and the deliverables layer, while the Web client additionally has a workspace-files read channel and does not depend on watching the filesystem itself.

## 7. Command / Terminal

- **One-shot shell**: the `bash`/`pwsh` tools go through the `ctx.shell` seam (local implementation via `ctx.subprocess`); `run_in_background` registers with `ctx.jobs` (tool-catalog.md:24-26).
- **Persistent terminals**: the `ctx.terminals` seam + the six `terminal_*` tools (open/read/send/signal/list/close, PTY state); `terminal_send(run_in_background)` also enters jobs (tool-catalog.md:28-33).
- **Unified background model**: `ctx.jobs` is kind-agnostic — background bash, PTY send, and subagents all register as jobs; the three tools `job_list/job_output/job_kill` consume them uniformly; background completion notifications become user messages via `agent.inject()` (tool-catalog.md:42).
- **Browser terminal**: `terminal-controller` owns "Session-owned interactive shells, screen recovery and browser terminal control" (packages/api/README.md:35); job-controller streams a job's observation records to the client (README.md:31).
- Visible to the shell (UI): command lifecycle, output stream (via job observation/terminal reads), exit, kill; process-world details (argv wrapping, the sandbox backend) stay in the runtime.

## 8. Context Management

- **Assembly**: the system prompt goes through the `system-prompt/assemble` waterfall; tool schemas are merged in; context injected via `agent.inject()` lands as a `user/message` at the next pre-step.
- **Compaction seam** (docs/subsystems/compaction.md): the `ctx.compaction` interface + the `compaction-basic` backend + the `command-compact` manual command. Three log-only events: `compaction/start {turn|null}`, `compaction/summary {summary, rawOutput?, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, usage?...}`, `compaction/end {turn, error?}`; the summary is persisted as a **single surface change**: a new `user/message` + `surfaceOp: { op:'replace', startSeq, endSeq }` (compaction.md:11-21).
- **Triggers**: `CompactionTrigger = 'pressure' | 'context-overflow'`; pressure runs at `agent/pre-step`; overflow recovers after a failed request via `agent/request-error` (compaction.md:81,101). An optional `ctx.toolResultPruner` prunes tool results first; `ctx.tokenMeter` does unified estimation (compaction.md:84,101).
- **Crash semantics**: the lock is released last → a mid-flight crash leaves a detectable orphan lock (`compaction/start` with no paired end) (compaction.md:19).
- **Raw output**: assistant/message embeds the complete timed raw stream; shadowed events are **not deleted**, they simply stop being projected onto the surface — immutable ledger semantics.
- **Spill**: `spill-policy` (tools/post-execute) writes over-cap tool output to `ctx.spillStore` and returns a locator (the grep tool's `sampleOverCapGlobResults` is this pattern, tool-catalog.md:32).
- **Assessment input**: compaction in DSH is a runtime-internal capability, but **partially visible** to the protocol: the persistent events record the summary and the replaced range, so a client can see from `session/event` that a compaction happened without needing to understand it.

## 9. PTC (Programmatic Tool Calling)

- **Execution seam**: `ctx.ptcRuntime` (dsh-ptc-runtime). `PtcRunRequest { program, bindings: PtcBindingNamespace[], cwd?, timeoutMs?, sandboxPolicy?, signal? }`; the program is an async function body with top-level await/return; `PtcRunResult { value?, stdout/stderr, sandbox?{mode,denied,enforcement}, error? }` — errors are fields, not exceptions (ptc-runtime.md:18-90).
- **Tool layer**: the `run_code` tool (the registry keeps the transport; injected under `mode: ptc | both`); programs call tools through bindings, **each bridged sub-call produces a pair of `tool/ptc-dispatch-start` + `tool/ptc-dispatch` events and re-enters the full guarded tool pipeline**, correlated with the outer result; concurrency follows the native contract (submission-ordered, concurrency-safe body up to `maxParallelSubCalls`) (tool-catalog.md:22).
- **Assessment input**: the intermediate steps **are** persistent events (the shell can see sub-call-level detail), but semantically PTC is a runtime capability — the shell only needs to render the ptc-dispatch events, without understanding the program.

## 10. Subagent

- **Providers**: `ctx.subagents` (providers are pluggable: in-process driver, dsh-sdk, the ACP bridge, a fresh child agent, or "delegated turn in another product", architecture.md:133); `subagent/start`, `subagent/end` events (event-producer-consumer.md:65-68).
- **Tool surface**: `subagent` (default name, alias `subagent_fork`, fixed routing) + `list_subagent_models`; control plane `send_message` / `interrupt_agent` / `list_agents` (tool-catalog.md:40-41). `subagent_fork` inherits the completed turns of the current session (fork semantics).
- **Parent-child relationship**: `parentAgent` + meta.delegation depth; the child is an independent Session (with its own event log); the `SDK subagent.finished` notification carries the child's last assistant message (sdk/protocol/README.md:46).
- **Parallelism + waiting**: background continuable children (unified via jobs); `wait_agent` (agent-team); events are forwarded upward via `ctx.subagents` (per the tool-subagent-control description).
- **Agent Teams (experimental)**: `ctx.agentTeams` durable roster/task board/mailbox; tools `spawn_teammate`, `team_task_*`, `wait_agent`, `interrupt_agent`, `list_agents`, `send_message`; events `team/member`, `team/message/queued|delivered`, `team/task` (architecture.md:135; tool-catalog.md:43).
- **Shell visibility**: subagent.started/finished (SDK), child session events forwarded via the provider, the `list_agents` projection. ARI exposes only two levels of events — "subagent exists" and "finished"; orchestration is not part of the protocol.

## 11. Streaming

- **In-process**: `agent/assistant-stream` (emit): start/chunk/end frames, `chunk = { attemptId, revision, index, time, chunk: StreamChunk }`; end carries `outcome: committed(assistant/message|attempt seq) | abandoned` (core.md:156-190). **The only remote consumer is the Web Session-follow adapter** (architecture.md:109).
- **Persistent**: the full stream is embedded in `assistant/message.stream` at settlement (lost on power failure, no partial attempt left behind, architecture.md:121).
- **Cross-process**: web clients go through Connection/`session-controller` history streams + live events; the SDK goes through `session.event` (full session events); the headless bundle is also a listener (event-producer-consumer.md:12,61).
- The model is exactly `request → event stream → completed`: holds. The completion signal = turn/end (durable) + agent/status idle.

## 12. Transport (DSH's own outward protocol surfaces)

DSH simultaneously exposes **four external protocol surfaces** (a highly valuable precedent for ARI):

1. **SDK JSON-RPC over stdio** (packages/sdk/protocol/README.md): newline-delimited JSON-RPC 2.0; only 3 methods: `initialize` (serverInfo/reasoningEffort/maxTokens), `session/prompt` (returns the durable enqueue receipt `messageId`), `shutdown`; 4 notifications: `session.event` (full session events), `session.status` (running/idle), `subagent.started`, `subagent.finished` (+`lastAssistantMessage`). Known limitations: **no protocol version negotiation, no cancel/session-close method (clients close the process instead), server→client request is a dead capability (the Python SDK reserves a responder surface for a future approval flow)** (README.md:113-115). The Python SDK mirrors the same protocol (it does not import it).
2. **ACP server (automation-only)** (packages/acp/README.md): lets programs create/list/resume/close sessions, attach MCP, choose a model, send text+image prompts, receive semantic updates, **answer permission prompts, cancel work**; subagent-acp is the reverse bridge (spawning this server from another harness).
3. **Web GUI protocol**: HTTP (SSE/fetch) (`ctx.webServer` + the shared `/api` channel); the `api/` Remote layer = typed Client→Host calls (remotes decide the exposed surface; the gateway carries unary calls, multiplexed streams + client uplink, and forwards Host events) + controllers: session (commands/history streams/activity control), terminal, workspace, workspace-files, job, settings/credentials (packages/api/README.md:27-38). Streaming session data is **deliberately not in the Remote layer** (README.md:12-38).
4. **Webhook**: HTTP ingress → fire-and-forget session creation (webhook.md).

## 13. Capability Matrix (DSH)

| Capability | DSH | Evidence |
|---|---|---|
| Session | ✓ | `ctx.sessions` append-only log; `agents.create/resume` (core.md:24) |
| Resume | ✓ | JSONL generations + migration chain + `resume()` (architecture.md:123) |
| Streaming | ✓ | `agent/assistant-stream` start/chunk/end; `session.event` notification (core.md:156) |
| Cancellation | ✓ | `Agent.cancel(cause)` + AbortSignal across the whole chain (core.md:82) |
| Approval | ✓ | `ctx.approval` + `approval/request` waterfall + ask/never policy (approval.md) |
| Tool events | ✓ | `tool/call`, `tool/result` (+meta) + `tools/*` pipeline events (session.md:107) |
| File changes | ✓ | `fs/observed`, `fs/*-intent`, the workspace-files changes feed, tool meta diff |
| Terminal | ✓ | `ctx.terminals` + terminal_* tools + terminal-controller (PTY) |
| Background task | ✓ | `ctx.jobs` unifies bash/PTY/subagent + job_* tools (tool-catalog.md:42) |
| Parallel tools | ✓ | `isConcurrencySafe` opt-in concurrency contract (tools.md:61-74) |
| Compaction | ✓ | compaction seam + 3 persistent events + surfaceOp replace (compaction.md) |
| Subagent | ✓ | `ctx.subagents` providers + subagent/fork/control tools + agent-team (experimental) |
| Usage | ✓ | `assistant/message.usage`, `ctx.tokenMeter`, compaction/summary.usage |
| Reasoning events | ✓ | `ReasoningBlock`, in-stream reasoning chunks, the persistent embedded stream |
| PTC | ✓ | `ctx.ptcRuntime` + `run_code` + `tool/ptc-dispatch*` events (ptc-runtime.md; tool-catalog.md:22) |

## 14. What the shell must see vs runtime internals (judgment under DSH evidence)

**What the shell must see (protocol surface)**:
1. Session lifecycle: created/resumed/disposed, `agent/status` (idle/running).
2. The persistent narrative stream: turn/step boundaries, user/message (with source), the assistant stream (incremental + settlement), tool/call + tool/result.
3. The two kinds of human-waiting requests: approval (can carry a callId) and open-ended questions (options/multi-select/intent).
4. Background task existence + observation stream + kill.
5. Deliverable/file presentation events (present, the changes feed).
6. Subagent started/finished (+ optional child-session event forwarding).
7. Usage (token metering travels with messages).

**Runtime internals (the shell should not need to understand)**:
- How context is derived from the log, prompt assembly order, request/header and routing, cache-friendly system node rules.
- Compaction's summary algorithm, thresholds, shadowed-seq bookkeeping (the shell only needs the fact that "the surface was replaced").
- The tool execution world: sandbox backends, argv wrapping, subprocesses, timeout policies, read-before-write policy plugins.
- How PTC programs execute (the shell only renders ptc-dispatch events).
- Hook bridges (Claude Code/Codex hooks), permission preset implementation.
- Session file format, generations, migration.

**Distinctive insight (for ARI)**: DSH proves that an "**immutable ledger + derived projections**" model can serve all three parties at once — the model (deriveMessages), the UI (projection snapshot), and the protocol (session.event forwarding); and that approval and question are two different seams (one closed-form adjudication, one open-ended answering).
