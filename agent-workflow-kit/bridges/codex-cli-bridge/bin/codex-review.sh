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
# For `code`, the wrapper PRECOMPUTES the full change set (repo map, git status,
# staged + unstaged diffs, untracked file CONTENTS — binaries skipped, symlinks
# shown as targets, other non-regular paths skipped) and feeds it in, so codex does
# not burn a run rediscovering it by roaming the filesystem. A clean tree exits 0
# BEFORE a run is spent; an oversized payload goes via a git-dir-local temp file
# (never silently truncated). Optionally (CODEX_REVIEW_SCHEMA=1) the findings come
# back as a validated JSON object, with a raw-text fallback.
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

# --- --help / -h (pre-preflight: no codex, no login, no git tree needed) -------
# Keyed ONLY on the FIRST argument — never a scan of all args (uniform rule across
# the four wrappers, so an open wrapper's passthrough payload is never intercepted).
# The contract below is drift-guarded against capability.json roles.review.contract.
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
codex-review — read-only ADVISORY review by the OpenAI Codex CLI (subscription-only; frontier model at max effort).

Usage:
  codex-review plan <plan-file>
  codex-review code [extra focus...]

Grounding:
  automatic — the wrapper precomputes the full working-tree change set (repo map,
  status, diffs, untracked contents) and codex auto-merges the root AGENTS.md;
  no grounding flags

Round-2 / resume:
  (none — one-shot; a follow-up review is a fresh run)

Environment: CODEX_REVIEW_SCHEMA=1 (structured JSON findings), CODEX_HARD_TIMEOUT (seconds, default 1800), CODEX_PROBE=1 (throwaway probe only).
Requires at run time: the codex CLI on PATH, a ChatGPT-subscription login, a git work tree with a root AGENTS.md (--help needs none of these).
HELP
    exit 0
    ;;
esac

DEFAULT_CODEX_MODEL="gpt-5.5"
DEFAULT_CODEX_EFFORT="xhigh"
CODEX_MODEL="${CODEX_MODEL:-$DEFAULT_CODEX_MODEL}"
CODEX_EFFORT="${CODEX_EFFORT:-$DEFAULT_CODEX_EFFORT}"
# Generous hard cap for a slow xhigh review (subscription latency varies).
CODEX_HARD_TIMEOUT="${CODEX_HARD_TIMEOUT:-1800}"
# Above this assembled-payload size (bytes), the diff goes via a git-dir-local temp
# file instead of inline — never truncated.
CODEX_REVIEW_MAX_TOTAL_BYTES="${CODEX_REVIEW_MAX_TOTAL_BYTES:-1500000}"
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

# Register the cleanup trap up front (before allocating any temp path), so a
# failure mid-assembly cannot leak the diff temp file, the schema, or the fence.
fence_home=""
out=""
trace=""
schema_file=""
review_diff_file=""
trap 'rm -rf "$fence_home" 2>/dev/null; rm -f "$out" "$trace" "$schema_file" "$review_diff_file" 2>/dev/null; true' EXIT

# Output-format instruction — schema-aware so it never contradicts the structured
# mode. When CODEX_REVIEW_SCHEMA=1 the model must return schema-shaped JSON; else
# the classic one-finding-per-line text.
if [[ "${CODEX_REVIEW_SCHEMA:-}" == "1" ]]; then
  _json_fmt="Return your review STRICTLY as a JSON object matching the provided output schema: a \"findings\" array (each item: \"severity\" one of blocker|major|minor|nit, plus \"location\", \"issue\", \"suggested_change\", and optional \"evidence\"), an overall \"verdict\" (ship|revise|rethink), and optional free-text \"notes\"."
  OUTPUT_FORMAT_CODE="$_json_fmt"
  OUTPUT_FORMAT_PLAN="$_json_fmt"
else
  OUTPUT_FORMAT_CODE="Output findings ONLY, one per line, as: [blocker|major|minor|nit] — file:line — issue — suggested fix. End with a one-line overall verdict (ship / revise / rethink)."
  OUTPUT_FORMAT_PLAN="Output findings ONLY, one per line, as: [blocker|major|minor|nit] — location — issue — suggested change. End with a one-line overall verdict (ship / revise / rethink)."
