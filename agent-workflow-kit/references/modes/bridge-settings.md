### Mode: bridge-settings

The reader + consent-gated **writer** for the **host-level** bridge settings file — the answer to *"turn on the codex Fast tier (or another bridge knob) once, predictably, so it survives kit upgrades."* The four bridge wrappers read `${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf` (`KEY=VALUE` lines, **parsed never sourced**); this is the ONLY writer for it. The file lives **outside every kit-managed tree**, so a kit refresh never writes or clobbers it — upgrade-survival is structural (D2). It **previews by default**; `--apply` writes. Hand-editing the file stays fully supported — this is an offered convenience, never a lock.

**The knobs are the bundled bridges' own `settings` blocks** (manifest-as-source, D6) — the tool never invents a key or a value rule, and what it writes always passes the wrappers' own validation. Model/effort are **NOT** settable here (the wrappers' quality-first guard is untouched, D4). Run **`node ${CLAUDE_SKILL_DIR}/tools/bridge-settings.mjs`** to see the live list; today:

| key | bridge | values | note |
|---|---|---|---|
| `CODEX_SERVICE_TIER` | codex | `priority` | **SPEND KNOB** — the "Fast" tier: ~1.5× token speed at a **2.5× credit rate** on gpt-5.5, quality-neutral (same model). Default unset ⇒ standard tier. |
| `CODEX_HARD_TIMEOUT` | codex | integer `1..86400` | hard wall-clock cap (seconds) via `timeout(1)`. |
| `CODEX_REVIEW_MAX_TOTAL_BYTES` | codex | integer `1..100000000` | codex-review payload size above which the diff rides a temp file (never truncated). |
| `AGY_HARD_TIMEOUT` | agy | duration `5m`/`30m`/`90s` (unit required, nonzero) | hard wall-clock cap via `timeout(1)`. |
| `AGY_REVIEW_ALLOW_ADDDIR` | agy | `0` \| `1` | `1` re-enables the oversized-review `--add-dir` offload (Issue-001 stall risk, bounded by the timeout). |

**Invocations:**

1. **Read** — `node ${CLAUDE_SKILL_DIR}/tools/bridge-settings.mjs [--json]` prints every knob's **effective value + source** (`env` / `file` / `default`) and flags any unknown/duplicate/malformed lines. Read-only.
2. **Preview a change** — `--set KEY=VALUE` (or `--unset KEY`) prints `before → after` and writes **nothing**. Re-run with **`--apply`** to write. Multiple `--set`/`--unset` ops apply in one atomic write.
3. **`--apply`** writes via the hardened out-of-tree atomic writer (creates the dir + file on first use; symlink/parent/TOCTOU-safe; last-writer-wins). It touches **only** the `KEY=` line it owns — every comment / blank / other line is preserved verbatim.

**Precedence at run time:** explicit env (even empty — `KEY=` disables the knob for one run) **>** this file **>** the wrapper's built-in default. So an operator can always override one run without editing the file; the reader shows which source wins.

**Refusals (the guarded contract):** an **unknown key** or an **invalid / out-of-range value** → exit `2` (nothing read of the file, nothing written). A file that already carries **duplicate keys** → exit `1`, named and left **byte-untouched** (fix the duplicates by hand first — the writer never edits blindly around them). A **symlinked / non-regular / unreadable** settings file → exit `1` (refuses to write through it). `--apply` with `--dry-run`, a duplicate op for one key, or a malformed `--set` → usage exit `2`.

**Spend consent (D4):** enabling `CODEX_SERVICE_TIER=priority` costs a **2.5× credit rate** — a per-host, consented act, never a default. The preview shows the caveat (from the manifest `effect`); confirm with the user before `--apply`. The tool also warns when an env var currently shadows the key you are writing (the env value wins for that session until unset).

Output is **English/structured** — **localize it to the user's conversational language** when you narrate.

**Invariants:** writer (writes only the host settings file — outside any project/kit tree) · never commits · never runs a subscription CLI · previews by default · allowlist + value rules from the bundled manifests · model/effort never settable · the host file survives every kit refresh.
