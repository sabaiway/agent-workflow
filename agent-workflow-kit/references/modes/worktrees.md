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

**Provision record (`docs/plans/handoff-<slug>.md`, `## Provision record` — tool-owned):** identity
(`slug`, `branch`, `include`, `node_modules`, `vscode-settings`, and after a prepare `prepared-tree`)
PLUS the three facts a fresh satellite session cannot derive from its own checkout:

- `shared-queue` — the ABSOLUTE path to MAIN's `docs/plans/queue.md`, followed by the rule the record states verbatim: the series index is SHARED and lives ONLY in main: read it at the absolute path above, and never copy it into this worktree, because docs/plans is git-ignored and machine-local, so a copy silently diverges from what main and every other worktree are writing. This worktree never WRITES that file: reaching outside it is an fs_outside_repo action the autonomy policy denies by default. Put new findings in THIS handoff record instead — it is the channel that survives the landing, and main appends them to the index from here. Provision never seeds a copy: the queue is deliberately absent from the satellite, and the absolute path is the only pointer — `--include` refuses to copy the index (or any directory containing it) into the worktree.
- `landing` — landing runs FROM MAIN, never from this worktree, with the runnable
  `… land <slug> --prepare` command already `cd`-ing back to main.
- `install` — the install posture the tool resolved for THIS worktree: the runnable
  isolated-install command when the package manager is unambiguous, the honest install-by-hand
  advice when it is not, and — when the provisioned `node_modules` is a SYMLINK into main — the
  unlink-first form, because a plain install through the symlink writes into MAIN and is never
  presented as isolated. When the WORKTREE'S OWN LIVE CHECKOUT is provably dependency-free (its `package.json` declares no dependencies, no `workspaces` field of any shape, no install-lifecycle script, no native-addon manifest, no external workspace manifest beside it — the evidence is what an install run in the satellite would actually read: exactly HEAD at provision time, the satellite's own committed state on `--resume`, never MAIN's mutable working tree) the record and the default-lane report both state `no install needed — the project declares no dependencies` and print no install command. A workspace tree is NEVER provably install-free — a workspace install materializes member links and `.bin` shims even with zero dependencies — and anything else the tool cannot enumerate (an absent or unparseable `package.json`, a malformed dependency or scripts field, an install-lifecycle script — dependency-free is not install-free) leaves the posture UNKNOWN and keeps the existing advice: a false "nothing to install" is worse than a redundant hint. `--install` remains an EXPLICIT request and is always answered with the
  isolated-install command.

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
ephemeral by design; durable content belongs in the handoff before landing — the handoff carries a
free-form session-records digest slot (every section outside `## Provision record` is user-owned
and byte-preserved by the tool).

**Ownership:** MAIN owns MAIN-tree files, commits, pushes, releases, the gate matrix, every
docs/ai record, `docs/plans/queue.md` (the satellite READS it at the absolute main path and never
writes it — its findings ride the handoff and main appends them; see **Provision record** above),
and all shared git state — stash, hooks, repo config,
`.git/info/exclude`, and every ref except the satellite's configured branch. The SATELLITE owns
that one branch (`aw/<slug>` or the `--branch` override), its feature edits, its seeded plan, and
the user-owned handoff sections; `## Provision record` remains tool-owned. Satellite forbidden
verbs (the v1 docs-only bar): no `git commit`/`push`/`tag`/`git stash`/history rewrite — the ONE
legal rewrite is the tool-printed `git reset --hard` recovery of the satellite's OWN configured
branch (`aw/<slug>` or the `--branch` override) — no kit lifecycle writers
(`init`/`upgrade`/`setup`/`hide-footprint`/`install-git-hooks`/`sandbox-masks`/`ack-write`), no
queue.md writes and no LOCAL queue.md copy — findings go into the handoff record, which main folds
into the index at landing, no version bumps or publishes, no edits to MAIN's files from the satellite
session — divergence and the landed verification enforce the observable half; the rest is the
stated contract. A symlinked `node_modules` under npm workspaces resolves
workspace self-links to MAIN-tree sources — use the printed isolated install when that matters.

**Other harnesses:** PROVEN — the host-installed codex/agy review wrappers run with a provisioned
worktree as their cwd; the footprint carries the root `AGENTS.md` required by the codex wrappers
and available to agy as its fallback project context. The host-level `bridge-settings.conf` under
`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/` is per-host, shared by every worktree, and is not
copied into the worktree. ASSUMED until probed per harness — each target harness's project-local
settings and context pickup in a fresh worktree session; treat that as unverified until the target
harness demonstrates it.
