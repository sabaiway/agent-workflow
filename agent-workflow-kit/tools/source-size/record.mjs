// record.mjs — the recorded ratchet as data: the delta rules every half reads, the layout record a
// regeneration would write, the regeneration plan, its materialization with each reason, and the
// canonical serialization. Pure: it writes no file and spawns no process — the writer half applies
// it and owns the one write.
//
// Dependency-free, Node >= 22. No side effects on import.

import { bandOf } from './layout.mjs';

const FILE_DIMENSIONS = Object.freeze(['lines', 'maxLineBytes']);
const LAYOUT_DIMENSIONS = Object.freeze(['entries', 'depth']);
const MACHINE_KEYS = Object.freeze(['baseline', 'aggregate', 'layout']);

// A recorded entry is read by OWN key only. A declared root may legitimately be named like an
// Object.prototype member ("constructor", "toString"), and a plain lookup would then answer with an
// INHERITED value — which reads as "already recorded", so the raise goes unnoticed and the entry is
// written with no reason at all, producing a config the validator refuses.
export const ownEntry = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

// A change is a RAISE when it puts a number where there was none, or a bigger one where there was a
// smaller — the whole class a human's reason is required for. Everything else lowers or removes.
export const isRaise = ({ from, to }) => to !== null && (from === null || to > from);

// changesFor(target, projected, recorded, dimensions) → the per-dimension old→new pairs that differ.
// The refusal, the printed delta and the reason an entry ends up with all read THIS.
export const changesFor = (target, projected, recorded, dimensions = FILE_DIMENSIONS) => dimensions
  .map((dimension) => ({
    target,
    dimension,
    from: recorded && Object.hasOwn(recorded, dimension) ? recorded[dimension] : null,
    to: Object.hasOwn(projected, dimension) ? projected[dimension] : null,
  }))
  .filter(({ from, to }) => from !== to);

const ceilingOf = ({ value, tolerance }) => value + bandOf(value, tolerance);

// projectLayout(measured, recorded, limits) → the layout record a regeneration would write, without
// reasons. A root's files are written as measured, except a count above its record and within its
// band, which keeps the record: a warning never raises. A directory is recorded only beyond its band:
// `entries` its count, `depth` on the shallowest directory beyond the depth band, holding the deepest
// level its subtree reaches.
export const projectLayout = (measured, recorded, limits) => {
  const tolerance = limits['files-per-root'].tolerance;
  const roots = Object.fromEntries([...measured.roots].map(([root, files]) => {
    const kept = recorded ? ownEntry(recorded.roots, root) : undefined;
    const keep = kept !== undefined && files > kept.files && files <= kept.files + bandOf(kept.files, tolerance);
    return [root, keep ? kept.files : files];
  }));
  const entries = ceilingOf(limits['entries-per-directory']);
  const holder = ceilingOf(limits.depth) + 1;
  const directories = Object.fromEntries([...measured.directories].flatMap(([key, facts]) => {
    const next = {
      ...(facts.entries > entries ? { entries: facts.entries } : {}),
      ...(facts.depth === holder ? { depth: facts.reach } : {}),
    };
    return Object.keys(next).length > 0 ? [[key, next]] : [];
  }));
  return { roots, directories };
};

const layoutPlan = (recorded, projected) => {
  const old = recorded ?? { roots: {}, directories: {} };
  const roots = Object.entries(projected.roots).map(([root, next]) => ({ root, next, recorded: ownEntry(old.roots, root) }));
  const directories = Object.entries(projected.directories).map(([key, next]) => {
    const was = ownEntry(old.directories, key);
    return { key, next, recorded: was, changes: changesFor(key, next, was, LAYOUT_DIMENSIONS) };
  });
  const deltas = [
    ...roots
      .filter(({ next, recorded: was }) => (was ? was.files : null) !== next)
      .map(({ root, next, recorded: was }) => ({ target: root, dimension: 'files', from: was ? was.files : null, to: next })),
    ...Object.entries(old.roots)
      .filter(([root]) => !Object.hasOwn(projected.roots, root))
      .map(([root, was]) => ({ target: root, dimension: 'files', from: was.files, to: null })),
    ...directories.flatMap(({ changes }) => changes),
    ...Object.entries(old.directories)
      .filter(([key]) => !Object.hasOwn(projected.directories, key))
      .flatMap(([key, was]) => changesFor(key, {}, was, LAYOUT_DIMENSIONS)),
  ];
  return { roots, directories, deltas };
};

