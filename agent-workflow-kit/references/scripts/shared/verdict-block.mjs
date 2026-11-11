// verdict-block: the red block composer (spec verdict-block).
const LINE_BREAK = /[\r\n]/;
const LINE_SEPARATOR = /\r\n|[\r\n]/;
const KEBAB_WORD = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LINE_NUMBER = /^[1-9][0-9]*$/;
const FINDING_SEPARATOR = ': ';
const DETAIL_PREFIX = '  ';
const VERDICT_WORD = 'FAIL';
const REMEDY_WORD = 'REMEDY';
const NO_MESSAGE = 'no message';
const MIN_EXIT_CODE = 1;
const MAX_EXIT_CODE = 255;
const NOT_FOUND = -1;

const refuseField = (field) => { throw new TypeError(`Invalid ${field}`); };

const validateName = (name) => {
  if (typeof name !== 'string' || KEBAB_WORD.exec(name)?.[0] !== name) refuseField('name');
};

const validateLine = (line, field, allowEmpty = false, allowIndent = false) => {
  if (typeof line !== 'string' || LINE_BREAK.test(line)
    || (!allowEmpty && !line.length) || (!allowIndent && line.startsWith(' '))) refuseField(field);
  return line;
};

const validateList = (list, field) => {
  if (!Array.isArray(list)) refuseField(field);
  return Array.from(list);
};

const formatNamedLine = (name, word, text) => `${name}: ${word} — ${text}`;

const judgeNamedLine = (line, name, word) => {
  const prefix = formatNamedLine(name, word, '');
  return line.startsWith(prefix) && line.length > prefix.length && line[prefix.length] !== ' ';
};

const validatePlace = (place) => {
  validateLine(place, 'place');
  const colonIndex = place.lastIndexOf(':');
  const path = colonIndex === NOT_FOUND ? place : place.slice(0, colonIndex);
  const lineNumber = place.slice(colonIndex + 1);
  if (!path.length || path.includes('\\') || path.startsWith('./') || path.split('/').includes('..')
    || (colonIndex !== NOT_FOUND && LINE_NUMBER.exec(lineNumber)?.[0] !== lineNumber)) refuseField('place');
};

const composeFinding = (finding, name) => {
  if (finding === null || typeof finding !== 'object') refuseField('findings');
  validatePlace(finding.place);
  validateLine(finding.text, 'text');
  const line = `${finding.place}${FINDING_SEPARATOR}${finding.text}`;
  if ([VERDICT_WORD, REMEDY_WORD].some((word) => judgeNamedLine(line, name, word))) refuseField('findings');
  const detail = validateList(finding.detail === undefined ? [] : finding.detail, 'detail');
  return [line, ...detail.map((text) => `${DETAIL_PREFIX}${validateLine(text, 'detail', false, true)}`)];
};

const validateLateLine = (line, places, field) => {
  if (places.some((place) => line.startsWith(`${place}${FINDING_SEPARATOR}`))) refuseField(field);
  return line;
};

export const composeRedBlock = ({ name, failed, findings = [], remedies, after = [] }) => {
  validateName(name);
  validateLine(failed, 'failed');
  const findingList = validateList(findings, 'findings');
  const findingLines = findingList.flatMap((finding) => composeFinding(finding, name));
  const places = findingList.map((finding) => finding.place);
  const remedyList = validateList(remedies, 'remedies');
  if (!remedyList.length) refuseField('remedies');
  const remedyLines = remedyList.map((remedy, index) => {
    const line = formatNamedLine(name, REMEDY_WORD, validateLine(remedy, 'remedies'));
    return index === 0 ? line : validateLateLine(line, places, 'remedies');
  });
  const afterLines = validateList(after, 'after').map((line) =>
    validateLateLine(validateLine(line, 'after', true, true), places, 'after'));
  return Object.freeze([formatNamedLine(name, VERDICT_WORD, failed), ...findingLines, ...remedyLines, ...afterLines]);
};

export const composeUsageRefusal = ({ name, failed, usage }) => {
  validateName(name);
  validateLine(failed, 'failed');
  if (typeof usage !== 'string' || !usage.length) refuseField('usage');
  return Object.freeze([formatNamedLine(name, VERDICT_WORD, failed), ...usage.split(LINE_SEPARATOR)]);
};

const readFirstLine = (value) => String(value).split(LINE_SEPARATOR)[0];

const readErrorLine = (error) => {
  try {
    return (error instanceof Error
      ? readFirstLine(error.message) || readFirstLine(error.name)
      : readFirstLine(error)) || NO_MESSAGE;
  } catch {
    return NO_MESSAGE;
  }
};

const composeErrorAnswer = ({ name, exitCode, remedy }, error) => {
  const stack = error instanceof Error && typeof error.stack === 'string' && error.stack.length
    ? error.stack.split(LINE_SEPARATOR) : [];
  return {
    exitCode,
    lines: Object.freeze([
      formatNamedLine(name, VERDICT_WORD, `unexpected error: ${readErrorLine(error)}`),
      formatNamedLine(name, REMEDY_WORD, remedy),
      ...stack,
    ]),
  };
};

export const guardChecker = ({ name, exitCode, remedy }, run) => {
  validateName(name);
  validateLine(remedy, 'remedy');
  if (!Number.isInteger(exitCode) || exitCode < MIN_EXIT_CODE || exitCode > MAX_EXIT_CODE) refuseField('exitCode');
  const answerError = (error) => composeErrorAnswer({ name, exitCode, remedy }, error);
  try {
    const answer = run();
    return answer instanceof Promise ? answer.catch(answerError) : answer;
  } catch (error) {
    return answerError(error);
  }
};
