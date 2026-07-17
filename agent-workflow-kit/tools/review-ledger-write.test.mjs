import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordRound, recordTriage, recordOverride, recordGateRun, main, HARD_MAX, DEFAULT_DIFF_CAP, LEDGER_WRITE_STOP, runBatch, validateBatchEnvelope, draftBackendsFromReceipts, SUBCOMMANDS } from './review-ledger-write.mjs';
import { readLedger } from './review-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FP = 'a'.repeat(64);
// Segment bases (AD-048 D1): every writer verb records at the CURRENT base; the teeth evaluate one
// segment. Deterministic here via deps.resolveBase.
const BASE = 'b'.repeat(40);
const BASE2 = 'c'.repeat(40);
// A resolvable testId of the Decision-3 form "<repo-relative test file>#<test-name-pattern>" —
// required on every fixable-bug classification under schema v2 (M2/AD-046).
const WELL_FORMED_TESTID = 'agent-workflow-kit/tools/review-ledger.test.mjs#refuses a round beyond the hard-max';

// A helper: a round's origins are computed from its findings so the record is internally consistent.
const originsOf = (findings) => {
  const o = { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 };
  for (const f of findings) o[f.origin] += 1;
  return o;
};
const roundParams = ({ loop = 'L', round = 1, backends, findings = [] }) => ({ loop, round, backends, findings, origins: originsOf(findings), timestamp: 't' });
// A receipt SELF-DECLARES its probe status (D3): only `probe:false` attests. `overrides` drives the
// exclusion lanes (probe / malformed / unmarked) the writer must refuse with a stated reason.
const codexReceiptFile = (path, fingerprint = FP, verdict = 'SHIP', overrides = {}) =>
  writeFileSync(path, `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint, backend: 'codex', verdict, grounded: true, timestamp: 't', probe: false, ...overrides })}\n`);

let dir;
let ledgerPath;
let receiptsPath;
// countChangedLines: () => 0 keeps the D4 cap tooth hermetic (no git spawn per test); the dedicated
// cap tests inject real magnitudes.
const deps = () => ({ ledgerPath, receiptsPath, computeFingerprint: () => FP, resolveBase: () => BASE, countChangedLines: () => 0 });

// The D5 green-baseline receipt (2.3): a SUCCESSFUL recordRound needs a quality-green gate-run at
// the segment + fingerprint it records against. Fixture seeding APPENDS (order in the ledger is
// irrelevant to the tooth); refusal-path tests that stop before D5 never need it.
const gateRunLine = (over = {}) => JSON.stringify({
  schema: 4, loop: 'L', activity: 'plan-execution', kind: 'gate-run', base: BASE,
  fingerprint: FP, fingerprintAfter: FP,
  declared: [{ id: 'unit-tests', cmd: 'node --test x' }],
  results: [{ id: 'unit-tests', ok: true, code: 0 }],
  summary: { status: 'ok', gates: 1, passed: 1, failed: 0, failedIds: [] },
  timestamp: 't', ...over,
});
const seedGateRun = (over = {}) => {
  const existing = readdirSync(dir).includes('ledger.jsonl') ? readFileSync(ledgerPath, 'utf8') : '';
  writeFileSync(ledgerPath, `${existing}${gateRunLine(over)}\n`);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-write-'));
  ledgerPath = join(dir, 'ledger.jsonl');
  receiptsPath = join(dir, 'receipts.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The writer reads the SAME attesting-receipt predicate as review-state and the round cross-check
// (D3): a probe never counted as a review, and each exclusion states its OWN recovery — they differ
// (run a real review / refresh the bridge / fix the receipt source), so a silent "no receipt" hides
// what to do next.
describe('review-ledger-write — only an ATTESTING receipt can bind a round (D3)', () => {
  const shipRound = () => roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }], findings: [] });

  it('refuses a probe-only current receipt, naming the probe as the reason', () => {
    codexReceiptFile(receiptsPath, FP, 'SHIP', { probe: true });
    seedGateRun();
    assert.throws(
      () => recordRound({ ...shipRound(), cwd: dir, env: {} }, deps()),
      /only probe receipts exist for the current tree/,
    );
  });

  it('refuses an UNMARKED current receipt fail-closed (silence is not a declaration)', () => {
    writeFileSync(receiptsPath, `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: FP, backend: 'codex', verdict: 'SHIP', grounded: true, timestamp: 't' })}\n`);
    seedGateRun();
    assert.throws(
      () => recordRound({ ...shipRound(), cwd: dir, env: {} }, deps()),
      /1 receipt\(s\) with no probe marker/,
    );
  });

  it('refuses a MALFORMED probe marker fail-closed', () => {
    codexReceiptFile(receiptsPath, FP, 'SHIP', { probe: 'no' });
    seedGateRun();
    assert.throws(
      () => recordRound({ ...shipRound(), cwd: dir, env: {} }, deps()),
      /malformed probe marker/,
    );
  });

  it('accepts probe:false and a later probe receipt never unseats it', () => {
    const real = JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: FP, backend: 'codex', verdict: 'SHIP', grounded: true, timestamp: 't', probe: false });
    const late = JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: FP, backend: 'codex', verdict: 'revise', grounded: true, timestamp: 't', probe: true });
    writeFileSync(receiptsPath, `${real}\n${late}\n`);
    seedGateRun();
    const { record } = recordRound({ ...shipRound(), cwd: dir, env: {} }, deps());
    assert.equal(record.kind, 'round', 'the real receipt attests; the probe beside it is simply not a review');
  });
});

describe('review-ledger-write — append + read back', () => {
  it('appends a round and reads it back through the read module', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    const params = roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }], findings: [] });
    const { record } = recordRound({ ...params, cwd: dir, env: {} }, deps());
    assert.equal(record.kind, 'round');
    assert.equal(record.fingerprint, FP);
    const { records, malformed } = readLedger(ledgerPath);
    assert.equal(malformed, 0);
    const rounds = records.filter((r) => r.kind === 'round');
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].round, 1);
  });

  it('appends a triage after a round (JSONL grows, both parse)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }] }), cwd: dir, env: {} }, deps());
    recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, deps());
    const { records } = readLedger(ledgerPath);
    assert.deepEqual(records.map((r) => r.kind), ['gate-run', 'round', 'triage']);
  });
});

