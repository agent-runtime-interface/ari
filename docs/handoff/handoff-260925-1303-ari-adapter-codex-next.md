# ARI Handoff — the Codex adapter is done

> For the **next agent**, who has no access to the previous session — only this
> document and the ones it links.
> Written: 2026-09-25 13:03 · Working directory: the repository root (no
> absolute paths). Predecessor:
> [handoff-260925-1154-ari-back-to-coding-next.md](handoff-260925-1154-ari-back-to-coding-next.md) —
> this file records only the delta on it.

---

## 0. Thirty-second overview

ARI (Agent Runtime Interface) is an interface specification + reference
implementation + conformance suite for driving any coding-agent harness from
one shell. **State: 109/109 tests green (78 before + 31 in the new adapter),
conformance 24/0/0 against the new Codex adapter — the first target with zero
skips — 18/0/6 DSH (unchanged), 23/0/1 mock (unchanged), typecheck clean.**

The session's P0 was **`packages/adapter-codex`**, the second of six adapters,
and it is done and judged. The one thing to do next is pick the next roadmap
item in predecessor §5 (P1 real-DSH smoke test, P2 metadata debt) or start the
third adapter.

## 1. What changed since the predecessor

One feature commit adds `packages/adapter-codex/` and wires it in:

- `src/translate.ts` — the pure Codex→ARI mapping layer: capability table,
  `turn/completed.turn.status` → stop reason, item mappers
  (CommandExecution / McpToolCall / FileChange / SubAgentActivity), usage
  breakdown mapping, approval-decision and question-answer mapping.
- `src/codex.ts` — the Codex-side client. The structural difference from
  `adapter-dsh`'s `dsh.ts`: it **answers server→client requests** (approvals,
  user input) through a pending-request table and per-request respond
  callbacks.
- `src/adapter.ts` — the translation core (state ownership documented in its
  header comment: notification gate, pending-input queue, replay ledger,
  interaction idempotency tables, interrupt-based cancel, fork, session list
  with adoption).
- `src/main.ts` + `package.json` — CLI (`--codex <command> [args...]` last,
  `--cwd`, `--queue-limit`, `--minimal`).
- `test/fake-codex.ts` — the Codex-wire double (keyword-driven, no ARI
  library, reproduces the notification-before-response ordering and the
  blocking server→client requests).
- `test/adapter.test.ts` — 31 cross-process tests.
- Root `package.json`: `test:adapter-codex`, `adapter:codex`,
  `conformance:codex`; `test` now includes the adapter.
- `README.md`: directory entry, counts (109), a second-adapter status section,
  `conformance:codex` documented.

Evidence: `npm test` 109/109; `npm run conformance:codex` 24 passed / 0 failed
/ 0 skipped; DSH and mock conformance unchanged; `tsc --noEmit` clean.

## 2. Decisions made — do not reopen

1. **ARI session ids are Codex thread ids.** Codex allocates durable opaque
   thread ids at `thread/start`, so no adapter-side id-mapping table is needed
   (the DSH adapter needed one because DSH sessions are lazily re-created).
   SPEC §9.1's `s_` + ULID is a recommendation, not a rule; ids stay opaque.
   `session/list` *adopts* listed thread ids: their ids enter the adoptable
   set and the first prompt creates adapter state for them. Unknown ids
   (never listed, never created) are `-32001` — C04 stays honest.
2. **The notification gate exists because of a real race, not paranoia.** The
   app-server funnels responses and notifications through one outbound mpsc
   queue and the turn can start before the `turn/start` response is written,
   so `turn/started` may precede the receipt. Everything inbound for a thread
   is parked while a `thread/start`/`turn/start` forward is outstanding; the
   ARI response is written, then the FIFO drains.
3. **Receipt attribution is exact, not a window.** Unlike DSH, each forward
   carries exactly one message (`clientUserMessageId` is even provided), so
   `turn/started.messageIds` claims exactly the one receipt. A turn nobody
   prompted for gets a synthesized id as a safety net.
