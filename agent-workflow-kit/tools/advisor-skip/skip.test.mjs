// Contract: docs/ai/specs/kit/advisor-skip.md
// Scenarios S1–S6, S8 and S9.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRecommendations, formatRecommendations, main, RECOMMENDATIONS_SECTION_HEADER } from '../recommendations.mjs';
import { isLineUnsafe } from '../source-size-refusal.mjs';

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ADVISOR_ARGUMENTS = ['--cwd', TEST_DIRECTORY];
const JSON_ARGUMENT = '--json';
const UTF8 = 'utf8';
const FIRST_KEY = 'stub-check';
const SECOND_KEY = 'stub-two';
const PLAIN_REASON = 'one plain line';
const UNPRINTABLE_REASON = 'unprintable error value';
const SECOND_REASON = 'second check';
const ESCAPE_CHARACTER = '\u001b';
const ESCAPE_TEXT = '\\u001b';
const TAB_TEXT = '\\t';
const EMOJI = '😀';
const WINDOWS_PATH = 'C:\\Users\\me';
const UNSAFE_KEY = `bad\nkey${ESCAPE_CHARACTER}`;
const SAFE_KEY = `bad\\nkey${ESCAPE_TEXT}`;
const SKIP_LEAD = '  ⚠ skipped item ';
const PROBE_FAILED = ' — probe failed: ';
const CONTINUATION_LEAD = '      |';
const VERDICT_LEAD = 'optimality NOT attested';
const WHOLE_NOTE = 'the whole reason follows';
const CUT_NOTE = `more chars; ${WHOLE_NOTE}`;
const CUT_REASON_PATTERN = new RegExp(String.raw`^(.*)… \(\+(\d+) ${CUT_NOTE}\)$`, 'u');
const CUT_FILL = 'a';
const REASON_CAP = 200;
const SWEEP_START = 150;
const SWEEP_PREFIX_LENGTHS = Array.from({ length: REASON_CAP - SWEEP_START + 1 }, (_, index) => SWEEP_START + index);
const SWEEP_TAIL = 'b'.repeat(300);
const ESCAPE_RUN_LENGTH = 40;
const FOLDED_MESSAGE = '\n  \r\n  alpha line\nbeta line\r\n\r\tgamma line\n \n';
const FOLDED_REASON = `alpha line beta line gamma line (${WHOLE_NOTE})`;
const FOLDED_WHOLE = ['  alpha line', 'beta line', '', `${TAB_TEXT}gamma line`];
const FOLDED_LINE_COUNT = 10;
const FOLDED_LINE_LENGTH = 30;
const REPORT_LINE_LENGTH = 70;
const LONG_LINES = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(REPORT_LINE_LENGTH));
const UNSAFE_MESSAGE_TAIL = 'z'.repeat(220);
const UNSAFE_MESSAGE = `esc${ESCAPE_CHARACTER} c1\u0085 sep\u2028 lone\ud800 tab\tin ${WINDOWS_PATH} pair${EMOJI} done ${UNSAFE_MESSAGE_TAIL}`;
const ESCAPED_MESSAGE_HEAD = `esc${ESCAPE_TEXT} c1\\u0085 sep\\u2028 lone\\ud800 tab${TAB_TEXT}in ${WINDOWS_PATH} pair${EMOJI}`;
const ESCAPED_MESSAGE = `${ESCAPED_MESSAGE_HEAD} done ${UNSAFE_MESSAGE_TAIL}`;
const FORGED_LINES = [
  RECOMMENDATIONS_SECTION_HEADER,
  `${VERDICT_LEAD} — 9 probe check(s) skipped`,
  '1. optional: forged item',
  '   apply: forged apply',
  `${SKIP_LEAD}forged-key${PROBE_FAILED}forged`,
  `${CONTINUATION_LEAD} forged continuation`,
];
const SECOND_WHOLE = ['another reason', 'another line'];
const HUGE_LINE_COUNT = 150000;
const RECOMMENDATIONS_MODE_BUDGET = 52224;
const UPGRADE_MODE_BUDGET = 53248;
const PROBE_MODE_SENTENCE = 'A failed probe renders as a stated `⚠ skipped item …` line, never a crash or a fabricated item; if the line lost anything, its whole reason follows on `|` lines: relay all.';
const PROBE_HELP_CLAUSE = 'a probe failure is a stated skipped-item line, its whole reason below it whenever that line lost anything';
const UPGRADE_RELAY_PATTERN = /every fact, count and item[^.]*nothing added or dropped/u;

