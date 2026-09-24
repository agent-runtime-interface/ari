# ZCode (zai-org/ZCode) 源码研究报告 — ARI 协议设计研究

> 仓库: `ZCode/`（本地 clone，未入库；package.json version 3.14.0，Apache-2.0，TypeScript pnpm monorepo）
> 方法: 源码定点阅读（grep + 分段 read）。所有 claim 给出 path + symbol；未找到写「源码中未找到」。

## 1. 架构总览

**是什么**: ZCode 是「AI coding workspace，具有 desktop / browser / terminal 三种界面」，仓库包含 clients、backend services、shared UI 与 Agent CLI/runtime 源码（README.en.md §"ZCode is an AI coding workspace"）。Agent CLI `zcode` 同时作为 Desktop 与 Web 的 Agent runtime（README.en.md 接口表 "Agent CLI ... which also provides the Agent runtime for Desktop and Web"）。

**Monorepo 布局**（pnpm-workspace.yaml + architecture-policy.yaml modules）:
- `apps/zcode-cli/` — 独立子 monorepo（有自己的 pnpm-workspace.yaml/turbo.json），Agent CLI 与 runtime。子包: `core`（runtime 核心: agent/tool/runtime/session-context/compact/subagent/mcp/memory/hooks/permission 等）、`bootstrap`（进程引导 + zcode-protocol server + stdio transport）、`cli`、`tui`、`contracts`、`shared-types`、`adapters`、`dynamic-workflow(-runtime)`、`node-repl-host`、`browser-use-plugin`、`superpowers-plugin`、`telemetry`、`i18n`、`debug`（apps/zcode-cli/packages/ 目录列表）。
- `packages/shared` — 共享协议与类型（含 `zcode-protocol-v4/`、legacy `zcode-protocol/`）；`packages/rpc` — RPC 框架；`packages/client` — "Agent 客户端 SDK"；`packages/services` — 业务服务（`zcode-agent/`、`session/`、`storage/`）；`packages/server` + `packages/web` — Web 后端与前端；`packages/ui` — 共享 React/Zustand；`packages/desktop` — Electron main/host/renderer（划分见 AGENTS.md §"命令与仓库结构"、architecture-policy.yaml `modules`）。

**分层流（入口 → runtime → tools → model provider）**: 客户端（desktop/web/tui）→ `packages/services/src/zcode-agent/zcodeProtocolClient.ts`（协议客户端）→ `zcodeStdioTransport.ts`（stdio 子进程）→ `apps/zcode-cli/packages/bootstrap`（zcode-protocol server: `transport.ts` / `server-operations.ts` / `v4-bridge.ts`）→ `apps/zcode-cli/packages/core/src/runtime.ts` + `runtime/`（agent loop）→ `core/src/tool/`（tools）→ `core/src/model/`（model 抽象，底层由 `packages/provider` / `packages/provider-node` 提供模型 API 访问）。server（Web 后端）通过 `packages/zcode-server-cli`/server 包把同一 runtime 暴露给浏览器（README.en.md: web 开发时 `@zcode/server` 起 :3030，`/ws`、`/api` 代理过去）。



## 2. 客户端协议 (ZCode Protocol V4)

定义位置: `packages/shared/src/zcode-protocol-v4/`（index.ts 自述「数据模型草稿（未冻结）」「只放 schema 类型 + 纯函数」）。与 legacy `packages/shared/src/zcode-protocol/` 并存。版本: `V4_WIRE_PROTOCOL_VERSION = 3`（core.ts；注释说明「projection snapshot 继续独立使用 protocolVersion=1」）。

**传输与拓扑**: 客户端与 runtime 之间是 **RPC + topic pub/sub 双面**。RPC 侧是 JSON-RPC 风格方法（`v4/command`、`v4/conversation/subscribe` 等，见下）；事件侧是 topic 帧流。承载层有三档——CLI 内嵌/stdio（NDJSON）、@zcode/rpc Channel socket（二进制 VQL header）、mobile relay（base64 包裹）——`measureTopicNotificationEnvelopeBytes` 按三层真实 envelope 分别计量（wire-codec.ts）。Desktop 用 stdio 拉起 CLI 子进程（packages/services/src/zcode-agent/zcodeStdioTransport.ts），Web 由 server 包代理 `/ws`（README.en.md）。

**握手与能力协商**: host→client `HelloMessage {kind:"hello", protocolVersion, connectionId, clientMode: "desktop-continuous"|"web-remote-replayable", deliveryProfile: "continuous"|"replayable", serverTime, capabilities: HostCapabilities, auth}`；client→host `ClientHello {clientId, clientKind: "desktop"|"web"|"mobileRemote"|"mobileApp", appVersion, capabilities}`（transport.ts `helloMessageSchema`/`clientHelloSchema`）。HostCapabilities = `{nativeDialogs, localTerminal, binaryFrames, compression: none|permessage-deflate, workspaceHookReview?, independentPlanState?}`（transport.ts `hostCapabilitiesSchema`）——用 optional+`=== true` 判断实现向后兼容。deliveryProfile（core.ts `DELIVERY_PROFILES`）: `continuous`（desktop, flushWindow 30ms, 全路径流式文本）vs `replayable`（web/mobile, 150ms 窗口, 不流式只带 toolProgress）。

