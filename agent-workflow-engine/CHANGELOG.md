# Changelog — @sabaiway/agent-workflow-engine

All notable changes to the methodology engine. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's `docs/ai/`
(which tracks the shared `agent-workflow` lineage, head `3.0.0`).

## 4.3.0 — the fifth recipe, the third activity, and a carrier that is never the one who commits (AD-124)

`references/orchestration.md` admits the CARRIER wherever it said backend: the orchestrator, a bridge
backend, or a full-tool frontier subagent dispatched from the placed executor vehicle; §2 lists
**Subagent** as the fifth recipe (a bounded, file-disjoint slice; degrades to Solo when the vehicle is
missing or unusable); §5 states the honest limit (a Claude Code lane — readiness is the vehicle FILE,
never the host; it spends no bridge quota but the host model's); §6 now reads "no recipe lets a
carrier commit or perform a git write … the orchestrator alone stages and commits".
`references/procedures.md`: `Slots: author, review` (the author carrier drafts from the orchestrator's
brief), the Subagent branch beside Delegated, and a new `## routine` activity (`Slots: carrier,
parallel`; a read-only slice rides a placed read-only vehicle, a write-capable one the executor; a
read-only chore has no commit boundary). Both injected pointer fragments name the fifth recipe and the
third activity; the prior texts are appended to the kit's known-prior stores, so a deployed slot
refreshes on the next reconcile.

## 4.2.0 — a zero governing-spec citation names the adoption state it relies on (AD-123)

`references/agent-rules-lens.md`'s **Spec-first** bullet, `references/planning.md`'s *Goal and boundary*
and `references/specs.md`'s *Governing specs are plural* said a plan may cite ZERO governing specs
"during adoption" — and nothing defined adoption, so "zero, every plan, forever" read exactly like
adopting. Each now says the same thing at its own point of use: a ZERO names the state it relies on —
`not adopted` (no store, or a recorded decline), `adopting` (a store with no live contract) or
`nothing spec-covered touched` (a store with live contracts) — and a bare zero is never a licence; the
store's own state is what the kit's `status` and upgrade advisor report.

The outgoing lens body is appended to `agent-rules-lens-priors.md` (append-only), so every deployed
`agent_rules.md` on the previous wording refreshes on the next upgrade instead of reading as a custom
edit; `test/lens-fragment.test.mjs` computes the outgoing body by swapping the Spec-first line back and
pins the tokens `adoption state` and `never a licence`.

## 4.1.0 — the queue is a named surface with a checker, not a prose promise

`references/planning.md` gains **`## The queue`**: `docs/plans/queue.md` NAMES work and never holds
the analysis of it — a row is one plain sentence saying what the work is and for whom, then its id,
then a short body, while measurements and `file:line` citations belong to an ADR or the record the
row points at. A row that goes terminal is DELETED in the same change that mints its closing
artifact, and where the queue is gitignored the deleted text is first written to a purge archive,
because there git history is no tombstone. Frozen work with a stated resume condition is not
terminal and stays, in its own bucket; order inside a bucket IS priority.

The canon names its own rung and the command that runs it, because a prose promise to trim later was
measured failing — 62 dead rows had accumulated by the time anybody counted.

`references/procedures.md` points at the new section by named anchor and stays the terse pointer it
is meant to be (its own test asserts it stays smaller than the canon it binds to).

## 4.0.0 — the scenario floor, and five answers the canon now states at its own points of use (AD-117)

Slice 4 wrote the layer's first real specs and came back with six questions the canon had left for
the next reader to rediscover. Five are answered here, IN `references/specs.md`, each at the point
where it is needed — and four of the five answers are a refusal to add a mechanism.

> ### ⚠ BREAKING — a spec written to the 3.3.0 canon can be invalid under this one
>
> `## Scenarios` gains a floor: at least one scenario line, with no empty-marker escape. A document
> the 3.3.0 canon and its reader both accepted now refuses as `scenarios-empty`. Same class as
> **3.0.0**, where deleting a vocabulary from the canon was already called MAJOR. The remedy is one
> line per scenario — `- S<N> <name> :: unbound` while no test pins it.

- **(1) No empty-marker escape on `## Scenarios`.** `*(empty)*` written there refuses as
  `scenario-line`; `unbound` already covers a scenario no test pins yet. An empty exclusion list is a
  claim, an empty scenario list is an absence. The refusal table gains the matching `scenarios-empty`
  row, in the reader's own order.
- **(2) A binding marker is an ORDINARY source line.** It counts toward the source-size practice like
  any other line, and a pinning file already at its cap raises its recorded ratchet to host one. No
  carve-out: the size judge counts bytes and must not learn spec vocabulary.
- **(3) There is NO sidecar binding form.** Retroactive coverage of a PUBLISHED package rides a
  release train, because the marker moves that package's subtree — a cost the family already pays
  deliberately, against a second place a binding could live.
- **(4) No `root` op verb.** The store root is the navigator, never an op target; it is judged as the
  listing parent of its declared child. The canon says so where containment is defined.
- **(5) The promoting event of a RETROACTIVE draft is PLAN APPROVAL.** `live` lands in the SAME slice
  that authors the draft, once every scenario is bound — otherwise a slice whose whole deliverable IS
  the specs has no later landing row, and the store's first contracts stay permanently provisional by
  the canon's own wording.
- `test/specs-canon.test.mjs` pins all five as prose assertions at their point of use, absorbs the
  new rule in the rules-table deep-equal, and gains two refuse fixtures — the empty section and the
  empty marker — each yielding exactly its one rule. The arm was red-proofed against the unchanged
  canon.


## 3.3.0 — the feature-spec canon: `references/specs.md`, the `Spec-first` lens bullet, specs as plan rows (AD-112)

- **`references/specs.md`** (NEW) — the canon of the feature-spec layer in the family's own
  vocabulary: where specs live and how the navigator counts them; the FROZEN schema (kinds,
  statuses and their forward-only transitions, the caps and the numeric fan-out / promotion
  thresholds, the slug pattern, the scenario-binding grammar, the module-root grammar, the
  Out-of-scope rule, the advisory unbound warning); the shape per kind; the 33-row refusal table
  the deployed reader enforces; lifecycle, per-scenario binding and atomic plan approval; the
  complete feature-vs-page precedence table; spec-driven feature-sliced architecture with ONE
  dependency rule and an honestly stated review-level enforcement altitude; spec vs ADR; the
  retroactive onboarding path; the scale budget. `test/specs-canon.test.mjs` pins this file against
  the reader's `SPEC_SCHEMA` — no second source of the numbers — reads the repo-only fixture corpus
  (81 files: every accept case clean, every refuse case exactly its one rule) and reads the two
  rendered templates clean.
- **`references/agent-rules-lens.md`** gains ONE bullet, `Spec-first`: a plan names its governing
  spec(s) — zero, one or many, one per touched slice — each one's Out of scope bounds that slice
  (no global union; a conflict is a spec revision BEFORE approval); a new feature's draft spec
  exists AT plan review, a contract change rides the plan as a proposed revision, and the revision
  lands with the code; page-only coverage governs as an adoption shim. The outgoing body is appended
  to the append-only prior store, so every unmodified deployment converges on the next kit touch.
- **`references/planning.md`** — Goal and boundary names the governing spec(s); a contract change
  is a ledger row present at review (`create` = draft spec, `modify` = revision; the landing row
  moves `draft -> live`, a removal row `live -> retired`). **`references/procedures.md`** —
  plan-authoring step 2 names the governing spec(s) and writes the `create` / `modify` spec rows so
  they exist at review; plan-execution step 3 lands the approved draft or revision WITH the code.
- `provides` stays `["plan"]`; the payload pins (tarball, installer) name the new file.

## 3.2.0 — the state table comes BEFORE the guard: enumerate by proof, never by exclusion (AD-111)

The canon already said a repeat finding in one subarea routes to SUBTRACTION rather than a fourth
patch. That rule fires LATE — by the time it triggers, the review has paid for every miss. This
release adds the early, structural trigger, learned from three consecutive review rounds that each
found one more unenumerated input state in a single function, every miss failing OPEN.

- **`references/agent-rules-lens.md`** gains one clause: where a decision's input has several
  independent state dimensions, write the table FIRST, admit the write with ONE conjunction of proven
  facts, funnel every other cell into a single refusal, and make the table the table-driven test. An
  exclusion list (`if (bad1) return; if (bad2) return;`) fails open on the first state nobody
  enumerated — and "unreadable" is a state, distinct from "absent". The clause also states plainly
  what a reviewer can and cannot do here: it judges the patch in front of it and can name only the
  NEXT missing state, one round at a time, so the enumeration is the author's job.
- The OUTGOING body is appended verbatim to **`references/agent-rules-lens-priors.md`** per the
  [[AD-041]] append-only contract, so every unmodified deployment still normalize-matches and
  converges on first touch, while a customized region stays preserved.

Engine-only content, but it ships with kit 7.2.0 and memory 4.5.4 because both carry the rendered
`agent_rules.md` template.

## 3.1.0 — a finding NAMES the invariant its fix enforces, and the acceptance criteria become a machine-readable list (AD-110)

A review round produces findings, and the canon never said which of them the phase owes. The two
ways of getting that wrong are silent and opposite: work the plan already requires gets deferred into
a queue row nobody reads, and work that was never in scope gets folded in until the round count is
the only thing that converges. `plan-execution` step 5 now carries the **finding-scope rule**.

- **`procedures.md` — the rule, in the plan-execution review step.** Every finding NAMES the
  invariant its fix would enforce, BEFORE the edit, in every round, and where that invariant already
  lives decides the arm. Already an acceptance criterion → **fold here**. It would have to be ADDED →
  the **narrow fix** for the found site ships now (red first) and ONLY the generalization is queued,
  as a row carrying five fields: the invariant, the origin `file:line`, the narrow fix, its proof,
  and a residual exposure declared NOT live. No correct narrow fix → **blocking**: the phase does not
  close, and it is never queued.
- **Two round bars ride along, declared before each round.** A finding counts only if it changes a
  WRITE/REMOVE decision or is a false statement in shipped text; a repeat finding in one subarea
  routes to SUBTRACTION, not a fourth patch.
- **Plan-execution scope only.** Plan-authoring settles boundaries and has no shipped behaviour to
  call a live defect in, so it carries none of the three — pinned in both directions, so neither a
  silent deletion nor a scope-creeping copy survives with tests green.
- **`planning.md` — the acceptance criteria ARE the `- ` bullets under `## Verification`, and they
  are the whole list.** Nothing outside a bullet is one, and a claim matches WITHIN ONE bullet,
  because bullets are reordered, split and deleted independently. A criterion needing two bullets is
  two criteria. A Verification written as prose declares NO criteria and every finding against that
  plan is a new invariant — the closed list fails closed.
- **The agent-rules lens gains the rule as one bullet, and that bullet carries its SCOPE.** The lens
  intro applies every bullet to plan-AUTHORING as well, so an unqualified bullet would have
  contradicted the canon it is rendered from — it opens `Finding scope (plan-execution)` and says
  plan-review carries none of it. The outgoing body is appended to the append-only prior store, so
  every deployed `agent_rules.md` still carrying the previous canonical body converges on first
  touch.

Engine-only release: no migration, no structural change to a deployed `docs/ai/`, and the
deployment-lineage stamp does not move. One thing in a deployment DOES change, stamp-independently —
the `agent_rules.md` lens region itself, which the kit's `lens-region` reconcile refreshes on its
next touch for any deployment still carrying a known canonical body; a customized region is preserved
verbatim and flagged. The checker the rule names ships in **agent-workflow-kit 7.1.0**
(`fold-scope`).

## 3.0.0 — the plan canon becomes a capped index: a module ledger whose rows ARE the steps (AD-104)

A plan is an **index plus constraints**, never a transcript. The executor reads the repository; the
plan says which files to open, what each may become, and how the result is checked. The canon used
to say what a plan CONTAINS and never what it may COST — the last plan written to the old shape ran
690 lines, most of it free prose under `## Approach`, a section with a budget of nothing and no
check on its content.

> ### ⚠ BREAKING — a plan written to any 2.x canon is invalid, and a shipped tool now refuses it
>
> The skeleton is LITERAL and tooling extracts by exact match: the title line `# Plan: <title>`,
> then five `## ` headings — `Goal and boundary`, `Module ledger`, `Verification`, `Phase: Cleanup`,
> `Next steps`. `## Approach` and `## Decisions (locked)` are gone, and the
> Plan → Phase → Step → Substep vocabulary with them. Kit **6.0.0**'s `grounding --plan` requires the
> three canon sections and refuses a MISSING one by name — a plan that exited 0 under every 2.x
> canon now exits 1. That refusal IS the migration signal, and it is why this is a MAJOR: the same
> class as **2.0.0**, where deleting a vocabulary from the canon was already called BREAKING.
> A leftover `## Approach` is not itself the trigger: a section the canon does not name is simply
> never sliced. A settled decision is no longer a section either — it becomes a boundary or non-goal
> in *Goal and boundary*, or a check in *Verification*.
>
> **Migration.** Rewrite the plan to the skeleton above: the old `## Approach` prose becomes a
> `## Goal and boundary` (observable outcome, preserved behaviour, explicit non-goals) plus a
> `## Module ledger` (one row per path, ending in the `total: <before> → <after> lines` budget); its
> Steps become ledger rows. Nothing in a deployed project's `docs/ai/` moves — the deployment-lineage
> stamp is unchanged and no migration file is needed.

- **`planning.md` 152 → 114 lines.** The whole plan file is capped at **100 lines AND 8000 bytes** —
  both, because a line cap alone is paid off with longer lines. Reserves: Goal and boundary 10,
  Module ledger 60, Verification 20, Cleanup plus Next steps 10. A plan that does not fit is not
  under-described: either the TASK splits along independently verifiable boundaries, or it is a sweep.
- **The ledger rows ARE the steps**, so the Plan → Phase → Step → Substep numbering is DELETED. One
  row per path, at most 200 bytes, six fields: `<check-id> | create|modify|delete | <path> |
  <responsibility> | <max lines | n/a> | <anchor>`. Rows execute top to bottom, each is one logical
  commit, and a row may anchor only on a path above it or on existing code. The only surviving phases
  are session boundaries and Cleanup. A `create` row's responsibility names the **exported surface**
  — the one interface contract a plan owes its executor, because it is not in the checkout to derive.
- **A wide mechanical change is ONE row** — a glob path, the invariant every site must satisfy, an
  asserted count. Splitting a sweep into per-file rows costs more prose than the sweep and breaks
  the intermediate states.
- **The budget that decides is the TOTAL.** The ledger ends with `total: <before> → <after> lines`.
  Five files under a 400-line cap can each be legal while the change doubles the codebase. Growth
  takes a stated reason on that line; a refactor that claims to reduce anything and grows is refused
  at plan time.
- **Review asks what to cut, not what is missing.** *What gets cut* deletes any line for which both
  answers are yes — can a zero-context executor still pick the right files without it, and can
  verification still catch a wrong result without it. A line may be ADDED only by naming the specific
  wrong execution it prevents AND deleting at least as many lower-value lines.
- **`procedures.md` 137 → 87 lines, 10427 → 5768 bytes** — back under `planning.md` (5977), as its
  own long-standing assertion requires. Every restated planning rule became a pointer, and the
  pointers name planning sections **by heading**: `planning.md` has no numbered sections, so the old
  `§4/§6/§7/§8/§9` references pointed at moved or deleted text. `procedures-canon.test.mjs` now
  checks that every named anchor is a live `## ` heading and that no `planning.md §N` pointer
  survives.
- `orchestration.md`'s convergence-bar pointer, the agent-rules **lens fragment** (its two per-Step
  clauses are now per-row, the outgoing body appended verbatim to `agent-rules-lens-priors.md` per
  the AD-041 append-only contract), the methodology **slot** blurb, and the SKILL/README/`package.json`
  descriptions all drop the retired vocabulary.
