# Codex App Server 源码研究报告(openai/codex,crate: codex-rs/app-server)

> 研究对象:`codex-rs/app-server`(JSON-RPC server)+ `codex-rs/app-server-protocol`(协议定义)。
> 本地仓库:`<local checkout>`。所有结论均给出 源码路径 + symbol 证据。

## 1. Transport & framing(JSON-RPC over stdio?)

**Line-delimited JSON,不是 Content-Length(LSP 风格)。** 整个仓库(app-server / app-server-transport)中 `Content-Length` 仅出现在 remote_control 的 HTTP/WebSocket 握手测试里,stdio 读取用 `std::io::stdin().lock().lines()` 逐行读,写出时 `json.push('\n')`(`codex-rs/app-server-transport/src/transport/stdio.rs:73,141`)。stdio 连接带 EOF 清理与 SIGTERM 处理("SIGTERM received; closing stdio connection (45s shutdown deadline)",stdio.rs:158)。

**多传输后端**:`ConnectionOrigin` 区分连接来源;`app-server/src/transport.rs` 再导出 `start_stdio_connection` / `start_websocket_acceptor` / `start_control_socket_acceptor`(Unix socket)/ `start_remote_control`(远程控制 WebSocket,含配对、auth、daemon 模式)(transport.rs:25-44)。即:stdio(本地 IDE)、Unix control socket、WebSocket(local acceptor + remote control)三类。

**双向请求:支持。** server→client 的 JSON-RPC request 由 `server_request_definitions!` 枚举(`codex-rs/app-server-protocol/src/protocol/common.rs:1761`):`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/permissions/requestApproval`、`item/tool/call`(DynamicToolCall,客户端工具回调)、`account/chatgptAuthTokens/refresh`、`attestation/generate`、`currentTime/read`。发送侧统一走 `outgoing.send_request(ServerRequestPayload::…)` 返回 `(pending_request_id, rx)` 后 `tokio::spawn` 等响应(`codex-rs/app-server/src/bespoke_event_handling.rs:804-814`);出站信封为 `OutgoingEnvelope::{Broadcast, ToConnection}`(`app-server/src/outgoing_message.rs:117,407-455`),即单 server 进程可服务多连接。

**握手**:client→server `initialize`,params `InitializeParams{client_info: ClientInfo{name,title,version}, capabilities: InitializeCapabilities}`(v1.rs:44-75);capabilities 含 `experimental_api`(opt-in 实验方法/字段)、`request_attestation`、`opt_out_notification_methods`(按方法名屏蔽通知,如 `thread/started`)、`extensions`(MCP 扩展)。连接态 `ConnectionState.outbound_initialized / outbound_experimental_api_enabled`(app-server/src/transport.rs:37-45)据此门控出站。

## 2. Method inventory(client→server 方法全集)

全部 client→server 方法由宏 `client_request_definitions!` 定义于 `common.rs:498-1490`(variant => wire method)。本 checkout 为 **v2 thread.* 命名**;任务中假设的 `newConversation/sendUserMessage/addUserVoiceMessage` 等旧名**源码中未找到**(全仓 grep 无命中),对应关系如下:

