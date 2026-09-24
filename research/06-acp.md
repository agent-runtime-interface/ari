# ACP（Agent Client Protocol）源码研究报告 —— ARI 设计先例分析

> 研究对象：Zed Industries 的 Agent Client Protocol（ACP）。本地仓库 `/tmp/ari-research/agent-client-protocol`（commit `e3bdb6d`，main 分支）；官方文档 https://agentclientprotocol.com/；TS/Rust 运行时 SDK 位于独立仓库（github.com/agentclientprotocol/typescript-sdk、rust-sdk），通过 web_fetch 核实关键源码。
>
> **语料说明**：任务书假设本地仓库含 `ts/` 包与 `schema/schema.json`、`schema.md`、`docs/`、rust crates。实际仓库结构已重构：本地仅含 `agent-client-protocol-schema/`（Rust 数据模型 crate，含 v1/v2 模块）、`schema/v1|v2/`（生成的 JSON Schema 与 `meta.json`）、`schema-generator/`、`docs/`（Mintlify 文档源）与 `CHANGELOG.md`。本地 `ts/` 目录：源码/文档中未找到。TS SDK 传输层与 Rust 运行时 crate 的结论均来自对应独立仓库的 raw 源码（URL 见正文），非本地文件。

---

## 1. ACP 是什么 / 不是什么

**定义与双方。** ACP 自我定位为"标准化 *code editor*（代码编辑器）与 *coding agent*（编码 agent）之间通信的协议"（`README.md` 首段；`docs/get-started/introduction.mdx`）。两个角色：

- **Client**：编辑器/IDE 或其他 UI，"管理环境、处理用户交互、控制资源访问"（`docs/protocol/v1/overview.mdx:114-116`）。
- **Agent**："使用生成式 AI 自主修改代码的程序，通常作为 Client 的子进程运行"（`overview.mdx:43-45`）。

**定位：编辑器 spawn 的 agent 后端进程。** `docs/get-started/architecture.mdx:16-18`："用户尝试连接 agent 时，编辑器按需启动 agent 子进程，全部通信走 stdin/stdout"。一条连接可承载多个并发 session（同文件："Each connection can support several concurrent sessions"）。本地 agent 走 JSON-RPC over stdio；远程 agent 走 HTTP/WebSocket（尚在推进，`introduction.mdx` Info 块）。

**设计哲学**（`architecture.mdx:8-14`）：① MCP-friendly——复用 MCP 的 `ContentBlock` 等 JSON 表示（`docs/protocol/v1/content.mdx:16-18` 明确 ContentBlock 与 MCP 相同，便于 MCP 工具输出免转换转发）；② UX-first——为 agent 编码 UX（diff 展示、权限弹窗、进度流）设计，"抽象不多也不少"；③ Trusted——信任模型是"编辑器信任模型"，用户在编辑器内控制工具调用，编辑器授予 agent 本地文件与 MCP 访问。

**不是什么。** ACP 不定义 agent 内部：无模型 provider 选择协议面（模型/推理等级通过 session config options 的 `category: "model"` / `"thought_level"` 暴露，`docs/protocol/v1/session-config-options.mdx:202-209`；`providers/list|set|disable` 仅存在于 `#[cfg(feature = "unstable_llm_providers")]`，`agent-client-protocol-schema/src/v1/agent.rs:4758-4763`）；不做 prompt 编排、上下文管理；认证是"agent 自己的账号体系"（`authenticate`/`authMethods`，见 §3），协议不持有模型 API key——`docs/protocol/v1/elicitation.mdx:134-135` 明确禁止把 URL-mode elicitation 获得的 token 送回 ACP 通道或进入模型上下文。v1 也没有 agent 侧后台任务、子 agent、上下文压缩的稳定协议面（§9）。

---

## 2. 传输与分帧

**JSON-RPC 2.0 over stdio，newline-delimited（非 Content-Length）。** 规范层：

- `docs/protocol/v1/overview.mdx:10`："The protocol follows the JSON-RPC 2.0 specification"；消息分 Methods（请求-响应）与 Notifications（单向）。
- `docs/protocol/v1/transports.mdx:17-27`（stdio 传输全文要点）：client 将 agent 作为子进程启动；"Messages are delimited by newlines (`\n`), and **MUST NOT** contain embedded newlines"（:24）；agent **MUST NOT** 向 stdout 写任何非 ACP 消息（:26），stderr 可用于日志（:25）。**没有 Content-Length 头**——与 LSP 的 HTTP 式分帧截然不同，就是逐行 NDJSON。
- `overview.mdx:225-227` 约定：JSON 对象键 `camelCase`、discriminator 字符串 `snake_case`、JSON-RPC 信封字段（`jsonrpc/id/method/params/result/error`）遵循 JSON-RPC 2.0。

**TS 实现佐证**（github.com/agentclientprotocol/typescript-sdk，raw 文件）：
- `src/line-buffer.ts`：`LineBuffer.push(chunk)` 按 `const newline = 0x0a` 增量切分行，跨 chunk 缓存不完整行——纯按字节 0x0a 分帧，无任何长度头。
- `src/examples/client.ts`：`spawn(...)` 启动 agent 子进程，`const stream = acp.ndJsonStream(input, output)` 后 `acp.client(...).connectWith(stream, ...)`——官方示例即"子进程 + NDJSON 流"。

**Rust 实现佐证**（github.com/agentclientprotocol/rust-sdk，raw 文件）：
- `src/agent-client-protocol/src/stdio.rs`：`Stdio::connect_to` 用 `BufReader::new(stdin).lines()` 读、`crate::jsonrpc::write_line(&mut writer, line)` 写——行式收发。
- `md/transport-architecture.md`：字节流 transport "Write newline-delimited JSON to stream"；协议层与分帧层以 `TransportFrame` 为界（一帧 = 一个 `RawJsonRpcMessage`、一个非空 `TransportBatch` 或保留原样的畸形输入）；in-process `Channel::duplex()` 跳过序列化。批量（JSON-RPC batch）在 SDK 层对 v1/v2 统一支持。

