// The read-only check: the record's closed schema, one verdict per theme judged only against the record,
// every moved file named, and no byte written. Contract: docs/ai/specs/kit/project-rules/rules-check.md.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { readFileBytesNoFollow } from '../fs-read-nofollow.mjs';
import {
  EFFECTIVE, KIT, KIT_TEXT, LOCAL, LOCAL_TEXT, MERGED_TEXT, ONE_THEME, RECORD, UPGRADE,
  copyProject, entryOf, load, makeProject, mergedProject, need, recordText, removeProject, sha, snapshot,
} from './rules-harness.test.mjs';

const THEME = 'project-layout';
const NOTE = 'move your edit to local/, a rebuild drops it';
const TEMPLATE = new URL('../../references/rules/project-layout.md', import.meta.url);

const checkFn = async () => {
  const checkRules = need(await load('./rules-check.mjs'), 'checkRules');
  return (root, deps = {}) => checkRules(root, { themes: ONE_THEME, ...deps });
};
const parseFn = async () => need(await load('./rules-check.mjs'), 'parseRecord');

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const drop = (root, rel) => rmSync(join(root, rel), { recursive: true, force: true });
const recordOf = (entry) => recordText({ [THEME]: entry });

// withTree(build, fn) → fn(root) over a fresh tree, the tree removed afterwards.
const withTree = async (build, fn) => {
  const root = build();
  try {
    await fn(root);
  } finally {
    removeProject(root);
  }
};

// The one verdict of the single registry theme.
const only = (verdicts) => {
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].theme, THEME);
  return verdicts[0];
};

const assertDrift = (verdict, roles) => {
  assert.equal(verdict.verdict, 'drift');
  const paths = { kit: KIT, local: LOCAL, effective: EFFECTIVE };
  assert.deepEqual(verdict.moved.map(({ role, file }) => ({ role, file })), roles.map((role) => ({ role, file: paths[role] })));
  for (const moved of verdict.moved) {
    if (moved.role === 'effective') assert.equal(moved.note, NOTE);
    else assert.equal('note' in moved, false);
    assert.ok(verdict.line.includes(moved.file), `line names ${moved.file}`);
  }
  assert.ok(verdict.line.startsWith(`${THEME}: drift`));
  assert.ok(verdict.line.includes(UPGRADE));
  assert.equal(verdict.line.split(NOTE).length - 1, roles.includes('effective') ? 1 : 0);
};

const assertRecord = (verdict, state) => {
  assert.equal(verdict.verdict, 'record');
  assert.equal(verdict.state, state);
  assert.ok(verdict.line.startsWith(`${THEME}: `));
  assert.ok(verdict.line.includes(`record (${state})`), verdict.line);
  assert.ok(verdict.line.includes(UPGRADE));
};

// Every record state a real tree can hold, as a builder of that tree.
const RECORD_TREES = [
  ['a garbage record', 'unreadable-record', () => {
    const root = copyProject();
    put(root, RECORD, 'not json {');
    return root;
  }],
  ['the record path a directory', 'unreadable-record', () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT });
    mkdirSync(join(root, RECORD), { recursive: true });
    return root;
  }],
  ['the kit a directory', 'unreadable-file', () => {
    const root = copyProject();
    drop(root, KIT);
    mkdirSync(join(root, KIT));
    return root;
  }],
  ['the effective a symlink to a regular file', 'unreadable-file', () => {
    const root = copyProject();
    renameSync(join(root, EFFECTIVE), join(root, `${EFFECTIVE}.real`));
    symlinkSync('project-layout.md.real', join(root, EFFECTIVE));
    return root;
  }],
  ['no record file while the kit exists', 'no-entry', () => makeProject({ [KIT]: KIT_TEXT })],
  ['a readable record with no entry while only the effective exists', 'no-entry',
    () => makeProject({ [EFFECTIVE]: KIT_TEXT, [RECORD]: recordText({}) })],
  ['only a local file', 'no-entry', () => makeProject({ [LOCAL]: LOCAL_TEXT })],
  ['an entry with the kit missing', 'missing-file', () => {
    const root = copyProject();
    drop(root, KIT);
    return root;
  }],
  ['an entry with the effective missing', 'missing-file', () => {
    const root = copyProject();
    drop(root, EFFECTIVE);
    return root;
  }],
  ['docs/ai/rules a symlink to a real directory holding a current copy', 'unreadable-record', () => {
    const root = copyProject();
    renameSync(join(root, 'docs/ai/rules'), join(root, 'real-rules'));
    symlinkSync(join(root, 'real-rules'), join(root, 'docs/ai/rules'));
    return root;
  }],
  ['docs/ai/rules/local a symlink to a real directory holding the recorded local', 'unreadable-file', () => {
    const root = mergedProject();
    renameSync(join(root, dirname(LOCAL)), join(root, 'real-local'));
    symlinkSync(join(root, 'real-local'), join(root, dirname(LOCAL)));
    return root;
  }],
  ['matching digests, no local, kit and effective bytes unequal', 'kit-effective-differ', () => makeProject({
    [KIT]: KIT_TEXT,
    [EFFECTIVE]: MERGED_TEXT,
    [RECORD]: recordOf(entryOf({ kit: KIT_TEXT, effective: MERGED_TEXT })),
  })],
];

