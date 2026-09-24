# Codex CLI (codex-rs) Runtime/Protocol 内部深度调研 — ARI 设计参考

> 调研对象:OpenAI Codex CLI 的 Rust 实现(codex-rs),聚焦 CLI 自身的 runtime/loop/protocol 内部。
> 仓库:<local checkout>(HEAD `44b857c00e`,2026-09-22)。不含 app-server protocol(另行交叉引用)。
> 【source】= 源码证据(路径 + 符号);【docs】= 仓库文档。所有行号基于该 HEAD,可能与发布版有偏移。

## 0. 总览:crate 地图与三条"协议线"

调查基于 HEAD `44b857c00e`(2026-09-22)。codex-rs 是超大 workspace(~180 crates),与本报告相关的核心链路:

- **core**(codex-core):agent loop、Session/turn 状态机、工具路由(tools/router.rs)、审批(tools/approvals.rs)、压缩(compact*.rs)、子代理调度(agent/)。入口 `CodexThread::submit(Op)`/`next_event()`【core/src/codex_thread.rs:235,658】。
- **protocol**(codex-protocol):`Op`、`EventMsg`、`ResponseItem`(经 models.rs)、`AskForApproval`/`SandboxPolicy`/`ReviewDecision`、`SessionMeta` 等全部 wire 类型。
- **rollout**(codex-rollout)+ **history**:JSONL 持久化(recorder/state_db/reverse_jsonl_scanner)与 `RolloutItem`/`RolloutLine`/`InitialHistory` 定义。
- **三条协议线**:① core 事件流(in-process,TUI 直接消费);② `codex exec --json`(EventMsg→精简 ThreadEvent JSONL,单向);③ app-server(双向 JSON-RPC,v1/v2,TS 绑定生成)。**旧 `codex proto` 已不存在**。
- 其余周边:tools(ToolSpec/spec 编译)、codex-api(ResponseEvent/SSE)、rmcp-client+codex-mcp(MCP)、code-mode*(PTC/V8)、sandboxing+linux-sandbox+windows-sandbox-rs+execpolicy(沙箱)、thread-store/thread-manager(线程仓库)、tui(前端参考实现)。

注:本 HEAD 中不少旧文档词汇已改名——TaskStarted/TaskComplete→TurnStarted/TurnComplete(wire 名保留 task_*),UserTurn→TurnInput,OnFailure→OnRequest 别名,AgentMessageDelta→AgentMessageContentDelta,ReasoningDelta→ReasoningContentDelta。

## 1. Session:创建 / resume / 持久化 / fork / 中断

**存储**:每个 thread 一个 JSONL 文件,目录布局 `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`【rollout/src/list.rs:437 doc;常量 `SESSIONS_SUBDIR="sessions"`、`ARCHIVED_SESSIONS_SUBDIR="archived_sessions"`,rollout/src/lib.rs:84-85】。另有 SQLite 索引/状态库【rollout/src/state_db.rs:47 `try_init_with_roots`】与反向 JSONL 扫描器(从尾部读)【rollout/src/reverse_jsonl_scanner.rs】。

**行格式**:`RolloutLine { timestamp: String, ordinal: Option<u64>, #[serde(flatten)] item: RolloutItem }`【history/src/lib.rs:302-308】。注释明确:RolloutLine 不实现 Deserialize,读方必须走 codex_rollout 的 canonical parser 以保住嵌套小数(lib.rs:297-300)。`RolloutItem` 变体【lib.rs:159-175】:SessionMeta / ResponseItem(ResponseItemEnvelope)/ InterAgentCommunication(_Metadata)/ Compacted(CompactedItem)/ TurnContext / TokenUsageRecord / WorldState / SecurityRiskScore / RetainedContext / EventMsg / RealtimeItem。写入端:`RolloutRecorder::record_canonical_items`、`flush`、`append_rollout_item_to_path`【rollout/src/recorder.rs:1035,1074,2005】;`RolloutRecorder::resume(path)` 重新打开已有文件续写(recorder.rs:365)。

**会话身份**:`SessionMeta`【protocol/src/protocol.rs:3100-3175】:`session_id: SessionId` 恒等于根 thread ID;`id: ThreadId` 为 UUIDv7【protocol/src/thread_id.rs:30 `Uuid::now_v7()`】;`forked_from_id`、`forked_from_ordinal_exclusive`、`parent_thread_id`(子代理归属)、`agent_nickname/agent_role/agent_path`(AgentControl 子代理)、`base_instructions`、`dynamic_tools`、`history_base`、`subagent_history_start_ordinal`、`multi_agent_version`、`context_window`。

**resume**:`codex resume [SESSION_ID|--last|--all|--include-non-interactive]`(默认 picker)【cli/src/main.rs:202-203,350,`finalize_resume_interactive`:2557】。核心路径:`ThreadManager::resume_thread_from_rollout`【core/src/thread_manager.rs:1195】→ `initial_history_from_rollout_path` → `resume_thread_with_history`(:1252)→ `spawn_thread`,把 `InitialHistory::Resumed(ResumedHistory{conversation_id, history, rollout_path})` 注入 StartThreadOptions【history/src/lib.rs:311-323】。resume 还能从 `CompactedItem.latest_token_usage_record` 恢复 token 用量而无需任意回扫【lib.rs:242-246 doc】。

**fork**:`codex fork [SESSION_ID|--last]`(main.rs:220,`finalize_fork_interactive`:2592;`--worktree` 需显式 session id,main.rs:2181)。核心:`fork_thread`/`fork_thread_from_history`/`fork_prepared_thread`/`fork_internal_session`【thread_manager.rs:1423,1457,1478,1062】,内部 `start_thread_inner(options, Some(forked_from_thread_id))`(:1191)。语义 = `InitialHistory::Forked(Vec<RolloutItem>)` + 新 ThreadId + `SessionMeta.forked_from_id`(`InitialHistory::forked_from_id`,lib.rs:334)。

