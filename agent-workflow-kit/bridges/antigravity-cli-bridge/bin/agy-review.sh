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
#                (code mode REFUSES pre-spend without a non-empty payload — escapes:
#                --ungrounded / AGY_PROBE=1; plan/diff omitted -> a LOUD stderr warning)
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
#   agy-review code   [--facts @f] [--ungrounded] [--decided @f] [--focus "…"] [extra focus…]
#   agy-review plan   <plan-file> [--facts @f] [--decided @f] [--focus "…"]
#   agy-review diff   <diff-file> [--facts @f] [--decided @f] [--focus "…"]
#   agy-review --continue          [--decided @f] [--focus "…"]   # round-2 delta (no mode, no re-assembly)
#   agy-review --conversation <id> [--decided @f] [--focus "…"]   # resume a specific conversation
#
# Environment (every optional var has an explicit default so a no-env run is safe under set -u):
#   AGY_MODEL                default "Gemini 3.7 Flash (High)"; ANY model allowed (advisory warn off-frontier).
#                            Set empty (AGY_MODEL=) to drop --model and use agy's settings.json.
#   AGY_HARD_TIMEOUT         default 30m  (duration string; the timeout(1) hard cap via agy-run)
#   AGY_TIMEOUT              default = AGY_HARD_TIMEOUT (agy's soft --print-timeout)
#   AGY_MAX_PROMPT_BYTES     default 120000 (single-argv byte ceiling; see agy.sh)
#   AGY_PROBE=1              throwaway probe — silences the off-frontier model advisory
#   AGY_REVIEW_MAX_TOTAL_BYTES default 240000 (the chunked feed's total outgoing prompt-byte ceiling)
#   AGY_REVIEW_ALLOW_ADDDIR  RETIRED — recognized so an existing settings line never warns, but it
#                            arms nothing; an oversized CODE review is delivered as a chunked feed
#   AW_REVIEW_RECEIPTS       override the review-receipt file (default: <git dir>/
#                            agent-workflow-review-receipts.jsonl — see the --help Receipt block)
#   AW_REVIEW_NONCE          the dispatch nonce (safe grammar [A-Za-z0-9._-]{1,64}) — when supplied,
#                            a successful review first mints the finding manifest beside the receipt;
#                            the --nonce <n> flag is its plain-argument equivalent (one seam — a
#                            disagreeing flag+env pair refuses pre-spend)
set -euo pipefail

# --- --help / -h (pre-preflight: no agy, no login, no git tree needed) ---------
# Keyed ONLY on the FIRST argument — never a scan of all args (uniform rule across
# the four wrappers). Drift-guarded against capability.json roles.review.contract.
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
agy-review — grounded read-only ADVISORY review by Google's Antigravity CLI (agy; subscription-only).

Usage:
  agy-review code [--facts @f] [--ungrounded] [--decided @f] [--focus "…"] [--nonce <n>] [extra focus…]
  agy-review plan <plan-file> [--facts @f] [--decided @f] [--focus "…"] [--nonce <n>]
  agy-review diff <diff-file> [--facts @f] [--decided @f] [--focus "…"] [--nonce <n>]

Flags:
  --facts @f — verified facts the review runs AGAINST (code mode REQUIRES a non-empty payload; plan/diff warn loudly when omitted)
  --ungrounded — deliberately ungrounded CODE review, a throwaway opinion (code mode only, contradicts --facts; the receipt records grounded:false and never attests)
  --decided @f — already-decided / already-addressed list; do NOT re-raise (anti-circling; the round-2 payload)
  --focus "…" — extra focus (repeatable; code mode also takes trailing focus words)
  --nonce <n> — the flow dispatch nonce, the plain-argument lane onto the AW_REVIEW_NONCE seam (one seam: flag and a non-empty env must agree; a disagreeing pair refuses pre-spend)

Grounding:
  grounded review — agy reads NOTHING by default, an ungrounded review GUESSES:
  --facts @f = the verified facts to review AGAINST; --decided @f = decisions
  already made, do NOT re-raise (anti-circling). code mode REQUIRES a non-empty
  --facts payload and refuses BEFORE spending a run (escapes: --ungrounded,
  AGY_PROBE=1); plan/diff proceed with a loud warning

Notes:
  pre-dispatch host-diff: before the FIRST dispatch of this bridge, diff its declared networkHosts
  against the live sandbox allow-list — a missing host is surfaced to the maintainer BEFORE
  dispatching, never fired into a known prompt
  the review posture banner appends a banner-only timeout=<duration> field — exactly the duration
  agy-run hands to timeout(1); the hard-timeout preflight fails CLOSED when no timeout/gtimeout
  binary exists (the wrapper refuses by name before any CLI run, so an uncapped review run can no
  longer happen), and the field never enters the receipt posture or the D5 banner↔receipt parity
  quote the posture banner verbatim when labeling this dispatch — the banner is the machine-stated
  posture; a prose re-type drifts

Round-2 / resume:
  agy-review --continue [--decided @f] [--focus "…"] [--nonce <n>]
  agy-review --conversation <id> [--decided @f] [--focus "…"] [--nonce <n>]
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
  grounded = whether a NON-EMPTY --facts payload was supplied (code mode refuses pre-spend without
  one — no run, no receipt — unless --ungrounded/AGY_PROBE=1; in plan/diff an empty payload records
  grounded:false — fail-closed, the state gate rejects it), factsHash = sha256 of the facts
  payload; a continuation receipt is fresh:false (informational-only — it cannot attest the
  folded tree); probe = whether the run relaxed the quality guards (AGY_PROBE=1), written on EVERY
  receipt so it self-declares — the kit's review-state gate rejects a probe-marked receipt (a probe
  review never attests) and equally rejects an unmarked one (silence is not a declaration);
  posture = the ACTUAL run posture {model} (agy has no tier), written on EVERY receipt (D5) — the
  gate rejects a receipt with an absent/invalid posture (a pre-D5 wrapper minted it; re-run the
  review), one stderr banner line states the same posture, an ATTESTING review with AGY_MODEL
  explicitly emptied refuses pre-spend, and a model string carrying control bytes refuses
  pre-spend in every mode; delivery = how the change set REACHED the model, currently emitted as
  'inline' (the whole set rode one prompt — proven by construction) or 'fed' (a chunked feed whose
  per-part echo proof verified); REQUIRED on every agy code receipt and its ABSENCE is what stops a
  pre-fed-lane receipt attesting, while the gate accepts any well-formed declaration rather than a
  particular value; absent by construction on plan/diff/continuation receipts, which carry no change
  set; a run whose output carries NO recognized '### Verdict' section — empty
  output included — exits 4 with NO receipt (D4: a FAILED review to RE-RUN, never a fatal session
  error); when the dispatch nonce seam is supplied — the AW_REVIEW_NONCE environment value or
  its plain-argument equivalent --nonce <n> (one seam: the flag assigns the same value;
  supplying both with different values refuses pre-spend) — under the safe grammar
  [A-Za-z0-9._-]{1,64} (anything else refuses pre-spend), the wrapper first mints the finding
  MANIFEST {schema, backend, nonce, fingerprint, findings} beside the receipts file
  (agent-workflow-finding-manifest-<backend>-<nonce>.json; atomic, no-clobber — a byte-identical
  rewrite is an idempotent no-op, different bytes refuse loudly) ORDERED before the receipt
  append — a failed manifest write EXCLUDES the receipt append, so a nonce-supplied dispatch can
  never land a receipt without its readable manifest; a nonce-less invocation adds NO nonce field
  and mints NO finding manifest (the existing wrapperVersion field still changes with each bridge
  release); a write failure warns, never fails the review

Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):
  ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf
  AGY_HARD_TIMEOUT — hard wall-clock cap, duration string like 5m/30m/90s (built-in default 30m)
  AGY_REVIEW_ALLOW_ADDDIR — RETIRED: still recognized (an existing line never warns as unknown) but it arms NOTHING; a set value prints the retirement notice. The oversized code review is a chunked feed now
  AGY_REVIEW_MAX_TOTAL_BYTES — integer bytes 1..100000000 (default 240000): the ceiling on the SUM of all outgoing prompt bytes an over-cap CODE review's chunked feed may send; past it the fed review refuses before spending turn 1

Honesty + posture (D4/D5):
  a run whose output carries NO recognized '### Verdict' section — empty output included — exits 4
  with NO receipt: a FAILED review to RE-RUN, never a fatal session error. One stderr banner line
  states the ACTUAL run posture (review posture: model=… timeout=…) and the receipt records the
  same posture {model} (agy has no tier; the timeout field is banner-only — never a receipt
  field). Quote the posture banner verbatim when labeling this dispatch. An ATTESTING review with
  AGY_MODEL explicitly emptied refuses pre-spend (the actual model would be unknowable;
  AGY_PROBE=1 is exempt), and a model string carrying control bytes refuses pre-spend in every
  mode.

Closed grammar: unknown flags are rejected; no '--' passthrough (the flag escape is --ungrounded; the env escape is AGY_PROBE=1).
Requires at run time: the agy CLI on PATH + a Google AI subscription login (--help needs neither).
HELP
    exit 0
    ;;
esac

# This wrapper's applied settings-file subset (see the shared reader block below).
AW_SETTINGS_APPLIED="AGY_HARD_TIMEOUT AGY_REVIEW_ALLOW_ADDDIR AGY_REVIEW_MAX_TOTAL_BYTES"

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
  case " CODEX_SERVICE_TIER CODEX_HARD_TIMEOUT CODEX_REVIEW_MAX_TOTAL_BYTES AGY_HARD_TIMEOUT AGY_REVIEW_ALLOW_ADDDIR AGY_REVIEW_MAX_TOTAL_BYTES " in
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
    AGY_REVIEW_MAX_TOTAL_BYTES) [[ "$v" =~ $int_re ]] && aw_int_in_range "$v" 1 100000000 ;;
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
# Snapshot BEFORE the shared reader runs: it EXPORTS a settings-file value under the same name, so a
# check made afterwards cannot tell a file value from an env override — and the retirement notice's
# recovery differs by source (a file `--unset` cannot clear an env override).
AGY_ALLOW_ADDDIR_FROM_ENV=0
if [[ -n "${AGY_REVIEW_ALLOW_ADDDIR+x}" ]]; then AGY_ALLOW_ADDDIR_FROM_ENV=1; fi
aw_apply_settings

