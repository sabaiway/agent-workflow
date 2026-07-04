### Mode: backends

Read-only. Answers *"which optional execution-backends are set up vs missing, and what's the next step?"* — for the family's subscription-CLI bridges (`codex-cli-bridge` → `codex`, `antigravity-cli-bridge` → `agy`). It **never writes, never commits, and never runs a subscription CLI**.

1. Run `node ${CLAUDE_SKILL_DIR}/tools/detect-backends.mjs` and present its table verbatim. Each row reports two **decoupled** axes: `manifestState` (health of the bridge *skill* — `not-installed | unsupported-schema | invalid-manifest | foreign | stub | ok`) and the readiness signals `cli` / `credentials` / `wrappers`, probed independently — so a CLI that is installed and signed in but whose bridge *skill* is absent reads `needs-skill`, not "missing".
2. For any backend that is not `ready`, point to its setup: the local `setup/README.md` when the bridge is installed, otherwise the backend's setup URL (both are in the report).
3. State plainly to the user that this is **detection only**:
   - **"credentials present"** means the credential-marker **file** exists — it is **not** a live login check. The detector never runs `codex login status` / `agy` (that would spawn a paid, slow, networked subscription CLI).
   - The bridges' wrappers are **POSIX `.sh`** scripts. On Windows the detector still works, but the bridges themselves are **not promised to run** — say so rather than implying they will.
