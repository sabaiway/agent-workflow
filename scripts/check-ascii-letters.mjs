#!/usr/bin/env node
// check-ascii-letters.mjs — the ENGLISH-ONLY invariant of this repository, as a MECHANISM.
//
// The bar was prose for the whole life of the project and broke more than once: a fixture here, an
// illustrative sentence there, and a whole feature's vocabulary in a language the kit does not ship.
// Prose bars fail under load; a checker does not. This is the checker.
//
// THE PREDICATE IS A NON-ASCII LETTER — `/[^\P{L}\x00-\x7F]/u` — and never "no Cyrillic". Searching
// for one alphabet is itself a locale assumption, and it under-reports: measured on this tree the
// same day, a Cyrillic-only search found 12 files and this predicate found 21. Letters only, so the
// typography this family already uses stays legal: an em dash, guillemets, a curly apostrophe, an
// arrow and an emoji are punctuation and symbols, not letters, and none of them is a language.
//
// A fixture that genuinely NEEDS the character keeps it as a `\uXXXX` escape: the runtime string is
// byte-identical, the test proves exactly what it proved before, and the SOURCE stays ASCII. That is
// the whole workaround, and there is deliberately no allowlist to reach for instead.
//
// SCOPE — three surfaces, because all three ride in the shipped git tree: the PATH NAME, the file
// CONTENT, and a SYMLINK's TARGET (which IS its blob). Judging content alone would let an accented
// FILENAME, and a symlink whose target names one, through untouched. The enumeration is literally
// the source-size practice's own `enumerateIndex`, so the two gates can never disagree about what
// "tracked" means.
//
// THE BYTES COME FROM THE INDEX, not from the worktree, because the index is what SHIPS. A worktree
// read makes the summary line untrue in three ordinary situations: a blob staged in one wording
// while the worktree holds another, a sparse checkout where most content is simply not on disk, and
// a tracked path deleted from the worktree but still in the commit about to be made. Each of those
// would report a green over content the checker never read. Reading the index also removes the need
// to guess a file's kind from a stat: the index states the mode, and the blob under it is exactly
// the thing that kind describes. The cost, stated: an UNSTAGED edit is not judged. That is the right
// subject for a commit gate — the run that matters is the one over the index that becomes the
// commit — and the edit is judged the moment it is staged.
//
// BINARY IS DECIDED BY A NUL BYTE, not by UTF-8 validity — git's own heuristic. The difference is
// the whole hole: a Latin-1 file carrying a lone 0xE9 byte (a lowercase e-acute) is INVALID UTF-8
// and is real text, so "invalid UTF-8 means binary" would skip exactly the file this gate exists to
// catch — and the one-byte form is the common way an accented letter ships outside UTF-8. So a
// NUL-carrying blob is skipped BY KIND and named in the summary (a skip nobody can see is a hole
// nobody can find), while text that is neither UTF-8 nor NUL-carrying REFUSES: its letters cannot be
// read, and a checker that cannot read them must say so instead of passing.
//
// Submodule gitlinks name a commit in another repository, not a blob here; only their name is judged.
//
// This is repo-only tooling and never ships in a tarball. The invariant is THIS project's, not the
// kit's: the kit is installed by people whose projects are written in their own languages, and a
// shipped checker enforcing English on them would be a bug, not a feature.
//
// COMMIT MESSAGES are judged too, over the history reachable from HEAD — the invariant covers the
// repository, and a message is part of it. The honest limit: this runs as a GATE, so it sees the
// commits that already exist. A message written today is caught on the next run, one commit late,
// when the remedy is an amend rather than a retype. Prevention would be a `commit-msg` hook; that is
// queued, not built, and this file does not pretend otherwise.
//
// Dependency-free, Node >= 22. Read-only: never writes, never commits. No side effects on import.

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enumerateIndex } from '../agent-workflow-kit/tools/source-size-scope.mjs';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';
const MAX_PER_FILE = 5;
const MAX_FILES_LISTED = 40;

