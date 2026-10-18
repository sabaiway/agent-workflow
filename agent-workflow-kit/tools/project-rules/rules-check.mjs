// The read-only check: one verdict per registry theme, judged only against the record. It imports no
// writer and reads every file through readUnder, so no symlink inside the root is followed. Contract:
// docs/ai/specs/kit/project-rules/rules-check.md.

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readFileBytesNoFollow } from '../fs-read-nofollow.mjs';
import { RECORD_PATH, THEMES, themePaths } from './themes.mjs';

const UPGRADE = 'run /agent-workflow-kit upgrade';
const EDIT_NOTE = 'move your edit to local/, a rebuild drops it';
const DIGEST = /^[0-9a-f]{64}$/;
const ROLES = ['kit', 'local', 'effective'];

export const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

const isDigest = (value) => typeof value === 'string' && DIGEST.test(value);

// readUnder(root, rel, deps?) → a readFileBytesNoFollow outcome for root/rel, or foreign or error
// without a read when a directory on rel's path inside root is a symlink, not a directory, or cannot be
// inspected; a missing directory ends the walk and the leaf then reads absent.
export const readUnder = (root, rel, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    let st;
    try {
      st = lstat(join(root, prefix));
    } catch (err) {
      if (err && err.code === 'ENOENT') break;
      return { outcome: 'error', code: `${prefix} cannot be inspected (${err?.code ?? err})` };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { outcome: 'foreign', code: `${prefix} is a symlink or not a directory` };
  }
  return (deps.read ?? readFileBytesNoFollow)(join(root, rel));
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

// parseRecord(text, themes?) → { ok: true, record } | { ok: false, reason }: the record's one schema reader.
export const parseRecord = (text, themes = THEMES) => {
  const bad = (reason) => ({ ok: false, reason });
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return bad('not JSON');
  }
  if (!isObject(record) || !sameKeys(record, ['schema', 'themes'])) return bad('the keys are not exactly schema and themes');
  if (record.schema !== 1) return bad(`schema ${JSON.stringify(record.schema)} is not 1`);
  if (!isObject(record.themes)) return bad('themes is not an object');
  const names = new Set(themes.map((theme) => theme.name));
  for (const [name, entry] of Object.entries(record.themes)) {
    if (!names.has(name)) return bad(`theme ${name} is not in the registry`);
    if (!isObject(entry) || !sameKeys(entry, ROLES)) return bad(`the entry of ${name} does not hold exactly kit, local and effective`);
    if (!isDigest(entry.kit) || !isDigest(entry.effective)) return bad(`the entry of ${name} holds a value that is not a sha256`);
    if (entry.local !== 'absent' && !isDigest(entry.local)) return bad(`the local of ${name} is neither a sha256 nor absent`);
  }
  return { ok: true, record };
};

// readRecord(outcome, themes) → { ok: true, themes } | { ok: false, reason }: an absent record holds no entry.
export const readRecord = (outcome, themes = THEMES) => {
  if (outcome.outcome === 'absent') return { ok: true, themes: {} };
  if (outcome.outcome !== 'ok') return { ok: false, reason: 'it is not a regular file this check can read' };
  const parsed = parseRecord(outcome.bytes.toString('utf8'), themes);
  return parsed.ok ? { ok: true, themes: parsed.record.themes } : parsed;
};

const recordVerdict = (theme, state, detail) =>
  ({ theme, verdict: 'record', state, line: `${theme}: record (${state}) — ${detail} — ${UPGRADE}` });

const judgeTheme = (theme, paths, files, record) => {
  if (!record.ok) return recordVerdict(theme, 'unreadable-record', `${paths.record} is unreadable: ${record.reason}`);
  const unreadable = ROLES.find((role) => !['ok', 'absent'].includes(files[role].outcome));
  if (unreadable) return recordVerdict(theme, 'unreadable-file', `${paths[unreadable]} is not a regular file this check can read`);
  const present = (role) => files[role].outcome === 'ok';
  const entry = record.themes[theme];
  if (entry === undefined) {
    const existing = ROLES.find(present);
    if (existing === undefined) return { theme, verdict: 'absent', line: `${theme}: absent` };
    return recordVerdict(theme, 'no-entry', `no record entry while ${paths[existing]} exists`);
  }
  const missing = ['kit', 'effective'].find((role) => !present(role));
  if (missing) return recordVerdict(theme, 'missing-file', `${paths[missing]} is missing under its record entry`);
  const differs = {
    kit: digestOf(files.kit.bytes) !== entry.kit,
    local: present('local') ? digestOf(files.local.bytes) !== entry.local : entry.local !== 'absent',
    effective: digestOf(files.effective.bytes) !== entry.effective,
  };
  const moved = ROLES.filter((role) => differs[role])
    .map((role) => (role === 'effective' ? { role, file: paths[role], note: EDIT_NOTE } : { role, file: paths[role] }));
  if (moved.length > 0) {
    const named = moved.map(({ file, note }) => (note ? `${file} (${note})` : file)).join('; ');
    return { theme, verdict: 'drift', moved, line: `${theme}: drift — moved ${named} — ${UPGRADE}` };
  }
  if (!present('local') && !files.kit.bytes.equals(files.effective.bytes)) {
    return recordVerdict(theme, 'kit-effective-differ', `no local file, yet ${paths.effective} differs from ${paths.kit}`);
  }
  return { theme, verdict: 'current', line: `${theme}: current` };
};

// checkRules(root, deps?) → [{ theme, verdict, line, moved?, state? }] in registry order; writes nothing.
export const checkRules = (root, deps = {}) => {
  const themes = deps.themes ?? THEMES;
  const record = readRecord(readUnder(root, RECORD_PATH, deps), themes);
  return themes.map(({ name }) => {
    const paths = themePaths(name);
    const files = Object.fromEntries(ROLES.map((role) => [role, readUnder(root, paths[role], deps)]));
    return judgeTheme(name, paths, files, record);
  });
};
