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

## 7. Plan-document structure

```
# Plan: <human-readable title>

## Context              ← why this Plan exists, current state, why now (reads cold)
## Approach             ← chosen design + an explicit "What we are NOT doing"
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
