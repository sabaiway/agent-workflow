---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: never
owner: none
maxLines: 500
---

# Architecture Decision Records (ADRs)

> The **HOT window** of Architecture Decision Records — every significant choice with long-term
> consequences, newest at the bottom. Link related ADRs with `[[AD-XXX]]`; retrieval is by the
> `AD-NNN` id (filename), grep over the flat store, or the `[[AD-NNN]]` supersession chain.

> **Archive:** older ADRs are stored one immutable file per record under [`adr/`](./adr/) — see the active-set navigator [`adr/log.md`](./adr/log.md). `archive-decisions.mjs` explodes the oldest entries beyond this window automatically; no cap is ever raised and there is no monolithic ledger.

## AD-001 — Adopt AI-agent memory system (`docs/ai/`)

**Date:** {{DATE}}
**Status:** Accepted

**Context.** Multi-session AI work loses context between runs. Without a structured handover, each new session re-reads code, re-discovers decisions, and repeats past mistakes.

**Decision.** Adopt a Memory Map in `AGENTS.md` (entry point — the cross-agent standard; tool aliases like `CLAUDE.md` symlink to it) + structured files under `docs/ai/`. Define three protocols (Start / During / Complete). Enforce frontmatter caps + index freshness + a one-file-per-ADR archive via a pre-commit hook. Deployed via the `agent-workflow-memory` substrate (standalone, or as part of the agent-workflow family).

**Rationale.** Single entry + structured spec files = constant boot-up cost regardless of project size. ADRs prevent litigating the same decision twice. `pages/<page>.md` keeps behaviour canonical (docs > assumptions). Caps + one-file-per-ADR archival keep every record scannable as the decision history grows without bound.

**Consequences.**
- ➕ Faster session start, less drift between agents.
- ➕ ADRs as institutional memory; honest `known_issues.md`.
- ➖ Discipline cost: docs updated alongside code.
- ➖ A set of markdown files + scripts to maintain.
