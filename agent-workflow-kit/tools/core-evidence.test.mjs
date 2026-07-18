// core-evidence.test.mjs — spec-first for the ONE core-evidence writer (strip-the-kit, D3(b)/(c) +
// D6 + D6a + D7). Scope: the git-dir evidence store (path constant, versioned schema, fail-closed
// reader, duplicate-refusing append, per-kind authoritative selection + canonical serialization),
// the red-proof verb (observed-red declaration over the MOVED runner safeguards: safe repo-relative
// resolution, no-follow containment, shell-free argv, per-run timeout, N/N reruns, the quarantine
// lane), the degrade verb (backend + non-empty reason + fingerprint), and the stateless D6 summary.
//
// Pure helpers are unit-tested directly; the integration cases drive the real verbs over hermetic
// git fixture repos (the retired fold runner's makeRepo idiom) with REAL `node --test`
// subprocesses, never mocked.
//
// The module under test is imported DYNAMICALLY (the D7 authoring pattern, the
// retired-runner precedent): this spec LOADS — and fails per fixture — on the
// pre-implementation tree, so every refusal fixture has an observed RED first.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, computeFingerprintPayload } from './review-state.mjs';
import { lstatSync } from 'node:fs';

const core = await import('./core-evidence.mjs').catch(() => null);
const {
  isBinaryFile,
  readReceipts,
  isShipVerdict,
  classifyReviewReceiptForTree,
  CORE_EVIDENCE_STOP,
  EVIDENCE_BASENAME,
  EVIDENCE_SCHEMA_VERSION,
  resolveEvidencePath,
  validateEvidenceRecord,
  readEvidence,
  appendEvidenceRecord,
  evidenceKey,
  authoritativeEvidence,
  authoritativeOfKind,
  canonicalKindSerialization,
  resolveTestFile,
  containsPath,
  hashFileBytes,
  parseProbeOutput,
  defaultBoundArgv,
  probeKnobsFromEnv,
  runRedProof,
  runDegrade,
  summarizeReviewReceiptsForTree,
  describeMissingReviewAttestation,
  main,
} = core ?? {};

// ── hermetic fixtures (the family idiom: mkdtemp repo + a clean AW_-stripped env) ─────────────────

const gitInit = (root) => {
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  return g;
};

const fixtureEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, ...extra };
};

// Every makeRepo starts from the SAME committed base — built once, cloned per test (a per-test
// `git init`+commit dominated this suite's wall).
const REPO_TEMPLATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'core-evidence-template-'));
  const g = gitInit(dir);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return dir;
})();
after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'core-evidence-'));
  cpSync(REPO_TEMPLATE, root, { recursive: true });
  return { root, g: (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }) };
};

const headOf = (root) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const storeOf = (root) => join(root, '.git', 'agent-workflow-core-evidence.jsonl');

const validRedProof = (over = {}) => ({
  schema: 1, kind: 'red-proof', testId: 'lib.test.mjs#red case', file: 'lib.test.mjs',
  fileHash: 'a'.repeat(64), runs: 3, reds: 3, base: 'b'.repeat(40), fingerprint: 'c'.repeat(64),
  timestamp: '2026-07-16T00:00:00Z', ...over,
});
const validDegrade = (over = {}) => ({
  schema: 1, kind: 'degrade', backend: 'agy', reason: 'oversized diff — headless permission lane missing',
  fingerprint: 'c'.repeat(64), timestamp: '2026-07-16T00:00:00Z', ...over,
});

// ── the store: path constant + resolver ──────────────────────────────────────────────────────────

