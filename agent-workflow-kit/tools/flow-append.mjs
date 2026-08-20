// flow-append.mjs — the flow store's ONE write door (flow-orchestration Phase 2, extracted from
// flow-store.mjs unchanged by baseline-practices tranche 2): the flow lane over the parameterized
// createStoreAppendLane, the SEMANTIC append preflight, the two generic append entries, the
// subset-run serializer + the pre-gate lock probe, and the Decision-7 locked subset-attempt factory.
//
// The lock/CAS discipline itself lives one module further down in store-append.mjs (delegation
// Plan 1 D12); this leaf injects the flow store's nouns, env seams, knob names, validator, parser
// and the per-kind legality the lane runs inside the critical section.
//
// Imports run ONE way: this module composes the two PURE leaves (flow-chain-state.mjs,
// flow-subset-budget.mjs) and the read half; the two mint leaves compose THIS one. Nothing here
// reaches back up to the flow-store.mjs facade — that edge would be the cycle
// test/read-graph-purity.test.mjs reds.
//
// flowSemanticPreflight, deepFreezeClone and the lane's own captureRecordSnapshot/
// appendResolvedRecord stay PRIVATE: the factory-only rule for subset-attempt records is kept by
// NOT publishing them, so a hand-built record can never forge a fresh counting context.

import {
  FLOW_SCHEMA_VERSION, CHAIN_KIND, validateFlowRecord, validateChainSequence, validateSupersessions,
  canonicalFlowDigest, subsetFoldBatchDigest, subsetGateIdsDigest, SUBSET_ATTEMPT_DIAGNOSIS_FROM,
} from './flow-record.mjs';
import { derivePregateSubsetIds, GATES_REL } from './gates-declaration.mjs';
import { CONFIG_REL } from './orchestration-config.mjs';
import { createStoreAppendLane } from './store-append.mjs';
import {
  flowStoreStop, resolveFlowStorePath, resolveFlowLockPath, parseFlowStoreText, deriveFlowOwner,
} from './flow-store-read.mjs';
import {
  walkChainState, resolveRecordReference, isAuthoritativeReferenceTarget, validateOpenerReference,
} from './flow-chain-state.mjs';
import {
  SUBSET_ATTEMPT_MAX_REDS, SUBSET_ATTEMPT_DIAGNOSIS_REDS, subsetAttemptState, subsetAttemptGate,
} from './flow-subset-budget.mjs';

const stop = flowStoreStop;

// Wait bound + poll cadence; the env knobs keep hermetic tests off wall-clock.
export const FLOW_LOCK_WAIT_MS = 10_000;
export const FLOW_LOCK_POLL_MS = 100;

// ── the shared append lane (D12) ──────────────────────────────────────────────────────────────────

// The lock/CAS discipline, the fd-custody rules and the serialized append are the EXTRACTION of
// exactly this module's former code into store-append.mjs, so behavior is unchanged by
// construction: this store injects its nouns (every refusal still names the flow store), its env
// seam and knob names, its typed-STOP factory, its record validator, its store-text parser, and
// the SEMANTIC preflight below. The flow suites are the characterization bar for that claim.
const flowAppendLane = createStoreAppendLane({
  nouns: { store: 'flow store', adj: 'flow-store', record: 'flow record' },
  envNames: { store: 'AW_FLOW_STORE', waitKnob: 'AW_FLOW_LOCK_WAIT_MS', pollKnob: 'AW_FLOW_LOCK_POLL_MS' },
  stop,
  resolveStorePath: resolveFlowStorePath,
  resolveLockPath: resolveFlowLockPath,
  validateRecord: validateFlowRecord,
  parseStoreText: parseFlowStoreText,
  lockWaitMs: FLOW_LOCK_WAIT_MS,
  lockPollMs: FLOW_LOCK_POLL_MS,
});

const captureRecordSnapshot = flowAppendLane.captureRecordSnapshot;

