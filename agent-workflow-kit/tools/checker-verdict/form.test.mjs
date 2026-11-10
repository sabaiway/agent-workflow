import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const CHECKER_NAME = 'form-check';
const OTHER_CHECKER_NAME = 'other-check';
const FILE_PATH = 'src/check.mjs';
const OUTSIDE_FILE_PATH = '/outside/check.mjs';
const FILE_PLACE = `${FILE_PATH}:12`;
const DIRECTORY_PLACE = 'src/checks';
const FAILURE_TEXT = 'declared places differ';
const REMEDY_TEXT = 'restore the declared places';
const VERDICT_LINE = `${CHECKER_NAME}: FAIL — ${FAILURE_TEXT}`;
const REMEDY_LINE = `${CHECKER_NAME}: REMEDY — ${REMEDY_TEXT}`;
const FIRST_FINDING = `${FILE_PLACE}: the entry differs`;
const SECOND_FINDING = `${DIRECTORY_PLACE}: the store differs`;
const CONTINUATION_LINE = '  expected the declared entry';
const NESTED_CONTINUATION_LINE = '    found another entry';
const NOTE_LINE = 'Note: only declared places were checked';
const MACHINE_LINE = '{"checked":2}';
const DECLARED_PLACES = [FILE_PLACE, DIRECTORY_PLACE];
const BLOCK_OPTIONS = { name: CHECKER_NAME, places: DECLARED_PLACES };
const WELL_FORMED_LINES = [
  VERDICT_LINE,
  FIRST_FINDING,
  CONTINUATION_LINE,
  SECOND_FINDING,
  REMEDY_LINE,
  NOTE_LINE,
  MACHINE_LINE,
];
const WELL_FORMED_BLOCK = WELL_FORMED_LINES.join('\n');
const EXPECTED_MISS_KINDS = ['verdict', 'place', 'remedy'];

const replaceBlockLine = (replacedLine, ...replacementLines) => WELL_FORMED_LINES
  .flatMap((line) => line === replacedLine ? replacementLines : [line])
  .join('\n');

describe('verdict lines (spec:checker-verdict/S1)', () => {
  it('accepts the declared verdict line', async () => {
    const { judgeVerdictLine } = await import('./form.mjs');
    assert.equal(judgeVerdictLine(VERDICT_LINE, CHECKER_NAME), true);
  });

  it('accepts the unexpected-error verdict line', async () => {
    const { judgeVerdictLine } = await import('./form.mjs');
    const line = `${CHECKER_NAME}: FAIL — unexpected error: cannot read the store`;
    assert.equal(judgeVerdictLine(line, CHECKER_NAME), true);
  });

  it('rejects every near miss of the verdict form', async () => {
    const { judgeVerdictLine } = await import('./form.mjs');
    const cases = [
      ['REFUSE', `${CHECKER_NAME}: REFUSE — ${FAILURE_TEXT}`, false],
      ['REFUSED', `${CHECKER_NAME}: REFUSED — ${FAILURE_TEXT}`, false],
      ['refused', `${CHECKER_NAME}: refused — ${FAILURE_TEXT}`, false],
      ['another word', `${CHECKER_NAME}: ERROR — ${FAILURE_TEXT}`, false],
      ['bracketed name', `[${CHECKER_NAME}]: FAIL — ${FAILURE_TEXT}`, false],
      ['leading space', ` ${VERDICT_LINE}`, false],
      ['hyphen', `${CHECKER_NAME}: FAIL - ${FAILURE_TEXT}`, false],
      ['empty text', `${CHECKER_NAME}: FAIL — `, false],
      ['another checker', `${OTHER_CHECKER_NAME}: FAIL — ${FAILURE_TEXT}`, false],
      ['missing colon space', `${CHECKER_NAME}:FAIL — ${FAILURE_TEXT}`, false],
      ['extra colon space', `${CHECKER_NAME}:  FAIL — ${FAILURE_TEXT}`, false],
      ['missing dash space', `${CHECKER_NAME}: FAIL— ${FAILURE_TEXT}`, false],
      ['missing text space', `${CHECKER_NAME}: FAIL —${FAILURE_TEXT}`, false],
    ];
    for (const [label, line, expected] of cases) {
      assert.equal(judgeVerdictLine(line, CHECKER_NAME), expected, label);
    }
  });
});

describe('places and continuations (spec:checker-verdict/S2)', () => {
  it('accepts all three place forms and paths outside the project', async () => {
    const { judgePlace } = await import('./form.mjs');
    const cases = [
      ['relative file line', FILE_PLACE, true],
      ['whole file', FILE_PATH, true],
      ['directory', DIRECTORY_PLACE, true],
      ['project', '.', true],
      ['absolute file line outside the project', `${OUTSIDE_FILE_PATH}:1`, true],
      ['absolute file outside the project', OUTSIDE_FILE_PATH, true],
    ];
    for (const [label, place, expected] of cases) {
      assert.equal(judgePlace(place), expected, label);
    }
  });

  it('rejects paths and line numbers outside the place forms', async () => {
    const { judgePlace } = await import('./form.mjs');
    const cases = [
      ['backslash', 'src\\check.mjs', false],
      ['parent segment', 'src/../check.mjs', false],
      ['leading dot slash', `./${FILE_PATH}`, false],
      ['zero line number', `${FILE_PATH}:0`, false],
      ['negative line number', `${FILE_PATH}:-1`, false],
      ['fractional line number', `${FILE_PATH}:1.5`, false],
      ['non-decimal line number', `${FILE_PATH}:one`, false],
      ['empty place', '', false],
    ];
    for (const [label, place, expected] of cases) {
      assert.equal(judgePlace(place), expected, label);
    }
  });

  it('continues a finding and its continuation with two and four spaces', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(
      CONTINUATION_LINE,
      CONTINUATION_LINE,
      NESTED_CONTINUATION_LINE,
    );
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), []);
  });

  it('rejects an indented line directly under the verdict', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(VERDICT_LINE, VERDICT_LINE, CONTINUATION_LINE);
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['place']);
  });

  it('rejects a one-space line between findings', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(CONTINUATION_LINE, ' expected the declared entry');
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['place']);
  });
});