describe('evidence store path (D7: the ONE writer owns ONE git-dir JSONL file)', () => {
  it('module exists (authored red-first: this spec predates the implementation)', () => {
    assert.ok(core, 'core-evidence.mjs must exist and load');
  });
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

// ── appendEvidenceRecord: validated, atomic, duplicate-refusing (D6a) ─────────────────────────────

describe('appendEvidenceRecord — the ONE writer: validate, refuse duplicates, atomic append', () => {
  it('appends one JSONL line and round-trips through readEvidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-append-'));
    const path = join(dir, 'ce.jsonl');
    appendEvidenceRecord({ path, record: validRedProof() });
    appendEvidenceRecord({ path, record: validDegrade() });
    const r = readEvidence(path);
    assert.equal(r.records.length, 2);
    assert.equal(r.malformed, 0);
    rmSync(dir, { recursive: true, force: true });
  });
  it('a malformed record is refused fail-closed and NOTHING is written (the D6a fixture)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-refuse-'));
    const path = join(dir, 'ce.jsonl');
    assert.throws(
      () => appendEvidenceRecord({ path, record: validDegrade({ reason: '' }) }),
      (e) => e.code === CORE_EVIDENCE_STOP && /reason/.test(e.message),
    );
    assert.equal(existsSync(path), false, 'a refusal writes nothing');
    rmSync(dir, { recursive: true, force: true });
  });
  it('a byte-identical replayed line is refused as a duplicate; a re-observation (different bytes) appends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-dup-'));
    const path = join(dir, 'ce.jsonl');
    const a = validRedProof();
    appendEvidenceRecord({ path, record: a });
    assert.throws(
      () => appendEvidenceRecord({ path, record: a }),
      (e) => e.code === CORE_EVIDENCE_STOP && /duplicate/.test(e.message),
    );
    const b = validRedProof({ fileHash: 'd'.repeat(64), fingerprint: 'e'.repeat(64), timestamp: '2026-07-16T01:00:00Z' });
    appendEvidenceRecord({ path, record: b });
    assert.equal(readEvidence(path).records.length, 2, 'same key, different bytes = supersession, never duplicate');
    rmSync(dir, { recursive: true, force: true });
  });
  it('appending over a store with malformed lines is refused fail-closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-badstore-'));
    const path = join(dir, 'ce.jsonl');
    const before = `${JSON.stringify(validRedProof())}\nnot json at all\n`;
    writeFileSync(path, before);
    assert.throws(
      () => appendEvidenceRecord({ path, record: validDegrade() }),
      (e) => e.code === CORE_EVIDENCE_STOP && /malformed line/.test(e.message),
    );
    assert.equal(readFileSync(path, 'utf8'), before, 'the store is byte-identical after the refusal');
    rmSync(dir, { recursive: true, force: true });
  });
  it('appendEvidenceRecord refuses when the store cannot be read at all (non-ENOENT)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-appdir-'));
    assert.throws(
      () => appendEvidenceRecord({ path: dir, record: validDegrade() }),
      (e) => e.code === CORE_EVIDENCE_STOP && /cannot read the evidence store/.test(e.message),
    );
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
  it('the joint D6a pin: duplicate-refusal AND red A → edit → red B supersession together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-joint-'));
    const path = join(dir, 'ce.jsonl');
    const redA = validRedProof({ fileHash: 'a'.repeat(64), timestamp: 't1' });
    appendEvidenceRecord({ path, record: redA });
    assert.throws(() => appendEvidenceRecord({ path, record: redA }), (e) => /duplicate/.test(e.message), 'a replayed line is refused');
    const redB = validRedProof({ fileHash: 'b'.repeat(64), fingerprint: 'd'.repeat(64), timestamp: 't2' });
    appendEvidenceRecord({ path, record: redB }); // the test file was edited → re-observed red = a NEW record, not a hash conflict
    const { records } = readEvidence(path);
    const auth = authoritativeOfKind(records, 'red-proof');
    assert.equal(auth.length, 1, 'one authoritative record per {base, testId}');
    assert.equal(auth[0].fileHash, 'b'.repeat(64), 'the LATEST record supersedes (red B wins)');
    rmSync(dir, { recursive: true, force: true });
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

// ── the review-domain primitives (owned here since the DAG inversion) ─────────────────────────────

describe('the closed verdict vocabulary — type-strict, never coerced', () => {
  it('a non-string verdict never coerces into the closed vocabulary', () => {
    assert.equal(isShipVerdict(['ship']), false, 'String([\'ship\']) === \'ship\' — coercion must never admit an array');
    assert.equal(isShipVerdict({ toString: () => 'ship' }), false);
    assert.equal(isShipVerdict(0), false);
    assert.equal(isShipVerdict('ship'), true);
    const fp = 'f'.repeat(64);
    const arrayVerdict = { schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: ['ship'], grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't' };
    assert.equal(classifyReviewReceiptForTree(arrayVerdict, fp), 'unrecognized-verdict');
  });

  it('the verdict arm precedes grounding: ungrounded plus unknown classifies unrecognized-verdict', () => {
    const fp = 'f'.repeat(64);
    const receipt = { schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'unknown', grounded: false, probe: false, posture: { model: 'm' }, timestamp: 't' };
    assert.equal(classifyReviewReceiptForTree(receipt, fp), 'unrecognized-verdict', 'grounding never reclassifies an unrecognized verdict');
    const ungroundedRevise = { ...receipt, verdict: 'revise' };
    assert.equal(classifyReviewReceiptForTree(ungroundedRevise, fp), 'ungrounded', 'a RECOGNIZED verdict without grounding stays ungrounded (not a veto)');
  });
});

