---
type: spec
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 150
kind: spec
status: draft
revision: 1
---

# Spec: example-feature

> Authoring reference for a `kind: spec` contract root — copy it to `docs/ai/specs/<slug>.md`
> (the slug mirrors the feature-slice or module name, `^[a-z0-9]+(-[a-z0-9]+)*$`) and replace every
> section. NOT deployed on bootstrap — it stays in the skill home like `adr-record.md`. The full
> schema (kinds, statuses, transitions, promotion, precedence) is the engine canon `references/specs.md`;
> the deployed reader `scripts/spec-schema.mjs` is what decides well-formed.

## Contract

What the feature accepts and returns, stated as invariants a test can pin. A `draft` spec is authored
WITH the plan that lands the feature and exists at plan review; approval of that plan confirms the
contract (no separate stop). It becomes `live` on the plan's landing row; `revision` increments by one
per live contract change; `retired` on the removal row — never backwards.

## Scenarios

- S1 accepts a well-formed request :: test/example-feature.test.mjs :: spec:example-feature/S1
- S2 refuses a malformed request with a typed error :: unbound

## Out of scope

- The neighbouring feature this one is often confused with (name it — exclusions are the core value)
- Retry, caching and observability concerns owned by their own slices

## Module

- src/example-feature/

## Links

- [[AD-NNN]] — the decision that shaped this contract
- `pages/<page>.md` — the page spec this feature's view layer is described in (a subordinate view)
