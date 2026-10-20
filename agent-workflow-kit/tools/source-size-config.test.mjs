// source-size-config.test.mjs — the config validator's REFUSALS, one test per rule. A malformed or
// unknown-keyed config is a loud STOP rather than a guess, because every one of these rules can
// otherwise be disarmed silently: a typo'd key, an empty scope array, an overlapping root or a
// placeholder left in place would each turn the practice into an empty green.
//
// The fail-closed arms of the addressing helpers ride here too: an unresolvable path is never
// canonical, and an empty declared root is a loud NOTE rather than either a refusal or a silence.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, sameFile } from './source-size-check.mjs';
import { validateSourceSizeConfig, loadSourceSizeConfig, matchesSourceSizeGate, SOURCE_SIZE_DEFAULTS } from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-config-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));
const loadLimits = () => import('./source-size/index.mjs');
const loadConfig = () => import('./source-size-config.mjs');

const CONFIG = (over = {}) => ({
  _README: 'fixture',
  schema: 2,
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  baseline: {},
  aggregate: { src: { lines: 0, reason: 'initial adoption' } },
  ...over,
});

// Every refusal of the validator is a config stop: exit 2, by name.
const stops = (parsed, pattern) => assert.throws(() => validateSourceSizeConfig(parsed), (err) => err.exitCode === 2 && pattern.test(err.message));
const refuses = (over, pattern) => stops(CONFIG(over), pattern);

let seq = 0;
const project = (files, rawConfig) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), rawConfig);
  const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  return cwd;
};

