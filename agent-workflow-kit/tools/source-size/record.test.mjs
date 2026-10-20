// The recorded ratchet as data: the delta rules, the layout record a regeneration would write, the
// regeneration plan, its materialization with each reason, and the canonical serialization.
// Contract: docs/ai/specs/kit/source-size/index.md and its part record.md.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const loadRecord = () => import('./record.mjs');
const loadLimits = () => import('./limits.mjs');
const loadJudge = () => import('../source-size-judge.mjs');

const STORE = 'docs/ai/specs';
const DEEP = 'src/a/b/c/d/e/g';

const resolvedLimits = async (overrides = {}) => (await loadLimits()).resolveLimits(overrides).limits;

// A judge verdict as planRecord reads it, built by hand: no tree is measured.
const verdictOf = ({ files = [], projected = {}, rootLines = {}, layout = null }) => ({
  scope: { files },
  projected: new Map(Object.entries(projected)),
  measured: new Map(files.map((rel) => [rel, {}])),
  rootLines: new Map(Object.entries(rootLines)),
  layout,
});

const measuredOf = (roots, directories) => ({ roots: new Map(roots), directories: new Map(directories) });

// The layout a regeneration starts from, with a root kept within its band, a lowered depth, a grown
// directory, an obsolete one and a gone root.
const RECORDED_LAYOUT = {
  roots: {
    src: { files: 40, reason: 'src debt' },
    lib: { files: 40, reason: 'lib debt' },
    gone: { files: 9, reason: 'gone debt' },
  },
  directories: {
    [DEEP]: { depth: 8, reason: 'deep debt' },
    'src/wider': { entries: 23, reason: 'wide debt' },
    'src/old': { entries: 30, reason: 'old debt' },
  },
};
const MEASURED_LAYOUT = [
  [['src', 46], ['lib', 44], [STORE, 3]],
  [
    ['src', { entries: 5, depth: 0, reach: 7 }],
    [DEEP, { entries: 1, depth: 6, reach: 7 }],
    ['src/wider', { entries: 25, depth: 1, reach: 1 }],
    ['src/old', { entries: 22, depth: 1, reach: 1 }],
    ['src/new/a/b/c/d/e', { entries: 1, depth: 6, reach: 6 }],
  ],
];
const layoutConfig = () => ({
  roots: ['src', 'lib'],
  baseline: {},
  aggregate: { src: { lines: 10, reason: 'agg src' }, lib: { lines: 4, reason: 'agg lib' } },
  layout: structuredClone(RECORDED_LAYOUT),
});
const planLayout = async (config) => {
  const { planRecord, projectLayout } = await loadRecord();
  const limits = await resolvedLimits();
  const projected = projectLayout(measuredOf(...MEASURED_LAYOUT), config.layout, limits);
  return planRecord({ config, verdict: verdictOf({ rootLines: { src: 10, lib: 4 }, layout: { projected } }) });
};

