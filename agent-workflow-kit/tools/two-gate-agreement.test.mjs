// two-gate-agreement.test.mjs — the behavioural proof (AD-050 Verification 5) that the two read-only
// review gates AGREE on a tree the orchestrator honestly converged codex-only with agy recorded
// degraded: review-state --check (presence) and review-ledger --check (convergence) both return 0.
// Flip the degrade to an OLD fingerprint and both return 1. Detector-INDEPENDENT (CI-portable): both
// gates' main() take an injected detector, so council resolves deterministically without the real
// bridges installed — the recipe never degrades to solo under a bridge-less CI.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main as reviewStateMain, computeTreeFingerprint } from './review-state.mjs';
import { main as reviewLedgerMain } from './review-ledger.mjs';
import { READY } from './detect-backends.mjs';

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const councilDetect = () => [{ name: CODEX, readiness: READY }, { name: AGY, readiness: READY }];
const COUNCIL_CONFIG = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });

// A hermetic git repo: committed base + a council config + one plan in flight + a dirty tree.
const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'two-gate-'));
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(root, 'base.txt'), 'committed base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), COUNCIL_CONFIG);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# active plan\n');
  writeFileSync(join(root, 'pending.txt'), 'uncommitted work\n');
  return { root, g };
};

// The receipt SELF-DECLARES its probe status (D3): an unmarked one is untrustworthy and would never
// satisfy, so this suite exercises the two gates AGREEING rather than the marker rule.
const codexShipReceipt = (fingerprint) =>
  JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint, backend: 'codex', verdict: 'ship', grounded: true, factsHash: null, wrapperVersion: '2.2.0', timestamp: '2026-07-09T00:00:00Z', probe: false });

