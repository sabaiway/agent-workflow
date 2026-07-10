# Migrations

Each upgrade step is one file: `migrations/<version>-<slug>.md`, where `<version>` is the
skill release that introduced the change (matches a `CHANGELOG.md` heading) and `<slug>`
is a short kebab-case name. Empty until the first change that needs migrating — most
releases add files/templates, which `upgrade` reconciles without a migration.

## How `upgrade` applies them

1. Read the project's stamped version from `docs/ai/.memory-version` (the deployment-lineage
   stamp owned by this substrate). On a deployment that has only the legacy `docs/ai/.workflow-version`
   (a kit fallback bootstrap), `legacy-stamp-takeover.md` runs first and copies that value into
   `.memory-version` verbatim — see that migration.
2. Select every migration whose `<version>` is **strictly newer** than the stamp.
3. Apply them in **ascending semver order**.
4. Re-stamp `docs/ai/.memory-version` to the deployment-lineage head (`2.0.0` today — the shared
   lineage sequence, **not** this package's npm version). The legacy `.workflow-version`, if present,
   is never deleted.

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
