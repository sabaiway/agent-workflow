// The layout limits: the band every limit is judged with, the layout count over a list of entries, the spec
// store's walk and the layout record's grammar.
// Contract: docs/ai/specs/kit/source-size/index.md and its part layout.md.

import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const loadLayout = () => import('./layout.mjs');
const loadLimits = () => import('./limits.mjs');

// 'n', 0xff, 'm': a name that is not valid UTF-8, and its binary string (one char per byte).
const ODD_NAME = Buffer.from([0x6e, 0xff, 0x6d]);
const ODD = ODD_NAME.toString('latin1');
const CWD = '/fixture/project';
const STORE = `${CWD}/docs/ai/specs`;
const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Clean at or under the value, a warning above it within the band, a stop beyond it.
const judgeAt = (bandOf, n, { value, tolerance }) => (n <= value ? 'clean' : n <= value + bandOf(value, tolerance) ? 'warning' : 'stop');

// A trailing '/' marks a directory entry; any other path is a non-directory entry.
const entriesOf = (...paths) => paths.map((path) => (path.endsWith('/') ? { path: path.slice(0, -1), dir: true } : { path, dir: false }));
const countPaths = (layoutCounts, paths) => {
  const { files, directories } = layoutCounts(entriesOf(...paths));
  return { files, directories: Object.fromEntries([...directories].sort(([a], [b]) => (a < b ? -1 : 1))) };
};

