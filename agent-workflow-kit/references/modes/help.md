### Mode: help

Read-only. The single discoverable **command index** — it answers *"what can `/agent-workflow-kit` do, and which commands change things?"* It **never writes, never commits, and never runs a subscription CLI**.

Run `node ${CLAUDE_SKILL_DIR}/tools/commands.mjs` (add `--json` for the machine-readable catalog) and present its grouped index — **Inspect / Configure / Orchestrate / Lifecycle**, each command tagged **read-only / writer / guarded / runs-project-commands** (the last: the kit writes nothing, but the mode executes the project's OWN declared commands — the `gates` runner) — in the user's conversational language. That catalog is the **single source of truth** for the command surface (the same one the bootstrap / upgrade report footers point at); `routeInvocation(token)` in the same file is the executable contract for which invocation maps to which mode.

`help` is also the landing spot for any **unrecognized or ambiguous** invocation — and that path is **always read-only** (the safe-routing rule under *Version status & the two axes*). When you arrive here that way, render the index and, in plain language, note that the invocation wasn't recognized so nothing was changed.
