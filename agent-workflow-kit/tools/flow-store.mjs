// flow-store.mjs — the flow-store IO (flow-orchestration, Phase 2): common-dir path resolution, the
// fail-closed reader, and the lock/CAS serialized append. No CLI, no side effects on import.
//
// The store pins to the git COMMON dir because flow records must be shared across worktrees
// (#49/#57), which the per-git-dir core store cannot do; appends are serialized by an exclusive-
// create lock file beside the store because the reusable atomic writer is last-writer-wins with no
// cross-process lock. Everything fails closed: bounded lock waits with named refusals per holder
// class, custody-checked release (only the inode the winning CAS fd proved is ever removed),
// fd-based no-follow reads, and a SEMANTIC append preflight on one captured snapshot (per-record
// validation, malformed-store refusal, replay refusal, chain-sequence and supersession legality) —
// an illegal record never lands.
//
// Phase 3 adds the mint primitives that need the tree: the adoption mint (frontmatter planId +
// plan content digest, #58), the canonical owning-worktree identity (#49), the generic reference
// validator + prior-terminal resolution in the append preflight (#63), and the bookkeeping-delta
// custody proof (masked revert-and-recompute, #60).
//
// Declared residuals no dependency-free core-Node mechanism can close: the pathname lstat→rename
// and reread→rename windows (no flock/fcntl, no inode-conditional unlink or rename) and bind-mount
// aliasing. Plan-3 scope lives with flow-check composition: decideCheck arms, guard/gates wiring,
// the park/resume/complete writer CLI. Records remain forgeable — a self-discipline mechanism in
// the git dir, not a security boundary.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, writeSync, readSync, rmSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, renameSync, readlinkSync, constants as fsConstants } from 'node:fs';
import { join, dirname, basename, isAbsolute, normalize, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeContainedFileAtomic, lstatNoFollow } from './atomic-write.mjs';
import { parsePositiveIntKnob } from './changed-surface.mjs';
import { FLOW_SCHEMA_VERSION, CHAIN_KIND, validateFlowRecord, validateChainSequence, validateSupersessions, authoritativeFlowRecords, canonicalFlowDigest } from './flow-record.mjs';
import { isNeverCommittableStat, isBinaryFile, lexicalRepoRelative, resolveBase, computeTreeFingerprint } from './core-evidence.mjs';

export const FLOW_STORE_STOP = 'FLOW_STORE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'FlowStoreStop', code: FLOW_STORE_STOP });

export const FLOW_STORE_BASENAME = 'agent-workflow-flow.jsonl';
export const FLOW_LOCK_SUFFIX = '.lock';

// Wait bound + poll cadence; the env knobs keep hermetic tests off wall-clock.
export const FLOW_LOCK_WAIT_MS = 10_000;
export const FLOW_LOCK_POLL_MS = 100;

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitBuf = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};
const gitLine = (args, cwd) => {
  const buf = gitBuf(args, cwd);
  return buf == null ? null : buf.toString('utf8').replace(/\r?\n$/, '');
};
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ── path resolution (common dir + the AW_FLOW_STORE producer seam) ────────────────────────────────

// resolveFlowStorePath(cwd, env) → the ABSOLUTE store path, or null outside a git WORK tree.
// is-inside-work-tree gates explicitly (--git-common-dir also succeeds in a bare repo, and the
// probe prints "false" WITH exit 0, so the STRING is compared). AW_FLOW_STORE must be absolute —
// a relative override would resolve a different store from each cwd.
export const resolveFlowStorePath = (cwd, env = process.env) => {
  if (env.AW_FLOW_STORE) {
    if (!isAbsolute(env.AW_FLOW_STORE)) {
      throw stop(`AW_FLOW_STORE must be an ABSOLUTE path (got "${env.AW_FLOW_STORE}") — a relative override resolves a different store from each worktree/cwd (fail closed)`);
    }
    const normalized = normalize(env.AW_FLOW_STORE);
    // A trailing separator survives normalize() but not the appender's basename/join — refuse the fork.
    if (normalized.endsWith(sep) || normalized.endsWith('/')) {
      throw stop(`AW_FLOW_STORE must not end with a path separator (got "${env.AW_FLOW_STORE}") — a store is a file, not a directory (fail closed)`);
    }
    return normalized;
  }
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const commonDir = gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDir == null ? null : join(commonDir, FLOW_STORE_BASENAME);
};

// The lock is a SIBLING derived from the resolved store path — one store, one lock, everywhere.
export const resolveFlowLockPath = (storePath) => `${storePath}${FLOW_LOCK_SUFFIX}`;

// ── the fail-closed reader ────────────────────────────────────────────────────────────────────────

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

// ── the lock/CAS ──────────────────────────────────────────────────────────────────────────────────

// Sync sleep (the append is a sync flow end-to-end); injectable so a hermetic test can intercept it.
const sleepSyncMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Monotonic — a system clock stepped backwards must not stretch the wait bound.
const monotonicNowMs = () => performance.now();

// POSIX single-quoting for paths pasted into recovery commands — a raw interpolation would execute
// path bytes on paste.
const shellQuotePath = (p) => `'${p.replaceAll("'", "'\\''")}'`;

const describeNonRegular = (st) =>
  st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'FIFO' : st.isDirectory() ? 'directory' : 'non-regular file';

const foreignObjectStop = (noun, path, className, isDirectory) =>
  stop(`the ${noun} ${path} is a ${className}, not a regular file — refusing to touch it. To recover: inspect it, then remove it by hand: ${isDirectory ? 'rmdir' : 'rm'} -- ${shellQuotePath(path)} — it is never removed silently (fail closed)`);

// A non-regular object at the store or lock path is never read (a FIFO read blocks forever) and
// never removed silently — an immediate named refusal. Returns the lstat result (null = absent).
const assertRegularOrAbsent = (path, noun, lstat) => {
  const st = lstatNoFollow(path, lstat);
  if (st && !st.isFile()) throw foreignObjectStop(noun, path, describeNonRegular(st), st.isDirectory());
  return st;
};

