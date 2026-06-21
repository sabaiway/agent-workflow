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

Probe reachability from a project root (cheap model):

```bash
AGY_MODEL="Gemini 3.5 Flash (Low)" agy-run \
  "Read the cwd context file and report the dialogue language plus one Hard Constraint."
AGY_MODEL="Gemini 3.5 Flash (Low)" agy-run \
  "Without using a file pointer, is there a project-specific planning skill in this repo? Name it and cite its path."
```

Plan-review prompt shape:

```text
You are reviewing the plan below from the current repository root.
Use the root context file and per-workspace skills if they are reachable.
Do not edit files. Do not run git write commands.
Return: 1) blocking issues  2) non-blocking risks  3) missing verification  4) a concise recommendation.
The implementation plan text follows in this same prompt.
```

Diff/code-review prompt shape (provide the diff as text):

```text
Review this diff against the stated constraints.
Focus on bugs, behavioural regressions, missing tests, and violations of the project rules.
Cite file paths and line hints from the diff where possible. Do not summarise unless there are no findings.
The project constraints and diff text follow in this same prompt.
```

## Handling output

`agy` returns plain text. Do not assume it is complete, current, or machine-valid. Before acting:

- Check claims against local files or primary sources available to the main agent.
- Re-run local tests and linters yourself.
- Reject advice that conflicts with user instructions, repository rules, or security boundaries.
- Summarise uncertainty clearly when reporting back to the user.
