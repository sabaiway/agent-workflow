---
type: state
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 30d
owner: current_state
maxLines: 120
---

# Current State

> Snapshot of what's built and what works. Updated after each feature completion.

## Stack

| Layer | Tool |
|-------|------|
| Language | {{LANGUAGE}} |
| Framework | {{FRAMEWORK}} |
| Package manager | {{PACKAGE_MANAGER}} |
| Test runner | {{TEST_RUNNER}} |
| Linter | {{LINTER}} |

## Feature Status

| Feature | Status | Notes |
|---------|--------|-------|
| AI memory system | ✅ Ready | Bootstrapped {{DATE}} |
| {{FEATURE}} | 🟡 In progress / ⛔ Blocked | {{note}} |

## Quality Gates

- lint: {{N}} errors / {{M}} warnings
- type-check: {{clean / N errors}}
- unit tests: {{N passed in M files}}
- E2E tests: {{N passed}}
