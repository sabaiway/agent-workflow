// flow-chain-state.mjs — the chain-state walk and the generic prior-terminal reference validator
// (#63): priorChainTerminal, walkChainState, resolveRecordReference, isAuthoritativeReferenceTarget
// and validateOpenerReference. Split out of flow-store.mjs unchanged (baseline-practices tranche 2),
// which now re-exports every name here.
//
// PURE over read results and the LOWEST of the store's five leaves: no store IO, no git, no fs, and
// the record vocabulary is its only tools sibling. Imports run ONE way — flow-append.mjs composes
// this module; nothing here reaches back up to the facade.

import { CHAIN_KIND, canonicalFlowDigest, authoritativeFlowRecords } from './flow-record.mjs';

const TERMINAL_PURPOSES = ['adoption', 'converged', 'complete'];

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
