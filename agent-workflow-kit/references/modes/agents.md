### Mode: agents

The opt-in **cheap-lane subagent writer** — the family's second `.claude/` writer, on the velocity discipline. It places the bundled cheap-lane subagent definitions (`references/agents/*.md`) into the project's `.claude/agents/` so mechanical work — extraction sweeps, changelog fact-skeletons, gate-failure triage — runs on a **cheap model** (`model: haiku`, `effort: low`, bounded read-only tools) instead of the frontier main lane. **Claude-Code-specific** (like velocity): other agent hosts ignore `.claude/agents/`. Judgment, review, real code, and user-facing copy never move to these vehicles — they are extraction/drafting only, and the orchestrator verifies their output.

Run `node ${CLAUDE_SKILL_DIR}/tools/cheap-agents.mjs [--dry-run | --apply] [--cwd <dir>]`:

1. **`--dry-run` first, always** (the default — changes nothing). It previews, per bundled vehicle, whether it **would place** the file, finds it **already current**, or finds a **customized** file (different content) that will be **preserved, never overwritten** (delete the file to reseed it from the bundle).
2. **Only on an explicit yes**, re-run with `--apply`. It writes **only** under `.claude/agents/` — never `settings.json` / `settings.local.json`, never a commit. `--apply` is deployment-gated (the stamp must be at the lineage head) and symlink-safe (a symlinked `.claude` / `.claude/agents` / target file is a STOP).
3. **Hidden-mode deployments:** after apply, run the hide-footprint reconcile (`node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --reconcile`) so the placed files stay invisible to `git status` — `/.claude/agents/` is in the known-footprint registry; the apply report reminds you.

**Invariants:** writer (writes only `.claude/agents/`) · preview by default · a diverged existing file is reported and preserved, never clobbered · never touches settings · never commits · vehicles are pinned to `model: haiku` + `effort: low` + read-only tools (content-tested).
