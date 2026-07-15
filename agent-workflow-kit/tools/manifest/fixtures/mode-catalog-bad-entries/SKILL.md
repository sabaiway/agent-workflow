---
name: fixture-mode-catalog-bad-entries
description: Malformed modeCatalog entries (shape, key, duplicate, kind, env-hook key) — must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-bad-entries

Negative fixture — the per-entry identity rules: an entry must be an object, `key` is a unique bare
token, `kind` comes from the closed taxonomy, and an env-hook's key IS its env-var name.