const convergedWithDegradeRound = (base, fingerprint) =>
  JSON.stringify({
    schema: 4, loop: 'active-plan', activity: 'plan-execution', kind: 'round', round: 1, base, fingerprint,
    origins: { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 },
    backends: [
      { backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' },
      { backend: 'agy', degraded: true, blockers: 0, majors: 0, minors: 0, verdict: 'degraded', reason: 'Issue-001 stall on a large diff' },
    ],
    findings: [], timestamp: '2026-07-09T00:00:00Z',
  });

// Seed out-of-tree ledger + receipts + core-evidence files (in the git dir they would not move the
// fingerprint; a tmp file is simplest to control per case). The degrade is recorded in BOTH homes —
// the ledger round (review-ledger's convergence input) AND the core-evidence degrade record
// (review-state's D3(b) escape) — the transitional agreement both gates read while the ledger
// lives. Returns the env override map + the cleanup dir.
const agyDegradeRecord = (fingerprint) =>
  JSON.stringify({ schema: 1, kind: 'degrade', backend: 'agy', reason: 'Issue-001 stall on a large diff', fingerprint, timestamp: '2026-07-09T00:00:00Z' });
const seed = (root, roundFingerprint) => {
  const dir = mkdtempSync(join(tmpdir(), 'two-gate-state-'));
  const ledger = join(dir, 'ledger.jsonl');
  const receipts = join(dir, 'receipts.jsonl');
  const evidence = join(dir, 'evidence.jsonl');
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const treeFp = computeTreeFingerprint(root);
  writeFileSync(ledger, `${convergedWithDegradeRound(base, roundFingerprint ?? treeFp)}\n`);
  writeFileSync(receipts, `${codexShipReceipt(treeFp)}\n`);
  writeFileSync(evidence, `${agyDegradeRecord(roundFingerprint ?? treeFp)}\n`);
  return { env: { AW_REVIEW_LEDGER: ledger, AW_REVIEW_RECEIPTS: receipts, AW_CORE_EVIDENCE: evidence }, dir };
};

const stateCheck = (root, env) => reviewStateMain(['--check'], { cwd: root, env, detect: councilDetect });
const ledgerCheck = (root, env) => reviewLedgerMain(['--check'], { cwd: root, env, detect: councilDetect });

describe('two-gate agreement (AD-050) — review-state and review-ledger agree on a converged-with-degrade tree', () => {
  it('agy degraded at the CURRENT fingerprint + a codex grounded receipt → BOTH gates exit 0', () => {
    const { root } = makeRepo();
    const { env, dir } = seed(root); // round fingerprint defaults to the current tree fingerprint
    const s = stateCheck(root, env);
    const l = ledgerCheck(root, env);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(s.code, 0, `review-state should PASS (agy degraded-exempt): ${s.stdout}`);
    assert.equal(l.code, 0, `review-ledger should PASS (converged): ${l.stdout}`);
  });

  it('flip the degrade to an OLD fingerprint → BOTH gates exit 1 (the degrade no longer attests THIS tree)', () => {
    const { root } = makeRepo();
    const { env, dir } = seed(root, 'a'.repeat(64)); // a VALID but different fingerprint — a stale record, never a malformed one
    const s = stateCheck(root, env);
    const l = ledgerCheck(root, env);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(s.code, 1, 'review-state: the degrade is stale → agy not exempt → FAIL');
    assert.doesNotMatch(s.stdout, /evidence store unavailable/, 'the refusal comes from stale-record semantics, not a malformed store');
    assert.equal(l.code, 1, 'review-ledger: the round attests a stale tree → not converged → FAIL');
  });
});

// The probe marker is a TWO-GATE invariant (D3): review-state owns receipt presence and review-ledger
// owns convergence, so a probe that satisfied either one alone would let the pair report a green
// tree. These pin that no probe receipt — however it is arranged — can do that.
describe('two-gate agreement (D3) — a probe receipt can never green the pair', () => {
  const seedProbeOnly = (root) => {
    const dir = mkdtempSync(join(tmpdir(), 'two-gate-probe-'));
    const ledger = join(dir, 'ledger.jsonl');
    const receipts = join(dir, 'receipts.jsonl');
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const treeFp = computeTreeFingerprint(root);
    writeFileSync(ledger, `${convergedWithDegradeRound(base, treeFp)}\n`);
    // The ONLY current receipt is a probe claiming ship — formally a converged 0/0 round beside it.
    writeFileSync(receipts, `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: treeFp, backend: 'codex', verdict: 'ship', grounded: true, factsHash: null, wrapperVersion: '2.2.0', timestamp: '2026-07-09T00:00:00Z', probe: true })}\n`);
    return { env: { AW_REVIEW_LEDGER: ledger, AW_REVIEW_RECEIPTS: receipts }, dir };
  };

  it('probe-only current receipts fail BOTH receipt gates', () => {
    const { root } = makeRepo();
    const { env, dir } = seedProbeOnly(root);
    const s = stateCheck(root, env);
    const l = ledgerCheck(root, env);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(s.code, 1, `review-state must reject a probe-only tree: ${s.stdout}`);
    assert.match(s.stdout, /only probe receipts/);
    assert.equal(l.code, 1, `review-ledger must reject a round bound only to a probe: ${l.stdout}`);
    assert.match(l.stdout, /only probe receipts/);
  });

  it('a real REWORK receipt followed by a probe SHIP cannot make the pair pass', () => {
    // BOTH gates refuse: review-state vetoes on the real "revise" (ship-class-only satisfaction —
    // the strip-the-kit hardening), and review-ledger refuses the recorded 0/0 against it. The
    // ATTESTING verdict is the real "revise" — never the probe that landed after it: taking the
    // LAST receipt is exactly the false-pass this pins shut.
    const { root } = makeRepo();
    const dir = mkdtempSync(join(tmpdir(), 'two-gate-probe-order-'));
    const ledger = join(dir, 'ledger.jsonl');
    const receipts = join(dir, 'receipts.jsonl');
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const treeFp = computeTreeFingerprint(root);
    writeFileSync(ledger, `${convergedWithDegradeRound(base, treeFp)}\n`);
    const real = JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: treeFp, backend: 'codex', verdict: 'revise', grounded: true, factsHash: null, wrapperVersion: '2.2.0', timestamp: '2026-07-09T00:00:00Z', probe: false });
    const probe = JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: treeFp, backend: 'codex', verdict: 'ship', grounded: true, factsHash: null, wrapperVersion: '2.2.0', timestamp: '2026-07-09T00:00:01Z', probe: true });
    writeFileSync(receipts, `${real}\n${probe}\n`);
    const env = { AW_REVIEW_LEDGER: ledger, AW_REVIEW_RECEIPTS: receipts };
    const s = stateCheck(root, env);
    const l = ledgerCheck(root, env);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(s.code, 1, `review-state vetoes on the real "revise" (ship-class-only): ${s.stdout}`);
    assert.match(s.stdout, /authoritative veto/);
    assert.equal(l.code, 1, `review-ledger must refuse 0/0 against the real "revise": ${l.stdout}`);
    assert.match(l.stdout, /is not ship-class/);
  });
});
