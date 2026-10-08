### Mode: jev

<!-- opt-in-capability: jev-connect -->
<!-- opt-in-capability: jev-skill -->

Read-only. The Jev guide: what Jev (TypeSafe) is, why it pays in this workflow, what it is not, the two steps — a set key and the vendor skill installed by the kit, pinned — and three prompts where it pays. The guide writes no file, opens no connection, never prints the key's value and never commits.

Run `node ${CLAUDE_SKILL_DIR}/tools/jev-guide.mjs --dir <project> --json`.

Render the returned envelope compactly in the user's conversational language. Never paste the JSON. Keep every path and every command verbatim, each command on its own line so it runs as printed; translate only the prose around them. Keep the one vendor-quoted text verbatim and in quotes, never translated or reflowed: the not-a-replacement sentence. The `Run it in <place>:` line, when the guide printed one, stays directly before the connect line and is never folded into it; the restart step is relayed whole.

The connect line is the user's own step — hand it over as printed; it asks for the key in their terminal, so the key never reaches the agent or the chat; the connect command refuses without a terminal, and a terminal is not consent. The agent applies the skill only through the advisor's `jev-skill` item: its check line, and on the user's yes on that result its apply line (spec kit/install/init-project); where the advisor shows no `jev-skill` item (the key not set), STEP 2's line is the user's own step. The guide's line is the user's command for a terminal of their own. The vendor's install lines are the user's own step too. Only when the user asks to see the plan, run the skill command without `--apply` yourself: a read-only dry run that writes nothing.

Keep this order: the fixed text (WHAT, WHY HERE, NOT, SOURCES); then the two steps — the key with its connect line and its mark, the vendor skill with its install lines, its mark and its first prompt; then the three prompts where it pays.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Rendered, or `--help` / `-h` as the whole invocation. |
| 1 | Nothing rendered: a stat of the `--dir` does not report a directory; the cause is printed on stderr. |
| 2 | Usage: an unknown argument, a `--dir` without a value, or `--help` / `-h` combined with anything. |

**Invariants:** the guide is read-only and opens no connection · the connect line is the user's own step in a terminal of their own: the key never reaches the agent or the chat · the key's value never printed · compact user-language render with paths, commands and vendor quotes verbatim · process.exitCode, never process.exit().
