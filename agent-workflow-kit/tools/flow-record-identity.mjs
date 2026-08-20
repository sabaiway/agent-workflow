// flow-record-identity.mjs — every answer to "what identifies this record, or this set of records":
// the per-kind supersession keys and the authoritative latest-per-key selection, the compound tree
// identity (#21), the canonical single-record serialization and its digest (#63 — the whole
// inter-record reference domain), the two Decision-7 derivation digests, and the owner-scoped
// projection with its order-sensitive hash. Split out of flow-record.mjs unchanged
// (baseline-practices tranche 3), which now re-exports every name here.
//
// Pure form: no filesystem, no git, no CLI, no side effects on import — node:crypto for the digests
// and the vocabulary leaf for the one kind constant are all it reaches. Imports run ONE way: the
// legality leaf composes this module; nothing here reaches back up to the facade.

import { createHash } from 'node:crypto';
import { CHAIN_KIND } from './flow-vocabulary.mjs';

// ── per-kind keys + the authoritative latest-per-key selection ────────────────────────────────────

// JSON-array keys (collision-proof across free-form fields — space-joining would let a planId forge
// a separator). The down-mark family shares ONE key per backend so up/clear supersede the mark;
// maintainer-override keys on its veto instance; internal-attestation keys on
// {plan, cycle, step, round, tree}.
export const flowRecordKey = (record) =>
  record.kind === CHAIN_KIND ? JSON.stringify([CHAIN_KIND, record.planId, record.cycle, record.stepId, record.round, record.purpose])
  : record.kind === 'internal-attestation' ? JSON.stringify([record.kind, record.planId, record.cycle, record.stepId, record.round, record.base, record.fingerprint])
  : record.kind === 'down-mark' || record.kind === 'down-mark-up' || record.kind === 'down-mark-clear' ? JSON.stringify(['down-mark', record.backend])
  : record.kind === 'degrade-justification' ? JSON.stringify([record.kind, record.downMark])
  : record.kind === 'rerun-cause' ? JSON.stringify([record.kind, record.attempt])
  : record.kind === 'bookkeeping-delta' ? JSON.stringify([record.kind, record.fingerprintBefore, record.fingerprintAfter, record.path])
  : record.kind === 'maintainer-override' ? JSON.stringify([record.kind, record.vetoReceiptDigest])
  : record.kind === 'consult-attestation' ? JSON.stringify([record.kind, record.backend, record.nonce])
  : record.kind === 'subset-attempt' ? JSON.stringify([record.kind, record.planId, record.cycle, record.stepId, record.foldBatch, record.subsetDigest])
  : null;

// The authoritative subset: the LATEST record per key, in file order of that latest appearance.
// Raw file order is a separate, surviving view — the transition/ordering checks consume ONLY raw.
export const authoritativeFlowRecords = (records) => {
  const lastByKey = new Map();
  records.forEach((r, i) => {
    const k = flowRecordKey(r);
    if (k != null) lastByKey.set(k, i);
  });
  const keep = new Set(lastByKey.values());
  return records.filter((_, i) => keep.has(i));
};

// ── tree identity (#21) ───────────────────────────────────────────────────────────────────────────

export const isTransitionShaped = (record) =>
  record.kind === 'bookkeeping-delta' || (record.kind === CHAIN_KIND && record.purpose === 'refresh');

// The compound tree identity every flow record carries; for transition-shaped records the singular
// fingerprint IS fingerprintAfter.
export const flowTreeIdentity = (record) => ({
  base: record.base,
  fingerprint: isTransitionShaped(record) ? record.fingerprintAfter : record.fingerprint,
});

// ── per-record canonical digest (#63) — the record-reference id domain ────────────────────────────

const serializeCanonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(serializeCanonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${serializeCanonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

// Canonical bytes of ONE record: recursively key-sorted JSON, NO trailing newline (the newline is
// store framing, not record identity). A parity test pins these bytes against core-evidence's
// canonicalKindSerialization on single-record fixtures.
export const flowCanonicalSerialization = (record) => serializeCanonical(record);

export const canonicalFlowDigest = (record) => createHash('sha256').update(flowCanonicalSerialization(record), 'utf8').digest('hex');

// ── Decision-7 derivation helpers (Plan 4) — pure digests over canonical bytes ────────────────────

// foldBatch keys the IMMUTABLE round identity projection: a round-ledger REVISION keeps
// {planId, cycle, stepId, round} (same digest — the budget never resets on supersession, #47),
// a NEW round moves it (fresh budget).
export const subsetFoldBatchDigest = ({ planId, cycle, stepId, round }) =>
  createHash('sha256').update(flowCanonicalSerialization({ planId, cycle, stepId, round }), 'utf8').digest('hex');

// The derived subset's counting identity — declaring pregateExclude changes the ordered gate-id
// list, therefore the key, therefore the counting context (#47/#66).
export const subsetGateIdsDigest = (gateIds) =>
  createHash('sha256').update(flowCanonicalSerialization(gateIds), 'utf8').digest('hex');

// ── the owner-scoped projection (Plan 4 Decision 2 / D10) — ONE pure helper, producer + consumer ──

// The hash domain is the OWNER-SCOPED projection, never the whole common store (#57): (a) every
// chain record whose owner is the committing worktree; (b) every planId-bearing global whose
// planId belongs to an owned chain; (c) every planId-less global (the down-mark family,
// degrade-justification, rerun-cause, bookkeeping-delta, maintainer-override — the rule is
// structural over every planId-less kind) whose tree identity (fingerprintAfter for transitions)
// is in {fingerprints appearing in owned-chain records} ∪ {the current tree fingerprint}. A
// foreign worktree's records fall outside (a)-(c) and never move the hash; a same-fingerprint
// foreign global is IN by (c) — same tree, same decision context. Raw store order is preserved:
// the projection hash is order-sensitive, so any in-projection append moves it.
export const ownerScopedFlowProjection = (records, { owner, currentFingerprint }) => {
  const ownedChain = records.filter((r) => r.kind === CHAIN_KIND && r.owner === owner);
  const ownedPlanIds = new Set(ownedChain.map((r) => r.planId));
  const fingerprints = new Set(currentFingerprint == null ? [] : [currentFingerprint]);
  for (const r of ownedChain) {
    for (const field of ['fingerprint', 'fingerprintBefore', 'fingerprintAfter']) {
      if (typeof r[field] === 'string') fingerprints.add(r[field]);
    }
  }
  return records.filter((r) => {
    if (r.kind === CHAIN_KIND) return r.owner === owner;
    if (typeof r.planId === 'string') return ownedPlanIds.has(r.planId);
    return fingerprints.has(flowTreeIdentity(r).fingerprint);
  });
};

export const flowProjectionHash = (records, ctx) =>
  createHash('sha256').update(ownerScopedFlowProjection(records, ctx).map(flowCanonicalSerialization).join('\n'), 'utf8').digest('hex');
