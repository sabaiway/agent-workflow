# Setup contracts

The three choices the bootstrap makes with the user — **visibility**, **conversational
language**, and **agent attribution** — each have a contract below. `SKILL.md` links here so the
main procedure stays lean; load this file when you need the full rule for a contract (e.g. while
filling the matching `AGENTS.md` block, or when an `upgrade` migration touches it).

Ask each as a **structured multiple-choice prompt where your agent supports it** (`AskUserQuestion`
in Claude Code), otherwise in prose — and always wait for the answer before writing.

---

## Visibility contract

The user chooses at bootstrap whether the AI artifacts are visible in the repo or hidden — an
**explicit up-front question** (bootstrap step 2), never an assumed default. The two modes then
diverge:

- **visible** — artifacts are committed. Wire the project's `package.json` scripts (`docs:check` / `docs:index` / `docs:index:check` / `docs:archive` / `docs:archive:check` / `docs:archive:issues` / `docs:archive:issues:check` / `prepare: node scripts/install-git-hooks.mjs`) and add a minimal `.gitignore` (`docs/plans/`, `.claude/settings.local.json`). This is the canonical model.
- **hidden** (in-tree) — same files on disk, but the repo "looks normal": the AI/agent footprint is git-ignored via **one managed block in the project-local `.git/info/exclude`** (resolved with `git rev-parse --git-path info/exclude` — never the machine-global `core.excludesFile`, which would affect every repo on the host; **AD-014** amends **AD-006**). The kit's `tools/hide-footprint.mjs` is the single writer: it covers `KIT_OWN_PATHS ∪ the present subset of KNOWN_FOOTPRINT` (the full footprint table below — the kit's own artifacts **and** every other AI/agent tool's files). Per path: a **tracked** file → **ASK** (an exclude does nothing for it; only `git rm --cached` un-tracks it — the tool prints that command and never runs it); an untracked path already covered by a **tracked `.gitignore`** → dropped (redundant); a **present** file whose name is generic enough to be ambiguous (`falsePositiveRisk`) → **ASK**; everything else → **hidden**. `asks` are excluded from the block unless explicitly opted in. **Verify** treats a path as hidden only when it is **untracked AND ignored by our project-local block** (or a tracked `.gitignore`) — being ignored by the global excludes does **not** count. Re-running re-derives the block wholesale (sorted/deduped) → a clean re-run is a **zero-diff** no-op. On an existing global-excludes deployment the tool **detects + reports the residual legacy machine-global block and keeps it by default** (a harmless double-ignore; the local block wins precedence); removal is the explicit `--remove-global` (it prints the removed lines as a restorable backup), which **the agent only runs after asking** — another of the user's hidden repos on the same host may rely on the same root-anchored global lines. **Do not edit `package.json`** — that is a tracked change and would leak; the pre-commit hook (always untracked in `.git/hooks/`) calls the scripts via `node scripts/<x>.mjs` directly. Windows is supported (text edit, no symlinks; CRLF preserved).

**Visibility changes what git sees — never how the agent works (the load-bearing invariant).** Both modes carry the **same** working memory and run the **same** session protocol: `docs/ai` and the deployed workflow artifacts (`AGENTS.md`, the added `scripts/`) are read at session start and maintained on task completion **identically** whether visible or hidden. (Hidden mode git-ignores a *wider* footprint — other AI/agent tools' files too — but that is only a **visibility** surface; the working memory the agent actually reads and maintains is `docs/ai` plus those artifacts.) Hidden mode only makes the repo *look* normal to git; it is **never** a license to skip, defer, or down-prioritise a doc/state update. The single difference is the destination: in hidden mode those updates live on disk and never enter a commit (the footprint is excluded), so a commit there carries only the project's own tracked files while `docs/ai` is still kept current locally — **git-ignored ≠ optional-to-maintain**. An agent that reads "git-ignored / `git status` clean" and infers the working memory is optional has the model backwards. (This is why bootstrap/upgrade never wire hidden-mode docs into a commit, yet the session protocol still mandates maintaining them.)

**Known AI/agent footprint** (the `KNOWN_FOOTPRINT` registry in `tools/known-footprint.mjs`; this table is its human mirror, kept in sync by review — D11):

| Pattern | Owner | Kind | Commit-risk name? | Note |
|---|---|---|---|---|
| `/.claude/skills/` | Claude Code | dir | no | local-dev skills; absorbs the AD-013 one-off |
| `/.claude/agents/` | Claude Code | dir | no | project subagent definitions (incl. the kit-placed cheap-lane vehicles) |
| `/.cursor/rules/` | Cursor | dir | no | project rule files |
| `/.cursorrules` | Cursor (legacy) | file | **yes** | legacy single-file rules |
| `/.codeium/` | Codeium/Windsurf | dir | no | home-scoped launchers live under `~/`, out of scope |
| `/.windsurf/` | Windsurf (Devin) | dir | no | project config dir |
| `/.windsurfrules` | Windsurf | file | **yes** | legacy single-file rules |
| `/GEMINI.md` | Gemini/Antigravity | file | **yes** | context file; generic name |
| `/.antigravity.md` | Antigravity | file | **yes** | context file |
| `/.github/copilot-*` | GitHub Copilot | file | **yes** | one reviewed glob; covers `copilot-instructions.md` |
| `/.aider.conf.yml` | Aider | file | no | config |
| `/.aider.chat.history.md` | Aider | file | no | chat history |
| `/.aider.input.history` | Aider | file | no | input history |
| `/.continue/` | Continue | dir | no | project config dir |

The kit's OWN footprint (`KIT_OWN_PATHS`) — `AGENTS.md`, `CLAUDE.md`, `docs/ai/` (subsumes the stamp), the added `scripts/*.mjs`, `docs/plans/`, `.claude/settings.local.json`, and `.claude/settings.json` (hidden-only — visible mode commits it) — is always a candidate in hidden mode.

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
- **Two enforcement layers** — the *Attribution* block binds everything an agent writes **by hand**; the automatic `Co-Authored-By` trailer is added by the **harness**, not the prose, so for **Claude Code** the kit also sets `"includeCoAuthoredBy": false` in the project's `.claude/settings.json`. Other tools: disable their equivalent co-author/footer setting if present.

When **`on`**, the agent may add its standard trailer / footer per the user's tooling defaults. This
block is about *attribution*, not authorship of the actual changes — quality, tests, and the "ask
before commit" rule are unchanged either way.

On `upgrade`, a pre-1.2.0 deployment with no block gets one (the agent asks, defaulting to `off`).
