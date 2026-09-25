# ARI handoff — the real-runtime smoke tests are run

> For the **next agent**, who has no access to the previous session — only this
> document and the ones it links.
> Written: 2026-09-25 13:32 · Working directory: the repository root (no
> absolute paths). Predecessor:
> [handoff-260925-1303-ari-adapter-codex-next.md](handoff-260925-1303-ari-adapter-codex-next.md) —
> this file records only the delta on it.

---

## 0. Thirty-second overview

ARI (Agent Runtime Interface) is an interface specification + reference
implementation + conformance suite for driving any coding-agent harness from
one shell. **State: 109/109 tests green, conformance 24/0/0 Codex and 18/0/6
DSH (both unchanged), typecheck clean.**

The predecessor left a choice: real-runtime smoke tests or the third adapter.
This session took the smoke tests (pending since two sessions) plus the
actionable metadata debt. **The real-Codex smoke passed end-to-end against a
real app-server** — including two behaviors the fake cannot reproduce — and
the real-DSH smoke ran a real runtime up to the machine's missing credential,
where the error path rendered correctly. Results are recorded in the README.
The one thing to do next is **start the third adapter (ZCode)**.

## 1. What changed since the predecessor

Two small commits plus repository metadata:

- **README**: a "Real-runtime smoke tests — run (2026-09-25)" status paragraph
  between the second-adapter paragraph and "Next"; the stale "a real-runtime
  smoke test would confirm…" sentence in "Next" is replaced by the confirmed
  outcome.
- **`packages/adapter-codex/src/adapter.ts`**: design-header note (predecessor
  P2) documenting the ledger's process lifetime — after an adapter restart,
  `session/resume` of a pre-restart session is -32001, the supported
  continuity path is `session/list` adoption with a fresh seq space, and the
  honest rebuild options (-32004 or a `thread/resume`-backed ledger) are named
  but deliberately not implemented.
- **GitHub metadata**: the repository topics from the 0924 handoff §7 are now
  set (10 topics); the description turned out to be already set, byte-equal to
  the intended text. The LICENSE copyright line is "Copyright 2026 cholf5" —
  already filled; see §5 for what remains.

Evidence: `npm test` 109/109 after the edits; `tsc --noEmit` clean (comment-only
code change); both smoke runs captured verbatim in files and summarized below.

## 2. Decisions made — do not reopen

1. **Smoke results live in the README's status section**, not a separate
   report. They are claims about the adapters, so they sit next to the
   adapter-status paragraphs they qualify.
2. **The DSH smoke is recorded as a partial pass, honestly.** It proves the
   live SDK wire (handshake, capability declaration, error settlement) but not
   the final model call; the README says exactly that instead of claiming
   "smoke passed".
3. **The remaining metadata items are user decisions, not agent decisions.**
   The LICENSE holder ("cholf5") is valid as-is; changing it to a legal name
   or the org, and the npm scope question, need the human — do not "fix" them
   unilaterally.
4. **The Codex restart-continuity note documents behavior; it does not change
   it.** No real use for cross-restart replay has appeared, so the -32004 and
   ledger-rebuild options stay unimplemented (predecessor §5 P2, now settled
   as documentation).

## 3. Hard constraints and facts discovered

Live-wire facts from the smoke runs — things the in-repo fakes do not
reproduce:

- **The real app-server emits notifications the fake never sends**:
  `remoteControl/status/changed`, `account/updated`, `thread/started` (without
  a thread id), `account/rateLimits/updated`. The adapter's
  "notification without a threadId → log and ignore" path handled all of them;
  no adapter change was needed. Expect such noise on any real run.
- **The real app-server emits retryable `error` notifications with
  `error.message` like "Reconnecting... N/5" and `willRetry: true`** (its own
  model-backend stream recovery). This exercised SPEC §8-I4 live: each retry
  surfaced as `session/error{retryable:true}`, the turn stayed open, and the
  answer arrived. A keyword-driven fake cannot reproduce this class; treat the
  I4 path as smoke-tested, not fake-tested.
