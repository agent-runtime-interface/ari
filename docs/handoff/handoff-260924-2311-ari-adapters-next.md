# ARI Handoff

> Addressed to **the next AI agent taking over this work**. You have no access to the previous sessions; this document is all you have.
> Generated: 2026-09-24 23:11 · Working directory: the repository root

> Translated from the Chinese original during the 2026-09-25 English-only migration; machine-specific details were sanitized per AGENTS.md.

---

## 0. Thirty-Second Overview

**ARI (Agent Runtime Interface)** is a runtime protocol that lets **one shell drive any coding-agent harness**. The repository is simultaneously spec + reference implementation + conformance suite, and is open-sourced at **https://github.com/agent-runtime-interface/ari** (public).

**Current progress**: spec (ARI 1.0) done · protocol library done · mock harness done · conformance suite done (24 checks) · reference shell done · **all 54 tests green**.
**Next step**: the 6 adapter layers (DSH / Codex / ZCode / OpenCode / Pi / ACP), with `adapter-dsh` as the recommended starting point.

Tech stack: **TypeScript, zero dependencies**, Node ≥ 22.6 native type stripping — run directly with `node xxx.ts`; no `npm install`, no build step.

---

## 1. Current Task Objectives

### The problem being solved

Today, a shell (IDE plugin, TUI, Web UI, automation script) that wants to drive different agent runtimes must write a dedicated adapter for each one: DSH has an SDK JSON-RPC, Codex has app-server, ZCode has Protocol V4, OpenCode is HTTP+SSE, Pi is RPC — method names, event names, completion semantics, and approval shapes all differ.

ARI's thesis: **these runtimes share the same runtime abstractions internally**, and that common ground is worth standardizing once.

### Expected deliverables

| Deliverable | Status |
|---|---|
| Normative spec `SPEC.md` | ✅ Done (ARI 1.0, English) |
| Reference protocol library `packages/ari` | ✅ Done |
| Reference harness `packages/mock-harness` | ✅ Done |
| Conformance suite `packages/conformance` | ✅ Done |
| Reference shell `packages/shell` | ✅ **Done** (2026-09-24 23:2x, see the end of §2) |
| **6 adapter layers** (DSH/Codex/ZCode/OpenCode/Pi/ACP) | ❌ **Not started ← next step** |
| A third-party, independently implemented harness passing conformance | ❌ Has not happened |

### Definition of done

- One shell can drive multiple real harnesses through ARI with **zero harness-specific branches anywhere in its code**
- Each adapter layer passes `packages/conformance` (the 22 harness-side checks of Appendix A)
- Ideal endgame: **some harness we did not write passes conformance** — the only hard evidence that "the spec can be independently implemented by a third party"

---

## 2. Current Progress

### Commit history (9 commits, all pushed; `main` in sync with `origin/main`)

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

### Documentation

| File | Language | Notes |
|---|---|---|
| `SPEC.md` | **English** | **Normative**. ARI 1.0. §0–§13 + Appendices A/B/C |
| `README.md` | English | Repository front page |
| `README.zh-CN.md` | Chinese | Content kept in sync with the English version |
| `ARI-RESEARCH-REPORT.md` | Chinese | Research report (Part A survey / B shared abstractions / C trade-offs / D derivation / E examples) |
| `research/01-dsh.md` … `08-related.md` + `capability-matrix.md` | Chinese | 9 source-level evidence documents with `path` + `symbol` citations |

> **Important**: the report and `research/` **intentionally remain in Chinese** — a deliberate, considered decision (see §3). The SPEC is in English and is the single source of truth; where the two conflict, the SPEC wins.

### Code (`packages/`)

```
packages/ari/src/types.ts        379 lines  protocol types, 11 capability keys, 21-event union, method table
packages/ari/src/errors.ts        88 lines  error codes -32001…-32008 + JSON-RPC standard codes
packages/ari/src/jsonrpc.ts      108 lines  JSON-RPC 2.0 detection, event notification recognition
packages/ari/src/framing.ts      155 lines  NDJSON framing, 1 MiB cap, backpressure writer, readFramesSafe
packages/ari/src/client.ts       528 lines  shell-side client
packages/ari/src/harness.ts     1172 lines  harness-side helper (invariant enforcement) ★core
packages/ari/src/index.ts         19 lines  entry point, 27 exports

packages/ari/test/invariants.test.ts      709 lines  29 invariant tests
packages/mock-harness/src/main.ts         339 lines  keyword-driven deterministic harness
packages/conformance/src/checks.ts        742 lines  24 checks
packages/conformance/src/main.ts          335 lines  CLI
packages/conformance/test/broken-harness.ts 151 lines  deliberately violating harness
packages/conformance/test/teeth.test.ts     129 lines  12 tests proving "the suite catches violations"
```

