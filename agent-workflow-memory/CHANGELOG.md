# Changelog — @sabaiway/agent-workflow-memory

All notable changes to the memory substrate. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's
`docs/ai/.memory-version` (which tracks the shared `agent-workflow` lineage, head `2.0.0`).

## 2.3.0 — agent_rules template: a report-facts Communication bullet + the writer-batch lens re-render (REPORT-FACTS train, AD-054)

A **feature** release (ships with kit 1.47.0 / engine 1.17.0 / bridges 2.7.0+2.6.0; the deployment
lineage head stays `2.0.0` — no deployed-`docs/ai` structure change). The bundled `agent_rules.md`
template gains:
- **§2.5 Communication — a report-facts bullet.** Any claim about the current host or session state
  (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts)
  must trace to **live tool output** from **this session**; a memory/handover snapshot is **context,
  never report facts**, and an unbacked claim is **omitted or explicitly marked unverified**. The
  report-facts twin lands in the memory template only (the kit template carries no §2.5 Communication).
- **§2.6 lens re-render.** The planning/review lens gains the writer-economy clause, kept in parity
  with the engine lens fragment by the lens-mirror guard.

## 2.2.0 — agent_rules template re-render: the lens gains the prompt-economy clause (REC-UX-REWORK D7, AD-053)

A **feature** release (ships with kit 1.46.0 / engine 1.16.0; the deployment lineage head stays
`2.0.0` — no deployed-`docs/ai` structure change). The bundled
`references/templates/agent_rules.md` §2.6 lens block is re-rendered to the current engine canon:
its cost-lanes line now carries the **prompt-economy clause** (read-only fan-out on restricted-tool
vehicles only; one plain pipeline per call; capability-gated launcher guidance; judgment, code and
synthesis stay at the frontier lane; the stated honest limit). Template-only — seeding, upgrade and
every other substrate behavior are unchanged; the render is byte-parity-pinned against the engine
fragment by the kit's lens-mirror guard.

## 2.1.0 — Autonomy template seed (AD-044 Plan 4)

A **feature** release (ships with kit 1.45.0 / engine 1.15.0; the deployment lineage head stays
`2.0.0` — the seed is ensure-if-missing, stamp-independent). `references/templates/autonomy.json`
— the sparse, defaults-equivalent autonomy-policy seed (`_README` only): resolving it equals
resolving no file at all, TEST-PINNED, so the seed can never drift from the computed defaults
(commit/push/publish `ask`; network/credentials/fs-outside-repo `deny`; absent activities floor at
`prompt`); it is STRUCTURALLY a seed (meta keys only) — an explicit policy declaring the same
values reads as a real declaration on every kit surface. Lifecycle follows gates.json: bootstrap
seeds it, upgrade ensures-if-missing (byte-preserving), hand-editable; the kit mirrors it via the
template manifest. Tarball sentinel 43→44. Deliberately NOT a delegated-bootstrap required asset
(the AD-044 Plan-3 no-gate decision holds).

## 2.0.0 — One-file-per-ADR store: the 3-tier decisions cascade retired (AD-051)

A **MAJOR** release (BREAKING; co-released with the workflow kit 1.42.0). The deployment-lineage
head bumps `1.3.0` → `2.0.0` — the first structural `docs/ai` change (a new `docs/ai/adr/` tree;
the WARM/COLD decisions-archive monolith tiers retired). **Nothing auto-migrates:** an existing
deployment keeps working on its old layout, old rotator included, until it opts in (below).

**Breaking.**
- `references/scripts/archive-decisions.mjs` is REPURPOSED in place (same path, same pre-commit
  hook slot, same `decisions-rotation` gate id): instead of rotating HOT `decisions.md` → WARM
  `history/decisions-archive.md` → a single COLD monolith whose cap was raised release after
  release, the rotator now EXPLODES the oldest ADRs beyond the HOT cap into one immutable MADR
  record per ADR at `docs/ai/adr/AD-NNN-slug.md` (body verbatim; inline 6-field frontmatter +
  `status`/`date`/`supersedes`/`supersededBy` lifecycle keys; slug frozen at creation). A record
  is O(1) forever — no archive cap is ever raised again, and there is no COLD tier to exhaust.
