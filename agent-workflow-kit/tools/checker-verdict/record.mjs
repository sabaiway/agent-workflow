import { judgePlace, MISS_KINDS } from './form.mjs';

export const RECORD_WORDS = Object.freeze([
  'writer', 'advisor', 'installer', 'hook', 'server', 'launcher', 'bridge', 'library',
]);
export const FAULT_POINTS = Object.freeze(['read', 'stat', 'list', 'spawn']);

const STRING_TYPE = 'string';
const ARRAY_TYPE = 'array';
const ARGUMENTS_FIELD = 'arguments';
const RECORD_FIELDS = {
  files: ARRAY_TYPE,
  redExceptions: ARRAY_TYPE,
  faultExceptions: ARRAY_TYPE,
};
const FILE_FIELDS = { path: STRING_TYPE, commandLines: ARRAY_TYPE, word: STRING_TYPE };
const FILE_REQUIRED_FIELDS = ['path'];
const COMMAND_FIELDS = { name: STRING_TYPE, arguments: ARRAY_TYPE, redCases: ARRAY_TYPE };
const RED_CASE_FIELDS = { name: STRING_TYPE, places: ARRAY_TYPE };
const EXCEPTION_FIELDS = { path: STRING_TYPE, arguments: ARRAY_TYPE };
const RED_EXCEPTION_FIELDS = { ...EXCEPTION_FIELDS, redCase: STRING_TYPE, missKinds: ARRAY_TYPE };
const FAULT_EXCEPTION_FIELDS = { ...EXCEPTION_FIELDS, faultPoint: STRING_TYPE };
const MIRROR_PREFIXES = [
  'agent-workflow-kit/references/scripts/',
  'agent-workflow-kit/bridges/',
];
const TEST_FILE_PATTERN = /\.(test|spec)\.[^./]+$/;
const SCRIPT_EXTENSIONS = ['.mjs', '.cjs', '.js'];
const PACKAGE_BIN_PATTERN = /^[^/]+\/bin\//;

const refuseRecord = (token, defect) => {
  throw new Error(`${token}: ${defect}`);
};

const assertShape = (value, fields, label, required = Object.keys(fields)) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuseRecord(label, 'expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) refuseRecord(key, 'unknown key');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) refuseRecord(key, 'missing field');
  }
  for (const key of Object.keys(value)) {
    const expectedType = fields[key];
    const matchesType = expectedType === ARRAY_TYPE
      ? Array.isArray(value[key])
      : typeof value[key] === expectedType;
    if (!matchesType) refuseRecord(key, `expected ${expectedType}`);
  }
};

const assertStrings = (values, field) => {
  if (values.some((value) => typeof value !== STRING_TYPE)) {
    refuseRecord(field, 'expected strings');
  }
};

const assertUnique = (values, getKey, getToken) => {
  const seen = new Set();
  for (const value of values) {
    const key = getKey(value);
    if (seen.has(key)) refuseRecord(getToken(value), 'repeated entry');
    seen.add(key);
  }
};

const buildCommandKey = ({ path, arguments: argumentsList }) => JSON.stringify([path, argumentsList]);

const assertRedCase = (redCase) => {
  assertShape(redCase, RED_CASE_FIELDS, 'redCases');
  assertStrings(redCase.places, 'places');
  if (redCase.places.length === 0) refuseRecord(redCase.name, 'no place');
  for (const place of redCase.places) {
    if (!judgePlace(place) || place.startsWith('/')) refuseRecord(place, 'invalid relative place');
  }
};

const assertCommand = (command, path) => {
  assertShape(command, COMMAND_FIELDS, path);
  assertStrings(command.arguments, ARGUMENTS_FIELD);
  if (command.redCases.length === 0) refuseRecord(path, 'no red case');
  command.redCases.forEach(assertRedCase);
  assertUnique(command.redCases, (redCase) => redCase.name, (redCase) => redCase.name);
};