- Unchanged and still binding: right altitude and fold-by-code (AD-027/AD-029), checked-vs-unchecked
  syntax — *Un-run syntax never ships in prose* (AD-036), heavy review at the diff, and the mandatory
  `## Phase: Cleanup`.

## 2.1.0 — the plan names the layout it is about to create (AD-091)

The authoring canon now asks for the layout while the plan is still text: every Step that creates a
file names that file and the single responsibility it carries — and where the project declares a
source-size cap, the planned layout fits it.

- **`procedures.md` plan-authoring, Draft (step 2)** — every Step that CREATES a file names that file
  and the single responsibility it carries, and **where the project declares a source-size cap**, the
  planned layout fits it. The conditional is canon, not decoration: a project that declares no
  practice must never be handed an invented limit.
- **`planning.md` §8 self-review checklist** — the matching line, so the draft is re-checked against
  it before the plan is finalized. The line carries the canon's own rationale for asking at plan
  time: "a gate that refuses an oversized file after it is written only pays for a rewrite".
- The rung lives in **plan-authoring only** — plan-execution grows no rival copy of it. Both canon
  pins are enforced by the existing canon suites, including the conditional form.

## 2.0.0 — strip-the-kit: the planning canon teaches the computed loop (AD-059)

> ### ⚠ BREAKING — the §9 "Computed instrument" canon is rewritten
>
> The review-ledger/fold-completeness vocabulary is gone from the methodology. The loop the canon
> now teaches: red-proof BEFORE a fix (`core-evidence red-proof`) · explicit per-backend degrade
> records · stage → reviews on the STAGED tree → `run-gates --final` (the ONE receipt) →
> `commit-guard --check` at the commit boundary — **no ledger records it**; the round
> tally/classification discipline stays dialogue-level.

