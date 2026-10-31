---
name: agent-workflow-engine
description: Canonical home of the agent-workflow planning methodology — the capped plan shape (goal and boundary, module ledger, verification), plan lifecycle, queue.md series index, mandatory Cleanup phase, the feature-spec canon (the durable per-feature contract layer with its frozen schema and Out-of-scope discipline), the bounded methodology fragment, the orchestration-recipe vocabulary (Solo / Reviewed / Council / Delegated / Subagent), and the activity-procedures canon (plan-authoring / plan-execution / routine / feedback-triage / epic / task, with typed recipe slots). A published, installable npm package (available:true) that *provides* the methodology text; it mutates nothing. The composition root (agent-workflow-kit) reads this canon LIVE from the installed engine and writes its fragments into the deployed entry point — one source of truth, no bundled mirror; `npx @sabaiway/agent-workflow-kit@latest init` installs the engine.
disable-model-invocation: true
metadata:
  version: '6.0.1'
---

# agent-workflow-engine

The **canonical source of truth** for the `agent-workflow` planning methodology. It is a
**published, installable npm package** (`capability.json` → `available:true`): it holds the
methodology text and **provides** it, but it ships no runtime and mutates no files. The kit reads
**this canon live from the installed engine** (resolved via the family `detect.installed` pattern)
and writes its fragments into the deployed entry point — **one source of truth, no bundled mirror**.
`npx @sabaiway/agent-workflow-kit@latest init` installs the engine as a core part of the kit; when the
engine is absent, the kit's reconcile **fails loudly** (never silently) and writes nothing.

## What it provides (`provides: ["plan"]`)

- [`references/planning.md`](references/planning.md) — the **plan canon**: the capped plan shape
  (Goal and boundary · Module ledger · Verification — literal headings), the subtraction rubric for
  review, the plan-file lifecycle (`docs/plans/*.md`, gitignored, never committed), the `queue.md`
  series index and the mandatory final **Phase: Cleanup**.
- [`references/specs.md`](references/specs.md) — the **feature-spec canon**: the durable per-feature
  contract layer under `docs/ai/specs/` (Contract · Scenarios · Out of scope · Module), the frozen
  schema (kinds, statuses, forward-only transitions, the numeric promotion threshold,
  the scenario-binding grammar, the refusal table the deployed reader enforces), governing specs
  cited per plan, the feature-vs-page precedence table, spec-driven feature-sliced architecture,
  and the retroactive onboarding path. The memory substrate's deployed reader
  `scripts/agent-workflow/spec-schema/spec-schema.mjs` is pinned against this canon by the engine's own test.
- [`references/methodology-slot.md`](references/methodology-slot.md) — the **bounded** fragment the
  composition root reads into a deployed project's `AGENTS.md`. A short summary that routes to the
  full reference, not the full reference itself.
- [`references/orchestration.md`](references/orchestration.md) — the canonical **orchestration-recipe**
  reference: the five recipes (Solo / Reviewed / Council / Delegated / Subagent) defined over the
  bridges' role vocabulary and the executor vehicle's `carry` role, the when/why decision guidance,
  the graceful-degradation lattice, and the quota/health guard. The kit owns the executable dispatch and surfaces it as `/agent-workflow-kit recipes`.
- [`references/orchestration-slot.md`](references/orchestration-slot.md) — the **bounded** one-line
  orchestration fragment the composition root reads into a deployed `AGENTS.md`. It names the
  five recipes and routes to `/agent-workflow-kit recipes`, never to this engine-internal reference.
- [`references/autonomy-slot.md`](references/autonomy-slot.md) — the **bounded** one-line autonomy
  fragment the composition root reads into a deployed `AGENTS.md`. It carries the
  cross-agent READ CONTRACT for the per-project autonomy policy (`docs/ai/autonomy.json`): read at
  session start, the canonical default floor when the file is absent, STOP on malformed — plus the
  honesty note that the policy is informational for delegated backends (enforcement stays the OS
  sandbox + the orchestrator). It routes to the kit's `set-autonomy` / `autonomy-doctor` surfaces,
  never to any engine-internal reference.
- [`references/procedures.md`](references/procedures.md) — the canonical **activity-procedures** canon:
  the ordered steps of the named activities (`plan-authoring`, `plan-execution`, `routine`, `feedback-triage`, `epic`, `task`) with **typed recipe
  slots** that bind to the orchestration recipes, composing with `planning.md` without restating it. It
  stays generic (no project-specific stages baked in). The kit reads it live and renders the steps +
  the resolved effective recipe per slot via the read-only `/agent-workflow-kit procedures <activity>`.
- [`references/rules/lens.md`](references/rules/lens.md) — the canonical **lens** rules theme (the
  planning/review/process-fidelity invariants). The composition root lays it down in a deployed
  project as the `lens` rules theme under `docs/ai/rules/` — a canon wording change edits this file
  and ships as an engine-only release.

## Ownership rule (the engine knows nobody)

The engine only **provides** text. It never reads, writes, or mutates any project file or any
sibling skill — in particular it never touches a deployed `AGENTS.md`. **Only the composition root
(`agent-workflow-kit`) writes these fragments into a deployed project.** This keeps the family a
DAG: the engine has no outbound edges.

## Status & roadmap

The engine is **no longer a stub**: it is a published, `available:true`, installable npm package
(`@sabaiway/agent-workflow-engine`). The kit reads **this canon live from the installed engine** and
writes its fragments into the deployed entry point — the old bundled mirror is **retired** (Plan
3D / AD-016): **one source of truth**. `npx @sabaiway/agent-workflow-kit@latest init` installs the
engine as a core part of the kit. See the kit's `tools/inject-methodology.mjs` (the entry-point block
reconcile) and `tools/engine-source.mjs` (the live read + fail-loud resolver).
