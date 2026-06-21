---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 120
---

# Environment & Commands

> Single reference for all dev/build/test/lint commands. (Mature projects may fold this into a project command skill.)

## Setup

```bash
{{install command}}
```

## Daily Loop

| Need | Command |
|------|---------|
| Dev server | `{{DEV_COMMAND}}` |
| Build | `{{BUILD_COMMAND}}` |
| Lint | `{{LINT}}` |
| Type-check | `{{TYPECHECK}}` |
| Unit tests | `{{TEST}}` |
| Unit tests (one file) | `{{TEST}} {{path/file}}` |
| E2E tests | `{{E2E_COMMAND}}` |
| Docs caps | `{{DOCS_CHECK}}` |
| Docs index (regenerate) | `{{DOCS_INDEX}}` |
| Docs index (freshness gate) | `{{DOCS_INDEX_CHECK}}` |
| Changelog rotation | `{{DOCS_ARCHIVE}}` |
| All checks (pre-commit) | `{{LINT}} && {{TYPECHECK}} && {{TEST}}` |

## Git Conventions

- Branches: `{{convention}}`
- Commit style: `{{e.g. Conventional Commits}}`
- PR target: `{{branch}}`
