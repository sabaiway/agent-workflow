import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sourceSizeCandidate } from '../gates-init.mjs';
import {
  INITIAL_ADOPTION_REASON, SOURCE_SIZE_WHY, escapeForLine, readLayoutSetup,
  validateSourceSizeConfig,
} from '../source-size-core.mjs';
import { SOURCE_SIZE_TOOL_PATH } from '../source-size-gate-cmd.mjs';
import { GROWTH_REASON_PLACEHOLDER } from '../source-size-report.mjs';
import { EXPECTED_WORKFLOW_VERSION } from '../velocity-profile.mjs';
import { configPath, createProject, makeLines, makeMany, readBlock, runCli } from './cli-harness.test.mjs';

const AUTHORED = { schema: 2, roots: ['src'], extensions: ['.mjs'] };
const RECORDED_REASON = 'recorded by hand';
const BIG_LINES = 441;
const GROWN_LINES = 450;
const BIG_FILES = { 'src/big.mjs': makeLines(BIG_LINES) };
const GROWN_FILES = { 'src/big.mjs': makeLines(GROWN_LINES) };
const BASELINE = { 'src/big.mjs': { lines: BIG_LINES, reason: RECORDED_REASON } };
const AGGREGATE = { src: { lines: BIG_LINES, reason: RECORDED_REASON } };
const MINTED = { ...AUTHORED, baseline: BASELINE, aggregate: AGGREGATE };
const WIDE_FILES = { 'src/a.mjs': makeLines(1), ...makeMany('src/wide', 23) };
const LAYOUT = {
  roots: { src: { files: 20, reason: RECORDED_REASON } },
  directories: { 'src/wide': { entries: 23, reason: RECORDED_REASON } },
};
const AUTHORED_LAYOUT = { ...AUTHORED, layout: LAYOUT };
const WHY = `source-size: WHY — ${SOURCE_SIZE_WHY}`;
const FAIL = 'source-size: FAIL — ';
const REFUSAL_LEAD = `source-size: REFUSED — --reason "${INITIAL_ADOPTION_REASON}" is the kit's own sentence, true only of a record half this write creates, and this regeneration RAISES `;
const LAYOUT_GROWTH_LEAD = 'source-size: --layout REFUSED — it starts the layout record and raises nothing else, but the record no longer holds for this tree, so that growth takes --write-baseline --reason first; no record was regenerated.';
const OVERRIDE_DEFECT = '--override takes its own reason — "initial adoption" is the kit\'s sentence for a record\'s first entries, and an override is a reasoned change of a kit number';
const OVERRIDE_ARGS = ['--override', 'lines-per-file', '--value', '500'];
const REASON_MODES = [['--write-baseline'], ['--adopt'], OVERRIDE_ARGS];
const MINT_COMMAND = (cwd, reason) => `node "${SOURCE_SIZE_TOOL_PATH}" --write-baseline --cwd "${cwd}" --reason "${reason}"`;
const GATES_PATH = (cwd) => join(cwd, 'docs', 'ai', 'gates.json');
const readBytes = (path) => existsSync(path) ? readFileSync(path) : null;
const readConfig = (cwd) => JSON.parse(readFileSync(configPath(cwd), 'utf8'));
const readSnapshot = (cwd) => [readBytes(configPath(cwd)), readBytes(GATES_PATH(cwd))];
const assertUnchanged = (cwd, before) => assert.deepEqual(readSnapshot(cwd), before, 'config and gates stay byte-unchanged');
const assertExit = (result, code) => assert.deepEqual([result.code, result.stderr], [code, ''], result.stdout);
const assertKitRefusal = (fixture, args, count, deltas) => {
  const cwd = createProject(fixture);
  const before = readSnapshot(cwd);
  const result = runCli(cwd, ...args, '--reason', INITIAL_ADOPTION_REASON);
  assertExit(result, 1);
  assertUnchanged(cwd, before);
  const lines = result.stdout.split('\n');
  const refusal = `${REFUSAL_LEAD}${count} value(s) in a half the config already holds. The whole old→new it would write:`;
  assert.ok(lines.includes(refusal), result.stdout);
  assert.deepEqual(lines.slice(lines.indexOf(refusal)), [
    refusal, ...deltas.map((delta) => `  ${delta}`),
    `  ${MINT_COMMAND(cwd, GROWTH_REASON_PLACEHOLDER)}`, WHY,
  ]);
};
const assertUsageRefusal = (args, reason, message) => {
  const cwd = createProject({ files: BIG_FILES, config: MINTED });
  const before = readSnapshot(cwd);
  const result = runCli(cwd, ...args, '--reason', reason);
  assertExit(result, 2);
  assertUnchanged(cwd, before);
  assert.equal(result.stdout.split('\n')[0], FAIL + escapeForLine(message));
  assert.doesNotMatch(result.stdout, /^source-size: limit /m);
};

