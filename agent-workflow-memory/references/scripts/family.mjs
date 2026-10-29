// family.mjs — the one reader of the script family's manifest (spec script-family).
//
// family.json lists every file of this tree but itself: its path relative to the tree, its role and, on a
// deployed entry alone, whether the rotator needs it to load (seed). readFamily returns the entries frozen, in
// the manifest's order, or throws an error naming the manifest's path, the offending field and the one cause —
// a strict config: an unknown key, a missing field or a value outside its grammar is refused, never guessed.
// Dependency-free, Node >= 22. No side effects on import.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FAMILY_FILE = 'family.json';
export const FAMILY_ROLES = Object.freeze(['deployed', 'skill-home', 'suite', 'support']);

const SCHEMA = 1;
const TOP_KEYS = ['schema', 'entries'];
const ENTRY_KEYS = ['path', 'role', 'seed'];
const TOP_FILES = new Set(['family.mjs', 'family.test.mjs']);
const MODULES = new Set(['docs-size', 'spec-schema', 'archives', 'git-hooks', 'gates', 'shared', 'test-support']);
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A path is a top-level file of the reader's own, or <module>/<file> with the module one of the seven.
const inGrammar = (path) => {
  const parts = path.split('/');
  if (parts.length === 1) return TOP_FILES.has(path);
  return parts.length === 2 && MODULES.has(parts[0]) && FILE_NAME.test(parts[1]);
};

const checkKeys = (object, keys, where, refuse) => {
  const unknown = Object.keys(object).find((key) => !keys.includes(key));
  if (unknown !== undefined) refuse(`${where}${unknown}`, `unknown key (allowed: ${keys.join(', ')})`);
};

const readEntry = (raw, at, seen, refuse) => {
  const where = `entries[${at}]`;
  if (!isObject(raw)) refuse(where, 'an entry must be an object');
  checkKeys(raw, ENTRY_KEYS, `${where}.`, refuse);
  for (const field of ['path', 'role']) {
    if (!(field in raw)) refuse(`${where}.${field}`, 'missing');
    if (typeof raw[field] !== 'string') refuse(`${where}.${field}`, 'must be a string');
  }
  const { path, role } = raw;
  if (!inGrammar(path)) {
    refuse(`${where}.path`, `${JSON.stringify(path)} is outside the grammar (family.mjs, family.test.mjs or <module>/<file> of ${[...MODULES].join(', ')})`);
  }
  if (seen.has(path)) refuse(`${where}.path`, `duplicate ${JSON.stringify(path)}`);
  seen.add(path);
  if (!FAMILY_ROLES.includes(role)) refuse(`${where}.role`, `${JSON.stringify(role)} is not one of ${FAMILY_ROLES.join(', ')}`);
  if (role === 'deployed') {
    if (!('seed' in raw)) refuse(`${where}.seed`, 'missing on a deployed entry');
    if (typeof raw.seed !== 'boolean') refuse(`${where}.seed`, 'must be a boolean');
  } else if ('seed' in raw) {
    refuse(`${where}.seed`, 'only a deployed entry carries a seed');
  }
  return Object.freeze({ path, module: path.includes('/') ? path.split('/')[0] : null, role, seed: raw.seed === true });
};

// The family of the manifest in `dir` (this reader's own directory when none is given).
export const readFamily = (dir = HERE) => {
  const manifest = join(dir, FAMILY_FILE);
  const refuse = (field, cause) => {
    throw new Error(`${manifest}: ${field === null ? '' : `${field}: `}${cause}`);
  };
  let text;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch (error) {
    refuse(null, `cannot read the manifest (${error.code ?? error.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    refuse(null, `not JSON (${error.message})`);
  }
  if (!isObject(parsed)) refuse(null, 'the top level must be an object');
  checkKeys(parsed, TOP_KEYS, '', refuse);
  for (const key of TOP_KEYS) if (!(key in parsed)) refuse(key, 'missing');
  if (parsed.schema !== SCHEMA) refuse('schema', `must be ${SCHEMA}, got ${JSON.stringify(parsed.schema)}`);
  if (!Array.isArray(parsed.entries)) refuse('entries', 'must be an array');
  const seen = new Set();
  const entries = parsed.entries.map((raw, at) => readEntry(raw, at, seen, refuse));
  if (!entries.some((entry) => entry.role === 'deployed')) refuse(null, 'no deployed entry — a family that deploys nothing is no family');
  return Object.freeze(entries);
};
