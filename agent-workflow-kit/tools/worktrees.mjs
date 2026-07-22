#!/usr/bin/env node
// worktrees.mjs — parallel feature worktrees over git: provision | list | land | cleanup (v1).
// Thin steps over git — every verification datum is recomputed live from git (branches, OIDs,
// observed status), never read from stored metadata; the handoff file is the one on-disk record
// (written at provision, refreshed at prepare, read by list/cleanup). Ownership matrix, crash
// discipline, and the zero-prompt lanes live in references/modes/worktrees.md. Dependency-free,
// Node >= 22.
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
const errorText = (error) => String(error?.message ?? error).replace(/^\[agent-workflow-kit\] /, '');
const composeFailure = (primary, secondaryName, secondary) =>
  stop(`${errorText(primary)}; ${secondaryName} failed: ${errorText(secondary)}`);

export const EXIT = Object.freeze({ ok: 0, stop: 1, usage: 2 });
export const CONFIG_REL = 'docs/ai/worktrees.json';
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DEFAULT_BRANCH_PREFIX = 'aw/';
export const handoffBasename = (slug) => `handoff-${slug}.md`;
const WORKTREES_TOOL_ABS = fileURLToPath(import.meta.url);
const WORKTREES_TOOL_DIR = dirname(WORKTREES_TOOL_ABS);

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
const TRANSFER_EXCLUSIONS = Object.freeze([':!docs/ai', ':!docs/plans']);
const PREPARE_LOCK_BASENAME = 'aw-prepare-lock';

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
  '            dialogue ask). Refuses divergence, incomplete satellite state, or a dirty main.',
  '  cleanup <slug> [--branch <name>] [--abandon]',
  '            remove a LANDED worktree (fail-closed verification); --abandon is the one',
  '            destructive arm and destroys unlanded work.',
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

// The include-identity door (F3). `door` rides ONLY the --include copy lane: { queuePath } on
// every crossing, plus { identity } for a FILE include root (a directory root is re-checked at
// walk start instead; its children keep the same-call lstat↔open identity — path-based walk is
// a stated residual). Every STOP here emits INCLUDE_IDENTITY_RULE.
const includeIdentityStop = (rel, cause) => stop(`--include: ${cause}: ${rel}\n${INCLUDE_IDENTITY_RULE}`);

// The fresh-preexist STOPs carry their own surgical recovery so the generic worktree-kept NOTE
// never steers the operator into a blind --resume over the very node the door refused.
const INCLUDE_PREEXIST_CAUSE = 'the include destination already exists at walk time — inspect the unexpected destination and remove it (single node: rm; directory: rm -rf), then finish with --resume';

// Equal / ancestor / descendant, canonized PER PLATFORM: on a backslash-separator platform
// `relative()` returns backslashes and path comparison is case-insensitive, so separators
// normalize and case folds (fail-closed for a refusal guard — more refusals, never fewer); on
// POSIX the compare stays LITERAL — a backslash is a valid filename character and case is
// significant, so normalizing would conflate distinct names into false refusals. The separator
// is injectable so both platforms' semantics are test-pinned from one host.
export const includeRelsOverlap = (a, b, { separator = sep } = {}) => {
  const canon = (p) => (separator === '\\' ? normalizeSlashes(p).toLowerCase() : p);
  const left = canon(a);
  const right = canon(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
};

// Follows links deliberately (the door must land on the THEN-CURRENT canonical queue node);
// O_NONBLOCK keeps a FIFO-shaped queue from blocking the door — its fstat classifies it.
const QUEUE_DOOR_READ = fsC.O_RDONLY | (fsC.O_NONBLOCK ?? 0);

// Runs while the SOURCE descriptor is open: open the LEXICAL queue path, fstat the OPEN
// descriptor, compare identities with both descriptors open. lstat-ENOENT (truly absent) keeps
// the lexical guard alone; a dangling link, unreadable, non-regular, or erroring queue is
// unprovable → fail-closed STOP. Queue identity is never cached across crossings.
const assertSourceIsNotDoorTimeQueue = ({ sourceStat, queuePath, rel, fs }) => {
  // Absence is proven at the OPEN, never at the lstat alone — a queue born between the two
  // still meets the descriptor compare. lstat's job is to tell truly-absent (both ENOENT)
  // from a dangling link (lstat succeeds, open ENOENT), which stays a fail-closed STOP.
  const lstatAbsent = (() => {
    try {
      fs.lstat(queuePath);
      return false;
    } catch (err) {
      if (err?.code === 'ENOENT') return true;
      throw includeIdentityStop(rel, `cannot probe the shared series index (${err?.code ?? 'fs error'})`);
    }
  })();
  const handle = { fd: null };
  const outcome = { error: null };
  try {
    try {
      handle.fd = fs.open(queuePath, QUEUE_DOOR_READ);
    } catch (err) {
      if (err?.code === 'ENOENT' && lstatAbsent) return;
      if (err?.code === 'ENOENT') throw includeIdentityStop(rel, 'the shared series index is a dangling link at copy time');
      throw includeIdentityStop(rel, `cannot open the shared series index (${err?.code ?? 'fs error'})`);
    }
    const queueStat = (() => {
      try {
        return fs.fstat(handle.fd);
      } catch (err) {
        throw includeIdentityStop(rel, `cannot inspect the shared series index (${err?.code ?? 'fs error'})`);
      }
    })();
    if (!queueStat.isFile()) throw includeIdentityStop(rel, 'the shared series index is not a regular file at copy time');
    if (queueStat.dev === sourceStat.dev && queueStat.ino === sourceStat.ino) {
      throw includeIdentityStop(rel, 'the source IS the door-time queue');
    }
  } catch (error) {
    outcome.error = error;
  }
  if (handle.fd !== null) {
    try {
      fs.close(handle.fd);
    } catch (closeError) {
      if (!outcome.error) {
        outcome.error = includeIdentityStop(rel, `cannot close the shared series index descriptor (${closeError?.code ?? 'fs error'})`);
      } else {
        outcome.error.message += ` (additionally: the shared series index descriptor failed to close: ${closeError?.code ?? 'fs error'})`;
      }
    }
  }
  if (outcome.error) throw outcome.error;
};

const copyFileNoFollow = ({ srcAbs, dstAbs, sourceStat, rel, fs, door = null, wtRoot }) => {
  const handles = { source: null, destination: null };
  const closeErrors = [];
  const outcome = { error: null };
  try {
    const sourceWindowStop = () => (door
      ? includeIdentityStop(rel, 'the source changed between lstat and open')
      : stop(`copy source changed between lstat and open: ${rel}`));
    try {
      handles.source = fs.open(srcAbs, NOFOLLOW_READ);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
        throw sourceWindowStop();
      }
      if (door) throw includeIdentityStop(rel, `cannot prove the source identity (${error?.code ?? 'fs error'})`);
      throw error;
    }
    const descriptorStat = (() => {
      try {
        return fs.fstat(handles.source);
      } catch (error) {
        if (door) throw includeIdentityStop(rel, `cannot prove the source identity (${error?.code ?? 'fs error'})`);
        throw error;
      }
    })();
    if (!descriptorStat.isFile() || descriptorStat.dev !== sourceStat.dev || descriptorStat.ino !== sourceStat.ino) {
      throw sourceWindowStop();
    }
    if (door?.identity && (descriptorStat.dev !== door.identity.dev || descriptorStat.ino !== door.identity.ino)) {
      throw includeIdentityStop(rel, 'the source is not the node preflight approved');
    }
    if (door) assertSourceIsNotDoorTimeQueue({ sourceStat: descriptorStat, queuePath: door.queuePath, rel, fs });
    // Destination preparation runs only AFTER every source-side proof — a refusal must leave no
    // fresh parent-directory residue, in either lane.
    guardDst(fs, wtRoot, dirname(dstAbs));
    fs.mkdir(dirname(dstAbs));
    guardDst(fs, wtRoot, dstAbs);
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
      closeErrors.push({ key, error });
    }
  }
  const withDestinationState = (error) => Object.assign(error, {
    copyDoorDestinationCreated: handles.destination !== null,
  });
  // Every close failure surfaces with its OWN descriptor name, in close order — a latched
  // primary error carries them all appended; without one, the first failure leads and the rest
  // still ride along. The suffix ALSO travels as a field because the copy walk re-wraps
  // non-STOP primaries into its own message (which would otherwise drop the close names).
  const closeSuffix = (failures) => failures
    .map(({ key, error }) => ` (additionally: the ${key} descriptor failed to close: ${error?.code ?? 'fs error'})`)
    .join('');
  if (outcome.error) {
    const suffix = closeSuffix(closeErrors);
    outcome.error.message += suffix;
    if (suffix) outcome.error.closeFailureSuffix = suffix;
    throw withDestinationState(outcome.error);
  }
  if (closeErrors.length > 0) {
    const [first, ...rest] = closeErrors;
    const suffix = ` (the ${first.key} descriptor failed to close)${closeSuffix(rest)}`;
    first.error.message = `${first.error.message ?? ''}${suffix}`;
    first.error.closeFailureSuffix = suffix;
    throw withDestinationState(first.error);
  }
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

