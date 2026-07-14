### Mode: setup

The **only writer** among the backend modes, and **opt-in / in-agent only** — **placement** is **never** part of `init`. The npx installer deploys the *kit* and bundles the bridge skills in its tarball, but **does not place** them (that honesty claim is load-bearing — see `decisions.md` AD-009 / AD-011); **once placed** by `setup`, `init` and `${CLAUDE_SKILL_DIR}/references/modes/upgrade.md` keep the placed copy fresh via the refresh-only `--refresh-placed` (below) — **never a first placement, never a downgrade**. `setup` owns exactly the two deterministic, secret-free steps and **guides** the rest. It **never commits and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/setup-backends.mjs [<backend>] [--bindir <path>] [--dry-run]`:

- `<backend>` — `codex` | `agy` | `antigravity` | `codex-cli-bridge` | `antigravity-cli-bridge`; omit for **all**.
- `--bindir <path>` — where to link the wrappers (default `~/.local/bin`).
- `--dry-run` — print the per-backend plan and change **nothing** (run this first).
- `--refresh-placed` — the **refresh-only** mode (what `init` runs automatically and `${CLAUDE_SKILL_DIR}/references/modes/upgrade.md`
  runs as its fourth stamp-independent reconcile): refresh every bridge `setup` **already placed**
  from the kit's bundled copies + re-link its wrappers; an absent bridge is a stated skip (**never**
  placed), a placed bridge newer than the bundle is a stated skip naming the kit update (**never**
  downgraded), and every outcome line is composed by the tool — paste verbatim. When the skills dir
  is **read-only this session** and the placed bridge is already at the bundled version, the
  equal-version re-sync it would run cannot write: that outcome is `skipped-readonly` — a **stated
  skip** (exit 0, not a failure) naming the current version, the skipped/incomplete re-sync, and the
  read-only cause; it never claims a re-sync ran, and any local drift persists until a writable rerun.
  (A version-**behind** refresh blocked by the same read-only dir stays a loud `could not refresh`,
  its recovery pointing at a writable rerun.) Does not combine with `--dry-run`.
- `--help`, `-h` — usage.

For each backend it:
1. **Places / refreshes the bundled bridge skill** (from the kit's `bridges/<name>/` mirror) into its canonical dir — but only when that dir is **absent / empty / proven-managed** (valid manifest, matching `name`+`kind`). A `stub` / `foreign` / `invalid` / `unsupported` dir, a marker fs-error, or a symlinked dir → **STOP**, never overwritten. Refresh re-runs on a proven-managed dir so re-running `setup` delivers bundled fixes.
2. **Links its wrappers** (`codex-exec` / `codex-review`; `agy-review` / `agy-run`) onto `--bindir` via **managed symlinks** — replacing only a symlink that already points at our source. A non-symlink or a foreign symlink → **STOP**; it **preflights every target first**, so a conflict on one wrapper makes **zero** changes. If `--bindir` is not on `PATH`, it prints the one-line `export PATH=…` to add — it never edits a shell rc.
3. **Guides the manual, secret-bearing steps it will NOT automate** — the binary install (each bridge's `setup/README.md` §1) and the one-time interactive subscription login (`codex login` / `agy`) — printing the exact command for whichever axis is still missing (axis-aware: it can ask for both the CLI and the login at once).

**Close-the-loop output (surface both, localized).** The tool prints, after the per-backend report:
- a **bridge version** on each skill line — `(vX)` for a fresh place / equal refresh, `(vOld → vNew)` when a refresh bumps the bridge (never `vnull → …`);
- a **status pointer** — the full family + deployment version view lives in `/agent-workflow-kit status`;
- a **proactive recipe offer** when a setup just made a review backend ready (re-detected AFTER apply, so it reflects the real new state): it prints `/agent-workflow-kit set-recipe --set plan-authoring.review=<depth>` **and** `…plan-execution.review=<depth>` (Council when both are ready, else Reviewed). Relay it in plain language: offer to set the review recipe for **both** planning and execution review (preview first; you'll write it via `${CLAUDE_SKILL_DIR}/references/modes/set-recipe.md`, or they can hand-edit) — never offer only `plan-execution`. Ask if the scope is unclear.

**Windows:** the wrappers are POSIX `.sh`; on `win32` it reports *unsupported — use WSL* and mutates nothing.

**Exit codes:** `0` = done / already set up / only manual steps remain (guidance is never a failure); **non-zero** = a STOP (a dir/symlink it refuses to clobber), a bad argument, a missing bundle, or a native fs error (the underlying reason is preserved in the message).
