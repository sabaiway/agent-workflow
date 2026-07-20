---
name: codex-cli-bridge
description: Delegate work to the OpenAI Codex CLI (`codex`) under a ChatGPT subscription — run plan/instruction EXECUTION in a sandboxed workspace, or get a read-only ADVISORY review of a plan or working-tree diff — as a second delegated-execution backend beside Antigravity. Use when the user wants to hand a bounded coding task or plan to `codex exec`, get a second-opinion review from codex, install or authenticate Codex CLI, understand its sandbox/network/approval policy, drive codex efficiently from the main agent (exec vs review, resume, the commit boundary), bridge project context (`AGENTS.md`) into codex, or troubleshoot codex flags, models, auth, or its no-TTY headless behaviour.
metadata:
  version: '3.1.0'
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

## Models quality-first pinned

Delegated codex work ALWAYS runs on the **frontier model at maximum reasoning effort**: the wrappers
**pin** `gpt-5.6-sol` / `xhigh` and **refuse** (exit 2, loud) a non-default `CODEX_MODEL` / `CODEX_EFFORT`
— knowingly-worse output is never traded for quota. The pin is deliberate (an explicit `-m gpt-5.6-sol`
guarantees the *strongest* model, not merely the CLI's current default); a release-time gate against
<https://developers.openai.com/codex/models> re-checks that `gpt-5.6-sol` is still the strongest selectable
Codex model. Economy comes only from **quality-neutral waste removal** (clean capture, a hard timeout,
a precomputed review diff, `resume` instead of re-sending context), never from a downgrade.

The ONLY escape is a **throwaway probe** whose result is effort-independent (a reachability / smoke
check): set `CODEX_PROBE=1` (echoed loudly) to relax the model/effort guard. Never use a probe run's
output as real delegated work.

| Variable | Default | Effect |
|---|---|---|
| `CODEX_MODEL` | `gpt-5.6-sol` (pinned) | model passed to `-m`; a non-default is REFUSED unless `CODEX_PROBE=1` |
| `CODEX_EFFORT` | `xhigh` (pinned) | reasoning effort (`-c model_reasoning_effort=…`); non-default REFUSED unless `CODEX_PROBE=1` |

`codex --version` reports the CLI version, **not** the model list. Quota is metered in **messages**
(a rolling 5h window + a weekly cap), not raw tokens — which is why the levers above are about removing
waste, never lowering quality. Full knob list: [§ Environment knobs](#environment-knobs).

## Usage

> **The machine-readable mode catalog lives in [`capability.json`](capability.json) `modeCatalog`** —
> every documented mode with its purpose, when to use it (and when not), the exact invocation form
> with its operand slots, and the guardrails that really apply. The catalog tracks **the documented
> wrapper mode set** (never "the CLI's modes"): an upstream Codex CLI change reaches it through a
> bridge release, where the source-level drift tests fail loudly until the catalog is updated.
> Nothing probes a live CLI. The prose below stays the human tour.

Drive codex only through the two wrappers (installed on `PATH`), run from the target project root:

```bash
# EXECUTION (workspace-write sandbox, network OFF, never prompts):
codex-exec docs/plans/<slug>.md                 # drive a plan file
echo "apply review fix: ..." | codex-exec -      # ad-hoc instruction from stdin
codex-exec <file|-> -- <extra codex flags...>     # GUARDED passthrough after `--` (policy/model/capture flags rejected; some relaxed only under CODEX_PROBE=1)

# RESUME (iterate on the SAME session without re-sending context):
codex-exec --resume-last docs/plans/<slug>.md    # continue the last session (id from the sidecar)
echo "now do step 2 ..." | codex-exec --resume <session-id> -

# REVIEW (read-only sandbox — codex cannot edit anything, only emits findings):
codex-review plan docs/plans/<slug>.md           # critique a plan
codex-review code                                # review the current working-tree diff (precomputed)
codex-review code "focus on the new reducer"     # review with extra focus
```

**Honesty + posture (D4/D5):** a run whose final message has no recognized
`Verdict: <ship|revise|rethink>` line — empty or missing output included — **exits 4 with NO
receipt**: treat it as a *failed review to re-run*, never a fatal session error. One stderr banner
states the actual posture (`review posture: model=… effort=… tier=… timeout=…`) and the receipt
records the same `posture {model, effort, tier}` (tier `null` on the standard tier); control bytes
in a posture value refuse pre-spend in every mode. `codex-exec` states its posture the same way —
ONE `exec posture: model=… effort=… tier=… sandbox=workspace-write session=fresh|resume:<id>
timeout=…` stderr line before dispatch (the resume id validated pre-spend). The `timeout=` field
is **banner-only** (exactly the duration handed to `timeout(1)`, or `uncapped`) — informational,
never a receipt field. **Quote the posture banner verbatim** when labeling a dispatch.

`codex exec` is headless: there is **no TTY**, so `approval_policy=never` — anything needing
escalation is refused and reported, never interactively approved. The wrappers capture only codex's
**final message** (`-o`; the JSON event stream + reasoning go to a discarded trace), so output is
clean; a successful **non-resume** `codex-exec` also records the session id to a sidecar
(`${CODEX_SESSION_FILE:-./.codex-last-session}`) so `--resume-last` can find it. Extra `codex` flags
go after a literal `--`; the wrapper rejects any that would defeat the policy or the pinned model (see
[§ Environment knobs](#environment-knobs) and the flag tiers in
[`references/sandbox-and-flags.md`](references/sandbox-and-flags.md)); args without the separator are
rejected, never silently dropped.

## Environment knobs

All optional; the defaults are the supported path. Anything that would lower quality (model/effort) or
defeat a policy is guarded — see [§ Models](#models-quality-first-pinned).

| Variable | Default | Effect |
|---|---|---|
| `CODEX_MODEL` | `gpt-5.6-sol` (pinned) | model; non-default REFUSED unless `CODEX_PROBE=1` |
| `CODEX_EFFORT` | `xhigh` (pinned) | reasoning effort; non-default REFUSED unless `CODEX_PROBE=1` |
| `CODEX_HARD_TIMEOUT` | `3600` (exec) / `1800` (review) | hard wall-clock cap (seconds) via `timeout`/`gtimeout`; exit 124/137 ⇒ "exceeded hard cap". No `timeout` binary ⇒ loud warning + uncapped (never silent). |
| `CODEX_SERVICE_TIER` | unset (standard tier) | **SPEND knob**: `priority` (catalog name "Fast") = ~1.5× token speed at a **2.5× credit rate** on gpt-5.6-sol — quality-neutral (same model). codex accepts any `-c service_tier` string silently (probe-pinned 2026-07-05), so the wrapper validates: an unsupported value warns and runs standard. Env or settings file. |
| `CODEX_SESSION_FILE` | `./.codex-last-session` | where `codex-exec` records the session id and where `--resume-last` reads it |
| `CODEX_REVIEW_MAX_TOTAL_BYTES` | `1500000` | `codex-review code`: above this the assembled diff goes via a git-dir temp file instead of inline — never truncated |
| `CODEX_REVIEW_SCHEMA` | unset | `codex-review`: `=1` returns findings as a validated JSON object (`--output-schema`), with a raw-text fallback. Default off. |
| `CODEX_PROBE` | unset | `=1` ⇒ throwaway-probe mode: relaxes the model/effort guard AND the tier-2 passthrough guard (echoed loudly). Never for real work. |

The git-write shim, `--ignore-user-config`, and the `*_API_KEY` scrub are NOT env-tunable — they are
fixed invariants.

### Settings file (host-level, survives kit upgrades)

`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf` holds `KEY=VALUE` lines,
**parsed, never sourced** — a file line can never execute code. Precedence: explicit env (even
empty — `KEY=` disables a knob for one run) > file > built-in default. File-settable keys for this
bridge: `CODEX_SERVICE_TIER` (the Fast tier — **2.5× credit rate**; enabling it is a consented
per-host spend decision, never a default), `CODEX_HARD_TIMEOUT`, `CODEX_REVIEW_MAX_TOTAL_BYTES` —
exactly the manifest `settings` block (the single source; the wrapper constants and `--help` are
drift-guarded against it). Model/effort keys are **not** file-settable — the quality guard above
is untouched. The file lives **outside every kit-managed tree**, so a kit refresh/upgrade can
never wipe it; edit it by hand or via `/agent-workflow-kit bridge-settings` (preview-first,
consent-gated).

## Project context (how `codex` sees the repo)

`codex` auto-**merges** `AGENTS.md` (root→cwd, plus a global `~/.codex/AGENTS.md`) straight into its
developer context, truncated at `project_doc_max_bytes` (default 32 KiB) — so when you run a wrapper
from a project root, the project's Hard Constraints are already in front of the model with no wiring (a
probe confirmed codex returned a repo's declared dialogue language from `AGENTS.md`). The wrappers
therefore **hardcode no project rules**, and the orchestrator contract is **lean**: it tells codex to
*obey* the already-merged `AGENTS.md` Hard Constraints + declared gates — it does NOT waste a step
telling codex to go *read* a file that is already in context.

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
  (branch/add/commit/stash/reset/checkout/tag/rewrite), and `codex-exec` additionally enforces it with
  a physical **git-write shim** on the codex subprocess's `PATH`: read-only git verbs pass through,
  every write/unknown verb is blocked (codex spawns `git` via `execve`, which bypasses shell
  functions — so the boundary must be a real file). You review codex's diff, then commit yourself.
- **Treat output as advisory** and verify before acting — re-run the project's gates yourself, reject
  advice that conflicts with user instructions or repo rules.
- **Hand codex a self-contained task.** It cannot see your conversation — for an ad-hoc instruction,
  embed the goal, the relevant paths, and the expected result; codex reads `AGENTS.md` for the rules.
- **Iterate with `codex-exec --resume-last` / `--resume <id>`** instead of re-sending context. The
  resume entrypoint re-establishes EVERY wrapper invariant (subscription-only, `--ignore-user-config`,
  the pinned model/effort) and **restates the full posture via `-c`** — `codex exec resume` resets the
  sandbox/approval/network posture and rejects the `-s`/`--add-dir`/`-C` posture flags, so the wrapper
  sets `sandbox_mode=workspace-write` + `approval_policy=never` +
  `sandbox_workspace_write.network_access=false` explicitly. It reads the session id from the sidecar
  (`--resume-last`) or takes it as an argument.
- **Network is OFF in exec.** New dependencies and any network step are installed by hand, then codex
  is re-dispatched.
- **`codex-review code` precomputes the diff.** The wrapper assembles the change set (repo map, status,
  staged + unstaged diff, untracked file contents) and feeds it in, so codex does not roam the
  filesystem rediscovering it; a clean tree exits 0 before a run is spent. Native `codex review` is
  deliberately NOT used — it rejects `--ignore-user-config` and would load a personal config.toml,
  breaking the subscription/config-isolation invariant.

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
- **`resume` resets the posture** — `codex exec resume` rejects `-s`/`--add-dir`/`-C` and forgets the
  original sandbox/approval/network policy. The `codex-exec --resume`/`--resume-last` entrypoint
  restates it via `-c`; only a *raw* `codex exec resume` (bypassing the wrapper) loses the posture.
- **Hard timeout** — a hung run is killed at `CODEX_HARD_TIMEOUT` (exec 3600s / review 1800s) and
  reported (exit 124/137); raise it for a known-healthy slow run. If neither `timeout` nor `gtimeout`
  is on `PATH` the wrapper warns loudly and runs uncapped (never silently).
- **Native `codex review` is out of scope** — it rejects `--ignore-user-config` (would load a personal
  `config.toml` and break the subscription/config-isolation invariant) and can't be cleanly captured;
  `codex-review` runs `codex exec` over a precomputed diff instead.
- **bubblewrap** — on Linux, if `bubblewrap` is not on `PATH` codex prints a warning and uses a
  bundled copy; install it via your package manager to silence the warning.
- codex output is advisory and may be incomplete or out of date — the main agent verifies before
  acting.