- A default or `--check` run that finds a legacy `history/decisions-archive*.md` monolith fails
  LOUD ("run `--migrate` first") — the new rotator never half-explodes an un-migrated tree and
  never reports green over one.
- The ADR id grammar widens to `AD-\d{3,}` with NUMERIC ordering everywhere (AD-200 precedes
  AD-1000 — never lexical).

**Migration (opt-in, never automatic).**
- The one-time `--migrate` (dry-run by default; `--migrate --apply` to write) explodes the
  monolith tiers into `adr/` records under a fail-loud conservation check: the full ADR corpus —
  the union HOT ∪ monolith tiers ∪ any already-written `adr/` records (the crash-resumable core;
  a same-id BODY CONFLICT across sources is refused) — must repartition EXACTLY into retained-HOT
  ∪ written records, nothing lost, added, double-counted, or edited. Before any destructive write
  it stores a durable timestamped snapshot of `decisions.md` + both monoliths into the GIT DIR
  (a stated out-of-tree fallback on a non-git deployment; fails loud if neither is writable).
  `docs/ai` is commonly git-ignored, so git history alone can NOT recover a deleted monolith —
  the snapshot is the recovery path. The apply is idempotent and crash-resumable; removal never
  precedes conservation + the snapshot.
- On an upgrade crossing this major, `bin/install.mjs` prints a GENERIC one-time advisory: run
  your workflow toolkit's ADR-store migration command in each already-deployed project (it
  snapshots, refreshes the enforcement scripts, and migrates in one consent-gated step). This
  installer targets the global skill dir and never touches a project itself.

**New.**
- `docs/ai/adr/log.md` — the ON-DEMAND active-set navigator: currently-governing heads
  (supersession COMPUTED corpus-wide from the two-way `supersedes`/`supersededBy` chain — a new
  superseding ADR needs no predecessor-file edit) + a recent window; a superseded record drops out
  of the list but stays reachable by filename, grep, and the chain. `--write-navigator`
  regenerates it AND re-triggers the docs-index regen. No committed full O(n) ledger.
- `references/scripts/check-docs-size.mjs` — `docs/ai/adr/` collapses to ONE aggregate `index.md`
  row (`adr/ — N records (AD-001 … AD-NNN)`), while every record body stays individually
  cap-checked; `docs/ai/index.md` stays bounded at O(1) as records accumulate.
