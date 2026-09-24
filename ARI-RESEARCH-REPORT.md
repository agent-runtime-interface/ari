# ARI 前期技术调研报告

> ARI 是项目名，不是首字母缩写——一套面向 Coding Agent Harness 的运行时协议。
> 方法：以**源码与真实协议实现**为主要依据（每条关键结论都有 `path` + `symbol` 级引用，见 `research/01…08`），产品文档仅作补充并标注。
> 本报告回答一个问题：现有主流 Coding Agent 的 Harness 之间，哪些是**真正共同的运行时抽象**，ARI v0.1 应该标准化什么、不该碰什么。

---

# Part A：现有实现调查

详细调查（每对象 2000+ 字、全量引用）在 `research/` 目录；此处为结论级摘要。

## A1. DSH（DeepSeek Harness）— [research/01-dsh.md]

**形态**：开源 monorepo（github.com/deepseek-ai/deepseek-harness，v0.1.7-alpha.1），"everything is a plugin"，构建于 Cordis。出厂 profile：`web / headless / sdk / sdk-minimal / acp`（docs/architecture.md:19）。

**核心抽象**：
- **Session = append-only `SessionEvent` 日志**（`ctx.sessions`）："Model-visible means logged" 运行时不变量——凡进入模型请求的必须可从日志重建（architecture.md:125）。持久事件词汇：`turn/start|end`、`step/start|end`、`user/message`、`developer/message`、`system/message`、`assistant/message`（嵌入完整定时原始流 + usage）、`assistant/attempt`（失败/取消 attempt，log-only）、`tool/call`（原始未解析 arguments）、`tool/result`（+ 工具私有 `meta`）、`request/header|context`、`session/end-seed`（packages/core/session/src/types.ts；docs/subsystems/session.md:27-174）。插件合并扩展：`compaction/*`、`approval/asked|decided`、`todo/write`、`goal/*`、`tool/ptc-dispatch*` 等。
- **事件三域**：durable session events / live `agent/*` 扩展点（pre-step、request、assistant-stream、inbox）/ capability seams（`fs/*`、`tools/*`）。
- **Turn flow 状态机**（architecture.md:88-113）：`turn/start → claim 输入 → agent/pre-step(waterfall) → step/start → agent/request → 流式 llm/stream → tool/call* → tools/pre|execute|post-execute → step/end →（工具欠请求或新输入→下一 step）→ agent/turn-stopping → turn/end`。重试在 `agent/request-error`（llm-retry）；循环检测为 `repeat-tool-reminder` 插件；并行工具 `isConcurrencySafe` 显式 opt-in。
- **对外协议面（4 个）**：① SDK JSON-RPC over stdio（newline-delimited，方法仅 `initialize`、`session/prompt`→durable 回执、`shutdown`；通知 `session.event`/`session.status`/`subagent.started|finished`；明确无 cancel/版本协商，packages/sdk/protocol/README.md:113-115）；② **ACP automation-only server**（packages/acp）；③ Web GUI（HTTP + `/api` typed Remote 层 + SSE 流，api/ 控制器族）；④ Webhook（fire-and-forget 会话创建）。
- **Approval**：闭式 `ApprovalOutcome = allowed-once | rejected | cancelled | unavailable`（fail-closed，无 allow-always），per-session 策略 `ask | never`，`ApprovalRequest` 刻意不含参数（用 `callId` 关联已流式展示的 tool call）；开放式问题走独立的 `user-questions` seam（`ask_user_question`，intent 如 `plan-review`）。
- **Compaction**：log-only 三事件 + 摘要以唯一一次 surface 变更（`user/message` + `surfaceOp:replace`）落盘；触发 `pressure | context-overflow`；可选 tool-result 裁剪、image offload；崩溃留下可检测孤儿锁。
- **PTC**：`ctx.ptcRuntime`（沙箱 JS 程序 + host bindings）；`run_code` 工具下**每个被桥接的 sub-call 产生 `tool/ptc-dispatch-start|dispatch` 事件并重入完整工具管线**（tool-catalog.md:22）。
- **Subagent**：可插 provider（in-process / dsh-sdk / acp 桥），`subagent|subagent_fork` 工具 + `send_message/interrupt_agent/list_agents` 控制工具；实验性 Agent Teams（roster/task board/mailbox）。

## A2. ZCode — [research/02-zcode.md]

**形态**：zai-org/ZCode（TS pnpm monorepo）。Runtime = `apps/zcode-cli` 子 monorepo；客户端经 `zcodeProtocolClient`（stdio transport）→ bootstrap 协议服务（v4-bridge）→ `AgentRuntime`。

**客户端协议 "Protocol V4"**（`packages/shared/src/zcode-protocol-v4/`，`V4_WIRE_PROTOCOL_VERSION=3`，自述**未冻结**）：双面 = **JSON-RPC 命令 + topic 发布/订阅**。握手协商 `clientMode`（desktop-continuous | web-remote-replayable）与 `HostCapabilities`；订阅带 **watermark `{logEpoch, seq}`** → ack 后以 `snapshot | resume` 模式投递；>1MiB 帧分片 + crc32；~35 个 `v4/*` RPC（conversation subscribe/resync/fileChanges/usage…）；命令带幂等键与 baseRevision CAS。
**最重要的设计**：**客户端只见投影**——`ConversationRow`（9 种：turnHeader/userInput/assistantText/reasoning/toolCall/artifact/subagent/hookInvocation/timelineMarker）+ 恰好 **5 种 delta 操作**（row.appended/upserted/removed、row.delta、state.updated）+ 封闭 `StatePatch`（~20 键：usage、queue、pendingInteractions、backgroundWorks、subagents、goal、plan…）。Runtime 内部是事件溯源（~90 种 SessionEventType）+ SQLite；不变量 `reduce(transcript) ≡ reduce(events)`。
**审批**：`pendingInteractions {kind: permission|userInput|workspaceHookReview}` + `resolveInteraction` 命令；**Runtime 侧支持 `modifiedInput` 参数改写**（独有）；选项 allowOnce/allowAlways/deny/custom。
**其余**：双层 compaction（auto+micro）、PAUSABLE 工具超时、`repeatedToolCallSignature` 循环检测、并行调度 maxConcurrency 10、subagent 独立 sessionId + drill-down + 事件镜像（`tool_subagent` 前缀）、PTC 半原生（持久 NodeRepl + DynamicWorkflow 脚本引擎）。

## A3. Codex CLI（codex-rs）— [research/03-codex-cli.md]

