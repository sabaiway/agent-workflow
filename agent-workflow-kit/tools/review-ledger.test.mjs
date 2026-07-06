import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateRecord,
  readLedger,
  decideStop,
  decideCheck,
  isShipVerdict,
  receiptCrossCheck,
  filterLoopRecords,
  roundSequenceIntact,
  buildLedgerState,
  resolveLedgerPath,
  REVIEW_CAP,
} from './review-ledger.mjs';

// The ONE literal schema fixture (Phase 2.1; neutral labels per Decision 10) — two record kinds, one
// JSONL ledger. Counts and findings[] are internally consistent.
const FIXTURE = [
  '{"schema":1,"loop":"example-feature","activity":"plan-execution","kind":"round","round":1,"fingerprint":"fde442150a65cfc4523e3be7292329a93412ee7794bf02caef2cc3aa5d78d436","origins":{"first-draft":1,"fold-induced":0,"mechanics":0},"backends":[{"backend":"codex","degraded":false,"blockers":0,"majors":1,"minors":0,"verdict":"revise"},{"backend":"agy","degraded":true,"reason":"Issue-001 stall on large diffs","blockers":0,"majors":0,"minors":0,"verdict":"degraded"}],"findings":[{"findingKey":"prefix-rule-global-option-bypass","severity":"major","origin":"first-draft","backend":"codex"}],"timestamp":"2026-01-01T00:00:00Z"}',
  '{"schema":1,"loop":"example-feature","activity":"plan-execution","kind":"triage","round":2,"fingerprint":"fde442150a65cfc4523e3be7292329a93412ee7794bf02caef2cc3aa5d78d436","classifications":[{"findingKey":"prefix-rule-global-option-bypass","class":"inherent-layer-residual","accepted":true,"testId":null,"note":"documented as a RESIDUAL_NOTICE and raised to an acceptance criterion"}],"timestamp":"2026-01-01T00:30:00Z"}',
].join('\n');

const roundFixture = () => JSON.parse(FIXTURE.split('\n')[0]);
const triageFixture = () => JSON.parse(FIXTURE.split('\n')[1]);

// ── schema: the fixture passes; each malformed variant is REJECTED (its own named test) ──────────