- `planning.md` §9 rewritten to the D3 loop; `procedures.md` step 5 mirrors it; the
  `orchestration.md` writer-economy clause reworded (the ledger-triad example died with the
  machinery).
- The agent-rules LENS reworded in its canonical home; the OUTGOING pre-strip body is appended to
  `agent-rules-lens-priors.md` verbatim (the AD-041 vintage contract — priors are append-only
  history).

## 1.17.0 — Prompt-economy canon gains a writer-batch clause + two sandbox-lane sentences (REPORT-FACTS train D5/D6, AD-054)

A **feature** release (ships with kit 1.47.0 / memory 2.3.0 / bridges 2.7.0+2.6.0). The cost-lanes
canon (`references/orchestration.md` §5) and the agent-rules lens gain:
- **Writer economy** — a stage's repeated WRITER commands batch into ONE invocation (the review-ledger
  triad rides one batched write, other stage writers combine via one launcher per stage); never one
  writer call at a time. Rendered on all three prompt-economy surfaces (orchestration §5, the lens
  fragment, the kit cost-lanes advisor), the lens re-rendered into both templates, and the outgoing
  lens body appended to the append-only prior store.
- **Sandbox lanes** — two sentences under the sandbox-lanes block: (i) a **pre-dispatch host-diff**
  (before the first dispatch of each bridge, diff its manifest `networkHosts` against the live sandbox
  allow-list — a missing host is surfaced to the maintainer, never fired into a known prompt); (ii)
  **nested-sandbox honesty** (a backend CLI shipping its own OS sandbox cannot run nested inside a
  harness sandbox — route it outside on the OBSERVED failure, never a preemptive blanket).