### Test status

```
$ npm test
ℹ tests 54   ℹ pass 54   ℹ fail 0
```

- `packages/ari/test/invariants.test.ts` — 29 (a real harness driven through the real client)
- `packages/conformance/test/teeth.test.ts` — 12 (including proof that 9 kinds of deliberate violations are detected)
- `packages/shell/test/shell.test.ts` — 12 (Appendix A checks 23–25 + CLI smoke tests)

### Commands

```bash
npm test                      # 54 tests
npm run test:invariants       # run only the invariant tests
npm run test:conformance      # run only the "teeth" tests
npm run mock                  # start the mock harness (speaks ARI 1.0 on stdin/stdout)
npm run conformance -- -- node packages/mock-harness/src/main.ts   # run conformance
npm run typecheck             # ⚠️ has never run successfully, see §5
```

---

## 3. Key Context

### The user's explicit requests (chronological order; paraphrased intent)

1. **Open source**: the repository must be public. Done (public).
2. **No version theatre**: the user asked to go straight to 1.0 with no version theatre → everything became **ARI 1.0**; no more v0.1/v0.2 wording anywhere.
3. **Internationalization**: the user asked for internationalization — spec, README, comments and commit messages in English → **spec / README / code comments / commit messages all in English**; **the research report and `research/` remain in Chinese** (the user accepted this trade-off: a 590-line spec vs a 2500-line report — decided on the benefit/cost ratio).
4. **Organization and naming**: final choice: organization **`agent-runtime-interface`**, repository **`ari`**. There was prolonged deliberation between `agentruntimeinterface` (no hyphen, MCP style) and `agent-runtime-interface` (more readable); **the user ultimately chose the hyphenated form**. **Do not reopen the naming discussion.**
5. **Next step**: the user confirmed the next step is a shell plus per-SDK adapter layers — the tech stack was settled as **TypeScript**, and the order as **shell + conformance first** (conformance is already done).
6. **History converted to English**: done (`git filter-branch` rewrote the 4 Chinese commit messages; tree objects were verified unchanged one by one; the old objects were reclaimed with `gc --prune=now`).

### Hard constraints (violating any of them breaks an established property)

| Constraint | Reason |
|---|---|
| **Zero dependencies** | The reference implementation running directly via `node xxx.ts` is a feature. Do not introduce any runtime dependency |
| **Erasable syntax only** | Node's native type stripping does not support `enum`, `namespace`, or constructor parameter properties. Use `const` objects + union types instead of enums. `tsconfig.json` sets `erasableSyntaxOnly: true` |
| **Imports must carry the `.ts` extension** | `import { x } from "./y.ts"`. `allowImportingTsExtensions` is enabled |
| **Code comments and commit messages in English** | The user explicitly requested internationalization |
| **Do not rewrite git history** | The repository has been pushed publicly; changing it would mean force-pushing public history |
| **Do not translate `research/` or `ARI-RESEARCH-REPORT.md`** | Intentionally kept in Chinese |

### Key design decisions already made (do not overturn them)

1. **ARI = Agent Runtime Interface** (the initialism holds, and it avoids the fatal collision with ARP → Address Resolution Protocol).
2. **No server→client requests.** ARI has only two message kinds: client→server requests and server→client notifications. Human-in-the-loop interactions go through "events + respond methods"; the shell needs no request router. This is a substantive departure from ACP.
3. **A prompt receipt ≠ the turn outcome.** The `messageId` of `session/prompt` strictly promises only "**durably enqueued**". Turn settlement is carried by `turn/completed`.
4. **`session/error` never replaces `turn/completed`.** The former is out-of-band diagnostics; the latter is the only closing event.
5. **Capability bits must not dangle.** Every capability declared `true` in `initialize` must have a defined method/event within 1.0. That is why subagent/background/fork/sessionList were promoted from "v0.2" into 1.0.
6. **Capabilities not yet protocolized go through the extension mechanism** (§12): `x-`-prefixed methods/events + `_meta`, **consuming no version number**. This includes steer, PTY passthrough, PTC, execpolicy corrections, and orchestration/control APIs.
7. **ARI is an interface specification; protocol bindings define the transport** (SPEC §1.1). Binding A (JSON-RPC 2.0 / NDJSON) is normative; Binding B (HTTP+SSE) is informative.

