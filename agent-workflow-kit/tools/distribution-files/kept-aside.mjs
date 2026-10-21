// kept-aside.mjs — where an upgrade keeps a user's edit before the bundled body replaces it:
// `.agent-workflow/kept-aside/<the first 16 hex of the replace set's digest>/<rel>` at the project
// root. Every copy is written create-only from the bytes the survey read (never a re-read of the
// source), read back and proven against the sha256 the digest bound, before anything is replaced.
// `.agent-workflow/.gitignore` holding exactly `*` and a line feed is proven before the first copy,
// so no stop leaves a copy git can see, with no edit of the user's own ignore files. The kit never
// overwrites or deletes a kept-aside copy: a copy with other bytes is the user's to move.
//
// Dependency-free, Node >= 22. Every fs primitive is injectable (deps.*). No side effects on import.

import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { lstatNoFollow, writeProjectFileCreateOnly } from '../atomic-write.mjs';
import { RESERVED_DIR } from '../repo-lex.mjs';

export const KEPT_ASIDE_DIR = `${RESERVED_DIR}/kept-aside`;
const IGNORE_REL = `${RESERVED_DIR}/.gitignore`;
const IGNORE_BODY = '*\n';

export const keptAsidePath = (digest, rel) => `${KEPT_ASIDE_DIR}/${digest.slice(0, 16)}/${rel}`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const causeOf = (err) => String((err && err.message) || err);
const kindOf = (st) => (st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : st.isFile() ? 'a regular file' : 'not a regular file');
const NOTHING_DONE = 'nothing was kept aside or replaced';

// The node-kind preflight, before anything is created: every directory from the project root down
// to each copy's parent must be a real directory, and each copy path and the ignore file a regular
// file when present. Returns the refusal line, or null.
const chainRefusal = (cwd, rels, lstat) => {
  for (const rel of rels) {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const sub = parts.slice(0, i).join('/');
      const st = lstatNoFollow(join(cwd, sub), lstat);
      const leaf = i === parts.length;
      if (st && (leaf ? !st.isFile() : !st.isDirectory())) return `${sub}: exists but is ${kindOf(st)} — ${NOTHING_DONE}; resolve it by hand, then re-run`;
    }
  }
  return null;
};

const fail = (cause, line, kept) => {
  const written = kept.filter((copy) => copy.created).map((copy) => copy.path);
  const note = written.length > 0 ? [`the edits already kept aside stay where they are: ${written.join(', ')}`] : [];
  return { failed: true, cause, lines: [line, ...note], kept };
};

// keepAside({ cwd, digest, entries, deps }) → { failed: false, kept } with every edited entry's copy
// proven, or { failed: true, cause, lines, kept } naming why and which copies were already written.
// An absent entry gets no copy. `kept` lists { rel, path, created } per proven copy.
export const keepAside = ({ cwd, digest, entries, deps = {} }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFileSync;
  const edited = entries.filter((entry) => !entry.absent).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const kept = [];
  if (edited.length === 0) return { failed: false, kept };
  const refusal = chainRefusal(cwd, [IGNORE_REL, ...edited.map((entry) => keptAsidePath(digest, entry.rel))], lstat);
  if (refusal) return fail('wrong-node-kind', refusal, kept);
  let at = IGNORE_REL;
  try {
    if (lstatNoFollow(join(cwd, IGNORE_REL), lstat) === null) {
      writeProjectFileCreateOnly(cwd, IGNORE_REL, IGNORE_BODY, deps, { noun: 'the kept-aside ignore file' });
    }
    if (String(read(join(cwd, IGNORE_REL))) !== IGNORE_BODY) {
      return fail('write-refused', `${IGNORE_REL}: holds other bytes — it must hold exactly "*" and a line feed, so git sees no kept-aside copy; ${NOTHING_DONE}`, kept);
    }
    for (const entry of edited) {
      const path = keptAsidePath(digest, entry.rel);
      const abs = join(cwd, path);
      at = path;
      const created = lstatNoFollow(abs, lstat) === null && writeProjectFileCreateOnly(cwd, path, entry.bytes, deps, { noun: 'a kept-aside copy' }).created;
      if (sha256(read(abs)) !== entry.sha256) {
        return fail('race-unresolved', `${path}: a copy with other bytes is there — it is the user's to move or delete before the yes is asked again; nothing was replaced`, kept);
      }
      kept.push({ rel: entry.rel, path, created });
    }
  } catch (err) {
    return fail('write-refused', `${at}: ${causeOf(err)} — nothing was replaced`, kept);
  }
  return { failed: false, kept };
};
