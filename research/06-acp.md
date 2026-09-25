# 06 · ACP (Agent Client Protocol) source-level survey — ARI design precedent analysis

> Subject of study: Zed Industries' Agent Client Protocol (ACP). Local checkout (not committed; commit `e3bdb6d`, main branch); official docs at https://agentclientprotocol.com/; the TS/Rust runtime SDKs live in separate repositories (github.com/agentclientprotocol/typescript-sdk, rust-sdk), with key source verified via web_fetch.
>
> **Corpus note**: the task brief assumed the local repository contained a `ts/` package plus `schema/schema.json`, `schema.md`, `docs/`, and Rust crates. The actual repository layout has been restructured: the local checkout contains only `agent-client-protocol-schema/` (the Rust data-model crate, with v1/v2 modules), `schema/v1|v2/` (generated JSON Schema and `meta.json`), `schema-generator/`, `docs/` (Mintlify doc sources), and `CHANGELOG.md`. A local `ts/` directory: not found anywhere in the sources/docs. The conclusions about the TS SDK transport layer and the Rust runtime crate come from the raw sources of the corresponding separate repositories (URLs given in the body), not from local files.

---

## 1. What ACP is / is not

**Definition and the two parties.** ACP describes itself as "a protocol that standardizes communication between *code editors* and *coding agents*" (first paragraph of `README.md`; `docs/get-started/introduction.mdx`). The two roles:

- **Client**: the editor/IDE or other UI, which "manages the environment, handles user interactions, and controls resource access" (`docs/protocol/v1/overview.mdx:114-116`).
- **Agent**: "a program that uses generative AI to autonomously modify code, typically run as a subprocess of the Client" (`overview.mdx:43-45`).

**Positioning: an agent backend process spawned by the editor.** `docs/get-started/architecture.mdx:16-18`: "when the user tries to connect to an agent, the editor launches the agent subprocess on demand, and all communication goes over stdin/stdout". One connection can carry multiple concurrent sessions (same file: "Each connection can support several concurrent sessions"). Local agents use JSON-RPC over stdio; remote agents use HTTP/WebSocket (still in progress, `introduction.mdx` Info block).

**Design philosophy** (`architecture.mdx:8-14`): (1) MCP-friendly — reuses MCP's JSON representations such as `ContentBlock` (`docs/protocol/v1/content.mdx:16-18` states explicitly that ContentBlock is identical to MCP's, so MCP tool output can be forwarded without conversion); (2) UX-first — designed for the agent coding UX (diff display, permission prompts, progress streaming), "no more and no less abstraction"; (3) Trusted — the trust model is the "editor trust model": the user controls tool calls inside the editor, and the editor grants the agent local file and MCP access.

**What it is not.** ACP does not define agent internals: there is no protocol surface for model-provider selection (model/reasoning level are exposed via session config options with `category: "model"` / `"thought_level"`, `docs/protocol/v1/session-config-options.mdx:202-209`; `providers/list|set|disable` exist only under `#[cfg(feature = "unstable_llm_providers")]`, `agent-client-protocol-schema/src/v1/agent.rs:4758-4763`); it does no prompt orchestration or context management; authentication is "the agent's own account system" (`authenticate`/`authMethods`, see §3), and the protocol never holds model API keys — `docs/protocol/v1/elicitation.mdx:134-135` explicitly forbids sending a token obtained via URL-mode elicitation back through the ACP channel or into model context. v1 also has no stable protocol surface for agent-side background tasks, subagents, or context compaction (§9).

---

## 2. Transport and framing

**JSON-RPC 2.0 over stdio, newline-delimited (not Content-Length).** At the spec layer:

- `docs/protocol/v1/overview.mdx:10`: "The protocol follows the JSON-RPC 2.0 specification"; messages split into Methods (request-response) and Notifications (one-way).
- `docs/protocol/v1/transports.mdx:17-27` (key points of the stdio transport section): the client launches the agent as a subprocess; "Messages are delimited by newlines (`\n`), and **MUST NOT** contain embedded newlines" (:24); the agent **MUST NOT** write anything that is not an ACP message to stdout (:26), while stderr may be used for logging (:25). **There is no Content-Length header** — a clean break from LSP's HTTP-style framing; it is simply line-by-line NDJSON.
- `overview.mdx:225-227` conventions: JSON object keys are `camelCase`, discriminator strings are `snake_case`, and the JSON-RPC envelope fields (`jsonrpc/id/method/params/result/error`) follow JSON-RPC 2.0.

**TS implementation evidence** (github.com/agentclientprotocol/typescript-sdk, raw files):
- `src/line-buffer.ts`: `LineBuffer.push(chunk)` incrementally splits lines on `const newline = 0x0a`, buffering incomplete lines across chunks — framing is purely on byte 0x0a, with no length header of any kind.
- `src/examples/client.ts`: `spawn(...)` starts the agent subprocess, then `const stream = acp.ndJsonStream(input, output)` followed by `acp.client(...).connectWith(stream, ...)` — the official example is exactly "subprocess + NDJSON stream".

**Rust implementation evidence** (github.com/agentclientprotocol/rust-sdk, raw files):
- `src/agent-client-protocol/src/stdio.rs`: `Stdio::connect_to` reads with `BufReader::new(stdin).lines()` and writes with `crate::jsonrpc::write_line(&mut writer, line)` — line-based send/receive.
- `md/transport-architecture.md`: the byte-stream transport "Write newline-delimited JSON to stream"; the protocol layer and framing layer meet at the `TransportFrame` boundary (one frame = one `RawJsonRpcMessage`, one non-empty `TransportBatch`, or malformed input preserved as-is); in-process `Channel::duplex()` skips serialization. Batching (JSON-RPC batch) is uniformly supported at the SDK layer for v1/v2.

