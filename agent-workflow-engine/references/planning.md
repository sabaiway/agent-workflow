# Planning Workflow

How plans are written, executed and torn down. Overrides the generic `writing-plans` skill — if both
trigger, this one wins.

A plan is an **index plus constraints**, never a transcript. The executor reads the repository; the
plan tells it which files to open, what each one may become, and how the result is checked.

## The story flow

A story goes from idea to release through seven steps, in this order, each giving one checked result;
the check is the only one the step carries. "Bridges" are the bridge members a recipe names (two on a
council), so a council round costs two bridge runs.

- **Epic** — Result: the epic file (*The epic*). Maker: the orchestrator, by the `epic.author` carrier.
  Check: the epic shape gate, a review-lens read of its rendered brief in at most two rounds, and the
  maintainer's go. Cost: once per epic, before its first story; no bridge run.
- **Spec** — Result: every contract the story creates or revises, with scenarios a test can pin, an
  out-of-scope list and a Module. Maker: the orchestrator, by the `plan-authoring.author` carrier.
  Check: the spec gate, then one review that reads them and the plan's ledger in the same rounds, at
  most two, by the `plan-authoring.review` members. Cost: session 1; at most two rounds of bridge runs,
  plus the fold asks and the last-round re-reads.
- **Plan** — Result: the ledger, with files, budgets, order and the Verification commands. Maker: the
  orchestrator, drafting beside the spec after the readers sweep, before the review's first round, and
  folding it with the spec. Check: the plan-shape gate, the spec review's reading of its ledger and the
  maintainer's approval of the plan with its contracts; no rounds or sessions of its own. Cost: session
  1; no bridge run of its own.
- **Tests** — Result: failing tests, at least one per scenario the story binds (or per acceptance
  bullet of a plan that governs no spec), and every test that asserts what the story retires rewritten.
  Maker: the orchestrator, or a bridge executor for a row whose tests are new, in one prompt per row.
  Check: running them; each new or rewritten test fails for the reason its scenario states, or on the
  absence of a name the plan adds (imported inside the test), while the other tests pass; the session
  records the staged tree its run judged and copies the git-excluded paths its tests read. Cost: session
  2; one bridge run per row handed out, plus every repair run that reaches a CLI.
- **Code** — Result: code that passes the new tests, the existing suites and the pre-review gates.
  Maker: the orchestrator, or a bridge executor for a row whose code is new, in one prompt per row.
  Check: the suites and `run-gates --pre-review`; a test found wrong is changed only back to what its
  scenario states, shown red on a scratch copy of the tree the tests session recorded, and the diff
  review's brief lists it. Cost: session 3; one bridge run per row handed out, plus every repair run that
  reaches a CLI.
- **Diff review** — Result: a ship-class verdict from every member on the staged diff, every committable
  output (package changelogs, version bumps, release notes, tracked records) staged before it. Maker: the
  `plan-execution.review` members. Check: the convergence bar within at most two rounds, a fold of the
  last round re-read by its raiser and a staged tree that moves after it re-checked. Cost: session 4; at
  most two rounds of bridge runs, plus the fold asks and the re-check of a staged tree that moves after
  the last round, which carries the last-round re-reads.
- **Release and record** — Result: the one commit of the reviewed staged diff, the release where the
  story ships one, the machine-local records (the
  session changelog and the handover where they are not tracked) and the plan's Phase: Cleanup, none of
  them changing what the review judged. Maker: the orchestrator. Check: the final gate matrix, the docs
  caps and, where the story ships a release, the release run's own stages. Cost: session 4; no bridge run.

The steps run as four sessions per story, after the epic: spec and plan, tests, code, then diff review,
release and record. Tests and code never share a session, and a storyless plan runs the same four. A
split (code and its existing cases moved into modules, no new logic, no new case) is one session: a
short spec (the Module list), the split, the diff review, the release, Cleanup.

## Shape

The whole file is capped at **100 lines and at most 25 ledger rows**. While it is drafted and before
the maintainer's approval, run `node <kit>/tools/plan-shape-cli.mjs --check <plan>`. The headings are
LITERAL, copied bare: tooling extracts sections by exact match.

```
# Plan: <title>
## Goal and boundary
## Module ledger
## Verification
## Phase: Cleanup
## Next steps
```

A project-declared `## Phase: <name>` may ride between Verification and Cleanup; it is bounded by
the whole-file line cap and may not reuse the Cleanup name.

