// The engine-homed lens theme and the two new kit themes through the upgrade op rules.
// Contract: docs/ai/specs/kit/project-rules/rules-ensure.md.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL, LENS_FILE, NO_ENGINE, makeEngine } from '../../inject-methodology.test/engine-harness.test.mjs';
import { RECORD, load, makeProject, need, removeProject, sha, snapshot } from '../rules-harness.test.mjs';

const KIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENSURE_CLI = join(KIT_ROOT, 'tools', 'ensure-configs.mjs');
const RULES_CLI = join(KIT_ROOT, 'tools', 'project-rules', 'rules-cli.mjs');
const KIT_THEMES = ['project-layout', 'communication', 'story-sessions'];
const LENS = 'docs/ai/rules/lens.md';
const LENS_EFFECTIVE = 'docs/ai/rules/effective/lens.md';
const NOT_LAID = `${LENS}: not laid — no installed engine supplies the lens rules theme; install or refresh it with ${INSTALL}`;
const LEFT = `${LENS}: left as it is — no installed engine supplies the lens rules theme; install or refresh it with ${INSTALL}`;
const HOME = mkdtempSync(join(tmpdir(), 'engine-theme-home-'));
const roots = [];
after(() => [HOME, ...roots].forEach(removeProject));

const lensOf = (engine) => readFileSync(join(engine, LENS_FILE), 'utf8');
const entries = (root) => (existsSync(join(root, RECORD)) ? JSON.parse(readFileSync(join(root, RECORD), 'utf8')).themes : {});
const place = (root, rel, body) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
// run({ engine, root, deps }) → the op's outcome over root with the engine at engine, and the tree before it.
const run = async ({ engine = makeEngine(), root = makeProject(), deps = {} } = {}) => {
  if (!roots.includes(root)) roots.push(root);
  const ensureRules = need(await load('./index.mjs'), 'ensureRules');
  const before = snapshot(root);
  const outcome = ensureRules({ cwd: root, kitRoot: KIT_ROOT, dryRun: false, deps: { env: { AGENT_WORKFLOW_ENGINE_DIR: engine }, home: HOME, ...deps } });
  return { ...outcome, root, before, text: (rel) => readFileSync(join(root, rel), 'utf8') };
};
const kitLaid = (root) => KIT_THEMES.filter((name) => existsSync(join(root, `docs/ai/rules/effective/${name}.md`)) && name in entries(root));
const lensUnlaid = (root) => assert.deepEqual([existsSync(join(root, LENS)), existsSync(join(root, LENS_EFFECTIVE)), 'lens' in entries(root)], [false, false, false]);

describe('spec:project-rules/S28 an engine-homed theme through the op', () => {
  it('lens is seeded from the engine bytes, its effective copy and entry written', async () => {
    const engine = makeEngine();
    const result = await run({ engine });
    assert.deepEqual([result.token, result.text(LENS), result.text(LENS_EFFECTIVE), entries(result.root).lens?.kit], ['seeded', lensOf(engine), lensOf(engine), sha(lensOf(engine))]);
  });

  it('a known prior of lens is refreshed and any other body replaced, both to the engine bytes', async () => {
    const engine = makeEngine();
    const prior = '---\nmaxLines: 80\n---\n\n# Planning, review and process-fidelity invariants\n\n- An older bullet.\n';
    const priors = Object.freeze([Object.freeze({ theme: 'lens', release: '1.0.0', sha256: sha(prior) })]);
    const cells = [
      [prior, { priors }, `${LENS}: held the body an earlier release shipped — refreshed to the bundled template`],
      ['My own lens.\n', {}, `${LENS}: differs from every body this kit knows it shipped — replaced by the bundled template; a rule meant to last goes in docs/ai/rules/local/lens.md, where it wins`],
    ];
    for (const [body, deps, line] of cells) {
      const root = makeProject();
      await run({ engine, root });
      place(root, LENS, body);
      const result = await run({ engine, root, deps });
      assert.deepEqual([result.token, result.lines.includes(line), result.text(LENS), entries(root).lens?.kit], ['refreshed', true, lensOf(engine), sha(lensOf(engine))]);
    }
  });

  it('a valid engine lacking the lens template lays the other themes, writes nothing for lens and prints the not-laid line', async () => {
    const engine = makeEngine({ omit: ['lens'] });
    const first = await run({ engine });
    assert.deepEqual([first.token, kitLaid(first.root), first.lines.filter((line) => line.startsWith(LENS))], ['seeded', KIT_THEMES, [NOT_LAID]]);
    lensUnlaid(first.root);
    const second = await run({ engine, root: first.root });
    assert.deepEqual([second.token, second.lines.filter((line) => line.startsWith(LENS))], ['already-current', [NOT_LAID]]);
  });
});

