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
(same files in-tree but git-ignored via the project-local `.git/info/exclude`, so the repo "looks
normal" — one managed block covering the full AI/agent footprint, scoped to this repo, never
machine-wide). Hidden changes how the files are *tracked*, not where agents find them.

---

## 🚀 Install

### 1. Install the global skill — once per machine

```bash
npx @sabaiway/agent-workflow-kit@latest init
```

`init` installs/refreshes the skill at `~/.claude/skills/agent-workflow-kit/` and wires launchers for
any Claude Code / Codex / Devin Desktop it finds. It **does not** deploy into a project, and **never
places** the optional bridges — **once placed** (by `/agent-workflow-kit setup`) it **refreshes** them
from its bundled copies (never a downgrade; skip with `--no-bridges`).

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
> its **own bundled copy** — the one command above keeps working with **no new dependency on the
> memory substrate**. Same `docs/ai/` either way. (The **methodology slot** is a separate axis: its
> fragment is read **live from the installed `agent-workflow-engine`**, which `npx … init` installs
> for you — a runtime dependency placed by `init`, read live.)

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

`init` is **additive — it never deletes your settings.** It writes its own namespaced slots, then
refreshes the other npm core members so a returning `init` leaves **no stale core member**:

| Path | What |
|------|------|
| `~/.claude/skills/agent-workflow-kit/` | the kit itself (refreshed on every `init`) |
| `~/.claude/skills/agent-workflow-memory/` | the **memory substrate**, refreshed via `npx @sabaiway/agent-workflow-memory@latest init` — **best-effort:** a failure is a **loud degraded success** (warning + the exact recovery command + exit 0), never silent; skip with `--no-memory` |
| `~/.claude/skills/agent-workflow-engine/` | the **methodology engine** the kit reads live, refreshed via `npx @sabaiway/agent-workflow-engine@latest init` — **required** (the live read STOPs without it); skip with `--no-engine` |
| `~/.claude/skills/{codex,antigravity}-cli-bridge/` | the placed **bridges**, refreshed from the kit's bundled copies (local files, no network) — **only if `/agent-workflow-kit setup` already placed them**: an absent bridge is never placed, a newer one never downgraded; skip with `--no-bridges` |
| `~/.codex/skills/agent-workflow-kit` | a symlink — only if you have Codex |
| `…/global_workflows/agent-workflow-kit.md` | a managed file — only if you have Devin Desktop |

The **execution-backend bridges** (`codex` / `agy`) are never first **placed** by `init` — set one up
on demand with `/agent-workflow-kit setup`; after that, a returning `init` keeps the placed copy
fresh (the table row above). Your other Codex skills and Devin Desktop workflows are
never touched. If one of those exact slots already holds a file the kit didn't write, it is **left
alone** and you're told — re-run with `--force` to replace it (the original is first copied to
`*.bak.<timestamp>` and the restore command is printed).

**Uninstall:** delete the slots above (the kit / memory / engine folders, the symlink, the workflow
file), or run the guarded `/agent-workflow-kit uninstall`.
</details>

---

## 🛠️ Use

