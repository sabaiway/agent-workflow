---
name: agent-workflow-kit
description: Deploy or upgrade a portable AI-agent memory-and-workflow system in any project. Use when the user wants to bootstrap `docs/ai/` + an entry-point `AGENTS.md` (+ `CLAUDE.md` alias) + cap/archive/index enforcement in a new or existing repo, set up the Memory Map and session protocols, install the docs-rotation pre-commit hook, or run `/agent-workflow-kit` / `/agent-workflow-kit upgrade`. Triggers on phrases like "set up the memory system", "deploy the AI workflow here", "bootstrap docs/ai", "upgrade the workflow".
disable-model-invocation: true
metadata:
  version: '1.36.0'
---

# agent-workflow-kit

Deploys a **portable AI-agent memory-and-workflow system** into a project, and upgrades it as the kernel evolves — so any future agent can reconstruct project context fast and avoid repeating past mistakes.

**Posture:** never leak kit internals — translate tool outcomes to plain language; Gotchas: `${CLAUDE_SKILL_DIR}/references/shared/deploy-tail.md`.

---

## Memory substrate: delegate or fall back (composition root)

This kit is the **composition root** of the `agent-workflow` family. The memory substrate
(`docs/ai/`, the entry-point doc, caps / archive / index, the setup contracts) is owned by
**`agent-workflow-memory`**. The kit **prefers to delegate** substrate deployment to that skill
when it is present and healthy, and otherwise uses its **own bundled copy** (`references/`,
`migrations/`) — so the existing one-command install keeps working with **no new dependency on the
memory substrate**. (The methodology slot is a separate axis: its fragment is read **live from the
installed `agent-workflow-engine`**, which `npx @sabaiway/agent-workflow-kit@latest init` installs — a
runtime dependency read live; see `${CLAUDE_SKILL_DIR}/references/shared/composition-handoff.md`.)
`init` also **refreshes the installed memory substrate** (best-effort — a miss is a loud DEGRADED
success: warn + the exact recovery command + exit 0, never silent, never the engine's hard STOP;
`--no-memory` skips it), so a returning `init` leaves **no stale core member**. The
execution-backend bridges are still never **placed** by `init` (placed on demand by `setup`, opt-in);
**once placed**, `init` **refreshes** them from the kit's own bundled copies (refresh-only, never a
downgrade; `--no-bridges` skips it) — so a returning `init` leaves no stale placed bridge either.

