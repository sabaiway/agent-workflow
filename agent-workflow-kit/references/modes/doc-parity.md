### Mode: doc-parity

The DOC-PARITY lint (BUGFREE-3 / AD-049, session-economics item (b)) — the deterministic doc-drift killer. A recurring class of review churn came from a mode-contract doc silently lagging a code constant (a `--check` doc still reading "300" after the diff cap moved to 400, caught only in a later review round). This read-only tool closes that class mechanically: a **closed, exported registry** ties each live code constant to the exact token its `references/modes/*.md` contract must carry, and asserts the CURRENT value renders into every bound file.

**Run** — `node ${CLAUDE_SKILL_DIR}/tools/doc-parity.mjs [--check | --json]`:
- default → the per-binding report (each `constant → file` marked ✓/✗).
- **`--check`** → the gate exit code (0 consistent, 1 drift). Declare it as a project gate by hand in `docs/ai/gates.json`.
- `--json` → the structured result.

**What it checks (the closed registry).** The tokens are IMPORTED live from the tools — never re-typed in the lint — so the registry itself can never go stale:
- `references/modes/autonomy-doctor.md` carries the doctor's frozen D7 contract (AD-044 Plan 2): every live EXIT-table phrase (`` `0` ready `` … `` `6` unsupported / untrusted ``), every status token (sourced from the exported `STATUS`), and the trusted-dir allowlist (`TRUSTED_DIRS`);
- `references/modes/recommendations.md` + `references/modes/upgrade.md` carry the frozen upgrade-Recommendations presentation contract (the section header, the exact empty-state line, the verdict templates);
- `references/modes/recommendations.md` + `references/modes/velocity.md` carry the family-owned ack-store path (`docs/ai/acks.json`);
- `references/modes/setup.md` + `references/modes/upgrade.md` carry the `skipped-readonly` refresh degrade token.

**Why the modes/*.md docs and NOT the tool HELP strings.** Every tool's HELP INTERPOLATES the same constant, so it can never drift from the code — there is nothing to check there. The hand-authored contract prose in `references/modes/*.md` is the surface that DOES drift, so that is exactly what this lint pins. Change a constant and the current-value token stops appearing in the lagging doc → the gate fails, forcing the doc update **in the same edit as the code** (the §2.6 "contract docs change in the same edit as code" rule, mechanized).

**Edit-safe (the closed-world discipline).** Adding a binding ADDS a checked entry; it never widens a blocklist. A token that stops appearing, a bound file that cannot be read, or an unknown binding all FAIL CLOSED — never a silent pass.

**Invariants:** read-only · never writes · never commits · never runs a subscription CLI · spawns nothing · the value source is the live imported constant, never a re-typed literal.
