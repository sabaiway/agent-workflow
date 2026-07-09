# ADR record format — authoring & lifecycle reference

> How an Architecture Decision Record is authored, archived, and retrieved in this project's
> **one-file-per-ADR** store. Read this when you author a new ADR or change an existing one's
> lifecycle. This file is a reference — it is **not** deployed into `docs/ai/` (it never becomes a
> record itself).

## Where ADRs live

- **HOT window — `docs/ai/decisions.md`.** The active ADR window. You **author here**, newest at the
  bottom. It is self-bounding under its frontmatter `maxLines`.
- **Store — `docs/ai/adr/AD-NNN-slug.md`.** One immutable record per archived ADR (full frontmatter +
  the verbatim `## AD-NNN — title` block). You **never hand-write** these — `archive-decisions.mjs`
  produces them by exploding the oldest HOT entries beyond the cap.
- **Navigator — `docs/ai/adr/log.md`.** The one generated map: the currently-governing heads
  (accepted ∧ not superseded) + a recent window. Superseded ADRs drop OUT (still reachable by
  filename, grep, or the `[[AD-NNN]]` chain). It is a navigator, never a full ledger.

## Authoring a new ADR (in the HOT window)

Append a block at the **bottom** of `docs/ai/decisions.md`:

```
## AD-NNN — <concise title>

**Date:** YYYY-MM-DD
**Status:** Accepted

**Context.** Why this decision is needed; the forces at play.
**Decision.** What was chosen (imperative, unambiguous).
**Consequences.** ➕ benefits · ➖ costs. Note any ADR this supersedes.
```

- **ID grammar: `AD-\d{3,}`.** Three digits minimum; `AD-1000+` is valid. Allocate the next integer
  after the highest id across HOT ∪ `adr/`. Ordering is always **numeric**, never lexical.
- **The `## AD-NNN — <title>` heading is strict.** Use the em dash ` — `. A non-canonical `## ` heading
  is a loud parse failure — the store never silently glues an entry to the previous body.
- **`slug` is cosmetic and frozen at creation** (`slugify(title)`); the `AD-NNN` prefix is the key. A
  retitle never renames the file.
- The block is preserved **verbatim** when it is archived, so write it as you want it to persist.

## Lifecycle (the only mutable part after acceptance)

The **body is immutable** once accepted — only lifecycle changes. Express supersession in the body of
the **new** ADR; governance is then computed automatically (no predecessor-file edit is required):

| Body form (in the newer ADR)     | Effect                                                            |
|----------------------------------|------------------------------------------------------------------|
| `Supersedes [[AD-NNN]]`          | retires AD-NNN (when the citing ADR is `accepted`)               |
| `Superseded by [[AD-NNN]]`       | marks this ADR retired by AD-NNN                                  |
| `Amended by [[AD-NNN]]`          | marks this ADR amended (also drops it from the governing heads)  |

- **`status`** is the leading word of `**Status:**`, lowercased (`accepted` / `superseded` /
  `amended` / `deprecated`). A **missing** `**Status:**` line defaults to `accepted` (the in-force
  default). Only `accepted` ADRs govern.
- When an ADR is archived, its record frontmatter backfills `status`, `date`, `supersedes`, and
  `supersededBy` from these body forms — you do not maintain the frontmatter by hand.

## Retrieval (never through an O(n) artifact)

- **by id** → the deterministic filename `docs/ai/adr/AD-NNN-*.md` (glob).
- **by topic** → `grep` the flat `docs/ai/adr/` tree.
- **by lifecycle** → the two-way `supersedes` / `supersededBy` frontmatter + the `[[AD-NNN]]` chain;
  `ls docs/ai/adr/` IS the log.

## Commands

- `node scripts/archive-decisions.mjs` — rotate: explode the oldest HOT entries beyond the cap into
  `adr/` records, then regenerate the navigator + `docs/ai/index.md`.
- `node scripts/archive-decisions.mjs --write-navigator` — regenerate `docs/ai/adr/log.md` (and the
  index) after authoring an ADR or editing a supersession, so `--check` stays green.
- `node scripts/archive-decisions.mjs --check` — verify HOT cap + store integrity + navigator freshness.
