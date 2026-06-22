---
name: agent-workflow-kit
description: Deploy or upgrade a portable AI-agent memory-and-workflow system in any project. Use when the user wants to bootstrap `docs/ai/` + an entry-point `AGENTS.md` (+ `CLAUDE.md` alias) + cap/archive/index enforcement in a new or existing repo, set up the Memory Map and session protocols, install the docs-rotation pre-commit hook, or run `/agent-workflow-kit` / `/agent-workflow-kit upgrade`. Triggers on phrases like "set up the memory system", "deploy the AI workflow here", "bootstrap docs/ai", "upgrade the workflow".
disable-model-invocation: true
metadata:
  version: '1.5.2'
---

# agent-workflow-kit

Deploys a **portable AI-agent memory-and-workflow system** into a project, and upgrades it as the kernel evolves. After it runs, any future agent (including a fresh session of yourself) can reconstruct project context in ~60 seconds, find the current task, and avoid repeating past mistakes.

The kernel is **stack-agnostic workflow** — `docs/ai/` structure, entry-point doc, session protocols, plan lifecycle, frontmatter caps, 3-tier archive, index-freshness gate. Enforcement ships as **Node `.mjs` scripts** (the reference implementation; non-Node stacks follow the same policy manually).

The kernel **artifacts** (this skill, the templates, the deployed `docs/ai/` files) stay in their **source language** — for cross-agent and cross-team portability. That is separate from the **conversational language**: the language the agent *talks to the user* in (questions, explanations, summaries, status). That is chosen once at bootstrap (step 3), recorded in the project's `AGENTS.md`, and applied to dialogue only — it never translates file contents, code, identifiers, paths, commands, or abbreviations.

This kernel is distilled from a canonical, battle-tested reference implementation. The skill is the single source of truth — projects deploy from it and upgrade against it.

---

## Memory substrate: delegate or fall back (composition root)

This kit is the **composition root** of the `agent-workflow` family. The memory substrate
(`docs/ai/`, the entry-point doc, caps / archive / index, the setup contracts) is owned by
**`agent-workflow-memory`**. The kit **prefers to delegate** substrate deployment to that skill
when it is present and healthy, and otherwise uses its **own bundled copy** (`references/`,
`migrations/`) — so the existing one-command install keeps working with **no new dependency**.

**Detection (kit-owned, decided BEFORE any project write).** Run the kit's **own shipped**
validator — `node ${CLAUDE_SKILL_DIR}/tools/manifest/validate.mjs <memory-skill-dir>` — never a
validator shipped by the candidate (which could itself be broken). Delegate only when **all**
hold:
- result is **valid** and `kind` is `memory-substrate`;
- **every required asset is present** in the candidate, at its real path:
  `references/templates/`, `references/contracts.md`, `references/scripts/`,
  `scripts/stamp-takeover.mjs`, `migrations/`, `capability.json`. A partial install (manifest +
  `SKILL.md` only) is treated as **invalid**.

On **unsupported** (unknown schema), **invalid**, **unavailable**, **wrong-family**, or
**wrong-name**, **use the bundled copy** — never block. The fallback decision is final once
made: a partial/broken memory install discovered mid-flow must not disable the working fallback.

> The **executable form** of this whole decision lives in
> [`tools/delegation.mjs`](tools/delegation.mjs): `detectMemory(<memory-dir>)` runs the validator +
> the required-asset check and returns `delegate` / fallback with a reason; `handoffPlan(delegate)`
> returns who writes what, which stamps end up present, and that the commit gate is kit-only. Both
> are unit-tested, so the contract below is pinned by code, not agent interpretation.

**Hand-off contract (explicit; tested independent of agent interpretation).**
- **Delegated** (memory valid): the kit passes the **target project dir** + the **three setup
  answers** (visibility / language / attribution) to `agent-workflow-memory`, which writes
  `docs/ai/` + `AGENTS.md` + **`.memory-version`**. The kit then **injects the bounded
  methodology slot** (below) and writes the kit-fallback **`.workflow-version`**. → **both
  stamps** present.
- **Fallback** (memory absent/invalid): the kit runs the bootstrap procedure below from its own
  bundled assets and writes **`.workflow-version`** only. Softly suggest installing
  `agent-workflow-memory` — never a prerequisite.