**订阅模型（事件流）**: `subscribeParamsSchema {topic: "conversation/<sessionId>" | "sessions-index/<workspaceId>" | "workspace-config/...", base: {logEpoch, seq}?, visibility: foreground|background}` → ack `{subscriptionId, mode: "snapshot"|"resume", logEpoch}`（transport.ts `subscribeParamsSchema`/`subscribeAckSchema`）。客户端带 base 水位则从该点续传增量，否则收全量 snapshot —— 基于 **logEpoch+seq 的会话事件日志**。frame envelope: `{topic, subscriptionId, fromSeq, toSeq, sentAt, payload: {kind:"snapshot",snapshot} | {kind:"deltas",deltas[]}}`（transport.ts `createTopicFrameSchema`）；物理层再包 `TopicWireFrame`：complete 或 fragment（>1MiB maxFrameBytes 时 UTF-8 byte 分片 + crc32，fragmentIndex/Count/logicalBytes，deliveryKind: initial|online|recovery）（wire.ts `topicWireFrameSchema`/`topicFrameDeliveryKindSchema`）。

**RPC 方法清单**（grep `"v4/"` 全仓库）: 控制/查询面 — `v4/command`（下发命令）, `v4/commands/query`（pending command 状态）, `v4/conversation/{subscribe,unsubscribe,resync,rowsRange,fileChanges,fileRewindPreview,backgroundBashOutput,usage,plans,workflowRuns,workflowRunEvents,workflowRunArtifacts,workflowRunArtifactRead,workflowRunArtifactData,workflowRunNodeResult,workflowRunWorkspace}`; 附件 — `v4/attachment/{begin,chunk,commit,abort,read,previewSource}`; 观测 — `v4/telemetry/event`, `v4/usage/stats`, `v4/connection/flow`; controller 面 — `v4/controller/{subscribe,unsubscribe,resync}`。

**命令下发（request/response）**: `commandEnvelopeSchema` + `commandPayloadSchemas`（command.ts）——命令是带幂等键的 RPC（`commandKeySchema`, `COMMANDS_REQUIRING_BASE_REVISION` 做乐观并发 baseRevision CAS, `ROW_TARGETING_COMMANDS` 以 rowId+entityId 定位），结果 `commandResultSchema` discriminated union（command.ts:367），另有 `commandAckSchema`。命令表（command.ts `commandPayloadSchemas`）: createSession, createSelectionSideSession, sendText, sendGoalCommand, stop, compact, forkAssistant, applyFileRewind, editUserQuery, retryTurn, setAssistantFeedback, sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem/setAutoDrain（输入队列管理）, resolveInteraction（**审批/提问回执**）, snoozeInteractionAutoResolution, respondWorkspaceHookReview(+toggle/revoke/request), switchModelConfig, switchCollaborationMode, setFollowupMode, pauseGoal/resumeGoal, cancelBackgroundWork, resumeWorkflowRun, startSavedWorkflow, amendWorkflowRunSettings, renameSession, deleteSession, discardSharedContext。SubmissionMode = `["build","edit","plan","yolo"]`（submission.ts `submissionModeSchema`）。

**限流/预算常量**: `PROTOCOL_V4_LIMITS`（core.ts）— maxFrameBytes 1MiB, logicalFrameAssembly 16MiB/1024 分片, subscriberBuffer 500 ops/1MiB, eventRetentionPerSession 2000, snapshotTailWindowRows 60, rowsRangeMaxLimit 200, toolOutputFinalHead/TailBytes 32KiB, attachment 20MiB/512KiB chunk 等。

## 3. 消息模型

V4 把「客户端可见投影」从「模型 API 消息」中解耦：协议里只有 **Row + Delta + StatePatch**，没有模型消息。

**ConversationRow 联合**（rows.ts `conversationRowSchema`, discriminated on `kind`）:
1. `turnHeaderRow`（turnHeaderRowSchema: 含 turnWorkSegment）— turn 边界/工作分段
2. `userInputRow`（userInputRowSchema）— 用户输入
3. `assistantTextRow`（assistantTextRowSchema）
4. `reasoningRow`（reasoningRowSchema）— 推理/思考内容行
5. `toolCallRow`（toolCallRowSchema）— 字段: assistantResponseId?, toolCallId, toolName, `status: "inputStreaming"|"pendingApproval"|"running"|"success"|"error"|"cancelled"`, inputText, input, output: toolOutputSchema, display: toolCallDisplaySchema, error{code,message}, progress（仅 replayable 运行态）, outputPreview, `approvalInteractionId`（指向 pendingInteractions）, `backgrounded`+`workId`（后台移交）, startedAt/endedAt
6. `artifactRow`（artifactRowSchema）— 产物: artifactVersionId, logicalArtifactKey, artifactType(pdf|pptx|docx|xlsx|image|html|md|text), sha256, ref
7. `subagentRow`（subagentRowSchema）— 子代理行
8. `hookInvocationRow`（hookInvocationRowSchema, + hookExecutionProjection）— hook 执行投影
9. `timelineMarkerRow`（timelineMarkerRowSchema, timelineMarkerLane）— 时间线标记

**ConversationDelta 联合**（delta.ts `conversationDeltaSchema`, discriminated on `op`, 共 5 个 op）: `row.appended`（追加, 99% 场景）, `row.upserted`（按 rowId 整行替换=状态机迁移）, `row.removed {fromRowId}`（删该行及之后 = edit/retry 分支）, `row.delta {rowId, path: "text"|"inputText"|"output.text"|"summaryText", append}`（流式追加, 仅流式态行）, `state.updated {patch}`。delta.ts 头注: 「没有 row.inserted（中间插入）、没有 row.moved、没有字段级 JSON patch——凡此模型表达不了的结构变化，服务端一律发 snapshot resync，刻意压缩客户端错误面」。

