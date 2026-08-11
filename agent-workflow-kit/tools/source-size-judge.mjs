// source-size-judge.mjs — the verdict as FACTS, never as words, and the ONE projection everything
// else reads. Measures every in-scope file once, projects the record the regenerator WOULD write for
// it, and states each difference against what is recorded today. The rendering half turns those
// differences into words; the writer half turns the very same projection into the file — so the
// checker can never demand something the regenerator would not do, nor pass a tree the regenerator
// would rewrite.
//
// The ratchet, stated once (D-3, D-4): a recorded size is DEBT, not permission. It may not grow
// (that is a raise, and a raise is reasoned); it may not sit ABOVE what the tree measures (a stale
// record is headroom nobody earned); it may not outlive the violation it records (a file back under
// the cap keeps no record); and a record whose file is gone is an error, because that is what makes
// a split or a rename visible instead of silent. The per-root budget rides the same rules over the
// summed LINES of the root — splitting one file into six buys no headroom at all.
//
// Dependency-free, Node >= 22. No writes, no side effects on import.

import { measureFile, resolveScope } from './source-size-scope.mjs';

export const DIMENSIONS = Object.freeze(['lines', 'maxLineBytes']);

// The measured dimension names ARE the baseline-entry keys; `defaults` spells the line cap
// differently, so the two vocabularies are bridged in exactly one place.
export const DEFAULT_KEY = Object.freeze({ lines: 'maxLines', maxLineBytes: 'maxLineBytes' });

// THE projection: a record exists for a dimension exactly while that dimension violates the declared
// default. An entry pinning a dimension that was never over the cap would make the ratchet refuse
// later changes nobody chose, so the entry appears with the violation and disappears with it.
export const recordFor = (measured, defaults) => Object.fromEntries(
  DIMENSIONS.filter((dimension) => measured[dimension] > defaults[DEFAULT_KEY[dimension]])
    .map((dimension) => [dimension, measured[dimension]]),
);

// A change is a RAISE when it puts a number where there was none, or a bigger one where there was a
// smaller — the whole class a human's reason is required for. Everything else lowers or removes.
export const isRaise = ({ from, to }) => to !== null && (from === null || to > from);

// A recorded entry is read by OWN key only. A declared root may legitimately be named like an
// Object.prototype member ("constructor", "toString"), and a plain lookup would then answer with an
// INHERITED value — which reads as "already recorded", so the raise goes unnoticed and the entry is
// written with no reason at all, producing a config this tool's own validator refuses.
export const ownEntry = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

// changesFor(target, projected, recorded) → the per-dimension old→new pairs that actually differ.
// The refusal, the printed delta and the reason an entry ends up with all read THIS.
export const changesFor = (target, projected, recorded) => DIMENSIONS
  .map((dimension) => ({
    target,
    dimension,
    from: recorded && Object.hasOwn(recorded, dimension) ? recorded[dimension] : null,
    to: Object.hasOwn(projected, dimension) ? projected[dimension] : null,
  }))
  .filter(({ from, to }) => from !== to);

const GROWTH_KINDS = new Set(['over-default', 'grew', 'aggregate-grew', 'aggregate-unrecorded']);

// D-9: the unmechanizable question — real decomposition, or the same coupling spread thinner? — is
// asked exactly where a record went DOWN or disappeared, and the checker itself raises it there.
const LOWERED_KINDS = new Set(['stale', 'record-obsolete', 'entry-gone']);

export const hasGrowth = (findings) => findings.some((f) => GROWTH_KINDS.has(f.kind));
export const hasLoweredRecord = (findings) => findings.some((f) => LOWERED_KINDS.has(f.kind));

const findingOfChange = (rel, { dimension, from, to }, measured, defaults) => {
  const allowed = defaults[DEFAULT_KEY[dimension]];
  if (from === null) return { kind: 'over-default', rel, dimension, actual: to, allowed };
  // `to === null` — the file is back under the cap, so the projection records nothing. The measured
  // value is what the reader needs to see; the record is simply obsolete.
  if (to === null) return { kind: 'record-obsolete', rel, dimension, actual: measured[dimension], allowed, recorded: from };
  return to > from
    ? { kind: 'grew', rel, dimension, actual: to, recorded: from }
    : { kind: 'stale', rel, dimension, actual: to, recorded: from };
};

const judgeAggregate = (rootLines, aggregate) => {
  const findings = [];
  for (const [root, actual] of rootLines) {
    if (!Object.hasOwn(aggregate, root)) {
      findings.push({ kind: 'aggregate-unrecorded', root, actual });
      continue;
    }
    const value = aggregate[root].lines;
    if (actual > value) findings.push({ kind: 'aggregate-grew', root, actual, recorded: value });
    else if (actual < value) findings.push({ kind: 'aggregate-stale', root, actual, recorded: value });
  }
  // The recorded set must MIRROR the declared roots: a budget nobody declares any more is a leftover
  // that hides its own root's disappearance, and deleting an entry must never be a way to disarm it.
  for (const root of Object.keys(aggregate)) {
    if (!rootLines.has(root)) findings.push({ kind: 'aggregate-root-gone', root, recorded: aggregate[root].lines });
  }
  return findings;
};

// judgeTree(cwd, config) → { scope, measured, projected, rootLines, findings }. EVERY in-scope file
// is measured, recorded or not: the fail-closed scope rule has no baseline exception, so an
// unreadable or non-UTF-8 file refuses even when its size is recorded debt.
export const judgeTree = (cwd, config, deps = {}) => {
  const scope = resolveScope(cwd, config, deps);
  const measured = new Map(scope.files.map((rel) => [rel, measureFile(cwd, rel, deps)]));
  const projected = new Map(scope.files.map((rel) => [rel, recordFor(measured.get(rel), config.defaults)]));
  const baseline = config.baseline ?? {};
  const findings = [];
  for (const rel of scope.files) {
    findings.push(...changesFor(rel, projected.get(rel), ownEntry(baseline, rel))
      .map((change) => findingOfChange(rel, change, measured.get(rel), config.defaults)));
  }
  for (const rel of Object.keys(baseline)) {
    if (!measured.has(rel)) findings.push({ kind: 'entry-gone', rel, recorded: baseline[rel] });
  }
  const rootLines = new Map(
    [...scope.perRoot].map(([root, files]) => [root, files.reduce((sum, rel) => sum + measured.get(rel).lines, 0)]),
  );
  findings.push(...judgeAggregate(rootLines, config.aggregate ?? {}));
  return { scope, measured, projected, rootLines, findings };
};
