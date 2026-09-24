# OpenCode 源码级研究报告 — ARI 设计参考

- 对象: OpenCode v1.18.32 (origin: github.com/anomalyco/opencode, fork of sst/opencode; 本地 repo `opencode/`，未入库)
- 方法: 全部基于本地源码阅读 (grep/glob/read), 未经标注即为【source】; 引用格式 `文件路径 + 符号名`。
- 重要总览: v1.18.32 的 OpenCode 已不是早期 "JSON 文件存储 + Hono server + Bus 事件" 的单一 package 形态, 而是一个 monorepo:
  - `packages/schema` — 浏览器安全的 wire/storage 契约 (Effect Schema), 事件清单 `EventManifest`;
  - `packages/protocol` — 当前 `/api/...` 协议面 (endpoint 定义 + 中间件);
  - `packages/core` — Effect 化的 domain core (V2 runtime, drizzle SQLite schema);
  - `packages/opencode` — 实例 runtime (session/agent/tool/permission/…), 对外暴露 Effect HttpApi server;
  - `packages/sdk/js` — 生成的 JS client SDK; `packages/sdk-next` 为新一代 SDK。
  - 命名约定 (见 `packages/schema/AGENTS.md`): 当前契约不带版本号 (`Session`, `Permission`), 旧契约标 `V1` (`SessionV1`, `PermissionV1`); `message.updated` / `message.part.*` 属于 V1-only 兼容事件。
  - 本文中 "legacy/V1" 指 `packages/opencode` 仍在线上运行的会话运行时, "V2/current" 指 `packages/core` 的新运行时与 `session.next.*` 事件面。两者在 v1.18.32 同时存在并桥接。

## 1. 架构总览 (server-based; runtime core; 客户端如何驱动)

v1.18.32 是 pnpm/bun monorepo, 分层 (`opencode/AGENTS.md` 依赖方向声明): `packages/schema`(Effect Schema 定义的 wire/storage 契约 + `EventManifest` 事件清单) ← `packages/protocol`(`/api/...` endpoint 定义, `protocol/src/groups/*`) ← `packages/core`(Effect 化 domain core: SQLite/drizzle 存储、EventV2、SessionRunner V2) ← `packages/opencode`(实例 runtime: session/agent/tool/permission/server)。客户端: `packages/sdk/js`(生成的 JS client, `sdk/js/src/client.ts`+`gen/`), `packages/sdk-next`(新 SDK, 组合 Client+Core+Server), 以及 TUI/App/CLI (`packages/tui` 等) 全部作为 HTTP 客户端连接本地 server。

- Server: `opencode/src/server/server.ts` — node:http + Effect HttpApi (`HttpApiApp`), 含 `MDNS`(局域网发现)、`WebSocketTracker`、OpenAPI 导出。每个 project directory 一个 instance, 事件按 directory/workspace 隔离。
- 协议面有两套并存: current `/api/...`(`packages/protocol/src/groups/`) 与 legacy 兼容面 (`opencode/src/server/routes/instance/httpapi/groups/`, 供 App/TUI/CLI, 含 `message.updated` 等 V1-only 事件, 见 `packages/schema/AGENTS.md` 事件分类规则)。
- Runtime core 是双轨: legacy V1 loop = `packages/opencode/src/session/prompt.ts` `SessionPrompt.loop`; V2 = `packages/core/src/session/runner/` + `SessionV2.prompt`(durable `session_input` 表 + `SessionExecution.wake`, 见 `opencode/AGENTS.md` V2 Session Core 规则)。v1.18.32 两者桥接 (`opencode/src/event-v2-bridge.ts`)。
- 客户端驱动方式: REST(`POST /api/session/:id/prompt` 等) + 单条 SSE `GET /api/event` 订阅全部事件; 无客户端 RPC 回调通道, 客户端是被动观察者 + 主动 POST 者 (permission/question/reply 除外)。

## 2. 消息模型: Session / Message / Part 全类型 + tool 状态机 + bus 事件名

契约在 `packages/schema/src/v1/session.ts` (V1 命名空间, 仍是在线运行时契约; current 契约见 `session-message.ts`)。

