# Changelog — @sabaiway/agent-workflow-memory

All notable changes to the memory substrate. Versions are this **package's** npm versions;
they are distinct from the **deployment-lineage** stamp written into a project's
`docs/ai/.memory-version` (which tracks the shared `agent-workflow` lineage, head `3.0.0`).

## 7.1.2 — the seed orchestration note names the fold slot (AD-125)

`references/templates/orchestration.json`: the `_README` note lists `plan-authoring`'s third slot,
`fold` (`solo | subagent`, computed default `solo`), beside `author` and `review`; the JSON shape is
unchanged. Documentation only — PATCH, the class 7.1.1 shipped.

## 7.1.1 — the seed orchestration note names every slot (AD-124)

`references/templates/orchestration.json`: the `_README` note now names the three activities, every
slot and its accepted values, the `subagent` carrier and the `parallel` switch; the JSON shape is
unchanged (two activities, `solo` everywhere), so a kit that predates the third activity still
accepts the seed. `SKILL.md` lists five orchestration recipes. Documentation only — PATCH.

## 7.1.0 — the rules template names the adoption state a zero relies on, and the upgrade skips only on no Node evidence (AD-123)

`references/templates/agent_rules.md`: §1.2 no longer says "zero is legal during adoption" — a zero
names the adoption state it relies on (not adopted, adopting, or nothing spec-covered touched); §2.5
Communication gains its last bullet — a tool-composed `skipped-*` line whose stated reason the observed
tree disproves is raised as a FINDING, never pasted as neutral, and a tool may not emit a skip it could
itself disprove; §2.6 is the re-rendered engine 4.2.0 lens (the Spec-first bullet with the state
clause). The kit's template twin moves byte-identically.

`SKILL.md` upgrade step 2: the ADR enforcement pair and the spec layer skip ONLY when no Node evidence
exists — no regular `package.json` at the root and none of the kit-seeded `scripts/*.mjs` present; a
probe that cannot be read is a stated failure, never a skip. A deployment the kit itself made is
therefore always recognized, whatever its stack.

## 7.0.0 — a symlinked docs file gets named instead of skipped (AD-119)

The docs cap-validator discovered files through `readdir(dir, { withFileTypes: true })` and kept an
entry only when `entry.isFile()`. For a symlink that predicate is FALSE — and so is `isDirectory()`
— so a symlinked `*.md` under `docs/ai` fell through BOTH arms of the walk and left it entirely.
Probed: a temp tree holding a 14-line `real.md` under `maxLines: 3`, a `linked.md` pointing at it and
an `escaped.md` pointing outside `docs/ai` reported `1 files inspected  —  1 error(s)`. No cap check,
no missing-frontmatter error, no staleness check, no navigator row — and not counted in the file
total either, which is what made it a lie rather than a gap.

> ### ⚠ BREAKING — a docs tree that was green can now go RED
>
> A symlink under `docs/ai` named `*.md`, or resolving to a directory, is now a NAMED error row and
> is never read.
>
> `--check-index` additionally runs the navigator's containment guard BEFORE it reads. On a chain
> the walk can TRAVERSE, that guard rejects a symlink at the project root, `docs`, `docs/ai` or
> `docs/ai/index.md` and exits 2 — where the mode used to compare and pass. It is the same guard
> `--write-index` and `--ensure-index` already applied. (A chain the walk cannot traverse at all —
> a dangling or unreadable `docs/ai` — still ends the run as it always did, before any guard; only
> `--ensure-index` promises one named line there. That is unchanged by this release.)
> Reading through a link matters because `buildIndex` drops the navigator's own row, so a symlinked
> `index.md` whose target held the current bytes compared EQUAL and reported it fresh (measured:
> exit 0 before, exit 2 after).
>
> **When it bites.** Only a deployment that actually has such a symlink — and only once these bytes
> reach its `scripts/`, which happens on a fresh bootstrap, a `migrate-adr-store` refresh, a
> prior-matched `specs` ensure, or a hand copy; installing this package does not overwrite an
> existing deployed `check-docs-size.mjs`. Such a project sees `docs-caps` turn red with no edit of
> its own. For a symlinked docs FILE, `docs-index` reds until the navigator is regenerated with that
> link's row. For a symlink on the navigator's own chain the regeneration is itself REFUSED, so
> `--write-index` cannot clear it — only replacing the link can.
>
> **Remedy.** Replace it with a real file or a real directory, whichever it stands for, or move it out
> of `docs/ai`. The gate names the path and which case it is.

**What is deliberately preserved.** A symlinked NON-`.md` regular file is still skipped, so the
pinned `orchestration.json` skip is unchanged; a tree with no symlink under `docs/ai` writes a
byte-identical navigator; and an over-cap REAL `adr/` record still collapses into the aggregate row,
because the collapse guard keys on the refusal and never on `errors.length`. Each is pinned by its
own arm.

**Only `ENOENT` and `ENOTDIR` mean "nothing is there".** The name decides first — a link named `*.md`
is refused with no `stat` at all — and only a differently named one is stat'ed, to learn whether it
stands where a directory would and would hide a whole subtree. Every other code (`EACCES`, `EIO`,
`ELOOP` from a symlink cycle) yields a named refusal carrying the code, because treating an
unclassifiable link as a skip is how the subtree behind it escapes all over again.

`walkMarkdownFiles` keeps its exact historical one-argument signature and contract: the `*.md` files
a run may READ. A refused symlink is not one of them — it is a row, not a file.

## 6.0.0 — a rolling archive stamps a cap it can honour, and refuses past a ceiling (AD-118)

The changelog archiver wrote each tier's frontmatter `maxLines` as a LITERAL in the builder that
emitted it: WARM 3500, COLD 1500, META 300. A literal is a promise about a corpus nobody has seen
yet, so the day a tier outgrew its number the archiver emitted a file the docs gate refuses — its
own output failing its own gate, and the repair was a hand edit that the next run stamped straight
back over.

> ### ⚠ BREAKING — the archiver now exits non-zero on input it used to accept
>
> New module `references/scripts/archive-caps.mjs` exports `capFor({tier, count})` over a frozen
> floor/ceiling table — COLD 1500/3000, WARM 3500/7000, META 1500/3000. Once a tier's line count
> goes PAST its ceiling the run REFUSES rather than stamp a cap it cannot honour, and it refuses
> identically in every mode: the default run, `--dry-run` and `--check` alike. META's floor also
> RISES 300 → 1500.
>
> **When it bites.** These bytes reach a project's `scripts/` only on a FRESH bootstrap, a
> `migrate-adr-store` refresh, or a hand copy — installing this package does NOT overwrite an
> existing deployed `archive-changelog.mjs`, and delivery to existing deployments is deliberately
> out of scope here (a filed row). Once the bytes do land, a project whose archive has already
> outgrown a ceiling sees its `changelog-rotation` gate turn red with no edit of its own, and an
> existing `condensed-index.md` is re-stamped on the next run.

- **The stamp is now a function of the file.** Below the floor a tier stamps the floor; inside the
  band it stamps its OWN final line count; the ceiling itself is still stamped. `count` is the count
  the docs gate computes (`check-docs-size.mjs` — a trailing newline ends a line, it never opens
  one), restated as `countLines` so the stamp and the judge cannot disagree. Each builder renders
  twice: once with a placeholder to learn its length, once with what `capFor` returns. The stamped
  integer is one line whatever its value, so the first render's count IS the final count and the
  stamp is a fixed point.
- **Every cap-bearing output is BUILT before the mode branch.** WARM/COLD/META used to be built only
  on the write path, so `--check` and `--dry-run` could never have seen a ceiling breach. A `--check`
  that went green on a corpus the next real run cannot write is the same fail-open the parse already
  refuses to be. Building is pure, so a refusal still leaves the tree byte-unchanged.
- **The ceiling is 2x the floor, FIXED here, never measured from a corpus.** The refusal rides a
  standing `--check` gate, so a ceiling derived from whatever happened to be on disk the day someone
  wrote the test would brick every commit as soon as the corpus grew past it. Raising one is a
  reviewed edit to the table, never something a run decides for itself.
- **A sharding tripwire warns at the FLOOR.** META grows O(total archived entries) and never sheds,
  so it reaches its ceiling first; warning while there is still room puts the remedy in front of
  whoever runs the archiver. Both the COLD and META remedies state their sharding as NOT
  IMPLEMENTED and say why — COLD discovery matches `YYYY-MM.md` only, so a hand-split file would
  drop out of the corpus, and META is always regenerated whole. A remedy must never instruct a
  layout the archiver cannot read back.
