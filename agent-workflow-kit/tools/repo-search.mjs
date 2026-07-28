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
//   lane 3  --paths-file <path>        the TARGETS' bytes never enter it either
//
// Lane 3 exists because lanes 1-2 answered only half the arguments: a search could name a pattern it
// could not spell in a shell, but not a PATH it could not spell, and this kit ships shell-byte
// fixtures as a genre. Both lane files are excluded from the search itself, by REAL path.
//
// The hook covers this tool's invocation: choosing lane 1 for a byte-carrying pattern raises an ASK
// whose reason names lane 2. Stated exactly: that ask goes to the HUMAN, and the reason is context for
// their decision — it is not delivered to the caller that composed the command. So the ask costs one
// human decision and never costs silence, but it is not by itself a correction mechanism.
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
// The `--paths-file` lane's own bounds. A target list arrives as a FILE, so neither its size nor its
// entry count is visible in the command string the caller composed — without ceilings here the lane
// would be the one unbounded input on a tool whose every other input is bounded.
export const HARD_MAX_TARGETS = 5000;
export const HARD_MAX_PATHS_FILE_BYTES = 4 * 1024 * 1024;
// The AGGREGATE read budget. The walk budget counts ENTRIES; without a byte ceiling a run may read up
// to the per-file limit for every one of them, which is unbounded work no bound was consulted about.
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const HARD_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
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

// Exported so a sibling kit tool reusing `parsePathsFile` maps the SAME failure to the SAME exit
// code by construction — an `instanceof` against a private class would silently degrade a usage
// error into a generic one, and exit-code parity between the two file lanes would be a promise
// instead of a mechanism.
export class UsageError extends Error {}
export class IoError extends Error {}

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
  const opts = { pattern: null, patternFile: null, paths: [], pathsFile: null, max: DEFAULT_MAX_RESULTS, maxBytes: DEFAULT_MAX_FILE_BYTES, maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES, json: false };
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
    else if (arg === '--paths-file') opts.pathsFile = next();
    else if (arg === '--max') opts.max = parseCount(next(), '--max', HARD_MAX_RESULTS);
    else if (arg === '--max-bytes') opts.maxBytes = parseCount(next(), '--max-bytes', HARD_MAX_FILE_BYTES);
    else if (arg === '--max-total-bytes') opts.maxTotalBytes = parseCount(next(), '--max-total-bytes', HARD_MAX_TOTAL_BYTES);
    else if (arg === '--json') opts.json = true;
    else throw new UsageError(`unknown argument: ${arg} (see --help)`);
  }
  if (opts.pattern !== null && opts.patternFile !== null) {
    throw new UsageError('--pattern and --pattern-file are mutually exclusive — the lane must be unambiguous');
  }
  if (opts.pattern === null && opts.patternFile === null) throw new UsageError('one of --pattern or --pattern-file is required');
  // The default target is applied only when the caller named NEITHER lane: `--paths-file` supplies
  // targets after argv is parsed, so defaulting here on an empty `--path` list would silently union
  // the whole root into an explicitly named list.
  if (opts.paths.length === 0 && opts.pathsFile === null) opts.paths.push('.');
  return opts;
};