// ── the ONE append (validated, semantic-preflighted, lock-serialized, atomic) ─────────────────────

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
  return flowAppendLane.appendResolvedRecord({ cwd, env, deps, preflight: flowSemanticPreflight, makeRecord: () => ({ line, snapshot }) });
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
  return flowAppendLane.appendResolvedRecord({ cwd, env, deps, preflight: flowSemanticPreflight, makeRecord: (records) => {
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

// The SEMANTIC half of the append, handed to the shared lane and run by it INSIDE the critical
// section on the LOCKED store snapshot (a writer's lock-free walk is advisory — only the locked
// snapshot decides): per-kind chain legality, reference resolution, the closure rules, the
// counting-context gate, and supersession legality. An illegal record never lands. Throws a typed
// STOP; the lane releases the lock and re-throws.
const flowSemanticPreflight = ({ records, snapshot, storePath }) => {
  if (snapshot.kind === CHAIN_KIND) {
    const chain = records.filter((r) => r.kind === CHAIN_KIND && r.planId === snapshot.planId);
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
      const ref = validateOpenerReference(records, snapshot);
      if (!ref.ok) throw stop(`refusing a step-opening round: ${ref.reason} — nothing was written`);
    }
    if (snapshot.purpose === 'refresh') {
      if (resolveRecordReference(records, snapshot.refreshedRecord) === undefined) {
        throw stop(`refusing a refresh whose refreshedRecord does not match the store (no record digests to ${snapshot.refreshedRecord.slice(0, 12)}…) — a re-attestation binds an existing record; nothing was written`);
      }
      if (!isAuthoritativeReferenceTarget(records, snapshot.refreshedRecord)) {
        throw stop('refusing a refresh whose refreshedRecord targets a superseded record — a re-attestation binds the authoritative latest record of its key; nothing was written');
      }
    }
  }
  // The closure rule runs UNDER the lock on the captured snapshot — a writer's lock-free
  // usability pre-check can race a concurrent up/clear, and a justification minted after its
  // mark closed can never satisfy the decide layer (#25), so the store refuses to strand it.
  if (snapshot.kind === 'degrade-justification') {
    const closed = records.some((r) => (r.kind === 'down-mark-up' || r.kind === 'down-mark-clear') && r.target === snapshot.downMark);
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
    const chain = records.filter((r) => r.kind === CHAIN_KIND && r.planId === snapshot.planId);
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
    const gate = subsetAttemptGate(records, snapshot);
    if (!gate.ok) throw stop(`refusing a subset-attempt: ${gate.reason} — nothing was written`);
  }
  const existingSup = validateSupersessions(records);
  if (!existingSup.ok) {
    throw stop(`refusing to append to a flow store whose existing records already violate supersession legality (${existingSup.reason}) — inspect ${storePath}; nothing was written (fail closed)`);
  }
  const candidateSup = validateSupersessions([...records, snapshot]);
  if (!candidateSup.ok) {
    throw stop(`refusing an illegal supersession: ${candidateSup.reason} — the append-only store never absorbs a record that permanently reddens the checker; nothing was written`);
  }
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
  const resolved = flowAppendLane.resolveOrStop(cwd, env, 'serialize a subset run against');
  const { lockPath, lockFd, lockIdentity } = flowAppendLane.acquireLock(`${resolved}${SUBSET_RUN_LOCK_INFIX}`, env, deps);
  return { lockPath, release: () => flowAppendLane.releaseLock(lockPath, lockFd, lockIdentity, deps) };
};

// The pre-gate append-lock readiness probe (round-8 fold): acquire and immediately release the
// ORDINARY append lock through the full acquire discipline — a DEAD/foreign/malformed lock or
// an unwritable parent surfaces BEFORE any gate spends, with the acquire's own named refusal.
// Stated residual: a lock landing between this probe and the post-run append still refuses at
// append time — closing that would mean holding the append lock across the whole gate run.
export const probeFlowAppendLock = ({ cwd = process.cwd(), env = process.env, deps = {} } = {}) => {
  const resolved = flowAppendLane.resolveOrStop(cwd, env, 'probe');
  const { lockPath, lockFd, lockIdentity } = flowAppendLane.acquireLock(resolved, env, deps);
  const issue = flowAppendLane.releaseLock(lockPath, lockFd, lockIdentity, deps);
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
  const value = flowAppendLane.appendResolvedRecord({ cwd, env, deps, preflight: flowSemanticPreflight, makeRecord: (records) => {
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
