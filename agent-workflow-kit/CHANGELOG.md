# Changelog — agent-workflow-kit

Semantically versioned ([semver](https://semver.org)), newest first. The `version:` in `SKILL.md`
is the current release. `upgrade` mode reads a project's `docs/ai/.workflow-version` and applies
every `migrations/<version>-<slug>.md` newer than it, in semver order.

## 3.11.0 — the record attests only a verified provision; tracked plans-chain paths refuse (AD-072)

Two provision honesty fixes from the converged resume-verify design (its slice R1; the
tolerance flip is the next slice):

- **The provision record is refreshed LAST — after the in-flight-plan check and the
  post-provision verify, in BOTH lanes.** The record now attests only a VERIFIED provision: a
  first provision that fails after the stub write leaves the STUB (identity still binds from
  it — `--resume` completes as before; a pre-write refusal leaves no handoff at all), and a
  failed resume leaves the PRIOR record bytes byte-exact. Previously a failed
  run left a freshly refreshed record (the 3.6.0 stated residual — now eliminated). A refresh
  failure after a clean verify keeps the worktree and names the exact re-run command in both
  lanes, preserving the original failure cause.
- **A TRACKED plans-chain path — the handoff or the seeded plan — refuses fail-closed in both
  lanes.** Its drift is undeliverable (`land` categorically refuses docs/plans, and satellite
  commits are not a lane), so tolerating it would strand the worktree. A fresh provision proves
  both paths untracked at ONE captured commit — the same OID the branch is cut from — and
  re-probes the new worktree's index and branch HEAD before the first write, catching
  post-checkout hooks that force-add or even COMMIT them (a committed add leaves the tree
  clean, invisible to the clean-tree verify). `--resume` probes the branch HEAD tree
  unconditionally plus the live index before reading the handoff identity.
- **Recovery is surgical and honest.** An index-only entry names a pathspec-LITERAL
  `git rm --cached` (a magic-shaped seed name never touches a pattern-matching neighbor) plus
  the ignore-rule restoration when the worktree's live rules lost it; a branch-HEAD-tracked
  file names salvage FIRST, then consented `cleanup --abandon` ONLY where the record identity
  binds (a malformed record routes to the shipped record recovery — abandon is never promised);
  the post-add hook STOP names inspect/salvage, then plain-git removal (never `cleanup
  --abandon` — no handoff identity exists yet); an irregular entry (tree / symlink / gitlink)
  fails closed with NO recovery command. Recovery never routes through the landing lane.
- **The mode doc states both contracts verbatim** (the corrected verify-then-refresh order and
  the plans-chain refusal), each pinned by a named test. Resume tolerance is UNCHANGED this
  release: the blanket clean-tree verify stays, pinned byte-exact.

## 3.10.0 — install advice reads the worktree checkout (AD-071)

The install advice picked its package manager from MAIN's `package.json` and lockfiles while the
printed command targets the SATELLITE (`cd <worktree> && <manager> install`) — so a dirty MAIN
lockfile could push the advice into ambiguity or the wrong manager, and a MAIN advanced past the
satellite's base steered a satellite it no longer describes. The evidence and the target are now
the SAME tree:

- **Manager evidence reads the worktree's own live checkout** — the `packageManager` field and
  the lockfile scan, the same live lane the dependency-free proof (3.6.0) and the node_modules
  symlink probe already use. MAIN's mutable working tree never steers manager selection; MAIN
  state legitimately steers only the symlink lane (the shared-cache link and its unlink-first
  posture), unchanged.
- **The contract ships in the worktrees mode doc as one pinned sentence** (a named test locks
  the exact wording): all manifest/lockfile install evidence is read from the worktree's own
  live files at the moment the posture is resolved — deliberately NOT «exactly HEAD», because a
  `post-checkout` hook can shape the checkout before the posture is resolved.
- **No resume-tolerance smuggling.** The shipped clean-tree `--resume` STOP is pinned byte-exact
  by a real-git test; dirty-resume semantics remain a queued redesign. A satellite behind an
  advanced MAIN now gets advice about ITSELF — pinned by a real-git test where MAIN's lockfile
  advance does not re-steer the satellite's refreshed record.
- **Honest residual:** a manager signal living only in MAIN's working tree (e.g. an ignored,
  uncommitted lockfile) no longer steers the advice — the checkout is the truth even when that
  yields the npm default.

## 3.9.0 — the --include copy door proves what it copies (AD-070)

Nothing bound the node the provision copy walk read to the node `--include` preflight approved:
a source swapped after preflight was copied as approved, and the path-based queue guard could not
see a node that had become the shared series index by identity (a hardlink, a swap) rather than
by path. The gap is closed at the existing descriptor door:

- **Preflight identity, captured before any git mutation.** The `--include` loop records each
  root's {device, inode, kind} from the canonical node. A root that is neither a regular file
  nor a directory — or an erroring identity probe — refuses BEFORE `git worktree add`: no
  worktree is left behind.
- **Three tiers at the walk.** A file root is verified at the door — the open descriptor must
  match the preflight identity, and a node that is no longer a plain regular file stops before
  any destination exists. A directory root gets a walk-start recheck (a recheck, not a binding).
  Child files keep the existing same-call lstat↔open identity; the child walk stays path-based
  (a stated residual).
- **The door-time queue refusal, every copied include file.** With the source descriptor open,
  the door opens the lexical queue path (following links, non-blocking — a FIFO-shaped queue
  classifies non-regular and stops), fstats the open descriptor, and compares identities with
  both descriptors open: never copy the node that IS the door-time queue. Queue identity is
  established at descriptor-open time and never cached across crossings — absence is not cached
  either. A truly absent queue keeps the lexical guard alone; a dangling, unreadable, or
  non-regular queue is unprovable and stops the copy. The queue descriptor closes exactly once;
  a close error surfaces without destination residue.
- **The contract ships as an exported constant** (`INCLUDE_IDENTITY_RULE`), emitted on every
  include-identity STOP and doc-parity-pinned into the worktrees mode doc.

## 3.8.0 — cleanup never deletes a node_modules it cannot prove ephemeral (AD-069)

Routine non-abandon `worktrees cleanup` used to delete an ignored user-built `node_modules`
silently: `node_modules` sat unconditionally in the provision-owned root lists, so real user data
was treated as removable provision footprint. The ownership call is now made LIVE, at cleanup
time, from what deleting the node would destroy — never from who created it, and never from the
handoff record:

- **The gate** classifies the worktree's `node_modules` with one no-follow lstat and (for a
  symlink) one buffer-form readlink: EPHEMERAL exactly when the raw target bytes equal MAIN's
  `node_modules` path — a relative or re-encoded target that merely resolves to main stays
  foreign, and the target's kind is irrelevant. Everything else — directory, file, special node —
  is FOREIGN. The lane is tracked-first: a tracked path or tracked descendant wins over any
  ignore rule, and an absent node with a live index entry is never clean-absent.
- **The one exemption** is the ignored-lane matching symlink (exactly what provision creates):
  the ignored inventory skips it and plain `git worktree remove` unlinks it — after the gate's
  verdict is RE-PROVEN, same class same lane, immediately before the irreversible remove. Any
  change in between, or any probe error at any point, is a fail-closed STOP with no remove call.
- **Every other state stops surgically**, and the recovery matches the lane and kind: ignored/
  untracked symlink, file, or special node → the exact single-node `rm`; directory → the
  recursive form; then re-run cleanup (`--abandon` always named second). A TRACKED
  `node_modules` never gets an `rm` — land its removal from MAIN instead. Probe errors offer no
  removal command at all. A clean-absent verdict follows the legacy path unchanged, so landing a
  tracked `node_modules` removal still converges. `--abandon` behavior is unchanged.
- The contract sentence ships as the exported `CLEANUP_OWNERSHIP_RULE`, emitted on every
  ownership STOP and pinned into `references/modes/worktrees.md` by a new doc-parity binding.

Honest residuals, stated in the mode doc: the revalidation→remove window stays open (git performs
the removal; no door there, deliberately); content that git cannot see — or that appears after
the inventories inside a reset-restored tracked directory — remains a pre-existing generic
worktree-removal residual, no longer masked by a false ownership claim; on Windows a strict-bytes
mismatch degrades to the surgical STOP, never a deletion.

## 3.7.0 — the worktrees-dir advisor item can finally converge (AD-068)

The `recommendations` advisor's `worktrees-dir` item used to fire forever: its only convergence
signal was a host write-capability callback that production never supplies, so the item kept
re-rendering even once its own advice had been applied. It now converges on either of two
maintainer-visible signals — while a genuinely supplied host signal still overrides both, in
EITHER direction (a trusted no keeps the item firing however the project is configured):

- **a declared grant** — a `sandbox.filesystem.allowWrite` entry covering the probed worktrees
  parent dir, in either settings scope; `~`/`~/…` resolve against home, and coverage is
  path-segment-aware (a grant on a sibling or on a child never counts). A declaration is proof the
  maintainer applied THIS item's advice, never proof of write capability — the provision
  preflight's real create+delete probe stays the runtime truth. The declaration read is guarded
  no-follow end to end (an out-of-project store reached through a symlink cannot silence the item;
  a non-regular target is a stated skip), and the `allowWrite` shape check is fail-closed over the
  whole array — one malformed entry invalidates the list rather than hiding beside a good one;
- **a dir-bound ack** — for hosts that ignore the settings key: the item's consent-gated APPLY
  one-liner is `ack-write --lane worktrees-dir` (a dry-run preview that prints the exact `--apply`
  which records the ack), while the HAND-APPLY grant advice rides the `recipe:` line as the
  labeled first step — the consent flow waits for the grant (or the terminal-fallback choice)
  before the ack runs, because the ack RECORDS a choice, never makes one. The recorded
  `worktreesDirAck` fingerprint lives in the family-owned `docs/ai/acks.json` and binds to the
  RESOLVED probe dir, so the item re-fires exactly when that resolved dir changes — never on a
  no-op re-render, never a security key. Against a trusted host NO the apply stays the HAND-APPLY
  grant advice and no ack surfaces (it could never converge there).