// Bounded positional comparison of a HELD fd against the snapshot: at most snapshot-length bytes
// plus ONE growth-probe byte (positional — the fd offset sits at EOF). Changed bytes, truncation,
// or growth report false.
const READ_CHUNK_BYTES = 65536;
const fdContentEquals = (fd, expected) => {
  const buf = Buffer.alloc(READ_CHUNK_BYTES);
  let position = 0;
  while (position < expected.length) {
    const want = Math.min(buf.length, expected.length - position);
    const n = readSync(fd, buf, 0, want, position);
    if (n === 0) return false; // truncated below the snapshot length
    if (!buf.subarray(0, n).equals(expected.subarray(position, position + n))) return false;
    position += n;
  }
  return readSync(fd, buf, 0, 1, position) === 0; // any byte here means the store GREW
};

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
const readRegularFileNoFollow = (path, io = {}) => {
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
      preStat = lstatNoFollow(path, lstat);
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
      const st = lstatNoFollow(path, lstat);
      if (st && !st.isFile()) return { outcome: 'foreign', className: describeNonRegular(st), isDirectory: st.isDirectory() };
    } catch { /* the open error stays the surfaced one */ }
    return { outcome: 'error', code: (err && err.code) || (err && err.message) || 'read failed' };
  } finally {
    if (fd !== null) close(fd);
  }
};

// Trusted only with parsed, valid metadata; anything else is the crash/corruption lane — never
// probed, never stolen.
const isValidHolder = (holder) =>
  holder !== null && typeof holder === 'object' && !Array.isArray(holder)
  && Number.isInteger(holder.pid) && holder.pid > 0
  && typeof holder.host === 'string' && holder.host.length > 0;

const describeHolder = (holder) => `pid ${holder.pid} (host ${holder.host}, started ${holder.startedAt ?? 'unknown'})`;

// ESRCH on a same-host signal-0 probe only; a foreign host is unprobeable — never treated as dead.
const isProvablyDead = (holder) => {
  if (holder.host !== hostname()) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (err) {
    return err && err.code === 'ESRCH';
  }
};

// The shared parser accepts any digit string — hundreds of digits parse to Infinity and would
// erase the wait bound; gated locally because the shared helper feeds the frozen core-evidence.
const parseLockKnob = (env, name, fallback) => {
  const value = parsePositiveIntKnob(env, name, fallback, stop);
  if (!Number.isSafeInteger(value)) {
    throw stop(`${name} must be a positive safe integer — the provided value overflows (fail closed)`);
  }
  return value;
};

// Containment + canonical pinning, once per append: a symlinked IMMEDIATE parent refuses by name;
// the ancestor chain is then realpath-rebased so every spelling funnels to ONE physical store+lock
// pair (refusing ancestor links would break legitimately symlinked prefixes like a distro /home).
// realpath ENOENT keeps the lexical path — a missing parent still refuses at lock creation.
const canonicalFlowWritePaths = (resolvedStorePath, lstat) => {
  const parent = dirname(resolvedStorePath);
  if (lstatNoFollow(parent, lstat)?.isSymbolicLink()) {
    throw stop(`${parent} is a symlink — refusing to write the flow store through a symlinked parent (pre-mutation containment)`);
  }
  let canonicalParent;
  try {
    canonicalParent = realpathSync(parent);
  } catch (err) {
    if (err && err.code === 'ENOENT') canonicalParent = parent;
    else throw stop(`cannot canonicalize the flow-store parent dir ${parent} (${(err && err.code) || (err && err.message) || err}) — refusing to write through an unresolvable path (fail closed)`);
  }
  const storePath = join(canonicalParent, basename(resolvedStorePath));
  const lockPath = resolveFlowLockPath(storePath);
  assertRegularOrAbsent(storePath, 'flow store', lstat);
  assertRegularOrAbsent(lockPath, 'flow-store lock', lstat);
  return { storePath, lockPath };
};

// Returns the OWNED canonical { storePath, lockPath, lockFd, lockIdentity }; throws BEFORE
// ownership on every refusal lane. The caller must reuse exactly these values end-to-end.
const acquireFlowLock = (resolvedStorePath, env, deps) => {
  const lstat = deps.lstat ?? lstatSync;
  const openLock = deps.openLock ?? ((p) => openSync(p, 'wx'));
  const sleep = deps.sleep ?? sleepSyncMs;
  const now = deps.now ?? monotonicNowMs;
  const waitBoundMs = parseLockKnob(env, 'AW_FLOW_LOCK_WAIT_MS', FLOW_LOCK_WAIT_MS);
  const pollMs = parseLockKnob(env, 'AW_FLOW_LOCK_POLL_MS', FLOW_LOCK_POLL_MS);
  const { storePath, lockPath } = canonicalFlowWritePaths(resolvedStorePath, lstat);
  const holderBody = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
  const deadline = now() + waitBoundMs;
  // Every retry lane passes this gate — else lock churn extends the wait past the bound forever.
  const refuseIfPastDeadline = (why) => {
    if (now() >= deadline) {
      throw stop(`the flow-store lock ${lockPath} could not be acquired within the ${waitBoundMs}ms wait (${why}) — retry, or raise AW_FLOW_LOCK_WAIT_MS`);
    }
  };
  for (;;) {
    // CAS: exclusive-create ('wx' also refuses a symlink leaf); the winning fd stamps the holder
    // and yields the lock's {dev, ino} — a pathname stat could already see a replacement.
    let fd = null;
    try {
      fd = openLock(lockPath);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw stop(`cannot create the flow-store lock ${lockPath} (${(err && err.code) || (err && err.message) || err}) — the store's parent dir must exist and be writable`);
      }
    }
    if (fd !== null) {
      let won = false;
      try {
        writeSync(fd, holderBody);
        const st = fstatSync(fd);
        won = true;
        // The fd stays open through the whole append — its inode cannot be recycled under us.
        return { storePath, lockPath, lockFd: fd, lockIdentity: { dev: st.dev, ino: st.ino } };
      } catch (err) {
        // Without the fd-proven identity, removing the pathname would be an unproven-ownership rm.
        throw stop(`cannot stamp or verify the just-created flow-store lock ${lockPath} (${(err && err.code) || (err && err.message) || err}) — the lock file is left in place; inspect it, then remove it by hand: rm -- ${shellQuotePath(lockPath)} (fail closed)`);
      } finally {
        if (!won) { try { closeSync(fd); } catch { /* the stamp failure above already decided the lane */ } }
      }
    }
    const holderRead = readRegularFileNoFollow(lockPath);
    if (holderRead.outcome === 'absent') {
      refuseIfPastDeadline('the lock kept appearing and vanishing (churn)');
      continue; // released between attempts — retry the CAS at once
    }
    if (holderRead.outcome === 'foreign') throw foreignObjectStop('flow-store lock', lockPath, holderRead.className, holderRead.isDirectory);
    let holder = null;
    if (holderRead.outcome === 'ok') {
      try {
        holder = JSON.parse(holderRead.content);
      } catch { holder = null; }
    }
    const validHolder = isValidHolder(holder);
    if (validHolder && isProvablyDead(holder)) {
      // The DEAD verdict binds to the inode the holder was read from — a lock released or replaced
      // since then means the observed holder is gone: retry, never refuse a vanished lock.
      let lockNow = null;
      try {
        lockNow = lstatNoFollow(lockPath, lstat); // null ONLY on a true ENOENT
      } catch (err) {
        throw stop(`cannot re-verify the flow-store lock identity before the DEAD refusal (${(err && err.code) || (err && err.message) || err}) — refusing to guess (fail closed)`);
      }
      if (lockNow == null || lockNow.dev !== holderRead.dev || lockNow.ino !== holderRead.ino) {
        refuseIfPastDeadline('the observed dead holder was released (churn)');
        continue;
      }
      throw stop(`the flow-store lock ${lockPath} is held by a DEAD process (${describeHolder(holder)}) — a crashed appender left it behind. To recover: inspect it, then remove it by hand: rm -- ${shellQuotePath(lockPath)} — it is never stolen silently (a steal could tear a live append; fail closed)`);
    }
    // ONE observation drives the deadline check AND the sleep cap — no overshoot by a full poll.
    const observedAt = now();
    if (observedAt >= deadline) {
      if (!validHolder) {
        throw stop(`the flow-store lock ${lockPath} carries an UNREADABLE or malformed holder after the full ${waitBoundMs}ms wait — a crashed appender may have died before writing its holder line, or the file is corrupted. To recover: inspect it, then remove it by hand: rm -- ${shellQuotePath(lockPath)} — it is never stolen silently (fail closed)`);
      }
      if (holder.host !== hostname()) {
        throw stop(`the flow-store lock ${lockPath} is still held by pid ${holder.pid} on host ${holder.host} (liveness unprobeable from ${hostname()}) after the full ${waitBoundMs}ms wait — retry after that holder finishes, or raise AW_FLOW_LOCK_WAIT_MS`);
      }
      throw stop(`the flow-store lock ${lockPath} is still held by ${describeHolder(holder)} after the full ${waitBoundMs}ms wait — retry after the holder finishes, or raise AW_FLOW_LOCK_WAIT_MS`);
    }
    sleep(Math.min(pollMs, deadline - observedAt));
  }
};

