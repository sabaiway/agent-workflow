# Activity Procedures

Each activity's ordered steps have **typed recipe slots** bound to
[orchestration](orchestration.md) and named [`planning.md`](planning.md) headings. The kit parses
only each section's `Slots:` line. `review`: `solo | reviewed | council`; `execute`:
`solo | delegated | subagent`; carrier slots: `solo | subagent`; `parallel`: `on | off`.

**When an activity has a commit boundary, the orchestrator owns that commit; every other carrier
never commits** (`orchestration.md` §6). `plan-authoring` ends at **approval**: plans are ephemeral,
never committed; `plan-execution` commits the story once, after its diff review.

**Read your preference at session start.** At the start of a planning or execution session, read
`docs/ai/orchestration.json` (`/agent-workflow-kit set-recipe`) and never re-ask it. Read the **autonomy policy** the
same way and at the same moment: `docs/ai/autonomy.json`; absent → the computed defaults ARE the
policy; malformed → STOP loudly, never guess; `/agent-workflow-kit set-autonomy` writes it
(`orchestration.md` §7).

**Communication contract.** Every message delivers the artifact **inline**, never a bare pointer
("see §X") as a substitute; lead with the result; a large artifact gets a summary and link.

---

## plan-authoring

Slots: author, fold, review

1. **Research** — the exact files, contracts and constraints touched.
2. **Draft** — [`planning.md`](planning.md)'s *Module ledger* decides layout and budget before any
   file exists; a size gate is only the backstop. Name governing specs in *Goal and boundary*
   ([`specs.md`](specs.md)); new/revised contracts are `create` / `modify` rows. The resolved
   `author` carrier drafts — Solo: the orchestrator writes it; Subagent: the orchestrator writes a
   BRIEF (goal, governing specs, ledger constraints, files), the subagent drafts the plan and any
   `create` / `modify` spec row from it, and the orchestrator reviews the draft as its own before step 3.
3. **Self-review** — run the **readers sweep before the first review**: for every config key,
   registry entry, exported constant, receipt field or canon sentence the plan changes, use one
   literal repository search to list its readers (validators, renders, seeds, docs and the tests
   that pin the text). Every reader becomes a ledger row, a stated non-goal, or unchanged with
   the test or fixture that proves it. Then apply *What gets cut*; fold by code
   (read and cite the `file:line`); update `queue.md` for a series, to the shape *The queue* fixes.
