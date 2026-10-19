### Mode: rules

<!-- opt-in-capability: none — the user's own rules are changed on request, never a capability the advisor offers -->

Requires: ${CLAUDE_SKILL_DIR}/references/shared/command-shapes.md

**The one place the user changes the project rules.** Each theme (the first is project layout) has three files under `docs/ai/rules/`: the kit file `docs/ai/rules/<theme>.md`, which only the kit writes; the user's local file `docs/ai/rules/local/<theme>.md`, which wins where it differs; and the effective file `docs/ai/rules/effective/<theme>.md`, which agents read. This mode writes the local file on the user's request and yes, and keeps the effective file and its record current with the kit's own tools. It never commits.

**1. Start with the ensure.** Run `node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only rules --cwd <project>` and relay its line in plain words. The effective file is built, never written by hand: this mode moves no edit out of it, and the ensure's rebuild or the next merge replaces one.

**2. Do what the user asks — one of three.**

- **Change a rule.** The user says in plain words what to change. Show the exact text you will write to `docs/ai/rules/local/<theme>.md`, its frontmatter included, holding only the user's own rules and never a copy of the kit's, and write it on the user's yes. That request and that yes are the consent for the write of the local file.
- **Move an edit of the kit file.** When an ensure line for the kit file says it `carries your edit`, whatever token the run printed (`pending` and `regenerated` included), offer the move: compare `docs/ai/rules/<theme>.md` with the bundled `${CLAUDE_SKILL_DIR}/references/rules/<theme>.md`, write the user's changes, by meaning, into the local file (shown first, written on the yes), then delete the kit file. The next ensure seeds it again from the template, so the kit file keeps its one writer.
- **Drop the local rules.** On the user's request, delete the local file; the next ensure rebuilds the effective file from the kit file and records it.

**3. After each of these, run the ensure again.** On `pending`, do the merge its line states, show the user what changed in the final rules, then run the record command the line prints with the sha256 of the merged file (one plain command for the digest, per the shared command-shapes contract).

**It stops on a refusal.** When an ensure run answers `failed`, or the record command exits non-zero, relay the line and stop: write, delete and record nothing further, and run no closing check as if the change held.

**4. End with the checks.** Run `node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only index --cwd <project>`, then `node ${CLAUDE_SKILL_DIR}/tools/project-rules/rules-cli.mjs --check --cwd <project>`, which answers `current` for every theme; relay both in plain words.

**What it never does.** It never writes the effective file except with the merge a `pending` line states, never changes the kit file's text (the move deletes the file whole and the ensure seeds it again), and never writes a local file without the user's request.
