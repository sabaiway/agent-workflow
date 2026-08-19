#!/usr/bin/env node
// path-inventory.mjs — the promptless path-inventory lane (read-only).
//
// WHY THIS EXISTS. The «useless approves» corpus keeps recording the same authoring shape: several
// small read-only questions about paths — does it exist, how big is it, how many lines, what is in
// that directory, what does this small config say — batched into ONE composed shell with `echo`
// banners and a defensive `2>/dev/null`, because no single call answers them. The composition is
// what raises the prompt: a redirect takes the command out of the read-lane before it is even split,
// `echo` is outside the frozen read-only core, and the banner's quotes are forbidden per segment.
// The corpus has only ever responded to removing the REASON to compose a shell. This tool is that
// reason removed for the inventory half, the way repo-search.mjs is for the search half.
//
//   lane 1  --path <p>          repeatable, for a path with no shell-significant byte
//   lane 2  --paths-file <p>    the targets' bytes NEVER enter the command string
//
// CONTRACT
//   A MISSING path is a RESULT (`exists:false`, exit 0), never a failure. That is the whole point:
//   "does either of these exist" is a question whose interesting answer is "no", and a tool that
//   errors on it sends the caller straight back to a composed shell. Only a CONTAINMENT refusal or a
//   real I/O fault is an error.
//   CONTAINMENT is decided on the REAL path of the nearest EXISTING ancestor, so a target that does
//   not exist is still refused when it lives behind a symlink pointing out of the root — a lexical
//   check passes exactly that case.
//   Symlinks are reported BY TYPE and never followed; a dangling one is reported as a symlink that
//   does not resolve. Binary and special files are reported by type and never decoded.
//   Line count is `wc -l` compatible — newline CHARACTERS — so a final line without one is not
//   counted. A tool that answers a different question than the command it replaces is a trap.
//   Results are DETERMINISTIC: targets in input order, directory entries in code-unit order.
//   Four outcomes, never collapsed: results (0), INCOMPLETE (3, naming the bound that fired),
//   invalid input (2), I/O failure or containment refusal (1). No bound ever truncates silently.
//   Pure reader — no writes, no subprocess, no network. Dependency-free, Node >= 22, no side effects
//   on import (the isDirectRun idiom).
//
//   THREAT MODEL, stated rather than inherited in silence. Containment is decided on the REAL path of
//   the nearest existing ancestor, and every leaf is opened NO-FOLLOW; the directory listing never
//   follows a symlink and never descends. What is NOT defended against is an adversary mutating the
//   tree BETWEEN the containment check and the read: a directory swapped for a symlink in that window
//   would be traversed, and closing it needs descriptor-relative traversal (`openat` semantics) which
//   dependency-free Node does not expose. This is the SAME boundary `repo-search.mjs:33-40` states for
//   the same reason — both tools inspect a workspace their own agent controls, and concurrent hostile
//   mutation is out of scope. An unstated residual would be the defect; the residual itself is not.
//
// The paths-file FORMAT and the two failure classes are imported from repo-search.mjs rather than
// restated: one definition means the two file lanes cannot drift into classifying the same failure
// differently, which is the parity a copied helper would only promise.

import { openSync, fstatSync, readSync, closeSync, opendirSync, realpathSync, lstatSync, constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { isDirectRun } from './direct-run.mjs';

import {
  UsageError,
  IoError,
  assertNameableTarget,
  requiresDirectory,
  decodeLaneFile,
  parsePathsFile,
  HARD_MAX_TARGETS,
  HARD_MAX_PATHS_FILE_BYTES,
} from './repo-search.mjs';

export { HARD_MAX_TARGETS, HARD_MAX_PATHS_FILE_BYTES };

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_INCOMPLETE = 3;

// One bound governs every byte this tool reads out of a file: the line count needs the bytes just as
// much as `--contents` does, so a single named ceiling keeps "why is `lines` null" answerable.
export const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
export const HARD_MAX_CONTENT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 500;
export const HARD_MAX_ENTRIES = 20000;
// The AGGREGATE budget, and it is the load-bearing one. Per-file and per-directory ceilings bound a
// SINGLE target; with up to HARD_MAX_TARGETS of them the run is still unbounded, and every result
// accumulates in memory before anything is formatted. A cumulative ceiling is what makes the total
// cost a constant no number of targets can grow.
export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const HARD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_ENTRIES = 20000;
export const HARD_MAX_TOTAL_ENTRIES = 200000;
const BINARY_SNIFF_BYTES = 8192;
const NEWLINE = 0x0a;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const OPEN_FLAGS = constants.O_RDONLY | NOFOLLOW | NONBLOCK;

export const countLines = (buf) => {
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === NEWLINE) n += 1;
  return n;
};

