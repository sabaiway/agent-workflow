// coverage-state.mjs — the coverage vocabulary LEAF (kit-inert-gate Phase 2, Decision 8).
//
// Two consumers need the same closed value set and cannot import each other: run-gates.mjs REPORTS
// the token on its summary line and records it on the `--final` receipt, and core-evidence.mjs
// VALIDATES that recorded field — and run-gates already imports core-evidence (the sole-writer
// boundary), so the dependency can only run this way. ONE home, no drift guard needed: the
// repo-lex.mjs / gates-declaration.mjs leaf idiom.
//
// No imports, no CLI, no side effects. Dependency-free, Node >= 22.

// The CLOSED set, with ONE value defined for every run outcome. It is DETAIL, never a new state:
// no exit code, no `status=` token, no receipt status and no commit-guard disposition reads it.
export const COVERAGE = Object.freeze({
  certified: 'certified', // the canonical checker consumed lcov bytes and ISSUED a verdict — pass OR fail
  notRun: 'not-run', // the checker ran and issued NO verdict: nothing was read, or the run holds no attestation context
  none: 'none', // no canonical checker ran here (an --only subset, the --pre-review derived subset)
  unknown: 'unknown', // the run ended before the gates produced the signal, or the signal is unreadable
});

// What may ride a `final` receipt. `none` never can: --final REFUSES a declaration that does not
// carry the canonical checker last, so a final run always selects it (run-gates.mjs --final
// preflight) — a recorded `none` would mean the receipt describes a run that could not have
// happened, and the validator says so instead of storing it.
export const FINAL_COVERAGE_STATES = Object.freeze([COVERAGE.certified, COVERAGE.notRun, COVERAGE.unknown]);
