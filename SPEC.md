# ARI 1.0 Specification

> ARI 是项目名，不是首字母缩写。本文件是 ARI 的**规范性规范**。
> 调研依据与取舍论证见 [ARI-RESEARCH-REPORT.md](ARI-RESEARCH-REPORT.md) 与 [research/](research/)。

---

## 0. 状态与规范性语言

本文使用 RFC 2119 关键词，中文对照如下：

| 关键词 | 含义 |
|---|---|
| **MUST** / 必须 | 绝对要求。违反即不符合 ARI 1.0 |
| **MUST NOT** / 禁止 | 绝对禁止 |
| **SHOULD** / 应当 | 强烈建议。存在正当理由时可偏离，但必须理解其后果 |
| **SHOULD NOT** / 不应当 | 强烈不建议 |
| **MAY** / 可以 | 可选 |

`protocolVersion` 为整数 **1**（MAJOR-only，见 §5）。本文描述 ARI **1.0**。

---

## 1. 范围与非目标

### 1.1 范围

ARI 规定 **Shell 与 Harness 之间的运行时契约**：会话生命周期、事件流、turn 结算、工具调用生命周期、人机交互、取消、用量与压缩通知、错误语义、能力协商。

- **Shell**：驱动 agent 的客户端（IDE 插件、TUI、Web UI、自动化脚本）。
- **Harness**：实现 agent 循环的运行时（DSH、Codex、ZCode、OpenCode、Pi，或自研）。

ARI 的目标是让一个 Shell 不必知道自己连的是哪个 Harness。

### 1.2 非目标

ARI **不**规定，且合规实现**禁止**假设以下内容：

- **工具体与工具 schema**——工具接入由 MCP 等外部机制解决。ARI 只规定工具调用的事件形状。
- **模型与 provider**——不规定模型选择、路由、重试策略、退避算法。
- **UI 与渲染**——事件是语义不是渲染。`meta` 对 Shell 不透明。
- **Harness 内部**——compaction 算法与阈值、PTC/沙箱执行、存储格式与迁移、迭代上限、循环检测、上下文装配。
- **传输以外的安全模型**——见 §13。
- **client tools 反转**（由 Shell 提供 fs/terminal 工具给 Harness）。此设计在 ACP v1→v2 中已被删除（实现不一致），ARI 不采纳。
- **PTY/终端透传**——终端生命周期经工具事件暴露即可。

---

## 2. 术语

| 术语 | 定义 |
|---|---|
| **Session** | 一次持续对话。由不透明 `sessionId` 标识。事件账本按 session 隔离。 |
| **Event** | Harness 产生的、属于某 session 的不可变事实。带单调 `seq`。 |
| **Turn** | 一个工作单元：从 claim 输入到结算。每 session 内 `turn` 从 1 单调递增。 |
| **Step** | 一次模型调用。**ARI 不暴露 step**，它是 Harness 内部概念。 |
| **ToolCall** | 一次工具调用，由不透明 `callId` 标识，状态机见 §9.2。 |
| **Interaction** | 需要 Shell 作答的挂起项：闭式审批（approval）或开放式提问（question）。 |
| **pending-input 队列** | 每 session 的 FIFO 队列，存放已接受但尚未被 turn claim 的 prompt。 |
| **水位（watermark）** | `nextSeq`，即该 session 下一条事件的序号。 |

---

## 3. 架构与定位

```
  Shell A ─┐
  Shell B ─┤   ARI（本规范）
  Shell C ─┘        │
              ┌─────┴─────┐
              │  Harness  │
              ├───────────┤
              │ DSH       │
              │ Codex     │
              │ OpenCode  │
              │ 自研       │
              └───────────┘
```

**通信模型**：ARI 1.0 **只使用两种消息**：

1. **client → server 请求**（有 `id`，有应答）
2. **server → client 通知**（无 `id`，不应答）

ARI 1.0 **不使用 server → client 请求**。人机交互采用「Harness 发事件 → Shell 调用 respond 方法」的单向模式，而非 ACP 的 `session/request_permission` 反向请求。理由：Shell 无需实现请求路由器，事件流保持单一有序通道。

---

## 4. 传输绑定

核心数据模型与传输解耦。Binding A 为**规范性**，Binding B 为**信息性**（数据模型相同，仅传输映射不同）。

### 4.1 Binding A（规范性）：JSON-RPC 2.0 over stdio，newline-delimited

