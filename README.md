**English** · [中文](README.zh-CN.md)

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
LICENSE                   Apache-2.0
```

## Running it

```bash
npm test        # 41 tests: invariants, plus proof that conformance detects violations
npm run mock    # the mock harness, speaking ARI 1.0 on stdin/stdout

# Check any harness against the Appendix A checklist:
node packages/conformance/src/main.ts -- node path/to/my-harness.js
```

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

## How to read

| Your goal | Suggested path |
|---|---|
| Build a compatible shell or harness | **[SPEC.md](SPEC.md)**: §6 method overview → §7 lifecycle → §8 settlement invariants → Appendix A conformance checklist |
| Quickly judge whether this protocol is worth using | README (this page) → report Part B → SPEC §6 |
| Check whether a given conclusion holds up | Follow the `[0x]` numbering into `research/`; every file has `path` + `symbol`-level citations |
| Understand why some feature is "not done" | Report Part C4 / D7, plus SPEC §1.2 non-goals and §12 extension mechanism |

### Language note

The research report and the evidence files under research/ are written in Chinese. The normative specification is SPEC.md, which is in English.

## Methodology

This report is based primarily on **source code and real protocol implementations**; every key conclusion carries a file-path + symbol-name-level citation. Product documentation is used only as a supplement and is marked as such. Surveyed subjects:

DSH (DeepSeek Harness) · ZCode · Codex CLI (codex-rs) · OpenCode · Pi (badlogic/pi-mono) · ACP (Agent Client Protocol) · Codex App Server · Claude Code (via `sdk.d.ts`; the CLI is closed-source) · Gemini CLI

Known limitations (e.g. ZCode's protocol describing itself as "not frozen", no binary audit of the Claude CLI, etc.) are recorded faithfully at the end of the report.

## Status and roadmap

**ARI 1.0 is complete** — [SPEC.md](SPEC.md): handshake and version negotiation, session lifecycle (new / resume / prompt / cancel / fork / list / shutdown), turn settlement invariants, 21 event kinds, human interaction, the full error-code table (`-32001`…`-32008`), extension mechanism, security considerations, conformance checklist.

**Reference implementation — in progress.** `packages/ari/` is the protocol library: protocol types, error codes, NDJSON framing with the 1 MiB cap and write backpressure, the Shell-side client, and a Harness-side helper that enforces the settlement invariants structurally rather than by convention. `packages/mock-harness/` is a minimal, deterministic harness built on that helper. `packages/conformance/` turns the Appendix A checklist into a CLI that runs against **any** harness command, and `packages/conformance/test/broken-harness.ts` is a deliberately non-conformant harness used to prove the suite detects violations rather than passing everything.

**Next (in this repository)** — a reference shell, and adapter layers for each agent SDK (DSH / Codex / ZCode / OpenCode / Pi / ACP). The adaptation principle is **change the envelope, not the semantics**: a harness's internal compaction algorithm, PTC, tool pipeline, and storage format do not change just because it adapts to ARI.

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

Every load-bearing claim in the report is cited at file-path + symbol level against real implementations (DSH, ZCode, Codex CLI, OpenCode, Pi, ACP, Codex App Server, Claude Code, Gemini CLI). The protocol library exists; the mock harness, conformance suite, reference shell, and per-SDK adapters are next.
