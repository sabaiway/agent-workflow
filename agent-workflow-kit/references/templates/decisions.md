---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: never
owner: none
maxLines: 500
---

# Architecture Decision Records (ADRs)

> Every significant choice that has long-term consequences. Newest at the bottom. Link related ADRs with `[[AD-XXX]]`.

## AD-001 — Adopt AI-agent memory system (`docs/ai/`)

**Date:** {{DATE}}
**Status:** Accepted

**Context.** Multi-session AI work loses context between runs. Without a structured handover, each new session re-reads code, re-discovers decisions, and repeats past mistakes.

**Decision.** Adopt a Memory Map in `AGENTS.md` (entry point — the cross-agent standard; tool aliases like `CLAUDE.md` symlink to it) + structured files under `docs/ai/`. Define three protocols (Start / During / Complete). Enforce frontmatter caps + index freshness + 3-tier archive via a pre-commit hook. Deployed via the `agent-workflow-kit` skill.

**Rationale.** Single entry + structured spec files = constant boot-up cost regardless of project size. ADRs prevent litigating the same decision twice. `pages/<page>.md` keeps behaviour canonical (docs > assumptions). Caps + archive keep files scannable as history grows.

**Consequences.**
- ➕ Faster session start, less drift between agents.
- ➕ ADRs as institutional memory; honest `known_issues.md`.
- ➖ Discipline cost: docs updated alongside code.
- ➖ A set of markdown files + scripts to maintain.

---

## AD-002 — {{Next decision}}

**Date:** {{DATE}}
**Status:** Proposed / Accepted / Superseded

**Context.** {{...}}
**Decision.** {{...}}
**Consequences.** {{...}}

---

> When this file nears ~90% of its cap, move the oldest Accepted/Superseded ADRs to `decisions-archive.md` (keep the IDs + a one-line pointer here) and record the split. Bumping the cap instead of splitting is a conscious exception, justified in an ADR.
