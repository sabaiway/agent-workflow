#!/usr/bin/env bash
# Read-only ADVISORY review BY the OpenAI Codex CLI. Runs under the read-only
# sandbox, so codex structurally CANNOT edit/create/delete files or write to git
# — it can only read and emit findings. The orchestrator reads those findings and
# decides what to act on; codex never applies them itself.
#
# Project-agnostic wrapper for the codex-cli-bridge skill. Codex reads the target
# project's Hard Constraints itself, from the root AGENTS.md in its cwd.
#
# Modes:
#   codex-review plan <plan-file>       # critique an implementation plan
#   codex-review code [extra focus...]  # review the current working-tree diff
#
# Auth/policy: subscription-only, identical to codex-exec.sh. The read-only
# sandbox grants no writes and no network in v0.140.0, so review needs no separate
# network flag (the sandbox_workspace_write.* config applies only to workspace-write).
set -euo pipefail

CODEX_MODEL="${CODEX_MODEL:-gpt-5.5}"
CODEX_EFFORT="${CODEX_EFFORT:-xhigh}"
CHATGPT_LOGIN_GUARD="Logged in using ChatGPT"

# --- Subscription-only guard (see codex-exec.sh) -----------------------------
unset OPENAI_API_KEY CODEX_API_KEY OPENAI_BASE_URL 2>/dev/null || true
while IFS= read -r _api_key_var; do
  unset "$_api_key_var" 2>/dev/null || true
done < <(compgen -v 2>/dev/null | grep '_API_KEY$' || true)

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
    directive="You are REVIEWING an implementation plan — ADVISORY ONLY. You are in a read-only sandbox: do NOT edit, create, or delete any file, and do NOT rewrite the plan. Read the plan below, the project's root AGENTS.md, and the relevant repository code it references. Output findings ONLY, one per line, as: [blocker|major|minor|nit] — location — issue — suggested change. Cover: correctness risks, missing or mis-ordered steps, ambiguities a cold executor would trip on, violated project Hard Constraints (AGENTS.md), scope creep, and missing verification/gates. End with a one-line overall verdict (ship / revise / rethink)."
    prompt="${directive}"$'\n\nPLAN:\n'"$(cat "$target")"
    ;;
  code)
    directive="You are REVIEWING the current uncommitted working-tree changes — ADVISORY ONLY. You are in a read-only sandbox: do NOT edit, create, or delete any file and do NOT run any git write command. Run \`git status --short\` to list ALL changes, \`git diff\` for the tracked changes, and for every path marked \`??\` by git status READ that file's full contents (plain \`git diff\` omits untracked files). Also read the project's root AGENTS.md. Then output findings ONLY, one per line, as: [blocker|major|minor|nit] — file:line — issue — suggested fix. Focus on correctness bugs, project Hard Constraints (AGENTS.md), behaviour drift vs the intended change, and test/gate gaps. End with a one-line overall verdict (ship / revise / rethink)."
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

printf '%s' "$prompt" | codex exec \
  --ignore-user-config \
  --sandbox read-only \
  -c approval_policy="never" \
  -c model_reasoning_effort="$CODEX_EFFORT" \
  -m "$CODEX_MODEL" \
  -