describe('spec:project-rules/S5 parseRecord reads only the closed schema 1 record', () => {
  const entry = entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: MERGED_TEXT });
  const noLocal = { kit: entry.kit, effective: entry.effective };
  const unreadable = [
    ['schema 2', recordOf(entry).replace('"schema": 1', '"schema": 2')],
    ["schema '1'", JSON.stringify({ schema: '1', themes: { [THEME]: entry } })],
    ['themes an array', JSON.stringify({ schema: 1, themes: [entry] })],
    ['themes null', JSON.stringify({ schema: 1, themes: null })],
    ['an unknown top-level key', JSON.stringify({ schema: 1, themes: {}, extra: true })],
    ['a missing themes key', JSON.stringify({ schema: 1 })],
    ['an entry with an unknown key', JSON.stringify({ schema: 1, themes: { [THEME]: { ...entry, extra: 'x' } } })],
    ['an entry missing local', JSON.stringify({ schema: 1, themes: { [THEME]: noLocal } })],
    ['a theme outside the registry', JSON.stringify({ schema: 1, themes: { 'other-theme': entry } })],
    ['non-JSON text', 'schema: 1\nthemes: {}\n'],
    ['a kit digest wrapped in an array', JSON.stringify({ schema: 1, themes: { [THEME]: { ...entry, kit: [entry.kit] } } })],
    ['a local digest wrapped in an array', JSON.stringify({ schema: 1, themes: { [THEME]: { ...entry, local: [entry.local] } } })],
    ['a value whose toString is null', JSON.stringify({ schema: 1, themes: { [THEME]: { ...entry, effective: { toString: null } } } })],
  ];
  for (const [name, text] of unreadable) {
    it(`is unreadable for ${name}`, async () => {
      const parseRecord = await parseFn();
      const result = parseRecord(text);
      assert.equal(result.ok, false);
      assert.equal(typeof result.reason, 'string');
    });
  }
  it('is readable for a valid record and for an empty themes object', async () => {
    const parseRecord = await parseFn();
    const valid = parseRecord(recordOf(entry));
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.record, { schema: 1, themes: { [THEME]: entry } });
    const copy = parseRecord(recordOf(entryOf({ kit: KIT_TEXT, effective: KIT_TEXT })));
    assert.equal(copy.ok, true);
    assert.equal(copy.record.themes[THEME].local, 'absent');
    const empty = parseRecord(JSON.stringify({ schema: 1, themes: {} }));
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.record, { schema: 1, themes: {} });
  });
  it('makes checkRules answer record (unreadable-record) for a schema 2 record', async () => {
    const checkRules = await checkFn();
    await withTree(copyProject, (root) => {
      put(root, RECORD, recordText({ [THEME]: entryOf({ kit: KIT_TEXT, effective: KIT_TEXT }) }, 2));
      assertRecord(only(checkRules(root)), 'unreadable-record');
    });
  });
});

describe('spec:project-rules/S6 with no local file the check is current only on equal bytes and a matching entry', () => {
  it('is current for a recorded kit copy', async () => {
    const checkRules = await checkFn();
    await withTree(copyProject, (root) => {
      const verdict = only(checkRules(root));
      assert.equal(verdict.verdict, 'current');
      assert.equal(verdict.line, `${THEME}: current`);
    });
  });
  it('is drift naming exactly the local when the entry records a local the tree lacks', async () => {
    const checkRules = await checkFn();
    await withTree(copyProject, (root) => {
      put(root, RECORD, recordOf(entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: KIT_TEXT })));
      assertDrift(only(checkRules(root)), ['local']);
    });
  });
  it('is drift naming exactly the kit, with no note, when entry.kit is wrong while the bytes are equal', async () => {
    const checkRules = await checkFn();
    await withTree(copyProject, (root) => {
      put(root, RECORD, recordOf({ ...entryOf({ kit: KIT_TEXT, effective: KIT_TEXT }), kit: sha('another kit') }));
      assertDrift(only(checkRules(root)), ['kit']);
    });
  });
});

