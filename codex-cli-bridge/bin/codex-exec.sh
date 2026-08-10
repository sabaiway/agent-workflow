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
#   - git WRITES are blocked by a physical shim (codex spawns git via execve, which
#     bypasses shell functions) — the orchestrator owns the commit boundary.
#
# Quality-first (hard rule): delegated codex work ALWAYS runs on the frontier
# model at maximum reasoning effort. The defaults below are pinned and the wrapper
# REFUSES a non-default CODEX_MODEL/CODEX_EFFORT — knowingly-worse output is never
# traded for quota. The ONLY exception is a throwaway probe whose result does not
# depend on effort: set CODEX_PROBE=1 (echoed loudly) to relax the guard. Economy
# comes from quality-neutral waste removal (clean capture, a hard timeout, a lean
# prompt, resume instead of re-sending context), never from a downgrade.
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
#   codex-exec --resume-last <file|->                # continue the last session (iterate, no re-send)
#   codex-exec --resume <session-id> <file|->        # continue a specific session
#   CODEX_HARD_TIMEOUT=7200 codex-exec <file>        # raise the hard wall-clock cap (integer seconds)
#   CODEX_PROBE=1 CODEX_MODEL=<slug> codex-exec <file>   # throwaway probe (relaxes the guard)
set -euo pipefail

# --- --help / -h (pre-preflight: no codex, no login, no git tree needed) -------
# Keyed ONLY on the FIRST argument — never a scan of all args, else a passthrough
# payload like `codex-exec f - -- --help` would be intercepted.
# The contract below is drift-guarded against capability.json roles.execute.contract.
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
codex-exec — delegate plan/instruction EXECUTION to the OpenAI Codex CLI (subscription-only; workspace-write sandbox, network OFF, git writes blocked — the orchestrator commits).

Usage:
  codex-exec [--nonce <n>] <plan-file|->
  codex-exec [--nonce <n>] <plan-file|-> -- <extra codex flags...>

Grounding:
  automatic — the root AGENTS.md (Hard Constraints) is auto-merged into codex's
  context and the wrapper prepends the orchestrator execution contract; no
  grounding flags

Round-2 / resume:
  codex-exec --resume-last [--nonce <n>] <plan-file|->
  codex-exec --resume <session-id> [--nonce <n>] <plan-file|->
  (resume continues the recorded session without re-sending context; takes no '--' passthrough)

Guarded passthrough after '--':
  blocked always: -c* --config* -s* --sandbox* --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --full-auto --oss --local-provider* -p* --profile* -m* --model* -o* --output-last-message* --json* --color* --output-schema* --ephemeral*
  relaxed only under CODEX_PROBE=1: --add-dir* -C* --cd* --skip-git-repo-check --ignore-rules --enable* --disable*

Receipt:
  side effect — a NONCED run mints ONE exec receipt beside the delegation store: the dispatch nonce
  seam is the AW_DISPATCH_NONCE environment value or its plain-argument equivalent --nonce <n>,
  recognised ONLY before the prompt operand (after the operand or a literal '--' it is passthrough
  payload, never a flag), under the safe grammar [A-Za-z0-9._-]{1,64} — anything else, a duplicate,
  or a flag disagreeing with a non-empty env value refuses PRE-SPEND. The store directory resolves
  exactly as the kit's delegation store does: the dirname of an ABSOLUTE AW_DELEGATION_STORE
  (a relative one, or one ending in a path separator, refuses), else the git common dir. The
  artifact is agent-workflow-exec-receipt-<backendLength>-<backend>-<nonce>.json in two states:
  'reserved' is written atomically and NO-CLOBBER immediately before the CLI runs — that write IS
  the nonce reservation, so a second dispatch on the same nonce, or an already-taken report name,
  refuses BEFORE any spend — and 'terminal' replaces it in place at exit. A nonced run also refuses
  pre-spend when no timeout/gtimeout binary can cap it (an accounted dispatch that cannot be capped
  can never honour the terminal-exit rule; a nonce-LESS run still warns and runs uncapped), when
  node is missing (the mint core), and when the prompt rides on stdin instead of a contract FILE —
  contractDigest is computed BY THIS WRAPPER from the dispatch file it was actually handed, so the
  kit can refuse a run that executed a different contract than the one it opened. That digest is
  taken from the SAME bytes already read as the prompt, never a second open of the path: two reads
  leave a window in which the file can be swapped, and the run would then execute one contract while
  its receipt claimed the digest of another. The header's own nonce must EQUAL the dispatch nonce —
  'dispatch open' copies the nonce FROM the header, so a disagreeing --nonce could only reserve an
  identity no return would ever absorb, and it refuses pre-spend. A contract file edited BETWEEN
  'dispatch open' and the run is caught at ABSORB by the contractDigest comparison, not pre-spend:
  the wrapper never reads the ledger, and that boundary is what the whole lane rests on. At exit the
  wrapper FIRST re-reads its reservation and verifies its own opaque owner token — a foreign owner
  refuses having published NOTHING, neither report nor receipt — THEN writes the delegate's final
  message atomically to agent-workflow-exec-report-<backendLength>-<backend>-<nonce>.txt, THEN
  re-verifies the owner and REPLACES the reservation with the terminal receipt {schema, kind, state,
  backend, nonce, owner, contractDigest, wrapperVersion, posture {model, effort, tier}, capS,
  killGraceS, sessionId, exitStatus, outcome, reportDigest, reportLength, timestamp}: the report is
  complete on disk before any artifact says the run arrived. capS and killGraceS are the cap the run
  ACTUALLY applied. outcome is the wrapper's own SUBSET of the ledger's vocabulary — exit 0 with a
  session id -> success, exit 0 without one -> missing-identity, ANY nonzero exit including the
  timeout codes 124 and 137 -> transport-failure; every orchestrator judgment is recorded at absorb
  time, never claimed here. The session id is captured BEFORE outcome branching, so a FAILED run
  records one too; in resume mode it is the validated resume id. FAIL-CLOSED, deliberately NOT the
  review lane's warn-only receipt: a publication that cannot complete exits nonzero with a DISTINCT
  status, and the message states only what the run can still prove. 70: the reservation could not be
  verified BEFORE any publication — NOTHING was published, not the report and not the receipt, and
  because the artifact found there belongs to another run it is never a '--no-receipt' source. 71: a
  publication stopped after that point — either the report write failed (nothing beyond the
  reservation was published; the '--no-receipt' absorb then records reportLength 0, ineligible by the
  name empty-report) or the report IS on disk and the terminal receipt was not completed (the absorb
  reads it, report-if-present). The post-report lane never claims the reservation still stands,
  because after that point its fate is no longer something this run observed. Every lane names the
  tree as partial/dirtied rather than untouched. A nonce-LESS invocation is byte-unchanged: no
  reservation, no receipt, no artifact, no node.

Notes:
  nested-sandbox limit: codex-exec ships its OWN OS sandbox (bwrap workspace-write) and cannot run
  nested inside a harness sandbox (the FS turns read-only) — route it OUTSIDE the harness sandbox
  (excludedCommands / a per-run consented bypass) on the OBSERVED bwrap/EPERM failure, never a
  preemptive blanket
  exec posture banner: ONE stderr line before dispatch states the ACTUAL run posture —
  exec posture: model=… effort=… tier=… sandbox=workspace-write session=fresh|resume:<id> timeout=… —
  from RESOLVED post-validation values; the resume id is validated pre-spend, and control bytes in
  any banner field refuse pre-spend
  threat model: the sidecar byte and grammar screens detect corrupted input under a trusted parent
  environment. A hostile parent environment — including exported shell functions or PATH
  substitution of core/backend commands — is outside the threat model and can substitute the
  backend itself. Targeted shadow-proof resolution protects banner/dispatch honesty from accidental
  shadowing; it is not an environment security boundary
  the exec posture banner appends a banner-only timeout=<duration|uncapped> field — exactly the
  duration handed to timeout(1), uncapped when no timeout/gtimeout binary caps the run;
  INFORMATIONAL only: it is never persisted in a receipt or session sidecar
  quote the posture banner verbatim when labeling this dispatch — the banner is the machine-stated
  posture; a prose re-type drifts
  every-run nested-sandbox scan (DUAL policy, deliberately two different rules): the scan runs on
  EVERY completed run, not only a failed one, because a run that SURVIVES the nested-sandbox failure
  exits 0 with an ungrounded answer and nothing said so. Failed run (rc != 0): the existing loose
  whole-trace combination rule prints the recovery hint. Successful run (rc == 0): a warning fires
  ONLY on precise per-item evidence — both a sandbox-mechanism token AND a permission/read-only
  failure token inside the aggregated_output of ONE command_execution item whose failure is PROVEN
  (a nonzero exit_code, or the serialized status "failed"); a null exit_code is never failure by
  itself, tokens split across two items never fire, and a successful command's output never fires.
  The answer is printed FIRST on stdout, then the warning on stderr. HONEST RESIDUAL: the exit
  status does NOT change on that lane (a distinct nonzero exit would give a heuristic scan DENY
  polarity, refusing real work whenever the scan over-warns), so an orchestrator keying on exit
  status alone can still bank an ungrounded answer — the stderr warning is the signal

Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):
  ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf
  CODEX_SERVICE_TIER — service tier: 'priority' (Fast — ~1.5x speed at a 2.5x credit rate on gpt-5.6-sol); a consented SPEND knob, default off (standard tier)
  CODEX_HARD_TIMEOUT — hard wall-clock cap, integer seconds 1..86400 (built-in default 3600)

