# Capability Matrix（ARI 前期调研）

> 证据均指向 `research/` 内各调查报告；✓ = 有实现与协议面；◐ = 部分/受限/实验；✗ = 无。
> 编号 [01]–[08] 对应 research/ 下各报告：01-dsh、02-zcode、03-codex-cli、04-opencode、05-pi、06-acp、07-codex-app-server、08-related。

## 主矩阵（七对象）

| Capability | DSH | ZCode | Codex CLI | OpenCode | Pi | ACP | Codex App Server |
|---|---|---|---|---|---|---|---|
| Session | ✓ ctx.sessions append-only log [01] | ✓ SQLite + event-source [02] | ✓ rollout JSONL (uuid7) [03] | ✓ SQLite/drizzle + EventV2 [04] | ✓ JSONL tree [05] | ✓ session/new [06] | ✓ thread/start [07] |
| Resume | ✓ resume() + generation 迁移 [01] | ✓ 水印/快照恢复 [02] | ✓ codex resume/--last [03] | ✓ session resume + V2 durable input 表 [04] | ✓ --continue/--resume [05] | ✓ load(replay)+resume [06] | ✓ thread/resume [07] |
| Streaming | ✓ assistant-stream 帧 [01] | ✓ delta + 30ms profile [02] | ✓ ContentDelta 事件 [03] | ✓ SSE + message.part.delta [04] | ✓ delta events [05] | ✓ agent_message_chunk 等 updates [06] | ✓ item/*Delta [07] |
| Cancellation | ✓ cancel(cause)+AbortSignal [01] | ✓ stop 命令 [02] | ✓ Op::Interrupt→TurnAborted [03] | ✓ fiber cancel→AbortedError [04] | ✓ Abort+RPC abort [05] | ✓ session/cancel [06] | ✓ turn/interrupt [07] |
| Approval | ✓ approval seam (ask/never) [01] | ✓ pendingInteractions [02] | ✓ ExecApprovalRequest/Response [03] | ✓ permission.asked + once/always/reject(+反馈文本) [04] | ◐ 扩展 hook+UI [05] | ✓ request_permission [06] | ✓ item/*/requestApproval [07] |
| Tool events | ✓ tool/call+result+meta [01] | ✓ toolCallRow 状态机 [02] | ✓ Begin/End/OutputDelta [03] | ✓ tool part: pending→running→completed/error [04] | ✓ start/update/end [05] | ✓ tool_call(+update) [06] | ✓ item/started/completed [07] |
| File changes | ✓ fs 事件+changes feed+meta diff [01] | ◐ FileDiff（无 hunk 级）[02] | ✓ PatchApplyBegin/End+TurnDiff [03] | ✓ file.edited+watcher+patch part [04] | ◐ diff in details [05] | ◐ v1 文本 diff；v2 结构化 [06] | ✓ FileUpdateChange [07] |
| Terminal | ✓ PTY + terminal_* + controller [01] | ◐ 无 PTY [02] | ✓ unified_exec PTY+后台 [03] | ✓ shell 工具 + PTY 一等 (/api/pty + pty.* 事件) [04] | ✓ bash 流+截断 [05] | ✓ terminal/* (v1 client 执行) [06] | ✓ command/exec+process/* [07] |
| Background task | ✓ ctx.jobs 统一 [01] | ✓ backgroundWorks [02] | ✓ Op::RunUserShellCommand{timeout_ms}+后台 PTY 存活于 interrupt [03] | ◐ 实验性（后台 subagent）[04] | ◐ 分离子进程 [05] | ✗ (v2 draft) [06] | ◐ thread/queue/* [07] |
| Parallel tools | ✓ isConcurrencySafe opt-in [01] | ✓ scheduler maxConcurrency 10 [02] | ✓ FuturesOrdered [03] | ✓ ai-sdk toolcalls map by callID [04] | ✓ 默认并行 [05] | ◐ 并发 JSON-RPC [06] | ◐ [07] |
| Compaction | ✓ compaction seam+事件 [01] | ✓ 双层 auto+micro [02] | ✓ pre-sampling auto+Op::Compact [03] | ✓ auto overflow+manual+session.compacted 事件 [04] | ✓ 3 触发+checkpoint [05] | ◐ unstable/RFD [06] | ◐ thread/compact（不可参数化）[07] |
| Subagent | ✓ providers+fork+team(实验) [01] | ✓ childSessionId+镜像 [02] | ✓ 原生 spawn_agent/wait_agent [03] | ✓ task→真实子 session（客户端自订阅，不转发）[04] | ✗ 示例扩展多进程 [05] | ✗ [06] | ◐ 仅事件面 [07] |
| Usage | ✓ usage 随消息+tokenMeter [01] | ✓ usage state [02] | ✓ TokenCount+rate_limits [03] | ✓ [04] | ✓ cost/cache/reasoning [05] | ◐ session 级 usage_update [06] | ✓ tokenUsage/updated [07] |
| Reasoning events | ✓ ReasoningBlock+流 [01] | ✓ reasoningRow [02] | ✓ ReasoningContentDelta+encrypted [03] | ✓ reasoning part [04] | ✓ thinking deltas+redacted [05] | ✓ agent_thought_chunk [06] | ✓ item/reasoning/* [07] |
| PTC | ✓ ptcRuntime+run_code+dispatch 事件 [01] | ◐ NodeRepl+DynamicWorkflow [02] | ✓ Code Mode (V8) [03] | ◐ experimental code-mode（MCP-only）[04] | ✗ [05] | ✗ [06] | ◐ dynamic tools+code_mode_host [07] |

## 次要对象（Claude Code / Gemini CLI）

证据：research/08-related.md。Claude Code = 闭源 CLI + npm `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts`（9451 行）+ bundle 检查；Gemini CLI = 开源（google-gemini/gemini-cli）。

| Capability | Claude Code (SDK/CLI) | Gemini CLI |
|---|---|---|
| Session | ✓ init+session_id [08] | ✓ InitEvent.session_id [08] |
| Resume | ✓ resume/continue/SessionStore [08] | ✓ --resume/--session-id/resumeSession [08] |
| Fork | ✓ forkSession [08] | ✗ [08] |
| Streaming | ✓ stream_event 包裹原始 API delta [08] | ✓ stream-json + ACP chunk [08] |
| Cancellation | ✓ interrupt+receipt(interrupt_receipt_v1)+control_cancel [08] | ◐ AbortSignal/UserCancelled [08] |
| Approval | ✓ can_use_tool → allow{updatedInput!}/deny{interrupt} [08] | ✓ 7-outcome ToolConfirmationOutcome + requestPermission [08] |
| Tool events | ✓ tool_use/result+tool_progress+tool_use_result [08] | ✓ tool_use/tool_result+调度器状态机 [08] |
| File changes | ◐ 结构化 tool_use_result+rewind_files，无 FS 事件 [08] | ◐ edit diff/diffStat+toolCall.locations [08] |
| Terminal | ✓ Bash 工具 [08] | ✓ node-pty 结构化 ShellOutputEvent [08] |
| Background task | ✓ task_* 事件族+stop_task [08] | ◐ is_background+PID，无通知族 [08] |
| Parallel tools | ✓ per-toolUseID+PostToolBatch [08] | ✓ 并发调度 [08] |
| Compaction | ✓ compact_boundary{trigger,pre/post_tokens} [08] | ✓ ChatCompressed+6 状态 [08] |
| Subagent | ✓ parent_tool_use_id+supportedAgents [08] | ◐ agents/+A2A(实验) [08] |
| Usage | ✓ usage/modelUsage+get_usage [08] | ✓ ResultEvent.stats [08] |
| Reasoning events | ◐ thinking tokens+thinking_display [08] | ✓ Thought 事件 [08] |
| PTC | ✗ [08] | ✗ [08] |

附加关键证据：Claude Code 的控制协议在同一 JSON-Lines 信道上多路复用 `control_request/response/cancel_request`（37 子类型，sender-chosen request_id）；`initialize` 响应带 `pending_permission_requests`（mid-join 重放挂起审批）与 `capabilities[]` 字符串能力协商。Gemini CLI 有确认的 ACP 适配器（packages/cli/src/acp/，ndJSON JSON-RPC over stdio）。

## 跨 Runtime 观察速记（最终报告 Part B/C 的素材）

- **Session 持久化**：全部核心 Runtime 都选择 append-only JSONL（DSH/Pi/Codex）或等价事件溯源（ZCode: SQLite+事件；OpenCode: SQLite+EventV2）。"Session = 不可变事件账本" 是最强共性。
- **客户端可见层**：ZCode 明确只投影（ConversationRow）；DSH 以 session/event 全量转发；Codex 以 EventMsg/通知；ACP 以 session/update；OpenCode 以 SSE 事件。共性 = **投影式事件流**，而非模型消息直通。
- **审批**：闭式决策枚举 + 会话级记忆（ApprovedForSession / allowAlways / AcceptForSession）几乎一致；Claude Code（updatedInput）与 ZCode（modifiedInput）支持参数改写；OpenCode 用"拒绝+反馈文本"达成类似效果。
- **Compaction**：6/7 自有实现且发持久事件（ACP 放 unstable/RFD）——"compaction 是 runtime 内部行为但产生可见事件" 是共识。
- **Subagent**：Codex CLI（原生）、DSH（可插 provider）、ZCode（独立 session+镜像）、OpenCode（真实子 session）最强；Pi/ACP 明确不做。
- **PTC**：Codex（Code Mode）与 DSH（ptc-runtime）原生；ZCode 半（REPL+workflow）；OpenCode 实验（MCP-only）；Pi/ACP/Claude/Gemini 无。
- **完成语义**：submit 返回"接收回执"与"turn 完成"普遍解耦（DSH messageId 回执、Pi agent_settled、OpenCode session.idle、ACP v2 state_update、Claude result、Gemini Finished）。