`ack-write` accordingly grows a closed-world `--lane` registry (`sandbox-lane` — the default, so
every existing invocation and rendered one-liner stays byte-identical — and `worktrees-dir`); one
lane sets exactly ONE store key, merge-preserving the rest, and an unknown lane is a usage refusal
at the writer, never an invented key in the shared store.

Honesty fix riding along: every shipped surface that promised the read-lane hook «fires on
subagent Bash too» now says «where the host fires hooks on subagent Bash» — that behavior has
never been measured, and a shipped surface must not assert it.

## 3.6.0 — the dependency-free install posture: a proof, never a default (AD-067)

On a provably dependency-free project the provision record and the default-lane report no longer
print a generic `npm install` hint: both state
`no install needed — the project declares no dependencies` (recorded node_modules mode
`no-dependencies`), and a `doc-parity` binding pins the posture string to the mode doc.

The verdict is a PROOF granted only on evidence the tool actually read — the WORKTREE'S OWN LIVE
checkout: what an install run there would actually read, exactly HEAD at provision time and the
satellite's own committed state on `--resume`, never MAIN's mutable working tree (which can
diverge from what the satellite actually holds; real-git tests pin both refresh directions).
Everything the tool cannot vouch for leaves the posture UNKNOWN with the honest advice kept — the
fail-safe direction, because a false "nothing to install" is worse than a redundant hint:

- a `workspaces` field of ANY shape, outright — a workspace install materializes member links and
  `.bin` shims even with zero dependencies, so a workspace tree is never provably install-free;
- an external workspace manifest beside the root (`pnpm-workspace.yaml`/`.yml`, `lerna.json`);
- a malformed manifest, dependency field, or `scripts` shape (three-valued verdicts — malformed is
  `unknown`, never "none"; a lifecycle key with a non-string value fails closed);
- an install-lifecycle script — dependency-free is NOT install-free: the CLOSED, test-pinned set
  is the npm lifecycle (including the deprecated `prepublish`) plus `pnpm:devPreinstall`; a
  native-addon manifest (`binding.gyp`) is a mandatory install too.

The posture COMPOSES with the shipped record contract, and LIVE STATE WINS: a node already at the
worktree — a directory, or a symlink left by an earlier provision, even dangling — records
`present` before any MAIN-state early return, the AD-065 symlink unlink-first arm is untouched for
every non-proven project, and `--install` remains an explicit request that is always answered with
the isolated-install command while the record still states the posture.

Third safe slice of the deferred parallel-track work (AD-063); node_modules ownership and
resume-verify semantics stay separate redesigns.

## 3.5.0 — the provision record orients a fresh satellite session (AD-065)

The worktrees provision record was an identity stub; a fresh satellite session could not derive
three facts from its own checkout. The record now carries all three, and the mode doc is pinned to
the live constants:

- **`shared-queue`** — the ABSOLUTE path to MAIN's `docs/plans/queue.md`, followed by the verbatim
  rule: the series index is SHARED, read it at that path, never copy it (a machine-local copy
  silently diverges); findings ride the handoff record and main appends them to the index. The rule
  ships only WITH the path — a record from an earlier kit carries neither. `--include` refuses to
  copy the index (or any directory containing it) into the worktree, at preflight AND re-asserted
  at the point of copy on the canonical pair resolved before `git worktree add`.
- **`landing`** — landing runs FROM MAIN, never from the worktree, with the runnable
  `… land <slug> --prepare` command already `cd`-ing back to main.
- **`install`** — the resolved install posture: the runnable isolated-install command, or the
  honest by-hand advice when the package manager is ambiguous.

The record is line-oriented and parsed back for IDENTITY, so it now REFUSES any value it cannot
round-trip: control bytes (an injected newline forges a field line or an `## …` heading that
truncates the section) and U+2028/U+2029 (which write fine and are then silently DROPPED on read —
a lost field with no error) are a typed STOP, never sanitized. Every value the record will carry is
validated BEFORE any git mutation — a refusal at compose time would strand a created worktree with
no handoff, which neither `--resume` nor `cleanup --abandon` can recover. Optional fields are
omitted when absent, never rendered as `null`, so a record written by an earlier kit survives a
refresh. Two new `doc-parity` bindings (`queue-shared-rule`, `landing-from-main`) pin
`references/modes/worktrees.md` to the emitted strings.

Second safe slice extracted from the deferred parallel-track work (AD-063) — no
node_modules-ownership coupling; the provable dependency-free install posture is the next slice.

## 3.4.0 — review-state names a latent arm on a clean-tree PASS (AD-064)

`review-state --check` under a configured `reviewed` or `council` recipe on a clean tree no longer
returns a bare `PASS — nothing to review`. It now NAMES every plan still in flight and states the
forward consequence — `this gate arms as soon as the
tree is dirty` — so a spent boot prompt left under a bare name is discoverable BEFORE it blocks,
instead of surfacing at the worst moment: a pending commit, or the landing of a feature worktree when
main first turns dirty. The quiet case (configured `solo`, no plan in flight, a non-git cwd) still
passes silently through the earlier-returning arms; dirty-tree behaviour is unchanged. A `doc-parity`
binding pins the
live notice to `references/modes/review-state.md`, so a reworded doc that drops it fails the gate — a
prose-only bar becomes a mechanism. This is the safe, converged slice of the deferred parallel-track
work (AD-063), shipped on its own with no worktrees-ownership coupling.

## 3.3.0 — version-pin honesty: the profile stops claiming a limit it never observed (AD-062)

`velocity --autonomy` told every user their credentials could not be protected by the sandbox —
naming a harness version frozen in the source, 30 patch releases stale, while a comment three lines
above recorded when the capability had actually arrived. A user who declared
`redlines.credentials=deny` got no `sandbox.credentials` key and a confident explanation that the
platform could not enforce it. Not a silent failure: a false claim about a security control.

Nobody can guarantee a vendor's version format, install layout or settings schema stays put, so the
fix is not "read the right version" — it is **never state what was not observed**. A pin goes stale
silently; a probe goes stale loudly, and that direction is the whole point.

- **`probeHarnessVersion`** reads the INSTALLED harness at render time — read-only PATH resolution,
  never a spawn. Two layouts matched exactly (`claude/versions/<version>` and the
  `@anthropic-ai/claude-code` package.json); a third-party wrapper whose name merely contains
  "claude", a decorated version segment, and a prerelease all resolve to a STATED unknown. A
  programming defect inside the walk is rethrown rather than reported as an unknown layout, and an
  unreadable package.json surfaces instead of folding into "not found".
- **A supported build now gets the protection.** `sandbox.credentials` is rendered, MERGED into
  settings (hand-declared `files` and foreign entries survive), drift-checked and local-mask-checked
  — the render owns exactly the entries for the env vars it protects, nothing more.
- **Every honest limit is a loud degrade, not a note.** Coverage is stated PARTIAL (env vars only;
  file credentials are NOT rendered, because that entry shape was never verified against an
  installed build). `credentials=ask` degrades rather than being quietly upgraded to deny. An older
  build, or one whose version cannot be RESOLVED from a recognised layout, degrades naming what was
  observed or stating that nothing was — and a PASSING `--check` prints the degrades too, because
  "in sync" only means the file matches the render. An UNREADABLE install (a permission error) or a
  defect inside the probe is a different outcome on purpose: it throws loudly rather than degrading,
  because "cannot confirm" must never read as "confirmed absent".
- **New `version-pin` rung in `release-scan`.** A harness version literal under `tools/` fails the
  scan unless a runtime probe sits beside it in the same JS file. The harness series is discovered
  from the scanned file, never hardcoded — a scanner carrying its own pin would be an instance of the
  class it catches, and a self-refusal test enforces that. Prose earns nothing: a `#` comment in a
  shell script or a line of Markdown cannot hold a probe, so those files stay scanned.
  **Stated residual, argued in the source:** the rung proves a probe is PRESENT, not that its result
  is compared with the literal. Proving the latter is JS lexing; an approximation of it was tried and
  withdrawn, because each increment of precision opened a new hole without buying the guarantee.

## 3.2.0 — plain language + posture as code: the friction cluster shipped as mechanism (AD-061)

Carrier release for a friction cluster (kit 3.2.0 bundles the bridges + shared contract + the
plain-language template bar; memory 3.1.0, codex bridge 3.1.0, agy bridge 4.1.0 ride alongside;
engine unbumped). The packaged fixes below ship as MECHANISM for every user, never as one agent's
discipline.