**JSON-RPC 信封在数据模型中的位置**：`agent-client-protocol-schema/src/rpc.rs:50-57`（`Request{id, method, params}`）、`:116-121`（`Notification{method, params}`）、`:138-142`（`JsonRpcMessage{jsonrpc:"2.0", flattened}`）；`:336-396` 的 `notification_wire_format` 测试给出了确切 wire 形状。所有方法名常量集中在 `src/v1/agent.rs:4753-4789`（agent 侧）与 `src/v1/client.rs:2689-2707`（client 侧），汇总于 `schema/v1/meta.json`。注意：session 更新流的 wire 方法名是 **`session/update`**（`client.rs:2689`），文档亦然；`rpc.rs:360` 测试里出现的 `"sessionUpdate"` 只是测试自造方法名，不是 wire 名。

**向后兼容规则**：
- `protocolVersion` 是单个整数，仅代表 MAJOR 版本，"只在 breaking change 时递增"；client 报最新版本，agent 支持则原样返回、否则返回自己支持的最新版，client 不支持则应断开并告知用户（`docs/protocol/v1/initialization.mdx:84-98`）。
- "引入新能力不是 breaking change"，未在 initialize 中出现的 capability 一律视为不支持（`initialization.mdx:100-106`）。同一 wire 版本内，可选消息/参数由 capability 决定（`README.md` Versioning 节：wire 兼容只看协商的 `protocolVersion`，与 crate/JSON Schema artifact 版本无关）。
- 版本常量：`ProtocolVersion(u16)` 的 `V0`（pre-release）、`V1`（stable）、`V2`（draft，仅 `unstable_protocol_v2` feature 下可用），`agent-client-protocol-schema/src/version.rs:9-49`。
- Rust 类型全部 `#[non_exhaustive]`、枚举带 `#[serde(other)]` 兜底（如 `ToolKind::Other`，`src/v1/tool_call.rs:493-495`）；扩展手段是 `_meta` 字段与 `_` 前缀自定义方法（`overview.mdx:229-237`）。v2 草案进一步把所有 enum/ tagged union 变成开放集合，`_` 前缀留给实现（`docs/protocol/v2/migration.mdx` "Extensibility and forward compatibility"）。

**远程传输（进行中）**：v1 规范只有 stdio + "Streamable HTTP (draft proposal in progress)"（`transports.mdx:44-46`）；RFD `docs/rfds/streamable-http-websocket-transport.mdx` 提出长连 GET SSE 流（connection 级 + session 级）+ POST（202 Accepted，`initialize` 除外）+ 同端点 WebSocket 升级，MUST 二者都支持，要求 HTTP/2 与 cookie 支持。

---

## 3. 握手：initialize / authenticate

`initialize`（Client→Agent 请求）携带 `protocolVersion` + `clientCapabilities` +（SHOULD）`clientInfo{name,title,version}`；响应携带协商后的 `protocolVersion` + `agentCapabilities` +（SHOULD）`agentInfo` + `authMethods[]`（`docs/protocol/v1/initialization.mdx:24-82`，JSON 示例即 wire 格式）。

**clientCapabilities**（`initialization.mdx:114-182`）：
- `auth.terminal: boolean`——client 能以交互终端复现 agent 登录命令，agent 才可广告 `type:"terminal"` 认证方法（:118-128；`docs/protocol/v1/authentication.mdx:92-128`，含 `ACP_INTERACTIVE_LOGIN=1` env 的示例）。
- `fs.readTextFile` / `fs.writeTextFile`（:130-138）——对应 `fs/*` 方法可用性。
- `terminal: boolean`——全部 `terminal/*` 方法可用（:144-153）。
- `elicitation: {form:{}, url:{}}`——支持哪些 elicitation 模式；ACP 特意与 MCP 不同，`{}` 不代表支持 form（:155-167；`docs/protocol/v1/elicitation.mdx:40-52`）。
- `session.configOptions.boolean`——支持 boolean 型 config option（:169-182）。

**agentCapabilities**（`initialization.mdx:184-267`）：
- `loadSession: boolean`——`session/load` 可用（:188-191；注意 :264-267 明确它游离于 `sessionCapabilities` 之外，未来会统一）。
- `promptCapabilities: {image, audio, embeddedContext}`——`session/prompt` 可接受的内容类型；基线：所有 agent **MUST** 支持 `ContentBlock::Text` 与 `ResourceLink`（:202-218）。
- `mcpCapabilities: {http, sse}`——agent 连接 MCP server 的传输能力，SSE 已被 MCP spec 弃用（:220-231）。
- `auth.logout`——`logout` 方法可用（:233-241）。
- `sessionCapabilities: {list:{}, delete:{}, resume:{}, close:{}, additionalDirectories:{}}`——各会话级扩展方法的 `{}` 对象型支持标记（:243-267）。

**authMethods / authenticate / logout**：agent 在 initialize 响应中广告 `authMethods[{id,name,description,type?}]`；`type` 缺省为 `"agent"`（走协议内 `authenticate{methodId}` 流程，`docs/protocol/v1/authentication.mdx:78-167`）；`type:"terminal"` 则 client 用同样的 agent 启动配置另起交互进程完成登录（exit 0 = 成功），**不得**对该方法发 `authenticate`（:169-188）。`logout`（agent 方法，需 `agentCapabilities.auth.logout`）终结已认证状态（:190-216）。Rust 侧 `AuthMethod` 等类型见 `src/v1/agent.rs:583-707`。

---

## 4. 会话生命周期

