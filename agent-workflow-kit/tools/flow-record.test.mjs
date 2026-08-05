import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  FLOW_SCHEMA_VERSION,
  DESIGN_SEED_ASSIGNMENT,
  FLOW_KINDS,
  GLOBAL_KINDS,
  CHAIN_KIND,
  CHAIN_PURPOSES,
  STEP_SCOPED_PURPOSES,
  PLAN_LANE_PURPOSES,
  TERMINAL_LANES,
  ALLOWED_TRANSITIONS,
  validateFlowRecord,
  flowRecordKey,
  authoritativeFlowRecords,
  flowTreeIdentity,
  validateChainSequence,
  validateSupersessions,
  flowCanonicalSerialization,
  canonicalFlowDigest,
  SAFE_NONCE_RE,
  FINDING_MANIFEST_PREFIX,
  findingManifestBasename,
  validateFindingManifest,
  decodeFindingManifest,
} from './flow-record.mjs';
import { FLOW_SCHEMA_VERSION as CONFIG_FLOW_SCHEMA_VERSION } from './orchestration-config.mjs';
import { canonicalKindSerialization } from './core-evidence.mjs';

const BASE = 'ad'.repeat(20);
const BASE2 = 'be'.repeat(20);
const FP = 'a1'.repeat(32);
const FP2 = 'b2'.repeat(32);
const D = (pair) => pair.repeat(32);
const TS = '2026-07-29T00:00:00.000Z';
const TS_LATER = '2026-07-30T00:00:00.000Z';

const chainCommon = {
  schema: FLOW_SCHEMA_VERSION,
  kind: 'chain',
  planId: 'plan-a',
  cycle: 1,
  commitEpoch: 0,
  owner: 'worktree-main',
  base: BASE,
  timestamp: TS,
};

const chain = (purpose, over = {}) => {
  const shapes = {
    adoption: { round: 0, stepId: null, fingerprint: FP, planLabel: 'Flow store core', createdAt: TS, planDigest: D('1a') },
    round: { round: 1, stepId: 'step-1', fingerprint: FP, opensFrom: D('2b'), dispatches: [], dispositions: [] },
    refresh: { round: 1, stepId: 'step-1', fingerprintBefore: FP, fingerprintAfter: FP2, cause: 'bookkeeping move', refreshedRecord: D('3c') },
    're-baseline': { round: 1, stepId: 'step-1', fingerprint: FP, baseBefore: BASE2 },
    freeze: { round: 1, stepId: 'step-1', fingerprint: FP },
    unfreeze: { round: 1, stepId: 'step-1', fingerprint: FP },
    park: { round: 1, stepId: null, fingerprint: FP },
    resume: { round: 1, stepId: null, fingerprint: FP },
    converged: { round: 1, stepId: 'step-1', fingerprint: FP },
    complete: { round: 1, stepId: null, fingerprint: FP },
  };
  return { ...chainCommon, purpose, ...shapes[purpose], ...over };
};

const globalCommon = { schema: FLOW_SCHEMA_VERSION, base: BASE, timestamp: TS };

const PENDING_DISPATCH = { backend: 'backend-a', dispatchBase: BASE, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: null, findingManifestDigest: null };
const LANDED_DISPATCH = { ...PENDING_DISPATCH, receiptDigest: D('6a'), findingManifestDigest: D('6b') };

const globalRecord = (kind, over = {}) => {
  const shapes = {
    'internal-attestation': {
      fingerprint: FP,
      planId: 'plan-a',
      stepId: 'step-1',
      cycle: 1,
      round: 1,
      lenses: ['correctness'],
      degraded: [],
      posture: { model: 'model-a', effort: 'high', tier: null },
      authority: 'orchestrator',
    },
    'down-mark': { fingerprint: FP, backend: 'backend-a', reason: 'unreachable', expiresAt: TS_LATER },
    'down-mark-up': { fingerprint: FP, backend: 'backend-a', target: D('4d') },
    'down-mark-clear': { fingerprint: FP, backend: 'backend-a', target: D('4d') },
    'degrade-justification': { fingerprint: FP, downMark: D('5e'), degradeDigest: D('6f') },
    'rerun-cause': { fingerprint: FP, cause: 'flaky fixture confirmed', attempt: 'attempt-1' },
    'bookkeeping-delta': {
      fingerprintBefore: FP,
      fingerprintAfter: FP2,
      path: 'docs/debt.md',
      contentDigest: D('7a'),
      custodyProof: { preClass: 'present', tracked: true, headDigest: D('8c'), indexDigest: D('8b'), worktreeDigest: D('8b'), maskedFingerprint: FP },
    },
    'maintainer-override': { fingerprint: FP, vetoReceiptDigest: D('9c'), backend: 'backend-a', verdict: 'revise', chainRecord: D('0d'), supersedes: null },
    'consult-attestation': {
      fingerprint: FP,
      backend: 'backend-a',
      nonce: 'nonce-7',
      planId: 'plan-a',
      cycle: 1,
      stepId: 'step-1',
      round: 1,
      findingDigest: D('4e'),
      proposedFixDigest: D('5d'),
    },
  };
  return { ...globalCommon, kind, ...shapes[kind], ...over };
};

const VALID_FIXTURES = new Map([
  ...CHAIN_PURPOSES.map((p) => [`chain/${p}`, chain(p)]),
  ...GLOBAL_KINDS.map((k) => [k, globalRecord(k)]),
]);

// The design §5 seed, verbatim — the drift-guard's ground truth. Never edit without a design round.
const DESIGN_SECTION5_SEED = [
  'adoption', 'round-chain', 'refresh', 're-baseline', 'unfreeze', 'freeze', 'converged',
  'park', 'resume', 'complete',
  'internal-attestation', 'down-mark', 'down-mark up', 'down-mark clear',
  'degrade-justification', 'rerun-cause', 'bookkeeping-delta', 'maintainer-override',
  'consult-attestation',
];

