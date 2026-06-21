---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 300
---

# Technical Reference — Patterns & Examples

> Copy-paste-ready snippets for libraries and patterns used in this project. (Mature projects may fold this into a project patterns skill.)

## No Silent Failures

Every internal validation/guard that rejects an action MUST log via the structured logger with context (component, action, ids, inputs). User-facing failures also surface in the UI.

```{{lang}}
{{Show the project's logger usage. Replace with a real example after first use.}}
```

## {{Library Name}} — {{Pattern}}

```{{lang}}
{{Example after first use.}}
```

---

## Add a section when

- You discover a non-trivial library configuration.
- You establish a reusable pattern across 2+ files.
- You hit a gotcha future agents should not re-discover.
