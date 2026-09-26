// queue-seed.test.mjs — the queue seed and its create-only write on the tier offer's yes
// (docs/ai/specs/kit/tier/session-rules/, part queue-seed). Red first: the CLI rides the harness's
// dynamic import and the seed is read inside each cell.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_CONFIG, serializeConfig } from '../orchestration-config.mjs';
import { buildInsertPreview } from '../rules-regions.mjs';
import { failAt, makeProject, readinessOf, runOffer } from './harness.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..', '..');
const TOOL = join(HERE, '..', 'tier-preview.mjs');
const AUDIT = join(HERE, '..', 'queue-audit-cli.mjs');
const SEED = join(KIT, 'references', 'authoring', 'QUEUE_TEMPLATE.md');
const LF = String.fromCharCode(10);
const CONFIG = 'docs/ai/orchestration.json';
const STORE = 'docs/ai/epics';
const STORE_SEED = 'docs/ai/epics/.gitkeep';
const PLANS = 'docs/plans';
const QUEUE = 'docs/plans/queue.md';
const ID = 'named-queue-row-seed';
const CHECK_LINE = 'node <kit>/tools/queue-audit-cli.mjs --check docs/plans/queue.md --require-names';
const BUCKETS = ['### Now', '### Next', '### Later', '### Frozen'];
const NONE = readinessOf();
const EVERY_TARGET = { epic: { author: 'solo', review: 'solo' }, task: { author: 'solo', execute: 'solo' } };
const seed = (extra = {}) => serializeConfig({ ...SEED_CONFIG, ...extra });
const seedText = () => readFileSync(SEED, 'utf8');
const entryOf = (run) => run.lines.find((line) => line.startsWith(`${ID}: `));
const assertRefusal = (run, name) => {
  assert.equal(run.code, 1, run.stdout);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr.split(LF).length, 1, run.stderr);
  assert.match(run.stderr, new RegExp(`(?<![\\w-])${name}(?![\\w-])`));
};
// Reads the seed path once for real, then throws on every later read of it: the detector's read
// passes and the writer's read fails, the race the writer's own refusal answers.
const seedFailsAfterFirstRead = () => {
  let reads = 0;
  return {
    readFileSync: (path, ...rest) => {
      if (path === SEED && (reads += 1) > 1) throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      return readFileSync(path, ...rest);
    },
  };
};

describe('spec:session-rules/S9 the seed states the named row and holds no row', () => {
  it('ships as the authoring seed beside the epic and task templates, never among the deployed templates', () => {
    assert.ok(existsSync(SEED), 'references/authoring/QUEUE_TEMPLATE.md is absent');
    assert.ok(existsSync(join(KIT, 'references', 'authoring', 'EPIC_TEMPLATE.md')));
    assert.ok(!existsSync(join(KIT, 'references', 'templates', 'QUEUE_TEMPLATE.md')));
  });

  it('opens with a title and a blockquote preamble holding no list item', () => {
    const lines = seedText().split(LF);
    assert.match(lines[0], /^# \S/);
    const preamble = lines.slice(1, lines.indexOf('## Queue')).filter((line) => line.trim() !== '');
    assert.ok(preamble.length > 0, 'a preamble');
    for (const line of preamble) {
      assert.ok(line.startsWith('> '), line);
      assert.doesNotMatch(line.slice(2), /^\s*(?:[-*+]|\d+[.)])\s/, line);
    }
  });

  it('states the named row, the terminal-row purge with its archive, bucket order as priority and the check line', () => {
    const lines = seedText().split(LF);
    const preamble = lines.slice(1, lines.indexOf('## Queue')).map((line) => line.replace(/^> ?/, '')).join(' ');
    for (const re of [/plain sentence/, /ALL-CAPS id/, /terminal/, /closing artifact/, /gitignored/, /purge archive/,
      /queue-purge-cli\.mjs snapshot/, /priority/]) {
      assert.match(preamble, re);
    }
    assert.ok(preamble.includes(CHECK_LINE), preamble);
  });

  it('holds one Queue section with the four buckets in order and no row', () => {
    const lines = seedText().split(LF);
    assert.equal(lines.filter((line) => line === '## Queue').length, 1);
    const section = lines.slice(lines.indexOf('## Queue') + 1);
    assert.deepEqual(section.filter((line) => line.startsWith('#')), BUCKETS);
    assert.deepEqual(section.filter((line) => line.trim() !== '' && !line.startsWith('#')), []);
  });

  for (const window of [[], ['--section', '## Queue']]) {
    it(`passes the queue audit with --require-names ${window.length ? 'inside the Queue section' : 'over the whole file'}`, () => {
      const run = spawnSync(process.execPath, [AUDIT, '--check', SEED, '--require-names', ...window], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr || run.stdout);
    });
  }
});

