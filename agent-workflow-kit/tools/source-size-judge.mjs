// source-size-judge.mjs — the verdict as FACTS, never as words, and the ONE projection everything
// else reads: every in-scope file and judged directory measured once, the record the regenerator
// WOULD write projected, and each difference against today's record stated — so the checker can
// never demand what the regenerator would not do, nor, on a present config, pass a tree whose regeneration would raise.
//
// The ratchet (D-3, D-4): a recorded size is DEBT, not permission. Each limit is judged with its
// band; a finding STOPS exactly when the regeneration would RAISE (beyond the band with no record, a
// record that grew, an unrecorded root) and WARNS otherwise (within the band, a record above the
// tree, no longer needed or gone). Each root's summed LINES ride the same ratchet with no band.
//
// Dependency-free, Node >= 22. No writes, no side effects on import.

import { measureFile, resolveScope, specStoreEntries } from './source-size-scope.mjs';
import { scopeFail } from './source-size-refusal.mjs';
import { SPEC_STORE_ROOT, bandOf, changesFor, isRaise, layoutCounts, ownEntry, projectLayout } from './source-size/index.mjs';

export const DIMENSIONS = Object.freeze(['lines', 'maxLineBytes']);
const LAYOUT_DIMENSIONS = Object.freeze(['entries', 'depth']);
export const STOP = 'stop';
export const WARNING = 'warning';

// The kit limit each measured dimension is judged against.
const LIMIT_OF = Object.freeze({ lines: 'lines-per-file', maxLineBytes: 'bytes-per-line', entries: 'entries-per-directory', depth: 'depth' });
const ceilingOf = ({ value, tolerance }) => value + bandOf(value, tolerance);
const withinBand = (value, limit) => value > limit.value && value <= ceilingOf(limit);

// THE projection: a record exists for a dimension exactly while that dimension is beyond its band. A
// value within the band warns and carries no record, so a record of one is obsolete.
export const recordFor = (measured, limits) => Object.fromEntries(
  DIMENSIONS.filter((dimension) => measured[dimension] > ceilingOf(limits[LIMIT_OF[dimension]]))
    .map((dimension) => [dimension, measured[dimension]]),
);

const BAND_KINDS = new Set(['within-band', 'root-band', 'dir-band']);
// D-9: the unmechanizable question — real decomposition, or the same coupling spread thinner? — is
// asked exactly where a record went DOWN or disappeared, and the checker itself raises it there.
const LOWERED_KINDS = new Set(['stale', 'record-obsolete', 'entry-gone', 'root-stale', 'root-gone', 'dir-stale', 'dir-obsolete', 'dir-gone']);

export const stopsOf = (findings) => findings.filter((f) => f.severity === STOP);
export const warningsOf = (findings) => findings.filter((f) => f.severity === WARNING);
export const bandWarningsOf = (findings) => findings.filter((f) => BAND_KINDS.has(f.kind));
// The warnings a write leaves standing: a value within its band, one whose obsolete record it drops included.
const BAND_OF_OBSOLETE = Object.freeze({ 'record-obsolete': 'within-band', 'dir-obsolete': 'dir-band' });
export const standingWarningsOf = (findings) => findings.flatMap((f) => {
  if (BAND_KINDS.has(f.kind)) return [f];
  const kind = BAND_OF_OBSOLETE[f.kind];
  return kind && f.dimension !== 'depth' && f.actual > f.allowed && f.actual <= f.ceiling ? [{ ...f, kind }] : [];
});
export const hasLoweredRecord = (findings) => findings.some((f) => LOWERED_KINDS.has(f.kind));
// The spec store's files count, recorded before files per root left the store: no decomposition, so no focus line.
export const hasStoreRecord = (findings) => findings.some((f) => f.kind === 'store-record');

