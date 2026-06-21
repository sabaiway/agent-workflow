# agent-workflow

Monorepo for the **agent-workflow** skill family — portable, cross-agent memory and
workflow tooling for AI coding agents.

## Start here

Most users want a single command. It deploys the whole workflow — the memory substrate plus the
injected methodology — into a project:

```
npx @sabaiway/agent-workflow-kit init
```

`agent-workflow-kit` is **the entry point**, and it already bundles the memory substrate — so you
install nothing else. When the kit detects a standalone `@sabaiway/agent-workflow-memory`, it
delegates substrate deployment to that package; otherwise it uses its bundled copy. Install
`@sabaiway/agent-workflow-memory` **directly** only to use the memory layer *without* the kit —
a deliberately rare case. The other family members ship as agent skills, not npm packages (see
below).

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
