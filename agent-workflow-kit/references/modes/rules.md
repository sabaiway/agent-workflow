### Mode: rules

<!-- opt-in-capability: none — the user's own rules are changed on request, never a capability the advisor offers -->

Requires: ${CLAUDE_SKILL_DIR}/references/shared/command-shapes.md

**The one place the user changes the project rules.** Each theme (the first is project layout) has three files under `docs/ai/rules/`: the kit file `docs/ai/rules/<theme>.md`, which only the kit writes; the user's local file `docs/ai/rules/local/<theme>.md`, which wins where it differs; and the effective file `docs/ai/rules/effective/<theme>.md`, which agents read. This mode writes the local file on the user's request and yes, and keeps the effective file and its record current with the kit's own tools. It never commits.

**1. Start with the ensure.** Run `node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only rules --cwd <project>` and relay its line in plain words. The effective file is built, never written by hand: this mode moves no edit out of it, and the ensure's rebuild or the next merge replaces one.

**2. Do what the user asks — one of three.**

- **Change a rule.** The user says in plain words what to change. Show the exact text you will write to `docs/ai/rules/local/<theme>.md`, its frontmatter included, holding only the user's own rules and never a copy of the kit's, and write it on the user's yes. That request and that yes are the consent for the write of the local file.
- **Drop the local rules.** On the user's request, delete the local file; the next ensure rebuilds the effective file from the kit file and records it.
- **Change a number.** A request to change a number, a limit's value or its tolerance, is never written into a rules file: the rules are prose and carry no numbers; the kit keeps its numbers in its code, and a project's own number is a reasoned override in the size check's config. Show the exact `node ${CLAUDE_SKILL_DIR}/tools/source-size-check.mjs --override <id> [--value <n>] [--tolerance <p>] --reason "<text>" --cwd <project>` command, passing only the numbers the user named (an option left out keeps the limit's current value or tolerance; `files-per-root` takes `--tolerance` only), with `--kit-default` in their place to return to the kit's numbers; run it on the user's yes and relay its lines. This route ends there: it runs no ensure, merge, record or closing check.

**3. After each of the two rules routes, run the ensure again.** On `pending`, do the merge its line states, show the user what changed in the final rules, then run the record command the line prints with the sha256 of the merged file (one plain command for the digest, per the shared command-shapes contract).

**It stops on a refusal.** When an ensure run answers `failed`, the record command exits non-zero, or the `--override` command exits non-zero, relay the line and stop: write, delete and record nothing further, and run no closing check as if the change held.

**4. End with the checks.** Run `node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only index --cwd <project>`, then `node ${CLAUDE_SKILL_DIR}/tools/project-rules/rules-cli.mjs --check --cwd <project>`, which answers `current` for every theme; relay both in plain words.

**What it never does.** It never writes the effective file except with the merge a `pending` line states, never changes the kit file's text, and never writes a local file without the user's request.
