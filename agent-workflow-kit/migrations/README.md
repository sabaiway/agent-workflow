# Migrations

Each upgrade step is one file: `migrations/<version>-<slug>.md`, where `<version>` is the
deployment-lineage step the note moves a project to (not a skill release) and `<slug>`
is a short kebab-case name. Empty until the first change that needs migrating — most
releases add files/templates, which `upgrade` reconciles without a migration.

## How `upgrade` applies them

1. Read the project's stamped version from `docs/ai/.workflow-version`.
2. Run `node ${CLAUDE_SKILL_DIR}/tools/migration-notes.mjs --cwd <project>` as the sole selector.
   It lists every migration whose `<version>` is **strictly newer** than the stamp and not newer than the head.
   Each line is `note <version> <path> :: <headline>`, with an absolute `<path>` under the running kit.
   The headline is the note's first `# ` line, with that prefix removed and surrounding whitespace trimmed.
   The upgrade must relay those stdout lines verbatim and apply exactly the listed notes.
   A named refusal stops the upgrade, except `stamp-absent`, which routes it back to the upgrade's step 1.
3. Apply them in the order the tool listed them (**ascending semver order**).
4. Re-stamp `docs/ai/.workflow-version` to the **deployment-lineage head** (`4.0.0` today — the
   shared lineage, **not** this skill's npm package version). A stamp greater than the head → STOP.

## Authoring rules

- **Idempotent** — safe to re-run; check before mutating (e.g. "if the file already has X, skip").
- **Non-destructive** — never clobber project-authored content (their `decisions.md`, `known_issues.md`, page specs). Add/rename/restructure only what the kernel owns.
- **Self-contained** — exact paths + commands, readable cold, like a mini-plan.
- **Mention rollback** — note how to undo if the step is risky.
- **Template blocks** — a note never pastes entry-point block text; `tools/migration-blocks.mjs` places it from the kit's template.

## Template

```markdown
# Migration <version>-<slug>

**From:** versions < <version>   **To:** <version>

## Why
<what changed in the kernel and why a project needs to follow>

## Steps
1. <exact, idempotent action with paths/commands>
2. ...

## Verification
<how to confirm the project is now consistent — e.g. docs cap-validator green>

## Rollback
<how to undo, or "n/a — additive only">
```
