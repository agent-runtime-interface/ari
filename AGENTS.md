# AGENTS.md

Working conventions for AI agents (and humans) contributing to this repository.
The hard project constraints — zero runtime dependencies, erasable TypeScript
syntax only, `.ts` import extensions, English for code comments and commit
messages, no re-opening settled naming — are listed in the most recent handoff
document and are not repeated here.

## Language

All committed content is **English-only** (since 2026-09-25): the specification,
README files, research report and evidence files, code comments, commit
messages, and handoff documents. Do not introduce new non-English content, and
do not translate older documents "back" — the migration is complete and its
commits are part of history.

## Handoff documentation

Session handoffs live in `docs/handoff/` and are **committed to git**. They are
this project's working memory across agent sessions, and git is the only place
that memory survives cleanly: fresh clones, other machines, new sessions. Start
each new handoff from the fill-in skeleton at `docs/handoff/TEMPLATE.md`;
the template itself is living infrastructure and the only file in that
directory that may be edited after commit.

Rules for every handoff document:

1. **Append-only — never edit a handoff after committing it.** Each document is
   a delta on its predecessor: it links the previous one and records only what
   changed. The date-prefixed filename (`handoff-YYMMDD-HHMM-<topic>-next.md`)
   is the ordering; the most recent handoff is the entry point for a new
   session.
2. **Describe the repository and its decisions, not the machine or the
   operator.** Keep out: local absolute paths (anything containing a username),
   SSH configuration details and other machine configuration, sizes and
   layout of untracked local checkouts, and quoted private conversation. Facts
   about the repository itself — decisions, baselines, metadata, pending work —
   stay in. Anything machine-specific that must survive across sessions belongs
   in an untracked local note instead.
3. When one handoff supersedes part of an older one, it says so explicitly;
   older documents are background, not live instructions.

## Git history policy

History was rewritten **once**, on 2026-09-25, before the project had any
external clones, to sanitize content that violated the rules above (machine
configuration details and private conversation in an early handoff). That was
a one-time pre-adoption cleanup, not a standing permission: **the freeze is in
force again.** Do not rewrite, rebase, or force-push public history from now
on; fix anything objectionable in a forward commit instead.
