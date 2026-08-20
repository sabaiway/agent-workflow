// flow-subset-budget.mjs — the Decision-7/8 counting-context budget (Plan 4): the two caps, the ONE
// budget walk both consumers share (subsetAttemptState), the exhaustion remedy prose, and the
// under-lock gate the append lane runs. Split out of flow-store.mjs unchanged (baseline-practices
// tranche 2); the facade re-exports everything here except subsetAttemptGate, which crosses to
// flow-append.mjs alone and stays off the store's public surface.
//
// PURE over read results, beside flow-chain-state.mjs at the bottom of the store's five leaves: no
// store IO, no git, no fs, and the record vocabulary is its only tools sibling.

import { flowRecordKey, subsetFoldBatchDigest } from './flow-record.mjs';

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
export const subsetAttemptGate = (records, snapshot) => {
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
