// dispatch-store.mjs — the delegation-ledger IO (delegation Plan 1, Phase 2): common-dir path
// resolution, the fail-closed reader, the lock-serialized append with its SEMANTIC preflight, and
// the ONE named tree-fingerprint contract the records bind. No CLI, no side effects on import; the
// engine (dispatch.mjs, Phase 3) is the only surface that mints records for a human.
//
// This is the measurement substrate's storage half. The vocabulary (closed record family, the
// outcome enum with its allowed-successor table, the metric byte domains) lives in the PURE
// dispatch-record.mjs and validates ONE record at a time; everything that needs a store SNAPSHOT
// lives here: thread transitions and terminality, return↔dispatch correlation, fold resolution,
// the retry rules, and the wave rules.
//
// Why its OWN store (D2), separate from the review receipts (`agent-workflow-review-receipts.jsonl`,
// per-git-dir) and the flow store (`agent-workflow-flow.jsonl`): a shared file would let one class
// of line answer another class of question — the exact defect the D10 discriminator closes on the
// review-waiter side. The parity is enforced from BOTH ends: a review receipt entering here is an
// unknown kind and the reader counts it malformed (the closed family fails closed), and a
// delegation line reaching the receipts store never satisfies a review waiter. The basename resolves
// to the git COMMON dir (the flow-store precedent) because delegation accounting is worktree-SHARED,
// and the `AW_DELEGATION_STORE` seam takes the AW_FLOW_STORE rules verbatim: absolute only, no
// trailing separator.
//
// The lock/CAS discipline is NOT re-implemented here — it is the shared store-append.mjs leaf (D12),
// so both stores fail closed the same way (bounded lock waits with named refusals per holder class,
// custody-checked release, fd-based no-follow reads, snapshot-bound rename guarding). This module
// supplies the nouns, the seams, the validator, the parser and the semantic preflight.
//
// Reference domains stay SPLIT (D3): a fold references a return by its per-record CANONICAL digest;
// thread linkage (`nonce`, `retryOf`) is by nonce identity. The family has NO supersession — a
// record is never superseded, only closed — so resolution never has to pick a "latest" of a key,
// and a fold whose returnDigest resolves cross-thread or not at all is a refusal, never a guess.
//
// Honest limits: records remain forgeable (a self-discipline mechanism in the git dir, not a
// security boundary); the fingerprint contract below is blind to the index↔worktree split, which is
// why the metric additionally requires the dispatch's recorded CLEAN baseline (D5); and the
// pathname-race residuals of the shared leaf are inherited as declared there.

import { join, isAbsolute, normalize, sep } from 'node:path';
import {
  validateDelegationRecord, canonicalDelegationDigest, allowedSuccessorKinds,
  isThreadTerminalRecord,
} from './dispatch-record.mjs';
import { computeTreeFingerprint } from './core-evidence.mjs';
import { gitLine } from './flow-store-read.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { createStoreAppendLane } from './store-append.mjs';

export const DELEGATION_STORE_STOP = 'DELEGATION_STORE_STOP';
// The ONE typed-STOP factory for this store — a caller classifies a delegation refusal by code.
export const delegationStoreStop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'DelegationStoreStop', code: DELEGATION_STORE_STOP });
const stop = delegationStoreStop;

export const DELEGATION_STORE_BASENAME = 'agent-workflow-delegation.jsonl';
export const DELEGATION_LOCK_SUFFIX = '.lock';

// ── path resolution (common dir + the AW_DELEGATION_STORE seam) ───────────────────────────────────

