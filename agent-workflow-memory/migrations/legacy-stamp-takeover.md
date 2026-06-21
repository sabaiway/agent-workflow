# Migration legacy-stamp-takeover

**From:** a deployment stamped only with the legacy `docs/ai/.workflow-version` (a kit-fallback
bootstrap, or a pre-extraction kit deployment)   **To:** the memory substrate's
`docs/ai/.memory-version`

This is the **no-Node manual fallback** for `scripts/stamp-takeover.mjs`. The script is the
source of truth (pure state machine + atomic writes, unit-tested per row); this file documents
the same table so a non-Node project can do it by hand. Run it **first** in `upgrade`, before
any other migration.

## Why

The deployment stamp moved from `.workflow-version` (owned by the kit) to `.memory-version`
(owned by this substrate). They track the **same** shared deployment-lineage sequence — never
their package versions. The current lineage head is **`1.3.0`** (`LINEAGE_HEAD`). This migration
adopts an existing legacy stamp into the new file **without** changing the lineage value and
**without** deleting the legacy stamp (both may coexist; each tool migrates from its own stamp).

## State table (idempotent)

Look at `docs/ai/` and act by row. `V` is the legacy stamp's value; `head` = `1.3.0`.

| `docs/ai/` state | Action |
|---|---|
| only `.workflow-version=V` | copy `V` **verbatim** → `.memory-version`; **leave** `.workflow-version`; then apply only memory migrations `> V` |
| both `.memory-version` and `.workflow-version` | **no-op** for takeover; migrate from `.memory-version` |
| only `.memory-version` | no takeover; migrate from it |
| no stamp | conservative re-bootstrap offer (existing behaviour) |
| any present stamp unparseable, or `> head` (future) | **STOP and report** — never downgrade or guess |

## Steps (manual)

1. **Inspect** the two files. Distinguish *absent* (the file does not exist) from a *read failure*
   (it exists but `cat` fails — permission/I/O): only absence is "no stamp"; a read failure must
   **STOP** (don't treat it as absent):
   ```bash
   for f in docs/ai/.memory-version docs/ai/.workflow-version; do
     if [ ! -e "$f" ]; then echo "$f: (absent)";
     elif v=$(cat "$f"); then echo "$f: $v";
     else echo "$f: READ FAILED — STOP and report"; exit 1; fi
   done
   ```
2. **Validate** each value that exists: it must be `MAJOR.MINOR.PATCH`, non-empty, and **not** greater
   than `1.3.0`. If any present stamp is empty, unparseable, or in the future → **STOP and report**;
   do nothing else.
3. **Apply** the matching row above. For the "only `.workflow-version=V`" row, copy verbatim and
   write **atomically** — create an exclusive randomized temp in `docs/ai/` (so a planted temp-name
   symlink can't be followed), then `mv` it over the target:
   ```bash
   v=$(cat docs/ai/.workflow-version)
   tmp=$(mktemp docs/ai/.memory-version.XXXXXX) && printf '%s\n' "$v" > "$tmp" && mv "$tmp" docs/ai/.memory-version
   ```
4. Continue the normal `upgrade` flow: apply memory migrations strictly newer than the resolved
   stamp, then re-stamp `.memory-version` to the lineage head.

Node projects do all of this in one call — pass the project's `docs/ai` directory:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/stamp-takeover.mjs" docs/ai   # runs applyTakeover() on docs/ai
```

## Verification

- `docs/ai/.memory-version` exists and equals the resolved lineage value (a single semver line,
  trailing newline). `docs/ai/.workflow-version`, if it existed, is **unchanged**.
- Re-running this migration changes nothing (idempotent).
- No `.memory-version.tmp-*` files remain in `docs/ai/`.

## Rollback

Delete `docs/ai/.memory-version` (the legacy `.workflow-version` was never modified). No other
files were changed.
