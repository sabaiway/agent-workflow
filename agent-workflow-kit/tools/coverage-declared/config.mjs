import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { classifyChangedPath } from '../changed-surface.mjs';
import { isLineUnsafe } from '../source-size-refusal.mjs';
import { readFileBytesNoFollow } from '../fs-read-nofollow.mjs';

export const COVERAGE_DECLARED_REL = 'docs/ai/coverage-declared.json';
export const DECLARED_REASON_MAX_BYTES = 300;

const SHAPE = '{ "schema": 1, "_README"?: string, "entries": [{ "path": string, "reason": string }, ...] }';
const SCHEMA = 1;
const TOP_KEYS = new Set(['schema', 'entries', '_README']);
const ENTRY_KEYS = new Set(['path', 'reason']);
const ABSENT = 'absent';
const REGULAR = 'regular';
const UNREADABLE = 'unreadable';
const OK = 'ok';
const FOREIGN = 'foreign';
const MISSING = 'ENOENT';
const NONE = 'none';
const STRING = 'string';
const OBJECT = 'object';
const UTF8 = 'utf-8';
const HASH_ALGORITHM = 'sha256';
const HEX = 'hex';
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HASH_LENGTH = 64;
const HASH_DISPLAY_LENGTH = 12;
const HEX_RADIX = 16;
const ESCAPE_WIDTH = 4;
const ESCAPE_PADDING = '0';
const SEPARATOR = '/';
const BACKSLASH = '\\';
const INVALID_SEGMENTS = new Set(['', '.', '..']);
const ASSESSABLE = 'assessable';
const DISPLAY = {
  noValue: 'no value', malformed: 'a malformed value', unreadable: 'an unreadable list',
  noList: 'no list', absent: 'absent', notReadable: 'not readable', another: 'another list',
  unprintableKey: 'an unprintable key',
};
const DEFECT = {
  json: 'not JSON', object: 'not a JSON object', schema: 'schema must be the number 1',
  entries: 'entries must be an array', readme: '_README must be a string',
  entryObject: 'must be an object', missingKey: 'is missing key', extraKey: 'has unknown key',
  pathString: 'must be a string', pathEmpty: 'must not be empty',
  pathAbsolute: 'must be repository-relative', pathBackslash: 'must not contain a backslash',
  pathSegment: 'must not contain an empty, . or .. segment', pathUnsafe: 'contains unsafe characters',
  pathDuplicate: 'duplicates an earlier entry', pathClass: 'is not assessable',
  reasonString: 'must be a string', reasonBlank: 'must not be blank',
  reasonUnsafe: 'contains unsafe characters',
};

export const resolveDeclaredListPath = (top) => join(top, COVERAGE_DECLARED_REL);

const renderSafeText = (value) => Array.from(String(value), (character) => isLineUnsafe(character)
  ? `\\u${character.codePointAt(0).toString(HEX_RADIX).padStart(ESCAPE_WIDTH, ESCAPE_PADDING)}`
  : character).join('');

export const readDeclaredList = (path, io = {}) => {
  try {
    (io.lstat ?? lstatSync)(path);
  } catch (error) {
    if (error?.code === MISSING) return { state: ABSENT };
  }
  const read = readFileBytesNoFollow(path, io);
  if (read.outcome === ABSENT) return { state: ABSENT };
  if (read.outcome === OK) {
    return { state: REGULAR, bytes: read.bytes,
      hash: createHash(HASH_ALGORITHM).update(read.bytes).digest(HEX) };
  }
  const defect = read.outcome === FOREIGN
    ? `not a regular file (${renderSafeText(read.className)})` : renderSafeText(read.code);
  return { state: UNREADABLE, defect };
};

const makeShapeDefect = (detail) => ({ ok: false, defect: `${detail}; the list must be ${SHAPE}` });
const renderKey = (key) => {
  const rendered = JSON.stringify(key);
  return isLineUnsafe(rendered) ? DISPLAY.unprintableKey : rendered;
};
const isPlainObject = (value) => value !== null && typeof value === OBJECT && !Array.isArray(value);

const checkListShape = (value) => {
  if (!isPlainObject(value)) return makeShapeDefect(DEFECT.object);
  const unknownKey = Object.keys(value).find((key) => !TOP_KEYS.has(key));
  if (unknownKey !== undefined) return makeShapeDefect(`${DEFECT.extraKey} ${renderKey(unknownKey)}`);
  if (value.schema !== SCHEMA) return makeShapeDefect(DEFECT.schema);
  if (!Array.isArray(value.entries)) return makeShapeDefect(DEFECT.entries);
  if (Object.hasOwn(value, '_README') && typeof value._README !== STRING) return makeShapeDefect(DEFECT.readme);
  for (const [index, entry] of value.entries.entries()) {
    const label = `entries[${index}]`;
    if (!isPlainObject(entry)) return makeShapeDefect(`${label} ${DEFECT.entryObject}`);
    const missingKey = [...ENTRY_KEYS].find((key) => !Object.hasOwn(entry, key));
    if (missingKey !== undefined) return makeShapeDefect(`${label} ${DEFECT.missingKey} ${renderKey(missingKey)}`);
    const extraKey = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
    if (extraKey !== undefined) return makeShapeDefect(`${label} ${DEFECT.extraKey} ${renderKey(extraKey)}`);
  }
  return null;
};

