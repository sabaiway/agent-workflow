#!/usr/bin/env bash
# Grounded read-only ADVISORY review BY Google's Antigravity CLI (`agy`).
#
# Project-agnostic wrapper for the antigravity-cli-bridge skill (review role). It
# MECHANIZES the grounded-review contract so grounding is the enforced default,
# not an ad-hoc per-call effort. `agy` reads NOTHING by default (the wrapper
# passes no --add-dir), and its training predates the current codebase/model
# facts, so an ungrounded `agy` review GUESSES — stale-model false positives
# ("that model doesn't exist") and partial-diff false positives ("missing code").
# The fix is the agy analog of codex's precomputed diff: feed agy a self-contained
# prompt of VERIFIED FACTS plus the full artifact, and forbid model/cutoff opining.
#
# Assembled prompt (byte-stable order):
#   1. POSTURE   read-only second-opinion reviewer; findings only, no edits/commits
#   2. GUARD     do NOT opine on AI model names/versions or your knowledge cutoff
#   3. FACTS     "## Grounded facts — review AGAINST these, do NOT guess the code"
#                (omitted -> a one-line note in-prompt + a LOUD stderr warning)
#   4. DECIDED   "## Decisions already made / already addressed — do NOT re-raise"
#                (optional; the anti-circling lever — the round-2 payload)
#   5. FOCUS     the merged --focus / trailing focus text (optional)
#   6. ARTIFACT  the working-tree change set (code) | a supplied plan/diff file
#   7. SHAPE     strict Markdown output shape (Verdict / Blocking / Non-blocking / Questions)
#
# Execution is DELEGATED to `agy-run` (bin/agy.sh) so the hard-timeout cap, the
# subscription invariant, and the single-argv byte ceiling live in exactly one
# place. The orchestrator supplies only what a script can't generate: the verified
# facts (--facts), the already-decided list (--decided), and the focus (--focus).
#
# Usage (installed on PATH as `agy-review`):
#   agy-review code   [--facts @f] [--decided @f] [--focus "…"] [extra focus…]
#   agy-review plan   <plan-file> [--facts @f] [--decided @f] [--focus "…"]
#   agy-review diff   <diff-file> [--facts @f] [--decided @f] [--focus "…"]
#   agy-review --continue          [--decided @f] [--focus "…"]   # round-2 delta (no mode, no re-assembly)
#   agy-review --conversation <id> [--decided @f] [--focus "…"]   # resume a specific conversation
#
# Environment (every optional var has an explicit default so a no-env run is safe under set -u):
#   AGY_MODEL                default "Gemini 3.1 Pro (High)"; ANY model allowed (advisory warn off-frontier).
#                            Set empty (AGY_MODEL=) to drop --model and use agy's settings.json.
#   AGY_HARD_TIMEOUT         default 30m  (duration string; the timeout(1) hard cap via agy-run)
#   AGY_TIMEOUT              default = AGY_HARD_TIMEOUT (agy's soft --print-timeout)
#   AGY_MAX_PROMPT_BYTES     default 120000 (single-argv byte ceiling; see agy.sh)
#   AGY_PROBE=1              throwaway probe — silences the off-frontier model advisory
#   AGY_REVIEW_ALLOW_ADDDIR=1  oversized CODE review: offload the change set to a private
#                            staging dir and pass it via --add-dir (re-enables Issue-001 stall risk)
set -euo pipefail

# --- --help / -h (pre-preflight: no agy, no login, no git tree needed) ---------
# Keyed ONLY on the FIRST argument — never a scan of all args (uniform rule across
# the four wrappers). Drift-guarded against capability.json roles.review.contract.
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
agy-review — grounded read-only ADVISORY review by Google's Antigravity CLI (agy; subscription-only).

Usage:
  agy-review code [--facts @f] [--decided @f] [--focus "…"] [extra focus…]
  agy-review plan <plan-file> [--facts @f] [--decided @f] [--focus "…"]
  agy-review diff <diff-file> [--facts @f] [--decided @f] [--focus "…"]

