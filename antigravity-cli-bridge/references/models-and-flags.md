# `agy` models & flags (reference)

The source of truth is the live binary: `agy --version`, `agy --help`, `agy models`. The tables below
were captured from **v1.0.10**; if the binary disagrees, the binary wins. The wrapper command is
`agy-run`, backed by `bin/agy.sh`.

## Headless behaviour

Use `-p`, `--print`, or `--prompt` to run one non-interactive prompt and print the text response. The
wrapper always uses headless `-p`. **There is no JSON output mode in v1.0.10** — ask for Markdown,
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

Subscription invariant: the wrapper prepends `$HOME/.local/bin` to `PATH` and clears
`ANTIGRAVITY_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_API_KEY` before execution.
Auth comes from the user's cached OAuth token, never from bundled credentials.

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

## Flags (from `agy --help`, v1.0.10)

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

## Subcommands (v1.0.10)

`changelog`, `help`, `install`, `models`, `plugin` / `plugins`, `update`.

**Not available in v1.0.10:** any JSON output mode, and any `agy inspect`. Output is plain text.

## Project-context flags

`agy` reads context from its current working directory:

```text
.antigravity.md > GEMINI.md > AGENTS.md
.agents/skills/
```

Use `--add-dir` for extra directories not already reachable from cwd. Subdirectory `CLAUDE.md` files
are **not** auto-loaded — include those local rules manually in the prompt when they matter.
