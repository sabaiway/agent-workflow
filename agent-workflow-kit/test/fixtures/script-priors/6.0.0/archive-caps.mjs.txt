#!/usr/bin/env node
// The ONE cap table the rolling changelog archive stamps from.
//
// Each tier's frontmatter `maxLines` used to be a LITERAL inside the builder that wrote it: COLD
// 1500, WARM 3500, META 300. A literal is a promise about a corpus nobody has seen yet, so the day a
// tier outgrew its number the archiver emitted a file the docs gate refuses — its own output failing
// its own gate — and the repair was to hand-raise the number in the emitted file until the next run
// stamped the literal straight back over it.
//
// capFor stamps a cap the file HONOURS: the tier FLOOR while the file fits under it, the file's OWN
// line count once it does not, and a REFUSAL once that count passes the tier CEILING. A growing
// archive therefore stays green with no hand edit, and an archive that has grown past what its tier
// was ever meant to hold STOPS the run instead of stamping a number nobody chose.
//
// The ceiling is 2x the floor, FIXED here and never measured from a corpus. The refusal rides the
// standing `--check` gate, so a ceiling derived from whatever happened to be on disk the day someone
// wrote the test would brick every commit as soon as the corpus grew past it.
//
// Dependency-free (one sibling import for the shared failure shape), Node >= 22. No side effects on
// import.

import { fail } from './markdown-blocks.mjs';

// Each tier carries its OWN remedy, because the three run out of room for different reasons and one
// piece of advice is wrong for two of them: COLD is already sharded per month, and WARM is a window
// whose size is a flag, not a file layout.
//
// A remedy must never instruct a layout this archiver cannot READ BACK. COLD files are discovered by
// `/^\d{4}-\d{2}\.md$/` alone, so a hand-split `2026-03-a.md` would silently drop out of the corpus
// on the next run — conservation lost by following our own advice. META is always regenerated as a
// single `condensed-index.md`, so a per-year file would be orphaned the moment it was written. Both
// therefore name the work as UNIMPLEMENTED rather than telling anyone to do it. Only WARM's remedy
// is something a run supports today: `--warm-days` is a flag, not a file layout.
export const CAP_TABLE = Object.freeze({
  // COLD — docs/ai/history/YYYY-MM.md: one CLOSED month of compressed entries. A closed month never
  // grows again, so its stamp is a fact about that month, not a forecast.
  cold: Object.freeze({
    floor: 1500,
    ceiling: 3000,
    remedy: 'compress that month harder — it is already one file per month, and sub-month sharding is NOT implemented (discovery matches YYYY-MM.md only, so a hand-split file would drop out of the corpus)',
  }),
  // WARM — docs/ai/history/recent.md: a rolling window of full-text entries, the widest tier.
  warm: Object.freeze({
    floor: 3500,
    ceiling: 7000,
    remedy: 'shorten the WARM window with --warm-days so the oldest entries move on to COLD',
  }),
  // META — docs/ai/history/condensed-index.md: one line per archived entry, so it grows O(total) and
  // never sheds. Its floor rose 300 -> 1500 because 300 never fit the ~1159-at-2y growth the
  // archiver's own header documents; the ceiling is where per-year sharding stops being optional.
  meta: Object.freeze({
    floor: 1500,
    ceiling: 3000,
    remedy: 'shard it per-year (condensed-index-YYYY.md) — NOT implemented yet: this file is always regenerated whole, so the split needs discovery and generation before anyone splits it by hand',
  }),
});

export const TIERS = Object.freeze(Object.keys(CAP_TABLE));

// The docs gate's OWN line count (check-docs-size.mjs): a trailing newline terminates the last line,
// it does not open a new one. Counting any other way would stamp a cap the gate disagrees with —
// precisely the failure this module exists to end.
export const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// Object.hasOwn, never a bare lookup: `CAP_TABLE['toString']` finds an INHERITED function, which is
// truthy, and the stamp then reads `undefined` off it and writes `maxLines: undefined`. An unknown
// tier has to refuse, and "unknown" includes every name Object.prototype happens to carry.
const bandFor = (tier) => {
  if (!Object.hasOwn(CAP_TABLE, tier)) {
    throw fail(1, `unknown archive tier: ${String(tier)} (known: ${TIERS.join(', ')})`);
  }
  return CAP_TABLE[tier];
};

const assertCount = (tier, count) => {
  if (!Number.isInteger(count) || count < 0) {
    throw fail(1, `${tier}: line count must be a non-negative integer, got ${JSON.stringify(count)}`);
  }
};

// The stamp. `count` is the FINAL line count of the file being written, frontmatter included — the
// caller renders the whole file once with a placeholder cap, counts it, and renders again with what
// this returns. The stamped integer occupies one line either way, so the second render has the same
// count as the first and the value is a fixed point.
export const capFor = ({ tier, count }) => {
  const band = bandFor(tier);
  assertCount(tier, count);
  if (count > band.ceiling) {
    throw fail(
      1,
      `${tier} archive is ${count} lines, past its ${band.ceiling}-line ceiling — there is no cap it ` +
        `can both stamp and honour. Remedy: ${band.remedy}. Raising the ceiling is a reviewed edit to ` +
        `archive-caps.mjs, never something a run decides for itself.`,
    );
  }
  return count > band.floor ? count : band.floor;
};

// The sharding tripwire. A tier past its FLOOR still stamps and still passes — it is simply growing
// on room the floor was not sized for. Warning here puts the remedy in front of whoever runs the
// archiver while there is still headroom, instead of at the ceiling where the run refuses.
export const shardingWarning = ({ tier, count }) => {
  const band = bandFor(tier);
  assertCount(tier, count);
  if (count <= band.floor) return null;
  return (
    `${tier} archive is ${count} lines, past its ${band.floor}-line floor (ceiling ${band.ceiling}) — ` +
    `it is stamping its own count. Remedy before the count goes PAST the ceiling and the run refuses: ${band.remedy}.`
  );
};
