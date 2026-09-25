# 04 · OpenCode source-level survey — ARI design reference

- Subject: OpenCode v1.18.32 (origin: github.com/anomalyco/opencode, fork of sst/opencode; local repo `opencode/`, not committed to this repository)
- Method: entirely based on reading the local source (grep/glob/read); unmarked statements are [source]; citation format `file path + symbol name`.
- Key overview: at v1.18.32 OpenCode is no longer the earlier single-package shape of "JSON file storage + Hono server + Bus events" but a monorepo:
  - `packages/schema` — browser-safe wire/storage contracts (Effect Schema), event manifest `EventManifest`;
  - `packages/protocol` — the current `/api/...` protocol surface (endpoint definitions + middleware);
  - `packages/core` — the Effect-based domain core (V2 runtime, drizzle SQLite schema);
  - `packages/opencode` — the instance runtime (session/agent/tool/permission/…), exposing an Effect HttpApi server;
  - `packages/sdk/js` — the generated JS client SDK; `packages/sdk-next` is the next-generation SDK.
  - Naming convention (see `packages/schema/AGENTS.md`): current contracts carry no version suffix (`Session`, `Permission`), legacy contracts are marked `V1` (`SessionV1`, `PermissionV1`); `message.updated` / `message.part.*` are V1-only compatibility events.
  - In this document "legacy/V1" refers to the session runtime still running live in `packages/opencode`, and "V2/current" refers to the new runtime in `packages/core` together with the `session.next.*` event surface. Both coexist at v1.18.32 and are bridged.

## 1. Architecture overview (server-based; runtime core; how clients drive it)

v1.18.32 is a pnpm/bun monorepo, layered (dependency direction declared in `opencode/AGENTS.md`): `packages/schema` (wire/storage contracts defined with Effect Schema + `EventManifest` event manifest) ← `packages/protocol` (`/api/...` endpoint definitions, `protocol/src/groups/*`) ← `packages/core` (Effect-based domain core: SQLite/drizzle storage, EventV2, SessionRunner V2) ← `packages/opencode` (instance runtime: session/agent/tool/permission/server). Clients: `packages/sdk/js` (generated JS client, `sdk/js/src/client.ts`+`gen/`), `packages/sdk-next` (new SDK composing Client+Core+Server), and the TUI/App/CLI (`packages/tui` etc.) all connect to the local server as HTTP clients.

- Server: `opencode/src/server/server.ts` — node:http + Effect HttpApi (`HttpApiApp`), including `MDNS` (LAN discovery), `WebSocketTracker`, and OpenAPI export. One instance per project directory; events are isolated by directory/workspace.
- Two protocol surfaces coexist: the current `/api/...` (`packages/protocol/src/groups/`) and the legacy compatibility surface (`opencode/src/server/routes/instance/httpapi/groups/`, serving the App/TUI/CLI, including V1-only events such as `message.updated`; see the event classification rules in `packages/schema/AGENTS.md`).
- The runtime core is dual-track: the legacy V1 loop = `packages/opencode/src/session/prompt.ts` `SessionPrompt.loop`; V2 = `packages/core/src/session/runner/` + `SessionV2.prompt` (durable `session_input` table + `SessionExecution.wake`; see the V2 Session Core rules in `opencode/AGENTS.md`). At v1.18.32 the two are bridged (`opencode/src/event-v2-bridge.ts`).
- How clients drive it: REST (`POST /api/session/:id/prompt` etc.) plus a single SSE stream `GET /api/event` subscribing to all events; there is no client-side RPC callback channel — the client is a passive observer + active POSTer (except for permission/question/reply).

## 2. Message model: all Session / Message / Part types + tool state machine + bus event names

The contracts live in `packages/schema/src/v1/session.ts` (the V1 namespace, still the live runtime contract; for current contracts see `session-message.ts`).