// ── the D5 posture marker (strip Phase 4) — the probe-marker twin ─────────────────────────────────
describe('the D5 posture marker — absent/empty/invalid never attest, fail closed', () => {
  const fp = 'f'.repeat(64);
  const base = { schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'ship', grounded: true, probe: false, timestamp: 't' };

  it('ABSENT posture → posture-unmarked (silence is not a declaration; pre-D5 receipts stop satisfying)', () => {
    assert.equal(classifyReviewReceiptForTree(base, fp), 'posture-unmarked');
  });

  it('EMPTY or INVALID posture shapes → malformed-posture, never attesting', () => {
    for (const posture of [{}, null, 'gpt-5.6-sol', 42, [], { model: '' }, { model: 42 }, { model: 'm', effort: '' }, { model: 'm', effort: 7 }, { model: 'm', tier: 0 }, { model: 'm', tier: '' }]) {
      assert.equal(classifyReviewReceiptForTree({ ...base, posture }, fp), 'malformed-posture', `posture=${JSON.stringify(posture)}`);
    }
  });

  it('a VALID posture attests: {model} alone (agy) and {model, effort, tier|null} (codex)', () => {
    assert.equal(classifyReviewReceiptForTree({ ...base, posture: { model: 'Gemini 3.1 Pro (High)' } }, fp), 'attesting');
    assert.equal(classifyReviewReceiptForTree({ ...base, posture: { model: 'gpt-5.6-sol', effort: 'xhigh', tier: null } }, fp), 'attesting');
    assert.equal(classifyReviewReceiptForTree({ ...base, posture: { model: 'gpt-5.6-sol', effort: 'xhigh', tier: 'priority' } }, fp), 'attesting');
  });

  it('order is load-bearing: after the probe arms, BEFORE the verdict arm', () => {
    assert.equal(classifyReviewReceiptForTree({ ...base, probe: true }, fp), 'probe', 'a posture-less probe still classifies probe');
    assert.equal(classifyReviewReceiptForTree({ ...base, verdict: 'unknown' }, fp), 'posture-unmarked', 'the posture arm precedes the verdict arm');
  });

  it('summarize lands posture-rejected receipts in the rejected state with a stated posture reason', () => {
    const s = summarizeReviewReceiptsForTree([base, { ...base, posture: {} }], fp);
    assert.equal(s.state, 'rejected');
    assert.match(describeMissingReviewAttestation(s), /posture/);
  });
});

