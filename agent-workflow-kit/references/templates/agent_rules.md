---
type: protocol
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 90d
owner: none
maxLines: 150
---

# AI Agent Rules & Self-Review Protocol — {{PROJECT_NAME}}

Every AI agent working on this project **must** adhere to this protocol before writing code, modifying files, or presenting solutions.

---

## 1. Session Protocols

### 1.1. Start of Session
Read in order, then confirm before starting:
1. `docs/ai/handover.md` — where we left off.
2. `docs/ai/active_plan.md` — pick ONE task from "Immediate Priority".
3. Confirm with the user: *"I'm taking task X. Confirm?"*

### 1.2. During Work
**Before any feature:** read the relevant page spec (`docs/ai/pages/<page>.md`). If behaviour changes, update the spec FIRST so docs and code never diverge.

**For every code change:**
1. Grep for similar implementations — reuse existing patterns.
2. Check the design-system layer for an existing component; if missing, add it there FIRST, then use it.
3. Verify changes align with `docs/ai/pages/<page>.md`; for a new page, create a full spec.
4. Follow §2 (Self-Review): functional style, named exports, full variable names, no magic literals.
5. Write/update tests FIRST (TDD): unit for pure functions, E2E for user flows.
6. Run quality checks: lint, type-check, tests.

### 1.3. Task Completion
Before claiming "done":
1. Run all quality gates (lint + type-check + tests) — all green.
2. Update docs: `current_state.md` (feature ready), `changelog.md` (entry), `handover.md` (**REPLACE** the last-session block — session delta, never append; older deltas live in `changelog.md` → `history/`), `pages/<page>.md` (matches implementation). Only bump "Last Updated" when content actually changed.
3. Run the docs cap-validator + index-freshness gate (pre-commit also enforces). On failure: trim the offending file, or run the changelog rotation if the offender is `changelog.md`.
4. If the work executed a plan file — run that plan's final **Phase: Cleanup** (see the planning skill / §5). Without it the plan is not done.
5. **Ask before committing** (§4): report lint / type-check / test counts + docs status, then wait for explicit approval. DO NOT auto-commit.

---

## 2. Self-Review Checklist

Before proposing changes or committing, review against:

### 2.1. Real-World Context
- Respects the user's locale (translations, decimal separators, encodings/BOM for non-ASCII exports).

### 2.2. Clean Code
- **No magic literals** — extract string/numeric constants to named consts at module level.
- **DRY** — no duplicated logic.

### 2.3. Strict Compliance
- Only `const` (no `let`); no classes — pure functions, closures, modules.
- Components as arrow functions; no unsafe `any` / casts.
- Functions start with a verb (`computeTotal`, `getList`).

### 2.4. Quality Gates
- Always run type-checker, linter, and all tests before committing.

---

## 3. Token & Session Optimization

Split a complex task across sessions for **focus and review hygiene**, not because the window is small. Modern long-context models (e.g. Opus 4.8) hold large working sets well, and a stable always-loaded layer (`AGENTS.md` + `index.md`) stays prompt-cache-warm across turns — split too eagerly and you pay re-boot + cache-miss cost for nothing.

- **Split (separate sessions)** when the *change* is large enough to deserve an isolated review checkpoint: creates/deletes a source or test file, touches several files, alters a dependency / core config / data model / routes, or needs new E2E tests. These are review-hygiene triggers, independent of context size.
- **Run inline** for small, self-contained work: a few files, no new files, no dependency/schema/route change, light discussion (typos, tweaks, single-line fixes, test additions).
- **Context size is a soft, secondary signal** — split only when the working context is genuinely large *relative to the window* or you notice degraded recall, never at a fixed token count. Prefer the planning skill's **session-continuity heuristic**: keep going in-session when the accumulated context IS the execution payload (targeted-deep reads of the exact files you'll edit); split when it was broad fan-out noise.

---

## 4. User Interaction

1. **Don't rush to commit.** Prepare changes, run local quality checks, report progress with test outcomes.
2. **Get explicit approval** before staging/committing or moving to the next phase.

---

## 5. Planning Workflow

All plan-file rules — vocabulary (Plan → Phase → Step → Substep), lifecycle (`docs/plans/<slug>.md`, gitignored, never committed), the mandatory final **Phase: Cleanup**, the `docs/plans/queue.md` series-index, "all work in plans", the plan-then-execute split — live in the project's planning skill. It is the single source of truth and overrides the generic `writing-plans` skill.
