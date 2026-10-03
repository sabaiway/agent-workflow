### Mode: bridge-settings

<!-- opt-in-capability: codex-fast -->

The reader + consent-gated **writer** for the **host-level** bridge settings file — the answer to *"turn on the codex Fast tier (or another bridge knob) once, predictably, so it survives kit upgrades."* The four bridge wrappers read `${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf` (`KEY=VALUE` lines, **parsed never sourced**); this is the ONLY writer for it. The file lives **outside every kit-managed tree**, so a kit refresh never writes or clobbers it — upgrade-survival is structural (D2). It **previews by default**; `--apply` writes. Hand-editing the file stays fully supported — this is an offered convenience, never a lock.

**The knobs are the bundled bridges' own `settings` blocks** (manifest-as-source, D6) — the tool never invents a key or a value rule, and what it writes always passes the wrappers' own validation. **The model keys set each bridge's host posture** — the model every run of that bridge uses (codex: and its effort); a set one is checked against the models the installed CLI offers **before anything is written**. Run **`/agent-workflow-kit bridge-settings`** (`node ${CLAUDE_SKILL_DIR}/tools/bridge-settings.mjs`) to see the live list and the models on offer; today:

| key | bridge | values | note |
|---|---|---|---|
| `CODEX_MODEL` | codex | a model the installed codex offers | the host posture's model; default `gpt-6.1-sol`. |
| `CODEX_EFFORT` | codex | an effort that model offers | the host posture's reasoning effort; default `high`. |
| `AGY_MODEL` | agy | a display string the installed agy offers | the host posture's model; default `Gemini 3.8 Flash (High)`. |
| `CODEX_SERVICE_TIER` | codex | `priority` | **SPEND KNOB** — the "Fast" tier: "2x speed, **increased usage**" in the codex catalog's own words for gpt-6.1-sol (cache fetched 2026-10-03); it states no credit-rate figure; quality-neutral (same model). Default unset ⇒ standard tier. |
| `CODEX_HARD_TIMEOUT` | codex | integer `1..86400` | hard wall-clock cap (seconds) via `timeout(1)`. |
| `CODEX_REVIEW_MAX_TOTAL_BYTES` | codex | integer `1..100000000` | codex-review payload size above which the diff rides a temp file (never truncated). |
| `AGY_HARD_TIMEOUT` | agy | duration `5m`/`30m`/`90s` (unit required, nonzero) | hard wall-clock cap via `timeout(1)`. |
| `AGY_REVIEW_MAX_TOTAL_BYTES` | agy | integer `1..100000000` | the ceiling on the SUM of all outgoing prompt bytes an oversized `agy-review code` may feed (default 240000); past it the fed review refuses **before** spending turn 1. |
| `AGY_REVIEW_ALLOW_ADDDIR` | agy | `0` \| `1` | **RETIRED** — still recognized (an existing line never warns as unknown) but it **arms nothing**; the writer refuses a new `--set` and `--unset` clears it. Headless agy auto-denies its own `read_file`, so the offload it armed could return a confident fabrication; an oversized code review is a **chunked feed with a per-part delivery proof** now. |

**Invocations:**

1. **Read** — `node ${CLAUDE_SKILL_DIR}/tools/bridge-settings.mjs [--json]` prints every knob's **effective value + source** (`env` / `file` / `default`; a model key's `environment` / `setting` / `default`, as the wrappers' banner names it), each bridge's host posture with the models its installed CLI offers (read with `codex debug models` / `agy models`, never a model run; an unreadable or missing CLI is one stated line, exit 0), and flags any unknown/duplicate/malformed lines. Read-only.
2. **Preview a change** — `--set KEY=VALUE` (or `--unset KEY`) prints `before → after` and writes **nothing**. Re-run with **`--apply`** to write. Multiple `--set`/`--unset` ops apply in one atomic write.
3. **`--apply`** writes via the hardened out-of-tree atomic writer (creates the dir + file on first use; symlink/parent/TOCTOU-safe; last-writer-wins). It touches **only** the `KEY=` line it owns — every comment / blank / other line is preserved verbatim.

**Precedence at run time:** explicit env (even empty — `KEY=` disables the knob for one run) **>** this file **>** the wrapper's built-in default. So an operator can always override one run without editing the file; the reader shows which source wins. A model key is the exception: an environment value off the host posture is a one-off, which `codex-exec`, `codex-review` and `agy-review` refuse unless it is a probe (the bridge-model contract).

**Refusals (the guarded contract):** an **unknown key** or an **invalid / out-of-range value** (a model key: empty, padded with whitespace, or carrying a control byte) → exit `2` (nothing read of the file, nothing written). A **model the catalog does not offer**, or a codex **effort that model does not offer**, → exit `2` with the offered list, nothing written; an unreadable catalog leaves the value unchecked and says so. A file that already carries **duplicate keys** → exit `1`, named and left **byte-untouched** (fix the duplicates by hand first — the writer never edits blindly around them). A **symlinked / non-regular / unreadable** settings file → exit `1` (refuses to write through it). `--apply` with `--dry-run`, a duplicate op for one key, or a malformed `--set` → usage exit `2`.

**Spend consent (D4):** enabling `CODEX_SERVICE_TIER=priority` costs **increased usage** (the catalog states no credit-rate figure) — a per-host, consented act, never a default. The preview shows the caveat (from the manifest `effect`); confirm with the user before `--apply`. The tool also warns when an env var currently shadows the key you are writing (the env value wins for that session until unset; for a model key, an environment value off the host posture is a one-off, which `codex-exec`, `codex-review` and `agy-review` refuse unless it is a probe).

Output is **English/structured** — **localize it to the user's conversational language** when you narrate.

**Invariants:** writer (writes only the host settings file — outside any project/kit tree) · never commits · never runs a model (only the two read-only catalog commands) · previews by default · allowlist + value rules from the bundled manifests · a model key is judged against its bridge's catalog before any write · the host file survives every kit refresh.