// ── the ONE append (validated, semantic-preflighted, lock-serialized, atomic) ─────────────────────

// ONE custody-checked release: only the inode the winning fd proved is ever removed (the fd is
// still open, so a pathname {dev, ino} match is proof of the same file); absent or replaced =
// a mutual-exclusion violation, the foreign lock stays. Closes the fd on EVERY outcome without
// losing a close failure. Returns a typed STOP or null, never throws — the caller sequences it
// after the body's own error so neither masks the other.
const releaseFlowLock = (lockPath, lockFd, lockIdentity, deps) => {
  const lstat = deps.lstat ?? lstatSync;
  const rm = deps.rm ?? ((p) => rmSync(p, { force: true }));
  const close = deps.close ?? closeSync;
  let issue = null;
  let st = null;
  try {
    st = lstatNoFollow(lockPath, lstat); // null ONLY on a true ENOENT
  } catch (err) {
    issue = stop(`cannot verify the flow-store lock before release (${(err && err.code) || (err && err.message) || err}) — the lock is left in place; inspect ${lockPath} (fail closed)`);
  }
  if (issue == null) {
    if (st == null || st.dev !== lockIdentity.dev || st.ino !== lockIdentity.ino) {
      issue = stop(`the flow-store lock ${lockPath} was removed or replaced under this append — mutual exclusion was violated and another appender may have run concurrently; the current lock (if any) is left untouched; inspect the store and the lock (fail closed)`);
    } else {
      try {
        rm(lockPath);
      } catch (err) {
        issue = stop(`cannot remove the flow-store lock at release (${(err && err.code) || (err && err.message) || err}) — inspect ${lockPath} (fail closed)`);
      }
    }
  }
  try {
    close(lockFd);
  } catch (err) {
    const closeStop = stop(`cannot close the flow-store lock descriptor at release (${(err && err.code) || (err && err.message) || err})`);
    if (issue == null) issue = closeStop;
    else issue.closeFailure = closeStop.message;
  }
  return issue;
};

// The store path is always RESOLVED (cwd/env), never caller-supplied — a raw path param would
// bypass the absolute-normalization door the AW_FLOW_STORE seam enforces. Read, write, and unlock
// all use the CANONICAL pair acquire returned — nothing is re-derived mid-append.
export const appendFlowRecord = ({ cwd = process.cwd(), record, env = process.env, deps = {} } = {}) => {
  const resolved = resolveFlowStorePath(cwd, env);
  if (resolved == null) {
    throw stop('not inside a git work tree (and no AW_FLOW_STORE override) — there is no flow store to append to');
  }
  // ONE serialization captured up front; validation and every preflight walk run on its PARSED
  // snapshot — a toJSON or getter can never make the written line differ from what validated.
  let line;
  let snapshot;
  try {
    line = JSON.stringify(record);
    snapshot = JSON.parse(line);
  } catch (err) {
    throw stop(`cannot capture a canonical serialization of the record (${(err && err.message) || err}) — refusing to write (fail closed)`);
  }
  const v = validateFlowRecord(snapshot);
  if (!v.ok) throw stop(`refusing to write a malformed flow record: ${v.reason}`);
  const { storePath, lockPath, lockFd, lockIdentity } = acquireFlowLock(resolved, env, deps);
  const body = appendUnderLock({ storePath, line, snapshot, deps });
  const releaseIssue = releaseFlowLock(lockPath, lockFd, lockIdentity, deps);
  if (body.err) {
    if (releaseIssue) {
      body.err.releaseViolation = releaseIssue.message;
      if (releaseIssue.closeFailure) body.err.releaseCloseFailure = releaseIssue.closeFailure;
    }
    throw body.err;
  }
  if (releaseIssue) throw releaseIssue;
  return body.value;
};