**形态**：openai/codex 的 Rust 实现（HEAD 44b857c00e）。
**消息模型三层**：`ResponseItem`（模型 wire）→ `ResponseEvent`（SSE 解码）→ `EventMsg`（**面向客户端的 ~60 变体枚举**，protocol.rs:1341）。新命名：`TurnStarted/TurnComplete`、`Op::TurnInput`、`AgentMessageContentDelta`、`ReasoningContentDelta`；提交封装已移除（`CodexThread::submit(Op)->String`）。
**Session**：append-only JSONL `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid7>.jsonl`（`RolloutLine{timestamp, ordinal, item}`）；`codex resume [id|--last|--all]`、fork = `InitialHistory::Forked` + `forked_from_id`；崩溃恢复 = 重新打开 + 反向 JSONL 扫描 + 打印 resume 提示；SQLite state db。
**Loop**：`run_turn → run_pre_sampling_compact → build_prompt → try_run_sampling_request` 流式循环；**并行工具 = in_flight `FuturesOrdered`**（turn.rs:2502）；重试 5s→60s 退避 + `StreamError` 事件；`Op::Interrupt → CancellationToken → TurnAborted{Interrupted|Replaced|ReviewEnded|BudgetLimited}`；无 max_turns。
**审批**：`AskForApproval{UnlessTrusted, OnRequest(默认), Granular{5 toggles}, Never}` + `SandboxPolicy`；`request_command_approval` 把 oneshot 放入 `TurnState.pending_approvals` 并发 `ExecApprovalRequest`（**不应答 ⇒ Abort**）；`ReviewDecision` 8 变体，含 `ApprovedForSession`、`ApprovedExecpolicyAmendment`、`NetworkPolicyAmendment`。
**传输**：`codex proto` **已不存在**——① 进程内 async_channel（TUI）；② `codex exec --json` 单向 JSONL；③ app-server 双向 JSON-RPC。
**原生 Subagent**（spawn_agent/send_message/wait_agent/close_agent/resume_agent，真实 thread + parent_thread_id）与**原生 PTC**（Code Mode：V8 JS runtime，工具从 JSON Schema 生成 TS 类型，嵌套工具调用经 ToolRouter 回路由）。

## A4. OpenCode — [research/04-opencode.md]

**形态**：客户端/服务器架构（origin anomalyco/opencode，v1.18.32）。TUI/App/CLI 都是 HTTP/SSE 客户端；`packages/schema`（Effect Schema 契约）← `packages/protocol` ← `packages/core`（SQLite/drizzle + EventV2）← `packages/opencode`（instance runtime + Effect HttpApi server）。V1 loop 与 V2 durable runtime 并存。
**消息模型**：12 种 Part（text/reasoning/file/agent/subtask/tool/step-start/step-finish/snapshot/patch/retry/compaction）；**tool part 状态机 `pending→running→completed|error`（无 cancelled，abort→error）**。事件名（真实）：`session.created/updated`、`message.updated`、`message.part.updated/delta{field,delta}`、`session.idle`、`session.compacted`、`permission.asked/replied`、`question.asked/replied/rejected`、`file.edited`、`file.watcher.updated`、`pty.*`、`todo.updated`、V2 `session.next.*`（~30）。
**Loop**：`SessionPrompt.loop` while(true)，每 turn 一次 `llm.stream`；退出条件 finish ∉ {tool-calls, unknown} 且无 pending 工具；`agent.steps ?? Infinity`；overflow 触发 auto-compaction；并行工具经 ai-sdk callID-keyed 结算；retry = status+RetryPart；无全局超时/预算。
**权限**：ruleset（agent+session 合并）`allow/ask/deny` + pattern；`permission.asked` → 阻塞 Deferred → 回复 `once | always | reject`（**reject 携带用户反馈文本回灌模型**，always 自动放行同类 pending）；无参数改写。
**特有**：PTY 一等公民（`/api/pty` CRUD + `pty.*` 事件）；git shadow snapshot 回滚；子代理 = **真实子 session**（parentID、深度限制 1，**事件不转发——客户端从 tool part `metadata.sessionId` 自行订阅**）；PTC 实验性（code-mode `execute`，仅 MCP 工具）；完成语义 = `session.idle` + `/wait`。
**传输**：REST + SSE `/api/event`（`{id: evt_, type, properties}`，10s 心跳，按 workspace 过滤）。

## A5. Pi（badlogic/pi-mono）— [research/05-pi.md]

**形态**：包结构与预期不同：`agent`（runtime 核心）、`ai`（provider 层）、`coding-agent`（CLI）、`tui`、`chord`、`protocol/server/client`（实验多客户端 CBOR）、`durable`；另有部分实现的 next-gen durable harness（Lanes + durable Tasks）。
**Runtime 事件恰好 10 种**（agent/src/types.ts:485-500）：agent_start/end、turn_start/end、message_start/update/end、tool_execution_start/update/end；产品层再加 `agent_settled`（"不再有自动工作：重试/溢出恢复/队列都结束"——ARI 需要这个语义）、`queue_update`、`compaction_start/end`、`auto_retry_*` 等。
**消息模型**：4 role + 扩展自定义 role（declaration merging + `convertToLlm` 边界）；**SystemMessage 携带 prompt + 工具装载的增量 delta**（sections + toolsAdded/toolsRemoved），持久化与 wire 同一机制。
**Session**：append-only JSONL **树**（entry `{id,parentId}`，leaf=最后 entry；分支=移动 leaf 指针；fork=复制路径到新文件；`ContextEditEntry` 追加式改写）；崩溃容忍=跳过坏行 + 延迟建文件。
**关键取舍**：**无内置权限系统**（README 明示）——扩展 `tool_call` hook 返回 `{block,reason}` + 通用 UI 对话框（RPC `extension_ui_request/response`）；**无 max iterations/循环检测/PTC/内置 subagent**；`stopReason==="length"` 使该消息**全部**工具调用失败（截断参数安全）；工具结果双通道 `content(模型)/details(UI)`。
**传输**：TUI/print/json/RPC（strict-LF JSONL，~30 命令，背压感知，stdin 关闭=优雅停机）/in-process SDK/实验 CBOR 多客户端。

## A6. ACP（Agent Client Protocol）— [research/06-acp.md]

**形态**：Zed Industries 的公开标准（agentclientprotocol.com）。**Client(editor) ↔ Agent 子进程**；一连接多 session。
**传输**：JSON-RPC 2.0 over stdio，**newline-delimited**（非 Content-Length），stdout 纯净性规则；协议声明 transport-agnostic（HTTP/WS 是 RFD 草案）；整数 protocolVersion 仅 MAJOR + capability 位；**wire 版本与 SDK/schema 工件版本解耦**。
**会话**：`session/new|load|resume|close|list|delete|prompt|cancel|set_config_option`；`session/load` 通过 session/update **全量重放历史**后再应答；v1 中 `session/prompt` 的**响应即 turn 结束**（`stopReason: end_turn|max_tokens|max_turn_requests|refusal|cancelled`）——v2 草案解耦（`state_update running|idle|requires_action`）。
**流**：11 种稳定 `session/update`（agent_message_chunk、agent_thought_chunk、tool_call(+update, 10 种 kind、pending→in_progress→completed|failed、content=content|diff|terminal、rawInput/rawOutput)、plan、usage_update{used,size,cost?}…）+ unstable（compaction 等）。
**Client-tool 反转**：v1 让客户端当工具提供方（fs/read_text_file、fs/write_text_file、terminal/create|output|kill…、elicitation/create）——**v2 草案删除了整个 client 执行面**（"除少数 IDE 外实现不一致"），改为客户端经 MCP 服务器注入工具。**这是 ARI 不应复制该设计的直接证据。**
**审批**：`session/request_permission {toolCall, options[{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}]}` → `{outcome: selected|cancelled}`；**无参数改写**；两级取消（`session/cancel` + `$/cancel_request`/-32800）。
**不覆盖**：subagent、后台任务（v2 draft "beyond the turn" 才有）、每 turn token（Draft RFD）、compaction（unstable）、PTC。

## A7. Codex App Server — [research/07-codex-app-server.md]

