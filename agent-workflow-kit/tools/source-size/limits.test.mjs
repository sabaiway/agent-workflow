// The kit's five size limits and a project's overrides: the frozen table, the resolution, the schema-1 move, the
// override transform, and the one door every kit module outside tools/source-size/ reaches them through.
// Contract: docs/ai/specs/kit/source-size/index.md and its part limits.md.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const loadLimits = () => import('./limits.mjs');
const loadLayout = () => import('./layout.mjs');
const loadRecord = () => import('./record.mjs');
const loadDoor = () => import('./index.mjs');
const loadCore = () => import('../source-size-core.mjs');
const loadReport = () => import('../source-size-report.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(HERE, '..', '..');
const FILE_NAMES = {
  'limits.mjs': ['KIT_LIMITS', 'SCHEMA1_REASON', 'applyOverride', 'limitLines', 'limitsDefect', 'migrateSchema1', 'resolveLimits'],
  'layout.mjs': ['SPEC_STORE_ROOT', 'bandOf', 'layoutCounts', 'layoutDefect', 'walkSpecStore'],
  'record.mjs': ['changesFor', 'isRaise', 'materialize', 'ownEntry', 'planRecord', 'projectLayout', 'serialize'],
};
const DOOR_NAMES = Object.values(FILE_NAMES).flat();
const IDS = ['lines-per-file', 'bytes-per-line', 'entries-per-directory', 'depth', 'files-per-root'];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"`])([^'"`\n]+)\1/g;
const HEAD_SCHEMA1_README = 'Source-size practice: declared scope + thresholds + the recorded ratchet. Authored keys: schema, defaults, roots, exclude, extensions. Machine keys: baseline, aggregate — each recorded entry carries a reason, and a recorded size is debt, not permission. Strict JSON — unknown keys refused.';

const BASELINE = { 'src/big.mjs': { lines: 401, reason: 'initial adoption' } };
const AGGREGATE = { src: { lines: 411, reason: 'initial adoption' } };
const schema1 = (defaults, readme = 'fixture') => ({
  _README: readme, schema: 1, defaults, roots: ['src'], exclude: ['src/gen'], extensions: ['.mjs'], baseline: BASELINE, aggregate: AGGREGATE,
});
const authored = () => ({ _README: 'fixture', schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'] });
const KIT_DEFAULTS = { maxLines: 400, maxLineBytes: 1000 };

// The specifiers of a module's text that resolve to a file of tools/source-size/ other than its door.
const pastTheDoor = (file, text) => [...text.matchAll(SPECIFIER)].map((m) => m[2])
  .filter((spec) => spec.startsWith('.'))
  .filter((spec) => {
    const target = resolve(dirname(file), spec);
    return target.startsWith(`${HERE}${sep}`) && target !== join(HERE, 'index.mjs');
  });

// Every non-test .mjs module of the kit outside tools/source-size/, node_modules skipped.
const listKitModules = () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && path !== HERE) walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) files.push(path);
    }
  };
  walk(KIT_ROOT);
  return files;
};

describe('spec:source-size/S9 the kit table holds exactly the five limits, frozen, and SOURCE_SIZE_DEFAULTS is derived from it', () => {
  it('holds lines-per-file 400 at 10, bytes-per-line 1000 at 0, entries-per-directory 20 at 10, depth 5 at 0 and files-per-root no value at 10, frozen', async () => {
    const { KIT_LIMITS } = await loadLimits();
    assert.deepEqual(Object.keys(KIT_LIMITS), IDS);
    assert.deepEqual(KIT_LIMITS, {
      'lines-per-file': { value: 400, tolerance: 10 },
      'bytes-per-line': { value: 1000, tolerance: 0 },
      'entries-per-directory': { value: 20, tolerance: 10 },
      depth: { value: 5, tolerance: 0 },
      'files-per-root': { value: null, tolerance: 10 },
    });
    assert.equal(Object.isFrozen(KIT_LIMITS), true, 'the table is frozen');
    for (const id of IDS) assert.equal(Object.isFrozen(KIT_LIMITS[id]), true, `${id} is frozen`);
    assert.throws(() => { KIT_LIMITS.depth.value = 9; }, TypeError);
    assert.throws(() => { KIT_LIMITS.extra = { value: 1, tolerance: 0 }; }, TypeError);
    assert.equal(KIT_LIMITS.depth.value, 5);
  });

  it('derives SOURCE_SIZE_DEFAULTS from the table: maxLines 400 and maxLineBytes 1000, in that shape', async () => {
    const { KIT_LIMITS } = await loadLimits();
    const { SOURCE_SIZE_DEFAULTS } = await loadCore();
    assert.deepEqual(Object.keys(SOURCE_SIZE_DEFAULTS), ['maxLines', 'maxLineBytes']);
    assert.deepEqual({ ...SOURCE_SIZE_DEFAULTS }, KIT_DEFAULTS);
    assert.equal(SOURCE_SIZE_DEFAULTS.maxLines, KIT_LIMITS['lines-per-file'].value);
    assert.equal(SOURCE_SIZE_DEFAULTS.maxLineBytes, KIT_LIMITS['bytes-per-line'].value);
  });
});

describe('spec:source-size/S11 the resolution gives every limit its value, tolerance and source, and derives defaults', () => {
  it('resolves every limit from the kit when nothing overrides it, files-per-root with no value', async () => {
    const { resolveLimits } = await loadLimits();
    const expected = {
      limits: {
        'lines-per-file': { value: 400, tolerance: 10, source: 'kit' },
        'bytes-per-line': { value: 1000, tolerance: 0, source: 'kit' },
        'entries-per-directory': { value: 20, tolerance: 10, source: 'kit' },
        depth: { value: 5, tolerance: 0, source: 'kit' },
        'files-per-root': { value: null, tolerance: 10, source: 'kit' },
      },
      defaults: KIT_DEFAULTS,
    };
    assert.deepEqual(resolveLimits({}), expected);
    assert.deepEqual(resolveLimits(), expected, 'a config with no "limits" key resolves the same');
    assert.deepEqual(Object.keys(resolveLimits({}).limits), IDS);
  });

  it('resolves an override with its value, tolerance and reason, and derives defaults from the resolved values', async () => {
    const { resolveLimits } = await loadLimits();
    const resolved = resolveLimits({
      depth: { value: 9, tolerance: 0, reason: 'deep trees' },
      'files-per-root': { tolerance: 20, reason: 'wider band' },
      'bytes-per-line': { value: 120, tolerance: 0, reason: 'narrow lines' },
      'lines-per-file': { value: 350, tolerance: 5, reason: 'tight files' },
    });
    assert.deepEqual(resolved, {
      limits: {
        'lines-per-file': { value: 350, tolerance: 5, source: 'override', reason: 'tight files' },
        'bytes-per-line': { value: 120, tolerance: 0, source: 'override', reason: 'narrow lines' },
        'entries-per-directory': { value: 20, tolerance: 10, source: 'kit' },
        depth: { value: 9, tolerance: 0, source: 'override', reason: 'deep trees' },
        'files-per-root': { value: null, tolerance: 20, source: 'override', reason: 'wider band' },
      },
      defaults: { maxLines: 350, maxLineBytes: 120 },
    });
    assert.deepEqual(Object.keys(resolved.limits), IDS, 'every limit in table order, whatever the override order');
    const equal = resolveLimits({ 'lines-per-file': { value: 400, tolerance: 10, reason: 'pinned' } });
    assert.deepEqual(equal.limits['lines-per-file'], { value: 400, tolerance: 10, source: 'override', reason: 'pinned' });
    assert.deepEqual(equal.defaults, KIT_DEFAULTS);
  });
});

describe('spec:source-size/S12 the schema-1 transform moves a config to schema 2, every key in its place', () => {
  it('sets schema 2, drops defaults and carries every other key verbatim in its order', async () => {
    const { migrateSchema1 } = await loadLimits();
    const given = schema1({ ...KIT_DEFAULTS });
    const before = structuredClone(given);
    const moved = migrateSchema1(given, {});
    assert.deepEqual(Object.keys(moved), ['_README', 'schema', 'roots', 'exclude', 'extensions', 'baseline', 'aggregate']);
    assert.deepEqual(moved, {
      _README: 'fixture', schema: 2, roots: ['src'], exclude: ['src/gen'], extensions: ['.mjs'], baseline: BASELINE, aggregate: AGGREGATE,
    });
    assert.deepEqual(given, before, 'the given config is left as it was');
    const odd = { aggregate: AGGREGATE, extensions: ['.mjs'], schema: 1, roots: ['src'], defaults: { ...KIT_DEFAULTS }, baseline: BASELINE };
    const oddMoved = migrateSchema1(odd, {});
    assert.deepEqual(Object.keys(oddMoved), ['aggregate', 'extensions', 'schema', 'roots', 'baseline']);
    assert.equal(oddMoved.schema, 2);
    assert.equal(Object.hasOwn(oddMoved, '_README'), false, 'an absent _README stays absent');
  });

  it('replaces a _README byte-equal to the schema-1 template text it is handed, and carries any other verbatim', async () => {
    const { migrateSchema1 } = await loadLimits();
    const { SCHEMA1_TEMPLATE_README, TEMPLATE_README, TEMPLATE_READMES } = await loadReport();
    assert.equal(SCHEMA1_TEMPLATE_README, HEAD_SCHEMA1_README, 'the schema-1 text is the one the kit shipped');
    assert.deepEqual(Object.keys(TEMPLATE_READMES), ['schema1', 'schema2']);
    assert.equal(TEMPLATE_READMES.schema1, SCHEMA1_TEMPLATE_README);
    assert.equal(TEMPLATE_READMES.schema2, TEMPLATE_README);
    assert.notEqual(TEMPLATE_README, SCHEMA1_TEMPLATE_README);
    const readmeOf = (readme, readmes) => migrateSchema1(schema1({ ...KIT_DEFAULTS }, readme), readmes)._README;
    assert.equal(readmeOf(SCHEMA1_TEMPLATE_README, TEMPLATE_READMES), TEMPLATE_README);
    assert.equal(readmeOf(`${SCHEMA1_TEMPLATE_README} `, TEMPLATE_READMES), `${SCHEMA1_TEMPLATE_README} `);
    assert.equal(readmeOf(SCHEMA1_TEMPLATE_README.replace('JSON', 'json'), TEMPLATE_READMES), SCHEMA1_TEMPLATE_README.replace('JSON', 'json'));
    assert.equal(readmeOf('our own words', TEMPLATE_READMES), 'our own words');
    assert.equal(readmeOf('old text', { schema1: 'old text', schema2: 'new text' }), 'new text', 'the texts are the ones handed in');
    assert.equal(readmeOf(SCHEMA1_TEMPLATE_README, { schema1: 'old text', schema2: 'new text' }), SCHEMA1_TEMPLATE_README);
    const moved = migrateSchema1(schema1({ ...KIT_DEFAULTS }, SCHEMA1_TEMPLATE_README), TEMPLATE_READMES);
    assert.equal(Object.keys(moved)[0], '_README', 'the replaced text keeps its place');
  });

  it('holds an override with the kit tolerance and the schema-1 reason only for a defaults value differing from the kit', async () => {
    const { SCHEMA1_REASON, migrateSchema1 } = await loadLimits();
    assert.equal(SCHEMA1_REASON, 'carried from schema 1');
    assert.equal(Object.hasOwn(migrateSchema1(schema1({ ...KIT_DEFAULTS }), {}), 'limits'), false, 'equal values make no limits key');
    const lines = migrateSchema1(schema1({ maxLines: 300, maxLineBytes: 1000 }), {});
    assert.deepEqual(Object.keys(lines), ['_README', 'schema', 'limits', 'roots', 'exclude', 'extensions', 'baseline', 'aggregate']);
    assert.deepEqual(lines.limits, { 'lines-per-file': { value: 300, tolerance: 10, reason: SCHEMA1_REASON } });
    assert.deepEqual(Object.keys(lines.limits['lines-per-file']), ['value', 'tolerance', 'reason']);
    const bytes = migrateSchema1(schema1({ maxLines: 400, maxLineBytes: 120 }), {});
    assert.deepEqual(bytes.limits, { 'bytes-per-line': { value: 120, tolerance: 0, reason: SCHEMA1_REASON } });
    const both = migrateSchema1(schema1({ maxLines: 500, maxLineBytes: 2000 }), {});
    assert.deepEqual(Object.keys(both.limits), ['lines-per-file', 'bytes-per-line']);
    assert.deepEqual(both.limits, {
      'lines-per-file': { value: 500, tolerance: 10, reason: SCHEMA1_REASON },
      'bytes-per-line': { value: 2000, tolerance: 0, reason: SCHEMA1_REASON },
    });
    assert.equal(Object.hasOwn(both, 'defaults'), false);
    const odd = migrateSchema1({ roots: ['src'], defaults: { maxLines: 300, maxLineBytes: 1000 }, schema: 1, extensions: ['.mjs'] }, {});
    assert.deepEqual(Object.keys(odd), ['roots', 'limits', 'schema', 'extensions'], 'limits takes the place defaults held');
  });
});

describe('spec:source-size/S13 the override transform sets, replaces or removes one id, every other key kept in its order', () => {
  it('sets an override in a new limits key that follows the authored keys, built as value, tolerance, reason', async () => {
    const { applyOverride } = await loadLimits();
    const given = authored();
    const before = structuredClone(given);
    const set = applyOverride(given, 'depth', { reason: 'deep trees', tolerance: 0, value: 7 });
    assert.deepEqual(Object.keys(set), ['_README', 'schema', 'roots', 'exclude', 'extensions', 'limits']);
    assert.deepEqual(set, { ...before, limits: { depth: { value: 7, tolerance: 0, reason: 'deep trees' } } });
    assert.deepEqual(Object.keys(set.limits.depth), ['value', 'tolerance', 'reason']);
    assert.deepEqual(given, before, 'the given config is left as it was');
    const fpr = applyOverride(authored(), 'files-per-root', { value: 3, reason: 'wider band', tolerance: 20 });
    assert.deepEqual(fpr.limits, { 'files-per-root': { tolerance: 20, reason: 'wider band' } });
    assert.deepEqual(Object.keys(fpr.limits['files-per-root']), ['tolerance', 'reason'], 'files-per-root takes no value');
    const minted = { ...authored(), baseline: BASELINE, aggregate: AGGREGATE };
    const onMinted = applyOverride(minted, 'lines-per-file', { value: 300, tolerance: 10, reason: 'tight files' });
    const keys = Object.keys(onMinted);
    assert.deepEqual(keys.filter((key) => key !== 'limits'), Object.keys(minted));
    for (const key of Object.keys(authored())) assert.ok(keys.indexOf(key) < keys.indexOf('limits'), `limits follows ${key}`);
    for (const key of Object.keys(minted)) assert.deepEqual(onMinted[key], minted[key]);
  });

  it('replaces an existing override in place, every other key and id keeping its value and its order', async () => {
    const { applyOverride } = await loadLimits();
    const limits = {
      'lines-per-file': { value: 300, tolerance: 10, reason: 'tight files' },
      depth: { value: 7, tolerance: 0, reason: 'deep trees' },
      'files-per-root': { tolerance: 20, reason: 'wider band' },
    };
    const given = { _README: 'fixture', schema: 2, limits, roots: ['src'], extensions: ['.mjs'], baseline: BASELINE };
    const before = structuredClone(given);
    const replaced = applyOverride(given, 'depth', { value: 9, tolerance: 5, reason: 'deeper still' });
    assert.deepEqual(Object.keys(replaced), ['_README', 'schema', 'limits', 'roots', 'extensions', 'baseline']);
    assert.deepEqual(Object.keys(replaced.limits), ['lines-per-file', 'depth', 'files-per-root']);
    assert.deepEqual(replaced, { ...before, limits: { ...before.limits, depth: { value: 9, tolerance: 5, reason: 'deeper still' } } });
    assert.deepEqual(given, before, 'the given config is left as it was');
  });

  it('removes an override in its kit-default form, dropping a limits key left empty', async () => {
    const { applyOverride } = await loadLimits();
    const two = {
      _README: 'fixture', schema: 2, roots: ['src'],
      limits: { 'lines-per-file': { value: 300, tolerance: 10, reason: 'tight files' }, depth: { value: 7, tolerance: 0, reason: 'deep trees' } },
      extensions: ['.mjs'], aggregate: AGGREGATE,
    };
    const before = structuredClone(two);
    const one = applyOverride(two, 'lines-per-file', null);
    assert.deepEqual(Object.keys(one), ['_README', 'schema', 'roots', 'limits', 'extensions', 'aggregate']);
    assert.deepEqual(one, { ...before, limits: { depth: { value: 7, tolerance: 0, reason: 'deep trees' } } });
    assert.deepEqual(two, before, 'the given config is left as it was');
    const none = applyOverride(one, 'depth', null);
    assert.deepEqual(Object.keys(none), ['_README', 'schema', 'roots', 'extensions', 'aggregate'], 'an emptied limits key is dropped');
    assert.deepEqual(none, { _README: 'fixture', schema: 2, roots: ['src'], extensions: ['.mjs'], aggregate: AGGREGATE });
    const untouched = applyOverride(authored(), 'depth', null);
    assert.deepEqual(Object.keys(untouched), Object.keys(authored()));
    assert.deepEqual(untouched, authored());
  });
});

describe('the limit lines state every resolved limit', () => {
  it('states all five in table order with value, tolerance and source, an override with its escaped reason, files-per-root recorded or none recorded', async () => {
    const { limitLines, resolveLimits } = await loadLimits();
    const escape = (text) => `<${text}>`;
    const { limits } = resolveLimits({
      'files-per-root': { tolerance: 20, reason: 'wider band' },
      'lines-per-file': { value: 350, tolerance: 5, reason: 'tight files' },
    });
    const head = [
      'limit lines-per-file 350, tolerance 5% — from override: <tight files>',
      'limit bytes-per-line 1000, tolerance 0% — from kit',
      'limit entries-per-directory 20, tolerance 10% — from kit',
      'limit depth 5, tolerance 0% — from kit',
    ];
    assert.deepEqual(limitLines(limits, { escape, recorded: false }), [...head, 'limit files-per-root none recorded, tolerance 20% — from override: <wider band>']);
    assert.deepEqual(limitLines(limits, { escape, recorded: true }), [...head, "limit files-per-root each judged root's recorded count, tolerance 20% — from override: <wider band>"]);
    assert.deepEqual(limitLines(resolveLimits({}).limits, { escape, recorded: false }), [
      'limit lines-per-file 400, tolerance 10% — from kit',
      'limit bytes-per-line 1000, tolerance 0% — from kit',
      'limit entries-per-directory 20, tolerance 10% — from kit',
      'limit depth 5, tolerance 0% — from kit',
      'limit files-per-root none recorded, tolerance 10% — from kit',
    ]);
  });
});

describe('spec:source-size/S14 the door exports exactly the nineteen names of limits.mjs, layout.mjs and record.mjs, and no kit module imports past it', () => {
  it('re-exports the very exports of its three files through the door and the core, and no kit module reaches a file of it but the door', async () => {
    const door = await loadDoor();
    const modules = { 'limits.mjs': await loadLimits(), 'layout.mjs': await loadLayout(), 'record.mjs': await loadRecord() };
    const core = await loadCore();
    assert.equal(DOOR_NAMES.length, 19);
    assert.deepEqual(Object.keys(door).sort(), [...DOOR_NAMES].sort());
    for (const [file, names] of Object.entries(FILE_NAMES)) {
      assert.deepEqual(Object.keys(modules[file]).sort(), [...names].sort(), `the door exports exactly the exports of ${file}`);
      for (const name of names) {
        assert.equal(door[name], modules[file][name], `the door's ${name} is the very export of ${file}`);
        assert.equal(core[name], modules[file][name], `the core's ${name} is the very export of ${file}`);
      }
    }

    const sample = join(KIT_ROOT, 'tools', 'project-rules', 'sample.mjs');
    const text = "import { KIT_LIMITS } from '../source-size/limits.mjs';\nexport * from \"../source-size/index.mjs\";\nconst m = import('../source-size-core.mjs');";
    assert.deepEqual(pastTheDoor(sample, text), ['../source-size/limits.mjs']);
    assert.deepEqual(pastTheDoor(join(KIT_ROOT, 'tools', 'x.mjs'), "export { a } from './source-size/limits.mjs';"), ['./source-size/limits.mjs']);
    const files = listKitModules();
    assert.ok(files.includes(join(KIT_ROOT, 'tools', 'source-size-core.mjs')), 'the walk reaches the core');
    const reached = files.flatMap((file) => pastTheDoor(file, readFileSync(file, 'utf8'))
      .map((spec) => `${relative(KIT_ROOT, file).split(sep).join('/')}: ${spec}`));
    assert.deepEqual(reached, []);
  });
});
