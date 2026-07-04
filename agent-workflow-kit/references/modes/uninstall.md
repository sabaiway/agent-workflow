### Mode: uninstall

The **guarded teardown** — the inverse of `init` (the kit + engine skills) + `setup` (the bridges) + a hidden deploy. **In-agent, opt-in**, and built around one hard rule: **it never deletes user-authored content.** Run **`--dry-run` first, always**, show the user the classified plan in plain language, get explicit consent, then re-run with `--yes`. It **never commits**.

Run `node ${CLAUDE_SKILL_DIR}/tools/uninstall.mjs [<member>] [--dir <project>] [--bindir <path>] [--dry-run | --yes]`:

- `<member>` — limit the skill axis to one member (`agent-workflow-kit` / `-memory` / `-engine` / a bridge); omit for the **whole family**.
- `--dir <project>` — also reverse the **project-deployment** surfaces in `<project>`.
- `--bindir <path>` — where the bridge wrappers were linked (default `~/.local/bin`, mirrors `setup`).
- `--dry-run` — print the plan and change **nothing** (run this first). `--yes` — apply the **auto-removable** set.

It classifies every surface into four classes and acts accordingly:

- **remove** (safe) — an installed skill dir that is **provably ours** (valid manifest, `name`+`kind` match). A dir present but **not provably ours** (`foreign`/`stub`/`invalid`/unreadable) → **STOP**: left untouched **and reported**, while the teardown still removes the members that ARE ours (a not-ours surface is never clobbered, and never blocks removing the rest — the per-item `setup` posture). **Preflight-then-mutate:** if a mutable surface **changed since the dry-run** (a skill no longer ours, a wrapper turned foreign, a hook that lost our marker, a malformed fence), the run **aborts with zero changes**.
- **reverse** (managed-marker) — a bridge **wrapper symlink that points at our source** (a foreign/non-symlink one → STOP); the hidden-mode **managed fence** (via the existing `--unhide` path — only the fenced lines); a **pre-commit hook carrying our marker** (an unmarked / user hook → left + reported).
- **KEEP — never deleted** (report-only) — `docs/ai`, `AGENTS.md`, `CLAUDE.md`, `docs/plans`, and `.claude/settings.json` (the `includeCoAuthoredBy` edit **and** any `permissions.defaultMode`/`permissions.allow` the velocity profile may have seeded). The tool **prints the exact `rm` / `git rm --cached`** for the docs/entry files and an **edit** instruction for `settings.json` (never an `rm` — it may hold your own settings); the **user** runs them. Surface this in plain language; never delete on their behalf.

**Shared globals:** removing `agent-workflow-memory` / `agent-workflow-engine` / a bridge removes a **global** skill that another project on the machine may use — say so before applying. **Windows:** the wrappers are POSIX; the skill-dir + project arms still work, the wrapper arm reports *use WSL*.
