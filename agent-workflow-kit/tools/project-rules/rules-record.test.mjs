// The record writer: a write when every condition holds, the other themes' entries kept, and every
// stop case naming its condition while the tree stays byte for byte as it was.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EFFECTIVE, KIT, KIT_TEXT, LOCAL, LOCAL_TEXT, MERGED_TEXT, RECORD,
  copyProject, entryOf, load, makeProject, mergedProject, need, recordText, removeProject, sha, snapshot,
} from './rules-harness.test.mjs';

const THEME = 'project-layout';
const OTHER = Object.freeze({ name: 'other-theme', template: 'x', readWhen: 'y' });
const TWO_THEMES = Object.freeze([
  Object.freeze({ name: THEME, template: 'references/rules/project-layout.md', readWhen: 'Creating, moving or naming a file, a module or a spec' }),
  OTHER,
]);
const NO_FRONTMATTER = '# Project layout\n\nA module is a directory. Tests live in test/.\n';

const roots = [];
const track = (root) => {
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) removeProject(root);
});

const writeRecordOf = async () => need(await load('./rules-record.mjs'), 'writeRecord');
const recordOf = (root) => JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
const place = (root, rel, body) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const link = (root, target, rel) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  symlinkSync(target, join(root, rel));
};
const copyPassed = () => entryOf({ kit: KIT_TEXT, effective: KIT_TEXT });
const mergePassed = () => entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: MERGED_TEXT });

describe('spec:project-rules/S3 record writes the closed entry, keeps every other theme and replaces an unreadable record', () => {
  it('writes schema 1 with the local absent stated for a kit copy with no record', async () => {
    const writeRecord = await writeRecordOf();
    const root = track(makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT }));
    const result = writeRecord(root, THEME, copyPassed());
    assert.equal(result.ok, true);
    assert.equal(result.path, RECORD);
    assert.deepEqual(result.entry, copyPassed());
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), recordText({ [THEME]: copyPassed() }));
    assert.equal(recordOf(root).themes[THEME].local, 'absent');
  });

  it('writes the merge entry of the three digests', async () => {
    const writeRecord = await writeRecordOf();
    const root = track(makeProject({ [KIT]: KIT_TEXT, [LOCAL]: LOCAL_TEXT, [EFFECTIVE]: MERGED_TEXT }));
    const result = writeRecord(root, THEME, mergePassed());
    assert.equal(result.ok, true);
    assert.deepEqual(recordOf(root), { schema: 1, themes: { [THEME]: mergePassed() } });
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), recordText({ [THEME]: mergePassed() }));
  });

  it('replaces the theme entry of an existing record on a re-record', async () => {
    const writeRecord = await writeRecordOf();
    const root = track(copyProject());
    place(root, LOCAL, LOCAL_TEXT);
    place(root, EFFECTIVE, MERGED_TEXT);
    const result = writeRecord(root, THEME, mergePassed());
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), recordText({ [THEME]: mergePassed() }));
  });

  it('keeps another theme entry with its values and its place first', async () => {
    const writeRecord = await writeRecordOf();
    const other = { kit: sha('other kit'), local: sha('other local'), effective: sha('other effective') };
    const root = track(makeProject({
      [KIT]: KIT_TEXT,
      [EFFECTIVE]: KIT_TEXT,
      [RECORD]: recordText({ [OTHER.name]: other }),
    }));
    const result = writeRecord(root, THEME, copyPassed(), { themes: TWO_THEMES });
    assert.equal(result.ok, true);
    const written = recordOf(root);
    assert.deepEqual(written.themes[OTHER.name], other);
    assert.deepEqual(Object.keys(written.themes), [OTHER.name, THEME]);
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), recordText({ [OTHER.name]: other, [THEME]: copyPassed() }));
  });

  it('replaces a record that is not JSON with one holding only the written entry', async () => {
    const writeRecord = await writeRecordOf();
    const root = track(makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT, [RECORD]: '{ not json\n' }));
    assert.equal(writeRecord(root, THEME, copyPassed()).ok, true);
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), recordText({ [THEME]: copyPassed() }));
  });

  it('replaces a record with schema 2 with one holding only the written entry', async () => {
    const writeRecord = await writeRecordOf();
    const root = track(makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT, [RECORD]: recordText({ [THEME]: copyPassed() }, 2) }));
    assert.equal(writeRecord(root, THEME, copyPassed()).ok, true);
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), recordText({ [THEME]: copyPassed() }));
  });

  it('replaces a record whose kit digest is wrapped in an array with one holding only the written entry', async () => {
    const writeRecord = await writeRecordOf();
    const entry = { ...copyPassed(), kit: [copyPassed().kit] };
    const root = track(makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT, [RECORD]: JSON.stringify({ schema: 1, themes: { [THEME]: entry } }) }));
    assert.equal(writeRecord(root, THEME, copyPassed()).ok, true);
    assert.equal(readFileSync(join(root, RECORD), 'utf8'), recordText({ [THEME]: copyPassed() }));
  });
});

// refuses(root, theme, passed, condition, deps?) → the refusal, asserted to name the condition and to
// leave the tree as it was.
const refuses = async (root, theme, passed, condition, deps = {}) => {
  const writeRecord = await writeRecordOf();
  track(root);
  const before = snapshot(root);
  const result = writeRecord(root, theme, passed, deps);
  assert.equal(result.ok, false);
  assert.equal(result.condition, condition);
  assert.equal(typeof result.message, 'string');
  assert.deepEqual(snapshot(root), before);
  return result;
};

