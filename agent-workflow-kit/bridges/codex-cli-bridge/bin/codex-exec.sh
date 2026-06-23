#!/usr/bin/env bash
# Delegate plan/instruction EXECUTION to the OpenAI Codex CLI (`codex exec`).
#
# Project-agnostic wrapper for the codex-cli-bridge skill. It encodes one fixed,
# deterministic execution policy and prepends an ORCHESTRATOR EXECUTION CONTRACT
# so codex never wastes a run rediscovering it. Codex reads the TARGET project's
# Hard Constraints itself, from the root AGENTS.md in its working directory
# (codex auto-reads AGENTS.md from cwd) — this wrapper hardcodes no project rules.
#
# Fixed policy (single source of truth — passed via flags + --ignore-user-config,
# so behaviour is deterministic regardless of ~/.codex/config.toml):
#   - workspace-write sandbox: codex may edit the repo, nothing outside it
#   - network access OFF: new dependencies / network installs are done by a human
#   - approval_policy=never: there is no TTY in exec; anything needing escalation
#     is refused and reported, then handled by hand
#   - strongest model at maximum reasoning effort (override CODEX_MODEL/CODEX_EFFORT)
#
# Auth: SUBSCRIPTION ONLY. Uses the cached ChatGPT login under CODEX_HOME
# (~/.codex). The wrapper unsets every *_API_KEY plus OPENAI_BASE_URL and passes
# --ignore-user-config, so a stray key or a personal ~/.codex/config.toml can
# never silently switch billing or change behaviour. No credentials are bundled.
#
# Usage (installed on PATH as `codex-exec`):
#   codex-exec docs/plans/<slug>.md                 # drive a plan file
#   echo "apply review fix: ..." | codex-exec -      # ad-hoc instruction (stdin)
#   CODEX_MODEL=<slug> codex-exec <file>             # override the model
#   codex-exec <file|-> -- <extra codex flags...>    # passthrough codex flags
set -euo pipefail

CODEX_MODEL="${CODEX_MODEL:-gpt-5.5}"   # default coding model (verified locally); override per call
CODEX_EFFORT="${CODEX_EFFORT:-xhigh}"   # maximum reasoning effort
CHATGPT_LOGIN_GUARD="Logged in using ChatGPT"

# --- Subscription-only guard -------------------------------------------------
# Never let an API key (or a user config) silently switch codex to paid api-key
# billing or alternate behaviour. Clear the explicit vars first, then any other
# *_API_KEY that may have been added later (`compgen` is a bash builtin).
unset OPENAI_API_KEY CODEX_API_KEY OPENAI_BASE_URL 2>/dev/null || true
while IFS= read -r _api_key_var; do
  unset "$_api_key_var" 2>/dev/null || true
done < <(compgen -v 2>/dev/null | grep '_API_KEY$' || true)

# --- Environment preflight (fail fast, before spending a subscription run) ----
if ! command -v codex >/dev/null 2>&1; then
  echo "error: 'codex' (OpenAI Codex CLI) not found on PATH. See this skill's setup/README.md." >&2
  exit 127
fi
if ! codex login status 2>&1 | grep -qF "$CHATGPT_LOGIN_GUARD"; then
  echo "error: codex is not on a ChatGPT subscription (expected '$CHATGPT_LOGIN_GUARD')." >&2
  echo "       Run 'codex login' once; this skill is subscription-only and won't use api-key billing." >&2
  exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: codex-exec must run inside a git working tree (codex exec needs one; the diff is your review surface)." >&2
  exit 2
fi
if [[ ! -f AGENTS.md ]]; then
  echo "error: no root AGENTS.md in the current directory — run from the target project root." >&2
  echo "       (codex reads AGENTS.md for the project's Hard Constraints and declared gates)" >&2
  exit 2
fi

read -r -d '' ORCHESTRATOR_DIRECTIVE <<'DIRECTIVE' || true
ORCHESTRATOR EXECUTION CONTRACT — read before the task, follow it exactly:
1. Work directly in the current working tree on the current git branch. NEVER run
   any git write command (no branch, add, commit, stash, reset, checkout, tag, or
   history rewrite) — the orchestrator commits after review.
2. Read the target project's root AGENTS.md and obey EVERY Hard Constraint it
   declares, plus this task's own "do NOT" / out-of-scope section.
3. After implementing, run a SELF-REVIEW pass over your own changes — `git status`
   for untracked files and `git diff` for tracked ones, reading the contents of
   any new untracked files — against the task and those Hard Constraints; fix
   anything that drifts so the handed-back work is clean.
4. Run the verification / gate set the project declares (in AGENTS.md or the
   task). If the project declares NO gate set, STOP and report — do NOT invent
   checks. Fix every failure before finishing.
5. Do NOT commit. If you hit a blocker needing escalation (network access, writes
   outside the repo, a live approval, or an ambiguous decision), STOP and report
   it clearly — never guess.

TASK:
DIRECTIVE

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <plan-file|-> [-- extra codex args...]" >&2
  exit 2
fi

prompt_src="$1"; shift

# Split off passthrough codex flags after a literal `--`. Extra args WITHOUT the
# `--` separator are a mistake — they would be silently dropped, so fail loudly.
passthrough=()
if [[ $# -gt 0 ]]; then
  if [[ "$1" == "--" ]]; then
    shift
    passthrough=("$@")
  else
    echo "error: unexpected argument '$1'. Pass extra codex flags after a literal '--':" >&2
    echo "       $0 <plan-file|-> -- <codex flags...>" >&2
    exit 2
  fi
fi

# This wrapper OWNS the safety policy (sandbox level, approval policy, network
# access, and every -c config override). Reject passthrough flags that would
# defeat it — appended flags can otherwise override the fixed ones. Benign flags
# (--add-dir, --cd, --ephemeral, -m, --image, ...) still pass through.
if [[ ${#passthrough[@]} -gt 0 ]]; then
  for _arg in "${passthrough[@]}"; do
    case "$_arg" in
      -c*|--config*|-s*|--sandbox*|--dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--full-auto)
        echo "error: passthrough flag '$_arg' is not allowed — this wrapper fixes the sandbox / approval / network / config policy." >&2
        echo "       Drop it, or invoke 'codex' directly if you truly need a different policy." >&2
        exit 2
        ;;
    esac
  done
fi

if [[ "$prompt_src" == "-" ]]; then
  task="$(cat)"
elif [[ -f "$prompt_src" ]]; then
  task="$(cat "$prompt_src")"
else
  echo "error: '$prompt_src' is not a file (use '-' to read the prompt from stdin)" >&2
  exit 2
fi

if [[ -z "${task//[[:space:]]/}" ]]; then
  echo "error: empty plan/instruction" >&2
  exit 2
fi

printf '%s\n\n%s' "$ORCHESTRATOR_DIRECTIVE" "$task" | codex exec \
  --ignore-user-config \
  --sandbox workspace-write \
  -c approval_policy="never" \
  -c sandbox_workspace_write.network_access=false \
  -c model_reasoning_effort="$CODEX_EFFORT" \
  -m "$CODEX_MODEL" \
  "${passthrough[@]+"${passthrough[@]}"}" \
  -
