import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANON_README, KNOWN_PRIOR_README, SEED_CONFIG, serializeConfig } from '../orchestration-config.mjs';
import { main as setRecipe } from '../set-recipe.mjs';
import { failAt, makeProject, readinessOf, runOffer } from './harness.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..', 'tier-preview.mjs');
const LINEAGE = JSON.parse(readFileSync(join(HERE, '..', '..', 'references', 'reference-profile.json'), 'utf8')).lineage;
const LF = String.fromCharCode(10);
const CONFIG = 'docs/ai/orchestration.json';
const RECORD = 'docs/ai/profile-declines.json';
const STORE = 'docs/ai/epics';
const SEED_FILE = 'docs/ai/epics/.gitkeep';
const RULES = 'docs/ai/agent_rules.md';
const CHECKER_LINE = 'checker-gates-declared: undecidable — declaration-absent';
const READY = readinessOf({ codex: 'ready', agy: 'ready', executor: 'placed' });
const NONE = readinessOf();
const EVERY_TARGET = { epic: { author: 'solo', review: 'solo' }, task: { author: 'solo', execute: 'solo' } };
const SLOT_LINE_RE = /^ {2}([a-z]+\.[a-z]+) = ([a-z]+)/;
const WRITE_PRIMITIVES = ['writeFile', 'rename', 'link', 'mkdir', 'rm'];
const seed = (extra = {}) => serializeConfig({ ...SEED_CONFIG, ...extra });
const record = (declined) => `${JSON.stringify({ schema: 1, declined }, null, 2)}${LF}`;
const bytesOf = (root, rel) => readFileSync(join(root, rel));
const rulesWithoutStory = () => readFileSync(join(HERE, '..', '..', 'references', 'templates', 'agent_rules.md'), 'utf8')
  .replace(/### 2\.7\. Story sessions\n.*\n\n/, '');
const entryOf = (run, id) => run.lines.find((line) => line.startsWith(`${id}: `));
const assertRefusal = (run, name) => {
  assert.equal(run.code, 1, run.stdout);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr.split(LF).length, 1, run.stderr);
  assert.match(run.stderr, new RegExp(`(?<![\\w-])${name}(?![\\w-])`));
};

describe('spec:tier-offer/S4 --apply writes the S3 items only', () => {
  for (const [name, readme, note] of [
    ['a seed config', CANON_README, CANON_README],
    ['a config with no note', undefined, CANON_README],
    ['a config whose note is a known prior canonical', KNOWN_PRIOR_README[0], CANON_README],
    ['a config whose note is customized', 'Our own note.', 'Our own note.'],
  ]) {
    it(`writes the bytes set-recipe writes for the same ops from ${name}`, async () => {
      const body = serializeConfig({ ...SEED_CONFIG, _README: readme });
      const { root } = makeProject({ files: { [CONFIG]: body } });
      const { root: twin } = makeProject({ files: { [CONFIG]: body } });
      const run = await runOffer(root, ['--apply'], READY);
      assert.equal(run.code, 0, run.stderr);
      const ops = run.lines.map((line) => line.match(SLOT_LINE_RE)).filter(Boolean)
        .flatMap(([, key, value]) => ['--set', `${key}=${value}`]);
      assert.equal(ops.length, 8);
      const written = setRecipe([...ops, '--write'], { cwd: twin, ...READY });
      assert.equal(written.code, 0, written.stderr);
      assert.deepEqual(bytesOf(root, CONFIG), bytesOf(twin, CONFIG));
      assert.equal(JSON.parse(bytesOf(root, CONFIG))._README, note);
    });
  }

  it('seeds the store as a directory holding one empty .gitkeep and writes nothing else', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(), [RULES]: rulesWithoutStory() } });
    const rulesBefore = bytesOf(root, RULES);
    const run = await runOffer(root, ['--apply'], READY);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(readdirSync(join(root, STORE)), ['.gitkeep']);
    assert.equal(bytesOf(root, SEED_FILE).length, 0);
    assert.deepEqual(bytesOf(root, RULES), rulesBefore);
    assert.deepEqual(readdirSync(join(root, 'docs', 'ai')).sort(), ['agent_rules.md', 'epics', 'orchestration.json']);
    assert.deepEqual(run.lines.slice(0, 2), ['story-sessions-section: offered', `  apply: node ${join(HERE, '..', 'rules-insert.mjs')} --cwd ${root}`]);
    assert.equal(entryOf(run, 'epic-task-slots'), 'epic-task-slots: applied');
    assert.equal(entryOf(run, 'epic-store-seeded'), 'epic-store-seeded: applied');
  });
});