## 1.16.0 — Prompt-economy canon: the cost lanes learn autonomy-preserving dispatch (REC-UX-REWORK D7, AD-053)

A **feature** release (ships with kit 1.46.0 / memory 2.2.0). The cost-lanes canon
(`references/orchestration.md` §5) gains the **prompt-economy clause**: (a) read-only fan-out
(research / sweeps / extraction) runs ONLY on restricted-tool vehicles — a full-tool subagent for
read-only work is a forbidden lane downgrade (an invisible prompt-flood plus blast radius, not just
tokens), and a subagent is never instructed to shell out for facts obtainable read-only; (b) the
orchestrator's own shell form is ONE plain pipeline per call (a `;`/`&&` chain or env-prefixed
invocation never matches a prefix allow rule); (c) a fan-out LAUNCHER that gates per call yields to
the agent-spawn lane — **capability-gated**: without restricted-tool vehicles (a host offering only
full-tool agents included), read-only research stays in the orchestrator's own context, never a
vehicle mandate a host cannot satisfy.
The quality/speed guard rides in canon (the clause narrows TOOLS for read-only work only —
judgment, code, synthesis stay at the frontier lane) with the honest limit stated (no deterministic
gate classifies a dispatch — enforcement is canon at the point of use + placed vehicles + the retro
loop). The `agent-rules-lens.md` cost-lanes line carries the same clause (the outgoing body is
appended to the append-only prior store, so unmodified in-the-wild deployments converge on first
touch); one distinctive token per invariant is drift-guarded on all three surfaces (canon · the kit
advisor render · the lens).