describe('flow-record vocabulary (Phase 1.1)', () => {
  it('flow-record vocabulary is closed and covers the locked family assignment exactly', () => {
    assert.deepEqual([...Object.keys(DESIGN_SEED_ASSIGNMENT)].sort(), [...DESIGN_SECTION5_SEED].sort());
    const chainAssigned = Object.values(DESIGN_SEED_ASSIGNMENT).filter((a) => a.family === 'chain').map((a) => a.purpose);
    const globalAssigned = Object.values(DESIGN_SEED_ASSIGNMENT).filter((a) => a.family === 'global').map((a) => a.kind);
    assert.equal(chainAssigned.length + globalAssigned.length, DESIGN_SECTION5_SEED.length, 'every seed member is assigned to exactly one family');
    assert.deepEqual([...chainAssigned].sort(), [...CHAIN_PURPOSES].sort());
    assert.deepEqual([...globalAssigned].sort(), [...GLOBAL_KINDS].sort());
    assert.equal(DESIGN_SEED_ASSIGNMENT['round-chain'].purpose, 'round', 'the round purpose realizes design §5 round-chain');
    assert.deepEqual([...FLOW_KINDS].sort(), [CHAIN_KIND, ...GLOBAL_KINDS].sort());
    assert.deepEqual([...STEP_SCOPED_PURPOSES, ...PLAN_LANE_PURPOSES].sort(), [...CHAIN_PURPOSES].sort(), 'step and plan lanes partition the purposes');
    for (const frozen of [DESIGN_SEED_ASSIGNMENT, FLOW_KINDS, GLOBAL_KINDS, CHAIN_PURPOSES, STEP_SCOPED_PURPOSES, PLAN_LANE_PURPOSES, TERMINAL_LANES, ALLOWED_TRANSITIONS, ALLOWED_TRANSITIONS.withinStep, ALLOWED_TRANSITIONS.withinStep.round, ALLOWED_TRANSITIONS.planLane, ALLOWED_TRANSITIONS.planLane.park, ALLOWED_TRANSITIONS.boundary]) {
      assert.ok(Object.isFrozen(frozen), 'exported vocabulary structures are frozen');
    }
  });

  it('the flow schema version is imported from the config namespace, never re-typed', () => {
    assert.equal(FLOW_SCHEMA_VERSION, CONFIG_FLOW_SCHEMA_VERSION);
    assert.equal(FLOW_SCHEMA_VERSION, 1);
  });

  it('unknown kind and unknown schema fail closed', () => {
    const unknownKind = validateFlowRecord({ ...globalRecord('rerun-cause'), kind: 'flow-note' });
    assert.equal(unknownKind.ok, false);
    assert.match(unknownKind.reason, /unknown kind "flow-note"/);
    assert.match(unknownKind.reason, /fail closed/);
    for (const badSchema of [2, '1', null, undefined]) {
      const res = validateFlowRecord({ ...globalRecord('rerun-cause'), schema: badSchema });
      assert.equal(res.ok, false);
      assert.match(res.reason, /unknown schema/);
    }
    const unknownPurpose = validateFlowRecord({ ...chain('round'), purpose: 'sprint' });
    assert.equal(unknownPurpose.ok, false);
    assert.match(unknownPurpose.reason, /unknown purpose "sprint"/);
    for (const nonObject of [null, [], 'x', 7]) {
      assert.equal(validateFlowRecord(nonObject).ok, false);
    }
  });

  it('every kind accepts its valid fixture and refuses each invalid one by name', () => {
    for (const [label, valid] of VALID_FIXTURES) {
      const accepted = validateFlowRecord(valid);
      assert.deepEqual(accepted, { ok: true }, `${label}: valid fixture must accept (${accepted.reason ?? ''})`);
      for (const field of Object.keys(valid)) {
        const clone = { ...valid };
        delete clone[field];
        const res = validateFlowRecord(clone);
        assert.equal(res.ok, false, `${label}: deleting "${field}" must refuse`);
        if (!['schema', 'kind', 'purpose'].includes(field)) {
          assert.match(res.reason, new RegExp(`^${label.replace('/', '\\/')}:`), `${label}: the refusal names the kind (got: ${res.reason})`);
        }
      }
      const stray = validateFlowRecord({ ...valid, stray: true });
      assert.equal(stray.ok, false, `${label}: an unknown extra field is malformed (the digest is identity)`);
      assert.match(stray.reason, /unknown field "stray"/);
    }
  });

  it('field-shape refusals are named: hex, counts, scope, and repo-relative path arms', () => {
    const cases = [
      [chain('round', { fingerprint: 'xyz' }), /fingerprint/],
      [chain('round', { base: 'zz' }), /base/],
      [chain('round', { cycle: 0 }), /cycle/],
      [chain('round', { round: -1 }), /round/],
      [chain('round', { commitEpoch: -1 }), /commitEpoch/],
      [chain('round', { owner: '' }), /owner/],
      [chain('round', { stepId: null }), /stepId/],
      [chain('round', { opensFrom: 'abc' }), /opensFrom/],
      [chain('adoption', { stepId: 'step-1' }), /stepId/],
      [chain('park', { stepId: 'step-1' }), /stepId/],
      [chain('refresh', { fingerprintAfter: 'short' }), /fingerprintAfter/],
      [globalRecord('down-mark', { reason: '' }), /reason/],
      [globalRecord('maintainer-override', { supersedes: 'not-hex' }), /supersedes/],
      [globalRecord('bookkeeping-delta', { path: '/etc/passwd' }), /repo-relative/],
      [globalRecord('bookkeeping-delta', { path: '../outside.md' }), /escapes|repo-relative/],
      [globalRecord('internal-attestation', { authority: '' }), /authority/],
      [globalRecord('consult-attestation', { findingDigest: 'zz' }), /findingDigest/],
    ];
    for (const [record, reasonRe] of cases) {
      const res = validateFlowRecord(record);
      assert.equal(res.ok, false);
      assert.match(res.reason, reasonRe);
    }
    assert.deepEqual(validateFlowRecord(chain('round', { base: null })), { ok: true }, 'a null base (unborn branch) is accepted');
    assert.deepEqual(validateFlowRecord(chain('re-baseline', { stepId: null })), { ok: true }, 'a boundary re-baseline carries a null stepId before the first step');
  });

  it('round records carry the dispatch and disposition ledgers with closed arms', () => {
    const pending = { backend: 'backend-a', dispatchBase: BASE, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: null, findingManifestDigest: null };
    const landed = { backend: 'backend-b', dispatchBase: null, receiptWatermark: 3, dispatchNonce: 'n-2', receiptDigest: D('6a'), findingManifestDigest: D('6b') };
    const folded = { findingDigest: D('7c'), action: 'folded', proofKind: 'red-proof', proofDigest: D('7d') };
    const consulted = { findingDigest: D('8e'), action: 'folded', proofKind: 'consult-attestation', proofDigest: D('7d') };
    const queued = { findingDigest: D('7e'), action: 'queued', debtId: 'DEBT-1', debtDigest: D('7f') };
    const rejected = { findingDigest: D('9a'), action: 'rejected', reason: 'not a defect on this axis' };
    const populated = chain('round', { dispatches: [pending, landed], dispositions: [folded, consulted, queued, rejected] });
    assert.deepEqual(validateFlowRecord(populated), { ok: true });
    const halfLanded = validateFlowRecord(chain('round', { dispatches: [{ ...pending, receiptDigest: D('6a') }] }));
    assert.equal(halfLanded.ok, false);
    assert.match(halfLanded.reason, /land together/);
    const strayDispatch = validateFlowRecord(chain('round', { dispatches: [{ ...pending, note: 'x' }] }));
    assert.equal(strayDispatch.ok, false);
    assert.match(strayDispatch.reason, /unknown field "note"/);
    const badWatermark = validateFlowRecord(chain('round', { dispatches: [{ ...pending, receiptWatermark: -1 }] }));
    assert.equal(badWatermark.ok, false);
    assert.match(badWatermark.reason, /receiptWatermark/);
    const unknownAction = validateFlowRecord(chain('round', { dispositions: [{ findingDigest: D('7c'), action: 'ignored' }] }));
    assert.equal(unknownAction.ok, false);
    assert.match(unknownAction.reason, /action/);
    const badProofKind = validateFlowRecord(chain('round', { dispositions: [{ ...folded, proofKind: 'promise' }] }));
    assert.equal(badProofKind.ok, false);
    assert.match(badProofKind.reason, /proofKind/);
    const queuedWithoutDebt = validateFlowRecord(chain('round', { dispositions: [{ findingDigest: D('7e'), action: 'queued', debtDigest: D('7f') }] }));
    assert.equal(queuedWithoutDebt.ok, false);
    assert.match(queuedWithoutDebt.reason, /debtId/);
    const strayDisposition = validateFlowRecord(chain('round', { dispositions: [{ ...rejected, extra: 1 }] }));
    assert.equal(strayDisposition.ok, false);
    assert.match(strayDisposition.reason, /unknown field "extra"/);
    const emptyReason = validateFlowRecord(chain('round', { dispositions: [{ ...rejected, reason: '' }] }));
    assert.equal(emptyReason.ok, false);
    assert.match(emptyReason.reason, /non-empty statement/);
  });

  it('a dispatch identity appears at most once in a round ledger', () => {
    const duplicate = validateFlowRecord(chain('round', { dispatches: [PENDING_DISPATCH, { ...LANDED_DISPATCH }] }));
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.reason, /duplicate dispatch identity/);
    const parallelSameWatermark = validateFlowRecord(chain('round', { dispatches: [PENDING_DISPATCH, { ...PENDING_DISPATCH, dispatchNonce: 'n-2' }] }));
    assert.deepEqual(parallelSameWatermark, { ok: true }, 'a shared watermark across parallel dispatches is legal — the nonce is the identity');
  });

  it('every finding gets exactly one disposition in a round record', () => {
    const twice = validateFlowRecord(chain('round', {
      dispositions: [
        { findingDigest: D('7c'), action: 'folded', proofKind: 'red-proof', proofDigest: D('7d') },
        { findingDigest: D('7c'), action: 'rejected', reason: 'also rejected' },
      ],
    }));
    assert.equal(twice.ok, false);
    assert.match(twice.reason, /exactly one disposition/);
  });

  it('a hostile prototype-key action fails closed instead of throwing', () => {
    for (const hostile of ['__proto__', 'constructor', 'toString']) {
      const res = validateFlowRecord(chain('round', { dispositions: [{ findingDigest: D('7c'), action: hostile }] }));
      assert.equal(res.ok, false, `action "${hostile}" must refuse, never resolve an inherited property`);
      assert.match(res.reason, /action must be one of/);
    }
  });

  it('internal-attestation carries the full bound schema', () => {
    const emptyLenses = validateFlowRecord(globalRecord('internal-attestation', { lenses: [] }));
    assert.equal(emptyLenses.ok, false);
    assert.match(emptyLenses.reason, /lenses/);
    const dupLenses = validateFlowRecord(globalRecord('internal-attestation', { lenses: ['a', 'a'] }));
    assert.equal(dupLenses.ok, false);
    const dupDegraded = validateFlowRecord(globalRecord('internal-attestation', { degraded: ['b', 'b'] }));
    assert.equal(dupDegraded.ok, false);
    const posturelessModel = validateFlowRecord(globalRecord('internal-attestation', { posture: { effort: null, tier: null } }));
    assert.equal(posturelessModel.ok, false);
    assert.match(posturelessModel.reason, /posture/);
    const strayPosture = validateFlowRecord(globalRecord('internal-attestation', { posture: { model: 'm', effort: null, tier: null, speed: 'fast' } }));
    assert.equal(strayPosture.ok, false);
    const numericEffort = validateFlowRecord(globalRecord('internal-attestation', { posture: { model: 'm', effort: 42, tier: null } }));
    assert.equal(numericEffort.ok, false);
    assert.deepEqual(validateFlowRecord(globalRecord('internal-attestation', { degraded: ['backend-b'] })), { ok: true });
  });

  it('consult-attestation binds plan, step, round, finding, and proposed fix', () => {
    const valid = globalRecord('consult-attestation');
    assert.deepEqual(validateFlowRecord(valid), { ok: true });
    const clone = { ...valid };
    delete clone.proposedFixDigest;
    const missingFix = validateFlowRecord(clone);
    assert.equal(missingFix.ok, false);
    assert.match(missingFix.reason, /proposedFixDigest/, 'the consult proves the PROPOSED FIX was consulted, not just the finding');
    const badFix = validateFlowRecord(globalRecord('consult-attestation', { proposedFixDigest: 'zz' }));
    assert.equal(badFix.ok, false);
  });

  it('custody proof persists the three-layer pre-state digest set', () => {
    const untracked = globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: false, headDigest: null, indexDigest: null, worktreeDigest: D('8b'), maskedFingerprint: FP } });
    assert.deepEqual(validateFlowRecord(untracked), { ok: true });
    const stagedAdd = globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: true, headDigest: null, indexDigest: D('8d'), worktreeDigest: D('8b'), maskedFingerprint: FP } });
    assert.deepEqual(validateFlowRecord(stagedAdd), { ok: true });
    const stagedDeletion = globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: true, headDigest: D('8c'), indexDigest: null, worktreeDigest: D('8b'), maskedFingerprint: FP } });
    assert.deepEqual(validateFlowRecord(stagedDeletion), { ok: true });
    const absentToPresent = globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'absent', tracked: true, headDigest: D('8c'), indexDigest: null, worktreeDigest: null, maskedFingerprint: FP } });
    assert.deepEqual(validateFlowRecord(absentToPresent), { ok: true });
    const presentSaysAbsent = validateFlowRecord(globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: true, headDigest: D('8c'), indexDigest: D('8b'), worktreeDigest: null, maskedFingerprint: FP } }));
    assert.equal(presentSaysAbsent.ok, false);
    assert.match(presentSaysAbsent.reason, /worktreeDigest/);
    const trackedWithoutEntries = validateFlowRecord(globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: true, headDigest: null, indexDigest: null, worktreeDigest: D('8b'), maskedFingerprint: FP } }));
    assert.equal(trackedWithoutEntries.ok, false);
    assert.match(trackedWithoutEntries.reason, /tracked/);
    const untrackedWithHead = validateFlowRecord(globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: false, headDigest: D('8c'), indexDigest: null, worktreeDigest: D('8b'), maskedFingerprint: FP } }));
    assert.equal(untrackedWithHead.ok, false);
    const strayProofKey = validateFlowRecord(globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: false, headDigest: null, indexDigest: null, worktreeDigest: D('8b'), maskedFingerprint: FP, note: 'x' } }));
    assert.equal(strayProofKey.ok, false);
    const missingLayer = validateFlowRecord(globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'present', tracked: false, indexDigest: null, worktreeDigest: D('8b'), maskedFingerprint: FP } }));
    assert.equal(missingLayer.ok, false);
    const badClass = validateFlowRecord(globalRecord('bookkeeping-delta', { custodyProof: { preClass: 'symlink', tracked: false, headDigest: null, indexDigest: null, worktreeDigest: D('8b'), maskedFingerprint: FP } }));
    assert.equal(badClass.ok, false);
    const absentToAbsent = validateFlowRecord(globalRecord('bookkeeping-delta', {
      contentDigest: null,
      custodyProof: { preClass: 'absent', tracked: false, headDigest: null, indexDigest: null, worktreeDigest: null, maskedFingerprint: FP },
    }));
    assert.equal(absentToAbsent.ok, false);
    assert.match(absentToAbsent.reason, /absent→absent/);
    assert.match(absentToAbsent.reason, /present→present, present→absent, absent→present/);
    const presentToAbsent = globalRecord('bookkeeping-delta', { contentDigest: null });
    assert.deepEqual(validateFlowRecord(presentToAbsent), { ok: true });
  });

  it('down-mark expiry and timestamp are canonical instants with expiry after timestamp', () => {
    const vagueExpiry = validateFlowRecord(globalRecord('down-mark', { expiresAt: 'soon' }));
    assert.equal(vagueExpiry.ok, false);
    assert.match(vagueExpiry.reason, /expiresAt/);
    const nonCanonical = validateFlowRecord(globalRecord('down-mark', { expiresAt: 'July 30, 2026' }));
    assert.equal(nonCanonical.ok, false);
    const nonCanonicalTimestamp = validateFlowRecord(globalRecord('down-mark', { timestamp: '2026-07-29 00:00:00' }));
    assert.equal(nonCanonicalTimestamp.ok, false);
    assert.match(nonCanonicalTimestamp.reason, /timestamp/);
    const expiryBefore = validateFlowRecord(globalRecord('down-mark', { expiresAt: '2026-07-28T00:00:00.000Z' }));
    assert.equal(expiryBefore.ok, false);
    assert.match(expiryBefore.reason, /strictly after/);
    const expiryEqual = validateFlowRecord(globalRecord('down-mark', { expiresAt: TS }));
    assert.equal(expiryEqual.ok, false);
  });

  it('transition table domain and range stay inside the vocabulary', () => {
    assert.ok(CHAIN_PURPOSES.includes(ALLOWED_TRANSITIONS.stepOpening));
    for (const [from, successors] of Object.entries(ALLOWED_TRANSITIONS.withinStep)) {
      assert.ok(STEP_SCOPED_PURPOSES.includes(from), `withinStep key ${from} is step-scoped`);
      for (const to of successors) assert.ok(STEP_SCOPED_PURPOSES.includes(to), `withinStep ${from} → ${to} stays step-scoped`);
    }
    assert.deepEqual([...Object.keys(ALLOWED_TRANSITIONS.withinStep)].sort(), [...STEP_SCOPED_PURPOSES].sort(), 'every step-scoped purpose has a successor row');
    for (const [from, successors] of Object.entries(ALLOWED_TRANSITIONS.planLane)) {
      assert.ok(PLAN_LANE_PURPOSES.includes(from), `planLane key ${from} is plan-lane`);
      for (const to of successors) assert.ok(CHAIN_PURPOSES.includes(to), `planLane ${from} → ${to} stays inside the vocabulary`);
    }
    assert.deepEqual([...Object.keys(ALLOWED_TRANSITIONS.planLane)].sort(), [...PLAN_LANE_PURPOSES].sort(), 'every plan-lane purpose has a successor row');
    for (const to of ALLOWED_TRANSITIONS.boundary) assert.ok(STEP_SCOPED_PURPOSES.includes(to), `boundary → ${to} stays step-scoped`);
    assert.deepEqual([...ALLOWED_TRANSITIONS.boundary], ['round', 'unfreeze', 're-baseline'], 'the boundary lane admits the opener, the reopen, and disjoint base motion');
  });

  it('terminal and suspension successors match the locked lanes exactly', () => {
    assert.deepEqual(TERMINAL_LANES, { converged: 'cycle', complete: 'plan' });
    assert.deepEqual([...ALLOWED_TRANSITIONS.withinStep.converged], ['unfreeze'], 'converged ends its step; only the unfreeze lane reopens it');
    assert.deepEqual([...ALLOWED_TRANSITIONS.planLane.complete], [], 'complete admits no successor');
    assert.deepEqual([...ALLOWED_TRANSITIONS.planLane.park], ['resume'], 'park is a resumable suspension; its successor lane is resume');
    assert.ok(!ALLOWED_TRANSITIONS.planLane.adoption.includes('adoption'), 'adoption never succeeds anything');
    assert.ok(!ALLOWED_TRANSITIONS.planLane.resume.includes('adoption'), 'resume never admits a re-adoption');
  });
});

