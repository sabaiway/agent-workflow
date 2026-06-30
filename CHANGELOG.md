# Changelog — agent-workflow (monorepo)

Repo-level history for the **agent-workflow** family monorepo. Each published package is
versioned **independently** — see its own changelog for package-level detail:

- `@sabaiway/agent-workflow-kit` → [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md)
- `@sabaiway/agent-workflow-memory` → [agent-workflow-memory/CHANGELOG.md](agent-workflow-memory/CHANGELOG.md)
- `@sabaiway/agent-workflow-engine` → [agent-workflow-engine/CHANGELOG.md](agent-workflow-engine/CHANGELOG.md)

## 2026-06-30 — engine 1.7.0 / memory 1.5.0 / kit 1.22.0

- **Harden the planning canon — process-fidelity + regression-free editing (all users).** Seven
  methodology invariants land in the kit canon and the deployed always-loaded lens, guarded by an extended
  non-vacuous drift test. **Process-fidelity:** *ExitPlanMode ≠ execute* (`planning.md` §6); *recipe
  fidelity* — Council runs every ready backend every round, dropping a ready one is a forbidden silent
  downgrade (`orchestration.md` §4/§5); and a *convergence bar* — a review loop is clean only at **0
  blockers + 0 majors from every named backend** (folding ≠ convergence). **Regression-free editing**
  (`planning.md` §9): *no code-mechanics in the plan*, *test-as-spec*, *characterize-first*, *heavy review
  at the diff*. Both `agent_rules.md` templates carry all seven in a generalized, byte-identical lens
  block; the kit's `lens-mirror.test.mjs` gains two scoped token sets (cross-all-four + template-scoped),
  proven non-vacuous. **engine → 1.7.0**, **memory → 1.5.0**, **kit → 1.22.0**; lineage head stays
  **`1.3.0`**.

## 2026-06-30 — antigravity-cli-bridge 2.0.0 / engine 1.6.0 / kit 1.21.0

- **Antigravity (`agy`) bridge grounded-review hardening.** A dedicated **`agy-review`** wrapper
  mechanizes the grounded-review contract (POSTURE + a model/cutoff GUARD + `--facts` + `--decided` +
  the artifact + a strict output shape), delegating execution to `agy-run` so the hard timeout, the
  subscription invariant, and a new single-argv byte ceiling (`AGY_MAX_PROMPT_BYTES`) live in one place.
  The bridge goes to **2.0.0** (review role → `agy-review`; two PATH wrappers). The kit (**1.21.0**)
  bundles the byte-identical mirror, probes the EXPECTED wrapper set in readiness (a stale install missing
  `agy-review` surfaces **DEGRADED**), and manages both wrappers in `setup` / `uninstall`. The engine
  (**1.6.0**) loosens the Issue-001 caveat — grounded review is a sound second opinion; the real
  service-stall risk is kept. `memory` is unchanged. Lineage head stays **`1.3.0`**.

## 2026-06-29 — engine 1.5.0 / memory 1.4.0 / kit 1.20.0

- **Right-altitude & code-grounded methodology institutionalized in the canon.** Two planning/review
  disciplines — right altitude (pin intent + invariants + acceptance; leave mechanics to Execute) and
  fold-by-code (read + cite the `file:line` before folding a finding), plus the convergence heuristic —
  now live in the engine canon (`planning.md` §9 + a §8 bullet; a terse §9 review-lens pointer in both
  `procedures.md` activities) and the deployed self-review substrate (a §2.x lens in both `agent_rules.md`
  templates). New guards pin them: a cross-package `lens-mirror` (shared vocabulary across all four files
  + the byte-identical template block, non-vacuous), a new engine `planning-canon`, and an extended
  `procedures-canon`. Lineage head stays `1.3.0`.
  - **`@sabaiway/agent-workflow-engine@1.5.0`** — `planning.md` §9 + §8 bullet; `procedures.md` terse §9
    lens in both activities; `test/planning-canon.test.mjs` + extended `test/procedures-canon.test.mjs`.
  - **`@sabaiway/agent-workflow-memory@1.4.0`** — `agent_rules.md` §2.6 lens (path-neutral; byte-identical
    to the kit block).
  - **`@sabaiway/agent-workflow-kit@1.20.0`** — `agent_rules.md` §2.5 lens; cross-package
    `test/lens-mirror.test.mjs` (region-scoped tokens + byte-identical block).

## 2026-06-29 — kit 1.19.0

- **One-command freshness + capability-adaptive `status`.** `npx @sabaiway/agent-workflow-kit@latest
  init` now refreshes the **memory substrate** and the **methodology engine** alongside the kit, so a
  returning user is no longer left with silently stale memory — a memory miss is a **loud DEGRADED
  success** (warning + exact recovery command + exit 0), `--no-memory` skips it, and bridges are still
  placed by `setup`, not `init`. The direct-CLI `status` view is rebuilt as a capability-adaptive
  `surface → view-model → renderers` pipeline (plain/ansi, `NO_COLOR`/`FORCE_COLOR`, width floor,
  ASCII fallback; `--format=<auto|plain|ansi|json>`, loud-reject parse), and the `--json` envelope
  gains an additive structural `installed[].refresh` `{ behind, recommend }`. Lineage head stays `1.3.0`.
  - **`@sabaiway/agent-workflow-kit@1.19.0`** — memory cascade in `bin/install.mjs` (`installMemory`,
    `--no-memory`, crash-proof degraded warning, drift-guarded cascade derived from `FAMILY_MEMBERS`);
    the status-presenter modules `tools/{labels,presentation,surface,view-model,renderers}.mjs` + the
    pure member-table leaf `tools/family-members.mjs`; `formatStatus`/`formatSettings` replaced by the
    pipeline; `SKILL.md` `Mode: status` reads `refresh` (the shared notes-based footers untouched).
  - **`@sabaiway/agent-workflow-memory`** / **`@sabaiway/agent-workflow-engine`** — unchanged, not
    republished (the kit refreshes the already-published versions).

