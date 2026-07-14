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
#   CODEX_HARD_TIMEOUT=2h codex-exec <file>          # raise the hard wall-clock cap
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
  codex-exec <plan-file|->
  codex-exec <plan-file|-> -- <extra codex flags...>

Grounding:
  automatic — the root AGENTS.md (Hard Constraints) is auto-merged into codex's
  context and the wrapper prepends the orchestrator execution contract; no
  grounding flags

Round-2 / resume:
  codex-exec --resume-last <plan-file|->
  codex-exec --resume <session-id> <plan-file|->
  (resume continues the recorded session without re-sending context; takes no '--' passthrough)

Guarded passthrough after '--':
  blocked always: -c* --config* -s* --sandbox* --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --full-auto --oss --local-provider* -p* --profile* -m* --model* -o* --output-last-message* --json* --color* --output-schema* --ephemeral*
  relaxed only under CODEX_PROBE=1: --add-dir* -C* --cd* --skip-git-repo-check --ignore-rules --enable* --disable*

Notes:
  nested-sandbox limit: codex-exec ships its OWN OS sandbox (bwrap workspace-write) and cannot run
  nested inside a harness sandbox (the FS turns read-only) — route it OUTSIDE the harness sandbox
  (excludedCommands / a per-run consented bypass) on the OBSERVED bwrap/EPERM failure, never a
  preemptive blanket

Settings file (KEY=VALUE, parsed never sourced; env wins over file, file wins over built-in default):
  ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf
  CODEX_SERVICE_TIER — service tier: 'priority' (Fast — ~1.5x speed at a 2.5x credit rate on gpt-5.6-sol); a consented SPEND knob, default off (standard tier)
  CODEX_HARD_TIMEOUT — hard wall-clock cap, integer seconds 1..86400 (built-in default 3600)

Environment: CODEX_HARD_TIMEOUT (seconds, default 3600), CODEX_PROBE=1 (throwaway probe only).
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
real_git="$(type -P git 2>/dev/null || true)"
if [[ -z "$real_git" ]]; then
  echo "error: 'git' not found on PATH (needed for the work tree and the git-write boundary shim)." >&2
  exit 127
fi
case "$real_git" in
  /*) ;;
  *)  real_git="$(cd "$(dirname "$real_git")" 2>/dev/null && pwd)/$(basename "$real_git")" ;;
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
# `codex exec resume` RESETS posture and rejects the -s/--add-dir/-C posture flags
# (it DOES accept -o/--json on 0.142.3, but we capture stdout directly), so we
# restate the FULL policy via -c.
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
    resume_id="$(head -n1 -- "$sidecar" | tr -d '[:space:]')"
    if [[ -z "$resume_id" ]]; then
      echo "error: the session sidecar '$sidecar' is empty — no session id to resume." >&2
      exit 2
    fi
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
out=""
trace=""
trap 'rm -rf "$shim_dir" 2>/dev/null; rm -f "$out" "$trace" 2>/dev/null; true' EXIT
shim_dir="$(mktemp -d)"
out="$(mktemp)"
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
  # Resume RESETS posture and rejects the -s/--add-dir/-C posture flags, so restate
  # the entire policy via -c. We deliberately pass no -o/--json (resume DOES accept
  # them) — codex prints the final message to stdout, which we capture into $out.
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

# Normal mode: -o writes $out, the JSON stream + logs go to $trace. Resume mode: the
# final message is codex's stdout → $out, logs → $trace. Either way the final lands
# in $out and diagnostics in $trace, so the post-processing below is shared.
set +e
if [[ -n "$resume_mode" ]]; then
  if [[ -n "$timeout_bin" ]]; then
    printf '%s' "$full_prompt" | "${run_env[@]}" "$timeout_bin" --kill-after=15s "$CODEX_HARD_TIMEOUT" "${codex_cmd[@]}" >"$out" 2>"$trace"
  else
    printf '%s' "$full_prompt" | "${run_env[@]}" "${codex_cmd[@]}" >"$out" 2>"$trace"
  fi
  rc=$?
else
  if [[ -n "$timeout_bin" ]]; then
    printf '%s' "$full_prompt" | "${run_env[@]}" "$timeout_bin" --kill-after=15s "$CODEX_HARD_TIMEOUT" "${codex_cmd[@]}" >"$trace" 2>&1
  else
    printf '%s' "$full_prompt" | "${run_env[@]}" "${codex_cmd[@]}" >"$trace" 2>&1
  fi
  rc=$?
fi
set -e

if [[ $rc -eq 124 || $rc -eq 137 ]]; then
  echo "error: codex exec exceeded the hard cap CODEX_HARD_TIMEOUT=${CODEX_HARD_TIMEOUT}s and was terminated." >&2
  echo "       Raise CODEX_HARD_TIMEOUT for a known-healthy slow run, or narrow the task, then re-dispatch." >&2
  exit $rc
fi
if [[ $rc -ne 0 ]]; then
  echo "error: codex exec failed (exit $rc). Last lines of the run trace:" >&2
  tail -n 40 "$trace" >&2
  # Nested-sandbox detection: codex ships its OWN OS sandbox (bwrap); run nested inside a harness
  # sandbox the FS is read-only and codex's own sandbox setup fails. Fire the STATED recovery hint
  # only on a COMBINATION — a sandbox MECHANISM token AND a permission/read-only FAILURE token in the
  # trace — so a lone 'bwrap' banner, or a lone 'permission denied' from unrelated code, is NOT enough
  # (never a preemptive blanket). grep is line-oriented, so a plain alternation stays within a line —
  # the old `[^\n]*` between the two halves was wrong twice over (it excluded the letter 'n', and grep
  # never spans lines anyway), so the split into two `-q` passes both fixes it and states the intent.
  if grep -qiE 'bwrap|landlock|user namespace|pivot_root|unshare|seccomp' "$trace" 2>/dev/null \
     && grep -qiE 'read-only file system|erofs|operation not permitted|permission denied|eperm' "$trace" 2>/dev/null; then
    echo "hint: this looks like a NESTED-SANDBOX failure — codex-exec ships its own OS sandbox (bwrap)," >&2
    echo "      which cannot run nested inside a harness sandbox (the FS is read-only). Route codex-exec" >&2
    echo "      OUTSIDE the harness sandbox: add it to the harness sandbox excludedCommands, or dispatch" >&2
    echo "      this one run via a per-run consented bypass. Do NOT blanket-disable the sandbox." >&2
  fi
  exit $rc
fi

# Success: capture the session id (NORMAL mode only — it carries thread.started in
# the JSON trace; a resume continues the same session) BEFORE the trap removes the
# trace, so an iterative resume (codex-exec --resume-last) can find it.
if [[ -z "$resume_mode" ]]; then
  session_id="$(grep -m1 '"type":"thread.started"' "$trace" 2>/dev/null \
    | grep -o '"thread_id":"[^"]*"' | cut -d'"' -f4 || true)"
  if [[ -n "$session_id" ]]; then
    sidecar="${CODEX_SESSION_FILE:-$PWD/.codex-last-session}"
    if ! printf '%s\n' "$session_id" >"$sidecar" 2>/dev/null; then
      echo "warning: could not write the session sidecar '$sidecar' — 'codex-exec --resume-last' won't find this id." >&2
    fi
    echo "session: $session_id" >&2
  fi
fi

if [[ -f "$out" && -s "$out" ]]; then
  cat "$out"
else
  echo "warning: codex produced no final-message file — printing the run-trace tail instead." >&2
  tail -n 40 "$trace"
fi
