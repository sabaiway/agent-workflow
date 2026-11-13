import assert from 'node:assert/strict';
import { readFileSync, renameSync } from 'node:fs';
import { describe, it } from 'node:test';
import { guardedMain, main } from './source-size-check.mjs';
import { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_WHY } from './source-size-core.mjs';
import { schema1MovedLines } from './source-size-report.mjs';
import { configPath, createProject, makeLines, runCli } from './source-size/cli-harness.test.mjs';

const SOURCE_PATH = 'src/grown.mjs';
const RECORDED_LINES = 441;
const GROWN_LINES = 460;
const OLD_REASON = 'The parser was recorded before this growth.';
const GROWTH_REASON = 'The parser grew before this write and its cause was not recorded.';
const RECORDS = {
  baseline: { [SOURCE_PATH]: { lines: RECORDED_LINES, reason: OLD_REASON } },
  aggregate: { src: { lines: RECORDED_LINES, reason: OLD_REASON } },
};
const AUTHORED_SCHEMA1 = {
  _README: 'Keep this project declaration verbatim.',
  schema: 1,
  roots: ['src'],
  defaults: SOURCE_SIZE_DEFAULTS,
  exclude: [],
  extensions: ['.mjs'],
};
const MOVED_AUTHORED = {
  _README: AUTHORED_SCHEMA1._README,
  schema: 2,
  roots: AUTHORED_SCHEMA1.roots,
  exclude: AUTHORED_SCHEMA1.exclude,
  extensions: AUTHORED_SCHEMA1.extensions,
};
const WHY_LINE = `source-size: WHY — ${SOURCE_SIZE_WHY}`;
const makeGrownProject = () => createProject({
  files: { [SOURCE_PATH]: makeLines(GROWN_LINES) },
  config: { ...AUTHORED_SCHEMA1, ...RECORDS },
});

const assertRefusedMove = (args, assertRefusal) => {
  const cwd = makeGrownProject();
  const first = runCli(cwd, ...args);
  const afterFirst = readFileSync(configPath(cwd));
  const written = JSON.parse(afterFirst.toString('utf8'));
  assert.deepEqual(
    afterFirst,
    Buffer.from(`${JSON.stringify({ ...MOVED_AUTHORED, ...RECORDS }, null, 2)}\n`),
    'step 1: the move is written with the authored half transformed and both old records preserved',
  );
  assert.deepEqual(written.baseline, RECORDS.baseline, 'step 1: the grown file keeps its old baseline');
  assert.deepEqual(written.aggregate, RECORDS.aggregate, 'step 1: the old aggregate is not regenerated');
  assert.equal(Object.hasOwn(written, 'defaults'), false, 'step 1: the move drops defaults');
  assert.equal(Object.hasOwn(written, 'layout'), false, 'step 1: the refusal does not add layout');
  assert.deepEqual([first.code, first.stderr], [1, ''], 'step 2: the first run renders a refusal, exit 1');
  const [moveLine] = schema1MovedLines(cwd);
  const firstLines = first.stdout.split('\n');
  const refusedAt = firstLines.findIndex((line) => line.includes('REFUSED'));
  assert.deepEqual(firstLines.filter((line) => line === moveLine), [moveLine], 'step 2: the move line prints once');
  assert.ok(firstLines.indexOf(moveLine) < refusedAt, 'step 2: the move line comes ahead of the refusal');
  const refusalOutput = firstLines.filter((line) => line !== moveLine).join('\n');
  assertRefusal(refusalOutput);
  assert.equal(firstLines.at(-1), WHY_LINE, 'step 2: the rendered refusal closes with WHY');

  const second = runCli(cwd, ...args);
  assert.deepEqual([second.code, second.stderr], [1, ''], 'step 3: the same arguments still refuse, exit 1');
  assert.equal(second.stdout, refusalOutput, 'step 3: the second refusal is identical with only the move removed');
  assert.deepEqual(readFileSync(configPath(cwd)), afterFirst, 'step 3: the second run leaves config bytes unchanged');
};

