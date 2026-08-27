# Activity Procedures

The ordered steps of each named activity, with **typed recipe slots** bound to the
[orchestration recipes](orchestration.md). It composes with — never restates —
[`planning.md`](planning.md), naming its sections by *heading*. The kit reads this file
live and parses only each section's `Slots:` line.

A **recipe slot**: `review` accepts `solo | reviewed | council`; `execute` accepts
`solo | delegated | subagent`; a carrier slot (`author`, `carrier`) accepts `solo | subagent`;
`parallel` is a switch (`on | off`), not a recipe. The per-project default lives in
`docs/ai/orchestration.json`.

**When an activity has a commit boundary, the orchestrator owns that commit; every other carrier is
advisory or delegated, never autonomous, and never commits** (`orchestration.md` §6). `plan-authoring` ends
at **approval** with no commit (plans are ephemeral, never committed); `plan-execution` commits per
ledger row.

**Read your preference at session start.** At the start of a planning or execution session, read
`docs/ai/orchestration.json` (`/agent-workflow-kit set-recipe` writes it; hand-editing stays
supported) and never re-ask it. Read the **autonomy policy** the same way and at the same moment:
`docs/ai/autonomy.json` (absent → the computed defaults ARE the policy; malformed → STOP loudly,
never guess; `/agent-workflow-kit set-autonomy` writes it) — every procedure below runs UNDER it
(`orchestration.md` §7).

**Communication contract.** Every user-facing message delivers the artifact **inline** — never a
bare pointer ("see §X") as a substitute; lead with the result; a large artifact gets a real summary
inline plus the link.

---

## plan-authoring

Slots: author, review

1. **Research** — the exact files, contracts and constraints touched.
2. **Draft** — write to the shape [`planning.md`](planning.md) fixes; its *Module ledger* decides
   the layout and every budget before any file exists — a size gate is only the backstop. Name the
   governing spec(s) in *Goal and boundary* ([`specs.md`](specs.md)); a new feature's draft spec is
   a `create` row and a revision of a governed contract a `modify` row, both written here so they
   exist AT review. The resolved `author` carrier drafts — Solo: the orchestrator writes it;
   Subagent: the orchestrator writes a BRIEF (goal, governing specs, ledger
   constraints, files) and the subagent drafts the plan and any `create` / `modify`
   spec row from it, and the orchestrator reviews the draft as its own before step 3.
3. **Self-review** — apply *What gets cut*; fold by code (read and cite the `file:line`); update
   `queue.md` for a series, to the shape *The queue* fixes.
4. **review {recipe}** — Solo (self-review only) / Reviewed (one backend) / Council (both; you
   synthesize), as the resolved `review` recipe selects.
5. **Fold + loop** — fold every finding and re-review; CLEAN is **0 blockers + 0 majors** from every
   backend the recipe names — folding ≠ convergence. Fold a code-touching finding **test-as-spec**,
   with **no code-mechanics** in the plan: only **checked syntax** its Verification runs; un-run,
   **logic-bearing** syntax never enters prose (*Un-run syntax never ships in prose*). Council runs
   every named backend **every round** (recipe fidelity, `orchestration.md` §4). Cap architecture
   review at **≤2 rounds**; **backend divergence** (one ships, one keeps revising mechanics) IS the
   **crossover** — resolve the surviving major at altitude, never by exhausting the strictest
   backend; a **self-consistency** read precedes each re-review; an all-mechanics or prose-only
   artifact takes a thin plan + **diff-review** (*The plan must read cold*). Each round MUST emit
   **{round N · finding-origin tally · per-backend verdict}**. At the cap, classify each surviving
   blocker or major: **fixable-bug** (fold ONCE as a red→green test, re-review) /
   **inherent-layer-residual** (raise to an acceptance criterion) / **escalate**.
6. **Present for approval** — never execute here: a harness "approved — start coding" prompt
   (**ExitPlanMode**) authorizes the PLAN only; `plan-execution` is a deliberate transition once
   the plan and its cold-start prompt exist.

