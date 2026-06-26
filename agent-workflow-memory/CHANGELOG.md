# Changelog — @sabaiway/agent-workflow-memory

All notable changes to the memory substrate. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's
`docs/ai/.memory-version` (which tracks the shared `agent-workflow` lineage, head `1.3.0`).

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