**形态**：openai/codex 内 `codex-rs/app-server`——IDE 扩展/外部客户端驱动 Codex 的 JSON-RPC API（本 checkout 为 **v2 `thread.*` 命名**；legacy `newConversation/codex/event/*` 已不存在）。
**传输**：line-delimited JSON over stdio + unix control socket + websocket + remote-control；**双向**：9 种 server→client request 类型；多连接 fan-out。
**规模**：~150 个 client→server 方法（`thread/*`、`turn/*`、`fs/*`、`process/*`、`plugin/*`、`queue/*`…）+ ~110 个通知（`item/*`、`thread/*`、`turn/*`、`account/*`）。**三级坐标信封：几乎每个通知都带 `thread_id/turn_id/item_id`**。
**统一 item 抽象**：16 类 ThreadItem 以 `item/started|completed` 包夹 `item/*Delta`。
**审批**：封闭决策枚举 `Accept | AcceptForSession | AcceptWithExecpolicyAmendment | ApplyNetworkPolicyAmendment | Decline | Cancel`（item.rs:66）；**不能修改命令**，但可附策略修正；`available_decisions` 服务端声明；`approvals_reviewer=auto_review` 可让服务端 subagent 代批。
**Client tools 反转存在**：`thread/start.dynamic_tools` → runtime 发 `item/tool/call` 请求 → 结果回灌 core。
**Usage**：`thread/tokenUsage/updated`（cached/cache_write/reasoning_output 分列）+ rateLimits 双通道。
**覆盖修正**：compaction 有（`thread/compact/start`，不可参数化）；terminal 很全（command/exec、process/*、backgroundTerminals）；subagent 只有事件面（SubAgentActivity/CollabAgentToolCall item）无编排 API；文件 diff 为文件级统一 diff（FileUpdateChange）；raw 模型流需 experimentalRawEvents opt-in。

## A8. 次要对象：Claude Code 与 Gemini CLI — [research/08-related.md]

**Claude Code**：CLI 闭源（未做二进制审计）；权威协议面 = npm `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts`（9451 行）。`SDKMessage` 38 成员 + **同一 JSON-Lines 信道上多路复用控制帧** `control_request/response/cancel_request`（37 子类型，sender-chosen request_id，KeepAlive）；`initialize` 响应带 `pending_permission_requests`（**mid-join 重放挂起审批**）与 `capabilities[]` 字符串能力协商；`can_use_tool` → `allow{updatedInput!}/deny{interrupt}`（**审批可改参数**）；6 种 permission mode；33 hook events；`stream_event` 包裹原始 API delta；`compact_boundary{trigger, pre_tokens, post_tokens, preserved_messages}`；后台任务事件族 + `stop_task`；`rewind_files`；interrupt 回执（`interrupt_receipt_v1`）。
**Gemini CLI**：开源。核心事件 `ServerGeminiStreamEvent`（18 型 GeminiEventType，含 `LoopDetected`、`MaxSessionTurns`、`ContextWindowWillOverflow`）；事实 wire = `--output-format stream-json`（init/message/tool_use/tool_result/error/result）；调度器 7 状态机（validating→awaiting_approval→executing→…）；`ToolConfirmationOutcome` 7 值（含 `modify_with_editor`）；**确认的 ACP 适配器**（packages/cli/src/acp/）；压缩可见（`ChatCompressed`，0.5 阈值）；无 fork、无 interrupt 回执、无后台任务通知族。

---

# Part B：Common Runtime Model（从实现中抽象）

以下每条概念都有≥3 个实现的直接证据；标注了最强证据来源。

**B1. Session = 不可变事件账本 + 身份 + resume。**
DSH：append-only SessionEvent 日志、generation 永不改写 [01]；Pi：append-only JSONL 树（分支=移 leaf）[05]；Codex：rollout JSONL（append-only + ordinal）[03]；ZCode：SQLite + 事件溯源 + `reduce(transcript)≡reduce(events)` [02]；OpenCode：SQLite + EventV2 [04]；Claude：SessionStore/rewind [08]。**没有任何一家把"会话"实现为可变消息数组。**

**B2. 客户端看到的是"投影事件流"，不是模型消息。**
ZCode 是最自觉的实现（客户端只见 ConversationRow + 5 种 delta 操作 + StatePatch [02]）；DSH 用 SurfaceEventType/surfaceOp 区分模型面与日志面 [01]；Codex EventMsg 独立于 ResponseItem [03]；OpenCode Part/事件系统 [04]；ACP session/update [06]。**"模型 API 消息"与"Harness 运行时事件"的分离是全部实现的共同结构**——ARI 该标准化的是后者。

**B3. Turn = 工作单元；Step = 一次模型调用。**
DSH turn/step 双层事件 [01]；Codex turn/step [03]；OpenCode step-start/step-finish Part [04]；Pi turn_start/end [05]；ZCode turnHeader row [02]；Gemini MaxSessionTurns [08]。turn 有 ID/序号、有结局（见 B4）。

**B4. 提交与完成解耦：prompt 回执 ≠ turn 结局。**
DSH `session/prompt` 返回 durable enqueue receipt `messageId` [01]；Pi `agent_settled` vs `agent_end` [05]；OpenCode `session.idle` + `/wait` [04]；Claude `user_message_uuid` 绑定 + `result` 消息 [08]；ZCode 命令幂等键 + 队列/状态补丁 [02]；ACP v2 `state_update` [06]。**ARI 必须把"已接受"与"做完了"定义为两个语义。**

**B5. 工具调用生命周期 = correlation id + 封闭状态机。**
callID 关联：所有实现。状态机：OpenCode `pending→running→completed|error`（无 cancelled）[04]；ACP `pending→in_progress→completed|failed` [06]；ZCode toolCallRow 7 态（含 pendingApproval/backgrounded）[02]；Pi start/update/end + isError [05]；Codex Begin/End [03]。收敛形态：**started → (progress*) → completed|error**。

**B6. 人机交互有两个不同通道：闭式审批 + 开放式提问。**
闭式（decision-only）：DSH ApprovalOutcome [01]、Codex ReviewDecision [03]、ACP permission options [06]、OpenCode once/always/reject [04]、ZCode permission [02]、Gemini ToolConfirmationOutcome [08]。
开放式（自由作答）：DSH user-questions [01]、OpenCode question.asked [04]、ZCode userInput [02]、Gemini ask_user confirmation [08]、Claude AskUserQuestion 工具。
**把两者混成一个是设计错误**（DSH 明确分 seam）。

**B7. 流式 = 有序增量事件 + 结算。**
文本 delta：8/8。推理 delta：7/8（Claude 为 partial）。工具输出流：DSH(无)/ZCode(row.delta)/Codex(ExecCommandOutputDelta)/OpenCode(metadata per chunk)/Pi(partialResult)/Gemini/Claude——**粒度不一，但"增量+最终结算"双层结构一致**（DSH：transient chunk + durable settlement [01]；Pi：message_update + message_end [05]）。

**B8. 取消是显式意图，且有因果。**
DSH `cancel(cause)` [01]；Codex TurnAborted{4 reasons} [03]；ZCode stop [02]；OpenCode fiber cancel [04]；Pi abort [05]；ACP session/cancel + 请求级 `$/cancel_request` [06]；Claude interrupt+receipt [08]。

**B9. Usage 是协议面的一部分。**
8/8 有 token 计量；粒度分化（每消息 [01][05]、每 turn [07][08]、session 级 [06]）+ rate limits（Codex/Claude）。

**B10. Compaction 是 Runtime 内部行为，但产生可见事件。**
Claude compact_boundary、OpenCode session.compacted、Pi compaction_start/end、DSH compaction/* 事件、Codex ContextCompacted、Gemini ChatCompressed、ZCode Compact*。ACP 是唯一没有的（unstable）。**共识：算法私有，事件公开。**

**B11. 能力协商 + 版本化。**
ACP protocolVersion+capability 位 [06]；Claude capabilities[] [08]；ZCode HostCapabilities/clientMode [02]；DSH 版本协商缺失本身是反面教材（已知限制 [01]）。

**B12. Mid-join / replay。**
ACP session/load 全量重放 [06]；ZCode watermark snapshot|resume [02]；DSH projection snapshot + session/event 全量转发 [01]；Claude pending_permission_requests 重放 [08]；Codex rollout 重放 [03]。

**B13. 工具集是 Runtime 资产，不是协议资产。**
没有任何协议标准化工具体（ACP 只声明 promptCapabilities；Codex App Server 列工具但不定义语义；ZCode 每轮 disallowlist）。MCP 是工具接入的事实标准（8/8 集成）。**ARI 不定义工具，只定义工具调用的事件形状。**

**最少概念集**（一个现代 Coding Agent Runtime 的"名词表"）：
`Session`、`Event(seq)`、`Turn`、`Step(隐式)`、`Message delta`、`ToolCall(call_id, status)`、`Approval(decision)`、`Question(answer)`、`Cancellation(cause)`、`Usage`、`Compaction(事件)`、`Capability/Version`。

---

# Part C：Divergence（差异与取舍）

## C1. 必须标准化（所有实现都有，且语义可统一）

| 概念 | 依据 |
|---|---|
| JSON-RPC 信封 + NDJSON 分帧（推荐 binding） | ACP/DSH SDK/Codex App Server/ZCode/Pi RPC/Claude 全部 line-delimited；唯一 HTTP 派 = OpenCode |
| initialize + protocolVersion + capabilities | ACP/Claude/ZCode；DSH 缺失是已记录限制 |
| session/new、resume、(list) | 8/8 |
| prompt → 回执；status/idle → 完成 | B4 |
| turn.started/completed + stop_reason | B3/B4 |
| message/reasoning delta | B7 |
| tool started/updated/completed（call_id） | B5 |
| approval.requested/respond（闭式枚举） | B6 |
| session/cancel | B8 |
| error 事件（含 stream/retry 语义） | Codex StreamError、Pi auto_retry、Claude api_retry、Gemini InvalidStream/Retry |
| 每 session 单调 seq + replay 语义 | B12 |

## C2. 应该标准化（多数有、形状略异，v0.x 内统一）

- **usage/updated**：粒度取"每 turn + 会话累计"（Codex [07]、Claude [08]、DSH [01]）。
- **compaction/performed 事件**：仅通知（trigger + 可选 token 前后值，像 Claude compact_boundary [08]）。
- **question/requested/respond**：开放式提问（DSH/OpenCode/ZCode 证据充分）。
- **审批的会话级记忆**：`allow_always`（ACP kind、OpenCode always、Codex ApprovedForSession、Claude updatedPermissions）。
- **审批参数改写**：`amended_input`（Claude updatedInput!、ZCode modifiedInput）——作为 capability flag（`approval.edit_input`），默认关闭。
- **replay/mid-join 参数**：`session/resume {since}`（ZCode/ACP/Claude 证据）。
- **fork**：Claude forkSession [08]、Codex fork [03]、DSH fork-at-turn-boundary [01]、Pi fork [05]、ZCode forkAssistant [02]、OpenCode fork [04]；Gemini/ACP 无。建议 v0.2 capability。

## C3. 可以作为 capability（存在性强分化，强制会破坏"小协议"）

- **subagent**：Codex 原生 [03] / DSH provider [01] / ZCode 子 session+镜像 [02] / OpenCode 子 session 自订阅 [04] / Claude Task [08] vs Pi、ACP 明确不做 [05][06]。→ v0.2+ 事件面（subagent.started/finished + 可选 child session attach）。
- **background task**：DSH jobs 统一 [01]、Codex RunUserShellCommand [03]、ZCode backgroundWorks [02]、Claude task_* [08] vs OpenCode/Pi 弱、ACP 无。→ capability。
- **terminal/PTY 桥**：OpenCode `/api/pty` [04]、DSH terminals [01]、Codex process/* [07] vs **ACP v1 client-exec 在 v2 被删除** [06]。→ 不进 core；terminal 生命周期经工具事件暴露即可。
- **file change 结构化事件**：OpenCode file.edited+patch part [04]、Codex PatchApply/TurnDiff [03]、DSH fs/*+changes feed [01] vs Pi 仅 details.diff [05]。→ v0.1 从工具事件派生；结构化事件作为 capability（`file_changes`）。
- **client tools 反转**（客户端当工具提供方）：ACP v1→v2 删除（反面证据）[06]；Codex dynamic_tools 存在 [07]。→ 不进 ARI v0.1。
- **PTC**：见 C4。

## C4. 应完全留在 Runtime 内部（有证据支持"不该协议化"）

- **上下文装配/deriveMessages/系统提示组装**：全部私有（DSH system-prompt seam [01]、ZCode 投影 [02]、OpenCode system=env+AGENTS.md… [04]）。
- **Compaction 算法/阈值**：私有；协议只有事件（B10）。DSH 的 shadowedSeqs 记账、Pi 的 firstKeptEntryId、OpenCode PRUNE_MINIMUM/PROTECT 都是内部细节。
- **模型路由/重试策略/退避**：私有（Codex 5s→60s [03]、Pi 3 次 2s [05]、OpenCode RetryPart [04]）。协议只要求 `error{retryable?}` 语义。
- **沙箱与工具执行世界**：私有（Codex SandboxPolicy [03]、DSH ctx.sandbox [01]）。协议不感知。
- **PTC 执行**：判断 = **Runtime implementation detail**。证据：DSH 的桥接 sub-call 重入正常工具管线并发普通 `tool/ptc-dispatch` 事件 [01]；Codex Code Mode 嵌套调用经 ToolRouter 回到普通事件流 [03]；OpenCode code-mode 只编排 MCP 工具 [04]。**Shell 无需知道"程序在跑"，只需看到（已有的）工具事件**——最多加一个 `program_started/finished` 可选事件（v0.2，不进 core）。
- **Session 存储格式/generation/迁移**：私有（DSH vN [01]、Codex rollout [03]、ZCode SQLite [02]）。
- **迭代上限/循环检测**：分化（Gemini MaxSessionTurns/LoopDetected [08]、ZCode signature streak [02]、OpenCode agent.steps [04]、DSH repeat-tool-reminder [01]、Codex/Pi 无）——语义上属 Runtime 自保，不是 Shell 关心的契约。

---

# Part D：ARI v0.1 Proposal（最小可用）

> 设计顺序遵守：源码 → 行为模型（Part A）→ 共同抽象（Part B）→ 必要能力（Part C）→ 才有本节。
> 目标：**一个独立开发者几天内可实现**。v0.1 全部核心 = **9 个方法 + 16 种事件 + 1 个握手**。
> （计数更正：原稿写 13，但 D6 表实际列了 14 行——若把可派生的 `file/changed` 排除，核心恰为 13；本轮补入 `approval/resolved`、`question/resolved` 后为 **16 行 / 核心 15**。方法数"9"含 `initialized` 通知，请求方法为 8，见 D3/D4/D5。）

## D1. 原则

1. Protocol 与 Transport 解耦：核心 = 方法名 + payload schema + 排序/重放保证。
2. 只标准化 B1–B12 的共同抽象；C3 一律 capability；C4 一律不碰。
3. 不定义工具体、不定义 UI、不定义 Model Provider、不规定 Harness 内部（含 compaction/PTC/sandbox）。
4. 可扩展性学 ACP/MCP：`_meta` 自由字段 + `_` 前缀保留；未知事件/字段必须被忽略（ZCode 的封闭投影 + ACP 的 open worlds 折中：**枚举封闭于 v0.1，map 开放于 _meta**）。

## D2. Transport binding

- **规范性 binding A（推荐）**：stdio 上的 **JSON-RPC 2.0，newline-delimited**（禁止嵌入换行；stdout 纯净性）。依据：6.5/8 个对象如此（ACP [06]、DSH SDK [01]、Codex App Server [07]、ZCode V4 命令面 [02]、Pi RPC [05]、Claude JSON-Lines [08]）。
- **信息性 binding B**：HTTP + SSE（OpenCode 形态 [04]）：方法 = POST 路由，事件 = SSE 流。核心数据模型不变。
- 不规定：Content-Length 分帧（ACP/Codex 均不用）、WebSocket、Unix socket（可作为未来 binding）。

## D3. 握手

```jsonc
// client → server
{ "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
  "protocolVersion": 1,
  "clientInfo": { "name":"mini-shell", "version":"0.0.1" },
  "clientCapabilities": { "replay": true }            // 可选能力位
}}
// server → client
{ "jsonrpc":"2.0", "id":1, "result":{
  "protocolVersion": 1,                                // 整数，MAJOR-only（ACP 证据 [06]）
  "agentInfo": { "name":"SimpleAgent", "version":"0.1.0" },
  "agentCapabilities": {
    "reasoning": true,          // 会发 reasoning/delta
    "question": false,          // 支持开放式提问
    "approvalEditInput": false, // 审批可带 amended_input（Claude/ZCode 证据）
    "usage": true,
    "compactionEvents": true,
    "replay": true,             // session/resume 支持 since
    "fileChanges": false,       // 结构化 file/changed 事件
    "subagents": false,         // v0.2+
    "backgroundTasks": false    // v0.2+
  }
}}
```
**版本协商失败**（server 不支持所请求 MAJOR）：

```jsonc
{ "jsonrpc":"2.0", "id":1, "error":{ "code":-32008, "message":"unsupported protocol version",
  "data":{ "supportedVersions":[1] } } }
```

- `protocolVersion` 为 **MAJOR-only 整数**（ACP 证据 [06]）；server 支持所请求 MAJOR ⇒ 正常应答（回自身 MAJOR）。
- 不支持 ⇒ `-32008` + `data.supportedVersions`；**连接保持可用**，客户端可用受支持 MAJOR **重试一次** initialize。
- 成功应答之前，除 `initialize` 外的一切方法 → `-32002`（版本重试窗口内亦然）。
- 已 initialize 的连接再次 initialize ⇒ `-32006`（不重协商；重协商须重连）。
- 客户端随后发 `initialized` 通知（对齐 ACP/Codex App Server）；**该通知不参与门控**——server 在 initialize 成功应答后即须接受其余方法，`initialized` 缺失不报错（避免为对齐 ACP 而引入无谓的失败模式）。

## D4. Session 生命周期（client → server，5 个方法）

```jsonc
session/new     { cwd?, meta? }                        → { sessionId, nextSeq }   // nextSeq = 下一条事件将用的序号，新会话为 1（原稿字段名 `seq`，与 resume 统一为 `nextSeq`）
session/resume  { sessionId, since? }                  → { sessionId, replayedFrom, nextSeq, events[], snapshot? }
session/prompt  { sessionId, content: ContentBlock[] } → { messageId }        // durable 入队回执，≠ turn 结局（B4）
session/cancel  { sessionId, cause? }                  → { cancelledTurn?, droppedMessageIds: string[] }
shutdown        {}                                     → {}
```
- **并发 prompt = 入队；不拒绝、也不隐式打断。** turn 运行中收到 `session/prompt` 一律接受并追加到该 session 的 **pending-input FIFO 队列**。`messageId` 的承诺范围严格是"**已持久入队**"——既不表示 turn 已开始，也不表示模型已看到。依据：ZCode 输入队列（`sendQueuedNow/editQueueItem/reorderQueueItem/deleteQueueItem/setAutoDrain`、`TurnMachine.queuePendingInput/drainPendingInputs` [02]）；DSH inbox 的 `nextTurn`+`nextStep` 双有序队列与 claim 语义 [01]。
- **关联义务**：`turn/started` 必须携带 `messageIds: string[]`（该 turn 从队列 claim 的消息，可 ≥1 条——DSH 一次 claim 可领多条 [01]）。缺了它，回执在线上无法与任何事件关联，"已入队"不可验证。
- **队列上限**：实现可设内部上限；超限时必须以 JSON-RPC 错误 `-32005` 拒绝该次 prompt，**不得静默丢弃**。
- **中途转向（steer/inject）不进 v0.1**：DSH `steer()`（最近 step 边界消费）/`followup()`/`inject()` 与 ZCode 的 guide-vs-queue 分化过大 [01][02] → v0.2 capability。
- `since` 省略 = 从头重放。**`since` 超出保留窗口不是错误**：server 必须退化为"`snapshot` + 自保留基点起的全部 `events`"，并用 `replayedFrom` 标明基点（ZCode 由 server 在 `snapshot | resume` 间选模式 [02]）。仅当 server 完全无日志（`replay:false`）时才回 `-32004`。
- `since` > 当前水位（未来序号）⇒ `-32602`（客户端 bug，不静默纠正）。
- **resume 的一致性切面**：应答 `events` 的最后一条 seq < `nextSeq`；此后同一 session 的实时事件 seq ≥ `nextSeq`，**不重不漏**（watermark 语义，ZCode [02]）。
- **`snapshot` schema**（重连重建 live UI 的最小投影；ZCode StatePatch / Claude SessionState 同构 [02][08]）：

```jsonc
{ "status":"running"|"idle", "nextTurn":2,
  "queue":[{"messageId":"m_1","content":[{"type":"text","text":"…"}]}],
  "pendingApprovals":[{"approvalId":"ap_1","toolCallId":"t_1","toolName":"shell","reason":"…","options":[…]?}],
  "pendingQuestions":[{"questionId":"q_1","questions":[…]}],
  "openToolCalls":[{"callId":"t_1","name":"shell","status":"running"}],
  "usage":{ "inputTokens":0, "outputTokens":0 } }
```

- **订阅模型（v0.1 = 隐式订阅）**：连接对"本连接上 `session/new` 或 `session/resume` 成功的每个 session"自动订阅 `event`，**无需 subscribe 方法**；唯一退订 = 关闭连接。同一 session 允许多连接（Codex App Server 多连接 fan-out [07]）：事件广播到全部订阅连接，任一连接上的 `approval/respond` 对全体生效。
- **顺序保证**：`session/prompt` 的应答必须先于"由该 prompt 引起的任何事件"发出（否则 Shell 无法归属事件）；其他来源（先前入队消息、后台工作）的事件可与之交错。跨 session 无序，但同一 session 在所有连接上按 seq 一致投递。
- **cancel 语义**：只作用于**当前在飞 turn**，并**清空尚未 claim 的 pending-input 队列**——即真正的停止；否则队列会立刻重启工作，Ctrl-C 形同虚设。被取消 turn 必须结算为 `turn/completed{stopReason:"cancelled"}`；被丢弃的入队消息经应答 `droppedMessageIds` 与 `snapshot.queue` 可观测，不另发事件。无在飞 turn 时 cancel 为幂等空操作。`cause` 为可选不透明字符串，v0.1 不设闭式枚举（Codex 的 4 种 reason 属 runtime 内部 [03]）。
- `shutdown`：client→server 请求；应答后 server **不得再发事件**，在飞 turn 直接放弃——这是 D9-I1 结算不变量的**唯一豁免**——并应在有限时间内退出。
- `ContentBlock` v0.1 仅 `{"type":"text","text":string}`；`image` 等作为 capability 扩展（ACP/MCP 同款教训：基线最小）。
- `session/list` 列为可选（capability `session_list`），v0.1 不强制。

## D5. 人机交互（2 个方法）

```jsonc
approval/respond { sessionId, approvalId,
  decision: "allow_once" | "allow_always" | "deny",
  amendedInput? }                                    → {}   // amendedInput 仅当 agentCapabilities.approvalEditInput
question/respond { sessionId, questionId,
  answers: [{ id, values: string[] }] }              → {}   // 仅当 agentCapabilities.question
```
决策枚举取各方交集：`allow_once`（DSH allowed-once [01]、ACP allow_once [06]、OpenCode once [04]）、`allow_always`（ACP/OpenCode/Codex ApprovedForSession [03][06]）、`deny`（全部）。参数改写（Claude updatedInput [08]、ZCode modifiedInput [02]）与"拒绝+反馈文本"（OpenCode [04]）都不进 v0.1 枚举——前者走 capability，后者 Shell 可自行再发一条 prompt。

**形状与约束**（补 review 指出的"options 无 schema、提问无拒绝表示、跨断线时效"）：

- `approval/requested.options`（缺省 = 上述三枚举）：`[{ id:"allow_once"|"allow_always"|"deny", label: string }]`。**客户端不得发送未出现在 options 中的 decision**（server 不想要 `allow_always` 就不下发它，无需新增能力位）；违反 ⇒ `-32602`。
- `question/requested.questions`：`[{ id, question, detail?, options?: [{ id, label, detail? }], multiSelect?: boolean }]`；`options` 缺省 = 自由文本作答（`values` 为字符串数组）。**`answers: []` = 显式整体放弃作答**；未出现在 `answers` 里的 question 视为跳过——补上了原稿缺失的"拒绝/跳过"表示。
- **幂等与终局**：每个 `approval/requested`/`question/requested` 以**恰好一个** `*/resolved` 事件终结（D6/D9-I7）。server 必须为每个 id 记住最后一次终局：**同 id + 同 decision 重发 ⇒ 幂等返回 `{}`**（网络重试安全）；**同 id + 不同 decision，或 id 不存在 ⇒ `-32007`**。
- **跨断线时效（B12 的落地）**：挂起交互在 session 存活期间**跨断线保持有效，且不换 id**——重放出的 `approval/requested` 与断线前是同一条 live 请求，Shell 按 id 去重即可；运行时**不得静默过期**，若自行兜底（超时、fail-closed 断连）必须发 `approval/resolved{decision:"expired"|"cancelled"}`（提问侧 `outcome:"expired"`）。重连后的挂起集另由 `snapshot.pendingApprovals/pendingQuestions` 给出（D4），两条通道对同一 id 必须一致。依据：Claude `initialize` 重放 `pending_permission_requests` [08]；ZCode `pendingInteractions` + `resolveInteraction` [02]；DSH fail-closed `unavailable` [01]。

## D6. 事件流（server → client，1 个通知通道）

统一信封（对齐 ZCode 投影 + DSH session.event + Codex 三级坐标）：

```jsonc
{ "jsonrpc":"2.0", "method":"event",
  "params": { "sessionId": string, "seq": integer, "type": string, ...payload } }