- `SessionInfo`(session.ts:543): `id, slug, projectID, workspaceID?, directory, parentID?, title, version, share{url}?, revert?{messageID, partID, snapshot, diff}, permission?`, `time{created, updated, compacting?, archived?}`, `cost, tokens, summary{additions, deletions, files, diffs}`。
- `Message = User | Assistant` (role 判别, session.ts:490)。`User`(session.ts:332): `time.created, format?, summary?{title, body, diffs}, agent, model{providerID, modelID, variant?}, system?, tools?`。`Assistant`(session.ts:453): `time{created, completed?}, error?(AuthError|UnknownError|OutputLengthError|AbortedError|StructuredOutputError|ContextOverflowError|ContentFilterError|APIError, session.ts:385), parentID, modelID, providerID, mode, agent, path{cwd, root}, cost, tokens{input, output, reasoning, cache{read, write}}, structured?, finish?`。
- `Part` 联合 12 类 (session.ts:357-370, 公共基座 `{id: prt_*, sessionID, messageID}`):
  1. `text`(session.ts:102): `text, synthetic?, ignored?, time{start, end?}, metadata?`
  2. `reasoning`(session.ts:118): `text, metadata?, time`
  3. `file`(session.ts:171): `mime, filename?, url, source?`(FilePartSource = file|symbol|resource, 带 text value+range)
  4. `agent`(session.ts:181): `name, source?` — 用户在 prompt 里 @切换 agent
  5. `subtask`(session.ts:204): `prompt, description, agent, model?, command?`
  6. `tool`(session.ts:315): `callID, tool, state: ToolState`
  7. `step-start`(session.ts:233): `snapshot?`
  8. `step-finish`(session.ts:240): `reason, cost, tokens{...}, snapshot?`
  9. `snapshot`(session.ts:87): `snapshot: string`
  10. `patch`(session.ts:94): `hash, files[]`
  11. `retry`(session.ts:220): `attempt, error: APIError, time.created`
  12. `compaction`(session.ts:195): `auto, overflow?, tail_start_id?`
- Tool 状态机 (session.ts:259-322, 按 `status` 判别): `pending{input, raw}` → `running{input, title?, metadata?, time.start}` → `completed{output, title, metadata, time{start, end, compacted?}, attachments?: FilePart[]}` | `error{error, metadata?, time{start, end}}`。无 cancelled 状态 — abort 归为 error。
- 事件名 (各 schema 模块 `Event.define`): session: `session.created/updated/deleted, message.updated, message.removed, message.part.updated, message.part.removed, message.part.delta{field, delta}, session.diff, session.error`(session.ts:571-676); 状态: `session.status, session.idle`(`schema/src/session-status-event.ts`); compaction: `session.compacted`; V2 runtime 全套 `session.next.*`(step/text/reasoning/tool.input/tool.called/progress/success/failed/retried/compaction/revert/shell, `schema/src/session-event.ts:55-442`); 权限: `permission.asked/replied`(`schema/src/v1/permission.ts:61-63`) + `permission.v2.asked/replied`; question: `question.asked/replied/rejected`(+v2); 文件: `file.edited`(`filesystem.ts:9`), `file.watcher.updated`(`filesystem-watcher.ts:7`); 终端: `pty.created/updated/exited/deleted`; 其它: `todo.updated, server.connected, server.heartbeat, global.disposed, server.instance.disposed, command.executed, mcp.tools.changed, lsp.updated, installation.*, vcs.branch.updated, workspace.*/worktree.*`。注意: 任务描述中的 "PermissionUpdated/FileChanged" 实际名为 `permission.asked` / `file.edited`+`file.watcher.updated`。
- Bus: 旧 `Bus` 模式已收敛为 `opencode/src/bus/global.ts` `GlobalBus`(EventEmitter, emit 时自动补 `evt_` 递增 id) + core `EventV2`(durable, 按 location 路由, `opencode/src/event-v2-bridge.ts` 是 publish 边界)。

## 3. Session: 创建 / 恢复 / ID / 持久化 / 多客户端 / 中断 / fork / share