Flags:
  --facts @f — verified facts the review runs AGAINST (omit ⇒ loud ungrounded-review warning)
  --decided @f — already-decided / already-addressed list; do NOT re-raise (anti-circling; the round-2 payload)
  --focus "…" — extra focus (repeatable; code mode also takes trailing focus words)

Grounding:
  grounded review — agy reads NOTHING by default, an ungrounded review GUESSES:
  --facts @f = the verified facts to review AGAINST; --decided @f = decisions
  already made, do NOT re-raise (anti-circling)

Round-2 / resume:
  agy-review --continue [--decided @f] [--focus "…"]
  agy-review --conversation <id> [--decided @f] [--focus "…"]
  (a continuation sends a small delta — agy holds the artifact server-side; --facts is invalid on a continuation)

Closed grammar: unknown flags are rejected; no '--' passthrough (the only escapes are AGY_PROBE=1 and AGY_REVIEW_ALLOW_ADDDIR=1).
Requires at run time: the agy CLI on PATH + a Google AI subscription login (--help needs neither).
HELP
    exit 0
    ;;
esac

DEFAULT_AGY_REVIEW_MODEL="Gemini 3.1 Pro (High)"
# `-` not `:-` so an EXPLICIT empty AGY_MODEL= survives (drop --model, use settings.json — agy.sh:52).
AGY_MODEL="${AGY_MODEL-$DEFAULT_AGY_REVIEW_MODEL}"
# Frontier review models. ANY model is allowed; a sub-frontier one only earns a soft, silenceable warning.
FRONTIER_SET=("Gemini 3.1 Pro (High)" "Claude Opus 4.6 (Thinking)" "Claude Sonnet 4.6 (Thinking)")

# Duration-string timeouts (NOT codex's bare seconds): agy-run forwards a duration to --print-timeout,
# and the timeout(1) hard cap is a duration too — never numerically compared, so 30m vs 2h is fine.
AGY_HARD_TIMEOUT="${AGY_HARD_TIMEOUT:-30m}"
AGY_TIMEOUT="${AGY_TIMEOUT:-$AGY_HARD_TIMEOUT}"
AGY_PROBE="${AGY_PROBE:-0}"
AGY_REVIEW_ALLOW_ADDDIR="${AGY_REVIEW_ALLOW_ADDDIR:-0}"
AGY_MAX_PROMPT_BYTES="${AGY_MAX_PROMPT_BYTES:-120000}"
if [[ ! "$AGY_MAX_PROMPT_BYTES" =~ ^[0-9]+$ ]]; then
  echo "error: AGY_MAX_PROMPT_BYTES='$AGY_MAX_PROMPT_BYTES' is not a non-negative integer." >&2
  exit 2
