# ARI 交接文档

> 面向**下一位接手的 AI Agent**。你无法访问之前的会话，只有这份文档。
> 生成时间：2026-09-24 23:11 · 工作目录：仓库根目录

---

## 0. 三十秒速览

**ARI (Agent Runtime Interface)** 是一套让「一个壳（Shell）驱动任意 Coding Agent Harness」的运行时协议。仓库同时是规范 + 参考实现 + conformance 套件，已开源在 **https://github.com/agent-runtime-interface/ari**（public）。

**当前进度**：规范（ARI 1.0）完成 · 协议库完成 · mock harness 完成 · conformance 套件完成（24 条检查）· 41 个测试全绿。
**下一步**：`packages/shell`（参考壳），然后是 6 个适配层。

技术栈：**TypeScript，零依赖**，Node ≥ 22.6 原生 type stripping，直接 `node xxx.ts` 跑，不需要 `npm install`、不需要构建。

---

## 1. 当前任务目标

### 要解决的问题

今天一个 Shell（IDE 插件、TUI、Web UI、自动化脚本）想驱动不同的 agent runtime，必须为每一家写一套适配器：DSH 有 SDK JSON-RPC、Codex 有 app-server、ZCode 有 Protocol V4、OpenCode 是 HTTP+SSE、Pi 是 RPC——方法名、事件名、完成语义、审批形状全不一样。

ARI 的主张：**这些 runtime 内部共享同一套运行时抽象**，值得标准化一次。

### 预期产出

| 产出 | 状态 |
|---|---|
| 规范性规范 `SPEC.md` | ✅ 完成（ARI 1.0，英文） |
| 参考协议库 `packages/ari` | ✅ 完成 |
| 参考 harness `packages/mock-harness` | ✅ 完成 |
| conformance 套件 `packages/conformance` | ✅ 完成 |
| **参考壳 `packages/shell`** | ❌ **未开始** |
| **6 个适配层**（DSH/Codex/ZCode/OpenCode/Pi/ACP） | ❌ **未开始** |
| 第三方独立实现的 harness 通过 conformance | ❌ 未发生 |

### 完成标准

- 一个壳能通过 ARI 驱动多个真实 harness，且**代码里不出现任何 harness 专有分支**
- 每个适配层通过 `packages/conformance`（附录 A 的 22 条 harness 侧检查）
- 理想终局：**某个不是我们写的 harness 通过 conformance**——这是"规范可被第三方独立实现"的唯一硬证据

---

## 2. 当前进展

### 提交历史（9 个，全部已推送，`main` 与 `origin/main` 同步）

```
53c4c8c  Add the conformance suite, and prove it detects violations
b3942a9  Add the mock harness, and fix three defects it exposed
54995cc  Add the Harness-side helper: settlement invariants as structure, not convention
c88a8b6  Add repository metadata to package.json
5de3ebe  Make the normative spec, README, and code comments English
128037a  Monorepo scaffolding + the ARI wire layer (types / jsonrpc / framing / errors)
f8c90ed  ARI 1.0: add the normative SPEC.md; drop the v0.1/v0.2 version theatre
f050ab3  Make ARI the project name (not an initialism); remove local absolute paths
75fe305  ARI: cross-harness runtime protocol research and proposal
```

### 文档

| 文件 | 语言 | 说明 |
|---|---|---|
| `SPEC.md` | **英文** | **规范性**。ARI 1.0。§0–§13 + 附录 A/B/C |
| `README.md` | 英文 | 仓库门面 |
| `README.zh-CN.md` | 中文 | 与英文版内容同步 |
| `ARI-RESEARCH-REPORT.md` | 中文 | 调研报告（Part A 调查 / B 共同抽象 / C 取舍 / D 推导 / E 示例） |
| `research/01-dsh.md` … `08-related.md` + `capability-matrix.md` | 中文 | 9 份源码级证据，带 `path` + `symbol` 引用 |

> **重要**：报告与 `research/` **故意保持中文**，这是深思后的决定（见 §3）。SPEC 是英文且为唯一规范来源；两者冲突以 SPEC 为准。