- Deliberately out of scope, each a filed row: the HOT changelog's own fallback stamp, the sibling
  `archive-issues` / `archive-decisions` stampers, and per-year META sharding.

## 5.0.0 — the scenario floor: a contract can no longer pin NOTHING (AD-117)

The reader enforced a minimum on `## Out of scope` and none on `## Scenarios`. A `kind: spec`
document could therefore carry an EMPTY scenario section and pass everything — the reader, both
`spec-check` lanes, the gate row. Measured cost, from writing the layer's first real specs: three
stub specs would have satisfied every mechanical check of that slice and delivered nothing.

> ### ⚠ BREAKING — the reader refuses a document it used to accept
>
> `SPEC_SCHEMA.rules` gains ONE frozen rule, **`scenarios-empty`**, in table position between
> `scenario-path` and `out-of-scope`: a `## Scenarios` section carrying no scenario line is now an
> error. The rule list is a frozen ordered contract, so a consumer that deep-equals it sees a 34th
> id, and a deployment's spec gate can turn red with no edit of its own. The remedy is one line per
> scenario — `- S<N> <name> :: unbound` while no test pins it.

- **`*(empty)*` is deliberately NOT an escape here.** Written under `## Scenarios` it still refuses,
  as `scenario-line`, and a fixture now pins that. The asymmetry with `## Out of scope` (where the
  marker IS the decision) is the point: an empty exclusion list is a claim, an empty scenario list is
  an absence, and the grammar already carries the honest form for the absence.
- **`unbound` accepts on every status** — `draft`, `live` and `retired` alike — so the floor costs a
  spec nothing but the statement that a scenario exists.
- Measured before shipping: no document in the fixture corpus, the live store or the shipped
  templates carries an empty section, so the floor refuses nothing that already exists.
- The other 33 rule ids, every existing refusal and the whole `structure` extraction stay
  behaviour-identical. The new arm was red-proofed against the pre-change reader.


## 4.7.0 — the reader's verdict gains the additive `structure` extraction (AD-114)

The slice-2 checker (`spec-check`, next release) must read a document's structure through the SAME
module that defines "malformed" — a second parser of the frozen grammar would fork that definition.
`readSpecDocument` therefore now returns, beside the untouched errors and warnings, an additive
`structure` field in a shape frozen at plan time:

- **`{scenarios: [{ordinal, binding: {file, marker} | null}], children: [{name, target}], parts:
  [{name, target}], module: {form: 'root' | 'fileSet', paths: [...]} | null}`** — every target
  VERBATIM as written (`./x.md` and `./x/index.md` stay distinct strings).
- **Null ONLY on the early refusals** (missing frontmatter, a frontmatter-key defect, an unknown
  kind); for a known kind with errors it is the DETERMINISTIC extraction of what parsed: a
  grammar-malformed scenario/child/part line is simply absent (valid lines before and after it
  extract), while a line that parses but breaks a rule still extracts verbatim beside its error.
- **The module is a conjunction** — ONE `dir/` root or an all-file list; prose, a refused path, a
  dir/file mix or `*(empty)*` extracts `module: null`. `## Links` stays free prose, never
  extracted.
- The 33 rule ids, every refusal and every existing verdict field stay behaviour-identical (the
  engine corpus suite is green untouched; engine stays 3.3.0). The deep-equal suite pins the shape
  per kind, both module forms, every early-refusal branch and the partial extractions; the new
  tests were red-proofed against the pre-change reader.

MINOR: a shipped script gains a capability. One prose alignment rides along: the upgrade's
refresh-lane sentence now names a file of EITHER deployed pair (reader or checker) on a shipped
body as refreshed by the composition root's upgrade — this substrate still carries no catalog and
never overwrites a deployed script itself.

## 4.6.1 — the standalone upgrade delivers the spec layer behind a checker it can prove (AD-113)

4.6.0 shipped the feature-spec layer for FRESH bootstraps; an EXISTING deployment at lineage head
`3.0.0` had no lane to it. The standalone (skill-only) upgrade now closes that gap in prose, with no
digest catalog and no change to the shipped payload:

- **SKILL.md upgrade step 2 gains the spec-layer twin.** The reader pair (`scripts/spec-schema.mjs`
  + its test) seeds create-only if missing. The store root `docs/ai/specs/index.md` seeds ONLY when
  BOTH deployed pairs — reader and checker — are regular files byte-equal to the bundled copies
  (checked via lstat; a dangling symlink anywhere means nothing is written), with the template's
  date placeholder rendered. Every other state — a custom or partial pair, reader or checker — is
  reported as is, with the composition root's upgrade named as the refresh lane and NO store root
  written.
- **`standalone-bootstrap.test.mjs` models the equal-head upgrade both ways:** both pairs
  bundle-equal -> store seeded and the installed pre-commit hook exits 0 over a seeded spec; a
  custom or partial pair -> reported, no store.

PATCH: prose + the E2E model only.

## 4.6.0 — the feature-spec layer: a store under `docs/ai/specs/`, one text-only reader, a counted navigator row (AD-112)

A deployed project gains a middle altitude of durable knowledge between the whole-project
`technical_specification.md` and the ephemeral plan: one contract per feature — what it accepts and
returns, which scenarios pin it, and, the part the family actually suffers from, what is OUT of its
scope. This is an adapted layer in the substrate's own vocabulary, not a methodology import: the
existing plan-approval checkpoint confirms a contract, the existing `maxLines` caps bound every file,
the existing `[[AD-NNN]]` convention links the why, and hidden mode covers the store with no new
machinery (`/docs/ai/` already subsumes it).

- **`references/scripts/spec-schema.mjs`** (+ its deploy-payload test) — the ONE reader that DEFINES
  a well-formed spec. Pure text in (`readSpecDocument(text, rel)`), a verdict out; it imports nothing
  and opens no file, so it seeds layout-free into any deployment. It carries the frozen schema
  (`SPEC_SCHEMA`: kinds `index|spec|part`, statuses `draft|live|retired`, fan-out 30, promotion at
  `maxLines: 150`, the kebab slug, the scenario-binding grammar, the module-root grammar) and names
  exactly ONE rule id per defect — 33 rules, each pinned by a repo-only fixture. It models no markdown
  code: a fence line refuses, a spec carries no code sample.
- **`references/scripts/check-docs-size.mjs`** — the ADR-only collapse became a GROUPS loop the spec
  store joins: every file the reader accepts folds into ONE `specs/` navigator row with live counts
  (specs / parts / indexes), so adding or removing a valid spec changes the generated index and
  `--check-index` sees it; a file the reader refuses keeps its own visible row and its schema
  refusal surfaces as `spec <rule>:` WARNINGS — advisory (the structural checker is a later slice);
  the substrate's own frontmatter and `maxLines` errors stay blocking, as for every `docs/ai` file.
  The 591-line ratchet held by trimming prose, not by raising a record.
- **`references/templates/specs/index.md`** — the seed store root (`kind: index`, the exact up-link
  line to `technical_specification.md`, an empty `## Children`); deployed by the bootstrap like the
  `adr/` seed. **`references/templates/SPEC_TEMPLATE.md`** — the `kind: spec` authoring reference
  with one bound and one unbound scenario; skill-home only, excluded by NAME like `adr-record.md` —
  in the SKILL prose AND in the bootstrap E2E copy loop, which also runs the real installed
  pre-commit hook over a seeded spec and asserts the one counted row.
- **`references/templates/agent_rules.md`** §1.2/§1.3 — name the governing spec(s) before a
  feature (zero, one or many; page-only coverage governs as an adoption shim), the revision lands
  with the code; the `### 2.6` lens region carries the engine's new `Spec-first` bullet.
  **`references/templates/AGENTS.md`** — the `technical_specification.md` Memory-Map row now points
  at the contracts under `docs/ai/specs/` (96 lines; the cap is 100).
- **Scale is a release gate.** 1000 valid specs in a 30-per-folder tree: both hook runs sum to a
  median of 843 ms against a 1500 ms budget (pre-slice 0.75 s for 1161 docs); over budget blocks the
  release.

**Reaches a FRESH bootstrap only.** An existing deployment keeps its old checker (which never imports
the reader) and has no `docs/ai/specs/` to collapse; delivery to existing deployments — the `specs`
ensure op, the layout-free reader seed, the prior-matching checker refresh, an upgrade E2E — is slice
1b of the same series.