// One rule for every recorded number: a raise stops, any other change warns. `kinds` names no record
// yet, grew, lowered and no longer needed in the target's own vocabulary.
const changeFinding = (target, { dimension, from, to }, actual, limits, kinds) => ({
  kind: kinds[from === null ? 0 : to === null ? 3 : to > from ? 1 : 2], severity: isRaise({ from, to }) ? STOP : WARNING, ...target, dimension,
  actual, allowed: limits[LIMIT_OF[dimension]].value, ceiling: ceilingOf(limits[LIMIT_OF[dimension]]), ...(from === null ? {} : { recorded: from }),
});
const bandFinding = (kind, target, dimension, actual, limit) => ({ kind, severity: WARNING, ...target, dimension, actual, allowed: limit.value, ceiling: ceilingOf(limit) });

const FILE_KINDS = ['over-default', 'grew', 'stale', 'record-obsolete'];
const DIR_KINDS = ['dir-over', 'dir-grew', 'dir-stale', 'dir-obsolete'];

const fileFindings = (rel, measured, projected, recorded, limits) => {
  const changes = changesFor(rel, projected, recorded);
  return [
    ...changes.map((change) => changeFinding({ rel }, change, measured[change.dimension], limits, FILE_KINDS)),
    ...DIMENSIONS.filter((d) => withinBand(measured[d], limits[LIMIT_OF[d]]) && !changes.some((c) => c.dimension === d))
      .map((d) => bandFinding('within-band', { rel }, d, measured[d], limits[LIMIT_OF[d]])),
  ];
};

const judgeAggregate = (rootLines, aggregate) => {
  const findings = [];
  for (const [root, actual] of rootLines) {
    const recorded = ownEntry(aggregate, root)?.lines;
    if (recorded === undefined) findings.push({ kind: 'aggregate-unrecorded', severity: STOP, root, actual });
    else if (actual > recorded) findings.push({ kind: 'aggregate-grew', severity: STOP, root, actual, recorded });
    else if (actual < recorded) findings.push({ kind: 'aggregate-stale', severity: WARNING, root, actual, recorded });
  }
  // The recorded set must MIRROR the declared roots: a budget nobody declares any more warns until
  // the writer drops it, and deleting an entry must never be a way to disarm it.
  for (const root of Object.keys(aggregate)) {
    if (!rootLines.has(root)) findings.push({ kind: 'aggregate-root-gone', severity: WARNING, root, recorded: aggregate[root].lines });
  }
  return findings;
};

// A directory is keyed by its repo-relative path, a root's own by its declared name. A name that is
// not lossless UTF-8 is counted, and refused only once a record would have to carry it.
const measureLayout = (cwd, config, scope, deps) => {
  const counted = config.roots.map((root) => [root, scope.layout.get(root)]);
  const store = specStoreEntries(cwd, deps);
  if (store !== null) counted.push([SPEC_STORE_ROOT, store]);
  const roots = new Map();
  const directories = new Map();
  const undecodable = [];
  for (const [root, entries] of counted) {
    const counts = layoutCounts(entries);
    if (root !== SPEC_STORE_ROOT) roots.set(root, counts.files);
    const base = Buffer.from(root, 'utf8').toString('latin1');
    for (const [below, facts] of counts.directories) {
      const bytes = Buffer.from(below === '' ? base : root === '.' ? below : `${base}/${below}`, 'latin1');
      const key = bytes.toString('utf8');
      if (Buffer.from(key, 'utf8').equals(bytes)) directories.set(key, facts);
      else undecodable.push({ bytes, facts });
    }
  }
  return { roots, directories, undecodable };
};

// The absent config records nothing, so the roots' files a first write would record are no findings.
const rootFindings = (measured, projected, recorded, tolerance) => {
  const findings = [];
  for (const [root, actual] of measured.roots) {
    const was = ownEntry(recorded.roots, root)?.files ?? null;
    const ceiling = was === null ? undefined : was + bandOf(was, tolerance);
    if (was === null) findings.push({ kind: 'root-unrecorded', severity: STOP, root, actual });
    else if (projected.roots[root] > was) findings.push({ kind: 'root-grew', severity: STOP, root, actual, recorded: was, ceiling });
    else if (projected.roots[root] < was) findings.push({ kind: 'root-stale', severity: WARNING, root, actual, recorded: was });
    else if (actual > was) findings.push({ kind: 'root-band', severity: WARNING, root, actual, recorded: was, ceiling });
  }
  for (const [root, was] of Object.entries(recorded.roots)) {
    if (!measured.roots.has(root)) findings.push({ kind: root === SPEC_STORE_ROOT ? 'store-record' : 'root-gone', severity: WARNING, root, recorded: was.files });
  }
  return findings;
};

