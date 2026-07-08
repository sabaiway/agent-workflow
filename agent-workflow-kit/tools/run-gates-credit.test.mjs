// run-gates-credit.test.mjs — spec-first for the (a) one-suite-run CREDIT (BUGFREE-3, AD-049, step
// 1.5): run-gates --record credits the unit-tests gate from the fold runner's recorded suite
// evidence instead of re-spawning it — IFF fingerprint-bound + tree-unchanged + cmd-identity + exit-0.
// Any mismatch (fingerprint / cmd / nonzero exit / absent evidence) → the normal spawn. A red suite
// NEVER credits a green gate-run. The spawn is captured (an injected spawn) so credit-vs-spawn is
// asserted directly, not via a sentinel.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, spawnGateViaBash } from './run-gates.mjs';
import { childTestEnv } from './fold-completeness-run.mjs';
import { computeTreeFingerprint } from './review-state.mjs';

const SUITE = 'node --test';
const LINT = 'eslint .';

const envFor = (root) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl'), AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl') };
};

let BASE = null;
const DEFAULT_GATES = [{ id: 'unit-tests', title: 'tests', cmd: SUITE }, { id: 'lint', title: 'lint', cmd: LINT }];
const makeRepo = (gates = DEFAULT_GATES) => {
  const root = mkdtempSync(join(tmpdir(), 'credit-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates }));
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  BASE = g('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(root, 'pending.txt'), 'uncommitted\n'); // a dirty tree (the review state)
  return { root };
};
const done = (root) => rmSync(root, { recursive: true, force: true });

// Seed a v4 fold RUN record whose suite evidence is (by default) fingerprint-bound, exit-0, cmd=SUITE.
const seedFold = (root, suiteOver = {}, fp) => {
  const fingerprint = fp ?? computeTreeFingerprint(root);
  const suite = { cmd: SUITE, exit: 0, fingerprintBefore: fingerprint, fingerprintAfter: fingerprint, ...suiteOver };
  const rec = {
    schema: 4, kind: 'run', loop: 'demo-plan', base: BASE, fingerprint,
    boundTestIds: [], testIds: [], unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] },
    tamper: { tampered: [] }, suite, mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null }, budgets: {}, timestamp: 't',
  };
  writeFileSync(join(root, '.git', 'fc.jsonl'), `${JSON.stringify(rec)}\n`);
  return fingerprint;
};

// Run --record with a captured spawn + a captured record (never touching the real ledger writer).
const runRecord = (root) => {
  const spawned = [];
  let recorded = null;
  const spawn = (cmd) => {
    spawned.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };
  const record = (a) => {
    recorded = a;
    return { writtenPath: '/tmp/x' };
  };
  const code = runCli(['--record'], { cwd: root, env: envFor(root), spawn, record, log: () => {}, logError: () => {} });
  return { code, spawned, recorded };
};

