# Changelog — agent-workflow (monorepo)

Repo-level history for the **agent-workflow** family monorepo. Each published package is
versioned **independently** — see its own changelog for package-level detail:

- `@sabaiway/agent-workflow-kit` → [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md)
- `@sabaiway/agent-workflow-memory` → [agent-workflow-memory/CHANGELOG.md](agent-workflow-memory/CHANGELOG.md)
- `@sabaiway/agent-workflow-engine` → [agent-workflow-engine/CHANGELOG.md](agent-workflow-engine/CHANGELOG.md)

## 2026-09-03 — AD-133 a spec guarantee is an invariant, never an open list (memory 8.0.0 MAJOR · engine 5.0.0 MAJOR · kit 12.0.0 MAJOR · bridges unchanged)

**One reader rule, two procedure sentences, a store revised by its code.** `feedback-triage.md` shipped a guarantee as
a list of three git states and the first live record met a fourth. The reader that defines "well-formed" now refuses
the class at the CLAUSE (a check verb + an enumeration + no closure in the same clause), the lists frozen only after a
probe over the live store: the `, … or` and ` · ` forms kept, `, … and` (36 hits — a closed statement refuses as
readily as an open list) and comma-only (38 hits, every one the kept forms do not already catch a false positive) dropped, `never` removed from the closures (it had immunised
the raising clause). Twenty refused clauses in nine project specs take closing forms written from the code's own
partition — two closures a reviewer proposed verbatim were false of `robustness-brief.mjs` and were rewritten from its
exit sites. Plan-authoring's review brief now walks around every check bullet; plan-execution's fold rule sends a
second case against one check to the replacement invariant; the consult line and the lens vehicle carry both. Measured
on itself: four plan rounds (codex revise 7 → 9, then the crossover stop; agy SHIP every round; the lens 1B+5M → 2B+7M
→ 2B+1M → 0B+0M), the code landed by ONE held codex session in three accounted dispatches with the red-proofs
re-minted by the orchestrator, the delegate's unnamed terseness compression of the procedures canon caught at
self-review and restored where a sentence had no other home.

## 2026-09-03 — AD-132 a field report is triaged through a rendered procedure over a checked record (kit 11.2.0 MINOR · engine 4.7.0 MINOR · memory 7.2.1 PATCH · bridges unchanged)

**A fourth activity, not a skill.** Three consumer field reports were triaged ad hoc; the family's
measured adoption pattern is a rendered procedure plus a record shape a checker can refuse. The kit
gains `feedback-triage` (one `review` slot, no autonomy block), the engine's canon gains its six
steps and Definition of Done, and the record `docs/plans/FEEDBACK-<date>-<slug>.md` has one grammar
(version 1) that `feedback-record-cli --check` proves on the WORKING TREE at the stamped HEAD — every
anchor read no-follow and capped, realpath-contained, and positively tracked: a lexical top-relative
`:(literal)` pathspec must be listed `H` by `ls-files`, clean by `status`, or the anchor refuses by
name (`.git/config`, an untracked file, a symlinked parent, a concealing index bit, a modified file).
`--excerpts` writes the verbatim anchor lines as the agy review's facts under the scratch-destination
guard and a stated budget; `--rows` renders the skeleton queue rows and the ratchet line; the
procedures advisor renders the record-bound review lines per roster member. The seed note states
the defaults honestly instead of seeding a slot (memory's twin follows). Measured on itself: seven
accounted dispatches on ONE held codex session; five diff rounds with the lens beside both bridges —
codex 6M → 3M → 1M → 1M → ship, agy SHIP every round, the lens 1M → 0M; every fold consulted with its
raiser, two consults corrected a proposed test; the maintainer's ruling at round 4 ("no majors means
done, real minors are debt") sent six real minors and nits to the queue.

## 2026-09-02 — AD-131 the bootstrap offers enforcement on every project and the advisor closes the loop (kit 11.1.0 MINOR · memory 7.2.0 MINOR · engine 4.6.0 unchanged · bridges unchanged)

**The first delegated feature under the five rungs, and the series' acceptance metric measured.**
Bootstrap steps 8–9 and the memory substrate decided the enforcement scripts + hook by the step-1
recon; a Python, Go or Rust project was denied the caps gate, the archivers and the hook, and
`upgrade` then reported `skipped-no-node-evidence` on the tree the bootstrap left bare. Now the
offer rides every project, preview-first, keyed on the kit's own node-evidence contract (rev 2: the
bootstrap seeds on `package-json` OR `deployed-node-scripts` OR the fact that the agent host runs the
kit; the only skip condition is that the agent host cannot run them; the committer-node residual is
stated); the Recommendations advisor gains ONE optional `enforcement` item — the exact bootstrap
tail as a shell-quoted `HAND-APPLY` line over a clean `scripts/` destination; silence on Node
evidence or with no `docs/ai`, a stated skip naming the offending path in every other state — and
the commit-guard skip carries its own remedy instead of "run upgrade
first"; a declined offer leaves no false claim anywhere in the family (one conditional per site, one pin
table). The deployed scripts' basename fallback is pinned, no script changed. Measured on itself:
eight delegated dispatches on ONE held session; diff council round 1 codex 0 blockers + 3 majors,
agy 0, lens 0 + 2 majors; CLEAN at round 4 against the 13-round baseline; three fold-induced
findings, every one caught by a test or gate before any receipt attested it.

## 2026-09-02 — AD-130 the per-fold walk is a record, the cap is a refusal, the fingerprint argv has one home (kit 11.0.0 MAJOR · engine 4.6.0 MINOR · codex bridge 3.7.0 · agy bridge 5.6.0 · memory 7.1.2 unchanged)

