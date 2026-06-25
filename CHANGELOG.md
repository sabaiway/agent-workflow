# Changelog — agent-workflow (monorepo)

Repo-level history for the **agent-workflow** family monorepo. Each published package is
versioned **independently** — see its own changelog for package-level detail:

- `@sabaiway/agent-workflow-kit` → [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md)
- `@sabaiway/agent-workflow-memory` → [agent-workflow-memory/CHANGELOG.md](agent-workflow-memory/CHANGELOG.md)
- `@sabaiway/agent-workflow-engine` → [agent-workflow-engine/CHANGELOG.md](agent-workflow-engine/CHANGELOG.md)

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
