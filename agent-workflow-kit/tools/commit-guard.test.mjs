// commit-guard.test.mjs — spec-first for the read-only commit guard (strip-the-kit 2.5, D10).
// The guard re-runs NO gate/test subprocess: it recomputes the current tree fingerprint (the
// review-state export), reads the LATEST completed final-run record from the core-evidence store,
// and compares { fingerprint before==after==current · declaration content · evidence hashes ·
// lcov hash } plus the ship receipts (the review-state decision). Integration: a REAL `git commit`
// in a fixture repo is refused per violation class; `--no-verify` stays the stated residual.
//
// The module under test is imported DYNAMICALLY (the authoring pattern): this spec LOADS — and
// fails per fixture — on the pre-implementation tree. D13 rides through every fixture: the final
// record is minted at the STAGED tree (staging moves the fingerprint), then the commit follows
// immediately.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, readEvidence, canonicalKindSerialization } from './core-evidence.mjs';

const guard = await import('./commit-guard.mjs').catch(() => null);
const { main } = guard ?? {};
const GUARD_TOOL = fileURLToPath(new URL('./commit-guard.mjs', import.meta.url));

const fixtureEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, ...extra };
};

const GATES = { gates: [{ id: 'noop', title: 'noop', cmd: 'true' }] };

// A repo with a committed base, a SOLO review config (the ship arm is exercised separately), a
// declared gates.json, and one staged change ready to commit. The committed base is identical
// everywhere — built once, cloned per test; only the staged change is re-added per clone.
const REPO_TEMPLATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'commit-guard-template-'));
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
  writeFileSync(join(dir, 'docs', 'ai', 'gates.json'), JSON.stringify(GATES));
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return dir;
})();
after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'commit-guard-'));
  cpSync(REPO_TEMPLATE, root, { recursive: true });
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  writeFileSync(join(root, 'change.mjs'), 'export const x = 1;\n');
  g('add', '-A'); // D13: staged FIRST — the final record below binds the STAGED tree
  return { root, g };
};

const storeOf = (root) => join(root, '.git', 'agent-workflow-core-evidence.jsonl');
const sha = (text) => createHash('sha256').update(text).digest('hex');

// Seed a COMPLETED final-run record at the given fingerprint (the D3(a) receipt run-gates --final
// mints — seeded directly here; provenance is run-gates' own suite).
let attemptSeq = 0;
const seedFinal = (root, fingerprint, over = {}) => {
  const { records } = readEvidence(storeOf(root));
  attemptSeq += 1;
  const record = {
    schema: 1,
    kind: 'final',
    status: 'green',
    attempt: `attempt-${attemptSeq}`,
    fingerprintBefore: fingerprint,
    fingerprintAfter: fingerprint,
    declared: GATES.gates.map(({ id, cmd }) => ({ id, cmd })),
    results: [{ id: 'noop', ok: true, code: 0 }],
    evidenceHashes: {
      redProof: sha(canonicalKindSerialization(records, 'red-proof')),
      degrade: sha(canonicalKindSerialization(records, 'degrade')),
    },
    lcovSha256: null,
    integrityFailure: null,
    timestamp: '2026-07-17T00:00:00Z',
    ...over,
  };
  writeFileSync(storeOf(root), `${JSON.stringify(record)}\n`, { flag: 'a' });
  return record;
};
const seedStart = (root, fingerprint, attempt) => {
  const record = { schema: 1, kind: 'final-start', fingerprint, attempt, timestamp: '2026-07-17T00:00:01Z' };
  writeFileSync(storeOf(root), `${JSON.stringify(record)}\n`, { flag: 'a' });
  return record;
};

// A well-formed ATTESTING code receipt (the shape the bridges mint) at the given fingerprint.
const shipReceipt = (fp, backend) => JSON.stringify({
  schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend, verdict: 'ship',
  grounded: true, factsHash: null, wrapperVersion: '0.0.0', timestamp: '2026-07-17T00:00:00Z', probe: false,
  posture: { model: '<display>' },
});

// The council-config repo shape the ship-arm fixtures share: an in-flight plan + both backends required.
const makeCouncilRepo = () => {
  const { root } = makeRepo();
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# plan\n');
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('add', '-A');
  return { root };
};

