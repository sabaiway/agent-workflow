---
name: fixture-mode-catalog-bad-shape
description: A modeCatalog that is an object, not the declared array — must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-bad-shape

Negative fixture — `modeCatalog` must be an ARRAY (a JSON object would silently dedupe entries
under `JSON.parse`, the same reason the `settings` block is an array).