### 代码（`packages/`）

```
packages/ari/src/types.ts        379 行  协议类型、11 个能力键、21 种事件联合、方法表
packages/ari/src/errors.ts        88 行  错误码 -32001…-32008 + JSON-RPC 标准码
packages/ari/src/jsonrpc.ts      108 行  JSON-RPC 2.0 判定、event 通知识别
packages/ari/src/framing.ts      155 行  NDJSON 分帧、1 MiB 上限、背压写入器、readFramesSafe
packages/ari/src/client.ts       528 行  Shell 侧客户端
packages/ari/src/harness.ts     1172 行  Harness 侧助手（不变量强制）★核心
packages/ari/src/index.ts         19 行  入口，27 个导出

packages/ari/test/invariants.test.ts      709 行  29 个不变量测试
packages/mock-harness/src/main.ts         339 行  关键词驱动的确定性 harness
packages/conformance/src/checks.ts        742 行  24 条检查
packages/conformance/src/main.ts          335 行  CLI
packages/conformance/test/broken-harness.ts 151 行  故意违规的 harness
packages/conformance/test/teeth.test.ts     129 行  12 个"套件抓得住违规"的测试
```

### 测试现状

```
$ npm test
ℹ tests 41   ℹ pass 41   ℹ fail 0
```

- `packages/ari/test/invariants.test.ts` — 29 个（真 harness 经真客户端驱动）
- `packages/conformance/test/teeth.test.ts` — 12 个（含 9 种故意违规的检出证明）

### 命令

```bash
npm test                      # 41 个测试
npm run test:invariants       # 只跑不变量测试
npm run test:conformance      # 只跑"牙齿"测试
npm run mock                  # 起 mock harness（在 stdin/stdout 上说 ARI 1.0）
npm run conformance -- -- node packages/mock-harness/src/main.ts   # 跑 conformance
npm run typecheck             # ⚠️ 从未成功跑过，见 §5
```

---

## 3. 关键上下文

### 用户的明确要求（按时间顺序，均为原话意图）

1. **开源**：仓库要公开。已完成（public）。
2. **不要版本戏**：（用户要求：直接定为 1.0，不要版本戏）→ 已全面改为 **ARI 1.0**，不再有 v0.1/v0.2 措辞。
3. **国际化**：（用户要求：国际化——规范、README、代码注释与提交信息一律英文）→ **规范/README/代码注释/提交信息一律英文**；**调研报告与 research/ 保持中文**（用户接受了这个折中：规范 590 行 vs 报告 2500 行，收益/成本比决定）。
4. **组织与命名**：最终选定组织 **`agent-runtime-interface`**，仓库名 **`ari`**。曾长期纠结 `agentruntimeinterface`（无连字符，MCP 风格）vs `agent-runtime-interface`（可读性好），**用户最终选了带连字符的**。**不要再重新讨论命名**。
5. **下一步**：（用户确认：接下来要做壳与各 SDK 适配层）——已明确技术栈选 **TypeScript**，顺序选**先做壳 + conformance**（conformance 已完成）。
6. **历史改英文**：已完成（`git filter-branch` 重写 4 条中文提交信息，树对象逐一校验未变，旧对象已 `gc --prune=now` 回收）。

### 硬约束（违反会破坏已建立的性质）

| 约束 | 原因 |
|---|---|
| **零依赖** | 参考实现能 `node xxx.ts` 直接跑是特性。不要引入任何 runtime 依赖 |
| **只用可擦除语法** | Node 原生 type stripping 不支持 `enum`、`namespace`、构造器参数属性。用 `const` 对象 + 联合类型代替 enum。`tsconfig.json` 开了 `erasableSyntaxOnly: true` |
| **import 必须带 `.ts` 扩展名** | `import { x } from "./y.ts"`。已开 `allowImportingTsExtensions` |
| **代码注释、提交信息一律英文** | 用户明确要求国际化 |
| **不要重写 git 历史** | 仓库已公开推送。要改就得 force-push 公开历史 |
| **不要翻译 `research/` 与 `ARI-RESEARCH-REPORT.md`** | 有意保留中文 |