// Captured-result shape ({ value } | { err }) — never throws past the caller, so release always
// runs. The snapshot fd is held until after the final rename and closed on every exit lane.
const appendUnderLock = ({ storePath, line, snapshot, deps }) => {
  let snapshotFd = null;
  try {
    const storeRead = readRegularFileNoFollow(storePath, { keepFd: true });
    if (storeRead.outcome === 'ok') snapshotFd = storeRead.fd;
    if (storeRead.outcome === 'foreign') throw foreignObjectStop('flow store', storePath, storeRead.className, storeRead.isDirectory);
    if (storeRead.outcome === 'error') throw stop(`cannot read the flow store before appending (${storeRead.code}) — refusing to overwrite it (fail closed)`);
    // A second hard-link path would derive its OWN lock and the two appends would race one inode.
    if (storeRead.outcome === 'ok' && storeRead.nlink !== 1) {
      throw stop(`the flow store ${storePath} has ${storeRead.nlink} hard links — two path-derived locks would race one inode; remove the extra links and retry (fail closed)`);
    }
    const existing = storeRead.outcome === 'absent' ? '' : storeRead.content;
    const parsed = parseFlowStoreText(existing);
    if (parsed.malformed > 0) {
      throw stop(`refusing to append to a flow store carrying ${parsed.malformed} malformed line(s) (${parsed.malformedReasons[0]}) — inspect ${storePath}; nothing was written (fail closed)`);
    }
    if (existing.split('\n').some((l) => l === line)) {
      throw stop('refusing a byte-identical replayed line (duplicate) — a genuine new record carries new content or timestamp; nothing was written');
    }
    if (snapshot.kind === CHAIN_KIND) {
      const chain = parsed.records.filter((r) => r.kind === CHAIN_KIND && r.planId === snapshot.planId);
      const existingSeq = validateChainSequence(chain);
      if (!existingSeq.ok) {
        throw stop(`refusing to append to a flow store whose existing chain for plan "${snapshot.planId}" is already illegal (${existingSeq.reason}) — inspect ${storePath}; nothing was written (fail closed)`);
      }
      const candidateSeq = validateChainSequence([...chain, snapshot]);
      if (!candidateSeq.ok) {
        throw stop(`refusing an illegal chain record: ${candidateSeq.reason} — the append-only store never absorbs a record that permanently reddens the checker; nothing was written`);
      }
      // Reference RESOLUTION (#63) on top of the structural half above: a step-OPENING round must
      // digest-reference the chain's prior terminal; a round REVISION re-states its reference
      // byte-bound (validateRoundRevision), so it is never re-classified against a moved terminal.
      if (snapshot.purpose === 'round' && snapshot.opensFrom !== null && walkChainState(chain).mode === 'boundary') {
        const ref = validateOpenerReference(parsed.records, snapshot);
        if (!ref.ok) throw stop(`refusing a step-opening round: ${ref.reason} — nothing was written`);
      }
      if (snapshot.purpose === 'refresh') {
        if (resolveRecordReference(parsed.records, snapshot.refreshedRecord) === undefined) {
          throw stop(`refusing a refresh whose refreshedRecord does not match the store (no record digests to ${snapshot.refreshedRecord.slice(0, 12)}…) — a re-attestation binds an existing record; nothing was written`);
        }
        if (!isAuthoritativeReferenceTarget(parsed.records, snapshot.refreshedRecord)) {
          throw stop('refusing a refresh whose refreshedRecord targets a superseded record — a re-attestation binds the authoritative latest record of its key; nothing was written');
        }
      }
    }
    const existingSup = validateSupersessions(parsed.records);
    if (!existingSup.ok) {
      throw stop(`refusing to append to a flow store whose existing records already violate supersession legality (${existingSup.reason}) — inspect ${storePath}; nothing was written (fail closed)`);
    }
    const candidateSup = validateSupersessions([...parsed.records, snapshot]);
    if (!candidateSup.ok) {
      throw stop(`refusing an illegal supersession: ${candidateSup.reason} — the append-only store never absorbs a record that permanently reddens the checker; nothing was written`);
    }
    const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    // The final rename is bound to the SNAPSHOT: (a) the held fd is re-read and byte-compared
    // (a same-inode in-place mutation refuses instead of being clobbered with stale bytes), then
    // (b) the leaf must still show the snapshot inode — or still-absent for a fresh store —
    // immediately before the rename. Rides the frozen writer's deps.rename seam.
    const renameBase = deps.rename ?? renameSync;
    const guardedRename = (from, to) => {
      if (to === storePath) {
        if (storeRead.outcome === 'ok') {
          let same;
          try {
            same = fdContentEquals(snapshotFd, storeRead.bytes);
          } catch (err) {
            throw stop(`cannot re-read the flow store snapshot before the final rename (${(err && err.code) || (err && err.message) || err}) — nothing was written (fail closed)`);
          }
          if (!same) {
            throw stop(`the flow store ${storePath} content changed under the lock (same-inode in-place mutation) — refusing the final rename; nothing was written (fail closed)`);
          }
        }
        let leaf = null;
        try {
          leaf = lstatNoFollow(to, deps.lstat ?? lstatSync);
        } catch (err) {
          throw stop(`cannot verify the flow store leaf before the final rename (${(err && err.code) || (err && err.message) || err}) — nothing was written (fail closed)`);
        }
        const identityHeld = storeRead.outcome === 'absent'
          ? leaf == null
          : leaf != null && leaf.isFile() && leaf.dev === storeRead.dev && leaf.ino === storeRead.ino;
        if (!identityHeld) {
          throw stop(`the flow store ${storePath} changed identity under the lock (concurrent or foreign mutation) — refusing the final rename; nothing was written (fail closed)`);
        }
        if (leaf != null && leaf.nlink !== 1) {
          throw stop(`the flow store ${storePath} has ${leaf.nlink} hard links — two path-derived locks would race one inode; remove the extra links and retry (fail closed)`);
        }
      }
      return renameBase(from, to);
    };
    writeContainedFileAtomic(dirname(storePath), storePath, `${prefix}${line}\n`, { ...deps, rename: guardedRename }, { stop, label: storePath });
    if (snapshotFd !== null) {
      const fd = snapshotFd;
      snapshotFd = null;
      closeSync(fd); // a success-lane close failure surfaces as the append's own error
    }
    return { value: { writtenPath: storePath, record: snapshot } };
  } catch (err) {
    return { err };
  } finally {
    if (snapshotFd !== null) { try { closeSync(snapshotFd); } catch { /* the failure above stays primary */ } }
  }
};

// ── chain-state walk + the generic reference validator (#63) ──────────────────────────────────────

