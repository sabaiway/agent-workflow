---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 200
---

# Page: {{PAGE_NAME}}

**Route:** `{{/path}}`
**Component:** `{{src/routes/<file>}}`

> Template — copy to `docs/ai/pages/<page>.md` when a route appears. NOT deployed on bootstrap.

## Purpose

{{1–2 sentences.}}

## Layout

```
{{ASCII or description of regions.}}
```

## States

| State | Trigger | UI |
|-------|---------|----|
| Empty | No data | {{description}} |
| Loading | Fetch in flight | {{description}} |
| Ready | Data loaded | {{description}} |
| Error | Fetch failed | {{description}} |

## User Actions

| Action | Trigger | Result | Validation |
|--------|---------|--------|------------|
| — | — | — | — |

## Data Dependencies

- Reads: {{data sources}}
- Writes: {{mutations}}

## Linked Components

- `{{src/components/...}}`

## Open Questions / TODO

- [ ] —
