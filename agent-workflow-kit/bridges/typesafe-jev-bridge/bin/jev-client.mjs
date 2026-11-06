// spec:typesafe-jev-bridge — docs/ai/specs/bridges/typesafe-jev-bridge/index.md
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JUDGE_TIMEOUT_MS = 10000;
const EXIT = { OK: 0, REQUEST: 2, KEY: 3, TIMEOUT: 4, HTTP: 5, ANSWER: 6, MODEL: 7, TRANSPORT: 8, INSTALL: 127 };
const EMPTY = '';
const NEWLINE = '\n';
const STRING_TYPE = 'string';
const OBJECT_TYPE = 'object';
const CHOICE_TYPE = 'choice';
const UTF8 = 'utf8';
const REQUEST_KEYS = ['state', 'questions'];
const QUESTION_KEYS = ['type', 'instructions', 'criteria'];
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 255;
const MIN_QUESTIONS = 1;
const EMPTY_BYTE_COUNT = 0;
const STATE_LIMIT = 30000;
const BODY_LIMIT = 60000;
const HTTP_MIN = 200;
const HTTP_MAX = 299;
const PROBABILITY_MIN = 0;
const PROBABILITY_MAX = 1;
const MILLISECONDS_PER_SECOND = 1000;
const ARGUMENT_COUNT = 5;
const HOST_FLAG = '--host';
const KEY_FLAG = '--key-variable';
const MANIFEST_FILE = 'capability.json';
const REQUEST_ID_HEADER = 'x-typesafe-request-id';
const AUTHORIZATION_HEADER = 'authorization';
const CONTENT_TYPE_HEADER = 'content-type';
const JSON_CONTENT_TYPE = 'application/json';
const REQUEST_METHOD = 'POST';
const REDIRECT_MODE = 'manual';
const ENDPOINT_PATH = '/v1/systemone';
const REMEDY = 'run /agent-workflow-kit upgrade to write it again';
const HTTP_CAUSES = { 401: 'the key was refused', 422: 'the request failed validation', 429: 'the rate limit was hit', 529: 'the vendor is overloaded' };
const CONTROL_RUN = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/gu;
const flattenText = (text) => String(text).replace(CONTROL_RUN, ' ');
const isPlainObject = (value) => value !== null && typeof value === OBJECT_TYPE &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const isNonemptyString = (value) => typeof value === STRING_TYPE && value !== EMPTY;
const isProbability = (value) => Number.isFinite(value) && value >= PROBABILITY_MIN && value <= PROBABILITY_MAX;
const measureBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const renderTimeout = (timeoutMs) => Number.isInteger(timeoutMs / MILLISECONDS_PER_SECOND) ?
  `${timeoutMs / MILLISECONDS_PER_SECOND}s` : `${timeoutMs}ms`;
const REDACTED = '[redacted]';
const makeFailure = (code, message) => ({ code, stdout: EMPTY, stderr: `jev-ask: ${flattenText(message)}${NEWLINE}` });
const redactKey = (text, key) => key === EMPTY ? text : text.replaceAll(key, REDACTED);
const cleanOutsideText = (text, key) => flattenText(redactKey(String(text), key));
const scrubOutcome = (outcome, key) => Object.fromEntries(Object.entries(outcome).map(([name, value]) =>
  [name, typeof value === STRING_TYPE ? redactKey(value, key) : value]));
const describeError = (error, key, seen = new Set()) => {
  if (seen.has(error)) return EMPTY;
  seen.add(error);
  return [cleanOutsideText(error?.message ?? error, key), ...(error?.cause === undefined ? [] : [describeError(error.cause, key, seen)])].join(' caused by ');
};

export const keyIsSet = (env, variable) => typeof env[variable] === STRING_TYPE && env[variable].trim() !== EMPTY;
export const checkRequest = (request) => {
  if (!hasKeys(request, REQUEST_KEYS)) return 'request must contain exactly state and questions';
  if (!isNonemptyString(request.state)) return 'state must be a non-empty string';
  if (!isPlainObject(request.questions) || Object.keys(request.questions).length < MIN_QUESTIONS) return 'questions must be a non-empty object';
  for (const [id, question] of Object.entries(request.questions)) {
    if (!hasKeys(question, QUESTION_KEYS) || question.type !== CHOICE_TYPE || !isNonemptyString(question.instructions)) return `question ${id} must have choice type, non-empty instructions and criteria`;
    if (!isPlainObject(question.criteria)) return `question ${id} criteria must be an object`;
    const options = Object.values(question.criteria);
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS || !options.every(isNonemptyString)) return `question ${id} criteria must have ${MIN_OPTIONS} to ${MAX_OPTIONS} non-empty options`;
  }
  return null;
};

const checkAnswer = (answer, questions) => isPlainObject(answer) && typeof answer.model === STRING_TYPE &&
  hasKeys(answer.answers, Object.keys(questions)) && Object.entries(questions).every(([id, question]) => {
    const note = answer.answers[id];
    return isPlainObject(note) && note.type === CHOICE_TYPE && typeof note.choice === STRING_TYPE &&
      Object.hasOwn(question.criteria, note.choice) && hasKeys(note.probabilities, Object.keys(question.criteria)) &&
      Object.values(note.probabilities).every(isProbability) && isProbability(note.confidence);
  });
const makeNotes = (answers) => Object.fromEntries(Object.entries(answers).map(([id, { choice, probabilities, confidence }]) =>
  [id, { choice, probabilities, confidence }]));
