---
name: agent-workflow-engine
description: Canonical home of the agent-workflow planning methodology — the Plan→Phase→Step→Substep vocabulary, plan lifecycle, queue.md series index, mandatory Cleanup phase, and the bounded methodology slot fragment. A published, installable npm package (available:true) that *provides* the methodology text; it mutates nothing. The composition root (agent-workflow-kit) reads this canon LIVE from the installed engine and injects the bounded slot from it — one source of truth, no bundled mirror; `npx @sabaiway/agent-workflow-kit@latest init` installs the engine.
disable-model-invocation: true
metadata:
  version: '1.1.0'
---

# agent-workflow-engine

The **canonical source of truth** for the `agent-workflow` planning methodology. It is a
**published, installable npm package** (`capability.json` → `available:true`): it holds the
methodology text and **provides** it, but it ships no runtime and mutates no files. The kit reads
**this canon live from the installed engine** (resolved via the family `detect.installed` pattern)
and injects the bounded slot fragment from it — **one source of truth, no bundled mirror**.
`npx @sabaiway/agent-workflow-kit@latest init` installs the engine as a core part of the kit; when a
slot fill is needed but the engine is absent, the kit's reconcile **fails loudly** (never silently).

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
(`@sabaiway/agent-workflow-engine`). The kit reads **this canon live from the installed engine** and
injects the methodology slot from it — the old bundled mirror is **retired** (Plan 3D / AD-016):
**one source of truth**. `npx @sabaiway/agent-workflow-kit@latest init` installs the engine as a core
part of the kit. See the kit's `tools/inject-methodology.mjs` (the marker contract + slot
reconciliation) and `tools/engine-source.mjs` (the live read + fail-loud resolver).
