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
- **Minimal comments (a BASELINE this project may tighten)** — if this project sets a stricter rule (e.g. comments forbidden entirely), that stricter rule ALWAYS wins; this is only a floor. Otherwise comment only where vitally necessary (a non-obvious invariant, a fail-closed rationale, a subtle edge). Make the code self-explaining first — clear variable/function names and compact-but-unambiguous test descriptions replace most comments; never restate what the code already says.

### 2.3. Strict Compliance
- Only `const` (no `let`); no classes — pure functions, closures, modules.
- Components as arrow functions; no unsafe `any` / casts.
- Functions start with a verb (`computeTotal`, `getList`).

### 2.4. Quality Gates
- Always run type-checker, linter, and all tests before committing.

### 2.5. Communication (user-facing messages)
Apply this as part of §2 before any user-facing summary:
- **Plain language.** User-facing narration is short, clear, plain words of the dialogue language; when the dialogue language is not English, transliterated English jargon is banned — an English term survives only as the NAME of a thing (a flag / command / file / test), glossed in plain words when helpful; plain English stays plain for English-dialogue users.
- **Deliver the artifact IN the message** — paste the prompt / diff / version / command inline; never "see §X / open the file / run it and you'll see" as a *substitute* for showing what was asked.
- **Lead with the result**, then the details; show exactly what was asked — no deflection, no "almost done" when the ask was the finished thing.
- **No condescension, no filler.** Own a miss plainly and fix it in the same message.
- **Large artifact (≈>100 lines):** deliver a real summary or the key excerpt inline **and** link the file — never flood the reader with a 2000-line paste, never hide the answer behind a bare pointer.
- **Live host/session facts are tool-composed only.** Any claim about the current host or session state (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts) must trace to **live tool output** from **this session**; a memory/handover snapshot is **context, never report facts**, and a claim with no live signal is **omitted or explicitly marked unverified** — never asserted from recollection.

