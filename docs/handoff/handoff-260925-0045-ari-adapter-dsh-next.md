# ARI 交接文档 — DSH 适配层已完成

> 面向**下一位接手的 AI Agent**。你无法访问之前的会话，只有这份文档和它引用的上一份。
> 生成时间：2026-09-25 00:45 · 工作目录：仓库根目录
> **前置阅读**：[handoff-260924-2311-ari-adapters-next.md](handoff-260924-2311-ari-adapters-next.md)——本文件只记录**增量**，所有背景、硬约束、命名决定、踩坑清单以那份为准。

---

## 0. 三十秒速览

**`packages/adapter-dsh` 已完成**——ARI 的第一个适配层：对壳说 ARI（server 角色），对 DeepSeek Harness 运行时说它的 SDK JSON-RPC 线协议（client 角色）。

- **78 个测试全绿**（原 54 + 适配层 24）
- **conformance 对适配层：18 passed / 0 failed / 6 skipped**，每个 SKIP 都是因为 DSH 的线协议真的没有那条通道（审批/提问/replay）——这正是能力声明如实反映的
- `npm run conformance:dsh` 一键复跑
- **壳、协议库、conformance 一行未改**——这是 ARI 核心主张的第一次实证

## 1. 本次做了什么

```
packages/adapter-dsh/
  src/translate.ts   纯映射层：能力表、TurnEndReason→StopReason、
                     assistant 流展开（text-chunks/reasoning-chunks→delta）、
                     TokenUsage→UsageInfo、tool/result→tool/completed、subagent 状态
  src/dsh.ts         DSH 侧客户端：NDJSON JSON-RPC、pending 关联、kill(SIGTERM→SIGKILL)
  src/adapter.ts     翻译核心（★ 状态都在这里，见下）
  src/drafts.ts      AriEventDraft = 去掉信封的 AriEvent（DistributiveOmit）
  src/main.ts        CLI：--dsh <cmd> [args...]（必须放最后）、--queue-limit、--minimal、
                     --provider/--model/--cwd
  test/fake-dsh.ts   DSH 线协议测试替身（手写 NDJSON，关键词驱动，不用任何 ARI 库）
  test/adapter.test.ts  24 个测试，全部跨真实进程
```

根 `package.json` 新增：`test:adapter-dsh`、`adapter:dsh`、`conformance:dsh`；`test` 已并入适配层。

## 2. 翻译核心的五个设计决定（不要推翻）

1. **seq/turn 由适配器重编号**。DSH 的 seq 含 log-only 事件（0 起），turn 计数在进程重建后归零——两都不可透传。ARI seq 从 1 连续、turn 从 1 单调，由适配器自持。
2. **回执归属用「到达时快照窗口」**。DSH 在 `session/prompt` 处理器里同步 `followup()`，`turn/start` 通知**先于**回执响应到达。适配器把该会话的所有 DSH 通知停到一个 per-session FIFO，回执落地后按到达序处理；`turn/start` 到达时快照 `inFlight.length + pendingReceipts` 作为可声明窗口。顺序提示是精确的；两个 prompt 撞进同一 turn 边界无法从线上区分——这是 DSH 线协议的信息上限，不是缺陷。
3. **通知闸门同时满足 C07（messageIds 归属）与 C14（回执先于事件）**，一箭双雕：停 FIFO 期间什么都不翻译，回执一到，先写 ARI 响应再放行（单条 FIFO 写队列保证顺序）。
4. **cancel = 杀进程 + 全会话结算**。DSH SDK 线上没有 cancel 方法（上游 README 明说「关进程即放弃 turn」）。适配器把 ARI `session/cancel` 映射为：SIGTERM 运行时 → 所有有 open turn 的会话发 `turn/completed{cancelled}` + `session/status idle`，请求方拿到 `droppedMessageIds`。下次 prompt 惰性重启新一代运行时（`dsh_<uuid>` 会话 id 防止与持久化日志冲突），ARI 会话 id 与 turn 计数跨代保持。
5. **能力声明 = 线协议能交付的精确集合**：reasoning/usage/compactionEvents/subagents 为 true（都经 `session.event`/`subagent.*` 通知真实到达），question/approvalEditInput/replay/fileChanges/backgroundTasks/fork/sessionList 为 false。emit 路径还有 EVENT_CAPABILITY 门控兜底，保证 C12 结构性成立。`--minimal` 全关。

## 3. DSH 线协议的硬事实（适配器无法逾越，不要试图在 DSH 侧修）

来源：上游 checkout `packages/sdk/protocol/{README.md,src/types.ts}`、`packages/sdk/server/src/server.ts`、`packages/core/session/src/types.ts`、`packages/llm/llm/src/{types,assistant-stream}.ts`。