// Over the WHOLE bounded buffer, not a sniff window: the contract says a binary is never decoded, and
// a NUL past the window would otherwise be handed back as text in direct contradiction of it. The
// buffer is already in memory and already bounded, so scanning all of it costs nothing extra.
const isBinary = (buf) => buf.includes(0);

const parseCount = (raw, flag, ceiling) => {
  if (!/^\d{1,15}$/u.test(raw ?? '')) throw new UsageError(`${flag} needs a plain non-negative integer, got: ${raw ?? '(missing)'}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new UsageError(`${flag} is not a safe integer: ${raw}`);
  if (n > ceiling) throw new UsageError(`${flag} exceeds the hard ceiling ${ceiling}: ${raw}`);
  return n;
};

const parseArgs = (argv) => {
  const opts = {
    paths: [],
    pathsFile: null,
    contents: false,
    maxContentBytes: DEFAULT_MAX_CONTENT_BYTES,
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    maxTotalEntries: DEFAULT_MAX_TOTAL_ENTRIES,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new UsageError(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--path') {
      const value = next();
      // An empty value passes a bare count check and then resolves to the ROOT — precisely the
      // accidental whole-root walk the "name at least one target" rule exists to prevent.
      if (value === '') throw new UsageError('--path needs a non-empty target');
      opts.paths.push(value);
    }
    else if (arg === '--paths-file') opts.pathsFile = next();
    else if (arg === '--contents') opts.contents = true;
    else if (arg === '--max-content-bytes') opts.maxContentBytes = parseCount(next(), '--max-content-bytes', HARD_MAX_CONTENT_BYTES);
    else if (arg === '--max-entries') opts.maxEntries = parseCount(next(), '--max-entries', HARD_MAX_ENTRIES);
    else if (arg === '--max-total-bytes') opts.maxTotalBytes = parseCount(next(), '--max-total-bytes', HARD_MAX_TOTAL_BYTES);
    else if (arg === '--max-total-entries') opts.maxTotalEntries = parseCount(next(), '--max-total-entries', HARD_MAX_TOTAL_ENTRIES);
    else if (arg === '--json') opts.json = true;
    else throw new UsageError(`unknown argument: ${arg} (see --help)`);
  }
  // No implicit target. A tool that walks the whole root when asked about nothing turns a typo into
  // an unbounded read, and the caller's question was always about NAMED paths.
  if (opts.paths.length === 0 && opts.pathsFile === null) {
    throw new UsageError('name at least one target with --path or --paths-file');
  }
  return opts;
};

// Containment on the REAL path of the nearest EXISTING ancestor. A target that does not exist has no
// real path of its own, and a lexical check on the parent is exactly what a symlinked ancestor
// defeats — so walk up until something resolves, and judge THAT.
export const resolveContained = (realRoot, target) => {
  assertNameableTarget(target);
  const lexical = resolve(realRoot, target);
  // Start the probe at the PARENT, never at the target itself: `realpathSync` on the target would
  // dereference a symlink leaf, and this tool promises to report a symlink BY TYPE and never follow
  // it. Probing the leaf turned a symlink pointing outside the root into a refusal instead of a
  // result — a contract violation the contract itself names. The leaf is still safe: it is `lstat`-ed
  // (which never follows) and opened O_NOFOLLOW (which refuses a symlink outright).
  let probe = lexical === realRoot ? lexical : dirname(lexical);
  for (;;) {
    let real;
    try {
      real = realpathSync(probe);
    } catch (err) {
      // ENOTDIR walks up for the same reason ENOENT does: a regular file used as an intermediate
      // component means the rest of the path does not exist, and "does not exist" is an ANSWER here,
      // not a fault. Refusing it would break the tool's central promise on an ordinary typo.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        throw new IoError(`cannot resolve ${target} (${err?.code ?? err?.message ?? err})`);
      }
      const parent = dirname(probe);
      if (parent === probe) throw new IoError(`cannot resolve ${target}`);
      probe = parent;
      continue;
    }
    const rel = relative(realRoot, real);
    if (rel !== '' && (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))) {
      throw new IoError(`target resolves outside the root: ${target}`);
    }
    return lexical;
  }
};

// Exported so the `special` fallback is testable: a FIFO, socket or device cannot be created inside
// the sandbox this suite runs in (a unix socket `listen` is EPERM), and a test that quietly skips
// when it cannot build its fixture is a test that checks nothing. These are pure maps from a stats
// shape to a type name, so a stub exercises exactly the branch a device would.
export const typeOfStats = (st) => {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'special';
};

export const typeOfDirent = (entry) => {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'special';
};

// Open → fstat the DESCRIPTOR → read bounded. O_NOFOLLOW refuses a symlinked leaf at open time and
// O_NONBLOCK means a special file that slipped in returns instead of hanging; fstat-ing the
// descriptor that was actually opened is what a swap between check and read cannot defeat.
// Returns a TAGGED outcome, never a bare null. An open that failed, a node that turned out not to be
// a regular file, and a read that stopped short are three different facts, and collapsing any of them
// into "here is your answer, lines are just null" is the silent failure this project forbids: the
// caller cannot tell "empty" from "unreadable" from "half-read".
const READ_OK = 'ok';
const READ_UNREADABLE = 'unreadable';
const READ_OVER_BOUND = 'over-bound';
const READ_SHORT = 'short';

// `io` is injectable so the SHORT-READ branch has a test. A read that stops early is a real race (the
// file shrinks between the fstat and the read) that no test can stage honestly on a real filesystem,
// and an untested defensive branch is indistinguishable from a wrong one.
export const readBounded = (abs, maxBytes, io = {}) => {
  const open = io.open ?? openSync;
  const fstat = io.fstat ?? fstatSync;
  const read = io.read ?? readSync;
  const close = io.close ?? closeSync;
  let fd;
  try {
    fd = open(abs, OPEN_FLAGS);
  } catch (err) {
    return { kind: READ_UNREADABLE, detail: err?.code ?? String(err) };
  }
  try {
    const st = fstat(fd);
    if (!st.isFile()) return { kind: READ_UNREADABLE, detail: 'not a regular file' };
    const size = Number(st.size);
    if (size > maxBytes) return { kind: READ_OVER_BOUND, size };
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    for (;;) {
      if (got >= size) break;
      const n = read(fd, buf, got, size - got, got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== size) return { kind: READ_SHORT, got, want: size };
    // The size travels WITH the buffer: the caller must report and budget the size the read was
    // actually sized by, never an earlier stat of the path. A file that grew in between would
    // otherwise be published at the wrong size, charged the wrong amount, and returned as complete.
    return { kind: READ_OK, buf, size };
  } finally {
    close(fd);
  }
};

const noteBound = (state, bound, detail) => {
  state.incomplete = state.incomplete ?? { bound, detail };
};

// Returns the entries AND the bound that cut them short, if any: a directory truncated by one
// ceiling while a later target hits a different one must still be able to say which one truncated IT.
const listDirectory = (abs, opts, state, rel) => {
  const entries = [];
  let bound = null;
  const dir = opendirSync(abs);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (entries.length >= opts.maxEntries) {
        bound = '--max-entries';
        noteBound(state, bound, `${rel} holds more than ${opts.maxEntries} entries`);
        break;
      }
      if (state.entries >= opts.maxTotalEntries) {
        bound = '--max-total-entries';
        noteBound(state, bound, `the run reached ${opts.maxTotalEntries} listed entries at ${rel}`);
        break;
      }
      state.entries += 1;
      entries.push({ name: entry.name, type: typeOfDirent(entry) });
    }
  } finally {
    dir.closeSync();
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, bound };
};

const inspectTarget = (realRoot, rel, opts, state) => {
  const abs = resolveContained(realRoot, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    // ENOTDIR is the same answer as ENOENT: a component along the way is a regular file, so the path
    // is not there. Anything else is a genuine fault and stays one.
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { path: rel, exists: false };
    throw new IoError(`cannot stat ${rel} (${err?.code ?? err?.message ?? err})`);
  }
  const type = typeOfStats(st);
  // A trailing separator or `.` asserts a directory; the OS answers ENOTDIR when it is not one, and
  // ENOTDIR is "not there" everywhere else in this tool.
  if (requiresDirectory(rel) && type !== 'directory') return { path: rel, exists: false };
  if (type === 'symlink') {
    // Only "the target is not there" means it does not resolve. A permission error, an I/O error or a
    // symlink LOOP are real faults, and reporting them as `(dangling)` with a clean exit would hide a
    // failure behind a normal-looking answer — the silent-failure class this tool refuses elsewhere.
    let resolves = true;
    try {
      realpathSync(abs);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        throw new IoError(`cannot resolve the symlink ${rel} (${err?.code ?? err?.message ?? err})`);
      }
      resolves = false;
    }
    return { path: rel, exists: true, type, resolves };
  }
  if (type === 'directory') {
    const listed = listDirectory(abs, opts, state, rel);
    return {
      path: rel,
      exists: true,
      type,
      entries: listed.entries,
      ...(listed.bound === null ? {} : { withheld: listed.bound }),
    };
  }
  if (type !== 'file') return { path: rel, exists: true, type, bytes: Number(st.size) };

  const size = Number(st.size);
  const base = { path: rel, exists: true, type, bytes: size, readable: true };
  // The bound that withheld THIS entry is recorded on the entry itself. `incomplete` keeps only the
  // first event for the run, so a later target hitting a different ceiling would otherwise come back
  // unread with no stated reason of its own.
  const withheld = (bound, detail, observedBytes = size) => {
    noteBound(state, bound, detail);
    return { ...base, bytes: observedBytes, withheld: bound, lines: null, binary: null, ...(opts.contents ? { contents: null } : {}) };
  };

  // The read is bounded by whichever ceiling binds FIRST — the per-file one or what is LEFT of the
  // run's budget. Checking the aggregate only afterwards would let every target read a full
  // `--max-content-bytes` before being rejected, so the aggregate ceiling would bound the accounting
  // and not the work, which is the opposite of what it is for.
  const remaining = Math.max(0, opts.maxTotalBytes - state.bytes);
  const limit = Math.min(opts.maxContentBytes, remaining);
  const read = readBounded(abs, limit, opts.io);
  // An unreadable file and a truncated read are I/O FAILURES, not bounds. The exit-code contract
  // reserves 3 for a ceiling that fired and 1 for an I/O failure, and a failed `opendir` already
  // exits 1 — reporting these as "incomplete" put a real fault under a code that means "bounded".
  if (read.kind === READ_UNREADABLE) throw new IoError(`cannot read ${rel} (${read.detail})`);
  if (read.kind === READ_SHORT) throw new IoError(`${rel} yielded ${read.got} of ${read.want} byte(s) — the file changed under the read`);
  if (read.kind === READ_OVER_BOUND) {
    // Which ceiling actually bound it is decided by the descriptor's size, so a file rejected because
    // the RUN had no budget left is never blamed on the per-file limit.
    // `bytes` comes from the DESCRIPTOR here too: the entry must not publish an earlier `lstat` size
    // while the reason beside it quotes a different one.
    // Blame the ceiling that FORMED the limit. Comparing against the per-file bound alone would name
    // it even when the run's remaining budget was the smaller of the two and did the actual cutting.
    return limit === opts.maxContentBytes
      ? withheld('--max-content-bytes', `${rel} is ${read.size} byte(s), above ${opts.maxContentBytes}`, read.size)
      : withheld('--max-total-bytes', `${rel} needs ${read.size} byte(s) and the run has ${remaining} left of ${opts.maxTotalBytes}`, read.size);
  }
  state.bytes += read.size;
  const binary = isBinary(read.buf);
  return {
    ...base,
    bytes: read.size,
    lines: binary ? null : countLines(read.buf),
    binary,
    ...(opts.contents ? { contents: binary ? null : read.buf.toString('utf8') } : {}),
  };
};

export const inventory = ({
  root,
  paths,
  contents = false,
  maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxTotalEntries = DEFAULT_MAX_TOTAL_ENTRIES,
  io = {},
}) => {
  const state = { incomplete: null, bytes: 0, entries: 0 };
  const opts = { contents, maxContentBytes, maxEntries, maxTotalBytes, maxTotalEntries, io };
  const results = paths.map((rel) => inspectTarget(root, rel, opts, state));
  return { results, incomplete: state.incomplete };
};

// Control and ANSI bytes reach the terminal through a NAME the tool did not choose. Escaping them is
// not cosmetic: a report about a hostile filename must not be a way to drive the reader's terminal.
export const escapeForDisplay = (text) =>
  [...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, '0')}`;
    return ch;
  }).join('');

