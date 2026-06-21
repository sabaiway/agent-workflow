# Changelog — agent-workflow-kit

Semantically versioned ([semver](https://semver.org)), newest first. The `version:` in `SKILL.md`
is the current release. `upgrade` mode reads a project's `docs/ai/.workflow-version` and applies
every `migrations/<version>-<slug>.md` newer than it, in semver order.

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