### 已做出的关键设计决定（不要重新推翻）

1. **ARI = Agent Runtime Interface**（缩写成立，避开了 ARP→Address Resolution Protocol 的致命碰撞）。
2. **不使用 server→client 请求**。ARI 只有两种消息：client→server 请求、server→client 通知。人机交互走「事件 + respond 方法」，壳不需要请求路由器。这是对 ACP 的实质偏离。
3. **prompt 回执 ≠ turn 结局**。`session/prompt` 的 `messageId` 严格只承诺「**已持久入队**」。turn 结算由 `turn/completed` 承载。
4. **`session/error` 永不替代 `turn/completed`**。前者是带外诊断，后者是唯一收尾。
5. **能力位不得悬空**。`initialize` 里声明为 `true` 的每个能力，都必须在 1.0 内有定义的方法/事件。这是当初把 subagent/background/fork/sessionList 从「v0.2」提升进 1.0 的原因。
6. **未协议化的能力走扩展机制**（§12）：`x-` 前缀方法/事件 + `_meta`，**不占版本号**。包括 steer、PTY 透传、PTC、execpolicy 修正、编排/控制 API。
7. **ARI 是接口规范，协议绑定规定传输**（SPEC §1.1）。Binding A（JSON-RPC 2.0 / NDJSON）为规范性，Binding B（HTTP+SSE）为信息性。

### 关键数字（改代码前先确认）

- **10 个请求方法**：`initialize`、`session/new`、`session/resume`、`session/prompt`、`session/cancel`、`session/fork`、`session/list`、`shutdown`、`approval/respond`、`question/respond`（+ `initialized` 通知 + `event` 通道）
- **21 种事件** = 10 必需 + 11 能力门控
- **11 个能力键**：`reasoning`、`question`、`approvalEditInput`、`usage`、`compactionEvents`、`replay`、`fileChanges`、`subagents`、`backgroundTasks`、`fork`、`sessionList`
- **13 个错误码**：`-32700`…`-32603`（JSON-RPC 标准）+ `-32001`…`-32008`（ARI 自有）
- `seq` 与 `turn` 均**从 1 起**；单帧上限 **1 MiB = 1,048,576 字节**
- conformance：附录 A **22 条 harness 侧 + 3 条 shell 侧**

### 环境事实

- Node **v25.4.0**、pnpm 12.4.2、npm 11.7.0
- **remote 用的是本地 SSH 别名**（配置细节按仓库内容规范省略）。他人克隆请使用 `https://github.com/agent-runtime-interface/ari.git`，文档中引用仓库地址一律写该 HTTPS URL
- 工作目录里有**未跟踪的第三方克隆**：`codex/`、`opencode/`、`ZCode/`、符号链接 `deepseek-harness`。**全部在 `.gitignore` 里**，是调研用的上游源码，不要提交、不要删

---

## 4. 关键发现

### 4.1 `harness.ts` 的价值在于"让违规做不到"

`AriHarness` 把 SPEC §8 的不变量做成了**结构性保证**，而不是文档里的自觉：

| 不变量 | 机制 |
|---|---|
| seq 无空洞 | **seq 由 helper 自己分配**，harness 作者没有写 seq 的机会 |
| 能力为 false 就发不出事件 | 门控在 `#emit` 内部查 `EVENT_CAPABILITY`，命中即抛 `AriInvariantError` |
| 每个 `turn/started` 恰好一条 `turn/completed` | 只有**一个** open-turn 槽位，`#settleTurn` 是唯一出口，重复结算直接抛 |
| 每个 `*/requested` 恰好一条 `*/resolved` | 结算时自动清算该 turn 的挂起交互（`cancelled`/`expired`） |
| 工具不悬空 | 结算前自动补发 `tool/completed{status:"error"}`，**在** `turn/completed` 之前 |
| 结算后不再有事件 | `ctx` 在 turn 结算后即"死亡"，任何 emit 抛错 |