Environment: CODEX_HARD_TIMEOUT (seconds, default 3600), CODEX_PROBE=1 (throwaway probe only), AW_DISPATCH_NONCE (delegation dispatch nonce — mints the exec receipt; the --nonce <n> flag is its plain-argument equivalent), AW_DELEGATION_STORE (absolute delegation-store path; its dirname is where the receipt lands).
Requires at run time: the codex CLI on PATH, a ChatGPT-subscription login, a git work tree with a root AGENTS.md (--help needs none of these).
HELP
    exit 0
    ;;
esac

# This wrapper's applied settings-file subset (see the shared reader block below).
AW_SETTINGS_APPLIED="CODEX_SERVICE_TIER CODEX_HARD_TIMEOUT"

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

DEFAULT_CODEX_MODEL="gpt-5.6-sol"   # frontier coding model (verified locally) — pinned
DEFAULT_CODEX_EFFORT="xhigh"    # maximum reasoning effort — pinned
CODEX_MODEL="${CODEX_MODEL:-$DEFAULT_CODEX_MODEL}"
CODEX_EFFORT="${CODEX_EFFORT:-$DEFAULT_CODEX_EFFORT}"
# Generous hard wall-clock cap, sized for a slow xhigh run (subscription latency
# varies — a trivial reply was observed taking minutes). Raise for a known-healthy
# long run; lowering it only risks killing real work.
CODEX_HARD_TIMEOUT="${CODEX_HARD_TIMEOUT:-3600}"
# Codex service tier (quality-neutral speed knob; live-probed 2026-07-05): default EMPTY ⇒ no
# service_tier flag (standard tier) — enabling Fast is a consented per-host SPEND act, never a
# silent default. The only server-catalog tier id on this subscription is 'priority' (catalog
# display name "Fast": ~1.5x token speed at a 2.5x credit rate on gpt-5.6-sol; quality-neutral —
# same model). codex itself accepts ANY -c service_tier string silently (probe-verified), so
# the wrapper validates the effective value: an unsupported one warns and runs on the standard
# tier — a typo can never silently masquerade as Fast.
CODEX_SERVICE_TIER="${CODEX_SERVICE_TIER:-}"
# D5 pre-spend control-byte screen — BEFORE tier validation (the codex-review.sh order: a
# malformed value is not a policy question). Screens EVERY exec-banner field.
for _posture_pair in "CODEX_MODEL=$CODEX_MODEL" "CODEX_EFFORT=$CODEX_EFFORT" "CODEX_SERVICE_TIER=$CODEX_SERVICE_TIER" "CODEX_HARD_TIMEOUT=$CODEX_HARD_TIMEOUT"; do
  if [[ "${_posture_pair#*=}" == *[$'\x01'-$'\x1f'$'\x7f']* ]]; then
    echo "error: ${_posture_pair%%=*} contains control bytes — fix the setting (env or bridge-settings.conf) and re-run." >&2
    exit 2
  fi
done
# The delegation dispatch nonce seam (delegation Plan 2 / D11): ONE seam, the AW_DISPATCH_NONCE
# environment value and its plain-argument twin --nonce <n> (parsed below, after the mode selector).
# Validated pre-spend under the SAFE grammar — a nonce that would escape the derived artifact name
# refuses before any CLI run. The bracket expression ENUMERATES the ASCII set (no ranges): a range
# like A-Z is locale-collation-dependent and could admit a non-ASCII nonce the kit's JS reader then
# refuses. Byte-identical rule to codex-review.sh's AW_REVIEW_NONCE screen — one grammar, two lanes.
AW_NONCE_RE='^[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-]{1,64}$'
if [[ -n "${AW_DISPATCH_NONCE:-}" && ! "${AW_DISPATCH_NONCE}" =~ $AW_NONCE_RE ]]; then
  echo "error: AW_DISPATCH_NONCE fails the safe nonce grammar ([A-Za-z0-9._-]{1,64}) — the derived receipt name would be unsafe; fix the nonce and re-run." >&2
  exit 2
fi
CODEX_HARD_TIMEOUT="$(aw_effective_timeout CODEX_HARD_TIMEOUT 3600)"
if [[ -n "$CODEX_SERVICE_TIER" ]] && ! aw_settings_valid CODEX_SERVICE_TIER "$CODEX_SERVICE_TIER"; then
  echo "warning: CODEX_SERVICE_TIER='$CODEX_SERVICE_TIER' is not a supported service tier ('priority') — running on the standard tier." >&2
  CODEX_SERVICE_TIER=""
fi
tier_flags=()
if [[ -n "$CODEX_SERVICE_TIER" ]]; then
  tier_flags=(-c "service_tier=$CODEX_SERVICE_TIER")
fi
CHATGPT_LOGIN_GUARD="Logged in using ChatGPT"

# --- Exec-receipt identity (delegation Plan 2) --------------------------------
# AW_RECEIPT_BACKEND is the ledger's backend id (the value `dispatch open --backend` records), not
# the wrapper name — the artifact name is a function of {backend, nonce} alone on both sides.
# AW_BRIDGE_VERSION mirrors this bridge's SKILL.md/capability.json version and is stamped into every
# receipt this wrapper mints; scripts/release/version-sync.mjs bumps it under the one-anchor-per-file
# rule, so a release can never leave it behind (the AD-053 drift class).
AW_RECEIPT_BACKEND="codex"
AW_BRIDGE_VERSION="3.4.1"  # aw-version-anchor
# The kill grace handed to timeout(1) as --kill-after, and recorded in the receipt as killGraceS:
# ONE constant, so the number the ledger checks against the dispatch deadline is the number the run
# actually applied.
CODEX_KILL_GRACE_S=15

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
# Resolve the real git to an ABSOLUTE executable, ignoring shell functions/aliases
# (`type -P` forces a PATH lookup). The shim embeds this path so codex cannot recurse
# into the shim or delegate to the wrong binary.
real_git="$(builtin type -P git 2>/dev/null || true)"
if [[ -z "$real_git" ]]; then
  echo "error: 'git' not found on PATH (needed for the work tree and the git-write boundary shim)." >&2
  exit 127
fi
# Normalize a relative-PATH hit to an ABSOLUTE path with the same shadow-proof discipline as
# aw_resolve_timeout_bin: parameter-expansion split (no external dirname/basename an exported
# function could shadow), builtin cd/pwd -P, fail-closed to empty (the -x check below STOPs).
case "$real_git" in
  /*) ;;
  *)
    case "$real_git" in
      */*) _git_dir="${real_git%/*}"; _git_base="${real_git##*/}" ;;
      *) _git_dir="."; _git_base="$real_git" ;;
    esac
    if _git_dir="$(builtin cd -- "$_git_dir" 2>/dev/null && builtin pwd -P)"; then
      real_git="$_git_dir/$_git_base"
    else
      real_git=""
    fi
    ;;
esac
if [[ ! -x "$real_git" ]]; then
  echo "error: resolved git path '$real_git' is not an executable." >&2
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

read -r -d '' RESUME_REMINDER <<'REMINDER' || true
CONTINUE the existing task in the same working tree under the SAME contract: never
run a git write command (the orchestrator commits), obey the project's root AGENTS.md
Hard Constraints, run the project's declared gates, do NOT commit, and STOP + report
any blocker — never guess.

