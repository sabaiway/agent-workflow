### Mode: bootstrap

Requires: ${CLAUDE_SKILL_DIR}/references/shared/report-footer.md · ${CLAUDE_SKILL_DIR}/references/shared/composition-handoff.md · ${CLAUDE_SKILL_DIR}/references/shared/deploy-tail.md

> Bundled sources below (templates, scripts) live in **this skill's own directory** — `${CLAUDE_SKILL_DIR}/` in Claude Code, or the folder containing this `SKILL.md` in Codex / other agents. Use that as the copy/read source; the working directory is the **target project**, not the skill.

> The three setup questions (steps 2–4) are decisions only the user can make and are hard to reverse after a commit. Ask them as **ONE structured multi-question prompt where your agent supports it** (`AskUserQuestion` in Claude Code — up to 4 questions per call, one option per choice, recommended one first), otherwise in prose; **record each answer individually** — and **write nothing until ALL are answered**.

1. **Recon (read-only).** Before writing anything:
   - `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` → stack, package manager, scripts.
   - `ls -la` root → `README`, existing `AGENTS.md`/`CLAUDE.md`, CI configs, linter/formatter configs.
   - `git log --oneline -30` + `git status` → recent activity, branch, uncommitted changes.
   - `src/` (or equivalent) 2–3 levels deep → modules, routes/pages, components, services, types.
   - Tests (framework, location, E2E?) and linter rules.
   - Record: stack, package manager, daily commands (`dev`/`test`/`lint`/`type-check`), routes/pages, architecture layers.
   - **First-contact orientation — say this before the first question (read-only).** In 1–2 plain lines, tell the user what this is — a portable memory & workflow system for this repo, so future sessions boot from a small structured memory instead of re-reading everything — and that they can run **`/agent-workflow-kit help`** any time to see every command. This is the "start here"; keep it to a sentence or two, then ask the three setup questions (the step-2 batched prompt).