**Detection (kit-owned, decided BEFORE any project write).** Run the kit's **own shipped**
validator — `node ${CLAUDE_SKILL_DIR}/tools/manifest/validate.mjs <memory-skill-dir>` — never a
validator shipped by the candidate (which could itself be broken). Delegate only when **all**
hold:
- result is **valid** and `kind` is `memory-substrate`;
- **every required asset is present** in the candidate, at its real path:
  `references/templates/`, **`references/templates/orchestration.json`** (a pre-`1.2.0` memory can't
  ship it, so it falls back to the kit's bundled substrate), `references/contracts.md`,
  `references/scripts/`, `scripts/stamp-takeover.mjs`, `migrations/`, `capability.json`. A partial
  install (manifest + `SKILL.md` only) is treated as **invalid**.

On **unsupported** (unknown schema), **invalid**, **unavailable**, **wrong-family**, or
**wrong-name**, **use the bundled copy** — never block. The fallback decision is final once
made: a partial/broken memory install discovered mid-flow must not disable the working fallback.

> The **executable form** of this whole decision lives in
> [`tools/delegation.mjs`](${CLAUDE_SKILL_DIR}/tools/delegation.mjs): `detectMemory(<memory-dir>)` runs the validator +
> the required-asset check and returns `delegate` / fallback with a reason; `handoffPlan(delegate)`
> returns who writes what, which stamps end up present, and that the commit gate is kit-only. Both
> are unit-tested, so the contract below is pinned by code, not agent interpretation.

**Hand-off contract & bounded pointer reconciliation** — `${CLAUDE_SKILL_DIR}/references/shared/composition-handoff.md` (read at the bootstrap/upgrade point of use).

**One composition-level commit gate.** The delegated memory mode performs **no** commit and
raises **no** "ask to commit". There is exactly **one** gate, owned by the kit, **after**
injection: report results and **ask before committing** — never auto-commit. No kit asset is
ever deleted.

---

## Modes

Pick the mode from the user's invocation — the mapping is pinned by `tools/commands.mjs` `routeInvocation` (unit-tested; safe-routing rule below). An existing `docs/ai/` guards against bootstrapping over a live system — the user makes the final call.

### Version status & the two axes — the internal routing check

**Safe-routing rule (which mode did the user invoke?).** Map the invocation token with `tools/commands.mjs` `routeInvocation`: a **known** subcommand → its mode; the **bare/empty** invocation → `bootstrap` — the one writer reachable without a token, and only on an undeployed project (if `docs/ai/` already exists, **ask upgrade-vs-bootstrap**, never overwrite); **any unrecognized/ambiguous** token → `help`, which is **read-only**. The invariant: **no unrecognized/garbage invocation ever triggers a write** (only an explicit known token or the acknowledged bare-bootstrap exception can). The mapping is unit-tested, so it is not left to interpretation.

Before acting, read `docs/ai/.workflow-version` (the project's stamp) to decide the route — this is an **internal** routing decision, **not** a line you print to the user (the number itself is shown only per *Version disclosure* in `${CLAUDE_SKILL_DIR}/references/shared/report-footer.md`). Route:

- **absent** → bootstrap (a fresh deployment).
- **stamp < `1.3.0`** (the deployment-lineage head) → `upgrade`.
- **stamp == `1.3.0`** → already current; only the stamp-independent reconciles may run — the FULL set lives in `${CLAUDE_SKILL_DIR}/references/modes/upgrade.md` step 3; run step 3 (never enumerate the reconciles from memory).
- **stamp > head / unparseable** → STOP — never-downgrade gate (see `${CLAUDE_SKILL_DIR}/references/modes/upgrade.md` step 2).

**Two independent version axes — never conflate them:**

1. **Project deployment** — `docs/ai/.workflow-version` vs the lineage head (`1.3.0`). This is the **only** axis this skill compares.
2. **Kit freshness** — this skill's own files vs the published npm package. That is the **npx installer's** job: `npx @sabaiway/agent-workflow-kit@latest init` (it refuses a stale-cache downgrade by comparing the version on disk — **no network**). This skill never checks npm, and the package version is **not** the lineage head.

**Refreshed the kit but nothing changed?** The skill you are running is whatever was on disk when the session started. After `npx @sabaiway/agent-workflow-kit@latest init` updates `~/.claude/skills/agent-workflow-kit/`, **restart the session** so the agent reloads the new skill files (the slash command + this `SKILL.md`).

### Mode: help

read-only — read `${CLAUDE_SKILL_DIR}/references/modes/help.md` before acting.

### Mode: gates

project-exec — read `${CLAUDE_SKILL_DIR}/references/modes/gates.md` before acting.

### Mode: bootstrap

writer — read `${CLAUDE_SKILL_DIR}/references/modes/bootstrap.md` before acting.

### Mode: upgrade

writer — read `${CLAUDE_SKILL_DIR}/references/modes/upgrade.md` before acting.

### Mode: backends

read-only — read `${CLAUDE_SKILL_DIR}/references/modes/backends.md` before acting.

### Mode: setup

writer — read `${CLAUDE_SKILL_DIR}/references/modes/setup.md` before acting.

### Mode: status

read-only — read `${CLAUDE_SKILL_DIR}/references/modes/status.md` before acting.

### Mode: recipes

read-only — read `${CLAUDE_SKILL_DIR}/references/modes/recipes.md` before acting.

### Mode: procedures

read-only — read `${CLAUDE_SKILL_DIR}/references/modes/procedures.md` before acting.

### Mode: set-recipe

writer — read `${CLAUDE_SKILL_DIR}/references/modes/set-recipe.md` before acting.

### Mode: set-autonomy

writer — read `${CLAUDE_SKILL_DIR}/references/modes/set-autonomy.md` before acting.

### Mode: uninstall

guarded — read `${CLAUDE_SKILL_DIR}/references/modes/uninstall.md` before acting.

### Mode: velocity

writer — read `${CLAUDE_SKILL_DIR}/references/modes/velocity.md` before acting.

### Mode: agents

writer — read `${CLAUDE_SKILL_DIR}/references/modes/agents.md` before acting.

### Mode: hook

writer — read `${CLAUDE_SKILL_DIR}/references/modes/hook.md` before acting.

### Mode: bridge-settings

guarded — read `${CLAUDE_SKILL_DIR}/references/modes/bridge-settings.md` before acting.

### Mode: review-state

read-only — read `${CLAUDE_SKILL_DIR}/references/modes/review-state.md` before acting.

### Mode: grounding

writer — read `${CLAUDE_SKILL_DIR}/references/modes/grounding.md` before acting.

### Mode: review-ledger

writer — read `${CLAUDE_SKILL_DIR}/references/modes/review-ledger.md` before acting.

---

## References

- [`references/modes/`](${CLAUDE_SKILL_DIR}/references/modes/) — one file per mode (the router lines above point here); [`references/shared/`](${CLAUDE_SKILL_DIR}/references/shared/) — the shared point-of-use contracts (report footer · composition hand-off · deploy tail).
- [`references/contracts.md`](${CLAUDE_SKILL_DIR}/references/contracts.md) — the three setup contracts.
- [`references/templates/`](${CLAUDE_SKILL_DIR}/references/templates/) — the `AGENTS.md` + `docs/ai/` templates + seeded configs; [`references/scripts/`](${CLAUDE_SKILL_DIR}/references/scripts/) — the Node enforcement scripts; [`migrations/`](${CLAUDE_SKILL_DIR}/migrations/) — per-version upgrade steps; [`launchers/`](${CLAUDE_SKILL_DIR}/launchers/) — non-Claude agent launchers.
- [`tools/`](${CLAUDE_SKILL_DIR}/tools/) — the family-wide tooling; each tool's contract lives with its mode file and its own header; bridge mirrors under [`bridges/`](${CLAUDE_SKILL_DIR}/bridges/).
- **Plan vocabulary & lifecycle** — the installed `agent-workflow-engine` canon; `npx @sabaiway/agent-workflow-kit@latest init` installs it.
