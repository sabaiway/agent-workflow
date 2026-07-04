## Gotchas

The non-obvious traps — scan these before bootstrapping or upgrading. Each is also enforced inline in the bootstrap/upgrade procedures (`${CLAUDE_SKILL_DIR}/references/modes/bootstrap.md`, `${CLAUDE_SKILL_DIR}/references/modes/upgrade.md`); this is the consolidated high-signal list.

- **Source vs target directory.** Templates and scripts are read from the skill's own dir (`${CLAUDE_SKILL_DIR}/` in Claude Code, the `SKILL.md` folder elsewhere). The **working directory is the target project** — never write kernel files back into the skill.
- **The `Co-Authored-By` trailer is added by the harness, not by prose.** When attribution is `off`, a doc directive alone won't stop it — for Claude Code you **must** also set `"includeCoAuthoredBy": false` in the project's `.claude/settings.json` (create it if absent). Other tools: disable their equivalent co-author/footer setting.
- **Hidden mode must never touch `package.json`.** Editing it is a *tracked* change and leaks the whole system. Hidden mode wires nothing into `package.json`; the pre-commit hook (untracked in `.git/hooks/`) calls `node scripts/<x>.mjs` directly. After hiding, **verify `git status` shows the artifacts as ignored**.
- **Hidden mode is project-local, and the hide tool owns the known footprint.** `tools/hide-footprint.mjs` writes **one managed block** in the **project-local `.git/info/exclude`** — never the machine-global `core.excludesFile` (which would silently affect every repo on the host; **AD-014** amends **AD-006**). It hides the kit's own artifacts **and** the known external AI/agent footprint (the `KNOWN_FOOTPRINT` table in [contracts](${CLAUDE_SKILL_DIR}/references/contracts.md#visibility-contract)). A **tracked** file is **never silently un-tracked** — the tool prints the `git rm --cached` it will not run. Never leak its internal marker / asks terms to the user; translate every outcome to plain language.
- **`CLAUDE.md` is a symlink, not a copy.** `ln -s AGENTS.md CLAUDE.md` — single source, no duplication. A copy drifts; a symlink can't.
- **Never overwrite an existing entry point or hook.** If `AGENTS.md` / `CLAUDE.md` already exist, or the installer reports a pre-existing non-marker git hook, **stop and ask** the user to merge vs replace — don't clobber.
- **Unrecognized invocations are read-only.** Only a **known** subcommand reaches its mode; the **bare** invocation bootstraps (and an existing `docs/ai/` makes it ask upgrade-vs-bootstrap first, never overwrite); **any other / ambiguous** token routes to `help` (read-only). A garbage invocation never writes. The mapping is pinned by `tools/commands.mjs` `routeInvocation` (unit-tested) — don't hand-route around it.
- **No Node runtime → skip enforcement.** If the project has no Node (recon step 1), skip bootstrap steps 8–9 (scripts + hook) and follow the cap/archive/index policy manually, or port the scripts to the project's language.
- **Conversational language never translates artifacts.** It governs *dialogue only*. Code, identifiers, paths, commands, log output, abbreviations, and every deployed `docs/ai/` / `AGENTS.md` file stay in their source language. See [Communication contract](${CLAUDE_SKILL_DIR}/references/contracts.md#communication-contract).
- **Never auto-commit.** Report quality-gate results and wait for explicit approval — in both modes.
- **Never leak kit internals to the user.** No ADR ids, tool / function / operation names (`reconcile`, `inject`, `ensureSlot`), marker / slot / fragment / anchor terminology, or verbatim tool stderr in anything the user reads. Translate every tool outcome into plain language a third-party user — who has never read this `SKILL.md` — can understand and act on (e.g. the cap-refusal report in `${CLAUDE_SKILL_DIR}/references/modes/upgrade.md` step 3).
- **Uninstall never deletes user-authored content, and dry-runs first.** `/agent-workflow-kit uninstall` removes only what is **provably ours** (a managed skill dir / wrapper symlink / fenced block / marker hook) and **prints — never runs** the `rm` / `git rm --cached` for `docs/ai` and the entry-point docs, and an **edit** instruction (not an `rm`) for `.claude/settings.json`. Always run `--dry-run` first, show the plan, get consent, then `--yes`. A skill dir or symlink that is not provably ours is a STOP, never a clobber (the `setup` posture, inverted). Removing a shared global (memory/engine/a bridge) may affect another project — say so.

---

## Setup contracts

The three setup choices — **visibility** (step 2), **conversational language** (step 3), and **agent attribution** (step 4) — each have a full contract in [`references/contracts.md`](${CLAUDE_SKILL_DIR}/references/contracts.md). Load it when you need the complete rule (e.g. while filling the matching `AGENTS.md` block, or when an `upgrade` migration touches one). Defaults, in brief: visibility = `visible` (committed); language = whatever the user is already writing in; attribution = `off`. Ask each as a structured multiple-choice prompt where supported (`AskUserQuestion` in Claude Code), otherwise in prose.

---

## System principles (encode these into the project's `AGENTS.md`)

1. **Single entry point.** `AGENTS.md` is the only entry point (tool aliases like `CLAUDE.md` symlink to it); it never bloats — details live in `docs/ai/`.
2. **Memory Map.** A "read-when / update-when" table for every file. Without it agents get lost.
3. **Three protocols.** Start of Session → During Work → Task Completion, each a short checklist.
4. **Update docs BEFORE code.** Page behaviour changing? Update `pages/<page>.md` first, then the code.
5. **No silent failures.** Every internal validation/guard that rejects an action logs structured context (component, action, ids, inputs); user-facing failures also surface in the UI.
6. **TDD by default.** Test before code (unit for functions, E2E for user flows).
7. **ADR for strategic choices.** Long-term-consequence decisions get a `decisions.md` entry.
8. **Hard Constraints are tool-enforced.** Style rules live in linter/type-checker configs, not prose.
9. **Ask before commit.** The agent reports quality-gate results and waits for explicit approval; it never auto-commits.
10. **Honest `known_issues.md`.** Every bug with a workaround gets Impact + Plan so it isn't re-discovered later.
11. **One conversational language.** Talk to the user in the language chosen at bootstrap; keep code, paths, commands, and abbreviations in their source language. See *Communication contract*.
12. **Attribution is opt-in.** Honour the *Attribution* block: by default no agent/AI/model mention anywhere (commits, PRs, code, comments, docs), and no `Co-Authored-By` trailer. See *Attribution contract*.
13. **Orchestrate via a named recipe.** Compose execution through a named recipe (Solo / Reviewed / Council / Delegated) and **always commit yourself** — backends are advisory or delegated, never autonomous. Encoded via the reconciled `workflow:orchestration` pointer (it routes to `/agent-workflow-kit recipes` + the engine canon), not by bloating the entry point.

---

## Hard Constraints (template — adapt to the stack)

Deploy these into `AGENTS.md`; remove rows that don't apply to the stack.

| Rule | Enforcement |
|------|-------------|
| No `export default` (named exports only) | Linter |
| No `any` / no unsafe casts | Linter / type-checker |
| Functional style (no mutation in app code) | Linter |
| No single-letter variables | Code review |
| Interactive elements semantic (button/link, not div+onClick) | Linter / a11y |
| No hardcoded colors — design tokens only | Code review |
| No business logic in components → hooks/services | Architecture review |
| No changes without tests (TDD) | Required |
| Check page docs before changes; update them after | Process |
| Ask user before committing | Process |
| Every page has an HTML-validity / a11y E2E test | Required |
| **No silent failures** — structured logging on every rejected action | Required |
