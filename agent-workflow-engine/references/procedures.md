# Activity Procedures

The ordered steps of each named activity, with **typed recipe slots** bound to the
[orchestration recipes](orchestration.md). It composes with — never restates —
[`planning.md`](planning.md), naming its sections by *heading*. The kit reads this file
live and parses only each section's `Slots:` line.

A **recipe slot**: `review` accepts `solo | reviewed | council`; `execute` accepts
`solo | delegated | subagent`; a carrier slot (`author`, `fold`, `carrier`) accepts `solo | subagent`;
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

Slots: author, fold, review

1. **Research** — the exact files, contracts and constraints touched.
2. **Draft** — write to the shape [`planning.md`](planning.md) fixes; its *Module ledger* decides
   the layout and every budget before any file exists — a size gate is only the backstop. Name the
   governing spec(s) in *Goal and boundary* ([`specs.md`](specs.md)); a new feature's draft spec is
   a `create` row and a revision of a governed contract a `modify` row, both written here so they
   exist AT review. The resolved `author` carrier drafts — Solo: the orchestrator writes it;
   Subagent: the orchestrator writes a BRIEF (goal, governing specs, ledger
   constraints, files) and the subagent drafts the plan and any `create` / `modify`
   spec row from it, and the orchestrator reviews the draft as its own before step 3.
3. **Self-review** — run the **readers sweep before the first review**: for every config key,
   registry entry, exported constant, receipt field or canon sentence the plan changes, use one
   literal repository search to list its readers (validators, renders, seeds, docs and the tests
   that pin the text). Every reader becomes a ledger row, a stated non-goal, or unchanged with
   the test or fixture that proves it. Then apply *What gets cut*; fold by code
   (read and cite the `file:line`); update `queue.md` for a series, to the shape *The queue* fixes.
4. **review {recipe}** — Solo (self-review only) / Reviewed (one backend) / Council (both; you
   synthesize), as the resolved `review` recipe selects.
5. **Fold + loop** — before folding a finding raised by a **review member**, **ASK** that member whether the
   proposed fold solves it without a new problem; **WAIT**, **READ**, then hand the accepted or
   corrected fold to the resolved `fold` carrier. Self-review findings, or findings with no review
   member, are folded directly. Forms: `agy-review --continue --decided @f` for agy, a
   fresh `codex-review plan <consult-brief>` for
   codex, or a fresh re-dispatch of the same lens vehicle for a lens member; write the finding and
   fold before the tree changes. Solo: orchestrator edits. Subagent: the round's findings with their
   dispositions are the slice; it edits the plan or contract and returns; orchestrator runs the
   self-consistency read.
   Fold and re-review every finding; CLEAN is **0 blockers + 0 majors** from each named backend;
   folding ≠ convergence. Fold code findings **test-as-spec**, with **no code-mechanics** in the
   plan: only **checked syntax** its Verification runs; un-run,
   **logic-bearing** syntax never enters prose (*Un-run syntax never ships in prose*). Council runs
   every named backend **every round** (recipe fidelity, `orchestration.md` §4). Cap architecture
   review at **≤2 rounds**; **backend divergence** (one ships, one keeps revising mechanics) IS the
   **crossover** — resolve the major at altitude, not by exhausting that backend.
   A **self-consistency** read precedes each re-review; all-mechanics or prose-only takes a thin plan
   + **diff-review** (*The plan must read cold*). Each round MUST emit
   **{round N · finding-origin tally · per-backend verdict}**: READ its verdict half from the round
   render (`review-rounds`, the kit's table over the review receipts); append the orchestrator's finding-origin tally
   judgment. At the cap, classify surviving blockers/majors: **fixable-bug** (fold ONCE as a red→green test, re-review) /
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
   Before a row's dispatch, and before `flow-writer adoption` on an armed flow, run
   `node <kit>/tools/robustness-brief.mjs --plan <plan> --coverage`, fix the tags, re-run
   `plan-shape --check`, and only then generate the brief. The dispatch brief — Delegated or
   Subagent — carries the generated robustness-literals block for every tagged row.
3. **Implement / integrate** — your own edits or the reviewed delegated diff; a spec row lands its
   approved draft or revision WITH the code ([`specs.md`](specs.md)).
4. **Self-review** — the change against its [`planning.md`](planning.md) ledger row and the plan's
   Verification, under the project's reuse and clean-code rules; fold by code (cite the
   `file:line`); **characterize-first**: pin uncovered code's behaviour in a green test before
   editing it; fold each finding test-as-spec (red→green); atomic, reversible edits.