// resolveDelegationStorePath(cwd, env) → the ABSOLUTE store path, or null outside a git WORK tree.
// is-inside-work-tree gates explicitly (--git-common-dir also succeeds in a bare repo, and the probe
// prints "false" WITH exit 0, so the STRING is compared). The override must be absolute — a relative
// one would resolve a different ledger from each worktree/cwd.
export const resolveDelegationStorePath = (cwd, env = process.env) => {
  if (env.AW_DELEGATION_STORE) {
    if (!isAbsolute(env.AW_DELEGATION_STORE)) {
      throw stop(`AW_DELEGATION_STORE must be an ABSOLUTE path (got "${env.AW_DELEGATION_STORE}") — a relative override resolves a different ledger from each worktree/cwd (fail closed)`);
    }
    const normalized = normalize(env.AW_DELEGATION_STORE);
    // A trailing separator survives normalize() but not the appender's basename/join — refuse the fork.
    if (normalized.endsWith(sep) || normalized.endsWith('/')) {
      throw stop(`AW_DELEGATION_STORE must not end with a path separator (got "${env.AW_DELEGATION_STORE}") — a store is a file, not a directory (fail closed)`);
    }
    return normalized;
  }
  if (gitLine(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') return null;
  const commonDir = gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return commonDir == null ? null : join(commonDir, DELEGATION_STORE_BASENAME);
};

// The lock is a SIBLING derived from the resolved store path — one store, one lock, everywhere.
export const resolveDelegationLockPath = (storePath) => `${storePath}${DELEGATION_LOCK_SUFFIX}`;

// ── the fail-closed reader ────────────────────────────────────────────────────────────────────────

// parseDelegationStoreText(raw) → { records, malformed, malformedReasons }. RAW file order is the
// only view: thread legality is an ordering property, and the family has no supersession, so there
// is no "authoritative" projection to compute. A line the closed family does not recognise — a
// review receipt included — is MALFORMED, never silently skipped.
export const parseDelegationStoreText = (raw) => {
  const records = [];
  const recordLines = [];
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
    const v = validateDelegationRecord(parsed);
    if (v.ok) {
      records.push(parsed);
      // The PHYSICAL line, carried beside the record: a reader that refuses has to say WHERE, and
      // the record's index in a filtered array is not a place anyone can open.
      recordLines.push(i + 1);
    } else malformedReasons.push(`line ${i + 1}: ${v.reason}`);
  }
  return { records, recordLines, malformed: malformedReasons.length, malformedReasons };
};

// readDelegationStore(path, io?) → { records, malformed, malformedReasons, readError? }. Absent →
// empty (no records yet is not an error); any other failure → readError, and consumers fail closed
// on malformed > 0 or readError. A dangling symlink must NOT read as an empty ledger.
export const readDelegationStore = (path, io = {}) => {
  const empty = () => ({ records: [], recordLines: [], malformed: 0, malformedReasons: [] });
  const read = readRegularFileNoFollow(path, io);
  if (read.outcome === 'absent') return empty();
  if (read.outcome === 'foreign') return { ...empty(), readError: `the store is a ${read.className}, not a regular file — refusing to read it (fail closed)` };
  if (read.outcome === 'error') return { ...empty(), readError: read.code };
  return parseDelegationStoreText(read.content);
};

// ── D5: the ONE named tree-fingerprint contract ───────────────────────────────────────────────────

// Every tree digest this family records — a dispatch's preTreeDigest, a return's postTreeDigest, a
// fold's treeDigestAtFold — is THIS ONE computation, so two records can be compared for equality at
// all. The helper DELEGATES to the frozen core rather than re-deriving the payload: a second
// implementation of "the uncommitted state" is exactly how two digests of one tree would appear.
//
// Domain (pinned by the parity fixtures): staged diff + unstaged diff + untracked-not-ignored
// contents; an untracked symlink contributes name+target, an untracked directory or unstatable path
// contributes its name only, a binary file contributes a marker, and the never-committable classes
// (character device, block device, FIFO, socket) are excluded ENTIRELY — no marker at all.
//
// Honest limit, stated where it bites: the domain is blind to the index↔worktree split (the staged
// and unstaged diffs are concatenated), so a hunk moving into the index leaves it unchanged. That is
// why metric eligibility additionally requires the dispatch's recorded CLEAN baseline (D5) — the
// fingerprint alone cannot attribute bytes to a dispatch.
export const UNCOMMITTED_STATE_FINGERPRINT = 'the uncommitted-state fingerprint';

export const uncommittedStateFingerprint = (cwd = process.cwd(), fsx) => {
  const fingerprint = computeTreeFingerprint(cwd, fsx);
  if (fingerprint == null) {
    throw stop(`cannot compute ${UNCOMMITTED_STATE_FINGERPRINT} — not inside a git work tree (or a git probe failed); a record never carries a null tree digest (fail closed)`);
  }
  return fingerprint;
};

// ── thread state (the store's ONE walk; the Phase-3 aggregator consumes it) ───────────────────────

const THREAD_KINDS = ['dispatch', 'return', 'fold', 'degrade'];

// delegationThreadState(records, nonce) → { records, dispatch, return, closure, last, terminal, open }
// over ONE nonce thread in RAW file order. A pre-dispatch degrade carries nonce null and therefore
// belongs to no thread. Terminality is the vocabulary's own predicate — never re-derived here.
export const delegationThreadState = (records, nonce) => {
  const thread = records.filter((r) => THREAD_KINDS.includes(r.kind) && r.nonce === nonce);
  const last = thread.length === 0 ? null : thread[thread.length - 1];
  const dispatch = thread.find((r) => r.kind === 'dispatch') ?? null;
  const terminal = last !== null && isThreadTerminalRecord(last);
  return {
    records: thread,
    dispatch,
    return: thread.find((r) => r.kind === 'return') ?? null,
    closure: thread.find((r) => r.kind === 'fold' || r.kind === 'degrade') ?? null,
    last,
    terminal,
    open: dispatch !== null && !terminal,
  };
};

// The cap that binds a retry chain is the ORIGIN's — walking back to retryIndex 0. A later contract
// may legitimately differ (a contract-refusal retry MUST differ), so reading the cap off the newest
// contract would let a fresh header manufacture a fresh budget. The seen-set is a tampered-store
// guard: an unresolvable or cyclic chain stops at the strictest link proven so far.
const retryChainOrigin = (records, dispatch) => {
  let current = dispatch;
  const seen = new Set([current.nonce]);
  while (current.retryOf !== null) {
    const prior = records.find((r) => r.kind === 'dispatch' && r.nonce === current.retryOf);
    if (prior === undefined || seen.has(prior.nonce)) return current;
    seen.add(prior.nonce);
    current = prior;
  }
  return current;
};

const closureLabel = (last) =>
  last.kind === 'fold' ? 'its fold'
    : last.kind === 'degrade' ? 'its recorded degrade'
      : `a terminal return (outcome "${last.outcome}")`;

// The kinds that name a wave and therefore require it to be REGISTERED first.
const WAVE_SCOPED_KINDS = ['dispatch', 'observation', 'degrade'];

// ── the semantic preflight (runs INSIDE the critical section, on the LOCKED snapshot) ─────────────

// Everything a single record cannot decide about itself. A writer's lock-free walk is advisory: only
// the snapshot under the lock can refuse a second dispatch, a stale return or a retry of a thread
// that closed a millisecond ago. Every refusal names the rule it enforces and states that nothing
// was written.
const delegationSemanticPreflight = ({ records, snapshot, storePath }) => {
  // Byte-identical replay is the lane's own refusal; this is the CANONICAL one — a key-order
  // permutation serializes differently but IS the same record, and the digest is record identity.
  const digest = canonicalDelegationDigest(snapshot);
  if (records.some((r) => canonicalDelegationDigest(r) === digest)) {
    throw stop(`refusing a canonical duplicate: ${storePath} already carries this exact record (${digest.slice(0, 12)}…), however its keys are ordered — a genuine new record carries new content or a new timestamp; nothing was written`);
  }

  // The registration is RESOLVED and READ, not merely found: it fixes the classes, the pairing key
  // and the minimum per class BEFORE the first observation it will count, so a record naming a
  // class the wave never registered would invent an acceptance set after the fact.
  const registration = records.find((r) => r.kind === 'pre-registration' && r.waveId === snapshot.waveId);
  if (snapshot.kind === 'pre-registration') {
    if (registration !== undefined) {
      throw stop(`refusing a second pre-registration: the wave "${snapshot.waveId}" is already registered and a registration is IMMUTABLE per wave — thresholds a wave was registered under can never move under its own observations; nothing was written`);
    }
  } else if (WAVE_SCOPED_KINDS.includes(snapshot.kind)) {
    if (registration === undefined) {
      throw stop(`refusing a ${snapshot.kind} that names the UNREGISTERED wave "${snapshot.waveId}" — acceptance is PRE-REGISTERED before the first observation it will count, so the thresholds can never be chosen after the fact; register the wave first; nothing was written`);
    }
    if (!registration.stepClasses.includes(snapshot.stepClass)) {
      throw stop(`refusing a ${snapshot.kind}: step class "${snapshot.stepClass}" is not among the classes wave "${snapshot.waveId}" registered (${registration.stepClasses.join(' | ')}) — the registered set IS the acceptance set; nothing was written`);
    }
  }

  const nonce = typeof snapshot.nonce === 'string' ? snapshot.nonce : null;
  if (nonce === null) return; // a pre-registration, an observation, or a pre-dispatch degrade
  const state = delegationThreadState(records, nonce);

  if (snapshot.kind === 'dispatch') {
    if (state.dispatch !== null) {
      throw stop(`refusing a duplicate dispatch: nonce "${nonce}" already carries a dispatch — a nonce IS the thread identity and is minted once; nothing was written`);
    }
    if (snapshot.retryOf !== null) {
      const prior = delegationThreadState(records, snapshot.retryOf);
      if (prior.dispatch === null) {
        throw stop(`refusing a retry: no dispatch for nonce "${snapshot.retryOf}" is in the store — a retry names the thread it retries; nothing was written`);
      }
      // At most ONE retry successor per thread. Bounding only the chain's DEPTH would leave its
      // BRANCHING free — n2, n3, n4 … all legally at retryIndex 1 — and the cap would be decorative.
      // It is also what retryChainOrigin already assumes when it walks back to index 0.
      const successor = records.find((r) => r.kind === 'dispatch' && r.retryOf === snapshot.retryOf);
      if (successor !== undefined) {
        throw stop(`refusing a retry: thread "${snapshot.retryOf}" already has the retry successor "${successor.nonce}" — a thread is retried at most ONCE, or the recorded cap would bound only the chain's depth while its branching stayed free; nothing was written`);
      }
      if (!prior.terminal) {
        throw stop(`refusing a retry: thread "${snapshot.retryOf}" is still OPEN — a thread is retried only after it closed (a success or acceptance-failure return stays live until its fold or degrade); nothing was written`);
      }
      // Terminality alone is not enough: a FOLD is also terminal, and a folded thread's work was
      // accepted into the tree. Retrying it would mint a second counted thread over the same work
      // (D7 counts a folded success in `n` with its metric), inflating both the count and the mean.
      // The legal retry origins are the ones that recorded a FAILED attempt: a terminal-failure
      // return, or a degrade (the recorded no-fold closure).
      if (prior.last.kind === 'fold') {
        throw stop(`refusing a retry: thread "${snapshot.retryOf}" was closed by its fold — folding accepts the attempt into the tree, so a folded thread is never a retry origin whatever its return's outcome was; open a NEW thread instead; nothing was written`);
      }
      if (snapshot.retryIndex !== prior.dispatch.retryIndex + 1) {
        throw stop(`refusing a retry: retryIndex ${snapshot.retryIndex} must be ${prior.dispatch.retryIndex + 1} — a retry increments its origin's index by exactly one, so the chain length is the index; nothing was written`);
      }
      if (snapshot.waveId !== prior.dispatch.waveId) {
        throw stop(`refusing a retry: it names wave "${snapshot.waveId}" but its retry origin "${snapshot.retryOf}" was dispatched in wave "${prior.dispatch.waveId}" — a retry stays in its origin's wave, or one thread would count in two acceptance sets; nothing was written`);
      }
      if (snapshot.stepClass !== prior.dispatch.stepClass) {
        throw stop(`refusing a retry: it declares step class "${snapshot.stepClass}" but its retry origin "${snapshot.retryOf}" was dispatched as "${prior.dispatch.stepClass}" — the pairing key is the step class, so a chain that changes it mid-way would split one attempt's accounting across two classes; nothing was written`);
      }
      const origin = retryChainOrigin(records, prior.dispatch);
      if (snapshot.retryIndex > origin.retryCap) {
        throw stop(`refusing a retry: retryIndex ${snapshot.retryIndex} exceeds the retryCap ${origin.retryCap} recorded on the thread's ORIGIN dispatch ("${origin.nonce}") — a fresh contract never manufactures a fresh retry budget; nothing was written`);
      }
      if (prior.return !== null && prior.return.outcome === 'contract-refusal' && snapshot.contractDigest === prior.dispatch.contractDigest) {
        throw stop(`refusing a retry: it retries a contract-refusal thread and must carry a DIFFERENT contractDigest — an unchanged contract would only be refused again, and a retry loop on one contract is exactly what the cap exists to prevent; nothing was written`);
      }
    }
    return;
  }

  if (state.dispatch === null) {
    throw stop(`refusing a ${snapshot.kind}: no dispatch for nonce "${nonce}" is in the store — a thread opens with its dispatch, and a record that binds to nothing is never absorbed; nothing was written`);
  }
  if (snapshot.kind === 'return' && state.return !== null) {
    throw stop(`refusing a second return: nonce "${nonce}" already carries a return (outcome "${state.return.outcome}") — one dispatch answers exactly once, so a stale return never lands; nothing was written`);
  }
  const allowed = allowedSuccessorKinds(state.last);
  if (!allowed.includes(snapshot.kind)) {
    throw stop(state.terminal
      ? `refusing a ${snapshot.kind}: thread "${nonce}" is already closed by ${closureLabel(state.last)} — a closed thread never absorbs another record; nothing was written`
      : `refusing a ${snapshot.kind}: nonce "${nonce}" carries no return to fold — the thread's last record is a ${state.last.kind}, whose only legal successors are ${allowed.join(' | ')}; nothing was written`);
  }

  if (snapshot.kind === 'return') {
    // The nonce binds the thread; these three bind the IDENTITY of what was dispatched — a return
    // from another backend, against another contract, or from another tree is not this answer.
    for (const field of ['backend', 'contractDigest', 'preTreeDigest']) {
      if (snapshot[field] !== state.dispatch[field]) {
        throw stop(`refusing a return: ${field} "${snapshot[field]}" does not equal its dispatch's "${state.dispatch[field]}" — a return is bound to the dispatch it answers by nonce AND by identity; nothing was written`);
      }
    }
    // D5's directional implication, enforced where it CAN be: `baselineClean` lives on the DISPATCH,
    // so the record validator had to admit `dirty-baseline` without being able to verify it. A dirty
    // baseline FORCES ineligibility — but never renames a STRICTER reason the return's own fields
    // already substantiate (the validator pinned that one locally, and the producer can prove it);
    // a CLEAN baseline forbids the claim outright, so an eligible metric is never silently
    // downgraded by an unsubstantiated override.
    if (state.dispatch.baselineClean === false) {
      if (snapshot.metric.eligible) {
        throw stop(`refusing a return: its dispatch recorded baselineClean:false, so the metric is INELIGIBLE — the uncommitted-state fingerprint is blind to the index↔worktree split, so a dirty baseline cannot attribute bytes to this dispatch (D5); record eligible:false with ineligibleReason "dirty-baseline" (or the stricter reason this return's own fields substantiate); nothing was written`);
      }
    } else if (snapshot.metric.ineligibleReason === 'dirty-baseline') {
      throw stop(`refusing a return: it claims ineligibleReason "dirty-baseline" while its dispatch recorded baselineClean:true — the override is unsubstantiated, and only the dispatch decides that fact; nothing was written`);
    }
  }

  if (snapshot.kind === 'degrade') {
    // A degrade CLOSES a thread, and a closed thread counts in its wave's aggregation with L = 0
    // (D7). Left unbound, a degrade declaring another (registered) wave or class would report one
    // thread into two acceptance sets — the same reason the cross-wave retry rule exists.
    for (const field of ['waveId', 'stepClass']) {
      if (snapshot[field] !== state.dispatch[field]) {
        throw stop(`refusing a degrade: ${field} "${snapshot[field]}" does not equal its dispatch's "${state.dispatch[field]}" — a thread is closed inside the wave and step class it was dispatched in; nothing was written`);
      }
    }
  }

  if (snapshot.kind === 'fold') {
    const target = records.find((r) => canonicalDelegationDigest(r) === snapshot.returnDigest);
    if (target === undefined) {
      throw stop(`refusing a fold: returnDigest ${snapshot.returnDigest.slice(0, 12)}… matches no record in the store — a fold binds an EXISTING return by its canonical digest; nothing was written`);
    }
    if (target.kind !== 'return') {
      throw stop(`refusing a fold: returnDigest resolves to a ${target.kind} record, not a return — a fold folds a return; nothing was written`);
    }
    if (target.nonce !== nonce) {
      throw stop(`refusing a fold: returnDigest resolves to the return of nonce "${target.nonce}", not this fold's "${nonce}" — a fold never reaches across threads; nothing was written`);
    }
    if (snapshot.treeDigestAtFold !== target.postTreeDigest) {
      throw stop(`refusing a fold: treeDigestAtFold ${snapshot.treeDigestAtFold.slice(0, 12)}… does not equal the folded return's postTreeDigest ${target.postTreeDigest.slice(0, 12)}… — the tree moved between the return and the fold, so what was folded is not what was returned; nothing was written`);
    }
  }
};

// ── the read-side audit (the append path's rules, replayed) ───────────────────────────────────────

// auditDelegationStoreSemantics({ records, recordLines, storePath }) → { ok: true } | { ok: false,
// line, reason }. The reader validates ONE record at a time; every cross-record rule — duplicate
// nonce, transition legality, correlation, the wave and retry rules, canonical duplicates — lives in
// the append preflight and was never re-run on read, so a ledger the append path would have REFUSED
// still parsed as a pile of valid records. A consumer computing over it (the Phase-3 aggregator's
// per-thread walk) would count a duplicated nonce twice and inflate its own statistic.
//
// The replay closes that by running the SAME preflight per record against the prefix before it, in
// file order — so legality has ONE authority (this store) rather than a second, drifting copy in
// each reader. It stops at the FIRST illegal record and names its physical line; a consumer never
// computes over a "legal prefix", because a ledger that lost a record mid-file is not a smaller
// ledger, it is an unexplained one.
//
// Honest limit, unchanged: this is not a security boundary. A forger can write a fully consistent
// ledger just as easily. What the replay defends against is a BUGGY producer — the exec-side
// wrapper Plan 2 introduces — and a hand-edit that got the rules wrong.
export const auditDelegationStoreSemantics = ({ records, recordLines = [], storePath = '(store)' } = {}) => {
  for (let i = 0; i < records.length; i += 1) {
    try {
      delegationSemanticPreflight({ records: records.slice(0, i), snapshot: records[i], storePath });
    } catch (err) {
      return { ok: false, line: recordLines[i] ?? i + 1, reason: err.message };
    }
  }
  return { ok: true };
};

// ── the append ────────────────────────────────────────────────────────────────────────────────────

const delegationAppendLane = createStoreAppendLane({
  nouns: { store: 'delegation store', adj: 'delegation-store', record: 'delegation record' },
  envNames: { store: 'AW_DELEGATION_STORE', waitKnob: 'AW_DELEGATION_LOCK_WAIT_MS', pollKnob: 'AW_DELEGATION_LOCK_POLL_MS' },
  stop,
  resolveStorePath: resolveDelegationStorePath,
  resolveLockPath: resolveDelegationLockPath,
  validateRecord: validateDelegationRecord,
  parseStoreText: parseDelegationStoreText,
});

// The store path is always RESOLVED (cwd/env), never caller-supplied — a raw path param would bypass
// the absolute-normalization door the AW_DELEGATION_STORE seam enforces. The record is validated and
// serialized ONCE up front; the semantic rules then run under the lock on the captured snapshot.
export const appendDelegationRecord = ({ cwd = process.cwd(), record, env = process.env, deps = {} } = {}) => {
  const { line, snapshot } = delegationAppendLane.captureRecordSnapshot(record);
  return delegationAppendLane.appendResolvedRecord({
    cwd, env, deps, preflight: delegationSemanticPreflight, makeRecord: () => ({ line, snapshot }),
  });
};
