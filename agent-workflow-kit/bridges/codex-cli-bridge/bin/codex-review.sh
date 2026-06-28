#!/usr/bin/env bash
# Read-only ADVISORY review BY the OpenAI Codex CLI. Runs under the read-only
# sandbox, so codex structurally CANNOT edit/create/delete files or write to git
# — it can only read and emit findings. The orchestrator reads those findings and
# decides what to act on; codex never applies them itself.
#
# Project-agnostic wrapper for the codex-cli-bridge skill. Codex reads the target
# project's Hard Constraints from the root AGENTS.md auto-merged into its context.
#
# Modes:
#   codex-review plan <plan-file>       # critique an implementation plan
#   codex-review code [extra focus...]  # review the current working-tree diff
#
# Auth/policy: subscription-only, identical to codex-exec.sh. Quality-first: the
# review runs on the frontier model at max effort (advisory findings still bear on
# what ships, so the same no-downgrade guard applies; CODEX_PROBE=1 relaxes it for
# a throwaway probe only).
#
# Best-effort read hygiene: the review runs under a temporary HOME / XDG_* with an
# ABSOLUTE CODEX_HOME so codex auth + history still resolve, but its default config
# / cache / skill-scan roots point at a throwaway dir instead of the real $HOME.
# This trims roaming noise; it is NOT a security boundary (absolute paths anywhere
# on disk remain readable under read-only — read-scoping is a prompt concern).
set -euo pipefail

DEFAULT_CODEX_MODEL="gpt-5.5"
DEFAULT_CODEX_EFFORT="xhigh"
CODEX_MODEL="${CODEX_MODEL:-$DEFAULT_CODEX_MODEL}"
CODEX_EFFORT="${CODEX_EFFORT:-$DEFAULT_CODEX_EFFORT}"
# Generous hard cap for a slow xhigh review (subscription latency varies).
CODEX_HARD_TIMEOUT="${CODEX_HARD_TIMEOUT:-1800}"
CHATGPT_LOGIN_GUARD="Logged in using ChatGPT"

# --- Quality-first guard: refuse a silent model/effort downgrade ---------------
if [[ "${CODEX_PROBE:-}" == "1" ]]; then
  echo "warning: CODEX_PROBE=1 — THROWAWAY PROBE MODE. Quality guards relaxed; do NOT use this run's" >&2
  echo "         output as a real review (model='$CODEX_MODEL' effort='$CODEX_EFFORT')." >&2
else
  if [[ "$CODEX_MODEL" != "$DEFAULT_CODEX_MODEL" ]]; then
    echo "error: CODEX_MODEL='$CODEX_MODEL' is not the pinned frontier model '$DEFAULT_CODEX_MODEL'." >&2
    echo "       A delegated review must run on the frontier model at max effort (quality-first)." >&2
    echo "       For a throwaway probe whose result is effort-independent, set CODEX_PROBE=1." >&2
    exit 2
  fi
  if [[ "$CODEX_EFFORT" != "$DEFAULT_CODEX_EFFORT" ]]; then
    echo "error: CODEX_EFFORT='$CODEX_EFFORT' is not the pinned max effort '$DEFAULT_CODEX_EFFORT'." >&2
    echo "       A delegated review must run at max reasoning effort (quality-first)." >&2
    echo "       For a throwaway probe whose result is effort-independent, set CODEX_PROBE=1." >&2
    exit 2
  fi
fi

# --- Subscription-only guard (see codex-exec.sh) -----------------------------
unset OPENAI_API_KEY CODEX_API_KEY OPENAI_BASE_URL 2>/dev/null || true
while IFS= read -r _api_key_var; do
  unset "$_api_key_var" 2>/dev/null || true
done < <(compgen -v 2>/dev/null | grep '_API_KEY$' || true)