NEW INSTRUCTION:
REMINDER

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <plan-file|-> [-- extra codex args...]" >&2
  echo "       $0 --resume-last <plan-file|->" >&2
  echo "       $0 --resume <session-id> <plan-file|->" >&2
  exit 2
fi

# --- Resume detection (must be the FIRST argument) ---------------------------
# A dedicated entrypoint for iterating on a session without re-sending context.
# `codex exec resume` RESETS posture and rejects the -s/--add-dir/-C posture flags,
# so we restate the FULL policy via -c. It DOES accept -o/--json/--color, and it now
# carries the same capture posture as a fresh run (one evidence surface, both modes).
resume_mode=""
resume_id=""
case "${1:-}" in
  --resume-last)
    resume_mode="last"; shift
    ;;
  --resume)
    resume_mode="id"; shift
    resume_id="${1:-}"; shift || true
    if [[ -z "$resume_id" || "$resume_id" == "-"* ]]; then
      echo "error: --resume needs a <session-id> argument before the prompt." >&2
      exit 2
    fi
    ;;
esac

# --- --nonce <n> — the plain-argument lane onto the AW_DISPATCH_NONCE seam (D11) ---------------
# Recognised at exactly ONE position: AFTER the mode selector and BEFORE the prompt operand, so the
# three accepted forms are `codex-exec [--nonce <n>] <plan-file|->`,
# `codex-exec --resume-last [--nonce <n>] <plan-file|->` and
# `codex-exec --resume <session-id> [--nonce <n>] <plan-file|->`. A GLOBAL strip (the codex-review.sh
# shape) is wrong here: this wrapper's remaining args are the prompt operand and the `--` passthrough
# payload, and consuming a `--nonce` out of them would move that boundary — after the operand or a
# literal `--`, `--nonce` is payload, never a flag.
# Semantics are codex-review.sh's, exactly: the flag and a non-empty env value must AGREE (two
# disagreeing sources would mint an ambiguous dispatch identity — fail closed), a duplicate refuses
# (one dispatch carries one nonce), and the NEXT argument is taken unconditionally (only end-of-args
# refuses here) — the closed grammar is the single validity door, so a grammar-valid leading-dash
# value is legal, and an EMPTY value still hits the grammar screen.
nonce_flag=""
nonce_flag_set=0
while [[ "${1:-}" == "--nonce" ]]; do
  if [[ "$nonce_flag_set" == "1" ]]; then
    echo "error: duplicate --nonce — one dispatch carries one nonce." >&2
    exit 2
  fi
  if [[ $# -lt 2 ]]; then
    echo "error: --nonce needs a value; got '<end of args>'." >&2
    exit 2
  fi
  nonce_flag="$2"; nonce_flag_set=1; shift 2
done
if [[ "$nonce_flag_set" == "1" ]]; then
  if [[ ! "$nonce_flag" =~ $AW_NONCE_RE ]]; then
    echo "error: --nonce fails the safe nonce grammar ([A-Za-z0-9._-]{1,64}) — the derived receipt name would be unsafe; fix the nonce and re-run." >&2
    exit 2
  fi
  if [[ -n "${AW_DISPATCH_NONCE:-}" && "${AW_DISPATCH_NONCE}" != "$nonce_flag" ]]; then
    echo "error: --nonce disagrees with the AW_DISPATCH_NONCE environment value — one dispatch carries one nonce; drop one source and re-run." >&2
    exit 2
  fi
  AW_DISPATCH_NONCE="$nonce_flag"
fi
aw_nonce="${AW_DISPATCH_NONCE:-}"

if [[ $# -lt 1 ]]; then
  echo "error: missing <plan-file|-> (the instruction to send)." >&2
  exit 2
fi
prompt_src="$1"; shift

passthrough=()
if [[ -n "$resume_mode" ]]; then
  # Resume takes no passthrough — the wrapper restates the entire fixed policy.
  if [[ $# -gt 0 ]]; then
    echo "error: resume modes take no extra flags ('$1' …) — the wrapper restates the full policy." >&2
    exit 2
  fi
  if [[ "$resume_mode" == "last" ]]; then
    sidecar="${CODEX_SESSION_FILE:-$PWD/.codex-last-session}"
    if [[ ! -f "$sidecar" ]]; then
      echo "error: --resume-last found no session sidecar at '$sidecar'." >&2
      echo "       Run a normal 'codex-exec' once (it records the session id there) before resuming." >&2
      exit 2
    fi
    # RAW-byte NUL screen BEFORE the shell variable: bash command substitution silently DROPS
    # NUL bytes, so a hostile `sess-\0target` would otherwise be repaired into a valid id.
    nul_count="$(head -n1 -- "$sidecar" | LC_ALL=C tr -cd '\000' | wc -c)"
    if (( nul_count != 0 )); then
      echo "error: the session sidecar '$sidecar' carries NUL bytes — refusing before any spend; delete it or pass --resume <session-id>." >&2
      exit 2
    fi
    # Read the first line WITHOUT content mutation — only a CRLF terminator is stripped. A
    # whitespace-ONLY line is an empty sidecar; inner whitespace beside real content hits the
    # session-id grammar below and REFUSES — it is never silently stripped into a different
    # (accidentally valid) id.
    resume_id="$(head -n1 -- "$sidecar")"
    resume_id="${resume_id%$'\r'}"
    if [[ -z "${resume_id//[[:space:]]/}" ]]; then
      echo "error: the session sidecar '$sidecar' is empty — no session id to resume." >&2
      exit 2
    fi
  fi
  # Resume-id grammar (AD-061, derived from live codex ids — UUID-like and sess-* forms alike):
  # a safe charset + length bound, FIRST char alphanumeric (a leading dash would reach
  # `codex exec resume` as an OPTION, bypassing the guarded passthrough). A hostile/malformed
  # id — explicit OR sidecar-read — refuses BEFORE any spend and before the id can reach the
  # codex argv; the raw value is never echoed (it could carry control bytes).
  aw_session_id_re='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  if [[ ! "$resume_id" =~ $aw_session_id_re ]]; then
    echo "error: the resolved session id is not a valid codex session id (letters, digits, dot," >&2
    echo "       underscore, hyphen; must START with a letter or digit; 1-128 chars) — refusing" >&2
    echo "       before any spend. If it came from the sidecar, the file may be corrupted —" >&2
    echo "       delete it or pass --resume <session-id>." >&2
    exit 2
  fi
else
  # Normal mode: split off passthrough codex flags after a literal `--`. Extra args
  # WITHOUT the `--` separator are a mistake — fail loudly rather than drop them.
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
  echo "error: empty ${resume_mode:+resumed }plan/instruction" >&2
  exit 2
fi

# --- The ACCOUNTED lane: everything below fires only for a NONCED run ---------
# A nonce-LESS invocation is byte-unchanged — no reservation, no receipt, no artifact, no node —
# which is what keeps every existing caller working. The whole mint core rides ONE node script per
# step (the family floor, codex-review.sh's finding-manifest precedent): a bash re-implementation of
# atomic no-clobber publication, JSON composition and canonical digesting would be a second, drifting
# implementation of contracts the kit owns.
aw_owner=""
aw_contract_digest=""
aw_artifact_dir=""

# Each mint core rides a BUILTIN heredoc read — `IFS= read -r -d '' … <<'AW_JS'`, the idiom this
# wrapper already uses for its two prompt directives — rather than a `$(cat <<'AW_JS' …)` command
# substitution. That is not style: a failed `cat` (gone from PATH, shadowed, or replaced) makes the
# substitution EMPTY, `node -e ""` exits 0, and the wrapper would report a successful accounted run
# having published no report and no terminal receipt at all — silent, on the success path. The
# builtin cannot fail that way because there is no external binary left to fail. The assertion below
# is the belt: an empty core never runs, it refuses by name.
aw_require_core() {
  [[ -n "$1" ]] && return 0
  echo "error: $2 is EMPTY — refusing to run an empty program rather than reporting a run that published nothing." >&2
  return 1
}

# The delegation store's directory, resolved EXACTLY as the kit resolves it
# (agent-workflow-kit/tools/dispatch-store.mjs): an ABSOLUTE AW_DELEGATION_STORE wins (its dirname),
# a relative one or one ending in a path separator refuses, otherwise the git common dir. Mirrored
# through node's own path primitives rather than re-derived in bash, so the two answers cannot drift
# on `..` segments, duplicate separators or a trailing dot — the cross-package parity test pins it.
aw_resolve_artifact_dir() {
  local common=""
  if [[ -z "${AW_DELEGATION_STORE:-}" ]]; then
    if [[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]]; then
      echo "error: a nonced dispatch resolves its receipt beside the delegation store, and there is no store outside a git work tree (set AW_DELEGATION_STORE to an absolute path, or run from the repository)." >&2
      return 1
    fi
    common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [[ -z "$common" ]]; then
      echo "error: could not resolve the git common dir — the receipt has nowhere to land; refusing before any spend." >&2
      return 1
    fi
  fi
  local aw_js=""
  IFS= read -r -d '' aw_js <<'AW_JS' || true
const { isAbsolute, normalize, sep, join, dirname } = require("node:path");
const common = process.argv[1] || "";
const override = process.env.AW_DELEGATION_STORE || "";
let storePath;
if (override) {
  if (!isAbsolute(override)) {
    process.stderr.write("error: AW_DELEGATION_STORE must be an ABSOLUTE path (got \"" + override + "\") — a relative override resolves a different ledger from each worktree/cwd; refusing before any spend.\n");
    process.exit(2);
  }
  const normalized = normalize(override);
  if (normalized.endsWith(sep) || normalized.endsWith("/")) {
    process.stderr.write("error: AW_DELEGATION_STORE must not end with a path separator (got \"" + override + "\") — a store is a file, not a directory; refusing before any spend.\n");
    process.exit(2);
  }
  storePath = normalized;
} else {
  storePath = join(common, "agent-workflow-delegation.jsonl");
}
process.stdout.write(dirname(storePath));
AW_JS
  aw_require_core "$aw_js" "the store-directory resolver" || return 1
  NODE_OPTIONS= node -e "$aw_js" "$common"
}

# The contract header this run is accountable for: its `nonce` and its `contractDigest`, both read
# from the bytes ALREADY loaded as the prompt (fed on stdin) rather than from a second open of the
# path. That single read is load-bearing: two reads leave a window in which the file can be swapped,
# and the run would then execute contract A while its receipt claimed the digest of B — a return the
# ledger would accept. Dropping the trailing newlines (`$( )` does) cannot move the digest: the digest
# is taken over the PARSED object and the fence walk is line-based, so anything after the closing
# fence is outside the block either way.
#
# contractDigest is sha256 over the CANONICAL serialization (recursively key-sorted JSON, no trailing
# newline) of the ONE top-level ```aw-dispatch-contract block. Independently produced HERE: without
# it the ledger would compare a dispatch record against values derived from itself, and a run that
# executed a DIFFERENT contract would correlate cleanly. The fence walk mirrors the kit's
# extractContractBlock — nesting-aware, so a contract marker inside another fenced block is example
# text; both line endings accepted. FORM validation is deliberately NOT duplicated here: the kit's
# `open` is the single form door, and a second one would drift. The ONE field validated is `nonce`,
# because this wrapper COMPARES it — a value outside the safe grammar could not be compared or named.
aw_compute_contract_header() {
  local aw_js=""
  IFS= read -r -d '' aw_js <<'AW_JS' || true
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const INFO = "aw-dispatch-contract";
const FENCE = /^(`{3,})(.*)$/;
const SAFE = /^[A-Za-z0-9._-]{1,64}$/;
const die = (m) => { process.stderr.write("error: dispatch contract — " + m + ".\n"); process.exit(2); };
let text;
try { text = fs.readFileSync(0, "utf8"); } catch (err) { die("cannot read the dispatch contract bytes (" + (err && err.code) + ")"); }
const lines = text.split(/\r?\n/);
const blocks = [];
let openTicks = 0, openInfo = "", openAt = -1;
for (let i = 0; i < lines.length; i += 1) {
  const fence = FENCE.exec(lines[i]);
  if (fence === null) continue;
  const ticks = fence[1].length;
  const info = fence[2].trim();
  if (openTicks === 0) { openTicks = ticks; openInfo = info; openAt = i; continue; }
  if (info === "" && ticks >= openTicks) {
    if (openInfo === INFO) blocks.push(lines.slice(openAt + 1, i).join("\n"));
    openTicks = 0; openInfo = ""; openAt = -1;
  }
}
if (openTicks !== 0 && openInfo === INFO) die("the ```" + INFO + " block is never closed");
if (blocks.length === 0) die("no top-level ```" + INFO + " block found — an accounted dispatch runs a contract");
if (blocks.length > 1) die(blocks.length + " ```" + INFO + " blocks found — a dispatch file carries exactly one");
let contract;
try { contract = JSON.parse(blocks[0]); } catch { die("the ```" + INFO + " block body is not valid JSON"); }
if (contract === null || typeof contract !== "object" || Array.isArray(contract)) die("the ```" + INFO + " block body must be ONE JSON object");
if (typeof contract.nonce !== "string" || !SAFE.test(contract.nonce)) die("the header carries no nonce in the safe grammar ([A-Za-z0-9._-]{1,64}) — an accounted dispatch is identified by the nonce the ledger copied from this header");
const ser = (v) => (Array.isArray(v)
  ? "[" + v.map(ser).join(",") + "]"
  : (v !== null && typeof v === "object")
    ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + ser(v[k])).join(",") + "}"
    : JSON.stringify(v));
process.stdout.write(contract.nonce + "\n" + createHash("sha256").update(ser(contract), "utf8").digest("hex"));
AW_JS
  aw_require_core "$aw_js" "the contract-header reader" || return 1
  printf '%s' "$1" | NODE_OPTIONS= node -e "$aw_js"
}

if [[ -n "$aw_nonce" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "error: a nonced dispatch mints an exec receipt, and its mint core needs 'node' on PATH — refusing before any spend." >&2
    echo "       (a nonce-less run needs no node at all)" >&2
    exit 2
  fi
  # The digest binds the FILE the kit's `dispatch open --contract` read. A prompt arriving on stdin
  # is not that file — there would be nothing to bind — so the accounted lane refuses it by name
  # rather than digesting a stream nobody can re-read.
  if [[ "$prompt_src" == "-" ]]; then
    echo "error: a nonced dispatch runs a contract FILE, not stdin — contractDigest binds the dispatch file this run was handed, and '-' leaves nothing for the ledger to bind; pass the same file 'dispatch open --contract' read." >&2
    exit 2
  fi
  # The resolved directory crosses back through a SENTINEL, not a bare command substitution: `$( )`
  # strips every trailing newline, while the kit's own reader strips exactly ONE (git's terminator,
  # flow-store-read.mjs:32-35). For a directory whose name ends in a newline the two sides would then
  # resolve different paths, and the wrapper would write beside a ledger the kit never reads. Appending
  # `x` inside the substitution makes the last byte a non-newline; only that final sentinel is
  # stripped, so a directory whose own name ends in `x` still round-trips. A refusing resolver prints
  # nothing on stdout, so the missing sentinel IS the failure signal.
  aw_dir_raw=""
  aw_dir_raw="$(aw_resolve_artifact_dir && printf x)" || true
  if [[ "$aw_dir_raw" != *x ]]; then
    echo "       (the receipt has nowhere to land — refusing before any spend)" >&2
    exit 2
  fi
  aw_artifact_dir="${aw_dir_raw%x}"
  aw_header=""
  if ! aw_header="$(aw_compute_contract_header "$task")"; then
    echo "error: the prompt '$prompt_src' carries no readable dispatch contract (see above) — an accounted dispatch is refused before any spend." >&2
    exit 2
  fi
  aw_contract_nonce="${aw_header%%$'\n'*}"
  aw_contract_digest="${aw_header#*$'\n'}"
  # The ledger's nonce IS the header's — `dispatch open` COPIES it — so a --nonce disagreeing with the
  # header can only mint an artifact no return will ever absorb, after paying for the run. Refuse it
  # here, where it is still free. Only the accounted lane compares: a nonce-LESS run of an ordinary
  # plan file that happens to carry a contract block is none of this seam's business.
  if [[ "$aw_contract_nonce" != "$aw_nonce" ]]; then
    echo "error: the dispatch nonce '$aw_nonce' does not match the contract header's nonce '$aw_contract_nonce' — 'dispatch open' copies the nonce FROM the header, so this run would reserve an identity no return could absorb; nothing was reserved and nothing was spent." >&2
    exit 2
  fi
fi

# --- Enforced git-write boundary (physical shim file) ------------------------
# codex spawns `git` via execve, which BYPASSES exported shell functions — so the
# boundary MUST be a physical executable on PATH. We write a `git` shim into a temp
# dir and prepend it to PATH for the codex subprocess ONLY. It passes read-only
# verbs through to the real git and blocks every write (add/commit/reset/…). The
# real git path is BAKED INTO the shim (not an env var) so codex can't read it to
# bypass the shim. This is best-effort defence-in-depth beside the prompt contract
# (codex could still call git by an absolute path — the contract + review are the
# real guard); it removes the trivial PATH-level write vector.
shim_dir=""
out_dir=""
out=""
trace=""
trap 'rm -rf "$shim_dir" "$out_dir" 2>/dev/null; rm -f "$trace" 2>/dev/null; true' EXIT
shim_dir="$(mktemp -d)"
# `-o` gets a path that does NOT exist yet, inside a private directory. A pre-created file (the old
# `mktemp`) made "the delegate produced no final message" indistinguishable from "the delegate
# produced an EMPTY one" — both read back as zero bytes — so an accounted run could publish a
# `success` receipt describing a report the run never wrote, while its own stderr said there was no
# final message. The real CLI CREATES this path when it has something to write (probed against
# codex-cli directly: exit 0, the file appeared with the answer in it) — the fake accepts any argv, so
# only the real one could answer that.
out_dir="$(mktemp -d)"
out="$out_dir/final-message.txt"
trace="$(mktemp)"
{
  printf '#!/usr/bin/env bash\n'
  printf 'set -u\n'
  printf 'real=%q\n' "$real_git"
  cat <<'SHIM'
# git-write boundary shim — read-only verbs pass through to the embedded real git;
# every write/unknown verb is blocked by default.
args=("$@")
i=0; n=${#args[@]}
# Walk past git's leading global options (value-taking ones consume the next token).
while [[ $i -lt $n ]]; do
  case "${args[$i]}" in
    -C|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env|-c) i=$((i+2)); continue ;;
    -*) i=$((i+1)); continue ;;
    *) break ;;
  esac
done
verb="${args[$i]:-}"
rest=("${args[@]:$((i+1))}")
case "$verb" in
  ""|version|status|diff|show|log|ls-files|ls-tree|rev-parse|rev-list|merge-base|cat-file|\
  describe|for-each-ref|name-rev|blame|grep|shortlog|annotate|whatchanged|count-objects|var|\
  check-ignore|check-attr|show-ref|show-branch|verify-commit|verify-tag|cherry)
    exec "$real" "$@" ;;
  config)
    # Reads only: block on any write/action flag, or a `<name> <value>` set form
    # (>= 2 non-option args). Permits --get*/--list and a bare `git config <name>`.
    positionals=0
    for a in ${rest[@]+"${rest[@]}"}; do
      case "$a" in
        --add|--unset|--unset-all|--replace-all|--remove-section|--rename-section|--edit|-e|--unset-pattern|--fixed-value|--set)
          echo "git-write-shim: 'git config' write is blocked (read-only boundary)." >&2; exit 13 ;;
        -*) : ;;
        *) positionals=$((positionals+1)) ;;
      esac
    done
    if [[ $positionals -ge 2 ]]; then
      echo "git-write-shim: 'git config <name> <value>' write is blocked." >&2; exit 13
    fi
    exec "$real" "$@" ;;
  *)
    echo "git-write-shim: 'git ${verb}' is blocked — codex must not write git state; the orchestrator commits after review." >&2
    exit 13 ;;
esac
SHIM
} >"$shim_dir/git"
chmod 755 "$shim_dir/git"

