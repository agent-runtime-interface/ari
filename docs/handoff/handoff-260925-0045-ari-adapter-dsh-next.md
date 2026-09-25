# ARI Handoff — the DSH adapter is done

> For the **next AI agent** taking over. You have no access to the previous session — only this document and the one it references.
> Written: 2026-09-25 00:45 · Working directory: the repository root (per AGENTS.md, handoffs never carry local absolute paths).
> **Read first**: [handoff-260924-2311-ari-adapters-next.md](handoff-260924-2311-ari-adapters-next.md) — this file records only the **delta**; all background, hard constraints, naming decisions, and the pitfall list live there.

---

## 0. Thirty-second overview

**`packages/adapter-dsh` is done** — ARI's first adapter layer: it speaks ARI to the shell (server role) and the DeepSeek Harness SDK JSON-RPC wire protocol to the runtime (client role).

- **78 tests green** (54 before + 24 in the adapter)
- **Conformance against the adapter: 18 passed / 0 failed / 6 skipped** — every SKIP exists because the DSH wire genuinely has no such channel (approvals / questions / replay), which is exactly what the capability declaration states
- `npm run conformance:dsh` re-runs it in one command
- **The shell, the protocol library, and the conformance suite are unchanged** — the first empirical proof of ARI's core claim

## 1. What was built

```
packages/adapter-dsh/
  src/translate.ts   pure mapping layer: capability table, TurnEndReason→StopReason,
                     assistant stream expansion (text-chunks/reasoning-chunks→deltas),
                     TokenUsage→UsageInfo, tool/result→tool/completed, subagent status
  src/dsh.ts         DSH-side client: NDJSON JSON-RPC, pending-request correlation,
                     kill (SIGTERM→SIGKILL)
  src/adapter.ts     translation core (★ all state lives here, see below)
  src/drafts.ts      AriEventDraft = AriEvent minus the envelope (DistributiveOmit)
  src/main.ts        CLI: --dsh <cmd> [args...] (must come last), --queue-limit, --minimal,
                     --provider/--model/--cwd
  test/fake-dsh.ts   DSH wire-protocol test double (hand-written NDJSON, keyword-driven,
                     uses no ARI library)
  test/adapter.test.ts  24 tests, all across real processes
```

Root `package.json` gained: `test:adapter-dsh`, `adapter:dsh`, `conformance:dsh`; `test` now includes the adapter.

## 2. Five design decisions in the translation core (do not overturn)

