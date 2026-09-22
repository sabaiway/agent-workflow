### Mode: tier

<!-- opt-in-capability: none — an inspection surface that configures nothing -->

Read-only. The tier guide: what an epic, a story and a task are, and where the walk of this project stands. It writes no file, cache, receipt, lock or git state; it never commits and never runs a subscription CLI.

Run `node ${CLAUDE_SKILL_DIR}/tools/tier-guide.mjs --dir <project> --json`.

Render the returned envelope compactly in the user's conversational language. Never paste the JSON. Keep every path and every command verbatim, each command on its own line so it runs as printed; translate only the prose around them.

Keep this order: the tier text (what each level is, the five story sessions, the two templates, the glossary of their keys, the Recommendations pointer); then every rendered state with its reader, file, cause and next command; then per epic its stage, any placeholder left and the accepted check; then each story in hand with its stage, any placeholder left and its ordered actions; then the epic's own ordered actions (for example the check, the close, or the Cleanup a landed story left over). The first action printed is the next step. Several epics or stories each render; never pick one silently.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Anything rendered, every rendered state included. |
| 1 | Nothing rendered: the `--dir` is not a git work tree; the cause is printed on stderr. |
| 2 | Usage: an unknown argument, a `--dir` without a value, or `--help` / `-h` combined with anything. |

**Invariants:** read-only · every printed command runnable as printed from the project root · compact user-language render with paths and commands verbatim · `process.exitCode`, never `process.exit()`.
