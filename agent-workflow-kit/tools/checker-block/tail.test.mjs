import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runImportCensus } from '../checker-verdict/import-harness.test.mjs';

const checkerBlock = await import('./index.mjs').catch(() => ({}));
const placeModule = await import('./place.mjs').catch(() => ({}));
const tailModule = await import('./tail.mjs').catch(() => ({}));
const { runCheckerTail } = checkerBlock;

const CHECKER_NAME = 'demo-check';
const EXIT_CODE = 2;
const REMEDY_TEXT = 'restore the declared entry';
const TAIL_OPTIONS = { name: CHECKER_NAME, exitCode: EXIT_CODE, remedy: REMEDY_TEXT };
const MODULE_FILES = ['place.mjs', 'tail.mjs', 'index.mjs'];
const ALLOWED_IMPORTS = new Set([
  '../../references/scripts/shared/index.mjs', './place.mjs', './tail.mjs', './index.mjs',
]);
const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g;

const createHost = () => {
  const stdoutWrites = [];
  const stderrWrites = [];
  const host = {
    stdout: { write: (text) => stdoutWrites.push(text) },
    stderr: { write: (text) => stderrWrites.push(text) },
    exitCode: undefined,
  };
  return { host, stdoutWrites, stderrWrites };
};

const assertHost = ({ host, stdoutWrites, stderrWrites }, expectedWrites, code, label) => {
  assert.equal(stdoutWrites.length, expectedWrites.length, label);
  assert.deepEqual(stdoutWrites, expectedWrites, label);
  assert.deepEqual(stderrWrites, [], label);
  assert.equal(host.exitCode, code, label);
};

it('spec:checker-block/S4 writes each tail answer once and guards unexpected errors', async () => {
  assert.equal(typeof runCheckerTail, 'function');
  const answerRows = [
    { label: 'lines', answer: { code: 1, lines: ['first line', 'second line'] },
      writes: ['first line\nsecond line\n'] },
    { label: 'stdout without final line feed', answer: { code: 3, stdout: 'first\nsecond', stderr: 'ignored' },
      writes: ['first\nsecond\n'] },
    { label: 'stdout with final line feed', answer: { code: 0, stdout: 'first\nsecond\n', stderr: 'ignored' },
      writes: ['first\nsecond\n'] },
    { label: 'empty lines', answer: { code: 4, lines: [] }, writes: [] },
    { label: 'empty stdout', answer: { code: 5, stdout: '' }, writes: [] },
  ];
  for (const row of answerRows) {
    const direct = createHost();
    assert.equal(runCheckerTail(TAIL_OPTIONS, () => row.answer, direct.host), row.answer.code, row.label);
    assertHost(direct, row.writes, row.answer.code, row.label);
    const promised = createHost();
    const answer = runCheckerTail(TAIL_OPTIONS, () => Promise.resolve(row.answer), promised.host);
    assert.ok(answer instanceof Promise, row.label);
    assert.equal(await answer, row.answer.code, row.label);
    assertHost(promised, row.writes, row.answer.code, row.label);
  }
  const error = new Error('broken input\r\nmore context');
  const errorLines = [
    `${CHECKER_NAME}: FAIL \u2014 unexpected error: broken input`,
    `${CHECKER_NAME}: REMEDY \u2014 ${REMEDY_TEXT}`,
    ...error.stack.split(/\r\n|[\r\n]/),
  ];
  const thrown = createHost();
  const thrownAnswer = runCheckerTail(TAIL_OPTIONS, () => { throw error; }, thrown.host);
  assert.equal(thrownAnswer, EXIT_CODE);
  assertHost(thrown, [`${errorLines.join('\n')}\n`], EXIT_CODE, 'thrown error');
  const rejected = createHost();
  const rejectedAnswer = runCheckerTail(TAIL_OPTIONS, () => Promise.reject(error), rejected.host);
  assert.ok(rejectedAnswer instanceof Promise);
  assert.equal(await rejectedAnswer, EXIT_CODE);
  assertHost(rejected, [`${errorLines.join('\n')}\n`], EXIT_CODE, 'rejected error');
  const refusalRows = [
    { name: 'Bad Name' }, { remedy: '' }, { exitCode: 0 },
  ];
  for (const fields of refusalRows) {
    const calls = [];
    const refused = createHost();
    assert.throws(() => runCheckerTail({ ...TAIL_OPTIONS, ...fields }, () => {
      calls.push('run');
      return answerRows[0].answer;
    }, refused.host), TypeError, JSON.stringify(fields));
    assert.deepEqual(calls, []);
    assertHost(refused, [], undefined, JSON.stringify(fields));
  }
});

it('spec:checker-block/S5 keeps module imports pure and exports exactly the two door names', async () => {
  for (const file of MODULE_FILES) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(source.split(/\r\n|[\r\n]/)[0].startsWith('#!'), false, file);
    assert.doesNotMatch(source, /\b(?:isDirectRun|process|readFileSync|spawn)\b/, file);
    const specifiers = Array.from(source.matchAll(STATIC_IMPORT), (match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(ALLOWED_IMPORTS.has(specifier), `${file}: ${specifier}`);
    }
  }
  assert.deepEqual(await runImportCensus({ record: { files: [{
    path: 'agent-workflow-kit/tools/checker-block/index.mjs',
    commandLines: [{ name: 'checker-block', arguments: [] }],
  }] } }), []);
  assert.deepEqual(Object.keys(checkerBlock).sort(), ['composeCheckerBlock', 'runCheckerTail']);
  assert.equal(typeof checkerBlock.composeCheckerBlock, 'function');
  assert.equal(typeof checkerBlock.runCheckerTail, 'function');
  assert.equal(checkerBlock.composeCheckerBlock, placeModule.composeCheckerBlock);
  assert.equal(checkerBlock.runCheckerTail, tailModule.runCheckerTail);
});