- **Shared command-shapes contract.** New `references/shared/command-shapes.md` states the
  promptless bar for improvised reads/probes — the host's file-read tool, else ONE plain
  undecorated command (no compounds, redirects, pipes, or command substitution; improvised writes
  use the host's file-edit tools). Bound via the existing `Requires:` mechanism to exactly the
  probe-instructing modes (bootstrap / upgrade / velocity, closed-world pinned) + a one-sentence
  inline bar on the SKILL.md router stamp-read. The honest residual is stated (a decorated form is
  host/config-dependent) — never a false "always prompts" guarantee.
- **Plain-language §2.5 Communication bar** in BOTH deployed `agent_rules` templates,
  byte-identically (the kit fallback deploy path communicates under the same bar): user-facing
  narration is short and plain in the dialogue language; transliterated jargon is banned; an
  English term survives only as the NAME of a thing (flag / command / file / test), glossed.
  `lens-region.mjs` now reconciles a SECOND region (Communication, canon from the kit's own bundled
  template) so EXISTING deployments gain the bar on `upgrade`, not only new bootstraps.
- **Posture as code on the codex-exec dispatch and both review dispatches** (bridges bundled here).
  `codex-exec` gains a D5 exec posture banner (fresh + resume, resolved post-validation values, a
  validated resume-id grammar + raw-byte NUL screen, control-byte refusal on every field). Both
  review banners gain a BANNER-ONLY `timeout` field — outside D5 banner↔receipt parity — from ONE
  shared effective-timeout resolver (byte-identical across the four wrappers) that closes the old
  env-validation bypass and resolves the timeout binary shadow-proof; no capping binary →
  `timeout=uncapped`, never fabricated. (The raw `agy-run` probe lane keeps no posture banner —
  out of scope this release.) The quote-the-banner-verbatim duty rides both bridges' driving
  contracts, capability notes, and the kit registry mirror, drift-guarded by a new cross-file test;
  the threat-model boundary is stated on the codex execute capability and `codex-exec --help`
  surfaces, including the kit mirror. The read-only `bridge-settings` advisor mirrors the wrapper's
  control-byte refusal semantics with escaped output.

## 3.1.0 — parallel feature worktrees v1: provision · list · land --prepare · cleanup (AD-060)

New `worktrees` mode + `tools/worktrees.mjs` — several features implemented simultaneously in
DIFFERENT agent sessions on one machine/repo, zero interference on working-tree files (the ONE
exception: the default `node_modules` symlink is a shared MUTABLE dependency cache — the printed
isolated install is the isolation lane), unambiguous ownership. One thin dependency-free tool over git: every verification datum is recomputed live
from git, never read from stored metadata (the ONE exception: the PREPARED OID in the handoff,
read back only for recovery). Git >= 2.36 floor (NUL-terminated worktree porcelain); typed STOPs,
never a guess.

- **`provision <slug> --plan <path>`** — visible sibling worktree + `aw/<slug>` branch: the
  registry-derived footprint copy-if-missing (a tracked file is NEVER overwritten), exactly one
  seeded feature plan, the `handoff-<slug>.md` stub, shared-`node_modules` symlink advice
  (`--install` only PRINTS the isolated install — zero spawn, zero write). `--resume` completes a
  half-done provision behind fail-closed identity: at most one handoff, slug AND branch must
  match, the section-required `## Provision record` (a duplicated field or section is a STOP,
  never last-wins), user content preserved byte-exact.
- **`list`** — read-only and honest: any read failure renders `handoff: (unreadable)` — a silent
  "no" never appears.
- **`land <slug> --prepare`** — the transient common-git-dir lock (shared with cleanup),
  dirty-main / graph-divergence / docs-ai-drift / red-review-state refusals, the satellite
  working-tree diff versus its base — staged AND unstaged inspected, every unstaged or
  untracked-not-ignored leftover listed and refused (ignored content is outside observation by
  design) — binary-safe transfer excluding exactly `docs/ai` + `docs/plans`, the optional
  porcelain-visible sync adapter, the main gate matrix, and an OID report (main HEAD · TRANSFER ·
  PREPARED · sync delta). The commit is NEVER run by the tool — it stays a dialogue ask. A second
  prepare is reset-only against the recorded PREPARED OID; transfer-apply and post-launch sync
  failures attempt a byte-clean rollback (rollback failures are composed without losing the
  primary error), while a red gate matrix that leaves the snapshot unchanged intentionally KEEPS
  the prepared tree and names both recovery lanes.
- **`cleanup <slug>`** — live landed-verification against main HEAD (exact land-exclusion
  parity), typed-EXACT ownership of ignored content (file/glob roots own only files), literal
  pathspecs, branch `-d`, prune; foreign content stops it. `--abandon` is the ONE destructive arm
  (`-D`; requires the handoff identity).
- **Hardening:** every content read and regular-file copy goes through two no-follow descriptor
  doors (identity-bound source · exclusive destination · descriptor-mode update), pinned as the
  only paths by tripwire tests; strict parsers everywhere (NUL porcelain fields,
  scan-before-parse JSON with any-depth duplicate-key refusal, atomic section surgery).
- **release-scan:** the reviewer-round-identity rung — an `agy` or `codex` name followed by an
  R-number reference is refused; shippable finding IDs use neutral
  `review-<scope>-rNN-<severity>-NN` IDs; the clean line now reads "no AI attribution or
  reviewer-round identity found".
- **recommendations:** the worktrees parent-dir item — write access stays "not confirmed" without
  a trusted host-capability signal; HAND-APPLY lines are host-qualified.
- **Docs:** the `references/modes/worktrees.md` contract — the MAIN/SATELLITE ownership matrix
  (shared git state included), satellite forbidden verbs (the v1 docs-only bar), the
  host-specific consent lane, and the other-harnesses PROVEN/ASSUMED split.

## 3.0.0 — strip-the-kit: the hardened computed core replaces the ledger machinery (AD-059)

> ### ⚠ BREAKING — the review loop is now computed, not recorded
>
> The review-ledger / fold-completeness / verification-profile / sarif / seed-gates tools, their
> modes, and their git-dir stores are **DELETED**. `run-gates --record` is a usage error (exit 7
> retired); the loop's ONE receipt is `run-gates --final`. Review receipts without a self-declared
> `posture` field (any pre-3.0.0/4.0.0 bridge wrapper) **stop satisfying** the review-state gate —
> fail-closed, like the AD-057 probe marker; re-run the reviews on the refreshed bridges. Node
> floor is **>= 22** family-wide. The consented `migrate-gates.mjs` migrates an existing
> `docs/ai/gates.json` (see `migrations/3.0.0-hardened-core-loop.md`).

The MAJOR family release (memory **3.0.0** / engine **2.0.0** / bundled codex bridge **3.0.0** /
bundled antigravity bridge **4.0.0**; deployment-lineage head **3.0.0**). One theme: **every claim
the loop makes is computed from artifacts it can re-verify — never remembered, never recorded prose.**

- **The hardened core (new tools):** `core-evidence.mjs` — the ONE git-dir evidence writer
  (red-proof records with observed-red 3/3 custody + content hashes; explicit per-backend degrade
  records; the stateless end-of-loop `summary`) · `coverage-check.mjs` — the D3(d) final-run
  checker (changed-line lcov coverage + red-proof verification + the `lcov-sha256=` machine line) ·
  `commit-guard.mjs` — the D10 read-only pre-commit (binds a commit to the LATEST green final
  receipt at the exact tree fingerprint; `--no-verify` stays a stated residual).
- **`run-gates --final`:** canonical realpath-anchored core checks (review-state + coverage-check,
  checker LAST), evidence-store drift teeth, the checker-bound lcov sha with an end re-hash, ONE
  attempt-linked receipt (green/red DERIVED, integrity failures explicit), `AW_GIT_DIR` exported
  to every gate child on every run.
- **`review-state` D3(b):** ship-class-only on the latest NORMAL receipt; a recognized negative is
  an authoritative VETO; unknown verdicts, probe-marked, unmarked, posture-less, and malformed
  receipts never attest (each with its stated recovery); explicit degrade records are the only
  escape and never all backends.
- **Consumer lanes:** `gates-init.mjs` (D9 consented fill preview; the coverage-check candidate
  appended LAST so a whole-offer apply is final-run-ready) · `migrate-gates.mjs` (D8, mirrored
  from the memory canon: canonical-anchor matching with move/collision semantics, the full lcov
  reporter flag set, retired-store cleanup, symlink/control-byte STOPs) · the hook installer's
  explicit `--commit-guard <path>` arm with strict carry-forward · a `commit-guard`
  Recommendations item gated on final-run-capability.
- **Bundled bridges (D4/D5):** a verdict-less review run exits 4 with NO receipt (exact agy
  `### Verdict` parse; structural top-level JSON verdict in codex schema mode); one stderr banner
  states the ACTUAL dispatch posture and every receipt records the same `posture{}`; control-byte
  and unknowable-model postures refuse pre-spend. Manifests carry VALIDATED posture pins; the kit
  renders the CONFIGURED posture (pins + the bridge-settings tier overlay) in the backend status
  line, drift-guarded end to end (`posture-parity`).
- **Suite economics note:** the supervisory ledger cluster (~98% of the old 94s unit matrix) is
  gone with its machinery; the dedicated speedup pass (plan Phase 5) follows post-release.

## 2.1.0 — agy code review fails CLOSED pre-spend: grounded facts required, `--ungrounded` is the explicit escape (AD-058)

> ### ⚠ the bundled antigravity bridge takes MAJOR 3.0.0 — bare `agy-review code` now refuses
>
> `agy-review code` without a NON-EMPTY `--facts` payload exits 2 **before spending a run**
> (previously: a loud warning, then a spent subscription run whose `grounded:false` receipt the
> review-state gate rejects — a guaranteed-wasted spend). Scripts calling bare `agy-review code`
> must add `--facts @f` (grounded) or `--ungrounded` (explicit throwaway opinion; the receipt still
> records `grounded:false` and never attests). `plan`/`diff` modes and continuations are unchanged.
> The kit itself is a MINOR carrier — the incompatibility is created, and declared, by the bridge.

A **fail-closed** release (kit MINOR carrying antigravity-cli-bridge **3.0.0** MAJOR in-tarball;
codex-cli-bridge 2.8.0 / engine 1.17.0 / memory 2.3.0 unchanged; the deployment-lineage head stays
`2.0.0`). One theme: **a run that cannot produce a usable result refuses before the money is spent.**

- **The refusal prints the recovery:** the exact `grounding.mjs` invocation — resolved from the
  wrapper's own location across the three real install layouts (monorepo canon / deployed skills
  sibling / kit-bundled mirror), quoted so an install path with spaces still yields a runnable
  command — plus the `agy-review code --facts @<file>` re-run line.