describe('source-size — the config validator refuses what it cannot judge', () => {
  it('config-unknown-key-refused: a typo would otherwise disarm the rule it meant to set', () => {
    refuses({ rooots: ['src'] }, /carries unknown key\(s\): rooots/);
  });

  it('config-schema-mismatch-refused: an unknown schema is never read on a guess', () => {
    refuses({ schema: 3 }, /"schema" must be 1 or 2, got 3/);
  });

  it('config-empty-roots-refused: an empty scope array is a misdeclaration, never an empty green', () => {
    refuses({ roots: [] }, /"roots" must be a non-empty array/);
  });

  it('config-empty-extensions-refused: the kit ships no default file-type list, so an empty one is refused', () => {
    refuses({ extensions: [] }, /"extensions" must be a non-empty array/);
  });

  it('config-extension-placeholder-refused: the printed template stays INERT until a human replaces it', () => {
    refuses({ extensions: ['<.an-extension-this-practice-covers>'] }, /still carries the authoring placeholder/);
  });

  it('config-extension-malformed-refused: an extension must look like an extension', () => {
    refuses({ extensions: ['mjs'] }, /must look like "\.mjs"/);
    refuses({ extensions: ['.'] }, /must look like "\.mjs"/);
    refuses({ extensions: ['.a/b'] }, /must look like "\.mjs"/);
  });

  it('config-overlapping-roots-refused: an overlapping root would double-count its files', () => {
    refuses({ roots: ['src', 'src/inner'], aggregate: undefined }, /"roots" entries overlap/);
  });

  it('config-duplicate-roots-refused: the overlap rule compares DISTINCT values, so a repeat needs its own refusal', () => {
    refuses({ roots: ['src', 'src'] }, /"roots" declares "src" twice/);
  });

  it('config-aggregate-rejects-line-bytes: the root budget has one dimension and says so', () => {
    refuses(
      { aggregate: { src: { lines: 10, maxLineBytes: 80, reason: 'r' } } },
      /the aggregate budgets LINES only/,
    );
  });

  it('reason-multiline-refused: a reason is copied verbatim into JSON, a commit message and a CHANGELOG', () => {
    refuses(
      { baseline: { 'src/a.mjs': { lines: 401, reason: 'first line\nsecond line' } } },
      /must be ONE line with no control bytes/,
    );
  });

  it('config-value-ranges-validated: a cap that is not a positive integer would silently exempt or refuse everything', () => {
    for (const bad of [0, -1, 1.5, '400', null]) {
      refuses({ schema: 1, defaults: { maxLines: bad, maxLineBytes: 1000 } }, /"defaults"\.maxLines must be a positive integer/);
      refuses({ schema: 1, defaults: { maxLines: 400, maxLineBytes: bad } }, /"defaults"\.maxLineBytes must be a positive integer/);
    }
    refuses({ schema: 1, defaults: { maxLines: 400, maxLineBytes: 1000, maxWhatever: 1 } }, /"defaults" carries unknown key\(s\): maxWhatever/);
    // A RECORDED size may be zero (an empty file), but never negative and never fractional.
    refuses({ baseline: { 'src/a.mjs': { lines: -1, reason: 'r' } } }, /"baseline"\."src\/a\.mjs"\.lines must be a non-negative integer/);
    assert.doesNotThrow(() => validateSourceSizeConfig(CONFIG({ baseline: { 'src/a.mjs': { lines: 0, reason: 'r' } } })));
  });

  it('config-root-containment: a declared path escapes nothing — no absolute root, no traversal, no bare dot', () => {
    for (const bad of ['/etc', '../sibling', 'src/../../out', './src', 'src//nested']) {
      refuses({ roots: [bad], aggregate: undefined }, /a "roots" entry/);
      refuses({ exclude: [bad] }, /an "exclude" entry/);
    }
    refuses({ baseline: { '../outside.mjs': { lines: 401, reason: 'r' } } }, /a "baseline" key/);
  });

  it('config-dangling-symlink-is-unreadable-not-absent: a BROKEN config link is loud, never a silent absence', () => {
    // Reading through a dangling link fails with the SAME code as a missing file, so mapping that
    // code to ABSENT tells the reader to author a file the path already holds — and the authoring
    // template it prints would be written straight through the link, to wherever it points. The
    // sibling loaders answer this with an lstat first (orchestration-config.mjs:262-273).
    const cwd = project({ 'src/a.mjs': 'x\n' }, JSON.stringify(CONFIG(), null, 2));
    rmSync(join(cwd, 'docs', 'ai', 'source-size.json'));
    symlinkSync(join(cwd, 'nowhere.json'), join(cwd, 'docs', 'ai', 'source-size.json'));
    const result = main(['--check', '--cwd', cwd]);
    assert.equal(result.code, 2, `a present-but-unreadable config is an input error:\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /could not be read/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /is absent/, 'a broken link is never reported as an undeclared practice');
  });

  it('config-malformed-stops-exit-2: a config that cannot be parsed is a STOP, never a guess', () => {
    const cwd = project({ 'src/a.mjs': 'x\n' }, '{ this is not json');
    const result = main(['--check', '--cwd', cwd]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is not valid JSON/);
    assert.ok(result.stderr.includes(join(cwd, 'docs/ai/source-size.json')), `the STOP names the file to fix:\n${result.stderr}`);
  });
});

describe('source-size — the layout record is a machine key read by its own grammar', () => {
  const LAYOUT = { roots: { src: { files: 3, reason: 'r' } }, directories: { '.': { depth: 6, reason: 'r' }, 'src/a': { entries: 23, reason: 'r' } } };
  const storeStop = (root) => new RegExp(`"roots" declares "${root}", at or inside the spec store docs/ai/specs — where layout is judged the store is a root of its own, so declare a root outside it`);

  it('layout-grammar-stops: a layout record outside its grammar is a config stop naming its key, and a valid one is carried as written', () => {
    const cases = [[{ roots: {} }, /"layout" is missing directories/], [[], /"layout" must be an object holding roots, directories/],
      [{ ...LAYOUT, x: 1 }, /"layout" carries unknown key\(s\): x/], [{ roots: [], directories: {} }, /"layout"\."roots" must be an object/],
      [{ roots: { src: { reason: 'r' } }, directories: {} }, /"layout"\."roots"\."src" is missing files/],
      [{ roots: { src: { files: 1, entries: 2, reason: 'r' } }, directories: {} }, /"layout"\."roots"\."src" carries unknown key\(s\): entries/],
      [{ roots: {}, directories: { a: { reason: 'r' } } }, /"layout"\."directories"\."a" must record entries or depth/],
      [{ roots: {}, directories: { a: { depth: -1, reason: 'r' } } }, /"layout"\."directories"\."a"\.depth must be a non-negative integer, got -1/],
      [{ roots: {}, directories: { 'a//b': { entries: 1, reason: 'r' } } }, /"layout"\."directories" key "a\/\/b" must be "\.", or a path with no empty, "\." or "\.\." segment/],
      [{ roots: { src: { files: 1, reason: '' } }, directories: {} }, /"layout"\."roots"\."src"\.reason: a reason must be a non-empty string/]];
    for (const [layout, pattern] of cases) refuses({ layout }, pattern);
    assert.deepEqual(validateSourceSizeConfig(CONFIG({ layout: LAYOUT })).layout, LAYOUT);
    const cwd = project({ 'src/a.mjs': 'x\n' }, JSON.stringify(CONFIG({ layout: { roots: {} } }), null, 2));
    const result = main(['--check', '--cwd', cwd]);
    assert.equal(result.code, 2, `a defective layout record is a config stop:\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /"layout" is missing directories/);
  });

  it('layout-on-schema-1-stops: a schema-1 config records no layout, so the key there is a stop naming the move', () => {
    stops({ ...CONFIG({ schema: 1, defaults: { ...SOURCE_SIZE_DEFAULTS } }), layout: LAYOUT }, /"layout" is a schema-2 key — a schema-1 config records no layout; --write-baseline moves it to schema 2/);
  });

  it('store-root-with-layout-stops: where layout is judged the spec store is a root of its own, so a root at or inside it stops', () => {
    for (const root of ['docs/ai/specs', 'docs/ai/specs/kit']) refuses({ roots: [root], aggregate: { [root]: { lines: 0, reason: 'r' } }, layout: LAYOUT }, storeStop(root));
    assert.doesNotThrow(() => validateSourceSizeConfig(CONFIG({ roots: ['docs/ai/specs'], aggregate: { 'docs/ai/specs': { lines: 0, reason: 'r' } } })), 'without layout the store is no root of its own');
  });
});

