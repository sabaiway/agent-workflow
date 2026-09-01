import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';

export const KINDS = Object.freeze(['env', 'flag', 'ref', 'syscall', 'errno', 'state', 'argv']);
const KIND_SET = new Set(KINDS);
const TOP_KEYS = Object.freeze(['schema', 'version', 'classes']);
const CLASS_KEYS = Object.freeze(['id', 'prove', 'members']);
const MEMBER_KEYS = Object.freeze(['literal', 'kind', 'note', 'source']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ADR = /^AD-\d+$/u;
const CONTROL = /[\p{Cc}\u2028\u2029\uFFFD]/u;
const SHIPPED_LIST = fileURLToPath(new URL('../references/robustness-literals.json', import.meta.url));

const refuse = (code, detail) => {
  throw Object.assign(new Error(`robustness-literals: ${code}${detail ? ` — ${detail}` : ''}`), { code });
};
const requireObject = (value, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('type', `${label} must be an object`);
};
const requireKeys = (value, keys, label) => {
  requireObject(value, label);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) refuse('unknown-key', `${label}.${unknown}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) refuse('missing-key', `${label}.${missing}`);
};
const requireString = (value, label) => {
  if (typeof value !== 'string') refuse('type', `${label} must be a string`);
  if (value.length === 0) refuse('empty-string', label);
  if (CONTROL.test(value)) refuse('control', label);
};
const isRepoSource = (source) => !source.startsWith('/') && !source.includes('\\') &&
  !source.split('/').includes('..') && (source.includes('/') || source.includes('.'));
const freezeList = (list) => Object.freeze({
  ...list,
  classes: Object.freeze(list.classes.map((entry) => Object.freeze({
    ...entry,
    members: Object.freeze(entry.members.map((member) => Object.freeze(member))),
  }))),
});

const validateList = (value) => {
  requireKeys(value, TOP_KEYS, 'list');
  if (value.schema !== 1) refuse('schema', 'schema must be 1');
  if (!Number.isSafeInteger(value.version) || value.version < 1) refuse('version', 'version must be an integer >= 1');
  if (!Array.isArray(value.classes)) refuse('type', 'classes must be an array');
  if (value.classes.length === 0) refuse('empty-class', 'classes must not be empty');
  const ids = new Set();
  for (const [classIndex, entry] of value.classes.entries()) {
    const label = `classes[${classIndex}]`;
    requireKeys(entry, CLASS_KEYS, label);
    requireString(entry.id, `${label}.id`);
    if (!SLUG.test(entry.id)) refuse('class-id', entry.id);
    if (ids.has(entry.id)) refuse('duplicate-class', entry.id);
    ids.add(entry.id);
    requireString(entry.prove, `${label}.prove`);
    if (!Array.isArray(entry.members)) refuse('type', `${label}.members must be an array`);
    if (entry.members.length === 0) refuse('empty-class', entry.id);
    const literals = new Set();
    for (const [memberIndex, member] of entry.members.entries()) {
      const memberLabel = `${label}.members[${memberIndex}]`;
      requireKeys(member, MEMBER_KEYS, memberLabel);
      for (const key of MEMBER_KEYS) requireString(member[key], `${memberLabel}.${key}`);
      if (literals.has(member.literal)) refuse('duplicate-literal', `${entry.id}:${member.literal}`);
      literals.add(member.literal);
      if (!KIND_SET.has(member.kind)) refuse('kind', member.kind);
      if (!ADR.test(member.source) && !SLUG.test(member.source) && !isRepoSource(member.source)) refuse('source', member.source);
    }
  }
  return freezeList(value);
};

export const readRobustnessLiterals = (path, io = {}) => {
  const read = readRegularFileNoFollow(path, io);
  if (read.outcome !== 'ok') refuse('type', `${path} must be a readable regular file (${read.className ?? read.code ?? read.outcome})`);
  try {
    return validateList(JSON.parse(read.content));
  } catch (error) {
    if (error?.code) throw error;
    refuse('type', `${path} is not valid JSON (${error.message})`);
  }
};

export const readShippedRobustnessLiterals = (deps = {}) =>
  readRobustnessLiterals((deps.resolvePath ?? (() => SHIPPED_LIST))(), deps.io);

export const parseRobustTag = (text) => {
  const matches = [...String(text ?? '').matchAll(/robust:(\S*)/gu)];
  if (matches.length === 0) return { classes: [] };
  if (matches.length > 1) return { refusal: 'multiple-tags' };
  if (matches[0][1] === '') return { refusal: 'no-class' };
  const classes = matches[0][1].split(',');
  if (classes.some((entry) => entry === '')) return { refusal: 'empty-class' };
  if (new Set(classes).size !== classes.length) return { refusal: 'duplicate-class' };
  if (classes.some((entry) => !SLUG.test(entry))) return { refusal: 'invalid-class' };
  return { classes };
};

export const classIds = (list) => Object.freeze(list.classes.map((entry) => entry.id));
export const digestOf = (list) => createHash('sha256').update(JSON.stringify(list.classes)).digest('hex');
