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
#   AW_REVIEW_RECEIPTS       override the review-receipt file (default: <git dir>/
#                            agent-workflow-review-receipts.jsonl — see the --help Receipt block)
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

Notes:
  pre-dispatch host-diff: before the FIRST dispatch of this bridge, diff its declared networkHosts
  against the live sandbox allow-list — a missing host is surfaced to the maintainer BEFORE
  dispatching, never fired into a known prompt

Round-2 / resume:
  agy-review --continue [--decided @f] [--focus "…"]
  agy-review --conversation <id> [--decided @f] [--focus "…"]
  (a continuation sends a small delta — agy holds the artifact server-side; --facts is invalid on a continuation)

Receipt:
  side effect — a successful review appends one JSON receipt line to
  <git dir>/agent-workflow-review-receipts.jsonl (AW_REVIEW_RECEIPTS overrides; plan/diff outside
  a git tree: warn + skip unless overridden): fingerprint = sha256 over the canonical
  uncommitted-state payload (staged diff + unstaged diff + untracked-not-ignored contents — the
  review-payload domain; never-committable untracked paths — character/block devices, FIFOs,
  sockets — are excluded from the domain entirely, untracked symlinks/directories ride as
  name-only notes) in code mode, the artifact-file sha256 in plan/diff mode; verdict
  recorded verbatim from the mandated '### Verdict' section (SHIP / SHIP WITH NITS / REWORK);
  grounded = whether a NON-EMPTY --facts payload was supplied (an empty payload records
  grounded:false — fail-closed, the state gate rejects it), factsHash = sha256 of the facts
  payload; a continuation receipt is fresh:false (informational-only — it cannot attest the
  folded tree); probe = whether the run relaxed the quality guards (AGY_PROBE=1), written on EVERY
  receipt so it self-declares — the kit's review-state gate rejects a probe-marked receipt (a probe
  review never attests) and equally rejects an unmarked one (silence is not a declaration); a write
  failure warns, never fails the review

Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):
  ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf
  AGY_HARD_TIMEOUT — hard wall-clock cap, duration string like 5m/30m/90s (built-in default 30m)
  AGY_REVIEW_ALLOW_ADDDIR — boolean 0/1: 1 arms the oversized --add-dir escape (re-enables the Issue-001 stall risk; default 0)

Closed grammar: unknown flags are rejected; no '--' passthrough (the only escapes are AGY_PROBE=1 and AGY_REVIEW_ALLOW_ADDDIR=1).
Requires at run time: the agy CLI on PATH + a Google AI subscription login (--help needs neither).
HELP
    exit 0
    ;;
esac

# This wrapper's applied settings-file subset (see the shared reader block below).
AW_SETTINGS_APPLIED="AGY_HARD_TIMEOUT AGY_REVIEW_ALLOW_ADDDIR"

# --- Bridge settings file (host-level, kit-independent) — byte-identical across the four wrappers ---
# ${XDG_CONFIG_HOME:-$HOME/.config}/agent-workflow/bridge-settings.conf holds KEY=VALUE lines,
# PARSED (grep/case), NEVER sourced — a file line can never execute code. Precedence: explicit
# env (even empty: KEY= disables the knob for one run) > file > built-in default. Each wrapper
# APPLIES only its own subset ($AW_SETTINGS_APPLIED, set above this block) but RECOGNIZES the
# whole registry: a key belonging to another wrapper or another bridge is skipped silently; only
# a key unknown to the entire registry warns (once per key), naming this file as the source.
# A malformed line warns and is ignored; a value failing the key's typed validation warns and
# falls back to the built-in default (never passed to the binary); duplicate key → the LAST
# occurrence wins; a missing file is silent; an existing-but-unreadable or non-regular file
# warns loudly and falls back to built-in defaults (a directory or FIFO is never opened).
# Diagnostics are emitted once per user-visible run: a delegating wrapper (agy-review →
# agy-run) exports AW_SETTINGS_NOTIFIED so the child never repeats the same file's warnings.
# The registry, per-wrapper subsets, and typed constants mirror
# the bridges' capability.json `settings` blocks (manifest-as-source, drift-guarded by tests).
aw_settings_file() {
  printf '%s/agent-workflow/bridge-settings.conf' "${XDG_CONFIG_HOME:-$HOME/.config}"
}
aw_settings_known() {
  case " CODEX_SERVICE_TIER CODEX_HARD_TIMEOUT CODEX_REVIEW_MAX_TOTAL_BYTES AGY_HARD_TIMEOUT AGY_REVIEW_ALLOW_ADDDIR " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}
