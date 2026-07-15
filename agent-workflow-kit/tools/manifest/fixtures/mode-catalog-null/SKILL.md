---
name: fixture-mode-catalog-null
description: An explicit `modeCatalog: null` — PRESENT but malformed, never "absent".
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-null

Negative fixture — declaring the key with a null value is a PRESENT block that is not an array. It
must never slip through the additive-optional absence lane.