- `SessionInfo` (session.ts:543): `id, slug, projectID, workspaceID?, directory, parentID?, title, version, share{url}?, revert?{messageID, partID, snapshot, diff}, permission?`, `time{created, updated, compacting?, archived?}`, `cost, tokens, summary{additions, deletions, files, diffs}`.
- `Message = User | Assistant` (role discriminant, session.ts:490). `User` (session.ts:332): `time.created, format?, summary?{title, body, diffs}, agent, model{providerID, modelID, variant?}, system?, tools?`. `Assistant` (session.ts:453): `time{created, completed?}, error?(AuthError|UnknownError|OutputLengthError|AbortedError|StructuredOutputError|ContextOverflowError|ContentFilterError|APIError, session.ts:385), parentID, modelID, providerID, mode, agent, path{cwd, root}, cost, tokens{input, output, reasoning, cache{read, write}}, structured?, finish?`.
- The `Part` union has 12 variants (session.ts:357-370, common base `{id: prt_*, sessionID, messageID}`):
  1. `text` (session.ts:102): `text, synthetic?, ignored?, time{start, end?}, metadata?`
  2. `reasoning` (session.ts:118): `text, metadata?, time`
  3. `file` (session.ts:171): `mime, filename?, url, source?` (FilePartSource = file|symbol|resource, with text value+range)
  4. `agent` (session.ts:181): `name, source?` — the user @-switches the agent inside the prompt
  5. `subtask` (session.ts:204): `prompt, description, agent, model?, command?`
  6. `tool` (session.ts:315): `callID, tool, state: ToolState`
  7. `step-start` (session.ts:233): `snapshot?`
  8. `step-finish` (session.ts:240): `reason, cost, tokens{...}, snapshot?`
  9. `snapshot` (session.ts:87): `snapshot: string`
  10. `patch` (session.ts:94): `hash, files[]`
  11. `retry` (session.ts:220): `attempt, error: APIError, time.created`
  12. `compaction` (session.ts:195): `auto, overflow?, tail_start_id?`