1. **seq/turn are renumbered by the adapter.** DSH seqs include log-only events (0-based), and its turn counter restarts when the runtime process is recreated — neither may pass through. ARI seq is dense from 1 and turn monotonic from 1, owned by the adapter.
2. **Receipt attribution uses an arrival-time claim window.** DSH calls `followup()` synchronously inside the `session/prompt` handler, so the `turn/start` notification arrives **before** the response that carries the receipt. The adapter parks all DSH notifications for a session in a per-session FIFO, processes them in arrival order once the receipt lands, and snapshots `inFlight.length + pendingReceipts` at `turn/start` arrival as the claimable window. Sequential prompting — what ARI clients do — is attributed exactly; two prompts racing into one turn boundary are indistinguishable on the wire. That is the DSH SDK protocol's information limit, not a defect.
3. **The notification gate satisfies both C07 (messageIds attribution) and C14 (receipt precedes events) with one mechanism.** Nothing is translated while the FIFO is parked; when the receipt arrives, the ARI response is written first, then the parked events are released (a single FIFO write queue guarantees the order).
4. **Cancel = kill the process + settle every session.** The DSH wire has no cancel method (upstream's README says outright: a turn is abandoned by closing the process). The adapter maps ARI `session/cancel` to: SIGTERM the runtime → every session with an open turn emits `turn/completed{cancelled}` + `session/status idle`, and the requester gets `droppedMessageIds`. The next prompt lazily starts a fresh runtime generation (`dsh_<uuid>` session ids avoid colliding with persisted logs); ARI session ids and turn numbering survive across generations.
5. **The capability declaration is exactly what the wire can deliver**: reasoning/usage/compactionEvents/subagents true (all really arrive via `session.event`/`subagent.*` notifications); question/approvalEditInput/replay/fileChanges/backgroundTasks/fork/sessionList false. The emit path additionally gates through EVENT_CAPABILITY, so C12 holds structurally. `--minimal` turns everything off.

## 3. Hard facts about the DSH wire (the adapter cannot exceed them — do not try to "fix" them on the DSH side)

Sources: the upstream checkout `packages/sdk/protocol/{README.md,src/types.ts}`, `packages/sdk/server/src/server.ts`, `packages/core/session/src/types.ts`, `packages/llm/llm/src/{types,assistant-stream}.ts`.

- Three methods: `initialize{cwd,provider,model,…}` / `session/prompt{sessionId,contentBlocks}→{messageId}` / `shutdown`; four notifications: `session.event{sessionId,event}` / `session.status` / `subagent.started` / `subagent.finished`. **No** cancel, resume, fork, list, approvals, or questions.
- `session.event` is an **unfiltered broadcast of the whole runtime** — the adapter only accepts ids it allocated (`dshId`) and drops the rest (tested).
- Assistant text arrives **only at settlement** (`assistant/message` embeds `AssistantStreamRecord[]`); there are no live deltas on the wire — the adapter synthesizes deltas from the embedded records, the model case of "change the envelope, not the semantics".
- `session/prompt` takes any caller-chosen `sessionId` and lazily creates unknown ids (that is not resume).
- `TurnEndReason`: completed/aborted/blocked/error/max-tokens/interrupted/forked → end_turn/cancelled(×2)/refusal/error (with `session/error` first)/cancelled/end_turn.
- Compaction is a plugin event family (`compaction/start|summary|end`) flowing through `session.event`; a `compaction/performed` is synthesized when `end` lands without error (sourceCommandId or turn:null → manual).
- Usage is embedded in `assistant/message.usage` (TokenUsage: cacheReadTokens→cachedTokens).

## 4. Pitfalls hit this session (do not step on them again)

1. **`| tail` disguises "process won't exit" as "no output".** When the test process has dangling handles, `node --test | tail` looks hung while the tests finished long ago. Debug with `node --test --test-force-exit` redirected to a file.
2. **node:test timeouts are the `{ timeout: N }` option**, not a third positional argument.
3. **Under ESM + verbatimModuleSyntax, types must be `import type`** — `import { SomeInterface }` explodes at module load (Node type stripping does not erase imports).
4. **Typecheck has now actually been run** (half the P2 debt is paid): `tsc --noEmit` is clean over the whole repository. It caught 2 pre-existing shell type bugs (`Rendered.stream` lacked a `tool` member so tool/updated deltas mis-typed; render.ts's default branch narrowed to never) plus 3 issues in the new adapter code. tsconfig uses strict + noUncheckedIndexedAccess; new code must pass it. Reproduce: `npm i typescript@5.8 @types/node@22 --prefix /tmp/tsc-check --no-save && /tmp/tsc-check/node_modules/.bin/tsc --noEmit --typeRoots /tmp/tsc-check/node_modules/@types` (node_modules stays out of the repo; zero runtime dependencies unchanged).
5. **fake-dsh must faithfully reproduce DSH's odd ordering** (notifications before the receipt), otherwise the gate logic is never exercised. The politer the double, the more real adapter defects it hides.

## 5. Next steps

**P0: the Codex app-server adapter (`adapter-codex`)** — the previous handoff already made the case: the three-level coordinate envelope `thread_id/turn_id/item_id` has the largest envelope gap and stresses the spec hardest. Build the second one before deciding whether to spread out. Same method as this session: read `research/07-codex-app-server.md` + the `codex/codex-rs` upstream source → write a wire-protocol double → write the adapter → let conformance judge it. SPEC Appendix B is the work list.

**P1: a real-DSH smoke test** — the adapter has only been judged against fake-dsh so far; on a machine with an API key, run `npm run shell -- -- node packages/adapter-dsh/src/main.ts --dsh dsh --profile sdk` and record the result in the README. Note that DSH's provider/model route is passed via `--provider/--model` (defaults `deepseek-official`, matching the upstream server's own defaults).

**P2 (unchanged)**: GitHub description/topics still need filling in on the web; the LICENSE copyright holder is still `cholf5`; the npm scope is undecided (all packages remain `private: true`).

## 6. Baseline verification (run before touching anything)

```bash
cd <repository root>
npm test                    # expect 78/78 green
npm run conformance         # against the mock harness: 23 passed / 0 failed / 1 skipped
npm run conformance:dsh     # against the DSH adapter: 18 passed / 0 failed / 6 skipped
git log --oneline -3        # HEAD should include the DSH adapter commit
```

## 7. Things not to do (inherited + new)

Everything in the predecessor handoff §7 (naming, language, zero dependencies, erasable syntax, `.ts` extensions, git history, third-party clones, the SSH alias). Two additions:

- **Do not use `AriHarness` in an adapter** — the predecessor said it; worth repeating: an adapter is a translator, and `AriHarness` is a server-side helper for harness authors. Opposite roles.
- **Do not try to backfill semantics DSH does not have** (approvals, replay, live deltas) in the adapter. Missing means missing: declare `false` honestly and let conformance SKIP — lying about capabilities is the actual violation.