describe('spec:project-rules/S4 record writes nothing and names the failed condition', () => {
  it('theme: a theme outside the registry', async () => {
    await refuses(copyProject(), 'no-such-theme', copyPassed(), 'theme');
  });

  it('record-path: the record path is a directory', async () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT });
    mkdirSync(join(root, RECORD));
    await refuses(root, THEME, copyPassed(), 'record-path');
  });

  it('record-path: the record is a symlink to a valid record file', async () => {
    const root = makeProject({
      [KIT]: KIT_TEXT,
      [EFFECTIVE]: KIT_TEXT,
      'elsewhere/sources.json': recordText({ [THEME]: copyPassed() }),
    });
    link(root, join(root, 'elsewhere/sources.json'), RECORD);
    await refuses(root, THEME, copyPassed(), 'record-path');
  });

  it('record-path: the effective directory is a symlink to a real directory holding the files', async () => {
    const root = makeProject({
      [KIT]: KIT_TEXT,
      'real-effective/project-layout.md': KIT_TEXT,
      'real-effective/sources.json': recordText({ [THEME]: copyPassed() }),
    });
    link(root, join(root, 'real-effective'), 'docs/ai/rules/effective');
    await refuses(root, THEME, copyPassed(), 'record-path');
  });

  it('record-path: a node on the record path that lstat cannot inspect', async () => {
    const lstat = () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    const result = await refuses(copyProject(), THEME, copyPassed(), 'record-path', { lstat });
    assert.match(result.message, /EACCES/);
  });

  it('write: a write door that throws', async () => {
    const write = () => {
      throw new Error('disk full');
    };
    const result = await refuses(copyProject(), THEME, copyPassed(), 'write', { write });
    assert.match(result.message, /disk full/);
  });

  it('unreadable-file: docs/ai/rules/local is a symlink to a real directory holding a valid local', async () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: MERGED_TEXT, 'real-local/project-layout.md': LOCAL_TEXT });
    link(root, join(root, 'real-local'), dirname(LOCAL));
    await refuses(root, THEME, mergePassed(), 'unreadable-file');
  });

  it('unreadable-file: the local is a directory', async () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: MERGED_TEXT });
    mkdirSync(join(root, LOCAL), { recursive: true });
    await refuses(root, THEME, mergePassed(), 'unreadable-file');
  });

  it('unreadable-file: the kit is a symlink to a regular file', async () => {
    const root = makeProject({ [EFFECTIVE]: KIT_TEXT, 'elsewhere/kit.md': KIT_TEXT });
    link(root, join(root, 'elsewhere/kit.md'), KIT);
    await refuses(root, THEME, copyPassed(), 'unreadable-file');
  });

  it('missing-file: the kit is missing', async () => {
    await refuses(makeProject({ [EFFECTIVE]: KIT_TEXT }), THEME, copyPassed(), 'missing-file');
  });

  it('missing-file: the effective file is missing', async () => {
    await refuses(makeProject({ [KIT]: KIT_TEXT, [RECORD]: recordText({}) }), THEME, copyPassed(), 'missing-file');
  });

  it('frontmatter: a merge whose effective text carries none', async () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [LOCAL]: LOCAL_TEXT, [EFFECTIVE]: NO_FRONTMATTER });
    const passed = entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: NO_FRONTMATTER });
    await refuses(root, THEME, passed, 'frontmatter');
  });

  it('kit-moved: the passed kit digest is wrong', async () => {
    await refuses(copyProject(), THEME, { ...copyPassed(), kit: sha('another kit') }, 'kit-moved');
  });

  it('effective-moved: the passed effective digest is wrong', async () => {
    await refuses(copyProject(), THEME, { ...copyPassed(), effective: sha('another effective') }, 'effective-moved');
  });

  it('local-moved: the passed local digest is wrong', async () => {
    await refuses(mergedProject(), THEME, { ...mergePassed(), local: sha('another local') }, 'local-moved');
  });

  it('local-presence: a local file while the passed local is absent', async () => {
    const passed = entryOf({ kit: KIT_TEXT, effective: MERGED_TEXT });
    await refuses(mergedProject(), THEME, passed, 'local-presence');
  });

  it('local-presence: no local file while the passed local is a digest', async () => {
    await refuses(copyProject(), THEME, { ...copyPassed(), local: sha(LOCAL_TEXT) }, 'local-presence');
  });

  it('effective-differs-from-kit: no local file and effective bytes unequal to the kit', async () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [EFFECTIVE]: MERGED_TEXT });
    await refuses(root, THEME, entryOf({ kit: KIT_TEXT, effective: MERGED_TEXT }), 'effective-differs-from-kit');
  });

  it('effective-equals-input: a local file with the effective equal to the kit', async () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [LOCAL]: LOCAL_TEXT, [EFFECTIVE]: KIT_TEXT });
    const passed = entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: KIT_TEXT });
    await refuses(root, THEME, passed, 'effective-equals-input');
  });

  it('effective-equals-input: a local file with the effective equal to the local', async () => {
    const root = makeProject({ [KIT]: KIT_TEXT, [LOCAL]: LOCAL_TEXT, [EFFECTIVE]: LOCAL_TEXT });
    const passed = entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: LOCAL_TEXT });
    await refuses(root, THEME, passed, 'effective-equals-input');
  });

  it('a refusal never calls the write door', async () => {
    const calls = [];
    const write = (...args) => {
      calls.push(args);
    };
    await refuses(mergedProject(), THEME, { ...mergePassed(), kit: sha('another kit') }, 'kit-moved', { write });
    assert.deepEqual(calls, []);
  });
});