## 4.5.4 — the deployed `agent_rules.md` carries the state-table clause (AD-111)

Template-only follow-up to engine 3.2.0: the rendered lens block in
`references/templates/agent_rules.md` gains the clause that asks for a state table before a guard,
admitted by a conjunction of proven facts rather than a list of exclusions. No substrate behaviour
changes.

**Which deployments actually see it, stated precisely:** a FRESH bootstrap (the template is copied)
and any project the KIT reconciles — the lens reconciler lives in the kit, not here. A standalone
`agent-workflow-memory` upgrade over an existing `agent_rules.md` preserves that file and does NOT
re-render its lens region, so this clause does not reach it by that path.

## 4.5.3 — the bundled `agent_rules.md` template carries the finding-scope lens bullet (AD-110)

The engine's agent-rules lens gained one bullet in **3.1.0** — the finding-scope rule, scoped to
plan-execution — and this package's bundled `agent_rules.md` template carries its render. Nothing
else in the substrate moves: no new template, no schema change, no migration.

**Why this is its own release rather than a free ride.** The lens canon lives in the engine and a
wording change is an engine-only release by contract, because a deployed region converges from the
engine read on the next kit touch. That is true of a DEPLOYED project and says nothing about this
PACKAGE: the publish workflow refuses to no-op a package whose subtree changed without a version
bump, and it is right to — the existing 4.5.2 tag still points at exactly the bytes on npm, and it is
the CHANGED subtree that no longer matches them, so a no-op would leave that change unversioned and
unpublished.

## 4.5.2 — the boundary sentence names the plan SHAPE, not the retired vocabulary (AD-104; ships with engine 3.0.0 / kit 6.0.0)

**Wording only — no contract, no script, no gate changes.** This substrate records only *where* the
workflow methodology lives, never the methodology itself, and the words it used to point with were
the ones engine **3.0.0** retired. Nothing here refuses anything it used to accept, and nothing new
is offered, so this stays a PATCH while its two siblings take a MAJOR each.

- **`SKILL.md`** — the "knows nobody else in the family" boundary paragraph and the ownership table
  say **plan shape** (goal and boundary, module ledger, verification) and **activity procedures**
  where they used to say "plan → execute → review vocabulary" and "Plan→Phase→Step". The slots, the
  owners and the composition-root contract are untouched.
- **`references/templates/agent_rules.md`** — the rendered lens fragment picks up the same
  re-render the kit template gets: the two per-Step clauses are per-row, and §5's plan-file summary
  says "shape, lifecycle" instead of "vocabulary, lifecycle". The session-continuity sentence went
  with the heuristic the canon dropped.

## 4.5.1 — the deployed scripts decide direct-run by real path, so a symlinked entry point stops silently doing nothing (AD-102; ships with kit 5.11.1)

**A script invoked through a symlink ran nothing and exited 0.** The guard that decides "was I run
directly, or imported?" compared `import.meta.url` against `process.argv[1]` — a comparison that is
false whenever the entry point reached the script through a symlink. The script then took the
imported-as-a-module path, did no work, and reported success. The fix has been sitting in-repo,
unpublished, since the delegation series' own measurement came back FAIL and the fix was correctly
held back from a release it should not have justified (AD-101). It ships here as the plain bug fix it
is.

- **The six standalone scripts this package deploys inline a fail-closed realpath guard.** A deployed
  script cannot reach the kit's shared direct-run leaf, so one lexical line becomes an 11-line IIFE
  that resolves both sides through `realpath` and refuses to guess when it cannot: `references/scripts/`
  `archive-changelog.mjs` · `archive-decisions.mjs` · `archive-issues.mjs` · `check-docs-size.mjs` ·
  `migrate-gates.mjs`, plus `scripts/stamp-takeover.mjs`.
- **No behaviour changes for a script invoked by its real path** — which is why this is a PATCH. What
  changes is that invoking one through a symlink now does what you asked instead of nothing.

Recorded size effect (reason: a standalone deployed script cannot reach the kit's shared direct-run
leaf, so it inlines the realpath guard — one lexical line becomes an 11-line fail-closed IIFE):

```text
  agent-workflow-memory/references/scripts/archive-changelog.mjs: lines 546 -> 557 (raise)
  agent-workflow-memory/references/scripts/archive-decisions.mjs: lines 1199 -> 1210 (raise)
  agent-workflow-memory/references/scripts/archive-issues.mjs: lines 415 -> 426 (raise)
  agent-workflow-memory/references/scripts/check-docs-size.mjs: lines 580 -> 591 (raise)
  agent-workflow-memory/references/scripts/migrate-gates.mjs: lines 722 -> 733 (raise)
  agent-workflow-memory: aggregate lines 10907 -> 10962 -> 10974 (raise)
```

## 4.5.0 — the closing state block gets a canon rule, and its slot labels are declared English (AD-098; ships with kit 5.10.0)

**Three slots that answer three different questions, or one restatement written three times.** The
deployed rules template already asked for a closing state block; what it never said was what belongs
in each slot — so *now* drifted into a report of finished work, and the block collapsed into a
summary the reader had already read.

- **`agent_rules.md` gains the rule, in §2.5.** *Now* is the state at this instant — what is running
  or what the work is stopped on, never a report of what was completed (that belongs in the message
  body, above the block). *From you* is the real unblocker, named; a turn that is ending always has
  one. *Next* is what follows.
- **The slot LABELS stay English; the values take the dialogue language.** An English label is what
  lets a state-block checker find the block and its slots at all; everything written into a slot is
  in the project's own language, and the checker's English phrase sets do not judge those values.
  This is the substrate half of the same decision the kit's guard ships.
- **One test point renamed to describe the check it actually runs** — the `--write-index` refusal is
  a pre-write symlink refusal on the index path, which is what the body has pinned since 4.4.0.

## 4.4.0 — the deploy finishes by writing the navigator its entry point declares (AD-096; ships with kit 5.9.0)

**The substrate deployed an `AGENTS.md` that calls `docs/ai/index.md` always-loaded, and no step
ever wrote it.** The navigator is generated — `check-docs-size.mjs` is its only writer — and neither
bootstrap nor upgrade ran the generator, so a fresh Node deployment started life with a pre-commit
hook failing its own index check, and a project without Node stayed silently broken. Fixed at the
source: the generator gains an idempotent finalizer, and every documented path now runs it.

- **`check-docs-size.mjs --ensure-index [--root=<dir>]`** — probe first, write only when the
  navigator is missing or stale, and close with exactly ONE outcome line: `ensure-index:
  regenerated` / `already-current` on stdout, or `write-refused` / `probe-failed` on stderr with
  exit 2. It reuses the existing generator and freshness check — there is no second index
  implementation, and no seed template that could drift from it.
- **The bootstrap and upgrade prose run it at the LAST `docs/ai` mutation of each path:** after the
  template fill (which covers a No-Node target — the generator runs from the skill home, so the
  step-8 script copy is not a precondition), stamp-independently BEFORE the equal-head short-circuit
  on upgrade, and again after the migrations before the re-stamp. Either refusal is a STOP.
- **The write is contained and atomic.** Every component of `<root>/docs/ai/index.md` is lstat'ed
  no-follow — a symlinked root, `docs`, `docs/ai` or leaf refuses by name — the body is published
  through an exclusive-create temp renamed into place with the chain re-checked immediately before
  the rename, and a failure ATTEMPTS the temp discard — never a name this run did not create, and a
  cleanup that itself fails names the temp it could not remove instead of swallowing it. The
  containment guard runs BEFORE the freshness read, so a symlink whose target happens to hold
  current bytes is refused rather than reported "already current".
- **"Could not read" never passes for "nothing there".** Under the finalizer, only a genuine
  `ENOENT` counts as an absence; any other read failure refuses instead of publishing an index
  missing whatever the run could not see. A malformed `package.json` stays the documented
  project-name fallback.
- **A closure guard** asserts every `docs/ai` reference in the entry-point template's Memory Map
  resolves to a shipped template, a generated artifact whose finalizer the prose documents, or an
  exact exception list — and the deploy fixture EXTRACTS the documented command from `SKILL.md` and
  runs it, so a step that loses its finalizer line fails as a broken deployment.

Known residual: a project that already carries `scripts/check-docs-size.mjs` keeps its un-hardened
copy (the scripts ensure is create-only by contract) — repair rides the next lineage migration.

## 4.3.0 — the migration emits a destination that refuses by name, accepts the producer marker, and preserves a vendored core check (AD-092 + AD-093 + AD-094; ships with kit 5.7.0)

