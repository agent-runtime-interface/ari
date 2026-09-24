[English](README.md) · **中文**

# ARI

> ARI = **Agent Runtime Interface**，一套面向 Coding Agent Harness 的运行时契约。
> 状态：**ARI 1.0** · 许可：Apache-2.0

一个 Shell（IDE 插件、TUI、Web UI、自动化脚本）想要驱动不同的 Coding Agent runtime，今天必须为每一家写一套适配器：DSH 有 SDK JSON-RPC，Codex 有 app-server，ZCode 有 Protocol V4，OpenCode 是 HTTP+SSE，Pi 是 RPC——方法名、事件名、完成语义、审批形状各不相同。

ARI 的出发点是：**这些 runtime 内部其实共享同一套运行时抽象**，值得被标准化一次。

## 这是什么

把「会话 / 事件 / turn / 工具调用生命周期 / 人机交互 / 取消 / 用量 / 压缩事件」这些**所有实现都有的运行时概念**标准化，使一个 Shell 能以同一套代码驱动多个 runtime。

**ARI 1.0 = 10 个请求方法 + 21 种事件 + 1 个握手**，规范性定义见 **[SPEC.md](SPEC.md)**。

- 传输：JSON-RPC 2.0 over stdio，newline-delimited（规范性 binding A）；HTTP + SSE 为信息性 binding B，核心数据模型不变。
- 两个关键区分：**prompt 回执 ≠ turn 结局**（回执只承诺"已持久入队"）；**`session/error` 永不替代 `turn/completed`**（前者是诊断，后者才是收尾）。
- 能力协商：Harness 在 `initialize` 里如实声明 `reasoning` / `question` / `usage` / `compactionEvents` / `replay` / `fileChanges` / `subagents` / `backgroundTasks` / `fork` / `sessionList` 等能力位。**声明为 `false` 的能力，一个事件都不发**——没有悬空的能力位。
- 只使用 client→server 请求与 server→client 通知，**不使用 server→client 请求**：人机交互走「事件 + respond 方法」，Shell 无需请求路由器。

## 这不是什么

- **不是工具协议**——不定义工具体、不定义工具 schema；工具接入交给 MCP（8/8 调查对象都已集成）。
- **不是模型 API**——不规定 provider、路由、重试策略。
- **不是 UI 规范**——事件是语义不是渲染，`meta` 对 UI 不透明。
- **不规定 Harness 内部**——compaction 算法、PTC 执行、沙箱、存储格式、迭代上限全部留在 runtime 内。

## 目录

```
SPEC.md                   **ARI 1.0 规范**（规范性）
ARI-RESEARCH-REPORT.md    调研报告（推导与证据）
                          Part A 现有实现调查（8 个对象）
                          Part B 共同运行时抽象（B1–B13）
                          Part C 差异与取舍（必标 / 应标 / capability / 不碰）
                          Part D ARI 1.0 提案的推导（D1–D9）
                          Part E 示例（4 个）
research/                 证据基础：8 份源码级分报告 + 能力矩阵
  01-dsh.md               02-zcode.md            03-codex-cli.md
  04-opencode.md          05-pi.md               06-acp.md
  07-codex-app-server.md  08-related.md          capability-matrix.md
packages/ari/             参考协议库（TypeScript；Node >= 22.6 原生 type stripping
                          直接运行，无构建步骤、无依赖）
  src/harness.ts          Harness 侧助手：把 §8 不变量变成结构性保证
  test/invariants.test.ts 29 个端到端断言这些不变量的测试
packages/mock-harness/    最小确定性 harness——conformance 的靶子
packages/conformance/     把附录 A 清单做成 CLI，可对任意 harness 运行
  test/broken-harness.ts  一个故意违规的 harness，用来证明套件有牙齿
LICENSE                   Apache-2.0
```

## 怎么跑

```bash
npm test        # 41 个测试：不变量，加上"conformance 确实能抓违规"的证明
npm run mock    # mock harness，在 stdin/stdout 上说 ARI 1.0

# 用附录 A 清单检查任意 harness：
node packages/conformance/src/main.ts -- node path/to/my-harness.js
```

mock harness 是**关键词驱动**的，所以每条有意义的路径都能靠选择 prompt 文本走到——不需要模型，不需要 fixture：

```
echo hello        tool ls        approve         question
slow 5000         throw          fail            oversized
chunks 3          dangling       usage           file a.txt
subagent          background     compact         reasoning hi
```

加 `--minimal` 让它把所有能力都声明为 false（报告 D8 里的最小 agent）。

### Conformance

套件检查两类性质。**观测型**不需要配合——发一条无害 prompt，然后断言回来的东西：seq 密度、每 turn 恰好一次结算、能力门控、错误码、帧上限、stdout 纯净性。**探针型**需要把 harness 驱动到特定路径，所以由 harness 作者声明怎么触发：

```bash
node packages/conformance/src/main.ts \
  --probe-approval approve --probe-question question \
  --probe-slow "slow 5000" --probe-error throw \
  --queue-limit 3 \
  -- node packages/mock-harness/src/main.ts --queue-limit=3
```

