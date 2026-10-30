# Setup contracts

The three choices the bootstrap makes with the user — **visibility**, **conversational
language**, and **agent attribution** — each have a contract below, and the scripts the substrate
deploys have theirs beside them, under *Reserved names and channels*. `SKILL.md` links here so the
main procedure stays lean; load this file when you need the full rule for a contract (e.g. while
filling the matching `AGENTS.md` block, or when an `upgrade` migration touches it).

Ask the three as **ONE structured multi-question prompt where your agent supports it**
(`AskUserQuestion` in Claude Code, up to 4 questions per call), otherwise in prose; record each
answer individually — and write nothing until ALL are answered.

---

## Visibility contract

The user chooses at bootstrap whether the AI artifacts are visible in the repo or hidden — an
**explicit up-front question** (bootstrap step 2), never an assumed default. The two modes then
diverge:

- **visible** — artifacts are committed. When a `package.json` exists and the enforcement offer was
  accepted, wire the project's `package.json` scripts through `node scripts/agent-workflow/run.mjs
  <name>`: `docs:check` → `docs-size`, `docs:index` → `docs-size --write-index`, `docs:index:check`
  → `docs-size --check-index`, `docs:archive` → `archive-changelog`, `docs:archive:check` →
  `archive-changelog --check`, `docs:archive:issues` → `archive-issues`, `docs:archive:issues:check`
  → `archive-issues --check`, `prepare` → `install-git-hooks`; add a minimal `.gitignore`
  (`docs/plans/`, `.claude/settings.local.json`) either way. This is the canonical model.
- **hidden** (in-tree) — same files on disk, but the repo "looks normal": add memory's OWN artifact
  paths to **one project-local ignore list, the repo's `.git/info/exclude`** — resolve it with `git
  rev-parse --git-path info/exclude` (worktree-safe) and **never** the machine-global
  `core.excludesFile`, which would silently affect every repo on the host (visibility is a *project*
  setting). Write each path **once**, in the **canonical anchored form** — `/AGENTS.md`,
  `/CLAUDE.md`, `/docs/ai/` (this subsumes `docs/ai/.memory-version` and any kit-fallback
  `docs/ai/.workflow-version` — do **not** list the stamps separately), `/scripts/agent-workflow/`
  whatever the enforcement answer (every upgrade with Node evidence places the spec layer there),
  `/docs/plans/`, `/.claude/settings.local.json`, and `/.claude/settings.json` (step-4 attribution
  can create it; a standalone hidden memory hides it too). Append only — never duplicate a line that
  is already present. **Verify `git status` shows the artifacts as ignored** afterwards. **Do not
  edit `package.json`** — that is a tracked change and would leak; the pre-commit hook (always
  untracked in `.git/hooks/`) calls the scripts via `node scripts/agent-workflow/run.mjs <name>`.
  *(In a family deploy the composition root then runs its hide tool, which absorbs these
  project-local lines into one canonical managed block and adds the external AI/agent footprint;
  memory writes no machine-global excludes at any step.)*

**Visibility changes only what git sees, never how the agent works.** Both modes carry the same working memory and run the same session protocol — `docs/ai` is read at session start and maintained on task completion **identically** in hidden mode; "git-ignored / `git status` clean" is **not** "optional to update", the updates just live on disk and never enter a commit (the durable wording lives in `agent_rules.md` §1.3).

Not in this version: a fully-external hidden mode (artifacts relocated outside the repo tree).
Deferred to a later release + migration.

---

## Communication contract

The user chooses at bootstrap (step 3) which language the agent **talks to them** in. The choice is
recorded in the *Communication language* block of the project's `AGENTS.md`, so every agent that
reads the entry point honours it — and stops drifting between languages mid-session.

Scope — **dialogue only**:

- **In the chosen language** — everything the agent produces *for the user to read*: questions, explanations, plan summaries, status updates, commit-message prose if asked, review notes.
- **Always in their source language** — code, identifiers, file paths, shell commands, log/console output, error strings, config keys, and abbreviations/acronyms. Translating these breaks copy-paste, search, and tooling.
- **Files aren't translated** — the deployed `docs/ai/` files, `AGENTS.md`, and this kernel stay in their source language regardless of the chosen language (cross-agent / cross-team portability). The conversational language is about the *chat*, not the *artifacts*.

Default to the language the user is already writing in; confirm rather than assume. On `upgrade`, a
pre-1.1.0 deployment with no block gets one (the agent asks).

---

## Attribution contract

The user chooses at bootstrap (step 4) whether the agent may **attribute work to itself or to AI**.
The choice is recorded in the *Attribution* block of the project's `AGENTS.md`, so every agent that
reads the entry point honours it. **Default is `off`** — people are routinely surprised to find an
AI listed as a repo contributor (a `Co-Authored-By` trailer is enough to do it), so opt-in, never
opt-out.

When attribution is **`off`**, no mention of the agent, AI, or the model appears **anywhere**:

- **No `Co-Authored-By` trailers** and **no "Generated with …" footers** on commits or PRs.
- **No AI/agent/model references** in code, comments, commit messages, PR titles/bodies, branch names, or `docs/` prose. The work reads as the human author's.
- **Two enforcement layers** — the *Attribution* block binds everything an agent writes **by hand**; the automatic `Co-Authored-By` trailer is added by the **harness**, not the prose, so for **Claude Code** the bootstrap also sets `"includeCoAuthoredBy": false` in the project's `.claude/settings.json`. Other tools: disable their equivalent co-author/footer setting if present.

When **`on`**, the agent may add its standard trailer / footer per the user's tooling defaults. This
block is about *attribution*, not authorship of the actual changes — quality, tests, and the "ask
before commit" rule are unchanged either way.

On `upgrade`, a pre-1.2.0 deployment with no block gets one (the agent asks, defaulting to `off`).

---

## Reserved names and channels

The kit folder `scripts/agent-workflow/` in the project is the
substrate's: an edit there is never a customization, and the next upgrade overwrites it with the
body this substrate bundles, with no question and no copy of the old file kept. A customization
goes into one of three channels instead:

- **Your own commit checks** go in the local hook file `scripts/pre-commit.local`: the managed
  pre-commit hook runs it first, with bash, when present (memory 8.4.0), once the installer has
  run (bootstrap step 9's command, or a visible deployment's `prepare`).
- **Your own scripts and suites** go in `scripts/` under names of your own.
- **A setting** goes in a config a script reads.

The substrate never writes `scripts/pre-commit.local` or a script of your own.
`.agent-workflow/` is reserved for the agent-workflow family's own files; the substrate writes
nothing there.