| 任务假设 | 实际方法(v2) | 参数/结果证据 |
|---|---|---|
| newConversation | `thread/start` | `ThreadStartParams{model, model_provider, cwd, approval_policy, sandbox, config, base_instructions, developer_instructions, ephemeral, …}`(v2/thread.rs:54-165) |
| sendUserMessage / sendUserTurn | `turn/start` | `TurnStartParams{thread_id, input: Vec<UserInput>, tool_output, cwd, approval_policy, sandbox_policy, model, …}`(v2/turn.rs:167-230;`UserInput` 枚举 turn.rs:425);运行中追加输入用 `turn/steer`(turn.rs:293) |
| interrupt / turn.abort | `turn/interrupt` | outgoing_message.rs:1445 |
| resumeConversation | `thread/resume` | `ThreadResumeParams`(支持 rollout `path`,v2/thread.rs:360-470) |
| listConversations | `thread/list` + `thread/loaded/list` | common.rs |
| archiveConversation | `thread/archive` / `thread/unarchive` | common.rs |
| setModel | 无独立方法:`thread/start.model`、`turn/start.model`(逐 turn 覆盖)+ `model/list` | thread.rs:56 / turn.rs:~228 |
| addUserVoiceMessage | `thread/realtime/appendAudio`(实时语音子协议:thread/realtime/start·appendText·appendSpeech·stop·listVoices) | common.rs |
| mcp server config | `config/mcpServer/reload`、`mcpServer/oauth/login`、`mcpServerStatus/list`、`mcpServer/resource/read`、`mcpServer/event/stream/start|stop`、`mcpServer/tool/call` | common.rs |
| auth | `account/login/start|cancel`、`account/logout`、`account/read`、`account/rateLimits/read`、`account/usage/read`、`account/gatewayOAuth/*`、`account/bedrock/*`;遗留顶层名 `getAuthStatus`、`getConversationSummary`、`gitDiffToRemote`、`fuzzyFileSearch` 仍保留 | common.rs:1330-1490 |

**其余方法家族**(均出自 common.rs:498-1490):thread 生命周期与元数据(`thread/fork`、`thread/delete`、`thread/name/set`、`thread/goal/set|get|clear`、`thread/queue/add|list|update|delete|reorder|start`(排队 turn)、`thread/metadata/update`、`thread/attachment/add|list|remove`、`thread/settings/update`、`thread/memoryMode/set`、`thread/revert`、`thread/inject_items`、`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/search`、`thread/searchOccurrences`、`thread/compact/start`、`thread/shellCommand`、`thread/backgroundTerminals/list|clean|terminate`);历史(`thread/section/*`、`threadSection/*`、`project/*`);fs(`fs/readFile|writeFile|createDirectory|getMetadata|readDirectory|remove|copy|watch|unwatch`);进程与执行(`command/exec|write|terminate|resize`、`process/spawn|writeStdin|kill|resizePty`);技能与插件(`skills/list|extraRoots/set|config/write`、`plugin/*`、`marketplace/*`);配置(`config/read|value/write|batchWrite`、`modelProvider/capabilities/read`、`experimentalFeature/*`、`permissionProfile/list`、`collaborationMode/list`);其他(`review/start`、`feedback/upload`、`remoteControl/*`、`windowsSandbox/*`、`environment/add|info|status`、`externalAgentConfig/*`、`memory/status|reset`、`rollout/compress`、`server/diagnostics`、`userVerification/*`)。

**server→client 通知**:由 `server_notification_definitions!` 定义(common.rs:1916-2060,约 110 个方法)。**注意:没有 `codex/event/*` 前缀**——v2 采用域前缀命名。任务中旧事件名映射:`task_started`→`turn/started`+`thread/status/changed`;`agent_message_delta`→`item/agentMessage/delta`;`agent_reasoning_delta`→`item/reasoning/textDelta|summaryTextDelta|summaryPartAdded`;`token_count`→`thread/tokenUsage/updated`;`exec_command_begin/end`→`item/started`+`item/completed`(ThreadItem::CommandExecution);`exec_approval_request`→`item/commandExecution/requestApproval`(server request);`apply_patch_approval_request`→`item/fileChange/requestApproval`;`patch_apply_end`→`item/completed`(FileChange,`PatchApplyStatus::{InProgress,Completed,Failed,Declined}` item.rs:1155);`task_complete`→`turn/completed`;`error`→`error`。其余重要通知:`item/started|completed`、`turn/diff/updated`、`turn/plan/updated`、`command/exec/outputDelta`、`item/commandExecution/outputDelta`、`item/commandExecution/terminalInteraction`、`item/fileChange/patchUpdated`、`item/mcpToolCall/progress`、`serverRequest/resolved`、`thread/compacted`、`thread/queue/changed`、`fs/changed`、`account/rateLimits/updated`、`rawResponseItem/completed`+`rawResponse/completed`(实验)、realtime 系列、`warning|deprecationNotice|configWarning|guardianWarning`。client→server 通知仅一个:`initialized`(common.rs:2061)。

