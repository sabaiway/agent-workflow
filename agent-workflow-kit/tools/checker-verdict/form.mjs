export const MISS_KINDS = Object.freeze(['verdict', 'place', 'remedy']);

const LINE_BREAK = /[\r\n]/;
const LINE_NUMBER = /^[1-9][0-9]*$/;
const FINDING_SEPARATOR = ': ';
const CONTINUATION_PREFIX = '  ';

const judgeNamedLine = (line, name, word) => {
  const prefix = `${name}: ${word} — `;
  return typeof line === 'string'
    && line.startsWith(prefix)
    && line.length > prefix.length
    && line[prefix.length] !== ' '
    && !LINE_BREAK.test(line);
};

export const judgeVerdictLine = (line, name) => judgeNamedLine(line, name, 'FAIL');

export const judgeRemedyLine = (line, name) => judgeNamedLine(line, name, 'REMEDY');

export const judgePlace = (place) => {
  if (typeof place !== 'string') return false;
  const colonIndex = place.lastIndexOf(':');
  const path = colonIndex < 0 ? place : place.slice(0, colonIndex);
  const lineNumber = place.slice(colonIndex + 1);
  const hasLine = colonIndex < 0 || LINE_NUMBER.exec(lineNumber)?.[0] === lineNumber;
  return path.length > 0
    && hasLine
    && !path.includes('\\')
    && !path.startsWith('./')
    && !path.split('/').includes('..');
};

const judgeFindingLine = (line, places) => places.some((place) =>
  line.startsWith(`${place}${FINDING_SEPARATOR}`));

const collectFindingLines = (lines, places) => lines.reduce((state, line) => {
  if (state.followsFinding && line.startsWith(CONTINUATION_PREFIX)) return state;
  return {
    lines: [...state.lines, line],
    followsFinding: judgeFindingLine(line, places),
  };
}, { lines: [], followsFinding: false }).lines;

export const judgeBlock = (block, { name, places }) => {
  const lines = block.split('\n');
  const verdictIndex = lines.findIndex((line) => judgeVerdictLine(line, name));
  if (verdictIndex < 0) return [...MISS_KINDS];
  const followingLines = lines.slice(verdictIndex + 1);
  const remedyIndex = followingLines.findIndex((line) => judgeRemedyLine(line, name));
  const findingLines = collectFindingLines(
    remedyIndex < 0 ? followingLines : followingLines.slice(0, remedyIndex),
    places,
  );
  const matchesPlaces = findingLines.length === places.length
    && findingLines.every((line, index) =>
      line.startsWith(`${places[index]}${FINDING_SEPARATOR}`));
  const hasLateFinding = remedyIndex >= 0 && followingLines.slice(remedyIndex + 1)
    .some((line) => judgeFindingLine(line, places));
  const misses = [verdictIndex !== 0, !matchesPlaces || hasLateFinding, remedyIndex < 0];
  return MISS_KINDS.filter((kind, index) => misses[index]);
};