describe('flow-record keys and authoritative selection (Phase 1.1)', () => {
  it('a later record supersedes its key while raw order survives selection', () => {
    const first = chain('freeze');
    const other = globalRecord('rerun-cause');
    const later = chain('freeze', { timestamp: '2026-07-29T01:00:00.000Z' });
    const raw = Object.freeze([first, other, later]);
    const authoritative = authoritativeFlowRecords(raw);
    assert.deepEqual(authoritative, [other, later], 'the latest record per key wins, in file order of its appearance');
    assert.deepEqual(raw, [first, other, later], 'selection never mutates the raw view');
    assert.equal(flowRecordKey(first), flowRecordKey(later));
  });

  it('a record of one step never supersedes a record of another step', () => {
    const stepOne = chain('converged', { stepId: 'step-1' });
    const stepTwo = chain('converged', { stepId: 'step-2' });
    const kept = authoritativeFlowRecords([stepOne, stepTwo]);
    assert.deepEqual(kept, [stepOne, stepTwo], 'two steps identical in every remaining key field do not collide');
    assert.notEqual(flowRecordKey(stepOne), flowRecordKey(stepTwo));
  });

  it('the down-mark family shares one supersession key so up and clear supersede the mark', () => {
    const mark = globalRecord('down-mark');
    const up = globalRecord('down-mark-up');
    assert.equal(flowRecordKey(mark), flowRecordKey(up));
    assert.deepEqual(authoritativeFlowRecords([mark, up]), [up]);
    const otherBackend = globalRecord('down-mark', { backend: 'backend-b' });
    assert.notEqual(flowRecordKey(mark), flowRecordKey(otherBackend));
  });

  it('internal-attestation keys carry base, cycle, and round beside plan, step, and tree', () => {
    const roundOne = globalRecord('internal-attestation');
    const roundTwo = globalRecord('internal-attestation', { round: 2 });
    const cycleTwo = globalRecord('internal-attestation', { cycle: 2 });
    assert.notEqual(flowRecordKey(roundOne), flowRecordKey(roundTwo));
    assert.notEqual(flowRecordKey(roundOne), flowRecordKey(cycleTwo));
    assert.deepEqual(authoritativeFlowRecords([roundOne, roundTwo]), [roundOne, roundTwo]);
    const otherBase = globalRecord('internal-attestation', { base: BASE2 });
    assert.notEqual(flowRecordKey(roundOne), flowRecordKey(otherBase), 'the compound tree identity {base, fingerprint} enters the key whole');
    assert.deepEqual(authoritativeFlowRecords([roundOne, otherBase]), [roundOne, otherBase], 'the same fingerprint on different bases never supersedes (the fingerprint excludes HEAD)');
  });

  it('a transition-shaped record exposes fingerprintAfter as its singular identity fingerprint', () => {
    const refresh = chain('refresh');
    assert.deepEqual(flowTreeIdentity(refresh), { base: BASE, fingerprint: refresh.fingerprintAfter });
    const delta = globalRecord('bookkeeping-delta');
    assert.deepEqual(flowTreeIdentity(delta), { base: BASE, fingerprint: delta.fingerprintAfter });
    assert.deepEqual(flowTreeIdentity(chain('round')), { base: BASE, fingerprint: FP });
  });
});