aw_int_in_range() {
  # All-digits $1 vs [min,max] WITHOUT 64-bit wrap (Issue-012): strip leading zeros, then a longer
  # digit count than max's is unconditionally out of range — never do the arithmetic on a huge string.
  # A leading-zero in-range value still passes (its stripped count is small); all-zeros collapses to
  # "0" (below min>=1). Mirrors the JS settingValueValid safe-integer bound, verified by parity test.
  local n="${1#"${1%%[!0]*}"}" min="$2" max="$3"
  n="${n:-0}"
  (( ${#n} > ${#max} )) && return 1
  (( n >= min && n <= max ))
}
aw_settings_valid() {
  local k="$1" v="$2" int_re='^[0-9]+$' dur_re='^[0-9]+(\.[0-9]+)?[smhd]$' zero_re='^0+(\.0+)?[smhd]$'
  case "$k" in
    CODEX_SERVICE_TIER) [[ "$v" == "priority" ]] ;;
    CODEX_HARD_TIMEOUT) [[ "$v" =~ $int_re ]] && aw_int_in_range "$v" 1 86400 ;;
    CODEX_REVIEW_MAX_TOTAL_BYTES) [[ "$v" =~ $int_re ]] && aw_int_in_range "$v" 1 100000000 ;;
    AGY_HARD_TIMEOUT) [[ "$v" =~ $dur_re && ! "$v" =~ $zero_re ]] ;;
    AGY_REVIEW_ALLOW_ADDDIR) [[ "$v" == "0" || "$v" == "1" ]] ;;
    *) return 1 ;;
  esac
}
aw_apply_settings() {
  local file line key value warned notify
  file="$(aw_settings_file)"
  [[ -e "$file" ]] || return 0
  notify=1
  [[ -n "${AW_SETTINGS_NOTIFIED:-}" ]] && notify=0
  export AW_SETTINGS_NOTIFIED=1
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    if (( notify )); then
      echo "warning: bridge settings file '$file' exists but is unreadable or not a regular file — using built-in defaults." >&2
    fi
    return 0
  fi
  if (( notify )); then
    warned=" "
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "${line//[[:space:]]/}" ]] && continue
      case "${line#"${line%%[![:space:]]*}"}" in "#"*) continue ;; esac
      if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        echo "warning: malformed line in bridge settings file '$file' (ignored): $line" >&2
        continue
      fi
      key="${line%%=*}"
      if ! aw_settings_known "$key"; then
        case "$warned" in
          *" $key "*) : ;;
          *)
            warned="$warned$key "
            echo "warning: unknown key '$key' in bridge settings file '$file' (ignored)." >&2
            ;;
        esac
      fi
    done <"$file"
  fi
  for key in $AW_SETTINGS_APPLIED; do
    if [[ -n "${!key+x}" ]]; then continue; fi
    value="$(grep "^${key}=" "$file" 2>/dev/null || true)"
    [[ -n "$value" ]] || continue
    value="${value##*$'\n'}"
    value="${value#*=}"
    if ! aw_settings_valid "$key" "$value"; then
      if (( notify )); then
        echo "warning: invalid value '$value' for $key in bridge settings file '$file' — using the built-in default." >&2
      fi
      continue
    fi
    # Normalize an all-digit (integer) value to DECIMAL before export: a leading-zero value the integer
    # arms legitimately accept (000…086400 == 86400) would otherwise read as OCTAL in downstream Bash
    # arithmetic ("value too great for base"). Strip leading zeros, floor "0"; enum/duration (non-digit)
    # and boolean 0/1 are unaffected.
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      value="${value#"${value%%[!0]*}"}"
      value="${value:-0}"
    fi
    export "$key=$value"
  done
  return 0
}
aw_apply_settings

DEFAULT_AGY_REVIEW_MODEL="Gemini 3.1 Pro (High)"
# Review-receipt identity (AD-038). AW_BRIDGE_VERSION mirrors this bridge's SKILL.md/capability.json
# version (drift-guarded by agy-review.test.mjs against capability.json).
AW_RECEIPT_BACKEND="agy"
AW_BRIDGE_VERSION="2.7.0"
# `-` not `:-` so an EXPLICIT empty AGY_MODEL= survives (drop --model, use settings.json — agy.sh:52).
AGY_MODEL="${AGY_MODEL-$DEFAULT_AGY_REVIEW_MODEL}"
# Frontier review models. ANY model is allowed; a sub-frontier one only earns a soft, silenceable warning.
FRONTIER_SET=("Gemini 3.1 Pro (High)" "Claude Opus 4.6 (Thinking)" "Claude Sonnet 4.6 (Thinking)")