const readAnswer = async (response, model, questions, key) => {
  const header = response.headers.get(REQUEST_ID_HEADER);
  const requestId = header === null ? null : cleanOutsideText(header, key);
  if (response.status < HTTP_MIN || response.status > HTTP_MAX) return makeFailure(EXIT.HTTP,
    `HTTP ${response.status}${requestId === null ? EMPTY : ` request ${requestId}`}${HTTP_CAUSES[response.status] ? `: ${HTTP_CAUSES[response.status]}` : EMPTY}`);
  const body = await response.text();
  const answer = (() => { try { return JSON.parse(body); } catch { return null; } })();
  if (!checkAnswer(answer, questions)) return makeFailure(EXIT.ANSWER, 'malformed answer');
  if (answer.model !== model) return makeFailure(EXIT.MODEL, `requested model ${model}; answering model ${cleanOutsideText(answer.model, key)}`);
  return { code: EXIT.OK, stdout: JSON.stringify({ model, requestId, notes: makeNotes(answer.answers) }) + NEWLINE, stderr: EMPTY };
};

export const askJudge = async ({ host, key, model, state, questions, transport, timeoutMs = JUDGE_TIMEOUT_MS }) => {
  const trimmedKey = key.trim();
  const controller = new AbortController();
  const deadline = { timer: null };
  const timeout = new Promise((complete) => {
    deadline.timer = setTimeout(() => complete(makeFailure(EXIT.TIMEOUT, `no complete answer within ${renderTimeout(timeoutMs)}`)), timeoutMs);
  });
  const work = (async () => {
    const response = await transport(`https://${host}${ENDPOINT_PATH}`, {
      method: REQUEST_METHOD, headers: { [AUTHORIZATION_HEADER]: `Bearer ${trimmedKey}`, [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ state, model, questions }), redirect: REDIRECT_MODE, signal: controller.signal,
    });
    return readAnswer(response, model, questions, trimmedKey);
  })().catch((error) => makeFailure(EXIT.TRANSPORT, describeError(error, trimmedKey)));
  try {
    return scrubOutcome(await Promise.race([timeout, work]), trimmedKey);
  } finally {
    clearTimeout(deadline.timer);
    controller.abort();
  }
};

export const runJudgeCli = async ({ argv, env, folder, transport, timeoutMs = JUDGE_TIMEOUT_MS }) => {
  const [hostFlag, host, keyFlag, variable, path] = Array.isArray(argv) ? argv : [];
  const key = typeof env?.[variable] === STRING_TYPE ? env[variable].trim() : EMPTY;
  const finish = (outcome) => scrubOutcome(outcome, key);
  try {
    if (!Array.isArray(argv) || argv.length !== ARGUMENT_COUNT || hostFlag !== HOST_FLAG || keyFlag !== KEY_FLAG ||
      ![host, variable, path].every(isNonemptyString)) return finish(makeFailure(EXIT.REQUEST, 'usage: --host <host> --key-variable <variable> <request-file>'));
    const manifestPath = resolve(folder, MANIFEST_FILE);
    const model = await readFile(manifestPath, UTF8).then((text) => {
      try { return JSON.parse(text)?.posture?.model; } catch { return null; }
    }, () => null);
    if (!isNonemptyString(model)) return finish(makeFailure(EXIT.INSTALL, `${manifestPath}: no readable posture.model; ${REMEDY}`));
    const text = await readFile(path, UTF8).catch(() => null);
    if (text === null) return finish(makeFailure(EXIT.REQUEST, `${path}: cannot read request file`));
    const parsed = (() => {
      try { return { value: JSON.parse(text) }; } catch { return null; }
    })();
    if (parsed === null) return finish(makeFailure(EXIT.REQUEST, `${path}: request is not JSON`));
    const reason = checkRequest(parsed.value);
    if (reason !== null) return finish(makeFailure(EXIT.REQUEST, reason));
    const { state, questions } = parsed.value;
    const stateBytes = measureBytes(state) + Object.entries(questions).reduce((largest, pair) => Math.max(largest, measureBytes(pair)), EMPTY_BYTE_COUNT);
    if (stateBytes > STATE_LIMIT) return finish(makeFailure(EXIT.REQUEST, `state and largest question measure ${stateBytes} bytes; bound ${STATE_LIMIT}`));
    const bodyBytes = measureBytes({ state, model, questions });
    if (bodyBytes > BODY_LIMIT) return finish(makeFailure(EXIT.REQUEST, `request measures ${bodyBytes} bytes; bound ${BODY_LIMIT}`));
    if (!keyIsSet(env, variable)) return finish(makeFailure(EXIT.KEY, `${variable} is unset or blank`));
    const posture = flattenText(`judge posture: model=${model} host=${host} timeout=${renderTimeout(timeoutMs)}`) + NEWLINE;
    const outcome = await askJudge({ host, key, model, state, questions, transport, timeoutMs });
    return finish({ ...outcome, stderr: posture + outcome.stderr });
  } catch (error) {
    return finish(makeFailure(EXIT.TRANSPORT, describeError(error, key)));
  }
};

const entry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ? await runJudgeCli({ argv: process.argv.slice(2), env: process.env, folder: dirname(dirname(fileURLToPath(import.meta.url))), transport: fetch }) : null;
if (entry !== null) { process.stdout.write(entry.stdout); process.stderr.write(entry.stderr); process.exitCode = entry.code; }