// planRecord({ config, verdict }) computes what the regeneration WOULD write, before any reason is
// applied — so a raise can be refused without ever building an entry that carries no reason. It reads
// the JUDGE's projection, never its own: the checker's verdict and the file the writer produces are
// then two renderings of one computation.
export const planRecord = ({ config, verdict }) => {
  const oldBaseline = config.baseline ?? {};
  const oldAggregate = config.aggregate ?? {};
  const files = verdict.scope.files.map((rel) => {
    const next = verdict.projected.get(rel);
    const recorded = ownEntry(oldBaseline, rel);
    return { rel, next, recorded, changes: changesFor(rel, next, recorded) };
  });
  const roots = config.roots.map((root) => ({ root, lines: verdict.rootLines.get(root) ?? 0, recorded: ownEntry(oldAggregate, root) }));
  const layout = verdict.layout ? layoutPlan(config.layout, verdict.layout.projected) : null;
  const deltas = [
    ...files.flatMap(({ changes }) => changes),
    // A record whose file left scope is REMOVED, never kept: that is what makes a split or a rename
    // visible in the delta instead of silently surviving as headroom.
    ...Object.entries(oldBaseline)
      .filter(([rel]) => !verdict.measured.has(rel))
      .flatMap(([rel, recorded]) => changesFor(rel, {}, recorded)),
    ...roots
      .filter(({ lines, recorded }) => (recorded ? recorded.lines : null) !== lines)
      .map(({ root, lines, recorded }) => ({ target: root, dimension: 'aggregate lines', from: recorded ? recorded.lines : null, to: lines })),
    ...Object.entries(oldAggregate)
      .filter(([root]) => !config.roots.includes(root))
      .map(([root, recorded]) => ({ target: root, dimension: 'aggregate lines', from: recorded.lines, to: null })),
    ...(layout ? layout.deltas : []),
  ];
  return { files, roots, layout, deltas, raises: deltas.filter(isRaise) };
};

const byKey = (entries) => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// The reason of an entry the regeneration did NOT raise is the one already recorded — a tighten
// rewrites a number, never the human sentence that justified it.
export const materialize = ({ files, roots, layout }, reason) => ({
  baseline: Object.fromEntries(
    files
      .filter(({ next }) => Object.keys(next).length > 0)
      .map(({ rel, next, recorded, changes }) => [rel, { ...next, reason: changes.some(isRaise) ? reason : recorded.reason }]),
  ),
  aggregate: Object.fromEntries(
    roots.map(({ root, lines, recorded }) => [root, { lines, reason: !recorded || lines > recorded.lines ? reason : recorded.reason }]),
  ),
  ...(layout === null ? {} : {
    layout: {
      roots: byKey(layout.roots.map(({ root, next, recorded }) => [root, { files: next, reason: !recorded || next > recorded.files ? reason : recorded.reason }])),
      directories: byKey(layout.directories.map(({ key, next, recorded, changes }) => [key, { ...next, reason: changes.some(isRaise) ? reason : recorded.reason }])),
    },
  }),
});

// The file is CANONICALLY serialized: the authored VALUES and the ORDER the human wrote them in are
// preserved exactly, their formatting is not — this file is machine-maintained and the writer owns
// half of it, so one deterministic rendering is what makes "regenerate an unchanged tree and get the
// same bytes" true at all. The machine keys follow in their fixed order.
export const serialize = (parsed, machine) => {
  const authored = Object.fromEntries(Object.entries(parsed).filter(([key]) => !MACHINE_KEYS.includes(key)));
  return `${JSON.stringify({ ...authored, ...machine }, null, 2)}\n`;
};
