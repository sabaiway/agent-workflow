---
name: antigravity-cli-bridge
description: Delegate work to Google's Antigravity CLI (`agy`) — the successor to Gemini CLI — to reach Gemini, Claude, and GPT-OSS models under a Google AI Pro/Ultra subscription from the terminal. Use when the user wants to run a headless `agy` prompt, hand a focused task or second-opinion review to `agy`, install or authenticate Antigravity CLI, check or economise its quota/models, bridge project context into `agy`, set up a second delegated-execution backend beside Codex, or troubleshoot `agy` flags, models, auth, conversations, or its no-JSON headless behaviour.
metadata:
  version: '2.6.0'
---

# antigravity-cli-bridge

Bridges the main agent to **Antigravity CLI** (`agy`), Google's successor to Gemini CLI. As of
2026-06-18 the old Gemini CLI stopped serving Google AI Pro / Ultra / free tiers; terminal access to
Google's models moved to `agy`. This is a **delegated-execution backend** beside Codex: the main
agent stays the orchestrator — owning decisions, edits, verification, and user-facing claims — and
hands `agy` a bounded, self-contained sub-task answered from the **subscription** quota (no
pay-as-you-go billing). `agy` reaches Gemini, Claude, and GPT-OSS through one subscription, so it
serves as both a cheap probe engine (Flash) and a strong second opinion (Pro / Claude Thinking).

## Overview / when to use

Use this skill when the user wants to:

- Delegate a focused prompt to `agy` in headless mode.
- Use Gemini, Claude, or GPT-OSS access available through a Google AI Pro/Ultra subscription.
- Ask a second model to review a plan, summarise project context, or critique a diff supplied in the
  prompt.
- Install, authenticate, smoke-test, or troubleshoot `agy`, or understand its models/flags/quota.

Do **not** use it to bundle secrets, bypass subscription auth, or hand uncontrolled repository
mutations to `agy`.

## Install

Clean-machine setup is in [`setup/README.md`](setup/README.md). In short: the binary is **`agy`**
(not `antigravity`), installs to `~/.local/bin/agy`, and must be on `PATH`; expose this skill's
wrapper [`bin/agy.sh`](bin/agy.sh) on `PATH` as `agy-run`.

## Auth — subscription only (invariant)

`agy` authenticates with a cached **OAuth token** from a **Google AI Pro/Ultra** sign-in:

```text
~/.gemini/antigravity-cli/antigravity-oauth-token
```

Never read, print, copy, commit, or package that token — it is personal and is **never bundled** with
this skill. The wrapper [`bin/agy.sh`](bin/agy.sh) **unsets every `*_API_KEY`** (`ANTIGRAVITY_API_KEY`,
`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY`) before invoking `agy`, so a stray key can
never silently switch you to pay-as-you-go billing.

**Caveat:** the subscription has a finite quota. Prefer the cheapest model that fits the task, and
keep probes short (see *How the main agent drives agy*).

## Models

Pass the **exact display string** to `--model` (or set `AGY_MODEL`). The wrapper defaults to
`Gemini 3.1 Pro (High)`. Run `agy models` for the live list — if it differs from this table, the live
list wins.

| Model string | Use it for |
|---|---|
| `Gemini 3.5 Flash (Low)` | cheapest; reachability checks, smoke tests, simple transforms |
| `Gemini 3.5 Flash (Medium)` | cheap probes, context-reachability checks, quick summaries |
| `Gemini 3.5 Flash (High)` | fast drafting / review when a little more effort helps |
| `Gemini 3.1 Pro (Low)` | cheaper Pro pass for medium reasoning |
| `Gemini 3.1 Pro (High)` | wrapper default; hard reasoning, plan critique, architecture review |
| `Claude Sonnet 4.6 (Thinking)` | a Claude second opinion through the same subscription |
| `Claude Opus 4.6 (Thinking)` | strongest Claude reasoning available via `agy` |
| `GPT-OSS 120B (Medium)` | an open-weights cross-check / diversity pass |

## Usage

Drive `agy` only through the wrapper [`bin/agy.sh`](bin/agy.sh) (installed on `PATH` as `agy-run`):

```bash
agy-run "your prompt"                         # prompt as an argument
echo "your prompt" | agy-run -                # prompt from stdin
agy-run @path/to/prompt.md                    # prompt from a file
AGY_MODEL="Claude Opus 4.6 (Thinking)" agy-run "..."   # pick a model
AGY_TIMEOUT=10m agy-run "..."                 # agy's soft --print-timeout
AGY_HARD_TIMEOUT=8m agy-run "..."             # hard wall-clock cap via timeout(1)
agy-run "..." -- --add-dir . --dangerously-skip-permissions   # passthrough agy flags
```