The `migrate-gates.mjs` canon moves in lockstep with the kit it is byte-twinned to. Three changes,
all in the drift-guarded shared block or the branches around it:

- **The emitted coverage destination becomes `"${AW_GIT_DIR:?exported by run-gates}/…lcov.info"`.**
  Where the runner injects the variable, behaviour is byte-identical; where a human pastes the cmd
  into a bare shell, bash refuses loudly by name — the old form expanded to empty and wrote the
  lcov to the filesystem root. Recognition stays APPEND-ONLY: every previously emitted form is
  still recognised, so an old-form declaration migrates as `keep` with zero diff.
- **The migration recognises the `lcovProducer` marker.** An optional gate-level boolean; only the
  literal `true` is a producer claim, and producer-ness stays POSITIONAL — a marker on the coverage
  checker itself never self-pairs. Strict schema validation of the key lives in the kit
  (`gates-declaration.mjs`), which accepts it in lockstep with this release; the published 5.6.0
  kit rejects a marker-carrying `gates.json` at exit 5 by design (forward-only; the kit's
  Issue-016 note owns the cross-version statement).
- **A vendored copy of a core check is PRESERVED instead of stopping the upgrade.** The
  three-outcome claim classifier (`canonical` / `tool-elsewhere` / `not-the-tool`) routes a
  shape-matching copy at a non-canonical realpath into a `keep` row plus separately rendered
  verify metadata — exit 0, nothing auto-added, a zero-diff apply, with the preview stating the
  verification instead of
  claiming final-run-capability the runner would refuse. A genuine id-squatter still hard-stops.

This package stays standalone — it imports nothing from the kit; the shared block is held equal by
the text drift guard, never by an import.

## 4.2.0 — the gates migration stops handing you a coverage checker with nothing to read (AD-089)

`migrate-gates.mjs` added the canonical `coverage-check` gate to any legacy declaration that lacked
one — whether or not anything in that declaration would ever WRITE the lcov the checker reads. The
result passes: the gate reports `skipped-no-lcov` and exits 0, so a migrated project came out with a
green matrix that certified nothing. This release stops the migration creating that pair, and makes
it say so when it finds one already there.

- **The checker is added only over a declaration that produces the lcov.** With no producer it is
  WITHHELD, loudly, with the exact suite-gate line to declare first and an invitation to re-run the
  migration afterwards.
- **An already-declared checker over no producer is reported as INERT** — same dead pair, made by an
  earlier deployment rather than by this migration. Nothing is removed for you; the warning names
  the remedy, and the result is no longer called final-run-capable.
- **`finalCapable` now means what it says.** It was computed from the review-state check alone, so a
  withheld or inert checker still reported a final-run-capable result. The review-state warning is
  now keyed on its own condition instead of riding that flag.
- **The "no canonical `unit-tests` entry" note stops firing over a working producer.** It was keyed
  on the entry ID, but a producer is recognised under any id — the note was sending people to fix
  something that was already correct.
- **The producer vocabulary is exported** (`COVERAGE_PRODUCER_BODY`, `matchesCoverageProducer`) as a
  CLOSED set of the full command forms this family emits, never a substring probe. Its tail rule is
  a positive path-shaped grammar rather than an operator blocklist, because
  `node --test <flags> && rm -f <lcov>` runs the suite and then deletes the file. The scope is
  stated in the source: recognising a producer means "configured with the reporters", never "the
  lcov survives the command".

This package stays standalone — it imports nothing from the kit, and the kit imports nothing from
here. The kit carries its own byte-identical copy of the block above, held equal by a text drift
guard rather than by an import.

## 4.1.0 — the ADR rotation carries your inbound links with it (AD-087)

Rotating `decisions.md` used to be a link-breaking event: `archive-decisions.mjs` moved ADR
blocks out of the HOT window into per-record `adr/` files while every `decisions.md#ad-NNN…`
link elsewhere in your `docs/ai/` kept pointing at a heading that was no longer there — and
neither `--check` nor `--dry-run` would say a word about it. One deployed project measured 114
such inbound anchors (23 aimed at the first tier a rotation would move) and had raised its HOT
cap twice specifically so the rotation never runs. A safety valve nobody dares open is not
shipped; this release makes the crossing carry its links:

- **Rotate and `--migrate --apply` rewrite inbound links.** Every non-fenced
  `decisions.md#ad-NNN…` link under `docs/ai/` whose id is in the moved set is rewritten to the
  record file. The heading-slug fragment is preserved — each record holds the verbatim
  `## AD-NNN — title` block, so the same anchor resolves — and the leading relative prefix
  survives (`adr/` is a sibling of `decisions.md`). Migrate additionally rewrites links into
  the retired monolith archives it deletes, each target computed relative to its linking file.
- **A conservation invariant guards every rewrite.** The rewrite set is computed and verified
  before the run's first write: every moved-id link rewritten, every other byte identical,
  per-file and total matched-link counts equal before and after — any mismatch exits 1 with
  nothing written.
- **The write order is pinned crash-safe:** records → inbound rewrites → HOT rewrite / monolith
  removal. Every interrupted intermediate state re-runs to completion; previously a crash after
  the HOT write re-ran as «nothing to rotate» with the orphans permanent.
- **`--check` now proves reference integrity.** A `decisions.md#ad-NNN…` anchor whose id has
  left the HOT window (stale even when the id exists as an archived record) and an
  `adr/AD-NNN-….md` link naming no existing record file both fail exit 1, every violation
  listed with `file:line`. A tree with matches but no ADR substrate fails too; the early SKIP
  remains only for trees with zero matches.
- **`--dry-run` prints the rewrite set** (`file:line`, old target → new target) alongside the
  move set and writes nothing; plain `--migrate` prints the same summary, and
  `--migrate --apply --dry-run` refuses loudly instead of silently writing.
- **Fail-closed edges, each red-tested:** a rewrite-form link targeting a moved id inside the
  ADR corpus itself (HOT preamble or block, a record, a monolith tier) refuses pre-write with
  `file:line` — convert the link (e.g. to `[[AD-NNN]]`) and re-run; a HOT block ABOUT to move
  that itself links a retained id or carries a record-form link refuses pre-write (the verbatim
  move would silently break the link from inside the record); symlinked `.md` files and
  directories in the scan scope refuse loudly; an unparseable scanned file (unclosed fence)
  aborts either write path before any write; a stale two-pass snapshot refuses instead of
  rewriting from old bytes.

**Stated limitations:** the scan is line-scoped (a link hand-wrapped across a line break is not
matched — the same accepted residual as the preamble contract), inline code is not tracked (a
backtick-wrapped link counts as live), and YAML frontmatter is opaque metadata — a link inside
it is neither rewritten nor checked, and is preserved byte-exactly on every write. The boundary
is `docs/ai/` — links in README or agent entry points outside it are neither rewritten nor
checked.

**Upgrading:** the tool itself has nothing to reconfigure — the rewrite is additive, and on a
healthy tree whose links resolve the new assertions stay green. **Reaching your deployment:** a
fresh Node-project bootstrap through the memory 4.1.0 skill — or a clean-layout upgrade where
the pair is entirely absent — copies the fixed pair from this package (a No-Node project skips
the scripts; a legacy-monolith layout goes through the consented migration ask); a normal
upgrade of an already-deployed pair preserves it byte-for-byte (local edits are never
clobbered — drift repair belongs to a lineage migration), so an existing deployment is NOT
auto-refreshed by this release; a verified drift-safe refresh lane is queued family work. If
`--check` then reports a `dead ADR anchor` or `dead ADR record link`, those are real orphans it
found — each line names the file, line and dead target; fix or remove the link, or re-point it
at an existing `adr/` record (or the `[[AD-NNN]]` form); with the links live, rotation is safe
to run again, so a cap raised only to avoid it can come back down. Any other `--check` red
carries its own printed diagnosis.

## 4.0.0 — the archivers stop reporting green on files they did not understand (AD-084)

> ### ⚠ BREAKING — the rotation gates fail CLOSED now
>
> A `--check` that silently passed over unparseable content now **refuses with `file:line` and a
> remedy**. If your changelog carries a malformed date heading, an issue claims resolution without
> a recognisable date, or one section carries both an open `Status:` and a dated `Resolved:` line,
> the gate goes red — that red is the fix arriving, not a regression. Every refusal message names
> exactly what to change. Nothing is ever rewritten on a refused input.

