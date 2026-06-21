# Changelog — @sabaiway/agent-workflow-memory

All notable changes to the memory substrate. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's
`docs/ai/.memory-version` (which tracks the shared `agent-workflow` lineage, head `1.3.0`).

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