- Tool state machine (session.ts:259-322, discriminated by `status`): `pending{input, raw}` → `running{input, title?, metadata?, time.start}` → `completed{output, title, metadata, time{start, end, compacted?}, attachments?: FilePart[]}` | `error{error, metadata?, time{start, end}}`. There is no cancelled state — abort is folded into error.
- Event names (each schema module's `Event.define`): session: `session.created/updated/deleted, message.updated, message.removed, message.part.updated, message.part.removed, message.part.delta{field, delta}, session.diff, session.error` (session.ts:571-676); status: `session.status, session.idle` (`schema/src/session-status-event.ts`); compaction: `session.compacted`; the full V2 runtime set `session.next.*` (step/text/reasoning/tool.input/tool.called/progress/success/failed/retried/compaction/revert/shell, `schema/src/session-event.ts:55-442`); permissions: `permission.asked/replied` (`schema/src/v1/permission.ts:61-63`) + `permission.v2.asked/replied`; questions: `question.asked/replied/rejected` (+v2); files: `file.edited` (`filesystem.ts:9`), `file.watcher.updated` (`filesystem-watcher.ts:7`); terminals: `pty.created/updated/exited/deleted`; others: `todo.updated, server.connected, server.heartbeat, global.disposed, server.instance.disposed, command.executed, mcp.tools.changed, lsp.updated, installation.*, vcs.branch.updated, workspace.*/worktree.*`. Note: what the task description calls "PermissionUpdated/FileChanged" is actually named `permission.asked` / `file.edited`+`file.watcher.updated`.
- Bus: the old `Bus` pattern has converged into `GlobalBus` (`opencode/src/bus/global.ts`, an EventEmitter that auto-assigns an incrementing `evt_` id on emit) + core `EventV2` (durable, routed by location; `opencode/src/event-v2-bridge.ts` is the publish boundary).

## 3. Session: creation / resume / IDs / persistence / multi-client / interrupt / fork / share

- Creation: `Session.create` (opencode/src/session/session.ts); `plan()` (session.ts:331) computes the path from slug+time; `ForkInput` (session.ts:273). ID format: `{prefix}_{time-sortable base62}{12 random}` (`schema/src/identifier.ts` `create`); prefix table: `session:ses, message:msg, part:prt, permission:per, question:que, pty, tool, workspace:wrk, job, event:evt` (`core/src/id/id.ts:5-16`).
- Persistence: migrated from "one JSON file per message" to SQLite/drizzle (`core/src/session/sql.ts`): seven tables — `session, message(data JSON), part(data JSON), todo, session_message, session_input, session_context_epoch`; `opencode/src/storage/storage.ts` retains the migration logic from the old `storage/session/message/*/*.json` layout. Message/Part are stored wholesale as JSON `data` columns (not one file per part).
- resume/continue: there is no explicit resume action — sessions persist in the DB; sending another prompt to the same sessionID continues the conversation; `GET /api/session` lists them (latest 50 by default, cursor pagination, protocol/groups/session.ts:109).
- Multi-client: the server dispatches statelessly; N clients can hold SSE + read REST simultaneously; concurrent prompts on the same session are merged into a single runner via `SessionRunState.ensureRunning` (opencode/src/session/run-state.ts:88-94); conflicting operations (shell) return `BusyError` (run-state.ts:96-105, `assertNotBusy`:71).
- Interrupt/abort: `POST /api/session/:id/interrupt` (protocol session.ts:345) → `SessionRunState.cancel` (run-state.ts:77-86) → runner.cancel + cascading cancel of that session's BackgroundJob (run-state.ts:111-129); the processor's `onInterrupt` finalizes the assistant message as `AbortedError` (prompt.ts:1203-1211, processor.ts:662-669).
- fork: `Session.fork(sessionID, messageID?)` (session.ts:691) copies messages into a new session and appends ` (fork #N)` to the title (session.ts:162-168).
- revert/undo: `SessionRevert.revert/unrevert` (session/revert.ts:38-96) restores from snapshots + rolls back patches; protocol endpoints `session.revert.stage/clear/commit` (protocol/groups/session.ts:256-281).
- share: `SessionInfo.share{url}` (v1/session.ts:526-528); sync implemented in `opencode/src/share/share.ts`+`share-next.ts` (details not verified in depth).

## 4. Agent loop: prompt → LLM stream → tool calls → looping / parallelism / interrupt / retry / budget

Control flow (legacy V1, all in `opencode/src/session/prompt.ts`):
1. Entry: `POST /api/session/:sessionID/prompt` (protocol/groups/session.ts:205) → `SessionPrompt.loop` (prompt.ts:1343) → `state.ensureRunning(sessionID, lastAssistant, runLoop)`.
2. `runLoop` (prompt.ts:1082) `while(true)`: `status.set(busy)`; `MessageV2.filterCompactedEffect` loads messages from SQLite; `MessageV2.latest` reads lastUser/lastAssistant/finished/task queue.
3. Exit condition (prompt.ts:1111-1130): `lastAssistant.finish` exists and is not `tool-calls/unknown`, there is no unfinished tool call (`hasToolCalls`, ignoring interrupted orphan tools, prompt.ts:1106-1109), and `parentID === lastUser.id` → break.
4. `step++`; on step 1 it forks two background tasks: `ensureTitle` (prompt.ts:1133-1139) and `summary.summarize` (prompt.ts:1252-1253).
5. Task queue: `task.type === "subtask"` → `handleSubtask` then continue (prompt.ts:1144-1147); `"compaction"` → `compaction.process` then continue (1149-1159).
6. Automatic compaction: `compaction.isOverflow(lastFinished.tokens)` → `compaction.create({auto: true})` → continue (1161-1168).
7. `agent.steps ?? Infinity` is maxSteps; on `isLastStep` a `MAX_STEPS_PROMPT` assistant message is injected toward the model (prompt.ts:1178-1179, 1281).
8. `processor.create({assistantMessage, sessionID, model})` yields a handle (prompt.ts:1213); `SessionTools.resolve` assembles the tool table (merging plugin/Permission/ToolRegistry/MCP/Truncate, prompt.ts:1226-1241); for `json_schema` output it injects the `StructuredOutput` tool + `toolChoice: required` (1243-1250, 1285).
9. system = `sys.environment` + `instruction.system()` (AGENTS.md) + `sys.mcp` + `sys.skills` (prompt.ts:1257-1269); `MessageV2.toModelMessagesEffect` translates V1 messages into provider format.
10. `handle.process(...)`: `llm.stream(streamInput)` is called exactly once per provider turn (processor.ts:654); streaming events drive part creation/updates; `Stream.takeUntil(() => ctx.needsCompaction)` truncates the stream (processor.ts:656-660).
- Parallel tool calls: multiple tool calls in the same assistant message execute concurrently via ai-sdk; the processor maintains a `ctx.toolcalls` map keyed by `toolCallID` (processor.ts:123-203 `settleToolCall/readToolCall/completeToolCall/failToolCall`); no forced-serialization switch was found in the source.
- Retry: `Effect.retry(SessionRetry.policy({provider, parse, set: status.set({type:"retry", attempt, ...})}))` (processor.ts:674-688), emitting a `session.status` retry + `RetryPart`; `session.next.retried` is the V2 counterpart event.
- Tool failure: `failToolCall` sets the tool part to `error` state (processor.ts:186-203) and the output is fed back to the model; `experimental.continue_loop_on_deny` decides whether the loop keeps running after a permission denial (processor.ts:647).
- Interrupt: fiber interrupt → `aborted` marker + `AbortedError` written onto the assistant message (processor.ts:662-669).
- Timeouts: no global timeout for LLM turns was found in the source; at the tool level shell has `input.timeout` (see §8).
- Token budget: no global budget; per-model `maxOutputTokens` (session/llm.ts:238); the context ceiling is backstopped by compaction (§9).
- Structured output: after `handle.message.structured` is written back, break (prompt.ts:1288-1293).
- Wrap-up: `compaction.prune` is forked to clean up old tool outputs (prompt.ts:1338); the final `lastAssistant` is returned.

## 5. Tool runtime: the Tool.define abstraction / builtin tool roster / callID / streaming output / cancellation / permission gate

- `Tool.define`/`Def` (opencode/src/tool/tool.ts:55-65): `{id, description, parameters: Effect Schema, jsonSchema?, execute(args, ctx) → ExecuteResult}`. `Context` (tool.ts:36-46): `{sessionID, messageID, agent, abort: AbortSignal, callID?, extra?, messages, metadata({title, metadata}) → emits a part update, ask(permission request)}`. `ExecuteResult` (tool.ts:48-53): `{title, metadata, output: string, attachments?: FilePart[]}`.
- `wrap` (tool.ts:99-148): argument decode failure → `InvalidArgumentsError`; after execution everything funnels through `Truncate.output` truncation, writing `metadata.truncated + outputPath` (tool.ts:131-144); all wrapped in `Effect.withSpan("Tool.execute")`.
- Builtin registry (tool/registry.ts:209-252): `invalid, question, shell, read, glob, grep, edit, write, task, fetch(webfetch), todo, search(websearch), skill, patch(apply_patch)` + conditional `execute` (code-mode, experimental), `lsp` (experimentalLspTool), `plan` (experimentalPlanMode+CLI). Note the bash tool is named `shell`. Plugin-defined tools go through `fromPlugin` (registry.ts:136-202, a Zod argument compatibility layer, likewise truncated + spanned); MCP tools go through `ToolRegistry.tools` + `Permission.visibleTools` (registry.ts:286).
- callID: `ToolPart.callID` is the provider-returned tool call id (v1/session.ts:318); state transitions are settled by the processor keyed on callID.
- Streaming output: during execution the tool calls `ctx.metadata({title, metadata})` at any time to update the tool part incrementally → pushed to clients as `message.part.updated` (e.g. shell updates `metadata.output` per chunk, tool/shell.ts:515-528); there is no separate "tool output delta" event — clients perceive progress via full part resends.
- Result encoding: the `output` string lands in `ToolStateCompleted.output` for the LLM (`message-v2.ts:320-357` converts it into a `tool-{name}` content block); `metadata`/`attachments` are primarily for clients; when truncated the LLM gets the truncated text + an outputPath hint.
- Permission gate: inside `SessionTools.resolve`, `ask: req → permission.ask({..., ruleset: Permission.merge(agent.permission, session.permission)})` (session/tools.ts:81-87); tools themselves call `ctx.ask` on demand (e.g. shell/MCP read patterns, tools.ts:180-184); plugin hooks `tool.execute.before/after` (tools.ts:107-121).
- Cancellation: the `ctx.abort` AbortSignal threads through everything (tool.ts:40); shell races on it (§8).
- Client visibility: the client receives the full `ToolPart` (including state.input, metadata, output); inside the runtime only plugin span/attributes and `extra` (e.g. `promptOps`) do not leak out.

## 6. Permission / approval: config / request / reply / modes

- Rule model: a ruleset = `{permission, pattern, action: "allow"|"ask"|"deny"}` with wildcard matching; two source layers: agent config `agent.permission` + session-level `session.permission` (`Permission.merge`, session/tools.ts:81-87); subagents additionally derive one via `agent/subagent-permissions.ts` `deriveSubagentSessionPermission`.
- `Permission.ask` (opencode/src/permission/index.ts:67-107): `evaluate` pattern by pattern → on `deny` fail immediately with `DeniedError` (carrying the ruleset for client rendering); if all `allow`, pass through; otherwise create `PermissionV1.Request{id: per_*, sessionID, permission, patterns, metadata, always, tool}`, store it in a pending map + `Deferred`, publish `permission.asked`, and block awaiting the Deferred.
- Reply: `POST /api/session/:sid/permission/:rid/reply` (protocol/groups/permission.ts `session.permission.reply`) with `reply: "once"|"always"|"reject"` (index.ts:109-167): `once` → only succeed the Deferred; `always` → append the `always` patterns to the approved list (equivalent to a persistent in-session rule) and automatically approve other pending requests on the same session that now evaluate to allow (reply event `always`); `reject` → fail the Deferred (`RejectedError`, or `CorrectedError` carrying user feedback, index.ts:121-127) and cascade-reject the remaining pending requests on the same session.
- How the client knows it should wait: the `permission.asked` event (SSE) / the `GET /api/permission/request` and `GET /api/session/:sid/permission` lists / a single lookup via `session.permission.get`; after replying, the `permission.replied` event closes it out.
- There is no global "permission mode" switch (not a plan/read-only-mode style design); modes are defined by the agent (e.g. the `plan` agent has restricted tools, agent/agent.ts:157). A similar human-in-the-loop exists as the question tool (`question.asked/replied/rejected` + `/api/question/*`).

## 7. File / diff: file watchers / patch parts / snapshot-undo / revert / git

- File events: `file.edited` (schema/src/filesystem.ts:9, emitted when the runtime writes files) and `file.watcher.updated` (filesystem-watcher.ts:7, watcher for external changes) are two distinct structured events; the client can also observe the disk directly (open-file REST: `fs.read/list/find`, protocol/groups/fs.ts). "FileChanged" from the task description corresponds to these two events.
- patch/snapshot parts: in the message stream, a `snapshot` part (snapshot hash, v1/session.ts:87) and a `patch` part (`{hash, files[]}`, session.ts:94) mark each file change; the session-level diff summary rides in the `session.diff` event + `SessionInfo.summary.diffs` (FileDiff.Info).
- Snapshot implementation: `opencode/src/snapshot/index.ts` — shadow tracking built on git plumbing (`Snapshot.state/track/restore/revert/diff/stage`, `Patch{hash, files}`; skipped via the `enabled` check when git is disabled).
- revert/undo: `SessionRevert.revert({sessionID, messageID, partID?})` (session/revert.ts:38-88) records/reuses `rev.snapshot` (`snap.track()`), rolls files back with `snap.revert(patches)`, and produces `rev.diff`; `unrevert` (revert.ts:91-96) restores via `snap.restore`; protocol endpoints `session.revert.stage/clear/commit` (protocol/groups/session.ts:256-281) provide a two-phase "staged → commit" flow.
- Git integration: `core/src/git.ts` + the `worktree/` module (worktree.ready/failed events); session summaries tally additions/deletions/files.

## 8. Command / terminal: bash output streaming / exit codes / background processes / PTY

- shell tool (`tool/shell.ts` `ShellTool`): `ChildProcessSpawner.spawn` (shell.ts:484) starts the process; `handle.all` (stdout+stderr merged) is consumed as a stream (shell.ts:487-528): each chunk updates a rolling keep buffer + `ctx.metadata({metadata: {output: lastPreview}})` → incremental tool part updates → the client sees output live; beyond `limits.maxBytes` output spills to a file (`trunc.write`, shell.ts:505-514) with the outputPath carried in metadata.
- Exit code: `Effect.raceAll([handle.exitCode → {kind:"exit", code}, abort → {kind:"abort"}, timeout])` (shell.ts:531-545); the timeout threshold is `input.timeout + 100ms`; the result metadata records exit/abort/timeout (shell.ts:583-590 additionally appends `<shell_metadata>` at the tail of output).
- Cancellation: a `ctx.abort` listener (shell.ts:520-529).
- Background processes: the `BackgroundJob` service (`opencode/src/background/job.ts`, core `background-job.ts`); interrupting a session cascade-cancels its related jobs (session/run-state.ts:111-129); subagent background mode also goes through it (task.ts:97-100). "background bash" from the task description manifests in this version mainly as background subagents + pty; a standalone "run_in_background" bash parameter was not found in the source.
- PTY: full interactive terminals as first-class citizens: schema events `pty.created/updated/exited/deleted`; REST `pty.list/create/get/update/remove/connect-token/connect` (protocol/groups/pty.ts); `connect` is authorized by token (the connection is a WebSocket/websocket-tracker, server/routes/instance/httpapi/websocket-tracker.ts).
- LSP: the `lsp.updated` event + an experimental `lsp` tool.

## 9. Context management: system prompt / AGENTS.md / compaction / truncation

- System prompt assembly (prompt.ts:1257-1271): `sys.environment(model)` (environment info) + `instruction.system()` (AGENTS.md/rule files, `session/instruction.ts`) + `sys.mcp` (MCP notes) + `sys.skills`; agent templates live in `agent/prompt/` (agent/agent.ts ships six built-in presets: build/plan/general/explore/compaction/title/summary); additionally `SessionReminders.apply` injects reminders (prompt.ts:1180-1184).
- Compaction triggers: (a) `isOverflow`: the previous turn's `tokens.total (or the sum of the four fields) >= usable`, where `usable = model.limit.input − reserved` or `context − maxOutputTokens`, `reserved = cfg.compaction.reserved ?? min(COMPACTION_BUFFER, maxOutputTokens)` (session/overflow.ts:10-37); `compaction.auto === false` turns this off (overflow.ts:30). (b) `needsCompaction` fires mid-LLM-stream → `Stream.takeUntil` interrupts the turn, the processor returns `"compact"` (processor.ts:646-658, 693), and the loop calls `compaction.create({auto: true, overflow})` (prompt.ts:1320-1327). Manual: `POST /api/session/:id/compact` (protocol/groups/session.ts:226).
- Compaction execution: marked by `CompactionPart{auto, overflow?, tail_start_id?}`; `compaction.select` retains the tail within a `cfg.compaction.tail_turns` budget (compaction.ts:223-267); a dedicated `compaction` agent performs the summary (agent/agent.ts:220). Client-visible: the `session.compacted` event (schema/src/session-compaction-event.ts:7) + `SessionInfo.time.compacting` + the CompactionPart in the message stream.
- History pruning: `compaction.prune` (compaction.ts:273-302) is forked at the end of each turn; threshold constants `PRUNE_MINIMUM = 20_000` / `PRUNE_PROTECT = 40_000` (compaction.ts:28-29); requires `cfg.compaction.prune` to be enabled.
- Tool output truncation: every `Tool.define` wrap funnels uniformly through `Truncate.output` (tool/tool.ts:131-144, `tool/truncate.ts`); after truncation the LLM gets the truncated text + an `outputPath` pointing at the on-disk file; shell additionally spills output to a file (§8). Configurable at agent granularity (passed in via `agents.get(ctx.agent)`).
- Token accounting: the Assistant message accumulates `tokens{input, output, reasoning, cache{read, write}}` + `cost` (v1/session.ts:471-481), with the step-finish part recording it step by step (session.ts:240-257).

## 10. Subagents: task tool / agent types / session relationships / event forwarding

- The `task` tool (`tool/task.ts`): parameters `{prompt, description, subagent_type, task_id? (resumes a previous subagent session, task.ts:49), background?}`; builtin agent types (`agent/agent.ts:142-251`): `build` (default), `plan`, `general`, `explore`, plus the internal `compaction/title/summary`. The task tool's dynamic description is generated from the agent list filtered through `Permission.evaluate("task", name)` (tool/registry.ts:265-278).
- Session relationship: each call does `sessions.create({parentID: ctx.sessionID, title: "<desc> (@<agent> subagent)", agent, permission: derived ruleset})` (task.ts:154-167) — the child session is a real Session; parent and child are linked by `parentID`; nesting depth cap `cfg.subagent_depth ?? 1` (task.ts:107-114).
- Execution: `ctx.extra.promptOps.prompt(...)` runs the full loop on the child session (task.ts:195-204); by default it blocks until the subagent finishes and returns the last text part; a subagent failure (assistant error or tool error part) throws `Subagent failed (task_id: ...)` upward (task.ts:205-213).
- Background mode: `background: true` requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (task.ts:97-100); it returns immediately, and on completion the result is injected into the parent session as a `synthetic` text part prompt (task.ts:230-250), with a `BackgroundJob` fallback notification.
- Parallelism: multiple task calls run in parallel alongside concurrent tool calls; or are pushed to background.
- Event forwarding: there is no explicit forwarding mechanism — the client obtains the child sessionID from the tool part's `metadata{parentSessionId, sessionId, model, background?}` (task.ts:171-177) and subscribes to its events itself (this is exactly what the TUI/CLI do: `cli/cmd/run/subagent-data.ts`, `stream.transport.ts:897` `listSubagentTabs`).
- Cleanup: interrupting the parent session cascade-cancels the child sessions' background jobs (run-state.ts:118-124, matched by sessionId/parentSessionId).

## 11. Streaming & transport: SSE /event event shape / token delta / idle semantics / SDK

- SSE: `GET /api/event` (protocol/src/groups/event.ts `event.subscribe`; implemented in `opencode/src/server/routes/instance/httpapi/handlers/event.ts`): `text/event-stream`; each data line is JSON `{id: evt_*, type, properties}` (`eventData`, event.ts:11-17); `server.connected` is sent on connect, `server.heartbeat` every 10s (event.ts:60-63); the server filters by instance directory + workspaceID (event.ts:38-41); `server.instance.disposed` terminates the stream (event.ts:44-56); the listener is registered before the body is built to avoid losing events (event.ts:26-28 comment).
- Token delta: `message.part.delta{sessionID, messageID, partID, field, delta}` (v1/session.ts:632-641) — text/reasoning deltas are appended per field; full part snapshots go via `message.part.updated`. These belong to the V1-only compatibility event surface (schema/AGENTS.md); the V2 counterparts are `session.next.text.delta` / `session.next.reasoning.delta` / `session.next.tool.input.delta` (session-event.ts:211, 249, 293).
- Completion signals: the `session.status` event + an extra `session.idle` when the status turns idle (session/status.ts:41-43); the client can alternatively `POST /api/session/:id/wait` to block until done (protocol/groups/session.ts:241).
- REST endpoints (protocol/src/groups/): session (list/create/get/prompt/compact/wait/revert.stage|clear|commit/context/history/event/message/interrupt/switchAgent/switchModel/active), permission (request.list, saved.list/remove, session.permission.create/list/get/reply), question (list/reply/reject), pty (6+connect), fs (read/list/find), agent/command/model/provider/skill listings, event (subscribe), health, location/project, etc.
- SDK: `packages/sdk/js` (generated client, `src/client.ts` + `gen/`, regenerated via `./packages/sdk/js/script/build.ts`); `packages/sdk-next` is the next generation (composing Client+Core+Server, opencode/AGENTS.md); additionally `sdk/js/src/process.ts` handles spawning/discovering the local server process.
- Multi-directory/multi-instance: one instance per directory, events routed by directory (`event-v2-bridge.ts` injects location), `server.instance.disposed` notifies of instance disposal; MDNS LAN broadcast (server/mdns.ts).

## 12. PTC (programmatic tool calling)

- An experimental implementation exists: `tool/code-mode.ts` — `CODE_MODE_TOOL = "execute"`, "Run a confined orchestration script with access to connected MCP tools"; the model submits a `code` string, which invokes MCP tools programmatically inside a confined interpreter (the `@opencode-ai/codemode` sandbox); results are validated against the MCP `CallToolResult` schema, and toolCalls progress lands in metadata (`CallEntry{tool, status: running|completed|error}`).
- Switch: `flags.experimentalCodeMode` (tool/registry.ts:122-123, 226); currently it covers only the MCP tool surface, not builtin tools. Verdict: PTC = partial (experimental, MCP-only).

## 13. Capability matrix

| Capability | OpenCode | Evidence |
|---|---|---|
| Session | ✓ (SQLite-persistent, ses_ IDs, multiple sessions in parallel) | core/src/session/sql.ts; session/session.ts |
| Resume | ✓ (persistent sessions continue by sending another prompt; fork/unrevert also available) | protocol/groups/session.ts:109; session.ts:691 |
| Streaming | ✓ (SSE /event + token-level message.part.delta) | handlers/event.ts; v1/session.ts:632 |
| Cancellation | ✓ (interrupt endpoint → runner cancel + cascaded bg jobs; tool ctx.abort) | run-state.ts:77; protocol:345 |
| Approval | ✓ (permission.asked/replied, once/always/reject+feedback, persistent in-session always rules) | permission/index.ts:67-167 |
| Tool events | ✓ (tool part state machine + part.updated; V2 session.next.tool.*) | v1/session.ts:259-322 |
| File changes | ✓ (file.edited/file.watcher.updated + patch/snapshot parts + session.diff) | filesystem.ts; v1/session.ts:87-100 |
| Terminal | ✓ (PTY first-class: /api/pty + pty.* events + connect token) | protocol/groups/pty.ts |
| Background task | partial (BackgroundJob + background subagents behind an experimental flag; no native background bash parameter) | task.ts:97; run-state.ts:111 |
| Parallel tools | ✓ (concurrent ai-sdk tool calls settled by callID; parallel tasks) | processor.ts:123-203 |
| Compaction | ✓ (auto overflow trigger + manual compact endpoint + prune; client-visible) | overflow.ts; compaction.ts |
| Subagent | ✓ (task tool, real child sessions linked via parentID, depth limit) | tool/task.ts |
| Usage | ✓ (Assistant.tokens/cost accumulated per step-finish; SessionInfo.tokens) | v1/session.ts:240-257, 471-481 |
| Reasoning events | ✓ (reasoning part + message.part.delta; V2 reasoning.delta) | v1/session.ts:118; session-event.ts:249 |
| PTC | partial (experimental code-mode `execute`, MCP tools only) | tool/code-mode.ts |

## 14. "What the shell must see" vs runtime internals

- The shell (client) must see: all Part types and the tool state machine — state transitions are delivered by the runtime pushing part snapshots (`message.part.updated`); the shell does not need to understand the LLM protocol.
- Must see: token-level deltas ride `message.part.delta{field, delta}` — the shell stitches them itself; part updates are idempotent snapshots, deltas are merely an optimization.
- Must see: `session.idle` is the authoritative signal that a turn has ended (status.ts:41-43); `session.status` is the in-progress signal for busy/retry/compact.
- Must see: waiting on permission means that once `permission.asked` arrives the client must reply (`once/always/reject`), otherwise the runtime's Deferred hangs forever; reject can carry feedback text straight back to the model.
- Must see: a tool's intermediate output lives in `ToolStateRunning.metadata` (e.g. shell `metadata.output`), final output in `ToolStateCompleted.output/metadata/attachments`; a shell that wants to display progress must watch parts rather than wait for completion.
- Must see: subagents are associated via the tool part's `metadata.sessionId`; the client must subscribe to the child session's events itself — the runtime does not forward child events onto the parent stream.
- Must see: file changes have two channels — structured events (`file.edited`/`file.watcher.updated` + patch parts) and disk observation; the patch part is the authoritative record of a change.
- Runtime internals: LLM adaptation (`session/llm.ts` ai-sdk streaming), provider retry (`SessionRetry.policy`), prompt/AGENTS.md assembly, and `MessageV2.toModelMessagesEffect` context translation — all server-side, invisible and unconfigurable from the shell (apart from agent/model parameters).
- Runtime internals: the SQLite storage layout (JSON data columns for message/part) is an implementation detail; the contract is the wire types of the schema package — the shell must not read the DB directly.
- Runtime internals: compaction's tail_turns/PRUNE thresholds and summary generation are entirely server-side; the shell only receives `session.compacted` + CompactionPart, and once history is pruned `MessageV2.filterCompactedEffect` has already filtered it — the shell needs no awareness.
- Runtime internals: the snapshot shadow git (snapshot/index.ts) and the revert stage/commit two-phase flow are server-side file rollback machinery; the shell only consumes the diffs of revert events for display.
- Runtime internals: tool argument decode failures (`InvalidArgumentsError`), truncation (`metadata.truncated`/`outputPath`), and plugin before/after hooks are transparent to the shell — they surface as ordinary tool error/completed parts.
- Runtime internals: the dual runtime (V1 loop / V2 runner) and the event bridge are migration-period implementation details; a shell relying only on the V1 compatibility events (`message.*`, `permission.asked`) stays transparent across both.
- Boundary verdict: OpenCode's shell contract ≈ "REST commands + an SSE event log + a small set of write-back endpoints (permission/question/reply/interrupt/pty)" — no client tool callbacks, no guarantee of token-by-token push to the client (delta events are best-effort), and no mechanism for the server to wait on shell rendering.