For years the failure mode of these scripts was a **green lie**: a changelog gate that printed
`OK` over a file it parsed nothing from (one real deployment passed 36 consecutive sessions
unparsed), and an issues gate that reported `archivable: 0` while nine resolved sections aged in
place and the file crept to one line under its cap. This release ends the class, not the instance:

- **One shared block tokenizer** (`references/scripts/markdown-blocks.mjs`, NEW): frontmatter,
  fenced regions, heading tokens outside fences; CRLF-safe; an unclosed fence is a loud error.
  All three archivers read through it — a structural test refuses any future raw-line scan.
- **Fail-closed contract, all three archivers:** every unit-shaped heading either parses or
  refuses naming `file:line`; every verdict names the counts it acted on; a zero-unit outcome is
  a stated decision; every reading mode refuses identically and **writes nothing** on refusal.
- **ISO dates are first-class:** `## YYYY-MM-DD — title` entry headings parse everywhere the
  legacy dotted form does; each entry re-emits in its **source form, verbatim**. Write ISO; the
  dotted archives keep working untouched.
- **The issues marker contract:** a resolved issue is recognised by a line-leading
  `- **Resolved:** YYYY-MM-DD …` or `- **Status:** … FIXED (YYYY-MM-DD) …` field — the shapes
  real files use, list prefix optional, emphasis/emoji variants read, both separators, strict
  calendar validation (the old code accepted `2026.02.30` — JS Date silently rolls it into
  March). Strikethrough is cosmetic in BOTH directions: the dated marker decides alone, and an
  explicit open `Status:` keeps a reopened-but-still-struck issue open. A resolution claim
  **without** a recognisable date, a struck heading with an unrecognised status word, and
  contradictory open+resolved state all refuse loudly instead of being skipped forever. The
  exact pre-4.0.0 template example section stays inert, so a pristine legacy deployment never
  reds its own gate.
- **The issues section model conserves your file:** category headings (`## 🟢 Resolved`), the
  preamble and the canonical closing footer belong to the FILE and survive rotation; an issue
  section contains only its own issue; rewrites are verbatim, guarded by an element-wise
  partition tripwire and a line-accounting conservation test. (Previously the first real
  rotation would have carried the category heading and footer into the archive and deleted them
  from your file.) Stated residual: a **reworded or localized** closing note is not recognised
  as the footer and travels with the last archived issue into the archive — conserved and
  recoverable, never lost.
- **The templates stopped contradicting the parsers:** the changelog seed teaches ISO on both
  `{{DATE}}` consumers; the known-issues template teaches ONE resolved shape inside a fenced
  sample in the file preamble, so neither a fresh project nor a section inserted under a
  category can ever red or lose the teaching text.

**Upgrading:** run your three `--check` gates once. If they refuse, the message names the line
and the remedy (typically: add the missing resolution date, repair a malformed date heading, or
delete the stale half of an open+resolved contradiction). The new `markdown-blocks.mjs` rides
every deploy path — old-layout projects get it companion-seeded by the kit's
`migrate-adr-store --apply`.

## 3.2.0 — the ADR rotation can be asked whether a seed is safe, without seeding (AD-083)

`archive-decisions.mjs --write-navigator` now honours `--dry-run`. It runs exactly the checks the
real write runs — the heading parse, the half-migrated guard, and the store-integrity check — and
then stops before touching anything, reporting how many decisions it validated.

Why it exists: a guarded caller (the kit's ADR-store migration) had no way to find out whether
seeding the store would succeed except by seeding it. A tree with a malformed decisions file could
therefore be told «go ahead», and only discover the problem after files had been written. The same
code now answers that question first. Nothing about the normal `--write-navigator` behaviour changes.

## 3.1.0 — plain-language communication bar in §2.5 of the agent_rules template (AD-061)

The `agent_rules.md` template's **§2.5 Communication** section gains a plain-language bar: every
user-facing message is short, clear, and written in plain words of the dialogue language; when the
dialogue language is not English, transliterated English jargon is banned — an English term
survives only as the NAME of a thing (a flag / command / file / test), glossed in plain words when
helpful; plain English stays plain for English-dialogue users.

The bar is byte-identical to the kit's fallback copy of the same template (a hand-kept pair), so
both deploy paths carry it. Existing deployments are reconciled into the bar by the kit's upgrade
lane (not only new bootstraps); a standalone memory upgrade does not touch the §2.5 region. This is
a COMMUNICATION contract (§2.5 of the deployed template), not a §2.x process invariant — the
methodology engine is untouched.

## 3.0.1 — bundled reference scripts refreshed (no behavior change)

PATCH rider on the kit 3.1.0 release — the publish workflow's changed-but-unbumped tooth caught
that two bundled reference scripts had moved since 3.0.0 without a version bump. No CLI surface,
output, or exit-code change:

- `references/scripts/check-docs-size.mjs` — reworked to an in-process CLI shape (pure argv
  parser, injectable log, exported `runCli`) so suites drive it without a spawn; same flags, same
  behavior; a colocated CLI test pins it.
- `references/scripts/archive-decisions.mjs` — comment-only cleanup (reviewer-round identity
  references removed as part of the family-wide neutral-review-ID sweep).

## 3.0.0 — strip-the-kit: the substrate follows the hardened computed core (AD-059)

> ### ⚠ BREAKING — retired loop surfaces + Node >= 22
>
> The verification-profile template is gone; the gates.json seed and the loop docs describe the
> `run-gates --final` / commit-guard loop; pre-commit hooks from `install-git-hooks.mjs` may gain
> the consented `--commit-guard <path>` line. Node floor **>= 22**. Deployment-lineage head is
> **3.0.0** — init/upgrade re-stamps and applies `migrations/3.0.0-hardened-core-loop.md`.

Shipped in lockstep with kit 3.0.0 / engine 2.0.0 (the lineage owner carries the consumer
migration surfaces):

- **`migrate-gates.mjs` (+ its deploy-payload spec, NEW):** the consented D8 legacy gates.json
  migration — preview default, atomic apply; canonical legacy entries removed by their documented
  single-invocation forms; the canonical `unit-tests` cmd gains the full lcov reporter flag set;
  the canonical `coverage-check` gate lands LAST (realpath-anchored, move/collision semantics);
  retired git-dir ledger stores cleaned; CUSTOMIZED entries reported with paste-ready recoveries;
  symlinked-parent and control-byte STOPs, all fail-closed.
- **`install-git-hooks.mjs`:** the hooks path comes from `git rev-parse --git-path hooks` (a
  linked worktree installs at ITS OWN hooks dir); the optional `--commit-guard <path>` arm writes
  the resolved quoted guard line; an armed line survives flagless re-runs (strict single-line
  carry-forward; `--no-commit-guard` is the one consented disable; duplicates fail closed). New
  colocated specs incl. the in-place GIT_DIR-pinned execution suite.
- **`stamp-takeover.mjs`:** LINEAGE_HEAD 3.0.0; the takeover/migration selection mechanics are
  unchanged — new deployments stamp 3.0.0, older ones pick up the 3.0.0 migration.
- **Templates/docs:** the gates seed + agent-rules/§4 consent line follow the D13 loop (staging
  is reversible loop-work; COMMIT is the ask); SKILL sweeps for the three seeded configs.

## 2.3.0 — agent_rules template: a report-facts Communication bullet + the writer-batch lens re-render (REPORT-FACTS train, AD-054)

A **feature** release (ships with kit 1.47.0 / engine 1.17.0 / bridges 2.7.0+2.6.0; the deployment
lineage head stays `2.0.0` — no deployed-`docs/ai` structure change). The bundled `agent_rules.md`
template gains:
- **§2.5 Communication — a report-facts bullet.** Any claim about the current host or session state
  (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts)
  must trace to **live tool output** from **this session**; a memory/handover snapshot is **context,
  never report facts**, and an unbacked claim is **omitted or explicitly marked unverified**. The
  report-facts twin lands in the memory template only (the kit template carries no §2.5 Communication).
- **§2.6 lens re-render.** The planning/review lens gains the writer-economy clause, kept in parity
  with the engine lens fragment by the lens-mirror guard.

## 2.2.0 — agent_rules template re-render: the lens gains the prompt-economy clause (REC-UX-REWORK D7, AD-053)

A **feature** release (ships with kit 1.46.0 / engine 1.16.0; the deployment lineage head stays
`2.0.0` — no deployed-`docs/ai` structure change). The bundled
`references/templates/agent_rules.md` §2.6 lens block is re-rendered to the current engine canon:
its cost-lanes line now carries the **prompt-economy clause** (read-only fan-out on restricted-tool
vehicles only; one plain pipeline per call; capability-gated launcher guidance; judgment, code and
synthesis stay at the frontier lane; the stated honest limit). Template-only — seeding, upgrade and
every other substrate behavior are unchanged; the render is byte-parity-pinned against the engine
fragment by the kit's lens-mirror guard.

## 2.1.0 — Autonomy template seed (AD-044 Plan 4)

A **feature** release (ships with kit 1.45.0 / engine 1.15.0; the deployment lineage head stays
`2.0.0` — the seed is ensure-if-missing, stamp-independent). `references/templates/autonomy.json`
— the sparse, defaults-equivalent autonomy-policy seed (`_README` only): resolving it equals
resolving no file at all, TEST-PINNED, so the seed can never drift from the computed defaults
(commit/push/publish `ask`; network/credentials/fs-outside-repo `deny`; absent activities floor at
`prompt`); it is STRUCTURALLY a seed (meta keys only) — an explicit policy declaring the same
values reads as a real declaration on every kit surface. Lifecycle follows gates.json: bootstrap
seeds it, upgrade ensures-if-missing (byte-preserving), hand-editable; the kit mirrors it via the
template manifest. Tarball sentinel 43→44. Deliberately NOT a delegated-bootstrap required asset
(the AD-044 Plan-3 no-gate decision holds).

## 2.0.0 — One-file-per-ADR store: the 3-tier decisions cascade retired (AD-051)

A **MAJOR** release (BREAKING; co-released with the workflow kit 1.42.0). The deployment-lineage
head bumps `1.3.0` → `2.0.0` — the first structural `docs/ai` change (a new `docs/ai/adr/` tree;
the WARM/COLD decisions-archive monolith tiers retired). **Nothing auto-migrates:** an existing
deployment keeps working on its old layout, old rotator included, until it opts in (below).

**Breaking.**
- `references/scripts/archive-decisions.mjs` is REPURPOSED in place (same path, same pre-commit
  hook slot, same `decisions-rotation` gate id): instead of rotating HOT `decisions.md` → WARM
  `history/decisions-archive.md` → a single COLD monolith whose cap was raised release after
  release, the rotator now EXPLODES the oldest ADRs beyond the HOT cap into one immutable MADR
  record per ADR at `docs/ai/adr/AD-NNN-slug.md` (body verbatim; inline 6-field frontmatter +
  `status`/`date`/`supersedes`/`supersededBy` lifecycle keys; slug frozen at creation). A record
  is O(1) forever — no archive cap is ever raised again, and there is no COLD tier to exhaust.
- A default or `--check` run that finds a legacy `history/decisions-archive*.md` monolith fails
  LOUD ("run `--migrate` first") — the new rotator never half-explodes an un-migrated tree and
  never reports green over one.
- The ADR id grammar widens to `AD-\d{3,}` with NUMERIC ordering everywhere (AD-200 precedes
  AD-1000 — never lexical).

**Migration (opt-in, never automatic).**
- The one-time `--migrate` (dry-run by default; `--migrate --apply` to write) explodes the
  monolith tiers into `adr/` records under a fail-loud conservation check: the full ADR corpus —
  the union HOT ∪ monolith tiers ∪ any already-written `adr/` records (the crash-resumable core;
  a same-id BODY CONFLICT across sources is refused) — must repartition EXACTLY into retained-HOT
  ∪ written records, nothing lost, added, double-counted, or edited. Before any destructive write
  it stores a durable timestamped snapshot of `decisions.md` + both monoliths into the GIT DIR
  (a stated out-of-tree fallback on a non-git deployment; fails loud if neither is writable).
  `docs/ai` is commonly git-ignored, so git history alone can NOT recover a deleted monolith —
  the snapshot is the recovery path. The apply is idempotent and crash-resumable; removal never
  precedes conservation + the snapshot.
- On an upgrade crossing this major, `bin/install.mjs` prints a GENERIC one-time advisory: run
  your workflow toolkit's ADR-store migration command in each already-deployed project (it
  snapshots, refreshes the enforcement scripts, and migrates in one consent-gated step). This
  installer targets the global skill dir and never touches a project itself.