## 1.15.0 — Canon autonomy prose + the sandbox cost-lane (AD-044 Plan 4)

A **feature** release (ships with kit 1.45.0 / memory 2.1.0). This publish delivers the Plan-3
`autonomy-slot.md` fragment to the install base — the third AGENTS.md `workflow:autonomy` slot
finally fills everywhere, so the kit's `ENGINE_FRAGMENT_CAVEATS` soft-skip residual retires on
refresh. Canon additions, appended without renumbering: orchestration.md trailing **§7
Checkpoint-bounded autonomy** (sandbox-as-floor, red-lines always-ask, informational for delegated
backends — enforcement stays the OS sandbox + the orchestrator); planning.md trailing **§10**
(autonomy at plan/execution checkpoints); procedures.md gains the read-at-start clause beside its
preamble. orchestration.md §5 gains the sandbox cost-lane token (sandbox-safe L0 surfaces ·
genuinely-unsandboxed bridge wrappers · command-shape-dependent npm-cache commands; move only the
failing command out of the sandbox, batch consecutive unsandboxed calls) — parity-pinned on both
the engine and kit sides.

## 1.14.1 — npm 12 tarball-guard compat + the lineage-head preamble correction

A **patch** release (no canon content change; co-released with memory 2.0.0 + kit 1.42.0 — the
one-file-per-ADR store, AD-051). Two housekeeping fixes: the monorepo tarball-guard test now
accepts both `npm pack --json` output shapes (an array on npm ≤11, an object keyed by package name
on npm ≥12 — environment compat, assertions unchanged), and this changelog's standing preamble
tracks the deployment-lineage head bumped by the co-released memory MAJOR (`1.3.0` → `2.0.0`; the
head lives in the family's shared stamps, not in this package's version).

## 1.14.0 — The review canon names its computed instrument, activity-aware (AD-046)

A **feature** release (canon content + guards; installer unchanged; deployment-lineage head stays
`1.3.0` — no migration). The kit's review-round ledger (AD-045 / AD-046) is now NAMED by the canon,
at the right activity scope:

- **`references/procedures.md`** — the plan-**execution** review step names the ledger (record ·
  `--status` · `--check` as the loop's gate; the exit contract stays in the tool's own header —
  point, don't restate); the review steps of BOTH activities gain the triage classification
  vocabulary (`fixable-bug / inherent-layer-residual / escalate`; a minor never forces triage);
  plan-**authoring** carries NO tool pointer — the ledger is plan-execution-scoped.
- **`references/planning.md` §9** — a new **"Computed instrument (plan-execution)"** paragraph: the
  stop decision is READ from the ledger, never remembered; stated neutrally that the same per-round
  tally + classification discipline governs plan-authoring review.
- **Drift-guards in BOTH directions** — `test/procedures-canon.test.mjs` pins the pointer INSIDE the
  plan-execution review step (a step extractor, not a whole-section match) and its ABSENCE from
  plan-authoring; `test/planning-canon.test.mjs` pins §9's ledger naming + the exact scope phrase.
  Lens files untouched (the 22 discipline tokens unchanged).

## 1.13.0 — The agent-rules lens gets its ONE canonical home here (slot-render, AD-041)

A **feature** release (canon content + its guard; installer unchanged; deployment-lineage head
stays `1.3.0` — no migration). The planning/review/process-fidelity lens block that used to be
hand-mirrored across the family's `agent_rules.md` templates now lives HERE, once:

- **`references/agent-rules-lens.md`** — the canonical lens block (number-neutral `### 2.x.`
  heading). Its intro now carries the provenance clause (rendered from the canon; refreshed on
  upgrade; a custom edit is preserved verbatim, but flagged). The family kit renders this into a
  deployed `docs/ai/agent_rules.md` region and refreshes it on bootstrap/upgrade.
- **`references/agent-rules-lens-priors.md`** — the **append-only store** of every lens body a
  previous release shipped (all 4 historical vintages harvested from the template git history,
  including the outgoing pre-1.13.0 body). The frozen delimiter format is documented in-file.
  A future canon wording change edits the fragment AND appends the outgoing body — both files
  in THIS package, so it ships as an **engine-only release** (the AD-041 measurement clause).
- **`test/lens-fragment.test.mjs`** — canon-presence guard: the 22 discipline tokens (the single
  token list going forward), heading shape, path-neutrality, priors shape + the computed
  pre-1.13.0 membership, injected non-vacuity; CRLF-tolerant reads.
- `SKILL.md` / `README.md` payload lists name the two new files (slot-fragment counts went
  count-free). Tarball 12 → 14 files, pinned by `package-content.test.mjs`.

## 1.12.0 — Plans carry a home for review-settled decisions (§7 optional `## Decisions (locked)`)

A **feature** release (canon text + its tests; installer unchanged; deployment-lineage head stays
`1.3.0` — no migration). Decisions a plan's review loop SETTLED (fixtures, contracts, boundary
clauses) now have a canonical, machine-extractable home:

- **`references/planning.md` §7** — the plan-document structure gains one optional row after
  `## Approach`: `## Decisions (locked) ← optional: settled, binding decisions the executor must
  not re-litigate`. The heading string is load-bearing: the kit's grounded-review facts assembler
  (`grounding.mjs`, AD-038) extracts the section by exact-heading match.
- **`references/planning.md` §8** — one checklist bullet: decisions the review loop settled live
  under the optional `## Decisions (locked)` heading — binding for the executor, never re-litigated
  at Execute.
- **`test/planning-canon.test.mjs`** — pins the exact §7 row (heading + optional + executor-binding
  wording, positioned after `## Approach`) and the §8 mention.

## 1.11.0 — Plans carry only checked syntax (the §9 checked-vs-unchecked boundary)

A **feature** release (canon text + its tests; installer unchanged). The §9 "No code-mechanics in
the plan" rule now names a hard discriminator for what syntax plan prose may carry:

- **`references/planning.md` §9 (B5)** — **checked syntax**: a Step's exact paths + commands stay
  REQUIRED (§7/§8) and count as checked because the plan's own Verification runs them against an
  explicit expected outcome or gate — merely running without asserting checks nothing; the only
  other syntax a plan may carry is a literal fixture/schema fragment a named test copies or
  validates. **Un-run, logic-bearing syntax** — control-flow, a regex, a glob, a grammar, an
  algorithm body, a mini-DSL, anything that transforms data or evaluates a condition — never lives
  in plan prose, however plausible or shell-verified it looks ("I ran it in my shell" is not a
  checker): a fold or draft that wants one writes the red→green test-as-spec at Execute instead.
- **`references/procedures.md` plan-authoring step 5** — the terse mirror of the same boundary at
  the point of use (the kit advisor prints this section verbatim).
- **Lockstep tests** — `planning-canon.test.mjs` (§9 it-block) and `procedures-canon.test.mjs`
  (Set-1) pin the two new tokens `checked syntax` + `logic-bearing`; non-vacuity proven by an
  injected red→green in both guards.

## 1.10.0 — Cost-lane vocabulary in the orchestration canon (§5)

A **feature** release (canon text + its tests; installer unchanged). Work now has named **cost
lanes**, and the canon states who runs what:

- **`orchestration.md` §5 defines the lanes** — **L0** deterministic script · **L1** cheap
  subagent (small model, low effort, read-only tools) · **L2** subscription bridge · **L3**
  frontier — plus the two routing rules: route every step to the **cheapest adequate executor**,
  and **a step with no named guardrail does not move down** a lane. The **red lines never move
  down**: council review models · real code · ADR/plan/handover/changelog-entry wording ·
  persuasive copy · go/no-go · the maintainer approval asks. Asymmetric pairing (cheap drafts,
  a deterministic tool or the frontier verifies) and the incident-repair default (salvage
  recorded state first, never frontier re-derivation) are canon now.