2. **Choose visibility — ask the batched prompt NOW (all three questions, per the preamble above) and wait until every answer is in.** This decides what gets tracked and is hard to reverse after a commit, so never assume the default silently: `visible` (committed — canonical, recommended) or `hidden` (in-tree, git-ignored via the **project-local** `.git/info/exclude` — one managed block covering the full AI/agent footprint, never the machine-global excludes). See [Visibility contract](${CLAUDE_SKILL_DIR}/references/contracts.md#visibility-contract).
3. **Choose conversational language — answered in the step-2 batch.** Which language should the agent *talk to them* in — questions, explanations, summaries, status updates? Offer the language they're already writing in as the default. Carry the answer into the `{{COMM_LANGUAGE}}` slot of the *Communication language* block when `AGENTS.md` is created (step 5). See [Communication contract](${CLAUDE_SKILL_DIR}/references/contracts.md#communication-contract). This sets the **dialogue** language only — never the files.
4. **Choose agent attribution — answered in the step-2 batch.** May the agent attribute work to itself / to AI — `Co-Authored-By` trailers, "Generated with …" footers, "AI"/agent/model mentions in code, comments, commit messages, PR titles/bodies, or docs? **Default to `off`** (no agent/AI mention anywhere) unless they opt in — people are routinely surprised to find an AI listed as a repo contributor. Carry the answer into the `{{AGENT_ATTRIBUTION}}` slot of the *Attribution* block when `AGENTS.md` is created (step 5). **If `off` and the project uses Claude Code**, also set `"includeCoAuthoredBy": false` in the project's `.claude/settings.json` (create it if absent) — the trailer is added by the harness, so a doc directive alone won't stop it. See [Attribution contract](${CLAUDE_SKILL_DIR}/references/contracts.md#attribution-contract).
5. **Entry-point doc.** If `AGENTS.md` / `CLAUDE.md` already exist (step-1 recon), do **not** overwrite — show the user and ask whether to merge or replace. Otherwise create `AGENTS.md` (the cross-agent standard — Codex / Cursor / Devin Desktop / Copilot read it natively) from `${CLAUDE_SKILL_DIR}/references/templates/AGENTS.md`, and symlink `CLAUDE.md -> AGENTS.md` (`ln -s AGENTS.md CLAUDE.md`) for Claude Code — single source, no duplication. For nested context, add a subdir `AGENTS.md` (+ a `CLAUDE.md` symlink beside it for Claude Code).
6. **Deploy `docs/ai/`.** Create every `docs/ai/` file + `pages/` from `${CLAUDE_SKILL_DIR}/references/templates/` (the template loop deploys each non-`AGENTS.md` template — the `.md` docs **and** the two seeded, user-editable strict-JSON configs: **`docs/ai/orchestration.json`** (the per-project recipe defaults the `procedures` advisor reads) and **`docs/ai/gates.json`** (the project's gate declaration — an empty list to fill with its own verification commands, consumed by `${CLAUDE_SKILL_DIR}/references/modes/gates.md`)). Keep each `.md` file's frontmatter (`type / lastUpdated / scope / staleAfter / owner / maxLines`); the `.json` seeds carry no frontmatter (the docs cap-validator globs `*.md` only, so they are inherently skipped).
7. **Fill templates** per the table below.
8. **Install enforcement (Node projects).** Copy `${CLAUDE_SKILL_DIR}/references/scripts/*.mjs` (+ `*.test.mjs`) into the project's `scripts/`. They self-configure (project name from `package.json`, hierarchical/on-demand sections auto-discovered). **If the project has no Node runtime** (step-1 recon), skip this step and the hook in step 9 — follow the cap/archive/index policy manually, or port the scripts to the project's language.
9. **Wire / hide** per visibility (see [Visibility contract](${CLAUDE_SKILL_DIR}/references/contracts.md#visibility-contract)). Install the pre-commit hook (Node projects): `node scripts/install-git-hooks.mjs`. If the installer reports a pre-existing non-marker hook, stop and ask the user to merge it manually rather than overwriting.
   - **visible** — wire the `package.json` scripts + add the minimal `.gitignore`. **Do not run the hide tool.**
   - **hidden** — run the kit's hide writer (one managed block in the **project-local** `.git/info/exclude`, covering the kit's own artifacts **and** every known AI/agent tool's footprint — never the machine-global excludes): `node ${CLAUDE_SKILL_DIR}/tools/hide-footprint.mjs --dir <project> --dry-run` **first** (changes nothing, prints the plan), then the same without `--dry-run`. Handle what it surfaces, in plain language (never the tool's internal terms):
     - A path it reports as **already committed** can't be hidden by ignoring it and is **never un-tracked silently** — show the user the printed `git rm --cached <path>`, let them decide, then opt it in with `--include=<path>`.
     - A **present file with a generic name** it flags (e.g. `GEMINI.md`) → ask before `--include=<path>`.
     - If it reports a **leftover machine-wide ignore block** from an older deployment, **ask before removing it** — it could affect another of the user's repos that relies on the same machine-wide rules; on a yes, re-run with `--remove-global` (prints a restorable backup). Otherwise it is kept (harmless — the project-local rules win).
     - Report the result plainly (what is now hidden). **No Node on the agent host** → write the one managed block into `.git/info/exclude` by hand from the contract's path list, and report the manual step. **Windows is supported.**
   - **Do not edit `package.json`** in hidden mode — a tracked change leaks the whole system.
10. **Stamp the deployment lineage.** Write the **deployment-lineage head** into
    `docs/ai/.workflow-version` (one semver line). The lineage head is **`1.3.0`** — the shared
    `agent-workflow` deployment lineage, **NOT** this kit's npm package version (see
    `package.json` / `CHANGELOG.md`). The two are
    independent axes: a packaging-only release bumps the package but leaves the lineage head until a
    migration actually changes the deployed `docs/ai` structure. A stamp greater than the head →
    STOP (never downgrade).
11. **Report & ask.** Show `tree docs/ai/`, 2–3 lines on what was filled with real data vs left as TODO, then print the **report footer** in the canonical order (version block → one-line backend-status line → welcome mat — the shared contracts in `${CLAUDE_SKILL_DIR}/references/shared/report-footer.md`, rendered from the helpers, same host-can't-run skip-with-reason). The welcome mat closes on **one** caveat-aware next step (a behind member first, else `setup` / `recipes` / `velocity` / `agents` / `hook`). **After the footer, present ONE compact optional-accelerators block** — every entry preview-first, a one-line why each, nothing runs without a yes:
    - `/agent-workflow-kit velocity` — routine read-only commands stop prompting (incl. the `--kit-tools` tier for the kit's own read-only tools; `${CLAUDE_SKILL_DIR}/references/modes/velocity.md`);
    - `/agent-workflow-kit agents` — cheap-model subagents take the mechanical work (sweeps, changelog skeletons, gate triage; `${CLAUDE_SKILL_DIR}/references/modes/agents.md`);
    - **gates seeding + hook** — offer to seed `docs/ai/gates.json` from the commands recon already recorded (step 1), via the consent-gated preview in `${CLAUDE_SKILL_DIR}/references/modes/gates.md` — this block is where that offer fires; then, once gates are declared, `/agent-workflow-kit hook` auto-approves exactly those declared commands (`${CLAUDE_SKILL_DIR}/references/modes/hook.md`);
    - `/agent-workflow-kit set-recipe` — put a ready review backend to work on plans and diffs (`${CLAUDE_SKILL_DIR}/references/modes/set-recipe.md`).
    Then **ask before committing** — never auto-commit.

Fill strategy:

| File | Strategy |
|------|----------|
| `current_state.md`, `architecture.md`, `env_commands.md`, `technical_specification.md`, `pages/index.md` | Fill with **real** recon data (stack, scripts, layers, routes). |
| `tech_reference.md` | Carry over real configs/patterns found in deps. |
| `active_plan.md`, `handover.md` | TODO seed (e.g. "Bootstrap session — fill domain sections after first real work"). |
| `decisions.md` | Seed `AD-001` (adopting this memory system). |
| `known_issues.md`, `changelog.md`, `pages/shared-patterns.md` | Empty template / first bootstrap entry. |