// The `--paths-file` format, pinned rather than discovered: one target per line, UTF-8, LF or CRLF, a
// trailing delimiter is not an extra entry, EMPTY lines are ignored, duplicates collapse. There is no
// comment syntax and no escaping, so a filename containing a newline CANNOT be expressed by this lane
// — stated here because an unstated gap in a lane that exists to carry awkward names is the defect,
// not the gap.
//
// A line is NOT trimmed. This lane exists to carry names a command string cannot, and a leading or
// trailing space is exactly such a name: trimming would silently rewrite the caller's target, which is
// the failure mode the lane was built to remove. A whitespace-only line is therefore a real target and
// either resolves or fails loudly — never a silent stand-in for the root.
//
// THREE name classes this lane CANNOT express, stated rather than discovered: one containing a
// newline (there is no escaping); one ENDING in a carriage return (a trailing CR is stripped as the
// CRLF delimiter it almost always is, and no line-oriented format can tell those apart without an
// encoding this lane deliberately does not have); and one whose bytes are not valid UTF-8. The first
// two are refused by silence — the target simply will not be found, loudly. The third is refused
// EXPLICITLY, because `Buffer.toString('utf8')` would replace the offending bytes with U+FFFD and the
// lane would then search a DIFFERENT path that happens to exist, which is worse than any refusal.
// `ignoreBOM: true` means "do not TREAT a leading U+FEFF as a byte-order mark", i.e. keep it as a
// character. The default strips it, which would rewrite a legitimate name beginning with U+FEFF into
// a different one — the same silent-substitution class as a lossy decode, one layer down.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const decodeLaneFile = (buf, flag) => {
  try {
    return strictUtf8.decode(buf);
  } catch {
    throw new UsageError(`${flag} is not valid UTF-8 — a lossy decode would silently name a different path`);
  }
};
export const parsePathsFile = (raw, flag = '--paths-file') => {
  const entries = raw.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).filter((line) => line !== '');
  // The ceiling counts TARGETS, so it is applied after dedupe: a file repeating one path 5001 times
  // names one target and refusing it would be a bound on the file's shape rather than on the work.
  const unique = [...new Set(entries)];
  if (unique.length > HARD_MAX_TARGETS) {
    throw new UsageError(`${flag} lists ${unique.length} distinct targets, above the ceiling of ${HARD_MAX_TARGETS}`);
  }
  if (unique.length === 0) throw new UsageError(`${flag} names no target — a blank list is never "search everything"`);
  return unique;
};

// ── the acceptance predicate for a caller-supplied TARGET ─────────────────────────────
//
// ONE closed rule set, applied before any target reaches `resolve()`. It replaces what were seven
// checks discovered one review round at a time, all of which turned out to be the same defect: a
// caller string is handed to `path.resolve()` / `realpathSync`, whose semantics differ from the
// operating system's, so the tool can end up answering about a DIFFERENT object than the string
// denotes. That is the one outcome worse than any refusal.
//
// The rule the predicate enforces: **a target is accepted only if it names exactly one filesystem
// object unambiguously.** Awkward-but-unambiguous names are supported on purpose — edge whitespace,
// backticks, control bytes — because carrying those is what the out-of-band lane exists for.
//
// Separators are PLATFORM-CORRECT, and that is load-bearing: on POSIX a backslash is an ordinary
// byte in a filename, so splitting on it would refuse `\..` — a legal file the OS answers about
// normally. An over-refusal is a smaller defect than a wrong answer, but it is still a defect.
const TARGET_SEPARATORS = Object.freeze(sep === '\\' ? ['/', '\\'] : ['/']);
const TARGET_SEPARATOR_SPLIT = sep === '\\' ? /[\\/]/u : /\//u;

// A trailing separator, or a trailing `.` component, is an ASSERTION by the caller that the target is
// a DIRECTORY — that is what it means to the operating system, which answers ENOTDIR when it is not.
// `resolve()` erases both forms before the filesystem sees them, so the assertion has to be carried
// separately and checked after resolution. Refusing these outright was wrong in both directions: it
// rejected `existing-directory/`, which names one object unambiguously, while still accepting
// `regular-file/.`, which the OS refuses.
//
// Stated divergence, and it differs per tool. `path-inventory` reports a symlink BY TYPE and never
// follows it, so `symlink-to-a-directory/` is not a directory there, while the OS would dereference
// it — following it would contradict that tool's louder promise. `repo-search` DOES resolve an
// explicitly named target (its threat model says so at the top of this file), so the assertion is
// checked against the resolved object and it agrees with the OS.
export const requiresDirectory = (target) => {
  if (TARGET_SEPARATORS.some((separator) => target.endsWith(separator))) return true;
  const components = target.split(TARGET_SEPARATOR_SPLIT);
  return components[components.length - 1] === '.';
};

