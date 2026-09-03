---
type: spec
lastUpdated: 2026-09-03
scope: permanent
staleAfter: 90d
owner: none
maxLines: 150
kind: spec
status: draft
revision: 1
---

# Spec: anchors

## Contract

- an anchor path is accepted only if `ls-files -v` lists it with tag `H` and `status` is silent — everything else, a path reported modified, untracked or ignored, is the named refusal `anchor-dirty`

## Scenarios

- S1 closed check :: unbound

## Out of scope

- Anchor discovery

## Module

- src/anchors/