describe('flow-record chain sequence (Phase 1.1)', () => {
  const opener = (stepId, opensFrom, over = {}) => chain('round', { stepId, round: 1, opensFrom, ...over });

  it('chain sequence is monotonic and starts at adoption', () => {
    const noAdoption = validateChainSequence([opener('step-1', D('2b'))]);
    assert.equal(noAdoption.ok, false);
    assert.match(noAdoption.reason, /starts at adoption/);
    const stuckRound = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b'), { round: 2 }),
      chain('round', { stepId: 'step-1', round: 1, opensFrom: null }),
    ]);
    assert.equal(stuckRound.ok, false);
    assert.match(stuckRound.reason, /round index must increase/);
    const reopenedOldStep = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      opener('step-2', D('3c')),
      chain('converged', { stepId: 'step-2', round: 1 }),
      opener('step-1', D('4d')),
    ]);
    assert.equal(reopenedOldStep.ok, false);
    assert.match(reopenedOldStep.reason, /unfreeze/);
    const cycleRegression = validateChainSequence([
      chain('adoption', { cycle: 2 }),
      opener('step-1', D('2b'), { cycle: 1 }),
    ]);
    assert.equal(cycleRegression.ok, false);
    assert.match(cycleRegression.reason, /cycle/);
  });

  it('a two-step chain validates end-to-end (adoption → rounds → converged → the next step opens with an ordinary round referencing that terminal → its own converged → complete)', () => {
    const res = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('round', { stepId: 'step-1', round: 2, opensFrom: null }),
      chain('converged', { stepId: 'step-1', round: 2 }),
      opener('step-2', D('3c')),
      chain('converged', { stepId: 'step-2', round: 1 }),
      chain('complete', { round: 1 }),
    ]);
    assert.deepEqual(res, { ok: true });
  });

  it('a step sequence opens only with a round carrying a prior-terminal reference', () => {
    const bareOpener = validateChainSequence([chain('adoption'), opener('step-1', null)]);
    assert.equal(bareOpener.ok, false);
    assert.match(bareOpener.reason, /prior-terminal reference/);
    const wrongOpener = validateChainSequence([chain('adoption'), chain('freeze', { stepId: 'step-1', round: 1 })]);
    assert.equal(wrongOpener.ok, false);
    assert.match(wrongOpener.reason, /opens with "round"/);
    const midStepReference = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('round', { stepId: 'step-1', round: 2, opensFrom: D('9e') }),
    ]);
    assert.equal(midStepReference.ok, false);
    assert.match(midStepReference.reason, /only a step-opening round/);
  });

  it('within-step transitions honor the exported table; freeze and converged reopen only through unfreeze', () => {
    const frozenThenRound = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('freeze', { stepId: 'step-1', round: 1 }),
      chain('round', { stepId: 'step-1', round: 2, opensFrom: null }),
    ]);
    assert.equal(frozenThenRound.ok, false);
    assert.match(frozenThenRound.reason, /freeze → round/);
    const reopened = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('freeze', { stepId: 'step-1', round: 1 }),
      chain('unfreeze', { stepId: 'step-1', round: 1 }),
      chain('round', { stepId: 'step-1', round: 2, opensFrom: null }),
      chain('converged', { stepId: 'step-1', round: 2 }),
      chain('unfreeze', { stepId: 'step-1', round: 2 }),
      chain('round', { stepId: 'step-1', round: 3, opensFrom: null }),
      chain('converged', { stepId: 'step-1', round: 3 }),
      chain('complete', { round: 3 }),
    ]);
    assert.deepEqual(reopened, { ok: true }, 'the unfreeze lane reopens a frozen or converged step');
    const interleaved = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('freeze', { stepId: 'step-2', round: 1 }),
    ]);
    assert.equal(interleaved.ok, false);
    assert.match(interleaved.reason, /serial/);
  });

  it('park admits only resume, resume returns the chain to its pre-park state, complete admits no successor', () => {
    const parkedThenRound = validateChainSequence([
      chain('adoption'),
      chain('park', { round: 0 }),
      opener('step-1', D('2b')),
    ]);
    assert.equal(parkedThenRound.ok, false);
    assert.match(parkedThenRound.reason, /park admits only resume/);
    const resumedMidStep = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('park'),
      chain('resume'),
      chain('round', { stepId: 'step-1', round: 2, opensFrom: null }),
      chain('converged', { stepId: 'step-1', round: 2 }),
      chain('complete', { round: 2 }),
    ]);
    assert.deepEqual(resumedMidStep, { ok: true });
    const afterComplete = validateChainSequence([chain('adoption'), chain('complete', { round: 0 }), chain('park', { round: 0 })]);
    assert.equal(afterComplete.ok, false);
    assert.match(afterComplete.reason, /complete admits no successor/);
    const resumeWithoutPark = validateChainSequence([chain('adoption'), chain('resume', { round: 0 })]);
    assert.equal(resumeWithoutPark.ok, false);
    assert.match(resumeWithoutPark.reason, /without a preceding park/);
  });

  it('park and resume preserve the pre-park cycle and round', () => {
    const parkBumpsCycleMidStep = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('park', { cycle: 2 }),
    ]);
    assert.equal(parkBumpsCycleMidStep.ok, false);
    assert.match(parkBumpsCycleMidStep.reason, /pre-park/);
    const parkWrongRoundAtBoundary = validateChainSequence([
      chain('adoption'),
      chain('park', { round: 3 }),
    ]);
    assert.equal(parkWrongRoundAtBoundary.ok, false);
    assert.match(parkWrongRoundAtBoundary.reason, /pre-park/);
    const resumeDrifts = validateChainSequence([
      chain('adoption'),
      chain('park', { round: 0 }),
      chain('resume', { round: 1 }),
    ]);
    assert.equal(resumeDrifts.ok, false);
    assert.match(resumeDrifts.reason, /pre-park/);
    const resumeBumpsCycle = validateChainSequence([
      chain('adoption', { cycle: 2 }),
      chain('park', { cycle: 2, round: 0 }),
      chain('resume', { cycle: 3, round: 0 }),
    ]);
    assert.equal(resumeBumpsCycle.ok, false);
    assert.match(resumeBumpsCycle.reason, /pre-park/);
    const cleanSuspension = validateChainSequence([
      chain('adoption'),
      chain('park', { round: 0 }),
      chain('resume', { round: 0 }),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('complete', { round: 1 }),
    ]);
    assert.deepEqual(cleanSuspension, { ok: true });
  });

  it('adoption is only ever the chain\'s first record', () => {
    const boundaryReAdoption = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('adoption', { planDigest: D('5f') }),
    ]);
    assert.equal(boundaryReAdoption.ok, false);
    assert.match(boundaryReAdoption.reason, /first record/);
    const midStepAdoption = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('adoption', { planDigest: D('5f') }),
    ]);
    assert.equal(midStepAdoption.ok, false);
    assert.match(midStepAdoption.reason, /first record/);
  });

  it('a boundary re-baseline records disjoint base motion without reopening the step', () => {
    const betweenSteps = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('re-baseline', { stepId: 'step-1', round: 1, base: BASE2, baseBefore: BASE }),
      opener('step-2', D('3c')),
      chain('converged', { stepId: 'step-2', round: 1 }),
      chain('complete', { round: 1 }),
    ]);
    assert.deepEqual(betweenSteps, { ok: true });
    const beforeFirstStep = validateChainSequence([
      chain('adoption'),
      chain('re-baseline', { stepId: null, round: 0, base: BASE2, baseBefore: BASE }),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('complete', { round: 1 }),
    ]);
    assert.deepEqual(beforeFirstStep, { ok: true });
    const foreignStep = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('re-baseline', { stepId: 'step-9', round: 1, baseBefore: BASE }),
    ]);
    assert.equal(foreignStep.ok, false);
    assert.match(foreignStep.reason, /prior terminal/);
    const wrongRound = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('re-baseline', { stepId: 'step-1', round: 4, baseBefore: BASE }),
    ]);
    assert.equal(wrongRound.ok, false);
    const bumpedCycle = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('re-baseline', { stepId: 'step-1', round: 1, cycle: 2, baseBefore: BASE }),
    ]);
    assert.equal(bumpedCycle.ok, false);
    assert.match(bumpedCycle.reason, /never moves the cycle/);
  });

  it('a converged stepId reopens as a fresh step in a later cycle', () => {
    const newCycleSameStep = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      opener('step-1', D('3c'), { cycle: 2 }),
      chain('converged', { stepId: 'step-1', round: 1, cycle: 2 }),
      chain('complete', { round: 1, cycle: 2 }),
    ]);
    assert.deepEqual(newCycleSameStep, { ok: true }, 'the redesign valve reopens a stepId in a later cycle through an ordinary opener');
    const unfreezeAcrossCycles = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('unfreeze', { stepId: 'step-1', round: 1, cycle: 2 }),
    ]);
    assert.equal(unfreezeAcrossCycles.ok, false);
    assert.match(unfreezeAcrossCycles.reason, /cycle/);
  });

  it('a round revision lands the pending dispatch without a lifecycle transition', () => {
    const opened = [
      chain('adoption'),
      opener('step-1', D('2b'), { dispatches: [PENDING_DISPATCH] }),
    ];
    const landedRevision = chain('round', {
      stepId: 'step-1',
      round: 1,
      opensFrom: D('2b'),
      dispatches: [LANDED_DISPATCH],
      dispositions: [{ findingDigest: D('7c'), action: 'rejected', reason: 'not a defect on this axis' }],
      timestamp: '2026-07-29T01:00:00.000Z',
    });
    const landed = validateChainSequence([
      ...opened,
      landedRevision,
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('complete', { round: 1 }),
    ]);
    assert.deepEqual(landed, { ok: true }, 'pending → landed is a legal same-index enrichment');
    const droppedDispatch = validateChainSequence([...opened, chain('round', { stepId: 'step-1', round: 1, opensFrom: D('2b'), dispatches: [], dispositions: [] })]);
    assert.equal(droppedDispatch.ok, false);
    assert.match(droppedDispatch.reason, /dispatch ledger/);
    const mutatedLanded = validateChainSequence([
      ...opened,
      landedRevision,
      chain('round', { stepId: 'step-1', round: 1, opensFrom: D('2b'), dispatches: [{ ...LANDED_DISPATCH, receiptDigest: D('9f'), findingManifestDigest: D('6b') }], dispositions: landedRevision.dispositions, timestamp: '2026-07-29T02:00:00.000Z' }),
    ]);
    assert.equal(mutatedLanded.ok, false);
    assert.match(mutatedLanded.reason, /dispatch ledger/);
    const regressedDisposition = validateChainSequence([
      ...opened,
      landedRevision,
      chain('round', { stepId: 'step-1', round: 1, opensFrom: D('2b'), dispatches: [LANDED_DISPATCH], dispositions: [], timestamp: '2026-07-29T02:00:00.000Z' }),
    ]);
    assert.equal(regressedDisposition.ok, false);
    assert.match(regressedDisposition.reason, /disposition ledger/);
    const mutatedDisposition = validateChainSequence([
      ...opened,
      landedRevision,
      chain('round', { stepId: 'step-1', round: 1, opensFrom: D('2b'), dispatches: [LANDED_DISPATCH], dispositions: [{ findingDigest: D('7c'), action: 'rejected', reason: 'a different story' }], timestamp: '2026-07-29T02:00:00.000Z' }),
    ]);
    assert.equal(mutatedDisposition.ok, false);
    assert.match(mutatedDisposition.reason, /byte-identical/);
    const changedReference = validateChainSequence([...opened, chain('round', { stepId: 'step-1', round: 1, opensFrom: D('9e'), dispatches: [LANDED_DISPATCH], dispositions: [] })]);
    assert.equal(changedReference.ok, false);
    assert.match(changedReference.reason, /re-states/);
    const movedFingerprint = validateChainSequence([...opened, chain('round', { stepId: 'step-1', round: 1, opensFrom: D('2b'), fingerprint: FP2, dispatches: [LANDED_DISPATCH], dispositions: [] })]);
    assert.equal(movedFingerprint.ok, false);
    assert.match(movedFingerprint.reason, /re-states/);
    const frozenRevision = validateChainSequence([
      ...opened,
      chain('freeze', { stepId: 'step-1', round: 1 }),
      chain('round', { stepId: 'step-1', round: 1, opensFrom: D('2b'), dispatches: [LANDED_DISPATCH], dispositions: [] }),
    ]);
    assert.equal(frozenRevision.ok, false);
    assert.match(frozenRevision.reason, /freeze → round/);
  });

  it('chain records never migrate owners mid-chain', () => {
    const migrated = validateChainSequence([chain('adoption'), opener('step-1', D('2b'), { owner: 'worktree-b' })]);
    assert.equal(migrated.ok, false);
    assert.match(migrated.reason, /owner/);
  });

  it('commitEpoch never regresses across the chain; a round revision repeats its original epoch', () => {
    const regressed = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b'), { commitEpoch: 1 }),
      chain('converged', { stepId: 'step-1', round: 1, commitEpoch: 0 }),
    ]);
    assert.equal(regressed.ok, false);
    assert.match(regressed.reason, /commitEpoch never regresses/);
    const revisionKeepsEpoch = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b'), { commitEpoch: 1, dispatches: [PENDING_DISPATCH] }),
      chain('re-baseline', { stepId: 'step-1', round: 1, commitEpoch: 2, baseBefore: BASE }),
      chain('round', { stepId: 'step-1', round: 1, commitEpoch: 1, opensFrom: D('2b'), dispatches: [LANDED_DISPATCH], dispositions: [] }),
      chain('converged', { stepId: 'step-1', round: 1, commitEpoch: 2 }),
      chain('complete', { round: 1, commitEpoch: 2 }),
    ]);
    assert.deepEqual(revisionKeepsEpoch, { ok: true }, 'the revision repeats the dispatched epoch and never enters the lifecycle cursor');
    const revisionBumpsEpoch = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b'), { commitEpoch: 1, dispatches: [PENDING_DISPATCH] }),
      chain('round', { stepId: 'step-1', round: 1, commitEpoch: 2, opensFrom: D('2b'), dispatches: [LANDED_DISPATCH], dispositions: [] }),
    ]);
    assert.equal(revisionBumpsEpoch.ok, false);
    assert.match(revisionBumpsEpoch.reason, /re-states/);
  });

  it('step-scoped rounds and cycles hold their arms within a step', () => {
    const cycleJumpMidStep = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('freeze', { stepId: 'step-1', round: 1, cycle: 2 }),
    ]);
    assert.equal(cycleJumpMidStep.ok, false);
    assert.match(cycleJumpMidStep.reason, /step boundary/);
    const wrongRoundFreeze = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('freeze', { stepId: 'step-1', round: 2 }),
    ]);
    assert.equal(wrongRoundFreeze.ok, false);
    assert.match(wrongRoundFreeze.reason, /current round index/);
    const wrongRoundUnfreeze = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('unfreeze', { stepId: 'step-1', round: 2 }),
    ]);
    assert.equal(wrongRoundUnfreeze.ok, false);
    assert.match(wrongRoundUnfreeze.reason, /converged round index/);
    const zeroRoundOpener = validateChainSequence([chain('adoption'), opener('step-1', D('2b'), { round: 0 })]);
    assert.equal(zeroRoundOpener.ok, false);
    assert.match(zeroRoundOpener.reason, /round 1 or later/);
    const unfreezeWithoutTerminal = validateChainSequence([chain('adoption'), chain('unfreeze', { stepId: 'step-1', round: 1 })]);
    assert.equal(unfreezeWithoutTerminal.ok, false);
    assert.match(unfreezeWithoutTerminal.reason, /prior converged terminal/);
    const unfreezeForeignStep = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('converged', { stepId: 'step-1', round: 1 }),
      chain('unfreeze', { stepId: 'step-2', round: 1 }),
    ]);
    assert.equal(unfreezeForeignStep.ok, false);
    assert.match(unfreezeForeignStep.reason, /only the step that just converged/);
  });

  it('the sequence validator scopes to one chain and refuses foreign or malformed members', () => {
    const twoPlans = validateChainSequence([chain('adoption'), opener('step-1', D('2b'), { planId: 'plan-b' })]);
    assert.equal(twoPlans.ok, false);
    assert.match(twoPlans.reason, /one plan/);
    const nonChain = validateChainSequence([chain('adoption'), globalRecord('rerun-cause')]);
    assert.equal(nonChain.ok, false);
    assert.match(nonChain.reason, /chain records only/);
    const malformed = validateChainSequence([chain('adoption'), chain('round', { fingerprint: 'zz' })]);
    assert.equal(malformed.ok, false);
    const midStepComplete = validateChainSequence([
      chain('adoption'),
      opener('step-1', D('2b')),
      chain('complete'),
    ]);
    assert.equal(midStepComplete.ok, false);
    assert.match(midStepComplete.reason, /the step ends at converged/);
    assert.deepEqual(validateChainSequence([]), { ok: true }, 'an absent chain is vacuously sequenced');
    assert.equal(validateChainSequence(null).ok, false);
  });
});

