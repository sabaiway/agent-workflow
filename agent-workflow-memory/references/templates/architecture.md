---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 350
---

# Architecture

> How the code is organized: where each module lives and where new code goes.

## Layout rules

The code is laid out by the project-layout rules: modules nest by meaning, and a name says where
code, tests and specs live. In a kit deployment those rules live in
`docs/ai/rules/effective/project-layout.md`, laid down by the kit's upgrade.

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