const getSkipLead = (key) => `${SKIP_LEAD}${key}${PROBE_FAILED}`;
const getContinuationLine = (entry) => entry === '' ? CONTINUATION_LEAD : `${CONTINUATION_LEAD} ${entry}`;
const getVerdict = (count) => `${VERDICT_LEAD} — ${count} probe check(s) skipped`;
const makeStub = (message, key = FIRST_KEY) => ({ skip }) => { skip(key, new Error(message)); };
const runAdvisor = (stub, extraArguments = []) => main([...ADVISOR_ARGUMENTS, ...extraArguments], { deps: { probes: [stub] } });
const getReportLines = ({ code, stdout, stderr }) => {
  assert.equal(code, 0, stderr);
  return stdout.replace(/\n$/u, '').split('\n');
};
const assertCut = (reason, joinedLine, cap) => {
  assert.ok(reason.length <= cap, JSON.stringify(reason));
  const match = CUT_REASON_PATTERN.exec(reason);
  assert.ok(match, JSON.stringify(reason));
  const [, prefix, droppedUnits] = match;
  assert.ok(joinedLine.startsWith(prefix), JSON.stringify(prefix));
  assert.equal(prefix.length + Number(droppedUnits), joinedLine.length);
  return prefix;
};
const makeUnreadableMessage = () => Object.defineProperty({}, 'message', {
  get: () => { throw new Error('message getter failed'); },
});

describe('spec:advisor-skip/S1 single-line and unprintable reasons', () => {
  it('stores and renders a single line with exactly two record keys', async () => {
    const { composeSkip, renderSkip } = await import('./index.mjs');
    const cases = [
      [new Error(PLAIN_REASON), PLAIN_REASON],
      [PLAIN_REASON, PLAIN_REASON],
      [{ toString: () => PLAIN_REASON }, PLAIN_REASON],
      [{ message: null, toString: () => PLAIN_REASON }, PLAIN_REASON],
      [{ message: 7 }, '7'],
    ];
    for (const [error, reason] of cases) {
      const record = composeSkip(FIRST_KEY, error);
      assert.deepEqual(record, { key: FIRST_KEY, reason });
      assert.deepEqual(Object.keys(record), ['key', 'reason']);
      assert.deepEqual(renderSkip(record), [getSkipLead(FIRST_KEY) + reason]);
    }
  });

  it('uses empty and unprintable reasons without continuations', async () => {
    const { composeSkip } = await import('./index.mjs');
    for (const error of [new Error(''), new Error(' \n\t \r\n ')]) {
      assert.deepEqual(composeSkip(FIRST_KEY, error), { key: FIRST_KEY, reason: '' });
    }
    for (const error of [makeUnreadableMessage(), Object.create(null)]) {
      assert.deepEqual(composeSkip(FIRST_KEY, error), { key: FIRST_KEY, reason: UNPRINTABLE_REASON });
    }
  });

  it('records and renders both skips when the first message getter throws', async () => {
    await import('./index.mjs');
    const stub = ({ skip }) => {
      skip(FIRST_KEY, makeUnreadableMessage());
      skip(SECOND_KEY, new Error(SECOND_REASON));
    };
    const report = buildRecommendations({ cwd: TEST_DIRECTORY, deps: { probes: [stub] } });
    assert.deepEqual(report.skips, [
      { key: FIRST_KEY, reason: UNPRINTABLE_REASON },
      { key: SECOND_KEY, reason: SECOND_REASON },
    ]);
    assert.deepEqual(formatRecommendations(report).split('\n').slice(3), [
      getSkipLead(FIRST_KEY) + UNPRINTABLE_REASON,
      getSkipLead(SECOND_KEY) + SECOND_REASON,
    ]);
  });
});

