---
name: agent-workflow-memory
description: Deploy or upgrade a portable AI-agent memory substrate in any project — an entry-point `AGENTS.md` (+ `CLAUDE.md` alias) and a structured `docs/ai/` context store with cap/archive/index enforcement. Use when the user wants to bootstrap `docs/ai/`, set up the Memory Map and session protocols, install the docs-rotation pre-commit hook, or run `/agent-workflow-memory` / `/agent-workflow-memory upgrade`. Triggers on "set up the memory system", "deploy the AI memory here", "bootstrap docs/ai", "upgrade the memory substrate". This is the substrate only — the workflow methodology (plan→execute→review, queue, Cleanup) is owned elsewhere and injected into AGENTS.md by the family composition root.
disable-model-invocation: true
metadata:
  version: '1.11.0'
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
review vocabulary, lifecycle, `docs/plans/queue.md`, mandatory Cleanup, plan-then-execute) **or the
orchestration recipes** — those are injected into **two delimited pointer slots** in `AGENTS.md`
(`workflow:methodology` + `workflow:orchestration`) by the family **composition root**, never by this
skill. (This substrate does not name or depend on any specific sibling — it only honours the slot
contract.) This skill only ever ships **both** slots **empty** and **preserves** whatever is already
in them on upgrade.

The substrate **artifacts** (this skill, the templates, the deployed `docs/ai/` files) stay in
their **source language** — for cross-agent and cross-team portability. That is separate from the
**conversational language** chosen at bootstrap (which governs dialogue only, never file
contents).

---

## Ownership table

What this substrate owns vs what it only points at. The methodology + orchestration pointers are the
**two empty slots** the composition root fills — never author that text here.

