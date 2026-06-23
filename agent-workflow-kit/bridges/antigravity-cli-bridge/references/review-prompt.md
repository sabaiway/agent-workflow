# Review prompt template — `agy-run` (review role)

The `review` role of `antigravity-cli-bridge` delegates a **read-only second opinion** to `agy`.
`agy` cannot see the conversation and (in v1.0.10) has no JSON output, so the prompt must be
**self-contained** and ask for **plain-Markdown findings only** — no repo edits, no git writes.
Fill the `{{…}}` slots, pipe it to `agy-run`, then verify every finding locally before acting.

```text
You are a meticulous staff-level reviewer giving a SECOND OPINION. You are read-only:
do not propose to edit files, run commands, or make git changes — return findings only.

## What to review
{{TARGET}}   # e.g. "the implementation plan below" or "the working-tree diff below"

## Project rules
Read the repo's root AGENTS.md (your cwd) and obey its Hard Constraints and conventions.
If AGENTS.md declares a verification/gate set, judge the change against it; if it declares
none, say so — do NOT invent checks.

## Material
{{CONTENT}}  # paste the plan text, or the unified diff, or the file excerpts under review

## Focus (optional)
{{FOCUS}}    # e.g. "correctness of the new reducer", "backward-compat of the stamp takeover"

## Output — Markdown, this exact shape, nothing else
### Verdict
One line: SHIP / SHIP WITH NITS / REWORK, plus a one-sentence reason.
### Blocking
Numbered. Correctness bugs, contract violations, data loss, security. Cite file:line.
Empty? write "none".
### Non-blocking
Numbered. Simplifications, reuse, naming, missing tests. Cite file:line.
### Questions
Anything ambiguous that changes your verdict if answered.
```

## Usage

```bash
# critique a plan
AGY_MODEL="Gemini 3.1 Pro (High)" agy-run @/tmp/review-prompt.filled.md

# critique the current diff (build the prompt with the diff pasted into {{CONTENT}})
git diff | ...  # assemble the filled prompt, then:
agy-run @/tmp/review-prompt.filled.md
```

Treat the result as **advisory** — `agy` output may be incomplete or out of date. The orchestrator
re-runs the project's real gates and owns every accepted change. See
[`driving-agy.md`](./driving-agy.md).
