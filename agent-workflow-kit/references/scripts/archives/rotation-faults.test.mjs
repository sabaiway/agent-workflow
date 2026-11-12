import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as changelog from './archive-changelog.mjs';
import * as issues from './archive-issues.mjs';

const { fsIo, writeWhole } = await import('./whole-write.mjs').catch(() => ({}));
const conservation = await import('./rotation-conservation.mjs').catch(() => ({}));
const TODAY = '2026-07-28';
const HOT = 'docs/ai/changelog.md';
const RECENT = 'docs/ai/history/recent.md';
const CARRY = 'docs/ai/history/changelog.carry';
const KNOWN = 'docs/ai/known_issues.md';
const RESOLVED = 'docs/ai/history/issues-resolved.md';
const MONTH = 'docs/ai/history/2026-06.md';
const SEAMS = ['writeFileSync', 'fsyncSync', 'renameSync', 'rmSync'];
const MODES = [[], ['--dry-run'], ['--check']];
const withRoot = (run) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'rotation-faults-'));
  try { return run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
const put = (root, path, text) => {
  fs.mkdirSync(dirname(join(root, path)), { recursive: true });
  fs.writeFileSync(join(root, path), text);
};
const read = (root, path) => fs.readFileSync(join(root, path), 'utf8');
const snapshot = (root, rel = '') => fs.readdirSync(join(root, rel), { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [[path, 'directory'], ...snapshot(root, path)] : [[path, read(root, path)]];
  });
const catchError = (run) => {
  try { run(); } catch (error) { return error; }
  assert.fail('expected an error');
};
const fault = (code = 'EIO') => Object.assign(new Error('injected fault'), { code });
const runRotation = (rotation, root, argv = [], seams = {}) => {
  const log = [];
  const logError = [];
  const code = rotation.runCli(argv, { root, log: (line) => log.push(line), logError: (line) => logError.push(line), ...seams });
  return { code, log, logError };
};
const recordSeams = (before = () => {}) => {
  const steps = [];
  const seams = Object.fromEntries(SEAMS.map((kind) => [kind, (...args) => {
    steps.push({ kind, args });
    before(steps.length - 1, kind, args);
    return fs[kind](...args);
  }]));
  return { seams, steps };
};
const assertUnexpected = (result, name) => {
  assert.equal(result.code, 1);
  assert.equal(result.log[0], `${name}: FAIL \u2014 unexpected error: injected fault`);
  assert.deepEqual(result.logError, []);
};
const parseEntries = (text) => changelog.parseChangelogText(text).entries;
const makeEntry = (date, title, body = `**Goal:** preserve ${title}.\n\nDetails for ${title}.`) =>
  parseEntries(`## ${date} \u2014 ${title}\n\n${body}\n`)[0];
const identity = (entry) => `${entry.dateStr}|${entry.title}`;
const listChangelog = (root) => snapshot(root).filter(([path]) =>
  path === HOT || path === 'docs/ai/changelog-archive.md' || path === RECENT || path === CARRY
  || /^docs\/ai\/history\/\d{4}-\d{2}\.md$/.test(path))
  .flatMap(([path, text]) => parseEntries(text).map((entry) => ({ path, entry })));
const locations = (root, corpus) => corpus.map((original) => [identity(original),
  [...new Set(listChangelog(root).filter(({ entry }) => identity(entry) === identity(original))
    .map(({ path }) => path))].sort()]);
const assertChangelog = (root, corpus) => {
  const entries = listChangelog(root);
  for (const original of corpus) assert.ok(entries.some(({ entry }) => identity(entry) === identity(original)
    && [original.block, changelog.compressEntry(original)].includes(entry.block)), `lost ${identity(original)}`);
  const pairs = entries.map(({ path, entry }) => `${path}|${identity(entry)}`);
  assert.equal(new Set(pairs).size, pairs.length, 'no file holds an identity twice');
};
const trimSection = (section) => section.lines.slice(0, section.lines.findLastIndex((line) => line.trim() !== '') + 1).join('\n');
const parseSections = (text) => issues.parseKnownIssues(text).sections.filter((section) => section.heading?.startsWith('### '));
const makeIssue = (number, resolved = true) => `### Issue-${number} \u2014 section ${number}\n\n${resolved
  ? '- **Resolved:** 2026-04-10' : '- **Status:** Open'}\nbody ${number}.\n`;
const seedChangelog = (root, widened = false) => {
  const huge = makeEntry(TODAY, 'large hot', 'large body\n'.repeat(7001));
  const hot = [huge, makeEntry('2026-07-20', 'hot to warm'), makeEntry('2026-05-12', 'hot to cold')];
  const warm = [makeEntry(widened ? '2026-07-19' : '2026-06-10', 'warm source')];
  const cold = [makeEntry(widened ? '2026-06-15' : '2026-06-01', 'month source')];
  const legacy = makeEntry('2026-04-02', 'legacy source');
  const older = widened ? [] : [makeEntry('2026-05-01', 'existing may')];
  put(root, HOT, `# Changelog\n\n${hot.map(({ block }) => block).join('\n\n')}\n`);
  put(root, RECENT, changelog.buildRecent(warm, TODAY, 'fixture'));
  put(root, MONTH, changelog.buildCold('2026', '06', cold, TODAY));
  if (!widened) put(root, 'docs/ai/history/2026-05.md', changelog.buildCold('2026', '05', older, TODAY));
  put(root, 'docs/ai/changelog-archive.md', `${legacy.block}\n`);
  return { corpus: [...hot, ...warm, ...cold, legacy, ...older], archivable: [],
    targets: [CARRY, HOT, RECENT, ...(widened ? [] : [MONTH, 'docs/ai/history/2026-05.md']),
      'docs/ai/history/2026-04.md', 'docs/ai/history/condensed-index.md'] };
};
const seedIssues = (root) => {
  const live = [makeIssue('001'), makeIssue('002', false), makeIssue('003'), makeIssue('004', false)];
  const earlier = parseSections(makeIssue('000'));
  put(root, KNOWN, `# Known issues\n\n${live.join('\n')}`);
  put(root, RESOLVED, issues.buildResolvedFile(null, earlier, TODAY, 'fixture'));
  return { corpus: [...parseSections(read(root, KNOWN)), ...earlier], earlier,
    archivable: parseSections(live[0] + '\n' + live[2]), targets: [RESOLVED, KNOWN] };
};
const assertIssues = (root, fixture, recovered = false) => {
  const archived = parseSections(read(root, RESOLVED)).map(trimSection);
  const live = parseSections(read(root, KNOWN)).map(trimSection);
  for (const section of fixture.corpus) assert.ok([...live, ...archived].includes(trimSection(section)), `lost ${section.heading}`);
  for (const section of fixture.earlier) assert.equal(archived.filter((value) => value === trimSection(section)).length, 1);
  if (recovered) for (const section of fixture.archivable) {
    assert.equal(archived.filter((value) => value === trimSection(section)).length, 1);
    assert.ok(!live.includes(trimSection(section)));
  }
};
const CHILD = `
import * as fs from 'node:fs';
const [url, root, argv, index] = process.argv.slice(1);
const rotation = await import(url);
const calls = [];
const seams = Object.fromEntries(${JSON.stringify(SEAMS)}.map((kind) => [kind, (...args) => {
  calls.push(kind);
  if (calls.length - 1 === Number(index)) process.kill(process.pid, 'SIGKILL');
  return fs[kind](...args);
}]));
process.exitCode = rotation.runCli(JSON.parse(argv), { root, ...seams, log: () => {}, logError: () => {} });
`;
const proveRotation = ({ rotation, name, seed, windows = [], ceiling }) => withRoot((cleanRoot) => {
  const argv = [`--today=${TODAY}`, ...windows];
  const fixture = seed(cleanRoot);
  const monthBefore = windows.length ? read(cleanRoot, MONTH) : null;
  const recording = recordSeams();
  assert.equal(runRotation(rotation, cleanRoot, argv, recording.seams).code, 0);
  const check = (root, recovered = false) => name === 'archive-changelog'
    ? assertChangelog(root, fixture.corpus) : assertIssues(root, fixture, recovered);
  check(cleanRoot, true);
  const expected = name === 'archive-changelog' ? locations(cleanRoot, fixture.corpus) : null;
  if (windows.length) {
    assert.ok(!parseEntries(read(cleanRoot, RECENT)).some((entry) => entry.title === 'warm source'));
    assert.ok(parseEntries(read(cleanRoot, HOT)).some((entry) => entry.title === 'warm source'));
    assert.ok(parseEntries(read(cleanRoot, RECENT)).some((entry) => entry.title === 'month source'));
    assert.equal(read(cleanRoot, MONTH), monthBefore);
  }
  const assertLater = (source) => {
    if (!ceiling) return;
    for (const [date, code] of [['2026-07-29', 0], [ceiling, 1]]) withRoot((copy) => {
      fs.cpSync(source, copy, { recursive: true });
      const before = snapshot(copy);
      assert.equal(runRotation(rotation, copy, [`--today=${date}`, ...windows]).code, code);
      check(copy);
      if (code === 1) assert.deepEqual(snapshot(copy), before);
      else assert.ok(!fs.existsSync(join(copy, CARRY)));
    });
  };
  assertLater(cleanRoot);
  const cleanSnapshot = snapshot(cleanRoot);
  assert.equal(runRotation(rotation, cleanRoot, argv).code, 0);
  assert.deepEqual(snapshot(cleanRoot), cleanSnapshot);
  assert.deepEqual(recording.steps.map(({ kind }) => kind), fixture.targets.flatMap(() =>
    ['writeFileSync', 'fsyncSync', 'renameSync', 'fsyncSync']).concat(name === 'archive-changelog' ? ['rmSync'] : []));
  assert.deepEqual(recording.steps.filter(({ kind }) => kind === 'renameSync').map(({ args }) => relative(cleanRoot, args[1])), fixture.targets);
  if (name === 'archive-changelog') assert.equal(relative(cleanRoot, recording.steps.at(-1).args[0]), CARRY);
  for (const [index, step] of recording.steps.entries()) {
    for (const mode of ['thrown', ...(step.kind === 'writeFileSync' ? ['partly written'] : []), 'killed']) withRoot((root) => {
      seed(root);
      const label = `${name} step ${index} ${step.kind} ${mode}`;
      if (mode === 'killed') {
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', CHILD,
          new URL(`./${name}.mjs`, import.meta.url).href, root, JSON.stringify(argv), String(index)],
        { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), encoding: 'utf8' });
        assert.equal(result.error, undefined, label);
        assert.equal(result.signal, 'SIGKILL', `${label}: ${result.stderr}`);
        assert.equal(result.status, null, label);
      } else {
        const injected = recordSeams((current, kind, args) => {
          if (current !== index) return;
          if (mode === 'partly written') fs.writeFileSync(args[0], args[1].slice(0, Math.floor(args[1].length / 2)), args[2]);
          throw fault();
        });
        assertUnexpected(runRotation(rotation, root, argv, injected.seams), name);
      }
      check(root);
      const leftovers = snapshot(root).filter(([path]) => path.endsWith('.tmp'));
      assertLater(root);
      assert.equal(runRotation(rotation, root, argv).code, 0, label);
      for (const [path, content] of leftovers) assert.equal(read(root, path), content, label);
      check(root, true);
      if (expected) {
        assert.deepEqual(locations(root, fixture.corpus), expected, label);
        assert.ok(!fs.existsSync(join(root, CARRY)), label);
      }
      const before = snapshot(root);
      assert.equal(runRotation(rotation, root, argv).code, 0, label);
      assert.deepEqual(snapshot(root), before, label);
    });
  }
});

