# 08. 相关运行时调研(二):Claude Code Agent SDK / CLI 与 Gemini CLI

> 状态:完成
> 方法与局限(重要):Claude Code CLI 本体为闭源、打包混淆的 npm 分发物,**本报告不对 CLI 二进制做源码审计**;其协议证据来自 (a) npm 包 `@anthropic-ai/claude-agent-sdk` 内随包发布的类型声明 `sdk.d.ts`(9451 行,公开 API 面,标注为【source: npm sdk.d.ts】)、(b) code.claude.com 官方文档【docs】、(c) 开源仓库 `anthropics/claude-agent-sdk-typescript`。注意:**该 GitHub 仓库并不包含 SDK 源码**——浅克隆后仓库内只有 `README.md`、`CHANGELOG.md`(逐版本记录协议面变化,极有价值)、`examples/session-stores/`(S3/Redis/Postgres 的 SessionStore 适配器示例)与 CI 脚本;SDK 实现源码在仓库中未找到(源码中未找到 src/)。实现体 `sdk.mjs` 为打包产物,凡只从 bundle 中确认的结论标注【closed-source, bundle-inspected】。Gemini CLI 为开源仓库 `google-gemini/gemini-cli`(main,浅克隆)【source】。

## 1. Claude Code:Agent SDK 与 headless CLI 协议

### 1.1 消息模型(stream-json / SDKMessage)

权威消息并集为 `SDKMessage`【source: npm sdk.d.ts:5025】,成员(38 个,逐个列出以展示 runtime 事件面之大):

`SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | SDKAPIRetryMessage | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage | SDKLocalCommandOutputMessage | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage | SDKPluginInstallMessage | SDKToolProgressMessage | SDKAuthStatusMessage | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskUpdatedMessage | SDKTaskProgressMessage | SDKBackgroundTasksChangedMessage | SDKThinkingTokensMessage | SDKSessionStateChangedMessage | SDKWorkerShuttingDownMessage | SDKCommandsChangedMessage | SDKNotificationMessage | SDKFilesPersistedEvent | SDKToolUseSummaryMessage | SDKMemoryRecallMessage | SDKRateLimitEvent | SDKElicitationCompleteMessage | SDKPermissionDeniedMessage | SDKPromptSuggestionMessage | SDKMirrorErrorMessage | SDKInformationalMessage | SDKConversationResetMessage`

**模型 API 消息 vs harness runtime 事件**的区分(ARI 设计的关键视角):
- 载荷为 Anthropic Messages API 原始结构的:`SDKAssistantMessage { type:'assistant', message: Message, parent_tool_use_id, uuid, session_id }`(:3405)、`SDKUserMessage { type:'user', message: MessageParam, parent_tool_use_id, isSynthetic?, tool_use_result?, priority?, origin? }`(:5879)。`parent_tool_use_id` 非空即 subagent 消息。
- harness 生成的事件:`system/init`(`SDKSystemMessage`:5580,含 model/tools/mcp_servers/permissionMode/slash_commands/output_style/skills/plugins/apiKeySource/capabilities)、`result`、`stream_event`、`compact_boundary`、`api_retry`、hook 三件套、task_* 系列、`permission_denied`、`files_persisted`、`conversation_reset` 等。

