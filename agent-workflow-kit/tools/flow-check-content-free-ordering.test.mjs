// The third CONTENT-FREE arm and the laziness that pays for it, in their own suite so the
// red-proofs frozen on the other two content-free suites stay valid.
//
// #64 orders a degrade against a final-start by FINGERPRINT alone. The core degrade record carries
// no base and no attempt, so on the content-free value two records from unrelated clean moments
// pair up and the rung refuses every commit — the #65 deadlock's shape in a third place. Their
// order is not a fact about any tree, so a content-free degrade is outside the rung.
//
// The laziness half: the D10 binding probes the tree fingerprint, and that probe must stay INSIDE
// the commit-guard lane. A store-less or health-broken tree pays a full-tree read otherwise, and an
// unreadable untracked file turns an inert answer into an exception.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideFlowCheck, computeFlowDecision } from './flow-check.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest } from './flow-record.mjs';
import { parseFlowStoreText } from './flow-store.mjs';
import { EVIDENCE_SCHEMA_VERSION, parseEvidenceText } from './core-evidence.mjs';

// The observed clean-tree value; flow-check-content-free-red.test.mjs binds this literal to the
// exported constant and to a real clean repository.
const CLEAN_TREE_FP = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FP = 'a1'.repeat(32);
const BASE = 'ad'.repeat(20);
const TS = (n) => `2026-08-18T00:00:${String(n).padStart(2, '0')}.000Z`;

const TMP = mkdtempSync(join(tmpdir(), 'aw-content-free-order-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const chainRec = (purpose, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'chain', purpose, planId: 'plan-a', cycle: 1,
  round: 1, commitEpoch: 0, owner: 'main', base: BASE, timestamp: TS(0),
  stepId: 'step-1', fingerprint: FP, ...over,
});
const adoption = (over = {}) => chainRec('adoption', {
  round: 0, stepId: null, planLabel: 'Plan A', createdAt: TS(0), planDigest: 'd1'.repeat(32), ...over,
});
const ownChain = () => {
  const first = adoption();
  return [first, chainRec('round', { opensFrom: canonicalFlowDigest(first), dispatches: [], dispositions: [], timestamp: TS(1) })];
};
const startAt = (fp, attempt, n) => ({ schema: EVIDENCE_SCHEMA_VERSION, kind: 'final-start', fingerprint: fp, attempt, timestamp: TS(n) });
// Distinct reasons: the store's authoritative selection is per {backend, fingerprint}, so two
// byte-identical degrades would collapse into one record and the count would prove nothing.
const degradeAt = (fp, n) => ({ schema: EVIDENCE_SCHEMA_VERSION, kind: 'degrade', backend: n % 2 === 0 ? 'agy' : 'codex', reason: `headless denial ${n}`, fingerprint: fp, timestamp: TS(n) });

// A start, then TWO degrades at the same fingerprint, and no completed re-run — the exact shape #64
// exists to refuse. Two, not one: at n=1 a per-record advisory and an aggregated one are
// indistinguishable, so the count could be wrong in either direction and no test would notice.
const decideOrderingAt = (fp) => decideFlowCheck({
  flowRead: parseFlowStoreText(ownChain().map((r) => JSON.stringify(r)).join('\n')),
  coreRead: parseEvidenceText([startAt(fp, 'a1', 2), degradeAt(fp, 3), degradeAt(fp, 4)].map((r) => JSON.stringify(r)).join('\n')),
  owner: 'main',
});
const ordering = (d) => d.refusals.filter((r) => /landed AFTER a final-start/.test(r));

