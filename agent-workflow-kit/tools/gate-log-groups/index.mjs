const LF = '\n';
const EMPTY_TEXT = '';
const TEXT_TYPE = 'string';
const TEXT_ERROR = 'text must be a string';
const FIRST_INDEX = 0;
const SINGLE_ITEM = 1;
const PAIR_LENGTH = 2;
const TABLE_PREFIX_LENGTH = 2;
const ZERO_COUNT = 0;
const NO_FAILED_IDS = '-';
const ID_SEPARATOR = ',';
const SPAWN_FAILED_EXIT = '-1';
const BUFFER_ERROR_LINE = '   spawn error: ENOBUFS';
const GROUPED_OUTCOME = 'grouped';
const REFUSED_OUTCOME = 'refused';
const CUT_BEFORE_SUMMARY = 'cut-before-summary';
const NO_FAILED_GATE = 'no-failed-gate';
const TABLE_MISMATCH = 'table-mismatch';
const NO_HEADER_PAIR = 'no-header-pair';
const BLOCK_AMBIGUOUS = 'block-ambiguous';
const GATE_ID_SOURCE = '[a-z0-9]+(?:-[a-z0-9]+)*';
const EXIT_SOURCE = '(?:null|-?[0-9]+)';
const SUMMARY_PATTERN = new RegExp(
  '^\\[run-gates\\] status=(?<status>\\S+) gates=(?<gates>[0-9]+) passed=(?<passed>[0-9]+) '
  + `failed=(?<failed>[0-9]+) failed_ids=(?<failedIds>-|${GATE_ID_SOURCE}(?:,${GATE_ID_SOURCE})*) `
  + `coverage=(?<coverage>\\S+)$`,
);
const TABLE_HEADER_PATTERN = /^gate {2,}result$/;
const TABLE_ROW_PATTERN = new RegExp(
  `^(?<id>${GATE_ID_SOURCE}) {2,}(?:(?<passed>PASS)|FAIL \\(exit (?<exit>${EXIT_SOURCE})\\))`
  + `(?: {2}[\\s\\S]+)?$`,
);
const GATE_HEADER_PATTERN = new RegExp(
  `^\u2500\u2500 (?<id>${GATE_ID_SOURCE}) \u2014 (?<title>[\\s\\S]*)$`,
);
const GATE_STATUS_PATTERN = new RegExp(
  `^   (?:(?<passed>PASS)|FAIL exit=(?<exit>${EXIT_SOURCE})) \\((?<seconds>[^()]+)\\)$`,
);

export const GROUP_REFUSALS = Object.freeze([
  CUT_BEFORE_SUMMARY, NO_FAILED_GATE, TABLE_MISMATCH, NO_HEADER_PAIR, BLOCK_AMBIGUOUS,
]);

const createRefusal = (reason) => Object.freeze({ outcome: REFUSED_OUTCOME, reason });
const readTableRow = (text) => TABLE_ROW_PATTERN.exec(text)?.groups ?? null;

const findTables = (lines, summary) => lines.flatMap((text, openingIndex) => {
  if (text !== EMPTY_TEXT || !TABLE_HEADER_PATTERN.test(lines[openingIndex + SINGLE_ITEM])) return [];
  const rowsStart = openingIndex + TABLE_PREFIX_LENGTH;
  const rowsEnd = rowsStart + Number(summary.gates);
  const rows = lines.slice(rowsStart, rowsEnd).map(readTableRow);
  if (rows.length !== Number(summary.gates) || rows.some((row) => row === null)) return [];
  if (readTableRow(lines[rowsEnd]) !== null) return [];
  const failedIds = rows.filter((row) => !row.passed).map((row) => row.id);
  const passedCount = rows.filter((row) => row.passed).length;
  const expectedIds = summary.failedIds === NO_FAILED_IDS ? EMPTY_TEXT : summary.failedIds;
  return failedIds.join(ID_SEPARATOR) === expectedIds && passedCount === Number(summary.passed)
    ? [{ openingIndex, rows }]
    : [];
});