const checkPath = (path, seen) => {
  if (typeof path !== STRING) return DEFECT.pathString;
  if (path === '') return DEFECT.pathEmpty;
  if (path.startsWith(SEPARATOR)) return DEFECT.pathAbsolute;
  if (path.includes(BACKSLASH)) return DEFECT.pathBackslash;
  if (path.split(SEPARATOR).some((segment) => INVALID_SEGMENTS.has(segment))) return DEFECT.pathSegment;
  if (isLineUnsafe(path)) return DEFECT.pathUnsafe;
  if (seen.has(path)) return DEFECT.pathDuplicate;
  if (classifyChangedPath(path) !== ASSESSABLE) return DEFECT.pathClass;
  seen.add(path);
  return null;
};

const checkReason = (reason) => {
  if (typeof reason !== STRING) return DEFECT.reasonString;
  if (reason.trim() === '') return DEFECT.reasonBlank;
  if (Buffer.byteLength(reason, UTF8) > DECLARED_REASON_MAX_BYTES) {
    return `exceeds ${DECLARED_REASON_MAX_BYTES} UTF-8 bytes`;
  }
  if (isLineUnsafe(reason)) return DEFECT.reasonUnsafe;
  return null;
};

export const parseDeclaredList = (bytes) => {
  const parsed = (() => {
    try {
      return { value: JSON.parse(new TextDecoder(UTF8, { fatal: true, ignoreBOM: true }).decode(bytes)) };
    } catch {
      return { failure: makeShapeDefect(DEFECT.json) };
    }
  })();
  if (parsed.failure) return parsed.failure;
  const shapeDefect = checkListShape(parsed.value);
  if (shapeDefect) return shapeDefect;
  const entries = parsed.value.entries;
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const defect = checkPath(entry.path, seen);
    if (defect) return { ok: false, defect: `entries[${index}].path ${defect}` };
  }
  for (const [index, entry] of entries.entries()) {
    const defect = checkReason(entry.reason);
    if (defect) return { ok: false, defect: `entries[${index}].reason ${defect}` };
  }
  return { ok: true, entries: entries.map(({ path, reason }) => ({ path, reason })) };
};

export const declaredAttestValue = (read) => {
  if (read.state === ABSENT) return NONE;
  return read.state === REGULAR ? read.hash : null;
};

const isHash = (value) => typeof value === STRING && value.length === HASH_LENGTH && HASH_PATTERN.test(value);
const renderHanded = (handed) => {
  if (handed === NONE) return NONE;
  if (isHash(handed)) return handed.slice(0, HASH_DISPLAY_LENGTH);
  return handed === undefined || handed === null ? DISPLAY.noValue : DISPLAY.malformed;
};

export const compareDeclaredAttest = (handed, read) => {
  const accepted = (handed === NONE && read.state === ABSENT)
    || (isHash(handed) && read.state === REGULAR && handed === read.hash);
  if (accepted) return { accepted: true };
  const displayedRead = read.state === ABSENT ? NONE
    : read.state === REGULAR ? read.hash.slice(0, HASH_DISPLAY_LENGTH) : DISPLAY.unreadable;
  return { accepted: false, handed: renderHanded(handed), read: displayedRead };
};

export const checkDeclaredBinding = ({ top, field, io = {} }) => {
  const read = readDeclaredList(resolveDeclaredListPath(top), io);
  const hasField = field !== undefined;
  const comparison = compareDeclaredAttest(hasField ? field : NONE, read);
  const parsed = hasField && comparison.accepted ? parseDeclaredList(read.bytes) : null;
  if (comparison.accepted && (!hasField || parsed.ok)) {
    const suffix = hasField
      ? ` — declared coverage list ${COVERAGE_DECLARED_REL} bound, ${parsed.entries.length} entr(ies)` : '';
    return { ok: true, suffix };
  }
  const bound = !hasField ? DISPLAY.noList
    : isHash(field) ? field.slice(0, HASH_DISPLAY_LENGTH) : DISPLAY.malformed;
  const current = read.state === ABSENT ? DISPLAY.absent
    : read.state === UNREADABLE || (parsed && !parsed.ok) ? DISPLAY.notReadable : DISPLAY.another;
  return { ok: false,
    line: `commit-guard: REFUSED — the declared coverage list is not the one the final run bound (the receipt binds ${bound}, ${COVERAGE_DECLARED_REL} is ${current}); re-run run-gates.mjs --final` };
};
