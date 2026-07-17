# Orchestration Recipes

Canonical, on-demand reference for **how an orchestrating agent composes the optional
execution-backends** (the family's subscription-CLI bridges) into the `plan → execute → review`
flow. This is the *narrative* source of truth — the **vocabulary** (what each recipe is), the
**when/why** (which to reach for), the **graceful-degradation lattice** (what happens when a backend
is unavailable), and the **quota/health guard**. The kit (`agent-workflow-kit`) owns the *executable*
dispatch (`tools/recipes.mjs` — `planRecipe` / `recommendRecipe`) and surfaces it read-only as
`/agent-workflow-kit recipes`; the two representations are kept in lockstep by a recipe-name parity
guard. For the plan lifecycle this composes with, see [`planning.md`](planning.md).

---

## 1. The role vocabulary recipes are built over

A recipe is an **orchestration pattern**, not a runnable script. The **orchestrator** (the main
agent) always owns the decisions, the edits it accepts, verification, and the **single commit** — a
backend is **advisory or delegated, never autonomous, and never commits**.

Each backend declares what it can do in its `capability.json` `provides` / `roles`:

- **`codex-cli-bridge`** (`codex`) — `provides: ["execute", "review"]`. It can run a bounded
  execution sub-task (`codex-exec`, output: a diff) and give an advisory review (`codex-review`,
  modes `plan` / `code`).
- **`antigravity-cli-bridge`** (`agy`) — `provides: ["review", "probe"]`. It gives an advisory,
  grounded review via `agy-review` (modes `code` / `plan` / `diff`) and answers a bounded probe via `agy-run`.

Both are **subscription** backends with a **finite quota** — spend deliberately.

## 2. The four recipes

| Recipe (id) | Pattern | Roles needed | Backends that satisfy it |
|-------------|---------|--------------|--------------------------|
| **Solo** (`solo`) | The orchestrator plans, executes, and self-reviews. No backend. | none | — (always available; the floor) |
| **Reviewed** (`reviewed`) | The orchestrator executes; **one** backend reviews the result (advisory). | ≥1 backend providing `review` | `codex` and/or `agy` |
| **Council** (`council`) | **Both** backends review independently; the orchestrator synthesizes the two opinions. | ≥2 backends providing `review` | `codex` **and** `agy` |
| **Delegated** (`delegated`) | The orchestrator hands a **bounded** execution sub-task to a backend, then reviews the returned diff and commits. | ≥1 backend providing `execute` | `codex` only |

## 3. When / why to reach for each (the decision vocabulary)

- **Solo** — the default for small, self-contained, low-risk work where a second opinion would not
  change the outcome: typos, one-line fixes, mechanical edits, doc tweaks. It is also the **floor**
  every other recipe degrades to, so the flow never blocks on a backend.
- **Reviewed** — the everyday choice when work carries real risk (a bug class, a security surface, a
  non-obvious refactor) and an independent reviewer is worth one backend's quota. When **both**
  backends can review, prefer **`codex`** (deterministic tie-break — `agy` carries a standing health
  caveat, §5).
- **Council** — for high-stakes or genuinely ambiguous decisions where two *diverse* opinions catch
  what one would miss. It spends **two** backends' quota, so reserve it for changes that justify the
  cost.
- **Delegated** — when a bounded, well-specified sub-task can be handed off (parallelism, or to keep
  the orchestrator's own context focused). Only `codex` provides `execute`. The orchestrator still
  reviews the returned diff and owns the commit — delegation never bypasses the review or the gate.

## 4. Graceful degradation (never silent)

Availability is **pure file-presence**: a backend is dispatchable **iff its detector `readiness` is
`ready`** — full stop. Every other readiness (`needs-skill` / `needs-cli` / `needs-credentials` /
`degraded`) means *not dispatchable*, and the specific value is the human reason (not installed → run
`/agent-workflow-kit setup`; CLI missing → install the CLI; credentials missing → log in; degraded →
the wrapper is not on `PATH`). This is a claim about **set-up state only** — never about whether a
backend's *service* is actually responsive.

When a recipe's roles can't be satisfied, it **degrades to a weaker recipe with a stated reason** —
always reported, never silently dropped:

- **Council → Reviewed → Solo.** Only one of the two reviewers is `ready` → Reviewed with that one;
  neither is `ready` → Solo.
- **Delegated → Solo.** No backend provides `execute` and is `ready` → Solo, with the reason.
- **Reviewed → Solo.** No backend provides `review` and is `ready` → Solo, with the reason.

**Recipe fidelity — the converse: every ready backend, every round.** Degradation is the *only*
licence to run fewer backends than the recipe names. When the resolved recipe is `council` and BOTH
reviewers are `ready`, EVERY review round runs BOTH — skipping a ready backend for quota, convenience,
or "the other one already shipped" is a **SILENT downgrade of Council → Reviewed, and is forbidden**.
The distinction is strict: an *unavailable* backend is a LOUD, stated degrade (the lattice above); a
*ready* backend you quietly drop is a fidelity breach, not a degrade. The same holds for any recipe
that names ≥2 backends. Folding a finding and re-reviewing (the convergence bar, [`planning.md`](planning.md)
§9) re-runs **every named backend each round** — convergence is reached only when one round comes back
clean from all of them.

**Backend divergence is the crossover stop — it bounds the ROUNDS, never the backends.** Running every
named backend every round CONVERGES when one round returns **0 blockers + 0 majors** from all of them.
But when the backends **diverge** — one grounded-**ships** while another keeps line-by-line **revising**
mechanics round after round — that **backend divergence** IS the crossover the loop must stop at: resolve
at **altitude** (raise the surviving major to an explicit acceptance invariant Execute must meet, or hand
the mechanics to the diff), NOT by exhausting the strictest line-by-line backend. This is the exact
converse of the fidelity rule above: divergence bounds how many ROUNDS the loop runs, and never licenses
dropping a ready backend within a round — both still run every round.

## 5. Quota & health guard (advisory)

Backends are **subscription** services with **finite** quota. The orchestrator should: prefer the
cheapest model that fits the task; not reach for a top-tier model by reflex; and remember that
**Council spends two backends' quota** for one decision.

This guides *which recipe to choose up front* and *which model to run within a backend* — it is
**never a licence to drop a ready backend mid-Council** (that is the §4 fidelity breach, not a quota
saving). Once `council` is the resolved recipe and both backends are `ready`, the two-backend cost is
already accepted: run both, every round, until a round comes back clean — or until **backend divergence**
marks the crossover (§4), resolved at altitude rather than by exhausting the strictest backend. Spending
quota to line-by-line re-review mechanics past that crossover is the over-run the divergence stop prevents.

### Cost lanes — route every step to the cheapest adequate executor

Model quota is one axis of a wider guard: work has **lanes**, and every step routes to the
**cheapest adequate executor**:

- **L0 — deterministic script.** Anything rule-driven and verifiable by exit code: the batched
  project gate matrix (the family's generic gate runner over a project-declared
  `docs/ai/gates.json`), the docs cap/index checks, the rotation `--check` scripts
  (changelog / issues / decisions). If a step CAN be a script, it IS a script — a model
  re-reading what an exit code already proves is the canonical waste.
- **L1 — cheap subagent** (a small model at low effort, bounded read-only tools): mechanical
  extraction at scale — inventories, fact sweeps, changelog fact-skeletons, digesting long
  failing output. Extraction and drafting ONLY; the orchestrator verifies the output against
  sources and owns every conclusion.
- **L2 — subscription bridge** (`codex` / `agy`): review and bounded delegated execution,
  governed by the recipes above; real review work stays on frontier bridge models
  (quality-first — economy on this lane comes from precomputed context, never a weaker model).
- **L3 — frontier main lane**: judgment — plans, folds, syntheses, ADR / handover /
  changelog-entry wording, user-facing copy, go/no-go, real code.

Two rules bound the routing. **A step with no named guardrail does not move down a lane** — a
deterministic checker, a pinned test, or a verifying orchestrator must catch a cheaper executor's
error, otherwise the step stays where it is. And the **red lines never move down**: council
reviews on frontier bridge models · real code implementation · ADR / plan / handover /
changelog-entry wording · persuasive user-facing copy · go/no-go judgment · the maintainer's
approval asks (commit / push / publish — cost tiering never touches approval gates).

**Asymmetric pairing** is the default composition: the cheap lane drafts, a deterministic tool or
the frontier verifies and signs — never the reverse.

**Prompt economy (autonomy-preserving dispatch).** Under a zero-prompt autonomy bar the lanes also
bound the TOOLS a dispatch may carry: **(a)** read-only fan-out — research, sweeps, extraction —
runs ONLY on **restricted-tool vehicles** (read-only tools, no shell); handing a full-tool
subagent to read-only work is a **forbidden lane downgrade** — an invisible prompt-flood plus
blast radius, not just tokens — and a subagent is never instructed to run a shell command for
facts obtainable read-only. **(b)** The orchestrator's own shell form: ONE plain pipeline per call
— a `;`/`&&` chain or an env-prefixed invocation never matches a prefix allow rule, so each such
call is a prompt. **(c)** A fan-out LAUNCHER tool may itself gate per call — under a
zero-prompt bar prefer the agent-spawn lane with placed vehicles. This clause is
**capability-gated** (route by what the host HAS): on a harness with restricted-tool subagent
vehicles, use them; WITHOUT restricted-tool vehicles — whether or not generic full-tool spawning
exists — read-only research stays in the orchestrator's own context —
never a vehicle mandate a host cannot satisfy. **(d)** a stage that fires repeated WRITER commands
batches them — a stage's evidence declarations (red-proofs, degrades) ride consecutive plain
writer invocations of ONE allow-listed tool, and the remaining stage writers combine via one
launcher per stage; never an unbatched writer scatter (each gated write is its own prompt). The clause narrows
TOOLS for read-only work only — judgment, code, and synthesis stay at the frontier lane, and a
task that genuinely needs to run or write keeps a full-tool subagent. **Honest limit:**
no deterministic gate classifies a dispatch — enforcement is this canon at the point of use,
the placed vehicles, and the retro loop.

**Sandbox lanes.** Under an OS sandbox the lanes split once more by **surface class**: the L0
surfaces are **sandbox-safe** (gate/ledger/state/fold checks, git reads, plain no-network tests);
the bridge wrappers are **genuinely unsandboxed** (they need network); npm-cache-touching commands
are **COMMAND-SHAPE dependent** — first try the sandbox-safe shape (cache under `$TMPDIR`,
offline/notifier off) before moving anything out. Two driving rules: **move ONLY the failing
command out of the sandbox, never its class**, and **BATCH consecutive unsandboxed calls** — a
blanket unsandbox after one failure is the canonical over-reaction. **Pre-dispatch host-diff:**
before the FIRST dispatch of each bridge, diff its manifest `networkHosts` against the live
sandbox's allowed hosts — a missing host is surfaced to the maintainer BEFORE dispatching, never
fired into a known prompt. **Nested-sandbox honesty:** a backend CLI that ships its OWN OS sandbox
cannot run nested inside a harness sandbox — route it outside (an excluded command / a per-run
consented bypass) on the OBSERVED failure, never a preemptive blanket.

**Incident repair (your own error) defaults down-lane:** salvage recorded state first (journals,
transcripts, git), replay it deterministically (L0), hand the leftovers to L1 in one batch —
frontier re-derivation of recoverable state is the expensive failure mode, and the maintainer
never pays frontier tokens for the agent's own mistake.

A **standing health advisory** applies to `agy`: the Antigravity service can **stall on substantive
prompts** (a long hang that returns nothing — an external service issue, not a setup problem;
tracked as **Issue-001** in the kit's known issues). It is **invisible to file-presence detection**,
so it is *not* a readiness signal — only a standing caveat. The **grounded** `agy-review` contract
makes `agy` a **sound** second opinion — it removes the stale-model / partial-diff **false positives**
that the old ungrounded, `--add-dir`-roaming reviews produced — so `agy` is no longer something to
merely avoid. But the *service* stall is a **separate, real** risk that grounding does **not** remove,
so keep reviews **focused** (the inherited hard timeout is the guard) and **prefer `codex`** for large
or latency-sensitive substantive reviews and for the `--add-dir` escalation path (the deterministic
Reviewed tie-break in §3). The recipe machinery **never runs a subscription CLI** to check — detection
stays read-only.

## 6. The orchestrator always commits

No recipe makes a backend write to the repo or create a commit. The kit's `recipes` surface is
**read-only** — it lists the recipes, plans one for the current environment, and recommends a
default; it **never executes** a recipe and **never runs a subscription CLI**. The orchestrator
executes the chosen recipe through the bridge skills, accepts or rejects every edit, runs the
verification gate, and makes the **one** commit — exactly as the plan lifecycle (`planning.md`)
requires.

## 7. Checkpoint-bounded autonomy (the policy every recipe runs under)

Autonomy is **checkpoint-bounded**: between human checkpoints the orchestrator runs as autonomously
as the project declares, and the checkpoints themselves never move. The policy is declared per
project in `docs/ai/autonomy.json` — **red-lines** (always in force: `commit`/`push`/`publish` ask;
`network`/`credentials`/`fs_outside_repo` deny) plus a **per-activity autonomy level**: `sandbox`
(the OS sandbox confines and auto-allows confined commands — work runs to the next checkpoint
without per-command prompts) or `prompt` (every non-allowlisted command prompts; the sandbox, where
enabled, still confines). **Read it at session start.** An **absent** file means the computed
defaults ARE the policy (every activity floors at `prompt`); a **malformed** file is a loud STOP —
never guess around it. The **sandbox is the floor, not the permission**: red-line commands keep
their asks at every level, and cost tiering (§5) never touches an approval gate. For **delegated
backends the policy is informational** — enforcement stays the OS sandbox plus the orchestrator
process (a backend never gains autonomy the orchestrator itself does not have). Declare and edit
the policy with `/agent-workflow-kit set-autonomy` (previews first; hand-editing stays supported);
render it into the harness settings with the kit's velocity `--autonomy` mode.
