### Mode: agents

<!-- opt-in-capability: agents -->

The opt-in **subagent-vehicle writer** — the family's second `.claude/` writer, on the velocity discipline. It places the **five** bundled subagent definitions (`references/agents/*.md`) into the project's `.claude/agents/`: **four read-only vehicles** and **one** full-tool `executor`. **Claude-Code-specific** (like velocity): other agent hosts ignore `.claude/agents/`.

**Every READ-ONLY vehicle grants READ-ONLY tools and NO `Bash`** — that is the load-bearing property, not a detail. A read-only fan-out on a full-tool vehicle shells out for facts it could have read, and each shelled command is an approval prompt the maintainer never needed to see; a vehicle with no shell structurally cannot do that. Two lanes ride on it:

- **cheap lane** (`model: haiku`, `effort: low`) — `mechanical-sweep`, `changelog-skeleton`, `gate-triage`: extraction sweeps, changelog fact-skeletons, gate-failure triage. Extraction/drafting only; the orchestrator applies judgment and verifies the output.
- **review lens** (`review-lens`, review-capable model) — an ADDITIONAL independent read-only opinion on code the configured review backends have already seen. It exists because a third lens otherwise has **no vehicle at all**: the cheap vehicles are scoped away from judgment, and a review-capable full-tool subagent is the prompt-flood shape. It never replaces the configured review recipe, and it is advisory like every other review.

Writing code, running gates, and user-facing copy never move to these four vehicles.

**The fifth vehicle, `executor`, is the ONE full-tool one** (`model: opus`, every tool — a shell included). It is the instrument behind the **Subagent** recipe, dispatched ONLY for a **bounded, file-disjoint slice** the orchestrator verifies afterwards by running its suites: a slice of execution (`plan-execution.execute`), a plan/contract authoring brief (`plan-authoring.author`), or a bounded chore (`routine.carrier`). It **never commits** (no git write at all), is **never a review backend**, is **never a bridge substitute**, and is **never dispatched for read-only work** — a sweep, an inventory or a review rides a read-only vehicle instead.

**Its readiness is the vehicle FILE.** `surveyExecutorVehicle` answers exactly one of four states: **`placed`** (the bundled bytes at `.claude/agents/executor.md`), **`customized`** (a readable regular file whose frontmatter names `executor` and whose tools are not read-only), **`unusable`** (a symlink, a non-regular or unreadable file, or one failing that check — with the reason), **`missing`**. `placed` and `customized` are dispatchable; on `unusable` or `missing` a `subagent` slot **degrades to Solo** with a reason naming this mode's apply command. `/agent-workflow-kit status` shows the state in its `agents` block and the deployment advisor raises it when a configured slot names `subagent` and the vehicle is `unusable` or `missing`. It is a claim about the FILE, never about the host: a Claude Code lane, like this mode itself.

Run `node ${CLAUDE_SKILL_DIR}/tools/cheap-agents.mjs [--dry-run | --apply] [--cwd <dir>]`:

1. **`--dry-run` first, always** (the default — changes nothing). It previews, per bundled vehicle, whether it **would place** the file, finds it **already current**, or finds a **customized** file (different content) that will be **preserved, never overwritten** (delete the file to reseed it from the bundle).
2. **Only on an explicit yes**, re-run with `--apply`. It writes **only** under `.claude/agents/` — never `settings.json` / `settings.local.json`, never a commit. `--apply` is deployment-gated (the stamp must be at the lineage head) and symlink-safe (a symlinked `.claude` / `.claude/agents` / target file is a STOP).
3. **Hidden-mode deployments:** after apply, run the hide-footprint reconcile (`node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --reconcile`) so the placed files stay invisible to `git status` — `/.claude/agents/` is in the known-footprint registry; the apply report reminds you.

**Invariants:** writer (writes only `.claude/agents/`) · preview by default · a diverged existing file is reported and preserved, never clobbered · never touches settings · never commits · **no READ-ONLY vehicle grants `Bash`, and exactly one bundled vehicle, `executor`, grants a shell** · the cheap-lane vehicles are pinned to `model: haiku` + `effort: low`, and the review lens is pinned OFF the cheap model (all content-tested).
