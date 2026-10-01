### Mode: jev

<!-- opt-in-capability: jev-connect -->

Read-only. The Jev guide: what Jev (TypeSafe) is, why it pays in this workflow, what it is not, the two steps to a connected key and three prompts where it pays. The guide writes no file, opens no connection, never prints the key's value and never commits.

Run `node ${CLAUDE_SKILL_DIR}/tools/jev-guide.mjs --dir <project> --json`.

Render the returned envelope compactly in the user's conversational language. Never paste the JSON. Keep every path and every command verbatim, each command on its own line so it runs as printed; translate only the prose around them. Keep the one vendor-quoted text verbatim and in quotes, never translated or reflowed: the not-a-replacement sentence.

The connect line is the user's: hand it over as printed and never run it — the command refuses without a terminal, and a terminal is not consent. The install lines are the user's too: they change the agent's own configuration outside the project. No command the guide prints is run by the agent.

Keep this order: the fixed text (WHAT, WHY HERE, NOT, SOURCES); then the two steps — the key with its connect line and its mark, the vendor skill with its install lines, its mark and its first prompt; then the three prompts where it pays.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Rendered, or `--help` / `-h` as the whole invocation. |
| 1 | Nothing rendered: a stat of the `--dir` does not report a directory; the cause is printed on stderr. |
| 2 | Usage: an unknown argument, a `--dir` without a value, or `--help` / `-h` combined with anything. |

**Invariants:** the guide is read-only and opens no connection · the connect line is run by the user in a terminal of their own, never by the agent · the key's value never printed · compact user-language render with paths, commands and vendor quotes verbatim · process.exitCode, never process.exit().
