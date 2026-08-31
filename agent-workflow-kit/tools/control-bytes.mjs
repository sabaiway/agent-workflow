#!/usr/bin/env node
// control-bytes.mjs — the read-only control-byte gate over the WORK TREE (the contract:
// docs/ai/specs/kit/control-bytes.md; the mode: references/modes/control-bytes.md). Measured
// 2026-08-30: an editor wrote a raw NUL into a test source, git classed the file as binary, the
// letter-level checker skipped the blob by kind, and the byte reached a reviewer one round later.
// This tool makes that byte a mechanical refusal: it judges BYTES, never letters, over tracked plus
// untracked-not-ignored paths — the name always, a regular file's content unless a git attribute
// says binary, a symlink's target string without following it — and refuses, never skips, on
// anything it cannot judge. main(argv, deps) returns { code, lines } and never exits; every spawn,
// fs and env read is injectable; the CLI half prints and sets the exit code. Read-only: it writes
// nothing and spawns only the git argv declared below (plus the location leaf's rev-parse probes).

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isDirectRun } from './direct-run.mjs';
import { probeRegularFileNoFollow, readFileBytesNoFollowCapped } from './fs-read-nofollow.mjs';
import { GIT_MAX_BUFFER, parseIndexEntries, resolveGitLocation, withGitPath } from './git-env.mjs';
import { isRefusedControlByte, renderPathForDisplay } from './repo-lex.mjs';

export const READ_CAP = 16 * 1024 * 1024;
// The exact read-only git argv this tool spawns — pinned by the kit read-only tier registry.
export const CONTROL_BYTES_GIT_ARGV = Object.freeze([
  Object.freeze(['ls-files', '-s', '-z']),
  Object.freeze(['ls-files', '--others', '--exclude-standard', '-z']),
  Object.freeze(['check-attr', '--stdin', '-z', 'binary', 'diff']),
  Object.freeze(['config', '--type=bool', '--get', 'core.symlinks']),
  Object.freeze(['ls-files', '-v', '-z']),
]);
const [TRACKED_ARGV, UNTRACKED_ARGV, ATTRIBUTES_ARGV, SYMLINKS_ARGV, SPARSE_ARGV] = CONTROL_BYTES_GIT_ARGV;
export const defaultIo = Object.freeze({ open: openSync, fstat: fstatSync, read: readSync, close: closeSync, constants: fsConstants, lstat: lstatSync, readlink: readlinkSync, realpath: realpathSync, stat: statSync });

const USAGE = `usage: node control-bytes.mjs [--check] [--cwd <dir>]
  Refuses any raw C0 or DEL byte (TAB, LF, CR admitted) in the work tree: a path's name, a regular
  file's content (unless its git attribute says binary or -diff) or a symlink's target string.
  --cwd <dir>   anchor at that directory's work-tree root (default: the process cwd)
  --check       the gate spelling; the plain run prints the same report and shares the exit table
  exit 0 clean · 1 a finding or a refusal · 2 usage`;

