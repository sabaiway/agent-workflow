### Mode: set-recipe

The **config writer** for `docs/ai/orchestration.json` — the answer to *"set my standing recipe preference without hand-editing JSON."* **Division of labor (AD-025):** YOU turn the user's plain language into explicit ops; the KIT does the deterministic validate → merge → preview → write. It **previews by default** (writes nothing); `--write` applies. It **never runs a backend and never commits**. Hand-editing `docs/ai/orchestration.json` stays fully supported — this is an offered convenience, never a lock.

**Map the user's plain language → explicit ops** (the kit ships no NL parser; it performs no `all`-magic, so you expand scope explicitly, asking when unclear):

| user says (RU/EN) | op | scope |
|---|---|---|
| "оба ревьюят" / "both review" | `--set <activity>.review=council` | **disambiguate**: which activity? If both, pass `--set plan-authoring.review=council --set plan-execution.review=council`. |
| "один ревьюер" / "one reviewer" | `--set <activity>.review=reviewed` | per the named activity, else ask |
| "делегируй исполнение" / "delegate execution" | `--set plan-execution.execute=delegated` | execution only |
| "верни как было / сам" / "revert / do it myself" | `--unset <activity>.<slot>` | the named slot → its computed default |

Run **`node ${CLAUDE_SKILL_DIR}/tools/set-recipe.mjs [--set <activity>.<slot>=<recipe>]… [--unset <activity>.<slot>]… [--write] [--json]`**:

1. **Grammar — always fully-qualified `<activity>.<slot>`** (the kit never guesses the activity; a bare `review=council` is rejected). `review` accepts `solo|reviewed|council`; `execute` accepts `solo|delegated`. Activities/slots: `plan-authoring.review`, `plan-execution.execute`, `plan-execution.review`.
2. **Preview by default** — prints `current → proposed` for the **changed** slots only, plus the **effective recipe resolved against live backend readiness** (degradation stated honestly, e.g. *council requested, 1 ready reviewer → runs reviewed until a 2nd backend is ready*). It writes **nothing**. Re-run with **`--write`** to apply (same effective/degradation note — a direct `--write` is never quieter than the preview). `--unset` returns a slot to its computed default (reverting needs no hand-edit either). A no-op `--set` (slot already equals) writes nothing and never re-seeds the onboarding note.
3. **`--write`** applies via a hardened, atomic write (deployment-gated — refuses to scatter a config into a repo with no `docs/ai`; exclusive-create temp + rename; symlink/TOCTOU-safe; last-writer-wins). It preserves the onboarding note + every untouched slot, normalizing to canonical 2-space JSON.
4. **Exit codes:** `0` success (an explicit recipe that gracefully degrades is still `0`); `2` usage (a bare/duplicate op, or `--write` with no ops); `1` config error (malformed/unreadable config — the file is left **untouched**, never clobbered) or a write STOP (no deployment / a symlinked config). A `1`/`2` failure is loud; on a malformed config, offer to show the parse error so you can help the user fix the JSON.

Output is **English/structured** — **localize it to the user's conversational language** when you narrate. Surface the effective-recipe/degradation note plainly.

**Invariants:** writer (writes only `docs/ai/orchestration.json`) · never commits · never runs a subscription CLI · previews by default · degradation honesty on preview AND `--write` · hand-edit stays first-class.