# --- Build the codex invocation + the prompt ---------------------------------
if [[ -n "$resume_mode" ]]; then
  # Resume RESETS posture and rejects the -s/--add-dir/-C posture flags, so restate the entire
  # policy via -c. Its accepted flag set is NARROWER than `codex exec`'s and is probed, never
  # assumed: `codex exec resume --help` (codex-cli 0.147.0) accepts -o and --json but NOT --color,
  # so the capture posture is shared with a fresh run MINUS that flag. Shipping --color here once
  # broke every resume invocation with a pre-spend exit 2 — the fake CLI in the suite accepts any
  # argv, so only the real one can answer this question. See RESUME_ACCEPTED_FLAGS in the test.
  codex_cmd=(codex exec resume "$resume_id"
    --ignore-user-config
    -m "$CODEX_MODEL"
    -c model_reasoning_effort="$CODEX_EFFORT"
    -c sandbox_mode=workspace-write
    -c approval_policy=never
    -c sandbox_workspace_write.network_access=false
    -c hide_agent_reasoning=true
    -c model_reasoning_summary=none
    "${tier_flags[@]+"${tier_flags[@]}"}"
    -o "$out"
    --json
    -)
  full_prompt="$RESUME_REMINDER"$'\n\n'"$task"
else
  # `-o` writes ONLY codex's final message; `--json` streams structured events
  # (thread.started carries the session id). CoT is dropped and colour disabled, so
  # the captured surfaces stay clean. Reasoning still runs at xhigh — quality is
  # unchanged; we only stop printing the noise.
  codex_cmd=(codex exec
    --ignore-user-config
    --sandbox workspace-write
    -c approval_policy="never"
    -c sandbox_workspace_write.network_access=false
    -c model_reasoning_effort="$CODEX_EFFORT"
    -c hide_agent_reasoning=true
    -c model_reasoning_summary=none
    "${tier_flags[@]+"${tier_flags[@]}"}"
    --color never
    -o "$out"
    --json
    -m "$CODEX_MODEL"
    "${passthrough[@]+"${passthrough[@]}"}"
    -)
  full_prompt="$ORCHESTRATOR_DIRECTIVE"$'\n\n'"$task"