# --- Effective-timeout resolver (D5 banner honesty; AD-061) --------------------
# ONE rule, both bridges: the posture banner prints EXACTLY the duration handed to timeout(1) —
# an integer-seconds value rendered with the `s` suffix, a duration string verbatim; without a
# capping binary the EXEC wrappers print `timeout=uncapped` and run, while the REVIEW wrappers
# refuse pre-spend (fail-closed preflight) — never a fabricated number.
# The EFFECTIVE value (env included — closing the aw_settings_valid env bypass) is validated by
# the same per-key rule as the settings file, plus a 7-digit integer-part bound (overflow); an
# invalid value warns + falls back to the built-in default — a typo never silently masquerades
# as a cap. AGY_TIMEOUT shares AGY_HARD_TIMEOUT's duration rule (it has no settings-file arm).
aw_effective_timeout() {
  local key="$1" default="$2" value="${!1:-}" rule="$1" intpart
  [[ "$rule" == "AGY_TIMEOUT" ]] && rule="AGY_HARD_TIMEOUT"
  [[ -n "$value" ]] || { printf '%s' "$default"; return 0; }
  intpart="${value%%[!0-9]*}"
  if ! aw_settings_valid "$rule" "$value" || (( ${#intpart} > 7 )); then
    # %q escapes the raw value so a control byte in it can never forge an extra diagnostic line
    # (the direct agy-run lane has no pre-spend screen — the warning itself must be injection-proof).
    printf "warning: invalid value '%q' for %s — using the built-in default %s.\n" "$value" "$key" "$default" >&2
    printf '%s' "$default"
    return 0
  fi
  printf '%s' "$value"
}
aw_timeout_label() {
  local bin="$1" value="$2"
  [[ -n "$bin" ]] || { printf 'uncapped'; return 0; }
  case "$value" in
    *[!0-9]*) printf '%s' "$value" ;;
    *) printf '%ss' "$value" ;;
  esac
}
aw_resolve_timeout_bin() {
  local bin dir base
  bin="$(builtin type -P timeout 2>/dev/null || true)"
  [[ -n "$bin" ]] || bin="$(builtin type -P gtimeout 2>/dev/null || true)"
  [[ -n "$bin" ]] || { printf ''; return 0; }
  case "$bin" in
    /*) ;;
    *)
      case "$bin" in
        */*) dir="${bin%/*}"; base="${bin##*/}" ;;
        *) dir="."; base="$bin" ;;
      esac
      dir="$(builtin cd -- "$dir" 2>/dev/null && builtin pwd -P)" || { printf ''; return 0; }
      bin="$dir/$base"
      ;;
  esac
  [[ -f "$bin" && -x "$bin" ]] || { printf ''; return 0; }
  printf '%s' "$bin"
}

DEFAULT_AGY_REVIEW_MODEL="Gemini 3.7 Flash (High)"
# Review-receipt identity (AD-038). AW_BRIDGE_VERSION mirrors this bridge's SKILL.md/capability.json
# version (drift-guarded by agy-review.test.mjs against capability.json).
AW_RECEIPT_BACKEND="agy"
AW_BRIDGE_VERSION="5.2.0"  # aw-version-anchor
# `-` not `:-` so an EXPLICIT empty AGY_MODEL= survives (drop --model, use settings.json — agy.sh:52).
AGY_MODEL="${AGY_MODEL-$DEFAULT_AGY_REVIEW_MODEL}"
# D5 control-byte screen — IMMEDIATELY after resolution, BEFORE the off-frontier advisory (or any
# other interpolation) can echo raw newline/ESC bytes into stderr/the terminal (round-2 fold).
if [[ "$AGY_MODEL" == *[$'\x01'-$'\x1f'$'\x7f']* ]]; then
  echo "error: AGY_MODEL contains control bytes — fix the setting (env or bridge-settings.conf) and re-run." >&2
  exit 2
fi
# Frontier review models. ANY model is allowed; a sub-frontier one only earns a soft, silenceable
# warning. Gemini 3.7 Flash (High) is asserted frontier-grade (fork (a), maintainer 2026-08-14).
FRONTIER_SET=("Gemini 3.7 Flash (High)" "Gemini 3.1 Pro (High)" "Claude Opus 4.6 (Thinking)" "Claude Sonnet 4.6 (Thinking)")

# Duration-string timeouts (NOT codex's bare seconds): agy-run forwards a duration to --print-timeout,
# and the timeout(1) hard cap is a duration too — never numerically compared, so 30m vs 2h is fine.
AGY_HARD_TIMEOUT="${AGY_HARD_TIMEOUT:-30m}"
# D5 banner-field control-byte screen (AD-061) — like AGY_MODEL above, BEFORE any interpolation.
if [[ "$AGY_HARD_TIMEOUT" == *[$'\x01'-$'\x1f'$'\x7f']* ]]; then
  echo "error: AGY_HARD_TIMEOUT contains control bytes — fix the setting (env or bridge-settings.conf) and re-run." >&2
  exit 2
fi
AGY_HARD_TIMEOUT="$(aw_effective_timeout AGY_HARD_TIMEOUT 30m)"
AGY_TIMEOUT="${AGY_TIMEOUT:-$AGY_HARD_TIMEOUT}"
# D5 banner-field control-byte screen for AGY_TIMEOUT (AD-061): agy-review forwards it to the
# child agy-run's --print-timeout, so a control byte must refuse HERE, pre-spawn — the child's
# own diagnostic would otherwise echo it. (agy-run screens its own direct-lane env separately.)
if [[ "$AGY_TIMEOUT" == *[$'\x01'-$'\x1f'$'\x7f']* ]]; then
  echo "error: AGY_TIMEOUT contains control bytes — fix the setting (env or bridge-settings.conf) and re-run." >&2
  exit 2
fi
AGY_PROBE="${AGY_PROBE:-0}"
# A probe run is RECORDED, not just silently allowed: the receipt carries probe:true so the kit's
# review-state gate rejects it — a guards-relaxed review must never attest a tree.
REVIEW_PROBE=false
if [[ "$AGY_PROBE" == "1" ]]; then REVIEW_PROBE=true; fi
# The dispatch nonce seam (flow-orchestration Decision 2/P5): validated pre-spend under the SAFE
# grammar — a nonce that would escape the derived manifest name refuses before any CLI run. The
# bracket expression ENUMERATES the ASCII set (no ranges): a range like A-Z is locale-collation-
# dependent and could admit a non-ASCII nonce the kit's JS reader then refuses.
if [[ -n "${AW_REVIEW_NONCE:-}" && ! "${AW_REVIEW_NONCE}" =~ ^[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-]{1,64}$ ]]; then
  echo "error: AW_REVIEW_NONCE fails the safe nonce grammar ([A-Za-z0-9._-]{1,64}) — the derived manifest name would be unsafe; fix the nonce and re-run." >&2
  exit 2
fi
# RETIRED (D3), not removed: the key stays RECOGNIZED by the shared settings registry so an existing
# settings line never starts warning as unknown — but it arms NOTHING. The `--add-dir` offload told
# agy to read a staging file; headless agy AUTO-DENIES its own read_file tool, so that lane could
# return a confident fabrication or an empty SHIP with no way to tell. Setting it says so, loudly.
# The notice keys on the key being CONFIGURED AT ALL, not on its value: a stale `=0` line is just as
# dead as a `=1` one, and staying silent about it would leave the operator believing a knob they can
# see still means something. The recovery is source-specific — a file `--unset` cannot clear an env
# override, so telling an env user to run it would hand them a command that changes nothing.
AGY_REVIEW_ALLOW_ADDDIR_SOURCE=""
if (( AGY_ALLOW_ADDDIR_FROM_ENV == 1 )); then AGY_REVIEW_ALLOW_ADDDIR_SOURCE="env"; fi
AGY_REVIEW_ALLOW_ADDDIR="${AGY_REVIEW_ALLOW_ADDDIR:-0}"
if [[ -z "$AGY_REVIEW_ALLOW_ADDDIR_SOURCE" ]] && [[ -f "$(aw_settings_file)" ]] && grep -q "^AGY_REVIEW_ALLOW_ADDDIR=" "$(aw_settings_file)"; then
  AGY_REVIEW_ALLOW_ADDDIR_SOURCE="file"
fi
if [[ -n "$AGY_REVIEW_ALLOW_ADDDIR_SOURCE" ]]; then
  echo "notice: AGY_REVIEW_ALLOW_ADDDIR is set (${AGY_REVIEW_ALLOW_ADDDIR_SOURCE}) but it is RETIRED and arms nothing. An" >&2
  echo "        oversized 'agy-review code' is now DELIVERED as a chunked feed with a per-part delivery" >&2
  echo "        proof, so the change set never has to be read from disk — which headless agy cannot do" >&2
  echo "        (read_file is auto-denied)." >&2
  if [[ "$AGY_REVIEW_ALLOW_ADDDIR_SOURCE" == "env" ]]; then
    echo "        Clear it where you set it: unset AGY_REVIEW_ALLOW_ADDDIR in the environment (a settings-file" >&2
    echo "        --unset cannot clear an env override)." >&2
  else
    echo "        Clear the line: node <agent-workflow-kit>/tools/bridge-settings.mjs --unset" >&2
    echo "        AGY_REVIEW_ALLOW_ADDDIR --apply" >&2
  fi
fi
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
# The repo file map's share of the prompt (see emit_repo_file_map). A PINNED constant, not a knob:
# a plain assignment, so an inherited environment value can never widen or narrow it. 8192 = 6.8%
# of agy's 120000-byte default ceiling — the map is context, the change set is the review.
AW_REVIEW_MAP_BUDGET_BYTES=8192

# --- The chunked-feed ceiling (D1b) -------------------------------------------
# "The whole conversation" is not knowable before turn 1 (model response sizes are unknown), so the
# bound is the SUM OF ALL OUTGOING PROMPT BYTES — every envelope, every body, and the final turn's
# prompt — which IS computable up front. Set deliberately BELOW the 262,967 bytes a live probe
# proved retained, because that probe measured part BODIES only and the shipped lane adds envelopes
# and a final prompt on top. This is an ECONOMY guard, not the correctness guard: correctness is the
# per-part body echo, which fails closed under this ceiling too.
AGY_REVIEW_MAX_TOTAL_BYTES="${AGY_REVIEW_MAX_TOTAL_BYTES:-240000}"
# CANONICALIZE BEFORE ANY ARITHMETIC. A hand-rolled `(( value < 1 ))` on `008000` makes bash read an
# invalid OCTAL constant: the arithmetic errors, both range tests yield false, and the ceiling simply
# stops existing — the guard silently absent, which is worse than no guard. Leading zeros are
# stripped exactly as the shared settings reader does, then the value is judged by the wrapper's OWN
# registry rule (aw_int_in_range is the overflow-safe comparator the manifest bounds are pinned to),
# never by a second hand-written bound that could drift from the manifest.
if [[ "$AGY_REVIEW_MAX_TOTAL_BYTES" =~ ^[0-9]+$ ]]; then
  AGY_REVIEW_MAX_TOTAL_BYTES="${AGY_REVIEW_MAX_TOTAL_BYTES#"${AGY_REVIEW_MAX_TOTAL_BYTES%%[!0]*}"}"
  AGY_REVIEW_MAX_TOTAL_BYTES="${AGY_REVIEW_MAX_TOTAL_BYTES:-0}"