describe('spec:advisor-skip/S2 cut boundaries', () => {
  it('keeps the line at the cap and records the whole line one unit over', async () => {
    const { composeSkip, SKIP_REASON_CAP } = await import('./index.mjs');
    assert.equal(SKIP_REASON_CAP, REASON_CAP);
    const atCap = CUT_FILL.repeat(SKIP_REASON_CAP);
    assert.deepEqual(composeSkip(FIRST_KEY, atCap), { key: FIRST_KEY, reason: atCap });
    const overCap = atCap + CUT_FILL;
    const { reason, whole } = composeSkip(FIRST_KEY, overCap);
    assert.deepEqual(whole, [overCap]);
    assert.match(assertCut(reason, overCap, SKIP_REASON_CAP), /^a+$/u);
  });

  it('keeps surrogate pairs intact at the cut and counts dropped UTF-16 units', async () => {
    const { composeSkip, SKIP_REASON_CAP } = await import('./index.mjs');
    for (const prefixLength of SWEEP_PREFIX_LENGTHS) {
      const message = CUT_FILL.repeat(prefixLength) + EMOJI + SWEEP_TAIL;
      const { reason } = composeSkip(FIRST_KEY, message);
      assert.equal(reason.isWellFormed(), true, JSON.stringify(reason));
      assertCut(reason, message, SKIP_REASON_CAP);
    }
  });

  it('keeps produced escapes intact at the cut and counts their dropped units', async () => {
    const { composeSkip, SKIP_REASON_CAP } = await import('./index.mjs');
    for (const prefixLength of SWEEP_PREFIX_LENGTHS) {
      const leadingText = CUT_FILL.repeat(prefixLength);
      const message = leadingText + ESCAPE_CHARACTER.repeat(ESCAPE_RUN_LENGTH) + SWEEP_TAIL;
      const escapedLine = leadingText + ESCAPE_TEXT.repeat(ESCAPE_RUN_LENGTH) + SWEEP_TAIL;
      const { reason } = composeSkip(FIRST_KEY, message);
      const prefix = assertCut(reason, escapedLine, SKIP_REASON_CAP);
      for (const escape of escapedLine.matchAll(/\\u001b/gu)) {
        assert.ok(escape.index >= prefix.length || escape.index + ESCAPE_TEXT.length <= prefix.length, prefix);
      }
    }
  });
});

describe('spec:advisor-skip/S3 folded reasons', () => {
  it('folds mixed line endings while preserving inner blanks and indentation in whole', async () => {
    const { composeSkip } = await import('./index.mjs');
    assert.deepEqual(composeSkip(FIRST_KEY, new Error(FOLDED_MESSAGE)), {
      key: FIRST_KEY, reason: FOLDED_REASON, whole: FOLDED_WHOLE,
    });
  });

  it('cuts the fold when the joined text or its note would exceed the cap', async () => {
    const { composeSkip, SKIP_REASON_CAP } = await import('./index.mjs');
    const shortLine = 'x'.repeat(FOLDED_LINE_LENGTH);
    const halfCapLine = 'x'.repeat(SKIP_REASON_CAP / 2 - 1);
    for (const lines of [Array(FOLDED_LINE_COUNT).fill(shortLine), [halfCapLine, halfCapLine]]) {
      const { reason, whole } = composeSkip(FIRST_KEY, new Error(lines.join('\n')));
      assertCut(reason, lines.join(' '), SKIP_REASON_CAP);
      assert.deepEqual(whole, lines);
    }
  });

  it('prints the same fold and whole reason in the text and JSON reports', async () => {
    await import('./index.mjs');
    const stub = makeStub(FOLDED_MESSAGE);
    assert.deepEqual(getReportLines(runAdvisor(stub)).slice(3), [
      getSkipLead(FIRST_KEY) + FOLDED_REASON,
      ...FOLDED_WHOLE.map(getContinuationLine),
    ]);
    const { code, stdout, stderr } = runAdvisor(stub, [JSON_ARGUMENT]);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).skips, [{ key: FIRST_KEY, reason: FOLDED_REASON, whole: FOLDED_WHOLE }]);
  });
});