- `result` 消息:`SDKResultMessage = SDKResultSuccess | SDKResultError`(:5416)。success 关键字段:`duration_ms / duration_api_ms / ttft_ms、num_turns、result、total_cost_usd、usage(主循环)、modelUsage(每模型全量,含 subagent/compaction 辅助调用)、permission_denials、structured_output、deferred_tool_use、result_index、queued_turn_count、session_id、uuid`(:5418-5481);error 子类型:`'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`(:5359)。
- 工具结果编码:除 tool_result block 外,`SDKUserMessage.tool_use_result` 携带**结构化 per-tool Output 对象**("the tool's full Output object, not the string content sent to the model",Agent/Task 工具的 completed shape 为 subagent 最终报告,:5884-5892)。
- 【docs】headless 文档(https://code.claude.com/docs/en/headless)额外规定 stream-json 上的 `system/api_retry`(attempt/max_retries/retry_delay_ms/error_status/error 枚举)、`system/plugin_install`、`hook_started/hook_progress/hook_response`、`permission_denied`;`system/init.capabilities[]` 为字符串能力协商(如 `interrupt_receipt_v1`、`interrupt_cancel_queued_v1`),要求消费者做 feature-detect 而非比较版本号。

### 1.2 Session:continue / resume / fork / 持久化

- `Options`【source: npm sdk.d.ts:1449-】: `continue?: boolean`(续接当前目录最近会话,:1522)、`resume?: string`(按 session id,:1991)、`forkSession?: boolean`(与 resume 连用产生分叉,:1637)、`persistSession?: false`(纯内存会话,:1745)、`abortController`(取消,:1454)、`cwd`。
- CLI flags【docs】(https://code.claude.com/docs/en/headless):`--continue`、`--resume <id|jsonl路径>`(可直接传 transcript 文件绝对路径)、`--fork-session`。
- 持久化:transcript 为 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`(cwd 非字母数字字符替换为 `-`)【docs】(https://code.claude.com/docs/en/agent-sdk/sessions);跨目录 resume(v2.1.223+)、跨主机用 `SessionStore` 适配器镜像(文档页 session-storage;repo 中 `examples/session-stores/{s3,redis,postgres}` 给出 conformance 测试)【source: repo examples】。
- 会话管理 API(模块级函数):`listSessions()`(:1029)、`getSessionMessages()`(:834)、`getSessionInfo()`(:804)、`renameSession()`(:3051)、`tagSession()`、`deleteSession()`(:600)、`forkSession({upToMessageId})`(:770);返回 `SDKSessionInfo`(:5486)。**注意:这些是 SDK host 进程内函数(直接读 transcript 文件),不是 control_request 子类型**——与会话相关的 control 子类型只有 `rename_session` 等。
- 中断:`Query.interrupt(): Promise<SDKControlInterruptResponse | undefined>`【source: npm sdk.d.ts:2685】,control 子类型 `interrupt`(:4348);宣告 `interrupt_receipt_v1` 能力的 CLI 返回 receipt(`still_queued` uuid 列表,需再 cancel)。control 协议撤销:`SDKControlCancelRequest {type:'control_cancel_request', request_id}`(:3677,语义:撤回己方在途 control_request,如 turn 被中断后遗留的 can_use_tool 提问)。
- 进程级取消:`abortController` + `endInput()`;SIGTERM 对 `claude -p` 的语义:exit code 143、当前 turn 不写入 result、kill Bash 进程树、执行 SessionEnd hooks、resume 时重放未完成 turn【docs: headless】。

### 1.3 Agent loop、工具与权限

**Loop 位置**:agent loop 完全在闭源 CLI 进程内;SDK 侧 `query()` 只是一个把 transport 帧转成 `AsyncGenerator<SDKMessage>` 的宿主循环【source: npm sdk.d.ts:2671 `Query extends AsyncGenerator<SDKMessage, void>`】。SDK host 可注册进程内工具(createSdkMcpServer,:543),工具在 host 执行,由 CLI 经 control 协议回调。

**canUseTool 审批回调**【source: npm sdk.d.ts:213-298】:`CanUseTool = (toolName, input, options) => Promise<PermissionResult | null>`,options 含 `signal / suggestions(PermissionUpdate[]) / blockedPath / mcpServer{name,source} / decisionReason / title / displayName / description / defaultToNo / suppressAlwaysAllowRule / toolUseID / agentID / requestId / matchedAskRule`——即 UI 渲染所需的一切都由协议下发。返回:`PermissionResult = {behavior:'allow', updatedInput?, updatedPermissions?} | {behavior:'deny', message, interrupt?: boolean}`(:2406)。`allow{updatedInput}` 允许宿主**改写工具入参**。底层是 `can_use_tool` control_request(SDKControlPermissionRequest),支持 out-of-band 回答(如签名 HTTP POST 回写 request_id)。

**审批优先级**【docs】(https://code.claude.com/docs/en/agent-sdk/permissions):hooks → deny 规则 → ask 规则 → permission mode → allow 规则 → canUseTool;`AskUserQuestion`、`_meta["anthropic/requiresUserInteraction"]` 的 MCP 工具、关键路径 rm 即使 allow 规则命中也落入回调。

**Permission modes**【source: npm sdk.d.ts:2383】:`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`(auto = 模型分类器审批)。运行时切换:`set_permission_mode` control_request(:4797)/ `Query.setPermissionMode()`(:2692);另有 `setMcpPermissionModeOverride(server, 'default'|'auto'|null)`(仅可收紧,:2709)。

**Hooks**【source: npm sdk.d.ts:910】:`HookEvent` 共 33 个事件:`'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch' | 'Notification' | 'UserPromptSubmit' | 'UserPromptExpansion' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop' | 'PreCompact' | 'PostCompact' | 'PreModelSwitch' | 'PostModelSwitch' | 'PermissionRequest' | 'PermissionDenied' | 'Setup' | 'TeammateIdle' | 'TaskCreated' | 'TaskCompleted' | 'Elicitation' | 'ElicitationResult' | 'ConfigChange' | 'WorktreeCreate' | 'WorktreeRemove' | 'InstructionsLoaded' | 'CwdChanged' | 'FileChanged' | 'DirectoryAdded' | 'MessageDisplay'`。SDK 内注册为进程内回调 `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`(:1658),经 `hook_callback` control_request 调用;CLI 侧事件流出现 `SDKHookStartedMessage/Progress/Response`。

**Subagents**:`agents` 选项定义(`AgentDefinition`:38,:1504),经 Agent/Task 工具调用;stream 中 subagent 消息以 `parent_tool_use_id` 归属(主会话为 null)【docs: headless "Follow subagent messages"】;默认只转发 tool_use/tool_result,`--forward-subagent-text` 才转发 text/thinking;token 级 stream_event 不转发 subagent【docs: streaming-output】;嵌套 depth 以 parent_tool_use_id 链重建。`supportedAgents()` 可枚举。

**MCP**:`mcpServers`(stdio/SSE/HTTP/Sdk in-process)【source: npm sdk.d.ts:1149】;control 子类型含 `mcp_status / mcp_call / mcp_set_servers / mcp_reconnect / mcp_toggle / mcp_message`;`system/init` 报告 `mcp_servers[].status` 与 `mcp_server_errors`【docs: headless】;`mcpServerStatus()` 查询(:2841)。

**并行工具调用**:同一 assistant message 携带多个 tool_use block;审批按 `toolUseID` 逐个进行("Multiple tool calls in the same assistant message will have different toolUseIDs",:274-277);`PostToolBatch` hook(:910)与 changelog 0.3.274 "queued background-task completions to share one model call" 佐证批处理存在。专用并行度控制参数:源码中未找到。

### 1.4 流式(partial messages / stream_event)

- 选项 `includePartialMessages?: boolean`【source: npm sdk.d.ts:1790】→ 产出 `SDKPartialAssistantMessage { type:'stream_event', event: BetaRawMessageStreamEvent, parent_tool_use_id: string|null, uuid, session_id, ttft_ms?, user_message_uuid?, user_message_uuids?, resume_reason? }`(:5170)。`event` 为**Anthropic Messages API 原生流事件**(message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop),SDK 不做累积。
- 事件顺序【docs】(https://code.claude.com/docs/en/agent-sdk/streaming-output):每个非空 content block 完成即产出一条 AssistantMessage(同一 message id),再 `content_block_stop`;最后 ResultMessage。structured output 只出现在最终 result,不流式。
- 限制:stream_event 只发主会话(subagent 的 token 级 delta 不转发);`user_message_uuid` 把回复帧绑定到触发它的 user 消息 uuid(绑帧语义,对 ARI 的 request↔event 关联有直接参考价值)。
- CLI 侧:`claude -p --output-format stream-json --verbose --include-partial-messages`,JSON Lines stdout,末行为 result【docs: headless】;stdout 慢消费时退出前 drain,上限 30s(v2.1.214+)。
- thinking:独立 `SDKThinkingTokensMessage`;`set_max_thinking_tokens` control 子类型支持 `thinking_display: 'summarized'|'omitted'|'highlights'`【source: npm sdk.d.ts:4774】。

### 1.5 Context 管理(compaction)

- 边界消息:`SDKCompactBoundaryMessage { type:'system', subtype:'compact_boundary', compact_metadata: { trigger: 'manual'|'auto', pre_tokens, post_tokens?, duration_ms?, preserved_segment?/preserved_messages?(保留消息 uuid 锚点,便于 resume 重链) } }`【source: npm sdk.d.ts:3530-3560】——**对客户端可见的 compaction 是一等事件,且携带 token 前后值与触发方式**。
- 触发:自动 + `/compact` 手动;前后置 hook `PreCompact`/`PostCompact`(:910);compaction 作为内部模型调用计入 `modelUsage`【source: sdk.d.ts:5460】。
- 上下文用量查询:`Query.getContextUsage({detail:'summary'|'full'})` control 子类型 `get_context_usage`,按 system prompt/tools/messages/MCP/memory 分类返回 token(:2852)。

### 1.6 Transport 与 control protocol(control_request/control_response)

- **同信道复用**:JSON Lines stdin/stdout 上同时跑数据消息与控制消息。wire 级并集:`StdoutMessage = SDKMessage | SDKActiveGoalMessage | SDKControlResponse | SDKControlRequest | SDKControlCancelRequest | SDKKeepAliveMessage`【source: npm sdk.d.ts:9049】(KeepAlive 为心跳帧)。
- 控制信封:`SDKControlRequest { type:'control_request', request_id(发送方选定,响应回显), request: SDKControlRequestInner }`(:4688);响应 `SDKControlResponse { type:'control_response', response: ControlResponse | ControlErrorResponse }`(:4739),error 形态带 `request_id`。撤销:`control_cancel_request`(:3677)。
- `SDKControlRequestInner` 共 37 个子类型(:4699):`interrupt / can_use_tool(权限) / initialize / set_permission_mode / set_model / set_max_thinking_tokens / rename_session / set_color / mcp_status / get_context_usage / get_session_cost / list_models / get_usage / get_binary_version / mcp_call / file_suggestions / hook_callback / mcp_message / rewind_files / cancel_async_message / read_file / seed_read_state / mcp_set_servers / register_repo_root / reload_plugins / reload_skills / reload_output_styles / mcp_reconnect / mcp_toggle / stop_task / background_tasks / apply_flag_settings / get_settings / get_hooks_listing / update_settings / elicitation / request_user_dialog / list_permission_rules`。`initialize` 响应携带 `pending_permission_requests[]`/`pending_user_dialog_requests[]`(客户端中途接入可重新武装在途提问,:317-331);`reinitialize()` 供 transport 断线重连后重放。
- Transport 抽象:`interface Transport { write / readMessages(): AsyncGenerator<StdoutMessage> / close / isReady / endInput / expectControlResponse? / markDelivered? / waitForExit? / Symbol.dispose? }`,注释明言 "support both process and WebSocket transports"【source: npm sdk.d.ts:9258-9314】。默认 `ProcessTransport` spawn CLI 子进程;bundle 内确认存在 `DirectConnectTransport`、`kWebSocket`、`fromSSEResponse`【closed-source, bundle-inspected:sdk.mjs】;另有 `/browser` 出口(SSE,类型见 browser-sdk.d.ts)与 `/bridge` 出口(CCR worker:每会话 handle + JWT,`SessionState = 'idle'|'running'|'requires_action'`)【source: npm bridge.d.ts】。

### 1.7 Claude Code 能力矩阵

| Session | Resume | Fork | Streaming | Cancellation | Approval | Tool events | File changes | Terminal | Background task | Parallel tools | Compaction | Subagent | Usage | Reasoning events | PTC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ✓ `system/init` + `session_id`【sdk.d.ts:5580】 | ✓ `resume`/`--resume`(id 或 jsonl 路径;SessionStore 跨机)【sdk.d.ts:1991;docs sessions】 | ✓ `forkSession` option + `forkSession({upToMessageId})`【sdk.d.ts:1637,770】 | ✓ `stream_event`(Anthropic 原生 delta)【sdk.d.ts:5170;docs streaming-output】 | ✓ `interrupt` control + receipt;`control_cancel_request`;AbortController【sdk.d.ts:2685,3677】 | ✓ `can_use_tool` + `PermissionResult(allow/deny/updatedInput/suggestions)`【sdk.d.ts:213,2406】 | ✓ tool_use/tool_result + `SDKToolProgressMessage`/`SDKToolUseSummaryMessage`/`tool_use_result`【sdk.d.ts:5025】 | partial 结构化 per-tool Output + `rewind_files`/checkpoint;无通用 FS 变更事件流【sdk.d.ts:4750;docs file-checkpointing】 | ✓ Bash 工具,输出经 tool_result/tool_progress;无独立 PTY 事件类型(源码中未找到)【sdk.d.ts:5025】 | ✓ `task_started/task_progress/task_notification/background_tasks_changed` + `stop_task`【sdk.d.ts:5025,4809】 | ✓ 多 tool_use/消息,按 toolUseID 审批,PostToolBatch hook【sdk.d.ts:277,910】 | ✓ `compact_boundary`(trigger/pre_tokens/preserved)【sdk.d.ts:3530】 | ✓ Agent 工具 + `parent_tool_use_id` + SubagentStart/Stop hook + `supportedAgents()`【sdk.d.ts:910,2835】 | ✓ result.usage/modelUsage/total_cost_usd + `get_usage`【sdk.d.ts:5458-5462】 | partial thinking blocks + `SDKThinkingTokensMessage` + thinking_display【sdk.d.ts:4774】 | ✗ 无程序化工具编排面(源码中未找到) |

### 1.8 文件变更报告与后台任务备注

- **文件变更**:非 watcher 模式。结构化路径有三:(1) 工具结果的 `tool_use_result` 结构化对象(user 消息上,per-tool Output);(2) `rewind_files` control_request(user_message_id + dry_run)+ file checkpointing【source: npm sdk.d.ts:4750;docs: /agent-sdk/file-checkpointing】;(3) hook 事件 `FileChanged/CwdChanged/DirectoryAdded`(:910)。通用"工作区 diff 推送"事件:源码中未找到。
- **后台任务**:一等 runtime 事件族 `SDKTaskStartedMessage / SDKTaskProgressMessage / SDKTaskUpdatedMessage / SDKTaskNotificationMessage / SDKBackgroundTasksChangedMessage`,通知可携带 `origin.kind='task-notification'` 重放进 user 消息、`reason:'worker_restart'`【source: npm sdk.d.ts:5025;CHANGELOG 0.3.269/0.3.274】;控制面 `stop_task / background_tasks` control 子类型【source: sdk.d.ts:4809】。changelog 0.3.274 记录"排队的后台任务完成共享一次模型调用,各自仍有 result"——后台完成与主循环合流的协议语义。【docs: headless】补充:`claude -p` 中后台 bash 在结果返回+stdin 关闭后 ~5s 终止;后台 subagent/workflow 则等待完成(默认 10 分钟上限,`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 可调);Monitor 工具的 watch 会被等待并持续回报。

## 2. Gemini CLI(google-gemini/gemini-cli)

### 2.1 消息模型:Turn / TurnEvent

- 核心事件流:`ServerGeminiStreamEvent` 联合类型,事件类型枚举 `GeminiEventType`【source: gemini-cli/packages/core/src/core/turn.ts:55-74】:`Content / ToolCallRequest / ToolCallResponse / ToolCallConfirmation / UserCancelled / Error / ChatCompressed / Thought / MaxSessionTurns / Finished / LoopDetected / Citation / Retry / ContextWindowWillOverflow / InvalidStream / ModelInfo / AgentExecutionStopped / AgentExecutionBlocked`。每类有具名 `ServerGemini*Event` 类型(:76-246),如 `ServerGeminiContentEvent{value:string}`、`ServerGeminiToolCallRequestEvent{value:ToolCallRequestInfo}`、`ServerGeminiFinishedEvent{value:{reason, usageMetadata}}`。
- 区分模型流与 runtime:`Content/Thought/Citation/Retry` 是模型流直出;`ToolCall*/ChatCompressed/MaxSessionTurns/LoopDetected/InvalidStream(ContextWindowWillOverflow 带 estimated/remaining token 数,:98-104)`是 harness runtime 事件。
- headless wire 模型(与 Claude stream-json 对位):`--output-format text|json|stream-json`【source: packages/core/src/output/types.ts:9-13 `OutputFormat`】;流式事件枚举 `JsonStreamEventType = init | message | tool_use | tool_result | error | result`(:30-37),形状:`InitEvent{session_id, model}`、`MessageEvent{role:'user'|'assistant', content, delta?}`、`ToolUseEvent{tool_name, tool_id, parameters}`、`ToolResultEvent{tool_id, status:'success'|'error', output?, error?}`、`ErrorEvent{severity, message}`、`ResultEvent{status, stats: StreamStats{total/input/output/cached_tokens, duration_ms, tool_calls, models}}`(:44-109);`JsonOutput{session_id, response, stats, error, warnings}` 为 json 模式(:21-27)。格式化器:`packages/core/src/output/stream-json-formatter.ts`、`json-formatter.ts`;装配:`packages/cli/src/nonInteractiveCli.ts:255-596`。
- 对比:Gemini 的 runtime 事件面(~18 类)远小于 Claude(~38 类),没有 hook 流事件、任务通知、会话状态等粘合事件;UI 专用语义(Thought 归为 `{subject, description}` ThoughtSummary)由 core 统一产出。

### 2.2 Session 与 chat service

- 持久化:`chatRecordingService` 会话落盘;`sessionSummaryService` 生成摘要【source: packages/core/src/services/chatRecordingService.ts、sessionSummaryService.ts】。
- Resume:CLI flags `--resume latest|<index>`("Resume a previous session. Use \"latest\" for most recent or index number")、`--session-id`、`--session-file`,三者互斥【source: packages/cli/src/config/config.ts:97,243-249,401-410】。
- Fork:**源码中未找到**(grep `forkSession|fork_session` 全仓无果)——fork 语义缺失是 Gemini CLI 与 Claude Code 的显著差距。
- SDK 包:`GeminiCliAgent.session()` / `resumeSession(id)`【source: packages/sdk/SDK_DESIGN.md、src/agent.ts】;ACP 面上 `newSession` / `loadSession`【source: packages/cli/src/acp/acpSessionManager.ts(README 列明)】。
- 取消:`AbortSignal` 贯穿(`sendStream(prompt, signal)`,SDK session.ts:211);交互态 `UserCancelled` 事件;non-interactive 无 interrupt control 子类型(源码中未找到)。

### 2.3 Agent loop 与 CoreToolScheduler(审批、并行工具)

- Loop:Turn 类在 `packages/core/src/core/turn.ts` 中迭代模型流并 yield 事件;`GeminiClient.sendMessageStream`(`core/client.ts`)驱动 turn 循环与自动压缩。
- 调度器:`Scheduler`(class 位于 `packages/core/src/scheduler/scheduler.ts:99`),工具调用状态机 `CoreToolCallStatus = validating | scheduled | error | success | executing | cancelled | awaiting_approval`【source: scheduler/types.ts:26-34】;`ToolCall` 联合:Validating/Scheduled/Errored/Successful/Executing/Cancelled/Waiting(:189-196)。`WaitingToolCall{status:'awaiting_approval', confirmationDetails: ToolCallConfirmationDetails | SerializableConfirmationDetails, correlationId?}`(:164-185)——确认载荷正朝**可序列化**方向迁移(TODO 注释明言将移除带回调的旧形态),这对跨进程审批协议是关键证据。
- 确认详情七类【source: packages/core/src/tools/tools.ts:1094-1101】:`sandbox_expansion / edit / exec / mcp / info / ask_user / exit_plan_mode`(如 `ToolExecuteConfirmationDetails{title, command, rootCommand, rootCommands[], untrustedFlags?, modifiedBuildFiles?}`,:1037-1048)。
- 审批结果枚举 `ToolConfirmationOutcome = proceed_once | proceed_always | proceed_always_and_save | proceed_always_server | proceed_always_tool | modify_with_editor | cancel`【source: tools/tools.ts:1106-1114】——比 Claude 的 allow/deny 二值细(持久化层级、编辑器改参都是 outcome)。
- 审批模式:`ApprovalMode = DEFAULT | AUTO_EDIT('autoEdit') | YOLO | PLAN`【source: packages/core/src/policy/types.ts:48-53】;每工具调用上记录 `approvalMode`【source: scheduler/types.ts:89】;策略引擎在 `packages/core/src/policy/`。
- 并行:调度器支持并发执行与完成回调(`AllToolCallsCompleteHandler`、`ToolCallsUpdateHandler`【source: scheduler/types.ts:207-216】),存在 `scheduler_parallel.test.ts`、`scheduler_waiting_callback.test.ts` 等专门测试【source: scheduler/ 目录】。
- Hook 系统:`HookEventName = BeforeTool | AfterTool | BeforeAgent | AfterAgent | Notification | SessionStart | SessionEnd | PreCompress | BeforeModel | AfterModel | BeforeToolSelection`(11 个)【source: packages/core/src/hooks/types.ts:43-55】,有完整 registry/planner/runner/aggregator 分层;Claude 的 33 个 hook 事件中 FilesChanged/CwdChanged/TaskCreated 等文件系统观察类在 Gemini 源码中未找到。
- Subagents:`packages/core/src/agents/`(agent-scheduler、local-invocation、remote-session-invocation(A2A)、browser agent),`AgentTerminateMode = ERROR|TIMEOUT|GOAL|MAX_TURNS|ABORTED|ERROR_NO_COMPLETE_TASK_CALL`,`OutputObject{result, terminate_reason, turn_count?, duration_ms?}`【source: agents/types.ts:18-42】;工具面含 `complete-task`、`activate-skill`【source: tools/ 目录】。
- MCP:`tools/mcp-client.ts、mcp-tool.ts、mcp-client-manager.ts、list-mcp-resources.ts`【source: tools/ 目录】。
- 工具结果编码:`ToolCallResponseInfo{callId, responseParts: Part[], resultDisplay?: ToolResultDisplay, error?, errorType?, outputFile?, contentLength?, data?}`【source: scheduler/types.ts:59-73】——`resultDisplay`(UI 用)与 `responseParts`(模型用)分离是它的结构化结果关键设计。

### 2.4 流式事件

- 模型流粒度:`Content` 事件按 chunk 文本增量、`Thought` 携带 `ThoughtSummary`(subject/description)【source: core/turn.ts:147-157】;**没有**把 Gemini API 原生流事件透传出来的模式(Claude 的 stream_event 对应物不存在);raw 事件透传:源码中未找到。
- stream-json 输出的流粒度以 `MessageEvent.delta?: boolean` 标注【source: output/types.ts:50-55】,工具以 `tool_use/tool_result` 事件成对出现;`ResultEvent.stats` 终态汇总。
- ACP 面流式:`sessionUpdate` 通知含 `agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / user_message_chunk / available_commands_update`【source: packages/cli/src/acp/acpSession.ts:181,231,248,258,267,295,425-434,809】。

### 2.5 Context 管理:compression service

- `ChatCompressionService.compress(chat, promptId, force, model, config, hasFailedCompressionAttempt, signal)`【source: packages/core/src/context/chatCompressionService.ts:239-】;默认阈值 `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5`(占模型 token limit 比例,:41),`config.getCompressionThreshold()` 可覆盖(:272-274);压缩前对 history 做 token 预算截断(`truncateHistoryToBudget`);结果 `ChatCompressionInfo{originalTokenCount, newTokenCount, compressionStatus}`。
- 状态枚举 `CompressionStatus = COMPRESSED | COMPRESSION_FAILED_INFLATED_TOKEN_COUNT | COMPRESSION_FAILED_TOKEN_COUNT_ERROR | COMPRESSION_FAILED_EMPTY_SUMMARY | NOOP | CONTENT_TRUNCATED`【source: core/turn.ts:183-207】——失败原因细粒度可观测(膨胀/计数错误/空摘要/截断降级)。
- 自动触发:`GeminiClient.sendMessageStream` 内超过阈值即 `tryCompressChat(prompt_id, false, signal)`,成功后 yield `ChatCompressed` 事件【source: core/client.ts:689-694】;手动 `/compress` 命令(force=true);压缩前后 hook:`PreCompress`(带 `PreCompressTrigger.Manual|Auto`)【source: chatCompressionService.ts:262-265】。
- 溢出预警:`ContextWindowWillOverflow{estimatedRequestTokenCount, remainingTokenCount}` 事件【source: core/turn.ts:98-104】。另有新 `ContextCompressionService`【source: context/contextCompressionService.ts:50】并存。

### 2.6 Transport:本地 REPL、IDE mode、ACP adapter、server/SDK

- 本地 REPL:core 事件流进程内直连 Ink/React UI,无 wire 协议;非交互走 `--output-format json/stream-json`(见 2.1)。
- **ACP adapter(重要)**:`packages/cli/src/acp/` 实现了 Zed 的 Agent Client Protocol:`acpStdioTransport.ts` 用 `acp.ndJsonStream(stdout, stdin)` + `new acp.AgentSideConnection(...)` 建立 **stdio 上 ndjson JSON-RPC**【source: acpStdioTransport.ts:25-26;README】;`acpRpcDispatcher.ts`(GeminiAgent 类,JSON-RPC 入口)、`acpSessionManager.ts`(newSession/loadSession/多会话)、`acpSession.ts`(prompt 执行、@file 解析、工具执行、slash 命令拦截、流式回传)、`acpFileSystemService.ts`(workspace 边界内的 fs 访问)、`acpErrors.ts`(错误码映射)。
- **审批跨协议映射**:ACP `RequestPermissionRequest{sessionId, options, toolCall:{toolCallId, status:'pending', title, content, locations, kind}}` → 客户端 `RequestPermissionResponse` → `outcome.optionId` 解析回 `ToolConfirmationOutcome`,`cancelled` 映射为 `ToolConfirmationOutcome.Cancel`【source: acpSession.ts:760-800】。
- IDE mode:`packages/core/src/ide/`(ide-client、`IdeContextStore`/`ideContextStore` 单例:IDE 推送 open files/selection 上下文、detect-ide、ide-installer)+ `packages/vscode-ide-companion` 扩展【source: ide/ 目录】。
- Server/SDK:`packages/a2a-server`(A2A 协议 server,README 自述 experimental)、`packages/sdk`(`@google/gemini-cli-sdk`,进程内 `GeminiCliAgent`,`sendStream` yield `ServerGeminiStreamEvent`;SDK_DESIGN.md 自述 hooks/skills/subagents/ACP 尚缺)【source: packages/a2a-server/README.md、packages/sdk/SDK_DESIGN.md、src/session.ts:211-265】。

### 2.7 Gemini CLI 能力矩阵

| Session | Resume | Fork | Streaming | Cancellation | Approval | Tool events | File changes | Terminal | Background task | Parallel tools | Compaction | Subagent | Usage | Reasoning events | PTC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ✓ `InitEvent.session_id` + chat recording【output/types.ts:44】 | ✓ `--resume latest\|N`、ACP `loadSession`、SDK `resumeSession()`【config.ts:401;acp README】 | ✗ fork 语义(源码中未找到) | ✓ stream-json + ACP `agent_message_chunk` + `delta` 标志【output/types.ts:50;acpSession.ts:181】 | partial AbortSignal/UserCancelled/交互 ESC;无 interrupt 控制子类型(源码中未找到) | ✓ `awaiting_approval` + `ToolConfirmationOutcome`(7 值)+ ACP `requestPermission`【scheduler/types.ts:164;tools/tools.ts:1106】 | ✓ `tool_use/tool_result` 事件 + scheduler 状态机 + `ToolCallsUpdateHandler`【output/types.ts:57;types.ts:216】 | partial edit 工具结构化 diff/diffStat(`FileDiff`,added/removed 行数)【tools/edit.ts:442】+ ACP `toolCall.locations`;无通用 FS 变更事件 | ✓ node-pty `ShellExecutionService`,`ShellOutputEvent = data\|binary_detected\|binary_progress\|exit`【services/executionLifecycleService.ts:37-53】 | partial shell `is_background` 参数 + PID 捕获【tools/shell.ts:97,119】;无跨 turn 任务通知事件族(源码中未找到) | ✓ 并发调度 + 专门测试【scheduler_parallel.test.ts】 | ✓ `ChatCompressed` 事件(auto/manual,阈值 0.5)【core/client.ts:689;chatCompressionService.ts:41】 | partial agents/ 框架 + A2A remote agent;非默认模型可见工具(源码中未找到 Task 等价物) | ✓ `ResultEvent.stats`(tokens/cached/duration/tool_calls/models)+ Finished.usageMetadata【output/types.ts:81-109;turn.ts:137】 | ✓ `Thought` 事件(ThoughtSummary)+ `agent_thought_chunk`【turn.ts:153】 | ✗ 源码中未找到 |

### 2.8 文件变更报告与后台任务备注

- **文件变更报告**:以"工具自报"为主——Edit/Write 工具的 `resultDisplay` 携带结构化 diff(`FileDiff`、`diffStat.model_added_lines/model_removed_lines`,基于 `diff` 库计算)【source: packages/core/src/tools/edit.ts:41-69,442-444;diffOptions.ts】;确认阶段 `ToolEditConfirmationDetails` 就给出 diff 预览;ACP 将 `invocation.toolLocations()` 作为 `toolCall.locations` 下发【source: acpSession.ts:775】。git 维度有 `gitService.ts`(仓库状态)。无文件系统 watcher 广播事件(源码中未找到)。
- **后台任务**:shell 工具 `is_background` 参数,命令包 subshell 捕获后台 PID,后台任务不阻塞流式输出【source: packages/core/src/tools/shell.ts:97,119,160-163,617-631】;`ExecutionLifecycleService` 集中广播执行事件(含按 pid)【source: services/executionLifecycleService.ts:34-53】。与 Claude 的 task_started/task_notification 事件族相比,缺少"后台任务完成 → 注入下轮上下文"的协议化通知(源码中未找到)。

## 3. 对 ARI 设计的启示(小结)

1. **控制信道与数据信道同流复用、request_id 关联**是两个实现共同的收敛点:Claude 的 `control_request/control_response/cancel_request`(37 子类型)跑在 stdout JSON Lines 内;Gemini 的 ACP 走 ndjson JSON-RPC。ARI 的 control 子协议有成熟先例可裁剪。
2. **审批消息必须携带 UI 所需全部元数据**:Claude `can_use_tool` options(title/displayName/description/suggestions/blockedPath/decisionReason)+ `PermissionResult.allow.updatedInput` 改写入参;Gemini 的可序列化 `SerializableConfirmationDetails` 迁移与 7 值 outcome。ARI 应至少支持 allow/deny/allow-with-edited-input + 持久化建议。
3. **回复↔请求绑定**:Claude 用 `user_message_uuid` 把流帧绑回触发消息;`parent_tool_use_id` 把 subagent 帧挂树。ARI 需要等价关联字段,否则多 subagent/多 turn 并发 UI 无法还原归属。
4. **compaction 是一等事件**:Claude `compact_boundary`(trigger/pre_tokens/preserved_messages)、Gemini `ChatCompressed`(token 前后计数 + 细粒度失败枚举)。ARI 的 compaction 事件应同时携带触发方式、token 计量与摘要锚点。
5. **工具结果双通道**:Gemini 分 `responseParts`(模型)与 `resultDisplay`(UI);Claude 分 tool_result 文本与 `tool_use_result` 结构化对象。ARI 应显式区分 model-facing 与 client-facing 载荷。
6. **能力协商**:Claude `system/init.capabilities[]` 字符串集合 + "ignore unknown" 规则,轻于版本比较,可直接借鉴为 ARI handshake。
7. **差距项**:fork(Gemini 无)、interrupt receipt(Gemini 无)、后台任务通知事件族(Gemini 无)、文件变更统一事件流(两者都以工具自报为主,ARI 若提供 watcher 事件即超出两者现有面)。