**这对适配层至关重要**：写适配层时不需要重新推导这些不变量，helper 已经强制了。

### 4.2 三个真 bug（都是"跨进程"才暴露的）

**进程内单元测试全部漏掉了它们**。第一个和第三个只有把 harness 当**子进程**、用真客户端驱动时才浮出来——因为只有跨进程才真的经过分帧，才有一个独立的状态跟踪者去发现不一致。

1. **规范级缺陷：信封字段被 payload 覆盖。** `subagent/started` 的 payload 里有个 `sessionId`（指**子**会话），而每个事件信封已有 `sessionId`（指事件所属会话）。构建事件时 `{sessionId: 本会话, seq, ...payload}` 让 payload 静默改写信封 → 客户端去查一个不存在的会话，既不推进 `nextSeq` 也不记缺口 → 表现为莫名其妙的 seq 空洞。
   - **修法**：字段改名 `childSessionId`（**ZCode 内部本来就叫这个名字**，反向印证），并在 SPEC §9.1 加规范性规则：`sessionId`/`seq`/`type` 为保留字段，payload 不得包含同名，Harness 必须拒绝此类事件。
   - `#emit` 现在**信封字段展开在最后**（永远胜出），且显式拒绝 payload 里的 `sessionId`/`seq`。

2. **被拒的帧消耗了 seq。** 1 MiB 尺寸检查跑在 `seq += 1` 和写日志**之后**，超大事件会在流里留下永久空洞。现在检查前移到任何状态变更之前，被拒的帧完全无副作用。**这是客户端自己的 gap 检测抓出来的**。

3. **工具状态在 emit 之前就被改了。** 帧被拒时客户端永远等不到 `tool/completed`，一个工具"开着"再也不会关。现在 `toolStarted`/`toolUpdated`/`toolCompleted` 一律**先 emit、后改状态**；配合结算时自动补关，保证"announce 过的工具一定会被 close"。

**教训（写适配层时会再遇到）**：任何"先改状态、后发事件"的写法都是 bug 温床。**先发事件、成功后再改状态**。

### 4.3 conformance 的设计难点与解法

**难点**：套件怎么把一个它从没见过的 harness 驱动到"请求审批""报错""慢到可以取消"这些路径？第三方 harness 不会认识 `approve` 这种关键词。

**解法**：两类检查。

| 类型 | 需要配合 | 覆盖 |
|---|---|---|
| **观测型** | 否 | seq 密度、每 turn 一次结算、能力门控、错误码、帧上限、stdout 纯净性、回执先于事件 |
| **探针型** | 是（`--probe-*`） | 审批往返、提问往返、取消、队列溢出 |

**没提供探针的检查报 SKIP 并附上该加哪个参数**——不静默通过，也不因为"套件触发不了"而误判失败。

### 4.4 一个永远通过的 conformance 套件毫无价值

所以有 `packages/conformance/test/broken-harness.ts`：它**刻意不使用 `AriHarness`**，手写 NDJSON，因为它要故意违规。9 种违规逐个验证套件抓得住：

| 违规 | 被抓的检查 |
|---|---|
| seq 跳号 | C06 |
| `turn/started` 缺 `messageIds` | C07 |
| 一个 turn 结算两次 | C08 |
| 声明 `reasoning:false` 却发 `reasoning/delta` | C12 |
| 事件先于 prompt 回执 | C14 |
| 永不进入 idle | C22 |
| stdout 打日志 | C21 |
| 单帧 > 1 MiB | C21 |
| `turn/completed{error}` 前无 `session/error` | C09 |

### 4.5 命名讨论的结论（不要重开）

