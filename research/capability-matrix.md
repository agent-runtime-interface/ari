# Capability Matrix (ARI Preliminary Research)

> All evidence points to the survey reports under `research/`; ✓ = implemented with a protocol surface; ◐ = partial/restricted/experimental; ✗ = none.
> Numbers [01]–[08] correspond to the reports under research/: 01-dsh, 02-zcode, 03-codex-cli, 04-opencode, 05-pi, 06-acp, 07-codex-app-server, 08-related.

## Main Matrix (Seven Subjects)

| Capability | DSH | ZCode | Codex CLI | OpenCode | Pi | ACP | Codex App Server |
|---|---|---|---|---|---|---|---|
| Session | ✓ ctx.sessions append-only log [01] | ✓ SQLite + event-source [02] | ✓ rollout JSONL (uuid7) [03] | ✓ SQLite/drizzle + EventV2 [04] | ✓ JSONL tree [05] | ✓ session/new [06] | ✓ thread/start [07] |
| Resume | ✓ resume() + generation migration [01] | ✓ watermark/snapshot recovery [02] | ✓ codex resume/--last [03] | ✓ session resume + V2 durable input table [04] | ✓ --continue/--resume [05] | ✓ load(replay)+resume [06] | ✓ thread/resume [07] |
| Streaming | ✓ assistant-stream frames [01] | ✓ delta + 30ms profile [02] | ✓ ContentDelta events [03] | ✓ SSE + message.part.delta [04] | ✓ delta events [05] | ✓ agent_message_chunk and other updates [06] | ✓ item/*Delta [07] |
| Cancellation | ✓ cancel(cause)+AbortSignal [01] | ✓ stop command [02] | ✓ Op::Interrupt→TurnAborted [03] | ✓ fiber cancel→AbortedError [04] | ✓ Abort+RPC abort [05] | ✓ session/cancel [06] | ✓ turn/interrupt [07] |
| Approval | ✓ approval seam (ask/never) [01] | ✓ pendingInteractions [02] | ✓ ExecApprovalRequest/Response [03] | ✓ permission.asked + once/always/reject(+feedback text) [04] | ◐ extension hook+UI [05] | ✓ request_permission [06] | ✓ item/*/requestApproval [07] |
| Tool events | ✓ tool/call+result+meta [01] | ✓ toolCallRow state machine [02] | ✓ Begin/End/OutputDelta [03] | ✓ tool part: pending→running→completed/error [04] | ✓ start/update/end [05] | ✓ tool_call(+update) [06] | ✓ item/started/completed [07] |
| File changes | ✓ fs events+changes feed+meta diff [01] | ◐ FileDiff (no hunk level) [02] | ✓ PatchApplyBegin/End+TurnDiff [03] | ✓ file.edited+watcher+patch part [04] | ◐ diff in details [05] | ◐ v1 text diff; v2 structured [06] | ✓ FileUpdateChange [07] |
| Terminal | ✓ PTY + terminal_* + controller [01] | ◐ no PTY [02] | ✓ unified_exec PTY+background [03] | ✓ shell tool + first-class PTY (/api/pty + pty.* events) [04] | ✓ bash stream+truncation [05] | ✓ terminal/* (v1 client execution) [06] | ✓ command/exec+process/* [07] |
| Background task | ✓ ctx.jobs unified [01] | ✓ backgroundWorks [02] | ✓ Op::RunUserShellCommand{timeout_ms}+background PTY survives interrupt [03] | ◐ experimental (background subagent) [04] | ◐ detached subprocess [05] | ✗ (v2 draft) [06] | ◐ thread/queue/* [07] |
| Parallel tools | ✓ isConcurrencySafe opt-in [01] | ✓ scheduler maxConcurrency 10 [02] | ✓ FuturesOrdered [03] | ✓ ai-sdk toolcalls map by callID [04] | ✓ parallel by default [05] | ◐ concurrent JSON-RPC [06] | ◐ [07] |
| Compaction | ✓ compaction seam+events [01] | ✓ two-tier auto+micro [02] | ✓ pre-sampling auto+Op::Compact [03] | ✓ auto overflow+manual+session.compacted event [04] | ✓ 3 triggers+checkpoint [05] | ◐ unstable/RFD [06] | ◐ thread/compact (not parameterizable) [07] |
| Subagent | ✓ providers+fork+team(experimental) [01] | ✓ childSessionId+mirroring [02] | ✓ native spawn_agent/wait_agent [03] | ✓ task→real child session (client subscribes itself, not forwarded) [04] | ✗ multi-process example extension [05] | ✗ [06] | ◐ event surface only [07] |
| Usage | ✓ usage alongside messages+tokenMeter [01] | ✓ usage state [02] | ✓ TokenCount+rate_limits [03] | ✓ [04] | ✓ cost/cache/reasoning [05] | ◐ session-level usage_update [06] | ✓ tokenUsage/updated [07] |
| Reasoning events | ✓ ReasoningBlock+stream [01] | ✓ reasoningRow [02] | ✓ ReasoningContentDelta+encrypted [03] | ✓ reasoning part [04] | ✓ thinking deltas+redacted [05] | ✓ agent_thought_chunk [06] | ✓ item/reasoning/* [07] |
| PTC | ✓ ptcRuntime+run_code+dispatch events [01] | ◐ NodeRepl+DynamicWorkflow [02] | ✓ Code Mode (V8) [03] | ◐ experimental code-mode (MCP-only) [04] | ✗ [05] | ✗ [06] | ◐ dynamic tools+code_mode_host [07] |

## Secondary Subjects (Claude Code / Gemini CLI)

Evidence: research/08-related.md. Claude Code = closed-source CLI + the `sdk.d.ts` (9451 lines) of npm `@anthropic-ai/claude-agent-sdk` + bundle inspection; Gemini CLI = open source (google-gemini/gemini-cli).

| Capability | Claude Code (SDK/CLI) | Gemini CLI |
|---|---|---|
| Session | ✓ init+session_id [08] | ✓ InitEvent.session_id [08] |
| Resume | ✓ resume/continue/SessionStore [08] | ✓ --resume/--session-id/resumeSession [08] |
| Fork | ✓ forkSession [08] | ✗ [08] |
| Streaming | ✓ stream_event wraps raw API delta [08] | ✓ stream-json + ACP chunk [08] |
| Cancellation | ✓ interrupt+receipt(interrupt_receipt_v1)+control_cancel [08] | ◐ AbortSignal/UserCancelled [08] |
| Approval | ✓ can_use_tool → allow{updatedInput!}/deny{interrupt} [08] | ✓ 7-outcome ToolConfirmationOutcome + requestPermission [08] |
| Tool events | ✓ tool_use/result+tool_progress+tool_use_result [08] | ✓ tool_use/tool_result+scheduler state machine [08] |
| File changes | ◐ structured tool_use_result+rewind_files, no FS events [08] | ◐ edit diff/diffStat+toolCall.locations [08] |
| Terminal | ✓ Bash tool [08] | ✓ node-pty structured ShellOutputEvent [08] |
| Background task | ✓ task_* event family+stop_task [08] | ◐ is_background+PID, no notification family [08] |
| Parallel tools | ✓ per-toolUseID+PostToolBatch [08] | ✓ concurrent scheduling [08] |
| Compaction | ✓ compact_boundary{trigger,pre/post_tokens} [08] | ✓ ChatCompressed+6 states [08] |
| Subagent | ✓ parent_tool_use_id+supportedAgents [08] | ◐ agents/+A2A(experimental) [08] |
| Usage | ✓ usage/modelUsage+get_usage [08] | ✓ ResultEvent.stats [08] |
| Reasoning events | ◐ thinking tokens+thinking_display [08] | ✓ Thought events [08] |
| PTC | ✗ [08] | ✗ [08] |

Additional key evidence: Claude Code's control protocol multiplexes `control_request/response/cancel_request` over the same JSON-Lines channel (37 subtypes, sender-chosen request_id); the `initialize` response carries `pending_permission_requests` (mid-join replay of pending approvals) and `capabilities[]` string capability negotiation. Gemini CLI has a confirmed ACP adapter (packages/cli/src/acp/, ndJSON JSON-RPC over stdio).

## Cross-Runtime Observation Notes (Material for Final Report Parts B/C)

- **Session persistence**: all core runtimes choose append-only JSONL (DSH/Pi/Codex) or equivalent event sourcing (ZCode: SQLite+events; OpenCode: SQLite+EventV2). "Session = immutable event ledger" is the strongest commonality.
- **Client-visible layer**: ZCode explicitly only projects (ConversationRow); DSH forwards session/event in full; Codex uses EventMsg/notifications; ACP uses session/update; OpenCode uses SSE events. Commonality = **projected event stream**, not pass-through of model messages.
- **Approval**: closed decision enums + session-scoped memory (ApprovedForSession / allowAlways / AcceptForSession) are nearly identical; Claude Code (updatedInput) and ZCode (modifiedInput) support argument rewriting; OpenCode achieves a similar effect with "reject+feedback text".
- **Compaction**: 6/7 have their own implementations and emit persistent events (ACP places it in unstable/RFD) — "compaction is runtime-internal behavior but produces visible events" is the consensus.
- **Subagent**: Codex CLI (native), DSH (pluggable providers), ZCode (independent session+mirroring), and OpenCode (real child session) are the strongest; Pi/ACP explicitly do not.
- **PTC**: Codex (Code Mode) and DSH (ptc-runtime) native; ZCode half (REPL+workflow); OpenCode experimental (MCP-only); Pi/ACP/Claude/Gemini none.
- **Completion semantics**: the "acceptance receipt" returned by submit is generally decoupled from "turn completion" (DSH messageId receipt, Pi agent_settled, OpenCode session.idle, ACP v2 state_update, Claude result, Gemini Finished).