// The bound that withheld an entry is printed WITH that entry: a run-level `incomplete` line names
// only the first event, so a reader of the human shape would otherwise see `unread` with no reason.
const withheldSuffix = (entry) => (entry.withheld === undefined ? '' : ` [withheld: ${entry.withheld}]`);

const formatEntry = (entry) => {
  const name = escapeForDisplay(entry.path);
  if (!entry.exists) return `${name}: absent`;
  if (entry.type === 'symlink') return `${name}: symlink${entry.resolves ? '' : ' (dangling)'}`;
  if (entry.type === 'directory') {
    const head = `${name}: directory, ${entry.entries.length} entr(ies)${withheldSuffix(entry)}`;
    return [head, ...entry.entries.map((e) => `    ${escapeForDisplay(e.name)}${e.type === 'directory' ? '/' : ''}`)].join('\n');
  }
  if (entry.type !== 'file') return `${name}: ${entry.type}, ${entry.bytes} byte(s)`;
  const lines = entry.lines === null ? (entry.binary ? 'binary' : 'unread') : `${entry.lines} line(s)`;
  const head = `${name}: file, ${entry.bytes} byte(s), ${lines}${withheldSuffix(entry)}`;
  if (entry.contents === undefined || entry.contents === null) return head;
  return [head, ...entry.contents.split('\n').map((l) => `    ${escapeForDisplay(l)}`)].join('\n');
};