fi
# The override may only TIGHTEN the ceiling — raising it past the OS single-argv limit (~131072) would
# defeat the guard (the prompt fails at exec with E2BIG). Reject above a safe hard maximum (matches agy.sh).
AGY_ARGV_HARD_MAX=131000
if (( AGY_MAX_PROMPT_BYTES > AGY_ARGV_HARD_MAX )); then
  echo "error: AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES} exceeds the OS single-argv ceiling (~${AGY_ARGV_HARD_MAX})." >&2
  echo "       The override may LOWER the ceiling (stricter), never raise it past the OS limit." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Subscription invariant (reuse agy.sh's security pattern verbatim) --------
export PATH="$HOME/.local/bin:$PATH"
unset ANTIGRAVITY_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_API_KEY 2>/dev/null || true
while IFS= read -r _api_key_var; do
  unset "$_api_key_var" 2>/dev/null || true
done < <(compgen -v 2>/dev/null | grep '_API_KEY$' || true)

if ! command -v agy >/dev/null 2>&1; then
  echo "error: 'agy' (Antigravity CLI) not found on PATH. See this skill's setup/README.md." >&2
  exit 127
fi
# Delegate execution to agy-run (the single home of the timeout + subscription + byte-ceiling guards);
# fall back to the sibling agy.sh on a fresh checkout / hermetic test where agy-run is not yet linked.
if command -v agy-run >/dev/null 2>&1; then
  AGY_RUN="agy-run"
else
  AGY_RUN="$HERE/agy.sh"
fi

# --- Model policy (advisory, NOT a gate) -------------------------------------
is_frontier=0
for _m in "${FRONTIER_SET[@]}"; do
  [[ "$AGY_MODEL" == "$_m" ]] && { is_frontier=1; break; }
done
if [[ "$is_frontier" != "1" && "$AGY_PROBE" != "1" ]]; then
  echo "warning: reviewing with a non-frontier model '${AGY_MODEL:-<settings.json default>}' — results may be" >&2
  echo "         weaker (quality-first). Set AGY_PROBE=1 to silence, or AGY_MODEL to a frontier model." >&2
fi

# --- Output shape + grounding helpers (the wrapper is the source of truth) -----
emit_posture() {
  cat <<'POSTURE'
You are a meticulous staff-level engineer giving a read-only SECOND OPINION on a change.
You are READ-ONLY: do NOT propose to edit files, run commands, or make any git change — return
findings ONLY. Your output is advisory; the orchestrator verifies every finding and owns each change.
POSTURE
}
emit_guard() {
  cat <<'GUARD'
GUARD: Do NOT comment on AI model names/versions or your own knowledge cutoff — that is irrelevant
here and a known source of false positives. Review ONLY the engineering of the material below,
AGAINST the grounded facts. If something contradicts your training, trust the facts, not your memory.
GUARD
}
emit_shape() {
  cat <<'SHAPE'
## Output — Markdown, this exact shape, nothing else
### Verdict
One line: SHIP / SHIP WITH NITS / REWORK, plus a one-sentence reason.
### Blocking
Numbered. Correctness bugs, contract violations, data loss, security. Cite file:line. Empty? write "none".
### Non-blocking
Numbered. Simplifications, reuse, naming, missing tests. Cite file:line. Empty? write "none".
### Questions
Anything ambiguous that would change your verdict if answered.
SHAPE
}
emit_resume_reminder() {
  cat <<'REMINDER'
CONTINUE the review you already started in THIS conversation, under the SAME read-only posture: do
NOT propose edits, run commands, or make any git change — findings ONLY. The material you reviewed
is already in this conversation; do NOT ask for it again and do NOT re-review what you already
passed. This is a round-2 DELTA.
GUARD: Do NOT comment on AI model names/versions or your own knowledge cutoff — review only the engineering.
REMINDER
}

# True (exit 0) when $1 looks BINARY: a NUL byte in the first 8 KiB (git's own heuristic).
is_binary() {
  local nul
  nul="$(LC_ALL=C head -c 8192 -- "$1" 2>/dev/null | LC_ALL=C tr -dc '\000' | wc -c)"
  [[ "${nul:-0}" -gt 0 ]]
}

# Emit the full code-review surface: repo map, status, staged + unstaged diffs, and the CONTENTS of
# every untracked REGULAR file (NUL-safe iteration). Symlinks are shown as their target (never
# followed — no out-of-repo leak); other non-regular paths (FIFO/socket/device/dir) are skipped.
# Ported verbatim from codex-cli-bridge/bin/codex-review.sh.
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

# --- Resume detection (must be the FIRST argument) ---------------------------
# A continuation takes NO <mode> and assembles NO artifact (agy keeps it server-side); it accepts only
# --decided / --focus and sends a small delta. `code`/`plan`/`diff` trigger assembly, which must never
# happen on a continuation.
resume_mode=""
resume_id=""
case "${1:-}" in
  --continue)
    resume_mode="continue"; shift ;;
  --conversation)
    resume_mode="conversation"; shift
    resume_id="${1:-}"; shift || true
    if [[ -z "$resume_id" || "${resume_id:0:2}" == "--" ]]; then
      echo "error: --conversation needs a <conversation-id> argument before the flags." >&2
      exit 2
    fi ;;
esac