const TERMINAL_PURPOSES = ['adoption', 'converged', 'complete'];
const HEX64_RE = /^[0-9a-f]{64}$/;

// The record a step-opening round must reference: the latest converged/complete, else the adoption
// record itself (the plan's first step — the exemption is explicit, never inferred).
export const priorChainTerminal = (chain) => {
  let terminal = null;
  for (const r of chain) {
    if (r.purpose === 'adoption' && terminal === null) terminal = r;
    else if (r.purpose === 'converged' || r.purpose === 'complete') terminal = r;
  }
  return terminal;
};

// walkChainState(chain) → { mode, parked, completed, cycle, round, stepId, openers, lastTerminal }
// over ONE plan's raw-order chain. Legality lives in validateChainSequence — callers run it first;
// this walk only derives state, including each opener with its at-that-point prior terminal.
export const walkChainState = (chain) => {
  const state = {
    mode: 'boundary', parked: false, completed: false,
    cycle: chain[0]?.cycle ?? null, round: chain[0]?.round ?? null, stepId: null,
    openers: [], lastTerminal: null,
  };
  for (const r of chain) {
    state.cycle = r.cycle;
    if (r.purpose === 'adoption') { state.lastTerminal = r; state.round = r.round; continue; }
    if (r.purpose === 'park') { state.parked = true; continue; }
    if (r.purpose === 'resume') { state.parked = false; continue; }
    if (r.purpose === 'complete') { state.completed = true; state.lastTerminal = r; continue; }
    if (r.purpose === 'converged') { state.mode = 'boundary'; state.lastTerminal = r; state.stepId = null; continue; }
    if (r.purpose === 'unfreeze' && state.mode === 'boundary') { state.mode = 'in-step'; state.stepId = r.stepId; state.round = r.round; continue; }
    if (r.purpose === 'round') {
      if (state.mode === 'boundary') {
        state.openers.push({ record: r, priorTerminal: state.lastTerminal });
        state.mode = 'in-step';
        state.stepId = r.stepId;
        state.round = r.round;
      } else if (r.round > state.round) state.round = r.round;
    }
  }
  return state;
};

// Reference checks live ENTIRELY in the digest domain — two byte-different records with one
// canonical serialization are ONE identity, so object identity never decides resolution or
// authority. resolveRecordReference returns the LAST matching record (consistent with the
// latest-per-key authoritative selection); the prefix (records BEFORE the referencing one) is the
// resolution domain, so an out-of-order reference never resolves.
export const resolveRecordReference = (prefixRecords, digest) =>
  prefixRecords.findLast((r) => canonicalFlowDigest(r) === digest);

export const isAuthoritativeReferenceTarget = (scopeRecords, digest) =>
  authoritativeFlowRecords(scopeRecords).some((r) => canonicalFlowDigest(r) === digest);

// validateOpenerReference(prefixRecords, candidate) → { ok } | { ok: false, reason }. The named
// classification of a step-opening round's prior-terminal reference: unresolved · non-chain ·
// another plan · non-terminal · superseded · not-the-prior-terminal.
export const validateOpenerReference = (prefixRecords, candidate) => {
  const target = resolveRecordReference(prefixRecords, candidate.opensFrom);
  if (target === undefined) {
    return { ok: false, reason: `the prior-terminal reference does not match the store — no record digests to ${candidate.opensFrom.slice(0, 12)}…` };
  }
  if (target.kind !== CHAIN_KIND) {
    return { ok: false, reason: `the prior-terminal reference targets a ${target.kind} record, not a chain terminal` };
  }
  if (target.planId !== candidate.planId) {
    return { ok: false, reason: `the prior-terminal reference targets another plan's record ("${target.planId}") — a step never opens from a foreign chain` };
  }
  if (!TERMINAL_PURPOSES.includes(target.purpose)) {
    return { ok: false, reason: `the prior-terminal reference targets a non-terminal record (purpose "${target.purpose}") — an opener references adoption, converged, or complete only` };
  }
  const chain = prefixRecords.filter((r) => r.kind === CHAIN_KIND && r.planId === candidate.planId);
  if (!isAuthoritativeReferenceTarget(chain, candidate.opensFrom)) {
    return { ok: false, reason: 'the prior-terminal reference targets a superseded record — reference the latest record of that key' };
  }
  const prior = priorChainTerminal(chain);
  if (prior == null || canonicalFlowDigest(prior) !== candidate.opensFrom) {
    return { ok: false, reason: `the prior-terminal reference must target the chain's PRIOR terminal (${prior == null ? 'none' : `${canonicalFlowDigest(prior).slice(0, 12)}…`}), not another step's or an earlier terminal — step minting cannot manufacture fresh budgets` };
  }
  return { ok: true };
};

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

// ── the adoption mint (#58) — frontmatter planId + plan content digest, read-only plan file ──────

const PLAN_ID_FRONTMATTER_HINT = 'planId: <your-stable-plan-id>';

// Identity binds only a CLOSED leading frontmatter block — an unterminated block never yields an
// id; CRLF is normalized per line so line endings never fork chain identity.
const readPlanFrontmatterId = (text) => {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0]?.trim() !== '---') return null;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (close === -1) return null;
  for (const line of lines.slice(1, close)) {
    const m = /^planId:[ \t]*(\S+)[ \t]*$/.exec(line);
    if (m) return m[1];
  }
  return null;
};