**New.**
- `docs/ai/adr/log.md` — the ON-DEMAND active-set navigator: currently-governing heads
  (supersession COMPUTED corpus-wide from the two-way `supersedes`/`supersededBy` chain — a new
  superseding ADR needs no predecessor-file edit) + a recent window; a superseded record drops out
  of the list but stays reachable by filename, grep, and the chain. `--write-navigator`
  regenerates it AND re-triggers the docs-index regen. No committed full O(n) ledger.
- `references/scripts/check-docs-size.mjs` — `docs/ai/adr/` collapses to ONE aggregate `index.md`
  row (`adr/ — N records (AD-001 … AD-NNN)`), while every record body stays individually
  cap-checked; `docs/ai/index.md` stays bounded at O(1) as records accumulate.
- Seeded templates: the new-scheme `decisions.md` HOT-window seed, the `adr-record.md` MADR
  authoring reference (a skill-side reference — never copied into a project's `docs/ai/`), and a
  seed `adr/log.md` byte-equal to the generator over the seeded HOT — a fresh bootstrap is
  `--check`-green on its first commit.

## 1.12.0 — Verification-profile template + the docs-index-on-rotation regen (BUGFREE-3, AD-049)

A **minor** release (deployment-lineage head stays `1.3.0` — no migration; co-released with the
workflow kit 1.40.0). The memory substrate gains the optional verification-profile config and closes
the docs-index-goes-stale-on-rotation cost (economics item (h)).

- **Verification-profile template** — a new seeded `references/templates/verification-profile.json`
  (`schema:1`; the kit reads it, kit 1.40.0) is created on bootstrap and ensured-if-missing on
  upgrade (the `gates.json` / `orchestration.json` twin); `SKILL.md`'s bootstrap/ensure prose now
  names it. An **absent profile reproduces today's V8 + node:test behaviour exactly** — it only ADDS
  an opt-in default a consumer edits for its own language/runner.
- **(h) a rotation regenerates `docs/ai/index.md`** — `references/scripts/archive-decisions.mjs`
  regenerates the docs index after a successful rotation write (moves OR a normalize-only rewrite) by
  reusing the now **root-parameterized** `check-docs-size.mjs --write-index --report` (the `--report`
  isolates the index-write outcome from the docs-cap-check, so a benign over-cap sibling never reads
  as a regeneration failure), with a loud instruct on absence/failure. An ADR rotation no longer
  leaves the index stale to trip the `--check-index` gate mid-release-matrix.
- **§2.2 minimal-comments** — the `agent_rules` template states comments as minimal / only-vital,
  a BASELINE a consumer project may tighten (e.g. comments forbidden entirely).

## 1.11.1 — One batched setup prompt (the F11 ask reword; AD-042)

A **patch** release (prose reword only; deployment-lineage head stays `1.3.0` — no migration).
The three bootstrap setup questions (visibility / conversational language / attribution) are now
asked as **ONE structured multi-question prompt where supported** (`AskUserQuestion`, up to 4
questions per call), each answer recorded individually, nothing written until ALL are answered —
first contact interrupts once, not three times (`SKILL.md` bootstrap preamble + steps 2–4). The
upgrade path batches its two migration asks the same way ONLY when both `AGENTS.md` blocks are
missing (a pre-1.1.0 deployment), collecting them in step 4 BEFORE the migrations apply and never
re-asking a collected answer (a migration's own "Ask the user" step stays the standalone
fallback). The `references/contracts.md` ask paragraph is reworded byte-identical with the kit's
copy — pinned cross-package by the kit's new `ask-contract` test.

## 1.11.0 — The template lens block becomes a render of the engine canon (AD-041)

A **feature** release (template text only; deployment-lineage head stays `1.3.0` — no migration).
`references/templates/agent_rules.md` §2.6 (the planning/review/process-fidelity lens block) is
now a **render of the engine's canonical `agent-rules-lens` fragment**: the intro gains the
provenance clause (rendered from the canon; refreshed on upgrade; a custom edit is preserved
verbatim, but flagged). Standalone-first is unchanged — the template still seeds the complete
block with no kit/engine present; an unmodified older seed converges to the current canon at the
next kit bootstrap/upgrade touch (the kit's new `lens-region` reconcile matches it against the
engine's known-prior store). Future lens wording changes no longer require a memory release.

## 1.10.0 — Installer verb parity (the AD-034 cmp-keyed contract) + the recipe discovery step in the templates

A **feature** release (installer messaging + template text; deployment-lineage head stays `1.3.0`
— content-only, no migration):

- **`bin/install.mjs`** — the install verb is now keyed on the OBSERVED version relation, never on
  mere presence (closing the false `updated the substrate to vX` on an already-current machine):
  fresh/legacy-unstamped → `installed`; older → `updated the substrate to`; same →
  `refreshed the already-current substrate` + the fact-only repair-on-rerun note (never a cache
  accusation; conditional `@latest` hint); newer → a loud **never-downgrade refusal** (nothing
  written) unless `--allow-downgrade`, which then says `downgraded the substrate to` plainly. The
  installed version is read from the target SKILL.md `metadata:`-scoped `version` (decoy-proof);
  an existing-but-unreadable SKILL.md **fails closed**, never silently treated as legacy. Helpers
  cloned INLINE (this package references no sibling — the knows-nobody DAG).
- **`bin/install.test.mjs`** — the full engine-shape contract suite: no-op re-run wording,
  downgrade refusal + `--allow-downgrade`, fail-closed unreadable SKILL.md, legacy no-stamp,
  metadata-decoy version read.
- **`references/templates/agent_rules.md` §1.1** — new step 2: read `docs/ai/orchestration.json`
  (the CONFIGURED orchestration recipes) BEFORE picking a task; a silent recipe downgrade is a
  forbidden substitution. **`references/templates/handover.md`** — a standing `**Active recipes:**`
  slot line. Both regions byte-identical with the kit template copies, path-neutral (this substrate
  names no sibling skill), guarded by the kit's `template-region-parity.test.mjs` (AD-038).

## 1.9.0 — The agent_rules lens carries the checked-vs-unchecked plan boundary

A **feature** release (template text only; scripts and installer unchanged; deployment-lineage
head stays `1.3.0` — content-only, no migration). The §2.6 lens B5 bullet mirrors the engine's §9
sharpening:

- **`references/templates/agent_rules.md` (B5)** — a plan carries only **checked syntax** (a
  Step's commands, run by its own Verification against an explicit expected outcome or gate) plus
  literal fixture/schema fragments a named test copies or validates; **un-run, logic-bearing
  syntax** (control-flow, a regex, a glob, a grammar, an algorithm body, a mini-DSL) never lives
  in plan prose — a fold or draft that wants one is the trigger to write the test instead. The
  line stays byte-identical to the kit template (lens-mirror guarded).

## 1.8.0 — ADR-cascade rotation script + the seeded per-project gate declaration

A **feature** release (deployment-lineage head stays `1.3.0`; the new surfaces reach existing
deployments via stamp-independent ensures, no migration file). The last hand-rolled docs
rotation — the `decisions.md` ADR cascade — is now a script, and every project gains a
hand-editable gate declaration:

- **`references/scripts/archive-decisions.mjs` (+ test)** — the `archive-changelog.mjs` sibling:
  a chained three-tier cascade (HOT `decisions.md` → WARM `history/decisions-archive.md` → COLD
  `history/decisions-archive-early.md`), caps read from each file's own frontmatter `maxLines`.
  Whole entries move, oldest first; the id multiset and every entry's line count are
  conservation-checked before any write. **Fail-LOUD**: a non-canonical `## AD-0NN — <title>`
  heading, disordered ids, a cross-tier duplicate, or a roll that would not fit COLD's remaining
  headroom all refuse **before any write** (a cap raise is a maintainer decision — the script
  only moves entries). `--check` reports per-tier `lines/cap`; on a project **without**
  `decisions.md` it exits 0 with a **stated skip** — a deliberate divergence from
  `archive-changelog.mjs` (the deployed pre-commit hook must never block a commit over an absent
  ADR substrate).
- **The pre-commit hook runs it** — `install-git-hooks.mjs` adds `archive-decisions.mjs --check`
  to the installed gate line-up.
- **`references/templates/gates.json`** — the seeded, user-editable per-project **gate
  declaration** (`{ id, title, cmd }`, strict JSON, an empty list as shipped; `cmd` is ONE bash
  command line). Bootstrap seeds it; upgrade **ensures-if-missing and preserves an existing file
  byte-for-byte**. It declares WHAT to check — the runner lives in the composition root, never
  here.
- **Stamp-independent ensures (equal-head deployments self-heal)** — the upgrade procedure now
  ensures BOTH seeded `.json` configs **and** the `archive-decisions` script pair
  (copy-if-missing into `scripts/`, never overwriting an existing file); an old hook without the
  decisions line stays consistent-safe until the next hook refresh.
- **Tests** — 22 cascade tests (fixtures for the chained roll, the COLD-exhaustion refusal, the
  absent-file `--check` skip, determinism, range-token maintenance); bootstrap/ensure coverage
  extended in `standalone-bootstrap.test.mjs`; tarball content re-pinned (40 files, reverse pins
  for every new asset).

## 1.7.0 — Humanize the deploy/version report (memory)

A **feature** release (report-prose only — the atomic stamp-WRITE mechanics and the *Stamp = lineage
head, not package version* gotcha are unchanged; deployment-lineage head stays `1.3.0`, no migration).

The substrate's upgrade report no longer surfaces the internal `docs/ai` **structure version**
(`.memory-version`) on the happy path:

- A zero-diff equal-head upgrade says **settings already current — no update needed**; a writeful
  reconcile (a footprint move / config seed) instead reports **what changed** and asks before commit.
  A fresh bootstrap keeps its deploy-success framing. Neither shows the structure number.
- The number surfaces only at the never-downgrade **STOP** gate and on an **explicit user ask** (a
  read-only answer that writes nothing) — named "the `docs/ai` structure version", never "lineage
  head", with a plain two-axes note (*Version disclosure*). Memory adds **no status mode** (the one
  intended kit↔memory asymmetry).
- Pinned by a new static contract test (`scripts/skill-report-contract.test.mjs`).

## 1.6.0 — §2.6 carries the review-loop economics disciplines (memory)

A **feature** release. The `agent_rules.md` substrate **§2.6** lens gains the review-loop economics
disciplines — *Fold minimally* (a self-consistency read), the extended *Heavy review at the diff*
(**backend divergence** = the crossover; **thin plan + diff-review**), and a *Per-round emission*
**{round N · finding-origin · per-backend verdict}** — kept **byte-identical** to the kit's §2.5 block and
guarded by the kit's cross-package `lens-mirror` two-set drift test. Substrate/docs only; deployment-lineage
head stays `1.3.0` (no migration).

## 1.5.0 — §2.6 carries the planning/review/process-fidelity invariants (memory)

A **feature** release. The `agent_rules.md` substrate **§2.6** is generalized from *Right-altitude &
code-grounded* to **Planning, review & process-fidelity invariants** — the always-loaded,
read-before-any-code-change lens now carries all **seven** methodology invariants: fold by code, right
altitude, no code-mechanics, test-as-spec, characterize-first, heavy review at the diff, the convergence
bar (0 blockers + 0 majors), recipe fidelity, and ExitPlanMode ≠ execute. Wording stays **path-neutral**
(the substrate "knows nobody"). The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural
change, no migration); the npm package version is a separate axis.

- **Seed-or-preserve only (unchanged contract).** A NEW deployment gets the §2.6 lens from the seed;
  refreshing an already-deployed file is the composition root's job.
- **Template parity preserved** — the §2.6 block body stays byte-identical to the kit fallback template
  (only the heading number differs), pinned by the kit's cross-package `lens-mirror.test.mjs` (now over
  two scoped, non-vacuous token sets).

