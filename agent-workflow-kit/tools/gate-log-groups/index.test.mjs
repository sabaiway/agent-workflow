import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runGates, formatTable, composeSummaryLine, runCli, EXIT, BASH_PROBE_CMD } from '../run-gates.mjs';
import { GATES_REL, FINAL_CORE_CHECKS, matchesCanonicalCheck } from '../gates-declaration.mjs';

const LF = '\n';
const FIRST_INDEX = 0;
const LAST_ITEM_OFFSET = 1;
const LINE_NUMBER_BASE = 1;
const SECONDS_CAPTURE_INDEX = 1;
const COVERAGE_CHECK_INDEX = 1;
const DROPPED_HEADER_COUNT = 1;
const DROPPED_SUMMARY_COUNT = 1;
const PRINTED_PAIR_CALL_COUNT = 2;
const PRINTED_GATE_CALL_COUNT = 3;
const OUTPUT_CALL_INDEX = 2;
const FIRST_CLI_FAILURE_STATUS_INDEX = 3;
const SECOND_CLI_FAILURE_STATUS_INDEX = 7;
const CLOCK_CALLS_PER_GATE = 2;
const ELAPSED_MILLISECONDS = 1500;
const PASS_CODE = 0;
const FAIL_CODE = 1;
const BLANK_TRAILER_COUNT = 2;
const FAILURE_STATUS = 'fail';
const NO_COVERAGE = 'none';
const TEXT_ENCODING = 'utf8';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNNER_PATH = fileURLToPath(new URL('../run-gates.mjs', import.meta.url));
const SOURCE_SIZE_COMMAND = `node ${fileURLToPath(new URL('../source-size-check.mjs', import.meta.url))} --check`;
const COVERAGE_COMMAND = `node ${fileURLToPath(new URL('../coverage-check.mjs', import.meta.url))} --check`;
const SOURCE_WARNING = 'source-size: WARNING — printed warning';
const COVERAGE_OUTPUT = 'coverage-check: attested=no\ncoverage-check: lcov-sha256=none\ncoverage-check: NO VERDICT\n';
const EXPECTED_ALPHA = { id: 'a', title: 'Alpha', exit: '1', seconds: '1.5s', headerLine: 1, lines: [{ line: 3, text: 'alpha' }], truncated: false };
const EXPECTED_BETA = { id: 'b', title: 'Beta', exit: '1', seconds: '1.5s', headerLine: 4, lines: [{ line: 6, text: 'beta' }], truncated: false };
const EXPECTED_SINGLE_RUN = { status: 'fail', gates: '1', passed: '0', failed: '1', failedIds: ['a'], coverage: 'none', summaryLine: 7 };
const EXPECTED_DOUBLE_RUN = { status: 'fail', gates: '2', passed: '0', failed: '2', failedIds: ['a', 'b'], coverage: 'none', summaryLine: 11 };

