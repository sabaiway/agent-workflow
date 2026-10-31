---
name: agent-workflow-memory
description: Deploy or upgrade a portable AI-agent memory substrate in any project — an entry-point `AGENTS.md` (+ `CLAUDE.md` alias) and a structured `docs/ai/` context store with cap/archive/index enforcement. Use when the user wants to bootstrap `docs/ai/`, set up the Memory Map and session protocols, install the docs-rotation pre-commit hook, or run `/agent-workflow-memory` / `/agent-workflow-memory upgrade`. Triggers on "set up the memory system", "deploy the AI memory here", "bootstrap docs/ai", "upgrade the memory substrate". This is the substrate only — the workflow methodology (plan→execute→review, queue, Cleanup) is owned elsewhere and injected into AGENTS.md by the family composition root.
disable-model-invocation: true
metadata:
  version: '10.0.0'
---

# agent-workflow-memory

Deploys a **portable AI-agent memory substrate** into a project, and upgrades it as the
substrate evolves. After it runs, any future agent (including a fresh session of yourself) can
reconstruct project context in ~60 seconds, find the current task, and avoid repeating past
mistakes.

The substrate is **stack-agnostic memory** — `docs/ai/` structure, entry-point doc, session
protocols, frontmatter caps, one-file-per-ADR archive, index-freshness gate. Enforcement ships as
dependency-free **Node `.mjs` scripts** with a pre-commit hook, offered on every project because
the agent host runs them.

This skill is the **memory layer** of the `agent-workflow` family. It **knows nobody else** in
the family. In particular it does **not** own the **workflow methodology** (the plan shape,
lifecycle, `docs/plans/queue.md`, mandatory Cleanup, the activity procedures), **the
orchestration recipes, or the autonomy-policy contract** — those reach `AGENTS.md` in the block
the family **composition root** writes there, never through this skill. (This substrate does not
name or depend on any specific sibling.) This skill ships no such block, never writes one, and on
upgrade keeps one already in the file byte for byte.

The substrate **artifacts** (this skill, the templates, the deployed `docs/ai/` files) stay in
their **source language** — for cross-agent and cross-team portability. That is separate from the
**conversational language** chosen at bootstrap (which governs dialogue only, never file
contents).

---

## Ownership table

What this substrate owns vs what it only points at. The methodology, orchestration and autonomy
texts are the composition root's to write in its own block — never author that text here.