**Where the JSON-RPC envelope sits in the data model**: `agent-client-protocol-schema/src/rpc.rs:50-57` (`Request{id, method, params}`), `:116-121` (`Notification{method, params}`), `:138-142` (`JsonRpcMessage{jsonrpc:"2.0", flattened}`); the `notification_wire_format` test at `:336-396` gives the exact wire shape. All method-name constants are concentrated in `src/v1/agent.rs:4753-4789` (agent side) and `src/v1/client.rs:2689-2707` (client side), summarized in `schema/v1/meta.json`. Note: the wire method name of the session update stream is **`session/update`** (`client.rs:2689`), and the docs agree; the `"sessionUpdate"` seen in the `rpc.rs:360` test is just a test-invented method name, not a wire name.

**Backward-compatibility rules**:
- `protocolVersion` is a single integer representing only the MAJOR version, "bumped only on breaking changes"; the client reports its latest version, the agent returns it verbatim if supported and otherwise returns the latest version it supports, and a client that does not support the result should disconnect and inform the user (`docs/protocol/v1/initialization.mdx:84-98`).
- "Introducing new capabilities is not a breaking change"; any capability not advertised in initialize is treated as unsupported (`initialization.mdx:100-106`). Within one wire version, optional messages/parameters are gated by capabilities (`README.md` Versioning section: wire compatibility depends only on the negotiated `protocolVersion`, independent of crate/JSON Schema artifact versions).
- Version constants: `ProtocolVersion(u16)` has `V0` (pre-release), `V1` (stable), `V2` (draft, available only under the `unstable_protocol_v2` feature), `agent-client-protocol-schema/src/version.rs:9-49`.
- Rust types are all `#[non_exhaustive]`, with enums carrying a `#[serde(other)]` fallback (e.g. `ToolKind::Other`, `src/v1/tool_call.rs:493-495`); the extension mechanisms are the `_meta` field and `_`-prefixed custom methods (`overview.mdx:229-237`). The v2 draft goes further, turning all enums/tagged unions into open sets with the `_` prefix reserved for implementations (`docs/protocol/v2/migration.mdx` "Extensibility and forward compatibility").

**Remote transport (in progress)**: the v1 spec has only stdio plus "Streamable HTTP (draft proposal in progress)" (`transports.mdx:44-46`); the RFD `docs/rfds/streamable-http-websocket-transport.mdx` proposes long-lived GET SSE streams (connection-level + session-level) + POST (202 Accepted, `initialize` excepted) + a WebSocket upgrade on the same endpoint, with a MUST that both be supported, plus HTTP/2 and cookie support requirements.

---

## 3. Handshake: initialize / authenticate

`initialize` (Client→Agent request) carries `protocolVersion` + `clientCapabilities` + (SHOULD) `clientInfo{name,title,version}`; the response carries the negotiated `protocolVersion` + `agentCapabilities` + (SHOULD) `agentInfo` + `authMethods[]` (`docs/protocol/v1/initialization.mdx:24-82`; the JSON example is the wire format).

**clientCapabilities** (`initialization.mdx:114-182`):
- `auth.terminal: boolean` — only if the client can reproduce the agent's login command in an interactive terminal may the agent advertise a `type:"terminal"` auth method (:118-128; `docs/protocol/v1/authentication.mdx:92-128`, with an example using the `ACP_INTERACTIVE_LOGIN=1` env var).
- `fs.readTextFile` / `fs.writeTextFile` (:130-138) — availability of the corresponding `fs/*` methods.
- `terminal: boolean` — all `terminal/*` methods available (:144-153).
- `elicitation: {form:{}, url:{}}` — which elicitation modes are supported; ACP deliberately differs from MCP here: `{}` does not mean form is supported (:155-167; `docs/protocol/v1/elicitation.mdx:40-52`).
- `session.configOptions.boolean` — support for boolean config options (:169-182).

**agentCapabilities** (`initialization.mdx:184-267`):
- `loadSession: boolean` — `session/load` is available (:188-191; note that :264-267 explicitly keeps it outside `sessionCapabilities`, to be unified in the future).
- `promptCapabilities: {image, audio, embeddedContext}` — content types `session/prompt` can accept; baseline: every agent **MUST** support `ContentBlock::Text` and `ResourceLink` (:202-218).
- `mcpCapabilities: {http, sse}` — transports the agent can use to connect to MCP servers; SSE is deprecated by the MCP spec (:220-231).
- `auth.logout` — the `logout` method is available (:233-241).
- `sessionCapabilities: {list:{}, delete:{}, resume:{}, close:{}, additionalDirectories:{}}` — `{}` object-style support markers for the session-level extension methods (:243-267).

**authMethods / authenticate / logout**: the agent advertises `authMethods[{id,name,description,type?}]` in the initialize response; `type` defaults to `"agent"` when absent (using the in-protocol `authenticate{methodId}` flow, `docs/protocol/v1/authentication.mdx:78-167`); with `type:"terminal"` the client instead starts a separate interactive process with the same agent launch configuration to complete login (exit 0 = success), and **MUST NOT** send `authenticate` for that method (:169-188). `logout` (an agent method, requires `agentCapabilities.auth.logout`) terminates the authenticated state (:190-216). For the Rust-side `AuthMethod` and related types see `src/v1/agent.rs:583-707`.

---

## 4. Session lifecycle

Baseline methods: every agent **MUST** support `session/new`, `session/prompt`, `session/cancel`, and `session/update` (`initialization.mdx:245`; the Rust comment says the same, `src/v1/agent.rs:4026`).

