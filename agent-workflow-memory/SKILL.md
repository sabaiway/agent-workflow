---
name: agent-workflow-memory
description: Deploy or upgrade a portable AI-agent memory substrate in any project — an entry-point `AGENTS.md` (+ `CLAUDE.md` alias) and a structured `docs/ai/` context store with cap/archive/index enforcement. Use when the user wants to bootstrap `docs/ai/`, set up the Memory Map and session protocols, install the docs-rotation pre-commit hook, or run `/agent-workflow-memory` / `/agent-workflow-memory upgrade`. Triggers on "set up the memory system", "deploy the AI memory here", "bootstrap docs/ai", "upgrade the memory substrate". This is the substrate only — the workflow methodology (plan→execute→review, queue, Cleanup) is owned elsewhere and injected into AGENTS.md by the family composition root.
disable-model-invocation: true
metadata:
  version: '1.1.0'
---

# agent-workflow-memory

Deploys a **portable AI-agent memory substrate** into a project, and upgrades it as the
substrate evolves. After it runs, any future agent (including a fresh session of yourself) can
reconstruct project context in ~60 seconds, find the current task, and avoid repeating past
mistakes.

The substrate is **stack-agnostic memory** — `docs/ai/` structure, entry-point doc, session
protocols, frontmatter caps, 3-tier archive, index-freshness gate. Enforcement ships as **Node
`.mjs` scripts** (the reference implementation; non-Node stacks follow the same policy
manually).

This skill is the **memory layer** of the `agent-workflow` family. It **knows nobody else** in
the family. In particular it does **not** own the **workflow methodology** (plan → execute →
review vocabulary, lifecycle, `docs/plans/queue.md`, mandatory Cleanup, plan-then-execute) —
that is injected into a delimited slot in `AGENTS.md` by the family **composition root**, never by
this skill. (This substrate does not name or depend on any specific sibling — it only honours the
slot contract.) This skill only ever ships the slot **empty** and **preserves** whatever is already
in it on upgrade.

The substrate **artifacts** (this skill, the templates, the deployed `docs/ai/` files) stay in
their **source language** — for cross-agent and cross-team portability. That is separate from the
**conversational language** chosen at bootstrap (which governs dialogue only, never file
contents).

---

## Ownership table

What this substrate owns vs what it only points at. The methodology pointer is the empty slot
the composition root fills — never author methodology text here.

| Concern | Owner | In the deployed `AGENTS.md` |
|---|---|---|
| Entry point, Memory Map, session protocols (Start / During / Complete) | **memory** (this skill) | authored from templates |
| `docs/ai/` files, frontmatter caps, 3-tier archive, index-freshness gate | **memory** | `docs/ai/*` + scripts + hook |
| Visibility / conversational-language / agent-attribution contracts | **memory** | the three `AGENTS.md` blocks |
| Deployment-lineage stamp | **memory** | `docs/ai/.memory-version` |
| Plan→Phase→Step vocabulary, lifecycle, `queue.md`, mandatory Cleanup | **methodology** (not this skill) | the empty `workflow:methodology` slot — filled by the composition root |

---

## Two modes

Pick the mode from the user's invocation. Auto-detect an existing `docs/ai/` to guard against
bootstrapping over a live system, but the user makes the final call.

- **`/agent-workflow-memory`** (default) — bootstrap a new or empty project. If `docs/ai/`
  already exists, stop and ask whether they meant `upgrade`.
- **`/agent-workflow-memory upgrade`** — upgrade an existing deployment.

### Mode: bootstrap

> Bundled sources below (templates, scripts) live in **this skill's own directory** —
> `${CLAUDE_SKILL_DIR}/` in Claude Code, or the folder containing this `SKILL.md` elsewhere.
> Use that as the copy/read source; the working directory is the **target project**.

> The three setup questions (steps 2–4) are decisions only the user can make and are hard to
> reverse after a commit. Ask each as a **structured multiple-choice prompt where supported**
> (`AskUserQuestion` in Claude Code, recommended option first), otherwise in prose — and
> **wait for the answer before writing anything**.

1. **Recon (read-only).** Before writing anything: `package.json` / `pyproject.toml` / `go.mod`
   / `Cargo.toml` → stack, package manager, scripts; `ls -la` root → README, existing
   `AGENTS.md`/`CLAUDE.md`, CI / linter configs; `git log --oneline -30` + `git status`; `src/`
   2–3 levels deep; tests + linter rules. Record stack, package manager, daily commands, layers.