// A recorded dimension is judged as a file's; within its band warns, depth one level past the value.
const directoryFindings = (directories, projected, recorded, limits) => {
  const findings = [];
  for (const dir of Object.keys(recorded).filter((key) => !directories.has(key))) {
    findings.push({ kind: 'dir-gone', severity: WARNING, dir, recorded: recorded[dir] });
  }
  for (const [dir, facts] of directories) {
    const was = ownEntry(recorded, dir);
    const changes = changesFor(dir, projected[dir] ?? {}, was, LAYOUT_DIMENSIONS);
    const actual = { entries: facts.entries, depth: facts.reach };
    findings.push(...changes.map((change) => changeFinding({ dir }, change, actual[change.dimension], limits, DIR_KINDS)));
    const entries = limits['entries-per-directory'];
    if (withinBand(facts.entries, entries) && !(was && Object.hasOwn(was, 'entries'))) findings.push(bandFinding('dir-band', { dir }, 'entries', facts.entries, entries));
    if (facts.depth === limits.depth.value + 1 && withinBand(facts.reach, limits.depth)) findings.push(bandFinding('dir-band', { dir }, 'depth', facts.reach, limits.depth));
  }
  return findings;
};

const judgeLayout = (cwd, config, scope, deps, { absent }) => {
  const measured = measureLayout(cwd, config, scope, deps);
  const { limits } = config;
  const unkeyable = measured.undecodable.find(({ facts }) => facts.entries > ceilingOf(limits['entries-per-directory']) || facts.depth === ceilingOf(limits.depth) + 1);
  if (unkeyable) throw scopeFail(`a judged directory's NAME is not valid UTF-8 (bytes ${unkeyable.bytes.toString('hex')}) and it is beyond its band — its record could not be keyed losslessly, so nothing is judged; rename it`);
  const recorded = config.layout ?? { roots: {}, directories: {} };
  const projected = projectLayout(measured, config.layout, limits);
  const lossy = new Map(measured.undecodable.map(({ bytes, facts }) => [bytes.toString('utf8'), facts]));
  const findings = [
    ...(absent ? [] : rootFindings(measured, projected, recorded, limits['files-per-root'].tolerance)),
    ...directoryFindings(measured.directories, projected.directories, recorded.directories, limits),
    ...directoryFindings(lossy, {}, {}, limits),
  ];
  return { measured, projected, findings };
};

// judgeTree(cwd, config, deps, { layout, absent }) → { scope, measured, projected, rootLines, layout,
// findings }. EVERY in-scope file is measured, recorded or not: an unreadable or non-UTF-8 file
// refuses even when its size is recorded debt. An absent config's aggregate is no finding.
export const judgeTree = (cwd, config, deps = {}, { layout = false, absent = false } = {}) => {
  const scope = resolveScope(cwd, config, deps);
  const measured = new Map(scope.files.map((rel) => [rel, measureFile(cwd, rel, deps)]));
  const projected = new Map(scope.files.map((rel) => [rel, recordFor(measured.get(rel), config.limits)]));
  const baseline = config.baseline ?? {};
  const findings = scope.files.flatMap((rel) => fileFindings(rel, measured.get(rel), projected.get(rel), ownEntry(baseline, rel), config.limits));
  for (const rel of Object.keys(baseline)) {
    if (!measured.has(rel)) findings.push({ kind: 'entry-gone', severity: WARNING, rel, recorded: baseline[rel] });
  }
  const rootLines = new Map(
    [...scope.perRoot].map(([root, files]) => [root, files.reduce((sum, rel) => sum + measured.get(rel).lines, 0)]),
  );
  if (!absent) findings.push(...judgeAggregate(rootLines, config.aggregate ?? {}));
  const judged = layout ? judgeLayout(cwd, config, scope, deps, { absent }) : null;
  if (judged) findings.push(...judged.findings);
  return { scope, measured, projected, rootLines, layout: judged, findings };
};