```
- **ID / 序号类型（原稿未定义）**：`sessionId`/`messageId`/`callId`/`approvalId`/`questionId` = **不透明字符串**（建议 `s_`/`m_`/`t_`/`ap_`/`q_` + ULID）；`seq` = 整数，**1 起**、每 session 单调 +1、无空洞；`turn` = 整数，**1 起**、每 session 单调 +1（DSH/Codex ordinal 语义 [01][03]）。
- **seq 起点 = 1**：新 session 首条事件 seq=1；`session/new` 返回的 `seq` 即"下一条将使用的序号"（新会话 = 1）。**重放事件与实时事件共用同一 seq 空间**，故 Example 3 的 `since` 语义无歧义。
- **单帧上限（binding A）**：任一 NDJSON 行 ≤ **1 MiB**（1,048,576 字节，不含换行）。超限 payload 必须在**事件层**拆分，绝不切 JSON 值：工具大输出先以 `tool/updated.outputDelta` 分块（每块 ≤1 MiB）流式下发，`tool/completed.output` 此时应为空或摘要，完整载荷放 `meta`/`outputRef`。依据：ZCode >1MiB 帧分片 [02]、Pi 背压感知 [05]。写入侧必须施加背压（阻塞写）而非无界缓冲（Pi [05]）。
- 事件类型（v0.1 全集）：

| type | payload 要点 | 对应证据 |
|---|---|---|
| `session/status` | `status: "running"\|"idle"`；idle 即 Pi `agent_settled` 语义（重试/队列均结束） | [01][04][05] |
| `turn/started` | `turn, messageIds: string[]`（该 turn claim 的入队消息，D4 关联义务） | [01][03][05] |
| `turn/completed` | `turn, stopReason: end_turn\|max_tokens\|cancelled\|refusal\|error` | [03][06][08] |
| `message/delta` | `turn?, text`（assistant 文本增量） | 8/8 |
| `reasoning/delta` | `turn?, text`（cap: reasoning） | 7/8 |
| `tool/started` | `turn?, callId, name, input?` | B5 |
| `tool/updated` | `callId, status: "pending"\|"running", title?, outputDelta?` | [02][04][05] |
| `tool/completed` | `callId, status: "success"\|"error", output?, meta?`（meta 不透明，UI 载荷） | [01][05] |
| `approval/requested` | `approvalId, toolCallId?, toolName?, reason?, options?`（options 缺省 = 三枚举） | B6 |
| `approval/resolved` | `approvalId, decision: "allow_once"\|"allow_always"\|"deny"\|"expired"\|"cancelled"`（每个 requested **恰好一条**） | [02][03][06] |
| `question/requested` | `questionId, questions[{id, question, detail?, options?, multiSelect?}]`（cap: question） | [01][04] |
| `question/resolved` | `questionId, outcome: "answered"\|"declined"\|"expired"`（cap: question；每个 requested **恰好一条**） | [01][04] |
| `usage/updated` | `turn?, usage{inputTokens, outputTokens, cachedTokens?, reasoningTokens?, cost?}` | B9 |
| `compaction/performed` | `trigger: "manual"\|"auto"\|"overflow", preTokens?, postTokens?`（cap: compactionEvents） | B10 |
| `file/changed` | `path, kind: "create"\|"modify"\|"delete"\|"rename", diff?`（cap: fileChanges；v0.1 可由 tool 事件派生） | C3 |
| `session/error` | `error{ code, message, retryable? }` | B8/C2 |

- **排序**：单 session 内严格按 seq；跨 session 无序。同一 session 在所有订阅连接上按 seq 一致投递（D4 订阅模型）。
- **pending 状态可推导**：`approval/requested` 未收到对应 `approval/resolved` = waiting；断线重连后由 `snapshot.pendingApprovals/pendingQuestions` 给出当前挂起集（Claude SessionState `requires_action` [08] 与 ACP v2 同构，可后加）。**原稿"不需要额外 state 位"的说法只在单连接、不重连时成立**——正是 `*/resolved` 事件（+ snapshot）让这条在断线场景下也成立，这也是本次唯一新增事件类型的原因（见 D9-I7）。

## D7. 明确不进 v0.1 的（附理由）

| 排除项 | 理由（证据） |
|---|---|
| 工具体/schema 标准化 | B13；MCP 已解决工具接入，勿重复 |
| client tools 反转（fs/terminal 回调） | ACP v2 删除该面 [06]；Codex dynamic_tools 留在自家 [07] |
| PTC 事件/控制 | C4：runtime detail；桥接调用已是普通工具事件 [01][03] |
| subagent 编排 | C3：分化最大；v0.2 capability（事件面） |
| 后台任务控制 | C3：v0.2 capability |
| fork/branch | C2：v0.2 capability（协议里加 `session/fork` 很容易，但先证明需求） |
| 终端桥（PTY 透传/输出订阅） | C3：ACP v2 反向证据；runtime 自有 UI 通道 [04][01] |
| compaction 控制（手动触发/参数） | Codex App Server 都"不可参数化" [07]；DSH 有手动命令但属 human command 而非协议 [01] |
| 审批策略修正（execpolicy amendment） | Codex 特有 [03][07]，封闭枚举放不下；v0.2 再议 |
| 模型/权限模式设置 | Claude set_permission_mode/set_model [08]、ZCode switchCollaborationMode [02] 属产品面；v0.1 用 `session/new meta` 一次性声明即可 |

## D8. "几天实现"自检

一个 v0.1 兼容 Runtime 的最小义务：stdin JSONL 解析（~50 行）+ initialize/会话三方法/两个 respond 方法（~100 行）+ 把自己的循环事件映射到 16 种事件（~100 行）+ cancel。**无账本、无 compaction、无 subagent 的 SimpleAgent 也能合规**——只要它如实声明 capabilities（不发布 compaction 事件、`compactionEvents:false`）。反向自检：DSH/Codex/ZCode 的现有协议面到 ARI v0.1 的映射都是"改信封、不改语义"级别（见 Example 4）。

## D9. 结算不变量与错误码（回答"该监听哪个事件收尾"）

### D9.1 turn 结算不变量

- **I1（结算）**：同一 session 内，每个 `turn/started` **最终恰好**对应一条 `turn/completed`——无论中途发生 error、cancel、审批拒绝还是工具失败。**唯一豁免**：连接/进程终止（`shutdown` 或崩溃），此时在飞 turn 不再结算，Shell 以连接关闭为准（D4）。
- **I2（error 不替代结算）**：`session/error` 是**带外诊断**，永不替代 `turn/completed`。致命错误也必须以 `turn/completed{stopReason:"error"}` 收尾。这是原稿最缺的一条：实现者应监听 `turn/completed` 收尾、`session/error` 取诊断，二者不可互相顶替。
- **I3（顺序）**：致命错误先发 `session/error`，紧接 `turn/completed{stopReason:"error"}`——只监听 `turn/completed` 的极简 Shell（D8 的 SimpleAgent 正是此情形）也能正确收尾。
- **I4（可重试错误不结束 turn）**：`session/error{retryable:true}` 表示运行时将自行重试，**不要求** turn 结束；同一 turn 可出现多条。Codex `StreamError`+5s→60s 退避 [03]、Pi `auto_retry_*` [05]、Claude `api_retry` [08]、Gemini `InvalidStream/Retry` [08] 均为此形态。
- **I5（无 turn 的 error）**：`session/error.turn?` 可缺省——错误可发生在任何 turn 之前（prompt 校验失败、模型不可达等）。`session/error` 不带 `turn` 时，Shell 不得假定存在在飞 turn。
- **I6（不卡 running）**：任何终止路径之后 session 必须达到 `session/status:"idle"`；idle 即 Pi `agent_settled` 语义（重试/队列全部结束）[05]，Shell 以此判定"不会再自动干活"。
- **I7（交互终局）**：每个 `approval/requested`/`question/requested` 恰好一条 `*/resolved`（D5）。

### D9.2 错误码表

| code | 名称 | 触发 | 可重试 |
|---|---|---|---|
| -32700 / -32600 / -32601 / -32602 / -32603 | JSON-RPC 标准 | 解析 / 请求 / 方法 / 参数 / 内部 | 视情况 |
| -32001 | `session_not_found` | `sessionId` 未知（prompt/resume/cancel/respond 一致，**不自动建会话**） | 否 |
| -32002 | `not_initialized` | initialize 成功应答前调用任何方法（含版本重试窗口内） | 是（先 initialize） |
| -32003 | `unsupported_capability` | 使用 agentCapabilities 声明为 false 的方法/参数（如 `amendedInput`、`question/respond`） | 否 |
| -32004 | `replay_unavailable` | `replay:false`，或服务端完全无日志可回放 | 否 |
| -32005 | `queue_full` | pending-input 队列超实现上限（**不得静默丢弃**） | 是（稍后重发） |
| -32006 | `already_initialized` | 已 initialize 的连接再次 initialize（重协商须重连） | 否 |
| -32007 | `unknown_interaction` | `approvalId`/`questionId` 不存在，或**以不同 decision 重复作答**已终结交互 | 否 |
| -32008 | `unsupported_protocol_version` | initialize 请求的 MAJOR 不受支持（`data.supportedVersions`） | 是（换版本重试一次） |

注：ACP 的 `-32800`（`$/cancel_request`）在 v0.1 不适用——取消是一等方法 `session/cancel`，错误面无需请求级取消码 [06]。

---

# Part E：Examples

## Example 1 — 极简 Shell 连接 Runtime

```
Shell                          Runtime                        Model/Tools
  │ initialize ────────────────▶│
  │◀──────────────── result ────│
  │ initialized (notification)▶│
  │ session/new ───────────────▶│
  │◀──────────────── result ────│
  │ session/prompt "列出文件" ──▶│──▶ LLM stream
  │◀──────────── { messageId } ──│
  │◀─ event seq1 session/status running                        │
  │◀─ event seq2 turn/started {turn:1, messageIds:["m_01JA"]}   │  ← claim 了哪条入队消息
  │◀─ event seq3 message/delta "我来看一下目录…"                │
  │◀─ event seq4 tool/started {callId:t1, name:"shell"} ───────▶│ 执行
  │◀─ event seq5 tool/completed {callId:t1, status:"success"} ◀─│
  │◀─ event seq6 message/delta "目录里有 a.txt, b.md"           │
  │◀─ event seq7 turn/completed {stopReason:"end_turn"}        │
  │◀─ event seq8 session/status idle                            │