export const EXIT = Object.freeze({ ok: 0, finding: 1, usage: 2 });

// Letter AND non-ASCII: the negated class excludes both every non-letter and the whole ASCII range,
// so what survives is exactly a letter outside ASCII. The global twin is the scanner; the plain one
// is the cheap "is there anything here at all" probe.
export const NON_ASCII_LETTER = /[^\P{L}\x00-\x7F]/u;
const NON_ASCII_LETTER_G = /[^\P{L}\x00-\x7F]/gu;

const codepoint = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

// A path whose bytes are not valid UTF-8 round-trips to something DIFFERENT — the replacement
// character is lossy, and that is the entire test.
const decodeStrict = (buf) => {
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
};

// findNonAsciiLetters(text) -> [{ line, column, char, codepoint, excerpt }]. Pure, so the predicate
// is testable without a repository.
export const findNonAsciiLetters = (text) => {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(NON_ASCII_LETTER_G)) {
      hits.push({
        line: index + 1,
        column: match.index + 1,
        char: match[0],
        codepoint: codepoint(match[0]),
        excerpt: line.trim().slice(0, 120),
      });
    }
  });
  return hits;
};

const refuse = (code, message) => Object.assign(new Error(message), { exitCode: code });

const NUL_BYTE = 0x00;
const LF = 0x0a;

// readBlobs(cwd, shas) -> Map<sha, Buffer>. ONE `git cat-file --batch` for the whole tree: 600-odd
// separate `cat-file` children would cost more than the check itself, and the batch protocol is
// exact — `<oid> <type> <size>\n`, then SIZE bytes, then one LF. The size is authoritative, so a
// blob containing the header's own shape is parsed correctly; nothing here searches for a delimiter.
export const readBlobs = (cwd, shas, deps = {}) => {
  const blobs = new Map();
  if (shas.length === 0) return blobs;
  const spawn = deps.spawn ?? spawnSync;
  const result = spawn('git', ['cat-file', '--batch'], {
    // The input is a BUFFER: with `encoding: 'buffer'` a string input is decoded with that same
    // (non-)encoding name and throws before git ever starts.
    cwd,
    input: Buffer.from(`${shas.join('\n')}\n`, 'utf8'),
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'buffer',
  });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `git exited ${result.status}`;
    throw refuse(EXIT.usage, `the index blobs could not be read (${why})`);
  }
  const out = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''), 'utf8');
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(LF, at);
    if (eol === -1) break;
    const header = out.subarray(at, eol).toString('utf8');
    const [oid, type] = header.split(' ');
    if (type === undefined || header.endsWith('missing')) {
      throw refuse(EXIT.finding, `the index names an object git cannot read (${header}) — nothing is judged over a broken index`);
    }
    const size = Number(header.slice(header.lastIndexOf(' ') + 1));
    blobs.set(oid, out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return blobs;
};