const dirOf = (entries, depth, reach) => ({ entries, depth, reach });
const sortEntries = (entries) => [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
const pathOf = (rel) => (rel === '' ? STORE : `${STORE}/${rel}`);
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// A fake disk keyed by absolute path: { names } a directory, 'file', 'link', or { lstatError | readError }.
// Every call is recorded; readdir on a link throws, so a walk that follows one is refused, never looping.
const fakeDisk = (nodes) => {
  const calls = [];
  const keyOf = (path) => (Buffer.isBuffer(path) ? path.toString('latin1') : String(path));
  const record = (kind, path) => calls.push([kind, keyOf(path)]) && [keyOf(path), nodes[keyOf(path)]];
  const lstat = (path) => {
    const [key, node] = record('lstat', path);
    if (node === undefined) throw failure('ENOENT', `no such file or directory, lstat '${key}'`);
    if (node.lstatError) throw node.lstatError;
    return { isDirectory: () => Array.isArray(node.names) || Boolean(node.readError) };
  };
  const readdir = (path) => {
    const [key, node] = record('readdir', path);
    if (node === 'link') throw new Error(`fake: readdir followed the symlink ${key}`);
    if (node?.readError) throw node.readError;
    if (!Array.isArray(node?.names)) throw failure('ENOTDIR', `not a directory, scandir '${key}'`);
    return node.names;
  };
  return { calls, deps: Object.freeze({ readdir, lstat }) };
};

const readsOf = (calls) => calls.filter(([kind]) => kind === 'readdir').map(([, path]) => path).sort();

describe('spec:source-size/S25 the band is ceil(value × tolerance / 100): clean at or under the value, a warning within the band, a stop beyond', () => {
  it('computes the band as ceil(value × tolerance / 100), an integer at every point', async () => {
    const { bandOf } = await loadLayout();
    const points = [[400, 10, 40], [1000, 0, 0], [20, 10, 2], [5, 0, 0], [47, 10, 5], [141, 10, 15], [99, 1, 1], [101, 1, 2], [1, 1, 1], [100, 100, 100], [0, 10, 0]];
    for (const [value, tolerance, band] of points) {
      assert.equal(bandOf(value, tolerance), band, `bandOf(${value}, ${tolerance})`);
      assert.ok(Number.isInteger(bandOf(value, tolerance)), `bandOf(${value}, ${tolerance}) is an integer`);
    }
  });

  it('judges a value clean at or under the limit, a warning above it within the band and a stop beyond the band', async () => {
    const { bandOf } = await loadLayout();
    const limit = { value: 47, tolerance: 10 };
    assert.deepEqual([46, 47, 48, 52, 53, 90].map((n) => judgeAt(bandOf, n, limit)), ['clean', 'clean', 'warning', 'warning', 'stop', 'stop']);
    assert.deepEqual([5, 6].map((n) => judgeAt(bandOf, n, { value: 5, tolerance: 0 })), ['clean', 'stop'], 'a zero tolerance has no band');
  });

  it('under the kit limits 400, 440 and 441 lines, 1000 and 1001 bytes, 20, 22 and 23 entries and depth 5 and 6 judge as stated', async () => {
    const { bandOf } = await loadLayout();
    const { KIT_LIMITS } = await loadLimits();
    const judged = (id, values) => values.map((n) => judgeAt(bandOf, n, KIT_LIMITS[id]));
    assert.deepEqual(judged('lines-per-file', [400, 401, 440, 441]), ['clean', 'warning', 'warning', 'stop']);
    assert.deepEqual(judged('bytes-per-line', [1000, 1001]), ['clean', 'stop']);
    assert.deepEqual(judged('entries-per-directory', [20, 21, 22, 23]), ['clean', 'warning', 'warning', 'stop']);
    assert.deepEqual(judged('depth', [5, 6]), ['clean', 'stop']);
  });
});

describe('spec:source-size/S28 layout counts every entry: distinct names under a directory, its depth below the root, every non-directory a file', () => {
  it('counts a root holding a/x.mjs and a/b/y.mjs as 2 files, the root 1 entry, a 2 entries at depth 1 reaching level 2', async () => {
    const { layoutCounts } = await loadLayout();
    assert.deepEqual(countPaths(layoutCounts, ['a/x.mjs', 'a/b/y.mjs']), { files: 2, directories: { '': dirOf(1, 0, 2), a: dirOf(2, 1, 2), 'a/b': dirOf(1, 2, 2) } });
  });

  it('counts the distinct names directly under each directory, the root own directory included', async () => {
    const { layoutCounts } = await loadLayout();
    const { directories } = countPaths(layoutCounts, ['x.mjs', 'y.mjs', 'a/', 'a/1.md', 'a/2.md', 'a/3/z.md', 'b/']);
    assert.equal(directories[''].entries, 4, 'x.mjs, y.mjs, a and b');
    assert.equal(directories.a.entries, 3, 'a directory listed and implied by its files counts once');
    assert.equal(directories['a/3'].entries, 1);
  });

  it('counts depth as the directory segments below the root, a file own name being no level', async () => {
    const { layoutCounts } = await loadLayout();
    const five = countPaths(layoutCounts, ['a/b/c/d/e/f.md']);
    assert.deepEqual(five.directories['a/b/c/d/e'], dirOf(1, 5, 5));
    assert.equal(five.directories[''].reach, 5);
    assert.equal(Object.hasOwn(five.directories, 'a/b/c/d/e/f.md'), false);
    const six = countPaths(layoutCounts, ['a/b/c/d/e/f.md', 'a/b/c/d/e/g/h.mjs']);
    assert.deepEqual(six.directories['a/b/c/d/e/g'], dirOf(1, 6, 6), 'the sixth level');
    assert.deepEqual([six.directories[''].reach, six.directories.a.reach, six.directories['a/b/c/d/e'].reach], [6, 6, 6]);
  });

  it('counts every non-directory entry anywhere under the root as a file, a symlink or gitlink included, and never enters it', async () => {
    const { layoutCounts } = await loadLayout();
    const counted = countPaths(layoutCounts, ['link', 'vendor/module', 'src/a.mjs', 'src/deep/b.md']);
    assert.equal(counted.files, 4);
    assert.deepEqual(Object.keys(counted.directories), ['', 'src', 'src/deep', 'vendor']);
    assert.equal(counted.directories.vendor.entries, 1);
  });

  it('counts an empty directory entry as a directory of no entry, and an empty list as the root alone', async () => {
    const { layoutCounts } = await loadLayout();
    assert.deepEqual(countPaths(layoutCounts, ['empty/', 'a/none/', 'a/x.md']), {
      files: 1, directories: { '': dirOf(2, 0, 2), a: dirOf(2, 1, 2), 'a/none': dirOf(0, 2, 2), empty: dirOf(0, 1, 1) },
    });
    assert.deepEqual(countPaths(layoutCounts, []), { files: 0, directories: { '': dirOf(0, 0, 0) } });
  });

  it('compares names as bytes, so a name that is not valid UTF-8 is counted and never refused', async () => {
    const { layoutCounts } = await loadLayout();
    const other = `n${String.fromCharCode(0xfe)}m`;
    const counted = countPaths(layoutCounts, [`${ODD}/x.mjs`, `${ODD}/y.mjs`, `${other}/z.mjs`, ODD.slice(0, 2)]);
    assert.equal(counted.files, 4);
    assert.equal(counted.directories[''].entries, 3, 'names one byte apart stay distinct');
    assert.deepEqual(counted.directories[ODD], dirOf(2, 1, 1));
    assert.equal(counted.directories[other].entries, 1);
  });
});

describe('spec:source-size/S29 the spec store is walked from disk through the readdir and lstat it is handed, following no symlink, writing nothing', () => {
  it('returns absent when lstat of docs/ai/specs fails with ENOENT or ENOTDIR, reading nothing more', async () => {
    const { SPEC_STORE_ROOT, walkSpecStore } = await loadLayout();
    assert.equal(SPEC_STORE_ROOT, 'docs/ai/specs');
    const { calls, deps } = fakeDisk({});
    assert.deepEqual(walkSpecStore(CWD, deps), { state: 'absent' });
    assert.deepEqual(calls, [['lstat', STORE]]);
    const underAFile = fakeDisk({ [STORE]: { lstatError: failure('ENOTDIR', 'not a directory') } });
    assert.deepEqual(walkSpecStore(CWD, underAFile.deps), { state: 'absent' }, 'a file where docs or docs/ai would be leaves no store');
  });

  it('walks a present store by lstat on every entry, names given back as Buffers or strings, a non-UTF-8 name counted', async () => {
    const { layoutCounts, walkSpecStore } = await loadLayout();
    const { calls, deps } = fakeDisk({
      [STORE]: { names: [Buffer.from('index.md'), 'kit', ODD_NAME] }, [pathOf('index.md')]: 'file', [pathOf(ODD)]: 'file',
      [pathOf('kit')]: { names: ['a.md', Buffer.from('empty')] }, [pathOf('kit/a.md')]: 'file', [pathOf('kit/empty')]: { names: [] },
    });
    const walked = walkSpecStore(CWD, deps);
    assert.equal(walked.state, 'present');
    const expected = entriesOf('index.md', 'kit/', 'kit/a.md', 'kit/empty/', ODD);
    assert.deepEqual(sortEntries(walked.entries), expected);
    assert.equal(layoutCounts(walked.entries).files, 3);
    const lstated = calls.filter(([kind]) => kind === 'lstat').map(([, path]) => path).sort();
    assert.deepEqual(lstated, [STORE, ...expected.map(({ path }) => pathOf(path))].sort(), 'the store and every entry read by lstat');
    assert.deepEqual(readsOf(calls), [STORE, pathOf('kit'), pathOf('kit/empty')]);
  });

  it('refuses a store present but not a directory, naming its path, and lists nothing under it', async () => {
    const { walkSpecStore } = await loadLayout();
    const { calls, deps } = fakeDisk({ [STORE]: 'file' });
    const walked = walkSpecStore(CWD, deps);
    assert.deepEqual([walked.state, walked.path], ['refused', STORE]);
    assert.ok(typeof walked.cause === 'string' && walked.cause.length > 0, 'the refusal carries its cause');
    assert.deepEqual(readsOf(calls), []);
  });

  it('refuses a store that is a symlink, even one to a directory, and never follows it', async () => {
    const { walkSpecStore } = await loadLayout();
    const { calls, deps } = fakeDisk({ [STORE]: 'link', [`${CWD}/elsewhere`]: { names: ['a.md'] } });
    const walked = walkSpecStore(CWD, deps);
    assert.deepEqual([walked.state, walked.path], ['refused', STORE]);
    assert.deepEqual(readsOf(calls), []);
  });

  it('refuses on a read error during the walk, naming the path it could not read', async () => {
    const { walkSpecStore } = await loadLayout();
    const denied = failure('EACCES', 'permission denied');
    const atRoot = walkSpecStore(CWD, fakeDisk({ [STORE]: { lstatError: denied } }).deps);
    assert.deepEqual([atRoot.state, atRoot.path], ['refused', STORE], 'an lstat error other than ENOENT is no absent store');
    const listing = walkSpecStore(CWD, fakeDisk({ [STORE]: { names: ['kit'] }, [pathOf('kit')]: { readError: denied } }).deps);
    assert.deepEqual([listing.state, listing.path], ['refused', pathOf('kit')]);
    assert.match(listing.cause, /EACCES/);
    const entry = walkSpecStore(CWD, fakeDisk({ [STORE]: { names: ['a.md'] }, [pathOf('a.md')]: { lstatError: failure('EIO', 'i/o error') } }).deps);
    assert.deepEqual([entry.state, entry.path], ['refused', pathOf('a.md')]);
    assert.match(entry.cause, /EIO/);
  });

  it('counts a symlink inside once as an entry and never enters it, one pointing at its own parent included', async () => {
    const { walkSpecStore } = await loadLayout();
    const { calls, deps } = fakeDisk({
      [STORE]: { names: ['self', 'kit', 'out'] }, [pathOf('self')]: 'link', [pathOf('out')]: 'link',
      [pathOf('kit')]: { names: ['up', 'x.md'] }, [pathOf('kit/up')]: 'link', [pathOf('kit/x.md')]: 'file',
    });
    const walked = walkSpecStore(CWD, deps);
    assert.equal(walked.state, 'present');
    assert.deepEqual(sortEntries(walked.entries), entriesOf('kit/', 'kit/up', 'kit/x.md', 'out', 'self'));
    assert.deepEqual(readsOf(calls), [STORE, pathOf('kit')]);
    const entered = calls.filter(([, path]) => [pathOf('self/'), pathOf('out/'), pathOf('kit/up/')].some((link) => path.startsWith(link)));
    assert.deepEqual(entered, [], 'nothing below a link is read');
  });

  it('reads through the readdir and lstat it is handed alone and writes nothing, on a real tree too', async () => {
    const { walkSpecStore } = await loadLayout();
    const { calls, deps } = fakeDisk({ [STORE]: { names: ['a.md'] }, [pathOf('a.md')]: 'file' });
    walkSpecStore(CWD, deps);
    assert.deepEqual(Object.keys(deps).sort(), ['lstat', 'readdir'], 'the handed deps hold no write door');
    assert.deepEqual([...new Set(calls.map(([kind]) => kind))].sort(), ['lstat', 'readdir']);

    const root = mkdtempSync(join(tmpdir(), 'layout-walk-'));
    scratch.push(root);
    const store = join(root, 'docs', 'ai', 'specs');
    mkdirSync(join(store, 'kit'), { recursive: true });
    writeFileSync(join(store, 'kit', 'a.md'), 'a\n');
    symlinkSync('..', join(store, 'kit', 'up'));
    writeFileSync(Buffer.concat([Buffer.from(`${store}/`), ODD_NAME]), 'x\n');
    const snapshot = () => [store, join(store, 'kit')].map((dir) => [
      readdirSync(dir, { encoding: 'buffer' }).map((name) => name.toString('latin1')).sort(), statSync(dir).mtimeMs,
    ]);
    const before = snapshot();
    const real = [];
    const walked = walkSpecStore(root, {
      readdir: (path, options) => { real.push('readdir'); return readdirSync(path, options); },
      lstat: (path) => { real.push('lstat'); return lstatSync(path); },
    });
    assert.equal(walked.state, 'present');
    assert.deepEqual(sortEntries(walked.entries), entriesOf('kit/', 'kit/a.md', 'kit/up', ODD));
    assert.equal(real.filter((kind) => kind === 'readdir').length, 2, 'the store and kit, never the link to its parent');
    assert.deepEqual(snapshot(), before, 'the tree is unchanged');
  });
});

describe('spec:source-size/S30 the layout record holds exactly roots and directories, and layoutDefect names the first key that breaks it', () => {
  const REASON_RULE = 'a reason must be a non-empty string';
  const reasonDefect = (reason) => (typeof reason === 'string' && reason.trim() !== '' ? null : REASON_RULE);
  const validRecord = () => ({
    roots: { src: { files: 47, reason: 'layout starts' }, 'docs/ai/specs': { files: 0, reason: 'layout starts' } },
    directories: {
      '.': { entries: 23, reason: 'a wide top' },
      'src/wider': { entries: 23, reason: 'layout starts' },
      'src/a/b/c/d/e/g': { depth: 6, reason: 'layout starts' },
      'src/both': { entries: 30, depth: 7, reason: 'both' },
    },
  });
  const withRoot = (entry) => ({ ...validRecord(), roots: { src: entry } });
  const withDir = (key, entry) => ({ ...validRecord(), directories: { [key]: entry } });

  it('accepts a record of exactly roots and directories, each entry of its shape, and a record of empty maps', async () => {
    const { layoutDefect } = await loadLayout();
    assert.equal(layoutDefect(validRecord(), reasonDefect), null);
    assert.equal(layoutDefect({ roots: {}, directories: {} }, reasonDefect), null);
  });

  it('refuses a record that is not an object, misses a key or carries another, naming "layout"', async () => {
    const { layoutDefect } = await loadLayout();
    for (const value of [null, [], 'layout', 3]) assert.match(layoutDefect(value, reasonDefect), /^"layout" must be an object/);
    assert.equal(layoutDefect({ roots: {} }, reasonDefect), '"layout" is missing directories');
    assert.equal(layoutDefect({ ...validRecord(), x: 1 }, reasonDefect), '"layout" carries unknown key(s): x');
    assert.equal(layoutDefect({ roots: [], directories: {} }, reasonDefect), '"layout"."roots" must be an object');
    assert.equal(layoutDefect({ roots: {}, directories: null }, reasonDefect), '"layout"."directories" must be an object');
  });

  it('refuses a root entry that is not exactly files and reason, naming the root', async () => {
    const { layoutDefect } = await loadLayout();
    assert.equal(layoutDefect(withRoot({ reason: 'r' }), reasonDefect), '"layout"."roots"."src" is missing files');
    assert.equal(layoutDefect(withRoot({ files: 3 }), reasonDefect), '"layout"."roots"."src" is missing reason');
    assert.equal(layoutDefect(withRoot({ files: 3, entries: 2, reason: 'r' }), reasonDefect), '"layout"."roots"."src" carries unknown key(s): entries');
    assert.match(layoutDefect(withRoot(3), reasonDefect), /^"layout"\."roots"\."src" must be an object/);
  });

  it('refuses a directory entry that records neither entries nor depth, or carries another key, naming the directory', async () => {
    const { layoutDefect } = await loadLayout();
    assert.equal(layoutDefect(withDir('a', { reason: 'r' }), reasonDefect), '"layout"."directories"."a" must record entries or depth');
    assert.equal(layoutDefect(withDir('a', { entries: 23 }), reasonDefect), '"layout"."directories"."a" is missing reason');
    assert.equal(layoutDefect(withDir('a', { files: 3, reason: 'r' }), reasonDefect), '"layout"."directories"."a" carries unknown key(s): files');
  });

  it('refuses a count that is not a non-negative integer, naming the key and the value, and accepts 0', async () => {
    const { layoutDefect } = await loadLayout();
    assert.equal(layoutDefect(withDir('a', { depth: -1, reason: 'r' }), reasonDefect), '"layout"."directories"."a".depth must be a non-negative integer, got -1');
    assert.equal(layoutDefect(withDir('a', { entries: 1.5, reason: 'r' }), reasonDefect), '"layout"."directories"."a".entries must be a non-negative integer, got 1.5');
    assert.equal(layoutDefect(withDir('a', { entries: '23', reason: 'r' }), reasonDefect), '"layout"."directories"."a".entries must be a non-negative integer, got "23"');
    assert.equal(layoutDefect(withRoot({ files: null, reason: 'r' }), reasonDefect), '"layout"."roots"."src".files must be a non-negative integer, got null');
    assert.equal(layoutDefect(withRoot({ files: 0, reason: 'r' }), reasonDefect), null);
  });

  it('refuses a reason the handed rule refuses, naming the key', async () => {
    const { layoutDefect } = await loadLayout();
    assert.equal(layoutDefect(withRoot({ files: 3, reason: '' }), reasonDefect), `"layout"."roots"."src".reason: ${REASON_RULE}`);
    const banned = (reason) => (reason === 'banned' ? 'banned word' : null);
    assert.equal(layoutDefect(withDir('a', { entries: 23, reason: 'banned' }), banned), '"layout"."directories"."a".reason: banned word');
    assert.equal(layoutDefect(withDir('a', { entries: 23, reason: '' }), banned), null, 'the rule is the one handed in');
  });

  it('refuses a directory key other than "." with an empty, "." or ".." segment, naming it, and accepts "." and a plain path', async () => {
    const { layoutDefect } = await loadLayout();
    for (const key of ['', 'a//b', 'a/', '/a', './a', 'a/.', 'a/../b', '..']) {
      assert.equal(layoutDefect(withDir(key, { entries: 23, reason: 'r' }), reasonDefect),
        `"layout"."directories" key "${key}" must be ".", or a path with no empty, "." or ".." segment`, `key "${key}"`);
    }
    for (const key of ['.', 'src', 'src/a.b', '.hidden/x', `${ODD}/x`]) {
      assert.equal(layoutDefect(withDir(key, { depth: 6, reason: 'r' }), reasonDefect), null, `key "${key}"`);
    }
    const twoBad = { roots: { src: { reason: 'r' } }, directories: { 'a//b': { entries: 23, reason: 'r' } } };
    assert.equal(layoutDefect(twoBad, reasonDefect), '"layout"."roots"."src" is missing files', 'the first key that breaks it');
  });
});
