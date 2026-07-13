# Changelog — @sabaiway/agent-workflow-engine

All notable changes to the methodology engine. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's `docs/ai/`
(which tracks the shared `agent-workflow` lineage, head `2.0.0`).

## 1.17.0 — Prompt-economy canon gains a writer-batch clause + two sandbox-lane sentences (REPORT-FACTS train D5/D6, AD-054)

A **feature** release (ships with kit 1.47.0 / memory 2.3.0 / bridges 2.7.0+2.6.0). The cost-lanes
canon (`references/orchestration.md` §5) and the agent-rules lens gain:
- **Writer economy** — a stage's repeated WRITER commands batch into ONE invocation (the review-ledger
  triad rides one batched write, other stage writers combine via one launcher per stage); never one
  writer call at a time. Rendered on all three prompt-economy surfaces (orchestration §5, the lens
  fragment, the kit cost-lanes advisor), the lens re-rendered into both templates, and the outgoing
  lens body appended to the append-only prior store.
- **Sandbox lanes** — two sentences under the sandbox-lanes block: (i) a **pre-dispatch host-diff**
  (before the first dispatch of each bridge, diff its manifest `networkHosts` against the live sandbox
  allow-list — a missing host is surfaced to the maintainer, never fired into a known prompt); (ii)
  **nested-sandbox honesty** (a backend CLI shipping its own OS sandbox cannot run nested inside a
  harness sandbox — route it outside on the OBSERVED failure, never a preemptive blanket).

## 1.16.0 — Prompt-economy canon: the cost lanes learn autonomy-preserving dispatch (REC-UX-REWORK D7, AD-053)

A **feature** release (ships with kit 1.46.0 / memory 2.2.0). The cost-lanes canon
(`references/orchestration.md` §5) gains the **prompt-economy clause**: (a) read-only fan-out
(research / sweeps / extraction) runs ONLY on restricted-tool vehicles — a full-tool subagent for
read-only work is a forbidden lane downgrade (an invisible prompt-flood plus blast radius, not just
tokens), and a subagent is never instructed to shell out for facts obtainable read-only; (b) the
orchestrator's own shell form is ONE plain pipeline per call (a `;`/`&&` chain or env-prefixed
invocation never matches a prefix allow rule); (c) a fan-out LAUNCHER that gates per call yields to
the agent-spawn lane — **capability-gated**: without restricted-tool vehicles (a host offering only
full-tool agents included), read-only research stays in the orchestrator's own context, never a
vehicle mandate a host cannot satisfy.
The quality/speed guard rides in canon (the clause narrows TOOLS for read-only work only —
judgment, code, synthesis stay at the frontier lane) with the honest limit stated (no deterministic
gate classifies a dispatch — enforcement is canon at the point of use + placed vehicles + the retro
loop). The `agent-rules-lens.md` cost-lanes line carries the same clause (the outgoing body is
appended to the append-only prior store, so unmodified in-the-wild deployments converge on first
touch); one distinctive token per invariant is drift-guarded on all three surfaces (canon · the kit
advisor render · the lens).

## 1.15.0 — Canon autonomy prose + the sandbox cost-lane (AD-044 Plan 4)

A **feature** release (ships with kit 1.45.0 / memory 2.1.0). This publish delivers the Plan-3
`autonomy-slot.md` fragment to the install base — the third AGENTS.md `workflow:autonomy` slot
finally fills everywhere, so the kit's `ENGINE_FRAGMENT_CAVEATS` soft-skip residual retires on
refresh. Canon additions, appended without renumbering: orchestration.md trailing **§7
Checkpoint-bounded autonomy** (sandbox-as-floor, red-lines always-ask, informational for delegated
backends — enforcement stays the OS sandbox + the orchestrator); planning.md trailing **§10**
(autonomy at plan/execution checkpoints); procedures.md gains the read-at-start clause beside its
preamble. orchestration.md §5 gains the sandbox cost-lane token (sandbox-safe L0 surfaces ·
genuinely-unsandboxed bridge wrappers · command-shape-dependent npm-cache commands; move only the
failing command out of the sandbox, batch consecutive unsandboxed calls) — parity-pinned on both
the engine and kit sides.

