# Changelog — agent-workflow (monorepo)

Repo-level history for the **agent-workflow** family monorepo. Each published package is
versioned **independently** — see its own changelog for package-level detail:

- `@sabaiway/agent-workflow-kit` → [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md)
- `@sabaiway/agent-workflow-memory` → [agent-workflow-memory/CHANGELOG.md](agent-workflow-memory/CHANGELOG.md)
- `@sabaiway/agent-workflow-engine` → [agent-workflow-engine/CHANGELOG.md](agent-workflow-engine/CHANGELOG.md)

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
