### Mode: set-autonomy

The **policy writer** for `docs/ai/autonomy.json` — the answer to *"set my autonomy policy without hand-editing JSON."* **Division of labor:** YOU turn the user's plain language into explicit ops; the KIT does the deterministic validate → merge → preview → write. It **previews by default** (writes nothing); `--write` applies. It **never renders enforcement** (that is the separate velocity autonomy mode — this writer touches only the policy file), **never runs a backend, and never commits**. Hand-editing `docs/ai/autonomy.json` stays fully supported — an offered convenience, never a lock.

**The policy** has two parts: **red-lines** (always hold, segment-independent) + a **per-activity autonomy level**.

- **red-lines** (`redlines.<key>` = `ask` | `deny`): the outward/irreversible actions. `commit` / `push` / `publish` (default **ask** — commit stays the human checkpoint); `network` / `credentials` / `fs_outside_repo` (default **deny** — the conservative floor).
- **autonomy** (`<activity>.autonomy` = `sandbox` | `prompt`) per activity (`plan-authoring`, `plan-execution`): `sandbox` ⇒ auto-allow confined commands + accept edits; `prompt` ⇒ conservative prompting (the sandbox still confines). An absent activity floors at `prompt`.

**Map the user's plain language → explicit ops** (the kit ships no NL parser; it performs no `all`-magic, so you expand scope explicitly, asking when unclear — localize the interpretation to the user's language at narration time, but keep the ops exact):

| user intent | op |
|---|---|
| more autonomous when executing | `--set plan-execution.autonomy=sandbox` |
| prompt while planning | `--set plan-authoring.autonomy=prompt` |
| always ask before commit | `--set redlines.commit=ask` |
| block the network | `--set redlines.network=deny` |
| revert / do it as before | `--unset <section>.<key>` (→ its computed default) |

Run **`node ${CLAUDE_SKILL_DIR}/tools/set-autonomy.mjs [--set <section>.<key>=<value>]… [--unset <section>.<key>]… [--write] [--json]`**:

1. **Grammar — always fully-qualified `<section>.<key>`** (the kit never guesses the section; a bare `commit=ask` is rejected). Sections/keys: `redlines.{commit,push,publish,network,credentials,fs_outside_repo}` (each `ask|deny`); `plan-authoring.autonomy`, `plan-execution.autonomy` (each `sandbox|prompt`).
2. **Preview by default** — prints `current → proposed` for the **changed** keys only, plus each key's **effective value** (an `--unset` shows its computed default). It writes **nothing**. Re-run with **`--write`** to apply. A no-op `--set` (value already equals) writes nothing and never re-seeds the onboarding note.
3. **`--write`** applies via a hardened, atomic write (deployment-gated — refuses to scatter a policy into a repo with no `docs/ai`; exclusive-create temp + rename; symlink/TOCTOU-safe; last-writer-wins). It preserves the onboarding note + every untouched key, normalizing to canonical 2-space JSON. After a write it points at the **velocity autonomy render** as the next step (rendering the policy into `.claude/settings.json` is a separate, previewed step — this writer never touches settings).
4. **Exit codes:** `0` success; `2` usage (a bare/duplicate op, or `--write` with no ops); `1` config error (malformed/unreadable policy — the file is left **untouched**, never clobbered) or a write STOP (no deployment / a symlinked policy). A `1`/`2` failure is loud; on a malformed policy, offer to show the parse error so you can help the user fix the JSON.

Output is **English/structured** — **localize it to the user's conversational language** when you narrate.

**Invariants:** writer (writes only `docs/ai/autonomy.json`) · never renders enforcement · never runs a backend · never commits · previews by default · hand-edit stays first-class.
