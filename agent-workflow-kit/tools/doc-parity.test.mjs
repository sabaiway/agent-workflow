// doc-parity.test.mjs — the deterministic doc-drift lint (BUGFREE-3 / AD-049, item (b)): a stale
// token fails, a matching set passes, an unreadable/absent binding fails closed, and the REAL
// registry is consistent with the shipped references/modes/*.md contract (the dogfood).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBinding, checkParity, BINDINGS, main } from './doc-parity.mjs';

// A synthetic file surface: rel → text. A rel absent from the map THROWS (fails closed like a real
// unreadable file).
const surface = (map) => (rel) => {
  if (!(rel in map)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return map[rel];
};

describe('checkBinding — value drift is detected', () => {
  const binding = { constant: 'DEFAULT_DIFF_CAP', value: 400, token: 'default 400', files: ['doc.md'] };

  it('passes when the doc carries the current-value token', () => {
    const r = checkBinding(binding, surface({ 'doc.md': '...the default 400 new-side lines...' }));
    assert.equal(r.ok, true);
  });

  it('FAILS a stale doc (says 300 while the constant is 400)', () => {
    const r = checkBinding(binding, surface({ 'doc.md': '...the default 300 new-side lines...' }));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /not found/);
  });

  it('FAILS CLOSED when a bound file is unreadable', () => {
    const r = checkBinding(binding, surface({}));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /unreadable/);
  });

  it('requires the token in EVERY bound file (one drifted file fails the binding)', () => {
    const multi = { constant: 'X', value: 1, token: 'v1', files: ['a.md', 'b.md'] };
    const r = checkBinding(multi, surface({ 'a.md': 'has v1', 'b.md': 'missing it' }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.files.map((f) => f.ok), [true, false]);
  });
});

describe('checkParity + main — over a synthetic registry', () => {
  const bindings = [
    { constant: 'CAP', value: 400, token: 'cap 400', files: ['x.md'] },
    { constant: 'vocab:refuted', value: 'refuted', token: 'refuted', files: ['x.md'] },
  ];

  it('a matching set passes every binding', () => {
    const results = checkParity(bindings, surface({ 'x.md': 'the cap 400 and the refuted lane' }));
    assert.ok(results.every((r) => r.ok));
  });

  it('a stale token fails closed under checkParity', () => {
    const results = checkParity(bindings, surface({ 'x.md': 'the cap 300 and the refuted lane' }));
    assert.equal(results.find((r) => r.constant === 'CAP').ok, false);
  });
});

describe('the REAL registry is consistent with the shipped contract docs (dogfood)', () => {
  it('every binding renders into its bound references/modes/*.md file', () => {
    const results = checkParity(); // real BINDINGS + real files
    const drifted = results.filter((r) => !r.ok);
    assert.deepEqual(
      drifted.map((r) => ({ constant: r.constant, misses: r.files.filter((f) => !f.ok).map((f) => f.rel) })),
      [],
      'a drifted binding means a mode doc lags a code constant — update the doc in the same edit as the code',
    );
  });

  it('--check over the real registry exits 0 (the dogfood gate is green)', () => {
    const r = main(['--check']);
    assert.equal(r.code, 0, r.stdout);
  });

  it('the registry covers the named constants + the full ledger vocabulary', () => {
    const names = BINDINGS.map((b) => b.constant);
    for (const c of ['SCHEMA_VERSION', 'HARD_MAX', 'DEFAULT_DIFF_CAP', 'REVIEW_CAP', 'RESULT_SCHEMA_VERSION']) {
      assert.ok(names.includes(c), `registry must bind ${c}`);
    }
    for (const word of ['size-cap', 'refuted', 'gate-run', 'red-proof', 'oracle-change', 'fixable-bug', 'inherent-layer-residual', 'escalate']) {
      assert.ok(names.includes(`vocab:${word}`), `registry must bind the vocab word ${word}`);
    }
  });

  // AD-044 Plan 2: the autonomy-doctor D7 exit/status contract is bound to its mode doc.
  it('the registry binds the autonomy-doctor EXIT table + every non-usage status token', () => {
    const names = BINDINGS.map((b) => b.constant);
    for (const key of ['ready', 'stop', 'usage', 'notReady', 'installFailed', 'verifyFailed', 'unsupported']) {
      assert.ok(names.includes(`doctor-exit:${key}`), `registry must bind doctor-exit:${key}`);
    }
    for (const token of ['ready-verified', 'ready-assumed', 'no-deployment', 'missing-binaries', 'present-unverified', 'handoff-required', 'install-failed', 'verify-failed', 'indeterminate', 'root-unproven', 'unsupported-platform', 'unknown-pm', 'untrusted-path']) {
      assert.ok(names.includes(`doctor-status:${token}`), `registry must bind doctor-status:${token}`);
    }
    const doctorBindings = BINDINGS.filter((b) => b.constant.startsWith('doctor-'));
    assert.ok(doctorBindings.every((b) => b.files.includes('references/modes/autonomy-doctor.md')));
    // The D2 trusted-dir allowlist is bound as the joined LITERAL — a widened allowlist (e.g.
    // +/usr/local/bin) makes the doc token drift and this pin plus the gate go red.
    const trusted = BINDINGS.find((b) => b.constant === 'doctor-trusted-dirs');
    assert.equal(trusted.token, '/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('doc-parity CLI surface', () => {
  it('--help is read-only and 0', () => {
    const r = main(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /deterministic doc-drift lint/);
  });

  it('an unknown argument is a usage error (exit 2)', () => {
    const r = main(['--frobnicate']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument/);
  });

  it('the default report renders every binding as ✓ and a PASS check line', () => {
    const r = main([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /doc-parity — code constants/);
    assert.match(r.stdout, /✓ SCHEMA_VERSION/);
    assert.match(r.stdout, /check: PASS/);
  });

  it('--json emits the structured result (ok:true, per-binding files)', () => {
    const r = main(['--json']);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.results) && j.results.length === BINDINGS.length);
    assert.ok(j.results.every((res) => res.files.every((f) => f.ok)));
  });

  it('the CLI entry runs end-to-end (subprocess smoke: --check exits 0)', () => {
    const script = fileURLToPath(new URL('./doc-parity.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /check: PASS/);
  });
});