### Key numbers (verify before touching code)

- **10 request methods**: `initialize`, `session/new`, `session/resume`, `session/prompt`, `session/cancel`, `session/fork`, `session/list`, `shutdown`, `approval/respond`, `question/respond` (+ the `initialized` notification + the `event` channel)
- **21 event types** = 10 required + 11 capability-gated
- **11 capability keys**: `reasoning`, `question`, `approvalEditInput`, `usage`, `compactionEvents`, `replay`, `fileChanges`, `subagents`, `backgroundTasks`, `fork`, `sessionList`
- **13 error codes**: `-32700`…`-32603` (JSON-RPC standard) + `-32001`…`-32008` (ARI's own)
- `seq` and `turn` both **start at 1**; the single-frame cap is **1 MiB = 1,048,576 bytes**
- conformance: Appendix A has **22 harness-side + 3 shell-side** checks

### Environment facts

- Node **v25.4.0**, pnpm 12.4.2, npm 11.7.0
- The configured remote uses a local SSH alias (details deliberately omitted per the repository's content policy). Anyone cloning should use https://github.com/agent-runtime-interface/ari.git — and that is the URL documentation should cite.
- The working directory contains **untracked third-party checkouts**: `codex/`, `opencode/`, `ZCode/`, and a symlink `deepseek-harness`. **All are in `.gitignore`** — upstream source checkouts used for research. Do not commit them; do not delete them.

---

## 4. Key Findings

### 4.1 The value of `harness.ts` is making violations impossible

`AriHarness` turns the invariants of SPEC §8 into **structural guarantees**, not into self-discipline left to documentation:

| Invariant | Mechanism |
|---|---|
| No gaps in seq | **seq is allocated by the helper itself**; the harness author never gets a chance to write a seq |
| No events for capabilities set to false | The gate inside `#emit` consults `EVENT_CAPABILITY`; on a hit it throws `AriInvariantError` |
| Exactly one `turn/completed` per `turn/started` | There is only **one** open-turn slot; `#settleTurn` is the sole exit, and a duplicate settlement throws immediately |
| Exactly one `*/resolved` per `*/requested` | Settlement automatically closes out the turn's pending interactions (`cancelled`/`expired`) |
| No dangling tools | Before settlement, a `tool/completed{status:"error"}` is automatically emitted, **before** `turn/completed` |
| No events after settlement | `ctx` is "dead" once the turn settles; any emit throws |

**This is crucial for the adapter layers**: when writing an adapter you do not need to re-derive these invariants — the helper already enforces them.

### 4.2 Three real bugs (all exposed only "across processes")

**In-process unit tests missed all of them.** The first and the third surfaced only when the harness ran as a **child process** driven by the real client — only across processes does data truly pass through framing, and only then is there an independent state tracker to notice inconsistencies.

1. **A spec-level defect: an envelope field overwritten by the payload.** The `subagent/started` payload contains a `sessionId` (pointing at the **child** session), while every event envelope already carries `sessionId` (pointing at the session the event belongs to). Constructing the event as `{sessionId: thisSession, seq, ...payload}` let the payload silently overwrite the envelope → the client looked up a session that does not exist, neither advancing `nextSeq` nor recording a gap → it manifested as a baffling seq hole.
   - **Fix**: rename the field to `childSessionId` (**ZCode's internals already used exactly this name** — reverse confirmation), and add a normative rule in SPEC §9.1: `sessionId`/`seq`/`type` are reserved fields; a payload must not contain fields with those names, and the harness must reject such events.
   - `#emit` now **spreads the envelope fields last** (they always win) and explicitly rejects a payload containing `sessionId`/`seq`.

2. **A rejected frame consumed a seq.** The 1 MiB size check ran **after** `seq += 1` and after writing the log, so an oversized event left a permanent hole in the stream. The check now happens before any state change, and a rejected frame is completely side-effect free. **This one was caught by the client's own gap detection.**

3. **Tool state was mutated before the emit.** When a frame was rejected, the client would never receive the `tool/completed`, leaving a tool "open" that never closes. Now `toolStarted`/`toolUpdated`/`toolCompleted` always **emit first, mutate state second**; combined with the automatic close at settlement, this guarantees "every announced tool is eventually closed".

**Lesson (you will run into it again when writing adapter layers)**: any "mutate state first, emit event second" pattern is a bug nursery. **Emit the event first; mutate state only after it succeeds.**

### 4.3 The conformance design problem and its solution

**The problem**: how can the suite drive a harness it has never seen into paths like "requesting an approval", "erroring out", or "running slowly enough to cancel"? A third-party harness will not recognize keywords like `approve`.

**The solution**: two classes of checks.

| Type | Needs cooperation | Covers |
|---|---|---|
| **Observational** | No | seq density, one settlement per turn, capability gating, error codes, the frame cap, stdout purity, receipt preceding events |
| **Probe-based** | Yes (`--probe-*`) | approval round-trip, question round-trip, cancel, queue overflow |

**Checks whose probes were not supplied report SKIP together with the flag to add** — they neither silently pass, nor falsely fail because "the suite could not trigger the path".

### 4.4 A conformance suite that always passes is worthless

Hence `packages/conformance/test/broken-harness.ts`: it **deliberately does not use `AriHarness`** and hand-writes NDJSON, because its job is to violate the spec. 9 violations, each individually verified to be caught by the suite:

| Violation | Catching check |
|---|---|
| seq skips a number | C06 |
| `turn/started` missing `messageIds` | C07 |
| a turn settled twice | C08 |
| declares `reasoning:false` yet emits `reasoning/delta` | C12 |
| events before the prompt receipt | C14 |
| never enters idle | C22 |
| logs to stdout | C21 |
| a single frame > 1 MiB | C21 |
| `turn/completed{error}` with no preceding `session/error` | C09 |

### 4.5 Outcome of the naming discussion (do not reopen it)

- Considered and **rejected**: `ARP` (collides with Address Resolution Protocol; in networking that reading overwhelmingly dominates), `AHP` (collides with Analytic Hierarchy Process, and the semantics are inverted — naming the abstraction layer after the implementation layer it abstracts away), `HIP` (double collision: IETF's Host Identity Protocol + AMD's HIP)
- The decision criterion: search "`<initialism>` protocol" and see who wins. `ARP`/`HIP`/`AHP` all have dominant results; `ARI` does not — which is also why `ari-protocol` is unclaimed on both npm and GitHub
- The 200 response from `github.com/ari` is **a username**, not a repository name; it **does not block** `agent-runtime-interface/ari`

### 4.6 The "compliant in 200 lines" claim needed rephrasing

Research report D8 said "~200 lines to compliance", while the mock harness is actually 339 lines. The difference is almost entirely **scenario dispatch** (20+ test paths); the protocol mechanics themselves are `harness.serve(process.stdin, process.stdout)` plus one delegate. The README has been reworded to the more accurate claim: **the helper carries the protocol obligations; the harness author only writes the business loop**.

---

### 5.0 Completed (added after this file was first written)

**`packages/shell` is done** (`packages/shell/src/{main,render,policy}.ts` + `test/shell.test.ts`).

- `render.ts` — `renderEvent(event)` is a **pure function** mapping the 21 event types to `{kind:"stream"|"line"|"none"}`. Unknown types return `none` instead of throwing (Appendix A check 23).
- `policy.ts` — `chooseDecision` / `parseDecision` / `buildAnswers`, **guaranteeing no decision outside the offered `options` is ever sent** (check 24).
- `main.ts` — the CLI. `--prompt` (one-shot), interactive mode (driven by stdin lines), `--policy ask|allow|deny`, `--no-reasoning`, `--show-status`, `--raw`. Ctrl-C cancels the in-flight turn; press it again to exit.
- 12 tests, covering checks 23–25 + CLI smoke tests. **Repository-wide tests went from 41 → 54, all green.**

**The core claim has been verified**: `grep -niE "mock|dsh|codex|zcode|opencode|acp" packages/shell/src/*.ts` has **zero hits** — the shell contains no harness-specific identifiers. All 13 mock paths (tool/toolerror/chunks/dangling/usage/file/subagent/background/compact/error/throw/reasoning/echo) exit 0.

**Two pitfalls already stepped on (you will meet them again when building other things)**:
1. **Do not use `readline.question()` to drive piped input** — all lines arrive before the question is asked and fire `line` events, and are silently dropped. Use the `line` event + your own state machine instead (whether the next line is an answer or a prompt is decided by `pendingApproval`/`pendingQuestion`). This holds for both TTY and pipes.
2. **Subscribe before you act.** By the time `await respondApproval()` returns, the harness may already have emitted `turn/completed` — calling `client.on("turn/completed")` afterwards will never catch it. Collect events into an array first, then poll (the `waitFor` in `packages/shell/test/shell.test.ts` is exactly this pattern).

### 5.1 Outstanding work (by priority)

### P0 — The 6 adapter layers (`adapter-dsh` / `adapter-codex` / `adapter-zcode` / `adapter-opencode` / `adapter-pi` / `adapter-acp`)

**Adaptation principle: change the envelope, not the semantics.** A harness's internal compaction algorithm, PTC, tool pipeline, and storage format **do not change because of the ARI adaptation**.

Refer to `SPEC.md` **Appendix B** (the line-by-line ARI ↔ each-implementation mapping table) — that is the work list.

**Build 1–2 first**; do not spread out over all of them at once:
- **DSH** has the most complete semantics (A1 in report Part A); the mapping is nearly one-to-one
- **Codex app-server** has the largest envelope differences (the three-level coordinate envelope `thread_id/turn_id/item_id`) and stress-tests the spec the hardest

When writing an adapter layer, **do not use `AriHarness`** — that is for harness authors (the server side). An adapter layer is a **translation layer** that translates an existing harness's private protocol into ARI; it usually needs to be implemented by using `AriClient`'s role in reverse (i.e. the adapter plays server to the shell and client to the real harness).

### P1 — The three shell-side checks of Appendix A (23–25)

`23. ignore unknown event types/fields/capability keys`, `24. never send a decision not among the offered options`, `25. after a disconnect, rebuild state via resume and restore pending interactions from the snapshot`.

**The conformance CLI cannot cover these today** (it is a harness-facing tool). `packages/ari/test` partially covers the reference client. Now that `packages/shell` exists, consider adding an `--as-shell` mode to conformance, or a separate shell-side test suite.

### P2 — Engineering debt

- **`npm run typecheck` has never run successfully.** `typescript` and `@types/node` sit in `devDependencies`, but **`pnpm install` was never run** (the project deliberately runs with zero dependencies, so nothing needed installing). **Types have never been checked by tsc** — only processed by Node's type stripping (which erases but does not check). This is a real gap. Recommendation: run `pnpm install && pnpm typecheck` once and fix whatever it finds (or explicitly record it as a known state).
- **The GitHub repository description and topics are still empty**; the API cannot change them, they must be filled in via the web UI. Suggested copy is at the end of §7 of this file.
- **The `LICENSE` copyright holder is `cholf5`** (taken from git config). Now that the repository lives under the organization, the user may want to change it to a real name or the organization name. This is an ordinary file change, unaffected by "history is frozen".
- **The npm scope is undecided.** `packages/ari/package.json` says `"name": "@ari/protocol"`, which does not match the organization name. **All packages are currently `"private": true` and cannot be published, so there is no rush**. If publishing ever happens, the scope will be `@agent-runtime-interface/...` (29 characters, awkward to type in imports).

### P3 — External validation (highest value, least controllable)

**Find a harness we did not write and run `packages/conformance` against it.** This is the only hard evidence that "the spec can be independently implemented by a third party". Until then, D8's argument is only half-validated — the README already says so honestly.

---

## 6. Recommended Takeover Path

### What to read first (in this order)

1. **`SPEC.md`** — the normative text. At minimum read §0 (normative language), §3 (architecture: why no server→client requests), §6 (method overview), §8 (settlement invariants I1–I7), §9 (the event stream), and Appendix A (the conformance checklist). **This is the single source of truth.**
2. **`README.md`** — repository front page, directory structure, commands, conformance usage.
3. **`packages/ari/src/harness.ts`** — the core. Focus on `#emit` (the invariant enforcement point), `#settleTurn` (the sole settlement exit), and `TurnContext` (the API handed to harness authors).
4. **`packages/ari/src/types.ts`** — protocol types, `EVENT_CAPABILITY` (event → capability mapping), `METHOD_CAPABILITY` (method → capability mapping).
5. **`packages/mock-harness/src/main.ts`** — what a compliant harness looks like (keyword-driven, 20+ scenarios).
6. **`packages/conformance/src/checks.ts`** — the implementation of the 24 checks; also the executable form of "what ARI actually requires".
7. Consult `ARI-RESEARCH-REPORT.md` and `research/` when needed (Chinese; they are the **argumentation and evidence**, not the implementation basis).

### What to verify first (run once before doing anything, to establish the baseline)

```bash
cd <repository root>

# 1. All 54 tests should be green
npm test

# 2. conformance against the mock harness should be 23 passed / 0 failed / 1 skipped
node packages/conformance/src/main.ts \
  --probe-approval approve --probe-question question \
  --probe-slow "slow 8000" --probe-error throw --queue-limit 3 \
  -- node packages/mock-harness/src/main.ts --queue-limit=3

# 3. That 1 skipped is C13 (the mock declares every capability true); it should pass against --minimal
node packages/conformance/src/main.ts --only C13 -- node packages/mock-harness/src/main.ts --minimal

# 4. The suite has teeth: the deliberately violating harness must be caught
node packages/conformance/src/main.ts --only C06 -- node packages/conformance/test/broken-harness.ts --violate=gap
#    Expected: exit code 1, C06 FAIL
```

### Recommended next actions

**Build the first adapter layer; `adapter-dsh` is recommended.** Why:

1. The shell is done and has verified "it can drive a peer it does not know" (see §5.0); what is missing now is a real runtime
2. DSH is the most completely documented (A1 in report Part A), has the fullest semantics, and maps nearly one-to-one
3. Once it is done, validate immediately with `packages/conformance` as the criterion, not by eyeballing

**The roles are easy to get wrong**: an adapter layer is not a harness — **do not use `AriHarness`**. It is a translator — playing server to the shell (speaking ARI) and client to the real harness (speaking its private protocol). Both directions usually need to be hand-written; you can use `readFramesSafe` / `createFrameWriter` / `encodeFrame` from `packages/ari/src/framing.ts` directly.

**Do not build all 6 at once.** Finish 1 (ideally adding Codex app-server, whose three-level coordinate envelope differs the most), then decide. If 1–2 adapter layers already require adding things to the SPEC, that means the spec has a problem — **changing the SPEC is the correct action**.

---

## 7. Risks and Cautions

### Where misjudgments / duplicated effort happen

| Pitfall | Notes |
|---|---|
| **Do not reopen the naming discussion** | After considerable effort this is settled: organization `agent-runtime-interface`, repository `ari`, expansion `Agent Runtime Interface`. Do not propose ARP or new names again |
| **Do not casually translate `research/` into English** | Intentionally kept in Chinese — a deliberate cost/benefit decision |
| **Do not introduce dependencies** | Zero dependencies is a feature. `npm install` is only needed if you want to run typecheck |
| **Do not use `enum`** | Node type stripping does not support it; `erasableSyntaxOnly: true` will error out. Use `const` objects + `as const` + union types |
| **Do not forget the `.ts` extension** | `import { x } from "./y.ts"`, not `"./y"` |
| **Do not rewrite git history** | Already pushed publicly |
| **Do not commit the third-party checkouts** | `codex/`, `opencode/`, `ZCode/`, `deepseek-harness` are in `.gitignore`; they are the research workspace |
| **Do not "fix" the `remote` URL as if it were a typo** | It uses a local SSH alias (details omitted per content policy); documentation should cite `https://github.com/agent-runtime-interface/ari.git` |

### Directions already explored — do not continue down them

- **Adding server→client requests to ARI** (copying ACP's `session/request_permission`). Explicitly rejected: it would force the shell to implement a request router and break the event stream's single ordered channel. The reasoning is in SPEC §3 and Appendix C.
- **Adopting the client-tools inversion** (the client as tool provider). ACP v2 removed that surface; ARI explicitly will not do it.
- **Putting PTC / PTY / subagent orchestration / background task control into the core protocol.** Judged to be runtime detail or product surface; they go through `x-` extensions.
- **Standardizing the tool body.** MCP already solves that; ARI only defines the event shapes of tool **calls**.

### The coding pitfalls most likely to bite (learned from real bugs)

1. **Emit first, mutate state second.** Do it the other way around and, once a frame is rejected (oversized / encoding failure), client state becomes permanently inconsistent. This was bug #3 caught in this session.
2. **Envelope fields must never be overwritable by the payload.** Any new payload field with `sessionId` semantics **must get a different name** (e.g. `childSessionId`). Bug #1.
3. **Any check that can throw belongs before the state change.** Bug #2.
4. **Only cross-process tests surface framing/state-consistency problems.** In-process unit tests miss an entire class of bugs. **Every new path must also be exercised once in child-process form.**
5. **When adding a capability bit you must simultaneously define the methods/events it gates**, otherwise the capability bit dangles — the rule of SPEC §5.3; `harness.ts`'s `EVENT_CAPABILITY` / `METHOD_CAPABILITY` are the single source of truth.

### Discipline when editing the spec

- The SPEC is **normative** text using RFC 2119 keywords (MUST / MUST NOT / SHOULD / SHOULD NOT / MAY). When editing it, keep the keywords consistent: **do not use synonymous phrasings like "is prohibited"** (implementers grepping for `MUST NOT` would miss the clause — 4 such spots really were fixed in this session).
- After changing the SPEC, sync three places: `SPEC.md` (English, normative), `README.md` + `README.zh-CN.md` (front page), and Part D plus the event table of `ARI-RESEARCH-REPORT.md` (Chinese, the derivation record).
- After changing the protocol surface, sync `packages/ari/src/types.ts` and the conformance `checks.ts`.

### GitHub repository metadata (for the user to fill in via the web UI)

**Description**
```
ARI (Agent Runtime Interface): one shell, any coding-agent harness. An interface specification derived from source-level study of DSH, Codex, ZCode, OpenCode, Pi, and ACP.
```

**Topics**
```
agent-protocol, agent-runtime, coding-agent, ai-agents, specification, json-rpc, ndjson, interoperability, harness, llm
```

---

## Suggested First Steps for the Next Agent

```bash
cd <repository root>
npm test                    # confirm 54/54 green, establish the baseline
git log --oneline -3        # confirm HEAD includes "Add the reference shell"
```

Then **read `SPEC.md` §3 / §6 / §8 / §9 and Appendix A**, then `#emit` and `#settleTurn` in `packages/ari/src/harness.ts`, plus `packages/shell/src/main.ts` (to see what a shell that "does not know its peer" looks like).

**Then start the first adapter layer; `adapter-dsh` is recommended.** Why: A1 in report Part A documents DSH most completely, DSH already has all the semantics, and the mapping is nearly one-to-one — **change the envelope, not the semantics**. The mapping table in SPEC Appendix B is the work list.

**The adapter layer's role is easy to get wrong; settle it first**: it is not a harness (**do not use `AriHarness`**) but a **translator** — playing server to the shell (speaking ARI) and client to the real harness (speaking DSH's private protocol). It therefore usually requires hand-writing both directions; use `readFramesSafe` / `createFrameWriter` / `encodeFrame` directly (all in `packages/ari/src/framing.ts`).

Once the first adapter layer is done, **run `packages/conformance` against it immediately** — that is the criterion for "is the adaptation correct", not eyeballing:

```bash
node packages/conformance/src/main.ts --probe-approval <prompt that triggers an approval in DSH> ... -- <adapter layer launch command>
```

**Do not build all 6 adapter layers at once.** Finish 1 (ideally then Codex app-server — its three-level coordinate envelope `thread_id/turn_id/item_id` differs the most and stress-tests the spec the hardest) before deciding whether to continue. If 1–2 adapter layers already require adding things to the SPEC, the spec has a problem — **changing the SPEC at that point is the correct action, not a failure**.
