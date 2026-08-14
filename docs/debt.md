# Debt queue

Rows queued out of a review round instead of folded. Each carries a stable id the flow store's
`queued` disposition binds to. A row leaves this file only when the work lands.

- **LINE-SAFETY-TEST-FULL-RANGE** — the `UNSAFE` byte list in
  `agent-workflow-kit/tools/lens-region.test.mjs` samples 11 boundary code points while the
  comment and the composer contract claim the full C0/DEL/C1/U+2028/U+2029 range; generate the
  array from the complete ranges (U+0000–U+001F, U+007F–U+009F, U+2028, U+2029) and use it in both
  checks, so a byte the composer misses cannot slip between samples. Queued at the Phase-1 round
  cap (a test-breadth minor; the composer itself already covers the full range by construction);
  land it with the next lens-region-touching Step of this plan.

## Closed

- **PARITY-RESOLVE-TERNARY** — queued when the fix (one redundant `isAbsolute` ternary spelled twice)
  reached outside the phase that raised it, then FOLDED in a later round of the same step: correcting
  the wrapper-link resolution base required touching both call sites anyway, and the check is no
  longer redundant there — it now decides whether the physical parent has to be resolved at all.