usage() {
  echo "usage: $0 code   [--facts @f] [--decided @f] [--focus \"…\"] [extra focus…]" >&2
  echo "       $0 plan   <plan-file> [--facts @f] [--decided @f] [--focus \"…\"]" >&2
  echo "       $0 diff   <diff-file> [--facts @f] [--decided @f] [--focus \"…\"]" >&2
  echo "       $0 --continue          [--decided @f] [--focus \"…\"]" >&2
  echo "       $0 --conversation <id> [--decided @f] [--focus \"…\"]" >&2
}

# --- Mode dispatch (non-resume) ----------------------------------------------
mode=""
target=""
PLAN_CONTENT=""
DIFF_CONTENT=""
if [[ -z "$resume_mode" ]]; then
  mode="${1:-}"; shift || true
  case "$mode" in
    code) ;;
    plan|diff)
      target="${1:-}"; shift || true
      if [[ -z "$target" ]]; then
        echo "error: $mode mode needs a <file> argument." >&2; usage; exit 2
      fi
      if [[ ! -f "$target" ]]; then
        echo "error: $mode file '$target' not found." >&2; exit 2
      fi
      # Read the target NOW (before any cd) — its path is relative to the invocation cwd.
      if [[ "$mode" == "plan" ]]; then PLAN_CONTENT="$(cat -- "$target")"; else DIFF_CONTENT="$(cat -- "$target")"; fi ;;
    *)
      usage; exit 2 ;;
  esac
fi

# --- Flag parse (--facts / --decided / --focus + trailing focus) -------------
FACTS_RAW=""
DECIDED_RAW=""
FOCUS_PARTS=()
# A value-taking flag must be followed by a real value — never end-of-args and never another flag.
# Otherwise `agy-review code --facts --focus x` would silently take "--focus" as the facts and spend a
# review on bogus grounding. ($2 is referenced only as ${2:-} so an unset value is safe under set -u.)
need_value() {  # $1 = flag name, $2 = candidate value
  if [[ -z "${2:-}" || "${2:0:2}" == "--" ]]; then
    echo "error: $1 needs a value; got '${2:-<end of args>}' (empty or a misplaced flag)." >&2
    exit 2
  fi
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --facts)
      if [[ -n "$resume_mode" ]]; then
        echo "error: --facts is not valid on a continuation (the facts are already in the conversation)." >&2
        exit 2
      fi
      need_value "$1" "${2:-}"; FACTS_RAW="$2"; shift 2 ;;
    --decided)
      need_value "$1" "${2:-}"; DECIDED_RAW="$2"; shift 2 ;;
    --focus)
      need_value "$1" "${2:-}"; FOCUS_PARTS+=("$2"); shift 2 ;;
    --)
      echo "error: this wrapper OWNS the review posture — no '--' passthrough. The only escapes are" >&2
      echo "       AGY_PROBE=1 (off-frontier model) and AGY_REVIEW_ALLOW_ADDDIR=1 (oversized code review)." >&2
      exit 2 ;;
    --*)
      echo "error: unknown flag '$1'." >&2; usage; exit 2 ;;
    *)
      if [[ -n "$resume_mode" ]]; then
        echo "error: a continuation takes no positional args (only --decided / --focus): '$1'." >&2
        exit 2
      fi
      if [[ "$mode" != "code" ]]; then
        echo "error: $mode mode takes no extra positional args — use --focus \"…\": '$1'." >&2
        exit 2
      fi
      FOCUS_PARTS+=("$1"); shift ;;
  esac
done
# Merge --focus values and trailing focus words, in parse order, into ONE focus block.
FOCUS="${FOCUS_PARTS[*]:-}"

# Resolve @file / literal for --facts and --decided NOW (cwd = invocation, before any code-mode cd).
# The `@file` existence check runs at TOP LEVEL (not inside a command substitution) so its exit-2 exits
# the whole script, not just a subshell.
FACTS_CONTENT=""
if [[ -n "$FACTS_RAW" ]]; then
  if [[ "${FACTS_RAW:0:1}" == "@" ]]; then
    _ff="${FACTS_RAW:1}"
    [[ -f "$_ff" ]] || { echo "error: --facts file '$_ff' not found." >&2; exit 2; }
    FACTS_CONTENT="$(cat -- "$_ff")"
  else
    FACTS_CONTENT="$FACTS_RAW"
  fi