const NUL = Buffer.from([0]);
const render = renderPathForDisplay;
// Every DYNAMIC diagnostic (a location cause, git stderr, an fs error code, a user argument) rides
// the same renderer as paths before it reaches a line — SAFE (never a raw byte or U+FFFD), while
// injectivity is promised for NAMES only: a string-originated diagnostic folds invalid bytes first.
const safe = (text) => render(Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8'));
const refusalLine = (message) => `control-bytes: REFUSED — ${message}`;
const absent = (path, tracked) => `${render(path)}: absent (${tracked ? 'tracked but missing from the work tree — stage the deletion with git rm or git add -A, or it' : 'git named it, it'} vanished before the read)`;
const unreadable = (path, why) => `${render(path)}: unreadable (${safe(why)})`;
const hexByte = (byte) => `0x${byte.toString(16).padStart(2, '0')}`;
const errorCode = (err) => err?.code ?? err?.message ?? String(err);

const parseArgs = (argv, io) => {
  const opts = { check: false, cwd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      opts.check = true;
      continue;
    }
    if (arg === '--cwd') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--cwd needs a directory' };
      try {
        if (!io.stat(value).isDirectory()) return { error: `--cwd ${safe(value)} is not a directory` };
      } catch (err) {
        return { error: `--cwd ${safe(value)}: ${safe(errorCode(err))}` };
      }
      opts.cwd = value;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${safe(arg)}` };
  }
  return opts;
};

// One git query → { stdout } or { failure } — a synchronous throw, ENOENT, a signal and an exit
// outside `ok` are four named failures, never a silent empty answer.
const gitQuery = (run, args, { cwd, env, input }, ok = [0]) => {
  let r;
  try {
    r = run('git', args, { cwd, env: withGitPath(env), input, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  } catch (err) {
    return { failure: `git ${args.join(' ')} threw synchronously (${safe(err?.message ?? err)})` };
  }
  if (r.error) return { failure: `git ${args.join(' ')} could not run (${safe(errorCode(r.error))})${r.error.code === 'ENOENT' ? ' — git is not on PATH' : ''}` };
  if (r.signal) return { failure: `git ${args.join(' ')} was killed by ${safe(r.signal)}` };
  const stderr = String(r.stderr ?? '').trim();
  if (!ok.includes(r.status)) return { failure: `git ${args.join(' ')} exited ${r.status}${stderr ? ` (${safe(stderr)})` : ''}` };
  return { stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '') };
};

const splitZ = (buf) => {
  const out = [];
  for (let start = 0; start < buf.length;) {
    let end = buf.indexOf(0, start);
    if (end === -1) end = buf.length;
    if (end > start) out.push(buf.subarray(start, end));
    start = end + 1;
  }
  return out;
};

// `check-attr --stdin -z` answers path NUL attribute NUL value NUL; `binary` set or `diff` unset
// is git's own "binary" — the content skip, keyed by the path's exact bytes.
const attributeSkips = (stdout) => {
  const skips = new Set();
  const fields = splitZ(stdout);
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, attribute, value] = [fields[i], fields[i + 1].toString('utf8'), fields[i + 2].toString('utf8')];
    if ((attribute === 'binary' && value === 'set') || (attribute === 'diff' && value === 'unset')) skips.add(path.toString('hex'));
  }
  return skips;
};

const kindOfMode = (mode) => (mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : mode === '100644' || mode === '100755' ? 'file' : null);
// An UNTRACKED entry git names with a trailing slash is its nested-repository rule (the `nested/`
// line): name-only, like a gitlink, and counted as a skip by kind beside the never-committable stat
// classes. A directory at a slash-less entry is a leaf that changed kind — a refusal.
const kindOfStat = (st, nested) => (st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? (nested ? 'nested-repository' : 'directory') : 'never-committable');

export const main = (argv, deps = {}) => {
  const io = { ...defaultIo, ...(deps.io ?? {}) };
  const run = deps.spawn ?? spawnSync;
  const env = deps.env ?? process.env;
  const opts = parseArgs(argv, io);
  if (opts.error) return { code: 2, lines: [`control-bytes: usage — ${opts.error}`, USAGE] };
  const cwd = opts.cwd ?? deps.cwd ?? process.cwd();
  const location = resolveGitLocation(cwd, { spawn: run, env, realpath: io.realpath });
  if (location.state !== 'work-tree') return { code: 1, lines: [refusalLine(`the git location is ${location.state} — ${safe(location.cause)}`)] };
  const top = location.top;
  const git = (args, input, ok) => gitQuery(run, args, { cwd: top, env, input }, ok);
  const tracked = git(TRACKED_ARGV);
  if (tracked.failure) return { code: 1, lines: [refusalLine(tracked.failure)] };
  const entries = parseIndexEntries(tracked.stdout);
  const unmerged = entries.filter((e) => e.stage !== 0).length;
  if (unmerged > 0) return { code: 1, lines: [refusalLine(`the git index is UNMERGED (${unmerged} conflict-stage entr(ies)) — resolve the conflict, then re-run`)] };
  const others = git(UNTRACKED_ARGV);
  if (others.failure) return { code: 1, lines: [refusalLine(others.failure)] };
  const domain = [...entries.map((e) => ({ path: e.path, mode: e.mode })), ...splitZ(others.stdout).map((path) => ({ path, mode: null }))]
    .sort((a, b) => Buffer.compare(a.path, b.path));
  if (domain.length === 0) return { code: 1, lines: [refusalLine(`the domain is EMPTY — no tracked and no untracked-not-ignored path under ${render(Buffer.from(top))}`)] };
  const attributes = git(ATTRIBUTES_ARGV, Buffer.concat(domain.flatMap((d) => [d.path, NUL])));
  if (attributes.failure) return { code: 1, lines: [refusalLine(attributes.failure)] };
  const skipByAttribute = attributeSkips(attributes.stdout);
  // core.symlinks: exit 1 = unset = git's default (true); `false` = the host materialises a tracked
  // symlink as a regular file holding the target bytes — refusing it there would refuse forever.
  const symlinks = git(SYMLINKS_ARGV, undefined, [0, 1]);
  if (symlinks.failure) return { code: 1, lines: [refusalLine(symlinks.failure)] };
  const symlinksMaterialised = symlinks.stdout.toString('utf8').trim() === 'false';
  // Sparse checkouts: a tracked path whose skip-worktree bit is set (`ls-files -v`, a tag that
  // uppercases to S — core-evidence's rule) may be ABSENT by design: a counted skip, never a refusal.
  const sparse = git(SPARSE_ARGV);
  if (sparse.failure) return { code: 1, lines: [refusalLine(sparse.failure)] };
  const sparseSkip = new Set();
  for (const record of splitZ(sparse.stdout)) {
    if (record.length > 2 && String.fromCharCode(record[0]).toUpperCase() === 'S') sparseSkip.add(record.subarray(2).toString('hex'));
  }

  const findings = [];
  const refusals = [];
  const skippedByAttribute = [];
  let skippedByKind = 0;
  const judge = (bytes, surface, path) => {
    let first = -1;
    let count = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      if (!isRefusedControlByte(bytes[i])) continue;
      if (first === -1) first = i;
      count += 1;
    }
    if (first !== -1) findings.push(`${render(path)} ${surface} offset ${first}: ${hexByte(bytes[first])}${count > 1 ? ` (+${count - 1} more)` : ''}`);
  };
  // An ABSENT path: a sparse (skip-worktree) tracked one is a counted skip; every other refuses.
  const settleAbsent = (path, tracked) => {
    if (tracked && sparseSkip.has(path.toString('hex'))) skippedByKind += 1;
    else refusals.push(absent(path, tracked));
  };
  // A descriptor read's outcome, settled: ok judges the bytes on `surface`; anything else refuses.
  const settle = (read, path, tracked, surface, named) => {
    if (read.outcome === 'ok') {
      if (read.bytes) judge(read.bytes, surface, path);
      return true;
    }
    if (read.outcome === 'over-cap') refusals.push(`${render(path)}: over the read cap (${READ_CAP} bytes) — the gate read cap+1 bytes on the descriptor and stopped; ${surface === 'content' ? 'declare the path binary in .gitattributes or shrink it' : 'restore the link or shorten its target'}`);
    else if (read.outcome === 'absent') settleAbsent(path, tracked);
    else if (read.outcome === 'foreign') refusals.push(unreadable(path, `a ${read.className} where git named a ${named}`));
    else refusals.push(unreadable(path, read.code));
    return false;
  };
  for (const { path, mode } of domain) {
    judge(path, 'name', path);
    // Filesystem calls drop git's nested-repository trailing slash: lstat on a slash-terminated
    // name FOLLOWS a symlink standing there (POSIX), which would skip a swapped link unjudged.
    const fsPath = path[path.length - 1] === 0x2f ? path.subarray(0, path.length - 1) : path;
    const full = Buffer.concat([Buffer.from(`${top}/`), fsPath]);
    const tracked = mode !== null;
    let kind = null;
    if (tracked) {
      kind = kindOfMode(mode);
      if (kind === null) {
        refusals.push(unreadable(path, `index mode ${mode} names no readable kind`));
        continue;
      }
    } else {
      try {
        kind = kindOfStat(io.lstat(full), path[path.length - 1] === 0x2f);
      } catch (err) {
        if (err?.code === 'ENOENT') settleAbsent(path, tracked);
        else refusals.push(unreadable(path, errorCode(err)));
        continue;
      }
    }
    if (kind === 'gitlink') continue;
    if (kind === 'directory') {
      refusals.push(unreadable(path, 'a directory where git named a file'));
      continue;
    }
    if (kind === 'never-committable' || kind === 'nested-repository') {
      skippedByKind += 1;
      continue;
    }
    if (kind === 'symlink') {
      let leafIsFile = false;
      if (symlinksMaterialised) {
        try {
          leafIsFile = io.lstat(full).isFile();
        } catch (err) {
          if (err?.code === 'ENOENT') settleAbsent(path, tracked);
          else refusals.push(unreadable(path, errorCode(err)));
          continue;
        }
      }
      if (leafIsFile) {
        settle(readFileBytesNoFollowCapped(full, READ_CAP, io), path, tracked, 'symlink-target', 'symlink');
        continue;
      }
      try {
        judge(io.readlink(full, { encoding: 'buffer' }), 'symlink-target', path);
      } catch (err) {
        if (err?.code === 'ENOENT') settleAbsent(path, tracked);
        else refusals.push(unreadable(path, err?.code === 'EINVAL' ? 'not a symlink where git named one' : errorCode(err)));
      }
      continue;
    }
    // An attribute skip covers the CONTENT only: the leaf still owes the descriptor's kind check.
    const skipped = skipByAttribute.has(path.toString('hex'));
    const read = skipped ? probeRegularFileNoFollow(full, io) : readFileBytesNoFollowCapped(full, READ_CAP, io);
    if (settle(read, path, tracked, 'content', 'file') && skipped) skippedByAttribute.push(path);
  }
  const lines = [
    `control-bytes: work tree ${render(Buffer.from(top))}`,
    `paths judged: ${domain.length} · skipped by attribute: ${skippedByAttribute.length} · skipped by kind: ${skippedByKind} · findings: ${findings.length}`,
    ...skippedByAttribute.map((path) => `skipped by attribute: ${render(path)}`),
    ...findings,
    ...refusals.map(refusalLine),
  ];
  return { code: findings.length > 0 || refusals.length > 0 ? 1 : 0, lines };
};

if (isDirectRun(import.meta.url)) {
  const result = main(process.argv.slice(2));
  (result.code === 2 ? process.stderr : process.stdout).write(`${result.lines.join('\n')}\n`);
  process.exitCode = result.code;
}