// judgeTree(cwd) -> { paths, judged, skippedBinary, findings }. Every exclusion is BY KIND and
// counted; the only thing that is silent is a path with nothing in it to report.
export const judgeTree = (cwd, deps = {}) => {
  let entries;
  try {
    entries = (deps.enumerate ?? enumerateIndex)(cwd, deps);
  } catch (error) {
    throw refuse(EXIT.usage, `the tracked tree could not be enumerated (${error.message})`);
  }
  const unmerged = entries.filter((entry) => entry.stage !== 0);
  if (unmerged.length > 0) {
    throw refuse(EXIT.finding, `the git index is UNMERGED (${unmerged.length} conflict-stage entr(ies)) — an ambiguous index is never judged green; resolve the conflict, then re-run`);
  }
  if (entries.length === 0) {
    throw refuse(EXIT.finding, `no tracked files found in ${cwd} — an empty tree is a broken invocation, never an empty green`);
  }
  const state = { judged: 0, skippedBinary: [], findings: [] };
  const report = (path, surface, text) => {
    const hits = findNonAsciiLetters(text);
    if (hits.length > 0) state.findings.push({ path, surface, hits });
  };
  const named = entries.map((entry) => {
    const rel = decodeStrict(entry.path);
    if (rel === null) {
      throw refuse(EXIT.finding, `a tracked path's NAME is not valid UTF-8 (bytes ${entry.path.toString('hex')}) — it cannot be addressed losslessly, so nothing is judged; rename it`);
    }
    // The NAME ships whatever kind the entry is, gitlinks and symlinks included.
    report(rel, 'name', rel);
    return { ...entry, rel };
  });
  const withBlobs = named.filter((entry) => entry.mode !== GITLINK_MODE);
  const blobs = readBlobs(cwd, [...new Set(withBlobs.map((entry) => entry.sha))], deps);
  for (const entry of withBlobs) {
    const buf = blobs.get(entry.sha);
    if (buf === undefined) {
      throw refuse(EXIT.finding, `${entry.rel}: the index names blob ${entry.sha} but git returned nothing for it — never a silent skip`);
    }
    // A symlink's blob IS its target string; the index states the kind, so nothing has to be guessed
    // from the filesystem and a dangling target reads exactly like any other.
    const surface = entry.mode === SYMLINK_MODE ? 'symlink target' : 'content';
    if (buf.includes(NUL_BYTE)) {
      state.skippedBinary.push(entry.rel);
      continue;
    }
    const text = decodeStrict(buf);
    if (text === null) {
      throw refuse(EXIT.finding, `${entry.rel}: carries no NUL byte but is not valid UTF-8 — that is TEXT in some other encoding, and a single-byte 0xE9 is exactly the letter this gate exists to catch; re-encode it as UTF-8`);
    }
    state.judged += 1;
    report(entry.rel, surface, text);
  }
  return { paths: entries.length, ...state };
};

// The message half. `%B` is the raw subject+body; the NUL delimiter keeps a message containing blank
// lines whole, which a line-based format cannot. `--encoding=UTF-8` asks git to hand over UTF-8
// rather than whatever `i18n.commitEncoding` declares, and the result is then decoded STRICTLY: a
// lossy decode turns an undecodable byte into U+FFFD, which is not a letter, so a message written in
// some other encoding would pass the predicate by being unreadable.
export const judgeMessages = (cwd, deps = {}) => {
  const spawn = deps.spawn ?? spawnSync;
  const result = spawn('git', ['log', '--encoding=UTF-8', '--format=%H%x00%B%x00', 'HEAD'], {
    cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'buffer',
  });
  if (result.error || result.status !== 0) {
    // A repository with no commits at all is not a failure: there is nothing to judge yet.
    const stderr = String(result.stderr ?? '');
    if (/does not have any commits yet|unknown revision/i.test(stderr)) return { commits: 0, findings: [] };
    const why = result.error ? result.error.message : `git exited ${result.status}`;
    throw refuse(EXIT.usage, `the commit messages could not be read (${why})`);
  }
  const raw = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''), 'utf8');
  const decoded = decodeStrict(raw);
  if (decoded === null) {
    throw refuse(EXIT.finding, 'a commit message in this history is not valid UTF-8 — its letters cannot be read, and an unreadable message is never a silent pass');
  }
  const parts = decoded.split('\0');
  const findings = [];
  let commits = 0;
  for (let at = 0; at + 1 < parts.length; at += 2) {
    const sha = parts[at].trim();
    if (sha === '') continue;
    commits += 1;
    const message = parts[at + 1];
    if (!NON_ASCII_LETTER.test(message)) continue;
    findings.push({ sha: sha.slice(0, 12), hits: findNonAsciiLetters(message) });
  }
  return { commits, findings };
};