describe('spec:source-size/S62 the kit sentence belongs only to new halves and placeholders are never command reasons', () => {
  it('absent config: a directory beyond its band is recorded with the kit sentence', () => {
    const cwd = createProject({ files: makeMany('wide', 23) });
    assert.equal(existsSync(configPath(cwd)), false);
    assertExit(runCli(cwd, '--write-baseline', '--reason', INITIAL_ADOPTION_REASON), 0);
    assert.deepEqual(readConfig(cwd).layout.directories.wide, { entries: 23, reason: INITIAL_ADOPTION_REASON });
  });

  it('authored config without a machine half: first records take the kit sentence', () => {
    const cwd = createProject({ files: BIG_FILES, config: AUTHORED });
    assertExit(runCli(cwd, '--write-baseline', '--reason', INITIAL_ADOPTION_REASON), 0);
    const written = readConfig(cwd);
    assert.deepEqual(written.baseline['src/big.mjs'], { lines: BIG_LINES, reason: INITIAL_ADOPTION_REASON });
    assert.deepEqual(written.aggregate.src, { lines: BIG_LINES, reason: INITIAL_ADOPTION_REASON });
  });

  it('authored config holding layout: a raise in that present half refuses and counts only that half', () => {
    assertKitRefusal({ files: WIDE_FILES, config: AUTHORED_LAYOUT }, ['--write-baseline'], 1, [
      'src: aggregate lines none → 1 (raise)', 'src: files 20 → 24 (raise)',
    ]);
  });

  it('incomplete config: a raise in its present aggregate refuses while the missing baseline also raises', () => {
    assertKitRefusal({ files: BIG_FILES, config: { ...AUTHORED, aggregate: { src: { lines: 1, reason: RECORDED_REASON } } } }, ['--write-baseline'], 1, [
      'src/big.mjs: lines none → 441 (raise)', 'src: aggregate lines 1 → 441 (raise)',
    ]);
  });

  it('incomplete config: raises confined to its missing baseline take the kit sentence', () => {
    const cwd = createProject({ files: BIG_FILES, config: { ...AUTHORED, aggregate: AGGREGATE } });
    assertExit(runCli(cwd, '--write-baseline', '--reason', INITIAL_ADOPTION_REASON), 0);
    const written = readConfig(cwd);
    assert.deepEqual(written.baseline['src/big.mjs'], { lines: BIG_LINES, reason: INITIAL_ADOPTION_REASON });
    assert.deepEqual(written.aggregate, AGGREGATE);
  });

  it('minted config without layout: starting layout alone takes the kit sentence', () => {
    const cwd = createProject({ files: BIG_FILES, config: MINTED });
    assertExit(runCli(cwd, '--write-baseline', '--layout', '--reason', INITIAL_ADOPTION_REASON), 0);
    const { layout, ...rest } = readConfig(cwd);
    assert.deepEqual(rest, MINTED);
    assert.deepEqual(layout, { roots: { src: { files: 1, reason: INITIAL_ADOPTION_REASON } }, directories: {} });
  });

  it('layout start with other growth: the S42 refusal precedes the kit-sentence refusal', () => {
    const cwd = createProject({ files: GROWN_FILES, config: MINTED });
    const before = readSnapshot(cwd);
    const result = runCli(cwd, '--write-baseline', '--layout', '--reason', INITIAL_ADOPTION_REASON);
    assertExit(result, 1);
    assertUnchanged(cwd, before);
    assert.equal(result.stdout.split('\n').find((line) => line.includes('REFUSED')), LAYOUT_GROWTH_LEAD);
    assert.ok(result.stdout.includes('src/big.mjs: lines 441 → 450 (raise)'), result.stdout);
    assert.equal(result.stdout.includes(REFUSAL_LEAD), false, result.stdout);
  });

  it('minted config with growth: plain regeneration cannot give old halves the kit sentence', () => {
    assertKitRefusal({ files: GROWN_FILES, config: MINTED }, ['--write-baseline'], 2, [
      'src/big.mjs: lines 441 → 450 (raise)', 'src: aggregate lines 441 → 450 (raise)',
    ]);
  });

  it('adopt on authored layout growth: the mint refuses and no gate is declared', () => {
    assertKitRefusal({ files: WIDE_FILES, config: AUTHORED_LAYOUT }, ['--adopt'], 1, [
      'src: aggregate lines none → 1 (raise)', 'src: files 20 → 24 (raise)',
    ]);
  });

  it('override on a minted config: the kit sentence is a usage refusal', () => {
    assertUsageRefusal(OVERRIDE_ARGS, INITIAL_ADOPTION_REASON, OVERRIDE_DEFECT);
  });

  for (const args of REASON_MODES) {
    for (const placeholder of [GROWTH_REASON_PLACEHOLDER, '<text>']) {
      it(`${args[0]} on a minted config: whole placeholder ${placeholder} is a usage refusal`, () => {
        assertUsageRefusal(args, placeholder, `--reason still carries the placeholder ${placeholder} — write the reason in its place; the command line never takes a placeholder as a reason`);
      });
    }

    it(`${args[0]} on a minted config: kept <for now> is a reason rather than a whole placeholder`, () => {
      const cwd = createProject({ files: { ...BIG_FILES, 'docs/ai/.workflow-version': `${EXPECTED_WORKFLOW_VERSION}\n` }, config: MINTED });
      assertExit(runCli(cwd, ...args, '--reason', 'kept <for now>'), 0);
    });
  }

  it('validator compatibility: a baseline reason already holding the placeholder still checks green', () => {
    const config = { ...MINTED, baseline: { 'src/big.mjs': { lines: BIG_LINES, reason: GROWTH_REASON_PLACEHOLDER } } };
    const cwd = createProject({ files: BIG_FILES, config });
    const before = readSnapshot(cwd);
    assertExit(runCli(cwd, '--check'), 0);
    assertUnchanged(cwd, before);
  });
});

