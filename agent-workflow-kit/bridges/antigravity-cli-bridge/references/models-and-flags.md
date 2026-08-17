# `agy` models & flags (reference)

The source of truth is the live binary: `agy --version`, `agy --help`, `agy models`. The tables below
were captured from **v1.1.13**; if the binary disagrees, the binary wins. The wrapper command is
`agy-run`, backed by `bin/agy.sh`.

## Headless behaviour

Use `-p`, `--print`, or `--prompt` to run one non-interactive prompt and print the text response.
Both wrappers run headless `-p`, and they differ in **transport**:

- **`agy-run` stays text.** It prints the CLI's text response unchanged. JSON can ride passthrough
  (`agy-run "…" -- --output-format json`) with NO parsing or validation — if you need structure here,
  ask for Markdown, bullets, tables or fenced blocks and validate the text yourself.
- **`agy-review` drives every dispatch in `--output-format json`** and reads the returned envelope
  (`bin/agy-envelope.mjs`), so the answer TEXT and the conversation id come from **named fields**
  instead of a guess at raw stdout. The **review contract stays prose-shaped**: the verdict is still
  parsed out of that text's `### Verdict` section, exactly as before. It also passes
  `--disable-slash-commands`, so a delivered change-set line that begins with a slash command stays
  BODY rather than being expanded by the CLI. **On a zero exit** what it PRINTS is the review text,
  never JSON — the envelope is wire format, not output format. When the **single dispatch or the
  FINAL fed turn** exits non-zero the captured stdout is published as-is (the CLI's own failure wins,
  and the envelope is parsed only on a zero exit), so a failing run may print a JSON or partial
  payload. An **intermediate** feed turn is the exception: its output stays private and its failure
  prints only a named error.