- 曾考虑并**否决**：`ARP`（撞 Address Resolution Protocol，网络领域辨识度压倒性）、`AHP`（撞 Analytic Hierarchy Process，且语义倒置——把被抽象掉的实现层拿来命名抽象层）、`HIP`（双重碰撞：IETF 的 Host Identity Protocol + AMD 的 HIP）
- 判断标准：搜「`<缩写>` protocol」谁赢。`ARP`/`HIP`/`AHP` 都有支配性结果，`ARI` 没有——这也是 `ari-protocol` 在 npm/GitHub 都空着的原因
- `github.com/ari` 返回 200 的是**一个用户名**，不是仓库名，**不阻碍** `agent-runtime-interface/ari`

### 4.6 "200 行可合规"这个说法需要重新表述

报告 D8 说「~200 行可合规」，而 mock harness 实际 339 行。差额几乎全在**场景分派**（20+ 条测试路径）；协议机制本身是 `harness.serve(process.stdin, process.stdout)` 加一个 delegate。README 里已改成更准确的说法：**协议义务由 helper 承担，harness 作者只需要写业务循环**。

---

## 5. 未完成事项（按优先级）

### P0 — `packages/shell`（参考壳）

`package.json` 里**已经有 `npm run shell` 脚本指向 `packages/shell/src/main.ts`，但该文件不存在**——这是个悬空脚本。

壳的职责：消费 ARI，**代码里不出现任何 harness 专有分支**。它是"ARI 到底能不能让壳无感"这个核心主张的验证物。

建议最小形态：CLI，接收 `-- <harness command>`，渲染事件流（文本输出即可），能响应审批/提问（stdin 输入或自动策略），能取消。

### P1 — 6 个适配层

`adapter-dsh` / `adapter-codex` / `adapter-zcode` / `adapter-opencode` / `adapter-pi` / `adapter-acp`。

**适配原则：改信封、不改语义。** Harness 内部的 compaction 算法、PTC、工具管线、存储格式**不因适配 ARI 而改变**。

参考 `SPEC.md` **附录 B**（ARI ↔ 各实现的逐行映射表）——那就是工作清单。

**建议先做 1–2 个**，不要一次铺开：
- **DSH** 语义最全（报告 Part A 的 A1），映射近乎一一对应
- **Codex app-server** 信封差异最大（三级坐标信封 `thread_id/turn_id/item_id`），最能压测规范

写适配层时**不要用 `AriHarness`**——那是给 harness 作者（服务端）用的；适配层是**翻译层**，把已有 harness 的私有协议翻译成 ARI，通常需要直接用 `AriClient` 的角色反向实现（即适配层扮演 server 对壳、扮演 client 对真 harness）。

### P2 — 附录 A 的 Shell 侧三条（23–25）

`23. 忽略未知事件 type/字段/能力键`、`24. 不发送不在 options 中的 decision`、`25. 断线后以 resume 重建状态并从 snapshot 恢复挂起交互`。

**当前无法被 conformance CLI 覆盖**（那是面向 harness 的工具）。`packages/ari/test` 对参考客户端有部分覆盖。等 `packages/shell` 存在后，可以考虑给 conformance 加一个 `--as-shell` 模式，或单列一个 shell 侧测试。

### P3 — 工程债

- **`npm run typecheck` 从未成功执行过**。`typescript` 与 `@types/node` 在 `devDependencies` 里，但**从未 `pnpm install`**（项目刻意零依赖运行，所以不需要装）。**类型从未被 tsc 检查过**——只被 Node 的 type stripping 检查过（它只擦除、不检查）。这是真实缺口。建议：跑一次 `pnpm install && pnpm typecheck` 并修掉发现的问题（或明确记录为已知状态）。
- **GitHub 仓库 description 与 topics 仍为空**，API 改不了，要在网页上填。建议文案见本文件 §7 末尾。
- **`LICENSE` 著作权人是 `cholf5`**（取自 git config）。挂在组织下，用户可能想改成真名或组织名。这是普通文件改动，不受"历史已冻结"影响。
- **npm scope 未定**。`packages/ari/package.json` 里是 `"name": "@ari/protocol"`，与组织名不一致。**目前所有包都是 `"private": true`，发不出去，所以不急**。真要发包时 scope 会是 `@agent-runtime-interface/...`（29 字符，import 手感差）。