fi

# Env for the codex subprocess: the git-write shim FIRST on PATH. The real git path
# is baked into the shim itself — never exposed to codex as an env var.
run_env=(env "PATH=$shim_dir:$PATH")

# --- Hard wall-clock cap via timeout(1) (gtimeout on macOS) -------------------
# A backgrounded, hung codex run survives otherwise. --kill-after SIGKILLs 15s
# after the initial TERM if codex ignores it (a live probe confirmed plain
# `timeout` reaps the whole codex child tree — no --foreground needed). If neither
# binary exists we warn loudly and run uncapped rather than fail silently.
# aw_resolve_timeout_bin: builtin type -P (an exported function can shadow neither `timeout` nor
# `type` itself), normalized to an ABSOLUTE path fail-closed — the dispatch invokes the same
# absolute path the banner rendered from (banner and run never make independent conclusions).
timeout_bin="$(aw_resolve_timeout_bin)"
if [[ -z "$timeout_bin" ]]; then
  # D8 — an ACCOUNTED dispatch that cannot be capped can never honour the terminal-exit rule: the
  # ledger records capS + killGraceS and refuses a dispatch whose deadline is below their sum, so a
  # run with no cap at all would put an unbounded run under a bounded deadline, and the waiter would
  # report an expiry while the run was still legitimately alive. A nonce-LESS run keeps the existing
  # behaviour exactly — warn loudly and run uncapped.
  if [[ -n "$aw_nonce" ]]; then
    echo "error: no 'timeout'/'gtimeout' on PATH — a nonced dispatch refuses to run uncapped (an accounted run that cannot be capped can never honour the terminal-exit rule)." >&2
    echo "       Install coreutils, or dispatch without a nonce; nothing was reserved and nothing was spent." >&2
    exit 2
  fi
  echo "warning: no 'timeout'/'gtimeout' on PATH — running codex WITHOUT a hard wall-clock cap" >&2
  echo "         (install coreutils to enable CODEX_HARD_TIMEOUT=$CODEX_HARD_TIMEOUT)." >&2
fi

# --- D5 exec banner (one line, the ACTUAL run posture; AD-061) -----------------
# Emitted from RESOLVED post-validation values, AFTER the resume id is resolved and validated,
# BEFORE the dispatch. The timeout field is banner-only (never a receipt/sidecar field): it
# prints exactly the duration handed to timeout(1), or `uncapped` without a capping binary.
aw_timeout_banner="$(aw_timeout_label "$timeout_bin" "$CODEX_HARD_TIMEOUT")"
aw_session_label="fresh"
[[ -n "$resume_mode" ]] && aw_session_label="resume:$resume_id"
echo "exec posture: model=$CODEX_MODEL effort=$CODEX_EFFORT tier=${CODEX_SERVICE_TIER:-standard} sandbox=workspace-write session=$aw_session_label timeout=$aw_timeout_banner" >&2

