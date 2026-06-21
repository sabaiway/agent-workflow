#!/usr/bin/env bash
# Install agent-workflow-kit launchers for whichever non-Claude agents you have.
# Claude Code needs no launcher — it reads the kit natively from ~/.claude/skills/.
#
# SAFE BY DEFAULT — additive only:
#   - Writes only the kit's OWN namespaced slots:
#       ~/.codex/skills/agent-workflow-kit                     (a symlink)
#       ~/.codeium/.../global_workflows/agent-workflow-kit.md  (a managed file)
#   - NEVER touches your other Codex skills or Devin Desktop workflows.
#   - If one of those exact slots already holds a file the kit did NOT write, it is
#     left untouched and you are told. Re-run with --force to replace it; --force first
#     backs the file up (.bak.<timestamp>) and prints the command to restore it.
#
#   bash <KIT_DIR>/launchers/install-launchers.sh [--force]
set -euo pipefail

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "[launchers] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Kit dir = parent of this script's directory (launchers/..).
KIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="agent-workflow-kit:managed"
TS="$(date +%Y%m%d-%H%M%S)"
echo "[launchers] kit: $KIT_DIR"

installed_any=0
skipped_any=0

backup_and_note() { # $1 = path to back up before we replace it
  local path="$1"
  local bak="${path}.bak.${TS}"
  cp -a "$path" "$bak"
  echo "[launchers]   backed up existing → $bak"
  echo "[launchers]   restore with:  rm -rf \"$path\" && mv \"$bak\" \"$path\""
}

# --- Codex: SKILL.md is a native cross-agent skill → symlink into a Codex skill scope.
if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/skills"
  LINK="$HOME/.codex/skills/agent-workflow-kit"
  if [ -L "$LINK" ] || { [ ! -e "$LINK" ] && [ ! -L "$LINK" ]; }; then
    # Our own symlink slot, or empty — a symlink is a pointer, not user data.
    ln -sfn "$KIT_DIR" "$LINK"
    echo "[launchers] Codex    → linked $LINK -> $KIT_DIR"
    installed_any=1
  elif [ "$FORCE" -eq 1 ]; then
    backup_and_note "$LINK"
    rm -rf "$LINK"
    ln -sfn "$KIT_DIR" "$LINK"
    echo "[launchers] Codex    → replaced (forced) $LINK -> $KIT_DIR"
    installed_any=1
  else
    echo "[launchers] Codex    ⚠ $LINK exists and was not created by the kit — left untouched."
    echo "[launchers]            re-run with --force to replace it (a backup is made first)."
    skipped_any=1
  fi
fi

# --- Devin Desktop (formerly Windsurf): needs a workflow launcher (Devin Local, ex-Cascade,
#     does not read SKILL.md). Cognition rebranded Windsurf -> Devin Desktop on 2026-06-02;
#     the ~/.codeium/windsurf/ paths are unchanged, so this launcher keeps working as-is.
if command -v devin >/dev/null 2>&1 || command -v windsurf >/dev/null 2>&1 || [ -d "$HOME/.codeium/windsurf" ]; then
  WF_DIR="$HOME/.codeium/windsurf/global_workflows"
  mkdir -p "$WF_DIR"
  WF="$WF_DIR/agent-workflow-kit.md"
  write_wf() { sed "s#<KIT_DIR>#$KIT_DIR#g" "$KIT_DIR/launchers/windsurf-workflow.md" > "$WF"; }
  if [ ! -e "$WF" ]; then
    write_wf
    echo "[launchers] Devin Desktop → wrote $WF (/agent-workflow-kit in Devin Local / Cascade)"
    installed_any=1
  elif grep -q "$MARKER" "$WF" 2>/dev/null; then
    write_wf
    echo "[launchers] Devin Desktop → refreshed $WF (kit-managed)"
    installed_any=1
  elif [ "$FORCE" -eq 1 ]; then
    backup_and_note "$WF"
    write_wf
    echo "[launchers] Devin Desktop → replaced (forced) $WF"
    installed_any=1
  else
    echo "[launchers] Devin Desktop ⚠ $WF exists and was not written by the kit — left untouched."
    echo "[launchers]            re-run with --force to replace it (a backup is made first)."
    skipped_any=1
  fi
fi

if [ "$installed_any" -eq 0 ] && [ "$skipped_any" -eq 0 ]; then
  echo "[launchers] No Codex/Devin Desktop install detected. Claude Code (if present) already has the kit natively."
fi
echo "[launchers] Uninstall later: delete the kit's own slot(s) above (the symlink / the agent-workflow-kit.md file)."
echo "[launchers] done."