const createClock = (gateCount) => {
  const ticks = Array.from({ length: gateCount * CLOCK_CALLS_PER_GATE }, (_, index) => index * ELAPSED_MILLISECONDS).values();
  return () => ticks.next().value;
};
const createGate = (id = 'a', title = 'Alpha', stdout = 'alpha\n', response = {}, command = id) => ({
  gate: { id, title, cmd: command }, response: { status: FAIL_CODE, stdout, stderr: '', error: null, ...response },
});
const joinPrintedCalls = (calls) => calls.map((call) => `${call}${LF}`).join('');
const printRun = (cells, { status = FAILURE_STATUS, coverage = NO_COVERAGE, cwd = ROOT, notes = new Map() } = {}) => {
  const calls = [];
  const responses = new Map(cells.map((cell) => [cell.gate.cmd, cell.response]));
  const results = runGates(cells.map((cell) => cell.gate), {
    cwd, spawn: (command) => responses.get(command), now: createClock(cells.length), log: (call) => calls.push(call),
  });
  const table = formatTable(results, notes);
  calls.push(...table, composeSummaryLine({ status, results, coverage }));
  return { calls, results, table, text: joinPrintedCalls(calls) };
};
const assertPrinted = (text, entries) => {
  const lines = text.split(LF);
  for (const [line, expectedText] of entries) assert.equal(lines[line - LINE_NUMBER_BASE], expectedText);
};
const createTemporaryProject = (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'gate-log-groups-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const printSpawnError = () => printRun([createGate('error', 'Error', '', { error: { code: 'ENOBUFS' } })]).calls[OUTPUT_CALL_INDEX];
const printAmbiguous = () => {
  const later = printRun([createGate('b', 'Beta', 'beta\n')]);
  return printRun([createGate('a', 'Alpha', joinPrintedCalls(later.calls.slice(FIRST_INDEX, PRINTED_PAIR_CALL_COUNT))), createGate('b', 'Beta', 'beta\n')]);
};
const printTableCollision = () => {
  const matching = printRun([createGate(), createGate('b', 'Beta', 'beta\n')]);
  return printRun([createGate('a', 'Alpha', joinPrintedCalls(matching.table)), createGate('b', 'Beta', 'beta\n')]);
};
const printCliRun = (context, argv, cells) => {
  const cwd = createTemporaryProject(context);
  const calls = [];
  const responses = new Map(cells.map((cell) => [cell.gate.cmd, cell.response]));
  const declaration = JSON.stringify({ gates: cells.map((cell) => cell.gate) });
  const code = runCli(argv, {
    cwd, env: {}, log: (call) => calls.push(call), logError: (call) => calls.push(call), now: createClock(cells.length),
    spawn: (command) => command === BASH_PROBE_CMD ? { status: PASS_CODE, stdout: '', stderr: '', error: null } : responses.get(command),
    readFile: (path, encoding) => { assert.equal(path, join(cwd, GATES_REL)); assert.equal(encoding, TEXT_ENCODING); return declaration; },
    lstat: (path) => { assert.equal(path, join(cwd, GATES_REL)); return {}; },
  });
  assert.equal(code, EXIT.fail);
  return { text: joinPrintedCalls(calls), cwd };
};
const assertDeepFrozen = (value) => {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(assertDeepFrozen);
};

describe('spec:gate-log-groups/S1 real CLI failures', () => {
  it('keeps two failures in run order with printed timing and counts', async (context) => {
    const cwd = createTemporaryProject(context);
    mkdirSync(join(cwd, 'docs/ai'), { recursive: true });
    writeFileSync(join(cwd, GATES_REL), JSON.stringify({ gates: [
      { id: 'pass', title: 'Passed', cmd: "printf 'hidden\\n'" },
      { id: 'a', title: 'Alpha', cmd: "printf 'alpha\\n'; printf 'error\\n' >&2; exit 3" },
      { id: 'b', title: 'Beta', cmd: "printf 'beta\\n'; exit 1" },
    ] }));
    const execution = spawnSync(process.execPath, [RUNNER_PATH, '--cwd', cwd], { encoding: TEXT_ENCODING });
    assert.equal(execution.stderr, '');
    assert.equal(execution.status, EXIT.fail);
    assertPrinted(execution.stdout, [[1, '── pass — Passed'], [3, '── a — Alpha'], [5, 'alpha'], [6, 'error'], [7, '── b — Beta'], [9, 'beta'], [10, ''], [11, 'gate  result'], [12, 'pass  PASS'], [13, 'a     FAIL (exit 3)'], [14, 'b     FAIL (exit 1)'], [15, '[run-gates] status=fail gates=3 passed=1 failed=2 failed_ids=a,b coverage=none']]);
    const firstStatus = execution.stdout.split(LF)[FIRST_CLI_FAILURE_STATUS_INDEX];
    const secondStatus = execution.stdout.split(LF)[SECOND_CLI_FAILURE_STATUS_INDEX];
    assert.match(firstStatus, /^   FAIL exit=3 \(\d+\.\ds\)$/);
    assert.match(secondStatus, /^   FAIL exit=1 \(\d+\.\ds\)$/);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(execution.stdout), { outcome: 'grouped',
      run: { status: 'fail', gates: '3', passed: '1', failed: '2', failedIds: ['a', 'b'], coverage: 'none', summaryLine: 15 },
      groups: [
        { id: 'a', title: 'Alpha', exit: '3', seconds: firstStatus.match(/\(([^)]+)\)$/)[SECONDS_CAPTURE_INDEX], headerLine: 3, lines: [{ line: 5, text: 'alpha' }, { line: 6, text: 'error' }], truncated: false },
        { id: 'b', title: 'Beta', exit: '1', seconds: secondStatus.match(/\(([^)]+)\)$/)[SECONDS_CAPTURE_INDEX], headerLine: 7, lines: [{ line: 9, text: 'beta' }], truncated: false },
      ] });
  });
});