基线方法：所有 agent **MUST** 支持 `session/new`、`session/prompt`、`session/cancel`、`session/update`（`initialization.mdx:245`；Rust 注释同文，`src/v1/agent.rs:4026`）。

- **session/new**：参数 `cwd`（绝对路径，MUST）+ `mcpServers[]`（stdio 配置 `{name,command,args,env}` 必须支持；`{type:"http",name,url,headers}` 与 `{type:"sse",...}` 分别需 `mcpCapabilities.http/sse`）；响应 `{sessionId}`，MAY 附带 `modes` / `configOptions`（`docs/protocol/v1/session-setup.mdx:45-81`；MCP 传输细节 :369-545）。`cwd` 规则：必须绝对路径、无视子进程实际启动位置、是相对路径解析基点、属于会话根集合（:358-367）。
- **session/load**（需 `loadSession`）：传 `{sessionId, cwd, mcpServers}`，agent **MUST** 以 `session/update` 通知把整段会话历史重放给 client（含 `user_message_chunk`/`agent_message_chunk`，可带 `messageId`），全部重放完毕后才响应 `{}`（:83-188）。这是"状态在 agent、UI 重建靠事件重放"的典型设计。
- **session/resume**（需 `sessionCapabilities.resume`）：同参数但 **MUST NOT** 重放历史，直接恢复上下文后响应；响应可附初始 mode/model/config 状态（:190-253）。RFD `session-resume.mdx`；v1 里 load/resume 是两个方法，v2 合并为 `session/resume` + `replayFrom` 游标（`docs/protocol/v2/migration.mdx` "session/load is gone"）。
- **session/close**（需 `sessionCapabilities.close`）：取消该会话进行中的工作并释放资源（等价先 `session/cancel`）（:255-311）。
- **session/list / session/delete**：发现已知会话（`cwd` 过滤 + cursor 分页，`SessionInfo{sessionId,cwd,title,updatedAt,additionalDirectories?,_meta}`）；`session_info_update` 通知可实时推送标题等元数据（`docs/protocol/v1/session-list.mdx:35-217`）；delete 从 list 结果中删除（`docs/protocol/v1/session-delete.mdx`；capability `sessionCapabilities.delete`）。
- **additionalDirectories**：`session/new|load|resume` 可带额外工作根目录，扩大会话文件系统边界 `[cwd, ...additionalDirectories]`，均为绝对路径，resume 时需重发全量列表（`session-setup.mdx:313-344`）。
- **session/prompt**：参数 `{sessionId, prompt: ContentBlock[]}`；内容类型受 promptCapabilities 约束（`docs/protocol/v1/prompt-turn.mdx:57-98`）。响应在 turn 结束时返回 `{stopReason}`，取值 `end_turn | max_tokens | max_turn_requests | refusal | cancelled`（:215-227, :292-311）。**v1 的响应即 turn 终点**——这是 v2 改造的核心（§9）。
- **session/cancel**（通知）：client 可随时打断；client 应把未完成 tool call 标记为 cancelled、以 `cancelled` outcome 回应所有 pending 权限请求；agent 停止后 **MUST** 以 `stopReason:"cancelled"` 响应原 prompt（:312-345）。agent **MUST** 捕获底层 SDK 的 abort 异常并翻译成语义化的 cancelled（:334-341 Warning）。
- **session/set_mode**：`{sessionId, modeId}` 切换模式（`docs/protocol/v1/session-modes.mdx:77-104`）。**没有** `session/set_model`；模型/思考等级选择走 config options（§8）。`providers/list|set|disable`（agent 方法）仅在 unstable feature 下。

---

## 5. 流式更新：`session/update` 全量变体

wire 格式：`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId", "update":{"sessionUpdate": <tag>, ...}}}`，tag 为 snake_case。Rust 权威枚举 `SessionUpdate`（`agent-client-protocol-schema/src/v1/client.rs:99-169`，`#[serde(tag="sessionUpdate", rename_all="snake_case")]`）：

**v1 稳定变体**：
1. `user_message_chunk`（`ContentChunk`）——用户消息流式块（重放时出现；live turn 中用户消息内嵌于 prompt 请求）。
2. `agent_message_chunk`——agent 回复文本/富内容流（`docs/protocol/v1/prompt-turn.mdx:147-169`；`messageId` 可选：同 ID 属同一条消息，ID 变化即新消息）。
3. `agent_thought_chunk`——agent 内部思考流（reasoning 事件）。
4. `tool_call`——新建工具调用报告（见下）。
5. `tool_call_update`——增量更新工具调用；除 `toolCallId` 外字段皆可选，只发改动的字段（`docs/protocol/v1/tool-calls.mdx:98-131`）。
6. `plan`——任务计划全量替换：`entries[{content, priority: high|medium|low, status: pending|in_progress|completed}]`，"MUST 发送完整列表，Client 整体替换"（`docs/protocol/v1/agent-plan.mdx:44-83`）。
7. `available_commands_update`——slash 命令广告：`availableCommands[{name, description, input:{hint}}]`，可随时推送；命令以普通 `/cmd args` 文本进入 prompt 执行（`docs/protocol/v1/slash-commands.mdx:8-96`）。
8. `current_mode_update`——agent 侧模式变更 `{currentModeId}`（`session-modes.mdx:106-122`）。
9. `config_option_update`——agent 推送全量 `configOptions`（`session-config-options.mdx:318-349`）。
10. `session_info_update`——标题/时间戳/`_meta` 元数据（`session-list.mdx:177-217`）。
11. `usage_update`——**用量上报已进入 v1 稳定面**：`{used, size, cost?: {amount, currency}}`，`used`/`size` 为当前上下文 token 数与窗口大小，`cost` 为 ISO 4217 累计费用（`prompt-turn.mdx:190-213`；`src/v1/client.rs:609-629` `UsageUpdate{used: u64, size: u64, cost}`）。发布于 `docs/announcements/session-usage-stabilized.mdx`（标注 2026-06-05）。