describe('review-ledger-write — the teeth', () => {
  it('refuses a round beyond the hard-max ceiling, unconditionally', () => {
    const params = roundParams({ round: HARD_MAX + 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(
      () => recordRound({ ...params, cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /hard-max/.test(e.message),
    );
    assert.equal(readdirSync(dir).includes('ledger.jsonl'), false, 'nothing written');
  });

  it('refuses a new round WHILE decideStop on the existing records is triage-required', () => {
    // Pre-seed a VALID segment sequence [1,2] ending at a cap-reached round with an UNCLASSIFIED
    // surviving major (v4 records at the CURRENT base — the teeth judge the segment).
    const r1 = { schema: 4, loop: 'L', activity: 'plan-execution', kind: 'round', round: 1, base: BASE, fingerprint: FP, origins: originsOf([{ origin: 'first-draft' }]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }], timestamp: 't' };
    const r2 = { ...r1, round: 2 };
    writeFileSync(ledgerPath, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);
    codexReceiptFile(receiptsPath);
    seedGateRun();
    const params = roundParams({ round: 3, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(
      () => recordRound({ ...params, cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /triage is required/.test(e.message),
    );
  });

  it('PERMITS the next round once the surviving finding is classified (no deadlock)', () => {
    const r1 = { schema: 4, loop: 'L', activity: 'plan-execution', kind: 'round', round: 1, base: BASE, fingerprint: FP, origins: originsOf([{ origin: 'first-draft' }]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }], timestamp: 't' };
    const r2 = { ...r1, round: 2 };
    const cls = { schema: 4, loop: 'L', activity: 'plan-execution', kind: 'triage', round: 2, base: BASE, fingerprint: FP, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't' };
    writeFileSync(ledgerPath, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n${JSON.stringify(cls)}\n`);
    codexReceiptFile(receiptsPath);
    seedGateRun();
    const params = roundParams({ round: 3, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    const { record } = recordRound({ ...params, cwd: dir, env: {} }, deps());
    assert.equal(record.round, 3, 'a classified loop permits the fix/re-review round');
  });
});

describe('review-ledger-write — integrity binding (receipts)', () => {
  it('refuses a round for a NON-degraded backend lacking a grounded code receipt', () => {
    // no receipts file written → codex has no receipt for FP
    const params = roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(
      () => recordRound({ ...params, cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /codex: no grounded code receipt/.test(e.message),
    );
  });

  it('a DEGRADED backend needs no receipt (it ran no real review)', () => {
    seedGateRun(); // the D5 receipt is orthogonal to the review receipts
    const params = roundParams({ backends: [{ backend: 'agy', degraded: true, reason: 'Issue-001 stall', blockers: 0, majors: 0, minors: 0, verdict: 'degraded' }] });
    const { record } = recordRound({ ...params, cwd: dir, env: {} }, deps());
    assert.equal(record.backends[0].degraded, true);
    assert.equal(readLedger(ledgerPath).records.filter((r) => r.kind === 'round').length, 1);
  });
});

describe('review-ledger-write — atomic-write hardening', () => {
  it('refuses a SYMLINKED ledger leaf (a write would clobber the link target)', () => {
    const target = join(dir, 'real.jsonl');
    writeFileSync(target, `${gateRunLine()}\n`); // the D5 receipt lives in the target; the append itself must STOP
    symlinkSync(target, ledgerPath);
    codexReceiptFile(receiptsPath);
    const params = roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(() => recordRound({ ...params, cwd: dir, env: {} }, deps()), /symlink/);
    assert.equal(readFileSync(target, 'utf8'), `${gateRunLine()}\n`, 'the link target is untouched');
  });
});

describe('review-ledger-write — R1 folds (fail-closed ledger reads + triage round-binding)', () => {
  it('recordRound refuses to append while the ledger has malformed lines (fail closed, codex R1)', () => {
    writeFileSync(ledgerPath, '{not json\n');
    codexReceiptFile(receiptsPath);
    seedGateRun();
    const params = roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(
      () => recordRound({ ...params, cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /malformed/.test(e.message),
    );
  });

  it('recordRound refuses on a NON-ENOENT ledger read error (fail closed, no clobber, codex R1)', () => {
    writeFileSync(ledgerPath, 'PRECIOUS\n');
    codexReceiptFile(receiptsPath);
    const badRead = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const params = roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(
      () => recordRound({ ...params, cwd: dir, env: {} }, { ...deps(), readFile: badRead }),
      (e) => e.code === LEDGER_WRITE_STOP && /fail closed/.test(e.message),
    );
    assert.equal(readFileSync(ledgerPath, 'utf8'), 'PRECIOUS\n', 'the existing ledger is not clobbered');
  });

  it('recordTriage rejects a nonexistent target round (codex R1)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }] }), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordTriage({ loop: 'L', round: 9, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /no such recorded round/.test(e.message),
    );
  });

  it('recordTriage rejects classifying a key that is not a surviving blocker of the round (codex R1)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }] }), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'ghost', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /not a surviving blocking finding/.test(e.message),
    );
  });
});

describe('review-ledger-write — round sequentiality (codex R2)', () => {
  const codexRound = (round) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });

  it('requires the FIRST round to be 1 (a round-2 on an empty ledger is refused)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    assert.throws(
      () => recordRound({ ...codexRound(2), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /sequential/.test(e.message),
    );
  });

  it('rejects a DUPLICATE round number', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /sequential/.test(e.message),
    );
  });

  it('rejects a GAPPED / out-of-order round (round 3 after round 1)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordRound({ ...codexRound(3), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /sequential/.test(e.message),
    );
  });

  it('accepts strictly sequential rounds (1 then 2)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps());
    const { record } = recordRound({ ...codexRound(2), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 2);
    assert.equal(readLedger(ledgerPath).records.filter((r) => r.kind === 'round').length, 2);
  });

  it('refuses to append onto a CORRUPT existing sequence ([2] with no round 1) — codex R3', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    const corrupt = { schema: 4, loop: 'L', activity: 'plan-execution', kind: 'round', round: 2, base: BASE, fingerprint: FP, origins: originsOf([]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }], findings: [], timestamp: 't' };
    writeFileSync(ledgerPath, `${JSON.stringify(corrupt)}\n`);
    assert.throws(
      () => recordRound({ ...codexRound(3), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /corrupt/.test(e.message),
    );
  });
});

describe('review-ledger-write — testId/note normalization (absent optional field → filled; agy R3)', () => {
  it('recordTriage normalizes an ABSENT testId/note to null/"" in the stored record', () => {
    // A non-fixable class may omit testId (v2 requires it only for fixable-bug) — use it to isolate
    // the normalization behavior (absent optional field → filled) from the M2 enforcement.
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }] }), cwd: dir, env: {} }, deps());
    recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'inherent-layer-residual', accepted: true }], timestamp: 't', cwd: dir, env: {} }, deps());
    const rec = readLedger(ledgerPath).records.find((r) => r.kind === 'triage');
    assert.equal(rec.classifications[0].testId, null, 'absent testId → null');
    assert.equal(rec.classifications[0].note, '', 'absent note → ""');
  });
});

describe('review-ledger-write — M2 testId enforcement (a fixable-bug requires a testId)', () => {
  // Seed a round with a surviving major 'k' so a triage classifying 'k' passes the round-binding.
  const seedRoundWithMajorK = () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }] }), cwd: dir, env: {} }, deps());
  };
  const classify = (classification) => recordTriage({ loop: 'L', round: 1, classifications: [classification], timestamp: 't', cwd: dir, env: {} }, deps());

  it('refuses a fixable-bug with no testId — a typed STOP that states the rule + points at the red test', () => {
    seedRoundWithMajorK();
    assert.throws(
      () => classify({ findingKey: 'k', class: 'fixable-bug', accepted: false }),
      (e) => e.code === LEDGER_WRITE_STOP && /carries no testId/.test(e.message) && /write it first/.test(e.message),
    );
    assert.equal(readLedger(ledgerPath).records.filter((r) => r.kind === 'triage').length, 0, 'nothing recorded');
  });

  it('refuses a fixable-bug with a malformed testId (no "#" separator)', () => {
    seedRoundWithMajorK();
    assert.throws(
      () => classify({ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: 'no-separator-here' }),
      (e) => e.code === LEDGER_WRITE_STOP && /malformed/.test(e.message),
    );
  });

  it('records a fixable-bug with a well-formed testId — and emits schema 4 with the segment base', () => {
    seedRoundWithMajorK();
    const { record } = classify({ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID });
    assert.equal(record.schema, 4, 'the writer emits schema 4 (v4 adds the segment base; triage rules are unchanged)');
    assert.equal(record.base, BASE, 'a v4 triage carries the segment base');
    assert.equal(record.classifications[0].testId, WELL_FORMED_TESTID);
  });

  it('records inherent-layer-residual / escalate WITHOUT a testId (only fixable-bug requires one)', () => {
    // Both classify 'k' (a surviving major of round 1); a triage has no teeth, so two triages for the
    // same round both record — one dir, one seed.
    seedRoundWithMajorK();
    for (const cls of ['inherent-layer-residual', 'escalate']) {
      const { record } = classify({ findingKey: 'k', class: cls, accepted: true });
      assert.equal(record.schema, 4);
      assert.equal(record.classifications[0].testId, null, `${cls} may omit testId → normalized to null`);
    }
  });

  it('a recorded ROUND also emits schema 4 with the segment base', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    const { record } = recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] }), cwd: dir, env: {} }, deps());
    assert.equal(record.schema, 4);
    assert.equal(record.base, BASE);
  });
});

// ── the override verb (BUGFREE-1 / AD-047, D3/D7): the loud, recorded waiver — standard teeth
// (field validation via the schema, fail-closed ledger read, an in-flight loop). ─────────────────

describe('review-ledger-write — the override verb', () => {
  const overDeps = () => ({ ...deps(), plansInFlight: () => ['L.md'] });

  it('records an oracle-change override (schema 4, kind override) and reads back clean', () => {
    const { record } = recordOverride(
      { cwd: dir, env: {}, loop: 'L', round: 1, scope: 'oracle-change', files: ['x.test.mjs', 'y.spec.js'], reason: 'expectation deliberately updated', timestamp: 't' },
      overDeps(),
    );
    assert.equal(record.schema, 4);
    assert.equal(record.kind, 'override');
    assert.equal(record.base, BASE, 'a v4 override carries the segment base');
    assert.equal(record.fingerprint, FP, 'the fingerprint is recorded for audit');
    const { records, malformed } = readLedger(ledgerPath);
    assert.equal(malformed, 0);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].files, ['x.test.mjs', 'y.spec.js']);
  });

  it('records a red-proof override carrying the REQUIRED testId', () => {
    const { record } = recordOverride(
      { cwd: dir, env: {}, loop: 'L', round: 1, scope: 'red-proof', testId: 'x.test.mjs#p', reason: 'red genuinely unestablishable', timestamp: 't' },
      overDeps(),
    );
    assert.equal(record.scope, 'red-proof');
    assert.equal(record.testId, 'x.test.mjs#p');
  });

  it('refuses when the named loop is not the in-flight plan (an override is minted only inside its live loop)', () => {
    assert.throws(
      () => recordOverride({ cwd: dir, env: {}, loop: 'ghost', round: 1, scope: 'oracle-change', files: ['x.test.mjs'], reason: 'r' }, overDeps()),
      (e) => e.code === LEDGER_WRITE_STOP && /in-flight/.test(e.message),
    );
    assert.equal(readLedger(ledgerPath).records.length, 0, 'nothing recorded');
  });

  // codex R5 + agy R5 (BUGFREE-1 live loop, found independently by both backends): includes() let a
  // waiver be minted while MULTIPLE plans were in flight — the ambiguity the rest of the family
  // refuses everywhere (the single-plan rule). Exactly one in-flight plan, and it must be the loop.
  it('the in-flight tooth requires exactly ONE in-flight plan', () => {
    assert.throws(
      () => recordOverride(
        { cwd: dir, env: {}, loop: 'L', round: 1, scope: 'oracle-change', files: ['x.test.mjs'], reason: 'r' },
        { ...deps(), plansInFlight: () => ['L.md', 'M.md'] },
      ),
      (e) => e.code === LEDGER_WRITE_STOP && /SINGLE in-flight/.test(e.message),
    );
    assert.equal(readLedger(ledgerPath).records.length, 0, 'nothing recorded');
  });

  it('refuses malformed payloads by name (the schema teeth ride the validate path)', () => {
    const cases = [
      [{ scope: 'whatever', files: ['x'], reason: 'r' }, /scope/],
      [{ scope: 'oracle-change', files: [], reason: 'r' }, /files/],
      [{ scope: 'oracle-change', files: ['x.test.mjs'], reason: '' }, /reason/],
      [{ scope: 'red-proof', reason: 'r' }, /testId/],
      [{ scope: 'red-proof', testId: 'no-separator', reason: 'r' }, /testId/],
    ];
    for (const [payload, re] of cases) {
      assert.throws(
        () => recordOverride({ cwd: dir, env: {}, loop: 'L', round: 1, ...payload }, overDeps()),
        (e) => e.code === LEDGER_WRITE_STOP && re.test(e.message),
        `${JSON.stringify(payload)} must be refused by ${re}`,
      );
    }
  });

  it('refuses while the existing ledger has malformed lines (fail closed)', () => {
    writeFileSync(ledgerPath, '{not json\n');
    assert.throws(
      () => recordOverride({ cwd: dir, env: {}, loop: 'L', round: 1, scope: 'oracle-change', files: ['x.test.mjs'], reason: 'r' }, overDeps()),
      (e) => e.code === LEDGER_WRITE_STOP && /malformed/.test(e.message),
    );
  });

  it('refuses to append onto a CORRUPT round sequence (the standard integrity tooth)', () => {
    const corrupt = { schema: 4, loop: 'L', activity: 'plan-execution', kind: 'round', round: 2, base: BASE, fingerprint: FP, origins: originsOf([]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }], findings: [], timestamp: 't' };
    writeFileSync(ledgerPath, `${JSON.stringify(corrupt)}\n`);
    assert.throws(
      () => recordOverride({ cwd: dir, env: {}, loop: 'L', round: 1, scope: 'oracle-change', files: ['x.test.mjs'], reason: 'r' }, overDeps()),
      (e) => e.code === LEDGER_WRITE_STOP && /corrupt/.test(e.message),
    );
  });

  it('CLI: the override subcommand records via --json; a missing payload is a usage error', () => {
    // main() has no deps injection — drive it through env overrides + a real fixture git repo.
    const root = mkdtempSync(join(tmpdir(), 'ledger-override-cli-'));
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const env = { AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl') };
    // Seed a round with a surviving major so the classify dispatch can run through the same CLI.
    // The CLI computes the segment base for real (git rev-parse HEAD), so the seed carries it.
    const head = g('rev-parse', 'HEAD').stdout.trim();
    const seededRound = { schema: 4, loop: 'demo-plan', activity: 'plan-execution', kind: 'round', round: 1, base: head, fingerprint: FP, origins: originsOf([{ origin: 'first-draft' }]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }], timestamp: 't' };
    writeFileSync(join(root, '.git', 'rl.jsonl'), `${JSON.stringify(seededRound)}\n`);
    const classified = main(['classify', '--json', JSON.stringify({ loop: 'demo-plan', round: 1, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }] }), '--cwd', root], { env });
    assert.equal(classified.code, 0, classified.stderr);
    assert.match(classified.stdout, /triage/);
    const ok = main(['override', '--json', JSON.stringify({ loop: 'demo-plan', round: 1, scope: 'oracle-change', files: ['x.test.mjs'], reason: 'deliberate' }), '--cwd', root], { env });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /override/);
    const bad = main(['override'], { env });
    assert.equal(bad.code, 2);
    // `--json @<file>` reads the payload from a file — the PLAIN-command form (AD-044 Plan 4): an
    // inline JSON argv falls outside plain-invocation allow heuristics and prompts.
    const payloadFile = join(root, 'payload.json');
    writeFileSync(payloadFile, JSON.stringify({ loop: 'demo-plan', round: 1, scope: 'size-cap', sanctionedLines: 999, reason: 'from-file payload form' }));
    const fromFile = main(['override', '--json', `@${payloadFile}`, '--cwd', root], { env });
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.match(fromFile.stdout, /override/);
    const missing = main(['override', '--json', `@${join(root, 'no-such.json')}`, '--cwd', root], { env });
    assert.equal(missing.code, 2, 'an unreadable payload file is a loud usage error');
    rmSync(root, { recursive: true, force: true });
  });
});

// ── the SEGMENT teeth (BUGFREE-2 / AD-048): the field-gap regression + per-segment ceiling ───────

describe('review-ledger-write — segments (D1/D3): the field-gap regression', () => {
  const cleanRound = (round) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
  const majorRound = (round, key) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: key, severity: 'major', origin: 'first-draft', backend: 'codex' }] });

  it('the BUGFREE-1 shape — 11 rounds across 4 bases record COMPLETELY, and a late (9th-round) fixable-bug binds its testId', () => {
    codexReceiptFile(receiptsPath);
    const bases = ['A'.padEnd(40, 'a'), 'B'.padEnd(40, 'b'), 'C'.padEnd(40, 'c'), 'D'.padEnd(40, 'd')];
    let currentBase = bases[0];
    const segDeps = () => ({ ...deps(), resolveBase: () => currentBase });
    // Segments A, B: 3 clean rounds each (1..3 — at, never beyond, the per-segment ceiling).
    for (const b of [bases[0], bases[1]]) {
      currentBase = b;
      seedGateRun({ base: b });
      for (const n of [1, 2, 3]) recordRound({ ...cleanRound(n), cwd: dir, env: {} }, segDeps());
    }
    // Segment C: rounds 1..2 clean, round 3 raises the LATE finding — the 9th round of the loop
    // (unrecordable under the pre-AD-048 loop-wide HARD_MAX; its bug then unbindable).
    currentBase = bases[2];
    seedGateRun({ base: bases[2] });
    recordRound({ ...cleanRound(1), cwd: dir, env: {} }, segDeps());
    recordRound({ ...cleanRound(2), cwd: dir, env: {} }, segDeps());
    recordRound({ ...majorRound(3, 'late-bug'), cwd: dir, env: {} }, segDeps());
    const { record: triage } = recordTriage({ loop: 'L', round: 3, classifications: [{ findingKey: 'late-bug', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, segDeps());
    assert.equal(triage.classifications[0].testId, WELL_FORMED_TESTID, 'the 9th-round fixable-bug binds its testId');
    assert.equal(triage.base, bases[2]);
    // Segment D: rounds 1..2 → the loop totals 11 recorded rounds.
    currentBase = bases[3];
    seedGateRun({ base: bases[3] });
    recordRound({ ...cleanRound(1), cwd: dir, env: {} }, segDeps());
    recordRound({ ...cleanRound(2), cwd: dir, env: {} }, segDeps());
    const { records, malformed } = readLedger(ledgerPath);
    assert.equal(malformed, 0);
    assert.equal(records.filter((r) => r.kind === 'round').length, 11, 'all 11 rounds recorded');
    assert.equal(new Set(records.map((r) => r.base)).size, 4, 'across 4 segments');
  });

  it('round 4 within ONE segment is still refused (D3 — the ceiling is the point)…', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    for (const n of [1, 2, 3]) recordRound({ ...cleanRound(n), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordRound({ ...cleanRound(4), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /hard-max/.test(e.message),
    );
  });

  it('…while a COMMIT (base moved) reopens at round 1 — the reset is earned, never declared', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    for (const n of [1, 2, 3]) recordRound({ ...cleanRound(n), cwd: dir, env: {} }, deps());
    seedGateRun({ base: BASE2 });
    const { record } = recordRound({ ...cleanRound(1), cwd: dir, env: {} }, { ...deps(), resolveBase: () => BASE2 });
    assert.equal(record.round, 1);
    assert.equal(record.base, BASE2);
  });

  it('recordTriage binds to SEGMENT rounds: a round of a closed (other-base) segment is not a target', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...majorRound(1, 'k'), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, { ...deps(), resolveBase: () => BASE2 }),
      (e) => e.code === LEDGER_WRITE_STOP && /no such recorded round in the current segment/.test(e.message),
    );
  });
});

// ── the D4 diff-size cap (writer tooth over the ONE shared changed-surface computation) ─────────

describe('review-ledger-write — the D4 diff-size cap', () => {
  const cleanRound = (round = 1) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });

  it('an over-cap round is refused WITHOUT a size-cap override — the remedy names the override verb', () => {
    codexReceiptFile(receiptsPath);
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, { ...deps(), countChangedLines: () => DEFAULT_DIFF_CAP + 1 }),
      (e) => e.code === LEDGER_WRITE_STOP && /over the 400-line review cap/.test(e.message) && /size-cap/.test(e.message),
    );
    assert.equal(readdirSync(dir).includes('ledger.jsonl'), false, 'nothing written');
  });

  it('an over-cap round is ACCEPTED once the segment carries a size-cap override sanctioning the magnitude', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordOverride(
      { cwd: dir, env: {}, loop: 'L', round: 1, scope: 'size-cap', sanctionedLines: 450, reason: 'one reviewed unit', timestamp: 't' },
      { ...deps(), plansInFlight: () => ['L.md'] },
    );
    const { record } = recordRound({ ...cleanRound(), cwd: dir, env: {} }, { ...deps(), countChangedLines: () => 450 });
    assert.equal(record.round, 1);
  });

  it('a surface LARGER than the sanctioned magnitude is still refused (the sanction is exact, not a blank check)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordOverride(
      { cwd: dir, env: {}, loop: 'L', round: 1, scope: 'size-cap', sanctionedLines: 450, reason: 'one reviewed unit', timestamp: 't' },
      { ...deps(), plansInFlight: () => ['L.md'] },
    );
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, { ...deps(), countChangedLines: () => 500 }),
      (e) => e.code === LEDGER_WRITE_STOP && /recorded size-cap sanction of 450/.test(e.message),
    );
  });

  it("a size-cap override of ANOTHER segment never sanctions this one (segment-scoped, dies at the commit)", () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordOverride(
      { cwd: dir, env: {}, loop: 'L', round: 1, scope: 'size-cap', sanctionedLines: 9999, reason: 'r', timestamp: 't' },
      { ...deps(), plansInFlight: () => ['L.md'], resolveBase: () => BASE2 },
    );
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, { ...deps(), countChangedLines: () => 500 }),
      (e) => e.code === LEDGER_WRITE_STOP && /over the 400-line review cap/.test(e.message),
    );
  });

  it('the AW_REVIEW_DIFF_CAP knob rescopes the cap and stays fail-closed on garbage', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: { AW_REVIEW_DIFF_CAP: '10' } }, { ...deps(), countChangedLines: () => 11 }),
      (e) => e.code === LEDGER_WRITE_STOP && /over the 10-line review cap/.test(e.message),
    );
    for (const bad of ['0', '-4', 'many', '1.5']) {
      assert.throws(
        () => recordRound({ ...cleanRound(), cwd: dir, env: { AW_REVIEW_DIFF_CAP: bad } }, { ...deps(), countChangedLines: () => 1 }),
        (e) => e.code === LEDGER_WRITE_STOP && /AW_REVIEW_DIFF_CAP must be a positive integer/.test(e.message),
        `knob "${bad}" must fail closed`,
      );
    }
  });

  it('an under-cap round never consults the override lane (subtractive/small folds stay free)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    const { record } = recordRound({ ...cleanRound(), cwd: dir, env: {} }, { ...deps(), countChangedLines: () => DEFAULT_DIFF_CAP });
    assert.equal(record.round, 1, 'exactly at the cap is within the cap');
  });

  it('the size-cap override payload is validated at the writer: sanctionedLines is required', () => {
    assert.throws(
      () => recordOverride({ cwd: dir, env: {}, loop: 'L', round: 1, scope: 'size-cap', reason: 'r' }, { ...deps(), plansInFlight: () => ['L.md'] }),
      (e) => e.code === LEDGER_WRITE_STOP && /sanctionedLines/.test(e.message),
    );
  });
});

// ── D6 — no-repro-no-fold: no blocking finding vanishes unclassified ─────────────────────────────

describe('review-ledger-write — the D6 vanished-finding tooth', () => {
  const majorRound = (round, key) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: key, severity: 'major', origin: 'first-draft', backend: 'codex' }] });
  const cleanRound = (round) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
  const minorRound = (round, key) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 1, verdict: 'SHIP' }], findings: [{ findingKey: key, severity: 'minor', origin: 'first-draft', backend: 'codex' }] });

  it('a blocking finding that VANISHES between rounds without a classification refuses the next round', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...majorRound(1, 'k'), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordRound({ ...cleanRound(2), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /vanished without a classification: k/.test(e.message) && /refuted/.test(e.message),
    );
  });

  it('the refuted lane clears a phantom finding — with the grounds MANDATORY in note', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...majorRound(1, 'k'), cwd: dir, env: {} }, deps());
    // An empty note is refused (the writer normalizes an absent note to "" and the schema rejects it).
    assert.throws(
      () => recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'refuted', accepted: false }], timestamp: 't', cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /refuted but carries no note/.test(e.message),
    );
    recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'refuted', accepted: false, note: 'phantom: the cited guard already exists at file:42' }], timestamp: 't', cwd: dir, env: {} }, deps());
    const { record } = recordRound({ ...cleanRound(2), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 2, 'a refuted classification permits the next round');
  });

  it('a fixable-bug classification (testId bound) also clears the vanish — the fold binds at the round it folded', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...majorRound(1, 'k'), cwd: dir, env: {} }, deps());
    recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, deps());
    const { record } = recordRound({ ...cleanRound(2), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 2);
  });

  it('a blocking finding DOWNGRADED to minor counts as vanished (the severity-downgrade bypass, codex R1)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...majorRound(1, 'k'), cwd: dir, env: {} }, deps());
    // Round 2 re-reports k as a MINOR: the blocking finding did not survive as blocking — without a
    // classification this is exactly the silent-soften lane D6 closes.
    assert.throws(
      () => recordRound({ ...minorRound(2, 'k'), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /vanished without a classification: k/.test(e.message),
    );
  });

  it('a PENDING escalate never clears the vanish; an ACCEPTED one does (codex R1)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...majorRound(1, 'k'), cwd: dir, env: {} }, deps());
    recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'escalate', accepted: false, note: 'maintainer decision pending' }], timestamp: 't', cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordRound({ ...cleanRound(2), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /vanished without a classification: k/.test(e.message),
      'an unresolved escalation must not disappear into a clean round',
    );
    recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'escalate', accepted: true, note: 'maintainer accepted' }], timestamp: 't', cwd: dir, env: {} }, deps());
    const { record } = recordRound({ ...cleanRound(2), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 2, 'an accepted escalation clears the vanish');
  });

  it('a finding still PRESENT in the next round is never a vanish (fold pending is honest)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...majorRound(1, 'k'), cwd: dir, env: {} }, deps());
    const { record } = recordRound({ ...majorRound(2, 'k'), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 2, 'a live finding rides into the next round');
  });

  it('non-array findings survive the D6 pass and land in the schema refusal (never a TypeError)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...cleanRound(1), cwd: dir, env: {} }, deps());
    const params = { ...cleanRound(2), findings: undefined };
    assert.throws(
      () => recordRound({ ...params, cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /malformed round/.test(e.message),
    );
  });

  it('minors are exempt (forcing repro ceremony on nits trains rubber-stamping)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun();
    recordRound({ ...minorRound(1, 'nit'), cwd: dir, env: {} }, deps());
    const { record } = recordRound({ ...cleanRound(2), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 2, 'a vanished minor never blocks');
  });
});

// Structural read/write split: the read module must NEVER import the writer (mirrors
// orchestration-write.test.mjs). Enforced by module structure — cannot be defeated at runtime.
describe('import-split guard — review-ledger.mjs never imports the writer', () => {
  it('review-ledger.mjs source contains no import of review-ledger-write', () => {
    const src = readFileSync(join(HERE, 'review-ledger.mjs'), 'utf8');
    const importsWriter = /from\s+['"][^'"]*review-ledger-write/.test(src) || /import\(\s*['"][^'"]*review-ledger-write/.test(src);
    assert.ok(!importsWriter, 'review-ledger.mjs must not import the writer (read-only invariant)');
  });

  it('procedures.mjs + review-state.mjs never import the writer either', () => {
    for (const f of ['procedures.mjs', 'review-state.mjs']) {
      const src = readFileSync(join(HERE, f), 'utf8');
      assert.ok(!/from\s+['"][^'"]*review-ledger-write/.test(src), `${f} must not import the ledger writer`);
    }
  });

  // BUGFREE-2 / AD-048 import pins: (a) the writer consumes the changed surface through the NEUTRAL
  // module, never the runner (the sole-tree-toucher boundary, codex R2); (b) the reader's telemetry
  // reads the fold ledger through the neutral module, never fold-completeness.mjs (which imports the
  // reader — the cycle, D8); (c) the neutral module imports NO family module (true neutrality).
  it('review-ledger-write.mjs never imports the fold-completeness runner (D4 boundary)', () => {
    const src = readFileSync(join(HERE, 'review-ledger-write.mjs'), 'utf8');
    assert.ok(!/from\s+['"][^'"]*fold-completeness/.test(src), 'the writer must reach the changed surface via changed-surface.mjs only');
    assert.match(src, /from '\.\/changed-surface\.mjs'/, 'the writer consumes the neutral shared module');
  });

  it('review-ledger.mjs never imports fold-completeness.mjs (the D8 import-cycle invariant)', () => {
    const src = readFileSync(join(HERE, 'review-ledger.mjs'), 'utf8');
    assert.ok(!/from\s+['"][^'"]*fold-completeness/.test(src), 'the telemetry fold-read path must live in the neutral module');
    assert.match(src, /from '\.\/changed-surface\.mjs'/, 'the reader consumes the neutral shared module');
  });

  it('changed-surface.mjs imports no family module (neutral — node built-ins only)', () => {
    const src = readFileSync(join(HERE, 'changed-surface.mjs'), 'utf8');
    const familyImports = [...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual(familyImports, [], `the neutral module must not import family modules (found: ${familyImports.join(', ')})`);
  });

  // The ledger read-core stays the neutral seam, now anchored on the core-evidence DAG bottom:
  // it may import ONLY core-evidence.mjs (which owns the shared review-domain primitives it
  // re-exports) — never a checker, so no cycle can form. review-ledger.mjs consumes+re-exports it
  // (every pre-existing importer resolves unchanged).
  it('review-ledger-core.mjs imports only the core-evidence DAG bottom (never a checker)', () => {
    const src = readFileSync(join(HERE, 'review-ledger-core.mjs'), 'utf8');
    const familyImports = [...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual(familyImports, ['./core-evidence.mjs'], `the read-core may import only core-evidence.mjs (found: ${familyImports.join(', ')})`);
  });

  it('core-evidence.mjs is the DAG bottom — it imports no checker (atomic-write + changed-surface only)', () => {
    const src = readFileSync(join(HERE, 'core-evidence.mjs'), 'utf8');
    const familyImports = [...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual(familyImports.sort(), ['./atomic-write.mjs', './changed-surface.mjs'], `the DAG bottom must import no checker (found: ${familyImports.join(', ')})`);
  });

  it('review-ledger.mjs consumes the neutral read-core (the seam); review-state.mjs reads the D3(b) escape from core-evidence, never review-ledger.mjs (the cycle)', () => {
    const ledger = readFileSync(join(HERE, 'review-ledger.mjs'), 'utf8');
    assert.match(ledger, /from '\.\/review-ledger-core\.mjs'/, 'review-ledger.mjs must consume + re-export the neutral read-core');
    const state = readFileSync(join(HERE, 'review-state.mjs'), 'utf8');
    assert.match(state, /from '\.\/core-evidence\.mjs'/, 'review-state.mjs must read the core-evidence store for the degrade escape');
    assert.ok(!/from\s+['"][^'"]*review-ledger\.mjs['"]/.test(state), 'review-state.mjs must never import review-ledger.mjs (no cycle)');
    assert.ok(!/from\s+['"][^'"]*review-ledger-core\.mjs['"]/.test(state), 'review-state.mjs no longer reads the ledger core — the exemption moved to the core-evidence degrade records');
  });
});

// ── recordGateRun (2.2) + the D5 green-baseline tooth (2.3) — BUGFREE-2 / AD-048 ─────────────────

describe('review-ledger-write — recordGateRun (the D5 receipt writer)', () => {
  const grDeps = () => ({ ...deps(), plansInFlight: () => ['L.md'] });
  const payload = (over = {}) => ({
    cwd: dir, env: {},
    declared: [{ id: 'unit-tests', cmd: 'node --test x' }],
    results: [{ id: 'unit-tests', ok: true, code: 0 }],
    summary: { status: 'ok', gates: 1, passed: 1, failed: 0, failedIds: [] },
    fingerprintBefore: FP, fingerprintAfter: FP, timestamp: 't', ...over,
  });

  it('records a gate-run: schema 4, the segment frame, NO round, the loop DERIVED from the in-flight plan', () => {
    const { record } = recordGateRun(payload(), grDeps());
    assert.equal(record.schema, 4);
    assert.equal(record.kind, 'gate-run');
    assert.equal(record.loop, 'L', 'the loop is derived, never passed');
    assert.equal(record.base, BASE);
    assert.equal(record.round, undefined, 'a gate-run carries no round number');
    const { records, malformed } = readLedger(ledgerPath);
    assert.equal(malformed, 0);
    assert.equal(records.length, 1);
  });

  it('refuses outside a SINGLE in-flight loop (the recordOverride precedent)', () => {
    for (const plans of [[], ['A.md', 'B.md']]) {
      assert.throws(
        () => recordGateRun(payload(), { ...deps(), plansInFlight: () => plans }),
        (e) => e.code === LEDGER_WRITE_STOP && /SINGLE in-flight/.test(e.message),
      );
    }
    assert.equal(readdirSync(dir).includes('ledger.jsonl'), false, 'nothing written');
  });

  it('a forged summary rides the validate path (a lying status is refused by name)', () => {
    assert.throws(
      () => recordGateRun(payload({ results: [{ id: 'unit-tests', ok: false, code: 1 }] }), grDeps()),
      (e) => e.code === LEDGER_WRITE_STOP && /status/.test(e.message),
    );
  });

  it('refuses while the existing ledger has malformed lines (fail closed)', () => {
    writeFileSync(ledgerPath, '{not json\n');
    assert.throws(
      () => recordGateRun(payload(), grDeps()),
      (e) => e.code === LEDGER_WRITE_STOP && /malformed/.test(e.message),
    );
  });

  it('refuses onto a CORRUPT segment round sequence + on a non-ENOENT read error (the standard integrity teeth)', () => {
    const corrupt = { schema: 4, loop: 'L', activity: 'plan-execution', kind: 'round', round: 2, base: BASE, fingerprint: FP, origins: originsOf([]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }], findings: [], timestamp: 't' };
    writeFileSync(ledgerPath, `${JSON.stringify(corrupt)}\n`);
    assert.throws(
      () => recordGateRun(payload(), grDeps()),
      (e) => e.code === LEDGER_WRITE_STOP && /corrupt/.test(e.message),
    );
    const badRead = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    assert.throws(
      () => recordGateRun(payload(), { ...grDeps(), readFile: badRead }),
      (e) => e.code === LEDGER_WRITE_STOP && /fail closed/.test(e.message),
    );
  });
});

describe('review-ledger-write — the D5 green-baseline tooth (2.3)', () => {
  const cleanRound = (round = 1) => roundParams({ round, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });

  it('refused with NO gate-run in the segment — the remedy names run-gates --record', () => {
    codexReceiptFile(receiptsPath);
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /quality-green gate-run/.test(e.message) && /run-gates\.mjs --record/.test(e.message),
    );
  });

  it('refused with a RED gate-run (a red non-process gate is never quality-green)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun({
      results: [{ id: 'unit-tests', ok: false, code: 1 }],
      summary: { status: 'fail', gates: 1, passed: 0, failed: 1, failedIds: ['unit-tests'] },
    });
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /quality-green gate-run/.test(e.message),
    );
  });

  it('refused with a green --only SUBSET (the R1 converged subset-bypass — a subset never satisfies)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun({
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }, { id: 'release-scan', cmd: 'node tools/release-scan.mjs pkg' }],
      results: [{ id: 'unit-tests', ok: true, code: 0 }],
      summary: { status: 'ok', gates: 1, passed: 1, failed: 0, failedIds: [] },
    });
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /quality-green gate-run/.test(e.message),
    );
  });

  it('refused with a TREE-CHANGED run (fingerprint !== fingerprintAfter attests no particular tree — codex R2)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun({ fingerprintAfter: 'e'.repeat(64) });
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /quality-green gate-run/.test(e.message),
    );
  });

  it('refused when the gate-run is for ANOTHER fingerprint (gates ran, then the tree moved)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun({ fingerprint: 'e'.repeat(64), fingerprintAfter: 'e'.repeat(64) });
    assert.throws(
      () => recordRound({ ...cleanRound(), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /quality-green gate-run/.test(e.message),
    );
  });

  it('ACCEPTED with a full quality-green run; a red PROCESS gate never blocks (the closed carve-out)', () => {
    codexReceiptFile(receiptsPath);
    seedGateRun({
      declared: [
        { id: 'unit-tests', cmd: 'node --test x' },
        { id: 'review-ledger', cmd: 'node agent-workflow-kit/tools/review-ledger.mjs --check' },
      ],
      results: [{ id: 'unit-tests', ok: true, code: 0 }, { id: 'review-ledger', ok: false, code: 1 }],
      summary: { status: 'fail', gates: 2, passed: 1, failed: 1, failedIds: ['review-ledger'] },
    });
    const { record } = recordRound({ ...cleanRound(), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 1, 'a mid-loop red process gate is exactly the carve-out');
  });
});

describe('the writer HELP names the D5 quality-green prerequisite (codex Phase-3 R2 — help matches recordRound)', () => {
  it('the writer HELP names the D5 quality-green prerequisite', () => {
    const r = main(['--help'], {});
    assert.equal(r.code, 0);
    assert.match(r.stdout, /quality-green gate-run/, 'the record verb must state the D5 prerequisite');
    assert.match(r.stdout, /run-gates\.mjs --record|--record/, 'the HELP must name the remedy');
  });
});

// ── the batch verb (WRITER-BURST-BATCH / D4 + D5): one invocation, an ordered op list ────────────
describe('review-ledger-write — the batch verb (D4/D5)', () => {
  const codexReceipt = { schema: 1, artifact: 'code', fresh: true, fingerprint: FP, backend: 'codex', verdict: 'SHIP', grounded: true, timestamp: 't', probe: false };
  // A fromReceipts op drafts backends[] from this injected state (the single verb builds it from the
  // receipts file; the draft path itself is shared, so the injected state is equivalent).
  const currentState = { requiredBackends: ['codex'], backends: [{ backend: 'codex', state: 'current', verdict: 'SHIP' }] };
  const cleanBackends = [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }];
  // A fully-seeded environment (own ledger + code receipt + D5 gate-run) so a batch and the
  // single-verb replay start from byte-identical state.
  const freshEnv = () => {
    const d = mkdtempSync(join(tmpdir(), 'ledger-batch-'));
    const lp = join(d, 'ledger.jsonl');
    const rp = join(d, 'receipts.jsonl');
    writeFileSync(rp, `${JSON.stringify(codexReceipt)}\n`);
    writeFileSync(lp, `${gateRunLine()}\n`);
    const envDeps = { ledgerPath: lp, receiptsPath: rp, computeFingerprint: () => FP, resolveBase: () => BASE, countChangedLines: () => 0, plansInFlight: () => ['L.md'], buildState: () => currentState };
    return { d, lp, deps: envDeps };
  };
  // A representative triad: an override, a fromReceipts round (D4 per-op lane), and an explicit round.
  const triad = () => [
    { verb: 'override', loop: 'L', round: 1, scope: 'size-cap', sanctionedLines: 450, reason: 'one reviewed unit', timestamp: 't' },
    { verb: 'record', fromReceipts: true, loop: 'L', round: 1, origins: originsOf([]), findings: [], timestamp: 't' },
    { verb: 'record', loop: 'L', round: 2, backends: cleanBackends, origins: originsOf([]), findings: [], timestamp: 't' },
  ];

  it('D5 equivalence: a batch of N ops == the same N single-verb invocations (field-equal, fromReceipts op included)', () => {
    const A = freshEnv();
    recordOverride({ cwd: A.d, env: {}, loop: 'L', round: 1, scope: 'size-cap', sanctionedLines: 450, reason: 'one reviewed unit', timestamp: 't' }, A.deps);
    const drafted = draftBackendsFromReceipts({ state: currentState, findings: [], explicitBackends: [] });
    recordRound({ cwd: A.d, env: {}, loop: 'L', round: 1, origins: originsOf([]), findings: [], backends: drafted, timestamp: 't' }, A.deps);
    recordRound({ cwd: A.d, env: {}, loop: 'L', round: 2, backends: cleanBackends, origins: originsOf([]), findings: [], timestamp: 't' }, A.deps);

    const B = freshEnv();
    const { count } = runBatch({ cwd: B.d, env: {}, operations: triad() }, B.deps);
    assert.equal(count, 3, 'all three ops applied');
    assert.deepEqual(readLedger(B.lp).records, readLedger(A.lp).records, 'the batch ledger is record-equivalent to the single-verb ledger');
    rmSync(A.d, { recursive: true, force: true });
    rmSync(B.d, { recursive: true, force: true });
  });

  it('mid-batch fail-fast: a domain STOP stops the batch, the op already applied stays recorded, the message names the op index + applied count', () => {
    const A = freshEnv();
    const bad = [
      { verb: 'record', loop: 'L', round: 1, backends: cleanBackends, origins: originsOf([]), findings: [], timestamp: 't' },
      { verb: 'record', loop: 'L', round: 1, backends: cleanBackends, origins: originsOf([]), findings: [], timestamp: 't' }, // duplicate round → sequential STOP
    ];
    assert.throws(
      () => runBatch({ cwd: A.d, env: {}, operations: bad }, A.deps),
      (e) => e.code === LEDGER_WRITE_STOP && /operation \[1\]/.test(e.message) && /1 of 2/.test(e.message) && /sequential/.test(e.message),
    );
    assert.equal(readLedger(A.lp).records.filter((r) => r.kind === 'round').length, 1, 'op[0] is durable (append-only ledger)');
    rmSync(A.d, { recursive: true, force: true });
  });

  it('D5 preflight: every structural envelope error is a usage failure (exit 2) — validated with ZERO writes', () => {
    const cases = [
      [undefined, /must be an object/],
      [null, /must be an object/],
      [[], /must be an object/],
      [{}, /operations must be an array/],
      [{ operations: 'x' }, /operations must be an array/],
      [{ operations: [] }, /empty/],
      [{ operations: [null] }, /operation \[0\] must be an object/],
      [{ operations: ['x'] }, /operation \[0\] must be an object/],
      [{ operations: [{ verb: 'nope' }] }, /unknown verb "nope"/],
      [{ operations: [{ verb: 'classify', fromReceipts: true }] }, /fromReceipts on "classify"/],
    ];
    for (const [payload, re] of cases) {
      assert.throws(() => validateBatchEnvelope(payload), (e) => e.exitCode === 2 && re.test(e.message), `${JSON.stringify(payload)} must be a usage failure`);
    }
  });

  it('D4 per-op fromReceipts: a record op whose recipe-named backend has no fresh receipt is a LOUD stop (the draft never invents)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ledger-batch-'));
    const downState = { requiredBackends: ['codex'], backends: [{ backend: 'codex', state: 'missing' }] };
    assert.throws(
      () => runBatch({ cwd: d, env: {}, operations: [{ verb: 'record', fromReceipts: true, loop: 'L', round: 1, origins: originsOf([]), findings: [], timestamp: 't' }] },
        { ledgerPath: join(d, 'ledger.jsonl'), buildState: () => downState }),
      (e) => e.code === LEDGER_WRITE_STOP && /no fresh grounded code receipt/.test(e.message) && /operation \[0\]/.test(e.message),
    );
    assert.equal(readdirSync(d).includes('ledger.jsonl'), false, 'the draft fails before any write');
    rmSync(d, { recursive: true, force: true });
  });

  it('CLI: batch applies a triad via --json @file (the plain-command form); a preflight-bad envelope is exit 2 with ZERO writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-batch-cli-'));
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const head = g('rev-parse', 'HEAD').stdout.trim();
    const ledger = join(root, '.git', 'rl.jsonl');
    const env = { AW_REVIEW_LEDGER: ledger };
    // Seed a round with a surviving major so classify + override (neither needs a receipt/gate-run) apply.
    const seededRound = { schema: 4, loop: 'demo-plan', activity: 'plan-execution', kind: 'round', round: 1, base: head, fingerprint: FP, origins: originsOf([{ origin: 'first-draft' }]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }], timestamp: 't' };
    writeFileSync(ledger, `${JSON.stringify(seededRound)}\n`);
    const payloadFile = join(root, 'batch.json');
    writeFileSync(payloadFile, JSON.stringify({ operations: [
      { verb: 'classify', loop: 'demo-plan', round: 1, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }] },
      { verb: 'override', loop: 'demo-plan', round: 1, scope: 'oracle-change', files: ['x.test.mjs'], reason: 'deliberate' },
    ] }));
    const ok = main(['batch', '--json', `@${payloadFile}`, '--cwd', root], { env });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /recorded 2 operation\(s\) in one batch/);
    assert.deepEqual(readLedger(ledger).records.map((r) => r.kind), ['round', 'triage', 'override']);
    // A preflight-bad envelope: exit 2, and nothing appended (the ledger is byte-unchanged).
    const before = readFileSync(ledger, 'utf8');
    const badFile = join(root, 'bad.json');
    writeFileSync(badFile, JSON.stringify({ operations: [] }));
    const bad = main(['batch', '--json', `@${badFile}`, '--cwd', root], { env });
    assert.equal(bad.code, 2, bad.stderr);
    assert.equal(readFileSync(ledger, 'utf8'), before, 'a preflight failure writes nothing');
    rmSync(root, { recursive: true, force: true });
  });

  it('Phase 2.3 doc-contract pin: the documented writer-line verb list == the dispatch SUBCOMMANDS (docs cannot lag)', () => {
    const modeDoc = readFileSync(join(HERE, '..', 'references', 'modes', 'review-ledger.md'), 'utf8');
    const writerLine = modeDoc.split('\n').find((l) => /review-ledger-write\.mjs\s+[a-z|]+\s+--json/.test(l));
    assert.ok(writerLine, 'the writer-contract line exists in review-ledger.md');
    const listed = writerLine.match(/review-ledger-write\.mjs\s+([a-z|]+)\s+--json/);
    assert.deepEqual(listed[1].split('|').sort(), [...SUBCOMMANDS].sort(), 'the documented verb list == the dispatch');
    const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
    assert.ok(readme.includes('`batch`'), 'the README review-ledger row names the batch verb at the point of use');
  });

  // ── R1 council folds ──────────────────────────────────────────────────────
  it('R1 fold: a batch op carrying cwd/env is rejected at preflight (no per-op project redirect)', () => {
    for (const field of ['cwd', 'env']) {
      assert.throws(
        () => validateBatchEnvelope({ operations: [{ verb: 'record', [field]: '/evil', loop: 'L', round: 1 }] }),
        (e) => e.exitCode === 2 && new RegExp(`"${field}" field`).test(e.message),
        `an op carrying ${field} must be a preflight usage failure`,
      );
    }
  });

  it('R1 fold: a non-boolean fromReceipts is rejected (a string "false" no longer silently enables the draft)', () => {
    assert.throws(
      () => validateBatchEnvelope({ operations: [{ verb: 'record', fromReceipts: 'false', loop: 'L', round: 1 }] }),
      (e) => e.exitCode === 2 && /non-boolean fromReceipts/.test(e.message),
    );
    assert.equal(validateBatchEnvelope({ operations: [{ verb: 'record', fromReceipts: true, loop: 'L', round: 1 }] }).length, 1,
      'a real boolean fromReceipts still passes preflight');
  });

  it('R4 fold: fromReceipts on a non-record op is rejected by PRESENCE (even the literal fromReceipts:false on classify)', () => {
    assert.throws(
      () => validateBatchEnvelope({ operations: [{ verb: 'classify', fromReceipts: false, loop: 'L', round: 1 }] }),
      (e) => e.exitCode === 2 && /fromReceipts on "classify"/.test(e.message),
    );
  });

  it('R4 fold: the read-only checker (review-ledger.mjs) help lists every writer verb too (batch discoverable there)', () => {
    const readChecker = readFileSync(join(HERE, 'review-ledger.mjs'), 'utf8');
    assert.ok(readChecker.includes(SUBCOMMANDS.join('/')),
      `the read checker help must list the writer verbs as "${SUBCOMMANDS.join('/')}" (batch included)`);
  });
});