- 创建: `Session.create`(opencode/src/session/session.ts), `plan()`(session.ts:331) 由 slug+时间算路径; `ForkInput`(session.ts:273)。ID 格式: `{prefix}_{时间可排序 base62}{12 随机}`(`schema/src/identifier.ts` `create`), prefix 表: `session:ses, message:msg, part:prt, permission:per, question:que, pty, tool, workspace:wrk, job, event:evt`(`core/src/id/id.ts:5-16`)。
- 持久化: 已从 "JSON 文件每消息" 迁移到 SQLite/drizzle (`core/src/session/sql.ts`): `session, message(data JSON), part(data JSON), todo, session_message, session_input, session_context_epoch` 七表; `opencode/src/storage/storage.ts` 保留从 `storage/session/message/*/*.json` 旧布局迁移的逻辑。Message/Part 以 JSON `data` 列整体存储 (非每 part 一文件)。
- resume/continue: 无显式 resume 动作 — session 持久于 DB, 对同 sessionID 继续发 prompt 即续聊; `GET /api/session` 列出 (默认最新 50, cursor 分页, protocol/groups/session.ts:109)。
- 多客户端: server 无状态派发, N 个客户端可同时挂 SSE + 读 REST; 同 session 并发 prompt 通过 `SessionRunState.ensureRunning` 合并到同一 runner (opencode/src/session/run-state.ts:88-94), 冲突操作 (shell) 返回 `BusyError`(run-state.ts:96-105, `assertNotBusy`:71)。
- 中断/abort: `POST /api/session/:id/interrupt`(protocol session.ts:345) → `SessionRunState.cancel`(run-state.ts:77-86) → runner.cancel + 级联 cancel 该 session 的 BackgroundJob (run-state.ts:111-129); processor `onInterrupt` 将 assistant 消息 finalize 为 `AbortedError`(prompt.ts:1203-1211, processor.ts:662-669)。
- fork: `Session.fork(sessionID, messageID?)`(session.ts:691) 复制消息到新 session, 标题追加 ` (fork #N)`(session.ts:162-168)。
- revert/undo: `SessionRevert.revert/unrevert`(session/revert.ts:38-96) 基于 snapshot 恢复 + patch 回滚; 协议端点 `session.revert.stage/clear/commit`(protocol/groups/session.ts:256-281)。
- share: `SessionInfo.share{url}`(v1/session.ts:526-528); 同步实现 `opencode/src/share/share.ts`+`share-next.ts` (细节未深入核对)。

## 4. Agent Loop: prompt → LLM stream → tool calls → 循环 / 并行 / 中断 / 重试 / 预算

控制流 (legacy V1, 全在 `opencode/src/session/prompt.ts`):
1. 入口: `POST /api/session/:sessionID/prompt`(protocol/groups/session.ts:205) → `SessionPrompt.loop`(prompt.ts:1343) → `state.ensureRunning(sessionID, lastAssistant, runLoop)`。
2. `runLoop`(prompt.ts:1082) `while(true)`: `status.set(busy)`; `MessageV2.filterCompactedEffect` 从 SQLite 载入消息; `MessageV2.latest` 取 lastUser/lastAssistant/finished/任务队列。
3. 退出条件 (prompt.ts:1111-1130): `lastAssistant.finish` 存在且非 `tool-calls/unknown`, 且无未完成 tool call (`hasToolCalls`, 忽略被中断孤儿 tool, prompt.ts:1106-1109), 且 `parentID === lastUser.id` → break。
4. `step++`; step 1 时 fork 两个后台任务: `ensureTitle`(prompt.ts:1133-1139) 与 `summary.summarize`(prompt.ts:1252-1253)。
5. 任务队列: `task.type === "subtask"` → `handleSubtask` 后 continue (prompt.ts:1144-1147); `"compaction"` → `compaction.process` 后 continue (1149-1159)。
6. 自动 compaction: `compaction.isOverflow(lastFinished.tokens)` → `compaction.create({auto: true})` → continue (1161-1168)。
7. `agent.steps ?? Infinity` 为 maxSteps; `isLastStep` 时向模型注入 `MAX_STEPS_PROMPT` 助手消息 (prompt.ts:1178-1179, 1281)。
8. `processor.create({assistantMessage, sessionID, model})` 得 handle (prompt.ts:1213); `SessionTools.resolve` 组装工具表 (合并 plugin/Permission/ToolRegistry/MCP/Truncate, prompt.ts:1226-1241); `json_schema` 格式注入 `StructuredOutput` 工具 + `toolChoice: required` (1243-1250, 1285)。
9. system = `sys.environment` + `instruction.system()`(AGENTS.md) + `sys.mcp` + `sys.skills` (prompt.ts:1257-1269); `MessageV2.toModelMessagesEffect` 把 V1 消息翻译成 provider 格式。
10. `handle.process(...)`: `llm.stream(streamInput)` 每 provider turn 恰一次调用 (processor.ts:654), 流式事件驱动 part 创建/更新, `Stream.takeUntil(() => ctx.needsCompaction)` 截断 (processor.ts:656-660)。
- 并行 tool calls: 同一 assistant 消息的多个 tool call 由 ai-sdk 并发执行, processor 以 `toolCallID` 为 key 维护 `ctx.toolcalls` map (processor.ts:123-203 `settleToolCall/readToolCall/completeToolCall/failToolCall`); 源码中未找到强制串行开关。
- 重试: `Effect.retry(SessionRetry.policy({provider, parse, set: status.set({type:"retry", attempt, ...})}))`(processor.ts:674-688), 发 `session.status` retry + `RetryPart`; `session.next.retried` 为 V2 对应事件。
- tool 失败: `failToolCall` 将 tool part 置 `error` 状态 (processor.ts:186-203), 输出回传模型; `experimental.continue_loop_on_deny` 决定权限拒绝时是否续跑 (processor.ts:647)。
- 中断: fiber interrupt → `aborted` 标记 + assistant 消息写 `AbortedError` (processor.ts:662-669)。
- 超时: LLM turn 源码中未找到全局超时; tool 层面 shell 有 `input.timeout`(见 §8)。
- token 预算: 无全局预算, 逐模型 `maxOutputTokens`(session/llm.ts:238); context 上限由 compaction 兜底 (§9)。
- 结构化输出: `handle.message.structured` 写回后 break (prompt.ts:1288-1293)。
- 收尾: `compaction.prune` fork 清理旧 tool 输出 (prompt.ts:1338); 返回最终 `lastAssistant`。