fi

# True (exit 0) when $1 looks BINARY: a NUL byte in the first 8 KiB (git's own
# heuristic). `tr -dc` keeps ONLY NUL bytes, `wc -c` counts them — never captures
# NUL into a variable. Empty / text files → not binary.
is_binary() {
  local nul
  nul="$(LC_ALL=C head -c 8192 -- "$1" 2>/dev/null | LC_ALL=C tr -dc '\000' | wc -c)"
  [[ "${nul:-0}" -gt 0 ]]
}

# Emit the full review surface to stdout: repo map, status, staged + unstaged
# diffs, and the CONTENTS of every untracked REGULAR file (NUL-safe iteration).
# Symlinks are shown as their target (never followed — no out-of-repo leak); other
# non-regular paths (FIFO/socket/device) are skipped (a `cat` on a FIFO would hang
# BEFORE the codex hard timeout applies).
assemble_code_diff() {
  echo "=== repo file map (git ls-files) ==="
  git ls-files
  echo
  echo "=== git status (porcelain) ==="
  git status --porcelain=v1
  echo
  echo "=== staged diff (git diff --cached) ==="
  git diff --cached --no-ext-diff
  echo
  echo "=== unstaged diff (git diff) ==="
  git diff --no-ext-diff
  echo
  echo "=== untracked file contents ==="
  local path
  while IFS= read -r -d '' path; do
    if [[ -L "$path" ]]; then
      printf '=== untracked (symlink): %s -> %s ===\n' "$path" "$(readlink -- "$path" 2>/dev/null || echo '?')"
    elif [[ ! -f "$path" ]]; then
      printf '=== untracked (non-regular, skipped): %s ===\n' "$path"
    elif is_binary "$path"; then
      printf '=== untracked (binary, skipped): %s ===\n' "$path"
    else
      printf '=== untracked: %s ===\n' "$path"
      cat -- "$path"
      printf '\n'
    fi
  done < <(git ls-files --others --exclude-standard -z)
}

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
    fence_plan="Do not read files outside this git working tree; the plan above plus the in-repo code it references are your whole surface."
    directive="You are REVIEWING an implementation plan — ADVISORY ONLY. You are in a read-only sandbox: do NOT edit, create, or delete any file, and do NOT rewrite the plan. Obey the project's Hard Constraints from its root AGENTS.md (already merged into your context). Read the plan below and the relevant repository code it references. ${fence_plan} ${OUTPUT_FORMAT_PLAN} Cover: correctness risks, missing or mis-ordered steps, ambiguities a cold executor would trip on, violated project Hard Constraints, scope creep, and missing verification/gates."
    prompt="${directive}"$'\n\nPLAN:\n'"$(cat -- "$target")"
    ;;
  code)
    # No-diff preflight — never spend a subscription run on a clean tree.
    if git diff --quiet && git diff --cached --quiet \
       && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then
      echo "codex-review: no uncommitted changes to review — the working tree is clean." >&2
      exit 0
    fi
    # Assemble DIRECTLY to a git-dir-local temp file (git-invisible + worktree /
    # submodule safe; 600 perms). Measuring size from the file keeps the whole
    # change set off the bash-variable path (no NUL drop, byte-accurate size).
    git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null || git rev-parse --git-dir)"
    review_diff_file="$git_dir/codex-review-diff.$$"
    ( umask 077; assemble_code_diff >"$review_diff_file" )
    payload_bytes="$(wc -c <"$review_diff_file")"
    base_directive="You are REVIEWING the uncommitted working-tree changes of a git repository — ADVISORY ONLY. You are in a read-only sandbox: do NOT edit, create, or delete any file and do NOT run any git write command. The COMPLETE change set (repo file map, git status, staged + unstaged diffs, and untracked file contents — binaries noted but skipped, symlinks shown as targets) has been assembled FOR you; you do NOT need to run git yourself, though you MAY read other in-repo files for surrounding context. Obey the project's Hard Constraints from its root AGENTS.md (already merged into your context)."
    if [[ "$payload_bytes" -gt "$CODEX_REVIEW_MAX_TOTAL_BYTES" ]]; then
      fence_code="Do not read files outside this git working tree, with ONE exception — the precomputed-diff file at ${review_diff_file}; read it IN FULL before reviewing. That file plus the in-repo code are your whole surface."
      directive="${base_directive} ${fence_code} ${OUTPUT_FORMAT_CODE}"
      if [[ $# -gt 0 ]]; then directive="${directive} Extra focus: $*"; fi
      prompt="$directive"
    else
      fence_code="Do not read files outside this git working tree; the assembled change set below plus the in-repo code are your whole surface."
      directive="${base_directive} ${fence_code} ${OUTPUT_FORMAT_CODE}"
      if [[ $# -gt 0 ]]; then directive="${directive} Extra focus: $*"; fi
      prompt="${directive}"$'\n\nASSEMBLED CHANGE SET:\n'"$(cat -- "$review_diff_file")"
    fi
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
fence_home="$(mktemp -d)"
out="$(mktemp)"
trace="$(mktemp)"
mkdir -p "$fence_home/.config" "$fence_home/.cache" "$fence_home/.local/share"

# --- Optional structured findings (CODEX_REVIEW_SCHEMA=1) ---------------------
# A FLEXIBLE schema (optional evidence, free-text notes) so codex can almost always
# conform (a live probe confirmed --output-schema CONSTRAINS the output rather than
# failing); a raw-text retry covers the rare validation/run failure. Default OFF.
codex_flags=(codex exec
  --ignore-user-config
  --sandbox read-only
  -c approval_policy="never"
  -c model_reasoning_effort="$CODEX_EFFORT"
  -c hide_agent_reasoning=true
  -c model_reasoning_summary=none
  --color never
  -o "$out"
  --json
  -m "$CODEX_MODEL")
if [[ "${CODEX_REVIEW_SCHEMA:-}" == "1" ]]; then
  schema_file="$(mktemp)"
  cat >"$schema_file" <<'SCHEMA'
{
  "type": "object",
  "additionalProperties": false,
  "required": ["findings", "verdict"],
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "location", "issue", "suggested_change"],
        "properties": {
          "severity": { "type": "string", "enum": ["blocker", "major", "minor", "nit"] },
          "location": { "type": "string" },
          "issue": { "type": "string" },
          "suggested_change": { "type": "string" },
          "evidence": { "type": "string" }
        }
      }
    },
    "verdict": { "type": "string", "enum": ["ship", "revise", "rethink"] },
    "notes": { "type": "string" }
  }
}
SCHEMA
  codex_flags+=(--output-schema "$schema_file")
