// source-size-scope.mjs — which files the practice judges (D-6) and how big each one is (D-7). The
// two rules ride together because they meet in measureFile: the same strict-UTF-8 decoder decides
// both whether a PATH can be addressed losslessly and whether a file's BYTES can be judged, and both
// refuse through the same fail-closed lane.
//
//   • SCOPE (fail-closed) — git-tracked files under a declared root carrying a declared extension,
//     minus the excluded path-segment prefixes. Symlinks and submodule gitlinks are skipped BY KIND.
//     An unmerged index, a non-UTF-8 in-scope FILENAME, an unverifiable in-scope file and an empty
//     declared scope are REFUSALS (exit 1); a failed enumeration is exit 2. The enumeration is
//     NUL-delimited and every path test runs on BYTES, so a tracked path carrying a tab or a newline
//     is judged byte-exactly instead of being mangled by line splitting.
//   • COUNTING — lines, and the longest line in BYTES. Terminators never count, CR included.
//
// Dependency-free, Node >= 22. No side effects on import; the only child process is a read-only git
// query, so the read-graph purity suite stays true.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFail, configPathFor, scopeFail } from './source-size-refusal.mjs';
import { GIT_MAX_BUFFER, parseIndexEntries, resolveGitLocation, withGitPath } from './git-env.mjs';

const LF = 0x0a;
const CR = 0x0d;
const SLASH = 0x2f;

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

// The enumeration-error class (exit 2) also refuses every git LOCATION but a work tree, by its own
// state name — a redirecting GIT_DIR would otherwise enumerate ANOTHER repository's index in
// silence — and a runner that throws, which is an answer here, never a raw stack.
export const enumerateIndex = (cwd, deps = {}) => {
  const spawn = deps.spawn ?? spawnSync;
  const env = deps.env ?? process.env;
  const location = resolveGitLocation(cwd, { spawn, env });
  if (location.state !== 'work-tree') {
    throw configFail(`the git index could not be enumerated in ${cwd} (the git location is ${location.state}: ${location.cause}) — the declared scope is unknown, so nothing is judged`);
  }
  let result;
  try {
    result = spawn('git', ['ls-files', '-s', '-z'], { cwd, env: withGitPath(env), maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  } catch (err) {
    result = { error: err };
  }
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : result.signal ? `git was killed by ${result.signal}` : `git exited ${result.status}`;
    throw configFail(`the git index could not be enumerated in ${cwd} (${why}) — the declared scope is unknown, so nothing is judged`);
  }
  return parseIndexEntries(result.stdout);
};

// resolveScope(cwd, config) → { files: [rel…] sorted, perRoot: Map<root, [rel…]>, emptyRoots: [root…] }.
// Every exclusion is BY RULE (root / extension / exclude prefix) or BY KIND (symlink, gitlink); an
// in-scope path that cannot be addressed losslessly is a refusal, never a quiet skip.
export const resolveScope = (cwd, config, deps = {}) => {
  const entries = enumerateIndex(cwd, deps);
  const unmerged = entries.filter((e) => e.stage !== 0);
  if (unmerged.length > 0) {
    throw scopeFail(`the git index is UNMERGED (${unmerged.length} conflict-stage entr(ies)) — an ambiguous index cannot be judged; resolve the conflict, then re-run`);
  }
  const roots = config.roots.map((rel) => ({ rel, buf: Buffer.from(rel, 'utf8') }));
  const excludes = config.exclude.map((rel) => Buffer.from(rel, 'utf8'));
  const extensions = config.extensions.map((ext) => Buffer.from(ext, 'utf8'));
  const perRoot = new Map(config.roots.map((rel) => [rel, []]));
  const files = [];
  for (const entry of entries) {
    const root = roots.find((r) => bufSegmentPrefix(entry.path, r.buf));
    if (!root) continue;
    if (!extensions.some((ext) => bufEndsWith(entry.path, ext))) continue;
    if (excludes.some((ex) => bufSegmentPrefix(entry.path, ex))) continue;
    if (entry.mode === SYMLINK_MODE || entry.mode === GITLINK_MODE) continue;
    const rel = decodeStrict(entry.path);
    if (rel === null) {
      throw scopeFail(`an in-scope tracked path's NAME is not valid UTF-8 (bytes ${entry.path.toString('hex')}) — it cannot be addressed losslessly, so nothing is judged; rename it, or add its prefix to "exclude" in ${configPathFor(cwd)}`);
    }
    files.push(rel);
    perRoot.get(root.rel).push(rel);
  }
  if (files.length === 0) {
    throw scopeFail(`the declared scope matches ZERO tracked files (roots: ${config.roots.join(', ')}; extensions: ${config.extensions.join(', ')}) — an empty scope is a misdeclaration, never an empty green; either widen "roots" / "extensions" in ${configPathFor(cwd)}, or track a file the declared scope covers`);
  }
  files.sort();
  for (const list of perRoot.values()) list.sort();
  return { files, perRoot, emptyRoots: [...perRoot].filter(([, list]) => list.length === 0).map(([rel]) => rel) };
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
export const measureFile = (cwd, rel, deps = {}) => {
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
  return countBytes(buf);
};
