# Activity Procedures

Canonical, on-demand reference for **how an orchestrating agent performs a named activity** — the
ordered steps of a workflow activity with **typed recipe slots** that bind to the
[orchestration recipes](orchestration.md) (Solo / Reviewed / Council / Delegated). This is the
*how to perform* source of truth; it composes with — and never restates — the plan structure and
lifecycle in [`planning.md`](planning.md). The composition root (`agent-workflow-kit`) reads this
canon LIVE and renders the requested activity's steps + the resolved effective recipe per slot via
the read-only `/agent-workflow-kit procedures <activity>`; it parses ONLY each section's `Slots:`
line (drift-guarded against its activity table), never the steps.

A **recipe slot** is a point in an activity where a recipe applies: `review` accepts
`solo | reviewed | council`; `execute` accepts `solo | delegated`. The per-project default lives in
`docs/ai/orchestration.json` and is resolved against backend readiness by the kit — never decided in
this canon. Each activity section below begins with a machine-parseable `Slots:` line (the only line
the kit parses) and then its ordered steps. Terse by design: it points at the canon it binds to, it
does not restate it.

The commit rule holds across every activity: **when an activity has a commit boundary, the
orchestrator owns that commit; a backend is advisory or delegated, never autonomous, and never
commits** (see [`orchestration.md`](orchestration.md) §6). Not every activity commits —
`plan-authoring` ends at **approval** and produces **no** commit (plans are ephemeral, never
committed); `plan-execution` commits **per Step**. Any project-declared release/publishing or extra
stages are honored per the project's `workflow:methodology` slot — this generic canon bakes in no
single project's stages.

**Read your preference at session start.** At the start of a planning or execution session, read the
project's standing recipe preference in `docs/ai/orchestration.json` (set it in plain language with
`/agent-workflow-kit set-recipe` — it previews then writes; hand-editing the file stays supported); the
kit resolves it against backend readiness. Do not re-ask each session what is already configured there.

**Communication contract.** Every user-facing message delivers the artifact **inline** — the plan, the
next-session prompt, the diff, the value asked for — never a bare pointer ("see §X / open the file") as a
*substitute* for showing it; lead with the result, show exactly what was asked, and never read as
mockery. For a genuinely large artifact, deliver a real summary or the key excerpt inline **and** link
the file — never flood, never hide.

---

## plan-authoring

Slots: review

Produce a self-contained, cold-readable plan, reviewed to the configured depth before approval.

1. **Research** — gather the exact files, contracts, and constraints the plan will touch.
2. **Draft** — write the plan to the document structure defined in [`planning.md`](planning.md) §7,
   with exact paths and commands per Step. Bind to that structure; do not restate it here.
3. **Self-review** — run the [`planning.md`](planning.md) §8 checklist (exact paths/commands, strict
   vocabulary, every out-of-plan recommendation folded into a Step, `queue.md` updated for a series).
   Apply the [`planning.md`](planning.md) §9 lens — fold by code (read and cite the `file:line`), and
   hold the right altitude.
4. **review {recipe}** — review the draft at the depth the resolved `review` recipe selects: Solo
   (self-review only), Reviewed (one backend reviews), or Council (both backends review, you
   synthesize). The kit resolves the effective recipe from `docs/ai/orchestration.json` + readiness.
5. **Fold + loop** — fold every finding back into the draft and re-review until the review is clean.
6. **Present for approval** — surface the finished plan to the user; do not begin execution here.

**Required output (Definition of Done):** a planning session produces a self-contained plan in
`docs/plans/` **and** a cold-start execution prompt to begin the next session — **both produced without
the user asking**. A planning session that ends without both is not done.

The plan MUST end with the mandatory **Phase: Cleanup** ([`planning.md`](planning.md) §4) — a plan
without it is not done.

## plan-execution

Slots: execute, review

Execute an approved plan Step by Step; each Step is one logical commit.

1. **Per Step, resolve the recipe** — the kit resolves `execute` and `review` for this run from
   `docs/ai/orchestration.json` + readiness (a per-run `--override <slot>=<recipe>` is allowed).
2. **If `execute` resolved to Delegated, dispatch execution FIRST** — hand the bounded sub-task to the
   backend (codex-exec → a diff) *before* integrating; otherwise the orchestrator implements the Step
   directly.
3. **Implement / integrate** — apply the change (your own edits, or the reviewed delegated diff),
   following the project's reuse + clean-code rules.
4. **Self-review** — run the [`planning.md`](planning.md) §8 self-review on the change, applying the
   [`planning.md`](planning.md) §9 lens — fold by code (read and cite the `file:line`), and hold the
   right altitude.
5. **review {recipe}** — review the result at the resolved `review` depth (Solo / Reviewed / Council),
   exactly as in plan-authoring.
6. **Gates** — run the project's verification gate (tests + checks) to green before committing.
7. **Commit boundary** — the orchestrator makes the single commit for the Step; a backend never
   commits. The project's commit-approval policy (e.g. ask first) lives in the project's own rules.

**Output:** each Step lands as one logical commit with its gates green; the orchestrator owns the commit.

Honor any project-declared release/publishing or extra stages (per the `workflow:methodology` slot)
before the plan's Cleanup — this generic canon does not enumerate them.
