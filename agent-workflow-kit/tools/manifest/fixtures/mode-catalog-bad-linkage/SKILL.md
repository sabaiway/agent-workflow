---
name: fixture-mode-catalog-bad-linkage
description: Broken modeCatalog role / parents / submode linkage — must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-bad-linkage

Negative fixture — the linkage rules: a primary/continuation names a declared `role`, an env-hook
names `parents[]` (never a role), and `submode` is present exactly when a primary's role declares
`modes[]`.
