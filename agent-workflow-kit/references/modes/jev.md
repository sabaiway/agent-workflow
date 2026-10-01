### Mode: jev

<!-- opt-in-capability: jev-connect -->

Read-only. The Jev guide: what Jev (TypeSafe) is, why it pays in this workflow, what it is not, the three steps to a first request and three prompts where it pays. The guide writes no file, opens no connection, never prints the key's value and never commits.

Run `node ${CLAUDE_SKILL_DIR}/tools/jev-guide.mjs --dir <project> --json`.

Render the returned envelope compactly in the user's conversational language. Never paste the JSON. Keep every path and every command verbatim, each command on its own line so it runs as printed; translate only the prose around them. Keep every vendor-quoted text verbatim and in quotes, never translated or reflowed: the not-a-replacement sentence, the curl line, the response, the three field meanings and the four error meanings.

Walk the steps with the user in order, one at a time; move on when the step's check passes or the user skips it. STEP 1: the user runs the key line in a terminal of their own, never the agent. STEP 2: the user runs the install lines — they change the agent's own configuration outside the project. STEP 3: run the curl line only on the user's explicit yes in the chat — it is a network call that sends the sample text to api.typesafe.ai — and never with `-v`, `--trace` or any flag that prints request headers; under an OS sandbox the host must be reachable, and a blocked host is named by the sandbox: the user allows it or runs the line in their own terminal.

Keep this order: the fixed text (WHAT, WHY HERE, NOT, SOURCES); then the three steps — the key with its line or its editor sentence and its mark, the vendor skill with its install lines and its mark, the first request with its curl line and its check; then the three prompts where it pays.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Rendered, or `--help` / `-h` as the whole invocation. |
| 1 | Nothing rendered: a stat of the `--dir` does not report a directory; the cause is printed on stderr. |
| 2 | Usage: an unknown argument, a `--dir` without a value, or `--help` / `-h` combined with anything. |

**Invariants:** the guide is read-only and opens no connection · the agent runs STEP 3's curl line only on the user's explicit yes · the key's value never printed · compact user-language render with paths, commands and vendor quotes verbatim · process.exitCode, never process.exit().