- **Lockstep tests** — `test/orchestration-canon.test.mjs` pins the four lane tokens, both
  routing rules, the red-line list, and that §5 stays generic (the L0 examples name the family's
  own surfaces — the gate runner over `docs/ai/gates.json`, the rotation checks — never a
  project's publish mechanics); `test/procedures-canon.test.mjs` pins the same canon tokens the
  composition root's advisor paraphrases, so the two cannot silently drift apart.

## 1.9.0 — Honest installer messaging: the verb states what was observed, the note states facts

A **feature** release (installer output contract only; the canon text is unchanged). `bin/install.mjs`
no longer claims "updated the canon to vX" on every run and no longer accuses the npx cache on a
same-version re-run:

- **The final verb is keyed on the OBSERVED version comparison**, never on mere presence: fresh or
  legacy/unstamped → `installed` (no transition claim when the prior version is unknowable); older →
  `updated the canon to vX`; same → `refreshed the already-current canon`; newer → `downgraded the
  canon to vX` (reachable only under the explicit `--allow-downgrade`).
- **The same-version note states observable facts only** — the copy still ran (a re-run repairs
  locally modified or deleted files) — plus a CONDITIONAL hint: *if you expected a newer version*,
  invoke the `@latest` tag explicitly. The "npx likely served a cached build" accusation is gone
  (not observable without a network check).
- The never-downgrade gate, its refusal wording, and the read-before-write ordering are untouched.

## 1.8.0 — Mechanize the §9 review-loop discipline (round cap · crossover · finding-origin)

A **feature** release. The methodology canon institutionalizes the review-loop economics so the round
cap, the crossover stop, and the finding-origin discipline stop being deletable prose:

- **`planning.md` §9** gains a *Fold minimally — a prose plan has no checker* bullet (a self-consistency
  read; fold minimally in ONE place), and the *Heavy review at the diff* bullet now names
  **backend divergence** as the crossover and routes an all-mechanics/CI or prose-only artifact to a
  **thin plan + diff-review**.
- **`orchestration.md` §4/§5** adds the **backend-divergence stop-signal**, reconciled with recipe
  fidelity: divergence bounds the *rounds*, never drops a ready backend within one.
- **`procedures.md`** requires a per-round emission **{round N · finding-origin tally · per-backend
  verdict}** at the loop point of *both* activities.

Guarded non-vacuously: `planning-`/`procedures-`/`orchestration-canon` gain region-scoped tokens; the
kit's `lens-mirror` registers the five review-loop tokens (Set-1) + the M6 `finding-origin` token (Set-2).
Deployment-lineage head stays `1.3.0` (no `docs/ai` migration).

## 1.7.0 — Harden the planning canon: process-fidelity + regression-free editing

A **feature** release. The methodology canon gains **seven invariants** that close recurring
process-fidelity slips and fold-induced churn — each pinned in its natural home and guarded by the engine
canon tests (+ the kit's extended cross-package `lens-mirror.test.mjs`):

- **`references/planning.md` §6 — *ExitPlanMode ≠ execute*.** A harness "approved — start coding" prompt
  authorizes the PLAN only; "continue in-session" is a DELIBERATE transition into `plan-execution` after
  the plan + cold-start prompt exist, never an implicit slide (disambiguates §6 vs the Definition of Done).
- **`references/planning.md` §9 — regression-free editing + the convergence bar.** *No code-mechanics in
  the plan*, *test-as-spec* (fold a code-touching finding into a red→green test, not prose),
  *characterize-first* (pin uncovered behavior before editing), *heavy review at the diff*, and a CLEAN
  loop defined as **0 blockers + 0 majors from every named backend** (folding ≠ convergence).
- **`references/orchestration.md` §4/§5 — *recipe fidelity*.** Council runs every ready backend **every
  round**; quietly dropping a ready backend is a forbidden silent downgrade (the converse of the
  unavailable-backend degrade), and the §5 quota guard is explicitly not a licence to drop one.
- **`references/procedures.md`** — terse pointers weave all of the above into both activity steps.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no migration); the npm
package version is a separate axis.

## 1.6.0 — Loosen the agy Issue-001 caveat (grounded review is sound)

A **feature** release. `references/orchestration.md` §5 reframes the `agy` health advisory: the grounded
`agy-review` contract removes agy's stale-model / partial-diff **false positives**, so `agy` is a **sound**
second opinion now — no longer something to merely avoid. The real **service-stall** caveat (Issue-001) is
kept — it is a separate risk that grounding does not remove — as is the codex-before-agy tie-break for
large / latency-sensitive substantive reviews and the `--add-dir` escalation path. The deployment-lineage
head stays **`1.3.0`** (no `docs/ai` structural change).

## 1.5.0 — Right-altitude & code-grounded folds in the canon

A **feature** release. The planning canon (`references/planning.md`, read **live** by the composition
root) gains a `## 9. Right-altitude & code-grounded folds` section + a §8 self-review bullet; the
activity-procedures canon (`references/procedures.md`) weaves a terse §9 review-lens pointer into the
rendered Self-review steps of **both** activities (binding to §9, not restating it). Two guards pin the
disciplines: a new `test/planning-canon.test.mjs` and an extended `test/procedures-canon.test.mjs`. The
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change); the npm package version is a
separate axis.

- **Right altitude.** A plan pins intent + architecture + invariants + acceptance criteria; fine
  code-mechanics are resolved at Execute, not spelled out in prose.
- **Fold by code, not prose.** Before folding a code-touching finding, read the cited `file:line` and cite it.
- **Convergence heuristic.** A stable architecture + recurring code-mechanism findings ⇒ raise the
  altitude or hand the mechanics to Execute.
- The procedures lens stays a terse pointer (the terseness invariant holds: `procedures.md` < `planning.md`).

## 1.4.0 — Durable session contracts in the canon: read-at-start, Definition of Done, communication

A **feature** release. The activity-procedures canon (`references/procedures.md`, read **live** by the
composition root) gains three durable-session contracts, and the two bounded slot fragments gain the
matching clauses so the composition root's canonical-refresh can push them to existing deployments:

- **Read-at-start.** The canon tells the agent to read the project's standing recipe preference in
  `docs/ai/orchestration.json` at the start of a planning/execution session (set it with the `set-recipe`
  writer) — no re-asking what is already configured.
- **plan-authoring Definition of Done.** A planning session must produce a self-contained plan **and** a
  cold-start execution prompt for the next session — both **without the user asking**.
