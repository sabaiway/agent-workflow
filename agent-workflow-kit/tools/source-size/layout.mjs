// layout.mjs — the layout limits: the band every limit is judged with, the layout count over a list
// of entries, the layout record's grammar and the spec store's walk. It writes no file, spawns no
// process and imports no file of the practice, so the record's reason rule is handed in by its
// caller; the walk alone reads the disk, through the readdir and lstat it is handed.
//
// A name is carried as a binary string — one code point per byte — so names are compared as bytes
// and a name that is not valid UTF-8 is still counted; the caller decodes a key only where a record
// needs one.
//
// Dependency-free, Node >= 22. No side effects on import.

import { join } from 'node:path';

// The spec store: one more judged root, at a fixed path, walked from disk because a deployment may
// hide it from git.
export const SPEC_STORE_ROOT = 'docs/ai/specs';

// bandOf(value, tolerance) → ceil(value × tolerance / 100), in integers so no float rounds it.
export const bandOf = (value, tolerance) => Math.floor((value * tolerance + 99) / 100);

// layoutCounts(entries) → { files, directories }: `entries` are { path, dir } relative to one root,
// '/'-separated; `directories` maps each directory ('' for the root's own) to its entries (the
// distinct names directly under it), its depth (its segments below the root) and its reach (the
// deepest level its subtree holds). A file's own name is no level; a non-directory entry is a file.
export const layoutCounts = (entries) => {
  const children = new Map([['', new Set()]]);
  const namesOf = (dir) => {
    if (!children.has(dir)) children.set(dir, new Set());
    return children.get(dir);
  };
  let files = 0;
  for (const { path, dir } of entries) {
    const segments = path.split('/');
    segments.forEach((name, at) => namesOf(segments.slice(0, at).join('/')).add(name));
    if (dir) namesOf(path);
    else files += 1;
  }
  const directories = new Map([...children].map(([key, names]) => {
    const depth = key === '' ? 0 : key.split('/').length;
    return [key, { entries: names.size, depth, reach: depth }];
  }));
  for (const [key, { depth }] of directories) {
    const segments = key === '' ? [] : key.split('/');
    for (let at = 0; at < segments.length; at += 1) {
      const ancestor = directories.get(segments.slice(0, at).join('/'));
      if (ancestor.reach < depth) ancestor.reach = depth;
    }
  }
  return { files, directories };
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const BAD_SEGMENTS = new Set(['', '.', '..']);

const keysDefect = (value, what, allowed, required) => {
  if (!isPlainObject(value)) return `${what} must be an object holding ${allowed.join(', ')}`;
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return `${what} carries unknown key(s): ${unknown.join(', ')}`;
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  return missing.length > 0 ? `${what} is missing ${missing.join(', ')}` : null;
};

const entryDefect = (key, entry, what, counts, reasonDefect) => {
  if (key !== '.' && key.split('/').some((segment) => BAD_SEGMENTS.has(segment))) {
    return `${what} key "${key}" must be ".", or a path with no empty, "." or ".." segment`;
  }
  const at = `${what}."${key}"`;
  const shape = keysDefect(entry, at, [...counts, 'reason'], counts.length === 1 ? [...counts, 'reason'] : ['reason']);
  if (shape) return shape;
  if (!counts.some((count) => Object.hasOwn(entry, count))) return `${at} must record ${counts.join(' or ')}`;
  for (const count of counts.filter((name) => Object.hasOwn(entry, name))) {
    if (!(Number.isSafeInteger(entry[count]) && entry[count] >= 0)) {
      return `${at}.${count} must be a non-negative integer, got ${JSON.stringify(entry[count])}`;
    }
  }
  const reason = reasonDefect(entry.reason);
  return reason ? `${at}.reason: ${reason}` : null;
};

// layoutDefect(layout, reasonDefect) → the first defect naming its key, or null. The record holds
// exactly roots (each exactly files and reason) and directories (entries, depth or both, and reason).
export const layoutDefect = (layout, reasonDefect) => {
  const shape = keysDefect(layout, '"layout"', ['roots', 'directories'], ['roots', 'directories']);
  if (shape) return shape;
  for (const [map, counts] of [['roots', ['files']], ['directories', ['entries', 'depth']]]) {
    const what = `"layout"."${map}"`;
    if (!isPlainObject(layout[map])) return `${what} must be an object`;
    for (const [key, entry] of Object.entries(layout[map])) {
      const defect = entryDefect(key, entry, what, counts, reasonDefect);
      if (defect) return defect;
    }
  }
  return null;
};

const SLASH = Buffer.from('/');

// walkSpecStore(cwd, { readdir, lstat }) → { state: 'absent' } | { state: 'present', entries } |
// { state: 'refused', path, cause }. Every entry is read by lstat and no symlink is followed, so a
// link — one pointing at its own parent included — is counted once as an entry and never entered.
export const walkSpecStore = (cwd, { readdir, lstat }) => {
  const root = Buffer.from(join(cwd, SPEC_STORE_ROOT));
  const refused = (path, err) => ({ state: 'refused', path: path.toString(), cause: err?.message ?? String(err) });
  let stat;
  try {
    stat = lstat(root);
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? { state: 'absent' } : refused(root, err);
  }
  if (!stat.isDirectory()) return refused(root, new Error('present but not a directory'));
  const entries = [];
  const pending = [{ abs: root, rel: '' }];
  while (pending.length > 0) {
    const { abs, rel } = pending.pop();
    let names;
    try {
      names = readdir(abs, { encoding: 'buffer' });
    } catch (err) {
      return refused(abs, err);
    }
    for (const raw of names) {
      const name = typeof raw === 'string' ? Buffer.from(raw) : raw;
      const path = Buffer.concat([abs, SLASH, name]);
      let entry;
      try {
        entry = lstat(path);
      } catch (err) {
        return refused(path, err);
      }
      const child = rel === '' ? name.toString('latin1') : `${rel}/${name.toString('latin1')}`;
      entries.push({ path: child, dir: entry.isDirectory() });
      if (entry.isDirectory()) pending.push({ abs: path, rel: child });
    }
  }
  return { state: 'present', entries };
};