describe('spec:project-rules/S29 an absent and an invalid engine leave lens unlaid; an unreadable or blank lens template fails the run', () => {
  it('an absent and an invalid engine lay the kit themes and leave lens unlaid with the not-laid line', async () => {
    for (const engine of [NO_ENGINE, makeEngine({ kind: 'not-an-engine' })]) {
      const result = await run({ engine });
      assert.deepEqual([result.token, kitLaid(result.root), result.lines.filter((line) => line.startsWith(LENS))], ['seeded', KIT_THEMES, [NOT_LAID]]);
      lensUnlaid(result.root);
    }
  });

  it('over a tree an earlier run laid lens in, an absent engine leaves lens byte-identical with the left-as-it-is line', async () => {
    const laid = await run();
    const lensBefore = [snapshot(laid.root).filter((line) => line.includes('lens.md')), entries(laid.root).lens];
    const result = await run({ engine: NO_ENGINE, root: laid.root });
    assert.deepEqual([result.lines.filter((line) => line.startsWith(LENS)), result.lines.some((line) => line.includes('not laid'))], [[LEFT], false]);
    assert.deepEqual([snapshot(laid.root).filter((line) => line.includes('lens.md')), entries(laid.root).lens], lensBefore);
    assert.notEqual(lensBefore[1], undefined, 'the earlier run laid lens');
    assert.equal(result.token, 'already-current');
  });

  it('a lens template present but unreadable, and one blank after trim, fail template-unreadable with nothing written', async (t) => {
    const engines = [makeEngine({ files: { [LENS_FILE]: '  \n\n' } })];
    if (process.getuid?.() === 0) t.diagnostic('running as root: the unreadable cell is not reachable');
    else engines.push(makeEngine({ unreadable: [LENS_FILE] }));
    for (const engine of engines) {
      const result = await run({ engine });
      assert.deepEqual([result.failed, result.token, result.lines[0].startsWith('template-unreadable — '), result.lines[0].includes(INSTALL)], [true, 'failed', true, true], result.lines[0]);
      assert.deepEqual(snapshot(result.root), result.before);
    }
  });
});

describe('spec:project-rules/S35 a new theme\'s unsafe path stops the run', () => {
  const wrongKind = (rel, reason) => `wrong-node-kind — ${rel}: ${reason} — nothing was read or written; resolve it by hand, then re-run`;
  const cells = [
    ['a symlink on the communication local file', (root) => {
      place(root, 'elsewhere.md', 'mine\n');
      mkdirSync(join(root, 'docs/ai/rules/local'), { recursive: true });
      symlinkSync(join(root, 'elsewhere.md'), join(root, 'docs/ai/rules/local/communication.md'));
    }, wrongKind('docs/ai/rules/local/communication.md', 'it is a symlink, not a regular file')],
    ['a directory on the story-sessions kit file', (root) => mkdirSync(join(root, 'docs/ai/rules/story-sessions.md'), { recursive: true }),
      wrongKind('docs/ai/rules/story-sessions.md', 'it is a directory, not a regular file')],
  ];
  for (const [label, prep, line] of cells) {
    it(`${label}: failed wrong-node-kind, nothing written, the configuration run exits non-zero`, async () => {
      const root = makeProject();
      prep(root);
      const result = await run({ root });
      assert.deepEqual([result.failed, result.lines[0]], [true, line]);
      assert.deepEqual(snapshot(root), result.before);
      const spawned = spawnSync(process.execPath, [ENSURE_CLI, '--reconcile', '--only', 'rules', '--cwd', root],
        { encoding: 'utf8', env: { ...process.env, AGENT_WORKFLOW_ENGINE_DIR: makeEngine() } });
      assert.notEqual(spawned.status, 0, spawned.stdout);
    });
  }
});

describe('spec:project-rules/S37 the spawned ensure with an engine lacking the lens template, then --check', () => {
  it('lays the three kit themes, exit 0, and --check answers absent for lens and current for the rest', () => {
    const root = makeProject();
    roots.push(root);
    const env = { ...process.env, AGENT_WORKFLOW_ENGINE_DIR: makeEngine({ omit: ['lens'] }) };
    const laid = spawnSync(process.execPath, [ENSURE_CLI, '--reconcile', '--only', 'rules', '--cwd', root], { encoding: 'utf8', env });
    assert.equal(laid.status, 0, `${laid.stdout}${laid.stderr}`);
    const checked = spawnSync(process.execPath, [RULES_CLI, '--check', '--cwd', root], { encoding: 'utf8', env });
    const lines = checked.stdout.split('\n');
    assert.equal(checked.status, 0, checked.stdout);
    assert.deepEqual([KIT_THEMES.filter((name) => lines.includes(`${name}: current`)), lines.some((line) => line.startsWith('lens: absent'))], [KIT_THEMES, true]);
  });
});

describe('spec:session-rules/S3 the rules op lays the communication and story-sessions themes', () => {
  it('seeds both from their templates, their effective copies carry the two rules, and a second run changes no byte', async () => {
    const first = await run();
    const template = (name) => readFileSync(join(KIT_ROOT, 'references', 'rules', `${name}.md`), 'utf8');
    const occurrences = (text, words) => text.split(words).length - 1;
    assert.deepEqual(['communication', 'story-sessions'].map((name) => [first.text(`docs/ai/rules/${name}.md`) === template(name), name in entries(first.root)]), [[true, true], [true, true]]);
    assert.equal(occurrences(first.text('docs/ai/rules/effective/communication.md'), '**Two blocks for the user.**'), 1);
    assert.equal(first.text('docs/ai/rules/effective/story-sessions.md').includes('only when it writes new tests or code'), true);
    const second = await run({ root: first.root });
    assert.deepEqual([second.token, snapshot(first.root)], ['already-current', second.before]);
  });
});
