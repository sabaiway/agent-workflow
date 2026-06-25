---
name: agent-workflow-engine
description: Canonical home of the agent-workflow planning methodology — the Plan→Phase→Step→Substep vocabulary, plan lifecycle, queue.md series index, mandatory Cleanup phase, and the bounded methodology slot fragment. A published, installable npm package (available:true) that *provides* the methodology text; it mutates nothing. The composition root (agent-workflow-kit) currently keeps byte-identical mirror copies of this text (drift-guarded) and injects the slot from its mirror; the live kit → engine read + mirror retirement land in the next slice.
disable-model-invocation: true
metadata:
  version: '1.0.0'
---

# agent-workflow-engine

The **canonical source of truth** for the `agent-workflow` planning methodology. It is a
**published, installable npm package** (`capability.json` → `available:true`): it holds the
methodology text and **provides** it, but it ships no runtime and mutates no files. The kit
currently keeps **byte-identical mirror copies** of these files so the live injection + fallback
keep working with no new dependency; a drift-guard test pins the mirrors to this canon. The live
`kit → engine` read (and retiring the mirror) lands in the next slice.

## What it provides (`provides: ["plan"]`)

- [`references/planning.md`](references/planning.md) — the **full methodology**: the
  Plan→Phase→Step→Substep vocabulary, plan-file lifecycle (`docs/plans/*.md`, gitignored, never
  committed), the `queue.md` series index, the mandatory final **Phase: Cleanup**, the
  plan-then-execute split, and the session-continuity heuristic.
- [`references/methodology-slot.md`](references/methodology-slot.md) — the **bounded** fragment the
  composition root injects into a deployed project's `AGENTS.md`, between the
  `<!-- workflow:methodology:start -->` / `<!-- workflow:methodology:end -->` markers. A short
  summary + pointer, not the full reference, so the entry point stays under its line cap.

## Ownership rule (the engine knows nobody)

The engine only **provides** text. It never reads, writes, or mutates any project file or any
sibling skill — in particular it never touches a deployed `AGENTS.md`. **Only the composition root
(`agent-workflow-kit`) injects the methodology slot.** This keeps the family a DAG: the engine has
no outbound edges.

## Status & roadmap

The engine is **no longer a stub**: it is a published, `available:true`, installable npm package
(`@sabaiway/agent-workflow-engine`). The kit currently keeps **byte-identical mirror copies** of
this canon (drift-guarded), so the live injection + fallback keep working with no new dependency.
The live `kit → engine` read (the kit reading this canon from the installed engine instead of its
bundled mirror) and **retiring that mirror** land in the next slice. See the kit's
`tools/inject-methodology.mjs` for the marker contract and the slot reconciliation the kit runs on
bootstrap + upgrade.
