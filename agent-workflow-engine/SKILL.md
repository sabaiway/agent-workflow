---
name: agent-workflow-engine
description: Canonical home of the agent-workflow planning methodology — the Plan→Phase→Step→Substep vocabulary, plan lifecycle, queue.md series index, mandatory Cleanup phase, the bounded methodology slot fragment, the orchestration-recipe vocabulary (Solo / Reviewed / Council / Delegated), and the activity-procedures canon (plan-authoring / plan-execution, with typed recipe slots). A published, installable npm package (available:true) that *provides* the methodology text; it mutates nothing. The composition root (agent-workflow-kit) reads this canon LIVE from the installed engine and injects the bounded slots from it — one source of truth, no bundled mirror; `npx @sabaiway/agent-workflow-kit@latest init` installs the engine.
disable-model-invocation: true
metadata:
  version: '1.17.0'
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
- [`references/orchestration.md`](references/orchestration.md) — the canonical **orchestration-recipe**
  reference: the four recipes (Solo / Reviewed / Council / Delegated) defined over the bridges' role
  vocabulary, the when/why decision guidance, the graceful-degradation lattice, and the quota/health
  guard. The kit owns the executable dispatch and surfaces it as `/agent-workflow-kit recipes`.
- [`references/orchestration-slot.md`](references/orchestration-slot.md) — the **bounded** one-line
  orchestration fragment the composition root injects into a deployed `AGENTS.md`, between the
  `<!-- workflow:orchestration:start -->` / `<!-- workflow:orchestration:end -->` markers. It names the
  four recipes and routes to `/agent-workflow-kit recipes`, never to this engine-internal reference.
- [`references/autonomy-slot.md`](references/autonomy-slot.md) — the **bounded** one-line autonomy
  fragment the composition root injects into a deployed `AGENTS.md`, between the
  `<!-- workflow:autonomy:start -->` / `<!-- workflow:autonomy:end -->` markers. It carries the
  cross-agent READ CONTRACT for the per-project autonomy policy (`docs/ai/autonomy.json`): read at
  session start, the canonical default floor when the file is absent, STOP on malformed — plus the
  honesty note that the policy is informational for delegated backends (enforcement stays the OS
  sandbox + the orchestrator). It routes to the kit's `set-autonomy` / `autonomy-doctor` surfaces,
  never to any engine-internal reference.
- [`references/procedures.md`](references/procedures.md) — the canonical **activity-procedures** canon:
  the ordered steps of the named activities (`plan-authoring`, `plan-execution`) with **typed recipe
  slots** that bind to the orchestration recipes, composing with `planning.md` without restating it. It
  stays generic (no project-specific stages baked in). The kit reads it live and renders the steps +
  the resolved effective recipe per slot via the read-only `/agent-workflow-kit procedures <activity>`.
- [`references/agent-rules-lens.md`](references/agent-rules-lens.md) — the canonical **agent-rules
  lens** block (the planning/review/process-fidelity invariants). The kit renders it into a deployed
  `docs/ai/agent_rules.md` `### 2.x.` region (heading-anchored, no markers) and refreshes that region
  on bootstrap/upgrade — a canon wording change edits this file (plus the prior store below) and ships
  as an engine-only release.
- [`references/agent-rules-lens-priors.md`](references/agent-rules-lens-priors.md) — the **append-only
  store** of every lens body a previous release shipped. The kit refreshes a deployed region only when
  its body matches the fragment or one of these entries; a customized region is preserved verbatim.

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
