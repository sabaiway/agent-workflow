// Contract: docs/ai/specs/kit/advisor-skip.md
import { isLineUnsafe, jsonForLine } from '../source-size-refusal.mjs';

export const SKIP_REASON_CAP = 200;

const EMPTY = '';
const SPACE = ' ';
const LINE_BREAK = /\r\n|\r|\n/u;
const UNPRINTABLE_REASON = 'unprintable error value';
const WHOLE_REASON_FOLLOWS = 'the whole reason follows';
const FOLD_NOTE = ` (${WHOLE_REASON_FOLLOWS})`;
const CUT_NOTE_START = '\u2026 (+';
const CUT_NOTE_END = ` more chars; ${WHOLE_REASON_FOLLOWS})`;
const SKIP_LEAD = '  \u26a0 skipped item ';
const PROBE_FAILED = ' \u2014 probe failed: ';
const CONTINUATION_LEAD = '      |';
const START_INDEX = 0;
const NEXT_INDEX_OFFSET = 1;
const LAST_INDEX = -1;
const NOT_FOUND = -1;

const readErrorText = (error) => {
  try {
    return String(error?.message ?? error);
  } catch {
    return UNPRINTABLE_REASON;
  }
};

const escapeCodePoint = (codePoint) => isLineUnsafe(codePoint)
  ? jsonForLine(codePoint).slice(NEXT_INDEX_OFFSET, LAST_INDEX)
  : codePoint;

const escapeLine = (line) => Array.from(line, escapeCodePoint).join(EMPTY);
const hasText = (line) => line.trim() !== EMPTY;
const formatCutNote = (droppedLength) => `${CUT_NOTE_START}${droppedLength}${CUT_NOTE_END}`;

const cutSummary = (summary, pieces) => {
  const prefixLengths = [START_INDEX];
  for (const piece of pieces.slice(START_INDEX, SKIP_REASON_CAP)) {
    prefixLengths.push(prefixLengths.at(LAST_INDEX) + piece.length);
  }
  const prefixLength = prefixLengths.findLast((length) =>
    length + formatCutNote(summary.length - length).length <= SKIP_REASON_CAP
  ) ?? START_INDEX;
  return summary.slice(START_INDEX, prefixLength) + formatCutNote(summary.length - prefixLength);
};

export const composeSkip = (key, error) => {
  const lines = readErrorText(error).split(LINE_BREAK);
  const firstLineIndex = lines.findIndex(hasText);
  if (firstLineIndex === NOT_FOUND) return { key, reason: EMPTY };

  const lastLineIndex = lines.findLastIndex(hasText);
  const countingLines = lines.slice(firstLineIndex, lastLineIndex + NEXT_INDEX_OFFSET);
  const trimmedLines = countingLines.map((line) => line.trim()).filter(Boolean);
  const [, secondLine] = trimmedLines;
  const isFolded = secondLine !== undefined;
  const pieces = Array.from(trimmedLines.join(SPACE), escapeCodePoint);
  const summary = pieces.join(EMPTY);
  if (!isFolded && summary.length <= SKIP_REASON_CAP) return { key, reason: summary };

  const reason = isFolded && summary.length + FOLD_NOTE.length <= SKIP_REASON_CAP
    ? summary + FOLD_NOTE
    : cutSummary(summary, pieces);
  const whole = countingLines.map((line) => hasText(line) ? escapeLine(line) : EMPTY);
  return { key, reason, whole };
};

export const renderSkip = ({ key, reason, whole }) => [
  `${SKIP_LEAD}${escapeLine(key)}${PROBE_FAILED}${reason}`,
  ...(whole?.map((entry) => entry === EMPTY ? CONTINUATION_LEAD : `${CONTINUATION_LEAD}${SPACE}${entry}`) ?? []),
];
