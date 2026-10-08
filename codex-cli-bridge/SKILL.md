---
name: codex-cli-bridge
description: Delegate work to the OpenAI Codex CLI (`codex`) under a ChatGPT subscription — run plan/instruction EXECUTION in a sandboxed workspace, or get a read-only ADVISORY review of a plan or working-tree diff — as a second delegated-execution backend beside Antigravity. Use when the user wants to hand a bounded coding task or plan to `codex exec`, get a second-opinion review from codex, install or authenticate Codex CLI, understand its sandbox/network/approval policy, drive codex efficiently from the main agent (exec vs review, resume, the commit boundary), bridge project context (`AGENTS.md`) into codex, or troubleshoot codex flags, models, auth, or its no-TTY headless behaviour.
metadata:
  version: '5.0.1'
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

- Delegate plan or instruction EXECUTION to `codex` in a workspace-write sandbox (network to
  `api.typesafe.ai` and `docs.typesafe.ai` only where the permissions profile `jev` runs, off elsewhere).
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

- they **unset `OPENAI_BASE_URL` and every `*_API_KEY` except `TYPESAFE_API_KEY`** (`OPENAI_API_KEY`
  and `CODEX_API_KEY` included; `TYPESAFE_API_KEY` passes as given) so a stray key can never silently
  switch you to paid api-key billing;
- they pass **`--ignore-user-config`** so a personal `~/.codex/config.toml` cannot change model,
  sandbox, or approval behaviour (auth still works — codex reads the login from `CODEX_HOME`
  regardless of that flag);
- they **preflight `codex login status`** and refuse to run unless it reports `Logged in using ChatGPT`.

## Models: the host posture

Delegated codex work runs on the **host posture**: `CODEX_MODEL` and `CODEX_EFFORT` from the bridge
settings file `${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf`, else the built-in
default `gpt-6.1-sol` / `high`. **`/agent-workflow-kit bridge-settings`** shows the models the
installed `codex` offers and sets the host posture (checked against that list before it writes).
Before any run is spent the wrappers check the effective model and
effort against the installed CLI's catalog (`codex debug models`, the entries offered for listing): a
model or effort it does not offer is refused (exit 2) with the offered list and the settings-file lines
that set an offered posture. An unreadable catalog is one stderr warning and the run proceeds — codex
itself then refuses a model it does not serve.

The environment overrides the host posture for one run. A run on anything other than the host posture
is a **one-off**, whatever set it, and only a probe runs one: without `CODEX_PROBE=1` the wrappers refuse
it pre-spend (exit 2) and name the remedy — the settings-file lines that make it the host posture, plus
unsetting `CODEX_MODEL` and `CODEX_EFFORT` in the environment. An environment value equal to the host
posture is not a one-off; an explicitly empty `CODEX_MODEL=` or `CODEX_EFFORT=` selects the built-in
default. A nonced `codex-exec` probe one-off is refused too (the exec receipt could not say it ran off
the host posture), and a probe review's receipt is `probe:true` and never attests.

A weaker model is therefore the user's choice in the setting, never the orchestrator's per call. `high`
is the default effort, not the catalog maximum (`xhigh`, `max` and `ultra` exist above it). Whether the
default is also the *strongest* selectable Codex model is a hand-checked claim against
<https://developers.openai.com/codex/models>, with **no automated gate and no recorded date** — a newer
model is silent until the user sets it or a bridge release moves the default. A retired model fails
loudly: the catalog check refuses it pre-spend with the offered list and the remedy.

Economy comes only from **quality-neutral waste removal** (clean capture, a hard timeout,
a precomputed review diff, `resume` instead of re-sending context), never from a per-call downgrade.

| Variable | Default | Effect |
|---|---|---|
| `CODEX_MODEL` | the setting, else `gpt-6.1-sol` | model passed to `-m`; an environment value off the host posture is a one-off, REFUSED unless `CODEX_PROBE=1` |
| `CODEX_EFFORT` | the setting, else `high` | reasoning effort (`-c model_reasoning_effort=…`); an environment value off the host posture is a one-off, REFUSED unless `CODEX_PROBE=1` |

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
# EXECUTION (workspace writes; network to api.typesafe.ai and docs.typesafe.ai under the profile `jev`, else off; never prompts):
codex-exec docs/plans/<slug>.md                 # drive a plan file
echo "apply review fix: ..." | codex-exec -      # ad-hoc instruction from stdin
codex-exec <file|-> -- <extra codex flags...>     # GUARDED passthrough after `--` (policy/model/capture flags rejected; some relaxed only under CODEX_PROBE=1)