```

线上一例（每行一个 JSON）：

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s_01J9","content":[{"type":"text","text":"列出当前目录的文件"}]}}
{"jsonrpc":"2.0","id":3,"result":{"messageId":"m_01JA"}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":2,"type":"turn/started","turn":1,"messageIds":["m_01JA"]}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":4,"type":"tool/started","turn":1,"callId":"t_01","name":"shell","input":{"command":"ls"}}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":5,"type":"tool/completed","callId":"t_01","status":"success","output":"a.txt\nb.md"}}
```

## Example 2 — Approval

```json
// Runtime 决定需要批准（工具已流式展示，参数经 callId 关联，不重复——DSH 证据 [01]）
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":9,"type":"approval/requested",
 "approvalId":"ap_01","toolCallId":"t_02","toolName":"shell","reason":"command matches rm -rf pattern"}}
// Shell 答复（三种闭式决策；approvalEditInput capability 下可带 amendedInput）
{"jsonrpc":"2.0","id":7,"method":"approval/respond","params":{"sessionId":"s_01J9","approvalId":"ap_01","decision":"allow_once"}}
{"jsonrpc":"2.0","id":7,"result":{}}
// 决策终局事件：每个 approval/requested 恰好一条（D9-I7）。Shell 消失/超时/拒绝时 Runtime 自行兜底，
// 也必须以此收尾（decision:"cancelled"/"expired"）——Codex: 不应答⇒Abort [03]；DSH fail-closed [01]
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":10,"type":"approval/resolved","approvalId":"ap_01","decision":"allow_once"}}
// 工具随后正常结算
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":11,"type":"tool/completed","callId":"t_02","status":"error","output":"permission denied"}}
```

