// custody-reattest.test.mjs — spec-first for the (c) same-segment custody re-attest (BUGFREE-3,
// AD-049, step 1.7). The fold-v4 `reattest` record kind (the schema quartet: validate the new kind,
// a pre-v4 record never carries it — the version-skew guard —, the selectors skip it, the custody
// chain consumes it), the custody scenarios ((i) a green-only append re-attested passes without a
// red-proof waiver; (ii) an un-reattested in-body insertion still fails closed; (iii) a
// removal/modification still trips the TAMPER guard — re-attest is scoped to CUSTODY, never tamper),
// and the runner's --reattest verb. The existing run/red-probe truth-tables are untouched (D10).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  main as checkMain,
  validateRunRecord,
  isReattestRecord,
  isRunRecord,
  isRedProbeRecord,
  latestRunRecord,
  REATTEST_KIND,
  RESULT_SCHEMA_VERSION,
} from './fold-completeness.mjs';
import { main as runMain, runReattest } from './fold-completeness-run.mjs';
import { computeTreeFingerprint } from './review-state.mjs';

const A = 'x.test.mjs#p'; // a bound testId in file x.test.mjs
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const SUITE = { cmd: 'node --test', exit: 0, fingerprintBefore: 'a'.repeat(64), fingerprintAfter: 'a'.repeat(64) };

// ── the v4 quartet (pure) ──────────────────────────────────────────────────────────────────────────

describe('fold-v4 reattest kind — the schema quartet (D2 version-skew)', () => {
  const reattest = (over = {}) => ({ schema: 4, kind: REATTEST_KIND, loop: 'L', base: 'h'.repeat(40), testId: A, fileHash: H1, fingerprint: 'a'.repeat(64), timestamp: 't', ...over });
  it('validate-new: a well-formed v4 reattest record is valid', () => {
    assert.deepEqual(validateRunRecord(reattest()), { ok: true });
  });
  it('rejects a malformed reattest (bad testId / bad hash)', () => {
    assert.equal(validateRunRecord(reattest({ testId: 'nohash' })).ok, false);
    assert.equal(validateRunRecord(reattest({ fileHash: 'short' })).ok, false);
  });
  it('version-skew: a pre-v4 (schema 2/3) record NEVER carries the reattest kind', () => {
    for (const schema of [2, 3]) {
      const v = validateRunRecord(reattest({ schema, base: schema >= 3 ? 'h'.repeat(40) : undefined }));
      assert.equal(v.ok, false, `schema ${schema} reattest must be rejected`);
      assert.match(v.reason, new RegExp(`${REATTEST_KIND} is a v4 record kind`));
    }
  });
  it('version-skew: a pre-v4 run carrying a suite field is rejected (suite is v4-only)', () => {
    const v3run = { schema: 3, kind: 'run', loop: 'L', base: 'h'.repeat(40), fingerprint: 'a'.repeat(64), boundTestIds: [], testIds: [], unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] }, tamper: { tampered: [] }, mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null }, budgets: {}, timestamp: 't', suite: { cmd: 'x', exit: 0, fingerprintBefore: null, fingerprintAfter: null } };
    const v = validateRunRecord(v3run);
    assert.equal(v.ok, false);
    assert.match(v.reason, /suite is a v4 field/);
  });
  it('selectors: isReattestRecord true; isRunRecord/isRedProbeRecord false; latestRunRecord skips it', () => {
    const r = reattest();
    assert.equal(isReattestRecord(r), true);
    assert.equal(isRunRecord(r), false);
    assert.equal(isRedProbeRecord(r), false);
    // a run precedes a reattest → latestRunRecord returns the RUN, never the reattest
    const run = { schema: 4, kind: 'run', loop: 'L', base: 'h'.repeat(40), fingerprint: 'a'.repeat(64), boundTestIds: [], testIds: [], unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] }, tamper: { tampered: [] }, suite: SUITE, mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null }, budgets: {}, timestamp: 't' };
    assert.equal(latestRunRecord([run, r]).index, 0, 'the run at index 0 is the latest RUN, not the reattest');
  });
});

// ── the custody scenarios (the checker over hermetic fixtures) ──────────────────────────────────────

const COUNCIL = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });
const READY = 'ready';
const detect = () => () => [{ name: 'codex-cli-bridge', readiness: READY }, { name: 'antigravity-cli-bridge', readiness: READY }];
const RESULTS = (root) => join(root, '.git', 'fc.jsonl');
const REVIEW = (root) => join(root, '.git', 'rl.jsonl');
const envFor = (root) => ({ AW_FOLD_RESULTS: RESULTS(root), AW_REVIEW_LEDGER: REVIEW(root) });

let BASE = null;
const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'reattest-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), COUNCIL);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  BASE = g('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(root, 'pending.txt'), 'uncommitted\n');
  return { root };
};
const done = (root) => rmSync(root, { recursive: true, force: true });
const check = (root) => checkMain(['--check'], { cwd: root, env: envFor(root), detect: detect() });

const triageLine = (testId) => `${JSON.stringify({ schema: 4, loop: 'demo-plan', activity: 'plan-execution', kind: 'triage', round: 1, base: BASE, fingerprint: 'b'.repeat(64), classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId, note: '' }], timestamp: 't' })}\n`;
const bindIds = (root, ...ids) => writeFileSync(REVIEW(root), ids.map(triageLine).join(''));
const seedResults = (root, ...records) => writeFileSync(RESULTS(root), records.map((r) => `${JSON.stringify(r)}\n`).join(''));