# --- The PRE-SPEND reservation (delegation Plan 2 / D1) ------------------------
# Written immediately before the CLI runs — after EVERY preflight and after the posture banner, so a
# refused run leaves no reservation behind — and it is the reservation itself, not a separate lock,
# that makes one nonce mean one dispatch: the publish is atomic and NO-CLOBBER, so a second dispatch
# on the same nonce refuses BEFORE any spend. Both derived names are checked, because the kit's
# `dispatch open` refuses on either too: a leftover report would otherwise be absorbed later as this
# run's own evidence.
#
# The mint core is codex-review.sh's finding-manifest shape: an UNPREDICTABLE sibling temp opened
# "wx" (O_CREAT|O_EXCL — a planted node at the name refuses, and ONLY a temp we provably created is
# ever unlinked), then a hard-link publish (atomic, no-clobber). The owner token is minted here and
# returned on stdout: it is what the terminal publication verifies it still holds.
aw_write_reservation() {
  local aw_js=""
  IFS= read -r -d '' aw_js <<'AW_JS' || true
const fs = require("node:fs");
const { join, dirname, basename } = require("node:path");
const { randomBytes } = require("node:crypto");
const [dir, backend, nonce, contractDigest, wrapperVersion, model, effort, tier, capS, killGraceS] = process.argv.slice(1);
const name = (prefix, suffix) => join(dir, prefix + backend.length + "-" + backend + "-" + nonce + suffix);
const receipt = name("agent-workflow-exec-receipt-", ".json");
const report = name("agent-workflow-exec-report-", ".txt");
for (const path of [receipt, report]) {
  try {
    fs.lstatSync(path);
    process.stderr.write("error: an exec artifact for this {backend, nonce} already exists at " + path + " — one nonce, one dispatch: refusing PRE-SPEND (remove it, or dispatch under a fresh nonce).\n");
    process.exit(3);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      process.stderr.write("error: could not probe " + path + " (" + (err && err.code) + ") — refusing PRE-SPEND.\n");
      process.exit(3);
    }
  }
}
const owner = randomBytes(16).toString("hex");
const bytes = Buffer.from(JSON.stringify({
  schema: 1,
  kind: "exec-receipt",
  state: "reserved",
  backend,
  nonce,
  owner,
  contractDigest,
  wrapperVersion,
  posture: { model, effort, tier: tier || null },
  capS: Number(capS),
  killGraceS: Number(killGraceS),
  sessionId: null,
  exitStatus: null,
  outcome: null,
  reportDigest: null,
  reportLength: null,
  timestamp: new Date().toISOString(),
}) + "\n");
let tmp = null;
let code = 1;
try {
  const candidate = join(dirname(receipt), "." + basename(receipt) + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp");
  const fd = fs.openSync(candidate, "wx", 0o600);
  tmp = candidate;
  try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
  fs.linkSync(tmp, receipt);
  code = 0;
} catch (err) {
  process.stderr.write("error: could not publish the nonce reservation at " + receipt + " (" + (err && err.code) + ") — refusing PRE-SPEND.\n");
  code = err && err.code === "EEXIST" ? 3 : 1;
}
// An orphan temp never blocks the run — but it is never silent either: it sits in the store
// directory looking like family state, and only the run that made it knows it is debris.
if (tmp !== null) {
  try { fs.unlinkSync(tmp); } catch {
    process.stderr.write("warning: the reservation was published, but its temporary sibling could not be removed — orphan left at: " + tmp + " — remove it by hand.\n");
  }
}
if (code === 0) process.stdout.write(owner);
process.exit(code);
AW_JS
  aw_require_core "$aw_js" "the reservation mint core" || return 1
  NODE_OPTIONS= node -e "$aw_js" "$aw_artifact_dir" "$AW_RECEIPT_BACKEND" "$aw_nonce" "$aw_contract_digest" "$AW_BRIDGE_VERSION" \
    "$CODEX_MODEL" "$CODEX_EFFORT" "${CODEX_SERVICE_TIER:-}" "$CODEX_HARD_TIMEOUT" "$CODEX_KILL_GRACE_S"
}

if [[ -n "$aw_nonce" ]]; then
  if ! aw_owner="$(aw_write_reservation)"; then
    echo "       (the reservation is the pre-spend half of the dispatch identity — nothing was spent)" >&2
    exit 2
  fi
  if [[ -z "$aw_owner" ]]; then
    echo "error: the nonce reservation published no owner token — refusing PRE-SPEND rather than running a dispatch nothing can claim." >&2
    exit 2
  fi
fi

# --- Nested-sandbox evidence scan: ONE entry point, TWO policies ---------------
# The class: codex ships its OWN OS sandbox (bwrap); run nested inside a harness sandbox the FS is
# read-only and codex's sandbox setup fails. The scan runs on EVERY completed run, not only a failed
# one — when the backend SURVIVES the failure (degrades to "I cannot check" and exits 0) a paid run
# is spent on an ungrounded answer, and nothing said so.
#
# The two arms have DIFFERENT rules, deliberately:
#   FAILED run (rc != 0) — the loose whole-trace COMBINATION rule, unchanged: a sandbox MECHANISM
#   token AND a permission/read-only FAILURE token anywhere in the trace. The run already failed and
#   the operator is already reading the tail, so an extra hint costs nothing. grep is line-oriented,
#   so a plain alternation stays within a line — hence two `-q` passes rather than one pattern.
#   SUCCESSFUL run (rc == 0) — per-item evidence ONLY: both tokens inside the aggregated_output of
#   ONE command_execution item whose FAILURE is proven. Here a false positive would libel a good
#   answer, so nothing loose is allowed near it.
# The successful-run scan is LINE-ORIENTED and TOLERANT: after the unified 2>&1 the trace
# legitimately mixes plain log lines with JSONL, so every line is judged alone, a line that is not a
# well-formed command_execution item is simply not evidence (never a parse error, never a stop), and
# no line can mask a later one.
AW_NS_MECHANISM='bwrap|landlock|user namespace|pivot_root|unshare|seccomp'
AW_NS_FAILURE='read-only file system|erofs|operation not permitted|permission denied|eperm'

# BOTH token classes present in one piece of text. Fed by here-string rather than `printf | grep`:
# with `pipefail` on, a producer that takes EPIPE when `grep -q` exits early on a match would make
# the pipeline non-zero and silently DROP a real signature — an under-fire invisible by
# construction. Not reproduced on this host, folded as portability hardening: with no explicit
# pipeline there is no producer left to fail.
aw_ns_both_tokens() {
  grep -qiE "$AW_NS_MECHANISM" <<<"$1" || return 1
  grep -qiE "$AW_NS_FAILURE" <<<"$1" || return 1
  return 0
}

# Valid JSON string CONTENT — no UNESCAPED quote. This is what proves a delimiter slice stayed
# inside ONE string instead of crossing an object boundary: without it, a decoy object carrying the
# anchor lets the walk leave its own string and land in another item's fields.
# The predicate is the parity rule — a quote is escaped iff an ODD number of backslashes precedes
# it — expressed as an ERE and evaluated by grep: `(^|[^\])` then an EVEN run `(\\)*` then the
# quote. It is measured, not assumed: the obvious bash spelling (delete the `\\` and `\"` pairs,
# then look for a survivor) is the SAME predicate but bash's `${var//…}` is quadratic, and it hung
# the wrapper outright on a 200KB aggregated_output — a real tool call's output reaches that size.
aw_ns_is_string_content() {
  if grep -qE '(^|[^\\])(\\\\)*"' <<<"$1"; then return 1; fi
  return 0
}