没提供探针的检查会报 **SKIP 并说明该加哪个参数**——既不会静默通过，也不会因为"套件没法触发"而误判失败。附录 A 的第 23–25 条属于 Shell 侧，对 harness 面向的工具不在范围内；`packages/ari/test` 已为参考客户端覆盖了它们。

## 怎么读

| 你的目的 | 建议路径 |
|---|---|
| 动手实现一个兼容 Shell 或 Harness | **[SPEC.md](SPEC.md)**：§6 方法总览 → §7 生命周期 → §8 结算不变量 → 附录 A 一致性清单 |
| 快速判断这个协议值不值得用 | README（本页）→ 报告 Part B → SPEC §6 |
| 核对某个结论是否站得住 | 顺着 `[0x]` 编号进 `research/`，每份都有 `path` + `symbol` 级引用 |
| 想知道为什么某个功能"不做" | 报告 Part C4 / D7，以及 SPEC §1.2 非目标、§12 扩展机制 |

## 方法论

本报告以**源码与真实协议实现**为主要依据，每条关键结论都带文件路径 + 符号名级引用；产品文档仅作补充并标注。调查对象：

DSH (DeepSeek Harness) · ZCode · Codex CLI (codex-rs) · OpenCode · Pi (badlogic/pi-mono) · ACP (Agent Client Protocol) · Codex App Server · Claude Code（经 `sdk.d.ts`，CLI 闭源）· Gemini CLI

已知限制（如 ZCode 协议自述"未冻结"、Claude CLI 未做二进制审计等）如实记录在报告末尾。

## 现状与路线

**ARI 1.0 已完成**——[SPEC.md](SPEC.md)：握手与版本协商、会话生命周期（new / resume / prompt / cancel / fork / list / shutdown）、turn 结算不变量、21 种事件、人机交互、完整错误码表（`-32001`…`-32008`）、扩展机制、安全考虑、一致性清单。

**参考实现进行中**——`packages/ari/` 是协议库：协议类型、错误码、NDJSON 分帧（含 1 MiB 上限与写入背压）、Shell 侧客户端，以及一个把结算不变量做成**结构性保证**（而非靠约定）的 Harness 侧助手。`packages/mock-harness/` 是基于该助手写的最小确定性 harness。`packages/conformance/` 把附录 A 清单做成可对**任意 harness 命令**运行的 CLI，其中 `test/broken-harness.ts` 是一个故意违规的 harness，用来证明套件确实抓得住违规而不是一律通过。

**下一步（本仓库内）**——参考 Shell，以及各 Agent SDK 的适配层（DSH / Codex / ZCode / OpenCode / Pi / ACP）。适配原则是**改信封、不改语义**：Harness 内部的 compaction 算法、PTC、工具管线、存储格式不因适配 ARI 而改变。

**明确不做**——工具体标准化（交给 MCP）、client tools 反转（ACP v2 已删除该面）、PTC 事件、compaction 控制、PTY 透传、子 agent 编排 API、后台任务控制 API。这些走 §12 的 `x-` 扩展机制，**不占版本号**。

**尚未对第三方 harness 验证。** mock harness 是报告 D8"最小 harness 也能合规"那个论证的可执行版本，但它仍是我们自己写的代码，而且它是套件至今唯一跑过的 harness。在某个独立实现的 harness 通过 `packages/conformance` 之前，这个论证只算验证了一半。

## 参与贡献

Issue 与 PR 都欢迎。最有价值的贡献是**反例**：如果你知道某个 runtime 的行为与 Part B 的"共同抽象"矛盾，或者 Part D 的某条规范在你的实现里无法落地，请开 issue 并附源码引用。

## 许可

[Apache-2.0](LICENSE)。提交贡献即表示同意按同一许可授权（Apache-2.0 §5）。

---

## English abstract

**ARI (Agent Runtime Interface)** is a minimal, source-evidence-driven runtime specification for coding-agent harnesses.

A shell that wants to drive different agent runtimes today needs a bespoke adapter per runtime. ARI argues that these runtimes already share the same runtime abstractions — session as append-only event ledger, turn/step, tool-call lifecycle, closed-form approvals vs. open questions, explicit cancellation, usage, compaction events — and that these are worth standardizing once.

ARI 1.0 is **10 request methods + 21 events + 1 handshake**, carried as newline-delimited JSON-RPC 2.0 over stdio; the normative text is [SPEC.md](SPEC.md). Two distinctions carry most of the design weight: a `session/prompt` receipt promises only *durable enqueue*, never turn completion; and `session/error` is out-of-band diagnostics that never substitutes for `turn/completed`.

Every capability flag in `initialize` gates a defined surface — no dangling capabilities. ARI uses client→server requests and server→client notifications only, never server→client requests.

Every load-bearing claim in the report is cited at file-path + symbol level against real implementations (DSH, ZCode, Codex CLI, OpenCode, Pi, ACP, Codex App Server, Claude Code, Gemini CLI). A reference shell and per-SDK adapters are next; no reference implementation exists yet.