describe('spec:tier-offer/S5 a second --apply, like a first with both items present, is a no-op', () => {
  it('writes nothing on the second run', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    assert.equal((await runOffer(root, ['--apply'], NONE)).code, 0);
    const run = await runOffer(root, ['--apply'], NONE);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.after, run.before);
    assert.deepEqual(run.lines.slice(1), ['epic-task-slots: present', 'epic-store-seeded: present', CHECKER_LINE]);
  });

  it('writes nothing when both items are present before the first run', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } } });
    const run = await runOffer(root, ['--apply'], READY);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.after, run.before);
  });
});

describe('spec:tier-offer/S6 --decline records every offered id at the shipped lineage', () => {
  it('records the offered ids, keeps the other entries, sorts by code unit and renames a temp file', async () => {
    const kept = { 'Zeta-upper': '1.0.0', 'epic-task-slots': LINEAGE, 'alpha-lower': '9.9.9' };
    const { root } = makeProject({ files: { [CONFIG]: seed(), [RECORD]: record(kept), [RULES]: rulesWithoutStory() } });
    const run = await runOffer(root, ['--decline'], NONE);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.lines, ['story-sessions-section: recorded', `epic-task-slots: declined — at lineage ${LINEAGE}`,
      'epic-store-seeded: recorded', CHECKER_LINE]);
    const expected = { 'Zeta-upper': '1.0.0', 'alpha-lower': '9.9.9', 'epic-store-seeded': LINEAGE,
      'epic-task-slots': LINEAGE, 'story-sessions-section': LINEAGE };
    assert.equal(bytesOf(root, RECORD).toString(), record(expected));
    const renames = run.writes.filter(([name]) => name === 'rename');
    assert.equal(renames.length, 1);
    assert.match(renames[0][1], /profile-declines\.json\.[^/]+\.tmp$/);
    assert.equal(renames[0][2], join(root, RECORD));
  });

  it('changes no byte on a second --decline and says nothing was recorded', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    assert.equal((await runOffer(root, ['--decline'], NONE)).code, 0);
    const recorded = bytesOf(root, RECORD);
    assert.equal(recorded.toString(), record({ 'epic-store-seeded': LINEAGE, 'epic-task-slots': LINEAGE }));
    const run = await runOffer(root, ['--decline'], NONE);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.after, run.before);
    assert.equal(run.lines.at(-1), 'nothing offered — nothing recorded');
  });

  it('writes no record when nothing is offered', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET), [STORE]: { kind: 'directory' } } });
    const run = await runOffer(root, ['--decline'], NONE);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.after, run.before);
    assert.deepEqual(run.lines, ['story-sessions-section: present', 'epic-task-slots: present', 'epic-store-seeded: present',
      CHECKER_LINE, 'nothing offered — nothing recorded']);
  });
});

describe('spec:tier-offer/S10 each refusal answers by its one name', () => {
  for (const [name, options, extraDeps] of [
    ['docs/ai absent', { docsAi: 'absent' }],
    ['docs/ai a symlink', { docsAi: 'symlink' }],
    ['docs/ai a regular file', { docsAi: 'file' }],
    ['a symlinked root', { link: 'root' }],
    ['a symlinked docs component', { link: 'docs' }],
    ['a failed lstat of docs/ai', {}, (root) => failAt(root, 'lstat', 'docs/ai')],
  ]) {
    for (const mode of [[], ['--apply'], ['--decline']]) {
      it(`refuses ${name} as no-deployment in ${mode[0] ?? 'preview'}`, async () => {
        const { root } = makeProject(options);
        const run = await runOffer(root, mode, { ...READY, ...(extraDeps ? extraDeps(root) : {}) });
        assertRefusal(run, 'no-deployment');
        assert.deepEqual(run.after, run.before);
      });
    }
  }

  for (const [refusal, bytes] of [['profile-unreadable', undefined], ['profile-malformed', '{"schema":1}']]) {
    it(`refuses a shipped profile as ${refusal}`, async () => {
      const { root, base } = makeProject({ files: { [CONFIG]: seed(), '../profile.json': bytes } });
      const run = await runOffer(root, ['--apply'], { ...READY, profilePath: join(base, 'profile.json') });
      assertRefusal(run, refusal);
      assert.deepEqual(run.after, run.before);
    });
  }

  for (const [refusal, spec] of [
    ['declines-symlink', { kind: 'symlink', text: record({}) }],
    ['declines-unreadable', { kind: 'directory' }],
    ['declines-malformed', '{"schema":1,"declined":[]}'],
  ]) {
    for (const mode of [[], ['--apply'], ['--decline']]) {
      it(`refuses a record as ${refusal} in ${mode[0] ?? 'preview'} and never overwrites it`, async () => {
        const { root } = makeProject({ files: { [CONFIG]: seed(), [RECORD]: spec } });
        const run = await runOffer(root, mode, READY);
        assertRefusal(run, refusal);
        assert.deepEqual(run.after, run.before);
      });
    }
  }

  it('withholds the store write when the config write fails', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const run = await runOffer(root, ['--apply'], { ...READY, ...failAt(root, 'rename', CONFIG) });
    assertRefusal(run, 'write-failed');
    assert.deepEqual(run.after, run.before);
  });

  it('names the config write and the created store directory when the seed write fails, with no rollback', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const configBefore = bytesOf(root, CONFIG);
    const run = await runOffer(root, ['--apply'], { ...READY, ...failAt(root, 'writeFile', SEED_FILE) });
    assertRefusal(run, 'write-failed');
    assert.ok(run.stderr.includes(CONFIG), run.stderr);
    assert.ok(run.stderr.includes(`${STORE} created`), run.stderr);
    assert.notDeepEqual(bytesOf(root, CONFIG), configBefore);
    assert.deepEqual(readdirSync(join(root, STORE)), []);
  });

  it('names only the config write when the store directory cannot be created', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const run = await runOffer(root, ['--apply'], { ...READY, ...failAt(root, 'mkdir', STORE) });
    assertRefusal(run, 'write-failed');
    assert.ok(run.stderr.includes(CONFIG), run.stderr);
    assert.ok(!run.stderr.includes(`${STORE} created`), run.stderr);
  });

  it('refuses a failed record write as write-failed', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const run = await runOffer(root, ['--decline'], { ...READY, ...failAt(root, 'rename', RECORD) });
    assertRefusal(run, 'write-failed');
    assert.deepEqual(run.after, run.before);
  });

  it('reports the store present when a .gitkeep appears under the seed write', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET) } });
    const link = (from, to) => {
      writeFileSync(to, 'appeared');
      return linkSync(from, to);
    };
    const run = await runOffer(root, ['--apply'], { ...READY, link });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(run, 'epic-store-seeded'), 'epic-store-seeded: present');
    assert.equal(bytesOf(root, SEED_FILE).toString(), 'appeared');
  });

  it('adds one line naming a temp file the seed write could not remove', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed(EVERY_TARGET) } });
    const run = await runOffer(root, ['--apply'], { ...READY, ...failAt(root, 'rm', `${SEED_FILE}.`) });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(entryOf(run, 'epic-store-seeded'), 'epic-store-seeded: applied');
    const leftovers = readdirSync(join(root, STORE)).filter((name) => name.endsWith('.tmp'));
    assert.equal(leftovers.length, 1);
    assert.equal(run.lines.filter((line) => line.includes(join(root, STORE, leftovers[0]))).length, 1);
  });
});

