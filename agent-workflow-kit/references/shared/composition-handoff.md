## Hand-off contract & the kit block (composition root)

**Hand-off contract (explicit; tested independent of agent interpretation).**
- **Delegated** (memory valid): the kit passes the **target project dir** + the **three setup
  answers** (visibility / language / attribution — memory is told to skip its step-4 settings write; the `attribution` item of step 11 sets it) to `agent-workflow-memory`, which writes
  `docs/ai/` + `AGENTS.md` + **`.memory-version`**. The kit then **writes the kit block** (below)
  and writes the kit-fallback **`.workflow-version`**. → **both stamps** present. In **hidden** mode the kit is the **single
  hide authority**: after the hand-off it runs `tools/hide-footprint.mjs` (bootstrap step 9 — `${CLAUDE_SKILL_DIR}/references/modes/bootstrap.md`), which **absorbs
  memory's project-local footprint lines** into the one canonical `.git/info/exclude` block and adds
  the external footprint — so the hide makes **no machine-global write** (a stale memory's
  residual global block is the advisor's footprint-global item).
- **Fallback** (memory absent/invalid): the kit runs the bootstrap procedure (`${CLAUDE_SKILL_DIR}/references/modes/bootstrap.md`) from its own
  bundled assets — whose entry-point template the kit block is then written into — and writes **`.workflow-version`** only.
  Softly suggest installing `agent-workflow-memory` — never a prerequisite.

**The kit block (the kit is the ONLY writer of it).** After `AGENTS.md` exists, run ONE command —
`node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs reconcile <project>/AGENTS.md` — which writes
the kit block between its two `workflow:kit` comment lines in a single atomic write: the precedence
line, the read line, the **workflow-methodology**, **orchestration-recipes** and **autonomy-policy**
texts, and the rules-themes table, one row per theme. The block is written current with no question
and no copy kept, its line naming the route — text of your own goes outside the two workflow:kit
comment lines; a change to a kit rule goes in its theme's file under docs/ai/rules/local/. A file
with no block gains it at its start; with a valid installed engine supplying every text, a
deployment whose kit block is current reconciles to a zero-diff no-op. The texts are read **live from the installed
`agent-workflow-engine`** (`references/methodology-slot.md` + `references/orchestration-slot.md` +
`references/autonomy-slot.md`, the family's one source of truth) — **not** a bundled mirror. The
read is **fail-loud**: an **absent/invalid** engine **STOPs** the run, nothing written — report it
in plain language with the one-line install command `npx @sabaiway/agent-workflow-engine@latest init`
(`npx @sabaiway/agent-workflow-kit@latest init` installs the engine for you; translate, never leak
tool internals). An engine that lacks a later text writes one line in its place and a note naming
the refresh command. Comment lines that are not exactly one start line before one end line are
refused with their line numbers, nothing written: the upgrade STOPs.

**Navigator finalizer (runs in BOTH paths, AFTER the block write above).** `docs/ai/index.md` is
a GENERATED artifact the entry point declares always-loaded, and the deploy may have just
written a `docs/ai` file — so the finalizer runs at the LAST `docs/ai` mutation of the deploy,
before the stamp and the report. ONE command:
`node ${CLAUDE_SKILL_DIR}/references/scripts/docs-size/check-docs-size.mjs --ensure-index --root=<project>`.
Relay its one outcome line (*regenerated* / *already current*); a `write-refused` (the write) or
`probe-failed` (the tree could not be read) line names the offending path and is a loud STOP,
never a note. It is idempotent, so an earlier run in the
delegated path (the substrate's own fill step) is never a reason to skip it here.
