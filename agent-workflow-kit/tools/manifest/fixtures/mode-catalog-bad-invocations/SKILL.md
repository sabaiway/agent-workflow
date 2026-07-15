---
name: fixture-mode-catalog-bad-invocations
description: Broken modeCatalog invocationRefs / descriptor composition — must fail validation.
metadata:
  version: '1.0.0'
---

# fixture-mode-catalog-bad-invocations

Negative fixture — composition-by-reference: every `invocationRefs[]` entry resolves, a contract
invocation is claimed by at most one entry, a contract-backed entry composes by reference (never a
literal), and a contract-free entry carries a literal `descriptor`.