const probeCleanupStop = ({ path, code }) => stop(
  `the writability probe could not clean up its probe dir (${code}) — remove it by hand: ${path}`,
);

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
const quoteOwnTool = () => `'${WORKTREES_TOOL_ABS.replace(/'/g, `'\\''`)}'`;
const composeOwnToolPrefix = (root) =>
  `cd ${shellQuoteArg(root)} && node ${quoteOwnTool()}`;

const landWritabilityStop = ({ parentDir, root, slug }) => stop([
  `the worktrees parent dir is not writable from this session: ${parentDir}`,
  'Arm the ONE-TIME consent (then land runs promptless):',
  `  .claude/settings.json → sandbox.filesystem.allowWrite += ${JSON.stringify(parentDir)}`,
  'Or run the full command yourself in a plain terminal:',
  `  ${composeOwnToolPrefix(root)} land ${shellQuoteArg(slug)} --prepare`,
].join('\n'));

export const composeProvisionArgv = ({ root, slug, flags }) => {
  const q = shellQuoteArg;
  return [composeOwnToolPrefix(root), 'provision', q(slug), ...provisionFlagsTail(flags, q)].join(' ');
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

// The ONE path-removal door: containment + no-follow classification before a known leaf/tree is
// removed. Symlinks are unlinked as links; recursion enters plain directories only.
const removeNodeNoFollow = ({ root, abs, fs, label = abs, emptyOnly = false }) => {
  guardDst(fs, root, dirname(abs));
  const node = classifyNodeNoFollow(abs, fs);
  if (node.kind === 'absent') return true;
  if (node.kind === 'error') throw stop(`cannot inspect removal target ${label} (${node.error})`);
  if (node.kind === 'plain-directory') {
    let names;
    try {
      names = fs.readdir(abs);
    } catch (error) {
      throw stop(`cannot enumerate removal target ${label} (${error?.code ?? 'fs error'})`, { causeCode: error?.code ?? 'fs error' });
    }
    if (emptyOnly && names.length > 0) return false;
    for (const name of names) {
      removeNodeNoFollow({ root, abs: join(abs, name), fs, label: `${label}/${name}` });
    }
    try {
      fs.rmdir(abs);
    } catch (error) {
      throw stop(`cannot remove directory ${label} (${error?.code ?? 'fs error'})`, { causeCode: error?.code ?? 'fs error' });
    }
    return true;
  }
  if (emptyOnly) return false;
  if (node.kind === 'special' || node.kind === 'symlink-to-special') {
    throw stop(`refusing to remove special node ${label}`);
  }
  try {
    fs.unlink(abs);
  } catch (error) {
    throw stop(`cannot remove ${label} (${error?.code ?? 'fs error'})`, { causeCode: error?.code ?? 'fs error' });
  }
  return true;
};

const removeEmptyParentsNoFollow = ({ root, abs, fs }) => {
  const parent = dirname(abs);
  if (parent === root) return;
  const removed = removeNodeNoFollow({
    root, abs: parent, fs, label: relative(root, parent), emptyOnly: true,
  });
  if (removed) removeEmptyParentsNoFollow({ root, abs: parent, fs });
};

const failAfterCopy = ({ cause, dstAbs, wtRoot, fs }) => {
  const primary = cause.message.replace(/^\[agent-workflow-kit\] /, '');
  const throwCleanupFailure = (error) => {
    // a door STOP carries its underlying errno as causeCode — the composed contract stays concise
    const cleanupCode = error?.causeCode ?? error?.code ?? 'fs error';
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
    removeNodeNoFollow({ root: wtRoot, abs: dstAbs, fs, label: dstAbs });
  } catch (error) {
    throwCleanupFailure(error);
  }
  throw stop(`${primary} — partial destination removed; re-run provision`);
};

const copyNode = ({ srcAbs, dstAbs, wtRoot, rel, fs, report, copied, door = null }) => {
  if (EXCLUDED_BASENAMES.has(basename(srcAbs))) {
    report.push(`  skip (session sidecar): ${rel}`);
    return;
  }
  let st;
  try {
    st = fs.lstat(srcAbs);
  } catch (err) {
    if (door) throw includeIdentityStop(rel, `cannot prove the source identity (${err?.code ?? 'fs error'})`);
    throw stop(`copy failed (${err?.code ?? 'fs error'}) reading ${rel}`);
  }
  // A preflight-approved FILE include routes ONLY to the regular-file door — a node that is no
  // longer a plain regular file (kind is part of the preflight identity) stops before any branch
  // could create a destination.
  if (door?.identity && (st.isSymbolicLink() || !st.isFile())) {
    throw includeIdentityStop(rel, 'the source is not the node preflight approved');
  }
  try {
    if (st.isSymbolicLink()) {
      if (lstatNoFollow(fs.lstat, dstAbs) !== null) {
        // Fresh-provision include lane: an existing destination is aliasing the overlap
        // comparator missed (nothing legitimate pre-populates it) — fail closed, never "kept".
        if (door?.fresh) throw includeIdentityStop(rel, INCLUDE_PREEXIST_CAUSE);
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
      } else if (door?.fresh) {
        // Mirrors the file/symlink kept-exit STOPs: on a fresh provision no include destination
        // node may pre-exist — an existing nested directory is aliasing or foreign content that
        // must never fall under the include's ownership.
        throw includeIdentityStop(rel, INCLUDE_PREEXIST_CAUSE);
      }
      for (const entry of fs.readdir(srcAbs)) {
        copyNode({ srcAbs: join(srcAbs, entry), dstAbs: join(dstAbs, entry), wtRoot, rel: `${rel}/${entry}`, fs, report, copied, door });
      }
    } else if (st.isFile()) {
      if (lstatNoFollow(fs.lstat, dstAbs) !== null) {
        if (door?.fresh) throw includeIdentityStop(rel, INCLUDE_PREEXIST_CAUSE);
        report.push(`  kept (already present): ${rel}`);
        return;
      }
      try {
        copyFileNoFollow({ srcAbs, dstAbs, sourceStat: st, rel, fs, door, wtRoot });
      } catch (err) {
        const cause = err?.code === WORKTREES_STOP ? err : stop(`copy failed (${err?.code ?? 'fs error'}) at ${rel}${err?.closeFailureSuffix ?? ''}`);
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

// The orientation facts a fresh satellite session cannot derive from its own checkout. They are
// CONSTANTS so the doc-parity registry can pin the mode doc to the exact strings the tool emits.
export const QUEUE_BASENAME = 'queue.md';
export const QUEUE_SHARED_RULE =
  'the series index is SHARED and lives ONLY in main: read it at the absolute path above, and never copy it into this worktree, because docs/plans is git-ignored and machine-local, so a copy silently diverges from what main and every other worktree are writing. This worktree never WRITES that file: reaching outside it is an fs_outside_repo action the autonomy policy denies by default. Put new findings in THIS handoff record instead — it is the channel that survives the landing, and main appends them to the index from here';
export const LANDING_FROM_MAIN = 'landing runs FROM MAIN, never from this worktree';
export const NO_DEPENDENCIES_POSTURE = 'no install needed — the project declares no dependencies';
// The recorded node_modules mode for that same verdict: provision neither advised nor created a
// node_modules for this worktree.
export const NODE_MODULES_NONE = 'no-dependencies';
// The cleanup-ownership contract (AD-069): ownership is information content, decided live at
// cleanup time — never provenance, never the handoff record. Doc-parity pins this exact sentence
// into the worktrees mode doc; every ownership STOP emits it.
export const CLEANUP_OWNERSHIP_RULE = "node_modules ownership is decided live: only a symlink whose raw target bytes equal MAIN's node_modules path, in the ignored lane, is provision-ephemeral; an absent node with no index entry is clean; every other state stops cleanup to protect user data or because inspection failed";
export const INCLUDE_IDENTITY_RULE = 'An --include source is copied only through the identity door: a file include must still match the identity preflight recorded (device, inode, kind), a directory include root is re-checked at walk start, and every copied file is proven, with both descriptors open, not to be the node that IS the door-time queue — an absent queue keeps the lexical guard alone, and anything unprovable stops the copy';

// The record is LINE-oriented and is parsed back for IDENTITY, so a value carrying a control byte
// is refused rather than written: a newline spills a second line the parser reads as a real field
// (`- include:` is exempt from the duplicate-identity STOP, and an `## …` spill truncates or bricks
// the whole section). Values reach here from the repo ROOT path and from --include, both of which
// may legally carry a newline on POSIX — so the guard is the only thing between them and a forged
// record. U+2028/U+2029 ride the same refusal: they are line terminators to the JS regex `.` but
// not to String.split('\n'), so such a value WRITES fine and is then silently DROPPED on read —
// a lost field with no error, which is the one outcome this codebase never allows.
// Fail closed: refuse to write, never sanitize silently.
const RECORD_CONTROL_BYTE = /[\u0000-\u001F\u007F\u2028\u2029]/;
const recordValue = (name, value) => {
  const text = String(value);
  if (RECORD_CONTROL_BYTE.test(text)) {
    throw stop(`handoff record: the ${name} value carries a control character (newline/CR/NUL) — refusing to write a record whose fields could be forged by an injected line`);
  }
  // The parser `.trim()`s every value on read, and String.prototype.trim strips UNICODE whitespace
  // — so an edge space (a Unicode one is legal even in a git branch name) writes fine and reads
  // back as a DIFFERENT identity, stranding the worktree behind a record that no longer matches.
  if (text !== text.trim()) {
    throw stop(`handoff record: the ${name} value carries leading or trailing whitespace, which the record trims on read — the identity would change across a write→read round-trip: ${JSON.stringify(text)}`);
  }
  return text;
};

// An OPTIONAL field is omitted when absent, never rendered as "null": a record written by an
// earlier kit is re-composed from its PARSED form at every refresh (land --prepare), so a field
// that kit never wrote must survive the round-trip as absence, not as a literal null string.
const optionalField = (name, value) => (value == null ? [] : [`- ${name}: ${recordValue(name, value)}`]);