- **Communication contract.** User-facing messages deliver the artifact **inline** (never a bare "see
  §X" as a substitute), lead with the result, with a large-artifact carve-out.
- **Slot fragments.** `orchestration-slot.md` gains the read-at-start clause (points at `set-recipe`);
  `methodology-slot.md` gains the communication clause. Both stay one bounded content line, under the
  deployed-`AGENTS.md` cap.

Generic as ever — no project release-publishing bake-in. The deployment-lineage head stays **`1.3.0`**
(stamp-independent reconciles reach the base; the engine **package** version is a separate axis).

## 1.3.0 — Activity procedures: named, recipe-aware playbooks

The engine now also owns the **activity-procedures** canon — *how to perform* a named workflow
activity, as ordered steps with **typed recipe slots** that bind to the orchestration recipes (Solo /
Reviewed / Council / Delegated). Two v1 activities: **`plan-authoring`** (slot: `review`) and
**`plan-execution`** (slots: `execute`, `review`). The canon composes with `planning.md` (it binds to
the §7 structure, §8 self-review, and §4 Cleanup without restating them) and stays **generic** — it
bakes in no single project's stages, deferring any project-declared release/publishing to that
project's `workflow:methodology` slot. The kit reads this canon **live** and surfaces a read-only
`/agent-workflow-kit procedures <activity>` that renders the steps + the resolved effective recipe per
slot (from `docs/ai/orchestration.json` + backend readiness).

### Added
- **`references/procedures.md`** — the canonical activity-procedures canon: `plan-authoring` +
  `plan-execution` as `## <activity>` sections, each opening with a machine-parseable `Slots:` line
  (the only line the kit parses, drift-guarded against its activity table). It carries the
  load-bearing "Delegated → dispatch execution first" rule and restates the commit contract as a
  commit-BOUNDARY rule (when an activity has a commit boundary the orchestrator owns that commit; a
  backend never commits — `plan-authoring` ends at approval with no commit, `plan-execution` commits
  per Step).

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file). The
npm package version is a separate axis.

## 1.2.0 — Orchestration recipes: a named vocabulary for composing the bridges

The engine now also owns the **orchestration-recipe** canon — the named patterns an agent uses to
compose the optional execution-backends (the `codex` / `agy` bridges) into `plan → execute → review`.
Four recipes, built over the bridges' role vocabulary: **Solo** (no backend — the floor), **Reviewed**
(one backend reviews), **Council** (both review, you synthesize), **Delegated** (a backend executes a
bounded sub-task). The orchestrator always owns the decisions and the single commit; a backend is
advisory or delegated, never autonomous. The kit reads this canon **live** and surfaces a read-only
`/agent-workflow-kit recipes` advisor that plans a recipe for the current environment.

### Added
- **`references/orchestration.md`** — the canonical narrative: the four recipes over the role
  vocabulary, the when/why decision guidance, the graceful-degradation lattice (Council → Reviewed →
  Solo; Delegated → Solo, always with a stated reason), and the quota/health guard.
- **`references/orchestration-slot.md`** — the bounded **one-line** fragment the composition root
  injects into a deployed `AGENTS.md` (between the `workflow:orchestration` markers). It names the four
  recipes and routes to `/agent-workflow-kit recipes` — never to this engine-internal reference.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file). The
npm package version is a separate axis.

## 1.1.0 — Live-read ready: never-downgrade gate + installer hardening

The kit now reads this canon **live from the installed engine** and has retired its bundled mirror
(see the kit's 1.11.0 / **AD-016**). This release hardens the engine's own installer to match — so an
engine placed by `npx … kit init` (or by hand) is safe to refresh.

### Added
- **Never-downgrade gate** (cloned from the kit, AD-012): a bare `npx … init` that npx serves from an
  **older cached build** can no longer overwrite a **newer** installed canon — `init` compares the
  on-disk version (no network) and refuses loudly unless you pass `--allow-downgrade`. A same-version
  re-run prints a cache hint and points at `@latest`. An existing but **unreadable** `SKILL.md` fails
  closed (the gate is never silently bypassed).

### Fixed
- Containment check now accepts a legitimately-contained child literally named `..foo` (it wrongly
  rejected anything starting with `..` before); `tildify` collapses only a **leading** `$HOME`, never
  a mid-path occurrence (**Issue-004**, fixed in lockstep with the memory installer).

### Changed
- The installer is importable without side effects (the `isDirectRun` guard) and exports its
  path/format helpers for in-process tests. The installer's own bare `npx … init` strings now use
  `@latest`.

## 1.0.0

First publish. The canonical home of the `agent-workflow` planning methodology is now an
installable, `available:true` npm package — no longer a declared, content-only stub.

### Added
- Standalone npm package + `bin/install.mjs` installer targeting
  `~/.claude/skills/agent-workflow-engine` (`AGENT_WORKFLOW_ENGINE_DIR`), with a
  symlink-traversal guard — the installer never writes *through* a destination symlink
  (root / intermediate / leaf), and never copies the npm wrapper into the skill dir.
- `capability.json` flipped to `available:true` with `detect.installed` +
  `install.npm` (`@sabaiway/agent-workflow-engine`). It still only `provides: ["plan"]`
  (the methodology text) with no callable command — it mutates nothing.

### Notes
- The canon itself — `references/planning.md` (the full methodology) and
  `references/methodology-slot.md` (the bounded slot fragment) — is unchanged; this release
  packages it for npm.
- The composition root (`agent-workflow-kit`) still consumes a **byte-identical,
  drift-guarded mirror** of this canon bundled inside the kit. The live `kit → engine` read
  and retiring that mirror land in the next slice.
- The deployment-lineage head stays **`1.3.0`** — packaging the engine changes only the npm
  axis, not any deployed project's `docs/ai` structure.
