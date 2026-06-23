---
name: codex-cli-bridge
description: Delegate work to the OpenAI Codex CLI (`codex`) under a ChatGPT subscription — run plan/instruction EXECUTION in a sandboxed workspace, or get a read-only ADVISORY review of a plan or working-tree diff — as a second delegated-execution backend beside Antigravity. Use when the user wants to hand a bounded coding task or plan to `codex exec`, get a second-opinion review from codex, install or authenticate Codex CLI, understand its sandbox/network/approval policy, drive codex efficiently from the main agent (exec vs review, resume, the commit boundary), bridge project context (`AGENTS.md`) into codex, or troubleshoot codex flags, models, auth, or its no-TTY headless behaviour.
metadata:
  version: '1.0.0'
---

# codex-cli-bridge

Bridges the main agent to the **OpenAI Codex CLI** (`codex`) as a **delegated-execution backend**
beside Antigravity. The main agent stays the orchestrator — owning decisions, the edits it accepts,
verification, and user-facing claims — and hands `codex` a bounded sub-task answered from a **ChatGPT
subscription** (no pay-as-you-go billing). Codex has two roles here: a **sandboxed executor** that
edits a repo under a fixed policy (`codex-exec`), and a **read-only reviewer** that critiques a plan
or a working-tree diff and only emits findings (`codex-review`).

## Overview / when to use

Use this skill when the user wants to:

- Delegate plan or instruction EXECUTION to `codex` in a workspace-write sandbox (network OFF).
- Get a second-opinion ADVISORY review of an implementation plan or the current diff.
- Install, authenticate, smoke-test, or troubleshoot `codex`, or understand its sandbox/flags/models.
- Drive codex efficiently from the main agent (exec vs review, `resume`, the commit boundary).

Do **not** use it to bundle secrets, bypass subscription auth, use api-key billing, or let codex
commit / push on its own.

## Install

Clean-machine setup is in [`setup/README.md`](setup/README.md). In short: install the `codex`
binary, run `codex login` once under a ChatGPT subscription, then expose this skill's two wrappers on
`PATH` as `codex-exec` ([`bin/codex-exec.sh`](bin/codex-exec.sh)) and `codex-review`
([`bin/codex-review.sh`](bin/codex-review.sh)).

## Auth — subscription only (invariant)

`codex` authenticates with the cached **ChatGPT login** under `CODEX_HOME` (`~/.codex`). Never read,
print, copy, commit, or package `~/.codex/auth.json` — it is personal and is **never bundled** with
this skill. Both wrappers enforce the subscription path before invoking codex:

- they **unset every `*_API_KEY`** (plus `OPENAI_API_KEY` / `CODEX_API_KEY` / `OPENAI_BASE_URL`) so a
  stray key can never silently switch you to paid api-key billing;
- they pass **`--ignore-user-config`** so a personal `~/.codex/config.toml` cannot change model,
  sandbox, or approval behaviour (auth still works — codex reads the login from `CODEX_HOME`
  regardless of that flag);
- they **preflight `codex login status`** and refuse to run unless it reports `Logged in using ChatGPT`.

## Models

The wrappers default to `gpt-5.5` at reasoning effort `xhigh` (the strongest setting verified in this
environment), both overridable per call. `codex --version` reports the CLI version, **not** the model
list — check your Codex CLI / ChatGPT account for the model slugs available to you, or let a wrong
`-m` surface the error.

| Variable | Default | Effect |
|---|---|---|
| `CODEX_MODEL` | `gpt-5.5` | model passed to `-m` |
| `CODEX_EFFORT` | `xhigh` | reasoning effort passed to `-c model_reasoning_effort=…` |

```bash
CODEX_MODEL=<slug> CODEX_EFFORT=<low|medium|high|xhigh> codex-exec <file>
```

## Usage

Drive codex only through the two wrappers (installed on `PATH`), run from the target project root:

```bash
# EXECUTION (workspace-write sandbox, network OFF, never prompts):
codex-exec docs/plans/<slug>.md                 # drive a plan file
echo "apply review fix: ..." | codex-exec -      # ad-hoc instruction from stdin
CODEX_MODEL=<slug> codex-exec <file>             # override the model
codex-exec <file|-> -- <extra codex flags...>    # passthrough codex flags after `--`

# REVIEW (read-only sandbox — codex cannot edit anything, only emits findings):
codex-review plan docs/plans/<slug>.md           # critique a plan
codex-review code                                # review the current working-tree diff
codex-review code "focus on the new reducer"     # review with extra focus
```

