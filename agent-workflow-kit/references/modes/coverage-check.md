### Mode: coverage-check

The **final-run checker** (strip-the-kit D3(c)+(d)) — two deterministic arms over ONE fixed artifact path, every refusal naming its locations `file:line`, never a bare count. It reads the lcov file the declared `unit-tests` gate cmd produced at `<git dir>/agent-workflow-lcov.info` (the constant this tool exports; `AW_LCOV_FILE` overrides, a test seam; the git dir is outside the fingerprint domain and never committable by construction) and prints `coverage-check: lcov-sha256=<hex|none>` — the sha of the EXACT bytes it consumed, which the `run-gates --final` receipt binds and re-hashes (exactly ONE such line attests).

Run `node ${CLAUDE_SKILL_DIR}/tools/coverage-check.mjs --check [--cwd <dir>]`:

1. **Coverage arm (D3(d)):** every CHANGED executable Node line (`.mjs`/`.cjs`/`.js`, tracked working-vs-HEAD changes + untracked-not-ignored files) must be covered — uncovered lines are LISTED `file:line` and fail; a changed file ABSENT from the lcov map is a file-level red (never "non-executable" by silence); changed out-of-domain files (e.g. `.sh`) and unsupported-source files (e.g. `.ts`) are LISTED — the claim is narrowed honestly, not widened. NO lcov file at the path = a LOUD `skipped-no-lcov` (exit 0, stated — produce the file via the unit-tests gate's lcov reporters); a symlink at the path is a refusal (lstat, no-follow).
2. **Red-proof arm (D3(c)):** every authoritative current-base `red-proof` declaration must verify — the bound test file exists (deleted fails), its content sha256 matches the declaration (custody), the test resolves (zero-match fails) and runs green N/N NOW, and the declaration's pre-fix fingerprint differs from the current tree (equal = reuse/forgery, refused). A malformed evidence store fails CLOSED.

Wire it as the LAST declared gate in `docs/ai/gates.json` — `run-gates --final` REFUSES a declaration where the canonical coverage-check gate is not last (nothing may run after the checker consumed the lcov) or where its cmd is not ONE plain invocation of the kit's OWN tool (a masked form or a lookalike path never counts).

**Invariants:** writes nothing · spawns read-only `git` queries + the bound-test probes (`node --test`, shell-free) · no network · exit 0 pass / 1 fail (locations listed) / 2 usage.