- **Escapes, both honest:** `--ungrounded` (code-mode only, contradicts `--facts`, refused on a
  continuation) and `AGY_PROBE=1` (a probe may now run ungrounded — a probe receipt never attests
  either way; its `modeCatalog` descriptor now marks the facts file optional).
- **Every declaration home moves in lockstep** (drift-guarded both directions): `--help` ⟷
  `capability.json` (`roles.review.contract` + `modeCatalog` `review.code` operands/guardrails +
  the `AGY_PROBE` env-hook) ⟷ the kit registry mirror (`tools/detect-backends.mjs`) ⟷ `SKILL.md` ⟷
  `references/driving-agy.md` / `models-and-flags.md` / `review-prompt.md`.
- **Receipt contract scoped honestly:** in `code` mode an absent/empty facts payload now means NO
  run and NO receipt; the `grounded:false`-on-empty clause applies to `plan`/`diff` only.

## 2.0.0 — Bridge mode catalog (manifest-as-source) + a review receipt that SELF-DECLARES (AD-057)

> ### ⚠ BREAKING — a review receipt written before this release no longer attests a tree
>
> The kit now **rejects an unmarked receipt**: a receipt must self-declare whether it came from a
> probe run, and silence is not a declaration. Every receipt on disk from kit ≤ 1.49.0 / bridges
> ≤ 2.7.1 / ≤ 2.6.1 predates the marker, so `review-state --check` and `review-ledger --check` will
> RED on it where they previously passed.
>
> **How to upgrade:** `npx @sabaiway/agent-workflow-kit@latest init`, which also ATTEMPTS to refresh
> the placed bridges — then read its per-bridge outcome. **`skipped-readonly` or `could not refresh`
> means a compatible writer is not guaranteed:** the new reader may still be paired with an old bridge
> writer, whose reviews write unmarked receipts this gate now rejects. Re-run the refresh from a
> writable environment (using the recovery command if one was printed), then **re-run the review** on
> the tree you are working on. That is the whole migration; no project file changes, and the
> deployment-lineage stamp is untouched.
>
> **Why it is not opt-in.** The pre-marker wrappers already honoured `CODEX_PROBE` / `AGY_PROBE` and
> wrote no marker, so an unmarked receipt is **indistinguishable from a probe receipt** — a review
> that ran with the frontier-model/max-effort guard switched off. Any transitional window that keeps
> accepting unmarked receipts keeps the hole fully open for exactly the receipts it targets: it would
> not defer the break, it would cancel the fix.

A **breaking + feature** release (kit MAJOR carrying codex-cli-bridge **2.8.0** + antigravity-cli-bridge
**2.7.0** MINOR in-tarball — the bridges only ADD a field to the receipt they write, which is additive;
the incompatibility is created by the kit READER that now refuses the old form. engine 1.17.0 / memory
2.3.0 unchanged; the deployment-lineage head is a separate axis and stays `2.0.0`). Two independent
contracts, one theme: **what a bridge offers, and what a receipt claims, must both be readable off the
artifact itself — never inferred from source or from silence.**

- **`modeCatalog` — a machine-readable answer to "what modes does this bridge offer, and why?"** A new
  **top-level, additive-optional** manifest block (schema stays 1), typed-validated exactly like
  `settings`: absent → valid (a bridge predating it keeps validating), present-but-malformed → invalid.
  Both bridges now declare their real mode set — codex `{exec, exec.resume-last, exec.resume,
  review.plan, review.code, CODEX_PROBE}`, agy `{review.code/plan/diff, review.continue,
  review.conversation, run, AGY_PROBE}` — each entry carrying a closed taxonomy (`primary` /
  `continuation` / `env-hook`, where an env-hook names `parents[]` rather than faking a role), a
  required one-line `purpose` + `whenToUse`, and — declared only where they apply — `whenNotTo`, typed
  `operands[]`, structured `guardrails` `{value, enforcement, condition?, source}` and `customHooks[]`
  (`exec.resume` carries no `guardrails`; a mode with no operands omits `operands`). Invocation forms compose **by
  reference** (`invocationRefs[]`) into the existing AD-033 driving contract — the catalog is the
  user-facing DISCOVERY layer and never shadows it.
- **Descriptor honesty is enforced, not promised.** Declared operand slots must set-EQUAL the
  placeholders the referenced forms really carry, in **both** directions over the deduplicated union of
  an entry's forms: an undeclared placeholder is as dishonest as an invented slot, since either way the
  render shows a form as ready-to-run that the reader cannot actually fill. `enforced` is claimable only
  for an OS- or code-enforced fact; a runtime bound rides in `condition`; anything a prompt merely asks
  for renders `advisory`. Catalog `submode` values are drift-guarded against the wrappers' real parser
  arms, and every declared env-hook must be a real EXECUTABLE condition (heredocs and comments excluded,
  so a name-grep cannot stay green after the logic is deleted).
- **A probe review can no longer attest a tree — and the receipt says so itself.** Both wrappers wrote
  receipts unconditionally, so a `CODEX_PROBE=1` / `AGY_PROBE=1` review — which runs with the
  frontier-model/max-effort guard **off** — minted a `fresh:true`/`grounded:true` receipt the
  review-state gate accepted. Both wrappers now write `probe` on **every** successful review, `true` or
  `false`, through the shared byte-identical `write_review_receipt` block: a receipt self-declares and
  nothing has to infer it. The kit rejects a probe-marked receipt (a probe never attests) and **equally
  rejects an unmarked one — silence is not a declaration**.
- **One attesting predicate, three consumers.** `classifyReviewReceiptForTree` /
  `summarizeReviewReceiptsForTree` / `describeMissingReviewAttestation` live in the neutral
  `review-ledger-core.mjs` and are read by `review-state.mjs`, `receiptCrossCheck` and the round writer
  — two gates disagreeing about what attests is precisely the class AD-050 closed, and a second copy
  would re-open it. The shared summary also fixes a latent hole: the ledger took `own[own.length - 1]`,
  so a probe landing **after** a real review became the authoritative verdict — a probe SHIP could bury
  a real REWORK and let both gates report convergence. The summary now returns the latest **attesting**
  receipt, never the last line.
- **Scope of the claim.** What a marker carries is UNTRUSTWORTHINESS, never provenance — receipts are
  not authenticated, and a forger could write `probe:false` as easily as any other field. This is
  self-discipline made legible, not a security boundary. See the BREAKING callout above for the upgrade
  path; full record, including the mid-execution amendment of the original design and the stated
  residuals, in AD-057.

## 1.49.0 — Honesty/robustness bundle: refresh EROFS stated skip · settings integer-overflow parity (AD-056)

A small **honesty/robustness** release (kit MINOR carrying the two bridge PATCH bumps in-tarball —
codex-cli-bridge 2.7.1 + antigravity-cli-bridge 2.6.1; engine 1.17.0 / memory 2.3.0 unchanged; lineage
head stays `2.0.0`). Two kit/bridge fixes ship here (a third, repo-only dispatcher fix, rides the same
commit); all three share one theme: **a blocked environment must produce a STATED degrade, never a
false red — and a real failure stays loud.**

- **Refresh under a read-only skills dir is a stated skip, not a false failure.** Under the harness
  session sandbox `~/.claude/skills` is read-only, yet `--refresh-placed` re-syncs even at the current
  version (repair-on-rerun). That write EROFSed into the generic catch → *"could not refresh — … recover
  with setup"*, though both versions were already current AND `setup` hits the same read-only dir. It now
  reports a new **`skipped-readonly`** outcome (exit 0): it names the current version, states the re-sync
  was skipped/incomplete, and names the read-only cause — never claiming a re-sync ran or file integrity
  (a partial copy may precede the block). Only a read-only-class write failure at the copy-write boundary,
  at an equal version, degrades; a read-side / source-side / `linkWrappers` / real-I/O failure, or a
  version-**behind** refresh, stays a loud *could not refresh* (its recovery pointing at a writable
  rerun). The opt-in `setup` placement lane keeps its loud failure. Any drift persists until a writable
  rerun (converge-on-re-run).
- **Settings integer validation is now shell↔JS exact (Issue-012, Resolved).** The four bridge wrappers'
  shared `aw_settings_valid` integer arms did `(( 10#$v … ))`, which wraps modulo 2^64 on a 19+ digit
  string — the shell **accepted** `18446744073709551916` (2^64+300) while the kit's `settingValueValid`
  (safe-integer) **rejected** it. A shared overflow-safe `aw_int_in_range` helper (byte-identical across
  all four wrappers) strips leading zeros then rejects on a digit count exceeding the max's — never
  running arithmetic on a huge string. A leading-zero **in-range** value (e.g. `000…086400`) still
  passes on both sides; the value is pinned by a new behavioral shell↔JS parity test.

## 1.48.0 — Family-owned neutral ack store + read-prompt-economy hook lane (AD-055, the CLAUDE-CODE-HARNESS-FRICTION cluster)

A **feature** release (kit-only — engine 1.17.0, memory 2.3.0, bridges 2.7.0/2.6.0 unchanged) that
closes two sibling defects where the kit fought the Claude Code host surface. Both land under one ADR
(AD-055), two commit-anchored segments.

- **Part I — the neutral ack store relocates off the host settings schema.** The `sandbox-lane`
  upgrade recommendation converged by writing `agentWorkflow.sandboxLaneAck` into
  `.claude/settings.local.json` — an advertised apply path a Claude Code host blocks twice (the
  Edit-tool settings validator rejects the unknown key; the command sandbox EROFS-denies
  `.claude/settings*.json`). The neutral fingerprint acknowledgement now lives in a **family-owned
  `docs/ai/acks.json`** no host validator guards, written by a new consent-gated **ack writer**
  (`tools/ack-write.mjs`); the legacy settings-scope key is still read for one deprecation window
  (until the next MAJOR). The recommendation's apply line is an executable writer one-liner again.