describe('review-domain primitives — the defensive arms of the canonical payload walk', () => {
  it('isBinaryFile: NUL bytes → binary; text → false; an unreadable read (EISDIR) → false via the catch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-bin-'));
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(dir, 'text.txt'), 'plain text\n');
    assert.equal(isBinaryFile(join(dir, 'bin.dat')), true);
    assert.equal(isBinaryFile(join(dir, 'text.txt')), false);
    assert.equal(isBinaryFile(dir), false, 'a directory read fails (EISDIR) — the fail-safe arm reads as text');
    rmSync(dir, { recursive: true, force: true });
  });

  it('computeFingerprintPayload: a THROWING lstat keeps the path as a name-only nonregular note (vanished path)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'ghosty.txt'), 'untracked\n');
    const throwingLstat = (p) => {
      if (p.endsWith('ghosty.txt')) throw new Error('vanished');
      return lstatSync(p);
    };
    const payload = computeFingerprintPayload(root, { lstat: throwingLstat });
    assert.match(payload.toString('utf8'), /untracked-nonregular:ghosty\.txt/);
    rmSync(root, { recursive: true, force: true });
  });

  it('computeFingerprintPayload: a lying symlink stat whose readlink fails rides as "-> ?" (never a crash)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'fake-link.txt'), 'a regular file the stat calls a symlink\n');
    const lyingLstat = (p) => {
      const real = lstatSync(p);
      if (!p.endsWith('fake-link.txt')) return real;
      return { ...real, isFile: () => false, isSymbolicLink: () => true, isCharacterDevice: () => false, isBlockDevice: () => false, isFIFO: () => false, isSocket: () => false, isDirectory: () => false };
    };
    const payload = computeFingerprintPayload(root, { lstat: lyingLstat });
    assert.match(payload.toString('utf8'), /untracked-symlink:fake-link\.txt -> \?/);
    rmSync(root, { recursive: true, force: true });
  });

  it('readReceipts: a valid-JSON line that is not a receipt object counts malformed (the else arm)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-recmal-'));
    const path = join(dir, 'receipts.jsonl');
    writeFileSync(path, '{"noBackendField":1}\n"just a string"\n');
    const r = readReceipts(path);
    assert.deepEqual([r.receipts.length, r.malformed], [0, 2]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── the probe safeguards (moved verbatim from the retired fold runner) ────────────────────────────

describe('resolveTestFile — the safe test-file resolver (moved intact)', () => {
  const makeResolverFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'core-evidence-resolve-'));
    gitInit(root);
    writeFileSync(join(root, 'real.test.mjs'), 'export const x = 1;\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'inner.test.mjs'), 'export const y = 1;\n');
    symlinkSync('real.test.mjs', join(root, 'leaf-link.test.mjs'));
    const outside = mkdtempSync(join(tmpdir(), 'core-evidence-outside-'));
    writeFileSync(join(outside, 'escaped.test.mjs'), 'export const z = 1;\n');
    symlinkSync(outside, join(root, 'linkdir'));
    mkdirSync(join(root, 'dir.test.mjs'));
    return { root, outside };
  };
  it('a valid repo-relative regular file resolves ok', () => {
    const { root, outside } = makeResolverFixture();
    const r = resolveTestFile(root, 'sub/inner.test.mjs');
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.abs.endsWith(join('sub', 'inner.test.mjs')));
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  it('each unsafe path is refused with a named reason (traversal, absolute, symlink leaf/parent, dir, ghost, empty)', () => {
    const { root, outside } = makeResolverFixture();
    const cases = [
      ['../escape.test.mjs', /escapes the repo root/],
      [`${outside}/escaped.test.mjs`, /absolute path/],
      ['leaf-link.test.mjs', /not a regular file/],
      ['linkdir/escaped.test.mjs', /outside the repo root/],
      ['dir.test.mjs', /not a regular file/],
      ['ghost.test.mjs', /does not exist/],
      ['', /empty file path/],
    ];
    for (const [rel, re] of cases) {
      const r = resolveTestFile(root, rel);
      assert.equal(r.ok, false, `"${rel}" must be refused`);
      assert.match(r.reason, re, `"${rel}" reason: ${r.reason}`);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  it('a realpath failure (fs race) is a refusal, never a throw (injected deps)', () => {
    const { root, outside } = makeResolverFixture();
    const r = resolveTestFile(root, 'real.test.mjs', { realpath: () => { throw new Error('gone'); } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /cannot resolve the real path/);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  it('containsPath: segment-safe containment incl. a filesystem-root repo', () => {
    assert.equal(containsPath('/repo', '/repo/x.test.mjs'), true);
    assert.equal(containsPath('/repo', '/repository/x.test.mjs'), false);
    assert.equal(containsPath('/', '/x.test.mjs'), true);
    assert.equal(containsPath('/repo', '/repo'), false);
  });
  it('hashFileBytes: sha-256 hex over bytes; null on an unreadable path (fail closed)', () => {
    const { root, outside } = makeResolverFixture();
    const expected = createHash('sha256').update(readFileSync(join(root, 'real.test.mjs'))).digest('hex');
    assert.equal(hashFileBytes(join(root, 'real.test.mjs')), expected);
    assert.equal(hashFileBytes(join(root, 'dir.test.mjs')), null);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('parseProbeOutput — resolvable + baselineGreen from node:test TAP (moved intact)', () => {
  const FILE = 'lib.test.mjs';
  it('matched pass / matched fail / wrapper-only nomatch', () => {
    const matchPass = ['TAP version 13', 'ok 1 - outer group', '1..1', '# fail 0'].join('\n');
    const matchFail = ['TAP version 13', 'not ok 1 - outer group', '1..1', '# fail 1'].join('\n');
    const noMatch = ['TAP version 13', '1..0', `ok 1 - ${FILE}`, '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: matchPass, code: 0, fileArg: FILE }), { resolvable: true, executed: 1, baselineGreen: true });
    assert.deepEqual(parseProbeOutput({ stdout: matchFail, code: 1, fileArg: FILE }), { resolvable: true, executed: 1, baselineGreen: false });
    assert.deepEqual(parseProbeOutput({ stdout: noMatch, code: 0, fileArg: FILE }), { resolvable: false, executed: 0, baselineGreen: false });
  });
  it('the file wrapper is matched by basename (./ and absolute wrapper paths never count as tests)', () => {
    const nomatchAbs = ['TAP version 13', '1..0', 'ok 1 - /tmp/x/lib.test.mjs', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: nomatchAbs, code: 0, fileArg: 'lib.test.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
    const matchDotSlash = ['TAP version 13', 'ok 1 - real case', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: matchDotSlash, code: 0, fileArg: './lib.test.mjs' }), { resolvable: true, executed: 1, baselineGreen: true });
  });
  it('SKIP/TODO-directive result lines never count (the node pattern-filter shape)', () => {
    const skipped = ['TAP version 13', 'ok 1 - green one # SKIP test name does not match pattern', '1..1', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: skipped, code: 0, fileArg: FILE }), { resolvable: false, executed: 0, baselineGreen: false });
    const todo = ['TAP version 13', 'ok 1 - future case # TODO later', '1..1', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: todo, code: 0, fileArg: FILE }), { resolvable: false, executed: 0, baselineGreen: false });
  });
});

describe('probe argv + knobs (N and the timeout pinned from the old runner constants)', () => {
  it('the default shape is the shell-free node --test --test-name-pattern= form (a leading-dash pattern never parses as an option)', () => {
    assert.deepEqual(defaultBoundArgv('a/b.test.mjs', '--telemetry refuses'), [
      'node', '--test', '--test-reporter', 'tap', '--test-name-pattern=--telemetry refuses', 'a/b.test.mjs',
    ]);
  });
  it('defaults: reruns 3, timeout 120s; valid overrides parse; invalid values refused by name', () => {
    assert.deepEqual(probeKnobsFromEnv({}), { reruns: 3, timeoutS: 120 });
    assert.deepEqual(probeKnobsFromEnv({ AW_CORE_EVIDENCE_RERUNS: '2', AW_CORE_EVIDENCE_TIMEOUT_S: '30' }), { reruns: 2, timeoutS: 30 });
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      assert.throws(
        () => probeKnobsFromEnv({ AW_CORE_EVIDENCE_RERUNS: bad }),
        (e) => e.code === CORE_EVIDENCE_STOP && /AW_CORE_EVIDENCE_RERUNS/.test(e.message),
      );
      assert.throws(
        () => probeKnobsFromEnv({ AW_CORE_EVIDENCE_TIMEOUT_S: bad }),
        (e) => e.code === CORE_EVIDENCE_STOP && /AW_CORE_EVIDENCE_TIMEOUT_S/.test(e.message),
      );
    }
  });
});

// ── the red-proof verb: observed red or nothing (D3(c)) ───────────────────────────────────────────

describe('runRedProof — the observed-red declaration (refusals write NOTHING)', () => {
  const redRepo = () => {
    const { root } = makeRepo();
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\ntest('green case', () => { assert.equal(1, 1); });\n",
    );
    return root;
  };

  it('an N/N observed red mints the D3(c) declaration record (testId, file, hash, N/N, base, pre-fix fingerprint)', () => {
    const root = redRepo();
    const { record, writtenPath } = runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '2' }), testId: 'lib.test.mjs#red case' });
    assert.equal(writtenPath, storeOf(root));
    assert.equal(record.schema, EVIDENCE_SCHEMA_VERSION);
    assert.equal(record.kind, 'red-proof');
    assert.equal(record.testId, 'lib.test.mjs#red case');
    assert.equal(record.file, 'lib.test.mjs');
    assert.equal(record.runs, 2);
    assert.equal(record.reds, 2);
    assert.equal(record.base, headOf(root));
    assert.equal(record.fileHash, createHash('sha256').update(readFileSync(join(root, 'lib.test.mjs'))).digest('hex'));
    assert.equal(record.fingerprint, computeTreeFingerprint(root), 'the PRE-FIX tree fingerprint at red observation');
    const { records, malformed } = readEvidence(storeOf(root));
    assert.deepEqual([records.length, malformed], [1, 0]);
    rmSync(root, { recursive: true, force: true });
  });

  it('an observed GREEN refuses by name and writes nothing (a red-proof on a green test proves nothing — the D3(c) fixture)', () => {
    const root = redRepo();
    assert.throws(
      () => runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '2' }), testId: 'lib.test.mjs#green case' }),
      (e) => e.code === CORE_EVIDENCE_STOP && /observed GREEN/.test(e.message),
    );
    assert.equal(existsSync(storeOf(root)), false, 'a refusal writes nothing');
    rmSync(root, { recursive: true, force: true });
  });

  it('an unresolvable FILE refuses naming the dynamic-import authoring pattern and writes nothing', () => {
    const root = redRepo();
    assert.throws(
      () => runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }), testId: 'ghost.test.mjs#whatever' }),
      (e) => e.code === CORE_EVIDENCE_STOP && /unresolvable/.test(e.message) && /dynamic import/.test(e.message),
    );
    assert.equal(existsSync(storeOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a pattern selecting no test refuses as unresolvable and writes nothing', () => {
    const root = redRepo();
    assert.throws(
      () => runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }), testId: 'lib.test.mjs#no such test here' }),
      (e) => e.code === CORE_EVIDENCE_STOP && /unresolvable/.test(e.message),
    );
    assert.equal(existsSync(storeOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a MIXED outcome (deterministic state-file alternator) refuses as QUARANTINE and writes nothing', () => {
    const root = redRepo();
    writeFileSync(
      join(root, 'flaky.test.mjs'),
      [
        "import { test } from 'node:test';",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "let n = 0; try { n = Number(readFileSync(new URL('./flaky-state.txt', import.meta.url), 'utf8')); } catch {}",
        "writeFileSync(new URL('./flaky-state.txt', import.meta.url), String(n + 1));",
        "test('flaky case', () => { if (n % 2 === 0) throw new Error('even run'); });",
      ].join('\n'),
    );
    assert.throws(
      () => runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '2' }), testId: 'flaky.test.mjs#flaky case' }),
      (e) => e.code === CORE_EVIDENCE_STOP && /QUARANTINE/.test(e.message) && /1 green \/ 1 red/.test(e.message),
    );
    assert.equal(existsSync(storeOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a TIMED-OUT probe run refuses as QUARANTINE naming the timeout and writes nothing', () => {
    const root = redRepo();
    writeFileSync(
      join(root, 'slow.test.mjs'),
      "import { test } from 'node:test';\ntest('slow case', async () => { await new Promise((r) => setTimeout(r, 30000)); });\n",
    );
    assert.throws(
      () => runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1', AW_CORE_EVIDENCE_TIMEOUT_S: '1' }), testId: 'slow.test.mjs#slow case' }),
      (e) => e.code === CORE_EVIDENCE_STOP && /timed out/.test(e.message),
    );
    assert.equal(existsSync(storeOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a leading-dash test file is spawned safely (node must not parse it as an option; the executed file IS the hashed file)', () => {
    const root = redRepo();
    writeFileSync(
      join(root, '-dash.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('dash red case', () => { assert.equal(1, 2); });\n",
    );
    const { record } = runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }), testId: '-dash.test.mjs#dash red case' });
    assert.equal(record.reds, 1);
    assert.equal(record.fileHash, createHash('sha256').update(readFileSync(join(root, '-dash.test.mjs'))).digest('hex'));
    rmSync(root, { recursive: true, force: true });
  });

  it('a traversal path resolves to its normalized in-repo target — the hashed file is the executed file', () => {
    const root = redRepo();
    writeFileSync(
      join(root, 'trap.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('trap red case', () => { assert.equal(1, 2); });\n",
    );
    const outside = mkdtempSync(join(tmpdir(), 'core-evidence-trap-'));
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'trap.test.mjs'), "import { test } from 'node:test';\ntest('trap red case', () => {});\n");
    symlinkSync(join(outside, 'sub'), join(root, 'linkdir'));
    const { record } = runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }), testId: 'linkdir/../trap.test.mjs#trap red case' });
    assert.equal(record.reds, 1, 'the executed file is the hashed IN-REPO target (red), never the green impostor outside');
    assert.equal(record.fileHash, createHash('sha256').update(readFileSync(join(root, 'trap.test.mjs'))).digest('hex'));
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('the supersession scenario end-to-end: red A → edit the test → red B → the edited red is the ONE authoritative record; the final green refuses a new red-proof', () => {
    const root = redRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '2' });
    const a = runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' }).record;
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(2, 3); });\ntest('green case', () => { assert.equal(1, 1); });\n",
    );
    const b = runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' }).record;
    assert.notEqual(a.fileHash, b.fileHash);
    const { records } = readEvidence(storeOf(root));
    assert.equal(records.length, 2, 'both observations stay in the file (history)');
    const auth = authoritativeOfKind(records, 'red-proof');
    assert.equal(auth.length, 1, 'ONE authoritative record per {base, testId} — red B superseded red A, no permanent hash conflict');
    assert.equal(auth[0].fileHash, b.fileHash);
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 1); });\ntest('green case', () => { assert.equal(1, 1); });\n",
    );
    assert.throws(
      () => runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' }),
      (e) => /observed GREEN/.test(e.message),
      'after the fix the test is green — a fresh red-proof is refused (nothing new recorded)',
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('tree drift during the observation is refused and writes nothing', () => {
    const root = redRepo();
    writeFileSync(
      join(root, 'drift.test.mjs'),
      [
        "import { test } from 'node:test';",
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(new URL('./drift-marker.txt', import.meta.url), 'the tree moved');",
        "test('drift red case', () => { throw new Error('red'); });",
      ].join('\n'),
    );
    assert.throws(
      () => runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }), testId: 'drift.test.mjs#drift red case' }),
      (e) => e.code === CORE_EVIDENCE_STOP && /tree moved during the observation/.test(e.message),
    );
    assert.equal(existsSync(storeOf(root)), false, 'a drifted observation writes nothing');
    rmSync(root, { recursive: true, force: true });
  });

  it('a red-proof in a sha256-object-format repo records the 64-hex base', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'core-evidence-sha256-'));
    const init = spawnSync('git', ['init', '--object-format=sha256', '-q', root], { encoding: 'utf8' });
    if (init.status !== 0) {
      rmSync(root, { recursive: true, force: true });
      t.skip('host git lacks --object-format=sha256 — the 64-hex arm stays covered by the validator fixture');
      return;
    }
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('config', 'user.email', 'probe@example.com');
    g('config', 'user.name', 'probe');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    const { record } = runRedProof({ cwd: root, env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }), testId: 'lib.test.mjs#red case' });
    assert.match(record.base, /^[0-9a-f]{64}$/, 'the sha256 repo HEAD is a 64-hex oid');
    rmSync(root, { recursive: true, force: true });
  });

  it('outside a git work tree / malformed testId → typed refusals', () => {
    const bare = mkdtempSync(join(tmpdir(), 'core-evidence-bare-'));
    assert.throws(
      () => runRedProof({ cwd: bare, env: fixtureEnv(), testId: 'x.test.mjs#y' }),
      (e) => e.code === CORE_EVIDENCE_STOP && /not a git work tree/.test(e.message),
    );
    const { root } = makeRepo();
    assert.throws(
      () => runRedProof({ cwd: root, env: fixtureEnv(), testId: 'no-separator' }),
      (e) => e.exitCode === 2 && /testId/.test(e.message),
    );
    rmSync(bare, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
});

// ── the degrade verb (D3(b): explicit per-backend, per-tree escape) ───────────────────────────────

describe('runDegrade — an explicit degrade record: backend, non-empty reason, CURRENT fingerprint', () => {
  it('mints the record bound to the current tree fingerprint', () => {
    const { root } = makeRepo();
    const { record } = runDegrade({ cwd: root, env: fixtureEnv(), backend: 'agy', reason: 'Issue-001 stall on an oversized diff' });
    assert.equal(record.kind, 'degrade');
    assert.equal(record.backend, 'agy');
    assert.equal(record.fingerprint, computeTreeFingerprint(root));
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    const { records } = readEvidence(storeOf(root));
    assert.equal(records.length, 1);
    rmSync(root, { recursive: true, force: true });
  });
  it('an empty / whitespace reason is refused (the D3(b) fixture) and writes nothing', () => {
    const { root } = makeRepo();
    for (const bad of ['', '   ']) {
      assert.throws(
        () => runDegrade({ cwd: root, env: fixtureEnv(), backend: 'agy', reason: bad }),
        (e) => e.exitCode === 2 && /reason/.test(e.message),
      );
    }
    assert.equal(existsSync(storeOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });
  it('a whitespace-only backend is refused; a padded backend records trimmed', () => {
    const { root } = makeRepo();
    assert.throws(
      () => runDegrade({ cwd: root, env: fixtureEnv(), backend: '   ', reason: 'why' }),
      (e) => e.exitCode === 2 && /backend/.test(e.message),
    );
    assert.equal(existsSync(storeOf(root)), false);
    const { record } = runDegrade({ cwd: root, env: fixtureEnv(), backend: ' agy ', reason: 'why' });
    assert.equal(record.backend, 'agy', 'the recorded backend is trimmed (matchable by the gate)');
    rmSync(root, { recursive: true, force: true });
  });
});

// ── the summary verb (D6: ONE stateless render — receipts + evidence store, no ledger) ────────────

describe('summary — stateless D6 render (verdicts, red-proofs, degrades; loud on malformed)', () => {
  it('renders per-backend verdicts for the current tree, current-base red-proofs, current-tree degrades', () => {
    const { root } = makeRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' });
    runDegrade({ cwd: root, env, backend: 'agy', reason: 'declared degrade for this tree' });
    const fp = computeTreeFingerprint(root);
    writeFileSync(
      join(root, '.git', 'agent-workflow-review-receipts.jsonl'),
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'SHIP', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't1' })}\n` +
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: 'stale'.padEnd(64, '0'), backend: 'agy', verdict: 'revise', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't0' })}\n`,
    );
    const r = main(['summary'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /codex: SHIP/);
    assert.match(r.stdout, /agy: .*stale|agy: .*no attesting/i);
    assert.match(r.stdout, /lib\.test\.mjs#red case/);
    assert.match(r.stdout, /1\/1 red/);
    assert.match(r.stdout, /degrade/);
    assert.match(r.stdout, /declared degrade for this tree/);
    rmSync(root, { recursive: true, force: true });
  });
  it('summary renders the final gate line from the latest completed attempt at the current tree', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    const done = {
      schema: 1, kind: 'final', status: 'green', attempt: 'a1',
      fingerprintBefore: fp, fingerprintAfter: fp,
      declared: [{ id: 'noop', cmd: 'true' }],
      results: [{ id: 'noop', ok: true, code: 0 }],
      evidenceHashes: { redProof: 'a'.repeat(64), degrade: 'b'.repeat(64) },
      lcovSha256: null, integrityFailure: null, timestamp: 't-final',
    };
    writeFileSync(storeOf(root), `${JSON.stringify(done)}\n`);
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /final gate run: GREEN/);
    rmSync(root, { recursive: true, force: true });
  });

  it('an empty world renders gracefully (no store, no receipts) and stays exit 0', () => {
    const { root } = makeRepo();
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /red-proof records \(current base\): \(none\)/);
    assert.match(r.stdout, /degrade records \(current tree\): \(none\)/);
    rmSync(root, { recursive: true, force: true });
  });
  it('summary exits non-zero over a malformed store and withholds the evidence sections', () => {
    const { root } = makeRepo();
    writeFileSync(storeOf(root), 'not json\n');
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 1, 'a malformed store must not read as a healthy summary');
    assert.match(r.stdout, /1 malformed/);
    assert.match(r.stdout, /WITHHELD/);
    rmSync(root, { recursive: true, force: true });
  });
  it('a malformed later receipt line never lets an older SHIP render as attesting', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    writeFileSync(
      join(root, '.git', 'agent-workflow-review-receipts.jsonl'),
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'SHIP', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't1' })}\n` +
      'corrupted receipt line — a NEWER verdict may hide here\n',
    );
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 1, 'a partially-corrupt receipts store must not read as a healthy summary');
    assert.doesNotMatch(r.stdout, /SHIP/, 'a possibly-outdated verdict must not render as attesting');
    assert.match(r.stdout, /review verdicts WITHHELD/);
    rmSync(root, { recursive: true, force: true });
  });
  it('an unreadable receipts store withholds the verdicts section and exits non-zero', () => {
    const { root } = makeRepo();
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-recdir-'));
    const r = main(['summary'], { cwd: root, env: fixtureEnv({ AW_REVIEW_RECEIPTS: dir }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /review verdicts WITHHELD/);
    assert.match(r.stdout, /read error/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  it('summary names an unrecognized verdict instead of stale or missing', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    writeFileSync(
      join(root, '.git', 'agent-workflow-review-receipts.jsonl'),
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'unknown', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't1' })}\n`,
    );
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.match(r.stdout, /codex: unrecognized verdict \("unknown"\) — never attests/);
    assert.doesNotMatch(r.stdout, /codex: no attesting receipt for the current tree \(stale or missing\)/, 'a current unknown-verdict receipt is NOT stale/missing — the render must not lie');
    rmSync(root, { recursive: true, force: true });
  });
  it('a malformed later line never resurrects a superseded record in the render (sections withheld)', () => {
    const { root } = makeRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' });
    const store = readFileSync(storeOf(root), 'utf8');
    writeFileSync(storeOf(root), `${store}corrupted-superseding-line\n`);
    const r = main(['summary'], { cwd: root, env });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stdout, /lib\.test\.mjs#red case/, 'a possibly-superseded record must not render as authoritative');
    rmSync(root, { recursive: true, force: true });
  });
});

