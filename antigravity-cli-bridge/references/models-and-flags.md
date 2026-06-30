# `agy` models & flags (reference)

The source of truth is the live binary: `agy --version`, `agy --help`, `agy models`. The tables below
were captured from **v1.0.13**; if the binary disagrees, the binary wins. The wrapper command is
`agy-run`, backed by `bin/agy.sh`.

## Headless behaviour

Use `-p`, `--print`, or `--prompt` to run one non-interactive prompt and print the text response. The
wrapper always uses headless `-p`. **There is no JSON output mode in v1.0.13** — ask for Markdown,
bullets, tables, or fenced blocks when the caller needs structure, then validate the text yourself.

## Wrapper contract

```bash
agy-run <prompt | - | @file> [-- extra agy flags...]
```

Inputs:

- Prompt text: `agy-run "say OK"`.
- Stdin: `echo "say OK" | agy-run -`.
- Prompt file: `agy-run @prompt.md`.
- Extra `agy` flags after `--`: `agy-run @prompt.md -- --add-dir . --continue`. Extra args **without**
  the `--` separator are rejected with a usage error (they are never silently dropped).
- A literal prompt that **begins with `@`** is read as a file path. Pass such prompts via stdin
  instead: `printf '%s' '@handle, review this' | agy-run -`.

Environment:

| Var | Default | Effect |
|---|---|---|
| `AGY_MODEL` | `Gemini 3.1 Pro (High)` | model display string; set empty (`AGY_MODEL=`) to drop `--model` and let `agy` use `settings.json` |
| `AGY_TIMEOUT` | `5m` | value passed to `--print-timeout` |
| `AGY_HARD_TIMEOUT` | `= AGY_TIMEOUT` | hard `timeout(1)` wall-clock cap (a duration string) |
| `AGY_MAX_PROMPT_BYTES` | `120000` | single-argv byte ceiling. `agy` takes the prompt as ONE `-p` argv; past `MAX_ARG_STRLEN` (~131072) `execve` fails with a cryptic `Argument list too long`. The wrapper measures the resolved `-`/`@file` prompt and fails loud over the ceiling. A huge **literal** `agy-run "<huge>"` fails at the wrapper's own `exec`, so route large prompts via `-`/`@file`. |

Subscription invariant: the wrapper prepends `$HOME/.local/bin` to `PATH` and clears
`ANTIGRAVITY_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_API_KEY` before execution.
Auth comes from the user's cached OAuth token, never from bundled credentials.

## `agy-review` contract (review role)

For a code / plan / diff review, drive **`agy-review`** (backed by `bin/agy-review.sh`) instead of
hand-rolling an `agy-run` prompt. It mechanizes the **grounded-review contract** (see
[`review-prompt.md`](./review-prompt.md)) and delegates execution to `agy-run`, so the timeout, the
subscription invariant, and the byte ceiling all apply once. The playbook is in
[`driving-agy.md`](./driving-agy.md); the surface:

```bash
agy-review code|plan <file>|diff <file> [--facts @f] [--decided @f] [--focus "…"]
agy-review --continue | --conversation <id>   [--decided @f] [--focus "…"]   # round-2 delta
```

| Var | Default | Effect |
|---|---|---|
| `AGY_MODEL` | `Gemini 3.1 Pro (High)` | frontier default; **any** model is allowed — a sub-frontier one earns a silenceable advisory (quality-first, not a gate) |
| `AGY_PROBE` | `0` | `1` silences the off-frontier model advisory (throwaway probe) |
| `AGY_REVIEW_ALLOW_ADDDIR` | `0` | `1` lets an oversized `code` review offload ONLY the change set to a private staging dir via `--add-dir` (the grounding stays inline; re-enables the Issue-001 stall risk — prefer splitting into focused reviews) |
| `AGY_HARD_TIMEOUT` | `30m` | the review's hard cap (longer default than a probe — reviews are slower) |
| `AGY_MAX_PROMPT_BYTES` | `120000` | the same single-argv byte ceiling; oversized → trim/split (or the `--add-dir` escape above) |

`agy-review` is **read-only** and **advisory**: it never edits, commits, or passes a stray `--`
passthrough (it owns the posture). The service can still **stall on large/substantive prompts**
(Issue-001) regardless of `--add-dir`, so keep reviews **focused**; the hard timeout is the guard.

## Models

Pass the **exact display string** from `agy models`, or set `AGY_MODEL`.

| Model string | Practical use |
|---|---|
| `Gemini 3.5 Flash (Low)` | lowest-cost smoke tests and simple rewrites |
| `Gemini 3.5 Flash (Medium)` | cheap probes, fast summaries, context-reachability checks |
| `Gemini 3.5 Flash (High)` | fast review when a little more reasoning effort is useful |
| `Gemini 3.1 Pro (Low)` | cheaper Pro pass for medium reasoning |
| `Gemini 3.1 Pro (High)` | wrapper default; hard reasoning, plan critique, architecture review |
| `Claude Sonnet 4.6 (Thinking)` | cross-vendor reasoning comparison |
| `Claude Opus 4.6 (Thinking)` | expensive deep critique when the user wants another high-end pass |
| `GPT-OSS 120B (Medium)` | open-weights-style comparison / diversity pass |

Examples:

```bash
AGY_MODEL="Gemini 3.5 Flash (Medium)" agy-run "Read AGENTS.md and report one Hard Constraint."
AGY_MODEL="Claude Sonnet 4.6 (Thinking)" AGY_TIMEOUT=10m agy-run @review-prompt.md
```

## Flags (from `agy --help`, v1.0.13)

| Flag | Meaning | Notes |
|---|---|---|
| `-p`, `--print`, `--prompt` | run one headless prompt and print the text response | the wrapper uses `-p` |
| `--print-timeout <dur>` | cap headless wait time | CLI default `5m0s`; wrapper default `5m` via `AGY_TIMEOUT` |
| `--model <string>` | select a model | must match an `agy models` display string exactly |
| `-i`, `--prompt-interactive` | run an initial prompt, then continue interactively | not used by the wrapper |
| `-c`, `--continue` | continue the most recent conversation | pass after the wrapper's `--` |
| `--conversation <id>` | resume a specific conversation by id | use only when the user provides/records the id |
| `--add-dir <dir>` | add a directory to the workspace | repeatable; for explicit extra context |
| `--dangerously-skip-permissions` | auto-approve all tool permissions | avoid by default; use only with explicit user approval |
| `--sandbox` | run with terminal restrictions enabled | prefer when delegating a prompt that might trigger tool/terminal work |
| `--log-file <path>` | override the CLI log-file path | keep logs secret-free and out of committed artifacts |

## Subcommands (v1.0.13)

`changelog`, `help`, `install`, `models`, `plugin` / `plugins`, `update`.

**Not available in v1.0.13:** any JSON output mode, and any `agy inspect`. Output is plain text.

## Project-context flags

`agy` reads context from its current working directory:

```text
.antigravity.md > GEMINI.md > AGENTS.md
.agents/skills/
```

Use `--add-dir` for extra directories not already reachable from cwd. Subdirectory `CLAUDE.md` files
are **not** auto-loaded — include those local rules manually in the prompt when they matter.

This is **reachability only** — `agy` may *surface* the single cwd context file, but it does **not**
read your repo code or a diff without an explicit `--add-dir`. So a **review must be self-contained**:
ground it with `agy-review --facts @file` (above), never by relying on `agy` to read the change set.
