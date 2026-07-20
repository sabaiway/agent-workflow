#!/usr/bin/env bash
# Universal, neutral wrapper around Google's Antigravity CLI (`agy`).
#
# Antigravity CLI is the successor to Gemini CLI: as of 2026-06-18 the old
# Gemini CLI stopped serving Google AI Pro / Ultra / free tiers, and access to
# Google's models from the terminal moved to `agy`. This wrapper is the single
# entry point so callers never have to remember the flag spelling.
#
# Auth: SUBSCRIPTION ONLY. We use the cached OAuth token at
# ~/.gemini/antigravity-cli/antigravity-oauth-token (Google AI Pro) and the
# quota that comes with it. To make that guarantee hard, the wrapper unsets any
# API-key env var so a stray key can never silently switch us to paid
# pay-as-you-go billing.
#
# This is a THIN, FLOW-AGNOSTIC wrapper on purpose: it just runs one headless
# prompt and prints the text response. It does NOT encode any orchestration
# policy (no plan contract, no auto-approve, no workspace edits) — that is left
# to whatever flow we design later, which can opt in via passthrough flags.
#
# Models (pass the exact display string from `agy models`, or set AGY_MODEL):
#   Gemini 3.5 Flash (Low|Medium|High), Gemini 3.1 Pro (Low|High),
#   Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B (Medium)
#
# Usage (installed on PATH as `agy-run`):
#   agy-run "your prompt"                    # prompt as an argument
#   echo "your prompt" | agy-run -           # prompt from stdin
#   agy-run @path/to/prompt.md               # prompt from a file
#   AGY_MODEL="Claude Opus 4.6 (Thinking)" agy-run "..."   # pick a model
#   AGY_TIMEOUT=10m agy-run "..."            # override print timeout (agy's soft bound)
#   AGY_HARD_TIMEOUT=8m agy-run "..."        # override the hard wall-clock cap (timeout(1))
#   AGY_MAX_PROMPT_BYTES=60000 agy-run @big.md    # LOWER the single-argv byte ceiling (default 120000;
#                                            # the override only tightens it — it can never exceed the OS ~131072 limit)
#   agy-run "..." -- --add-dir . --dangerously-skip-permissions
#                                            # passthrough agy flags (future flows)
set -euo pipefail

# --- --help / -h (pre-preflight: no agy, no login needed) ----------------------
# Keyed ONLY on the FIRST argument — never a scan of all args, else a passthrough
# payload like `agy-run "prompt" -- --help` would be intercepted. agy-run is the
# probe role (not dispatched by any activity slot), so this help is authored here
# — not manifest-pinned (candidate C only).
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
agy-run — thin, flow-agnostic wrapper around Google's Antigravity CLI (agy; subscription-only, hard wall-clock cap).

Usage:
  agy-run "your prompt"
  echo "your prompt" | agy-run -
  agy-run @path/to/prompt.md
  agy-run <prompt|-|@file> -- <extra agy flags...>

Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):
  ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf
  AGY_HARD_TIMEOUT — hard wall-clock cap, duration string like 5m/30m/90s (built-in default = AGY_TIMEOUT, 5m)