## 5. Tool Runtime: Tool.define 抽象 / builtin 工具清单 / callID / 流式输出 / 取消 / 权限门

- `Tool.define`/`Def`(opencode/src/tool/tool.ts:55-65): `{id, description, parameters: Effect Schema, jsonSchema?, execute(args, ctx) → ExecuteResult}`。`Context`(tool.ts:36-46): `{sessionID, messageID, agent, abort: AbortSignal, callID?, extra?, messages, metadata({title, metadata}) → 发 part 更新, ask(permission request)}`。`ExecuteResult`(tool.ts:48-53): `{title, metadata, output: string, attachments?: FilePart[]}`。
- `wrap`(tool.ts:99-148): 参数解码失败 → `InvalidArgumentsError`; 执行后统一走 `Truncate.output` 截断, 写 `metadata.truncated + outputPath` (tool.ts:131-144); 全部包 `Effect.withSpan("Tool.execute")`。
- Builtin 注册表 (tool/registry.ts:209-252): `invalid, question, shell, read, glob, grep, edit, write, task, fetch(webfetch), todo, search(websearch), skill, patch(apply_patch)` + 条件 `execute`(code-mode, experimental)、`lsp`(experimentalLspTool)、`plan`(experimentalPlanMode+CLI)。注意 bash 工具名为 `shell`。Plugin 自定义工具经 `fromPlugin`(registry.ts:136-202, Zod 参数兼容层, 同样截断+span); MCP 工具经 `ToolRegistry.tools` + `Permission.visibleTools`(registry.ts:286)。
- callID: `ToolPart.callID` = provider 返回的 tool call id (v1/session.ts:318), 状态迁移由 processor 按 callID 结算。
- 流式输出: 工具执行中随时 `ctx.metadata({title, metadata})` 增量更新 tool part → `message.part.updated` 推给客户端 (如 shell 每 chunk 更新 `metadata.output`, tool/shell.ts:515-528); 无独立 "tool output delta" 事件, 客户端靠 part 全量重发感知进度。
- 结果编码: `output` 字符串进 `ToolStateCompleted.output` 给 LLM (`message-v2.ts:320-357` 转成 `tool-{name}` content block); `metadata`/`attachments` 主要给客户端; 截断时 LLM 拿截断文本 + outputPath 提示。
- 权限门: `SessionTools.resolve` 里 `ask: req → permission.ask({..., ruleset: Permission.merge(agent.permission, session.permission)})`(session/tools.ts:81-87); 工具内部再按需 `ctx.ask`(如 shell/MCP read patterns, tools.ts:180-184); plugin 钩子 `tool.execute.before/after`(tools.ts:107-121)。
- 取消: `ctx.abort` AbortSignal 贯穿 (tool.ts:40), shell 用它 race (§8)。
- 客户端可见性: 客户端收到完整 `ToolPart`(含 state.input、metadata、output); runtime 内部仅 plugin span/attributes 与 `extra`(如 `promptOps`) 不外泄。

## 6. Permission / Approval: config / request / reply / 模式

