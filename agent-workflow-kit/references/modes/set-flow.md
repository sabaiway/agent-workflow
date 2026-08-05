### Mode: set-flow

<!-- opt-in-capability: none — the flow arms only by explicit maintainer action at a plan boundary (#52); the advisor-offer decision rides the Plan-4 dogfood/release wave -->

The **arming writer** for the `flow` block of `docs/ai/orchestration.json` — the answer to *"turn the review-flow machinery on for this project."* **Division of labor (AD-025 discipline):** YOU turn the user's plain language into explicit `--preset` / `--set <key>=<value>` / `--unset <key>` ops; the KIT does the deterministic parse → merge → floor-check → preview → write. It **previews by default** (writes nothing); `--write` applies. It **never runs a backend and never commits**. Hand-editing the config stays fully supported.

Run **`node ${CLAUDE_SKILL_DIR}/tools/set-flow.mjs [--preset <council|reviewed|internal-only>] [--set <key>=<value>]… [--unset <key>]… [--write] [--json]`**:

1. **Merge (#30):** the preset is a **seed** — its values come verbatim from the kit's schema-1 canon (the same literal fixture the config validator pins); explicit `--set` keys win over the seed, the seed wins over the existing block, and `schema` is pinned by the kit (never an op). `candidates` are never seeded — they name the project's REAL backends (`--set candidates=codex:review,agy:review`). The **merged flow block previews** before any write.
2. **Arming floors (#31 — the config validator stays shape-only; every DEEP floor lives on this path):**
   - **`kitMinVersion` (Decision 6, #54):** the null-guarded semver comparison — an unparseable version on either side **never** passes (the bare `>= 0` shape fails open on null and is banned).
   - **`debtQueue` / `convergenceSummary` (#37/#69):** each declared path must be a **single regular TRACKED file** or carry its explicit `…Excluded: true` declaration (**loud**); never a symlink or directory; never under `docs/ai/`; never a literal substring of any declared gate `cmd` (`docs/ai/gates.json`).
   - Floors hold on the preview **and** the write lane — exit `1`, nothing written, until every floor passes.
3. **The disclosed residual (printed on every floor evaluation):** the bookkeeping floors decide only what is decidable at arming time: a gate command reading the declared path INDIRECTLY (through its own script), content-level abuse inside the file, and a path re-pointed after arming stay undecided — bookkeeping WRITES are bound by digest and custody proof at the checker instead (#37/#69); this line is the honest boundary, not a pretended rule
4. **After a successful `--write`:** only the **config half** is armed — the **chain half** arms at plan adoption (`flow-writer adoption <plan-file>`), and `gates-init` offers the full checker TRIO (review-state + coverage-check + flow-check) for a flow-carrying config.
5. **Exit codes:** `0` success/preview; `2` usage (bad key/value/flag, a bare `--write`); `1` floor refusal, config error (the file is left untouched), or a write STOP (no deployment / symlinked config).

**Lagging-kit honesty (verbatim contract):** a kit predating the `"flow"` key that reads a config carrying one fails this config load loudly (exit `1`, reddening its full gate matrix); the `set-flow` arming path now enforces the declared `kitMinVersion` floor with a null-guarded comparison (an unparseable version never passes), while tolerate-first ordering remains the only protection for readers older than the `"flow"` key itself — no in-config floor can reach a kit that dies on the unknown key

Output is **English/structured** — **localize it to the user's conversational language** when you narrate.

**Invariants:** writer (writes only `docs/ai/orchestration.json`) · never commits · never runs a subscription CLI · previews by default · every deep floor on this path only · hand-edit stays first-class.
