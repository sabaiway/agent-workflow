import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CHECKER_NAME = 'demo-check';
const FAILURE_TEXT = 'declared places differ';
const REMEDY_TEXT = 'restore the declared places';
const SECOND_REMEDY_TEXT = 'run the check again';
const VERDICT_LINE = `${CHECKER_NAME}: FAIL — ${FAILURE_TEXT}`;
const REMEDY_LINE = `${CHECKER_NAME}: REMEDY — ${REMEDY_TEXT}`;
const GUARD_OPTIONS = { name: CHECKER_NAME, exitCode: 2, remedy: REMEDY_TEXT };
const RED_OPTIONS = { name: CHECKER_NAME, failed: FAILURE_TEXT, remedies: [REMEDY_TEXT] };
const FINDING = { place: 'src/a.mjs:12', text: 'entry differs' };
const FINDINGS = [
  { place: 'src/check.mjs:12', text: 'line differs', detail: ['expected entry', '  found entry'] },
  { place: 'src/check.mjs', text: 'file differs' },
  { place: 'src/checks', text: 'directory differs' },
  { place: '.', text: 'project differs' },
  { place: '/outside/check.mjs', text: 'outside file differs' },
  { place: '/outside/check.mjs:3', text: 'outside line differs' },
];
const FULL_RED_OPTIONS = {
  ...RED_OPTIONS, findings: FINDINGS, remedies: [REMEDY_TEXT, SECOND_REMEDY_TEXT],
  after: ['Note: checked declared places', '', '  trailing note'],
};
const EMPTY_RED_OPTIONS = [
  RED_OPTIONS, { ...RED_OPTIONS, findings: [] }, { ...RED_OPTIONS, after: [] },
  { ...RED_OPTIONS, findings: [], after: [] },
];
const USAGE_LINES = [`Usage: ${CHECKER_NAME} [options]`, '  --help  show usage', 'Options end here'];
const USAGE_OPTIONS = ['\n', '\r\n'].map((separator) => ({
  name: CHECKER_NAME, failed: FAILURE_TEXT, usage: USAGE_LINES.join(separator),
}));
const BAD_NAMES = ['Demo', 'demo_check', 'demo--check', '-demo', 'demo-', '', 7];
const BAD_TEXTS = [7, '', ' leading space', 'first\rsecond', 'first\nsecond'];
const BAD_DETAILS = [7, '', 'first\nsecond', 'first\rsecond'];
const BAD_PLACES = [
  7, ' src/a.mjs', 'src/a.mjs\n', 'src\\a.mjs', 'src/../a.mjs', './src/a.mjs', '', ':3',
  'a:0', 'a:03', 'a:1e3', 'a:b', 'src/a.mjs:',
];
const BAD_EXIT_CODES = [0, 256, 1.5, '1', undefined];
const STACK_LINES = ['Error: first line', '    at check (src/check.mjs:12:3)', '    at run (src/run.mjs:4:2)'];
const makeExpectedErrorLines = (message, stackLines = []) => [
  `${CHECKER_NAME}: FAIL — unexpected error: ${message}`, REMEDY_LINE, ...stackLines,
];
const makeErrorWithoutStack = (message, name = 'Error') => Object.assign(new Error(message), {
  name, stack: undefined,
});

describe('spec:verdict-block/S1 red block order and optional lists', () => {
  it('returns exact ordered lines for every place form and omitted or empty lists', async () => {
    const { composeRedBlock } = await import('./verdict-block.mjs');
    assert.deepEqual(composeRedBlock(FULL_RED_OPTIONS), [
      VERDICT_LINE,
      'src/check.mjs:12: line differs',
      '  expected entry',
      '    found entry',
      'src/check.mjs: file differs',
      'src/checks: directory differs',
      '.: project differs',
      '/outside/check.mjs: outside file differs',
      '/outside/check.mjs:3: outside line differs',
      REMEDY_LINE,
      `${CHECKER_NAME}: REMEDY — ${SECOND_REMEDY_TEXT}`,
      'Note: checked declared places', '', '  trailing note',
    ]);
    for (const options of EMPTY_RED_OPTIONS) {
      assert.deepEqual(composeRedBlock(options), [VERDICT_LINE, REMEDY_LINE]);
    }
  });
});

describe('spec:verdict-block/S2 usage refusal', () => {
  it('returns only the verdict and usage lines for LF and CRLF', async () => {
    const { composeUsageRefusal } = await import('./verdict-block.mjs');
    for (const options of USAGE_OPTIONS) {
      assert.deepEqual(composeUsageRefusal(options), [VERDICT_LINE, ...USAGE_LINES]);
    }
  });
});

