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
// Declared residuals no dependency-free core-Node mechanism can close: the pathname lstat→rename
// and reread→rename windows (no flock/fcntl, no inode-conditional unlink or rename) and bind-mount
// aliasing. Plan-3 scope lives with flow-check: store-level reference resolution, mint primitives,
// decideCheck arms, whole-store health. Records remain forgeable — a self-discipline mechanism in
// the git dir, not a security boundary.

import { readFileSync, writeFileSync, writeSync, readSync, rmSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, renameSync, constants as fsConstants } from 'node:fs';
import { join, dirname, basename, isAbsolute, normalize, sep } from 'node:path';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeContainedFileAtomic, lstatNoFollow } from './atomic-write.mjs';
import { parsePositiveIntKnob } from './changed-surface.mjs';
import { CHAIN_KIND, validateFlowRecord, validateChainSequence, validateSupersessions, authoritativeFlowRecords } from './flow-record.mjs';

export const FLOW_STORE_STOP = 'FLOW_STORE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'FlowStoreStop', code: FLOW_STORE_STOP });

export const FLOW_STORE_BASENAME = 'agent-workflow-flow.jsonl';
export const FLOW_LOCK_SUFFIX = '.lock';

// Wait bound + poll cadence; the env knobs keep hermetic tests off wall-clock.
export const FLOW_LOCK_WAIT_MS = 10_000;
export const FLOW_LOCK_POLL_MS = 100;

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

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