const installHook = (root) => {
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\nexec node "${GUARD_TOOL}" --check --cwd "${root}"\n`);
  chmodSync(hook, 0o755);
};

const tryCommit = (root) => spawnSync('git', ['commit', '-qm', 'guarded'], { cwd: root, encoding: 'utf8', env: fixtureEnv() });

describe('commit-guard — module + refusal classes (unit --check)', () => {
  it('module exists (authored red-first)', () => {
    assert.ok(guard, 'commit-guard.mjs must exist and load');
  });

  it('NO completed final record at the current fingerprint → refuse naming the recovery', () => {
    const { root } = makeRepo();
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /no completed final-run record|run-gates\.mjs --final/);
  });

  it('a green record at a DIFFERENT fingerprint → refuse (the tree moved after the final run)', () => {
    const { root } = makeRepo();
    seedFinal(root, 'a'.repeat(64));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /fingerprint/);
  });

  it('a RED completed record never satisfies — and it KILLS an earlier green at the same fingerprint', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp, { status: 'green', timestamp: 't1' });
    seedFinal(root, fp, { status: 'red', results: [{ id: 'noop', ok: false, code: 1 }], timestamp: 't2' });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the LATEST completed attempt at a fingerprint is authoritative');
    assert.match(r.stdout + r.stderr, /red/i);
  });

  it('a DECLARATION edited after the final run → refuse (content mismatch)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'noop', title: 'noop', cmd: 'true || true' }] }));
    // docs/ai is tracked in this fixture — restage so the fingerprint matches the receipt? No:
    // the declaration edit itself MOVES the fingerprint here, which is the honest double refusal;
    // pin the DECLARATION arm by re-minting at the edited tree's fingerprint.
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('add', '-A');
    seedFinal(root, computeTreeFingerprint(root)); // receipt matches the tree but DECLARED array is stale
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /declaration/);
  });

  it('an EVIDENCE-HASH mismatch → refuse (the store moved under the receipt)', () => {
    const { root } = makeRepo();
    const fp0 = computeTreeFingerprint(root);
    seedFinal(root, fp0, { evidenceHashes: { redProof: 'f'.repeat(64), degrade: 'f'.repeat(64) } });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /evidence/);
  });

  it('a MALFORMED evidence store refuses closed (never "no record" by silence)', () => {
    const { root } = makeRepo();
    writeFileSync(storeOf(root), 'not json\n');
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /evidence store unavailable/);
    assert.match(r.stdout + r.stderr, /malformed/);
  });

  it('fingerprint before ≠ after on the receipt → refuse (the tree moved UNDER the final run)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp, { fingerprintAfter: 'b'.repeat(64) });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /UNDER the final run/);
  });

  it('an UNREADABLE declaration refuses naming the path (never a pass on a vanished gates.json)', () => {
    const { root } = makeRepo();
    rmSync(join(root, 'docs', 'ai', 'gates.json'));
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('add', '-A'); // the delete moves the fingerprint — re-mint at the CURRENT tree to pin THIS arm
    seedFinal(root, computeTreeFingerprint(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /no readable gate declaration/);
  });

  it('a receipt with lcovSha256 and a MATCHING lcov file passes; a vanished lcov refuses', () => {
    const { root } = makeRepo();
    const lcovPath = join(root, '.git', 'agent-workflow-lcov.info');
    writeFileSync(lcovPath, 'TN:\nend_of_record\n');
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp, { lcovSha256: sha('TN:\nend_of_record\n') });
    const ok = main(['--check', '--cwd', root], { env: fixtureEnv() });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    rmSync(lcovPath);
    const gone = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(gone.code, 1);
    assert.match(gone.stdout + gone.stderr, /lcov.*moved or vanished/);
  });

  it('a dangling LATER final-start refuses (an attempt started after the green and never completed)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    seedStart(root, fp, 'attempt-dangling'); // interrupted / failed-append attempt — no completion
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /never completed/);
  });

  it('a completed later attempt CLOSES its start — the latest completion governs again', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    seedStart(root, fp, 'attempt-two');
    seedFinal(root, fp, { attempt: 'attempt-two' });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('a poisoned AW_LCOV_FILE is IGNORED — the guard reads only the fixed git-dir lcov', () => {
    const { root } = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-poison-'));
    writeFileSync(join(outside, 'poison.info'), 'POISONED\n');
    writeFileSync(join(root, '.git', 'agent-workflow-lcov.info'), 'TN:\nend_of_record\n');
    seedFinal(root, computeTreeFingerprint(root), { lcovSha256: sha('TN:\nend_of_record\n') });
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_LCOV_FILE: join(outside, 'poison.info') }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, `the stray override must not reach the guard: ${r.stdout}${r.stderr}`);
  });

  it('a poisoned AW_CORE_EVIDENCE is IGNORED — the guard reads only the fixed git-dir store', () => {
    const { root } = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-forge-'));
    const forged = join(outside, 'forged.jsonl');
    const fp = computeTreeFingerprint(root);
    // The FORGED store carries a perfect green receipt; the REAL git-dir store has none.
    const real = storeOf(root);
    seedFinal(root, fp); // build a valid record shape…
    writeFileSync(forged, readFileSync(real));
    rmSync(real); // …then move it wholly into the forgery
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE: forged }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a forged out-of-repo store must not satisfy the guard');
    assert.match(r.stdout + r.stderr, /no completed final-run record/);
  });

  it('a MISSING/VETOED ship receipt refuses (the review-state decision rides the guard)', () => {
    const { root } = makeCouncilRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout + r.stderr, /no receipt|review/);
  });

  it('a FORGED receipts store via AW_REVIEW_RECEIPTS is IGNORED — the ship arm reads the real git-dir receipts', () => {
    const { root } = makeCouncilRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-forge-receipts-'));
    const forged = join(outside, 'forged-receipts.jsonl');
    writeFileSync(forged, `${shipReceipt(fp, 'codex')}\n${shipReceipt(fp, 'agy')}\n`);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_REVIEW_RECEIPTS: forged }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'forged out-of-repo receipts must never satisfy the ship arm');
    assert.match(r.stdout + r.stderr, /review obligations/);
  });

  it('a FORGED degrade record via AW_CORE_EVIDENCE never exempts a backend — the escape reads the real git-dir store', () => {
    const { root } = makeCouncilRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    // ONE real attesting ship receipt (codex) in the REAL git-dir receipts store…
    writeFileSync(join(root, '.git', 'agent-workflow-review-receipts.jsonl'), `${shipReceipt(fp, 'codex')}\n`);
    // …and a FORGED degrade for the other backend in an out-of-repo evidence store.
    const outside = mkdtempSync(join(tmpdir(), 'commit-guard-forge-degrade-'));
    const forged = join(outside, 'forged-evidence.jsonl');
    writeFileSync(forged, `${JSON.stringify({ schema: 1, kind: 'degrade', backend: 'agy', reason: 'forged exemption', fingerprint: fp, timestamp: 't' })}\n`);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE: forged }) });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a forged degrade must never exempt a required backend');
    assert.match(r.stdout + r.stderr, /review obligations/);
  });

  it('everything current → PASS (fingerprint + declaration + evidence hashes + ship arm)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    seedFinal(root, fp);
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('usage errors are exit 2 with the reason on stderr (unknown argument; --cwd without a value)', () => {
    const unknown = main(['--check', '--nope'], { env: fixtureEnv() });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown argument: --nope/);
    const dangling = main(['--check', '--cwd'], { env: fixtureEnv() });
    assert.equal(dangling.code, 2);
    assert.match(dangling.stderr, /--cwd needs a directory/);
  });
});

describe('commit-guard — integration: a REAL git commit is refused per violation class', () => {
  it('no receipt → the commit is refused by the pre-commit hook; with a current green receipt it lands', () => {
    const { root, g } = makeRepo();
    installHook(root);
    const refused = tryCommit(root);
    assert.notEqual(refused.status, 0, 'the hook must refuse an unreceipted commit');
    assert.match(`${refused.stdout}${refused.stderr}`, /final-run record|--final/);
    seedFinal(root, computeTreeFingerprint(root));
    const ok = tryCommit(root);
    assert.equal(ok.status, 0, `a receipted staged tree commits: ${ok.stdout}${ok.stderr}`);
    const log = g('log', '--oneline');
    assert.match(log.stdout, /guarded/);
    rmSync(root, { recursive: true, force: true });
  });

  it('a stale-fingerprint receipt → the commit is refused (edited after the final run)', () => {
    const { root } = makeRepo();
    installHook(root);
    seedFinal(root, computeTreeFingerprint(root));
    writeFileSync(join(root, 'change.mjs'), 'export const x = 2;\n'); // unstaged edit AFTER the final run
    const refused = tryCommit(root);
    rmSync(root, { recursive: true, force: true });
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stdout}${refused.stderr}`, /fingerprint/);
  });
});

describe('resolveGitHooksPath — the ONE hooks-path answer consumers read', () => {
  it('answers git’s own hooks dir inside a repo and null outside one', () => {
    const { root } = makeRepo();
    assert.equal(guard.resolveGitHooksPath(root), join(root, '.git', 'hooks'));
    rmSync(root, { recursive: true, force: true });
    const plain = mkdtempSync(join(tmpdir(), 'commit-guard-nogit-'));
    assert.equal(guard.resolveGitHooksPath(plain), null);
    rmSync(plain, { recursive: true, force: true });
  });
});
