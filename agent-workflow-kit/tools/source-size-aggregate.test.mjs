import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, makeLines as lines, runCli as run } from './source-size/cli-harness.test.mjs';
import { loadSourceSizeConfig, mintReasonOf, SOURCE_SIZE_DEFAULTS } from './source-size-core.mjs';
import { stripGitLocationEnv } from './git-env.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';
import { makeFixtureRepo } from '../../scripts/testing/fixture-repo.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-aggregate-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const { NODE_TEST_CONTEXT, ...TEST_ENV } = stripGitLocationEnv(process.env);
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));
const RUNNER = fileURLToPath(new URL('./run-gates.mjs', import.meta.url));
const REASON = 'The parser remains together while its extraction is scheduled.';
const CONFIG = (over = {}) => ({ _README: 'fixture', schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'], baseline: {}, ...over });
const configBytes = (cwd) => readFileSync(configPath(cwd), 'utf8');
const configOf = (cwd) => JSON.parse(configBytes(cwd));
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: TEST_ENV });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};
const project = ({ files = {}, config = CONFIG(), tracked = true } = {}) => {
  const cwd = mkdtempSync(join(TMP, 'p'));
  mkdirSync(join(cwd, 'docs/ai'), { recursive: true });
  if (tracked) makeFixtureRepo((args) => git(cwd, args), cwd, ['-q', '-b', 'main']);
  for (const [relativePath, body] of Object.entries(files)) {
    mkdirSync(join(cwd, relativePath, '..'), { recursive: true });
    writeFileSync(join(cwd, relativePath), body);
  }
  if (config !== null) writeFileSync(configPath(cwd), canonical(config));
  if (tracked) git(cwd, ['add', '-A']);
  return cwd;
};
const check = (cwd) => run(cwd, '--check');
const assertRun = (result, code = 0) => assert.deepEqual([result.code, result.stderr], [code, ''], result.stdout);
const schemaLine = (cwd, from, to = 3) => `source-size: ${configPath(cwd)} ${from === null ? `written at schema ${to}` : `moved from schema ${from} to schema ${to}`} in this write; a kit that predates schema ${to} stops by name until that copy is upgraded.`;
const schemaLines = (result) => result.stdout.split('\n').filter((line) => /(?:moved from|written at) schema/.test(line));
const warningLines = (result) => result.stdout.split('\n').filter((line) => line.startsWith('source-size: WARNING — '));
const aggregate = { src: { lines: 500, reason: 'old sum' }, retired: { lines: 900, reason: 'old sum' } };

describe('spec:source-size/S5 a per-file raise takes a reason and records it verbatim', () => {
  it('per-file-growth-needs-reason: a refusal changes no config bytes and a reason lands in the raised baseline entry', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(460) }, config: CONFIG({ baseline: { 'src/a.mjs': { lines: 441, reason: 'old record' } } }) });
    const before = configBytes(cwd);
    assertRun(run(cwd, '--write-baseline'), 1);
    assert.equal(configBytes(cwd), before);
    assertRun(run(cwd, '--write-baseline', '--reason', REASON));
    assert.deepEqual(configOf(cwd).baseline['src/a.mjs'], { lines: 460, reason: REASON });
    assert.deepEqual([configOf(cwd).schema, Object.hasOwn(configOf(cwd), 'aggregate')], [3, false]);
    assertRun(check(cwd));
  });
});