describe('spec:source-size/S31 the regeneration\'s layout record mirrors the judged roots, records a directory only beyond its band, and serializes after the aggregate', () => {
  it('writes every judged root as measured, a count above its record within its band keeping the record, a gone root dropped', async () => {
    const { projectLayout } = await loadRecord();
    const limits = await resolvedLimits();
    const recorded = {
      roots: {
        src: { files: 40, reason: 'r' }, grown: { files: 40, reason: 'r' }, lib: { files: 40, reason: 'r' },
        [STORE]: { files: 2, reason: 'r' }, gone: { files: 9, reason: 'r' },
      },
      directories: {},
    };
    const roots = [['src', 44], ['grown', 45], ['lib', 30], [STORE, 3], ['fresh', 7]];
    assert.deepEqual(projectLayout(measuredOf(roots, []), recorded, limits).roots, {
      src: 40, grown: 45, lib: 30, [STORE]: 2, fresh: 7,
    }, 'within the band (40 + 4, 2 + 1) the record is kept; beyond it, under it or unrecorded the count is written');
    assert.deepEqual(projectLayout(measuredOf(roots, []), null, limits).roots, {
      src: 44, grown: 45, lib: 30, [STORE]: 3, fresh: 7,
    }, 'with no record every root is written as measured');
    const strict = await resolvedLimits({ 'files-per-root': { tolerance: 0, reason: 'no band' } });
    assert.equal(projectLayout(measuredOf(roots, []), recorded, strict).roots.src, 44, 'the band is the resolved tolerance');
  });

  it('records a directory only beyond its band: entries its count, depth on the sixth level holding its reach', async () => {
    const { projectLayout } = await loadRecord();
    const limits = await resolvedLimits();
    const directories = [
      ['src', { entries: 20, depth: 0, reach: 8 }],
      ['src/one', { entries: 21, depth: 1, reach: 1 }],
      ['src/wide', { entries: 22, depth: 1, reach: 1 }],
      ['src/wider', { entries: 23, depth: 1, reach: 1 }],
      ['src/a/b/c/d/e', { entries: 1, depth: 5, reach: 8 }],
      [DEEP, { entries: 1, depth: 6, reach: 8 }],
      [`${DEEP}/h`, { entries: 1, depth: 7, reach: 8 }],
      ['src/p/q/r/s/t/u', { entries: 24, depth: 6, reach: 6 }],
    ];
    const projected = projectLayout(measuredOf([['src', 60]], directories), null, limits);
    assert.deepEqual(projected.directories, {
      'src/wider': { entries: 23 },
      [DEEP]: { depth: 8 },
      'src/p/q/r/s/t/u': { entries: 24, depth: 6 },
    });
    assert.deepEqual(Object.keys(projected.directories['src/p/q/r/s/t/u']), ['entries', 'depth']);
    const tight = await resolvedLimits({
      'entries-per-directory': { value: 20, tolerance: 0, reason: 'no band' },
      depth: { value: 6, tolerance: 0, reason: 'one deeper' },
    });
    assert.deepEqual(projectLayout(measuredOf([['src', 60]], directories), null, tight).directories, {
      'src/one': { entries: 21 },
      'src/wide': { entries: 22 },
      'src/wider': { entries: 23 },
      [`${DEEP}/h`]: { depth: 8 },
      'src/p/q/r/s/t/u': { entries: 24 },
    }, 'the bands are the resolved limits');
  });

  it('records a directory named like an Object.prototype member as its own key, so the regeneration raises it', async () => {
    const { planRecord, projectLayout } = await loadRecord();
    const projected = projectLayout(measuredOf([['.', 23]], [['__proto__', { entries: 23, depth: 1, reach: 1 }]]), null, await resolvedLimits());
    assert.deepEqual(Object.keys(projected.directories), ['__proto__']);
    assert.equal(Object.getPrototypeOf(projected.directories), Object.prototype);
    const plan = planRecord({ config: { roots: ['.'], baseline: {}, aggregate: {} }, verdict: verdictOf({ rootLines: { '.': 0 }, layout: { projected } }) });
    assert.ok(plan.raises.some((d) => d.target === '__proto__' && d.dimension === 'entries' && d.to === 23), JSON.stringify(plan.raises));
  });

  it('plans the layout deltas with files, entries and depth, a raise counted as one', async () => {
    const plan = await planLayout(layoutConfig());
    assert.deepEqual(plan.deltas, [
      { target: 'src', dimension: 'files', from: 40, to: 46 },
      { target: STORE, dimension: 'files', from: null, to: 3 },
      { target: 'gone', dimension: 'files', from: 9, to: null },
      { target: DEEP, dimension: 'depth', from: 8, to: 7 },
      { target: 'src/wider', dimension: 'entries', from: 23, to: 25 },
      { target: 'src/new/a/b/c/d/e', dimension: 'depth', from: null, to: 6 },
      { target: 'src/old', dimension: 'entries', from: 30, to: null },
    ]);
    assert.deepEqual(plan.raises.map(({ target }) => target), ['src', STORE, 'src/wider', 'src/new/a/b/c/d/e']);
  });

  it('materializes a raise with the reason and a lowered or kept entry with its own, every map sorted by key', async () => {
    const { materialize } = await loadRecord();
    const machine = materialize(await planLayout(layoutConfig()), 'layout grew');
    assert.deepEqual(Object.keys(machine), ['baseline', 'aggregate', 'layout']);
    assert.deepEqual(machine.layout, {
      roots: {
        [STORE]: { files: 3, reason: 'layout grew' },
        lib: { files: 40, reason: 'lib debt' },
        src: { files: 46, reason: 'layout grew' },
      },
      directories: {
        [DEEP]: { depth: 7, reason: 'deep debt' },
        'src/new/a/b/c/d/e': { depth: 6, reason: 'layout grew' },
        'src/wider': { entries: 25, reason: 'layout grew' },
      },
    });
    assert.deepEqual(Object.keys(machine.layout), ['roots', 'directories']);
    assert.deepEqual(Object.keys(machine.layout.roots), [STORE, 'lib', 'src']);
    assert.deepEqual(Object.keys(machine.layout.directories), [DEEP, 'src/new/a/b/c/d/e', 'src/wider']);
    assert.deepEqual(machine.aggregate, { src: { lines: 10, reason: 'agg src' }, lib: { lines: 4, reason: 'agg lib' } });
  });

  it('serializes layout after the aggregate and regenerates an unchanged tree to the same bytes', async () => {
    const { materialize, serialize } = await loadRecord();
    const config = layoutConfig();
    const parsed = { _README: 'fixture', schema: 2, layout: config.layout, roots: config.roots, extensions: ['.mjs'], baseline: {}, aggregate: config.aggregate };
    const machine = materialize(await planLayout(config), 'layout grew');
    const body = serialize(parsed, machine);
    const expected = { _README: 'fixture', schema: 2, roots: ['src', 'lib'], extensions: ['.mjs'], ...machine };
    assert.equal(body, `${JSON.stringify(expected, null, 2)}\n`);
    assert.deepEqual(Object.keys(JSON.parse(body)), ['_README', 'schema', 'roots', 'extensions', 'baseline', 'aggregate', 'layout']);
    assert.ok(body.indexOf('"aggregate"') < body.indexOf('"layout"'), 'layout follows the aggregate in the bytes');
    const reread = JSON.parse(body);
    const again = await planLayout({ roots: reread.roots, baseline: reread.baseline, aggregate: reread.aggregate, layout: reread.layout });
    assert.deepEqual(again.deltas, [], 'the regenerated record holds the tree');
    assert.equal(serialize(reread, materialize(again, 'another reason')), body, 'the same bytes, no reason rewritten');
  });
});

