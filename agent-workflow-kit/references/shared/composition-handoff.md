## Hand-off contract & bounded pointer reconciliation (composition root)

**Hand-off contract (explicit; tested independent of agent interpretation).**
- **Delegated** (memory valid): the kit passes the **target project dir** + the **three setup
  answers** (visibility / language / attribution) to `agent-workflow-memory`, which writes
  `docs/ai/` + `AGENTS.md` (carrying the **two empty pointer pairs** — `workflow:methodology` and
  `workflow:orchestration`) + **`.memory-version`**. The kit then **reconciles both bounded pointers**
  (below) and writes the kit-fallback **`.workflow-version`**. → **both stamps** present. In **hidden** mode the kit is the **single
  hide authority**: after the hand-off it runs `tools/hide-footprint.mjs` (bootstrap step 9 — `${CLAUDE_SKILL_DIR}/references/modes/bootstrap.md`), which **absorbs
  memory's project-local footprint lines** into the one canonical `.git/info/exclude` block and adds
  the external footprint — so there is **no machine-global write** at any step (a stale memory's
  residual global block is cleaned via the upgrade reconcile, below).
- **Fallback** (memory absent/invalid): the kit runs the bootstrap procedure (`${CLAUDE_SKILL_DIR}/references/modes/bootstrap.md`) from its own
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
