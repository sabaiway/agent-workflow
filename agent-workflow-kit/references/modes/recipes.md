### Mode: recipes

Read-only **orchestration advisor**. Answers *"how should I compose the optional execution-backends into plan → execute → review here, and which recipe fits?"* It **never writes, never commits, never runs a subscription CLI, and never executes a recipe** — the orchestrator (you) runs the chosen recipe through the bridge skills and makes the single commit; a backend is advisory or delegated, never autonomous.

The four recipes (defined over each bridge's `provides` roles — `codex`: execute + review; `agy`: review + probe), canonical narrative in the **installed engine** (`references/orchestration.md`):

- **Solo** — you plan, execute, and self-review; no backend (always available; the floor).
- **Reviewed** — you execute; **one** backend reviews the result (advisory). Prefers `codex` when both are ready (`agy` carries a standing health caveat).
- **Council** — **both** backends review independently; you synthesize the two opinions.
- **Delegated** — you hand a **bounded** execution sub-task to a backend (`codex exec`), then review the returned diff and commit.

1. Run **`node ${CLAUDE_SKILL_DIR}/tools/recipes.mjs`** (the read-only planner; `--json` for the structured form). It runs the backend detector, lists the four recipes, and prints — for the current environment — a **per-recipe dispatch plan that degrades with a stated reason** when a backend isn't `ready` (Council → Reviewed → Solo; Delegated → Solo), plus advisory **quota/health notes** (prefer the cheapest model; Council spends two backends' quota; `agy` may stall on substantive prompts — Issue-001, prefer `codex`).
2. **Offer the choice** via **`AskUserQuestion` where your agent supports it** (`AskUserQuestion` in Claude Code) — one option per recipe, the `recommendRecipe` choice listed **first** — otherwise in prose. Then print `planRecipe(chosen, detection)` (the per-stage dispatch + degradation reasons + quota/health notes) so the user sees exactly what running it entails.
3. **Availability = `readiness === ready`, full stop.** Every other readiness supplies the human reason (needs-skill → "not installed — `/agent-workflow-kit setup`"; needs-cli → "install the CLI"; needs-credentials → "log in"; degraded → "wrapper not on PATH — `/agent-workflow-kit setup`"). This is set-up state only — **never** a claim that a backend's service is responsive (the detector cannot observe a runtime stall; `agy`'s Issue-001 is a *standing advisory*, not a readiness signal).

**The configured-recipe line (`--active-line`, read-only).** `node ${CLAUDE_SKILL_DIR}/tools/recipes.mjs --active-line` prints exactly **one** machine-composed line: the **CONFIGURED** recipe of every activity/slot, resolved from the target project's `docs/ai/orchestration.json` (read from the current directory) + live readiness — each slot with its source (configured vs computed default), its degradation stated, and its dispatched wrapper set — explicitly contrasted with the readiness **recommendation** (which is informational; the configured recipes are what runs). Paste it verbatim: it fills the session-start discovery step (the deployed `agent_rules.md` §1.1) and the handover "Active recipes:" slot; `set-recipe` echoes the same line after every successful write. A malformed config fails loud (exit 1), never a silent fallback.

**Invariants:** read-only · never runs a subscription CLI · never commits · the orchestrator executes the recipe via the bridge skills, not the kit.