# RESUME (iterate on the SAME session without re-sending context):
codex-exec --resume-last docs/plans/<slug>.md    # continue the last session (id from the sidecar)
echo "now do step 2 ..." | codex-exec --resume <session-id> -

# ACCOUNTED EXECUTION (the delegation ledger's exec lane — see "Dispatch identity" below):
codex-exec --nonce <n> docs/plans/<slug>-dispatch.md   # mints a fail-closed exec receipt

# REVIEW (read-only: the profile `jev` with no write entry, or --sandbox read-only — codex only emits findings):
codex-review plan docs/plans/<slug>.md           # critique a plan
codex-review code                                # review the current working-tree diff (precomputed)
codex-review code "focus on the new reducer"     # review with extra focus
```

**Honesty + posture (D4/D5):** a run whose final message has no recognized
`Verdict: <ship|revise|rethink>` line — empty or missing output included — **exits 4 with NO
receipt**: treat it as a *failed review to re-run*, never a fatal session error. One stderr banner
states the actual posture (`review posture: model=… effort=… tier=… jev=… source=… timeout=…`) and the
receipt records the same `posture {model, effort, tier}` (tier `null` on the standard tier); control
bytes in a posture value refuse pre-spend in every mode. `codex-exec` states its posture the same way —
ONE `exec posture: model=… effort=… tier=… sandbox=jev-profile|workspace-write session=fresh|resume:<id>
jev=… source=… timeout=…` stderr line before dispatch (the resume id validated pre-spend). The `jev=`
field says what the run reaches: `jev=api.typesafe.ai,docs.typesafe.ai` under the permissions profile `jev`
(Linux, codex-cli 0.160.0 or newer, for `codex-exec` a repository outside every temp root, a codex
version and profile digest not recorded as refused), else `jev=unreachable (<reason>)` on today's flags.
A run whose codex refuses the profile (a profile error before the turn starts, or `bwrap: execvp` in a
failed command) **exits 72** with no success receipt (a review writes none); a refused profile key is
recorded in `${XDG_STATE_HOME:-~/.local/state}/agent-workflow/codex-jev-profile-refused` when that file
can be written, so the next run of that wrapper on that version and digest takes today's flags; a
`bwrap: execvp` failure records nothing. The `jev=`, `source=` (`model:<s>,effort:<s>`,
each `default`, `setting` or `environment`) and `timeout=` fields
are **banner-only** (`timeout=` is exactly the duration handed to `timeout(1)`; on exec `uncapped`
without a capping binary, while `codex-review` **fails CLOSED pre-spend** there) — informational,
never a receipt field. **Quote the posture banner verbatim** when labeling a dispatch.

Every successful review receipt carries integer `durationS` and `blocking`; the wrapper prints
`review duration: <n>s`. A plan receipt also carries `artifactPath`, normalized to a repo-relative
realpath inside the work tree and an absolute realpath otherwise. A double quote, backslash or
control byte in that path refuses pre-spend because the receipt encoder cannot carry it. Codex
counts `[blocker]` and `[major]` lines, or those two finding severities in schema mode — a schema
payload whose findings cannot be counted fails the run (exit 4, no receipt).

`codex exec` is headless: there is **no TTY**, so `approval_policy=never` — anything needing
escalation is refused and reported, never interactively approved. The wrappers capture only codex's
**final message** (`-o`), so output is clean; the JSON event stream + reasoning go to a run trace
that is **read before it is discarded**. Fresh and resumed runs share **ONE** capture posture
(`-o` + `--json`, everything redirected into the trace; `--color never` rides the fresh lane only —
`codex exec resume` does not accept it), so both modes have the
same evidence surface — and the wrapper scans that surface on **every completed run**: a run that
SURVIVES a nested-sandbox failure exits 0 with an ungrounded answer, so on `rc == 0` it prints the
answer first and then warns loudly on stderr when one `command_execution` item with a **proven**
failure carries both a sandbox-mechanism and a permission/read-only token in its `aggregated_output`.
The exit status stays 0 there (warning, not gate) — read the stderr line. A successful **non-resume**
`codex-exec` also records the session id to a sidecar
(`${CODEX_SESSION_FILE:-./.codex-last-session}`) so `--resume-last` can find it. Extra `codex` flags
go after a literal `--`; the wrapper rejects any that would defeat the policy or the host posture (see
[§ Environment knobs](#environment-knobs) and the flag tiers in
[`references/sandbox-and-flags.md`](references/sandbox-and-flags.md)); args without the separator are
rejected, never silently dropped.

## Environment knobs

All optional; the defaults are the supported path. The model and effort are the host posture, and
anything that would defeat a policy is guarded — see [§ Models](#models-the-host-posture).

| Variable | Default | Effect |
|---|---|---|
| `CODEX_MODEL` | the setting, else `gpt-6.1-sol` | model; off the host posture REFUSED unless `CODEX_PROBE=1` |
| `CODEX_EFFORT` | the setting, else `high` | reasoning effort; off the host posture REFUSED unless `CODEX_PROBE=1` |
| `CODEX_HARD_TIMEOUT` | `3600` (exec) / `1800` (review) | hard wall-clock cap (seconds) via `timeout`/`gtimeout`; exit 124/137 ⇒ "exceeded hard cap". No `timeout` binary ⇒ a nonce-less exec warns loudly + runs uncapped, a **nonced** exec REFUSES pre-spend (an accounted dispatch that cannot be capped can never honour the terminal-exit rule), and `codex-review` REFUSES pre-spend (fail-closed preflight). |
| `CODEX_SERVICE_TIER` | unset (standard tier) | **SPEND knob**: `priority` (catalog name "Fast") = "2x speed, **increased usage**" in the codex catalog's own words for gpt-6.1-sol (cache fetched 2026-10-03); it states no credit-rate figure — quality-neutral (same model). codex accepts any `-c service_tier` string silently (probe-verified), so the wrapper validates: an unsupported value warns and runs standard. Env or settings file. |
| `CODEX_SESSION_FILE` | `./.codex-last-session` | where `codex-exec` records the session id and where `--resume-last` reads it |
| `CODEX_REVIEW_MAX_TOTAL_BYTES` | `1500000` | `codex-review code`: above this the assembled diff goes via a git-dir temp file instead of inline — never truncated |
| `AW_REVIEW_NONCE` | unset | the flow dispatch nonce (safe grammar `[A-Za-z0-9._-]{1,64}` — anything else refuses pre-spend). `codex-review … --nonce <n>` is the plain-argument equivalent (one seam; flag and a non-empty env must agree, a disagreeing pair refuses pre-spend) — the lane for hosts whose dispatch policy has no env-prefix form. When supplied, a successful review first mints the finding MANIFEST `agent-workflow-finding-manifest-codex-<nonce>.json` beside the receipts file (atomic, no-clobber, ORDERED before the receipt append) — a failed mint EXCLUDES the receipt, so a nonce-supplied dispatch never lands a receipt without its readable manifest; nonce-less runs add no nonce field and mint nothing (the `wrapperVersion` field every receipt carries moves with each release) |
| `AW_DISPATCH_NONCE` | unset | the **delegation** dispatch nonce (same safe grammar; anything else refuses pre-spend). `codex-exec [--nonce <n>] <plan-file>` is the plain-argument equivalent — ONE seam, recognised only BEFORE the prompt operand (after it, or after a literal `--`, it is passthrough payload). When supplied, the run is ACCOUNTED: see [§ Dispatch identity](#dispatch-identity-the-accounted-exec-lane). |
| `AW_DELEGATION_STORE` | unset (the git common dir) | absolute path of the delegation ledger; its **dirname** is where a nonced run's receipt and report land. Relative, or ending in a path separator, refuses pre-spend — the same rule the kit's store applies. |
| `CODEX_REVIEW_SCHEMA` | unset | `codex-review`: `=1` returns findings as a validated JSON object (`--output-schema`), with a raw-text fallback. Default off. |
| `CODEX_PROBE` | unset | `=1` ⇒ throwaway-probe mode: the one route to a one-off model or effort, and it relaxes the tier-2 passthrough guard (echoed loudly); a probe review's receipt never attests. Never for real work. |

The git-write shim, `--ignore-user-config`, the key rule (`OPENAI_BASE_URL` and every `*_API_KEY` but
`TYPESAFE_API_KEY` unset) and the choice between the profile and today's flags are NOT env-tunable —
they are fixed invariants.

### Dispatch identity — the accounted exec lane

A **nonced** `codex-exec` run has an identity the delegation ledger can absorb. Everything here is
skipped entirely without a nonce: the wrapper is byte-unchanged, writes no artifact and needs no
`node`.

- **Pre-spend, it RESERVES the nonce.** Immediately before the CLI runs — after every preflight and
  after the posture banner — it publishes `agent-workflow-exec-receipt-<len>-<backend>-<nonce>.json`
  in state `reserved`, atomically and **no-clobber**, beside the delegation store. A second dispatch
  on the same nonce (or a leftover report under that name) refuses **before any spend**. So does a
  run with no capping binary, without `node`, with the prompt on stdin instead of a contract file, or
  with a file carrying no ` ```aw-dispatch-contract ` block.