describe('spec:gate-log-groups/S2 verbatim lines and passing warnings', () => {
  it('keeps CR, blanks, stderr, a table-shaped row and constructor', async () => {
    const row = printRun([createGate('row', 'Row')]).table.at(-LAST_ITEM_OFFSET);
    assert.equal(row, 'row   FAIL (exit 1)');
    const printed = printRun([
      createGate('a', 'Alpha — detail', `a\r\nb\r\n\n${row}\n`, { stderr: 'error\n' }),
      createGate('size', 'Size', `${SOURCE_WARNING}\nignored\n`, { status: PASS_CODE }, SOURCE_SIZE_COMMAND),
      createGate('constructor', 'Constructor', 'constructor output\n'),
    ]);
    assertPrinted(printed.text, [[3, 'a\r'], [4, 'b\r'], [5, ''], [6, 'row   FAIL (exit 1)'], [7, 'error'], [8, '── size — Size'], [9, '   PASS (1.5s)'], [10, 'source-size: WARNING — printed warning'], [11, '── constructor — Constructor'], [13, 'constructor output'], [19, '[run-gates] status=fail gates=3 passed=1 failed=2 failed_ids=a,constructor coverage=none']]);
    assert.ok(!printed.text.includes('ignored'));
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(printed.text), { outcome: 'grouped',
      run: { status: 'fail', gates: '3', passed: '1', failed: '2', failedIds: ['a', 'constructor'], coverage: 'none', summaryLine: 19 },
      groups: [
        { id: 'a', title: 'Alpha — detail', exit: '1', seconds: '1.5s', headerLine: 1, lines: [{ line: 3, text: 'a\r' }, { line: 4, text: 'b\r' }, { line: 5, text: '' }, { line: 6, text: 'row   FAIL (exit 1)' }, { line: 7, text: 'error' }], truncated: false },
        { id: 'constructor', title: 'Constructor', exit: '1', seconds: '1.5s', headerLine: 11, lines: [{ line: 13, text: 'constructor output' }], truncated: false },
      ] });
  });
});

describe('spec:gate-log-groups/S3 truncation follows the final spawn error', () => {
  const cases = [
    { title: 'marks ENOBUFS spawn failure', response: { error: { code: 'ENOBUFS' } }, printOutput: () => 'partial\n', exit: '-1', lines: [{ line: 3, text: 'partial' }, { line: 4, text: '   spawn error: ENOBUFS' }], truncated: true, nextHeader: 5 },
    { title: 'keeps EACCES untruncated', response: { error: { code: 'EACCES' } }, printOutput: () => 'partial\n', exit: '-1', lines: [{ line: 3, text: 'partial' }, { line: 4, text: '   spawn error: EACCES' }], truncated: false, nextHeader: 5 },
    { title: 'keeps an exit-one imitation untruncated', response: {}, printOutput: () => `partial\n${printSpawnError()}\n`, exit: '1', lines: [{ line: 3, text: 'partial' }, { line: 4, text: '   spawn error: ENOBUFS' }], truncated: false, nextHeader: 5 },
    { title: 'keeps an interior ENOBUFS line untruncated', response: {}, printOutput: () => `${printSpawnError()}\nafter\n`, exit: '1', lines: [{ line: 3, text: '   spawn error: ENOBUFS' }, { line: 4, text: 'after' }], truncated: false, nextHeader: 5 },
    { title: 'keeps a signal exit as printed null', response: { status: null }, printOutput: () => 'partial\n', exit: 'null', lines: [{ line: 3, text: 'partial' }], truncated: false, nextHeader: 4 },
  ];
  for (const cell of cases) it(cell.title, async () => {
    const printed = printRun([createGate('a', 'Alpha', cell.printOutput(), cell.response), createGate('b', 'Beta', '', { status: PASS_CODE })]);
    assertPrinted(printed.text, [[2, `   FAIL exit=${cell.exit} (1.5s)`], ...cell.lines.map(({ line, text }) => [line, text]), [cell.nextHeader, '── b — Beta']]);
    const { groupGateLog } = await import('./index.mjs');
    const result = groupGateLog(printed.text);
    assert.equal(result.outcome, 'grouped');
    assert.deepEqual(result.groups, [{ id: 'a', title: 'Alpha', exit: cell.exit, seconds: '1.5s', headerLine: 1, lines: cell.lines, truncated: cell.truncated }]);
  });
});

