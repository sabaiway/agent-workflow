#!/usr/bin/env node
// worktrees.mjs — parallel feature worktrees over git: provision | list | land | cleanup (v1).
// Thin steps over git — every verification datum is recomputed live from git (branches, OIDs,
// observed status), never read from stored metadata; the handoff file is the one on-disk record
// (written at provision, read by list/cleanup). Ownership matrix, crash discipline, and the
// zero-prompt lanes live in references/modes/worktrees.md. Dependency-free, Node >= 22.
// No side effects on import (the isDirectRun idiom).

import {
  lstatSync, statSync, readFileSync, mkdirSync, rmdirSync, readdirSync, readlinkSync,
  symlinkSync, realpathSync, unlinkSync, openSync, fstatSync, readSync, writeSync, fchmodSync,
  closeSync, constants as fsC,
} from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  KIT_OWN_PATHS, KNOWN_FOOTPRINT, expandGlob, normalizeSlashes, isDirPattern, isGlobPattern,
  patternToProbe,
} from './known-footprint.mjs';
import { isScratchPlanName, plansInFlight, PLANS_REL, shellQuoteArg } from './review-state.mjs';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { assertContainedRealPath } from './fs-safe.mjs';
import { isFinalCapableDeclaration } from './run-gates.mjs';

export const WORKTREES_STOP = 'WORKTREES_STOP';
export const stop = (message, fields = {}) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'WorktreesStop', code: WORKTREES_STOP, ...fields });
const usageStop = (message) => stop(message, { exitCode: EXIT.usage });

export const EXIT = Object.freeze({ ok: 0, stop: 1, usage: 2 });
export const CONFIG_REL = 'docs/ai/worktrees.json';
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_BRANCH_PREFIX = 'aw/';
export const handoffBasename = (slug) => `handoff-${slug}.md`;

// Stores/sidecars a fresh worktree must NOT inherit (session state stays with its session).
const EXCLUDED_BASENAMES = new Set([
  '.codex-last-session',
  'agent-workflow-review-receipts.jsonl',
  'agent-workflow-core-evidence.jsonl',
]);
// Registry entries provision seeds by its own rules instead of copying wholesale.
const SEEDED_SEPARATELY = new Set([`/${PLANS_REL}/`]);
// Copied files whose absolute main-root pins are rebased onto the worktree root.
const REBASE_TARGETS = Object.freeze(['docs/ai/gates.json', '.claude/settings.json', '.claude/settings.local.json']);
const TRACKED_PIN_DECLARATION =
  'tracked declaration is not worktree-portable — this worktree\'s council/final checks route through the MAIN runner via --cwd';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const USAGE = [
  'usage: worktrees.mjs <subcommand> [args]',
  '',
  '  provision <slug> --plan <path> [--as <name>.md] [--dir <path>] [--branch <name>]',
  '            [--include <path>]... [--install] [--resume]',
  '            create + populate a feature worktree (sibling dir by default; the parent dir is',
  `            the ${CONFIG_REL} "parentDir" setting when present). --install only PRINTS the`,
  '            install command. --resume completes a half-done provision (identity-checked).',
  '  list      show every worktree of this repo: slug, path, branch, base OID, dirty, handoff.',
  '  land <slug> --prepare',
  '            stage the satellite diff onto a clean main (no commit — the commit stays a',
  "            dialogue ask). This subcommand arrives with this release's landing half.",
  '  cleanup <slug> [--branch <name>] [--abandon]',
  '            remove a LANDED worktree (fail-closed verification); --abandon is the one',
  "            destructive arm and destroys unlanded work. This subcommand arrives with this release's landing half.",
  '',
  'The slug is REQUIRED and positional on provision/land/cleanup: lowercase letters, digits,',
  'hyphens, max 64 chars, letter/digit first. Exit codes: 0 ok / 1 refusal / 2 usage.',
].join('\n');

// ── deps + git plumbing (every seam injectable for hermetic tests) ─────────────────────

const fsOf = (deps) => ({
  lstat: deps.lstat ?? lstatSync,
  mkdir: deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true })),
  mkdirPlain: deps.mkdirPlain ?? mkdirSync,
  rmdir: deps.rmdir ?? rmdirSync,
  readdir: deps.readdir ?? readdirSync,
  unlink: deps.unlink ?? unlinkSync,
  readlink: deps.readlink ?? readlinkSync,
  symlink: deps.symlink ?? symlinkSync,
  realpath: deps.realpath ?? realpathSync,
  open: deps.open ?? openSync,
  fstat: deps.fstat ?? fstatSync,
  read: deps.read ?? readSync,
  write: deps.write ?? writeSync,
  fchmod: deps.fchmod ?? fchmodSync,
  close: deps.close ?? closeSync,
  writeFile: deps.writeFile,
  rename: deps.rename,
  rm: deps.rm,
  rand: deps.rand ?? (() => randomBytes(6).toString('hex')),
});

export const spawnGit = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER });
  return {
    status: r.error ? -1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.error ? String(r.error.message) : (r.stderr ?? ''),
  };
};
const gitLine = (git, args, cwd) => {
  const r = git(args, cwd);
  return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
};

// check-ignore's honest trichotomy: 0 ignored · 1 not-ignored · anything else is a REAL git
// failure that must never read as "not ignored"
const checkIgnored = (git, probeRel, cwd) => {
  const r = git(['check-ignore', '--', probeRel], cwd);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw stop(`git check-ignore failed for ${probeRel}: ${(r.stderr || r.stdout).trim()}`);
};

const lstatNoFollow = (lstat, path) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

const classifyNodeNoFollow = (path, fs) => {
  const node = (() => {
    try {
      return { stat: fs.lstat(path) };
    } catch (error) {
      return error?.code === 'ENOENT'
        ? { stat: null }
        : { error: error?.code ?? 'fs error' };
    }
  })();
  if (node.error) return { kind: 'error', error: node.error };
  if (node.stat === null) return { kind: 'absent' };
  if (!node.stat.isSymbolicLink()) {
    if (node.stat.isDirectory()) return { kind: 'plain-directory', stat: node.stat };
    if (node.stat.isFile()) return { kind: 'regular-file', stat: node.stat };
    return { kind: 'special', stat: node.stat };
  }
  const realPath = (() => {
    try {
      return { path: fs.realpath(path) };
    } catch (error) {
      return { error: error?.code ?? 'fs error' };
    }
  })();
  if (realPath.error) return { kind: 'symlink-unresolvable', error: realPath.error };
  const target = (() => {
    try {
      return { stat: fs.lstat(realPath.path) };
    } catch (error) {
      return { error: error?.code ?? 'fs error' };
    }
  })();
  if (target.error) return { kind: 'symlink-unresolvable', error: target.error };
  if (target.stat.isDirectory()) return { kind: 'symlink-to-directory', realPath: realPath.path, stat: node.stat };
  if (target.stat.isFile()) return { kind: 'symlink-to-file', realPath: realPath.path, stat: node.stat };
  return { kind: 'symlink-to-special', realPath: realPath.path, stat: node.stat };
};