`codex exec` is headless: there is **no TTY**, so `approval_policy=never` — anything needing
escalation is refused and reported, never interactively approved. Extra `codex` flags go after a
literal `--`; args without the separator are rejected (never silently dropped). Full flag/policy
detail: [`references/sandbox-and-flags.md`](references/sandbox-and-flags.md).

## Project context (how `codex` sees the repo)

From its **current working directory** `codex` auto-reads the root **`AGENTS.md`** — so when you run a
wrapper from a project root, the project's Hard Constraints are available to codex with no wiring (a
probe confirmed codex returned a repo's declared dialogue language from `AGENTS.md`). The wrappers
therefore **hardcode no project rules**: the orchestrator contract tells codex to read the target
`AGENTS.md` and obey it.

**Fallback is strict.** Both wrappers preflight that they run inside a git work tree and that a root
`AGENTS.md` exists — if either is missing they **STOP and report** (a wasted subscription run is
avoided). And the execution contract tells codex: if the project declares **no** verification/gate
set, **STOP and report** rather than invent checks. Pass `--skip-git-repo-check` to codex only when
you truly mean it.

## How the main agent drives `codex` efficiently

See [`references/driving-codex.md`](references/driving-codex.md) for the full playbook. Essentials:

- **`codex-exec` for doing, `codex-review` for judging.** Use exec to implement a plan/fix under the
  sandbox; use review to get advisory findings on a plan or diff without any edits.
- **The orchestrator commits — codex never does.** The execution contract forbids every git write
  (branch/add/commit/stash/reset/checkout/tag/rewrite); you review codex's diff, then commit yourself.
- **Treat output as advisory** and verify before acting — re-run the project's gates yourself, reject
  advice that conflicts with user instructions or repo rules.
- **Hand codex a self-contained task.** It cannot see your conversation — for an ad-hoc instruction,
  embed the goal, the relevant paths, and the expected result; codex reads `AGENTS.md` for the rules.
- **Re-dispatch with `codex exec resume`** (run codex directly — the wrapper's flag/stdin shape can't
  host the `resume` subcommand) instead of re-sending context. **Caveat:** resume runs outside the
  wrapper and may not re-accept `--sandbox` / policy flags — restate the policy, or start a fresh
  `codex-exec` run when a guaranteed sandbox/network posture matters.
- **Network is OFF in exec.** New dependencies and any network step are installed by hand, then codex
  is re-dispatched.

## Complementary skills (optional, standalone-first)

The wrappers work in any git repo where `codex` is installed and authenticated. The skills below are
**not required** — surface them only when they actually help.

- **`antigravity-cli-bridge`** (sibling backend, Google `agy`) — recommend **by actual presence**: if
  `~/.claude/skills/antigravity-cli-bridge/` exists you have a **second delegated engine** (codex for
  sandboxed repo edits with gates; `agy` for subscription-quota Gemini/Claude/GPT-OSS reasoning). If
  it is **not** installed, treat it as a planned sibling — don't assume it exists.
- **`agent-workflow-memory`** (family **context provider**) — if the target project has **no**
  `AGENTS.md` + `docs/ai/`, codex has no root context to read (and the wrappers' preflight will
  STOP). The memory substrate is what creates that context. Soft-recommend it (only when the user
  wants the memory workflow): `npx @sabaiway/agent-workflow-memory@latest init`, or bootstrap the whole
  family via the **`agent-workflow-kit`** orchestrator (`npx @sabaiway/agent-workflow-kit@latest init`),
  which delegates substrate deployment to memory and injects the workflow methodology. Never a
  prerequisite.

## Known limitations

- **Network is OFF** in `codex-exec` (`sandbox_workspace_write.network_access=false`): codex cannot
  install dependencies or reach the network — do that by hand, then re-dispatch.
- **No live approvals** — `codex exec` has no TTY, so `approval_policy=never`; an action that would
  need escalation is reported, not approved interactively.
- **`resume` may drop sandbox/policy flags** — restate the policy or start a fresh run when the
  posture matters (see the driving reference).
- **bubblewrap** — on Linux, if `bubblewrap` is not on `PATH` codex prints a warning and uses a
  bundled copy; install it via your package manager to silence the warning.
- codex output is advisory and may be incomplete or out of date — the main agent verifies before
  acting.
