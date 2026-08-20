// store-append.mjs — the PARAMETERIZED lock/CAS serialized-append leaf (delegation Plan 1, Phase 2,
// D12). Extracted VERBATIM from the flow store, whose write door flow-append.mjs is now its first
// caller; the delegation store (dispatch-store.mjs) is the second. No CLI, no side effects on import.
//
// Why a leaf rather than an import of the flow appender: `appendFlowRecordWithPreflight` hardwires
// the AW_FLOW_STORE seam and validateFlowRecord, so a second store could only reuse it by pretending
// to be the flow store. Everything store-SPECIFIC is injected instead — the path resolution, the env
// seam and knob names, the typed-STOP factory, the record validator, the store-text parser, and the
// semantic preflight — while the DISCIPLINE stays here in exactly one copy: bounded lock waits with
// named refusals per holder class, custody-checked release (only the inode the winning CAS fd proved
// is ever removed), fd-based no-follow reads, snapshot-bound rename guarding, and an append that
// runs its caller's semantic preflight on ONE captured snapshot inside the critical section.
//
// The nouns are parameters because the refusal messages are the user contract: a store's refusals
// must name THAT store. `nouns.adj` is the hyphenated adjective form ("flow-store" → "flow-store
// lock", "flow-store parent dir"), `nouns.store` the standalone noun ("flow store"), `nouns.record`
// what a rejected line is called ("flow record").
//
// Declared residuals no dependency-free core-Node mechanism can close (inherited unchanged from the
// extraction source): the pathname lstat→rename and reread→rename windows (no flock/fcntl, no
// inode-conditional unlink or rename) and bind-mount aliasing. Records remain forgeable — this is a
// self-discipline mechanism, not a security boundary.