// The ONE content-read door: no-follow lstat, then an O_NOFOLLOW|O_NONBLOCK descriptor with an
// fstat recheck — a node swapped after the lstat can neither follow a link nor block on a FIFO.
// Outcomes: { bytes } | { absent } | { unsafe } | { error: code }; callers map them, never read raw.
const NOFOLLOW_READ = fsC.O_RDONLY | (fsC.O_NOFOLLOW ?? 0) | (fsC.O_NONBLOCK ?? 0);
const readFileNoFollow = (fs, abs) => {
  let st;
  try {
    st = fs.lstat(abs);
  } catch (err) {
    return err?.code === 'ENOENT' ? { absent: true } : { error: err?.code ?? 'fs error' };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { unsafe: true };
  let fd = null;
  try {
    fd = openSync(abs, NOFOLLOW_READ);
    const fdStat = fstatSync(fd);
    // Comparing the injected lstat with the real descriptor fstat is deliberate.
    if (!fdStat.isFile() || st.dev !== fdStat.dev || st.ino !== fdStat.ino) return { unsafe: true };
    return { bytes: readFileSync(fd) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { absent: true };
    return err?.code === 'ELOOP' ? { unsafe: true } : { error: err?.code ?? 'fs error' };
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

const NOFOLLOW_WRITE = fsC.O_WRONLY | fsC.O_CREAT | fsC.O_EXCL | (fsC.O_NOFOLLOW ?? 0);
const COPY_BUFFER_BYTES = 64 * 1024;
const copyFileNoFollow = ({ srcAbs, dstAbs, sourceStat, rel, fs }) => {
  const handles = { source: null, destination: null };
  const closeErrors = [];
  const outcome = { error: null };
  try {
    try {
      handles.source = fs.open(srcAbs, NOFOLLOW_READ);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
        throw stop(`copy source changed between lstat and open: ${rel}`);
      }
      throw error;
    }
    const descriptorStat = fs.fstat(handles.source);
    if (!descriptorStat.isFile() || descriptorStat.dev !== sourceStat.dev || descriptorStat.ino !== sourceStat.ino) {
      throw stop(`copy source changed between lstat and open: ${rel}`);
    }
    try {
      // O_EXCL closes the create race; O_NOFOLLOW is defense-in-depth for nonstandard link handling.
      handles.destination = fs.open(dstAbs, NOFOLLOW_WRITE, sourceStat.mode & 0o666);
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ELOOP') {
        throw stop(`copy destination changed between lstat and open: ${rel}`);
      }
      throw error;
    }
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytesRead = fs.read(handles.source, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = fs.write(handles.destination, buffer, written, bytesRead - written, null);
        if (bytesWritten <= 0) throw Object.assign(new Error('zero-byte descriptor write'), { code: 'EIO' });
        written += bytesWritten;
      }
      bytesRead = fs.read(handles.source, buffer, 0, buffer.length, null);
    }
    if ((sourceStat.mode & 0o111) !== 0) fs.fchmod(handles.destination, sourceStat.mode & 0o777);
  } catch (error) {
    outcome.error = error;
  }
  for (const key of ['destination', 'source']) {
    if (handles[key] === null) continue;
    try {
      fs.close(handles[key]);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const withDestinationState = (error) => Object.assign(error, {
    copyDoorDestinationCreated: handles.destination !== null,
  });
  if (outcome.error) throw withDestinationState(outcome.error);
  if (closeErrors.length > 0) throw withDestinationState(closeErrors[0]);
};

const isInside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// ── slug / config / target resolution ──────────────────────────────────────────────────

export const validateSlug = (slug) => {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw usageStop(
      `invalid slug ${JSON.stringify(slug ?? '')} — lowercase letters, digits, hyphens, max 64 chars, letter/digit first`,
    );
  }
  return slug;
};

export const parseStrictJson = (text) => {
  const source = String(text);
  const cursor = { index: 0 };
  const skipWhitespace = () => {
    while (/\s/.test(source[cursor.index] ?? '')) cursor.index += 1;
  };
  const readString = () => {
    const start = cursor.index;
    cursor.index += 1;
    while (cursor.index < source.length) {
      if (source[cursor.index] === '\\') {
        cursor.index += 2;
      } else if (source[cursor.index] === '"') {
        cursor.index += 1;
        return JSON.parse(source.slice(start, cursor.index));
      } else {
        cursor.index += 1;
      }
    }
    return null;
  };
  const childPath = (path, key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
  const scanValue = (path) => {
    skipWhitespace();
    if (source[cursor.index] === '{') {
      cursor.index += 1;
      skipWhitespace();
      const seen = new Set();
      if (source[cursor.index] === '}') {
        cursor.index += 1;
        return;
      }
      while (cursor.index < source.length) {
        const key = readString();
        if (seen.has(key)) throw new SyntaxError(`duplicate JSON key ${JSON.stringify(key)} at ${path}`);
        seen.add(key);
        skipWhitespace();
        cursor.index += 1;
        scanValue(childPath(path, key));
        skipWhitespace();
        if (source[cursor.index] === '}') {
          cursor.index += 1;
          return;
        }
        cursor.index += 1;
        skipWhitespace();
      }
      return;
    }
    if (source[cursor.index] === '[') {
      cursor.index += 1;
      skipWhitespace();
      if (source[cursor.index] === ']') {
        cursor.index += 1;
        return;
      }
      let item = 0;
      while (cursor.index < source.length) {
        scanValue(`${path}[${item}]`);
        item += 1;
        skipWhitespace();
        if (source[cursor.index] === ']') {
          cursor.index += 1;
          return;
        }
        cursor.index += 1;
      }
      return;
    }
    if (source[cursor.index] === '"') {
      readString();
      return;
    }
    while (cursor.index < source.length && !/[\s,}\]]/.test(source[cursor.index])) cursor.index += 1;
  };
  // the duplicate scan tolerates malformed tails (EOF-safe returns); JSON.parse then rejects them
  scanValue('$');
  return JSON.parse(source);
};

export const loadWorktreesConfig = (root, deps = {}) => {
  const fs = fsOf(deps);
  // the ancestor chain is verified even when the leaf is absent — a symlinked docs/ or docs/ai
  // must never read as plain absence
  let dir = root;
  for (const seg of ['docs', 'ai']) {
    dir = join(dir, seg);
    let st;
    try {
      st = fs.lstat(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') return { parentDir: null, source: 'default' };
      throw stop(`${CONFIG_REL}: cannot stat ${relative(root, dir)} (${err?.code ?? 'fs error'}) — refusing to trust plain absence`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw stop(`${CONFIG_REL}: ${relative(root, dir)} is not a plain directory — refusing to trust plain absence`);
    }
  }
  const leaf = readFileNoFollow(fs, join(root, CONFIG_REL));
  if (leaf.absent) return { parentDir: null, source: 'default' };
  if (leaf.unsafe) throw stop(`${CONFIG_REL} is not a regular file — refusing to read it`);
  if (leaf.error) throw stop(`${CONFIG_REL}: unreadable (${leaf.error})`);
  let parsed;
  try {
    parsed = parseStrictJson(String(leaf.bytes));
  } catch (err) {
    throw stop(`${CONFIG_REL}: malformed JSON (${err.message}) — fix it by hand; the tool never guesses`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw stop(`${CONFIG_REL}: must be a JSON object { "parentDir": "<dir>" }`);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== '_README' && key !== 'parentDir') {
      throw stop(`${CONFIG_REL}: unknown key "${key}" (allowed: _README, parentDir)`);
    }
  }
  if (parsed.parentDir !== undefined && (typeof parsed.parentDir !== 'string' || parsed.parentDir.trim() === '')) {
    throw stop(`${CONFIG_REL}: "parentDir" must be a non-empty string`);
  }
  return { parentDir: parsed.parentDir ?? null, source: parsed.parentDir === undefined ? 'default' : 'setting' };
};

export const resolveTargetDir = ({ root, slug, dirFlag, parentDir }) => {
  if (dirFlag) return resolve(root, dirFlag);
  const parent = parentDir == null ? dirname(root) : resolve(root, parentDir);
  return join(parent, `${basename(root)}--${slug}`);
};

// Realpath through the NEAREST EXISTING ancestor (the target itself may not exist yet), so a
// symlinked parent can never smuggle the worktree outside the intended placement.
export const realpathThroughExistingParent = (target, deps = {}) => {
  const { lstat, realpath } = fsOf(deps);
  const tail = [];
  const walkUp = (p) => {
    if (lstatNoFollow(lstat, p) !== null) return p;
    const parent = dirname(p);
    if (parent === p) return p;
    tail.unshift(basename(p));
    return walkUp(parent);
  };
  const existing = walkUp(resolve(target));
  return join(realpath(existing), ...tail);
};

// ── roots + worktree registry ──────────────────────────────────────────────────────────

export const parseWorktreeList = (text) => {
  const entries = [];
  let fields = [];
  const finishEntry = () => {
    if (fields.length === 0) return;
    const entry = { path: null, head: null, branch: null, detached: false, prunable: false, bare: false };
    for (const field of fields) {
      if (field.startsWith('worktree ')) entry.path = field.slice('worktree '.length);
      else if (field.startsWith('HEAD ')) entry.head = field.slice('HEAD '.length);
      else if (field.startsWith('branch ')) entry.branch = field.slice('branch '.length);
      else if (field === 'detached') entry.detached = true;
      else if (field === 'bare') entry.bare = true;
      else if (field === 'prunable' || field.startsWith('prunable ')) entry.prunable = true;
    }
    if (entry.path !== null) entries.push(entry);
    fields = [];
  };
  for (const field of String(text).split('\0')) {
    if (field === '') finishEntry();
    else fields.push(field);
  }
  finishEntry();
  return entries;
};

const listWorktrees = (git, cwd) => {
  const r = git(['worktree', 'list', '--porcelain', '-z'], cwd);
  if (r.status !== 0) throw stop(`git worktree list failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return parseWorktreeList(r.stdout);
};

// The MAIN worktree is the first `git worktree list --porcelain -z` entry; provision/land/cleanup
// refuse to run from inside a linked worktree.
export const resolveRoots = (cwd, git, { refuseLinked = true } = {}) => {
  const root = gitLine(git, ['rev-parse', '--show-toplevel'], cwd);
  if (root == null) throw stop('not inside a git work tree');
  const gitDir = gitLine(git, ['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
  const commonDir = gitLine(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (gitDir == null || commonDir == null) throw stop('cannot resolve the git dir');
  if (refuseLinked && gitDir !== commonDir) {
    const main = listWorktrees(git, cwd)[0]?.path ?? '(unknown)';
    throw stop(`run this from the MAIN worktree (${main}) — the cwd is inside a linked worktree`);
  }
  return { root, gitDir, commonDir };
};

// ── the writability preflight (the ONE sibling-mutation gate + degrade) ────────────────

// git worktree add creates missing leading dirs itself — the probe targets the nearest
// EXISTING ancestor (probing a not-yet-existing parent would read as a false denial).
export const nearestExistingDir = (path, deps = {}) => {
  const { lstat } = fsOf(deps);
  const walk = (p) => {
    if (lstatNoFollow(lstat, p) !== null) return p;
    const parent = dirname(p);
    return parent === p ? p : walk(parent);
  };
  return walk(resolve(path));
};

// The ONE canonical probe-dir derivation provision AND the recommendations advisor share:
// resolve through the existing-parent realpath, then walk to the nearest existing dir.
export const resolveProbeDir = (path, deps = {}) =>
  nearestExistingDir(realpathThroughExistingParent(path, deps), deps);

export const probeParentWritable = (parentDir, deps = {}) => {
  const { mkdirPlain, rmdir, rand } = fsOf(deps);
  const probe = join(parentDir, `.aw-write-probe-${rand()}`);
  try {
    mkdirPlain(probe);
  } catch (err) {
    return { writable: false, code: err?.code ?? 'error' };
  }
  try {
    rmdir(probe);
  } catch (err) {
    // create-OK/delete-FAIL is its own refusal — never "writable", never silent debris
    return { writable: false, cleanupFailed: { path: probe, code: err?.code ?? 'error' } };
  }
  return { writable: true };
};

const provisionFlagsTail = (flags, q) => {
  const parts = ['--plan', q(flags.plan)];
  if (flags.as) parts.push('--as', q(flags.as));
  if (flags.branch) parts.push('--branch', q(flags.branch));
  if (flags.dir) parts.push('--dir', q(flags.dir));
  for (const inc of flags.include ?? []) parts.push('--include', q(inc));
  if (flags.install) parts.push('--install');
  if (flags.resume) parts.push('--resume');
  return parts;
};

// The maintainer-paste fallback must be the COMPLETE original invocation, quoted; the tool
// path is ALWAYS quoted — the one token whose spaces depend on the install location.
export const composeProvisionArgv = ({ root, slug, flags }) => {
  const q = shellQuoteArg;
  const toolAbs = fileURLToPath(import.meta.url);
  return ['cd', q(root), '&&', 'node', `'${toolAbs.replace(/'/g, `'\\''`)}'`, 'provision', q(slug), ...provisionFlagsTail(flags, q)].join(' ');
};

const writabilityStop = ({ parentDir, root, slug, flags }) => {
  const q = shellQuoteArg;
  return stop(
    [
      `the worktrees parent dir is not writable from this session: ${parentDir}`,
      'Arm the ONE-TIME consent (then every provision/cleanup runs promptless):',
      `  .claude/settings.json → sandbox.filesystem.allowWrite += ${JSON.stringify(parentDir)}`,
      'Or run the full command yourself in a plain terminal:',
      `  ${composeProvisionArgv({ root, slug, flags })}`,
      `(from the target repo root, when that checkout carries the kit at agent-workflow-kit/: node agent-workflow-kit/tools/worktrees.mjs provision ${q(slug)} ${provisionFlagsTail(flags, q).join(' ')})`,
    ].join('\n'),
  );
};

// ── provision: copy set + copy semantics ───────────────────────────────────────────────

const isPresent = (root, pattern, fs) => {
  const rel = patternToProbe(pattern).replace(/\/$/, '');
  const st = lstatNoFollow(fs.lstat, join(root, rel));
  if (st === null) return false;
  return isDirPattern(pattern) ? st.isDirectory() : true;
};

export const provisionCopySet = (root, deps = {}) => {
  const fs = fsOf(deps);
  const out = [];
  for (const pattern of KIT_OWN_PATHS) {
    if (SEEDED_SEPARATELY.has(pattern)) continue;
    if (isPresent(root, pattern, fs)) out.push(pattern);
  }
  for (const entry of KNOWN_FOOTPRINT) {
    if (isGlobPattern(entry.pattern)) {
      out.push(...expandGlob(entry.pattern, { dir: root, readdir: fs.readdir, stat: deps.stat ?? statSync }));
    } else if (isPresent(root, entry.pattern, fs)) {
      out.push(entry.pattern);
    }
  }
  return out;
};

// fs-safe's traversal guard, surfaced as this tool's typed STOP — runs before EVERY destination
// mutation, so a symlinked parent can never leak a write.
const guardDst = (fs, wtRoot, dstAbs) => {
  try {
    assertContainedRealPath(wtRoot, dstAbs, { lstat: fs.lstat });
  } catch (err) {
    throw stop(String(err?.message ?? err).replace(/^\[agent-workflow-kit\] /, ''));
  }
};

const failAfterCopy = ({ cause, dstAbs, wtRoot, fs }) => {
  const primary = cause.message.replace(/^\[agent-workflow-kit\] /, '');
  const throwCleanupFailure = (error) => {
    const cleanupCode = error?.code ?? 'fs error';
    const cleanupDetail = cleanupCode === WORKTREES_STOP
      ? `: ${error.message.replace(/^\[agent-workflow-kit\] /, '')}`
      : '';
    throw stop(`${primary}; cleanup failed (${cleanupCode}${cleanupDetail}) — untrusted destination remains; remove it by hand: ${dstAbs}`);
  };
  const destination = (() => {
    try {
      return { stat: lstatNoFollow(fs.lstat, dstAbs) };
    } catch (error) {
      return { error };
    }
  })();
  if (destination.error) throwCleanupFailure(destination.error);
  if (destination.stat === null) throw cause;
  try {
    guardDst(fs, wtRoot, dstAbs);
  } catch (error) {
    throwCleanupFailure(error);
  }
  try {
    fs.unlink(dstAbs);
  } catch (error) {
    throwCleanupFailure(error);
  }
  throw stop(`${primary} — partial destination removed; re-run provision`);
};

const copyNode = ({ srcAbs, dstAbs, wtRoot, rel, fs, report, copied }) => {
  if (EXCLUDED_BASENAMES.has(basename(srcAbs))) {
    report.push(`  skip (session sidecar): ${rel}`);
    return;
  }
  let st;
  try {
    st = fs.lstat(srcAbs);
  } catch (err) {
    throw stop(`copy failed (${err?.code ?? 'fs error'}) reading ${rel}`);
  }
  try {
    if (st.isSymbolicLink()) {
      if (lstatNoFollow(fs.lstat, dstAbs) !== null) {
        report.push(`  kept (already present): ${rel}`);
        return;
      }
      const target = fs.readlink(srcAbs);
      if (isAbsolute(target)) throw stop(`refusing to copy an absolute symlink: ${rel} -> ${target}`);
      const resolved = resolve(dirname(dstAbs), target);
      if (!isInside(wtRoot, resolved)) {
        throw stop(`refusing to copy a symlink escaping the worktree: ${rel} -> ${target}`);
      }
      // the lexical check alone can be re-routed through an existing symlinked component —
      // canonicalize through the nearest existing ancestor and re-check
      const canonicalTarget = (() => {
        try {
          return realpathThroughExistingParent(resolved, fs);
        } catch {
          throw stop(`refusing to copy a symlink with an unresolvable target: ${rel} -> ${target}`);
        }
      })();
      const wtReal = (() => {
        try {
          return fs.realpath(wtRoot);
        } catch {
          return wtRoot;
        }
      })();
      if (!isInside(wtReal, canonicalTarget)) {
        throw stop(`refusing to copy a symlink escaping the worktree (canonical): ${rel} -> ${target}`);
      }
      guardDst(fs, wtRoot, dirname(dstAbs));
      fs.mkdir(dirname(dstAbs));
      guardDst(fs, wtRoot, dstAbs);
      fs.symlink(target, dstAbs);
      copied.add(rel);
      report.push(`  linked: ${rel} -> ${target}`);
    } else if (st.isDirectory()) {
      if (lstatNoFollow(fs.lstat, dstAbs) === null) {
        guardDst(fs, wtRoot, dstAbs);
        fs.mkdir(dstAbs);
      }
      for (const entry of fs.readdir(srcAbs)) {
        copyNode({ srcAbs: join(srcAbs, entry), dstAbs: join(dstAbs, entry), wtRoot, rel: `${rel}/${entry}`, fs, report, copied });
      }
    } else if (st.isFile()) {
      if (lstatNoFollow(fs.lstat, dstAbs) !== null) {
        report.push(`  kept (already present): ${rel}`);
        return;
      }
      guardDst(fs, wtRoot, dirname(dstAbs));
      fs.mkdir(dirname(dstAbs));
      guardDst(fs, wtRoot, dstAbs);
      try {
        copyFileNoFollow({ srcAbs, dstAbs, sourceStat: st, rel, fs });
      } catch (err) {
        const cause = err?.code === WORKTREES_STOP ? err : stop(`copy failed (${err?.code ?? 'fs error'}) at ${rel}`);
        if (err?.copyDoorDestinationCreated !== true) throw cause;
        failAfterCopy({ cause, dstAbs, wtRoot, fs });
      }
      copied.add(rel);
      report.push(`  copied: ${rel}`);
    } else {
      throw stop(`refusing to copy a special file (device/FIFO/socket): ${rel}`);
    }
  } catch (err) {
    if (err?.code === WORKTREES_STOP) throw err;
    throw stop(`copy failed (${err?.code ?? 'fs error'}) at ${rel}`);
  }
};

export const copyTreeIfMissing = ({ srcAbs, dstAbs, wtRoot, rel, deps = {} }) => {
  const report = [];
  const copied = new Set();
  copyNode({ srcAbs, dstAbs, wtRoot, rel, fs: fsOf(deps), report, copied });
  return { report, copied: [...copied] };
};

// ── absolute-pin rebase (pure; slash-normalized both ways) ─────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const rebaseAbsolutePins = (text, mainRoot, wtRoot) => {
  const mainFwd = normalizeSlashes(mainRoot);
  const wtFwd = normalizeSlashes(wtRoot);
  const mainBack = mainFwd.replace(/\//g, '\\');
  const wtBack = wtFwd.replace(/\//g, '\\');
  // three encodings of the same pin: forward, raw backslash, and JSON-escaped doubled
  // backslash (serialized settings/gates content) — the doubled pass runs FIRST
  const mainBack2 = mainBack.replace(/\\/g, '\\\\');
  const wtBack2 = wtBack.replace(/\\/g, '\\\\');
  const boundary = '(?=[/\\\\"\'\\s]|$)';
  const fwdRe = () => new RegExp(escapeRe(mainFwd) + boundary, 'g');
  const backRe = () => new RegExp(escapeRe(mainBack) + boundary, 'g');
  const back2Re = () => new RegExp(escapeRe(mainBack2) + boundary, 'g');
  // function replacements — a worktree path carrying $&/$$/$' must land byte-literal
  const rebased = text.replace(back2Re(), () => wtBack2).replace(fwdRe(), () => wtFwd).replace(backRe(), () => wtBack);
  const changes = [];
  if (rebased !== text) {
    const before = text.split('\n');
    const after = rebased.split('\n');
    before.forEach((line, i) => {
      if (line !== after[i]) {
        const count = (line.match(back2Re()) ?? []).length
          + (line.match(fwdRe()) ?? []).length
          + (line.match(backRe()) ?? []).length;
        changes.push({ line: i + 1, count, before: line, after: after[i] });
      }
    });
  }
  return { text: rebased, changes };
};

// ── pre-add source sweeps (containment + target-collision; nothing mutates before them) ─

// Every lstat-PRESENT registry entry (dir-pattern symlinks included — the copy set excludes
// them, but a symlinked root must still never smuggle outside content) realpath-resolves
// INSIDE the main repo. Returns the present entries with their realpaths for the collision check.
const assertProvisionSourcesContained = ({ root, rootReal, fs, statFollow }) => {
  const rels = [];
  for (const pattern of [...KIT_OWN_PATHS, ...KNOWN_FOOTPRINT.map((e) => e.pattern)]) {
    if (SEEDED_SEPARATELY.has(pattern)) continue;
    if (isGlobPattern(pattern)) {
      rels.push(...expandGlob(pattern, { dir: root, readdir: fs.readdir, stat: statFollow }).map((p) => patternToProbe(p)));
      continue;
    }
    const rel = patternToProbe(pattern).replace(/\/$/, '');
    if (lstatNoFollow(fs.lstat, join(root, rel)) !== null) rels.push(rel);
  }
  const sources = [];
  for (const rel of rels) {
    const abs = join(root, rel);
    let real;
    try {
      real = fs.realpath(abs);
    } catch (err) {
      // realpath validation stays authoritative for resolvable paths; the ONE lexical
      // acceptance is an inside-root ENOENT-dangling symlink (the copy mirrors it as a link)
      const st = lstatNoFollow(fs.lstat, abs);
      if (st !== null && st.isSymbolicLink() && err?.code === 'ENOENT') {
        const target = fs.readlink(abs);
        const lexical = isAbsolute(target) ? resolve(target) : resolve(dirname(abs), target);
        if (isAbsolute(target) || !isInside(rootReal, lexical)) {
          throw stop(`provision source escapes the main repo via a symlink (dangling): ${rel} -> ${target} — fix or remove it before provisioning`);
        }
        const canonical = (() => {
          try {
            return realpathThroughExistingParent(lexical, fs);
          } catch {
            throw stop(`provision source unresolvable (dangling chain): ${rel} -> ${target} — fix or remove it before provisioning`);
          }
        })();
        if (!isInside(rootReal, canonical)) {
          throw stop(`provision source escapes the main repo via a symlink (dangling): ${rel} -> ${target} — fix or remove it before provisioning`);
        }
        sources.push({ rel, real: canonical });
        continue;
      }
      throw stop(`provision source unresolvable (${err?.code ?? 'fs error'}): ${rel} — fix or remove it before provisioning`);
    }
    if (!isInside(rootReal, real)) {
      throw stop(`provision source escapes the main repo via a symlink: ${rel} -> ${real} — fix or remove it before provisioning`);
    }
    sources.push({ rel, real });
  }
  return sources;
};

// A target inside a provision-source subtree would copy ITSELF recursively at copy time.
const assertTargetOutsideSources = ({ targetReal, sources }) => {
  for (const s of sources) {
    if (targetReal === s.real || isInside(s.real, targetReal)) {
      throw stop(`the target dir is inside a provision source (${s.rel}) — pick a dir outside every provision source`);
    }
  }
};

// ── the shared plans-chain scanner (resume identity + list ride the SAME no-follow walk) ─

// Whole-chain no-follow: the worktree root, docs, and docs/plans must be plain directories;
// handoff candidates count ONLY as regular files. states: ok | absent | unreadable.
// ANY stat failure (not just readdir) renders honestly — list must never crash on a bad node.
const scanPlansDir = ({ wtRoot, fs }) => {
  if (classifyNodeNoFollow(wtRoot, fs).kind !== 'plain-directory') return { state: 'unreadable' };
  const docs = classifyNodeNoFollow(join(wtRoot, 'docs'), fs);
  if (docs.kind === 'absent') return { state: 'absent' };
  if (docs.kind !== 'plain-directory') return { state: 'unreadable' };
  const plans = classifyNodeNoFollow(join(wtRoot, PLANS_REL), fs);
  if (plans.kind === 'absent') return { state: 'absent' };
  if (plans.kind !== 'plain-directory') return { state: 'unreadable' };
  let names;
  try {
    names = fs.readdir(join(wtRoot, PLANS_REL));
  } catch {
    return { state: 'unreadable' };
  }
  const handoffs = [];
  const nonRegular = [];
  for (const n of names) {
    if (!/^handoff-.+\.md$/.test(n)) continue;
    const cand = classifyNodeNoFollow(join(wtRoot, PLANS_REL, n), fs);
    if (cand.kind !== 'regular-file') nonRegular.push(n);
    else handoffs.push(n);
  }
  return { state: 'ok', handoffs, nonRegular };
};

// Resume writes NOTHING before this: the existing handoff must be the live identity.
const assertResumeHandoffIdentity = ({ wtRoot, slug, branch, fs }) => {
  const scan = scanPlansDir({ wtRoot, fs });
  if (scan.state === 'unreadable') {
    throw stop('--resume: the worktree docs/plans chain is not a plain directory tree (a symlink or special node is in the way) — fix it before resuming');
  }
  if (scan.state === 'absent') return;
  if (scan.nonRegular.length > 0) {
    throw stop(`--resume: handoff-named entr${scan.nonRegular.length === 1 ? 'y is' : 'ies are'} not regular file(s): ${scan.nonRegular.join(', ')} — fix before resuming`);
  }
  if (scan.handoffs.length === 0) return;
  if (scan.handoffs.length > 1) {
    throw stop(`--resume: multiple handoff files found (${scan.handoffs.join(', ')}) — exactly one may exist`);
  }
  const name = scan.handoffs[0];
  if (name !== handoffBasename(slug)) {
    throw stop(`--resume identity mismatch: the existing handoff is ${name}, the live slug is ${slug} (${handoffBasename(slug)})`);
  }
  const rf = readFileNoFollow(fs, join(wtRoot, PLANS_REL, name));
  if (!rf.bytes) throw stop(`--resume: the handoff ${name} is not readable as a regular file — fix it before resuming`);
  const record = parseProvisionRecord(String(rf.bytes));
  if (record.slug !== slug) {
    throw stop(`--resume identity mismatch: the handoff record slug is ${record.slug ?? '(missing)'}, the live slug is ${slug}`);
  }
  if (record.branch !== branch) {
    throw stop(`--resume identity mismatch: the handoff record branch is ${record.branch ?? '(missing)'}, the live branch is ${branch}`);
  }
};

const assertResumePlanCompatibility = ({ wtRoot, seedName, fs }) => {
  const inFlight = plansInFlight(wtRoot, fs.readdir);
  if (inFlight.length === 0 || (inFlight.length === 1 && inFlight[0] === seedName)) return;
  if (inFlight.length === 1) {
    throw stop(
      `--resume plan mismatch: found [${inFlight[0]}], expected [${seedName}] or no in-flight plan — ` +
        `re-run with --as ${inFlight[0]}, or remove the existing plan by hand`,
    );
  }
  throw stop(
    `the worktree must hold EXACTLY ONE in-flight plan, found [${inFlight.join(', ')}] — remove the extras (or re-seed) and re-run --resume`,
  );
};

// ── the handoff artifact (the tool's own record inside it; list/cleanup read it) ───────

const composeProvisionRecordSection = ({ slug, branch, includes, nodeModules, vscode }) => [
  '## Provision record',
  '',
  `- slug: ${slug}`,
  `- branch: ${branch}`,
  ...(includes.length === 0 ? ['- include: (none)'] : includes.map((p) => `- include: ${p}`)),
  `- node_modules: ${nodeModules}`,
  `- vscode-settings: ${vscode}`,
  '',
].join('\n');

export const composeHandoffStub = (fields) => [
  `# Handoff — ${fields.slug}`,
  '',
  'provisioned, nothing done yet',
  '',
  composeProvisionRecordSection(fields),
].join('\n');

const ATX_SECTION_HEADING = /^ {0,3}#{1,2} /;

const locateProvisionRecordSection = (text) => {
  const source = String(text);
  const lines = [...source.matchAll(/.*(?:\r?\n|$)/g)].filter((match) => match[0] !== '');
  const headings = lines.filter((match) => match[0].replace(/\r?\n$/, '').trim() === '## Provision record');
  if (headings.length === 0) throw stop('handoff record: missing required "## Provision record" section');
  if (headings.length > 1) throw stop('handoff record: multiple "## Provision record" sections — the record is ambiguous');
  const start = headings[0].index;
  const nextHeading = lines.find((match) => match.index > start && ATX_SECTION_HEADING.test(match[0].replace(/\r?\n$/, '')));
  return { source, start, end: nextHeading?.index ?? source.length };
};

// ONLY the required section is parsed, so decoy fields elsewhere cannot hijack identity.
// Duplicated single-valued fields are ambiguous identity → typed STOP, never last-wins.
export const parseProvisionRecord = (text) => {
  const section = locateProvisionRecordSection(text);
  const scan = section.source.slice(section.start, section.end).split('\n').slice(1);
  const record = { slug: null, branch: null, includes: [], nodeModules: null, vscode: null };
  const single = { slug: 'slug', branch: 'branch', node_modules: 'nodeModules', 'vscode-settings': 'vscode' };
  const seen = new Set();
  for (const line of scan) {
    const m = line.match(/^- ([a-z_-]+): (.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] === 'include') {
      if (value !== '(none)') record.includes.push(value);
      continue;
    }
    const key = single[m[1]];
    if (!key) continue;
    if (seen.has(m[1])) throw stop(`handoff record: duplicate "${m[1]}" field — the record is ambiguous`);
    seen.add(m[1]);
    record[key] = value;
  }
  return record;
};

const pendingHandoffFields = ({ slug, branch }) =>
  ({ slug, branch, includes: [], nodeModules: 'pending', vscode: 'pending' });

// The stub is written only when ABSENT; the final record surgically replaces the tool section.
const writeHandoffStubIfAbsent = ({ wtRoot, slug, branch, fs, report }) => {
  const dst = join(wtRoot, PLANS_REL, handoffBasename(slug));
  const cur = readFileNoFollow(fs, dst);
  if (cur.bytes) {
    report.push('  handoff: kept (already present)');
    return;
  }
  if (!cur.absent) {
    throw stop(`the handoff at ${PLANS_REL}/${handoffBasename(slug)} is not readable as a regular file — fix or remove it, then re-run`);
  }
  guardDst(fs, wtRoot, dirname(dst));
  fs.mkdir(dirname(dst));
  writeContainedFileAtomic(wtRoot, dst, composeHandoffStub(pendingHandoffFields({ slug, branch })), fs, { stop: (m) => stop(m) });
};

const writeHandoffRecord = ({ wtRoot, slug, branch, fields, fs, report }) => {
  const dst = join(wtRoot, PLANS_REL, handoffBasename(slug));
  const cur = readFileNoFollow(fs, dst);
  if (!cur.bytes) {
    throw stop(`the handoff at ${PLANS_REL}/${handoffBasename(slug)} is not readable as a regular file — fix or remove it, then re-run --resume`);
  }
  const section = locateProvisionRecordSection(String(cur.bytes));
  const updated = `${section.source.slice(0, section.start)}${composeProvisionRecordSection(fields)}${section.source.slice(section.end)}`;
  writeContainedFileAtomic(wtRoot, dst, updated, fs, { stop: (m) => stop(m) });
  report.push('  handoff: provision record refreshed (user sections preserved)');
};

// ── provision ──────────────────────────────────────────────────────────────────────────

// Validated BEFORE any git mutation — a bad --plan/--as never leaves a half-made worktree.
const validateSeedPlan = ({ root, rootReal, planFlag, asFlag, fs }) => {
  if (asFlag !== null && (asFlag.includes('/') || asFlag.includes('\\') || !asFlag.endsWith('.md'))) {
    throw usageStop(`--as must be a basename ending in .md, got ${JSON.stringify(asFlag)}`);
  }
  const srcAbs = resolve(root, planFlag);
  const node = classifyNodeNoFollow(srcAbs, fs);
  if (node.kind === 'absent') throw stop(`--plan: not found: ${planFlag}`);
  if (node.kind === 'error') throw stop(`--plan: cannot inspect ${planFlag} (${node.error})`);
  if (node.kind !== 'regular-file') throw stop(`--plan must be a regular non-symlink file: ${planFlag}`);
  let srcReal;
  try {
    srcReal = fs.realpath(srcAbs);
  } catch {
    throw stop(`--plan: not found: ${planFlag}`);
  }
  if (!isInside(rootReal, srcReal)) throw stop(`--plan must resolve inside the main repo: ${planFlag}`);
  if (normalizeSlashes(dirname(srcReal)) === normalizeSlashes(join(rootReal, PLANS_REL)) && !isScratchPlanName(basename(srcReal))) {
    throw stop(
      `--plan names a bare (in-flight) plan inside MAIN's ${PLANS_REL} — the feature plan must live in the satellite ONLY, ` +
        'else main keeps a plan in flight and every land trips the review-state gate. ' +
        'Recovery: rename the main copy to a scratch name (or remove it), then re-run.',
    );
  }
  const name = asFlag ?? basename(srcAbs);
  if (!name.endsWith('.md')) throw stop(`the seeded plan name must end in .md: ${name}`);
  if (isScratchPlanName(name)) {
    throw stop(
      `refusing to seed a scratch-class plan name (${name}) — the worktree's review-state would read it as "no plan ` +
        'in flight" and every council check would pass vacuously. Seed a bare name via --as <name>.md.',
    );
  }
  return { srcAbs: srcReal, name };
};

const writeSeedPlan = ({ wtRoot, srcAbs, name, fs, report }) => {
  const dst = join(wtRoot, PLANS_REL, name);
  if (lstatNoFollow(fs.lstat, dst) !== null) {
    report.push(`  kept (already present): ${PLANS_REL}/${name}`);
    return;
  }
  const src = readFileNoFollow(fs, srcAbs);
  if (!src.bytes) throw stop(`--plan: not readable as a regular file: ${srcAbs}`);
  guardDst(fs, wtRoot, dirname(dst));
  fs.mkdir(dirname(dst));
  writeContainedFileAtomic(wtRoot, dst, String(src.bytes), fs, { stop: (m) => stop(m) });
  report.push(`  seeded plan: ${PLANS_REL}/${name}`);
};

const provisionIncludes = ({ root, rootReal, wtRoot, includes, git, fs, report, copied }) => {
  const recorded = [];
  for (const inc of includes) {
    const srcAbs = resolve(root, inc);
    let srcReal;
    try {
      srcReal = fs.realpath(srcAbs);
    } catch {
      throw stop(`--include: not found: ${inc}`);
    }
    if (!isInside(rootReal, srcReal)) throw stop(`--include must resolve inside the main repo: ${inc}`);
    const rel = relative(rootReal, srcReal);
    const probeRel = fs.lstat(srcReal).isDirectory() ? `${rel}/` : rel;
    if (!checkIgnored(git, probeRel, wtRoot)) {
      throw stop(
        `--include destination is not ignored in the worktree: ${rel} — it would become a land-preflight leftover. ` +
          'Recovery: ignore the path (shared exclude / .gitignore) or drop the --include.',
      );
    }
    copyNode({ srcAbs: srcReal, dstAbs: join(wtRoot, rel), wtRoot, rel, fs, report, copied });
    recorded.push(rel);
  }
  return recorded;
};

const LOCKFILE_MANAGERS = Object.freeze([
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
]);
const NEUTRAL_INSTALL_ADVICE =
  'install command not printed — package manager is ambiguous or unknown; install dependencies in the worktree by hand';

const resolveInstallAdvice = ({ root, wtRoot, fs }) => {
  const pkg = readFileNoFollow(fs, join(root, 'package.json'));
  let manager = null;
  let inspectLocks = false;
  if (pkg.absent) {
    inspectLocks = true;
  } else if (pkg.bytes) {
    try {
      const parsed = JSON.parse(String(pkg.bytes));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { command: null, instruction: NEUTRAL_INSTALL_ADVICE };
      }
      if (Object.hasOwn(parsed, 'packageManager')) {
        const match = typeof parsed.packageManager === 'string'
          ? /^(npm|pnpm|yarn|bun)@[^\s]+$/.exec(parsed.packageManager)
          : null;
        if (!match) return { command: null, instruction: NEUTRAL_INSTALL_ADVICE };
        manager = match[1];
      } else {
        inspectLocks = true;
      }
    } catch {
      return { command: null, instruction: NEUTRAL_INSTALL_ADVICE };
    }
  } else {
    return { command: null, instruction: NEUTRAL_INSTALL_ADVICE };
  }
  if (inspectLocks) {
    const found = [];
    for (const [name, candidate] of LOCKFILE_MANAGERS) {
      let st;
      try {
        st = fs.lstat(join(root, name));
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        return { command: null, instruction: NEUTRAL_INSTALL_ADVICE };
      }
      if (st.isSymbolicLink() || !st.isFile()) return { command: null, instruction: NEUTRAL_INSTALL_ADVICE };
      found.push(candidate);
    }
    if (found.length > 1) return { command: null, instruction: NEUTRAL_INSTALL_ADVICE };
    manager = found[0] ?? 'npm';
  }
  const command = `cd ${shellQuoteArg(wtRoot)} && ${manager} install`;
  return { command, instruction: command };
};

const provisionNodeModules = ({ root, rootReal, wtRoot, installFlag, git, fs, report }) => {
  const install = resolveInstallAdvice({ root, wtRoot, fs });
  if (installFlag) {
    const dst = join(wtRoot, 'node_modules');
    const existing = lstatNoFollow(fs.lstat, dst);
    if (existing !== null && existing.isSymbolicLink()) {
      // isolation only exists BEFORE the link: an install through it would write into MAIN
      const separator = install.command === null ? ' — ' : ' && ';
      report.push(`  node_modules: existing symlink kept — for isolation remove it first: rm ${shellQuoteArg(dst)}${separator}${install.instruction}`);
      return 'install-printed-unlink-first';
    }
    report.push(install.command === null
      ? `  node_modules: ${install.instruction}`
      : `  node_modules: install it yourself (zero spawn): ${install.instruction}`);
    return 'install-printed';
  }
  const mainNm = join(root, 'node_modules');
  const node = classifyNodeNoFollow(mainNm, fs);
  if (node.kind === 'absent') {
    report.push(`  node_modules: main has none — after your own install there, re-run --resume, or: ${install.instruction}`);
    return 'absent';
  }
  if (node.kind === 'symlink-unresolvable') {
    report.push(`  node_modules: main's is unresolvable — ${install.instruction}`);
    return 'unresolvable';
  }
  if (node.kind === 'error') throw stop(`cannot inspect main's node_modules (${node.error})`);
  if (node.kind !== 'plain-directory' && node.kind !== 'symlink-to-directory') {
    report.push(`  node_modules: main's node_modules is neither a plain directory nor a symlink resolving to a directory — not symlinked; ${install.instruction}`);
    return 'invalid-kind';
  }
  // A directory-form ignore pattern (node_modules/) never covers a SYMLINK of that name — the
  // link would surface as an untracked leftover; the placed-paths-stay-ignored rule applies.
  // Deliberately slashless: this probes the SYMLINK form.
  if (!checkIgnored(git, 'node_modules', wtRoot)) {
    report.push(`  node_modules: a symlink would not be ignored here (only the directory form is) — not symlinked; ${install.instruction}`);
    return 'not-ignored';
  }
  let mainNmReal;
  try {
    mainNmReal = fs.realpath(mainNm);
  } catch {
    report.push(`  node_modules: main's is unresolvable — ${install.instruction}`);
    return 'unresolvable';
  }
  if (!isInside(rootReal, mainNmReal)) {
    report.push(`  node_modules: main's resolves outside the repo — not symlinked; ${install.instruction}`);
    return 'outside-repo';
  }
  const dst = join(wtRoot, 'node_modules');
  if (lstatNoFollow(fs.lstat, dst) !== null) {
    report.push('  node_modules: already present in the worktree');
    return 'present';
  }
  guardDst(fs, wtRoot, dst);
  try {
    fs.symlink(mainNm, dst);
  } catch (err) {
    report.push(`  node_modules: symlink failed (${err?.code ?? 'error'}) — ${install.instruction}`);
    return 'symlink-failed';
  }
  report.push(`  node_modules: symlinked -> ${mainNm} (shared MUTABLE cache — writes through it hit MAIN's node_modules; isolation: --install; workspace self-links resolve to MAIN sources)`);
  return 'symlinked';
};

const provisionVscode = ({ root, wtRoot, slug, git, fs, report }) => {
  const relPath = '.vscode/settings.json';
  const vscodeDir = lstatNoFollow(fs.lstat, join(root, '.vscode'));
  if (vscodeDir === null || !vscodeDir.isDirectory()) {
    report.push('  .vscode: main has no .vscode/ dir — window title not written');
    return 'absent';
  }
  const tracked = git(['ls-files', '--', relPath], root);
  if (tracked.status !== 0) {
    throw stop(`git ls-files failed for ${relPath}: ${(tracked.stderr || tracked.stdout).trim()}`);
  }
  if (tracked.stdout.trim() !== '') {
    report.push(`  .vscode: ${relPath} is tracked — left byte-unchanged (set the window title by hand if wanted)`);
    return 'skipped-tracked';
  }
  if (!checkIgnored(git, relPath, wtRoot)) {
    report.push(`  .vscode: ${relPath} is not ignored in the worktree — skipped (it would become a land leftover)`);
    return 'skipped-not-ignored';
  }
  if (lstatNoFollow(fs.lstat, join(wtRoot, relPath)) !== null) {
    report.push('  .vscode: kept (already present)');
    return 'kept';
  }
  const src = readFileNoFollow(fs, join(root, relPath));
  if (src.unsafe) {
    report.push(`  .vscode: main's ${relPath} is not a regular file — skipped`);
    return 'skipped-unsafe';
  }
  if (src.error) {
    report.push(`  .vscode: main's ${relPath} is unreadable (${src.error}) — skipped`);
    return 'skipped-unreadable';
  }
  const base = (() => {
    if (!src.bytes) return {};
    try {
      return JSON.parse(String(src.bytes));
    } catch {
      return null;
    }
  })();
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    report.push(`  .vscode: main's ${relPath} is not a JSON object — skipped`);
    return 'skipped-unparsable';
  }
  const body = `${JSON.stringify({ ...base, 'window.title': slug }, null, 2)}\n`;
  guardDst(fs, wtRoot, join(wtRoot, '.vscode'));
  fs.mkdir(join(wtRoot, '.vscode'));
  writeContainedFileAtomic(wtRoot, join(wtRoot, relPath), body, fs, { stop: (m) => stop(m) });
  report.push(`  .vscode: ${relPath} written (window.title = ${slug})`);
  return 'written';
};

// tracked/untracked is decided by GIT (a run-local copy log lies after a crash-resume); an
// untracked pin-carrying file is rewritten ONLY when its bytes equal the MAIN source or its
// already-rebased form — anything else is user work and stays byte-untouched (reported).
const rebasePins = ({ root, wtRoot, git, fs, report }) => {
  for (const target of REBASE_TARGETS) {
    const wtAbs = join(wtRoot, target);
    const cur = readFileNoFollow(fs, wtAbs);
    if (cur.absent) continue;
    if (!cur.bytes) {
      report.push(`  ${target}: ${cur.unsafe ? 'not a regular file' : `unreadable (${cur.error})`} — left untouched`);
      continue;
    }
    const tracked = git(['ls-files', '--', target], wtRoot);
    if (tracked.status !== 0) throw stop(`git ls-files failed for ${target}: ${(tracked.stderr || tracked.stdout).trim()}`);
    const text = String(cur.bytes);
    const { text: rebased, changes } = rebaseAbsolutePins(text, root, wtRoot);
    if (tracked.stdout.trim() !== '') {
      if (changes.length > 0) report.push(`  ${target}: ${TRACKED_PIN_DECLARATION}`);
      continue;
    }
    if (changes.length === 0) continue;
    const main = readFileNoFollow(fs, join(root, target));
    const mainText = main.bytes ? String(main.bytes) : null;
    const rebasedMain = mainText === null ? null : rebaseAbsolutePins(mainText, root, wtRoot).text;
    if (mainText !== null && (text === mainText || text === rebasedMain)) {
      writeContainedFileAtomic(wtRoot, wtAbs, rebasedMain, fs, { stop: (m) => stop(m) });
      // file:line + count only — settings lines can carry secrets, so content never hits the report
      for (const c of changes) report.push(`  rebased ${target}:${c.line} (${c.count} replacement${c.count === 1 ? '' : 's'})`);
    } else {
      report.push(`  ${target}: carries main-root pins but is user-modified — left untouched; rebase it by hand if wanted`);
    }
  }
  const gates = readFileNoFollow(fs, join(wtRoot, 'docs/ai/gates.json'));
  if (!gates.absent) {
    const capable = (() => {
      if (!gates.bytes) return null;
      try {
        return isFinalCapableDeclaration(JSON.parse(String(gates.bytes)).gates, wtRoot);
      } catch {
        return null;
      }
    })();
    report.push(capable === null
      ? '  gates.json: unreadable at the worktree — final-capability unknown'
      : `  gates.json: final-capable at the worktree: ${capable ? 'yes' : 'no'}`);
  }
};

export const runProvision = ({ argvSlug, flags, cwd, git, deps, log }) => {
  const fs = fsOf(deps);
  const slug = validateSlug(argvSlug);
  const branch = flags.branch ?? `${DEFAULT_BRANCH_PREFIX}${slug}`;
  if (flags.plan == null) throw usageStop('provision requires --plan <path> (the ONE feature plan the worktree starts with)');
  const { root, commonDir } = resolveRoots(cwd, git);
  const rootReal = fs.realpath(root);
  const config = loadWorktreesConfig(root, deps);
  const targetAbs = resolveTargetDir({ root, slug, dirFlag: flags.dir ?? null, parentDir: config.parentDir });
  const report = [];

  // dir probes carry the trailing slash — a dir-form ignore pattern never matches an
  // absent-slashless path, and the probed dir may not exist yet
  if (!checkIgnored(git, `${PLANS_REL}/`, root)) {
    throw stop(`${PLANS_REL} is not git-ignored in the main repo — the seeded plan and handoff would land as tracked leftovers. Ignore ${PLANS_REL}/ first.`);
  }

  const targetReal = realpathThroughExistingParent(targetAbs, deps);
  if (targetReal === rootReal) throw stop('the target dir is the main repo itself');
  if (isInside(rootReal, targetReal)) {
    const rel = relative(rootReal, targetReal);
    if (!checkIgnored(git, `${rel}/`, root)) {
      throw stop(`the target dir is inside the main repo and not ignored: ${rel} — pick an outside dir (--dir) or ignore it`);
    }
  }

  const seed = validateSeedPlan({ root, rootReal, planFlag: flags.plan, asFlag: flags.as ?? null, fs });

  const sources = assertProvisionSourcesContained({ root, rootReal, fs, statFollow: deps.stat ?? statSync });
  const includeSources = [];
  for (const inc of flags.include) {
    const incAbs = resolve(root, inc);
    let incReal;
    try {
      incReal = fs.realpath(incAbs);
    } catch {
      throw stop(`--include: not found: ${inc}`);
    }
    if (!isInside(rootReal, incReal)) throw stop(`--include must resolve inside the main repo: ${inc}`);
    includeSources.push({ rel: relative(rootReal, incReal), real: incReal });
  }
  assertTargetOutsideSources({ targetReal, sources: [...sources, ...includeSources] });

  const probeDir = resolveProbeDir(dirname(targetReal), deps);
  // the probe itself is a create+delete write — on resume it runs only AFTER every identity check
  const runWritabilityProbe = () => {
    const probe = probeParentWritable(probeDir, deps);
    if (!probe.writable) {
      if (probe.cleanupFailed) {
        throw stop(
          `the writability probe could not clean up its probe dir (${probe.cleanupFailed.code}) — remove it by hand: ${probe.cleanupFailed.path}`,
        );
      }
      throw writabilityStop({ parentDir: probeDir, root, slug, flags });
    }
  };

  if (flags.resume) {
    const entry = listWorktrees(git, root).find((e) => resolve(e.path) === resolve(targetReal));
    if (!entry) throw stop(`--resume: no registered worktree at ${targetReal} — run provision without --resume`);
    if (entry.branch !== `refs/heads/${branch}`) {
      throw stop(`--resume identity mismatch: worktree at ${targetReal} is on ${entry.branch ?? 'detached HEAD'}, expected refs/heads/${branch}`);
    }
    const wtCommon = gitLine(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], targetReal);
    if (wtCommon !== commonDir) throw stop(`--resume identity mismatch: ${targetReal} does not share this repo's git dir`);
    assertResumeHandoffIdentity({ wtRoot: targetReal, slug, branch, fs });
    assertResumePlanCompatibility({ wtRoot: targetReal, seedName: seed.name, fs });
    runWritabilityProbe();
    report.push(`resuming provision at ${targetReal} (branch ${branch})`);
  } else {
    runWritabilityProbe();
    const add = git(['worktree', 'add', '-b', branch, targetReal], root);
    if (add.status !== 0) {
      throw stop(
        [
          `git worktree add refused: ${(add.stderr || add.stdout).trim()}`,
          'Recoveries: another --dir · another --branch · provision --resume <slug> (finish a half-done provision) · consented cleanup of the stale worktree.',
        ].join('\n'),
      );
    }
    report.push(`created worktree ${targetReal} (branch ${branch})`);
  }

  // any failure past this point leaves a real created worktree — the error must say so and
  // hand back the exact finish command, never just the local cause
  try {
    return finishProvision({ root, rootReal, targetPath: targetReal, slug, branch, flags, seed, git, deps, fs, report, log });
  } catch (err) {
    if (!flags.resume && err?.message) {
      err.message += `\nNOTE: the worktree at ${targetReal} (branch ${branch}) was created and KEPT — finish with: ${composeProvisionArgv({ root, slug, flags: { ...flags, resume: true } })} (or reclaim it with the consented cleanup).`;
    }
    throw err;
  }
};