**StatePatch**（delta.ts `statePatchSchema`, 键级整体替换、键集合封闭）: revision, control, sharedContextImport, availability, inputRouting, meta, config, modelTransition, usage, queue, pendingInteractions, pendingCommands, backgroundWorks, subagents, workflowRuns, goal, plan, workspaceHookAdmission —— 各键 schema 在 snapshot.ts（如 pendingInteractionSchema, backgroundWorkSummarySchema, queueStateSchema, goalStateSchema, planStateSchema）。

**模型 API 消息**: 协议层未包含 Anthropic/OpenAI 风格 messages；模型消息在 runtime 内部（apps/zcode-cli/packages/core，见 §5）。toolCall 行与模型 response 通过 `assistantResponseId` 关联（rows.ts 注释「同一模型 response 的正文与工具共享此 ID」）。legacy 协议（packages/shared/src/zcode-protocol/）仍在 packages/ui 中被引用（如 conversationProjectionStore.ts），属于旧客户端面。



## 4. Session

**创建**: 协议命令 `createSession {workspaceId, firstInput{text,attachments,modelSelection,mode,planEnabled}, config, mcpServers, offPeakToolEnabled, dynamicWorkflowEnabled}`（command.ts）；side session: `createSelectionSideSession`（选区侧会话）。Runtime 侧 `AgentRuntime` 构造即绑定一个 `sessionId`（agent-runtime.ts 字段 `private sessionId: SessionId`），首个事件 `SessionCreated {planEnabled, mode, contextWindow}`（contracts session.events.ts `SessionCreatedPayload`）。

**持久化**: **SQLite**。默认路径 `~/.zcode/cli/db/db.sqlite`（packages/adapters/src/storage/session-store/paths.ts `getDefaultSessionDbPath`），可由 `config.storage.sessionDbPath` 覆盖（bootstrap/src/app/session-store.ts `getSessionDbPath`）。实现 `sqlite-session-store.ts` 基于 `node:sqlite` `DatabaseSync`，实现 `SessionStorePort` 等多个 port；从 type import 可见覆盖: sessions, messages(MessageInfo/MessagePart/MessageWithParts), input history(InputHistoryEntry), usage(TurnUsageRecord/ToolUsageRecord/ModelUsageRecord), todos, permission rulesets, script workflow definition/run/event/activity records, session task links, goal(SessionGoal), file diff(FileDiff), fork bundle(ForkCommitBundle/ForkChildSessionMetadata), shared-context import 等。消息模型是 **message + parts**（session-transcript.ts `SessionTranscriptPart = {text|thought|tool{toolCallId,toolName,input,output,status,title,resultDisplay}}`，role: user|agent）。

**事件溯源双轨**: runtime 内存态 `InMemorySessionEventStore`（contracts events/in-memory-session-event-store.ts）保存 `SessionEvent{id, sessionId, turnId, type, timestamp, traceId, sequenceNumber, payload}`；持久化以 message 库为主。V4 投影由 transcript 反向合成事件: bootstrap/src/zcode-protocol-v4/transcript-hydration.ts —— 注释明言「reduce(transcript) ≡ reduce(events)」，fork 子会话/rewind 截断只动 message 库，冷订阅 hydration 把 transcript 反向合成 SessionEvent 序列再归约，保证重启后历史可见运行态不消失。

**Resume**: `resume.ts`（runtime/methods, 453 行）+ `ResumeSessionOptions/ResumeSessionResult`（runtime/types.ts）；`SessionResumedPayload {directory, interruptedToolCount, messageCount, partCount, recoveredCompactTimelineCount, recoveredSteerInputCount, resumedTodoCount}` —— **崩溃恢复**包含被打断工具数、steer 输入数、compact 时间线的回收。CLI 侧恢复事件 `Resume`、取消持久化错误码集合 `PERSISTED_CANCELLATION_CODES`（transcript-hydration.ts）。

**Fork/Rewind**: `session-fork.ts`（1487 行, runtime/methods）+ `WorkspaceForkResult`；协议命令 `forkAssistant {target: conversationRowTarget}`、`applyFileRewind {target}`、`editUserQuery {target, newText, workspaceMode: preserve|rewind}`、`retryTurn {target}`（command.ts）；查询 `v4/conversation/fileRewindPreview`。文件级: `file-rewind.ts`、`rewind.ts`、`workspace-checkpoints.ts`（`WorkspaceCheckpointSummary`, `WorkspaceRewindRestoredFile`, checkpoint 事件 `CheckpointCreated`, `RewindTriggered`, `application/vnd.zcode.workspace-checkpoint+json`）。

**多客户端**: 单 CLI 进程 + 多订阅者模型 —— subscribe 的 `subscriptionId` 与 deliveryKind=recovery 支持多消费端各自水位；`clientKind: desktop|web|mobileRemote|mobileApp`（transport.ts）。**Interrupt/Cancel**: 协议命令 `stop {expectedForegroundExecutionId?}`；事件 `Interrupt`, `Cancel`, `TurnError`；`StopActiveForegroundExecutionOptions/Result`（runtime/types.ts）。

## 5. Agent loop

核心文件: runtime/methods/turn-loop.ts `runRegularTurnLoop`（while(true) 每轮 = 一次 model step）+ turn.ts（turn 入口, 872 行）+ turn-machine.ts（状态机抽象）+ turn-model-step.ts（provider 调用）+ turn-step-finish.ts。

