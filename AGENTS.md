# AGENTS.md

Working conventions for AI agents (and humans) contributing to this repository.
The hard project constraints — zero runtime dependencies, erasable TypeScript
syntax only, `.ts` import extensions, English for code comments and commit
messages, no history rewrites, no re-opening settled naming — are listed in the
most recent handoff document and are not repeated here.

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

Note: handoffs published before 2026-09-25 predate rule 2 and contain local
environment details; rule 2 applies from this date onward, and older documents
are left as committed rather than rewritten.