**统一流式单元是 Item**:`ThreadItem` 枚举(v2/item.rs:236)含 UserMessage、HookPrompt、AgentMessage、FunctionCallOutput、Plan、Reasoning、CommandExecution、FileChange、McpToolCall、DynamicToolCall、CollabAgentToolCall、SubAgentActivity、ImageView、EnteredReviewMode、ExitedReviewMode、ContextCompaction——16 种,比任务预设的"事件列表"抽象一级。

## 3. Approvals(execCommandApproval / applyPatchApproval)

**Exec 审批流程**:core 发出 `EventMsg::ExecApprovalRequest` → app-server 组装 `CommandExecutionRequestApprovalParams`(v2/item.rs:1544):`kind`(command|writeStdin,`CommandExecutionApprovalKind` item.rs:79)、`thread_id/turn_id/item_id`、`started_at_ms`(审批 UI 计时)、`approval_id`(zsh-exec-bridge 子命令/多个回调同属一个 itemId 时的路由 UUID)、`environment_id`、`reason`、`network_approval_context`、`command`、`cwd`、`command_actions`(解析后的动作,便于展示)、`additional_permissions`、`proposed_execpolicy_amendment`、`proposed_network_policy_amendments`、`available_decisions`(服务端声明的可选决策列表,实验特性)。经 `outgoing.send_request(ServerRequestPayload::CommandExecutionRequestApproval(params))` 发给 client,`(pending_request_id, rx)` 交给 `on_command_execution_request_approval_response` 异步等待(bespoke_event_handling.rs:785-814)。client 回 `CommandExecutionRequestApprovalResponse{decision}`(item.rs:1618)。

**决策枚举** `CommandExecutionApprovalDecision`(item.rs:66):`Accept`、`AcceptForSession`(写入会话级审批缓存,后续同类命令免提示)、`AcceptWithExecpolicyAmendment{execpolicy_amendment}`(持久化 execpolicy 规则)、`ApplyNetworkPolicyAmendment{network_policy_amendment}`(按 host 的 allow/deny 规则)、`Decline`(拒绝但 turn 继续)、`Cancel`(拒绝并立即中断 turn)。由 `From<CoreReviewDecision>` 映射(item.rs:87-110;`TimedOut→Decline`)。

**Client 能否修改命令?不能。** 响应只有 `{decision}`,源码中未找到任何"修改后命令"字段;最接近的"修改"能力是批准时附带 execpolicy/network policy amendment(改规则而非改命令)。

**FileChange 审批**:`item/fileChange/requestApproval`,`FileChangeRequestApprovalParams{thread_id,turn_id,item_id,started_at_ms,reason,grant_root}`(grant_root 为 UNSTABLE 的"本会话允许写该根"请求,item.rs:1624-1645);响应决策 `FileChangeApprovalDecision{Accept, AcceptForSession, Decline, Cancel}`(item.rs:115-127)。另有 `item/permissions/requestApproval`、`mcpServer/elicitation/request`、`item/tool/requestUserInput`(选择题式用户输入)。

**策略配置(每 thread + 每 turn 覆盖)**:`ThreadStartParams.approval_policy: Option<AskForApproval>`、`sandbox: Option<SandboxMode>`、`approvals_reviewer: Option<ApprovalsReviewer>`(v2/thread.rs:69-75);`TurnStartParams.approval_policy/sandbox_policy/permissions/approvals_reviewer` 可逐 turn 覆盖并对后续 turn 生效(v2/turn.rs:207-226)。`AskForApproval`:`untrusted`/`on-request`(默认,alias `on-failure`)/细粒度变体(protocol.rs:969-981);`SandboxMode`:`read-only`(默认)/`workspace-write`/`danger-full-access`(config_types.rs:104-112)。`approvals_reviewer` 可设为 `auto_review`(legacy 别名 `guardian_subagent`)——**服务端内部用一个 subagent 做风险决策再批准/拒绝**,即审批者可不在客户端(v2/shared.rs:237-261)。