**v1 unstable 变体**（`#[cfg(feature=...)]`，RFD 草案，默认关闭）：`plan_update` / `plan_removed`（`unstable_plan_operations`，`client.rs:113-126`）；`notice`（`unstable_session_notices`，非历史内 advisory，:139-148）；`compaction_update` / `compaction_summary_chunk`（`unstable_session_compaction`，上下文压缩实体 + 摘要流式追加，:149-168；设计见 `docs/rfds/session-compaction.mdx`，含 `compactionId` + `status: in_progress|completed`）。

**tool_call 细节**（`docs/protocol/v1/tool-calls.mdx:14-96`；`src/v1/tool_call.rs`）：
- 字段：`toolCallId`（必填）、`name`（可选程序化工具名，"不广告能力、不授予权限"）、`title`（人类可读，必填）、`kind`、`status`、`content[]`、`locations[]`、`rawInput`、`rawOutput`（任意 JSON 值；更新时缺省 = 保持原值）。
- `ToolKind`（`tool_call.rs:473-496`）：`read | edit | delete | move | search | execute | think | fetch | switch_mode | other`（默认，`#[serde(other)]` 兜底）。
- `ToolCallStatus`（`tool_call.rs:514-525`）：`pending`（输入流式中或等待批准）→ `in_progress` → `completed | failed`。
- `ToolCallContent` 三种（`tool_call.rs:546-557`）：`content`（MCP 式内容块）、`diff`（`{path, oldText?, newText}` 单文件文本 diff，`:277-295`）、`terminal`（`{terminalId}` 引用 `terminal/create` 产物，client 持续展示 live 输出，`terminals.mdx:113-140`）。
- `ToolCallLocation{path, line?}`：让 client 实现"跟随 agent"光标联动（`tool-calls.mdx:318-337`）。

---

## 6. 客户端工具反转：client 是 fs/terminal 的工具提供方

ACP 最有意思的架构决定：**agent 侧工具执行可以反向调用 client**。连接是双向 JSON-RPC，client 同时也是 server。

- **fs/read_text_file**：agent→client 请求 `{sessionId, path, line?, limit?}`，返回 `{content}`；可读编辑器未保存状态（`docs/protocol/v1/file-system.mdx:31-75`）。行号 1-based；所有路径必须绝对（`overview.mdx:212-215`）。
- **fs/write_text_file**：`{sessionId, path, content}`，client MUST 在文件不存在时创建（`file-system.mdx:77-117`）。
- **terminal/create**：`{sessionId, command, args?, env?, cwd?, outputByteLimit?}`，client 立即返回 `{terminalId}`，命令后台运行（`docs/protocol/v1/terminals.mdx:28-111`）；`outputByteLimit` 超限时从头部截断且 MUST 在字符边界截断（:79-90）。
- **terminal/output**：`{output, truncated, exitStatus?:{exitCode?, signal?}}` 非阻塞取当前输出（:142-190）。
- **terminal/wait_for_exit**：阻塞至退出（:191-227）。
- **terminal/kill**：杀命令但保留终端（仍可 output/wait_for_exit），**MUST** 仍要 release（:229-249）。超时由 agent 组合原语实现：create → 计时器与 wait_for_exit 竞争 → 到点 kill → output 取尾 → release（:251-262）——协议不内置 timeout 参数，用组合表达。
- **terminal/release**：杀进程并释放全部资源，ID 失效（:264-282）。
- **session/request_permission**：agent→client 请求用户授权（§7）。
- **elicitation/create + elicitation/complete**：基于 MCP elicitation 数据模型的结构化问询（form 模式：受限 JSON Schema；URL 模式：带外 OAuth 流，`elicitationId` + 完成通知回连，`docs/protocol/v1/elicitation.mdx`）。form 模式 **MUST NOT** 用于索取机密（:105-111）。
- **MCP 反向注入**：client 想把自家工具给 agent，"可以把自己作为一个 MCP server 配置传给 agent"，必要时用 stdio proxy 隧道回传（`session-setup.mdx:543-545`；`architecture.mdx:31-35` 及 mcp-proxy 图）。

**为什么反转**：让"编辑器"保持对文件系统与终端的权威（含未保存缓冲、终端 UI 呈现），agent 只需说意图。但这份 client 执行面在 v2 草案中被**整体删除**：`fs/*` 与全部 `terminal/*` 方法移除，改为"client 通过 `mcpServers` 提供工具，agent 拥有 display-only 的 terminal 流"（`docs/protocol/v2/migration.mdx` "Client file system and terminal execution removed"："inconsistently implemented outside of a few IDEs"）。这是对 ARI 极有借鉴意义的教训（§11）。

---

## 7. 权限模型

- 请求：`session/request_permission`（agent→client **请求**，即 agent 阻塞等待 JSON-RPC 响应），参数 `{sessionId, toolCall: ToolCallUpdate, options[], _meta?}`——`toolCall` 允许在请求权限的同时刷新/补全工具调用展示（`docs/protocol/v1/tool-calls.mdx:135-174`；`src/v1/client.rs:968-985`）。
- 选项：`PermissionOption{optionId, name, kind}`，`kind ∈ allow_once | allow_always | reject_once | reject_always`（`tool-calls.mdx:213-233`；`client.rs:1092-1101`）。kind 只是 UI 提示（图标/语义），具体"记忆"策略在 client。
- 响应：`{outcome: {outcome:"selected", optionId} | {outcome:"cancelled"}}`（`tool-calls.mdx:176-211`；`client.rs:1152-1167`，`#[serde(tag="outcome")]`）。turn 被 cancel 时 client **MUST** 对所有 pending 请求回 `cancelled`（`tool-calls.mdx:193-205`）。
- client 可依据用户设置自动放行/拒绝（`tool-calls.mdx:191`）。
- 级联取消：`$/cancel_request`（`{requestId}`，协议级通知，`agent-client-protocol-schema/src/v1/protocol_level.rs:73`）可用于撤销 agent 发出的单个请求（如 terminal/create 或权限请求），响应错误码 `-32800`（`docs/protocol/v1/cancellation.mdx:10-38`；级联时序 :40-68）。
- **任务书问的 "edit param on approval"（批准时附带编辑/参数修改）**：v1 稳定协议中源码/文档中未找到——权限响应只有 selected/cancelled，无携带参数修改的字段。v2 草案的演进是把权限提示与工具状态解耦：`title`（必填）、`description?`、`subject: {type:"tool_call"|"command", ...}` 可扩展主语（`docs/protocol/v2/migration.mdx` "Permission requests"）。等价的"批准时修改输入"在 ACP 中不存在。
- 典型用法：architect 模式下的 "switch_mode" 工具借用同一权限机制征求"退出计划模式"的确认（`session-modes.mdx:124-173`，选项 kind 映射到 allow_always/allow_once/reject_once）。

