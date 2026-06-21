---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 350
---

# Architecture

> How the code is organized. Layers, boundaries, where new code goes.

## Layers

```
UI Components       ← {{src/components/}}
    ↓
Hooks / Composition ← {{src/hooks/}}
    ↓
Services (pure)     ← {{src/services/}}
    ↓
State / Storage     ← {{src/store/ or src/data/}}
    ↓
Types / Schemas     ← {{src/types/}}
```

## Module Boundaries

- **Components** — render only. No fetching, no business logic.
- **Hooks** — orchestration; combine services + state.
- **Services** — pure functions. Easy to test.
- **State** — single source of truth per domain.

## File Tree (top level)

```
{{FILL FROM REAL src/}}
```

## Extension Points

- Add a new page → {{where + what to update}}
- Add a new domain entity → {{where}}
- Add a new shared component → {{where + docs to update}}

## Split policy (when this file nears its cap)

At ~90% of `maxLines`, split the deepest detail into `architecture-details.md` and keep this file high-level. Record the split as an ADR. Bumping the cap instead of splitting is a conscious exception, justified in that ADR.
