<div align="center">

# 🧠 agent-workflow-kit

**A portable, cross-agent memory & workflow system for AI coding agents.**

*Bootstrap it once — then every future session reconstructs project context in seconds
instead of re-reading your whole repo.*

[![npm version](https://img.shields.io/npm/v/@sabaiway/agent-workflow-kit?logo=npm)](https://www.npmjs.com/package/@sabaiway/agent-workflow-kit)
[![npm downloads](https://img.shields.io/npm/dm/@sabaiway/agent-workflow-kit)](https://www.npmjs.com/package/@sabaiway/agent-workflow-kit)
[![license](https://img.shields.io/npm/l/@sabaiway/agent-workflow-kit)](./LICENSE)
[![node](https://img.shields.io/node/v/@sabaiway/agent-workflow-kit)](https://nodejs.org)

`v1.4.0`  ·  `Node ≥ 18`  ·  `kernel-only`

**Works with any tool that reads `AGENTS.md`** — Claude Code · Codex · Cursor · Devin Desktop (formerly Windsurf) · GitHub Copilot · Gemini CLI · Cline · Aider · and 20+ more.

</div>

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

<sub>*Illustrative — exact numbers scale with repo size. The point is the **shape**: cold re-reads that grow vs. a flat, cache-warm boot.*</sub>

| | 🚫 Without | ✅ With `agent-workflow-kit` |
|---|---|---|
| **Session boot** | re-read source + grep to rebuild context | read 4 small docs, ~constant |
| **Boot cost** | grows with repo, paid every session | flat; stable layer stays prompt-cache-warm |
| **Cross-session memory** | none | `handover` (where we left off) |
| **Past decisions** | re-litigated | `decisions.md` (ADRs) — settled once |
| **Known bugs** | re-discovered | `known_issues.md` — impact + workaround |
| **Doc growth** | unbounded sprawl | frontmatter caps + 3-tier rolling archive |
| **Drift** | docs ≠ code over time | pre-commit gate keeps them honest |

---

## 📦 What it deploys into your project

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
  + scripts/               ← caps · index · archive (Node)
  + pre-commit hook        ← keeps it all honest
```

Two visibility modes, chosen at bootstrap: **visible** (committed) or **hidden**
(in-tree but git-ignored, so the repo "looks normal").

---

## 🚀 Install

**One command** installs the kit into `~/.claude/skills/` and wires any Codex / Devin Desktop you have:

```bash
npx @sabaiway/agent-workflow-kit init
```

Then invoke it **inside a project** — first time vs. already-deployed use different sub-commands:

| Agent | First time in the project | Project already has the kit |
|-------|---------------------------|-----------------------------|
| **Claude Code** | `/agent-workflow-kit` | `/agent-workflow-kit upgrade` |
| **Codex** | `/skills` menu → `agent-workflow-kit` | …→ `agent-workflow-kit upgrade` |
| **Devin Desktop** (Windsurf · Devin Local) | `/agent-workflow-kit` | `/agent-workflow-kit upgrade` |

<sub>`/agent-workflow-kit` bootstraps a fresh deployment (and asks your **visibility**, **conversational language**, and whether the agent may **attribute work to itself / AI** — default off); `/agent-workflow-kit upgrade` migrates an existing one to the kit's current version. The `npx … init` above is a third, separate thing — it updates the **kit itself**, not any project.</sub>

> **New in 1.4.0 — optional memory substrate.** The memory layer is now also published
> standalone as [`@sabaiway/agent-workflow-memory`](https://www.npmjs.com/package/@sabaiway/agent-workflow-memory).
> If it is installed, the kit **delegates** substrate deployment to it and injects the workflow
> methodology; if not, the kit uses its **own bundled copy** — the one command above keeps
> working with no new dependency. Same `docs/ai/` either way.

**Upgrade the kit itself** later — same command with `@latest`:

```bash
npx @sabaiway/agent-workflow-kit@latest init
```

<sub>That refreshes the **kit's own files** — distinct from `/agent-workflow-kit upgrade`, which migrates a **project's** deployment (see **Use** below).</sub>

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
| `/agent-workflow-kit upgrade` | existing deployment | reads `docs/ai/.workflow-version`, shows the changelog diff, applies migrations, re-stamps |

It **never auto-commits** and **never overwrites** an existing `AGENTS.md` without asking.

> **Two kinds of "upgrade":** `npx @sabaiway/agent-workflow-kit@latest init` updates the **kit's
> own files** in `~/.claude/skills/`; `/agent-workflow-kit upgrade` then migrates a **project's**
> `docs/ai/` deployment to that kit version.

---

## 🔍 How it works (60 seconds)

- **Layered, lazy loading** — *always-loaded* = `AGENTS.md` + `index.md` (~160 lines, cache-warm). *On-demand* = open a `docs/ai/` file only when its "Read When" applies. *Hierarchical* = subdir `AGENTS.md` loads when you work in that folder. *Archive* = old history rolls out of the hot files.
- **Caps + freshness** — every doc declares a `maxLines` cap; a pre-commit hook blocks commits that bust a cap or let the auto-generated index go stale.
- **3-tier rolling archive** — `changelog.md` (HOT, last days) → `history/recent.md` (WARM) → per-month COLD + a one-line condensed index. Hot files stay small forever.
- **Plan lifecycle** — Plan → Phase → Step → Substep, ephemeral plan files, a mandatory Cleanup phase, and a session-continuity heuristic tuned for large-context models (e.g. Opus 4.8).
- **No silent failures** — every guard that rejects an action logs structured context.

Enforcement ships as dependency-free **Node** scripts (`node --test`, no package manager assumed). Non-Node projects follow the same policy by hand.

---

## 🤝 Cross-agent by design

One kit, three front doors — the *output* (`AGENTS.md` + `docs/ai/`) is read natively by
Codex, Cursor, Devin Desktop, Copilot, Gemini CLI & 20+ tools, and the *bootstrapper* runs from
Claude Code, Codex, or Devin Desktop. No logic is duplicated per tool.

---

## 📁 What's in the kit

```
agent-workflow-kit/
├── README.md        ← you are here
├── SKILL.md         ← agent-facing algorithm
├── CHANGELOG.md     ← version history
├── capability.json  ← agent-workflow family manifest (composition-root)
├── references/
    ├── templates/   ← AGENTS.md + every docs/ai file
    ├── scripts/     ← caps / archive / index + tests
    ├── contracts.md ← visibility / language / attribution rules
    └── planning.md  ← plan lifecycle + continuity
├── tools/           ← family tooling: manifest schema + validator, methodology-slot injection
├── launchers/       ← Codex / Devin Desktop / Cursor entries
└── migrations/      ← per-version upgrade steps
```

---

<div align="center">
<sub>Kernel-only · stack-agnostic · distilled from a multi-year-verified reference implementation.</sub>
</div>