- **A real Codex turn is heavy**: a one-line answer cost ~16k input tokens
  (system prompt + tool schema). Budget for that when scripting smoke runs.
- **DSH's `sdk` is a factory profile** (with `web`, `headless`, `sdk-minimal`,
  `acp` — research/01-dsh.md:9): `dsh --profile sdk` serves the SDK JSON-RPC
  wire over stdio with no profile setup, and the adapter's handshake against
  the real runtime succeeds unchanged. A missing provider credential settles
  the turn as an error (`MISSING_CREDENTIAL`) whose message names the exact
  remedy (credentials service or `DEEPSEEK_API_KEY` in the environment).
- The GitHub description was already set to the intended text; only topics
  were missing.

## 4. Pitfalls hit this session

1. **An npm-installed Codex CLI can lose its vendored platform binary** (the
   wrapper resolves `vendor/<triple>/codex/codex`, which was an empty
   directory). Reinstalling the same npm version did **not** restore it — the
   package ships without the binary content. The official release tarball
   (`codex-<triple>.tar.gz` from the `rust-v*` release) works directly: point
   the adapter at the extracted binary, `--codex <binary> app-server`. Pick the
   release matching the `codex/` checkout's vintage (here: checkout HEAD and
   v0.156.0 tagged the same day).
2. **Version-matching matters for a live smoke**: the adapter encodes one
   vintage of the wire. Take the binary's version from the release closest to
   the checkout commit, not "latest".
3. **A green suite says nothing about live notification shapes.** Run the
   smoke before assuming the fake covers the wire; the real server's extra
   notifications and retry chatter are exactly what keyword tables omit.
4. **When a smoke fails on a credential, the runtime's error names the
   remedy** — do not go hunting through local config for keys; the smoke ends
   there and the next machine with the key reruns one command.
5. Predecessor pitfalls all re-verified: redirect smoke output to a file
   (`| tail` hides hangs — both runs above were captured that way), and the
   `--prompt` one-shot shell mode is the right way to smoke a real runtime
   non-interactively.

## 5. Next steps, in priority order

**P0 — the third adapter (ZCode, SPEC Appendix B).** The headline item, now
unblocked. Method (predecessor §5, proven twice): read
`research/02-zcode.md`, verify wire facts in the `ZCode/` checkout, hand-write
the wire double, build the pure translation table, judge with
`packages/conformance` (add a `conformance:zcode` script), cross-process tests
in `node --test`, README counts updated.

**P1 — finish the DSH smoke** on a machine with a DeepSeek API key: the
documented command from README "Running it" with `--prompt`, then update the
README smoke paragraph's last sentence to a full pass. One command, no code.

**P1 — remaining metadata debt (user decisions, see §2.3):** LICENSE holder
legal name and the npm scope decision. GitHub description/topics are done.

**P2 — cross-restart replay** for `adapter-codex`: only if a real use demands
it; the honest options are documented in the adapter header (§1 above).

## 6. Baseline verification — run before touching anything

```bash
npm test                    # expect 109/109 green
npm run conformance:dsh     # DSH adapter: 18 passed / 0 failed / 6 skipped
npm run conformance:codex   # Codex adapter: 24 passed / 0 failed / 0 skipped
npm run conformance -- -- node packages/mock-harness/src/main.ts
                            # bare runner: 16 passed / 0 failed / 8 skipped
git log --oneline -4        # HEAD should include this session's two commits
git status                  # clean; main == origin/main
```

Typecheck recipe is in the predecessor's predecessor §3 (`tsc --noEmit` via a
temporary prefix); it is clean and must stay so.

## 7. Standing rules

Everything in predecessor §7 stands (naming, zero dependencies, erasable
syntax, `.ts` import extensions, English-only, the history freeze, third-party
clones are gitignored evidence, never use `AriHarness` in an adapter, missing
means missing, amaro-safe casts, fake keyword tables mirror the conformance
probe texts). This session adds:

- **Smoke evidence is repository evidence**: record outcomes and the
  transferable method, never local binary paths or machine state.
- **A smoke binary must match the checkout's vintage** (§4.2) — record which
  release a smoke used next to its result.