`agy` is **headless-only** here (`-p`/`--print`) and there is **no JSON output mode** in v1.0.13 — you
get plain text. If you need structure, ask for Markdown with explicit headings and validate it
yourself. Wrapper inputs: first argument is the prompt (`text`, `-` for stdin, or `@file`);
`AGY_MODEL` (default `Gemini 3.1 Pro (High)`); `AGY_TIMEOUT` → `--print-timeout` (default `5m`);
`AGY_HARD_TIMEOUT` → hard `timeout(1)` wall-clock cap (default = `AGY_TIMEOUT`); extra `agy` flags
after `--`. Full detail: [`references/models-and-flags.md`](references/models-and-flags.md).

## Settings file (host-level, survives kit upgrades)

`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf` holds `KEY=VALUE` lines,
**parsed, never sourced** — a file line can never execute code. Precedence: explicit env (even
empty — `KEY=` disables a knob for one run) > file > built-in default. File-settable keys for this
bridge: `AGY_HARD_TIMEOUT` (duration string, e.g. `5m`/`30m`) and `AGY_REVIEW_ALLOW_ADDDIR`
(`0`/`1`; arming the oversized `--add-dir` escape re-enables the Issue-001 stall risk — the hard
timeout bounds it) — exactly the manifest `settings` block (the single source; the wrapper
constants and `--help` are drift-guarded against it). Model keys are **not** file-settable. The
file lives **outside every kit-managed tree**, so a kit refresh/upgrade can never wipe it; edit it
by hand or via `/agent-workflow-kit bridge-settings` (preview-first, consent-gated).

## Review mode (`agy-review`)

For a **code / plan / diff review**, drive the dedicated **`agy-review`** wrapper
([`bin/agy-review.sh`](bin/agy-review.sh)) — the `review` role — instead of hand-rolling an `agy-run`
prompt. Because `agy` reads nothing by default and its training predates your codebase, an *ungrounded*
review **guesses** (stale-model and partial-diff false positives). `agy-review` mechanizes the
**grounded contract** (see [`references/review-prompt.md`](references/review-prompt.md)): it assembles
POSTURE + a **model/cutoff GUARD** + your **`--facts`** (the verified facts the model reviews AGAINST)
+ **`--decided`** (the anti-circling list) + **`--focus`** + the artifact + a strict output shape, then
delegates execution to `agy-run` (one home for the timeout, the subscription invariant, and the byte
ceiling).

```bash
agy-review code [--facts @facts.md] [--decided @decided.md] [--focus "…"]   # the repo-complete diff
agy-review plan <plan-file> [--facts @f] …      # critique a plan
agy-review diff <diff-file> [--facts @f] …      # review a supplied diff
agy-review --continue --decided @round1.md --focus "still-open items"   # round-2 delta, no re-assembly
```

Frontier default `Gemini 3.1 Pro (High)`; **any** model is allowed (a sub-frontier one earns a
silenceable `AGY_PROBE=1` advisory). An oversized `code` review trips the byte ceiling with trim/split
guidance; `AGY_REVIEW_ALLOW_ADDDIR=1` offloads only the change set to a private `--add-dir` staging dir
(grounding stays inline). The service can still **stall on large/substantive prompts** (Issue-001) — keep
reviews **focused**; the inherited hard timeout is the guard. Full playbook:
[`references/driving-agy.md`](references/driving-agy.md).

## Project context (how `agy` sees the repo)

From its **current working directory** `agy` reads one root context file by priority, plus
per-workspace skills:

```text
.antigravity.md > GEMINI.md > AGENTS.md
.agents/skills/
```

So when you run `agy-run` from a project root, `agy` loads the **highest-priority context file that
exists** — in most repos that is `AGENTS.md`, so its Hard Constraints are available — plus the
project's `.agents/skills/`, with no wiring needed. **A `.antigravity.md` or `GEMINI.md`, if present,
shadows `AGENTS.md`** (only the winning file is read), so put cross-cutting rules in whichever file
wins, or include them in the prompt. Probe results in a real repo confirmed `agy` read the root
`AGENTS.md` (returning the dialogue language + a Hard Constraint) and cited
`.agents/skills/<skill>/SKILL.md` by path.

**Honest scope:** these probes prove *reachability* — `agy` surfaces the cwd context file and
per-workspace skills by directory scan. In testing it also **named a project-specific skill without
being pointed at any file** (auto-discovery), but that is `agy`'s own mechanism, not a guaranteed
Claude-style description-dispatch engine; don't promise more than the probe shows in a given repo.
**A review, though, must never *depend* on this** — `agy` does not read your repo code or a diff
without an explicit `--add-dir`, so ground a review **self-contained** via `agy-review --facts` (above)
rather than relying on `agy` to read the change set. Re-runnable from a project root (use a cheap model):

