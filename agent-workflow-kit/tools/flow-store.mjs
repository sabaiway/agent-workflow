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
// aliasing. The decideCheck arms, guard/gates wiring, and the arming + writer CLIs (set-flow,
// flow-writer) are LIVE (Plan 3 Phases 2–3); the remaining Plan-3 surface is the deadline runner +
// wrapper manifest lane (Phase 4). Records remain forgeable — a self-discipline mechanism in the
// git dir, not a security boundary.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, writeSync, readSync, rmSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, renameSync, readlinkSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeContainedFileAtomic, lstatNoFollow } from './atomic-write.mjs';
import { parsePositiveIntKnob } from './changed-surface.mjs';
import { FLOW_SCHEMA_VERSION, CHAIN_KIND, validateFlowRecord, validateChainSequence, validateSupersessions, authoritativeFlowRecords, canonicalFlowDigest, flowRecordKey, subsetFoldBatchDigest, subsetGateIdsDigest, SUBSET_ATTEMPT_DIAGNOSIS_FROM } from './flow-record.mjs';
import { isNeverCommittableStat, isBinaryFile, lexicalRepoRelative, resolveBase, computeTreeFingerprint } from './core-evidence.mjs';
import { derivePregateSubsetIds, GATES_REL } from './gates-declaration.mjs';
import { CONFIG_REL } from './orchestration-config.mjs';
// The read half lives in flow-store-read.mjs (it OWNS no write API — read-only surfaces like the
// procedures advisor import it directly) and is RE-EXPORTED here — every existing consumer keeps
// its import site.
import {
  FLOW_STORE_STOP, flowStoreStop, FLOW_STORE_BASENAME, FLOW_LOCK_SUFFIX, gitLine,
  resolveFlowStorePath, resolveFlowLockPath, parseFlowStoreText, readFlowStore,
  readRegularFileNoFollow, deriveFlowOwner, describeNonRegular,
} from './flow-store-read.mjs';

export {
  FLOW_STORE_STOP, FLOW_STORE_BASENAME, FLOW_LOCK_SUFFIX,
  resolveFlowStorePath, resolveFlowLockPath, parseFlowStoreText, readFlowStore, deriveFlowOwner,
};

const stop = flowStoreStop;

// Wait bound + poll cadence; the env knobs keep hermetic tests off wall-clock.
export const FLOW_LOCK_WAIT_MS = 10_000;
export const FLOW_LOCK_POLL_MS = 100;

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitBuf = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ── the lock/CAS ──────────────────────────────────────────────────────────────────────────────────

// Sync sleep (the append is a sync flow end-to-end); injectable so a hermetic test can intercept it.
const sleepSyncMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Monotonic — a system clock stepped backwards must not stretch the wait bound.
const monotonicNowMs = () => performance.now();