fi

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
if [[ -z "$timeout_bin" ]]; then
  echo "warning: no 'timeout'/'gtimeout' on PATH — running codex WITHOUT a hard wall-clock cap" >&2
  echo "         (install coreutils to enable CODEX_HARD_TIMEOUT=$CODEX_HARD_TIMEOUT)." >&2
fi

# Run codex with the current ${codex_cmd[@]}; capture rc, stream → $trace.
invoke_codex() {
  set +e
  if [[ -n "$timeout_bin" ]]; then
    printf '%s' "$prompt" \
      | "${fence_env[@]}" "$timeout_bin" --kill-after=15s "$CODEX_HARD_TIMEOUT" "${codex_cmd[@]}" >"$trace" 2>&1
    rc=$?
  else
    printf '%s' "$prompt" \
      | "${fence_env[@]}" "${codex_cmd[@]}" >"$trace" 2>&1
    rc=$?
  fi
  set -e
}

codex_cmd=("${codex_flags[@]}" -)
invoke_codex

# Raw-text fallback: if the structured-findings run failed (not a timeout), retry
# once WITHOUT the schema rather than lose the review — loud, never silent.
if [[ -n "$schema_file" && $rc -ne 0 && $rc -ne 124 && $rc -ne 137 ]]; then
  echo "warning: the --output-schema run failed (exit $rc) — retrying once without the schema constraint." >&2
  codex_cmd=()
  for _f in "${codex_flags[@]}"; do
    [[ "$_f" == "--output-schema" || "$_f" == "$schema_file" ]] && continue
    codex_cmd+=("$_f")
  done
  codex_cmd+=(-)
  invoke_codex
fi

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
