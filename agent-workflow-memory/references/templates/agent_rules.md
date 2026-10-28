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
2. `docs/ai/orchestration.json` — the CONFIGURED orchestration recipes (per activity/slot). Honor them: a silent recipe downgrade is a forbidden substitution.
3. `docs/ai/active_plan.md` — pick ONE task from "Immediate Priority".
4. Confirm with the user: *"I'm taking task X. Confirm?"*

### 1.2. During Work
**Before any feature:** name its governing spec(s) — the feature spec under `docs/ai/specs/` for every touched spec-covered slice (a zero names the adoption state it relies on — not adopted, adopting, or nothing spec-covered touched; each cited spec's Out of scope bounds that slice's work). Where only a page spec (`docs/ai/pages/<page>.md`) exists it governs as an ADOPTION SHIM: state Out of scope + Revision inline in the plan. If the contract changes, the spec revision is authored WITH the plan (visible at review) and lands with the code, so docs and code never diverge.

**For every code change:**
1. Grep for similar implementations — reuse existing patterns.
2. Check the design-system layer for an existing component; if missing, add it there FIRST, then use it.
3. Verify changes align with the governing spec(s) and `docs/ai/pages/<page>.md`; a new feature gets a `draft` spec (the skill's `SPEC_TEMPLATE.md`), a new page a full page spec.
4. Follow §2 (Self-Review): functional style, named exports, full variable names, no magic literals.
5. Write/update tests FIRST (TDD): unit for pure functions, E2E for user flows.
6. Run quality checks: lint, type-check, tests.

### 1.3. Task Completion
> **Visibility-independent.** Every step below is mandatory in **both** visibility modes. Hidden mode (the AI footprint git-ignored via `.git/info/exclude`) changes only what **git** tracks — never whether you maintain `docs/ai`. "Git-ignored / `git status` clean" is **not** "optional to update": the doc/state updates still happen, they just live on disk and never enter a commit.

Before claiming "done":
1. Run all quality gates (lint + type-check + tests) — all green.
2. Update docs: `current_state.md` (feature ready), `changelog.md` (entry), `handover.md` (**REPLACE** the last-session block — session delta, never append; older deltas live in `changelog.md` → `history/`), `pages/<page>.md` (matches implementation), the governing spec (its revision lands with the code: `draft` -> `live` on the landing row). Only bump "Last Updated" when content actually changed.
3. Run the docs cap-validator + index-freshness gate (the pre-commit hook also enforces it where installed). On failure: trim the offending file, or run the changelog rotation if the offender is `changelog.md`.
4. If the work executed a plan file — complete it per the project's **planning skill / methodology** (the `workflow:kit` block in `AGENTS.md` points to it; see §5). Without completing that step the plan is not done. (The methodology, including any mandatory final cleanup, is defined there — not in this substrate.)
5. **Ask before committing** (§4): report lint / type-check / test counts + docs status, then wait for explicit approval. DO NOT auto-commit.

---

## 2. Self-Review Checklist

Before proposing changes or committing, review against:

### 2.1. Real-World Context
- Respects the user's locale (translations, decimal separators, encodings/BOM for non-ASCII exports).

### 2.2. Clean Code
- **No magic literals** — extract string/numeric constants to named consts at module level.
- **DRY** — no duplicated logic.
- **Minimal comments (a BASELINE this project may tighten)** — if this project sets a stricter rule (e.g. comments forbidden entirely), that stricter rule ALWAYS wins; this is only a floor. Otherwise comment only where vitally necessary (a non-obvious invariant, a fail-closed rationale, a subtle edge). Make the code self-explaining first — clear variable/function names and compact-but-unambiguous test descriptions replace most comments; never restate what the code already says.

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
- **Context size is a soft, secondary signal** — split only when the working context is genuinely large *relative to the window* or you notice degraded recall, never at a fixed token count.
---

## 4. User Interaction

1. **Don't rush to commit.** Prepare changes, run local quality checks, report progress with test outcomes.
2. **Get explicit approval** before COMMITTING or moving to the next phase — staging is reversible loop-work (the final-run ordering stages first, reviews the staged tree, then asks ONCE at the commit; a separate staging ask is a useless approval).

---

## 5. Planning Workflow

Plan-file rules — shape, lifecycle (`docs/plans/<slug>.md`, gitignored, never committed), the mandatory final **Phase: Cleanup**, the `docs/plans/queue.md` series-index, "all work in plans" — are **workflow methodology**, owned by the project's planning skill, not by this memory substrate. The `workflow:kit` block in `AGENTS.md` points to it; the planning skill is the single source of truth and overrides the generic `writing-plans` skill. This substrate records only *where* the methodology lives, never the methodology itself.