## Example 3 — Streaming（断线重连 = replay）

```json
// 正常流：delta 序列 + 结算
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":12,"type":"message/delta","turn":1,"text":"目录里有 "}}
{"jsonrpc":"2.0","method":"event","params":{"sessionId":"s_01J9","seq":13,"type":"message/delta","turn":1,"text":"a.txt 和 b.md"}}
// Shell 崩溃重连：从 seq 12 起 resume —— 服务端回放缺失事件（ZCode watermark [02] / ACP load [06] 语义）
{"jsonrpc":"2.0","id":9,"method":"session/resume","params":{"sessionId":"s_01J9","since":12}}
{"jsonrpc":"2.0","id":9,"result":{"sessionId":"s_01J9","replayedFrom":12,"nextSeq":14,"events":[
  {"seq":12,"type":"message/delta","turn":1,"text":"目录里有 "},
  {"seq":13,"type":"message/delta","turn":1,"text":"a.txt 和 b.md"}]}}
// 注：若 since 超出保留窗口，server 不报错，而是回 snapshot + 自保留基点起的 events，并以 replayedFrom 标明（D4）
```

## Example 4 — 两个完全不同的 Runtime 实现 ARI

**（a）DSH → ARI（适配器 ≈ 改信封）**：DSH 已有全部语义，映射近乎一一对应：

