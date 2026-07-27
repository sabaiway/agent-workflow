#!/usr/bin/env node
// repo-search.mjs — the promptless repository search lane (LITERAL search, read-only).
//
// WHY THIS EXISTS. A search whose pattern carries a shell-significant byte (`>`, `` ` ``, `$(`)
// cannot be issued as a seeded-core command without raising the residual ASK: the guard scans the
// raw command string AND a quote-stripped copy, so no quoting protects the byte. That is not a bug
// to fix in the guard — AD-079 closed that direction on four verified counterexamples. This tool
// routes around it instead, in two lanes:
//
//   lane 1  --pattern <literal>        for a pattern with no shell-significant byte
//   lane 2  --pattern-file <path>      the pattern's bytes NEVER enter the command string
//
// The selection rule is enforced by the hook, not by memory: this tool's invocation is in the
// hook's scanned list, so choosing lane 1 for a byte-carrying pattern earns an ASK whose reason
// names lane 2. A wrong choice costs one guiding prompt; it never costs silence.
//
// CONTRACT
//   LITERAL only — no regex dialect, and none is planned for this slice: a bounded walk cannot
//   interrupt a catastrophically backtracking RegExp call, so the class is removed, not mitigated.
//   Multiline patterns DO match (the search runs over the whole decoded buffer; a hit reports the
//   line it starts on).
//   Four outcomes, never collapsed: matches (0), no matches (0 with an explicitly empty result),
//   INCOMPLETE (3, naming the bound that fired), invalid input (2), I/O failure (1).
//   CONTAINMENT is decided on the REAL path, never lexically — a symlinked ancestor resolves out of
//   the root while passing every `..` check, and on Windows `relative()` across drives returns an
//   absolute path that contains no `..` at all.
//   Every file is opened NO-FOLLOW and NON-BLOCKING, then `fstat`-ed on the descriptor actually
//   opened: an lstat-then-read pair loses to a swap between the two calls, and the swapped-in FIFO
//   is precisely the blocking read this tool promises cannot happen.
//   Directories are walked INCREMENTALLY with the budget checked before each entry — reading and
//   sorting a whole directory first is unbounded work in exactly the case bounds exist for.
//
//   THREAT MODEL, stated rather than implied. Explicit `--path`/`--pattern-file` targets are
//   resolved (so a symlink INSIDE the root is followed by design) and then containment-checked on
//   the real path; the WALK never traverses a symlink at all. What is NOT defended against is an
//   adversary mutating the tree DURING the walk: a directory swapped for a symlink between its
//   lstat and its opendir would be traversed, and closing that needs descriptor-relative traversal
//   (`openat` semantics) which dependency-free Node does not expose. This tool searches a workspace
//   its own agent controls; concurrent hostile mutation is out of scope, and saying so is the
//   honest close — an unstated residual would be the defect.
//   Pure reader — no writes, no subprocess, no network. Dependency-free, Node >= 22, no side
//   effects on import (the isDirectRun idiom).