describe('the moved delta rules, plan, materialization and serialization keep their output on the baseline and aggregate', () => {
  it('reads an entry by own key only, counts a raise, and pairs the changes of one target', async () => {
    const { changesFor, isRaise, ownEntry } = await loadRecord();
    assert.equal(ownEntry({}, 'constructor'), undefined, 'an inherited key is no entry');
    assert.equal(ownEntry({}, 'toString'), undefined);
    const entry = { lines: 500, reason: 'r' };
    assert.equal(ownEntry({ constructor: entry }, 'constructor'), entry);
    assert.equal(isRaise({ from: null, to: 1 }), true);
    assert.equal(isRaise({ from: 1, to: 2 }), true);
    assert.equal(isRaise({ from: 2, to: 1 }), false);
    assert.equal(isRaise({ from: 1, to: 1 }), false);
    assert.equal(isRaise({ from: 1, to: null }), false);
    assert.equal(isRaise({ from: null, to: null }), false);
    assert.deepEqual(changesFor('a.mjs', { lines: 480 }, { lines: 500, maxLineBytes: 1200, reason: 'r' }), [
      { target: 'a.mjs', dimension: 'lines', from: 500, to: 480 },
      { target: 'a.mjs', dimension: 'maxLineBytes', from: 1200, to: null },
    ]);
    assert.deepEqual(changesFor('a.mjs', { lines: 441 }, undefined), [{ target: 'a.mjs', dimension: 'lines', from: null, to: 441 }]);
    assert.deepEqual(changesFor('a.mjs', { lines: 441 }, { lines: 441, reason: 'r' }), []);
    assert.deepEqual(changesFor('d', { entries: 23 }, { depth: 7, reason: 'r' }, ['entries', 'depth']), [
      { target: 'd', dimension: 'entries', from: null, to: 23 },
      { target: 'd', dimension: 'depth', from: 7, to: null },
    ]);
  });

  it('plans and materializes a baseline and aggregate regeneration as before, with no layout', async () => {
    const { materialize, planRecord } = await loadRecord();
    const config = {
      roots: ['src', 'lib'],
      baseline: {
        'src/big.mjs': { lines: 500, reason: 'big debt' },
        'src/gone.mjs': { lines: 450, reason: 'gone debt' },
        'src/wide.mjs': { maxLineBytes: 1200, reason: 'wide debt' },
      },
      aggregate: { src: { lines: 900, reason: 'src budget' }, old: { lines: 10, reason: 'old budget' } },
    };
    const verdict = verdictOf({
      files: ['src/big.mjs', 'src/new.mjs', 'src/wide.mjs'],
      projected: { 'src/big.mjs': { lines: 480 }, 'src/new.mjs': { lines: 441 }, 'src/wide.mjs': {} },
      rootLines: { src: 1400 },
    });
    const plan = planRecord({ config, verdict });
    assert.deepEqual(plan.deltas, [
      { target: 'src/big.mjs', dimension: 'lines', from: 500, to: 480 },
      { target: 'src/new.mjs', dimension: 'lines', from: null, to: 441 },
      { target: 'src/wide.mjs', dimension: 'maxLineBytes', from: 1200, to: null },
      { target: 'src/gone.mjs', dimension: 'lines', from: 450, to: null },
      { target: 'src', dimension: 'aggregate lines', from: 900, to: 1400 },
      { target: 'lib', dimension: 'aggregate lines', from: null, to: 0 },
      { target: 'old', dimension: 'aggregate lines', from: 10, to: null },
    ]);
    assert.deepEqual(plan.raises, [plan.deltas[1], plan.deltas[4], plan.deltas[5]]);
    assert.equal(plan.layout, null, 'no layout judged, no layout planned');
    const machine = materialize(plan, 'grew on purpose');
    assert.deepEqual(machine, {
      baseline: {
        'src/big.mjs': { lines: 480, reason: 'big debt' },
        'src/new.mjs': { lines: 441, reason: 'grew on purpose' },
      },
      aggregate: {
        src: { lines: 1400, reason: 'grew on purpose' },
        lib: { lines: 0, reason: 'grew on purpose' },
      },
    });
    assert.equal(Object.hasOwn(machine, 'layout'), false);
  });

  it('raises an entry named like an Object.prototype member instead of reading it as recorded', async () => {
    const { materialize, planRecord } = await loadRecord();
    const plan = planRecord({
      config: { roots: ['constructor'], baseline: {}, aggregate: {} },
      verdict: verdictOf({ files: ['toString'], projected: { toString: { lines: 441 } }, rootLines: { constructor: 441 } }),
    });
    assert.deepEqual(plan.raises, [
      { target: 'toString', dimension: 'lines', from: null, to: 441 },
      { target: 'constructor', dimension: 'aggregate lines', from: null, to: 441 },
    ]);
    assert.deepEqual(materialize(plan, 'why'), {
      baseline: { toString: { lines: 441, reason: 'why' } },
      aggregate: { constructor: { lines: 441, reason: 'why' } },
    });
  });

  it('serializes the authored keys in their order then the machine keys, the same bytes twice', async () => {
    const { serialize } = await loadRecord();
    const parsed = {
      _README: 'fixture', schema: 2, baseline: { 'src/a.mjs': { lines: 999, reason: 'old' } }, roots: ['src'],
      limits: { depth: { value: 7, tolerance: 0, reason: 'deep' } }, extensions: ['.mjs'], aggregate: { src: { lines: 1, reason: 'old' } },
    };
    const machine = { baseline: { 'src/a.mjs': { lines: 441, reason: 'r' } }, aggregate: { src: { lines: 441, reason: 'r' } } };
    const body = serialize(parsed, machine);
    const lines = [
      '{', '  "_README": "fixture",', '  "schema": 2,', '  "roots": [', '    "src"', '  ],', '  "limits": {', '    "depth": {',
      '      "value": 7,', '      "tolerance": 0,', '      "reason": "deep"', '    }', '  },', '  "extensions": [', '    ".mjs"', '  ],',
      '  "baseline": {', '    "src/a.mjs": {', '      "lines": 441,', '      "reason": "r"', '    }', '  },', '  "aggregate": {',
      '    "src": {', '      "lines": 441,', '      "reason": "r"', '    }', '  }', '}', '',
    ];
    assert.equal(body, lines.join('\n'));
    assert.equal(serialize(JSON.parse(body), machine), body);
  });
});

describe('recordFor records a dimension of a file only beyond its band', () => {
  it('records 441 lines but not 440, and 1001 bytes per line but not 1000, under the resolved limits', async () => {
    const { recordFor } = await loadJudge();
    const limits = await resolvedLimits();
    assert.deepEqual(recordFor({ lines: 441, maxLineBytes: 1001 }, limits), { lines: 441, maxLineBytes: 1001 });
    assert.deepEqual(recordFor({ lines: 440, maxLineBytes: 1000 }, limits), {}, 'within the band no record is kept');
    assert.deepEqual(recordFor({ lines: 401, maxLineBytes: 10 }, limits), {});
    assert.deepEqual(recordFor({ lines: 12, maxLineBytes: 1001 }, limits), { maxLineBytes: 1001 });
    const tight = await resolvedLimits({ 'lines-per-file': { value: 300, tolerance: 10, reason: 'tight files' } });
    assert.deepEqual(recordFor({ lines: 330, maxLineBytes: 10 }, tight), {});
    assert.deepEqual(recordFor({ lines: 331, maxLineBytes: 10 }, tight), { lines: 331 });
  });
});
