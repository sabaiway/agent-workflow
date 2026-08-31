// fs-read-nofollow.mjs — the race-free no-follow read primitive (flow-orchestration, Plan 4
// Phase 2). A LEAF: imports Node built-ins only, owns no write API, no CLI, no side effects on
// import — extracted from flow-store-read.mjs so consumers on BOTH sides of the flow-record →
// core-evidence import edge (the receipts reader lives in core-evidence) can share the ONE
// no-follow read without a cycle. flow-store-read.mjs re-exports everything here, so every
// existing consumer keeps its import site. Dependency-free, Node >= 22.

import { readFileSync, readSync, lstatSync, openSync, closeSync, fstatSync, constants as fsConstants } from 'node:fs';

// Local no-follow lstat (null ONLY on a true ENOENT).
export const lstatNoFollowRead = (path, lstat = lstatSync) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

export const describeNonRegular = (st) =>
  st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'FIFO' : st.isDirectory() ? 'directory' : 'non-regular file';

// fatal: a lossy decode would fold invalid bytes to U+FFFD and silently fork a record's digest.
// ignoreBOM: a BOM must surface as malformed line 1, not vanish and get rewritten without it.
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hasOpenFlag = (v) => typeof v === 'number' && v !== 0;
const errCode = (err) => (err && err.code) || (err && err.message) || null;
// The open failures with a NAME of their own (shared by both readers); null for every other.
const openFailure = (err) => {
  if (err && err.code === 'ENOENT') return { outcome: 'absent' };
  if (err && err.code === 'ELOOP') return { outcome: 'foreign', className: 'symlink', isDirectory: false };
  if (err && err.code === 'EISDIR') return { outcome: 'foreign', className: 'directory', isDirectory: true };
  return null;
};

// The ONE race-free read for store/lock bytes: open O_NOFOLLOW|O_NONBLOCK, fstat the DESCRIPTOR,
// read through it, decode fatally — a pathname swapped after the open cannot change what the fd
// reads. Without O_NONBLOCK (nonzero-integer check) it fails closed before any open — a FIFO open
// would block and no check helps a blocked syscall; without only O_NOFOLLOW it lstat-classifies
// first and binds the open to the observed {dev, ino}. Open failures outside ENOENT/ELOOP/EISDIR
// fall back to a classification-only lstat (no read ever follows a path-based check). A close
// failure on an OK read converts to outcome:error (the wrapper below — the bytes-twin discipline);
// a non-ok outcome keeps its own class and carries the failure as `closeFailure` (the lock
// holder's custody lane consumes it); consumers get a structured result, never a throw.
export const readRegularFileNoFollow = (path, io = {}) => {
  const closeBox = { failure: null };
  const r = readNoFollowCore(path, io, closeBox);
  if (closeBox.failure !== null) {
    if (r.outcome === 'ok') return { outcome: 'error', code: `descriptor close failed (${closeBox.failure}) — fail closed` };
    return { ...r, closeFailure: closeBox.failure };
  }
  return r;
};

const readNoFollowCore = (path, io, closeBox) => {
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
    const known = openFailure(err);
    if (known !== null) return known;
    try {
      const st = lstatNoFollowRead(path, lstat);
      if (st && !st.isFile()) return { outcome: 'foreign', className: describeNonRegular(st), isDirectory: st.isDirectory() };
    } catch { /* the open error stays the surfaced one */ }
    return { outcome: 'error', code: (err && err.code) || (err && err.message) || 'read failed' };
  } finally {
    if (fd !== null) {
      try {
        close(fd);
      } catch (err) {
        closeBox.failure = (err && err.code) || (err && err.message) || 'close failed';
      }
    }
  }
};

// readFileBytesNoFollowCapped(path, cap, io?) → ok { bytes } | over-cap { cap } | absent | foreign |
// error — the control-byte gate's read: open O_NOFOLLOW|O_NONBLOCK, fstat the DESCRIPTOR for its
// kind, read on it in bounded chunks until EOF or cap+1 bytes; the fstat SIZE is never consulted (a
// file growing after the fstat still refuses); no decode (a lone 0xE9 is ok bytes); no lstat fallback.
// ONE skeleton: no open without both flags; fstat the DESCRIPTOR; the body runs on a regular file only.
const READ_CHUNK = 64 * 1024;
const withRegularDescriptor = (path, io, body) => {
  const consts = io.constants ?? fsConstants;
  const open = io.open ?? openSync;
  const fstat = io.fstat ?? fstatSync;
  const close = io.close ?? closeSync;
  if (!hasOpenFlag(consts.O_NONBLOCK) || !hasOpenFlag(consts.O_NOFOLLOW)) {
    return { outcome: 'error', code: 'this platform exposes no usable O_NOFOLLOW|O_NONBLOCK open flags — refusing to open (fail closed)' };
  }
  let fd = null;
  let result;
  try {
    fd = open(path, (consts.O_RDONLY ?? 0) | consts.O_NOFOLLOW | consts.O_NONBLOCK);
    const st = fstat(fd);
    result = st.isFile() ? body(fd) : { outcome: 'foreign', className: describeNonRegular(st), isDirectory: st.isDirectory() };
  } catch (err) {
    result = openFailure(err) ?? { outcome: 'error', code: errCode(err) ?? 'read failed' };
  } finally {
    if (fd !== null) {
      try { close(fd); } catch (err) { result = { outcome: 'error', code: `descriptor close failed (${errCode(err) ?? 'close failed'}) — fail closed` }; }
    }
  }
  return result;
};
// probeRegularFileNoFollow(path, io?) → ok | absent | foreign | error: the kind check alone, no read.
export const probeRegularFileNoFollow = (path, io = {}) => withRegularDescriptor(path, io, () => ({ outcome: 'ok' }));
export const readFileBytesNoFollowCapped = (path, cap, io = {}) => withRegularDescriptor(path, io, (fd) => {
  const read = io.read ?? readSync;
  const chunks = [];
  let total = 0;
  while (total <= cap) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, cap + 1 - total));
    const n = read(fd, chunk, 0, chunk.length, null);
    if (n === 0) break;
    chunks.push(chunk.subarray(0, n));
    total += n;
  }
  return total > cap ? { outcome: 'over-cap', cap } : { outcome: 'ok', bytes: Buffer.concat(chunks, total) };
});

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