### P4 — 外部验证（最高价值但不可控）

**找一个不是我们写的 harness 跑 `packages/conformance`。** 这是"规范可被第三方独立实现"的唯一硬证据。在此之前，D8 的论证只算验证了一半——README 里已如实这么写。

---

## 6. 建议接手路径

### 先读什么（按顺序）

1. **`SPEC.md`** — 规范性文本。至少读 §0（规范性语言）、§3（架构：为什么不用 server→client 请求）、§6（方法总览）、§8（结算不变量 I1–I7）、§9（事件流）、附录 A（一致性清单）。**这是唯一规范来源。**
2. **`README.md`** — 仓库门面、目录结构、命令、conformance 用法。
3. **`packages/ari/src/harness.ts`** — 核心。重点看 `#emit`（不变量强制点）、`#settleTurn`（唯一结算出口）、`TurnContext`（给 harness 作者的 API）。
4. **`packages/ari/src/types.ts`** — 协议类型、`EVENT_CAPABILITY`（事件→能力映射）、`METHOD_CAPABILITY`（方法→能力映射）。
5. **`packages/mock-harness/src/main.ts`** — 看一个合规 harness 长什么样（关键词驱动的 20+ 场景）。
6. **`packages/conformance/src/checks.ts`** — 24 条检查的实现，也是"ARI 到底要求了什么"的可执行版本。
7. 需要时再查 `ARI-RESEARCH-REPORT.md` 与 `research/`（中文，是**论证与证据**，不是实现依据）。

### 先验证什么（动手前先跑一遍，建立基线）

```bash
cd <仓库根目录>

# 1. 41 个测试应全绿
npm test

# 2. conformance 对 mock harness 应 23 passed / 0 failed / 1 skipped
node packages/conformance/src/main.ts \
  --probe-approval approve --probe-question question \
  --probe-slow "slow 8000" --probe-error throw --queue-limit 3 \
  -- node packages/mock-harness/src/main.ts --queue-limit=3

# 3. 那个 1 skipped 是 C13（mock 声明全部能力为 true），对 --minimal 应通过
node packages/conformance/src/main.ts --only C13 -- node packages/mock-harness/src/main.ts --minimal

# 4. 套件确实有牙齿：故意违规的 harness 必须被抓
node packages/conformance/src/main.ts --only C06 -- node packages/conformance/test/broken-harness.ts --violate=gap
#    期望：exit code 1，C06 FAIL
```

### 推荐的下一步动作

**做 `packages/shell`。** 理由：

1. 它验证 ARI 的**核心主张**——壳能否真的对背后是哪个 harness 无感
2. 它让 conformance 附录 A 的 Shell 侧三条（23–25）终于有被测对象
3. 它比适配层便宜：先用 `mock-harness` 当靶子就能跑通，不必先啃 6 家私有协议
4. 适配层写完也需要一个壳来演示，先做壳可以避免"适配层写完却无处可看"

建议形态：CLI（`-- <harness command>`），事件流文本渲染，审批/提问用 stdin 或 `--auto-allow` 策略，支持 Ctrl-C 取消。**保持零依赖、可擦除语法、英文注释。**

---

## 7. 风险与注意事项

### 容易误判 / 重复劳动的点

| 陷阱 | 说明 |
|---|---|
| **不要重开命名讨论** | 用户在此耗费大量精力后已定：组织 `agent-runtime-interface`、仓库 `ari`、展开 `Agent Runtime Interface`。不要再提议 ARP / 新名字 |
| **不要"顺手"把 research/ 翻成英文** | 有意保留中文，是成本/收益权衡后的决定 |
| **不要引入依赖** | 零依赖是特性。`npm install` 只在想跑 typecheck 时需要 |
| **不要用 `enum`** | Node type stripping 不支持，`erasableSyntaxOnly: true` 会报错。用 `const` 对象 + `as const` + 联合类型 |
| **不要忘记 `.ts` 扩展名** | `import { x } from "./y.ts"`，不是 `"./y"` |
| **不要重写 git 历史** | 已公开推送 |
| **不要把第三方克隆提交进去** | `codex/`、`opencode/`、`ZCode/`、`deepseek-harness` 已在 `.gitignore`，是调研现场 |
| **不要把 `remote` 的 SSH 别名当成笔误去"修"** | 那是本机 SSH 配置（细节按仓库内容规范省略）；文档引用一律使用 HTTPS URL |