5. **review {recipe}** — the **heavy review at the diff** (*The plan must read cold*): real code +
   full suite. Authoring loop applies unchanged: every named backend every round; a finding raised
   by a **review member**: **ASK**, **WAIT**, **READ**, fold only as accepted or corrected; a
   self-review finding is folded directly (forms: its step 5). CLEAN:
   **0 blockers + 0 majors**; the **{round N · finding-origin tally · per-backend verdict}**
   emission; **fixable-bug / inherent-layer-residual / escalate** at the cap. Its instruments:
   when `execute` resolved to Delegated, a fold of a review finding is `codex-exec --resume <held id>
   --nonce <nonce> <fold-brief>` — the session the first FOLDED delegated dispatch's exec receipt minted
   — the first delegated code that entered the tree, never an earlier failed or unfolded run — held
   until the row's commit (a nonce-less run mints no receipt and is invisible to the judge); a fresh session for
   a fold is a forbidden substitution `review-state` names (a retry of a failed thread and a recorded
   execute degrade excepted); the orchestrator still runs the suites, verifies the returned diff,
   re-mints the red-proofs and owns the commit, and folds by hand only what the delegate cannot reach.
   `core-evidence red-proof` declares each bugfix red BEFORE the fix; `core-evidence
   degrade` records an unavailable backend; reviews run on the STAGED tree; `run-gates --final`
   mints the ONE receipt `commit-guard --check` gates the commit against.

   On an **ARMED flow**, a **bridge-raised** finding uses this order: the round is open; dispatch
   its consult with a nonce; WAIT and READ; accept or correct the fold; run
   `flow-writer consult-attestation <planId> --backend <id> --nonce <n> --proposed-fix-digest
   <the-sha256-of-the-fold-text>`; then edit. The attestation records the manifest and fold digest,
   never the run or answer. A **lens-raised** finding instead re-dispatches the lens without a nonce
   (WAIT and READ, edit as accepted or corrected); it mints no manifest and no attestation; only its
   per-round participation rides `internal-attestation`.

   For an ARMED flow, every fold owes a walk: run `flow-writer internal-attestation <planId> …
   --walk <file>` on folded bytes before the next `round-open`; it records `uncovered` and never
   refuses it, while `--justification` lifts the walk refusal as an echoed input. The cap is the round
   table's own signal (`cap reached` / `crossover`, computed by `round-open` from the round's landed dispatches), never a tool's constant:
   past it `round-open` refuses until every blocking item of the latest round has one disposition:
   `folded` (its proof), `queued` (`--claim` plus a bound proof and the fold-scope ACCEPT), `rejected`
   (its reason), `escalated` (its maintainer-override), or `custody-lost` (a lost manifest, recorded first).

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

## feedback-triage

Slots: review

1. **Record** — write the field report as a record in the record grammar: a title, the source,
   the HEAD the claims are verified on, and ONE claims table (claim · evidence · verdict ·
   disposition); stamp the HEAD.
2. **Verify** — every claim by code on that HEAD, `file:line` evidence, a verdict from the closed
   list (confirmed · corrected · refuted · works-as-designed).
3. **Check** — `feedback-record-cli --check <record>` exits 0 before any row is written: the
   shape, every anchor on the checkout, the HEAD.
4. **review {recipe}** over the verdicts — the record is the artifact: `--excerpts` first, then
   the bridges in plan mode over the record, the excerpts as agy's `--facts` payload, the round
   table on the record.
5. **Rows** — `feedback-record-cli --rows <record>` renders the skeleton queue rows and the
   ratchet line; paste and word them, then `queue-audit --check`.
6. **Fold** only a false statement in shipped copy, red-first; everything else is a row, or an
   already-queued / declined disposition that opens none.
   Definition of Done: a checked record, its rows in the queue, the ratchet moved by exactly the rows rendered
   (unmoved when the record opens none).
