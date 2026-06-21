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
#   AGY_TIMEOUT=10m agy-run "..."            # override print timeout
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

model_flag=()
if [[ -n "$AGY_MODEL" ]]; then
  model_flag=(--model "$AGY_MODEL")
fi

exec agy "${model_flag[@]}" --print-timeout "$AGY_TIMEOUT" "${passthrough[@]}" -p "$prompt"