describe('source-size — the fail-closed arms of the addressing helpers', () => {
  it('matcher-unresolvable-token-fails-closed: a path that resolves to nothing is never canonical', () => {
    assert.equal(matchesSourceSizeGate(`node ${join(TMP, 'no-such-dir/source-size-check.mjs')} --check`, REPO_ROOT), false);
    assert.equal(matchesSourceSizeGate(`node "${join(TMP, 'no-such-dir/source-size-check.mjs')}" --check`, REPO_ROOT), false);
  });

  it('same-file-seam-fails-closed-on-an-unresolvable-path: the direct-run guard never throws', () => {
    assert.equal(sameFile(TOOL, TOOL), true);
    assert.equal(sameFile(TOOL, join(TMP, 'no-such-entry-point.mjs')), false);
  });

  it('empty-root-is-a-loud-note-not-a-refusal: a declared root matching nothing is stated, and the run still passes', () => {
    const cwd = project(
      { 'src/a.mjs': 'x\n' },
      JSON.stringify({
        ...CONFIG({ roots: ['src', 'extra'], aggregate: { src: { lines: 1, reason: 'r' }, extra: { lines: 0, reason: 'r' } } }),
      }, null, 2),
    );
    mkdirSync(join(cwd, 'extra'), { recursive: true });
    const result = main(['--check', '--cwd', cwd]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /NOTE — the declared root "extra" matches no tracked file/);
  });
});

describe('spec:source-size/S10 — an override outside the grammar is a config stop naming its key', () => {
  it('limits-grammar-stops: each malformed override exits 2 by name, and an entry equal to the kit\'s resolves as an override', () => {
    const entry = (over) => ({ depth: { value: 5, tolerance: 0, reason: 'r', ...over } });
    const cases = [[[], /"limits" must be an object mapping a kit limit id/], ['x', /"limits" must be an object/], [{ depth: 3 }, /"limits"\."depth" must be an object/],
      [{ nope: entry().depth }, /"limits" names "nope", which is no kit limit/], [{ depth: { value: 5, tolerance: 0 } }, /"limits"\."depth" is missing reason/],
      [entry({ extra: 1 }), /"limits"\."depth" carries unknown key\(s\): extra/], [{ 'files-per-root': { value: 3, tolerance: 10, reason: 'r' } }, /"limits"\."files-per-root" carries unknown key\(s\): value/],
      ...[0, -1, 1.5, '5', null].map((value) => [entry({ value }), /"limits"\."depth"\.value must be a positive integer/]),
      ...[-1, 101, 1.5, '5', null].map((tolerance) => [entry({ tolerance }), /"limits"\."depth"\.tolerance must be an integer percent from 0 to 100/]),
      ...['', 'a\nb', 'x'.repeat(301)].map((reason) => [entry({ reason }), /"limits"\."depth"\.reason: a reason must be/])];
    for (const [limits, pattern] of cases) refuses({ limits }, pattern);
    const { limits } = validateSourceSizeConfig(CONFIG({ limits: { ...entry(), 'files-per-root': { tolerance: 10, reason: 'same' } } }));
    assert.deepEqual([limits.depth, limits['files-per-root']], [{ value: 5, tolerance: 0, source: 'override', reason: 'r' }, { value: null, tolerance: 10, source: 'override', reason: 'same' }]);
  });
});

describe('spec:source-size/S15 — a config of schema 2 alone is a whole declaration, and a misdeclaration stops by name', () => {
  it('schema2-alone: the root ".", no exclusion, no extension and every limit from the kit; every other shape stops', async () => {
    const config = validateSourceSizeConfig({ schema: 2 });
    const [{ KIT_LIMITS }, { WHOLE_TREE_ROOT }] = await Promise.all([loadLimits(), loadConfig()]);
    const limits = Object.fromEntries(Object.entries(KIT_LIMITS).map(([id, limit]) => [id, { ...limit, source: 'kit' }]));
    assert.deepEqual([WHOLE_TREE_ROOT, config], ['.', { schema: 2, defaults: { ...SOURCE_SIZE_DEFAULTS }, limits, roots: ['.'], exclude: [], extensions: [], baseline: null, aggregate: null, layout: null }]);
    for (const roots of [['.', 'src'], ['src', '.']]) stops({ schema: 2, roots }, /"roots" declares "\." beside another root/);
    for (const key of ['roots', 'extensions']) stops({ schema: 2, [key]: [] }, new RegExp(`"${key}" must be a non-empty array`));
    stops({ schema: 2, defaults: { ...SOURCE_SIZE_DEFAULTS } }, /"defaults" is a schema-1 key/);
    for (const schema of [0, 3, '2', null]) stops(CONFIG({ schema }), /"schema" must be 1 or 2, got/);
  });
});