## 1.4.0 — §2.6 right-altitude & code-grounded lens (memory)

A **feature** release. The `agent_rules.md` substrate gains a **§2.6 Right-altitude & code-grounded
(planning + review)** self-review subsection — fold by code (read + cite the `file:line`), pin
intent/invariants/acceptance, and the convergence heuristic. Wording is **path-neutral** (the substrate
"knows nobody": it points at "the project's planning methodology / workflow-methodology canon", never a
sibling/engine path). The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no
migration file); the npm package version is a separate axis.

- **Seed-or-preserve only (unchanged contract).** A NEW deployment gets the §2.6 lens from the seed;
  refreshing an already-deployed file is the composition root's job.
- **Template parity preserved** — the §2.6 block body stays byte-identical to the kit fallback template
  (only the heading number differs), pinned by the kit's cross-package `lens-mirror.test.mjs`.

## 1.3.0 — Agent-writable config note; §2.5 Communication (memory)

A **feature** release. The seeded `docs/ai/orchestration.json` note now frames the config as
agent-writable (via the `set-recipe` writer) **and** still hand-editable — the old "never written for
you" wording is gone. The `agent_rules.md` substrate gains a **§2.5 Communication** self-review item
(deliver the artifact inline; lead with the result; large-artifact carve-out). The deployment-lineage
head stays **`1.3.0`** (no `docs/ai` structural change, no migration file); the npm package version is a
separate axis.

