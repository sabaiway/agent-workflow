### Mode: migrate-adr-store

<!-- opt-in-capability: adr-store-migration -->

The **guarded ADR-store migration** — a one-time, opt-in move of an existing project's `docs/ai` from the retired 3-tier ADR cascade (HOT `decisions.md` → the WARM/COLD `decisions-archive*.md` monoliths) to the durable **one-file-per-ADR store** (HOT `decisions.md` + `docs/ai/adr/AD-NNN-slug.md` records + the `docs/ai/adr/log.md` navigator). **In-agent, opt-in**, and reached ONLY here: a normal `upgrade` never installs the new-scheme rotator into an un-migrated project — the new rotator arrives ONLY through this mode, which migrates in the same step (AD-051). Run **`--dry-run` first, always**, show the user the plan in plain language, get explicit consent, then re-run with `--apply`. It **never commits**.

When to run it: `status` (or `upgrade`) reports an *old ADR layout*. That covers **two** shapes, and the remedy is the same for both — (1) a `decisions-archive*.md` monolith is still on disk, and (2) **no monolith was ever produced**: the project's deployed `scripts/archive-decisions.mjs` simply predates the store, so its own gate reports the retired three-tier world as healthy and would never mention the store. The second shape is detected by that deployed script's own provenance — never by "has `decisions.md`, lacks `adr/`", which would falsely accuse a project whose NEW rotator already reds its gate with an actionable fix, and every project that runs no Node. A project already on the one-file-per-ADR store with a fresh navigator — or a fresh deployment seeded with it — needs nothing here (the mode is a stated no-op).

On the no-monolith shape `--apply` does the same work minus the explosion: snapshot → refresh the deployed enforcement scripts → **seed** the store (`docs/ai/adr/` + the navigator + a regenerated `docs/ai/index.md`) → verify. It is **re-runnable to completion from any interruption**: a store directory alone never counts as finished (the navigator must exist and the project's own `--check` must pass), the whole script refresh is re-planned on every run with the rotation script written last, and a failed index regeneration fails the run **closed** rather than reporting success.

Run `node ${CLAUDE_SKILL_DIR}/tools/migrate-adr-store.mjs [--dry-run | --apply] [--cwd <project>]`:

- **`--dry-run`** (default) — prints the plan and writes NOTHING: the monoliths to be exploded + retired, the pre-migration snapshot location, which deployed enforcement scripts will be refreshed (naming any that differ locally), and the rotator's conservation proof (every archived ADR accounted for).
- **`--apply`** — performs it in order: (1) write a durable pre-migration **snapshot** (`decisions.md` + both monoliths + the pre-refresh `scripts/` copies) to the project's git dir (uncommittable), with a stated out-of-tree fallback off git — fail loud if neither base is writable; (2) **force-refresh** the deployed enforcement scripts (the directional subset — only kit-canon basenames the project already has) so the project's own gates run the new rotator + collapse rule; (3) run the conservation-checked **rotation** that explodes the monoliths into `adr/` records, retires them, and regenerates the navigator + `docs/ai/index.md`. Idempotent / crash-resumable.

After a successful `--apply`, run the normal **`upgrade`** immediately — **before any
review/commit ask** — so the deployment-lineage stamp advances to the current head (this mode
**never writes stamps**); then review the migrated `docs/ai/` tree and the re-stamp together and
commit them yourself in ONE gated commit.

**Invariants:** guarded (mandatory `--dry-run` preview → explicit consent → `--apply`) · a durable pre-delete snapshot is written before any remove/overwrite (a locally-edited script is snapshotted, never silently clobbered) · the remove is gated on conservation passing AND the snapshot existing · a project with no old-layout monolith is a stated no-op · **never commits**.