- Seeded templates: the new-scheme `decisions.md` HOT-window seed, the `adr-record.md` MADR
  authoring reference (a skill-side reference — never copied into a project's `docs/ai/`), and a
  seed `adr/log.md` byte-equal to the generator over the seeded HOT — a fresh bootstrap is
  `--check`-green on its first commit.

## 1.12.0 — Verification-profile template + the docs-index-on-rotation regen (BUGFREE-3, AD-049)

A **minor** release (deployment-lineage head stays `1.3.0` — no migration; co-released with the
workflow kit 1.40.0). The memory substrate gains the optional verification-profile config and closes
the docs-index-goes-stale-on-rotation cost (economics item (h)).

- **Verification-profile template** — a new seeded `references/templates/verification-profile.json`
  (`schema:1`; the kit reads it, kit 1.40.0) is created on bootstrap and ensured-if-missing on
  upgrade (the `gates.json` / `orchestration.json` twin); `SKILL.md`'s bootstrap/ensure prose now
  names it. An **absent profile reproduces today's V8 + node:test behaviour exactly** — it only ADDS
  an opt-in default a consumer edits for its own language/runner.
- **(h) a rotation regenerates `docs/ai/index.md`** — `references/scripts/archive-decisions.mjs`
  regenerates the docs index after a successful rotation write (moves OR a normalize-only rewrite) by
  reusing the now **root-parameterized** `check-docs-size.mjs --write-index --report` (the `--report`
  isolates the index-write outcome from the docs-cap-check, so a benign over-cap sibling never reads
  as a regeneration failure), with a loud instruct on absence/failure. An ADR rotation no longer
  leaves the index stale to trip the `--check-index` gate mid-release-matrix.
- **§2.2 minimal-comments** — the `agent_rules` template states comments as minimal / only-vital,
  a BASELINE a consumer project may tighten (e.g. comments forbidden entirely).

## 1.11.1 — One batched setup prompt (the F11 ask reword; AD-042)

A **patch** release (prose reword only; deployment-lineage head stays `1.3.0` — no migration).
The three bootstrap setup questions (visibility / conversational language / attribution) are now
asked as **ONE structured multi-question prompt where supported** (`AskUserQuestion`, up to 4
questions per call), each answer recorded individually, nothing written until ALL are answered —
first contact interrupts once, not three times (`SKILL.md` bootstrap preamble + steps 2–4). The
upgrade path batches its two migration asks the same way ONLY when both `AGENTS.md` blocks are
missing (a pre-1.1.0 deployment), collecting them in step 4 BEFORE the migrations apply and never
re-asking a collected answer (a migration's own "Ask the user" step stays the standalone
fallback). The `references/contracts.md` ask paragraph is reworded byte-identical with the kit's
copy — pinned cross-package by the kit's new `ask-contract` test.

## 1.11.0 — The template lens block becomes a render of the engine canon (AD-041)

A **feature** release (template text only; deployment-lineage head stays `1.3.0` — no migration).
`references/templates/agent_rules.md` §2.6 (the planning/review/process-fidelity lens block) is
now a **render of the engine's canonical `agent-rules-lens` fragment**: the intro gains the
provenance clause (rendered from the canon; refreshed on upgrade; a custom edit is preserved
verbatim, but flagged). Standalone-first is unchanged — the template still seeds the complete
block with no kit/engine present; an unmodified older seed converges to the current canon at the
next kit bootstrap/upgrade touch (the kit's new `lens-region` reconcile matches it against the
engine's known-prior store). Future lens wording changes no longer require a memory release.

## 1.10.0 — Installer verb parity (the AD-034 cmp-keyed contract) + the recipe discovery step in the templates

A **feature** release (installer messaging + template text; deployment-lineage head stays `1.3.0`
— content-only, no migration):

- **`bin/install.mjs`** — the install verb is now keyed on the OBSERVED version relation, never on
  mere presence (closing the false `updated the substrate to vX` on an already-current machine):
  fresh/legacy-unstamped → `installed`; older → `updated the substrate to`; same →
  `refreshed the already-current substrate` + the fact-only repair-on-rerun note (never a cache
  accusation; conditional `@latest` hint); newer → a loud **never-downgrade refusal** (nothing
  written) unless `--allow-downgrade`, which then says `downgraded the substrate to` plainly. The
  installed version is read from the target SKILL.md `metadata:`-scoped `version` (decoy-proof);
  an existing-but-unreadable SKILL.md **fails closed**, never silently treated as legacy. Helpers
  cloned INLINE (this package references no sibling — the knows-nobody DAG).
- **`bin/install.test.mjs`** — the full engine-shape contract suite: no-op re-run wording,
  downgrade refusal + `--allow-downgrade`, fail-closed unreadable SKILL.md, legacy no-stamp,
  metadata-decoy version read.
- **`references/templates/agent_rules.md` §1.1** — new step 2: read `docs/ai/orchestration.json`
  (the CONFIGURED orchestration recipes) BEFORE picking a task; a silent recipe downgrade is a
  forbidden substitution. **`references/templates/handover.md`** — a standing `**Active recipes:**`
  slot line. Both regions byte-identical with the kit template copies, path-neutral (this substrate
  names no sibling skill), guarded by the kit's `template-region-parity.test.mjs` (AD-038).

## 1.9.0 — The agent_rules lens carries the checked-vs-unchecked plan boundary

A **feature** release (template text only; scripts and installer unchanged; deployment-lineage
head stays `1.3.0` — content-only, no migration). The §2.6 lens B5 bullet mirrors the engine's §9
sharpening:

- **`references/templates/agent_rules.md` (B5)** — a plan carries only **checked syntax** (a
  Step's commands, run by its own Verification against an explicit expected outcome or gate) plus
  literal fixture/schema fragments a named test copies or validates; **un-run, logic-bearing
  syntax** (control-flow, a regex, a glob, a grammar, an algorithm body, a mini-DSL) never lives
  in plan prose — a fold or draft that wants one is the trigger to write the test instead. The
  line stays byte-identical to the kit template (lens-mirror guarded).

## 1.8.0 — ADR-cascade rotation script + the seeded per-project gate declaration

A **feature** release (deployment-lineage head stays `1.3.0`; the new surfaces reach existing
deployments via stamp-independent ensures, no migration file). The last hand-rolled docs
rotation — the `decisions.md` ADR cascade — is now a script, and every project gains a
hand-editable gate declaration:

- **`references/scripts/archive-decisions.mjs` (+ test)** — the `archive-changelog.mjs` sibling:
  a chained three-tier cascade (HOT `decisions.md` → WARM `history/decisions-archive.md` → COLD
  `history/decisions-archive-early.md`), caps read from each file's own frontmatter `maxLines`.
  Whole entries move, oldest first; the id multiset and every entry's line count are
  conservation-checked before any write. **Fail-LOUD**: a non-canonical `## AD-0NN — <title>`
  heading, disordered ids, a cross-tier duplicate, or a roll that would not fit COLD's remaining
  headroom all refuse **before any write** (a cap raise is a maintainer decision — the script
  only moves entries). `--check` reports per-tier `lines/cap`; on a project **without**
  `decisions.md` it exits 0 with a **stated skip** — a deliberate divergence from
  `archive-changelog.mjs` (the deployed pre-commit hook must never block a commit over an absent
  ADR substrate).
- **The pre-commit hook runs it** — `install-git-hooks.mjs` adds `archive-decisions.mjs --check`
  to the installed gate line-up.
- **`references/templates/gates.json`** — the seeded, user-editable per-project **gate
  declaration** (`{ id, title, cmd }`, strict JSON, an empty list as shipped; `cmd` is ONE bash
  command line). Bootstrap seeds it; upgrade **ensures-if-missing and preserves an existing file
  byte-for-byte**. It declares WHAT to check — the runner lives in the composition root, never
  here.
- **Stamp-independent ensures (equal-head deployments self-heal)** — the upgrade procedure now
  ensures BOTH seeded `.json` configs **and** the `archive-decisions` script pair
  (copy-if-missing into `scripts/`, never overwriting an existing file); an old hook without the
  decisions line stays consistent-safe until the next hook refresh.
- **Tests** — 22 cascade tests (fixtures for the chained roll, the COLD-exhaustion refusal, the
  absent-file `--check` skip, determinism, range-token maintenance); bootstrap/ensure coverage
  extended in `standalone-bootstrap.test.mjs`; tarball content re-pinned (40 files, reverse pins
  for every new asset).

## 1.7.0 — Humanize the deploy/version report (memory)

A **feature** release (report-prose only — the atomic stamp-WRITE mechanics and the *Stamp = lineage
head, not package version* gotcha are unchanged; deployment-lineage head stays `1.3.0`, no migration).

The substrate's upgrade report no longer surfaces the internal `docs/ai` **structure version**
(`.memory-version`) on the happy path:

- A zero-diff equal-head upgrade says **settings already current — no update needed**; a writeful
  reconcile (a footprint move / config seed) instead reports **what changed** and asks before commit.
  A fresh bootstrap keeps its deploy-success framing. Neither shows the structure number.
- The number surfaces only at the never-downgrade **STOP** gate and on an **explicit user ask** (a
  read-only answer that writes nothing) — named "the `docs/ai` structure version", never "lineage
  head", with a plain two-axes note (*Version disclosure*). Memory adds **no status mode** (the one
  intended kit↔memory asymmetry).
- Pinned by a new static contract test (`scripts/skill-report-contract.test.mjs`).

## 1.6.0 — §2.6 carries the review-loop economics disciplines (memory)

A **feature** release. The `agent_rules.md` substrate **§2.6** lens gains the review-loop economics
disciplines — *Fold minimally* (a self-consistency read), the extended *Heavy review at the diff*
(**backend divergence** = the crossover; **thin plan + diff-review**), and a *Per-round emission*
**{round N · finding-origin · per-backend verdict}** — kept **byte-identical** to the kit's §2.5 block and
guarded by the kit's cross-package `lens-mirror` two-set drift test. Substrate/docs only; deployment-lineage
head stays `1.3.0` (no migration).

## 1.5.0 — §2.6 carries the planning/review/process-fidelity invariants (memory)

A **feature** release. The `agent_rules.md` substrate **§2.6** is generalized from *Right-altitude &
code-grounded* to **Planning, review & process-fidelity invariants** — the always-loaded,
read-before-any-code-change lens now carries all **seven** methodology invariants: fold by code, right
altitude, no code-mechanics, test-as-spec, characterize-first, heavy review at the diff, the convergence
bar (0 blockers + 0 majors), recipe fidelity, and ExitPlanMode ≠ execute. Wording stays **path-neutral**
(the substrate "knows nobody"). The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural
change, no migration); the npm package version is a separate axis.

- **Seed-or-preserve only (unchanged contract).** A NEW deployment gets the §2.6 lens from the seed;
  refreshing an already-deployed file is the composition root's job.
- **Template parity preserved** — the §2.6 block body stays byte-identical to the kit fallback template
  (only the heading number differs), pinned by the kit's cross-package `lens-mirror.test.mjs` (now over
  two scoped, non-vacuous token sets).

