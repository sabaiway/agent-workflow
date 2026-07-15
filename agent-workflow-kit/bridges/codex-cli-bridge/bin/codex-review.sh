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
# shown as targets, directories/vanished paths noted; never-committable untracked
# paths (devices/FIFOs/sockets) are excluded from the review domain entirely) and
# feeds it in, so codex does not burn a run rediscovering it. A clean tree exits 0
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

Receipt:
  side effect — a successful review appends one JSON receipt line to
  <git dir>/agent-workflow-review-receipts.jsonl (AW_REVIEW_RECEIPTS overrides): fingerprint =
  sha256 over the canonical uncommitted-state payload (staged diff + unstaged diff +
  untracked-not-ignored contents — the review-payload domain; never-committable untracked paths —
  character/block devices, FIFOs, sockets — are excluded from the domain entirely, untracked
  symlinks/directories ride as name-only notes) in code mode, the artifact-file
  sha256 in plan mode; verdict parsed from the mandated literal verdict line (schema mode: the
  verdict field); always fresh:true (one-shot) + grounded:true (native AGENTS.md auto-merge,
  factsHash null); probe = whether the run relaxed the quality guards (CODEX_PROBE=1), written on
  EVERY receipt so it self-declares — the kit's review-state gate rejects a probe-marked receipt (a
  probe review never attests) and equally rejects an unmarked one (silence is not a declaration); a
  write failure warns, never fails the review

Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):
  ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf
  CODEX_SERVICE_TIER — service tier: 'priority' (Fast — ~1.5x speed at a 2.5x credit rate on gpt-5.6-sol); a consented SPEND knob, default off (standard tier)
  CODEX_HARD_TIMEOUT — hard wall-clock cap, integer seconds 1..86400 (built-in default 1800)
  CODEX_REVIEW_MAX_TOTAL_BYTES — inline-payload cap, integer bytes 1..100000000 (default 1500000); above it the diff rides via a git-dir temp file

Environment: CODEX_REVIEW_SCHEMA=1 (structured JSON findings), CODEX_HARD_TIMEOUT (seconds, default 1800), CODEX_PROBE=1 (throwaway probe only), AW_REVIEW_RECEIPTS (receipt file override).
Requires at run time: the codex CLI on PATH, a ChatGPT-subscription login, a git work tree with a root AGENTS.md (--help needs none of these).
HELP
    exit 0
    ;;
esac

# This wrapper's applied settings-file subset (see the shared reader block below).
AW_SETTINGS_APPLIED="CODEX_SERVICE_TIER CODEX_HARD_TIMEOUT CODEX_REVIEW_MAX_TOTAL_BYTES"

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

DEFAULT_CODEX_MODEL="gpt-5.6-sol"
DEFAULT_CODEX_EFFORT="xhigh"
# Review-receipt identity (AD-038). AW_BRIDGE_VERSION mirrors this bridge's SKILL.md/capability.json
# version (drift-guarded by codex-review.test.mjs against capability.json).
AW_RECEIPT_BACKEND="codex"
AW_BRIDGE_VERSION="2.8.0"
CODEX_MODEL="${CODEX_MODEL:-$DEFAULT_CODEX_MODEL}"
CODEX_EFFORT="${CODEX_EFFORT:-$DEFAULT_CODEX_EFFORT}"
# Generous hard cap for a slow xhigh review (subscription latency varies).
CODEX_HARD_TIMEOUT="${CODEX_HARD_TIMEOUT:-1800}"
# Above this assembled-payload size (bytes), the diff goes via a git-dir-local temp
# file instead of inline — never truncated.
CODEX_REVIEW_MAX_TOTAL_BYTES="${CODEX_REVIEW_MAX_TOTAL_BYTES:-1500000}"
# Codex service tier (quality-neutral speed knob; live-probed 2026-07-05): default EMPTY ⇒ no
# service_tier flag (standard tier) — enabling Fast is a consented per-host SPEND act, never a
# silent default. The only server-catalog tier id on this subscription is 'priority' (catalog
# display name "Fast": ~1.5x token speed at a 2.5x credit rate on gpt-5.6-sol; quality-neutral —
# same model). codex itself accepts ANY -c service_tier string silently (probe-verified), so
# the wrapper validates the effective value: an unsupported one warns and runs on the standard
# tier — a typo can never silently masquerade as Fast.
CODEX_SERVICE_TIER="${CODEX_SERVICE_TIER:-}"
if [[ -n "$CODEX_SERVICE_TIER" ]] && ! aw_settings_valid CODEX_SERVICE_TIER "$CODEX_SERVICE_TIER"; then
  echo "warning: CODEX_SERVICE_TIER='$CODEX_SERVICE_TIER' is not a supported service tier ('priority') — running on the standard tier." >&2
  CODEX_SERVICE_TIER=""