## 1.14.1 — npm 12 tarball-guard compat + the lineage-head preamble correction

A **patch** release (no canon content change; co-released with memory 2.0.0 + kit 1.42.0 — the
one-file-per-ADR store, AD-051). Two housekeeping fixes: the monorepo tarball-guard test now
accepts both `npm pack --json` output shapes (an array on npm ≤11, an object keyed by package name
on npm ≥12 — environment compat, assertions unchanged), and this changelog's standing preamble
tracks the deployment-lineage head bumped by the co-released memory MAJOR (`1.3.0` → `2.0.0`; the
head lives in the family's shared stamps, not in this package's version).

## 1.14.0 — The review canon names its computed instrument, activity-aware (AD-046)

A **feature** release (canon content + guards; installer unchanged; deployment-lineage head stays
`1.3.0` — no migration). The kit's review-round ledger (AD-045 / AD-046) is now NAMED by the canon,
at the right activity scope:

- **`references/procedures.md`** — the plan-**execution** review step names the ledger (record ·
  `--status` · `--check` as the loop's gate; the exit contract stays in the tool's own header —
  point, don't restate); the review steps of BOTH activities gain the triage classification
  vocabulary (`fixable-bug / inherent-layer-residual / escalate`; a minor never forces triage);
  plan-**authoring** carries NO tool pointer — the ledger is plan-execution-scoped.
- **`references/planning.md` §9** — a new **"Computed instrument (plan-execution)"** paragraph: the
  stop decision is READ from the ledger, never remembered; stated neutrally that the same per-round
  tally + classification discipline governs plan-authoring review.
- **Drift-guards in BOTH directions** — `test/procedures-canon.test.mjs` pins the pointer INSIDE the
  plan-execution review step (a step extractor, not a whole-section match) and its ABSENCE from
  plan-authoring; `test/planning-canon.test.mjs` pins §9's ledger naming + the exact scope phrase.
  Lens files untouched (the 22 discipline tokens unchanged).

## 1.13.0 — The agent-rules lens gets its ONE canonical home here (slot-render, AD-041)

A **feature** release (canon content + its guard; installer unchanged; deployment-lineage head
stays `1.3.0` — no migration). The planning/review/process-fidelity lens block that used to be
hand-mirrored across the family's `agent_rules.md` templates now lives HERE, once:

- **`references/agent-rules-lens.md`** — the canonical lens block (number-neutral `### 2.x.`
  heading). Its intro now carries the provenance clause (rendered from the canon; refreshed on
  upgrade; a custom edit is preserved verbatim, but flagged). The family kit renders this into a
  deployed `docs/ai/agent_rules.md` region and refreshes it on bootstrap/upgrade.
- **`references/agent-rules-lens-priors.md`** — the **append-only store** of every lens body a
  previous release shipped (all 4 historical vintages harvested from the template git history,
  including the outgoing pre-1.13.0 body). The frozen delimiter format is documented in-file.
  A future canon wording change edits the fragment AND appends the outgoing body — both files
  in THIS package, so it ships as an **engine-only release** (the AD-041 measurement clause).
- **`test/lens-fragment.test.mjs`** — canon-presence guard: the 22 discipline tokens (the single
  token list going forward), heading shape, path-neutrality, priors shape + the computed
  pre-1.13.0 membership, injected non-vacuity; CRLF-tolerant reads.
- `SKILL.md` / `README.md` payload lists name the two new files (slot-fragment counts went
  count-free). Tarball 12 → 14 files, pinned by `package-content.test.mjs`.

## 1.12.0 — Plans carry a home for review-settled decisions (§7 optional `## Decisions (locked)`)

A **feature** release (canon text + its tests; installer unchanged; deployment-lineage head stays
`1.3.0` — no migration). Decisions a plan's review loop SETTLED (fixtures, contracts, boundary
clauses) now have a canonical, machine-extractable home:

- **`references/planning.md` §7** — the plan-document structure gains one optional row after
  `## Approach`: `## Decisions (locked) ← optional: settled, binding decisions the executor must
  not re-litigate`. The heading string is load-bearing: the kit's grounded-review facts assembler
  (`grounding.mjs`, AD-038) extracts the section by exact-heading match.