fi
DECIDED_CONTENT=""
if [[ -n "$DECIDED_RAW" ]]; then
  if [[ "${DECIDED_RAW:0:1}" == "@" ]]; then
    _df="${DECIDED_RAW:1}"
    [[ -f "$_df" ]] || { echo "error: --decided file '$_df' not found." >&2; exit 2; }
    DECIDED_CONTENT="$(cat -- "$_df")"
  else
    DECIDED_CONTENT="$DECIDED_RAW"
  fi
fi

if [[ -z "$FACTS_CONTENT" && -z "$resume_mode" ]]; then
  echo "warning: no --facts supplied. agy reads NOTHING by default, so an ungrounded review GUESSES" >&2
  echo "         (stale-model and partial-diff false positives). Pass --facts @file with the verified" >&2
  echo "         facts the model must review AGAINST. Proceeding without grounding." >&2
fi

# --- Private staging dir (mode 0700, trap-cleaned) ---------------------------
# Mode-agnostic: works in all modes incl. plan/diff outside a git repo, and never exposes .git to agy.
staging=""
trap 'rm -rf "$staging" 2>/dev/null; true' EXIT
staging="$(mktemp -d)"
chmod 700 "$staging"
prompt_file="$staging/prompt"

# --- Assemble the prompt + size guard ----------------------------------------
run_passthrough=()
if [[ -n "$resume_mode" ]]; then
  # Round-2 DELTA: posture/guard reminder + new focus + restated SHAPE (so formatting holds) + decided.
  # NEVER re-send the artifact — agy keeps it in the server-side conversation.
  ( umask 077; {
      emit_resume_reminder
      echo
      if [[ -n "$FOCUS" ]]; then echo "## New focus for this round"; printf '%s\n\n' "$FOCUS"; fi
      emit_shape
      echo
      if [[ -n "$DECIDED_CONTENT" ]]; then
        echo "## Decisions already made / already addressed — do NOT re-raise these"
        printf '%s\n' "$DECIDED_CONTENT"
      fi
    } > "$prompt_file" )
  delta_bytes=$(( $(wc -c < "$prompt_file") ))
  if (( delta_bytes > AGY_MAX_PROMPT_BYTES )); then
    echo "error: the round-2 delta is ${delta_bytes} bytes, over AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES}." >&2
    echo "       A continuation must stay small (agy holds the artifact server-side). Trim --decided / --focus." >&2
    exit 2
  fi
  if [[ "$resume_mode" == "continue" ]]; then
    run_passthrough=(--continue)
  else
    run_passthrough=(--conversation "$resume_id")
  fi