const formatResult = (result) => {
  const lines = result.results.map(formatEntry);
  if (result.incomplete) lines.push(`  ⚠ INCOMPLETE (${result.incomplete.bound}): ${escapeForDisplay(result.incomplete.detail)}`);
  return lines.join('\n');
};

const HELP = `path-inventory — read-only facts about named paths, without composing a shell.

Usage:
  node path-inventory.mjs --path <p> [--path <p>]... [--contents] [--json]
  node path-inventory.mjs --paths-file <path> [--contents] [--json]

Answers, for each named target: does it exist, what type is it, how many bytes, how many lines
(wc -l compatible), what a directory holds (one level, sorted), and with --contents what a small
text file says. A MISSING path is a normal result, not an error.

--paths-file is the lane for targets carrying shell-significant bytes (\`>\`, \`$(\`, a backtick):
one target per line, their bytes never enter the command string. Write it with your host's
file-write tool; this tool never writes.

Symlinks are reported by type and never followed. Binary and special files are reported by type and
never decoded.

Bounds — a bound that fires is NAMED on the run AND on the entry it withheld, never a silent
truncation:
  --max-content-bytes <n>   per file, for the line count and --contents
  --max-entries <n>         per directory listing
  --max-total-bytes <n>     the whole run, across every target
  --max-total-entries <n>   the whole run, across every listing

A target must NAME EXACTLY ONE filesystem object: no empty value, no NUL byte, and no ".."
component (resolve() collapses it before the filesystem sees it). A trailing "/" or "/." is NOT
rejected — it ASSERTS the target is a directory, exactly as it does to the OS: it holds for a real
directory, and anything else answers exists:false. Awkward-but-unambiguous names — edge whitespace,
backticks, control bytes — are supported, and --paths-file is the lane for the ones a command string
cannot carry.

Exit codes: 0 answered · 1 I/O failure or a containment refusal · 2 usage / invalid input ·
3 answered but INCOMPLETE (a bound fired; the bound is named). A path that does not exist is a
RESULT, not a failure — an unreadable one that DOES exist is an I/O failure.`;