const WHY = 'check-ascii-letters: WHY — this project is written in English, and the bar held only as long as somebody re-read every file. A fixture that needs the character keeps it as a \\uXXXX escape: same bytes at runtime, ASCII in the source.';

// Both listings are capped, and EVERY cap announces itself. A truncation nobody can see reads as
// "that was all of it", which is the one thing a report of findings must never imply.
const formatFindings = (findings, log, { label, line }) => {
  for (const finding of findings.slice(0, MAX_FILES_LISTED)) {
    for (const hit of finding.hits.slice(0, MAX_PER_FILE)) log(`  ${line(finding, hit)}`);
    if (finding.hits.length > MAX_PER_FILE) {
      log(`  ${finding.path ?? finding.sha}: +${finding.hits.length - MAX_PER_FILE} more not listed`);
    }
  }
  if (findings.length > MAX_FILES_LISTED) log(`  +${findings.length - MAX_FILES_LISTED} more ${label} not listed`);
};

const USAGE = `check-ascii-letters — the English-only invariant over the tracked tree and HEAD's commit messages.

Usage:
  node scripts/check-ascii-letters.mjs [--check] [--cwd <repo-root>] [--no-messages]

--check is accepted so the gate line reads like its neighbours; checking is all this tool does.
--no-messages judges the tracked files only.

Exit codes: 0 green; 1 a non-ASCII letter, or a refusal (unmerged index, unreadable tracked file,
empty tree); 2 usage, or an enumeration that failed.`;

export const parseArgs = (argv) => {
  const options = { cwd: process.cwd(), messages: true, help: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--check') continue;
    else if (arg === '--no-messages') options.messages = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--cwd') {
      at += 1;
      if (at >= argv.length) throw refuse(EXIT.usage, '--cwd needs a directory');
      options.cwd = argv[at];
    } else throw refuse(EXIT.usage, `unrecognised argument ${arg}`);
  }
  return options;
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log(`check-ascii-letters: ${error.message}`);
    log(USAGE);
    return error.exitCode ?? EXIT.usage;
  }
  if (options.help) {
    log(USAGE);
    return EXIT.ok;
  }
  let tree;
  let messages = { commits: 0, findings: [] };
  try {
    tree = judgeTree(options.cwd, deps);
    if (options.messages) messages = judgeMessages(options.cwd, deps);
  } catch (error) {
    log(`check-ascii-letters: REFUSED — ${error.message}`);
    return error.exitCode ?? EXIT.finding;
  }
  const total = tree.findings.reduce((sum, f) => sum + f.hits.length, 0)
    + messages.findings.reduce((sum, f) => sum + f.hits.length, 0);
  const skipped = `${tree.skippedBinary.length} binary skipped by kind`;
  if (total === 0) {
    log(`check-ascii-letters: PASS — ${tree.paths} tracked path(s) and ${messages.commits} commit message(s) carry no non-ASCII letter; names, index contents and symlink targets all judged, ${tree.judged} with a blob (${skipped}).`);
    if (tree.skippedBinary.length > 0) log(`  skipped by kind: ${tree.skippedBinary.slice(0, MAX_FILES_LISTED).join(', ')}`);
    return EXIT.ok;
  }
  log(`check-ascii-letters: FAIL — ${total} non-ASCII letter(s) in ${tree.findings.length} tracked path(s) and ${messages.findings.length} commit message(s):`);
  formatFindings(tree.findings, log, {
    label: 'path(s)',
    line: (finding, hit) => `${finding.path} (${finding.surface}):${hit.line}:${hit.column} — ${hit.codepoint} in: ${hit.excerpt}`,
  });
  formatFindings(messages.findings, log, {
    label: 'commit message(s)',
    line: (finding, hit) => `commit ${finding.sha} message line ${hit.line} — ${hit.codepoint} in: ${hit.excerpt}`,
  });
  log(WHY);
  return EXIT.finding;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = main();

export const TOOL_PATH = fileURLToPath(import.meta.url);
