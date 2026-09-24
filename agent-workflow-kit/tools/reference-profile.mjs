// reference-profile.mjs — the READ-ONLY leaf over the running kit's reference profile and a
// project's decline record: the frozen epic/task target table, the shipped profile reader, the
// decline record reader and the currency rule. Governing contract: docs/ai/specs/kit/tier/tier-offer/.
// No CLI (refuseDirectRun); every read goes through injected deps; nothing here writes.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { refuseDirectRun } from './direct-run.mjs';

const PROFILE_PATH = fileURLToPath(new URL('../references/reference-profile.json', import.meta.url));
const DECLINES_REL = 'docs/ai/profile-declines.json';
const PROFILE_KEYS = ['items', 'lineage', 'name', 'schema'];
const ITEM_KEYS = ['has', 'id', 'story'];
const RECORD_KEYS = ['declined', 'schema'];
const SCHEMA = 1;
const OK = 'ok';
const ABSENT = 'absent';
const SYMLINK_CLASS = 'symlink';

const target = (activity, slot, candidates) => Object.freeze({ activity, slot, candidates: Object.freeze(candidates) });

export const TIER_TARGETS = Object.freeze([
  target('epic', 'author', ['subagent', 'solo']),
  target('epic', 'review', ['reviewed', 'solo']),
  target('task', 'author', ['delegated', 'subagent', 'solo']),
  target('task', 'execute', ['delegated', 'subagent', 'solo']),
]);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => isPlainObject(value) && Object.keys(value).sort().join() === keys.join();
const isText = (value) => typeof value === 'string' && value.length > 0;
const parseJson = (text) => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
};

const isProfile = (value) => hasKeys(value, PROFILE_KEYS) && value.schema === SCHEMA
  && isText(value.name) && isText(value.lineage) && Array.isArray(value.items)
  && value.items.every((item) => hasKeys(item, ITEM_KEYS) && isText(item.id) && isText(item.story) && isText(item.has));

const isRecord = (value) => hasKeys(value, RECORD_KEYS) && value.schema === SCHEMA && isPlainObject(value.declined)
  && Object.entries(value.declined).every(([id, lineage]) => id.length > 0 && typeof lineage === 'string');

export const readShippedProfile = (deps = {}) => {
  const read = readRegularFileNoFollow(deps.profilePath ?? PROFILE_PATH, deps);
  if (read.outcome !== OK) return { refusal: 'profile-unreadable' };
  const parsed = parseJson(read.content);
  if (parsed === null || !isProfile(parsed.value)) return { refusal: 'profile-malformed' };
  return { profile: parsed.value };
};

export const readDeclines = (root, deps = {}) => {
  const read = readRegularFileNoFollow(join(root, DECLINES_REL), deps);
  if (read.outcome === ABSENT) return { absent: true };
  if (read.outcome !== OK) {
    return { refusal: read.className === SYMLINK_CLASS ? 'declines-symlink' : 'declines-unreadable' };
  }
  const parsed = parseJson(read.content);
  if (parsed === null || !isRecord(parsed.value)) return { refusal: 'declines-malformed' };
  return { declined: parsed.value.declined };
};

export const isDeclineCurrent = (declined, id, lineage) =>
  isPlainObject(declined) && Object.hasOwn(declined, id) && declined[id] === lineage;

refuseDirectRun(import.meta.url);
