# ARI handoff — the ZCode adapter is built and smoked

> For the **next agent**, who has no access to the previous session — only this
> document and the ones it links.
> Written: 2026-09-25 22:00 · Working directory: the repository root (no
> absolute paths). Predecessor:
> [handoff-260925-1332-real-runtime-smoke-next.md](handoff-260925-1332-real-runtime-smoke-next.md) —
> this file records only the delta on it.

---

## 0. Thirty-second overview

ARI (Agent Runtime Interface) is an interface specification + reference
implementation + conformance suite for driving any coding-agent harness from
one shell. **State: 140/140 tests green, conformance 24/0/0 Codex and 24/0/0
ZCode and 18/0/6 DSH, typecheck clean.**

The predecessor's P0 — the third adapter — is done: `packages/adapter-zcode/`
drives the ZCode Agent CLI over Protocol V4, passes the full conformance suite
with zero skips (the second target after Codex where every probe could be
supplied), and its **real-runtime smoke passed end-to-end** against a CLI at
the checkout's vintage, which surfaced two live-only behaviors the adapter now
handles (§3). The one thing to do next is pick up the remaining roadmap items:
the fourth adapter (OpenCode, per the predecessor's method) or the P1 debts.

## 1. What changed since the predecessor

One commit plus this handoff:

- **`packages/adapter-zcode/` (new)** — the adapter in the established shape:
  `translate.ts` (pure ZCode→ARI vocabulary), `adapter.ts` (the translator
  core), `zcode.ts` (the wire client: v4 RPC, reverse requests, wire-frame
  fragment reassembly), `main.ts` (CLI entry, `--zcode <cmd>` last-arg rule,
  `--cwd`, `--queue-limit`, `--minimal`), `drafts.ts` (envelope-less event
  drafts), `test/fake-zcode.ts` (the wire double), `test/adapter.test.ts`
  (31 cross-process tests).
- **`package.json`** — `test` now includes the new adapter suite (140 total);
  added `test:adapter-zcode`, `adapter:zcode`, `conformance:zcode`.
- **`README.md`** — directory entry, running examples, conformance paragraph
  (24/0/0), a "Third adapter — done" status paragraph, the smoke paragraph now
  covers all three adapters, "Next" drops ZCode, summary counts updated.

Evidence: `npm test` 140/140; `conformance:zcode` 24/0/0 (all probes
supplied); `conformance:codex` 24/0/0 and `conformance:dsh` 18/0/6 unchanged;
`tsc --noEmit` clean; the real-runtime smoke transcript showed handshake,
capability declaration, receipt attribution, live reasoning/text deltas, real
usage, `end_turn` settlement, and dense seq.

## 2. Decisions made — do not reopen

1. **Session ids are ZCode session ids; forked children are adoptable.**
   Same model as the Codex adapter (thread ids are session ids). A forked
   child enters the adoptable set; the first prompt subscribes and creates
   adapter state.
2. **The adapter owns the pending-input queue** and forwards each prompt as
   its own `sendText` with `requestedDelivery:"startNow"` only when idle.
   ZCode's own queue has product semantics (auto-drain pausing, held/choice
   routing) ARI 1.0 does not absorb. Each forward carries one message, so
   `turn/started.messageIds` attributes exactly the shell's receipt; turns
   nobody prompted for get synthesized ids.
3. **Legacy reverse requests split into two classes.**
   `session/requestRuntimePreferences` **must be answered** (it blocks
   runtime creation upstream, and the CLI only self-falls-back on
   "method not found"/"no client", not on a timeout) — the adapter returns
   the desktop host's own fallback values. `interaction/*` requests **must
   stay unanswered** (they race the V4 `pendingInteractions` deferred;
   answering one could pre-empt a pending permission with a bogus decision).