**crash recovery**:基于 append-only JSONL + `recorder.resume(path)` 续写 + 反向扫描器尾部恢复;CLI 的 fatal exit 消息直接打印 `codex resume <uuid>` 提示【cli/src/main.rs:3790 附近 exit message 逻辑;utils/cli/src/resume_command.rs:6 `resume_command` 生成提示】;另有 cli/src/state_db_recovery.rs 处理状态库恢复。`InitialHistory::Cleared` 支持清空后延续同一 thread(lib.rs:318-323)。

## 2. 消息模型:三层类型体系(ResponseItem / ResponseEvent / EventMsg)

Codex 把"消息"分为三层,逐层收敛:

1. **`ResponseItem`**【protocol/src/models.rs:1011 `pub enum ResponseItem`】——模型 wire 协议条目(message / function_call / function_call_output / reasoning / custom_tool_call(_output) / local_shell_call 等),既是发给模型的 input,也是 rollout 的记录单元。
2. **`ResponseEvent`**【codex-rs/codex-api/src/common.rs:80 `pub enum ResponseEvent`】——模型 SSE 流解码后的内部事件(仅 core 消费)。
3. **`EventMsg`**【protocol/src/protocol.rs:1341】——面向客户端的稳定事件枚举;core/src/event_mapping.rs 负责内部状态 → EventMsg 的映射与广播。

### EventMsg 变体全表(protocol.rs:1341-1558,serde snake_case tag)

**生命周期**:`Error(ErrorEvent)` submission 执行错误;`Warning` 警告(turn 继续);`TurnStarted`(serde rename `task_started`, alias `turn_started`)turn 开始;`TurnComplete`(`task_complete`)所有动作完成;`TurnAborted` 中断;`ShutdownComplete`;`SessionConfigured` ack;`ThreadSettingsApplied` 线程配置覆盖已生效;`DeprecationNotice`。

**模型输出流**:`AgentMessage` 完整消息;`AgentMessageContentDelta` 增量文本(注意:旧名 AgentMessageDelta 已演化为该变体);`AgentReasoning` reasoning summary;`AgentReasoningRawContent` 原始 CoT;`AgentReasoningSectionBreak` 新 reasoning 段落;`ReasoningContentDelta`/`ReasoningRawContentDelta` reasoning 增量;`PlanDelta`/`PlanUpdate(UpdatePlanArgs)` 计划;`ItemStarted`/`ItemCompleted` 通用 item 生命周期;`RawResponseItem`/`RawResponseCompleted` 原始响应条目透传。

**命令执行**:`ExecCommandBegin` 即将执行命令;`ExecCommandOutputDelta` 运行中输出增量块;`TerminalInteraction` 向运行中命令写 stdin 并观测 stdout;`ExecCommandEnd`;`ViewImageToolCall` view_image 附加本地图片。

**文件补丁**:`ApplyPatchApprovalRequest` patch 审批请求;`PatchApplyBegin` 即将打补丁(镜像 ExecCommandBegin 供前端显示进度);`PatchApplyUpdated` 模型生成的最新结构化变更;`PatchApplyEnd` 完成;`TurnDiff` 整个 turn 的 diff。

**审批/输入请求**:`ExecApprovalRequest` 命令审批;`RequestPermissions` 权限请求;`RequestUserInput` 结构化用户输入;`ElicitationRequest` MCP elicitation;`DynamicToolCallRequest`/`DynamicToolCallResponse` 动态工具回调;`GuardianAssessment` guardian 自动审批评审的结构化生命周期;`GuardianWarning`。

**MCP/搜索/生成**:`McpStartupUpdate`/`McpStartupComplete` MCP 启动进度;`McpToolCallBegin`/`McpToolCallEnd`;`WebSearchBegin`/`WebSearchEnd`;`ImageGenerationBegin`/`ImageGenerationEnd`。

**用量/上下文**:`TokenCount(TokenCountEvent)` 会话用量更新(可选=未知,UI 不应显示);`ContextCompacted` 历史被压缩(自动或手动);`ThreadRolledBack` 丢弃最近 N 个 user turn 的 legacy 持久化标记(仅用于旧 rollout 回放)。

**多代理**:`CollabAgentSpawnBegin/End`、`CollabAgentInteractionBegin/End`、`CollabWaitingBegin/End`、`CollabCloseBegin/End`、`CollabResumeBegin/End`(collab 交互);`SubAgentActivity` path-based v2 子代理活动;`HookStarted`/`HookCompleted` 生命周期 hook。

**其他**:`StreamError` 模型流出错/断连、系统正在处理(如 backoff 重试);`ModelReroute` 模型路由被改;`ModelVerification` 后端要求额外账号验证;`TurnModerationMetadata`/`SafetyBuffering` 安全审核元数据与缓冲;`AuthRecoveryStarted/Completed` 认证恢复;`EnvironmentConnected/Disconnected` 环境连接握手;`ThreadGoalUpdated`/`ThreadQueueChanged` 目标与队列;`McpStartupUpdate` 等;`RealtimeConversation*`(Started/Realtime/Closed/Sdp/ListVoicesResponse)语音会话;`EnteredReviewMode`/`ExitedReviewMode` review 模式。

> 词汇演化:任务期文档中的 TaskStarted/TaskComplete、AgentMessageDelta、AgentReasoningDelta 在本 HEAD 分别对应 TurnStarted/TurnComplete(wire 名仍为 task_started/task_complete)、AgentMessageContentDelta、ReasoningContentDelta。

## 3. Agent Loop:turn 入口、模型流、工具分发、重试、中断

