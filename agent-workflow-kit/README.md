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

`Node ≥ 22`  ·  `dependency-free scripts`  ·  `no telemetry in family code`

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
| **Doc growth** | unbounded sprawl | frontmatter caps + rolling changelog archive + one-file-per-ADR store |
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
    ├── decisions.md       ← ADRs — the HOT window (newest)
    ├── adr/               ← one file per archived ADR + log.md navigator
    ├── known_issues.md    ← bugs + workarounds
    ├── changelog.md       ← rolling, then archived
    ├── env_commands.md    ← daily commands
    ├── tech_reference.md  ← configs & patterns
    ├── pages/             ← one spec per page/route
    └── history/           ← changelog archive (HOT→WARM→COLD)
  + scripts/               ← caps · index · archive (installed on a yes)
  + pre-commit hook        ← keeps it all honest    (installed on a yes)
```

The Markdown memory is **stack-agnostic**; the `scripts/` + pre-commit hook are the **Node path**
(dependency-free, `node --test`). They are offered on every project because the agent host runs them; a committer without Node on PATH gets a loud hook failure.

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
| `/agent-workflow-kit` | new / empty project | recon → **asks visible-or-hidden** + **conversational language** + **agent attribution** (default off) → deploys `AGENTS.md` + `docs/ai/` filled with real recon data → offers enforcement (installed on a yes) → **asks before committing** |
| `/agent-workflow-kit upgrade` | existing deployment | reads `docs/ai/.workflow-version`, shows the changelog diff, preserves your authored memory, applies migrations, re-stamps — then prints a **read-only** one-line backend-status line (what's set up vs missing); refreshes the already-placed bridges from the kit's bundled copies (never installs a new one — set one up with `/agent-workflow-kit setup`) |
| `/agent-workflow-kit help` | any time | **read-only command index** — every command, grouped (Inspect / Configure / Orchestrate / Lifecycle) and tagged read-only / writer / guarded. The discoverable entry point, and where any unrecognized invocation lands (always read-only — a garbage invocation never writes). Never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit backends` | any time | **read-only** check of the optional execution-backends (the `codex` / `agy` bridges): what's set up vs missing and the next step. Never writes, never commits, never runs a subscription CLI (credentials = marker-file presence, not a live login). |
| `/agent-workflow-kit gates` | any time | **project gate runner** — runs the verification commands **your project itself declares** in `docs/ai/gates.json` (seeded at deploy; hand-editable `{ id, title, cmd }` entries plus the optional boolean `lcovProducer`, each `cmd` one bash line) as one batch: a per-gate **PASS/FAIL table** + one machine-readable summary line, exit 0 iff all green; a failing gate's own output is shown verbatim; `--only <id>` re-runs one. Honest distinct outcomes for a missing / empty / malformed declaration — never a silent green. The runner writes nothing **by default** and never commits — opt-in `--final` runs the FULL declared matrix and mints ONE final-run receipt into the git-dir core-evidence store (status green/red, pre/post tree fingerprints, the declaration, the consumed lcov's sha; the receipt the commit-guard binds); it executes only your own declared commands (a batching convenience, not a sandbox). The velocity tier auto-approves only the exact no-`--final` form — the recording run stays explicit. |
| `/agent-workflow-kit setup [backend]` | opt-in, any time | **link-only** auto-setup of a bridge: places the bundled bridge skill (only into an absent / empty / managed dir — never overwrites an unmanaged one) + links its wrappers onto `PATH` via managed symlinks (idempotent; refuses to clobber a non-symlink; try `--dry-run` to preview). The binary install + the one-time subscription login stay **manual**: it prints the exact **login** command and points the binary install at each bridge's `setup/README.md`. POSIX wrappers — on Windows use WSL. Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit status` | any time | **read-only** single view of **versions + deployment + settings + bridges**: which members (kit / memory / engine / the two bridges) are installed and at what version (with an honest "installed on this machine" note when one is behind) and — in a project — what's deployed (`docs/ai`, the version stamps, and the **visibility**: visible / hidden / unclear), and the **feature-spec adoption state** (`not adopted` / `adopting (N draft)` / `adopted (N live, M draft)` / `could not be read`, plus `declined` when recorded), plus your settings (orchestration recipes, attribution, velocity) and the bridges' readiness. The two version axes (package number vs deployment-structure head) stay decoupled. Never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit recipes` | any time | **read-only** orchestration advisor: presents five named recipes for composing the carriers of a step — the bridges and the full-tool executor subagent — into plan → execute → review — **Solo / Reviewed / Council / Delegated / Subagent** — plans + recommends one for your environment (degrading with a stated reason when a backend isn't ready, or when the executor vehicle is missing/unusable), and offers the choice. The activity/slot registry (three activities) is rendered by `procedures` and by `set-recipe --help`. The orchestrator runs it via the bridge skills or the executor vehicle and **always commits**; the kit never executes a recipe, never runs a subscription CLI, never commits. |
| `/agent-workflow-kit procedures <activity>` | any time | **read-only** activity-procedures advisor: prints a named activity's ordered steps (`plan-authoring` / `plan-execution` / `routine`) read **live** from the engine, plus the **resolved recipe per slot** from your `docs/ai/orchestration.json` (agent-writable via `set-recipe`, or hand-edited) + carrier readiness (`plan-authoring`: author, fold, review; default Reviewed when a backend is ready, Council on request; slot-aware incl. Delegated and Subagent) — and, for every dispatched backend, the **full driving contract at the point of use** (exact copy-pasteable invocation, grounding levers like agy's `--facts`/`--decided`, the round-2 `--continue` delta, guarded passthrough), verbatim from the bridge manifests (drift-guarded; each wrapper's `--help` prints the same). `--override <slot>=<value>` adjusts one slot per run. Composes with `recipes`; never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit set-recipe` | any time | **config writer** for `docs/ai/orchestration.json`: tell the agent your preference in plain language and it maps it to explicit `--set <activity>.<slot>=<value>` / `--unset` ops; the kit validates, **previews by default**, and writes only on `--write` (deployment-gated, atomic, symlink/TOCTOU-safe), resolving the effective recipe vs live readiness. Writes **only** that file — **never runs a backend or a subagent, never commits**; hand-editing stays fully supported. |
| `/agent-workflow-kit review-state` | any time | **read-only review-receipt checker** — makes "reviewed ≠ shipped" detectable: the bridge review wrappers append a receipt per successful review (into a file inside the git dir — never committable); this checks that every backend your configured `plan-execution.review` recipe names holds a **fresh, grounded receipt for the current uncommitted tree** (any later edit moves the fingerprint and stales the receipt; a review continuation never re-attests a folded tree). `--check` gives a gate exit code to declare in `docs/ai/gates.json` **by hand or via the consent-gated seeder** (preview → your explicit yes; never without consent). `--await [--timeout <s>]` (AD-049) BLOCKS until every recipe-named backend has receipted the current tree — the durable completion signal is the receipt, never a process event — so you wait for the bridges instead of hand-polling. Never writes, never commits, never runs a subscription CLI; it spawns read-only `git` queries to fingerprint the tree — and `git commit --no-verify` stays possible (discipline, not a sandbox). |
| `/agent-workflow-kit sandbox-masks` | any time | **cosmetic exclude lane for sandbox device masks** — an OS sandbox (Claude Code) injects character-device masks into the work tree as untracked `git status` noise; the review domain already ignores them **by construction** (never-committable untracked classes — char/block devices, FIFOs, sockets — are excluded from the fingerprint, the assembled review payload, and the clean checks). This mode hides them from `git status` too: flagless = read-only probe (derives the CURRENT mask set from the unfiltered walk + lstat — never a frozen list — and revalidates fenced entries, loudly flagging one that became a real path); `--apply` = consent-gated FULL-BLOCK replace of its own fenced block in `git rev-parse --git-path info/exclude` (stale masks drop by construction; `--clear` always means REMOVE the block — it takes precedence over the derivation). Writes ONLY its fence — never `.gitignore`, never global config; symlinked/non-regular exclude paths and malformed fences fail closed. Watch note: a real file at an excluded path is silently skipped by bulk staging (`git add -A`/`git add .`) — delete the stale line first; the probe flags exactly this case. |
| `/agent-workflow-kit mcp` | Claude Code · opt-in | **typed-channel registration** — the kit ships a read-only stdio **MCP server** exposing its two promptless readers as TYPED tools (`path_inventory`: exists / type / size / line count / listing / a small file's text, many paths in ONE call; `repo_search`: literal search, the pattern a JSON string). Their arguments are named JSON fields rather than a string handed to a shell, so a pipe, a redirect or a quote inside a pattern or a path stays DATA and is never interpreted — legal bytes to search for, with no shell to read them as operators. Shipping the server does nothing on its own — a client sees it only once the project declares it, and this mode is that declaration: the `agent-workflow` entry in **`.mcp.json`** (command `node`, args = the absolute path of the RUNNING kit's server) plus `enabledMcpjsonServers` and the two derived tool allow rules in **`.claude/settings.json`**. Preview by default and the **exact entry is printed before consent** (registering a server means your client will run that command); `--apply` writes `.mcp.json` FIRST, then settings, merge-don't-clobber with each file's EOL kept, and a re-apply adds nothing twice. An existing `agent-workflow` entry that **structurally differs** from what this kit copy would write is refused unwritten (the comparison ignores key order, so re-serialized identical bytes are the same registration) — silently changing what an MCP server launches is what consent must not slide past. Where an OS sandbox masks `.mcp.json` with a device node, it writes nothing, hands you both paste-ready texts and exits 0. The server is a read-only child of your client (no write, no exec API) running outside the Bash sandbox as the client does. Never writes `settings.local.json`; never commits. |
| `/agent-workflow-kit grounding` | any time | **grounded-review facts assembler** — mechanizes populating `agy-review --facts @f`: slices your entry-point's **Hard Constraints** section verbatim (exactly one match, else a loud stop) and/or a plan's three canon sections (`## Goal and boundary` + `## Module ledger` + `## Verification`, each required; duplicates stop), under the same byte budget the agy wrapper enforces (minus `--reserve-bytes` for the artifact share), with a loud tail-trim on overflow. `--autonomy` (AD-044) appends the COMPUTED effective autonomy policy from the git-top `docs/ai/autonomy.json` (every red-line + per-activity level, stated source line; absent file → the computed defaults ARE the policy, exit 0; a malformed policy fails CLOSED, exit 1). `--extra <text|@file>` (repeatable) appends your own facts **byte-verbatim** after the mechanical sections, so the merge is a tool input rather than a shell append — an `@file` must sit inside the proven git work tree (never the git dir) or the system temp surface, and is read through a no-follow descriptor (a FIFO cannot block it, a symlink leaf cannot substitute its target). Prints to stdout; `--out` writes **one scratch file only** — system-temp outside the repo ($TMPDIR / /tmp, rewritable) or a **fresh** gitignored in-repo path (create-only, exclusive write; an existing in-repo file, even gitignored, is refused — the `.env` clobber class); tracked, not-ignored-in-repo, other outside-repo, and symlink/non-regular destinations are all refused. Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit core-evidence` | any time | **the ONE loop-evidence writer** (strip-the-kit) — every core evidence record lands in a single append-only JSONL store inside the git dir (never committable; versioned schema, latest-per-key supersession, byte-identical duplicates refused, malformed lines fail every reader closed). `red-proof "<file>#<pattern>"` declares an observed-red **BEFORE a bugfix** (N/N red runs + content custody + base + the pre-fix fingerprint; green/mixed/timeout are DISTINGUISHED refusals — nothing written); `degrade --backend --reason` is the ONLY escape for an unavailable review backend (per-tree, never all backends); `summary` renders the whole loop state statelessly (gate result · per-backend verdicts · red-proofs · degrades) — no ledger, no rounds, nothing remembered. Honest residual: records are forgeable — self-discipline, not a security boundary. Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit coverage-check` | any time | **the final-run checker** (D3(c)+(d)) — **certifies coverage ONLY inside the `--final` run that owns the lcov** (ownership is exclusive by CONVENTION over the fixed path, not enforced — a concurrent writer to it is a stated residual, queued as LCOV-EXCLUSIVE-OWNERSHIP): an artifact on disk proves nothing about the tree it came from, so a standalone run prints its findings and states `attested=no` / `NO VERDICT` rather than a PASS (an lcov that predates an edit would otherwise certify a line the suite never executed). `attested=` claims a verdict was ISSUED, pass or fail — a run over uncovered lines still reads `attested=yes` and still exits 1, and a run whose coverage arm never executed (no lcov) reads `attested=no` even inside `--final`, because nothing was read and nothing is certified. The runner passes a nonce whose one-way commitment over `{nonce, fingerprint, base}` is the `final-start.attempt` it recorded; a context describing another tree, or matching no recorded attempt, is a REFUSAL, never a verdict. Findings are unchanged — reads the lcov the declared `unit-tests` gate produced at the FIXED git-dir path and fails on any uncovered CHANGED executable Node line (listed `file:line`; a changed file absent from the map is a file-level red; out-of-domain/unsupported files are LISTED — the claim narrowed honestly); VERIFIES every current-base red-proof declaration (bound test exists · custody hash unchanged · green N/N now · pre-fix fingerprint differs); prints `lcov-sha256=<hex|none>` of the exact bytes it consumed — the sha the `--final` receipt binds and re-hashes. An absent lcov is a LOUD `skipped-no-lcov`; a symlinked path is a refusal. `--check` is the gate exit code — declare it as the LAST gate (`run-gates --final` refuses otherwise). Read-only. |
| `/agent-workflow-kit commit-guard` | any time | **the read-only pre-commit guard** (D10) — makes the commit capture the whole current working tree, so «verified» and «about to be committed» are the same bytes (the receipt itself has a stated residual — see the mode doc). FIRST it refuses an **INDEX that lags the verified working tree** (the gates and the fingerprint describe the WORKING tree while `git commit` takes the INDEX alone, and the fingerprint cannot tell them apart — so a lagging index used to ship a strict subset of what was verified): unstaged tracked paths or reviewable untracked-not-ignored paths, named up to a bounded cap with the remainder stated, a dirty tracked **submodule** named separately with its own recovery, and fail-closed on an undecidable probe. This deliberately blocks a partial commit. Then it binds the LATEST completed `run-gates --final` receipt to the EXACT current tree: refuses on a missing/red/stale receipt, fingerprint drift under the run, a dangling later attempt, declaration content drift, evidence-hash or lcov drift, or unsatisfied review obligations (the same review-state decision, recomputed over a sanitized env — forged out-of-repo stores never satisfy). Re-runs NO gate or test. Wire it into `.git/hooks/pre-commit` (the installer writes the RESOLVED invocation). `git commit --no-verify` stays the stated residual. |
| `/agent-workflow-kit recommendations` | any time (every `upgrade` ends with it) | **read-only deployment advisor** (AD-044) — computes what in THIS deployment is configured sub-optimally (allowlist not seeded, autonomy render drifted, OS sandbox unavailable, gates undeclared, bridge friction, sandbox-mask clutter, an unacknowledged sandbox recipe, a feature-spec layer never adopted) and renders **verdict-first**: one composed verdict line (does anything need attention?), then each item as **{severity · what · one-line benefit · an optional `recipe:` line (the sandbox-lane live recipe, the worktrees-dir hand-apply-first grant advice, the agents hidden-mode reconcile follow-up, or the spec-adoption decline preview) · the exact consent-gated apply one-liner}**. The agent PRESENTS the section in the user's conversational language — every fact and count, nothing added or dropped; commands, paths, hosts and rule strings byte-exact; raw tool block on request — and runs EXACTLY the rendered one-liners only on your yes, surfacing each item's posture note first. Renders **present-even-when-empty** (`no recommendations — flow optimal.`); a failed probe degrades to a stated skip line. Registry strings are fact-true frozen one-line data (posture/risk notes live in the mode doc at the consent moment); the kit never seeds `sandbox.network.allowedDomains` / `filesystem.allowWrite` (**HAND-APPLY** territory), and the sandbox-lane item's convergence is a neutral fingerprint acknowledgement recorded by a consent-gated ack writer into `docs/ai/acks.json` — never a security key (the recipe is documented per bridge in `capability.json` `networkHosts` + `writableDirs`). `--cwd` is required (the target project is explicit); never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit doc-parity` | any time | **read-only doc-parity lint** (AD-049) — kills the doc-drift class where a mode-contract doc silently lags a code constant (a `--check` doc still reading `300` after the diff cap moved to `400`): a **closed, exported registry** binds each live constant (review caps, schema versions, the ledger's own class/scope vocabulary, and the autonomy-doctor EXIT/status/trusted-dir contract) to the exact token its `references/modes/*.md` contract must carry, and asserts the CURRENT value renders into every bound file — a drifted doc, an unreadable file, or an absent token **fails closed**. The values are sourced from the live imports (never re-typed), so the lint can't itself go stale; adding a binding is adding a checked entry (closed-world, edit-safe). `--check` is a gate exit code for `docs/ai/gates.json`. Never writes, never commits, never runs a subscription CLI. |
| `/agent-workflow-kit dispatch` | any time | **the delegation engine** — makes "how much does delegating a sub-task actually buy?" a measured number instead of a feeling. `check <file>` validates a sub-task brief's contract block and exits 0/1 naming the first violated field — **form only**: whether the task is genuinely bounded, its design decided and its acceptance adequate stays your judgment, and a well-formed absurdity passes here by construction. `advise --step-class <c>` answers the question that comes BEFORE that one — which vehicle should carry this kind of sub-task, whether it is even present on this machine, and what the ledger has already recorded for threads of that class (finished, failed, closed without a fold, and still open — counted separately) — and it decides nothing: it refuses no dispatch, gates no verb, and a choice that diverges from the advice is noted rather than blocked. It reads the filesystem only: nothing is launched to find out what is installed, an absent ledger prints "no recorded history", an unreadable one prints the store's own words, and either way the advice still prints. The same block appears as a footer under a form-valid `check` — never under a refusal, so it can never hide one. `register` pre-registers an acceptance wave (step classes, pairing key, minimum observations per class, the mean and first-pass thresholds) so the bar can never be chosen after the results it judges — immutable per wave. `observe` records ONE hand-written observation (`solo-construction`, the baseline whose ratio is 1 by construction — except over a scope measuring zero bytes, which has no ratio at all and is recorded ineligible by name — or `self-reported`) — delegated numbers are never hand-written, they are derived. The writer verbs are where that derivation happens: `open` puts a delegated thread on the record with every mint-time field copied from the brief's own header, refusing a deadline the wrapper's cap plus its kill grace would not fit inside, and recording whether the tree it started from was clean (a dirty one makes the result honestly unmeasurable rather than quietly counted); `await` waits for that one dispatch to answer and writes nothing — only the finished receipt satisfies it, a run still holding the nonce means keep waiting, and a wait that runs out says so with its own exit code, names whether the deadline or your own timeout ended it, and authorizes nothing: a wait that ended without an answer is a question for you, never permission to dispatch again; `return` absorbs the receipt the wrapper minted — only a finished one, checked against the contract it actually ran, its deadline and its own report, and refused outright when the tree hides changes from git or moves while the return is being computed — and derives the bytes from git rather than from anyone's claim; `fold` is the acceptance, and it refuses if the tree moved since the return — precisely, it re-confirms **equality of the visible canonical payload**, which is a change detector rather than a cryptographic identity of the tree: that payload is unframed and carries no file mode, so a content or symlink target that imitates the marker opening the next entry can alias two trees, and an executable-bit flip moves nothing (both named as residuals in the mode doc, with the fix queued). Where the payload cannot follow an object's bytes at all — a binary, a non-regular path, a submodule, a symlink whose target is not valid UTF-8 — `return` and `fold` **refuse** rather than promise what they cannot check. `degrade` closes a thread that never earned a fold, on the record and with its reason. `aggregate` prints one wave: the registered thresholds, every observation as context, and per step class the finished threads — a folded success with git-provable bytes contributes its ratio, one whose bytes are unprovable is excluded from the mean but still counts in the first-pass rate, and a failed thread, a degrade-closed one, or one folded after failing acceptance each count as a real zero. Below the registered minimum nothing is computed (insufficient); at or above it is computed and labeled PILOT evidence. It REFUSES rather than guessing: no pre-registration, an unfinished thread in scope, a recorded refusal-to-delegate that never opened a thread, or an ambiguous wave each stop the computation by name. `handoff-return --slug <s>` closes the worktree loop after `land --prepare`: it re-attests that main still holds exactly the prepared tree under the same HEAD (both recorded in the handoff at prepare time), prints the satellite handoff's user-owned content byte for byte with its boundaries, byte lengths and the main-owned destinations each part folds into, prints the handoff digest and both OIDs as its proof, states the after-the-fold order (a fold landed after the gates leaves them stale), and records ONE self-reported worktree-stream observation only when the whole prepared change set is measurable — a deletion, a rename, a symlink, a submodule or a mode-only change ends with a named NOT RECORDED instead, never a partial number. Writes only its own append-only ledger inside the git dir (never committable); never commits, never runs a subscription CLI. |
| `/agent-workflow-kit worktrees` | any time | **parallel feature worktrees** — run several features in DIFFERENT agent sessions on one repo, zero interference on working-tree files (the ONE exception is the dependency cache, below): `provision <slug> --plan <file>` creates a sibling git worktree on branch `aw/<slug>` and populates it (registry-derived footprint copy-if-missing — a tracked file is never overwritten; EXACTLY ONE seeded feature plan; the `handoff-<slug>.md` record from minute zero; `node_modules` symlinked where the link stays ignored — a shared MUTABLE dependency cache: writes through it hit MAIN's node_modules; for isolation run the printed isolated-install command (`--install` only PRINTS it; on `--resume` run the printed unlink-first recovery first — printed only for a link whose RAW TARGET is MAIN's `node_modules`, since a foreign or unreadable link is reported as such with no removal advised); absolute root-pinned gate commands rebased on untracked copies only, and only while their bytes equal the MAIN source or its rebased form — user-modified copies stay untouched); `list` is read-only (slug, branch, base, dirty, handoff); `prompt <slug>` is read-only too and re-prints the satellite's cold-start prompt — the same text `provision` ends its report with: where the worktree is, its ONE seeded plan, the handoff as the one channel back, MAIN's orientation (shared series index, landing) and, under its own heading because it is probed on the satellite, that checkout's install posture — every value derived LIVE rather than replayed from the frozen provision record, a recorded value that no longer matches NAMED as a divergence (with the cause its source makes likely) instead of printed as the runnable one, every offered command marked with WHO runs it (`MAIN $ …` for the landing, `HERE $ …` for this checkout's own install, a posture with nothing to run staying prose), and a control character in any rendered value a typed STOP rather than a forged prompt line; `land <slug> --prepare` locks the common git dir, fail-closes on divergence or incomplete satellite state, transfers the complete accepted satellite diff onto a CLEAN main, runs sync plus the declared gates, and reports HEAD/TRANSFER/PREPARED OIDs — the commit ALWAYS stays a dialogue ask; `cleanup <slug>` takes the same lock and removes a LANDED worktree only after live landed-verification against main HEAD, while `--abandon` is the ONE destructive arm (destroys unlanded work; **no preview step** on any writer). The parent dir is the `docs/ai/worktrees.json` `parentDir` setting (default: the repo's sibling parent); an unwritable parent degrades to printed maintainer-pasted commands, and the one-time host consent that makes it promptless surfaces via `recommendations`. Never commits, never pushes, never runs a subscription CLI. |
| `/agent-workflow-kit uninstall` | opt-in, any time | **guarded teardown** — the inverse of `init` / `setup`. Removes only what's **provably ours** (managed skill dirs + bridge wrappers; in a project, the hidden-mode git-ignore block it added + the pre-commit hook it installed); **never deletes** your `docs/ai` / `AGENTS.md` (prints the exact `rm` to run by hand) or your `.claude/settings.json` (prints an **edit** — remove the attribution key, review any velocity `permissions.*` — never an `rm`). Always `--dry-run` first; preflight-then-mutate; never commits. |
| `/agent-workflow-kit velocity` | Claude Code · opt-in | **onboarding velocity profile** — seeds a fixed, audited **read-only** allowlist into `.claude/settings.json` so routine read-only commands stop idling on approval prompts while you're away; opt-in `acceptEdits`; plus a **read-only advisory** of likely project gate commands to add by hand. Writes **only** `.claude/settings.json` — **never** allowlists commit/push/publish, never writes `settings.local.json`, never commits. A seeded entry is a **trust posture, not a sandbox** (a runtime residual remains at the settings level — its guard ships as the opt-in `hook` command); a direct commit/push/publish still asks. `--dry-run` first. |
| `/agent-workflow-kit agents` | Claude Code · opt-in | **subagent vehicles** — places the five bundled subagent definitions into `.claude/agents/`: **four read-only vehicles + one full-tool `executor`**. **No read-only vehicle gets `Bash`**, and that is the load-bearing property: a read-only fan-out on a full-tool subagent shells out for facts it could have read, and every shelled command is an approval prompt you never needed to see. Three of the four ride a **cheap model** (haiku, low effort) for mechanical work — extraction sweeps, changelog fact-skeletons, gate-failure triage; the fourth, **`review-lens`**, is an ADDITIONAL independent read-only review opinion on code your configured backends have already seen (never a replacement for your review recipe, advisory like every review). The fifth, **`executor`** (`model: opus`, all tools), is the ONE vehicle with a shell and the instrument behind the **Subagent** recipe: dispatched only for a bounded, file-disjoint execution / authoring / routine slice you verify afterwards — never for read-only work, never as a review backend, and it never commits. Its state (`placed` / `customized` / `unusable` / `missing`) is what a `subagent` slot's readiness resolves from. Writing code and running gates stay off the four read-only vehicles; the executor carries a bounded slice you re-verify on your main lane, and every vehicle's output is verified. Preview by default (`--apply` writes); an existing customized file is **preserved, never overwritten**; never touches `settings*.json`, never commits. |
| `/agent-workflow-kit hook` | Claude Code · opt-in | **gate-approval hook** — places a self-contained PreToolUse hook (`.claude/hooks/`) and wires it into `.claude/settings.json`: a Bash command **byte-identical** to a gate you declared in `docs/ai/gates.json` (run from the project root) is auto-approved — no prompt, no idle; a seeded read-only command carrying a runtime residual (output redirection, command substitution, `--output` writes) now **asks** even where an allow rule would have silently passed it (proven live — hook `ask` overrides an allow rule). Detection is a conservative string scan, so it over-asks on a byte that is ordinary text — searching for `=>`, or a read wearing `2>/dev/null`, prompts. That is a documented open limit: 4.1.0 built three mechanisms to narrow it and removed all three in review, each counterexample kept as a test (see Mode: hook). Exact matches only, never patterns; never `deny`; a broken `gates.json` only disables auto-approval, never the guard. An opt-in **read-lane** (`--read-lane` → `docs/ai/lanes.json`, a **separate** file from `gates.json`) additionally auto-approves *compounds* of seeded read-only commands carrying no shell metaprogramming; `--apply --read-lane` verifies the placed hook is current first (delete-to-reseed otherwise). Preview by default; never writes `settings.local.json`; never commits. |
| `/agent-workflow-kit state-block-guard` | Claude Code · opt-in | **closing-block detector** — a `Stop` hook that reads the turn's final assistant message and warns when the closing state block is defective: the «what I need from you» slot answering *nothing* (a turn that ENDS always needs a resume, so the answer is false, not merely unhelpful), or a first-person promise of imminent work in a turn that is over. Judged on the slot's first clause, so a real ask followed by a clause break and "nothing else" passes, and a promise gated on something named passes; matching is word-bounded and Unicode-aware, quoted and fenced examples are stripped, and the last STARTED block decides — an incomplete tail counts as no block rather than falling back to an earlier one. A message carrying no block at all is silent unless you pass `--require-block` — this kit does not mandate the block, and a hook that runs every turn must not warn every turn. The judgement is lexical and the mode doc names every residual it leaves. **Detection, never prevention** — a `Stop` hook cannot un-send the message it judges; what it buys is that a silent recurrence becomes a visible one. Warns via `systemMessage` and **exits 0 on every path**: never `deny`, never blocks the stop, never re-enters the model. Reads nothing but the message, makes no network call, approves nothing. This mode is **read-only and has no writer** — it ships the self-contained hook and a paste-ready wiring block you merge into `.claude/settings.json` yourself. |
| `/agent-workflow-kit bridge-settings` | opt-in, any time | **host-level bridge settings** — read or change the bridges' `KEY=VALUE` config file (`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf`), the **one place a knob survives kit upgrades** (it lives outside every kit tree; a refresh never touches it, and now states loudly if it ever overwrote a local edit). First knobs: the **codex Fast tier** (`CODEX_SERVICE_TIER=priority` — ~1.5× speed at a **2.5× credit rate**, quality-neutral, default off — a consented spend), the codex/agy hard timeouts, the codex review byte cap, and `AGY_REVIEW_MAX_TOTAL_BYTES` (the ceiling on what an oversized agy code review may feed before it refuses pre-spend). `AGY_REVIEW_ALLOW_ADDDIR` is a **retired** compatibility key: still recognized so an existing line never warns as unknown, but it arms nothing — the writer refuses to set it and `--unset` clears it. Allowed keys + value rules come from the bundled bridge manifests; **model/effort are never settable** (the quality guard is untouched). **Previews by default**; refuses an unknown key, an out-of-range value, or a duplicate-carrying file; writes atomically (symlink/TOCTOU-safe). Never commits, never runs a subscription CLI. |
| `/agent-workflow-kit autonomy-doctor` | opt-in, any time | **guarded sandbox provisioner "doctor"** — can this machine run the Claude sandbox, and (only with your consent) fix it: macOS Seatbelt built-in / Linux+WSL2 needs `bwrap`+`socat` / native Windows → WSL2. Flagless = **FS-only preview** (the diagnosis, the exact absolute-path command it WOULD run, the exact `--apply <pm>:<pkgs>` consent tuple — runs nothing, never claims ready); `--verify` runs the unprivileged proof (a `bwrap` user-namespace smoke + `socat -V`) — the **only** source of a Linux "ready (verified)" claim; `--apply <pm>:<pkgs>` is the consent-gated privileged install (the tuple must equal the previewed plan; everything executed resolves to absolute paths inside `/usr/bin:/bin:/usr/sbin:/sbin`; the exact command is re-printed immediately before execution), then verifies. Honest loud degrades (unknown PM, untrusted location, nested-sandbox INDETERMINATE, root-unproven) and a stated restart step. Sits **outside every velocity auto-approve tier**; never auto-runs, never writes repo files, never commits. |

It **never auto-commits** and **never overwrites** an existing `AGENTS.md` without asking.

> **Two kinds of "upgrade":** `npx @sabaiway/agent-workflow-kit@latest init` updates the **kit's
> own files** in `~/.claude/skills/`; `/agent-workflow-kit upgrade` then migrates a **project's**
> `docs/ai/` deployment to that kit version.

---

## 🔍 How it works (60 seconds)

- **Layered, lazy loading** — *always-loaded* = `AGENTS.md` + `index.md` (~160 lines, cache-warm). *On-demand* = open a `docs/ai/` file only when its "Read When" applies. *Hierarchical* = subdir `AGENTS.md` loads when you work in that folder. *Archive* = old history rolls out of the hot files.
- **Caps + freshness** — every doc declares a `maxLines` cap; a pre-commit hook blocks commits that bust a cap or let the auto-generated index go stale.
- **3-tier rolling archive** — `changelog.md` (HOT, last days) → `history/recent.md` (WARM) → per-month COLD + a one-line condensed index. Hot files stay small forever.
- **Plan lifecycle** — a capped plan (goal and boundary, module ledger, verification), ephemeral plan files, and a mandatory Cleanup phase.
- **No silent failures** — every guard that rejects an action logs structured context.

The dependency-free **Node** enforcement scripts (`node --test`, no package manager assumed) and their hook are offered on every project because the agent host runs them; a committer without Node on PATH gets a loud hook failure.

---

## 🧩 The composition root of the family

The kit is the member you install — the family's **composition root**. `npx … init` only installs
the kit globally; the composition happens when you **deploy it in a repo** (`/agent-workflow-kit`):

```
agent-workflow-kit  —  the composition root (installed via npx … init)
   on /agent-workflow-kit in a repo, the kit:
   ├─ delegates ─▶ memory substrate   (healthy copy, else bundled fallback)
   ├─ injects   ─▶ workflow methodology  (live from the installed engine)
   ├─ deploys   ─▶ AGENTS.md + docs/ai/
   │               + Node scripts + pre-commit hook (installed on a yes)
   ├─ detects   ─▶ optional backends   (codex / agy, read-only)
   └─ sets up   ─▶ a bridge (opt-in)   (place skill + link wrappers)
```

- **Delegates** substrate deployment to **`@sabaiway/agent-workflow-memory`** when a healthy
  standalone copy is present, else uses its **bundled fallback** — same `docs/ai/` either way.
- **Injects** three bounded pointers into the deployed `AGENTS.md` — the workflow **methodology**, the
  **orchestration recipes** (Solo / Reviewed / Council / Delegated / Subagent), and the **autonomy policy** (the
  `docs/ai/autonomy.json` read contract) — read **live** from the installed
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
