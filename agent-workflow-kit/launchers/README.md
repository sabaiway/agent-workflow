# Cross-agent launchers

`agent-workflow-kit` is one kit with **three front doors**. The logic lives once in
[`../SKILL.md`](../SKILL.md) + [`../references/`](../references/); each launcher is a thin
pointer, no duplicated logic. The kit's *output* (`AGENTS.md` + `docs/ai/`) is cross-agent
already — these launchers make the *bootstrapper itself* runnable from non-Claude agents.

`<KIT_DIR>` below = this kit's directory (e.g. `~/.claude/skills/agent-workflow-kit`).

## Install matrix

| Agent | Mechanism | Install | Invoke |
|-------|-----------|---------|--------|
| **Claude Code** | native skill | already at `~/.claude/skills/agent-workflow-kit/` | `/agent-workflow-kit` |
| **Codex** | native skill (same `SKILL.md` cross-agent standard) | symlink the kit into a Codex skill scope: `ln -sfn <KIT_DIR> ~/.codex/skills/agent-workflow-kit` (or `~/.agents/skills/`) | Codex `/skills` menu → `agent-workflow-kit` |
| **Devin Desktop** (formerly Windsurf) | workflow (Devin Local / Cascade doesn't read `SKILL.md`) | `sed "s#<KIT_DIR>#$KIT#g" <KIT_DIR>/launchers/windsurf-workflow.md > ~/.codeium/windsurf/global_workflows/agent-workflow-kit.md` | `/agent-workflow-kit` in Devin Local |
| **Cursor** (bonus) | command/rule | point a `.cursor/commands` entry at `<KIT_DIR>/SKILL.md` (same pattern as the Devin Desktop launcher) | the command name |
| **Any other** | manual | tell the agent: "execute the bootstrap in `<KIT_DIR>/SKILL.md`" | — |

Or run [`install-launchers.sh`](install-launchers.sh) — it auto-detects which of these tools
you have and installs the matching launcher (Claude Code needs none).

## Notes

- **`${CLAUDE_SKILL_DIR}`** in `SKILL.md` means "this skill's own directory". Claude Code expands
  it; other agents should read it as `<KIT_DIR>` (the folder containing `SKILL.md`).
- **Codex invocation policy**: `SKILL.md`'s `disable-model-invocation` is Claude-Code-specific.
  To make the skill user-only in Codex too, add an `agents/openai.yaml` to the kit per the
  [Codex skills docs](https://developers.openai.com/codex/skills). Without it, Codex may
  auto-trigger; the kit's internal "ask before writing / ask before commit" gates still hold.
- **Where the kit lives for non-Claude users**: it does not have to be under `~/.claude/`. Clone
  the kit anywhere (or to `~/.agents/skills/agent-workflow-kit`, which Codex scans) and point the
  launchers at that path.
