### Mode: agents

<!-- opt-in-capability: agents -->

The opt-in **read-only subagent writer** — the family's second `.claude/` writer, on the velocity discipline. It places the bundled subagent definitions (`references/agents/*.md`) into the project's `.claude/agents/`. **Claude-Code-specific** (like velocity): other agent hosts ignore `.claude/agents/`.

**Every vehicle grants READ-ONLY tools and NO `Bash`** — that is the load-bearing property, not a detail. A read-only fan-out on a full-tool vehicle shells out for facts it could have read, and each shelled command is an approval prompt the maintainer never needed to see; a vehicle with no shell structurally cannot do that. Two lanes ride on it:

- **cheap lane** (`model: haiku`, `effort: low`) — `mechanical-sweep`, `changelog-skeleton`, `gate-triage`: extraction sweeps, changelog fact-skeletons, gate-failure triage. Extraction/drafting only; the orchestrator applies judgment and verifies the output.
- **review lens** (`review-lens`, review-capable model) — an ADDITIONAL independent read-only opinion on code the configured review backends have already seen. It exists because a third lens otherwise has **no vehicle at all**: the cheap vehicles are scoped away from judgment, and a review-capable full-tool subagent is the prompt-flood shape. It never replaces the configured review recipe, and it is advisory like every other review.

Writing code, running gates, and user-facing copy never move to these vehicles.

Run `node ${CLAUDE_SKILL_DIR}/tools/cheap-agents.mjs [--dry-run | --apply] [--cwd <dir>]`:

1. **`--dry-run` first, always** (the default — changes nothing). It previews, per bundled vehicle, whether it **would place** the file, finds it **already current**, or finds a **customized** file (different content) that will be **preserved, never overwritten** (delete the file to reseed it from the bundle).
2. **Only on an explicit yes**, re-run with `--apply`. It writes **only** under `.claude/agents/` — never `settings.json` / `settings.local.json`, never a commit. `--apply` is deployment-gated (the stamp must be at the lineage head) and symlink-safe (a symlinked `.claude` / `.claude/agents` / target file is a STOP).
3. **Hidden-mode deployments:** after apply, run the hide-footprint reconcile (`node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --reconcile`) so the placed files stay invisible to `git status` — `/.claude/agents/` is in the known-footprint registry; the apply report reminds you.

**Invariants:** writer (writes only `.claude/agents/`) · preview by default · a diverged existing file is reported and preserved, never clobbered · never touches settings · never commits · **no vehicle grants `Bash`** · the cheap-lane vehicles are pinned to `model: haiku` + `effort: low`, and the review lens is pinned OFF the cheap model (all content-tested).