export const mintAdoption = ({ cwd = process.cwd(), env = process.env, deps = {}, planPath, planLabel, cycle = 1, commitEpoch = 0, timestamp = new Date().toISOString() } = {}) => {
  const owner = deriveFlowOwner(cwd);
  if (owner == null) throw stop('not inside a git work tree — the adoption mint derives the owning worktree and the tree fingerprint from git (fail closed)');
  let planBytes;
  try {
    planBytes = readFileSync(resolve(cwd, planPath));
  } catch (err) {
    throw stop(`cannot read the plan file ${planPath} (${(err && err.code) || (err && err.message) || err}) — the adoption mint READS an existing plan file (fail closed)`);
  }
  const planId = readPlanFrontmatterId(planBytes.toString('utf8'));
  if (planId == null) {
    throw stop(`the plan file ${planPath} carries no frontmatter planId — plan filenames are never chain identity. Add this line inside a leading "---" frontmatter block:\n${PLAN_ID_FRONTMATTER_HINT}\nand re-run; the plan file is never written by this mint (fail closed)`);
  }
  const planDigest = sha256Hex(planBytes);
  // A pre-append read purely for the NAMED refusal: the locked append would refuse a second
  // adoption anyway, but only this comparison can surface whether the plan content still matches.
  const resolved = resolveFlowStorePath(cwd, env);
  const adopted = resolved == null ? undefined : readFlowStore(resolved).records
    .find((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption' && r.planId === planId);
  if (adopted !== undefined) {
    throw stop(adopted.planDigest === planDigest
      ? `plan "${planId}" is already adopted (content digest unchanged — a rename never resets chain identity); adoption is only ever the chain's first record`
      : `plan "${planId}" is already adopted and the plan file content no longer matches its adoption record (recorded ${adopted.planDigest.slice(0, 12)}…, current ${planDigest.slice(0, 12)}…) — re-adopting edited plan content is refused; the digest mismatch is surfaced, never silent`);
  }
  const fingerprint = computeTreeFingerprint(cwd);
  if (fingerprint == null) throw stop('cannot compute the tree fingerprint — the adoption record binds {base, fingerprint} (fail closed)');
  const record = {
    schema: FLOW_SCHEMA_VERSION, kind: CHAIN_KIND, purpose: 'adoption', planId, cycle, round: 0,
    commitEpoch, owner, base: resolveBase(cwd), timestamp, stepId: null, fingerprint,
    planLabel: planLabel ?? planId, createdAt: timestamp, planDigest,
  };
  const { writtenPath } = appendFlowRecord({ cwd, record, env, deps });
  return { writtenPath, record, digest: canonicalFlowDigest(record) };
};

// ── the bookkeeping-delta custody proof (#60) — masked revert-and-recompute at mint time ─────────

// The supported pre-state model; everything else refuses BY NAME (fail closed): the delta lives in
// the WORKTREE layer of one plain-ASCII, non-binary, non-executable regular path. A tracked path
// must be CLEAN at the path before the delta (pre-change worktree bytes = its index entry), so the
// pre-state contributes NO unstaged diff section and the mask is pure section REMOVAL plus
// untracked-entry splicing — the recompute never regenerates git diff bytes, whose exact form this
// module cannot promise. Supported transitions: present→present, present→absent, absent→present.

const GIT_PLAIN_PATH_RE = /^[\x20-\x7e]+$/;
const pathNeedsGitQuoting = (rel) => !GIT_PLAIN_PATH_RE.test(rel) || rel.includes('"') || rel.includes('\\');
const bufferLooksBinary = (buf) => buf.subarray(0, 8192).includes(0);
const REGULAR_FILE_MODE = '100644';

const defaultRunGit = (args, dir) => spawnSync('git', args, { cwd: dir, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });

// The declared path enters git as a LITERAL pathspec and comes back through a strict -z parse:
// exactly one NUL-terminated record whose path field EQUALS the declared rel, full-octal mode,
// an OID of exactly 40 or 64 hex — a glob-capable name ([]*?) or a prefix-valid truncated answer
// can then never bind the proof to another file (fail closed on every mismatch).
const OID_PART = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const INDEX_META_RE = new RegExp(`^([0-7]{6}) (${OID_PART}) (\\d)$`);
const TREE_META_RE = new RegExp(`^([0-7]{6}) (\\w+) (${OID_PART})$`);

const parseZRecords = (stdout) => {
  const text = stdout.toString('utf8');
  if (text === '') return [];
  if (!text.endsWith('\0')) return null;
  return text.slice(0, -1).split('\0');
};

const splitZEntry = (entry, metaRe) => {
  const at = entry.indexOf('\t');
  if (at === -1) return null;
  const meta = metaRe.exec(entry.slice(0, at));
  return meta == null ? null : { meta, path: entry.slice(at + 1) };
};

const readIndexEntry = (top, rel, runGit) => {
  const out = runGit(['ls-files', '-s', '-z', '--', `:(literal)${rel}`], top);
  if (out.error || out.status !== 0) throw stop(`cannot read the index entry of ${rel} (git ls-files failed) — refusing to mint (fail closed)`);
  const recordsZ = parseZRecords(out.stdout);
  if (recordsZ == null) throw stop(`cannot parse the index entry of ${rel} (unterminated git ls-files output) — refusing to mint (fail closed)`);
  if (recordsZ.length === 0) return null;
  const entry = splitZEntry(recordsZ[0], INDEX_META_RE);
  if (recordsZ.length > 1 || entry == null || entry.meta[3] !== '0' || entry.path !== rel) {
    throw stop(`the declared path ${rel} carries an unmerged or unparseable index entry — an unsupported pre-state class (fail closed)`);
  }
  return { mode: entry.meta[1], sha: entry.meta[2] };
};

// An absent HEAD layer is PROVEN unborn, never assumed: rev-parse must answer with EXACTLY the
// clean verify-miss status (1) AND HEAD must still resolve as a symbolic ref; any operational
// fault fails closed. "No entry" is ONLY an empty ls-tree stdout — a non-empty answer must parse
// as exactly one entry line, else the repository is at fault (a false custody proof otherwise).
const GIT_VERIFY_MISS_STATUS = 1;
const readHeadEntry = (top, rel, runGit) => {
  const probe = runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], top);
  if (probe.error || probe.status !== 0) {
    const verifyMiss = !probe.error && probe.status === GIT_VERIFY_MISS_STATUS;
    const sym = verifyMiss ? runGit(['symbolic-ref', '--quiet', 'HEAD'], top) : null;
    if (sym == null || sym.error || sym.status !== 0) {
      throw stop('cannot decide the HEAD state (git rev-parse --verify HEAD did not answer with a clean verify miss, or symbolic-ref HEAD failed) — refusing to mint (fail closed)');
    }
    return null;
  }
  const out = runGit(['ls-tree', '-z', 'HEAD', '--', `:(literal)${rel}`], top);
  if (out.error || out.status !== 0) throw stop(`cannot read the HEAD entry of ${rel} (git ls-tree failed with an existing HEAD) — refusing to mint (fail closed)`);
  const recordsZ = parseZRecords(out.stdout);
  if (recordsZ == null) throw stop(`cannot parse the HEAD entry of ${rel} (unterminated git ls-tree output) — refusing to mint (fail closed)`);
  if (recordsZ.length === 0) return null;
  const entry = splitZEntry(recordsZ[0], TREE_META_RE);
  if (recordsZ.length > 1 || entry == null || entry.path !== rel) {
    throw stop(`cannot parse the HEAD entry of ${rel} (unexpected git ls-tree output) — refusing to mint (fail closed)`);
  }
  if (entry.meta[2] !== 'blob') {
    throw stop(`the HEAD entry of ${rel} is a ${entry.meta[2]}, not a blob — an unsupported pre-state class (fail closed)`);
  }
  return { mode: entry.meta[1], sha: entry.meta[3] };
};