**单轮控制流**（turn-loop.ts）: ① `throwIfTurnAborted(turnAbortSignal)`；② drain pending runtime commands（steering 输入、后台 subagent 结果、workflow 结果并入 turnRequestState）；③ `microcompactIfNeeded`（phase: PreRequest|MidTurn）；④ `evaluateRapidRefill` + `autoCompactIfNeeded(CompactReason.ContextLimit)`，连续 rapid refill 超限抛 `createCompactRapidRefillError`（熔断）；⑤ `initializeMcp` + `getTools`（按 `toolDisallowlist`/automation/off-peak 限制过滤，定时任务轮禁写任务定义防递归）；⑥ 注入 system reminders: `plan_mode_exit`/`runtime_mode`/`todo_reminder`/`output_style`（provider-visible attachment，output_style 不落 session）；⑦ `buildRuntimeProviderRequestMessages`（provider-visible 排序投影 + cache-control 锚点在投影后统一设置）；⑧ `TurnMachineImpl.startModelRequest` → `runModelBackedTurnStep`；结果 `"break"` 退出循环。

**TurnMachine 状态机**（agent/turn-machine.ts `TurnMachine`）: start → startModelRequest → (addStreamingContent|receiveModelResponse) → scheduleTools → startToolExecution → completeTool → aggregateResults → complete/fail；另有 requestPermission/resolvePermission、queuePendingInput/drainPendingInputs。`TurnPhase` 由 `getNextPhase()` 推导。

**上下文预算/迭代**: model step 无硬编码 max-iterations（源码中未找到固定次数上限；终止靠 turnControl/stopTurnOnSuccess 工具、stop 命令与错误）；`turnOutputTokenContinuation`（输出 token 截断续跑, filterOutputTokenContinuationEntries）、`target-continuation-loop.ts`、`streaming-recovery.ts`（流中断恢复）。**重试/循环检测**: `repeatedToolCallSignature`/`repeatedToolCallStreakCount`（turn-loop.ts 引用, turn-loop-state.ts 定义）—— 同签名工具调用连击计数。**parallel**: ToolScheduler 并行组（见 §6）；**steering**: `TurnSteerQueued/Drained/...` 事件 + `steering.ts`，guide 模式一次注入 vs queue 排队。

## 6. Tools

**统一接口**: `ToolEntry = {metadata: ToolMetadata, handler: ToolHandler, ...}`（tool/types.ts）；`ToolMetadata {name, description, modelInstructions, allowedInPlanMode, readOnly, destructive, concurrentSafe, requiresUserInteraction, timeoutMs, maxOutputBytes, sideEffectScope, riskLevel, needsApproval, providerVisible, stopTurnOnSuccess, mcpPresentation{serverName,toolName,official}}`（tool/types.ts）。`ToolRuntimeScope = "main"|"subagent"`。注册: `ToolRegistryImpl.register/unregister`（tool/registry.ts, 重名覆盖+警告）。

**调度**: `ToolScheduler.schedule(ToolDependency[]) → ToolSchedule {items, parallelGroups: ToolCallId[][], executionOrder}`，`DEFAULT_MAX_CONCURRENCY = 10`，拓扑排序 + 并行分组 + 环校验；`canRunInParallel` 综合 readOnly/destructive/concurrentSafe/sideEffectScope（tool/scheduler.ts）。

**超时/取消**: `ToolDeadline`（executor/timeout.ts）——**可暂停的 deadline**: 工具内部模型请求在进程级准入闸门排队时暂停计时「剩余时长守恒」，超时守 provider 挂而不是自己队列长；`executeWithTimeout`, `resolveTimeoutMs`, `linkAbortSignal`。取消: `CoreErrorType.ToolCancelled`（executor/call-runner.ts 检查 signal.aborted）。

**Builtin 工具**（tool/handlers/ 文件名清单）: Bash（bash.ts + 庞大 readonly-policy 族判定只读性 + bash-background-lifecycle/policy + bash-cwd-policy + git runtime safety）、Read（read.ts + read-text/image/pdf/video）、Write（write.ts）、Edit（edit.ts + edit-matchers.ts + tool/diff.ts）、Glob（glob.ts）、Grep（grep.ts）、TodoWrite/TodoRead（todo.ts）、WebFetch（webfetch.ts + cache/egress-guard/processing）、WebSearch（websearch.ts）、Agent（agent.ts, 子代理）、AskUserQuestion（ask-user-question.ts）、Skill（skill.ts）、NodeRepl/js（node-repl.ts, 见 §12）、ListModels/model-reference、Cron（cron.ts, 定时任务）、OffPeak（off-peak.ts, 闲时任务）、TaskOutput/TaskStop/TaskOutputBash（task-output*.ts, 后台任务）、SendMessage（send-message.ts）、SubmitResult（submit-result.ts, stopTurnOnSuccess 终态提交）、ReadSessionContext、PlanMode（plan-mode.ts）、Escalate（escalate.ts）、CreateWorkflow/AmendWorkflow*/GetWorkflowRun*/ListWorkflowRuns/ResumeWorkflowRun/EvalWorkflowSnippet/SaveWorkflow（dynamic workflow 族, 见 §12）、browser-use 插件工具。

**MCP**: `McpPort`, `initializeMcp`（turn-loop 每轮前确保初始化）, `mcpToolsRegistered`, `mcpPresentation` 投影字段; 配置 `mcpServers` 随 createSession 传入（command.ts）。**进度/流式输出**: ToolCallRow.progress（replayable 档）与 `outputPreview`（execution-output-preview.ts, 有界 Bash 内容, 终态或后台移交时清除）; 事件 `ToolCallProgress`/`StreamingToolLedgerUpdated`。**后台**: `backgrounded`+`workId` 字段 + `BackgroundTaskStarted/Updated/Completed` 事件 + executor/background-task-registry.ts。



## 7. Approval / Permission