- 三个方法：`initialize{cwd,provider,model,…}` / `session/prompt{sessionId,contentBlocks}→{messageId}` / `shutdown`；四个通知：`session.event{sessionId,event}` / `session.status` / `subagent.started` / `subagent.finished`。**没有** cancel、resume、fork、list、审批、提问。
- `session.event` 是**全 runtime 无过滤**广播——适配器只认自己分配的 `dshId`，其余丢弃（有测试）。
- assistant 文本**只在结算时**到达（`assistant/message` 内嵌 `AssistantStreamRecord[]`），线上没有活流 delta——适配器从内嵌 records 合成 delta，这是「改信封不改语义」的样板。
- `session/prompt` 的 `sessionId` 由调用方随意命名，未知 id 惰性创建（不是 resume）。
- `TurnEndReason`：completed/aborted/blocked/error/max-tokens/interrupted/forked → end_turn/cancelled(×2)/refusal/error(带 session/error 先行)/cancelled/end_turn。
- compaction 是插件事件（`compaction/start|summary|end`），经 `session.event` 流出；`end` 无 error 时合成一条 `compaction/performed`（sourceCommandId 或 turn:null → manual）。
- usage 内嵌在 `assistant/message.usage`（TokenUsage：cacheReadTokens→cachedTokens）。

## 4. 本次踩的坑（下次别再踩）

1. **`| tail` 会把「进程不退出」伪装成「无输出」**。测试进程有悬空句柄时 `node --test | tail` 看起来像挂死，其实测试早跑完了。用 `node --test --test-force-exit` + 重定向到文件排查。
2. **node:test 的 timeout 是 `{ timeout: N }` 选项**，不是第三位置参数。
3. **ESM + verbatimModuleSyntax 下，类型必须 `import type`**——`import { Interface }` 会在运行时炸模块加载（Node type stripping 不擦 import）。
4. **typecheck 这次真的跑过了**（P2 债还了一半）：`tsc --noEmit` 全仓零错误。它抓出 2 个**既有** shell 类型 bug（`Rendered.stream` 缺 `tool` 成员导致 tool/updated 增量类型不符；render.ts default 分支 never 收窄）+ 我自己的 3 处。tsconfig 用 strict + noUncheckedIndexedAccess，新代码必须过它。复现：`npm i typescript@5.8 @types/node@22 --prefix /tmp/tsc-check --no-save && /tmp/tsc-check/node_modules/.bin/tsc --noEmit --typeRoots /tmp/tsc-check/node_modules/@types`（node_modules 仍未入库，零运行时依赖不变）。
5. **fake-dsh 必须忠实复刻 DSH 的怪序**（通知先于回执），否则闸门逻辑测不到。替身越「乖」，适配层的真实缺陷越测不出。

## 5. 下一步

**P0：Codex app-server 适配层（`adapter-codex`）**——上一份交接文档已论证：三级坐标信封 `thread_id/turn_id/item_id` 差异最大，最能压测规范。做完第二个再决定是否铺开。方法学同本次：先读 `research/07-codex-app-server.md` + `codex/codex-rs` 上游源码 → 写线协议替身 → 适配器 → conformance 判定。SPEC 附录 B 是工作清单。

**P1：真实 DSH 冒烟**——适配层目前只被 fake-dsh 判定过；在有 API key 的环境跑一次 `npm run shell -- -- node packages/adapter-dsh/src/main.ts --dsh dsh --profile sdk`，把结果记录进 README。注意 DSH 的 provider/model 路由经 `--provider/--model` 传入（默认 `deepseek-official`，与上游 server 的缺省一致）。

**P2（遗留未变）**：GitHub description/topics 仍待网页填写；LICENSE 著作权人仍是 `cholf5`；npm scope 未定（所有包仍 `private: true`）。

## 6. 基线自检（动手前先跑）

```bash
cd <仓库根目录>
npm test                    # 期望 78/78 绿
npm run conformance         # 对 mock harness：23 passed / 0 failed / 1 skipped
npm run conformance:dsh     # 对 DSH 适配层：18 passed / 0 failed / 6 skipped
git log --oneline -3        # HEAD 应包含 DSH adapter 提交
```

## 7. 不要做的事（继承 + 新增）

全部继承上一份交接文档 §7（命名、语言、零依赖、erasable syntax、`.ts` 扩展名、git 历史、第三方克隆、SSH 别名）。新增两条：

- **不要给适配层用 `AriHarness`**——上一份已经说过，这里再强调一次：适配层是翻译器，`AriHarness` 是 harness 作者的服务端 helper，角色相反。
- **不要试图在适配层里「补齐」DSH 没有的语义**（审批、replay、活流 delta）。缺就是缺，如实声明 `false` 并让 conformance SKIP——谎报能力才是违规。