- 规则模型: ruleset = `{permission, pattern, action: "allow"|"ask"|"deny"}` 通配匹配; 来源两层: agent 配置 `agent.permission` + session 级 `session.permission` (`Permission.merge`, session/tools.ts:81-87); subagent 另经 `agent/subagent-permissions.ts` `deriveSubagentSessionPermission` 派生。
- `Permission.ask`(opencode/src/permission/index.ts:67-107): 逐 pattern `evaluate` → `deny` 直接 `DeniedError`(携带 ruleset 供客户端渲染); 全 `allow` 放行; 否则创建 `PermissionV1.Request{id: per_*, sessionID, permission, patterns, metadata, always, tool}` 存入 pending map + `Deferred`, publish `permission.asked`, 阻塞 await Deferred。
- 回复: `POST /api/session/:sid/permission/:rid/reply`(protocol/groups/permission.ts `session.permission.reply`) `reply: "once"|"always"|"reject"`(index.ts:109-167): `once` → 仅 succeed Deferred; `always` → 把 `always` patterns 追加进 approved 列表 (等效会话内持久规则), 且自动放行同 session 其它 pending 请求中现在能 evaluate 为 allow 的 (reply 事件 `always`); `reject` → fail Deferred (`RejectedError` 或带用户 feedback 的 `CorrectedError`, index.ts:121-127), 并级联 reject 同 session 其余 pending。
- 客户端如何知道在等: `permission.asked` 事件 (SSE) / `GET /api/permission/request` 与 `GET /api/session/:sid/permission` 列表 / `session.permission.get` 单查; 回复后 `permission.replied` 事件收尾。
- 无 "permission mode" 全局开关 (非 plan/read-only mode 式设计); 模式由 agent 定义 (如 `plan` agent 工具受限, agent/agent.ts:157)。同类人机闭环还有 question 工具 (`question.asked/replied/rejected` + `/api/question/*`)。

## 7. File / Diff: 文件 watcher / patch part / snapshot-undo / revert / git

- 文件事件: `file.edited`(schema/src/filesystem.ts:9, runtime 写文件时发) 与 `file.watcher.updated`(filesystem-watcher.ts:7, 外部变更 watcher) 是两类结构化事件; 客户端也可直接观察磁盘 (open-file REST: `fs.read/list/find`, protocol/groups/fs.ts)。task 描述中的 "FileChanged" 对应这两个事件。
- patch/snapshot part: 消息流内 `snapshot` part (snapshot hash, v1/session.ts:87) 与 `patch` part (`{hash, files[]}`, session.ts:94) 标记每次文件变更; session 汇总 diff 在 `session.diff` 事件 + `SessionInfo.summary.diffs`(FileDiff.Info)。
- snapshot 实现: `opencode/src/snapshot/index.ts` — 基于 git plumbing 的影子跟踪 (`Snapshot.state/track/restore/revert/diff/stage`, `Patch{hash, files}`, git 禁用时 `enabled` 判定跳过)。
- revert/undo: `SessionRevert.revert({sessionID, messageID, partID?})`(session/revert.ts:38-88): 记录/复用 `rev.snapshot`(`snap.track()`), `snap.revert(patches)` 回滚文件, 生成 `rev.diff`; `unrevert`(revert.ts:91-96) 用 `snap.restore` 恢复; 协议端点 `session.revert.stage/clear/commit`(protocol/groups/session.ts:256-281) 提供 "staged → commit" 两段式。
- git 集成: `core/src/git.ts` + `worktree/` 模块 (worktree.ready/failed 事件); session summary 统计 additions/deletions/files。

## 8. Command / Terminal: bash 输出流 / exit code / 后台进程 / PTY

- shell 工具 (`tool/shell.ts` `ShellTool`): `ChildProcessSpawner.spawn`(shell.ts:484) 启动进程; `handle.all`(stdout+stderr 合流) 流式消费 (shell.ts:487-528): 每 chunk 维护滚动 keep 缓冲 + `ctx.metadata({metadata: {output: lastPreview}})` → tool part 增量更新 → 客户端实时看到输出; 超过 `limits.maxBytes` 后溢写到文件 (`trunc.write`, shell.ts:505-514) 并在 metadata 带 outputPath。
- 退出码: `Effect.raceAll([handle.exitCode → {kind:"exit", code}, abort → {kind:"abort"}, timeout])`(shell.ts:531-545); 超时阈值 `input.timeout + 100ms`; 结果 metadata 记录 exit/abort/timeout (shell.ts:583-590 另在 output 尾部附 `<shell_metadata>`)。
- 取消: `ctx.abort` listener (shell.ts:520-529)。
- 后台进程: `BackgroundJob` service (`opencode/src/background/job.ts`, core `background-job.ts`); interrupt session 时级联 cancel 相关 job (session/run-state.ts:111-129); subagent 后台模式也走它 (task.ts:97-100)。task 描述中的 "background bash" 在此版本主要体现为后台 subagent + pty, 独立 "run_in_background" bash 参数源码中未找到。
- PTY: 完整交互式终端作为一等公民: schema `pty.created/updated/exited/deleted` 事件; REST `pty.list/create/get/update/remove/connect-token/connect`(protocol/groups/pty.ts); `connect` 由 token 授权 (连接为 WebSocket/websocket-tracker, server/routes/instance/httpapi/websocket-tracker.ts)。
- LSP: `lsp.updated` 事件 + experimental `lsp` 工具。