**Definition of Done:** a plan in `docs/plans/` ending with **Phase: Cleanup** **and** a cold-start
execution prompt to begin the next session — both without the user asking.

## plan-execution

Slots: execute, review

Each ledger row is one logical commit.

1. **Resolve the recipe per row** — `execute` and `review` from `docs/ai/orchestration.json` +
   readiness (`--override <slot>=<value>` per run).
2. **If `execute` resolved to Delegated, dispatch execution FIRST** — the backend returns a diff
   (codex-exec) *before* you integrate. **If `execute` resolved to Subagent**, split the ledger into
   file-disjoint slices, exact wording where wording is a red line, dispatch each slice to
   the executor vehicle in the background, and verify
   every returned slice by running its suites yourself before step 3. Otherwise implement directly.
3. **Implement / integrate** — your own edits or the reviewed delegated diff; a spec row lands its
   approved draft or revision WITH the code ([`specs.md`](specs.md)).
4. **Self-review** — the change against its [`planning.md`](planning.md) ledger row and the plan's
   Verification, under the project's reuse and clean-code rules; fold by code (cite the
   `file:line`); **characterize-first**: pin uncovered code's behaviour in a green test before
   editing it; fold each finding test-as-spec (red→green); atomic, reversible edits.
5. **review {recipe}** — the **heavy review at the diff** (*The plan must read cold*): real code and
   the full suite. The plan-authoring loop applies unchanged — every named backend every round,
   **0 blockers + 0 majors**, the **{round N · finding-origin tally · per-backend verdict}**
   emission, **fixable-bug / inherent-layer-residual / escalate** at the cap. Its instruments:
   `core-evidence red-proof` declares each bugfix red BEFORE the fix; `core-evidence
   degrade` records an unavailable backend; reviews run on the STAGED tree; `run-gates --final`
   mints the ONE receipt `commit-guard --check` gates the commit against.

   **Finding scope** — every finding NAMES the invariant its fix enforces, BEFORE the edit, every
   round. Already an acceptance criterion (*Verification*'s `- ` bullets) → **fold here**. It would
   have to be ADDED → the **narrow fix** for the found site ships now (red first) and ONLY the
   generalization is queued, as a row carrying five fields: the invariant, the origin `file:line`,
   the narrow fix, its proof, and a residual exposure declared NOT live. No correct narrow fix →
   **blocking** — the phase does not close, and it is never queued. Two bars, before each round: a
   finding counts only if it changes a WRITE/REMOVE decision or is a false statement in shipped
   text; a repeat finding in one subarea routes to SUBTRACTION, not a fourth patch.
6. **Gates** — the project's verification gate to green.
7. **Commit boundary** — the orchestrator makes the single commit; every other carrier never commits; the
   commit-approval policy lives in the project's own rules.
8. **After the last row** — the project-declared release or extra stages (the `workflow:methodology`
   slot; this canon bakes in none) and then `## Phase: Cleanup` (*Cleanup, and the plan's own
   life*) run as rows of their own, each through steps 1–7.

## routine

Slots: carrier, parallel

1. **Name the chore and its slices** — gate triage, sweeps, regeneration, fixture builds; never
   the changelog; each slice bounded and file-disjoint.
2. **Resolve the recipe** — `carrier` and `parallel` from `docs/ai/orchestration.json` + readiness
   (`--override <slot>=<value>` per run).
3. **Carry it** — Solo: the orchestrator does it. Subagent classifies each slice: read-only (a
   sweep, gate triage) rides its placed read-only vehicle, or is carried Solo with a stated reason
   when that vehicle is absent; write-capable (a regeneration, a fixture build) rides the executor.
   Dispatch in the background, concurrently when `parallel` is on.
4. **Verify** — every returned slice, by running its suites yourself.
5. **The commit boundary is unchanged** — when an accepted slice changed the tree, the orchestrator
   alone commits; a read-only chore has no commit boundary; a carrier never commits.
