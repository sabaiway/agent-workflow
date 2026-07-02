---
name: agent-workflow-kit
description: Deploy or upgrade a portable AI-agent memory-and-workflow system in any project. Use when the user wants to bootstrap `docs/ai/` + an entry-point `AGENTS.md` (+ `CLAUDE.md` alias) + cap/archive/index enforcement in a new or existing repo, set up the Memory Map and session protocols, install the docs-rotation pre-commit hook, or run `/agent-workflow-kit` / `/agent-workflow-kit upgrade`. Triggers on phrases like "set up the memory system", "deploy the AI workflow here", "bootstrap docs/ai", "upgrade the workflow".
disable-model-invocation: true
metadata:
  version: '1.28.0'
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
`init` also **refreshes the installed memory substrate** (best-effort — a miss is a loud DEGRADED
success: a warning with the exact recovery command + exit 0, never silent, never the engine's hard
STOP; `--no-memory` skips it), so a returning `init` leaves **no stale core member**. The
execution-backend bridges are still never **placed** by `init` (placed on demand by `setup`, opt-in);
**once placed**, `init` **refreshes** them from the kit's own bundled copies (refresh-only, local
files, never a downgrade; `--no-bridges` skips it) — so a returning `init` leaves no stale placed
bridge either.

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
- **`/agent-workflow-kit help`** — read-only **command index**: enumerate every command, grouped (Inspect / Configure / Orchestrate / Lifecycle) and tagged read-only / writer / guarded / runs-project-commands. The single discoverable entry point, and the landing spot for any unrecognized invocation. Never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit gates`** — run the **project's own declared gate commands** (`docs/ai/gates.json`) as one batch: per-gate PASS/FAIL table + one machine-readable summary line, exit 0 iff all green. The runner itself writes nothing and never commits; what it executes is the project's own declaration (trust posture — a batching convenience, not a sandbox). See *Mode: gates*.
- **`/agent-workflow-kit backends`** — read-only environment check: which optional **execution-backends** (the `codex` / `agy` bridges) are set up vs missing. Never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit setup [backend]`** — the **link-only**, opt-in companion to `backends`: place the bundled bridge skill + link its wrappers onto `PATH`. **In-agent only** — `init` (npx) never *places* bridges; once placed, `init`/`upgrade` refresh them (refresh-only). The binary install + the interactive subscription login stay **manual** (it prints the exact commands); idempotent; refuses to clobber a non-symlink; never commits, never runs a subscription CLI.
- **`/agent-workflow-kit status`** — read-only view of the **whole family**: which members (kit / memory / engine / the two bridges) are installed, at what version, and — in a project — what is deployed (`docs/ai`, the version stamps, the hidden-mode fence). Never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit recipes`** — read-only **orchestration advisor**: present the four recipes (Solo / Reviewed / Council / Delegated) over the bridges' role vocabulary, plan + recommend one for the current environment, and offer the choice. **The orchestrator executes the chosen recipe via the bridge skills and always commits** — the kit only surfaces/selects/plans it; it never executes a recipe, never runs a subscription CLI, never commits.
- **`/agent-workflow-kit procedures <activity>`** — read-only **activity-procedures advisor**: print the ordered steps of a named activity (`plan-authoring` / `plan-execution`) read **live** from the installed engine (`references/procedures.md`), and the **resolved effective recipe per slot** from the per-project `docs/ai/orchestration.json` (strict JSON; agent-writable via `set-recipe` or hand-edit) + backend readiness (default = Reviewed when a backend is ready, Council on request, slot-aware incl. Delegated; graceful default vs loud override degradation) — plus, for every dispatched backend, the **full driving contract at the point of use**: the exact copy-pasteable invocation descriptor(s), the grounding levers (agy `--facts`/`--decided`), the round-2 `--continue` delta, and the guarded passthrough tiers, rendered verbatim from the bridge manifests (drift-guarded; each wrapper's `--help` prints the same contract). A per-run `--override <slot>=<recipe>` overrides one slot. Composes with `recipes` (which stays read-only); never writes, never commits, never runs a subscription CLI.
- **`/agent-workflow-kit set-recipe`** — the **config writer** for `docs/ai/orchestration.json`: turn the user's plain language into explicit `--set <activity>.<slot>=<recipe>` / `--unset` ops; the kit validates, merges, **previews by default**, and writes only on `--write` (deployment-gated, atomic, symlink/TOCTOU-safe). Resolves the effective recipe vs live readiness (degradation honesty on both paths). **Writes only `docs/ai/orchestration.json`; never runs a backend, never commits.** Hand-editing the file stays fully supported.
- **`/agent-workflow-kit uninstall`** — the **guarded teardown** companion to `init`/`setup`. Removes what they placed — installed skill dirs + the bridge wrappers — and, in a project, reverses the hidden-mode fence + the marker pre-commit hook. **Never deletes user-authored content**: it prints the exact `rm` for `docs/ai` / `AGENTS.md` and an **edit** for `.claude/settings.json` (the `includeCoAuthoredBy` key + any velocity `permissions.*`), for you to run by hand. `--dry-run` first, always; preflight-then-mutate; never commits.
- **`/agent-workflow-kit velocity`** — opt-in onboarding **velocity profile**: seed a fixed, audited **read-only** Claude Code allowlist into `.claude/settings.json` so routine read-only commands stop idling on approval prompts; opt-in `acceptEdits`; plus a **read-only advisory** of likely project gate commands to add by hand. **Writes only `.claude/settings.json`, never allowlists commit/push/publish, never writes `settings.local.json`, never commits.** `--dry-run` first.
- **`/agent-workflow-kit agents`** — opt-in **cheap-lane subagent placement**: place the bundled haiku/low-effort, read-only-tool subagent definitions (mechanical sweeps, changelog skeletons, gate triage) into the project's `.claude/agents/` so mechanical work stops defaulting to a frontier model. **Writes only under `.claude/agents/`, never overwrites a customized file, never touches `settings*.json`, never commits.** Claude-Code-specific; `--dry-run` first. See *Mode: agents*.

### Version status & the two axes — the internal routing check

**Safe-routing rule (which mode did the user invoke?).** Map the invocation token with `tools/commands.mjs` `routeInvocation`: a **known** subcommand → its mode; the **bare/empty** invocation → `bootstrap` — the one writer reachable without a token, and only on an undeployed project (if `docs/ai/` already exists, **ask upgrade-vs-bootstrap**, never overwrite); **any unrecognized/ambiguous** token → `help`, which is **read-only**. The invariant: **no unrecognized/garbage invocation ever triggers a write** (only an explicit known token or the acknowledged bare-bootstrap exception can). The mapping is unit-tested, so it is not left to interpretation.

Before acting, read `docs/ai/.workflow-version` (the project's stamp) to decide the route — this is an **internal** routing decision, **not** a line you print to the user (the number itself is shown only per *Version disclosure*). Route:

- **absent** → bootstrap (a fresh deployment).
- **stamp < `1.3.0`** (the deployment-lineage head) → `upgrade`.
- **stamp == `1.3.0`** → already current; only the stamp-independent reconciles may run — the FULL set lives in *Mode: upgrade* step 3 (pointer slots · hidden-mode footprint · both `.json` config ensures · the enforcement-script ensure · the placed-bridge refresh); run step 3 rather than enumerating from memory.
- **stamp > head / unparseable** → STOP — never-downgrade gate (see *Mode: upgrade* step 2).

**Two independent version axes — never conflate them:**

1. **Project deployment** — `docs/ai/.workflow-version` vs the lineage head (`1.3.0`). This is the **only** axis this skill compares.
2. **Kit freshness** — this skill's own files vs the published npm package. That is the **npx installer's** job: `npx @sabaiway/agent-workflow-kit@latest init` (it refuses a stale-cache downgrade by comparing the version on disk — **no network**). This skill never checks npm, and the package version (e.g. `1.x`) is **not** the lineage head.

**Refreshed the kit but nothing changed?** The skill you are running is whatever was on disk when the session started. After `npx @sabaiway/agent-workflow-kit@latest init` updates `~/.claude/skills/agent-workflow-kit/`, **restart the session** so the agent reloads the new skill files (the slash command + this `SKILL.md`).

### The one-line backend-status line (shared by bootstrap + upgrade)

Bootstrap (step 11) and **every** successful `upgrade` exit (steps 4 + 8) print the **same**
read-only, one-line summary of the optional execution-backends. The line is **machine-composed** —
run the status-line composer and **paste its single emitted line verbatim**:
`node ${CLAUDE_SKILL_DIR}/tools/recipes.mjs --status-line`
The tool runs the backend detector and appends the recipe recommendation itself
(`composeStatusLine`); the agent **composes nothing factual** — no readiness token, no glyph, no
recipe clause of its own, ever.

- **Placeholder template (structure only — never copy this example; paste the tool's line):**
  `backends: <alias> <✓|✗> <readiness> · <alias> <✓|✗> <readiness> — run /agent-workflow-kit backends · recipes: <recommendation clause> — see /agent-workflow-kit recipes`
- The **`recipes:` clause is appended after** the `— run /agent-workflow-kit backends` pointer (never
  replacing it) and routes to the read-only `recipes` mode (`see /agent-workflow-kit recipes`). It is
  **never blank**: both backends ready → *"Council available, Reviewed the everyday default"*; one
  ready → *"Reviewed available (via …)"*; **none installed → *"Solo — run /agent-workflow-kit setup to
  add a backend"***; a backend present-but-not-ready → Solo with that backend's specific remedy.
  (Composed by `recommendRecipe` inside the same tool run — never by the agent.)
- **Invariants:** **read-only · never blocks the commit gate · never runs a subscription CLI · the
  pointer is the in-agent `backends` mode, never a network fetch · the appended `recipes:` clause
  routes to the in-agent `recipes` mode the same way · `init`/npx never *places* bridges (it
  refreshes only what `setup` already placed, AD-011 §5).**
- **Composer unavailable → skip with a stated reason, never silently.** The composer is a Node script
  the **agent host** runs (not the target project), so the only skip condition is "**the agent host
  can't run it**" — `node` is not on the agent's PATH, or the tool itself errors — **not** "the
  project has no Node runtime". On that condition, skip the line and say so **with the concrete
  reason**, e.g. *"Couldn't run the backend status-line composer here (node is not on the agent host
  PATH), so I'm skipping the backend-status line."* — never a silent skip (Hard Constraint — no
  silent failures).

### The version block + welcome mat (shared by bootstrap + upgrade)

Bootstrap (step 11) and **every** successful `upgrade` exit (steps 4 + 8) close with the same
**report footer**, in this **canonical order**: success state → **version block** → the **one-line
backend-status line** → **welcome mat**. Only the version block comes from
`node ${CLAUDE_SKILL_DIR}/tools/family-registry.mjs --json` (add `--dir <project>` for the deploy
axis) — **never hardcoded semver**; the backend-status line is its own shared contract (above), and
the welcome mat **composes signals already gathered** (the version block's notes + the backend-status
line), not a fresh helper call. Present everything in the user's conversational language; never paste
the JSON or any internal field name.

**Success state — the happy path never leads with a structure number.** No happy-path report surfaces
the project's internal `docs/ai` structure version, the stamp filename, or the internal versioning
vocabulary — that number is inert here and only confuses; it belongs to *Version disclosure* (below).
Frame the success itself plainly, in the **user's conversational language** (never hardcode a phrase):
- a **zero-diff no-op `upgrade`** (step 4) → **settings already current — no update is required**
  (illustrative tone for a Russian-speaking user, an example of the meaning, not a literal string to
  embed: *«Настройки уже актуальны — обновление не требуется»*);
- a **fresh `bootstrap`** → its normal "deployed and ready" success, minus the number.

**Version block — the installed package versions, fed from `--json`** (the `docs/ai` structure version
is shown on demand only — see *Version disclosure* below, **not** here):
- **`Installed on this machine — package versions:`** `kit <v> · memory <v> · engine <v> ·
  codex-bridge <v> · antigravity-bridge <v>` — one per `installed[]` entry, labelled by its `display`
  and showing its `version`, or, when there is no version, the plain phrase for its `state` (map
  below). Append any `installed[].notes` **in plain words** (e.g. the memory-behind refresh+restart
  line).

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
1. a member is **behind** (a behind-class `installed[].notes` caveat fired — any member, the bridges
   included) → *refresh the behind member first*, quoting **that note's own recovery command
   verbatim** (a memory/engine note carries its `npx …@latest init` + restart the session; a bridge
   note carries `/agent-workflow-kit setup`). An **uncheckable** member ("couldn't be checked" — an
   unknown-freshness note) is **never** a refresh trigger: only a behind note fires this step — the
   uncheckable note already appears in the version block, add nothing more;
2. else **no backend is ready** (the backend-status line shows none ready) → *set one up with
   `/agent-workflow-kit setup`*;
3. else **a backend is ready but the orchestration config is still all-Solo** (no `reviewed` /
   `council` / `delegated` slot anywhere — inspect `docs/ai/orchestration.json`, or read the
   procedures advisor's resolved recipes) → *put it to work with `/agent-workflow-kit recipes`*;
4. else (a backend is ready **and** a backend-backed recipe is already selected) → the optional
   *`/agent-workflow-kit velocity`* opt-in (never run it without a yes).

Keep it compact — a few short lines, plain language, no kit-internal terms.

### Version disclosure — the `docs/ai` structure version, on demand only

The deployment carries an internal **`docs/ai` structure version** (the envelope's `deploymentHead`) —
the number `upgrade` compares the project's stamp against to decide whether a migration is due. The
happy path deliberately **hides** it: a user cannot act on it, and because it advances far more slowly
than the published package version, it reads as *"why is this smaller than what GitHub shows?"* Surface
it in exactly **three** places, and nowhere else:
1. the **never-downgrade STOP** (*Mode: upgrade* step 2) — the stamp is ahead of what this kit knows,
   so the number IS the message;
2. the **explicit version-status view** (*Mode: status*) the user deliberately opens;
3. when the **user explicitly asks** about versions.

When you show it, **name what it versions — "the `docs/ai` structure version"** (render that meaning in
the user's conversational language) — **never** "lineage head", "deployment head", or any raw internal
token. Pair it with **one plain-language line** telling the two axes apart, on demand only:

> the number your project carries versions its `docs/ai` **structure**; the (usually larger) number on
> npm/GitHub is the **tool's own package version** — the two advance independently, so a bigger package
> number is **not** a newer deployment.

**Never** print this two-axes line on a successful equal-head exit — only at the STOP, the status view,
or on an explicit ask.

### Mode: help

Read-only. The single discoverable **command index** — it answers *"what can `/agent-workflow-kit` do, and which commands change things?"* It **never writes, never commits, and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/commands.mjs` (add `--json` for the machine-readable catalog) and present its grouped index — **Inspect / Configure / Orchestrate / Lifecycle**, each command tagged **read-only / writer / guarded / runs-project-commands** (the last: the kit writes nothing, but the mode executes the project's OWN declared commands — the `gates` runner) — in the user's conversational language. That catalog is the **single source of truth** for the command surface (the same one the bootstrap / upgrade report footers point at); `routeInvocation(token)` in the same file is the executable contract for which invocation maps to which mode.

`help` is also the landing spot for any **unrecognized or ambiguous** invocation — and that path is **always read-only** (the safe-routing rule under *Version status & the two axes*). When you arrive here that way, render the index and, in plain language, note that the invocation wasn't recognized so nothing was changed.

### Mode: gates

The **generic project gate runner** — it batches the project's OWN declared verification commands into one run. The runner itself **writes nothing, never commits, and never runs a subscription CLI**; what it EXECUTES is the project's own declaration, with the caller's privileges (trust posture: a batching convenience over commands the project already runs by hand — **not a sandbox**).

Run `node ${CLAUDE_SKILL_DIR}/tools/run-gates.mjs [--cwd <project>] [--only <id>]…`:

1. **Reads `docs/ai/gates.json`** (strict JSON, hand-editable; seeded from `references/templates/gates.json`). Each gate is `{ id, title, cmd }` — `id` a unique kebab handle, `cmd` **ONE bash command line** (brace/glob expansion works; a host without bash gets a loud preflight error, exit 6 — never a silent reinterpretation under another shell). The declaration names **WHAT to check, never who executes it** — the schema has no lane/model/routing fields and rejects unknown keys loudly.
2. **Runs each gate from the project root** and prints a per-gate **PASS/FAIL table** plus **one machine-readable summary line** as the last line (`[run-gates] status=… gates=… passed=… failed=… failed_ids=…`). A failing gate's own output is preserved **verbatim** (triage without re-running); a green gate's output is not echoed; gates after a failure still run. **Exit 0 iff all selected gates are green.**
3. **Honest outcomes, each distinct — never a silent green:** a **missing** declaration (exit 3 — the report names the recovery: create `docs/ai/gates.json` from the template; `upgrade` re-seeds a missing one), an **empty** `gates` list (exit 4), a **malformed/invalid** declaration (exit 5, loud `path: reason`). Repeatable **`--only <id>`** re-runs a subset; an unknown id is a loud usage error (exit 2).

The declaration is **seeded at bootstrap** (the template loop, step 6) and **ensured-if-missing on upgrade** from THIS kit's own template twin (*Mode: upgrade* step 3) — independent of the installed memory substrate's age; an existing file is always **preserved byte-for-byte**. It is deliberately **not** a delegation-required memory asset: gates are optional, and absence is an honest runner outcome, not a deployment failure.

**Invariants:** the runner writes nothing · never commits · never runs a subscription CLI · executes only the project's OWN declared commands (never a kit-invented one) · the bash contract fails loud, never reinterprets.

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
6. **Deploy `docs/ai/`.** Create every `docs/ai/` file + `pages/` from `${CLAUDE_SKILL_DIR}/references/templates/` (the template loop deploys each non-`AGENTS.md` template — the `.md` docs **and** the two seeded, user-editable strict-JSON configs: **`docs/ai/orchestration.json`** (the per-project recipe defaults the `procedures` advisor reads) and **`docs/ai/gates.json`** (the project's gate declaration — an empty list to fill with its own verification commands, consumed by *Mode: gates*)). Keep each `.md` file's frontmatter (`type / lastUpdated / scope / staleAfter / owner / maxLines`); the `.json` seeds carry no frontmatter (the docs cap-validator globs `*.md` only, so they are inherently skipped).
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
2. **Never-downgrade gate — FIRST, before any write.** Compare the stamp to the **deployment-lineage head** (`1.3.0` — NOT this kit's package version). If the stamp is **greater than the head** or unparseable → **STOP and report**; do not touch a newer / unknown deployment at all (not even the methodology slot). This STOP is one of the few places the number is actionable (*Version disclosure*): show the user **the `docs/ai` structure version** their deployment carries versus the one this kit expects, plus the plain one-line two-axes note — naming it the structure version, **never** "lineage head".
3. **Reconcile the bounded pointers — stamp-independent, BEFORE the equal-head short-circuit.** Reached only when the stamp **≤ head**. Run `node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs reconcile <project>/AGENTS.md`. ONE call reconciles **two** pointers — the **workflow-methodology** pointer and, right below it, the **orchestration-recipes** pointer (Solo / Reviewed / Council / Delegated, routing to `/agent-workflow-kit recipes`) — and is filled on **every** upgrade, idempotently (zero-diff when both are already present + filled), so even a legacy / current **`1.3.0`** deployment gains them **without a lineage-head bump or a migration** (the deployment-lineage head stays `1.3.0`; the `agent-workflow-memory` **package** template did get a docs-only headroom trim for the second pointer, but no deployed-`docs/ai` structure changed). Per slot it inserts an empty pair at its anchor if absent, preserves a customized pair verbatim, and STOPs (never edits) on a malformed pair, a missing / duplicate anchor, or **when a fill is needed but the installed `agent-workflow-engine` is absent/invalid** (both fragments are read live from it — see the distinct outcomes below).

   **Classify the exit — there are THREE non-zero exits + one soft in-band skip; handle each differently:**

   (a) **Soft, reported skip of the orchestration pointer (CONTINUE the upgrade).** The orchestration pointer is the less-critical second pointer; when it can't be added right now `reconcile` exits **zero**, keeps the methodology pointer, and **reports the skip on stdout** (the `… skipped …` line) — never silent (Hard Constraint). Two reasons: **(i)** the methodology pointer fits but adding the orchestration pointer would push the file past the `AGENTS.md` 100-line cap; or **(ii)** the installed `agent-workflow-engine` is **present but too old** to ship the recipes fragment (`<1.2.0`) — it can still supply the methodology pointer, so only the recipes pointer is withheld. Report it in the successful-exit report (**step 4** equal-head, else **step 8**) in plain language, e.g. *"The orchestration-recipes pointer wasn't added — the entry point is at its 100-line limit / your methodology engine is older than the recipes feature. The recipes are still available any time via `/agent-workflow-kit recipes`; to add the pointer, trim the entry point and/or refresh the engine with `npx @sabaiway/agent-workflow-engine@latest init`, then re-run upgrade."* (The separate case where the **methodology** pointer ITSELF can't fit the cap is a non-zero exit that changes nothing — continue without either pointer, same plain-language framing.)

   (b) **Malformed pair / missing-or-duplicate anchor (either pointer) — a hard STOP (do NOT continue).** A non-zero exit whose message names a marker/anchor problem; never soft-skip it.

   (c) **`methodology engine not found/invalid …` — a hard STOP (do NOT continue).** A fill was needed but the installed `agent-workflow-engine` is **fully absent/invalid** — it can supply **neither** fragment (distinct from (a)(ii), where the engine is valid but merely too old for the recipes one). Report it in plain language with the one-line install command `npx @sabaiway/agent-workflow-engine@latest init` (or note that `npx @sabaiway/agent-workflow-kit@latest init` installs the engine for you), then re-run upgrade once it is present. **Never** treat (c) as a soft-skip (a) — mis-handling it would silently drop the methodology pointer (a no-silent-failures violation). (b) and (c) STOP the upgrade; only (a) continues.

   **No-Node project:** the fragments live only in the **installed `agent-workflow-engine`** (`references/methodology-slot.md` + `references/orchestration-slot.md`, under `~/.claude/skills/agent-workflow-engine` or `$AGENT_WORKFLOW_ENGINE_DIR`) — there is no bundled copy, and a No-Node host cannot run the `npx` engine install. Open `AGENTS.md` and classify **each** pointer by hand: a **filled / customized** pair → leave it verbatim (no engine needed); a **malformed** pair (not exactly one ordered `start → end`) → STOP, do not edit. A pair that needs filling — **absent markers OR a present-but-empty pair** — needs the engine's fragment, so: if the engine is **not installed**, that pointer **cannot be added** — report it plainly (the methodology is already in `docs/ai/agent_rules.md`; the recipes are available via `/agent-workflow-kit recipes`; install the engine to add the pointers). If the engine **is** present, **count the lines first** — if adding/filling would take the file over 100 lines, **skip that pointer and report the skip** (methodology first, then orchestration; the orchestration pair sits right under the methodology end marker). Fill each empty pair from its engine fragment (`methodology-slot.md` / `orchestration-slot.md`) — never inline a copy (that would re-create the retired mirror).

   **Hidden-mode footprint reconcile — stamp-independent, same gate, BEFORE the equal-head short-circuit (D9 / AD-014).** A deployment does not record whether it chose `hidden`, so first **infer visibility**: `node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --reconcile --dry-run` (writes **zero bytes**). It reports one of — **visible** (the entry point is tracked) → nothing to do; **ambiguous** (untracked but not ignored — could be a fresh uncommitted repo, or a hide that broke) → **ASK** the user which it is, never guess; **hidden** → re-run without `--dry-run` to migrate any older **machine-global** hide to the **project-local** `.git/info/exclude` (one managed block; folds in the legacy `.claude/skills/` line), idempotently (a clean re-run is zero-diff). Handle its surfaced paths exactly as bootstrap step 9 (already-committed → show `git rm --cached`, ask before `--include`; generic-name present file → ask; **leftover machine-wide ignore block → ASK before `--remove-global`**, default keep + report). No Node on the agent host / Windows → as step 9. This runs on **every** hidden upgrade, like the methodology slot — no lineage-head bump, no migration file.

   **Orchestration config ensure (seed-or-refresh) — stamp-independent, same gate, BEFORE the equal-head short-circuit.** Ensure `docs/ai/orchestration.json` exists **and its onboarding note is current**: **create it from the template if missing**; **if it already exists, preserve every activity/slot the user set, and refresh ONLY the `_README` note when the existing one still matches a known prior canonical** — the tested `refreshIfCanonical` / `refreshReadme` in `tools/orchestration-config.mjs` is the source of truth for that decision (normalize CRLF/whitespace before comparing; a *customized* `_README` is preserved verbatim; a *malformed* existing config is **preserved + a loud warning**, never clobbered or silently skipped). The current note points at `/agent-workflow-kit set-recipe` (the config is now agent-writable — no more "never written for you"). **The refresh helper is kit-owned** — in the **delegated** path memory only seeds/preserves the file (memory upgrade step 2) and the **kit** then applies the `_README` refresh; in the **fallback** path the kit seeds-or-refreshes directly from `${CLAUDE_SKILL_DIR}/references/templates/orchestration.json`. (Memory stays standalone — it never depends on this helper.) Like the pointer slots + the footprint reconcile, this reaches an equal-head (`1.3.0`) deployment **without a lineage-head bump or a migration file** (it is a `.json`, inherently outside the docs cap-validator). Report it in the step 4 / step 8 success report (config *seeded* / *note refreshed* / *already current* / *customized — preserved*).

   **Gate-declaration ensure (seed-if-missing) — stamp-independent, same gate, BEFORE the equal-head short-circuit.** Ensure `docs/ai/gates.json` exists: **create it from `${CLAUDE_SKILL_DIR}/references/templates/gates.json` if missing** — the kit's OWN template twin, so this works even when the installed memory substrate predates the gates feature (a stale memory never silently loses it); **an existing file is preserved byte-for-byte** (a project's declared gate matrix is authored content — never clobbered, never refreshed in place; unlike the orchestration `_README` there is no note-refresh here). Report it in the step 4 / step 8 success report (*seeded* / *already present*). Like the config ensure, this reaches an equal-head deployment without a lineage-head bump or a migration file (a `.json`, inherently outside the docs cap-validator).

   **Enforcement-script ensure (seed-if-missing) — stamp-independent, same gate, BEFORE the equal-head short-circuit.** A deployment older than the ADR-cascade feature has no `scripts/archive-decisions.mjs`, and an equal-head exit would otherwise never deliver it. Ensure the pair exists in the project's `scripts/`: **copy `archive-decisions.mjs` + `archive-decisions.test.mjs` from `${CLAUDE_SKILL_DIR}/references/scripts/` if missing** (the kit's own fallback copies — byte-identical to the memory canon by the mirror guard); **an existing file is preserved, never overwritten** (drift repair belongs to a lineage migration, not this ensure). The deployed pre-commit hook gains the `archive-decisions.mjs --check` line only when the hook itself is next refreshed (re-run `node scripts/install-git-hooks.mjs` after the ensure and it will refuse a non-marker hook as always); an OLD hook without the line stays consistent-safe — the decisions gate is simply not enforced yet, never a broken hook. Skip this ensure on a No-Node project (the scripts are Node enforcement). Report it in the step 4 / step 8 success report (*added* / *already present*).

   **Placed-bridge refresh — stamp-independent, same gate, BEFORE the equal-head short-circuit.** Run
   `node ${CLAUDE_SKILL_DIR}/tools/setup-backends.mjs --refresh-placed` and **paste its per-bridge
   output lines verbatim** — every outcome line is composed by the tool (*refreshed* / *already
   current* / *skipped — not placed* / *could not refresh* + its recovery); you compose nothing
   factual. It is **refresh-only**: it refreshes a bridge **`setup` already placed** from this kit's
   bundled copies and re-links its wrappers; an **absent** bridge is a stated skip, **never a first
   placement** (placement stays the opt-in *Mode: setup* — AD-009/AD-011 honesty intact), and a
   placed bridge **newer** than the bundled copy is a stated skip naming the kit update (**never a
   downgrade**). Like the other three reconciles it runs on **every** upgrade — including an
   equal-head one — with no lineage-head bump. A *could not refresh* line is non-fatal: relay it
   plainly with its recovery and continue the upgrade.
4. **Equal-head exit — a real successful-exit report, not a bare stop.** If the stamp **equals** the head, the lineage is up to date — but step 3 (the methodology-slot **and** hidden-mode footprint reconciles) ran first and may have changed things, so this is a proper exit report, not a no-op:
   - **Report step 3's outcome in plain language** — for **each** pointer (workflow-methodology and orchestration-recipes) whether it was *added*, was *already present* (nothing changed), or was *skipped because the entry point is over its line limit* (the cap-refusal soft-skip from step 3, with its reason); whether the `docs/ai/orchestration.json` config was *seeded* (created from the template), had its onboarding note *refreshed*, was *already current*, or carried a *customized note that was preserved* (a user edit is never clobbered); whether the `docs/ai/gates.json` gate declaration was *seeded* or was *already present* (preserved byte-for-byte); whether the enforcement-script ensure *added* the `archive-decisions` pair to `scripts/` or found it *already present*; the **placed-bridge refresh** outcome — paste the tool's per-bridge lines verbatim (they are already plain: *refreshed* / *already current* / *skipped — not placed* / *could not refresh* + recovery); and, for a hidden deployment, whether the hidden-mode footprint was *moved to project-local*, was *already project-local* (nothing changed), or needed a question (ambiguous visibility / a leftover machine-wide block). Plain wording only — never the reconcile/slot/anchor/marker terms (Gotcha: never leak kit internals).
   - **Never surface the structure number on this exit.** Whatever step 3 did, do **not** recite the `docs/ai` structure version, the internal versioning vocabulary, or the two-axes note here — the number is inert on an equal-head exit; it belongs to *Version disclosure* (shown at the never-downgrade STOP, the explicit status view, or on an explicit ask). Frame the success itself per the final bullet: if step 3 changed anything, say **what changed** in plain human terms; only a pure zero-diff no-op is *settings already current — no update needed*.
   - **Print the report footer** in the canonical order (version block → one-line backend-status line → welcome mat — the shared contracts above; rendered from the helpers, same host-can't-run skip-with-reason). The welcome mat closes on **one** caveat-aware next step (a behind member first, else `setup` / `recipes` / `velocity`).
   - **Then ask before committing — never auto-commit.** If step 3 added the slot (or anything else changed), report it and ask. If step 3 was a pure zero-diff no-op and nothing else changed, give the plain **settings already current — no update needed** message (the *Success state* contract) and still print the read-only version block (installed package versions) + backend line — but **no `docs/ai` structure version and no two-axes note** (nothing changed, so the number is inert here).
5. Show the relevant `${CLAUDE_SKILL_DIR}/CHANGELOG.md` diff (entries newer than the project's stamp).
6. Apply `${CLAUDE_SKILL_DIR}/migrations/<version>-<slug>.md` in **semver order**, only those newer than the project's stamp. Migrations are **idempotent** — safe to re-run.
7. Reconcile drift: add any kernel files/scripts the project is missing; never clobber project-authored content (their `decisions.md`, `known_issues.md`, page specs stay). Any user question a migration raises follows the same rule as bootstrap — **structured multiple-choice where supported** (`AskUserQuestion` in Claude Code), otherwise prose. If `AGENTS.md` has no *Communication language* block (pre-1.1.0 deployment), **ask the user their conversational language** and insert the block — see `migrations/1.1.0-communication-language.md`. If it has no *Attribution* block (pre-1.2.0 deployment), **ask whether the agent may attribute work to itself / AI** and insert the block (defaulting to `off`) — see `migrations/1.2.0-agent-attribution.md`.
8. Re-stamp `docs/ai/.workflow-version` to the **deployment-lineage head** (`1.3.0`, not the package version — mechanics unchanged: the atomic write to the stamp file). In the report, **describe what the upgrade changed in plain human terms** — which parts of their `docs/ai` are now different (the migrations that ran), plus the step-3 **placed-bridge refresh** lines (pasted verbatim) — rather than reciting a version number; **omit the raw structure number**, and do **not** print the two-axes note here (it belongs to *Version disclosure*, on demand only). Then **print the report footer** in the canonical order (version block → one-line backend-status line → welcome mat — the shared contracts above; rendered from the helpers, same host-can't-run skip-with-reason; the welcome mat closes on one caveat-aware next step). Then **ask before committing**.

### Mode: backends

Read-only. Answers *"which optional execution-backends are set up vs missing, and what's the next step?"* — for the family's subscription-CLI bridges (`codex-cli-bridge` → `codex`, `antigravity-cli-bridge` → `agy`). It **never writes, never commits, and never runs a subscription CLI**.

1. Run `node ${CLAUDE_SKILL_DIR}/tools/detect-backends.mjs` and present its table verbatim. Each row reports two **decoupled** axes: `manifestState` (health of the bridge *skill* — `not-installed | unsupported-schema | invalid-manifest | foreign | stub | ok`) and the readiness signals `cli` / `credentials` / `wrappers`, probed independently — so a CLI that is installed and signed in but whose bridge *skill* is absent reads `needs-skill`, not "missing".
2. For any backend that is not `ready`, point to its setup: the local `setup/README.md` when the bridge is installed, otherwise the backend's setup URL (both are in the report).
3. State plainly to the user that this is **detection only**:
   - **"credentials present"** means the credential-marker **file** exists — it is **not** a live login check. The detector never runs `codex login status` / `agy` (that would spawn a paid, slow, networked subscription CLI).
   - The bridges' wrappers are **POSIX `.sh`** scripts. On Windows the detector still works, but the bridges themselves are **not promised to run** — say so rather than implying they will.

### Mode: setup

The **only writer** among the backend modes, and **opt-in / in-agent only** — **placement** is **never** part of `init`. The npx installer deploys the *kit* and bundles the bridge skills in its tarball, but **does not place** them (that honesty claim is load-bearing — see `decisions.md` AD-009 / AD-011); **once placed** by `setup`, `init` and *Mode: upgrade* keep the placed copy fresh via the refresh-only `--refresh-placed` (below) — **never a first placement, never a downgrade**. `setup` owns exactly the two deterministic, secret-free steps and **guides** the rest. It **never commits and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/setup-backends.mjs [<backend>] [--bindir <path>] [--dry-run]`:

- `<backend>` — `codex` | `agy` | `antigravity` | `codex-cli-bridge` | `antigravity-cli-bridge`; omit for **all**.
- `--bindir <path>` — where to link the wrappers (default `~/.local/bin`).
- `--dry-run` — print the per-backend plan and change **nothing** (run this first).
- `--refresh-placed` — the **refresh-only** mode (what `init` runs automatically and *Mode: upgrade*
  runs as its fourth stamp-independent reconcile): refresh every bridge `setup` **already placed**
  from the kit's bundled copies + re-link its wrappers; an absent bridge is a stated skip (**never**
  placed), a placed bridge newer than the bundle is a stated skip naming the kit update (**never**
  downgraded), and every outcome line is composed by the tool — paste verbatim. Does not combine
  with `--dry-run`.
- `--help`, `-h` — usage.

For each backend it:
1. **Places / refreshes the bundled bridge skill** (from the kit's `bridges/<name>/` mirror) into its canonical dir — but only when that dir is **absent / empty / proven-managed** (valid manifest, matching `name`+`kind`). A `stub` / `foreign` / `invalid` / `unsupported` dir, a marker fs-error, or a symlinked dir → **STOP**, never overwritten. Refresh re-runs on a proven-managed dir so re-running `setup` delivers bundled fixes.
2. **Links its wrappers** (`codex-exec` / `codex-review`; `agy-review` / `agy-run`) onto `--bindir` via **managed symlinks** — replacing only a symlink that already points at our source. A non-symlink or a foreign symlink → **STOP**; it **preflights every target first**, so a conflict on one wrapper makes **zero** changes. If `--bindir` is not on `PATH`, it prints the one-line `export PATH=…` to add — it never edits a shell rc.
3. **Guides the manual, secret-bearing steps it will NOT automate** — the binary install (each bridge's `setup/README.md` §1) and the one-time interactive subscription login (`codex login` / `agy`) — printing the exact command for whichever axis is still missing (axis-aware: it can ask for both the CLI and the login at once).

**Close-the-loop output (surface both, localized).** The tool prints, after the per-backend report:
- a **bridge version** on each skill line — `(vX)` for a fresh place / equal refresh, `(vOld → vNew)` when a refresh bumps the bridge (never `vnull → …`);
- a **status pointer** — the full family + deployment version view lives in `/agent-workflow-kit status`;
- a **proactive recipe offer** when a setup just made a review backend ready (re-detected AFTER apply, so it reflects the real new state): it prints `/agent-workflow-kit set-recipe --set plan-authoring.review=<depth>` **and** `…plan-execution.review=<depth>` (Council when both are ready, else Reviewed). Relay it in plain language: offer to set the review recipe for **both** planning and execution review (preview first; you'll write it via *Mode: set-recipe*, or they can hand-edit) — never offer only `plan-execution`. Ask if the scope is unclear.

**Windows:** the wrappers are POSIX `.sh`; on `win32` it reports *unsupported — use WSL* and mutates nothing.

**Exit codes:** `0` = done / already set up / only manual steps remain (guidance is never a failure); **non-zero** = a STOP (a dir/symlink it refuses to clobber), a bad argument, a missing bundle, or a native fs error (the underlying reason is preserved in the message).

### Mode: status

Read-only. The **single answer to "versions + deployment + settings + bridges"** across the whole family — `tools/family-registry.mjs` aggregates every member's `capability.json` and surveys the project. It **never writes, never commits, and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/family-registry.mjs --json [--dir <project>]` and render it **compact**, in the user's conversational language — **never paste the JSON or any internal field name** (no-leak rule). Map the **`installed[].state`** token via the value→plain-language map under *The version block + welcome mat* (the `visibility` and wrapper states have their own phrasings, below). Present, each area on its own line(s), routing detail to its domain mode:

1. **Versions — a status-only render from `installed[]` + `deploymentHead`** (this is **NOT** the shared notes-based version block — see the separation note below): the **`docs/ai` structure version** (named as such, never "lineage head"), then each member by its `display` showing its `version` (or, when there is no version, the plain phrase for its `state`, mapped above), plus the two-axes disambiguation. **Freshness comes from `installed[].refresh`, not from `notes`:** for each member whose **`refresh.behind`** is `true`, show a **localized "needs refresh"** label and the **verbatim `refresh.recommend`** command **exactly once** (the command/package name stays source-language; **do not also paste the English `notes` caveats** — `refresh.recommend` is the single source of the recovery step, so the command is never duplicated on this surface). A member whose **`refresh.freshness`** is **`unknown`** is surfaced too — a localized *"couldn't be checked"* label; it is **never counted as current and never as behind** (its `notes` caveat carries the detail on the notes-based surfaces; here the label is enough). Lead with a one-line **headline count** derived from `installed[].state` + `refresh.behind` + `refresh.freshness` (e.g. *"5 members installed · 1 needs a refresh · 1 couldn't be checked"* — omit a zero count).

> **Status reads `refresh`; the shared version block + the bootstrap/upgrade footers stay `notes`-based (unchanged this release).** *Mode: status* has its OWN status-only render (above), keyed on `installed[].refresh.behind` / `refresh.recommend`. The shared **version block** (under *The version block + welcome mat*) and the bootstrap (step 11) + every upgrade (steps 4 / 8) report footer still consume `installed[].notes` verbatim — that wiring is deliberately **untouched** here (their migration onto `refresh` is deferred). Do not rewrite those footers onto `refresh`.
2. **Deployment (`--dir`)** (from `project`): whether `docs/ai/` is deployed + the deploy stamps by `display`; and **visibility** — render `project.visibility.state` in **user-safe words only**: *visible (tracked)* / *hidden (git-ignored, local-only)* / *unclear (uncommitted or partially set up)* — **never** the words "hidden fence" or any marker term. A `visibility.error` → surface it plainly.
3. **Settings (`--dir`, one line each)** (from `project.settings`):
   - **recipes** — the effective recipe per slot (detail → `/agent-workflow-kit procedures` / `recipes`); a `recipes.detectError` → say the backends couldn't be checked, so recipes floored at solo.
   - **attribution** — `includeCoAuthoredBy` effective; call out a **local override** only when `local` is non-null **and** differs from `project` (a `null` `local` means the key is absent there, so the project value stands — that is not an override).
   - **velocity** — the effective `permissions.defaultMode` + whether an allowlist is seeded (detail → `/agent-workflow-kit velocity`).
   - Any area's **`error`** field → surface it **loudly** in plain language; the rest of `status` still renders (never a crash).
4. **Bridges (host, one line)** (from `bridges[]`): per bridge — readiness + wrapper PATH-presence; render each wrapper's `state` as *on PATH* (`present`) / *not on PATH* (`missing`) / *couldn't check* (`unknown`) (detail → `/agent-workflow-kit backends` / `setup`). **No default-model claim.** "credentials present" means a marker file exists, not a live login.

Restate the **two-axes honesty** — an installed *package* version is not the project's **`docs/ai` structure version** (see *Version disclosure*); the installed version is whatever is on disk under `~/.claude/skills/…`, so a stale install shows its real (older) version, honestly. A host that can't run the helper → **skip with the concrete reason** (the helper-failure contract), never silently.

**Invariants:** read-only · never writes · never commits · never runs a subscription CLI · plain language only, no leaked internal terms.

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

1. **Config = `docs/ai/orchestration.json`** — strict JSON, **agent-writable via `/agent-workflow-kit set-recipe` (Mode: set-recipe) OR hand-edited** (the kit reads + validates it; `procedures`/`recipes` stay read-only — the writer is `set-recipe`). Shape: `{ "<activity>": { "<slot>": "<recipe>" } }`; all slots optional (an absent slot → its computed default, stated); an optional `"_README"` string is allowed + ignored. `review` accepts `solo|reviewed|council`; `execute` accepts `solo|delegated`. Seeded by `init` (a user-editable template) — see *Mode: bootstrap*.
2. **Default resolution (config silent):** `review` → Reviewed if any review-capable backend is `ready`, else Solo (never Council by default); `execute` → Solo (Delegated is opt-in). **Degradation:** a config/computed default degrades **gracefully with a stated reason** (Council → Reviewed → Solo; Delegated → Solo); a per-run **`--override <slot>=<recipe>`** that can't be satisfied degrades **loudly** (a flagged warning, so you tell the user) — but is **still exit 0** (a valid request that gracefully degraded).
3. **Exit codes:** `0` success; `2` usage (unknown `<activity>` / bad `--override` — a bare `--override <recipe>`, an unknown slot, an invalid recipe-for-slot, or a duplicate slot); `1` config error (malformed / schema-invalid / unreadable `orchestration.json`) **or** engine error (the installed engine is absent / invalid / **too old** to ship `references/procedures.md` — upgrade it with `npx @sabaiway/agent-workflow-engine@latest init`). A `1`/`2` failure is loud (`path: reason`), never a silent fallback.

**Cap-soft-skip degradation (the feature's only AUTO route).** The activity procedures are auto-discoverable only through the one-line **`workflow:methodology`** pointer (this kit + the engine carry `disable-model-invocation:true`, so NL like "write a plan" does **not** auto-load this skill). On a deployment whose methodology pointer was cap-soft-skipped — or whose pre-existing customized pointer lacks the procedures clause — the procedures are still reachable by **explicitly** invoking `/agent-workflow-kit procedures`; surface that plainly rather than treating it as a gap.

**Invariants:** read-only · never writes · never commits · never runs a subscription CLI · the deterministic resolution is the kit's, the recipe execution is the orchestrator's.

### Mode: set-recipe

The **config writer** for `docs/ai/orchestration.json` — the answer to *"set my standing recipe preference without hand-editing JSON."* **Division of labor (AD-025):** YOU turn the user's plain language into explicit ops; the KIT does the deterministic validate → merge → preview → write. It **previews by default** (writes nothing); `--write` applies. It **never runs a backend and never commits**. Hand-editing `docs/ai/orchestration.json` stays fully supported — this is an offered convenience, never a lock.

**Map the user's plain language → explicit ops** (the kit ships no NL parser; it performs no `all`-magic, so you expand scope explicitly, asking when unclear):

| user says (RU/EN) | op | scope |
|---|---|---|
| "оба ревьюят" / "both review" | `--set <activity>.review=council` | **disambiguate**: which activity? If both, pass `--set plan-authoring.review=council --set plan-execution.review=council`. |
| "один ревьюер" / "one reviewer" | `--set <activity>.review=reviewed` | per the named activity, else ask |
| "делегируй исполнение" / "delegate execution" | `--set plan-execution.execute=delegated` | execution only |
| "верни как было / сам" / "revert / do it myself" | `--unset <activity>.<slot>` | the named slot → its computed default |

Run **`node ${CLAUDE_SKILL_DIR}/tools/set-recipe.mjs [--set <activity>.<slot>=<recipe>]… [--unset <activity>.<slot>]… [--write] [--json]`**:

1. **Grammar — always fully-qualified `<activity>.<slot>`** (the kit never guesses the activity; a bare `review=council` is rejected). `review` accepts `solo|reviewed|council`; `execute` accepts `solo|delegated`. Activities/slots: `plan-authoring.review`, `plan-execution.execute`, `plan-execution.review`.
2. **Preview by default** — prints `current → proposed` for the **changed** slots only, plus the **effective recipe resolved against live backend readiness** (degradation stated honestly, e.g. *council requested, 1 ready reviewer → runs reviewed until a 2nd backend is ready*). It writes **nothing**. Re-run with **`--write`** to apply (same effective/degradation note — a direct `--write` is never quieter than the preview). `--unset` returns a slot to its computed default (reverting needs no hand-edit either). A no-op `--set` (slot already equals) writes nothing and never re-seeds the onboarding note.
3. **`--write`** applies via a hardened, atomic write (deployment-gated — refuses to scatter a config into a repo with no `docs/ai`; exclusive-create temp + rename; symlink/TOCTOU-safe; last-writer-wins). It preserves the onboarding note + every untouched slot, normalizing to canonical 2-space JSON.
4. **Exit codes:** `0` success (an explicit recipe that gracefully degrades is still `0`); `2` usage (a bare/duplicate op, or `--write` with no ops); `1` config error (malformed/unreadable config — the file is left **untouched**, never clobbered) or a write STOP (no deployment / a symlinked config). A `1`/`2` failure is loud; on a malformed config, offer to show the parse error so you can help the user fix the JSON.

Output is **English/structured** — **localize it to the user's conversational language** when you narrate. Surface the effective-recipe/degradation note plainly.

**Invariants:** writer (writes only `docs/ai/orchestration.json`) · never commits · never runs a subscription CLI · previews by default · degradation honesty on preview AND `--write` · hand-edit stays first-class.

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
4. **Surface delegation-readiness, read-only.** If they want a step run Delegated, set it with `/agent-workflow-kit set-recipe --set plan-execution.execute=delegated` (*Mode: set-recipe*) or by hand-editing `docs/ai/orchestration.json`; **velocity itself never writes the orchestration config.**

**Invariants:** creates `.claude/` if absent and writes **only** `.claude/settings.json` (no other file); **never** allowlists commit/push/publish; **never** writes `settings.local.json`; never commits; opt-in `acceptEdits`, never silent.

**Exit codes:** `0` done / dry-run; `1` a precondition STOP (stamp not current, unsafe mode, malformed settings, symlinked `.claude` / non-regular target); `2` bad arguments.

### Mode: agents

The opt-in **cheap-lane subagent writer** — the family's second `.claude/` writer, on the velocity discipline. It places the bundled cheap-lane subagent definitions (`references/agents/*.md`) into the project's `.claude/agents/` so mechanical work — extraction sweeps, changelog fact-skeletons, gate-failure triage — runs on a **cheap model** (`model: haiku`, `effort: low`, bounded read-only tools) instead of the frontier main lane. **Claude-Code-specific** (like velocity): other agent hosts ignore `.claude/agents/`. Judgment, review, real code, and user-facing copy never move to these vehicles — they are extraction/drafting only, and the orchestrator verifies their output.

Run `node ${CLAUDE_SKILL_DIR}/tools/cheap-agents.mjs [--dry-run | --apply] [--cwd <dir>]`:

1. **`--dry-run` first, always** (the default — changes nothing). It previews, per bundled vehicle, whether it **would place** the file, finds it **already current**, or finds a **customized** file (different content) that will be **preserved, never overwritten** (delete the file to reseed it from the bundle).
2. **Only on an explicit yes**, re-run with `--apply`. It writes **only** under `.claude/agents/` — never `settings.json` / `settings.local.json`, never a commit. `--apply` is deployment-gated (the stamp must be at the lineage head) and symlink-safe (a symlinked `.claude` / `.claude/agents` / target file is a STOP).
3. **Hidden-mode deployments:** after apply, run the hide-footprint reconcile (`node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --reconcile`) so the placed files stay invisible to `git status` — `/.claude/agents/` is in the known-footprint registry; the apply report reminds you.

**Invariants:** writer (writes only `.claude/agents/`) · preview by default · a diverged existing file is reported and preserved, never clobbered · never touches settings · never commits · vehicles are pinned to `model: haiku` + `effort: low` + read-only tools (content-tested).

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
- [`tools/`](tools/) — the family-wide tooling the kit **owns and ships**: `manifest/{schema.md,validate.mjs}` (the `capability.json` schema + the validator the kit runs as the memory detector, and root CI invokes), `commands.mjs` (the canonical **command catalog** + the pure `routeInvocation` router behind `/agent-workflow-kit help` and the safe unknown-invocation routing rule — one source of truth for the command surface, drift-guarded against the `### Mode:` headers), `delegation.mjs` (the executable delegate/fallback decision + hand-off plan), `inject-methodology.mjs` + `engine-source.mjs` (the bounded **two-slot** reconciliation — ensure-slot / inject-if-empty / cap for the `workflow:methodology` **and** `workflow:orchestration` pointers; both fragments read **live** from the installed `agent-workflow-engine` via `engine-source.mjs` (`deps.rel` selects which) — the family's one source of truth, no bundled mirror; fail-loud when the engine is needed but absent, orchestration soft-skipped when it would bust the cap), `detect-backends.mjs` (the read-only **backend detector** behind `/agent-workflow-kit backends`, plus the axis-aware `guideFor`; exports the readiness consts the planner reuses), `recipes.mjs` (the read-only **recipe planner** behind `/agent-workflow-kit recipes` — `RECIPES` / `planRecipe` / `recommendRecipe` over the bridges' role vocabulary, drift-guarded against `provides`/`cost`/`quota` + an engine↔kit recipe-name parity guard; pure, never runs a subscription CLI; also exports the pure `ACTIVITIES` / `resolveActivityRecipe` activity-procedures resolver and the machine-composed one-line backend status — `composeStatusLine` behind `--status-line`, pasted verbatim by the bootstrap/upgrade report footers), `procedures.mjs` (the read-only **activity-procedures advisor** behind `/agent-workflow-kit procedures` — reads `references/procedures.md` live from the engine via `engine-source.mjs`, reads + validates the agent-writable `docs/ai/orchestration.json` via `orchestration-config.mjs`, and prints the steps + the resolved effective recipe per slot; drift-guarded activity/slot table vs the canon; read-only, never imports the writer, never runs a subscription CLI), `orchestration-config.mjs` (the config **schema/read/pure-transform core** — `loadConfig`/`validateConfig`/the shared slot-recipe validity + `parseOp`/`applySetOps`/`serializeConfig`/the canonical-refresh helpers; no fs writes), `orchestration-write.mjs` (the **only** config fs-writer — a deployment-gated, atomic, symlink/TOCTOU-safe `writeConfig`; imported by `set-recipe` alone, never by `procedures`), `set-recipe.mjs` (the **config writer** behind `/agent-workflow-kit set-recipe` — validate → merge → preview-by-default → write; never runs a backend, never commits), `setup-backends.mjs` (the **link-only** backend setup behind `/agent-workflow-kit setup` — place the bundled bridge + link wrappers), `fs-safe.mjs` (the shared symlink-traversal-safe copy/link/**remove/unlink** primitives that `setup-backends`, the npx installer, and the uninstaller use), `known-footprint.mjs` + `hide-footprint.mjs` (the **hidden-mode** registry + the single hide-writer behind step 9 / the upgrade reconcile — one managed block in the **project-local** `.git/info/exclude` covering the full AI/agent footprint; pinned by `known-footprint.test.mjs` drift-guard + `hide-footprint.test.mjs` / `.integration.test.mjs`), `family-registry.mjs` (the **unified family registry** behind `/agent-workflow-kit status` — aggregates every member's `capability.json`; pinned by a `family-registry.test.mjs` drift-guard), `uninstall.mjs` (the **guarded teardown** behind `/agent-workflow-kit uninstall` — classify each surface, preflight-then-mutate, never delete user-authored content), `run-gates.mjs` (the **generic project gate runner** behind `/agent-workflow-kit gates` — batches the project-declared `docs/ai/gates.json` matrix into one PASS/FAIL table + a machine-readable summary line; bash cmd contract, distinct honest outcomes for missing/empty/malformed declarations; the runner writes nothing), `cheap-agents.mjs` (the **cheap-lane subagent writer** behind `/agent-workflow-kit agents` — places the bundled `references/agents/*.md` haiku/low vehicles into a project's `.claude/agents/`; velocity writer discipline: dry-run default, deployment-gated apply, a diverged file preserved, never settings), and `release-scan.mjs` (the attribution-off release gate). The bundled bridge skill mirrors live under [`bridges/`](bridges/) (byte-identical to the repo-root bridges, pinned by `test/bridges-mirror.test.mjs`). See [`tools/manifest/schema.md`](tools/manifest/schema.md).
- [`capability.json`](capability.json) — the kit's own `agent-workflow` family manifest (`kind: composition-root`).
- [`CHANGELOG.md`](CHANGELOG.md) — version history of this kernel.