## 9. Context 管理: 系统提示 / AGENTS.md / compaction / 截断

- system prompt 组装 (prompt.ts:1257-1271): `sys.environment(model)`(环境信息) + `instruction.system()`(AGENTS.md/规则文件, `session/instruction.ts`) + `sys.mcp`(MCP 说明) + `sys.skills`; agent 模板在 `agent/prompt/`(agent/agent.ts 内置 build/plan/general/explore/compaction/title/summary 六类预设); 另有 `SessionReminders.apply` 注入提醒 (prompt.ts:1180-1184)。
- compaction 触发: (a) `isOverflow`: 上轮 `tokens.total(或四项和) >= usable`, `usable = model.limit.input − reserved` 或 `context − maxOutputTokens`, `reserved = cfg.compaction.reserved ?? min(COMPACTION_BUFFER, maxOutputTokens)`(session/overflow.ts:10-37); `compaction.auto === false` 关闭 (overflow.ts:30)。(b) LLM 流中触发 `needsCompaction` → `Stream.takeUntil` 中断本 turn, processor 返回 `"compact"`(processor.ts:646-658, 693), loop `compaction.create({auto: true, overflow})`(prompt.ts:1320-1327)。手动: `POST /api/session/:id/compact`(protocol/groups/session.ts:226)。
- compaction 执行: `CompactionPart{auto, overflow?, tail_start_id?}` 标记; `compaction.select` 按 `cfg.compaction.tail_turns` 预算保留尾部 (compaction.ts:223-267); 专有 `compaction` agent 执行摘要 (agent/agent.ts:220)。client 可见: `session.compacted` 事件 (schema/src/session-compaction-event.ts:7) + `SessionInfo.time.compacting` + 消息流中 CompactionPart。
- 历史裁剪 prune: `compaction.prune`(compaction.ts:273-302) 每轮结束 fork 执行, 阈值常量 `PRUNE_MINIMUM = 20_000` / `PRUNE_PROTECT = 40_000`(compaction.ts:28-29), 需 `cfg.compaction.prune` 开启。
- tool 输出截断: 每次 `Tool.define` wrap 统一 `Truncate.output`(tool/tool.ts:131-144, `tool/truncate.ts`), 截断后 LLM 拿截断文本 + `outputPath` 指向落盘文件; shell 另有输出溢写文件 (§8)。agent 粒度可配 (`agents.get(ctx.agent)` 传入)。
- token 记账: Assistant 消息累计 `tokens{input, output, reasoning, cache{read, write}}` + `cost`(v1/session.ts:471-481), step-finish part 逐步记录 (session.ts:240-257)。

## 10. Subagents: task tool / agent 类型 / 会话关系 / 事件转发

