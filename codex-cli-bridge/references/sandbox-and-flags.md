# `codex` sandbox, flags & policy (reference)

The source of truth is the live binary: `codex --version`, `codex --help`, `codex exec --help`. The
tables below were captured from **codex-cli 0.142.3**; if the binary disagrees, the binary wins. The
wrapper commands are `codex-exec` and `codex-review`, backed by `bin/codex-exec.sh` /
`bin/codex-review.sh`.

## Sandbox levels — when to use which

| Level | Can write? | Network? | Wrapper that uses it |
|---|---|---|---|
| `read-only` | no | no | `codex-review` (codex only reads + emits findings) |
| `workspace-write` | repo (cwd) only | OFF (we force it off) | `codex-exec` (codex edits the repo) |
| `danger-full-access` | anywhere | yes | never used by this skill |

**A sandbox bounds WRITES, not READS.** Even `read-only` can read any file on disk (it is what kept a
naive review roaming into `~/.claude/**` and producing multi-MB transcripts). Read-scoping is therefore
a **prompt + env** concern, not a sandbox one — see the review read-fence below. Under `read-only` codex
*structurally* cannot edit, create, delete, or git-write; it can only read and report.

## Flags the wrappers always pass

`codex-exec`:

```bash
codex exec --ignore-user-config \
  --sandbox workspace-write \
  -c approval_policy=never \
  -c sandbox_workspace_write.network_access=false \
  -c model_reasoning_effort="$CODEX_EFFORT" \
  -c hide_agent_reasoning=true -c model_reasoning_summary=none \
  --color never -o "$out" --json -m "$CODEX_MODEL" -
```

`codex-review` is the same minus the write/network posture, plus `--sandbox read-only` and (optionally)
`--output-schema`. In v0.142.3 `read-only` also grants **no network**, so `codex-review` relies on that
and passes no separate network flag — the `sandbox_workspace_write.*` config (including
`network_access`) applies **only** to `workspace-write`.

### Clean output capture

`-o`/`--output-last-message` writes ONLY codex's final message; `--json` streams the structured event
stream (incl. `thread.started`, which carries the session id) to a discarded trace; `--color never` +
`-c hide_agent_reasoning=true` + `-c model_reasoning_summary=none` strip colour and chain-of-thought.
Net effect: the wrapper prints just the final answer. **Reasoning still runs at `xhigh`** — quality is
unchanged; only the *noise* is dropped. On success `codex-exec` extracts the session id from the trace
and records it to `${CODEX_SESSION_FILE:-./.codex-last-session}` (so `--resume-last` can find it) and
echoes `session: <id>` to stderr. On a missing/empty final-message file it falls back to the trace tail
(loud, never silent).

## Quality-first guard (pinned model & effort)

The wrappers default `CODEX_MODEL=gpt-5.5` and `CODEX_EFFORT=xhigh` and **refuse** (exit 2, loud) any
non-default — delegated work always uses the frontier model at max effort; quality is never traded for
quota. `CODEX_PROBE=1` relaxes this for a throwaway, effort-independent probe only (echoed loudly), and
a probe still runs on the subscription, in the sandbox, with clean capture.

## Passthrough guard (two tiers, after a literal `--`)

`codex-exec` owns the safety + quality policy, so it filters passthrough flags:

- **Tier 1 — ALWAYS rejected, even under `CODEX_PROBE=1`:** anything that would defeat the policy or the
  capture — `-c`/`--config`, `-s`/`--sandbox`, `--full-auto`, `--dangerously-bypass-*`, `--oss`,
  `--local-provider`, `-p`/`--profile`, `-m`/`--model` (the model is pinned via `CODEX_MODEL`), and the
  capture flags `-o`/`--output-last-message`/`--json`/`--color`/`--output-schema`/`--ephemeral`.
- **Tier 2 — context/discovery knobs, rejected for a real run but allowed under `CODEX_PROBE=1`:**
  `--add-dir`, `-C`/`--cd`, `--skip-git-repo-check`, `--ignore-rules`, `--enable`/`--disable`.

Args passed WITHOUT the `--` separator are rejected (a likely mistake), never silently dropped. Need
more than the wrapper allows? Invoke `codex` directly — outside the subscription/policy guarantees.

Note that `--skip-git-repo-check` (tier 2) only relaxes **codex's own** git-repo check; the wrapper's
preflight still **requires a git work tree and a root `AGENTS.md`** and STOPs first if either is
missing — passing it does not let `codex-exec` run outside a repo.

