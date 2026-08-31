### Mode: control-bytes

<!-- opt-in-capability: none — a read-only gate entry; declaring the gate matrix is covered by gates-declaration -->

Read-only **control-byte gate** over the work tree — it makes *"a raw control byte in a source"* a
mechanical refusal instead of a reviewer's find. Measured 2026-08-30: an editor tool wrote a raw NUL
into a test source, git classed the file as binary, and a NUL-carrying blob is exactly what a
letter-level checker skips by kind. This mode judges BYTES, never letters, so it is language-neutral:
every consumer of the kit can declare it, whatever language the project is written in.

**What it judges.** The review-payload domain over the WORK TREE, from the work-tree root: tracked
paths (`git ls-files -z`) plus untracked-not-ignored paths (`git ls-files --others --exclude-standard
-z`). Three surfaces per path, in this order: the NAME is always judged; a regular file's CONTENT is
judged unless the attribute skip below covers it (the skip covers content only); a symlink's TARGET
string is always judged and the link is never followed. A path's kind is the index mode for a tracked
path (`git ls-files -s -z`; a gitlink is name-only) and the lstat for an untracked one; the descriptor
the read opens must report the same kind, or the path is unreadable. The predicate is over raw bytes:
any byte in 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F or 0x7F refuses; TAB, LF and CR are the only admitted C0
bytes; bytes at or above 0x80 are not judged (UTF-8 validity and C1 controls are not this tool's
business). A finding names the path, the surface, the byte offset and the byte in hex; the render is
injective — bytes decode as UTF-8 where valid, a control or line-separator code point (and a valid
U+FFFD) renders as `\u{XXXX}`, an invalid byte as `\xNN`, a backslash as `\\` — so no output line carries a raw control
byte or U+FFFD and two names differing only in an unrenderable byte render differently.

**Binary by KIND, never by guess.** A path whose git attribute says `binary` or `-diff` has its
CONTENT skipped by kind and is NAMED in the summary (one `git check-attr --stdin -z binary diff`
over the whole domain — git's own answer, global and system attributes files included, because the
tool runs under your env); its name and target are still judged. There is no extension allow-list
and no size heuristic — a NUL in an unattributed file is the finding this gate exists for. A fixture
that genuinely needs a control byte keeps it as an escape in source (`\x00`, `String.fromCharCode(0)`):
the runtime string is byte-identical and the SOURCE stays clean. A never-committable stat class
(device, FIFO, socket) and an untracked nested repository (git's `nested/` entry) are skipped by
kind and counted — name judged, no content surface. On a host that materialises symlinks
(`core.symlinks=false`) a tracked symlink's placeholder file is judged as its target string.

Run `node ${CLAUDE_SKILL_DIR}/tools/control-bytes.mjs [--check] [--cwd <dir>]` (`--cwd` anchors at
that directory's work-tree root):

1. Plain run → the human report: the work-tree root, the counts (paths judged · skipped by attribute,
   each named · skipped by kind · findings), then every finding as one line
   `<path> <surface> offset <n>: 0x<hex>` (`(+N more)` when that surface carries more than one) —
   under the SAME exit table as `--check`: the plain run is never a silent 0.
2. **`--check`** → the gate spelling: the same report (counts, the named attribute skips, the
   finding lines), then the gate exit code. **Exit 0** clean. **Exit 1** on a finding OR on a refusal —
   refusals never pass and never skip silently, each with its own message: an UNREADABLE path
   (EACCES, EIO, a descriptor whose kind disagrees with the named kind — distinct from an ABSENT
   path git named that vanished before the read; a TRACKED absent path with the skip-worktree bit is
   a sparse checkout, skipped by kind and counted); a git command that fails, is killed by a signal or
   is not on PATH; an UNMERGED index; an EMPTY domain; a file over the read cap (16 MiB — read as at
   most cap+1 bytes on the descriptor, never trusting the fstat size, so a file that grows after the
   fstat still refuses; the message names the cap and the path); a git LOCATION that is not a work
   tree. The location is a closed table of six states shared with the fingerprint and index
   consumers through the kit's git-location leaf, judged on the REALPATH identity of the git dir,
   the common dir and the work-tree top under the ambient env against the discovery from cwd with
   every variable whose upper-cased name starts with `GIT_` removed (a case-insensitive host honours
   `git_dir` too): `work-tree` (all three agree) proceeds; `not-a-repository` (git
   itself answers not-a-git-repository, exit 128); `error` (ENOENT, a synchronous throw, a signal, a
   realpath that cannot resolve, any other non-zero or unparsable answer); `redirected` (any of the
   three differs — `GIT_WORK_TREE` at a second tree with the same git dir, or `GIT_COMMON_DIR` at a
   second repository); `no-work-tree` (the git
   dir agrees but `--show-toplevel` fails: bare, or cwd inside `.git`); `env-only` (the ambient env
   reaches a repository the stripped discovery does not) — each refuses by its own state name. A
   pre-commit hook's own env (`GIT_INDEX_FILE`, `GIT_PREFIX`, `GIT_CONFIG_PARAMETERS`,
   `GIT_EXEC_PATH`) agrees and passes: the check is agreement, never a variable ban. **Exit 2**
   usage — every operand is validated at parse; an unknown argument is usage. Every content read is
   descriptor-bound (open, fstat, read on the descriptor), never a path read that a symlink swap
   could redirect.
3. **Wire it as a gate by hand — never without consent (AD-021/D9).** The candidate line for your
   own `docs/ai/gates.json`: `{ "id": "control-bytes", "title": "No raw control byte in the work
   tree", "cmd": "node \"<path-to-this-skill>/tools/control-bytes.mjs\" --check" }` — with the path
   your project actually reaches the kit by, double-quoted inside the JSON string so a path with
   spaces survives, executable from the project root. `gates-init` does not offer this entry; the full consent-fill contract for the
   matrix is in `${CLAUDE_SKILL_DIR}/references/modes/gates.md`. Once declared, the opt-in
   `${CLAUDE_SKILL_DIR}/references/modes/hook.md` auto-approves it like any other declared gate.

**Honest bounds (stated, accepted):** the work tree is judged at the moment of the read — a byte
written after the run is caught on the next run, which is why the gate belongs in the pre-commit
matrix; the attribute is the only "binary" signal, so a binary file with no attribute refuses until
the project declares it; the tool reports and never edits — the remedy is the escape in source; a
checkout PATH that is itself not valid UTF-8 is unreachable by any Node consumer (cwd is a string
before git ever answers) and a non-UTF-8 LINKED git dir or common dir path refuses as `error` — a
stated bound, not a case this tool judges; `O_NOFOLLOW` guards the
LEAF only — a parent directory swapped for a symlink between git's answer and the open redirects the
read (Node exposes no `openat2`/component-wise no-follow walk), so a mid-run parent swap is the same
moment-of-the-read race bound as a byte written after the run: caught on the next run, inside the
work tree the gate's verdict still refuses-or-reports, never silently skips.

**Invariants:** read-only · never writes · never commits · spawns read-only `git` queries only
(`ls-files`, `check-attr`, `config --get core.symlinks`, `rev-parse`) · judges bytes, never decoded text · skips by kind only, every
skip named or counted · exit 0 clean / 1 finding or refusal / 2 usage · `main(argv, deps)` returns,
never exits.