const readLaneFile = (root, rel, maxBytes) => {
  const abs = resolveContained(root, rel);
  const read = readBounded(abs, maxBytes);
  if (read.kind !== READ_OK) {
    throw new IoError(`cannot read --paths-file ${rel} as a regular file within ${maxBytes} byte(s) (${read.kind})`);
  }
  return decodeLaneFile(read.buf, '--paths-file');
};

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: EXIT_OK, stdout: HELP, stderr: '', result: null };
    const root = realpathSync(resolve(ctx.cwd ?? process.cwd()));
    const opts = parseArgs(argv);
    const named = [...opts.paths];
    if (opts.pathsFile !== null) {
      named.push(...parsePathsFile(readLaneFile(root, opts.pathsFile, HARD_MAX_PATHS_FILE_BYTES)));
    }
    // Dedupe across the UNION, not only within each lane. Here it is more than tidiness: a duplicate
    // target would be READ twice and charged twice against the run's aggregate byte budget.
    const paths = [...new Set(named)];
    // EVERY target is validated BEFORE any of them is inspected. Validating lazily means an invalid
    // target late in the list is refused only if the run gets that far — so whether the invocation is
    // accepted would depend on how much work happened first. A refusal must not depend on scheduling.
    for (const target of paths) assertNameableTarget(target);
    if (paths.length > HARD_MAX_TARGETS) {
      throw new UsageError(`more than the ceiling of ${HARD_MAX_TARGETS} targets`);
    }
    const result = inventory({
      root,
      paths,
      contents: opts.contents,
      maxContentBytes: opts.maxContentBytes,
      maxEntries: opts.maxEntries,
      maxTotalBytes: opts.maxTotalBytes,
      maxTotalEntries: opts.maxTotalEntries,
    });
    const stdout = opts.json ? JSON.stringify(result, null, 2) : formatResult(result);
    return { code: result.incomplete ? EXIT_INCOMPLETE : EXIT_OK, stdout, stderr: '', result };
  } catch (err) {
    // Errors carry the caller's own path, so they are escaped exactly like the success output. A
    // refusal that hands a hostile filename's control bytes straight to the terminal would make the
    // safe path the only safe one, which is the wrong half to protect.
    const say = (message) => `path-inventory: ${escapeForDisplay(String(message))}`;
    if (err instanceof UsageError) return { code: EXIT_USAGE, stdout: '', stderr: say(err.message), result: null };
    if (err instanceof IoError) return { code: EXIT_ERROR, stdout: '', stderr: say(err.message), result: null };
    return { code: EXIT_ERROR, stdout: '', stderr: say(err?.message ?? err), result: null };
  }
};

const emitResult = (r) => {
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
};

if (isDirectRun(import.meta.url)) emitResult(main(process.argv.slice(2)));
