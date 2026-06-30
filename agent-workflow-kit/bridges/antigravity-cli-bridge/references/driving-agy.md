# How the main agent drives `agy`

`agy` is a **delegated-execution backend**: the main agent stays the orchestrator and hands `agy` a
bounded, self-contained sub-task. `agy` answers from the **subscription** quota, so the goal is
maximum useful output per token of that quota. Treat its output as **advisory** — the main agent owns
edits, verification, and final judgment.

## Delegation checklist

1. Pick the narrowest useful question.
2. Choose the cheapest model that can answer it.
3. Include only the relevant excerpts, paths, constraints, and the expected output shape.
4. State permission boundaries in the prompt (no edits, no git writes).
5. Run `agy-run` headlessly.
6. Treat the response as advisory and verify before acting.

## Model selection

| Task | Model |
|---|---|
| Reachability / smoke / "is it wired?" | `Gemini 3.5 Flash (Low)` |
| Cheap probes, summaries | `Gemini 3.5 Flash (Medium)` |
| Quick review with a little more effort | `Gemini 3.5 Flash (High)` |
| Reasoning, plan critique, careful drafting | `Gemini 3.1 Pro (High)` (wrapper default) |
| Same reasoning, lower quota cost | `Gemini 3.1 Pro (Low)` |
| A different engine's opinion | `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, or `GPT-OSS 120B (Medium)` |

Don't reach for Pro by reflex — Flash answers most reachability/probe questions for a fraction of the
quota.

## Quota economy

Subscription quota is finite. Prefer:

- A short probe on Flash before a large Pro run.
- One sharp question over broad "review everything" prompts.
- Prompt files with trimmed excerpts instead of whole repositories.
- `AGY_TIMEOUT=2m` for probes, longer timeouts only for deep reviews.
- Reusing a conversation with `--continue` when the context is already loaded.

## Continue vs. fresh

```bash
# Continue the most recent conversation (cheaper than re-sending context):
agy-run "Given your previous review, list only the top three risks." -- --continue

# Resume a specific conversation by id:
agy-run "Continue from the prior architecture critique; focus on test gaps." -- --conversation <id>
```

Use conversation state only when it saves quota or preserves useful context. For auditable decisions,
prefer self-contained prompts.

## Review via `agy-review` (grounded second opinion)

For a code / plan / diff review, drive the dedicated **`agy-review`** wrapper rather than hand-rolling a
prompt for `agy-run`. It **mechanizes the grounded-review contract** (see
[`review-prompt.md`](./review-prompt.md)) so grounding is the enforced default, not a per-call effort:

```bash
agy-review code  [--facts @facts.md] [--decided @decided.md] [--focus "…"] [extra focus…]
agy-review plan  <plan-file> [--facts @f] [--decided @f] [--focus "…"]
agy-review diff  <diff-file> [--facts @f] [--decided @f] [--focus "…"]
agy-review --continue          [--decided @f] [--focus "…"]   # round-2 delta — no re-assembly
agy-review --conversation <id> [--decided @f] [--focus "…"]
```

What it does for you, and what YOU must supply:

- **It** assembles POSTURE + a model/cutoff GUARD + your facts + your already-decided list + your focus
  + the artifact (in `code` mode, the **repo-complete** working-tree change set) + a strict output
  SHAPE, then delegates execution to `agy-run` (so the hard timeout, the subscription invariant, and
  the single-argv byte ceiling apply once).
- **You** supply what a script can't generate: `--facts @file` (the **verified facts** the model must
  review AGAINST — agy reads nothing by default, so without this it guesses), `--decided @file` (the
  **anti-circling** list of things already handled — the round-2 payload), and `--focus`.
- **Anti-circling round 2:** after folding round 1, iterate with `agy-review --continue --decided
  @round1-decisions.md --focus "only the still-open items"`. The continuation sends a small DELTA
  (restated posture + new focus + the output shape + the decided list) and never re-sends the artifact
  — `agy` holds it in the conversation.
- **Oversized `code` review:** the byte ceiling (`AGY_MAX_PROMPT_BYTES`, default 120000) trips with
  trim/split guidance. `AGY_REVIEW_ALLOW_ADDDIR=1` offloads ONLY the change set to a private staging
  dir and passes it via `--add-dir` (the grounding stays inline) — this re-enables the Issue-001 stall
  risk, bounded by the hard timeout; prefer splitting into focused per-area reviews.
- **Model:** frontier default `Gemini 3.1 Pro (High)`; any model is allowed (a sub-frontier one earns a
  silenceable `AGY_PROBE=1` advisory). The service can still **stall on large/substantive prompts**
  (Issue-001) — keep reviews **focused**; the hard timeout is the guard.

## Escalation policy (edits, network, git)

The wrapper passes no `--add-dir`, no `--dangerously-skip-permissions`, and no `--sandbox`. Treat this
as a **policy boundary you enforce in the prompt, not an enforced sandbox** — so prompt `agy` as a
read-only reviewer, and reach for `-- --sandbox` for anything that might trigger terminal/tool work:

```text
Do not edit files. Do not run git write commands. Do not branch, add, commit, stash, reset, or
rewrite history. Return findings and suggested changes only.
```

- **Repo edits** stay with the orchestrator. If a flow truly needs `agy` to write files, opt in
  explicitly — `agy-run "..." -- --add-dir . --dangerously-skip-permissions` — and review the diff.
- **New dependencies / network installs** are done by hand, not by `agy`.
- **Git writes** (branch/commit) are never delegated — the orchestrator commits after review.
- Prefer `-- --sandbox` for any prompt that might trigger terminal work.

## Project-context prompts

Probe **reachability** from a project root (cheap model) — this is the one place `agy` reading its cwd
context file is the point of the prompt:

```bash
AGY_MODEL="Gemini 3.5 Flash (Low)" agy-run \
  "Read the cwd context file and report the dialogue language plus one Hard Constraint."
AGY_MODEL="Gemini 3.5 Flash (Low)" agy-run \
  "Without using a file pointer, is there a project-specific planning skill in this repo? Name it and cite its path."
```

**For an actual review, do NOT hand-roll a prompt that tells `agy` to "use the root context file if
reachable"** — that is the documented root cause of guessing (`agy` cannot reliably read the repo code
or the diff without an explicit `--add-dir`). Use **`agy-review`** (above): it makes the review
**self-contained via `--facts`** plus the assembled artifact, so the review never *depends* on `agy`
reading anything. `agy` may still surface the single cwd context file, but the grounded contract does
not rely on it.

## Handling output

`agy` returns plain text. Do not assume it is complete, current, or machine-valid. Before acting:

- Check claims against local files or primary sources available to the main agent.
- Re-run local tests and linters yourself.
- Reject advice that conflicts with user instructions, repository rules, or security boundaries.
- Summarise uncertainty clearly when reporting back to the user.