- **Part II — the read-prompt-economy hook lane kills read-side Bash prompts at the source.** A
  Claude Code prefix allow rule can never match a `;`/`&&`/`|` COMPOUND even when every segment is
  seeded, so routine read compounds still prompt. The placed gate hook gains an **opt-in read-lane**
  (rung c): with `docs/ai/lanes.json` set to `{ "readLane": true }` (read live per call, fail-closed),
  a command whose every separator-split segment is a plain frozen read-only core command with **zero
  shell metaprogramming** is auto-approved — a conservative closed-world allow bounded by the audited
  core (a standalone opt-in grant). `lanes.json` is a **separate** kit-owned file — `gates.json`, its
  validators and the byte-mirrored template stay untouched. The residual guard (settings-allowed
  singles) additionally trips the bash-5.3 funsub openers, a backslash-newline line-continuation
  splice, and a de-spliced re-scan of quote/backslash/bracket/brace `--output` reconstruction.
- **`gate-hook --read-lane`** is the consent-gated writer for `lanes.json`: it verifies the placed
  hook is byte-current **and** wired **and** at the deployment stamp head before enabling (a pre-1.48
  hook never reads `lanes.json`), refusing a stale/unwired hook with the delete-to-reseed recovery
  (absolute paths). The upgrade Recommendations advisor surfaces the **read-lane offer** once the hook
  is placed+wired (RISK_NOTED, with a consent-moment posture note; ATTENTION variants when the placed
  hook is stale or missing — no silent dark lane).
- **Canon honesty.** `velocity.md` (read-side invocation shape), `hook.md` (rung c + `lanes.json` +
  the currency check + delete-to-reseed), the three cheap-agent templates (they grant no Bash — a
  missing `Grep`/`Glob` falls back to the Read tool; a harness-forced Bash read stays plain-single),
  and the README hook row.

Reviewed by the codex + agy council across three rounds (agy SHIP ×3; every fixable fold red-first);
the surviving word-construction-on-a-single major is a documented inherent-layer-residual — a
string-based residual guard cannot close every shell reconstruction of a write flag without a full
shell parser or an over-ASK that would defeat the read-prompt-economy goal (rung b is a trust-posture
convenience, not a sandbox). Dogfooded live on this host: the read-lane currency guard passed on the
re-placed 1.48 hook and wrote `lanes.json`.

## 1.47.0 — REPORT-FACTS train: live-fact report contract · batched ledger writer · version-sync wrapper lane · sandbox-lanes canon & bridge contract twins (AD-054)

A **feature** release (ships with engine 1.17.0, memory 2.3.0, bridges 2.7.0/2.6.0 bundled) that
bundles three top-of-queue items plus this session's own live prompt-defects into one train, all
fixed kit-level:

- **Report-facts contract (D1/D2).** A binding clause at the point of use: any claim a report makes
  about the CURRENT host or session state — prompts fired, sandbox scope, whether a bypass was
  needed, network reachability, approval counts — must trace to **live tool output** run **this
  session**; with no live signal the claim is **omitted or explicitly marked unverified**; a
  memory/handover snapshot is **context, never report facts**. The full clause lives in
  `references/shared/report-footer.md` (single home); upgrade steps 4/8 and the recommendations
  advisor carry one binding line each, pinned by the new `report-facts-contract.test.mjs`.
- **Batched ledger writer (D3).** `review-ledger-write.mjs` gains a `batch` verb — one invocation
  applies an ordered record/classify/override list through the SAME single-verb code paths (no forked
  validator). Two passes: the whole envelope is validated structurally first with ZERO writes, then
  ops apply sequentially and fail-fast on the first typed STOP with an honest partial-success report
  (prior ops stay recorded, append-only). One writer call for a records stage instead of ~13.
- **version-sync wrapper lane (D4).** `version-sync --bump` for a bridge now also rewrites the
  line-anchored `AW_BRIDGE_VERSION` in `bin/*.sh` (closed one-anchor rule — every assignment counted,
  so a shadowing malformed line is caught; a non-canonical anchor or a downgrade is refused with zero
  writes), and the no-flag verify checks it across all four constants (each wrapper + its kit mirror).
  The bridge version constant is now first-class — dogfooded on this very release.
- **Bridge contract twins + codex-exec detection (D7).** Both bridge manifests gain a typed `notes[]`
  (codex execute = the nested-sandbox limit; agy review = the pre-dispatch host-diff), rendered in the
  `procedures` advisor and each wrapper `--help`, bidirectionally drift-guarded. `codex-exec.sh` now
  detects the nested-sandbox failure class (a sandbox-mechanism token AND a permission/read-only
  failure token together) and emits a stated recovery hint — route codex-exec OUTSIDE the harness
  sandbox ON the observed failure, never a preemptive blanket. The velocity bridge-tier stays
  REVIEW-wrappers-only; delegated execution keeps its human prompt.
- **Canon twins (D5/D6).** The prompt-economy canon gains a writer-batch clause and two sandbox-lane
  sentences (pre-dispatch host-diff + nested-sandbox honesty), rendered across `orchestration.md` §5,
  the agent-rules lens (re-rendered into both templates), and the kit cost-lanes advisor.

## 1.46.0 — Recommendations UX rework: verdict-first, shape-capped, user-language; sandbox-lane discoverability (REC-UX-REWORK, AD-053)

A **feature** release (ships with engine 1.16.0, memory 2.2.0, bridges 2.6.0/2.5.0 bundled)
reworking the upgrade Recommendations section after its first consumer-side report drew a
readability verdict — the section now LEADS with an answer instead of a wall of caveats:

- **Verdict-first render (D1).** Items carry a frozen two-class severity (`attention` — a
  configured declaration broken/drifted/degrading/invalid; `optional` — an offer to enable an
  unconfigured capability). The optimal state stays the byte-identical empty-state line; every
  other state opens with ONE composed verdict line from frozen, doc-parity-bound templates
  (`{K} item(s) need attention` / `nothing is broken` ONLY when nothing needs attention AND no
  probe was skipped / `{N} optional recommendation(s), apply any you want` / `optimality NOT
  attested — {M} probe check(s) skipped`). Items render attention-first with severity tags.
- **Shape is contract (D2).** Every benefit string and static WHAT template lives in frozen
  exported registries (`BENEFITS` + the new `WHATS`, per-site variants included) pinned by a
  static gate: one line, 140-char cap, banned tokens (RISK/CAVEAT/IF-hedges/dates); dynamic parts
  cap by truncation-with-count; `add()` backstops composed items into the stated-skip lane; skip
  reasons normalize to one capped line. The first RED run enumerated 9 violators — all rewritten.
- **Risk moved to the consent moment (D3).** Posture/risk prose lives in the mode doc's per-item
  notes (closed, bidirectionally test-pinned via `RISK_NOTED_KEYS`); the apply lane is an explicit
  informed-consent checkpoint: select → posture note inline → explicit confirm → run EXACTLY the
  rendered one-liner.
- **`network-allowlist` → `sandbox-lane` (D4, merges REC-SANDBOX-LANE).** The unknowable-condition
  hedge is gone: the item surfaces the manifest-declared observed session-sandbox recipe
  (`networkHosts` ∪ resolved `writableDirs`) for wired review wrappers and converges on a NEUTRAL
  fingerprint acknowledgement (`agentWorkflow.sandboxLaneAck`, either settings scope; home-symbolic
  normalization keeps a committed ack machine-portable; a changed recipe re-fires). Security keys
  are never read as an ack and never recommended as a fix; the mode doc's sandbox-lanes section
  routes per host class by a narrowest-scope ladder.
- **User-language presentation (D5).** The paste-verbatim contract is retired: the agent PRESENTS
  the section in the user's conversational language — every fact and count, nothing added or
  dropped; commands/paths/hosts byte-exact; raw tool block on request (the AD-032 lane). A static
  language-contract test pins the new tokens present and the retired phrases absent on every live
  surface (both mode docs, README row, tool header, doc-parity comments).
- **Manifests: `writableDirs` (D6).** New optional validated field — `{env, default}` entries
  (validate `--strict`, fixtures ×4, kit mirrors re-synced); the advisor resolves at run time
  mirroring the wrapper byte-semantics (non-empty env wins; empty ≡ unset; only `~`, `~/…`,
  absolute forms ride as-given — anything else anchors to the project root).
- **Prompt-economy render (D7).** The cost-lanes advisory (`procedures.mjs`) gains the
  prompt-economy clause rendered from the engine canon (read-only fan-out on restricted-tool
  vehicles only; one plain pipeline per call; capability-gated launcher guidance; the
  quality/speed guard + honest limit), drift-guarded by one distinctive token per invariant on all
  three surfaces.

Bundled bridges: **codex-cli-bridge 2.6.0**, **antigravity-cli-bridge 2.5.0** — each manifest
gains its `writableDirs` declaration (codex `{CODEX_HOME, ~/.codex}`; agy
`{null, ~/.gemini/antigravity-cli}`); wrapper behavior unchanged.

## 1.45.1 — codex frontier pin moves to gpt-5.6-sol (bridge 2.5.0)

