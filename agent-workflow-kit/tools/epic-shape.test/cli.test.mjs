import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, lstatSync, rmSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { parseEpic } from '../epic-shape.mjs';
import { readRegularFileNoFollow } from '../fs-read-nofollow.mjs';

const load = () => import('../epic-shape-cli.mjs');
const ID = 'CLI-BOUNDARY';
const DATE = '2026-09-10';
const VERBS = ['--check', '--review-brief', '--fold', '--close'];
const LINK_REFUSALS = ['EPERM', 'EACCES', 'ENOTSUP'];
const FINDINGS = '# Findings\n- [P1] dir/file:12 \u2014 Intent is unclear.\n- dir/file:13 \u2014 Use `code`.\nClosing line.\n';
const makeText = ({ id = ID, storyState = `landed ${DATE}` } = {}) => `---
type: epic
lastUpdated: ${DATE}
scope: permanent
staleAfter: 90d
owner: caf\u00e9
maxLines: 60
state:  open  
---
# Epic: A visible boundary
## Intent
Keep the outcome clear.
## Value
Keep ownership visible.
## Non-goals
No implementation choices.
## Acceptance
Result line: ${DATE}
## Specs
docs/ai/specs/kit/example.md
## Stories ledger
- S1 | Describe the boundary | depends-on: none | owns: tools/example.mjs | shared: none | state: ${storyState}
## Queue
Row ${id} in Now
`;
const createFixture = (t, text = makeText()) => {
  const root = mkdtempSync(join(tmpdir(), 'epic-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const epics = join(root, 'docs/ai/epics');
  const plans = join(root, 'docs/plans');
  mkdirSync(epics, { recursive: true });
  mkdirSync(plans, { recursive: true });
  const epic = join(epics, `${ID}.md`);
  const queue = join(plans, 'queue.md');
  const findings = join(root, 'findings.txt');
  writeFileSync(epic, text);
  writeFileSync(queue, '# Queue\n## Now\n## Later\n');
  writeFileSync(findings, FINDINGS);
  writeFileSync(join(root, 'keep.bin'), Buffer.from([0, 255, 1, 128]));
  return { root, epics, epic, queue, findings };
};
const snapshotTree = (root, dir = root) => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  const key = relative(root, path);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return [{ path: key, kind: 'symlink', target: readlinkSync(path) }];
  if (stats.isDirectory()) return [{ path: key, kind: 'directory' }, ...snapshotTree(root, path)];
  return [{ path: key, kind: 'file', bytes: readFileSync(path) }];
});
const createLink = (t, link, target, path) => {
  try { link(target, path); return true; }
  catch (error) {
    if (!LINK_REFUSALS.includes(error.code)) throw error;
    t.diagnostic(`sandbox refused ${link.name}: ${error.code}: ${path}`);
    return false;
  }
};
const loadRules = async () => {
  const rules = await load().catch((error) => {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
    return {};
  });
  assert.equal(typeof rules.main, 'function', 'the CLI module must export main');
  return rules;
};
const run = (main, argv, io = {}) => {
  const out = [];
  const err = [];
  const code = main(argv, { ...io, log: (text) => out.push(text), error: (text) => err.push(text) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('epic CLI', () => {
  it('spec:epic-shape/S12 closes in place changing only header state bytes and refuses a second hard link', async (t) => {
    const { main } = await loadRules();
    for (const text of [makeText(), makeText().replaceAll('\n', '\r\n'), makeText().trimEnd()]) {
      const fixture = createFixture(t, text);
      const before = snapshotTree(fixture.root);
      const original = readFileSync(fixture.epic);
      const identity = lstatSync(fixture.epic);
      const range = parseEpic(text, fixture.epic).stateRange;
      const expected = Buffer.concat([original.subarray(0, range.start), Buffer.from('landed'), original.subarray(range.end)]);
      const result = run(main, ['--close', fixture.epic]);
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /epic-shape: accept/);
      assert.deepEqual(snapshotTree(fixture.root), before.map((entry) => entry.path === relative(fixture.root, fixture.epic)
        ? { ...entry, bytes: expected } : entry));
      assert.equal(lstatSync(fixture.epic).ino, identity.ino, 'close must preserve the inode');
      assert.equal(lstatSync(fixture.epic).dev, identity.dev);
      assert.deepEqual(readFileSync(fixture.epic), expected);
    }
    const fixture = createFixture(t);
    const alias = join(fixture.root, 'hardlink.txt');
    if (createLink(t, linkSync, fixture.epic, alias)) {
      const before = snapshotTree(fixture.root);
      const result = run(main, ['--close', fixture.epic]);
      assert.equal(result.code, 1);
      assert.match(result.err, /epic-shape: .*hard.?link|epic-shape: .*hard link/);
      assert.deepEqual(snapshotTree(fixture.root), before);
    }
    for (const queue of [null, '- **CLI-BOUNDARY**\n', '* Unread queue row\n']) {
      const blocked = createFixture(t);
      if (queue === null) rmSync(blocked.queue);
      else writeFileSync(blocked.queue, queue);
      const before = snapshotTree(blocked.root);
      const result = run(main, ['--close', blocked.epic]);
      assert.equal(result.code, 1);
      assert.ok(result.err.includes(blocked.queue));
      assert.deepEqual(snapshotTree(blocked.root), before);
    }
  });

  it('spec:epic-shape/S15 closes argv to one verb and positional or bare help with exits zero one two', async (t) => {
    const { main } = await loadRules();
    const fixture = createFixture(t);
    const reads = [];
    const read = (path, options) => { reads.push(path); return readRegularFileNoFollow(path, options); };
    const before = snapshotTree(fixture.root);
    const invalid = [[], ['--unknown'], ['--unknown', fixture.epic], [fixture.epic], ['-h'], ['--help', '--help'],
      ['--help', fixture.epic], [fixture.epic, '--check'], ['--check', '--', fixture.epic],
      ...VERBS.flatMap((verb) => [[verb], [verb, '-epic.md'], [verb, ''], [verb, fixture.epic, fixture.epic],
        [verb, fixture.epic, '--close', fixture.epic], [verb, fixture.epic, '--help'], ['--help', verb, fixture.epic],
        [verb, '--fold'], [verb, fixture.epic, '--unknown']])];
    for (const argv of invalid) {
      const result = run(main, argv, { read });
      assert.equal(result.code, 2, JSON.stringify(argv));
      assert.match(result.err, /^epic-shape:/);
    }
    const help = run(main, ['--help'], { read });
    assert.equal(help.code, 0);
    for (const verb of VERBS) assert.ok(help.out.includes(verb));
    assert.deepEqual(reads, []);
    assert.deepEqual(snapshotTree(fixture.root), before);
    assert.equal(run(main, ['--check', fixture.epic]).code, 0);
    const absent = run(main, ['--check', join(fixture.epics, 'absent.md')]);
    assert.equal(absent.code, 1);
    assert.match(absent.err, /^epic-shape: .*:1: read:/);
  });

  it('spec:epic-shape/S16 keeps all read-only paths identical and sweeps direct entries through no-follow reads', async (t) => {
    const { main } = await loadRules();
    const refused = createFixture(t, makeText().replace('Keep the outcome clear.', 'Use `code`.'));
    const result = run(main, ['--review-brief', refused.epic]);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.out, /# Epic review:/);
    assert.match(result.err, /epic-shape: .*:\d+: altitude:/);
    assert.deepEqual([result.err.match(/epic-shape: .*:\d+: altitude:/g).length,
      /epics read 1; entries skipped 0/.test(result.err)], [1, true]);
    const fixture = createFixture(t, makeText({ storyState: 'planned' }));
    const nested = join(fixture.epics, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'HIDDEN.md'), '---\ntype: epic\nstate: unreadable\n');
    writeFileSync(join(fixture.epics, 'notes.md'), '# Notes\n');
    const before = snapshotTree(fixture.root);
    const reads = [];
    const read = (path, options) => { reads.push(path); return readRegularFileNoFollow(path, options); };
    for (const verb of ['--check', '--review-brief', '--fold']) {
      const path = verb === '--fold' ? fixture.findings : fixture.epic;
      const result = run(main, [verb, path], { read });
      assert.equal(result.code, 0, result.err);
      assert.deepEqual(snapshotTree(fixture.root), before);
      if (verb === '--fold') {
        assert.match(result.out, /kept \(1\)/);
        assert.match(result.out, /discarded \(1\)/);
        assert.match(result.out, /outside \(2\)/);
        assert.match(result.out, /backtick/);
      } else {
        assert.ok((result.out + result.err).includes(fixture.epics));
        assert.match(result.out + result.err, /epics read 1/);
        assert.match(result.out + result.err, /entries skipped 2/);
        if (verb === '--review-brief') assert.match(result.out, /# Epic review: CLI-BOUNDARY \(open\)/);
      }
    }
    assert.ok(reads.includes(fixture.epic));
    assert.ok(reads.includes(join(fixture.epics, 'notes.md')));
    assert.ok(reads.every((path) => !path.startsWith(`${nested}${sep}`)));
    const sibling = join(fixture.epics, 'notes.md');
    const readUnreadableSibling = (path, options) => path === sibling
      ? { outcome: 'error', code: 'EACCES' } : readRegularFileNoFollow(path, options);
    const unreadable = run(main, ['--check', fixture.epic], { read: readUnreadableSibling });
    assert.equal(unreadable.code, 1);
    assert.ok(unreadable.err.includes(sibling));
    assert.match(unreadable.err, /sibling-read: unreadable: EACCES/);
    assert.deepEqual(snapshotTree(fixture.root), before);
    const target = join(fixture.root, 'target.txt');
    const alias = join(fixture.epics, 'ALIAS.md');
    writeFileSync(target, makeText({ id: 'ALIAS' }));
    if (createLink(t, symlinkSync, target, alias)) {
      const linked = snapshotTree(fixture.root);
      for (const verb of ['--check', '--review-brief', '--close']) {
        const result = run(main, [verb, fixture.epic]);
        assert.equal(result.code, 1);
        assert.ok(result.err.includes(alias));
        assert.match(result.err, /symlink/);
        assert.deepEqual(snapshotTree(fixture.root), linked);
      }
      for (const verb of VERBS) {
        const result = run(main, [verb, alias]);
        assert.equal(result.code, 1);
        assert.ok(result.err.includes(alias));
        assert.deepEqual(snapshotTree(fixture.root), linked);
      }
    }
  });
});
