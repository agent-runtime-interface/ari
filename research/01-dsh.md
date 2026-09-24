# 01 · DeepSeek Harness (DSH) 源码级调查

> 调查对象：`deepseek-harness` monorepo（github.com/deepseek-ai/deepseek-harness），本地 checkout v0.1.7-alpha.1（commit c36a83ff6b）。
> 证据标注：【source】= 源码/生成目录直接验证；【docs】= 仓库内 docs/（与源码同步校验的生成文档，可信度高）；行号为阅读时位置，供回查。

## 0. 总体架构

- **Everything is a plugin**：DSH 构建在 [Cordis](https://github.com/cordiverse/cordis) 之上，插件向共享 Context 贡献服务、类型化事件与可逆 effect；模型适配器、工具注册表、session 日志、agent loop 本身都是插件（docs/architecture.md:9-13）。
- **Profiles/Bundles**：运行时由有序层组合：`web`、`headless`、`sdk`、`sdk-minimal`、`acp` 是出厂 profile（architecture.md:19）。`dsh-base` 为共享底层（模型适配、工具、持久化、sandbox 与 approval 策略、settings、凭据、遥测）；`dsh-sdk-app` 增加 **SDK JSON-RPC server**；`dsh-acp-app` 增加 **automation-only ACP server**（architecture.md:25）。
- 核心包与 ctx 键（architecture.md:61-70）：`core/session`→`ctx.sessions`（append-only `SessionEvent` 日志），`core/system-prompt`→`ctx.systemPrompt`，`core/tools`→`ctx.tools`（作用域工具注册表 + 守护执行管线），`core/agent`→`ctx.agents`（Agent 接口 + 活跃注册表 + `agent/*` 事件），`core/agent-loop`→`ctx.agentLoop`，`llm/llm`→`ctx.llm`（消息/流词汇 + 适配器 seam）。
- **事件三域**（architecture.md:74-78）：① Session events = 追加到日志的持久事实，经 `session/event` 广播；② Agent events（`agent/*`）= 进程内活的扩展点（inbox、step、status、request、validation、continuation）；③ Capability events（`fs/*`、`tools/*`、`telemetry/*`）= 给 seam 挂策略/适配器。waterfall 型事件要求 listener 调 `next()` 委托（architecture.md:109）。

## 1. Session

- **创建**：`ctx.agents.create()` 一次建立 session + agent（caller 提供 `SessionId`）；`ctx.agents.resume()` 先加载持久化 session（docs/subsystems/core.md:24）。`AgentHandle` 只暴露给创建者（owner-only disposer，core.md:29-47）。创建选项含 `parentAgent`、meta（cwd、fork 血缘、delegation depth、agentPreset）、`seed`（fork 回放前缀）、per-agent `AgentOptions`（provider/model/reasoningEffort/maxTokens）（core.md:49-51）。
- **持久化**：session log 即 source of truth；JSONL 提供者负责物理帧、压缩（`session.jsonl[.zstd]` / `session.vN.jsonl[.zstd]`）、generation 选择与独占发布；committed generation 路径永不改名/替换/删除；相邻迁移包一次只做 `vN → vN+1`（architecture.md:123）。checkpoint 策略归 `dsh-session-checkpoint-policy`（session.md:38-41）。
- **Resume / 崩溃恢复**：`resume()` + header-only `stat`/`list` 重扫目录选择最高 generation，历史版本走显式迁移链（architecture.md:123）；未封口的尾部 repair 是消费者职责（architecture.md:123）。
- **Fork**：`ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })`，只在 turn 边界 fork；`inheritedEventCount` 记录精确切点；`session/end-seed { inherited?: true }` 标记继承前缀边界（session.md:149-173; architecture.md:160）。
- **多客户端**：单进程内多插件共享同一 session；远程多客户端通过 web `session-controller` + `session/event` 广播（见 §13）。SDK 侧 `session.event` 通知是"every session in the runtime, unfiltered"（packages/sdk/protocol/README.md:43）。
- **Interrupt/Cancel**：`Agent.cancel(cause, { keepInbox })` 清队列并 abort 活动 turn；无活动时为 no-op（core.md:82-84）。`TurnEndReason` 记录在 `turn/end`（session.md:43）。
- **Webhook 入口**：外部系统可 fire-and-forget 创建普通 root Session（`WebhookSessionRequest`: workspacePath/title/prompt/agent preset/permission preset/model），follow-up 是 `source.kind: "webhook"` 的 user message（docs/subsystems/webhook.md:17-29）。

## 2. 消息模型（`SessionEventMap`）

来源 docs/subsystems/session.md:27-174（类型与 packages/core/session/src/types.ts 等价校验）。**持久事件词汇**：

| 事件 | 载荷要点 |
|---|---|
| `turn/start` / `turn/end` | `{ turn }` / `{ turn, reason: TurnEndReason }` |
| `step/start` / `step/end` | `{ turn, step }` —— step = 一次模型调用 + 其工具执行 |
| `user/message` | `UserMessage`；`source` 区分真人 prompt / `agent.inject()` 注入 / goal 续轮（session.md:48-55） |
| `developer/message` | **增量 agent session 变化**（turn/step 定位）+ 引用 `request/header`（session.md:56-63） |
| `system/message` | 渲染后的系统提示词，作为 surface node 0 追加；空渲染清空全部活跃 system nodes（session.md:64-76） |
| `assistant/message` | 组装后的 assistant 消息 + **嵌入的完整定时原始流** `AssistantStreamRecord[]` + `usage?` + `interrupted?`（session.md:87-95） |
| `assistant/attempt` | 无 surface 消息的模型 attempt（失败/重试/取消/流错误），log-only（session.md:100-101） |
| `tool/call` | `{ turn, step, callId, name, arguments }` —— arguments 是模型产出的**原始未解析 JSON 串**（session.md:107） |
| `tool/result` | `ToolResultMessage` + `error?{name,code,reason}`（模型不可见）+ `meta?`（工具私有展示载荷，如 dsh-tool-fs 的结果时 diff）（session.md:121-131） |
| `request/header` | 下一请求全量头（工具集等），log-only（session.md:136-141） |
| `request/context` | 路由元数据（route/capacity/system-prompt 更新模式变化时记录）（session.md:147-148） |
| `session/end-seed` | fork 边界标记（session.md:173） |

插件合并扩展（声明合并）：`compaction/start|summary|end`（log-only）、`hook/invoked|result`（log-only）、`image/offload`、`approval/asked|decided`（log-only 审计）、`todo/write`、`goal/change`、`schedule/change`、`team/*`、`deliverables/presented`、`tool/ptc-dispatch(-start)`（persistence-catalog.md:1078,1101）、`workflow/*`。

**LLM 词汇**（docs/subsystems/llm-streaming.md:24-35）：`ContentBlockMap = text | reasoning | image | file | tool-call | tool-addition | tool-removal`；`ToolResultMessage` 是一等消息（toolCallId + content + isError）。`MessageSourceMap`（llm-streaming.md:86-91）: `user | model | tool | system-prompt`（merge-extensible，producer 声明自己的 kind）。

**模型 API 消息 vs Harness 事件**：DSH 的分离非常干净——模型可见的东西必须可在日志中重建（"Model-visible means logged" 运行时不变量，architecture.md:125）；`SurfaceEventType`（带 `surfaceOp`）子集才参与 surface 投影，其余为 log-only。Harness 自己的事件（approval、compaction、hooks、goal、todo…）不进入模型历史，除非通过 `agent.inject()` 变成 `user/message`。

## 3. Agent Loop（turn flow）

docs/architecture.md:88-113 给出权威控制流：

```
turn/start
  claim next-step input + 一条 queued message
  组装 prompt sections + tool schemas; 投影 runtime context
  → agent/pre-step (waterfall)          # 决定接受哪些输入；可改写/拒绝
     step/start
     agent/request → prepareCall        # 解析 provider/model 路由；取消则什么都不提交
     reconcile system/message; 追加 user/message; 记录 request/header|context
     从日志 derive + freeze 模型历史
     流式调用 → llm/stream (waterfall) → agent/assistant-stream start
       chunk* → assistant/message | assistant/attempt → end
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
     工具欠下一请求 或 新的 next-step 输入 → claim → 下一个 step
  → agent/turn-stopping (serial)
turn/end
```

- **Model call**：经 `ctx.llm` 的 `llm/stream` waterfall（llm-deepseek / llm-pi-ai 适配器）；重试由 `llm-retry` 挂在 `agent/request-error`（event-producer-consumer.md:21）。
- **并行工具**：`ToolDefinition.isConcurrencySafe(args)` 显式 opt-in；并发契约见 .agents note 2026-07-10（tools.md:61-74）。
- **Interrupt**：`agent.cancel(cause)`；流中途取消会把已送达文本/推理前缀固化为 `assistant/message { interrupted: true }`，未派发的 tool calls 不存在（session.md:82-85）。
- **Timeout**：工具级 `timeoutMs` 由 `dsh-tool-call-timeout-policy`（tools/execute wrapper）执行，永不发给模型（tools.md:54-59）。
- **Loop detection**：`repeat-tool-reminder`（packages/guard）挂 `tools/post-execute`（event-producer-consumer.md:73）。
- **Budget/iteration**：未见显式 max-iteration 上限【docs 中未找到】；token 压力走 compaction（见 §9）。
- **Steering/Followup/Inject**：`Agent.send(message, target, wakeup)`、`followup()`（独占下一 turn）、`steer()`（最近 step 边界消费）、`inject()`（下个 pre-step 注入、不唤醒）（core.md:114-140）。Inbox = `nextTurn` + `nextStep` 两个有序队列，durable projection（core.md:213-247）。
- **AgentStatus**：仅 `idle | running`；dispose 不是第三状态（core.md:152）。

## 4. Tool Runtime

- **统一抽象** `ToolDefinition`（tools.md:26-93）：`ToolSchema`（name/description/parameters，模型可见）+ `output: ToolOutputDefinition`（canonical JSON schema + `render(args,value)→ContentBlock[]` + `presentationMeta?`）+ `execute(args, exec: ToolRunContext)` + `finalizeContent?` + `timeoutMs?` + `isConcurrencySafe?` + `presentCall?(args)→ToolCallView` + `presentResult?(args,result)→ToolResultView`。`schemas()` 用显式白名单防止执行字段泄漏给模型（tools.md:11）。
- **执行管线**：`tools/pre-execute → tools/execute → tools/post-execute`（waterfall）+ `tools/result`（emit）。挂载者：timeout-policy、session-checkpoint-policy、auto-review、hooks-claude-code/codex、tool-jobs、workspace-changes、repeat-tool-reminder、spill-policy、tool-fs-search、browser-use、computer-use（event-producer-consumer.md:72-76）。
- **结果表示**：canonical JSON value + render 产出的模型内容 + 可选 `meta`（UI 展示载荷，必须可 JSON 序列化，Session.append 运行时校验）（session.md:109-131）。
- **取消**：`exec.signal`（AbortSignal）协作式转发；注册表通过 around-dispatch 信号替换保留 caller 取消（tools.md:32-38）。
- **流式返回**：工具本身不流式（结果是 settled 后一个 canonical value）；实时增量展示属 assistant 流。bash 输出经 job observation（§8）。
- **内置工具**（docs/tool-catalog.md:16-47，生成目录）：`bash`、`pwsh`、bash/pwsh-persistent（PTY）、`read`、`read_image`、`write`、`edit`、`str_replace_editor`、`glob`、`grep`、`web_search`、`web_fetch`、`terminal_open/read/send/signal/list/close`、`job_list/output/kill`、`subagent`(+`subagent_fork` alias)、`list_subagent_models`、`send_message`、`interrupt_agent`、`list_agents`、`ask_user_question`、`exit_plan_mode`、`todo_write`、`skill`、`create_goal/get_goal/update_goal`、`schedule_create/delete/list`、`workflow`、`ralph`、`run_code`(PTC)、`lsp`、`present`、`plugin_manager`、`session_search/trace` 等 5 个、MCP 资源 3 个、stagehand_* 6 个（browser）、`load_workspace_dependencies`、`cordis_inspect_*`。
- **MCP**：`mcp-client` 包 + MCP 资源工具；工具经 `tools/change` 动态增删（`tool-addition/tool-removal` blocks 记录到 developer/message）。
- **Shell 必须看到什么**：tool/call（name+原始 args+callId）、tool/result（模型内容+meta+error 概览）、pending/完成两种视图（presentCall/presentResult 是纯函数、可重放）。执行世界（sandbox 细节、子进程、超时策略）留在 runtime。

## 5. Human-in-the-loop

- **Approval seam**（docs/subsystems/approval.md）：`ctx.approval`；`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（**closed、fail-closed**，没有 allow-always）；per-session `ApprovalPolicy = 'ask' | 'never'`（session log 中最后一条 approval/policy 生效；`never` 在服务内部拦截，answerer 无法绕过）（approval.md:21-47,86）。
- **请求形状**：`ApprovalRequest { agent, toolName, callId?, reason?, signal? }` —— **刻意不含工具参数**：UI 通过 `callId` 把 prompt 贴到已流式展示的 tool call 上（approval.md:53-81）。`signal` abort → `cancelled`。
- **派发与审计**：`ctx.approval.request(req)` 追加 `approval/asked` → waterfall（`approval/request`）首个 answer 定夺 → `approval/decided`；审计对 log-only、不进模型历史（approval.md:86-88）。`request` 要求 session 处于打开的 turn 内（approval.md:119-120）。
- **Answerer**：UI 通道可注册人类 answerer；**ACP automation bridge 提供一次性机器决策**；web 侧 `remotes` 监听 `approval/request`（event-producer-consumer.md:30）。
- **用户问题 seam**（docs/subsystems/user-questions.md）：`ask_user_question` 工具 → `AskUserQuestionRequest { questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }] }`；intent 如 `{ kind: 'plan-review', approve: '<label>', callId? }` 只改变呈现不改变协议（user-questions.md:35-47）；答案按 id 回填。**`remotes` 把 waterfall 转发给已连接的 Web 客户端作答**（user-questions.md:5; event-producer-consumer.md:77）。
- **参数修改**：approval 协议本身不支持修改参数（closed outcome）；"修改"靠拒绝后让模型重发【推断自 closed enum】。
- **权限预设**：`permission-presets`（catalog-changed 事件 → remotes）+ `ctx.sandbox` 后端（SandboxMode）提供规则式控制；`plugin_manager` 工具需要 danger-full-access 或本次 approval（tool-catalog.md:55）。
- **客户端如何知道在等待**：`approval/request`、`user-questions/request` waterfall 事件（远程经 remotes 转发）+ `agent/status`。

## 6. File / Diff

- **fs 事件域**：`fs/observed`（读/存在性/变更后）、`fs/write-intent`、`fs/edit-intent`（变更前 waterfall，可被 `fs-observation-policy` 拦截实现 read-before-write 策略）（event-producer-consumer.md:45-47）。
- **结构化 diff**：`tool/result.meta` 携带工具私有展示载荷，dsh-tool-fs 在此放置结果时上下文 diff（session.md:117-119）。
- **工作区变更 feed**：`workspace-files` 控制器提供"instrumented-operation `changes` feed" + stat/read/list（packages/api/README.md:36）；`deliverables/workspace-changes` 在 `tools/pre-execute`、`agent/turn-stopping`、`session/disposed` 上追踪变更（event-producer-consumer.md:23,74,60）。
- **呈现**：`present` 工具 + `deliverables/presented` 事件把文件作为交付物推给 Web UI（tool-catalog.md:25）。
- 判断：DSH 是"**结构化事件 + 客户端按需读文件**"混合派：Runtime 在 fs seam 与 deliverables 层发结构化事实，Web 客户端另有 workspace-files 读通道，不依赖自己 watch 文件系统。

## 7. Command / Terminal

- **一次性 shell**：`bash`/`pwsh` 工具走 `ctx.shell` seam（本地实现经 `ctx.subprocess`）；`run_in_background` 注册到 `ctx.jobs`（tool-catalog.md:24-26）。
- **持久终端**：`ctx.terminals` seam + `terminal_*` 六工具（open/read/send/signal/list/close，PTY 状态）；`terminal_send(run_in_background)` 也进 jobs（tool-catalog.md:28-33）。
- **后台统一模型**：`ctx.jobs` 是 kind-agnostic 的——后台 bash、PTY send、subagent 全部注册为 job；`job_list/job_output/job_kill` 三个工具统一消费；后台完成通知经 `agent.inject()` 变成 user message（tool-catalog.md:42）。
- **浏览器终端**：`terminal-controller` 拥有"Session-owned interactive shells, screen recovery and browser terminal control"（packages/api/README.md:35）；job-controller 把一个 job 的 observation record 流式推给客户端（README.md:31）。
- Shell（UI）可见：命令生命周期、输出流（经 job observation/terminal 读）、exit、kill；进程世界细节（argv 包装、sandbox 后端）留在 runtime。

## 8. Context Management

- **构建**：系统提示经 `system-prompt/assemble` waterfall；工具 schema 并入；`agent.inject()` 注入的上下文在下个 pre-step 落为 `user/message`。
- **Compaction seam**（docs/subsystems/compaction.md）：`ctx.compaction` 接口 + `compaction-basic` 后端 + `command-compact` 人工命令。三个 log-only 事件 `compaction/start {turn|null}`、`compaction/summary {summary, rawOutput?, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, usage?...}`、`compaction/end {turn, error?}`；摘要以**唯一一次 surface 变更**落盘：新 `user/message` + `surfaceOp: { op:'replace', startSeq, endSeq }`（compaction.md:11-21）。
- **触发**：`CompactionTrigger = 'pressure' | 'context-overflow'`，pressure 在 `agent/pre-step` 运行；overflow 在请求失败后经 `agent/request-error` 恢复（compaction.md:81,101）。可选 `ctx.toolResultPruner` 先裁剪工具结果；`ctx.tokenMeter` 统一估算（compaction.md:84,101）。
- **崩溃语义**：锁在最后释放 → 中途崩溃留下可检测的孤儿锁（compaction/start 无配对 end）（compaction.md:19）。
- **原始输出**：assistant/message 嵌入完整定时原始流；shadowed 事件**不被删除**，只是不再投影到 surface——不可变 ledger 语义。
- **Spill**：`spill-policy`（tools/post-execute）把超限工具输出落 `ctx.spillStore` 并返回 locator（grep 工具 `sampleOverCapGlobResults` 即此模式，tool-catalog.md:32）。
- **结论素材**：compaction 在 DSH 是 Runtime 内部能力，但对协议**部分可见**：持久事件记录了摘要与被替换范围，客户端可以从 `session/event` 看到发生了 compaction，而不需要理解它。

## 9. PTC（Programmatic Tool Calling）

- **执行 seam**：`ctx.ptcRuntime`（dsh-ptc-runtime）。`PtcRunRequest { program, bindings: PtcBindingNamespace[], cwd?, timeoutMs?, sandboxPolicy?, signal? }`；程序是 async 函数体，顶层 await/return；`PtcRunResult { value?, stdout/stderr, sandbox?{mode,denied,enforcement}, error? }`——错误是字段不是异常（ptc-runtime.md:18-90）。
- **工具层**：`run_code` 工具（registry 保留传输，在 `mode: ptc | both` 下注入）；程序通过 bindings 调用工具，**每个被桥接的 sub-call 产生一对 `tool/ptc-dispatch-start` + `tool/ptc-dispatch` 事件并重新进入完整守护工具管线**，与外层 result 关联；并发遵循原生契约（submission-ordered，concurrency-safe body 至 `maxParallelSubCalls`）（tool-catalog.md:22）。
- **判断素材**：中间过程**是**持久事件（shell 可以看到 sub-call 级明细），但语义上 PTC 是 runtime 能力——shell 只需渲染 ptc-dispatch 事件即可，无需理解程序。

## 10. Subagent

- **Providers**：`ctx.subagents`（provider 可插：in-process driver、dsh-sdk、acp 桥、fresh child agent、或"delegated turn in another product"，architecture.md:133）；`subagent/start`、`subagent/end` 事件（event-producer-consumer.md:65-68）。
- **工具面**：`subagent`（默认名，alias `subagent_fork`，固定路由）+ `list_subagent_models`；控制面 `send_message` / `interrupt_agent` / `list_agents`（tool-catalog.md:40-41）。`subagent_fork` 继承本会话已完成轮次（fork 语义）。
- **父子关系**：`parentAgent` + meta.delegation depth；child 是独立 Session（有自己的 event log）；`SDK subagent.finished` 通知带 child 最后一条 assistant 消息（sdk/protocol/README.md:46）。
- **并行 + 等待**：后台 continuable children（经 jobs 统一）；`wait_agent`（agent-team）；事件向上转发经 `ctx.subagents`（tool-subagent-control 描述）。
- **Agent Teams（experimental）**：`ctx.agentTeams` durable roster/task board/mailbox；工具 `spawn_teammate`、`team_task_*`、`wait_agent`、`interrupt_agent`、`list_agents`、`send_message`；事件 `team/member`、`team/message/queued|delivered`、`team/task`（architecture.md:135; tool-catalog.md:43）。
- **Shell 可见性**：subagent.started/finished（SDK）、child session 事件经 provider 转发、`list_agents` 投影。ARI 只暴露"子代理存在 + 完成"两级事件，编排不在协议内。

## 11. Streaming

- **进程内**：`agent/assistant-stream`（emit）：start/chunk/end 帧，`chunk = { attemptId, revision, index, time, chunk: StreamChunk }`；end 带 `outcome: committed(assistant/message|attempt seq) | abandoned`（core.md:156-190）。**唯一远程消费者是 Web Session-follow 适配器**（architecture.md:109）。
- **持久**：完整流在结算时嵌入 `assistant/message.stream`（断电即丢失，不留部分 attempt，architecture.md:121）。
- **跨进程**：web 客户端经 Connection/`session-controller` 的 history streams + live 事件；SDK 经 `session.event`（全量 session 事件）；headless bundle 也是 listener（event-producer-consumer.md:12,61）。
- 模型即 `request → event stream → completed`：成立。completion 信号 = turn/end（durable）+ agent/status idle。

## 12. Transport（DSH 自身的对外协议面）

DSH 同时暴露**四个外部协议面**（对 ARI 是极有价值的先例）：

1. **SDK JSON-RPC over stdio**（packages/sdk/protocol/README.md）：newline-delimited JSON-RPC 2.0；方法仅 3 个：`initialize`（serverInfo/reasoningEffort/maxTokens）、`session/prompt`（返回 durable enqueue receipt `messageId`）、`shutdown`；通知 4 个：`session.event`（全量 session 事件）、`session.status`（running/idle）、`subagent.started`、`subagent.finished`（+`lastAssistantMessage`）。已知限制：**无协议版本协商、无 cancel/session-close 方法（客户端以关闭进程代替）、server→client request 是死能力（Python SDK 预留 responder surface 给未来 approval 流）**（README.md:113-115）。Python SDK 镜像同一协议（不 import）。
2. **ACP server（automation-only）**（packages/acp/README.md）：让程序创建/列出/恢复/关闭 session、挂 MCP、选模型、发文本+图片 prompt、收 semantic updates、**回答 permission prompts、取消工作**；subagent-acp 是反向桥（从另一个 harness spawn 本 server）。
3. **Web GUI 协议**：HTTP(SSE/fetch)（`ctx.webServer` + `/api` 共享通道）；`api/` Remote 层 = typed Client→Host 调用（remotes 决定暴露面；gateway 携带 unary 调用、多路复用流 + client uplink、转发 Host 事件）+ 控制器：session（命令/历史流/活动控制）、terminal、workspace、workspace-files、job、settings/credentials（packages/api/README.md:27-38）。流式 session 数据**刻意不在 Remote 层**（README.md:12-38）。
4. **Webhook**：HTTP ingress → fire-and-forget session 创建（webhook.md）。

## 13. Capability Matrix（DSH）

| Capability | DSH | 证据 |
|---|---|---|
| Session | ✓ | `ctx.sessions` append-only log；`agents.create/resume`（core.md:24） |
| Resume | ✓ | JSONL generations + 迁移链 + `resume()`（architecture.md:123） |
| Streaming | ✓ | `agent/assistant-stream` start/chunk/end；`session.event` 通知（core.md:156） |
| Cancellation | ✓ | `Agent.cancel(cause)` + AbortSignal 全链路（core.md:82） |
| Approval | ✓ | `ctx.approval` + `approval/request` waterfall + ask/never 策略（approval.md） |
| Tool events | ✓ | `tool/call`、`tool/result`（+meta）+ `tools/*` 管线事件（session.md:107） |
| File changes | ✓ | `fs/observed`、`fs/*-intent`、workspace-files changes feed、tool meta diff |
| Terminal | ✓ | `ctx.terminals` + terminal_* 工具 + terminal-controller（PTY） |
| Background task | ✓ | `ctx.jobs` 统一 bash/PTY/subagent + job_* 工具（tool-catalog.md:42） |
| Parallel tools | ✓ | `isConcurrencySafe` opt-in 并行契约（tools.md:61-74） |
| Compaction | ✓ | compaction seam + 3 个持久事件 + surfaceOp replace（compaction.md） |
| Subagent | ✓ | `ctx.subagents` providers + subagent/fork/control 工具 + agent-team（实验） |
| Usage | ✓ | `assistant/message.usage`、`ctx.tokenMeter`、compaction/summary.usage |
| Reasoning events | ✓ | `ReasoningBlock`、流内 reasoning chunk、持久嵌入流 |
| PTC | ✓ | `ctx.ptcRuntime` + `run_code` + `tool/ptc-dispatch*` 事件（ptc-runtime.md; tool-catalog.md:22） |

## 14. Shell 必须看到 vs Runtime 内部（DSH 证据下的判断）

**Shell 必须看到（协议面）**：
1. 会话生命周期：created/resumed/disposed、`agent/status`（idle/running）。
2. 持久叙事流：turn/step 边界、user/message（含 source）、assistant 流（增量 + 结算）、tool/call + tool/result。
3. 等待人类的两种请求：approval（可挂 callId）与开放式 question（选项/多选/intent）。
4. 后台任务存在性 + observation 流 + kill。
5. 交付物/文件呈现事件（present、changes feed）。
6. Subagent started/finished（+ 可选子会话事件转发）。
7. Usage（token 计量随消息走）。

**Runtime 内部（shell 不该理解）**：
- 上下文如何从日志 derive、prompt 装配顺序、request/header 与路由、缓存友好的 system node 规则。
- Compaction 的摘要算法、阈值、shadowed seq 记账（shell 只需"surface 被替换"这一事实）。
- 工具执行世界：sandbox 后端、argv 包装、子进程、超时策略、read-before-write 策略插件。
- PTC 程序如何执行（shell 只渲染 ptc-dispatch 事件）。
- Hook 桥（Claude Code/Codex hooks）、permission presets 的实现。
- Session 文件格式、generation、迁移。

**独特启示（对 ARI）**：DSH 证明了一个"**不可变 ledger + 派生投影**"模型可以同时服务模型（deriveMessages）、UI（projection snapshot）、协议（session.event 转发）三方；且 approval 与 question 是两个不同的 seam（一个闭式裁决、一个开放式作答）。
