---
name: fixture-mode-catalog-empty
description: An empty `modeCatalog: []` — the silent-empty-list D1 forbids.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-empty

Negative fixture — a bridge that declares a catalog must populate it. An empty array would render as
"this bridge has no modes", which is never true and is exactly the silent empty list D1 forbids.
A bridge with nothing to say omits the block instead.
