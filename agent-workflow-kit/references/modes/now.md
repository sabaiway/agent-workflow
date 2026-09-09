### Mode: now

<!-- opt-in-capability: none — an inspection surface that configures nothing -->

Read-only. The single answer to where the work stands. It writes no file, cache, receipt, lock or git state; it never commits and never runs a subscription CLI.

Run `node ${CLAUDE_SKILL_DIR}/tools/now-cli.mjs --dir <project> --json`. For a direct terminal render, use `--format=plain|ansi|json`; `--json` is strict sugar for `--format=json`.

Render the returned envelope compactly in the user's conversational language. Never paste the JSON and never expose an internal field name. Preserve every fact, evidence label, annotation and withheld cause while translating only the prose around source-language commands, paths and identifiers.

The four blocks keep this order:

1. **NOW** — every plan in flight, its derived phase, current and next step, then the tree fingerprint, clean state, review verdict lines, final run and red-proof currency. No plan and several plans are rendered states; never pick one silently.
2. **STEPS** — every ledger row with one of `landed`, `in progress`, `pending` or `unjudged`. The rows are the steps; invent no numbering.
3. **QUEUE** — every work-carrying row (live, parked, ambiguous) under the full line-numbered heading path it carries, with per-class counts covering every row of the bucket, terminal and record included, and names rather than ids. Only a path through `## Pending / backlog` calls its position priority; every other bucket is archive and calls it position.
4. **CAMPAIGN** — source-size config state (`absent`, `authored`, `incomplete`, `minted`), caps, roots, recorded over-cap files and aggregate lines. An absent opt-in config is a rendered state.

Evidence alone sets a ledger status: the row's path and verb, then the path fact, changed set and exclusion fact. The plan's prose never sets a status. A checked box or terminal marker is only a claim; when evidence contradicts it, print the claim beside the evidence-derived status. Keep anomaly and current red-proof annotations beside the same status too. Every status line names its evidence source.

A block that cannot be derived is `WITHHELD` and prints its cause on one line. NOW has two halves, plans and tree, each independently a value or `WITHHELD`; NOW itself is `WITHHELD` only when both are. Render every other block normally.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Anything rendered, including default states, contradictions and a WITHHELD block. |
| 1 | Nothing rendered: every block withheld, each cause printed on stderr; the usual cause is a `--dir` that is not a git work tree. |
| 2 | Usage: an unknown flag, an invalid or missing value, conflicting `--json` / `--format`, or `--help` combined with anything. |

**Invariants:** read-only · the plan's prose never sets status · evidence is shown beside every status · compact user-language render with no JSON or internal field names · `process.exitCode`, never `process.exit()`.
