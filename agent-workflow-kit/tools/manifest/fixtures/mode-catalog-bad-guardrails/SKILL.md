---
name: fixture-mode-catalog-bad-guardrails
description: Malformed modeCatalog structured guardrails[] — must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-bad-guardrails

Negative fixture — structured `guardrails[]`: a non-empty `value`, an `enforcement` from the closed
enum, an optional string `condition` (the runtime bound on an `enforced` claim), and a `source`.