describe('spec:source-size/S63 schema-1 moves before a rendered refusal, with regeneration and thrown stops distinct', () => {
  it('a minted schema-1 raise without --reason moves first, then refuses, and the second run changes no bytes', () => {
    assertRefusedMove(['--write-baseline'], (stdout) => {
      assert.match(stdout, /source-size: REFUSED.*RAISES 2 recorded value\(s\).*a raise takes a reason/,
        'step 2: the missing-reason refusal follows the move');
      assert.ok(stdout.includes(`${SOURCE_PATH}: lines ${RECORDED_LINES} → ${GROWN_LINES} (raise)`),
        'step 2: the refusal prints the grown file delta after the move');
      assert.ok(stdout.includes(`src: aggregate lines ${RECORDED_LINES} → ${GROWN_LINES} (raise)`),
        'step 2: the refusal prints the aggregate delta after the move');
    });
  });

  it('a minted schema-1 raise with the kit sentence moves first, then refuses, and the second run changes no bytes', () => {
    assertRefusedMove(['--write-baseline', '--reason', 'initial adoption'], (stdout) => {
      const refusal = 'source-size: REFUSED — --reason "initial adoption" is the kit\'s own sentence, true only of a record half this write creates, and this regeneration RAISES 2 value(s) in a half the config already holds. The whole old→new it would write:';
      assert.ok(stdout.split('\n').includes(refusal), 'step 2: the kit-sentence refusal follows the move');
      assert.ok(stdout.includes(`${SOURCE_PATH}: lines ${RECORDED_LINES} → ${GROWN_LINES} (raise)`),
        'step 2: the kit-sentence refusal includes the baseline delta');
      assert.ok(stdout.includes(`src: aggregate lines ${RECORDED_LINES} → ${GROWN_LINES} (raise)`),
        'step 2: the kit-sentence refusal includes the aggregate delta');
      assert.ok(stdout.includes('--reason "<why this size is accepted>"'),
        'step 2: the kit-sentence refusal offers regeneration with the reason placeholder');
    });
  });

  it('a minted schema-1 --layout growth refusal moves first without adding layout and repeats without a write', () => {
    assertRefusedMove(['--write-baseline', '--layout', '--reason', GROWTH_REASON], (stdout) => {
      assert.match(stdout, /source-size: --layout REFUSED.*record no longer holds/,
        'step 2: the layout growth refusal follows the move');
      assert.match(stdout, /--write-baseline --reason/,
        'step 2: the layout growth refusal names the plain regeneration needed first');
      assert.ok(stdout.includes(`${SOURCE_PATH}: lines ${RECORDED_LINES} → ${GROWN_LINES} (raise)`),
        'step 2: the layout growth refusal prints the baseline growth');
      assert.ok(stdout.includes('no record was regenerated') && !stdout.includes('nothing was written'),
        'step 2: a refusal after the written move never says nothing was written');
    });
  });

  it('an admitted schema-1 regeneration moves and raises the records in exactly one atomic rename', () => {
    const cwd = makeGrownProject();
    const renames = [];
    const result = guardedMain(['--write-baseline', '--cwd', cwd, '--reason', GROWTH_REASON], {
      deps: {
        rename: (...args) => {
          renames.push(args);
          return renameSync(...args);
        },
      },
    });
    assert.deepEqual([result.code, result.stderr], [0, ''], result.stdout);
    assert.equal(renames.length, 1, 'the move and admitted regeneration share exactly one atomic write');
    assert.equal(renames[0][1], configPath(cwd), 'the one rename publishes the size config');
    const written = JSON.parse(readFileSync(configPath(cwd), 'utf8'));
    assert.deepEqual(written, {
      ...MOVED_AUTHORED,
      baseline: { [SOURCE_PATH]: { lines: GROWN_LINES, reason: GROWTH_REASON } },
      aggregate: { src: { lines: GROWN_LINES, reason: GROWTH_REASON } },
    }, 'schema 2 holds the regenerated record and the reason verbatim on each raised entry');
  });

  it('a minted schema-1 thrown stop on non-UTF-8 source bytes writes nothing and prints no move', () => {
    const cwd = createProject({
      files: { [SOURCE_PATH]: Buffer.from([0x61, 0xff, 0x0a]) },
      config: { ...AUTHORED_SCHEMA1, ...RECORDS },
    });
    const before = readFileSync(configPath(cwd));
    const result = runCli(cwd, '--write-baseline');
    assert.deepEqual([result.code, result.stderr], [1, ''], result.stdout);
    assert.ok(result.stdout.includes(SOURCE_PATH), 'the thrown stop names the unverifiable tracked file');
    assert.match(result.stdout, /in-scope but not valid UTF-8/, 'this is the source-byte stop, not a reason refusal');
    assert.deepEqual(readFileSync(configPath(cwd)), before, 'the thrown stop leaves schema-1 config bytes unchanged');
    for (const line of schema1MovedLines(cwd)) {
      assert.ok(!result.stdout.includes(line), 'the thrown stop prints no move line');
    }
  });

  for (const [state, machine] of [
    ['authored', {}],
    ['incomplete with baseline only', { baseline: RECORDS.baseline }],
    ['incomplete with aggregate only', { aggregate: RECORDS.aggregate }],
  ]) {
    it(`a refused mint of an ${state} schema-1 config writes nothing and prints no move`, () => {
      const cwd = createProject({
        files: { [SOURCE_PATH]: makeLines(GROWN_LINES) },
        config: { ...AUTHORED_SCHEMA1, ...machine },
      });
      const before = readFileSync(configPath(cwd));
      const result = runCli(cwd, '--write-baseline');
      assert.deepEqual([result.code, result.stderr], [1, ''], `${state}: ${result.stdout}`);
      assert.match(result.stdout, /REFUSED.*RAISES.*a raise takes a reason/, `${state}: the mint requires a reason`);
      assert.deepEqual(readFileSync(configPath(cwd)), before, `${state}: the refused mint leaves schema-1 bytes unchanged`);
      for (const line of schema1MovedLines(cwd)) {
        assert.ok(!result.stdout.includes(line), `${state}: the refused mint prints no move line`);
      }
    });
  }

  it('--help says a refused --write-baseline on a minted schema-1 config still moves it', () => {
    const result = main(['--help']);
    assert.deepEqual([result.code, result.stderr], [0, '']);
    const text = result.stdout.replace(/\s+/g, ' ');
    const sentence = text.split(/[.!?](?:\s|$)/).find((part) =>
      /schema[ -]1/i.test(part) && /\bminted\b/i.test(part) && /\brefused\b/i.test(part) && /\bmov(?:e|es|ed)\b/i.test(part));
    assert.ok(sentence, 'help must say in one sentence that a refused --write-baseline on a minted schema-1 config still moves it');
  });
});
