# ARI Handoff — governance settled, back to coding

> For the **next agent**, who has no access to the previous session — only this
> document and the ones it links.
> Written: 2026-09-25 11:54 · Working directory: the repository root (no
> absolute paths). Predecessor:
> [handoff-260925-0045-ari-adapter-dsh-next.md](handoff-260925-0045-ari-adapter-dsh-next.md) —
> this file records only the delta on it, and then points you back at the code.

---

## 0. Thirty-second overview

ARI (Agent Runtime Interface) is an interface specification + reference
implementation + conformance suite for driving any coding-agent harness from
one shell. **State: 78/78 tests green, conformance 23/0/1 against the mock
harness and 18/0/6 against the finished DSH adapter, typecheck clean,
everything pushed.**

The last session was a governance detour — handoff policy, English-only
migration, a one-time history sanitization — and it is **done**. Your session
should be a coding session. The roadmap has one headline item: **build the
Codex app-server adapter (`adapter-codex`)**, the second of six. The first
(`adapter-dsh`) is your worked example, and its handoff documents the method.

## 1. What changed since the predecessor

Three governance commits landed and were pushed (HEAD is the rewrite tip
`7537e3c`; `main` == `origin/main`):

1. **`AGENTS.md` is now the policy entry point**: handoff documentation rules
   (committed, append-only, delta-on-previous, repository-not-machine content
   rule), a **Language** section (all committed content English-only from
   2026-09-25), and a **Git history policy** section (see §2 below). Read it
   first; it is short.
2. **`docs/handoff/TEMPLATE.md`** — the fill-in skeleton every new handoff
   starts from (this document follows it). The template is the only file under
   `docs/handoff/` that may be edited after commit.
3. **English-only migration**: the nine `research/` surveys, the capability
   matrix, `ARI-RESEARCH-REPORT.md`, and both prior handoffs are translated
   (structure, heading numbering, `path:symbol` citations, and `[0x]`
   cross-references preserved). `README.zh-CN.md` is deleted. The repository
   contains zero Chinese; do not reintroduce translations or zh mirrors.
4. **One-time history rewrite**: all 19 commits were rewritten to sanitize
   machine-configuration details, local absolute paths, and quoted private
   conversation out of the early handoff blobs, then force-pushed once. The
   tip tree is byte-identical to the pre-rewrite tree; only historical blobs
   changed.

## 2. Decisions made — do not reopen

- **English-only is complete.** Do not translate anything "back", do not
  propose zh mirrors, do not write handoffs in any other language.
- **The history freeze is back in force.** The 2026-09-25 rewrite was a
  one-time pre-adoption cleanup, sanctioned because no external clones
  existed. It is not a precedent: fix anything objectionable in a forward
  commit. Never force-push again.
- **Handoffs are committed, append-only, and start from the template.** Their
  content describes the repository and its decisions — never machines or
  operators.
- **The DSH adapter's five design decisions stand** (predecessor §2):
  adapter-assigned seq/turn, arrival-time claim windows for receipt
  attribution, the notification gate, cancel-as-process-replacement, and
  capability honesty. Read them before writing any adapter.
- Naming and organization (`agent-runtime-interface` / `ari`) — settled long
  ago; not up for discussion.

## 3. Hard constraints and facts discovered

- **Governance entry points**: `AGENTS.md` (policy) → `docs/handoff/TEMPLATE.md`
  (handoff skeleton) → `SPEC.md` (the normative specification, Appendix B is
  the adapter work list) → the predecessor handoff (DSH adapter method and DSH
  wire facts in its §2–§3).
- **Typecheck is part of the workflow now.** `tsc --noEmit` is clean over the
  whole repo (strict + `noUncheckedIndexedAccess`); keep it that way. Recipe:
  `npm i typescript@5.8 @types/node@22 --prefix /tmp/tsc-check --no-save &&
  /tmp/tsc-check/node_modules/.bin/tsc --noEmit --typeRoots
  /tmp/tsc-check/node_modules/@types` (node_modules stays out of the repo;
  zero runtime dependencies unchanged).