**双门模型**: 规则判定（PermissionService, 同步）+ 客户端 broker（异步人工确认）。
- `PermissionService.checkPermission(context, toolCapability, projectRules, rulePolicy) → PermissionDecisionResult`（core/permission/service.ts）。`PermissionContext {toolName, input, riskLevel, mode, planEnabled, prePlanMode, workingDirectory}`; `PermissionBehavior = "allow"|"ask"|"deny"`; 结果含 `modifiedInput`（**权限层可改写工具参数**）、`escalated`、`ruleId`、`alwaysAsk`（结构化标记「该 ask 来自工具 alwaysAsk 声明, PreToolUse hook 不可抹掉」）。
- 工具能力声明 `PermissionToolCapability {allowedInPlanMode, alwaysAsk, readOnly, destructive, requiresUserInteraction, sideEffectScope, riskLevel, needsApproval, permissionCapabilityGroup, permission: ToolPermissionSpec}`（service.ts）。
- 规则持久化: `PermissionRuleset {version:1}` + `applyPermissionUpdates(ruleset, PermissionUpdate[])`; `PermissionUpdate = {type:"addRules", behavior, rules: PermissionRuleValue[]}`（contracts interfaces/permission.port.ts）。会话级「Always allow in this session」= `grantSessionPermission`，仅存 runtime 内存随会话消亡（service.ts 注释）。plan-mode 切换有专门 `resolvePlanModeTransitionPermission`（plan-mode-policy.ts）。

**等待客户端确认（broker）**: `PermissionBrokerPort` / `ManualPermissionBroker`（core/permission/broker.ts）——pending map 按 requestId 去重（重复请求抛 `InvalidStateTransition`），带超时；无 broker 时 `DenyPermissionBroker` 兜底 deny。请求结构 `PermissionBrokerRequest {requestId, sessionId, turnId, traceId, toolCallId, toolName, ...}`（contracts permission.port.ts）。事件: `PermissionRequested` → `PermissionResolved|PermissionDenied`。

**客户端可见形态（V4 投影）**: pending interaction 挂在 StatePatch 的 `pendingInteractions[]`（snapshot.ts `pendingInteractionSchema`）: `{interactionId, kind: "permission"|"userInput"|"workspaceHookReview", anchorRowId(nullable, null=会话级), createdAt, autoResolution, payload}`。**permission payload**: `{toolCallId, toolName, summary, detail, freeText?, origin?, display(工具自报确认预览,复用 toolCallDisplay), fullAccessOption?(PERMISSION_FULL_ACCESS_OPTION_ID="fullAccess"), options: [{optionId, label, kind: "allowOnce"|"allowAlways"|"deny"|"custom", response}]}`（snapshot.ts `permissionRequestPayloadSchema`/`permissionOptionSchema`）。同时对应 toolCallRow.status = "pendingApproval" 且 `approvalInteractionId` 指回 interaction —— **客户端如何知道在等: StatePatch.pendingInteractions 非空 + toolCall 行状态**。回执: 协议命令 `resolveInteraction {interactionId, answer{optionId?, freeText?, action: accept|decline|cancel?, content?}}`（command.ts）。**参数编辑**: `PermissionDecisionResult.modifiedInput`（runtime 侧改写）；客户端侧 freeText 反馈与 AskUserQuestion 多题答案（`userInputRequestPayloadSchema {prompt, freeText, options, sensitive, questions[], schema}`）。AskUserQuestion 首次操作永久暂停自动结束: `snoozeInteractionAutoResolution`（command.ts）。另有 permission-options.ts / permission-suggestions.ts / permission-rules-persistence.ts（executor/ 目录, 建议规则与落盘）。

## 8. File / Diff

**协议面**: 专用 RPC `v4/conversation/fileChanges` 与 `v4/conversation/fileRewindPreview`（grep "v4/" 命中, bootstrap v4-bridge 服务端实现）；文件回卷命令 `applyFileRewind`。**Diff 数据类型**: `FileDiff {path, additions, deletions, oldPath?, newPath?}`（contracts interfaces/session-store.port.ts —— rename 以 old/newPath 表达, 无 hunk 级内容）。工具结果展示层有 `FileDiffToolResultDisplayPayload`（contracts tools/tool-result-metadata.ts）。tool/diff.ts 提供 edit 工具的 diff 计算。

**变更表示哲学**: 文件修改不是独立事件流，而是 **toolCallRow（Edit/Write 工具行）+ turn 级汇总**。contracts 有 `TurnFileChangeSummary`（transcript-hydration.ts import）——每 turn 汇总文件变化; toolCallRow.status/output/display 携带结果。V4 事件日志中没有 file.changed 独立事件（源码中未找到; 文件变化经 tool 结果与 turn summary 投影）。

**快照/回滚**: workspace checkpoints —— `workspace-checkpoints.ts` + `WorkspaceCheckpointSummary`/`WorkspaceFileRewindApplyResult`/`WorkspaceRewindRestoredFile`（runtime/types.ts）, 事件 `CheckpointCreated`/`RewindTriggered`, MIME `application/vnd.zcode.workspace-checkpoint+json`（bootstrap grep 命中）; `SessionRevert {messageID, partID?, snapshot?, diff?}`（session-store.port.ts）把会话回退与文件快照关联。SQLite 端有 FileDiff/ForkCommitBundle 存储列。

## 9. Command / Terminal

**Bash 工具**: handler tool/handlers/bash.ts + 大量配套: `bash-command-parser.ts`（命令解析）, `bash-readonly-policy*.ts`（~20 个文件: argv/flags/git/simple-commands/multiword 维度判定命令是否只读, 直接喂 PermissionService 的 readOnly 判定）, `bash-cwd-policy.ts`, `bash-timeout-policy.ts`（tool/ 根）, `bash-gh-rate-limit.ts`, `bash-git-runtime-safety.ts`, `bash-image-output.ts`（图片输出支持）, `bash-output.ts`。