describe('spec:verdict-block/S3 guarded runs', () => {
  it('preserves a plain value by identity and resolves a promise to the same value', async () => {
    const { guardChecker } = await import('./verdict-block.mjs');
    const value = { checked: true };
    assert.equal(guardChecker(GUARD_OPTIONS, () => value), value);
    const answer = guardChecker(GUARD_OPTIONS, () => Promise.resolve(value));
    assert.ok(answer instanceof Promise);
    assert.equal(await answer, value);
  });

  it('places the verdict and remedy before an exact LF or CRLF stack', async () => {
    const { guardChecker } = await import('./verdict-block.mjs');
    for (const separator of ['\n', '\r\n']) {
      const error = new Error('first line\nsecond line');
      error.stack = STACK_LINES.join(separator);
      const answer = guardChecker(GUARD_OPTIONS, () => { throw error; });
      assert.deepEqual(answer, { exitCode: GUARD_OPTIONS.exitCode,
        lines: makeExpectedErrorLines('first line', STACK_LINES) });
      assert.equal(Object.getPrototypeOf(answer), Object.prototype);
      for (const line of answer.lines) assert.doesNotMatch(line, /[\r\n]/);
    }
  });

  it('answers a rejected promise with a promise of the exact unexpected-error block', async () => {
    const { guardChecker } = await import('./verdict-block.mjs');
    const error = new Error('first line\nsecond line');
    error.stack = STACK_LINES.join('\n');
    const answer = guardChecker(GUARD_OPTIONS, () => Promise.reject(error));
    assert.ok(answer instanceof Promise);
    assert.deepEqual(await answer, { exitCode: GUARD_OPTIONS.exitCode,
      lines: makeExpectedErrorLines('first line', STACK_LINES) });
  });

  it('uses first-line fallbacks and ends at the remedy when no stack exists', async () => {
    const { guardChecker } = await import('./verdict-block.mjs');
    const cases = [
      ['empty message', makeErrorWithoutStack('', 'RangeError'), 'RangeError'],
      ['multi-line name', makeErrorWithoutStack('', 'RangeError\nsecond name'), 'RangeError'],
      ['string', 'plain failure', 'plain failure'],
      ['multi-line string', 'first text\nsecond text', 'first text'],
      ['number', 42, '42'],
      ['empty message and name', makeErrorWithoutStack('', ''), 'no message'],
      ['unprintable value', Object.create(null), 'no message'],
      ['undefined stack', makeErrorWithoutStack('x'), 'x'],
    ];
    for (const [label, error, message] of cases) {
      assert.deepEqual(guardChecker(GUARD_OPTIONS, () => { throw error; }), {
        exitCode: GUARD_OPTIONS.exitCode, lines: makeExpectedErrorLines(message),
      }, label);
    }
  });
});