| Concern | Owner | In the deployed `AGENTS.md` |
|---|---|---|
| Entry point, Memory Map, session protocols (Start / During / Complete) | **memory** (this skill) | authored from templates |
| `docs/ai/` files, frontmatter caps, 3-tier archive, index-freshness gate | **memory** | `docs/ai/*` + scripts + hook |
| Visibility / conversational-language / agent-attribution contracts | **memory** | the three `AGENTS.md` blocks |
| Deployment-lineage stamp | **memory** | `docs/ai/.memory-version` |
| Plan→Phase→Step vocabulary, lifecycle, `queue.md`, mandatory Cleanup | **methodology** (not this skill) | the empty `workflow:methodology` slot — filled by the composition root |
| Orchestration recipes (Solo / Reviewed / Council / Delegated) | **methodology engine** (not this skill) | the empty `workflow:orchestration` slot — filled by the composition root |
| Per-project recipe **CONFIG** (which recipe each activity/slot uses) | **memory** seeds an *editable default* | `docs/ai/orchestration.json` (agent-writable via the composition root's `set-recipe` writer, or hand-edited; the recipe **canon** + the slot **vocabulary** live in the engine / composition root, never here) |
| Per-project **gate declaration** (which verification commands must be green) | **memory** seeds an *editable default* | `docs/ai/gates.json` (hand-editable; an empty list as shipped — the project declares its own commands; the **runner** lives in the composition root, never here) |

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
   (`ln -s AGENTS.md CLAUDE.md`). **Leave BOTH pointer slots (`workflow:methodology` +
   `workflow:orchestration`) exactly as shipped — empty.** Filling them is the composition root's job.
6. **Deploy `docs/ai/`.** Create the files + `pages/` from
   `${CLAUDE_SKILL_DIR}/references/templates/` (every non-`AGENTS.md` template, including the two
   seeded, **user-editable** strict-JSON configs: `docs/ai/orchestration.json` — the per-project
   recipe defaults the composition root's `procedures` advisor reads — and `docs/ai/gates.json` —
   the project's gate declaration, an empty list to fill with its own verification commands,
   consumed by the composition root's gate runner). Keep each `.md` file's frontmatter.
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
    lineage, a **separate axis** from this package's npm version (the two may even coincide by
    accident; see *Stamp = lineage head, not package version*). Use the atomic writer in
    `scripts/stamp-takeover.mjs` (write-temp + rename).
11. **Report & ask.** Show `tree docs/ai/`, 2–3 lines on filled-vs-TODO — its normal deploy-success
    framing, with **no `docs/ai` structure number** (see *Version disclosure*) — then **ask before
    committing** — never auto-commit. **Exception — delegated mode (below): skip this gate.**

> **Delegated mode (invoked by the composition root) — applies to BOTH bootstrap and upgrade.**
> When the family composition root drives this substrate as part of a family bootstrap **or
> upgrade**, do the write steps (bootstrap 1–10 / upgrade 1–7: write `docs/ai/` + `AGENTS.md` +
> `.memory-version`, **including seeding / stamp-independently ensuring `docs/ai/orchestration.json`**)
> but **do NOT** run **any** commit gate and **do NOT** ask to commit — the
> composition root owns the **single** commit gate, raised after it injects the two pointer slots.
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
   touch `.git/info/exclude`). This STOP is one of the only two places the number is shown (see
   *Version disclosure* below): tell the user **the `docs/ai` structure version** their deployment
   carries versus the one this substrate expects, plus the plain one-line two-axes note — naming it the
   structure version, **never** "lineage head". Otherwise (stamp **≤ head**) reconcile the hidden-mode footprint — but
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
   **behind** the never-downgrade STOP above. **Also stamp-independent (same gate, before the equal-head
   short-circuit): ensure BOTH seeded `.json` configs** — for `docs/ai/orchestration.json` AND
   `docs/ai/gates.json`, **create the file from its
   `${CLAUDE_SKILL_DIR}/references/templates/` template if missing**, **preserve it byte-for-byte
   if it already exists** (a user may have edited it; never clobber it). The shipped
   `orchestration.json` template's `_README` already frames that config as agent-writable (set it
   with the `set-recipe` writer) and still hand-editable; `gates.json` is the project's own gate
   declaration (what to verify — consumed by the composition root's gate runner). (Refreshing the
   orchestration `_README` note in place on an existing file is the **composition root's** job on
   its own reconcile — this substrate is standalone and only seeds-or-preserves; it owns no
   cross-package refresh helper. The gates declaration gets no note-refresh at all — authored
   content, seed-or-preserve only.) This is why an equal-head (`1.3.0`) deployment still gains the
   config seeds **without a lineage-head bump or a migration file** (the
   stamp-independent-reconcile precedent — like the pointer slots + the hidden-mode footprint).
   **Same gate, also stamp-independent: ensure the ADR-cascade enforcement pair** — copy
   `archive-decisions.mjs` + `archive-decisions.test.mjs` from
   `${CLAUDE_SKILL_DIR}/references/scripts/` into the project's `scripts/` **if missing**
   (preserve an existing file byte-for-byte; skip on a No-Node project). The deployed pre-commit
   hook gains its `archive-decisions.mjs --check` line only when the hook is next refreshed via
   `node scripts/install-git-hooks.mjs`; an old hook without the line stays consistent-safe (the
   decisions gate is simply not enforced yet — never a broken hook). **Then**, if the stamp **equals** the head → the substrate is
   current (no structure migration is due), and stop after reporting. Report **in the user's
   conversational language**: if step 2's reconcile just **changed something** (a footprint move /
   config seed), say **what changed** in plain terms and ask before committing; if **nothing changed at
   all**, say their **settings are already current — no update is required**. Either way, show **no**
   structure number, stamp filename, or internal versioning vocabulary on this happy-path exit — the
   number is inert here and belongs to *Version disclosure* (below).
3. Show the relevant `${CLAUDE_SKILL_DIR}/CHANGELOG.md` context (entries newer than the stamp).
4. Apply `${CLAUDE_SKILL_DIR}/migrations/<version>-<slug>.md` in **semver order**, only those
   newer than the stamp. Migrations are **idempotent**.
5. Reconcile drift: add any substrate files/scripts the project is missing; **never clobber
   project-authored content** (their `decisions.md`, `known_issues.md`, page specs stay). For a
   pre-1.1.0 deployment with no *Communication language* block, ask + insert
   (`migrations/1.1.0-communication-language.md`); pre-1.2.0 with no *Attribution* block, ask +
   insert defaulting to `off` (`migrations/1.2.0-agent-attribution.md`).