- 消息为 **JSON-RPC 2.0** 对象。
- 分帧：**每行一条完整 JSON**，以单个 `\n`（U+000A）结束。**JSON 内禁止嵌入换行**（即禁止 pretty-print）。
- **stdout 纯净性**：Harness 的 stdout **必须**只包含 ARI 消息。所有日志、调试输出、进度信息**必须**写 stderr。
- 编码为 UTF-8。
- stdin 关闭表示 Shell 侧终止；Harness **应当**据此优雅停机。

### 4.2 帧上限

- 单行**必须** ≤ **1,048,576 字节**（1 MiB，UTF-8，不含结尾换行）。
- 超过上限的载荷**必须**在**事件层**拆分，**禁止**切割 JSON 值。
- 工具大输出**必须**先以 `tool/updated.outputDelta` 分块流式下发（每块 ≤ 1 MiB）；此时 `tool/completed.output` **应当**为空或摘要，完整载荷放 `meta`。

### 4.3 背压

写入侧**必须**施加背压（阻塞写），**禁止**无界缓冲。读取侧**应当**及时消费，避免对端阻塞。

### 4.4 Binding B（信息性）：HTTP + SSE

- 方法 = `POST /ari/<method>`，请求体为 JSON-RPC 请求对象，响应体为 JSON-RPC 响应对象。
- 事件 = `GET /ari/events` 的 SSE 流，`data:` 为 `event` 通知的 JSON。
- 核心数据模型、`seq` 语义、错误码均与 Binding A 一致。
- 帧上限与背压由 HTTP 层承担。

---

## 5. 握手与版本协商

### 5.1 initialize

```jsonc
// client → server
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
  "protocolVersion": 1,
  "clientInfo": { "name": "mini-shell", "version": "0.0.1" },
  "clientCapabilities": { "replay": true }
}}
```

```jsonc
// server → client
{ "jsonrpc": "2.0", "id": 1, "result": {
  "protocolVersion": 1,
  "agentInfo": { "name": "SimpleAgent", "version": "0.1.0" },
  "agentCapabilities": {
    "reasoning": true,
    "question": false,
    "approvalEditInput": false,
    "usage": true,
    "compactionEvents": true,
    "replay": true,
    "fileChanges": false,
    "subagents": false,
    "backgroundTasks": false,
    "fork": false,
    "sessionList": false
  }
}}
```

### 5.2 规则

- `protocolVersion` 为 **MAJOR-only 整数**。
- Harness 支持所请求 MAJOR ⇒ **必须**正常应答（回自身 MAJOR）。
- 不支持 ⇒ **必须**返回 `-32008`，`data.supportedVersions` 列出可用 MAJOR。**连接保持可用**，Shell **可以**用受支持 MAJOR **重试一次** `initialize`。
- `initialize` 成功应答之前，除 `initialize` 外的一切方法 ⇒ `-32002`。
- 已 initialize 的连接再次 `initialize` ⇒ `-32006`（不重协商；重协商**必须**重连）。
- Shell **应当**随后发送 `initialized` 通知。该通知**不参与门控**：Harness 在 `initialize` 成功应答后即**必须**接受其余方法，`initialized` 缺失**不得**报错。

### 5.3 能力语义

`agentCapabilities` 中每个为 `false` 的能力，对应的方法/事件/参数**禁止**使用：

| 能力 | 为 `true` 时解锁 | 默认 |
|---|---|---|
| `reasoning` | `reasoning/delta` 事件 | `false` |
| `question` | `question/requested`、`question/resolved` 事件；`question/respond` 方法 | `false` |
| `approvalEditInput` | `approval/respond` 的 `amendedInput` 参数 | `false` |
| `usage` | `usage/updated` 事件 | `false` |
| `compactionEvents` | `compaction/performed` 事件 | `false` |
| `replay` | `session/resume` 的 `since` 参数 | `false` |
| `fileChanges` | `file/changed` 事件 | `false` |
| `subagents` | `subagent/started`、`subagent/finished` 事件 | `false` |
| `backgroundTasks` | `background/started`、`background/updated`、`background/finished` 事件 | `false` |
| `fork` | `session/fork` 方法 | `false` |
| `sessionList` | `session/list` 方法 | `false` |

- Harness **禁止**发出未声明为 `true` 的能力所对应的事件。
- Shell 调用被 `false` 门控的方法或传入被门控的参数 ⇒ `-32003`。
- Shell **必须**忽略未知能力键（向前兼容）。

---

## 6. 方法总览