const finishProvision = ({ root, rootReal, targetPath, slug, branch, flags, seed, git, deps, fs, report, log }) => {
  writeHandoffStubIfAbsent({ wtRoot: targetPath, slug, branch, fs, report });

  const copied = new Set();
  report.push('copying the provision set (copy-if-missing; tracked files come from the checkout):');
  for (const pattern of provisionCopySet(root, deps)) {
    const rel = patternToProbe(pattern).replace(/\/$/, '');
    copyNode({ srcAbs: join(root, rel), dstAbs: join(targetPath, rel), wtRoot: targetPath, rel, fs, report, copied });
  }

  writeSeedPlan({ wtRoot: targetPath, srcAbs: seed.srcAbs, name: seed.name, fs, report });
  const includesRecorded = provisionIncludes({ root, rootReal, wtRoot: targetPath, includes: flags.include, git, fs, report, copied });
  const nodeModulesMode = provisionNodeModules({ root, rootReal, wtRoot: targetPath, installFlag: flags.install, git, fs, report });
  const vscodeMode = provisionVscode({ root, wtRoot: targetPath, slug, git, fs, report });

  rebasePins({ root, wtRoot: targetPath, git, fs, report });

  writeHandoffRecord({
    wtRoot: targetPath,
    slug,
    branch,
    fields: { slug, branch, includes: includesRecorded, nodeModules: nodeModulesMode, vscode: vscodeMode },
    fs,
    report,
  });

  const inFlight = plansInFlight(targetPath, fs.readdir);
  if (inFlight.length !== 1 || inFlight[0] !== seed.name) {
    throw stop(
      `the worktree must hold EXACTLY ONE in-flight plan, found [${inFlight.join(', ')}] — remove the extras (or re-seed) and re-run --resume`,
    );
  }

  const porcelain = git(['status', '--porcelain'], targetPath);
  if (porcelain.status !== 0) throw stop(`git status failed in the worktree: ${porcelain.stderr.trim()}`);
  if (porcelain.stdout.trim() !== '') {
    throw stop(
      `post-provision verify failed — the worktree status is not clean (everything provision places must be ignored-or-tracked):\n${porcelain.stdout.trimEnd()}`,
    );
  }

  const base = gitLine(git, ['rev-parse', 'HEAD'], targetPath) ?? '(unknown)';
  for (const line of report) log(line);
  log(`[worktrees] provisioned ${slug} at ${targetPath} (branch ${branch}, base ${base})`);
  log(`open it: code -n ${shellQuoteArg(targetPath)}`);
  return EXIT.ok;
};

