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
#   AGY_MAX_PROMPT_BYTES=200000 agy-run @big.md   # raise the single-argv byte ceiling (default 120000)
#   agy-run "..." -- --add-dir . --dangerously-skip-permissions
#                                            # passthrough agy flags (future flows)
set -euo pipefail

# 1. Make `agy` findable even when ~/.bashrc was not sourced.
export PATH="$HOME/.local/bin:$PATH"

# 2. Force the subscription path: never let an API key hijack billing. Unset EVERY *_API_KEY for the
#    agy subprocess — the explicit Google/Antigravity ones first, then any other *_API_KEY that may
#    have been added later (`compgen` is a bash builtin; the shebang guarantees bash).
unset ANTIGRAVITY_API_KEY GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_API_KEY 2>/dev/null || true
while IFS= read -r _api_key_var; do
  unset "$_api_key_var" 2>/dev/null || true
done < <(compgen -v 2>/dev/null | grep '_API_KEY$' || true)

if ! command -v agy >/dev/null 2>&1; then
  echo "error: 'agy' (Antigravity CLI) not found on PATH. Install it and run 'agy' once to sign in." >&2
  exit 127
fi

# `-` (empty) => skip --model and let agy use settings.json; default to Pro.
AGY_MODEL="${AGY_MODEL-Gemini 3.1 Pro (High)}"
AGY_TIMEOUT="${AGY_TIMEOUT:-5m}"
# Hard wall-clock cap (defaults to AGY_TIMEOUT). agy's own --print-timeout is NOT a reliable
# wall-clock kill — a run was observed surviving 32 min past a 10m --print-timeout — so we also wrap
# agy in timeout(1). A heavy `--add-dir` agentic prompt on the slowest model can otherwise run
# unbounded, and once a caller backgrounds it nothing kills it. Raise only for a known-healthy run.
AGY_HARD_TIMEOUT="${AGY_HARD_TIMEOUT:-$AGY_TIMEOUT}"

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
timeout_bin=""
if command -v timeout >/dev/null 2>&1; then
  timeout_bin="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin="gtimeout"
fi

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
