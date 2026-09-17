import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVIDENCE_BASENAME, EVIDENCE_SCHEMA_VERSION, resolveEvidencePath, validateEvidenceRecord, readEvidence,
  evidenceKey, authoritativeEvidence, authoritativeOfKind, canonicalKindSerialization,
} from './core-evidence-store-read.mjs';
import { makeRepo, storeOf, validRedProof, validDegrade } from './core-evidence-harness.test.mjs';

// ── the store: path constant + resolver ──────────────────────────────────────────────────────────

// spec:core-evidence/S3
describe('evidence store path (D7: the ONE writer owns ONE git-dir JSONL file)', () => {
  it('EVIDENCE_BASENAME is the git-dir store name; schema version is 1', () => {
    assert.equal(EVIDENCE_BASENAME, 'agent-workflow-core-evidence.jsonl');
    assert.equal(EVIDENCE_SCHEMA_VERSION, 1);
  });
  it('AW_CORE_EVIDENCE overrides the git-dir default; null outside a git tree', () => {
    assert.equal(resolveEvidencePath('/x', { AW_CORE_EVIDENCE: '/tmp/ce.jsonl' }), '/tmp/ce.jsonl');
    const { root } = makeRepo();
    assert.equal(resolveEvidencePath(root, {}), storeOf(root));
    const bare = mkdtempSync(join(tmpdir(), 'core-evidence-nogit-'));
    assert.equal(resolveEvidencePath(bare, {}), null);
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
});

// ── validateEvidenceRecord: closed schema + per-kind arms (D6a) ───────────────────────────────────

describe('validateEvidenceRecord — versioned schema, closed kinds, per-kind fields', () => {
  it('a valid red-proof and a valid degrade validate', () => {
    assert.equal(validateEvidenceRecord(validRedProof()).ok, true);
    assert.equal(validateEvidenceRecord(validDegrade()).ok, true);
    assert.equal(validateEvidenceRecord(validRedProof({ base: null })).ok, true, 'an unborn-branch red-proof (base null) is valid');
  });
  it('an unknown schema version is refused by name (fail closed)', () => {
    for (const bad of [2, 0, 'x', undefined]) {
      const v = validateEvidenceRecord(validRedProof({ schema: bad }));
      assert.equal(v.ok, false);
      assert.match(v.reason, /schema/);
    }
  });
  it('an unknown kind is refused by name', () => {
    const v = validateEvidenceRecord(validRedProof({ kind: 'mystery' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /kind/);
  });
  it('the final-run kinds validate: final-start and a completed final (green/red)', () => {
    const start = { schema: 1, kind: 'final-start', fingerprint: 'c'.repeat(64), attempt: 'a1', timestamp: 't' };
    assert.equal(validateEvidenceRecord(start).ok, true);
    const done = {
      schema: 1, kind: 'final', status: 'green', attempt: 'a1',
      fingerprintBefore: 'c'.repeat(64), fingerprintAfter: 'c'.repeat(64),
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }],
      results: [{ id: 'unit-tests', ok: true, code: 0 }],
      evidenceHashes: { redProof: 'a'.repeat(64), degrade: 'b'.repeat(64) },
      lcovSha256: null, integrityFailure: null, timestamp: 't',
    };
    assert.equal(validateEvidenceRecord(done).ok, true);
    assert.equal(validateEvidenceRecord({ ...done, status: 'maybe' }).ok, false, 'status is a closed enum');
    assert.equal(validateEvidenceRecord({ ...done, declared: [] }).ok, false, 'an empty declaration never attests');
    assert.equal(validateEvidenceRecord({ ...done, evidenceHashes: { redProof: 'zz' } }).ok, false);
    assert.equal(validateEvidenceRecord({ ...done, results: 'nope' }).ok, false, 'results must be the per-gate array');
    assert.equal(validateEvidenceRecord({ ...done, results: [{ id: 1, ok: true }] }).ok, false, 'a result row needs a string id and boolean ok');
    assert.equal(validateEvidenceRecord({ ...done, lcovSha256: 'zz' }).ok, false, 'lcovSha256 is 64-hex or null');
    assert.equal(validateEvidenceRecord({ ...done, lcovSha256: 'a'.repeat(64) }).ok, true, 'a consumed lcov records its sha');
    const key1 = evidenceKey(done);
    const key2 = evidenceKey({ ...done, status: 'red', results: [] });
    assert.equal(key1, key2, 'completed attempts key on fingerprintBefore — the LATEST attempt is authoritative');
  });
  // The run's own coverage token (kit-inert-gate Phase 2): ADDITIVE like evidenceHashes.flow, and
  // CLOSED — `none` can never ride a final receipt (--final refuses a declaration without the
  // canonical checker last), and `certified` is cross-checked against the bound digest.
  it('the final coverage token is ADDITIVE and closed: none is refused, certified needs a bound digest', () => {
    const done = {
      schema: 1, kind: 'final', status: 'green', attempt: 'a1',
      fingerprintBefore: 'c'.repeat(64), fingerprintAfter: 'c'.repeat(64),
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }],
      results: [{ id: 'unit-tests', ok: true, code: 0 }],
      evidenceHashes: { redProof: 'a'.repeat(64), degrade: 'b'.repeat(64) },
      lcovSha256: null, integrityFailure: null, timestamp: 't',
    };
    assert.equal(validateEvidenceRecord(done).ok, true, 'a pre-token final stays valid to the new reader');
    for (const token of ['not-run', 'unknown']) {
      assert.equal(validateEvidenceRecord({ ...done, coverage: token }).ok, true, `${token} rides a digest-less receipt`);
    }
    const noneRecord = validateEvidenceRecord({ ...done, coverage: 'none' });
    assert.equal(noneRecord.ok, false, 'a final run always selects the checker — "none" describes a run that cannot have happened');
    assert.match(noneRecord.reason, /coverage/);
    for (const bad of ['certified ', 42, null, '']) {
      assert.equal(validateEvidenceRecord({ ...done, coverage: bad }).ok, false, `coverage=${JSON.stringify(bad)} must be malformed`);
    }
    const uncertified = validateEvidenceRecord({ ...done, coverage: 'certified' });
    assert.equal(uncertified.ok, false, 'certified over a null digest is a contradiction');
    assert.match(uncertified.reason, /certified/);
    assert.equal(validateEvidenceRecord({ ...done, coverage: 'certified', lcovSha256: 'a'.repeat(64) }).ok, true);
  });
  it('evidenceHashes.flow is ADDITIVE (Plan 4 D10): absent valid, 64-hex valid, anything else malformed', () => {
    const done = {
      schema: 1, kind: 'final', status: 'green', attempt: 'a1',
      fingerprintBefore: 'c'.repeat(64), fingerprintAfter: 'c'.repeat(64),
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }],
      results: [{ id: 'unit-tests', ok: true, code: 0 }],
      evidenceHashes: { redProof: 'a'.repeat(64), degrade: 'b'.repeat(64) },
      lcovSha256: null, integrityFailure: null, timestamp: 't',
    };
    assert.equal(validateEvidenceRecord(done).ok, true, 'a pre-upgrade final (no flow field) stays valid to the new reader');
    const bound = { ...done, evidenceHashes: { ...done.evidenceHashes, flow: 'd'.repeat(64) } };
    assert.equal(validateEvidenceRecord(bound).ok, true, 'a flow-bearing final validates (the additive cross-version claim)');
    for (const bad of ['zz', 42, null, '']) {
      const v = validateEvidenceRecord({ ...done, evidenceHashes: { ...done.evidenceHashes, flow: bad } });
      assert.equal(v.ok, false, `flow=${JSON.stringify(bad)} must be malformed`);
      assert.match(v.reason, /evidenceHashes\.flow/);
    }
  });
  it('the final kinds enforce attempt linkage, 1:1 ordered results, and status consistency (fail closed)', () => {
    const done = {
      schema: 1, kind: 'final', status: 'green', attempt: 'a1',
      fingerprintBefore: 'c'.repeat(64), fingerprintAfter: 'c'.repeat(64),
      declared: [{ id: 'g1', cmd: 'true' }, { id: 'g2', cmd: 'true' }],
      results: [{ id: 'g1', ok: true, code: 0 }, { id: 'g2', ok: true, code: 0 }],
      evidenceHashes: { redProof: 'a'.repeat(64), degrade: 'b'.repeat(64) },
      lcovSha256: null, integrityFailure: null, timestamp: 't',
    };
    assert.equal(validateEvidenceRecord(done).ok, true);
    const { attempt: _a, ...noAttempt } = done;
    assert.equal(validateEvidenceRecord(noAttempt).ok, false, 'a completion without its attempt id never validates');
    const start = { schema: 1, kind: 'final-start', fingerprint: 'c'.repeat(64), timestamp: 't' };
    assert.equal(validateEvidenceRecord(start).ok, false, 'a start without its attempt id never validates');
    assert.equal(validateEvidenceRecord({ ...start, attempt: 'a1' }).ok, true);
    assert.equal(validateEvidenceRecord({ ...done, results: done.results.slice(0, 1) }).ok, false, 'results must cover the declaration 1:1');
    assert.equal(
      validateEvidenceRecord({ ...done, results: [done.results[1], done.results[0]] }).ok, false,
      'results must mirror the declared ORDER — a shuffled attribution never validates',
    );
    assert.equal(validateEvidenceRecord({ ...done, results: [done.results[0], { id: 'g2', ok: true, code: 1.5 }] }).ok, false, 'code is an integer or null');
    assert.equal(validateEvidenceRecord({ ...done, results: [done.results[0], { id: 'g2', ok: true, code: null }] }).ok, true, 'a spawn-failed gate records code null');
    assert.equal(
      validateEvidenceRecord({ ...done, results: [done.results[0], { id: 'g2', ok: false, code: 1 }] }).ok, false,
      'status green with a failing result is a lie — refused',
    );
    assert.equal(
      validateEvidenceRecord({ ...done, status: 'red' }).ok, false,
      'status red with all-green results and no integrity failure is a lie — refused',
    );
    assert.equal(validateEvidenceRecord({ ...done, integrityFailure: '' }).ok, false, 'an empty integrity reason never validates');
    assert.equal(
      validateEvidenceRecord({ ...done, status: 'red', integrityFailure: 'the lcov moved under the run' }).ok, true,
      'an integrity failure forces red even over all-green results — the ONE honest representation',
    );
    assert.equal(
      validateEvidenceRecord({ ...done, integrityFailure: 'the lcov moved under the run' }).ok, false,
      'status green with a named integrity failure is a lie — refused',
    );
  });
  it('a red-proof with anything but an N/N red observation is malformed (reds must equal runs)', () => {
    assert.equal(validateEvidenceRecord(validRedProof({ reds: 2 })).ok, false);
    assert.equal(validateEvidenceRecord(validRedProof({ runs: 0, reds: 0 })).ok, false);
  });
  it('red-proof field arms are refused by name: testId format, file, hashes, fingerprint, timestamp', () => {
    for (const [field, bad] of [
      ['testId', 'no-separator'], ['testId', '#empty-file'], ['testId', 'file.mjs#'], ['testId', 7],
      ['file', ''], ['fileHash', 'zz'], ['fileHash', 'a'.repeat(63)], ['base', 'nothex'],
      ['fingerprint', ''], ['timestamp', ''],
    ]) {
      const v = validateEvidenceRecord(validRedProof({ [field]: bad }));
      assert.equal(v.ok, false, `${field}=${JSON.stringify(bad)} must be refused`);
      assert.match(v.reason, new RegExp(field));
    }
  });
  it('a degrade without a non-empty reason is refused by name (the D3(b) fixture)', () => {
    for (const bad of ['', '   ', undefined, 7]) {
      const v = validateEvidenceRecord(validDegrade({ reason: bad }));
      assert.equal(v.ok, false, `reason=${JSON.stringify(bad)} must be refused`);
      assert.match(v.reason, /reason/);
    }
  });
  it('a degrade without a backend or a well-formed fingerprint is refused by name', () => {
    assert.equal(validateEvidenceRecord(validDegrade({ backend: '' })).ok, false);
    assert.equal(validateEvidenceRecord(validDegrade({ fingerprint: 'short' })).ok, false);
  });
  it('a red-proof whose file half mismatches its testId is refused', () => {
    const mismatch = validateEvidenceRecord(validRedProof({ file: 'other.test.mjs' }));
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.reason, /file must equal the testId file half/);
    const forgedAbs = validateEvidenceRecord(validRedProof({ testId: '/abs/x.test.mjs#y', file: '/abs/x.test.mjs' }));
    assert.equal(forgedAbs.ok, false, 'an equal but ABSOLUTE pair must still be refused (lexical repo-relative guard)');
    assert.match(forgedAbs.reason, /repo-relative/);
    const forgedEscape = validateEvidenceRecord(validRedProof({ testId: '../esc.test.mjs#y', file: '../esc.test.mjs' }));
    assert.equal(forgedEscape.ok, false, 'an equal but ESCAPING pair must still be refused');
  });
  it('a whitespace-only backend is refused by the validator (trim-empty)', () => {
    const v = validateEvidenceRecord(validDegrade({ backend: '   ' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /backend/);
  });
  it('a 64-hex base validates (git sha256 object format); junk still refused', () => {
    assert.equal(validateEvidenceRecord(validRedProof({ base: 'f'.repeat(64) })).ok, true);
    assert.equal(validateEvidenceRecord(validRedProof({ base: 'f'.repeat(63) })).ok, false);
  });
});

