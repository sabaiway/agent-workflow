---
type: spec
lastUpdated: 2026-08-23
scope: permanent
staleAfter: 90d
owner: none
maxLines: 150
kind: spec
status: draft
revision: 1.5
---

# Spec: login

## Contract

Accepts a credential pair and returns a session or a typed refusal.

## Scenarios

- S1 happy path :: test/login.test.mjs :: spec:login/S1
- S2 lockout after five failures :: unbound

## Out of scope

- Password reset and MFA enrolment

## Module

- src/login/