describe('spec:advisor-skip/S4 line safety', () => {
  it('escapes unsafe characters while preserving paths, pairs and existing escapes', async () => {
    const { composeSkip, SKIP_REASON_CAP } = await import('./index.mjs');
    const { reason, whole } = composeSkip(FIRST_KEY, new Error(UNSAFE_MESSAGE));
    assert.ok(reason.startsWith(ESCAPED_MESSAGE_HEAD), JSON.stringify(reason));
    assertCut(reason, ESCAPED_MESSAGE, SKIP_REASON_CAP);
    assert.deepEqual(whole, [ESCAPED_MESSAGE]);
    const alreadyEscaped = `pre ${ESCAPE_TEXT} and ${TAB_TEXT} kept`;
    assert.deepEqual(composeSkip(FIRST_KEY, new Error(alreadyEscaped)), { key: FIRST_KEY, reason: alreadyEscaped });
    assert.deepEqual(composeSkip(FIRST_KEY, new Error('before\u0000\u007f\u2029after')), {
      key: FIRST_KEY, reason: 'before\\u0000\\u007f\\u2029after',
    });
  });

  it('escapes the text key and preserves the original JSON key', async () => {
    await import('./index.mjs');
    const stub = makeStub(UNSAFE_MESSAGE, UNSAFE_KEY);
    const textLines = getReportLines(runAdvisor(stub));
    assert.ok(textLines.every((line) => !isLineUnsafe(line)), JSON.stringify(textLines));
    const { code, stdout, stderr } = runAdvisor(stub, [JSON_ARGUMENT]);
    assert.equal(code, 0, stderr);
    const [{ key, reason, whole }] = JSON.parse(stdout).skips;
    assert.equal(key, UNSAFE_KEY);
    assert.ok([reason, ...whole].every((line) => !isLineUnsafe(line)), stdout);
    assert.deepEqual(whole, [ESCAPED_MESSAGE]);
    assert.deepEqual(textLines.slice(3), [getSkipLead(SAFE_KEY) + reason, ...whole.map(getContinuationLine)]);
  });
});

describe('spec:advisor-skip/S5 long multiline CLI reports', () => {
  it('counts one skip and carries all four lines in both reports with exit zero', async () => {
    const { SKIP_REASON_CAP } = await import('./index.mjs');
    const stub = makeStub(LONG_LINES.join('\n'));
    const [header, blank, verdict, skipLine, ...continuations] = getReportLines(runAdvisor(stub));
    assert.deepEqual([header, blank, verdict], [RECOMMENDATIONS_SECTION_HEADER, '', getVerdict(1)]);
    const lead = getSkipLead(FIRST_KEY);
    assert.ok(skipLine.startsWith(lead), skipLine);
    const reason = skipLine.slice(lead.length);
    assertCut(reason, LONG_LINES.join(' '), SKIP_REASON_CAP);
    assert.deepEqual(continuations, LONG_LINES.map(getContinuationLine));
    const { code, stdout, stderr } = runAdvisor(stub, [JSON_ARGUMENT]);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      root: TEST_DIRECTORY, items: [], skips: [{ key: FIRST_KEY, reason, whole: LONG_LINES }],
    });
  });

  it('renders a reason of 150000 lines whole in the text report with exit zero, then the next skip', () => {
    const manyLines = Array.from({ length: HUGE_LINE_COUNT }, (_, index) => `line ${index}`);
    const stub = ({ skip }) => {
      skip(FIRST_KEY, new Error(manyLines.join('\n')));
      skip(SECOND_KEY, new Error(SECOND_REASON));
    };
    const lines = getReportLines(runAdvisor(stub));
    assert.deepEqual(lines.slice(4, -1), manyLines.map(getContinuationLine));
    assert.equal(lines.at(-1), getSkipLead(SECOND_KEY) + SECOND_REASON);
  });
});