- **Seed-or-preserve only (unchanged contract).** This substrate still only **seeds** the config from its
  template when missing and **preserves** an existing one byte-for-byte — a NEW deployment gets the updated
  note from the seed. Refreshing the note *in place* on an already-deployed file is the **composition
  root's** job (memory stays standalone and owns no cross-package refresh helper).
- **Template parity preserved** — the seeded `orchestration.json` stays byte-identical to the composition
  root's fallback copy; the new note is identical across both.
- **Knows-nobody invariant intact** — the note + SKILL.md refer to the writer generically, never naming a
  specific sibling skill.

## 1.2.2 — Strip the package's own tests from the npm tarball (memory)

Packaging only — no API/behaviour change; removed the package's own colocated tests from the
published tarball, deploy payload tests retained. The deployment-lineage head stays **`1.3.0`** (no
`docs/ai` structural change, no migration file). The npm package version is a separate axis.

- **`files[]` scoped negation.** Appended `!bin/*.test.mjs` and `!scripts/*.test.mjs` to the
  package allowlist (npm ignores a root `.npmignore` when `files[]` is present, so negation entries
  in `files[]` are the mechanism). Tarball **41 → 37 files**: 4 of the package's own colocated tests
  no longer ship.
- **Deploy payload tests retained.** `references/scripts/*.test.mjs` are deployed into a consumer
  repo's `scripts/`, so they still ship — `!scripts/*.test.mjs` does not cross `/` and never touches
  `references/scripts/`. **Never broaden it to `!references/**`** — those tests are deploy payload.
- **Tarball guard.** `scripts/package-content.test.mjs` (dev-only) gains an `npm pack --dry-run
  --json` invariant: no own-test leak, payload tests + runtime files present, exact file count
  `=== 37`.
- Test files stay on disk; the gate + publish CI run them from the checkout, unchanged. This is a
  tarball-only exclusion.

## 1.2.1 — Hidden-mode maintenance invariant (memory)

Patch: documentation only. The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural
change, no migration file). The npm package version is a separate axis.

- **`agent_rules.md` template (§1.3) + the Visibility contract** now state that the task-completion
  doc updates are **visibility-independent**: hidden mode git-ignores `docs/ai` but never makes
  maintaining it optional — the updates simply live on disk and never enter a commit. Future
  deployments carry the clarified protocol; the durable wording lives in `agent_rules.md` §1.3.

## 1.2.0 — Seeds the per-project orchestration config

The substrate now seeds a new **per-project, user-editable recipe config** —
`references/templates/orchestration.json` — deployed into `docs/ai/orchestration.json` by the bootstrap
template loop. It declares the orchestration **recipe** each named activity/slot uses (the composition
root's read-only `procedures` advisor reads it); the recipe **canon** and the slot **vocabulary** still
live in the engine / composition root, never here (the substrate keeps knowing nobody — the seed's
self-documentation uses generic "composition root" phrasing, naming no sibling). The shipped default is
conservative: **`solo` everywhere**, with an onboarding `_README` explaining how to raise a slot.

### Added
- **`references/templates/orchestration.json`** — strict JSON (no comments), byte-identical to the kit's
  fallback copy (kit↔memory template parity guard). Seeded on bootstrap; on upgrade it is **ensured
  stamp-independently** (create-if-missing / **preserve-if-edited** — a user's edits are never clobbered),
  so even an equal-head (`1.3.0`) deployment gains it **without a lineage-head bump or a migration file**.
- An **ownership-table** row distinguishing the seeded, editable recipe **CONFIG** (memory) from the
  recipe **CANON** + slot vocabulary (engine / composition root).

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file). The
npm package version is a separate axis.

## 1.1.2 — Entry-point template headroom for the orchestration pointer

A **docs/prose** release (no new executable, the `1.1.1`/`1.9.1` precedent). The bundled entry-point
template (`references/templates/AGENTS.md`) ships a second empty marker pair — `workflow:orchestration`,
right under the methodology pair — which the family **composition root** fills live from the methodology
engine on deploy. To keep the deployed `AGENTS.md` inside its ≤100-line budget with **both** pointers
filled, the template trimmed non-essential slack (the Hard-Constraints intro blockquote + one
illustrative row a deploying agent adapts anyway). No behaviour change; the composition root remains the
only writer of the slots.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file).

## 1.1.1 — Installer hardening (Issue-004 parity)

A patch release that applies the same two installer fixes shipped to the engine in 1.1.0, keeping the
two identical family installers in lockstep.

### Fixed
- Containment check now accepts a legitimately-contained child literally named `..foo` (it wrongly
  rejected anything starting with `..` before); `tildify` collapses only a **leading** `$HOME`, never
  a mid-path occurrence (**Issue-004**).

### Changed
- The installer is importable without side effects (the `isDirectRun` guard) and exports its
  path/format helpers for in-process tests. The installer's own + README bare `npx … init` strings now
  use `@latest`.

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file).

## 1.1.0 — Hidden mode writes project-local, not global, excludes

Memory's **hidden** visibility now targets the **project-local** `.git/info/exclude` (its own footprint
only — `/AGENTS.md`, `/CLAUDE.md`, `/docs/ai/`, the added `/scripts/*.mjs`, `/docs/plans/`, both
`/.claude/settings*.json` — in canonical anchored form, idempotently), **never** the machine-global
`core.excludesFile`. Hiding a deployment no longer affects every other repo on the host (visibility is
a project setting). This is a **docs/prose** release (memory's hide was always prose-driven; no new
executable code); the tested superset path is the family composition root's hide tool, which absorbs
memory's project-local lines into one canonical managed block and adds the external footprint. The
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file).

### Changed
- `references/contracts.md` Visibility contract + `SKILL.md` step 9 retarget the hide to project-local.
- The upgrade flow moves an older machine-global hide to project-local — **after** the never-downgrade
  gate and **before** the equal-head short-circuit, so even an at-head hidden deployment is migrated.

## 1.0.0

Initial standalone release. The **memory substrate** extracted into its own package as Plan 1
of the agent-workflow family refactor (deployment-lineage head `1.3.0`). Additive: the family
composition root keeps its own bundled copy as a fallback, so nothing breaks for existing users.

### Added
- Standalone npm package + `bin/install.mjs` installer targeting
  `~/.claude/skills/agent-workflow-memory` (`AGENT_WORKFLOW_MEMORY_DIR`), with a
  symlink-traversal guard — the installer never writes *through* a destination symlink
  (root / intermediate / leaf).
- `capability.json` — the `agent-workflow` family manifest (`kind: memory-substrate`,
  `provides: ["context"]`). The package ships **no** family-wide schema/validator tooling
  (owned by the composition root) — it knows nobody.
- An **empty** delimited methodology slot in `templates/AGENTS.md`
  (`<!-- workflow:methodology:start -->` / `:end`); the substrate only ever ships it empty
  and preserves any filled content on upgrade. The composition root injects the methodology.
- `scripts/stamp-takeover.mjs` — a pure, unit-tested state machine for the legacy
  `.workflow-version` → `.memory-version` lineage takeover, with **atomic** (write-temp +
  rename) stamp writes, plus `migrations/legacy-stamp-takeover.md` (the no-Node manual
  fallback).

### Changed
- The deployment stamp is `docs/ai/.memory-version` (the legacy `.workflow-version` is never
  deleted; both track the shared lineage). Hidden-mode ignore lists now include
  `.memory-version`.
- `references/templates/agent_rules.md` no longer embeds the planning-methodology vocabulary —
  it points at the methodology owner. `contracts.md` attribution wiring is de-attributed from
  "the kit" to "the bootstrap".

### Carried over from the original substrate (deployment-lineage 1.3.0)
- `docs/ai/` templates, the Node enforcement scripts (caps + index freshness + 3-tier archive
  + hook installer) and their tests, the three setup contracts, and migrations `1.1.0`
  (conversational language) and `1.2.0` (agent attribution).