### 已验证过、不建议继续的方向

- **给 ARI 加 server→client 请求**（学 ACP 的 `session/request_permission`）。已明确否决：会让壳必须实现请求路由器，破坏事件流的单一有序通道。理由写在 SPEC §3 与附录 C。
- **采纳 client tools 反转**（客户端当工具提供方）。ACP v2 已删除该面，ARI 明确不做。
- **把 PTC / PTY / 子 agent 编排 / 后台任务控制放进核心协议**。已判定为 runtime detail 或产品面，走 `x-` 扩展。
- **把工具体标准化**。MCP 已解决，ARI 只定义工具**调用**的事件形状。

### 写代码时最容易踩的坑（来自实际 bug）

1. **先 emit、后改状态。** 反过来做，一旦帧被拒（超大/编码失败）客户端状态就会永久不一致。这是本会话抓到的 bug #3。
2. **信封字段不可被 payload 覆盖。** 新增任何带 `sessionId` 语义的 payload 字段时，**必须另起名字**（如 `childSessionId`）。bug #1。
3. **任何可能抛错的检查都要放在状态变更之前。** bug #2。
4. **跨进程测试才能发现分帧/状态一致性问题。** 进程内单元测试会漏掉一整类 bug。**每加一条新路径，都要在子进程形态下跑一遍。**
5. **新增能力位时必须同时定义它门控的方法/事件**，否则能力位悬空——SPEC §5.3 的规则，`harness.ts` 的 `EVENT_CAPABILITY` / `METHOD_CAPABILITY` 是唯一真源。

### 改规范时的纪律

- SPEC 是**规范性**文本，用 RFC 2119 关键词（MUST / MUST NOT / SHOULD / SHOULD NOT / MAY）。改它时保持关键词一致：**不要用 "is prohibited" 之类的同义表述**（这会让实现者 grep `MUST NOT` 时漏掉条款——本会话真修过 4 处）。
- 改完 SPEC 要同步三处：`SPEC.md`（英文，规范）、`README.md` + `README.zh-CN.md`（门面）、`ARI-RESEARCH-REPORT.md` 的 Part D 与事件表（中文，推导记录）。
- 改协议面要同步 `packages/ari/src/types.ts` 与 conformance 的 `checks.ts`。

### GitHub 仓库元数据（待用户在网页填写）

**Description**
```
ARI (Agent Runtime Interface): one shell, any coding-agent harness. An interface specification derived from source-level study of DSH, Codex, ZCode, OpenCode, Pi, and ACP.
```

**Topics**
```
agent-protocol, agent-runtime, coding-agent, ai-agents, specification, json-rpc, ndjson, interoperability, harness, llm
```

---

## 下一位 Agent 的第一步建议

```bash
cd <仓库根目录>
npm test                    # 确认 41/41 绿，建立基线
git log --oneline -3        # 确认 HEAD = 53c4c8c
```

然后**读 `SPEC.md` 的 §3 / §6 / §8 / §9 与附录 A**，再读 `packages/ari/src/harness.ts` 的 `#emit` 与 `#settleTurn`。

**接着直接开始写 `packages/shell/src/main.ts`**——先用 `packages/mock-harness` 当靶子跑通（`node packages/shell/src/main.ts -- node packages/mock-harness/src/main.ts`），确保壳里**没有一行代码知道背后是 mock 还是 DSH**。这个"无感"就是 ARI 存在的全部理由，也是你这一轮最该守住的东西。

不要先做适配层。壳能跑通 mock 之后，适配层只是翻译信封的体力活。