# Duration-string timeouts (NOT codex's bare seconds): agy-run forwards a duration to --print-timeout,
# and the timeout(1) hard cap is a duration too — never numerically compared, so 30m vs 2h is fine.
AGY_HARD_TIMEOUT="${AGY_HARD_TIMEOUT:-30m}"
AGY_TIMEOUT="${AGY_TIMEOUT:-$AGY_HARD_TIMEOUT}"
AGY_PROBE="${AGY_PROBE:-0}"
# A probe run is RECORDED, not just silently allowed: the receipt carries probe:true so the kit's
# review-state gate rejects it — a guards-relaxed review must never attest a tree.
REVIEW_PROBE=false
if [[ "$AGY_PROBE" == "1" ]]; then REVIEW_PROBE=true; fi
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

# --- Review receipts (AD-038) — byte-identical in codex-review.sh and agy-review.sh ---------------
# sha256 hex of stdin. sha256sum, else shasum -a 256; neither → warn + fail (the caller records a
# null fingerprint — a null never satisfies the review-state checker, fail-safe direction).
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  else
    echo "warning: no sha256sum/shasum on PATH — cannot compute the review fingerprint." >&2
    return 1
  fi
}

# Never-committable untracked stat class (Decision 1, AD-044 Plan 4): character/block devices,
# FIFOs, sockets — git content can never carry them, so they are excluded from the ENTIRE review
# domain (fingerprint payload, assembled change set, status section, no-diff preflight). Symlinks
# (checked first, never followed) and directories (an embedded repo lists as `dir/` — a committable
# gitlink) STAY in the domain. The class surfaces where a sandbox injects device masks whose dirent
# LIES to git's walk; the stat here sees the truth.
is_never_committable_untracked() {
  [[ ! -L "$1" && ( -p "$1" || -S "$1" || -c "$1" || -b "$1" ) ]]
}

# The ONE untracked-not-ignored walk every review-domain surface iterates (fingerprint payload,
# assembled change set, no-diff preflight): NUL-delimited paths with the never-committable classes
# filtered out.
emit_untracked_paths_z() {
  local path
  while IFS= read -r -d '' path; do
    if is_never_committable_untracked "$path"; then continue; fi
    printf '%s\0' "$path"
  done < <(git ls-files --others --exclude-standard -z)
}

# True when at least one untracked-not-ignored path survives the never-committable filter — the
# no-diff preflight twin of the fingerprint walk (a tree whose ONLY untracked paths are
# device/FIFO/socket masks reads clean).
has_reviewable_untracked() {
  [[ "$(emit_untracked_paths_z | wc -c)" -gt 0 ]]
}

# `git status --porcelain=v1` with never-committable untracked records dropped, so the assembled
# review payload is byte-identical with and without a device mask (the fingerprint==payload domain
# identity). Quote/space-safe: each filtered path's DISPLAYED line comes from git itself (never a
# re-implemented C-quoting), then exact whole-line removal — only untracked (??) records can match
# by construction. A mask nested in an otherwise-empty untracked directory leaves the collapsed
# `?? dir/` record (a directory is not in the filtered class); the real sandbox masks land beside
# tracked content, where status lists them individually.
emit_status_porcelain_filtered() {
  local path line drop=""
  while IFS= read -r -d '' path; do
    if is_never_committable_untracked "$path"; then
      line="$(git status --porcelain=v1 -- ":(literal)$path")"
      if [[ -n "$line" ]]; then drop+="$line"$'\n'; fi
    fi
  done < <(git ls-files --others --exclude-standard -z)
  if [[ -z "$drop" ]]; then
    git status --porcelain=v1
  else
    git status --porcelain=v1 | grep -Fvxf <(printf '%s' "$drop") || true
  fi
}

# ONE non-failing advisory when the walk observes never-committable untracked paths: they are
# ignored by the review domain BY CONSTRUCTION; the kit's sandbox-masks lane can hide them from
# `git status` too. Never an error, never a detector.
warn_never_committable_untracked() {
  local path n=0
  while IFS= read -r -d '' path; do
    if is_never_committable_untracked "$path"; then n=$((n + 1)); fi
  done < <(git ls-files --others --exclude-standard -z)
  if (( n > 0 )); then
    echo "notice: $n never-committable untracked path(s) (device/FIFO/socket) ignored by the review domain — for a clean 'git status' see the kit's sandbox-masks lane (/agent-workflow-kit sandbox-masks)." >&2
  fi
}

