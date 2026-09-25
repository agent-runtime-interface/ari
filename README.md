# ARI

> ARI = **Agent Runtime Interface** — a runtime interface specification for coding-agent harnesses.
> Status: **ARI 1.0** · License: Apache-2.0

A shell (IDE plugin, TUI, web UI, automation script) that wants to drive different coding agent runtimes today has to write a bespoke adapter for every vendor: DSH has SDK JSON-RPC, Codex has app-server, ZCode has Protocol V4, OpenCode is HTTP+SSE, Pi is RPC — with different method names, event names, completion semantics, and approval shapes.

ARI's starting point: **these runtimes already share the same set of runtime abstractions internally**, and those are worth standardizing once.

## What this is

Standardize the runtime concepts that **every implementation has** — session / events / turn / tool-call lifecycle / human interaction / cancellation / usage / compaction events — so that a single shell can drive multiple runtimes with the same code.

**ARI 1.0 = 10 request methods + 21 events + 1 handshake**; the normative definition is in **[SPEC.md](SPEC.md)**.

- Transport: JSON-RPC 2.0 over stdio, newline-delimited (normative binding A); HTTP + SSE is informative binding B, and the core data model is unchanged.
- Two key distinctions: **a prompt receipt ≠ the turn outcome** (the receipt only promises "durably enqueued"); **`session/error` never substitutes for `turn/completed`** (the former is diagnostics, the latter is the only closing).
- Capability negotiation: in `initialize` the harness truthfully declares capability bits such as `reasoning` / `question` / `usage` / `compactionEvents` / `replay` / `fileChanges` / `subagents` / `backgroundTasks` / `fork` / `sessionList`. **A capability declared `false` emits not a single event** — no dangling capability bits.
- Only client→server requests and server→client notifications are used; **no server→client requests**: human interaction goes through "event + respond method", so a shell needs no request router.

## What this is not

- **Not a tool protocol** — it defines no tool bodies and no tool schemas; tool integration is left to MCP (all 8/8 surveyed subjects already integrate it).
- **Not a model API** — it prescribes no provider, routing, or retry policy.
- **Not a UI specification** — events are semantics, not rendering; `meta` is opaque to the UI.
- **Does not prescribe harness internals** — compaction algorithms, PTC execution, sandboxes, storage formats, and iteration limits all stay inside the runtime.

## Directory

```
SPEC.md                   **ARI 1.0 specification** (normative)
ARI-RESEARCH-REPORT.md    research report (derivation and evidence)
                          Part A survey of existing implementations (8 subjects)
                          Part B shared runtime abstractions (B1–B13)
                          Part C differences and trade-offs (must-specify / should-specify / capability / leave alone)
                          Part D derivation of the ARI 1.0 proposal (D1–D9)
                          Part E examples (4)
research/                 evidence base: 8 source-level sub-reports + capability matrix
  01-dsh.md               02-zcode.md            03-codex-cli.md
  04-opencode.md          05-pi.md               06-acp.md
  07-codex-app-server.md  08-related.md          capability-matrix.md
packages/ari/             reference protocol library (TypeScript; runs directly on Node >= 22.6
                          via native type stripping — no build step, no dependencies)
  src/harness.ts          Harness-side helper: turns the §8 invariants into structure
  test/invariants.test.ts 29 tests asserting those invariants end to end
packages/mock-harness/    a minimal deterministic harness — the conformance target
packages/conformance/     the Appendix A checklist as a CLI, runnable against any harness
  test/broken-harness.ts  a deliberately non-conformant harness, to prove the suite has teeth
packages/shell/           the reference shell: drives any harness, knows none of them
  test/shell.test.ts      Appendix A items 23–25 (Shell-side) plus a CLI smoke test
packages/adapter-dsh/     the first adapter: ARI ⇄ DeepSeek Harness (SDK JSON-RPC wire)
  src/translate.ts        the pure DSH→ARI vocabulary mapping (envelope changes, semantics do not)
  src/adapter.ts          the translator core: seq/turn renumbering, receipt attribution,
                          the notification gate, cancellation by process replacement
  src/dsh.ts              the DSH-side client (speaks the SDK wire as the client end)
  test/fake-dsh.ts        a DSH-wire test double, so the adapter is judged without an API key
  test/adapter.test.ts    24 end-to-end tests across real processes
packages/adapter-codex/   the second adapter: ARI ⇄ Codex app-server (the v2 thread.* wire)
  src/translate.ts        the pure Codex→ARI vocabulary mapping (three-level coordinates
                          thread/turn/item collapse into ARI's envelope + payload fields)
  src/adapter.ts          the translator core: notification gate, pending-input queue,
                          approvals/questions over server→client requests, interrupt-based
                          cancellation, fork, session list, and the replay ledger
  src/codex.ts            the Codex-side client (answers the runtime's server→client requests)
  test/fake-codex.ts      a Codex-wire test double (notification-before-response ordering,
                          blocking approval/user-input requests), no API key needed
  test/adapter.test.ts    31 end-to-end tests across real processes
LICENSE                   Apache-2.0
```