describe('spec:source-size/S16 — a schema-1 config is read strictly and resolved in memory, and its read writes nothing', () => {
  const SCHEMA1 = (defaults = { ...SOURCE_SIZE_DEFAULTS }) => CONFIG({ schema: 1, defaults });
  it('schema1-resolved: a differing defaults value is an override carried from schema 1, a limits key stops, a read writes nothing', async () => {
    const config = validateSourceSizeConfig(SCHEMA1({ maxLines: 300, maxLineBytes: 1000 }));
    const { SCHEMA1_REASON } = await loadLimits();
    assert.deepEqual([SCHEMA1_REASON, config.schema, config.defaults], ['carried from schema 1', 1, { maxLines: 300, maxLineBytes: 1000 }]);
    assert.deepEqual([config.limits['lines-per-file'], config.limits['bytes-per-line']], [{ value: 300, tolerance: 10, source: 'override', reason: SCHEMA1_REASON }, { value: 1000, tolerance: 0, source: 'kit' }]);
    stops({ ...SCHEMA1(), limits: {} }, /"limits" is a schema-2 key/);
    for (const key of ['defaults', 'roots', 'extensions']) stops(Object.fromEntries(Object.entries(SCHEMA1()).filter(([name]) => name !== key)), new RegExp(`"${key}" must be a`));
    const text = `${JSON.stringify(SCHEMA1({ maxLines: 300, maxLineBytes: 1000 }), null, 2)}\n`;
    const cwd = project({ 'src/a.mjs': 'x\n' }, text);
    const path = join(cwd, 'docs', 'ai', 'source-size.json');
    assert.equal(loadSourceSizeConfig(cwd).config.limits['lines-per-file'].source, 'override');
    assert.equal(readFileSync(path, 'utf8'), text, 'the read wrote nothing');
    assert.equal(main(['--check', '--cwd', cwd]).code, 1, 'the check stops on a schema-1 config');
    assert.equal(readFileSync(path, 'utf8'), text, 'the check on schema 1 wrote nothing');
  });
});

describe('spec:source-size/S17 — the root "." judges every tracked path with a declared extension, and no extension judges no file', () => {
  it('whole-tree-root: the record lands under ".", the check judges every tracked declared-extension path, and no extension judges no file', () => {
    const cwd = project({ 'a.mjs': 'x\n', 'deep/x/big.mjs': 'x\n'.repeat(441), 'gen/huge.mjs': 'x\n'.repeat(500), 'notes.md': 'x\n'.repeat(500) }, JSON.stringify({ _README: 'fixture', schema: 2, exclude: ['gen'], extensions: ['.mjs'] }, null, 2));
    writeFileSync(join(cwd, 'untracked.mjs'), 'x\n'.repeat(500));
    const written = main(['--write-baseline', '--reason', 'initial adoption', '--cwd', cwd]);
    assert.equal(written.code, 0, `${written.stdout}${written.stderr}`);
    const { baseline, aggregate } = JSON.parse(readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8'));
    assert.deepEqual([baseline, aggregate], [{ 'deep/x/big.mjs': { lines: 441, reason: 'initial adoption' } }, { '.': { lines: 442, reason: 'initial adoption' } }]);
    const check = main(['--check', '--cwd', cwd]);
    assert.deepEqual([check.code, check.stdout.includes('PASS — 2 in-scope file(s)')], [0, true], `${check.stdout}${check.stderr}`);
    for (const roots of [undefined, ['src']]) {
      const cwd = project({ 'src/big.mjs': `${'y'.repeat(1001)}\n`.repeat(441) }, JSON.stringify({ schema: 2, roots, baseline: {}, aggregate: { [roots ? 'src' : '.']: { lines: 0, reason: 'r' } } }, null, 2));
      const result = main(['--check', '--cwd', cwd]);
      assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
      assert.ok(result.stdout.includes(`NOTE — ${join(cwd, 'docs/ai/source-size.json')} declares no extension, so no file is judged on lines or bytes`), result.stdout);
      assert.match(result.stdout, /PASS — 0 in-scope file\(s\)/);
      assert.doesNotMatch(result.stdout, /matches ZERO tracked files/);
    }
  });
});
