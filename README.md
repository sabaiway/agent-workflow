<div align="center">

# 🧠 agent-workflow

**Durable, cross-agent memory & workflow for AI coding agents.**

*Bootstrap once — then every future session boots from a small, structured memory
instead of re-reading your whole repo and re-deriving yesterday's decisions. Works with
Claude Code, Codex, Cursor, and any agent that reads `AGENTS.md`.*

[![kit](https://img.shields.io/npm/v/@sabaiway/agent-workflow-kit?logo=npm&label=kit)](https://www.npmjs.com/package/@sabaiway/agent-workflow-kit)
[![memory](https://img.shields.io/npm/v/@sabaiway/agent-workflow-memory?logo=npm&label=memory)](https://www.npmjs.com/package/@sabaiway/agent-workflow-memory)
[![license](https://img.shields.io/npm/l/@sabaiway/agent-workflow-kit)](./LICENSE)
[![node](https://img.shields.io/node/v/@sabaiway/agent-workflow-kit)](https://nodejs.org)

`Node ≥ 18`  ·  `dependency-free scripts`  ·  `no telemetry in family code`

**One command to start:**

```bash
npx @sabaiway/agent-workflow-kit init
```

**Cross-agent by design** — the deployed `AGENTS.md` is read natively by Claude Code (via the
`CLAUDE.md` alias) · Codex · Cursor · Devin · Copilot · Gemini CLI & 20+ tools; `init` itself
auto-wires bootstrapper launchers for Claude Code · Codex · Devin Desktop.

**Quick-jump:** [Start](#-start-using-it) · [How it composes](#-how-the-family-composes) · [Choose a member](#-choose-the-right-member)

</div>

---

## ❓ The problem — every session starts cold

AI coding agents are **stateless between sessions**. Each new chat begins from zero, and the
cost compounds:

```
stateless session  ->  re-scans the repo  ->  re-infers the architecture
   ->  re-litigates decisions you already settled  ->  repeats a fixed bug
   ->  drift between docs and code  +  the same context paid for, every time
```

There is no durable handover, so what the agent learned yesterday is gone today.

```
WITHOUT  session -> scan repo -> re-infer design -> re-decide -> work -> lost
WITH     session -> read AGENTS.md + index -> load what matters -> handover
```

<sub>*Continuity loop: transient chat context is lost; a maintained memory feeds the next session.*</sub>

---

## ⚡ Without vs. With

Just *telling* the agent in chat doesn't last: those instructions are transient — no handover,
the same decisions get re-litigated next session, and docs drift from code. A durable memory
layer fixes the **mechanism**, not just the symptom.

| | 🚫 Without | ✅ With `agent-workflow` |
|---|---|---|
| **Session boot** | re-read source + grep to rebuild context | read a few small docs, ~constant |
| **Boot cost** | grows with the repo, paid every session | flat; the entry layer stays cache-warm |
| **Cross-session memory** | none | `handover.md` — where we left off |
| **Past decisions** | re-litigated | `decisions.md` (ADRs) — settled once |
| **Known bugs** | re-discovered | `known_issues.md` — impact + workaround |
| **Doc growth** | unbounded sprawl | frontmatter caps + 3-tier rolling archive |
| **Drift** | docs ≠ code over time | pre-commit gate keeps them honest |
| **Cross-agent** | re-explain the project to each tool | one `AGENTS.md`, read by 20+ agents |

```
WITHOUT the kit — cold start, cost grows
  s1  ~30k  ##########
  s2  ~28k  #########      <- repeats an already-fixed bug
  s3  ~34k  ###########    <- drift

WITH the kit — boots from memory, cost stays flat
  s1   ~4k  #
  s2   ~4k  #              <- no drift
  s3   ~5k  #              <- decisions kept
```

<sub>*Boot cost is illustrative/directional, not a measured guarantee — the **shape** is the
point: cold re-reads that grow vs. a flat, cache-warm boot.*</sub>

---

## 🚀 Start using it

Onboarding has three honest scopes — and `init` is **not** the project deploy:

```
ONCE / MACHINE    npx @sabaiway/agent-workflow-kit init  -> global kit skill
ONCE / PROJECT    invoke the skill in the repo  -> deploy AGENTS.md + docs/ai/
EVERY SESSION     agent reads entry layer -> loads on demand -> handover
OPTIONAL/MACHINE  install a bridge + subscription login -> delegated exec
```

1. **Once per machine** — `npx @sabaiway/agent-workflow-kit init` installs/refreshes the
   **global skill** in `~/.claude/skills/` and wires launchers for any Claude Code / Codex /
   Devin Desktop you have. It does **not** deploy into a project and does **not** install the
   bridges.
2. **Once per project** — invoke the skill **inside the repo** (the command differs per agent —
   see the [kit README's command table](agent-workflow-kit/README.md#-use)). It deploys
   `AGENTS.md` + `docs/ai/` filled with real recon, installs the enforcement scripts +
   pre-commit hook, and **asks before committing**.
3. **Every session afterwards** — the agent reads the small entry layer, loads deeper docs only
   on demand, and writes a handover at the end.

---

## 📦 What you get in your project

```
your-repo/
├── AGENTS.md              <- single entry point (read first)
├── CLAUDE.md -> AGENTS.md <- symlink, for Claude Code
└── docs/ai/
    ├── index.md           <- auto-generated navigator
    ├── handover.md        <- where we left off
    ├── active_plan.md     <- current task
    ├── decisions.md       <- ADRs — settled once
    ├── known_issues.md    <- bugs + workarounds
    ├── architecture.md · current_state.md · changelog.md · …
    └── history/           <- archive (HOT -> WARM -> COLD)
  + scripts/               <- caps · index · archive   (Node path)
  + pre-commit hook        <- keeps it all honest       (Node path)
```

The Markdown memory is **stack-agnostic**; the `scripts/` + pre-commit hook are the **Node path**
(dependency-free, `node --test`). Non-Node projects keep the same policy by hand.

Two **visibility** modes, chosen at deploy time: **visible** (committed with the repo) or
**hidden** (same files in-tree but git-ignored via the global `core.excludesFile`, so the repo
"looks normal"). Hidden changes how the files are tracked, not where agents find them.

| Tier | Files | Behaviour |
|---|---|---|
| **Always loaded** | `AGENTS.md` + `docs/ai/index.md` | read every session; small + cache-warm |
| **On demand** | `handover` · `active_plan` · `architecture` · `decisions` · … | opened only when its "Read When" applies |
| **Archive** | `changelog` (HOT) → `recent` (WARM) → per-month (COLD) | old history rolls out of the hot files |

<sub>Enforced by `maxLines` caps + an index-freshness gate (pre-commit).</sub>

---

## 🧩 How the family composes

One kit is the entry point; everything else is a layer it composes:

```
npx ... init -> kit  (composition root; global skill, NOT a project deploy)
   |- injects the methodology   <- engine (future supplier; available:false)
   |- delegates -> memory substrate (standalone, else bundled fallback)
   `- deploys -> AGENTS.md + docs/ai/ + Node scripts + pre-commit hook

optional backends (set up once per machine, NOT by init):
   codex (execute / review)  |  antigravity (review / probe)
   `- read the deployed memory as context (codex auto; agy if it wins)
```

- **kit** (`@sabaiway/agent-workflow-kit`) — the composition root + entry point. Detects the
  substrate, delegates or falls back, and **injects the methodology**.
- **memory** (`@sabaiway/agent-workflow-memory`) — the standalone substrate (`AGENTS.md` +
  `docs/ai/` with caps / archive / index gate). The kit uses a **standalone** copy if present,
  else its bundled fallback — same `docs/ai/` either way.
- **engine** (`agent-workflow-engine`) — a stub (`available: false`); the *future* home of the
  methodology the kit injects today. Not shipped yet.
- **bridges** — optional execution backends (below) that *can read* the deployed memory as their
  context file.

---

## 🔍 How it works (60 seconds)

- **Layered, lazy loading** — *always-loaded* = `AGENTS.md` + `index.md` (small, cache-warm);
  *on-demand* = open a `docs/ai/` file only when its "Read When" applies.
- **Caps + freshness** — every doc declares a `maxLines` cap; a pre-commit hook blocks commits
  that bust a cap or let the auto-generated index go stale.
- **3-tier rolling archive** — `changelog.md` (HOT) → `history/recent.md` (WARM) → per-month
  COLD. Hot files stay small forever.
- **Plan lifecycle** — Plan → Phase → Step, ephemeral plan files, a **mandatory Cleanup phase**.
- **No silent failures** — every guard that rejects an action surfaces a real error.

Enforcement ships as dependency-free **Node ≥ 18** scripts; non-Node projects follow the policy
by hand.

---

## 🔌 Optional delegated execution (the bridges)

Two optional backends let your orchestrator hand bounded sub-tasks to another model under **your
own subscription** (no pay-as-you-go):

- **`codex-cli-bridge`** — wraps OpenAI `codex` for **execute / review** under a ChatGPT subscription.
- **`antigravity-cli-bridge`** — wraps Google `agy` for **review / probe** under a Google AI subscription.

Honest caveats:

- They are **agent skills, not npm packages**, and are **not placed by `init`** (it only bundles
  them in the kit tarball). `/agent-workflow-kit setup` does the **link-only** part — places the
  bundled bridge skill + links its wrappers — while the **binary install** and the **interactive
  subscription login stay manual** (they can't be safely automated).
- Their context provider is the deployed memory — but not unconditionally (`codex` auto-reads
  `AGENTS.md`; `agy` reads `.antigravity.md` > `GEMINI.md` > `AGENTS.md`, so a higher-priority
  file shadows it).
- They call **third-party services** (`codex` / `agy`); the "no telemetry" claim covers this
  family's own code, not those external services.

`/agent-workflow-kit backends` checks readiness **read-only** (marker-file presence — it never
runs a subscription CLI or changes the machine); `/agent-workflow-kit setup` then does the link-only
setup (place skill + link wrappers). See each bridge's
[`codex-cli-bridge/SKILL.md`](codex-cli-bridge/SKILL.md) ·
[`antigravity-cli-bridge/SKILL.md`](antigravity-cli-bridge/SKILL.md) and its `setup/README.md`.

---

## 🧭 Choose the right member

| Member | When you need it | Distribution | Start here |
|---|---|---|---|
| **agent-workflow-kit** | almost everyone — the entry point | npm | [README](agent-workflow-kit/README.md) |
| **agent-workflow-memory** | the substrate only, without the methodology (rare) | npm | [README](agent-workflow-memory/README.md) |
| **codex-cli-bridge** | delegated execute / review via `codex` | agent skill (bundled; `setup` places + links) | [SKILL](codex-cli-bridge/SKILL.md) |
| **antigravity-cli-bridge** | delegated review / probe via `agy` | agent skill (bundled; `setup` places + links) | [SKILL](antigravity-cli-bridge/SKILL.md) |
| **agent-workflow-engine** | *not available yet* (future methodology engine) | stub (`available: false`) | [capability.json](agent-workflow-engine/capability.json) |

Most people only ever need the **kit**. Each per-package README / SKILL stays the source of truth
for its detailed commands and operating policy — this front door summarizes and routes, it does
not duplicate them.

---

<details>
<summary>🗂️ <b>Repo layout & contributing</b></summary>

This is a monorepo (npm workspaces) for the whole family.

| Package | npm | Role |
|---|---|---|
| [`agent-workflow-kit`](agent-workflow-kit) | `@sabaiway/agent-workflow-kit` | composition root: detects the substrate, delegates or falls back, injects the methodology, ships the manifest schema + validator + backend detector |
| [`agent-workflow-memory`](agent-workflow-memory) | `@sabaiway/agent-workflow-memory` | standalone memory substrate: `AGENTS.md` + `docs/ai/` with cap / archive / index enforcement |

- `codex-cli-bridge` · `antigravity-cli-bridge` — in-repo agent skills (not npm workspaces); each
  declares its role + detection contract in `capability.json`.
- `agent-workflow-engine` — declared-but-unbuilt stub (`available: false`).
- **Publish order is memory before kit** (the kit may delegate to memory at deploy time).
- The deployment-lineage stamp is independent of the npm package versions; both packages stamp
  the shared lineage head.
- `docs/plans/` is machine-local and is never committed (see `.gitignore`).
- Shipped Node scripts stay dependency-free and support Node ≥ 18. Run the repo's test,
  manifest-validate, release-scan, and docs-caps checks before proposing a commit.

</details>

---

<div align="center">
<sub>Kernel-only · stack-agnostic · cross-agent · no telemetry in family code — <a href="https://github.com/sabaiway/agent-workflow">sabaiway/agent-workflow</a></sub>
</div>