## 1.4.0 — §2.6 right-altitude & code-grounded lens (memory)

A **feature** release. The `agent_rules.md` substrate gains a **§2.6 Right-altitude & code-grounded
(planning + review)** self-review subsection — fold by code (read + cite the `file:line`), pin
intent/invariants/acceptance, and the convergence heuristic. Wording is **path-neutral** (the substrate
"knows nobody": it points at "the project's planning methodology / workflow-methodology canon", never a
sibling/engine path). The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no
migration file); the npm package version is a separate axis.

- **Seed-or-preserve only (unchanged contract).** A NEW deployment gets the §2.6 lens from the seed;
  refreshing an already-deployed file is the composition root's job.
- **Template parity preserved** — the §2.6 block body stays byte-identical to the kit fallback template
  (only the heading number differs), pinned by the kit's cross-package `lens-mirror.test.mjs`.

## 1.3.0 — Agent-writable config note; §2.5 Communication (memory)

A **feature** release. The seeded `docs/ai/orchestration.json` note now frames the config as
agent-writable (via the `set-recipe` writer) **and** still hand-editable — the old "never written for
you" wording is gone. The `agent_rules.md` substrate gains a **§2.5 Communication** self-review item
(deliver the artifact inline; lead with the result; large-artifact carve-out). The deployment-lineage
head stays **`1.3.0`** (no `docs/ai` structural change, no migration file); the npm package version is a
separate axis.

