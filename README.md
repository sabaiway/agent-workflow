# agent-workflow

Monorepo for the **agent-workflow** skill family — portable, cross-agent memory and
workflow tooling for AI coding agents.

## Workspaces (npm packages)

| Package | npm | Role |
|---|---|---|
| [`agent-workflow-kit`](agent-workflow-kit) | `@sabaiway/agent-workflow-kit` | Composition root: detects the memory substrate, delegates or falls back, injects the workflow methodology, ships the family manifest schema + validator. |
| [`agent-workflow-memory`](agent-workflow-memory) | `@sabaiway/agent-workflow-memory` | Standalone memory substrate: `AGENTS.md` entry point + `docs/ai/` context store with cap/archive/index enforcement. Ships the methodology slot empty. |

## Sibling skills (in-repo, not npm workspaces)

- `codex-cli-bridge`, `antigravity-cli-bridge` — delegated-execution backends; their context provider is the memory substrate.
- `agent-workflow-engine` — methodology engine (stub; `available: false` until its own series lands).

## Layout notes

- Deployment-lineage stamp is independent of npm package versions; both packages stamp the shared lineage head.
- Publish order is **memory before kit** (the kit may delegate to memory at deploy time).
- `docs/plans/` is machine-local and is never committed (see `.gitignore`).