// ── list ───────────────────────────────────────────────────────────────────────────────

export const runList = ({ cwd, git, deps, log }) => {
  const fs = fsOf(deps);
  const entries = listWorktrees(git, cwd);
  if (entries.length <= 1) {
    log('[worktrees] no linked worktrees');
    return EXIT.ok;
  }
  const rows = [];
  for (const entry of entries.slice(1)) {
    const row = {
      slug: 'unknown (foreign)',
      path: entry.path,
      branch: entry.detached ? '(detached)' : (entry.branch ?? '(none)').replace(/^refs\/heads\//, ''),
      base: entry.head ? entry.head.slice(0, 12) : '(none)',
      dirty: '?',
      handoff: 'no',
      prunable: entry.prunable,
    };
    if (!entry.prunable) {
      // the SAME no-follow chain scan resume identity uses: only a genuinely absent docs/plans
      // under a safe chain reads as no-handoff; symlinks, non-files, and read failures render honestly
      const scan = scanPlansDir({ wtRoot: entry.path, fs });
      if (scan.state === 'unreadable' || (scan.state === 'ok' && scan.nonRegular.length > 0)) {
        row.handoff = '(unreadable)';
      } else if (scan.state === 'ok') {
        if (scan.handoffs.length === 1) {
          row.slug = scan.handoffs[0].slice('handoff-'.length, -'.md'.length);
          row.handoff = 'yes';
        } else if (scan.handoffs.length > 1) {
          row.handoff = `ambiguous (${scan.handoffs.length})`;
        }
      }
      const porcelain = git(['--no-optional-locks', 'status', '--porcelain'], entry.path);
      row.dirty = porcelain.status === 0 ? (porcelain.stdout.trim() === '' ? 'clean' : 'dirty') : '(unreadable)';
    }
    rows.push(row);
  }
  for (const r of rows) {
    const state = r.prunable ? 'PRUNABLE (dir gone — `git worktree prune` reclaims the entry)' : `${r.dirty}, handoff: ${r.handoff}`;
    log(`${r.slug} · ${r.path} · branch ${r.branch} · base ${r.base} · ${state}`);
    if (!r.prunable) log(`  open: code -n ${shellQuoteArg(r.path)}`);
  }
  return EXIT.ok;
};

// ── CLI ────────────────────────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h') return { sub: 'help' };
  if (!['provision', 'list', 'land', 'cleanup'].includes(sub)) {
    throw usageStop(`unknown subcommand ${JSON.stringify(sub)}\n${USAGE}`);
  }
  const SUB_FLAGS = {
    provision: ['--plan', '--as', '--dir', '--branch', '--include', '--install', '--resume'],
    list: [],
    land: ['--prepare'],
    cleanup: ['--branch', '--abandon'],
  };
  const flags = { plan: null, as: null, dir: null, branch: null, include: [], install: false, resume: false, prepare: false, abandon: false };
  let slug = null;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      if (!SUB_FLAGS[sub].includes(a)) {
        throw usageStop(`flag ${JSON.stringify(a)} is not valid for ${sub}\n${USAGE}`);
      }
      const takesValue = ['--plan', '--as', '--dir', '--branch', '--include'].includes(a);
      if (takesValue) {
        i += 1;
        if (rest[i] === undefined) throw usageStop(`${a} requires an argument`);
        if (a === '--include') flags.include.push(rest[i]);
        else flags[a.slice(2)] = rest[i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else if (slug === null) slug = a;
    else throw usageStop(`unexpected argument ${JSON.stringify(a)}`);
  }
  if (sub !== 'list' && slug === null) throw usageStop(`${sub} requires the positional <slug>`);
  if (sub === 'list' && slug !== null) throw usageStop('list takes no positional argument');
  return { sub, slug, flags };
};

export const runCli = (argv, deps = {}) => {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const git = deps.git ?? spawnGit;
  try {
    const parsed = parseArgs(argv);
    if (parsed.sub === 'help') {
      log(USAGE);
      return EXIT.ok;
    }
    if (parsed.sub === 'provision') {
      return runProvision({ argvSlug: parsed.slug, flags: parsed.flags, cwd, git, deps, log });
    }
    if (parsed.sub === 'list') return runList({ cwd, git, deps, log });
    throw stop(`${parsed.sub} is not available in this build yet — it ships with this release's landing half`);
  } catch (err) {
    logError(`[worktrees] ${err.message}`);
    return err.exitCode ?? EXIT.stop;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
