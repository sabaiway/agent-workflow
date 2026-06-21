---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 80
---

# Pages Index

> Registry of every user-facing page/route. Source of truth for routing.

| Route | Name | Spec | Status |
|-------|------|------|--------|
| `/` | Home | [home.md](./home.md) | TODO |
| `{{/path}}` | {{Name}} | [{{name}}.md](./{{name}}.md) | TODO |

## Shared

- [shared-patterns.md](./shared-patterns.md) — loading, empty, error, modal, form, toast patterns.

> Create one `pages/<page>.md` per route as it appears (use `PAGE_TEMPLATE.md` from the skill). Every page must ship an HTML-validity / a11y E2E test.