const v2Entry = (id, hash) => ({ id, executed: 1, runs: 3, greens: 3, reds: 0, timeouts: 0, fileHash: hash, resolvable: true, baselineGreen: true });
const runV4 = (root, id, hash, over = {}) => ({
  schema: RESULT_SCHEMA_VERSION, kind: 'run', loop: 'demo-plan', base: BASE, fingerprint: computeTreeFingerprint(root),
  boundTestIds: [id], testIds: [v2Entry(id, hash)], unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] },
  tamper: { tampered: [] }, suite: SUITE, mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null }, budgets: {}, timestamp: 't', ...over,
});
const redProbe = (testId, hash) => ({ schema: RESULT_SCHEMA_VERSION, kind: 'red-probe', loop: 'demo-plan', base: BASE, testId, fileHash: hash, runs: 3, reds: 3, fingerprint: 'a'.repeat(64), timestamp: 't' });
const reattest = (testId, hash) => ({ schema: RESULT_SCHEMA_VERSION, kind: REATTEST_KIND, loop: 'demo-plan', base: BASE, testId, fileHash: hash, fingerprint: 'a'.repeat(64), timestamp: 't' });

describe('custody re-attest — the checker consumes a reattest receipt as a custody anchor', () => {
  it('(i) a GREEN-ONLY append re-attested via the new receipt PASSES (no red-proof waiver)', () => {
    const { root } = makeRepo();
    bindIds(root, A);
    // A observed red at H1; the file gained a green sibling test → H2; A re-attested at H2; the run
    // probes A green with the CURRENT content hash H2. Custody re-anchors on the reattest — no waiver.
    seedResults(root, redProbe(A, H1), reattest(A, H2), runV4(root, A, H2));
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stdout);
  });

  it('(ii) an un-reattested in-body change still FAILS CLOSED (re-attest never auto-relaxes)', () => {
    const { root } = makeRepo();
    bindIds(root, A);
    // A red at H1; the file content moved to H2 (an in-body insertion is additions-only, yet the
    // guard must NOT auto-accept it) with NO reattest → custody broken.
    seedResults(root, redProbe(A, H1), runV4(root, A, H2));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /custody broken/);
    assert.match(r.stdout, /--reattest/, 'the recovery names the re-attest verb');
  });

  it('(iii) a re-attest does NOT waive the TAMPER guard (a removal/modification still fails closed)', () => {
    const { root } = makeRepo();
    bindIds(root, A);
    // The run records a tampered file (a removed/modified line in x.test.mjs) AND a reattest exists —
    // but tamper needs an oracle-change override, which re-attest is NOT. So it still fails closed.
    seedResults(root, redProbe(A, H1), reattest(A, H1), runV4(root, A, H1, { tamper: { tampered: ['x.test.mjs'] } }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /tampered test-surface file/);
  });

  it('an UNBOUND same-file reattest does NOT restore custody (eligibility: bound testId only)', () => {
    const { root } = makeRepo();
    bindIds(root, A);
    seedResults(root, redProbe(A, H1), reattest('x.test.mjs#throwaway', H2), runV4(root, A, H2));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /custody broken/);
  });

  it('a POST-RUN reattest does NOT restore custody (the anti-post-hoc i < sel.index guard, shared with red-probes)', () => {
    const { root } = makeRepo();
    bindIds(root, A);
    // red @H1, run records A green @H2 (custody breaks), reattest @H2 minted AFTER the run (index > run).
    seedResults(root, redProbe(A, H1), runV4(root, A, H2), reattest(A, H2));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1, 'a post-run re-attest must not launder a broken custody without a fresh run');
    assert.match(r.stdout, /custody broken/);
  });
});

// ── the runner --reattest verb ───────────────────────────────────────────────────────────────────

const makeRunnerRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'reattest-run-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
  writeFileSync(join(root, 'x.test.mjs'), "import { test } from 'node:test';\ntest('p', () => {});\n");
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root };
};
const runnerEnv = (root) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl') };
};

describe('fold-completeness-run --reattest — the verb', () => {
  it('mints a v4 reattest receipt with the current file bytes hash', () => {
    const { root } = makeRunnerRepo();
    const { record } = runReattest({ cwd: root, env: runnerEnv(root), testId: A });
    done(root);
    assert.equal(record.kind, REATTEST_KIND);
    assert.equal(record.schema, RESULT_SCHEMA_VERSION);
    assert.equal(record.testId, A);
    assert.match(record.fileHash, /^[0-9a-f]{64}$/);
    assert.equal(validateRunRecord(record).ok, true);
  });

  it('refuses a testId whose file does not resolve (nothing to anchor)', () => {
    const { root } = makeRunnerRepo();
    assert.throws(() => runReattest({ cwd: root, env: runnerEnv(root), testId: 'missing.test.mjs#p' }), /cannot anchor|does not exist/);
    done(root);
  });

  it('the CLI --reattest prints a receipt line (exit 0)', () => {
    const { root } = makeRunnerRepo();
    const r = runMain(['--reattest', A], { cwd: root, env: runnerEnv(root) });
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /minted a custody re-attest/);
  });

  it('--reattest with a malformed testId → usage error (exit 2)', () => {
    const { root } = makeRunnerRepo();
    const r = runMain(['--reattest', 'nohash'], { cwd: root, env: runnerEnv(root) });
    done(root);
    assert.equal(r.code, 2);
  });
});
