// flow-store-read.mjs — the read half of the flow store (flow-orchestration, Plan 3 Phase 3):
// common-dir path resolution, the fail-closed reader, the race-free no-follow file read, and the
// canonical owning-worktree identity. This module OWNS no write API: the append surface and the
// lock/CAS stay behind flow-store.mjs (which imports and RE-EXPORTS everything here, so every
// existing consumer keeps its import site), and the procedures advisor imports ONLY this module.
// Honest boundary: the TRANSITIVE graph still reaches shared read/validate helpers hosted in
// mixed modules (flow-record → core-evidence → atomic-write) — an acknowledged residual, never a
// claimed purity; the full leaf-extraction is queued (FLOW-READ-GRAPH-PURITY).
//
// No CLI, no side effects on import, no fs WRITES of any kind. Dependency-free, Node >= 22.

import { readFileSync, lstatSync, openSync, closeSync, fstatSync, constants as fsConstants } from 'node:fs';
import { join, isAbsolute, normalize, basename, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateFlowRecord, authoritativeFlowRecords } from './flow-record.mjs';

export const FLOW_STORE_STOP = 'FLOW_STORE_STOP';
// The ONE typed-STOP factory for the store's read AND write halves (flow-store.mjs imports it).
export const flowStoreStop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'FlowStoreStop', code: FLOW_STORE_STOP });

export const FLOW_STORE_BASENAME = 'agent-workflow-flow.jsonl';
export const FLOW_LOCK_SUFFIX = '.lock';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitBuf = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};
export const gitLine = (args, cwd) => {
  const buf = gitBuf(args, cwd);
  return buf == null ? null : buf.toString('utf8').replace(/\r?\n$/, '');
};

// Local no-follow lstat (null ONLY on a true ENOENT) — deliberately NOT imported from
// atomic-write.mjs: that module also hosts the atomic WRITER, and this module OWNS no write API,
// so the tiny helper stays local rather than pulling that import in directly.
export const lstatNoFollowRead = (path, lstat = lstatSync) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// ── path resolution (common dir + the AW_FLOW_STORE producer seam) ────────────────────────────────

// resolveFlowStorePath(cwd, env) → the ABSOLUTE store path, or null outside a git WORK tree.
// is-inside-work-tree gates explicitly (--git-common-dir also succeeds in a bare repo, and the
// probe prints "false" WITH exit 0, so the STRING is compared). AW_FLOW_STORE must be absolute —
// a relative override would resolve a different store from each cwd.
export const resolveFlowStorePath = (cwd, env = process.env) => {
  if (env.AW_FLOW_STORE) {
    if (!isAbsolute(env.AW_FLOW_STORE)) {
      throw flowStoreStop(`AW_FLOW_STORE must be an ABSOLUTE path (got "${env.AW_FLOW_STORE}") — a relative override resolves a different store from each worktree/cwd (fail closed)`);
    }
    const normalized = normalize(env.AW_FLOW_STORE);
    // A trailing separator survives normalize() but not the appender's basename/join — refuse the fork.
    if (normalized.endsWith(sep) || normalized.endsWith('/')) {
      throw flowStoreStop(`AW_FLOW_STORE must not end with a path separator (got "${env.AW_FLOW_STORE}") — a store is a file, not a directory (fail closed)`);
    }
    return normalized;
  }
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const commonDir = gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDir == null ? null : join(commonDir, FLOW_STORE_BASENAME);
};

// The lock is a SIBLING derived from the resolved store path — one store, one lock, everywhere.
export const resolveFlowLockPath = (storePath) => `${storePath}${FLOW_LOCK_SUFFIX}`;

// ── the canonical owning-worktree identity (#49) ──────────────────────────────────────────────────

