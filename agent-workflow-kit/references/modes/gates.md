### Mode: gates

The **generic project gate runner** — it batches the project's OWN declared verification commands into one run. The runner itself **writes nothing, never commits, and never runs a subscription CLI**; what it EXECUTES is the project's own declaration, with the caller's privileges (trust posture: a batching convenience over commands the project already runs by hand — **not a sandbox**).

Run `node ${CLAUDE_SKILL_DIR}/tools/run-gates.mjs [--cwd <project>] [--only <id>]…`:

1. **Reads `docs/ai/gates.json`** (strict JSON, hand-editable; seeded from `references/templates/gates.json`). Each gate is `{ id, title, cmd }` — `id` a unique kebab handle, `cmd` **ONE bash command line** (brace/glob expansion works; a host without bash gets a loud preflight error, exit 6 — never a silent reinterpretation under another shell). The declaration names **WHAT to check, never who executes it** — the schema has no lane/model/routing fields and rejects unknown keys loudly.
2. **Runs each gate from the project root** and prints a per-gate **PASS/FAIL table** plus **one machine-readable summary line** as the last line (`[run-gates] status=… gates=… passed=… failed=… failed_ids=…`). A failing gate's own output is preserved **verbatim** (triage without re-running); a green gate's output is not echoed; gates after a failure still run. **Exit 0 iff all selected gates are green.**
3. **Honest outcomes, each distinct — never a silent green:** a **missing** declaration (exit 3 — the report names the recovery: create `docs/ai/gates.json` from the template; `upgrade` re-seeds a missing one), an **empty** `gates` list (exit 4), a **malformed/invalid** declaration (exit 5, loud `path: reason`). Repeatable **`--only <id>`** re-runs a subset; an unknown id is a loud usage error (exit 2).

The declaration is **seeded at bootstrap** (the template loop, `${CLAUDE_SKILL_DIR}/references/modes/bootstrap.md` step 6) and **ensured-if-missing on upgrade** from THIS kit's own template twin (`${CLAUDE_SKILL_DIR}/references/modes/upgrade.md` step 3) — independent of the installed memory substrate's age; an existing file is always **preserved byte-for-byte**. It is deliberately **not** a delegation-required memory asset: gates are optional, and absence is an honest runner outcome, not a deployment failure.

Declared gates can also be **auto-approved** (no permission prompt on a byte-exact invocation from the project root) via the opt-in PreToolUse hook — `${CLAUDE_SKILL_DIR}/references/modes/hook.md`: the SAME declaration, a second consumer; editing gates.json needs no re-wiring.

**Candidate line — the review-receipt gate (opt-in, never auto-seeded; AD-021).** Projects that configure a reviewed/council `plan-execution.review` recipe can declare the AD-038 review-state check as one more gate — the exact candidate `{ id, title, cmd }` line and its contract live under `${CLAUDE_SKILL_DIR}/references/modes/review-state.md` (step 3). The template `gates.json` stays EMPTY; adding the line is the maintainer's explicit consent, by hand.

**Invariants:** the runner writes nothing · never commits · never runs a subscription CLI · executes only the project's OWN declared commands (never a kit-invented one) · the bash contract fails loud, never reinterprets.