### 2.6. Planning, review & process-fidelity invariants
Apply these when authoring a plan, reviewing, folding a finding, or editing code — the layer read **before any code change**. (Full canon: the project's planning / workflow-methodology + orchestration canon. This section is rendered from that canon and refreshed on upgrade; a custom edit is preserved verbatim, but flagged.)
- **Fold by code, not prose.** Before folding a code-touching finding into a plan or change, read the cited `file:line` and cite it — a prose fold drifts from the code and seeds the next bug.
- **Right altitude.** Pin intent + invariants + acceptance criteria (named tests); leave fine code-mechanics to Execute, where prose cannot diverge from reality.
- **No code-mechanics in the plan.** A Step still carries its exact paths + commands (the plan-structure / self-review canon) — checked syntax: the plan's own Verification runs them against an explicit expected outcome or gate; the only other syntax a plan may carry is a literal fixture/schema fragment a named test copies or validates. Un-run, logic-bearing syntax — control-flow, a regex, a glob, a grammar, an algorithm body, a mini-DSL — never lives in plan prose, however plausible or shell-verified it looks: a fold or draft that wants one is the trigger to write the test instead.
- **Test-as-spec.** Fold a code-touching finding into a red→green TEST, not a prose paragraph — the gate is the only deterministic checker; a paragraph cannot self-check.
- **Characterize-first.** Before editing UNCOVERED code, pin its current behavior in a green test, then edit — any unintended change goes red. Never edit what has no checker; first give it one. Keep edits atomic/reversible; prefer SUBTRACTIVE folds.
- **Fold minimally — prose has no checker.** An ephemeral, gitignored plan is prose with no executable checker; fold **minimally, in ONE place** and run a **self-consistency** read across the plan before every re-review — a fold that drifts several prose spots is what turns a 2-round review into churn.
- **Heavy review at the diff.** Plan-review settles architecture only (≤2 rounds, stop at the pre-existing→fold-induced crossover); the exhaustive per-Step review runs against real compiling code + the full suite, where a regression fails a gate immediately. **Backend divergence** (one backend grounded-ships while another keeps revising mechanics) IS that crossover — resolve at altitude, don't exhaust the strictest backend; route an all-mechanics/CI or prose-only artifact to a **thin plan + diff-review**.
- **Convergence bar.** A review loop is CLEAN only when one round returns **0 blockers + 0 majors** from EVERY backend the recipe names (nits + a ship verdict is the stop). Folding ≠ convergence — re-review after folding.
- **Per-round emission.** Every review round emits **{round N · finding-origin tally · per-backend verdict}** so the crossover is a computed, visible signal, not a remembered rule.
- **Recipe fidelity.** Council runs every backend the recipe names, **every round**; silently dropping a ready backend for quota/convenience is a forbidden downgrade — an unavailable backend is a LOUD, stated degrade, never a quiet drop.
- **ExitPlanMode ≠ execute.** A harness "approved — start coding" prompt authorizes the PLAN only; this methodology overrides it. Continue into execution only as a DELIBERATE transition after the plan + cold-start prompt exist, never an implicit slide.
- **Cost lanes.** Route every step to the **cheapest adequate executor** — L0 deterministic script (the batched gate matrix over `gates.json`, the rotation `--check`s) · L1 cheap subagent (extraction/drafting only; the orchestrator verifies) · L2 subscription bridge · L3 frontier judgment. A step with **no named guardrail does not move down** a lane, and the **red lines never move down** (council review models · real code · ADR/handover/changelog-entry wording · persuasive copy · go/no-go · the approval asks). Own-error repair: salvage recorded state first (L0/L1, batched), never frontier re-derivation. **Prompt economy:** read-only fan-out (research/sweeps/extraction) runs ONLY on restricted-tool vehicles — a full-tool subagent for read-only work is a forbidden lane downgrade (invisible prompt-flood + blast radius), and a subagent is never told to shell out for facts obtainable read-only; the orchestrator's own shell form is ONE plain pipeline per call (a `;`/`&&` chain or env-prefixed invocation never matches a prefix allow rule); a fan-out launcher that gates per call yields to the agent-spawn lane — capability-gated: without restricted-tool vehicles (generic full-tool spawning does not count), read-only research stays in the orchestrator's own context, never a vehicle mandate a host cannot satisfy. Judgment, code, synthesis stay at the frontier lane (a task that genuinely runs/writes keeps a full-tool subagent); honest limit: no deterministic gate classifies a dispatch — canon at the point of use + placed vehicles + the retro loop. **Writer economy:** a stage's repeated WRITER commands batch — evidence declarations ride consecutive plain invocations of ONE allow-listed tool, other stage writers combine via one launcher per stage; never an unbatched writer scatter (each gated write is its own prompt).

---

## 3. Token & Session Optimization

Split a complex task across sessions for **focus and review hygiene**, not because the window is small. Modern long-context models (e.g. Opus 4.8) hold large working sets well, and a stable always-loaded layer (`AGENTS.md` + `index.md`) stays prompt-cache-warm across turns — split too eagerly and you pay re-boot + cache-miss cost for nothing.

- **Split (separate sessions)** when the *change* is large enough to deserve an isolated review checkpoint: creates/deletes a source or test file, touches several files, alters a dependency / core config / data model / routes, or needs new E2E tests. These are review-hygiene triggers, independent of context size.
- **Run inline** for small, self-contained work: a few files, no new files, no dependency/schema/route change, light discussion (typos, tweaks, single-line fixes, test additions).
- **Context size is a soft, secondary signal** — split only when the working context is genuinely large *relative to the window* or you notice degraded recall, never at a fixed token count. Prefer the planning skill's **session-continuity heuristic**: keep going in-session when the accumulated context IS the execution payload (targeted-deep reads of the exact files you'll edit); split when it was broad fan-out noise.

---

## 4. User Interaction

1. **Don't rush to commit.** Prepare changes, run local quality checks, report progress with test outcomes.
2. **Get explicit approval** before COMMITTING or moving to the next phase — staging is reversible loop-work (the final-run ordering stages first, reviews the staged tree, then asks ONCE at the commit; a separate staging ask is a useless approval).

---

## 5. Planning Workflow

All plan-file rules — vocabulary (Plan → Phase → Step → Substep), lifecycle (`docs/plans/<slug>.md`, gitignored, never committed), the mandatory final **Phase: Cleanup**, the `docs/plans/queue.md` series-index, "all work in plans", the plan-then-execute split — live in the project's planning skill. It is the single source of truth and overrides the generic `writing-plans` skill.
