# Planning Workflow

Source of truth for **how plans are written, stored, executed, and torn down**. Overrides the generic `writing-plans` skill — if both trigger, this one wins. Runtime series status (which plan is Current / Pending) lives in `docs/plans/queue.md`.

---

## 1. Plan vocabulary

Strict four-level hierarchy, used in plan files (`docs/plans/*.md`) and in verbal summaries:

- **Plan** — top-level container = the plan file itself. One file = one Plan. A series of related plans is not grouped under any wrapper noun; refer to them as "Plan 1 of N", "the next plan". Series order lives in `queue.md` (§3).
- **Phase** — a large block inside the Plan. Exactly one execution session. Ends with its own verification block. `## Phase 1: …`, `## Phase 2: …`.
- **Step** — an atomic change inside a Phase. Numbered `<phase>.<step>`: `### 1.1. …`. One Step → one logical commit.
- **Substep** — optional split of a complex Step. Lettered: `**1.2.a**`, `**1.2.b**`. Use only when a Step cannot be one command.

Reserve the word "task" for the todo list and `active_plan.md` — not for plan structure.

## 2. Plan directory & lifecycle

Plan files are **ephemeral, machine-local scratch space**, gitignored (`.gitignore` contains `docs/plans/`).

**Lifecycle:** Creation (untracked file) → Execution (Phases 1..N-1) → mandatory **Phase N: Cleanup** (§4) → Post-deletion (only `changelog.md` + ADRs remain). Plans are **NEVER committed** — full stop. Even if a plan looks load-bearing (referenced by an ADR), inline the load-bearing content into a persistent doc and delete the plan file.

**Forbidden:** `git add` of any plan file; plan-file paths in committed docs; leaving plan files on disk after Cleanup. If the user says "commit the plan" — ask back: "the plan is ephemeral — what exactly should I inline into `decisions.md` / `changelog.md`?".

## 3. Series & queue.md

A **series** = 2+ related plans that share a roadmap. The index lives at `docs/plans/queue.md` (gitignored, machine-local):

```markdown
## Series: <name>

### Current
- **Plan N / M** — <slug> — <one-line description>

### Pending
- **Plan N+1 / M** — <slug or TBD> — <description>

### Done
- **Plan K / M** — <slug> — done YYYY-MM-DD. Outputs: <pointers>.
```

`queue.md` is initialised when the **first** plan of a series is written, not during its Cleanup — without an upfront index the execution agent has no map of the series. Each plan's Cleanup then marks itself Done (with outputs) and promotes the next plan to Current. A single, unrelated plan does not need a series entry.

## 4. Required Cleanup phase

Every Plan MUST end with a final **Phase N: Cleanup** — the last numbered Phase. Without it the Plan is not done.

Minimum content:

- **Migrate outputs** → `docs/ai/decisions.md` (AD-XXX), `changelog.md`, `known_issues.md` (Issue-XXX), `current_state.md`, `pages/<page>.md`.
- **Inline cross-references** — `grep -rn "<plan-slug>" docs/` must be empty. Every pointer is rewritten inline or removed.
- **Update `queue.md`** — if part of a series, mark Done + promote next.
- **Delete the plan file** — `rm docs/plans/<slug>.md`.
- **Verification** — `grep -rn "<slug>" .` empty; `ls docs/plans/<slug>.md` → No such file; docs cap-validator green.

If a Plan is aborted mid-flight, Cleanup still runs — partial outputs land in `known_issues.md`, then the file is deleted.

## 5. All work in plans

Anything required for the task is a **Step inside the Plan**. Nothing "before the plan", "between plans", or "don't forget" — those evaporate at execution time because the execution agent reads only the plan file, not chat scrollback. Every dependency, check, and install is its own Step or Substep. The final "Next steps" section contains **only user-actionable** items.

## 6. Plan-then-execute split

Default workflow for non-trivial features (multi-file change, new service + hook + UI, architectural choices): write a **self-contained Plan** and stop. Implementation runs in a fresh session via the `executing-plans` skill.

- Triggers: any feature, refactor, or change touching more than ~1 file, or non-obvious architectural choices.
- Does NOT apply to typos, one-line fixes, doc-only edits, or pure "where is X" research — those run inline.
- The Plan must be readable cold by a fresh agent: file paths, contracts, execution order, verification, gotchas — all inside the file.