## 4. Threads vs Conversations(命名/版本、fork、dynamic tools)

**命名与版本**:现行 API 一律 `thread.*`;旧版 `conversation.*`/`newConversation`/`sendUserTurn` 命名在本 checkout 源码中未找到(仅 `getConversationSummary`、`getAuthStatus`、`gitDiffToRemote`、`fuzzyFileSearch` 等无命名空间的顶层遗留方法保留在 client_request_definitions 尾部,common.rs:1330-1490)。版本化机制不是 v1/v2 两套 method 表:`protocol/v1.rs`(247 行)只承载 `initialize` 及共享类型,`v2/` 承载全部现代方法;实验面通过 `#[experimental("thread/start.dynamicTools")]` 属性标注 + `InitializeCapabilities.experimental_api` 协商门控,出站还有 `strip_experimental_fields()` 手工剥离(item.rs:1605)。`ClientRequestSerializationScope`(common.rs:129-160)按 Global/Thread 作用域做键控序列化,支持同 server 多 thread 并发。

**fork**:`thread/fork`(common.rs)。resume:`thread/resume` 支持 id 或 rollout 文件 `path`(实验 `thread/resume.path`,thread.rs:368);全量历史注入已废弃,改用 `thread/resume.initialTurnsPage` + `thread/turns/list` + `thread/items/list` 分页(thread.rs:421-428);另有 `thread/revert`。

**Dynamic tools / 客户端工具反转:支持,且与审批走同一条 JSON-RPC 通道。** 声明:`ThreadStartParams.dynamic_tools: Option<Vec<DynamicToolSpec>>`(thread.rs:145-150,配套 `DynamicToolNamespaceSpec/DynamicToolNamespaceTool` 命名空间,thread.rs:30-31)。调用:runtime 产生 `CoreTurnItem::DynamicToolCall` → app-server 发 `item/started` 通知 + **server→client request `item/tool/call`**(`DynamicToolCallParams{thread_id,turn_id,call_id,namespace,tool,arguments}`)→ `crate::dynamic_tools::on_call_response(call_id, rx, conversation)` 把客户端结果回灌 core(bespoke_event_handling.rs:1086-1115,973-974)。

**viewImage:core 内部工具,不可被客户端注册/回调。** `registry.add(ViewImageHandler::new(…))` 注册于 core 的 tool registry(`Feature::ViewImage` 门控,core/src/tools/spec_plan.rs:1230-1234);历史中以 `ViewImageToolCallEvent` 记录(thread_history.rs:386,888),客户端只见 `ImageView` item。

**ephemeral thread**:`ThreadStartParams.ephemeral`(thread.rs:120),配合 `thread/loaded/list` 管理活跃会话。

## 5. Usage & limits(tokenCount / rate_limits)

**推送**:每个 turn 推 `thread/tokenUsage/updated`,payload `ThreadTokenUsageUpdatedNotification{thread_id, turn_id, token_usage}`(v2/thread.rs:1855)。`ThreadTokenUsage{total: TokenUsageBreakdown, last: TokenUsageBreakdown, model_context_window: Option<i64>}`(thread.rs:1885-1896,`From<CoreTokenUsageInfo>`)。`TokenUsageBreakdown{total_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`(thread.rs:1913-1933)——即累计 + 最近一次 + 上下文窗口三分量,reasoning tokens 单列。内部实验通道 `rawResponse/completed` 附单次上游响应的精确 usage(`TokenUsageBreakdown` + `usage_metadata`,thread.rs:1864-1882)。