| ARI v0.1 | DSH 现有机制 [01] |
|---|---|
| initialize/capabilities | DSH SDK `initialize`（补版本协商——其已知限制） |
| session/new / resume / prompt(回执) | `agents.create/resume`；SDK `session/prompt`→`messageId` |
| `event` 通道 | `session.event`（全量 SessionEvent 转发）+ `session.status` |
| message/delta | `agent/assistant-stream` chunk（远程消费者本就存在） |
| tool/started|completed | `tool/call` / `tool/result`（meta 原样透传） |
| approval/requested ↔ respond | `approval/request` waterfall ↔ remotes/ACP answerer |
| question ↔ respond | `user-questions/request` waterfall |
| compaction/performed | `compaction/*` 事件折叠 |
| turn/completed stopReason | `turn/end.reason`（TurnEndReason） |

不动的：compaction 算法、ptc-runtime、工具管线、存储格式——**全部留在 Runtime 内**。

**（b）SimpleAgent → ARI（≈200 行的合规 Runtime）**：无账本、无 compaction、无 subagent：
```jsonc
// initialize 应答如实声明
{"agentCapabilities":{"reasoning":false,"question":false,"approvalEditInput":false,
                      "usage":false,"compactionEvents":false,"replay":false,
                      "fileChanges":false,"subagents":false,"backgroundTasks":false}}
// 收到 session/prompt → 回执 messageId，然后发 seq 事件即可：
// session/status running → turn/started{turn, messageIds:[该 messageId]} → (自行调 LLM/工具，发 message/delta 与 tool/*)
// → turn/completed → session/status idle
// 若中途报错：先 session/error，再 turn/completed{stopReason:"error"}（D9-I3）；cancel 亦然。
// 不具备的能力一个事件都不发——协议不为 DSH、也不为 SimpleAgent 特制。
```
两个实现共享同一份 schema 与同一套验收：**事件 seq 自 1 起连续无空洞**、prompt 回执先于该 turn 事件且可经 `turn/started.messageIds` 关联、**每个 `turn/started` 恰好一条 `turn/completed`（error/cancel 路径亦然，D9-I1/I3）**、每个 `approval/requested` 恰好一条 `approval/resolved`、`session/resume` 后 seq 不重不漏、错误码按 D9.2 返回。

