import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const VEHICLES_REL = 'docs/ai/vehicles.json';
export const EXECUTOR_DEFAULTS = Object.freeze({ model: 'opus', effort: 'high', fallback: 'sonnet' });
export const REVIEW_LENS_DEFAULTS = Object.freeze({ model: 'opus', effort: 'high' });

const README_KEY = '_README';
const EXECUTOR_KEY = 'executor';
const LENS_KEY = 'review-lens';
const TOP_LEVEL_KEYS = Object.freeze([README_KEY, EXECUTOR_KEY, LENS_KEY]);
const EXECUTOR_KEYS = Object.freeze(Object.keys(EXECUTOR_DEFAULTS));
const LENS_KEYS = Object.freeze(Object.keys(REVIEW_LENS_DEFAULTS));
const OBJECT_TYPE = 'object';
const STRING_TYPE = 'string';
const EMPTY_STRING = '';
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ABSENT = 'absent';
const PRESENT = 'present';
const UNREADABLE = 'unreadable';
const FILE_SOURCE = 'file';
const DEFAULT_SOURCE = 'default';
const MISSING_ENTRY_CODE = 'ENOENT';
const ENCODING = 'utf8';
const CONFIG_EXIT_CODE = 1;
const BODY_NAME = 'body';
const UNKNOWN_KEY = 'unknown key';
const REQUIRED_KEY = 'required key is missing';
const OBJECT_REQUIRED = 'must be a plain object';
const STRING_REQUIRED = 'must be a string';
const NONEMPTY_REQUIRED = 'must not be empty';
const TOKEN_REQUIRED = 'must be a bare token';
const DISTINCT_FALLBACK_REQUIRED = 'fallback must differ from model';
const DIRECTORY_KIND = 'directory';
const SYMLINK_KIND = 'symlink';
const OTHER_KIND = 'not a regular file';
const UNKNOWN_STATE = 'unknown state';

const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });
const isPlainObject = (value) => {
  if (value === null || typeof value !== OBJECT_TYPE || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const refuseValue = (rel, key, problem) => ({ ok: false, reason: `${rel}: ${key} ${problem}` });
const unreadable = (reason) => ({ state: UNREADABLE, reason });
const describeError = (error) => String(error?.code ?? error?.message ?? error);
const formatReadError = (error) => `${VEHICLES_REL}: ${UNREADABLE} (${describeError(error)})`;

const validateSection = (value, rel, name, keys) => {
  const section = value[name];
  if (!isPlainObject(section)) return refuseValue(rel, name, OBJECT_REQUIRED);
  for (const key of Object.keys(section)) {
    if (!keys.includes(key)) return refuseValue(rel, `${name}.${key}`, UNKNOWN_KEY);
  }
  for (const key of keys) {
    const qualifiedKey = `${name}.${key}`;
    if (!Object.hasOwn(section, key)) return refuseValue(rel, qualifiedKey, REQUIRED_KEY);
    const token = section[key];
    if (typeof token !== STRING_TYPE) return refuseValue(rel, qualifiedKey, STRING_REQUIRED);
    if (token === EMPTY_STRING) return refuseValue(rel, qualifiedKey, NONEMPTY_REQUIRED);
    if (!TOKEN_PATTERN.test(token) || token.trim() !== token) {
      return refuseValue(rel, qualifiedKey, TOKEN_REQUIRED);
    }
  }
  return { ok: true, values: Object.fromEntries(keys.map((key) => [key, section[key]])) };
};

export const validateVehicles = (value, rel = VEHICLES_REL) => {
  if (!isPlainObject(value)) return refuseValue(rel, BODY_NAME, OBJECT_REQUIRED);
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.includes(key)) return refuseValue(rel, key, UNKNOWN_KEY);
  }
  if (Object.hasOwn(value, README_KEY) && typeof value[README_KEY] !== STRING_TYPE) {
    return refuseValue(rel, README_KEY, STRING_REQUIRED);
  }
  if (!Object.hasOwn(value, EXECUTOR_KEY)) return refuseValue(rel, EXECUTOR_KEY, REQUIRED_KEY);
  const executor = validateSection(value, rel, EXECUTOR_KEY, EXECUTOR_KEYS);
  if (!executor.ok) return executor;
  if (executor.values.fallback === executor.values.model) {
    return refuseValue(rel, EXECUTOR_KEY, DISTINCT_FALLBACK_REQUIRED);
  }
  const settings = { executor: executor.values };
  if (!Object.hasOwn(value, LENS_KEY)) return { ok: true, settings };
  const lens = validateSection(value, rel, LENS_KEY, LENS_KEYS);
  return lens.ok ? { ok: true, settings: { ...settings, [LENS_KEY]: lens.values } } : lens;
};

const probeEntry = (path, lstat) => {
  try {
    return { entry: lstat(path) };
  } catch (error) {
    return error?.code === MISSING_ENTRY_CODE
      ? { state: ABSENT }
      : unreadable(formatReadError(error));
  }
};
const describeNodeKind = (entry) => {
  if (entry.isSymbolicLink()) return SYMLINK_KIND;
  if (entry.isDirectory()) return DIRECTORY_KIND;
  return OTHER_KIND;
};

export const readVehicles = (cwd, readFile = readFileSync, lstat = lstatSync) => {
  try {
    const path = join(cwd, VEHICLES_REL);
    const probe = probeEntry(path, lstat);
    if (probe.state) return probe;
    const { entry } = probe;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return unreadable(`${VEHICLES_REL}: ${describeNodeKind(entry)}`);
    }
    const value = JSON.parse(readFile(path, ENCODING));
    const validation = validateVehicles(value);
    return validation.ok
      ? { state: PRESENT, settings: validation.settings }
      : unreadable(validation.reason);
  } catch (error) {
    return unreadable(formatReadError(error));
  }
};

export const loadVehicles = (cwd, readFile = readFileSync, lstat = lstatSync) => {
  const answer = readVehicles(cwd, readFile, lstat);
  if (answer.state === UNREADABLE) throw fail(CONFIG_EXIT_CODE, answer.reason);
  return answer;
};

export const resolveExecutor = (answer) => {
  if (answer?.state === PRESENT) {
    return { posture: { ...answer.settings.executor, source: FILE_SOURCE }, reason: null };
  }
  if (answer?.state === ABSENT) {
    return { posture: { ...EXECUTOR_DEFAULTS, source: DEFAULT_SOURCE }, reason: null };
  }
  if (answer?.state === UNREADABLE) return { posture: null, reason: answer.reason };
  throw fail(CONFIG_EXIT_CODE, `${VEHICLES_REL}: ${UNKNOWN_STATE} ${String(answer?.state)}`);
};

export const resolveReviewLens = (answer) => {
  if (answer?.state === PRESENT && Object.hasOwn(answer.settings, LENS_KEY)) {
    return { posture: { ...answer.settings[LENS_KEY], source: FILE_SOURCE }, reason: null };
  }
  if (answer?.state === PRESENT || answer?.state === ABSENT) {
    return { posture: { ...REVIEW_LENS_DEFAULTS, source: DEFAULT_SOURCE }, reason: null };
  }
  if (answer?.state === UNREADABLE) return { posture: null, reason: answer.reason };
  throw fail(CONFIG_EXIT_CODE, `${VEHICLES_REL}: ${UNKNOWN_STATE} ${String(answer?.state)}`);
};