| Concern | Owner | In the deployed `AGENTS.md` |
|---|---|---|
| Entry point, Memory Map, session protocols (Start / During / Complete) | **memory** (this skill) | authored from templates |
| `docs/ai/` files, frontmatter caps, one-file-per-ADR archive, index-freshness gate | **memory** | `docs/ai/*` + scripts + hook |
| Visibility / conversational-language / agent-attribution contracts | **memory** | the three `AGENTS.md` blocks |
| Deployment-lineage stamp | **memory** | `docs/ai/.memory-version` |
| Plan shape (goal and boundary, module ledger, verification), lifecycle, `queue.md`, mandatory Cleanup | **methodology** (not this skill) | the composition root's block — written by the composition root |
| Orchestration recipes (Solo / Reviewed / Council / Delegated / Subagent) | **methodology engine** (not this skill) | the composition root's block — written by the composition root |
| Autonomy-policy read contract (`docs/ai/autonomy.json`) | **methodology engine** (not this skill) | the composition root's block — written by the composition root |
| Per-project recipe **CONFIG** (which recipe each activity/slot uses) | **memory** seeds an *editable default* | `docs/ai/orchestration.json` (agent-writable via the composition root's `set-recipe` writer, or hand-edited; the recipe **canon** + the slot **vocabulary** live in the engine / composition root, never here) |
| Per-project **gate declaration** (which verification commands must be green) | **memory** seeds an *editable default* | `docs/ai/gates.json` (hand-editable; an empty list as shipped — the project declares its own commands; the **runner** lives in the composition root, never here) |
| Per-project **autonomy policy** (red-lines + per-activity autonomy level) | **memory** seeds an *editable default* | `docs/ai/autonomy.json` (hand-editable, or agent-writable via the composition root's `set-autonomy` writer; the seed is SPARSE — the onboarding note only, defaults-equivalent, so deploying it never changes behavior; the policy **canon** + the render live in the engine / composition root, never here) |

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
> reverse after a commit. Ask them as **ONE structured multi-question prompt where supported**
> (`AskUserQuestion` in Claude Code, up to 4 questions per call, recommended option first),
> otherwise in prose; **record each answer individually** — and **write nothing until ALL are
> answered**.

1. **Recon (read-only).** Before writing anything: `package.json` / `pyproject.toml` / `go.mod`
   / `Cargo.toml` → stack, package manager, scripts; `ls -la` root → README, existing
   `AGENTS.md`/`CLAUDE.md`, CI / linter configs; `git log --oneline -30` + `git status`; `src/`
   2–3 levels deep; tests + linter rules. Record stack, package manager, daily commands, layers.
2. **Choose visibility — ask the batched prompt NOW (all three questions, per the preamble
   above) and wait until every answer is in.** `visible` (committed — canonical,
   recommended) or `hidden` (in-tree, git-ignored via the **project-local** `.git/info/exclude` —
   never the machine-global excludes). See
   [Visibility contract](references/contracts.md#visibility-contract).
3. **Choose conversational language — answered in the step-2 batch.** Which language the agent
   *talks to them* in. Offer the language they're already writing in as the default. Carry it
   into the `{{COMM_LANGUAGE}}` slot of the *Communication language* block (step 5). See
   [Communication contract](references/contracts.md#communication-contract). Dialogue only —
   never the files.
4. **Choose agent attribution — answered in the step-2 batch.** May the agent attribute work to
   itself / AI — `Co-Authored-By` trailers, "Generated with …" footers, AI/agent/model mentions?
   **Default `off`.** Carry it into `{{AGENT_ATTRIBUTION}}` (step 5). **If `off` and the project
   uses Claude Code**, also set `"includeCoAuthoredBy": false` in the project's
   `.claude/settings.json` (create it if absent). See
   [Attribution contract](references/contracts.md#attribution-contract).
5. **Entry-point doc.** If `AGENTS.md` / `CLAUDE.md` already exist (recon), do **not**
   overwrite — show the user and ask whether to merge or replace. Otherwise create `AGENTS.md`
   from `${CLAUDE_SKILL_DIR}/references/templates/AGENTS.md` and symlink `CLAUDE.md -> AGENTS.md`
   (`ln -s AGENTS.md CLAUDE.md`). The template carries no workflow comment lines; writing its block
   into the file is the composition root's job.
6. **Deploy `docs/ai/`.** Create the files + `pages/` + the seed `adr/` store + the seed `specs/`
   store from `${CLAUDE_SKILL_DIR}/references/templates/` (every template except `AGENTS.md`,
   `adr-record.md` and `SPEC_TEMPLATE.md` — the latter two are skill-home authoring references, never
   deployed). This deploys the HOT ADR window `docs/ai/decisions.md` **and** the seed navigator
   `docs/ai/adr/log.md` (its `adr/` subdir copies in wholesale), the spec store root
   `docs/ai/specs/index.md` (its `specs/` subdir copies in wholesale; feature contracts are authored
   under it from `SPEC_TEMPLATE.md`), plus the three seeded, **user-editable** strict-JSON configs:
   `docs/ai/orchestration.json` — the per-project recipe defaults the composition root's `procedures`
   advisor reads — `docs/ai/gates.json` — the project's gate declaration, an empty list to fill with
   its own verification commands, consumed by the composition root's gate runner — and
   `docs/ai/autonomy.json` — the per-project autonomy policy, seeded SPARSE (the onboarding note
   only, defaults-equivalent — behavior changes only when the user declares levels). Keep each
   `.md` file's frontmatter.
7. **Fill templates** per the table below. **Then materialize the navigator, as the last `docs/ai`
   step:** the entry point declares `docs/ai/index.md` always-loaded and it is a GENERATED artifact
   with no template, so run
   `node ${CLAUDE_SKILL_DIR}/references/scripts/docs-size/check-docs-size.mjs --ensure-index --root=<target>`
   and relay its one outcome line (`ensure-index: regenerated` / `already-current`, or a
   `write-refused` / `probe-failed` line naming the offending path — either is a STOP: resolve it
   before reporting the deploy, since the navigator the entry point declares does not exist yet). The
   generator runs from the **skill home**, so a **No-Node target** is covered too: the operator's own
   host runs it, and step 8's copy is not a precondition.
8. **Offer enforcement on every project, preview-first.** Explain in one line that the
   dependency-free Node scripts are available because the agent host already runs the skill-home
   navigator; the only skip condition is that the agent host cannot run them. Preview with
   `node ${CLAUDE_SKILL_DIR}/scripts/kit-folder.mjs --project <target> --dry-run --enforcement`,
   naming each file it would write over, and ask; on a yes copy with the same line without `--dry-run`.
   Relay every line; in a hidden deployment relay every line but the commit-together line, since
   step 9 writes the exclude after the copy and `check-ignore` still sees the kit folder as visible.
   A non-zero exit is named, and the run continues as on a no.
   On a no, skip the hook in step 9 and say so; the docs command slots then name no project-local
   command — fill `env_commands.md` and the `Docs caps + index freshness` row of `AGENTS.md` with
   the same note: the caps + index gate run from the agent's own skill copy (the step-7
   `--root=<target>` form) and the archive rotations need the scripts deployed. Never write the
   skill's absolute path into a deployed doc. They self-configure
   (project name from `package.json` or, without one, the directory basename). The hook calls
   `node scripts/agent-workflow/run.mjs <name>`, so a committer without `node` on PATH gets the hook's own loud
   failure.
9. **Wire / hide** per visibility (see contract). When the user accepts the enforcement offer
   and step 8's apply exited 0,
   install the pre-commit hook: `node scripts/agent-workflow/run.mjs install-git-hooks`. If it reports a pre-existing
   non-marker hook, stop and
   ask the user to merge it manually. **Hidden** → add memory's own artifact paths (the canonical
   anchored list in the [Visibility contract](references/contracts.md#visibility-contract)) to the
   **project-local** `.git/info/exclude` (resolve via `git rev-parse --git-path info/exclude`),
   append-only (never duplicate an existing line), then **verify `git status` shows them ignored**.
   Never the machine-global excludes; never edit `package.json`.
10. **Stamp the deployment lineage.** Write the **deployment-lineage head** into
    `docs/ai/.memory-version` (one semver line). The lineage head is **`5.0.0`** (the
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
> composition root owns the **single** commit gate, raised after it writes its block.
> The three setup answers and the target dir are passed in by the composition root; you perform no
> commit and no block write. **Standalone** invocation keeps its own commit gate (bootstrap step
> 11 / upgrade step 7).

Fill strategy:

| File | Strategy |
|------|----------|
| `current_state.md`, `architecture.md`, `env_commands.md`, `technical_specification.md`, `pages/index.md` | Fill with **real** recon data. |
| `tech_reference.md` | Carry over real configs/patterns found in deps. |
| `active_plan.md`, `handover.md` | TODO seed. |
| `decisions.md` | The HOT ADR window — seed `AD-001` (adopting this memory system), newest at the bottom. |
| `adr/log.md` | The seed navigator — deployed as-is (the generator over the seeded HOT); regenerated by `node scripts/agent-workflow/run.mjs archive-decisions` wherever the kit folder holds the rotator, otherwise it stays the seed — never hand-edited either way. |
| `known_issues.md`, `changelog.md`, `pages/shared-patterns.md` | Empty template / first bootstrap entry. |

### Mode: upgrade

1. **Resolve the stamp.** Read `docs/ai/.memory-version`. If it is absent but a legacy
   `docs/ai/.workflow-version` exists (a kit fallback bootstrap), run
   `migrations/legacy-stamp-takeover.md` **first** — it copies that value verbatim into
   `.memory-version` (and never deletes the legacy stamp). The pure state machine in
   `scripts/stamp-takeover.mjs` decides the action per state; the Markdown migration is the
   no-Node manual fallback. If **no** stamp exists at all, offer a conservative re-bootstrap.
2. **Never-downgrade gate FIRST, then the stamp-independent hidden-mode reconcile (D14).** Compare the
   stamp to the **deployment-lineage head** (`LINEAGE_HEAD`, `5.0.0`). **Greater than the head, or
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
   short-circuit): ensure the THREE seeded `.json` configs** — for `docs/ai/orchestration.json`,
   `docs/ai/gates.json`, AND `docs/ai/autonomy.json`,
   **create the file from its
   `${CLAUDE_SKILL_DIR}/references/templates/` template if missing**, **preserve it byte-for-byte
   if it already exists** (a user may have edited it; never clobber it). The shipped
   `orchestration.json` template's `_README` already frames that config as agent-writable (set it
   with the `set-recipe` writer) and still hand-editable; `gates.json` is the project's own gate
   declaration (what to verify — consumed by the composition root's gate runner);
   `autonomy.json` is the
   per-project autonomy policy, seeded SPARSE (the onboarding note only, defaults-equivalent —
   agent-writable via the composition root's `set-autonomy` writer, hand-editing supported). (Refreshing the
   orchestration `_README` note in place on an existing file is the **composition root's** job on
   its own reconcile — this substrate is standalone and only seeds-or-preserves; it owns no
   cross-package refresh helper. The gates declaration gets no note-refresh at all — authored
   content, seed-or-preserve only.) This is why an equal-head (`5.0.0`) deployment still gains the
   config seeds **without a lineage-head bump or a migration file** (the
   stamp-independent-reconcile precedent — like the hidden-mode footprint).
   **Same gate, also stamp-independent — the kit folder:** run
   `node ${CLAUDE_SKILL_DIR}/scripts/kit-folder.mjs --project <target>`, relay every line, and
   **STOP on a non-zero exit**. The script owns the survey, writes, ADR store run and flat-file
   removal; run no probe, copy, comparison or rotator yourself. Relay its `ADR store: ` lines:
   `--ensure-current` is the script's store run. With no Node evidence its pending-move line names
   `docs/ai/history/decisions-archive.md` or `decisions-archive-early.md`, whichever stands.
   Then seed `docs/ai/specs/index.md` **if missing** from
   `${CLAUDE_SKILL_DIR}/references/templates/specs/` (date filled), only after the script
   **exited 0 without its no-Node-evidence skip line**; a link or any other node at the path writes
   nothing and is named; on the skip line the seed is skipped. In delegated mode the script does not run
   and memory seeds no store root: the composition root's upgrade owns the kit folder, its move,
   its store run and the store root; name the composition root's upgrade as their owner in the report.
   In a visible deployment holding the documented `package.json` wiring, the agent rewrites those
   scripts to the command forms in contracts.md in this upgrade. Memory touches no gate: a grep hit
   naming an old gate path is reported with its replacement and left unchanged until the composition
   root's upgrade switches it.
   **After a removal, including a stopped upgrade's hand route:** name as the suites to wire the
   regular `scripts/*.test.mjs` outside `FLAT_NAMES`, plus each flat suite the run named not the
   kit's; the user adds each to `scripts/pre-commit.local` as `node --test scripts/<file>` (the
   substrate never writes that file).
   Use the grep form `git grep -n -F --untracked <one -e per FLAT_NAMES> -- . ':!scripts/agent-workflow'`,
   taking `FLAT_NAMES` from `${CLAUDE_SKILL_DIR}/scripts/flat-scripts.mjs`, never copying its names
   here. Check the hooks dir and ignored files yourself: git grep does not cover them.
   Grep legend: a kit check's `node scripts/<file>` becomes
   `node scripts/agent-workflow/run.mjs <name>` with its arguments; a deployed entry's path becomes
   `scripts/agent-workflow/<path>`; a suite and the support file have no deployed path.
   In a visible deployment, commit `scripts/agent-workflow/`, each removed flat file and
   `package.json` as the upgrade changed it as one change, and merge it into every branch still
   committed or installed on. The suite and grep lines print only on the run that removed; the
   commit-together line prints only for a visible deployment when a file was placed or removed.
   A no on the hook switch leaves every commit stopped at Node's error naming a removed file until
   the switch line is run. A switch skip naming an absent installer requires running the script
   once with `--enforcement`, then the switch line, or removing the hooks dir's `pre-commit`.
   An older flat body is named not the kit's and left; a tree holding only flat suites and the
   support file with no other Node evidence is skipped. Hidden reconcile only appends: an earlier
   flat exclude line stays until the user removes it. **Same gate, also
   stamp-independent — ensure the NAVIGATOR:** `docs/ai/index.md` is a GENERATED artifact the entry
   point declares always-loaded, so a deployment that never had one must gain it even at head — run
   `node ${CLAUDE_SKILL_DIR}/references/scripts/docs-size/check-docs-size.mjs --ensure-index --root=<target>`
   and relay its outcome line. It writes only when the navigator is missing or stale
   (`already-current` otherwise), so a re-run changes nothing; a `write-refused` (the write) or
   `probe-failed` (the tree could not be read) line names the offending path and STOPs this
   reconcile like any other failed ensure. **Then**, if the stamp **equals** the head → the substrate is
   current (no structure migration is due), and stop after reporting. Report **in the user's
   conversational language**: if step 2's reconcile just **changed something**, say **what changed**
   in plain terms, naming each written file, each removed flat file, the ADR move and the lines after
   a removal. Residuals never mean nothing changed: relay any switch line or its skip, pending-move,
   kept, not-the-kit's or left flat path line (link, directory, unreadable file or failed unlink),
   and ask the hook switch only when the switch line stands, on the report's one chat yes with
   the commit ask; apply it on that yes,
   a no leaving the limit above. If **nothing changed at all**, say their **settings are already
   current — no update is required**. Either way, show **no**
   structure number, stamp filename, or internal versioning vocabulary on this happy-path exit — the
   number is inert here and belongs to *Version disclosure* (below).
3. Show the relevant `${CLAUDE_SKILL_DIR}/CHANGELOG.md` context (entries newer than the stamp).
4. **Collect the migration answers FIRST, then apply.** If `AGENTS.md` is missing BOTH the
   *Communication language* and *Attribution* blocks — i.e. both blocks are missing (a pre-1.1.0
   deployment) — ask the two questions as ONE structured multi-question prompt; record each
   answer individually, write nothing until ALL are answered, and carry the answers into the
   migrations below: a migration whose answer was already collected never re-asks (its own
   "Ask the user" step is the standalone fallback); a single missing block keeps its single ask
   (step 5). Then apply `${CLAUDE_SKILL_DIR}/migrations/<version>-<slug>.md` in **semver order**,
   only those newer than the stamp. Migrations are **idempotent**.
5. Reconcile drift: add any substrate files the project is missing (never a file of
   `references/scripts/`: step 2's script owns those; in delegated mode the composition root's upgrade
   does); **never clobber
   project-authored content** (their `decisions.md`, `known_issues.md`, page specs stay). For a
   pre-1.1.0 deployment with no *Communication language* block, ask + insert
   (`migrations/1.1.0-communication-language.md`); pre-1.2.0 with no *Attribution* block, ask +
   insert defaulting to `off` (`migrations/1.2.0-agent-attribution.md`). (An answer already
   collected by the step-4 batched prompt is carried in — never re-asked here.)
6. **Never regenerate `AGENTS.md`.** An existing `AGENTS.md` is **never regenerated wholesale**:
   memory keeps the kit block between its two `workflow:kit` comment lines and any `workflow:*`
   pair byte for byte. The composition root writes that kit block current on every upgrade, with
   no question and no copy kept; text of your own goes outside the two workflow:kit comment lines;
   a change to a kit rule goes in its theme's file under docs/ai/rules/local/. **Then, before the stamp, re-run the navigator finalizer:** steps 4–6 may have added
   or changed `docs/ai` files, so run
   `node ${CLAUDE_SKILL_DIR}/references/scripts/docs-size/check-docs-size.mjs --ensure-index --root=<target>`
   once more (idempotent — an untouched tree reports `already-current`) and relay its outcome line.
7. **Re-stamp** `docs/ai/.memory-version` to the lineage head (atomic write — mechanics unchanged).
   Report changes **in plain human terms** (which parts of the deployment are now different,
   naming each written file, each removed flat file, the ADR move and the lines after a removal);
   relay step 2's residual lines and ask the hook switch only with its switch line, on the report's
   one chat yes, with the same limits and hand route as step 2;
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
  head** (`5.0.0`, the shared `agent-workflow` lineage) — a **separate axis** from this package's npm
  version (the two may even coincide by accident). They move independently.
- **Memory ships no workflow block and never writes one.** Never author methodology, orchestration
  or autonomy text into `AGENTS.md`; memory's own upgrade keeps the composition root's block byte for
  byte, and the composition root writes it current on every upgrade.
- **The `Co-Authored-By` trailer is added by the harness, not by prose.** When attribution is
  `off` + Claude Code, also set `"includeCoAuthoredBy": false` in `.claude/settings.json`.
- **Hidden mode is project-local, never machine-global.** Memory's hide writes to the repo's
  `.git/info/exclude` (one per-project ignore list), never `core.excludesFile`. `/docs/ai/`
  subsumes `docs/ai/.memory-version` (and any kit-fallback `.workflow-version`) — list neither
  separately. **Never touch `package.json`.** After hiding, verify `git status` shows the
  artifacts as ignored.
- **`CLAUDE.md` is a symlink, not a copy.** `ln -s AGENTS.md CLAUDE.md`.
- **Never overwrite an existing entry point or hook.** Stop and ask to merge vs replace.
- **Enforcement is offered on every project.** See step 8 for the preview, the agent-host
  criterion, and the committer-node residual.
- **The deployed scripts are the substrate's.** An edit in `scripts/agent-workflow/` is
  overwritten by the next upgrade; a customization goes where
  [Reserved names and channels](references/contracts.md#reserved-names-and-channels) says.
- **Never auto-commit.** Report quality-gate results and wait for explicit approval — both modes.

---

## Setup contracts

The three setup choices each have a full contract in
[`references/contracts.md`](references/contracts.md). Defaults: visibility = `visible`; language
= whatever the user is already writing in; attribution = `off`.

---

## References

- [`references/contracts.md`](references/contracts.md) — the three setup contracts in full, and
  the reserved names and channels.
- [`references/templates/`](references/templates/) — stack-agnostic `AGENTS.md`, `agent_rules.md`, the seeded user-editable
  `orchestration.json` + `autonomy.json` configs, the `adr-record.md` ADR authoring reference + the
  seed `adr/log.md` navigator, the `SPEC_TEMPLATE.md` spec authoring reference + the seed
  `specs/index.md` store root, and all `docs/ai/` files to deploy.
- [`references/scripts/`](references/scripts/) — the Node enforcement scripts (caps + staleness +
  index-freshness gate with the counted `specs/` collapse, the import-free spec reader
  `spec-schema.mjs` that defines a well-formed spec, one-file-per-ADR archive, hook installer) and
  their unit tests.
- [`scripts/stamp-takeover.mjs`](scripts/stamp-takeover.mjs) — the upgrade-time lineage state
  machine (`LINEAGE_HEAD`, atomic stamp writes) + tests.
- [`migrations/`](migrations/) — per-version upgrade steps, incl. `legacy-stamp-takeover.md`;
  see `migrations/README.md`.
- [`capability.json`](capability.json) — the `agent-workflow` family manifest.
- [`CHANGELOG.md`](CHANGELOG.md) — version history of this substrate.