const readBlob = (top, sha, runGit) => {
  const out = runGit(['cat-file', 'blob', sha], top);
  if (out.error || out.status !== 0) throw stop(`cannot read blob ${sha} from the object store — refusing to mint (fail closed)`);
  return out.stdout;
};

// Byte-level removal of ONE file's section from a git diff buffer. Hunk lines start with
// [ +\-\\@], so a line starting "diff --git " is always a section header; the declared path is
// plain-ASCII by refusal, so its header is these exact bytes. No section = a no-op mask.
const DIFF_SECTION_START = Buffer.from('\ndiff --git ');
const removeDiffSection = (buf, rel) => {
  const header = Buffer.from(`diff --git a/${rel} b/${rel}\n`);
  let at = -1;
  if (buf.subarray(0, header.length).equals(header)) at = 0;
  else {
    const i = buf.indexOf(Buffer.concat([Buffer.from('\n'), header]));
    if (i !== -1) at = i + 1;
  }
  if (at === -1) return buf;
  const next = buf.indexOf(DIFF_SECTION_START, at + header.length - 1);
  const end = next === -1 ? buf.length : next + 1;
  return Buffer.concat([buf.subarray(0, at), buf.subarray(end)]);
};

// One untracked entry's payload chunks, branch-for-branch the frozen core's discipline
// (computeFingerprintPayload) — the NULL-mask parity test pins the byte equality.
const untrackedEntryChunks = (top, rel, lstat) => {
  const full = join(top, rel);
  let stat = null;
  try {
    stat = lstat(full);
  } catch {
    stat = null;
  }
  if (isNeverCommittableStat(stat)) return [];
  if (stat?.isSymbolicLink()) {
    let target = '?';
    try {
      target = readlinkSync(full);
    } catch {
      target = '?';
    }
    return [Buffer.from(`untracked-symlink:${rel} -> ${target}\n`)];
  }
  if (!stat?.isFile()) return [Buffer.from(`untracked-nonregular:${rel}\n`)];
  if (isBinaryFile(full)) return [Buffer.from(`untracked-binary:${rel}\n`)];
  return [Buffer.from(`untracked:${rel}\n`), readFileSync(full)];
};

// ONE captured read set — every assembly over it (masked and unmasked) binds the SAME tree
// snapshot, so a tree move between two independent snapshots can never be certified. The three
// git reads themselves are separate processes; that window is the frozen core's own inherent
// residual and stays declared, not closed.
const captureFingerprintPieces = (cwd, { lstat = lstatSync } = {}) => {
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) return null;
  const staged = gitBuf(['diff', '--cached', '--no-ext-diff'], top);
  const unstaged = gitBuf(['diff', '--no-ext-diff'], top);
  const untrackedZ = gitBuf(['ls-files', '--others', '--exclude-standard', '-z'], top);
  if (staged == null || unstaged == null || untrackedZ == null) return null;
  const entries = untrackedZ.toString('utf8').split('\0').filter(Boolean)
    .map((rel) => ({ rel, chunks: untrackedEntryChunks(top, rel, lstat) }));
  return { staged, unstaged, entries };
};

// mask: null = the exact frozen-core payload; { layer: 'diff', rel } removes the path's unstaged
// section (its pre-state section is EMPTY by the clean-at-path rule); { layer: 'untracked', rel,
// insert, preBytes } splices the untracked entry (git emits ls-files sorted by path bytes).
const assembleMaskedPayload = (pieces, mask) => {
  const unstaged = mask?.layer === 'diff' ? removeDiffSection(pieces.unstaged, mask.rel) : pieces.unstaged;
  let entries = pieces.entries;
  if (mask?.layer === 'untracked') {
    entries = entries.filter((e) => e.rel !== mask.rel);
    if (mask.insert) {
      const at = entries.findIndex((e) => e.rel > mask.rel);
      entries = [...entries];
      entries.splice(at === -1 ? entries.length : at, 0, { rel: mask.rel, chunks: [Buffer.from(`untracked:${mask.rel}\n`), mask.preBytes] });
    }
  }
  return Buffer.concat([pieces.staged, unstaged, ...entries.flatMap((e) => e.chunks)]);
};

export const computeMaskedFingerprintPayload = (cwd, mask = null, fsx) => {
  const pieces = captureFingerprintPieces(cwd, fsx);
  return pieces == null ? null : assembleMaskedPayload(pieces, mask);
};

