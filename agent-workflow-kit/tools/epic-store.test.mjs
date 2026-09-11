import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';

const EPICS_REL = 'docs/ai/epics';
const LINK_REFUSALS = ['EPERM', 'EACCES', 'ENOTSUP'];
const createFixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'epic-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: join(root, EPICS_REL) };
};
const createLink = (t, target, path) => {
  try { symlinkSync(target, path); return true; }
  catch (error) {
    if (!LINK_REFUSALS.includes(error.code)) throw error;
    t.diagnostic(`sandbox refused symlinkSync: ${error.code}: ${path}`);
    return false;
  }
};
const loadRules = async () => {
  const rules = await import('./epic-store.mjs').catch((error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    return {};
  });
  assert.equal(typeof rules.readEpicStore, 'function', 'the store leaf must export readEpicStore');
  return rules;
};

it('spec:plan-shape-ownership/S9 reads sorted direct entries through no-follow reads and distinguishes an absent store', async (t) => {
  const { readEpicEntries, readEpicStore, EPICS_REL: exportedPath } = await loadRules();
  const { root, store } = createFixture(t);
  assert.equal(exportedPath, EPICS_REL);
  assert.deepEqual(readEpicStore(root), { outcome: 'absent', entries: [] });
  mkdirSync(join(store, 'nested.md'), { recursive: true });
  writeFileSync(join(store, 'nested.md', 'HIDDEN.md'), 'Hidden');
  writeFileSync(join(store, 'Z.md'), 'Last');
  writeFileSync(join(store, 'A.md'), 'First');
  writeFileSync(join(store, 'notes.txt'), 'Notes');
  const linked = createLink(t, join(store, 'A.md'), join(store, 'B.md'));
  const reads = [];
  const read = (path) => { reads.push(path); return readRegularFileNoFollow(path); };
  const expected = [{ name: 'A.md', text: 'First' },
    ...(linked ? [{ name: 'B.md', outcome: 'non-regular', kind: 'symlink' }] : []),
    { name: 'nested.md', outcome: 'directory' }, { name: 'notes.txt', text: '' }, { name: 'Z.md', text: 'Last' }];
  assert.deepEqual(readEpicEntries(store, read), expected);
  assert.deepEqual(reads, ['A.md', ...(linked ? ['B.md'] : []), 'Z.md'].map((name) => join(store, name)));
  assert.deepEqual(readEpicStore(root), { outcome: 'ok', entries: expected });
  assert.deepEqual(readEpicEntries(store, () => ({ outcome: 'error', code: 'EACCES' })),
    expected.map((entry) => entry.name.endsWith('.md') && entry.outcome !== 'directory'
      ? { name: entry.name, outcome: 'unreadable', reason: 'EACCES' } : entry));
});

it('refuses symlinked and regular-file roots while the CLI door still follows a root link', async (t) => {
  const { readEpicEntries, readEpicStore } = await loadRules();
  const { root, store } = createFixture(t);
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'A.md'), 'First');
  mkdirSync(join(root, 'docs/ai'), { recursive: true });
  if (createLink(t, target, store)) {
    assert.deepEqual(readEpicStore(root), { outcome: 'refused', reason: 'symlink' });
    assert.deepEqual(readEpicEntries(store, readRegularFileNoFollow), [{ name: 'A.md', text: 'First' }]);
    rmSync(store);
  }
  writeFileSync(store, 'Not a directory');
  assert.deepEqual(readEpicStore(root), { outcome: 'refused', reason: 'regular file' });
  rmSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs'), 'Not a directory');
  assert.deepEqual(readEpicStore(root), { outcome: 'refused', reason: 'ENOTDIR' });
});

it('refuses probe errors, entries-read failures and throwing readers without inventing an empty store', async (t) => {
  const { readEpicStore } = await loadRules();
  const { root, store } = createFixture(t);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'A.md'), 'First');
  for (const code of ['EACCES', 'ENOENT']) {
    const read = () => { throw Object.assign(new Error(code), { code }); };
    assert.deepEqual(readEpicStore(root, read), { outcome: 'refused', reason: code });
  }
  for (const error of [null, undefined, 'unreadable']) {
    assert.deepEqual(readEpicStore(root, () => { throw error; }), { outcome: 'refused', reason: String(error) });
  }
  for (const [method, code] of [['lstatSync', 'EACCES'], ['lstatSync', 'ELOOP'], ['readdirSync', 'EACCES'], ['readdirSync', 'ENOENT']]) {
    const mock = t.mock.method(fs, method, () => { throw Object.assign(new Error(code), { code }); });
    syncBuiltinESMExports();
    try { assert.deepEqual(readEpicStore(root), { outcome: 'refused', reason: code }); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
  }
});