| Command | When | What happens |
|---------|------|--------------|
| `/agent-workflow-kit` | new / empty project | recon → **asks visible-or-hidden** + **conversational language** + **agent attribution** (default off) → deploys `AGENTS.md` + `docs/ai/` filled with real recon data → installs enforcement → **asks before committing** |
| `/agent-workflow-kit upgrade` | existing deployment | reads `docs/ai/.workflow-version`, shows the changelog diff, preserves your authored memory, applies migrations, re-stamps — then prints a **read-only** one-line backend-status line (what's set up vs missing); refreshes the already-placed bridges from the kit's bundled copies (never installs a new one — set one up with `/agent-workflow-kit setup`) |
| `/agent-workflow-kit help` | any time | **read-only command index** — every command, grouped (Inspect / Configure / Orchestrate / Lifecycle) and tagged read-only / writer / guarded. The discoverable entry point, and where any unrecognized invocation lands (always read-only — a garbage invocation never writes). Never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit backends` | any time | **read-only** check of the optional execution-backends (the `codex` / `agy` bridges): what's set up vs missing and the next step. Never writes, never commits, never runs a subscription CLI (credentials = marker-file presence, not a live login). |
| `/agent-workflow-kit gates` | any time | **project gate runner** — runs the verification commands **your project itself declares** in `docs/ai/gates.json` (seeded at deploy; hand-editable `{ id, title, cmd }` entries, each `cmd` one bash line) as one batch: a per-gate **PASS/FAIL table** + one machine-readable summary line, exit 0 iff all green; a failing gate's own output is shown verbatim; `--only <id>` re-runs one. Honest distinct outcomes for a missing / empty / malformed declaration — never a silent green. The runner writes nothing **by default** and never commits — opt-in `--record` mints ONE `gate-run` record into the review ledger **via the ledger's sole writer** (the segment's green-baseline receipt: full declaration + what ran + pre/post tree fingerprints; a red run records honestly; a failed record is its own loud exit 7); it executes only your own declared commands (a batching convenience, not a sandbox). The velocity tier auto-approves only the exact no-`--record` form — the recording run stays explicit. |
| `/agent-workflow-kit setup [backend]` | opt-in, any time | **link-only** auto-setup of a bridge: places the bundled bridge skill (only into an absent / empty / managed dir — never overwrites an unmanaged one) + links its wrappers onto `PATH` via managed symlinks (idempotent; refuses to clobber a non-symlink; try `--dry-run` to preview). The binary install + the one-time subscription login stay **manual**: it prints the exact **login** command and points the binary install at each bridge's `setup/README.md`. POSIX wrappers — on Windows use WSL. Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit status` | any time | **read-only** single view of **versions + deployment + settings + bridges**: which members (kit / memory / engine / the two bridges) are installed and at what version (with an honest "installed on this machine" note when one is behind) and — in a project — what's deployed (`docs/ai`, the version stamps, and the **visibility**: visible / hidden / unclear), plus your settings (orchestration recipes, attribution, velocity) and the bridges' readiness. The two version axes (package number vs deployment-structure head) stay decoupled. Never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit recipes` | any time | **read-only** orchestration advisor: presents four named recipes for composing the bridges into plan → execute → review — **Solo / Reviewed / Council / Delegated** — plans + recommends one for your environment (degrading with a stated reason when a backend isn't ready), and offers the choice. The orchestrator runs it via the bridge skills and **always commits**; the kit never executes a recipe, never runs a subscription CLI, never commits. |
| `/agent-workflow-kit procedures <activity>` | any time | **read-only** activity-procedures advisor: prints a named activity's ordered steps (`plan-authoring` / `plan-execution`) read **live** from the engine, plus the **resolved recipe per slot** from your `docs/ai/orchestration.json` (agent-writable via `set-recipe`, or hand-edited) + backend readiness (default Reviewed when a backend is ready, Council on request, slot-aware incl. Delegated) — and, for every dispatched backend, the **full driving contract at the point of use** (exact copy-pasteable invocation, grounding levers like agy's `--facts`/`--decided`, the round-2 `--continue` delta, guarded passthrough), verbatim from the bridge manifests (drift-guarded; each wrapper's `--help` prints the same). `--override <slot>=<recipe>` adjusts one slot per run. Composes with `recipes`; never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit set-recipe` | any time | **config writer** for `docs/ai/orchestration.json`: tell the agent your preference in plain language and it maps it to explicit `--set <activity>.<slot>=<recipe>` / `--unset` ops; the kit validates, **previews by default**, and writes only on `--write` (deployment-gated, atomic, symlink/TOCTOU-safe), resolving the effective recipe vs live readiness. Writes **only** that file — **never runs a backend, never commits**; hand-editing stays fully supported. |
| `/agent-workflow-kit review-state` | any time | **read-only review-receipt checker** — makes "reviewed ≠ shipped" detectable: the bridge review wrappers append a receipt per successful review (into a file inside the git dir — never committable); this checks that every backend your configured `plan-execution.review` recipe names holds a **fresh, grounded receipt for the current uncommitted tree** (any later edit moves the fingerprint and stales the receipt; a review continuation never re-attests a folded tree). `--check` gives a gate exit code to declare in `docs/ai/gates.json` **by hand or via the consent-gated seeder** (preview → your explicit yes; never without consent). `--await [--timeout <s>]` (AD-049) BLOCKS until every recipe-named backend has receipted the current tree — the durable completion signal is the receipt, never a process event — so you wait for the bridges instead of hand-polling. Never writes, never commits, never runs a subscription CLI; it spawns read-only `git` queries to fingerprint the tree — and `git commit --no-verify` stays possible (discipline, not a sandbox). |
| `/agent-workflow-kit grounding` | any time | **grounded-review facts assembler** — mechanizes populating `agy-review --facts @f`: slices your entry-point's **Hard Constraints** section verbatim (exactly one match, else a loud stop) and/or a plan's decision-bearing sections (`## Approach` + `## Verification` required, `## Decisions (locked)` when present; duplicates stop), under the same byte budget the agy wrapper enforces (minus `--reserve-bytes` for the artifact share), with a loud tail-trim on overflow. `--ledger-summary` (AD-049) appends a COMPUTED review-ledger digest for the single in-flight segment (rounds · origins · classifications · verdicts · overrides — unrelated loops excluded), so the reviewer sees the loop's own history without hand-copying. Prints to stdout; `--out` writes **one scratch file only** (gitignored / outside the repo — a tracked or not-ignored in-repo path is refused). Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit review-ledger` | any time | **review-round ledger** — turns the review-loop stop rule into a **computed** signal: record each plan-execution review round, its triage, and any recorded **overrides** (`oracle-change` lifts named tampered test files; `red-proof` waives the observed-red proof for exactly one `testId`; v4 adds **`size-cap`** — the exact sanctioned magnitude for a surface over the diff cap, segment-scoped — all loud, durable, auditable waivers, never silent) into a JSONL ledger inside the git dir (never committable), and read the stop decision (`converged > resolved-residual > triage-required > continue`) from the records — never from a remembered rule. **Since v4 every record carries `base` = the HEAD commit and the whole loop is SEGMENT-scoped (AD-048):** round numbering, the caps, and every tooth reset ONLY at a gated commit — a multiphase plan records fully while round 4 within one segment stays refused; `gate-run` records (minted by `gates --record`) make gates-before-review a computed precondition; the triage class **`refuted`** is the honest phantom-finding lane (grounds mandatory); `--telemetry` renders counts-only gate-efficacy data across all loops and both ledgers. `--status` replaces the hand-composed per-round tally; `record --from-receipts` (AD-049) DRAFTS the `backends[]` from the current-fingerprint receipts (verdict per backend, counts from the supplied findings) instead of hand-composing them — a recipe-named backend with no receipt is a loud stop; `--check` is a fail-closed gate exit code for `docs/ai/gates.json` (by hand or via the consent-gated seeder). A `fixable-bug` triage **requires its red→green `testId`** (v1..v3 records stay valid on read — old records never enter a segment). The writer refuses a round (past the hard-max, while a triage is pending, or lacking a grounded review receipt) and refuses an override outside its single in-flight loop. Honest residual: records are forgeable — self-discipline, not a security boundary. Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit fold-completeness` | any time | **fold-completeness gate** — attests the review loop's folded fixes were proven the HONEST way (no fix theater): the runner executes your suite ONCE under `NODE_V8_COVERAGE`, checks every changed executable line is **executed**, probes every bound `testId` N times (`AW_FOLD_RERUNS`), records content hashes, and scans the test surface for tamper; the `--red` verb observes a test FAILING on the pre-fold tree — **BEFORE the fix** — and mints an **observed-red receipt**. The read-only checker (`--status` / `--check`) then requires, per bound test: the receipt, receipt-precedes-run order, N/N-green probes, and content **custody** (the green test is byte-identical to the one seen failing) — the receipt+custody half waivable for exactly one `testId` by a recorded `red-proof` override; mixed/timed-out probes are QUARANTINE (never converted, no override); **v3 records carry `base` and the proof is segment-scoped (AD-048)** — a committed phase's custody obligations close with its commit, and a receipt never crosses a commit boundary; tampered pre-existing test files fail closed unless covered by a recorded `oracle-change` override. Honest residuals: coverage proves **execution, not assertion**, and records are forgeable — self-discipline, not a security boundary. v1 scope is JS/V8 (pluggable via `AW_FOLD_BOUND_CMD`): changed TS/JSX fails closed, docs/config changes are listed but never block, and **no mutation testing ships**. Wire the gate by hand — the consent-gated seeder deliberately does not offer it yet (JS-only hold). Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit doc-parity` | any time | **read-only doc-parity lint** (AD-049) — kills the doc-drift class where a mode-contract doc silently lags a code constant (a `--check` doc still reading `300` after the diff cap moved to `400`): a **closed, exported registry** binds each live constant (review caps, schema versions, and the ledger's own class/scope vocabulary) to the exact token its `references/modes/*.md` contract must carry, and asserts the CURRENT value renders into every bound file — a drifted doc, an unreadable file, or an absent token **fails closed**. The values are sourced from the live imports (never re-typed), so the lint can't itself go stale; adding a binding is adding a checked entry (closed-world, edit-safe). `--check` is a gate exit code for `docs/ai/gates.json`. Never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit uninstall` | opt-in, any time | **guarded teardown** — the inverse of `init` / `setup`. Removes only what's **provably ours** (managed skill dirs + bridge wrappers; in a project, the hidden-mode git-ignore block it added + the pre-commit hook it installed); **never deletes** your `docs/ai` / `AGENTS.md` (prints the exact `rm` to run by hand) or your `.claude/settings.json` (prints an **edit** — remove the attribution key, review any velocity `permissions.*` — never an `rm`). Always `--dry-run` first; preflight-then-mutate; never commits. |
| `/agent-workflow-kit velocity` | Claude Code · opt-in | **onboarding velocity profile** — seeds a fixed, audited **read-only** allowlist into `.claude/settings.json` so routine read-only commands stop idling on approval prompts while you're away; opt-in `acceptEdits`; plus a **read-only advisory** of likely project gate commands to add by hand. Writes **only** `.claude/settings.json` — **never** allowlists commit/push/publish, never writes `settings.local.json`, never commits. A seeded entry is a **trust posture, not a sandbox** (a runtime residual remains at the settings level — its guard ships as the opt-in `hook` command); a direct commit/push/publish still asks. `--dry-run` first. |
| `/agent-workflow-kit agents` | Claude Code · opt-in | **cheap-lane subagents** — places bundled subagent definitions (`.claude/agents/`) pinned to a **cheap model** (haiku, low effort, read-only tools) for mechanical work: extraction sweeps, changelog fact-skeletons, gate-failure triage. Judgment, review, and real code stay on your main lane — these vehicles only extract and draft, and their output is verified. Preview by default (`--apply` writes); an existing customized file is **preserved, never overwritten**; never touches `settings*.json`, never commits. |
| `/agent-workflow-kit hook` | Claude Code · opt-in | **gate-approval hook** — places a self-contained PreToolUse hook (`.claude/hooks/`) and wires it into `.claude/settings.json`: a Bash command **byte-identical** to a gate you declared in `docs/ai/gates.json` (run from the project root) is auto-approved — no prompt, no idle; a seeded read-only command carrying a runtime residual (output redirection, command substitution, `--output` writes) now **asks** even where an allow rule would have silently passed it (proven live — hook `ask` overrides an allow rule). Exact matches only, never patterns; never `deny`; a broken `gates.json` only disables auto-approval, never the guard. Preview by default; never writes `settings.local.json`; never commits. |
| `/agent-workflow-kit bridge-settings` | opt-in, any time | **host-level bridge settings** — read or change the bridges' `KEY=VALUE` config file (`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf`), the **one place a knob survives kit upgrades** (it lives outside every kit tree; a refresh never touches it, and now states loudly if it ever overwrote a local edit). First knobs: the **codex Fast tier** (`CODEX_SERVICE_TIER=priority` — ~1.5× speed at a **2.5× credit rate**, quality-neutral, default off — a consented spend), the codex/agy hard timeouts, the review byte cap, the oversized-review add-dir toggle. Allowed keys + value rules come from the bundled bridge manifests; **model/effort are never settable** (the quality guard is untouched). **Previews by default**; refuses an unknown key, an out-of-range value, or a duplicate-carrying file; writes atomically (symlink/TOCTOU-safe). Never commits, never runs a subscription CLI. |

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
   ├─ injects   ─▶ workflow methodology  (live from the installed engine)
   ├─ deploys   ─▶ AGENTS.md + docs/ai/ + Node scripts + pre-commit hook
   ├─ detects   ─▶ optional backends   (codex / agy, read-only)
   └─ sets up   ─▶ a bridge (opt-in)   (place skill + link wrappers)
