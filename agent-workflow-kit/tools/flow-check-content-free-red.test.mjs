// The CONTENT-FREE arms, in their own suite: flow-check.test.mjs carries a recorded size baseline,
// and these are lanes of their own. A clean tree emits an EMPTY fingerprint payload, so its
// fingerprint is the one value every clean moment in every repository shares: it identifies no
// working state and correlates to no base, so evidence found at it belongs to some other moment
// and must decide nothing — not the red rung that would convict, not the coverage rungs that would
// demand, and not the guard that would attest. Correlating it is meaningless rather than
// ambiguous, so each arm steps over it and SAYS SO.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectUnansweredRedRefusals, decideFlowCheck } from './flow-check.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest } from './flow-record.mjs';
import { parseFlowStoreText } from './flow-store.mjs';
// Namespace-imported ON PURPOSE: a named import of a not-yet-exported constant is a link-time
// error, which would make the RED observation a load failure instead of a failed assertion.
import * as coreEvidence from './core-evidence.mjs';
import { EVIDENCE_SCHEMA_VERSION, parseEvidenceText, computeTreeFingerprint } from './core-evidence.mjs';

// The OBSERVED clean-tree value: sha256 over an empty payload. Pinned as a literal here and bound
// to a REAL clean repository by the last test, so neither the constant nor the arm can drift into
// agreeing with itself.
const CLEAN_TREE_FP = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const BASE = 'ad'.repeat(20);
const BASE2 = 'be'.repeat(20);
const FP = 'a1'.repeat(32);
const TS = (n) => `2026-08-18T00:00:${String(n).padStart(2, '0')}.000Z`;

const chainRec = (purpose, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'chain', purpose, planId: 'plan-a', cycle: 1,
  round: 1, commitEpoch: 0, owner: 'main', base: BASE, timestamp: TS(0),
  stepId: 'step-1', fingerprint: FP, ...over,
});
const adoption = (over = {}) => chainRec('adoption', {
  round: 0, stepId: null, planLabel: 'Plan A', createdAt: TS(0), planDigest: 'd1'.repeat(32), ...over,
});
const opener = (opensFrom, over = {}) => chainRec('round', { opensFrom, dispatches: [], dispositions: [], ...over });
const freezeAt = (fp, over = {}) => chainRec('freeze', { fingerprint: fp, timestamp: TS(2), ...over });

const coreFinal = (attempt, fp, n) => ({
  schema: EVIDENCE_SCHEMA_VERSION, kind: 'final', status: 'red', attempt, fingerprintBefore: fp,
  fingerprintAfter: fp, declared: [{ id: 'g', cmd: 'true' }], results: [{ id: 'g', ok: false, code: 1 }],
  integrityFailure: null, evidenceHashes: { redProof: 'aa'.repeat(32), degrade: 'bb'.repeat(32) },
  lcovSha256: null, timestamp: TS(n),
});