describe('remedy lines (spec:checker-verdict/S3)', () => {
  it('accepts the declared remedy line', async () => {
    const { judgeRemedyLine } = await import('./form.mjs');
    assert.equal(judgeRemedyLine(REMEDY_LINE, CHECKER_NAME), true);
  });

  it('rejects every near miss of the remedy form', async () => {
    const { judgeRemedyLine } = await import('./form.mjs');
    const cases = [
      ['another word', `${CHECKER_NAME}: FIX — ${REMEDY_TEXT}`, false],
      ['bracketed name', `[${CHECKER_NAME}]: REMEDY — ${REMEDY_TEXT}`, false],
      ['another checker', `${OTHER_CHECKER_NAME}: REMEDY — ${REMEDY_TEXT}`, false],
      ['empty text', `${CHECKER_NAME}: REMEDY — `, false],
      ['leading space', ` ${REMEDY_LINE}`, false],
      ['hyphen', `${CHECKER_NAME}: REMEDY - ${REMEDY_TEXT}`, false],
      ['missing colon space', `${CHECKER_NAME}:REMEDY — ${REMEDY_TEXT}`, false],
      ['extra colon space', `${CHECKER_NAME}:  REMEDY — ${REMEDY_TEXT}`, false],
      ['missing dash space', `${CHECKER_NAME}: REMEDY— ${REMEDY_TEXT}`, false],
      ['missing text space', `${CHECKER_NAME}: REMEDY —${REMEDY_TEXT}`, false],
    ];
    for (const [label, line, expected] of cases) {
      assert.equal(judgeRemedyLine(line, CHECKER_NAME), expected, label);
    }
  });
});

describe('block order and isolated miss kinds (spec:checker-verdict/S4)', () => {
  it('accepts findings, a continuation, a remedy and trailing matter in order', async () => {
    const { judgeBlock } = await import('./form.mjs');
    assert.deepEqual(judgeBlock(WELL_FORMED_BLOCK, BLOCK_OPTIONS), []);
  });

  it('reports only verdict for a note before the verdict', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = [NOTE_LINE, ...WELL_FORMED_LINES].join('\n');
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['verdict']);
  });

  it('reports only verdict for a stack before the verdict', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const stack = `Error: cannot read the store\n    at readStore (${FILE_PLACE}:3)`;
    const block = [stack, ...WELL_FORMED_LINES].join('\n');
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['verdict']);
  });

  it('reports only place when findings exchange their declared order', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const swappedFindings = new Map([
      [FIRST_FINDING, SECOND_FINDING],
      [SECOND_FINDING, FIRST_FINDING],
    ]);
    const block = WELL_FORMED_LINES
      .map((line) => swappedFindings.get(line) ?? line)
      .join('\n');
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['place']);
  });

  it('reports only place when a declared place is missing', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(SECOND_FINDING);
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['place']);
  });

  it('reports only place for a note between findings', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(SECOND_FINDING, NOTE_LINE, SECOND_FINDING);
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['place']);
  });

  it('reports only place for indentation directly under the verdict', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(VERDICT_LINE, VERDICT_LINE, CONTINUATION_LINE);
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['place']);
  });

  it('reports only place for a declared place opening a line after the remedy', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(REMEDY_LINE, REMEDY_LINE, SECOND_FINDING);
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['place']);
  });

  it('reports only remedy for findings without a remedy section', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = WELL_FORMED_LINES.slice(0, WELL_FORMED_LINES.indexOf(REMEDY_LINE)).join('\n');
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), ['remedy']);
  });

  it('reports all three kinds in order when no verdict line exists', async () => {
    const { judgeBlock } = await import('./form.mjs');
    const block = replaceBlockLine(VERDICT_LINE);
    assert.deepEqual(judgeBlock(block, BLOCK_OPTIONS), EXPECTED_MISS_KINDS);
  });
});

it('exports exactly the five interface names and the frozen ordered miss kinds', async () => {
  const door = await import('./index.mjs');
  assert.deepEqual(Object.keys(door).sort(), [
    'MISS_KINDS',
    'judgeBlock',
    'judgePlace',
    'judgeRemedyLine',
    'judgeVerdictLine',
  ].sort());
  assert.deepEqual(door.MISS_KINDS, EXPECTED_MISS_KINDS);
  assert.equal(Object.isFrozen(door.MISS_KINDS), true);
});
