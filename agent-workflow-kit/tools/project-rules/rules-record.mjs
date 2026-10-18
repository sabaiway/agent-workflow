// The record's one writer: docs/ai/rules/effective/sources.json states what every effective file was
// built from, and a merge it cannot vouch for is refused. Contract:
// docs/ai/specs/kit/project-rules/rules-record.md.

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeDocsAiFileAtomic } from '../atomic-write.mjs';
import { parseFrontmatter } from '../../references/scripts/check-docs-size.mjs';
import { digestOf, readRecord, readUnder } from './rules-check.mjs';
import { RECORD_PATH, THEMES, themePaths } from './themes.mjs';

const ROLES = ['kit', 'local', 'effective'];

// Why the first node on the record's path that lstat cannot inspect, is a symlink or is of the wrong
// kind fails, or null when the path holds or ends in a missing node.
const wrongNode = (root, lstat) => {
  const parts = RECORD_PATH.split('/');
  for (let i = 1; i <= parts.length; i += 1) {
    const rel = parts.slice(0, i).join('/');
    let st;
    try {
      st = lstat(join(root, rel));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      return `${rel} cannot be inspected (${err?.code ?? err})`;
    }
    const isLeaf = i === parts.length;
    if (st.isSymbolicLink() || (isLeaf ? !st.isFile() : !st.isDirectory())) return `${rel} is a symlink or not of its kind`;
  }
  return null;
};

// The conditions in the order they are judged; each returns null when it holds, else the refusal.
const judge = (root, theme, passed, deps) => {
  const themes = deps.themes ?? THEMES;
  const fail = (condition, message) => ({ ok: false, condition, message });
  if (!themes.some(({ name }) => name === theme)) return fail('theme', `${theme} is not a registry theme`);
  const node = wrongNode(root, deps.lstat ?? lstatSync);
  if (node !== null) return fail('record-path', node);
  const recordRead = readUnder(root, RECORD_PATH, deps);
  if (!['ok', 'absent'].includes(recordRead.outcome)) return fail('record-path', `${RECORD_PATH} is not a regular file`);
  const record = readRecord(recordRead, themes);
  if (!record.ok) return fail('unreadable-record', `${RECORD_PATH} is unreadable: ${record.reason}`);
  const paths = themePaths(theme);
  const files = Object.fromEntries(ROLES.map((role) => [role, readUnder(root, paths[role], deps)]));
  const unreadable = ROLES.find((role) => !['ok', 'absent'].includes(files[role].outcome));
  if (unreadable) return fail('unreadable-file', `${paths[unreadable]} is not a regular file this writer can read`);
  const missing = ['kit', 'effective'].find((role) => files[role].outcome !== 'ok');
  if (missing) return fail('missing-file', `${paths[missing]} is missing`);
  const { kit, local, effective } = { kit: files.kit.bytes, local: files.local.bytes, effective: files.effective.bytes };
  if (parseFrontmatter(effective.toString('utf8')) === null) return fail('frontmatter', `${paths.effective} carries no frontmatter`);
  if (digestOf(kit) !== passed.kit) return fail('kit-moved', `${paths.kit} no longer hashes to the passed kit digest`);
  if (digestOf(effective) !== passed.effective) return fail('effective-moved', `${paths.effective} no longer hashes to the passed effective digest`);
  if ((local !== undefined) !== (passed.local !== 'absent')) {
    return fail('local-presence', `${paths.local} ${local === undefined ? 'is absent' : 'exists'} while the passed local is ${passed.local}`);
  }
  if (local !== undefined) {
    if (digestOf(local) !== passed.local) return fail('local-moved', `${paths.local} no longer hashes to the passed local digest`);
    if (effective.equals(kit) || effective.equals(local)) return fail('effective-equals-input', `${paths.effective} equals one of its inputs, so no merge was written`);
  } else if (!effective.equals(kit)) {
    return fail('effective-differs-from-kit', `with no local file ${paths.effective} must equal ${paths.kit}`);
  }
  return { ok: true, themes: record.themes };
};

// writeRecord(root, theme, passed, deps?) → { ok: true, path, entry } | { ok: false, condition, message }.
export const writeRecord = (root, theme, passed, deps = {}) => {
  const judged = judge(root, theme, passed, deps);
  if (!judged.ok) return judged;
  const entry = { kit: passed.kit, local: passed.local, effective: passed.effective };
  const body = `${JSON.stringify({ schema: 1, themes: { ...judged.themes, [theme]: entry } }, null, 2)}\n`;
  try {
    (deps.write ?? writeDocsAiFileAtomic)(root, RECORD_PATH, body);
  } catch (err) {
    return { ok: false, condition: 'write', message: String(err?.message ?? err) };
  }
  return { ok: true, path: RECORD_PATH, entry };
};