// ── the process contract (representative E2E spawns — argv + exit code + stdio) ──────────────────

describe('core-evidence CLI — real process spawns (argv/exit-code contract)', () => {
  const TOOL = new URL('./core-evidence.mjs', import.meta.url).pathname;
  it('summary runs as a real process (exit 0, report on stdout)', () => {
    const { root } = makeRepo();
    const r = spawnSync('node', [TOOL, 'summary', '--cwd', root], { encoding: 'utf8', env: fixtureEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /core-evidence summary/);
    rmSync(root, { recursive: true, force: true });
  });
  it('an unknown verb exits 2 with the refusal on stderr', () => {
    const r = spawnSync('node', [TOOL, 'mystery'], { encoding: 'utf8', env: fixtureEnv() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown verb/);
  });
});

// ── CLI surface ───────────────────────────────────────────────────────────────────────────────────

describe('core-evidence CLI — verbs red-proof / degrade / summary', () => {
  it('--help prints usage naming the three verbs (exit 0)', () => {
    const r = main(['--help'], {});
    assert.equal(r.code, 0);
    for (const verb of ['red-proof', 'degrade', 'summary']) assert.match(r.stdout, new RegExp(verb));
  });
  it('an unknown verb / missing arguments are usage errors (exit 2)', () => {
    assert.equal(main(['mystery'], {}).code, 2);
    assert.equal(main([], {}).code, 2);
    assert.equal(main(['red-proof'], {}).code, 2);
    assert.equal(main(['degrade', '--backend', 'agy'], {}).code, 2, 'degrade without --reason is a usage refusal');
    assert.equal(main(['degrade', '--reason', 'why'], {}).code, 2, 'degrade without --backend is a usage refusal');
  });
  it('red-proof + degrade mint and report through the CLI (exit 0); refusals surface on stderr (exit 1)', () => {
    const { root } = makeRepo();
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\ntest('green case', () => { assert.equal(1, 1); });\n",
    );
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    const ok = main(['red-proof', 'lib.test.mjs#red case'], { cwd: root, env });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /red-proof/);
    const green = main(['red-proof', 'lib.test.mjs#green case'], { cwd: root, env });
    assert.equal(green.code, 1);
    assert.match(green.stderr, /observed GREEN/);
    const dg = main(['degrade', '--backend', 'agy', '--reason', 'declared'], { cwd: root, env });
    assert.equal(dg.code, 0, dg.stderr);
    assert.match(dg.stdout, /degrade/);
    rmSync(root, { recursive: true, force: true });
  });
});