---

## 8. 会话模式与配置

- **modes（v1，标记弃用中）**：session 响应可带 `modes: {currentModeId, availableModes[{id,name,description}]}`，示例即 ask/architect/code（`session-modes.mdx:15-47`）。文档头部 Note：config options 是新方式，"专用 mode 方法将在未来版本移除"（:6-11）；`session/set_mode` 与 `current_mode_update` 同理。
- **session config options（取代者）**：agent 在 session 响应返回有序 `configOptions[]`；每项 `{id, name, description?, category?, type: "select"|"boolean", currentValue, options: ConfigOptionValue[] | ConfigOptionGroup[]}`（`session-config-options.mdx:15-110`）。语义类别 `mode | model | model_config | thought_level`，`_` 前缀类别留给自定义；类别仅供 UX（快捷键/图标/摆放），MUST 容忍未知类别（:191-211）。boolean 型需 client 先广告 `session.configOptions.boolean`（:154-189）。
- **修改**：client 用 `session/set_config_option {sessionId, configId, value}`，agent **MUST** 返回**全量** configOptions（因为选项间可能联动，如换模型改变 reasoning 选项）；agent 主动变更推 `config_option_update`（:233-355）。v1 的 `set_config_option` 值是裸 string|boolean，v2 改为带 `type` 判别的 `{type:"id"|"boolean"}`（`migration.mdx` "Session modes become config options"）。
- 降级策略：agent 提供 configOptions 时 SHOULD 同时保留 `modes` 供旧 client，支持 configOptions 的 client SHOULD 忽略 `modes`（:357-368）。

---

## 9. ACP 明确不覆盖 / 覆盖不足的面

- **agent loop 内部**：prompt-turn 文档只约定"agent 处理用户消息并与 LLM 交互"，对内部分轮、重试、模型切换完全无感知（`prompt-turn.mdx:100-102`）。
- **模型 provider / API key**：无协议面；认证是 agent 账号体系（§3）。provider 管理方法仅 unstable（`v1/agent.rs:4758-4763`）+ RFD `custom-llm-endpoint.mdx`。
- **上下文压缩**：稳定 v1 无；`usage_update` 只报窗口占用不报压缩事件；压缩作为 `compaction_update`/`compaction_summary_chunk` 处于 unstable + RFD 阶段（`docs/rfds/session-compaction.mdx`；v1 `client.rs:149-168`）。ARI 应注意：这是"runtime 内部职责泄漏到 UI"的边界案例，ACP 选择"报事件、不报机制"。
- **子 agent**：协议无子 agent 概念。仅 `docs/rfds/proxy-chains.mdx:402` 提到"代理可通过新会话制造 subagents"、`docs/rfds/session-fork.mdx:35` 把 fork 用途之一列为 summaries/可能 subagents——即：多 agent 靠**多 session/多连接/代理层**组合，而非协议内实体。
- **后台任务**：v1 无显式模型（turn 之外发 `session/update` 属于灰色地带）。v2 草案正面解决"beyond the turn"：prompt 响应只确认用户消息插入（返回 `messageId`），`state_update{running|idle|requires_action}` 承载前台状态与 stopReason，idle 期间后台更新可以继续（`docs/announcements/acp-v2-draft.mdx`；`migration.mdx` "The new prompt lifecycle"）。
- **用量**：会话级 context/cost 已稳定（`usage_update`）；**每 turn 的 token 明细**（input/output/cache/reasoning 分类）仍是 Draft RFD `docs/rfds/end-turn-token-usage.mdx`（"Intentionally kept in Draft"），v1 `PromptResponse` 无 usage 字段。
- **PTC（programmatic tool calling，模型直接在代码里调工具）**：源码/文档中未找到任何协议支持。
- **并行工具**：无显式扇出语义；可获得性来自 JSON-RPC 双向并发（多个 in-flight 请求）+ `terminal/create` 的后台执行 + 一连接多 session（`architecture.mdx`）。取消文档的时序图（`cancellation.mdx:40-68`）明确展示了 agent 同时挂起 terminal/create 与 request_permission 两个并发请求。
- **文件变更**：v1 的 diff 表达力有限（单文件 `oldText/newText`，无法区分删除 vs 清空、无 rename/copy/binary）；v2 草案换成结构化 `changes[]`（add/delete/modify/move/copy + fileType/mimeType）+ 可选 `git_patch`（`migration.mdx` "Diff Overhaul"/"Diff content"）。

---

## 10. 生态证据