ARI 1.0 共 **10 个请求方法**，外加 `initialized` 通知与 `event` 事件通道：

| 方法 | 方向 | 门控 | 说明 |
|---|---|---|---|
| `initialize` | C→S | — | 握手与能力协商（§5） |
| `initialized` | C→S | — | 通知，不参与门控（§5.2） |
| `session/new` | C→S | — | 建会话（§7.1） |
| `session/resume` | C→S | — | 重放与重连（§7.2） |
| `session/prompt` | C→S | — | 提交输入，入队（§7.3） |
| `session/cancel` | C→S | — | 取消在飞 turn（§7.4） |
| `session/fork` | C→S | `fork` | 从 turn 边界分叉（§7.5） |
| `session/list` | C→S | `sessionList` | 列会话（§7.6） |
| `shutdown` | C→S | — | 停机（§7.7） |
| `approval/respond` | C→S | — | 审批作答（§10.1） |
| `question/respond` | C→S | `question` | 提问作答（§10.2） |
| `event` | S→C | — | 唯一通知通道（§9） |

---

## 7. 会话生命周期

### 7.1 session/new

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":2, "method":"session/new", "params":{ "cwd":"/repo", "meta":{} } }
// S→C
{ "jsonrpc":"2.0", "id":2, "result":{ "sessionId":"s_01J9", "nextSeq":1 } }
```

- `cwd?`：工作目录提示。Harness **必须**自行校验，**不得**无条件信任。
- 新会话初始状态为 **`idle`**，`nextSeq` = **1**。
- Harness **禁止**在 `session/new` 应答之前发出该 session 的任何事件。
- 初始状态为 `idle` 是定义的一部分，**不需要**发 `session/status` 事件。

### 7.2 session/resume

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":9, "method":"session/resume", "params":{ "sessionId":"s_01J9", "since":12 } }
// S→C
{ "jsonrpc":"2.0", "id":9, "result":{
  "sessionId":"s_01J9", "replayedFrom":12, "nextSeq":14,
  "events":[ {"seq":12,"type":"message/delta","turn":1,"text":"…"} ],
  "snapshot": { "status":"idle", "nextTurn":2, "queue":[],
                "pendingApprovals":[], "pendingQuestions":[],
                "openToolCalls":[], "usage":{"inputTokens":0,"outputTokens":0} }
}}
```

- `since` 省略 ⇒ 从头重放。
- `since` 超出保留窗口**不是错误**：Harness **必须**退化为「`snapshot` + 自保留基点起的全部 `events`」，并以 `replayedFrom` 标明基点。仅当完全无日志可回放（`replay:false`）时才返回 `-32004`。
- `since` > 当前水位 ⇒ `-32602`（Shell 侧 bug，**禁止**静默纠正）。
- `sessionId` 未知 ⇒ `-32001`。**禁止**自动建会话。
- **一致性切面**：应答中 `events` 的最后一条 `seq` < `nextSeq`；此后同一 session 的实时事件 `seq` **必须** ≥ `nextSeq`，**不重不漏**。

`snapshot` schema：

```jsonc
{ "status": "running" | "idle",
  "nextTurn": 2,
  "queue": [ { "messageId":"m_1", "content":[{"type":"text","text":"…"}] } ],
  "pendingApprovals": [ { "approvalId":"ap_1", "toolCallId":"t_1", "toolName":"shell", "reason":"…", "options":[…]? } ],
  "pendingQuestions": [ { "questionId":"q_1", "questions":[…] } ],
  "openToolCalls": [ { "callId":"t_1", "name":"shell", "status":"running" } ],
  "usage": { "inputTokens":0, "outputTokens":0 } }
```

### 7.3 session/prompt

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":3, "method":"session/prompt", "params":{
  "sessionId":"s_01J9", "content":[{"type":"text","text":"列出当前目录的文件"}] } }
// S→C
{ "jsonrpc":"2.0", "id":3, "result":{ "messageId":"m_01JA" } }
```

- **并发 prompt = 入队，不拒绝、不隐式打断。** turn 运行中收到 `session/prompt`，Harness **必须**接受并追加到该 session 的 pending-input FIFO 队列。
- `messageId` 的承诺范围**严格**是「**已持久入队**」——既不表示 turn 已开始，也不表示模型已看到。
- **关联义务**：`turn/started` **必须**携带 `messageIds: string[]`，即该 turn 从队列 claim 的消息（可 ≥1 条）。否则回执在线上不可验证。
- **队列上限**：实现**可以**设内部上限；超限时**必须**以 `-32005` 拒绝该次 prompt，**禁止**静默丢弃。
- `content` 为 `ContentBlock[]`。ARI 1.0 仅定义 `{"type":"text","text":string}`；其他类型由扩展机制引入（§12）。
- `sessionId` 未知 ⇒ `-32001`。

### 7.4 session/cancel

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":4, "method":"session/cancel", "params":{ "sessionId":"s_01J9", "cause":"user" } }
// S→C
{ "jsonrpc":"2.0", "id":4, "result":{ "cancelledTurn":1, "droppedMessageIds":["m_01JB"] } }
```

