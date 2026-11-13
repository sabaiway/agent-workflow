// source-size-scope.mjs — which files the practice judges (D-6) and how big each one is (D-7). The
// two rules ride together because they meet in measureFile: the same strict-UTF-8 decoder decides
// both whether a PATH can be addressed losslessly and whether a file's BYTES can be judged, and both
// refuse through the same fail-closed lane.
//
//   • SCOPE (fail-closed) — git-tracked files under a declared root carrying a declared extension,
//     minus the excluded path-segment prefixes and the kit's own folder scripts/agent-workflow
//     (KIT_FOLDER_ROOT). Symlinks and submodule gitlinks are skipped BY KIND. An unmerged index, a
//     non-UTF-8 in-scope FILENAME, an unverifiable in-scope file and a declared scope matching no
//     tracked file, the kit's own folder included, are REFUSALS (exit 1); a failed enumeration is
//     exit 2. The enumeration is NUL-delimited and every path test runs on BYTES, so a tracked path
//     carrying a tab or a newline is judged byte-exactly instead of being mangled by line splitting.
//   • COUNTING — lines, and the longest line in BYTES. Terminators never count, CR included.
//
// Dependency-free, Node >= 22. No side effects on import; the only child process is a read-only git
// query, so the read-graph purity suite stays true.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { configFail, configPathFor, scopeFail } from './source-size-refusal.mjs';
import { KIT_FOLDER_ROOT, WHOLE_TREE_ROOT } from './source-size-config.mjs';
import { SPEC_STORE_ROOT, walkSpecStore } from './source-size/index.mjs';
import { GIT_MAX_BUFFER, parseIndexEntries, resolveGitLocation, withGitPath } from './git-env.mjs';

const LF = 0x0a;
const CR = 0x0d;
const SLASH = 0x2f;

const SPEC_STORE = Buffer.from(SPEC_STORE_ROOT, 'utf8');
const KIT_FOLDER = Buffer.from(KIT_FOLDER_ROOT, 'utf8');
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

// The `ls-files -s -z` record parser lives in the git leaf (raw bytes in, raw path bytes out, the
// object id carried through so a consumer reading what the index HOLDS has it) — one home shared
// with the control-byte gate.

// A path whose bytes are not valid UTF-8 round-trips to something DIFFERENT (the replacement char is
// lossy) — that is the whole test, and it is exact.
const decodeStrict = (buf) => {
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
};

const bufSegmentPrefix = (path, prefix) =>
  path.length >= prefix.length &&
  path.subarray(0, prefix.length).equals(prefix) &&
  (path.length === prefix.length || path[prefix.length] === SLASH);

const bufEndsWith = (path, suffix) =>
  path.length >= suffix.length && path.subarray(path.length - suffix.length).equals(suffix);