// ── readEvidence: fail-closed reader (D6a reader tests: malformed, unknown-schema) ────────────────

describe('readEvidence — absent file empty; malformed / unknown-schema lines counted with reasons', () => {
  it('an absent file reads empty (no review ever ran is not an error)', () => {
    const r = readEvidence(join(tmpdir(), 'core-evidence-ghost.jsonl'));
    assert.deepEqual([r.records.length, r.malformed], [0, 0]);
  });
  it('valid lines parse; bad JSON, a non-object, an unknown schema, and a schema-invalid record are each counted malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-read-'));
    const path = join(dir, 'ce.jsonl');
    writeFileSync(path, [
      JSON.stringify(validRedProof()),
      'not json at all',
      '"a string line"',
      JSON.stringify(validDegrade({ schema: 99 })),
      JSON.stringify(validDegrade({ reason: '' })),
      JSON.stringify(validDegrade()),
    ].join('\n'));
    const r = readEvidence(path);
    assert.equal(r.records.length, 2);
    assert.equal(r.malformed, 4);
    assert.equal(r.malformedReasons.length, 4);
    rmSync(dir, { recursive: true, force: true });
  });
  it('a non-ENOENT read failure surfaces as readError (fail closed), never an empty success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-eisdir-'));
    const r = readEvidence(dir);
    assert.ok(r.readError, 'reading a directory must surface a readError');
    assert.equal(r.records.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── D6a: per-kind keys, authoritative selection, canonical serialization ──────────────────────────

describe('authoritative selection + canonical serialization (D6a: LATEST per key, file order)', () => {
  it('evidenceKey returns null for an unknown kind and authoritativeEvidence skips it', () => {
    assert.equal(evidenceKey({ kind: 'mystery' }), null);
    assert.deepEqual(authoritativeEvidence([{ kind: 'mystery' }]), []);
  });
  it('evidenceKey: red-proof keys on {base, testId}; degrade keys on {backend, fingerprint}', () => {
    assert.equal(evidenceKey(validRedProof()), evidenceKey(validRedProof({ fileHash: 'f'.repeat(64) })));
    assert.notEqual(evidenceKey(validRedProof()), evidenceKey(validRedProof({ base: 'e'.repeat(40) })));
    assert.notEqual(evidenceKey(validRedProof()), evidenceKey(validRedProof({ testId: 'lib.test.mjs#other' })));
    assert.equal(evidenceKey(validDegrade()), evidenceKey(validDegrade({ reason: 'another reason' })));
    assert.notEqual(evidenceKey(validDegrade()), evidenceKey(validDegrade({ backend: 'codex' })));
    assert.notEqual(evidenceKey(validDegrade()), evidenceKey(validDegrade({ fingerprint: 'd'.repeat(64) })));
  });
  it('degrade supersession is per {backend, fingerprint}; distinct fingerprints both stay authoritative', () => {
    const d1 = validDegrade({ reason: 'first', timestamp: 't1' });
    const d2 = validDegrade({ reason: 'second', timestamp: 't2' });
    const other = validDegrade({ fingerprint: 'd'.repeat(64), reason: 'other tree' });
    const auth = authoritativeOfKind([d1, d2, other], 'degrade');
    assert.equal(auth.length, 2);
    assert.equal(auth.find((r) => r.fingerprint === 'c'.repeat(64)).reason, 'second');
  });
  it('authoritativeEvidence spans kinds; canonicalKindSerialization is per-kind, stable under key order, newline-terminated', () => {
    const rp = validRedProof();
    const dg = validDegrade();
    const auth = authoritativeEvidence([rp, dg]);
    assert.equal(auth.length, 2);
    const reordered = JSON.parse(JSON.stringify(dg, Object.keys(dg).sort().reverse()));
    assert.equal(
      canonicalKindSerialization([dg], 'degrade'),
      canonicalKindSerialization([reordered], 'degrade'),
      'canonical bytes are independent of the original key order',
    );
    const s = canonicalKindSerialization([rp, dg], 'red-proof');
    assert.ok(s.endsWith('\n'));
    assert.match(s, /red-proof/);
    assert.doesNotMatch(s, /degrade/, 'serialization never mixes kinds (receipts/other kinds are outside the hashed domain)');
    assert.equal(canonicalKindSerialization([], 'red-proof'), '', 'an empty authoritative set serializes empty');
  });
});