- **`references/planning.md` §8** — one checklist bullet: decisions the review loop settled live
  under the optional `## Decisions (locked)` heading — binding for the executor, never re-litigated
  at Execute.
- **`test/planning-canon.test.mjs`** — pins the exact §7 row (heading + optional + executor-binding
  wording, positioned after `## Approach`) and the §8 mention.

## 1.11.0 — Plans carry only checked syntax (the §9 checked-vs-unchecked boundary)

A **feature** release (canon text + its tests; installer unchanged). The §9 "No code-mechanics in
the plan" rule now names a hard discriminator for what syntax plan prose may carry:

- **`references/planning.md` §9 (B5)** — **checked syntax**: a Step's exact paths + commands stay
  REQUIRED (§7/§8) and count as checked because the plan's own Verification runs them against an
  explicit expected outcome or gate — merely running without asserting checks nothing; the only
  other syntax a plan may carry is a literal fixture/schema fragment a named test copies or
  validates. **Un-run, logic-bearing syntax** — control-flow, a regex, a glob, a grammar, an
  algorithm body, a mini-DSL, anything that transforms data or evaluates a condition — never lives
  in plan prose, however plausible or shell-verified it looks ("I ran it in my shell" is not a
  checker): a fold or draft that wants one writes the red→green test-as-spec at Execute instead.
- **`references/procedures.md` plan-authoring step 5** — the terse mirror of the same boundary at
  the point of use (the kit advisor prints this section verbatim).
- **Lockstep tests** — `planning-canon.test.mjs` (§9 it-block) and `procedures-canon.test.mjs`
  (Set-1) pin the two new tokens `checked syntax` + `logic-bearing`; non-vacuity proven by an
  injected red→green in both guards.

## 1.10.0 — Cost-lane vocabulary in the orchestration canon (§5)

A **feature** release (canon text + its tests; installer unchanged). Work now has named **cost
lanes**, and the canon states who runs what:

- **`orchestration.md` §5 defines the lanes** — **L0** deterministic script · **L1** cheap
  subagent (small model, low effort, read-only tools) · **L2** subscription bridge · **L3**
  frontier — plus the two routing rules: route every step to the **cheapest adequate executor**,
  and **a step with no named guardrail does not move down** a lane. The **red lines never move
  down**: council review models · real code · ADR/plan/handover/changelog-entry wording ·
  persuasive copy · go/no-go · the maintainer approval asks. Asymmetric pairing (cheap drafts,
  a deterministic tool or the frontier verifies) and the incident-repair default (salvage
  recorded state first, never frontier re-derivation) are canon now.
- **Lockstep tests** — `test/orchestration-canon.test.mjs` pins the four lane tokens, both
  routing rules, the red-line list, and that §5 stays generic (the L0 examples name the family's
  own surfaces — the gate runner over `docs/ai/gates.json`, the rotation checks — never a
  project's publish mechanics); `test/procedures-canon.test.mjs` pins the same canon tokens the
  composition root's advisor paraphrases, so the two cannot silently drift apart.

## 1.9.0 — Honest installer messaging: the verb states what was observed, the note states facts

A **feature** release (installer output contract only; the canon text is unchanged). `bin/install.mjs`
no longer claims "updated the canon to vX" on every run and no longer accuses the npx cache on a
same-version re-run:

- **The final verb is keyed on the OBSERVED version comparison**, never on mere presence: fresh or
  legacy/unstamped → `installed` (no transition claim when the prior version is unknowable); older →
  `updated the canon to vX`; same → `refreshed the already-current canon`; newer → `downgraded the
  canon to vX` (reachable only under the explicit `--allow-downgrade`).
- **The same-version note states observable facts only** — the copy still ran (a re-run repairs
  locally modified or deleted files) — plus a CONDITIONAL hint: *if you expected a newer version*,
  invoke the `@latest` tag explicitly. The "npx likely served a cached build" accusation is gone
  (not observable without a network check).
- The never-downgrade gate, its refusal wording, and the read-before-write ordering are untouched.

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