2. **Choose visibility — ASK explicitly and wait.** `visible` (committed — canonical,
   recommended) or `hidden` (in-tree, git-ignored via the **project-local** `.git/info/exclude` —
   never the machine-global excludes). See
   [Visibility contract](references/contracts.md#visibility-contract).
3. **Choose conversational language — ASK explicitly and wait.** Which language the agent
   *talks to them* in. Offer the language they're already writing in as the default. Carry it
   into the `{{COMM_LANGUAGE}}` slot of the *Communication language* block (step 5). See
   [Communication contract](references/contracts.md#communication-contract). Dialogue only —
   never the files.
4. **Choose agent attribution — ASK explicitly and wait.** May the agent attribute work to
   itself / AI — `Co-Authored-By` trailers, "Generated with …" footers, AI/agent/model mentions?
   **Default `off`.** Carry it into `{{AGENT_ATTRIBUTION}}` (step 5). **If `off` and the project
   uses Claude Code**, also set `"includeCoAuthoredBy": false` in the project's
   `.claude/settings.json` (create it if absent). See
   [Attribution contract](references/contracts.md#attribution-contract).
5. **Entry-point doc.** If `AGENTS.md` / `CLAUDE.md` already exist (recon), do **not**
   overwrite — show the user and ask whether to merge or replace. Otherwise create `AGENTS.md`
   from `${CLAUDE_SKILL_DIR}/references/templates/AGENTS.md` and symlink `CLAUDE.md -> AGENTS.md`
   (`ln -s AGENTS.md CLAUDE.md`). **Leave the `workflow:methodology` slot exactly as shipped —
   empty.** Filling it is the composition root's job.
6. **Deploy `docs/ai/`.** Create the files + `pages/` from
   `${CLAUDE_SKILL_DIR}/references/templates/`. Keep each file's frontmatter.
7. **Fill templates** per the table below.
8. **Install enforcement (Node projects).** Copy `${CLAUDE_SKILL_DIR}/references/scripts/*.mjs`
   (+ `*.test.mjs`) into the project's `scripts/`. **No Node runtime** → skip this + the hook;
   follow the cap/archive/index policy manually.
9. **Wire / hide** per visibility (see contract). Install the pre-commit hook (Node projects):
   `node scripts/install-git-hooks.mjs`. If it reports a pre-existing non-marker hook, stop and
   ask the user to merge it manually. **Hidden** → add memory's own artifact paths (the canonical
   anchored list in the [Visibility contract](references/contracts.md#visibility-contract)) to the
   **project-local** `.git/info/exclude` (resolve via `git rev-parse --git-path info/exclude`),
   append-only (never duplicate an existing line), then **verify `git status` shows them ignored**.
   Never the machine-global excludes; never edit `package.json`.
10. **Stamp the deployment lineage.** Write the **deployment-lineage head** into
    `docs/ai/.memory-version` (one semver line). The lineage head is **`1.3.0`** (the
    `LINEAGE_HEAD` constant in `scripts/stamp-takeover.mjs`) — the shared `agent-workflow`
    lineage, **not** this package's npm version (`1.1.0`). Use the atomic writer in
    `scripts/stamp-takeover.mjs` (write-temp + rename).
11. **Report & ask.** Show `tree docs/ai/`, 2–3 lines on filled-vs-TODO, then **ask before
    committing** — never auto-commit. **Exception — delegated mode (below): skip this gate.**

> **Delegated mode (invoked by the composition root) — applies to BOTH bootstrap and upgrade.**
> When the family composition root drives this substrate as part of a family bootstrap **or
> upgrade**, do the write steps (bootstrap 1–10 / upgrade 1–7: write `docs/ai/` + `AGENTS.md` +
> `.memory-version`) but **do NOT** run **any** commit gate and **do NOT** ask to commit — the
> composition root owns the **single** commit gate, raised after it injects the methodology slot.
> The three setup answers and the target dir are passed in by the composition root; you perform no
> commit and no slot injection. **Standalone** invocation keeps its own commit gate (bootstrap step
> 11 / upgrade step 7).

Fill strategy:

| File | Strategy |
|------|----------|
| `current_state.md`, `architecture.md`, `env_commands.md`, `technical_specification.md`, `pages/index.md` | Fill with **real** recon data. |
| `tech_reference.md` | Carry over real configs/patterns found in deps. |
| `active_plan.md`, `handover.md` | TODO seed. |
| `decisions.md` | Seed `AD-001` (adopting this memory system). |
| `known_issues.md`, `changelog.md`, `pages/shared-patterns.md` | Empty template / first bootstrap entry. |

### Mode: upgrade

1. **Resolve the stamp.** Read `docs/ai/.memory-version`. If it is absent but a legacy
   `docs/ai/.workflow-version` exists (a kit fallback bootstrap), run
   `migrations/legacy-stamp-takeover.md` **first** — it copies that value verbatim into
   `.memory-version` (and never deletes the legacy stamp). The pure state machine in
   `scripts/stamp-takeover.mjs` decides the action per state; the Markdown migration is the
   no-Node manual fallback. If **no** stamp exists at all, offer a conservative re-bootstrap.
2. **Never-downgrade gate FIRST, then the stamp-independent hidden-mode reconcile (D14).** Compare the
   stamp to the **deployment-lineage head** (`LINEAGE_HEAD`, `1.3.0`). **Greater than the head, or
   unparseable → STOP and report immediately, before ANY write** (never downgrade or guess, and never
   touch `.git/info/exclude`). Otherwise (stamp **≤ head**) reconcile the hidden-mode footprint — but
   first **infer this deployment's OWN visibility from its git state** (NOT from whether the machine-global
   excludes list these paths — another repo on the host may have added them): if `AGENTS.md` (or
   `docs/ai/`) is **tracked / committed** → **VISIBLE** → do nothing (never write `.git/info/exclude`);
   if it is **untracked AND currently git-ignored** → **HIDDEN** → move memory's own footprint to the
   **project-local** `.git/info/exclude` (the canonical anchored list from the Visibility contract,
   append-only and idempotent — a clean re-run changes nothing), leaving the machine-global lines for the
   user to remove (in a family upgrade the composition root's hide tool detects + reports that residual
   block and removes it only after the user's explicit consent — never by default); if it is
   **untracked AND not ignored** → **AMBIGUOUS** → **ASK** the user before writing. This visibility check
   runs on **every** in-range upgrade, even at head — it is not gated by the stamp delta, but it is gated
   **behind** the never-downgrade STOP above. **Then**, if the stamp **equals** the head → report "up to
   date" (plus any footprint move just made) and stop.
3. Show the relevant `${CLAUDE_SKILL_DIR}/CHANGELOG.md` context (entries newer than the stamp).
4. Apply `${CLAUDE_SKILL_DIR}/migrations/<version>-<slug>.md` in **semver order**, only those
   newer than the stamp. Migrations are **idempotent**.
5. Reconcile drift: add any substrate files/scripts the project is missing; **never clobber
   project-authored content** (their `decisions.md`, `known_issues.md`, page specs stay). For a
   pre-1.1.0 deployment with no *Communication language* block, ask + insert
   (`migrations/1.1.0-communication-language.md`); pre-1.2.0 with no *Attribution* block, ask +
   insert defaulting to `off` (`migrations/1.2.0-agent-attribution.md`).
6. **Preserve the methodology slot.** If `AGENTS.md` has the `workflow:methodology` markers,
   **never regenerate the file wholesale** — extract any bytes between the markers and reinsert
   them unchanged. If the markers are absent (a legacy `AGENTS.md`), gracefully **no-op** on the
   slot (adding the slot to already-deployed files is a separate methodology migration). On any
   malformed marker state (single, reversed, nested, or duplicate pair), **no-op with an error**
   — never edit.
7. **Re-stamp** `docs/ai/.memory-version` to the lineage head (atomic write). Report changes;
   **ask before committing** — **except in delegated mode** (see the *Delegated mode* note above),
   where the composition root owns the single gate and this step raises none.

---

## Gotchas

- **Source vs target directory.** Templates/scripts are read from the skill's own dir; the
  **working directory is the target project** — never write substrate files back into the skill.
- **Stamp = lineage head, not package version.** `.memory-version` carries `1.3.0` (the shared
  `agent-workflow` lineage), not the npm `1.1.0`. They are independent axes.
- **The methodology slot ships empty and stays the user's.** Never author methodology text into
  it; on upgrade, preserve its content byte-for-byte. The composition root is its only writer.
- **The `Co-Authored-By` trailer is added by the harness, not by prose.** When attribution is
  `off` + Claude Code, also set `"includeCoAuthoredBy": false` in `.claude/settings.json`.
- **Hidden mode is project-local, never machine-global.** Memory's hide writes to the repo's
  `.git/info/exclude` (one per-project ignore list), never `core.excludesFile`. `/docs/ai/`
  subsumes `docs/ai/.memory-version` (and any kit-fallback `.workflow-version`) — list neither
  separately. **Never touch `package.json`.** After hiding, verify `git status` shows the
  artifacts as ignored.
- **`CLAUDE.md` is a symlink, not a copy.** `ln -s AGENTS.md CLAUDE.md`.
- **Never overwrite an existing entry point or hook.** Stop and ask to merge vs replace.
- **No Node runtime → skip enforcement** (scripts + hook); follow the policy manually.
- **Never auto-commit.** Report quality-gate results and wait for explicit approval — both modes.

---

## Setup contracts

The three setup choices each have a full contract in
[`references/contracts.md`](references/contracts.md). Defaults: visibility = `visible`; language
= whatever the user is already writing in; attribution = `off`.

---

## References

- [`references/contracts.md`](references/contracts.md) — the three setup contracts in full.
- [`references/templates/`](references/templates/) — stack-agnostic `AGENTS.md` (with the empty
  methodology slot), `agent_rules.md`, and all `docs/ai/` files to deploy.
- [`references/scripts/`](references/scripts/) — the Node enforcement scripts (caps + staleness +
  index-freshness gate, 3-tier archive, hook installer) and their unit tests.
- [`scripts/stamp-takeover.mjs`](scripts/stamp-takeover.mjs) — the upgrade-time lineage state
  machine (`LINEAGE_HEAD`, atomic stamp writes) + tests.
- [`migrations/`](migrations/) — per-version upgrade steps, incl. `legacy-stamp-takeover.md`;
  see `migrations/README.md`.
- [`capability.json`](capability.json) — the `agent-workflow` family manifest.
- [`CHANGELOG.md`](CHANGELOG.md) — version history of this substrate.