import { readSync, rmSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, renameSync, writeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { hostname } from 'node:os';
import { writeContainedFileAtomic, lstatNoFollow } from './atomic-write.mjs';
import { parsePositiveIntKnob } from './changed-surface.mjs';
import { readRegularFileNoFollow, describeNonRegular } from './fs-read-nofollow.mjs';

// Wait bound + poll cadence defaults; a lane may override either, and the env knobs keep hermetic
// tests off wall-clock.
export const DEFAULT_LOCK_WAIT_MS = 10_000;
export const DEFAULT_LOCK_POLL_MS = 100;

// Sync sleep (the append is a sync flow end-to-end); injectable so a hermetic test can intercept it.
const sleepSyncMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Monotonic — a system clock stepped backwards must not stretch the wait bound.
const monotonicNowMs = () => performance.now();

// POSIX single-quoting for paths pasted into recovery commands — a raw interpolation would execute
// path bytes on paste.
const shellQuotePath = (p) => `'${p.replaceAll("'", "'\\''")}'`;

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

// createStoreAppendLane(config) → the append surface for ONE store. Every message the lane emits
// names that store; every seam it opens is the caller's.
//   nouns          { store, adj, record } — the refusal vocabulary (see the header)
//   envNames       { store, waitKnob, pollKnob } — the override seam + the two lock knobs
//   stop           the typed-STOP factory (one per store, so callers can classify by code)
//   resolveStorePath(cwd, env) → absolute path, or null when there is no store to write
//   resolveLockPath(storePath) → the sibling lock path
//   validateRecord(snapshot) → { ok } | { ok: false, reason }
//   parseStoreText(raw) → { records, malformed, malformedReasons }
//   lockWaitMs / lockPollMs — the defaults the env knobs override
export const createStoreAppendLane = ({
  nouns, envNames, stop, resolveStorePath, resolveLockPath, validateRecord, parseStoreText,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS, lockPollMs = DEFAULT_LOCK_POLL_MS,
}) => {
  const LOCK_NOUN = `${nouns.adj} lock`;

  const foreignObjectStop = (noun, path, className, isDirectory) =>
    stop(`the ${noun} ${path} is a ${className}, not a regular file — refusing to touch it. To recover: inspect it, then remove it by hand: ${isDirectory ? 'rmdir' : 'rm'} -- ${shellQuotePath(path)} — it is never removed silently (fail closed)`);

  // A non-regular object at the store or lock path is never read (a FIFO read blocks forever) and
  // never removed silently — an immediate named refusal. Returns the lstat result (null = absent).
  const assertRegularOrAbsent = (path, noun, lstat) => {
    const st = lstatNoFollow(path, lstat);
    if (st && !st.isFile()) throw foreignObjectStop(noun, path, describeNonRegular(st), st.isDirectory());
    return st;
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
  const canonicalWritePaths = (resolvedStorePath, lstat) => {
    const parent = dirname(resolvedStorePath);
    if (lstatNoFollow(parent, lstat)?.isSymbolicLink()) {
      throw stop(`${parent} is a symlink — refusing to write the ${nouns.store} through a symlinked parent (pre-mutation containment)`);
    }
    let canonicalParent;
    try {
      canonicalParent = realpathSync(parent);
    } catch (err) {
      if (err && err.code === 'ENOENT') canonicalParent = parent;
      else throw stop(`cannot canonicalize the ${nouns.adj} parent dir ${parent} (${(err && err.code) || (err && err.message) || err}) — refusing to write through an unresolvable path (fail closed)`);
    }
    const storePath = join(canonicalParent, basename(resolvedStorePath));
    const lockPath = resolveLockPath(storePath);
    assertRegularOrAbsent(storePath, nouns.store, lstat);
    assertRegularOrAbsent(lockPath, LOCK_NOUN, lstat);
    return { storePath, lockPath };
  };

  // Returns the OWNED canonical { storePath, lockPath, lockFd, lockIdentity }; throws BEFORE
  // ownership on every refusal lane. The caller must reuse exactly these values end-to-end.
  const acquireLock = (resolvedStorePath, env, deps) => {
    const lstat = deps.lstat ?? lstatSync;
    const openLock = deps.openLock ?? ((p) => openSync(p, 'wx'));
    const sleep = deps.sleep ?? sleepSyncMs;
    const now = deps.now ?? monotonicNowMs;
    const waitBoundMs = parseLockKnob(env, envNames.waitKnob, lockWaitMs);
    const pollMs = parseLockKnob(env, envNames.pollKnob, lockPollMs);
    const { storePath, lockPath } = canonicalWritePaths(resolvedStorePath, lstat);
    const holderBody = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
    const deadline = now() + waitBoundMs;
    // Every retry lane passes this gate — else lock churn extends the wait past the bound forever.
    const refuseIfPastDeadline = (why) => {
      if (now() >= deadline) {
        throw stop(`the ${LOCK_NOUN} ${lockPath} could not be acquired within the ${waitBoundMs}ms wait (${why}) — retry, or raise ${envNames.waitKnob}`);
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
          throw stop(`cannot create the ${LOCK_NOUN} ${lockPath} (${(err && err.code) || (err && err.message) || err}) — the store's parent dir must exist and be writable`);
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
          throw stop(`cannot stamp or verify the just-created ${LOCK_NOUN} ${lockPath} (${(err && err.code) || (err && err.message) || err}) — the lock file is left in place; inspect it, then remove it by hand: rm -- ${shellQuotePath(lockPath)} (fail closed)`);
        } finally {
          if (!won) { try { closeSync(fd); } catch { /* the stamp failure above already decided the lane */ } }
        }
      }
      // The holder read HOLDS its fd (keepFd) until the lane decides: while the fd is open the
      // inode cannot be recycled, so the DEAD re-verify below can trust an identity match only
      // together with the held inode still being linked (FLOW-LOCK-HOLDER-FD-RECHECK). The lane
      // verdict is computed FIRST (its error captured), the held fd then closes unconditionally,
      // and a close failure is a typed STOP — thrown alone, or preserved on the primary error as
      // holderCloseFailure (the release never-mask discipline; P28).
      const holderIo = deps.holderIo ?? {};
      // The read itself is wrapped: on the early error/foreign lanes the reader closes its own fd
      // in a finally, and a close throw there would otherwise escape as a RAW error outside the
      // typed-STOP guarantee.
      let holderRead;
      try {
        holderRead = readRegularFileNoFollow(lockPath, { ...holderIo, keepFd: true });
      } catch (err) {
        throw stop(`cannot read the ${LOCK_NOUN} holder (${(err && err.code) || (err && err.message) || err}) — the read/close custody failed (fail closed)`);
      }
      if (holderRead.closeFailure !== undefined) {
        throw stop(`cannot read the ${LOCK_NOUN} holder (${holderRead.closeFailure}) — the read/close custody failed (fail closed)`);
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
          if (holderRead.outcome === 'foreign') throw foreignObjectStop(LOCK_NOUN, lockPath, holderRead.className, holderRead.isDirectory);
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
              throw stop(`cannot re-verify the ${LOCK_NOUN} identity before the DEAD refusal (${(err && err.code) || (err && err.message) || err}) — refusing to guess (fail closed)`);
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
              throw stop(`cannot re-verify the ${LOCK_NOUN} through its held descriptor (${(err && err.code) || (err && err.message) || err}) — refusing to guess (fail closed)`);
            }
            if (heldNow.nlink === 0) {
              refuseIfPastDeadline('the observed dead holder was released (churn)');
              return { retry: true };
            }
            throw stop(`the ${LOCK_NOUN} ${lockPath} is held by a DEAD process (${describeHolder(holder)}) — a crashed appender left it behind. To recover: inspect it, then remove it by hand: rm -- ${shellQuotePath(lockPath)} — it is never stolen silently (a steal could tear a live append; fail closed)`);
          }
          // ONE observation drives the deadline check AND the sleep cap — no overshoot by a full poll.
          const observedAt = now();
          if (observedAt >= deadline) {
            if (!validHolder) {
              throw stop(`the ${LOCK_NOUN} ${lockPath} carries an UNREADABLE or malformed holder after the full ${waitBoundMs}ms wait — a crashed appender may have died before writing its holder line, or the file is corrupted. To recover: inspect it, then remove it by hand: rm -- ${shellQuotePath(lockPath)} — it is never stolen silently (fail closed)`);
            }
            if (holder.host !== hostname()) {
              throw stop(`the ${LOCK_NOUN} ${lockPath} is still held by pid ${holder.pid} on host ${holder.host} (liveness unprobeable from ${hostname()}) after the full ${waitBoundMs}ms wait — retry after that holder finishes, or raise ${envNames.waitKnob}`);
            }
            throw stop(`the ${LOCK_NOUN} ${lockPath} is still held by ${describeHolder(holder)} after the full ${waitBoundMs}ms wait — retry after the holder finishes, or raise ${envNames.waitKnob}`);
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
          const closeStop = stop(`cannot close the held ${nouns.adj} holder descriptor (${(err && err.code) || (err && err.message) || err}) — the fd-custody guarantee is violated (fail closed)`);
          if (primary == null) primary = closeStop;
          else primary.holderCloseFailure = closeStop.message;
        }
      }
      if (primary != null) throw primary;
      if (verdict.retry) continue;
      sleep(verdict.sleepMs);
    }
  };

  // ONE custody-checked release: only the inode the winning fd proved is ever removed (the fd is
  // still open, so a pathname {dev, ino} match is proof of the same file); absent or replaced =
  // a mutual-exclusion violation, the foreign lock stays. Closes the fd on EVERY outcome without
  // losing a close failure. Returns a typed STOP or null, never throws — the caller sequences it
  // after the body's own error so neither masks the other.
  const releaseLock = (lockPath, lockFd, lockIdentity, deps) => {
    const lstat = deps.lstat ?? lstatSync;
    const rm = deps.rm ?? ((p) => rmSync(p, { force: true }));
    const close = deps.close ?? closeSync;
    let issue = null;
    let st = null;
    try {
      st = lstatNoFollow(lockPath, lstat); // null ONLY on a true ENOENT
    } catch (err) {
      issue = stop(`cannot verify the ${LOCK_NOUN} before release (${(err && err.code) || (err && err.message) || err}) — the lock is left in place; inspect ${lockPath} (fail closed)`);
    }
    if (issue == null) {
      if (st == null || st.dev !== lockIdentity.dev || st.ino !== lockIdentity.ino) {
        issue = stop(`the ${LOCK_NOUN} ${lockPath} was removed or replaced under this append — mutual exclusion was violated and another appender may have run concurrently; the current lock (if any) is left untouched; inspect the store and the lock (fail closed)`);
      } else {
        try {
          rm(lockPath);
        } catch (err) {
          issue = stop(`cannot remove the ${LOCK_NOUN} at release (${(err && err.code) || (err && err.message) || err}) — inspect ${lockPath} (fail closed)`);
        }
      }
    }
    try {
      close(lockFd);
    } catch (err) {
      const closeStop = stop(`cannot close the ${LOCK_NOUN} descriptor at release (${(err && err.code) || (err && err.message) || err})`);
      if (issue == null) issue = closeStop;
      else issue.closeFailure = closeStop.message;
    }
    return issue;
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
    const v = validateRecord(snapshot);
    if (!v.ok) throw stop(`refusing to write a malformed ${nouns.record}: ${v.reason}`);
    return { line, snapshot };
  };

  // Captured-result shape ({ value } | { err }) — never throws past the caller, so release always
  // runs. The snapshot fd is held until after the final rename and closed on every exit lane.
  // `preflight({ records, snapshot, line, storePath })` is the caller's SEMANTIC half: it runs on
  // the locked snapshot after the byte-replay refusal and throws its own named stops.
  const appendUnderLock = ({ storePath, makeRecord, preflight, deps }) => {
    let snapshotFd = null;
    try {
      const storeRead = readRegularFileNoFollow(storePath, { keepFd: true });
      if (storeRead.outcome === 'ok') snapshotFd = storeRead.fd;
      if (storeRead.outcome === 'foreign') throw foreignObjectStop(nouns.store, storePath, storeRead.className, storeRead.isDirectory);
      if (storeRead.outcome === 'error') throw stop(`cannot read the ${nouns.store} before appending (${storeRead.code}) — refusing to overwrite it (fail closed)`);
      // A second hard-link path would derive its OWN lock and the two appends would race one inode.
      if (storeRead.outcome === 'ok' && storeRead.nlink !== 1) {
        throw stop(`the ${nouns.store} ${storePath} has ${storeRead.nlink} hard links — two path-derived locks would race one inode; remove the extra links and retry (fail closed)`);
      }
      const existing = storeRead.outcome === 'absent' ? '' : storeRead.content;
      const parsed = parseStoreText(existing);
      if (parsed.malformed > 0) {
        throw stop(`refusing to append to a ${nouns.store} carrying ${parsed.malformed} malformed line(s) (${parsed.malformedReasons[0]}) — inspect ${storePath}; nothing was written (fail closed)`);
      }
      const { line, snapshot } = makeRecord(parsed.records);
      if (existing.split('\n').some((l) => l === line)) {
        throw stop('refusing a byte-identical replayed line (duplicate) — a genuine new record carries new content or timestamp; nothing was written');
      }
      if (preflight != null) preflight({ records: parsed.records, snapshot, line, storePath });
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
              throw stop(`cannot re-read the ${nouns.store} snapshot before the final rename (${(err && err.code) || (err && err.message) || err}) — nothing was written (fail closed)`);
            }
            if (!same) {
              throw stop(`the ${nouns.store} ${storePath} content changed under the lock (same-inode in-place mutation) — refusing the final rename; nothing was written (fail closed)`);
            }
          }
          let leaf = null;
          try {
            leaf = lstatNoFollow(to, deps.lstat ?? lstatSync);
          } catch (err) {
            throw stop(`cannot verify the ${nouns.store} leaf before the final rename (${(err && err.code) || (err && err.message) || err}) — nothing was written (fail closed)`);
          }
          const identityHeld = storeRead.outcome === 'absent'
            ? leaf == null
            : leaf != null && leaf.isFile() && leaf.dev === storeRead.dev && leaf.ino === storeRead.ino;
          if (!identityHeld) {
            throw stop(`the ${nouns.store} ${storePath} changed identity under the lock (concurrent or foreign mutation) — refusing the final rename; nothing was written (fail closed)`);
          }
          if (leaf != null && leaf.nlink !== 1) {
            throw stop(`the ${nouns.store} ${storePath} has ${leaf.nlink} hard links — two path-derived locks would race one inode; remove the extra links and retry (fail closed)`);
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

  // resolveOrStop(cwd, env, purpose) → the absolute store path; the named refusal when there is
  // none. `purpose` completes the sentence ("append to", "probe", …) so every lane says what it
  // was about to do.
  const resolveOrStop = (cwd, env, purpose) => {
    const resolved = resolveStorePath(cwd, env);
    if (resolved == null) {
      throw stop(`not inside a git work tree (and no ${envNames.store} override) — there is no ${nouns.store} to ${purpose}`);
    }
    return resolved;
  };

  // The lock-serialized core every append lane shares: resolve → acquire → makeRecord (UNDER the
  // lock, over the captured store snapshot) → semantic preflight → atomic write → custody release.
  // A factory lane COMPUTES its record inside the critical section (a monotonic index or a budget
  // state cannot be derived lock-free), so makeRecord runs under the lock by contract.
  const appendResolvedRecord = ({ cwd, env, deps, makeRecord, preflight = null }) => {
    const resolved = resolveOrStop(cwd, env, 'append to');
    const { storePath, lockPath, lockFd, lockIdentity } = acquireLock(resolved, env, deps);
    const body = appendUnderLock({ storePath, makeRecord, preflight, deps });
    const releaseIssue = releaseLock(lockPath, lockFd, lockIdentity, deps);
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

  return { resolveOrStop, acquireLock, releaseLock, captureRecordSnapshot, appendUnderLock, appendResolvedRecord };
};
