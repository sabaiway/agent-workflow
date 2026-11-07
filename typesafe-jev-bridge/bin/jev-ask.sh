#!/usr/bin/env bash
# spec:typesafe-jev-bridge — docs/ai/specs/bridges/typesafe-jev-bridge/index.md
set -euo pipefail

aw_script_dir() {
  local src="${BASH_SOURCE[0]}" dir hops=0 max_hops=16
  while :; do
    case "$src" in */*) dir="${src%/*}"; dir="${dir:-/}" ;; *) dir=. ;; esac
    dir="$(CDPATH= builtin cd -P -- "$dir" 2>/dev/null && builtin pwd -P)" || break
    [[ -L "$src" ]] || { printf '%s\n' "$dir"; return 0; }
    if (( hops >= max_hops )); then
      printf 'error: exceeded %s symlink hops; could not resolve its OWN directory\n' "$max_hops" >&2
      return 127
    fi
    hops=$((hops + 1))
    src="$(command readlink -- "$src" 2>/dev/null)" || break
    case "$src" in /*) ;; *) src="$dir/$src" ;; esac
  done
  printf 'error: could not resolve its OWN directory\n' >&2
  return 127
}
aw_read_service_facts() {
  local path="${1%/*}/service-facts.txt" line key value entry number=0 bad=0 valid seen=() run_lines=()
  local host_re='^(\*\.)?[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789]([abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-]*[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789])?(\.[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789]([abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-]*[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789])?)+$'
  local variable_re='^[ABCDEFGHIJKLMNOPQRSTUVWXYZ][ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*$'
  local command_re='^[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789][abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]* \*$'
  local env directory segments LC_ALL=C
  AW_FACT_HOST=() AW_FACT_RUN_HOST=() AW_FACT_PASSED_VARIABLE=()
  if [[ -f "$path" && -r "$path" ]]; then
    while IFS= read -r line; do
      number=$((number + 1)); valid=1
      if (( number == 1 )); then
        [[ "$line" == "# generated from the kit's service fragments (agent-workflow-kit/tools/services/); do not edit" ]] || bad=1
        continue
      fi
      key="${line%%=*}"; value="${line#*=}"
      [[ "$line" == *=* ]] || valid=0
      case "$key" in
        HOST|RUN_HOST) [[ "$value" =~ $host_re ]] || valid=0
          if [[ "$key" == RUN_HOST && "$value" == '*.'* ]]; then valid=0; fi ;;
        PASSED_VARIABLE) [[ "$value" =~ $variable_re && "$value" != OPENAI_BASE_URL ]] || valid=0 ;;
        EXCLUDED_COMMAND) [[ "$value" =~ $command_re ]] || valid=0 ;;
        WRITABLE_DIR)
          env="${value%%:*}"; directory="${value#*:}"; segments="/${directory//\\//}/"
          [[ "$value" == *:* && ( -z "$env" || "$env" =~ $variable_re ) &&
            ( "$directory" == '~/'* || "$directory" == /* ) && "$directory" != */ &&
            "$directory" != *[\*\?\[\]]* && ! "$directory" =~ [[:cntrl:]] && "$segments" != */../* ]] || valid=0 ;;
        *) valid=0 ;;
      esac
      for entry in ${seen[@]+"${seen[@]}"}; do [[ "$entry" != "$line" ]] || valid=0; done
      if (( ! valid )); then (( bad )) || bad=$number; continue; fi
      seen+=("$line")
      case "$key" in
        HOST) AW_FACT_HOST+=("$value") ;; RUN_HOST) AW_FACT_RUN_HOST+=("$value"); run_lines+=("$number") ;;
        PASSED_VARIABLE) AW_FACT_PASSED_VARIABLE+=("$value") ;;
      esac
    done <"$path"
    if (( ! number )); then bad=1; fi
    if [[ -n "$line" ]] && (( ! bad )); then bad=$((number + 1)); fi
    for ((number=0; number<${#AW_FACT_RUN_HOST[@]}; number++)); do
      valid=0
      for entry in ${AW_FACT_HOST[@]+"${AW_FACT_HOST[@]}"}; do [[ "$entry" != "${AW_FACT_RUN_HOST[number]}" ]] || valid=1; done
      if (( ! valid && (! bad || run_lines[number] < bad) )); then bad=${run_lines[number]}; fi
    done
    (( bad )) || return 0
    printf 'error: %s: invalid facts at line %s; remove whatever is at that path and run /agent-workflow-kit upgrade to write it again\n' "$path" "$bad" >&2
  else
    printf 'error: %s: not a readable regular file; remove whatever is at that path and run /agent-workflow-kit upgrade to write it again\n' "$path" >&2
  fi
  exit 127
}
HERE="$(aw_script_dir)" || exit 127
aw_read_service_facts "$HERE"

AW_SETTINGS_APPLIED=""
aw_settings_file() {
  printf '%s/agent-workflow/bridge-settings.conf' "${XDG_CONFIG_HOME:-$HOME/.config}"
}
aw_settings_known() {
  case " CODEX_SERVICE_TIER CODEX_HARD_TIMEOUT CODEX_REVIEW_MAX_TOTAL_BYTES AGY_HARD_TIMEOUT AGY_REVIEW_ALLOW_ADDDIR AGY_REVIEW_MAX_TOTAL_BYTES CODEX_MODEL CODEX_EFFORT AGY_MODEL JEV_MODEL " in
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
aw_read_posture() {
  local key="$1" default="$2" empty="$3" file line value notify=1
  AW_HOST_VALUE="$default"
  AW_HOST_SOURCE="default"
  file="$(aw_settings_file)"
  [[ -n "${AW_SETTINGS_NOTIFIED:-}" ]] && notify=0
  if [[ -f "$file" && -r "$file" ]]; then
    line="$(grep "^${key}=" "$file" 2>/dev/null || true)"
    if [[ -n "$line" ]]; then
      value="${line##*$'\n'}"
      value="${value#*=}"
      if [[ -n "$value" && "$value" != *[$'\x01'-$'\x1f'$'\x7f']* ]]; then
        AW_HOST_VALUE="$value"
        AW_HOST_SOURCE="setting"
      elif (( notify )); then
        if [[ -n "$default" ]]; then
          echo "warning: $key in bridge settings file '$file' is empty or carries a control byte — using the built-in default '$default'." >&2
        else
          echo "warning: $key in bridge settings file '$file' is empty or carries a control byte — using the manifest's default." >&2
        fi
      fi
    fi
  fi
  AW_RUN_VALUE="$AW_HOST_VALUE"
  AW_RUN_SOURCE="$AW_HOST_SOURCE"
  if [[ -n "${!key+x}" ]]; then
    AW_RUN_VALUE="${!key:-$empty}"
    AW_RUN_SOURCE="environment"
  fi
  return 0
}
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
aw_scrub_billing_keys() {
  local name passed keep
  unset OPENAI_BASE_URL 2>/dev/null || true
  for name in $(compgen -v); do
    [[ "$name" == *_API_KEY ]] || continue
    keep=0
    for passed in ${AW_FACT_PASSED_VARIABLE[@]+"${AW_FACT_PASSED_VARIABLE[@]}"}; do
      [[ "$name" != "$passed" ]] || keep=1
    done
    if (( ! keep )); then unset "$name" 2>/dev/null || true; fi
  done
  return 0
}

AW_BRIDGE_VERSION="1.1.0"  # aw-version-anchor
case "${1:-}" in
  --help|-h)
    printf '%s\n' "jev-ask — judge notes through typesafe-jev-bridge $AW_BRIDGE_VERSION." '' \
      'Usage:' '  jev-ask <request-file>' '  jev-ask --help' \
      'Request: {"state": <non-empty string>, "questions": {<id>: {"type": "choice",' \
      '  "instructions": <non-empty string>, "criteria": {<option id>: <non-empty string>, ...}}}} (2..255 options)' \
      'Exit: 0 notes; 2 usage/request; 3 no key; 4 timeout; 5 HTTP; 6 malformed answer; 7 model mismatch; 8 transport; 127 installation.'
    exit 0
    ;;
esac

if (( $# != 1 )) || [[ "$1" == -* ]]; then
  printf '%s\n' 'jev-ask: usage: jev-ask <request-file> | jev-ask --help' >&2
  exit 2
fi
if (( ${#AW_FACT_RUN_HOST[@]} == 0 )); then
  printf 'jev-ask: %s: no RUN_HOST line; run /agent-workflow-kit upgrade to write it again\n' "${HERE%/*}/service-facts.txt" >&2
  exit 127
fi
if (( ${#AW_FACT_PASSED_VARIABLE[@]} == 0 )); then
  printf 'jev-ask: %s: no PASSED_VARIABLE line; run /agent-workflow-kit upgrade to write it again\n' "${HERE%/*}/service-facts.txt" >&2
  exit 127
fi
aw_scrub_billing_keys
aw_read_posture JEV_MODEL "" ""
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'jev-ask: node not found on PATH; install Node.js 22.21 or newer' >&2
  exit 127
fi
export NODE_USE_ENV_PROXY=1
exec node --disable-warning=UNDICI-EHPA "$HERE/jev-client.mjs" --host "${AW_FACT_RUN_HOST[0]}" --key-variable "${AW_FACT_PASSED_VARIABLE[0]}" --model "$AW_RUN_VALUE" --model-source "$AW_RUN_SOURCE" "$1"