- 作用域 = **当前在飞 turn**，并**清空尚未 claim 的 pending-input 队列**（真正的停止）。否则队列会立刻重启工作，取消形同虚设。
- 被取消的 turn **必须**结算为 `turn/completed{stopReason:"cancelled"}`（§8-I1）。
- 被丢弃的入队消息经 `droppedMessageIds` 与 `snapshot.queue` 可观测，**不**另发事件。
- 无在飞 turn 时 cancel 为**幂等空操作**。
- `cause` 为可选不透明字符串；ARI 1.0 **不**定义闭式枚举（各 Harness 的取消原因是内部概念）。
- `sessionId` 未知 ⇒ `-32001`。

### 7.5 session/fork（cap: `fork`）

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":5, "method":"session/fork", "params":{ "sessionId":"s_01J9", "atTurn":3 } }
// S→C
{ "jsonrpc":"2.0", "id":5, "result":{
  "sessionId":"s_01J9b", "nextSeq":1, "forkedFrom":{ "sessionId":"s_01J9", "turn":3 } } }
```

- 语义：以源 session 截至 `atTurn` 边界的历史为基础，创建**新的独立 session**。
- `atTurn` 省略 ⇒ 以当前 turn 边界为准。
- 新 session **必须**是全新的 `sessionId`，初始状态 `idle`，`nextSeq` = 1；**禁止**复用源 session 的 `seq` 空间。
- 源 session **不受影响**（fork 不是 move）。
- `atTurn` 不存在或不是 turn 边界 ⇒ `-32602`。
- 能力为 `false` 时调用 ⇒ `-32003`。

### 7.6 session/list（cap: `sessionList`）

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":6, "method":"session/list", "params":{ "cwd":"/repo" } }
// S→C
{ "jsonrpc":"2.0", "id":6, "result":{ "sessions":[
  { "sessionId":"s_01J9", "status":"idle", "cwd":"/repo", "title":"修复登录", "createdAt":"2026-09-24T12:00:00Z" }
]}}
```

- 仅返回调用方可访问的会话。`status` 取 `running|idle`。
- 能力为 `false` 时调用 ⇒ `-32003`。

### 7.7 shutdown

```jsonc
{ "jsonrpc":"2.0", "id":7, "method":"shutdown", "params":{} }   // → { "result": {} }
```

- 应答后 Harness **禁止**再发事件。
- 在飞 turn **直接放弃**——这是 §8-I1 结算不变量的**唯一豁免**。
- Harness **应当**在有限时间内退出。

### 7.8 订阅模型

- **隐式订阅**：连接对「本连接上 `session/new` 或 `session/resume` 成功的每个 session」自动订阅 `event`。**没有** subscribe 方法；唯一退订 = 关闭连接。
- 同一 session **允许**多连接：事件**必须**广播到全部订阅连接；任一连接上的 `approval/respond` 对全体生效。
- 跨 session 事件无序；**同一 session 在所有连接上必须按 `seq` 一致投递**。

### 7.9 顺序保证

- `session/prompt` 的应答**必须**先于「由该 prompt 引起的任何事件」发出。否则 Shell 无法归属事件。
- 其他来源（先前入队消息、后台工作）的事件**可以**与之交错。
- 事件在单 session 内**必须**严格按 `seq` 递增投递。

---

## 8. Turn 结算不变量

以下不变量**必须**成立：

- **I1（结算）**：同一 session 内，每个 `turn/started` **最终恰好**对应一条 `turn/completed`——无论中途发生 error、cancel、审批拒绝还是工具失败。
  **唯一豁免**：连接/进程终止（`shutdown` 或崩溃），此时在飞 turn 不再结算，Shell 以连接关闭为准。