const findPairs = (row, lines) => lines.flatMap((text, headerIndex) => {
  const header = GATE_HEADER_PATTERN.exec(text)?.groups;
  const status = GATE_STATUS_PATTERN.exec(lines[headerIndex + SINGLE_ITEM])?.groups;
  return header?.id === row.id && status && Boolean(status.passed) === Boolean(row.passed) && status.exit === row.exit
    ? [{ headerIndex, title: header.title, exit: status.exit, seconds: status.seconds }]
    : [];
});

const createGroup = (row, pair, endIndex, lines) => {
  const outputStart = pair.headerIndex + PAIR_LENGTH;
  const outputLines = Object.freeze(lines.slice(outputStart, endIndex).map((text, index) =>
    Object.freeze({ line: outputStart + index + SINGLE_ITEM, text })));
  return Object.freeze({
    id: row.id,
    title: pair.title,
    exit: pair.exit,
    seconds: pair.seconds,
    headerLine: pair.headerIndex + SINGLE_ITEM,
    lines: outputLines,
    truncated: pair.exit === SPAWN_FAILED_EXIT && outputLines.at(-SINGLE_ITEM)?.text === BUFFER_ERROR_LINE,
  });
};

export const groupGateLog = (text) => {
  if (typeof text !== TEXT_TYPE) throw new TypeError(TEXT_ERROR);
  const splitLines = text.split(LF);
  const lines = text.endsWith(LF) ? splitLines.slice(FIRST_INDEX, -SINGLE_ITEM) : splitLines;
  const summaryIndex = lines.findLastIndex((line) => line.trim() !== EMPTY_TEXT);
  const summary = SUMMARY_PATTERN.exec(lines[summaryIndex])?.groups;
  if (!summary) return createRefusal(CUT_BEFORE_SUMMARY);
  if (Number(summary.failed) === ZERO_COUNT) return createRefusal(NO_FAILED_GATE);
  const tables = findTables(lines.slice(FIRST_INDEX, summaryIndex), summary);
  if (tables.length !== SINGLE_ITEM) return createRefusal(TABLE_MISMATCH);
  const table = tables[FIRST_INDEX];
  const blockLines = lines.slice(FIRST_INDEX, table.openingIndex);
  const rowPairs = table.rows.map((row) => findPairs(row, blockLines));
  if (rowPairs.some((pairs) => pairs.length === ZERO_COUNT)) return createRefusal(NO_HEADER_PAIR);
  const pairs = rowPairs.map((matches) => matches[FIRST_INDEX]);
  const repeatedPair = rowPairs.some((matches) => matches.length > SINGLE_ITEM);
  const reversedPair = pairs.some((pair, index) =>
    index > FIRST_INDEX && pair.headerIndex <= pairs[index - SINGLE_ITEM].headerIndex);
  const earlierHeader = blockLines.slice(FIRST_INDEX, pairs[FIRST_INDEX]?.headerIndex ?? FIRST_INDEX)
    .some((line) => GATE_HEADER_PATTERN.test(line));
  if (repeatedPair || reversedPair || earlierHeader) return createRefusal(BLOCK_AMBIGUOUS);
  const groups = Object.freeze(table.rows.flatMap((row, index) => row.passed ? [] : [
    createGroup(row, pairs[index], pairs[index + SINGLE_ITEM]?.headerIndex ?? table.openingIndex, lines),
  ]));
  const failedIds = Object.freeze(summary.failedIds === NO_FAILED_IDS ? [] : summary.failedIds.split(ID_SEPARATOR));
  const run = Object.freeze({
    status: summary.status,
    gates: summary.gates,
    passed: summary.passed,
    failed: summary.failed,
    failedIds,
    coverage: summary.coverage,
    summaryLine: summaryIndex + SINGLE_ITEM,
  });
  return Object.freeze({ outcome: GROUPED_OUTCOME, run, groups });
};