## Running it

```bash
npm test        # 109 tests: invariants, conformance teeth, Shell-side checks, both adapters
npm run mock    # the mock harness, speaking ARI 1.0 on stdin/stdout

# Drive any harness with the reference shell:
node packages/shell/src/main.ts -- node path/to/my-harness.js

# Check any harness against the Appendix A checklist:
node packages/conformance/src/main.ts -- node path/to/my-harness.js

# Drive DSH through its SDK wire with the same shell (no ARI code in DSH, none in the shell):
node packages/shell/src/main.ts -- node packages/adapter-dsh/src/main.ts --dsh dsh --profile sdk

# Drive the Codex app-server the same way:
node packages/shell/src/main.ts -- node packages/adapter-codex/src/main.ts --codex codex app-server
```

### The shell

`packages/shell` is the point of the whole exercise: it renders the event stream,
answers approvals and questions, and cancels on Ctrl-C — and **contains no branch
on which harness is on the other end**. It contains no occurrence of any harness
name at all. If that is not enough to drive a harness, the protocol is wrong, not
the shell.

```bash
# one prompt, then exit
node packages/shell/src/main.ts --prompt "list the files" -- node packages/mock-harness/src/main.ts

# interactive: prompts from stdin; a pending interaction consumes the next line
node packages/shell/src/main.ts -- node packages/mock-harness/src/main.ts

# answer approvals automatically instead of asking
node packages/shell/src/main.ts --policy allow -- node packages/mock-harness/src/main.ts
```

Flags: `--prompt <text>`, `--policy ask|allow|deny`, `--no-reasoning`,
`--show-status`, `--raw`. Approval decisions are always validated against the
`options` the harness actually offered (Appendix A item 24), so a shell can never
send a decision that was not on the menu.

The mock harness is keyword-driven, so every interesting path can be exercised by
choosing the prompt text — no model, no fixtures:

```
echo hello        tool ls        approve         question
slow 5000         throw          fail            oversized
chunks 3          dangling       usage           file a.txt
subagent          background     compact         reasoning hi
```