## 2026-06-29

- **Agent-writable orchestration config + durable session/communication contracts (AD-025).** The
  per-project recipe config is no longer hand-edit-only, `setup` surfaces bridge versions, and the
  methodology canon gains read-at-start + a planning Definition of Done + a communication contract that
  reach the existing base via a canonical-refresh. Three packages bumped (lineage head stays `1.3.0`):
  - **`@sabaiway/agent-workflow-kit@1.18.0`** — new `/agent-workflow-kit set-recipe` writer
    (`tools/{orchestration-config,orchestration-write,set-recipe}.mjs`; previews by default; hardened
    atomic write; `procedures` never imports the writer); `setup` bridge-version surfacing + a re-detect-
    after-apply proactive offer + a `status` pointer; `inject-methodology` canonical-refresh + advisory.
  - **`@sabaiway/agent-workflow-engine@1.4.0`** — `references/procedures.md` read-at-start + plan-authoring
    Definition of Done + communication contract; the two slot fragments gain the matching clauses.
  - **`@sabaiway/agent-workflow-memory@1.3.0`** — agent-writable config note in the seed (seeds-when-missing
    / preserves existing; the in-place note refresh is kit-owned); `agent_rules.md` §2.5 Communication.

## 2026-06-27

- **Activity procedures — recipe-aware, configurable playbooks (AD-019).** A bare activity ("write a
  plan", "execute the plan") now has codified, recipe-aware steps + a per-project, user-configurable
  default recipe, composing over the AD-018 recipes (which stay read-only). Three packages bumped in
  lockstep:
  - **`@sabaiway/agent-workflow-engine@1.3.0`** — new `references/procedures.md` activity canon
    (`plan-authoring`, `plan-execution`; typed recipe slots; generic); the methodology slot fragment
    gained the one-line `/agent-workflow-kit procedures` auto-discovery route.
  - **`@sabaiway/agent-workflow-kit@1.14.0`** — read-only **`/agent-workflow-kit procedures <activity>`**
    advisor (`tools/procedures.mjs`): live engine read + `docs/ai/orchestration.json` validation + the
    resolved recipe per slot (graceful default vs loud override degradation). `status` multi-caveat.
  - **`@sabaiway/agent-workflow-memory@1.2.0`** — seeds the user-editable `docs/ai/orchestration.json`
    config (byte-identical to the kit fallback copy; conservative `solo` default + onboarding note),
    ensured stamp-independently on upgrade.

  The deployment-lineage head stays `1.3.0` (no deployed `docs/ai` structural change; no migration).
  Release tags: `agent-workflow-engine-v1.3.0` / `agent-workflow-kit-v1.14.0` / `agent-workflow-memory-v1.2.0`.
  See the per-package changelogs and AD-019.

## 2026-06-25

- **`@sabaiway/agent-workflow-engine@1.0.0` — first publish.** The canonical home of the
  `agent-workflow` planning methodology is now an installable, `available:true` npm package — no
  longer a declared, content-only stub. It ships its own `bin/install.mjs` (symlink-hardened),
  `capability.json` (`detect.installed` + `install.npm`), README/CHANGELOG/LICENSE, and the
  methodology canon (`references/`). The composition root (`agent-workflow-kit`) still consumes a
  byte-identical, drift-guarded mirror of this canon; the live `kit → engine` read and retiring that
  mirror land in the next slice. **No kit/memory republish**, and the deployment-lineage head stays
  `1.3.0` (packaging changes only the npm axis). Release tag: `agent-workflow-engine-v1.0.0`. See
  [agent-workflow-engine/CHANGELOG.md](agent-workflow-engine/CHANGELOG.md) and AD-015.

## 2026-06-22

- **`agent-workflow-kit@1.6.0` — methodology slot reconciliation + engine becomes the canonical
  methodology home.** `agent-workflow-engine` (still `available:false`) is now the single source of
  truth for the planning methodology; the kit keeps byte-identical mirror copies, pinned by a
  drift-guard test. The kit gains a stamp-independent `reconcile` operation (`ensureSlot` /
  `reconcileSlot`) that ensures the `workflow:methodology` slot exists and is filled on bootstrap +
  every upgrade — reaching legacy `1.3.0` deployments **without** bumping the deployment-lineage
  head. The kit fallback template now ships the empty slot. `agent-workflow-memory` is unchanged (no
  republish). See [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md) and AD-010.

## 2026-06-21

- **First publish from the monorepo.** Released `@sabaiway/agent-workflow-memory@1.0.0` (initial
  standalone release of the memory substrate) and `@sabaiway/agent-workflow-kit@1.4.0` to npm,
  both with build provenance, in that order (the kit may delegate to memory at deploy time).
  Release tags: `agent-workflow-memory-v1.0.0`, `agent-workflow-kit-v1.4.0`.
- **Root CI workflows added** under `.github/workflows/`:
  - `publish` — manual dispatch for `memory`, `kit`, or `both` (with `dry_run`); runs the
    per-package preflights + provenance publish via the reusable `_publish-one`, always
    memory → kit.
  - `stats` — daily snapshot of per-package npm downloads plus shared repo signals into
    `stats/history.csv`.
  - `unpublish` — guarded admin unpublish with a `memory | kit` selector.

## Earlier

The family was refactored out of the standalone `agent-workflow-kit` project into this monorepo:
the memory substrate was extracted into its own package and the kit became the composition root
(detect-and-delegate, with a bundled fallback). For package history before the monorepo, see the
per-package changelogs linked above.