**提交入口**:`CodexThread::submit(op: Op) -> CodexResult<String>` 返回 submission id【core/src/codex_thread.rs:235 → io.submit;旧版 Submission{id,op} 包装已不存在,Op 直提交】。Op 由 SessionIo/handlers 分发【core/src/session/handlers.rs:427 `Op::Interrupt`】。

**Task 层**:`TaskKind { Regular, Review, Compact }`【core/src/state/turn.rs:68】;任务实现 `RegularTask`/`ReviewTask`/`CompactTask`/`UserShellCommandTask`【core/src/tasks/mod.rs:62-67】。`RunningTask { kind, task, cancellation_token: CancellationToken, handle: AbortOnDropHandle, turn_context }`【state/turn.rs:74-85】——每个 turn 一个 CancellationToken。

**turn 入口**:`run_turn(sess, turn_context, input, …, cancellation_token)`【core/src/session/turn.rs:163】:guardian pending-input 检查(:171)→ `run_pre_sampling_compact` 采样前预压缩(:183,失败会先记录用户输入再报错)→ `required_mcp_servers_for_input` 按需启动 MCP(:235)→ `build_prompt`(:1555)→ `run_sampling_request`(:1584)。

**采样循环**:`try_run_sampling_request`【turn.rs:2448】:`client_session.stream(...).or_cancel(&cancellation_token)`(:2484-2501);`loop { stream.next() }` 消费 `ResponseEvent`:Created{response_id} 记录 response id(:2575);OutputItemDone(item) → `handle_output_item_done`(:2672)返回 `output_result.tool_future` → `in_flight.push_back(tool_future)`(:2679-2681)。**并行工具调用**:`let mut in_flight: FuturesOrdered<InFlightFuture>`【turn.rs:2502】——同一响应内的多个 function_call 并发执行,循环尾部 drain;`needs_follow_up` 标志决定是否再发起下一轮采样(:2685)。assistant Commentary 消息或 Reasoning item 可抢占等待中的 mailbox 输入(`preempt_for_mailbox_mail`,:2648-2669)。流关闭而无 response.completed → `CodexErr::Stream`(:2562-2566)。

**工具分发**:`ToolRouter::dispatch_tool_call_with_state` / `dispatch_tool_call_with_code_mode_result`【core/src/tools/router.rs:323,300】;审批拒绝 `ReviewDecision::Abort → ToolError::Codex(CodexErr::TurnAborted)`【core/src/tools/approvals.rs:467】。`TurnState.tool_calls` 计数【state/turn.rs:99】。

**重试(backoff)**:`core/src/responses_retry.rs`:常量 `INITIAL_CONNECTION_RETRY_DELAY=5s`、`MAX_CONNECTION_RETRY_DELAY=60s`(:16-17),`max_retries: u64`(:52),日志 "stream disconnected - retrying sampling request ({retries}/{max_retries} in {delay:?})"(:163)。重试期间发 `EventMsg::StreamError`(doc:"retrying with backoff",protocol.rs:1490-1492)。backoff 工具已移至 codex-async-utils crate【core/src/util.rs:1 `pub use codex_async_utils::backoff`】。

**中断**:客户端提交 `Op::Interrupt`(handlers.rs:427;doc:响应 EventMsg::TurnAborted,protocol.rs:586)。循环内每个 await `.or_cancel(&cancellation_token)`,取消 → `CodexErr::TurnAborted`(turn.rs:2554-2555)。`TurnAbortReason { Interrupted, Replaced, ReviewEnded, BudgetLimited }`【protocol.rs:4253-4258】;`abort_turn_if_active(turn_id, reason)`【tasks/mod.rs:566】,先 flush interrupted-turn 历史标记再发 TurnAborted 事件(tasks/mod.rs:962-989 注释:部分客户端依赖顺序)。宽限 `GRACEFULL_INTERRUPTION_TIMEOUT_MS=100`【tasks/mod.rs:69】。TUI ESC 键位绑定:源码中未找到(tui 层未验证)。

**max turns / token budget**:`max_turns` 限制:源码中未找到。预算中止走 `TurnAbortReason::BudgetLimited`【protocol.rs:4257】,由后端上报的 `usage.codex_rollout_budget_units` 判定耗尽【core/src/rollout_budget.rs:47-56 `RolloutBudgetReminder`】;compaction 另有独立 token 预算【core/src/compact_token_budget.rs】。

## 4. Tool Runtime:工具抽象、注册、调用与产物

**工具规格**:`ToolSpec`【tools/src/tool_spec.rs:22-56,serde tag="type"】:`Function(ResponsesApiTool)`、`Namespace(ResponsesApiNamespace)`(工具命名空间,默认 namespace 常量 `DEFAULT_FUNCTION_NAMESPACE="functions"`,protocol/src/tool_name.rs:7)、`ToolSearch{execution, description, parameters}`(工具检索,名 "tool_search")、`WebSearch{external_web_access, indexed_web_access, filters, user_location, search_context_size, …}`、`Freeform(FreeformTool)`(custom/自由格式)。`create_tools_json_for_responses_api` 生成 Responses API Tool 数组(tool_spec.rs:82)。

**内置工具处理器**(core/src/tools/handlers/):shell(shell.rs + shell_spec.rs)、unified_exec(unified_exec/ —— 持久化 shell 会话)、apply_patch、view_image、web_search(core/src/web_search.rs)、tool_search、plan(update_plan)、current_time、sleep、request_user_input、request_permissions、send_message_to_user、dynamic(动态注册工具)、extension_tools、mcp_resource、mcp(MCP 工具调用)、multi_agents + multi_agents_v2(collab 子代理工具)、get_context_remaining、new_context_window、wait_for_environment、request_plugin_install。运行时组织:core/src/tools/registry.rs(注册表)、router.rs(分发)、orchestrator.rs、parallel.rs、runtimes/。

