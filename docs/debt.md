# Debt queue

Rows queued out of a review round instead of folded. Each carries a stable id the flow store's
`queued` disposition binds to. A row leaves this file only when the work lands.

No open rows.

## Closed

- **PARITY-RESOLVE-TERNARY** — queued when the fix (one redundant `isAbsolute` ternary spelled twice)
  reached outside the phase that raised it, then FOLDED in a later round of the same step: correcting
  the wrapper-link resolution base required touching both call sites anyway, and the check is no
  longer redundant there — it now decides whether the physical parent has to be resolved at all.