# Resolve the real CODEX_HOME (where the cached ChatGPT login lives) to an ABSOLUTE
# path BEFORE the env fence repoints HOME — auth must keep resolving.
real_codex_home="${CODEX_HOME:-$HOME/.codex}"
case "$real_codex_home" in
  "~")    real_codex_home="$HOME" ;;                          # literal tilde
  "~/"*)  real_codex_home="$HOME/${real_codex_home#"~/"}" ;;  # unexpanded ~/...
  /*)     : ;;                                                # already absolute
  *)      real_codex_home="$PWD/$real_codex_home" ;;          # relative → anchor
esac

# --- Environment preflight (fail fast) ---------------------------------------
if ! command -v codex >/dev/null 2>&1; then
  echo "error: 'codex' (OpenAI Codex CLI) not found on PATH. See this skill's setup/README.md." >&2
  exit 127
fi
if ! codex login status 2>&1 | grep -qF "$CHATGPT_LOGIN_GUARD"; then
  echo "error: codex is not on a ChatGPT subscription (expected '$CHATGPT_LOGIN_GUARD'). Run 'codex login' once." >&2
  exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: codex-review must run inside a git working tree." >&2
  exit 2
fi
if [[ ! -f AGENTS.md ]]; then
  echo "error: no root AGENTS.md in the current directory — run from the target project root." >&2
  exit 2
fi

# Read-fence prompt line (best-effort; the env fence trims roaming, this states intent).
READ_FENCE_LINE="Do not read files outside this git working tree; the diff and the in-repo code are your whole surface."

mode="${1:-}"
shift || true

case "$mode" in
  plan)
    target="${1:-}"
    shift || true
    if [[ ! -f "$target" ]]; then
      echo "error: plan file '$target' not found" >&2
      exit 2
    fi
    if [[ $# -gt 0 ]]; then
      echo "error: unexpected arguments after plan file: $*" >&2
      exit 2
    fi
    directive="You are REVIEWING an implementation plan — ADVISORY ONLY. You are in a read-only sandbox: do NOT edit, create, or delete any file, and do NOT rewrite the plan. Obey the project's Hard Constraints from its root AGENTS.md (already merged into your context). Read the plan below and the relevant repository code it references. ${READ_FENCE_LINE} Output findings ONLY, one per line, as: [blocker|major|minor|nit] — location — issue — suggested change. Cover: correctness risks, missing or mis-ordered steps, ambiguities a cold executor would trip on, violated project Hard Constraints, scope creep, and missing verification/gates. End with a one-line overall verdict (ship / revise / rethink)."
    prompt="${directive}"$'\n\nPLAN:\n'"$(cat -- "$target")"
    ;;
  code)
    directive="You are REVIEWING the current uncommitted working-tree changes — ADVISORY ONLY. You are in a read-only sandbox: do NOT edit, create, or delete any file and do NOT run any git write command. Run \`git status --short\` to list ALL changes, \`git diff\` for the tracked changes, and for every path marked \`??\` by git status READ that file's full contents (plain \`git diff\` omits untracked files). Obey the project's Hard Constraints from its root AGENTS.md (already merged into your context). ${READ_FENCE_LINE} Then output findings ONLY, one per line, as: [blocker|major|minor|nit] — file:line — issue — suggested fix. Focus on correctness bugs, project Hard Constraints, behaviour drift vs the intended change, and test/gate gaps. End with a one-line overall verdict (ship / revise / rethink)."
    if [[ $# -gt 0 ]]; then
      directive="${directive} Extra focus: $*"
    fi
    prompt="$directive"
    ;;
  *)
    echo "usage: $0 plan <plan-file> | code [extra focus...]" >&2
    exit 2
    ;;
esac

# --- Best-effort env read-fence ----------------------------------------------
# A throwaway HOME + XDG roots so codex's default config / cache / skill-scan land
# in an empty dir (trims the ~MB roaming + skill-scan noise), while an ABSOLUTE
# CODEX_HOME keeps the subscription login + history reachable (probe-confirmed).
# Register the cleanup trap BEFORE allocating, so a failing later mktemp under
# `set -e` cannot leak an earlier temp dir/file.
fence_home=""
out=""
trace=""
trap 'rm -rf "$fence_home" 2>/dev/null; rm -f "$out" "$trace" 2>/dev/null; true' EXIT
fence_home="$(mktemp -d)"
out="$(mktemp)"
trace="$(mktemp)"
mkdir -p "$fence_home/.config" "$fence_home/.cache" "$fence_home/.local/share"

codex_cmd=(codex exec
  --ignore-user-config
  --sandbox read-only
  -c approval_policy="never"
  -c model_reasoning_effort="$CODEX_EFFORT"
  -c hide_agent_reasoning=true
  -c model_reasoning_summary=none
  --color never
  -o "$out"
  --json
  -m "$CODEX_MODEL"
  -)

fence_env=(env
  HOME="$fence_home"
  XDG_CONFIG_HOME="$fence_home/.config"
  XDG_CACHE_HOME="$fence_home/.cache"
  XDG_DATA_HOME="$fence_home/.local/share"
  CODEX_HOME="$real_codex_home")

# --- Hard wall-clock cap via timeout(1) (gtimeout on macOS) -------------------
timeout_bin=""
if command -v timeout >/dev/null 2>&1; then
  timeout_bin="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin="gtimeout"
fi

set +e
if [[ -n "$timeout_bin" ]]; then
  printf '%s' "$prompt" \
    | "${fence_env[@]}" "$timeout_bin" --kill-after=15s "$CODEX_HARD_TIMEOUT" "${codex_cmd[@]}" >"$trace" 2>&1
  rc=$?
else
  echo "warning: no 'timeout'/'gtimeout' on PATH — running codex WITHOUT a hard wall-clock cap" >&2
  echo "         (install coreutils to enable CODEX_HARD_TIMEOUT=$CODEX_HARD_TIMEOUT)." >&2
  printf '%s' "$prompt" \
    | "${fence_env[@]}" "${codex_cmd[@]}" >"$trace" 2>&1
  rc=$?
fi
set -e

if [[ $rc -eq 124 || $rc -eq 137 ]]; then
  echo "error: codex review exceeded the hard cap CODEX_HARD_TIMEOUT=${CODEX_HARD_TIMEOUT}s and was terminated." >&2
  echo "       Raise CODEX_HARD_TIMEOUT for a known-healthy slow review, or narrow the focus, then retry." >&2
  exit $rc
fi
if [[ $rc -ne 0 ]]; then
  echo "error: codex review failed (exit $rc). Last lines of the run trace:" >&2
  tail -n 40 "$trace" >&2
  exit $rc
fi

# Surface the session id (stderr only — a review session is one-shot; never write
# the shared .codex-last-session sidecar, which is codex-exec's resume target).
session_id="$(grep -m1 '"type":"thread.started"' "$trace" 2>/dev/null \
  | grep -o '"thread_id":"[^"]*"' | cut -d'"' -f4 || true)"
if [[ -n "$session_id" ]]; then
  echo "session: $session_id" >&2
fi

if [[ -f "$out" && -s "$out" ]]; then
  cat "$out"
else
  echo "warning: codex produced no final-message file — printing the run-trace tail instead." >&2
  tail -n 40 "$trace"
fi