This split is a token-efficiency strategy: exploration context stays out of the execution window.

### Session-continuity heuristic (split vs continue)

The volume trigger above (files / LoC / tokens) is necessary but not sufficient. The deeper question is whether the planning context is the execution **payload** or **noise**:

- **Split** (fresh session) when planning exploration was *broad fan-out* — many files skimmed, sub-agent dumps, wide searches to *locate* things. That context is noise for execution; discard it.
- **Continue** in the current session when ALL hold: (1) exploration was *targeted-deep* — you read the exact files to be created/modified/copied, so execution would just re-read them; (2) no new heavy exploration is needed to execute; (3) the context budget is healthy (far from the window limit / Lost-in-the-Middle).
- When continuing, each Phase's Verification block is a natural checkpoint. If different Phases need different cold context, continue only through the warm Phases, then split.

### ExitPlanMode authorizes the plan, not execution

A harness "approved — you can now start coding" prompt (e.g. Claude Code's **ExitPlanMode**) authorizes the **PLAN only** — this methodology overrides that generic prompt. A planning session is not done until the plan is landed in `docs/plans/` **and** the cold-start execution prompt is emitted (the plan-authoring Definition of Done). So **"Continue in-session" above is a DELIBERATE transition into `plan-execution`, taken *after* both of those exist** — never an implicit slide from plan-approval straight into editing tracked files. Plan-approval is not a licence to execute the plan in the same breath; the boundary holds whether you split or continue.

## 7. Plan-document structure

```
# Plan: <human-readable title>

## Context              ← why this Plan exists, current state, why now (reads cold)
## Approach             ← chosen design + an explicit "What we are NOT doing"
## Decisions (locked)   ← optional: settled, binding decisions the executor must not re-litigate
## Phase 1: <name>
   ### 1.1. <step>      ← exact paths + commands
## Phase 2: <name>
   ...
## Phase N: Cleanup     ← mandatory (§4)
## Critical files       ← table: file → change kind (new / modify / delete / move)
## Reuse                ← pointers to existing patterns/snippets to copy, not re-derive
## Verification         ← full check sequence (mechanical + behavioural)
## Next steps           ← user-actionable only (§5)
```

## 8. Self-review checklist (before finalizing a Plan)

- Every Step has exact file paths and exact commands.
- Every recommendation that used to live outside the Plan is now a Step (§5).
- Vocabulary is strict (§1); the Plan ends with **Phase N: Cleanup** (§4).
- If part of a series: `queue.md` is initialised / updated (§3).
- No `git add <plan>` and no "commit the plan" wording in the final report.
- Every code-touching decision cites the `file:line` it is grounded in; the plan stays at intent / invariant / acceptance altitude, leaving fine code-mechanics to Execute (§9).
- Decisions the review loop SETTLED (fixtures, contracts, boundary clauses) live under the optional `## Decisions (locked)` heading (§7) — binding for the executor, never re-litigated at Execute.

## 9. Right-altitude & code-grounded folds

These disciplines keep a plan converging instead of churning, and keep a fold or edit from shipping a new bug. They govern authoring, every review round, and execution. The honest premise: prose has no checker, so the only guarantee that a fold/edit ships no regression is a deterministic, non-vacuous, auto-run gate — hence test-as-spec + characterize-first below.

**Right altitude.** A plan pins *intent + architecture + invariants + acceptance criteria* — the named tests that must stay green and the new tests that must pass. It does NOT spell out fine code-mechanics in prose: those are resolved in code at Execute (against the real files + the per-Step review + the gates), where prose cannot diverge from reality. Most "blockers" that resurface across review rounds are code-level details that never belonged in a prose plan.

**No code-mechanics in the plan.** A Step still carries its exact paths + commands (§7, §8) — checked syntax: the plan's own Verification runs them against an explicit expected outcome or gate, and merely running without asserting checks nothing; the only other syntax a plan may carry is a literal fixture/schema fragment a named test copies or validates. Un-run, logic-bearing syntax — control-flow, a regex, a glob, a grammar, an algorithm body, a mini-DSL, anything that transforms data or evaluates a condition — never lives in plan prose, however plausible or shell-verified it looks ("I ran it in my shell" is not a checker): a fold or draft that wants one is the trigger to write the red→green test-as-spec at Execute instead.

**Fold by code, not prose.** Before folding any code-touching finding into the plan, READ the cited `file:line`; the fold cites it. A fold grounded in prose alone drifts from the code and seeds the next bug.

**Test-as-spec.** Fold a code-touching review finding into a red→green TEST, not a prose paragraph — the gate is the only deterministic checker, and a paragraph cannot self-check. A bug may still be written, but the test catches a fold-/edit-induced regression before it ships.

**Characterize-first.** Before editing UNCOVERED code, first write a test pinning its current behavior (green), then edit — any unintended change goes red. Never edit what has no checker; first give it one. Keep edits atomic/reversible (one logical change = one gated commit), and prefer SUBTRACTIVE folds.

**Fold minimally — a prose plan has no checker.** An ephemeral, gitignored plan is PROSE with no executable checker, so a single fold that silently drifts one of several prose spots seeds the next churn round (this is what turns a 2-round review into a 6-round one). Fold **minimally, in ONE place**, run a **self-consistency** read across the whole plan before every re-review, and keep the plan SHORT. The only runtime firing an ephemeral plan can carry is the point-of-use advisor's printed review-loop checkpoint — there is no other checker.

**Heavy review at the diff, not the plan.** Plan-review settles architecture only (≤2 rounds, stop at the pre-existing→fold-induced crossover); the exhaustive per-Step review runs against real compiling code + the full suite, where a regression fails a gate immediately. **Backend divergence** — one backend grounded-ships while another keeps revising line-by-line mechanics — IS that crossover: resolve at altitude (raise the surviving major to an acceptance invariant, or hand the mechanics to Execute), do not exhaust the strictest backend. Route an all-mechanics/CI or prose-only artifact to a **thin plan + diff-review**, where the runner and gates settle it, not another prose round. The plan is the wrong place for an exhaustive line-by-line review.

**Convergence bar.** A review loop is CLEAN only when one round returns **0 blockers + 0 majors** from EVERY named backend the recipe runs (nits / non-blocking + a ship verdict is the stop). FOLDING a finding is NOT convergence — re-review after folding. This §9 governs the ALTITUDE at which you reach clean (fix the major, or raise it to an explicit acceptance invariant Execute must meet) — it NEVER lowers the bar to "majors folded".

**Convergence heuristic.** When a review round keeps finding code-mechanism issues on a stable architecture, STOP refining prose — either raise the spec to invariant + acceptance altitude, or hand the mechanics to Execute. Do not re-litigate code mechanics in the plan.

**Computed instrument (plan-execution).** The **review-ledger** computes the crossover-stop for the plan-execution (code) loop: each round and each triage classification — **fixable-bug** (a fold pinned by a red→green test) / **inherent-layer-residual** (raised to an acceptance criterion) / **escalate** (a maintainer decision) — is recorded, and the stop decision is READ from the ledger, never remembered; its `--check` is the loop's gate (the exit contract lives in the tool's own header — point, don't restate). The same per-round tally + classification discipline governs plan-authoring review; the ledger itself is plan-execution-scoped.

## 10. Autonomy at the plan checkpoints

The plan lifecycle's human checkpoints — plan **approval** (plan-authoring ends there), each
**gated commit** (plan-execution commits per Step), and any push/publish ask — are **fixed points
the autonomy policy never moves** (`orchestration.md` §7). What the per-activity level changes is
the texture *between* them: under `sandbox` autonomy the executor runs a whole working stretch —
edits, tests, gates, review dispatches — to the next checkpoint without per-command prompts (the
OS sandbox confines the blast radius); under `prompt` it asks along the way. **Read the policy at
session start** (`docs/ai/autonomy.json`; absent → the computed defaults ARE the policy; malformed
→ STOP loudly) alongside the standing recipe preference, and state the effective level in the
session's opening summary so the human knows which texture to expect. A plan itself never needs to
restate the policy — it is per-project configuration, not plan content; a plan names an autonomy
requirement only when a Step genuinely departs from the declared level (e.g. a consent-gated
privileged install), and that departure is always an explicit ask, never a silent widening.