fi
if ! aw_settings_valid AGY_REVIEW_MAX_TOTAL_BYTES "$AGY_REVIEW_MAX_TOTAL_BYTES"; then
  # Only an EXPLICIT env override can reach here: the shared settings reader already drops an invalid
  # FILE value before the wrapper body runs, leaving the built-in default, which is valid. So this is
  # unconditionally a refusal — a warn-and-default arm would be dead code pretending to be a policy.
  echo "error: AGY_REVIEW_MAX_TOTAL_BYTES='$AGY_REVIEW_MAX_TOTAL_BYTES' is not a valid byte ceiling (integer 1..100000000)." >&2
  echo "       Refusing rather than running with a spending ceiling you set and this wrapper ignored." >&2
  exit 2
fi
# The echo-candidate window (D1): long enough that a line is distinctive and cannot be guessed,
# short enough that a model can reproduce it verbatim without truncating.
# Mirrors agy.sh's `timeout --kill-after=10s`. A turn that ignores TERM survives this long past its
# own cap, so the fed loop reserves it out of every turn's budget rather than letting the last turn
# spend it past the shared deadline. Keep in lockstep with agy.sh.
AGY_TURN_KILL_GRACE_S=10
FED_ECHO_MIN_BYTES=24
FED_ECHO_MAX_BYTES=200
# The largest proof ADDRESS number the parser will convert. It exists because the numbers come from
# the model: past this, awk's `%d` conversion is no longer faithful, and a silently-wrapped value
# could land back inside the requested range and impersonate a real address. An entry naming a
# bigger number is reported as address 0 — a value no request can ever carry — so it reads as an
# address nobody requested and FAILS the proof, rather than vanishing from the check entirely.
FED_PROOF_ADDRESS_MAX=1000000000

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
# The hard-timeout cap is a TWO-STAGE guarantee (flow-orchestration #26): (1) THIS parent
# preflight fails CLOSED without a capping binary — an uncapped review run is refused before any
# CLI spend; (2) the agy-run child re-resolves the binary at dispatch time, so the exported seam
# below makes ITS missing-binary lane refuse too — a delete-between race can never silently void
# the cap. The banner uses the parent-resolved path; the child's mandatory recheck is the seam's.
aw_review_timeout_bin="$(aw_resolve_timeout_bin)"
if [[ -z "$aw_review_timeout_bin" ]]; then
  echo "error: no 'timeout'/'gtimeout' binary on PATH — the hard-timeout preflight fails CLOSED:" >&2
  echo "       an uncapped review run is refused before any CLI spend. Install coreutils (timeout;" >&2
  echo "       on macOS: brew install coreutils for gtimeout), then re-run." >&2
  exit 127
fi
export AGY_REQUIRE_TIMEOUT_BIN=1
# Delegate execution to agy-run (the single home of the timeout + subscription + byte-ceiling guards);
# fall back to the sibling agy.sh on a fresh checkout / hermetic test where agy-run is not yet linked.
if command -v agy-run >/dev/null 2>&1; then
  AGY_RUN="agy-run"
else
  AGY_RUN="$HERE/agy.sh"