A plan that does not fit is not under-described. Either the TASK is too big — split it along
independently verifiable boundaries, never by document size — or it is a SWEEP (below).

- **Goal and boundary** (10 lines) — the observable outcome, what behaviour is preserved, explicit
  non-goals, and the GOVERNING spec(s) ([`specs.md`](specs.md)): zero, one or many — one per touched
  spec-covered slice — a ZERO names the adoption state it relies on (not adopted · adopting — either
  with a recorded decline — · nothing spec-covered touched); a bare zero is never a licence. Each
  cited spec's Out of scope is restated as a non-goal for that slice.
  A plan carrying an epic story names it with exactly one line `Story: S<N> of <ID>` (`<ID>` is the
  epic's file stem under `docs/ai/epics/`); zero such lines is a storyless plan and stays legal.
- **Module ledger** (60 lines) — the single list of paths, and the plan's execution order.
- **Verification** (20 lines) — the acceptance check, plus one command that validates the whole ledger.
- **Phase: Cleanup** and **Next steps** (human-actionable only) share the 10 reserved lines.

## Module ledger

One row per path, six fields. A row is capped at **200 UTF-8 bytes counted without its path and
anchor**: id, verb, responsibility and budget after trimming, including their three ` | ` separators.

```
<check-id> | create|modify|delete | <path> | <responsibility, one sentence> | <max lines | n/a> | <anchor>
```

**The rows ARE the steps.** They execute top to bottom in the tests and code sessions and none of them
commits; a row may only anchor on a path above it or on existing code. The story's staged diff is
reviewed whole and committed once, after its diff review. There is no separate step/phase numbering —
the only phases are session boundaries in a multi-session plan, and Cleanup.

**A contract change is a row, present at the spec review.** A NEW feature's draft spec is a `create` row
(`docs/ai/specs/<slug>.md`) and a proposed REVISION of a governed contract is a `modify` row — both
written WITH the plan, so approval confirms the plan and every cited draft or revision atomically; the
landing row moves the spec `draft -> live`, a removal row `live -> retired`.

A `create` row's responsibility names the **exported surface** the module must provide — the names
other rows import. That surface does not exist in the checkout yet, so it cannot be derived from it;
this is the one interface contract a plan owes its executor.

Budgets come from the project's declared source-size cap. No declared cap → `n/a`, never an invented
number. On `modify` the budget is the file's TOTAL size after the change, not a delta. A `delete` row
carries `—` for budget and anchor.

**Total, not per-file.** The ledger ends with one line:
`total: <before> → <after> lines`. Five files under a 400 cap can each be legal while the change
doubles the codebase — the per-file budget cannot see that. Growth is allowed only with a stated
reason on that line; a refactor that claims to reduce anything and grows is refused here, at plan
time.

**A SWEEP is one row.** A wide mechanical change — one edit repeated across N files — is a single row
whose path is a glob, whose responsibility states the invariant every site must satisfy, and whose
count is asserted. Splitting a sweep into per-file rows or into several plans costs more prose than
the sweep, and breaks the intermediate states.

## Verification

Exact existing commands plus the acceptance check for the goal. The ledger is validated by ONE
command: `node <kit>/tools/plan-shape-cli.mjs --verify <plan>` — existence and budget for
create/modify, absence for delete, the count for a sweep, and the total line. Per-row assertions in
prose are the repetition this section exists to avoid.

**The acceptance criteria ARE the `- ` bullets.** Every top-level `- ` bullet in this section is one
acceptance criterion, and they are the whole list — nothing outside a bullet is one. That makes the
list machine-readable, so a review can be told mechanically whether a claimed invariant is already
required. A claim matches WITHIN ONE bullet: a literal spanning two is not in scope, because bullets
are reordered, split and deleted independently. A criterion that needs two bullets is two criteria —
write each one self-contained. A Verification written as prose with no bullets therefore declares NO
criteria, and every finding against that plan is a new invariant: the closed list fails closed.

## What gets cut

Delete any line for which both answers are yes: *can a zero-context executor still pick the right
files without it?* and *can verification still catch a wrong result without it?* Specifically, cut:

- prose that restates code reachable from a named anchor — keep the anchor, drop the retelling
- anything already binding from `AGENTS.md`, package scripts or repo convention
- rejected alternatives, discussion history, past incidents that do not change the file map
- edge cases, failure paths, rollback narratives that change neither a boundary nor a check
- implementation walkthroughs and pseudocode — except a `create` row's exported surface, above
- any requirement stated twice, and any dependency or install that is not its own ledger row

**A decision settled during review is not a section.** It becomes a boundary or non-goal in Goal, or a
check in Verification. A settlement expressible as neither is code-level detail for Execute.

**The spec review, reading the plan's ledger in its rounds, asks what to cut, not what is missing.** A line may be ADDED only by naming the specific
wrong execution it prevents AND deleting at least as many lower-value lines. A review comment asking
for "more completeness" is refused by this rule.

## Un-run syntax never ships in prose

A plan carries exact commands its own Verification RUNS against a stated expected outcome, plus
literal fixtures a named test validates. Control flow, regexes, grammars, algorithm bodies — anything
that transforms data or evaluates a condition — never live in plan prose: prose has no checker. A
finding that wants one is the trigger to write a red→green test at Execute instead.

## Cleanup, and the plan's own life

Plan files are **ephemeral, gitignored, never committed**. If something in a plan is load-bearing,
inline it into a durable doc — `decisions.md`, `changelog.md` — and delete the plan. `git add` of a
plan file, and plan paths inside committed docs, are forbidden.

**Every plan ends with `## Phase: Cleanup`.** Cleanup runs `node <kit>/tools/plan-shape-cli.mjs --verify <plan>`
FIRST, before anything is migrated or deleted, then migrates outputs to the durable docs, updates
`docs/plans/queue.md` for a series, deletes the plan file, and verifies that `grep -rn "<slug>" . --exclude-dir=.git`
is empty (review receipts under the git dir carry the plan path, so the plain grep never clears a reviewed plan)
and the docs cap-validator is green. An aborted plan still runs Cleanup — partial outputs land in
`known_issues.md`.

**Cleanup writes no tracked text after the review.** Where `docs/ai`, the queue or the debt queue is
tracked, the plan's durable outputs (the decision record, the changelog entry, the epic row's state, the
queue's update, the debt rows the story closes or its spec review opened) are written and staged before
the diff review, and a debt row the diff review opens is staged with that round's folds; Cleanup then
verifies the plan, deletes it and its scratch, and checks the grep and the docs caps. Where they are
excluded from git, Cleanup writes them as above.

## The epic

An epic is the tier above the plan: a CAPPED concept file at `docs/ai/epics/<ID>.md` — intent, value,
non-goals, acceptance, specs, a stories ledger and its queue row — whose id is its file stem and whose
mechanism content is a refusal: a code fence, a backtick span or a file-line citation anywhere in its
body is below the tier's altitude, and a plan path other than the queue is a dead reference the day the
story lands. The ledger is where an epic says who touches what: one row per story with its depends-on,
owns and shared claims and its state, judged as ONE claim relation so two carriers are never put in one
file without an order between them. The rung is a tool, never a remembered rule —
`node <kit>/tools/epic-shape-cli.mjs --check docs/ai/epics/<ID>.md`, declared as a project gate over the
repo's own epic — and an epic is reviewed by the lens alone, whatever `epic.review` resolves to: one
review-lens read per round, at most two rounds, of the brief the kit renders,
`node <kit>/tools/epic-shape-cli.mjs --review-brief docs/ai/epics/<ID>.md`, whose guard holds the round
at concept altitude, so no bridge run is spent on an epic. The findings that come back are folded
through the fold ask by the same predicate (`--fold`), a fold of the second round is re-read by the lens
or taken to the maintainer with the go, and `--close` lands the epic only when every story has landed,
the result line is a date and the queue row is gone.

## The task

A task is one ledger row handed, in the tests or the code session, to the carrier `task.execute`
resolves to (a bridge executor, the executor vehicle, or the orchestrator itself). Nothing is drafted or
recorded around it: the orchestrator's prompt is the brief, the index is the tree its run starts from, and
the row's tests are its one check. The orchestrator writes one prompt file from one ledger row, whatever
`task.author` resolves to, as scratch under the plans directory (`EXECUTE-PROMPT-<plan stem>-<row id>.md`,
deleted with the plan at Cleanup): the row line verbatim; its Files, the paths the carrier may write, none
ignored or excluded by git; its Reads, the governing scenario lines verbatim and every other file it must
read; the commands the carrier runs and those it must not; and, for a row tagged `robust:`, the generated
robustness-literals block. A bridge prompt also carries one `aw-dispatch-contract` block holding a fresh
nonce for every bridge invocation, a retry and a fold included (`codex-exec --nonce <n> <prompt file>`),
and the run leaves its exec receipt; the executor vehicle gets the same file.

A hand-out starts with the story's changes staged: the orchestrator stages its own changes in the story's
scope and keeps the listing `git status --porcelain --untracked-files=all` prints; a path that listing
shows unstaged or untracked is not the story's, is never staged, sits in no row's Files, and the read
leaves it as it is. The orchestrator also copies, into its scratch directory, every git-excluded path a
run could write that the flow keeps there (in a hidden deployment `docs/ai`, the governing contracts
included): the excluded paths' pre-run tree. From the hand-out until its read no other session or person
writes a path git lists or the copy holds, and the orchestrator writes only the Files of a row it carries
itself and its records outside the copied paths — the orchestrator's precondition, stated so the choice
is owned. The rows of one hand-out have pairwise disjoint Files and no row's Reads
names another out row's Files; hand-outs never overlap, so a row that reads what an out row writes, and a
retry, go out in the next one.

When every run has stopped, each path the listing shows outside the union of the out rows' Files, other
than one it showed unstaged or untracked before the hand-out, is restored from the index (deleted when the
index lacks it), each copied path is restored wholesale from its pre-run copy, entries the copy lacks
deleted, and only then does the orchestrator run each row's tests on that tree: in the tests
session each new or rewritten test fails for the reason its scenario states, or on the absence of a name
the plan adds; in the code session they pass. A run whose tests answer otherwise, or that was interrupted
or returned no edit, is not accepted: its Files are
restored the same way and the accepted runs' tests run again; an accepted run's Files are staged. A run
not accepted is retried by a new prompt with a fresh nonce, a resume of its session, or the
orchestrator's own edit, in the next hand-out. A run of the executor vehicle refused for its model's quota
is retried once on the fallback model of the resolved vehicle posture — the `fallback` of
`docs/ai/vehicles.json`, the bundled default only when that file is absent — and the session record names
the model that ran it; a second refusal stops the story. A fold of code a bridge wrote is a hand-out of one
row resumed on that run's session (`codex-exec --resume <session id> --nonce <n> <prompt file>`), the
session id read from the `sessionId` of the run's exec receipt.

## The queue

`docs/plans/queue.md` NAMES work; it never holds the analysis of it. A row is one plain sentence
saying what the work is and for whom, then its id, then a short body — measurements, `file:line`
citations and fix direction belong to an ADR or the record the row points at. A row that goes
terminal is DELETED in the same change that mints its closing artifact — and where the queue is
gitignored, the deleted text is first written to a purge archive beside the history docs, because
there git history is no tombstone. The archive rung is runnable: `node <kit>/tools/queue-purge-cli.mjs
snapshot docs/plans/queue.md --section '<bucket heading>' --archive <file>` before the purge, and the
same line with `--check` in place of `snapshot` after it. In a hidden deployment that archive is
machine-local like the rest of the substrate: its guarantee is the working copy, not git. Frozen work
with a stated resume condition is not terminal and stays, in its own bucket. Order inside a bucket IS
priority.
A prose promise to trim later has been measured failing: a checker over the file is the rung, and it
is runnable — `node <kit>/tools/queue-audit-cli.mjs --check docs/plans/queue.md --section '<bucket
heading>' --max-rows <n> --max-row-lines <n>`, declared as a project gate once the queue has migrated.
The opening sentence has a rung too: append `--require-names` and a row whose name is not a sentence
refuses. It is an OPT-IN a project adds once its rows are named — without the flag a nameless row is
only a note, so the gate line a project wrote before this rule keeps its verdict byte for byte.
A project with no queue is offered a seeded one by the kit's full-flow offer: the seed states the row
shape and holds no row, so its gate line can carry `--require-names` from the first row.

## The plan must read cold

The executing session sees the plan file and the repository, never the authoring conversation.

Review runs on the spec with the plan's ledger, on the staged diff and on the epic by the lens: the spec
review reads the plan's Goal and boundary, ledger and Verification in the same rounds as the contracts,
the plan-shape gate and the maintainer's approval settle boundaries, budgets and the total, and the diff
review runs against real code where a gate fails immediately. An all-mechanics artifact — a sweep, CI wiring, prose-only edits —
takes a thin plan plus a diff review.