describe('flow-record canonical digest (Phase 1.2)', () => {
  it('the per-record canonical digest is byte-layout independent, including nested objects', () => {
    const record = globalRecord('bookkeeping-delta');
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    reordered.custodyProof = Object.fromEntries(Object.entries(record.custodyProof).reverse());
    assert.notDeepEqual(Object.keys(reordered), Object.keys(record), 'the fixture genuinely reorders keys');
    assert.equal(canonicalFlowDigest(reordered), canonicalFlowDigest(record));
    assert.match(canonicalFlowDigest(record), /^[0-9a-f]{64}$/);
    assert.notEqual(canonicalFlowDigest(record), canonicalFlowDigest({ ...record, path: 'docs/flow-summary.md' }), 'a differing record digests differently');
    assert.equal(canonicalFlowDigest(record), createHash('sha256').update(flowCanonicalSerialization(record), 'utf8').digest('hex'), 'the digest is sha256 over exactly the canonical serialization');
  });

  it('flow canonical serialization carries no trailing newline and matches core canonicalKindSerialization on a single core-kind record', () => {
    const coreDegrade = { schema: 1, kind: 'degrade', backend: 'backend-a', reason: 'offline for the run', fingerprint: FP, timestamp: TS };
    const coreBytes = canonicalKindSerialization([coreDegrade], 'degrade');
    const flowBytes = flowCanonicalSerialization(coreDegrade);
    assert.notEqual(coreBytes, '', 'the core side is non-vacuous (a valid core kind survives the core key filter)');
    assert.notEqual(flowBytes, '', 'the flow side is non-vacuous');
    assert.ok(!flowBytes.endsWith('\n'), 'the single-record serialization carries NO trailing newline');
    assert.equal(coreBytes, `${flowBytes}\n`, 'flow and core canonical serializations agree on the single-record bytes; core adds only the per-line framing newline');
  });
});

