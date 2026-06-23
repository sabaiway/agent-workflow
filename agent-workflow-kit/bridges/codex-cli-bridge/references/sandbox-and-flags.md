# `codex` sandbox, flags & policy (reference)

The source of truth is the live binary: `codex --version`, `codex --help`, `codex exec --help`. The
tables below were captured from **codex-cli 0.140.0**; if the binary disagrees, the binary wins. The
wrapper commands are `codex-exec` and `codex-review`, backed by `bin/codex-exec.sh` /
`bin/codex-review.sh`.

## Sandbox levels — when to use which

| Level | Can write? | Network? | Wrapper that uses it |
|---|---|---|---|
| `read-only` | no | no | `codex-review` (codex only reads + emits findings) |
| `workspace-write` | repo (cwd) only | OFF (we force it off) | `codex-exec` (codex edits the repo) |
| `danger-full-access` | anywhere | yes | never used by this skill |

`codex-exec` always passes:

```bash
--sandbox workspace-write \
-c approval_policy="never" \
-c sandbox_workspace_write.network_access=false
```

`codex-review` always passes:

```bash
--sandbox read-only \
-c approval_policy="never"
```

Under `read-only`, codex *structurally* cannot edit, create, delete, or git-write — it can only read
and report. In v0.140.0 `read-only` also grants **no network**, so `codex-review` relies on that and
passes no separate network flag — the `sandbox_workspace_write.*` config (including
`network_access`) applies **only** to `workspace-write`.

## Network-OFF invariant (exec)

`codex-exec` keeps network access OFF on purpose: **new dependencies and any network step are
installed by a human**, not by codex. If a task needs a new package, codex must STOP and report it;
the orchestrator installs it, then re-dispatches.

## Escalation & approvals

There is **no TTY** in `codex exec`, so `approval_policy=never`: codex never pauses for an interactive
approval. Any action that would need escalation (network, writes outside the repo, an ambiguous
decision) is **refused and reported**, and the orchestrator handles it by hand. Codex must never run a
git write command — the orchestrator commits after reviewing the diff.

## Commit prohibition

Delegated codex runs do not own repository history. The wrappers' contract prohibits every git write:
no branch, add, commit, stash, reset, checkout, tag, or history rewrite. The orchestrator reviews the
diff, runs final verification, and commits only when that is the desired next step.

## `resume` caveat

`codex exec resume` re-dispatches an existing session without re-sending context. **It may not
re-accept `--sandbox` / `approval_policy` / network flags** — do not assume the original posture
carries over. Restate the policy in the resumed instruction, or start a fresh `codex-exec` run when a
guaranteed sandbox/network posture matters.

## Subscription / config invariant

Both wrappers, before invoking codex:

- **unset** `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, and every other `*_API_KEY`, so a
  stray key can't switch to paid api-key billing;
- pass **`--ignore-user-config`** so a personal `~/.codex/config.toml` cannot change behaviour. Auth
  still works: codex reads the cached login from `CODEX_HOME` (`~/.codex`) regardless of that flag;
- preflight `codex login status` and refuse unless it contains `Logged in using ChatGPT`;
- preflight a git work tree and a root `AGENTS.md`, failing fast (before a run is spent) if missing.

## Verified commands & flags (v0.140.0)

| Command / flag | Verified behaviour |
|---|---|
| `codex exec` | non-interactive run from stdin / a prompt arg (headless, no TTY) |
| `codex exec resume` | resume an exec session (see the resume caveat) |
| `codex exec review` | review path reachable under `exec` |
| `codex review` | repository review path; supports reviewing uncommitted changes |
| `codex login` / `codex login status` | subscription auth flow + status check |
| `codex sandbox` / `codex apply` / `codex resume` | sandbox / apply / resume helper subcommands |
| `-c key=value` | override a config value (dotted path, TOML-parsed) — how policy is set deterministically |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` (this skill uses the first two) |
| `-c approval_policy=never` | never pause for interactive approval (required: exec has no TTY) |
| `-c sandbox_workspace_write.network_access=false` | network OFF under workspace-write (the exec invariant) |
| `-m <model>` | model to use (wrapper default `gpt-5.5` via `CODEX_MODEL`) |
| `-c model_reasoning_effort=<effort>` | reasoning effort (wrapper default `xhigh` via `CODEX_EFFORT`) |
| `--ignore-user-config` | do NOT load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME` |
| `--add-dir <dir>` | extra writable dir alongside the workspace |
| `-C, --cd <dir>` | use `<dir>` as the working root |
| `--skip-git-repo-check` | allow running outside a git repo (exec normally requires one) |
| `--ephemeral` | do not persist session files |

## Troubleshooting

- **`could not find bubblewrap on PATH`** (Linux): codex falls back to a bundled bubblewrap. Install
  `bubblewrap` (`sudo apt install bubblewrap` or equivalent) to silence the warning; it is only a
  blocker if sandbox startup actually fails.
- **`not on a ChatGPT subscription`** (wrapper preflight): run `codex login`; confirm with
  `codex login status` → `Logged in using ChatGPT`.
- **`must run inside a git working tree` / `no root AGENTS.md`** (wrapper preflight): run the wrapper
  from the target project root.
- **codex wants to install a dependency**: it can't (network OFF in exec) — install it by hand, then
  re-dispatch.
