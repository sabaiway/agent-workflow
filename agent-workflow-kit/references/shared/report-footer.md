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
line), not a fresh helper call. **Beside the backend-status line**, when the target project carries a
`docs/ai/orchestration.json`, also paste the one-line **configured-recipe line** verbatim from
`node ${CLAUDE_SKILL_DIR}/tools/recipes.mjs --active-line` (run from the project root; `${CLAUDE_SKILL_DIR}/references/modes/recipes.md`
documents it; same agent-host skip-with-reason contract as the status line). Present everything in the
user's conversational language; never paste the JSON or any internal field name.

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
1. the **never-downgrade STOP** (`${CLAUDE_SKILL_DIR}/references/modes/upgrade.md` step 2) — the stamp is ahead of what this kit knows,
   so the number IS the message;
2. the **explicit version-status view** (`${CLAUDE_SKILL_DIR}/references/modes/status.md`) the user deliberately opens;
3. when the **user explicitly asks** about versions.

When you show it, **name what it versions — "the `docs/ai` structure version"** (render that meaning in
the user's conversational language) — **never** "lineage head", "deployment head", or any raw internal
token. Pair it with **one plain-language line** telling the two axes apart, on demand only:

> the number your project carries versions its `docs/ai` **structure**; the (usually larger) number on
> npm/GitHub is the **tool's own package version** — the two advance independently, so a bigger package
> number is **not** a newer deployment.

**Never** print this two-axes line on a successful equal-head exit — only at the STOP, the status view,
or on an explicit ask.