A **patch** release (the kit surface is unchanged; the bundled `codex-cli-bridge` moves 2.4.0 →
**2.5.0**). Both codex wrappers' quality-first pin advances to the new frontier:
`DEFAULT_CODEX_MODEL` `gpt-5.5` → **`gpt-5.6-sol`** ("Latest frontier agentic coding model",
catalog priority 1 — verified against the codex CLI's own server model catalog on 2026-07-12),
effort stays **`xhigh`** (supported: low…ultra), the service tier stays STANDARD by default (the
`priority`/Fast spend knob is unchanged: consented, never a default). The refuse-on-non-default
guard, `CODEX_PROBE=1` escape, and every other wrapper contract are untouched; SKILL/references
prose follows the pin in lockstep.

## 1.45.0 — Autonomy series close: upgrade Recommendations, bridge-wrappers tier, review-domain mask fix (AD-044 Plan 4)

A **feature** release closing the AD-044 autonomy series (ships with memory 2.1.0, engine 1.15.0,
bridges 2.4.0; the deployment lineage head stays `2.0.0` — the new seed is ensure-if-missing,
stamp-independent). Three maintainer pains land as product:

- **`recommendations` mode — the mandatory upgrade advisor.** Read-only `recommendations.mjs`
  renders a frozen 12-item registry as `{what is sub-optimal · one-line fact-true benefit · exact
  apply one-liner}`; every `upgrade` run now ENDS with the section on BOTH exits (equal-head and
  re-stamp), present-even-when-empty ("no recommendations — flow optimal."), BEFORE the report
  footer and commit ask. Apply lines are PURE executable commands, cwd-independent (absolute
  paths, pinned `--cwd`); probes degrade to stated skipped-item lines — an unreadable bundled
  manifest or an uncaveated unknown-freshness row is a stated skip, a stray bundle-root file is
  ignored, a duplicate-carrying bridge-settings file renders fix-duplicates-first instead of the
  writer command it would refuse. The network-allowlist item is HAND-APPLY by design: the kit
  never seeds `sandbox.network.allowedDomains`; hosts derive from the bridges' manifest
  `networkHosts`, the paste value is PROJECT scope ∪ missing (a local-scope allowance counts
  toward coverage but never widens into the committed file), and the item renders only on the
  full two-surface tier proof. Autonomy facts resolve from the PROJECT ROOT on every paste
  surface, and seed detection is STRUCTURAL via the shared `isSparseSeedConfig` predicate on all
  four surfaces (an explicit declared-defaults policy still gets its render nudge — the red-line
  ask rules ride the render).
- **`--bridge-tier` velocity lane — unattended council runs.** A frozen tier seeds, behind its own
  consent flag, BOTH surfaces a promptless review run needs: `permissions.allow` prefix rules for
  the review wrappers' CODE mode only (`Bash(codex-review code:*)`, `Bash(agy-review code:*)` —
  plan/diff modes and the exec wrappers keep their human prompt) + the wrapper names in
  `sandbox.excludedCommands` (the harness runs those outside the sandbox — no agent-side bypass).
  The grounding pre-step rule seeds in the EXACT double-quoted byte-form the procedures advisor
  renders (byte-parity pinned; derives only when agy-review is placed). Tier entries register at
  all three audit points — the audit never flags an entry the tier itself seeded. The
  exfiltration posture is INFORMED CONSENT, notice-pinned; the invocation-shape contract is
  stated (prefix rules match only PLAIN invocations). `grounding --out` hardened: temp-only
  outside-repo, create-only + exclusive fresh in-repo, non-regular-leaf refusals.
- **Review-domain device-mask fix + `sandbox-masks` lane.** Never-committable stat classes
  (char/block devices, FIFOs, sockets) are filtered out of the ENTIRE review domain in lockstep —
  node fingerprint/isTreeClean + both bash twins' payload, diff assembly and preflights + parity —
  so the sandbox-mask fingerprint-divergence class is dead BY CONSTRUCTION (untracked symlinks and
  directories/gitlinks stay in the domain). The GUARDED `sandbox-masks` tool adds the cosmetic
  lane: read-only probe (derives/revalidates, refuses every non-mask class) + consent-gated
  `--apply` full-block REPLACE of its own fence in `git-path info/exclude` (a stale-real-only
  fence renders the `--clear` form on every surface); `review-state --check` advises the exact
  one-liner when masks are visible. Honest residual: REGULAR fake-file injection is a new design
  round if it appears.
- **Autonomy surfacing + seeds.** `recipes --status-line/--json/--active-line`, `set-recipe` echo
  and `procedures` gained autonomy segments rendered from `resolveAutonomy` (MALFORMED-loud on
  every paste surface; `procedures` also exits 1 on a malformed policy while still rendering);
  the sparse defaults-equivalent `autonomy.json` template mirrors from memory; bootstrap seeds it,
  upgrade ensures-if-missing. Manifests gained consult-locked `networkHosts` (observed-minimal
  INCLUDING apex domains; validated by `--strict`; synthetic examples in schema.md); velocity.md
  carries the honesty matrix (settings sandbox keys are INERT under harness-managed sandboxes —
  live-observed). Tarball sentinel 145→150; router/read-set budgets took documented KB bumps.

## 1.44.0 — Autonomy provisioner: the consent-gated sandbox doctor (AD-044 Plan 2)

A **feature** release (kit-only; memory/engine/bridges unchanged, lineage head stays `2.0.0`). New
routable GUARDED mode **`autonomy-doctor`** — the cross-platform system provisioner that makes the
AD-044 sandbox actually initializable on consumer hosts: detect → consent-gated install → verify →
loud degrade, over the locked matrix (macOS Seatbelt built-in / Linux + WSL2 `bwrap` + `socat` /
native Windows → WSL2 redirect). This is the kit's FIRST tool that can run a privileged command,
so the consent and honesty contract is the release:

- **Three explicit lanes.** Flagless = FS-only preview (ZERO subprocesses): the diagnosis, the
  exact install command it WOULD run, and the exact `--apply <pm>:<pkg,…>` consent line — never a
  "ready" claim (Linux flagless is `present-unverified`, exit 3, by design). `--verify` = the only
  source of a Linux "ready (verified)": a pinned bwrap user-namespace smoke + `socat -V`.
  `--apply <pm>:<pkgs>` = consent bound to the previewed tuple — any mismatch vs the re-derived
  plan refuses (exit 2) and runs nothing; a successful install auto-verifies.
- **Privileged execution, closed world.** Every executed token — package manager, sudo, and the
  binary `env` execs — resolves to an ABSOLUTE path inside the fixed trusted-dir allowlist
  `/usr/bin:/bin:/usr/sbin:/sbin` (`/usr/local/bin` deliberately excluded); a PATH-shadowed
  binary triggers a loud advisory, never execution. Frozen 4-family map: apt via the
  env-trampoline (`sudo /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y …`, so
  non-interactivity survives sudo `env_reset`) · dnf `-y` · pacman `--needed --noconfirm` ·
  apk `add`; package names come from a frozen internal map — no repo/config/user input ever
  enters the command line. Unknown PM or untrusted location → stated degrade (exit 6), never a
  guess.
- **Sudo boundary, honestly.** `sudo -n true` preflight; passwordless success is LOUDLY stated;
  no TTY + a password required → the ENFORCED print-handoff (the doctor runs NOTHING and prints
  the exact command to run in your own terminal) — the designed primary path under an agent
  harness. Root callers (`euid 0` / `SUDO_UID`) are refused a "verified" claim — a green smoke
  under root can't prove unprivileged user namespaces (`root-unproven`, exit 5).
- **Frozen output contract.** Exported EXIT/status table (Linux exit 0 ONLY via the verify
  oracle) + a machine-parseable summary LAST line in every diagnosis outcome (`--help` prints the
  help text alone); `doc-parity` bindings pin the contract to the mode doc. The docs/ai
  deployment gate runs after arg parsing, ahead of every diagnosis/verify/apply lane; the
  `.workflow-version` stamp gate is a stated EXEMPTION (the doctor mutates the OS, never
  lineage-bound repo content).