4. **Capability declaration is the wire's own** (translate.ts): `reasoning`,
   `question`, `usage`, `compactionEvents`, `subagents`, `fork`, `replay`
   true; `approvalEditInput` (answers are decision-shaped), `fileChanges` (no
   per-path event stream), `backgroundTasks` (`backgroundWorks` entries
   vanish on delivery without an ARI-mappable terminal status), `sessionList`
   (V4 lists through a topic subscription; the coexisting legacy
   `session/list` RPC is a deprecated namespace the adapter does not bridge —
   SPEC Appendix B maps ZCode's session/list to "—") false.
5. **Snapshot rows are history, not events.** The initial subscribe frame
   reconstructs row/turn bookkeeping and opens live work (a running turn,
   running tools) but emits nothing for settled content; only live deltas
   become ARI events. A shell that adopts a session must not see its past
   replayed as new deltas.
6. **The fake mirrors the real ordering hazards deliberately**: `sendText`
   projection frames go out before the ack (the notification gate exists for
   that), `createSession` blocks on the preferences reverse request, frames
   fragment above a 256 KiB physical cap, and `coalesced`/`removed`/`foreign`
   keywords reproduce dirty branches and noise.
7. **Predecessor decisions all stand** (smoke results live in the README,
   honest partial passes, user-decision metadata, restart-continuity as
   documentation).

## 3. Hard constraints and facts discovered

Wire facts verified in the ZCode checkout (version 3.14.0; the CLI
sub-monorepo `apps/zcode-cli` is version 0.16.9, `V4_WIRE_PROTOCOL_VERSION`
3) and now encoded in `packages/adapter-zcode/src/translate.ts`:

- **The stdio carrier is JSON-RPC-shaped without the `jsonrpc` member**:
  `{id, method, params}` requests, `{id, result}` / `{id, error{code,message}}`
  responses, `{method, params}` notifications (`packages/shared/src/
  zcode-protocol/index.ts`, `zcodeProtocolMessageSchema`). There is **no
  hello/handshake on the stdio carrier** — the V4 `hello`/`clientHello`
  schemas belong to other carriers; the desktop drives the CLI statelessly.
- **The event source is a projection, not a fact stream**: subscribe to
  `v4/conversation/subscribe` (topic `conversation/<sessionId>`, ACK-only
  response) → the initial snapshot arrives as a post-response
  `v4/conversation/frame` notification wrapping a physical `TopicWireFrame`
  (`wireVersion` 3, `kind:"complete"` or base64+crc32 `fragment`s of one JSON
  value). Deltas are five closed ops; StatePatch keys are whole-key
  replacements.
- **Turn brackets are row states**: `turnHeader` `running` →
  `completedSuccess`/`completedInterrupted`/`failed`. No refusal/max-tokens
  exist (same documented limitation as Codex). The flush coalescer can
  collapse a whole bracket into `row.appended` (the adapter opens and settles
  in one breath) and can swallow every streaming `row.delta`, merging the
  text into the settled `row.upserted` (the adapter delivers the remainder,
  deduped across the runtime's re-announced rows — both seen live).
- **Interactions are data**: `pendingInteractions[]` (permission/userInput)
  answered via `resolveInteraction {interactionId, answer{optionId|
  freeText|action,content}}`; permission options carry a `kind`
  (allowOnce/allowAlways/deny/custom) and the answer echoes the *optionId*
  whose kind matches; AskUserQuestion answers ride `action:"accept"` +
  `content.answers` keyed by question text, valued by option `value` (the
  desktop elicitation path, `interaction-broker.ts`); a late
  `resolveInteraction` is a `noop` ack, so the adapter keeps the §10.3
  idempotency table itself.
- **`forkAssistant` targets a row, with CAS**: the turn's last `assistantText`
  row (`{rowId, entityId}`) plus `baseRevision` + `baseLogEpoch`; the CLI
  rejects non-assistant/non-latest targets and stale bases. The projection
  publishes the revision as a `state.updated {revision}` patch after every
  commit, which is what makes the CAS trackable.
- **A real ZCode turn is heavy**: ~15.4k input tokens for a one-line answer
  (same shape as the Codex observation). The smoke used the CLI bundled at
  the same vintage as the checkout (0.16.9).
- The real runtime's unknown noise (startup/storageState, process/mcpTelemetry,
  v4/telemetry/event, computer-use/operation-event notifications,
  `interaction/requestOfficialMcpAuthHeaders` reverse request) is tolerated by
  the ignore paths without breaking the stream.

## 4. Pitfalls hit this session

1. **The logical topic frame rides inside a notification**: the CLI sends
   `{method:"v4/conversation/frame", params:<wireframe>}` — a bare wire frame
   (no `method` key) is silently dropped by any client that classifies frames
   by the presence of `method`/`id`. The initial fake omitted the wrapper and
   the adapter saw nothing.
2. **Base64 fragments must be decoded individually, then concatenated.**
   Concatenating padded base64 strings and decoding once silently drops
   everything after the first `=` (manifested as "Unterminated string in JSON
   at position 262144").
3. **`baseRevision` CAS needs the projection's published revision.** If the
   fake (or a client) only tracks revision from patches it happens to see,
   `forkAssistant` answers `stale`. The revision must be observable after
   every projection commit.
4. **A CLI reverse request can block a command.** The preferences request is
   not advisory: ignoring it hangs `createSession` until the adapter's own
   request timeout. Distinguish must-answer configuration requests from
   must-not-answer interaction requests (§2.3).
5. **The coalescer swallows deltas** — a "settled row" path that only handles
   never-seen rows loses the answer when the row was seen streaming first.
   Deliver `text.slice(streamed)` on settlement, and dedupe by row id because
   upstream re-announces settled rows (the raw capture showed three upserts).
6. **The reference shell's one-shot mode never answers interactions** — it
   exits on `turn/completed` and does not read stdin; interactive answers
   need the interactive mode (and with piped stdin the lines are consumed as
   prompts before the interaction exists). This is the shell's documented
   design, not an adapter bug; the conformance suite drives interactions
   programmatically.
7. Predecessor pitfalls re-verified: redirect smoke output to a file; the
   `--prompt` one-shot shell mode is the right smoke shape; match the smoke
   binary to the checkout's vintage (here: the bundled CLI at 0.16.9 equals
   the checkout's `apps/zcode-cli` version).

## 5. Next steps, in priority order

**P0 — the fourth adapter (OpenCode, SPEC Appendix B).** Method (proven three
times now): read `research/04-opencode.md`, verify wire facts in the
`opencode/` checkout, hand-write the wire double, build the pure translation
table, judge with `packages/conformance` (add a `conformance:opencode`
script), cross-process tests in `node --test`, README counts updated. Note
OpenCode is HTTP+SSE — the first adapter off stdio; the framing layer may not
apply.

**P1 — finish the DSH smoke** on a machine with a DeepSeek API key: the
documented command from README "Running it" with `--prompt`, then update the
README smoke paragraph's DSH sentence to a full pass. One command, no code.

**P1 — remaining metadata debt (user decisions, predecessor §2.3):** LICENSE
holder legal name and the npm scope decision.

**P2 — a real multi-turn ZCode smoke** (steering-adjacent paths, cancel mid
real turn, compaction on real pressure): the single-turn smoke passed; deeper
real-runtime paths need a workspace the CLI is configured for.

**P2 — cross-restart replay** for the adapters: only if a real use demands
it; the honest options are documented in the adapter headers.

## 6. Baseline verification — run before touching anything

```bash
npm test                    # expect 140/140 green
npm run conformance:zcode   # ZCode adapter: 24 passed / 0 failed / 0 skipped
npm run conformance:codex   # Codex adapter: 24 passed / 0 failed / 0 skipped
npm run conformance:dsh     # DSH adapter: 18 passed / 0 failed / 6 skipped
npm run conformance -- -- node packages/mock-harness/src/main.ts
                            # bare runner: 16 passed / 0 failed / 8 skipped
git log --oneline -3        # HEAD: this handoff; before it: "Add the ZCode
                            # adapter (adapter-zcode)" and the smoke handoff
git status                  # clean; main == origin/main
```

Typecheck recipe is in the predecessor's predecessor §3 (`tsc --noEmit` via a
temporary prefix); it is clean and must stay so.

## 7. Standing rules

Everything in predecessor §7 stands (naming, zero dependencies, erasable
syntax, `.ts` import extensions, English-only, the history freeze, third-party
clones are gitignored evidence, never use `AriHarness` in an adapter, missing
means missing, amaro-safe casts, fake keyword tables mirror the conformance
probe texts, smoke evidence records the transferable method and the vintage).
This session adds:

- **A wire double must reproduce the upstream ordering hazards, not be
  politer than reality**: projection-before-ack, blocking reverse requests,
  fragmentation, coalescing, and re-announced settled rows are exactly what
  the adapter's structure exists for.
- **Reverse requests get a policy, not a blanket**: answer what blocks
  (configuration), ignore what races state (interactions), and say which is
  which in the wire client's header.