**调用/输出条目**(`ResponseItem`,protocol/src/models.rs:1011-1230):`FunctionCall{id, name, namespace, arguments:String(JSON 字符串), encrypted_function_args, call_id}`(:1073-1092);`FunctionCallOutput{call_id, name, namespace, output: FunctionCallOutputPayload}`(:1113-1132,payload 可为纯文本 content 或结构化 content_items,注释 :1108-1112);`CustomToolCall{call_id, name, input}` / `CustomToolCallOutput{call_id, output}`(:1133-1168,freeform 工具);`LocalShellCall{call_id, status, action}`(:1060);`ToolSearchCall/ToolSearchOutput`(:1093,1169);`WebSearchCall{id, status, action{type:"search",query}}`(:1190,由 Responses API 直接触发);`ImageGenerationCall`(:1213);`Reasoning{summary, content, encrypted_content}`(:1047);`Message{role, content, phase(commentary/final_answer), …}`(:1020);`AgentMessage{author, recipient, content}`(多代理间消息,:1036);`Compaction`/`ContextCompaction`/`CompactionTrigger`/`ConfigurationUpdate`/`AdditionalTools`/`Other`。call_id 即工具调用关联键,FunctionCallOutput 用 call_id 回填。

**MCP 集成**:MCP 客户端为独立 crate codex-rs/rmcp-client(基于 rmcp);连接管理在 codex-mcp crate(mcp_connection_manager.rs,AGENTS.md 指明工具与调用变更入口);启动进度经 `EventMsg::McpStartupUpdate/Complete` 上报,工具调用经 `McpToolCallBegin/End` 事件(core/src/mcp_tool_call.rs);审批走 ExecApprovalRequest + `mcp_tool_approval_templates.rs`(protocol/src/);elicitation → `Op::ResolveElicitation`。工具发现/暴露:core/src/mcp_tool_exposure.rs、tools/src/tool_discovery.rs;tools/src/mcp_tool.rs 为 MCP 工具的 ToolSpec 适配。

## 5. Human-in-the-loop:审批策略、沙箱与升级

