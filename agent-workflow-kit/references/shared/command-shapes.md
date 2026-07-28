### Command shapes — the promptless bar for instructed reads & probes

When a mode doc tells you to read a file or probe state WITHOUT prescribing the exact command (a
recon read, the version-stamp read, any "check X"), the shape is yours — and improvised shapes are
where approval prompts come from. The bar:

- **Reads ride the host's file-read tool** (Read/Grep/Glob, or your agent's equivalent) whenever one
  exists — a file-read tool never fires a shell approval prompt.
- **No file-read tool → ONE plain undecorated command per probe:** no `;`/`&&` compounds, no
  redirects, no pipes, no command substitution — one probe per invocation (the lens’s «plain pipeline
  per call», stricter). A decorated or chained form is outside this contract’s guarantee: behavior is
  host/config-dependent — it may prompt, an opt-in read-lane may auto-approve a vetted compound, and
  command substitution may even slip past a prefix allow rule. The plain single-command shape is the
  only shell fallback that is promptless by construction.
- **Improvised file writes ride the host's file-edit tools** (Write/Edit or equivalent) — never an
  ad-hoc heredoc or shell-redirect write.
- **Searching for TEXT is its own case.** A pattern carrying `>`, `` ` `` or `$(` prompts on a
  seeded-core command however quoted — the guard scans the raw string and a quote-stripped copy.
  Quoting is not a workaround. (`|`/`&&` do not trip it.) Use the host's search tool if it has
  one; else, with the kit tier seeded, `node <kit>/tools/repo-search.mjs --pattern <literal>`,
  switching to `--pattern-file <path>` for a byte-carrying pattern and `--paths-file <path>` for a
  byte-carrying TARGET — written with the file-write tool above, so their bytes never enter the
  command string; else one plain command, taking the prompt. A wrong lane earns an ask naming the
  right lane back to YOU, not just the human. **PATH questions too:** exists / size / lines / listing
  (file text needs `--contents`), any number of paths, is ONE
  `node <kit>/tools/path-inventory.mjs --path <p>` — not a bannered compound. Residual: a bare `grep` still prompts, and the file lanes need
  promptless writes.

**Scope — improvised shapes only.** The commands a mode doc itself prescribes (`node …/tools/…`
dispatch lines, `--apply` lanes, install/symlink steps) are OUTSIDE this contract: run them exactly
as prescribed, as plain single invocations.
