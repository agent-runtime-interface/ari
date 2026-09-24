# ARI — Agent Runtime Protocol

> 面向 Coding Agent Harness 的**运行时协议**提案。
> 状态：**v0.1 提案，未冻结** · 许可：Apache-2.0

一个 Shell（IDE 插件、TUI、Web UI、自动化脚本）想要驱动不同的 Coding Agent runtime，今天必须为每一家写一套适配器：DSH 有 SDK JSON-RPC，Codex 有 app-server，ZCode 有 Protocol V4，OpenCode 是 HTTP+SSE，Pi 是 RPC——方法名、事件名、完成语义、审批形状各不相同。

ARI 的出发点是：**这些 runtime 内部其实共享同一套运行时抽象**，值得被标准化一次。

## 这是什么

把「会话 / 事件 / turn / 工具调用生命周期 / 人机交互 / 取消 / 用量 / 压缩事件」这些**所有实现都有的运行时概念**标准化，使一个 Shell 能以同一套代码驱动多个 runtime。

**v0.1 全部核心 = 9 个方法 + 16 种事件 + 1 个握手。**

- 传输：JSON-RPC 2.0 over stdio，newline-delimited（规范性 binding A）；HTTP + SSE 为信息性 binding B，核心数据模型不变。
- 两个关键区分：**prompt 回执 ≠ turn 结局**（回执只承诺"已持久入队"）；**`session/error` 永不替代 `turn/completed`**（前者是诊断，后者才是收尾）。
- 能力协商：runtime 在 `initialize` 里如实声明 `reasoning` / `question` / `usage` / `compactionEvents` / `replay` / `fileChanges` 等能力位，不具备的能力**一个事件都不发**。

## 这不是什么

- **不是工具协议**——不定义工具体、不定义工具 schema；工具接入交给 MCP（8/8 调查对象都已集成）。
- **不是模型 API**——不规定 provider、路由、重试策略。
- **不是 UI 规范**——事件是语义不是渲染，`meta` 对 UI 不透明。
- **不规定 Harness 内部**——compaction 算法、PTC 执行、沙箱、存储格式、迭代上限全部留在 runtime 内。

## 目录

```
ARI-RESEARCH-REPORT.md    主报告
                          Part A 现有实现调查（8 个对象）
                          Part B 共同运行时抽象（B1–B13）
                          Part C 差异与取舍（必标 / 应标 / capability / 不碰）
                          Part D v0.1 提案（D1–D9）
                          Part E 示例（4 个）
research/                 证据基础：8 份源码级分报告 + 能力矩阵
  01-dsh.md               02-zcode.md            03-codex-cli.md
  04-opencode.md          05-pi.md               06-acp.md
  07-codex-app-server.md  08-related.md          capability-matrix.md
LICENSE                   Apache-2.0
```

## 怎么读

| 你的目的 | 建议路径 |
|---|---|
| 快速判断这个提案值不值得看 | Part B → Part D |
| 动手实现一个兼容 runtime | Part D + Part E（Example 1/2/3），验收标准见 D9 |
| 核对某个结论是否站得住 | 顺着 `[0x]` 编号进 `research/`，每份都有 `path` + `symbol` 级引用 |
| 想知道为什么某个功能"不做" | Part C4 与 D7，每条排除都有反向证据 |

## 方法论

本报告以**源码与真实协议实现**为主要依据，每条关键结论都带文件路径 + 符号名级引用；产品文档仅作补充并标注。调查对象：

DSH (DeepSeek Harness) · ZCode · Codex CLI (codex-rs) · OpenCode · Pi (badlogic/pi-mono) · ACP (Agent Client Protocol) · Codex App Server · Claude Code（经 `sdk.d.ts`，CLI 闭源）· Gemini CLI

已知限制（如 ZCode 协议自述"未冻结"、Claude CLI 未做二进制审计等）如实记录在报告末尾。

## 现状与路线

**已完成（v0.1）**——骨架，以及一轮规格加固：并发 prompt 入队语义、turn 结算不变量、完整错误码表（`-32001`…`-32008`）、`resume` 的一致性切面与 pending 交互跨断线时效、ID/seq 类型、1 MiB 帧上限。

**推迟到 v0.2（已在报告中给出位点）**——subagent 编排、后台任务、fork/branch、terminal/PTY 桥、中途转向（steer）、审批参数改写、审批策略修正。

**明确不做**——client tools 反转（ACP v2 已删除该面）、PTC 事件、工具体标准化、compaction 控制。

**尚无参考实现。** 报告 D8 论证了一个 ~200 行、无账本/无 compaction/无 subagent 的 SimpleAgent 也能合规，但这份论证尚未被代码验证。

## 参与贡献

Issue 与 PR 都欢迎。最有价值的贡献是**反例**：如果你知道某个 runtime 的行为与 Part B 的"共同抽象"矛盾，或者 Part D 的某条规范在你的实现里无法落地，请开 issue 并附源码引用。

## 许可

[Apache-2.0](LICENSE)。提交贡献即表示同意按同一许可授权（Apache-2.0 §5）。

---

## English abstract

**ARI (Agent Runtime Protocol)** is a minimal, source-evidence-driven runtime protocol for coding-agent harnesses.

A shell that wants to drive different agent runtimes today needs a bespoke adapter per runtime. ARI argues that these runtimes already share the same runtime abstractions — session as append-only event ledger, turn/step, tool-call lifecycle, closed-form approvals vs. open questions, explicit cancellation, usage, compaction events — and that these are worth standardizing once.

v0.1 core is **9 methods + 16 events + 1 handshake**, carried as newline-delimited JSON-RPC 2.0 over stdio. Two distinctions carry most of the design weight: a `session/prompt` receipt promises only *durable enqueue*, never turn completion; and `session/error` is out-of-band diagnostics that never substitutes for `turn/completed`.

Every load-bearing claim in the report is cited at file-path + symbol level against real implementations (DSH, ZCode, Codex CLI, OpenCode, Pi, ACP, Codex App Server, Claude Code, Gemini CLI). No reference implementation exists yet.
