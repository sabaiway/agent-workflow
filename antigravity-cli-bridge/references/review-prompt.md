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
{{ARTIFACT}}         # code: the assembled, repo-complete working-tree change set (when oversized it
                     #   is not inlined at all — see the chunked feed below)
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

## Over-cap `code`: the change set is DELIVERED, and delivery is PROVEN

`agy` takes its prompt as ONE argv value, and headless `agy` **auto-denies its own `read_file` tool**
(probed twice, including for a file inside the working tree). So an over-cap change set can never be
**fetched** by the model. Past `AGY_MAX_PROMPT_BYTES` a `code` review is therefore **delivered**:
the assembled change set is cut into under-cap parts, fed over continuation turns, and reviewed in a
final turn. `plan` / `diff` keep refusing over the cap — their artifact is an operator-supplied file
the operator can split.

- **Envelope and body are formally separate.** Each fed turn = an ENVELOPE the wrapper authors
  (framing, part index, the acknowledge-only instruction) plus a **pristine BODY**, a verbatim slice
  of the change set. Only BODIES concatenate, and they concatenate **byte-for-byte**: nothing the
  wrapper adds ever enters the reviewed artifact, and the receipt's fingerprint domain is untouched.
- **Delivery is proven, never assumed.** After assembly the wrapper picks, per part, an interior line
  the model cannot anticipate, and asks for it **by address only**. The mandated shape gains
  `### Delivery proof` as its **FIRST** section, so output truncation cannot silently drop it:

```text
### Delivery proof
part <K> line <L>: <the text of line L of part K, VERBATIM>
Requested addresses, one per line:
part 1 line 743
part 2 line 512
### Verdict
…
```

The addresses ride **one per line, each shorter than the minimum length a proof candidate may have**.
That is not formatting: it makes a collision **constructively impossible**. A candidate is a single
line of at least that minimum, and a single line can never match across a newline — so the request
itself can never reveal the very text it asks for, and the wrapper needs no second selection pass.

- **Any missing or non-matching echo is a FAILED review** — `exit 4`, **NO receipt**, and a message
  naming the cause. Never a downgraded verdict, never a warning beside a kept receipt.
- **Cost is stated before it is spent** (D5): N parts cost N+1 subscription turns, announced on
  stderr before the first dispatch. `AGY_REVIEW_MAX_TOTAL_BYTES` (default 240000) bounds the SUM of
  all outgoing prompt bytes and refuses **before** turn 1 — an economy guard, not the correctness
  guard.
- **The receipt self-declares delivery**: `inline` (the whole change set rode one prompt — proven by
  construction) or `fed` (proven by echo). The kit's review-state gate requires the field present and
  well-formed, never a particular value, so a receipt minted before this lane existed no longer
  attests. The recovery is stated: re-run the review.
- **Later turns are routed by a NAMED field.** Turn 1's `--output-format json` envelope carries
  `conversation_id`; the wrapper validates it against the UUID grammar and dispatches every later
  turn with `--conversation <id>`. There is no `--continue` fallback in this lane: an id that is
  absent, wrong-typed or malformed stops the run **before turn 2 is spent**, with NO receipt. (It was
  formerly scraped from `agy`'s own run log — a format that is `agy`'s to change, so the pin could
  rot silently; a named field fails loudly instead.)

### Honest residuals (recorded, not engineered away)

- A model that genuinely received every part but **mis-transcribes** one echo produces a FALSE
  refusal and its analysis is lost. Placing the proof FIRST bounds the truncation case, and the
  comparison tolerates surrounding whitespace only — never content. The rest is the accepted price of
  failing closed: **re-run the review**, do not distrust the lane.
- A change set whose parts carry **no unique interior line** in the 24..200-byte window (a single
  huge minified line, for instance) cannot be proven delivered, so the wrapper **refuses** rather
  than reviewing unprovably. Split the review, or exclude the blob.

## agy's own permission ask — surfaced, never applied

When `agy` denies `read_file` it names the permission rule it wants. The kit **never writes it**:
granting it would widen a boundary for ALL `agy` use on the machine, and it would buy nothing this
design needs — the fed lane delivers content inline and reads no file. `--dangerously-skip-permissions`
is strictly worse (it auto-approves writes during a read-only review) and is not offered.

## Why no "read the repo's AGENTS.md" instruction

Earlier versions told `agy` to *read the repo's root `AGENTS.md` (your cwd)*. That was the documented
root cause of guessing: `agy` cannot reliably read repo code or the diff without an explicit
`--add-dir`, so a review that **depends** on it silently reviews half a picture. The grounded contract
removes that dependency — everything the model needs is **in the prompt** (`--facts` + the artifact).
`agy` may still *surface* the single cwd context file, but a review must never **rely** on it.

Treat the result as **advisory** — re-run the project's real gates and verify every finding locally
before acting.