# The canonical uncommitted-state fingerprint payload (code mode). Domain == the review payload:
# tracked staged + unstaged changes + untracked-not-ignored file contents (binary untracked files,
# symlinks, and directories/gitlinks ride as name-only notes, mirroring the assembled change set;
# never-committable untracked paths — devices/FIFOs/sockets — are EXCLUDED entirely, see
# emit_untracked_paths_z). The prose definition lives in capability.json
# roles.review.contract.receipt (both bridges, lockstep); the kit checker (tools/review-state.mjs)
# implements the SAME serialization in node — cross-checked by the kit's
# review-fingerprint-parity.test.mjs.
emit_fingerprint_payload() {
  git diff --cached --no-ext-diff
  git diff --no-ext-diff
  local path
  while IFS= read -r -d '' path; do
    if [[ -L "$path" ]]; then
      printf 'untracked-symlink:%s -> %s\n' "$path" "$(readlink -- "$path" 2>/dev/null || echo '?')"
    elif [[ ! -f "$path" ]]; then
      printf 'untracked-nonregular:%s\n' "$path"
    elif is_binary "$path"; then
      printf 'untracked-binary:%s\n' "$path"
    else
      printf 'untracked:%s\n' "$path"
      cat -- "$path"
    fi
  done < <(emit_untracked_paths_z)
}

# sha256 of the canonical payload, emitted from the work-tree ROOT (a subdir invocation hashes the
# same bytes). Empty output on failure (no git tree / no sha256 tool) — recorded as null.
compute_tree_fingerprint() {
  ( cd "$(git rev-parse --show-toplevel)" && emit_fingerprint_payload ) | sha256_stdin
}

# JSON-encode a receipt scalar: empty → null, else a quoted string (every value comes from a closed
# vocabulary or a hex digest — no escaping needed by construction).
receipt_json_scalar() {
  if [[ -z "${1:-}" ]]; then printf 'null'; else printf '"%s"' "$1"; fi
}

# write_review_receipt <artifact|""> <fresh: true|false> <fingerprint|""> <verdict> <grounded: true|false> <factsHash|""> [probe: true|false]
# Appends ONE receipt line (the AD-038 fixture shape) as a side effect of a SUCCESSFUL review —
# to $AW_REVIEW_RECEIPTS when set, else <git dir>/agent-workflow-review-receipts.jsonl (inside the
# git dir by construction, so it is never committable). Fail-safe: every failure here warns loudly
# and returns 0 — a missing receipt fails the kit's review-state CHECKER, never the review run.
# The optional 7th argument marks a PROBE run (CODEX_PROBE=1 / AGY_PROBE=1 — the quality guards
# relaxed), which the kit's review-state gate rejects: a probe review must never attest a tree. The
# marker is written ALWAYS, true or false: the receipt SELF-DECLARES, so the gate reads the fact
# itself instead of inferring it from this wrapper's version (which bumps in a different release
# phase). Silence is not a declaration — an unmarked receipt is untrustworthy and the gate rejects it.
write_review_receipt() {
  local artifact="$1" fresh="$2" fingerprint="$3" verdict="$4" grounded="$5" facts_hash="$6" probe="${7:-false}"
  local receipts="${AW_REVIEW_RECEIPTS:-}"
  if [[ -z "$receipts" ]]; then
    local receipt_git_dir
    if ! receipt_git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)"; then
      echo "warning: not inside a git work tree and AW_REVIEW_RECEIPTS is unset — skipping the review receipt." >&2
      return 0
    fi
    receipts="$receipt_git_dir/agent-workflow-review-receipts.jsonl"
  fi
  local line probe_field=',"probe":false'
  if [[ "$probe" == "true" ]]; then probe_field=',"probe":true'; fi
  line="$(printf '{"schema":1,"artifact":%s,"fresh":%s,"fingerprint":%s,"backend":"%s","verdict":"%s","grounded":%s,"factsHash":%s,"wrapperVersion":"%s","timestamp":"%s"%s}' \
    "$(receipt_json_scalar "$artifact")" "$fresh" "$(receipt_json_scalar "$fingerprint")" \
    "$AW_RECEIPT_BACKEND" "$verdict" "$grounded" "$(receipt_json_scalar "$facts_hash")" \
    "$AW_BRIDGE_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$probe_field")"
  if ! printf '%s\n' "$line" >>"$receipts" 2>/dev/null; then
    echo "warning: could not append the review receipt to $receipts — the review itself succeeded;" >&2
    echo "         the review-state gate will read the current tree as un-receipted." >&2
  fi
}