describe('spec:tier-offer/S11 usage is judged before any read; main returns and never asks', () => {
  const throwing = Object.fromEntries(['lstat', 'lstatSync', 'readFileSync', 'open', 'detect', 'surveyVehicle', ...WRITE_PRIMITIVES]
    .map((name) => [name, () => { throw new Error(`${name} was called`); }]));
  const loadMain = async () => {
    const loaded = await import('../tier-preview.mjs').catch(() => ({}));
    assert.equal(typeof loaded.main, 'function', 'tier-preview.mjs main is absent');
    return loaded.main;
  };
  for (const [name, argv] of [
    ['an unknown flag', ['--cwd', '/nowhere', '--force']],
    ['--apply given twice', ['--cwd', '/nowhere', '--apply', '--apply']],
    ['--cwd given twice', ['--cwd', '/nowhere', '--cwd', '/elsewhere']],
    ['a missing --cwd', ['--apply']],
    ['a --cwd with no value', ['--cwd']],
    ['--apply with --decline', ['--cwd', '/nowhere', '--apply', '--decline']],
    ['--help beside another flag', ['--help', '--apply']],
  ]) {
    it(`exits 2 for ${name} before any read`, async () => {
      const outcome = (await loadMain())(argv, throwing);
      assert.equal(outcome.code, 2, outcome.stderr);
      assert.equal(outcome.stdout, '');
      assert.equal(outcome.stderr.split(LF).length, 1);
    });
  }

  for (const flag of ['--help', '-h']) {
    it(`prints the help for ${flag} alone and exits 0 before any read`, async () => {
      const outcome = (await loadMain())([flag], throwing);
      assert.equal(outcome.code, 0);
      assert.match(outcome.stdout, /--cwd/);
      assert.equal(outcome.stderr, '');
    });
  }

  it('reaches the filesystem through the injected deps', async () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const run = await runOffer(root, [], { ...READY, lstat: () => { throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); } });
    assertRefusal(run, 'no-deployment');
  });

  it('never exits and never reads from the terminal', () => {
    const source = readFileSync(TOOL, 'utf8');
    assert.doesNotMatch(source, /process\.exit\(|process\.stdin|node:readline/);
  });

  it('runs as a command: a preview exits 0 and a usage error exits 2', () => {
    const { root } = makeProject({ files: { [CONFIG]: seed() } });
    const preview = spawnSync(process.execPath, [TOOL, '--cwd', root], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^story-sessions-section: present$/m);
    const usage = spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(usage.status, 2);
    assert.equal(usage.stdout, '');
  });
});
