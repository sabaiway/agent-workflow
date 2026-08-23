---
type: spec
lastUpdated: 2026-08-23
scope: permanent
staleAfter: 90d
owner: none
maxLines: 150
kind: spec
status: draft
revision: 1
---

# Spec: tools

## Contract

Accepts a credential pair and returns a session or a typed refusal.

## Scenarios

- S1 happy path :: test/tools.test.mjs :: spec:tools/S1
- S2 lockout after five failures :: unbound

## Out of scope

- Password reset and MFA enrolment

## Module

- agent-workflow-kit/tools/a.mjs
- agent-workflow-kit/tools/b.mjs