- **Host-proven where it counts.** The bwrap smoke fixture and the apt env-trampoline descriptor
  are host-proven (the trampoline crossed a real sudo boundary with zero apt prompts); a fresh
  Claude Code session on the newly-ready host shows the series payoff — an ad-hoc command's
  prompt-delta drops 1 → 0 while the commit/push/publish red-lines still ask (content-scoped
  `ask` rules pierce `autoAllowBashIfSandboxed`; the render's exact rule form is load-bearing)
  and network egress still prompts. The sandbox is picked up at session START — the doctor's
  success output always states the restart step.
- **Registration + guards.** The GUARDED legend now reads "consent-gated destructive/privileged
  actions (dry-run-first)"; the velocity render's sandbox-unavailable degrade message points at
  the doctor; the doctor stays OUTSIDE every velocity auto-approve tier; tarball sentinel
  143 → 145 (`tools/autonomy-doctor.mjs` + `references/modes/autonomy-doctor.md`).

## 1.43.0 — Closed-world gate seeding: lifecycle hooks die by construction (AD-052)

A **feature** release (kit-only; memory/engine/bridges unchanged, lineage head stays `2.0.0`). The
consent-gated `gates.json` seeder (`seed-gates.mjs`) moves from BLOCKLIST screening to a
**closed-world** offer derivation — the structural fix for **Issue-011**, whose three residuals the
AD-042 council could only ever push one gap further, never close. Since a declared gate is
hook-auto-approvable, the offer is now conservative BY CONSTRUCTION: the worst case is a legit
command not offered (add it by hand), never a dangerous one offered.

- **Uniform hook-free exec form.** The seeded cmd is
  `COREPACK_ENABLE_NETWORK=0 <pm> exec -- <allowlisted-body>` for the detected package manager.
  `exec` runs a command, not a named script, so no `pre<name>`/`post<name>` lifecycle hook can fire
  — structurally and uniformly across **npm, pnpm, and yarn** (classic + berry). Never `<pm> run
  <name>`, which would re-expose hooks and let a later `package.json` edit change what a byte-exact
  approved gate runs.
- **Body allowlist, not blocklist.** The script body must be a string member of a 9-entry literal
  runner allowlist (`node --test`, `vitest run`, `jest`, `jest --ci`, `eslint .`,
  `prettier --check .`, `tsc --noEmit`, `tsc -p . --noEmit`, `vite build`) after a pinned
  ASCII-only normalization; anything else — an injected `curl … | sh`, a `release:npm` alias, an
  env/path body — is not offered, by non-membership. Editing the allowlist ADDS a test-guarded
  entry; it can never weaken a filter.
- **Per-PM fail-closed floor.** npm is pinned `--offline --script-shell /bin/sh` (no registry fetch
  of a missing runner; a hostile `.npmrc script-shell` loses); the `COREPACK_ENABLE_NETWORK=0`
  prefix blocks a Corepack-shimmed PM from fetching a hostile `packageManager` pin before exec;
  pnpm/yarn fail closed natively; a package manager whose exec contract cannot be verified is
  WITHHELD with a loud note. Screened-out gate-class scripts are counted and named — never silently
  absent (preview and apply alike).
- **Preflight parent-chain guard.** `assertDocsAiDeployment` (`atomic-write.mjs`) now walks the
  `docs` parent chain (refusing a symlinked `docs` parent or cwd root) before any read, closing the
  seeder's preview-path escape; all four write consumers inherit it. ENOENT-safe — a brand-new
  project still gets the normal no-deployment stop.
- **Scoped safety claim.** Safe-by-construction is the OFFER DERIVATION, not a runtime sandbox: a
  script gate runs the project's own tooling (project-controlled code), the disclosed residual
  bounded by the two-consent trust chain. The preview discloses it.

## 1.42.0 — Opt-in ADR-store migration mode + old-layout detection (AD-051)

A **feature** release, co-released with **memory 2.0.0 (MAJOR)** — the one-file-per-ADR store that
retires the 3-tier decisions cascade (engine 1.14.1 rides along as a housekeeping patch; bridges
unchanged). The deployment-lineage head bumps
`1.3.0` → `2.0.0` in lockstep (`EXPECTED_WORKFLOW_VERSION`; the cross-package drift guard pins it
to memory's `LINEAGE_HEAD`) — the first structural `docs/ai` migration in the lineage.

- **`/agent-workflow-kit migrate-adr-store`** — the consent-gated, opt-in crossing for an EXISTING
  deployment (`references/modes/migrate-adr-store.md` + `tools/migrate-adr-store.mjs`; dry-run →
  apply, the velocity/seed-gates writer pattern). It force-refreshes the WHOLE consumer
  `references/scripts` enforcement set atomically (`archive-decisions.mjs` + `check-docs-size.mjs`
  + their tests — so the consumer's own docs-cap gate can't red against the new scheme), writes
  the durable git-dir snapshot FIRST (docs + the pre-refresh scripts; a PROVEN out-of-tree
  fallback; a locally-EDITED enforcement script is snapshotted or the apply refuses — never
  silently clobbered), then runs the idempotent, conservation-checked `--migrate --apply` and
  regenerates navigator + index. Previews first; never commits.
- **Old-layout detection lives in the kit's project-aware surfaces** (the memory installer is a
  global, knows-nobody skill installer): `status` gains the `adrLayout` axis (old / migrated /
  none) via `family-registry`'s project survey; `upgrade` DETECTS a legacy
  `docs/ai/history/decisions-archive*.md` monolith and LOUDLY instructs the migration mode
  INSTEAD of seeding the new-scheme rotator into an un-migrated tree — an un-migrated consumer
  keeps their old rotator + old layout fully working until they opt in.
- **Kit fallback templates retargeted in lockstep** with memory's (`references/templates/` —
  `decisions.md` HOT-window seed + the seed `adr/log.md`): a kit-fallback fresh bootstrap seeds
  the new scheme, never the old; pinned by `template-parity` + the scripts-mirror guard.

## 1.41.0 — review-state degraded lane: align the presence gate with the review-ledger (AD-050)

A **feature** release (kit-only; deployment-lineage head stays `1.3.0` — no migration;
memory/engine/bridges untouched). Closes the AD-049 residual: the family shipped two read-only review
gates that **disagreed** on the same tree when a ready backend genuinely can't review a diff.
`review-ledger --check` (convergence) already excused a recorded-degraded backend; `review-state
--check` (presence) had no degraded model, so a legitimately degraded agy (stalled → no receipt) read
missing/stale → exit 1. On BUGFREE-3 S2 the loop converged codex-only with agy recorded degraded, yet
review-ledger PASSED and review-state FAILED — a consumer wiring review-state into a pre-commit hook
was blocked on an honest degrade.

- **A neutral read-core (`review-ledger-core.mjs`)** — the validated review-ledger read/schema core
  (path/base resolvers, `validateRecord` + its validators + schema constants, loop/segment filters)
  moves VERBATIM into a new node-built-ins-only module both read-only checkers import; `review-ledger.mjs`
  re-exports every symbol for back-compat. It breaks the `review-ledger ↔ review-state` import cycle so
  review-state can read the ledger without a back-import (the `changed-surface.mjs` precedent). Pure
  mechanical move — no behaviour change, pinned by the full pre-existing suite + import-split pins.
- **The `review-state` degraded exemption** — `review-state --check` now exempts a recipe-named backend
  without a current grounded receipt when the in-flight segment's LATEST review-ledger round records it
  `degraded:true` at the current tree fingerprint, with ≥1 non-degraded recipe-named backend present in
  that round and grounded, the loop unambiguous, and the ledger clean. It **mirrors review-ledger's
  `decideStop`** exactly (allPresent + presence) and stays **verdict-blind** — presence, not unanimity:
  the two gates now AGREE on an honestly-converged-with-degrade tree, and still intentionally differ on
  a non-converged one. `--await` inherits the exemption.
- **Fail-closed, exemption-scoped** — an unreadable/malformed ledger DENIES the exemption but never
  fails a tree whose receipts independently satisfy the gate (all-current stays exit 0, the ledger issue
  surfaced). More than one plan in flight suppresses the exemption without adding a fail-closed arm.

Contract surfaces moved in lockstep (the tool header, `--help`, the human render, the `--await`
comment, `references/modes/review-state.md`). Council-converged both segments (S1 codex + agy SHIP; S2
review round 1 revise → allPresent fold → review round 2 both SHIP), the two-gate agreement dogfooded live + pinned by a
detector-independent `two-gate-agreement.test.mjs` + a 17-case matrix; full suite 2969 green.

## 1.40.0 — Universal verification profile + session-loop economics (a)–(h) (BUGFREE-3, AD-049)

A **feature** release (deployment-lineage head stays `1.3.0` — no migration; co-released with
`@sabaiway/agent-workflow-memory` 1.12.0; engine/bridges untouched). BUGFREE-3 closes two residuals
AD-046/AD-048 left open: the fold-completeness signal was **JS/V8-only** (coverage read solely from
`NODE_V8_COVERAGE`, the single-test probe parsed node:test TAP from stdout — no consumer on another
runner could use the gate), and the BUGFREE-2 retro left **eight kit-level cycle-costs** unfolded.

- **Verification profile** — a new, optional, versionable `docs/ai/verification-profile.json`
  (`schema:1`; memory-canon template + kit mirror + a read-core kit tool) declares WHERE the suite
  leaves coverage (`coverage.kind ∈ {v8,lcov}` + `lcovPath`), the single-test template
  (`resultFormat ∈ {tap-stdout,tap-file,junit-xml}`), and an optional SARIF findings path. Env knobs
  override; an **absent profile reproduces today's V8 + node:test behaviour exactly**. Every declared
  path is realpath-guarded gitignored/out-of-tree. LCOV branches at `readCoverage` (the V8 path is
  byte-unchanged); the single-test strategy preserves `resolvable = matched>0` across every format;
  SARIF is advisory, never on the blocking path.
- **(a) one suite run per fingerprint** — fold RESULT schema v3→v4 carries suite-execution evidence,
  and `run-gates --record` **credits** the `unit-tests` gate from it instead of re-spawning (strictly
  fingerprint-bound + tree-unchanged + command-identity + exit-0; no "recent enough" cache).
  **(c) same-segment re-attest** — a recorded `reattest` receipt anchors custody at a new file hash
  for a green-only test append without fabricating a red-observe (the honest replacement for
  mis-using `red-proof`). **(f) `--preflight`** — the cheap set only, actions routed by kind, no
  suite/probe spawn.
- **(b) doc-parity** — a new read-only lint + mode: a closed, live-imported registry pins each
  mode-contract doc token to its code constant (caps, schema versions, the ledger vocabulary),
  fail-closed on drift. **(d) `review-state --await`** — block until every recipe-named backend has
  a fresh grounded receipt for the current tree (receipts-not-pgrep; deadline-first, bounded sleep).
  **(e) `grounding --ledger-summary`** — a loop/base-scoped review-ledger digest for `--facts`,
  fail-closed on an unreadable/malformed ledger. **(g) `record --from-receipts`** — draft
  `backends[]` from the current-fingerprint receipts; an explicit non-degraded row is a loud STOP.
- **(h) a rotation regenerates `docs/ai/index.md`** (the memory-canon `archive-decisions.mjs` reuses
  the root-parameterized `check-docs-size.mjs --write-index --report`) — so an ADR rotation never
  leaves the index stale mid-release-matrix; **dogfooded on this very release** (AD-049's rotation
  regenerated the index automatically, zero mid-matrix trip).

**Stated residual (Option A).** The (a) credit rides `NODE_V8_COVERAGE`, an observable env var — a
test reading it could flip; bounded (fails-under-coverage caught by exit-0), documented, and tested.
The clean closure (Node ≥22 + `--test-reporter=lcov`) is queued.

## 1.39.0 — Fold boundaries: commit-anchored segments, the diff-size cap, the green-baseline receipt, no-repro-no-fold, and gate telemetry (AD-048)