---

# 附：证据与限制说明

- 本地源码：DSH（v0.1.7-alpha.1 @ c36a83ff6b）、codex（openai/codex @ 44b857c00e）、opencode（anomalyco/opencode @ v1.18.32）、ZCode（zai-org/ZCode @ "feat: open source"）、pi-mono 与 agent-client-protocol（浅克隆 @ 调查日）；Gemini CLI 与 claude-agent-sdk 由子调查克隆/npm 获取。
- **限制（如实记录）**：① Claude Code CLI 闭源，未做二进制审计，协议面取自 npm `sdk.d.ts` + bundle 检查（标注于 [08]）；② ZCode Protocol V4 自述"未冻结"；③ opencode 的 origin 为 anomalyco/opencode（历史 sst/opencode 的现行仓库）；④ ACP 本地 clone 为重构后仓库（schema crate + docs），TS/Rust SDK 在独立仓库（已用 raw fetch 佐证）；⑤ pi-mono 包结构与旧资料不同（无 packages/pi，见 [05]）；⑥ DSH 的 docs/ 为生成并校验的仓库内文档，引用时已标注。
- 调查期间有 5 个子代理上下文耗尽/中断，均以"增量写盘 + 压缩范围"重试策略完成；全部报告落盘于 `research/`。

## 最终原则自查（对应任务十九条之 1–10）

1. 不为 DSH 特制——Example 4(b) 反证；2. 不为 ZCode 特制——同；3. 不复制 ACP——client-tool 反转、turn=响应生命周期、modes 双轨均被明确拒绝（D7）；4. 不复制 MCP——工具不进协议（D7）；5. 不规定 Harness 内部——C4；6. 不规定 Model Provider——initialize 无 provider 字段；7. 不规定 UI——事件是语义不是渲染（meta 不透明）；8. 不规定具体 Tool——B13；9. 不为未来功能提前设计——subagent/background/fork/PTY 全部推迟并给出 v0.2 位点；10. 可实现性——D8 自检：9 方法 + 16 事件，SimpleAgent 200 行可合规。