- **Seed-or-preserve only (unchanged contract).** This substrate still only **seeds** the config from its
  template when missing and **preserves** an existing one byte-for-byte — a NEW deployment gets the updated
  note from the seed. Refreshing the note *in place* on an already-deployed file is the **composition
  root's** job (memory stays standalone and owns no cross-package refresh helper).
- **Template parity preserved** — the seeded `orchestration.json` stays byte-identical to the composition
  root's fallback copy; the new note is identical across both.
- **Knows-nobody invariant intact** — the note + SKILL.md refer to the writer generically, never naming a
  specific sibling skill.

## 1.2.2 — Strip the package's own tests from the npm tarball (memory)

Packaging only — no API/behaviour change; removed the package's own colocated tests from the
published tarball, deploy payload tests retained. The deployment-lineage head stays **`1.3.0`** (no
`docs/ai` structural change, no migration file). The npm package version is a separate axis.

- **`files[]` scoped negation.** Appended `!bin/*.test.mjs` and `!scripts/*.test.mjs` to the
  package allowlist (npm ignores a root `.npmignore` when `files[]` is present, so negation entries
  in `files[]` are the mechanism). Tarball **41 → 37 files**: 4 of the package's own colocated tests
  no longer ship.
- **Deploy payload tests retained.** `references/scripts/*.test.mjs` are deployed into a consumer
  repo's `scripts/`, so they still ship — `!scripts/*.test.mjs` does not cross `/` and never touches
  `references/scripts/`. **Never broaden it to `!references/**`** — those tests are deploy payload.