describe('review-ledger schema — the fixture validates + malformed variants rejected', () => {
  it('both fixture lines parse + validate (0 malformed, 2 records)', () => {
    const { records, malformed } = readLedger('X', () => FIXTURE);
    assert.equal(malformed, 0);
    assert.equal(records.length, 2);
    assert.equal(validateRecord(roundFixture()).ok, true);
    assert.equal(validateRecord(triageFixture()).ok, true);
  });

  it('rejects a non-object', () => assert.equal(validateRecord(42).ok, false));
  it('rejects an unsupported schema version', () => assert.equal(validateRecord({ ...roundFixture(), schema: 99 }).ok, false));
  it('rejects a missing loop', () => assert.equal(validateRecord({ ...roundFixture(), loop: '' }).ok, false));
  it('rejects a bad activity', () => assert.equal(validateRecord({ ...roundFixture(), activity: 'nope' }).ok, false));
  it('rejects a bad kind', () => assert.equal(validateRecord({ ...roundFixture(), kind: 'nope' }).ok, false));

  it('rejects a bad class in a triage', () => {
    const bad = triageFixture();
    bad.classifications[0].class = 'not-a-class';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a bad origin in a round finding', () => {
    const bad = roundFixture();
    bad.findings[0].origin = 'not-an-origin';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a round with missing backends', () => {
    const bad = roundFixture();
    delete bad.backends;
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a round with missing findings', () => {
    const bad = roundFixture();
    delete bad.findings;
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a degraded backend with no reason', () => {
    const bad = roundFixture();
    delete bad.backends[1].reason; // agy is the degraded one
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a findings-vs-counts mismatch', () => {
    const bad = roundFixture();
    bad.backends[0].majors = 2; // codex has one major finding, claims two
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects an origins-vs-findings mismatch', () => {
    const bad = roundFixture();
    bad.origins['first-draft'] = 0; // findings carry one first-draft origin
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a finding whose backend is not in backends[]', () => {
    const bad = roundFixture();
    bad.findings[0].backend = 'ghost';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('readLedger counts a malformed line + surfaces its reason, keeps the valid ones', () => {
    const withBad = `${FIXTURE}\n{"schema":1,"loop":"L","activity":"plan-execution","kind":"round","round":1,"fingerprint":null,"origins":{"first-draft":0,"fold-induced":0,"mechanics":0},"backends":[{"backend":"codex","degraded":false,"blockers":0,"majors":9,"minors":0,"verdict":"x"}],"findings":[],"timestamp":"t"}`;
    const { records, malformed, malformedReasons } = readLedger('X', () => withBad);
    assert.equal(records.length, 2);
    assert.equal(malformed, 1);
    assert.match(malformedReasons[0], /findings-vs-counts/);
  });

  it('readLedger counts an unparseable JSON line', () => {
    const { records, malformed } = readLedger('X', () => `${FIXTURE}\n{not json`);
    assert.equal(records.length, 2);
    assert.equal(malformed, 1);
  });

  // ── R1 folds: degraded-backend exactness (codex R1) + duplicate backends (agy R1) ──
  it('rejects a degraded backend carrying non-zero counts (a hidden-blocker hole)', () => {
    const bad = roundFixture();
    bad.backends[1].majors = 1; // agy is degraded — must be 0/0/0
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a degraded backend whose verdict is not "degraded"', () => {
    const bad = roundFixture();
    bad.backends[1].verdict = 'SHIP';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a finding that references a degraded backend', () => {
    const bad = roundFixture();
    bad.findings.push({ findingKey: 'x', severity: 'minor', origin: 'first-draft', backend: 'agy' });
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects duplicate backend names in backends[]', () => {
    const bad = roundFixture();
    bad.backends.push({ ...bad.backends[0] }); // a second "codex" entry
    assert.equal(validateRecord(bad).ok, false);
  });

  it('readLedger surfaces a NON-ENOENT read error (fail closed), not "empty"', () => {
    const { readError } = readLedger('X', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    assert.equal(readError, 'EACCES');
  });

  it('readLedger treats ENOENT as an absent file (empty, no readError)', () => {
    const r = readLedger('X', () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
    assert.equal(r.records.length, 0);
    assert.equal(r.readError, undefined);
  });

  it('accepts a triage classification with an ABSENT testId (v1 tolerance defaults null — agy R3)', () => {
    const t = triageFixture();
    delete t.classifications[0].testId;
    assert.equal(validateRecord(t).ok, true);
  });
});

// ── schema v2 (M2/AD-046): fixable-bug ⟹ non-null well-formed testId; v1 stays tolerant ──────────
// The test-per-fold binding — a fold recorded as a fixable-bug MUST name the red→green test that pins
// it. Enforced only under schema 2 so historical/live v1 ledgers never retroactively become malformed
// (a malformed line cascades fail-closed refusals in the writer teeth AND the --check gate). decideStop
// never reads testId — this is validation-only (Decision 2).
describe('review-ledger schema v2 — testId enforcement (M2/AD-046)', () => {
  // A resolvable testId of the Decision-3 form "<repo-relative test file>#<test-name-pattern>".
  const WELL_FORMED_TESTID = 'agent-workflow-kit/tools/review-ledger.test.mjs#refuses a round beyond the hard-max';
  // A v2 triage carrying exactly one classification, over the v1 fixture's shared frame.
  const v2Triage = (classification) => ({ ...triageFixture(), schema: 2, classifications: [classification] });
  const cls = (over = {}) => ({ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '', ...over });

  it('accepts a schema-2 round (rounds are version-agnostic)', () => {
    assert.equal(validateRecord({ ...roundFixture(), schema: 2 }).ok, true);
  });

  it('v2 fixable-bug + a well-formed testId → ok', () => {
    assert.equal(validateRecord(v2Triage(cls())).ok, true);
  });

  it('v2 fixable-bug + null testId → rejected, reason names testId', () => {
    const r = validateRecord(v2Triage(cls({ testId: null })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /testId/);
  });

  it('v2 fixable-bug + ABSENT testId → rejected, reason names testId', () => {
    const c = cls();
    delete c.testId;
    const r = validateRecord(v2Triage(c));
    assert.equal(r.ok, false);
    assert.match(r.reason, /testId/);
  });

  it('v2 fixable-bug + malformed testId (missing "#") → rejected, reason names the failed check', () => {
    const r = validateRecord(v2Triage(cls({ testId: 'no-separator-here' })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed/);
  });

  it('v2 fixable-bug + malformed testId (empty left half "#pattern") → rejected, reason names the failed check', () => {
    const r = validateRecord(v2Triage(cls({ testId: '#pattern' })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed/);
  });

  it('v2 fixable-bug + malformed testId (empty right half "file#") → rejected, reason names the failed check', () => {
    const r = validateRecord(v2Triage(cls({ testId: 'file#' })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed/);
  });

  it('v2 inherent-layer-residual + null testId → ok (a non-fixable class may omit it)', () => {
    assert.equal(validateRecord(v2Triage(cls({ class: 'inherent-layer-residual', accepted: true, testId: null }))).ok, true);
  });

  it('v2 escalate + null testId → ok (a non-fixable class may omit it)', () => {
    assert.equal(validateRecord(v2Triage(cls({ class: 'escalate', accepted: true, testId: null }))).ok, true);
  });

  it('v1 tolerance — a schema:1 triage with fixable-bug + null testId is still ok', () => {
    const v1 = { ...triageFixture(), schema: 1, classifications: [cls({ testId: null })] };
    assert.equal(validateRecord(v1).ok, true);
  });

  it('a mixed v1 + v2 ledger reads back malformed: 0', () => {
    const v1Round = FIXTURE.split('\n')[0]; // the schema-1 round line
    const v2Line = JSON.stringify(v2Triage(cls()));
    const { records, malformed } = readLedger('X', () => `${v1Round}\n${v2Line}`);
    assert.equal(malformed, 0);
    assert.equal(records.length, 2);
  });
});

describe('roundSequenceIntact', () => {
  const rd = (n) => ({ kind: 'round', round: n });
  it('true for 1..n in order', () => assert.equal(roundSequenceIntact([rd(1), rd(2), rd(3)]), true));
  it('true for empty', () => assert.equal(roundSequenceIntact([]), true));
  it('false for a gap / missing first (e.g. [2])', () => assert.equal(roundSequenceIntact([rd(2)]), false));
  it('false for a duplicate ([1,1])', () => assert.equal(roundSequenceIntact([rd(1), rd(1)]), false));
  it('false for out-of-order ([2,1])', () => assert.equal(roundSequenceIntact([rd(2), rd(1)]), false));
  it('ignores triage records (only rounds count)', () => assert.equal(roundSequenceIntact([rd(1), { kind: 'triage', round: 1 }, rd(2)]), true));
});

// ── decideStop truth table — helpers ─────────────────────────────────────────────────────────────

const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);
const B = (backend, blockers = 0, majors = 0, minors = 0, extra = {}) => ({ backend, degraded: false, blockers, majors, minors, verdict: 'ship', ...extra });
const F = (findingKey, severity, backend, origin = 'first-draft') => ({ findingKey, severity, origin, backend });
const round = ({ round = 1, fingerprint = FP, backends, findings = [], loop = 'L', activity = 'plan-execution' }) => {
  const origins = { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 };
  for (const f of findings) origins[f.origin] += 1;
  return { schema: 1, loop, activity, kind: 'round', round, fingerprint, origins, backends, findings, timestamp: 't' };
};
const triage = ({ round = 2, fingerprint = FP, classifications, loop = 'L', activity = 'plan-execution' }) => ({ schema: 1, loop, activity, kind: 'triage', round, fingerprint, classifications, timestamp: 't' });
const CLS = (findingKey, cls, accepted = false) => ({ findingKey, class: cls, accepted, testId: null, note: '' });
const REQ = ['codex', 'agy'];

describe('decideStop — the four states + edge cases', () => {
  it('converged — every requiredBackend present, non-degraded, 0/0, current tree', () => {
    const r = [round({ backends: [B('codex'), B('agy')], findings: [] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });

  it('resolved-residual — cap + surviving major classified inherent-residual, matching triage fingerprint', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'inherent-layer-residual', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'resolved-residual');
  });

  it('resolved-residual — accepted-escalate counts as resolved', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 1, 0), B('agy')], findings: [F('k', 'blocker', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'escalate', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'resolved-residual');
  });

  it('resolved-residual STALE — a doc edit after triage moves the fingerprint → NOT resolved → continue', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 2, fingerprint: FP, classifications: [CLS('k', 'inherent-layer-residual', true)] }),
    ];
    // current tree moved to FP2 (edited after the triage) → the triage no longer matches
    assert.equal(decideStop(r, { currentFingerprint: FP2, requiredBackends: REQ }).state, 'continue');
  });

  it('fixable-bug does NOT deadlock — all surviving classified fixable-bug → continue (writer permits)', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'fixable-bug', false)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('resolved-residual REJECTS a pending-escalate (accepted:false) → continue', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 1, 0), B('agy')], findings: [F('k', 'blocker', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'escalate', false)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('triage-required — cap + UNCLASSIFIED surviving major', () => {
    const r = [round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('triage-required — cap + UNCLASSIFIED surviving BLOCKER only (blocking = blocker ∪ major)', () => {
    const r = [round({ round: 2, backends: [B('codex', 1, 0), B('agy')], findings: [F('k', 'blocker', 'codex')] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('triage-required — recurrence auto-trip (same blocking key in 2 rounds, unclassified) UNDER the cap', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
    ];
    // cap raised to 3 so latest.round (2) < cap — isolates the recurrence trip from the cap trip
    assert.equal(decideStop(r, { cap: 3, currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('continue — under the cap with a surviving major (no recurrence)', () => {
    const r = [round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('continue — 0-blocking stale (clean review then a post-review edit moves the fingerprint)', () => {
    const r = [round({ round: 1, backends: [B('codex'), B('agy')], findings: [] })];
    const d = decideStop(r, { currentFingerprint: FP2, requiredBackends: REQ });
    assert.equal(d.state, 'continue');
    assert.match(d.reason, /re-review the edited tree/);
  });

  it('precedence — cap + 0 surviving blocking + a triage record → converged (not resolved-residual)', () => {
    const r = [
      round({ round: 2, backends: [B('codex'), B('agy')], findings: [] }),
      triage({ round: 2, classifications: [CLS('old', 'inherent-layer-residual', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });

  it('partial-classification — cap + surviving blocking, a triage covering SOME → still triage-required for the rest', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 0, 2), B('agy')], findings: [F('k1', 'major', 'codex'), F('k2', 'major', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k1', 'inherent-layer-residual', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('continue — no round recorded yet (only a triage, or empty)', () => {
    assert.equal(decideStop([], { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('round-binding — a triage targeting an EARLIER round does not resolve the latest round (codex R1)', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 1, classifications: [CLS('k', 'inherent-layer-residual', true)] }), // targets round 1, not the latest
    ];
    // the round-1 triage must NOT satisfy resolved-residual for the round-2 survivor → still triage-required
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('recurrence reason mentions "recurred" (agy R1 UX)', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
    ];
    const d = decideStop(r, { cap: 3, currentFingerprint: FP, requiredBackends: REQ });
    assert.equal(d.state, 'triage-required');
    assert.match(d.reason, /recurred/);
  });
});

// ── EXHAUSTIVE interaction truth table (the SPEC) ────────────────────────────────────────────────
// decideStop is a state machine over (rounds × findings × severity × classifications × fingerprint ×
// degraded × cap/recurrence). Point tests miss INTERACTIONS — this table pins the full transition
// space, including the exact cross-cases the council found (a fixed-but-recurring finding must NOT
// deadlock the gate; round-bound classifications). A row that regresses goes red BEFORE any commit.
describe('decideStop — exhaustive interaction truth table (the spec)', () => {
  const R = (...bs) => bs; // backends
  const codexOnly = ['codex'];
  const both = ['codex', 'agy'];
  const deg = { degraded: true, reason: 'stall', verdict: 'degraded' };

  const CASES = [
    // ── converged / not-converged by counts, fingerprint, degraded, presence ──
    { name: 'converged: both 0/0 at current tree', records: [round({ round: 1, backends: R(B('codex'), B('agy')) })], req: both, expect: 'converged' },
    { name: 'converged: non-degraded 0/0 with the other degraded (Decision 4 ii)', records: [round({ round: 1, backends: R(B('codex'), B('agy', 0, 0, 0, deg)) })], req: both, expect: 'converged' },
    { name: 'NOT converged: the sole required backend is degraded (Decision 4 i)', records: [round({ round: 1, backends: R(B('codex', 0, 0, 0, deg)) })], req: codexOnly, expect: 'continue' },
    { name: 'NOT converged: a required backend has no entry — missing ≠ degraded (Decision 4 iii)', records: [round({ round: 1, backends: R(B('codex')) })], req: both, expect: 'continue' },
    { name: 'continue: 0-blocking but the tree moved after the clean review (stale)', records: [round({ round: 1, backends: R(B('codex'), B('agy')) })], req: both, fp: FP2, expect: 'continue' },

    // ── resolved-residual: class × fingerprint × round-binding ──
    { name: 'resolved-residual: cap survivor classified inherent-residual, matching tree', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, expect: 'resolved-residual' },
    { name: 'resolved-residual: accepted-escalate counts', records: [round({ round: 2, backends: R(B('codex', 1, 0), B('agy')), findings: [F('k', 'blocker', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'escalate', true)] })], req: both, expect: 'resolved-residual' },
    { name: 'NOT resolved (stale): a doc edit after the triage moved the fingerprint', records: [round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, fingerprint: FP, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, fp: FP2, expect: 'continue' },
    { name: 'NOT resolved (round-binding): the triage targets an EARLIER round than the latest', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 1, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, expect: 'triage-required' },
    { name: 'NOT resolved (pending escalate): accepted:false → continue', records: [round({ round: 2, backends: R(B('codex', 1, 0), B('agy')), findings: [F('k', 'blocker', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'escalate', false)] })], req: both, expect: 'continue' },
    { name: 'partial classification at cap → triage-required for the unclassified rest', records: [round({ round: 2, backends: R(B('codex', 0, 2), B('agy')), findings: [F('k1', 'major', 'codex'), F('k2', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k1', 'inherent-layer-residual', true)] })], req: both, expect: 'triage-required' },
    // A recipe-named backend MISSING from the residual round → NOT resolved-residual: the residual was
    // accepted without full council (agy never reviewed). Same presence discipline as converged (codex R4).
    { name: 'NOT resolved (missing backend): a recipe-named backend has no entry in the residual round', records: [round({ round: 2, backends: R(B('codex', 0, 1)), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, expect: 'continue' },

    // ── triage-required: cap × severity × recurrence ──
    { name: 'triage-required: cap + unclassified surviving major', records: [round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] })], req: both, expect: 'triage-required' },
    { name: 'triage-required: cap + unclassified surviving BLOCKER only', records: [round({ round: 2, backends: R(B('codex', 1, 0), B('agy')), findings: [F('k', 'blocker', 'codex')] })], req: both, expect: 'triage-required' },
    { name: 'triage-required: recurrence of a SURVIVING key under the cap', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] })], req: both, cap: 3, expect: 'triage-required' },
    { name: 'continue: cap + all survivors classified fixable-bug (no deadlock)', records: [round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'fixable-bug', false)] })], req: both, expect: 'continue' },

    // ── THE DEADLOCK CASES (council-found): a FIXED recurring key must not force triage ──
    // A key surviving rounds 1+2, GONE in round 3, with round 3's own surviving finding classified:
    // OLD (buggy) code force triage-required on the vanished key (recordTriage rightly refuses to
    // classify a finding that no longer survives → deadlock). The spec: continue.
    { name: 'DEADLOCK GUARD: a fixed recurring key does not force triage once the live finding is handled', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 3, backends: R(B('codex', 0, 1), B('agy')), findings: [F('m', 'major', 'codex')] }), triage({ round: 3, classifications: [CLS('m', 'fixable-bug', false)] })], req: both, cap: 3, expect: 'continue' },
    // A key surviving rounds 1+2, GONE in round 3, round 3 fully clean (0/0): must converge.
    { name: 'DEADLOCK GUARD: a fixed recurring key does not block convergence of a later clean round', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 3, backends: R(B('codex'), B('agy')) })], req: both, cap: 3, expect: 'converged' },
    // A key GONE in round 3 but a NEW live major m present + unclassified: triage-required on m ONLY.
    { name: 'DEADLOCK GUARD: triage keys reference only the LIVE finding, not the vanished recurring one', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 3, backends: R(B('codex', 0, 1), B('agy')), findings: [F('m', 'major', 'codex')] })], req: both, cap: 3, expect: 'triage-required', reasonHas: 'm', reasonHasNot: 'k' },

    // ── continue catch-all ──
    { name: 'continue: under the cap, one unclassified major, no recurrence', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] })], req: both, expect: 'continue' },
    { name: 'continue: no round recorded yet', records: [], req: both, expect: 'continue' },
    { name: 'precedence: cap + 0 surviving + a triage → converged (not resolved-residual)', records: [round({ round: 2, backends: R(B('codex'), B('agy')) }), triage({ round: 2, classifications: [CLS('old', 'inherent-layer-residual', true)] })], req: both, expect: 'converged' },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const d = decideStop(c.records, { cap: c.cap ?? REVIEW_CAP, currentFingerprint: c.fp ?? FP, requiredBackends: c.req });
      assert.equal(d.state, c.expect, `expected ${c.expect}, got ${d.state} (${d.reason})`);
      if (c.reasonHas) assert.match(d.reason, new RegExp(c.reasonHas));
      if (c.reasonHasNot) assert.doesNotMatch(d.reason, new RegExp(`\\b${c.reasonHasNot}\\b`));
    });
  }
});

describe('decideStop — degraded-backend matrix (Decision 4)', () => {
  it('(i) a degraded backend with a ship-shaped record does NOT by itself produce converged', () => {
    const r = [round({ backends: [B('codex', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })] })];
    assert.notEqual(decideStop(r, { currentFingerprint: FP, requiredBackends: ['codex'] }).state, 'converged');
  });

  it('(ii) converged is reached on the non-degraded requiredBackends 0/0 with the degrade recorded', () => {
    const r = [round({ backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });

  it('(iii) a requiredBackend with NO entry is missing (≠ degraded) → non-converged', () => {
    const r = [round({ backends: [B('codex')] })]; // agy required but absent
    assert.notEqual(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });
});

// ── the --check gate (decideCheck is a pure function of state) ───────────────────────────────────

const mkState = (over = {}) => ({
  resolved: { recipe: 'council', source: 'config', degradedFrom: null, reason: null },
  requiredBackends: ['codex', 'agy'],
  plans: ['L.md'],
  fingerprint: FP,
  clean: false,
  ledgerPath: '/tmp/ledger.jsonl',
  records: [],
  malformed: 0,
  malformedReasons: [],
  receipts: [],
  receiptsPath: '/tmp/receipts.jsonl',
  detectionWarning: null,
  ...over,
});

const codexReceipt = (fingerprint, verdict = 'SHIP') => ({ schema: 1, artifact: 'code', fresh: true, fingerprint, backend: 'codex', verdict, grounded: true, timestamp: 't' });

describe('decideCheck — the --check gate exit contract', () => {
  it('exit 0 — explicitly configured solo (detector-independent)', () => {
    assert.equal(decideCheck(mkState({ resolved: { recipe: 'solo', source: 'config', degradedFrom: null } })).code, 0);
  });

  it('exit 0 — recipe degrades to solo (no reviewer ready)', () => {
    assert.equal(decideCheck(mkState({ resolved: { recipe: 'solo', source: 'config', degradedFrom: 'council', reason: 'no backend ready' } })).code, 0);
  });

  it('exit 0 — no plan in flight', () => assert.equal(decideCheck(mkState({ plans: [] })).code, 0));

  it('exit 1 — more than one plan in flight (ambiguous loop id, fail-closed)', () => {
    const c = decideCheck(mkState({ plans: ['A.md', 'B.md'] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /more than one plan/);
  });

  it('exit 0 — not a git work tree', () => assert.equal(decideCheck(mkState({ fingerprint: null })).code, 0));
  it('exit 0 — clean tree', () => assert.equal(decideCheck(mkState({ clean: true })).code, 0));

  it('exit 1 — dirty active plan with NO round recorded (fail-closed, not fail-open)', () => {
    const c = decideCheck(mkState({ records: [] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /no review round recorded/);
  });

  it('exit 0 — converged with a grounded ship-class receipt for the current tree', () => {
    const records = [round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] })];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 0);
    assert.match(c.reason, /converged/);
  });

  it('exit 1 — triage-required loop (valid [1,2] sequence at the cap)', () => {
    const records = [round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] })];
    const c = decideCheck(mkState({ records }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /triage-required/);
  });

  it('exit 1 — continue loop (dirty, non-converged)', () => {
    const records = [round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] })];
    const c = decideCheck(mkState({ records }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /continue/);
  });

  it('exit 1 — converged recorded but a NON-degraded backend lacks a receipt', () => {
    const records = [round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy')], findings: [] })];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')] })); // agy receipt missing
    assert.equal(c.code, 1);
    assert.match(c.reason, /no grounded code receipt for agy/);
  });

  it('exit 1 — converged recorded 0/0 but the receipt verdict is non-ship (inconsistent)', () => {
    const records = [round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] })];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'revise')] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /not ship-class/);
  });

  it('exit 1 — fail-closed on a detector failure (not explicit solo)', () => {
    const c = decideCheck(mkState({ detectionWarning: 'detector blew up' }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /cannot verify the ledger/);
  });

  it('exit 1 — fail-closed on an unreadable ledger (non-ENOENT readError) for a dirty active plan', () => {
    const c = decideCheck(mkState({ readError: 'EACCES' }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /cannot read the ledger/);
  });

  it('exit 0 — a readError is irrelevant to a clean tree / no plan (short-circuits before the ledger)', () => {
    assert.equal(decideCheck(mkState({ readError: 'EACCES', clean: true })).code, 0);
    assert.equal(decideCheck(mkState({ readError: 'EACCES', plans: [] })).code, 0);
  });

  it('fails CLOSED on malformed ledger lines for a dirty active loop (codex R3)', () => {
    // a dropped malformed line could hide the latest non-converged round → never a fail-open PASS
    const records = [round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] })];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')], malformed: 1 }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /malformed/);
  });

  it('exit 0 — malformed is irrelevant to a clean tree / no plan (short-circuits before the ledger)', () => {
    assert.equal(decideCheck(mkState({ malformed: 3, clean: true })).code, 0);
    assert.equal(decideCheck(mkState({ malformed: 3, plans: [] })).code, 0);
  });

  it('exit 1 — a corrupt round sequence (not 1..n) fails closed (codex R3)', () => {
    const records = [round({ round: 2, fingerprint: FP, backends: [B('codex'), B('agy')], findings: [] })]; // [2], no round 1
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /corrupt/);
  });

  it('the execution gate IGNORES plan-authoring records (Decision 6)', () => {
    const authoring = round({ round: 2, activity: 'plan-authoring', backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] });
    const execConverged = round({ round: 1, activity: 'plan-execution', fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] });
    const c = decideCheck(mkState({ records: [authoring, execConverged], receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 0, 'the plan-authoring triage-required round must not block the code gate');
  });
});