- **官方 Registry**：`curl https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，GitHub `agentclientprotocol/registry`，PR 制提交 agent manifest（`docs/get-started/_registry_agents.mdx`）；RFD 已 Completed（`docs/announcements/acp-agent-registry-stabilized.mdx`）。
- **实现 ACP 的 agents**（`docs/get-started/agents.mdx`，节选）：Gemini CLI（google-gemini/gemini-cli）、Claude Agent（经 Zed 的 SDK adapter `zed-industries/claude-agent-acp`）、**Codex CLI（经官方 adapter `agentclientprotocol/codex-acp`）**、Qwen Code、Kimi CLI、OpenCode、Goose、Cursor CLI、GitHub Copilot CLI（public preview，changelog 链接）、Junie、Cline、Factory Droid、Mistral Vibe、OpenHands、Docker cagent、Kiro CLI 等 40+。
- **实现 ACP 的 clients**（`docs/get-started/clients.mdx`）：Zed、JetBrains AI Assistant、Qt Creator（官方 ACP 插件）、Visual Studio（Poolside Assistant）、VS Code 多个扩展（vscode-acp、ACP Patchbay 等）、Neovim（CodeCompanion/agentic.nvim/avante.nvim/hermes.nvim）、Emacs（agent-shell.el）、Obsidian 多插件、Pulsar、Sublime、Unity、DuckDB/marimo/Jupyter 集成；CLI/TUI（acpx、Toad、Nori CLI…）；桌面/网页数十款；**消息桥**（Slack/Discord/Telegram/微信/飞书/QQ）；移动端（Happy、Runmote 等）；以及 stdio↔HTTP/WebSocket 的 connector 层（`acp_rpc_bridge`、ACP to AG-UI 等——恰好证明传输层是生态自建的补丁点）。
- **官方 SDK**：Kotlin（acp-kotlin）、Java、Python、Rust（`agent-client-protocol` runtime crate + `agent-client-protocol-schema` schema crate）、TypeScript（`@agentclientprotocol/sdk`）（`README.md` Integrations 节）。

---

## 11. 边界分析：ACP vs ARI

**重叠区**（ARI 若做，几乎必然复用 ACP 的形状）：会话抽象（`sessionId` + `session/new|prompt|cancel`）；流式更新（chunk 化的 `session/update` + 工具调用生命周期事件）；审批（options 数组 + kind 提示 + selected/cancelled outcome）；fs/terminal 的 client 桥接（client 作为工具提供方）；resume/重放语义；`_meta` 扩展与开放枚举兼容策略。

**本质差异**：
1. **对端身份不同。** ACP 的对端是"编辑器/任意 UI"，核心动机是 UX（`architecture.mdx` "UX-first"；diff、跟随光标、终端 live 输出都是编辑器场景）。ARI 的对端是 Coding Shell ↔ Agent Runtime/Harness：Shell 不只是渲染器，它自己有 loop、上下文、工具与任务编排，需要的是**运行时托管与委派**（会话编排、后台任务、并发工具、压缩边界、usage 结算），而非"给编辑器补一个聊天面板"。证据：ACP v2 才补 `state_update`（running/idle/requires_action）与 turn 之外的事件流，且把 client 执行面删掉——恰恰说明"编辑器当工具宿主"的模型撑不住更厚的 runtime 场景。
2. **所有权方向相反。** ACP v1：状态在 agent，文件/终端权威在 client（反转）。v2：全部回收给 agent（agent-owned terminal、经 MCP 提供工具）。ARI 应一开始就明确：**上下文与历史的权威在 Runtime**，Shell 持有的是展示态与其本地资源（workspace、凭据、终端）；工具执行权按资源归属分配，而不是按"谁是编辑器"分配。
3. **粒度。** ACP 的 session ≈ 一个对话线程；ARI 需要的 task/session 层级（subagent、fan-out、后台任务、取消树）在 ACP 里只有 proxy/fork 的 RFD 雏形（§9）。

**ARI 不应从 ACP 抄的东西**：
- **fs/terminal 反转执行面**（v1 的 `fs/*`、`terminal/*`）——ACP 自己已在 v2 弃用，理由是"除少数 IDE 外实现不一致"；ARI 用 MCP/工具清单桥接 client 资源即可。
- **turn 与请求生命周期绑死**（v1 prompt-response=turn）——v2 已改；ARI 从第一天起就该把"提交输入"与"工作进度/完成"分离（参考 `state_update`）。
- **modes 双轨**（`modes` + configOptions 并存）——弃用期双轨是历史包袱，ARI 只需 config/selector 一种机制。
- **int 魔数 protocolVersion + 语义靠文档**——可借但其版本策略应配 capability 位图而非仅 MAJOR 整数。

**值得 ARI 抄的东西**：
- **权限 options 模型**：`{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}` + `selected/cancelled` outcome + "cancelled 不算错误"语义（`tool-calls.mdx`、`prompt-turn.mdx:334-341`）——简单、可本地化、client 可自动化；v2 的 `subject` tagged union（tool_call/command 可扩展）把"请求什么"与"展示什么"解耦，也值得照搬。
- **tool_call 生命周期**：`pending（等待输入/批准）→ in_progress → completed/failed` + `toolCallId` 幂等 upsert + `rawInput/rawOutput` 透传 + `locations` 跟随 + `kind` 分类（`tool_call.rs:473-525`）。ARI 的工具事件流可以直接对齐这套状态机以换取生态心智。
- **update chunking 与 upsert 补丁语义**：v2 的三态补丁（缺省=不变 / null=清除 / 值=替换；chunk=追加）+ 必填 `messageId`（`migration.mdx` "Updates are upserts"）是流式 UI 的正解，避免 v1 `tool_call`/`tool_call_update` 双方法与 plan 全量重放的尴尬。
- **NDJSON-over-stdio 分帧与 stdout 纯净规则**（§2）——比 LSP 的 Content-Length 简单一个数量级，且可 `grep`/`jq` 调试；`MUST NOT` 污染 stdout 的规则必须保留。
- **`_meta` + `_` 前缀扩展法与开放枚举**——向前兼容成本低。
- **cancelled 级联模型**：`session/cancel`（语义级）+ `$/cancel_request`（请求级，-32800）两层取消（`cancellation.mdx`）。

---

## 12. Capability Matrix —— ACP 行

| Session | Resume | Streaming | Cancellation | Approval | Tool events | File changes | Terminal | Background task | Parallel tools | Compaction | Subagent | Usage | Reasoning events | PTC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ✓ | ✓ (partial*) | ✓ | ✓ | ✓ | ✓ | partial | ✓ (v1 client-run / v2 agent-display) | ✗ (v1) / partial (v2 draft) | partial | partial (unstable) | ✗ | partial (session-level ✓, per-turn ✗) | ✓ | ✗ |

证据指针：Session = `session/new` + 一连接多 session（`docs/get-started/architecture.mdx:20`，`session-setup.mdx:45-81`）；Resume = `session/load` 重放 + `session/resume` 免重放（`session-setup.mdx:83-253`，*两者 v2 合并）；Streaming = `session/update` 11 种稳定变体（`v1/client.rs:99-169`）；Cancellation = `session/cancel` + `$/cancel_request`/-32800（`prompt-turn.mdx:312-345`，`cancellation.mdx:10-38`）；Approval = `session/request_permission` 4 种 kind（`tool-calls.mdx:133-233`）；Tool events = tool_call 生命周期 + rawInput/rawOutput（`tool-calls.mdx:14-131`）；File changes = 单文件 oldText/newText diff + locations（`tool-calls.mdx:277-295`，v2 结构化 changes：`migration.mdx`）；Terminal = client 侧 `terminal/*` 五方法（`terminals.mdx`）；Background = v1 无协议面、v2 `state_update`+idle 后台更新（`acp-v2-draft.mdx`）；Parallel = 无显式扇出，仅并发请求 + 后台 terminal + 多 session（`cancellation.mdx:40-68`）；Compaction = unstable feature + RFD（`v1/client.rs:149-168`，`rfds/session-compaction.mdx`）；Subagent = 源码/文档中未找到（仅 `rfds/proxy-chains.mdx:402`、`rfds/session-fork.mdx:35` 提及组合方式）；Usage = `usage_update`（context+cost，稳定）而 per-turn token 明细 Draft（`prompt-turn.mdx:190-213`，`rfds/end-turn-token-usage.mdx`）；Reasoning = `agent_thought_chunk`（`v1/client.rs:104-105`）；PTC = 源码/文档中未找到。

---

## 13. 传输层判断：JSON-RPC-over-stdio 是否污染数据模型？

**基本不污染，且有明显的刻意隔离。** 论据：

1. **数据模型对传输无感**：`transports.mdx:50` 明言 "The protocol is transport-agnostic"；schema（`schema/v1/schema.json` 及 Rust crate）只描述 params/result，不出现任何 stdio/帧概念；JSON-RPC 信封被压缩到 `rpc.rs` 的三个薄类型（`Request`/`Notification`/`JsonRpcMessage`），方法名是纯字符串常量表（`meta.json`）。换 HTTP/WebSocket 时消息体不变（`rfds/streamable-http-websocket-transport.mdx`："same JSON-RPC message format and ACP lifecycle as the existing stdio transport"）。
2. **NDJSON 是正确的取舍**：JSON 序列化本身转义换行，"MUST NOT contain embedded newlines"（`transports.mdx:24`）不损失表达力；换来可 `head`/`grep`/`jq` 直调 agent、无 LSP 式头部状态机。代价只有一条：单行超长（大 base64 图片/音频）会撑大内存缓冲——TS `LineBuffer` 与 Rust `Lines` 都要缓存半行；`outputByteLimit` 这类字段的出现说明生态已感知大负载问题。
3. **batch 是" SDK 先行、规范后补"的轻微裂缝**：v1 规范说消息是"individual JSON-RPC requests, notifications, or responses"（`transports.mdx:23`），未授权 batch；rust-sdk 的分帧层却统一支持 batch（`md/transport-architecture.md` "JSON-RPC Batch Behavior ... shared by the stable v1 and draft v2 APIs"）；v2 规范才正式收编 batch 并警告"勿 batch 生命周期敏感消息"（`migration.mdx` Transports 节）。ARI 教训：**分帧语义要进 v1 规范**，否则 SDK 会替规范做决定。
4. **JSON-RPC 层约定成了隐性协议面**：`$/cancel_request` 与 `-32800`（`protocol_level.rs:73`、`cancellation.mdx:22`）是 LSP 式的 JSON-RPC 约定，位于"协议级"而非 ACP 数据模型——这个分层（protocol-level vs session-level 方法）本身是干净的。
5. **版本协商**：`initialize` 内嵌的 `protocolVersion` 整数（MAJOR-only）+ 能力位（omitted=unsupported）双轨（§2）；v2 草案沿用同一机制并要求"一连接一版本"（`migration.mdx` Version negotiation）。整数版本 + capability 的组合对 ARI 够用，但 ACP 的"artifact 版本（crate/schema）与 wire 版本解耦"声明（`README.md` Versioning）值得 ARI 写进规范第一页——SDK 版本号不等于协议版本号是最常见的社区误读。

---

## 14. 方法 / 通知参考表（ACP v1 稳定面）

方法名以 `schema/v1/meta.json` 与 `v1/agent.rs:4753-4789`、`v1/client.rs:2689-2707` 常量为准；方向：A=agent 实现（client 调用），C=client 实现（agent 调用），P=协议级双向。

### Client → Agent（agent 侧方法）

| 方法 | 类型 | 参数 → 结果 | 能力门槛 | 证据 |
|---|---|---|---|---|
| `initialize` | Request | `{protocolVersion, clientCapabilities, clientInfo?}` → `{protocolVersion, agentCapabilities, agentInfo?, authMethods[]}` | 无（基线） | initialization.mdx:24-98；v1/agent.rs:4753 |
| `authenticate` | Request | `{methodId}` → `{}` | `authMethods` 广告 `type:"agent"` 方法 | authentication.mdx:134-167；agent.rs:4755 |
| `logout` | Request | `{}` → `{}` | `agentCapabilities.auth.logout` | authentication.mdx:190-216；agent.rs:4789 |
| `session/new` | Request | `{cwd, mcpServers[], additionalDirectories?}` → `{sessionId, modes?, configOptions?}` | 基线；additionalDirectories 需 cap | session-setup.mdx:45-81,313-344 |
| `session/load` | Request | `{sessionId, cwd, mcpServers[]}` → `{}`（响应前重放历史） | `loadSession` | session-setup.mdx:83-188 |
| `session/resume` | Request | `{sessionId, cwd, mcpServers[]}` → `{}`（可附 mode/model/config） | `sessionCapabilities.resume` | session-setup.mdx:190-253 |
| `session/close` | Request | `{sessionId}` → `{}` | `sessionCapabilities.close` | session-setup.mdx:255-311 |
| `session/list` | Request | `{cwd?, cursor?}` → `{sessions[SessionInfo], nextCursor?}` | `sessionCapabilities.list` | session-list.mdx:66-176 |
| `session/delete` | Request | `{sessionId}` → `{}` | `sessionCapabilities.delete` | session-delete.mdx；agent.rs:4780 |
| `session/prompt` | Request | `{sessionId, prompt[ContentBlock]}` → `{stopReason}` | 基线 | prompt-turn.mdx:57-98,292-311 |
| `session/set_mode` | Request | `{sessionId, modeId}` → `{modes?}` | 无（弃用中） | session-modes.mdx:77-104；agent.rs:4770 |
| `session/set_config_option` | Request | `{sessionId, configId, value}` → `{configOptions[] 全量}` | 无（boolean 型需 client cap） | session-config-options.mdx:237-316 |
| `session/cancel` | Notification | `{sessionId}` | 基线 | prompt-turn.mdx:312-345；agent.rs:4776 |

### Agent → Client（client 侧方法/通知）

| 方法 | 类型 | 参数 → 结果 | 能力门槛 | 证据 |
|---|---|---|---|---|
| `session/update` | Notification | `{sessionId, update{sessionUpdate: <tag>, ...}}` | 基线（各 tag 见 §5） | v1/client.rs:99-169,2689 |
| `session/request_permission` | Request | `{sessionId, toolCall:ToolCallUpdate, options[]}` → `{outcome}` | 基线方法 | tool-calls.mdx:133-233；client.rs:968 |
| `fs/read_text_file` | Request | `{sessionId, path, line?, limit?}` → `{content}` | `fs.readTextFile` | file-system.mdx:31-75；client.rs:2695 |
| `fs/write_text_file` | Request | `{sessionId, path, content}` → `{}` | `fs.writeTextFile` | file-system.mdx:77-117 |
| `terminal/create` | Request | `{sessionId, command, args?, env?, cwd?, outputByteLimit?}` → `{terminalId}` | `terminal` | terminals.mdx:28-111 |
| `terminal/output` | Request | `{sessionId, terminalId}` → `{output, truncated, exitStatus?}` | `terminal` | terminals.mdx:142-190 |
| `terminal/wait_for_exit` | Request | `{sessionId, terminalId}` → `{exitCode?, signal?}` | `terminal` | terminals.mdx:191-227 |
| `terminal/kill` | Request | `{sessionId, terminalId}` → `{}` | `terminal` | terminals.mdx:229-249 |
| `terminal/release` | Request | `{sessionId, terminalId}` → `{}` | `terminal` | terminals.mdx:264-282 |
| `elicitation/create` | Request | `{sessionId|requestId, mode:"form"|"url", message, requestedSchema?/elicitationId+url}` → `{action: accept/decline/cancel, content?}` | `elicitation.form/url` | elicitation.mdx:57-167 |
| `elicitation/complete` | Notification | `{sessionId?, elicitationId}` | URL mode | elicitation.mdx:155-167 |

### 协议级（双向）

| 方法 | 类型 | 参数 | 语义 | 证据 |
|---|---|---|---|---|
| `$/cancel_request` | Notification | `{requestId}` | 请求级取消；响应 `-32800` | protocol_level.rs:73-106；cancellation.mdx:10-38 |

### `session/update` 变体速查（v1 稳定 + unstable）

`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update`；unstable：`plan_update`、`plan_removed`、`notice`、`compaction_update`、`compaction_summary_chunk`（`v1/client.rs:99-169`）。

---

## 15. 结论（给 ARI 的三句话）

1. ACP 证明了"薄协议 + 双向 JSON-RPC + NDJSON stdio + 能力协商 + `_meta` 扩展"足以支撑一个跨 40+ agent、数百 client 的生态；ARI 的会话/流式/审批层可以近乎照抄其形状（特别是 permission options、tool_call 状态机、upsert 补丁语义、cancelled≠error）。
2. ACP 的两次自我修正——v2 删除 client 执行面（fs/terminal）、v2 把 turn 从 prompt 响应中解耦（`state_update`）——正是 ARI 的起点而非终点：**ARI 面向"Shell ↔ Runtime"解耦，第一天就要按 v2 的形态设计**（事件流自持、输入提交与工作状态分离、client 资源经工具清单暴露），并补上 ACP 没有的后台任务、并发编排、per-turn usage、压缩与子 agent 的协议面。
3. 版本与传输纪律：整数 MAJOR `protocolVersion` + 能力位 + artifact 版本与 wire 版本解耦（照抄）；NDJSON-over-stdio 与 stdout 纯净规则（照抄）；分帧/batch 语义必须写进第一版规范（吸取 ACP 的 batch 裂缝）。