- **I2（error 不替代结算）**：`session/error` 是**带外诊断**，**禁止**替代 `turn/completed`。致命错误也**必须**以 `turn/completed{stopReason:"error"}` 收尾。
- **I3（顺序）**：致命错误**必须**先发 `session/error`，紧接 `turn/completed{stopReason:"error"}`。只监听 `turn/completed` 的极简 Shell 也能正确收尾。
- **I4（可重试错误不结束 turn）**：`session/error{retryable:true}` 表示 Harness 将自行重试，**不要求** turn 结束；同一 turn **可以**出现多条。
- **I5（无 turn 的 error）**：`session/error.turn` **可以**缺省——错误可发生在任何 turn 之前。缺省时 Shell **禁止**假定存在在飞 turn。
- **I6（不卡 running）**：任何终止路径之后，session **必须**达到 `session/status:"idle"`。
- **I7（交互终局）**：每个 `approval/requested` / `question/requested` **恰好**对应一条 `*/resolved`。

**Shell 实现指引**：以 `turn/completed` 判定单 turn 结束；以 `session/status:"idle"` 判定「不会再自动干活」；以 `session/error` 取诊断信息。三者不可互相顶替。

---

## 9. 事件流

### 9.1 信封与类型

```jsonc
{ "jsonrpc":"2.0", "method":"event",
  "params": { "sessionId": "s_01J9", "seq": 4, "type": "tool/started", "...payload" } }
```

| 字段 | 类型 | 规则 |
|---|---|---|
| `sessionId` | string | 不透明。建议 `s_` + ULID |
| `seq` | integer | **1 起**，每 session 单调 +1，**无空洞**。重放与实时共用同一空间 |
| `type` | string | 事件类型，见 §9.2 / §9.3 |
| `turn` | integer? | **1 起**，每 session 单调 +1 |
| `messageId` / `callId` / `approvalId` / `questionId` / `taskId` | string | 不透明。建议前缀 `m_` / `t_` / `ap_` / `q_` / `bg_` + ULID |

### 9.2 必需事件（10）

| type | payload | 说明 |
|---|---|---|
| `session/status` | `status:"running"\|"idle"` | 状态**变更**时发出；`idle` 即「重试/队列均结束」 |
| `turn/started` | `turn, messageIds:string[]` | claim 了哪些入队消息 |
| `turn/completed` | `turn, stopReason:"end_turn"\|"max_tokens"\|"cancelled"\|"refusal"\|"error"` | 每个 started 恰好一条 |
| `message/delta` | `turn?, text` | assistant 文本增量 |
| `tool/started` | `turn?, callId, name, input?` | 工具调用开始 |
| `tool/updated` | `callId, status:"pending"\|"running", title?, outputDelta?` | 进度与输出增量 |
| `tool/completed` | `callId, status:"success"\|"error", output?, meta?` | `meta` 不透明，供 UI 使用 |
| `approval/requested` | `approvalId, toolCallId?, toolName?, reason?, options?` | `options` 缺省 = 三枚举（§10.1） |
| `approval/resolved` | `approvalId, decision:"allow_once"\|"allow_always"\|"deny"\|"expired"\|"cancelled"` | 每个 requested 恰好一条 |
| `session/error` | `error{ code, message, retryable? }, turn?` | 带外诊断 |

工具状态机收敛为：**`started → (updated*) → completed`**。`tool/completed` 是唯一终局事件。

### 9.3 能力事件（11）

| type | 门控 | payload |
|---|---|---|
| `reasoning/delta` | `reasoning` | `turn?, text` |
| `question/requested` | `question` | `questionId, questions[{id, question, detail?, options?, multiSelect?}]` |
| `question/resolved` | `question` | `questionId, outcome:"answered"\|"declined"\|"expired"` |
| `usage/updated` | `usage` | `turn?, usage{inputTokens, outputTokens, cachedTokens?, reasoningTokens?, cost?}` |
| `compaction/performed` | `compactionEvents` | `trigger:"manual"\|"auto"\|"overflow", preTokens?, postTokens?` |
| `file/changed` | `fileChanges` | `path, kind:"create"\|"modify"\|"delete"\|"rename", diff?` |
| `subagent/started` | `subagents` | `callId?, sessionId?, name?` |
| `subagent/finished` | `subagents` | `callId?, sessionId?, status:"success"\|"error"\|"cancelled", summary?` |
| `background/started` | `backgroundTasks` | `taskId, title?` |
| `background/updated` | `backgroundTasks` | `taskId, status:"running"\|"pending", title?, outputDelta?` |
| `background/finished` | `backgroundTasks` | `taskId, status:"success"\|"error"\|"cancelled", output?` |

