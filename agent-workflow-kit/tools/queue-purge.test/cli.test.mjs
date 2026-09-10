import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, linkSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const load = () => import('../queue-purge-cli.mjs');
const CLI = fileURLToPath(new URL('../queue-purge-cli.mjs', import.meta.url));
const SECTION = '## Inbox';
const TEXT = '## Inbox\n- **CLI-ROW** Body.\n';
const createFixture = (t, text = TEXT) => {
  const dir = mkdtempSync(join(tmpdir(), 'purge-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queue = join(dir, 'queue.md');
  const archive = join(dir, 'archive.txt');
  writeFileSync(queue, text);
  return { dir, queue, archive };
};
const run = async (argv) => {
  const out = [];
  const err = [];
  const code = (await load()).main(argv, { log: (text) => out.push(text), error: (text) => err.push(text) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};
const makeArgs = (verb, { queue, archive }, section = SECTION) => [verb, queue, '--section', section, '--archive', archive];

describe('queue-purge CLI', () => {
  // spec:queue-purge/S9
  it('has only accept/refuse/usage and rejects repeated options, positionals, verbs, mixed help and missing values', async (t) => {
    const fixture = createFixture(t);
    const args = makeArgs('snapshot', fixture);
    for (const argv of [[], ['--wat'], ['snapshot'], ['--check'], ['--section', SECTION],
      [...args, '--archive', fixture.archive], [...args, '--section', SECTION], [...args, fixture.queue],
      [...args, 'snapshot', fixture.queue], [...args, '--check', fixture.queue], [...args, '--help'],
      ['-h', ...args], [...args, '-h'], ['--help', '--help'],
      ['snapshot', fixture.queue, '--section'], ['snapshot', fixture.queue, '--archive'],
      ['snapshot', fixture.queue, '--section', '--archive', fixture.archive],
      ['snapshot', fixture.queue, '--section', '', '--archive', fixture.archive],
      ['snapshot', fixture.queue, '--section', '-h', '--archive', fixture.archive]]) {
      assert.equal((await run(argv)).code, 2, JSON.stringify(argv));
    }
    for (const flag of ['--help', '-h']) assert.equal((await run([flag])).code, 0);
    assert.equal((await run(args)).code, 0);
    assert.equal((await run(makeArgs('--check', fixture))).code, 1);
    writeFileSync(fixture.queue, TEXT.replace('Body.', 'Trim.'));
    assert.equal((await run(makeArgs('--check', fixture))).code, 0);
    const child = spawnSync(process.execPath, [CLI, '--check', fixture.queue, '--section', SECTION,
      '--archive', fixture.archive], { encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /accept/);
  });

  // spec:queue-purge/S10
  it('refuses absent or duplicate headings in either verb and accepts closing runs canonically', async (t) => {
    const fixture = createFixture(t);
    assert.equal((await run(makeArgs('snapshot', fixture))).code, 0);
    for (const verb of ['snapshot', '--check']) {
      const absent = await run(makeArgs(verb, fixture, '## Missing'));
      assert.equal(absent.code, 2);
      assert.match(absent.err, /## Missing/);
      writeFileSync(fixture.queue, TEXT + '\n## Inbox ##\n');
      const twice = await run(makeArgs(verb, fixture));
      assert.equal(twice.code, 2);
      assert.match(twice.err, /2 section headings/);
      writeFileSync(fixture.queue, TEXT);
    }
    assert.equal((await run(makeArgs('--check', fixture, '## Inbox ##'))).code, 1);
    writeFileSync(fixture.queue, TEXT.replace('## Inbox', '## Inbox ##'));
    assert.equal((await run(makeArgs('--check', fixture))).code, 0);
  });

  // spec:queue-purge/S11
  it('requires archive and section in both verbs and creates no neighbouring default file', async (t) => {
    const fixture = createFixture(t);
    for (const verb of ['snapshot', '--check']) {
      const noArchive = await run([verb, fixture.queue, '--section', SECTION]);
      assert.equal(noArchive.code, 2);
      assert.match(noArchive.err, /--archive/);
      const noSection = await run([verb, fixture.queue, '--archive', fixture.archive]);
      assert.equal(noSection.code, 2);
      assert.match(noSection.err, /--section/);
    }
    assert.deepEqual(readdirSync(fixture.dir), ['queue.md']);
  });

  // spec:queue-purge/S13
  it('keeps queue bytes identical, writes only the archive on snapshot and writes nothing on check', async (t) => {
    const fixture = createFixture(t, '## Inbox\r\n- **No key** caf\u00e9.\r\n');
    const before = readFileSync(fixture.queue);
    const snapshot = await run(makeArgs('snapshot', fixture));
    assert.equal(snapshot.code, 0);
    assert.match(snapshot.out, /1 rows/);
    assert.match(snapshot.out, new RegExp(`${before.length} section bytes`));
    assert.match(snapshot.err, /1 keyless/);
    assert.deepEqual(readFileSync(fixture.queue), before);
    assert.deepEqual(readdirSync(fixture.dir), ['archive.txt', 'queue.md']);
    const archived = readFileSync(fixture.archive);
    const check = await run(makeArgs('--check', fixture));
    assert.equal(check.code, 1);
    assert.match(check.err, /not moved/);
    assert.match(check.err, /keyless entry/);
    assert.deepEqual(readFileSync(fixture.queue), before);
    assert.deepEqual(readFileSync(fixture.archive), archived);
    assert.deepEqual(readdirSync(fixture.dir), ['archive.txt', 'queue.md']);
  });

  // spec:queue-purge/S14
  it('handles archive existence, type, grammar and section selection without guessing', async (t) => {
    const fixture = createFixture(t);
    const missing = await run(makeArgs('--check', fixture));
    assert.equal(missing.code, 2);
    assert.ok(missing.err.includes(fixture.archive));
    assert.deepEqual(readdirSync(fixture.dir), ['queue.md']);
    writeFileSync(fixture.archive, '');
    assert.equal((await run(makeArgs('--check', fixture))).code, 2);
    assert.equal((await run(makeArgs('snapshot', fixture))).code, 0);
    const other = join(fixture.dir, 'other.txt');
    writeFileSync(fixture.queue, TEXT + '## Other\n');
    assert.equal((await run(makeArgs('snapshot', { ...fixture, archive: other }, '## Other'))).code, 0);
    const noBlock = await run(makeArgs('--check', { ...fixture, archive: other }));
    assert.equal(noBlock.code, 2);
    assert.match(noBlock.err, /## Inbox/);
    assert.match(noBlock.err, /## Other/);
    const folder = join(fixture.dir, 'folder');
    mkdirSync(folder);
    const foreign = join(fixture.dir, 'handwritten.txt');
    writeFileSync(foreign, '- **Row** archived by hand\n  Original prose.\n');
    const alias = join(fixture.dir, 'alias.txt');
    symlinkSync(fixture.archive, alias);
    for (const verb of ['snapshot', '--check']) {
      for (const archive of [folder, join(fixture.dir, 'absent', 'archive.txt'), alias]) {
        const result = await run(makeArgs(verb, { ...fixture, archive }));
        assert.equal(result.code, 2);
        assert.ok(result.err.includes(archive));
      }
      const result = await run(makeArgs(verb, { ...fixture, archive: foreign }));
      assert.equal(result.code, 2);
      assert.match(result.err, /foreign.*line 1/);
    }
  });

  // spec:queue-purge/S17
  it('rejects the queue as an archive by path, symlink or hard link, preserving every byte', async (t) => {
    const fixture = createFixture(t);
    const hard = join(fixture.dir, 'hard.txt');
    const soft = join(fixture.dir, 'soft.txt');
    linkSync(fixture.queue, hard);
    symlinkSync(fixture.queue, soft);
    const before = readFileSync(fixture.queue);
    for (const verb of ['snapshot', '--check']) {
      for (const archive of [fixture.queue, hard, soft]) {
        const result = await run(makeArgs(verb, { ...fixture, archive }));
        assert.equal(result.code, 2);
        assert.ok(result.err.includes(archive));
        assert.match(result.err, /queue/);
        assert.deepEqual(readFileSync(fixture.queue), before);
      }
    }
  });
});