describe('flow-record supersessions (Phase 1.1 + 1.2)', () => {
  it('a stateful global kind refuses a mis-targeted or out-of-order supersession', () => {
    const mark = globalRecord('down-mark');
    const up = globalRecord('down-mark-up', { target: canonicalFlowDigest(mark) });
    assert.deepEqual(validateSupersessions([mark, up]), { ok: true });
    const outOfOrder = validateSupersessions([up, mark]);
    assert.equal(outOfOrder.ok, false);
    assert.match(outOfOrder.reason, /EARLIER/);
    const foreignBackend = globalRecord('down-mark', { backend: 'backend-b' });
    const misTargetedBackend = validateSupersessions([foreignBackend, globalRecord('down-mark-up', { target: canonicalFlowDigest(foreignBackend) })]);
    assert.equal(misTargetedBackend.ok, false);
    assert.match(misTargetedBackend.reason, /backend "backend-b", not "backend-a"/);
    const notAMark = globalRecord('rerun-cause');
    const misTargetedKind = validateSupersessions([notAMark, globalRecord('down-mark-clear', { target: canonicalFlowDigest(notAMark) })]);
    assert.equal(misTargetedKind.ok, false);
    assert.match(misTargetedKind.reason, /not a down-mark/);
    const override = globalRecord('maintainer-override');
    const successor = globalRecord('maintainer-override', { supersedes: canonicalFlowDigest(override), timestamp: '2026-07-29T02:00:00.000Z' });
    assert.deepEqual(validateSupersessions([override, successor]), { ok: true });
    const crossVeto = globalRecord('maintainer-override', { vetoReceiptDigest: D('1f'), supersedes: canonicalFlowDigest(override) });
    const crossed = validateSupersessions([override, crossVeto]);
    assert.equal(crossed.ok, false);
    assert.match(crossed.reason, /one override binds exactly one veto instance/);
    const danglingOverride = validateSupersessions([globalRecord('maintainer-override', { supersedes: D('2e') })]);
    assert.equal(danglingOverride.ok, false);
    const wrongKindTarget = validateSupersessions([mark, globalRecord('maintainer-override', { supersedes: canonicalFlowDigest(mark) })]);
    assert.equal(wrongKindTarget.ok, false);
    assert.match(wrongKindTarget.reason, /must target a maintainer-override/);
  });

  it('a later override must supersede the current head of its veto instance', () => {
    const first = globalRecord('maintainer-override');
    const nullOnLater = validateSupersessions([first, globalRecord('maintainer-override', { timestamp: '2026-07-29T02:00:00.000Z' })]);
    assert.equal(nullOnLater.ok, false);
    assert.match(nullOnLater.reason, /first override/);
    const second = globalRecord('maintainer-override', { supersedes: canonicalFlowDigest(first), timestamp: '2026-07-29T02:00:00.000Z' });
    const staleTarget = validateSupersessions([
      first,
      second,
      globalRecord('maintainer-override', { supersedes: canonicalFlowDigest(first), timestamp: '2026-07-29T03:00:00.000Z' }),
    ]);
    assert.equal(staleTarget.ok, false);
    assert.match(staleTarget.reason, /CURRENT head/);
    const chained = validateSupersessions([
      first,
      second,
      globalRecord('maintainer-override', { supersedes: canonicalFlowDigest(second), timestamp: '2026-07-29T03:00:00.000Z' }),
    ]);
    assert.deepEqual(chained, { ok: true });
  });

  it('a supersession targets only the backend\'s active down-mark', () => {
    const mark = globalRecord('down-mark');
    const up = globalRecord('down-mark-up', { target: canonicalFlowDigest(mark) });
    const mark2 = globalRecord('down-mark', { timestamp: '2026-07-29T05:00:00.000Z', expiresAt: '2026-07-30T05:00:00.000Z' });
    const staleClear = validateSupersessions([mark, up, mark2, globalRecord('down-mark-clear', { target: canonicalFlowDigest(mark) })]);
    assert.equal(staleClear.ok, false);
    assert.match(staleClear.reason, /ACTIVE mark/);
    const doubleUp = validateSupersessions([mark, up, globalRecord('down-mark-up', { target: canonicalFlowDigest(mark), timestamp: '2026-07-29T06:00:00.000Z' })]);
    assert.equal(doubleUp.ok, false);
    assert.match(doubleUp.reason, /no active down-mark/);
    const freshClear = validateSupersessions([mark, up, mark2, globalRecord('down-mark-clear', { target: canonicalFlowDigest(mark2) })]);
    assert.deepEqual(freshClear, { ok: true }, 'a new down-mark opens a new instance; superseding it is legal');
  });

  it('an active down-mark must be closed before a new mark for the same backend', () => {
    const mark = globalRecord('down-mark');
    const mark2 = globalRecord('down-mark', { timestamp: '2026-07-29T05:00:00.000Z', expiresAt: '2026-07-30T05:00:00.000Z' });
    const silentReplace = validateSupersessions([mark, mark2]);
    assert.equal(silentReplace.ok, false);
    assert.match(silentReplace.reason, /explicitly closed/);
    const closedThenReopened = validateSupersessions([mark, globalRecord('down-mark-up', { target: canonicalFlowDigest(mark) }), mark2]);
    assert.deepEqual(closedThenReopened, { ok: true }, 'up/clear closes the instance; a new mark then opens a fresh one');
  });

  it('an unknown kind has no key and never enters the authoritative view (the reader refuses it upstream)', () => {
    const alien = { kind: 'flow-note' };
    assert.equal(flowRecordKey(alien), null);
    const kept = authoritativeFlowRecords([alien, globalRecord('rerun-cause')]);
    assert.deepEqual(kept, [globalRecord('rerun-cause')]);
  });
});