- `task` 工具 (`tool/task.ts`): 参数 `{prompt, description, subagent_type, task_id?(恢复先前 subagent session, task.ts:49), background?}`; 内置 agent 类型 (`agent/agent.ts:142-251`): `build`(默认), `plan`, `general`, `explore`, 及内部 `compaction/title/summary`。task 工具的动态描述按 agent 列表 + `Permission.evaluate("task", name)` 过滤生成 (tool/registry.ts:265-278)。
- 会话关系: 每次调用 `sessions.create({parentID: ctx.sessionID, title: "<desc> (@<agent> subagent)", agent, permission: 派生规则集})`(task.ts:154-167) — 子 session 是真实 Session, 父子靠 `parentID` 关联; 嵌套深度上限 `cfg.subagent_depth ?? 1`(task.ts:107-114)。
- 执行: 经 `ctx.extra.promptOps.prompt(...)` 在子 session 上跑完整 loop (task.ts:195-204), 默认阻塞直至子 agent 结束, 返回最后 text part; 子 agent 失败 (assistant error 或 tool error part) 上抛 `Subagent failed (task_id: ...)`(task.ts:205-213)。
- 后台模式: `background: true` 需 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`(task.ts:97-100); 立即返回, 完成后把结果作为 `synthetic` text part prompt 注入父 session (task.ts:230-250), 并有 `BackgroundJob` 兜底通知。
- 并行: 多个 task call 随并发 tool calls 并行; 或 background 化。
- 事件转发: 无显式转发机制 — 客户端从 tool part `metadata{parentSessionId, sessionId, model, background?}`(task.ts:171-177) 拿到子 sessionID, 自行订阅其事件 (TUI/CLI 即此做法: `cli/cmd/run/subagent-data.ts`, `stream.transport.ts:897` `listSubagentTabs`)。
- 清理: 中断父 session 会级联 cancel 子 session 的 background job (run-state.ts:118-124 按 sessionId/parentSessionId 匹配)。

## 11. Streaming & Transport: SSE /event 事件形状 / token delta / idle 语义 / SDK

- SSE: `GET /api/event`(protocol/src/groups/event.ts `event.subscribe`; 实现 `opencode/src/server/routes/instance/httpapi/handlers/event.ts`): `text/event-stream`, 每条 data 为 JSON `{id: evt_*, type, properties}`(`eventData`, event.ts:11-17); 连接即发 `server.connected`, 每 10s 心跳 `server.heartbeat`(event.ts:60-63); 服务端按 instance directory + workspaceID 过滤 (event.ts:38-41); `server.instance.disposed` 终止流 (event.ts:44-56); 监听器先注册后建 body 防丢事件 (event.ts:26-28 注释)。
- token delta: `message.part.delta{sessionID, messageID, partID, field, delta}`(v1/session.ts:632-641) — 文本/推理增量按字段追加; part 全量快照走 `message.part.updated`。属于 V1-only 兼容事件面 (schema/AGENTS.md), V2 对应 `session.next.text.delta` / `session.next.reasoning.delta` / `session.next.tool.input.delta`(session-event.ts:211, 249, 293)。
- 完成信号: `session.status` 事件 + 状态转 idle 时额外发 `session.idle`(session/status.ts:41-43); 客户端亦可 `POST /api/session/:id/wait` 阻塞等待 (protocol/groups/session.ts:241)。
- REST 端点 (protocol/src/groups/): session(list/create/get/prompt/compact/wait/revert.stage|clear|commit/context/history/event/message/interrupt/switchAgent/switchModel/active), permission(request.list, saved.list/remove, session.permission.create/list/get/reply), question(list/reply/reject), pty(6+connect), fs(read/list/find), agent/command/model/provider/skill 列表, event(subscribe), health, location/project 等。
- SDK: `packages/sdk/js`(生成式 client, `src/client.ts` + `gen/`, 重生成 `./packages/sdk/js/script/build.ts`); `packages/sdk-next` 为新一代 (组合 Client+Core+Server, opencode/AGENTS.md); 另有 `sdk/js/src/process.ts` 负责拉起/发现本地 server 进程。
- 多目录/多实例: 每 directory 一个 instance, 事件按 directory 路由 (`event-v2-bridge.ts` 注入 location), `server.instance.disposed` 通知实例销毁; MDNS 局域网广播 (server/mdns.ts)。

## 12. PTC (Programmatic Tool Calling)

- 存在实验实现: `tool/code-mode.ts` — `CODE_MODE_TOOL = "execute"`, "Run a confined orchestration script with access to connected MCP tools"; 模型提交 `code` 字符串, 在受限解释器 (`@opencode-ai/codemode` sandbox) 内编程式调用 MCP 工具, 结果按 MCP `CallToolResult` schema 校验, toolCalls 进度进 metadata (`CallEntry{tool, status: running|completed|error}`)。
- 开关: `flags.experimentalCodeMode`(tool/registry.ts:122-123, 226); 当前仅覆盖 MCP 工具面, 非 builtin 工具。结论: PTC = partial (experimental, MCP-only)。

## 13. Capability Matrix

| 能力 | OpenCode | 证据 |
|---|---|---|
| Session | ✓ (SQLite 持久, ses_ ID, 多 session 并行) | core/src/session/sql.ts; session/session.ts |
| Resume | ✓ (持久 session 直接续 prompt; fork/unrevert 另有) | protocol/groups/session.ts:109; session.ts:691 |
| Streaming | ✓ (SSE /event + message.part.delta token 级) | handlers/event.ts; v1/session.ts:632 |
| Cancellation | ✓ (interrupt 端点 → runner cancel + 级联 bg job; tool ctx.abort) | run-state.ts:77; protocol:345 |
| Approval | ✓ (permission.asked/replied, once/always/reject+feedback, 会话内 always 规则) | permission/index.ts:67-167 |
| Tool events | ✓ (tool part 状态机 + part.updated; V2 session.next.tool.*) | v1/session.ts:259-322 |
| File changes | ✓ (file.edited/file.watcher.updated + patch/snapshot part + session.diff) | filesystem.ts; v1/session.ts:87-100 |
| Terminal | ✓ (PTY 一等公民: /api/pty + pty.* 事件 + connect token) | protocol/groups/pty.ts |
| Background task | partial (BackgroundJob + 后台 subagent 需 experimental flag; 无原生 background bash 参数) | task.ts:97; run-state.ts:111 |
| Parallel tools | ✓ (ai-sdk 并发 tool call, callID 结算; 并行 task) | processor.ts:123-203 |
| Compaction | ✓ (auto overflow 触发 + 手动 compact 端点 + prune; client 可见) | overflow.ts; compaction.ts |
| Subagent | ✓ (task 工具, 真实子 session, parentID 关联, depth 限制) | tool/task.ts |
| Usage | ✓ (Assistant.tokens/cost 逐 step-finish 累计; SessionInfo.tokens) | v1/session.ts:240-257, 471-481 |
| Reasoning events | ✓ (reasoning part + message.part.delta; V2 reasoning.delta) | v1/session.ts:118; session-event.ts:249 |
| PTC | partial (experimental code-mode `execute`, 仅 MCP 工具) | tool/code-mode.ts |

## 14. 「Shell 必须看到 vs Runtime 内部」

- Shell(客户端)必须看到: 全部 Part 类型与 tool 状态机 — 状态迁移由 runtime 推 part 快照 (`message.part.updated`), shell 无需理解 LLM 协议。
- 必须看到: token 级增量走 `message.part.delta{field, delta}` — shell 自行拼接; part 更新是幂等快照, delta 只是优化。
- 必须看到: `session.idle` 是 turn 结束的权威信号 (status.ts:41-43); `session.status` 是 busy/retry/compact 的过程信号。
- 必须看到: 权限等待 = 收到 `permission.asked` 后必须回复 (`once/always/reject`), 否则 runtime 的 Deferred 永久挂起; reject 可带 feedback 文本直接回传模型。
- 必须看到: tool 的中间输出在 `ToolStateRunning.metadata`(如 shell `metadata.output`), 最终输出在 `ToolStateCompleted.output/metadata/attachments`; shell 想展示进度必须轮询 part 而非等完成。
- 必须看到: 子 agent 通过 tool part `metadata.sessionId` 关联, 需自行订阅子 session 事件 — runtime 不转发子事件到父流。
- 必须看到: 文件变更有双通道 — 结构化事件 (`file.edited`/`file.watcher.updated` + patch part) 与磁盘观察; patch part 是变更的权威记录。
- Runtime 内部: LLM 适配 (`session/llm.ts` ai-sdk 流)、provider 重试 (`SessionRetry.policy`)、prompt/AGENTS.md 拼装、`MessageV2.toModelMessagesEffect` 上下文翻译 — 全部在 server 侧, shell 不可见也不可配 (除 agent/model 参数)。
- Runtime 内部: SQLite 存储布局 (message/part 的 JSON data 列) 是实现细节, 契约是 schema 包的 wire 类型 — shell 不应直接读库。
- Runtime 内部: compaction 的 tail_turns/PRUNE 阈值与摘要生成完全 server 侧; shell 只收到 `session.compacted` + CompactionPart, 且历史被裁剪后 `MessageV2.filterCompactedEffect` 已过滤 — shell 无需感知。
- Runtime 内部: snapshot 影子 git (snapshot/index.ts) 与 revert 的 stage/commit 两段式是 server 侧文件回滚机制; shell 只消费 revert 事件的 diff 展示。
- Runtime 内部: tool 参数解码失败 (`InvalidArgumentsError`)、truncation(`metadata.truncated`/`outputPath`)、plugin before/after 钩子对 shell 透明 — 呈现为普通 tool error/completed part。
- Runtime 内部: 双 runtime (V1 loop / V2 runner) 与事件桥接是迁移期实现细节; shell 若只依赖 V1 兼容事件 (`message.*`, `permission.asked`) 可对两者透明。
- 边界判断: OpenCode 的 shell 契约 ≈ "REST 命令 + SSE 事件日志 + 少量回写端点 (permission/question/reply/interrupt/pty)" — 无客户端工具回调, 无客户端 token-by-token 推送保证 (delta 事件尽力而为), 无服务端等待 shell 渲染的机制。