**审批策略**:`AskForApproval`【protocol/src/protocol.rs:969-992,kebab-case serde】:`UnlessTrusted`(serde `untrusted`,untrusted 项目默认需批准,除非 execpolicy 规则放行)、`OnRequest`(#[default],由模型决定何时询问;`#[serde(alias = "on-failure")]` —— 旧 OnFailure 已并为其别名,源码中未找到独立 OnFailure 变体)、`Granular(GranularApprovalConfig)`(细粒度开关:sandbox_approval / rules / skill_approval / request_permissions / mcp_elicitations,protocol.rs:995-1009)、`Never`(失败直接返回给模型,不升级)。

**沙箱策略**:`SandboxPolicy`【protocol.rs:1055-1103,serde tag="type",kebab-case】:`danger-full-access`、`read-only{network_access}`、`external-sandbox{network_access}`(宿主已在外部沙箱,允许全盘读 + 指定网络)、`workspace-write{writable_roots, network_access, exclude_tmpdir_env_var, exclude_slash_tmp}`。辅助层:`SandboxMode { ReadOnly | WorkspaceWrite | DangerFullAccess }`(kebab-case)【protocol/src/config_types.rs:104-114】;`WritableRoot { root, read_only_subpaths, protected_metadata_names }` 阻止写 `.git/hooks`、`.codex` 等可提权路径【protocol.rs:1111-1156】;`NetworkAccess { Restricted, Enabled }`(protocol.rs:1039)。平台实现:codex-rs/sandboxing(landlock/seatbelt 经 manager.rs/policy_transforms.rs)、linux-sandbox、windows-sandbox-rs、bwrap、execpolicy、shell-escalation 各自成 crate。

**escalation 请求流**:
1. 工具执行前,`Session::request_command_approval`(【core/src/session/mod.rs:2866-2887】):先把 `tx_approve: oneshot::Sender` 插入 `active_turn.turn_state.pending_approvals`(state/turn.rs:90 `HashMap<String, oneshot::Sender<ReviewDecision>>`),再发 `EventMsg::ExecApprovalRequest(ExecApprovalRequestEvent{call_id, approval_id, turn_id, command, cwd, reason, kind, network_approval_context, proposed_execpolicy_amendment, proposed_network_policy_amendments, additional_permissions, available_decisions, parsed_cmd, model_context, …})`,然后 `rx_approve.await.unwrap_or(ReviewDecision::Abort)`(mod.rs:2887)——客户端不答视为 Abort。
2. patch 同构:`request_patch_approval` → `ApplyPatchApprovalRequest{call_id, changes: HashMap<PathBuf, FileChange>, reason, grant_root}`(mod.rs:2894-2930)。
3. **决策返回**:客户端提交 `Op::ExecApproval { id(approval_id), turn_id, decision: ReviewDecision }`【protocol.rs:655-662】→ handlers.rs:529 → `exec_approval()`【handlers.rs:173-202】:ApprovedExecpolicyAmendment 先 `persist_execpolicy_amendment`;`ReviewDecision::Abort` → `sess.interrupt_task()`(turn 级中止);其余 → `sess.notify_approval(&approval_id, decision)` 唤醒 pending oneshot。`Op::PatchApproval` 同路(handlers.rs:537-540, 204-211)。

**决策枚举**:`ReviewDecision`【protocol.rs:4136-4171,snake_case】:`Approved`、`ApprovedExecpolicyAmendment{proposed_execpolicy_amendment}`、`ApprovedForSession`(会话级审批缓存)、`ApprovedMcpPolicyAmendment`、`NetworkPolicyAmendment{network_policy_amendment}`(按 host 持久 allow/deny)、`Denied{rejection}`(拒绝但会话继续)、`TimedOut`(自动审批评审超时)、`Abort`(拒绝并停止直到下一条用户命令)。Default = Denied。Guardian 自动审批评审可产生 GuardianAssessment 事件,用户可用 `Op::ApproveGuardianDeniedAction` 覆盖一次拒绝(protocol.rs:734)。

## 6. File/Diff:文件变更如何到达客户端

**变更单元**:`FileChange`【protocol/src/protocol.rs:4212-4223】:`Add{content}` / `Delete{content}` / `Update{unified_diff, move_path}`;以 `HashMap<PathBuf, FileChange>` 出现在 `ApplyPatchApprovalRequestEvent.changes`(审批预览,mod.rs:2898)与 `PatchApplyBeginEvent/EndEvent.changes`。补丁生命周期:`PatchApplyBegin`(即将应用)→ `PatchApplyUpdated`(模型生成的最新结构化变更,可多次)→ `PatchApplyEnd{call_id, turn_id, stdout, stderr, success, changes, status: Completed|Failed|Declined}`【protocol.rs:3721-3747】。Declined 状态 = 审批拒绝后的显式闭环。turn 级汇总:`TurnDiffEvent { unified_diff: String }`【protocol.rs:3750-3752】,由 core/src/turn_diff_tracker.rs 聚合(§3 采样循环中 `should_emit_turn_diff` 控制)。`exec` JSONL 协议里对应 FileChangeItem/FileUpdateChange(exec_events.rs)。apply_patch 的实现与 spec 独立成 crate:codex-rs/apply-patch(core/src/apply_patch.rs + handlers/apply_patch_spec.rs)。

## 7. Command/Terminal:exec 事件流与后台命令

**事件字段**:`ExecCommandBeginEvent { call_id, turn_id, command: Vec<String>, cwd: PathUri, parsed_cmd: Vec<ParsedCommand>, source: ExecCommandSource(默认 Agent), process_id(PTY 进程标识), plugin_id/script_path(插件溯源), interaction_input(unified exec 交互输入), started_at_ms }`【protocol.rs:3539-3570】;`ExecCommandEndEvent { call_id, completed_at_ms, …exit code/时长 }`(:3573-)。增量输出走 `ExecCommandOutputDelta`(3643,按块)。

**交互与后台**:`TerminalInteractionEvent` = 向运行中命令写 stdin 并观测 stdout(protocol.rs:1461-1462);unified_exec 处理器(core/src/unified_exec/,tools/handlers/unified_exec/)维护持久化 PTY 会话,`process_id` 关联底层进程。后台终端进程在 turn 中断时**不会**被终止——`Op::Interrupt` doc 明确"without terminating background terminal processes",需显式 `Op::CleanBackgroundTerminals`【protocol.rs:585-591】;查询接口 `list_background_terminals`【tasks/mod.rs:782,遥测 TURN_UNIFIED_EXEC_RUNNING_PROCESSES_METRIC】;codex_thread.rs:27 引 `BackgroundTerminalInfo`。用户直连 shell:`Op::RunUserShellCommand{command, timeout_ms}`("!"前缀,默认 1h,输出同样走 ExecCommand* 事件、结束发 TurnComplete)【protocol.rs:744-749;tasks/user_shell.rs UserShellCommandTask/Mode】。

## 8. Context 管理:compaction、截断与 rollout 恢复

**阈值判定**:`ContextWindowTokenStatus`【core/src/session/context_window.rs:8-20】:`active_context_tokens`(会话总 token)、`auto_compact_scope_limit`(= config `model_auto_compact_token_limit` 或 `model_info.auto_compact_token_limit()`;scope 可为 `Total` 或 `BodyAfterPrefix`——只统计初始前缀之后的增量,:61-81)、`full_context_window_limit = resolved_context_window × effective_context_window_percent / 100`(:84-86,百分比缓冲)、`token_limit_reached`、`turn_end_compaction_threshold_reached`(turn 结束时也检查)。上下文窗口来源:`Config.model_context_window` 覆盖(clamp 到模型上限,models-manager/src/model_info.rs:20、model_info_tests.rs:251),否则用模型元数据。

**触发路径**:`run_pre_sampling_compact`【core/src/session/turn.rs:1271-1300】在 turn 入口(run_turn 之前)调用:先 `maybe_run_previous_model_inline_compact`(:1339——模型切换时 comp_hash 变化或新窗口更小则对旧模型做收尾压缩),再查 `token_status.token_limit_reached` → `run_auto_compact(reason=ContextLimit, phase=PreTurn)`(:1288-1297)。

**压缩实现**:`run_auto_compact`【turn.rs:1443-1501】三分支:① Feature::TokenBudget → `compact_token_budget::run_inline_auto_compact_task`;② provider 支持 RemoteCompaction::V2 → `run_inline_remote_auto_compact_task_v2`(服务端压缩);③ 否则本地 `run_inline_auto_compact_task`(core/src/compact.rs:114-144)——用 `SUMMARIZATION_PROMPT` 或 config `compact_prompt` 作为输入起一个 compact task。手动触发:`Op::Compact` → `run_compact_task`(trigger=Manual,reason=UserRequested,phase=StandaloneTurn,先 emit_turn_started,compact.rs:146-163)。压缩任务有 PreCompact/PostCompact hooks(`run_pre_compact_hooks`,Stopped → CodexErr::TurnAborted,compact.rs:185-200)与 `CompactionTrigger/Reason/Phase/Implementation` 元数据;独立 token 预算【core/src/compact_token_budget.rs】。

**结果与多窗口**:产物为 `CompactedItem { message, replacement_history, window_number/first_window_id/previous_window_id/window_id, compaction_response_id, latest_token_usage_record, guardian_history, retained_context, mcp_resource_origins }`【history/src/lib.rs:230-247】——window id 链支持分页历史(ThreadHistoryMode::Paginated,protocol.rs:762-766); Responses API 侧有 `ContextCompaction`/`Compaction`/`CompactionTrigger` ResponseItem 变体。事件:`EventMsg::ContextCompacted`(protocol.rs:1383);专用工具 `get_context_remaining`(剩余配额)与 `new_context_window`(重开窗口,handlers/ 目录)。

**截断/恢复**:rollout 侧 thread_rollout_truncation.rs + 反向扫描器支持截断恢复;`ThreadRolledBack` 为 legacy 回放标记(live rollback 不支持,protocol.rs:1385-1387);resume 时历史由 `RolloutItem` 全量重建(含 Compacted/EventMsg/TokenUsageRecord,见 §1)。

## 9. PTC(programmatic tool calling):Code Mode

**存在**。实现为独立的 code-mode crate 族:codex-rs/code-mode(会话:grpc_session / remote_session)、code-mode-runtime(cell_actor / session_runtime / service.rs / **v8_init.rs** —— V8 JS 运行时)、code-mode-protocol、code-mode-host、code-mode-protocol-noop-macros,外加 v8-poc 原型目录。

**机制**:把工具 spec 增强(augment)后注入代码运行时——`augment_tool_spec_for_code_mode`【tools/src/code_mode.rs:7-40】为 Function/Freeform/Namespace 工具附加 code-mode exec 样例描述并生成嵌套调用名;code-mode-protocol 提供 `render_json_schema_to_typescript`(把工具 JSON Schema 转成 TS 声明供模型写代码)、`CODE_MODE_PRAGMA_PREFIX`、`CodeModeNestedToolCall`、`DEFAULT_EXEC_YIELD_TIME_MS`/`DEFAULT_MAX_OUTPUT_TOKENS_PER_EXEC_CALL`【code-mode-protocol/src/lib.rs 导出表】。模型用一次 exec 调用提交 JS 代码,运行时执行并在 yield 点向宿主发起嵌套工具调用,由 core 的 `ToolRouter::dispatch_tool_call_with_code_mode_result`【core/src/tools/router.rs:300,346】路由回真实工具。即:**Codex 的 PTC = "工具 JS/TS 化 + V8 代码执行 + 嵌套工具调用回环"**,由 feature flag 与 provider 能力门控(core/tests/suite/code_mode.rs 存在端到端测试)。

## 10. Subagents:collab / multi-agent

**原生存在,两代实现**。事件面:`EventMsg::CollabAgentSpawnBegin/End`、`CollabAgentInteractionBegin/End`、`CollabWaitingBegin/End`、`CollabCloseBegin/End`、`CollabResumeBegin/End` + v2 的 `SubAgentActivity`【protocol/src/protocol.rs:1535-1557】。

**工具集**【core/src/tools/handlers/multi_agents_spec.rs】:`spawn_agent`(v1/v2,带 model/agent_type/reasoning/fork_turns=none|all 选项,输出 agent thread id + user-facing nickname + canonical task name 如 `/root/task1/task_3`;v2 描述明确"spawned agent 与你有相同工具且可继续 spawn 子代理",:761-768)、`send_message`(:185-203)、`resume_agent`(:246-263,复活已 close 的 agent)、`wait_agent`(v1:等指定 agent 完成并取结果;v2:mailbox 更新摘要 + 支持用户输入抢占,:287)、`close_agent`(:317-328,级联关闭后代)、按 id/task-name interrupt。多代并发限制与调度在 core/src/agent/(control.rs AgentControl、status.rs、communication)。

**会话侧**:子代理是真实 thread——SessionMeta 记录 `parent_thread_id`、`agent_nickname/agent_role/agent_path`、`subagent_history_start_ordinal`(继承父上下文但项目自己的历史)、`multi_agent_version`【protocol.rs:3100-3175】;InterAgentCommunication 成为 Op 与 RolloutItem(protocol.rs:790-806,记录 agent 间消息历史,trigger_turn 决定是否触发收件方 turn);resume 父线程后可 `ensure_multi_agent_v2_child_loaded` 重载子线程【thread_manager.rs:1218-1249】。InterAgentCommunicationMetadata 记录 trigger_turn。

## 11. Streaming:turn 期间客户端看到什么 + Usage/Reasoning 事件

**时序**(一次普通 turn,客户端通过 next_event/事件流看到):`TurnStarted`(wire 名 task_started,含 model_context_window、collaboration_mode 等,docs/protocol_v1.md:80)→ [若压缩] `ContextCompacted` → 流式输出:`AgentMessageContentDelta`(正文增量)/`AgentReasoning`/`ReasoningContentDelta`/`ReasoningRawContentDelta`/`AgentReasoningSectionBreak`(reasoning 分段)/`PlanDelta`/`ItemStarted`→`ItemCompleted`(通用 item 生命周期)/`RawResponseItem`(透传)→ 工具期:`ExecCommandBegin`→`ExecCommandOutputDelta`*→`ExecCommandEnd`、`PatchApplyBegin/Updated/End`、`McpToolCallBegin/End`、`WebSearchBegin/End`、`ViewImageToolCall`、审批请求 → `TokenCount`(每次 usage 更新,`should_emit_token_count` 由采样循环控制,turn.rs:2511)→ `TurnDiff`(turn 级文件变更汇总,turn_diff_tracker.rs)→ `TurnComplete`(或 `TurnAborted`/`Error`)。Commentary 相位的 assistant 消息支持抢占 mailbox 队列(§3)。

**TokenCount 载荷**:`TokenCountEvent { info: Option<TokenUsageInfo>, rate_limits: Option<RateLimitSnapshot> }`【protocol.rs:2320-2323;doc:Optional=未知,UI 不应显示】。`TokenUsageInfo { total_token_usage, last_token_usage, model_context_window }`【protocol.rs:2253-2259】(TokenUsage 含 input/cached_input/cache_write_input/output/reasoning_output/total,tasks/mod.rs:726-771 的遥测字段清单可佐证)。`RateLimitSnapshot { primary, secondary: RateLimitWindow{used_percent, window_minutes, resets_at}, credits, plan_type, rate_limit_reached_type, spend_control_reached, … }`【protocol.rs:2326-2351,2369-2378】。`fill_to_context_window`(:2293)把压缩后余量折算为占满窗口的用量。

**Reasoning 侧**:模型产出 `ResponseItem::Reasoning{summary, content, encrypted_content}`(models.rs:1047-1059;encrypted_content 供 Zero-Data Retention 回放);流式 delta 为 `ReasoningContentDelta`/`ReasoningRawContentDelta`;`AgentReasoning*` 事件族为 summary 呈现。ConcurrentReasoningSummaries feature(turn.rs:2479-2483)允许 summary 与正文并发流出。

**持久化**:TokenUsageRecord 是独立 RolloutItem(lib.rs:168),resume 可从 CompactedItem.latest_token_usage_record 恢复累计用量(§1)。

## 12. Transport:CLI 作为程序的事件出口(stdio / exec JSONL / proto)

**core 事件出口**:`Session` 持有 `async_channel::unbounded()` 事件通道【core/src/session/mod.rs:590 `let (tx_event, rx_event) = async_channel::unbounded();`;发送点 :2585 `tx_event.send(event)`;`Event { id: String(submission/turn id), msg: EventMsg }`】。对外 API:`CodexThread::next_event() -> CodexResult<Event>`【core/src/codex_thread.rs:658】+ `submit(Op) -> CodexResult<String>`(:235)。这就是 core 的"客户端协议":Op 提交 / Event 流式回包。

**TUI**:进程内直连——`tui::Tui` 用 `TuiEventStream`/`EventBroker` 包装 core 事件流【tui/src/tui.rs:55-56,943 `pub fn event_stream(&self) -> Pin<Box<dyn Stream<Item = TuiEvent>>>`;断线恢复 `resume_events` tui.rs:820】。无 IPC 序列化,直接消费 EventMsg。

**`codex exec --json`(JSONL 模式)**:`codex exec` 非交互模式,stdout 按行输出 JSON 事件——`EventProcessorWithJsonOutput` 把 core `EventMsg` 映射为更精简的 `ThreadEvent` 序列【exec/src/event_processor_with_jsonl_output.rs:59-80;事件类型 exec/src/exec_events.rs:ThreadStartedEvent / ItemStartedEvent / ItemUpdatedEvent / ItemCompletedEvent / TurnStartedEvent / TurnCompletedEvent / TurnFailedEvent / ThreadErrorEvent / Usage;item 类型:AgentMessageItem / ReasoningItem / CommandExecutionItem / FileChangeItem / McpToolCallItem / PatchApplyStatus+PatchChangeKind / WebSearchItem / TodoListItem / CollabToolCallItem】。另有 EventProcessorWithHumanOutput(人类可读)。即:**CLI 的 JSON 事件协议出口 = `codex exec --json`,而不是旧版 `codex proto`** —— proto 子命令在本 HEAD:源码中未找到。

**app-server(JSON-RPC)**:`codex app-server`【cli/src/main.rs:169-172 "[experimental] Run the app server"】+ app-server-daemon(远控)。协议在 codex-rs/app-server-protocol:v1 与 v2 两版,v2 规范(camelCase wire、`*Params/*Response/*Notification`、`<resource>/<method>` 如 thread/start、`#[ts(export_to = "v2/")]` TS 绑定生成,见 AGENTS.md 与 cli/src/main.rs:617-620 generate-ts/json-schema 命令)。app-server 内部把 EventMsg 转成 ServerNotification(v2)推送——exec JSONL 处理器同样 import codex_app_server_protocol 类型(event_processor_with_jsonl_output.rs:6-16),两协议共享 item 抽象。

**历史对照**:早期版本的 `codex proto` = stdin/stdout JSONL 的 Submission/Op↔Event 协议;本 HEAD 已由 (a) 进程内 channel、(b) `codex exec --json` 单向 JSONL、(c) app-server 双向 JSON-RPC 三分其职。

## 13. Capability Matrix(单行)

| Capability | Value+evidence |
|---|---|
| Session | ThreadId=UUIDv7,`~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl` append-only;SessionMeta【protocol.rs:3100;rollout/lib.rs:84;thread_id.rs:30】 |
| Resume | `codex resume [id\|--last\|--all]` picker;`resume_thread_from_rollout`→`InitialHistory::Resumed`【cli/main.rs:202;thread_manager.rs:1195】 |
| Streaming | `AgentMessageContentDelta`/`ReasoningContentDelta`/`ExecCommandOutputDelta`/`ItemStarted/Completed`;core→TUI 为 async_channel 流【turn.rs:2502;session/mod.rs:590】 |
| Cancellation | `Op::Interrupt` → CancellationToken贯穿每个await(`.or_cancel`)→ `CodexErr::TurnAborted` → `TurnAborted{reason}`【handlers.rs:427;turn.rs:2554;protocol.rs:4253】 |
| Approval | ExecApprovalRequest→`Op::ExecApproval{id, decision: ReviewDecision}`→pending_approvals oneshot 回注【session/mod.rs:2866-2887;handlers.rs:173】 |
| Tool events | `McpToolCallBegin/End`、`ExecCommandBegin/End`、`ViewImageToolCall`、`WebSearchBegin/End`【protocol.rs:1443-1467】 |
| File changes | `ApplyPatchApprovalRequest{changes}`、`PatchApplyBegin/Updated/End{changes, success, status}`、`TurnDiff{unified_diff}`【protocol.rs:3721-3752】 |
| Terminal | `ExecCommandOutputDelta` 增量;`TerminalInteraction`(stdin/stdout);后台进程 `CleanBackgroundTerminals`、`list_background_terminals`【protocol.rs:1461;tasks/mod.rs:782】 |
| Background task | `Op::RunUserShellCommand{timeout_ms}`("!cmd",默认1h);后台终端进程持续存活于 Interrupt 之外【protocol.rs:744】 |
| Parallel tools | `in_flight: FuturesOrdered` 同响应内并发执行 tool_future【turn.rs:2502,2679】 |
| Compaction | 预采样自动压缩(token_limit_reached)+ 手动 `Op::Compact`;local/remote-v2/TokenBudget 三实现;window_id 链【turn.rs:1271-1501;compact.rs】 |
| Subagent | 原生 spawn_agent/send_message/wait_agent/close_agent/resume_agent(v1+v2);子代理=真实 thread(parent_thread_id)【multi_agents_spec.rs;protocol.rs:3100】 |
| Usage | `TokenCount{info{total,last,model_context_window}, rate_limits{primary,secondary,credits,plan_type}}`【protocol.rs:2320-2378】 |
| Reasoning events | `AgentReasoning(+RawContent/SectionBreak)`、`ReasoningContentDelta/RawContentDelta`、encrypted_content 回放【protocol.rs:1413-1420,1532-1533】 |
| PTC | 有:Code Mode(V8 JS runtime,工具 TS 化 + exec 内嵌套工具调用)【code-mode-runtime/v8_init.rs;code-mode-protocol】 |

## 14. 判断:Shell 必须看到 vs Runtime 内部

1. **Shell 必须看到 turn 生命周期边界**:TurnStarted/TurnComplete/TurnAborted/Error——没有它就无法对齐 UI 状态机;wire 名是 task_started/task_complete(兼容别名 turn_started/turn_complete),集成时必须按 serde 名解析【protocol.rs:1391,1400】。
2. **Shell 必须看到两条流式通道**:assistant 文本(AgentMessageContentDelta)与 reasoning(ReasoningContentDelta)是独立事件族,不能合并;reasoning 还有 SectionBreak 分段语义【protocol.rs:1530-1533】。
3. **Shell 必须看到审批请求-响应对**:事件侧 ExecApprovalRequest/ApplyPatchApprovalRequest(带 approval_id/call_id、available_decisions、proposed amendments),响应用 Op::ExecApproval/PatchApproval{decision};超时/不答=Abort——协议必须支持"等待可被取消"【session/mod.rs:2887;protocol.rs:4170】。
4. **Shell 必须看到文件变更的结构化流**:PatchApplyBegin(changes)→End(changes+status Completed/Failed/Declined)+TurnDiff{unified_diff};只看 apply_patch 工具输出是不够的,审批前就要拿到 changes 做预览【protocol.rs:3721-3747,2894】。
5. **Shell 必须看到用量与配额**:TokenCount 的 rate_limits(primary/secondary/credits)是唯一配额信号;模型上下文窗口占用(model_context_window)随 info 下发,用于渲染余量【protocol.rs:2253-2259】。
6. **Shell 必须看到会话可恢复性**:崩溃恢复依赖 rollout JSONL + `codex resume <uuid>` 提示;Shell 集成若要持久化会话,应持久化 rollout 路径/ThreadId 而非自己拼 history【cli/main.rs:3790】。
7. **Shell 必须看到工具执行的三段式**:Begin(含 parsed_cmd/cwd)→OutputDelta→End(exit code/时长),以及 McpToolCallBegin/End 对 MCP 的对等事件——这是渲染"正在做什么"的最小集合【protocol.rs:1455-1464】。
8. **可以内部化:模型流解码与重试**。SSE 解码、5s→60s backoff、stream disconnected 重试全部在 core 内,客户端只收到 StreamError(含"正在重试"语义);Shell 不需要自己实现 429/5xx 退避【responses_retry.rs:16-17,163】。
9. **可以内部化:并行工具调度**。FuturesOrdered 并发、in-flight 排序、needs_follow_up 决策都是 runtime 内部;客户端只需看到乱序完成的三段式事件【turn.rs:2502】。
10. **可以内部化:压缩决策**。何时压、用本地还是 remote-v2、window 链管理对客户端透明,只有一个 ContextCompacted 事件;Shell 不应自行做 history 截断,否则破坏 rollout 重放【turn.rs:1443-1501】。
11. **可以内部化:上下文构建**。build_prompt、MCP 按需启动、skills/plugins 注入、ContextualUserFragment 约束(AGENTS.md:上下文只增不改、单项≤10K token)都在 core;Shell 提交的用户输入会被规范化后入库。
12. **可以内部化(但可订阅):guardian 自动审批**。GuardianAssessment/ApproveGuardianDeniedAction 是可选覆盖路径;默认策略下客户端无需参与自动评审【protocol.rs:734,1484】。
13. **协议形态判断**:Codex 没有"单一 CLI 协议",而是三出口(core 内嵌 Event 流、`codex exec --json` 单向 JSONL、app-server 双向 JSON-RPC v2);ARI 若要复用,建议对齐 app-server v2(camelCase、thread/<method>、TS 绑定生成)而非复刻已删除的 proto 模式【exec/event_processor_with_jsonl_output.rs:59;cli/main.rs:169】。
14. **词汇判断**:Task→Turn 的改名(TurnStarted/TurnComplete)、UserTurn→TurnInput 的重命名、OnFailure→OnRequest 别名说明:codex-rs 的协议语义正在从"任务驱动"迁移到"turn/线程驱动",ARI 设计应直接采用 thread/turn/item 三层词汇【protocol.rs:1391-1401,612-616,977】。
15. **预算判断**:无 max_turns 硬限;中断有四原因(Interrupted/Replaced/ReviewEnded/BudgetLimited),其中 BudgetLimited 来自后端上报的 rollout budget units——ARI 若做预算控制,应设计为"运行时可撤销的外部预算信号"而非本地计数器【protocol.rs:4253-4258;rollout_budget.rs:47-56】。