**关于 subagent**：ARI 1.0 只标准化**事件面**——「有一个子 agent 在跑 / 跑完了」。子 agent 的**编排**（spawn/send/wait/close）**不在** ARI 内。若 Harness 暴露子会话，`subagent/started.sessionId` 给出其 `sessionId`，Shell **可以**通过 `session/resume` 挂载该子会话；未暴露时该字段缺省，Shell **不得**假定可挂载。

**关于 background**：同样只标准化事件面，**不**提供控制 API（启动/停止/查询）。需要控制的场景走扩展机制（§12）。

### 9.4 排序与重放

- 单 session 内**必须**严格按 `seq`；跨 session 无序。
- `session/resume{since}` 用它补洞（§7.2）。
- **pending 状态可推导**：`approval/requested` 未收到对应 `approval/resolved` = waiting；断线重连后由 `snapshot.pendingApprovals` / `snapshot.pendingQuestions` 给出当前挂起集。

---

## 10. 人机交互

### 10.1 approval/respond

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":7, "method":"approval/respond", "params":{
  "sessionId":"s_01J9", "approvalId":"ap_01",
  "decision":"allow_once", "amendedInput": null } }
```

- 决策枚举：`allow_once` | `allow_always` | `deny`。
- `approval/requested.options`（缺省 = 上述三枚举）：`[{ "id":"allow_once"|"allow_always"|"deny", "label": string }]`。
- Shell **禁止**发送未出现在 `options` 中的 decision（Harness 不想要 `allow_always` 就不下发它）。违反 ⇒ `-32602`。
- `amendedInput` 仅在 `agentCapabilities.approvalEditInput` 为 `true` 时可用；否则 ⇒ `-32003`。
- **失败关闭（fail-closed）**：Shell 消失或超时不得被解释为允许。Harness 自行兜底时**必须**发 `approval/resolved{decision:"expired"|"cancelled"}`。

### 10.2 question/respond（cap: `question`）

```jsonc
// C→S
{ "jsonrpc":"2.0", "id":8, "method":"question/respond", "params":{
  "sessionId":"s_01J9", "questionId":"q_01",
  "answers":[ { "id":"which", "values":["A"] } ] } }
