### Mode: set-recipe

<!-- opt-in-capability: review-recipe -->
<!-- opt-in-capability: delegated-execution -->

The **config writer** for `docs/ai/orchestration.json` — the answer to *"set my standing recipe preference without hand-editing JSON."* **Division of labor (AD-025):** YOU turn the user's plain language into explicit ops; the KIT does the deterministic validate → merge → preview → write. It **previews by default** (writes nothing); `--write` applies. It **never runs a backend and never commits**. Hand-editing `docs/ai/orchestration.json` stays fully supported — this is an offered convenience, never a lock.

**Map the user's plain language → explicit ops** (the kit ships no NL parser; it performs no `all`-magic, so you expand scope explicitly, asking when unclear):

The intents are listed in English; a user speaking any other language expresses the same ones, and
mapping their wording onto them is your job, not a shipped phrase list.

| user means | op | scope |
|---|---|---|
| "both review" | `--set <activity>.review=council` | **disambiguate**: which activity? If both, pass `--set plan-authoring.review=council --set plan-execution.review=council`. |
| "one reviewer" | `--set <activity>.review=reviewed` | per the named activity, else ask |
| "delegate execution" | `--set plan-execution.execute=delegated` | execution only (a **bridge** runs the change) |
| "let a subagent do it" | `--set <activity>.<slot>=subagent` | **disambiguate**: which work? `--set plan-execution.execute=subagent` (a slice of the change), `--set plan-authoring.author=subagent` (a plan/contract brief), `--set plan-authoring.fold=subagent` (the round's findings and dispositions), `--set routine.carrier=subagent` (a bounded chore) |
| "one slice at a time" | `--set routine.parallel=off` | `routine` only — `parallel` is a **flag**, not a recipe |
| "revert / do it myself" | `--unset <activity>.<slot>` | the named slot → its computed default |

Run **`node ${CLAUDE_SKILL_DIR}/tools/set-recipe.mjs [--set <activity>.<slot>=<value>]… [--unset <activity>.<slot>]… [--write] [--json]`**:

1. **Grammar — always fully-qualified `<activity>.<slot>`** (the kit never guesses the activity; a bare `review=council` is rejected). The writer takes **every slot of the four activities**, and `--help` prints the registry (`tools/carriers.mjs`) as two blocks:

   ```
   Activities and their slots:
     plan-authoring → author, fold, review
     plan-execution → execute, review
     routine → carrier, parallel
     feedback-triage → review

   Accepted values per slot type:
     review slots accept solo | reviewed | council
     execute slots accept solo | delegated | subagent
     carrier slots accept solo | subagent
     switch slots accept on | off
   ```

   `parallel` is a **flag**, not a recipe: it resolves outside the recipe lattice and is never degraded. Examples: `--set routine.carrier=subagent`, `--set routine.parallel=off`, `--set plan-authoring.author=subagent`, `--set plan-authoring.fold=subagent`. A value outside its slot's list is a **usage** error (`2`) naming the accepted values, never a coercion to a neighbour.
2. **Preview by default** — prints `current → proposed` for the **changed** slots only, plus the **effective recipe resolved against live carrier readiness** (degradation stated honestly, e.g. *council requested, 1 ready reviewer → runs reviewed until a 2nd backend is ready*; *subagent requested, the executor vehicle is `missing` → runs solo until the vehicle is placed, naming the apply command*). A `parallel` value is reported as requested — a flag has nothing to degrade against. It writes **nothing**. Re-run with **`--write`** to apply (same effective/degradation note — a direct `--write` is never quieter than the preview). `--unset` returns a slot to its computed default (reverting needs no hand-edit either). A no-op `--set` (slot already equals) writes nothing and never re-seeds the onboarding note.
3. **`--write`** applies via a hardened, atomic write (deployment-gated — refuses to scatter a config into a repo with no `docs/ai`; exclusive-create temp + rename; symlink/TOCTOU-safe; last-writer-wins). It preserves the onboarding note + every untouched slot, normalizing to canonical 2-space JSON.
   **Standing-consent advisory (after a successful `--write` only, and only when the written config names a `reviewed`/`council` recipe — a solo recipe gets NO advisory):** advise the ONE-TIME **hand-adds** to the maintainer's `.claude/settings.local.json` — `Bash(codex-review:*)` + `Bash(agy-review:*)` + `Bash(node <skill-dir>/tools/grounding.mjs:*)`, with the path your project actually reaches the kit by. State plainly: (a) auto-approving a review wrapper **spends subscription quota without a per-run prompt** — that is exactly what standing consent means here, so it is the maintainer's call; (b) the kit **never writes that file** — these stay hand-adds; (c) `grounding.mjs --out` writes ONE scratch facts file — that write is what the standing consent covers; (d) the entry must match the invocation **byte-form your project actually uses, INCLUDING quoting** — the procedures advisor renders a QUOTED path for the grounding pre-step (the readers-sweep command renders bare, matching the kit-tools tier), and a hand-add covering it must use the same spelling (a mismatched spelling is a dead rule that simply prompts).
4. **Exit codes:** `0` success (an explicit recipe that gracefully degrades is still `0`); `2` usage (a bare/duplicate op, or `--write` with no ops); `1` config error (malformed/unreadable config — the file is left **untouched**, never clobbered) or a write STOP (no deployment / a symlinked config). A `1`/`2` failure is loud; on a malformed config, offer to show the parse error so you can help the user fix the JSON.

Output is **English/structured** — **localize it to the user's conversational language** when you narrate. Surface the effective-recipe/degradation note plainly.

**Invariants:** writer (writes only `docs/ai/orchestration.json`) · never commits · never runs a subscription CLI · previews by default · degradation honesty on preview AND `--write` · hand-edit stays first-class.