**The last two rungs of the first-pass-quality series, and the two fingerprint classes plan 1 measured
RED.** Rung 4: "does the tag cover the row" is the generator's second mode (`robustness-brief
--coverage`, bounded literal occurrence in the row file's bytes — the first run over this plan named
an errno the executor would otherwise never have been briefed on) and the adversarial walk a fold
owes is a RECORD (`internal-attestation --walk`) that `round-open` refuses without for every round
after the first. Rung 5: the cap is the round table's OWN signal (`cap reached` / `crossover`), past
which `round-open` refuses unless every blocking item of the latest round is covered by a disposition
at digest equality; `--dispose queued` carries a `--claim` fold-scope accepts and a bound proof, so a
finding with no proven narrow fix is never queued; a lost manifest is a recorded `custody-lost`
disposition, never an exemption. The fingerprint argv has ONE home in `core-evidence.mjs` and carries
`--no-textconv --ignore-submodules=none`, mirrored into both wrappers' bash twins and proven on real
git — Issue-023 and Issue-024 close, `commit-guard`'s content-free lane narrows to a backstop. The
MAJOR: the fingerprint domain moves on textconv / submodule repositories, `--dispose queued` changes
its operands, `round-open` refuses where a justification used to lift, and every post-rung record
form reads under kit >= 11 only — the kit's CHANGELOG carries the BREAKING block and the minimum
bridge versions. Measured on itself: the plan's fourteen delegated dispatches rode ONE held session
(AD-127) and the diff council converged in three rounds — the crossover at round 2, every survivor a
fixable bug folded once, the attestation round ship-class from every member. Memory is unchanged.

## 2026-08-31 — AD-126 + AD-127 the release is one run with one approval, and a fold on delegated code rides the delegate's held session (kit 10.6.0 · engine 4.5.0 MINOR · memory 7.1.2 unchanged)

**Two decisions since 10.5.0, one of them driving this very release.** AD-126 (`2682492`, repo-only
scripts): a family release is ONE run under ONE approval — `scripts/release/release-run.mjs` drives
eight receipted stages (`commit`, `preflight-remote`, `push`, `smoke-candidate`, `cross-version-gate`,
`live`, `verify`, `smoke-init`) from a `--plan` render that IS the approval text and ends with the
fingerprint the run then requires, resumes
at a failed stage from its receipt, and reads npm `@latest` through an isolated `npm view` so no stage
needs the sandbox off. This entry's release is the first one it drives. AD-127 (`300e01f`, the bumps
here): **the delegate that wrote the code is the one who folds the review into it.** Thirteen
diff-review rounds of hand-made folds on the previous feature, with the executor's session id on
disk the whole time, measured the defect; the answer is a kit mechanism, not a rule to remember. The held session is a
value read from the delegation ledger the kit already mints (`held-session.mjs`, the pure judge;
`dispatch-store-read.mjs`, the ledger's read half); `review-state` names it and `--check` refuses a
substitution, so the commit guard inherits it; the advisor renders the fold command `codex-exec
--resume <held id> --nonce <nonce> <fold-brief>` with the id populated; the engine's `procedures.md`
step 5 states the sentence. Proven on itself: seven folds of the feature's own review rode the held
session. Memory and both bridges are unchanged.

**Hotfix the same day (repo-only release tooling):** `npm-view.mjs` passed ONE empty file as both
`--userconfig` and `--globalconfig`, and npm 12 exits 1 before any request ("double-loading config …
as global, previously loaded as user") — so the run's own post-publish verify failed although the
publish had succeeded, and verify + smoke ran by hand. Two distinct empty configs now, pinned by an
offline real-npm test (the `scripts` size record grows by that pin: "npm-view hotfix: two distinct
empty configs (npm 12 refuses one path as both user and global config) and the real-npm offline pin").

## 2026-08-28 — AD-125 the plan-review loop's measured costs are rungs, values and receipt fields (kit 10.5.0 · engine 4.4.0 MINOR · memory 7.1.2 PATCH · codex bridge 3.6.0 · agy bridge 5.5.0)

**Five hours of review, taken apart into checkers and fields.** A plan is refused by SHAPE before its
first review (`plan-shape-cli --check`: the row cap, red-first order, the pin row, budgets, anchors) and
closed by `--verify`; the readers sweep opens self-review and the advisor renders it; consult-before-fold
is a procedure step, not a memory; `plan-authoring` distinguishes the draft carrier from the fold
carrier; every review receipt carries its duration and its blocking count, and a plan or diff receipt
its artifact path, so the
kit's round table (`review-rounds-cli --artifact <plan>`) computes `converged` and `crossover` from
the receipts and the advisor prints that command populated with the plan in flight; `agy-review
plan|diff` forbid the file read themselves. Four plans, each landed as one reviewed commit: plan 1 the
checker (4 rounds: the cap of 2, one round on the cap fold, one narrow round), plan 2 the procedure and
the fold slot (4 rounds: the cap of 2, one narrow round after the cap fold, one round paid for a test
rename), plan 3 the receipt fields and the round table (3 rounds, 4 red-proofs), plan 4 the render and
the release. The next feature of comparable size is the acceptance measure: a spec and a plan in
≤2 rounds each, zero shape findings, zero reader blockers, receipted durations.

## 2026-08-27 — AD-124 who does what is a project setting (kit 10.4.0 · engine 4.3.0 MINOR · memory 7.1.1 PATCH)

**The carrier of a step is a setting, not a memory.** `docs/ai/orchestration.json` now says who
authors a plan, who executes a ledger row and who carries a routine chore — the orchestrator, a bridge,
or a full-tool frontier subagent — with a project default per slot and a per-run override that never
touches the file. The kit ships the executor vehicle beside its four read-only ones, surveys it as a
readiness fact, renders the dispatch form per slot and raises an attention item when a configured
subagent has no usable vehicle; the engine canon names the fifth recipe and the third activity.
Plan 1: two plan-review rounds and twelve diff-review rounds across both configured review
backends, 28 findings folded. Plan 2: three diff-review rounds, 18 findings folded, then an attestation round.

## 2026-08-27 — AD-123 a deployed project is never in an unnamed spec-adoption state (kit 10.3.0 · engine 4.2.0 · memory 7.1.0, all MINOR)

**Two lines stopped being false about the tree they described.** A Bash-only consumer's `upgrade`
printed `specs: skipped-no-node — no package.json at the project root` beside its own deployed Node
scripts, and its advisor said `flow optimal` over a project with no spec store at all. The kit now
PROVES Node — a root `package.json` OR any kit-seeded `scripts/*.mjs` — and the skip that remains
(`skipped-no-node-evidence`) names every probe it checked; a probe it cannot read fails closed
(`node-evidence-unverifiable`) instead of skipping. The advisor's new `spec-adoption` item renders
the seed on an absent store and the decline while a store holds no live contract (both optional —
the layer is opt-in), a stated skip over a store it cannot read, silenced only by a recorded decline (`ack-write --lane spec-adoption`); `status`
prints one `specs` line in every state. The ack store's guarded no-follow read became ONE leaf both
surfaces import.

**The canon names the state instead of licensing the zero.** Engine 4.2.0's Spec-first lens,
`planning.md` and `specs.md` say a ZERO cites `not adopted` / `adopting` / `nothing spec-covered
touched` and is never a licence; the outgoing lens body joins the priors so deployed rules refresh.
Memory 7.1.0's template carries the same words, plus the §2.5 bullet the kit's upgrade doc now enforces
too: a skip line that contradicts the observed tree is a FINDING, never pasted as neutral.

Refused from the brief, with reason: a mechanical refusal of a bare zero once the store exists — no
plan-shape checker exists and the citation has no literal grammar; queued with its entry condition.
Two plan-review rounds and two diff-review rounds converged; every fold was confirmed on the finding's
own axis before it landed.

## 2026-08-26 — AD-122 a review can no longer pass a change it called broken (kit 10.2.0 · antigravity-cli-bridge 5.4.0, both MINOR)

**The receipt stops lying.** A consumer's council round recorded a clean `SHIP WITH NITS` receipt
while the same review body listed a correctness bug and a security violation under `### Blocking`:
the wrapper parsed the verdict line and nothing anywhere read the section its own prompt mandates.
A ship-class verdict beside a numbered Blocking item is now a verdict-body contradiction and takes
the existing failed-review arm — exit 4, NO receipt, both halves named, re-run the review — in the
fresh, fed and continuation lanes alike. The verdict is never rewritten and never downgraded.

Bounded on purpose: the predicate binds the mandated shape, not comprehension; `REWORK` is never
refused; an absent Blocking section is not a contradiction; and exactly one section is judged, so a
repeated heading can never suppress a receipt the first one did not. The codex twin is unchanged —
its contract carries no machine-checkable findings section.

Written to a contract before the code, under the AD-121 ruling, and the bridge's 3224-line test
suite was split while the guard went in: a shared harness file, the wrapper suite at 2893 lines with
its 213 arms green, and a 109-line topic suite carrying the eight scenarios.

## 2026-08-26 — AD-121 no work without a specification (kit 10.1.0 · engine 4.1.0, both MINOR)

**A contract stops being a suggestion.** A shipped tool that no LIVE contract under `docs/ai/specs/`
claims is now a REFUSAL, enforced by `spec-coverage --check` and declared as a gate. Each contract's
own `## Module` list IS the coverage map, so coverage is never declared twice. Measured at adoption
in this repo: **122 tool modules, 14 governed by a contract.**

The other 108 are recorded as debt — and the debt is DERIVED, not stored: `adopted` is the set
measured once and never rewritten, `settled` names the paths whose contract has since been written,
and what is owed is the difference. There is no list a hand can edit into a lie; the one editable
claim, "this was paid", is checked against the contracts on every run. Storing the debt directly was
the first design and a review killed it: nothing obliged anyone to use the safe write path.

The scope file is validated before use (a census of zero REFUSES — a gate that passes because it
looked at nothing is not a pass), exclusions are path-component boundaries, and `draft` / `retired`
contracts cover nothing. Also in this release: `spec-check` counts a scenario marker as a whole
ordinal, so a store reaching ten scenarios no longer refuses a correct binding.

**Engine 4.1.0** carries the other half: `references/planning.md` gains `## The queue` — the backlog
NAMES work and never holds the analysis of it, a terminal row is deleted in the same change that
mints its closing artifact, and where the queue is gitignored the deleted text goes to a purge
archive first. The canon names the runnable checker instead of promising the discipline in prose,
which had been measured failing at 62 dead rows.

## 2026-08-26 — AD-119 a symlinked docs file gets named instead of skipped (kit 10.0.0 · memory 7.0.0, both MAJOR)

**A gate that skips silently is a gate that lies.** The docs cap-validator kept a walk entry only
when `entry.isFile()` — FALSE for a symlink, as is `isDirectory()` — so a symlinked `*.md` under
`docs/ai` fell through both arms and left the walk entirely: no cap check, no missing-frontmatter
error, no navigator row, and not counted in the report's own file total either. Probed live, a tree
with one real over-cap doc and two symlinks reported `1 files inspected  —  1 error(s)`, which is
what turns a gap into a false report. Such a link, and one resolving to a directory, is now a NAMED
error row that is never read.

MAJOR on both because a docs tree that was green can now go RED with no edit of its own. Two scopes,
the second wider than the first: a symlinked docs FILE produces an error row, and `--check-index`
now runs the navigator's containment guard BEFORE it reads — so on a chain the walk can traverse, a
symlink at the project root, `docs`, `docs/ai` or `docs/ai/index.md` exits 2 where the mode used
to compare and pass. That is the guard `--write-index` and `--ensure-index` already ran. A chain the
walk cannot traverse at all still ends the run as it always did, before any guard — unchanged here.

It bites only once the new bytes reach a project's `scripts/`: a fresh bootstrap, a
`migrate-adr-store` refresh, the `specs` ensure's prior-matched lane, or a hand copy — an ordinary
install does not overwrite a deployed `check-docs-size.mjs`. The gate names the path and which case
it is; the remedy is to replace it with a real file or a real directory, whichever it stands for, or
move it out of `docs/ai`. For a symlink on the navigator's own chain, regeneration is itself refused,
so `--write-index` cannot clear the gate — only replacing the link can. Package changelogs carry the
per-package detail, including what this deliberately does NOT move.

## 2026-08-25 — AD-118 a rolling archive stamps a cap it can honour (kit 9.0.0 · memory 6.0.0, both MAJOR)

**The archiver emitted files its own gate refuses.** Each tier's frontmatter `maxLines` was a
LITERAL in the builder that wrote it — WARM 3500, COLD 1500, META 300 — which is a promise about a
corpus nobody has seen yet. When a tier outgrew its number the run produced an over-cap file, the
repair was a hand edit, and the next run stamped the literal straight back over the repair. This
repository was carrying two such workarounds when the work opened: a hand-raised `maxLines: 1800`
on a COLD month against 1750 live lines, and a changelog that could only be rotated with
`--warm-days=21`. Both are gone. `capFor({tier, count})` stamps the tier floor while the file fits
under it, the file's OWN line count once it does not, and REFUSES past a ceiling — in the default
run, `--dry-run` and `--check` alike, which required every cap-bearing output to be built before the
mode branch rather than on the write path. The ceiling is 2x the floor, fixed and never measured
from a corpus, because the refusal rides a standing `--check` gate: a ceiling derived from whatever
happened to be on disk would brick every commit the day the corpus grew past it.

MAJOR on both because a shipped CLI gains a non-zero exit and refuses input it previously accepted.
It bites when the new bytes actually reach a project's `scripts/` — a fresh bootstrap, a
`migrate-adr-store` refresh, or a hand copy; installing the packages does not overwrite an existing
deployed archiver, and delivery to existing deployments stays a filed row rather than part of this
release. Once the bytes land, a deployment whose archive has already outgrown a ceiling turns red
with no edit of its own, and META's floor rises 300 → 1500. The kit's own half is the companion
seed: `archive-caps.mjs` is imported by `archive-changelog.mjs` alone, so the migration's flat seed
list — correct for the one runtime dependency it held — became a way to write a file with no
importer, and an entry can now name the importer it rides.

Four review rounds over the diff, and each of the first three paid. `capFor` returned `undefined`
instead of refusing for an inherited key like `toString`. A gate the plan never anticipated went red
because a new import by a refreshed archiver reopened the exact hole the companion seed closes. And
the per-tier remedy text, added in one round, was found in the next to be advising a file layout the
archiver cannot read back — following the COLD remedy would have dropped those files out of the
corpus, so both COLD and META now state their sharding as not implemented and say why.

## 2026-08-25 — AD-117 the scenario floor and the five canon answers (kit 8.0.0 · memory 5.0.0 · engine 4.0.0, all MAJOR)

**A `kind: spec` document could pin NOTHING and pass everything.** `checkOutOfScope` enforced a
minimum; `checkScenarios` enforced none — so an empty `## Scenarios` section satisfied the reader,
both `spec-check` lanes and the gate row alike. Measured cost, from writing the layer's first real
specs one slice earlier: three stub specs would have cleared every mechanical check and delivered
nothing. The reader now carries one new frozen rule, `scenarios-empty`, in table position between
`scenario-path` and `out-of-scope`. `*(empty)*` is deliberately not an escape there — written under
`## Scenarios` it still refuses as `scenario-line` — because the grammar already has the honest form
for a scenario no test pins yet, `- S<N> <name> :: unbound`, and that form accepts on every status.
The asymmetry with `## Out of scope` is the whole point: an empty exclusion list is a claim, an empty
scenario list is an absence. Nothing that exists refuses — the corpus, the live store and the shipped
templates were all measured before the floor shipped.

MAJOR on all three because the same refusal reaches each package by a different road: the reader
refuses a document it accepted (memory), the kit ships those bytes so a deployment's spec gate turns
red with no edit of its own (kit), and a spec written to the 3.3.0 canon can be invalid under this
one (engine — the class engine 3.0.0 already called MAJOR). The release also discharges
KIT-SUBTREE-CHANGED-WITHOUT-A-BUMP, the obligation slice 4 left when it wrote 19 binding markers into
the kit subtree and shipped no bump. The reader pair's outgoing 4.7.0 bodies join the known-prior
catalog in the same release, so an unmodified deployment converges instead of stranding as `custom`.

The other four frictions slice 4 recorded are answered IN the canon, at their own points of use, and
four of the five answers are a refusal to add a mechanism: a binding marker is an ORDINARY source
line (no carve-out in the size judge — it counts bytes and must not learn spec vocabulary); there is
no sidecar binding form (retroactive coverage of a published package rides a release train, because
the marker moves that package's subtree); there is no `root` op verb (the store root is the
navigator, judged as the listing parent of its declared child); and the promoting event of a
retroactive draft is PLAN APPROVAL, so `live` lands in the slice that authors the draft — otherwise
the store's first contracts stay permanently provisional by the canon's own wording.

Review: the plan took five councils before approval (23 findings, all folded or withdrawn) and a
sixth NARROW round over the two round-5 folds nothing had re-reviewed. That sixth round paid three
times over, all before a line of code: the sequencing sentence claimed a queue row ordered another
plan first when the row names neither this slice nor a successor; the precondition passed three pairs
to a single `version-sync --expect`, which exits 2 — so the check could never have detected the
release order it existed to detect; and the Cleanup re-pin named two of the three version sites in
the sibling plan. Both backends found the third independently. Execution converged in ONE round —
codex `ship` (gpt-5.6-sol, xhigh, priority), agy `SHIP` 0/0 (Gemini 3.7 Flash (High)) — with a narrow
grounded consult finding no new defect.

## 2026-08-25 — AD-115 `spec-check`, the spec store's structural checker (kit 7.6.0 MINOR)

**The spec store is now judged against what the session SAYS it changed — explicitly, never from
git.** A checker that inferred the change set would attest a post-state nobody declared, and a diff
cannot tell "renamed" from "deleted plus added" at all. So a session states its ops in a frozen
grammar with exactly ONE accepted spelling per document (nothing is normalized away; a path holds at
most one role; the store root is never a target), and the checker judges the closure of those ops —
the targets plus each one's listing parent — on their post-state, their reader verdict, their
per-kind cap, their scenario bindings and the containment of every path they name. A `## Module`
path must now also EXIST with the kind it declares, so a contract can no longer name code that is
not there. `--all` judges
the whole store instead and adds the four questions no document can answer about itself: an unlisted
child (distinct from an orphan), acyclicity, store-wide slug uniqueness and module overlap. Nothing
here re-defines "well-formed": every per-document verdict is relayed from the 7.5.0 reader.

The half worth remembering is what "fail-closed" turned out to mean. Not "safe unless proven to
escape": a path whose realpath does not resolve is never read; containment asks the platform's own
path model, because a textual prefix test reads `/repo\outside` as a child of `/repo` on POSIX; every
listed edge is probed before it may enter the reachability graph, or a phantom target gets marked
reached and launders an orphan into a reached document; and the census admits a closed set — plain
directories and regular `.md` files — and states everything else, because a symlinked directory was
the hole through which an edge resolved to documents nothing had ever observed. A census that
observed nothing keeps its own refusal rather than
collapsing into a usage error. Memory 4.7.0 and engine 3.3.0 unchanged.

Review: a codex (gpt-5.6-sol, xhigh, priority) + agy (Gemini 3.7 Flash (High), single run) council
on the staged tree, **5 rounds and 17 findings, all folded** — codex `revise` four times then `ship`,
agy SHIP from round 1 and clean for its last four. Round 2 overturned round 1's own prescription (a
dual-separator overlap comparison, wrong on POSIX where a backslash is an ordinary filename
character). Two defects were caught by this repo's own gates rather than by either backend: a D-scale
regression when platform-native containment made the pairwise overlap sweep 4.5x too slow at
n=1000 (now an index over an injective pair key, 573 ms against a 1500 ms budget), and a raw NUL byte
an edit put into the module, refused by the tarball guard.

## 2026-08-24 — AD-114 the structure verdict + the reader refresh lane (kit 7.5.0 MINOR, memory 4.7.0 MINOR)

**The ONE reader now hands the coming `spec-check` its structural read, and the reader pair itself
becomes refreshable on deployments.** Slice 2b needs `{scenarios, children, parts, module}` out of a
spec document, and the only module allowed to define "malformed" is the reader — so its verdict
gains an additive, deterministically-extracted `structure` field (shape frozen at plan time,
verbatim targets, null only on the early refusals, `## Links` never extracted, the module a
conjunction). And because the bundled reader bytes move, the reader pair joins the AD-113
known-prior refresh lane in the SAME release — the catalog gains the outgoing 4.6.0..4.6.1 bodies,
`ensure-specs` decouples its pair constants (the alias would have double-surveyed) and admits a
reader refresh through the same one-conjunction discipline, directionally: a custom file withholds
its pair's refreshes and everything downstream (create-only reader seeds stay admitted), nothing
above it. A real 4.6.x deployment now upgrades whole under its real hook instead of stranding as
`custom`. Engine unchanged at 3.3.0.

Review: two execution commits + the release commit, each a codex (gpt-5.6-sol, xhigh, priority) +
agy (Gemini 3.7 Flash (High), single run) council on the staged tree — commit 1 closed in 1 round
(codex ship, zero findings; agy degraded LOUDLY on an unreadable envelope, single-run policy),
commit 2 in 4 rounds and the release commit in 3, each to ship/ship; 12 findings folded.

## 2026-08-24 — AD-113 the spec layer reaches existing deployments (kit 7.4.0 MINOR, memory 4.6.1 PATCH)

**An EXISTING deployment at lineage head `3.0.0` gains the AD-112 layer on an equal-head upgrade,
with no lineage bump.** AD-112 delivered the feature-spec layer to fresh bootstraps only; the brief's
delivery invariant (D1) says a new deployed `scripts/` file ships create-only BEFORE any refresh of a
file that imports it. One measured fact shaped the slice: the kit's bundled navigator generator
collapses `docs/ai/specs/` into one counted row while the project's pre-commit hook runs its DEPLOYED
`check-docs-size.mjs` — a store root seeded behind an older checker renders row by row and reds
`--check-index` on the next commit. Hence the two rules this release ships:

- **A deployed script is refreshed only when its bytes are a body a release shipped.** The kit's
  append-only `script-priors` catalog (sha256 of every checker/test body since memory 4.0.0,
  verbatim fixtures held equal both ways, a literal immutable prefix pin) classifies a deployed
  `check-docs-size.mjs` as `current` · `prior` · `custom`; a custom body is preserved verbatim and
  said so, and no other deployed script is refreshed.
- **The store root is seeded ONLY behind a checker pair proven current after the run.** The sixth
  `specs` ensure surveys four scripts and the store root before writing, admits each write through
  ONE conjunction, re-proves a lost create-only race, composes every line from the fate of its
  write, and relays one token (`seeded` > `refreshed` > `customized-preserved` > `already-present`).
  The closed vocabulary gains `refreshed` / `would-refresh`; engine unchanged at 3.3.0.
- **The memory standalone upgrade is the twin with NO catalog:** seed the reader pair if missing,
  seed the store root only when BOTH deployed pairs are regular files byte-equal to the bundle, else
  report the composition root's upgrade as the refresh lane with no store root written.

Review: three execution commits, each a codex (gpt-5.6-sol, xhigh, priority) + agy (Gemini 3.7 Flash
(High), single run) council on the staged tree — 2 + 2 + 4 rounds to ship/ship, 9 findings folded;
one agy degrade recorded (unreadable envelope), loudly, per single-run policy.

## 2026-08-23 — AD-112 the feature-spec layer (memory 4.6.0 + engine 3.3.0 + kit 7.3.0, all MINOR)

**A deployed project gains per-feature contracts with a mandatory Out of scope.** The family had no
durable layer between the whole-project `technical_specification.md` and the plan that dies at
Cleanup; a feature's boundary lived in tests and memory, and scope creep was the measured pain. The
maintainer ordered an adapted spec layer shipped into the family at once, under six binding
constraints (no 1:1 copy; hidden mode from day one with no new machinery; Out of scope as the core
value; spec as an architecture discipline; thousands of specs as a designed scale; order, not chaos).
The design brief settled ten decisions over four council rounds; slice 1a lands the layer and its
fresh-bootstrap delivery.

- **One frozen schema, one reader, one definition of well-formed.** The engine canon
  `references/specs.md` and a repo-only corpus (81 fixtures: 9 accept cases covering every kind, 33
  refuse-rule folders) freeze the schema; the deployed, import-free, text-only reader
  `scripts/spec-schema.mjs` enforces it with exactly one rule id per defect (33 rules), and the
  navigator collapse reads through it today so the slice-2 checker can read through the SAME module.
  Review subtracted the one attempt to model markdown code inside the reader — two fold-induced
  majors in one subarea meant the grammar shrank (a fence refuses) instead of growing a parser.
- **A counted navigator row, visible refusals, a release-gating budget.** The ADR-only collapse in
  the checker became a GROUPS loop; `specs/` is ONE row with live counts; a file the reader refuses
  keeps its own visible row and its schema refusal is advisory (the substrate's own frontmatter and
  cap errors stay blocking, as for every `docs/ai` file). 1000 specs in a 30-per-folder tree: 843 ms for both hook runs against a
  1500 ms budget.
- **Plans bind to specs without a new checkpoint.** Governing specs are plural and per slice, Out of
  scope composes per slice, a draft or revision is a ledger row present at review — the existing
  approval confirms plan and contract atomically. The lens gains `Spec-first`; both `agent_rules.md`
  templates and `AGENTS.md` carry it.
- **Delivery.** Fresh bootstrap only (memory standalone + kit fallback, each E2E-pinned with
  `SPEC_TEMPLATE.md` excluded by NAME and the store root present; the memory E2E runs the real hook
  over a seeded spec). Existing deployments are slice 1b.

Review: three execution commits, each a codex (gpt-5.6-sol, xhigh, priority) + agy (Gemini 3.7
Flash (High), single run) council on the staged tree — 5 + 1 + 4 rounds to ship/ship; 16 findings
folded and two more answered by subtracting a surface, at the originating bridge's call.

## 2026-08-23 — AD-111 a placed file joins the hidden-mode registry in the same change that places it (kit 7.2.0 + engine 3.2.0 MINOR, memory 4.5.4 PATCH)

**The bug was shipped by the release that created the file.** kit 7.0.0 added the MCP registration
writer; `.mcp.json` never entered the hidden-mode footprint registry, so a hidden deployment that
registered the typed channel left it visible to `git status`. The omission had even been *recorded*
as forced — but the recorded reason was about the worktrees consumer, and hidden mode's loss was
written down nowhere. This repository had quietly grown a hand-written exclude line outside the
managed fence to compensate.

Kit seats the path and gives worktrees their own predicate: one frozen never-provisioned set at three
sites (copy set, containment sweep, cleanup ownership) plus a pre-mutation `--include` refusal, and a
settings strip that rewrites only an untracked copy whose bytes are still byte-identical to MAIN (or
to its rebased form) beside a launcher proven absent — every other state keeps its tokens on purpose.
Measured, not assumed:
without the ownership guard, `cleanup` removed a satellite's own registration and exited 0.

Engine adds the canon clause the cycle earned — a guard is admitted by a conjunction of PROVEN facts,
never by a list of exclusions, and the state table is written before the code. Three review rounds
each found one more unenumerated state in one function; every miss failed open. Memory ships the
re-rendered template.

## 2026-08-22 — AD-110 a finding names the invariant its fix enforces, and the fold channel gets a checker (engine 3.1.0 + kit 7.1.0 MINOR, memory 4.5.3 PATCH)

**Memory ships too, and the reason it does is worth recording, because the plan said it would not.**
The engine's contract is that a lens wording change is an **engine-only release**: a deployed
`agent_rules.md` region converges from the live engine read on the next kit touch, so no other
package needs to move for a DEPLOYMENT to be correct. That reasoning was carried into this release
and it was wrong about one thing — it is a statement about deployments, not about PACKAGES. This
package's own bundled template is a shipped artifact, and the publish workflow refuses to no-op a
package whose subtree changed without a version bump: the existing tag still points at exactly the
bytes on npm, and it is the CHANGED subtree that no longer matches them, so a no-op would leave that
change unversioned and unpublished. The live dispatch is what said so, by name,
after engine 3.1.0 had already published — the review had raised exactly this and it was rebutted on
the lens mechanism, which was true and beside the point. Memory 4.5.3 carries the re-rendered
template and nothing else.


A review round produces findings, and until now nothing said which of them the phase owes. Measured
on this repository: 8 rounds where the declared scope closed at round 2, and 15 in the 7.0.0 cycle —
each one re-deciding, per finding and from scratch, whether it belonged to the work in hand.

The rule is one sentence with three arms. Every finding NAMES the invariant its fix would enforce,
BEFORE the edit, and where that invariant already lives decides the arm: already an acceptance
criterion of the phase, fold it here; it would have to be ADDED, ship the narrow fix for the found
site now and queue ONLY the generalization; no correct narrow fix, it is blocking and the phase does
not close. What makes the arms checkable rather than rhetorical is the second half: the acceptance
criteria ARE the `- ` bullets under a plan's `## Verification`, and they are the whole list — so
`fold-scope` can refuse a claim whose reference does not resolve, and refuse a deferral whose queue
row is absent, closed, ambiguous, self-contradictory, or short of one of its five fields.

The slice is deliberately ADVISORY: nothing records that the checker ran. Binding it to a receipt a
gate reads is the next slice, and saying so is the point — a mechanism that cannot yet prove it ran
should not be described as if it could.

Its own execution is the first evidence either way. Eight council rounds on this diff, 22 findings
folded, two rebutted with a live probe, and exactly ONE deferred — as a five-field queue row the
shipped checker itself accepts. The second bar (a repeat in one subarea routes to SUBTRACTION) fired
twice against this change's own code: a hand-rolled markdown grammar was deleted in favour of the
block model the archivers already read through, and a pattern asking two questions at once was split
so it asks one.

## 2026-08-22 — AD-108 the typed channel reaches a deployed project, and a veto check is subtracted after it worked (kit 7.0.0 — MAJOR for an `uninstall` outcome that stopped lying; every other member measured unchanged)

The kit's stdio MCP server shipped in 6.0.0 and no project could see it — a client sees a
project-scoped server only once the project declares it. `/agent-workflow-kit mcp` is that
declaration: the `agent-workflow` entry in `.mcp.json` plus the enable key and two derived allow
rules in `.claude/settings.json`, preview-first, with the exact entry on screen before consent.

The decision worth keeping is the one that removed working code. A `disabledMcpjsonServers` check
was built during review and generated seven findings across three rounds, because honouring that
veto means reading it from every settings scope the client merges and each scope has its own masked,
symlinked, malformed and unreadable states in which a hidden deny still yields a confident answer.
It was **subtracted** and the limit stated by name instead. The same review generalised `uninstall`'s
containment from one named directory to the whole parent chain, and gave an interrupted teardown a
typed outcome that distinguishes a refusal proven pre-mutation from a possibly-partial failure.

**That last change is what makes this a MAJOR.** An interrupted teardown used to return
`{ applied: true }` — a run that had not finished, reported as one that had — and now refuses with a
typed INCOMPLETE stop, with no alias and no deprecation window. This package sized exactly that shape
as MAJOR twice before (4.0.0, 5.0.0) and stayed MINOR once (5.6.0) only because that release kept an
alias. Three independent opinions were taken on the bump; the two that said MINOR gave no reasoning,
the one that said MAJOR cited those precedent lines, and the citations were verified before the call.

## 2026-08-21 — AD-104 the plan canon becomes a capped index, and the grounding tool follows it (engine 3.0.0, kit 6.0.0, memory 4.5.2; codex-cli-bridge 3.5.0 and antigravity-cli-bridge 5.3.0 measured unchanged)

One thing rides this train: the planning canon is rewritten, and every surface that quoted it moves
with it. The canon used to say what a plan CONTAINS and never what it may COST. The measurement that
started this: the last plan written to the old shape ran 690 lines, and most of that was free prose
under `## Approach` — a section with a budget of nothing and no check on its content, which review
could only ever ask to extend.

A plan is now an index plus constraints, capped at 100 lines AND 8000 bytes — both, because a line
cap alone is paid off with longer lines. Its centre is a **Module ledger**: one row per path, six
fields, at most 200 bytes, and those rows ARE the steps. The Plan → Phase → Step → Substep numbering
is deleted; rows execute top to bottom, each is one logical commit, and the only phases left are
session boundaries and Cleanup. A wide mechanical change is ONE row with a glob path and an asserted
count, because splitting a sweep into per-file rows costs more prose than the sweep. The ledger ends
with `total: <before> → <after> lines`, since five files under a 400-line cap can each be legal while
the change doubles the codebase — the per-file budget cannot see that, and the total refuses a
"refactor" that grows at plan time rather than at review.

The review rule is the other half. *What gets cut* deletes any line for which a zero-context executor
still picks the right files and verification still catches a wrong result. A line may be ADDED only
by naming the specific wrong execution it prevents AND deleting at least as many lower-value lines —
so "please add more detail" is refused by the document itself.

The headings are LITERAL, and that is a tool contract rather than a style note: kit **6.0.0**'s
`grounding --plan` extracts by exact match, and it now requires exactly the three canon sections it
grounds. A plan written to the old shape STOPs there — not because `## Approach` is present (a
section the canon does not name is simply never sliced) but because `## Goal and boundary` and
`## Module ledger` are absent, and the refusal names the missing heading. The `optional` arm of the
slicer went with the optional heading: a section the canon does not name cannot be sliced, and one
it does name cannot be absent.

**Both engine and kit take a MAJOR, and the family's own precedents are what decided it.** An input
that exited 0 exits 1 now, with no deprecation window and no alias — the shape kit already sized
MAJOR twice (4.0.0, a receipt no longer accepted; 5.0.0, a `--check` that silently passed and now
refuses), and the converse case is on record too: 5.6.0 stayed a MINOR *because* it kept the old
field as an alias. On the engine side, 2.0.0 had already taken a MAJOR for a documents-only canon
rewrite that deleted a vocabulary, and this rewrite deletes two skeleton headings and the whole
Plan → Phase → Step → Substep vocabulary. The sizing was put to both review backends and to a third
independent reader; all three returned MAJOR / MAJOR / PATCH, and memory stays a PATCH because
nothing in it refuses anything it used to accept.

`procedures.md` went from 137 to 87 lines and from 10427 to 5768 bytes, back under `planning.md` as
its own long-standing assertion requires — every restated planning rule cut to a pointer. Those
pointers now name planning sections by heading, because `planning.md` has no numbered sections and
the old `§4/§6/§7/§8/§9` references had been pointing at moved or deleted text. A test checks that
each named anchor is a live heading and that no `§N` pointer survives, which is the guard that would
have caught the dangling numbers before a reader did.

## 2026-08-20 — AD-103 the record vocabulary becomes a facade over five leaves (kit 5.11.2; memory 4.5.1, engine 2.1.0, codex-cli-bridge 3.5.0 and antigravity-cli-bridge 5.3.0 measured unchanged)

One thing rides this train: tranche 3 of the source-size cleanup campaign. `flow-record.mjs` was the
family's most expensive module to read — 795 lines, 13 measured reads — and it was pure form all the
way down, with eleven of its own section rules already marking where it wanted to be cut. It keeps
its path and its 29 export names, all 30 import sites stay exactly as they were, and it becomes a
55-line re-export facade over `flow-vocabulary.mjs` (96), `flow-record-shape.mjs` (283),
`flow-record-identity.mjs` (115), `flow-legality.mjs` (248) and `flow-finding-manifest.mjs` (70).
Nothing on the public surface moved, which is why a split this large is a PATCH.

Tranche 2 proved its conservation by line multiset. A multiset cannot see a reordering, so this one
proves both: per leaf, the normalised line SEQUENCE must equal the concatenation of its declared
source ranges in declared order, and over the union the multiset must equal the pre-split module.
Across the 587 executable lines both differences came back empty — and because a comparator nobody
tested is a claim about a script rather than about the code, it was run three more times: against the
unsplit module alone, with one leaf omitted, and with one line duplicated, so it is shown able to
report equality, loss and excess before its verdict is believed.

The other decision worth carrying forward inverts tranche 2's. There, shared one-liners were copied
into each leaf. Here the five shared names are the record family's grammars — `isHex64`/`HEX64_RE` IS
the 64-hex digest grammar every consumer takes by reference, and `refuse` IS the shape of a refusal —
so they live once, off-surface on the lowest leaf, with the layout suite pinning that set exactly. A
copy would be the only way two of them could ever drift.

The council converged in one round, and the reason is legible: the plan named the leaves, their
source ranges and the line arithmetic before execution wrote a file, so the review had a claim to
check rather than a design to finish. One backend returned a bare `Verdict: ship` with no citation;
a bare verdict weighs nothing against a grounded one, so it was pushed into a narrow advisory consult
on its own session instead of being counted as a second opinion, and came back with six confirmations
each carrying a `file:line`.

## 2026-08-20 — AD-102 the flow store becomes a facade over five leaves, and the direct-run guard fix finally ships (kit 5.11.1, memory 4.5.1; engine 2.1.0, codex-cli-bridge 3.5.0 and antigravity-cli-bridge 5.3.0 measured unchanged)

Two halves ride this train, and only one of them is new work.

The half that is not new is a bug fix that has been finished and deliberately unpublished for a day. A
tool or script invoked through a symlink used to run nothing and exit 0, because the guard deciding
"was I run directly?" compared `import.meta.url` against `process.argv[1]` — false through a symlink,
so the module took its imported-as-a-library path, did no work, and reported success. Five of the
affected sites are declared gates. The sweep converting all 66 sites to a realpath decision was
complete on 2026-08-19, and the series it was produced by then measured its own delegation lane and
came back FAIL against a pre-registered threshold (AD-101). The named fail lane held the commits back,
which was right: a release that publishes work while the measurement funding it says FAIL is a silent
pass in release clothing. What the fail lane never said was that the bug should stay live on every
deployed host. It ships here, on the next regular train, as the plain bug fix it is — and the wave's
verdict stays FAIL as printed, re-measured by nothing.

The new half is the second tranche of the source-size cleanup campaign. `flow-store.mjs` was 827 lines
carrying seven responsibilities behind one path, and 23 measured reads paid for that every time
someone opened it. It keeps its path, its 29 export names and all 22 of its import sites, and becomes a
50-line re-export facade over five leaves with one responsibility each and one-way edges — the pure
chain-state walk, the pure subset budget, the single write door, the adoption mint and the
bookkeeping-delta custody proof. Nothing on the public surface moved, which is why a split this large
is a PATCH.

The interesting part is what makes that claim checkable. A line-multiset conservation check compares
the pre-split module against the union of the five leaves and expects exactly two lines to have gained
a copy; it was then run twice more — against the unsplit module alone, and with one leaf deliberately
omitted — so a comparator that cannot report loss could not pass for one that does. The three owning
suites stay byte-identical and reproduce 169/169. A new layout suite pins the frozen surface, that
every facade name is the SAME binding as its leaf's export, that the facade carries no logic at all,
the size caps, and the one-way import direction including its negative edges. The recorded debt for
`flow-store.mjs` is gone rather than moved: 827 to none.

One process finding is worth carrying out of this release. The plan prescribed
`git diff --quiet BASE..HEAD -- <dir>` to decide which packages bump — and in this harness that call
returned exit 0 on a directory `git diff --stat` proves carries 47 changed files, while
`merge-base --is-ancestor`'s exit 1 surfaced normally in the same batch. Read literally, the probe
would have published the kit at its old version. The measurement moved to `git diff --name-only`,
whose answer is stdout rather than an exit code. A probe that fails OPEN is worse than one that
refuses.

## 2026-08-19 — AD-100 the fan-out half: routing that advises and never gates, a satellite that starts oriented, and a handoff that comes back delivered (kit 5.11.0; memory 4.5.0, engine 2.1.0, codex-cli-bridge 3.5.0 and antigravity-cli-bridge 5.3.0 unchanged)

The delegation series had already shipped what a delegated thread RECORDS — the sub-task contract, the
ledger, the end-to-end dispatch lane. What it had not shipped were the two questions on either side of
that thread, and both were being answered from memory. Before a sub-task: which vehicle should carry
it, and is that vehicle even present on this machine. After one that ran in a worktree satellite:
nothing composed the prompt the satellite starts from, and its handoff back into MAIN was a convention
with no rung at all — nothing read it, nothing delivered what it held, nothing counted what it bought.

`dispatch advise` now answers the first one at the point of use, and prints the same block as a footer
on any form-valid `dispatch check`. The design constraint that shaped it is that it must never be able
to decide: `check`'s exit code and first line are byte-identical whether the advised vehicle is there
or not, and an invalid contract still shows only its first violated field. Capability is read off the
filesystem: the advisor module itself spawns nothing, and the verb's only subprocesses are read-only
git probes for the repository top-level and the delegation store path — never a vehicle, never a
subscription CLI, never anything that writes. Which means the honest answer is sometimes "I do not
know" — so the agent lane distinguishes *missing* from *unanchored* (no repository root resolved, and a file found
here proves nothing against a nested shadow copy) from *probe-error*, rather than reporting all three
as absence. Recorded history comes through the ledger's existing door over a closed state set, and an
absent or unreadable store degrades to a named line while the advice still prints.

The other half is the satellite's round trip. `worktrees prompt <slug>` composes the cold-start prompt
— and `provision` now ends its report with it — carrying the branch, the seeded plan, where the shared
series index lives, that landing runs from MAIN, and that the handoff is the one channel back. Every
value is derived LIVE rather than replayed out of the provision record, because a moved MAIN would
otherwise put a stale runnable command in front of a fresh session; a recorded value that no longer
matches is named beside the live one. Commands are attributed `MAIN $` or `HERE $`, since the landing
command mutates MAIN — exactly what the satellite is forbidden to do — while a dependency-bearing
checkout's install command runs HERE, and an unattributed `$` line read as an instruction to whoever
held the prompt.

`dispatch handoff-return` closes the loop. It delivers every user-owned fragment of the handoff byte
verbatim with its byte lengths, names the MAIN-owned files that content folds into, and only then
proves the window it is measuring: an unchanged HEAD plus a staged tree equal to the recorded
`prepared-tree`, re-attested immediately before either answer. One fact was not enough — a clean
post-commit index reproduces the committed tree — so `land --prepare` now records MAIN's HEAD as well,
and a record from an earlier kit refuses by name. The observation it appends is recorded wholly or not
at all: the numerator is the attested tree's blob bytes, and a deletion, a rename's absent old side, a
symlink, a submodule, a non-UTF-8 path name or a mode-only change each produce a NAMED non-record at
exit 0. A number that silently dropped the deletions half of a landing would be worse than no number.

Riding along, the fix that had to land before any of it could be committed: evidence minted on a clean
tree binds the empty-payload fingerprint, the one value every clean moment of every repository shares,
and the correlation rung had resolved it to nineteen distinct bases and failed closed forever —
blocking every commit through `commit-guard`. The two rungs that had failed closed — the `#65` red
correlation and the `#64` degrade ordering — now step over content-free records and record the step,
and the guard splits its clean-tree lanes by the INDEX instead of the payload: a dirty index means
staged bytes the fingerprint cannot see and refuses with the git configuration named as the recovery,
while a clean one skips the RECEIPT arms and passes, stating plainly that it attests nothing. That
pass is scoped, not blanket — an unreadable evidence store and a flow refusal still stop the commit
there, which is exactly what they are for.

## 2026-08-17 — AD-098 the agy review reads the CLI's own envelope, and the schema half of the opportunity is measured and refused (kit 5.10.0, antigravity-cli-bridge 5.3.0, memory 4.5.0; engine 2.1.0 and codex-cli-bridge 3.5.0 unchanged)

The queued opportunity said structured output would let the review stop parsing prose for its
verdict. Probing the installed CLI inverted that: the envelope is worth adopting, the schema is worth
refusing. `--output-format json` returns one object carrying the model's Markdown verbatim plus a
first-class `conversation_id`, at one turn. `--json-schema` is not a constrained decode at all — the
model answers in prose and the CLI spends a **second** turn asking it to restate that answer in
schema shape. Measured on the same prompt and the same model, schema off vs on: **16,585 vs 33,446
total tokens**, with the structured reason coming back reworded rather than quoted. A schema would
therefore replace a free, deterministic regex with a billed non-deterministic re-read, and add a
failure mode where a run dies between the two turns.

So the envelope was adopted as **transport** and the review contract left prose-shaped. Every
dispatch — single, resume, each turn of a chunked feed — now runs in JSON and the wrapper reads named
fields, while the delivery-proof echo, the section shape, the receipt and the verdict-less arm keep
their exact semantics and their tests. What that bought is the deletion of a guess: the conversation
id used to come from an awk scrape of the CLI's own run log, a format its own comment called "agy's
own to change", with a silent `--continue` fallback when the scrape failed. Both are gone, and the
id's grammar check is kept and applied to the named field.

Reading JSON in bash is a defect farm, so the parse lives in its own small module — which makes Node
a hard requirement for every review. That cost is paid back by the other half of the work: a
**pre-spend capability door** that probes what `agy --help` actually declares, checks Node, and
refuses before a single subscription turn is spent, naming the capability that is missing and what
its absence would have cost. It is a capability probe, not a version floor: the release that
introduced the flag is not measurable from one installed build, and a guessed floor would refuse
working installs.

Riding along, the shipped half of the English-only sweep: the state-block guard now ships **one**
vocabulary and enumerates no other language — a shipped phrase list is a guess about somebody else's
dialogue — with the resulting silence stated in its contract rather than hidden, and the always-loaded
rules template gains the closing state-block rule in the same shape (labels English so a checker can
find the block; values in the project's own language). Engine and the codex bridge were measured
unchanged and hold their published versions.

## 2026-08-15 — AD-096 the always-loaded navigator becomes something every deploy path actually creates (memory 4.4.0, kit 5.9.0; engine 2.1.0 and both bridges unchanged)

Every fresh deployment of this family shipped broken, quietly. The entry point it writes declares
`docs/ai/index.md` **always-loaded**, but that file is generated rather than templated — and no
bootstrap step ever ran the generator. On a Node project the damage was visible immediately in a
strange place: the pre-commit hook failed its own index check on the very first commit. On a project
without Node nothing complained at all; the entry point simply pointed at a file that would never
exist. The kit's fallback bootstrap carried an identical copy of the gap.

The fix is one idempotent finalizer rather than a seed file. `check-docs-size.mjs --ensure-index`
probes, writes only when the navigator is missing or stale, and closes with a single outcome line;
every deploy and upgrade path — the substrate's own, the kit's fallback, and the delegated
hand-off — runs it at its last `docs/ai` mutation. On upgrade it also becomes the fifth
project-configuration ensure, so a deployment that never had a navigator gains one without a lineage
bump, and the authoritative run is the LATE one, after the reconcile that rewrites `docs/ai`
underneath it.

Two things were hardened on the way, both found by review rather than planned. The navigator's write
now refuses a symlink at any level of its path and publishes through a temp-then-rename, with the
containment check ahead of the freshness read — otherwise a symlink whose target happened to hold
current bytes would be reported "already current" over a file the tool refuses to write through. And
an unreadable subtree stopped counting as an empty one: the finalizer refuses rather than publishing
an index missing whatever it could not see.

Alongside, a leak that predates this work: hidden mode's registry named 14 of the scripts a
deployment copies, and the payload is 21 — so seven were left visible in `git status` on projects
that chose to keep the footprint out of git (six that predate this work, plus the one it adds). The
registry is complete, and a test now derives it from the deploy payload so the gap cannot reopen.

## 2026-08-15 — AD-095 the catalog is whatever the installed binary says, and the facts assembler stops needing a shell (kit 5.8.0, antigravity-cli-bridge 5.2.0; memory 4.3.0, engine 2.1.0 and codex-cli-bridge 3.5.0 unchanged)

Gemini 3.7 Flash shipped, and every model surface of the agy bridge was still describing a catalog
captured from CLI v1.0.13 — while the installed binary had moved to 1.1.13. That is not a stale
paragraph: a display string is matched exactly, so the wrong one refuses a dispatch before it
spends anything. The fix is the discipline rather than the edit — every catalog row and default
pin a user can copy was read off `agy models` on the live binary, which is also how a `Gemini 3.6
Flash` family nobody had announced turned up, and how 3.5 Flash was confirmed still served rather
than assumed retired.

`Gemini 3.7 Flash (High)` becomes the default for both bridge roles and joins the review wrapper's
frontier set — the maintainer's explicit call, because council-review models are a line that only
moves deliberately. The catalog lists each served tier as its own copy-pasteable row. And the
reference stops overclaiming: 1.1.13 adds structured output and an effort flag, the wrapper adopts
neither, so the docs say text-default and name the passthrough that rides without validation.

Riding with it, a queued kit fix that had been overdue four times: `grounding.mjs --extra
<text|@file>`. Appending orchestrator facts to an assembled review payload had been a shell append
on the same pipeline step in four consecutive sessions, which is a missing tool input rather than a
lapse of discipline. Extras now merge inside the tool, byte-verbatim, through a fail-closed read
surface — a proven work tree or the system temp surface, never the git dir, read through a
descriptor that a FIFO cannot block and a symlink cannot redirect.

## 2026-08-14 — AD-092 + AD-093 + AD-094 the feedback-hardening series: emitted things are executed, claims are proven, and a shipping kit is gated against the published one (kit 5.7.0, memory 4.3.0; engine 2.1.0, codex-cli-bridge 3.5.0 and antigravity-cli-bridge 5.1.1 unchanged)

Seven items of feedback from one live upgrade session on a deployed TypeScript project, and every
one was the same defect at a different surface: the kit EMITTED something — a shell command, a
status line, a prescribed operation, an optimality verdict — and nothing downstream ever ran it,
proved it, or performed it. The emitted coverage command wrote its lcov to the filesystem root when
its variable was unset, because every test asserted on the string and none executed it. The
read-only refresh told users the tree "may be PARTIALLY updated" without having checked. Upgrade
step 3 prescribed four state-changing writes as prose done slightly differently every session. And
the advisor attested "flow optimal" over a tree whose primary sources its coverage domain could not
even see.

The series answer, shipped as one release: the emitted command refuses by name
(`"${AW_GIT_DIR:?…}"`) and is a fixture the tests EXECUTE; recognition of previously emitted forms
is append-only, so no deployed gate is reclassified by an upgrade; degrade lines bind clause by
clause to what a re-scan proved; the four ensures are one runnable command with a closed outcome
vocabulary; upgrade step 3 is a registry-owned run-list a structure test holds against the doc; the
optimality verdict gained named third outcomes gated on a tracked-tree census, an `lcovProducer`
marker for runners the closed cmd-world cannot name, and a preserved — not upgrade-stopping — path
for a vendored copy of a core check.

And the release lane itself learned the lesson: a kit-carrying dispatch — dry-run included — now
refuses without TWO HEAD-bound receipts. The candidate smoke proves the packed candidate against a
foreign fixture this repo's own suite cannot represent; the new cross-version gate installs the
PUBLISHED kit and asserts the three Issue-016 axes by name (`schema-accept` / `execution` /
`producer-recognition`), with the marker arm decided against `MARKER_AWARE_SINCE = 5.7.0` — from
this release on, the first marker-aware kit version is a constant, not a memory.

## 2026-08-12 — AD-091 the source-size practice: a declared cap, and a record that is debt rather than permission (kit 5.6.0, engine 2.1.0; memory 4.2.0, codex-cli-bridge 3.5.0 and antigravity-cli-bridge 5.1.1 unchanged)

The kit taught module granularity nowhere and enforced it nowhere, and its own tree was the evidence:
of the 194 `.mjs` files under `agent-workflow-kit/tools` and `agent-workflow-memory` measured on
2026-08-10, 112 sat above 300 lines, 70 above 500 and 39 above 800. This release ships the practice
that answers it — and it ships honestly. The goal is MAINTAINABILITY, not context economy: a split
does not by itself demonstrate a lower session-context cost, and that claim stays unavailable until
somebody measures it.

The checker refuses rather than assumes. Scope is DECLARED — your roots, your extensions, your
exclusions — because a default file-type list would silently exempt every language it forgot. With
no config it prints the exact file to author and a template whose placeholders the validator itself
rejects until replaced, so the starting point can never be pasted into a scope that matches nothing
and passes green. An unmerged index, a filename that is not valid UTF-8, an unreadable file, an empty
declared scope: refusals, every one, because a check that cannot judge the tree must not report that
the tree is fine.

What makes it adoptable on a real codebase is that a recorded size is DEBT, not permission. Adopting
records today's oversized files instead of demanding a refactor nobody planned; from then on the
record may not grow without a written reason, may not sit above what the tree measures, and may not
outlive the violation it records. Each declared root carries the same ratchet over its summed lines,
so splitting one big file into six buys no headroom at all. Every ratchet refusal is one you can
serve yourself: a tighten prints the command exactly as it should be pasted, a growth prints it as a
template with the reason placeholder and states the requirement, and on a path that would not survive
quoting nothing is rendered — the parameters and the manual lane are stated instead.

The cap is the backstop; the knowledge is upstream. The plan-authoring and plan-execution renders now
print the declared caps and the reason they exist, and engine canon asks every Step that creates a
file to name that file and its single responsibility — fitting the declared cap **where one is
declared**, and inventing none where it is not. That is where the canon now asks for the layout, on
its own stated rationale: a gate that refuses an oversized file after it is written only pays for a
rewrite.

**Campaign tranche 1, recorded here because the record is the point.** `flow-check.mjs` became a
254-line facade over two pure decision modules and a git-I/O leaf, behaviour and declared gate
command unchanged. The regeneration that followed carries the verbatim reason
**`tranche 1: flow-check split`**, and the exact old → new delta it recorded:

- `agent-workflow-kit/test/package-content.test.mjs`: lines **453 → 467** (raise)
- `agent-workflow-kit/tools/flow-check.mjs`: lines **842 → none**
- `agent-workflow-kit` aggregate: lines **111102 → 111234** (raise)

A split COSTS lines — four module headers where there was one — and the aggregate is what says so out
loud instead of letting the cost hide. That is the whole argument for budgeting the sum as well as
the file. The remaining violators are a declared campaign, one module per tranche, riding regular
release trains.

## 2026-08-11 — AD-090 delegating a sub-task becomes a record (kit 5.5.0, codex-cli-bridge 3.5.0, antigravity-cli-bridge 5.1.1; memory 4.2.0 and engine 2.0.0 unchanged)

The family could delegate work and could not account for it. A task went out, something came back,
and whether the handoff paid for itself was decided from memory — because nothing wrote it down.
This release closes that: a delegated run now claims an identity BEFORE it spends anything, carries a
deadline the ledger owns rather than the process, and comes back through a door that would rather
refuse than record a number it cannot stand behind.

The split follows what each side can prove. The bridge wrapper is dependency-free bash with no path
to the kit, so it mints the one thing it can prove — a receipt beside the ledger, reserved before the
spend and finished at exit, with the delegate's report published first so anything that arrives has a
complete report behind it. The kit absorbs that through its single existing append door and adds no
second rulebook: four new writer verbs assemble records and pass the store's refusals through
verbatim, and a fifth only waits and reads.

`dispatch await` is the piece that changes how a session behaves. It waits for ONE dispatch to
answer, and when the wait ends without one it exits with its own status, names whether the deadline
or your own bound ended it, and states that no writer slot was released. A timed-out wait had always
been the moment a session quietly decided it could move on; now it is a question with a name.

The numbers are deliberately hard to inflate. The two sides of the ratio are different byte
quantities — the numerator sums the image bytes of the returned objects, the denominator is the
framed bundle of the change set's payload and its report — and what binds them is not one buffer but
one observable change set: the same HEAD→index→worktree domain, bracketed by digests that refuse
when drift is detectable. A dirty starting tree makes the result INELIGIBLE by name rather than
counted; a change set the shared fingerprint cannot follow — a binary, a non-regular path, a
submodule — is refused outright at both doors. `aggregate` refuses to compute over an unfinished
thread, an unregistered wave or a recorded refusal-to-delegate. The instrument ships here; measuring
with it is the next plan's job, and the acceptance wave is deliberately still empty.

Each wrapper that stamps a version into a receipt now declares it on one marked line, and every other
`AW_BRIDGE_VERSION=` or `+=` token in a shipped wrapper is refused by the version-sync verifier —
with the forms it deliberately does not model (an array-element setter, a spaced arithmetic
assignment, an eval-constructed name among them) stated rather than implied. agy's wrapper gains only that marker, hence its
PATCH; codex's gains the dispatch identity. Proven live twice against the real CLI before shipping,
including one run that proved the seam and NOT the work and was closed by a recorded degrade rather
than counted.

## 2026-08-09 — AD-089 a check that certifies nothing now says so (kit 5.4.0, memory 4.2.0, codex-cli-bridge 3.4.1; engine 2.0.0 unchanged)

A field report against 5.3.0 turned out to describe something the kit was building itself. Neither
declaration path ever wired a coverage PRODUCER, yet both declared the coverage CHECKER — so a
project could come out of `init` or `upgrade` with a matrix that prints three `PASS`,
`lcov-sha256=none`, `attested=yes`, `status=ok` and exits 0 while certifying nothing at all. The
honest signal was there, on one inner line, and it reached no surface anyone keys on.

Neither kit-owned path adds one any more. `gates-init` withholds the checker, and refuses at write
time on the declaration that actually gets WRITTEN rather than on the offer — the offer-level check
alone still let `--only coverage-check`, a late-arriving producer and a second checker under another
id through. `migrate-gates` — the memory substrate's own upgrade path, which is why memory ships
4.2.0 here — stops adding one, and reports an already-declared inert pair instead of quietly
removing it. A pair declared by hand stays declared, and `--final` acceptance did not move.
Recognising a producer is a closed set of the command forms the kit itself emits, with a positive
path-shaped tail rule, because `… && rm -f <lcov>` runs the suite and then deletes the file.

The withheld verdict now travels. `attested=` binds to the bytes actually consumed and states that a
verdict was ISSUED — pass or fail — so a handshake over uncovered lines still reads `yes` and still
exits 1. A new closed `coverage=` field rides the machine summary line with one value defined for
every run outcome, the `--final` receipt records it, and `core-evidence summary` renders the
qualifier from that record instead of guessing from a hash that only ever said what a receipt binds.
Nothing gained a state: exit codes, `status=`, the receipt enum, `--final` acceptance and the commit
guard are all untouched, so an optional-coverage project never goes red by surprise.

The advisor reports the inert matrix under two causes with two remedies — the one that needs
reordering stays hand-applied, since the fill is append-only. And every runtime claim the autonomy
render makes about a settings key became conditional on the host honouring it. That was the second
half of the report: three surfaces promised the bridge wrappers run outside the sandbox while this
kit's own mode doc records, from live observation, that honouring is runtime-unknowable. Someone
applied the advisor's own item and lost both review backends.

## 2026-08-08 — AD-088 a check must speak where it is built to speak: the two silent checks (kit 5.3.0, codex-cli-bridge 3.4.0; memory 4.1.0 and engine 2.0.0 unchanged)

Two shipped checks stayed quiet at exactly the point they exist to speak — one a GATE that refuses
and blocks a commit, one a WARNING that never changes an exit status — and they were the same
sentence, so they ship together.

The `flow-check` gate demanded a receipt its own run had not written yet: a red final on the
current base cleared only through a LATER completed retry, while `run-gates` appends the final
receipt only after every gate has run. Each `--final` on an unchanged base therefore minted the
next red, no number of rerun-causes converged, and the only way out was a hook bypass. The rung is
now consumer-aware — the same lane split the flow→final comparison already used one arm away — so
inside a real final run a red is answered by a provable in-progress retry, while a standalone check
on a quiet tree still refuses and the commit boundary keeps its strict demand unchanged.

`codex-exec` had a nested-sandbox detector but ran it only when the run FAILED. A delegated run
that survives the failure — degrades to "I cannot check" and exits 0 — spent a paid run and handed
back an ungrounded answer with nothing saying so. Fresh runs and resumes now share one capture
posture, so the resume lane finally has a structured per-item evidence surface: its stderr was
already captured, but the JSON event stream, where a tool call's own failure is visible, went
nowhere. The scan then runs on every completed run under two honest policies — the failed arm keeps
its loose rule, and the successful arm warns only when the scanner recognises the expected per-item
shape, biased toward under-firing on ambiguous or schema-drifted input. The answer still prints
first and the exit status still stays 0: a heuristic scan must never gain the power to refuse real
work.

## 2026-08-07 — AD-087 the ADR rotation stops orphaning inbound anchors (memory 4.1.0; kit 5.2.0 and engine 2.0.0 unchanged)

The decisions rotator moved ADR blocks out of the HOT window while every `decisions.md#ad-NNN…`
link elsewhere in a deployment's `docs/ai/` kept pointing at the vanished heading — and no mode,
`--check` and `--dry-run` included, ever looked. A deployed project measured 114 inbound anchors
exposed to that break and raised its HOT cap twice so the rotation would never run: the feature
protected itself out of use.

Memory 4.1.0 makes the crossing carry its links. Rotate and migrate rewrite the inbound anchors
to the per-record `adr/` files (fragment preserved for HOT links, monolith-form targets computed
relative to each linking file) under a conservation invariant that verifies the whole rewrite
set before the first write, with the cross-file write order pinned so an interrupted run always
re-runs to completion. `--dry-run` prints the rewrite set, `--check` now fails loudly with
`file:line` on any anchor the store no longer resolves, and links inside the ADR corpus itself
refuse pre-write instead of being rewritten. Kit and engine are untouched; the kit's script
mirror rides its next release.

## 2026-08-06 — AD-086 the N+1 flow wave ships whole, and this repo releases under its own armed flow (kit 5.2.0, codex-bridge 3.3.0, agy-bridge 5.1.0)

Everything the flow-orchestration series built after the tolerance release publishes as one wave:
the flow store and its chain identity, the review-round machinery (`round-open`/`round-land`/
`freeze`/`converged` and their caps), the recorded subset-attempt budget under an armed
`--pre-review`, and the final-record flow binding the commit guard now enforces. Two supporting
moves ride the same wave: the receipts reader stops following symlinks (a flagged security fix —
four consumers now refuse loudly instead of reading through), and both review wrappers gain an
additive `--nonce` flag so a dispatch nonce can travel as a plain argument on hosts whose dispatch
policy has no environment-prefix lane; a nonce-less invocation adds no nonce field and mints no
manifest (the `wrapperVersion` field every receipt carries moves with the release).

The release itself is the proof: a permanent hermetic fixture drives the whole pipeline through
the real CLIs, and this repo was ARMED before publishing — the wave's own release cycle ran as the
first live armed flow, its council rounds nonce-bound in the store and its release `--final`
carrying the flow hash the guard checked at the commit. Cross-version safety was proven against
released bytes, not assumptions: the 5.1.0 validator (from a `4b08ace` worktree) accepts a
flow-bearing final, and the new validator accepts a field-less one.

## 2026-07-29 — AD-085 the flow rollout starts with tolerance, not features (kit 5.1.0)

The converged orchestration-flow design will add a `flow` block to the shared
`docs/ai/orchestration.json`. That file is a wire protocol between kit versions: the validator is
strict, so a kit that has never heard of the key fails the whole config load loudly and every gate
on that collaborator's machine goes red. The safe order is therefore fixed before any feature
ships: first a release every collaborator can upgrade to that tolerates the block, only later the
writer that puts one into a config.

Kit 5.1.0 is that release. It accepts a versioned `"flow"` object (numeric `"schema": 1`),
interprets nothing inside it, and changes no behaviour for any existing config. The one thing it
adds beyond tolerance is honesty about what it does NOT do: it carries no version floor against
older readers, and that admission ships as an exported sentence the doc-parity gate pins into the
mode doc, so the wording cannot drift while the gap is real. Enforcement arms with the `set-flow`
writer in a later release; the floor mechanics it will lean on are characterized green now, and
the characterization already caught a `null >= 0` coercion trap the arming check must guard.

## 2026-07-29 — AD-084 the archivers stop reporting green on files they did not understand (memory 4.0.0, kit 5.0.0)

The rolling-window archivers — the changelog, known-issues and decisions rotators every deployed
project runs as gates — used to fail OPEN: a file they parsed nothing from earned a green `OK`.
One real deployment's changelog gate passed 36 consecutive sessions without parsing a single
entry, and this repo's own issues file sat one line under its cap because the drain had never
once recognised a real resolution marker.

Both packages go MAJOR because the fix is a findings-contract change: a `--check` that silently
passed can now refuse — with `file:line`, the offending text, and the remedy in the message. All
three archivers now read through one shared markdown tokenizer (fences, frontmatter, CRLF, loud
unclosed-fence errors), recognise the resolution-marker shapes real files actually use, refuse
recognisable-but-malformed input instead of guessing, and rewrite files verbatim under a
conservation guard — category headings and the closing footer can no longer be carried into an
archive by a rotation. Engine is untouched and byte-identical.

## 2026-07-28 — AD-083 the ADR-store migration finds the projects that could never hear about it (kit 4.5.0, memory 3.2.0)

The one-file-per-ADR migration has worked since AD-051. It could not be *reached* by an entire class
of projects: the old-layout check keyed on a retired archive file being on disk, so a project whose
decisions file never grew big enough to roll one over was reported as having nothing to do — and the
migration tool greeted it as «a fresh new-scheme tree». Its own pre-commit check agreed, printing
«OK — every tier is within its cap» about a layout that no longer exists.

The check now reads the rotation script the project actually deploys, which either knows about the
store or does not. That is a fact about the tree rather than an inference from filenames, and it
deliberately stays silent for the two groups the obvious heuristic would have accused wrongly. The
migration gained the matching arm and, more importantly, can now be re-run to completion after any
interruption — a store folder on its own is no longer mistaken for a finished job. `upgrade` stops
reporting «flow optimal» to a project sitting on the retired layout, through a recommendation whose
runnable half is the preview and never the migration itself.

Memory ships the piece that makes the preview honest: the rotation can now be asked whether seeding
would succeed, running exactly the checks the real write runs and touching nothing.

## 2026-07-28 — AD-082 the guard stops charging you for answers it already has (kit 4.4.0)

For two months a guard rung that DENIES instead of asking looked like the answer to a growing corpus
of avoidable approval prompts. It was designed, reviewed and withdrawn twice, and the reason is worth
recording: a command substitution embeds an arbitrary command **without any separator byte**, so
`node …/repo-search.mjs --pattern-file $(git commit -am wip >out)` slips past every "is this a single
command" test and a refusal there destroys work it never meant to touch. Both review backends found
that independently, in the same round. The guard still never denies.

**What closed the gap instead was the channel nobody had checked.** Every deny design existed for one
reason: a deny is the only hook outcome that reaches the *agent*. An allow is silent, and an ask is
answered by the human whose dialog the agent never sees. `additionalContext` on `PreToolUse` is that
same channel with no refusal — probed live here with a throwaway hook and a distinct marker per
variant, delivered on `allow`, on no decision, and on `ask`. Both residual rungs now carry it, so an
ask names the promptless lane to the agent that composed the command. A host that ignores the field
degrades to silence, which is precisely the old behaviour: the withdrawn mechanisms had to be RIGHT
about a command's bytes, this one only has to be USEFUL.

**Two lanes ship with it**, because the corpus's own evidence is that the shell gets composed when no
single call answers the question: `path-inventory.mjs` (existence, type, size, `wc -l` lines,
one-level listing, small-file contents for N paths in ONE call — and a missing path is a RESULT, not
an error), and `repo-search.mjs --paths-file` (the TARGET half of the out-of-band lane the pattern
half already had). Promptlessness needs a re-run of `velocity --kit-tools`: allow rules are values
already in your settings, and upgrading the kit does not edit them.

Honest ceiling, stated rather than implied: this makes the promptless path the cheapest path. It does
not make a composed shell impossible.

## 2026-07-27 — AD-081 the coverage gate stops certifying evidence that predates your edit (kit 4.3.0)

`coverage-check --check` read whatever LCOV sat at the fixed path and issued a verdict, with nothing
tying that artifact to the tree it judged. Seen live during the AD-080 release in the harmless
direction — an identical failure list and an identical sha after tests were added — and reproduced
hermetically in the dangerous one: attest three lines, append one the suite never ran, and the
checker prints `PASS`. LCOV has no executability signal, so a line that did not exist at suite time
reads as nothing to cover.

The gap was visible inside a single runner: `review-state` failed loudly on its own staleness while
`coverage-check` passed judgment silently, in the same `--final` run.

**Two designs were built and withdrawn** under a stop rule declared to the reviewers before the round
that met it — a stamp sidecar (killed by the runner's own "writes nothing on a plain run" boundary)
and attestation from a dangling start record (both backends independently produced the same
counterexample: a record about a RUN cannot attest an ARTIFACT). What shipped is smaller than either:
`--final` mints a nonce whose one-way commitment over `{nonce, fingerprint, base}` IS the attempt id
it already recorded, and the checker certifies only when it can recompute it. No new artifact, no
schema change, no migration.

Outside that run the checker reports and states `NO VERDICT`; a context describing another tree is a
refusal. Findings are unchanged — uncovered lines still exit 1, listed `file:line` — so this is a
minor release. Deliberately left open and named: the base commit is persisted nowhere, so
`commit-guard` stays fingerprint-only.

## 2026-07-27 — AD-080 a search whose pattern contains `>` no longer has to ask (kit 4.2.0)

4.1.0 established that the guard cannot be narrowed. This release stops sending the search through
the guard instead. The corpus stood at 31 firings, two of them minutes apart during unrelated
research: one a reflexive `2>/dev/null`, one a `>` sitting inside a quoted search pattern.

**The fix turned out to be small, and the fact enabling it had been in the previous session's
handover the whole time**: the residual scan is gated on seeded-core membership, so a command outside
that core never reaches it. A plain kit tool therefore cannot raise the residual ask, whatever bytes
its arguments carry. Two full design-council rounds went to an MCP-server proposal that was not
needed before a reviewing bridge cited the code.

**Shipped: `tools/repo-search.mjs`**, literal search, two lanes — `--pattern` for ordinary patterns,
`--pattern-file` for byte-carrying ones, whose bytes never enter the command string. The tool's
prefix also joins the hook's scanned list, so a real redirection or substitution on its own
invocation still asks — coverage GAINED, since a non-core command had none. Picking the wrong lane
earns a refusal that names the right one, which is why the rule does not rest on the agent
remembering it.

**Stated residuals:** a bare `grep` still prompts (nothing forces the lane); a literal inline `$(`
stays indistinguishable from an active one, permanently; bytes in search paths still over-ask; and
promptlessness rests on the allow rule, because "no decision" is not "allow".

## 2026-07-27 — AD-079 why the gate hook still over-asks, established rather than assumed (kit 4.1.0)

Twenty-nine times the maintainer approved a command that never needed approving, and for months the
cause was misattributed to the agent that wrote the command. Two live probes settled it: a command
outside the hook's frozen core, wearing the exact decoration from the corpus, ran silently — and so
did the same command redirecting into a real file. The hook cannot fire on a non-core command, so
only the harness decided those calls, and it did not ask. **The prompts were the hook's own.**

**Three mechanisms were BUILT to stop it and none shipped**, each removed on a rule declared before
the round that met it; a fourth direction never got built. Deleting the redirection class outright —
rejected at PLAN review, because the kit's own velocity profile seeds the allowlist that turns a
redirect on `cat` into a silent write, so the guard closes a hole the kit itself opens, and every
pre-existing test would have had to go. A quote-aware reading — one quote in each of two heredoc
bodies opens and later closes a spurious span across the `$(…)` between them, so the walker ends
balanced, never falls back, and the guard goes silent on a nested command. An fd-duplication
exemption — `grep x f >&12file` writes the file `12file` and slipped
through a pattern with no token boundary. A null-device exemption, boundary included — JavaScript's
`\s` counts U+00A0 as a word boundary and bash does not, so a no-break space turns `/dev/null` into
an ordinary filename and the span was deleted anyway. Every counterexample was verified live and
ships as a test.

**The finding is the deliverable:** this hook cannot decide what a redirection byte MEANS — not by
parsing it, and not even by deleting it — because JavaScript's token boundaries and bash's disagree.
On an ASK rung that costs a prompt, which is safe, and it is exactly why the same scan must never
become a DENY. **The deny direction is retired**: a refusal cannot remove a prompt the hook itself
raises. What ships as behaviour is one line — `>(…)` named in the class it belongs to.

## 2026-07-26 — AD-078 a large change set is delivered, and its delivery is proven (agy 5.0.0 · codex 3.2.0 · kit 4.0.0)

An oversized `agy-review code` used to have two honest outcomes and one dishonest one. The dishonest
one shipped findings: two BLOCKING items citing lines 612–767 of a 322-line file and functions that
exist nowhere, delivered as an ordinary REWORK verdict with `file:line` citations. The lane that
produced it pointed the model at a staging file and asked it to read it — and on a headless host that
read is auto-denied, so it could return an invention or an empty SHIP with no way to tell which.

The change set is now **delivered, not fetched**: cut at line boundaries into under-cap parts, fed
over continuation turns, reviewed in a final one. Only the bodies concatenate — byte-for-byte — so
nothing the wrapper adds ever enters the reviewed artifact. And delivery is **proven**: the wrapper
picks one interior line per part after assembly and asks for it *by address only*; the answer must
reproduce each line verbatim in a proof section that comes first, so output truncation cannot drop
it. A missing, duplicated, unrequested or mismatched echo is a failed review — no receipt.

`AGY_REVIEW_ALLOW_ADDDIR` is retired: still recognized so an existing settings line never warns as
unknown, but it arms nothing, and the advisor no longer offers it. Receipts now declare how the code
arrived, so a receipt minted by the old lane stops attesting — **re-run the review**; because that
incompatibility is created by the kit's READER, the kit takes the MAJOR alone.

**The cost model changes too:** an oversized review used to refuse and spend nothing, and now spends
**N+1 subscription turns** — announced on stderr before the first one, and refused outright when the
feed would exceed `AGY_REVIEW_MAX_TOTAL_BYTES` (default 240000). The repo file map — measured at
28,735 bytes in this repository, 24% of the prompt budget, growing with repo size rather than change
size — is now bounded to 8192 bytes for `agy`, degrading to the changed-path subset with a stated
count of what it omitted.

Two live limits are recorded rather than assumed: context retention was probed at 262,967 bytes, and
at ~320,000 the final turn was lost twice to a tool the host denies — which is exactly what the
shipped 240,000-byte ceiling refuses before spending anything.

The kit also ships `review-lens`, a read-only review subagent with **no shell**: a read-only fan-out
on a full-tool vehicle shells out for facts it could have read, and each command is an approval prompt
nobody needed.

A deny rung for the gate hook was built during this release and **removed before it shipped** — and
that is the honest outcome, not a footnote. Six times while building this, an agent's reflexive
`grep … 2>/dev/null` became an approval prompt for the maintainer. The rung would have refused only
reads that provably discard their output, on the argument that such a refusal destroys nothing. The
argument was fine; the byte-level proof was not. Three review rounds found five shell constructs that
slipped through it — an fd dup that routes output back out of `/dev/null`, a quoted literal, a
leading-token-only match that hid `&& npm test`, a bare `&`, and a `#` comment — each of them a false
refusal of real work. On an *ask* rung an incomplete scan just over-asks; on a *deny* rung the same gap
blocks something legitimate, and telling an operator from ordinary text means lexing the shell, which
this hook deliberately does not do. The hook still never denies, the counterexamples are kept as the
spec for a future attempt, and the prompt remains.

## 2026-07-26 — AD-076 a shipped opt-in now advertises itself (kit 3.15.0)

`upgrade` and `recommendations` now offer the closing-block detector that 3.14.0 shipped. They did
not: 3.14.0 added it with a mode doc, a catalog row and a README row — every surface an agent reads —
and no advisor entry, so a user who installed the update was told «nothing is broken — process is
optimal» while the new capability sat unwired and unmentioned.

The item fires when no `Stop` hook runs the detector's runtime and points at the mode doc for the
exact wiring block. Matched on the runtime file name, not an exact command: with no writer every user
pastes their own path.

Why it was invited rather than merely missed: every other surface of a new mode fails a test when
omitted; the advisor is the one with no such guard, and the only one a user receives without asking.
The guard that closes that needs an accurate claim for all 28 modes and is the next slice's first
item.

## 2026-07-26 — AD-075 the closing state block gets a checker (kit 3.14.0)

An opt-in `Stop` hook now reads the turn's final assistant message and warns when the closing state
block lies about the turn that just ended: a «what I need from you» slot answering *nothing* — false
by construction, since a turn that has ended needs a resume — or a first-person promise of imminent
work in a turn that produced none.

The gap was structural, not careless: every mechanised bar in this family gates FILES, and the
closing block is chat output that no file gate can see. One contract recurred five times across
three sessions while every file-level bar held.

It is **detection, never prevention** — a `Stop` hook cannot un-send the message it judges — and the
limit is stated on every surface. The warning rides `systemMessage` on stdout, because at exit 0 a
`Stop` hook's stderr reaches the debug log and nobody else. The absent-block report is opt-in behind
`--require-block`, since this kit does not mandate the block and a hook that runs every turn must
not warn every turn. No writer ships with it; the mode doc carries a check-first wiring block and
names every residual, including the limits of a lexical layer that no further rule would close.

## 2026-07-25 — AD-074 the commit guard proves the INDEX carries the verified tree (kit 3.13.0)

`commit-guard --check` now refuses an index that lags the working tree. The gates and the tree
fingerprint both describe the WORKING tree while `git commit` builds the commit from the INDEX
alone — and against an otherwise-empty index the fingerprint is byte-identical whether a hunk sits
staged or unstaged. So a lagging index passed every gate and every guard arm, and the commit shipped
a strict subset of what was verified. It fired on this repo's own 3.12.0 release commit: a fix
landed without its regression arm, caught only by the publish dispatcher's dirty-tree refusal one
step later. The new arm runs FIRST, before the fingerprint, and names the offending paths (bounded,
safely escaped) with the complete whole-tree recovery; a dirty tracked submodule is named separately
with the only recovery that works there; an undecidable git probe refuses fail-closed. A deliberate
partial commit is now blocked by design — `git commit --no-verify` stays the stated residual and no
opt-out flag was invented. The fingerprint domain is deliberately unchanged; one shared computation
of the index↔worktree split now serves both the new arm and `isTreeClean`. Stated residual: this
makes the COMMIT capture the whole working tree, not the RECEIPT unforgeable — a config-blinded
fingerprint can still be reused after a submodule change, which is a receipt collision rather than
an under-capture, and is tracked as its own class.

## 2026-07-25 — AD-073 the resume verify proves per placed path; session work is out of scope (kit 3.12.0)

The closing slice of the resume-verify design, and the end of that series. `provision --resume`
no longer refuses a satellite you have worked in: instead of asking whether the whole tree is
clean, the verify proves the git lane of every path THIS run placed or kept — a closed, frozen
placement registry (leaf-only, kind-gated, frozen at the verify) — so uncommitted edits, untracked
scratch, renames and hook-created files are out of scope BY CONSTRUCTION rather than by
subtraction. What still refuses, fail-closed: an owned path in the untracked lane and any erroring
lane probe, each naming the exact leaf with a convergent fix (restore the ignore rule; for a
droppable `--include`, one grouped instruction to move the whole destination root out of the
worktree paired with dropping the flag) and never deriving a removal command over content the tool
cannot prove it owns. The lane probes are literal — live-probed on git 2.43, `check-ignore` refuses
pathspec magic and otherwise answers for a name that glob-matches a tracked sibling, so tracked-ness
is decided first by an explicit literal pathspec and the ignore probe runs `--no-index`. The FIRST
provision stays deliberately strict, with its untracked visibility now explicit so repo `status`
config cannot blind it. The contract ships as a live constant printed on every resume-verify STOP
and doc-parity-pinned, and the AD-071 byte-exact dirty-resume pin is retired as the design record
sanctioned.

## 2026-07-23 — AD-072 the record attests only a verified provision; tracked plans-chain paths refuse (kit 3.11.0)

Slice R1 of the converged resume-verify design. The provision record is refreshed LAST — after
the in-flight-plan check and the post-provision verify, in both lanes — so the record attests
only a VERIFIED provision: a first provision failing after the stub write leaves the stub
(identity still binds; a pre-write refusal leaves no handoff at all), a failed resume leaves
the prior record bytes byte-exact, and a refresh failure after a clean verify keeps the
worktree and names the exact re-run command. A TRACKED plans-chain path — the
handoff or the seeded plan — now refuses fail-closed in both lanes (its drift is undeliverable
at land, a manufactured dead end): the fresh lane proves both paths untracked at ONE captured
commit (the same OID the branch is cut from) and re-probes the new worktree's index and branch
HEAD before the first write (post-checkout hooks that force-add or even commit are caught);
`--resume` probes the branch HEAD tree unconditionally plus the live index before reading the
handoff identity. Recovery is surgical and kind-aware — pathspec-literal index removal,
salvage-first with consented abandon only where identity binds, plain-git removal for the
hook-poisoned fresh worktree, and NO recovery command for irregular entries. Resume tolerance
is unchanged this release (the blanket clean-tree verify stays, pinned byte-exact); the
per-owned-path tolerance flip is the next slice.

## 2026-07-23 — AD-071 install advice reads the worktree checkout (kit 3.10.0)

The provision install advice picked its package manager from MAIN's manifest and lockfiles while
its printed command targets the satellite — a dirty MAIN lockfile pushed the advice into
ambiguity or the wrong manager, and a MAIN advanced past the satellite's base steered a
satellite it no longer describes. The manager evidence (the `packageManager` field and the
lockfile scan) now reads the worktree's own live checkout — the same live lane as the
dependency-free proof and the symlink probe — so the evidence tree and the command's target tree
are the same tree. The contract ships as one pinned mode-doc sentence (a named test locks the
wording); the shipped clean-tree `--resume` STOP is pinned byte-exact — no resume tolerance is
smuggled; MAIN state legitimately steers only the node_modules symlink lane, unchanged.

## 2026-07-22 — AD-070 the --include copy door proves what it copies (kit 3.9.0)

The `--include` provision lane carried a preflight→walk gap: a source swapped after preflight
was copied as approved, and the path-based queue guard could not see a node that had become the
shared series index by identity (a hardlink, a swap) rather than by path. Preflight now captures
each include root's {device, inode, kind} before any git mutation (special or unprobeable roots
refuse with no worktree created); a file root is re-verified at the descriptor door, a directory
root at walk start; and every copied include file is proven, with both descriptors open, not to
be the door-time queue — identity read at descriptor-open time, never cached, fail-closed on
anything unprovable. The contract ships as an exported constant, emitted on every
include-identity STOP and doc-parity-pinned into the worktrees mode doc.

## 2026-07-22 — AD-069 cleanup never deletes a node_modules it cannot prove ephemeral (kit 3.8.0)

Routine non-abandon `worktrees cleanup` silently deleted an ignored user-built `node_modules` —
it sat unconditionally in the provision-owned root lists. Ownership is now decided live at
cleanup time from information content, never provenance and never the handoff record: the node is
EPHEMERAL only as a symlink whose raw target bytes equal MAIN's `node_modules` path, crossed with
a tracked-first lane; the single exempt state (the ignored-lane matching link) is re-proven
immediately before the irreversible remove; every other state stops surgically with a lane- and
kind-matched recovery (a tracked `node_modules` never gets an `rm`), and every probe error fails
closed with no removal command. Clean-absent follows the legacy path, so landing a tracked
`node_modules` removal still converges. The contract sentence ships as an exported constant,
emitted on every ownership STOP and doc-parity-pinned into the worktrees mode doc.

## 2026-07-22 — AD-068 the worktrees-dir advisor item can finally converge (kit 3.7.0)

The `recommendations` advisor's `worktrees-dir` item fired forever — its only convergence signal
was a host callback production never supplies. It now converges on a declared
`sandbox.filesystem.allowWrite` entry covering the probed dir (either settings scope,
path-segment-aware, guarded no-follow) or, on hosts that ignore that key, on a neutral dir-bound
`worktreesDirAck` recorded by the consent-gated `ack-write --lane worktrees-dir` into
`docs/ai/acks.json`; a supplied host signal still overrides both, in either direction. Neither
signal claims write CAPABILITY — the provision preflight's real probe stays the runtime truth.
`ack-write` grows a closed-world `--lane` registry (default `sandbox-lane` keeps every existing
invocation byte-identical). Every shipped surface now qualifies the subagent promise honestly:
«where the host fires hooks on subagent Bash». The advisor half of the bare-lane plan, shipped
alone (AD-068); the deny rung stays deliberately queued behind its consent-gated live-host canary.

## 2026-07-22 — AD-067 the dependency-free install posture is a proof, never a default (kit 3.6.0)

On a provably dependency-free project the worktrees provision record and the default-lane report
now state `no install needed — the project declares no dependencies` instead of a generic
`npm install` hint. The proof reads the WORKTREE'S OWN LIVE checkout — exactly HEAD at provision
time, the satellite's own committed state on `--resume`, never MAIN's mutable working tree — and
is granted only on evidence the tool actually read: a `workspaces` field of any shape
(a workspace install materializes links even with zero dependencies), an external workspace
manifest, a malformed manifest or field shape, an install-lifecycle script (dependency-free is
NOT install-free), or a `binding.gyp` all leave the posture UNKNOWN and keep the honest advice.
Composes with the shipped symlink unlink-first arm; a `doc-parity` binding pins the posture
string. Third safe slice of the deferred parallel-track work (AD-063); node_modules ownership and
resume-verify semantics stay separate redesigns.

## 2026-07-21 — AD-065 the provision record orients a fresh satellite session (kit 3.5.0)

The worktrees provision record now carries the three facts a fresh satellite session cannot derive
from its own checkout: the ABSOLUTE path to MAIN's shared `docs/plans/queue.md` with the verbatim
never-copy rule, the landing-runs-FROM-MAIN direction with the runnable command, and the resolved
install posture. The record refuses values it cannot round-trip (control bytes, U+2028/U+2029) and
validates everything BEFORE any git mutation; `--include` can no longer smuggle the shared index
into a satellite. Two `doc-parity` bindings pin the mode doc to the live strings.
Second safe slice of the deferred parallel-track work (AD-063); the dependency-free install
posture is the next slice, node_modules ownership stays a separate redesign.

## 2026-07-21 — AD-064 review-state names a latent arm on a clean-tree PASS (kit 3.4.0)

`review-state --check` under a configured `reviewed` or `council` recipe on a clean tree now NAMES
every plan in flight and states that the gate arms as soon as the tree turns dirty, so a spent boot
prompt left under a bare name is discoverable before it blocks rather than at the worst moment. A
`doc-parity` binding pins the live notice to its mode doc.
This is the safe, converged slice of the deferred parallel-track work (AD-063), shipped alone with no
worktrees-ownership coupling.

## 2026-07-20 — AD-062 version-pin honesty: a runtime harness probe replaces a frozen claim (kit 3.3.0)

`velocity --autonomy` had been telling every user their credentials could not be protected by the
sandbox, naming a harness version frozen in the source and 30 patch releases stale — a false claim
about a security control, not a silent failure. **kit 3.3.0** replaces the literal with a runtime
probe of the INSTALLED build, renders and merges `sandbox.credentials` where it is genuinely
supported, and degrades loudly — naming the version it observed, or stating that it resolved none —
wherever the build is older or its version is unresolvable. An UNREADABLE install or a defect inside
the probe throws instead, deliberately: "cannot confirm" must never read as "confirmed absent". A
new `version-pin` rung in `release-scan` refuses a bare harness version literal
under `tools/` unless a runtime probe sits beside it, so the next frozen pin fails a gate instead of
quietly aging. The rung deliberately proves PRESENCE, not comparison — the stronger claim needs JS
lexing, and the repo's existing lexer is not reachable from a shipped kit tool (queued separately).
Nothing else in the family moved (memory 3.1.0 / engine 2.0.0 / bridges unchanged).

## 2026-07-20 — AD-061 friction cluster: minimum approvals + plain language + posture as code (kit 3.2.0 / memory 3.1.0 / codex bridge 3.1.0 / agy bridge 4.1.0)

A four-item maintainer-flagged friction cluster shipped as mechanism (engine unbumped at 2.0.0):

- **kit 3.2.0** carries the shared `command-shapes.md` promptless-probe contract (bound to the
  probe-instructing modes + a router inline bar), bundles the two updated bridges, and carries the
  plain-language §2.5 bar in its fallback template.
- **memory 3.1.0** adds the plain-language §2.5 Communication bar to the `agent_rules` template
  (byte-identical to the kit's copy; reconciled into existing deployments by the kit's upgrade
  lane — a standalone memory upgrade does not touch the §2.5 region).
- **codex bridge 3.1.0 / agy bridge 4.1.0** ship posture as code on the codex-exec dispatch and
  both review dispatches: the codex-exec D5 exec banner (validated resume id + NUL/control-byte
  screens), a banner-only `timeout` field on the review banners from one shared shadow-proof
  effective-timeout resolver, the quote-the-banner-verbatim duty across every contract surface, and
  the advisor's matching control-byte refusal.
- **This repo's `release-cycle` process** flips to CONSOLIDATED approval asks by default (minimum
  approvals — one message, one reply). This is a machine-local process change for this repository,
  not part of any published package payload.

## 2026-07-19 — memory 3.0.1: bundled reference scripts refreshed (patch rider on kit 3.1.0)

The publish workflow's changed-but-unbumped tooth refused to no-op memory at 3.0.0: two bundled
reference scripts had moved since that tag (the in-process CLI rework of `check-docs-size.mjs`
from the suite speedup + a comment-only neutral-review-ID sweep in `archive-decisions.mjs`). No
behavior change — a PATCH release restores the version/content pairing the workflow enforces.

## 2026-07-19 — kit 3.1.0: parallel feature worktrees v1 — provision · list · land --prepare · cleanup (AD-060)

**Parallel feature development lands as a first-class mode.** `worktrees.mjs` provisions a visible
sibling worktree per feature (registry-derived footprint copy-if-missing, exactly one seeded plan,
a handoff stub, fail-closed `--resume` identity), lists honestly (`handoff: (unreadable)` — never
a silent "no"), prepares a landing (the satellite diff — staged AND unstaged inspected, unstaged
or untracked-not-ignored leftovers refused, `docs/ai` + `docs/plans` excluded — staged onto a
clean main behind a common transient lock, gates run, OIDs reported — the commit stays a dialogue
ask; a second prepare is reset-only; transfer-apply failures attempt a byte-clean rollback while
a red gate that leaves the snapshot unchanged keeps the prepared tree with named recovery lanes,
rollback failures composed without losing the primary error), and removes a LANDED worktree
fail-closed (live verification at exact land-exclusion
parity, typed-EXACT ignored-content ownership; `--abandon` is the one destructive arm). All
content reads/copies go through two no-follow descriptor doors pinned by tripwire tests; parsers
are strict (NUL worktree porcelain — git >= 2.36 floor, any-depth duplicate-key JSON refusal,
section-required provision record). release-scan gains the reviewer-round-identity rung
(`agy`/`codex` R-number references refused; shippable finding IDs move to neutral `review-…`
IDs). Four gated commits, each council-converged on the staged tree.

## 2026-07-17 — MAJOR family: kit 3.0.0 / memory 3.0.0 / engine 2.0.0 / codex bridge 3.0.0 / agy bridge 4.0.0 — strip-the-kit ships the hardened computed core (AD-059)

**The recorded review loop is replaced by a computed one.** The ledger/fold machinery (tools,
modes, stores — ~14.5k lines whose records duplicated what receipts and the tree already prove) is
DELETED; in its place: `core-evidence` (observed-red red-proof custody + explicit degrade records +
the stateless summary), `coverage-check` (changed-line lcov + red-proof verification inside
`run-gates --final`, the one attempt-linked receipt), and `commit-guard` (the pre-commit that binds
a commit to the latest green receipt at the exact tree fingerprint). Both bundled bridges gain
honesty (a verdict-less run exits 4 with NO receipt; exact/structural verdict parses) and dispatch
posture (a banner + `posture{}` on every receipt, validated manifest pins, pre-spend control-byte
refusals) — pre-posture receipts stop attesting, fail-closed. Consumers migrate via the consented
`migrate-gates.mjs` + `gates-init.mjs` and the hook installer's `--commit-guard` arm; the
deployment-lineage head is 3.0.0 (`migrations/3.0.0-hardened-core-loop.md`); Node floor >= 22
family-wide. Five gated code commits across Phases 2–4, each council-converged; the last two passed under
the armed commit-guard itself — the loop shipped by surviving its own teeth.

## 2026-07-16 — kit 2.1.0 + antigravity bridge 3.0.0 (MAJOR): agy code review fails CLOSED pre-spend (AD-058)

**Bridge MAJOR, kit MINOR carrier.** `agy-review code` without a NON-EMPTY `--facts` payload now
refuses at parse time — exit 2, zero subscription runs spent, and the refusal prints the exact
recovery (the installed kit's `grounding.mjs`, resolved from the wrapper's own location and quoted,
plus the `--facts @<file>` re-run line). Previously the wrapper warned and spent the run anyway —
producing a `grounded:false` receipt the review-state gate rejects by design: a guaranteed-wasted
spend. Explicit, honest escapes: `--ungrounded` (throwaway opinion; the receipt records
`grounded:false` and never attests) and `AGY_PROBE=1` (a probe may run ungrounded — its receipt
never attests either way). `plan`/`diff` and continuations unchanged. Every declaration home moved
in lockstep, drift-guarded: `--help` ⟷ `capability.json` (contract + modeCatalog) ⟷ the kit
registry mirror ⟷ SKILL.md ⟷ the reference docs. Scripts calling bare `agy-review code` add
`--facts @f` or `--ungrounded`.

## 2026-07-15 — kit 2.0.0 (BREAKING) + bridges 2.8.0/2.7.0: bridge mode catalog + a review receipt that self-declares (AD-057)

**Kit MAJOR** — the first in the kit's history. A review receipt written before this release **no longer
attests a tree**: the kit now rejects an unmarked receipt, because the pre-marker wrappers already
honoured `CODEX_PROBE`/`AGY_PROBE` and wrote no marker, so an unmarked receipt is indistinguishable from
a probe receipt (a review that ran with the quality guards off). Upgrade with
`npx @sabaiway/agent-workflow-kit@latest init`, which also ATTEMPTS to refresh the placed bridges — then
read its per-bridge outcome: **`skipped-readonly` or `could not refresh` means a compatible writer is not
guaranteed**, so the new kit reader may still be paired with an old bridge writer and every review would
write an unmarked receipt the gate rejects. Re-run the refresh from a writable environment (using the
recovery command if one was printed), then re-run the review. No project files change; the
deployment-lineage head is a separate axis and stays `2.0.0`.

The two bridges stay **MINOR** (2.8.0 / 2.7.0): they only ADD a field to the receipt they write, which is
additive. The incompatibility is created by the kit READER that refuses the old form.

Two independently reviewable contracts, one theme — *what a bridge offers, and what a receipt claims,
must be readable off the artifact itself; never inferred from source, never inferred from silence*:

- **`modeCatalog` — the discovery layer.** A new top-level, additive-optional manifest block (schema
  stays 1), typed-validated like `settings` (absent → valid; present-but-malformed → invalid). Both
  bridges declare their real mode set with a closed taxonomy (`primary`/`continuation`/`env-hook` — an
  env-hook names `parents[]` instead of faking a role), a required per-mode `purpose` + `whenToUse`, and
  — where they apply — `whenNotTo`, typed `operands[]`, structured `guardrails{value, enforcement,
  condition?, source}` and `customHooks[]`. Forms compose **by reference** into the AD-033 driving contract rather than shadowing
  it. Honesty is enforced, not promised: declared slots set-EQUAL the placeholders the rendered forms
  really carry in both directions, `enforced` is claimable only for an OS-/code-enforced fact, and
  `submode`/env-hook declarations are drift-guarded against the wrappers' real parser arms and real
  executable conditions.
- **Probe-receipt honesty — the breaking change above.** Both wrappers wrote receipts unconditionally, so
  a `CODEX_PROBE=1`/`AGY_PROBE=1` review — running with the frontier-model/max-effort guard **off** —
  minted a receipt the review-state gate accepted. Both now write `probe` (`true`/`false`) on **every**
  successful review through the shared byte-identical `write_review_receipt` block: the receipt
  self-declares. The kit rejects a probe-marked receipt and equally rejects an unmarked one — silence is
  not a declaration. What the marker carries is UNTRUSTWORTHINESS, never provenance: receipts are not
  authenticated, so this is self-discipline made legible, not a security boundary.
- **One attesting predicate, three consumers.** The classify/summarize/describe trio lives in the neutral
  `review-ledger-core.mjs`, read by `review-state.mjs`, `receiptCrossCheck` and the round writer — two
  gates disagreeing about what attests is the class AD-050 closed. It also fixes a latent hole: the ledger
  took the LAST receipt line, so a probe landing after a real review became authoritative (a probe SHIP
  could bury a real REWORK and let both gates report convergence). The summary now returns the latest
  **attesting** receipt.

The BRIDGE-MODES-CATALOG plan's **Segment B** (the kit `bridge-modes` read-only mode, its Recommendations
funnel/ack, and the memory `archive-decisions --headroom` lane) is **not** in this release — a maintainer
scope decision both backends independently endorsed. Full record, the mid-execution amendment of the
original probe design, and the stated residuals in AD-057.

## 2026-07-14 — kit 1.49.0 + bridges 2.7.1/2.6.1: honesty/robustness bundle (AD-056)

**Kit MINOR** (carrying codex-cli-bridge 2.7.1 + antigravity-cli-bridge 2.6.1 PATCH in-tarball;
engine 1.17.0 / memory 2.3.0 unchanged; lineage head stays `2.0.0`) **plus a repo-only dispatcher
fix** on the same commit. Three small, live-observed defects, one theme — *a blocked environment must
produce a STATED degrade, never a false red; a real failure stays loud*:

- **kit — refresh under a read-only skills dir.** `--refresh-placed` re-syncs even at the current
  version (repair-on-rerun); under the harness sandbox `~/.claude/skills` is read-only, so that write
  EROFSed into a false *"could not refresh — recover with setup"* (both versions current; `setup` hits
  the same read-only dir). It now reports a new **`skipped-readonly`** outcome (exit 0) naming the
  version, the skipped/incomplete re-sync and the read-only cause — never claiming a re-sync ran. A
  version-behind or non-read-only failure stays loud; the opt-in `setup` lane stays loud.
- **bridges — settings integer parity (Issue-012, Resolved).** The four wrappers' shared
  `aw_settings_valid` integer arms wrapped modulo 2^64 on a 19+ digit string, so the shell accepted a
  value the kit's safe-integer `settingValueValid` rejected. A shared overflow-safe `aw_int_in_range`
  helper (byte-identical across all four wrappers) closes the gap; a leading-zero in-range value still
  passes on both sides — pinned by a behavioral shell↔JS parity test.
- **repo — the publish dispatcher's post-publish verify (`scripts/release/dispatch-publish.mjs`).** A
  network-blocked in-sandbox verify hit two false-red paths (a transport-rejected npm fetch → exit 1
  "fetch failed"; a gh transport failure at the Release lookup → "treating as missing") though the
  publish concluded success. The production adapters now type the transport outcome (keying on the
  response shape, not the exit code), and a transport failure/timeout classifies as **UNREACHABLE — a
  new distinct exit `9`** (inconclusive, not a failed release). A new **`--verify-only`** lane re-runs
  only the verify (zero dispatches) so a degraded in-run verify is recovered outside the sandbox
  without re-dispatching. Every verify lookup carries a bounded transport deadline. Full record in AD-056.

## 2026-07-14 — kit 1.48.0: family-owned neutral ack store + read-prompt-economy hook lane (AD-055, the CLAUDE-CODE-HARNESS-FRICTION cluster)

**Kit-only release** (engine 1.17.0, memory 2.3.0, bridges 2.7.0/2.6.0 unchanged; lineage head stays
`2.0.0`). Two sibling defects where the kit fought the Claude Code host surface, one ADR, two
commit-anchored segments. **Part I:** the `sandbox-lane` recommendation's neutral fingerprint ack
relocates out of `.claude/settings.local.json` (a host that blocks the write twice — the settings
validator rejects the unknown key, the command sandbox EROFS-denies the file) into a family-owned
`docs/ai/acks.json` no host validator guards, written by a new consent-gated ack writer; the legacy
key is read for one deprecation window. **Part II:** the placed gate hook gains an **opt-in read-lane**
(rung c) — with `docs/ai/lanes.json` `{ "readLane": true }` (read live, fail-closed), a command whose
every `;`/`&&`/`|`-split segment is a plain frozen read-only core command with **zero shell
metaprogramming** is auto-approved, killing the read-side compound prompts a prefix allow rule can
never match; `lanes.json` is a separate file so the `gates.json` chain stays byte-untouched. The
residual guard for settings-allowed singles additionally trips bash-5.3 funsub openers, a
backslash-newline line-continuation splice, and a de-spliced `--output` word-construction re-scan.
`gate-hook --read-lane` enables the lane only after a hook currency + wired + stamp check (a pre-1.48
hook never reads `lanes.json`), and the upgrade Recommendations advisor surfaces the read-lane offer
(RISK_NOTED; stale/missing-hook ATTENTION variants). Council: codex+agy across three rounds, agy
SHIP ×3, every fixable fold red-first; the word-construction-on-a-single residual is a documented
inherent-layer-residual (rung b is a trust-posture convenience, not a sandbox). Full record in AD-055.

## 2026-07-13 — memory 2.3.0 · engine 1.17.0 · kit 1.47.0 · bridges 2.7.0/2.6.0: REPORT-FACTS train — live-fact report contract, batched ledger writer, version-sync wrapper lane, sandbox-lanes canon & bridge contract twins (AD-054)

**Family release** (bridges 2.7.0/2.6.0 ship inside the kit tarball; the deployment lineage head
stays `2.0.0`). Three top-of-queue items plus this session's own live prompt-defects, fixed
kit-level for all consumers: a **report-facts contract** binds every report claim about the current
host/session (prompts, sandbox, bypass, network reachability, approvals) to **live tool output from
this session** — no live signal → omitted or marked unverified, a snapshot is context not fact
(single-home clause + point-of-use binding lines + a new contract test); a **`batch` verb** in the
review-ledger writer collapses a records stage's ~13 writer calls into one two-pass invocation
(structural preflight with zero writes, then sequential fail-fast, append-only partial-success);
**version-sync `--bump`** now moves the bridges' `AW_BRIDGE_VERSION` wrapper constant under a closed
one-anchor rule and the verify pass checks it across all four constants (each wrapper + its kit
mirror) — dogfooded on this release; both bridges gain a typed **contract `notes[]`** (codex execute
= the nested-sandbox limit; agy review = the pre-dispatch host-diff) rendered in the advisor and each
wrapper `--help`, and **`codex-exec.sh` detects the nested-sandbox failure class** (a
sandbox-mechanism token AND a permission/read-only failure token together) and states a recovery hint
— route codex-exec outside the harness sandbox ON the observed failure, never a preemptive blanket;
the **prompt-economy canon** gains a writer-batch clause plus two sandbox-lane sentences (pre-dispatch
host-diff, nested-sandbox honesty). The velocity bridge-tier stays REVIEW-wrappers-only — delegated
execution keeps its human prompt. Council on the code: 5 rounds, 14 real codex findings all folded,
agy shipped R2–R5; full record in AD-054.

## 2026-07-12 — memory 2.2.0 · engine 1.16.0 · kit 1.46.0: Recommendations UX rework — verdict-first, in the user's language (REC-UX-REWORK, AD-053)

**Family release** (bridges 2.6.0/2.5.0 ship inside the kit tarball; the deployment lineage head
stays `2.0.0`). The upgrade Recommendations section is reworked end-to-end after its first
consumer-side report: a composed **verdict line now opens every render** (severity-classed items —
`attention` vs `optional` — with `nothing is broken` claimed only when nothing needs attention and
no probe was skipped); every registry string is **shape-capped frozen data** (one line, 140 chars,
banned risk/hedge tokens — a static gate that enumerated and killed 9 prose-wall violators);
posture/risk prose moved to the mode doc's per-item notes at the **informed-consent moment**; the
hedged `network-allowlist` item became the **`sandbox-lane` discoverability item** — the
manifest-declared session-sandbox recipe (`networkHosts` ∪ the new validated **`writableDirs`**
field) converging on a neutral, machine-portable fingerprint acknowledgement, never a security
key; and the paste-verbatim contract is retired for **presentation in the user's conversational
language** (facts complete, commands byte-exact, raw block on request — the AD-032 lane). The
engine canon gains the **prompt-economy clause** (read-only fan-out on restricted-tool vehicles;
one plain pipeline per call; capability-gated launcher guidance; frontier lane guarded; honest
limit stated), rendered by the kit advisor and the §2.6 lens, drift-guarded three ways. Council:
codex revise (6 major + 1 minor, all consult-verified folds) → agy SHIP; full record in AD-053.

## 2026-07-12 — memory 2.1.0 · engine 1.15.0 · kit 1.45.0: the autonomy series closes (AD-044 Plan 4)

**Family release** (bridges 2.4.0 ship inside the kit tarball; the deployment lineage head stays
`2.0.0`). The AD-044 checkpoint-bounded-autonomy series closes with the UX/velocity layer on top of
the Plans 1–3 mechanism: every kit `upgrade` now ends with a mandatory read-only
**Recommendations** section (frozen 12-item registry, exact consent-gated apply one-liners, honest
probe degradation, the HAND-APPLY network item derived from the new manifest `networkHosts`); the
consent-gated **`--bridge-tier`** velocity lane seeds promptless COUNCIL review runs (code mode
only — delegated execution keeps its human prompt) and registers with the audit at all three
points; the sandbox **device-mask fingerprint-divergence class dies by construction**
(never-committable stat classes filtered from the whole review domain across node + both bash
twins) with the GUARDED `sandbox-masks` cosmetic lane on top; autonomy becomes VISIBLE everywhere
(recipes status/active lines, set-recipe echo, procedures per-activity block — malformed-loud on
every paste surface, project-root-resolved, structural seed detection) and SEEDED everywhere
(memory's sparse defaults-equivalent `autonomy.json` template); the engine publish delivers the
`workflow:autonomy` slot to the install base (the Plan-3 D7 residual clears). Per-package detail
in the three package CHANGELOGs.

## 2026-07-11 — kit 1.44.0: autonomy provisioner — the consent-gated sandbox doctor (AD-044 Plan 2)

**agent-workflow-kit 1.44.0** (kit-only feature; memory/engine/bridges unchanged, lineage head
stays `2.0.0`). New routable GUARDED mode **`autonomy-doctor`** — the cross-platform provisioner
that makes the AD-044 checkpoint-bounded-autonomy sandbox actually initializable on consumer hosts
(macOS Seatbelt built-in / Linux + WSL2 `bwrap` + `socat` / native Windows → WSL2 redirect). Three
explicit lanes: a FS-only flagless preview that spawns NOTHING and never claims ready; `--verify`,
the only source of a Linux "ready (verified)" (pinned bwrap user-namespace smoke + `socat -V`);
and the consent-tuple `--apply <pm>:<pkgs>` install that refuses any mismatch with the previewed
plan. The kit's FIRST privileged spawn ships with a closed-world doctrine: absolute trusted-dir
paths for every executed token (including through `env`), a frozen 4-family package-manager map
(apt env-trampoline / dnf / pacman / apk), a scrubbed child env, an enforced no-TTY print-handoff
at the sudo boundary, root-refusal honesty (`root-unproven`), a frozen EXIT/status contract, and
disclosed residuals. Host-proven end-to-end on WSL2: the ad-hoc prompt-delta drops 1 → 0 in a
fresh session while the commit/push/publish red-lines and network egress still prompt. See
[agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md).

## 2026-07-10 — kit 1.43.0: closed-world gate seeding — lifecycle hooks die by construction (AD-052)

**agent-workflow-kit 1.43.0** (kit-only feature; memory/engine/bridges unchanged, lineage head stays
`2.0.0`). The consent-gated `gates.json` seeder moves from BLOCKLIST body screening to a
**closed-world** offer derivation — the structural fix for **Issue-011**, whose three residuals the
AD-042 council could only push one gap further each round, never close. Because a declared gate is
hook-auto-approvable, the offer is now conservative BY CONSTRUCTION (worst case = a legit command
not offered, add-by-hand; never a dangerous one offered). The seeded cmd is the uniform hook-free
`COREPACK_ENABLE_NETWORK=0 <pm> exec -- <allowlisted-body>` for the detected package manager — `exec`
runs a command, not a named script, so no `pre`/`post` lifecycle hook fires on **npm, pnpm, or
yarn** (never `<pm> run <name>`); the body must be a member of a 9-entry literal runner allowlist
after a pinned ASCII normalization (an injected `curl | sh` / release alias / env-body is rejected
by non-membership); per-PM hardening keeps a missing runner from fetching (npm `--offline`, the
Corepack env prefix, pnpm/yarn native fail-closed), and an unverifiable package manager is withheld
loudly. A companion `assertDocsAiDeployment` parent-chain preflight refuses a symlinked `docs`
parent across all four write consumers. Safe-by-construction is the OFFER DERIVATION, not a runtime
sandbox — a gate runs the project's own tooling, the disclosed residual bounded by the two-consent
trust chain. See [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md).

## 2026-07-10 — memory 2.0.0 (MAJOR) + kit 1.42.0 + engine 1.14.1: one-file-per-ADR store — the 3-tier decisions cascade retired (AD-051)

**agent-workflow-memory 2.0.0 (BREAKING) + agent-workflow-kit 1.42.0 + agent-workflow-engine
1.14.1** (a housekeeping patch — npm-12 tarball-guard compat + the lineage-head preamble; no canon
change; bridges unchanged).
ADRs accumulate monotonically, and the 3-tier cascade (HOT `decisions.md` → WARM archive → one COLD
monolith) turned that O(n) growth into a recurring release cost — the COLD cap was raised
800→1000→1100→1200 across four releases and stood exhausted again. Every ADR now lives as its own
immutable MADR record `docs/ai/adr/AD-NNN-slug.md`; `decisions.md` stays the bounded HOT authoring
window; `archive-decisions.mjs` is repurposed IN PLACE (same path/hook slot/gate id) to explode the
oldest entries beyond the cap into per-file records — a record is O(1) forever, no cap is ever
raised again. Retrieval never routes through an O(n) artifact (filename by id · grep by topic · the
two-way supersession chain by lifecycle); the ONE generated navigator `adr/log.md` lists governing
heads only (supersession computed corpus-wide) and `index.md` carries a single `adr/`
directory-collapse row. Every destructive migrate writes a durable git-dir snapshot first
(`docs/ai` is git-ignored here — git history can NOT recover the monoliths) under a fail-loud
partition-preserving conservation check. **The deployment-lineage head bumps `1.3.0` → `2.0.0`**
(the first structural `docs/ai` migration; `LINEAGE_HEAD` / `EXPECTED_WORKFLOW_VERSION` in
lockstep). **Consumer path is repo-first + OPT-IN:** fresh bootstraps (memory and kit-fallback
alike) seed the new scheme; an existing deployment keeps its old layout + old rotator fully working
until the consent-gated `/agent-workflow-kit migrate-adr-store` (whole-set script refresh →
snapshot → conservation-checked migrate); the kit's `status`/`upgrade` surfaces detect an
old layout and point at the mode, while memory's global installer prints only a generic advisory
(knows-nobody). Dogfooded on this repo: 41 records exploded, both monoliths retired behind a
verified snapshot, all gates green. Design consult + plan council both ran pre-execution (codex
`revise` + agy `REWORK` on the brief; codex `revise` + agy `SHIP-WITH-NITS` on the plan; a
12-finding internal pre-sweep) — every finding folded into 17 locked decisions (AD-051). Dev-infra:
the four `npm pack --json` tarball-guard tests now accept both npm ≤11 (array) and npm ≥12
(name-keyed object) output shapes.

## 2026-07-09 — kit 1.41.0: review-state degraded lane — align the presence gate with the ledger (AD-050)

**agent-workflow-kit 1.41.0** (memory/engine/bridges unchanged). Closes the AD-049 residual: the
family's two read-only review gates **disagreed** on a tree the orchestrator honestly converged
codex-only with agy recorded degraded — `review-ledger --check` (convergence) excused the degraded
backend, but `review-state --check` (presence) had no degraded model and failed on the missing
receipt, blocking a consumer that wires review-state into a pre-commit hook. The fix lands in two
reviewed segments: (1) the validated review-ledger read/schema core is extracted VERBATIM into a
neutral node-built-ins-only `review-ledger-core.mjs` (re-exported for back-compat) so review-state can
read the ledger without the `review-ledger ↔ review-state` import cycle — a pure mechanical move, no
behaviour change; (2) `review-state` gains the SAME degraded exemption, mirroring review-ledger's
`decideStop` (allPresent + a non-degraded present-in-round backend with a current grounded receipt) and
staying **verdict-blind** — presence, not unanimity. Fail-closed is exemption-scoped: a corrupt ledger
denies the exemption but never fails a receipt-satisfied tree. The two gates now agree on a
converged-with-degrade tree (dogfooded live + pinned by a detector-independent two-gate-agreement test
+ a 17-case matrix), and still intentionally differ on a non-converged one. Council-converged both
segments; full suite 2969 green.

## 2026-07-08 — kit 1.40.0 + memory 1.12.0: universal verification profile + session-loop economics (a)–(h) (BUGFREE-3, AD-049)

**agent-workflow-kit 1.40.0 + agent-workflow-memory 1.12.0** (engine/bridges unchanged). BUGFREE-3
closes the AD-046 language-independence residual and folds the BUGFREE-2 retro's eight session-loop
cycle-costs (a)–(h). A new optional `docs/ai/verification-profile.json` (`schema:1`; memory template
+ a kit read-core tool) declares WHERE a suite leaves coverage (V8 or **LCOV**) + the single-test
format (**TAP stdout/file, JUnit-XML**) + an optional SARIF path — so a non-JS/V8 consumer can
finally use the fold-completeness gate (an absent profile reproduces today's behaviour exactly). The
economics: (a) one suite run per fingerprint **credits** the `unit-tests` gate; (b) a `doc-parity`
lint pins mode-contract docs to live code constants; (c) a same-segment re-attest replaces mis-using
`red-proof` for a green-only test append; (d) `review-state --await` blocks on receipts, not a pid;
(e) `grounding --ledger-summary` renders a loop-scoped ledger digest for `--facts`; (f) a
`--preflight` verb; (g) `record --from-receipts`; and (h) an ADR rotation regenerates
`docs/ai/index.md` so it never trips the freshness gate mid-release-matrix (**dogfooded on this very
release**). Stated Option-A residual: the (a) credit rides `NODE_V8_COVERAGE` (bounded, documented,
tested); the Node ≥22 + LCOV-reporter closure is queued.

## 2026-07-07 — kit 1.39.0: fold boundaries — commit-anchored segments, the diff-size cap, the green-baseline receipt, no-repro-no-fold, gate telemetry (AD-048)

**agent-workflow-kit 1.39.0** (engine/memory/bridges unchanged). AD-047's own execution loop
field-proved the gap: the review ledger hard-capped a MULTIPHASE plan at 3 rounds total (11 real
rounds across 4 commit boundaries unrecordable; late fixable-bugs unbindable), and whole-plan
custody forced a waiver for every later-phase edit of an earlier-bound test file. One structural
move fixes both and gives the three most-replicated fold-boundary effects real teeth: **the
SEGMENT** — every record carries `base` = the HEAD commit; round numbering, the caps, every writer
tooth, and both `--check` gates operate per (activity, loop, base); a segment closes ONLY through a
gated commit, so a round-counter reset is earned, never declared. Review-ledger schema **v4**
(kind `gate-run`, override scope `size-cap`, triage class `refuted`) + fold ledger **v3**, each
with the per-version quartet — old ledgers never retroactively malformed. New teeth: the
**diff-size cap** (`AW_REVIEW_DIFF_CAP` 400, one shared changed-surface computation in the new
neutral `tools/changed-surface.mjs`), the **green-baseline receipt** (`run-gates --record` →
`recordGateRun`; a round records only over a gate-run proving every declared NON-process gate green
at the current fingerprint — a subset omitting a declared non-process gate, or a tree-changed run,
never satisfies; red process gates never block), and
**no-repro-no-fold** (a blocking finding never vanishes unclassified; `refuted` is the honest
phantom lane, grounds mandatory). The fold gate's custody obligations now **close with each
commit** (the cross-phase churn class is dead); `review-ledger --telemetry` renders counts-only
gate-efficacy data. Dogfooded live on its own three-segment loop: the cap fired on the plan's own
Phase-1 surface, the D5 tooth consumed a real quality-green receipt at first use, and segment
closure ran end-to-end at every phase commit.

## 2026-07-07 — kit 1.38.0: honest red→green — observed-red receipts, flaky quarantine, content custody, oracle-tamper guard (AD-047)

BUGFREE-1. The fold-completeness gate now demands proof a bound test ever FAILED before its fix —
"fix theater" (a test written green beside the fix) no longer passes. A new `--red` verb observes a
test failing on the real pre-fold tree and mints a custody receipt (fold ledger schema v2); RED and
GREEN are strict N/N verdicts (`AW_FOLD_RERUNS`, per-run `AW_FOLD_PROBE_TIMEOUT_S`) with
mixed/timeout QUARANTINED (no override lane); the gate then requires, per bound test, receipt → order → N/N green →
per-FILE byte-identical custody (the latest custody-eligible receipt on that test file), over an
untampered test surface (hunk-polarity tamper pass;
recorded, auditable `oracle-change` / `red-proof` overrides — review-ledger schema v3, exact
payloads, single-in-flight-loop teeth). Engine/memory/bridges untouched. See
`agent-workflow-kit/CHANGELOG.md`.

## 2026-07-07 — kit 1.37.1: the fold-completeness probe no longer green-vouches a nonexistent testId on Node 18/20

Patch on top of 1.37.0, same day. Node 18/20 emit pattern-filtered tests as `# SKIP` TAP lines and
the probe parser counted them as executed matches — a nomatch `testId` read as resolvable +
baseline-green on exactly the Node versions the kit supports (caught by the CI 18/20 matrix on the
release commit; newer Node omits filtered tests, so local runs were green). `parseProbeOutput` now
ignores SKIP/TODO-directive result lines (a skipped test did not run — fails closed, never open),
with the node-18/20 TAP shape pinned as fixtures. See `agent-workflow-kit/CHANGELOG.md`.

## 2026-07-07 — kit 1.37.0 + engine 1.14.0: fold-safety completion — testId enforcement, the fold-completeness coverage gate, the activity-aware canon pointer (AD-046)

Completes DEBT-TEST-COMPLETENESS (M2 + M3a). The ledger's `fixable-bug` triage now REQUIRES its
red→green `testId` (schema v2; v1 records tolerated on read), and a NEW kit tool pair attests the
loop's folds against the changed code — every changed executable line executed, every bound testId
resolvable with a green baseline: `fold-completeness-run.mjs` (one suite run under
`NODE_V8_COVERAGE` + shell-free testId probes; the record binds the tree fingerprint AND the sorted
testId set) with the fail-closed read-only `fold-completeness.mjs --check`. The engine canon names the
ledger **activity-aware**: the plan-execution review step only, with the triage classification
vocabulary in both activities, drift-guarded in both directions. **Mutation testing (M3b) was
researched and SHELVED** (maintainer decision: bounded local mutation missed the empirical anchor and
is not language-independent) — no mutation testing or mutation evidence ships: records carry only a
reserved EMPTY `mutation` shape (plus inert budget fields), and the checker fails closed on any
record carrying mutation data. Consumer seeding of the new gate is deliberately ON HOLD (JS/V8-only
v1). See the package changelogs.

## 2026-07-06 — kit 1.36.0: review-round ledger — the prose crossover-stop becomes a computed signal (AD-045)

The review-loop crossover-stop (`planning.md` §9 / `procedures.md`) was prose with no checker and
broke under load. Ships as a **mechanism** (DEBT-REVIEW-CAP): `tools/review-ledger.mjs` (read-only —
schema + tolerant reader + the pure `decideStop` truth table `converged > resolved-residual >
triage-required > continue` + the fail-closed `--check` gate) and `tools/review-ledger-write.mjs` (the
sole writer over the `atomic-write` core — `record` / `classify` with the teeth: refuse a round while
triage is required, beyond hard-max 3, or without a grounded receipt; round-sequence integrity). The
read/write split is import-split-test pinned; the ledger lives in the git dir (uncommittable). Adds the
`review-ledger` command + mode + the conditional `seed-gates` candidate. Honest residual (stated): the
ledger attests a review occurred + its ship-class is consistent, not that counts are truthful — a
self-discipline mechanism, not a security boundary. `testId` enforcement + a fold-completeness signal +
the canon-pointer mechanization are the next plan. See `agent-workflow-kit/CHANGELOG.md`.

## 2026-07-05 — kit 1.35.0 (bundling bridges 2.3.0): host-level bridge settings file + the Codex Fast tier as configuration (AD-043)

Bridge knobs now live in ONE host-level file that survives kit upgrades:
`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf` (`KEY=VALUE`, parsed never
sourced — a file line can never execute code; explicit env — even empty — wins over file, file
wins over built-in). All four wrappers read it through a byte-identical reader block: each
applies only its own subset but recognizes the whole registry (another wrapper's key is skipped
silently; only a truly unknown key warns, once per run — a delegating chain never repeats
diagnostics). First shipped knobs: `CODEX_SERVICE_TIER` — the Codex Fast tier (`priority` is the
only server-catalog tier id on the subscription: ~1.5× token speed at a 2.5× credit rate on
gpt-5.5, quality-neutral, default OFF — enabling it is a consented per-host spend act),
`CODEX_HARD_TIMEOUT`, `CODEX_REVIEW_MAX_TOTAL_BYTES`, `AGY_HARD_TIMEOUT`,
`AGY_REVIEW_ALLOW_ADDDIR`. codex itself accepts any `-c service_tier` string silently
(live-probed 2026-07-05), so the wrappers validate every **file** value — and the service-tier env
— against typed constants pinned to each bridge's new `capability.json` `settings` block (an explicit
env override of a non-enum knob stays the operator's documented raw value; manifest-as-source;
`validate.mjs --strict` now fails a malformed block; `--help` Settings sections and the shell
constants are drift-guarded set-equal to it). Model/effort keys are NOT file-settable — the
quality-first guard is byte-untouched.

**kit 1.35.0 machinery.** A `bridge-settings` reader + consent-gated writer (`guarded`) reads/writes
that file on a hardened out-of-tree atomic core (`writeContainedFileAtomic` / `writeHostConfigFileAtomic`,
factored from `atomic-write.mjs` — symlink/parent/TOCTOU-safe, dir created on first use); previews by
default, refuses unknown keys / out-of-range values / a duplicate-carrying file. The bridge **refresh
driver now states what it overwrites**: on an equal-version re-sync it names the locally-changed files
and points to the settings file (D5 — killing the silent-wipe that started this), while a version
upgrade never mislabels the version delta as a local edit. `init` and `upgrade` **reconcile** the
settings file (unknown/retired keys flagged, preserved verbatim). `status`, the `procedures` advisor,
and `recipes --status-line` surface the active knobs and each wrapper's settable knobs — fact-only, no
model claim, via a read-only reader core.

## 2026-07-04 — memory 1.11.1 · kit 1.34.0: onboarding UX — one batched setup prompt, the visible accelerator funnel, the consent-gated gates seeder (AD-042)

First contact now interrupts ONCE: bootstrap asks its three setup questions as one structured
multi-question prompt (recorded individually; nothing written until all are answered), and
upgrade batches its two migration asks when both `AGENTS.md` blocks are missing — collected
before the migrations apply, never re-asked. The installer tells a returning user to restart the
session after a refresh and states the real per-agent invocation matrix (Codex = its `/skills`
menu). The opt-in funnel is visible end-to-end: caveat-aware welcome-mat rungs
(velocity / agents / hook, fed machine-computed from the status envelope), a bootstrap
accelerators block, and a help "Tune" tail. New consent-gated `seed-gates` writer proposes a
project's own terminating verification commands (and the review-state gate when the config
declares reviewed/council on `plan-execution.review`) into `docs/ai/gates.json` — preview-first,
append-only, mutating variants screened out, every preview disclosing the seeding↔hook two-consent
trust chain; its hardened atomic core is extracted into `tools/atomic-write.mjs` (shared with the
orchestration-config writer, API unchanged). Engine unchanged; lineage head stays `1.3.0` (no
migration). AD-042 also records the documented AD-039 re-pin (`routerPlusMode` 28672 → 29696).

## 2026-07-04 — engine 1.13.0 · memory 1.11.0 · kit 1.33.0: lens slot-render — canon wording ships engine-only (AD-041)

The planning/review/process-fidelity lens now has ONE canonical home — the engine's
`agent-rules-lens` fragment plus its append-only prior store — and every other copy is a RENDER
of it: both `agent_rules.md` templates (the provenance intro), and every deployed
`docs/ai/agent_rules.md` via the kit's new heading-anchored `lens-region` reconcile (the 7th
stamp-independent upgrade reconcile + both bootstrap paths; a customized region is preserved
verbatim + flagged; cap-guarded; a too-old engine is a stated soft skip + a `status` caveat).
The 22-token × 4-file drift mesh is replaced by engine-side canon-presence + kit-side
render-parity against the known-canonical set. A future lens wording change is an ENGINE-ONLY
release — the AD-041 measurement clause watches the next ~5 canon changes. The repo release
harness gains `smoke-init --expect-file` (installed-file content assertions). Lineage head stays
`1.3.0` (no migration).

## 2026-07-04 — kit 1.32.0: approval-idle reduction — the opt-in `velocity --kit-tools` tier (AD-040)

Routine read-only kit-tool invocations stop idling on approval prompts, opt-in and honestly
labeled. `velocity --kit-tools` seeds 12 entries resolved from the running skill at seed time
(8 read-only tools wildcard · `run-gates.mjs` as one exact project-root-pinned byte-string,
advertised project-exec · 3 writer dry-run previews); the audited read-only core grows 18 → 31
by the AD-021 empirical probe method (`file` and `git cat-file` failed and stay hand-adds), in
lockstep with the PreToolUse hook; `set-recipe --write` now advises the one-time review-wrapper
hand-adds with quota honesty; the release flow gains a maintainer-chosen consolidated-ask option
(machine-local skill) with a deviation-voids-approvals staleness rule. Dead rules are prevented
by a new drift-guard test that matches every documented dispatch line against the seeded
byte-form. Details: [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md).

## 2026-07-04 — kit 1.31.0: SKILL.md progressive-disclosure split (AD-039)

The kit's 112 KB SKILL.md monolith becomes a ~10 KB router + 16 `references/modes/<key>.md`
verbatim mode bodies + 3 `references/shared/` point-of-use contracts, so every invocation loads
only its own read set (a daily `help` ~10× lighter, the worst path ~2.3×). Byte budgets and the
pointer conventions are pinned by the new `test/router-contract.test.mjs`; 7 content-coupled
guards re-anchored; packaging additive (tarball 96 → 115, exact-count-pinned); deployments
untouched (lineage head stays `1.3.0`, no migration). memory / engine / bridges unchanged — the
`package=all` dispatch of this release is the Issue-007 live proof (the unchanged packages'
Release steps must no-op cleanly).

## 2026-07-03 — engine 1.12.0 · memory 1.10.0 · kit 1.30.0 · bridges 2.2.0: review-recipe enforcement (AD-038)

Origin: a real council-substitution incident (Issue-010) + independent kit-user feedback — the
configured review recipe could be silently skipped, downgraded, or run before later edits, with no
way to detect it after the fact. The release makes the configured recipe impossible to miss, makes
"reviewed ≠ shipped" mechanically detectable, and turns grounding assembly into a command:

- **kit 1.30.0** — the machine-composed CONFIGURED-recipe line (`recipes.mjs --active-line` + the
  `set-recipe` post-write echo + the §1.1/handover template wiring); `/agent-workflow-kit
  review-state` (read-only receipt checker: fresh grounded current-fingerprint receipts per
  recipe-named backend, `--check` gate, never auto-seeded); `/agent-workflow-kit grounding` (facts
  assembler — Hard-Constraints slice + plan decision sections under the agy byte budget; WRITER
  honesty, scratch-only `--out`); the procedures advisor renders a populated grounding pre-step;
  bundled **bridges 2.2.0** append one JSONL receipt per successful review (canonical
  uncommitted-state fingerprint == the review-payload domain; codex literal verdict line; agy
  verbatim verdict + `factsHash`; continuations `fresh:false`, informational-only).
- **engine 1.12.0** — `planning.md` §7 gains the optional `## Decisions (locked)` row (+ a §8
  bullet): review-settled, executor-binding decisions get a canonical, machine-extractable home.
- **memory 1.10.0** — the installer verb-parity fold (the AD-034 cmp-keyed contract +
  never-downgrade gate, inline clone); both templates gain the §1.1 discovery step + the handover
  "Active recipes:" slot, byte-identical with the kit copies (new cross-package region-parity
  guard).

## 2026-07-03 — kit 1.29.0: an opt-in PreToolUse gate-approval hook (velocity scope C; bridges unchanged at 2.1.0)

- **The velocity residual is closed, opt-in.** `/agent-workflow-kit hook` places a self-contained
  PreToolUse hook and wires it into `.claude/settings.json`: a Bash command byte-exact to a gate
  declared in `docs/ai/gates.json` (invoked from the project root) is auto-approved with no prompt,
  and a seeded read-only command carrying a runtime residual (output redirection, command/process
  substitution, an `--output` write flag) now ASKS even where a settings allow rule would have
  silently passed it — proven live on Claude Code 2.1.185, recorded in **AD-037**. Exact matches
  only (never patterns — the rejected [[AD-021]] shape); never `deny`; a broken `gates.json` disables
  only the auto-approval, never the guard. The residual guard reads the whole command as a substring
  so a quoted or escaped form cannot hide it.
- **Kit-only, opt-in, reviewed at the diff.** Never auto-wired by `init`/`upgrade` (the AD-034
  refresh-not-place boundary); `/.claude/hooks/` joins the hidden-mode footprint; `uninstall` reports
  the settings edit and never removes a still-wired or customized hook; `status` gains one hook row.
  Council converged over four grounded rounds (codex + agy) — each round closed a string-scan
  obfuscation class or a TOCTOU/symlink window by code — ending codex **ship** + agy **SHIP**, 0/0.

## 2026-07-02 — engine 1.11.0 · memory 1.9.0 · kit 1.28.0: plans carry only checked syntax (bridges unchanged at 2.1.0)

- **A plan may carry only checked syntax.** The methodology's §9 "No code-mechanics in the plan"
  rule now has a hard boundary: a Step's exact paths + commands stay required and count as
  CHECKED because the plan's own Verification runs them against an explicit expected outcome or
  gate (merely running without asserting checks nothing); the only other syntax a plan may carry
  is a literal fixture/schema fragment a named test copies or validates. **Un-run, logic-bearing
  syntax** — control-flow, a regex, a glob, a grammar, an algorithm body, a mini-DSL — never
  lives in plan prose, however plausible or shell-verified it looks: a fold or draft that wants
  one writes the red→green test-as-spec at Execute instead. Origin: a 2026-07-01 incident where
  invalid bash (`[[ … == --help|-h ]]`) survived a review round inside an ephemeral plan — prose
  has no checker.
- **Four surfaces, one boundary, drift-guarded.** The engine canon (`planning.md` §9 +
  `procedures.md` plan-authoring step 5) and both `agent_rules.md` templates (byte-identical)
  carry the boundary; the two new tokens `checked syntax` + `logic-bearing` are pinned by all
  three guards (kit `lens-mirror`, engine `planning-canon` + `procedures-canon`), each proven
  non-vacuous by an injected red→green.
- **Nothing else moved** — no installer/tool/API change; bridges stay 2.1.0; deployment-lineage
  head stays `1.3.0` (content-only, no migration).

## 2026-07-02 — engine 1.10.0 · memory 1.8.0 · kit 1.27.0: cost-tiered execution (bridges unchanged at 2.1.0)

- **Every project gate is now ONE command.** The kit gained a generic gate runner
  (`/agent-workflow-kit gates` — `tools/run-gates.mjs`) over a per-project, hand-editable
  `docs/ai/gates.json` (seeded by bootstrap, ensured on upgrade, byte-identical template twins in
  kit + memory): a PASS/FAIL table, one machine-readable summary line, exit 0 iff all green,
  verbatim failing output, honest distinct outcomes for a missing/empty/malformed declaration.
  This repo's own matrix (unit tests · manifest validate ×5 · release scan · docs caps/index ·
  3 rotation checks · the release-skill existence gate) runs behind it — 9 gates, one exit code.
- **Mechanical work moved off the frontier lane.** `/agent-workflow-kit agents`
  (`tools/cheap-agents.mjs`) places three cheap-model subagent vehicles (haiku/low, read-only
  tools: mechanical-sweep, changelog-skeleton, gate-triage) on the velocity writer discipline;
  the engine canon (`orchestration.md` §5) now names the four **cost lanes** (L0 script · L1
  cheap subagent · L2 bridge · L3 frontier), the cheapest-adequate-executor rule, the
  no-guardrail-no-move rule, and the red lines that never move down; the `procedures` advisor
  renders the lanes at the point of use (additive `costLanes` in `--json`), drift-guarded on
  both sides.
- **The ADR cascade is a script now.** `agent-workflow-memory` ships
  `archive-decisions.mjs` (+ kit fallback mirror, byte-parity-guarded): the chained
  HOT→WARM→COLD `decisions.md` rotation with conservation checks and fail-LOUD refusals (bad
  heading, disordered ids, COLD exhaustion — always before any write); the deployed pre-commit
  hook now runs its `--check`; an absent `decisions.md` is a stated exit-0 skip.
- **Release mechanics live in the repo, not the kit.** New tracked `scripts/release/`:
  `version-sync.mjs` (all version sources per package compared; `--expect`),
  `dispatch-publish.mjs` (ordered per-package `publish.yml` dispatch via gh REST — ALL dry-runs
  green before the FIRST live dispatch, deterministic run correlation, kit LAST, stale
  `--expect` refused against the local tree, npm `@latest` + Release single-asset verification
  with bounded retry, distinct exit codes), and `smoke-init.mjs` (temp-HOME/`npm_config_*`-
  sanitized installer smoke). Wired into CI (unit glob + release-scan target). The kit ships no
  publish/dispatch/marketing logic — the boundary holds.

## 2026-07-02 — engine 1.9.0 · kit 1.26.0 (bridges bundled unchanged at 2.1.0)

- **A returning user's `init`/`upgrade` now leaves no stale bridge behind (all users).** Bridges are
  placed by the opt-in `/agent-workflow-kit setup`; once placed they were refreshed by NOTHING, so
  every bridge release left placed copies lagging silently — and no read-only surface could tell a
  lagging bridge from a current one. Now: `family-registry` compares placed vs kit-bundled versions
  (local files only — nothing checks npm) and reports behind / unknown / current honestly, with a
  tool-composed checked-scope verdict; `npx … init` and `Mode: upgrade` refresh proven-managed
  placed bridges (never place an absent one, never downgrade a newer one — each a stated line;
  `--no-bridges` opts out); the one-line backend-status comes verbatim from
  `recipes.mjs --status-line` instead of being agent-composed. **Both installers stop contradicting
  themselves:** the final verb states what was observed (installed / updated /
  refreshed-the-already-current) and the same-version note states facts — no more false "npx likely
  served a cached build". Kit `1.26.0` + engine `1.9.0`; memory unchanged; bridges bundled unchanged
  at `2.1.0`. AD-034.

## 2026-07-02 — kit 1.25.0 (bridges 2.1.0, bundled)

- **The bridge driving contract, guaranteed at the point of use (all users).** An agent running a
  recipe no longer re-derives how to drive `codex-review` / `agy-review` / `codex-exec` from wrapper
  source — a path that missed documented levers (agy's `--facts`/`--decided` grounding, the
  `agy-review --continue` round-2 delta) and wasted subscription runs. **Bridges 2.1.0:** each
  manifest's dispatchable role carries a machine-readable `contract` (exact invocation descriptors +
  grounding + continue + codex-exec's tiered guarded passthrough), and **all four wrappers answer
  `--help`/`-h` pre-preflight** (no CLI/login/git needed; first-argument-only, passthrough-safe) —
  the three dispatchable ones print the manifest contract; `agy-run` (probe role, never dispatched)
  ships a lightweight wrapper-authored help with no manifest pivot by design. **Kit 1.25.0:**
  `/agent-workflow-kit procedures` renders the full contract VERBATIM under every dispatched backend
  (council/reviewed AND `execute=delegated`); `--json` adds the additive `slots[*].contracts` field.
  Drift-guarded in both directions for the dispatchable wrappers — registry ⟷ manifest
  deep-equality, advisor ⟷ manifest and `--help` ⟷ manifest set-EQUALITY, plus a **source-level
  reverse guard** pinning each dispatchable wrapper's real parser arms to the manifest, so a wrapper
  change without the surfaced contract fails a test. Bridges ship bundled in the kit tarball — no
  separate publish.

## 2026-07-01 — memory 1.7.0 / kit 1.24.0

- **Humanize the deploy/version report (all users).** `/agent-workflow-kit upgrade|bootstrap` (and the
  memory substrate) stop leaking the internal `docs/ai` **structure-version** number into the happy
  path — it was un-actionable and appeared on every success, including no-ops, reading as smaller than
  the npm/GitHub package version. Now a no-op says **settings already current — no update needed**
  (rendered in the user's language) with **no** structure semver / stamp path / head-lineage wording; a
  fresh bootstrap keeps its "deployed and ready" framing. The number survives only where it is
  actionable — the never-downgrade STOP gate, the kit's explicit `Mode: status`, and (memory) an
  explicit user ask — **named "the `docs/ai` structure version"** (never "lineage head"), with a plain
  on-demand two-axes note. **Report-contract (prose) change only:** no logic, no migration, no
  lineage-head bump (stays `1.3.0`); pinned by new static contract tests in both packages.

## 2026-07-01 — engine 1.8.0 / memory 1.6.0 / kit 1.23.0

- **Mechanize the §9 review-loop discipline (all users).** The methodology canon turns the review-loop
  economics from deletable prose into guarded, point-of-use mechanism, so review loops **converge in ≤2
  rounds with a computed crossover signal** instead of churning. **Engine:** `planning.md` §9 gains a
  *Fold minimally* bullet (a self-consistency read; fold in ONE place); `orchestration.md` §4/§5 adds the
  **backend-divergence stop-signal** (divergence — one backend ships while another keeps revising mechanics
  — IS the crossover; it bounds the *rounds*, never drops a ready backend within one); `procedures.md`
  requires a per-round emission **{round N · finding-origin tally · per-backend verdict}** in both
  activities; and an all-mechanics/CI or prose-only artifact is routed at the right altitude via a *thin
  plan + diff-review* carve-out. **Kit:** `/agent-workflow-kit procedures` now prints the **explicit
  backend set** beside each recipe (`review: council → run every backend every round: codex-review +
  agy-review`) and a **review-loop economics block** for reviewed|council, surfacing the discipline where
  the advisor is invoked. Guarded non-vacuously by region-scoped canon tokens + the kit's two-set
  `lens-mirror` drift test; both `agent_rules.md` lenses (kit §2.5 / memory §2.6) carry the disciplines
  byte-identically. Deployment-lineage head stays `1.3.0` (no `docs/ai` migration).

## 2026-06-30 — engine 1.7.0 / memory 1.5.0 / kit 1.22.0

- **Harden the planning canon — process-fidelity + regression-free editing (all users).** Seven
  methodology invariants land in the kit canon and the deployed always-loaded lens, guarded by an extended
  non-vacuous drift test. **Process-fidelity:** *ExitPlanMode ≠ execute* (`planning.md` §6); *recipe
  fidelity* — Council runs every ready backend every round, dropping a ready one is a forbidden silent
  downgrade (`orchestration.md` §4/§5); and a *convergence bar* — a review loop is clean only at **0
  blockers + 0 majors from every named backend** (folding ≠ convergence). **Regression-free editing**
  (`planning.md` §9): *no code-mechanics in the plan*, *test-as-spec*, *characterize-first*, *heavy review
  at the diff*. Both `agent_rules.md` templates carry all seven in a generalized, byte-identical lens
  block; the kit's `lens-mirror.test.mjs` gains two scoped token sets (cross-all-four + template-scoped),
  proven non-vacuous. **engine → 1.7.0**, **memory → 1.5.0**, **kit → 1.22.0**; lineage head stays
  **`1.3.0`**.

## 2026-06-30 — antigravity-cli-bridge 2.0.0 / engine 1.6.0 / kit 1.21.0

- **Antigravity (`agy`) bridge grounded-review hardening.** A dedicated **`agy-review`** wrapper
  mechanizes the grounded-review contract (POSTURE + a model/cutoff GUARD + `--facts` + `--decided` +
  the artifact + a strict output shape), delegating execution to `agy-run` so the hard timeout, the
  subscription invariant, and a new single-argv byte ceiling (`AGY_MAX_PROMPT_BYTES`) live in one place.
  The bridge goes to **2.0.0** (review role → `agy-review`; two PATH wrappers). The kit (**1.21.0**)
  bundles the byte-identical mirror, probes the EXPECTED wrapper set in readiness (a stale install missing
  `agy-review` surfaces **DEGRADED**), and manages both wrappers in `setup` / `uninstall`. The engine
  (**1.6.0**) loosens the Issue-001 caveat — grounded review is a sound second opinion; the real
  service-stall risk is kept. `memory` is unchanged. Lineage head stays **`1.3.0`**.

## 2026-06-29 — engine 1.5.0 / memory 1.4.0 / kit 1.20.0

- **Right-altitude & code-grounded methodology institutionalized in the canon.** Two planning/review
  disciplines — right altitude (pin intent + invariants + acceptance; leave mechanics to Execute) and
  fold-by-code (read + cite the `file:line` before folding a finding), plus the convergence heuristic —
  now live in the engine canon (`planning.md` §9 + a §8 bullet; a terse §9 review-lens pointer in both
  `procedures.md` activities) and the deployed self-review substrate (a §2.x lens in both `agent_rules.md`
  templates). New guards pin them: a cross-package `lens-mirror` (shared vocabulary across all four files
  + the byte-identical template block, non-vacuous), a new engine `planning-canon`, and an extended
  `procedures-canon`. Lineage head stays `1.3.0`.
  - **`@sabaiway/agent-workflow-engine@1.5.0`** — `planning.md` §9 + §8 bullet; `procedures.md` terse §9
    lens in both activities; `test/planning-canon.test.mjs` + extended `test/procedures-canon.test.mjs`.
  - **`@sabaiway/agent-workflow-memory@1.4.0`** — `agent_rules.md` §2.6 lens (path-neutral; byte-identical
    to the kit block).
  - **`@sabaiway/agent-workflow-kit@1.20.0`** — `agent_rules.md` §2.5 lens; cross-package
    `test/lens-mirror.test.mjs` (region-scoped tokens + byte-identical block).

## 2026-06-29 — kit 1.19.0

- **One-command freshness + capability-adaptive `status`.** `npx @sabaiway/agent-workflow-kit@latest
  init` now refreshes the **memory substrate** and the **methodology engine** alongside the kit, so a
  returning user is no longer left with silently stale memory — a memory miss is a **loud DEGRADED
  success** (warning + exact recovery command + exit 0), `--no-memory` skips it, and bridges are still
  placed by `setup`, not `init`. The direct-CLI `status` view is rebuilt as a capability-adaptive
  `surface → view-model → renderers` pipeline (plain/ansi, `NO_COLOR`/`FORCE_COLOR`, width floor,
  ASCII fallback; `--format=<auto|plain|ansi|json>`, loud-reject parse), and the `--json` envelope
  gains an additive structural `installed[].refresh` `{ behind, recommend }`. Lineage head stays `1.3.0`.
  - **`@sabaiway/agent-workflow-kit@1.19.0`** — memory cascade in `bin/install.mjs` (`installMemory`,
    `--no-memory`, crash-proof degraded warning, drift-guarded cascade derived from `FAMILY_MEMBERS`);
    the status-presenter modules `tools/{labels,presentation,surface,view-model,renderers}.mjs` + the
    pure member-table leaf `tools/family-members.mjs`; `formatStatus`/`formatSettings` replaced by the
    pipeline; `SKILL.md` `Mode: status` reads `refresh` (the shared notes-based footers untouched).
  - **`@sabaiway/agent-workflow-memory`** / **`@sabaiway/agent-workflow-engine`** — unchanged, not
    republished (the kit refreshes the already-published versions).

## 2026-06-29

- **Agent-writable orchestration config + durable session/communication contracts (AD-025).** The
  per-project recipe config is no longer hand-edit-only, `setup` surfaces bridge versions, and the
  methodology canon gains read-at-start + a planning Definition of Done + a communication contract that
  reach the existing base via a canonical-refresh. Three packages bumped (lineage head stays `1.3.0`):
  - **`@sabaiway/agent-workflow-kit@1.18.0`** — new `/agent-workflow-kit set-recipe` writer
    (`tools/{orchestration-config,orchestration-write,set-recipe}.mjs`; previews by default; hardened
    atomic write; `procedures` never imports the writer); `setup` bridge-version surfacing + a re-detect-
    after-apply proactive offer + a `status` pointer; `inject-methodology` canonical-refresh + advisory.
  - **`@sabaiway/agent-workflow-engine@1.4.0`** — `references/procedures.md` read-at-start + plan-authoring
    Definition of Done + communication contract; the two slot fragments gain the matching clauses.
  - **`@sabaiway/agent-workflow-memory@1.3.0`** — agent-writable config note in the seed (seeds-when-missing
    / preserves existing; the in-place note refresh is kit-owned); `agent_rules.md` §2.5 Communication.

## 2026-06-27

- **Activity procedures — recipe-aware, configurable playbooks (AD-019).** A bare activity ("write a
  plan", "execute the plan") now has codified, recipe-aware steps + a per-project, user-configurable
  default recipe, composing over the AD-018 recipes (which stay read-only). Three packages bumped in
  lockstep:
  - **`@sabaiway/agent-workflow-engine@1.3.0`** — new `references/procedures.md` activity canon
    (`plan-authoring`, `plan-execution`; typed recipe slots; generic); the methodology slot fragment
    gained the one-line `/agent-workflow-kit procedures` auto-discovery route.
  - **`@sabaiway/agent-workflow-kit@1.14.0`** — read-only **`/agent-workflow-kit procedures <activity>`**
    advisor (`tools/procedures.mjs`): live engine read + `docs/ai/orchestration.json` validation + the
    resolved recipe per slot (graceful default vs loud override degradation). `status` multi-caveat.
  - **`@sabaiway/agent-workflow-memory@1.2.0`** — seeds the user-editable `docs/ai/orchestration.json`
    config (byte-identical to the kit fallback copy; conservative `solo` default + onboarding note),
    ensured stamp-independently on upgrade.

  The deployment-lineage head stays `1.3.0` (no deployed `docs/ai` structural change; no migration).
  Release tags: `agent-workflow-engine-v1.3.0` / `agent-workflow-kit-v1.14.0` / `agent-workflow-memory-v1.2.0`.
  See the per-package changelogs and AD-019.

## 2026-06-25

- **`@sabaiway/agent-workflow-engine@1.0.0` — first publish.** The canonical home of the
  `agent-workflow` planning methodology is now an installable, `available:true` npm package — no
  longer a declared, content-only stub. It ships its own `bin/install.mjs` (symlink-hardened),
  `capability.json` (`detect.installed` + `install.npm`), README/CHANGELOG/LICENSE, and the
  methodology canon (`references/`). The composition root (`agent-workflow-kit`) still consumes a
  byte-identical, drift-guarded mirror of this canon; the live `kit → engine` read and retiring that
  mirror land in the next slice. **No kit/memory republish**, and the deployment-lineage head stays
  `1.3.0` (packaging changes only the npm axis). Release tag: `agent-workflow-engine-v1.0.0`. See
  [agent-workflow-engine/CHANGELOG.md](agent-workflow-engine/CHANGELOG.md) and AD-015.

## 2026-06-22

- **`agent-workflow-kit@1.6.0` — methodology slot reconciliation + engine becomes the canonical
  methodology home.** `agent-workflow-engine` (still `available:false`) is now the single source of
  truth for the planning methodology; the kit keeps byte-identical mirror copies, pinned by a
  drift-guard test. The kit gains a stamp-independent `reconcile` operation (`ensureSlot` /
  `reconcileSlot`) that ensures the `workflow:methodology` slot exists and is filled on bootstrap +
  every upgrade — reaching legacy `1.3.0` deployments **without** bumping the deployment-lineage
  head. The kit fallback template now ships the empty slot. `agent-workflow-memory` is unchanged (no
  republish). See [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md) and AD-010.

## 2026-06-21

- **First publish from the monorepo.** Released `@sabaiway/agent-workflow-memory@1.0.0` (initial
  standalone release of the memory substrate) and `@sabaiway/agent-workflow-kit@1.4.0` to npm,
  both with build provenance, in that order (the kit may delegate to memory at deploy time).
  Release tags: `agent-workflow-memory-v1.0.0`, `agent-workflow-kit-v1.4.0`.
- **Root CI workflows added** under `.github/workflows/`:
  - `publish` — manual dispatch for `memory`, `kit`, or `both` (with `dry_run`); runs the
    per-package preflights + provenance publish via the reusable `_publish-one`, always
    memory → kit.
  - `stats` — daily snapshot of per-package npm downloads plus shared repo signals into
    `stats/history.csv`.
  - `unpublish` — guarded admin unpublish with a `memory | kit` selector.

## Earlier

The family was refactored out of the standalone `agent-workflow-kit` project into this monorepo:
the memory substrate was extracted into its own package and the kit became the composition root
(detect-and-delegate, with a bundled fallback). For package history before the monorepo, see the
per-package changelogs linked above.