- **`contractDigest` is computed HERE**, by the wrapper, from the dispatch file it was handed — an
  independent value, never a copy of what the ledger holds, so `dispatch return` can refuse a run
  that executed a *different* contract than the one it opened.
- **At exit it publishes, in this ORDER**: verify the reservation is still ours → write the
  delegate's final message to `agent-workflow-exec-report-<len>-<backend>-<nonce>.txt` → verify
  again → replace the reservation with the `terminal` receipt. An artifact that has arrived therefore
  always has a complete report behind it, and a **foreign owner publishes nothing at all**.
- **The outcome is a SUBSET** the run can prove about itself: exit 0 with a session id → `success`,
  exit 0 without one → `missing-identity`, any nonzero exit (124/137 included) →
  `transport-failure`. Every orchestrator judgment is recorded later, at absorb time.
- **FAIL-CLOSED, unlike the review receipt.** A review receipt that cannot be written only warns; an
  exec receipt that cannot be written leaves an EDITED tree with no accounting, so the wrapper exits
  nonzero and calls the tree partial/dirtied — never untouched. The two statuses carry **different**
  recoveries:
  - **71** — a publication stopped. The reservation is the run's own, so absorb the thread with
    `dispatch return --nonce <n> --no-receipt --exit-status <n> --outcome <o>`. The message says
    whether the report reached disk: if it did the absorb reads it, if it did not the absorb records
    `reportLength 0` and the metric is ineligible by the name `empty-report`.
  - **70** — the reservation could not be verified *before* anything was published, so nothing was.
    `--no-receipt` is **not** the recovery here: it would source `wrapperVersion` and `posture` from
    an artifact that belongs to another run. Establish what replaced the reservation first.