// STABLE and git-derived, never caller-supplied and never the raw path: the main tree is "main"
// (a repo-root relocation keeps it); a linked worktree is "worktree:<admin-dir name>" — the
// <common>/worktrees/<name> admin dir survives both a path-alias invocation (git canonicalizes)
// and `git worktree move` (the admin dir is not renamed), so relocation cannot silently turn an
// own open chain into foreign advisory. Null outside a git work tree.
export const deriveFlowOwner = (cwd) => {
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const gitDir = gitLine(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
  const commonDir = gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (gitDir == null || commonDir == null) return null;
  return gitDir === commonDir ? 'main' : `worktree:${basename(gitDir)}`;
};

// ── the fail-closed reader ────────────────────────────────────────────────────────────────────────

export const describeNonRegular = (st) =>
  st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'FIFO' : st.isDirectory() ? 'directory' : 'non-regular file';

// fatal: a lossy decode would fold invalid bytes to U+FFFD and silently fork a record's digest.
// ignoreBOM: a BOM must surface as malformed line 1, not vanish and get rewritten without it.
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hasOpenFlag = (v) => typeof v === 'number' && v !== 0;

// The ONE race-free read for store/lock bytes: open O_NOFOLLOW|O_NONBLOCK, fstat the DESCRIPTOR,
// read through it, decode fatally — a pathname swapped after the open cannot change what the fd
// reads. Without O_NONBLOCK (nonzero-integer check) it fails closed before any open — a FIFO open
// would block and no check helps a blocked syscall; without only O_NOFOLLOW it lstat-classifies
// first and binds the open to the observed {dev, ino}. Open failures outside ENOENT/ELOOP/EISDIR
// fall back to a classification-only lstat (no read ever follows a path-based check).
export const readRegularFileNoFollow = (path, io = {}) => {
  const consts = io.constants ?? fsConstants;
  const open = io.open ?? openSync;
  const fstat = io.fstat ?? fstatSync;
  const readFd = io.readFile ?? readFileSync;
  const close = io.close ?? closeSync;
  const lstat = io.lstat ?? lstatSync;
  if (!hasOpenFlag(consts.O_NONBLOCK)) {
    return { outcome: 'error', code: 'this platform exposes no usable O_NONBLOCK open flag — refusing to open (a FIFO would block forever; fail closed)' };
  }
  const noFollow = hasOpenFlag(consts.O_NOFOLLOW);
  let preStat = null;
  if (!noFollow) {
    try {
      preStat = lstatNoFollowRead(path, lstat);
    } catch (err) {
      return { outcome: 'error', code: (err && err.code) || (err && err.message) || 'lstat failed' };
    }
    if (preStat == null) return { outcome: 'absent' };
    if (!preStat.isFile()) return { outcome: 'foreign', className: describeNonRegular(preStat), isDirectory: preStat.isDirectory() };
  }
  let fd = null;
  try {
    fd = open(path, (consts.O_RDONLY ?? 0) | (noFollow ? consts.O_NOFOLLOW : 0) | consts.O_NONBLOCK);
    const st = fstat(fd);
    if (!st.isFile()) return { outcome: 'foreign', className: describeNonRegular(st), isDirectory: st.isDirectory() };
    if (preStat !== null && (st.dev !== preStat.dev || st.ino !== preStat.ino)) {
      return { outcome: 'error', code: 'the leaf changed identity between lstat and open (fail closed)' };
    }
    const bytes = readFd(fd);
    let content;
    try {
      content = typeof bytes === 'string' ? bytes : FATAL_UTF8.decode(bytes);
    } catch {
      return { outcome: 'error', code: 'invalid UTF-8 in the file (fail closed)' };
    }
    if (io.keepFd) {
      // While the caller holds this fd the inode cannot be recycled — a later pathname stat
      // matching {dev, ino} is proof of the same file.
      const heldFd = fd;
      fd = null;
      return { outcome: 'ok', content, dev: st.dev, ino: st.ino, nlink: st.nlink, fd: heldFd, bytes: typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes };
    }
    return { outcome: 'ok', content, dev: st.dev, ino: st.ino };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { outcome: 'absent' };
    if (err && err.code === 'ELOOP') return { outcome: 'foreign', className: 'symlink', isDirectory: false };
    if (err && err.code === 'EISDIR') return { outcome: 'foreign', className: 'directory', isDirectory: true };
    try {
      const st = lstatNoFollowRead(path, lstat);
      if (st && !st.isFile()) return { outcome: 'foreign', className: describeNonRegular(st), isDirectory: st.isDirectory() };
    } catch { /* the open error stays the surfaced one */ }
    return { outcome: 'error', code: (err && err.code) || (err && err.message) || 'read failed' };
  } finally {
    if (fd !== null) close(fd);
  }
};

// readFileBytesNoFollow(path, io?) → { outcome: 'ok', bytes } | absent | foreign | error — the
// BYTES twin of the reader above for consumers whose domain is byte offsets (the Phase-4
// receipt-deadline watermark, the finding-manifest digest domain): keepFd internally so the raw
// bytes come back, then the fd is closed HERE with a fail-closed close (a close failure becomes
// an error outcome, never a leak and never a swallowed throw). Balance: one open, one close, on
// every outcome — pinned by an injectable-io counting test.
export const readFileBytesNoFollow = (path, io = {}) => {
  const r = readRegularFileNoFollow(path, { ...io, keepFd: true });
  if (r.outcome !== 'ok') return r;
  let closeFailure = null;
  try {
    (io.close ?? closeSync)(r.fd);
  } catch (err) {
    closeFailure = (err && err.code) || (err && err.message) || 'close failed';
  }
  if (closeFailure !== null) return { outcome: 'error', code: `held-descriptor close failed (${closeFailure}) — fail closed` };
  return { outcome: 'ok', bytes: r.bytes };
};

// parseFlowStoreText(raw) → { records, authoritative, malformed, malformedReasons }. Both views on
// every result: `records` is RAW file order (the only view ordering checks may consume, #65),
// `authoritative` is the latest-per-key selection (#22).
export const parseFlowStoreText = (raw) => {
  const records = [];
  const malformedReasons = [];
  const lines = String(raw).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      malformedReasons.push(`line ${i + 1}: invalid JSON`);
      continue;
    }
    const v = validateFlowRecord(parsed);
    if (v.ok) records.push(parsed);
    else malformedReasons.push(`line ${i + 1}: ${v.reason}`);
  }
  return { records, authoritative: authoritativeFlowRecords(records), malformed: malformedReasons.length, malformedReasons };
};

// readFlowStore(path, io?) → { records, authoritative, malformed, malformedReasons, readError? }.
// Absent → empty (no records yet is not an error); any other failure → readError, and consumers
// fail closed on malformed > 0 or readError. A dangling symlink must NOT read as an empty store —
// that would be a fail-open for the checker.
export const readFlowStore = (path, io = {}) => {
  const empty = () => ({ records: [], authoritative: [], malformed: 0, malformedReasons: [] });
  const read = readRegularFileNoFollow(path, io);
  if (read.outcome === 'absent') return empty();
  if (read.outcome === 'foreign') return { ...empty(), readError: `the store is a ${read.className}, not a regular file — refusing to read it (fail closed)` };
  if (read.outcome === 'error') return { ...empty(), readError: read.code };
  return parseFlowStoreText(read.content);
};