const recordsOf = (recs) => {
  const read = parseFlowStoreText(recs.map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(read.malformed, 0, read.malformedReasons[0]);
  return read.records;
};
const coreOf = (recs) => {
  const read = parseEvidenceText(recs.map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(read.malformed, 0, read.malformedReasons[0]);
  return read.records;
};
const ownChain = () => {
  const first = adoption();
  return [first, opener(canonicalFlowDigest(first), { timestamp: TS(1) })];
};
const rung = (flowRecords, coreRecords, advisories = []) => collectUnansweredRedRefusals({
  flowRecords, coreRecords, currentBase: BASE, owner: 'main', advisories,
});

describe('flow-check — the #65 CONTENT-FREE red arm', () => {
  it('a content-free red final is OUTSIDE the rung and never refuses', () => {
    // The shape that deadlocked this repository: the clean-tree fingerprint appears in the flow
    // store under two different bases, so the multi-base lane refused fail-closed forever.
    const flow = recordsOf([
      ...ownChain(),
      freezeAt(CLEAN_TREE_FP),
      freezeAt(CLEAN_TREE_FP, { base: BASE2, timestamp: TS(3) }),
    ]);
    assert.deepEqual(rung(flow, coreOf([coreFinal('a1', CLEAN_TREE_FP, 4)])), []);
  });

  it('the content-free skip is RECORDED as an advisory naming the attempt', () => {
    const flow = recordsOf([
      ...ownChain(),
      freezeAt(CLEAN_TREE_FP),
      freezeAt(CLEAN_TREE_FP, { base: BASE2, timestamp: TS(3) }),
    ]);
    const advisories = [];
    rung(flow, coreOf([coreFinal('a1', CLEAN_TREE_FP, 4)]), advisories);
    assert.equal(advisories.length, 1);
    assert.match(advisories[0], /attempt "a1"/);
    assert.match(advisories[0], /OUTSIDE the rung/);
    assert.match(advisories[0], /CONTENT-FREE/);
    assert.match(advisories[0], /#65/);
  });

  it('the arm keys the fingerprint, not the ambiguity — one correlated base is still outside', () => {
    // Resolving to exactly ONE base is an accident of store history, never a fact about the tree:
    // a content-free fingerprint states nothing about the work the commit would carry.
    const flow = recordsOf([...ownChain(), freezeAt(CLEAN_TREE_FP)]);
    const advisories = [];
    assert.deepEqual(rung(flow, coreOf([coreFinal('a1', CLEAN_TREE_FP, 4)]), advisories), []);
    assert.equal(advisories.length, 1);
  });

  it('a red final at a real tree keeps refusing — the arm never widens past an empty payload', () => {
    const ambiguous = recordsOf([...ownChain(), freezeAt(FP, { base: BASE2, timestamp: TS(3) })]);
    const multi = rung(ambiguous, coreOf([coreFinal('a1', FP, 4)]));
    assert.equal(multi.length, 1);
    assert.match(multi[0], /distinct bases/);
    const onBase = rung(recordsOf(ownChain()), coreOf([coreFinal('a1', FP, 4)]));
    assert.equal(onBase.length, 1);
    assert.match(onBase[0], /on the CURRENT base/);
  });

  it('CONTENT_FREE_FINGERPRINT is the fingerprint a CLEAN work tree actually computes', () => {
    const TMP = mkdtempSync(join(tmpdir(), 'aw-content-free-'));
    after(() => rmSync(TMP, { recursive: true, force: true }));
    const root = join(TMP, 'repo');
    mkdirSync(root, { recursive: true });
    const sh = (args) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    };
    sh(['init', '-q', '-b', 'main']);
    sh(['config', 'user.email', 'coder-tools@proton.me']);
    sh(['config', 'user.name', 'coder-tool']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    sh(['add', '-A']);
    sh(['commit', '-q', '-m', 'init']);
    assert.equal(computeTreeFingerprint(root), CLEAN_TREE_FP, 'a clean work tree emits an empty payload');
    assert.equal(coreEvidence.CONTENT_FREE_FINGERPRINT, CLEAN_TREE_FP);
    writeFileSync(join(root, 'base.txt'), 'dirty\n');
    assert.notEqual(computeTreeFingerprint(root), CLEAN_TREE_FP, 'an ordinary tracked edit leaves the content-free value');
    // Deliberately NOT claimed here: that EVERY real change leaves it. A gitlink hidden by
    // `submodule.<name>.ignore` keeps the payload empty while the index carries the change — the
    // counterexample commit-guard-content-free.test.mjs pins, and the reason the guard splits its
    // content-free lanes by the INDEX rather than by the payload.
  });
});

describe('flow-check — the CONTENT-FREE coverage arms', () => {
  const flowReadOf = (recs) => parseFlowStoreText(recs.map((r) => JSON.stringify(r)).join('\n'));
  const coreReadOf = (recs) => parseEvidenceText(recs.map((r) => JSON.stringify(r)).join('\n'));
  const receiptAt = (fp) => ({
    schema: 1, artifact: 'code', fresh: true, probe: false, grounded: true, fingerprint: fp,
    backend: 'codex', verdict: 'ship', posture: { model: 'frontier' }, delivery: 'inline', timestamp: TS(0),
  });
  const degradeAt = (fp) => ({
    schema: EVIDENCE_SCHEMA_VERSION, kind: 'degrade', backend: 'codex', reason: 'quota stall',
    fingerprint: fp, timestamp: TS(1),
  });
  // An UNBOUND receipt (no round dispatch entry carries its digest) and an UNJUSTIFIED degrade —
  // the two states the coverage rungs exist to refuse. `treeCarriesBytes` is the CALLER's
  // statement, not a property the checker derives: a routine clean-tree check still wants both
  // rungs, and only a caller judging an actual commit knows the tree carries nothing.
  const decideAt = (fp, treeCarriesBytes = true) => decideFlowCheck({
    flowRead: flowReadOf(ownChain()),
    coreRead: coreReadOf([degradeAt(fp)]),
    owner: 'main',
    treeCarriesBytes,
    evidence: {
      receipts: [receiptAt(fp)],
      tree: { base: BASE, fingerprint: fp },
      receiptBackends: ['codex'],
      degradeBackends: ['codex'],
      declaredPaths: null,
      refreshCap: null,
    },
  });

  // The open-chain refusal the fixture also carries is a CHAIN fact, not a coverage one — it must
  // survive both lanes untouched, so it is asserted rather than filtered away silently.
  const coverage = (d) => d.refusals.filter((r) => /coverage refuses uncovered degrades|bound by NO round dispatch-ledger entry/.test(r));

  it('a tree that carries bytes is covered as before — both rungs refuse', () => {
    const d = decideAt(FP);
    assert.equal(coverage(d).length, 2, JSON.stringify(d.refusals));
    assert.ok(d.refusals.some((r) => /is not converged/.test(r)), 'and the chain refusal stands');
  });

  it('a CONTENT-FREE tree demands neither coverage, and records the skip', () => {
    const d = decideAt(CLEAN_TREE_FP, false);
    assert.deepEqual(coverage(d), [], 'evidence at that fingerprint belongs to another clean moment');
    assert.ok(d.refusals.some((r) => /is not converged/.test(r)), 'while every CHAIN refusal is untouched');
    // Filtered, not counted: the fixture's content-free degrade also earns the ordering-rung
    // advisory (#64), and a bare count would break every time another arm learns the same fact.
    const skip = d.advisories.filter((a) => /#42/.test(a));
    assert.equal(skip.length, 1);
    assert.match(skip[0], /carries NO bytes/);
    assert.match(skip[0], /#25/);
    // The same fingerprint WITHOUT the caller's statement keeps both rungs — the checker never
    // derives the fact from the tree.
    assert.equal(coverage(decideAt(CLEAN_TREE_FP)).length, 2);
  });
});