let seq = 0;
const makeRepo = (flowRecords = null) => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'coder-tools@proton.me');
  g('config', 'user.name', 'coder-tool');
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  if (flowRecords != null) {
    writeFileSync(join(root, '.git', 'agent-workflow-flow.jsonl'), `${flowRecords.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  return root;
};

describe('flow-check — the CONTENT-FREE ordering arm', () => {
  it('a content-free degrade after a content-free final-start is OUTSIDE the ordering rung', () => {
    const d = decideOrderingAt(CLEAN_TREE_FP);
    assert.deepEqual(ordering(d), [], 'two clean moments cannot be shown to be the same moment');
    const skips = d.advisories.filter((a) => /ordering rung/.test(a));
    assert.equal(skips.length, 1, 'ONE aggregated advisory, never one per record');
    // Anchored: an unanchored /2 core degrade/ would also accept 12 or 22, so the count the fold
    // exists to prove would not be pinned at all.
    assert.match(skips[0], /^2 core degrade\(s\) /, 'carrying the exact count it skipped');
    assert.match(skips[0], /CONTENT-FREE/);
    assert.match(skips[0], /#64/);
  });

  it('the ordering rung still refuses the same shape at an ordinary fingerprint', () => {
    const d = decideOrderingAt(FP);
    assert.equal(ordering(d).length, 2, JSON.stringify(d.refusals));
    assert.match(ordering(d)[0], /#64/);
    assert.equal(d.advisories.filter((a) => /ordering rung/.test(a)).length, 0, 'and nothing is skipped there');
  });
});

describe('flow-check — the D10 fingerprint probe stays lazy', () => {
  const throwingProbe = () => { throw new Error('the fingerprint probe must not run on this lane'); };

  it('a store-less tree never probes the fingerprint, on either consumer', () => {
    const root = makeRepo();
    for (const consumer of ['gate', 'commit-guard']) {
      const d = computeFlowDecision({ cwd: root, consumer, probes: { fingerprint: throwingProbe } });
      assert.equal(d.present, false, consumer);
      assert.deepEqual(d.refusals, [], consumer);
    }
  });

  it('a PRESENT unadopted store with no completed final never probes either — and one final makes it', () => {
    // The store-less case alone would leave the claim resting on `present === false`. Here the
    // store exists and reads clean; what keeps the lane quiet is that no final record can be bound.
    const quiet = makeRepo([{
      schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: FP, cause: 'unadopted store',
      attempt: 'a1', base: BASE, timestamp: TS(1),
    }]);
    const d = computeFlowDecision({ cwd: quiet, consumer: 'commit-guard', probes: { fingerprint: throwingProbe } });
    assert.equal(d.present, true);
    assert.equal(d.armed, false, 'valid, unadopted');
    // The counterexample: one completed final in the core store and the SAME lane probes, exactly
    // once — the guard is quiet because there is nothing to bind, never because it stopped looking.
    const bound = makeRepo([{
      schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: FP, cause: 'unadopted store',
      attempt: 'a1', base: BASE, timestamp: TS(1),
    }]);
    writeFileSync(join(bound, '.git', 'agent-workflow-core-evidence.jsonl'), `${JSON.stringify({
      schema: EVIDENCE_SCHEMA_VERSION, kind: 'final', status: 'green', attempt: 'a1',
      fingerprintBefore: FP, fingerprintAfter: FP, declared: [{ id: 'g', cmd: 'true' }],
      results: [{ id: 'g', ok: true, code: 0 }], integrityFailure: null,
      evidenceHashes: { redProof: 'aa'.repeat(32), degrade: 'bb'.repeat(32) },
      lcovSha256: null, timestamp: TS(2),
    })}\n`);
    let calls = 0;
    computeFlowDecision({ cwd: bound, consumer: 'commit-guard', probes: { fingerprint: () => { calls += 1; return FP; } } });
    assert.equal(calls, 1);
  });

  it('an ARMED gate probes the fingerprint exactly once — the lane stays armed, not merely quiet', () => {
    // The counter-test: laziness must not become blindness. An armed decision needs the tree for
    // its evidence rungs, and that is ONE probe, not zero and not two.
    const root = makeRepo(ownChain());
    let calls = 0;
    const d = computeFlowDecision({ cwd: root, consumer: 'gate', probes: { fingerprint: () => { calls += 1; return FP; } } });
    assert.equal(d.armed, true);
    assert.equal(calls, 1);
  });
});