**拉取 + 推送双通道**:`account/rateLimits/read` 返回 `GetAccountRateLimitsResponse{rate_limits: RateLimitSnapshot, rate_limits_by_limit_id: Option<HashMap<…>>}`(v2/account.rs:331-338);变化时推 `account/rateLimits/updated`。`RateLimitSnapshot{limit_id, limit_name, normal_model_slug, primary: Option<RateLimitWindow>, secondary, credits, individual_limit, spend_control_reached, plan_type, rate_limit_reached_type}`(protocol.rs:2326-2340)——主/双窗口 + credits + spend control。另有 `account/usage/read`(GetAccountTokenUsage)、`account/rateLimitResetCredit/consume`。

## 6. App Server 不覆盖的部分(gaps)

对照"完整 runtime 协议"逐项核实(v2 其实比传闻覆盖广得多):

- **Compaction:已覆盖,但不可参数化。** `thread/compact/start` params 仅 `{thread_id}`(v2/thread.rs:1148-1153)+ 通知 `thread/compacted`;`ThreadItem::ContextCompaction` item 类型存在。client 无法传 compaction 提示词或策略;手动 `rollout/compress`、`memory/reset`、`thread/memoryMode/set` 属相邻能力。
- **Terminal:已覆盖且很全。** `command/exec`(+write/terminate/resize)、`process/spawn|writeStdin|kill|resizePty`(PTY resize!)、`thread/backgroundTerminals/list|clean|terminate`、`thread/shellCommand`(保 shell 语法、**不沙箱、全权限**、timeout_ms,thread.rs:1160-1172)、通知 `item/commandExecution/outputDelta` 与 `terminalInteraction`(向既有终端写 stdin 的交互事件,item.rs:1496)。
- **Background tasks:部分。** 只有 `thread/queue/*`(排队 turn,add/list/update/delete/reorder/start)与 backgroundTerminals;通用后台任务框架源码中未找到。
- **Subagents:无客户端编排 API,但有事件面。** `ThreadItem::SubAgentActivity`、`CollabAgentToolCall` item 类型(item.rs:236 区段)表明 subagent 活动作为 item 流出;`multiAgentMode` 字段已 deprecated("Use Ultra reasoning effort for proactive multi-agent behavior",thread.rs:110-111);`approvals_reviewer=auto_review` 是服务端内部 subagent(shared.rs:243-261);hooks 有 `subagent_start/subagent_stop` matcher(config.rs:618-621)。但客户端无法 spawn/配置 subagent——源码中未找到对应 method。
- **File-diff 粒度:文件级统一 diff。** `turn/diff/updated`、`item/fileChange/patchUpdated`(`FileUpdateChange{path, kind: Add|Delete|Update{move_path}, diff}` v2/item.rs:1135-1152);无 hunk 级流式、无客户端 apply/edit API。
- **Raw 模型流:默认隐藏。** 需 `thread/start.experimentalRawEvents=true`(内部用,thread.rs:163-165)才发 `rawResponseItem/completed`/`rawResponse/completed`;另有 `Feature::OmitAppServerNotificationMedia` 裁剪通知媒体(bespoke_event_handling.rs:1102-1105)。
- **其他不在范围内**:无 LLM sampling/completions 代理接口(纯 agent-session 协议);系统提示注入仅 `base_instructions/developer_instructions`(thread.rs:79-81);错误分类只有通用 `error`/`warning`/`configWarning`/`deprecationNotice`。

## 7. App Server 已解决 vs 未解决的 ARI 问题 + 可借鉴设计