- **session/new**: params `cwd` (absolute path, MUST) + `mcpServers[]` (the stdio configuration `{name,command,args,env}` must be supported; `{type:"http",name,url,headers}` and `{type:"sse",...}` require `mcpCapabilities.http`/`sse` respectively); the response is `{sessionId}` and MAY include `modes` / `configOptions` (`docs/protocol/v1/session-setup.mdx:45-81`; MCP transport details :369-545). `cwd` rules: must be an absolute path, ignores where the subprocess was actually started, is the base for resolving relative paths, and belongs to the set of session roots (:358-367).
- **session/load** (requires `loadSession`): pass `{sessionId, cwd, mcpServers}`; the agent **MUST** replay the entire session history to the client via `session/update` notifications (including `user_message_chunk`/`agent_message_chunk`, optionally carrying `messageId`), and only respond `{}` once the replay is complete (:83-188). This is the classic design of "state lives in the agent; the UI is rebuilt by event replay".
- **session/resume** (requires `sessionCapabilities.resume`): same params but **MUST NOT** replay history; it responds after restoring context directly, and the response may attach initial mode/model/config state (:190-253). RFD `session-resume.mdx`; in v1 load/resume are two methods, merged in v2 into `session/resume` + a `replayFrom` cursor (`docs/protocol/v2/migration.mdx` "session/load is gone").
- **session/close** (requires `sessionCapabilities.close`): cancels the session's in-flight work and releases resources (equivalent to a `session/cancel` first) (:255-311).
- **session/list / session/delete**: discovery of known sessions (`cwd` filter + cursor pagination, `SessionInfo{sessionId,cwd,title,updatedAt,additionalDirectories?,_meta}`); a `session_info_update` notification can push metadata such as the title in real time (`docs/protocol/v1/session-list.mdx:35-217`); delete removes an entry from the list results (`docs/protocol/v1/session-delete.mdx`; capability `sessionCapabilities.delete`).
- **additionalDirectories**: `session/new|load|resume` may carry additional working root directories, widening the session's filesystem boundary to `[cwd, ...additionalDirectories]`; all paths are absolute, and the full list must be re-sent on resume (`session-setup.mdx:313-344`).
- **session/prompt**: params `{sessionId, prompt: ContentBlock[]}`; content types are constrained by promptCapabilities (`docs/protocol/v1/prompt-turn.mdx:57-98`). The response returns `{stopReason}` when the turn ends, with values `end_turn | max_tokens | max_turn_requests | refusal | cancelled` (:215-227, :292-311). **In v1 the response is the turn's endpoint** — this is the core of what v2 reworks (§9).
- **session/cancel** (notification): the client may interrupt at any time; the client should mark unfinished tool calls as cancelled and answer all pending permission requests with the `cancelled` outcome; once stopped, the agent **MUST** respond to the original prompt with `stopReason:"cancelled"` (:312-345). The agent **MUST** catch the underlying SDK's abort exception and translate it into a semantic cancelled (:334-341 Warning).
- **session/set_mode**: `{sessionId, modeId}` switches the mode (`docs/protocol/v1/session-modes.mdx:77-104`). There is **no** `session/set_model`; model/thought-level selection goes through config options (§8). `providers/list|set|disable` (agent methods) exist only under an unstable feature.

---

## 5. Streaming updates: the full set of `session/update` variants

Wire format: `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId", "update":{"sessionUpdate": <tag>, ...}}}`, with the tag in snake_case. The authoritative Rust enum is `SessionUpdate` (`agent-client-protocol-schema/src/v1/client.rs:99-169`, `#[serde(tag="sessionUpdate", rename_all="snake_case")]`):

**v1 stable variants**:
1. `user_message_chunk` (`ContentChunk`) — streamed chunks of the user message (appears during replay; in a live turn the user message is embedded in the prompt request).
2. `agent_message_chunk` — streamed agent reply text/rich content (`docs/protocol/v1/prompt-turn.mdx:147-169`; `messageId` is optional: the same ID belongs to the same message, an ID change means a new message).
3. `agent_thought_chunk` — streamed agent internal thinking (reasoning events).
4. `tool_call` — reports a new tool call (see below).
5. `tool_call_update` — incremental update of a tool call; every field except `toolCallId` is optional, and only changed fields are sent (`docs/protocol/v1/tool-calls.mdx:98-131`).
6. `plan` — full replacement of the task plan: `entries[{content, priority: high|medium|low, status: pending|in_progress|completed}]`; "MUST send the complete list, and the Client replaces it wholesale" (`docs/protocol/v1/agent-plan.mdx:44-83`).
7. `available_commands_update` — slash-command advertisement: `availableCommands[{name, description, input:{hint}}]`, pushable at any time; commands enter the prompt as plain `/cmd args` text (`docs/protocol/v1/slash-commands.mdx:8-96`).
8. `current_mode_update` — agent-side mode change `{currentModeId}` (`session-modes.mdx:106-122`).
9. `config_option_update` — the agent pushes the full `configOptions` (`session-config-options.mdx:318-349`).
10. `session_info_update` — title/timestamps/`_meta` metadata (`session-list.mdx:177-217`).
11. `usage_update` — **usage reporting has entered the v1 stable surface**: `{used, size, cost?: {amount, currency}}`, where `used`/`size` are the current context token count and window size and `cost` is the cumulative cost in ISO 4217 (`prompt-turn.mdx:190-213`; `src/v1/client.rs:609-629` `UsageUpdate{used: u64, size: u64, cost}`). Announced in `docs/announcements/session-usage-stabilized.mdx` (dated 2026-06-05).

**v1 unstable variants** (`#[cfg(feature=...)]`, RFD drafts, off by default): `plan_update` / `plan_removed` (`unstable_plan_operations`, `client.rs:113-126`); `notice` (`unstable_session_notices`, an advisory outside the message history, :139-148); `compaction_update` / `compaction_summary_chunk` (`unstable_session_compaction`, a context-compaction entity + streamed appends of the summary, :149-168; design in `docs/rfds/session-compaction.mdx`, with `compactionId` + `status: in_progress|completed`).

