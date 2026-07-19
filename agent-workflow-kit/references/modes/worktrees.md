### Mode: worktrees

Parallel feature worktrees (v1) — several features implemented simultaneously in DIFFERENT agent
sessions on one machine/repo, zero interference on working-tree files (the ONE exception: the
default `node_modules` symlink is a shared MUTABLE dependency cache — see below), unambiguous
ownership. One thin tool over git; every verification datum is recomputed live from git, never
read from stored metadata.
The ONE stored-metadata exception is the PREPARED OID recorded in the handoff: land and cleanup read it back only for recovery.

**Run** — `node ${CLAUDE_SKILL_DIR}/tools/worktrees.mjs <subcommand> …`:

Git ≥ 2.36 is required for NUL-terminated worktree porcelain; an older Git fails closed with its
own verbatim error through the existing Git-error surface.

- `provision <slug> --plan <path> [--as <name>.md] [--dir <path>] [--branch <name>] [--include <path>]... [--install] [--resume]`
  — create a feature worktree (default: the visible sibling `<repoParent>/<repoName>--<slug>`,
  branch `aw/<slug>`) and populate it: the registry-derived footprint copy-if-missing (a tracked
  file is NEVER overwritten), EXACTLY ONE seeded feature plan, the `handoff-<slug>.md` stub
  (written at provision — the tool's own record; `list` and `cleanup` read it), a
  `node_modules` symlink when main has one and the link stays ignored — a SHARED MUTABLE cache:
  writes through it hit MAIN's node_modules; for isolation RUN the printed isolated-install
  command (`--install` only prints it), and on `--resume` an existing symlink is kept — run the
  printed unlink-first recovery first. Absolute root-pinned gate commands are rebased on UNTRACKED copies only — and only
  while their bytes still equal the MAIN source (or its rebased form); user-modified copies stay
  byte-untouched. `--install` only PRINTS the install command — zero spawn, zero write.
  `--resume <slug>` completes a half-done provision (identity fail-closed; handoff user sections,
  the seeded plan, and edited copies are preserved byte-exact; the provision-record section is
  refreshed atomically; copy-if-missing everywhere).
  Resume identity also binds the EXISTING handoff: at most one `handoff-<slug>.md` may exist and
  its recorded slug AND branch must match the live invocation — a second handoff, a name/record
  mismatch, or a handoff that is not a regular file is a typed STOP before anything is written
  (the writability probe itself runs only after these checks on a resume). The provision record
  is read from exactly one REQUIRED `## Provision record` section (a decoy field elsewhere cannot
  hijack identity); a missing or repeated section, or a duplicated single-valued field, is a typed
  STOP, never last-wins.
- `list` — read-only: every worktree of this repo with slug (from the handoff file; none →
  "unknown (foreign)"), path, branch, base OID (the worktree HEAD — under the v1 no-commit bar
  that IS the provision base; a manual satellite commit moves it, and land derives its own base
  live), dirty flag, handoff presence, opener suggestion. Honest read errors: only a genuinely
  ABSENT docs/plans under a symlink-free, present worktree dir reads as `handoff: no`; a
  symlinked docs/plans (or ancestor), a handoff-named entry that is not a regular file, a
  vanished worktree dir, or any other read failure renders `handoff: (unreadable)` — never a
  silent "no".
- `land <slug> --prepare` — stage the satellite's finished diff onto a CLEAN main; the commit is
  NEVER run by the tool — it stays a dialogue ask at the primary session. Land takes the transient
  common-git-dir lock, refuses a dirty main, graph divergence, visible `docs/ai` drift, excluded
  staged paths, unstaged/untracked leftovers, an empty diff, or a red satellite review-state. The
  complete satellite working-tree diff versus its base is inspected (staged and unstaged); every
  unstaged/untracked path is listed and refused, so an accepted transfer cannot silently omit it.
  The binary/no-ext-diff/no-textconv transfer excludes exactly `docs/ai` and `docs/plans`, applies
  into the index, optionally runs the porcelain-visible sync adapter, then runs the main gate
  matrix. It reports main HEAD, TRANSFER, PREPARED, and sync delta OIDs/data; the primary re-attests
  that prepared tree and confirms main HEAD still equals the printed OID before the commit ask.
- `cleanup <slug> [--branch <name>] [--abandon]` — take the same transient lock and remove a LANDED
  worktree fail-closed after live landed-verification against main HEAD. Verification uses exactly
  the land exclusions (`docs/ai`, `docs/plans`), then checks untracked and ignored content before a
  plain worktree remove, branch `-d`, and prune. Provision-derived ignored containers are ephemeral;
  `node_modules` of any kind is provision-derivable because provision explicitly advises installs.
  Foreign content stops cleanup. `--abandon` is the ONE destructive arm: it DESTROYS unlanded work,
  requires the handoff identity, and is the only path where `--force` may appear.

**Honesty:** there is NO preview step on the writers — over-warned by design. The tool never
commits, never pushes, never runs a subscription CLI. Every content read and regular-file copy
goes through its one no-follow descriptor door (identity-bound source, exclusive destination,
descriptor mode update), and tripwire tests keep them the only paths.

**Settings:** the parent dir for new worktrees is the `docs/ai/worktrees.json` `{"parentDir": …}`
project setting (hand-editable strict JSON; absent file → the sibling default; malformed → a
typed STOP, never a guess). The file must be a REGULAR, non-symlink file reached through a
symlink-free path — anything else is a typed STOP (the advisor renders the same shape as a
stated skip), and the ancestor chain is verified even when the leaf is ABSENT (a symlinked
`docs/` or `docs/ai` never reads as plain absence). `--dir` overrides per invocation.

**Host-specific consent (zero-prompt only where the host honors it):** every sibling-dir mutation
runs a REAL create+delete writability probe first. An unwritable parent prints both the
settings-native line (`sandbox.filesystem.allowWrite` in `.claude/settings.json`) and the full
terminal command. On a settings-native host that honors the key, adding the parent can make later
provision/cleanup promptless. On a harness-managed host that ignores project settings, grant the
narrow parent through the host/session controls; if that is unavailable, use the printed terminal
command for each operation. The `recommendations` mode surfaces this lane but treats write access
as unverified without a trusted host-capability signal.

**Landing flow:** provision → work → handoff → land → re-attest → commit → cleanup. Satellite
commits are outside v1: graph divergence stops land and prints cherry-pick/rebase recovery. A gate
failure keeps the prepared main tree and names both recovery lanes. A second prepare is reset-only:
the STOP prints the current staged write-tree, compares it with the PREPARED OID recorded in the
handoff, distinguishes a converged re-run from foreign staged work, and lists removal commands for
untracked crash residue before the reset-and-re-run lane. A killed process may leave
`aw-prepare-lock`; after confirming no land/cleanup process owns it, remove that directory by hand.

The optional `scripts/sync-mirrors.mjs` adapter runs as a child. Its contract is porcelain-visible
output: tracked modifications/deletions or untracked-not-ignored creations. Ignored writes and
changes inside an already-untracked file are outside observation and therefore out of contract.
Cleanup reports EBUSY as likely lingering processes/open file descriptors (including a sandbox
mount); close them and retry, outside the sandbox when needed. Hidden satellite `docs/ai` state is
ephemeral by design; durable content belongs in the handoff before landing.