**已解决(有源码证据)**:
1. 传输与帧:line-delimited JSON-RPC(stdio.rs:73,141)+ ws/uds/remote-control 变体,同一协议多传输。
2. 双向请求与 pending-request 路由:`send_request→(id, rx)`,Broadcast/ToConnection 信封(outgoing_message.rs:117,407)。
3. 能力协商:`initialize` + `experimental_api`/`opt_out_notification_methods`/`extensions`(v1.rs:55-75)。
4. wire 兼容演进:`#[experimental(...)]` 属性化标注 + 出站字段剥离,避免 schema 分叉(v2/thread.rs 各处;item.rs:1605)。
5. 审批闭环:decision-only 响应 + 会话级缓存(AcceptForSession)+ 规则修正作为一等决策(execpolicy/network amendment)+ 服务端声明 `available_decisions` + 可选机器审批者 auto_review。
6. 策略分层:thread 级默认 + turn 级覆盖(approval/sandbox/model/cwd 均可逐 turn 覆盖,turn.rs:207-230)。
7. client-tools 反转:dynamic tools 经同一 JSON-RPC 通道回调,无旁路协议。
8. usage/rate-limit 双通道(拉+推)与三级坐标事件封装(见下)。
9. 可恢复历史:rollout path + 分页(initialTurnsPage)替代全量 hydration。

**未解决 / 对 ARI 仍是开放问题**:客户端侧 subagent 编排(只有事件面);审批时修改命令本体;通用后台任务;可参数化 compaction;hunk 级文件编辑回调;结构化错误分类(仅 error/warning 族);多模态实时音频是独立子协议(thread/realtime/*),与文本 turn 模型不统一。

**值得 ARI 借鉴的设计**:
- **命名法**:`{domain}/{resource}/{action}` 与 `{domain}/{resource}/{subresource}/{action}`(thread/turn/start、item/commandExecution/requestApproval),通知用过去分词(updated/changed/completed),请求用动词原形——机器可推断方向性。
- **事件三级坐标**:几乎每个通知都带 `thread_id/turn_id/item_id`(如 ReasoningTextDeltaNotification,item.rs:1480-1490),把"会话/回合/原子项"作为关联键,ARI 的事件信封可直接采用。
- **item 即流式单元**:16 类 ThreadItem + item/started|completed 包夹 delta,替代按工具类型各设 begin/end 事件。
- **审批模式**:params 带 `started_at_ms`(UI 计时)、`reason`、`available_decisions`;响应是封闭枚举而非布尔;策略修正(amendment)是决策的一种,把"批准即授权范围调整"显式化。
- **client-tools 反转**:客户端注册工具声明(thread/start.dynamic_tools + namespace),runtime 用标准 request 回调——与审批同通道、同信封、同错误语义。
- **实验特性门控**:方法/字段级 opt-in + schema 导出(export.rs),为协议演进提供不出破坏性变更的路径。
- **客户端可控通知过滤**:opt_out_notification_methods 按方法名屏蔽,避免高流量通知压垮 UI。

## 8. Capability Matrix

| Session | Resume | Streaming | Cancellation | Approval | Tool events | File changes | Terminal | Background task | Parallel tools | Compaction | Subagent | Usage | Reasoning events | PTC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ✓ `thread/start` + `thread/started` | ✓ `thread/resume`(path + initialTurnsPage) | ✓ `item/*Delta` | ✓ `turn/interrupt` + Decline/Cancel | ✓ `item/*/requestApproval` 闭环 | ✓ `item/started/completed`+`item/mcpToolCall/progress` | ✓ `item/fileChange/patchUpdated`(FileUpdateChange) | ✓ `command/exec`+`process/*`+backgroundTerminals | partial `thread/queue/*` | partial(多 item 共享 turn_id;显式并行控制源码中未找到) | partial `thread/compact/start`(不可参数化) | partial(SubAgentActivity item;无编排 API) | ✓ `thread/tokenUsage/updated`+`account/rateLimits/*` | ✓ `item/reasoning/textDelta|summaryTextDelta|summaryPartAdded` | partial(dynamic tools 回调 + `app-server/src/code_mode_host.rs` code-mode host 集成;viewImage 为 core 内部工具) |