**tool_call details** (`docs/protocol/v1/tool-calls.mdx:14-96`; `src/v1/tool_call.rs`):
- Fields: `toolCallId` (required), `name` (optional programmatic tool name, "advertises no capability and grants no permission"), `title` (human-readable, required), `kind`, `status`, `content[]`, `locations[]`, `rawInput`, `rawOutput` (arbitrary JSON values; on update, omitted = keep the original value).
- `ToolKind` (`tool_call.rs:473-496`): `read | edit | delete | move | search | execute | think | fetch | switch_mode | other` (the default, backed by `#[serde(other)]`).
- `ToolCallStatus` (`tool_call.rs:514-525`): `pending` (input still streaming, or awaiting approval) → `in_progress` → `completed | failed`.
- Three forms of `ToolCallContent` (`tool_call.rs:546-557`): `content` (MCP-style content blocks), `diff` (`{path, oldText?, newText}` single-file text diff, `:277-295`), `terminal` (`{terminalId}` referencing the product of `terminal/create`; the client keeps displaying its live output, `terminals.mdx:113-140`).
- `ToolCallLocation{path, line?}`: lets the client implement a "follow the agent" cursor linkage (`tool-calls.mdx:318-337`).

---

## 6. Client-side tool inversion: the client is the tool provider for fs/terminal

ACP's most interesting architectural decision: **agent-side tool execution can call back into the client**. The connection is bidirectional JSON-RPC; the client is also a server.

- **fs/read_text_file**: agent→client request `{sessionId, path, line?, limit?}`, returning `{content}`; can read the editor's unsaved state (`docs/protocol/v1/file-system.mdx:31-75`). Line numbers are 1-based; all paths must be absolute (`overview.mdx:212-215`).
- **fs/write_text_file**: `{sessionId, path, content}`; the client MUST create the file if it does not exist (`file-system.mdx:77-117`).
- **terminal/create**: `{sessionId, command, args?, env?, cwd?, outputByteLimit?}`; the client immediately returns `{terminalId}` and the command runs in the background (`docs/protocol/v1/terminals.mdx:28-111`); when `outputByteLimit` is exceeded, truncation happens from the head and MUST occur on a character boundary (:79-90).
- **terminal/output**: `{output, truncated, exitStatus?:{exitCode?, signal?}}` fetches the current output without blocking (:142-190).
- **terminal/wait_for_exit**: blocks until exit (:191-227).
- **terminal/kill**: kills the command but keeps the terminal (output/wait_for_exit still usable); a release **MUST** still follow (:229-249). Timeouts are implemented by the agent composing primitives: create → race a timer against wait_for_exit → kill when it fires → output to grab the tail → release (:251-262) — the protocol has no built-in timeout parameter; it is expressed by composition.
- **terminal/release**: kills the process and releases all resources; the ID becomes invalid (:264-282).
- **session/request_permission**: agent→client request for user authorization (§7).
- **elicitation/create + elicitation/complete**: structured questioning built on the MCP elicitation data model (form mode: a restricted JSON Schema; URL mode: an out-of-band OAuth flow with `elicitationId` plus a completion notification calling back, `docs/protocol/v1/elicitation.mdx`). Form mode **MUST NOT** be used to solicit secrets (:105-111).
- **Reverse MCP injection**: when the client wants to hand its own tools to the agent, it "can pass itself to the agent as an MCP server configuration", tunneling back through a stdio proxy if necessary (`session-setup.mdx:543-545`; `architecture.mdx:31-35` and the mcp-proxy diagram).

**Why the inversion**: it keeps the "editor" authoritative over the filesystem and terminal (including unsaved buffers and terminal UI rendering), so the agent only needs to state intent. But this client execution surface is **deleted wholesale** in the v2 draft: the `fs/*` methods and all `terminal/*` methods are removed, replaced by "the client provides tools via `mcpServers`, and the agent owns display-only terminal streams" (`docs/protocol/v2/migration.mdx` "Client file system and terminal execution removed": "inconsistently implemented outside of a few IDEs"). This is a highly instructive lesson for ARI (§11).

---

## 7. Permission model

- Request: `session/request_permission` (an agent→client **request**, i.e. the agent blocks waiting on the JSON-RPC response), params `{sessionId, toolCall: ToolCallUpdate, options[], _meta?}` — `toolCall` allows refreshing/completing the tool call display at the same time as requesting permission (`docs/protocol/v1/tool-calls.mdx:135-174`; `src/v1/client.rs:968-985`).
- Options: `PermissionOption{optionId, name, kind}` with `kind ∈ allow_once | allow_always | reject_once | reject_always` (`tool-calls.mdx:213-233`; `client.rs:1092-1101`). kind is only a UI hint (icon/semantics); the concrete "remember" policy lives in the client.
- Response: `{outcome: {outcome:"selected", optionId} | {outcome:"cancelled"}}` (`tool-calls.mdx:176-211`; `client.rs:1152-1167`, `#[serde(tag="outcome")]`). When the turn is cancelled, the client **MUST** answer all pending requests with `cancelled` (`tool-calls.mdx:193-205`).
- The client may auto-allow/auto-deny based on user settings (`tool-calls.mdx:191`).
- Cascade cancellation: `$/cancel_request` (`{requestId}`, a protocol-level notification, `agent-client-protocol-schema/src/v1/protocol_level.rs:73`) can retract a single request issued by the agent (e.g. terminal/create or a permission request), with response error code `-32800` (`docs/protocol/v1/cancellation.mdx:10-38`; cascade sequence :40-68).
- **The "edit param on approval" the task brief asked about (attaching edits/parameter modifications at approval time)**: not found anywhere in the v1 stable protocol's sources/docs — the permission response is only selected/cancelled, with no field carrying parameter modifications. The v2 draft's evolution decouples the permission prompt from tool state: `title` (required), `description?`, and an extensible `subject: {type:"tool_call"|"command", ...}` (`docs/protocol/v2/migration.mdx` "Permission requests"). An equivalent of "modify the input at approval time" does not exist in ACP.
- Typical usage: in architect mode, a "switch_mode" tool borrows the same permission mechanism to ask for confirmation of "leaving plan mode" (`session-modes.mdx:124-173`, with option kinds mapped to allow_always/allow_once/reject_once).

