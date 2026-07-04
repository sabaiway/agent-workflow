### Mode: grounding

The **grounded-review facts assembler** (AD-038) — an ungrounded `agy` review GUESSES, and while the grounding contract is mechanized (`agy-review code --facts @f`), populating the facts file was a manual chore. This mode emits the two **mechanical** halves of a facts payload; the orchestrator still owns any judgment-bearing additions. **Catalogued honestly as a WRITER** — `--out <path>` writes one file — with the invariant: `--out` accepts **only gitignored / out-of-repo scratch destinations** and REFUSES a tracked path AND an in-repo not-ignored path (a new untracked file would itself move the review fingerprint the facts are about to ground); **stdout is the default**. It never commits and never runs a subscription CLI.

Run `node ${CLAUDE_SKILL_DIR}/tools/grounding.mjs [--constraints] [--plan <path>] [--reserve-bytes <n>] [--out <path>]`:

1. **`--constraints`** — slice the root `AGENTS.md` **Hard Constraints** section, verbatim and whole (exactly ONE matching heading; zero or several is a loud STOP, never a guess — the marker-slot discipline).
2. **`--plan <path>`** — extract the plan's decision-bearing canonical sections, verbatim + whole: `## Approach` (REQUIRED — its "What we are NOT doing" text rides inside; it is not a heading in canon) and `## Verification` (REQUIRED — STOP if missing), plus `## Decisions (locked)` when present (the optional engine §7 heading); a DUPLICATE heading is always a STOP.
3. **Byte budget** — the output honors the same `AGY_MAX_PROMPT_BYTES` contract the agy wrapper enforces (override may only tighten; the OS argv ceiling is rejected), MINUS **`--reserve-bytes <n>`** — the artifact share the caller expects `agy-review` to add around these facts. Overflow is trimmed tail-first with a loud in-band marker + stderr report — never a silent cut.
4. Feed the result to the wrapper: `agy-review code --facts @<out>`. The `procedures` advisor renders this invocation as a concrete pre-step whenever the resolved review dispatch includes agy — populated with the in-flight plan path when exactly one plan is in flight.

**Invariants:** writer (writes at most the ONE `--out` scratch file — gitignored / out-of-repo only) · never commits · never runs a subscription CLI · verbatim slices only (assembly is mechanical; facts judgment stays with the orchestrator).
