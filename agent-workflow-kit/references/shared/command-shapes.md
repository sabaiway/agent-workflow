### Command shapes — the promptless bar for instructed reads & probes

When a mode doc tells you to read a file or probe project state WITHOUT prescribing the exact
command (a recon read, the version-stamp read, any "check X" instruction), the shape is yours —
and improvised shapes are where approval prompts come from. The bar:

- **Reads ride the host's file-read tool** (Read/Grep/Glob in Claude Code, or your agent's
  equivalent) whenever one exists — a file-read tool never fires a shell approval prompt.
- **No file-read tool → ONE plain undecorated command per probe:** no `;`/`&&` compounds, no
  redirects, no pipes, no command substitution — one probe per invocation. This applies the
  deployed agent-rules lens’s «plain pipeline per call» discipline here as a stricter
  single-command shape. Any decorated or chained form falls outside this contract’s baseline
  guarantee; behavior is then host/config-dependent — it may prompt, an opt-in read-lane may
  auto-approve a vetted compound, and command substitution may even slip past a prefix allow
  rule. The plain single-command shape is the only shell fallback this contract treats as
  promptless by construction.
- **Improvised file writes ride the host's file-edit tools** (Write/Edit or the equivalent) —
  never an ad-hoc heredoc or shell-redirect write.
- **Searching for TEXT is its own case.** A pattern carrying `>`, `` ` `` or `$(` prompts on a
  seeded-core command however it is quoted — the guard scans the raw string and a quote-stripped
  copy. Quoting is not a workaround. (`|`/`&&` do not trip it.) Use the host's search tool if it has
  one; else, where the kit tier is seeded, `node <kit>/tools/repo-search.mjs --pattern <literal>`,
  switching to `--pattern-file <path>` for a byte-carrying pattern — written with the file-write tool
  above, so its bytes never enter the command string; else one plain command, accepting the prompt.
  A wrong lane earns a refusal that NAMES the file lane. Residual: a bare `grep` still prompts, and
  the file lane needs promptless host writes.

**Scope — improvised shapes only.** The executable commands a mode doc itself prescribes (the
`node …/tools/…` dispatch lines, `--apply` lanes, install/symlink steps) are OUTSIDE this
contract: run them exactly as prescribed, as plain single invocations.