---

## 8. Session modes and configuration

- **modes (v1, flagged for deprecation)**: the session response may carry `modes: {currentModeId, availableModes[{id,name,description}]}`, with ask/architect/code as the canonical example (`session-modes.mdx:15-47`). A Note at the top of the doc: config options are the new way, and "the dedicated mode methods will be removed in a future version" (:6-11); the same applies to `session/set_mode` and `current_mode_update`.
- **session config options (the successor)**: the agent returns an ordered `configOptions[]` in the session response; each item is `{id, name, description?, category?, type: "select"|"boolean", currentValue, options: ConfigOptionValue[] | ConfigOptionGroup[]}` (`session-config-options.mdx:15-110`). Semantic categories are `mode | model | model_config | thought_level`, with `_`-prefixed categories reserved for custom ones; categories exist only for UX (shortcuts/icons/placement), and unknown categories MUST be tolerated (:191-211). The boolean type requires the client to have advertised `session.configOptions.boolean` first (:154-189).
- **Modification**: the client uses `session/set_config_option {sessionId, configId, value}`, and the agent **MUST** return the **full** configOptions (because options can be interlinked — e.g. switching the model changes the reasoning option); agent-initiated changes are pushed as `config_option_update` (:233-355). In v1 the `set_config_option` value is a bare string|boolean; v2 changes it to a `type`-tagged `{type:"id"|"boolean"}` (`migration.mdx` "Session modes become config options").
- Degradation strategy: when an agent provides configOptions it SHOULD also keep `modes` for older clients, and clients that support configOptions SHOULD ignore `modes` (:357-368).

---

## 9. Surfaces ACP explicitly does not cover / covers insufficiently

- **Agent loop internals**: the prompt-turn doc only stipulates that "the agent processes the user message and interacts with the LLM"; it is completely oblivious to internal turn-splitting, retries, and model switching (`prompt-turn.mdx:100-102`).
- **Model provider / API key**: no protocol surface; authentication is the agent's account system (§3). Provider management methods are unstable-only (`v1/agent.rs:4758-4763`) plus the RFD `custom-llm-endpoint.mdx`.
- **Context compaction**: absent from stable v1; `usage_update` reports only window occupancy, not compaction events; compaction, as `compaction_update`/`compaction_summary_chunk`, is at the unstable + RFD stage (`docs/rfds/session-compaction.mdx`; v1 `client.rs:149-168`). ARI should note: this is a boundary case of "runtime internal responsibility leaking into the UI", and ACP chose "report events, not mechanisms".
- **Subagents**: the protocol has no subagent concept. Only `docs/rfds/proxy-chains.mdx:402` mentions that "a proxy can create subagents via new sessions", and `docs/rfds/session-fork.mdx:35` lists summaries/possible subagents as one use of fork — i.e. multiple agents are achieved by composing **multiple sessions / multiple connections / proxy layers**, not as in-protocol entities.
- **Background tasks**: v1 has no explicit model (emitting `session/update` outside a turn is a gray area). The v2 draft tackles "beyond the turn" head-on: the prompt response only confirms insertion of the user message (returning `messageId`), `state_update{running|idle|requires_action}` carries foreground state and the stopReason, and background updates may continue while idle (`docs/announcements/acp-v2-draft.mdx`; `migration.mdx` "The new prompt lifecycle").
- **Usage**: session-level context/cost is stable (`usage_update`); the **per-turn token breakdown** (input/output/cache/reasoning categories) remains a Draft RFD, `docs/rfds/end-turn-token-usage.mdx` ("Intentionally kept in Draft"), and v1 `PromptResponse` has no usage field.
- **PTC (programmatic tool calling, the model calling tools directly in code)**: no protocol support found anywhere in the sources/docs.
- **Parallel tools**: no explicit fan-out semantics; availability comes from bidirectional JSON-RPC concurrency (multiple in-flight requests) + the background execution of `terminal/create` + multiple sessions per connection (`architecture.mdx`). The cancellation doc's sequence diagram (`cancellation.mdx:40-68`) explicitly shows the agent with terminal/create and request_permission outstanding as two concurrent requests at once.
- **File changes**: v1's diff expressiveness is limited (single-file `oldText/newText`; cannot distinguish deletion vs emptying; no rename/copy/binary); the v2 draft switches to structured `changes[]` (add/delete/modify/move/copy + fileType/mimeType) plus an optional `git_patch` (`migration.mdx` "Diff Overhaul"/"Diff content").

---

## 10. Ecosystem evidence

