# TEMPLATE — how to start a new handoff

> This file is the fill-in skeleton for new handoff documents. **Copy it** to
> `handoff-YYMMDD-HHMM-<topic>-next.md`, fill every section in, delete the
> guidance text, and commit alongside the work it describes.
>
> `TEMPLATE.md` itself is living infrastructure: it is the only file in
> `docs/handoff/` that may be edited after commit. Dated handoffs are
> append-only (AGENTS.md).
>
> Two binding rules this template cannot enforce (from AGENTS.md):
>
> 1. A handoff records the **delta** since its predecessor — link the
>    predecessor below and do not restate what it already says. Exception: the
>    first handoff in a repository may be a full state document.
> 2. Describe the **repository and its decisions, not the machine or the
>    operator**: no local absolute paths (anything containing a username), no
>    SSH or shell configuration details, no sizes or layout of untracked local
>    checkouts, no quoted private conversation.

---

# <Repository> handoff — <topic>

> For the **next agent**, who has no access to the previous session — only this
> document and the ones it links.
> Written: YYYY-MM-DD HH:MM · Working directory: the repository root (no
> absolute paths). Predecessor:
> [handoff-YYMMDD-HHMM-<topic>-next.md](./<filename>) — this file records only
> the delta on it.

## 0. Thirty-second overview

What this repository is, in one sentence. Where the work stands, in numbers
(test counts, conformance results). The one thing the reader should do after
reading.

## 1. What changed since the predecessor

Deliverables, files added or changed, commit hashes — each with the evidence
that it works: test counts, conformance output, what was verified and how.

## 2. Decisions made — do not reopen

Each decision settled this session, with its one-line rationale. Include
anything a reader will be tempted to "fix" or re-litigate; that is exactly what
belongs here.

## 3. Hard constraints and facts discovered

Source- or protocol-level facts that bound future work, with their sources
(file paths, symbols). Environment facts only when they are properties of the
repository (Node version floor, package manager) — never of a particular
machine.

## 4. Pitfalls hit this session

What the next agent would otherwise re-discover the hard way: tool quirks,
test-runner behavior, ordering traps. One line each: what happened, what to do
instead.

## 5. Next steps, in priority order

P0 / P1 / P2… Each item: what it is, why it is next, and the first concrete
action.

## 6. Baseline verification — run before touching anything

Commands with their expected results, so the next session starts from verified
ground truth rather than assumptions:

```bash
npm test        # expect N/N green
```

If HEAD is expected to contain a specific commit, say so.

## 7. Standing rules

Point to the section of the predecessor that lists the inherited constraints,
then list only what this session adds.

---

Omit a section rather than write filler in it. Body language follows the
session's working language; keep the headings exactly as above so handoffs
stay greppable.