const assertFile = (file) => {
  assertShape(file, FILE_FIELDS, 'files', FILE_REQUIRED_FIELDS);
  const hasCommands = Object.hasOwn(file, 'commandLines');
  const hasWord = Object.hasOwn(file, 'word');
  if (hasCommands === hasWord) refuseRecord(file.path, 'expected commandLines or word exclusively');
  if (hasWord) {
    if (!RECORD_WORDS.includes(file.word)) refuseRecord(file.word, 'unknown word');
    return;
  }
  if (file.commandLines.length === 0) refuseRecord(file.path, 'empty commandLines');
  file.commandLines.forEach((command) => assertCommand(command, file.path));
  assertUnique(file.commandLines, (command) => JSON.stringify(command.arguments), () => file.path);
};

const findExceptionCommand = (exception, files) => {
  const file = files.find(({ path }) => path === exception.path);
  const commandKey = buildCommandKey(exception);
  const command = file?.commandLines?.find((entry) =>
    buildCommandKey({ path: file.path, arguments: entry.arguments }) === commandKey);
  if (!command) refuseRecord(exception.path, 'no recorded command line with these arguments');
  return command;
};

const assertRedException = (exception, files) => {
  assertShape(exception, RED_EXCEPTION_FIELDS, 'redExceptions');
  assertStrings(exception.arguments, ARGUMENTS_FIELD);
  assertStrings(exception.missKinds, 'missKinds');
  const command = findExceptionCommand(exception, files);
  if (!command.redCases.some(({ name }) => name === exception.redCase)) {
    refuseRecord(exception.redCase, 'no recorded red case');
  }
  for (const kind of exception.missKinds) {
    if (!MISS_KINDS.includes(kind)) refuseRecord(kind, 'unknown miss kind');
  }
};

const assertFaultException = (exception, files) => {
  assertShape(exception, FAULT_EXCEPTION_FIELDS, 'faultExceptions');
  assertStrings(exception.arguments, ARGUMENTS_FIELD);
  findExceptionCommand(exception, files);
  if (!FAULT_POINTS.includes(exception.faultPoint)) {
    refuseRecord(exception.faultPoint, 'unknown fault point');
  }
};

export const readRecord = (text) => {
  const record = JSON.parse(text);
  assertShape(record, RECORD_FIELDS, 'record');
  record.files.forEach(assertFile);
  assertUnique(record.files, (file) => file.path, (file) => file.path);
  record.redExceptions.forEach((exception) => assertRedException(exception, record.files));
  record.faultExceptions.forEach((exception) => assertFaultException(exception, record.files));
  assertUnique(record.redExceptions,
    (exception) => JSON.stringify([buildCommandKey(exception), exception.redCase]),
    (exception) => exception.path);
  assertUnique(record.faultExceptions,
    (exception) => JSON.stringify([buildCommandKey(exception), exception.faultPoint]),
    (exception) => exception.path);
  return record;
};

const judgeCommandFile = ({ path, bin, interpreterLine, guardName }) => {
  const segments = path.split('/');
  const basename = segments.at(-1);
  const excluded = MIRROR_PREFIXES.some((prefix) => path.startsWith(prefix))
    || TEST_FILE_PATTERN.test(basename)
    || segments.slice(0, -1).includes('fixtures');
  const isScript = SCRIPT_EXTENSIONS.some((extension) => basename.endsWith(extension));
  const isShell = basename.endsWith('.sh');
  const marked = bin
    || (isShell && PACKAGE_BIN_PATTERN.test(path))
    || (interpreterLine && (isScript || isShell))
    || (guardName && isScript);
  return !excluded && Boolean(marked);
};

export const judgeWholeness = (record, { files, offered, commandTargets }) => {
  const markedPaths = new Set(files.filter(judgeCommandFile).map(({ path }) => path));
  const recordPaths = new Set(record.files.map(({ path }) => path));
  const commandLines = record.files.flatMap((file) => (file.commandLines ?? [])
    .map((command) => ['node', file.path, ...command.arguments].join(' ')));
  return [
    ...[...markedPaths].filter((path) => !recordPaths.has(path))
      .map((path) => `${path}: command-line file is missing from the record`),
    ...[...recordPaths].filter((path) => !markedPaths.has(path))
      .map((path) => `${path}: record path is not a listed command-line file`),
    ...offered.filter(({ matches }) => !commandLines.some((commandLine) => matches(commandLine)))
      .map(({ name }) => `${name}: offered command line is missing from the record`),
    ...commandTargets.filter(({ path }) => !recordPaths.has(path))
      .map(({ name }) => `${name}: command target is missing from the record`),
  ];
};