- **Conformance is the judge, not your eyes.** `npm run conformance` (mock
  harness) and `npm run conformance:dsh` (DSH adapter through its wire double)
  are one command each. A new adapter is done when this suite passes it — with
  honest SKIPs where the source wire lacks a channel, which are findings, not
  failures.
- The upstream checkouts at the repository root (`codex/`, `opencode/`,
  `ZCode/`, the `deepseek-harness` symlink) are gitignored research material —
  use them as evidence, never commit them.

## 4. Pitfalls hit this session

1. **Parallel subagents hit a user concurrency limit (~6).** Large fan-outs
   (we ran 13 translations) fail with `user concurrency limit exceeded` beyond
   that; batch them, retry the failures, and make every agent's task
   self-contained.
2. **`git filter-branch` refuses a second run while `refs/original/*` exists**
   (its abort message mentions `-f`). Delete the backup ref first. After any
   rewrite, old commits remain reachable via `refs/remotes/origin/main` and
   reflogs — expire reflogs, `git gc --prune=now`, and sweep `git rev-list
   main`, **not** `--all`, or your own verification will report ghosts.
3. **A tree-filter with `|| true` can mask failures** — the real safety net is
   a full-history grep for every sanitized pattern after the rewrite, plus a
   tip-tree diff against the pre-rewrite HEAD.
4. **Splitting one document across translation agents works well** if you cut
   at heading boundaries, have each part written to its own file, and verify
   the assembled result by line count and section positions before installing.

## 5. Next steps, in priority order

**P0 — `adapter-codex`, the Codex app-server adapter.** This is the session's
job. The method, proven by `adapter-dsh`:

1. Read `research/07-codex-app-server.md` (English now) and skim the `codex/`
   checkout's app-server crate for the wire vocabulary. The three-level
   coordinate envelope (`thread_id`/`turn_id`/`item_id`) is the biggest
   envelope gap in the whole family — expect it to stress the spec, and if it
   demands a SPEC change, **changing SPEC is the correct move, not a failure**.
2. Design the pure translation table first (the `translate.ts` role):
   capability honesty up front — declare exactly what the wire can deliver —
   plus the stop-reason, event, and error mappings.
3. Hand-write a `fake-codex` wire double (no ARI library in it; reproduce the
   real wire's ordering quirks faithfully — the DSH double's
   notifications-before-receipt quirk is what made the adapter's gate
   testable).
4. Build the adapter core: ARI server toward the shell, wire client toward the
   runtime; renumber seq/turn; never use `AriHarness` (it is the server-side
   helper for harness authors — opposite role).
5. Judge with `packages/conformance` (add a `conformance:codex` script),
   cross-process tests in `node --test`, README counts updated, English
   commit message.

**P1 — a real-DSH smoke test** on a machine with an API key:
`npm run shell -- -- node packages/adapter-dsh/src/main.ts --dsh dsh --profile
sdk`; record the result in the README (predecessor §5).

**P2 — repository metadata debt**: GitHub description/topics (text in the
0924 handoff §7), the LICENSE copyright holder, the npm scope decision. All
web/normal-file work, none of it history-sensitive.

## 6. Baseline verification — run before touching anything

```bash
cd <repository root>
npm test                    # expect 78/78 green
npm run conformance         # mock harness: 23 passed / 0 failed / 1 skipped
npm run conformance:dsh     # DSH adapter: 18 passed / 0 failed / 6 skipped
git log --oneline -3        # HEAD should include "…back to coding" (this handoff)
git status                  # clean; main == origin/main
```

If typecheck is wanted, use the recipe in §3.

## 7. Standing rules

Everything in the predecessor handoff §7 still applies (naming, zero
dependencies, erasable syntax, `.ts` import extensions, third-party clones,
the SSH-alias caveat), with two updates superseding it: the **language** rules
now live in `AGENTS.md` (English-only — the predecessor's "keep research/
Chinese" decision is obsolete), and the **git history** rule is the resumed
freeze described in §2 above. The predecessor's pitfalls (§4) — tail pipes
masking hangs, node:test timeout options, `import type` under
`verbatimModuleSyntax`, emit-before-mutate, envelope-wins — remain mandatory
reading.