A **feature** release (deployment-lineage head stays `1.3.0` — no migration; engine/memory/bridges
untouched). AD-047's own execution loop field-proved the next gap twice: the ledger hard-capped a
MULTIPHASE plan at 3 rounds total (11 real council rounds across 4 commit boundaries went
unrecordable, their late fixable-bugs unbindable), and custody obligations spanning the whole plan
forced a waiver for every later-phase edit of an earlier-bound test file (4 of 5 recorded
overrides). One structural move fixes both and gives the three most-replicated fold-boundary
effects in the review literature real teeth: **the SEGMENT**.

- **The segment (review-ledger schema v4)** — every new record carries `base` = the commit the
  dirty tree sits on (`git rev-parse HEAD`; null on an unborn branch); a segment = (activity,
  loop, base). Round numbering, `REVIEW_CAP`/`HARD_MAX` (values unchanged — scope corrected),
  every writer tooth, and `--check` operate **per segment**; a segment closes ONLY through a
  gated commit, so a round-counter reset is **earned, never declared**. The field-proven
  11-round/4-base shape records completely while round 4 within one segment stays refused.
  `--status` groups rounds by segment; v1..v3 records stay readable and never enter one (the
  failure reason names the schema upgrade).
- **The diff-size cap (D4, writer tooth)** — `recordRound` refuses a round whose changed source
  surface exceeds `AW_REVIEW_DIFF_CAP` (default 400 new-side lines; fail-closed parser) without a
  recorded segment-scoped **`size-cap`** override carrying the EXACT sanctioned magnitude (it dies
  at the next commit — a grown surface needs a fresh recorded sanction). Counted classes are
  pinned: assessable + unsupported SOURCE lines count (excluding TS would gift a bypass); tests
  and out-of-domain never count; pure deletions are free. The computation lives in the NEW
  NEUTRAL `tools/changed-surface.mjs` — one home shared with the coverage domain (the runner and
  the writer can never drift; the writer never imports the runner).
- **The green-baseline receipt (D5)** — `run-gates --record` mints a v4 **`gate-run`** record via
  the ledger's NEW sole-writer API `recordGateRun` (the runner never opens the ledger itself):
  the FULL declaration + exactly what ran + the tree fingerprint BEFORE and AFTER the run; a red
  run records honestly; a failed record is its own loud **exit 7**. `recordRound` then refuses
  without a **quality-green** gate-run at the current fingerprint — gates-before-review is
  computed, not remembered: a subset that omits a declared non-process gate (any `--only` run
  short of the full quality set) or a tree-changed run never satisfies, while the kit's own
  `--check` loop gates (a CLOSED whole-command classification — compound lines and suffix-named
  tools never match) legitimately fail mid-loop and never block — omitting THOSE is fine. The velocity tier
  auto-approves only the exact no-`--record` form. Revert-first beyond this ships as protocol +
  telemetry visibility — stated plainly, never pretend-teeth.
- **No-repro-no-fold (D6)** — a blocking finding of the previous segment round may not VANISH
  unclassified: present means present-AS-BLOCKING (a severity downgrade does not survive), a
  pending `escalate` never clears, and the new v4 triage class **`refuted`** is the honest
  phantom lane (mandatory grounds in `note`; it also resolves in `decideStop` — additive rows
  beside the untouched truth table — so an honestly refuted phantom minted at the hard-max round
  can never wedge a segment). Minors stay exempt. Every fixable-bug fold therefore binds its
  red→green `testId` at the round it folded — late binding on multiphase plans restored.
- **Segment-scoped fold custody (D7, fold ledger v3)** — run and observed-red records carry
  `base`; bound testIds, receipts, custody chains, and tamper all filter to the current segment.
  A committed phase's custody obligations **close with its commit** — the cross-phase churn class
  that forced 4 of BUGFREE-1's 5 overrides is dead (regression-pinned); a receipt never crosses a
  commit boundary, so a cross-segment fold still takes the recorded `red-proof` lane (the stated
  residual).
- **Gate telemetry (D8)** — `review-ledger --telemetry`: read-only COUNTS across all loops and
  both ledgers (rounds/segments, finding origins, classification distribution incl. `refuted`,
  per-backend verdicts + divergence rounds, override usage by scope, gate-run quality-green and
  red-results-by-gate, fold runs, observed-red receipts, quarantined probes). Counts only —
  which gates earn their keep stays the maintainer's judgment. Never combined with `--check`.
- Bound-test probes now pass the pattern in the `=`-joined `--test-name-pattern=` form — a test
  name beginning with `-`/`--` no longer parses as a node option and silently selects no test
  (the pattern-half sibling of AD-047's dash-spawn fix; found live by this release's own `--red`
  loop).
- Surfaces in lockstep: both mode-refs + `gates.md` (the runner's claim is now "writes nothing
  BY DEFAULT"), README rows, catalog one-liners, the procedures advisor (run `run-gates --record`
  BEFORE recording a round; per-segment wording), velocity notes; the surface test pins every
  token.

Dogfooded live on its own three-segment execution loop (the AD-047 precedent): the cap fired on
the plan's own 792-line Phase-1 surface (exact re-sanctions recorded), the quality-green receipt
was consumed by the D5 tooth at the very first segment-2 round, and segment closure was exercised
end-to-end at each phase commit.

## 1.38.0 — Honest red→green: observed-red receipts, flaky quarantine, content custody, and the oracle-tamper guard (AD-047)

A **feature** release (deployment-lineage head stays `1.3.0` — no migration; engine/memory/bridges
untouched). AD-046 verified each bound test is resolvable and green — this release closes its one
named hole: **nothing proved the test ever FAILED before the fix**. A test written green beside the
fix ("fix theater") passed every shipped check. Now the gate demands the whole honest sequence:
red observed → fix folded → green observed — with the test's bytes in custody in between.

- **Observed-red receipts** — a new runner verb, `fold-completeness-run.mjs --red "<testId>"`,
  observes a test on the REAL pre-fold tree: failing on N/N runs → it mints a receipt (testId,
  rerun counts, the test file's sha-256, fingerprint) into the fold ledger (schema **v2**: records
  carry a kind, `run` | `red-probe`; v1 records stay readable, a v1 record as the loop's latest run
  fails with a re-run reason). Observed-green / unresolvable / mixed / timed-out are DISTINGUISHED
  refusals — nothing is written. A test that cannot even load pre-fold is authored with a dynamic
  `import()` (the refusal says so).
- **The N/N verdict algebra** — every probe side runs `AW_FOLD_RERUNS` times (default 3): RED and
  GREEN are strict N/N verdicts; anything mixed or timed out is **QUARANTINE** — never converted,
  no override lane (a flaky pin proves nothing — replace the test). Probes gain the kit's first
  spawn timeout (`AW_FOLD_PROBE_TIMEOUT_S`, default 120, per RUN, probes only); both knobs go
  through one fail-closed positive-integer parser.
- **Content custody** — the gate requires, per bound testId: the receipt, the receipt PRECEDING the
  loop's latest run (a post-hoc red proves nothing), N/N-green probes, and that the green test is
  **byte-identical** to the test seen failing (per-FILE hash custody; appending the next fold's red
  test re-attests its file without ceremony). Probes always spawn the safe resolver's canonical
  absolute path — a leading-dash or OS-resolved traversal path would execute a different file than
  the hashed one.
- **Oracle-tamper guard + recorded overrides** — the runner records a tamper surface over the
  tracked diff (test-classified paths + bound-testId file halves at HEAD, by hunk old-side
  polarity; pure additions and new test files never trip it; parsing is config/platform-proof).
  The gate fails closed on a tampered file without a recorded **`oracle-change`** override; a
  **`red-proof`** override waives receipt+custody for exactly one testId (the loud escape for a
  genuinely unestablishable red). Overrides are a new review-ledger record kind (schema **v3**;
  v1/v2 records stay valid; exact per-scope payloads), written only by
  `review-ledger-write override --json '…'` with the standard teeth plus a strict
  single-in-flight-loop rule. **Never silent: every waiver is a durable, auditable ledger entry.**
- **Honest limits (stated):** insertion-only weakening inside a pre-existing test body,
  expectation artifacts outside test files (snapshots/goldens), and weakening an already-green
  test behind a newer same-file receipt (characterization-pinned) remain in the stated
  self-discipline residual class; ledgers stay forgeable — this is a self-discipline mechanism,
  not a security boundary. No mutation testing ships (still shelved); the checker still fails
  closed on any mutation data.
- Dogfooded live on its own development loop: ten pre-fix receipts, six council-found bugs folded
  strictly red→fix→green, and the guard's own refusals caught one premature fix mid-plan.

## 1.37.1 — Fix: the fold-completeness probe on Node 18/20 counted pattern-filtered SKIP lines as executed tests

A **patch** release (one product fix + its pinned fixtures; no other change). On Node 18/20 —
versions the kit supports — `node --test --test-name-pattern` EMITS every non-matching test as
`ok N - <name> # SKIP test name does not match pattern` (newer Node omits them), so the 1.37.0
probe parser counted those lines as real matches: a `testId` whose pattern matches NOTHING was
reported **resolvable with a green baseline**, and the fold-completeness gate green-vouched a test
that never ran — defeating the gate's purpose on exactly those Node versions. Caught by the CI
matrix (node 18 + 20) on the 1.37.0 release commit; invisible on newer local Node.

- `parseProbeOutput` now ignores any TAP result line carrying a **SKIP/TODO directive** — a skipped
  test was not executed, on any Node version; a real test name containing a literal `# skip` would
  only fail CLOSED (unresolvable), never open.
- New pinned fixtures: the node-18/20 pattern-filter TAP shape (nomatch → unresolvable; a matched
  test among skipped ones still resolves), a lowercase `# skip`, and a `# TODO` directive.

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