```

- `question/requested.questions`：`[{ id, question, detail?, options?:[{id,label,detail?}], multiSelect? }]`。
- `options` 缺省 = 自由文本作答（`values` 为字符串数组）。
- **`answers: []` = 显式整体放弃作答**；未出现在 `answers` 中的 question 视为跳过。
- 终局：`question/resolved{outcome:"answered"|"declined"|"expired"}`。

### 10.3 幂等与跨断线时效

- 每个 `*/requested` 以**恰好一个** `*/resolved` 终结。
- Harness **必须**为每个交互 id 记住最后一次终局：
  - 同 id + 同 decision 重发 ⇒ **幂等返回 `{}`**（网络重试安全）
  - 同 id + **不同** decision，或 id 不存在 ⇒ `-32007`
- 挂起交互在 session 存活期间**跨断线保持有效，且不换 id**。重放出的 `*/requested` 与断线前是同一条 live 请求，Shell 按 id 去重即可。
- Harness **禁止**静默过期；自行兜底时**必须**发 `*/resolved`。
- 重连后的挂起集另由 `snapshot.pendingApprovals` / `snapshot.pendingQuestions` 给出；两条通道对同一 id **必须**一致。

---

## 11. 错误

### 11.1 错误码

| code | 名称 | 触发 | 可重试 |
|---|---|---|---|
| -32700 | `parse_error` | JSON 解析失败 | 否 |
| -32600 | `invalid_request` | 非法 JSON-RPC 对象 | 否 |
| -32601 | `method_not_found` | 方法不存在 | 否 |
| -32602 | `invalid_params` | 参数非法（含 `since` 越界、decision 不在 options、`atTurn` 非边界） | 否 |
| -32603 | `internal_error` | 内部错误 | 视情况 |
| -32001 | `session_not_found` | `sessionId` 未知（**禁止**自动建会话） | 否 |
| -32002 | `not_initialized` | `initialize` 成功应答前调用任何方法 | 是（先 initialize） |
| -32003 | `unsupported_capability` | 使用声明为 `false` 的能力所门控的方法/参数 | 否 |
| -32004 | `replay_unavailable` | 无日志可回放（`replay:false`） | 否 |
| -32005 | `queue_full` | pending-input 队列超上限（**禁止**静默丢弃） | 是（稍后重发） |
| -32006 | `already_initialized` | 已 initialize 的连接再次 initialize | 否 |
| -32007 | `unknown_interaction` | 交互 id 不存在，或不同 decision 重复作答 | 否 |
| -32008 | `unsupported_protocol_version` | 请求的 MAJOR 不受支持（`data.supportedVersions`） | 是（换版本重试一次） |

- `-32000`…`-32099` 为 ARI/JSON-RPC 保留区间。
- **不**定义请求级取消码（如 ACP 的 `-32800`）：取消是一等方法 `session/cancel`。

### 11.2 事件中的错误

`session/error` 的 `error` 对象复用 `{ code, message, retryable? }`，`code` 取值同上。事件中的错误**不**终止连接。

---

## 12. 扩展机制

ARI 1.0 通过**扩展**而非版本承诺来容纳未标准化的能力。

- **`_meta`**：任何对象**可以**带 `_meta` 自由字段。Shell **必须**忽略其内容。
- **保留前缀**：以 `_` 开头的字段名保留给规范使用；实现**禁止**自行使用。
- **扩展事件**：扩展事件类型**必须**以 `x-` 开头（如 `x-vendor/pty-resized`）。Shell **必须**忽略未知 `type`。
- **扩展方法**：扩展方法名**必须**以 `x-` 开头（如 `x-vendor/task/stop`）。
- **未知字段**：Shell 与 Harness **必须**忽略彼此不认识的字段与能力键（向前兼容）。

以下内容明确**不在** ARI 1.0，且**不需要**版本承诺即可由扩展提供：工具 schema 标准化、client tools 反转、PTC 事件、compaction 控制、中途转向（steer/inject）、审批策略修正、模型与权限模式设置、PTY/终端透传、子 agent 编排 API、后台任务控制 API。

---

## 13. 安全考虑

- **信任边界**：ARI 赋予 Shell 在用户环境中触发工具执行的能力。Binding A 下传输为同用户进程间 stdio；实现**禁止**将其暴露到不可信边界之外（网络、跨用户）而不加认证。
- **审批失败关闭**：任何不确定性（超时、断连、解析失败）**必须**解释为拒绝，**禁止**解释为允许。
- **资源上限**：1 MiB 帧上限与队列上限是**强制**的 DoS 防护，不得仅作为建议。
- **`cwd` 与路径**：Harness **必须**校验 `session/new.cwd` 与工具参数中的路径，**禁止**假定其已在沙箱内。
- **重放**：`session/resume` 会回放历史事件，其中可能含敏感内容。Harness **应当**将 session 可见性绑定到连接身份。
- **`meta` 与 `_meta`**：**禁止**将安全决策建立在这两个字段上。

---

## 附录 A：一致性清单

Harness 侧（可逐条测试）：

1. `initialize` 前调用任何方法 ⇒ `-32002`。
2. 重复 `initialize` ⇒ `-32006`。
3. 不支持的 MAJOR ⇒ `-32008` 且连接仍可重试。
4. 未知 `sessionId` ⇒ `-32001`，不自动建会话。
5. `session/new` 应答前无该 session 的事件；`nextSeq` = 1。
6. 事件 `seq` 自 1 起连续无空洞，重放与实时共用同一空间。
7. `turn/started.messageIds` 非空，且其消息此前已入队。
8. 每个 `turn/started` 恰好一条 `turn/completed`（含 error / cancel 路径）。
9. 致命错误先 `session/error` 后 `turn/completed{stopReason:"error"}`。
10. 每个 `approval/requested` 恰好一条 `approval/resolved`。
11. 每个 `question/requested` 恰好一条 `question/resolved`（`question` 能力为 true 时）。
12. 未声明为 `true` 的能力，其事件一个都不发。
13. 被 `false` 门控的方法/参数 ⇒ `-32003`。
14. `session/prompt` 应答先于该 prompt 引起的任何事件。
15. turn 运行中 `session/prompt` 被接受并排队，不打断在飞 turn。
16. 队列超限 ⇒ `-32005`，不静默丢弃。
17. `session/cancel` 结算在飞 turn 为 `cancelled`，并清空未 claim 队列。
18. `session/resume{since}` 的 `events` 末条 `seq` < `nextSeq`，之后实时事件 ≥ `nextSeq`，不重不漏。
19. `since` 超出保留窗口 ⇒ 返回 `snapshot` + `replayedFrom`，而非报错。
20. 同 id 同 decision 重复 `approval/respond` ⇒ `{}`；不同 decision ⇒ `-32007`。
21. 任一事件序列化后 ≤ 1 MiB，且 stdout 无杂质。
22. 任何终止路径后最终达到 `session/status:"idle"`（除连接终止）。

Shell 侧：

23. 忽略未知事件 `type`、未知字段、未知能力键。
24. 不发送未出现在 `options` 中的 decision。
25. 断线后以 `session/resume` 重建状态，以 `snapshot` 恢复挂起交互。

---

## 附录 B：与现有实现的映射

| ARI | DSH | Codex CLI / App Server | ZCode | OpenCode | Pi | ACP |
|---|---|---|---|---|---|---|
| `initialize` | SDK `initialize`（补版本协商） | app-server `initialize` | V4 握手 + `HostCapabilities` | — | RPC 握手 | `initialize` |
| `session/new` | `agents.create` | `thread/start` | `createSession` | `session.create` | 建 agent | `session/new` |
| `session/resume` | `agents.resume` + 事件转发 | rollout 重放 | 订阅 watermark | `/api/event` 重连 | — | `session/load` |
| `session/prompt` | SDK `session/prompt`→`messageId` | `turn/start` | `sendText` | `session.prompt` | `prompt` | `session/prompt` |
| `session/cancel` | `cancel(cause)` | `Op::Interrupt` | `stop` | fiber cancel | `abort` | `session/cancel` |
| `session/fork` | fork-at-turn-boundary | `InitialHistory::Forked` | `forkAssistant` | fork | fork | — |
| `session/list` | `list_agents` 类 | `thread/list` | — | — | — | `session/list` |
| `event` | `session.event` + `session.status` | 通知（三级坐标信封） | 投影 + delta | EventV2 / SSE | runtime 事件 | `session/update` |
| `message/delta` | `agent/assistant-stream` | `AgentMessageContentDelta` | `row.delta` | `message.part.updated` | `message_update` | `agent_message_chunk` |
| `reasoning/delta` | 流式 reasoning | `ReasoningContentDelta` | reasoning row | reasoning part | — | `agent_thought_chunk` |
| `tool/started\|updated\|completed` | `tool/call` / `tool/result` | `item/started\|completed` | `toolCall` row | tool part 状态机 | `tool_execution_*` | `tool_call(_update)` |
| `approval/*` | `approval/request` waterfall | `ExecApprovalRequest` + `ReviewDecision` | `pendingInteractions` + `resolveInteraction` | `permission.asked/replied` | 无内置权限 | `session/request_permission` |
| `question/*` | `user-questions` seam | — | `userInput` | `question.asked/replied` | 扩展 UI 对话框 | `elicitation/create` |
| `usage/updated` | usage 事件 | `thread/tokenUsage/updated` | `usage` StatePatch | usage part | usage | `usage_update` |
| `compaction/performed` | `compaction/*` | `ContextCompacted` | `Compact*` | `session.compacted` | `compaction_*` | unstable |
| `subagent/*` | provider + 控制工具 | SubAgentActivity item | 子 session + 镜像 | 子 session（自订阅） | 无 | 无 |
| `background/*` | jobs | `RunUserShellCommand` | `backgroundWorks` | 弱 | 无 | 无 |
| `session/error` | `agent/request-error` | `StreamError` | 错误状态 | `RetryPart` | `auto_retry_*` | — |

映射原则：**改信封，不改语义**。Harness 内部的 compaction 算法、PTC、工具管线、存储格式**不**因适配 ARI 而改变。

---

## 附录 C：与 ACP / MCP 的关系

- **MCP** 解决**工具接入**（Harness ↔ 工具）。ARI 不重复它；ARI 只规定工具**调用**的事件形状。两者正交，可同时使用。
- **ACP** 解决 **editor ↔ agent** 的会话协议，与 ARI 目标重叠。ARI 的差异：
  1. **不用 server→client 请求**（§3）——交互走「事件 + respond 方法」，Shell 无需请求路由器。
  2. **prompt 回执 ≠ turn 结局**：`session/prompt` 只承诺入队，turn 结算由 `turn/completed` 承载。ACP v1 中 `session/prompt` 的响应即 turn 结束。
  3. **不采用 client tools 反转**：ACP v2 草案已删除整个 client 执行面。
  4. **交互有终局事件**（`*/resolved`），断线重连后挂起状态可推导。