**暴露给 UI 的形态**: toolCallRow kind="toolCall", toolName="Bash", inputText=命令文本, output=toolOutputSchema, `outputPreview: ExecutionOutputPreview`（有界实时输出, PROTOCOL_V4_LIMITS.toolOutputFinalHead/TailBytes 32KiB 截取, 终态或后台移交时清除, rows.ts）。事件: ToolCallStarted/Progress/Result。

**后台 Bash**: 后台移交后 toolCallRow.`backgrounded: true` + `workId`; 专用 RPC **`v4/conversation/backgroundBashOutput`** 拉取输出（bootstrap v4-bridge）; 类型 `backgroundBashOutputSchema {kind:"output", workId, status: "running"|"completed"|"failed"|"timed_out"|"cancelled"|"spawn_error", output(max 8KiB), truncated, outputPath}`（packages/shared/src/background-bash-output.ts）——超限截断+全量落盘 outputPath。控制: `cancelBackgroundWork {workId}`（command.ts）+ TaskStop 工具（task-stop.ts, BackgroundTaskControlStopOptions.initiator: "user"|"model"）。启动: `BackgroundTaskStarted` 事件 + executor/background-tasks.ts。轮询输出工具 `task-output-bash.ts`（TaskOutputBash）。

**PTY**: 源码中未找到 node-pty 等 PTY 依赖（bash 用普通子进程执行; desktop 端 `localTerminal` HostCapability 指 Host 是否能开本地终端窗口, transport.ts hostCapabilitiesSchema）。



## 10. Context management

**Context 构建**: `ContextBuilder.build() → ContextBuildResult {sections: ContextSection[]}`（core/context/builder.ts）——结构化 section 列表，每个 section 带 `chars/tokens(estimateTokens)/injectionTarget("system"|...)/cacheHint("dynamic"|"stable")`；section 1 = CLI prefix「You are ZCode, an interactive coding agent」, 2 = 稳定行为体或 customSystemPrompt, 特殊身份 workflowActor（与 customSystemPrompt 互斥, 同时在场抛错）；`addSection` 支持扩展; 工具说明不再镜像进 system prompt（由 request 的 tools 字段承载, builder.ts 注释）。`context/dynamic-sections.ts` + `context/sections/`。子代理有独立 `SubagentContextBuilder extends ContextBuilder`（subagent/context-builder.ts）。

**Compaction（两级）**:
- **auto-compact**: `autoCompactIfNeeded`（runtime/methods/compact.ts, 184 行起）——`shouldAutoCompact({messages, config, consecutiveFailures, tokenOverride})` 决策（thresholdTokens 由 `getAutoCompactThreshold`/modelContextBudgetStrategy/contextWindow+maxOutputTokens 推导, compact.ts:267）；触发理由 `CompactReason.ContextLimit|UserRequested|ProviderOverflow`（compact.ts:92,425 —— provider 报 context exceeded 后 `reactiveCompactAfterContextExceeded`）；摘要模型请求 `compact-summary-model-request.ts`; rapid-refill 熔断（`MAX_CONSECUTIVE_RAPID_REFILLS`, `RAPID_REFILL_TOOL_TURN_THRESHOLD`, turn-loop-state.ts）。
- **microcompact**: `microcompactIfNeeded`（PreRequest|MidTurn 两 phase, turn-loop 每轮调用）——`LocalMicrocompactPolicyConfig.thresholdTokens ?? buildDefaultMicrocompactThreshold`（microcompact.ts:112）。
- **可见性**: 事件 `CompactStarted/Completed/Failed/CompactBoundary/MicrocompactBoundary`; payload `SessionCompactedPayload {compactBoundary, summary, preservedEventCount, removedEventCount}`（session.events.ts）; 恢复计数 `recoveredCompactTimelineCount`（SessionResumedPayload）。**Snapshot/restore**: compact timeline 持久化 `compact-persistence.ts`。

**Transcript**: message 库（SQLite）为权威; 投影时跳过 summary message 与 model-only user message（「goal continuation 等 runtime 内部输入保留在 raw history 供模型恢复, 但 transcript 是用户可见投影」session-transcript.ts 注释）。`read-session-context.ts` 提供 ReadSessionContext 工具（跨会话读 transcript, 「Cleaned transcript」标题, :70）。

**工具输出截断**: `PROTOCOL_V4_LIMITS.toolOutputFinalHeadBytes/TailBytes = 32KiB`（协议面 head+tail 截取）; `ToolMetadata.maxOutputBytes`（工具元数据层）; usage-observability.ts 记录 `truncated` 标志。流式档 streamOutputCapBytes（continuous 256KiB, replayable 0=不流式）, core.ts DELIVERY_PROFILES。**其他**: `context-history-entries.ts`、`residency.ts`（驻留策略）、project memory（core/src/memory/, memory-file-path.ts）、`context-refresh.ts`。

## 11. Subagents

**支持且深集成**。工具: `Agent`（tool/handlers/agent.ts; 旧名 Task/subagent 也在 hydration 的 `SUBAGENT_TOOL_NAMES`）+ Explore 专用子代理（subagent/explore.ts, createExploreSubagentPort）。

