#!/usr/bin/env bash
# Delegate plan/instruction EXECUTION to the OpenAI Codex CLI (`codex exec`).
#
# Project-agnostic wrapper for the codex-cli-bridge skill. It encodes one fixed,
# deterministic execution policy and prepends an ORCHESTRATOR EXECUTION CONTRACT
# so codex never wastes a run rediscovering it. Codex reads the TARGET project's
# Hard Constraints from the root AGENTS.md auto-merged into its context (root→cwd,
# truncated at project_doc_max_bytes) — this wrapper hardcodes no project rules.
#
# Fixed policy (single source of truth — passed via flags + --ignore-user-config,
# so behaviour is deterministic regardless of ~/.codex/config.toml):
#   - workspace-write sandbox: codex may edit the repo, nothing outside it
#   - network access OFF: new dependencies / network installs are done by a human
#   - approval_policy=never: there is no TTY in exec; anything needing escalation
#     is refused and reported, then handled by hand
#   - strongest model at maximum reasoning effort (quality-first — see below)
#
# Quality-first (hard rule): delegated codex work ALWAYS runs on the frontier
# model at maximum reasoning effort. The defaults below are pinned and the wrapper
# REFUSES a non-default CODEX_MODEL/CODEX_EFFORT — knowingly-worse output is never
# traded for quota. The ONLY exception is a throwaway probe whose result does not
# depend on effort: set CODEX_PROBE=1 (echoed loudly) to relax the guard. Economy
# comes from quality-neutral waste removal (clean capture, a hard timeout, a lean
# prompt), never from a downgrade.
#
# Auth: SUBSCRIPTION ONLY. Uses the cached ChatGPT login under CODEX_HOME
# (~/.codex). The wrapper unsets every *_API_KEY plus OPENAI_BASE_URL and passes
# --ignore-user-config, so a stray key or a personal ~/.codex/config.toml can
# never silently switch billing or change behaviour. No credentials are bundled.
#
# Usage (installed on PATH as `codex-exec`):
#   codex-exec docs/plans/<slug>.md                 # drive a plan file
#   echo "apply review fix: ..." | codex-exec -      # ad-hoc instruction (stdin)
#   codex-exec <file|-> -- <extra codex flags...>    # passthrough codex flags
#   CODEX_HARD_TIMEOUT=2h codex-exec <file>          # raise the hard wall-clock cap
#   CODEX_PROBE=1 CODEX_MODEL=<slug> codex-exec <file>   # throwaway probe (relaxes the guard)
set -euo pipefail

DEFAULT_CODEX_MODEL="gpt-5.5"   # frontier coding model (verified locally) — pinned
DEFAULT_CODEX_EFFORT="xhigh"    # maximum reasoning effort — pinned
CODEX_MODEL="${CODEX_MODEL:-$DEFAULT_CODEX_MODEL}"
CODEX_EFFORT="${CODEX_EFFORT:-$DEFAULT_CODEX_EFFORT}"
# Generous hard wall-clock cap, sized for a slow xhigh run (subscription latency
# varies — a trivial reply was observed taking minutes). Raise for a known-healthy
# long run; lowering it only risks killing real work.
CODEX_HARD_TIMEOUT="${CODEX_HARD_TIMEOUT:-3600}"
CHATGPT_LOGIN_GUARD="Logged in using ChatGPT"

# --- Quality-first guard: refuse a silent model/effort downgrade ---------------
# Real delegated runs must use the frontier model at max effort. A throwaway probe
# (effort-independent result) may opt out with CODEX_PROBE=1, announced loudly.
if [[ "${CODEX_PROBE:-}" == "1" ]]; then
  echo "warning: CODEX_PROBE=1 — THROWAWAY PROBE MODE. Quality guards relaxed; do NOT use this run's" >&2
  echo "         output as real delegated work (model='$CODEX_MODEL' effort='$CODEX_EFFORT')." >&2