describe('spec:verdict-block/S4 closed refusals and validation before running', () => {
  it('refuses each malformed compose input by field and converts each refusal inside the guard', async () => {
    const { composeRedBlock, composeUsageRefusal, guardChecker } = await import('./verdict-block.mjs');
    const withFinding = (finding) => composeRedBlock({ ...RED_OPTIONS, findings: [finding] });
    const cases = [
      ...BAD_NAMES.map((name) => [`name ${JSON.stringify(name)}`,
        () => composeRedBlock({ ...RED_OPTIONS, name }), 'name']),
      ...BAD_TEXTS.flatMap((text) => [
        [`failed ${JSON.stringify(text)}`, () => composeRedBlock({ ...RED_OPTIONS, failed: text }), 'failed'],
        [`text ${JSON.stringify(text)}`, () => withFinding({ ...FINDING, text }), 'text'],
        [`remedy ${JSON.stringify(text)}`, () => composeRedBlock({ ...RED_OPTIONS, remedies: [text] }), 'remedies'],
      ]),
      ...BAD_DETAILS.map((detail) => [`detail ${JSON.stringify(detail)}`,
        () => withFinding({ ...FINDING, detail: [detail] }), 'detail']),
      ['detail not array', () => withFinding({ ...FINDING, detail: 'detail' }), 'detail'],
      ...BAD_PLACES.map((place) => [`place ${JSON.stringify(place)}`,
        () => withFinding({ ...FINDING, place }), 'place']),
      ['findings not array', () => composeRedBlock({ ...RED_OPTIONS, findings: 'text' }), 'findings'],
      ['null finding', () => withFinding(null), 'findings'],
      ['string finding', () => withFinding('text'), 'findings'],
      ['after not array', () => composeRedBlock({ ...RED_OPTIONS, after: 'text' }), 'after'],
      ['findings hole', () => composeRedBlock({ ...RED_OPTIONS, findings: new Array(1) }), 'findings'],
      ['detail hole', () => withFinding({ ...FINDING, detail: new Array(1) }), 'detail'],
      ['remedies hole', () => composeRedBlock({ ...RED_OPTIONS, remedies: new Array(1) }), 'remedies'],
      ['after hole', () => composeRedBlock({ ...RED_OPTIONS, after: new Array(1) }), 'after'],
      ['remedies not array', () => composeRedBlock({ ...RED_OPTIONS, remedies: 'text' }), 'remedies'],
      ['empty remedies', () => composeRedBlock({ ...RED_OPTIONS, remedies: [] }), 'remedies'],
      ['missing remedies', () => composeRedBlock({ name: CHECKER_NAME, failed: FAILURE_TEXT }), 'remedies'],
      ['finding verdict', () => withFinding({ place: CHECKER_NAME, text: 'FAIL — late' }), 'findings'],
      ['finding remedy', () => withFinding({ place: CHECKER_NAME, text: 'REMEDY — late' }), 'findings'],
      ...[7, ''].map((usage) => [`usage ${JSON.stringify(usage)}`,
        () => composeUsageRefusal({ name: CHECKER_NAME, failed: FAILURE_TEXT, usage }), 'usage']),
      ...['first\nsecond', 7].map((line) => [`after ${JSON.stringify(line)}`,
        () => composeRedBlock({ ...RED_OPTIONS, after: [line] }), 'after']),
      ['late finding', () => composeRedBlock({ ...RED_OPTIONS, findings: [FINDING],
        after: ['src/a.mjs:12: late'] }), 'after'],
      ['later remedy opens with place', () => composeRedBlock({ ...RED_OPTIONS,
        findings: [{ place: CHECKER_NAME, text: 'ok' }],
        remedies: [REMEDY_TEXT, SECOND_REMEDY_TEXT] }), 'remedies'],
    ];
    for (const [label, call, field] of cases) {
      const captured = {};
      assert.throws(call, (error) => {
        assert.ok(error instanceof TypeError, label);
        assert.match(error.message, new RegExp(`\\b${field}\\b`), label);
        captured.message = error.message.split(/\r\n|[\r\n]/)[0];
        return true;
      }, label);
      const answer = guardChecker(GUARD_OPTIONS, () => call());
      assert.equal(answer.exitCode, GUARD_OPTIONS.exitCode, label);
      assert.deepEqual(answer.lines.slice(0, 2), makeExpectedErrorLines(captured.message), label);
    }
    assert.doesNotThrow(() => composeRedBlock({ ...RED_OPTIONS,
      findings: [{ place: CHECKER_NAME, text: 'ok' }] }));
    assert.doesNotThrow(() => composeUsageRefusal(USAGE_OPTIONS[0]));
  });

  it('synchronously rejects malformed guard options without calling run', async () => {
    const { guardChecker } = await import('./verdict-block.mjs');
    const cases = [
      ...BAD_NAMES.map((name) => ['name', { ...GUARD_OPTIONS, name }]),
      ...BAD_TEXTS.map((remedy) => ['remedy', { ...GUARD_OPTIONS, remedy }]),
      ...BAD_EXIT_CODES.map((exitCode) => ['exitCode', { ...GUARD_OPTIONS, exitCode }]),
      ['exitCode', { name: CHECKER_NAME, remedy: REMEDY_TEXT }],
    ];
    for (const [field, options] of cases) {
      const calls = [];
      assert.throws(() => guardChecker(options, () => { calls.push(true); }), (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, new RegExp(`\\b${field}\\b`));
        return true;
      });
      assert.equal(calls.length, 0);
    }
  });
});

describe('spec:verdict-block/S5 pure source and frozen line arrays', () => {
  it('keeps the source pure and freezes every returned array of individual string lines', async () => {
    const source = readFileSync(new URL('./verdict-block.mjs', import.meta.url), 'utf8');
    const { composeRedBlock, composeUsageRefusal, guardChecker } = await import('./verdict-block.mjs');
    assert.doesNotMatch(source, /\bimport\b/);
    assert.doesNotMatch(source, /\b(?:process|globalThis|console)\b/);
    assert.equal(source.includes('require('), false);
    assert.equal(source.startsWith('#!'), false);
    assert.equal(source.includes('isDirectRun'), false);
    const error = new Error('first line\nsecond line');
    error.stack = STACK_LINES.join('\r\n');
    const answer = guardChecker(GUARD_OPTIONS, () => { throw error; });
    const returns = [
      composeRedBlock(FULL_RED_OPTIONS), ...EMPTY_RED_OPTIONS.map(composeRedBlock),
      ...USAGE_OPTIONS.map(composeUsageRefusal), answer.lines,
    ];
    for (const lines of returns) {
      assert.ok(Array.isArray(lines));
      assert.equal(Object.isFrozen(lines), true);
      for (const line of lines) {
        assert.equal(typeof line, 'string');
        assert.doesNotMatch(line, /[\r\n]/);
      }
    }
  });
});