### Settings file (host-level, survives kit upgrades)

`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf` holds `KEY=VALUE` lines,
**parsed, never sourced** — a file line can never execute code. Precedence: explicit env (even
empty — `KEY=` disables a knob for one run) > file > built-in default. File-settable keys for this
bridge: `CODEX_MODEL` and `CODEX_EFFORT` (the host posture — see [§ Models](#models-the-host-posture)),
`CODEX_SERVICE_TIER` (the Fast tier — **increased usage**; enabling it is a consented per-host spend
decision, never a default), `CODEX_HARD_TIMEOUT`, `CODEX_REVIEW_MAX_TOTAL_BYTES` — exactly the
manifest `settings` block (the single source; the wrapper constants and `--help` are drift-guarded
against it, the model keys read by the posture reader instead). The file lives **outside every kit-managed tree**, so a kit refresh/upgrade can
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

**The Jev skill in a delegated run.** A `codex-exec` or `codex-review` run loads the vendor's Jev skill from the
user root the kit's `jev-skill` command fills, `~/.agents/skills` (a run under `--ignore-user-config` listed its
skills, measured 2026-10-02; `codex-review` links that root into its fence home), and `TYPESAFE_API_KEY` passes the
wrappers as given while every other `*_API_KEY` is unset. On Linux with codex-cli 0.160.0 or newer, off a codex
version and profile digest recorded as refused and, for `codex-exec`, from a repository outside every temp root, the
run carries the permissions profile `jev`: it reaches `api.typesafe.ai` and `docs.typesafe.ai` and no other host, a review still
writes nothing, and the banner reads `jev=api.typesafe.ai,docs.typesafe.ai`; anywhere else the run keeps today's
flags with network off and the banner says `jev=unreachable (<reason>)`. Two residuals stand: codex's server-side
`web_search` reaches pages outside the profile, and the key now sits in every run's environment, the `web_search`
channel included. A codex release that stops recognizing a profile key costs one run per version and profile digest
(exit 72), while the state file can be written, before the recorded fallback takes over.

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
  the host posture's model/effort) and **restates the full posture via `-c`** — `codex exec resume` resets the
  sandbox/approval/network posture and rejects the `-s`/`--add-dir`/`-C` posture flags, so the wrapper
  sets `approval_policy=never` and the run's own posture explicitly — the profile `jev`'s four overrides,
  or `sandbox_mode=workspace-write` + `sandbox_workspace_write.network_access=false` — chosen afresh on
  each resume. It reads the session id from the sidecar (`--resume-last`) or takes it as an argument.
- **Network: two hosts at most in exec.** Under the profile `jev` a run reaches `api.typesafe.ai` and
  `docs.typesafe.ai` only; under today's flags none. New dependencies and any other network step are
  installed by hand, then codex is re-dispatched.
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

- **Network: two hosts at most** in `codex-exec` — the profile `jev` reaches `api.typesafe.ai` and
  `docs.typesafe.ai` only, today's flags (`sandbox_workspace_write.network_access=false`) none: codex
  cannot install dependencies — do that by hand, then re-dispatch. The profile runs only on Linux with
  codex-cli 0.160.0 or newer; Windows and macOS keep today's flags until its round-trip is probed there.
- **No live approvals** — `codex exec` has no TTY, so `approval_policy=never`; an action that would
  need escalation is reported, not approved interactively.
- **`resume` resets the posture** — `codex exec resume` rejects `-s`/`--add-dir`/`-C` and forgets the
  original sandbox/approval/network policy. The `codex-exec --resume`/`--resume-last` entrypoint
  restates it via `-c`; only a *raw* `codex exec resume` (bypassing the wrapper) loses the posture.
- **Hard timeout** — a hung run is killed at `CODEX_HARD_TIMEOUT` (exec 3600s / review 1800s) and
  reported (exit 124/137); raise it for a known-healthy slow run. If neither `timeout` nor `gtimeout`
  is on `PATH`, a nonce-less `codex-exec` warns loudly and runs uncapped, a **nonced** one refuses
  pre-spend, and `codex-review` refuses pre-spend (the fail-closed preflight — an uncapped review run
  no longer exists).
- **The wrapper cannot enforce an ABSOLUTE deadline** — it applies its own cap from ITS start and
  never reads the ledger, so a dispatch started long after `dispatch open` is caught at absorb time
  (the return refuses a late receipt), not pre-spend. Keeping that window small is the
  orchestrator's rule: `open` is the last act before the dispatch.
- **The gate output is not accounted** — the run trace is a temp file the EXIT trap removes, so a
  nonced run's report carries the delegate's final message only; the metric counts the returned
  change set, never what the gates printed.
- **Native `codex review` is out of scope** — it rejects `--ignore-user-config` (would load a personal
  `config.toml` and break the subscription/config-isolation invariant) and can't be cleanly captured;
  `codex-review` runs `codex exec` over a precomputed diff instead.
- **bubblewrap** — on Linux, if `bubblewrap` is not on `PATH` codex prints a warning and uses a
  bundled copy; install it via your package manager to silence the warning.
- codex output is advisory and may be incomplete or out of date — the main agent verifies before
  acting.
