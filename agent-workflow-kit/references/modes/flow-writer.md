### Mode: flow-writer

<!-- opt-in-capability: none — the writer serves an already-armed flow (arming is set-flow's, adoption is explicit); the advisor-offer decision rides the Plan-4 dogfood/release wave -->

The **explicit flow-store writer** — the answer to every `flow-check` refusal that names a mintable record class. The checker's refusals print the **exact pasteable command** this tool runs; the store's own semantic preflight (lock-serialized, validated, atomic) is the **single legality door** — the writer adds NO second validator, and an illegal transition surfaces the store's own refusal **verbatim**.

Run **`node ${CLAUDE_SKILL_DIR}/tools/flow-writer.mjs <arm> …`** — the arm set (Decision 8; every record class a flow refusal names as recovery):

| arm | what it records |
|---|---|
| `adoption <plan-file> [--label <l>] [--cycle <n>]` | a chain's FIRST record — binds the plan's frontmatter `planId` + content digest (#58); the plan file is only read |
| `park <planId>` / `resume <planId>` / `complete <planId>` | the explicit plan-lane transitions (#59) — park is a resumable suspension, complete is the plan terminal |
| `refresh <planId> --cause <text> --refreshed-record <digest>` | a within-step re-attestation binding an existing record (bookkeeping-delta re-attestations ride this) |
| `re-baseline <planId>` | the disjoint-base-motion recovery — records the pre-motion base (#62) |
| `rerun-cause --attempt <id> --cause <text>` | legalizes exactly one confirmed final-gates retry (#65) — mint it on the RETRY tree |
| `down-mark --backend <b> --reason <r> --expires-at <ISO>` | a sticky reviewer down-mark with an explicit TTL instant |
| `down-mark-up --backend <b> [--target <digest>]` | closes the backend's ACTIVE mark upward (auto-resolved when `--target` is omitted) |
| `down-mark-clear --backend <b> [--target <digest>]` | clears the backend's ACTIVE mark (auto-resolved when `--target` is omitted) |
| `degrade-justification --backend <b> [--down-mark <d>] [--degrade-digest <d>]` | binds a core degrade to a then-active down-mark (#25) — both digests resolve automatically; an explicit digest only VERIFIES the resolved authority (a foreign digest never mints), and the store's locked preflight re-refuses a mark closed in the race window |
| `maintainer-override <planId> --backend <b> --checkpoint-approved` | the checkpoint-approved ship-over-veto record — it **prints the FULL bound set** it is about to record and **requires the explicit flag** (#38); without the flag the bound set still prints and nothing is written |
| `consult-attestation <planId> --backend <b> --nonce <n> --proposed-fix-digest <d>` | binds a consult to a real dispatch's findings (#11/#33): `findingDigest` is **computed from the `{backend, nonce}`-named finding manifest** beside the receipts file (never hand-supplied); `proposedFixDigest` is the explicit consult-time input; refuses without an open step, or without a readable identity-matching manifest |
| `write-plan-id <plan-file> --plan-id <id>` | adds the frontmatter `planId` line — bounded to an EXISTING regular file under `docs/plans/` (never a symlink), contained-atomic, same-id idempotent, **different-id refuses** (#58) |

Operand shapes: a positional operand may follow a literal `--` and a value flag accepts `--flag=<value>` — the lanes a leading-dash id or value rides; the checker's printed recoveries compose exactly these shapes. Every arm computes its **tree context** (owner, base, fingerprint; cycle/round from the chain walk) — you never hand-supply tree identity. Chain arms **refuse a foreign worktree's chain** (#57): park/resume/complete a chain only from the worktree that adopted it. `round` / `freeze` / `unfreeze` / `converged` / `internal-attestation` minting rides the next release wave with the dogfood round machinery.

**Exit codes:** `0` success (incl. the `write-plan-id` idempotent no-op); `2` usage; `1` refusal (a store STOP verbatim, a derivation failure, or the missing checkpoint flag).

Output is **English/structured** — **localize it to the user's conversational language** when you narrate.

**Invariants:** writer (appends to the git-common-dir flow store; `write-plan-id` writes one plan file) · never commits · never runs a subscription CLI · the store preflight is the single legality door · refusal recoveries paste back into this tool.