describe('spec:source-size/S68 regeneration writes schema 3 canonically and a schema move names earlier kits', () => {
  const cases = [
    ...[1, 2, 3].flatMap((schema) => ['schema1', 'schema2', 'project'].map((readme) => ['plain', schema, readme])),
    ['layout', 2, 'schema2'], ['absent', null, 'absent'], ['mint', 2, 'project'],
    ['adopt', 1, 'schema1'], ['override', 1, 'schema2'],
  ];
  for (const [mode, schema, readme] of cases) {
    it(`${mode} regeneration from schema ${schema} with ${readme} text writes schema 3, drops the sum and repeats the same bytes`, async () => {
      const { SCHEMA1_TEMPLATE_README, SCHEMA2_TEMPLATE_README, TEMPLATE_README } = await import('./source-size-report.mjs');
      assert.equal(typeof SCHEMA2_TEMPLATE_README, 'string');
      const text = { schema1: SCHEMA1_TEMPLATE_README, schema2: SCHEMA2_TEMPLATE_README, project: 'Keep this project text verbatim.' }[readme];
      const paths = ['z/p/q/r/s/t/u/b.mjs', 'a/p/q/r/s/t/u/a.mjs'];
      const baseline = Object.fromEntries(paths.map((path) => [path, { lines: 441, reason: REASON }]));
      const layout = {
        roots: { z: { files: 1, reason: REASON }, a: { files: 1, reason: REASON } },
        directories: { 'z/p/q/r/s/t/u': { depth: 6, reason: REASON }, 'a/p/q/r/s/t/u': { depth: 6, reason: REASON } },
      };
      const authored = { extensions: ['.mjs'], _README: text, schema, exclude: [], roots: ['z', 'a'] };
      const config = mode === 'absent' ? null : {
        ...authored,
        ...(schema === 1 ? { defaults: { ...SOURCE_SIZE_DEFAULTS } } : {}),
        ...(['mint', 'adopt'].includes(mode) ? {} : { baseline, aggregate: { z: { lines: 441, reason: REASON }, a: { lines: 441, reason: REASON } } }),
        ...(schema !== 1 && !['layout', 'mint', 'adopt'].includes(mode) ? { layout } : {}),
      };
      const files = Object.fromEntries(paths.map((path) => [path, lines(441)]));
      const cwd = project({ files: { ...files, 'docs/ai/.workflow-version': `${EXPECTED_WORKFLOW_VERSION}\n` }, config });
      const args = mode === 'adopt' ? ['--adopt'] : mode === 'override' ? ['--override', 'bytes-per-line', '--value', '1200'] : ['--write-baseline', ...(mode === 'layout' ? ['--layout'] : [])];
      const result = run(cwd, ...args, '--reason', REASON);
      assertRun(result);
      const written = configOf(cwd);
      assert.equal(written.schema, 3);
      assert.equal(Object.hasOwn(written, 'aggregate'), false);
      const expectedAuthored = mode === 'absent' ? ['_README', 'schema'] : [...Object.keys(authored), ...(mode === 'override' ? ['limits'] : [])];
      const hasLayout = mode === 'absent' || mode === 'layout' || (schema !== 1 && !['mint', 'adopt'].includes(mode));
      assert.deepEqual(Object.keys(written), [...expectedAuthored, 'baseline', ...(hasLayout ? ['layout'] : [])]);
      assert.equal(written._README, readme === 'project' ? text : TEMPLATE_README);
      for (const key of mode === 'absent' ? [] : ['extensions', 'exclude', 'roots']) assert.deepEqual(written[key], authored[key]);
      for (const map of [written.baseline, ...(hasLayout ? [written.layout.roots, written.layout.directories] : [])]) {
        assert.deepEqual(Object.keys(map), Object.keys(map).sort());
      }
      assert.equal(configBytes(cwd), canonical(written));
      assert.deepEqual(schemaLines(result), schema === 3 ? [] : [schemaLine(cwd, schema)]);
      const first = configBytes(cwd);
      const again = run(cwd, '--write-baseline');
      assertRun(again);
      assert.equal(configBytes(cwd), first);
      assert.deepEqual(schemaLines(again), []);
    });
  }
  for (const verb of ['--adopt', '--write-baseline']) {
    for (const hasAggregate of [true, false]) {
      it(`${verb} moves a minted schema-1 config verbatim onto ${hasAggregate ? 2 : 3} and renews its template`, async () => {
        const { SCHEMA1_TEMPLATE_README, SCHEMA2_TEMPLATE_README, TEMPLATE_README } = await import('./source-size-report.mjs');
        assert.equal(typeof SCHEMA2_TEMPLATE_README, 'string');
        const schema = hasAggregate ? 2 : 3;
        const baseline = { 'src/a.mjs': { lines: 441, reason: REASON } };
        const records = { baseline, ...(hasAggregate ? { aggregate } : {}) };
        const cwd = project({ files: { 'src/a.mjs': lines(460), 'docs/ai/.workflow-version': `${EXPECTED_WORKFLOW_VERSION}\n` }, config: CONFIG({ _README: SCHEMA1_TEMPLATE_README, schema: 1, defaults: { ...SOURCE_SIZE_DEFAULTS }, ...records }) });
        const result = run(cwd, verb);
        assertRun(result, 1);
        assert.equal(configBytes(cwd), canonical({ _README: hasAggregate ? SCHEMA2_TEMPLATE_README : TEMPLATE_README, schema, roots: ['src'], exclude: [], extensions: ['.mjs'], ...records }));
        assert.deepEqual(schemaLines(result), [schemaLine(cwd, 1, schema)]);
      });
    }
  }
});