describe('spec:rotation-conservation/S1 whole-file publication and rotation seams', () => {
  const rows = [
    ['clean', null], ['write throws', 0], ['temporary sync throws', 1], ['rename throws', 2],
    ['partly written', 0], ['cleanup throws', 0], ['create EEXIST', 0, 'EEXIST'],
    ['rename EEXIST', 2, 'EEXIST'], ['directory EINVAL', 3, 'EINVAL'], ['directory EIO', 3],
  ];
  for (const [title, index, code] of rows) it(title, () => withRoot((root) => {
    assert.equal(typeof fsIo, 'function');
    assert.equal(typeof writeWhole, 'function');
    const target = join(root, 'target.md');
    fs.writeFileSync(target, 'old bytes');
    const injected = fault(code);
    const recording = recordSeams((current, kind, args) => {
      if (kind === 'fsyncSync') {
        assert.equal(fs.fstatSync(args[0]).isDirectory(), current === 3);
        assert.equal(fs.fstatSync(args[0]).ino, fs.statSync(current === 3 ? root : recording.steps[0].args[0]).ino);
      }
      if (title === 'cleanup throws' && kind === 'rmSync') throw fault();
      if (current !== index) return;
      if (title === 'partly written' || title === 'cleanup throws') fs.writeFileSync(args[0], args[1].slice(0, 4), args[2]);
      throw injected;
    });
    const publish = () => writeWhole(fsIo(recording.seams), target, 'new content');
    if (index === null || code === 'EINVAL') assert.doesNotThrow(publish);
    else assert.equal(catchError(publish), injected);
    assert.equal(fs.readFileSync(target, 'utf8'), index === null || index === 3 ? 'new content' : 'old bytes');
    const temporary = recording.steps[0].args[0];
    if (title === 'cleanup throws') {
      assert.ok(injected.message.includes(temporary));
      assert.ok(fs.existsSync(temporary));
    } else if (code === 'EEXIST') assert.ok(!recording.steps.some(({ kind }) => kind === 'rmSync'));
    else assert.deepEqual(fs.readdirSync(root), ['target.md']);
    if (index === null) assert.deepEqual(recording.steps.map(({ kind }) => kind), ['writeFileSync', 'fsyncSync', 'renameSync', 'fsyncSync']);
  }));
  for (const [name, rotation, seed] of [['archive-changelog', changelog, seedChangelog], ['archive-issues', issues, seedIssues]]) {
    it(`${name} publishes every changed file through a temporary file`, () => withRoot((root) => {
      const fixture = seed(root);
      const before = new Map(snapshot(root));
      const recording = recordSeams();
      assert.equal(runRotation(rotation, root, [`--today=${TODAY}`], recording.seams).code, 0);
      assert.ok(recording.steps.length > 0, 'runCli must route writes through deps');
      const renames = recording.steps.filter(({ kind }) => kind === 'renameSync');
      assert.deepEqual(renames.map(({ args }) => relative(root, args[1])), fixture.targets);
      for (const [index, { kind, args }] of recording.steps.entries()) if (kind === 'writeFileSync') {
        const renamed = renames.find(({ args: [from] }) => from === args[0]);
        assert.ok(renamed);
        assert.equal(args[2].flag, 'wx');
        assert.ok(args[0].endsWith('.tmp'));
        assert.equal(dirname(args[0]), dirname(renamed.args[1]));
        assert.ok(basename(args[0]).startsWith(`${basename(renamed.args[1])}.`));
        assert.equal(recording.steps[index + 1].kind, 'fsyncSync');
        assert.equal(recording.steps[index + 2], renamed);
        assert.ok(!renames.some(({ args: [, target] }) => target === args[0]));
      }
      for (const [path, text] of snapshot(root)) if (before.get(path) !== text)
        assert.ok(renames.some(({ args: [, target] }) => target === join(root, path)), path);
    }));
  }
});
it('spec:rotation-conservation/S2 default-window changelog survives every seam fault', () =>
  proveRotation({ rotation: changelog, name: 'archive-changelog', seed: seedChangelog, ceiling: '2026-07-31' }));