**生命周期**（subagent/runner.ts, 915 行级）: `SubagentPort` 接口含 `SubagentLaunchRequest/RunRequest/StartRequest`, `SubagentSendMessageRequest`, `SubagentStopOptions`, `SubagentWaitOptions`, `SubagentTaskSnapshot`, `AgentBackgroundedOutput`; **每个子代理独立 sessionId**（`createSessionId()` 在 runner 中调用）+ child trace context; profile 驱动: `AgentProfile`（subagent/profile.ts, frontmatter 解析 profile-frontmatter.ts, 每 profile 可选 modelSelection + getAllowedTools 白名单）; 前台/后台双生命周期（`runInBackground === true || profile.background === true`）; 完成经 `ParentTaskNotificationCommand`/completion-notification.ts 通知父会话; `runtime-task-registry.ts` 维护活动子任务。

**协议可见性**: `subagentRow {parentToolCallId, subagentType, status: running|success|failed|cancelled, summaryText, childSessionId?, backgrounded?, workId?}`（rows.ts）——**存在 childSessionId 时 UI 可下钻订阅 conversation/<childSessionId>**（rows.ts 注释明言「不内嵌 child rows」）。**事件转发**: subagent/tool-event-mirror.ts 把子代理的 ToolCall{Scheduled,Started,Progress,Result,Error} 与 Permission{Requested,Resolved,Denied} 事件镜像进父会话事件流, toolCallId 前缀 `tool_subagent`, source="subagent"。StatePatch 有 `subagents` 键（subagentProjectionStateSchema）。**并行**: spawn 多个 + 后台运行皆支持; steering: subagent/message-steering.ts。

## 12. PTC (Programmatic Tool Calling)

ZCode 没有 Anthropic 式「tool-use code API」，但有两条「模型写代码调能力」通道:

1. **NodeRepl（js 工具）**: tool/handlers/node-repl.ts —— 「每个 zcode session 一个持久 NodeReplSession，跨多次 js 调用保持内存状态（globalThis），key = context.sessionId」（node-repl.ts 注释）; 契约 JsInputJsonSchema/JsOutputSchema（@zcode/contracts）; host 进程 packages/node-repl-host; REPL 内可访问 `agent.browsers`（browser-use 插件启用时 browserControlPort 透传, setupBrowserRuntime）。模型在一个持久 JS 沙箱里编程式组合能力 —— 这是 ZCode 最接近 PTC 的机制。tool-input-validation-model-content.ts 处理 REPL 的模型内容校验。

2. **Dynamic Workflow（dwf）**: 模型用 `CreateWorkflow` 工具提交一段脚本 → `validateCreateWorkflowSource`/`resolveCreateWorkflowInput`（create-workflow-source.ts）**先静态 typecheck against facade**（dynamic-workflow 包: compiler/engine/facade/lowering/schema/analysis, 含 phase marker 诊断 `collectPhaseMarkerDiagnostics`）→ 用户在 gate 确认（`prepareApproval` 裁掉编译不过的弹窗, create-workflow.ts 注释）→ `DynamicWorkflowRunPort.submit` 后台起 run（输出 `{status:"backgrounded", backgroundTaskId: runId}`）→ 引擎在 dynamic-workflow-runtime（harness.ts, child 进程 child-entry-file.ts/child-source.ts）执行 → 进度以事件 `DynamicWorkflowRunProgress` 追加到**父会话**（「run 自己没有会话」, session.events.ts 注释）→ 投影进 StatePatch `workflowRuns` 键（workflowRunsStateSchema, workflow-runs-reducer.ts 641 行）。协议面有整套查询/控制: `v4/conversation/workflowRuns/workflowRunEvents/workflowRunArtifacts/workflowRunArtifactData/workflowRunNodeResult/workflowRunWorkspace/workflowRunArtifactRead` + 命令 `resumeWorkflowRun`/`cancelBackgroundWork`/`startSavedWorkflow`/`amendWorkflowRunSettings`/`saveWorkflow`/`amendWorkflow*`/`getWorkflowRun*`/`listWorkflowRuns`/`evalWorkflowSnippet`。脚本的 `artifact.*` 发布与顶层返回值是两套物（workflow-artifacts.ts 文件头注）。

**中间事件**: dwf run 的节点进度（workflow-runs-node-progress.ts, phases/concurrency/lineage 模块）实时入父会话; NodeRepl 无中间事件（单工具调用）。tools.ts（runtime/methods）把两类工具注册进 provider-visible contract（tool/provider-visible-order.ts 定序）。



## 13. Capability matrix