```bash
AGY_MODEL="Gemini 3.5 Flash (Low)" agy-run \
  "Read the cwd context file and state the dialogue language plus one Hard Constraint, in two lines."
AGY_MODEL="Gemini 3.5 Flash (Low)" agy-run \
  "Without me pointing you at any file, name a project-specific skill under .agents/skills/ here and cite its path."
```

## How the main agent drives `agy` efficiently

See [`references/driving-agy.md`](references/driving-agy.md) for the full playbook (delegation
checklist, prompt templates, output handling). Essentials:

- **Pick the cheapest model that fits.** Flash (Low/Medium) for reachability/probes; Pro (High) for
  reasoning; `Claude Sonnet 4.6 (Thinking)`, `Claude Opus 4.6 (Thinking)`, or `GPT-OSS 120B (Medium)`
  for a different engine's opinion (exact strings — see the Models table) — all on the same
  subscription. Quota is finite, so don't reach for Pro by reflex.
- **Hand `agy` a self-contained prompt.** It cannot see your conversation — embed the goal,
  constraints, relevant excerpts, and the expected output shape; nothing more.
- **Continue a thread** with `-- --continue` (most recent) or `-- --conversation <id>` (by id) instead
  of re-sending context.
- **Treat output as advisory** and verify before acting — check claims against local files, re-run
  tests/linters yourself, reject advice that conflicts with user instructions or repo rules.
- **Escalations are done by hand, not by `agy`.** The wrapper passes no `--add-dir`, no
  `--dangerously-skip-permissions`, and no `--sandbox` — but that is a **policy boundary you state in
  the prompt, not an enforced sandbox**. Keep repo edits, new dependencies/network installs, and git
  writes (branch/add/commit/stash/reset/rewrite) with the orchestrator, and tell `agy` in the prompt
  to return findings only. Add `-- --sandbox` when delegating anything that could trigger
  terminal/tool work; opt into `-- --add-dir . --dangerously-skip-permissions` only for a flow that
  genuinely needs writes, then review the diff afterwards.

## Complementary skills (optional, standalone-first)

`agy-run` works in any directory where `agy` is installed and authenticated. The two skills below are
**not required** to use `agy` — surface them only when they actually help.

- **`agent-workflow-memory`** (family **context provider**) — if the current project has **no**
  `AGENTS.md` + `docs/ai/`, `agy` has no per-workspace context to read. The memory substrate creates
  it. Soft-recommend it (only when the user wants the memory workflow):
  `npx @sabaiway/agent-workflow-memory@latest init`, then `/agent-workflow-memory` in the project — or
  bootstrap the whole family via the **`agent-workflow-kit`** orchestrator
  (`npx @sabaiway/agent-workflow-kit@latest init`), which delegates substrate deployment to memory. Never a
  prerequisite for using `agy`.
- **`codex-cli-bridge`** (sibling backend, OpenAI Codex) — recommend **by actual presence**: if
  `~/.claude/skills/codex-cli-bridge/` exists you have a **second delegated engine** (Codex for
  sandboxed repo edits with gates; `agy` for subscription-quota Gemini/Claude reasoning). If it is
  **not** installed, treat it as a **planned sibling** — don't assume it exists.

## Known limitations

- Subdirectory `CLAUDE.md` files are **not** auto-loaded by `agy` (only the cwd context file +
  `.agents/skills/`). Put cross-cutting rules in the root context file, or include local rules in the
  prompt when they matter.
- **No JSON output** and **no `agy inspect`** in v1.0.13 — parse text; there is no machine-readable
  introspection.
- Model names must match the `agy models` display strings **exactly**.
- **Quota is finite.** Heavy use of Pro/Claude models can exhaust the subscription; prefer Flash for
  cheap work.
- **A run can't hang forever.** The wrapper caps `agy` with `timeout(1)` (`AGY_HARD_TIMEOUT`,
  default = `AGY_TIMEOUT`) because `agy`'s own `--print-timeout` is **not** a reliable wall-clock
  kill (a run was seen surviving 32 min past a 10m `--print-timeout`). A heavy `--add-dir` agentic
  prompt on the slowest model (`Gemini 3.1 Pro (High)`) can run unbounded — prefer a faster model or
  a **self-contained prompt** (no `--add-dir`); an "exceeded the hard cap" error is the guard firing.
- `agy` output is plain text and may be incomplete or out of date — treat it as advisory until the
  main agent verifies it.