it('spec:rotation-conservation/S3 widened-window changelog survives every seam fault', () =>
  proveRotation({ rotation: changelog, name: 'archive-changelog', seed: (root) => seedChangelog(root, true),
    windows: ['--hot-days=30', '--warm-days=90'], ceiling: '2026-08-27' }));
it('spec:rotation-conservation/S4 issues survive every seam fault', () =>
  proveRotation({ rotation: issues, name: 'archive-issues', seed: seedIssues }));

it('spec:rotation-conservation/S5 refused month publication retains the aging entry for retry', () => withRoot((root) => {
  const fixture = seedChangelog(root);
  const recording = recordSeams((index, kind, args) => {
    if (kind === 'renameSync' && args[1] === join(root, MONTH)) throw fault();
  });
  assertUnexpected(runRotation(changelog, root, [`--today=${TODAY}`], recording.seams), 'archive-changelog');
  const aging = fixture.corpus.find((entry) => entry.title === 'warm source');
  assert.ok(parseEntries(read(root, CARRY)).some((entry) => identity(entry) === identity(aging)));
  assert.equal(runRotation(changelog, root, [`--today=${TODAY}`]).code, 0);
  assert.ok(parseEntries(read(root, MONTH)).some((entry) => identity(entry) === identity(aging)));
  assert.ok(!fs.existsSync(join(root, CARRY)));
  assertChangelog(root, fixture.corpus);
}));

