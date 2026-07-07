# Changelog — agent-workflow-kit

Semantically versioned ([semver](https://semver.org)), newest first. The `version:` in `SKILL.md`
is the current release. `upgrade` mode reads a project's `docs/ai/.workflow-version` and applies
every `migrations/<version>-<slug>.md` newer than it, in semver order.

## 1.37.0 — Fold-safety completion: a fixable-bug requires its test, and a coverage gate attests the fold against the changed code (AD-046)

A **feature** release (deployment-lineage head stays `1.3.0` — no migration). AD-045's ledger computed
WHEN a review loop stops; this release mechanizes **"a fold carries no new bug"** — M2 + M3a of
DEBT-TEST-COMPLETENESS. **No mutation testing ships** — that half was researched and shelved (see the
honest-limits note below).

- **M2 — testId enforcement (ledger schema v2).** A `fixable-bug` triage classification now REQUIRES a
  `testId` (`<test-file>#<test-name-pattern>` — a `#` separator with both halves non-empty; the writer
  validates FORMAT only, staying hermetic). Schema 1→2 with per-version validation: historical v1
  records stay valid on read, a mixed ledger reads back clean; the writer emits v2 only; `decideStop`
  is untouched.
- **M3a — the fold-completeness tool pair (read/run split, mirroring the ledger's read/write split).**
  `tools/fold-completeness-run.mjs` — the SOLE tree-toucher + result writer: ONE suite run under
  `NODE_V8_COVERAGE` (the coverage dir lives OUTSIDE the work tree), the changed surface classified by
  a CLOSED extension rule (assessable JS · unsupported TS/JSX fails the gate closed · out-of-domain
  docs/config listed loudly, never blocking), every bound testId probed shell-free for resolvability +
  a GREEN baseline, and ONE machine-only record bound to BOTH the tree fingerprint AND the sorted
  fixable-bug testId set — either moving makes the record stale. `tools/fold-completeness.mjs` — the
  read-only `--status` / `--check` gate (fail-closed; the normative exit contract lives in its header,
  the single home) that never imports the runner (import-split test).
- **Command surface** — the `fold-completeness` catalog entry (a writer) + `### Mode: fold-completeness`
  + its mode reference. **Consumer seeding is deliberately ON HOLD**: the signal is JS/V8-only in v1,
  so the consent-gated seeder does not offer this gate yet — wire it by hand (the mode-ref carries the
  candidate `gates.json` line and the hold's reason).
- **Activity-aware canon pointer (with engine 1.14.0)** — the procedures advisor renders the ledger
  pointer (record / `--status` / `--check`) for `plan-execution` ONLY, plus an unconditional
  triage-classification bullet (`fixable-bug / inherent-layer-residual / escalate`) for every
  review-backed activity.
- **Honest limits (stated in the tool headers, like `review-state`'s):** coverage proves EXECUTION, not
  assertion — the per-fold proof remains the red→green test discipline (M2), the coverage run is the
  whole-surface prefilter; records/testIds are forgeable (a self-discipline mechanism, not a security
  boundary); line-entry granularity (same-line branch gaps are out of scope without an AST).
  **Mutation (M3b) was researched and SHELVED** — bounded local-boundary mutation did not catch the
  motivating interaction bug and is not language-independent; records carry a reserved EMPTY `mutation`
  shape and the checker fails CLOSED on any record carrying mutation data.

## 1.36.0 — Review-round ledger: the prose crossover-stop becomes a computed signal (AD-045)

A **feature** release (deployment-lineage head stays `1.3.0` — no migration). The review-loop
crossover-stop that `planning.md` §9 and `procedures.md` describe in prose — "cap ≤2 rounds", the
crossover, "fold-at-altitude vs residual", "{round N · finding-origin tally · per-backend verdict} …
a computed signal, not a remembered rule" — was **prose with no checker** and broke under load. This
ships it as a **mechanism** (DEBT-REVIEW-CAP): a review-round **LEDGER** that protects every consumer
project's `plan-execution` review loop.

- **`tools/review-ledger.mjs`** (read-only) — the record schema (two kinds, `round` / `triage`,
  internally-consistency-validated), a tolerant reader (malformed lines counted + surfaced, never
  dropped), the pure **`decideStop`** truth table returning exactly one state under a fixed precedence
  (**converged > resolved-residual > triage-required > continue**) from machine fields only, the
  integrity receipt cross-check, and the **`--check`** gate — **fail-CLOSED** on every unknown state
  (detector failure · unreadable / malformed ledger · a corrupt round sequence · more than one plan
  in flight).
- **`tools/review-ledger-write.mjs`** (the sole writer, over the hardened `atomic-write` core) —
  `record` / `classify` with **the teeth**: it refuses a round while triage is required, beyond the
  hard-max ceiling of 3, or without a grounded review receipt, and enforces round-sequence integrity +
  round-bound classifications. The read/write split is pinned by an import-split test; the ledger lives
  in the git dir (uncommittable by construction, mirroring the receipts precedent).
- **Command surface** — a `review-ledger` catalog entry + `### Mode: review-ledger` + its mode
  reference; the conditional `seed-gates` candidate (offered only when `plan-execution.review` is
  reviewed / council).
- **Honest residual** (stated in the tool header, like `review-state`'s): the ledger attests a review
  occurred and its ship-class is consistent; it does not prove the recorded counts are truthful nor
  that a self-reported `degraded` is real — a self-discipline mechanism, not a security boundary.

Self-arming dogfood: this release's own review loop was recorded through the ledger it builds
(`--check` exits 0 via the `converged` branch). The optional per-fold `testId` slot exists but stays
**unenforced** — enforcement + a fold-completeness signal + the canon-pointer mechanization are the
next plan (DEBT-TEST-COMPLETENESS).

## 1.35.0 — Host-level bridge settings surface + Codex Fast tier as configuration (AD-043)

A **feature** release (deployment-lineage head stays `1.3.0` — no migration). Bridge knobs like the
Codex Fast tier are now enabled **through a host-level settings file that survives kit upgrades**,
never re-researched and re-patched per host; the kit surfaces, reconciles, and honestly refreshes
that surface. Ships **bridges 2.3.0** inside the tarball (the four wrappers' shared settings-reader
block + the `CODEX_SERVICE_TIER` knob + the typed `settings` manifest schema, Phase 1). The kit
machinery (Phase 2):

- **`bridge-settings` mode — the host-config reader + consent-gated writer.** New
  `tools/bridge-settings.mjs` (+ its read-only core `tools/bridge-settings-read.mjs`) reads/writes
  `${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf` — a `KEY=VALUE` file **outside
  every kit tree** (D2, upgrade-survival is structural). Previews by default, `--apply` writes via a
  hardened out-of-tree atomic core (`writeContainedFileAtomic` / `writeHostConfigFileAtomic`,
  factored from `atomic-write.mjs` — symlink/parent/TOCTOU-safe, dir created on first use). The
  allowlist + typed validation come from the **bundled bridge manifests** (`settings` blocks,
  manifest-as-source / D6 — `settingValueValid` is now the single shared predicate). It refuses an
  unknown key, an out-of-range/invalid value, and — loudly, naming the key — a duplicate-carrying
  file; model/effort stay unsettable (the quality guard is untouched, D4). Routed in `SKILL.md`
  (`guarded` kind) with `references/modes/bridge-settings.md`.
- **Refresh overwrite honesty (D5).** `tools/setup-backends.mjs` now byte-compares a placed bridge
  against the bundle on an equal-version re-sync and **states** the local edits it overwrote (file
  list + the settings-file pointer), instead of the old silent wipe; a version upgrade never cries
  wolf about the version delta, an unreadable placed file degrades honestly, a placed-only extra is
  preserved and never claimed as loss.
- **Init/upgrade reconcile.** `init` (`bin/install.mjs`) and `Mode: upgrade` run
  `bridge-settings --reconcile` after the bridge refresh: every settings-file key is validated
  against the new bundled manifests; an unknown/retired key is a loud flag, **preserved verbatim**
  (never edited — the lens-region posture).
- **Status + advisor surfaces (fact-only).** `status`' execution-backends block, the `procedures`
  driving-contract render, and `recipes --status-line` now surface the active knobs (env>file>default)
  and each wrapper's settable knobs — fact-only, no model claim, localized-on-error; the status line
  stays byte-identical unless a knob is active.
- Parity + budgets: new `test/settings-reader-parity.test.mjs` pins the reader block byte-identical
  across the four wrappers; the always-loaded router stays `≤ 10240 B` (the equal-head reconcile
  enumeration was trimmed to its step-3 pointer to make room for the new mode); the `routerPlusMode`
  budget is re-pinned `29696 → 30720` (documented) for the reconcile paragraph added to `upgrade.md`.

## 1.34.0 — Onboarding UX: one batched setup prompt, honest installer messaging, the visible accelerator funnel, and the consent-gated gates seeder (AD-042)

A **feature** release (first-contact flow + a new consent-gated writer; deployment-lineage head
stays `1.3.0` — no migration). First contact now interrupts once instead of three times, the
opt-in accelerators are discoverable from every happy path, and a project's own verification
commands can be seeded into `docs/ai/gates.json` behind an explicit per-entry yes:

- **F11 — ONE batched setup prompt.** Bootstrap asks the three setup questions (visibility /
  conversational language / attribution) as one structured multi-question prompt where supported
  (`AskUserQuestion`, up to 4 questions per call), records each answer individually, and writes
  nothing until all are answered (`references/modes/bootstrap.md` preamble + steps 2–4;
  `references/contracts.md` · `references/shared/deploy-tail.md` · `launchers/windsurf-workflow.md`
  reworded to match). Upgrade batches its two migration asks the same way ONLY when BOTH
  `AGENTS.md` blocks are missing (a pre-1.1.0 deployment), collects them in step 6 BEFORE the
  migrations apply, and never re-asks a collected answer (`references/modes/upgrade.md`); the four
  migration files are untouched — their own ask stays the standalone fallback. New
  `test/ask-contract.test.mjs` pins the wording across all 7 files and holds the kit↔memory
  `references/contracts.md` ask paragraph byte-identical (a hand-lockstep pair, deliberately not a
  sync-mirrors family).
- **F12 — the installer says what a returning user needs.** `bin/install.mjs` prints a restart
  hint on every run over a PRE-existing install ("restart the session so the agent reloads the
  refreshed kit files") — on the verb path, at most once per run, surviving even the fatal
  engine-install abort — and replaces the false "Claude Code / Codex / Devin Desktop all use the
  same /agent-workflow-kit" claim with the real per-agent matrix (Codex invokes via its `/skills`
  menu and may auto-trigger) in `--help` AND the final next-steps block. Pinned in
  `bin/install.test.mjs`.
- **F10a — the opt-in funnel is visible.** The welcome-mat ladder
  (`references/shared/report-footer.md`) gains caveat-aware rungs: velocity when the allowlist is
  unseeded, `agents` when no cheap-lane vehicle is placed, `hook` when gates are DECLARED
  (non-empty — file presence alone would misfire on the empty seed) but the hook is unwired; the
  two new signals ride the existing status envelope (`tools/family-registry.mjs`
  `surveyCheapAgents` + `surveyGateHook.declaredGates` → `tools/view-model.mjs` →
  `tools/renderers.mjs` — no new helper call). Bootstrap step 11 ends on a compact
  optional-accelerators block (velocity · agents · gates seeding + hook · set-recipe;
  preview-first, nothing runs without a yes), and `help` output gains a matching "Tune" tail
  (`tools/commands.mjs` — no new mode, no new kind; the router SKILL.md is untouched). New
  `test/report-footer-rotation.test.mjs` pins one shorthand ladder literal across
  upgrade + bootstrap; the `gate-approve-hook` fixture is refreshed to the live 10-gate shape.
- **F10b — the consent-gated `gates.json` seeder (the seeding↔hook trust chain).** New
  `tools/seed-gates.mjs`: dry-run by default (prints the derived `{ id, title, cmd }` entries,
  writes NOTHING; declining leaves the file byte-identical); `--apply [--only <id>]…` appends
  exactly the consented entries — append-only (never modifies or removes an existing entry),
  id-collision refusal, validator-checked (it imports the runner's `validateDeclaration`; the
  runner never imports it), stamp-gated apply, and OUTSIDE every velocity tier (a consent-per-run
  writer is never pre-approved). Offered candidates are terminating verification classes only
  (test / lint / type-check / build) — release/publish/deploy scripts, watch/serve modes, and
  MUTATING variants (`lint:fix`, `test:update`, bodies carrying `--fix`/`--write`/`-w`/`-u`)
  never enter the offer; commands are package-manager-aware (npm/pnpm/yarn). The review-state
  candidate is included ONLY when `docs/ai/orchestration.json` declares reviewed/council on
  `plan-execution.review` (the slot the checker enforces), with the resolved QUOTED path. Every
  preview prints the trust-chain disclosure: the hook auto-approves byte-exact declared commands —
  seeding and hook wiring are two separate consents. The hardened atomic write core is extracted
  into `tools/atomic-write.mjs` (exclusive-create tmp+rename, TOCTOU re-check, symlink STOPs) and
  shared with `tools/orchestration-write.mjs` (public API unchanged). The consent-seed protocol
  lives in `references/modes/gates.md`; `references/modes/review-state.md` step 3 now names the
  seeder path ("by hand OR the explicit-consent seeder — never without consent").
- **AD-039 amendment (documented, AD-042):** `test/router-contract.test.mjs` `routerPlusMode`
  28672 → 29696 — the F11 upgrade batching caveat is +422 B of new contract text against 154 B of
  headroom; the router itself is byte-identical. Tarball 116 → 118 files
  (`test/package-content.test.mjs` count + payload pins for the seeder pair).

## 1.33.0 — The agent-rules lens region: render + reconcile from the engine canon (AD-041)

A **feature** release (new shipped tool + wiring; deployment-lineage head stays `1.3.0` — the
refresh is stamp-independent, no migration). The deployed `docs/ai/agent_rules.md` lens section
is now a RENDER of the engine's canonical fragment, kept current by the kit:

- **New `tools/lens-region.mjs`** — the lens reconcile: heading-anchored region (no markers; a
  renamed heading is a natural preserve+advise), render with the file's OWN section number,
  refresh IFF the body matches the engine fragment or a known-prior body (fragment + prior store
  read LIVE from the installed engine — no kit-side prior constants), a customized region
  preserved verbatim + a one-line advisory, cap-guard from the target's frontmatter `maxLines`
  (loud non-fatal refusal; no frontmatter → stated skip), atomic write, document EOL preserved.
  Lazy + fail-loud: an absent/invalid engine is a STOP with the install command; a valid engine
  older than 1.13.0 (no lens pair) is a stated soft skip. CLI:
  `node tools/lens-region.mjs reconcile <path/to/agent_rules.md>`; invariants pinned by
  `tools/lens-region.test.mjs` incl. the canon-change simulation (v1 deploy + v2 engine →
  refreshed; re-run → zero-diff).
- **`Mode: upgrade` step 3** gains the SEVENTH stamp-independent reconcile (plain-language
  outcomes: refreshed / already current / custom preserved + note / file absent / engine too
  old / over the line cap), reported in both the step-4 and step-8 exit reports; the stale
  "other three reconciles" phrasing went count-free.
  `references/shared/composition-handoff.md` runs the same reconcile in BOTH bootstrap paths
  (its own precondition: after `docs/ai/agent_rules.md` exists) — this is what converges a
  stale-memory seed; `handoffPlan` names the lens region in `kitWrites` for both paths.
- **`family-registry`**: a distinct plain-language `status` caveat for an engine that does not
  ship the lens canon — keyed on the PAIR (fragment + prior store), so a half-shipped engine
  never reports healthy.
- **`test/lens-mirror.test.mjs` REWRITTEN** to render-parity vs the known-canonical set (each
  template lens block byte-equals a render of the engine fragment or a prior-store entry; the
  checkout additionally pins the CURRENT render; injected non-vacuity). The 22-token × 4-file
  vocabulary mesh is deleted — token presence now lives in the ENGINE's own lens-fragment guard,
  so a future lens wording change is an engine-only release (no forced kit/memory diffs).
- `references/templates/agent_rules.md` §2.5 intro carries the provenance clause (the render);
  `tools/engine-source.mjs` exports `LENS_FRAGMENT_REL` + `LENS_PRIORS_REL`. Tarball 115 → 116
  (`lens-region.mjs` reverse-pinned). AD-039 byte budgets hold unchanged.
- Repo-local release harness: `scripts/release/smoke-init.mjs` gains repeatable
  `--expect-file <sandbox-HOME-relative path>=<substring>` (installed-file content assertions;
  both path dialects fenced to the sandbox HOME).

## 1.32.0 — Approval-idle reduction: the opt-in `velocity --kit-tools` tier, an audited core extension, and the standing-consent advisory (AD-040)

A **feature** release; packaging-only for deployments (lineage stays `1.3.0` — no `docs/ai`
structure change, no migration). Routine read-only kit-tool invocations — the session-start
discovery line, the procedures advisor, the status/backends/gates checks — stop idling on
approval prompts, opt-in and honestly labeled; nothing that writes, commits, or publishes gets
any quieter.

- **`velocity --kit-tools` (opt-in tier).** On top of the read-only core, seeds 12 entries derived
  from the RUNNING skill's own location at seed time: 8 read-only kit tools as resolved-absolute
  script path + args wildcard (`recipes` / `procedures` / `family-registry` / `detect-backends` /
  `commands` / `review-state` / `manifest/validate` / `release-scan`), `run-gates.mjs` as ONE
  exact byte-string pinned `--cwd <resolved project root>` and advertised **project-exec, never
  "read-only"** (a wildcard would be broader than the AD-037 hook boundary), and the three
  default-dry-run writers' exact arg-free preview byte-strings (`velocity-profile`,
  `cheap-agents`, `gate-hook`) — every `--apply`/`--write`/`--yes` still prompts. Fail-safe by
  construction: a moved skill or stale path simply prompts again; non-POSIX / space- /
  quote-carrying paths are refused up front with a typed error (hand-add fallback). Flagless
  `velocity` behavior is unchanged (validates core-only, never depends on skill paths).
- **Dead-rule prevention as a test.** The `velocity.md` tier subsection lists the covered dispatch
  line per tool (the documented-invocation source); the new `test/kit-readonly-tools.test.mjs`
  substitutes the resolved skill dir (+ project root for run-gates) into each line and asserts the
  seeded byte-form matches (prefix for wildcard, equality for exact) — plus the tier ↔
  `commands.mjs` catalog-partition guard (run-gates the only project-exec member; the two
  non-mode-backed validators get a writes-nothing source assertion).
- **Audited read-only core 18 → 31 (the AD-021 empirical method, probe record in AD-040).**
  Survivors: `diff`, `stat`, `du`, `basename`, `dirname`, `realpath`, `git rev-parse`,
  `git blame`, `git shortlog`, `git describe`, and the FIXED forms `git tag --list`,
  `git stash list`, `git worktree list` (their bare forms mutate — probe-proven). FAILED and
  excluded: `file` (`-C -m` compiles a magic FILE WRITE) and `git cat-file` (`--textconv`/
  `--filters` run configured filters; `git show` already covers the reads). The PreToolUse hook's
  `SEEDED_READONLY_CORE` extends in LOCKSTEP (order-sensitive parity guard); an already-placed
  hook keeps the OLD core (a strict subset) until a delete-to-reseed refresh.
- **Sharper pre-existing advisory.** `node …`-shaped allow entries OUTSIDE the derived tier
  (foreign script path, foreign `run-gates --cwd` root) are now flagged for hand review — the
  tier's shape can never hide arbitrary local JS.
- **`set-recipe` standing-consent advisory (wording-only).** After a `--write` that names a
  reviewed/council recipe, the mode file now advises the one-time HAND-adds
  (`codex-review` / `agy-review` / `grounding.mjs`) to `settings.local.json` — stating plainly
  that auto-approval spends subscription quota without a per-run prompt, the kit never writes
  that file, and the entry must match the invocation byte-form including quoting. Solo recipes
  get no advisory; the tool echo is untouched.
- **Honesty floor, twinned.** The velocity residual notice + its `velocity.md` prose mirror now
  both carry the approval floor: every writer apply-class flag still prompts, clobber-protection
  STOPs still stop, the three release asks (commit/push/publish) stay maintainer-owned.

## 1.31.0 — Progressive disclosure: SKILL.md becomes a thin router over references/modes + references/shared (AD-039)

A **feature** release; packaging-only for deployments (the deployment lineage stays `1.3.0` — no
`docs/ai` structure change, no migration). The 112,106 B / 680-line SKILL.md monolith — loaded
whole on EVERY invocation — becomes a **10,139 B router** plus per-mode files, so an invocation
reads only what it needs:

- **The router** keeps the always-needed core: the composition-root decision (detect → delegate /
  fallback + the init refresh-cascade), the safe-routing rule + version-status routing note, and
  16 bare `### Mode:` headers each carrying ONE line — the catalog `kind` EXACTLY + ``read
  `${CLAUDE_SKILL_DIR}/references/modes/<mode>.md` before acting.``
- **`references/modes/<key>.md` ×16** — the mode bodies, moved verbatim (set-equality-guarded
  against the `tools/commands.mjs` catalog). **`references/shared/`** — the point-of-use
  contracts: `report-footer.md` (backend-status line · version block + welcome mat · version
  disclosure), `composition-handoff.md` (hand-off + bounded pointer reconciliation),
  `deploy-tail.md` (Gotchas · Setup contracts · System principles · Hard-Constraints template).
  Each mode file opens with one `Requires:` line naming its shared reads (bootstrap/upgrade → all
  three; status → the report footer; the daily modes none).
- **Byte budgets are acceptance, not vibes** — the new `test/router-contract.test.mjs` asserts,
  over the real files: router ≤ 10,240 B · router + any mode ≤ 28,672 · every full read set
  ≤ 53,248 · the daily no-shared modes ≤ 16,384 (realized: 10,139 · 27,392 · 48,419 · 14,121 —
  a daily `help` run is ~10× lighter, the worst path (`upgrade`) ~2.3×). It also pins the D4
  pointer audits permanently: every `Requires:` resolves, zero italic/plain cross-mode refs, zero
  bare kit-relative links, moved shared-section references carry their pointer.
- **Nothing else moved:** runtime routing untouched (`routeInvocation` never reads SKILL.md);
  packaging additive (`references/` already rides `files[]`; the npx installer copies it
  recursively; tarball 96 → 115 files, exact-count-pinned); frontmatter byte-compatible with the
  twin version readers; 7 content-coupled guards re-anchored to the new files.

## 1.30.0 — Review-recipe enforcement: the configured recipe is impossible to miss, "reviewed ≠ shipped" is detectable, grounding is a command (AD-038)

A **feature** release (ships the bundled bridges refreshed to **2.2.0**). Origin: a real
council-substitution incident + independent kit-user feedback — the configured review recipe could
be silently skipped, downgraded, or run before later edits, and nothing could detect it. Three
mechanisms, each self-firing at its point of use:

- **The discovery line** — `tools/recipes.mjs --active-line` (`Mode: recipes`): exactly ONE
  machine-composed line rendering the **CONFIGURED** recipe of every activity/slot from
  `docs/ai/orchestration.json` + live readiness — source labeled, degradation stated, wrapper set
  named, explicitly contrasted with the readiness recommendation (which is informational). Wired
  where a session already reads: the deployed `agent_rules.md` §1.1 gains step 2 (read the
  orchestration config BEFORE picking a task; a silent recipe downgrade is a forbidden
  substitution) and `handover.md` gains a standing **"Active recipes:"** slot — both template
  regions byte-identical with the memory copies (new `test/template-region-parity.test.mjs`,
  injected-divergence non-vacuous); `set-recipe` now ECHOES the freshly composed line + a
  handover-slot reminder after every successful `--write` (additive `activeLine` field in
  `--json`). New `test/active-recipe-line.test.mjs` proves the line derives from the CONFIG, not
  the recommendation.
- **`/agent-workflow-kit review-state`** (`tools/review-state.mjs`, read-only + colocated tests) —
  makes "reviewed ≠ shipped" mechanically detectable. The 2.2.0 review wrappers append one JSONL
  receipt per SUCCESSFUL review to `<git dir>/agent-workflow-review-receipts.jsonl`
  (`AW_REVIEW_RECEIPTS` overrides; never committable by construction); the checker resolves the
  effective `plan-execution.review` recipe, recomputes the canonical **uncommitted-state
  fingerprint** (sha256 over staged diff + unstaged diff + untracked-not-ignored contents — exactly
  the review-payload domain), and `--check` exits 0 only when every recipe-named backend holds a
  **fresh, grounded, current-fingerprint** receipt (**presence, not unanimity** — verdicts stay
  orchestrator judgment). Any later edit stales the receipts; plan/diff receipts and continuations
  (`fresh:false`) are informational-only — after a fold, only a fresh grounded re-run restores
  green. Normative exit contract in the tool header; plan-in-flight detector keyed on the
  documented `docs/plans` naming convention; honest residual stated (`--no-verify`, receipt-file
  deletion — discipline, not a sandbox). The gate line is **never auto-seeded** ([[AD-021]]): the
  template `gates.json` stays empty; the candidate line lives in `Mode: review-state`/`Mode: gates`
  prose. New `test/review-fingerprint-parity.test.mjs` proves bash (both wrappers, byte-identical
  block) ↔ node fingerprint parity — hash, serialization, AND behavioral domain equality.
- **`/agent-workflow-kit grounding`** (`tools/grounding.mjs` + colocated tests) — the
  grounded-review facts assembler, catalogued honestly as a **WRITER**: `--constraints` slices the
  root `AGENTS.md` Hard-Constraints section verbatim (exactly-one-match, else a loud STOP);
  `--plan <path>` extracts the decision-bearing sections (`## Approach` + `## Verification`
  required, `## Decisions (locked)` when present; duplicates STOP); output honors the wrapper's
  `AGY_MAX_PROMPT_BYTES` budget minus `--reserve-bytes` with a loud tail-trim; `--out` accepts only
  gitignored / out-of-repo scratch (a tracked or in-repo not-ignored path is refused — a new
  untracked file would move the fingerprint it grounds). `procedures.mjs` renders the invocation as
  a POPULATED pre-step whenever agy is dispatched (exactly one plan in flight → its path; else a
  placeholder + discovery caveat; additive `groundingPreStep` in `--json`).
- **Bundled bridges 2.2.0** (mirrors byte-refreshed): `codex-review.sh` mandates + parses ONE
  literal `Verdict: ship|revise|rethink` line (schema mode reads the JSON field); `agy-review.sh`
  records the `### Verdict` token verbatim (SHIP / SHIP WITH NITS / REWORK), `grounded` +
  `factsHash` from `--facts` (an empty payload is visible), and marks continuations `fresh:false`
  with a one-line fresh-run notice; a receipt write failure warns and never fails the review. The
  review-role `capability.json` contracts gain the `receipt` block (the fingerprint definition
  home) — three-way lockstep wrapper `--help` ↔ manifest ↔ `detect-backends.mjs` registry,
  drift-guarded.
- **Catalog/report wiring:** two new SKILL modes + README rows; the bootstrap/upgrade report
  footers paste the active-recipe line beside the backend-status line; `package-content` pin
  94 → 96 (the two new tools).

## 1.29.0 — Velocity scope C: an opt-in PreToolUse gate-approval hook

A **feature** release (ships the bundled bridges unchanged at **2.1.0**). The shipped, probe-proven
closure of the velocity trust-posture residual ([[AD-021]] scope C, recorded in **AD-037**) — a
new opt-in `.claude/` writer, the family's third:

- **`/agent-workflow-kit hook`** (`tools/gate-hook.mjs`) — places a **self-contained** hook runtime
  (`references/hooks/gate-approve.mjs` → `.claude/hooks/agent-workflow-gates.mjs`; no kit imports, so
  the placed copy survives an uninstall) and wires ONE `PreToolUse` "Bash" entry into
  `.claude/settings.json`. Velocity writer discipline verbatim: `--dry-run` default, deployment-gated
  `--apply`, symlink-safe, refuses unsafe modes in either settings file, merge-don't-clobber,
  idempotent, never `settings.local.json`, never commits. Place-file-FIRST-then-wire; a malformed
  existing `hooks` shape or a diverged-and-unwired target file is a STOP with zero writes (it refuses
  to wire an unknown script as a hook); the target is re-verified no-follow immediately before wiring.
- **The hook's decision ladder**, read against `docs/ai/gates.json` LIVE per call (one declaration,
  two consumers with *Mode: gates* — editing gates.json never needs re-wiring): **(a)** a command
  BYTE-EXACT to a declared gate `cmd` (trim-only; never a pattern — the rejected AD-021 shape),
  invoked from the project root, under `default`/`acceptEdits` → `allow`; **(b)** a seeded-read-only
  command carrying a documented runtime residual (output redirection, command/process substitution
  `$(…)`/`` ` ``/`<(…)`, or the `--output` write-flag family — matched as a whole-command substring so
  a quoted/escaped form can't hide it) → `ask`, overriding a settings allow rule (**proven live** on
  Claude Code 2.1.185); **(c)** else no decision. Never `deny`. Fail-safe is **decoupled**: a broken
  `gates.json` disables only (a), the guard keeps running; every anomaly exits 0, never 2. Validation
  parity with the runner (`_README` included) — an invalid declaration approves nothing.
- **Integration.** `/.claude/hooks/` joins the hidden-mode footprint registry; `uninstall` gains the
  hook seam (reports the settings edit + preserves a still-wired or non-bundle file, removes only a
  byte-identical unwired one and cleans an emptied `.claude/hooks/`, all lstat-no-follow + AD-011
  preflight; the wired-probe reads DECODED settings JSON so an escaped `\/` path still counts as
  wired); `status` gains one row (wired / file placed / declaration present) through the full
  surface→view-model→renderers pipeline; the velocity residual notice + SKILL/README point at the
  shipped hook instead of a "deferred" one. Kit-only; the runtime + writer ride the tarball.
- **Review.** Council at the diff converged over four rounds (codex + agy, grounded): every finding
  closed one obfuscation-of-a-string-scan class (process substitution, quoted/escaped `--output`,
  JSON-escaped `\/`) or a TOCTOU/symlink window — folded by code with red→green regressions; the
  final round was codex **ship** + agy **SHIP**, 0 blockers / 0 majors.

## 1.28.0 — Lens-mirror guards the checked-vs-unchecked plan boundary

A **feature** release (template + test only; ships the bundled bridges unchanged at **2.1.0**).
The kit's half of the §9 sharpening:

- **`references/templates/agent_rules.md` (B5)** — the byte-identical sharpened lens bullet (see
  the memory 1.9.0 entry): a plan carries only checked syntax plus literal fixture/schema
  fragments a named test validates; un-run, logic-bearing syntax never lives in plan prose.
- **`test/lens-mirror.test.mjs`** — Set-1 gains the two new tokens `checked syntax` +
  `logic-bearing`, pinned inside the lens region of all four files (engine planning §9, engine
  procedures, both templates); template byte-identity unchanged; non-vacuity proven by an
  injected red→green (a broken token fails the guard twice over — region + byte-identity).

## 1.27.0 — Cost-tiered execution: the `gates` runner + the `agents` cheap-lane writer

A **feature** release (ships the bundled bridges unchanged at **2.1.0**). Two new modes move
mechanical work off the frontier lane — one batches every project gate into a single exit code,
the other places cheap-model subagents for extraction work:

- **`/agent-workflow-kit gates`** (`tools/run-gates.mjs`) — the **generic project gate runner**:
  reads the project-declared `docs/ai/gates.json` (`{ id, title, cmd }`, strict schema, unknown
  keys rejected — the declaration names WHAT to check, never who executes it), runs each `cmd`
  as ONE bash line from the project root, prints a per-gate PASS/FAIL table + one
  machine-readable summary line, exits 0 iff all green. A failing gate's own output is preserved
  verbatim; `--only <id>` re-runs a subset; **honest distinct outcomes** for a missing (exit 3,
  recovery named), empty (4), or malformed (5) declaration and a bash-less host (6) — never a
  silent green. Trust posture stated: it executes the project's OWN declared commands — a
  batching convenience, not a sandbox. 33 hermetic tests + one real-spawn brace-glob fixture.
- **`/agent-workflow-kit agents`** (`tools/cheap-agents.mjs`) — the opt-in **cheap-lane subagent
  writer** (the second `.claude/` writer, on the velocity discipline: dry-run default,
  deployment-gated `--apply`, symlink STOPs, never `settings*.json`, never commits). Places
  three bundled vehicles (`references/agents/`): `mechanical-sweep`, `changelog-skeleton`,
  `gate-triage` — each pinned `model: haiku` + `effort: low` + read-only tools (content-tested).
  A diverged existing file is **preserved and reported, never overwritten**. Claude-Code-specific,
  like velocity.
- **`gates.json` seeded everywhere** — `references/templates/gates.json` ships byte-identical in
  kit + memory (template-parity guard); bootstrap seeds it; upgrade **ensures-if-missing from
  the kit's OWN twin** (a stale memory never silently loses the feature) and preserves an
  existing declaration byte-for-byte. Also new on upgrade: a stamp-independent
  **enforcement-script ensure** seeds a missing `archive-decisions.mjs` pair into deployed
  projects (the kit's byte-identical fallback mirror of the memory canon — pinned by the new
  `test/scripts-mirror.test.mjs` across ALL shared reference scripts).
- **The advisor now routes by cost** — `procedures.mjs` renders an unconditional **cost-lanes**
  block (L0 script · L1 cheap subagent · L2 bridge · L3 frontier; cheapest adequate executor; no
  guardrail → no down-move; the red lines) + an additive `costLanes` field in `--json`,
  drift-guarded against the engine canon on both sides. One byte-identical cost-lane bullet
  joined both `agent_rules.md` templates (lens-mirror tokens + an injected red→green non-vacuity
  proof).
- **Footprint registries** — `KNOWN_FOOTPRINT` += `/.claude/agents/` (the vehicles stay
  invisible in a hidden deployment); `KIT_OWN_PATHS` += the two deployed decisions copies;
  snapshots + the `contracts.md` mirror row updated in lockstep. Tarball re-pinned (92 files,
  reverse pins for every new asset).

## 1.26.0 — Deterministic bridge freshness & delivery; machine-composed status line; honest installer messaging

A **feature** release (ships the bundled bridges unchanged at **2.1.0**). One architecture across
four fixes: **the registry computes, the tools speak, the agent pastes** — no factual line on these
surfaces is agent-composed anymore.

- **Bridge freshness is now visible.** `family-registry` compares each placed bridge against the
  kit-bundled mirror (both local files — nothing checks npm): behind → a plain caveat + the runnable
  `/agent-workflow-kit setup` recommend + `refresh.behind:true` in `--json`, reaching the
  bootstrap/upgrade footers and the welcome mat (priority 1 is now caveat-generic and quotes the
  firing note's OWN recovery verbatim); uncheckable → an explicit unknown note (never "current",
  never "behind"); zero-behind → the TOOL prints a checked-scope verdict (`all N checked members are
  current` — any unknown blocks the all-current claim). New dependency-free `tools/semver-lite.mjs`.
- **Placed bridges refresh on `init` and `upgrade`.** A refresh-only driver in `setup-backends.mjs`
  (`--refresh-placed`) refreshes proven-managed placed bridges and NEVER places an absent one —
  placement stays opt-in via `/agent-workflow-kit setup`. `npx … init` calls it best-effort (a miss
  is a loud warning + a recovery command composed from the resolved install target + exit 0;
  `--no-bridges` opts out; win32 is a stated skip); `Mode: upgrade` runs it as a fourth
  stamp-independent reconcile and pastes the output verbatim. **Never-downgrade:** a placed bridge
  NEWER than the bundle is a stated keep + "update the kit", enforced at both the plan and the write
  boundary (TOCTOU re-inspect at apply); an unparseable version is treated as legacy repair, stated.
- **The one-line backend status is machine-composed.** `tools/recipes.mjs --status-line` emits the
  exact line (deterministic order, one alias table; additive `statusLine` in `--json`; strict argv —
  an unknown flag exits loudly instead of masquerading as the human render); SKILL.md now says run
  the tool and paste its line verbatim — the realistic example that once got echoed as fact is
  replaced by an explicitly-placeholder template.
- **The installer speaks facts.** The final verb is keyed on the OBSERVED version comparison
  (installed / updated / refreshed-the-already-current / downgraded-under-`--allow-downgrade`); the
  same-version note states that the copy ran (a re-run repairs locally modified files) + a
  CONDITIONAL `@latest` hint; the false "npx likely served a cached build" accusation is gone. One
  message contract with the engine installer (engine `1.9.0`).
- Lens sync everywhere — "placed by `setup` (opt-in), refreshed by `init`/`upgrade` once placed" —
  across SKILL.md, both READMEs and `family-members.mjs`, guarded by the new region+token
  `test/init-refresh-lens.test.mjs` (non-vacuous, injected red→green proven).

## 1.25.0 — The bridge driving contract at the point of use (advisor render + wrapper `--help`)

A **feature** release (additive; ships the bundled bridges at **2.1.0**). An agent told to run a
bridge no longer re-derives the invocation from wrapper source — where it missed documented levers
(agy's `--facts`/`--decided` grounding, the `agy-review --continue` round-2 delta) and wasted
subscription runs on ungrounded reviews. The contract is now **delivered at the moment a recipe
dispatches a backend**, from ONE machine-readable source:

- **Manifest as source.** Each bridge `capability.json` dispatchable role (`review`, `execute`) now
  carries a structured `contract`: exact copy-pasteable **invocation descriptors** (operands and
  alternatives included), the **grounding** note, the closed **flag** set (agy-review), the
  **round-2 / resume** descriptors, and codex-exec's **tiered guarded passthrough**
  (always-blocked vs `CODEX_PROBE=1`-relaxable). Documented in `tools/manifest/schema.md`.
- **Advisor renders it at the point of use.** `/agent-workflow-kit procedures <activity>` prints,
  under every dispatched backend of every slot (review recipes AND `execute=delegated`), the full
  driving contract VERBATIM — e.g. council shows `agy-review code [--facts @f] [--decided @f] …`
  plus the `agy-review --continue` delta beside `codex-review plan|code`. `--json` carries the same
  in an **additive** `slots[*].contracts` field (`backends: string[]` unchanged).
- **Every wrapper answers `--help`/`-h`** — pre-preflight (no CLI, no login, no git tree, no
  AGENTS.md needed); keyed on the FIRST argument only, so an open wrapper's passthrough payload
  (`codex-exec - -- --help`) is never intercepted. The three **dispatchable** wrappers
  (`codex-review`, `agy-review`, `codex-exec`) print the manifest contract; `agy-run` (probe role —
  never dispatched by a recipe slot) ships a lightweight wrapper-authored help, pinned for
  pre-preflight reachability only, with no manifest pivot by design.
- **Drift-guarded in both directions (test-as-spec), for the dispatchable wrappers.** The kit
  registry mirror (`wrapperContractFor`) deep-equals each manifest; the advisor's rendered
  descriptor set set-EQUALS the manifest (a missing AND a stale-extra descriptor both fail); each
  dispatchable wrapper's `--help` set-EQUALS the manifest; and a **source-level reverse guard**
  extracts each dispatchable wrapper's real parser arms (mode/flag/resume/passthrough-tier `case`
  arms, heredocs excluded) and pins them to the manifest — adding a wrapper mode or flag without
  updating the surfaced contract fails a test.
- Stale "unguarded codex flags" wording in the codex bridge docs corrected to the real **guarded**
  passthrough contract.

## 1.24.0 — Humanize the deploy/version report: hide the internal structure number in the happy path

A **feature** release (report-contract only — no logic, migration, or lineage change; the
deployment-lineage head stays `1.3.0`).

The bootstrap/upgrade report no longer leads with the internal `docs/ai` **structure version**
(`deploymentHead`) — an un-actionable number that leaked into **every** successful report, including
zero-diff no-ops, and read as "smaller than the version on npm/GitHub".

- **Happy path is now plain.** A zero-diff no-op `upgrade` says **settings already current — no update
  needed** (rendered in the user's language); a fresh `bootstrap` keeps its "deployed and ready"
  framing. Neither surfaces the structure semver, the stamp filename, or any head/lineage vocabulary.
- **The number survives only where it is actionable** — the never-downgrade STOP gate and the explicit
  `Mode: status` view — now **named "the `docs/ai` structure version"** (never "lineage head"), paired
  with a plain, on-demand two-axes note (*Version disclosure*). A migration that ran is described in
  **human terms**; the raw number is omitted, never recited on a successful report.
- **The version-status check is framed as internal routing**, not a line printed on every invocation.
- Pinned by a new static contract test (`test/report-contract.test.mjs`, invariants A1–A6).

## 1.23.0 — Surface the review-loop economics + the resolved backend set in the procedures advisor

A **feature** release. `/agent-workflow-kit procedures <activity>` now makes the review-loop discipline
mechanical at the point of use:

- **Backend-set aid.** Each resolved recipe prints its EXPLICIT wrapper set beside the recipe name
  (`review: council → run every backend every round: codex-review + agy-review`; `reviewed → codex-review`;
  `delegated → codex-exec`; solo prints none), so recipe fidelity is visible where the advisor is invoked.
  Sourced from `planRecipe().dispatch` + a new role-keyed `detect-backends.wrapperCmdFor` (reading
  `KNOWN_BACKENDS[].roleCmds`, now the source of truth; the deduped `wrapperCmds` readiness list is derived
  from it). Drift-guarded against each bridge manifest `roles[role].cmd`.
- **Review-loop economics block.** For a review slot resolving reviewed|council (omitted for solo) the
  advisor prints the ≤2-round cap, the bar-met-by-raising-a-major rule, the backend-divergence crossover
  stop, the thin-plan/diff-review carve-out, a self-consistency read, and the required per-round emission
  {round N · finding-origin · per-backend verdict}. `--json` carries per-slot `backends` + a top-level
  `reviewLoop`.
- The fallback `agent_rules.md` **§2.5** lens mirror gains the same review-loop disciplines (byte-identical
  to memory's §2.6).

Read-only; no resolution behaviour change. Deployment-lineage head stays `1.3.0`.

## 1.22.0 — Harden the planning canon: two-set lens drift guard + the deployed lens

A **feature** release. The kit's fallback `agent_rules.md` **§2.5** lens is generalized from *Right-altitude
& code-grounded* to **Planning, review & process-fidelity invariants** (byte-identical to memory's §2.6
block) and now carries all **seven** methodology invariants. The cross-package **`test/lens-mirror.test.mjs`**
is extended to **two scoped, non-vacuous token sets**:

- **Set 1 (cross-all-four)** pins the §9-native review/fold + convergence disciplines in EVERY region —
  planning §9, procedures (`## plan-authoring` onward), and both template lens blocks: `0 blockers + 0
  majors`, `test-as-spec`, `no code-mechanics`, `at the diff`, `characterize-first` (alongside the
  existing `fold by code` / `file:line` / `altitude`).
- **Set 2 (template-scoped)** pins the process-fidelity invariants A1/A2 (`ExitPlanMode`, recipe-fidelity
  `every round`) PRESENT in both template lens blocks — closing the gap the byte-identical check alone
  cannot (it only proves the two templates AGREE, so both could drop A1/A2 and stay green).

The lens heading + the `extractLensBlock` regex move in lockstep. The deployment-lineage head stays
**`1.3.0`** (no `docs/ai` structural change, no migration); the kit **package** version is a separate axis.

## 1.21.0 — Ships the antigravity-cli-bridge 2.0.0 mirror (grounded agy-review)

A **feature** release. The kit now bundles the **antigravity-cli-bridge 2.0.0** byte-identical mirror —
a grounded `agy-review` review wrapper beside the `agy-run` probe. The two-wrapper ripple lands kit-side:
`detect-backends` readiness probes the **EXPECTED** bundled wrapper set (a stale install missing
`agy-review` now reports **DEGRADED**, not a false "ready 1/1"), `setup` / `uninstall` manage **both**
wrappers, `release-scan` allowlists `agy-review`, and the recipes ↔ engine Issue-001 caveat is loosened
(grounded review is a sound second opinion; the service-stall risk is kept). The deployment-lineage head
stays **`1.3.0`** (no `docs/ai` structural change, no migration); the kit **package** version is a
separate axis.

## 1.20.0 — Fallback-template lens + the cross-package lens-mirror guard (kit)

A **feature** release. The kit's fallback `agent_rules.md` template gains the **§2.5 Right-altitude &
code-grounded** lens (byte-identical to memory's §2.6 block), and a new cross-package
`test/lens-mirror.test.mjs` ties the shared lens vocabulary across the engine canon (`planning.md` +
`procedures.md`) AND both `agent_rules.md` templates: each distinctive token must survive in every file's
lens **region**, and the two template blocks must stay byte-identical apart from the heading number. The
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no migration); the kit
**package** version is a separate axis.

- **Non-vacuous guard.** Deleting the lens block (or a distinctive token) from any of the four files
  fails the guard — proven by an injected-divergence dry-run.

## 1.19.0 — One-command freshness: `init` refreshes memory too, and a capability-adaptive `status` (kit)

A **feature** release that closes the returning-user gap and modernizes the status surface. The
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no migration); the kit
**package** version is a separate axis.

- **`init` now leaves no stale core member.** After installing/refreshing the kit, `npx
  @sabaiway/agent-workflow-kit@latest init` also refreshes the **memory substrate** and the
  **methodology engine** over npm — so a returning user is no longer left with silently stale memory.
  The memory refresh is **best-effort: a miss is a loud DEGRADED success** — a warning with the exact
  recovery command (and the on-disk version) plus **exit 0**, never a silent skip and never the engine's
  hard STOP. New **`--no-memory`** flag skips it for air-gapped/scripted installs. The cascade
  membership is derived from the one family registry and drift-guarded; bridges are still placed by
  `setup`, never by `init`.
- **Capability-adaptive `status` output.** The direct-CLI status view (`node tools/family-registry.mjs`)
  is rebuilt as a `surface → view-model → renderers` pipeline: it auto-detects the terminal (plain vs
  ANSI, color via `NO_COLOR`/`FORCE_COLOR`, width with a 40-col floor, ASCII-glyph fallback) and renders
  all four blocks (members · bridges · project deploy/visibility · settings). `--format=<auto|plain|ansi|json>`
  (with `--json` as sugar) selects the surface; unknown flags and a missing `--dir` value now **reject
  loudly** instead of being silently ignored.
- **Additive `--json` freshness signal.** Each `installed[]` entry gains a structural `refresh`
  `{ behind, recommend }` object (derived from the registry, never parsed from a caveat). The
  agent-mediated `/agent-workflow-kit status` reads it to show a localized "needs refresh" label + the
  exact command **once**; every existing envelope field is unchanged.
- **Docs.** Install help + READMEs document the memory/engine refresh, `--no-memory`, the degraded-success
  recovery, and that bridges are not installed by `init`. Tarball **75 → 81** (the pure member-table leaf
  + five status-presenter modules).

## 1.18.0 — Agent-writable orchestration config (`set-recipe`), version-aware setup, durable session contracts (kit)

A **feature** release. The per-project recipe config (`docs/ai/orchestration.json`) is no longer
hand-edit-only: a new **`set-recipe`** writer turns plain-language intent into a validated, previewed,
atomic write — and `setup` now surfaces bridge versions and proactively offers to set the review recipe
when a backend becomes ready. The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural
change, no migration); the kit **package** version is a separate axis.

- **`/agent-workflow-kit set-recipe` (new WRITER).** The agent maps plain language → explicit
  `--set <activity>.<slot>=<recipe>` / `--unset <activity>.<slot>` ops; the kit validates → merges →
  **previews by default** → writes only on `--write`. Split modules: `tools/orchestration-config.mjs`
  (schema/read/pure — the shared slot-recipe validity table + `parseOp` / `applySetOps` /
  `serializeConfig` / the canonical-refresh helpers) and `tools/orchestration-write.mjs` (the **only**
  fs-writer — deployment gate, exclusive-create temp + rename, symlink/TOCTOU-safe, last-writer-wins).
  `procedures` never imports the writer → the read-only invariant is **structural**. Renamed from the
  planned `orchestrate` (it never *runs* a recipe). Hand-editing the file stays fully supported.
- **Setup surfaces versions + closes the loop.** Each skill line shows the bridge version (`(vX)` for a
  fresh place / equal refresh, `(vOld → vNew)` on a bump, never `vnull → …`); a closing pointer at
  `/agent-workflow-kit status`; and — re-detecting AFTER apply — a proactive `set-recipe` offer for
  **both** `plan-authoring.review` and `plan-execution.review` when a review backend just became ready.
- **Canonical-refresh reaches the filled base.** `inject-methodology` refreshes a filled pointer slot to
  the current engine canon when its content matches a known-prior fragment (a customization is preserved
  + advised); the `_README` refresh reuses the same `refreshIfCanonical` helper, and the upgrade
  config-ensure is now seed-**or-refresh**.
- **Docs.** New `### Mode: set-recipe`; `procedures` / `velocity` / README no longer say the config is
  "never written for you". Tarball **72 → 75** (three new `tools/*.mjs`).

## 1.17.0 — Hardened Codex bridge: quality-first delegation, clean capture, enforced git-write boundary (kit)

A **feature** release. The bundled `codex-cli-bridge` (`bridges/codex-cli-bridge/`) is overhauled to
make delegating to the OpenAI Codex CLI faster, quieter, and safer **without lowering output quality** —
economy comes only from quality-neutral waste removal, never a model/effort downgrade. The bridge's own
contract bumps to **`2.0.0`** (MAJOR — the hardened wrappers now *refuse* inputs the `1.0.0` wrappers
silently accepted). The kit's own modes/CLI are unchanged, so the kit is a MINOR bump; the
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no migration). The kit
**package** version is a separate axis.

- **Quality-first — no silent downgrade.** Both wrappers pin frontier `gpt-5.5` @ `xhigh` and **refuse
  with a loud error** if `CODEX_MODEL`/`CODEX_EFFORT` resolves to a non-default, unless the explicit
  throwaway `CODEX_PROBE=1` mode is set (echoed loudly). Outside that probe mode the passthrough guard
  now blocks **every** model/context/policy-affecting flag (`-m/--model`, `--add-dir`, `-C/--cd`,
  `-p/--profile`, `--oss`, …), not just the previous subset.
- **Clean output capture.** `-o` (final message only) + a `--json` event trace +
  `hide_agent_reasoning=true` + `--color never` replace the streamed reasoning transcript; the session id
  is persisted to a sidecar (`CODEX_SESSION_FILE`) for resume; on failure the trace tail is surfaced to
  stderr (no silent failure). Reasoning still runs at `xhigh` — quality unchanged.
- **Hard timeout.** New `CODEX_HARD_TIMEOUT` (`timeout`/`gtimeout`, generous `xhigh`-sized defaults —
  exec `3600` s / review `1800` s, `--kill-after=15s`); a hard kill (124/137) reports `codex exceeded
  hard timeout`. A host with no `timeout` warns and runs uncapped (no silent skip).
- **Precomputed-diff review.** `review code` now assembles the diff itself (`git status` + cached/unstaged
  `git diff` + untracked file **contents**, binary-skipped; a payload above the
  `CODEX_REVIEW_MAX_TOTAL_BYTES` threshold goes via a repo-local temp file, never truncated) and feeds it
  to `codex exec` — killing the agentic
  discovery roaming that read unrelated files (incl. `~/.claude`). Reads stay `read-only` for
  surrounding-file context; a no-change preflight exits before spending a run. Optional structured
  findings via `CODEX_REVIEW_SCHEMA=1` (default off, raw-text fallback).
- **Invariant-preserving resume + enforced git-write boundary.** A dedicated `--resume-last` /
  `--resume <id>` entrypoint re-establishes every wrapper invariant (`--ignore-user-config`, the pin,
  posture restated via `-c`). A **physical `git` shim** (a real executable on a temp `PATH`, since
  `execve` bypasses bash functions) enforces a strict read allowlist and blocks every write verb by
  default — defence beyond the prompt contract.
- **First hermetic bridge tests + tarball `70 → 72` files.** `bridges/codex-cli-bridge/bin/{codex-exec,codex-review}.test.mjs`
  ship as byte-identical mirror payload (matching `agy.test.mjs`); `npm pack --dry-run --json`
  re-verified. The byte-identical bridge mirror + `capability.json` stay valid.

## 1.16.0 — Onboarding & discoverability: `help`, honest versioning, an enriched `status` (kit)

A **feature** release (additive, backward-compatible). Makes the kit self-explanatory: a discoverable
command surface, honest installed-on-this-machine version legibility, and one `status` that answers
"versions + deployment + settings + bridges". The deployment-lineage head stays **`1.3.0`** — nothing
in the deployed `docs/ai` *structure* changed, so there is **no migration**. The kit **package**
version is a separate axis from that head.

- **`/agent-workflow-kit help` + safe unknown-invocation routing.** New `tools/commands.mjs`: a frozen
  command catalog (grouped Inspect / Configure / Orchestrate / Lifecycle, each tagged read-only /
  writer / guarded) + a pure `routeInvocation` router. A discoverable index, and the read-only landing
  spot for any unrecognized invocation — **no unrecognized/garbage token ever reaches a writer/guarded
  mode** (only an explicit known token, or the acknowledged bare-bootstrap exception). Drift-guarded
  against the `### Mode:` headers.
- **Honest version legibility.** `tools/family-registry.mjs` gains a no-leak `--json` envelope (user-safe
  field names only — never the internal manifest/stamp terms) feeding a shared **version block**:
  deployment-structure head · installed package versions per member · the two-axes disambiguation when
  the numbers coincide. An **offline caveat** flags a memory install too old to ship the current
  orchestration template ("installed on this machine", no network). Bootstrap/upgrade now print a
  **welcome mat** (success → version block → backend line → one caveat-aware next step) and bootstrap
  opens with a one-line first-contact orientation.
- **Settings & bridges in `status`.** `status` is now the single answer to "versions + deployment +
  settings + bridges": orchestration recipes (effective per slot), attribution
  (`includeCoAuthoredBy`), velocity (`defaultMode`), the bridges (readiness + wrapper PATH presence,
  no model claim), and **visibility** (visible / hidden / unclear, via `inferVisibility`) — each in
  plain language, **localized-on-error** (a malformed file surfaces its own error, the rest still
  renders). `loadConfig` is shared with the procedures advisor (one strict-JSON reader).
- **Surgical delegation gate.** `references/templates/orchestration.json` joins the memory
  required-asset set: a memory too old to seed `docs/ai/orchestration.json` now **falls back** to the
  kit's bundled substrate (which seeds it) instead of being delegate-classified — closing the
  stale-memory trap the read-only note only informs about.
- **Tarball guard `69 → 70`** (the new shipped `tools/commands.mjs`); `npm pack --dry-run --json`
  re-verified. No `docs/ai` structural change → lineage head unchanged.

## 1.15.2 — Strip the package's own tests + fixtures from the npm tarball (kit)

Packaging only — no API/behaviour change; removed the package's own colocated tests + fixtures from
the published tarball, deploy/mirror payload tests retained. The deployment-lineage head stays
**`1.3.0`** (no `docs/ai` structural change, no migration file). The kit **package** version is a
separate axis.

- **`files[]` scoped negation.** Appended `!bin/*.test.mjs`, `!tools/**/*.test.mjs`, and
  `!tools/manifest/fixtures/**` to the package allowlist (npm ignores a root `.npmignore` when
  `files[]` is present, so negation entries in `files[]` are the mechanism). Tarball **115 → 69
  files**: 18 of the package's own colocated tests + 28 manifest fixtures no longer ship.
- **Deploy/mirror payload tests retained.** `references/scripts/*.test.mjs` (deployed into a
  consumer repo's `scripts/` with the docs-rotation scripts) and
  `bridges/antigravity-cli-bridge/bin/agy.test.mjs` (part of the byte-identical bridge mirror the
  installed kit links from) still ship — a blanket `!**/*.test.mjs` would have silently broken
  installs, so the negation is deliberately scoped. **Never broaden it to `!references/**` or
  `!bridges/**`.**
- **New tarball guard.** `test/package-content.test.mjs` (dev-only; outside `files[]`, never ships)
  pins the exact shape via `npm pack --dry-run --json`: no own-test/fixture leak, payload tests +
  runtime files present, exact file count `=== 69`.
- Test files stay on disk; the gate + publish CI run them from the checkout, unchanged. This is a
  tarball-only exclusion.

## 1.15.1 — Version-axis clarity, hidden-mode invariant, lineage-head drift guard (kit)

Patch: documentation + a regression guard; no behaviour change to shipped tooling, and the
deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change, no migration file). The
kit **package** version is a separate axis.

- **`upgrade` now names the version axis in its report.** Steps 4 (equal-head exit) and 8 (re-stamp)
  state that a project's stamp tracks the **deployment-lineage head** (`1.3.0`) — a separate axis from
  the kit **package** version on npm/GitHub — so an equal-head report is no longer mistaken for a
  stale deployment when GitHub shows a higher package number. A packaging-only release bumps the
  package without moving the head; the head advances only when the deployed `docs/ai` structure does.
- **Hidden-mode maintenance invariant made explicit (Visibility contract).** Hidden mode changes only
  what *git* sees — never the agent's duty to read/maintain `docs/ai`. "Git-ignored / `git status`
  clean" is **not** "optional to update"; those updates simply live on disk and never enter a commit.
- **New cross-package drift guard** (`test/lineage-head-drift.test.mjs`): asserts the kit's
  `EXPECTED_WORKFLOW_VERSION` equals the canonical `LINEAGE_HEAD` in `agent-workflow-memory`, so a
  future head bump can't silently desync the two duplicated literals (which would make
  `velocity --apply` reject a correctly-upgraded project). Runs in the gate; lives outside the package
  `files` whitelist, so it is never shipped.

## 1.15.0 — Velocity-profile onboarding (kit)

An opt-in **`/agent-workflow-kit velocity`** mode seeds a fixed, audited **read-only** Claude Code
allowlist into `.claude/settings.json` so an agent stops idling on approval prompts for routine
read-only commands while the maintainer is away. It never allowlists `commit`/`push`/`publish`, so a
direct invocation still ASKs — the only caveat is the trust-posture residual (below), closed by a
deferred hook.

### Added
- **`tools/velocity-profile.mjs`** — the pure core (a frozen 18-entry `UNIVERSAL_READONLY_ALLOWLIST`,
  the `screenAllowlistEntry` read-only screen, the read-only `discoverGateCandidates` gate advisor, and
  the `validateProfile` drift guard) **plus** the programmatic settings writer + CLI
  (`[--dry-run | --apply] [--accept-edits] [--cwd <dir>]`). Strict **preflight-then-mutate**:
  merge-don't-clobber, opt-in `acceptEdits`; refuses an unsafe `permissions.defaultMode`
  (`bypassPermissions` / any non-`{default,acceptEdits,plan}` mode present in **either** settings file),
  a symlinked `.claude`, malformed settings JSON, or a non-current deployment stamp on `--apply`. Writes
  **only** `.claude/settings.json`, never `settings.local.json`.
- A **`### Mode: velocity`** section + a `## Modes` dispatch entry + a one-line opt-in bootstrap offer
  in `SKILL.md`.
- The guarded **`uninstall`** now also reports `permissions.defaultMode`/`permissions.allow` in
  `.claude/settings.json` **non-committally** (REPORT_ONLY, never auto-removed — the writer stores no
  ownership marker).

### Honesty
- This is the family's **first programmatic `.claude/settings.json` writer** — a new writer subsystem
  with its own tests and teardown reporting, **not** merely an extension of the attribution prose seam.
- The audited core is **read-only by intent — verified, not assumed** (no mutating command, no inline
  code execution): build-time probes proved `git grep` (`--open-files-in-pager`) and `sort`
  (`--compress-program`) give inline code execution; both were dropped (the core is 18, not 20).
  `git diff`/`log`/`show` are kept with a documented bounded-write (`--output`) residual.
- A seeded read-only allow entry is a **trust posture, not a sandbox**: Claude Code's settings-level
  allow rules do not inspect output redirection (`cmd > file`) nor command substitution (`cmd $(…)`),
  so that residual is surfaced honestly in the consent copy, bounded by `acceptEdits` staying opt-in,
  and **fully closed only by a deferred PreToolUse hook** (a recorded follow-up). `commit`/`push`/
  `publish` are never added as allow rules.

Lineage head stays **1.3.0** (no `docs/ai` structural change; no migration). See AD-021.

## 1.14.0 — Activity procedures: recipe-aware, configurable playbooks

A new read-only **`/agent-workflow-kit procedures <activity>`** advisor turns a bare command like
"write a plan" into a codified, recipe-aware procedure. It reads the named activity's ordered steps
**live** from the installed engine (`references/procedures.md`) and prints them verbatim, then resolves
the **effective recipe per slot** from a new per-project, hand-edited config and the read-only backend
detector. Two v1 activities: **`plan-authoring`** (slot: `review`) and **`plan-execution`** (slots:
`execute`, `review`). It composes with the AD-018 recipes; **`recipes` stays read-only** (the config is
hand-edited, never written by the kit).

### Added
- **`tools/procedures.mjs`** — the read-only CLI: live engine read + per-activity section extraction,
  config IO + validation, and the resolved recipe per slot (default = Reviewed when a backend is ready,
  Council on request, slot-aware incl. Delegated). A repeatable `--override <slot>=<recipe>` adjusts one
  slot per run. Exit codes: `0` success (an unsatisfiable override degrades **loudly** but still `0`),
  `2` usage (unknown activity / bad `--override`), `1` config or engine error (loud `path: reason`).
- **`docs/ai/orchestration.json`** — the per-project, strict-JSON config (`{ activity: { slot: recipe } }`;
  all slots optional; an optional `"_README"` is allowed + ignored). Hand-edited; kit-validated.
- **`resolveActivityRecipe` / `ACTIVITIES` / `SLOT_RECIPES`** in `tools/recipes.mjs` — the pure resolver
  (graceful default vs loud override degradation), drift-guarded against the engine canon's `Slots:`
  lines. `planRecipe` / `recommendRecipe` are unchanged.
- A **`workflow:methodology`** pointer clause routing to `/agent-workflow-kit procedures <activity>`
  (the feature's only auto-discovery route — both engine + kit are `disable-model-invocation`).

The deployment-lineage head stays **`1.3.0`** (no `docs/ai` structural change; no migration file). See
**AD-019**.

## 1.13.0 — Orchestration recipes: a named way to compose the bridges

The kit now knows **how to put the optional execution-backends to work**, not just whether they're set
up. A new read-only **`/agent-workflow-kit recipes`** advisor presents four named recipes — **Solo**
(no backend), **Reviewed** (one backend reviews), **Council** (both review, you synthesize), and
**Delegated** (a backend executes a bounded sub-task) — plans the right one for your environment, and
**degrades gracefully with a stated reason** when a backend isn't ready (Council → Reviewed → Solo;
Delegated → Solo). It offers the choice (a multiple-choice prompt where your agent supports it) and
prints exactly what running it entails, including advisory quota/health notes. It is **read-only**:
the orchestrator runs the chosen recipe through the bridge skills and always makes the single commit —
the kit never executes a recipe and never runs a subscription CLI.

Every deployed `AGENTS.md` now also carries a one-line **orchestration-recipes pointer** (right under
the methodology pointer), reconciled live from the engine on bootstrap + upgrade. And the read-only
backend-status line that bootstrap/upgrade already print gains an **actionable tail** — e.g.
*"recipes: Reviewed available (via codex) — see /agent-workflow-kit recipes"* — so you're nudged
toward the recipe that fits, never left guessing.

Both entry-point templates were trimmed for headroom so both pointers fit inside the 100-line cap; if
an entry point is already at the limit, the orchestration pointer is **skipped and reported** (never
silently) while the methodology pointer still lands. The deployment-lineage head stays **`1.3.0`** (no
`docs/ai` structural change; no migration file). See **AD-018**.

## 1.12.0 — See the whole family, and uninstall it cleanly

Two new in-agent modes, built on a single **unified family registry**. `/agent-workflow-kit status`
shows — read-only — which family members (kit / memory / engine / the two bridges) are installed, at
what version, and (in a project) what is deployed (`docs/ai`, the version stamps, the hidden-mode
fence). `/agent-workflow-kit uninstall` is the **guarded teardown**: it reverses what `init` and
`setup` placed — installed skill dirs + bridge wrappers, and in a project the hidden-mode fence + the
marker pre-commit hook — but it **never deletes user-authored content** (`docs/ai`, `AGENTS.md`, your
`.claude/settings.json`); for those it prints the exact commands and lets you run them. It removes only
what is **provably ours** (a valid manifest, name + kind match; a wrapper symlink that points at our
source) — anything else is left untouched — and it **previews with `--dry-run` and preflights before
it touches anything**, so a conflict makes zero changes. The deployment-lineage head stays **`1.3.0`**
(no `docs/ai` structural change; no migration file). See **AD-017**.

### Added
- `tools/family-registry.mjs` — the unified, kit-owned registry over every family member (the
  `KNOWN_BACKENDS` precedent, generalized to all five). Resolves each member's `detect.installed`,
  manifest health, and installed version; powers `/agent-workflow-kit status`. A drift-guard test pins
  it to the five in-repo `capability.json` files.
- `tools/uninstall.mjs` — the guarded uninstaller behind `/agent-workflow-kit uninstall`: a pure
  classifier (`buildPlan`) + a preflight-then-mutate executor (`executePlan`). Four surface classes —
  safe-remove (provably-ours skill dirs), managed-marker (wrapper symlinks / the hidden-mode fence /
  the marker hook), report-only (never-deleted user content), and stop (present-but-not-ours).
- `tools/fs-safe.mjs` gains `removeTreeManaged` + `unlinkManaged` — the symlink-safe inverses of
  `copyTreeRefresh` / `linkManaged` (refuse to delete through a symlink or outside the root; remove
  only a symlink whose target is ours).

### Changed
- `tools/manifest/validate.mjs` exports `readAuthoritativeVersion` so the registry reports an installed
  member's version from the same authoritative source the validator checks.
- The kit's own `capability.json` now declares `uninstall.removeResolved` (uniform with memory +
  engine); the guarded uninstaller's behavior matches it — it removes exactly the resolved
  `detect.installed` dir, so the long-declared teardown is now realized, not just documented.

The bounded methodology fragment the kit writes into a project's `AGENTS.md` is now read **live from
the installed `@sabaiway/agent-workflow-engine`** — the family's single source of truth. The kit's old
bundled mirror of that text (and its drift-guard) is **retired**: there is exactly one copy now, in the
engine. `npx @sabaiway/agent-workflow-kit@latest init` installs the engine as a **core** part of the
kit (it is core methodology, not an optional backend — deliberately diverging from AD-011 §5), so the
slot can always be filled. The read is **lazy + fail-loud**: the engine is consulted only when a slot
actually needs filling — a deployment whose slot is already filled upgrades to a **zero-diff no-op even
without the engine** — and when a fill *is* needed but the engine is absent/invalid the reconcile
**STOPs** with the exact install command, never a silent fallback. The deployment-lineage head stays
**`1.3.0`** (no `docs/ai` structural change; no migration file). See **AD-016**.

### Added
- `tools/engine-source.mjs` — resolves the installed engine via the family `detect.installed` pattern
  (env `AGENT_WORKFLOW_ENGINE_DIR` → `~/.claude/skills/agent-workflow-engine`, **not** an npm
  dependency), validates it with the kit's own manifest validator, and reads the live fragment —
  throwing a loud, actionable error (with the install command) when the engine is needed but absent.
- `npx … init` now installs the engine after placing the kit. `--no-engine` opts out (the live read
  then STOPs until the engine is installed by hand). An install failure **retries once**, then fails
  loudly with concrete recovery steps and a non-zero exit (the kit itself is already on disk).

### Changed
- `tools/inject-methodology.mjs` sources the fragment live from the engine (a lazy `slotNeedsFill`
  guard), not a bundled file. `SKILL.md` / `README.md` rewired to the live-read reality; the
  `init-command-uses-latest` drift-guard now also covers the engine's `init` command.

### Removed
- The bundled mirror (`references/planning.md` + `tools/methodology-slot.md`) and its drift-guard
  `test/methodology-mirror.test.mjs` — retired in favor of the live read.

### Honesty
- `init` now contacts a server (it fetches the engine over npm) and the kit gains a **runtime
  dependency on the installed engine**; the "nothing contacts a server" / "no new dependency" notes
  were scoped accordingly. The stale-version gate stays no-network, and there is still no telemetry.

## 1.10.0 — Hidden mode covers the full AI/agent footprint, project-local

Hidden visibility now hides the **full AI/agent footprint** — the kit's own artifacts **and** every
known foreign tool's files (Claude skills, Cursor, Windsurf, Gemini, Copilot, Aider, Continue, …) — in
**one managed block in the project-local `.git/info/exclude`**, never the machine-global
`core.excludesFile` (which leaked the same rules to every repo on the host). **AD-014** amends
**AD-006** and generalizes the `.claude/skills/` one-off (AD-013). The deployment-lineage head stays
**`1.3.0`** — this is a stamp-independent reconcile wired into bootstrap + the upgrade flow (the AD-010
methodology-slot precedent), so there is **no migration file**.

### Added
- `tools/known-footprint.mjs` — the `KIT_OWN_PATHS` + `KNOWN_FOOTPRINT` registry (+ `patternToProbe` /
  `expandGlob` / `matchesKnownGlob`), guarded by a frozen-snapshot + count-sentinel drift test.
- `tools/hide-footprint.mjs` — the single hide-writer. Classifies each path (tracked → **ASK** with the
  printed `git rm --cached`; present generic-name → **ASK**; else **hide**), writes one re-derived
  managed fence (a clean re-run is byte-identical / zero-diff), `migrateFromGlobal` (detect + report the
  residual machine-global block by default; `--remove-global` removes it with a printed backup),
  `--reconcile` (upgrade-time visibility inference: visible → zero bytes, ambiguous → ASK),
  `--unhide`, `--include`. Unit + real-`git` integration tests (worktree, precedence, delegated memory).

### Changed
- `references/contracts.md` Visibility contract rewritten (project-local; full footprint table);
  `SKILL.md` bootstrap step 9 + the upgrade reconcile now drive the tool; root + kit READMEs corrected.
- A **tracked** file is never silently un-tracked — the tool prints the `git rm --cached` it will not run.

## 1.9.1 — Front-door value framing for the optional bridges; kit flow-pointer

The optional execution-backends (the `codex` / `agy` bridges) were **listed** but never **sold**: a
reader couldn't tell what they add to the workflow or why they'd want them. Promoted per **AD-009**
altitude — value lives at the **family front door**, the per-package page stays a manual.

- **Root README** — the existing `## 🔌 Optional delegated execution (the bridges)` section now
  frames what the bridges add to **plan → execute → review**: an *independent reviewer* (a second
  opinion in the **review** phase) and a *delegated executor / parallel hand* (a bounded task to
  `codex exec` in the **execute** phase), under your own subscription (no pay-as-you-go billing,
  subject to each provider's quotas). The honesty caveats are unchanged (`init` bundles but never
  places a bridge; link-only `setup`; third-party services; context-file priority).
- **Kit README** — one manual-altitude flow-pointer in the composition-root bridge bullet: the
  bridges plug into the **execute** and **review** phases, routing **up** to the front door for the
  *why*. No value pitch duplicated into the manual (AD-009 anti-drift).

Documentation change only — no code, detector, or `init`/npx behaviour change, no `docs/ai`
structural change, deployment-lineage head stays **`1.3.0`**, `agent-workflow-memory` untouched, no
migration. The **kit** README + metadata ship in the kit tarball (the root README is the GitHub
family front door, outside the package), so the kit README edit rides a patch bump — three version
sources in sync.

## 1.9.0 — `upgrade` surfaces the optional backends at every successful exit

`/agent-workflow-kit upgrade` said **nothing** about the optional execution-backends (the `codex` /
`agy` bridges). A maintainer running `upgrade` on a fresh machine got a full report with **zero**
bridge mention — because when a deployment is **already current** (by far the most common case),
`upgrade` stopped *before* its final report. Bootstrap already prints a read-only one-line backend
summary; `upgrade` never adopted it.

- **The already-current exit is now a real success report**, not a silent stop: it states in plain
  language whether the workflow-methodology pointer was added, was already present, or was skipped
  because the entry point is over its line limit; prints the **one-line backend-status line**; and
  asks before committing when anything changed (otherwise it says "already up to date" and still
  prints the read-only line).
- **The full-migration exit** prints the **same** one-line backend-status line before the commit
  gate — so **every** successful `upgrade` exit now surfaces what's set up vs missing, mirroring
  bootstrap's summary verbatim
  (`backends: codex ✓ ready · antigravity ✗ needs-credentials — run /agent-workflow-kit backends`).
  Both exits share one definition in `SKILL.md`, so the line stays identical everywhere.
- **Detection-only, honesty-safe.** The line is **read-only · never blocks the commit gate · never
  runs a subscription CLI · the pointer is the in-agent `backends` mode, never a network fetch ·
  `init`/npx is unaffected (it still never places a bridge).** If the **agent host** can't run the
  detector (no `node` on its PATH, or the detector errors), the line is skipped with a
  plain-language reason — never a silent skip (Hard Constraint).
- **README "Use" table:** the `upgrade` row notes the read-only backend-status line (never installs
  a bridge — set one up with `/agent-workflow-kit setup`).

Agent-procedure / documentation change only — no detector or `init`/npx behaviour change, no
`docs/ai` structural change, deployment-lineage head stays **`1.3.0`**, `agent-workflow-memory`
untouched, no migration.

## 1.8.2 — Upgrade DX: graceful, plain-language handling when the methodology slot can't fit the cap

On a real `upgrade`, a project whose `AGENTS.md` was already over its 100-line cap hit the
methodology-slot `reconcile`'s **cap refusal** (adding the bounded pointer would push the file to 109
lines). The tool behaved correctly — it refused and left the file byte-for-byte unchanged — but the
upgrade procedure had **no instruction for this exit path**, so the agent improvised: it surfaced a
confusing, kit-internal multiple-choice prompt to the user (ADR ids, tool / operation names, marker
terminology) that a third-party user has no vocabulary to answer.

- **Defined the cap-refusal path in `SKILL.md` (upgrade step 3):** a cap-exceeded `reconcile` refusal
  is now a **soft, explicitly-reported skip — not a STOP** (a malformed slot / missing-or-duplicate
  anchor still STOPs, unchanged). The upgrade continues without the slot; the skip is reported in
  plain language in the final report — the methodology is already documented in
  `docs/ai/agent_rules.md`, and trimming the entry point then re-running adds the pointer. It is
  **not** silent (Hard Constraint — no silent failures). The reported line count is the file's
  **current** size, not the tool's would-be post-injection number, and any remaining mandatory
  `AGENTS.md` edit must keep the file ≤100 lines rather than bust the cap to land a migration.
- **No-Node manual path:** count the lines before pasting the slot by hand — skip + report if it
  would take the file over the cap.
- **New Gotcha — communication firewall:** never surface ADR ids, tool / function / operation names,
  marker / slot / fragment / anchor terminology, or verbatim tool stderr to the user; translate every
  tool outcome into plain language.

Agent-procedure / documentation change only — no `inject-methodology.mjs` behavior change (the tool
was already correct), no `docs/ai` structural change, deployment-lineage head stays **`1.3.0`**, no
migration.

## 1.8.1 — Fix: `npx … init` ran nothing (the installer's own run-guard mis-fired under npx)

1.8.0 set out to fix "`npx <pkg> init` quietly did nothing" — and shipped a *second*, unrelated
silent no-op in the same spot. The reported symptom: `npx @sabaiway/agent-workflow-kit@latest init`
installs the package, prints the npx "Ok to proceed?" line, and then **prints nothing and does
nothing** — none of 1.8.0's new DX messaging, no install, exit 0.

Root cause: the bottom-of-file run-guard that gates `main()` so importing the module has no side
effects:

```js
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
```

npx never runs `bin/install.mjs` by its real path — it runs the `node_modules/.bin/agent-workflow-kit`
**symlink** to it. Node resolves `import.meta.url` to the real file but leaves `process.argv[1]` as the
symlink path, so the string compare is always false, `main()` never runs, and the process exits 0
without a word. (Running `node bin/install.mjs` directly — as the test suite did — has no symlink, which
is why every test passed while real `npx` was broken.)

- **Fix:** the guard now compares **real paths** (`realpathSync` on both sides), which collapses the
  `.bin` symlink so direct and npx invocations both register as a direct run; it also holds under
  `--preserve-symlinks`. Import-with-no-`argv[1]` and a missing file still fall through to `false`, so
  importing the module continues to run nothing.
- **Regression test:** a new case invokes the installer **through a symlink** (the exact `.bin` shim
  npx uses) and asserts it both prints and writes the payload — the previous suite never exercised a
  symlinked invocation, so the bug slipped through.

Installer bugfix only — no `docs/ai` structural change, deployment-lineage head stays **`1.3.0`**, no
migration.

## 1.8.0 — Stale-version DX: `@latest` everywhere + a no-network never-downgrade gate

A returning user ran the headline `npx @sabaiway/agent-workflow-kit init` and it quietly did nothing:
a bare `npx <pkg> init` (no `@latest`) reuses the npx cache and re-runs an **older cached build** of
the installer, which exits 0 and reports it "updated" — to the same stale version. This release makes
that mistake hard to miss while **the installer itself stays 100% network-free** — the only thing
that ever contacts npm is npx resolving `@latest`, exactly as it already does (the no-phone-home
principle is preserved; see AD-012):

- **`@latest` is the documented default everywhere.** Every prescribing surface (both READMEs, the
  bridge `SKILL.md` files + their bundled mirrors, the installer `--help` / header) now shows
  `npx @sabaiway/agent-workflow-kit@latest init`. A new drift guard
  (`test/init-command-uses-latest.test.mjs`) fails the build if a bare form sneaks back in (historical
  contexts — CHANGELOG / `releases/` / `migrations/` — are exempt).
- **Never-downgrade gate (no network).** `init` reads the installed skill's version from
  `SKILL.md` **before** writing; if the installed kit is **newer** than the version you ran (the exact
  stale-cache signature), it **refuses** (nonzero) and points at `@latest`, rather than silently
  overwriting a newer install with old code. `--force` overrides. A legacy install with no version
  stamp still upgrades cleanly.
- **No-op re-run hint.** When `init` refreshes the skill with the *same* version it already had, it
  says so and points at `@latest` — the no-network signal that catches the reported scenario.
- **In-agent skill** (`SKILL.md`): surfaces a one-line version status (project `docs/ai/.workflow-version`
  vs the lineage head) + routes (bootstrap / upgrade / current), spells out the **two independent
  version axes** (project deployment vs kit freshness — the latter is the npx installer's job, never
  this skill's), and tells you to **restart the session** after refreshing the kit so the new skill
  files load.

New users are unaffected (an empty npx cache already fetches `latest`); this targets the returning-user
trap. No `docs/ai` structural change → the deployment-lineage head stays **`1.3.0`**; no migration.

## 1.7.0 — Link-only backend auto-setup; bridges bundled in the tarball

The optional execution-backend bridges (`codex-cli-bridge` → `codex`, `antigravity-cli-bridge` →
`agy`) can now be set up from the kit itself, via a new **opt-in, in-agent** mode —
**`/agent-workflow-kit setup [backend]`** (`tools/setup-backends.mjs`). It owns only the two
**deterministic, secret-free** steps and **guides** the rest (AD-011):

- **Bridges are bundled in the kit's npm tarball** under `bridges/<name>/` — a **byte-identical
  mirror** of the repo-root bridges, pinned by `test/bridges-mirror.test.mjs` (the same drift-guard
  pattern as the methodology mirror). So `setup` places a bridge from local files, with **no network
  fetch**. `init` (npx) bundles them but still **does not place** them — that stays the opt-in
  `setup` job (preserving the honest `init` ≠ deploy claim).
- **`setup` places/refreshes the bundled bridge skill**, but only into a dir that is **absent /
  empty / proven-managed** (valid manifest, matching `name`+`kind`); a stub/foreign/invalid/
  unsupported manifest, a marker fs-error, a non-empty unknown dir, or a symlinked dir → **STOP**,
  never overwritten. Refresh re-runs on a managed dir so re-running `setup` delivers bundled fixes.
- **It links the wrappers** (`codex-exec` / `codex-review`; `agy-run`) onto `PATH` (`~/.local/bin`,
  override with `--bindir`) via **managed symlinks** — replacing only a symlink already pointing at
  our source. It **preflights every target first**, so a conflict on one wrapper makes **zero**
  changes; a non-symlink or a foreign symlink → STOP. Wrapper presence is judged **per-bindir**, not
  PATH-wide. `--dry-run` prints the plan and changes nothing.
- **The binary install + the interactive subscription login stay manual** — `setup` prints the exact
  commands (the detector's axis-aware `guideFor`), never runs a subscription CLI, never commits. On
  **Windows** it reports *unsupported — use WSL* and mutates nothing (the wrappers are POSIX `.sh`).
- Internal: the symlink-traversal-safe copy/link primitives are now shared in `tools/fs-safe.mjs`
  (the npx installer consumes them and gained an `isDirectRun` guard so importing it runs nothing).
  The per-package publish workflow now gates the kit on its **whole** test suite, not just the
  shipped enforcement scripts.

No `docs/ai` structural change → the deployment-lineage head stays **`1.3.0`**; no migration.

## 1.6.0 — Methodology slot reconciliation; engine becomes the canonical methodology home

The workflow methodology now has a **single canonical home** in `agent-workflow-engine`
(`available:false` — content only, not yet published or wired live), and the kit keeps
**byte-identical mirror copies** so the existing injection + fallback keep working with **no new
runtime dependency**. A drift-guard test (`tools/methodology-mirror.test.mjs`) pins the mirrors to
the engine canon: `references/planning.md` and `tools/methodology-slot.md` must equal their engine
counterparts byte-for-byte.

The user-facing win is **stamp-independent slot reconciliation**. A single atomic, idempotent kit
operation now **ensures the `workflow:methodology` slot exists and is filled** in a deployed
`AGENTS.md`, on **bootstrap** and on **every upgrade**:

- **`tools/inject-methodology.mjs`** gains `METHODOLOGY_ANCHOR`, `EMPTY_SLOT`, `ensureSlot`, and
  `reconcileSlot` (reusing the existing `findSlot` / `injectMethodology` / `extractSlot` marker
  parser — no second parser). `reconcileSlot` = **ensure the slot exists** (insert an empty marker
  pair right after the Session-Protocols anchor when a legacy entry point lacks one) → **inject the
  bounded fragment ONLY IF the slot is empty** (a filled / user-customized slot is preserved
  verbatim) → **cap-check** (`AGENTS.md` ≤ 100 lines). On a malformed slot or a missing / duplicate
  anchor it **STOPs with an error and never edits** — the file is left byte-for-byte unchanged.
- A new CLI mode — `inject-methodology.mjs reconcile <AGENTS.md>` — runs that policy as **one
  atomic write** (temp + rename); there is no partial state where markers exist but the fill failed.
- The kit **fallback** entry-point template (`references/templates/AGENTS.md`) now ships the **empty
  methodology slot** (matching memory's template) instead of an inline methodology line, so a fresh
  fallback bootstrap gets a slot the kit fills. A new test (`test/fallback-template-cap.test.mjs`)
  pins that template — empty and filled — under the 100-line cap.
- **Bootstrap** and **upgrade** (`SKILL.md`) now run `reconcile`. On upgrade it runs
  **before** the lineage short-circuit, so the slot is reconciled on every upgrade — reaching even
  legacy **`1.3.0`** deployments — **without bumping the deployment-lineage head**.

The deployment-lineage head **stays `1.3.0`** and `agent-workflow-memory` is **untouched** (no code,
version, or migration change): reconciliation is stamp-independent, so it needs no head bump (which
would have forced a memory republish, since the head is hard-coded in memory's stamp module).
Additive — no user-facing break. The engine's npm packaging, `available:true`, and the live
`kit → engine` read selector are deferred to the next plan.

## 1.5.2 — README uplift to front-door grade (docs)

Docs-only patch. The npm-facing `README.md` is uplifted to match the GitHub family front door's
pitch and voice while staying the kit's **manual**: a stronger hero, a compact "Part of the
agent-workflow family" callout, a new **composition-root** section (the kit delegates to the memory
substrate, injects the methodology, and detects the optional `codex` / `agy` bridges — all on the
in-repo deploy, never on `npx … init`), a two-tier cross-agent note, and links **up** to the family
front door instead of re-telling the whole-family story (AD-009). Accuracy passes hold: `init` ≠
project deploy, the scoped `dependency-free` / `no telemetry` claims, bridges-as-skills, the
`available:false` engine stub, and the bridge context-file priority. A new dev-only test
(`test/readme-structure.test.mjs`) enforces fenced-ASCII width ≤ 78, in-page anchor resolution, and
local-link existence across the published READMEs. No code, schema, or deployed-payload change; the
deployment-lineage head stays `1.3.0` (no migration).

## 1.5.1 — README hero fix (docs)

Docs-only patch. The hero showed a hardcoded `v1.4.0` chip while the kit was 1.5.0; the chip is
removed (the shields.io npm-version badge already shows the live version). A repo test
(`test/readme-no-stale-version.test.mjs`, dev-only — not shipped) now asserts no published README
hero carries a pinned `vX.Y.Z` chip, so the drift can't recur. No code, schema, or deployed-payload
change; the deployment-lineage head stays `1.3.0` (no migration).

## 1.5.0 — Backend detection (detect + guide)

The kit's onboarding can now **see the optional execution-backends** — the thin bridges to
subscription CLIs (`codex-cli-bridge` → `codex`, `antigravity-cli-bridge` → `agy`) — instead of
being blind to everything but the memory substrate. **Additive and read-only**: no `capability.json`
schema change, no validator change, no auto-install. Since nothing in the deployed `docs/ai/`
structure changes, **no migration is needed** and the deployment-lineage head stays `1.3.0`
(`upgrade` reconciles and re-stamps with nothing to apply).

- **`tools/detect-backends.mjs` — the read-only detector.** Pure, dependency-injectable,
  dependency-free (Node ≥ 18), and already shipped (it lives under `tools/`, which is in the
  package `files` + the installer `PAYLOAD`). It reports two **decoupled** axes so a healthy
  manifest is never confused with a usable backend: `manifestState` (health of the bridge *skill*:
  `not-installed | unsupported-schema | invalid-manifest | foreign | stub | ok`) and the readiness
  signals `cli` / `credentials` / `wrappers`, probed **independently** for every registry entry even
  when the skill is absent — so "the `codex` CLI is installed and signed in, but the bridge skill
  isn't" reads as `needs-skill`, with the setup pointer. Every fs probe is wrapped → an explicit
  `unknown` + reason, never a throw and never a nameless failure.
- **Detection is read-only — it never runs a subscription CLI.** "credentials present/missing" is
  the existence of the credential-marker **file**, never a live `codex login status` / `agy` check
  (which would spawn a paid, slow, networked CLI). The report deliberately never says
  "authenticated" (a unit test asserts the word's absence).
- **Kit-owned registry (`KNOWN_BACKENDS`), not a schema change.** A missing bridge has no manifest
  on disk and no `setup/README.md` in the kit tarball, so the per-backend facts (`bin`, credential
  marker, stable setup URL) must live in the detector. A **drift-guard** test keeps the registry in
  lockstep with the in-repo manifests (set equality with every `kind:execution-backend` dir, unique
  names, `detect.installed` match, `setup/README.md` exists).
- **Two surfaces.** A new **`/agent-workflow-kit backends`** mode presents the table and, for any
  backend that is not `ready`, points to its setup (local `setup/README.md` when installed, else the
  setup URL). Bootstrap **step 11** also prints a one-line backends summary — read-only, and it
  **never blocks the commit gate**. Honest about Windows: detection works, but the bridges' POSIX
  `.sh` wrappers are not promised to run there.

## 1.4.0 — Delegation-aware composition root (agent-workflow family, Plan 1)

The kit becomes the **composition root** of the new `agent-workflow` family. **Additive** — the
kit keeps its entire bundled substrate as a fallback, so the existing one-command install is
unchanged and **no migration is needed** (`upgrade` reconciles and re-stamps; the deployment
lineage head stays `1.3.0`). Published from the new `agent-workflow` monorepo.

- **Memory extracted to `@sabaiway/agent-workflow-memory`** — the memory substrate (`docs/ai/`,
  the entry point, caps / archive / index, the three setup contracts) now also ships as its own
  package. The kit **delegates** substrate deployment to it when a **kit-owned detector** finds it
  valid, and otherwise uses its own bundled copy. Detection runs the kit's **own shipped**
  `tools/manifest/validate.mjs` (never a validator shipped by the candidate) and requires
  `kind: memory-substrate` **valid** plus all required assets present; unsupported / invalid /
  unavailable / wrong-family / wrong-name → bundled fallback. The fallback decision is made
  **before** any project write.
- **Family manifest contract** — every member ships a `capability.json` (`schema 1`, JSON,
  dependency-free). The kit **owns and ships** the schema + validator at `tools/manifest/`
  (in the tarball + installer `PAYLOAD`, so an installed kit can run the detector; root CI invokes
  the same file). The kit's own manifest is `kind: composition-root`.
- **Methodology slot injection** — memory ships an **empty** delimited `workflow:methodology` slot
  in `AGENTS.md`; the kit is its **only** writer, injecting a **bounded** summary + pointer
  (`tools/inject-methodology.mjs` + `tools/methodology-slot.md`) that keeps `AGENTS.md` under its
  ≤100-line cap. Marker contract: exactly one ordered pair → replace between; absent → no-op;
  malformed → no-op with an error.
- **Two-stamp delegation hand-off** — delegated mode: memory writes `.memory-version`, the kit
  injects + writes the fallback `.workflow-version` (→ both stamps); fallback mode: `.workflow-version`
  only. Exactly **one** composition-level commit gate, owned by the kit, after injection. The
  decision + hand-off matrix is codified and unit-tested in `tools/delegation.mjs`
  (`detectMemory` + `handoffPlan`), so it does not depend on agent interpretation.
- **Release gate — attribution-off** — `tools/release-scan.mjs` fails on AI/reviewer attribution
  (co-author trailers, "Generated with <AI>" footers) anywhere in the release tree, so no agent
  attribution can ship by accident.
- **Hardened installer** — `copyRecursive` never writes *through* a destination symlink
  (root / intermediate / leaf). `capability.json` + `tools/` added to `files` and the installer
  `PAYLOAD`. `repository`/`homepage`/`bugs` repointed to the `agent-workflow` monorepo.

## 1.3.0 — Skill authoring aligned with Anthropic's Skills guidance

Internal refinements to how the kernel itself is written — no change to what gets deployed into a
project, so **no migration is needed** (`upgrade` reconciles and re-stamps to `1.3.0` with nothing
to apply). Drawn from [*Lessons from building Claude Code: how we use Skills*](https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills).

- **Consolidated Gotchas section in `SKILL.md`** — the blog calls the Gotchas section "the highest-signal content in any skill". The non-obvious traps that were scattered through the procedure (harness-added `Co-Authored-By` vs prose, hidden mode never touching `package.json`, `CLAUDE.md` as a symlink not a copy, source-vs-target dir, no-Node → skip enforcement, never overwrite an existing entry point/hook) are now also a single scannable list.
- **Setup contracts moved to `references/contracts.md`** — progressive disclosure: `SKILL.md` keeps a lean *Setup contracts* pointer (with one-line defaults), and the full Visibility / Communication / Attribution rules load only when needed. Trims the always-loaded `SKILL.md` by ~40 lines without losing any rule.
- **Setup questions use structured prompts where supported** — the three bootstrap questions (visibility, language, attribution) and the equivalent `upgrade` migration questions now call for a structured multiple-choice prompt (`AskUserQuestion` in Claude Code) where the agent supports it, falling back to prose elsewhere — keeping cross-agent portability (Codex / Cursor / Devin) intact.

## 1.2.0 — Agent attribution is opt-in

**Attribution question at setup**

- **Bootstrap now asks whether the agent may attribute work to itself / AI** — a new step 4 in `/agent-workflow-kit`, alongside the visibility and language questions. The answer is recorded in a new *Attribution* block in the project's `AGENTS.md`, so every agent that reads the entry point honours it.
- **Default is `off`** — people are routinely surprised to find an AI listed as a repo contributor (a single `Co-Authored-By` trailer is enough to do it, and GitHub keeps it via permanent PR refs). So attribution is **opt-in**, never opt-out.
- **`off` means nowhere** — no `Co-Authored-By` trailers, no "Generated with …" footers, and no AI/agent/model mentions in code, comments, commit messages, PR titles/bodies, branch names, or docs. The work reads as the human author's.
- **Two enforcement layers** — the *Attribution* block binds everything an agent writes by hand; the automatic `Co-Authored-By` trailer is added by the **harness**, so for **Claude Code** the kit also sets `"includeCoAuthoredBy": false` in the project's `.claude/settings.json` (a doc directive alone can't stop a harness-added trailer). See the *Attribution contract* in `SKILL.md`.
- **Existing deployments are covered** — `/agent-workflow-kit upgrade` backfills the block on a pre-1.2.0 project, asking (and defaulting to `off`). See `migrations/1.2.0-agent-attribution.md` (idempotent, additive).

**Devin Desktop rebrand (formerly Windsurf)**

- Cognition rebranded Windsurf → **Devin Desktop** (and Cascade → **Devin Local**) on 2026-06-02. Docs, install messages, and labels now say "Devin Desktop"; `windsurf`/`devin` are both kept as keywords. The launcher is unchanged functionally — the `~/.codeium/windsurf/global_workflows/` paths persist, and detection now also recognises a `devin` binary.

## 1.1.0 — Conversational language + unambiguous install guidance

**Conversational language (dialogue only)**

- **Bootstrap now asks the conversational language** — a new step 3 in `/agent-workflow-kit`, alongside the visibility question. The agent records the answer in a new *Communication language* block in the project's `AGENTS.md`, so every agent that reads the entry point talks to the user in that language and stops drifting between languages mid-session.
- **Dialogue-only scope, by design** — the choice governs what the agent writes *for the user to read* (questions, explanations, summaries, status). Code, identifiers, file paths, shell commands, log output, and abbreviations stay in their source language; the deployed `docs/ai/` files and `AGENTS.md` are not translated either (the conversational choice governs the chat, not the artifacts). See the *Communication contract* in `SKILL.md`.
- **Existing deployments are covered** — `/agent-workflow-kit upgrade` backfills the block on a pre-1.1.0 project, asking the user their language. See `migrations/1.1.0-communication-language.md` (idempotent, additive).

**Clearer install / upgrade guidance**

- **`init` now distinguishes a fresh kit install from a refresh** — prints `installed v…` the first time and `updated the kit to v…` on re-run, so it's obvious the command targets the *kit*, not a project.
- **The "Next" message is unambiguous about which path to take** — it spells out *first time in a project* (`/agent-workflow-kit`) vs *project already has the kit* (`/agent-workflow-kit upgrade`), and reminds that re-running `npx … init` updates the kit's own files. `--help` and the README install table say the same. Resolves the prior single-line hint that read the same for first-timers and upgraders.

## 1.0.0 — Initial public release

First public release of `@sabaiway/agent-workflow-kit`. The kernel — distilled from a battle-tested, multi-year-verified reference implementation — ships on npm + GitHub so it installs (and self-upgrades) in one command. Adoption is countable from the registry's public per-version download numbers — no telemetry, no phone-home.

**The kernel — a portable AI-agent memory & workflow system**

- **Entry point** — `AGENTS.md` (cross-agent open standard: Codex / Cursor / Windsurf / Copilot read it natively) + `CLAUDE.md` symlink for Claude Code; concise Memory Map, protocols delegated to `agent_rules.md`.
- **`docs/ai/` structure** — `handover`, `active_plan`, `current_state`, `technical_specification`, `architecture`, `known_issues`, `decisions`, `changelog`, `env_commands`, `tech_reference`, `agent_rules` + `pages/` (`index`, `shared-patterns`, `PAGE_TEMPLATE`). Layered lazy-loading: always-loaded / on-demand / hierarchical subdir `AGENTS.md` / archive.
- **Frontmatter caps** — every file declares `maxLines` + `staleAfter`; the validator errors over cap, warns when stale.
- **Index-freshness gate** — `check-docs-size.mjs --check-index` regenerates the navigator in memory and diffs it against the on-disk `index.md`, using the on-disk header date so a day-rollover is not a false positive.
- **3-tier rolling archive** — `archive-changelog.mjs` (HOT changelog → WARM `recent.md` → COLD `YYYY-MM.md`) + condensed-index META; `archive-issues.mjs` for resolved issues.
- **Pre-commit hook** — `install-git-hooks.mjs` wires caps + index freshness + archive checks + the `scripts/` test suite; package-manager-agnostic (`node` directly).
- **Tests** — rotation/cap pure functions covered by `*.test.mjs`, runnable under `node --test` via a zero-dependency `expect` shim.
- **Planning** — `references/planning.md`: Plan→Phase→Step→Substep, ephemeral plan lifecycle, `queue.md` series-index, mandatory Cleanup, plan-then-execute split + session-continuity heuristic.
- **Two modes** — `/agent-workflow-kit` (new) and `/agent-workflow-kit upgrade` (existing).
- **Cross-agent invocation** — `launchers/`: `SKILL.md` is a native Codex skill (same cross-agent standard); a Windsurf workflow launcher + `install-launchers.sh` let Codex/Windsurf users run the bootstrapper too, not just Claude Code.
- **Visibility** — `visible` (committed) and `hidden` (in-tree, hidden via `~/.gitignore_global`).

**Distribution & install**

- **`npx @sabaiway/agent-workflow-kit init`** — `bin/install.mjs` (dependency-free, Node ≥ 18) copies the kit into `~/.claude/skills/agent-workflow-kit/` and runs `launchers/install-launchers.sh` (auto-detects Codex / Windsurf). `--dir` / `AGENT_WORKFLOW_KIT_DIR` override the target; `--no-launchers` skips the wiring.
- **Self-upgrade** — `npx @sabaiway/agent-workflow-kit@latest init` refreshes the kit's own files; distinct from `/agent-workflow-kit upgrade`, which migrates a project's `docs/ai/` deployment.
- **Manual install still supported** — `git clone` + `install-launchers.sh`; only the npx path is reflected in install stats.
- **Additive & safe** — the installer writes only the kit's own namespaced slots and never deletes your settings. A pre-existing non-kit Codex link or Windsurf workflow is left untouched unless you pass `--force`, which backs it up to `*.bak.<timestamp>` and prints a restore command first. Windsurf launcher files carry an `agent-workflow-kit:managed` marker so the installer can tell its own file from yours.

**Known limitation** — condensed-index grows O(total archived entries); shard per-year on a multi-year horizon (noted in `archive-changelog.mjs`). Fully-external hidden mode is deferred to a later release.
