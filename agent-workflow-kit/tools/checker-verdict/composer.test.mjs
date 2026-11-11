import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const CHECKER_NAME = 'demo-check';
const FILE_PLACE = 'src/check.mjs:12';
const OTHER_PLACE = 'src/other.mjs';
const BLOCK_PLACES = [FILE_PLACE, 'src/check.mjs', 'src/checks', '.', '/outside/check.mjs'];
const FAILURE_TEXT = 'declared entries differ';
const FINDING_TEXT = 'the entry differs';
const REMEDY_TEXT = 'restore the declared entry';
const SECOND_REMEDY = 'run the check again';
const DETAIL_LINES = ['expected the declared entry', '  found another entry'];
const AFTER_LINES = ['Note: only declared entries were checked', '{"checked":2}'];
const USAGE_TEXT = `Usage: ${CHECKER_NAME} <path>\nOptions: --help`;
const ERROR_EXIT_CODE = 2;
const ERROR_MESSAGE = 'boom';
const REMEDY_FINDING_TEXT = 'REMEDY \u2014 late';
const RED_OPTIONS = {
  name: CHECKER_NAME,
  failed: FAILURE_TEXT,
  findings: [{ place: FILE_PLACE, text: FINDING_TEXT }],
  remedies: [REMEDY_TEXT],
};
const PLACE_ROWS = [
  'a:b', 'src/a:b.mjs', 'a:03', 'a:0', 'a:1e3',
  FILE_PLACE, 'src/check.mjs', '.', '/outside/check.mjs',
  'src\\a.mjs', '../a.mjs', 'src/../a.mjs', './a.mjs', '', ':3', 'src/a.mjs:',
  ' a.mjs', 'a\nb', 'a\rb',
];

describe('spec:verdict-block/S6 composer output meets the kit form', () => {
  it('accepts every place form with two findings, details, remedies and after lines', async () => {
    const { composeRedBlock } = await import('../../references/scripts/shared/index.mjs');
    const { judgeBlock } = await import('./index.mjs');
    for (const place of BLOCK_PLACES) {
      const findings = [
        { place, text: FINDING_TEXT, detail: DETAIL_LINES },
        { place: OTHER_PLACE, text: FINDING_TEXT },
      ];
      const lines = composeRedBlock({
        ...RED_OPTIONS, findings, remedies: [REMEDY_TEXT, SECOND_REMEDY], after: AFTER_LINES,
      });
      const places = findings.map((finding) => finding.place);
      assert.deepEqual(judgeBlock(lines.join('\n'), { name: CHECKER_NAME, places }), [], place);
    }
  });

  it('refuses an after line opening with a finding place', async () => {
    const { composeRedBlock } = await import('../../references/scripts/shared/index.mjs');
    composeRedBlock(RED_OPTIONS);
    assert.throws(() => composeRedBlock({
      ...RED_OPTIONS, after: [`${FILE_PLACE}: late finding`],
    }), TypeError);
  });

  it('refuses a later remedy opening with the checker-name finding place', async () => {
    const { composeRedBlock } = await import('../../references/scripts/shared/index.mjs');
    const options = {
      ...RED_OPTIONS, findings: [{ place: CHECKER_NAME, text: FINDING_TEXT }],
    };
    composeRedBlock(options);
    assert.throws(() => composeRedBlock({
      ...options, remedies: [REMEDY_TEXT, SECOND_REMEDY],
    }), TypeError);
  });

  it('refuses a finding whose complete line reads as a remedy', async () => {
    const { composeRedBlock } = await import('../../references/scripts/shared/index.mjs');
    composeRedBlock(RED_OPTIONS);
    assert.throws(() => composeRedBlock({
      ...RED_OPTIONS, findings: [{ place: CHECKER_NAME, text: REMEDY_FINDING_TEXT }],
    }), TypeError);
  });

  it('opens a usage refusal with a judged verdict line', async () => {
    const { composeUsageRefusal } = await import('../../references/scripts/shared/index.mjs');
    const { judgeVerdictLine } = await import('./index.mjs');
    const lines = composeUsageRefusal({ name: CHECKER_NAME, failed: FAILURE_TEXT, usage: USAGE_TEXT });
    assert.equal(judgeVerdictLine(lines[0], CHECKER_NAME), true);
  });

  it('judges the guard verdict, second-line remedy and complete unexpected-error block', async () => {
    const { guardChecker } = await import('../../references/scripts/shared/index.mjs');
    const { judgeVerdictLine, judgeRemedyLine, judgeBlock } = await import('./index.mjs');
    const answer = guardChecker({ name: CHECKER_NAME, exitCode: ERROR_EXIT_CODE, remedy: REMEDY_TEXT }, () => {
      throw new Error(ERROR_MESSAGE);
    });
    assert.equal(judgeVerdictLine(answer.lines[0], CHECKER_NAME), true);
    assert.equal(judgeRemedyLine(answer.lines[1], CHECKER_NAME), true);
    assert.deepEqual(judgeBlock(answer.lines.join('\n'), { name: CHECKER_NAME, places: [] }), []);
  });

  it('matches judgePlace over the place table except leading spaces and line breaks', async () => {
    const { composeRedBlock } = await import('../../references/scripts/shared/index.mjs');
    const { judgePlace } = await import('./index.mjs');
    assert.equal(judgePlace(' a.mjs'), true, 'leading space is accepted by judgePlace');
    assert.equal(judgePlace('a\nb'), true, 'line feed is accepted by judgePlace');
    assert.equal(judgePlace('a\rb'), true, 'carriage return is accepted by judgePlace');
    for (const place of PLACE_ROWS) {
      const options = { ...RED_OPTIONS, findings: [{ place, text: FINDING_TEXT }] };
      const accepted = judgePlace(place) && !place.startsWith(' ') && !/[\r\n]/.test(place);
      const message = `place ${JSON.stringify(place)}`;
      if (accepted) {
        assert.doesNotThrow(() => composeRedBlock(options), message);
      } else {
        assert.throws(() => composeRedBlock(options), { name: 'TypeError', message: /place/ }, message);
      }
    }
  });
});
