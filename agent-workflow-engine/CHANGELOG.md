# Changelog — @sabaiway/agent-workflow-engine

All notable changes to the methodology engine. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's `docs/ai/`
(which tracks the shared `agent-workflow` lineage, head `1.3.0`).

## 1.8.0 — Mechanize the §9 review-loop discipline (round cap · crossover · finding-origin)

A **feature** release. The methodology canon institutionalizes the review-loop economics so the round
cap, the crossover stop, and the finding-origin discipline stop being deletable prose:

- **`planning.md` §9** gains a *Fold minimally — a prose plan has no checker* bullet (a self-consistency
  read; fold minimally in ONE place), and the *Heavy review at the diff* bullet now names
  **backend divergence** as the crossover and routes an all-mechanics/CI or prose-only artifact to a
  **thin plan + diff-review**.
- **`orchestration.md` §4/§5** adds the **backend-divergence stop-signal**, reconciled with recipe
  fidelity: divergence bounds the *rounds*, never drops a ready backend within one.
- **`procedures.md`** requires a per-round emission **{round N · finding-origin tally · per-backend
  verdict}** at the loop point of *both* activities.

Guarded non-vacuously: `planning-`/`procedures-`/`orchestration-canon` gain region-scoped tokens; the
kit's `lens-mirror` registers the five review-loop tokens (Set-1) + the M6 `finding-origin` token (Set-2).
Deployment-lineage head stays `1.3.0` (no `docs/ai` migration).

## 1.7.0 — Harden the planning canon: process-fidelity + regression-free editing

A **feature** release. The methodology canon gains **seven invariants** that close recurring
process-fidelity slips and fold-induced churn — each pinned in its natural home and guarded by the engine
canon tests (+ the kit's extended cross-package `lens-mirror.test.mjs`):

- **`references/planning.md` §6 — *ExitPlanMode ≠ execute*.** A harness "approved — start coding" prompt
  authorizes the PLAN only; "continue in-session" is a DELIBERATE transition into `plan-execution` after
  the plan + cold-start prompt exist, never an implicit slide (disambiguates §6 vs the Definition of Done).
- **`references/planning.md` §9 — regression-free editing + the convergence bar.** *No code-mechanics in
  the plan*, *test-as-spec* (fold a code-touching finding into a red→green test, not prose),
  *characterize-first* (pin uncovered behavior before editing), *heavy review at the diff*, and a CLEAN
  loop defined as **0 blockers + 0 majors from every named backend** (folding ≠ convergence).
- **`references/orchestration.md` §4/§5 — *recipe fidelity*.** Council runs every ready backend **every
  round**; quietly dropping a ready backend is a forbidden silent downgrade (the converse of the
  unavailable-backend degrade), and the §5 quota guard is explicitly not a licence to drop one.
- **`references/procedures.md`** — terse pointers weave all of the above into both activity steps.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no migration); the npm
package version is a separate axis.

## 1.6.0 — Loosen the agy Issue-001 caveat (grounded review is sound)

A **feature** release. `references/orchestration.md` §5 reframes the `agy` health advisory: the grounded
`agy-review` contract removes agy's stale-model / partial-diff **false positives**, so `agy` is a **sound**
second opinion now — no longer something to merely avoid. The real **service-stall** caveat (Issue-001) is
kept — it is a separate risk that grounding does not remove — as is the codex-before-agy tie-break for
large / latency-sensitive substantive reviews and the `--add-dir` escalation path. The deployment-lineage
head stays **`1.3.0`** (no `docs/ai` structural change).

## 1.5.0 — Right-altitude & code-grounded folds in the canon

A **feature** release. The planning canon (`references/planning.md`, read **live** by the composition
root) gains a `## 9. Right-altitude & code-grounded folds` section + a §8 self-review bullet; the
activity-procedures canon (`references/procedures.md`) weaves a terse §9 review-lens pointer into the
rendered Self-review steps of **both** activities (binding to §9, not restating it). Two guards pin the
disciplines: a new `test/planning-canon.test.mjs` and an extended `test/procedures-canon.test.mjs`. The
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change); the npm package version is a
separate axis.

- **Right altitude.** A plan pins intent + architecture + invariants + acceptance criteria; fine
  code-mechanics are resolved at Execute, not spelled out in prose.
- **Fold by code, not prose.** Before folding a code-touching finding, read the cited `file:line` and cite it.
- **Convergence heuristic.** A stable architecture + recurring code-mechanism findings ⇒ raise the
  altitude or hand the mechanics to Execute.
- The procedures lens stays a terse pointer (the terseness invariant holds: `procedures.md` < `planning.md`).

## 1.4.0 — Durable session contracts in the canon: read-at-start, Definition of Done, communication

A **feature** release. The activity-procedures canon (`references/procedures.md`, read **live** by the
composition root) gains three durable-session contracts, and the two bounded slot fragments gain the
matching clauses so the composition root's canonical-refresh can push them to existing deployments:

- **Read-at-start.** The canon tells the agent to read the project's standing recipe preference in
  `docs/ai/orchestration.json` at the start of a planning/execution session (set it with the `set-recipe`
  writer) — no re-asking what is already configured.
- **plan-authoring Definition of Done.** A planning session must produce a self-contained plan **and** a
  cold-start execution prompt for the next session — both **without the user asking**.
