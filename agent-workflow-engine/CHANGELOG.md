# Changelog — @sabaiway/agent-workflow-engine

All notable changes to the methodology engine. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's `docs/ai/`
(which tracks the shared `agent-workflow` lineage, head `1.3.0`).

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
