# Migrations

Each upgrade step is one file: `migrations/<version>-<slug>.md`, where `<version>` is the
skill release that introduced the change (matches a `CHANGELOG.md` heading) and `<slug>`
is a short kebab-case name. Empty until the first change that needs migrating — most
releases add files/templates, which `upgrade` reconciles without a migration.

## How `upgrade` applies them

1. Read the project's stamped version from `docs/ai/.workflow-version`.
2. Select every migration whose `<version>` is **strictly newer** than the stamp.
3. Apply them in **ascending semver order**.
4. Re-stamp `docs/ai/.workflow-version` to the **deployment-lineage head** (`1.3.0` today — the
   shared lineage, **not** this skill's package version `1.4.0`). A stamp greater than the head → STOP.

## Authoring rules

- **Idempotent** — safe to re-run; check before mutating (e.g. "if the file already has X, skip").
- **Non-destructive** — never clobber project-authored content (their `decisions.md`, `known_issues.md`, page specs). Add/rename/restructure only what the kernel owns.
- **Self-contained** — exact paths + commands, readable cold, like a mini-plan.
- **Mention rollback** — note how to undo if the step is risky.

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