# One trace line → 0 only when THAT line is a command_execution item with a PROVEN failure whose
# aggregated_output carries both token classes. The wrapper stays dependency-free, so this is not a
# JSON parse — it is ONE anchored walk over the CLI's observed serialization in which every SKIPPED
# gap is PROVEN to be a single JSON string's content (aw_ns_is_string_content). Both halves are
# load-bearing: testing the fields as independent substrings lets a decoy object supply the anchor
# while the failure fields belong to another item, and skipping a gap without validating it lets the
# walk leave its own string and land in that other item anyway.
# The observed shape (codex-cli 0.147.0, live-probed):
#   {"id":…,"type":"command_execution","command":"…","aggregated_output":"…","exit_code":2,"status":"failed"}
# Failure proofs: A = a nonzero exit_code, B = the status "failed" immediately after it. A null
# exit_code is never failure by itself (an in-flight item carries "exit_code":null,"status":"in_progress").
# Two stated consequences, both deliberate:
#   - a future CLI that REORDERS these fields makes the scan stop firing rather than misfire.
#     Under-firing is the right direction here: over-firing would libel a correct answer.
#   - only the FIRST matching item on a line is judged; a second item's evidence is missed.
# A hand-crafted trace line is outside the threat model (the same boundary the wrapper declares for
# a hostile parent environment): the trace's only non-CLI content is plain stderr, which does not
# start with `{`, and a tool call's own output is JSON-escaped into a string and cannot inject
# structure. Anything not matching the walk is "not evidence" — never an error, never a stop.
# Every slice is taken by a SHORT-pattern `#*` cut plus length arithmetic. That is not a style
# choice: `${var%%<long>*}` and a prefix removal whose PATTERN is a huge variable are both
# quadratic in bash, and either one hangs the wrapper outright on a 200KB aggregated_output
# (measured, not assumed — a real tool call's output reaches that size).
aw_ns_item_evidence() {
  local line="$1" d1='","aggregated_output":"' d2='","exit_code":' rest tail cmd agg code after
  case "$line" in '{'*) ;; *) return 1 ;; esac
  rest="${line#*'"type":"command_execution","command":"'}"
  if [[ "$rest" == "$line" ]]; then return 1; fi
  tail="${rest#*"$d1"}"
  if [[ "$tail" == "$rest" ]]; then return 1; fi
  cmd="${rest:0:$(( ${#rest} - ${#tail} - ${#d1} ))}"
  aw_ns_is_string_content "$cmd" || return 1
  after="${tail#*"$d2"}"
  if [[ "$after" == "$tail" ]]; then return 1; fi
  agg="${tail:0:$(( ${#tail} - ${#after} - ${#d2} ))}"
  aw_ns_is_string_content "$agg" || return 1
  code="${after%%,*}"
  if [[ "$code" =~ ^-?[0-9]+$ && "$code" != "0" ]]; then
    :
  elif [[ "${after#"$code",}" == '"status":"failed"'* ]]; then
    :
  else
    return 1
  fi
  aw_ns_both_tokens "$agg"
}

aw_scan_nested_sandbox() {   # $1 = rc, $2 = trace path
  [[ -r "$2" ]] || return 0
  if [[ "$1" -ne 0 ]]; then
    if grep -qiE "$AW_NS_MECHANISM" "$2" 2>/dev/null && grep -qiE "$AW_NS_FAILURE" "$2" 2>/dev/null; then
      echo "hint: this looks like a NESTED-SANDBOX failure — codex-exec ships its own OS sandbox (bwrap)," >&2
      echo "      which cannot run nested inside a harness sandbox (the FS is read-only). Route codex-exec" >&2
      echo "      OUTSIDE the harness sandbox: add it to the harness sandbox excludedCommands, or dispatch" >&2
      echo "      this one run via a per-run consented bypass. Do NOT blanket-disable the sandbox." >&2
    fi
    return 0
  fi
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if aw_ns_item_evidence "$line"; then
      echo "warning: NESTED-SANDBOX — this run COMPLETED, but a tool call inside it FAILED with a sandbox-setup" >&2
      echo "         signature. codex-exec ships its own OS sandbox (bwrap), which cannot run nested inside a" >&2
      echo "         harness sandbox (the FS turns read-only), so the backend most likely could not read what" >&2
      echo "         it was asked to check: the answer above may be UNGROUNDED — treat it as such rather than" >&2
      echo "         banking it. Re-dispatch OUTSIDE the harness sandbox: add codex-exec to the harness" >&2
      echo "         sandbox excludedCommands, or use a per-run consented bypass. Do NOT blanket-disable the" >&2
      echo "         sandbox. The exit status stays 0 on purpose — this is a warning, never a gate." >&2
      return 0
    fi
  done <"$2"
  return 0
}

# ONE capture posture for BOTH modes: -o writes the final message to $out, the JSON
# event stream and every log line go to $trace (stderr merged in). The final always
# lands in $out and the diagnostics always in $trace, so the post-processing below —
# including the evidence scan — is genuinely shared instead of mode-dependent.
set +e
if [[ -n "$timeout_bin" ]]; then
  printf '%s' "$full_prompt" | "${run_env[@]}" "$timeout_bin" --kill-after="${CODEX_KILL_GRACE_S}s" "$CODEX_HARD_TIMEOUT" "${codex_cmd[@]}" >"$trace" 2>&1
else
  printf '%s' "$full_prompt" | "${run_env[@]}" "${codex_cmd[@]}" >"$trace" 2>&1
fi
rc=$?
set -e

# --- The session id, captured BEFORE any outcome branching (D3) ----------------
# It used to be extracted only on the SUCCESS path, after the timeout and failure exits, so a run
# that failed or timed out recorded no identity at all — and the session id is exactly the handle an
# operator needs to find such a run in the backend's own history. In resume mode it is the resume id,
# validated pre-spend. A fresh run that emitted no thread.started leaves it empty, which is the
# receipt's `missing-identity` outcome, never a guess.
session_id=""
if [[ -n "$resume_mode" ]]; then
  session_id="$resume_id"