describe('spec:source-size/S64 every mint printer asks the same reason rule and first-entry lanes keep the kit sentence', () => {
  const REASON_STATES = [
    ['absent', null, INITIAL_ADOPTION_REASON],
    ['authored without a machine half', AUTHORED, INITIAL_ADOPTION_REASON],
    ['incomplete with baseline', { ...AUTHORED, baseline: BASELINE }, GROWTH_REASON_PLACEHOLDER],
    ['authored holding layout', AUTHORED_LAYOUT, GROWTH_REASON_PLACEHOLDER],
  ];
  for (const [state, raw, expected] of REASON_STATES) {
    it(`mintReasonOf: ${state} answers ${expected}`, async () => {
      const config = raw === null ? null : validateSourceSizeConfig(raw);
      const { mintReasonOf } = await import('./index.mjs');
      assert.equal(typeof mintReasonOf, 'function', 'the door exports mintReasonOf');
      assert.equal(mintReasonOf(config), expected);
    });
  }

  const PRINT_STATES = REASON_STATES.filter(([state]) => state === 'authored without a machine half' || state === 'incomplete with baseline');
  for (const [state, config, reason] of PRINT_STATES) {
    it(`unminted override refusal: ${state} prints ${reason}`, () => {
      const cwd = createProject({ files: BIG_FILES, config });
      const before = readSnapshot(cwd);
      const result = runCli(cwd, ...OVERRIDE_ARGS, '--reason', 'x');
      assertExit(result, 1);
      assert.ok(result.stdout.split('\n').includes(`  ${MINT_COMMAND(cwd, reason)}`), result.stdout);
      assertUnchanged(cwd, before);
    });

    for (const suffix of ['', '$']) {
      it(`unminted check remedy${suffix ? ' with withheld project path' : ''}: ${state} prints ${reason}`, () => {
        const cwd = createProject({ files: BIG_FILES, config }, suffix);
        const before = readSnapshot(cwd);
        const result = runCli(cwd, '--check');
        assertExit(result, 1);
        const expected = suffix
          ? `Run source-size-check.mjs --write-baseline --reason "${reason}" with the working directory set to this project.`
          : MINT_COMMAND(cwd, reason);
        assert.deepEqual(readBlock(result.stdout).remedies, [expected]);
        assertUnchanged(cwd, before);
      });

      it(`gate fill${suffix ? ' with withheld project path' : ''}: ${state} prints ${reason}`, () => {
        const cwd = createProject({ files: BIG_FILES, config }, suffix);
        const before = readSnapshot(cwd);
        const result = sourceSizeCandidate(cwd, {});
        assert.equal(result.candidate, null);
        const expected = suffix
          ? `run source-size-check.mjs --adopt --reason "${reason}" yourself, with the working directory set to this project`
          : `node "${SOURCE_SIZE_TOOL_PATH}" --adopt --reason "${reason}" --cwd "${cwd}"`;
        assert.ok(result.note.includes(expected), result.note);
        assertUnchanged(cwd, before);
      });
    }

    it(`gate fill with withheld tool path: ${state} prints ${reason}`, () => {
      const cwd = createProject({ files: BIG_FILES, config });
      const before = readSnapshot(cwd);
      const result = sourceSizeCandidate(cwd, { sourceSizeTool: join(cwd, 'kit$', 'source-size-check.mjs') });
      assert.equal(result.candidate, null);
      assert.ok(result.note.includes(`mint the record first — run source-size-check.mjs --adopt --reason "${reason}" with the working directory set to this project, then declare the gate by hand`), result.note);
      assertUnchanged(cwd, before);
    });
  }

  for (const args of [['--adopt'], OVERRIDE_ARGS]) {
    it(`absent refusal for ${args[0]} keeps the initial-adoption lane and prints no growth placeholder`, () => {
      const cwd = createProject({ files: BIG_FILES });
      const before = readSnapshot(cwd);
      const result = runCli(cwd, ...args, '--reason', 'x');
      assertExit(result, 1);
      assert.equal(result.stdout.includes(GROWTH_REASON_PLACEHOLDER), false, result.stdout);
      if (args[0] === '--adopt') {
        assert.ok(result.stdout.includes(`node "${SOURCE_SIZE_TOOL_PATH}" --adopt --cwd "${cwd}" --reason "${INITIAL_ADOPTION_REASON}"`), result.stdout);
      }
      assertUnchanged(cwd, before);
    });
  }

  for (const [state, fixture, flags] of [
    ['absent with a directory beyond its band', { files: makeMany('wide', 23) }, []],
    ['minted without layout with a passing check', { files: BIG_FILES, config: MINTED }, ['--layout']],
  ]) {
    it(`layout setup record: ${state} keeps initial adoption`, () => {
      const cwd = createProject(fixture);
      const before = readSnapshot(cwd);
      assert.deepEqual(readLayoutSetup(cwd, {}), {
        answer: 'record', args: ['--write-baseline', ...flags, '--reason', INITIAL_ADOPTION_REASON],
      });
      assertUnchanged(cwd, before);
    });
  }
});
