import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint } from './core-evidence-tree.mjs';
import { EVIDENCE_SCHEMA_VERSION, readEvidence, authoritativeOfKind } from './core-evidence-store-read.mjs';
import { CORE_EVIDENCE_STOP, appendEvidenceRecord, probeKnobsFromEnv, runRedProof, runDegrade } from './core-evidence-store.mjs';
import { makeRepo, fixtureEnv, headOf, storeOf, validRedProof, validDegrade } from './core-evidence-harness.test.mjs';

// ── appendEvidenceRecord: validated, atomic, duplicate-refusing (D6a) ─────────────────────────────

// spec:core-evidence/S4
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
});

describe('probe argv + knobs (N and the timeout pinned from the old runner constants)', () => {
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