else
  if [[ "$CODEX_MODEL" != "$DEFAULT_CODEX_MODEL" ]]; then
    echo "error: CODEX_MODEL='$CODEX_MODEL' is not the pinned frontier model '$DEFAULT_CODEX_MODEL'." >&2
    echo "       Delegated codex work must run on the frontier model at max effort (quality-first)." >&2
    echo "       For a throwaway probe whose result is effort-independent, set CODEX_PROBE=1." >&2
    exit 2
  fi
  if [[ "$CODEX_EFFORT" != "$DEFAULT_CODEX_EFFORT" ]]; then
    echo "error: CODEX_EFFORT='$CODEX_EFFORT' is not the pinned max effort '$DEFAULT_CODEX_EFFORT'." >&2
    echo "       Delegated codex work must run at max reasoning effort (quality-first)." >&2
    echo "       For a throwaway probe whose result is effort-independent, set CODEX_PROBE=1." >&2
    exit 2
  fi
fi

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
2. Obey EVERY Hard Constraint declared in the project's root AGENTS.md (already
   merged into your context) and this task's own "do NOT" / out-of-scope section.
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

# This wrapper OWNS the safety + quality policy. Reject passthrough flags in two
# tiers:
#  (1) ALWAYS rejected — they would defeat the subscription / sandbox / approval /
#      config-isolation policy (-c/-s/--full-auto/bypass), switch the provider off
#      the subscription (--oss/--local-provider), load alternate config (-p/--profile),
#      override the pinned frontier model (-m), or break the wrapper-owned clean
#      output / session capture (-o/--json/--color/--output-schema/--ephemeral).
#      CODEX_PROBE=1 NEVER relaxes these: a probe still runs on the subscription, in
#      the sandbox, with clean capture; its model is chosen via CODEX_MODEL, not -m.
#  (2) Probe-relaxable — context/discovery knobs the wrapper otherwise pins; a
#      throwaway probe (CODEX_PROBE=1) may pass them. Need more? invoke `codex` direct.
if [[ ${#passthrough[@]} -gt 0 ]]; then
  for _arg in "${passthrough[@]}"; do
    case "$_arg" in
      -c*|--config*|-s*|--sandbox*|--dangerously-bypass-approvals-and-sandbox|--dangerously-bypass-hook-trust|--full-auto|--oss|--local-provider*|-p*|--profile*|-m*|--model*|-o*|--output-last-message*|--json*|--color*|--output-schema*|--ephemeral*)
        echo "error: passthrough flag '$_arg' is not allowed — it would defeat the subscription / sandbox /" >&2
        echo "       approval / config-isolation policy, the pinned frontier model, or the clean output/session" >&2
        echo "       capture. It stays blocked even under CODEX_PROBE=1. Invoke 'codex' directly if you must." >&2
        exit 2
        ;;
      --add-dir*|-C*|--cd*|--skip-git-repo-check|--ignore-rules|--enable*|--disable*)
        if [[ "${CODEX_PROBE:-}" != "1" ]]; then
          echo "error: passthrough flag '$_arg' is not allowed — this wrapper pins the model & context." >&2
          echo "       Set CODEX_PROBE=1 for a throwaway probe, or invoke 'codex' directly." >&2
          exit 2
        fi
        ;;
    esac
  done
fi

if [[ "$prompt_src" == "-" ]]; then
  task="$(cat)"
elif [[ -f "$prompt_src" ]]; then
  task="$(cat -- "$prompt_src")"
else
  echo "error: '$prompt_src' is not a file (use '-' to read the prompt from stdin)" >&2
  exit 2
fi

if [[ -z "${task//[[:space:]]/}" ]]; then
  echo "error: empty plan/instruction" >&2
  exit 2
fi

# --- Clean output capture: final message to $out, JSON event stream to $trace --
# `-o` writes ONLY codex's final message; `--json` streams structured events
# (thread.started carries the session id; turn.completed carries usage). CoT is
# dropped (hide_agent_reasoning + reasoning_summary=none) and colour disabled, so
# the captured surfaces stay clean. Reasoning still runs at xhigh — quality is
# unchanged; we only stop printing the noise.
# Register the cleanup trap BEFORE allocating, so a failing second mktemp under
# `set -e` cannot leak the first temp file.
out=""
trace=""
trap 'rm -f "$out" "$trace" 2>/dev/null || true' EXIT
out="$(mktemp)"
trace="$(mktemp)"

codex_cmd=(codex exec
  --ignore-user-config
  --sandbox workspace-write
  -c approval_policy="never"
  -c sandbox_workspace_write.network_access=false
  -c model_reasoning_effort="$CODEX_EFFORT"
  -c hide_agent_reasoning=true
  -c model_reasoning_summary=none
  --color never
  -o "$out"
  --json
  -m "$CODEX_MODEL"
  "${passthrough[@]+"${passthrough[@]}"}"
  -)

# --- Hard wall-clock cap via timeout(1) (gtimeout on macOS) -------------------
# A backgrounded, hung codex run survives otherwise. --kill-after SIGKILLs 15s
# after the initial TERM if codex ignores it (a live probe confirmed plain
# `timeout` reaps the whole codex child tree — no --foreground needed). If neither
# binary exists we warn loudly and run uncapped rather than fail silently.
timeout_bin=""
if command -v timeout >/dev/null 2>&1; then
  timeout_bin="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin="gtimeout"
fi

set +e
if [[ -n "$timeout_bin" ]]; then
  printf '%s\n\n%s' "$ORCHESTRATOR_DIRECTIVE" "$task" \
    | "$timeout_bin" --kill-after=15s "$CODEX_HARD_TIMEOUT" "${codex_cmd[@]}" >"$trace" 2>&1
  rc=$?
else
  echo "warning: no 'timeout'/'gtimeout' on PATH — running codex WITHOUT a hard wall-clock cap" >&2
  echo "         (install coreutils to enable CODEX_HARD_TIMEOUT=$CODEX_HARD_TIMEOUT)." >&2
  printf '%s\n\n%s' "$ORCHESTRATOR_DIRECTIVE" "$task" \
    | "${codex_cmd[@]}" >"$trace" 2>&1
  rc=$?
fi
set -e

if [[ $rc -eq 124 || $rc -eq 137 ]]; then
  echo "error: codex exec exceeded the hard cap CODEX_HARD_TIMEOUT=${CODEX_HARD_TIMEOUT}s and was terminated." >&2
  echo "       Raise CODEX_HARD_TIMEOUT for a known-healthy slow run, or narrow the task, then re-dispatch." >&2
  exit $rc
fi
if [[ $rc -ne 0 ]]; then
  echo "error: codex exec failed (exit $rc). Last lines of the run trace:" >&2
  tail -n 40 "$trace" >&2
  exit $rc
fi

# Success: capture the session id from the thread.started event BEFORE the trap
# removes $trace, so an iterative resume (codex-exec --resume-last) can find it.
session_id="$(grep -m1 '"type":"thread.started"' "$trace" 2>/dev/null \
  | grep -o '"thread_id":"[^"]*"' | cut -d'"' -f4 || true)"
if [[ -n "$session_id" ]]; then
  sidecar="${CODEX_SESSION_FILE:-$PWD/.codex-last-session}"
  if ! printf '%s\n' "$session_id" >"$sidecar" 2>/dev/null; then
    echo "warning: could not write the session sidecar '$sidecar' — 'codex-exec --resume-last' won't find this id." >&2
  fi
  echo "session: $session_id" >&2
fi

if [[ -f "$out" && -s "$out" ]]; then
  cat "$out"
else
  echo "warning: codex produced no final-message file — printing the run-trace tail instead." >&2
  tail -n 40 "$trace"
fi