- **Communication contract.** User-facing messages deliver the artifact **inline** (never a bare "see
  §X" as a substitute), lead with the result, with a large-artifact carve-out.
- **Slot fragments.** `orchestration-slot.md` gains the read-at-start clause (points at `set-recipe`);
  `methodology-slot.md` gains the communication clause. Both stay one bounded content line, under the
  deployed-`AGENTS.md` cap.

Generic as ever — no project release-publishing bake-in. The deployment-lineage head stays **`1.3.0`**
(stamp-independent reconciles reach the base; the engine **package** version is a separate axis).

## 1.3.0 — Activity procedures: named, recipe-aware playbooks

The engine now also owns the **activity-procedures** canon — *how to perform* a named workflow
activity, as ordered steps with **typed recipe slots** that bind to the orchestration recipes (Solo /
Reviewed / Council / Delegated). Two v1 activities: **`plan-authoring`** (slot: `review`) and
**`plan-execution`** (slots: `execute`, `review`). The canon composes with `planning.md` (it binds to
the §7 structure, §8 self-review, and §4 Cleanup without restating them) and stays **generic** — it
bakes in no single project's stages, deferring any project-declared release/publishing to that
project's `workflow:methodology` slot. The kit reads this canon **live** and surfaces a read-only
`/agent-workflow-kit procedures <activity>` that renders the steps + the resolved effective recipe per
slot (from `docs/ai/orchestration.json` + backend readiness).

### Added
- **`references/procedures.md`** — the canonical activity-procedures canon: `plan-authoring` +
  `plan-execution` as `## <activity>` sections, each opening with a machine-parseable `Slots:` line
  (the only line the kit parses, drift-guarded against its activity table). It carries the
  load-bearing "Delegated → dispatch execution first" rule and restates the commit contract as a
  commit-BOUNDARY rule (when an activity has a commit boundary the orchestrator owns that commit; a
  backend never commits — `plan-authoring` ends at approval with no commit, `plan-execution` commits
  per Step).

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file). The
npm package version is a separate axis.

## 1.2.0 — Orchestration recipes: a named vocabulary for composing the bridges

The engine now also owns the **orchestration-recipe** canon — the named patterns an agent uses to
compose the optional execution-backends (the `codex` / `agy` bridges) into `plan → execute → review`.
Four recipes, built over the bridges' role vocabulary: **Solo** (no backend — the floor), **Reviewed**
(one backend reviews), **Council** (both review, you synthesize), **Delegated** (a backend executes a
bounded sub-task). The orchestrator always owns the decisions and the single commit; a backend is
advisory or delegated, never autonomous. The kit reads this canon **live** and surfaces a read-only
`/agent-workflow-kit recipes` advisor that plans a recipe for the current environment.

### Added
- **`references/orchestration.md`** — the canonical narrative: the four recipes over the role
  vocabulary, the when/why decision guidance, the graceful-degradation lattice (Council → Reviewed →
  Solo; Delegated → Solo, always with a stated reason), and the quota/health guard.
- **`references/orchestration-slot.md`** — the bounded **one-line** fragment the composition root
  injects into a deployed `AGENTS.md` (between the `workflow:orchestration` markers). It names the four
  recipes and routes to `/agent-workflow-kit recipes` — never to this engine-internal reference.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file). The
npm package version is a separate axis.

## 1.1.0 — Live-read ready: never-downgrade gate + installer hardening

The kit now reads this canon **live from the installed engine** and has retired its bundled mirror
(see the kit's 1.11.0 / **AD-016**). This release hardens the engine's own installer to match — so an
engine placed by `npx … kit init` (or by hand) is safe to refresh.

### Added
- **Never-downgrade gate** (cloned from the kit, AD-012): a bare `npx … init` that npx serves from an
  **older cached build** can no longer overwrite a **newer** installed canon — `init` compares the
  on-disk version (no network) and refuses loudly unless you pass `--allow-downgrade`. A same-version
  re-run prints a cache hint and points at `@latest`. An existing but **unreadable** `SKILL.md` fails
  closed (the gate is never silently bypassed).

### Fixed
- Containment check now accepts a legitimately-contained child literally named `..foo` (it wrongly
  rejected anything starting with `..` before); `tildify` collapses only a **leading** `$HOME`, never
  a mid-path occurrence (**Issue-004**, fixed in lockstep with the memory installer).

### Changed
- The installer is importable without side effects (the `isDirectRun` guard) and exports its
  path/format helpers for in-process tests. The installer's own bare `npx … init` strings now use
  `@latest`.

## 1.0.0

First publish. The canonical home of the `agent-workflow` planning methodology is now an
installable, `available:true` npm package — no longer a declared, content-only stub.

### Added
- Standalone npm package + `bin/install.mjs` installer targeting
  `~/.claude/skills/agent-workflow-engine` (`AGENT_WORKFLOW_ENGINE_DIR`), with a
  symlink-traversal guard — the installer never writes *through* a destination symlink
  (root / intermediate / leaf), and never copies the npm wrapper into the skill dir.
- `capability.json` flipped to `available:true` with `detect.installed` +
  `install.npm` (`@sabaiway/agent-workflow-engine`). It still only `provides: ["plan"]`
  (the methodology text) with no callable command — it mutates nothing.

### Notes
- The canon itself — `references/planning.md` (the full methodology) and
  `references/methodology-slot.md` (the bounded slot fragment) — is unchanged; this release
  packages it for npm.
- The composition root (`agent-workflow-kit`) still consumes a **byte-identical,
  drift-guarded mirror** of this canon bundled inside the kit. The live `kit → engine` read
  and retiring that mirror land in the next slice.
- The deployment-lineage head stays **`1.3.0`** — packaging the engine changes only the npm
  axis, not any deployed project's `docs/ai` structure.