describe('spec:rotation-conservation/S7 carry green states', () => {
  it('absent carry stays unnamed; a standing carry is counted and its unique entries restored in order', () => {
    for (const argv of MODES) withRoot((root) => {
      put(root, HOT, `${makeEntry(TODAY, 'live').block}\n`);
      const before = snapshot(root);
      const result = runRotation(changelog, root, [`--today=${TODAY}`, ...argv]);
      assert.equal(result.code, 0);
      assert.ok(result.log.every((line) => !line.includes(CARRY)));
      assert.ok(!fs.existsSync(join(root, CARRY)));
      if (argv.length) assert.deepEqual(snapshot(root), before);
    });
    withRoot((root) => {
      const shared = makeEntry(TODAY, 'shared', 'live body');
      const unique = [makeEntry('2026-05-10', 'carry cold'), makeEntry('2026-07-20', 'carry warm')];
      const carry = [...unique, makeEntry(TODAY, 'shared', 'losing body')].map(({ block }) => block).join('\n\n');
      put(root, HOT, `${shared.block}\n`);
      put(root, CARRY, carry);
      const before = snapshot(root);
      const recording = recordSeams();
      const dry = runRotation(changelog, root, [`--today=${TODAY}`, '--dry-run'], recording.seams);
      assert.equal(dry.code, 0);
      assert.deepEqual(recording.steps, []);
      assert.equal(JSON.parse(dry.log[1]).perFile[CARRY], 3);
      assert.deepEqual(snapshot(root), before);
      assert.equal(conservation.CARRY_REL, CARRY);
      const result = runRotation(changelog, root, [`--today=${TODAY}`]);
      assert.equal(result.code, 0);
      assert.equal(result.log[0], '[archive-changelog] migrated:');
      assert.equal(parseEntries(read(root, HOT)).find((entry) => entry.title === 'shared').block, shared.block);
      for (const [index, path] of ['docs/ai/history/2026-05.md', RECENT].entries())
        assert.ok(parseEntries(read(root, path)).some((entry) => identity(entry) === identity(unique[index])));
      assertChangelog(root, [shared, ...unique]);
      assert.ok(!fs.existsSync(join(root, CARRY)));
      const restored = result.log.filter((line) => line.includes(CARRY));
      assert.equal(restored.length, 2);
      assert.deepEqual(result.log.slice(-2), restored);
      assert.ok(restored.every((line) => !line.includes(shared.title)));
      for (const [index, entry] of unique.entries()) {
        assert.ok(restored[index].includes(entry.title));
        assert.ok([entry.dateStr, entry.dateSource].some((date) => restored[index].includes(date)));
      }
    });
  });
});