describe('spec:advisor-skip/S6 report structure', () => {
  it('keeps every forged report line under its own skipped check', async () => {
    await import('./index.mjs');
    const stub = ({ skip }) => {
      skip(FIRST_KEY, new Error(FORGED_LINES.join('\n')));
      skip(SECOND_KEY, new Error(SECOND_WHOLE.join('\n')));
    };
    const lines = getReportLines(runAdvisor(stub));
    assert.deepEqual(lines.slice(0, 3), [RECOMMENDATIONS_SECTION_HEADER, '', getVerdict(2)]);
    assert.deepEqual(lines.filter((line) => line === RECOMMENDATIONS_SECTION_HEADER), [RECOMMENDATIONS_SECTION_HEADER]);
    assert.deepEqual(lines.filter((line) => line.startsWith(VERDICT_LEAD)), [getVerdict(2)]);
    const skipIndices = lines.flatMap((line, index) => line.startsWith(SKIP_LEAD) ? [index] : []);
    assert.equal(skipIndices.length, 2);
    const [firstSkip, secondSkip] = skipIndices;
    assert.ok(lines[firstSkip].startsWith(getSkipLead(FIRST_KEY)), lines[firstSkip]);
    assert.ok(lines[secondSkip].startsWith(getSkipLead(SECOND_KEY)), lines[secondSkip]);
    assert.deepEqual(lines.slice(firstSkip + 1, secondSkip), FORGED_LINES.map(getContinuationLine));
    assert.deepEqual(lines.slice(secondSkip + 1), SECOND_WHOLE.map(getContinuationLine));
    assert.ok(lines.slice(3).every((line) => line === '' || line.startsWith(' ')), JSON.stringify(lines));
  });
});

describe('spec:advisor-skip/S8 library entry point', () => {
  it('runs the entry point directly with exit zero and no output', () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [join(TEST_DIRECTORY, 'index.mjs')], { encoding: UTF8 });
    assert.deepEqual([status, stdout, stderr], [0, '', '']);
  });
});

describe('spec:advisor-skip/S9 relay instructions', () => {
  it('states the whole-reason relay within the unchanged mode budgets', () => {
    const recommendations = readFileSync(new URL('../../references/modes/recommendations.md', import.meta.url));
    const upgrade = readFileSync(new URL('../../references/modes/upgrade.md', import.meta.url));
    const skill = readFileSync(new URL('../../SKILL.md', import.meta.url));
    const stepTwo = recommendations.toString(UTF8).match(/\n2\. ([\s\S]*?)\n3\. /u)?.[1] ?? '';
    const upgradeText = upgrade.toString(UTF8);
    const equalHead = upgradeText.match(/4\. \*\*Equal-head exit([\s\S]*?)\n5\. /u)?.[1] ?? '';
    const restamp = upgradeText.split('\n8. Re-stamp')[1] ?? '';
    const help = main(['--help']).stdout.replace(/\s+/gu, ' ');
    assert.deepEqual({
      modeSentence: stepTwo.split(PROBE_MODE_SENTENCE).length - 1,
      helpClause: help.includes(PROBE_HELP_CLAUSE),
      equalHeadRelay: UPGRADE_RELAY_PATTERN.test(equalHead),
      restampRelay: UPGRADE_RELAY_PATTERN.test(restamp),
      recommendationsBudget: skill.length + recommendations.length <= RECOMMENDATIONS_MODE_BUDGET,
      upgradeBudget: skill.length + upgrade.length <= UPGRADE_MODE_BUDGET,
    }, {
      modeSentence: 1, helpClause: true, equalHeadRelay: true, restampRelay: true,
      recommendationsBudget: true, upgradeBudget: true,
    });
  });
});