describe('spec:source-size/S69 a deployed sum warns once, stops nothing and is dropped without a reason', () => {
  for (const schema of [2, 3]) {
    it(`a minted schema-${schema} sum warns once across roots, a green gate echoes it, and regeneration drops every recorded root`, () => {
      const gates = { gates: [{ id: 'source-size', title: 'Source size', cmd: `node "${TOOL}" --check` }] };
      const cwd = project({ files: { 'src/a.mjs': lines(260), 'src/b.mjs': lines(260), 'extra/a.mjs': lines(1), 'docs/ai/gates.json': canonical(gates) }, config: CONFIG({ schema, roots: ['src', 'extra'], aggregate }) });
      const warning = 'source-size: WARNING — "aggregate" records a line sum for 2 root(s), which the check no longer judges or records — the regeneration removes it'
        + (schema === 2 ? ' and writes schema 3, on which a kit that predates schema 3 stops by name until that copy is upgraded' : '');
      for (const result of [check(cwd), check(cwd)]) {
        assertRun(result);
        assert.deepEqual(warningLines(result).filter((line) => line.startsWith('source-size: WARNING — "aggregate"')), [warning]);
        assert.ok(result.stdout.includes(`node "${TOOL}" --write-baseline --cwd "${cwd}"`));
        assert.doesNotMatch(result.stdout.split('\n').filter((line) => !line.startsWith('source-size: NOTE — ')).join('\n'), /--reason|REVIEW FOCUS/);
        assert.doesNotMatch(result.stdout, /aggregate lines|NO recorded aggregate/);
      }
      const gate = spawnSync(process.execPath, [RUNNER, '--cwd', cwd], { encoding: 'utf8', env: TEST_ENV });
      assert.deepEqual([gate.status, gate.stderr], [0, ''], gate.stdout);
      const gateLines = gate.stdout.split('\n');
      assert.deepEqual(gateLines.filter((line) => line.startsWith('source-size: WARNING — "aggregate"')), [warning]);
      const pass = gateLines.findIndex((line) => /^\s+PASS /.test(line));
      assert.ok(pass >= 0 && gateLines.indexOf(warning) > pass, gate.stdout);
      assert.match(gate.stdout, /^source-size\s+PASS$/m);
      const written = run(cwd, '--write-baseline');
      assertRun(written);
      for (const [root, entry] of Object.entries(aggregate)) assert.ok(written.stdout.includes(`${root}: aggregate lines ${entry.lines} → none`), written.stdout);
      assert.deepEqual([configOf(cwd).schema, Object.hasOwn(configOf(cwd), 'aggregate')], [3, false]);
      assert.deepEqual(schemaLines(written), schema === 2 ? [schemaLine(cwd, 2)] : []);
      const settled = check(cwd);
      assertRun(settled);
      assert.deepEqual(warningLines(settled), []);
    });
    it(`a malformed schema-${schema} aggregate remains a config stop, exit 2`, () => {
      const cwd = project({ config: CONFIG({ schema, aggregate: { src: { lines: 10, maxLineBytes: 4000, reason: REASON } } }), tracked: false });
      const result = check(cwd);
      assertRun(result, 2);
      assert.match(result.stdout, /the aggregate budgets LINES only/);
    });
  }
  it('an absent config emits no deployed-sum warning', () => {
    const result = check(project({ files: { 'src/a.mjs': lines(1) }, config: null }));
    assertRun(result);
    assert.deepEqual(warningLines(result), []);
  });
});