- **Tarball guard.** `scripts/package-content.test.mjs` (dev-only) gains an `npm pack --dry-run
  --json` invariant: no own-test leak, payload tests + runtime files present, exact file count
  `=== 37`.
- Test files stay on disk; the gate + publish CI run them from the checkout, unchanged. This is a
  tarball-only exclusion.

## 1.2.1 — Hidden-mode maintenance invariant (memory)

Patch: documentation only. The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural
change, no migration file). The npm package version is a separate axis.

- **`agent_rules.md` template (§1.3) + the Visibility contract** now state that the task-completion
  doc updates are **visibility-independent**: hidden mode git-ignores `docs/ai` but never makes
  maintaining it optional — the updates simply live on disk and never enter a commit. Future
  deployments carry the clarified protocol; the durable wording lives in `agent_rules.md` §1.3.

## 1.2.0 — Seeds the per-project orchestration config

The substrate now seeds a new **per-project, user-editable recipe config** —
`references/templates/orchestration.json` — deployed into `docs/ai/orchestration.json` by the bootstrap
template loop. It declares the orchestration **recipe** each named activity/slot uses (the composition
root's read-only `procedures` advisor reads it); the recipe **canon** and the slot **vocabulary** still
live in the engine / composition root, never here (the substrate keeps knowing nobody — the seed's
self-documentation uses generic "composition root" phrasing, naming no sibling). The shipped default is
conservative: **`solo` everywhere**, with an onboarding `_README` explaining how to raise a slot.

### Added
- **`references/templates/orchestration.json`** — strict JSON (no comments), byte-identical to the kit's
  fallback copy (kit↔memory template parity guard). Seeded on bootstrap; on upgrade it is **ensured
  stamp-independently** (create-if-missing / **preserve-if-edited** — a user's edits are never clobbered),
  so even an equal-head (`1.3.0`) deployment gains it **without a lineage-head bump or a migration file**.
- An **ownership-table** row distinguishing the seeded, editable recipe **CONFIG** (memory) from the
  recipe **CANON** + slot vocabulary (engine / composition root).

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file). The
npm package version is a separate axis.

## 1.1.2 — Entry-point template headroom for the orchestration pointer

A **docs/prose** release (no new executable, the `1.1.1`/`1.9.1` precedent). The bundled entry-point
template (`references/templates/AGENTS.md`) ships a second empty marker pair — `workflow:orchestration`,
right under the methodology pair — which the family **composition root** fills live from the methodology
engine on deploy. To keep the deployed `AGENTS.md` inside its ≤100-line budget with **both** pointers
filled, the template trimmed non-essential slack (the Hard-Constraints intro blockquote + one
illustrative row a deploying agent adapts anyway). No behaviour change; the composition root remains the
only writer of the slots.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file).