const composeProvisionRecordSection = ({ slug, branch, includes, nodeModules, vscode, install = null, sharedQueue = null, landing = null, prepared = null }) => [
  '## Provision record',
  '',
  `- slug: ${recordValue('slug', slug)}`,
  `- branch: ${recordValue('branch', branch)}`,
  ...(includes.length === 0 ? ['- include: (none)'] : includes.map((p) => `- include: ${recordValue('include', p)}`)),
  `- node_modules: ${recordValue('node_modules', nodeModules)}`,
  `- vscode-settings: ${recordValue('vscode-settings', vscode)}`,
  ...optionalField('install', install),
  ...optionalField('shared-queue', sharedQueue),
  ...optionalField('landing', landing),
  ...optionalField('prepared-tree', prepared),
  '',
  // The rule says "at the absolute path above", so it ships only WITH that path: a record from an
  // earlier kit carries no shared-queue field, and a rule pointing at nothing is worse than silence.
  ...(sharedQueue == null ? [] : [QUEUE_SHARED_RULE, '']),
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
  const record = { slug: null, branch: null, includes: [], nodeModules: null, vscode: null, install: null, sharedQueue: null, landing: null, prepared: null };
  const single = {
    slug: 'slug', branch: 'branch', node_modules: 'nodeModules',
    'vscode-settings': 'vscode', 'prepared-tree': 'prepared',
    install: 'install', 'shared-queue': 'sharedQueue', landing: 'landing',
  };
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

// Derived from MAIN's root, so the satellite reads an absolute path and a command that already
// cd-s back to main — neither is derivable from inside the worktree.
const orientationFields = ({ root, slug }) => ({
  sharedQueue: join(root, PLANS_REL, QUEUE_BASENAME),
  landing: `${LANDING_FROM_MAIN} — ${composeOwnToolPrefix(root)} land ${shellQuoteArg(slug)} --prepare`,
});

// Pre-mutation gate for everything the record will carry. `sharedQueue`/`landing` are derived from
// the repo ROOT, so validating them here validates the root itself.
const assertRecordValuesComposable = ({ root, slug, branch }) => {
  recordValue('slug', slug);
  recordValue('branch', branch);
  const orientation = orientationFields({ root, slug });
  recordValue('shared-queue', orientation.sharedQueue);
  recordValue('landing', orientation.landing);
};

// An `- include:` value also round-trips through the literal `(none)` empty-list sentinel, so that
// exact text reads back as NO value at all and cleanup would not recognize the copied path.
// (Edge whitespace is refused inside recordValue — the same trim-on-read hazard for every field.)
const assertIncludeRoundTrips = (rel) => {
  recordValue('include', rel);
  // No empty-rel arm: an include resolving TO the repo root is already refused by the containment
  // check above (`isInside` excludes the root itself), so a guard here would be unreachable.
  if (rel === '(none)') {
    throw stop('--include resolves to the literal "(none)", which the provision record uses as its empty-list sentinel — rename the path before provisioning');
  }
};

// The shared series index must never reach a satellite — a machine-local copy silently diverges
// from what main and every other worktree are writing, which is the whole point of the
// read-only-at-the-absolute-path contract. `--include` is the one lane that could smuggle it in,
// by naming the file OR any directory that contains it. The compare runs in BOTH spaces: `incReal`
// is canonical, so a queue.md (or docs/plans) that is itself a symlink canonicalizes AWAY from the
// lexical queue path and would walk straight through a lexical-only compare while copying the very
// content the rule fences. Fail closed: ONLY an ABSENT queue path (ENOENT — nothing exists there
// to smuggle) falls back to the lexical compare alone; any other realpath failure (EACCES/EIO)
// means the canonical identity cannot be established, and a silent fallback would quietly disable
// the guard it exists to enforce.
const assertIncludeNeverCopiesTheQueue = ({ rootReal, incReal, inc, fs, contract = false }) => {
  // `contract` marks the WALK-TIME (point-of-use) call: its failures are include-identity
  // refusals and carry the door contract; the pre-mutation preflight call keeps the plain form.
  const withContract = (message) => stop(contract ? `${message}\n${INCLUDE_IDENTITY_RULE}` : message);
  const queueLexical = join(rootReal, PLANS_REL, QUEUE_BASENAME);
  const queuePaths = [queueLexical];
  try {
    queuePaths.push(fs.realpath(queueLexical));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw withContract(`--include: cannot resolve the shared series index path (${err?.code ?? 'error'}), so the queue-copy guard cannot establish its canonical identity: ${PLANS_REL}/${QUEUE_BASENAME} — fix the path (or drop the --include) and re-run`);
    }
  }
  for (const queuePath of queuePaths) {
    if (incReal === queuePath || isInside(incReal, queuePath)) {
      throw withContract(`--include would copy the SHARED series index (${PLANS_REL}/${QUEUE_BASENAME}) into the worktree: ${inc}. The index lives only in main and is read there — a local copy silently diverges.`);
    }
  }
};

const pendingHandoffFields = ({ root, slug, branch }) =>
  ({ slug, branch, includes: [], nodeModules: 'pending', vscode: 'pending', install: 'pending', ...orientationFields({ root, slug }) });