## Network-OFF invariant (exec)

`codex-exec` keeps network access OFF on purpose: **new dependencies and any network step are installed
by a human**, not by codex. If a task needs a new package, codex must STOP and report it; the
orchestrator installs it, then re-dispatches.

## Escalation & approvals

There is **no TTY** in `codex exec`, so `approval_policy=never`: codex never pauses for an interactive
approval. Any action that would need escalation (network, writes outside the repo, an ambiguous
decision) is **refused and reported**, and the orchestrator handles it by hand.

## Commit prohibition — enforced by a git-write shim

Delegated codex runs do not own repository history. Beyond the prompt contract (no branch/add/commit/
stash/reset/checkout/tag/rewrite), `codex-exec` **physically enforces** the boundary: it writes a `git`
shim into a temp dir and prepends that dir to the codex subprocess's `PATH`. codex spawns `git` via
`execve`, which bypasses exported shell functions, so the boundary must be a real executable file. The
shim:

- passes a **read-only allowlist** through to the real git (`status`, `diff`, `show`, `log`, `ls-files`,
  `rev-parse`, `cat-file`, `for-each-ref`, …);
- treats `git config` as **read-only** — blocked on any write/action flag (`--add`/`--unset`/…) or a
  `<name> <value>` set form (≥2 positionals);
- **blocks every other / unknown verb** (`add`, `commit`, `reset`, `checkout`, `merge`, `push`, `tag`,
  `update-ref`, `symbolic-ref`, `reflog`, …) with exit 13;
- bakes the **real git path into the shim itself** (never exposed as an env var — that would be a
  trivial bypass vector).

This is defence-in-depth beside the prompt contract; the orchestrator still reviews the diff and commits.

## Precomputed review diff (`codex-review code`)

`code` mode does NOT make codex discover the diff. The wrapper assembles the full surface — repo file
map (`git ls-files`), `git status`, staged + unstaged diff, and the **contents** of every untracked
regular file (NUL-safe; binaries noted but skipped, symlinks shown as targets; never-committable
untracked paths — devices/FIFOs/sockets — excluded from the review domain entirely) — into a
git-dir-local temp file (600 perms), then feeds it in. A **clean tree exits 0** before
a run is spent. If the assembled payload exceeds `CODEX_REVIEW_MAX_TOTAL_BYTES` (default `1500000`) it is
passed **by path** (read-fence carve-out) instead of inline — **never truncated**. `-s read-only` is
kept so codex may still read surrounding in-repo files for context.

### Optional structured findings

`CODEX_REVIEW_SCHEMA=1` adds `--output-schema` with a flexible schema (`findings[]` of
`severity`/`location`/`issue`/`suggested_change`/optional `evidence`, plus `verdict` and free-text
`notes`). `--output-schema` *constrains* the output (a probe confirmed it does not silently emit
non-conforming text); a raw-text retry covers a rare validation/run failure. Default OFF.

### Review read-fence (best-effort env hygiene)

`codex-review` runs under a throwaway `HOME` + `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME` with an
**absolute `CODEX_HOME`** so auth + history still resolve while codex's default config/cache/skill-scan
roots point at an empty dir (trims the roaming + skill-scan noise). This is **env hygiene, NOT a security
boundary** — absolute paths anywhere on disk remain readable under `read-only`; the real read-scoping is
the prompt fence ("do not read outside the working tree, except the precomputed-diff temp file").

## `resume` — resets posture, restated via `-c`