describe('isShipVerdict — the single home of the ship-class mapping', () => {
  for (const v of ['ship', 'SHIP', 'SHIP WITH NITS', 'Ship With Nits']) it(`"${v}" is ship-class`, () => assert.equal(isShipVerdict(v), true));
  for (const v of ['revise', 'REWORK', 'unknown', '', null, undefined]) it(`${JSON.stringify(v)} is NOT ship-class`, () => assert.equal(isShipVerdict(v), false));
});

describe('receiptCrossCheck — presence + ship-class consistency', () => {
  it('ok when each non-degraded backend has a grounded ship-class receipt', () => {
    const r = round({ fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'x', verdict: 'degraded' })], findings: [] });
    assert.equal(receiptCrossCheck(r, [codexReceipt(FP, 'SHIP')], FP).ok, true);
  });
  it('a non-0/0 backend needs presence but no ship-class consistency', () => {
    const r = round({ fingerprint: FP, backends: [B('codex', 0, 1)], findings: [F('k', 'major', 'codex')] });
    assert.equal(receiptCrossCheck(r, [codexReceipt(FP, 'revise')], FP).ok, true);
  });
});

describe('filterLoopRecords', () => {
  it('keeps only the named activity + loop', () => {
    const recs = [
      round({ loop: 'A', activity: 'plan-execution', backends: [B('codex')] }),
      round({ loop: 'B', activity: 'plan-execution', backends: [B('codex')] }),
      round({ loop: 'A', activity: 'plan-authoring', backends: [B('codex')] }),
    ];
    assert.equal(filterLoopRecords(recs, { activity: 'plan-execution', loop: 'A' }).length, 1);
  });
});

// ── integration: buildLedgerState over a real git tree + AW_REVIEW_LEDGER override ──────────────

describe('review-ledger — integration over a scratch git tree', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'review-ledger-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('resolveLedgerPath honors AW_REVIEW_LEDGER', () => {
    assert.equal(resolveLedgerPath(cwd, { AW_REVIEW_LEDGER: '/x/y.jsonl' }), '/x/y.jsonl');
  });

  it('buildLedgerState reads a ledger file + surfaces malformed lines (detector stubbed)', () => {
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    const ledger = join(cwd, 'ledger.jsonl');
    writeFileSync(ledger, `${FIXTURE}\n{bad`);
    const state = buildLedgerState({ cwd, env: { AW_REVIEW_LEDGER: ledger }, detect: () => [] });
    assert.equal(state.records.length, 2);
    assert.equal(state.malformed, 1);
    assert.equal(REVIEW_CAP, 2);
  });
});