describe('spec:gate-log-groups/S4 refusals and their precedence', () => {
  it('refuses cut-before-summary for a tail cut and an empty cut', async () => {
    const printed = printRun([createGate()]);
    const cut = joinPrintedCalls(printed.calls.slice(FIRST_INDEX, -DROPPED_SUMMARY_COUNT));
    const empty = printed.text.slice(printed.text.length);
    assert.ok(cut.endsWith('a     FAIL (exit 1)\n'));
    assert.equal(empty, '');
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(cut), { outcome: 'refused', reason: 'cut-before-summary' });
    assert.deepEqual(groupGateLog(empty), { outcome: 'refused', reason: 'cut-before-summary' });
  });
  it('refuses no-failed-gate for passing results under either status', async () => {
    const passing = [createGate('a', 'Alpha', '', { status: PASS_CODE })];
    const ordinary = printRun(passing, { status: 'ok' }).text;
    const failingStatus = printRun(passing, { status: 'fail' }).text;
    assertPrinted(ordinary, [[2, '   PASS (1.5s)'], [6, '[run-gates] status=ok gates=1 passed=1 failed=0 failed_ids=- coverage=none']]);
    assertPrinted(failingStatus, [[2, '   PASS (1.5s)'], [6, '[run-gates] status=fail gates=1 passed=1 failed=0 failed_ids=- coverage=none']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(ordinary), { outcome: 'refused', reason: 'no-failed-gate' });
    assert.deepEqual(groupGateLog(failingStatus), { outcome: 'refused', reason: 'no-failed-gate' });
  });
  it('refuses table-mismatch for a whole matching table inside a failing output', async () => {
    const { text } = printTableCollision();
    assertPrinted(text, [[3, ''], [4, 'gate  result'], [5, 'a     FAIL (exit 1)'], [6, 'b     FAIL (exit 1)'], [10, ''], [11, 'gate  result'], [12, 'a     FAIL (exit 1)'], [13, 'b     FAIL (exit 1)'], [14, '[run-gates] status=fail gates=2 passed=0 failed=2 failed_ids=a,b coverage=none']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(text), { outcome: 'refused', reason: 'table-mismatch' });
  });
  it('refuses no-header-pair for a lost header and an LF title', async () => {
    const cut = printRun([createGate()]).text.split(LF).slice(DROPPED_HEADER_COUNT).join(LF);
    const multiline = printRun([createGate('a', 'Alpha\ncontinued')]).text;
    assertPrinted(cut, [[1, '   FAIL exit=1 (1.5s)'], [2, 'alpha'], [6, '[run-gates] status=fail gates=1 passed=0 failed=1 failed_ids=a coverage=none']]);
    assertPrinted(multiline, [[1, '── a — Alpha'], [2, 'continued'], [3, '   FAIL exit=1 (1.5s)']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(cut), { outcome: 'refused', reason: 'no-header-pair' });
    assert.deepEqual(groupGateLog(multiline), { outcome: 'refused', reason: 'no-header-pair' });
  });
  it('refuses block-ambiguous for a later gate pair inside an earlier output', async () => {
    const { text } = printAmbiguous();
    assertPrinted(text, [[3, '── b — Beta'], [4, '   FAIL exit=1 (1.5s)'], [5, '── b — Beta'], [6, '   FAIL exit=1 (1.5s)']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(text), { outcome: 'refused', reason: 'block-ambiguous' });
  });
  it('chooses table-mismatch before no-header-pair', async () => {
    const cut = printTableCollision().text.split(LF).slice(DROPPED_HEADER_COUNT).join(LF);
    assertPrinted(cut, [[1, '   FAIL exit=1 (1.5s)'], [2, ''], [3, 'gate  result'], [4, 'a     FAIL (exit 1)'], [5, 'b     FAIL (exit 1)'], [9, ''], [10, 'gate  result'], [11, 'a     FAIL (exit 1)'], [12, 'b     FAIL (exit 1)'], [13, '[run-gates] status=fail gates=2 passed=0 failed=2 failed_ids=a,b coverage=none']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(cut), { outcome: 'refused', reason: 'table-mismatch' });
  });
  it('allows blank lines after the summary', async () => {
    const text = printRun([createGate()]).text + LF.repeat(BLANK_TRAILER_COUNT);
    assert.ok(text.endsWith('coverage=none\n\n\n'));
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(text), { outcome: 'grouped', run: EXPECTED_SINGLE_RUN, groups: [EXPECTED_ALPHA] });
  });
  it('exports the frozen refusal order', async () => {
    const { GROUP_REFUSALS } = await import('./index.mjs');
    assert.deepEqual(GROUP_REFUSALS, ['cut-before-summary', 'no-failed-gate', 'table-mismatch', 'no-header-pair', 'block-ambiguous']);
    assert.ok(Object.isFrozen(GROUP_REFUSALS));
  });
});

describe('spec:gate-log-groups/S5 runner-shaped gate output', () => {
  it('keeps a header without a following status inside the earlier group', async () => {
    const later = printRun([createGate('b', 'Beta', 'beta\n')]);
    const { text } = printRun([createGate('a', 'Alpha', `before\n${later.calls[FIRST_INDEX]}\nafter\n`), createGate('b', 'Beta', 'beta\n')]);
    assertPrinted(text, [[3, 'before'], [4, '── b — Beta'], [5, 'after'], [6, '── b — Beta'], [7, '   FAIL exit=1 (1.5s)'], [13, '[run-gates] status=fail gates=2 passed=0 failed=2 failed_ids=a,b coverage=none']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(text), { outcome: 'grouped', run: { ...EXPECTED_DOUBLE_RUN, summaryLine: 13 }, groups: [
      { ...EXPECTED_ALPHA, lines: [{ line: 3, text: 'before' }, { line: 4, text: '── b — Beta' }, { line: 5, text: 'after' }] },
      { ...EXPECTED_BETA, headerLine: 6, lines: [{ line: 8, text: 'beta' }] },
    ] });
  });
  it('refuses a cut at an inner summary while the outer pair remains', async () => {
    const inner = printRun([createGate('b', 'Beta', 'beta\n')]);
    const outer = printRun([createGate('a', 'Alpha', inner.text)]);
    const text = joinPrintedCalls(outer.calls.slice(FIRST_INDEX, PRINTED_GATE_CALL_COUNT));
    assertPrinted(text, [[1, '── a — Alpha'], [2, '   FAIL exit=1 (1.5s)'], [3, '── b — Beta'], [4, '   FAIL exit=1 (1.5s)'], [9, '[run-gates] status=fail gates=1 passed=0 failed=1 failed_ids=b coverage=none']]);
    assert.ok(text.endsWith('failed_ids=b coverage=none\n'));
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(text), { outcome: 'refused', reason: 'block-ambiguous' });
  });
});

describe('spec:gate-log-groups/S6 CLI notes stay outside groups', () => {
  it('excludes the unarmed pre-review note after the table', async (context) => {
    const { text } = printCliRun(context, ['--pre-review'], [createGate()]);
    assertPrinted(text, [[5, 'gate  result'], [6, 'a     FAIL (exit 1)'], [7, '[run-gates] "a" failed under --pre-review — review-dependent? declare it in docs/ai/orchestration.json flow.pregateExclude and the subset will skip it (a declared exclude opens a FRESH counting context — the subsetDigest changes)'], [8, '[run-gates] status=fail gates=1 passed=0 failed=1 failed_ids=a coverage=none']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(text), { outcome: 'grouped', run: { ...EXPECTED_SINGLE_RUN, summaryLine: 8 }, groups: [EXPECTED_ALPHA] });
  });
  it('excludes the coverage table note and header-shaped verdict block', async (context) => {
    const { text, cwd } = printCliRun(context, [], [createGate(), createGate('coverage', 'Coverage', COVERAGE_OUTPUT, { status: PASS_CODE }, COVERAGE_COMMAND)]);
    assert.ok(matchesCanonicalCheck(FINAL_CORE_CHECKS[COVERAGE_CHECK_INDEX], COVERAGE_COMMAND, cwd));
    assertPrinted(text, [[4, '── coverage — Coverage'], [5, '   PASS (1.5s)'], [7, 'gate      result'], [9, 'coverage  PASS  coverage=not-run (no lcov bytes were read; no coverage verdict was issued)'], [10, '── coverage — NO COVERAGE VERDICT (the gate passed; it did not certify)'], [11, 'coverage-check: NO VERDICT'], [12, '   A coverage verdict is issued only by run-gates.mjs --final, which owns the lcov for the whole run.'], [13, '[run-gates] status=fail gates=2 passed=1 failed=1 failed_ids=a coverage=not-run']]);
    const { groupGateLog } = await import('./index.mjs');
    assert.deepEqual(groupGateLog(text), { outcome: 'grouped',
      run: { status: 'fail', gates: '2', passed: '1', failed: '1', failedIds: ['a'], coverage: 'not-run', summaryLine: 13 }, groups: [EXPECTED_ALPHA] });
  });
});

describe('spec:gate-log-groups/S7 frozen results and public surface', () => {
  it('freezes every grouped object and array and exposes exactly the result keys', async () => {
    const { text } = printRun([createGate(), createGate('b', 'Beta', 'beta\n')]);
    assertPrinted(text, [[1, '── a — Alpha'], [3, 'alpha'], [4, '── b — Beta'], [6, 'beta'], [11, '[run-gates] status=fail gates=2 passed=0 failed=2 failed_ids=a,b coverage=none']]);
    const { groupGateLog } = await import('./index.mjs');
    const result = groupGateLog(text);
    assert.deepEqual(result, { outcome: 'grouped', run: EXPECTED_DOUBLE_RUN, groups: [EXPECTED_ALPHA, EXPECTED_BETA] });
    assertDeepFrozen(result);
    assert.deepEqual(Object.keys(result).sort(), ['groups', 'outcome', 'run']);
    assert.deepEqual(Object.keys(result.run).sort(), ['coverage', 'failed', 'failedIds', 'gates', 'passed', 'status', 'summaryLine']);
    for (const group of result.groups) {
      assert.deepEqual(Object.keys(group).sort(), ['exit', 'headerLine', 'id', 'lines', 'seconds', 'title', 'truncated']);
      for (const line of group.lines) assert.deepEqual(Object.keys(line).sort(), ['line', 'text']);
    }
  });
  it('freezes the refused result with exactly its two keys', async () => {
    const printed = printRun([createGate()]);
    const text = joinPrintedCalls(printed.calls.slice(FIRST_INDEX, -DROPPED_SUMMARY_COUNT));
    assert.ok(text.endsWith('a     FAIL (exit 1)\n'));
    const { groupGateLog } = await import('./index.mjs');
    const result = groupGateLog(text);
    assert.deepEqual(result, { outcome: 'refused', reason: 'cut-before-summary' });
    assertDeepFrozen(result);
    assert.deepEqual(Object.keys(result).sort(), ['outcome', 'reason']);
  });
  const invalidInputs = [['undefined', undefined], ['null', null], ['number', 42], ['Buffer', Buffer.from('text')]];
  for (const [title, value] of invalidInputs) it(`rejects ${title} with a TypeError naming text`, async () => {
    const { groupGateLog } = await import('./index.mjs');
    assert.throws(() => groupGateLog(value), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /\btext\b/);
      return true;
    });
  });
  it('exports exactly the two public names', async () => {
    const moduleUnderTest = await import('./index.mjs');
    assert.deepEqual(Object.keys(moduleUnderTest).sort(), ['GROUP_REFUSALS', 'groupGateLog']);
  });
});
