// The read-only check: the record's closed schema, one verdict per theme judged only against the record,
// every moved file named, and no byte written. Contract: docs/ai/specs/kit/project-rules/rules-check.md.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { parseFrontmatter } from '../../references/scripts/docs-size/index.mjs';
import { tokenizeMarkdown } from '../../references/scripts/shared/index.mjs';
import { readFileBytesNoFollow } from '../fs-read-nofollow.mjs';
import {
  EFFECTIVE, KIT, KIT_TEXT, LOCAL, LOCAL_TEXT, MERGED_FATES, MERGED_TEXT, ONE_THEME, RECORD, UPGRADE,
  copyProject, entryOf, legacyOf, load, makeProject, mergedProject, need, recordText, removeProject, sha, snapshot,
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
  assert.ok(verdict.line.startsWith(`${THEME}: record (${state}) — `), verdict.line);
  assert.ok(verdict.line.endsWith(` — ${UPGRADE}`), verdict.line);
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

describe('spec:project-rules/S5 parseRecord reads only the closed schema 1 and 2 records', () => {
  const proved = entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: MERGED_TEXT, fates: MERGED_FATES });
  const entry = legacyOf(proved);
  const noLocal = { kit: entry.kit, effective: entry.effective };
  const unreadable = [
    ...[3, '2', null].map((schema) => [`schema ${JSON.stringify(schema)}`, recordText({ [THEME]: entry }, schema)]),
    ['an entry with fates under schema 1', recordText({ [THEME]: proved }, 1)],
    ['an entry with an unknown key under schema 2', recordOf({ ...proved, extra: true })],
    ['an entry missing local under schema 2', recordOf(noLocal)],
    ['an entry with a non-string fate', recordOf({ ...proved, fates: [null] })],
    ['a schema 2 record with an unknown top-level key', JSON.stringify({ schema: 2, themes: {}, extra: true })],
    ['a schema 2 record missing themes', JSON.stringify({ schema: 2 })],
    ['a record missing schema', JSON.stringify({ themes: {} })],
    ['an entry with non-array fates', recordOf({ ...proved, fates: 'K1 replaced-by L1' })],
    ...['K1  replaced-by L1', 'K1\treplaced-by L1', ' K1 replaced-by L1', 'garbage'].map((fate) =>
      [`a non-normalized fate ${JSON.stringify(fate)}`, recordOf({ ...proved, fates: [fate] })]),
    ['a fate beside an absent local', recordOf({ ...proved, local: 'absent' })],
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
  for (const [name, schema, themes] of [
    ['a proved entry', 2, { [THEME]: proved }],
    ['a legacy entry', 2, { [THEME]: entry }],
    ['a schema 1 legacy entry', 1, { [THEME]: entry }],
    ['a proved copy with local absent', 2, { [THEME]: entryOf({ kit: KIT_TEXT, effective: KIT_TEXT }) }],
    ['empty themes in schema 2', 2, {}],
    ['empty themes in schema 1', 1, {}],
  ]) {
    it(`is readable for ${name}`, async () => {
      const result = (await parseFn())(recordText(themes, schema));
      assert.equal(result.ok, true);
      assert.deepEqual(result.record, { schema, themes });
    });
  }
  it('makes checkRules answer record (unreadable-record) for a schema 3 record', async () => {
    const checkRules = await checkFn();
    await withTree(copyProject, (root) => {
      put(root, RECORD, recordText({ [THEME]: entryOf({ kit: KIT_TEXT, effective: KIT_TEXT }) }, 3));
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

describe('spec:project-rules/S7 with a local file a proved or legacy merge is current, every differing file is drift, the note only on the effective', () => {
  it('is current for a proved merge', async () => {
    const checkRules = await checkFn();
    await withTree(mergedProject, (root) => {
      const verdict = only(checkRules(root));
      assert.equal(verdict.verdict, 'current');
      assert.equal(verdict.line, `${THEME}: current`);
    });
  });
  for (const schema of [1, 2]) {
    it(`is current by its digests alone for a legacy merge in schema ${schema}`, async () => {
      const checkRules = await checkFn();
      await withTree(mergedProject, (root) => {
        put(root, RECORD, recordText({ [THEME]: legacyOf(entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: MERGED_TEXT })) }, schema));
        assert.equal(only(checkRules(root)).line, `${THEME}: current`);
      });
    });
  }
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

describe('spec:project-rules/S10 a theme with no file and no entry is absent for engine, not-laid for kit', () => {
  const lens = { name: 'lens', home: 'engine', template: 'references/rules/lens.md', readWhen: '**Before any code change**' };
  const trees = [
    ['a project with only docs/ai', () => makeProject()],
    ['a bare directory with no docs at all', () => mkdtempSync(join(tmpdir(), 'project-rules-'))],
    ['an empty schema 1 record and no rule file', () => makeProject({ [RECORD]: recordText({}, 1) })],
    ['an empty schema 2 record and no rule file', () => makeProject({ [RECORD]: recordText({}) })],
  ];
  for (const [name, build] of trees) {
    it(`is absent for engine and not-laid for kit over ${name}`, async () => {
      const checkRules = await checkFn();
      await withTree(build, (root) => {
        const [verdict] = checkRules(root, { themes: [lens] });
        assert.equal(verdict.verdict, 'absent');
        assert.equal(verdict.line, 'lens: absent');
        assert.equal('state' in verdict, false);
        assert.equal('moved' in verdict, false);
        assertRecord(only(checkRules(root)), 'not-laid');
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

describe('spec:project-rules/S41 the unit reader preserves rule bytes, lines and heading labels', () => {
  const cells = [
    ['blocks end at a blank or heading', 'First\nsecond\n\nThird\n## Section\nFourth', [[1, 'First\nsecond'], [4, 'Third'], [6, 'Fourth']]],
    ['a fence keeps its blank lines and heading sample', '~~~md\nFirst\n\n# Sample\n~~~', [[1, '~~~md\nFirst\n\n# Sample\n~~~']]],
    ['each column-zero item starts a unit', '- Dash\n* Star\n+ Plus\n1. Dot\n2) Paren', [[1, '- Dash'], [2, '* Star'], [3, '+ Plus'], [4, '1. Dot'], [5, '2) Paren']]],
    ['list lines in a fence start no unit', '~~~\n- Dash\n* Star\n+ Plus\n1. Dot\n2) Paren\n~~~', [[1, '~~~\n- Dash\n* Star\n+ Plus\n1. Dot\n2) Paren\n~~~']]],
    ['an indented continuation stays with its item', '- First\n  continuation\n\tsecond\n- Next', [[1, '- First\n  continuation\n\tsecond'], [4, '- Next']]],
    ['an indented block joins the preceding unit across blanks up to its list line', '- First\n- Second\n\n \n  continuation\nMore\n- Next', [[1, '- First'], [2, '- Second\n\n \n  continuation\nMore'], [7, '- Next']]],
    ['an indented block after a heading is its own unit', 'First\n# Section\n\n  indented\nMore\n- Next', [[1, 'First'], [4, '  indented\nMore'], [6, '- Next']]],
    ['an indented first body block is its own unit', '\tindented\nMore\n- Next', [[1, '\tindented\nMore'], [3, '- Next']]],
    ['whitespace-only lines are blank', 'First\n \t \nSecond', [[1, 'First'], [3, 'Second']]],
    ['prose before the first item is one unit', 'First\nsecond\n- Item', [[1, 'First\nsecond'], [3, '- Item']]],
    ['an item opening a block has no leading unit', '- Item\n\n* Next', [[1, '- Item'], [3, '* Next']]],
    ['CRLF bytes survive', 'First\r\nsecond\r\n\r\n- Next\r\n', [[1, 'First\r\nsecond\r'], [4, '- Next\r']]],
    ['file lines count frontmatter; the precedence paragraph is a unit', '---\ntype: rules\n---\n\n# Title\n\nLocal rules take precedence.\n\n## Section\n- Item', [[7, 'Local rules take precedence.'], [10, '- Item']]],
  ];
  for (const [name, body, expected] of cells) {
    it(name, async () => {
      const readRuleUnits = need(await load('./rules-check.mjs'), 'readRuleUnits');
      const result = readRuleUnits(body, 'K');
      assert.equal(result.ok, true);
      assert.deepEqual(result.units, expected.map(([line, text], i) => ({ label: 'K' + (i + 1), line, text })));
    });
  }
  for (const label of ['K', 'L', 'E']) {
    it('numbers units and headings for ' + label, async () => {
      const readRuleUnits = need(await load('./rules-check.mjs'), 'readRuleUnits');
      assert.deepEqual(readRuleUnits('# Title\nOne\n## Section  \nTwo\n### Nested\nThree', label), {
        ok: true,
        units: ['One', 'Two', 'Three'].map((text, i) => ({ label: label + (i + 1), line: 2 * i + 2, text })),
        headings: ['# Title', '## Section  ', '### Nested'].map((text, i) => ({ label: label === 'K' ? 'KH' + (i + 1) : null, line: 2 * i + 1, text, level: i + 1 })),
      });
    });
  }
  for (const [name, body, label] of [
    ['an unclosed fence', '~~~\nSample\n', 'L'],
    ['an ambiguous leading block', '---\n# Heading\n---\nBody\n', 'E'],
  ]) {
    it('refuses ' + name, async () => {
      const readRuleUnits = need(await load('./rules-check.mjs'), 'readRuleUnits');
      const result = readRuleUnits(body, label);
      assert.deepEqual([result.ok, result.label], [false, label]);
      assert.ok(typeof result.reason === 'string' && result.reason.trim());
    });
  }
});

const FRAME = '---\ntype: rules\n---\n';
const LAST = 'the labels number the three files as they stand when the command runs, and a merged file changed after this refusal takes its new sha256 and its new labels';
const FORMS = ['K<n> replaced-by L<m>', 'K<n> rewritten-as E<m> because-of L<k>', 'L<n> folded-into E<m>'];
const NO_ADVICE = /\b(should|try|fix|consider|instead|suggest|perhaps|maybe|add)\b/i;
const merge = { kit: KIT_TEXT, local: LOCAL_TEXT, effective: MERGED_TEXT, fates: MERGED_FATES };

describe('spec:project-rules/S42 the three fate forms normalize and every other form is refused', () => {
  for (const [name, input, fates] of [
    ['replaced-by', { ...merge, effective: LOCAL_TEXT }, ['K1 replaced-by L1']],
    ['rewritten-as', merge, MERGED_FATES],
    ['folded-into', { ...merge, local: KIT_TEXT, effective: KIT_TEXT }, ['L1 folded-into E1']],
  ]) {
    it('normalizes ' + name, async () => {
      const proveMerge = need(await load('./rules-check.mjs'), 'proveMerge');
      const result = proveMerge({ ...input, fates: fates.map((fate) => ' \t' + fate.replaceAll(' ', ' \t  ') + '  ') });
      assert.equal(result.ok, true);
      assert.deepEqual(result.fates, fates);
    });
  }
  for (const fate of ['KH1 replaced-by L1', 'k1 replaced-by L1', 'K01 replaced-by L1', 'K0 replaced-by L1', 'K1 deleted-by L1', 'K1 replaced-by', 'K1 replaced-by L1 extra', '']) {
    it('refuses form ' + JSON.stringify(fate), async () => {
      const proveMerge = need(await load('./rules-check.mjs'), 'proveMerge');
      const result = proveMerge({ ...merge, fates: [fate] });
      assert.equal(result.ok, false);
      assert.ok(result.failures.some((entry) => entry.row === 'form' && entry.subject === fate));
    });
  }
});

const LEAD = 'A lead rule with more than eight opening words.';
const FIRST = 'Alpha first.';
const SECOND = 'Alpha second.';
const THIRD = 'Alpha third.';
const REPLACEMENT = 'Local replacement.';
const NESTED = 'Nested rule.';
const BETA = 'Beta rule.';
const ALPHA = '## Alpha\n\n';
const NEST = '### Nested\n\n';
const EMPTY = '### Empty\n\n';
const B = '## Beta\n\n';
const ROOT = '# Root\n\n';
const kitBody = FRAME + LEAD + '\n\n' + ROOT + ALPHA + FIRST + '\n\n' + SECOND + '\n\n' + THIRD + '\n\n' + NEST + NESTED + '\n\n' + EMPTY + B + BETA + '\n';
const localBody = FRAME + '# Wrapper\n\n## Notes\n\n### Aside\n\n' + REPLACEMENT + '\n';
const base = { kit: kitBody, local: localBody, effective: kitBody.replace(THIRD, REPLACEMENT), fates: ['K4 replaced-by L1'] };
const altered = (from, to) => ({ ...base, effective: base.effective.replace(from, to) });
const refusedProof = async (proveMerge, input, row, subject) => {
  const result = proveMerge(input);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.row === row && failure.subject === subject), JSON.stringify(result.failures));
  for (const [i, failure] of result.failures.entries()) {
    assert.ok(result.lines[i].startsWith(failure.row + ': ') && result.lines[i].includes(failure.subject), result.lines[i]);
  }
  const listing = result.lines.slice(result.failures.length);
  const readRuleUnits = need(await load('./rules-check.mjs'), 'readRuleUnits');
  for (const [role, label] of [['kit', 'K'], ['local', 'L'], ['effective', 'E']]) {
    const read = readRuleUnits(input[role], label);
    if (!read.ok) continue;
    for (const heading of read.headings.filter((heading) => heading.label !== null)) {
      assert.ok(listing.some((line) => line.includes(heading.label) && line.includes(heading.text)), heading.label);
    }
    for (const unit of read.units) {
      const words = unit.text.split('\n')[0].trim().split(/\s+/);
      const line = listing.find((line) => new RegExp('\\b' + unit.label + '\\b').test(line) && line.includes(words.slice(0, 8).join(' ')));
      assert.ok(line, unit.label);
      if (words.length > 8) assert.ok(!line.includes(words.slice(0, 9).join(' ')), line);
    }
  }
  assert.ok(listing.some((line) => FORMS.every((form) => line.includes(form))));
  assert.equal(result.lines.at(-1), LAST);
  for (const line of result.lines) assert.doesNotMatch(line, NO_ADVICE);
  return result;
};

describe('spec:project-rules/S43 the proof holds precisely over the state table', () => {
  const wholeSection = {
    ...base,
    effective: base.effective.replace(FIRST + '\n\n' + SECOND + '\n\n', '').replace(NESTED + '\n\n', ''),
    fates: ['K2 replaced-by L1', 'K3 replaced-by L1', 'K4 replaced-by L1', 'K5 replaced-by L1'],
  };
  for (const [name, input] of [
    ['the harness merge', merge],
    ['the base merge with its kit lead above the first heading', base],
    ['a local subheading after the kit section units', altered(REPLACEMENT, '### Aside\n\n' + REPLACEMENT)],
    ['a local section at kit section level between kit sections', { ...base, effective: base.effective.replace(REPLACEMENT + '\n\n', '').replace(EMPTY + B, EMPTY + '## Notes\n\n' + REPLACEMENT + '\n\n' + B) }],
    ['a whole section replaced by one local rule', wholeSection],
    ['a kit rule moved with a fate', { ...base, effective: base.effective.replace(FIRST + '\n\n', '').replace(BETA, FIRST + '\n\n' + BETA), fates: [...base.fates, 'K2 rewritten-as E5 because-of L1'] }],
    ['no fates, every rule standing', { ...merge, effective: KIT_TEXT + '\nTests live in test/.\n', fates: [] }],
  ]) {
    it('holds for ' + name, async () => {
      const proveMerge = need(await load('./rules-check.mjs'), 'proveMerge');
      const result = proveMerge(input);
      assert.equal(result.ok, true);
      assert.deepEqual(result.fates, input.fates);
      if (input === wholeSection) {
        assert.equal(result.changes.length, 1);
        for (const label of ['K2', 'K3', 'K4', 'K5', 'L1']) assert.ok(result.changes[0].includes(label));
      }
      if (name === 'a kit rule moved with a fate') assert.ok(result.changes.some((line) => line.includes('moved')));
      if (!input.fates.length) {
        assert.equal(result.changes.length, 1);
        assert.match(result.changes[0], /every kit and local rule stands word for word/);
      }
    });
  }
  const secondTop = { ...base, kit: base.kit.replace(ROOT, '## Root\n\n').replaceAll('## Alpha', '### Alpha').replaceAll('## Beta', '### Beta').replaceAll('### Nested', '#### Nested').replaceAll('### Empty', '#### Empty'),
    effective: base.effective.replace(ROOT, '# Wrapper\n\n## Root\n\n').replaceAll('## Alpha', '### Alpha').replaceAll('## Beta', '### Beta').replaceAll('### Nested', '#### Nested').replaceAll('### Empty', '#### Empty') };
  const failures = [
    ['a missing kit unit', altered(FIRST + '\n\n', ''), 'kit order', 'K2'],
    ['two kit units out of order', altered(FIRST + '\n\n' + SECOND, SECOND + '\n\n' + FIRST), 'kit order', 'K3'],
    ['a kit unit moved to the next section', { ...base, effective: base.effective.replace(FIRST + '\n\n', '').replace(BETA, FIRST + '\n\n' + BETA) }, 'kit order', 'K2'],
    ['the lead moved below the first heading', altered(LEAD + '\n\n' + ROOT, ROOT + LEAD + '\n\n'), 'kit order', 'K1'],
    ['two kit sections swapped', { ...base, effective: base.effective.replace(B + BETA + '\n', '').replace(ALPHA, B + BETA + '\n\n' + ALPHA) }, 'skeleton', 'KH5'],
    ['a kit heading dropped', altered(NEST, ''), 'skeleton', 'KH3'],
    ['a kit heading duplicated', altered(ALPHA, ALPHA + ALPHA), 'headings', '## Alpha'],
    ['a nested kit heading under another kit heading', { ...base, effective: base.effective.replace(NEST + NESTED + '\n\n', '').replace(BETA, NEST + NESTED + '\n\n' + BETA) }, 'skeleton', 'KH3'],
    ['an empty nested kit heading under another kit heading', { ...base, effective: base.effective.replace(EMPTY, '').replace(BETA, BETA + '\n\n' + EMPTY) }, 'skeleton', 'KH4'],
    ['a nested kit heading under a local heading', altered(NEST, '## Notes\n\n' + NEST), 'skeleton', 'KH3'],
    ['an empty nested kit heading under a local heading', altered(EMPTY, '## Notes\n\n' + EMPTY), 'skeleton', 'KH4'],
    ['a local heading between a kit heading and its parent', altered(NEST, '# Wrapper\n\n' + NEST), 'skeleton', 'KH3'],
    ['a local heading above the top level-two kit heading', secondTop, 'skeleton', 'KH1'],
    ['a local unit missing', altered(REPLACEMENT, ''), 'local', 'L1'],
    ['an unaccounted effective unit', altered(BETA, BETA + '\n\nUnclaimed rule.'), 'accounted', 'E7'],
    ['an unknown effective heading', altered(BETA, BETA + '\n\n### Unknown'), 'headings', '### Unknown'],
    ['a label of no unit', { ...base, fates: ['K99 replaced-by L1'] }, 'labels', 'K99 replaced-by L1'],
    ['a unit with two fates', { ...base, fates: [...base.fates, 'K4 rewritten-as E4 because-of L1'] }, 'one fate', 'K4'],
    ['a replaced-by whose local takes a fate', { ...base, fates: [...base.fates, 'L1 folded-into E4'] }, 'replaced-by', base.fates[0]],
    ['a rewritten-as targeting a standing unit', { ...base, fates: ['K4 rewritten-as E2 because-of L1'] }, 'rewritten-as', 'K4 rewritten-as E2 because-of L1'],
    ['no effective frontmatter', altered(FRAME, ''), 'frame', 'effective'],
    ['CRLF effective frontmatter', altered(FRAME, FRAME.replaceAll('\n', '\r\n')), 'frame', 'effective'],
    ['an early delimiter prefix in frontmatter', altered(FRAME, '---\ntype: rules\n---prefix\nmaxLines: 80\n---\n'), 'frame', 'effective'],
    ['an unclosed fence in the effective file', altered(BETA, '~~~\n' + BETA), 'reader', 'effective'],
  ];
  for (const [name, input, row, subject] of failures) {
    it('refuses ' + name, async () => {
      if (name === 'CRLF effective frontmatter') {
        assert.equal(parseFrontmatter(input.effective), null);
        assert.equal(tokenizeMarkdown(input.effective).frontmatter, FRAME.replaceAll('\n', '\r\n'));
      }
      if (name === 'an early delimiter prefix in frontmatter') {
        assert.deepEqual(parseFrontmatter(input.effective), { type: 'rules' });
        assert.equal(tokenizeMarkdown(input.effective).frontmatter, '---\ntype: rules\n---prefix\nmaxLines: 80\n---\n');
      }
      const proveMerge = need(await load('./rules-check.mjs'), 'proveMerge');
      const result = await refusedProof(proveMerge, input, row, subject);
      if (row === 'one fate') {
        const line = result.lines[result.failures.findIndex((failure) => failure.row === row)];
        for (const fate of input.fates) assert.ok(line.includes(fate), line);
      }
    });
  }
});

describe('spec:project-rules/S44 matching proved digests need proof and frontmatter, legacy digests alone suffice', () => {
  const noFrame = KIT_TEXT.slice(KIT_TEXT.indexOf('# Project layout'));
  const cells = [
    ['a merge without proving fates', KIT_TEXT, LOCAL_TEXT, MERGED_TEXT, ['K1', 'L1', 'E1']],
    ['a merge with a missing kit heading and unknown effective heading', KIT_TEXT, LOCAL_TEXT, MERGED_TEXT.replace('# Project layout', '# Unknown'), ['KH1', '# Unknown']],
    ['a merge with an unknown fate label', KIT_TEXT, LOCAL_TEXT, MERGED_TEXT, ['K99 replaced-by L1'], ['K99 replaced-by L1']],
    ['a merge without frontmatter', KIT_TEXT, LOCAL_TEXT, MERGED_TEXT.slice(MERGED_TEXT.indexOf('# Project layout')), []],
    ['a copy without frontmatter', noFrame, undefined, noFrame, []],
  ];
  for (const [name, kit, local, effective, labels, fates = []] of cells) {
    const entry = entryOf({ kit, local, effective, fates });
    const tree = (record) => makeProject({ [KIT]: kit, ...(local === undefined ? {} : { [LOCAL]: local }), [EFFECTIVE]: effective, [RECORD]: record });
    it('is unproved-merge for ' + name, async () => {
      const checkRules = await checkFn();
      await withTree(() => tree(recordOf(entry)), (root) => {
        const verdict = only(checkRules(root));
        assertRecord(verdict, 'unproved-merge');
        for (const label of labels) assert.ok(verdict.line.includes(label), verdict.line);
      });
    });
    for (const schema of [1, 2]) {
      it('is current for legacy schema ' + schema + ' over ' + name, async () => {
        const checkRules = await checkFn();
        await withTree(() => tree(recordText({ [THEME]: legacyOf(entry) }, schema)), (root) => {
          assert.equal(only(checkRules(root)).line, THEME + ': current');
        });
      });
    }
  }
});
