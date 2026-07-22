# Changelog — agent-workflow (monorepo)

Repo-level history for the **agent-workflow** family monorepo. Each published package is
versioned **independently** — see its own changelog for package-level detail:

- `@sabaiway/agent-workflow-kit` → [agent-workflow-kit/CHANGELOG.md](agent-workflow-kit/CHANGELOG.md)
- `@sabaiway/agent-workflow-memory` → [agent-workflow-memory/CHANGELOG.md](agent-workflow-memory/CHANGELOG.md)
- `@sabaiway/agent-workflow-engine` → [agent-workflow-engine/CHANGELOG.md](agent-workflow-engine/CHANGELOG.md)

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
