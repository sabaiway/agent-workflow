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
| `round-open <planId> --backend <b> [--backend <b> …] [--step <stepId>] [--new-cycle] [--justification <t>]` | the round's **pre-dispatch half** (#41): mints before any backend runs and applies the cap, walk and completeness gates detailed below |
| `round-land <planId> [--dispose <action> …]` | the round's **post-arrival half** (#42/#13/#33): binds exact arrivals and records one of the five dispositions detailed below |
| `freeze <planId>` / `converged <planId>` | the step terminals, gated on **completeness + the sanctioned-move rule** (no premature terminal): every dispatch landed or **justified-degraded** at the dispatched tree (a core degrade + a mint-time-valid `degrade-justification` at the round's `{base, fingerprint}` — a bare degrade is not base-bound); every landed non-ship receipt rides a round with a non-empty disposition ledger (a form floor — semantic per-finding completeness is an honest limit); the tree sits at the last round's fingerprint or reached it through an **anchored** declared bookkeeping-delta chain + refresh (a pre-round chain never re-certifies a later move). Both walks **re-run on the locked store snapshot** at append time |
| `unfreeze <planId> [--justification <t>]` | reopens the frozen step (in-step) or the just-converged terminal (boundary); **cap 1 per cycle** — the design's post-freeze checkpoint |
| `internal-attestation <planId> --lens <l> … [--degraded <b> …] --model <m> [--effort <e>] [--tier <t>] --authority <a> [--walk <file>]` | the #28 internal-review attestation at the open step's round, gated on #68 adoption coverage. `--walk` is a capped, no-follow closed JSON file relative to the absolute git common dir; for every judged plan row every class in TAGGED ∪ PRESENT needs non-empty `checked`, while extra entries are ignored and PRESENT minus TAGGED is recorded as `walk.uncovered`. |
| `write-plan-id <plan-file> --plan-id <id>` | adds the frontmatter `planId` line — bounded to an EXISTING regular file under `docs/plans/` (never a symlink), contained-atomic, same-id idempotent, **different-id refuses** (#58) |

`round-open` mints the round record BEFORE any backend runs — per `--backend` a fresh nonce + receipts watermark; stdout prints one `dispatch backend=<b> nonce=<n> watermark=<w>` line per dispatch (pass the nonce as `--nonce <n>` on the wrapper invocation — the plain-argument lane onto the `AW_REVIEW_NONCE` seam; hand the pair to `receipt-deadline`).

Every round after the first requires an authoritative walk-carrying attestation at the preceding round's `{planId, cycle, stepId, round}` and the CURRENT tree's `{base, fingerprint}` when the adopted plan has a judgeable ledger row; `--justification` may lift that absence as an echoed input, and the ABSENCE of the attestation is its durable trail. At `cap reached` or `crossover`, every blocking item from the latest head's landed receipts must be covered by equal item digest: uncovered items print verbatim, enumeration failure is an advisory plus the existing disposition floor, and a lost manifest is covered only by `custody-lost`; this cap refusal is never lifted by `--justification`.

Both lock-free and locked `round-open` checks run cap → walk → completeness floor. Boundary invocations need `--step`; `--new-cycle` opens the next cycle; a fingerprint move opens a new round.

For `round-land`, exactly one fresh code-artifact non-probe line of the dispatched backend **carrying the dispatch's exact nonce** (the wrapper stamps `AW_REVIEW_NONCE` into the receipt — a delayed or cross-chain answer can never cross-bind) past the watermark is the candidate, and only the canonical **ATTESTING** class binds. It revises the ONE round record in place with five closed actions.

`folded --finding <quote> --proof-kind … --proof-digest <d>` and `rejected --finding <quote> --reason <r>` retain their bindings; `queued --finding <quote> --claim <invariant> --proof-kind consult-attestation|red-proof --proof-digest <d>` requires `decideFoldScope` ACCEPT, derives `debtId` from the resolved row and computes `debtDigest` from its block, then binds the proof to this head, item and claim.

`escalated --finding <quote> --override-digest <d>` binds a veto override and only that receipt's findings; `custody-lost --receipt <receiptDigest>` carries no quote, is recordable whenever the carrier loss is real, covers that receipt for the cap, and excludes it from later manifest re-reads. Arrivals still bind only canonical attesting receipts and identity-matching manifest bytes.

Operand shapes: a positional operand may follow a literal `--` and a value flag accepts `--flag=<value>` — the lanes a leading-dash id or value rides; the checker's printed recoveries compose exactly these shapes. Every arm computes its **tree context** (owner, base, fingerprint; cycle/round from the chain walk) — you never hand-supply tree identity. Chain arms **refuse a foreign worktree's chain** (#57): move a chain only from the worktree that adopted it.

**Round-machinery caps (enforced at the arms; the store owns transition legality):** HARD_MAX **3 rounds per {cycle, step}** and **1 post-freeze unfreeze per cycle**. The walk obligation holds when the adopted plan's ledger parses with at least one valid row; a plan with no judgeable row owes no walk. Both lock-free and locked round-open checks run cap → walk → completeness floor. The justification predicate is `overCap || walkRefusalFired`: a non-empty justification lifts only a design-cap or missing-walk refusal and is echoed; an in-cap invocation with its walk satisfied refuses it as usage. The blocking-item cap is independent and never lifted. A `custody-lost` entry is recordable whenever the carrier loss is real. One-way door: records carrying `walk`, the queued proof trio, `escalated`, or `custody-lost` require kit >= 11 to read; pre-rung records remain valid.

**Exit codes:** `0` success (incl. the `write-plan-id` idempotent no-op); `2` usage; `1` refusal (a store STOP verbatim, a derivation failure, or the missing checkpoint flag).

Output is **English/structured** — **localize it to the user's conversational language** when you narrate.

**Invariants:** writer (appends to the git-common-dir flow store; `write-plan-id` writes one plan file) · never commits · never runs a subscription CLI · the store preflight is the single legality door · refusal recoveries paste back into this tool.