**Methodology injection (the kit is the ONLY writer of memory's slot).** After `AGENTS.md`
exists, inject the bounded methodology fragment into its `workflow:methodology` slot:
`node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs <project>/AGENTS.md`. It injects a short
summary + pointer (Phase-1 source: the kit's bundled `tools/methodology-slot.md`) — **not** the
full `references/planning.md` — and keeps `AGENTS.md` under its ≤100-line cap. Marker contract:
exactly one ordered `start → end` pair → replace only the bytes between them; markers absent →
no-op; any malformed state (single, reversed, nested, duplicate) → no-op **with an error**,
never edit.

**One composition-level commit gate.** The delegated memory mode performs **no** commit and
raises **no** "ask to commit". There is exactly **one** gate, owned by the kit, **after**
injection: report results and **ask before committing** — never auto-commit. No kit asset is
ever deleted.

---

## Modes

Pick the mode from the user's invocation. Auto-detect an existing `docs/ai/` to guard against bootstrapping over a live system, but the user makes the final call.

- **`/agent-workflow-kit`** (default) — bootstrap a new or empty project. If `docs/ai/` already exists, stop and ask whether they meant `upgrade`.
- **`/agent-workflow-kit upgrade`** — upgrade an existing deployment to the skill's current `version`.
- **`/agent-workflow-kit backends`** — read-only environment check: which optional **execution-backends** (the `codex` / `agy` bridges) are set up vs missing. Never writes, never commits, never runs a subscription CLI.

### Mode: bootstrap

> Bundled sources below (templates, scripts) live in **this skill's own directory** — `${CLAUDE_SKILL_DIR}/` in Claude Code, or the folder containing this `SKILL.md` in Codex / other agents. Use that as the copy/read source; the working directory is the **target project**, not the skill.

> The three setup questions (steps 2–4) are decisions only the user can make and are hard to reverse after a commit. Ask each as a **structured multiple-choice prompt where your agent supports it** (`AskUserQuestion` in Claude Code — one option per choice, recommended one first), otherwise in prose — and **wait for the answer before writing anything**.

1. **Recon (read-only).** Before writing anything:
   - `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` → stack, package manager, scripts.
   - `ls -la` root → `README`, existing `AGENTS.md`/`CLAUDE.md`, CI configs, linter/formatter configs.
   - `git log --oneline -30` + `git status` → recent activity, branch, uncommitted changes.
   - `src/` (or equivalent) 2–3 levels deep → modules, routes/pages, components, services, types.
   - Tests (framework, location, E2E?) and linter rules.
   - Record: stack, package manager, daily commands (`dev`/`test`/`lint`/`type-check`), routes/pages, architecture layers.
2. **Choose visibility — ASK the user explicitly and wait for the answer, before writing anything.** This decides what gets tracked and is hard to reverse after a commit, so never assume the default silently: `visible` (committed — canonical, recommended) or `hidden` (in-tree, hidden via `~/.gitignore_global`). See [Visibility contract](references/contracts.md#visibility-contract).
3. **Choose conversational language — ASK the user explicitly and wait for the answer.** Which language should the agent *talk to them* in — questions, explanations, summaries, status updates? Offer the language they're already writing in as the default. Carry the answer into the `{{COMM_LANGUAGE}}` slot of the *Communication language* block when `AGENTS.md` is created (step 5). See [Communication contract](references/contracts.md#communication-contract). This sets the **dialogue** language only — never the files.
4. **Choose agent attribution — ASK the user explicitly and wait for the answer.** May the agent attribute work to itself / to AI — `Co-Authored-By` trailers, "Generated with …" footers, "AI"/agent/model mentions in code, comments, commit messages, PR titles/bodies, or docs? **Default to `off`** (no agent/AI mention anywhere) unless they opt in — people are routinely surprised to find an AI listed as a repo contributor. Carry the answer into the `{{AGENT_ATTRIBUTION}}` slot of the *Attribution* block when `AGENTS.md` is created (step 5). **If `off` and the project uses Claude Code**, also set `"includeCoAuthoredBy": false` in the project's `.claude/settings.json` (create it if absent) — the trailer is added by the harness, so a doc directive alone won't stop it. See [Attribution contract](references/contracts.md#attribution-contract).
5. **Entry-point doc.** If `AGENTS.md` / `CLAUDE.md` already exist (step-1 recon), do **not** overwrite — show the user and ask whether to merge or replace. Otherwise create `AGENTS.md` (the cross-agent standard — Codex / Cursor / Devin Desktop / Copilot read it natively) from `${CLAUDE_SKILL_DIR}/references/templates/AGENTS.md`, and symlink `CLAUDE.md -> AGENTS.md` (`ln -s AGENTS.md CLAUDE.md`) for Claude Code — single source, no duplication. For nested context, add a subdir `AGENTS.md` (+ a `CLAUDE.md` symlink beside it for Claude Code).
6. **Deploy `docs/ai/`.** Create the 11 files + `pages/` from `${CLAUDE_SKILL_DIR}/references/templates/`. Keep each file's frontmatter (`type / lastUpdated / scope / staleAfter / owner / maxLines`).
7. **Fill templates** per the table below.
8. **Install enforcement (Node projects).** Copy `${CLAUDE_SKILL_DIR}/references/scripts/*.mjs` (+ `*.test.mjs`) into the project's `scripts/`. They self-configure (project name from `package.json`, hierarchical/on-demand sections auto-discovered). **If the project has no Node runtime** (step-1 recon), skip this step and the hook in step 9 — follow the cap/archive/index policy manually, or port the scripts to the project's language.
9. **Wire / hide** per visibility (see contract). Install the pre-commit hook (Node projects): `node scripts/install-git-hooks.mjs`. If the installer reports a pre-existing non-marker hook, stop and ask the user to merge it manually rather than overwriting.
10. **Stamp the deployment lineage.** Write the **deployment-lineage head** into
    `docs/ai/.workflow-version` (one semver line). The lineage head is **`1.3.0`** — the shared
    `agent-workflow` deployment lineage, **NOT** this kit's package version (`1.4.0`). The two are
    independent axes: a packaging-only release bumps the package but leaves the lineage head until a
    migration actually changes the deployed `docs/ai` structure. A stamp greater than the head →
    STOP (never downgrade).
11. **Report & ask.** Show `tree docs/ai/`, 2–3 lines on what was filled with real data vs left as TODO, then run the **backend detector** (`node ${CLAUDE_SKILL_DIR}/tools/detect-backends.mjs`) and print a one-line summary of the optional execution-backends (e.g. `backends: codex ✓ ready · antigravity ✗ needs-credentials — run /agent-workflow-kit backends`). This is **read-only and never blocks the commit gate**. Then **ask before committing** — never auto-commit.

Fill strategy:

| File | Strategy |
|------|----------|
| `current_state.md`, `architecture.md`, `env_commands.md`, `technical_specification.md`, `pages/index.md` | Fill with **real** recon data (stack, scripts, layers, routes). |
| `tech_reference.md` | Carry over real configs/patterns found in deps. |
| `active_plan.md`, `handover.md` | TODO seed (e.g. "Bootstrap session — fill domain sections after first real work"). |
| `decisions.md` | Seed `AD-001` (adopting this memory system). |
| `known_issues.md`, `changelog.md`, `pages/shared-patterns.md` | Empty template / first bootstrap entry. |

### Mode: upgrade

1. Read `docs/ai/.workflow-version` (the project's stamped lineage). If missing, treat as a pre-versioned deployment and offer to re-bootstrap conservatively.
2. Compare to the **deployment-lineage head** (`1.3.0` — NOT this kit's package version). If equal → report "up to date" and stop. If the stamp is **greater than the head** or unparseable → **STOP and report** (never downgrade).
3. Show the relevant `${CLAUDE_SKILL_DIR}/CHANGELOG.md` diff (entries newer than the project's stamp).
4. Apply `${CLAUDE_SKILL_DIR}/migrations/<version>-<slug>.md` in **semver order**, only those newer than the project's stamp. Migrations are **idempotent** — safe to re-run.
5. Reconcile drift: add any kernel files/scripts the project is missing; never clobber project-authored content (their `decisions.md`, `known_issues.md`, page specs stay). Any user question a migration raises follows the same rule as bootstrap — **structured multiple-choice where supported** (`AskUserQuestion` in Claude Code), otherwise prose. If `AGENTS.md` has no *Communication language* block (pre-1.1.0 deployment), **ask the user their conversational language** and insert the block — see `migrations/1.1.0-communication-language.md`. If it has no *Attribution* block (pre-1.2.0 deployment), **ask whether the agent may attribute work to itself / AI** and insert the block (defaulting to `off`) — see `migrations/1.2.0-agent-attribution.md`.
6. Re-stamp `docs/ai/.workflow-version` to the **deployment-lineage head** (`1.3.0`, not the package version). Report changes; **ask before committing**.

### Mode: backends

Read-only. Answers *"which optional execution-backends are set up vs missing, and what's the next step?"* — for the family's subscription-CLI bridges (`codex-cli-bridge` → `codex`, `antigravity-cli-bridge` → `agy`). It **never writes, never commits, and never runs a subscription CLI**.

1. Run `node ${CLAUDE_SKILL_DIR}/tools/detect-backends.mjs` and present its table verbatim. Each row reports two **decoupled** axes: `manifestState` (health of the bridge *skill* — `not-installed | unsupported-schema | invalid-manifest | foreign | stub | ok`) and the readiness signals `cli` / `credentials` / `wrappers`, probed independently — so a CLI that is installed and signed in but whose bridge *skill* is absent reads `needs-skill`, not "missing".
2. For any backend that is not `ready`, point to its setup: the local `setup/README.md` when the bridge is installed, otherwise the backend's setup URL (both are in the report).
3. State plainly to the user that this is **detection only**:
   - **"credentials present"** means the credential-marker **file** exists — it is **not** a live login check. The detector never runs `codex login status` / `agy` (that would spawn a paid, slow, networked subscription CLI).
   - The bridges' wrappers are **POSIX `.sh`** scripts. On Windows the detector still works, but the bridges themselves are **not promised to run** — say so rather than implying they will.

---

## Gotchas

The non-obvious traps — scan these before bootstrapping or upgrading. Each is also enforced inline in the procedure above; this is the consolidated high-signal list.

- **Source vs target directory.** Templates and scripts are read from the skill's own dir (`${CLAUDE_SKILL_DIR}/` in Claude Code, the `SKILL.md` folder elsewhere). The **working directory is the target project** — never write kernel files back into the skill.
- **The `Co-Authored-By` trailer is added by the harness, not by prose.** When attribution is `off`, a doc directive alone won't stop it — for Claude Code you **must** also set `"includeCoAuthoredBy": false` in the project's `.claude/settings.json` (create it if absent). Other tools: disable their equivalent co-author/footer setting.
- **Hidden mode must never touch `package.json`.** Editing it is a *tracked* change and leaks the whole system. Hidden mode wires nothing into `package.json`; the pre-commit hook (untracked in `.git/hooks/`) calls `node scripts/<x>.mjs` directly. After hiding, **verify `git status` shows the artifacts as ignored**.
- **`CLAUDE.md` is a symlink, not a copy.** `ln -s AGENTS.md CLAUDE.md` — single source, no duplication. A copy drifts; a symlink can't.
- **Never overwrite an existing entry point or hook.** If `AGENTS.md` / `CLAUDE.md` already exist, or the installer reports a pre-existing non-marker git hook, **stop and ask** the user to merge vs replace — don't clobber.
- **No Node runtime → skip enforcement.** If the project has no Node (recon step 1), skip bootstrap steps 8–9 (scripts + hook) and follow the cap/archive/index policy manually, or port the scripts to the project's language.
- **Conversational language never translates artifacts.** It governs *dialogue only*. Code, identifiers, paths, commands, log output, abbreviations, and every deployed `docs/ai/` / `AGENTS.md` file stay in their source language. See [Communication contract](references/contracts.md#communication-contract).
- **Never auto-commit.** Report quality-gate results and wait for explicit approval — in both modes.

---

## Setup contracts

The three setup choices — **visibility** (step 2), **conversational language** (step 3), and **agent attribution** (step 4) — each have a full contract in [`references/contracts.md`](references/contracts.md). Load it when you need the complete rule (e.g. while filling the matching `AGENTS.md` block, or when an `upgrade` migration touches one). Defaults, in brief: visibility = `visible` (committed); language = whatever the user is already writing in; attribution = `off`. Ask each as a structured multiple-choice prompt where supported (`AskUserQuestion` in Claude Code), otherwise in prose.

---

## System principles (encode these into the project's `AGENTS.md`)

1. **Single entry point.** `AGENTS.md` is the only entry point (tool aliases like `CLAUDE.md` symlink to it); it never bloats — details live in `docs/ai/`.
2. **Memory Map.** A "read-when / update-when" table for every file. Without it agents get lost.
3. **Three protocols.** Start of Session → During Work → Task Completion, each a short checklist.
4. **Update docs BEFORE code.** Page behaviour changing? Update `pages/<page>.md` first, then the code.
5. **No silent failures.** Every internal validation/guard that rejects an action logs structured context (component, action, ids, inputs); user-facing failures also surface in the UI.
6. **TDD by default.** Test before code (unit for functions, E2E for user flows).
7. **ADR for strategic choices.** Long-term-consequence decisions get a `decisions.md` entry.
8. **Hard Constraints are tool-enforced.** Style rules live in linter/type-checker configs, not prose.
9. **Ask before commit.** The agent reports quality-gate results and waits for explicit approval; it never auto-commits.
10. **Honest `known_issues.md`.** Every bug with a workaround gets Impact + Plan so it isn't re-discovered later.
11. **One conversational language.** Talk to the user in the language chosen at bootstrap; keep code, paths, commands, and abbreviations in their source language. See *Communication contract*.
12. **Attribution is opt-in.** Honour the *Attribution* block: by default no agent/AI/model mention anywhere (commits, PRs, code, comments, docs), and no `Co-Authored-By` trailer. See *Attribution contract*.

---

## Hard Constraints (template — adapt to the stack)

Deploy these into `AGENTS.md`; remove rows that don't apply to the stack.

| Rule | Enforcement |
|------|-------------|
| No `export default` (named exports only) | Linter |
| No `any` / no unsafe casts | Linter / type-checker |
| Functional style (no mutation in app code) | Linter |
| No single-letter variables | Code review |
| Interactive elements semantic (button/link, not div+onClick) | Linter / a11y |
| No hardcoded colors — design tokens only | Code review |
| No business logic in components → hooks/services | Architecture review |
| No changes without tests (TDD) | Required |
| Check page docs before changes; update them after | Process |
| Ask user before committing | Process |
| Every page has an HTML-validity / a11y E2E test | Required |
| **No silent failures** — structured logging on every rejected action | Required |

---

## References

- [`references/contracts.md`](references/contracts.md) — the three setup contracts (visibility, conversational language, agent attribution) in full; the *Setup contracts* section above points here.
- [`references/planning.md`](references/planning.md) — plan vocabulary (Plan→Phase→Step→Substep), lifecycle, `queue.md` series-index, mandatory Cleanup, session-continuity heuristic.
- [`references/templates/`](references/templates/) — stack-agnostic `AGENTS.md`, `agent_rules.md`, and all `docs/ai/` files to deploy.
- [`references/scripts/`](references/scripts/) — the Node enforcement scripts (caps + staleness + index-freshness gate, 3-tier archive, hook installer) and their unit tests.
- [`migrations/`](migrations/) — per-version upgrade steps; see `migrations/README.md`.
- [`launchers/`](launchers/) — run the bootstrapper from non-Claude agents (`SKILL.md` is a native Codex skill; a Devin Desktop workflow launcher + install script). See `launchers/README.md`.
- [`tools/`](tools/) — the family-wide tooling the kit **owns and ships**: `manifest/{schema.md,validate.mjs}` (the `capability.json` schema + the validator the kit runs as the memory detector, and root CI invokes), `delegation.mjs` (the executable delegate/fallback decision + hand-off plan), `inject-methodology.mjs` + `methodology-slot.md` (the bounded slot injection), `detect-backends.mjs` (the read-only **backend detector** behind `/agent-workflow-kit backends`), and `release-scan.mjs` (the attribution-off release gate). See [`tools/manifest/schema.md`](tools/manifest/schema.md).
- [`capability.json`](capability.json) — the kit's own `agent-workflow` family manifest (`kind: composition-root`).
- [`CHANGELOG.md`](CHANGELOG.md) — version history of this kernel.