4. **Mid-turn prompts are queued adapter-side, never steered.** Codex
   `turn/start` *steers* a running turn (upstream `start_or_steer_turn`);
   steering is explicitly not ARI 1.0 (SPEC §12). The queue is the adapter's;
   the next queued prompt is forwarded on `turn/completed`.
5. **Cancellation is `turn/interrupt`, not process replacement.** The runtime
   and session survive; the wire's `turn/completed{interrupted}` settles the
   turn as `cancelled`. Queue contents go to `droppedMessageIds`. A cancel
   racing an in-flight start waits (bounded) for the forward to land first.
6. **`replay: true` is served from the adapter's per-session event ledger**
   (in-memory, same lifetime as the adapter process — the same contract the
   reference mock harness offers). `since` beyond the watermark is `-32602`.
7. **`approvalEditInput: false` is a wire fact** (approval responses carry
   only `{decision}` — verified upstream), and `backgroundTasks: false`
   because no general background framework exists on the wire.
8. **The fake deliberately emits `turn/started` before the `turn/start`
   response** and runs turn bodies asynchronously after the response — the
   real server's ordering — so the gate is load-bearing, not decorative.
9. The DSH adapter's five design decisions (predecessor §2) all still stand.

## 3. Hard constraints and facts discovered

Sources: the `codex/` checkout (`codex-rs/app-server-protocol/src/protocol/
common.rs` macro tables, `v2/{thread,turn,item,thread_data,notification,mcp}.rs`,
`app-server/src/request_processors/turn_processor.rs`,
`app-server/src/outgoing_message.rs`) and `research/07-codex-app-server.md`.