```

- **Delegates** substrate deployment to **`@sabaiway/agent-workflow-memory`** when a healthy
  standalone copy is present, else uses its **bundled fallback** — same `docs/ai/` either way.
- **Injects** two bounded pointers into the deployed `AGENTS.md` — the workflow **methodology** and the
  **orchestration recipes** (Solo / Reviewed / Council / Delegated) — read **live** from the installed
  **`agent-workflow-engine`** (the canonical narrative; a published member, never one of the shipped
  backends). `/agent-workflow-kit recipes` surfaces + plans a recipe for your environment, read-only.
- **Detects & (opt-in) sets up** the optional `codex` / `agy` **bridges** — agent skills (not npm;
  never first placed by `init` — `setup` places them, and once placed `init`/`upgrade` refresh
  them). They plug into the workflow's **execute** and **review** phases — for *what
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
  same `SKILL.md` router (which loads its `references/modes/` + `references/shared/` files per
  invocation), so deployment logic lives in one place.

---

## 📁 What's in the kit

```
agent-workflow-kit/
├── README.md        ← you are here (the kit's manual)
├── SKILL.md         ← thin agent-facing router: mode index + safe routing
├── CHANGELOG.md     ← version history
├── capability.json  ← agent-workflow family manifest (composition-root)
├── references/
│   ├── modes/       ← one file per mode (deploy/upgrade/… procedures)
│   ├── shared/      ← shared contracts (footer · hand-off · tail)
│   ├── templates/   ← AGENTS.md + every docs/ai file
│   ├── scripts/     ← caps / archive / index + tests
│   └── contracts.md ← visibility / language / attribution rules
├── tools/           ← family tooling:
│   ├── manifest/    ← capability-manifest schema + validator
│   ├── delegation.mjs        ← detect substrate · delegate-or-fall-back
│   ├── inject-methodology.mjs ← write the methodology + recipe slots
│   ├── engine-source.mjs     ← live engine fragment read (fail-loud)
│   ├── detect-backends.mjs    ← read-only backend detector
│   ├── recipes.mjs           ← read-only recipe planner (recipes)
│   ├── procedures.mjs        ← activity-procedures advisor (procedures)
│   ├── setup-backends.mjs     ← link-only backend setup
│   ├── fs-safe.mjs            ← symlink-safe copy/link/remove/unlink
│   ├── family-registry.mjs    ← unified family registry (status)
│   ├── uninstall.mjs          ← guarded teardown (uninstall)
│   └── release-scan.mjs       ← attribution / release gate
├── bridges/         ← bundled bridge skill mirrors (codex / antigravity)
├── launchers/       ← Codex / Devin Desktop / Cursor entries
└── migrations/      ← per-version upgrade steps
```

---

<div align="center">
<sub>Kernel-only · stack-agnostic · no telemetry in family code · distilled from a multi-year-verified reference implementation — <a href="https://github.com/sabaiway/agent-workflow">sabaiway/agent-workflow</a></sub>
</div>
