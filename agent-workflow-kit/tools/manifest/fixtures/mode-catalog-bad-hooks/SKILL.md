---
name: fixture-mode-catalog-bad-hooks
description: Malformed modeCatalog customHooks[] linkage — must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-bad-hooks

Negative fixture — `customHooks[]`: each entry resolves and is either an env-hook that really lists
this mode as a parent, or the mode's OWN key (the raw-mode self-reference, contract-free only).