import { openSync, fstatSync, readSync, closeSync, opendirSync, realpathSync, lstatSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_INCOMPLETE = 3;

export const DEFAULT_MAX_RESULTS = 200;
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_WALK_BUDGET = 20000;
// Hard ceilings: a caller-supplied bound may lower these, never raise them. Without a ceiling the
// bounds are advisory, which is the same as absent.
export const HARD_MAX_RESULTS = 100000;
export const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
// Characters of context kept on EACH side of a match, and a HARD ceiling on the whole snippet.
// The ceiling is the load-bearing one: bounding only the context still lets a huge --pattern-file
// matched in many places accumulate, because the match itself rode into every snippet. With a total
// cap the stored size per match is a constant, so no size of pattern or file can grow it.
const SNIPPET_CONTEXT = 200;
const SNIPPET_MAX = 512;
const NEVER_WALKED = Object.freeze(['.git', 'node_modules']);
// O_NOFOLLOW refuses a symlinked leaf at open time; O_NONBLOCK means a FIFO that slipped in returns
// instead of hanging. Both are POSIX; on a platform lacking them the flags degrade to 0 and the
// fstat check below is the remaining guard.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const OPEN_FLAGS = constants.O_RDONLY | NOFOLLOW | NONBLOCK;

class UsageError extends Error {}
class IoError extends Error {}

// The pattern is echoed as a DIGEST plus a byte length — never as a first content line. A first
// line cannot separate two multiline patterns that share it, and it is unsafe for NUL/control
// bytes; a digest separates them and survives any byte.
export const patternDigest = (pattern) => {
  const buf = Buffer.from(pattern, 'utf8');
  return { digest: createHash('sha256').update(buf).digest('hex').slice(0, 16), bytes: buf.length };
};

// Exactly ONE trailing line ending is stripped — CRLF as one unit: a pattern file written by an
// editor almost always ends in one, while a pattern that deliberately ends in a blank line keeps it.
// Leaving a stray `\r` would make the search silently fail against LF content, which is the worst
// possible failure mode for a tool whose whole job is finding text.
export const resolvePattern = (raw) => {
  if (raw.endsWith('\r\n')) return raw.slice(0, -2);
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
};

// `Number()` turns a long digit string into Infinity, which would disable the very bound being
// parsed. Safe-integer and a hard ceiling are both required.
export const parseCount = (raw, flag, ceiling) => {
  if (!/^\d{1,15}$/u.test(raw ?? '')) throw new UsageError(`${flag} needs a plain non-negative integer, got: ${raw ?? '(missing)'}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new UsageError(`${flag} is not a safe integer: ${raw}`);
  if (n > ceiling) throw new UsageError(`${flag} exceeds the hard ceiling ${ceiling}: ${raw}`);
  return n;
};

const parseArgs = (argv) => {
  const opts = { pattern: null, patternFile: null, paths: [], max: DEFAULT_MAX_RESULTS, maxBytes: DEFAULT_MAX_FILE_BYTES, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new UsageError(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--pattern') opts.pattern = next();
    else if (arg === '--pattern-file') opts.patternFile = next();
    else if (arg === '--path') opts.paths.push(next());
    else if (arg === '--max') opts.max = parseCount(next(), '--max', HARD_MAX_RESULTS);
    else if (arg === '--max-bytes') opts.maxBytes = parseCount(next(), '--max-bytes', HARD_MAX_FILE_BYTES);
    else if (arg === '--json') opts.json = true;
    else throw new UsageError(`unknown argument: ${arg} (see --help)`);
  }
  if (opts.pattern !== null && opts.patternFile !== null) {
    throw new UsageError('--pattern and --pattern-file are mutually exclusive — the lane must be unambiguous');
  }
  if (opts.pattern === null && opts.patternFile === null) throw new UsageError('one of --pattern or --pattern-file is required');
  if (opts.paths.length === 0) opts.paths.push('.');
  return opts;
};

// Containment on the REAL path. A lexical check passes `link/secret.txt` whenever `link` resolves
// outside, and on Windows a cross-drive `relative()` returns an absolute path carrying no `..` —
// both were live review findings, not hypotheticals.
export const resolveTarget = (realRoot, target) => {
  const lexical = resolve(realRoot, target);
  let real;
  try {
    real = realpathSync(lexical);
  } catch (err) {
    if (err?.code === 'ENOENT') throw new IoError(`no such path: ${target}`);
    throw new IoError(`cannot resolve ${target} (${err?.code ?? err?.message ?? err})`);
  }
  const rel = relative(realRoot, real);
  if (rel !== '' && (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))) {
    throw new IoError(`target resolves outside the search root: ${target}`);
  }
  return real;
};

// Open → fstat the DESCRIPTOR → read bounded. The descriptor is what was actually opened, so a swap
// after the check cannot substitute a different node; O_NOFOLLOW refuses a symlinked leaf outright.
const readRegularFile = (abs, maxBytes, state, io = {}) => {
  const open = io.open ?? openSync;
  const fstat = io.fstat ?? fstatSync;
  const read = io.read ?? readSync;
  const close = io.close ?? closeSync;
  let fd;
  try {
    fd = open(abs, OPEN_FLAGS);
  } catch (err) {
    // ELOOP is a symlink refused by O_NOFOLLOW — a counted skip, not an error.
    if (err?.code === 'ELOOP') state.skipped.symlinks += 1;
    else state.skipped.unreadable += 1;
    return null;
  }
  try {
    const stat = fstat(fd);
    if (!stat.isFile()) {
      state.skipped.special += 1;
      return null;
    }
    if (stat.size > maxBytes) {
      state.skipped.large += 1;
      // A skipped file is NOT a silent omission: the search is incomplete and says which bound did
      // it. Reporting it only as a counter would let a partial search read as "no matches".
      if (state.incomplete === null) {
        state.incomplete = { bound: 'max-file-bytes', detail: `at least one file exceeds ${maxBytes} byte(s) and was not searched` };
      }
      return null;
    }
    const buf = Buffer.allocUnsafe(stat.size);
    let got = 0;
    while (got < stat.size) {
      const n = read(fd, buf, got, stat.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    // A short read means the file changed under us. Returning the partial buffer would let a
    // truncated file come back as a confident "no matches" — the file is classified unreadable
    // instead, which is counted and visible.
    if (got !== stat.size) {
      state.skipped.unreadable += 1;
      return null;
    }
    return buf;
  } catch {
    state.skipped.unreadable += 1;
    return null;
  } finally {
    close(fd);
  }
};

const isBinary = (buf) => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);

// Whole-buffer search, so a MULTILINE pattern matches; the line number is derived from the offset.
// The newline cursor is carried ACROSS matches rather than recounted from zero for each one — with
// the result cap at six figures, recounting is quadratic in the file length and burns the event
// loop on exactly the large files a search is aimed at.
const searchBuffer = (buf, pattern, relPath, state) => {
  const text = buf.toString('utf8');
  let from = 0;
  let line = 1;
  let counted = 0;
  for (;;) {
    const at = text.indexOf(pattern, from);
    if (at === -1) return;
    if (state.matches.length >= state.max) {
      state.incomplete = { bound: 'max-results', detail: `stopped at ${state.max} result(s); more may exist` };
      return;
    }
    for (let i = counted; i < at; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    counted = at;
    // A pattern that STARTS on a newline would otherwise take that same byte as its own line start
    // and report an empty snippet; searching back from the byte BEFORE it reports the line the match
    // actually begins on.
    const back = text.charCodeAt(at) === 10 ? Math.max(0, at - 1) : at;
    const lineStart = text.lastIndexOf('\n', back) + 1;
    // The snippet must span the WHOLE match: taking the line end from the match's START truncates a
    // multiline pattern at its first newline, so the snippet could exclude the very text that
    // matched (`\nbeta` in "alpha\nbeta" reported "alpha"). It is taken from the match's END.
    const lineEndRaw = text.indexOf('\n', at + pattern.length);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    // The snippet is WINDOWED around the match, not the whole line. A minified file is one enormous
    // line, and storing it per match turns a 200-result search into hundreds of megabytes — the
    // bound has to apply to what is kept, not only to how many are kept.
    const from0 = Math.max(lineStart, at - SNIPPET_CONTEXT);
    const to0 = Math.min(lineEnd, at + pattern.length + SNIPPET_CONTEXT);
    const windowed = `${from0 > lineStart ? '…' : ''}${text.slice(from0, to0)}${to0 < lineEnd ? '…' : ''}`;
    const snippet = windowed.length > SNIPPET_MAX ? `${windowed.slice(0, SNIPPET_MAX - 1)}…` : windowed;
    state.matches.push({ file: relPath, line, text: snippet });
    from = at + Math.max(1, pattern.length);
  }
};

const spend = (state) => {
  if (state.walked >= state.walkBudget) {
    if (state.incomplete === null) {
      state.incomplete = { bound: 'walk-budget', detail: `stopped after ${state.walkBudget} entries; the tree was not fully traversed` };
    }
    return false;
  }
  state.walked += 1;
  return true;
};

const walk = (root, abs, pattern, state, isExplicitTarget = false) => {
  if (state.incomplete !== null || !spend(state)) return;

  let stat;
  try {
    stat = (state.io.lstat ?? lstatSync)(abs);
  } catch {
    state.skipped.unreadable += 1;
    return;
  }
  if (stat.isSymbolicLink()) {
    state.skipped.symlinks += 1;
    return;
  }
  if (stat.isDirectory()) {
    // The default prune never applies to a directory the caller NAMED: `--path node_modules` asking
    // for nothing back, silently, is a worse answer than searching it.
    if (!isExplicitTarget && NEVER_WALKED.includes(abs.split(sep).pop())) return;
    let dir;
    try {
      dir = (state.io.opendir ?? opendirSync)(abs);
    } catch {
      state.skipped.unreadable += 1;
      return;
    }
    try {
      // Incremental: the budget is consulted before each entry, so one enormous directory cannot
      // force unbounded work (or unbounded memory) before the first check.
      for (;;) {
        const entry = dir.readSync();
        if (entry === null) break;
        if (state.incomplete !== null) break;
        walk(root, join(abs, entry.name), pattern, state);
      }
    } finally {
      dir.closeSync();
    }
    return;
  }
  if (state.excludePath !== null && abs === state.excludePath) {
    state.skipped.patternFile += 1;
    return;
  }
  const buf = readRegularFile(abs, state.maxBytes, state, state.io);
  if (buf === null) return;
  if (isBinary(buf)) {
    state.skipped.binary += 1;
    return;
  }
  searchBuffer(buf, pattern, relative(root, abs) || abs, state);
};

// `io` injects the filesystem primitives so the failure branches — a vanished entry, an unopenable
// directory, a symlink refused by O_NOFOLLOW, a file truncated mid-read — are reachable from tests.
// Every one of them is a COUNTED skip in production, and a counted skip that no test ever exercises
// is indistinguishable from a silent one.
export const search = ({ root, pattern, paths, max, maxBytes, excludePath = null, walkBudget = DEFAULT_WALK_BUDGET, io = {} }) => {
  const state = {
    matches: [],
    incomplete: null,
    skipped: { symlinks: 0, binary: 0, special: 0, unreadable: 0, large: 0, patternFile: 0 },
    excludePath,
    io,
    walked: 0,
    walkBudget,
    max,
    maxBytes,
  };
  for (const target of paths) {
    // The target list is bounded too: a caller passing thousands of --path values would otherwise
    // spend unbounded work resolving them while walk() returns immediately.
    if (state.incomplete !== null) break;
    walk(root, resolveTarget(root, target), pattern, state, true);
  }
  return {
    pattern: patternDigest(pattern),
    matches: state.matches,
    incomplete: state.incomplete,
    skipped: state.skipped,
    scanned: state.walked,
  };
};

const formatResult = (result) => {
  const lines = [
    `repo-search — literal pattern sha256:${result.pattern.digest} (${result.pattern.bytes} byte(s)) · ${result.scanned} entr(ies) scanned`,
  ];
  for (const m of result.matches) lines.push(`${m.file}:${m.line}: ${m.text}`);
  if (result.matches.length === 0) lines.push('  no matches');
  const skips = Object.entries(result.skipped).filter(([, n]) => n > 0);
  if (skips.length) lines.push(`  skipped: ${skips.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  if (result.incomplete) lines.push(`  ⚠ INCOMPLETE (${result.incomplete.bound}): ${result.incomplete.detail}`);
  return lines.join('\n');
};

const HELP = `repo-search — literal repository search that never has to ride a shell metacharacter.

Usage:
  node repo-search.mjs --pattern <literal> [--path <p>]... [--max <n>] [--max-bytes <n>] [--json]
  node repo-search.mjs --pattern-file <path> [--path <p>]... [--max <n>] [--max-bytes <n>] [--json]

--pattern-file is the lane for a pattern carrying shell-significant bytes (\`>\`, \`$(\`, a backtick):
its bytes never enter the command string, so the residual guard has nothing to scan. Write the file
with your host's file-write tool, then pass the plain path here, and delete it when you are done —
this tool never writes.

LITERAL only, multiline patterns supported. Reads regular files only, opened no-follow. Skipped
entries (symlinks, non-regular, binary, oversized, unreadable) are counted and reported, never
dropped silently; an oversized file additionally makes the whole search INCOMPLETE.

Exit codes: 0 search completed (matches or an explicitly empty result) · 1 I/O failure or refusal ·
2 usage / invalid input · 3 completed but INCOMPLETE (a bound fired; the bound is named).`;

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: EXIT_OK, stdout: HELP, stderr: '', result: null };
    const root = realpathSync(resolve(ctx.cwd ?? process.cwd()));
    const opts = parseArgs(argv);
    let raw;
    let excludePath = null;
    if (opts.patternFile !== null) {
      excludePath = resolveTarget(root, opts.patternFile);
      const state = { skipped: { symlinks: 0, special: 0, unreadable: 0, large: 0 }, incomplete: null };
      const buf = readRegularFile(excludePath, HARD_MAX_FILE_BYTES, state);
      if (buf === null) throw new IoError(`cannot read --pattern-file ${opts.patternFile} as a regular file`);
      raw = buf.toString('utf8');
    } else {
      raw = opts.pattern;
    }
    const pattern = opts.patternFile !== null ? resolvePattern(raw) : raw;
    if (pattern === '') throw new UsageError('the pattern is empty — it would match every line of every file');

    const result = search({ root, pattern, paths: opts.paths, max: opts.max, maxBytes: opts.maxBytes, excludePath });
    const stdout = opts.json ? JSON.stringify(result, null, 2) : formatResult(result);
    return { code: result.incomplete ? EXIT_INCOMPLETE : EXIT_OK, stdout, stderr: '', result };
  } catch (err) {
    if (err instanceof UsageError) return { code: EXIT_USAGE, stdout: '', stderr: `repo-search: ${err.message}`, result: null };
    if (err instanceof IoError) return { code: EXIT_ERROR, stdout: '', stderr: `repo-search: ${err.message}`, result: null };
    return { code: EXIT_ERROR, stdout: '', stderr: `repo-search: ${err?.message ?? err}`, result: null };
  }
};

const emitResult = (r) => {
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) emitResult(main(process.argv.slice(2)));
