<div align="center">

# 🧠 agent-workflow-kit

**Durable, cross-agent memory & workflow for AI coding agents — the one command that installs it.**

*Run it once per machine, deploy it once per project — then every future session boots from a
small, structured memory instead of re-reading your whole repo and re-deriving yesterday's
decisions. Works with Claude Code, Codex, Cursor, and any agent that reads `AGENTS.md`.*

[![npm version](https://img.shields.io/npm/v/@sabaiway/agent-workflow-kit?logo=npm)](https://www.npmjs.com/package/@sabaiway/agent-workflow-kit)
[![npm downloads](https://img.shields.io/npm/dm/@sabaiway/agent-workflow-kit)](https://www.npmjs.com/package/@sabaiway/agent-workflow-kit)
[![license](https://img.shields.io/npm/l/@sabaiway/agent-workflow-kit)](./LICENSE)
[![node](https://img.shields.io/node/v/@sabaiway/agent-workflow-kit)](https://nodejs.org)

`Node ≥ 18`  ·  `dependency-free scripts`  ·  `no telemetry in family code`

**One command to start:**

```bash
npx @sabaiway/agent-workflow-kit@latest init
```

<sub>This installs the **global skill** — deploying into a project is a separate step ([below](#-install)).</sub>

**Works with any tool that reads `AGENTS.md`** — Claude Code · Codex · Cursor · Devin Desktop (formerly Windsurf) · GitHub Copilot · Gemini CLI · Cline · Aider · and 20+ more.

**Quick-jump:** [Install](#-install) · [What it deploys](#-what-it-deploys-into-your-project) · [How it works](#-how-it-works-60-seconds) · [Composition root](#-the-composition-root-of-the-family)

</div>

---

> **Part of the [`agent-workflow`](https://github.com/sabaiway/agent-workflow) family.** This package
> is the **composition root** + entry point: it **delegates** memory deployment to the substrate,
> **injects** the workflow methodology, and **detects** optional execution backends. This page is the
> kit's **manual** (install · commands · what it deploys) — for the whole-family story, start at the
> **[family front door](https://github.com/sabaiway/agent-workflow#readme)**.

---

## ❓ The problem

AI coding agents are **stateless between sessions**. Every new chat starts from zero:

```
── new session, no kit ───────────────────
    ▶ "continue the feature"
        ↓
    reads 18 files… greps ×6…
    re-infers the architecture…
    re-asks a decision you settled…
        ↓  (15k–40k tokens later)
    …finally starts working
──────────────────────────────────────────
→ re-derives what it knew yesterday, and
  re-introduces a bug you already fixed
```

No durable handover ⇒ **drift between sessions, repeated mistakes, ballooning token cost.**

---

## ⚡ Without vs. With

The kit gives the agent a small, structured **memory** it reads at the start of every
session — instead of rebuilding context from source each time.

```
WITHOUT the kit · cold start, cost grows
  s1  ~30k tok  ██████████
  s2  ~28k tok  █████████    ← repeats a fixed bug
  s3  ~34k tok  ███████████  ← drift

WITH the kit · boots from memory, cost flat
  s1   ~4k tok  █
  s2   ~4k tok  █            ← no drift
  s3   ~5k tok  █            ← decisions kept
```

<sub>*Illustrative/directional, not a measured guarantee — exact numbers scale with repo size. The point is the **shape**: cold re-reads that grow vs. a flat, cache-warm boot.*</sub>

| | 🚫 Without | ✅ With `agent-workflow-kit` |
|---|---|---|
| **Session boot** | re-read source + grep to rebuild context | read a few small docs, ~constant |
| **Boot cost** | grows with repo, paid every session | flat; stable layer stays prompt-cache-warm |
| **Cross-session memory** | none | `handover` (where we left off) |
| **Past decisions** | re-litigated | `decisions.md` (ADRs) — settled once |
| **Known bugs** | re-discovered | `known_issues.md` — impact + workaround |
| **Doc growth** | unbounded sprawl | frontmatter caps + 3-tier rolling archive |
| **Drift** | docs ≠ code over time | pre-commit gate keeps them honest |
| **Cross-agent** | re-explain the project to each tool | one `AGENTS.md`, read by 20+ agents |

---

## 📦 What it deploys into your project

Invoking the skill **inside a project** creates a portable memory and its maintenance policy:

```
your-repo/
├── AGENTS.md              ← single entry point
├── CLAUDE.md → AGENTS.md  ← symlink, for Claude Code
└── docs/ai/
    ├── index.md           ← auto-generated navigator
    ├── handover.md        ← where we left off (read first)
    ├── active_plan.md     ← current task
    ├── agent_rules.md     ← session protocols + self-review
    ├── current_state.md   ← snapshot of the codebase now
    ├── architecture.md    ← layers & boundaries
    ├── technical_specification.md
    ├── decisions.md       ← ADRs — settled once
    ├── known_issues.md    ← bugs + workarounds
    ├── changelog.md       ← rolling, then archived
    ├── env_commands.md    ← daily commands
    ├── tech_reference.md  ← configs & patterns
    ├── pages/             ← one spec per page/route
    └── history/           ← archive (HOT→WARM→COLD)
  + scripts/               ← caps · index · archive (Node path)
  + pre-commit hook        ← keeps it all honest    (Node path)
```

The Markdown memory is **stack-agnostic**; the `scripts/` + pre-commit hook are the **Node path**
(dependency-free, `node --test`). Non-Node projects keep the same policy by hand.

Two **visibility** modes, chosen at deploy time: **visible** (committed with the repo) or **hidden**
(same files in-tree but git-ignored via the global `core.excludesFile`, so the repo "looks normal").
Hidden changes how the files are *tracked*, not where agents find them.

---

## 🚀 Install

### 1. Install the global skill — once per machine

```bash
npx @sabaiway/agent-workflow-kit@latest init
```

`init` installs/refreshes the skill at `~/.claude/skills/agent-workflow-kit/` and wires launchers for
any Claude Code / Codex / Devin Desktop it finds. It **does not** deploy into a project, and **does
not** install the optional bridges.

### 2. Deploy into a project — once per repo

Invoke the installed skill **inside the target repository** — first time vs. already-deployed use
different sub-commands:

| Agent | First time in the project | Project already has the kit |
|-------|---------------------------|-----------------------------|
| **Claude Code** | `/agent-workflow-kit` | `/agent-workflow-kit upgrade` |
| **Codex** | `/skills` menu → `agent-workflow-kit` | …→ `agent-workflow-kit upgrade` |
| **Devin Desktop** (Windsurf · Devin Local) | `/agent-workflow-kit` | `/agent-workflow-kit upgrade` |

<sub>`/agent-workflow-kit` bootstraps a fresh deployment (and asks your **visibility**, **conversational language**, and whether the agent may **attribute work to itself / AI** — default off); `/agent-workflow-kit upgrade` migrates an existing one to the kit's current version.</sub>

> **Optional standalone memory substrate.** The memory layer is also published standalone as
> [`@sabaiway/agent-workflow-memory`](https://www.npmjs.com/package/@sabaiway/agent-workflow-memory).
> If a **healthy** copy is installed (the kit validates it with its own shipped validator), the kit
> **delegates** substrate deployment to it and injects the workflow methodology; otherwise it uses
> its **own bundled copy** — the one command above keeps working with no new dependency. Same
> `docs/ai/` either way.

### Refresh the kit itself — same command with `@latest`

```bash
npx @sabaiway/agent-workflow-kit@latest init
```

<sub>That refreshes the **kit's own files** in `~/.claude/skills/` — distinct from `/agent-workflow-kit upgrade`, which migrates a **project's** deployment (see **Use** below).</sub>

<details>
<summary><b>Manual install</b> — no <code>npx</code></summary>

The kit is a single self-contained folder inside the `agent-workflow` monorepo. Clone the repo
and copy the kit into a skill scope yourself, then run the launcher:

```bash
git clone https://github.com/sabaiway/agent-workflow
cp -r agent-workflow/agent-workflow-kit ~/.claude/skills/agent-workflow-kit
cd ~/.claude/skills/agent-workflow-kit
bash launchers/install-launchers.sh
```

`install-launchers.sh` auto-detects Codex **and** Devin Desktop — it only touches tools you actually
have. See [`launchers/README.md`](launchers/README.md) for the full matrix (incl. Cursor / any
other agent). The manual path works identically but **isn't reflected in install stats** — prefer
`npx` if you don't mind.
</details>

<details>
<summary><b>What <code>init</code> touches — and how to undo it</b></summary>

`init` is **additive — it never deletes your settings.** It writes only its own namespaced slots:

| Path | What |
|------|------|
| `~/.claude/skills/agent-workflow-kit/` | the kit itself (refreshed on every `init`) |
| `~/.codex/skills/agent-workflow-kit` | a symlink — only if you have Codex |
| `…/global_workflows/agent-workflow-kit.md` | a managed file — only if you have Devin Desktop |

Your other Codex skills and Devin Desktop workflows are never touched. If one of those exact slots
already holds a file the kit didn't write, it is **left alone** and you're told — re-run with
`--force` to replace it (the original is first copied to `*.bak.<timestamp>` and the restore
command is printed).

**Uninstall:** delete the slots above (the kit folder, the symlink, the workflow file).
</details>

---

## 🛠️ Use

| Command | When | What happens |
|---------|------|--------------|
| `/agent-workflow-kit` | new / empty project | recon → **asks visible-or-hidden** + **conversational language** + **agent attribution** (default off) → deploys `AGENTS.md` + `docs/ai/` filled with real recon data → installs enforcement → **asks before committing** |
| `/agent-workflow-kit upgrade` | existing deployment | reads `docs/ai/.workflow-version`, shows the changelog diff, preserves your authored memory, applies migrations, re-stamps — then prints a **read-only** one-line backend-status line (what's set up vs missing); never installs a bridge — set one up with `/agent-workflow-kit setup` |
| `/agent-workflow-kit backends` | any time | **read-only** check of the optional execution-backends (the `codex` / `agy` bridges): what's set up vs missing and the next step. Never writes, never commits, never runs a subscription CLI (credentials = marker-file presence, not a live login). |
| `/agent-workflow-kit setup [backend]` | opt-in, any time | **link-only** auto-setup of a bridge: places the bundled bridge skill (only into an absent / empty / managed dir — never overwrites an unmanaged one) + links its wrappers onto `PATH` via managed symlinks (idempotent; refuses to clobber a non-symlink; try `--dry-run` to preview). The binary install + the one-time subscription login stay **manual**: it prints the exact **login** command and points the binary install at each bridge's `setup/README.md`. POSIX wrappers — on Windows use WSL. Never commits, never runs a subscription CLI. |

It **never auto-commits** and **never overwrites** an existing `AGENTS.md` without asking.

> **Two kinds of "upgrade":** `npx @sabaiway/agent-workflow-kit@latest init` updates the **kit's
> own files** in `~/.claude/skills/`; `/agent-workflow-kit upgrade` then migrates a **project's**
> `docs/ai/` deployment to that kit version.

---

## 🔍 How it works (60 seconds)

- **Layered, lazy loading** — *always-loaded* = `AGENTS.md` + `index.md` (~160 lines, cache-warm). *On-demand* = open a `docs/ai/` file only when its "Read When" applies. *Hierarchical* = subdir `AGENTS.md` loads when you work in that folder. *Archive* = old history rolls out of the hot files.
- **Caps + freshness** — every doc declares a `maxLines` cap; a pre-commit hook blocks commits that bust a cap or let the auto-generated index go stale.
- **3-tier rolling archive** — `changelog.md` (HOT, last days) → `history/recent.md` (WARM) → per-month COLD + a one-line condensed index. Hot files stay small forever.
- **Plan lifecycle** — Plan → Phase → Step → Substep, ephemeral plan files, a mandatory Cleanup phase, and a session-continuity heuristic tuned for large-context models (e.g. Claude Opus).
- **No silent failures** — every guard that rejects an action logs structured context.

Enforcement ships as dependency-free **Node** scripts (`node --test`, no package manager assumed). Non-Node projects follow the same policy by hand.

---

## 🧩 The composition root of the family

The kit is the member you install — the family's **composition root**. `npx … init` only installs
the kit globally; the composition happens when you **deploy it in a repo** (`/agent-workflow-kit`):

```
agent-workflow-kit  —  the composition root (installed via npx … init)
   on /agent-workflow-kit in a repo, the kit:
   ├─ delegates ─▶ memory substrate   (healthy copy, else bundled fallback)
   ├─ injects   ─▶ workflow methodology  (engine = future supplier; stub)
   ├─ deploys   ─▶ AGENTS.md + docs/ai/ + Node scripts + pre-commit hook
   ├─ detects   ─▶ optional backends   (codex / agy, read-only)
   └─ sets up   ─▶ a bridge (opt-in)   (place skill + link wrappers)
```

- **Delegates** substrate deployment to **`@sabaiway/agent-workflow-memory`** when a healthy
  standalone copy is present, else uses its **bundled fallback** — same `docs/ai/` either way.
- **Injects** the bounded workflow methodology into the deployed `AGENTS.md`. Its *future* home is
  **`agent-workflow-engine`** — today an `available: false` stub, never one of the shipped backends.
- **Detects & (opt-in) sets up** the optional `codex` / `agy` **bridges** — agent skills (not npm, not
  installed by `init`). They plug into the workflow's **execute** and **review** phases — for *what
  each adds and why*, see the
  [family front door](https://github.com/sabaiway/agent-workflow#readme). `/agent-workflow-kit backends`
  reports readiness **read-only**;
  `/agent-workflow-kit setup` does the **link-only** part (place the bundled bridge skill + link its
  wrappers), while the binary install + the subscription login stay manual. A bridge reads the deployed
  memory only if it wins that tool's context-file priority, and the bridges call third-party services
  (so "no telemetry" covers family code, not those).

> Full member-by-member map + the whole-family story: the
> **[family front door](https://github.com/sabaiway/agent-workflow#readme)** — this page stays the
> kit's manual.

---

## 🤝 Cross-agent by design

One kit, two tiers — **no logic is duplicated per tool:**

- The **output** (`AGENTS.md` + `docs/ai/`) is read natively by Claude Code (via the `CLAUDE.md`
  alias) · Codex · Cursor · Devin Desktop · Copilot · Gemini CLI & 20+ tools.
- The **bootstrapper** runs from Claude Code · Codex · Devin Desktop — their launchers point at the
  same `SKILL.md`, so deployment logic lives in one place.

---

## 📁 What's in the kit

```
agent-workflow-kit/
├── README.md        ← you are here (the kit's manual)
├── SKILL.md         ← agent-facing deploy / upgrade algorithm
├── CHANGELOG.md     ← version history
├── capability.json  ← agent-workflow family manifest (composition-root)
├── references/
│   ├── templates/   ← AGENTS.md + every docs/ai file
│   ├── scripts/     ← caps / archive / index + tests
│   ├── contracts.md ← visibility / language / attribution rules
│   └── planning.md  ← plan lifecycle + continuity
├── tools/           ← family tooling:
│   ├── manifest/    ← capability-manifest schema + validator
│   ├── delegation.mjs        ← detect substrate · delegate-or-fall-back
│   ├── inject-methodology.mjs ← write the methodology slot
│   ├── detect-backends.mjs    ← read-only backend detector
│   ├── setup-backends.mjs     ← link-only backend setup
│   ├── fs-safe.mjs            ← symlink-safe copy/link
│   └── release-scan.mjs       ← attribution / release gate
├── bridges/         ← bundled bridge skill mirrors (codex / antigravity)
├── launchers/       ← Codex / Devin Desktop / Cursor entries
└── migrations/      ← per-version upgrade steps
```

---

<div align="center">
<sub>Kernel-only · stack-agnostic · no telemetry in family code · distilled from a multi-year-verified reference implementation — <a href="https://github.com/sabaiway/agent-workflow">sabaiway/agent-workflow</a></sub>
</div>