// The stub is written only when ABSENT; the final record surgically replaces the tool section.
const writeHandoffStubIfAbsent = ({ root, wtRoot, slug, branch, fs, report }) => {
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
  writeContainedFileAtomic(wtRoot, dst, composeHandoffStub(pendingHandoffFields({ root, slug, branch })), fs, { stop: (m) => stop(m) });
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

// The include set is resolved and identity-checked in runProvision — BEFORE `git worktree add` —
// against the queue-copy guard and the round-trip guard, and arrives here as {rel, real} pairs.
// It is copied from that already-canonical `real`, NEVER re-resolved from the raw path: a fresh
// realpath here (after the worktree exists) would re-open a TOCTOU where a swapped symlink could
// redirect an include at the shared series index between the check and the copy.
const provisionIncludes = ({ rootReal, wtRoot, includeSources, resume, git, fs, report, copied }) => {
  const recorded = [];
  const queuePath = join(rootReal, PLANS_REL, QUEUE_BASENAME);
  for (const { rel, real, identity } of includeSources) {
    // Defence in depth: re-assert the queue-copy prohibition on the canonical path at the POINT OF
    // USE, so it holds where the copy happens and not only where the path was first checked.
    assertIncludeNeverCopiesTheQueue({ rootReal, incReal: real, inc: rel, fs, contract: true });
    if (identity.kind === 'directory') {
      // The walk-start ROOT recheck (a recheck, not a binding — the child walk stays path-based;
      // a FILE root instead verifies its descriptor against the preflight identity at the door).
      const live = (() => {
        try {
          return fs.lstat(real);
        } catch (err) {
          throw includeIdentityStop(rel, `cannot re-probe the include root (${err?.code ?? 'fs error'})`);
        }
      })();
      if (!live.isDirectory() || live.dev !== identity.dev || live.ino !== identity.ino) {
        throw includeIdentityStop(rel, 'the include root is not the node preflight approved');
      }
    }
    const probeRel = identity.kind === 'directory' ? `${rel}/` : rel;
    if (!checkIgnored(git, probeRel, wtRoot)) {
      throw stop(
        `--include destination is not ignored in the worktree: ${rel} — it would become a land-preflight leftover. ` +
          'Recovery: ignore the path (shared exclude / .gitignore) or drop the --include.',
      );
    }
    // On a FRESH provision nothing may legitimately pre-populate an IGNORED include destination
    // (overlaps refuse pre-mutation; a tracked rel was just refused above), so an existing
    // destination root is filesystem aliasing the comparator missed — fail closed at the door.
    // `--resume` keeps the copy-if-missing kept-exit (the stated prior-run residual).
    if (!resume && lstatNoFollow(fs.lstat, join(wtRoot, rel)) !== null) {
      throw includeIdentityStop(rel, INCLUDE_PREEXIST_CAUSE);
    }
    const door = identity.kind === 'file'
      ? { identity, queuePath, fresh: !resume }
      : { queuePath, fresh: !resume };
    copyNode({ srcAbs: real, dstAbs: join(wtRoot, rel), wtRoot, rel, fs, report, copied, door });
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

// Exported and frozen so the closed sets are test-pinned in BOTH directions (a member can neither
// be dropped nor smuggled in without failing the pin).
export const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
// Workspace declarations this tool cannot read. Their presence makes the dependency inventory
// unknowable from package.json alone, so it is never proof.
export const EXTERNAL_WORKSPACE_MANIFESTS = Object.freeze(['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json']);

const readPackageJson = (fs, path) => {
  const file = readFileNoFollow(fs, path);
  if (!file.bytes) return null;
  try {
    const parsed = JSON.parse(String(file.bytes));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// A dependency field is read THREE ways, never two: 'has' (a non-empty plain object), 'none' (the
// field is absent, or an empty plain object), and 'unknown' for every other shape — a string, an
// array, null. A malformed manifest is evidence of NOTHING, so it must never read as "none".
const dependencyFieldsVerdict = (pkg) => {
  let verdict = 'none';
  for (const field of DEPENDENCY_FIELDS) {
    if (!Object.hasOwn(pkg, field)) continue;
    const value = pkg[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
    if (Object.keys(value).length > 0) verdict = 'has';
  }
  return verdict;
};

// A project with NO declared dependencies can still REQUIRE an install: a package-manager install
// runs the WHOLE install-lifecycle set — the npm set (including the deprecated `prepublish`, which
// historically fired on install) plus pnpm's `pnpm:devPreinstall` — so a manifest declaring any of
// them, ROOT or member, needs an install even with no dependencies. dependency-free is NOT
// install-free. The list is CLOSED and stated: a hook from a manager this tool has never heard of is
// the honest residual of a closed-world check, the same shape as EXTERNAL_WORKSPACE_MANIFESTS.
export const INSTALL_LIFECYCLE_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish', 'pnpm:devPreinstall']);
// Fail-closed like the dependency check: a `scripts` field of the wrong SHAPE, or a lifecycle key
// present with a NON-STRING value, is 'unknown' (never "no hook"). An empty-string value is a no-op,
// not a trigger; 'has' only when a lifecycle key holds a non-empty command string.
const installHookVerdict = (pkg) => {
  if (!Object.hasOwn(pkg, 'scripts')) return 'none';
  const scripts = pkg.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return 'unknown';
  let verdict = 'none';
  for (const name of INSTALL_LIFECYCLE_SCRIPTS) {
    if (!Object.hasOwn(scripts, name)) continue;
    if (typeof scripts[name] !== 'string') return 'unknown';
    if (scripts[name].length > 0) verdict = 'has';
  }
  return verdict;
};
// A native-addon manifest triggers an implicit `node-gyp rebuild` on install even with an empty
// scripts block, so its presence — root or member — is a mandatory install, never proof of none.
const declaresNativeBuild = (fs, dir) => lstatNoFollow(fs.lstat, join(dir, 'binding.gyp')) !== null;

// PROVABLY dependency-free, or nothing — read from the WORKTREE'S OWN LIVE CHECKOUT, never from
// MAIN's mutable working tree: the evidence is what an install run in THIS worktree would actually
// read. At provision time that is exactly HEAD; on --resume it follows the session's own edits, in
// both directions (gained dependencies revoke the proof, shed ones grant it) — the same live lane
// as the node_modules symlink probe. A dirty main manifest must neither grant nor revoke a verdict
// about content it does not describe. A `workspaces` field of ANY shape
// is UNKNOWN outright — a workspace install materializes member links and `.bin` shims even with
// zero dependencies, so a workspace tree is never provably install-free. Everything else the tool
// cannot enumerate — an absent/unparseable package.json, a malformed dependency or scripts field,
// an install-lifecycle script, a native-addon manifest (binding.gyp), an external workspace
// manifest — leaves the posture UNKNOWN, and unknown keeps the existing install advice: a false
// "nothing to install" is worse than a redundant hint.
const declaresNoDependencies = ({ wtRoot, fs }) => {
  const pkg = readPackageJson(fs, join(wtRoot, 'package.json'));
  if (pkg === null || dependencyFieldsVerdict(pkg) !== 'none' || installHookVerdict(pkg) !== 'none') return false;
  if (Object.hasOwn(pkg, 'workspaces')) return false;
  if (declaresNativeBuild(fs, wtRoot)) return false;
  // A workspace set can be declared OUTSIDE package.json too. The list is CLOSED and stated: an
  // exotic third manifest this tool has never heard of would still read as proof, which is the
  // honest residual of a closed-world check (the same shape as INSTALL_LIFECYCLE_SCRIPTS).
  for (const manifest of EXTERNAL_WORKSPACE_MANIFESTS) {
    if (lstatNoFollow(fs.lstat, join(wtRoot, manifest)) !== null) return false;
  }
  return true;
};

// What the RECORD states about installing — the resolved posture for THIS worktree (the runnable
// isolated-install command, or the honest by-hand advice), never a lane-dependent hint. Probed on
// the LIVE worktree after the node_modules step, and LIVE STATE WINS: a symlinked node_modules
// records the unlink-first form even on a dependency-free checkout (`--resume` can meet a symlink
// an earlier provision left — an install through it writes into MAIN, and the posture must never
// hide that). Only then may a PROVEN dependency-free checkout short-circuit: a verdict of
// "nothing to install" must not ride an install instruction.
const resolveInstallPosture = ({ root, wtRoot, dependencyFree, fs }) => {
  const nmPath = join(wtRoot, 'node_modules');
  const nm = lstatNoFollow(fs.lstat, nmPath);
  if (nm !== null && nm.isSymbolicLink()) {
    const advice = resolveInstallAdvice({ root, wtRoot, fs });
    const separator = advice.command === null ? ' — ' : ' && ';
    return `the provisioned node_modules is a symlink into MAIN (an install through it writes into MAIN) — for isolation remove it first: rm ${shellQuoteArg(nmPath)}${separator}${advice.instruction}`;
  }
  if (dependencyFree) return NO_DEPENDENCIES_POSTURE;
  return resolveInstallAdvice({ root, wtRoot, fs }).instruction;
};

const provisionNodeModules = ({ root, rootReal, wtRoot, installFlag, dependencyFree, git, fs, report }) => {
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
  // LIVE STATE WINS the whole default lane: a node already at the worktree — a directory, or a
  // symlink an earlier provision left, even dangling — is what the record states; reporting
  // MAIN's state (`absent`) beside an existing node would contradict record.install.
  const dst = join(wtRoot, 'node_modules');
  if (lstatNoFollow(fs.lstat, dst) !== null) {
    report.push('  node_modules: already present in the worktree');
    return 'present';
  }
  // Only then may a PROVEN dependency-free checkout short-circuit the rest. Composing the posture
  // into one of the arms below instead produced a self-contradicting line ("after your own
  // install there, re-run --resume, or: no install needed"). `--install` is untouched above —
  // that request was explicit.
  if (dependencyFree) {
    report.push(`  node_modules: ${NO_DEPENDENCIES_POSTURE}`);
    return NODE_MODULES_NONE;
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
  // Composing the record is the LAST step of provision, so a refusal there would leave a created
  // worktree with no handoff — which neither --resume nor `cleanup --abandon` can recover, because
  // both bind on the handoff identity. Every value the record will carry is therefore checked HERE,
  // before the first fs read and long before `git worktree add`.
  assertRecordValuesComposable({ root, slug, branch });
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
  // FROZEN before any git mutation and used for BOTH the overlap refusal below and the copy loop
  // in finishProvision — a re-computed set could admit a registry path that appeared after
  // preflight inside an include root and copy it through the doorless copy-if-missing lane.
  const provisionSet = provisionCopySet(root, deps);
  const provisionSetRels = provisionSet.map((pattern) => patternToProbe(pattern).replace(/\/$/, ''));
  const reservedRels = [
    ...provisionSetRels,
    `${PLANS_REL}/${seed.name}`,
    `${PLANS_REL}/${handoffBasename(slug)}`,
  ];
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
    assertIncludeNeverCopiesTheQueue({ rootReal, incReal, inc, fs });
    const rel = relative(rootReal, incReal);
    assertIncludeRoundTrips(rel);
    // Preflight identity (F3): {dev, ino, kind} of the canonical node, captured BEFORE any git
    // mutation. A root that is neither a regular file nor a directory, or an erroring probe,
    // refuses pre-mutation (a plain usage STOP — the door contract applies to the copy walk).
    const incNode = (() => {
      try {
        return fs.lstat(incReal);
      } catch (err) {
        throw stop(`--include: cannot establish the identity of ${inc} (${err?.code ?? 'fs error'}) — fix the path (or drop the --include) and re-run`);
      }
    })();
    const kind = incNode.isDirectory() ? 'directory' : incNode.isFile() ? 'file' : null;
    if (kind === null) throw stop(`--include must be a regular file or a directory: ${inc}`);
    // Overlap refusal (pre-mutation): an include rel that another provision lane also populates
    // (the frozen registry footprint, the seeded plan, the handoff) — or another include root —
    // would meet the copy-if-missing kept-exit and skip the identity door entirely.
    const reserved = reservedRels.find((r) => includeRelsOverlap(rel, r));
    if (reserved !== undefined) {
      throw stop(`--include overlaps a path provision itself populates (${reserved}): ${inc} — the footprint, the seeded plan, and the handoff are copied by provision; drop the --include`);
    }
    const clashing = includeSources.find((prior) => includeRelsOverlap(rel, prior.rel));
    if (clashing !== undefined) {
      throw stop(`--include roots overlap: ${clashing.rel} and ${rel} — name each copied path once`);
    }
    includeSources.push({ rel, real: incReal, identity: { dev: incNode.dev, ino: incNode.ino, kind } });
  }
  assertTargetOutsideSources({ targetReal, sources: [...sources, ...includeSources] });
  // The TARGET path reaches the record too — the `install` field embeds the worktree dir — and it
  // is only known here, after --dir/parentDir resolution. Validating it now keeps the whole record
  // composable BEFORE `git worktree add`, which is the point of every check above.
  recordValue('target-dir', targetReal);

  const probeDir = resolveProbeDir(dirname(targetReal), deps);
  // the probe itself is a create+delete write — on resume it runs only AFTER every identity check
  const runWritabilityProbe = () => {
    const probe = probeParentWritable(probeDir, deps);
    if (!probe.writable) {
      if (probe.cleanupFailed) throw probeCleanupStop(probe.cleanupFailed);
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
    return finishProvision({ root, rootReal, targetPath: targetReal, slug, branch, flags, seed, includeSources, provisionSet, git, deps, fs, report, log });
  } catch (err) {
    if (!flags.resume && err?.message) {
      err.message += `\nNOTE: the worktree at ${targetReal} (branch ${branch}) was created and KEPT — finish with: ${composeProvisionArgv({ root, slug, flags: { ...flags, resume: true } })} (or reclaim it with the consented cleanup).`;
    }
    throw err;
  }
};

const finishProvision = ({ root, rootReal, targetPath, slug, branch, flags, seed, includeSources, provisionSet, git, deps, fs, report, log }) => {
  writeHandoffStubIfAbsent({ root, wtRoot: targetPath, slug, branch, fs, report });

  const copied = new Set();
  report.push('copying the provision set (copy-if-missing; tracked files come from the checkout):');
  for (const pattern of provisionSet) {
    const rel = patternToProbe(pattern).replace(/\/$/, '');
    copyNode({ srcAbs: join(root, rel), dstAbs: join(targetPath, rel), wtRoot: targetPath, rel, fs, report, copied });
  }

  writeSeedPlan({ wtRoot: targetPath, srcAbs: seed.srcAbs, name: seed.name, fs, report });
  const includesRecorded = provisionIncludes({ rootReal, wtRoot: targetPath, includeSources, resume: flags.resume, git, fs, report, copied });
  // Computed ONCE, from the satellite's own checkout, and threaded to both consumers — the report
  // lane and the record must state the SAME verdict.
  const dependencyFree = declaresNoDependencies({ wtRoot: targetPath, fs });
  const nodeModulesMode = provisionNodeModules({ root, rootReal, wtRoot: targetPath, installFlag: flags.install, dependencyFree, git, fs, report });
  const vscodeMode = provisionVscode({ root, wtRoot: targetPath, slug, git, fs, report });

  rebasePins({ root, wtRoot: targetPath, git, fs, report });

  writeHandoffRecord({
    wtRoot: targetPath,
    slug,
    branch,
    fields: {
      slug,
      branch,
      includes: includesRecorded,
      nodeModules: nodeModulesMode,
      vscode: vscodeMode,
      install: resolveInstallPosture({ root, wtRoot: targetPath, dependencyFree, fs }),
      ...orientationFields({ root, slug }),
    },
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

// ── land + cleanup ────────────────────────────────────────────────────────────────────

const nulFields = (text) => String(text).split('\0').filter((field) => field !== '');

const gitRead = (git, args, cwd, label) => {
  const result = git(args, cwd);
  if (result.status !== 0) {
    throw stop(`${label}: ${(result.stderr || result.stdout).trim() || `git exited ${result.status}`}`);
  }
  return result;
};

// New git mutations cross one status-checking door; callers may add a narrower recovery message.
const gitMutation = (git, args, cwd, label) => gitRead(git, args, cwd, label);

const spawnChild = (deps, command, args, cwd) => {
  const spawn = deps.spawn ?? ((cmd, childArgs, options) => {
    const result = spawnSync(cmd, childArgs, {
      ...options, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER,
    });
    return {
      status: result.error ? -1 : result.status,
      stdout: result.stdout ?? '',
      stderr: result.error ? String(result.error.message) : (result.stderr ?? ''),
    };
  });
  return spawn(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER });
};

const childWords = (result) => [result.stdout, result.stderr]
  .map((part) => String(part ?? '').trim())
  .filter(Boolean)
  .join('\n');

const withPrepareLock = ({ commonDir, fs, now }, action) => {
  const path = join(commonDir, PREPARE_LOCK_BASENAME);
  try {
    fs.mkdirPlain(path);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw stop(`cannot acquire ${PREPARE_LOCK_BASENAME}: ${error?.code ?? 'fs error'}`);
    let age = 'unknown';
    try {
      const stat = fs.lstat(path);
      age = `${Math.max(0, Math.floor((now() - Number(stat.mtimeMs)) / 1000))}s`;
    } catch {
      // The lock still failed atomically; an unreadable age must not weaken the refusal.
    }
    throw stop(
      `${PREPARE_LOCK_BASENAME} is already held at ${path} (age ${age}). ` +
      `If no land/cleanup process owns it, remove ${path} by hand and retry.`,
    );
  }
  let result;
  let actionError = null;
  try {
    result = action();
  } catch (error) {
    actionError = error;
  }
  let releaseError = null;
  try {
    fs.rmdir(path);
  } catch (error) {
    releaseError = stop(`could not release ${PREPARE_LOCK_BASENAME} at ${path} (${error?.code ?? 'fs error'}) — remove it by hand`);
  }
  if (actionError && releaseError) throw composeFailure(actionError, 'lock release', releaseError);
  if (actionError) throw actionError;
  if (releaseError) throw releaseError;
  return result;
};

const branchNameOf = (entry) => entry.branch?.replace(/^refs\/heads\//, '') ?? null;

const findSatelliteEntry = ({ root, slug, branch, git, fs }) => {
  const entries = listWorktrees(git, root).slice(1);
  const exactHandoff = [];
  for (const entry of entries) {
    if (entry.prunable) continue;
    const scan = scanPlansDir({ wtRoot: entry.path, fs });
    if (scan.state === 'ok' && scan.handoffs.includes(handoffBasename(slug))) exactHandoff.push(entry);
  }
  if (exactHandoff.length > 1) {
    throw stop(`multiple worktrees carry ${handoffBasename(slug)} — cleanup the duplicate identity before continuing`);
  }
  if (branch !== null) {
    const byBranch = entries.filter((entry) => entry.branch === `refs/heads/${branch}`);
    if (byBranch.length > 1) throw stop(`multiple worktrees claim branch ${branch}`);
    if (byBranch.length === 1) return byBranch[0];
  }
  if (exactHandoff.length === 1) return exactHandoff[0];
  const fallback = entries.filter((entry) => entry.branch === `refs/heads/${DEFAULT_BRANCH_PREFIX}${slug}`);
  if (fallback.length === 1) return fallback[0];
  throw stop(`no registered satellite worktree for ${slug}`);
};

const readSatelliteIdentity = ({ entry, slug, expectedBranch, fs, abandon = false }) => {
  const name = handoffBasename(slug);
  const scan = scanPlansDir({ wtRoot: entry.path, fs });
  if (scan.state === 'ok' && scan.nonRegular.includes(name)) {
    throw stop(`handoff identity mismatch: ${name} is not a regular file`);
  }
  if (scan.state !== 'ok' || !scan.handoffs.includes(name)) {
    if (abandon) throw stop(`${name} is absent — force deletion is forbidden without the handoff identity`);
    throw stop(`handoff identity mismatch: expected ${name} in the satellite`);
  }
  if (scan.handoffs.length !== 1) {
    throw stop(`handoff identity mismatch: expected exactly ${name}, found [${scan.handoffs.join(', ')}]`);
  }
  const leaf = readFileNoFollow(fs, join(entry.path, PLANS_REL, name));
  if (!leaf.bytes) throw stop(`handoff identity mismatch: ${name} is not readable as a regular file`);
  const record = parseProvisionRecord(String(leaf.bytes));
  const liveBranch = branchNameOf(entry);
  const wantedBranch = expectedBranch ?? liveBranch;
  if (record.slug !== slug || record.branch !== wantedBranch || liveBranch !== wantedBranch) {
    throw stop(
      `handoff identity mismatch: expected slug ${slug} and branch ${wantedBranch}; ` +
      `record has slug ${record.slug ?? '(missing)'} and branch ${record.branch ?? '(missing)'}, live branch ${liveBranch ?? '(detached)'}`,
    );
  }
  return { record, path: join(entry.path, PLANS_REL, name), branch: wantedBranch };
};

const changedPaths = (git, args, cwd, label) =>
  nulFields(gitRead(git, [...args, '-z', '--', ...TRANSFER_EXCLUSIONS], cwd, label).stdout);

const literalPathspec = (path) => `:(literal)${path}`;

const untrackedPaths = (git, cwd) => nulFields(gitRead(
  git, ['ls-files', '--others', '--exclude-standard', '-z'], cwd, 'git ls-files failed',
).stdout);

const mainPorcelain = (git, cwd) => gitRead(
  git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, 'git status failed',
).stdout;

const classifyDivergence = ({ git, mainHead, satelliteHead, worktree }) => {
  if (mainHead === satelliteHead) return 'none';
  const satelliteBehind = git(['merge-base', '--is-ancestor', satelliteHead, mainHead], worktree);
  const satelliteAhead = git(['merge-base', '--is-ancestor', mainHead, satelliteHead], worktree);
  if (![0, 1].includes(satelliteBehind.status) || ![0, 1].includes(satelliteAhead.status)) {
    throw stop(`git merge-base failed: ${(satelliteBehind.stderr || satelliteAhead.stderr).trim()}`);
  }
  if (satelliteBehind.status === 0) return 'behind';
  if (satelliteAhead.status === 0) return 'local';
  return 'both';
};

const driftRecipe = ({ slug, satelliteHead, mainHead }) => [
  `satellite is behind main; old satellite HEAD rollback datum: ${satelliteHead}`,
  'Recover in the satellite:',
  '  git add -A',
  `  git diff --cached --binary --no-ext-diff --no-textconv --output=${PLANS_REL}/aw-rebase-${slug}.patch`,
  `  git reset --hard ${mainHead}`,
  `  git apply --index ${PLANS_REL}/aw-rebase-${slug}.patch`,
  'Delete the patch ONLY after apply succeeds; on failure the patch is KEPT, run:',
  `  git reset --hard ${satelliteHead}`,
  `  git apply --index ${PLANS_REL}/aw-rebase-${slug}.patch`,
  'Resolve conflicts in the satellite, then re-run its council.',
].join('\n');

const assertSatelliteReady = ({ slug, mainHead, satelliteHead, worktree, git }) => {
  const divergence = classifyDivergence({ git, mainHead, satelliteHead, worktree });
  if (divergence === 'local') {
    throw stop('satellite has local commits; cherry-pick the wanted commits at main, then retire or reset the satellite before land');
  }
  if (divergence === 'both') {
    throw stop(
      'satellite is both behind main and carries local commits. Recover commits first with cherry-pick, then repair the working diff:\n' +
      driftRecipe({ slug, satelliteHead, mainHead }),
    );
  }
  if (divergence === 'behind') throw stop(driftRecipe({ slug, satelliteHead, mainHead }));

  const docsAi = nulFields(gitRead(
    git, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'docs/ai'], worktree,
    'git status failed for docs/ai',
  ).stdout).map((entry) => entry.length > 3 ? entry.slice(3) : entry);
  if (docsAi.length > 0) {
    throw stop(
      `satellite docs/ai must stay byte-equal to HEAD; move durable content to the handoff and reset these paths:\n${docsAi.join('\n')}`,
    );
  }

  const stagedExcluded = nulFields(gitRead(
    git, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--', 'docs/ai', 'docs/plans'], worktree,
    'git diff failed for excluded paths',
  ).stdout);
  if (stagedExcluded.length > 0) {
    throw stop(
      `staged excluded path(s): ${stagedExcluded.join(', ')} — unstage them; their durable content belongs in the handoff`,
    );
  }

  const unstaged = nulFields(gitRead(
    git, ['diff', '--name-only', '--no-renames', '-z'], worktree, 'git diff failed for satellite leftovers',
  ).stdout);
  const untracked = untrackedPaths(git, worktree);
  const leftovers = [...new Set([...unstaged, ...untracked])];
  if (leftovers.length > 0) {
    throw stop(
      `satellite has unstaged or untracked-not-ignored leftovers; stage the complete working-tree diff before land:\n${leftovers.join('\n')}`,
    );
  }

  const staged = changedPaths(git, ['diff', '--cached', '--name-only', '--no-renames'], worktree, 'git diff failed');
  if (staged.length === 0) throw stop('satellite has an empty staged diff — there is nothing to prepare');
  return staged;
};

const runSatelliteReview = ({ worktree, deps }) => {
  const tool = join(WORKTREES_TOOL_DIR, 'review-state.mjs');
  const result = spawnChild(deps, process.execPath, [tool, '--check'], worktree);
  if (result.status !== 0) {
    throw stop(
      `satellite review-state is not green; finish the in-flight plan and council in the satellite before land.\n${childWords(result)}`,
    );
  }
};

const rollbackMain = ({ root, mainHead, git, fs }) => {
  const failures = [];
  let leftovers = [];
  try {
    leftovers = untrackedPaths(git, root);
  } catch (error) {
    failures.push(error);
  }
  for (const rel of leftovers) {
    try {
      const abs = join(root, rel);
      removeNodeNoFollow({ root, abs, fs, label: rel });
      removeEmptyParentsNoFollow({ root, abs, fs });
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    gitMutation(git, ['reset', '--hard', mainHead], root, 'git reset --hard rollback failed');
  } catch (error) {
    failures.push(error);
  }
  return failures;
};

const withRollbackFailures = (primary, rollback) =>
  rollback.reduce((error, failure) => composeFailure(error, 'rollback', failure), primary);

const withRollbackOnFailure = ({ root, mainHead, git, fs }, action) => {
  try {
    return action();
  } catch (error) {
    throw withRollbackFailures(error, rollbackMain({ root, mainHead, git, fs }));
  }
};

const applyTransfer = ({ root, commonDir, slug, patch, mainHead, git, fs }) => {
  const patchPath = join(commonDir, `aw-transfer-${slug}.patch`);
  writeContainedFileAtomic(commonDir, patchPath, patch, fs, { stop: (message) => stop(message) });
  let applyError = null;
  try {
    gitMutation(git, ['apply', '--index', patchPath], root, 'git apply --index failed');
  } catch (error) {
    applyError = error;
  }
  let cleanupError = null;
  try {
    removeNodeNoFollow({ root: commonDir, abs: patchPath, fs, label: patchPath });
  } catch (error) {
    cleanupError = error;
  }
  if (!applyError && !cleanupError) return;
  let primary = applyError ?? cleanupError;
  if (applyError && cleanupError) primary = composeFailure(applyError, 'patch cleanup', cleanupError);
  throw withRollbackFailures(primary, rollbackMain({ root, mainHead, git, fs }));
};

const runSyncAdapter = ({ root, mainHead, transferPaths, git, fs, deps, report }) => {
  const adapter = join(root, 'scripts/sync-mirrors.mjs');
  const node = classifyNodeNoFollow(adapter, fs);
  if (node.kind === 'absent') {
    report.push('sync adapter: absent — skipped');
    return [];
  }
  if (node.kind !== 'regular-file') throw stop('sync adapter is not a regular non-symlink file — refusing to execute it');
  const indexTreeBefore = gitRead(git, ['write-tree'], root, 'cannot snapshot the main index before sync').stdout.trim();
  const result = spawnChild(deps, process.execPath, [adapter], root);
  const { indexDelta, workingDelta } = withRollbackOnFailure({ root, mainHead, git, fs }, () => {
    const indexTreeAfter = gitRead(git, ['write-tree'], root, 'cannot snapshot the main index after sync').stdout.trim();
    return {
      indexDelta: indexTreeBefore === indexTreeAfter
        ? []
        : nulFields(gitRead(
            git, ['diff', '--name-only', '--no-renames', '-z', indexTreeBefore, indexTreeAfter], root,
            'git diff failed for the sync index delta',
          ).stdout),
      workingDelta: [...new Set([
        ...nulFields(gitRead(git, ['diff', '--name-only', '--no-renames', '-z'], root, 'git diff failed after sync').stdout),
        ...untrackedPaths(git, root),
      ])],
    };
  });
  if (result.status !== 0) {
    const output = childWords(result);
    const primary = stop('sync adapter failed');
    const composed = withRollbackFailures(primary, rollbackMain({ root, mainHead, git, fs }));
    if (composed !== primary) {
      if (output) composed.message += `\n${output}`;
      throw composed;
    }
    throw stop(`sync adapter failed; main was rolled back byte-clean.${output ? `\n${output}` : ''}`);
  }
  withRollbackOnFailure({ root, mainHead, git, fs }, () => {
    if (workingDelta.length > 0) {
      gitMutation(
        git, ['add', '-A', '--', ...workingDelta.map(literalPathspec)], root,
        'git add failed for the observed sync delta',
      );
    }
  });
  const delta = [...new Set([...indexDelta, ...workingDelta])];
  const overlap = delta.filter((path) => transferPaths.includes(path));
  if (overlap.length > 0) report.push(`mirror edit overwritten by canon sync: ${overlap.join(', ')}`);
  const output = childWords(result);
  if (output) report.push(output);
  return delta;
};

const recordPreparedTree = ({ identity, slug, entry, prepared, fs }) => {
  writeHandoffRecord({
    wtRoot: entry.path,
    slug,
    branch: identity.branch,
    fields: { ...identity.record, prepared },
    fs,
    report: [],
  });
};

const dirtyMainStop = ({ root, git, record, porcelain }) => {
  const tree = gitRead(git, ['write-tree'], root, 'git write-tree failed').stdout.trim();
  const leftovers = untrackedPaths(git, root);
  const treeMatchesRecord = record.prepared !== null && record.prepared === tree;
  const stagedDelta = treeMatchesRecord ? git(['diff', '--cached', '--quiet'], root) : null;
  if (stagedDelta !== null && ![0, 1].includes(stagedDelta.status)) {
    throw stop(`git diff --cached --quiet failed: ${(stagedDelta.stderr || stagedDelta.stdout).trim()}`);
  }
  const converged = treeMatchesRecord && (stagedDelta.status === 1 || stagedDelta.stdout !== '');
  const trackedEntries = parseStatusZ(porcelain).filter((entry) => !['??', '!!'].includes(entry.code));
  const trackedPaths = [...new Set(trackedEntries.flatMap((entry) => entry.paths))];
  const hasTrackedUnstaged = trackedEntries.some((entry) => entry.code[1] !== ' ');
  const mayReset = converged && !hasTrackedUnstaged;
  const classification = converged
    ? `converged re-run: current staged write-tree matches the previous prepare's recorded OID ${record.prepared}`
    : record.prepared === null
      ? 'foreign staged work: no previous prepare OID is recorded'
      : treeMatchesRecord
        ? `foreign staged work: the index has no staged delta against HEAD, although its write-tree matches the recorded OID ${record.prepared}`
      : `foreign staged work: current staged write-tree differs from the previous prepare's recorded OID ${record.prepared}`;
  const leftoversReport = leftovers.length === 0
    ? []
    : mayReset
      ? [
          'Then remove crash-residue untracked paths:',
          ...leftovers.map((path) => `  cd ${shellQuoteArg(root)} && rm -- ${shellQuoteArg(path)}`),
        ]
      : [
          'Untracked paths require manual review; no removal command is offered:',
          ...leftovers.map((path) => `  ${shellQuoteArg(path)}`),
        ];
  const trackedReport = trackedPaths.length === 0
    ? []
    : ['Tracked changes:', ...trackedPaths.map((path) => `  ${shellQuoteArg(path)}`)];
  throw stop([
    mayReset
      ? 'main is not clean; a second prepare is reset-only.'
      : 'main is not clean; land --prepare refuses to overwrite existing main changes.',
    `current staged write-tree: ${tree}`,
    classification,
    ...trackedReport,
    ...(mayReset ? ['Recover mechanically: git reset --hard'] : []),
    ...leftoversReport,
    `Re-run land from ${root} with --prepare.`,
  ].join('\n'));
};

export const runLand = ({ argvSlug, flags, cwd, git, deps, log }) => {
  const slug = validateSlug(argvSlug);
  if (!flags.prepare) throw usageStop('land requires --prepare');
  const fs = fsOf(deps);
  const { root, commonDir } = resolveRoots(cwd, git);

  return withPrepareLock({ commonDir, fs, now: deps.now ?? Date.now }, () => {
    const entry = findSatelliteEntry({ root, slug, branch: null, git, fs });
    if (entry.prunable) throw stop(`satellite ${slug} is prunable because its directory is gone — run cleanup ${slug}`);
    const identity = readSatelliteIdentity({ entry, slug, expectedBranch: null, fs });
    const porcelain = mainPorcelain(git, root);
    if (porcelain !== '') dirtyMainStop({ root, git, record: identity.record, porcelain });
    const mainHead = gitRead(git, ['rev-parse', 'HEAD'], root, 'cannot resolve main HEAD').stdout.trim();
    const satelliteHead = gitRead(git, ['rev-parse', 'HEAD'], entry.path, 'cannot resolve satellite HEAD').stdout.trim();
    const transferPaths = assertSatelliteReady({ slug, mainHead, satelliteHead, worktree: entry.path, git });
    runSatelliteReview({ worktree: entry.path, deps });

    const gates = classifyNodeNoFollow(join(root, 'docs/ai/gates.json'), fs);
    if (gates.kind === 'absent') throw stop('docs/ai/gates.json is absent — land cannot attest the prepared main tree');
    if (gates.kind !== 'regular-file') throw stop('docs/ai/gates.json is not a regular non-symlink file — land fails closed');

    const satelliteParent = dirname(entry.path);
    const probe = probeParentWritable(satelliteParent, deps);
    if (!probe.writable) {
      if (probe.cleanupFailed) throw probeCleanupStop(probe.cleanupFailed);
      throw landWritabilityStop({ parentDir: satelliteParent, root, slug });
    }

    const transferTree = gitRead(git, ['write-tree'], entry.path, 'cannot write the satellite transfer tree').stdout.trim();
    const patch = gitRead(
      git,
      ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--full-index', '--', ...TRANSFER_EXCLUSIONS],
      entry.path,
      'cannot create the satellite transfer diff',
    ).stdout;
    applyTransfer({ root, commonDir, slug, patch, mainHead, git, fs });

    const report = [];
    const syncDelta = runSyncAdapter({ root, mainHead, transferPaths, git, fs, deps, report });
    const preparedTree = gitRead(git, ['write-tree'], root, 'cannot write the prepared main tree').stdout.trim();
    try {
      recordPreparedTree({ identity, slug, entry, prepared: preparedTree, fs });
    } catch (error) {
      throw withRollbackFailures(error, rollbackMain({ root, mainHead, git, fs }));
    }

    const beforeGates = { head: mainHead, tree: preparedTree, porcelain: mainPorcelain(git, root) };
    const gateTool = join(WORKTREES_TOOL_DIR, 'run-gates.mjs');
    const gateResult = spawnChild(deps, process.execPath, [gateTool, '--cwd', root], root);
    const afterGates = {
      head: gitRead(git, ['rev-parse', 'HEAD'], root, 'cannot re-read main HEAD').stdout.trim(),
      tree: gitRead(git, ['write-tree'], root, 'cannot re-read the prepared tree').stdout.trim(),
      porcelain: mainPorcelain(git, root),
    };
    if (afterGates.head !== beforeGates.head || afterGates.tree !== beforeGates.tree || afterGates.porcelain !== beforeGates.porcelain) {
      throw stop(
        `main changed during gates; the post-gates snapshot no longer matches. ` +
        `Recover with git reset --hard ${mainHead}, fix the gate, and re-run land --prepare.`,
      );
    }
    if (gateResult.status !== 0) {
      throw stop([
        childWords(gateResult),
        'The prepared tree stays staged. Recover either by: reset main, fix in satellite, and re-land; or apply a maintainer-directed fix at main during primary re-attest.',
      ].filter(Boolean).join('\n'));
    }

    const gateOutput = childWords(gateResult);
    if (gateOutput) log(gateOutput);
    for (const line of report) log(line);
    log(`transfer paths: ${transferPaths.map(shellQuoteArg).join(', ')}`);
    log(`main HEAD: ${mainHead}`);
    log(`transfer: ${transferTree}`);
    log(`prepared: ${preparedTree}`);
    log(`sync delta: ${syncDelta.length === 0 ? 'none' : syncDelta.join(', ')}`);
    log('this tool did not commit — re-attest the landed diff, confirm main HEAD is unchanged, then ask before committing');
    return EXIT.ok;
  });
};

const parseStatusZ = (text) => {
  const fields = String(text).split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const paths = [field.slice(3)];
    if (code.includes('R') || code.includes('C')) paths.push(fields[index += 1]);
    entries.push({ code, paths: paths.filter(Boolean) });
  }
  return entries;
};

const indexEntry = (git, cwd, path) => {
  const fields = nulFields(gitRead(
    git, ['ls-files', '--stage', '-z', '--', literalPathspec(path)], cwd,
    `git ls-files failed for ${path}`,
  ).stdout);
  if (fields.length === 0) return null;
  if (fields.length !== 1) throw stop(`satellite index is conflicted at ${path}`);
  const match = fields[0].match(/^(\d+) ([0-9a-f]+) 0\t/);
  if (!match) throw stop(`cannot parse the satellite index entry for ${path}`);
  return { mode: match[1], oid: match[2] };
};

const headEntry = (git, cwd, head, path) => {
  const fields = nulFields(gitRead(
    git, ['ls-tree', '-z', head, '--', literalPathspec(path)], cwd,
    `git ls-tree failed for ${path}`,
  ).stdout);
  if (fields.length === 0) return null;
  const match = fields[0].match(/^(\d+) \w+ ([0-9a-f]+)\t/);
  if (!match) throw stop(`cannot parse the main HEAD entry for ${path}`);
  return { mode: match[1], oid: match[2] };
};

const registryRoots = () => {
  const roots = [];
  for (const pattern of [...KIT_OWN_PATHS, ...KNOWN_FOOTPRINT.map((entry) => entry.pattern)]) {
    const normalized = normalizeSlashes(pattern).replace(/^\//, '').replace(/\/$/, '');
    if (normalized) roots.push(normalized);
  }
  return roots;
};

const safeRecordedPath = (path) => {
  const normalized = normalizeSlashes(String(path)).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw stop(`handoff record carries an unsafe provision path: ${path}`);
  }
  return normalized;
};

const provisionKnownRoots = (identity) => {
  const roots = [
    ...registryRoots(),
    ...identity.record.includes.map(safeRecordedPath),
    PLANS_REL,
  ];
  if (identity.record.vscode === 'written') roots.push('.vscode/settings.json');
  return [...new Set(roots)];
};

const provisionKnownDirectoryRoots = ({ root, identity, fs }) => {
  const roots = [
    ...KIT_OWN_PATHS.filter(isDirPattern),
    ...KNOWN_FOOTPRINT.filter((entry) => entry.type === 'dir').map((entry) => entry.pattern),
    PLANS_REL,
  ].map((path) => normalizeSlashes(path).replace(/^\//, '').replace(/\/$/, ''));
  for (const include of identity.record.includes.map(safeRecordedPath)) {
    const kind = classifyNodeNoFollow(join(root, include), fs).kind;
    if (kind === 'plain-directory' || kind === 'symlink-to-directory') roots.push(include);
  }
  return new Set(roots);
};

const rootCoveringPath = (path, roots) => roots.find((root) => {
  if (root.includes('*')) {
    const expression = new RegExp(`^${root.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return expression.test(path);
  }
  return path === root || path.startsWith(`${root}/`);
}) ?? null;

const foreignIgnoredPaths = ({ root, git, identity, fs, exemptNodeModules = false }) => {
  const result = gitRead(
    git, ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'], root,
    'git status --ignored failed',
  );
  const seen = new Map();
  for (const entry of parseStatusZ(result.stdout)) {
    if (entry.code !== '!!') continue;
    for (const rawPath of entry.paths) {
      const normalized = normalizeSlashes(rawPath);
      const path = normalized.replace(/\/$/, '');
      // The ONE ownership exemption (AD-069): the gate has already proven this exact node an
      // ignored-lane matching symlink; it is neither re-probed nor reported here.
      if (exemptNodeModules && path === NODE_MODULES_REL) continue;
      const kind = classifyNodeNoFollow(join(root, path), fs).kind;
      const rootType = kind === 'plain-directory' || kind === 'symlink-to-directory'
        ? 'directory'
        : kind === 'regular-file' || kind === 'symlink-to-file'
          ? 'file'
          : kind === 'absent'
            ? (normalized.endsWith('/') ? 'directory' : 'file')
            : 'unknown';
      seen.set(path, rootType);
    }
  }
  const knownRoots = provisionKnownRoots(identity);
  const directoryRoots = provisionKnownDirectoryRoots({ root, identity, fs });
  return [...seen].filter(([path, rootType]) => {
    const known = rootCoveringPath(path, knownRoots);
    if (known === null) return true;
    const atRoot = known.includes('*') || path === known;
    if (atRoot && rootType !== (directoryRoots.has(known) ? 'directory' : 'file')) return true;
    return !atRoot && !directoryRoots.has(known);
  }).map(([path]) => path);
};

// ── the node_modules ownership gate (AD-069) ──────────────────────────────────────────────
// Class {absent, ephemeral, foreign} × lane {tracked, ignored, untracked}, decided live from
// exactly one no-follow lstat + (symlink only) one buffer-form readlink + the git lane probes.
// The record is never consulted; every probe error is FOREIGN fail-closed with no recovery
// command. The single exempt state — the ignored-lane matching link — is re-proven immediately
// before the irreversible worktree remove.

const NODE_MODULES_REL = 'node_modules';

const nodeModulesInspectStop = (nmPath, detail) => stop(
  `cleanup stopped: cannot inspect ${nmPath} (${detail})\n${CLEANUP_OWNERSHIP_RULE}`,
);

const nodeModulesSnapshot = ({ wtRoot, mainRoot, git, fs }) => {
  const nmPath = join(wtRoot, NODE_MODULES_REL);
  const node = (() => {
    try {
      return { stat: fs.lstat(nmPath) };
    } catch (error) {
      return error?.code === 'ENOENT' ? { stat: null } : { error: error?.code ?? 'fs error' };
    }
  })();
  if (node.error) throw nodeModulesInspectStop(nmPath, node.error);
  const trackedProbe = git(['ls-files', '--cached', '-z', '--', NODE_MODULES_REL], wtRoot);
  if (trackedProbe.status !== 0) {
    throw nodeModulesInspectStop(nmPath, `git ls-files failed: ${(trackedProbe.stderr || trackedProbe.stdout).trim()}`);
  }
  const tracked = trackedProbe.stdout.length > 0;
  if (node.stat === null) {
    return { klass: 'absent', kind: 'absent', lane: tracked ? 'tracked' : null, nmPath };
  }
  const lane = tracked ? 'tracked' : (() => {
    const probe = git(['check-ignore', '--', NODE_MODULES_REL], wtRoot);
    if (probe.status === 0) return 'ignored';
    if (probe.status === 1) return 'untracked';
    throw nodeModulesInspectStop(nmPath, `git check-ignore failed: ${(probe.stderr || probe.stdout).trim()}`);
  })();
  if (!node.stat.isSymbolicLink()) {
    const kind = node.stat.isDirectory() ? 'directory' : node.stat.isFile() ? 'file' : 'special';
    return { klass: 'foreign', kind, lane, nmPath };
  }
  const target = (() => {
    try {
      return { bytes: fs.readlink(nmPath, { encoding: 'buffer' }) };
    } catch (error) {
      return { error: error?.code ?? 'fs error' };
    }
  })();
  if (target.error) throw nodeModulesInspectStop(nmPath, target.error);
  // Raw BYTES against MAIN's node_modules path — never decoded, never resolved: a relative or
  // re-encoded form that merely RESOLVES to main stays foreign, and the target's kind is
  // irrelevant (unlink touches only the link).
  const matches = Buffer.compare(target.bytes, Buffer.from(join(mainRoot, NODE_MODULES_REL))) === 0;
  return { klass: matches ? 'ephemeral' : 'foreign', kind: 'symlink', lane, nmPath };
};

const nodeModulesExemptVerdict = (snapshot) => snapshot.klass === 'ephemeral' && snapshot.lane === 'ignored';

const composeNodeModulesStop = ({ snapshot, slug, branch, changed = false }) => {
  const { klass, kind, lane, nmPath } = snapshot;
  const kindDesc = kind === 'symlink'
    ? (klass === 'ephemeral' ? 'a main-matching symlink' : 'a foreign symlink')
    : kind === 'directory' ? 'a directory'
      : kind === 'file' ? 'a regular file'
        : kind === 'special' ? 'a special node' : 'absent';
  const head = `cleanup stopped: ${nmPath} is ${kindDesc} in the ${lane} lane`
    + `${changed ? ' (changed during cleanup)' : ''}\n${CLEANUP_OWNERSHIP_RULE}`;
  if (lane === 'tracked') {
    return stop([
      head,
      'this node_modules is tracked: removing it by hand only creates drift that stops cleanup earlier — land its removal from MAIN, then re-run cleanup',
      destructiveRecovery({ slug, branch }),
    ].join('\n'));
  }
  const removal = kind === 'directory' ? `rm -rf -- ${shellQuoteArg(nmPath)}` : `rm -- ${shellQuoteArg(nmPath)}`;
  return stop([
    head,
    `remove it yourself, then re-run cleanup: ${removal}`,
    destructiveRecovery({ slug, branch }),
  ].join('\n'));
};

const composeCleanupCommand = ({ slug, branch, abandon }) =>
  `cleanup ${shellQuoteArg(slug)}` +
  `${branch === `${DEFAULT_BRANCH_PREFIX}${slug}` ? '' : ` --branch ${shellQuoteArg(branch)}`}` +
  `${abandon ? ' --abandon' : ''}`;

const destructiveRecovery = ({ slug, branch }) =>
  `Destructive recovery requires: ${composeCleanupCommand({ slug, branch, abandon: true })}`;

const cleanupWritabilityStop = ({ parentDir, root, slug, branch, abandon }) => stop([
  `the worktrees parent dir is not writable from this session: ${parentDir}`,
  'Arm the ONE-TIME consent (then every provision/cleanup runs promptless):',
  `  .claude/settings.json → sandbox.filesystem.allowWrite += ${JSON.stringify(parentDir)}`,
  'Or run the full command yourself in a plain terminal:',
  `  ${composeOwnToolPrefix(root)} ${composeCleanupCommand({ slug, branch, abandon })}`,
].join('\n'));

const removeWorktree = ({ root, entry, branch, abandon, git }) => {
  const args = ['worktree', 'remove', ...(abandon ? ['--force'] : []), entry.path];
  try {
    gitMutation(git, args, root, 'git worktree remove failed');
  } catch (error) {
    if (/EBUSY|Device or resource busy/i.test(error.message)) {
      throw stop(
        `${error.message}\nLikely causes: lingering processes or open file descriptors (including a sandbox mount). ` +
        'Close them and retry cleanup outside the sandbox if needed.',
      );
    }
    throw error;
  }
  const deleteFlag = abandon ? '-D' : '-d';
  // Normal cleanup's divergence STOP makes -d sufficient; --abandon is explicitly destructive.
  gitMutation(git, ['branch', deleteFlag, branch], root, `git branch ${deleteFlag} failed`);
  gitMutation(git, ['worktree', 'prune'], root, 'git worktree prune failed');
};

export const runCleanup = ({ argvSlug, flags, cwd, git, deps, log }) => {
  const slug = validateSlug(argvSlug);
  const fs = fsOf(deps);
  const { root, commonDir } = resolveRoots(cwd, git);
  const branch = flags.branch ?? `${DEFAULT_BRANCH_PREFIX}${slug}`;

  return withPrepareLock({ commonDir, fs, now: deps.now ?? Date.now }, () => {
    const entry = findSatelliteEntry({ root, slug, branch, git, fs });
    if (entry.prunable) {
      gitMutation(git, ['worktree', 'prune'], root, 'git worktree prune failed');
      log(`[worktrees] pruned the registered deleted worktree for ${slug}`);
      return EXIT.ok;
    }
    const identity = readSatelliteIdentity({ entry, slug, expectedBranch: branch, fs, abandon: flags.abandon });
    if (flags.abandon) log('WARNING: cleanup --abandon DESTROYS unlanded work');

    const knownRoots = provisionKnownRoots(identity);
    let removalRoots = [];
    let nodeModulesExempt = false;
    if (!flags.abandon) {
      const mainHead = gitRead(git, ['rev-parse', 'HEAD'], root, 'cannot resolve main HEAD').stdout.trim();
      // Transfer verification excludes docs/ai and docs/plans; their tracked drift is checked separately before reset.
      const stagedPaths = changedPaths(
        git, ['diff', '--cached', '--name-only', '--no-renames', 'HEAD'], entry.path,
        'git diff failed for landed verification',
      );
      const unstagedPaths = changedPaths(
        git, ['diff', '--name-only', '--no-renames'], entry.path,
        'git diff failed for landed verification',
      );
      const excludedStagedPaths = nulFields(gitRead(
        git, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--', 'docs/ai', 'docs/plans'], entry.path,
        'git diff failed for excluded tracked paths',
      ).stdout);
      const excludedUnstagedPaths = nulFields(gitRead(
        git, ['diff', '--name-only', '--no-renames', '-z', '--', 'docs/ai', 'docs/plans'], entry.path,
        'git diff failed for excluded tracked paths',
      ).stdout);
      const mismatches = new Set([...unstagedPaths, ...excludedStagedPaths, ...excludedUnstagedPaths]);
      for (const path of stagedPaths) {
        const satellite = indexEntry(git, entry.path, path);
        const main = headEntry(git, root, mainHead, path);
        if (satellite?.mode !== main?.mode || satellite?.oid !== main?.oid) mismatches.add(path);
      }
      if (mismatches.size > 0) {
        const lines = [...mismatches].map(
          (path) => `${path}: differs — canon-overwritten at land OR changed after land; confirm via the handoff`,
        );
        throw stop(
          `unlanded or foreign work prevents cleanup:\n${lines.join('\n')}\n` +
          destructiveRecovery({ slug, branch }),
        );
      }

      if (identity.record.prepared === null) {
        throw stop(
          `nothing has been landed: the handoff prepared-tree OID is absent — ` +
          `${composeCleanupCommand({ slug, branch, abandon: true })} is required`,
        );
      }

      // The ownership gate (AD-069) runs BEFORE the inventories: it also catches tracked
      // node_modules and empty untracked directories git never lists. Clean-absent proceeds on
      // the legacy path with no post-reset ownership arm; the single exemption is re-proven
      // below, immediately before the irreversible remove.
      const ownership = nodeModulesSnapshot({ wtRoot: entry.path, mainRoot: root, git, fs });
      if (!nodeModulesExemptVerdict(ownership) && !(ownership.klass === 'absent' && ownership.lane !== 'tracked')) {
        throw composeNodeModulesStop({ snapshot: ownership, slug, branch });
      }
      nodeModulesExempt = nodeModulesExemptVerdict(ownership);

      const untracked = untrackedPaths(git, entry.path);
      const foreign = [];
      for (const path of untracked) {
        const known = rootCoveringPath(path, knownRoots);
        if (known === null) foreign.push(path);
        else removalRoots.push(known.includes('*') ? path : known);
      }
      if (foreign.length > 0) {
        throw stop(
          `unlanded or foreign work prevents cleanup:\n${foreign.join('\n')}\n` +
          destructiveRecovery({ slug, branch }),
        );
      }
      const foreignIgnored = foreignIgnoredPaths({ root: entry.path, git, identity, fs, exemptNodeModules: nodeModulesExempt });
      if (foreignIgnored.length > 0) {
        throw stop(`foreign ignored content requires --abandon:\n${foreignIgnored.join('\n')}`);
      }
    }

    const probe = probeParentWritable(dirname(entry.path), deps);
    if (!probe.writable) {
      if (probe.cleanupFailed) throw probeCleanupStop(probe.cleanupFailed);
      throw cleanupWritabilityStop({ parentDir: dirname(entry.path), root, slug, branch, abandon: flags.abandon });
    }

    if (!flags.abandon) {
      const satelliteHead = gitRead(git, ['rev-parse', 'HEAD'], entry.path, 'cannot resolve satellite HEAD').stdout.trim();
      gitMutation(git, ['reset', '--hard', satelliteHead], entry.path, 'git reset --hard failed before cleanup');
      removalRoots = [...new Set(removalRoots)].sort((a, b) => a.length - b.length)
        .filter((path, index, all) => !all.slice(0, index).some((parent) => path.startsWith(`${parent}/`)));
      for (const rel of removalRoots) {
        removeNodeNoFollow({ root: entry.path, abs: join(entry.path, rel), fs, label: rel });
      }
      if (nodeModulesExempt) {
        // The authoritative re-proof (AD-069): the verdict authorizing the irreversible remove
        // postdates the last tree-mutating operation. Strict equality with the exempt state —
        // never re-authorization: ANY deviation fails closed with no remove call.
        const revalidated = nodeModulesSnapshot({ wtRoot: entry.path, mainRoot: root, git, fs });
        if (!nodeModulesExemptVerdict(revalidated)) {
          if (revalidated.klass === 'absent' && revalidated.lane !== 'tracked') {
            throw stop(
              `cleanup stopped: ${revalidated.nmPath} changed during cleanup (now absent) — re-run cleanup\n${CLEANUP_OWNERSHIP_RULE}`,
            );
          }
          throw composeNodeModulesStop({ snapshot: revalidated, slug, branch, changed: true });
        }
      }
    }

    removeWorktree({ root, entry, branch, abandon: flags.abandon, git });
    log(`[worktrees] cleanup complete for ${slug}`);
    return EXIT.ok;
  });
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
    if (parsed.sub === 'land') {
      return runLand({ argvSlug: parsed.slug, flags: parsed.flags, cwd, git, deps, log });
    }
    return runCleanup({ argvSlug: parsed.slug, flags: parsed.flags, cwd, git, deps, log });
  } catch (err) {
    logError(`[worktrees] ${err.message}`);
    return err.exitCode ?? EXIT.stop;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