describe('spec:source-size/S70 baseline alone decides MINTED and every other present config is AUTHORED', () => {
  for (const schema of [2, 3]) {
    it(`schema ${schema} with baseline and no aggregate is MINTED and judges the per-file record`, () => {
      const cwd = project({ files: { 'src/a.mjs': lines(442) }, config: CONFIG({ schema, baseline: { 'src/a.mjs': { lines: 441, reason: REASON } } }) });
      const loaded = loadSourceSizeConfig(cwd);
      assert.equal(loaded.state, 'minted');
      assert.equal(Object.hasOwn(loaded, 'missingMachineKeys'), false);
      const result = check(cwd);
      assertRun(result, 1);
      assert.match(result.stdout, /src\/a\.mjs: lines 442 exceeds its recorded baseline 441/);
      assert.doesNotMatch(result.stdout, /not yet MINTED|INCOMPLETE/);
    });
    for (const [state, machine, reason] of [
      ['aggregate-only', { aggregate }, 'initial adoption'],
      ['empty', {}, 'initial adoption'],
      ['layout-only', { layout: { roots: {}, directories: {} } }, '<why this size is accepted>'],
    ]) {
      it(`schema ${schema} ${state} is AUTHORED, holds no baseline and prints the core's mint reason`, () => {
        const config = CONFIG({ schema, baseline: undefined, ...machine });
        const cwd = project({ config, tracked: false });
        const loaded = loadSourceSizeConfig(cwd);
        assert.equal(loaded.state, 'authored');
        assert.equal(Object.hasOwn(loaded, 'missingMachineKeys'), false);
        assert.equal(mintReasonOf(loaded.config), reason);
        const result = check(cwd);
        assertRun(result, 1);
        const [verdict] = result.stdout.split('\n');
        assert.match(verdict, /^source-size: FAIL — .*AUTHORED but not yet MINTED/);
        assert.ok(verdict.includes('no "baseline"') && verdict.includes('per-file record'), verdict);
        assert.ok(result.stdout.includes(`--reason "${reason}"`), result.stdout);
        assert.deepEqual(warningLines(result), []);
      });
    }
    it(`schema ${schema} aggregate-only mint admits initial adoption for the baseline it creates`, () => {
      const cwd = project({ files: { 'src/a.mjs': lines(441) }, config: CONFIG({ schema, baseline: undefined, aggregate: { src: { lines: 0, reason: REASON } } }) });
      assertRun(run(cwd, '--write-baseline', '--reason', 'initial adoption'));
      assert.deepEqual(configOf(cwd).baseline, { 'src/a.mjs': { lines: 441, reason: 'initial adoption' } });
      assert.deepEqual([configOf(cwd).schema, Object.hasOwn(configOf(cwd), 'aggregate')], [3, false]);
    });
  }
  it('a schema-1 config with no baseline keeps the schema-1 stop', () => {
    const cwd = project({ config: CONFIG({ schema: 1, defaults: { ...SOURCE_SIZE_DEFAULTS }, baseline: undefined }), tracked: false });
    const result = check(cwd);
    assertRun(result, 1);
    assert.equal(result.stdout.split('\n')[0], `source-size: FAIL — ${configPath(cwd)} is schema 1, which the check no longer judges`);
    assert.ok(result.stdout.includes('--write-baseline moves it off schema 1 (a raise riding it still takes --reason)'));
  });
});
