# Planning Workflow

How plans are written, executed and torn down. Overrides the generic `writing-plans` skill — if both
trigger, this one wins.

A plan is an **index plus constraints**, never a transcript. The executor reads the repository; the
plan tells it which files to open, what each one may become, and how the result is checked.

## Shape

The whole file is capped at **100 lines and at most 25 ledger rows**. Before its first review and
after every authoring fold, run `node <kit>/tools/plan-shape-cli.mjs --check <plan>`. The headings are
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
- **Module ledger** (60 lines) — the single list of paths, and the plan's execution order.
- **Verification** (20 lines) — the acceptance check, plus one command that validates the whole ledger.
- **Phase: Cleanup** and **Next steps** (human-actionable only) share the 10 reserved lines.

## Module ledger

One row per path, six fields. A row is capped at **200 UTF-8 bytes counted without its path and
anchor**: id, verb, responsibility and budget after trimming, including their three ` | ` separators.

```
<check-id> | create|modify|delete | <path> | <responsibility, one sentence> | <max lines | n/a> | <anchor>
```

**The rows ARE the steps.** They execute top to bottom, each row is one logical commit, and a row may
only anchor on a path above it or on existing code. There is no separate step/phase numbering — the
only phases are session boundaries in a multi-session plan, and Cleanup.

**A contract change is a row, present at review.** A NEW feature's draft spec is a `create` row
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

**Review asks what to cut, not what is missing.** A line may be ADDED only by naming the specific
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

**Every plan ends with `## Phase: Cleanup`.** It migrates outputs to the durable docs, updates
`docs/plans/queue.md` for a series, deletes the plan file, and verifies `grep -rn "<slug>" .` is empty
and the docs cap-validator is green. An aborted plan still runs Cleanup — partial outputs land in
`known_issues.md`.

## The queue

`docs/plans/queue.md` NAMES work; it never holds the analysis of it. A row is one plain sentence
saying what the work is and for whom, then its id, then a short body — measurements, `file:line`
citations and fix direction belong to an ADR or the record the row points at. A row that goes
terminal is DELETED in the same change that mints its closing artifact — and where the queue is
gitignored, the deleted text is first written to a purge archive beside the history docs, because
there git history is no tombstone. In a hidden deployment that archive is machine-local like the rest
of the substrate: its guarantee is the working copy, not git. Frozen work with a stated resume
condition is not terminal and stays, in its own bucket. Order inside a bucket IS priority.
A prose promise to trim later has been measured failing: a checker over the file is the rung, and it
is runnable — `node <kit>/tools/queue-audit-cli.mjs --check docs/plans/queue.md --section '<bucket
heading>' --max-rows <n> --max-row-lines <n>`, declared as a project gate once the queue has migrated.

## The plan must read cold

The executing session sees the plan file and the repository, never the authoring conversation.

Heavy review belongs at the diff, not the plan: plan review settles boundaries, budgets and the
total; the per-row review runs against real code where a gate fails immediately. An all-mechanics
artifact — a sweep, CI wiring, prose-only edits — takes a thin plan plus a diff review rather than
another prose round.