# Parse the mandated '### Verdict' section of a captured review: the first non-empty line after the
# heading, matched against the closed verdict vocabulary (SHIP WITH NITS before SHIP — substring).
# No heading / no match → "unknown" (recorded, never guessed).
parse_agy_verdict() { # $1 = captured-output file
  local line
  line="$(awk '/^### Verdict/{flag=1; next} flag && NF {print; exit}' "$1" 2>/dev/null)"
  case "$line" in
    *"SHIP WITH NITS"*) printf 'SHIP WITH NITS' ;;
    *REWORK*)           printf 'REWORK' ;;
    *SHIP*)             printf 'SHIP' ;;
    *)                  printf 'unknown' ;;
  esac
}

# Emit the full review surface to stdout: repo map, status (never-committable untracked records
# filtered), staged + unstaged diffs, and the CONTENTS of every untracked REGULAR file (NUL-safe
# iteration over the SAME filtered walk as the fingerprint — the payload is byte-identical with
# and without a device mask). Symlinks are shown as their target (never followed — no out-of-repo
# leak); directories/vanished paths are noted, never read (a `cat` on a FIFO would hang BEFORE the
# hard timeout applies — that class never reaches this loop).
assemble_code_diff() {
  echo "=== repo file map (git ls-files) ==="
  git ls-files
  echo
  echo "=== git status (porcelain) ==="
  emit_status_porcelain_filtered
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
  done < <(emit_untracked_paths_z)
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
REVIEW_ARTIFACT=""
REVIEW_FINGERPRINT=""
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
      if [[ "$mode" == "plan" ]]; then PLAN_CONTENT="$(cat -- "$target")"; else DIFF_CONTENT="$(cat -- "$target")"; fi
      # Plan/diff receipt identity: the artifact-file sha256 (informational-only for the tree checker).
      REVIEW_ARTIFACT="$mode"
      REVIEW_FINGERPRINT="$(sha256_stdin <"$target" || true)" ;;
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
    # No-diff preflight — never spend a run on a clean tree. Never-committable untracked masks do
    # not count: the FILTERED domain is the review surface.
    if git diff --quiet && git diff --cached --quiet && ! has_reviewable_untracked; then
      echo "agy-review: no uncommitted changes to review — the working tree is clean." >&2
      warn_never_committable_untracked
      exit 0
    fi
    warn_never_committable_untracked
    # The canonical fingerprint of the tree agy is about to review — computed at assembly time,
    # so the receipt attests exactly the reviewed state.
    REVIEW_ARTIFACT="code"
    REVIEW_FINGERPRINT="$(compute_tree_fingerprint || true)"
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
# The output is teed into the private staging dir so the mandated '### Verdict' section can be
# parsed into the review receipt — the user-facing stream is unchanged.
review_out_file="$staging/review-output"
set +e
if (( ${#run_passthrough[@]} > 0 )); then
  AGY_MODEL="$AGY_MODEL" AGY_TIMEOUT="$AGY_TIMEOUT" AGY_HARD_TIMEOUT="$AGY_HARD_TIMEOUT" \
    "$AGY_RUN" "@$prompt_file" -- "${run_passthrough[@]}" | tee "$review_out_file"
  rc=${PIPESTATUS[0]}
else
  AGY_MODEL="$AGY_MODEL" AGY_TIMEOUT="$AGY_TIMEOUT" AGY_HARD_TIMEOUT="$AGY_HARD_TIMEOUT" \
    "$AGY_RUN" "@$prompt_file" | tee "$review_out_file"
  rc=${PIPESTATUS[0]}
fi
set -e

# --- Review receipt (AD-038): only a SUCCESSFUL review attests --------------------
if [[ $rc -eq 0 ]]; then
  verdict="$(parse_agy_verdict "$review_out_file")"
  if [[ -n "$resume_mode" ]]; then
    # A continuation never re-embeds the current artifact (agy holds the ORIGINAL round server-side;
    # --facts is rejected above), so it cannot attest the folded tree: fresh:false, artifact /
    # fingerprint / factsHash null, grounded false — informational-only, ignored by the state gate.
    write_review_receipt "" false "" "$verdict" false "" "$REVIEW_PROBE"
    echo "notice: a continuation receipt is fresh:false (informational-only) — only a fresh grounded run" >&2
    echo "        (agy-review code --facts @f) mints a receipt that satisfies the review-state gate." >&2
  else
    grounded=false
    facts_hash=""
    if [[ -n "$FACTS_CONTENT" ]]; then
      grounded=true
      facts_hash="$(printf '%s' "$FACTS_CONTENT" | sha256_stdin || true)"
    fi
    write_review_receipt "$REVIEW_ARTIFACT" true "$REVIEW_FINGERPRINT" "$verdict" "$grounded" "$facts_hash" "$REVIEW_PROBE"
  fi
fi
exit $rc