## 1.1.1 — Installer hardening (Issue-004 parity)

A patch release that applies the same two installer fixes shipped to the engine in 1.1.0, keeping the
two identical family installers in lockstep.

### Fixed
- Containment check now accepts a legitimately-contained child literally named `..foo` (it wrongly
  rejected anything starting with `..` before); `tildify` collapses only a **leading** `$HOME`, never
  a mid-path occurrence (**Issue-004**).

### Changed
- The installer is importable without side effects (the `isDirectRun` guard) and exports its
  path/format helpers for in-process tests. The installer's own + README bare `npx … init` strings now
  use `@latest`.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file).

## 1.1.0 — Hidden mode writes project-local, not global, excludes

Memory's **hidden** visibility now targets the **project-local** `.git/info/exclude` (its own footprint
only — `/AGENTS.md`, `/CLAUDE.md`, `/docs/ai/`, the added `/scripts/*.mjs`, `/docs/plans/`, both
`/.claude/settings*.json` — in canonical anchored form, idempotently), **never** the machine-global
`core.excludesFile`. Hiding a deployment no longer affects every other repo on the host (visibility is
a project setting). This is a **docs/prose** release (memory's hide was always prose-driven; no new
executable code); the tested superset path is the family composition root's hide tool, which absorbs
memory's project-local lines into one canonical managed block and adds the external footprint. The
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file).

### Changed
- `references/contracts.md` Visibility contract + `SKILL.md` step 9 retarget the hide to project-local.
- The upgrade flow moves an older machine-global hide to project-local — **after** the never-downgrade
  gate and **before** the equal-head short-circuit, so even an at-head hidden deployment is migrated.

## 1.0.0

Initial standalone release. The **memory substrate** extracted into its own package as Plan 1
of the agent-workflow family refactor (deployment-lineage head `1.3.0`). Additive: the family
composition root keeps its own bundled copy as a fallback, so nothing breaks for existing users.

### Added
- Standalone npm package + `bin/install.mjs` installer targeting
  `~/.claude/skills/agent-workflow-memory` (`AGENT_WORKFLOW_MEMORY_DIR`), with a
  symlink-traversal guard — the installer never writes *through* a destination symlink
  (root / intermediate / leaf).
- `capability.json` — the `agent-workflow` family manifest (`kind: memory-substrate`,
  `provides: ["context"]`). The package ships **no** family-wide schema/validator tooling
  (owned by the composition root) — it knows nobody.
- An **empty** delimited methodology slot in `templates/AGENTS.md`
  (`<!-- workflow:methodology:start -->` / `:end`); the substrate only ever ships it empty
  and preserves any filled content on upgrade. The composition root injects the methodology.
- `scripts/stamp-takeover.mjs` — a pure, unit-tested state machine for the legacy
  `.workflow-version` → `.memory-version` lineage takeover, with **atomic** (write-temp +
  rename) stamp writes, plus `migrations/legacy-stamp-takeover.md` (the no-Node manual
  fallback).

### Changed
- The deployment stamp is `docs/ai/.memory-version` (the legacy `.workflow-version` is never
  deleted; both track the shared lineage). Hidden-mode ignore lists now include
  `.memory-version`.
- `references/templates/agent_rules.md` no longer embeds the planning-methodology vocabulary —
  it points at the methodology owner. `contracts.md` attribution wiring is de-attributed from
  "the kit" to "the bootstrap".

### Carried over from the original substrate (deployment-lineage 1.3.0)
- `docs/ai/` templates, the Node enforcement scripts (caps + index freshness + 3-tier archive
  + hook installer) and their tests, the three setup contracts, and migrations `1.1.0`
  (conversational language) and `1.2.0` (agent attribution).
