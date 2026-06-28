---
name: agent-workflow-kit
description: Deploy or upgrade a portable AI-agent memory-and-workflow system in any project. Use when the user wants to bootstrap `docs/ai/` + an entry-point `AGENTS.md` (+ `CLAUDE.md` alias) + cap/archive/index enforcement in a new or existing repo, set up the Memory Map and session protocols, install the docs-rotation pre-commit hook, or run `/agent-workflow-kit` / `/agent-workflow-kit upgrade`. Triggers on phrases like "set up the memory system", "deploy the AI workflow here", "bootstrap docs/ai", "upgrade the workflow".
disable-model-invocation: true
metadata:
  version: '1.15.2'
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
`migrations/`) — so the existing one-command install keeps working with **no new dependency on the
memory substrate**. (The methodology slot is a separate axis: its fragment is read **live from the
installed `agent-workflow-engine`**, which `npx @sabaiway/agent-workflow-kit@latest init` installs — a
runtime dependency placed by `init` and read live; see *Methodology slot reconciliation* below.)

**Detection (kit-owned, decided BEFORE any project write).** Run the kit's **own shipped**
validator — `node ${CLAUDE_SKILL_DIR}/tools/manifest/validate.mjs <memory-skill-dir>` — never a
validator shipped by the candidate (which could itself be broken). Delegate only when **all**
hold:
- result is **valid** and `kind` is `memory-substrate`;
- **every required asset is present** in the candidate, at its real path:
  `references/templates/`, **`references/templates/orchestration.json`** (the orchestration-config
  template — a memory too old to ship it, pre-`1.2.0`, can't seed `docs/ai/orchestration.json`, so it
  falls back to the kit's own bundled substrate, which does), `references/contracts.md`,
  `references/scripts/`, `scripts/stamp-takeover.mjs`, `migrations/`, `capability.json`. A partial
  install (manifest + `SKILL.md` only) is treated as **invalid**.

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
  `docs/ai/` + `AGENTS.md` (carrying the **two empty pointer pairs** — `workflow:methodology` and
  `workflow:orchestration`) + **`.memory-version`**. The kit then **reconciles both bounded pointers**
  (below) and writes the kit-fallback **`.workflow-version`**. → **both stamps** present. In **hidden** mode the kit is the **single
  hide authority**: after the hand-off it runs `tools/hide-footprint.mjs` (step 9), which **absorbs
  memory's project-local footprint lines** into the one canonical `.git/info/exclude` block and adds
  the external footprint — so there is **no machine-global write** at any step (a stale memory's
  residual global block is cleaned via the upgrade reconcile, below).
- **Fallback** (memory absent/invalid): the kit runs the bootstrap procedure below from its own
  bundled assets — whose entry-point template now ships **two empty pointer pairs** (`workflow:methodology`
  + `workflow:orchestration`) the kit reconciles + fills — and writes **`.workflow-version`** only.
  Softly suggest installing `agent-workflow-memory` — never a prerequisite.

**Bounded pointer reconciliation (the kit is the ONLY writer of these slots).** After `AGENTS.md`
exists, run ONE command — `node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs reconcile
<project>/AGENTS.md` — which reconciles **two** bounded pointers in a single atomic write: the
**workflow-methodology** pointer (the plan → execute → review summary) **and**, right below it, the
**orchestration-recipes** pointer (the Solo / Reviewed / Council / Delegated vocabulary, routing to
`/agent-workflow-kit recipes`). Each is **one atomic operation per slot**: **ensure the slot exists**
(insert an empty marker pair at its anchor when a legacy entry point lacks one) → **inject the bounded
fragment ONLY IF the slot is empty** (a filled / user-customized slot is preserved verbatim) →
**cap-check** (the second pointer's check runs on the file *after* the first, so it guards the
**combined** ≤100-line budget). Both fragments are short summary + pointer, read **live from the
installed `agent-workflow-engine`** (`references/methodology-slot.md` + `references/orchestration-slot.md`,
the family's one source of truth) — **not** a bundled mirror, and **not** the full references. The
live read is **lazy + fail-loud**: the engine is consulted **only when a slot actually needs filling**,
so a deployment whose pointers are already filled reconciles to a zero-diff no-op even on a host
without the engine; but when a fill **is** needed and the engine is **absent/invalid**, reconcile
**STOPs** — report it in plain language with the one-line install command
`npx @sabaiway/agent-workflow-engine@latest init` (`npx @sabaiway/agent-workflow-kit@latest init`
installs the engine for you; translate, never leak tool internals). Contract per slot: exactly one
ordered `start → end` pair; a malformed slot (single, reversed, nested, duplicate) or a missing /
duplicate anchor → **STOP with an error**, never edit (the file is left byte-for-byte unchanged). The
**orchestration pointer is soft-skipped** (reported, never silent) when — and only when — adding it
would exceed the 100-line cap: the methodology pointer still lands and the upgrade continues.

**One composition-level commit gate.** The delegated memory mode performs **no** commit and
raises **no** "ask to commit". There is exactly **one** gate, owned by the kit, **after**
injection: report results and **ask before committing** — never auto-commit. No kit asset is
ever deleted.

---

## Modes

Pick the mode from the user's invocation. Auto-detect an existing `docs/ai/` to guard against bootstrapping over a live system, but the user makes the final call. The invocation→mode mapping is pinned by `tools/commands.mjs` `routeInvocation` (unit-tested): a **known** subcommand routes to its mode; the **bare/empty** invocation routes to `bootstrap`; **any unrecognized/ambiguous** token routes to `help`, which is **read-only** — so a garbage invocation never triggers a write (see the safe-routing rule under *Version status & the two axes*).

- **`/agent-workflow-kit`** (default) — bootstrap a new or empty project. If `docs/ai/` already exists, stop and ask whether they meant `upgrade`.
- **`/agent-workflow-kit upgrade`** — upgrade an existing deployment to the skill's current `version`.
- **`/agent-workflow-kit help`** — read-only **command index**: enumerate every command, grouped (Inspect / Configure / Orchestrate / Lifecycle) and tagged read-only / writer / guarded. The single discoverable entry point, and the landing spot for any unrecognized invocation. Never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit backends`** — read-only environment check: which optional **execution-backends** (the `codex` / `agy` bridges) are set up vs missing. Never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit setup [backend]`** — the **link-only**, opt-in companion to `backends`: place the bundled bridge skill + link its wrappers onto `PATH`. **In-agent only** — `init` (npx) never places bridges. The binary install + the interactive subscription login stay **manual** (it prints the exact commands); idempotent; refuses to clobber a non-symlink; never commits, never runs a subscription CLI.
- **`/agent-workflow-kit status`** — read-only view of the **whole family**: which members (kit / memory / engine / the two bridges) are installed, at what version, and — in a project — what is deployed (`docs/ai`, the version stamps, the hidden-mode fence). Never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit recipes`** — read-only **orchestration advisor**: present the four recipes (Solo / Reviewed / Council / Delegated) over the bridges' role vocabulary, plan + recommend one for the current environment, and offer the choice. **The orchestrator executes the chosen recipe via the bridge skills and always commits** — the kit only surfaces/selects/plans it; it never executes a recipe, never runs a subscription CLI, never commits.
- **`/agent-workflow-kit procedures <activity>`** — read-only **activity-procedures advisor**: print the ordered steps of a named activity (`plan-authoring` / `plan-execution`) read **live** from the installed engine (`references/procedures.md`), and the **resolved effective recipe per slot** from the per-project `docs/ai/orchestration.json` (hand-edited, strict JSON) + backend readiness (default = Reviewed when a backend is ready, Council on request, slot-aware incl. Delegated; graceful default vs loud override degradation). A per-run `--override <slot>=<recipe>` overrides one slot. Composes with `recipes` (which stays read-only); never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit uninstall`** — the **guarded teardown** companion to `init`/`setup`. Removes what they placed — installed skill dirs + the bridge wrappers — and, in a project, reverses the hidden-mode fence + the marker pre-commit hook. **Never deletes user-authored content**: it prints the exact `rm` for `docs/ai` / `AGENTS.md` and an **edit** for `.claude/settings.json` (the `includeCoAuthoredBy` key + any velocity `permissions.*`), for you to run by hand. `--dry-run` first, always; preflight-then-mutate; never commits.
- **`/agent-workflow-kit velocity`** — opt-in onboarding **velocity profile**: seed a fixed, audited **read-only** Claude Code allowlist into `.claude/settings.json` so routine read-only commands stop idling on approval prompts; opt-in `acceptEdits`; plus a **read-only advisory** of likely project gate commands to add by hand. **Writes only `.claude/settings.json`, never allowlists commit/push/publish, never writes `settings.local.json`, never commits.** `--dry-run` first.

### Version status & the two axes — surface this on every invocation

**Safe-routing rule (which mode did the user invoke?).** Map the invocation token with `tools/commands.mjs` `routeInvocation`: a **known** subcommand → its mode; the **bare/empty** invocation → `bootstrap` — the one writer reachable without a token, and only on an undeployed project (if `docs/ai/` already exists, **ask upgrade-vs-bootstrap**, never overwrite); **any unrecognized/ambiguous** token → `help`, which is **read-only**. The invariant: **no unrecognized/garbage invocation ever triggers a write** (only an explicit known token or the acknowledged bare-bootstrap exception can). The mapping is unit-tested, so it is not left to interpretation.

Before acting, read `docs/ai/.workflow-version` (the project's stamp), state a one-line status, then route:

- **absent** → bootstrap (a fresh deployment).
- **stamp < `1.3.0`** (the deployment-lineage head) → `upgrade`.
- **stamp == `1.3.0`** → already current; only the stamp-independent reconciles may run (the methodology slot, the hidden-mode footprint, **and** the `docs/ai/orchestration.json` config ensure, *Mode: upgrade* step 3).
- **stamp > head / unparseable** → STOP — never-downgrade gate (see *Mode: upgrade* step 2).

**Two independent version axes — never conflate them:**

1. **Project deployment** — `docs/ai/.workflow-version` vs the lineage head (`1.3.0`). This is the **only** axis this skill compares.
2. **Kit freshness** — this skill's own files vs the published npm package. That is the **npx installer's** job: `npx @sabaiway/agent-workflow-kit@latest init` (it refuses a stale-cache downgrade by comparing the version on disk — **no network**). This skill never checks npm, and the package version (e.g. `1.x`) is **not** the lineage head.

**Refreshed the kit but nothing changed?** The skill you are running is whatever was on disk when the session started. After `npx @sabaiway/agent-workflow-kit@latest init` updates `~/.claude/skills/agent-workflow-kit/`, **restart the session** so the agent reloads the new skill files (the slash command + this `SKILL.md`).

### The one-line backend-status line (shared by bootstrap + upgrade)

Bootstrap (step 11) and **every** successful `upgrade` exit (steps 4 + 8) print the **same**
read-only, one-line summary of the optional execution-backends. Run the **backend detector** —
`node ${CLAUDE_SKILL_DIR}/tools/detect-backends.mjs` — and compose one line from its per-backend
readiness, then **append an actionable recipe recommendation** from the recipe planner
(`node ${CLAUDE_SKILL_DIR}/tools/recipes.mjs --json` → `recommendation.clause`, P2-rich). Canonical format:
`backends: codex ✓ ready · antigravity ✗ needs-credentials — run /agent-workflow-kit backends · recipes: Reviewed available (via codex) — see /agent-workflow-kit recipes`

- The **`recipes:` clause is appended after** the `— run /agent-workflow-kit backends` pointer (never
  replacing it) and routes to the read-only `recipes` mode (`see /agent-workflow-kit recipes`). It is
  **never blank**: both backends ready → *"Council available, Reviewed the everyday default"*; one
  ready → *"Reviewed available (via …)"*; **none installed → *"Solo — run /agent-workflow-kit setup to
  add a backend"***; a backend present-but-not-ready → Solo with that backend's specific remedy.
  (Matches `recommendRecipe`.)
- **Invariants:** **read-only · never blocks the commit gate · never runs a subscription CLI · the
  pointer is the in-agent `backends` mode, never a network fetch · the appended `recipes:` clause
  routes to the in-agent `recipes` mode the same way · `init`/npx is unaffected (it never places
  bridges, AD-011 §5).**
- **Detector unavailable → skip with a stated reason, never silently.** The detector is a Node script
  the **agent host** runs (not the target project), so the only skip condition is "**the agent host
  can't run it**" — `node` is not on the agent's PATH, or the detector itself errors — **not** "the
  project has no Node runtime". On that condition, skip the line and say so **with the concrete
  reason**, e.g. *"Couldn't run the backend detector here (node is not on the agent host PATH), so
  I'm skipping the backend-status line."* — never a silent skip (Hard Constraint — no silent
  failures).

### The version block + welcome mat (shared by bootstrap + upgrade)

Bootstrap (step 11) and **every** successful `upgrade` exit (steps 4 + 8) close with the same
**report footer**, in this **canonical order**: success state → **version block** → the **one-line
backend-status line** → **welcome mat**. Only the version block comes from
`node ${CLAUDE_SKILL_DIR}/tools/family-registry.mjs --json` (add `--dir <project>` for the deploy
axis) — **never hardcoded semver**; the backend-status line is its own shared contract (above), and
the welcome mat **composes signals already gathered** (the version block's notes + the backend-status
line), not a fresh helper call. Present everything in the user's conversational language; never paste
the JSON or any internal field name.

**Version block — three plain lines, fed from `--json`:**
- **`Deployment structure: <deploymentHead> (current)`** — the deployed `docs/ai` structure version
  (the envelope's `deploymentHead`); **the only axis `upgrade` compares**.
- **`Installed on this machine — package versions:`** `kit <v> · memory <v> · engine <v> ·
  codex-bridge <v> · antigravity-bridge <v>` — one per `installed[]` entry, labelled by its `display`
  and showing its `version`, or, when there is no version, the plain phrase for its `state` (map
  below). Append any `installed[].notes` **in plain words** (e.g. the memory-behind refresh+restart
  line).
- **The two axes are different — say so even when the numbers coincide:** an installed *package*
  version (e.g. engine `1.3.0`) is a package number, **not** the deployment-structure version on line
  one (which is also `1.3.0` today). The head advances only when the deployed `docs/ai` structure
  changes, so a higher package number on npm/GitHub is **not** a newer deployment.

**`state` → plain language** (map the envelope's `installed[].state` token; never show the raw token):
`installed` → its version · `absent` → "not installed" · `other-tool` → "a different tool occupies
that skill slot" · `placeholder` → "a placeholder, not a working install" · `invalid` → "installed
but its manifest didn't validate" · `unsupported` → "installed but its manifest schema is too new for
this kit" · `uncheckable` → "couldn't be checked (a permission error)".

**Helper-failure contract (mirror the backend-status line).** The version block needs the
family-registry helper, which the **agent host** runs. If the host can't run it (`node` not on the
agent's PATH, or the helper errors), **skip the version block and say so with the concrete reason** —
e.g. *"Couldn't run the family-registry helper here (node is not on the agent host PATH), so I'm
skipping the installed-versions block."* — never a silent skip (Hard Constraint). It is non-essential:
the rest of the report — and the commit gate — proceeds.

**Welcome mat — the last line(s) of the footer.** After the version block and the backend-status
line, print *"Run `/agent-workflow-kit help` to see every command."* then **one** recommended next
step, chosen **caveat-aware** from signals already in hand (the version block's notes + the
backend-status line — no new helper call) in this priority order:
1. a member is **behind** (an `installed[].notes` caveat fired — memory/engine) → *refresh the behind
   member first* (its `npx …@latest init` + restart the session);
2. else **no backend is ready** (the backend-status line shows none ready) → *set one up with
   `/agent-workflow-kit setup`*;
3. else **a backend is ready but the orchestration config is still all-Solo** (no `reviewed` /
   `council` / `delegated` slot anywhere — inspect `docs/ai/orchestration.json`, or read the
   procedures advisor's resolved recipes) → *put it to work with `/agent-workflow-kit recipes`*;
4. else (a backend is ready **and** a backend-backed recipe is already selected) → the optional
   *`/agent-workflow-kit velocity`* opt-in (never run it without a yes).

Keep it compact — a few short lines, plain language, no kit-internal terms.

### Mode: help

Read-only. The single discoverable **command index** — it answers *"what can `/agent-workflow-kit` do, and which commands change things?"* It **never writes, never commits, and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/commands.mjs` (add `--json` for the machine-readable catalog) and present its grouped index — **Inspect / Configure / Orchestrate / Lifecycle**, each command tagged **read-only / writer / guarded** — in the user's conversational language. That catalog is the **single source of truth** for the command surface (the same one the bootstrap / upgrade report footers point at); `routeInvocation(token)` in the same file is the executable contract for which invocation maps to which mode.

`help` is also the landing spot for any **unrecognized or ambiguous** invocation — and that path is **always read-only** (the safe-routing rule under *Version status & the two axes*). When you arrive here that way, render the index and, in plain language, note that the invocation wasn't recognized so nothing was changed.

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
   - **First-contact orientation — say this before the first question (read-only).** In 1–2 plain lines, tell the user what this is — a portable memory & workflow system for this repo, so future sessions boot from a small structured memory instead of re-reading everything — and that they can run **`/agent-workflow-kit help`** any time to see every command. This is the "start here"; keep it to a sentence or two, then ask the visibility question.
2. **Choose visibility — ASK the user explicitly and wait for the answer, before writing anything.** This decides what gets tracked and is hard to reverse after a commit, so never assume the default silently: `visible` (committed — canonical, recommended) or `hidden` (in-tree, git-ignored via the **project-local** `.git/info/exclude` — one managed block covering the full AI/agent footprint, never the machine-global excludes). See [Visibility contract](references/contracts.md#visibility-contract).
3. **Choose conversational language — ASK the user explicitly and wait for the answer.** Which language should the agent *talk to them* in — questions, explanations, summaries, status updates? Offer the language they're already writing in as the default. Carry the answer into the `{{COMM_LANGUAGE}}` slot of the *Communication language* block when `AGENTS.md` is created (step 5). See [Communication contract](references/contracts.md#communication-contract). This sets the **dialogue** language only — never the files.
4. **Choose agent attribution — ASK the user explicitly and wait for the answer.** May the agent attribute work to itself / to AI — `Co-Authored-By` trailers, "Generated with …" footers, "AI"/agent/model mentions in code, comments, commit messages, PR titles/bodies, or docs? **Default to `off`** (no agent/AI mention anywhere) unless they opt in — people are routinely surprised to find an AI listed as a repo contributor. Carry the answer into the `{{AGENT_ATTRIBUTION}}` slot of the *Attribution* block when `AGENTS.md` is created (step 5). **If `off` and the project uses Claude Code**, also set `"includeCoAuthoredBy": false` in the project's `.claude/settings.json` (create it if absent) — the trailer is added by the harness, so a doc directive alone won't stop it. See [Attribution contract](references/contracts.md#attribution-contract).
5. **Entry-point doc.** If `AGENTS.md` / `CLAUDE.md` already exist (step-1 recon), do **not** overwrite — show the user and ask whether to merge or replace. Otherwise create `AGENTS.md` (the cross-agent standard — Codex / Cursor / Devin Desktop / Copilot read it natively) from `${CLAUDE_SKILL_DIR}/references/templates/AGENTS.md`, and symlink `CLAUDE.md -> AGENTS.md` (`ln -s AGENTS.md CLAUDE.md`) for Claude Code — single source, no duplication. For nested context, add a subdir `AGENTS.md` (+ a `CLAUDE.md` symlink beside it for Claude Code).
6. **Deploy `docs/ai/`.** Create every `docs/ai/` file + `pages/` from `${CLAUDE_SKILL_DIR}/references/templates/` (the template loop deploys each non-`AGENTS.md` template — the `.md` docs **and** the seeded, user-editable **`docs/ai/orchestration.json`** config, strict JSON, the per-project recipe defaults the `procedures` advisor reads). Keep each `.md` file's frontmatter (`type / lastUpdated / scope / staleAfter / owner / maxLines`); `orchestration.json` carries no frontmatter (the docs cap-validator globs `*.md` only, so it is inherently skipped).
7. **Fill templates** per the table below.
8. **Install enforcement (Node projects).** Copy `${CLAUDE_SKILL_DIR}/references/scripts/*.mjs` (+ `*.test.mjs`) into the project's `scripts/`. They self-configure (project name from `package.json`, hierarchical/on-demand sections auto-discovered). **If the project has no Node runtime** (step-1 recon), skip this step and the hook in step 9 — follow the cap/archive/index policy manually, or port the scripts to the project's language.
9. **Wire / hide** per visibility (see [Visibility contract](references/contracts.md#visibility-contract)). Install the pre-commit hook (Node projects): `node scripts/install-git-hooks.mjs`. If the installer reports a pre-existing non-marker hook, stop and ask the user to merge it manually rather than overwriting.
   - **visible** — wire the `package.json` scripts + add the minimal `.gitignore`. **Do not run the hide tool.**
   - **hidden** — run the kit's hide writer (one managed block in the **project-local** `.git/info/exclude`, covering the kit's own artifacts **and** every known AI/agent tool's footprint — never the machine-global excludes): `node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --dry-run` **first** (changes nothing, prints the plan), then the same without `--dry-run`. Handle what it surfaces, in plain language (never the tool's internal terms):
     - A path it reports as **already committed** can't be hidden by ignoring it and is **never un-tracked silently** — show the user the printed `git rm --cached <path>`, let them decide, then opt it in with `--include=<path>`.
     - A **present file with a generic name** it flags (e.g. `GEMINI.md`) → ask before `--include=<path>`.
     - If it reports a **leftover machine-wide ignore block** from an older deployment, **ask before removing it** — it could affect another of the user's repos that relies on the same machine-wide rules; on a yes, re-run with `--remove-global` (prints a restorable backup). Otherwise it is kept (harmless — the project-local rules win).
     - Report the result plainly (what is now hidden). **No Node on the agent host** → write the one managed block into `.git/info/exclude` by hand from the contract's path list, and report the manual step. **Windows is supported.**
   - **Do not edit `package.json`** in hidden mode — a tracked change leaks the whole system.
10. **Stamp the deployment lineage.** Write the **deployment-lineage head** into
    `docs/ai/.workflow-version` (one semver line). The lineage head is **`1.3.0`** — the shared
    `agent-workflow` deployment lineage, **NOT** this kit's npm package version (see
    `package.json` / `CHANGELOG.md`). The two are
    independent axes: a packaging-only release bumps the package but leaves the lineage head until a
    migration actually changes the deployed `docs/ai` structure. A stamp greater than the head →
    STOP (never downgrade).
11. **Report & ask.** Show `tree docs/ai/`, 2–3 lines on what was filled with real data vs left as TODO, then print the **report footer** in the canonical order (version block → one-line backend-status line → welcome mat — the shared contracts above, rendered from the helpers, same host-can't-run skip-with-reason). The welcome mat ends on **one** recommended next step — including the optional, opt-in `/agent-workflow-kit velocity` (a read-only allowlist so routine read-only commands stop prompting; *Mode: velocity*) when nothing more pressing applies, never run without a yes. Then **ask before committing** — never auto-commit.

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
2. **Never-downgrade gate — FIRST, before any write.** Compare the stamp to the **deployment-lineage head** (`1.3.0` — NOT this kit's package version). If the stamp is **greater than the head** or unparseable → **STOP and report**; do not touch a newer / unknown deployment at all (not even the methodology slot).
3. **Reconcile the bounded pointers — stamp-independent, BEFORE the equal-head short-circuit.** Reached only when the stamp **≤ head**. Run `node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs reconcile <project>/AGENTS.md`. ONE call reconciles **two** pointers — the **workflow-methodology** pointer and, right below it, the **orchestration-recipes** pointer (Solo / Reviewed / Council / Delegated, routing to `/agent-workflow-kit recipes`) — and is filled on **every** upgrade, idempotently (zero-diff when both are already present + filled), so even a legacy / current **`1.3.0`** deployment gains them **without a lineage-head bump or a migration** (the deployment-lineage head stays `1.3.0`; the `agent-workflow-memory` **package** template did get a docs-only headroom trim for the second pointer, but no deployed-`docs/ai` structure changed). Per slot it inserts an empty pair at its anchor if absent, preserves a customized pair verbatim, and STOPs (never edits) on a malformed pair, a missing / duplicate anchor, or **when a fill is needed but the installed `agent-workflow-engine` is absent/invalid** (both fragments are read live from it — see the distinct outcomes below).

   **Classify the exit — there are THREE non-zero exits + one soft in-band skip; handle each differently:**

   (a) **Soft, reported skip of the orchestration pointer (CONTINUE the upgrade).** The orchestration pointer is the less-critical second pointer; when it can't be added right now `reconcile` exits **zero**, keeps the methodology pointer, and **reports the skip on stdout** (the `… skipped …` line) — never silent (Hard Constraint). Two reasons: **(i)** the methodology pointer fits but adding the orchestration pointer would push the file past the `AGENTS.md` 100-line cap; or **(ii)** the installed `agent-workflow-engine` is **present but too old** to ship the recipes fragment (`<1.2.0`) — it can still supply the methodology pointer, so only the recipes pointer is withheld. Report it in the successful-exit report (**step 4** equal-head, else **step 8**) in plain language, e.g. *"The orchestration-recipes pointer wasn't added — the entry point is at its 100-line limit / your methodology engine is older than the recipes feature. The recipes are still available any time via `/agent-workflow-kit recipes`; to add the pointer, trim the entry point and/or refresh the engine with `npx @sabaiway/agent-workflow-engine@latest init`, then re-run upgrade."* (The separate case where the **methodology** pointer ITSELF can't fit the cap is a non-zero exit that changes nothing — continue without either pointer, same plain-language framing.)

   (b) **Malformed pair / missing-or-duplicate anchor (either pointer) — a hard STOP (do NOT continue).** A non-zero exit whose message names a marker/anchor problem; never soft-skip it.

   (c) **`methodology engine not found/invalid …` — a hard STOP (do NOT continue).** A fill was needed but the installed `agent-workflow-engine` is **fully absent/invalid** — it can supply **neither** fragment (distinct from (a)(ii), where the engine is valid but merely too old for the recipes one). Report it in plain language with the one-line install command `npx @sabaiway/agent-workflow-engine@latest init` (or note that `npx @sabaiway/agent-workflow-kit@latest init` installs the engine for you), then re-run upgrade once it is present. **Never** treat (c) as a soft-skip (a) — mis-handling it would silently drop the methodology pointer (a no-silent-failures violation). (b) and (c) STOP the upgrade; only (a) continues.

   **No-Node project:** the fragments live only in the **installed `agent-workflow-engine`** (`references/methodology-slot.md` + `references/orchestration-slot.md`, under `~/.claude/skills/agent-workflow-engine` or `$AGENT_WORKFLOW_ENGINE_DIR`) — there is no bundled copy, and a No-Node host cannot run the `npx` engine install. Open `AGENTS.md` and classify **each** pointer by hand: a **filled / customized** pair → leave it verbatim (no engine needed); a **malformed** pair (not exactly one ordered `start → end`) → STOP, do not edit. A pair that needs filling — **absent markers OR a present-but-empty pair** — needs the engine's fragment, so: if the engine is **not installed**, that pointer **cannot be added** — report it plainly (the methodology is already in `docs/ai/agent_rules.md`; the recipes are available via `/agent-workflow-kit recipes`; install the engine to add the pointers). If the engine **is** present, **count the lines first** — if adding/filling would take the file over 100 lines, **skip that pointer and report the skip** (methodology first, then orchestration; the orchestration pair sits right under the methodology end marker). Fill each empty pair from its engine fragment (`methodology-slot.md` / `orchestration-slot.md`) — never inline a copy (that would re-create the retired mirror).

   **Hidden-mode footprint reconcile — stamp-independent, same gate, BEFORE the equal-head short-circuit (D9 / AD-014).** A deployment does not record whether it chose `hidden`, so first **infer visibility**: `node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --reconcile --dry-run` (writes **zero bytes**). It reports one of — **visible** (the entry point is tracked) → nothing to do; **ambiguous** (untracked but not ignored — could be a fresh uncommitted repo, or a hide that broke) → **ASK** the user which it is, never guess; **hidden** → re-run without `--dry-run` to migrate any older **machine-global** hide to the **project-local** `.git/info/exclude` (one managed block; folds in the legacy `.claude/skills/` line), idempotently (a clean re-run is zero-diff). Handle its surfaced paths exactly as bootstrap step 9 (already-committed → show `git rm --cached`, ask before `--include`; generic-name present file → ask; **leftover machine-wide ignore block → ASK before `--remove-global`**, default keep + report). No Node on the agent host / Windows → as step 9. This runs on **every** hidden upgrade, like the methodology slot — no lineage-head bump, no migration file.

   **Orchestration config ensure — stamp-independent, same gate, BEFORE the equal-head short-circuit.** Ensure `docs/ai/orchestration.json` exists: **create it if missing**, **preserve it byte-for-byte if it already exists** (a user may have edited it — never clobber it). In the **delegated** path memory does this from its own template (memory upgrade step 2); in the **fallback** path the kit seeds it from `${CLAUDE_SKILL_DIR}/references/templates/orchestration.json`. Like the pointer slots + the footprint reconcile, this lets an equal-head (`1.3.0`) deployment gain the config seed **without a lineage-head bump or a migration file** (it is a `.json`, inherently outside the docs cap-validator). Report it in the step 4 / step 8 success report (config *seeded* vs *already present*).
4. **Equal-head exit — a real successful-exit report, not a bare stop.** If the stamp **equals** the head, the lineage is up to date — but step 3 (the methodology-slot **and** hidden-mode footprint reconciles) ran first and may have changed things, so this is a proper exit report, not a no-op:
   - **Report step 3's outcome in plain language** — for **each** pointer (workflow-methodology and orchestration-recipes) whether it was *added*, was *already present* (nothing changed), or was *skipped because the entry point is over its line limit* (the cap-refusal soft-skip from step 3, with its reason); whether the `docs/ai/orchestration.json` config was *seeded* or was *already present* (a user edit is preserved); and, for a hidden deployment, whether the hidden-mode footprint was *moved to project-local*, was *already project-local* (nothing changed), or needed a question (ambiguous visibility / a leftover machine-wide block). Plain wording only — never the reconcile/slot/anchor/marker terms (Gotcha: never leak kit internals).
   - **Name the version axis so the package number isn't mistaken for a newer release.** When you state the deployment is up to date, say it is current at the **deployment-lineage head** (`1.3.0`) and add one plain line: this head versions the deployed `docs/ai` structure and is a **separate axis** from the kit **package** version published on npm/GitHub (the larger number users see on the repo/npm page). A packaging-only release can bump that package version **without** moving the head — the head advances only when the deployed `docs/ai` structure changes — so an equal-head report is **not** a stale deployment even though GitHub shows a higher package number. (This is the only place the two axes meet the user in `upgrade`; surfacing it here prevents the recurring "but GitHub shows a higher version" confusion.)
   - **Print the report footer** in the canonical order (version block → one-line backend-status line → welcome mat — the shared contracts above; rendered from the helpers, same host-can't-run skip-with-reason). The welcome mat closes on **one** caveat-aware next step (a behind member first, else `setup` / `recipes` / `velocity`).
   - **Then ask before committing — never auto-commit.** If step 3 added the slot (or anything else changed), report it and ask. If step 3 was a pure zero-diff no-op and nothing else changed, say **"already up to date"** and still print the read-only version block + backend line.
5. Show the relevant `${CLAUDE_SKILL_DIR}/CHANGELOG.md` diff (entries newer than the project's stamp).
6. Apply `${CLAUDE_SKILL_DIR}/migrations/<version>-<slug>.md` in **semver order**, only those newer than the project's stamp. Migrations are **idempotent** — safe to re-run.
7. Reconcile drift: add any kernel files/scripts the project is missing; never clobber project-authored content (their `decisions.md`, `known_issues.md`, page specs stay). Any user question a migration raises follows the same rule as bootstrap — **structured multiple-choice where supported** (`AskUserQuestion` in Claude Code), otherwise prose. If `AGENTS.md` has no *Communication language* block (pre-1.1.0 deployment), **ask the user their conversational language** and insert the block — see `migrations/1.1.0-communication-language.md`. If it has no *Attribution* block (pre-1.2.0 deployment), **ask whether the agent may attribute work to itself / AI** and insert the block (defaulting to `off`) — see `migrations/1.2.0-agent-attribution.md`.
8. Re-stamp `docs/ai/.workflow-version` to the **deployment-lineage head** (`1.3.0`, not the package version). Report changes — and when you report the stamp, **name the axis**: the head versions the deployed `docs/ai` structure and is a separate axis from the kit **package** version on npm/GitHub (the larger number users see there), so the user doesn't read the bigger package number as a newer deployment (same framing as the step 4 equal-head exit). Then **print the report footer** in the canonical order (version block → one-line backend-status line → welcome mat — the shared contracts above; rendered from the helpers, same host-can't-run skip-with-reason; the welcome mat closes on one caveat-aware next step). Then **ask before committing**.

### Mode: backends

Read-only. Answers *"which optional execution-backends are set up vs missing, and what's the next step?"* — for the family's subscription-CLI bridges (`codex-cli-bridge` → `codex`, `antigravity-cli-bridge` → `agy`). It **never writes, never commits, and never runs a subscription CLI**.

1. Run `node ${CLAUDE_SKILL_DIR}/tools/detect-backends.mjs` and present its table verbatim. Each row reports two **decoupled** axes: `manifestState` (health of the bridge *skill* — `not-installed | unsupported-schema | invalid-manifest | foreign | stub | ok`) and the readiness signals `cli` / `credentials` / `wrappers`, probed independently — so a CLI that is installed and signed in but whose bridge *skill* is absent reads `needs-skill`, not "missing".
2. For any backend that is not `ready`, point to its setup: the local `setup/README.md` when the bridge is installed, otherwise the backend's setup URL (both are in the report).
3. State plainly to the user that this is **detection only**:
   - **"credentials present"** means the credential-marker **file** exists — it is **not** a live login check. The detector never runs `codex login status` / `agy` (that would spawn a paid, slow, networked subscription CLI).
   - The bridges' wrappers are **POSIX `.sh`** scripts. On Windows the detector still works, but the bridges themselves are **not promised to run** — say so rather than implying they will.

### Mode: setup

The **only writer** among the backend modes, and **opt-in / in-agent only** — it is **never** part of `init`. The npx installer deploys the *kit* and bundles the bridge skills in its tarball, but **does not place** them (that honesty claim is load-bearing — see `decisions.md` AD-009 / AD-011). `setup` owns exactly the two deterministic, secret-free steps and **guides** the rest. It **never commits and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/setup-backends.mjs [<backend>] [--bindir <path>] [--dry-run]`:

- `<backend>` — `codex` | `agy` | `antigravity` | `codex-cli-bridge` | `antigravity-cli-bridge`; omit for **all**.
- `--bindir <path>` — where to link the wrappers (default `~/.local/bin`).
- `--dry-run` — print the per-backend plan and change **nothing** (run this first).
- `--help`, `-h` — usage.

For each backend it:
1. **Places / refreshes the bundled bridge skill** (from the kit's `bridges/<name>/` mirror) into its canonical dir — but only when that dir is **absent / empty / proven-managed** (valid manifest, matching `name`+`kind`). A `stub` / `foreign` / `invalid` / `unsupported` dir, a marker fs-error, or a symlinked dir → **STOP**, never overwritten. Refresh re-runs on a proven-managed dir so re-running `setup` delivers bundled fixes.
2. **Links its wrappers** (`codex-exec` / `codex-review`; `agy-run`) onto `--bindir` via **managed symlinks** — replacing only a symlink that already points at our source. A non-symlink or a foreign symlink → **STOP**; it **preflights every target first**, so a conflict on one wrapper makes **zero** changes. If `--bindir` is not on `PATH`, it prints the one-line `export PATH=…` to add — it never edits a shell rc.
3. **Guides the manual, secret-bearing steps it will NOT automate** — the binary install (each bridge's `setup/README.md` §1) and the one-time interactive subscription login (`codex login` / `agy`) — printing the exact command for whichever axis is still missing (axis-aware: it can ask for both the CLI and the login at once).

**Windows:** the wrappers are POSIX `.sh`; on `win32` it reports *unsupported — use WSL* and mutates nothing.

**Exit codes:** `0` = done / already set up / only manual steps remain (guidance is never a failure); **non-zero** = a STOP (a dir/symlink it refuses to clobber), a bad argument, a missing bundle, or a native fs error (the underlying reason is preserved in the message).

### Mode: status

Read-only. Answers *"which family members are installed (and at what version), and what is deployed in this project?"* across the **whole family** — the unified registry behind it (`tools/family-registry.mjs`) aggregates every member's `capability.json`. It **never writes, never commits, and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/family-registry.mjs [--dir <project>]` and present its two-axis table:

1. **Skill axis (always):** per member — `installed` + the manifest health (`ok` / `not-installed` / `foreign` / `stub` / `invalid-manifest` / `unsupported-schema`, the same precedence the backend detector uses) + the installed version (read from the member's own `SKILL.md`, the authoritative source).
2. **Deploy axis (`--dir <project>`):** the deployment stamps (`docs/ai/.workflow-version`, `.memory-version`), whether `docs/ai/` exists, and whether the hidden-mode managed fence is present.

State plainly that the two version axes stay decoupled (an installed *skill* version is not a project's deployment-lineage stamp — see *Version status & the two axes*). The installed version reflects whatever is on disk under `~/.claude/skills/…`; a stale install shows its real (older) version, honestly.

### Mode: recipes

Read-only **orchestration advisor**. Answers *"how should I compose the optional execution-backends into plan → execute → review here, and which recipe fits?"* It **never writes, never commits, never runs a subscription CLI, and never executes a recipe** — the orchestrator (you) runs the chosen recipe through the bridge skills and makes the single commit; a backend is advisory or delegated, never autonomous.

The four recipes (defined over each bridge's `provides` roles — `codex`: execute + review; `agy`: review + probe), canonical narrative in the **installed engine** (`references/orchestration.md`):

- **Solo** — you plan, execute, and self-review; no backend (always available; the floor).
- **Reviewed** — you execute; **one** backend reviews the result (advisory). Prefers `codex` when both are ready (`agy` carries a standing health caveat).
- **Council** — **both** backends review independently; you synthesize the two opinions.
- **Delegated** — you hand a **bounded** execution sub-task to a backend (`codex exec`), then review the returned diff and commit.

1. Run **`node ${CLAUDE_SKILL_DIR}/tools/recipes.mjs`** (the read-only planner; `--json` for the structured form). It runs the backend detector, lists the four recipes, and prints — for the current environment — a **per-recipe dispatch plan that degrades with a stated reason** when a backend isn't `ready` (Council → Reviewed → Solo; Delegated → Solo), plus advisory **quota/health notes** (prefer the cheapest model; Council spends two backends' quota; `agy` may stall on substantive prompts — Issue-001, prefer `codex`).
2. **Offer the choice** via **`AskUserQuestion` where your agent supports it** (`AskUserQuestion` in Claude Code) — one option per recipe, the `recommendRecipe` choice listed **first** — otherwise in prose. Then print `planRecipe(chosen, detection)` (the per-stage dispatch + degradation reasons + quota/health notes) so the user sees exactly what running it entails.
3. **Availability = `readiness === ready`, full stop.** Every other readiness supplies the human reason (needs-skill → "not installed — `/agent-workflow-kit setup`"; needs-cli → "install the CLI"; needs-credentials → "log in"; degraded → "wrapper not on PATH — `/agent-workflow-kit setup`"). This is set-up state only — **never** a claim that a backend's service is responsive (the detector cannot observe a runtime stall; `agy`'s Issue-001 is a *standing advisory*, not a readiness signal).

**Invariants:** read-only · never runs a subscription CLI · never commits · the orchestrator executes the recipe via the bridge skills, not the kit.

### Mode: procedures

Read-only **activity-procedures advisor**. Answers *"what are the steps of this named activity, and which recipe applies at each slot here?"* It composes the orchestration recipes (Mode: recipes) into **named activities** with **typed recipe slots**. It **never writes, never commits, never runs a subscription CLI** — the deterministic resolution lives in the kit; the orchestrator runs the resolved recipe via the bridge skills and **owns any commit when the activity has a commit boundary** (a backend never commits). Not every activity commits: `plan-authoring` ends at approval and produces no commit (plans are ephemeral, never committed); `plan-execution` commits per Step.

The two v1 activities (canon in the **installed engine**, `references/procedures.md`):

- **`plan-authoring`** (slot: `review`) — research → draft → self-review → **review {recipe}** → fold/loop → present for approval; enforce the mandatory Cleanup.
- **`plan-execution`** (slots: `execute`, `review`) — per Step: resolve the recipe → if Delegated, dispatch execution first → implement → self-review → **review {recipe}** → gates → commit boundary.

Run **`node ${CLAUDE_SKILL_DIR}/tools/procedures.mjs <activity> [--override <slot>=<recipe>]… [--json]`**. It reads the activity's steps live from the engine and prints them **verbatim**, then the **resolved effective recipe per slot** from the per-project config + the read-only backend detector:

1. **Config = `docs/ai/orchestration.json`** — strict JSON, **hand-edited** (the kit reads + validates it; `recipes` stays read-only — there is no writer). Shape: `{ "<activity>": { "<slot>": "<recipe>" } }`; all slots optional (an absent slot → its computed default, stated); an optional `"_README"` string is allowed + ignored. `review` accepts `solo|reviewed|council`; `execute` accepts `solo|delegated`. Seeded by `init` (a user-editable template) — see *Mode: bootstrap*.
2. **Default resolution (config silent):** `review` → Reviewed if any review-capable backend is `ready`, else Solo (never Council by default); `execute` → Solo (Delegated is opt-in). **Degradation:** a config/computed default degrades **gracefully with a stated reason** (Council → Reviewed → Solo; Delegated → Solo); a per-run **`--override <slot>=<recipe>`** that can't be satisfied degrades **loudly** (a flagged warning, so you tell the user) — but is **still exit 0** (a valid request that gracefully degraded).
3. **Exit codes:** `0` success; `2` usage (unknown `<activity>` / bad `--override` — a bare `--override <recipe>`, an unknown slot, an invalid recipe-for-slot, or a duplicate slot); `1` config error (malformed / schema-invalid / unreadable `orchestration.json`) **or** engine error (the installed engine is absent / invalid / **too old** to ship `references/procedures.md` — upgrade it with `npx @sabaiway/agent-workflow-engine@latest init`). A `1`/`2` failure is loud (`path: reason`), never a silent fallback.

**Cap-soft-skip degradation (the feature's only AUTO route).** The activity procedures are auto-discoverable only through the one-line **`workflow:methodology`** pointer (this kit + the engine carry `disable-model-invocation:true`, so NL like "write a plan" does **not** auto-load this skill). On a deployment whose methodology pointer was cap-soft-skipped — or whose pre-existing customized pointer lacks the procedures clause — the procedures are still reachable by **explicitly** invoking `/agent-workflow-kit procedures`; surface that plainly rather than treating it as a gap.

**Invariants:** read-only · never writes · never commits · never runs a subscription CLI · the deterministic resolution is the kit's, the recipe execution is the orchestrator's.

### Mode: uninstall

The **guarded teardown** — the inverse of `init` (the kit + engine skills) + `setup` (the bridges) + a hidden deploy. **In-agent, opt-in**, and built around one hard rule: **it never deletes user-authored content.** Run **`--dry-run` first, always**, show the user the classified plan in plain language, get explicit consent, then re-run with `--yes`. It **never commits**.

Run `node ${CLAUDE_SKILL_DIR}/tools/uninstall.mjs [<member>] [--dir <project>] [--bindir <path>] [--dry-run | --yes]`:

- `<member>` — limit the skill axis to one member (`agent-workflow-kit` / `-memory` / `-engine` / a bridge); omit for the **whole family**.
- `--dir <project>` — also reverse the **project-deployment** surfaces in `<project>`.
- `--bindir <path>` — where the bridge wrappers were linked (default `~/.local/bin`, mirrors `setup`).
- `--dry-run` — print the plan and change **nothing** (run this first). `--yes` — apply the **auto-removable** set.

It classifies every surface into four classes and acts accordingly:

- **remove** (safe) — an installed skill dir that is **provably ours** (valid manifest, `name`+`kind` match). A dir present but **not provably ours** (`foreign`/`stub`/`invalid`/unreadable) → **STOP**: left untouched **and reported**, while the teardown still removes the members that ARE ours (a not-ours surface is never clobbered, and never blocks removing the rest — the per-item `setup` posture). **Preflight-then-mutate:** if a mutable surface **changed since the dry-run** (a skill no longer ours, a wrapper turned foreign, a hook that lost our marker, a malformed fence), the run **aborts with zero changes**.
- **reverse** (managed-marker) — a bridge **wrapper symlink that points at our source** (a foreign/non-symlink one → STOP); the hidden-mode **managed fence** (via the existing `--unhide` path — only the fenced lines); a **pre-commit hook carrying our marker** (an unmarked / user hook → left + reported).
- **KEEP — never deleted** (report-only) — `docs/ai`, `AGENTS.md`, `CLAUDE.md`, `docs/plans`, and `.claude/settings.json` (the `includeCoAuthoredBy` edit **and** any `permissions.defaultMode`/`permissions.allow` the velocity profile may have seeded). The tool **prints the exact `rm` / `git rm --cached`** for the docs/entry files and an **edit** instruction for `settings.json` (never an `rm` — it may hold your own settings); the **user** runs them. Surface this in plain language; never delete on their behalf.

**Shared globals:** removing `agent-workflow-memory` / `agent-workflow-engine` / a bridge removes a **global** skill that another project on the machine may use — say so before applying. **Windows:** the wrappers are POSIX; the skill-dir + project arms still work, the wrapper arm reports *use WSL*.

### Mode: velocity

The opt-in onboarding **velocity profile** — it seeds a fixed, audited **read-only** Claude Code allowlist into `.claude/settings.json` so an agent stops idling on approval prompts for routine read-only commands while the maintainer is away. It is the family's **first programmatic `.claude/settings.json` writer** (attribution stayed an agent-driven prose merge). **In-agent, opt-in, writes only `.claude/settings.json`**, on one hard rule: **it never allowlists `commit`/`push`/`publish`** — so a direct commit/push/publish still ASKs; the only caveat is the trust-posture residual (below), closed by the deferred hook.

**Version-status routing (like the other writer modes):** read `docs/ai/.workflow-version` first — not-deployed → bootstrap; stamp < `1.3.0` → `upgrade`; stamp > head / unparseable → STOP. The tool enforces this in code too (`--apply` STOPs unless the stamp is the lineage head).

Run `node ${CLAUDE_SKILL_DIR}/tools/velocity-profile.mjs [--dry-run | --apply] [--accept-edits] [--cwd <dir>]`:

1. **`--dry-run` first, always** (the default — changes nothing). It prints: the fixed read-only core it would add; a **read-only advisory** that lists your `package.json` `scripts` as **unaudited candidates you may add BY HAND** (inspect each first) to `.claude/settings.json` / `settings.local.json` — the tool **never** writes them and flags obviously-mutating names as "do not add"; any **pre-existing non-read-only `Bash(...)` entries** to consider removing by hand; and the honest residual notice (below). It STOPs (zero writes) on a symlinked `.claude` / non-regular `settings.json`, malformed settings JSON, or an unsafe `permissions.defaultMode` — `bypassPermissions` or anything outside `default`/`acceptEdits`/`plan`, present in **either** `settings.json` or `settings.local.json`.
2. **Ask the `acceptEdits` opt-in** via **`AskUserQuestion` where supported**, the safe option FIRST:
   - **"Keep per-edit approval prompts (recommended)"** — seed only the read-only allowlist; file edits still prompt.
   - **"Auto-accept file edits (`defaultMode: acceptEdits`)"** — present the honest FULL posture: it auto-applies Edit/Write AND auto-runs `mkdir`/`touch`/`mv`/`cp` in the working dir, is paired with the read-only allowlist, and — stated plainly — a settings-level allow rule is a **trust posture, not a sandbox**: a read-only entry can still write a file via output redirection, and (Claude Code's allow rules do not inspect command substitution) could in principle run another command via `cmd $(…)`. velocity **never adds `commit`/`push`/`publish` as allow rules** — so a direct `git push` still ASKs — but that same redirection/substitution residual means they are not *fully* closed until the deferred PreToolUse hook (family backlog). Note also that a `defaultMode` in `settings.local.json` would override this project-level write (local > project), since velocity writes only `.claude/settings.json`.
3. **Only on an explicit yes**, re-run with `--apply` (add `--accept-edits` only if they chose the second option). It merges-don't-clobber (preserves `includeCoAuthoredBy`, every key, and existing allow entries) and writes **only** `.claude/settings.json`.
4. **Surface delegation-readiness, read-only.** If they want a step run Delegated, point them at the hand-edited `docs/ai/orchestration.json` (*Mode: procedures*); the tool never writes it.

**Invariants:** creates `.claude/` if absent and writes **only** `.claude/settings.json` (no other file); **never** allowlists commit/push/publish; **never** writes `settings.local.json`; never commits; opt-in `acceptEdits`, never silent.

**Exit codes:** `0` done / dry-run; `1` a precondition STOP (stamp not current, unsafe mode, malformed settings, symlinked `.claude` / non-regular target); `2` bad arguments.

---

## Gotchas

The non-obvious traps — scan these before bootstrapping or upgrading. Each is also enforced inline in the procedure above; this is the consolidated high-signal list.

- **Source vs target directory.** Templates and scripts are read from the skill's own dir (`${CLAUDE_SKILL_DIR}/` in Claude Code, the `SKILL.md` folder elsewhere). The **working directory is the target project** — never write kernel files back into the skill.
- **The `Co-Authored-By` trailer is added by the harness, not by prose.** When attribution is `off`, a doc directive alone won't stop it — for Claude Code you **must** also set `"includeCoAuthoredBy": false` in the project's `.claude/settings.json` (create it if absent). Other tools: disable their equivalent co-author/footer setting.
- **Hidden mode must never touch `package.json`.** Editing it is a *tracked* change and leaks the whole system. Hidden mode wires nothing into `package.json`; the pre-commit hook (untracked in `.git/hooks/`) calls `node scripts/<x>.mjs` directly. After hiding, **verify `git status` shows the artifacts as ignored**.
- **Hidden mode is project-local, and the hide tool owns the known footprint.** `tools/hide-footprint.mjs` writes **one managed block** in the **project-local `.git/info/exclude`** — never the machine-global `core.excludesFile` (which would silently affect every repo on the host; **AD-014** amends **AD-006**). It hides the kit's own artifacts **and** the known external AI/agent footprint (the `KNOWN_FOOTPRINT` table in [contracts](references/contracts.md#visibility-contract)). A **tracked** file is **never silently un-tracked** — the tool prints the `git rm --cached` it will not run. Never leak its internal marker / asks terms to the user; translate every outcome to plain language.
- **`CLAUDE.md` is a symlink, not a copy.** `ln -s AGENTS.md CLAUDE.md` — single source, no duplication. A copy drifts; a symlink can't.
- **Never overwrite an existing entry point or hook.** If `AGENTS.md` / `CLAUDE.md` already exist, or the installer reports a pre-existing non-marker git hook, **stop and ask** the user to merge vs replace — don't clobber.
- **Unrecognized invocations are read-only.** Only a **known** subcommand reaches its mode; the **bare** invocation bootstraps (and an existing `docs/ai/` makes it ask upgrade-vs-bootstrap first, never overwrite); **any other / ambiguous** token routes to `help` (read-only). A garbage invocation never writes. The mapping is pinned by `tools/commands.mjs` `routeInvocation` (unit-tested) — don't hand-route around it.
- **No Node runtime → skip enforcement.** If the project has no Node (recon step 1), skip bootstrap steps 8–9 (scripts + hook) and follow the cap/archive/index policy manually, or port the scripts to the project's language.
- **Conversational language never translates artifacts.** It governs *dialogue only*. Code, identifiers, paths, commands, log output, abbreviations, and every deployed `docs/ai/` / `AGENTS.md` file stay in their source language. See [Communication contract](references/contracts.md#communication-contract).
- **Never auto-commit.** Report quality-gate results and wait for explicit approval — in both modes.
- **Never leak kit internals to the user.** No ADR ids, tool / function / operation names (`reconcile`, `inject`, `ensureSlot`), marker / slot / fragment / anchor terminology, or verbatim tool stderr in anything the user reads. Translate every tool outcome into plain language a third-party user — who has never read this `SKILL.md` — can understand and act on (e.g. the cap-refusal report in *Mode: upgrade* step 3).
- **Uninstall never deletes user-authored content, and dry-runs first.** `/agent-workflow-kit uninstall` removes only what is **provably ours** (a managed skill dir / wrapper symlink / fenced block / marker hook) and **prints — never runs** the `rm` / `git rm --cached` for `docs/ai` and the entry-point docs, and an **edit** instruction (not an `rm`) for `.claude/settings.json`. Always run `--dry-run` first, show the plan, get consent, then `--yes`. A skill dir or symlink that is not provably ours is a STOP, never a clobber (the `setup` posture, inverted). Removing a shared global (memory/engine/a bridge) may affect another project — say so.

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
13. **Orchestrate via a named recipe.** Compose execution through a named recipe (Solo / Reviewed / Council / Delegated) and **always commit yourself** — backends are advisory or delegated, never autonomous. Encoded via the reconciled `workflow:orchestration` pointer (it routes to `/agent-workflow-kit recipes` + the engine canon), not by bloating the entry point.

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
- **Plan vocabulary** (Plan→Phase→Step→Substep), lifecycle, `queue.md` series-index, mandatory Cleanup, session-continuity heuristic — the single home is the **installed `agent-workflow-engine`** canon (`~/.claude/skills/agent-workflow-engine/references/planning.md`, or `$AGENT_WORKFLOW_ENGINE_DIR`); there is no bundled mirror. `npx @sabaiway/agent-workflow-kit@latest init` installs the engine.
- [`references/templates/`](references/templates/) — stack-agnostic `AGENTS.md`, `agent_rules.md`, the seeded user-editable `orchestration.json` config (byte-identical to the memory copy — `test/template-parity.test.mjs`), and all `docs/ai/` files to deploy.
- [`references/scripts/`](references/scripts/) — the Node enforcement scripts (caps + staleness + index-freshness gate, 3-tier archive, hook installer) and their unit tests.
- [`migrations/`](migrations/) — per-version upgrade steps; see `migrations/README.md`.
- [`launchers/`](launchers/) — run the bootstrapper from non-Claude agents (`SKILL.md` is a native Codex skill; a Devin Desktop workflow launcher + install script). See `launchers/README.md`.
- [`tools/`](tools/) — the family-wide tooling the kit **owns and ships**: `manifest/{schema.md,validate.mjs}` (the `capability.json` schema + the validator the kit runs as the memory detector, and root CI invokes), `commands.mjs` (the canonical **command catalog** + the pure `routeInvocation` router behind `/agent-workflow-kit help` and the safe unknown-invocation routing rule — one source of truth for the command surface, drift-guarded against the `### Mode:` headers), `delegation.mjs` (the executable delegate/fallback decision + hand-off plan), `inject-methodology.mjs` + `engine-source.mjs` (the bounded **two-slot** reconciliation — ensure-slot / inject-if-empty / cap for the `workflow:methodology` **and** `workflow:orchestration` pointers; both fragments read **live** from the installed `agent-workflow-engine` via `engine-source.mjs` (`deps.rel` selects which) — the family's one source of truth, no bundled mirror; fail-loud when the engine is needed but absent, orchestration soft-skipped when it would bust the cap), `detect-backends.mjs` (the read-only **backend detector** behind `/agent-workflow-kit backends`, plus the axis-aware `guideFor`; exports the readiness consts the planner reuses), `recipes.mjs` (the read-only **recipe planner** behind `/agent-workflow-kit recipes` — `RECIPES` / `planRecipe` / `recommendRecipe` over the bridges' role vocabulary, drift-guarded against `provides`/`cost`/`quota` + an engine↔kit recipe-name parity guard; pure, never runs a subscription CLI; also exports the pure `ACTIVITIES` / `resolveActivityRecipe` activity-procedures resolver), `procedures.mjs` (the read-only **activity-procedures advisor** behind `/agent-workflow-kit procedures` — reads `references/procedures.md` live from the engine via `engine-source.mjs`, reads + validates the hand-edited `docs/ai/orchestration.json`, and prints the steps + the resolved effective recipe per slot; drift-guarded activity/slot table vs the canon; read-only, never runs a subscription CLI), `setup-backends.mjs` (the **link-only** backend setup behind `/agent-workflow-kit setup` — place the bundled bridge + link wrappers), `fs-safe.mjs` (the shared symlink-traversal-safe copy/link/**remove/unlink** primitives that `setup-backends`, the npx installer, and the uninstaller use), `known-footprint.mjs` + `hide-footprint.mjs` (the **hidden-mode** registry + the single hide-writer behind step 9 / the upgrade reconcile — one managed block in the **project-local** `.git/info/exclude` covering the full AI/agent footprint; pinned by `known-footprint.test.mjs` drift-guard + `hide-footprint.test.mjs` / `.integration.test.mjs`), `family-registry.mjs` (the **unified family registry** behind `/agent-workflow-kit status` — aggregates every member's `capability.json`; pinned by a `family-registry.test.mjs` drift-guard), `uninstall.mjs` (the **guarded teardown** behind `/agent-workflow-kit uninstall` — classify each surface, preflight-then-mutate, never delete user-authored content), and `release-scan.mjs` (the attribution-off release gate). The bundled bridge skill mirrors live under [`bridges/`](bridges/) (byte-identical to the repo-root bridges, pinned by `test/bridges-mirror.test.mjs`). See [`tools/manifest/schema.md`](tools/manifest/schema.md).
- [`capability.json`](capability.json) — the kit's own `agent-workflow` family manifest (`kind: composition-root`).
- [`CHANGELOG.md`](CHANGELOG.md) — version history of this kernel.
