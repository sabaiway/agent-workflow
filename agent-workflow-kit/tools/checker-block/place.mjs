import { composeRedBlock } from '../../references/scripts/shared/index.mjs';

const ROOT_PLACE = '.';
const PARENT_SEGMENT = '..';
const PATH_SEPARATOR = '/';
const LINE_MARKER = ':';
const FINDING_SEPARATOR = ': ';
const EMPTY_TEXT = '';
const SPACE = ' ';
const MIN_LINE = 1;
const TRAILING_SLASH = /\/$/;
const UNSAFE_PLACE = /[\\:\r\n]/;
const CARRIAGE_RETURN = /\r/g;
const LINE_FEED = /\n/g;
const LEADING_SPACE = /^ /;
const SHOWN_CARRIAGE_RETURN = '\\r';
const SHOWN_LINE_FEED = '\\n';
const SHOWN_LEADING_SPACE = '\\u0020';

const escapeLineBreaks = (text) => typeof text === 'string'
  ? text.replace(CARRIAGE_RETURN, SHOWN_CARRIAGE_RETURN).replace(LINE_FEED, SHOWN_LINE_FEED)
  : text;

export const escapeLineText = (text) => typeof text === 'string'
  ? escapeLineBreaks(text).replace(LEADING_SPACE, SHOWN_LEADING_SPACE) : text;

export const placeFinding = ({ root, name, path, line, laterLines = [] }) => {
  const rootPrefix = root.replace(TRAILING_SLASH, EMPTY_TEXT);
  const relative = path === (rootPrefix || PATH_SEPARATOR) ? ROOT_PLACE
    : typeof path === 'string' && path.startsWith(`${rootPrefix}${PATH_SEPARATOR}`)
      ? path.slice(rootPrefix.length + PATH_SEPARATOR.length) : path;
  if (relative === ROOT_PLACE && line === undefined) return { place: ROOT_PLACE, lead: EMPTY_TEXT };
  const lineSuffix = line === undefined ? EMPTY_TEXT : `${LINE_MARKER}${String(line)}`;
  const place = String(relative) + lineSuffix;
  const segments = typeof path === 'string'
    ? (path.startsWith(PATH_SEPARATOR) ? path.slice(PATH_SEPARATOR.length) : path).split(PATH_SEPARATOR)
    : [];
  const ownPlace = typeof path === 'string'
    && segments.every((segment) => segment !== EMPTY_TEXT && segment !== ROOT_PLACE && segment !== PARENT_SEGMENT)
    && relative !== EMPTY_TEXT && relative !== ROOT_PLACE && !UNSAFE_PLACE.test(relative)
    && !relative.startsWith(SPACE) && relative !== name
    && (line === undefined || (Number.isSafeInteger(line) && line >= MIN_LINE))
    && !laterLines.some((text) => typeof text === 'string' && text.startsWith(`${place}${FINDING_SEPARATOR}`));
  return ownPlace ? { place, lead: EMPTY_TEXT }
    : { place: ROOT_PLACE, lead: `${escapeLineText(String(path) + lineSuffix)}${FINDING_SEPARATOR}` };
};

const mapList = (list, transform) => Array.isArray(list) ? Array.from(list, transform) : list;

export const composeCheckerBlock = ({ name, root, failed, findings = [], remedies, after = [] }) => {
  const afterLines = mapList(after, escapeLineBreaks);
  const findingList = mapList(findings, (finding) => {
    if (finding === null || typeof finding !== 'object') return finding;
    const { path, line, text, detail } = finding;
    const { place, lead } = placeFinding({
      root, name, path, line, laterLines: Array.isArray(afterLines) ? afterLines : [],
    });
    return {
      place,
      text: typeof text === 'string' && text.length ? lead + escapeLineText(text) : text,
      ...(detail === undefined ? {} : { detail }),
    };
  });
  return composeRedBlock({
    name,
    failed: escapeLineText(failed),
    findings: findingList,
    remedies: mapList(remedies, escapeLineText),
    after: afterLines,
  });
};