fi
# The seam is a guarantee only when the RESOLVED child honors it: a stale installed agy-run that
# never reads AGY_REQUIRE_TIMEOUT_BIN would keep its uncapped lane past the parent preflight —
# refuse loudly and name the refresh recovery instead of dispatching on a hope.
aw_child_path="$(command -v "$AGY_RUN" 2>/dev/null || printf '%s' "$AGY_RUN")"
if ! grep -q "AGY_REQUIRE_TIMEOUT_BIN" "$aw_child_path" 2>/dev/null; then
  echo "error: the resolved agy-run child ($aw_child_path) does not honor the AGY_REQUIRE_TIMEOUT_BIN seam —" >&2
  echo "       a stale bridge install could run uncapped past the parent preflight. Refresh the placed" >&2
  echo "       bridges (/agent-workflow-kit setup --refresh-placed), then re-run." >&2
  exit 127
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
emit_shape_sections() {
  cat <<'SHAPE'
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
emit_shape() {
  echo "## Output — Markdown, this exact shape, nothing else"
  emit_shape_sections
}
# The FED shape (D1): '### Delivery proof' is the FIRST section, so output truncation cannot
# silently drop the proof. The requested lines are named by ADDRESS only — revealing the text would
# let a model that never held the body copy it back, which is exactly what the proof exists to catch.
emit_shape_fed() {  # $1 = the requested addresses, "part K line L; part K line L"
  echo "## Output — Markdown, this exact shape, nothing else"
  cat <<'PROOF'
### Delivery proof
This section comes FIRST, before ### Verdict. For each requested address below print exactly one
line, in this form and nothing else:
  part <K> line <L>: <the text of line L of part K, VERBATIM>
Count lines 1-based from the FIRST line after that part's BEGIN marker. Print the raw line text
after the colon — no code fences, no backticks, no quotes, no commentary, no ellipsis, no
re-indenting. If you cannot reproduce a line exactly, say so on that line rather than guessing.
PROOF
  # ONE ADDRESS PER LINE, and every address line is shorter than FED_ECHO_MIN_BYTES. That is not
  # cosmetic: it makes a collision CONSTRUCTIVELY impossible. A proof candidate is a single line of
  # at least FED_ECHO_MIN_BYTES, and a single line can never match across a newline, so no candidate
  # can occur inside this list — which is what lets the selector pick in ONE pass instead of
  # re-picking against a request that does not exist yet.
  printf 'Requested addresses, one per line:\n%s\n' "$1"
  emit_shape_sections
}
# One feed turn's ENVELOPE (D1a). Nothing here ever enters the reviewed artifact: only the BODY
# between the BEGIN/END markers concatenates, and it concatenates byte-for-byte.
emit_feed_frame() {  # $1 = part index, $2 = part count
  printf '## Chunked delivery — part %s of %s\n' "$1" "$2"
  cat <<'FEED'
This is one piece of ONE change set being delivered to you in order.
Reply with exactly OK and NOTHING else: do NOT review yet, do NOT summarise, do NOT comment, do NOT
ask questions. The review request arrives after the last part. The text between the BEGIN and END
markers below is the change set VERBATIM — the markers themselves are delivery framing and are not
part of it.
Work from THIS CONVERSATION only: do NOT use any tool, do NOT run any command, do NOT read any file.
Everything you need is already in this conversation, and on this host EVERY tool is auto-denied — a
denied tool produces no output at all and loses the whole answer.
FEED
}
emit_fed_final_head() {
  cat <<'FINAL'
## The change set is fully delivered
Every part above belongs to ONE change set, and it is now complete in this conversation. Review the
WHOLE change set against the grounded facts from the first message, under the same read-only posture.
Work from THIS CONVERSATION only: do NOT use any tool, do NOT run any command, do NOT read any file,
do NOT try to count lines with a tool — count them by reading. Everything you need is already in this
conversation, and on this host EVERY tool is auto-denied: a denied tool produces no output at all, so
reaching for one loses your entire review. Observed live on this lane's first real run.
FINAL
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

# STRICT JSON string encoding for the ONE free-form receipt field (the posture model display
# string): backslash then double-quote escaped. Control bytes never reach here — the posture
# resolution refuses them pre-spend (D5), so these two escapes make the encoding total.
json_string_escape() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# The D5 posture object this wrapper writes into EVERY receipt (agy has no tier — the label is
# the model display string). An unknowable model (explicitly emptied on an exempt probe run) is
# recorded null, never guessed.
posture_json() {
  if [[ -z "${AGY_MODEL:-}" ]]; then
    printf '{"model":null}'
  else
    printf '{"model":"%s"}' "$(json_string_escape "$AGY_MODEL")"
  fi
}

# write_finding_manifest <receipts-path> <fingerprint|""> <findings-file> — the wrapper-minted
# finding MANIFEST (flow-orchestration Decision 2 / P5 / P24-25), minted ONLY when the dispatch
# nonce seam AW_REVIEW_NONCE is supplied: {schema, backend, nonce, fingerprint, findings} lands
# beside the receipts file under the {backend, nonce}-derived name. The write is ATOMIC (temp +
# hard-link publish) and NO-CLOBBER: a byte-identical re-write is an idempotent no-op, different
# bytes refuse loudly. Returns non-zero on ANY failure — the caller then EXCLUDES the receipt
# append, so a nonce-supplied dispatch can never land a receipt without its readable manifest.
# A nonce-less invocation returns 0 untouched (no nonce field, no manifest — the receipt
# otherwise proceeds unchanged).
write_finding_manifest() {
  local receipts="$1" fingerprint="$2" findings_file="$3" nonce="${AW_REVIEW_NONCE:-}"
  [[ -n "$nonce" ]] || return 0
  if [[ ! "$nonce" =~ ^[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-]{1,64}$ ]]; then
    echo "error: AW_REVIEW_NONCE fails the safe nonce grammar ([A-Za-z0-9._-]{1,64}) — the derived manifest name would be unsafe; NO manifest was written." >&2
    return 1
  fi
  if [[ -z "$findings_file" || ! -f "$findings_file" ]]; then
    echo "error: no captured findings file to mint the manifest from — NO manifest was written." >&2
    return 1
  fi
  local manifest mint_rc
  manifest="$(dirname -- "$receipts")/agent-workflow-finding-manifest-${AW_RECEIPT_BACKEND}-${nonce}.json"
  # The WHOLE mint core rides ONE node script (a family floor; the verdict parse already leans on
  # it): FATAL UTF-8 compose (BOM kept — invalid bytes refuse rather than silently mutate the
  # digest domain), an UNPREDICTABLE sibling temp opened with "wx" (O_CREAT|O_EXCL — a planted
  # node at the name refuses, and ONLY a temp we provably created is ever unlinked), a hard-link
  # publish (atomic no-clobber), and an EEXIST loser judged through ONE O_NOFOLLOW|O_NONBLOCK
  # descriptor whose fstat must say REGULAR before the same-fd byte compare — no TOCTOU window,
  # no symlink read-through, no FIFO hang. Exit: 0 minted or byte-identical no-op; 3 different
  # bytes or a non-regular/symlink manifest; 5 minted-but-temp-left (SUCCESS with the orphan path
  # on stdout — the caller warns loudly, never silently); 1 unreadable/non-UTF-8 findings or an
  # fs failure.
  local mint_out
  mint_out="$( umask 077; node -e '
const fs = require("node:fs");
const { join, dirname, basename } = require("node:path");
const { randomBytes } = require("node:crypto");
const [file, backend, nonce, fingerprint, manifest] = process.argv.slice(1);
let code = 1;
let tmp = null;
try {
  const findings = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
  const bytes = Buffer.from(`${JSON.stringify({ schema: 1, backend, nonce, fingerprint: fingerprint || null, findings })}\n`);
  const candidate = join(dirname(manifest), `.${basename(manifest)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = fs.openSync(candidate, "wx", 0o600);
  tmp = candidate;
  try {
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, manifest);
    code = 0;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const mfd = fs.openSync(manifest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          code = !fs.fstatSync(mfd).isFile() ? 3 : fs.readFileSync(mfd).equals(bytes) ? 0 : 3;
        } finally {
          fs.closeSync(mfd);
        }
      } catch {
        code = 3;
      }
    }
  }
} catch {
  code = 1;
}
if (tmp !== null) { try { fs.unlinkSync(tmp); } catch { if (code === 0) code = 5; process.stdout.write(tmp); } }
process.exit(code);
' "$findings_file" "$AW_RECEIPT_BACKEND" "$nonce" "$fingerprint" "$manifest" 2>/dev/null )"
  mint_rc=$?
  if [[ $mint_rc -eq 5 ]]; then
    echo "warning: the finding manifest was minted, but its temporary sibling could not be removed —" >&2
    echo "         orphan left at: ${mint_out} — remove it by hand (the manifest and the receipt are intact)." >&2
    return 0
  fi
  if [[ $mint_rc -eq 3 ]]; then
    echo "error: the finding manifest $manifest already exists with DIFFERENT bytes or is not a regular file — no-clobber refuses loudly (one dispatch identity, one manifest)." >&2
    if [[ -n "$mint_out" ]]; then
      echo "       orphan left at: ${mint_out} — its temporary sibling could not be removed either; remove it by hand." >&2
    fi
    return 1
  fi
  if [[ $mint_rc -ne 0 ]]; then
    echo "error: could not compose or write the finding manifest (unreadable or non-UTF-8 findings, or an fs failure) — NO manifest was written." >&2
    if [[ -n "$mint_out" ]]; then
      echo "       orphan left at: ${mint_out} — its temporary sibling could not be removed either; remove it by hand." >&2
    fi
    return 1
  fi
  return 0
}

# write_review_receipt <artifact|""> <fresh: true|false> <fingerprint|""> <verdict> <grounded: true|false> <factsHash|""> [probe: true|false] [delivery|""] [findings-file]
# Appends ONE receipt line (the AD-038 fixture shape) as a side effect of a SUCCESSFUL review —
# to $AW_REVIEW_RECEIPTS when set, else <git dir>/agent-workflow-review-receipts.jsonl (inside the
# git dir by construction, so it is never committable). Fail-safe: every failure here warns loudly
# and returns 0 — a missing receipt fails the kit's review-state CHECKER, never the review run.
# The optional 7th argument marks a PROBE run (CODEX_PROBE=1 / AGY_PROBE=1 — the quality guards
# relaxed), which the kit's review-state gate rejects: a probe review must never attest a tree. The
# marker is written ALWAYS, true or false: the receipt SELF-DECLARES, so the gate reads the fact
# itself instead of inferring it from this wrapper's version (which bumps in a different release
# phase). Silence is not a declaration — an unmarked receipt is untrustworthy and the gate rejects it.
# The 9th argument feeds the finding-manifest mint: on a nonce-supplied dispatch the manifest is
# minted FIRST (atomic, no-clobber, ORDERED) and a failed mint EXCLUDES the receipt append.
write_review_receipt() {
  local artifact="$1" fresh="$2" fingerprint="$3" verdict="$4" grounded="$5" facts_hash="$6" probe="${7:-false}" delivery="${8:-}" findings_file="${9:-}"
  local receipts="${AW_REVIEW_RECEIPTS:-}"
  if [[ -z "$receipts" ]]; then
    local receipt_git_dir
    if ! receipt_git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)"; then
      echo "warning: not inside a git work tree and AW_REVIEW_RECEIPTS is unset — skipping the review receipt." >&2
      return 0
    fi
    receipts="$receipt_git_dir/agent-workflow-review-receipts.jsonl"
  fi
  if ! write_finding_manifest "$receipts" "$fingerprint" "$findings_file"; then
    echo "warning: the finding manifest could not be minted — the receipt append is EXCLUDED (a" >&2
    echo "         nonce-supplied dispatch never lands a receipt without its readable manifest);" >&2
    echo "         the review itself succeeded — re-run it to mint the pair." >&2
    return 0
  fi
  # A nonce-SUPPLIED dispatch stamps its nonce into the receipt too (the flow round-land matcher
  # requires exact {backend, nonce} equality — dispatch identity end-to-end); the nonce is
  # grammar-safe by the pre-spend check, and a nonce-less receipt stays BYTE-EXACT (the frozen
  # compatibility floor).
  local line probe_field=',"probe":false' delivery_field="" nonce_field=""
  if [[ "$probe" == "true" ]]; then probe_field=',"probe":true'; fi
  if [[ -n "$delivery" ]]; then delivery_field=",\"delivery\":\"$delivery\""; fi
  if [[ -n "${AW_REVIEW_NONCE:-}" ]]; then nonce_field=",\"nonce\":\"${AW_REVIEW_NONCE}\""; fi
  line="$(printf '{"schema":1,"artifact":%s,"fresh":%s,"fingerprint":%s,"backend":"%s","verdict":"%s","grounded":%s,"factsHash":%s,"wrapperVersion":"%s","timestamp":"%s"%s,"posture":%s%s%s}' \
    "$(receipt_json_scalar "$artifact")" "$fresh" "$(receipt_json_scalar "$fingerprint")" \
    "$AW_RECEIPT_BACKEND" "$verdict" "$grounded" "$(receipt_json_scalar "$facts_hash")" \
    "$AW_BRIDGE_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$probe_field" "$(posture_json)" "$delivery_field" "$nonce_field")"
  if ! printf '%s\n' "$line" >>"$receipts" 2>/dev/null; then
    echo "warning: could not append the review receipt to $receipts — the review itself succeeded;" >&2
    echo "         the review-state gate will read the current tree as un-receipted." >&2
  fi
}

# Parse the mandated '### Verdict' section of a captured review: the first non-empty line after
# the EXACT heading (`### Verdicts` or any suffix never matches), tested against the closed
# vocabulary as an ANCHORED PREFIX with a word boundary — the verdict line must START with the
# token and the next char must be non-word/EOL (SHIP WITH NITS before SHIP; `NOT SHIP` and
# `SHIPPING` never match). No heading / no match → "unknown" (the D4 failed-run arm owns it).
parse_agy_verdict() { # $1 = captured-output file
  local line
  line="$(awk '/^### Verdict[[:space:]]*$/{flag=1; next} flag && NF {print; exit}' "$1" 2>/dev/null)"
  if [[ "$line" =~ ^SHIP\ WITH\ NITS([^[:alnum:]_]|$) ]]; then printf 'SHIP WITH NITS'
  elif [[ "$line" =~ ^REWORK([^[:alnum:]_]|$) ]]; then printf 'REWORK'
  elif [[ "$line" =~ ^SHIP([^[:alnum:]_]|$) ]]; then printf 'SHIP'
  else printf 'unknown'
  fi
}

# The repo file map is a FIXED cost that scales with REPO SIZE, not change size (measured 28,735
# bytes in the home repo — 24% of agy's 120000-byte single-argv ceiling), so an unbounded map taxes
# the change budget of every review. AW_REVIEW_MAP_BUDGET_BYTES bounds it; the value is set by each
# wrapper so THIS BODY stays byte-identical across both (review-fingerprint-parity.test.mjs
# lockstep). Unset/0 = unbounded. Past the budget the map degrades to the CHANGED-path subset — cut
# at the SAME budget, so a change touching very many long paths cannot re-breach the bound — plus a
# stated omitted count; a truncation-with-count, never a silent cut. The map was never part of the
# fingerprint domain (emit_fingerprint_payload does not contain it), so bounding it moves no receipt.
emit_repo_file_map() {
  local budget="${AW_REVIEW_MAP_BUDGET_BYTES:-0}" total shown omitted subset tracked
  # ONE deduplicated tracked-path SNAPSHOT, captured once and reused for all four uses — the
  # byte-budget predicate, the printed map, `total`, and the index intersection. Re-running the query
  # per use let a concurrent index change make the budget decision, the map and the counts describe
  # DIFFERENT snapshots. Dedupe: an UNMERGED index lists a path once per stage, so a predicate
  # counting duplicates against a map printing unique paths would push a map that fits into the
  # truncated arm. `ls-files` output is sorted by path, so one path's stages are adjacent and `uniq`
  # is exact — no git version floor needed.
  tracked="$(git ls-files | LC_ALL=C uniq)"
  if (( budget <= 0 )) || (( $(printf '%s\n' "$tracked" | wc -c) <= budget )); then
    if [[ -n "$tracked" ]]; then printf '%s\n' "$tracked"; fi
    return 0
  fi
  total=$(( $(printf '%s\n' "$tracked" | wc -l) ))
  # The subset is INTERSECTED with the index before budgeting, so `shown` and `total` live in ONE
  # domain and `shown + omitted == total` holds exactly: a STAGED DELETION is a changed path that is
  # no longer in `git ls-files`, and counting it as shown would make the stated arithmetic a lie.
  # (The NR==FNR reader is safe here: an empty index returns through the in-budget arm above.)
  # awk never `exit`s early: a closed pipe would SIGPIPE `sort` and pipefail would abort the run.
  subset="$(LC_ALL=C awk 'NR == FNR { known[$0] = 1; next } ($0 in known)' <(printf '%s\n' "$tracked") <(git diff --name-only --no-ext-diff; git diff --cached --name-only --no-ext-diff) |
    LC_ALL=C sort -u |
    LC_ALL=C awk -v cap="$budget" '{ n = length($0) + 1; if (!over && used + n <= cap) { used += n; print } else over = 1 }')"
  shown=0
  if [[ -n "$subset" ]]; then
    printf '%s\n' "$subset"
    shown=$(( $(printf '%s\n' "$subset" | wc -l) ))
  fi
  omitted=$(( total - shown ))
  if (( omitted < 0 )); then omitted=0; fi
  printf '=== repo file map TRUNCATED to the changed-path subset: %s of %s tracked paths shown, %s omitted (map budget %s bytes) ===\n' \
    "$shown" "$total" "$omitted" "$budget"
}

# ── the chunked feed: partition, proof selection, turn targeting (Phase 3) ─────────────────────
# Delivery framing. `printf --` because the format itself begins with a dash.
FED_BEGIN_FMT='--- BEGIN CHANGE-SET PART %s OF %s ---\n'
FED_END_FMT='\n--- END CHANGE-SET PART %s OF %s ---\n'
FED_MODE=0
FED_PART_COUNT=0
FED_REQUESTED=""
declare -a FED_ECHO_LINE=()
declare -a FED_ECHO_TEXT=()

# Byte-exact slice of a file. pipefail is disabled INSIDE the subshell only: `head -c` closes the
# pipe early, which SIGPIPEs `tail` — under pipefail that would abort the whole run.
slice_bytes() {  # $1 = file, $2 = 0-based byte offset, $3 = length
  ( set +o pipefail; tail -c "+$(( $2 + 1 ))" "$1" | head -c "$3" )
}

# Part LENGTHS (bytes, one per line) cutting a file at LINE boundaries: part 1 up to $2, later parts
# up to $3. Every cut lands on a line boundary, so a split multi-byte code point is impossible — there
# is NO hard-cut fallback: a line that cannot fit an EMPTY active part makes the whole run refuse
# (status 1) BEFORE any turn is spent, because a part built from fragments of one giant line carries
# no line to prove delivery with anyway.
#
# Precisely what "does not fit an empty active part" means, because the loose version of this
# sentence was a review finding: when the current part already holds content, the flush below moves
# the long line into a later, LARGER part, and only a line longer than that later budget refuses.
# When the active part is still empty the refusal is immediate against the CURRENT cap — for part 1
# that is the smaller budget, since turn 1 also carries the grounding and a body-less turn would be
# a turn spent on nothing. In practice part 1 always accumulates the assembled header first, so the
# reachable refusal is a line longer than the LATER-part budget.
#
# The final record contributes no separator byte when the artifact does not end with a newline —
# inventing one would split a part that actually fits and cost an entire extra turn.
plan_fed_parts() {  # $1 = file, $2 = first-part budget, $3 = later-part budget, $4 = line count, $5 = 1 if the file ends with a newline
  LC_ALL=C awk -v b1="$2" -v bk="$3" -v last="$4" -v final_nl="$5" '
    function flush() { if (used > 0) { print used; used = 0; cap = bk } }
    BEGIN { cap = b1; used = 0 }
    {
      n = length($0) + ((NR == last && final_nl == 0) ? 0 : 1)
      if (used + n > cap) {
        flush()
        if (n > cap) exit 1
      }
      used += n
    }
    END { flush() }
  ' "$1"
}

# ORDERED delivery-proof candidates for ONE part (D1), nearest that part's middle first: an INTERIOR
# line whose trimmed text sits in the echo window and is unique as a WHOLE line across the change
# set. This is only the cheap prefilter — the exact fixed-string checks (exactly one occurrence
# across the bodies, ZERO anywhere the wrapper's own envelope text can reveal it) run in bash over
# this list, because a candidate that is merely a unique LINE can still occur as a SUBSTRING of
# another body's line, and a model without that part could then copy it.
# The order is produced by WALKING OUTWARD from the part's middle, never by sorting: a comparison
# sort here was quadratic, and the caller may walk the whole list, so the cost of merely ORDERING
# candidates must not depend on how many there are. There is no cap — capping made the wrapper claim
# "no usable candidate" while a usable one sat at position 26.
list_echo_candidates() {  # $1 = part file, $2 = unique-trimmed-lines file → "<line number><TAB><text>"
  LC_ALL=C awk -v minlen="$FED_ECHO_MIN_BYTES" -v maxlen="$FED_ECHO_MAX_BYTES" '
    NR == FNR { uniq[$0] = 1; next }
    { lines[FNR] = $0 }
    function usable(i,   t) {
      if (i < 2 || i >= FNR) return 0
      t = lines[i]
      gsub(/^[ \t]+|[ \t]+$/, "", t)
      if (length(t) < minlen || length(lines[i]) > maxlen) return 0
      return (t in uniq)
    }
    END {
      mid = int((FNR + 1) / 2)
      if (usable(mid)) printf "%s\t%s\n", mid, lines[mid]
      for (d = 1; d <= FNR; d++) {
        if (usable(mid - d)) printf "%s\t%s\n", mid - d, lines[mid - d]
        if (usable(mid + d)) printf "%s\t%s\n", mid + d, lines[mid + d]
      }
    }' "$2" "$1"
}

# Exact FIXED-STRING occurrence count of $1 in file $2. `|| true`: grep exits 1 on no match, which
# pipefail would otherwise turn into an aborted run.
fixed_occurrences() {
  local n
  n="$( { LC_ALL=C grep -o -F -- "$1" "$2" || true; } | wc -l )"
  printf '%s' "$(( n ))"
}

# The conversation id agy writes into its own run log (D9, Arm A). The format is agy's own to change,
# which is exactly why an unparseable log DEGRADES LOUDLY to --continue instead of failing: the
# correctness guarantee is the D1 echo proof, which fails closed if the wrong conversation answers.
capture_conversation_id() {  # $1 = run log → the id, or empty
  local id
  [[ -f "$1" ]] || { printf ''; return 0; }
  id="$(LC_ALL=C awk '/onversation/ && match($0, /[0-9a-fA-F]+-[0-9a-fA-F]+-[0-9a-fA-F]+-[0-9a-fA-F]+-[0-9a-fA-F]+/) { print substr($0, RSTART, RLENGTH); exit }' "$1")"
  if [[ "$id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    printf '%s' "$id"
  else
    printf ''
  fi
}

# A validated duration string → integer seconds (floor 1). The fed lane needs arithmetic on the cap
# because ONE wall-clock budget has to cover N+1 turns; the banner keeps printing the duration
# verbatim, so this conversion never changes what the user is told about the cap itself.
aw_duration_seconds() {  # $1 = duration string matching the settings grammar
  LC_ALL=C awk -v d="$1" 'BEGIN {
    u = substr(d, length(d), 1)
    n = substr(d, 1, length(d) - 1) + 0
    m = (u == "s") ? 1 : (u == "m") ? 60 : (u == "h") ? 3600 : 86400
    s = int(n * m)
    if (s < 1) s = 1
    print s
  }'
}

trim_ws() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# A final turn that produced NO mandated section at all did not FAIL DELIVERY — it produced no
# review. Blaming delivery sends the reader hunting the wrong bug. What the wrapper can HONESTLY say
# is that it SENT every part and every feed turn exited zero; whether the model retained them is
# exactly what the unanswered proof leaves unknown, so it is never claimed.
fed_output_is_answerless() {  # $1 = captured final-turn output
  ! LC_ALL=C grep -qi -e '^###[[:space:]]*Delivery proof' -e '^###[[:space:]]*Verdict' "$1"
}

# agy's OWN refusal line when headless mode auto-denies a tool it chose to call. Recognizing it lets
# the wrapper name the real cause; anything else is reported as an UNKNOWN cause rather than guessed.
fed_output_names_tool_denial() {  # $1 = captured final-turn output
  LC_ALL=C grep -q 'no output produced.*permission that headless mode cannot prompt for' "$1"
}

# D1/D7: every part's selected line must come back VERBATIM, or the review FAILED — exit 4, no
# receipt, and a message naming the cause. Never a downgraded verdict, never a warning beside a kept
# receipt. The comparison tolerates surrounding whitespace only, never content.
# The proof section is the FIRST '### Delivery proof' block only, ending at the next '###' heading.
# Anything outside it is prose the model happens to have written and can never satisfy the proof.
# The FIRST '###' heading of the answer must BE the proof heading — that is the whole point of
# placing the proof first: output truncation can then never silently drop it. A proof block sitting
# after '### Verdict' is not the mandated shape and is not searched for.
fed_proof_section() {  # $1 = captured output
  LC_ALL=C awk '
    !seen && /^###/ {
      if (tolower($0) ~ /^###[ \t]*delivery proof[ \t]*$/) { seen = 1; inside = 1; next }
      exit
    }
    inside && /^###/ { exit }
    inside { print }
  ' "$1"
}

# One recognized echo per output line: "K<TAB>L<TAB>payload". The anchor is STRICT — optional leading
# whitespace and at most ONE list marker that must itself be followed by whitespace, then the address
# at the START of the line. A marker buried mid-sentence is prose, not an echo.
#
# Two properties are load-bearing. (1) The addresses are NORMALIZED here, at the parse boundary:
# `%d` over `k + 0` hands bash a canonical decimal, because a model-written `part 08` would otherwise
# reach bash arithmetic and an array index as OCTAL and abort the wrapper with `value too great for
# base` instead of the contracted clean refusal — and a safely padded `01` would mismatch `1`. An
# out-of-range number is REPORTED as address 0 — never dropped, because a dropped address is an
# INVISIBLE one, and an answer carrying every correct echo plus one invented giant address would
# otherwise satisfy a grammar whose whole point is that it is closed. (2) The anchor is
# matched case-INSENSITIVELY on a lowered copy while the PAYLOAD is sliced from the ORIGINAL line:
# tolerating `Part 1 Line 5:` removes a false refusal, but the echoed text must keep its own case or
# the verbatim comparison would be checking something the model never wrote.
fed_proof_entries() {  # reads the section on stdin
  LC_ALL=C awk -v addrmax="$FED_PROOF_ADDRESS_MAX" '
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      sub(/^[-*][ \t]+/, "", line)
      probe = tolower(line)
      if (match(probe, /^part[ \t]+[0-9]+[ \t]+line[ \t]+[0-9]+:/)) {
        head = substr(probe, 1, RLENGTH)
        rest = substr(line, RLENGTH + 1)
        k = head; sub(/^part[ \t]+/, "", k); sub(/[ \t]+line.*$/, "", k)
        l = head; sub(/^.*line[ \t]+/, "", l); sub(/:$/, "", l)
        # An out-of-range address is REPORTED as address 0, never dropped: dropping it made a huge
        # bogus address INVISIBLE, so an answer carrying every correct echo PLUS one invented
        # `part 99999999999999999999 line …` satisfied the closed grammar and minted a receipt.
        if (k + 0 > addrmax || l + 0 > addrmax) { printf "0\t0\t%s\n", rest; next }
        printf "%d\t%d\t%s\n", k + 0, l + 0, rest
      }
    }'
}

verify_delivery_proof() {  # $1 = captured final-turn output
  local k l payload want got section entries
  local -a seen_count=() seen_payload=()
  section="$(fed_proof_section "$1")"
  entries="$(printf '%s\n' "$section" | fed_proof_entries)"
  for (( k = 1; k <= FED_PART_COUNT; k++ )); do
    seen_count[k]=0
    seen_payload[k]=""
  done
  if [[ -n "$entries" ]]; then
    while IFS=$'\t' read -r k l payload; do
      if (( k == 0 )); then
        echo "error: the review did NOT prove delivery — its proof section echoes an address whose numbers are" >&2
        echo "       out of range (over ${FED_PROOF_ADDRESS_MAX}). An answer that invents its own addresses is not a proof:" >&2
        echo "       NO receipt was written. Re-run the review." >&2
        return 1
      fi
      if (( k < 1 || k > FED_PART_COUNT )) || [[ "$l" != "${FED_ECHO_LINE[k]}" ]]; then
        echo "error: the review did NOT prove delivery — its proof section echoes 'part ${k} line ${l}', which" >&2
        echo "       was never requested. An answer that invents its own addresses is not a proof: NO receipt" >&2
        echo "       was written. Re-run the review." >&2
        return 1
      fi
      seen_count[k]=$(( seen_count[k] + 1 ))
      if (( seen_count[k] == 1 )); then seen_payload[k]="$payload"; fi
    done <<< "$entries"
  fi
  for (( k = 1; k <= FED_PART_COUNT; k++ )); do
    if (( seen_count[k] == 0 )); then
      echo "error: the review did NOT prove delivery — its '### Delivery proof' section carries no echo for" >&2
      echo "       part ${k} of ${FED_PART_COUNT} (requested: part ${k} line ${FED_ECHO_LINE[k]}). A review that cannot" >&2
      echo "       reproduce a part's body never received it: NO receipt was written. Re-run the review." >&2
      return 1
    fi
    if (( seen_count[k] > 1 )); then
      echo "error: the review did NOT prove delivery — part ${k}'s address is echoed more than once" >&2
      echo "       (${seen_count[k]} times). One address, one line: an ambiguous proof proves nothing, so NO" >&2
      echo "       receipt was written. Re-run the review." >&2
      return 1
    fi
    got="${seen_payload[k]}"
    want="${FED_ECHO_TEXT[k]}"
    if [[ "$(trim_ws "$got")" != "$(trim_ws "$want")" ]]; then
      echo "error: the review did NOT prove delivery — part ${k}'s echoed line does not match the change set" >&2
      echo "       (requested: part ${k} line ${FED_ECHO_LINE[k]}). Delivery is unproven, so NO receipt was written." >&2
      echo "       Re-run the review; a model that DID receive every part but mis-transcribed one line is the" >&2
      echo "       known false-refusal case." >&2
      return 1
    fi
  done
  return 0
}

# Dispatch the prebuilt turns. Invariant E: a feed turn's stdout is captured PRIVATELY — nothing it
# produced (an OK, or a premature verdict) reaches this wrapper's stdout or the parsed capture, and
# the FIRST non-zero feed turn stops the run so no later turn is spent.
run_fed_review() {
  local k conv_id="" log_file="$staging/turn1.log" feed_out="$staging/feed-turn-out" turn_rc turn_pass=()
  # ONE wall-clock budget for the WHOLE fed review, not one per turn. Handing every call the full
  # AGY_HARD_TIMEOUT multiplied the stated cap by the turn count — a 30m cap silently became up to
  # 30m × (N+1). Each turn now gets only what is LEFT of the shared deadline, and a review that runs
  # out of budget stops there instead of quietly outliving its own guarantee.
  # The grace agy.sh hands timeout(1) as --kill-after: a turn that ignores TERM keeps running that
  # much longer, so handing a turn the FULL remaining time lets the last one outlive the deadline by
  # the grace. Each turn is therefore given remaining MINUS the grace, and the whole N+1 sequence
  # stays inside the stated cap even when every turn has to be SIGKILLed.
  local deadline remaining turn_hard turn_soft soft_budget budget
  deadline=$(( $(date +%s) + $(aw_duration_seconds "$AGY_HARD_TIMEOUT") ))
  soft_budget=$(aw_duration_seconds "$AGY_TIMEOUT")
  for (( k = 1; k <= FED_PART_COUNT; k++ )); do
    remaining=$(( deadline - $(date +%s) ))
    # A turn needs strictly more than the SIGKILL grace to be dispatchable: hand it 1s and a
    # TERM-ignoring process still runs grace+1 seconds, breaking the very cap this loop enforces.
    # Too little left is therefore a refusal, never a shrunken turn.
    if (( remaining <= AGY_TURN_KILL_GRACE_S )); then
      echo "error: the fed review exhausted its hard wall-clock cap (AGY_HARD_TIMEOUT=${AGY_HARD_TIMEOUT}) before" >&2
      echo "       feed turn ${k} of ${FED_PART_COUNT} — ${remaining}s left, and a turn needs more than the" >&2
      echo "       ${AGY_TURN_KILL_GRACE_S}s SIGKILL grace to run without outliving the cap. The cap covers the WHOLE" >&2
      echo "       review, not each turn — no later turn is spent and NO receipt is written." >&2
      echo "       Re-run with a larger cap, or a smaller change set." >&2
      return 124
    fi
    budget=$(( remaining - AGY_TURN_KILL_GRACE_S ))
    turn_hard="${budget}s"
    turn_soft="$(( soft_budget < budget ? soft_budget : budget ))s"
    if (( k == 1 )); then turn_pass=(--log-file "$log_file")
    elif [[ -n "$conv_id" ]]; then turn_pass=(--conversation "$conv_id")
    else turn_pass=(--continue)
    fi
    set +e
    # Dispatched from the STAGING dir, never the work tree: agy surfaces the cwd's context file
    # (AGENTS.md / GEMINI.md / .antigravity.md) automatically, and that is text the model can see
    # which is NOT a body. The delivery proof is only sound when the wrapper knows every non-body
    # byte the model can read, so the fed lane removes the uncontrolled input instead of guessing
    # at it. Nothing is lost: the grounded facts already carry what the review must know.
    ( cd "$staging" && AGY_MODEL="$AGY_MODEL" AGY_TIMEOUT="$turn_soft" AGY_HARD_TIMEOUT="$turn_hard" \
      "$AGY_RUN" "@$staging/turn-$k" -- "${turn_pass[@]}" ) > "$feed_out"
    turn_rc=$?
    set -e
    if (( turn_rc != 0 )); then
      echo "error: feed turn ${k} of ${FED_PART_COUNT} failed (exit ${turn_rc}) — the change set was never fully" >&2
      echo "       delivered, so no later turn is spent and NO receipt is written. Re-run the review." >&2
      return "$turn_rc"
    fi
    if (( k == 1 )); then
      conv_id="$(capture_conversation_id "$log_file")"
      if [[ -z "$conv_id" ]]; then
        echo "notice: could not capture the conversation id from agy's run log — the remaining turns ride" >&2
        echo "        --continue instead. Stated, never silent; the delivery proof still fails closed if" >&2
        echo "        another conversation answers." >&2
      fi
    fi
  done
  if [[ -n "$conv_id" ]]; then turn_pass=(--conversation "$conv_id"); else turn_pass=(--continue); fi
  remaining=$(( deadline - $(date +%s) ))
  if (( remaining <= AGY_TURN_KILL_GRACE_S )); then
    echo "error: the fed review exhausted its hard wall-clock cap (AGY_HARD_TIMEOUT=${AGY_HARD_TIMEOUT}) before the" >&2
    echo "       final review turn — ${remaining}s left, less than the ${AGY_TURN_KILL_GRACE_S}s SIGKILL grace a turn" >&2
    echo "       needs. Every part was delivered but the review itself was never asked for." >&2
    echo "       NO receipt was written. Re-run with a larger cap, or a smaller change set." >&2
    return 124
  fi
  budget=$(( remaining - AGY_TURN_KILL_GRACE_S ))
  turn_hard="${budget}s"
  turn_soft="$(( soft_budget < budget ? soft_budget : budget ))s"
  set +e
  ( cd "$staging" && AGY_MODEL="$AGY_MODEL" AGY_TIMEOUT="$turn_soft" AGY_HARD_TIMEOUT="$turn_hard" \
    "$AGY_RUN" "@$staging/turn-final" -- "${turn_pass[@]}" ) | tee "$review_out_file"
  turn_rc=${PIPESTATUS[0]}
  set -e
  return "$turn_rc"
}

# Emit the full review surface to stdout: repo map (bounded, see emit_repo_file_map), status
# (never-committable untracked records filtered), staged + unstaged diffs, and the CONTENTS of every
# untracked REGULAR file (NUL-safe iteration over the SAME filtered walk as the fingerprint — the
# payload is byte-identical with and without a device mask). Symlinks are shown as their target
# (never followed — no out-of-repo leak); directories/vanished paths are noted, never read (a `cat`
# on a FIFO would hang BEFORE the hard timeout applies — that class never reaches this loop).
assemble_code_diff() {
  echo "=== repo file map (git ls-files) ==="
  emit_repo_file_map
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
  echo "usage: $0 code   [--facts @f] [--ungrounded] [--decided @f] [--focus \"…\"] [--nonce <n>] [extra focus…]" >&2
  echo "       $0 plan   <plan-file> [--facts @f] [--decided @f] [--focus \"…\"] [--nonce <n>]" >&2
  echo "       $0 diff   <diff-file> [--facts @f] [--decided @f] [--focus \"…\"] [--nonce <n>]" >&2
  echo "       $0 --continue          [--decided @f] [--focus \"…\"] [--nonce <n>]" >&2
  echo "       $0 --conversation <id> [--decided @f] [--focus \"…\"] [--nonce <n>]" >&2
}

# --- Mode dispatch (non-resume) ----------------------------------------------
mode=""
target=""
PLAN_CONTENT=""
DIFF_CONTENT=""
REVIEW_ARTIFACT=""
REVIEW_FINGERPRINT=""
# D8/D8b: an agy `code` receipt SELF-DECLARES how the change set reached the model — `inline` when
# the whole set rode ONE prompt (delivery proven BY CONSTRUCTION), `fed` when a chunked feed proved
# it by echo. The kit's gate requires the field present and valid, never a particular value, and a
# receipt that does not declare one no longer attests (the old --add-dir lane could not).
REVIEW_DELIVERY=""
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
UNGROUNDED=0
NONCE_FLAG=""
NONCE_FLAG_SET=0
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
    --ungrounded)
      if [[ -n "$resume_mode" ]]; then
        echo "error: --ungrounded is not valid on a continuation (the original round already set its grounding)." >&2
        exit 2
      fi
      UNGROUNDED=1; shift ;;
    --decided)
      need_value "$1" "${2:-}"; DECIDED_RAW="$2"; shift 2 ;;
    --focus)
      need_value "$1" "${2:-}"; FOCUS_PARTS+=("$2"); shift 2 ;;
    --nonce)
      # Not need_value: the nonce's CLOSED grammar admits leading-dash values and validates
      # deterministically below — the next argument is taken unconditionally (only end-of-args
      # refuses here), and presence rides its own flag so an EMPTY value still hits the grammar
      # screen and a duplicate after it still refuses.
      if [[ $# -lt 2 ]]; then
        echo "error: --nonce needs a value; got '<end of args>'." >&2
        exit 2
      fi
      if [[ "$NONCE_FLAG_SET" == "1" ]]; then
        echo "error: duplicate --nonce — one dispatch carries one nonce." >&2
        exit 2
      fi
      NONCE_FLAG="$2"; NONCE_FLAG_SET=1; shift 2 ;;
    --)
      echo "error: this wrapper OWNS the review posture — no '--' passthrough. The only escapes are" >&2
      echo "       AGY_PROBE=1 (off-frontier model). An oversized code review is a chunked feed, not a flag." >&2
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

# --nonce rides the EXISTING AW_REVIEW_NONCE seam (flow FLOW-NONCE-DISPATCH-LANE): the
# plain-argument lane for hosts whose dispatch policy has no env-prefix form. The flag and a
# non-empty env value must AGREE — two disagreeing sources would mint an ambiguous dispatch
# identity (fail closed). Grammar screen identical to the env screen above (enumerated ASCII —
# locale-independent), pre-spend.
if [[ "$NONCE_FLAG_SET" == "1" ]]; then
  if [[ ! "$NONCE_FLAG" =~ ^[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-]{1,64}$ ]]; then
    echo "error: --nonce fails the safe nonce grammar ([A-Za-z0-9._-]{1,64}) — the derived manifest name would be unsafe; fix the nonce and re-run." >&2
    exit 2
  fi
  if [[ -n "${AW_REVIEW_NONCE:-}" && "${AW_REVIEW_NONCE}" != "$NONCE_FLAG" ]]; then
    echo "error: --nonce disagrees with the AW_REVIEW_NONCE environment value — one dispatch carries one nonce; drop one source and re-run." >&2
    exit 2
  fi
  AW_REVIEW_NONCE="$NONCE_FLAG"
fi

# --ungrounded closed grammar (D4): code-mode only, and an explicit contradiction with --facts refuses.
if [[ "$UNGROUNDED" == "1" ]]; then
  if [[ -n "$FACTS_RAW" ]]; then
    echo "error: --ungrounded contradicts --facts — pass the verified facts (grounded) or drop them (--ungrounded), never both." >&2
    exit 2
  fi
  if [[ "$mode" != "code" ]]; then
    echo "error: --ungrounded is only valid in code mode — $mode mode already proceeds ungrounded with a loud warning." >&2
    exit 2
  fi
fi

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
  # code mode fails CLOSED before the spend (D4): an ungrounded CODE receipt records grounded:false,
  # which the review-state gate rejects — the run would be paid for and attest nothing. Keyed on the
  # resolved CONTENT, so --facts naming an empty payload refuses identically.
  if [[ "$mode" == "code" && "$UNGROUNDED" != "1" && "$AGY_PROBE" != "1" ]]; then
    # The recovery hint resolves the kit's grounding tool from THIS wrapper's location (monorepo
    # canon / deployed skills sibling / kit-bundled mirror) — a repo-relative path would not exist
    # for a globally installed kit. Quoted: an install path may carry spaces.
    grounding_tool="node <agent-workflow-kit>/tools/grounding.mjs"
    for _g in "$HERE/../../agent-workflow-kit/tools/grounding.mjs" "$HERE/../../../tools/grounding.mjs"; do
      if [[ -f "$_g" ]]; then grounding_tool="node \"$_g\""; break; fi
    done
    echo "error: 'agy-review code' requires grounded facts and refuses BEFORE spending a run — an" >&2
    echo "       ungrounded code review GUESSES, and its receipt (grounded:false) never attests." >&2
    echo "       Assemble the verified facts, then re-run:" >&2
    echo "         $grounding_tool --constraints [--plan <plan-file>] --out <facts-file>" >&2
    echo "         agy-review code --facts @<facts-file>" >&2
    echo "       Explicit escapes: --ungrounded (throwaway opinion) · AGY_PROBE=1 (a probe never attests)." >&2
    exit 2
  fi
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
    REVIEW_DELIVERY="inline"
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

  # Partition the assembled change set into under-cap parts, pick each part's delivery-proof line,
  # and BUILD every turn's prompt UP FRONT — so the per-turn ceiling and the total outgoing byte
  # count (D1b) are both checked BEFORE a single subscription turn is spent. A refusal here costs
  # nothing; a refusal after turn 1 would have burned quota for no review.
  plan_fed_review() {
    local artifact_file="$staging/change-set" uniques="$staging/uniques" nonbody="$staging/nonbody"
    local grounding_bytes frame_bytes begin_bytes end_bytes overhead1 overheadk budget1 budgetk
    local artifact_bytes concat_bytes offset len k n picked built total_bytes
    local art_lines final_nl part_lengths

    ( umask 077; emit_artifact > "$artifact_file" )
    ( umask 077; emit_grounding > "$staging/grounding" )
    artifact_bytes=$(( $(wc -c < "$artifact_file") ))
    grounding_bytes=$(( $(wc -c < "$staging/grounding") ))
    # Measured at the WIDEST index rendering the loop can produce, so a part count that only becomes
    # known during planning can never push an already-budgeted turn past the ceiling.
    frame_bytes=$(( $(emit_feed_frame 9999 9999 | wc -c) ))
    begin_bytes=$(( $(printf -- "$FED_BEGIN_FMT" 9999 9999 | wc -c) ))
    end_bytes=$(( $(printf -- "$FED_END_FMT" 9999 9999 | wc -c) ))
    overhead1=$(( grounding_bytes + frame_bytes + begin_bytes + end_bytes ))
    overheadk=$(( frame_bytes + begin_bytes + end_bytes ))
    budget1=$(( AGY_MAX_PROMPT_BYTES - overhead1 ))
    budgetk=$(( AGY_MAX_PROMPT_BYTES - overheadk ))
    if (( budget1 < 1 || budgetk < 1 )); then
      echo "error: the fed lane's fixed overhead (grounding ${grounding_bytes} B + delivery framing ${overheadk} B)" >&2
      echo "       leaves no room for a change-set body under AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES}." >&2
      echo "       Trim --facts / --decided / --focus, or raise AGY_MAX_PROMPT_BYTES (never past ~${AGY_ARGV_HARD_MAX})." >&2
      exit 2
    fi

    art_lines=$(( $(LC_ALL=C awk 'END { print NR + 0 }' "$artifact_file") ))
    final_nl=1
    if [[ "$(tail -c 1 "$artifact_file" | wc -l)" -eq 0 ]]; then final_nl=0; fi
    # Run the partitioner ONCE into a variable: a refusal must be seen, and a `< <(…)` process
    # substitution would swallow its status.
    if ! part_lengths="$(plan_fed_parts "$artifact_file" "$budget1" "$budgetk" "$art_lines" "$final_nl")"; then
      echo "error: a single change-set line does not fit even an EMPTY fed part (first part budget" >&2
      echo "       ${budget1} B, later parts ${budgetk} B). The lane cuts only at line boundaries, and a part" >&2
      echo "       built from fragments of one giant line carries no line to prove delivery with —" >&2
      echo "       refusing before any turn is spent. Exclude the oversized file, or review it alone." >&2
      exit 2
    fi
    offset=0
    k=0
    if [[ -n "$part_lengths" ]]; then
      while IFS= read -r len; do
        k=$(( k + 1 ))
        if (( len < 1 )); then
          echo "error: the partitioner produced an empty part — refusing rather than spending a turn on nothing." >&2
          exit 2
        fi
        ( umask 077; slice_bytes "$artifact_file" "$offset" "$len" > "$staging/part-$k" )
        offset=$(( offset + len ))
      done <<< "$part_lengths"
    fi
    n=$k
    concat_bytes=0
    for (( k = 1; k <= n; k++ )); do concat_bytes=$(( concat_bytes + $(wc -c < "$staging/part-$k") )); done
    if (( n < 1 || concat_bytes != artifact_bytes )); then
      echo "error: the change-set partition does not reassemble to the assembled change set" >&2
      echo "       (${concat_bytes} of ${artifact_bytes} bytes across ${n} part(s)) — refusing rather than" >&2
      echo "       reviewing a change set the model would receive incompletely." >&2
      exit 2
    fi

    ( umask 077; LC_ALL=C awk '{ t = $0; gsub(/^[ \t]+|[ \t]+$/, "", t); c[t]++ } END { for (l in c) if (c[l] == 1) print l }' "$artifact_file" > "$uniques" )
    if [[ ! -s "$uniques" ]]; then
      echo "error: the change set carries no line unique enough to serve as a delivery proof — refusing," >&2
      echo "       because an unprovable delivery is exactly what this lane exists to prevent." >&2
      exit 2
    fi
    # Everything the wrapper itself will SEND that is not a BODY. A candidate occurring anywhere in
    # here would be revealed to a model that never received its part, so the proof would prove
    # nothing. Rendered with the REAL part indices, because the frames carry them.
    ( umask 077; {
        cat "$staging/grounding"
        for (( k = 1; k <= n; k++ )); do
          emit_feed_frame "$k" "$n"
          printf -- "$FED_BEGIN_FMT" "$k" "$n"
          printf -- "$FED_END_FMT" "$k" "$n"
        done
        emit_fed_final_head
        emit_shape_fed "(addresses are appended below)"
      } > "$nonbody" )

    # ONE pass, no re-picking. The address list cannot reveal a candidate BY CONSTRUCTION (see
    # emit_shape_fed: one address per line, every such line shorter than a candidate's minimum), so
    # there is nothing to re-check once the addresses exist — the earlier two-pass blacklist loop was
    # solving a problem the FORMAT removes, and it could not be made a complete search anyway.
    local cand_no cand_text cand_trim address
    FED_REQUESTED=""
    for (( k = 1; k <= n; k++ )); do
      picked=""
      while IFS=$'\t' read -r cand_no cand_text; do
        cand_trim="$(trim_ws "$cand_text")"
        [[ -n "$cand_trim" ]] || continue
        (( $(fixed_occurrences "$cand_trim" "$artifact_file") == 1 )) || continue
        (( $(fixed_occurrences "$cand_trim" "$nonbody") == 0 )) || continue
        picked="${cand_no}"$'\t'"${cand_text}"
        break
      done < <(list_echo_candidates "$staging/part-$k" "$uniques")
      if [[ -z "$picked" ]]; then
        echo "error: part ${k} of ${n} carries no line the wrapper can use as a delivery proof — it needs an" >&2
        echo "       interior line of ${FED_ECHO_MIN_BYTES}..${FED_ECHO_MAX_BYTES} bytes that occurs exactly ONCE in the whole change set and" >&2
        echo "       nowhere in the wrapper's own framing. Refusing: delivery could not be proven." >&2
        exit 2
      fi
      FED_ECHO_LINE[k]="${picked%%$'\t'*}"
      FED_ECHO_TEXT[k]="${picked#*$'\t'}"
      address="part ${k} line ${FED_ECHO_LINE[k]}"
      # The invariant the one-pass selection rests on, ASSERTED rather than assumed: an address line
      # long enough to contain a candidate would break the constructive guarantee.
      if (( ${#address} >= FED_ECHO_MIN_BYTES )); then
        echo "error: the address '${address}' is ${#address} bytes, at or past the ${FED_ECHO_MIN_BYTES}-byte proof-candidate minimum —" >&2
        echo "       the request list could then reveal a candidate. Refusing rather than sending an unsound proof." >&2
        exit 2
      fi
      if [[ -n "$FED_REQUESTED" ]]; then FED_REQUESTED+=$'\n'; fi
      FED_REQUESTED+="$address"
    done

    for (( k = 1; k <= n; k++ )); do
      ( umask 077; {
          if (( k == 1 )); then cat "$staging/grounding"; fi
          emit_feed_frame "$k" "$n"
          printf -- "$FED_BEGIN_FMT" "$k" "$n"
          cat "$staging/part-$k"
          printf -- "$FED_END_FMT" "$k" "$n"
        } > "$staging/turn-$k" )
    done
    ( umask 077; { emit_fed_final_head; echo; emit_shape_fed "$FED_REQUESTED"; } > "$staging/turn-final" )

    total_bytes=0
    for (( k = 1; k <= n; k++ )); do
      built=$(( $(wc -c < "$staging/turn-$k") ))
      if (( built > AGY_MAX_PROMPT_BYTES )); then
        echo "error: fed turn ${k} would be ${built} bytes, over AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES} —" >&2
        echo "       refusing before any turn is spent." >&2
        exit 2
      fi
      total_bytes=$(( total_bytes + built ))
    done
    built=$(( $(wc -c < "$staging/turn-final") ))
    if (( built > AGY_MAX_PROMPT_BYTES )); then
      echo "error: the final review turn would be ${built} bytes, over AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES}." >&2
      echo "       Trim --facts / --decided / --focus." >&2
      exit 2
    fi
    total_bytes=$(( total_bytes + built ))
    if (( total_bytes > AGY_REVIEW_MAX_TOTAL_BYTES )); then
      echo "error: the fed review would send ${total_bytes} outgoing prompt bytes across $(( n + 1 )) turns," >&2
      echo "       over AGY_REVIEW_MAX_TOTAL_BYTES=${AGY_REVIEW_MAX_TOTAL_BYTES} — refusing BEFORE the first turn is spent." >&2
      echo "       Split the change set into focused per-area reviews, or raise AGY_REVIEW_MAX_TOTAL_BYTES" >&2
      echo "       knowing that retention past ~263000 bytes of body has never been probed." >&2
      exit 2
    fi

    FED_PART_COUNT=$n
    echo "notice: the assembled prompt is ${prompt_bytes} bytes (> AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES}) —" >&2
    echo "        feeding the change set in ${n} part(s) over $(( n + 1 )) subscription turns, then reviewing." >&2
    echo "        Total outgoing prompt bytes: ${total_bytes} (AGY_REVIEW_MAX_TOTAL_BYTES=${AGY_REVIEW_MAX_TOTAL_BYTES})." >&2
    # 4.3: state the boundary fact at the point of use. agy's own denial names the permission rule it
    # wants; granting it would widen a boundary for ALL agy use on this machine, so the kit surfaces
    # it and never writes it. The feed exists precisely so no permission is needed.
    echo "        (The change set is DELIVERED, not read: headless agy auto-denies its own read_file" >&2
    echo "        tool, and this kit never grants that permission — it would widen a boundary for every" >&2
    echo "        agy run on this machine. Delivery is proven per part instead.)" >&2
  }

  # Full prompt = grounding + artifact (inline) + shape.
  ( umask 077; { emit_grounding; emit_artifact; echo; emit_shape; } > "$prompt_file" )
  prompt_bytes=$(( $(wc -c < "$prompt_file") ))

  if (( prompt_bytes > AGY_MAX_PROMPT_BYTES )); then
    if [[ "$mode" == "code" ]]; then
      # The change set cannot be FETCHED on this host (agy's native read_file is auto-denied
      # headlessly), so it is DELIVERED: under-cap parts over continuation turns, proven by echo.
      plan_fed_review
      FED_MODE=1
      REVIEW_DELIVERY="fed"
    else
      # D2: chunking is code-mode only — a plan/diff artifact is an operator-supplied file the
      # operator can split, so those modes keep the refuse-over-cap contract verbatim.
      echo "error: the assembled prompt is ${prompt_bytes} bytes, over AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES}." >&2
      echo "       agy takes the prompt as a single argv; past ~131072 bytes it fails with a cryptic" >&2
      echo "       'Argument list too long'. Trim to the relevant hunks, or split into focused per-area" >&2
      echo "       reviews (split the $mode into focused parts)." >&2
      exit 2
    fi
  fi
fi

# --- D5 pre-spend posture gate + banner (one line, the ACTUAL run posture) ------------------
# The control-byte screen already ran at AGY_MODEL resolution (before any interpolation). An
# ATTESTING review (fresh code mode, guards on) whose wrapper cannot know the actual model
# (AGY_MODEL explicitly emptied → the CLI's own settings default decides) refuses pre-spend;
# AGY_PROBE=1 runs are exempt (their receipts never attest and record model null).
# Scoped to the ATTESTING branch only (grounded code, guards on): plan / diff / --ungrounded
# code mint receipts that never attest, so an emptied model just records posture.model null.
if [[ -z "$AGY_MODEL" && -z "$resume_mode" && "$REVIEW_PROBE" != "true" && "$REVIEW_ARTIFACT" == "code" && -n "$FACTS_CONTENT" ]]; then
  echo "error: AGY_MODEL is explicitly empty, so the ACTUAL review model is unknowable (the agy CLI's" >&2
  echo "       own settings default decides) — an attesting review refuses pre-spend. Fix: unset" >&2
  echo "       AGY_MODEL (wrapper default), or set the real model display string; AGY_PROBE=1 is exempt." >&2
  exit 2
fi
# The timeout field is BANNER-ONLY (AD-061): it prints exactly the duration agy-run hands to
# timeout(1) and never enters the receipt posture. The banner uses the PARENT-preflight-resolved
# path (builtin type -P, absolute); the child re-resolves at dispatch under the exported
# AGY_REQUIRE_TIMEOUT_BIN seam, whose missing-binary lane refuses — so an uncapped review
# dispatch cannot exist on either stage.
aw_timeout_banner="$(aw_timeout_label "$aw_review_timeout_bin" "$AGY_HARD_TIMEOUT")"
echo "review posture: model=${AGY_MODEL:-<agy settings default>} timeout=$aw_timeout_banner" >&2

# --- Execute via agy-run (single home of timeout + subscription + byte ceiling) ---
# The output is teed into the private staging dir so the mandated '### Verdict' section can be
# parsed into the review receipt — the user-facing stream is unchanged.
review_out_file="$staging/review-output"
set +e
if (( FED_MODE == 1 )); then
  run_fed_review
  rc=$?
elif (( ${#run_passthrough[@]} > 0 )); then
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
# D4 (wrapper honesty): a run that produced NO recognized '### Verdict' section — empty output
# included — is a FAILED review: non-zero exit, NO receipt. This is a failed review to RE-RUN,
# never a fatal session error (documented in --help).
if [[ $rc -eq 0 ]]; then
  # D1/D7: on the fed lane, delivery is checked BEFORE the verdict is even parsed — an unproven
  # delivery is never a downgraded verdict and never a warning beside a kept receipt.
  if (( FED_MODE == 1 )); then
    if fed_output_is_answerless "$review_out_file"; then
      echo "error: the fed review produced no review at all — the final turn returned neither a" >&2
      echo "       '### Delivery proof' nor a '### Verdict' section. The wrapper SENT every one of" >&2
      echo "       the ${FED_PART_COUNT} part(s) and every feed turn exited zero; whether the model retained them is" >&2
      echo "       precisely what the unanswered proof leaves unknown, so nothing is claimed here." >&2
      if fed_output_names_tool_denial "$review_out_file"; then
        echo "       CAUSE (named by agy itself): it called a tool and headless mode auto-denied it, which" >&2
        echo "       produces NO output at all. Observed on very large fed reviews; the fix is a SMALLER" >&2
        echo "       review — split the change set, or leave AGY_REVIEW_MAX_TOTAL_BYTES at its default so" >&2
        echo "       an oversized feed refuses before spending any turn." >&2
      else
        echo "       CAUSE: unknown — agy returned no recognizable diagnostic. Inspect the run output." >&2
      fi
      echo "       NO receipt was written. Re-run the review." >&2
      exit 4
    fi
    if ! verify_delivery_proof "$review_out_file"; then
      exit 4
    fi
  fi
  verdict="$(parse_agy_verdict "$review_out_file")"
  if [[ "$verdict" == "unknown" ]]; then
    echo "error: the review output carries no recognized '### Verdict' section (closed vocabulary:" >&2
    echo "       SHIP / SHIP WITH NITS / REWORK) — a FAILED review; NO receipt was written. Re-run" >&2
    echo "       the review; if it recurs, inspect the captured output for what the model produced." >&2
    exit 4
  fi
  if [[ -n "$resume_mode" ]]; then
    # A continuation never re-embeds the current artifact (agy holds the ORIGINAL round server-side;
    # --facts is rejected above), so it cannot attest the folded tree: fresh:false, artifact /
    # fingerprint / factsHash null, grounded false — informational-only, ignored by the state gate.
    write_review_receipt "" false "" "$verdict" false "" "$REVIEW_PROBE" "" "$review_out_file"
    echo "notice: a continuation receipt is fresh:false (informational-only) — only a fresh grounded run" >&2
    echo "        (agy-review code --facts @f) mints a receipt that satisfies the review-state gate." >&2
  else
    grounded=false
    facts_hash=""
    if [[ -n "$FACTS_CONTENT" ]]; then
      grounded=true
      facts_hash="$(printf '%s' "$FACTS_CONTENT" | sha256_stdin || true)"
    fi
    write_review_receipt "$REVIEW_ARTIFACT" true "$REVIEW_FINGERPRINT" "$verdict" "$grounded" "$facts_hash" "$REVIEW_PROBE" "$REVIEW_DELIVERY" "$review_out_file"
  fi
fi
exit $rc
