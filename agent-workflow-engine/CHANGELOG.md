# Changelog — @sabaiway/agent-workflow-engine

All notable changes to the methodology engine. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's `docs/ai/`
(which tracks the shared `agent-workflow` lineage, head `1.3.0`).

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