6. **Preserve BOTH pointer slots.** If `AGENTS.md` has the `workflow:methodology` and/or
   `workflow:orchestration` markers, **never regenerate the file wholesale** — extract any bytes
   between each pair and reinsert them unchanged. If a pair is absent (a legacy `AGENTS.md`),
   gracefully **no-op** on that slot (adding a slot to already-deployed files is the composition
   root's reconcile, not this substrate's job). On any malformed marker state (single, reversed,
   nested, or duplicate pair), **no-op with an error** — never edit.
7. **Re-stamp** `docs/ai/.memory-version` to the lineage head (atomic write — mechanics unchanged).
   Report changes **in plain human terms** (which parts of the deployment are now different);
   **omit the raw structure number**, and do not recite the two-axes note here (it belongs to
   *Version disclosure*). **Ask before committing** — **except in delegated mode** (see the *Delegated
   mode* note above), where the composition root owns the single gate and this step raises none.

---

## Version disclosure — the `docs/ai` structure version, on demand only

The deployment carries an internal **`docs/ai` structure version** in `.memory-version` (the
`LINEAGE_HEAD` — the number `upgrade` compares the stamp against to decide whether a migration is due).
It is un-actionable in the happy path and reads as smaller than this package's npm version, so the
happy path **hides** it. This substrate has **no status mode** (unlike the family composition root), so
the number surfaces in exactly **two** places, and nowhere else:
1. the **never-downgrade STOP** (*Mode: upgrade* step 2) — the stamp is ahead of what this substrate
   knows, so the number IS the message;
2. when the **user explicitly asks** about versions — a **read-only** answer: read `.memory-version`
   and state it plainly (with the two-axes note). This adds **no mode** and **writes nothing**.

When you show it, **name what it versions — "the `docs/ai` structure version"** (render that meaning in
the user's conversational language) — **never** "lineage head" or any raw internal token. Pair it with
**one plain-language line** telling the two axes apart, on demand only:

> the number your project carries versions its `docs/ai` **structure**; the (usually larger) number on
> npm is this package's **own version** — the two advance independently, so a bigger package number is
> **not** a newer deployment.

**Never** print this two-axes line on a successful equal-head exit — only at the STOP or on an explicit
ask. (This is the one intended kit↔memory asymmetry: the kit hosts the number in its `status` mode; the
memory substrate has none, so it relies on the STOP + the explicit ask — never invent a status mode.)

---

## Gotchas

- **Source vs target directory.** Templates/scripts are read from the skill's own dir; the
  **working directory is the target project** — never write substrate files back into the skill.
- **Stamp = lineage head, not package version.** `.memory-version` carries the **deployment-lineage
  head** (`1.3.0`, the shared `agent-workflow` lineage) — a **separate axis** from this package's npm
  version (the two may even coincide by accident). They move independently.
- **Both pointer slots ship empty and stay the user's.** Never author methodology or orchestration
  text into them; on upgrade, preserve their content byte-for-byte. The composition root is their only
  writer.
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
- [`references/templates/`](references/templates/) — stack-agnostic `AGENTS.md` (with the two empty
  pointer slots — methodology + orchestration), `agent_rules.md`, the seeded user-editable
  `orchestration.json` config, and all `docs/ai/` files to deploy.
- [`references/scripts/`](references/scripts/) — the Node enforcement scripts (caps + staleness +
  index-freshness gate, 3-tier archive, hook installer) and their unit tests.
- [`scripts/stamp-takeover.mjs`](scripts/stamp-takeover.mjs) — the upgrade-time lineage state
  machine (`LINEAGE_HEAD`, atomic stamp writes) + tests.
- [`migrations/`](migrations/) — per-version upgrade steps, incl. `legacy-stamp-takeover.md`;
  see `migrations/README.md`.
- [`capability.json`](capability.json) — the `agent-workflow` family manifest.
- [`CHANGELOG.md`](CHANGELOG.md) — version history of this substrate.