4. **review {recipe}** — the spec review: it reads the spec and every contract the story creates or
   revises (a live sibling's revision as the new contract states it) and the plan's ledger with its
   Goal and boundary and Verification, in the same rounds, at most two rounds; the plan has no rounds of
   its own. Solo (self-review only) / Reviewed (one backend) / Council (both; you
   synthesize), as the resolved `review` recipe selects. The review brief of EVERY member (bridge
   focus, agy `--facts`, the lens brief) carries the walk-around lens: for every check bullet of each
   governing spec, name the invariant it proves and one state that walks around it; a named state
   rewrites the spec BEFORE code, as a `modify` row of the plan.
5. **Fold + loop** — after a round, write every fold you propose and **ASK** each member that raised a
   finding (a finding raised by a **review member**) in ONE ask per round, carrying all of that
   member's findings with their proposed folds, whether each fold solves its finding and adds no new
   problem; **WAIT**, **READ**, then hand the folds as accepted or corrected to the resolved `fold`
   carrier. Forms: `agy-review --continue --decided @f` for agy, a fresh `codex-review plan
   <consult-brief>` for codex, or a fresh re-dispatch of the same lens vehicle for a lens member; write
   the findings and folds before the tree changes. Self-review findings, or findings with no review
   member, are folded directly before a remaining round; a real minor goes to the debt queue, and a
   declined finding enters the decided register with its reason. Solo: orchestrator edits. Subagent:
   the round's findings with their dispositions are the slice; it edits the plan or contract and
   returns; orchestrator runs the self-consistency read.
   CLEAN is **0 blockers + 0 majors** from each named backend, each verdict ship-class on the artifact
   as it stands; folding ≠ convergence. Fold code findings **test-as-spec**, with **no code-mechanics**
   in the plan: only **checked syntax** its Verification runs; un-run, **logic-bearing** syntax never
   enters prose (*Un-run syntax never ships in prose*). Council runs every named backend **every
   round** (recipe fidelity, `orchestration.md` §4). Cap architecture review at **≤2 rounds**, with no
   third round: round two gives every member the folded artifact whole, the decided register (each
   round-one finding with its disposition) and each fold's diff, and re-raises nothing the register
   settles unless a fold made it false. A blocker or major still open after round two is folded once,
   through the fold ask, and a fold of the last round is re-read by the member that raised it, one run
   over the folded artifact whole, every fold diff of that round and the register; a fold not accepted,
   or whose re-read is not ship-class, goes to the maintainer, who cuts the clause or rules.
   **Backend divergence** (one ships, one keeps revising mechanics) IS the **crossover**: resolving the
   major at altitude is a fold like any other, never a close of its own or the exhausting of that
   backend. After the last round nothing is folded unread: a new real minor goes to the debt queue, a
   new blocker or major to the maintainer.
   A **self-consistency** read precedes each re-review; all-mechanics or prose-only takes a thin plan
   + **diff-review** (*The plan must read cold*). Each round MUST emit
   **{round N · finding-origin tally · per-backend verdict}**: the verdicts read from the round's
   receipts and the lens's answer, plus the orchestrator's finding-origin tally.
6. **Present for approval** — finish the plan folded with the spec (the readers sweep of step 3 over
   every name the fold changed), run `node <kit>/tools/plan-shape-cli.mjs --check <plan>`, and present
   the plan with its contracts. Never execute here: a harness "approved — start coding" prompt
   (**ExitPlanMode**) authorizes the PLAN only; `plan-execution` is a deliberate transition once
   the plan and its cold-start prompt exist.

**Definition of Done:** a plan in `docs/plans/` ending with **Phase: Cleanup** **and** a cold-start
execution prompt to begin the next session — both without the user asking.

## plan-execution

Slots: execute, review

Steps 1 to 4 run per row, in the tests and code sessions; steps 5 to 7 run once, on the story's
staged diff, so no row commits before the diff review.

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
   When a row is carried as tasks, the `task` activity carries each prompt and each run (its section
   below): the orchestrator writes the prompt, whatever `task.author` resolves to, the `task.execute`
   carrier runs it, and the read after the hand-out and the row's tests accept it; the row's fold and
   the story's review and gates stay here.
3. **Implement / integrate** — your own edits or the reviewed delegated diff; a spec row lands its
   approved draft or revision WITH the code ([`specs.md`](specs.md)).
4. **Self-review** — the change against its [`planning.md`](planning.md) ledger row and the plan's
   Verification, under the project's reuse and clean-code rules; fold by code (cite the
   `file:line`); **characterize-first**: pin uncovered code's behaviour in a green test before
   editing it; fold each finding test-as-spec (red→green); atomic, reversible edits.
