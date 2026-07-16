# Grounded review contract — `agy-review` (review role)

The `review` role of `antigravity-cli-bridge` delegates a **read-only second opinion** to `agy`.
`agy` reads **nothing** by default and its training predates the current codebase, so an *ungrounded*
review **guesses** — stale-model false positives ("that model can't exist") and partial-diff false
positives ("the bridge code is missing"). The fix is the **agy analog of codex's precomputed diff**:
feed `agy` a **self-contained** prompt of **verified facts** plus the **full artifact**, and forbid it
from opining on model names / its own cutoff.

> **This file is a STATIC, human-readable reference of the assembled contract — NOT a dynamically
> rendered template.** `bin/agy-review.sh` assembles the prompt **in code**; the `{{…}}` below are
> documentation placeholders, not runtime substitutions. The **wrapper is the executable source of
> truth** — if it disagrees with this file, the wrapper wins (no drift). Drive it through `agy-review`
> (see [`driving-agy.md`](./driving-agy.md)), supplying `--facts` / `--decided` / `--focus`.

## Assembled prompt shape (byte-stable order)

```text
POSTURE  You are a meticulous staff-level engineer giving a read-only SECOND OPINION. Read-only:
         do NOT propose edits, run commands, or make git changes — findings ONLY, advisory.

GUARD    Do NOT comment on AI model names/versions or your own knowledge cutoff — irrelevant here
         and a known source of false positives. Review ONLY the engineering, AGAINST the facts.

## Grounded facts — review AGAINST these, do NOT guess the code
{{GROUNDED_FACTS}}   # from --facts @file (code: REQUIRED non-empty, refuses pre-spend — escapes --ungrounded / AGY_PROBE=1; plan/diff omitted -> an in-band note + a LOUD stderr warning)

## Decisions already made / already addressed — do NOT re-raise these
{{ALREADY_DECIDED}}  # from --decided @file (optional — the anti-circling lever; the round-2 payload)

## Focus
{{FOCUS}}            # from --focus "…" + any trailing focus words, merged in parse order (optional)

## The change set / plan / diff under review
{{ARTIFACT}}         # code: the assembled, repo-complete working-tree change set (or, when oversized
                     #   with AGY_REVIEW_ALLOW_ADDDIR=1, a private --add-dir staging file)
                     # plan/diff: the supplied file, inlined

## Output — Markdown, this exact shape, nothing else
### Verdict
One line: SHIP / SHIP WITH NITS / REWORK, plus a one-sentence reason.
### Blocking
Numbered. Correctness bugs, contract violations, data loss, security. Cite file:line. Empty? "none".
### Non-blocking
Numbered. Simplifications, reuse, naming, missing tests. Cite file:line. Empty? "none".
### Questions
Anything ambiguous that would change your verdict if answered.
```

## Why no "read the repo's AGENTS.md" instruction

Earlier versions told `agy` to *read the repo's root `AGENTS.md` (your cwd)*. That was the documented
root cause of guessing: `agy` cannot reliably read repo code or the diff without an explicit
`--add-dir`, so a review that **depends** on it silently reviews half a picture. The grounded contract
removes that dependency — everything the model needs is **in the prompt** (`--facts` + the artifact).
`agy` may still *surface* the single cwd context file, but a review must never **rely** on it.

Treat the result as **advisory** — re-run the project's real gates and verify every finding locally
before acting.
