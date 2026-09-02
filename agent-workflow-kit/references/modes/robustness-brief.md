### Mode: robustness-brief

<!-- opt-in-capability: none — a read-only generator over a plan file and the kit's own list -->

Read-only **executor-brief generator** — it turns a ledger row's `robust:<class>[,<class>]` tag into
the block of concrete robustness literals the executor must prove BEFORE the first line of code.
Measured 2026-08-30: a diff correct to its contract took 13 review rounds, each finding one more
standard invariant (a git location variable, a sequencer ref, `%B`'s newline, `textconv`, fsync, a
no-process spawn error) that nobody had written into the brief. The list is data
(`${CLAUDE_SKILL_DIR}/references/robustness-literals.json`, versioned, language-neutral); this mode
renders it, so a retro extends the list instead of a reviewer re-finding a member.

**What it reads.** The plan file named by `--plan`, opened as a regular file no-follow through the
kit's capped descriptor read (1 MiB — a plan is capped at 100 lines) with its realpath required
under the realpath of the cwd (the project root the advisor renders the command from; no git is
asked): an absolute path outside, a `..` traversal out of it, a symlink leading out, a non-regular file and
an over-cap plan each refuse **exit 2** by name — the generator PRINTS row text, so unlike
plan-shape-cli's unbounded no-follow read it is bounded. The plan is judged on every rule of plan-shape's structural half (headings, section caps,
row grammar, ids, bytes, lexical containment, sweep form, duplicate paths, the total line, the
acceptance and governing-spec presence rules) over EMPTY facts (`{}` — never undefined); the
facts-bound half — realpath containment and sweep expansion — stays `plan-shape --check`'s. A plan
that fails the structural half is refused, never half-rendered. And the kit's own list through its
reader leaf (a list that fails the closed schema is refused by name; the tag grammar is that leaf's
`parseRobustTag`, ONE home). Nothing else: no git, no project config, no network.

Run `node ${CLAUDE_SKILL_DIR}/tools/robustness-brief.mjs --plan <plan> [--row <id>] [--coverage]`:

1. Plain run → the Markdown block, ready to paste into the dispatch brief: a header naming the list
   version and the plan path; then, for every tagged row, its id and path, and per tagged class the
   class's `prove` sentence followed by its members as `literal — note (source)`. Every
   plan-derived path — the header's and each row's — is rendered through the kit's string display
   escape (`escapeForDisplay`), so no output line carries a raw control byte, U+2028 or U+2029; a
   U+FFFD passes as the printable replacement character (stated, not escaped). The brief is built
   whole before a byte is printed — never a partial brief. **Exit 0.** A plan with no `robust:`
   token prints ONE stated line and still exits 0 — an untagged ledger is a fact about the plan, not
   a failure of the tool. A row whose tag the grammar refuses (`no-class`, `empty-class`,
   `duplicate-class`, `invalid-class`, `multiple-tags`) or names an unknown class id is **exit 1**
   naming the row — never a zero-tags success.
2. **`--row <id>`** → the block for that one row (the slice brief of a subagent or a delegated
   dispatch). **Exit 1** when the row is absent from the ledger or carries no tag, so a brief can
   never be assembled from a row that names nothing to prove.
3. **Exit 1** also when the plan fails the structural half (the refusal lines are printed first);
   **exit 2** usage — every operand is validated at parse: an unknown argument, an uncontained or
   over-cap `--plan` (above), a malformed-UTF-8 plan (`malformed-utf8` — a genuine U+FFFD passes)
   and a list the reader refuses by name (the tool's own installation, the plan-shape-facts precedent) are usage.
4. Where it belongs (procedures.md `plan-execution` step 2): the dispatch brief — delegated or
   subagent — carries the generated block for every tagged row; the procedures advisor renders the
   populated command in the plan-execution render. Tag a row by writing `robust:<class>` in its
   responsibility sentence; `plan-shape --check` refuses a class id the list does not carry
   (`robust-class`) and leaves an untagged row unjudged.
5. **`--coverage`** judges every valid `create`/`modify` row except `.md`/`.txt` documents and the shipped list itself. A class is PRESENT when the row file's bytes carry a bounded member token of kind env/flag/ref/syscall/errno/argv; `state` is never searched, `uncovered = present − tagged`, delete and absent rows are listed, and sweep rows union every path expanded by `plan-shape-facts`' one glob compiler. Reads use the same 1 MiB capped no-follow primitive. The table exits `0` when covered, `1` with each `row:class:literal` when uncovered, and `2` on a named row-read refusal. Bootstrap: for rows up to the row that lands this mode, apply the rule by hand; thereafter run coverage before every dispatch and before `flow-writer adoption`.

**Honest bounds (stated, accepted):** the tag is the author's claim — the tool cannot know that an
untagged row touches git, the reviewer still can; the list names classes and carries only MEASURED
members, so a fact of someone else's runtime that nobody has measured yet is not in it until a retro
adds it with its `source`; `source` is provenance of the measurement, not a path an installed kit
opens; a class with only `state` members is blind and can never be PRESENT. The block informs the
brief and never judges a diff — the hostile harness and the diff review stay the last line.

**Invariants:** read-only · never writes · never commits · spawns nothing · the plain run reads the plan file and the kit list; `--coverage` additionally reads every judged row file through the capped no-follow read and the repository's regular-file listing for sweep expansion — nothing else, still no git, no spawn and no write · exit 0 printed / 1 refused / 2 usage ·
`main(argv, deps)` returns, never exits.
