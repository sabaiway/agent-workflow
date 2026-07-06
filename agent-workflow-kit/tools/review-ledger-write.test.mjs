import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRound, recordTriage, HARD_MAX, LEDGER_WRITE_STOP } from './review-ledger-write.mjs';
import { readLedger } from './review-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FP = 'a'.repeat(64);
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
const codexReceiptFile = (path, fingerprint = FP, verdict = 'SHIP') =>
  writeFileSync(path, `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint, backend: 'codex', verdict, grounded: true, timestamp: 't' })}\n`);

let dir;
let ledgerPath;
let receiptsPath;
const deps = () => ({ ledgerPath, receiptsPath, computeFingerprint: () => FP });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-write-'));
  ledgerPath = join(dir, 'ledger.jsonl');
  receiptsPath = join(dir, 'receipts.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('review-ledger-write — append + read back', () => {
  it('appends a round and reads it back through the read module', () => {
    codexReceiptFile(receiptsPath);
    const params = roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }], findings: [] });
    const { record } = recordRound({ ...params, cwd: dir, env: {} }, deps());
    assert.equal(record.kind, 'round');
    assert.equal(record.fingerprint, FP);
    const { records, malformed } = readLedger(ledgerPath);
    assert.equal(malformed, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].round, 1);
  });

  it('appends a triage after a round (JSONL grows, both parse)', () => {
    codexReceiptFile(receiptsPath);
    recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }] }), cwd: dir, env: {} }, deps());
    recordTriage({ loop: 'L', round: 1, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, deps());
    const { records } = readLedger(ledgerPath);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.kind), ['round', 'triage']);
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
    // Pre-seed a VALID sequence [1,2] ending at a cap-reached round with an UNCLASSIFIED surviving major.
    const r1 = { schema: 1, loop: 'L', activity: 'plan-execution', kind: 'round', round: 1, fingerprint: FP, origins: originsOf([{ origin: 'first-draft' }]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }], timestamp: 't' };
    const r2 = { ...r1, round: 2 };
    writeFileSync(ledgerPath, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);
    codexReceiptFile(receiptsPath);
    const params = roundParams({ round: 3, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(
      () => recordRound({ ...params, cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /triage is required/.test(e.message),
    );
  });

  it('PERMITS the next round once the surviving finding is classified (no deadlock)', () => {
    const r1 = { schema: 1, loop: 'L', activity: 'plan-execution', kind: 'round', round: 1, fingerprint: FP, origins: originsOf([{ origin: 'first-draft' }]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }], timestamp: 't' };
    const r2 = { ...r1, round: 2 };
    const cls = { schema: 1, loop: 'L', activity: 'plan-execution', kind: 'triage', round: 2, fingerprint: FP, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: null, note: '' }], timestamp: 't' };
    writeFileSync(ledgerPath, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n${JSON.stringify(cls)}\n`);
    codexReceiptFile(receiptsPath);
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
    const params = roundParams({ backends: [{ backend: 'agy', degraded: true, reason: 'Issue-001 stall', blockers: 0, majors: 0, minors: 0, verdict: 'degraded' }] });
    const { record } = recordRound({ ...params, cwd: dir, env: {} }, deps());
    assert.equal(record.backends[0].degraded, true);
    assert.equal(readLedger(ledgerPath).records.length, 1);
  });
});

describe('review-ledger-write — atomic-write hardening', () => {
  it('refuses a SYMLINKED ledger leaf (a write would clobber the link target)', () => {
    const target = join(dir, 'real.jsonl');
    writeFileSync(target, '');
    symlinkSync(target, ledgerPath);
    codexReceiptFile(receiptsPath);
    const params = roundParams({ backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] });
    assert.throws(() => recordRound({ ...params, cwd: dir, env: {} }, deps()), /symlink/);
    assert.equal(readFileSync(target, 'utf8'), '', 'the link target is untouched');
  });
});

describe('review-ledger-write — R1 folds (fail-closed ledger reads + triage round-binding)', () => {
  it('recordRound refuses to append while the ledger has malformed lines (fail closed, codex R1)', () => {
    writeFileSync(ledgerPath, '{not json\n');
    codexReceiptFile(receiptsPath);
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
    recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' }], findings: [{ findingKey: 'k', severity: 'major', origin: 'first-draft', backend: 'codex' }] }), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordTriage({ loop: 'L', round: 9, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '' }], timestamp: 't', cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /no such recorded round/.test(e.message),
    );
  });

  it('recordTriage rejects classifying a key that is not a surviving blocker of the round (codex R1)', () => {
    codexReceiptFile(receiptsPath);
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
    assert.throws(
      () => recordRound({ ...codexRound(2), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /sequential/.test(e.message),
    );
  });

  it('rejects a DUPLICATE round number', () => {
    codexReceiptFile(receiptsPath);
    recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /sequential/.test(e.message),
    );
  });

  it('rejects a GAPPED / out-of-order round (round 3 after round 1)', () => {
    codexReceiptFile(receiptsPath);
    recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps());
    assert.throws(
      () => recordRound({ ...codexRound(3), cwd: dir, env: {} }, deps()),
      (e) => e.code === LEDGER_WRITE_STOP && /sequential/.test(e.message),
    );
  });

  it('accepts strictly sequential rounds (1 then 2)', () => {
    codexReceiptFile(receiptsPath);
    recordRound({ ...codexRound(1), cwd: dir, env: {} }, deps());
    const { record } = recordRound({ ...codexRound(2), cwd: dir, env: {} }, deps());
    assert.equal(record.round, 2);
    assert.equal(readLedger(ledgerPath).records.length, 2);
  });

  it('refuses to append onto a CORRUPT existing sequence ([2] with no round 1) — codex R3', () => {
    codexReceiptFile(receiptsPath);
    const corrupt = { schema: 1, loop: 'L', activity: 'plan-execution', kind: 'round', round: 2, fingerprint: FP, origins: originsOf([]), backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }], findings: [], timestamp: 't' };
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

  it('records a fixable-bug with a well-formed testId — and emits schema 2', () => {
    seedRoundWithMajorK();
    const { record } = classify({ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID });
    assert.equal(record.schema, 2, 'the writer emits schema 2');
    assert.equal(record.classifications[0].testId, WELL_FORMED_TESTID);
  });

  it('records inherent-layer-residual / escalate WITHOUT a testId (only fixable-bug requires one)', () => {
    // Both classify 'k' (a surviving major of round 1); a triage has no teeth, so two triages for the
    // same round both record — one dir, one seed.
    seedRoundWithMajorK();
    for (const cls of ['inherent-layer-residual', 'escalate']) {
      const { record } = classify({ findingKey: 'k', class: cls, accepted: true });
      assert.equal(record.schema, 2);
      assert.equal(record.classifications[0].testId, null, `${cls} may omit testId → normalized to null`);
    }
  });

  it('a recorded ROUND also emits schema 2', () => {
    codexReceiptFile(receiptsPath);
    const { record } = recordRound({ ...roundParams({ round: 1, backends: [{ backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'SHIP' }] }), cwd: dir, env: {} }, deps());
    assert.equal(record.schema, 2);
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
});