export const assertNameableTarget = (target, flag = '--path') => {
  const refuse = (why) => {
    throw new UsageError(`${flag} ${why} — got ${JSON.stringify(target)}`);
  };
  if (target === '') refuse('must not be empty; an empty target resolves to the whole root');
  if (target.includes('\0')) refuse('must not contain a NUL byte; no filesystem path can hold one');
  if (target.split(TARGET_SEPARATOR_SPLIT).includes('..')) {
    refuse('must not contain a ".." component; resolve() collapses it lexically, so the answer could be about a different object than the OS would reach');
  }
};

// Containment on the REAL path. A lexical check passes `link/secret.txt` whenever `link` resolves
// outside, and on Windows a cross-drive `relative()` returns an absolute path carrying no `..` —
// both were live review findings, not hypotheticals.
export const resolveTarget = (realRoot, target) => {
  assertNameableTarget(target);
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
  if (requiresDirectory(target) && !lstatSync(real).isDirectory()) {
    throw new IoError(`no such path: ${target} — a trailing separator or "." asserts a directory, and this is not one`);
  }
  return real;
};

// Open → fstat the DESCRIPTOR → read bounded. The descriptor is what was actually opened, so a swap
// after the check cannot substitute a different node; O_NOFOLLOW refuses a symlinked leaf outright.
const readRegularFile = (abs, maxBytes, state, io = {}, boundName = 'max-file-bytes') => {
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
        state.incomplete = { bound: boundName, detail: `at least one file exceeds ${maxBytes} byte(s) and was not searched` };
      }
      return null;
    }
    const buf = Buffer.allocUnsafe(stat.size);
    let got = 0;
    while (got < stat.size) {
      const n = read(fd, buf, got, stat.size - got, got);
      if (n <= 0) break;
      got += n;
      // Charged INSIDE the loop, per successful chunk. After the loop is too late: a `read` that
      // throws mid-file skips the charge entirely, so a series of partial reads that end in a fault
      // would move real bytes the aggregate budget never learns about.
      state.bytesRead += n;
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
  const excludedAs = state.excludePaths.get(abs);
  if (excludedAs !== undefined) {
    state.skipped[excludedAs] += 1;
    return;
  }
  // The walk budget counts ENTRIES, not bytes, so without this a run may read up to the per-file
  // ceiling for every one of them — twenty thousand files at the hard per-file ceiling is work no
  // bound was ever consulted about. The sibling inventory tool already carries an aggregate byte
  // budget for exactly this reason; this closes the asymmetry rather than stating it.
  const remaining = state.maxTotalBytes - state.bytesRead;
  if (remaining <= 0) {
    state.incomplete = state.incomplete ?? {
      bound: '--max-total-bytes',
      detail: `stopped after reading ${state.bytesRead} byte(s); the tree was not fully searched`,
    };
    return;
  }
  // The read is bounded by whichever ceiling binds FIRST. Checking the aggregate only BEFORE the file
  // and then handing the reader the full per-file limit lets a single file larger than the remaining
  // budget be read whole — the budget would bound the accounting, not the work.
  const limit = Math.min(state.maxBytes, remaining);
  const boundName = limit < state.maxBytes ? '--max-total-bytes' : 'max-file-bytes';
  const buf = readRegularFile(abs, limit, state, state.io, boundName);
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
// `excludePaths` maps a REAL path to the skip counter it belongs to: BOTH lane files must be kept out
// of their own search (a `--paths-file` under a searched target would otherwise match on its own
// contents), and a skip that is not attributed to its lane is indistinguishable from a silent one.
export const search = ({ root, pattern, paths, max, maxBytes, excludePaths = new Map(), walkBudget = DEFAULT_WALK_BUDGET, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES, io = {} }) => {
  const state = {
    matches: [],
    incomplete: null,
    skipped: { symlinks: 0, binary: 0, special: 0, unreadable: 0, large: 0, patternFile: 0, pathsFile: 0 },
    excludePaths,
    io,
    walked: 0,
    walkBudget,
    bytesRead: 0,
    maxTotalBytes,
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
    // Reported so the aggregate budget is observable rather than internal: a bound that nobody can
    // read is a bound nobody can test.
    bytesRead: state.bytesRead,
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

Usage — pick ONE pattern lane and ANY combination of target lanes:
  pattern lane   --pattern <literal>   |   --pattern-file <path>          (mutually exclusive)
  target lanes   [--path <p>]...       and/or   --paths-file <path>       (union; default: .)
  shared flags   [--max <n>] [--max-bytes <n>] [--max-total-bytes <n>] [--json]

A target must NAME EXACTLY ONE filesystem object: no empty value, no NUL byte, and no ".."
component (resolve() collapses it before the filesystem sees it). A trailing "/" or "/." is NOT
rejected — it ASSERTS the target is a directory, exactly as it does to the OS: it holds for a real
directory and fails for anything else. Awkward-but-unambiguous names — edge whitespace, backticks,
control bytes — are supported, and --paths-file is the lane for the ones a command string cannot
carry.

Two out-of-band lanes, one per argument half — their bytes never enter the command string, so the
residual guard has nothing to scan:
  --pattern-file <path>   a PATTERN carrying shell-significant bytes (\`>\`, \`$(\`, a backtick)
  --paths-file <path>     TARGET paths carrying the same, one per line

Write either file with your host's file-write tool, pass the plain path here, and delete it when you
are done — this tool never writes. --paths-file format: one target per line, UTF-8, LF or CRLF; blank
lines ignored; duplicates collapse; no comment syntax and no escaping, so a filename containing a
newline cannot be expressed by this lane. Both lane files are excluded from the search itself.

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
    const excludePaths = new Map();
    // ONE reader for both out-of-band lanes, so their failure classification cannot drift: a missing,
    // unreadable or non-regular lane file is an IoError (exit 1) for the pattern lane and for the
    // target lane alike.
    const readLaneFile = (rel, flag, maxBytes, counter) => {
      const abs = resolveTarget(root, rel);
      // `bytesRead` is present but SEPARATE from the search's budget: reading a lane file is the
      // caller's own instruction, not tree traversal, so it is accounted and then discarded.
      const state = { skipped: { symlinks: 0, special: 0, unreadable: 0, large: 0 }, incomplete: null, bytesRead: 0 };
      const buf = readRegularFile(abs, maxBytes, state);
      if (buf === null) throw new IoError(`cannot read ${flag} ${rel} as a regular file`);
      excludePaths.set(abs, counter);
      return decodeLaneFile(buf, flag);
    };
    let raw;
    if (opts.patternFile !== null) {
      raw = readLaneFile(opts.patternFile, '--pattern-file', HARD_MAX_FILE_BYTES, 'patternFile');
    } else {
      raw = opts.pattern;
    }
    const pattern = opts.patternFile !== null ? resolvePattern(raw) : raw;
    if (pattern === '') throw new UsageError('the pattern is empty — it would match every line of every file');

    const named = [...opts.paths];
    if (opts.pathsFile !== null) {
      const listed = readLaneFile(opts.pathsFile, '--paths-file', HARD_MAX_PATHS_FILE_BYTES, 'pathsFile');
      named.push(...parsePathsFile(listed));
    }
    // Dedupe across the UNION, not only within each lane: the same target named by `--path` and by
    // the file would otherwise be walked twice.
    const paths = [...new Set(named)];
    // EVERY target is validated BEFORE any of them is walked. Validating lazily per target means an
    // invalid one late in the list is only refused if the walk gets that far — and a bound that fires
    // on an earlier target ends the loop first, so the same invocation would be accepted or refused
    // depending on how much work happened to be done. A refusal must not depend on scheduling.
    for (const target of paths) assertNameableTarget(target);
    // The ceiling holds over the UNION. `parsePathsFile` bounds the file, but thousands of `--path`
    // values would otherwise walk straight past it.
    if (paths.length > HARD_MAX_TARGETS) {
      throw new UsageError(`more than the ceiling of ${HARD_MAX_TARGETS} targets`);
    }

    const result = search({ root, pattern, paths, max: opts.max, maxBytes: opts.maxBytes, maxTotalBytes: opts.maxTotalBytes, excludePaths });
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