// The wrapper finding manifest (Phase 4.2, Decision 2 / P5 / P24): the findings schema is THIS
// literal fixture — the named test the plan demands — plus the safe nonce grammar and the
// {backend, nonce}-derived name (containment-checked, no cross-backend collision).
describe('finding manifest — the literal fixture, the safe nonce grammar, the derived name', () => {
  const MANIFEST_FIXTURE = JSON.parse(
    '{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":"9c2e4d8f1a6b3c7d0e5f2a8b4c6d1e3f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d","findings":"[major] — a.txt:1 — x — y\\nVerdict: revise\\n"}',
  );

  it('the literal findings-schema fixture validates (the named fixture test)', () => {
    assert.deepEqual(validateFindingManifest(MANIFEST_FIXTURE), { ok: true });
    assert.deepEqual(Object.keys(MANIFEST_FIXTURE), ['schema', 'backend', 'nonce', 'fingerprint', 'findings'], 'the closed key set, in fixture order');
  });

  it('every shape violation refuses by name: stray key · missing key · wrong schema · empty findings · bad fingerprint', () => {
    assert.match(validateFindingManifest({ ...MANIFEST_FIXTURE, extra: 1 }).reason, /unknown field "extra"/);
    const { findings, ...missing } = MANIFEST_FIXTURE;
    assert.match(validateFindingManifest(missing).reason, /missing field "findings"/);
    assert.match(validateFindingManifest({ ...MANIFEST_FIXTURE, schema: 2 }).reason, /unknown schema 2/);
    assert.match(validateFindingManifest({ ...MANIFEST_FIXTURE, findings: '' }).reason, /non-empty captured findings payload/);
    assert.match(validateFindingManifest({ ...MANIFEST_FIXTURE, fingerprint: 'zz' }).reason, /64-hex tree fingerprint, or null/);
    assert.deepEqual(validateFindingManifest({ ...MANIFEST_FIXTURE, fingerprint: null }), { ok: true }, 'null fingerprint is the stated wrapper-could-not-compute lane');
    assert.match(validateFindingManifest('nope').reason, /not an object/);
  });

  it('the safe nonce grammar is containment-checked — no separator, no traversal, no empty, no overlength', () => {
    for (const good of ['nx7', 'A.b_c-9', 'x'.repeat(64), '..']) assert.equal(SAFE_NONCE_RE.test(good), true, good);
    for (const bad of ['', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 'a\nb', 'п1']) assert.equal(SAFE_NONCE_RE.test(bad), false, JSON.stringify(bad));
  });

  it('decodeFindingManifest — the ONE shared reader: fatal UTF-8 (BOM preserved), JSON, shape, well-formed findings', () => {
    const okBytes = Buffer.from(JSON.stringify(MANIFEST_FIXTURE));
    const ok = decodeFindingManifest(okBytes);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.manifest, MANIFEST_FIXTURE);
    const invalidUtf8 = Buffer.concat([Buffer.from('{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":null,"findings":"x'), Buffer.from([0xff, 0xfe]), Buffer.from('y"}')]);
    assert.match(decodeFindingManifest(invalidUtf8).reason, /not valid UTF-8/, 'a lossy decode never substitutes U+FFFD into the digest domain');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), okBytes]);
    assert.match(decodeFindingManifest(bom).reason, /not valid JSON/, 'ignoreBOM preserves the BOM char, so a BOM-prefixed manifest keeps refusing (no widening)');
    assert.match(decodeFindingManifest(Buffer.from('not json')).reason, /not valid JSON/);
    assert.match(decodeFindingManifest(Buffer.from('{"schema":1,"backend":"codex","nonce":"nx7","fingerprint":null,"findings":"x\\ud800y"}')).reason, /well-formed Unicode/, 'an escaped lone surrogate refuses — ill-formed UTF-16 never reaches the findingDigest');
    assert.match(decodeFindingManifest(Buffer.from(JSON.stringify({ ...MANIFEST_FIXTURE, schema: 2 }))).reason, /unknown schema/, 'shape refusals pass through the validator');
  });

  it('the manifest name derives from the DISPATCH IDENTITY {backend, nonce} — no cross-backend collision; unsafe halves yield null', () => {
    assert.equal(findingManifestBasename('codex', 'nx7'), `${FINDING_MANIFEST_PREFIX}codex-nx7.json`);
    assert.notEqual(findingManifestBasename('codex', 'n1'), findingManifestBasename('agy', 'n1'), 'two backends never collide on one nonce (P24)');
    assert.equal(findingManifestBasename('codex', '../x'), null);
    assert.equal(findingManifestBasename('bad/backend', 'n1'), null);
    assert.equal(findingManifestBasename('codex', ''), null);
  });
});