Environment: AGY_MODEL (exact display string from `agy models`; empty ⇒ agy's settings.json), AGY_TIMEOUT / AGY_HARD_TIMEOUT (duration strings), AGY_MAX_PROMPT_BYTES (single-argv byte ceiling; the override only lowers it).
Requires at run time: the agy CLI on PATH + a Google AI subscription login (--help needs neither).
HELP
    exit 0
    ;;
esac

# 1. Make `agy` findable even when ~/.bashrc was not sourced.
export PATH="$HOME/.local/bin:$PATH"

# 2. Force the subscription path: never let an API key hijack billing. Unset EVERY *_API_KEY for the
#    agy subprocess — the explicit Google/Antigravity ones first, then any other *_API_KEY that may
#    have been added later (`compgen` is a bash builtin; the shebang guarantees bash).
unset ANTIGRAVITY_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_API_KEY 2>/dev/null || true
while IFS= read -r _api_key_var; do
  unset "$_api_key_var" 2>/dev/null || true
done < <(compgen -v 2>/dev/null | grep '_API_KEY$' || true)

# This wrapper's applied settings-file subset (see the shared reader block below).
AW_SETTINGS_APPLIED="AGY_HARD_TIMEOUT"

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

# --- Effective-timeout resolver (D5 banner honesty; AD-061) --------------------
# ONE rule, both bridges: the posture banner prints EXACTLY the duration handed to timeout(1) —
# an integer-seconds value rendered with the `s` suffix, a duration string verbatim — and
# `timeout=uncapped` when no timeout/gtimeout binary can cap the run; never a fabricated number.
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

if ! command -v agy >/dev/null 2>&1; then
  echo "error: 'agy' (Antigravity CLI) not found on PATH. Install it and run 'agy' once to sign in." >&2
  exit 127
fi

# `-` (empty) => skip --model and let agy use settings.json; default to Pro.
AGY_MODEL="${AGY_MODEL-Gemini 3.1 Pro (High)}"
AGY_TIMEOUT="${AGY_TIMEOUT:-5m}"
AGY_TIMEOUT="$(aw_effective_timeout AGY_TIMEOUT 5m)"
# Hard wall-clock cap (defaults to AGY_TIMEOUT). agy's own --print-timeout is NOT a reliable
# wall-clock kill — a run was observed surviving 32 min past a 10m --print-timeout — so we also wrap
# agy in timeout(1). A heavy `--add-dir` agentic prompt on the slowest model can otherwise run
# unbounded, and once a caller backgrounds it nothing kills it. Raise only for a known-healthy run.
AGY_HARD_TIMEOUT="${AGY_HARD_TIMEOUT:-$AGY_TIMEOUT}"
AGY_HARD_TIMEOUT="$(aw_effective_timeout AGY_HARD_TIMEOUT "$AGY_TIMEOUT")"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <prompt | - | @file> [-- extra agy flags...]" >&2
  exit 2
fi

prompt_src="$1"; shift

# Split off any passthrough flags after a literal `--`. Extra args WITHOUT the `--` separator are a
# mistake — they would be silently dropped, so fail loudly instead (no silent failures).
passthrough=()
if [[ $# -gt 0 ]]; then
  if [[ "$1" == "--" ]]; then
    shift
    passthrough=("$@")
  else
    echo "error: unexpected argument '$1'. Pass extra agy flags after a literal '--':" >&2
    echo "       $0 <prompt | - | @file> -- <agy flags...>" >&2
    exit 2
  fi
fi

if [[ "$prompt_src" == "-" ]]; then
  prompt="$(cat)"
elif [[ "${prompt_src:0:1}" == "@" ]]; then
  file="${prompt_src:1}"
  if [[ ! -f "$file" ]]; then
    echo "error: prompt file '$file' not found" >&2
    exit 2
  fi
  prompt="$(cat "$file")"
else
  prompt="$prompt_src"
fi

if [[ -z "${prompt// }" ]]; then
  echo "error: empty prompt" >&2
  exit 2
fi

# --- Argv byte-ceiling guard --------------------------------------------------
# agy takes the prompt as a single `-p` argv. On Linux a single argv element past
# MAX_ARG_STRLEN (~131072 bytes) makes execve fail with a cryptic "Argument list
# too long". Guard the prompt THIS wrapper holds — the `-` (stdin) / `@file` paths,
# and pre-measuring callers like agy-review.sh — with a margin under that ceiling.
# Scope: a huge LITERAL `agy-run "<huge>"` argv fails at THIS script's own exec
# before any line here runs, so it can't be caught here — route large prompts via
# `-` (stdin) or `@file`, which land in $prompt where this guard can measure them.
AGY_MAX_PROMPT_BYTES="${AGY_MAX_PROMPT_BYTES:-120000}"
if [[ ! "$AGY_MAX_PROMPT_BYTES" =~ ^[0-9]+$ ]]; then
  echo "error: AGY_MAX_PROMPT_BYTES='$AGY_MAX_PROMPT_BYTES' is not a non-negative integer." >&2
  exit 2
fi
# The override may only TIGHTEN the ceiling. Raising it past the OS single-argv limit (MAX_ARG_STRLEN
# ~131072) would let an oversized prompt through the guard only to fail at `exec` with E2BIG — exactly
# what the guard exists to prevent. Reject anything above a safe hard maximum just under that limit.
AGY_ARGV_HARD_MAX=131000
if (( AGY_MAX_PROMPT_BYTES > AGY_ARGV_HARD_MAX )); then
  echo "error: AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES} exceeds the OS single-argv ceiling (~${AGY_ARGV_HARD_MAX})." >&2
  echo "       The prompt is passed as ONE -p argv; raising the limit past the OS ceiling only restores the cryptic" >&2
  echo "       'Argument list too long' failure. The override may LOWER the ceiling (stricter), never raise it past this." >&2
  exit 2
fi
prompt_bytes=$(( $(printf '%s' "$prompt" | wc -c) ))   # arithmetic strips any BSD `wc` padding
if (( prompt_bytes > AGY_MAX_PROMPT_BYTES )); then
  echo "error: prompt is ${prompt_bytes} bytes, over AGY_MAX_PROMPT_BYTES=${AGY_MAX_PROMPT_BYTES}." >&2
  echo "       agy takes the prompt as a single argv; past ~131072 bytes it fails with a cryptic" >&2
  echo "       'Argument list too long'. Trim or split the prompt. (Override via AGY_MAX_PROMPT_BYTES.)" >&2
  exit 2
fi

model_flag=()
if [[ -n "$AGY_MODEL" ]]; then
  model_flag=(--model "$AGY_MODEL")
fi

agy_cmd=(agy "${model_flag[@]}" --print-timeout "$AGY_TIMEOUT" "${passthrough[@]}" -p "$prompt")

# Hard wall-clock cap via timeout(1) (GNU `timeout` on Linux, `gtimeout` from coreutils on macOS).
# This is the real guard — a backgrounded, hung agy survives its own --print-timeout otherwise.
# aw_resolve_timeout_bin: builtin type -P (an exported function can shadow neither `timeout` nor
# `type` itself), normalized to an ABSOLUTE path fail-closed — nothing can masquerade as the cap.
timeout_bin="$(aw_resolve_timeout_bin)"

if [[ -z "$timeout_bin" ]]; then
  echo "warning: no 'timeout'/'gtimeout' on PATH — running agy WITHOUT a hard wall-clock cap" >&2
  echo "         (install coreutils to enable AGY_HARD_TIMEOUT=$AGY_HARD_TIMEOUT)." >&2
  exec "${agy_cmd[@]}"
fi

# --kill-after: if agy ignores the initial TERM, SIGKILL it 10s later. Capture rc (don't `exec`) so
# we can turn a timeout into an explicit, actionable error instead of a silent non-zero.
set +e
"$timeout_bin" --kill-after=10s "$AGY_HARD_TIMEOUT" "${agy_cmd[@]}"
rc=$?
set -e
if [[ $rc -eq 124 || $rc -eq 137 ]]; then
  echo "error: agy exceeded the hard cap AGY_HARD_TIMEOUT=$AGY_HARD_TIMEOUT and was terminated." >&2
  echo "       This usually means a heavy '--add-dir' agentic run, or the slowest model looping." >&2
  echo "       Retry with a faster model (e.g. AGY_MODEL='Gemini 3.5 Flash (High)') or a" >&2
  echo "       self-contained prompt without --add-dir. Raise AGY_HARD_TIMEOUT only if the run is healthy." >&2
fi
exit $rc