// mintBookkeepingDelta: the FULL pre-state arrives as EXPLICIT inputs (pre-change worktree bytes +
// the presence class; tracked-ness derives from the window-constant HEAD/index layers) — never
// reconstructed from ambient git state. The computation only READS: the working tree is never
// mutated. The mint refuses unless the masked recompute reproduces fingerprintBefore — an
// unconfined delta never lands; the proof payload persists so the checker can verify a PROVEN
// mint against a bare declaration.
export const mintBookkeepingDelta = ({ cwd = process.cwd(), env = process.env, deps = {}, path: rel, fingerprintBefore, preContent = null, timestamp = new Date().toISOString() } = {}) => {
  if (typeof fingerprintBefore !== 'string' || !HEX64_RE.test(fingerprintBefore)) {
    throw stop('fingerprintBefore must be the 64-hex PRE-DELTA tree fingerprint — the proof compares the masked recompute against it (fail closed)');
  }
  const lex = lexicalRepoRelative(rel);
  if (!lex.ok) throw stop(`the declared path must be lexically repo-relative — ${lex.reason} (fail closed)`);
  if (pathNeedsGitQuoting(rel)) {
    throw stop(`the declared path "${rel}" needs git diff-header quoting — an unsupported pre-state class (the masked recompute matches plain header bytes only; fail closed)`);
  }
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) throw stop('not inside a git work tree — the custody proof has no meaning outside the fingerprint domain; refusing to mint');
  const preBytes = preContent == null ? null : Buffer.from(preContent);
  if (preBytes !== null && bufferLooksBinary(preBytes)) {
    throw stop(`the pre-change bytes of ${rel} carry binary content — an unsupported pre-state class (fail closed)`);
  }
  const full = join(top, rel);
  const st = lstatNoFollow(full, deps.lstat ?? lstatSync);
  if (st?.isSymbolicLink()) throw stop(`the declared path ${rel} is a symlink — an unsupported pre-state class (fail closed)`);
  if (st && !st.isFile()) throw stop(`the declared path ${rel} is a ${describeNonRegular(st)} — an unsupported pre-state class (fail closed)`);
  if (st && (st.mode & 0o111) !== 0) throw stop(`the declared path ${rel} carries an executable mode — an unsupported pre-state class (mode motion cannot be expressed; fail closed)`);
  const nowBytes = st ? readFileSync(full) : null;
  if (nowBytes !== null && bufferLooksBinary(nowBytes)) {
    throw stop(`the declared path ${rel} carries binary content — an unsupported pre-state class (fail closed)`);
  }
  const preClass = preBytes === null ? 'absent' : 'present';
  if (preClass === 'absent' && nowBytes === null) {
    throw stop('the absent→absent transition is unsupported — supported: present→present, present→absent, absent→present (fail closed)');
  }
  const runGit = deps.runGit ?? defaultRunGit;
  const index = readIndexEntry(top, rel, runGit);
  const head = readHeadEntry(top, rel, runGit);
  for (const [layer, entry] of [['index', index], ['HEAD', head]]) {
    if (entry && entry.mode !== REGULAR_FILE_MODE) {
      throw stop(`the ${layer} entry of ${rel} carries mode ${entry.mode} — an unsupported pre-state class (only plain ${REGULAR_FILE_MODE} regular files are expressible; fail closed)`);
    }
  }
  if (index == null && head != null) {
    throw stop(`the declared path ${rel} has a HEAD entry but no index entry (a staged deletion) — an unsupported pre-state class (fail closed)`);
  }
  const tracked = index != null || head != null;
  const headBytes = head == null ? null : readBlob(top, head.sha, runGit);
  const indexBytes = index == null ? null : readBlob(top, index.sha, runGit);
  let mask;
  if (tracked) {
    if (preClass === 'absent') {
      throw stop(`the declared path ${rel} is tracked while its pre-change worktree state is absent — a dirty pre-state at the declared path is an unsupported pre-state class (the masked proof covers a clean-at-path pre-state only; fail closed)`);
    }
    if (!preBytes.equals(indexBytes)) {
      throw stop(`the declared path ${rel} has a dirty pre-state (the pre-change worktree bytes do not equal the index entry) — an unsupported pre-state class (the masked proof covers a clean-at-path pre-state only; fail closed)`);
    }
    mask = { layer: 'diff', rel };
  } else {
    // --no-index: the ignore ANSWER must come from the rules alone — with the index consulted, a
    // tracked glob neighbor (feature-a.md vs the literal feature-[a].md) flips the answer and a
    // genuinely ignored path would spuriously refuse to mint.
    const ig = runGit(['check-ignore', '-q', '--no-index', '--', rel], top);
    if (ig.error || (ig.status !== 0 && ig.status !== 1)) {
      throw stop(`cannot decide the ignore state of ${rel} (git check-ignore failed) — refusing to mint (fail closed)`);
    }
    // An ignored path is outside the fingerprint domain in BOTH states — the mask is a no-op there.
    // Honest limit: an untracked path's MODE is likewise invisible to the frozen payload in both
    // states (an entry is name + bytes only) — untracked mode motion is neither expressible nor
    // claimed; only the CURRENT tree's non-plain modes refuse by name above.
    mask = { layer: 'untracked', rel, insert: preClass === 'present' && ig.status !== 0, preBytes };
  }
  const pieces = captureFingerprintPieces(cwd, deps);
  if (pieces == null) throw stop('cannot capture the fingerprint read set (a git probe failed) — refusing to mint (fail closed)');
  // Bracket: the declared path must still be EXACTLY what the class checks and contentDigest
  // observed — the no-follow class checks repeat first, then presence + bytes must match, so the
  // digest and the captured payload can never bind two different post-states.
  const stAfter = lstatNoFollow(full, deps.lstat ?? lstatSync);
  if (stAfter?.isSymbolicLink()) throw stop(`the declared path ${rel} is a symlink — an unsupported pre-state class (fail closed)`);
  if (stAfter && !stAfter.isFile()) throw stop(`the declared path ${rel} is a ${describeNonRegular(stAfter)} — an unsupported pre-state class (fail closed)`);
  if (stAfter && (stAfter.mode & 0o111) !== 0) throw stop(`the declared path ${rel} carries an executable mode — an unsupported pre-state class (mode motion cannot be expressed; fail closed)`);
  const bytesAfter = stAfter ? readFileSync(full) : null;
  const declaredMoved = (stAfter == null) !== (nowBytes === null)
    || (nowBytes !== null && bytesAfter !== null && !bytesAfter.equals(nowBytes));
  if (declaredMoved) {
    throw stop(`the declared path ${rel} moved under the mint (its bytes or presence changed during the capture) — contentDigest and the captured payload must bind ONE post-state; retry on a quiescent tree (fail closed)`);
  }
  const maskedFingerprint = sha256Hex(assembleMaskedPayload(pieces, mask));
  if (maskedFingerprint !== fingerprintBefore) {
    throw stop(`the delta is NOT confined to the declared path ${rel} — the masked revert-and-recompute (${maskedFingerprint.slice(0, 12)}…) does not reproduce fingerprintBefore (${fingerprintBefore.slice(0, 12)}…); something else moved in the window (fail closed)`);
  }
  // Both fingerprints derive from the ONE captured read set — a tree move between two independent
  // snapshots can never be certified as a confined delta.
  const fingerprintAfter = sha256Hex(assembleMaskedPayload(pieces, null));
  const record = {
    schema: FLOW_SCHEMA_VERSION, kind: 'bookkeeping-delta', fingerprintBefore, fingerprintAfter,
    path: rel, contentDigest: nowBytes === null ? null : sha256Hex(nowBytes),
    custodyProof: {
      preClass, tracked,
      headDigest: headBytes === null ? null : sha256Hex(headBytes),
      indexDigest: indexBytes === null ? null : sha256Hex(indexBytes),
      worktreeDigest: preBytes === null ? null : sha256Hex(preBytes),
      maskedFingerprint,
    },
    base: resolveBase(cwd), timestamp,
  };
  const { writtenPath } = appendFlowRecord({ cwd, record, env, deps });
  return { writtenPath, record, digest: canonicalFlowDigest(record) };
};