Pass `--minimal` to make it declare every capability false (report D8's minimal agent).

### Conformance

The suite checks two kinds of property. **Observational** checks need no
cooperation — they drive a harmless prompt and assert what comes back: seq
density, one settlement per turn, capability gating, error codes, frame limits,
stdout purity. **Probe** checks need the harness to be driven into a specific
path, so the harness author declares how:

```bash
node packages/conformance/src/main.ts \
  --probe-approval approve --probe-question question \
  --probe-slow "slow 5000" --probe-error throw \
  --queue-limit 3 \
  -- node packages/mock-harness/src/main.ts --queue-limit=3
```

A probe that was not supplied makes its check report **SKIP with the flag that
would enable it** — never a silent pass, and never a failure for something the
suite could not provoke. Items 23–25 of Appendix A are Shell-side and therefore
out of scope for a harness-facing tool; `packages/ari/test` covers them for the
reference client.

The same suite judges the DSH adapter (driving its DSH-wire fake), where the
skips are themselves the finding: no approval/question/replay probe can be
supplied because the DSH SDK wire has no such channel, which is exactly what the
adapter's capability declaration says:

```bash
npm run conformance:dsh
# 18 passed, 0 failed, 6 skipped —
# C11/C18/C19/C24 skip on declared-false capabilities,
# C10/C20 skip because no prompt can reach an approval over this wire
```

The Codex adapter, by contrast, can be driven into every path its wire offers —
approvals and questions arrive as server→client requests, the adapter keeps a
replay ledger, and `thread/fork` / `thread/list` back `session/fork` /
`session/list` — so every probe can be supplied and nothing skips:

```bash
npm run conformance:codex
# 24 passed, 0 failed, 0 skipped
```

## How to read

| Your goal | Suggested path |
|---|---|
| Build a compatible shell or harness | **[SPEC.md](SPEC.md)**: §6 method overview → §7 lifecycle → §8 settlement invariants → Appendix A conformance checklist |
| Quickly judge whether this protocol is worth using | README (this page) → report Part B → SPEC §6 |
| Check whether a given conclusion holds up | Follow the `[0x]` numbering into `research/`; every file has `path` + `symbol`-level citations |
| Understand why some feature is "not done" | Report Part C4 / D7, plus SPEC §1.2 non-goals and §12 extension mechanism |

## Methodology

This report is based primarily on **source code and real protocol implementations**; every key conclusion carries a file-path + symbol-name-level citation. Product documentation is used only as a supplement and is marked as such. Surveyed subjects:

DSH (DeepSeek Harness) · ZCode · Codex CLI (codex-rs) · OpenCode · Pi (badlogic/pi-mono) · ACP (Agent Client Protocol) · Codex App Server · Claude Code (via `sdk.d.ts`; the CLI is closed-source) · Gemini CLI

Known limitations (e.g. ZCode's protocol describing itself as "not frozen", no binary audit of the Claude CLI, etc.) are recorded faithfully at the end of the report.

## Status and roadmap

**ARI 1.0 is complete** — [SPEC.md](SPEC.md): handshake and version negotiation, session lifecycle (new / resume / prompt / cancel / fork / list / shutdown), turn settlement invariants, 21 event kinds, human interaction, the full error-code table (`-32001`…`-32008`), extension mechanism, security considerations, conformance checklist.

**Reference implementation — in progress.** `packages/ari/` is the protocol library: protocol types, error codes, NDJSON framing with the 1 MiB cap and write backpressure, the Shell-side client, and a Harness-side helper that enforces the settlement invariants structurally rather than by convention. `packages/mock-harness/` is a minimal, deterministic harness built on that helper. `packages/conformance/` turns the Appendix A checklist into a CLI that runs against **any** harness command, and `packages/conformance/test/broken-harness.ts` is a deliberately non-conformant harness used to prove the suite detects violations rather than passing everything. `packages/shell/` is the reference shell, which drives the mock harness with no harness-specific code in it.

**First adapter — done.** `packages/adapter-dsh/` drives a DeepSeek Harness runtime over its own SDK JSON-RPC wire and speaks ARI to the shell. The adapter is a translator, not a harness: it plays the ARI server toward the shell and the DSH client toward the runtime, renumbering `seq`/`turn`, attributing prompt receipts to turns (DSH's `turn/start` carries no message ids), holding DSH notifications until the prompt receipt precedes them on the wire (SPEC §7.9), and mapping DSH's process-closure cancellation idiom onto `session/cancel`. Its capability declaration is exactly what that wire can deliver — reasoning, usage, compaction events, subagents; no approvals, questions, or replay — and the conformance suite passes 18 checks with 6 honest skips. The shell, the adapter, and the shell test never needed to change for this; that is the claim ARI makes.

**Second adapter — done.** `packages/adapter-codex/` drives the Codex app-server over its v2 `thread.*` wire — the biggest envelope gap in the family, since every notification carries three-level coordinates (`thread_id`/`turn_id`/`item_id`). The coordinates collapse into ARI's envelope: thread ids *are* ARI session ids, adapter-assigned turns map the `turn_id` space, and `item_id` rides ARI's opaque `callId`. The wire's server→client requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`) become ARI `approval/*` and `question/*` events answered through the respond methods — the one-way interaction pattern holding against a bidirectional wire. Cancellation is `turn/interrupt` (the runtime survives, unlike DSH), `turn/start`'s steering behavior is deliberately not exposed (mid-turn prompts queue, SPEC §7.3), `thread/fork`/`thread/list` back `session/fork`/`session/list`, and `session/resume` is served from the adapter's per-session event ledger. The conformance suite passes **24/24 with zero skips** — the first target against which every probe could be supplied. The documented limits are the wire's own: no `refusal`/`max_tokens` stop reasons exist upstream, approval decisions are closed-enum (no input amending), and child-agent threads are surfaced as events, not attachable sessions.

**Real-runtime smoke tests — run (2026-09-25).** Both adapters have now driven their real runtimes through the shell, not only the in-repo wire doubles. The Codex smoke passed end-to-end against a real app-server: handshake, capability declaration, and a real answered prompt — plus two paths the fake cannot reproduce: the server's own retryable `error` notifications ("Reconnecting... N/5") surfaced as ARI `session/error{retryable:true}` while the turn stayed open (SPEC §8-I4), and notifications unknown to the adapter (`thread/started`, `account/*`) were tolerated without breaking the stream. The DSH smoke ran a real `dsh --profile sdk` runtime through handshake, capability declaration, and the error path; it stops only at the machine credential — with no DeepSeek API key configured, the runtime settles the turn as an error (`MISSING_CREDENTIAL`), which the shell rendered correctly. Completing that final model call is the same one command on a machine with the key.

**Next (in this repository)** — the remaining adapter layers (ZCode / OpenCode / Pi / ACP), so the shell can drive real runtimes. The adaptation principle is **change the envelope, not the semantics**: a harness's internal compaction algorithm, PTC, tool pipeline, and storage format do not change just because it adapts to ARI. SPEC Appendix B is the mapping table to work from. The Codex adapter's notification gate — a `turn/started` can race the `turn/start` response through the app-server's single outbound queue — held against the real server in the smoke test above.

**Explicitly out of scope** — tool-body standardization (left to MCP), reversing client tools (ACP v2 removed that surface), PTC events, compaction control, PTY pass-through, subagent orchestration API, background-task control API. These go through the `x-` extension mechanism in §12 and **do not consume version numbers**.

**Not yet validated against a third-party harness.** The mock harness is report D8's "a minimal harness can be conformant" argument made executable, but it is still our own code, and it is the only harness the suite has been run against. Until an independently written harness passes `packages/conformance`, that claim remains half tested.

## Contributing

Issues and PRs are welcome. The most valuable contribution is a **counterexample**: if you know of a runtime whose behavior contradicts the "shared abstractions" in Part B, or if some clause in Part D cannot be implemented in your runtime, please open an issue with source citations.

## License

[Apache-2.0](LICENSE). By submitting a contribution you agree to license it under the same license (Apache-2.0 §5).

---

## Summary

**ARI (Agent Runtime Interface)** is a minimal, source-evidence-driven runtime specification for coding-agent harnesses.

A shell that wants to drive different agent runtimes today needs a bespoke adapter per runtime. ARI argues that these runtimes already share the same runtime abstractions — session as append-only event ledger, turn/step, tool-call lifecycle, closed-form approvals vs. open questions, explicit cancellation, usage, compaction events — and that these are worth standardizing once.

ARI 1.0 is **10 request methods + 21 events + 1 handshake**, carried as newline-delimited JSON-RPC 2.0 over stdio; the normative text is [SPEC.md](SPEC.md). Two distinctions carry most of the design weight: a `session/prompt` receipt promises only *durable enqueue*, never turn completion; and `session/error` is out-of-band diagnostics that never substitutes for `turn/completed`.

Every capability flag in `initialize` gates a defined surface — no dangling capabilities. ARI uses client→server requests and server→client notifications only, never server→client requests.

Every load-bearing claim in the report is cited at file-path + symbol level against real implementations (DSH, ZCode, Codex CLI, OpenCode, Pi, ACP, Codex App Server, Claude Code, Gemini CLI). The protocol library, the mock harness, the conformance suite, the reference shell, and the DSH and Codex adapters exist; the remaining per-SDK adapters are next.