// POSIX single-quoting for paths pasted into recovery commands — a raw interpolation would execute
// path bytes on paste.
const shellQuotePath = (p) => `'${p.replaceAll("'", "'\\''")}'`;

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
    // The holder read HOLDS its fd (keepFd) until the lane decides: while the fd is open the
    // inode cannot be recycled, so the DEAD re-verify below can trust an identity match only
    // together with the held inode still being linked (FLOW-LOCK-HOLDER-FD-RECHECK). The lane
    // verdict is computed FIRST (its error captured), the held fd then closes unconditionally,
    // and a close failure is a typed STOP — thrown alone, or preserved on the primary error as
    // holderCloseFailure (the releaseFlowLock never-mask discipline; P28).
    const holderIo = deps.holderIo ?? {};
    // The read itself is wrapped: on the early error/foreign lanes the reader closes its own fd
    // in a finally, and a close throw there would otherwise escape as a RAW error outside the
    // typed-STOP guarantee.
    let holderRead;
    try {
      holderRead = readRegularFileNoFollow(lockPath, { ...holderIo, keepFd: true });
    } catch (err) {
      throw stop(`cannot read the flow-store lock holder (${(err && err.code) || (err && err.message) || err}) — the read/close custody failed (fail closed)`);
    }
    if (holderRead.closeFailure !== undefined) {
      throw stop(`cannot read the flow-store lock holder (${holderRead.closeFailure}) — the read/close custody failed (fail closed)`);
    }
    const holderFd = holderRead.outcome === 'ok' ? holderRead.fd : null;
    let verdict = null;
    let primary = null;
    try {
      verdict = (() => {
        if (holderRead.outcome === 'absent') {
          refuseIfPastDeadline('the lock kept appearing and vanishing (churn)');
          return { retry: true }; // released between attempts — retry the CAS at once
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
          // The DEAD verdict binds to the inode the holder was read from — a lock released or
          // replaced since then means the observed holder is gone: retry, never refuse a
          // vanished lock.
          let lockNow = null;
          try {
            lockNow = lstatNoFollow(lockPath, lstat); // null ONLY on a true ENOENT
          } catch (err) {
            throw stop(`cannot re-verify the flow-store lock identity before the DEAD refusal (${(err && err.code) || (err && err.message) || err}) — refusing to guess (fail closed)`);
          }
          if (lockNow == null || lockNow.dev !== holderRead.dev || lockNow.ino !== holderRead.ino) {
            refuseIfPastDeadline('the observed dead holder was released (churn)');
            return { retry: true };
          }
          // A pathname identity match alone can be a recycled lie (release + re-create landing
          // the same {dev, ino}); the held fd settles it — an unlinked held inode (nlink 0)
          // proves the observed holder's lock is GONE, whatever the pathname claims.
          let heldNow;
          try {
            heldNow = (holderIo.fstat ?? fstatSync)(holderFd);
          } catch (err) {
            throw stop(`cannot re-verify the flow-store lock through its held descriptor (${(err && err.code) || (err && err.message) || err}) — refusing to guess (fail closed)`);
          }
          if (heldNow.nlink === 0) {
            refuseIfPastDeadline('the observed dead holder was released (churn)');
            return { retry: true };
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
        return { sleepMs: Math.min(pollMs, deadline - observedAt) };
      })();
    } catch (err) {
      primary = err;
    }
    if (holderFd !== null) {
      try {
        (holderIo.close ?? closeSync)(holderFd);
      } catch (err) {
        const closeStop = stop(`cannot close the held flow-store holder descriptor (${(err && err.code) || (err && err.message) || err}) — the fd-custody guarantee is violated (fail closed)`);
        if (primary == null) primary = closeStop;
        else primary.holderCloseFailure = closeStop.message;
      }
    }
    if (primary != null) throw primary;
    if (verdict.retry) continue;
    sleep(verdict.sleepMs);
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
  const { line, snapshot } = captureRecordSnapshot(record);
  // Round-9 fold: subset-attempt records are minted ONLY by the locked factory — foldBatch,
  // subsetDigest, and attemptIndex are DERIVED inside its critical section, and a hand-built
  // record could forge a fresh counting context and bypass the hard-stop budget.
  if (snapshot.kind === 'subset-attempt') {
    throw stop('subset-attempt records are minted ONLY by the locked append factory (appendSubsetAttempt) — a hand-built record could forge a fresh counting context and bypass the hard-stop budget (fail closed)');
  }
  return appendResolvedFlowRecord({ cwd, env, deps, makeRecord: () => ({ line, snapshot }) });
};

// appendFlowRecordWithPreflight — the generic lane plus a caller `preflight(records)` hook that
// runs INSIDE the critical section on the locked store snapshot (Plan 4 Phase 3 / round-1 fold
// F6): a writer's lock-free cap/completeness walk is advisory — the locked snapshot decides, so
// a concurrent append can never slip a stale terminal (or a stranding round) through. The hook
// receives a DEEP-FROZEN CLONE (round-1 fold M5): a buggy preflight throws on any mutation
// attempt and can never skew the bytes the semantic validation and the write see. A throwing
// preflight refuses the append with nothing written. The subset-attempt factory-only rule holds
// on this lane too.
export const appendFlowRecordWithPreflight = ({ cwd = process.cwd(), record, env = process.env, deps = {}, preflight = null } = {}) => {
  const { line, snapshot } = captureRecordSnapshot(record);
  if (snapshot.kind === 'subset-attempt') {
    throw stop('subset-attempt records are minted ONLY by the locked append factory (appendSubsetAttempt) — a hand-built record could forge a fresh counting context and bypass the hard-stop budget (fail closed)');
  }
  return appendResolvedFlowRecord({ cwd, env, deps, makeRecord: (records) => {
    if (preflight != null) preflight(deepFreezeClone(records));
    return { line, snapshot };
  } });
};

const deepFreezeClone = (value) => {
  const freeze = (v) => {
    if (v !== null && typeof v === 'object') {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(structuredClone(value));
};

// ONE serialization captured up front; validation and every preflight walk run on its PARSED
// snapshot — a toJSON or getter can never make the written line differ from what validated.
const captureRecordSnapshot = (record) => {
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
  return { line, snapshot };
};

// The lock-serialized core both append lanes share: resolve → acquire → makeRecord (UNDER the
// lock, over the captured store snapshot) → semantic preflights → atomic write → custody release.
// The Decision-7 factory lane COMPUTES its record inside the critical section — attemptIndex and
// the hard-stop state cannot be derived lock-free — so makeRecord runs under the lock by contract.
const appendResolvedFlowRecord = ({ cwd, env, deps, makeRecord }) => {
  const resolved = resolveFlowStorePath(cwd, env);
  if (resolved == null) {
    throw stop('not inside a git work tree (and no AW_FLOW_STORE override) — there is no flow store to append to');
  }
  const { storePath, lockPath, lockFd, lockIdentity } = acquireFlowLock(resolved, env, deps);
  const body = appendUnderLock({ storePath, makeRecord, deps });
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
const appendUnderLock = ({ storePath, makeRecord, deps }) => {
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
    const { line, snapshot } = makeRecord(parsed.records);
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
    // The closure rule runs UNDER the lock on the captured snapshot — a writer's lock-free
    // usability pre-check can race a concurrent up/clear, and a justification minted after its
    // mark closed can never satisfy the decide layer (#25), so the store refuses to strand it.
    if (snapshot.kind === 'degrade-justification') {
      const closed = parsed.records.some((r) => (r.kind === 'down-mark-up' || r.kind === 'down-mark-clear') && r.target === snapshot.downMark);
      if (closed) {
        throw stop('refusing a degrade-justification whose down-mark is already closed by up/clear — minted-after-close can never satisfy (#25); nothing was written');
      }
    }
    // The same P3-26 discipline for the consult-attestation (Phase-4): the writer derives
    // {cycle, stepId, round} lock-free, so a concurrent converged/park/complete can close or move
    // the step first — under the lock the named plan's chain must be LEGAL and hold an OPEN step
    // (in-step, not parked, not completed) whose {cycle, stepId, round} EQUALS the record's; a
    // stale consult context can never satisfy the decide layer, so the store refuses to strand it.
    if (snapshot.kind === 'consult-attestation') {
      const chain = parsed.records.filter((r) => r.kind === CHAIN_KIND && r.planId === snapshot.planId);
      const seq = chain.length === 0 ? { ok: false, reason: 'no chain exists for that plan' } : validateChainSequence(chain);
      if (!seq.ok) {
        throw stop(`refusing a consult-attestation: the plan "${snapshot.planId}" chain is not a legal open carrier under the lock (${seq.reason}); nothing was written`);
      }
      const state = walkChainState(chain);
      const open = state.mode === 'in-step' && !state.parked && !state.completed;
      if (!open || state.stepId !== snapshot.stepId || state.cycle !== snapshot.cycle || state.round !== snapshot.round) {
        const shown = !open
          ? (state.completed ? 'the plan is completed' : state.parked ? 'the plan is parked' : 'no step is open')
          : `the open step is "${state.stepId}" (cycle ${state.cycle}, round ${state.round})`;
        throw stop(`refusing a consult-attestation whose {cycle, stepId, round} does not match the OPEN step under the lock — ${shown}; a consult binds the open step's round, and a stale context can never satisfy; nothing was written`);
      }
    }
    // The Decision-7/8 counting-context gate runs UNDER the lock for BOTH append lanes (the
    // factory computes a passing record; a hand-built one must satisfy the same rules).
    if (snapshot.kind === 'subset-attempt') {
      const gate = subsetAttemptGate(parsed.records, snapshot);
      if (!gate.ok) throw stop(`refusing a subset-attempt: ${gate.reason} — nothing was written`);
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

// ── the Decision-7/8 subset-attempt lane (Plan 4) — counting-context gate + locked factory ────────

// The waste bound is the CAP, not the prose (Decision 8): a counting context allows at most
// THREE red attempts (two blind + one diagnosed) on its own; past that, no diagnosis reopens it —
// only a recorded FRESH-EYES consult verdict does, one further attempt per consult.
export const SUBSET_ATTEMPT_MAX_REDS = 3;

// Past the SECOND red every further attempt at the key rides a recorded diagnosis — the
// obligation keys on REDS, never on the attempt index (a green history stays blind-legal).
export const SUBSET_ATTEMPT_DIAGNOSIS_REDS = 2;

// subsetAttemptState(records, probe) → { attempts, nextIndex, reds, credits, exhausted } — the
// ONE Decision-7/8 budget walk both consumers share (the locked gate below re-runs it under the
// lock; run-gates' pre-gate check reads it lock-free). The exhaustion ladder is PERMIT-based
// and foldBatch-GLOBAL (round-3 disposition): red counts stay per key, but permits and their
// consumption span EVERY subsetDigest of the round context — one consult verdict is exactly
// ONE further attempt across the whole foldBatch, whichever subset spends it. Consult identity
// {backend, nonce} is tracked STORE-WIDE before any relevance filtering, so a replay from
// another round (or any seen identity — pre-exhaustion or spent) never credits; a credit is
// granted only for a NEW identity whose {planId, cycle, stepId, round} digests to this
// foldBatch while SOME key of the foldBatch is base-exhausted at that point in raw order.
// EVERY attempt recorded past its own key's base budget consumes one credit, whatever its
// status; a tampered store that drove credits negative stays exhausted (fail closed).
export const subsetAttemptState = (records, probe) => {
  const key = flowRecordKey({ kind: 'subset-attempt', ...probe });
  const attempts = [];
  const seenConsults = new Set();
  const redsByKey = new Map();
  let credits = 0;
  const someKeyExhausted = () => [...redsByKey.values()].some((n) => n >= SUBSET_ATTEMPT_MAX_REDS);
  for (const r of records) {
    if (r.kind === 'subset-attempt' && r.foldBatch === probe.foldBatch) {
      const rKey = flowRecordKey(r);
      const priorReds = redsByKey.get(rKey) ?? 0;
      if (priorReds >= SUBSET_ATTEMPT_MAX_REDS) credits -= 1;
      if (r.status === 'red') redsByKey.set(rKey, priorReds + 1);
      if (rKey === key) attempts.push(r);
    } else if (r.kind === 'consult-attestation') {
      const identity = JSON.stringify([r.backend, r.nonce]);
      const relevant = subsetFoldBatchDigest({ planId: r.planId, cycle: r.cycle, stepId: r.stepId, round: r.round }) === probe.foldBatch;
      if (relevant && !seenConsults.has(identity) && someKeyExhausted()) credits += 1;
      seenConsults.add(identity);
    }
  }
  const reds = redsByKey.get(key) ?? 0;
  return {
    attempts,
    nextIndex: attempts.reduce((m, r) => Math.max(m, r.attemptIndex), 0) + 1,
    reds,
    credits,
    exhausted: reds >= SUBSET_ATTEMPT_MAX_REDS && credits <= 0,
  };
};

export const subsetExhaustionRemedy = 'the fresh-eyes lane reopens it (Decision 8 — never a human wait-state): dispatch a MANDATORY grounded bridge consult (a different model) carrying the full attempt/diagnosis trail; its recorded consult-attestation at this round context reopens exactly ONE further diagnosed attempt. Otherwise park the stuck work with its trail and switch to independent work; a fresh context opens with the next round (new foldBatch) or a declared pregateExclude change (new subsetDigest)';

// The under-lock rules the factory does NOT already enforce itself: the exhaustion ladder and
// the byte-distinct diagnosis (blind thrashing refuses; a NEW hypothesis proceeds). The
// monotonic index and the reds-based diagnosis REQUIREMENT live in the factory alone — it is
// the ONLY entry for this kind (the generic lane refuses it by name, round-9 fold), computes
// the index from the SAME locked snapshot this gate sees, and throws its own named stops first.
const subsetAttemptGate = (records, snapshot) => {
  const { attempts, reds, exhausted } = subsetAttemptState(records, snapshot);
  if (exhausted) {
    return { ok: false, reason: `this counting context already holds ${reds} red attempts — EXHAUSTED (two blind + one diagnosed, Decision 8) and no diagnosis reopens it; ${subsetExhaustionRemedy}` };
  }
  const prior = attempts.find((r) => r.attemptIndex === snapshot.attemptIndex - 1);
  if (typeof snapshot.diagnosis === 'string' && prior != null && prior.diagnosis === snapshot.diagnosis) {
    return { ok: false, reason: "the diagnosis is byte-identical to the prior attempt's — a diagnosed continuation states a NEW hypothesis (Decision 8); blind thrashing refuses" };
  }
  return { ok: true };
};

// ── the Decision-7 subset-run serializer (round-6 fold) ──────────────────────────────────────────

// --pre-review's WHOLE armed cycle (budget preflight → gates → append) holds this lock: without
// it a parallel run executes gates whose red can no longer be recorded once the winner lands,
// and an unrecorded red undercounts the budget ("EVERY subset-run red counts"). A SEPARATE lock
// file beside the store — never the store lock itself, so appends from other lanes never block
// behind a minutes-long gate run — riding the same CAS/fd-custody/holder-liveness discipline: a
// crashed holder surfaces as the named DEAD refusal with its rm recovery; a live holder is a
// bounded loud wait (the queued run then re-reads the budget and re-decides).
export const SUBSET_RUN_LOCK_INFIX = '.subset-run';

export const acquireSubsetRunLock = ({ cwd = process.cwd(), env = process.env, deps = {} } = {}) => {
  const resolved = resolveFlowStorePath(cwd, env);
  if (resolved == null) {
    throw stop('not inside a git work tree (and no AW_FLOW_STORE override) — there is no flow store to serialize a subset run against');
  }
  const { lockPath, lockFd, lockIdentity } = acquireFlowLock(`${resolved}${SUBSET_RUN_LOCK_INFIX}`, env, deps);
  return { lockPath, release: () => releaseFlowLock(lockPath, lockFd, lockIdentity, deps) };
};

// The pre-gate append-lock readiness probe (round-8 fold): acquire and immediately release the
// ORDINARY append lock through the full acquire discipline — a DEAD/foreign/malformed lock or
// an unwritable parent surfaces BEFORE any gate spends, with the acquire's own named refusal.
// Stated residual: a lock landing between this probe and the post-run append still refuses at
// append time — closing that would mean holding the append lock across the whole gate run.
export const probeFlowAppendLock = ({ cwd = process.cwd(), env = process.env, deps = {} } = {}) => {
  const resolved = resolveFlowStorePath(cwd, env);
  if (resolved == null) {
    throw stop('not inside a git work tree (and no AW_FLOW_STORE override) — there is no flow store to probe');
  }
  const { lockPath, lockFd, lockIdentity } = acquireFlowLock(resolved, env, deps);
  const issue = releaseFlowLock(lockPath, lockFd, lockIdentity, deps);
  if (issue != null) throw issue;
};

// appendSubsetAttempt — the Decision-7 locked append factory: the chain identity is captured
// BEFORE the gates run (the caller's `expected` {planId, cycle, stepId, round}) and re-checked
// under the append lock against the OPEN owning chain; attemptIndex, foldBatch/subsetDigest
// derivation, and the hard-stop state are computed from the captured store snapshot INSIDE the
// critical section — a concurrent appender never duplicates an index, and a round/park/complete
// landing mid-run refuses the append (never a silent misfile). subsetGateIds states what the
// caller RAN — only the caller knows that — but it never DECIDES the counting context: the
// factory re-derives the subset from the declaration + config itself (the R10 rider, via the
// gates-declaration leaf) and refuses a mismatch, so a caller-chosen id list can never forge a
// fresh subsetDigest and bypass the hard-stop budget.
export const appendSubsetAttempt = ({ cwd = process.cwd(), env = process.env, deps = {}, expected, subsetGateIds, status, diagnosis = null, base, fingerprint, timestamp = new Date().toISOString() } = {}) => {
  const owner = deriveFlowOwner(cwd);
  if (owner == null) throw stop('not inside a git work tree — the subset-attempt mint derives the owning worktree from git (fail closed)');
  if (expected == null || typeof expected.planId !== 'string' || expected.planId.length === 0
    || !Number.isInteger(expected.cycle) || !Number.isInteger(expected.round)
    || (expected.stepId !== null && typeof expected.stepId !== 'string')) {
    throw stop('the captured chain identity must be {planId, cycle, stepId|null, round} — the factory re-checks exactly this projection under the lock (fail closed)');
  }
  if (!Array.isArray(subsetGateIds)) throw stop("subsetGateIds must be the derived subset's ordered gate-id array (fail closed)");
  if (status !== 'green' && status !== 'red') throw stop(`status must be green | red (got ${JSON.stringify(status)}) — an unrunnable subset refuses with NO attempt record (fail closed)`);
  if (diagnosis !== null && (typeof diagnosis !== 'string' || diagnosis.length === 0)) {
    throw stop(`diagnosis must be null or a non-empty string (got ${JSON.stringify(diagnosis)}) — a mistyped input would otherwise record diagnosis-less silently (round-11 fold; fail closed)`);
  }
  let derived;
  try {
    derived = derivePregateSubsetIds(cwd);
  } catch (err) {
    throw stop(`the pregate subset cannot be re-derived (${(err && err.message) || err}) — an attempt records only a subset the declaration derives (R10; fail closed)`);
  }
  if (derived.length !== subsetGateIds.length || derived.some((id, i) => id !== subsetGateIds[i])) {
    throw stop(`subsetGateIds [${subsetGateIds.join(', ')}] does not match the subset derived from ${GATES_REL} + ${CONFIG_REL} flow.pregateExclude [${derived.join(', ')}] — the factory re-derives the subset itself (R10), so a caller-chosen id list never binds a counting context (fail closed)`);
  }
  // Everything downstream binds the factory-owned DERIVED ids — the caller array stays mutable in
  // the caller's hands (a deps lock-hook could rewrite it after the check above) and must never
  // reach the digest domain.
  const subsetIds = Object.freeze([...derived]);
  let minted = null;
  const value = appendResolvedFlowRecord({ cwd, env, deps, makeRecord: (records) => {
    const chain = records.filter((r) => r.kind === CHAIN_KIND && r.planId === expected.planId);
    if (chain.length === 0) throw stop(`no chain exists for plan "${expected.planId}" under the lock — the captured identity is stale; re-run the subset under the current context (fail closed)`);
    const seq = validateChainSequence(chain);
    if (!seq.ok) throw stop(`the plan "${expected.planId}" chain is illegal under the lock (${seq.reason}) — refusing to bind an attempt to it (fail closed)`);
    if (chain[0].owner !== owner) throw stop(`the plan "${expected.planId}" chain is owned by "${chain[0].owner}", not this worktree ("${owner}") — a foreign chain never records this tree's attempts (fail closed)`);
    const state = walkChainState(chain);
    const open = !state.completed && !state.parked;
    const held = open && state.cycle === expected.cycle && state.stepId === expected.stepId && (state.round ?? 0) === expected.round;
    if (!held) {
      const shown = state.completed ? 'the plan completed' : state.parked ? 'the plan parked' : `the open context is {cycle ${state.cycle}, step ${JSON.stringify(state.stepId)}, round ${state.round ?? 0}}`;
      throw stop(`the chain identity moved under the run — captured {cycle ${expected.cycle}, step ${JSON.stringify(expected.stepId)}, round ${expected.round}}, but ${shown} under the lock (a round/park/complete landed mid-run); re-run the subset under the current context (fail closed)`);
    }
    if (expected.stepId === null && state.openers.length > 0) {
      throw stop(`the plan "${expected.planId}" chain sits at a post-convergence boundary — the stepId-null context is legal only before the FIRST round (the adoption context, round-6 fold); open the next step round first (fail closed)`);
    }
    // Round-9 fold: the EXACTLY-ONE-open-owning-chain rule is re-derived UNDER the lock — an
    // adoption/resume landing after the caller's preflight would otherwise record the attempt
    // into an already-ambiguous context. (After the specific refusals above, so a parked or
    // moved TARGET chain keeps its own named diagnosis.)
    const openOwn = [...new Set(records.filter((r) => r.kind === CHAIN_KIND && r.owner === owner).map((r) => r.planId))].filter((planId) => {
      const c = records.filter((r) => r.kind === CHAIN_KIND && r.planId === planId);
      if (c[0].purpose !== 'adoption' || c[0].owner !== owner || !validateChainSequence(c).ok) return false;
      const s = walkChainState(c);
      return !s.completed && !s.parked;
    });
    if (openOwn.length !== 1 || openOwn[0] !== expected.planId) {
      throw stop(`this worktree ("${owner}") owns ${openOwn.length} open chains under the lock (${openOwn.join(', ') || 'none'}) — an attempt records only when exactly ONE open owning chain exists and it is the captured one ("${expected.planId}"); a chain landed mid-run — re-run the subset under the current context (fail closed)`);
    }
    const probe = { planId: expected.planId, cycle: expected.cycle, stepId: expected.stepId, foldBatch: subsetFoldBatchDigest(expected), subsetDigest: subsetGateIdsDigest(subsetIds) };
    const budget = subsetAttemptState(records, probe);
    const attemptIndex = budget.nextIndex;
    if (budget.reds >= SUBSET_ATTEMPT_DIAGNOSIS_REDS && (typeof diagnosis !== 'string' || diagnosis.length === 0)) {
      throw stop(`attempt ${attemptIndex} follows ${budget.reds} reds at this counting context and requires a recorded diagnosis (Decision 8 — the blind budget is spent): investigate, then re-run with a non-empty diagnosis byte-distinct from the prior attempt's; never a wait-for-maintainer`);
    }
    if (attemptIndex < SUBSET_ATTEMPT_DIAGNOSIS_FROM && diagnosis != null) {
      throw stop(`attempt ${attemptIndex} is inside the blind budget (attempts 1-2) — a diagnosis rides only attempt ${SUBSET_ATTEMPT_DIAGNOSIS_FROM} and later (Decision 8); drop the diagnosis input (the captured context may be stale — fail closed, never silently dropped)`);
    }
    const { line, snapshot } = captureRecordSnapshot({
      schema: FLOW_SCHEMA_VERSION, kind: 'subset-attempt', planId: expected.planId, cycle: expected.cycle,
      stepId: expected.stepId, foldBatch: probe.foldBatch, subsetDigest: probe.subsetDigest, attemptIndex,
      ...(typeof diagnosis === 'string' ? { diagnosis } : {}), status, base, fingerprint, timestamp,
    });
    // Computed UNDER the lock from the captured snapshot — a lock-free preflight state could
    // pick the wrong message under a concurrent append.
    const consumedPermit = budget.reds >= SUBSET_ATTEMPT_MAX_REDS;
    const redsAfter = budget.reds + (status === 'red' ? 1 : 0);
    const creditsAfter = budget.credits - (consumedPermit ? 1 : 0);
    minted = {
      attemptIndex,
      redsAtKey: redsAfter,
      reopened: consumedPermit,
      exhaustedAfter: redsAfter >= SUBSET_ATTEMPT_MAX_REDS && creditsAfter <= 0,
    };
    return { line, snapshot };
  } });
  return { ...value, ...minted, digest: canonicalFlowDigest(value.record) };
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

// ── the adoption mint (#58) — frontmatter planId + plan content digest, read-only plan file ──────

const PLAN_ID_FRONTMATTER_HINT = 'planId: <your-stable-plan-id>';

// Identity binds only a CLOSED leading frontmatter block — an unterminated block never yields an
// id; CRLF is normalized per line so line endings never fork chain identity.
export const readPlanFrontmatterId = (text) => {
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