`codex exec resume` re-dispatches an existing session without re-sending context. It **rejects the
posture flags** `-s`/`--add-dir`/`-C` and **resets** the sandbox/approval/network posture (it DOES
accept `-c`/`-m`/`--last`/`-o`/`--json` on 0.142.3 — the wrapper just doesn't need `-o`/`--json` here).
The `codex-exec --resume`/`--resume-last` entrypoint handles the reset: it restates the entire policy
via `-c` (`sandbox_mode=workspace-write`, `approval_policy=never`,
`sandbox_workspace_write.network_access=false`) plus the pinned `-m`/effort and `--ignore-user-config`,
reads the session id from the sidecar (or an argument), and captures codex's final message straight
from stdout (no `-o` needed). Only a *raw* `codex exec resume` outside the wrapper loses the posture.

## Hard timeout

A backgrounded/hung run survives otherwise, so both wrappers wrap codex in `timeout`/`gtimeout`
(`--kill-after=15s`): `CODEX_HARD_TIMEOUT` defaults to **3600s (exec)** / **1800s (review)**, sized for a
slow `xhigh` run. Exit 124/137 ⇒ "exceeded the hard cap" (raise the cap or narrow the task). If neither
`timeout` nor `gtimeout` is on `PATH`, the wrapper **warns loudly and runs uncapped** — never a silent
no-op.

## Subscription / config invariant

Both wrappers, before invoking codex:

- **unset** `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, and every other `*_API_KEY`, so a
  stray key can't switch to paid api-key billing;
- pass **`--ignore-user-config`** so a personal `~/.codex/config.toml` cannot change behaviour. Auth
  still works: codex reads the cached login from `CODEX_HOME` (`~/.codex`) regardless of that flag;
- preflight `codex login status` and refuse unless it contains `Logged in using ChatGPT`;
- preflight a git work tree and a root `AGENTS.md`, failing fast (before a run is spent) if missing.

## Native `codex review` is out of scope (why)

`codex review` is the CLI's built-in review subcommand, but this skill does **not** ship it. Its flag
surface (0.142.3) is `-c`/`--strict-config`/`--enable`/`--disable`/`--uncommitted`/`--base`/`--commit`/
`--title` — crucially it **rejects** `--ignore-user-config`, `-s`, `-m`, `-o`, `--json`,
`--output-schema`. Without `--ignore-user-config` a
personal `~/.codex/config.toml` loads (a live run forced `sandbox: workspace-write`), which breaks the
subscription/config-isolation invariant, and it has no clean-capture flag. `codex-review` runs `codex
exec` over the precomputed diff instead, keeping every invariant intact.

## Verified commands & flags (v0.142.3)

| Command / flag | Verified behaviour |
|---|---|
| `codex exec` | non-interactive run from stdin / a prompt arg (headless, no TTY) |
| `codex exec resume --last` / `resume <id>` | resume a session; **resets posture & rejects the `-s`/`--add-dir`/`-C` posture flags** (accepts `-c`/`-m`/`--last`/`-o`/`--json`) — restate posture via `-c` |
| `codex review` | built-in review subcommand — **NOT used** (rejects `--ignore-user-config`; see above) |
| `codex login` / `codex login status` | subscription auth flow + status check |
| `-c key=value` | override a config value (dotted, TOML-parsed) — how policy is set deterministically |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` (this skill uses the first two) |
| `-c approval_policy=never` | never pause for interactive approval (required: exec has no TTY) |
| `-c sandbox_workspace_write.network_access=false` | network OFF under workspace-write (the exec invariant) |
| `-c hide_agent_reasoning=true` / `-c model_reasoning_summary=none` | drop chain-of-thought from output (reasoning still runs) |
| `-o, --output-last-message <f>` | write ONLY the final message (clean capture) |
| `--json` | structured event stream (`thread.started` ⇒ session id) |
| `--output-schema <f>` | constrain output to a JSON schema (`CODEX_REVIEW_SCHEMA=1`) |
| `-m <model>` | model (wrapper default `gpt-5.5`, pinned via `CODEX_MODEL`) |
| `-c model_reasoning_effort=<effort>` | reasoning effort (wrapper default `xhigh`, pinned via `CODEX_EFFORT`) |
| `--ignore-user-config` | do NOT load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME` |
| `--color never` | disable ANSI colour in output |

## Environment variables

`CODEX_MODEL`, `CODEX_EFFORT`, `CODEX_HARD_TIMEOUT`, `CODEX_SESSION_FILE`, `CODEX_REVIEW_MAX_TOTAL_BYTES`,
`CODEX_REVIEW_SCHEMA`, `CODEX_PROBE` — see the knob table in [`../SKILL.md`](../SKILL.md#environment-knobs).

## Troubleshooting

- **`could not find bubblewrap on PATH`** (Linux): codex falls back to a bundled bubblewrap. Install
  `bubblewrap` (`sudo apt install bubblewrap` or equivalent) to silence the warning; it is only a
  blocker if sandbox startup actually fails.
- **`not on a ChatGPT subscription`** (wrapper preflight): run `codex login`; confirm with
  `codex login status` → `Logged in using ChatGPT`.
- **`must run inside a git working tree` / `no root AGENTS.md`** (wrapper preflight): run the wrapper
  from the target project root.
- **`exceeded the hard cap`** (exit 124/137): the run hit `CODEX_HARD_TIMEOUT` — raise it for a
  known-healthy slow run, or narrow the task, then re-dispatch.
- **codex wants to install a dependency**: it can't (network OFF in exec) — install it by hand, then
  re-dispatch.
