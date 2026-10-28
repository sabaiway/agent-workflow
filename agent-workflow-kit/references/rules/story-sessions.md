---
type: rules
lastUpdated: 2026-10-28
scope: permanent
staleAfter: never
owner: kit
maxLines: 30
---

# Story sessions

The kit block of AGENTS.md is the kit's and is rewritten on every upgrade; it and docs/ai/rules/effective/ govern over any copy of kit text elsewhere in this project's files; text of your own goes outside the block, and a change to a kit rule goes in its theme's file under docs/ai/rules/local/.

A story — one row of an epic's ledger, carried by one plan — runs as four sessions, each step in them giving one checked result: **spec and plan** (every contract the story creates or revises and the plan's ledger beside them, checked by the spec gate, the plan-shape gate and one review of at most two rounds that reads both, then the plan's approval), **tests** (only tests, each new one failing for the reason its scenario or acceptance bullet states, or on the absence of a name the plan adds, imported inside the test; no code and no prototype), **code** (code until the tests and the pre-review gates pass; a wrong test is changed only back to what its scenario states), and **diff review, release and record** (every committable output, tracked records included, staged first, the review of the staged diff in at most two rounds, the final gates and the release where the story ships one, then the plan's Phase: Cleanup). Tests and code never share a session. A storyless plan runs the same four. **Exception — a split:** moving code and its existing cases into modules, with no new logic and no new case, is one session: a short spec (the Module list), the split, the diff review, the release, Cleanup. A bridge executor gets a task only when it writes new tests or code, from one prompt of the orchestrator; a file the orchestrator already wrote is laid down by the orchestrator, never relayed through a bridge.
