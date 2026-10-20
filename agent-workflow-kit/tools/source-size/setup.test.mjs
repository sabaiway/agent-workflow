// The layout setup over temp git trees: what a --check run judges and runCheck answering by it, the setup's
// closed answers on disk and through handed stubs, the core's bound form, and the --layout start's reach.
// Contract: docs/ai/specs/kit/source-size/index.md and its part setup.md.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hermeticGitEnv, withGitPath } from '../git-env.mjs';
import { INITIAL_ADOPTION_REASON, loadSourceSizeConfig } from '../source-size-config.mjs';
import { judgeTree, stopsOf } from '../source-size-judge.mjs';
import { checkReportLines, schema1StopLines, unmintedRefusalLines } from '../source-size-report.mjs';
import { main, runCheck } from '../source-size-check.mjs';

const { checkTargetOf, layoutSetupOf } = await import('./setup.mjs').catch(() => ({}));
const core = await import('../source-size-core.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-setup-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
// The fixtures' own git env: a hook-shaped ambient (location, index, prefix) stripped, host config pinned.
const ENV = withGitPath(hermeticGitEnv({ ...process.env, GIT_DIR: join(TMP, 'nowhere'), GIT_WORK_TREE: TMP, GIT_INDEX_FILE: join(TMP, 'index'), git_prefix: 'x/' }, TMP));
const DEPS = { env: ENV };

const NL = String.fromCharCode(10);
const R = 'recorded by hand';
const LEAD = 'source-size: --layout REFUSED — it starts the layout record and raises nothing else, but the record no longer holds for this tree, so that growth takes --write-baseline --reason first; nothing was written.';
const lines = (n) => `x${NL}`.repeat(n);
const many = (dir, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/f${i}.txt`, 'x']));
const git = (cwd, args) => ((r) => assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`))(spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }));
const writeTree = (cwd, files) => Object.entries(files).forEach(([rel, body]) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), body); });
const configPath = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
const project = ({ files = {}, config = null, raw = config && JSON.stringify(config, null, 2) } = {}) => {
  const cwd = mkdtempSync(join(TMP, 'p'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  writeTree(cwd, raw === null ? files : { ...files, 'docs/ai/source-size.json': raw });
  git(cwd, ['add', '-A']);
  return cwd;
};
// The work tree minus .git, as relative path → text.
const snapshot = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.name !== '.git')
  .flatMap((entry) => (entry.isDirectory() ? snapshot(join(dir, entry.name), base) : [[relative(base, join(dir, entry.name)), readFileSync(join(dir, entry.name), 'utf8')]]));
const cli = (cwd, ...args) => main([...args, '--cwd', cwd], { deps: DEPS });
const show = (result) => `${result.stdout}${NL}${result.stderr}`;
const readConfig = (cwd) => JSON.parse(readFileSync(configPath(cwd), 'utf8'));

const AUTH = { _README: 'fixture', schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'] };
const ONE = { 'src/a.mjs': lines(1) };
const MINTED = (over = {}) => ({ ...AUTH, baseline: {}, aggregate: { src: { lines: 1, reason: R } }, ...over });
const LAYOUT = (files) => ({ roots: { src: { files, reason: R } }, directories: {} });
const SCHEMA1 = { _README: 'fixture', schema: 1, defaults: { maxLines: 400, maxLineBytes: 1000 }, roots: ['src'], extensions: ['.mjs'], baseline: {}, aggregate: { src: { lines: 1, reason: R } } };
const storeRoot = (root) => ({ files: { [`${root}/a.mjs`]: lines(1) }, config: MINTED({ roots: [root], aggregate: { [root]: { lines: 1, reason: R } } }) });
let absentCache;
const absentConfigOf = () => (absentCache ??=runCheck({ cwd: project({ files: ONE }), deps: DEPS }).config);
const practiceOf = (reason) => ({ loadSourceSizeConfig, judgeTree, stopsOf, absentConfig: absentConfigOf(), reason });

describe('spec:source-size/S39 checkTargetOf states what a check judges and runCheck answers by it, its lines and exits unchanged', () => {
  const STATES = [
    ['a schema-1 config', { files: ONE, config: SCHEMA1 }, { stop: 'schema-1' }],
    ['an authored config', { files: ONE, config: AUTH }, { stop: 'unminted', state: 'authored', missing: ['baseline', 'aggregate'] }],
    ['an incomplete config', { files: ONE, config: { ...AUTH, baseline: {} } }, { stop: 'unminted', state: 'incomplete', missing: ['aggregate'] }],
    ['an absent config', { files: { ...ONE, ...many('src/wide', 22) } }, { stop: null, judged: { absent: true, layout: true } }],
    ['a minted config carrying layout', { files: ONE, config: MINTED({ layout: LAYOUT(1) }) }, { stop: null, judged: { absent: false, layout: true } }],
    ['a minted config without layout', { files: { ...ONE, 'src/big.mjs': lines(441) }, config: MINTED() }, { stop: null, judged: { absent: false, layout: false } }],
  ];
  for (const [what, fixture, expected] of STATES) {
    it(`${what}: ${expected.stop === null ? `the config to judge, absent ${expected.judged.absent} and layout ${expected.judged.layout}` : `the ${expected.stop} stop`}, and runCheck renders it as before`, () => {
      assert.equal(typeof checkTargetOf, 'function', 'setup.mjs exports checkTargetOf');
      const cwd = project(fixture);
      const absentConfig = absentConfigOf();
      const loaded = loadSourceSizeConfig(cwd, DEPS);
      const target = checkTargetOf({ loaded, absentConfig });
      const config = loaded.state === 'absent' ? absentConfig : loaded.config;
      assert.deepEqual(target, { ...expected, config });
      if (loaded.state === 'absent') assert.equal(target.config, absentConfig, 'the absent config is the one handed in');
      const run = runCheck({ cwd, deps: DEPS });
      assert.deepEqual(run.config, config);
      if (expected.stop === 'schema-1') assert.deepEqual([run.code, run.lines], [1, schema1StopLines(cwd)]);
      if (expected.stop === 'unminted') assert.deepEqual([run.code, run.lines], [1, unmintedRefusalLines(cwd, { state: expected.state, missing: expected.missing })]);
      if (expected.stop !== null) return;
      const verdict = judgeTree(cwd, config, DEPS, expected.judged);
      const before = [expected.judged, checkReportLines({ cwd, config, verdict, absent: expected.judged.absent }), stopsOf(verdict.findings).length === 0 ? 0 : 1];
      assert.deepEqual([run.judged, run.lines, run.code], before);
    });
  }
});

describe('spec:source-size/S40 layoutSetupOf answers one closed answer from the values it is handed, and the core binds it once', () => {
  const record = (...flags) => (reason) => ({ answer: 'record', args: ['--write-baseline', ...flags, '--reason', reason] });
  const held = (reason, extra = {}) => () => ({ answer: 'held', reason, ...extra });
  const armable = () => ({ answer: 'armable' });
  const ANSWERS = [
    ['an absent config with no stop', { files: ONE }, armable],
    ['an absent config holding a directory beyond its band', { files: { ...ONE, ...many('src/wide', 23) } }, record()],
    ['a minted schema-2 config carrying layout with no stop', { files: ONE, config: MINTED({ layout: LAYOUT(1) }) }, armable],
    ['a minted schema-2 config without layout whose check passes', { files: ONE, config: MINTED() }, record('--layout')],
    ['the same over the root .', { files: ONE, config: MINTED({ roots: ['.'], aggregate: { '.': { lines: 1, reason: R } } }) }, record('--layout')],
    ['a schema-1 config', { files: ONE, config: SCHEMA1 }, held('schema-1')],
    ['an authored config', { files: ONE, config: AUTH }, held('unminted')],
    ['an incomplete config', { files: ONE, config: { ...AUTH, aggregate: { src: { lines: 1, reason: R } } } }, held('unminted')],
    ['a config without layout declaring the root docs/ai/specs/x', storeRoot('docs/ai/specs/x'), held('store-root', { root: 'docs/ai/specs/x' })],
    ['a config without layout declaring the root docs/ai/specs', storeRoot('docs/ai/specs'), held('store-root', { root: 'docs/ai/specs' })],
    ['a minted config without layout whose check stops', { files: { ...ONE, 'src/big.mjs': lines(441) }, config: MINTED() }, held('stops')],
    ['a minted config carrying layout whose check stops', { files: { ...ONE, ...many('src/wide', 23) }, config: MINTED({ layout: LAYOUT(24) }) }, held('stops')],
  ];
  const fixtures = new Map();
  const fixtureOf = (what, fixture) => fixtures.get(what) ?? fixtures.set(what, project(fixture)).get(what);
  for (const [what, fixture, expected] of ANSWERS) {
    it(`${what}: ${JSON.stringify(expected('the handed reason'))}, writing nothing`, () => {
      assert.equal(typeof layoutSetupOf, 'function', 'setup.mjs exports layoutSetupOf');
      const [cwd, before] = ((dir) => [dir, snapshot(dir)])(fixtureOf(what, fixture));
      assert.deepEqual(layoutSetupOf(cwd, practiceOf('the handed reason'), DEPS), expected('the handed reason'));
      assert.deepEqual(snapshot(cwd), before, 'the setup writes nothing');
    });
  }

  it("throws on a malformed config, as the loader does, and so does the core's bound form", () => {
    assert.equal(typeof layoutSetupOf, 'function', 'setup.mjs exports layoutSetupOf');
    for (const raw of ['{ not json', JSON.stringify({ ...MINTED(), stray: true })]) {
      const cwd = project({ files: ONE, raw });
      assert.throws(() => layoutSetupOf(cwd, practiceOf(R), DEPS), /source-size/);
      assert.throws(() => core.readLayoutSetup(cwd, DEPS), /source-size/);
    }
  });

  it('reads only through the values it is handed: a root never created answers from stubs handed that root and those deps', () => {
    assert.equal(typeof layoutSetupOf, 'function', 'setup.mjs exports layoutSetupOf');
    assert.deepEqual(Object.keys(ENV).filter((key) => /^git_/i.test(key)).sort(), ['GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM']);
    const [root, deps, absentConfig] = [join(TMP, 'never-created'), { handed: true }, { schema: 2, roots: ['.'], layout: null }];
    const run = (loaded, findings) => {
      const calls = [];
      const answer = layoutSetupOf(root, {
        loadSourceSizeConfig: (...args) => { calls.push(['load', ...args]); return loaded; },
        judgeTree: (...args) => { calls.push(['judge', ...args]); return { findings }; },
        stopsOf: (given) => given.filter((finding) => finding === 'stop'), absentConfig, reason: 'stub reason',
      }, deps);
      for (const call of calls) assert.ok(call[1] === root && call.includes(deps), `${call[0]} is handed the root and the deps`);
      return { answer, calls: calls.map(([name]) => name) };
    };
    assert.deepEqual(run({ state: 'absent', config: null }, ['stop']), { answer: { answer: 'record', args: ['--write-baseline', '--reason', 'stub reason'] }, calls: ['load', 'judge'] });
    assert.deepEqual(run({ state: 'absent', config: null }, ['warn']), { answer: { answer: 'armable' }, calls: ['load', 'judge'] });
    const minted = (over) => ({ state: 'minted', config: { schema: 2, roots: ['src'], layout: null, ...over } });
    assert.deepEqual(run(minted({ layout: {} }), []).answer, { answer: 'armable' });
    assert.deepEqual(run(minted({ roots: ['docs/ai/specs/x'] }), []), { answer: { answer: 'held', reason: 'store-root', root: 'docs/ai/specs/x' }, calls: ['load'] });
    assert.deepEqual(run({ state: 'authored', config: { schema: 2 }, missingMachineKeys: ['baseline', 'aggregate'] }, []), { answer: { answer: 'held', reason: 'unminted' }, calls: ['load'] });
    assert.equal(existsSync(root), false, 'nothing reached the disk');
  });

  it('imports no file outside tools/source-size/', () => {
    const file = join(HERE, 'setup.mjs');
    assert.ok(existsSync(file), 'tools/source-size/setup.mjs exists');
    const specifiers = [...readFileSync(file, 'utf8').matchAll(/(?:from|import)[ (]*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const spec of specifiers) assert.ok(spec.startsWith('.') && resolve(HERE, spec).startsWith(`${HERE}${sep}`), `${spec} resolves outside tools/source-size/`);
  });

  it("readLayoutSetup of the core answers what layoutSetupOf answers handed the core's loader, judgeTree, stopsOf, runCheck's absent config and INITIAL_ADOPTION_REASON", () => {
    assert.equal(typeof core.readLayoutSetup, 'function', 'the core exports readLayoutSetup');
    assert.equal(typeof layoutSetupOf, 'function', 'setup.mjs exports layoutSetupOf');
    for (const [what, fixture] of ANSWERS) {
      const cwd = fixtureOf(what, fixture);
      assert.deepEqual(core.readLayoutSetup(cwd, DEPS), layoutSetupOf(cwd, practiceOf(INITIAL_ADOPTION_REASON), DEPS), what);
    }
  });
});

describe('spec:source-size/S42 a --layout start on a minted config raises the layout record and nothing else', () => {
  const wide = (n) => `${'y'.repeat(n)}${NL}`;
  const BASE = { 'src/a.mjs': lines(1), 'src/big.mjs': lines(450), 'src/wide.mjs': wide(1200) };
  const BASELINE = { 'src/big.mjs': { lines: 450, reason: R }, 'src/wide.mjs': { maxLineBytes: 1200, reason: R } };
  const CONFIG = MINTED({ baseline: BASELINE, aggregate: { src: { lines: 452, reason: R } } });
  const GROWTHS = [
    ['a file grown past its line record', { 'src/big.mjs': lines(460) }, 'src/big.mjs: lines 450 → 460 (raise)'],
    ['a file grown past its byte record', { 'src/wide.mjs': wide(1300) }, 'src/wide.mjs: maxLineBytes 1200 → 1300 (raise)'],
    ['a root grown past its aggregate', { 'src/new.mjs': lines(1) }, 'src: aggregate lines 452 → 453 (raise)'],
  ];
  const grown = (growth, config = CONFIG) => {
    const cwd = project({ files: BASE, config });
    assert.equal(cli(cwd, '--check').code, 0, 'the record holds before the tree grows');
    writeTree(cwd, growth);
    git(cwd, ['add', '-A']);
    return cwd;
  };
  for (const [what, growth, raise] of GROWTHS) {
    it(`${what}: --layout refuses, exit 1, byte-unchanged, naming the plain reasoned write, which records it; --layout then starts layout alone`, () => {
      const cwd = grown(growth);
      const before = readFileSync(configPath(cwd));
      const refused = cli(cwd, '--write-baseline', '--layout', '--reason', 'layout starts');
      assert.equal(refused.code, 1, show(refused));
      const said = refused.stdout.split(NL).map((line) => line.trim());
      assert.ok(said.includes(LEAD) && said.includes(raise), show(refused));
      assert.ok(refused.stdout.includes(`--write-baseline --cwd "${cwd}" --reason`), show(refused));
      assert.ok(!refused.stdout.includes('--layout --cwd') && !said.some((line) => line.includes(': files ')), 'the layout record is not the growth');
      assert.deepEqual(readFileSync(configPath(cwd)), before, 'nothing was written');
      const plain = cli(cwd, '--write-baseline', '--reason', 'grown');
      assert.ok(plain.code === 0 && plain.stdout.split(NL).map((line) => line.trim()).includes(raise), show(plain));
      const recorded = readConfig(cwd);
      assert.ok(!Object.hasOwn(recorded, 'layout') && JSON.stringify(recorded) !== JSON.stringify(JSON.parse(before)), 'the plain write records the growth');
      const started = cli(cwd, '--write-baseline', '--layout', '--reason', 'layout starts');
      assert.equal(started.code, 0, show(started));
      const { layout, ...rest } = readConfig(cwd);
      assert.deepEqual(rest, recorded, 'the start raises nothing but the layout record');
      assert.deepEqual(layout.directories, {});
      assert.deepEqual(Object.values(layout.roots).map((entry) => entry.reason), ['layout starts']);
    });
  }

  it('on an absent and on a layout-recording config the --layout write is the plain one, growth included', () => {
    for (const make of [() => project({ files: { ...BASE, ...many('src/wide', 23) } }), () => grown({ 'src/new.mjs': lines(1) }, { ...CONFIG, layout: LAYOUT(3) })]) {
      const [plain, flagged] = [make(), make()];
      const [plainRun, flaggedRun] = [cli(plain, '--write-baseline', '--reason', 'r'), cli(flagged, '--write-baseline', '--layout', '--reason', 'r')];
      assert.deepEqual([flaggedRun.code, plainRun.code], [0, 0], `${show(flaggedRun)}${NL}${show(plainRun)}`);
      assert.deepEqual(readFileSync(configPath(flagged)), readFileSync(configPath(plain)));
    }
  });
});