else
  # code mode: assemble against the FULL repo. cd to the work-tree root FIRST so git status/diff/ls-files
  # are repo-complete (a subdir invocation would otherwise silently miss root/sibling changes). Every
  # file-path argument was already resolved/read above, before this cd.
  if [[ "$mode" == "code" ]]; then
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "error: 'agy-review code' must run inside a git working tree (the diff is the review surface)." >&2
      exit 2
    fi
    cd "$(git rev-parse --show-toplevel)"
    # No-diff preflight — never spend a run on a clean tree.
    if git diff --quiet && git diff --cached --quiet \
       && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then
      echo "agy-review: no uncommitted changes to review — the working tree is clean." >&2
      exit 0
    fi
  fi

  emit_artifact() {
    case "$mode" in
      code) echo "## The change set under review (assembled working-tree diff — repo-complete)"; assemble_code_diff ;;
      plan) echo "## The implementation plan under review"; printf '%s\n' "$PLAN_CONTENT" ;;
      diff) echo "## The diff under review"; printf '%s\n' "$DIFF_CONTENT" ;;
    esac
  }
  emit_grounding() {  # POSTURE + GUARD + FACTS + DECIDED + FOCUS
    emit_posture; echo
    emit_guard; echo
    if [[ -n "$FACTS_CONTENT" ]]; then
      echo "## Grounded facts — review AGAINST these, do NOT guess the code"
      printf '%s\n' "$FACTS_CONTENT"
    else
      echo "## Grounded facts"
      echo "(none supplied — review the material as given; do NOT invent facts about the codebase or its model/version context.)"
    fi
    echo
    if [[ -n "$DECIDED_CONTENT" ]]; then
      echo "## Decisions already made / already addressed — do NOT re-raise these"
      printf '%s\n\n' "$DECIDED_CONTENT"
    fi
    if [[ -n "$FOCUS" ]]; then
      echo "## Focus"
      printf '%s\n\n' "$FOCUS"
    fi
  }

  # Full prompt = grounding + artifact (inline) + shape.
  ( umask 077; { emit_grounding; emit_artifact; echo; emit_shape; } > "$prompt_file" )
  prompt_bytes=$(( $(wc -c < "$prompt_file") ))

  if (( prompt_bytes > AGY_MAX_PROMPT_BYTES )); then
    if [[ "$AGY_REVIEW_ALLOW_ADDDIR" == "1" ]]; then
      # Offload ONLY the artifact to a private 0600 file; the -p prompt still carries the full grounding
      # inline and points agy at the file. --add-dir targets the private staging dir, never .git/work-tree.
      artifact_file="$staging/precomputed-change-set"
      ( umask 077; emit_artifact > "$artifact_file" )
      ( umask 077; {
          emit_grounding
          echo "## The change set under review"
          echo "The full change set is too large to inline. It is in the precomputed file at:"
          echo "  $artifact_file"
          echo "Read it IN FULL, then review it against the grounded facts above."
          echo
          emit_shape
        } > "$prompt_file" )
      small_bytes=$(( $(wc -c < "$prompt_file") ))
      if (( small_bytes > AGY_MAX_PROMPT_BYTES )); then
        echo "error: even the grounding-only prompt is ${small_bytes} bytes (> AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES})." >&2
        echo "       Trim --facts / --decided / --focus." >&2
        exit 2
      fi
      echo "warning: the assembled prompt was ${prompt_bytes} bytes (> AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES})." >&2
      echo "         AGY_REVIEW_ALLOW_ADDDIR=1 — offloading the change set to a private staging dir and" >&2
      echo "         passing it via --add-dir. This RE-ENABLES the Issue-001 stall risk (heavy agentic" >&2
      echo "         roaming); the inherited hard timeout (AGY_HARD_TIMEOUT=$AGY_HARD_TIMEOUT) bounds it." >&2
      run_passthrough=(--add-dir "$staging")
    else
      echo "error: the assembled prompt is ${prompt_bytes} bytes, over AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES}." >&2
      echo "       agy takes the prompt as a single argv; past ~131072 bytes it fails with a cryptic" >&2
      echo "       'Argument list too long'. Trim to the relevant hunks, or split into focused per-area" >&2
      if [[ "$mode" == "code" ]]; then
        echo "       reviews. For a large CODE review, AGY_REVIEW_ALLOW_ADDDIR=1 offloads the change set via" >&2
        echo "       a private --add-dir staging dir (re-enables the Issue-001 stall risk)." >&2
      else
        echo "       reviews (split the $mode into focused parts)." >&2
      fi
      exit 2
    fi
  fi
fi

# --- Execute via agy-run (single home of timeout + subscription + byte ceiling) ---
set +e
if (( ${#run_passthrough[@]} > 0 )); then
  AGY_MODEL="$AGY_MODEL" AGY_TIMEOUT="$AGY_TIMEOUT" AGY_HARD_TIMEOUT="$AGY_HARD_TIMEOUT" \
    "$AGY_RUN" "@$prompt_file" -- "${run_passthrough[@]}"
else
  AGY_MODEL="$AGY_MODEL" AGY_TIMEOUT="$AGY_TIMEOUT" AGY_HARD_TIMEOUT="$AGY_HARD_TIMEOUT" \
    "$AGY_RUN" "@$prompt_file"
fi
rc=$?
set -e
exit $rc