- Wire inventory used: `initialize` (params `{clientInfo}`, response
  `{userAgent,…}`; no protocolVersion), `thread/start|resume|fork|list`,
  `turn/start|interrupt`, the `initialized` client notification (the only
  one; outbound is enabled by the initialize request itself), notifications
  `turn/started|completed`, `item/started|completed`, `item/agentMessage/delta`,
  `item/reasoning/{textDelta,summaryTextDelta}`,
  `item/commandExecution/outputDelta`, `thread/tokenUsage/updated`, `error`
  (`{error, willRetry, threadId, turnId}`), `thread/compacted`,
  `serverRequest/resolved`, and server→client requests
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/tool/requestUserInput` (response `{answers: {id: {answers: []}}}`).
- A settled `Turn` carries `status: completed|interrupted|failed|inProgress`
  plus `error.message`. **There is no refusal and no max-tokens status** on
  this wire — those ARI stop reasons are unreachable here (documented limit,
  not a mapping guess).
- Approval decisions are a closed enum
  (`accept|acceptForSession|acceptWithExecpolicyAmendment|
  applyNetworkPolicyAmendment|decline|cancel`, externally tagged camelCase).
  ARI maps `allow_once|allow_always|deny` onto the first/second/fifth; the
  amendment variants are not expressible from ARI.
- Everything on this wire is camelCase; enums are either tagged
  (`ThreadStatus`, `ThreadItem`, `PatchChangeKind`) or externally tagged
  (decisions). `ApprovalParams.approvalId` is usually `null` — the adapter
  keys interactions by the JSON-RPC request id instead (`ap_<id>`, `q_<id>`).
- `thread/fork` takes `lastTurnId` (fork through, inclusive); the referenced
  turn must not be in progress. The adapter maps ARI `atTurn` through its
  per-session turn table and `-32602`s unknown boundaries.
- `thread/list` returns `Thread` records with a tagged `ThreadStatus`
  (`notLoaded|idle|systemError|active{activeFlags}`); `active` → `running`,
  everything else → `idle`.

## 4. Pitfalls hit this session

1. **Node's type stripper (amaro) rejects `(x as T | null)?.prop`** even
   though `tsc` accepts it: the parse fails at require time with a cryptic
   `ERR_INVALID_TYPESCRIPT_SYNTAX`. Bind the cast to a variable first. (Node
   22.6+ type stripping is stricter than tsc about cast placement.)
2. **The fake's item ids must be allocated once per logical item.** An id
   helper that reads a counter at call time gives `started`, `delta`, and
   `completed` three different ids, and the adapter's streamed-byte guard
   then never matches — the symptom was tool output being double-delivered
   (600k of deltas for a 300k payload) and callId mismatches in tests.
3. **A keyword mismatch between the fake and the conformance probe silently
   becomes an echo turn.** The probe `approve` did not match the fake's
   `approval` keyword, so C10/C20 timed out while everything else passed.
   When a probe check times out, first compare the probe text with the
   fake's keyword table.
4. **Dangling `fake-codex`/`fake-dsh` processes accumulate across failed
   test runs** (`node --test` kills the adapter, orphans survive the fake).
   `pkill -f fake-codex` between runs; orphans otherwise eat ports and
   confuse nothing but your patience.
5. Predecessor pitfalls all re-verified as alive: `| tail` hides hangs
   (redirect to a file), node:test timeouts are `{ timeout: N }` options,
   `import type` under `verbatimModuleSyntax`, emit-before-mutate
   (envelope-wins), and the politer the double, the more real adapter defects
   it hides.

## 5. Next steps, in priority order

**P0 — choose the next move** (either is defensible; the roadmap lists both):

- **P1 of the predecessor: a real-DSH smoke test** on a machine with an API
  key (`npm run shell -- -- node packages/adapter-dsh/src/main.ts --dsh dsh
  --profile sdk`), recorded in the README. A real-**Codex** smoke test is the
  symmetric new item: `node packages/shell/src/main.ts -- node
  packages/adapter-codex/src/main.ts --codex codex app-server`, and it would
  additionally confirm the gate's race assumptions against the real
  outbound-queue behavior.
- **The third adapter** (ZCode per SPEC Appendix B). Same method: read the
  research survey, verify wire facts in the checkout, write the wire double,
  build the translator, let conformance judge.

**P1 — repository metadata debt** (unchanged from the predecessor): GitHub
description/topics, the LICENSE copyright holder, the npm scope decision.

**P2 — worth noting in the adapter**: `session/resume` on a *restarted*
adapter process cannot rebuild the ledger (in-memory by design). If a real
use demands it, the honest fix is a documented `-32004` for unknown-to-this-
process sessions or a `thread/resume`-backed rebuild with a fresh seq space —
not a pretend continuity.

## 6. Baseline verification — run before touching anything

```bash
npm test                    # expect 109/109 green
npm run conformance:dsh     # DSH adapter: 18 passed / 0 failed / 6 skipped
npm run conformance:codex   # Codex adapter: 24 passed / 0 failed / 0 skipped
npm run conformance -- -- node packages/mock-harness/src/main.ts
                            # bare runner: 16 passed / 0 failed / 8 skipped
                            # (probe flags raise it to 23/0/1; the exact
                            # mock-harness command is in predecessor §3)
git log --oneline -2        # HEAD should be this session's adapter commit
git status                  # clean; main == origin/main
```

Typecheck recipe is in predecessor §3; `tsc --noEmit` is clean and must stay
so. `npm run conformance` (bare) exits with usage because the `--` separator
is mandatory.

## 7. Standing rules

Everything in predecessor §7 stands (naming, zero dependencies, erasable
syntax, `.ts` import extensions, English-only, the history freeze, third-party
clones are gitignored evidence, never use `AriHarness` in an adapter, missing
means missing). This session adds two:

- **Node's type stripper is part of the typecheck surface.** `tsc --noEmit`
  passing is necessary but not sufficient: keep casts simple enough for amaro
  to strip (see pitfall 1).
- **Fake keyword tables must mirror the conformance script's probe texts
  exactly** — the `conformance:*` scripts in the root `package.json` are the
  contract between the two.