`--json-schema` is **not** adopted and was measured and rejected; see the flags table below.

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
| `AGY_MODEL` | `Gemini 3.7 Flash (High)` | model display string; set empty (`AGY_MODEL=`) to drop `--model` and let `agy` use `settings.json` |
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
agy-review code --facts @f [--decided @f] [--focus "…"]   # facts REQUIRED — refuses pre-spend (escapes: --ungrounded, AGY_PROBE=1)
agy-review plan <file>|diff <file> [--facts @f] [--decided @f] [--focus "…"]
agy-review --continue | --conversation <id>   [--decided @f] [--focus "…"]   # round-2 delta
```

| Var | Default | Effect |
|---|---|---|
| `AGY_MODEL` | `Gemini 3.7 Flash (High)` | frontier default (fork (a), 2026-08-14); **any** model is allowed — a sub-frontier one earns a silenceable advisory (quality-first, not a gate) |
| `AGY_PROBE` | `0` | `1` silences the off-frontier model advisory AND lets `code` run without `--facts` (an ungrounded probe never attests — its receipt is probe-marked) |
| `AGY_REVIEW_MAX_TOTAL_BYTES` | `240000` | the ceiling on the SUM of all outgoing prompt bytes an oversized `code` review's chunked feed may send; checked BEFORE the first turn is spent |
| `AGY_REVIEW_ALLOW_ADDDIR` | `0` | **RETIRED** — recognized so an existing settings line never warns as unknown, but it arms nothing. An oversized `code` review is a chunked feed with a per-part delivery proof; the `--add-dir` offload it armed could not be verified (headless `agy` auto-denies `read_file`) |
| `AGY_HARD_TIMEOUT` | `30m` | the review's hard cap (longer default than a probe — reviews are slower) |
| `AGY_MAX_PROMPT_BYTES` | `120000` | the same single-argv byte ceiling; oversized `code` is DELIVERED as a chunked feed (see above), oversized `plan`/`diff` refuses with trim/split guidance |

`agy-review` is **read-only** and **advisory**: it never edits, commits, or passes a stray `--`
passthrough (it owns the posture). The service can still **stall on large/substantive prompts**
(Issue-001), so keep reviews **focused**; the hard timeout is the guard.

**Host requirements, enforced BEFORE any run is spent.** Because the review reads agy's JSON
envelope in node, `agy-review` needs **Node ≥ 22** on `PATH`; and because it passes flags the CLI
must honour, it probes `agy --help` for **`--output-format`** and **`--disable-slash-commands`**
first. A missing flag, an unreadable `agy --help`, a missing or too-old node, or a missing
`bin/agy-envelope.mjs` each refuse with a named cause and spend nothing. This is a **capability
probe, not a version floor** — the release that introduced `--output-format` is not measurable from
one installed build, so a guessed floor would refuse working installs. A failed probe is never read
as "capability present".

## Models

Pass the **exact display string** from `agy models`, or set `AGY_MODEL`.

| Model string | Practical use |
|---|---|
| `Gemini 3.7 Flash (Low)` | lowest-cost smoke tests, cheap probes, simple rewrites (newest Flash) |
| `Gemini 3.7 Flash (Medium)` | fast summaries, context-reachability checks |
| `Gemini 3.7 Flash (High)` | wrapper + review default — asserted frontier-grade (fork (a)) |
| `Gemini 3.6 Flash (Low)` | previous Flash generation, still served — prefer 3.7 |
| `Gemini 3.6 Flash (Medium)` | previous Flash generation, still served — prefer 3.7 |
| `Gemini 3.6 Flash (High)` | previous Flash generation, still served — prefer 3.7 |
| `Gemini 3.5 Flash (Low)` | older Flash generation, still served — prefer 3.7 |
| `Gemini 3.5 Flash (Medium)` | older Flash generation, still served — prefer 3.7 |
| `Gemini 3.5 Flash (High)` | older Flash generation, still served — prefer 3.7 |
| `Gemini 3.1 Pro (Low)` | cheaper Pro pass for medium reasoning |
| `Gemini 3.1 Pro (High)` | hard reasoning, plan critique, architecture review (slower, deeper) |
| `Claude Sonnet 4.6 (Thinking)` | cross-vendor reasoning comparison |
| `Claude Opus 4.6 (Thinking)` | expensive deep critique when the user wants another high-end pass |
| `GPT-OSS 120B (Medium)` | open-weights-style comparison / diversity pass |

Examples:

```bash
AGY_MODEL="Gemini 3.7 Flash (Low)" agy-run "Read AGENTS.md and report one Hard Constraint."
AGY_MODEL="Claude Sonnet 4.6 (Thinking)" AGY_TIMEOUT=10m agy-run @review-prompt.md
```

## Flags (from `agy --help`, v1.1.13)

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
| `--output-format <fmt>` | print-mode output: `text` (default), `json`, `stream-json` | **ADOPTED by `agy-review`** — every dispatch runs `json` and the envelope is parsed (`bin/agy-envelope.mjs`). `agy-run` stays `text`; JSON there rides passthrough, unparsed. `stream-json` is adopted by neither (see below) |
| `--json-schema <s\|path>` | enforce structured output (stream-json final result) | **REJECTED, and the reason is a measurement.** It is not a constrained decode: the model answers in prose and the CLI then spends a **second turn** asking it to restate that answer in schema shape (`num_turns: 2`). Matched control — same prompt, same model, schema off vs on: **16,585 vs 33,446 total tokens**. So a schema does not remove prose parsing; it replaces a free, deterministic, anchored regex with a billed non-deterministic re-read (the structured `reason` came back reworded, not quoted) and adds a failure mode — a run dying between the two turns has prose but no `structured_output` |
| `--effort <low\|medium\|high>` | reasoning effort for the session | NEW in 1.1.x; the display strings already carry an effort tier — the wrapper keeps model selection in ONE place (`AGY_MODEL`) |
| `--mode <m>` | agent execution mode (`accept-edits`, `plan`) | NEW in 1.1.x; not used by the wrapper |
| `--agent` / `--project <id>` / `--new-project` | agent + project selection for the session | NEW in 1.1.x; not used by the wrapper |
| `--disable-slash-commands` | disable slash command/skill expansion in print mode | **ADOPTED by `agy-review`** on every dispatch — a delivered change-set line beginning with a slash command stays BODY instead of being expanded, so the model reviews the delivered bytes. Not used by `agy-run` |

## Subcommands (v1.1.13)

`agent` / `agents`, `changelog`, `help`, `install`, `models`, `plugin` / `plugins`, `update`.

**Still not available in v1.1.13:** any `agy inspect`. On output format the two wrappers differ:
`agy-run` is a **text-by-default passthrough** — it hands back the CLI's stdout unchanged, so
`agy-run "…" -- --output-format json` really does print JSON; `agy-review` prints the review text it
read out of the JSON envelope on a **successful** run. (When its single dispatch or FINAL fed turn
exits non-zero, `agy-review` publishes that captured stdout unchanged — never an intermediate feed
turn's; see the transport bullet above.)

**`--output-format stream-json` is deliberately NOT adopted.** Its two measured gains are queued as
follow-ups rather than built: its `init` event names the **resolved** model (neither the plain `json`
envelope nor the stream's own `result` event carries one), which would let the receipt record what
actually ran; and its live `step_update` events would make a stalled run visible (Issue-001). The
seam built here makes the FLAG easy to switch, but neither gain is free: `bin/agy-envelope.mjs`
parses ONE JSON object and refuses anything else, so NDJSON needs a stream-aware reader, and live
progress needs an event relay rather than a captured file.

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
