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

## 5. Quota & health guard (advisory)

Backends are **subscription** services with **finite** quota. The orchestrator should: prefer the
cheapest model that fits the task; not reach for a top-tier model by reflex; and remember that
**Council spends two backends' quota** for one decision.

This guides *which recipe to choose up front* and *which model to run within a backend* — it is
**never a licence to drop a ready backend mid-Council** (that is the §4 fidelity breach, not a quota
saving). Once `council` is the resolved recipe and both backends are `ready`, the two-backend cost is
already accepted: run both, every round, until a round comes back clean.

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
