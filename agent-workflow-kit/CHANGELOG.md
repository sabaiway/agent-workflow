# Changelog — agent-workflow-kit

Semantically versioned ([semver](https://semver.org)), newest first. The `version:` in `SKILL.md`
is the current release. `upgrade` mode reads a project's `docs/ai/.workflow-version` and applies
every `migrations/<version>-<slug>.md` newer than it, in semver order.

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
