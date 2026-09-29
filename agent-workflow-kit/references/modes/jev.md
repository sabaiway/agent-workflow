### Mode: jev

<!-- opt-in-capability: none — a read-only guide that configures nothing and calls no service -->

Read-only. The Jev guide: what Jev (TypeSafe) is, why it pays in this workflow, what it is not, the three steps to a first request and three prompts where it pays. It writes no file, opens no connection, never prints the key's value and never commits.

Run `node ${CLAUDE_SKILL_DIR}/tools/jev-guide.mjs --dir <project> --json`.

Render the returned envelope compactly in the user's conversational language. Never paste the JSON. Keep every path and every command verbatim, each command on its own line so it runs as printed; translate only the prose around them. Keep every vendor-quoted text verbatim and in quotes, never translated or reflowed: the not-a-replacement sentence, the request, the response, the three field meanings and the four error meanings.

Keep this order: the fixed text (WHAT, WHY HERE, NOT, SOURCES); then the three steps — the vendor skill with its install lines and its mark, the key with its mark, the first use; then the three prompts where it pays.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Rendered, or `--help` / `-h` as the whole invocation. |
| 1 | Nothing rendered: a stat of the `--dir` does not report a directory; the cause is printed on stderr. |
| 2 | Usage: an unknown argument, a `--dir` without a value, or `--help` / `-h` combined with anything. |

**Invariants:** read-only · no network · the key's value never printed · compact user-language render with paths, commands and vendor quotes verbatim · `process.exitCode`, never `process.exit()`.