it('spec:rotation-conservation/S8 empty carry is refused by check and cleared by default', () => withRoot((root) => {
  put(root, HOT, '# Changelog\n');
  put(root, CARRY, '');
  const before = snapshot(root);
  const checked = runRotation(changelog, root, [`--today=${TODAY}`, '--check']);
  assert.equal(checked.code, 1);
  assert.ok(checked.log[0].startsWith('archive-changelog: FAIL \u2014 '));
  assert.ok(checked.log[0].includes(CARRY));
  assert.deepEqual(snapshot(root), before);
  const result = runRotation(changelog, root, [`--today=${TODAY}`]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.log, ['[archive-changelog] nothing to rotate \u2014 0 entries across every source.']);
  assert.ok(!fs.existsSync(join(root, CARRY)));
  const after = runRotation(changelog, root, [`--today=${TODAY}`, '--check']);
  assert.equal(after.code, 0);
  assert.ok(after.log[0].startsWith('[archive-changelog] OK \u2014 '));
}));

describe('spec:rotation-conservation/S9 issues skip only identical archived sections', () => {
  const footer = `\n---\n> ${issues.CANONICAL_FOOTER_NOTE}\n`;
  const countHeading = (text, heading) => text.split(/\r?\n/).filter((line) => line === heading).length;
  const withNote = (text) => text + footer + '\n' + makeIssue('002', false);
  for (const variant of ['LF', 'CRLF', 'archive note', 'known note', 'both notes']) it(`${variant}: identical sections skip; edited versions remain distinct`, () => {
    for (const edited of [true, false]) withRoot((root) => {
      const text = makeIssue('001');
      const original = variant === 'CRLF' ? text.replace(/\n/g, '\r\n') : text;
      const archived = parseSections(['archive note', 'both notes'].includes(variant) ? withNote(original) : original).slice(0, 1);
      const live = edited ? original.replace('body 001.', 'edited body.') : original;
      put(root, RESOLVED, issues.buildResolvedFile(null, archived, TODAY, 'fixture'));
      put(root, KNOWN, ['known note', 'both notes'].includes(variant) ? withNote(live) : live);
      assert.equal(runRotation(issues, root, [`--today=${TODAY}`]).code, 0);
      const result = read(root, RESOLVED);
      assert.equal(countHeading(result, archived[0].heading.trimEnd()), edited ? 2 : 1);
      assert.equal(countHeading(read(root, KNOWN), archived[0].heading.trimEnd()), 0);
      assert.ok(result.includes(original.trimEnd()));
      if (edited) assert.ok(result.includes(live.trimEnd()));
    });
  });
  it('hand-placed archive footer survives a failed known_issues publication and a duplicate-free retry', () => withRoot((root) => {
    const sectionA = makeIssue('001');
    const sectionB = makeIssue('002');
    put(root, RESOLVED, issues.buildResolvedFile(null, parseSections(sectionA), TODAY, 'fixture') + footer);
    put(root, KNOWN, sectionA + '\n' + sectionB);
    const recording = recordSeams((index, kind, args) => {
      if (kind === 'renameSync' && args[1] === join(root, KNOWN)) throw fault();
    });
    assertUnexpected(runRotation(issues, root, [`--today=${TODAY}`], recording.seams), 'archive-issues');
    assert.equal(runRotation(issues, root, [`--today=${TODAY}`]).code, 0);
    for (const section of parseSections(sectionA + '\n' + sectionB)) {
      assert.equal(countHeading(read(root, RESOLVED), section.heading), 1);
      assert.equal(countHeading(read(root, KNOWN), section.heading), 0);
    }
    const before = snapshot(root);
    assert.equal(runRotation(issues, root, [`--today=${TODAY}`]).code, 0);
    assert.deepEqual(snapshot(root), before);
  }));
});