describe('run-gates --record — the (a) unit-tests credit', () => {
  it('credit FIRES: unit-tests is NOT spawned, and it is recorded green', () => {
    const { root } = makeRepo();
    seedFold(root); // fingerprint-bound + exit-0 + cmd=SUITE
    const { spawned, recorded } = runRecord(root);
    done(root);
    assert.equal(spawned.includes(SUITE), false, 'unit-tests was credited from the fold suite run — never re-spawned');
    assert.equal(spawned.includes(LINT), true, 'the other gate still spawns');
    const ut = recorded.results.find((r) => r.id === 'unit-tests');
    assert.ok(ut && ut.ok && ut.code === 0, 'the credited unit-tests gate is recorded green');
  });

  it('a FINGERPRINT mismatch (the tree moved since the fold run) → spawn', () => {
    const { root } = makeRepo();
    seedFold(root, {}, 'f'.repeat(64)); // suite bound to a DIFFERENT fingerprint
    const { spawned } = runRecord(root);
    done(root);
    assert.equal(spawned.includes(SUITE), true, 'a stale-fingerprint fold run never credits — the gate re-spawns');
  });

  it('a CMD mismatch (a narrower fold suite) → spawn (the --only-subset defense)', () => {
    const { root } = makeRepo();
    seedFold(root, { cmd: 'node --test --only x' }); // NOT the unit-tests gate cmd
    const { spawned } = runRecord(root);
    done(root);
    assert.equal(spawned.includes(SUITE), true, 'a different suite cmd never credits the full gate');
  });

  it('a RED (nonzero-exit) suite NEVER credits a green gate-run → spawn', () => {
    const { root } = makeRepo();
    seedFold(root, { exit: 1 }); // fingerprint-bound + cmd-identical but RED
    const { spawned } = runRecord(root);
    done(root);
    assert.equal(spawned.includes(SUITE), true, 'a nonzero-exit fold suite never credits a green gate');
  });

  it('NO fold evidence → spawn (the honest default)', () => {
    const { root } = makeRepo();
    // no seedFold
    const { spawned } = runRecord(root);
    done(root);
    assert.equal(spawned.includes(SUITE), true);
  });

  it('a MALFORMED fold-ledger line → NO credit (fail-closed, matching decideCheck) → spawn', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    // an otherwise-creditable run PLUS a corrupt line — a partially-trusted ledger must never credit.
    const suite = { cmd: SUITE, exit: 0, fingerprintBefore: fp, fingerprintAfter: fp };
    const rec = { schema: 4, kind: 'run', loop: 'demo-plan', base: BASE, fingerprint: fp, boundTestIds: [], testIds: [], unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] }, tamper: { tampered: [] }, suite, mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null }, budgets: {}, timestamp: 't' };
    writeFileSync(join(root, '.git', 'fc.jsonl'), `${JSON.stringify(rec)}\n{ corrupt json line\n`);
    const { spawned } = runRecord(root);
    done(root);
    assert.equal(spawned.includes(SUITE), true, 'a malformed fold ledger must not credit — the gate re-spawns (fail-closed)');
  });

  it('the credit applies ONLY when unit-tests is the FIRST DECLARED gate — otherwise it re-spawns', () => {
    // unit-tests declared SECOND (selectGates preserves DECLARATION order, not CLI order): a prior gate
    // could side-effect an ignored/out-of-tree dependency without moving the fingerprint, so a
    // later-positioned unit-tests must re-spawn rather than credit a state the real matrix might fail.
    const { root } = makeRepo([{ id: 'lint', title: 'lint', cmd: LINT }, { id: 'unit-tests', title: 'tests', cmd: SUITE }]);
    seedFold(root); // valid: fingerprint-bound + exit-0 + cmd-identical
    const { spawned } = runRecord(root);
    done(root);
    assert.equal(spawned.includes(SUITE), true, 'unit-tests is not the first declared gate → it re-spawns despite valid evidence');
  });

  it('WITHOUT --record the credit never applies (unit-tests spawns)', () => {
    const { root } = makeRepo();
    seedFold(root);
    const spawned = [];
    const spawn = (cmd) => {
      spawned.push(cmd);
      return { status: 0, stdout: '', stderr: '' };
    };
    runCli([], { cwd: root, env: envFor(root), spawn, log: () => {}, logError: () => {} });
    done(root);
    assert.equal(spawned.includes(SUITE), true, 'the credit is a --record-mode optimization only');
  });
});

describe('run-gates gate spawn — env-equivalence with the fold suite (the (a) credit premise)', () => {
  it('spawnGateViaBash strips NODE_TEST_CONTEXT so a `node --test` gate is not vacuously skipped under a parent test context', () => {
    // This suite runs under `node --test`, so NODE_TEST_CONTEXT is set in process.env. Without the strip a
    // `node --test` gate child inherits it, hits the recursive-run guard, skips every file, and exits 0 (a
    // vacuous false green). With the strip the failing gate test actually runs → nonzero exit.
    assert.ok(process.env.NODE_TEST_CONTEXT !== undefined, 'precondition: this suite runs under node --test');
    const dir = mkdtempSync(join(tmpdir(), 'gate-env-'));
    const f = join(dir, 'z.test.mjs');
    writeFileSync(f, "import { test } from 'node:test';\ntest('always fails', () => { throw new Error('boom'); });\n");
    const res = spawnGateViaBash(`node --test ${JSON.stringify(f)}`, dir);
    rmSync(dir, { recursive: true, force: true });
    assert.notEqual(res.status, 0, 'the failing gate test must run (NODE_TEST_CONTEXT stripped), not be vacuously skipped to exit 0');
  });

  it('documents the bounded NODE_V8_COVERAGE residual: the fold V8 suite env carries it, a plain gate does not', () => {
    // The fix: BOTH the fold suite (childTestEnv) and the plain gate (spawnGateViaBash) strip
    // NODE_TEST_CONTEXT → env-equivalent there. The residual: the fold V8 suite injects NODE_V8_COVERAGE,
    // a plain gate spawn does not; only a test READING that var can flip the credit (a test that FAILS
    // under coverage exits nonzero and never credits — the exit-0 gate). AD-047-class, documented.
    const base = { PATH: '/x', NODE_TEST_CONTEXT: 'child' };
    const foldV8SuiteEnv = childTestEnv(base, { NODE_V8_COVERAGE: '/cov' });
    assert.equal(foldV8SuiteEnv.NODE_TEST_CONTEXT, undefined, 'the fold suite strips NODE_TEST_CONTEXT (as does the plain gate)');
    assert.equal(foldV8SuiteEnv.NODE_V8_COVERAGE, '/cov', 'the fold V8 suite runs under coverage instrumentation');
    assert.equal(base.NODE_V8_COVERAGE, undefined, 'a plain gate spawn injects no coverage env — the bounded residual');
  });
});