| Capability | ✓/✗/partial | 证据 |
|---|---|---|
| Session | ✓ | `createSession` command（command.ts）; AgentRuntime.sessionId（agent-runtime.ts）; SQLite store（paths.ts getDefaultSessionDbPath） |
| Resume | ✓ | `resume.ts` + SessionResumedPayload{interruptedToolCount, recoveredSteerInputCount...}（session.events.ts）; subscribe mode:"resume"（transport.ts） |
| Streaming | ✓ | `row.delta {path, append}`（delta.ts）; deliveryProfile continuous 30ms flush（core.ts） |
| Cancellation | ✓ | `stop` command + expectedForegroundExecutionId（command.ts）; Interrupt/Cancel events; ToolCancelled（call-runner.ts）; turnAbortSignal（turn-loop.ts） |
| Approval | ✓ | pendingInteractions + resolveInteraction + permissionOptionSchema allowOnce/allowAlways/deny/custom（snapshot.ts, command.ts） |
| Tool events | ✓ | ToolCallScheduled/Started/Progress/Result/Error/BatchComplete（session.events.ts）; toolCallRow.status 6 态（rows.ts） |
| File changes | partial | `v4/conversation/fileChanges` + FileDiff{additions,deletions}（session-store.port.ts）+ TurnFileChangeSummary —— 但无独立 file.changed 事件流, hunk 级内容不在协议 |
| Terminal | partial | Bash 工具 + outputPreview + backgroundBashOutput RPC（background-bash-output.ts）; 无 PTY/终端复用暴露 |
| Background task | ✓ | backgrounded/workId（rows.ts）; BackgroundTaskStarted/Updated/Completed; cancelBackgroundWork/resumeWorkflowRun（command.ts）; background-task-registry.ts |
| Parallel tools | ✓ | ToolScheduler parallelGroups, DEFAULT_MAX_CONCURRENCY=10, 拓扑排序（scheduler.ts） |
| Compaction | ✓ | autoCompactIfNeeded + microcompactIfNeeded + CompactReason 三类 + rapid-refill 熔断（compact.ts, turn-loop-state.ts） |
| Subagent | ✓ | Agent tool + SubagentPort + subagentRow.childSessionId 下钻订阅 + tool-event-mirror（rows.ts, tool-event-mirror.ts） |
| Usage | ✓ | StatePatch.usage（delta.ts）; TurnUsageRecord/ToolUsageRecord/ModelUsageRecord（sqlite-session-store.ts）; v4/conversation/usage + v4/usage/stats |
| Reasoning events | ✓ | reasoningRow（rows.ts）; SessionResumedPayload 带 reasoning backfill migration 0022-backfilled-session-reasoning（migrations/） |
| PTC | partial | NodeRepl 持久 JS 会话（node-repl.ts）+ DynamicWorkflow 脚本引擎（create-workflow.ts, dynamic-workflow 包）——非模型 API 级 tool-use-in-code |

## 14. Shell 必须看到 vs Runtime 内部

1. **协议只暴露投影（Row/Delta/StatePatch），不暴露模型消息**。模型 API messages、provider 请求结构、cache-control 锚点全部是 runtime 内部（buildRuntimeProviderRequestMessages, turn-loop.ts）；Shell 若自研，只需实现 Row 投影 + 5 个 delta op。
2. **事件日志水位（logEpoch+seq）是恢复协议的核心**。Shell 必须持久化每个 topic 的最后 seq 才能做断线 resume；snapshot 是 fallback 而非常态（subscribeParamsSchema.base, transport.ts）。
3. **deliveryProfile 是产品分档契约**：desktop=continuous（流式文本+30ms flush）、web/mobile=replayable（不流式、靠 progress 字段+回放）。Shell 必须按自己的形态选档并诚实上报 clientMode。
4. **能力协商是 optional-boolean 加法演进**：HostCapabilities/ClientHello 用 `=== true` 判断缺失（workspaceHookReview 等）；Shell 实现新能力字段必须容忍旧端忽略。
5. **审批是数据不是回调**：pendingInteractions 在 StatePatch 中是普通状态键，回执走 `resolveInteraction` 命令；Shell 不需要实现 RPC 回调通道，只需渲染状态 + 发命令。
6. **权限三档（allow/ask/deny）+ 四种 option kind（allowOnce/allowAlways/deny/custom）由 runtime 裁决**；Shell 只展示 options 与 freeText；`modifiedInput`（参数改写）发生在 runtime，Shell 无需理解规则引擎。
7. **toolCallId 是全链路关联键**：subagent 镜像事件前缀 `tool_subagent`、审批 interaction 锚定 approvalInteractionId、后台任务 workId —— Shell 做聚合 UI 时依赖这些 id 关联而非时序猜测。
8. **工具并行的语义由 runtime 保证**：Shell 不需要理解 parallelGroups/拓扑排序，只按 row.upserted 顺序渲染即可；但 Shell 若自研 scheduler，需实现 readOnly/destructive/concurrentSafe/sideEffectScope 四元判定 + 环检测。
9. **后台任务的输出是拉取式**：running 态有界 outputPreview 推送，全量输出经 `v4/conversation/backgroundBashOutput` 拉取（8KiB 上限 + outputPath 落盘截断标志）——Shell 必须实现这对推/拉组合，不能假设全量输出会推来。
10. **文件变化是工具结果的投影而非独立事件**：Shell 要展示 diff 需组合 toolCallRow（Edit/Write）+ TurnFileChangeSummary + `v4/conversation/fileChanges`；hunk 级 patch 不进协议，需要 UI 自行从 workspace 文件重算或拉 preview。
11. **回滚有两层**：会话层（editUserQuery/retryTurn/forkAssistant 按 conversationRowTarget 定位）与文件层（applyFileRewind + checkpoints）——Shell 的撤销 UX 应区分这两层而非做单一 undo。
12. **Compaction 对客户端几乎透明但有痕迹**：CompactBoundary/MicrocompactBoundary 事件 + row 层 summary/removedEventCount；Shell 需要渲染「已压缩」分界条，但不能假设历史 rows 会消失（projection 保留 timeline）。
13. **Subagent 的正确客户端形态是「行 + 按需订阅」**：subagentRow 只带 summaryText/childSessionId，子对话通过订阅 conversation/<childSessionId> 下钻 —— Shell 不应期待父会话流内嵌子代理全部输出。
14. **超时/预算是 runtime 职责但 Shell 需要感知**：ToolDeadline 可暂停（准入排队不计入）、rapid-refill 熔断抛错、output token continuation 续跑 —— Shell 会看到「工具失败→自动重试/继续」的非线性序列，不能按「一次调用=一次结果」假设。
15. **多客户端并发是头等设计约束**：subscriberBuffer 上限（500 ops/1MiB）、deliveryKind=recovery、idempotencyTablePerSession=512、pendingCommandsDisplayMax —— Shell 必须把「另一个客户端可能同时发命令/已消费事件」当作常态处理。

