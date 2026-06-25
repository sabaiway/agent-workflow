# @sabaiway/agent-workflow-memory

**Portable, cross-agent memory substrate for AI coding agents.** Deploys an `AGENTS.md`
entry point (+ a `CLAUDE.md` symlink for Claude Code) and a structured `docs/ai/` context
store with cap / archive / index-freshness enforcement into any repo. After it runs, any
future agent — including a fresh session of yourself — can reconstruct project context in
~60 seconds, find the current task, and avoid repeating past mistakes.

This is the **memory layer** of the `agent-workflow` family.
It owns the substrate only — `docs/ai/`, the entry point, caps / 3-tier archive / index gate,
the Node enforcement scripts, the pre-commit hook, the templates, and the three setup
contracts (visibility / conversational language / agent attribution). It deliberately **knows
nobody else** in the `agent-workflow` family: the **workflow methodology** (plan → execute →
review vocabulary, lifecycle, `queue.md`, mandatory Cleanup) lives elsewhere and is injected
into a delimited slot in `AGENTS.md` by the family composition root, not by this package.

## Install

```bash
npx @sabaiway/agent-workflow-memory@latest init
```

Installs/refreshes the skill at `~/.claude/skills/agent-workflow-memory` (override with
`--dir <path>` or `AGENT_WORKFLOW_MEMORY_DIR`). `init` is additive — it never deletes your
settings and never writes through a symlink. Re-running updates the skill's own files; that is
how you upgrade the *skill*. Migrating a *project's* deployment is a separate in-agent step
(below).

## Use

Open your agent inside a project and run the skill:

- **`/agent-workflow-memory`** — bootstrap a new or empty project. Asks the three setup
  questions (visibility, conversational language, agent attribution), then writes `docs/ai/`,
  `AGENTS.md`, the enforcement scripts + pre-commit hook, and stamps
  `docs/ai/.memory-version`. The methodology slot in `AGENTS.md` is left **empty**.
- **`/agent-workflow-memory upgrade`** — migrate an existing deployment to the skill's current
  version. Reads `docs/ai/.memory-version`, runs only newer migrations in semver order, and
  **preserves** anything already in the methodology slot (extract-and-reinsert — it never
  regenerates `AGENTS.md` wholesale).

## Stamps & lineage

Two independent axes: this package's **npm version** vs the **deployment-lineage** stamp the
substrate writes into a project. They are not the same number. `.memory-version` tracks the
shared `agent-workflow` deployment lineage (head `1.3.0` today), **not** this package's
version. A project bootstrapped by the kit's fallback carries a `.workflow-version`; when this
substrate is later installed, `migrations/legacy-stamp-takeover.md` copies that value verbatim
into `.memory-version` and never deletes the legacy stamp. See `migrations/README.md`.

## What this package ships

`SKILL.md` (procedure + ownership table), `references/` (templates + the deployable Node
enforcement scripts + the setup contracts), `scripts/stamp-takeover.mjs` (the upgrade-time
lineage state machine + tests), `migrations/`, `capability.json` (the family manifest), and
this installer. It ships **no** family-wide tooling (the schema/validator are owned by the
composition root) — preserving "knows nobody".

## License

MIT — see [LICENSE](./LICENSE).
