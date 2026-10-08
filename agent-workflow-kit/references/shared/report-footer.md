### The one-line backend-status line (shared by bootstrap + upgrade)

Bootstrap (step 11) and **every** successful `upgrade` exit (steps 4 + 8) share a read-only,
**machine-composed** backend summary — **paste its single emitted line verbatim**:
`node ${CLAUDE_SKILL_DIR}/tools/recipes.mjs --status-line`
The tool runs the backend detector and appends the recipe recommendation itself
(`composeStatusLine`); the agent **composes nothing factual** — no readiness token, no glyph, no
recipe clause of its own, ever.

- **Placeholder template (structure only — never copy this example; paste the tool's line):**
  `backends: <alias> <✓|✗> <readiness> · <alias> <✓|✗> <readiness> — run /agent-workflow-kit backends · recipes: <recommendation clause> — see /agent-workflow-kit recipes · autonomy: <per-activity levels> (<policy state>)`
- **Ready bridge wiring cells (placeholders only):** `<alias> ✗ not wired — <n> sandbox entr(ies) missing`,
  `<alias> ✗ not wired (unused) — <n> sandbox entr(ies) missing`, `<alias> ✗ unchecked — <reason>`.
  The ` · sandbox: <condition>` segment follows `— see /agent-workflow-kit recipes`: enabled in the project
  settings — `ready means wired` where the host honors the settings sandbox keys; not enabled in the project
  settings — `ready means installed`; `unchecked — <reason>`.
- The **`autonomy:` segment is appended by the composer itself** (`composeAutonomyFacts`, AD-044) —
  per-activity levels + the policy state (computed defaults / declared / MALFORMED, loud) — the
  agent never types it; the composer resolves the policy from the project root, so the line is
  correct from any working directory inside the project.
- The **`recipes:` clause is appended after** the `— run /agent-workflow-kit backends` pointer (never
  replacing it) and routes to the read-only `recipes` mode (`see /agent-workflow-kit recipes`). It is
  **never blank**: both backends ready → *"Council available, Reviewed the everyday default"*; one
  ready → *"Reviewed available (via …)"*; **none installed → *"Solo — run /agent-workflow-kit setup to
  add a backend"***; a backend present-but-not-ready → Solo with that backend's specific remedy.
  (`recommendWiredRecipe` appends ` · not wired: <alias> (review) — <route>` and
  ` · unchecked: <aliases>` to the readiness clause in the same tool run.)
- **Invariants:** **read-only · never blocks the commit gate · never runs a subscription CLI · the
  pointer is the in-agent `backends` mode, never a network fetch · the appended `recipes:` clause
  routes to the in-agent `recipes` mode the same way · `init`/npx never *places* bridges (it
  refreshes only what `setup` already placed, AD-011 §5).**
- **Composer unavailable → skip with a stated reason, never silently.** This Node script runs on the
  **agent host**: skip only when the host lacks `node` on PATH or the tool errors — **not** "the
  project has no Node runtime". Skip the line and state the concrete reason — never a silent skip.

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

**Success state — the happy path never leads with a structure number.** Omit the internal `docs/ai`
structure version, stamp filename and versioning vocabulary; see *Version disclosure* below.
Frame the success itself plainly, in the **user's conversational language** (never hardcode a phrase):
- a **zero-diff no-op `upgrade`** (step 4) → **settings already current — no update is required**
  (convey this meaning in the user's conversational language, in your own words);
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

**Helper-failure contract (mirror the backend-status line).** The **agent host** runs family-registry.
If it lacks `node` on PATH or the helper errors, **skip the version block and say so with the concrete
reason** — never a silent skip. The rest of the report — and the commit gate — proceeds.

**Welcome mat — the last line(s) of the footer.** After the version block and the backend-status
line, print *"Run `/agent-workflow-kit help` to see every command."* and *"New to the epic, story and task tier? Run `/agent-workflow-kit tier`."* then **one** recommended next
step, chosen **caveat-aware** from signals already in hand (the version block's notes, the settings
areas of the same `--json` envelope, and the backend-status line — no new helper call) in this
priority order:
1. a member is **behind** (a behind-class `installed[].notes` caveat fired — any member, the bridges
   included) → *refresh the behind member first*, quoting **that note's own recovery command
   verbatim** (a memory/engine note carries its `npx …@latest init` + restart the session; a bridge
   note carries `/agent-workflow-kit setup`). An **uncheckable** member ("couldn't be checked" — an
   unknown-freshness note) is **never** a refresh trigger: only a behind note fires this step — the
   uncheckable note already appears in the version block, add nothing more;
2. else **no bridge is ready by the detector's readiness** (not the cell word) → *set one up with
   `/agent-workflow-kit setup`*;
3. else **a ready bridge's cell reads `✗ not wired —` or `✗ unchecked`** → *see what is missing with
   `/agent-workflow-kit recipes`* (its lines name each bridge's missing entries and route, or its reason);
   never on a `✗ not wired (unused)` cell;
4. else **a backend is ready but the orchestration config is still all-Solo** (no `reviewed` /
   `council` / `delegated` slot anywhere — inspect `docs/ai/orchestration.json`, or read the
   procedures advisor's resolved recipes) → *put it to work with `/agent-workflow-kit recipes`*;
5. else **the velocity allowlist is not yet seeded** (the envelope's velocity settings show zero
   allow entries) → the optional *`/agent-workflow-kit velocity`* opt-in (never run it without a
   yes);
6. else **the cheap-lane agent vehicles are not placed** (the envelope's agents settings show zero
   placed) → the optional *`/agent-workflow-kit agents`* opt-in (never run it without a yes);
7. else **gates are declared but the approval hook is not wired** (the envelope's hook settings:
   at least one declared gate, wired = no) → the optional *`/agent-workflow-kit hook`* opt-in
   (never run it without a yes). If no rung applies, the two lines above stand alone.

Keep it compact — a few short lines, plain language, no kit-internal terms.

### Version disclosure — the `docs/ai` structure version, on demand only

The internal **`docs/ai` structure version** (`deploymentHead`) is what `upgrade` compares the stamp
against to decide whether a migration is due. Hide it on the happy path; surface it in exactly
**three** places:
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

### Live host/session facts — tool-composed only

Any claim a report makes about the **current host or session state** — whether a permission prompt
fired, what the session sandbox allows or blocks, whether a bypass was needed, which network hosts
are reachable, how many approvals happened — must trace to **live tool output** produced **this
session**: a status / recipe / recommendations line the composer emitted on this run, or a probe you
ran and observed this session. It is never asserted from recollection. A memory or handover note is
**context, never report facts** — it records what was true when written, not the live state, and is
never the source of a current-state claim. When no live signal backs such a claim, the claim is
**omitted or explicitly marked unverified** — never stated as fact and never back-filled from a
snapshot. This binds **every** report surface (the bootstrap / upgrade exits, the recommendations
advisor, any ad-hoc status summary); the mode files carry a one-line pointer to this clause, never
their own copy of it.