describe('spec:session-rules/S10 --apply seeds docs/plans/queue.md create-only when the entry is offered', () => {
  it('previews the offer with its apply line and writes nothing', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } } });
    const run = await runOffer(root, [], NONE);
    assert.equal(run.code, 0, run.stderr);
    const at = run.lines.indexOf(`${ID}: offered`);
    assert.ok(at >= 0, run.stdout);
    assert.equal(run.lines[at + 1], `  apply: ${buildInsertPreview(root, TOOL)}`);
    assert.deepEqual(run.after, run.before);
  });

  for (const [name, files] of [['no docs/plans', {}], ['an empty docs/plans', { [PLANS]: { kind: 'directory' } }]]) {
    it(`writes the installed seed's bytes for ${name}, the parent created and verified`, async () => {
      const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' }, ...files } });
      const run = await runOffer(root, ['--apply'], NONE);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(entryOf(run), `${ID}: applied`);
      assert.ok(lstatSync(join(root, PLANS)).isDirectory());
      assert.deepEqual(readdirSync(join(root, PLANS)), ['queue.md']);
      assert.deepEqual(readFileSync(join(root, QUEUE)), readFileSync(SEED));
    });
  }

  it('changes no byte on a second --apply and reports the queue present', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } } });
    assert.equal((await runOffer(root, ['--apply'], NONE)).code, 0);
    const run = await runOffer(root, ['--apply'], NONE);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(run), `${ID}: present`);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.after, run.before);
  });

  it('reports present when a queue appears under the write, leaving it exactly as it is', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } } });
    const link = (from, to) => {
      writeFileSync(to, 'appeared');
      return linkSync(from, to);
    };
    const run = await runOffer(root, ['--apply'], { ...NONE, link });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(run), `${ID}: present`);
    assert.equal(readFileSync(join(root, QUEUE), 'utf8'), 'appeared');
  });

  it('refuses a docs/plans symlinked under the write, writing no queue through it', async () => {
    const { root, base } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } } });
    const plans = join(root, PLANS);
    const outside = join(base, 'outside-plans');
    // The detector probed docs/plans absent; the writer's first look finds a symlink placed since.
    const lstat = (path) => {
      if (path === plans && !existsSync(outside)) {
        mkdirSync(outside);
        symlinkSync(outside, plans);
      }
      return lstatSync(path);
    };
    const run = await runOffer(root, ['--apply'], { ...NONE, lstat });
    assertRefusal(run, 'write-failed');
    assert.deepEqual(readdirSync(outside), []);
  });

  it('refuses an installed seed unreadable at the write as seed-unreadable before any write', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const run = await runOffer(root, ['--apply'], { ...NONE, ...seedFailsAfterFirstRead() });
    assertRefusal(run, 'seed-unreadable');
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.after, run.before);
  });

  it('names every mutation already made when the seed write fails: the settings, the store seed and docs/plans', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const run = await runOffer(root, ['--apply'], { ...NONE, ...failAt(root, 'writeFile', QUEUE) });
    assertRefusal(run, 'write-failed');
    for (const made of [`${CONFIG} written`, `${STORE_SEED} created`, `${PLANS} created`]) {
      assert.ok(run.stderr.includes(made), `${made}: ${run.stderr}`);
    }
    assert.deepEqual(readdirSync(join(root, PLANS)), []);
  });

  it('names a store temp file left behind among the mutations made', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET) } });
    const deps = { ...NONE, ...failAt(root, 'rm', `${STORE_SEED}.`), ...failAt(root, 'writeFile', QUEUE) };
    const run = await runOffer(root, ['--apply'], deps);
    assertRefusal(run, 'write-failed');
    const leftover = readdirSync(join(root, STORE)).find((name) => name.endsWith('.tmp'));
    assert.ok(leftover, 'the store write left its temp file');
    assert.ok(run.stderr.includes(join(root, STORE, leftover)), run.stderr);
  });

  it('names no docs/plans when it stood before the failed write', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' }, [PLANS]: { kind: 'directory' } } });
    const run = await runOffer(root, ['--apply'], { ...NONE, ...failAt(root, 'writeFile', QUEUE) });
    assertRefusal(run, 'write-failed');
    assert.ok(!run.stderr.includes(`${PLANS} created`), run.stderr);
  });

  it('names only the earlier mutations when docs/plans cannot be created', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const run = await runOffer(root, ['--apply'], { ...NONE, ...failAt(root, 'mkdir', PLANS) });
    assertRefusal(run, 'write-failed');
    assert.ok(run.stderr.includes(`${CONFIG} written`), run.stderr);
    assert.ok(run.stderr.includes(`${STORE_SEED} created`), run.stderr);
    assert.ok(!run.stderr.includes(`${PLANS} created`), run.stderr);
    assert.equal(existsSync(join(root, PLANS)), false);
  });

  it('notes a queue temp file it could not remove with the queue path, the write standing', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } } });
    const run = await runOffer(root, ['--apply'], { ...NONE, ...failAt(root, 'rm', `${QUEUE}.`) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(run), `${ID}: applied`);
    const leftover = readdirSync(join(root, PLANS)).find((name) => name.endsWith('.tmp'));
    assert.ok(leftover, 'the queue write left its temp file');
    const notes = run.lines.filter((line) => line.includes(join(root, PLANS, leftover)));
    assert.equal(notes.length, 1);
    assert.ok(notes[0].startsWith(`${QUEUE}: `), notes[0]);
  });

  it('names the queue seed in the help', async () => {
    const loaded = await import('../tier-preview.mjs').catch(() => ({}));
    assert.equal(typeof loaded.main, 'function', 'tier-preview.mjs main is absent');
    assert.match(loaded.main(['--help']).stdout, /queue seed/);
  });
});