describe('spec:project-rules/S7 with a local file every differing file is drift, the note only on the effective', () => {
  it('is current for a recorded merge', async () => {
    const checkRules = await checkFn();
    await withTree(mergedProject, (root) => {
      const verdict = only(checkRules(root));
      assert.equal(verdict.verdict, 'current');
      assert.equal(verdict.line, `${THEME}: current`);
    });
  });
  const edits = [
    ['the kit edited', ['kit'], (root) => put(root, KIT, `${KIT_TEXT}edited\n`)],
    ['the local edited', ['local'], (root) => put(root, LOCAL, `${LOCAL_TEXT}edited\n`)],
    ['the effective edited', ['effective'], (root) => put(root, EFFECTIVE, `${MERGED_TEXT}edited\n`)],
    ['all three edited', ['kit', 'local', 'effective'], (root) => {
      put(root, KIT, `${KIT_TEXT}edited\n`);
      put(root, LOCAL, `${LOCAL_TEXT}edited\n`);
      put(root, EFFECTIVE, `${MERGED_TEXT}edited\n`);
    }],
    ['the local removed under a recorded local', ['local'], (root) => drop(root, LOCAL)],
  ];
  for (const [name, roles, edit] of edits) {
    it(`is drift naming ${roles.join(', ')} for ${name}`, async () => {
      const checkRules = await checkFn();
      await withTree(mergedProject, (root) => {
        edit(root);
        assertDrift(only(checkRules(root)), roles);
      });
    });
  }
  it('is drift naming exactly the local for a local added to a recorded copy', async () => {
    const checkRules = await checkFn();
    await withTree(copyProject, (root) => {
      put(root, LOCAL, LOCAL_TEXT);
      assertDrift(only(checkRules(root)), ['local']);
    });
  });
});

describe('spec:project-rules/S8 every other state is record with its state and the upgrade line', () => {
  for (const [name, state, build] of RECORD_TREES) {
    it(`is record (${state}) for ${name}`, async () => {
      const checkRules = await checkFn();
      await withTree(build, (root) => assertRecord(only(checkRules(root)), state));
    });
  }
  it('is record (unreadable-record) when lstat cannot inspect a directory on the paths', async () => {
    const checkRules = await checkFn();
    const lstat = () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    await withTree(copyProject, (root) => assertRecord(only(checkRules(root, { lstat })), 'unreadable-record'));
  });
  it('is record (unreadable-file) when the local read is an error outcome', async () => {
    const checkRules = await checkFn();
    await withTree(copyProject, (root) => {
      const read = (path) => (path === join(root, LOCAL) ? { outcome: 'error', code: 'EIO' } : readFileBytesNoFollow(path));
      assertRecord(only(checkRules(root, { read })), 'unreadable-file');
    });
  });
});

describe('spec:project-rules/S9 the check judges the kit file only against the record, never the template', () => {
  it('is current for a kit file unlike the template and reads only the four project paths', async () => {
    const checkRules = await checkFn();
    assert.notEqual(readFileSync(TEMPLATE, 'utf8'), KIT_TEXT);
    await withTree(copyProject, (root) => {
      const reads = [];
      const read = (path) => {
        reads.push(path);
        return readFileBytesNoFollow(path);
      };
      assert.equal(only(checkRules(root, { read })).verdict, 'current');
      assert.deepEqual([...reads].sort(), [RECORD, KIT, LOCAL, EFFECTIVE].map((rel) => join(root, rel)).sort());
      for (const path of reads) assert.equal(path.includes('references/'), false, path);
    });
  });
});

describe('spec:project-rules/S10 a theme with no file and no entry is absent and stops nothing', () => {
  const trees = [
    ['a project with only docs/ai', () => makeProject()],
    ['a bare directory with no docs at all', () => mkdtempSync(join(tmpdir(), 'project-rules-'))],
    ['an empty record and no rule file', () => makeProject({ [RECORD]: JSON.stringify({ schema: 1, themes: {} }) })],
  ];
  for (const [name, build] of trees) {
    it(`is absent for ${name}`, async () => {
      const checkRules = await checkFn();
      await withTree(build, (root) => {
        const verdict = only(checkRules(root));
        assert.equal(verdict.verdict, 'absent');
        assert.equal(verdict.line, `${THEME}: absent`);
        assert.equal('state' in verdict, false);
        assert.equal('moved' in verdict, false);
      });
    });
  }
});

describe('spec:project-rules/S11 a stopping check changes no byte of the tree', () => {
  const trees = [
    ['a drift project', 'drift', () => {
      const root = mergedProject();
      put(root, EFFECTIVE, `${MERGED_TEXT}edited\n`);
      return root;
    }],
    ...RECORD_TREES.map(([name, state, build]) => [name, `record (${state})`, build]),
  ];
  for (const [name, stop, build] of trees) {
    it(`leaves the tree byte-identical for ${name}`, async () => {
      const checkRules = await checkFn();
      await withTree(build, (root) => {
        const before = snapshot(root);
        const verdict = only(checkRules(root));
        assert.ok(verdict.line.startsWith(`${THEME}: ${stop}`), verdict.line);
        assert.deepEqual(snapshot(root), before);
      });
    });
  }
});