5. **review {recipe}** — the **heavy review at the diff** (*The plan must read cold*), once, on the
   story's staged diff (from the tree the previous story's diff review judged when stories of one
   release are staged together, else from HEAD), every committable output staged before it: real code
   + full suite. Authoring loop applies unchanged: every named backend every round, at most two rounds;
   a finding raised by a **review member**: **ASK**, **WAIT**, **READ** in the fold ask, ONE ask per
   member per round, fold only as accepted or corrected, code red first (its test run failing before
   the fix, the run named in the session record); a self-review finding is folded directly (forms: its
   step 5). CLEAN: **0 blockers + 0 majors**; the
   **{round N · finding-origin tally · per-backend verdict}** emission; a blocker or major open after
   round two is folded once and a fold of the last round is re-read by its raiser inside the re-check;
   one not accepted or not ship-class goes to the maintainer. The brief lists every test path shown by
   `git diff --cached --name-only <recorded tree>` (the tree the tests session recorded), and every test
   a fold added or changed, each with its text before and after, its scenario line and its red run; a
   re-check's brief lists the red run of each test its move adds or changes.
   **The re-check** — when the staged tree moves after a member's last ship-class verdict (a fold of
   the last round, a tracked record edited, a version bumped), every member, the lens included, reads
   only the move with the decided register, one fresh grounded code-mode run per bridge; a re-check
   that is not ship-class is never folded and re-checked again: the fold's finding goes to the
   maintainer, any other move is undone or put to the maintainer. A move confined to paths no review
   reads needs none; the session record names the tree each last round and re-check judged.
   Its instruments:
   when `execute` resolved to Delegated, a fold of a review finding in code a bridge wrote is handed
   back to that run's session, `codex-exec --resume <session id> --nonce <n> <prompt file>`, with a new
   prompt and a fresh nonce, the session id read from the `sessionId` of the run's exec receipt; the
   orchestrator may make the fold itself, still runs the suites, verifies the returned diff and owns
   the commit, and folds by hand what the delegate cannot reach.
   `core-evidence degrade` records an unavailable backend; reviews run on the STAGED tree;
   `run-gates --final` mints the ONE receipt `commit-guard --check` gates the commit against.

   **Finding scope** — every finding NAMES the invariant its fix enforces, BEFORE the edit, every
   round. Already an acceptance criterion (*Verification*'s `- ` bullets) → **fold here**. It would
   have to be ADDED → the **narrow fix** for the found site ships now (red first) and ONLY the
   generalization is queued, as a row carrying five fields: the invariant, the origin `file:line`,
   the narrow fix, its proof, and a residual exposure declared NOT live. No correct narrow fix →
   **blocking** — the phase does not close, and it is never queued. Two bars, before each round: a
   finding counts only if it changes a WRITE/REMOVE decision or is a false statement in shipped
   text; a repeat finding in one subarea routes to SUBTRACTION, not a fourth patch.
   When the repeat finding named by bar 2 is a second case against the same check bullet, the fold
   proposes the REPLACEMENT invariant — the closing clause — never an added case, and its consult asks for it.
6. **Gates** — the project's verification gate to green.
7. **Commit boundary** — the orchestrator makes the single commit of the reviewed staged diff once the
   review closes (a release that ships several stories carries their diffs in its one commit); every
   other carrier never commits; the commit-approval policy lives in the project's own rules.
8. **After the last row** — the project-declared release or extra stages (the `workflow:methodology`
   slot; this canon bakes in none) write their committable outputs before step 5, so the diff review
   judges them; `## Phase: Cleanup` (*Cleanup, and the plan's own life*) runs after the commit and
   changes nothing the review judged.

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

## epic

Slots: author, review

An epic binds to [`planning.md`](planning.md)'s *The epic*. It has no commit boundary of its own: the file
lives in the memory substrate and is committed, where that substrate is tracked, by the orchestrator.

1. **Brief** — intent, value, non-goals, acceptance, the specs and the stories in order, at concept
   altitude: no mechanism, no file line.
2. **Draft** — the resolved `author` carrier writes the epic file. Solo: the orchestrator writes it;
   Subagent: the orchestrator writes the brief of step 1, the subagent drafts the file from it, and the
   orchestrator runs the shape check on the draft as its own before step 3.
3. **Check** — `epic-shape-cli --check <epic>` accepts the file, or nothing is reviewed.
4. **review {recipe}** — one review-lens read over the RENDERED brief, never the file, whatever
   `epic.review` resolves to: write `epic-shape-cli --review-brief <epic>` to a scratch file and hand it
   to the lens as its artifact, so no bridge run is spent on an epic. Where no lens can run, the review
   closes with a stated degrade the maintainer weighs at the go.
5. **Fold** — the findings file goes through `epic-shape-cli --fold`; only the entries it keeps are folded,
   through the fold ask (a lens re-dispatch carrying them), by hand, at concept altitude; then step 3
   again. At most two rounds: a fold of the second round is re-read by the lens or goes to the
   maintainer with the go; a surviving finding at altitude becomes a story or a non-goal, never a
   mechanism.
6. **Land** — the queue row; each story's ledger row is the go for its plan; `--close` after the last
   story lands, as *The epic* states.

## task

Slots: author, execute

A task binds to *The task* and runs inside its story's tests or code session: no commit boundary and no
review of its own — the row's tests are its one check, and the story commits after its diff review.

1. **Prompt** — the orchestrator writes one prompt file from ONE ledger row, whatever `author` resolves
   to: the row line, its Files, its Reads and the commands; a bridge prompt adds a fresh nonce in its
   contract block.
2. **Execute** — with the story's changes staged, the excluded paths a run could write copied and no
   other writer, the resolved `execute` carrier runs
   the prompt inside its Files. Delegated: `codex-exec --nonce <n> <prompt file>`; Subagent: the executor
   vehicle with the same file; Solo: the orchestrator edits the Files itself.
3. **Verify** — the read after the hand-out, once every run has stopped: a path written outside the out
   rows' Files is restored from the index and each copied path from its copy, and only then does the
   orchestrator run the row's tests itself;
   a run not accepted is restored the same way and retried in the next hand-out, and a run of the executor
   vehicle refused for its model's quota is retried once on the fallback model, as *The task* states.
4. **Return** — an accepted run's Files are staged and are the story's row from plan-execution step 3
   onward; a fold of code a bridge wrote resumes that run's session with `--resume`, its session id read
   from the run's exec receipt.