const queryGit = (cwd, args, deps, what) => {
  const spawn = deps.spawn ?? spawnSync;
  const env = deps.env ?? process.env;
  const location = resolveGitLocation(cwd, { spawn, env });
  if (location.state !== 'work-tree') {
    throw configFail(`${what} in ${cwd} (the git location is ${location.state}: ${location.cause}) — the declared scope is unknown, so nothing is judged`);
  }
  const result = (() => {
    try {
      return spawn('git', args, { cwd, env: withGitPath(env), maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
    } catch (error) {
      return { error };
    }
  })();
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : result.signal ? `git was killed by ${result.signal}` : `git exited ${result.status}`;
    throw configFail(`${what} in ${cwd} (${why}) — the declared scope is unknown, so nothing is judged`);
  }
  return { stdout: result.stdout, top: location.top };
};

export const enumerateIndex = (cwd, deps = {}) => parseIndexEntries(
  queryGit(cwd, ['ls-files', '-s', '-z'], deps, 'the git index could not be enumerated').stdout);

const WORK_TREE_ARGS = Object.freeze(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames']);
const UNTRACKED_STATUS = '??';
const INTENT_STATUS = ' A';
const WORK_TREE_UNCHANGED = ' ';
const SHA256_HEX_LENGTH = 64;
const hashBlob = (bytes, oid) => createHash(oid.length === SHA256_HEX_LENGTH ? 'sha256' : 'sha1')
  .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const rulesOf = (config) => ({
  roots: config.roots.map((rel) => ({ rel, buf: Buffer.from(rel, 'utf8') })),
  excludes: config.exclude.map((rel) => Buffer.from(rel, 'utf8')),
  extensions: config.extensions.map((extension) => Buffer.from(extension, 'utf8')),
});
const rootOf = ({ roots }, path) => roots.find((root) => root.rel === WHOLE_TREE_ROOT || bufSegmentPrefix(path, root.buf));
const isExcluded = ({ excludes }, path) => excludes.some((entry) => bufSegmentPrefix(path, entry));
const isExtended = ({ extensions }, path) => extensions.some((extension) => bufEndsWith(path, extension));

export const workTreeOf = (cwd, config, { scope, bytes, layout }, deps = {}) => {
  const { stdout, top } = queryGit(cwd, WORK_TREE_ARGS, deps, "the git work tree's state could not be read");
  const below = relative(realpathSync(top), realpathSync(cwd)).split(sep).join('/');
  const prefix = below === '' ? Buffer.alloc(0) : Buffer.from(`${below}/`, 'utf8');
  const entries = stdout.toString('latin1').split('\0').filter(Boolean)
    .map((record) => ({ status: record.slice(0, 2), path: Buffer.from(record.slice(3), 'latin1') }))
    .filter(({ path }) => path.subarray(0, prefix.length).equals(prefix))
    .map((entry) => ({ ...entry, path: entry.path.subarray(prefix.length) }));
  const rules = rulesOf(config);
  const intents = new Set(entries.filter((entry) => entry.status === INTENT_STATUS).map((entry) => decodeStrict(entry.path)));
  const untracked = entries.filter(({ status, path }) => status === UNTRACKED_STATUS
    && rootOf(rules, path) !== undefined && !isExcluded(rules, path) && !bufSegmentPrefix(path, KIT_FOLDER)
    && (isExtended(rules, path) || (layout && !bufSegmentPrefix(path, SPEC_STORE))))
    .map(({ path }) => path.toString('utf8')).sort();
  const changed = new Set(entries.filter(({ status }) => status !== UNTRACKED_STATUS && status[1] !== WORK_TREE_UNCHANGED)
    .map((entry) => decodeStrict(entry.path)));
  const differing = scope.files.filter((rel) => intents.has(rel)
    || (changed.has(rel) && hashBlob(bytes.get(rel), scope.objectIds.get(rel)) !== scope.objectIds.get(rel)));
  return { untracked, differing };
};

// resolveScope(cwd, config) → { files: [rel…] sorted, perRoot: Map<root, [rel…]>, layout: Map<root,
// [{ path, dir }…]>, emptyRoots: [root…], kitFolderRoots: [root…] }; `layout` holds every entry under
// a root, of any mode, as a binary string below the root; `kitFolderRoots` are the empty roots whose
// matches all lie inside the kit's own folder.
// Every exclusion is BY RULE (root / extension / exclude prefix / the kit's own folder) or BY KIND
// (symlink, gitlink); an in-scope path that cannot be addressed losslessly is a refusal, never a quiet
// skip. The root "." covers every tracked path.
export const resolveScope = (cwd, config, deps = {}) => {
  const entries = enumerateIndex(cwd, deps);
  const unmerged = entries.filter((e) => e.stage !== 0);
  if (unmerged.length > 0) {
    throw scopeFail(`the git index is UNMERGED (${unmerged.length} conflict-stage entr(ies)) — an ambiguous index cannot be judged; resolve the conflict, then re-run`);
  }
  const rules = rulesOf(config);
  const { excludes, extensions } = rules;
  const excluded = config.exclude.map((entry, at) => {
    const carried = entries.filter(({ path }) => bufSegmentPrefix(path, excludes[at]));
    const count = carried.filter(({ path }) => rootOf(rules, path) !== undefined).length;
    return { entry, count, carried: carried.length };
  });
  const objectIds = new Map();
  const perRoot = new Map(config.roots.map((rel) => [rel, []]));
  const layout = new Map(config.roots.map((rel) => [rel, []]));
  const files = [];
  const kitMatched = new Set();
  for (const entry of entries) {
    const root = rootOf(rules, entry.path);
    if (!root) continue;
    if (isExcluded(rules, entry.path)) continue;
    const extended = isExtended(rules, entry.path);
    if (bufSegmentPrefix(entry.path, KIT_FOLDER)) {
      if (extended) kitMatched.add(root.rel);
      continue;
    }
    // Layout counts every entry of any mode, the spec store's aside: the store is a root of its own.
    if (!bufSegmentPrefix(entry.path, SPEC_STORE)) {
      const below = root.rel === WHOLE_TREE_ROOT ? entry.path : entry.path.subarray(root.buf.length + 1);
      if (below.length > 0) layout.get(root.rel).push({ path: below.toString('latin1'), dir: false });
    }
    if (!extended) continue;
    if (entry.mode === SYMLINK_MODE || entry.mode === GITLINK_MODE) continue;
    const rel = decodeStrict(entry.path);
    if (rel === null) {
      throw scopeFail(`an in-scope tracked path's NAME is not valid UTF-8 (bytes ${entry.path.toString('hex')}) — it cannot be addressed losslessly, so nothing is judged; rename it, or add its prefix to "exclude" in ${configPathFor(cwd)}`);
    }
    files.push(rel);
    objectIds.set(rel, entry.sha);
    perRoot.get(root.rel).push(rel);
  }
  // A config declaring no extension judges no file, and the check says so instead of refusing.
  if (extensions.length === 0) return { files, perRoot, layout, emptyRoots: [], kitFolderRoots: [], excluded, objectIds };
  // A scope the kit's own folder alone matches judges no line, and is no misdeclaration.
  if (files.length === 0 && kitMatched.size === 0) {
    throw scopeFail(`the declared scope matches ZERO tracked files (roots: ${config.roots.join(', ')}; extensions: ${config.extensions.join(', ')}) — an empty scope is a misdeclaration, never an empty green; either widen "roots" / "extensions" in ${configPathFor(cwd)}, or track a file the declared scope covers`);
  }
  files.sort();
  for (const list of perRoot.values()) list.sort();
  const emptyRoots = [...perRoot].filter(([, list]) => list.length === 0).map(([rel]) => rel);
  return { files, perRoot, layout, emptyRoots, kitFolderRoots: emptyRoots.filter((rel) => kitMatched.has(rel)), excluded, objectIds };
};

// specStoreEntries(cwd) → the spec store's entries walked from disk, or null where it is absent. A
// store that is present but no directory, or that cannot be read, is a scope refusal naming the path.
export const specStoreEntries = (cwd, deps = {}) => {
  const walked = walkSpecStore(cwd, { readdir: deps.readdir ?? readdirSync, lstat: deps.lstat ?? lstatSync });
  if (walked.state === 'absent') return null;
  if (walked.state === 'refused') {
    throw scopeFail(`${walked.path}: the spec store ${SPEC_STORE_ROOT} could not be walked (${walked.cause}) — layout counts it from disk, so nothing is judged; make it a readable directory, or remove it`);
  }
  return walked.entries;
};

// countBytes(buf) → { lines, maxLineBytes }. A terminator never counts (the CR of a CRLF included);
// a last line with no final newline still counts; an empty file is 0 lines.
export const countBytes = (buf) => {
  let lines = 0;
  let maxLineBytes = 0;
  let start = 0;
  const widen = (from, to) => {
    lines += 1;
    if (to - from > maxLineBytes) maxLineBytes = to - from;
  };
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== LF) continue;
    widen(start, i > start && buf[i - 1] === CR ? i - 1 : i);
    start = i + 1;
  }
  if (start < buf.length) widen(start, buf.length);
  return { lines, maxLineBytes };
};

// measureFile(cwd, rel) → { lines, maxLineBytes }. The judged bytes are the WORKTREE bytes of an
// index-visible path; an in-scope file the checker cannot verify is exit 1 naming the exclude lane,
// never a silent or green skip.
export const measureFile = (cwd, rel, deps = {}, observe = () => {}) => {
  const read = deps.readFile ?? readFileSync;
  let buf;
  try {
    buf = read(join(cwd, rel));
  } catch (err) {
    throw scopeFail(`${rel}: in-scope but unverifiable (${err.message}) — a file the checker cannot read is never a silent skip; fix it, or add its prefix to "exclude" in ${configPathFor(cwd)}`);
  }
  if (decodeStrict(buf) === null) {
    throw scopeFail(`${rel}: in-scope but not valid UTF-8 — its size cannot be judged; add its prefix to "exclude" in ${configPathFor(cwd)}`);
  }
  observe(buf);
  return countBytes(buf);
};