- **Official registry**: `curl https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, GitHub `agentclientprotocol/registry`, agent manifests submitted via PRs (`docs/get-started/_registry_agents.mdx`); the RFD is Completed (`docs/announcements/acp-agent-registry-stabilized.mdx`).
- **Agents implementing ACP** (`docs/get-started/agents.mdx`, excerpt): Gemini CLI (google-gemini/gemini-cli), Claude Agent (via Zed's SDK adapter `zed-industries/claude-agent-acp`), **Codex CLI (via the official adapter `agentclientprotocol/codex-acp`)**, Qwen Code, Kimi CLI, OpenCode, Goose, Cursor CLI, GitHub Copilot CLI (public preview, changelog link), Junie, Cline, Factory Droid, Mistral Vibe, OpenHands, Docker cagent, Kiro CLI, and 40+ in total.
- **Clients implementing ACP** (`docs/get-started/clients.mdx`): Zed, JetBrains AI Assistant, Qt Creator (official ACP plugin), Visual Studio (Poolside Assistant), multiple VS Code extensions (vscode-acp, ACP Patchbay, etc.), Neovim (CodeCompanion/agentic.nvim/avante.nvim/hermes.nvim), Emacs (agent-shell.el), multiple Obsidian plugins, Pulsar, Sublime, Unity, DuckDB/marimo/Jupyter integrations; CLI/TUI (acpx, Toad, Nori CLI, ...); dozens of desktop/web apps; **message bridges** (Slack/Discord/Telegram/WeChat/Feishu/QQ); mobile (Happy, Runmote, etc.); plus connector layers for stdio↔HTTP/WebSocket (`acp_rpc_bridge`, ACP to AG-UI, etc. — which is precisely proof that the transport layer is the patch point the ecosystem builds for itself).
- **Official SDKs**: Kotlin (acp-kotlin), Java, Python, Rust (`agent-client-protocol` runtime crate + `agent-client-protocol-schema` schema crate), TypeScript (`@agentclientprotocol/sdk`) (`README.md` Integrations section).

---

## 11. Boundary analysis: ACP vs ARI

**Overlap** (if ARI builds these, it will almost certainly reuse ACP's shapes): the session abstraction (`sessionId` + `session/new|prompt|cancel`); streaming updates (chunked `session/update` + tool call lifecycle events); approval (options array + kind hints + selected/cancelled outcome); the client bridge for fs/terminal (the client as tool provider); resume/replay semantics; `_meta` extension and the open-enum compatibility strategy.

**Essential differences**:
1. **Different counterpart identity.** ACP's counterpart is "the editor / any UI", with UX as the core motivation (`architecture.mdx` "UX-first"; diffs, cursor following, and terminal live output are all editor scenarios). ARI's counterparts are Coding Shell ↔ Agent Runtime/Harness: the shell is not just a renderer — it has its own loop, context, tools, and task orchestration, and what it needs is **runtime hosting and delegation** (session orchestration, background tasks, concurrent tools, compaction boundaries, usage settlement), not "adding a chat panel to an editor". Evidence: only in ACP v2 were `state_update` (running/idle/requires_action) and an event stream beyond the turn added, and the client execution surface was deleted — precisely showing that the "editor as tool host" model cannot sustain thicker runtime scenarios.
2. **Opposite direction of ownership.** ACP v1: state lives in the agent, while file/terminal authority lives in the client (inversion). v2: everything is reclaimed by the agent (agent-owned terminals, tools provided via MCP). ARI should be explicit from day one: **authority over context and history belongs to the Runtime**, while the shell holds the display state and its local resources (workspace, credentials, terminal); tool execution rights are assigned by resource ownership, not by "who is the editor".
3. **Granularity.** An ACP session ≈ one conversation thread; the task/session hierarchy ARI needs (subagents, fan-out, background tasks, cancellation trees) exists in ACP only as the embryonic proxy/fork RFDs (§9).

**What ARI should not copy from ACP**:
- **The fs/terminal inverted execution surface** (v1's `fs/*`, `terminal/*`) — ACP itself has already deprecated it in v2, on the grounds of "inconsistently implemented outside of a few IDEs"; ARI can simply bridge client resources via MCP/tool manifests.
- **Binding the turn to the request lifecycle** (v1 prompt-response=turn) — v2 has already changed this; ARI should separate "input submission" from "work progress/completion" from day one (see `state_update`).
- **The dual track of modes** (`modes` coexisting with configOptions) — a dual track during a deprecation window is historical baggage; ARI needs only a single config/selector mechanism.
- **The int magic-number protocolVersion with semantics living in docs** — borrowable, but the version policy should come with a capability bitmap rather than only a MAJOR integer.

**What is worth copying for ARI**:
- **The permission options model**: `{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}` + the `selected/cancelled` outcome + the "cancelled is not an error" semantics (`tool-calls.mdx`, `prompt-turn.mdx:334-341`) — simple, localizable, and automatable by the client; v2's `subject` tagged union (tool_call/command, extensible) decouples "what is being requested" from "what is displayed", also worth copying outright.
- **The tool_call lifecycle**: `pending (awaiting input/approval) → in_progress → completed/failed` + idempotent upsert keyed by `toolCallId` + pass-through of `rawInput/rawOutput` + `locations` following + `kind` classification (`tool_call.rs:473-525`). ARI's tool event stream can align directly with this state machine in exchange for ecosystem mindshare.
- **Update chunking and upsert patch semantics**: v2's three-state patch (omitted = unchanged / null = clear / value = replace; chunk = append) + the required `messageId` (`migration.mdx` "Updates are upserts") is the right answer for streaming UIs, avoiding the awkwardness of v1's `tool_call`/`tool_call_update` method pair and the plan's full-list replacement.
- **NDJSON-over-stdio framing and the stdout purity rule** (§2) — an order of magnitude simpler than LSP's Content-Length, and debuggable with `grep`/`jq`; the `MUST NOT` pollute stdout rule must be kept.
- **The `_meta` + `_`-prefix extension approach and open enums** — low forward-compatibility cost.
- **The cancelled cascade model**: two layers of cancellation — `session/cancel` (semantic level) + `$/cancel_request` (request level, -32800) (`cancellation.mdx`).

---

## 12. Capability Matrix — the ACP row

| Session | Resume | Streaming | Cancellation | Approval | Tool events | File changes | Terminal | Background task | Parallel tools | Compaction | Subagent | Usage | Reasoning events | PTC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ✓ | ✓ (partial*) | ✓ | ✓ | ✓ | ✓ | partial | ✓ (v1 client-run / v2 agent-display) | ✗ (v1) / partial (v2 draft) | partial | partial (unstable) | ✗ | partial (session-level ✓, per-turn ✗) | ✓ | ✗ |

Evidence pointers: Session = `session/new` + multiple sessions per connection (`docs/get-started/architecture.mdx:20`, `session-setup.mdx:45-81`); Resume = `session/load` replay + `session/resume` without replay (`session-setup.mdx:83-253`, *the two are merged in v2*); Streaming = the 11 stable variants of `session/update` (`v1/client.rs:99-169`); Cancellation = `session/cancel` + `$/cancel_request`/-32800 (`prompt-turn.mdx:312-345`, `cancellation.mdx:10-38`); Approval = `session/request_permission` with 4 kinds (`tool-calls.mdx:133-233`); Tool events = the tool_call lifecycle + rawInput/rawOutput (`tool-calls.mdx:14-131`); File changes = single-file oldText/newText diff + locations (`tool-calls.mdx:277-295`; v2 structured changes: `migration.mdx`); Terminal = the five client-side `terminal/*` methods (`terminals.mdx`); Background = no v1 protocol surface, v2 `state_update` + idle-time background updates (`acp-v2-draft.mdx`); Parallel = no explicit fan-out, only concurrent requests + background terminal + multiple sessions (`cancellation.mdx:40-68`); Compaction = unstable feature + RFD (`v1/client.rs:149-168`, `rfds/session-compaction.mdx`); Subagent = not found in the sources/docs (only `rfds/proxy-chains.mdx:402` and `rfds/session-fork.mdx:35` mention composition approaches); Usage = `usage_update` (context+cost, stable) while the per-turn token breakdown is Draft (`prompt-turn.mdx:190-213`, `rfds/end-turn-token-usage.mdx`); Reasoning = `agent_thought_chunk` (`v1/client.rs:104-105`); PTC = not found in the sources/docs.

---

## 13. Transport-layer verdict: does JSON-RPC-over-stdio pollute the data model?

**Basically no, and the isolation is clearly deliberate.** Arguments:

1. **The data model is transport-agnostic**: `transports.mdx:50` states plainly "The protocol is transport-agnostic"; the schema (`schema/v1/schema.json` and the Rust crate) describes only params/result, with no stdio/frame concepts anywhere; the JSON-RPC envelope is compressed into three thin types in `rpc.rs` (`Request`/`Notification`/`JsonRpcMessage`), and method names are a pure string-constant table (`meta.json`). Switching to HTTP/WebSocket leaves the message body unchanged (`rfds/streamable-http-websocket-transport.mdx`: "same JSON-RPC message format and ACP lifecycle as the existing stdio transport").
2. **NDJSON is the right trade-off**: JSON serialization escapes newlines by itself, so "MUST NOT contain embedded newlines" (`transports.mdx:24`) loses no expressiveness; in exchange, the agent can be driven directly with `head`/`grep`/`jq` and there is no LSP-style header state machine. The only cost: a single overlong line (large base64 images/audio) balloons the in-memory buffer — both the TS `LineBuffer` and Rust `Lines` must buffer partial lines; the appearance of fields like `outputByteLimit` shows the ecosystem has already felt the large-payload problem.
3. **Batch is a small crack of "SDK first, spec catches up"**: the v1 spec says messages are "individual JSON-RPC requests, notifications, or responses" (`transports.mdx:23`) and does not authorize batch; yet the rust-sdk's framing layer uniformly supports batch (`md/transport-architecture.md` "JSON-RPC Batch Behavior ... shared by the stable v1 and draft v2 APIs"); only the v2 spec formally brings batch into the fold and warns "do not batch lifecycle-sensitive messages" (`migration.mdx` Transports section). Lesson for ARI: **framing semantics must go into the v1 spec**, otherwise the SDK will make the decision for the spec.
4. **JSON-RPC-layer conventions have become an implicit protocol surface**: `$/cancel_request` and `-32800` (`protocol_level.rs:73`, `cancellation.mdx:22`) are LSP-style JSON-RPC conventions, located at the "protocol level" rather than in the ACP data model — this layering (protocol-level vs session-level methods) is itself clean.
5. **Version negotiation**: the `protocolVersion` integer (MAJOR-only) embedded in `initialize` + capability bits (omitted = unsupported) as a dual track (§2); the v2 draft keeps the same mechanism and requires "one version per connection" (`migration.mdx` Version negotiation). The integer-version + capability combination is enough for ARI, but ACP's declaration that "artifact versions (crate/schema) are decoupled from the wire version" (`README.md` Versioning) deserves a place on page one of the ARI spec — "the SDK version number is not the protocol version number" is the most common community misreading.

---

## 14. Method / notification reference tables (ACP v1 stable surface)

Method names follow the constants in `schema/v1/meta.json` and `v1/agent.rs:4753-4789`, `v1/client.rs:2689-2707`; directions: A = implemented by the agent (called by the client), C = implemented by the client (called by the agent), P = protocol-level, bidirectional.

### Client → Agent (agent-side methods)

| Method | Type | Params → Result | Capability gate | Evidence |
|---|---|---|---|---|
| `initialize` | Request | `{protocolVersion, clientCapabilities, clientInfo?}` → `{protocolVersion, agentCapabilities, agentInfo?, authMethods[]}` | none (baseline) | initialization.mdx:24-98; v1/agent.rs:4753 |
| `authenticate` | Request | `{methodId}` → `{}` | `authMethods` advertises a `type:"agent"` method | authentication.mdx:134-167; agent.rs:4755 |
| `logout` | Request | `{}` → `{}` | `agentCapabilities.auth.logout` | authentication.mdx:190-216; agent.rs:4789 |
| `session/new` | Request | `{cwd, mcpServers[], additionalDirectories?}` → `{sessionId, modes?, configOptions?}` | baseline; additionalDirectories requires a cap | session-setup.mdx:45-81,313-344 |
| `session/load` | Request | `{sessionId, cwd, mcpServers[]}` → `{}` (history replayed before the response) | `loadSession` | session-setup.mdx:83-188 |
| `session/resume` | Request | `{sessionId, cwd, mcpServers[]}` → `{}` (may attach mode/model/config) | `sessionCapabilities.resume` | session-setup.mdx:190-253 |
| `session/close` | Request | `{sessionId}` → `{}` | `sessionCapabilities.close` | session-setup.mdx:255-311 |
| `session/list` | Request | `{cwd?, cursor?}` → `{sessions[SessionInfo], nextCursor?}` | `sessionCapabilities.list` | session-list.mdx:66-176 |
| `session/delete` | Request | `{sessionId}` → `{}` | `sessionCapabilities.delete` | session-delete.mdx; agent.rs:4780 |
| `session/prompt` | Request | `{sessionId, prompt[ContentBlock]}` → `{stopReason}` | baseline | prompt-turn.mdx:57-98,292-311 |
| `session/set_mode` | Request | `{sessionId, modeId}` → `{modes?}` | none (deprecating) | session-modes.mdx:77-104; agent.rs:4770 |
| `session/set_config_option` | Request | `{sessionId, configId, value}` → `{configOptions[] full set}` | none (boolean type requires a client cap) | session-config-options.mdx:237-316 |
| `session/cancel` | Notification | `{sessionId}` | baseline | prompt-turn.mdx:312-345; agent.rs:4776 |

### Agent → Client (client-side methods/notifications)

| Method | Type | Params → Result | Capability gate | Evidence |
|---|---|---|---|---|
| `session/update` | Notification | `{sessionId, update{sessionUpdate: <tag>, ...}}` | baseline (tags in §5) | v1/client.rs:99-169,2689 |
| `session/request_permission` | Request | `{sessionId, toolCall:ToolCallUpdate, options[]}` → `{outcome}` | baseline method | tool-calls.mdx:133-233; client.rs:968 |
| `fs/read_text_file` | Request | `{sessionId, path, line?, limit?}` → `{content}` | `fs.readTextFile` | file-system.mdx:31-75; client.rs:2695 |
| `fs/write_text_file` | Request | `{sessionId, path, content}` → `{}` | `fs.writeTextFile` | file-system.mdx:77-117 |
| `terminal/create` | Request | `{sessionId, command, args?, env?, cwd?, outputByteLimit?}` → `{terminalId}` | `terminal` | terminals.mdx:28-111 |
| `terminal/output` | Request | `{sessionId, terminalId}` → `{output, truncated, exitStatus?}` | `terminal` | terminals.mdx:142-190 |
| `terminal/wait_for_exit` | Request | `{sessionId, terminalId}` → `{exitCode?, signal?}` | `terminal` | terminals.mdx:191-227 |
| `terminal/kill` | Request | `{sessionId, terminalId}` → `{}` | `terminal` | terminals.mdx:229-249 |
| `terminal/release` | Request | `{sessionId, terminalId}` → `{}` | `terminal` | terminals.mdx:264-282 |
| `elicitation/create` | Request | `{sessionId|requestId, mode:"form"|"url", message, requestedSchema?/elicitationId+url}` → `{action: accept/decline/cancel, content?}` | `elicitation.form/url` | elicitation.mdx:57-167 |
| `elicitation/complete` | Notification | `{sessionId?, elicitationId}` | URL mode | elicitation.mdx:155-167 |

### Protocol-level (bidirectional)

| Method | Type | Params | Semantics | Evidence |
|---|---|---|---|---|
| `$/cancel_request` | Notification | `{requestId}` | request-level cancellation; response `-32800` | protocol_level.rs:73-106; cancellation.mdx:10-38 |

### `session/update` variant quick reference (v1 stable + unstable)

`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update`; unstable: `plan_update`, `plan_removed`, `notice`, `compaction_update`, `compaction_summary_chunk` (`v1/client.rs:99-169`).

---

## 15. Conclusion (three sentences for ARI)

1. ACP proves that "a thin protocol + bidirectional JSON-RPC + NDJSON stdio + capability negotiation + `_meta` extensions" is enough to sustain an ecosystem spanning 40+ agents and hundreds of clients; ARI's session/streaming/approval layers can copy its shapes nearly verbatim (especially permission options, the tool_call state machine, upsert patch semantics, and cancelled≠error).
2. ACP's two self-corrections — v2 deleting the client execution surface (fs/terminal), and v2 decoupling the turn from the prompt response (`state_update`) — are ARI's starting point, not its end state: **ARI targets "Shell ↔ Runtime" decoupling and must be designed in the v2 shape from day one** (a self-standing event stream, input submission separated from work state, client resources exposed via a tool manifest), while adding the protocol surfaces ACP lacks: background tasks, concurrency orchestration, per-turn usage, compaction, and subagents.
3. Versioning and transport discipline: integer MAJOR `protocolVersion` + capability bits + artifact versions decoupled from the wire version (copy); NDJSON-over-stdio and the stdout purity rule (copy); framing/batch semantics must be written into the first version of the spec (learning from ACP's batch crack).
