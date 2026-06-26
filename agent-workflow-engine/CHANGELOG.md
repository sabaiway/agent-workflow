# Changelog — @sabaiway/agent-workflow-engine

All notable changes to the methodology engine. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's `docs/ai/`
(which tracks the shared `agent-workflow` lineage, head `1.3.0`).

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