fi
tier_flags=()
if [[ -n "$CODEX_SERVICE_TIER" ]]; then
  tier_flags=(-c "service_tier=$CODEX_SERVICE_TIER")
fi
CHATGPT_LOGIN_GUARD="Logged in using ChatGPT"

# --- Quality-first guard: refuse a silent model/effort downgrade ---------------
# A relaxed run is RECORDED, not just warned about: the receipt carries probe:true so the kit's
# review-state gate rejects it — "do NOT use this as a real review" becomes a mechanism, not a plea.
REVIEW_PROBE=false
if [[ "${CODEX_PROBE:-}" == "1" ]]; then
  REVIEW_PROBE=true
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
  # The verdict line is machine-parsed into the review receipt (AD-038) — mandate ONE exact literal.
  _verdict_fmt="End with EXACTLY ONE final verdict line in this literal, machine-parsed form (that word pair alone on the line, nothing else): 'Verdict: ship' or 'Verdict: revise' or 'Verdict: rethink'."
  OUTPUT_FORMAT_CODE="Output findings ONLY, one per line, as: [blocker|major|minor|nit] — file:line — issue — suggested fix. ${_verdict_fmt}"
  OUTPUT_FORMAT_PLAN="Output findings ONLY, one per line, as: [blocker|major|minor|nit] — location — issue — suggested change. ${_verdict_fmt}"
fi

# True (exit 0) when $1 looks BINARY: a NUL byte in the first 8 KiB (git's own
# heuristic). `tr -dc` keeps ONLY NUL bytes, `wc -c` counts them — never captures
# NUL into a variable. Empty / text files → not binary.
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

mode="${1:-}"
shift || true

REVIEW_ARTIFACT=""
REVIEW_FINGERPRINT=""

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
    # Plan-mode receipt identity: the artifact-file sha256 (informational-only for the tree checker).
    REVIEW_ARTIFACT="plan"
    REVIEW_FINGERPRINT="$(sha256_stdin <"$target" || true)"
    fence_plan="Do not read files outside this git working tree; the plan above plus the in-repo code it references are your whole surface."
    directive="You are REVIEWING an implementation plan — ADVISORY ONLY. You are in a read-only sandbox: do NOT edit, create, or delete any file, and do NOT rewrite the plan. Obey the project's Hard Constraints from its root AGENTS.md (already merged into your context). Read the plan below and the relevant repository code it references. ${fence_plan} ${OUTPUT_FORMAT_PLAN} Cover: correctness risks, missing or mis-ordered steps, ambiguities a cold executor would trip on, violated project Hard Constraints, scope creep, and missing verification/gates."
    prompt="${directive}"$'\n\nPLAN:\n'"$(cat -- "$target")"
    ;;
  code)
    # No-diff preflight — never spend a subscription run on a clean tree. Never-committable
    # untracked masks do not count: the FILTERED domain is the review surface.
    if git diff --quiet && git diff --cached --quiet && ! has_reviewable_untracked; then
      echo "codex-review: no uncommitted changes to review — the working tree is clean." >&2
      warn_never_committable_untracked
      exit 0
    fi
    warn_never_committable_untracked
    # The canonical fingerprint of the tree codex is about to review — computed at assembly time
    # (BEFORE the EXIT trap can fire), so the receipt attests exactly the reviewed state.
    REVIEW_ARTIFACT="code"
    REVIEW_FINGERPRINT="$(compute_tree_fingerprint || true)"
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
  "${tier_flags[@]+"${tier_flags[@]}"}"
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

# --- Review receipt (AD-038): parse the verdict, append one receipt line ------
# Text mode parses the mandated literal 'Verdict: <ship|revise|rethink>' line; CODEX_REVIEW_SCHEMA=1
# reads the schema's "verdict" field instead; absent either way → "unknown" (recorded, never guessed).
verdict=""
if [[ -f "$out" && -s "$out" ]]; then
  if [[ "${CODEX_REVIEW_SCHEMA:-}" == "1" ]]; then
    verdict="$(sed -nE 's/.*"verdict"[[:space:]]*:[[:space:]]*"(ship|revise|rethink)".*/\1/p' "$out" | tail -n1)"
  else
    verdict="$(sed -nE 's/^Verdict: (ship|revise|rethink)[[:space:]]*$/\1/p' "$out" | tail -n1)"
  fi
fi
[[ -z "$verdict" ]] && verdict="unknown"
# codex is grounded by construction (AGENTS.md auto-merge + the precomputed change set): grounded
# true, factsHash null (native grounding — no separate facts payload exists). Every codex run is a
# full fresh run (one-shot, no resume) → fresh:true. $REVIEW_PROBE marks a guards-relaxed run.
write_review_receipt "$REVIEW_ARTIFACT" true "$REVIEW_FINGERPRINT" "$verdict" true "" "$REVIEW_PROBE"