else
  session_id="$(grep -m1 '"type":"thread.started"' "$trace" 2>/dev/null \
    | grep -o '"thread_id":"[^"]*"' | cut -d'"' -f4 || true)"
fi

# --- The TERMINAL exec receipt, fail-closed (D1 / 3.1.d) -----------------------
# Publication ORDER, and it is the whole point: verify the reservation is still OURS (so a tampered
# reservation costs no overwritten artifact — nothing at all is published), write the REPORT
# atomically, re-verify the owner, then REPLACE the reservation with the terminal receipt. An
# artifact that has arrived therefore always has a complete report behind it.
#
# FAIL-CLOSED, deliberately unlike codex-review.sh's warn-only receipt (a missing review receipt only
# fails a checker; a missing exec receipt leaves an EDITED tree with no accounting). Two statuses:
# 70 the reservation could not be verified as this run's — NOTHING was published; 71 a publication
# could not complete, and the message names WHICH artifact stopped. In both the RESERVATION survives,
# so the recovery is the same door — `dispatch return --no-receipt` — while what the kit then reads
# differs and stays two separate lanes: a failed REPORT write leaves the reservation alone (the
# absorb records reportLength 0 and the metric is ineligible by the name `empty-report`), a failed
# TERMINAL write leaves the published report beside it (the absorb reads it, report-if-present).
aw_publish_terminal_receipt() {
  local aw_js=""
  IFS= read -r -d '' aw_js <<'AW_JS' || true
const fs = require("node:fs");
const { join, dirname, basename } = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const [dir, backend, nonce, owner, exitStatusRaw, sessionIdRaw, reportSrc] = process.argv.slice(1);
const name = (prefix, suffix) => join(dir, prefix + backend.length + "-" + backend + "-" + nonce + suffix);
const receipt = name("agent-workflow-exec-receipt-", ".json");
const report = name("agent-workflow-exec-report-", ".txt");
const exitStatus = Number(exitStatusRaw);
const sessionId = sessionIdRaw === "" ? null : sessionIdRaw;
// D3, the wrapper OUTCOME SUBSET — the only three a run can prove about itself.
const outcome = exitStatus !== 0 ? "transport-failure" : (sessionId === null ? "missing-identity" : "success");
const die = (code, message) => { process.stderr.write("error: " + message + "\n"); process.exit(code); };
// The reservation is re-read and re-verified BEFORE anything at all is published: a foreign owner,
// a missing artifact or a terminal one means this run does not hold the nonce, and the honest answer
// is to publish NOTHING — neither the report nor the receipt.
// `code` differs by WHEN the check runs: before any publication a refusal is total (4), after the
// report is on disk it is not (6) — and the message must not claim otherwise.
// The publication consequence is identical for every cause, but the DIAGNOSIS is not: "another run
// owns this" is a specific claim, and asserting it over a malformed file, a vanished one or an I/O
// error sends the operator hunting for a second dispatch that never existed. Each cause is named.
const claim = (when, code) => {
  let raw;
  try {
    raw = fs.readFileSync(receipt, "utf8");
  } catch (err) {
    const why = err && err.code === "ENOENT"
      ? "it is GONE — something removed it after this run published it"
      : "it could not be read (" + (err && err.code ? err.code : "unknown error") + ")";
    die(code, "the nonce reservation at " + receipt + " cannot be verified " + when + ": " + why);
  }
  let held;
  try {
    held = JSON.parse(raw);
  } catch {
    die(code, "the nonce reservation at " + receipt + " cannot be verified " + when + ": it is MALFORMED — the bytes there are not valid JSON, so nothing about its ownership is readable");
  }
  if (held === null || typeof held !== "object" || Array.isArray(held)) {
    die(code, "the nonce reservation at " + receipt + " cannot be verified " + when + ": its body is not a JSON object");
  }
  if (held.state !== "reserved") {
    die(code, "the artifact at " + receipt + " is not a RESERVATION " + when + ": its state is " + JSON.stringify(held.state) + " — this run holds no claim on a receipt something else has already finished");
  }
  if (held.owner !== owner) {
    die(code, "the artifact at " + receipt + " is not this run’s reservation " + when + ": its owner token belongs to ANOTHER run");
  }
  return held;
};
const held = claim("before any publication", 4);
// THREE cases, decided by lstat BEFORE any read — because `readFileSync` FOLLOWS a symlink, so a
// DANGLING one at the capture path reports ENOENT and would be recorded as a clean empty report on a
// `success` receipt. ABSENT (no entry at all) is the legitimate "the delegate wrote no final message"
// case: the sha256 of no bytes, exactly what the receipt contract expresses. A REGULAR file is read.
// Anything else PRESENT — a symlink, a directory, a device — is a FAILED probe, never an absence.
// Type only: the capture lives in a directory this run created with `mktemp -d`, so a mode or
// ownership check would be theatre against a threat model this wrapper already declares out of scope,
// while the type check catches the real accident. Same discipline as the kit's readRegularFileNoFollow.
let bytes;
if (reportSrc === "") {
  bytes = Buffer.alloc(0);
} else {
  let stat = null;
  try {
    stat = fs.lstatSync(reportSrc);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      die(5, "the delegate’s final message at " + reportSrc + " could not be probed (" + (err && err.code) + ") — a failed probe is not an absence, and recording it as an empty report would put bytes in the receipt that the run never produced");
    }
  }
  if (stat === null) {
    bytes = Buffer.alloc(0);
  } else if (!stat.isFile()) {
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "non-regular entry";
    die(5, "the delegate’s final message at " + reportSrc + " is a " + kind + ", not a regular file — a CORRUPT capture is a FAILED probe, not an absent one (a dangling symlink reads as ENOENT and would otherwise be recorded as a clean empty report)");
  } else {
    try {
      bytes = fs.readFileSync(reportSrc);
    } catch (err) {
      die(5, "the delegate’s final message at " + reportSrc + " could not be read (" + (err && err.code) + ") — an unreadable capture is a FAILED probe, not an absent one");
    }
  }
}
// Both publications are atomic: an unpredictable sibling temp, then a rename that either replaces
// the target whole or leaves it untouched. A reader never sees half a report or half a receipt.
const publishAtomically = (path, payload, code, what) => {
  let tmp = null;
  try {
    const candidate = join(dirname(path), "." + basename(path) + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp");
    const fd = fs.openSync(candidate, "wx", 0o600);
    tmp = candidate;
    try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path);
    tmp = null;
  } catch (err) {
    if (tmp !== null) { try { fs.unlinkSync(tmp); } catch { /* an orphan temp never masks the real failure */ } }
    die(code, what + " could not be published at " + path + " (" + (err && err.code) + ")");
  }
};
publishAtomically(report, bytes, 5, "the delegate’s report");
claim("immediately before the terminal replace", 6);
publishAtomically(receipt, Buffer.from(JSON.stringify({
  schema: held.schema,
  kind: held.kind,
  state: "terminal",
  backend: held.backend,
  nonce: held.nonce,
  owner: held.owner,
  contractDigest: held.contractDigest,
  wrapperVersion: held.wrapperVersion,
  posture: held.posture,
  capS: held.capS,
  killGraceS: held.killGraceS,
  sessionId,
  exitStatus,
  outcome,
  reportDigest: createHash("sha256").update(bytes).digest("hex"),
  reportLength: bytes.length,
  timestamp: new Date().toISOString(),
}) + "\n"), 6, "the terminal exec receipt");

process.stdout.write(outcome);
AW_JS
  aw_require_core "$aw_js" "the terminal publication core" || return 7
  NODE_OPTIONS= node -e "$aw_js" "$aw_artifact_dir" "$AW_RECEIPT_BACKEND" "$aw_nonce" "$aw_owner" "$1" "$session_id" "$out"
}

# The failure diagnostics print BEFORE the receipt is published, and the exits happen AFTER: a
# publication that fails must not swallow the trace tail that explains WHY the run failed. Both are
# explicitly NON-FATAL: under `set -e` a diagnostic that cannot run (no `tail` on PATH, an unreadable
# trace) would kill the wrapper BEFORE the terminal publication, stranding the reservation with no
# recovery status at all — the diagnostics are the least important thing here and must never be the
# thing that decides whether the run gets accounted.
if [[ $rc -eq 124 || $rc -eq 137 ]]; then
  echo "error: codex exec exceeded the hard cap CODEX_HARD_TIMEOUT=${CODEX_HARD_TIMEOUT}s and was terminated." >&2
  echo "       Raise CODEX_HARD_TIMEOUT for a known-healthy slow run, or narrow the task, then re-dispatch." >&2
elif [[ $rc -ne 0 ]]; then
  echo "error: codex exec failed (exit $rc). Last lines of the run trace:" >&2
  tail -n 40 "$trace" >&2 || true
  aw_scan_nested_sandbox "$rc" "$trace" || true
fi

if [[ -n "$aw_nonce" ]]; then
  aw_outcome=""
  aw_publish_rc=0
  aw_outcome="$(aw_publish_terminal_receipt "$rc")" || aw_publish_rc=$?
  if [[ $aw_publish_rc -ne 0 ]]; then
    echo "       The delegate ran and the working tree may be PARTIALLY EDITED — treat it as dirtied, not as" >&2
    echo "       untouched." >&2
    # What SURVIVES differs per lane, and the message says only what this run can still prove. After
    # the report is on disk the reservation's fate is no longer known to us (it was already not ours,
    # or the replace failed for a reason that may also have removed it) — so that lane never claims
    # "the reservation stands".
    case "$aw_publish_rc" in
      7)
        echo "       The publisher never RAN — nothing was published. The reservation is untouched; absorb with:" >&2
        echo "         dispatch return --nonce $aw_nonce --no-receipt --exit-status $rc --outcome <o>" >&2
        exit 71
        ;;
      4)
        echo "       NOTHING was published — not the report, not the receipt. The artifact at the receipt path" >&2
        echo "       is not this run's reservation, so establish what replaced it BEFORE absorbing anything:" >&2
        echo "       a --no-receipt absorb would source its posture from another run's artifact." >&2
        exit 70
        ;;
      5)
        echo "       Nothing beyond the reservation was published. Absorb the thread with:" >&2
        echo "         dispatch return --nonce $aw_nonce --no-receipt --exit-status $rc --outcome <o>" >&2
        echo "       (with no report on disk it records reportLength 0 — ineligible by the name empty-report)" >&2
        exit 71
        ;;
      *)
        echo "       The REPORT is published; the terminal receipt was NOT completed. Absorb the thread with:" >&2
        echo "         dispatch return --nonce $aw_nonce --no-receipt --exit-status $rc --outcome <o>" >&2
        echo "       (it reads the published report, report-if-present), and check the receipt path by hand." >&2
        exit 71
        ;;
    esac
  fi
  echo "exec receipt: nonce=$aw_nonce outcome=$aw_outcome exit=$rc session=${session_id:-none} → $aw_artifact_dir" >&2
fi

if [[ $rc -ne 0 ]]; then
  exit $rc
fi

# Success: record the session id in the sidecar (NORMAL mode only — a resume continues the same
# session) BEFORE the trap removes the trace, so an iterative resume (codex-exec --resume-last) can
# find it. The id itself was captured above, for every outcome; only the sidecar is success-scoped.
if [[ -z "$resume_mode" && -n "$session_id" ]]; then
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

# The answer is printed FIRST, then the evidence speaks: a run that COMPLETED can still have been
# ungrounded, and saying so after the answer keeps stdout byte-identical for every caller.
aw_scan_nested_sandbox "$rc" "$trace"
