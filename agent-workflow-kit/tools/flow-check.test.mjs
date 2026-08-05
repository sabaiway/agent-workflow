import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  decideFlowCheck, runFlowCheck, classifyDeltaChain, evaluateVetoOverride,
  collectUnansweredRedRefusals, classifyBaseMotion, collectDegradeCoverageRefusals,
  collectReceiptCoverageRefusals, computeAllPathBaseDelta, computeAllPathWorktreeSurface,
  evaluateInternalAttestationLenses,
} from './flow-check.mjs';
import { FALLBACK_LENS_ADDITIONAL_ONLY } from './cheap-agents.mjs';
import { resolveFlowStorePath, parseFlowStoreText } from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest, flowProjectionHash } from './flow-record.mjs';
import { EVIDENCE_SCHEMA_VERSION, resolveEvidencePath, parseEvidenceText, computeTreeFingerprint } from './core-evidence.mjs';

const TOOL = fileURLToPath(new URL('./flow-check.mjs', import.meta.url));
// The pasteable-recovery command anchor: the SAME absolute tool path + POSIX single-quoting the
// checker composes (byte-pinned below).
const WRITER_TOOL = fileURLToPath(new URL('./flow-writer.mjs', import.meta.url));
const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const TMP = mkdtempSync(join(tmpdir(), 'aw-flow-check-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
const makeRepo = () => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(root, { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
};

const BASE = 'ad'.repeat(20);
const FP = 'a1'.repeat(32);
const F2 = 'b2'.repeat(32);
const D = (pair) => pair.repeat(32);
const TS = (n) => `2026-07-30T00:00:${String(n).padStart(2, '0')}.000Z`;

const chainRec = (purpose, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'chain', purpose, planId: 'plan-a', cycle: 1,
  round: 1, commitEpoch: 0, owner: 'main', base: BASE, timestamp: TS(0),
  stepId: 'step-1', fingerprint: FP, ...over,
});
const adoption = (over = {}) => chainRec('adoption', {
  round: 0, stepId: null, planLabel: 'Plan A', createdAt: TS(0), planDigest: D('1a'), ...over,
});
const opener = (opensFrom, over = {}) => chainRec('round', { opensFrom, dispatches: [], dispositions: [], ...over });
const refresh = (refreshedRecord, over = {}) => {
  const r = chainRec('refresh', { fingerprintBefore: D('aa'), fingerprintAfter: D('aa'), cause: 're-attest', refreshedRecord, ...over });
  delete r.fingerprint;
  return r;
};
const delta = (over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'bookkeeping-delta', fingerprintBefore: D('aa'), fingerprintAfter: D('ab'),
  path: 'docs/notes.md', contentDigest: D('cd'),
  custodyProof: {
    preClass: 'absent', tracked: false, headDigest: null, indexDigest: null,
    worktreeDigest: null, maskedFingerprint: D('aa'),
  },
  base: BASE, timestamp: TS(0), ...over,
});
const coreStart = (fp, attempt, n) => ({ schema: EVIDENCE_SCHEMA_VERSION, kind: 'final-start', fingerprint: fp, attempt, timestamp: TS(n) });
const coreDegrade = (fp, n) => ({ schema: EVIDENCE_SCHEMA_VERSION, kind: 'degrade', backend: 'agy', reason: 'quota exhausted', fingerprint: fp, timestamp: TS(n) });
const coreFinal = (attempt, fp, n) => ({
  schema: EVIDENCE_SCHEMA_VERSION, kind: 'final', status: 'green', attempt, fingerprintBefore: fp, fingerprintAfter: fp,
  declared: [{ id: 'g', cmd: 'true' }], results: [{ id: 'g', ok: true, code: 0 }], integrityFailure: null,
  evidenceHashes: { redProof: D('aa'), degrade: D('bb') }, lcovSha256: null, timestamp: TS(n),
});

const flowReadOf = (records) => parseFlowStoreText(records.map((r) => JSON.stringify(r)).join('\n'));
const coreReadOf = (records) => parseEvidenceText(records.map((r) => JSON.stringify(r)).join('\n'));
const decide = (flowRecords, { core = [], owner = 'main', flowRead, motion } = {}) =>
  decideFlowCheck({ flowRead: flowRead ?? flowReadOf(flowRecords), coreRead: coreReadOf(core), owner, motion });

// Phase-1 fixtures. recordsOf/coreOf keep every fixture shape-valid — a malformed fixture would
// otherwise turn an arm test into a store-health test silently.
const BASE2 = 'be'.repeat(20);
const F3 = 'c3'.repeat(32);
const short = (digest) => `${digest.slice(0, 12)}…`;
const coreRedFinal = (attempt, fp, n) => ({ ...coreFinal(attempt, fp, n), status: 'red', results: [{ id: 'g', ok: false, code: 1 }] });
const receipt = (backend, verdict, fp, over = {}) => ({
  schema: 1, artifact: 'code', fresh: true, probe: false, grounded: true, fingerprint: fp,
  backend, verdict, posture: { model: 'frontier' }, delivery: 'inline', timestamp: TS(0), ...over,
});
const downMark = (backend, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'down-mark', fingerprint: FP, backend, reason: 'quota stall',
  expiresAt: TS(30), base: BASE, timestamp: TS(1), ...over,
});
const markClear = (target, backend, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'down-mark-clear', fingerprint: FP, backend, target, base: BASE, timestamp: TS(2), ...over,
});
const justification = (mark, degradeRecord, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'degrade-justification', fingerprint: FP,
  downMark: canonicalFlowDigest(mark), degradeDigest: canonicalFlowDigest(degradeRecord),
  base: BASE, timestamp: TS(5), ...over,
});
const rerunCause = (attempt, fp, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'rerun-cause', fingerprint: fp, cause: 'confirmed retry after the fix landed',
  attempt, base: BASE, timestamp: TS(6), ...over,
});
const override = (vetoRecord, over = {}) => ({
  schema: FLOW_SCHEMA_VERSION, kind: 'maintainer-override', fingerprint: FP,
  vetoReceiptDigest: canonicalFlowDigest(vetoRecord), backend: vetoRecord.backend, verdict: vetoRecord.verdict,
  chainRecord: D('00'), supersedes: null, base: BASE, timestamp: TS(7), ...over,
});
const recordsOf = (recs) => {
  const read = flowReadOf(recs);
  assert.equal(read.malformed, 0, read.malformedReasons[0]);
  return read.records;
};
const coreOf = (recs) => {
  const read = coreReadOf(recs);
  assert.equal(read.malformed, 0, read.malformedReasons[0]);
  return read.records;
};

describe('flow-check — fail-closed store health', () => {
  it('a malformed flow store is itself a refusal — an unknown kind fails closed, never a silent empty', () => {
    const d = decide([], { flowRead: parseFlowStoreText(`${JSON.stringify({ schema: FLOW_SCHEMA_VERSION, kind: 'mystery' })}\n`) });
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /malformed line/);
    assert.match(d.refusals[0], /unknown kind/);
  });

  it('an unreadable flow store is a refusal', () => {
    const d = decide([], { flowRead: { records: [], authoritative: [], malformed: 0, malformedReasons: [], readError: 'EACCES' } });
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /unreadable .*EACCES|unreadable \(EACCES\)/);
  });

  it('a malformed or unreadable CORE store is a refusal — the checker consumes the FULL read-results of BOTH stores', () => {
    const viaMalformed = decideFlowCheck({ flowRead: flowReadOf([]), coreRead: parseEvidenceText('junk\n'), owner: 'main' });
    assert.equal(viaMalformed.refusals.length, 1);
    assert.match(viaMalformed.refusals[0], /core evidence store/);
    const viaError = decideFlowCheck({ flowRead: flowReadOf([]), coreRead: { records: [], malformed: 0, malformedReasons: [], readError: 'EIO' }, owner: 'main' });
    assert.equal(viaError.refusals.length, 1);
    assert.match(viaError.refusals[0], /core evidence store is unreadable/);
  });
});

describe('flow-check — chain refusals', () => {
  it('a chain without a content-digest-bound adoption refuses', () => {
    const d = decide([opener(D('2b'))]);
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /no content-digest-bound adoption/);
  });

  it('an illegal transition refuses — a converged step never reopens outside the unfreeze lane', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const converged1 = chainRec('converged', { timestamp: TS(2) });
    const reopened = opener(canonicalFlowDigest(converged1), { timestamp: TS(3) });
    const d = decide([first, step1, converged1, reopened]);
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /already converged/);
  });

  it('a step-opening reference is re-classified at read time — an unresolved or non-terminal target refuses', () => {
    const first = adoption();
    const unresolved = decide([first, opener(D('9f'), { timestamp: TS(1) })]);
    assert.equal(unresolved.refusals.length, 1);
    assert.match(unresolved.refusals[0], /does not match the store/);
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const converged1 = chainRec('converged', { timestamp: TS(2) });
    const badTarget = opener(canonicalFlowDigest(step1), { stepId: 'step-2', timestamp: TS(3) });
    const nonTerminal = decide([first, step1, converged1, badTarget]);
    assert.equal(nonTerminal.refusals.length, 1);
    assert.match(nonTerminal.refusals[0], /non-terminal record/i);
  });
});

describe('flow-check — worktree scoping', () => {
  it('a chain record with no owner refuses (fail closed at the record layer)', () => {
    const broken = adoption();
    delete broken.owner;
    const d = decide([], { flowRead: parseFlowStoreText(`${JSON.stringify(broken)}\n`) });
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /malformed line/);
    assert.match(d.refusals[0], /owner/);
  });

  it('a foreign owner open chain yields advisory output and no refusal', () => {
    const first = adoption({ owner: 'worktree:elsewhere' });
    const step1 = opener(canonicalFlowDigest(first), { owner: 'worktree:elsewhere', timestamp: TS(1) });
    const d = decide([first, step1], { owner: 'main' });
    assert.deepEqual(d.refusals, []);
    assert.equal(d.advisories.length, 1);
    assert.match(d.advisories[0], /owned by "worktree:elsewhere"/);
    assert.match(d.advisories[0], /advisory/);
  });

  it('the committing tree own open chain refuses, printing the verbatim pasteable park command', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const d = decide([first, step1], { owner: 'main' });
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /OPEN chain owned by this worktree/);
    assert.ok(d.refusals[0].includes(`recovery (pasteable): node ${q(WRITER_TOOL)} park -- ${q('plan-a')}`), 'the recovery is the verbatim pasteable writer command (Decision 3; the -- terminator keeps a leading-dash id recoverable)');
  });
});

describe('flow-check — state-to-exit acceptance matrix', () => {
  it('own open → refuse · parked → pass · resumed → refuse · converged → pass · complete → pass', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const park = chainRec('park', { stepId: null, timestamp: TS(2) });
    const resume = chainRec('resume', { stepId: null, timestamp: TS(3) });
    const converged1 = chainRec('converged', { timestamp: TS(4) });
    const complete = chainRec('complete', { stepId: null, round: 1, timestamp: TS(5) });
    assert.equal(decide([first, step1]).refusals.length, 1, 'own open chain refuses');
    assert.equal(decide([first, step1, park]).refusals.length, 0, 'own PARKED chain passes');
    assert.equal(decide([first, step1, park, resume]).refusals.length, 1, 'after resume it refuses again');
    assert.equal(decide([first, step1, park, resume, converged1]).refusals.length, 0, 'own converged passes (cycle-lane terminal)');
    assert.equal(decide([first, step1, park, resume, converged1, complete]).refusals.length, 0, 'own complete passes (plan-lane terminal)');
  });
});

describe('flow-check — bookkeeping-delta refusals', () => {
  const boundRefresh = (theDelta, over = {}) => refresh(canonicalFlowDigest(theDelta), {
    owner: 'worktree:elsewhere', fingerprintBefore: theDelta.fingerprintAfter, fingerprintAfter: D('ae'), timestamp: TS(3), ...over,
  });
  const foreignChain = () => {
    const first = adoption({ owner: 'worktree:elsewhere' });
    const step1 = opener(canonicalFlowDigest(first), { owner: 'worktree:elsewhere', timestamp: TS(1) });
    return [first, step1];
  };

  it('a delta whose persisted proof does not prove confinement refuses — a bare declaration never passes', () => {
    const bare = delta({ custodyProof: { ...delta().custodyProof, maskedFingerprint: D('ab') } });
    const d = decide([bare]);
    assert.ok(d.refusals.some((r) => /custody proof/.test(r) && /confinement/.test(r)));
  });

  it('a tampered or detached proof field refuses (tamper-negatives)', () => {
    const theDelta = delta({ timestamp: TS(2) });
    const chain = foreignChain();
    const healthy = decide([...chain, theDelta, boundRefresh(theDelta)]);
    assert.deepEqual(healthy.refusals, [], 'the intact pair passes');
    const tamperedProof = { ...theDelta, custodyProof: { ...theDelta.custodyProof, maskedFingerprint: D('ff') } };
    assert.ok(decide([...chain, tamperedProof, boundRefresh(theDelta)]).refusals.length >= 1, 'an edited proof field refuses');
    const tamperedBefore = { ...theDelta, fingerprintBefore: D('ee') };
    assert.ok(decide([...chain, tamperedBefore, boundRefresh(theDelta)]).refusals.length >= 1, 'a detached fingerprintBefore refuses');
  });

  it('a delta with no satisfying re-attestation refuses; only the bound SUBSEQUENT refresh satisfies', () => {
    const theDelta = delta({ timestamp: TS(2) });
    const chain = foreignChain();
    const alone = decide([...chain, theDelta]);
    assert.ok(alone.refusals.some((r) => /re-attestation/.test(r)));
    assert.deepEqual(decide([...chain, theDelta, boundRefresh(theDelta)]).refusals, []);
    const mismatched = boundRefresh(theDelta, { fingerprintBefore: D('77') });
    assert.ok(decide([...chain, theDelta, mismatched]).refusals.some((r) => /re-attestation/.test(r)), 'a fingerprint-mismatched refresh never satisfies');
    const foreign = boundRefresh(theDelta, { refreshedRecord: D('66') });
    assert.ok(decide([...chain, theDelta, foreign]).refusals.length >= 1, 'a refresh bound to another record never satisfies');
    const earlier = decide([...chain, boundRefresh(theDelta), theDelta]);
    assert.ok(earlier.refusals.length >= 1, 'an earlier record never satisfies — raw order decides');
  });

  it('an unmintable custody proof refuses even when the masked recompute matches — the mint invariants are re-verified', () => {
    const chain = foreignChain();
    const cases = [
      { preClass: 'absent', tracked: true, headDigest: D('11'), indexDigest: D('12'), worktreeDigest: null, maskedFingerprint: D('aa') },
      { preClass: 'present', tracked: true, headDigest: D('11'), indexDigest: null, worktreeDigest: D('13'), maskedFingerprint: D('aa') },
      { preClass: 'present', tracked: true, headDigest: D('11'), indexDigest: D('12'), worktreeDigest: D('13'), maskedFingerprint: D('aa') },
    ];
    for (const custodyProof of cases) {
      const forged = delta({ timestamp: TS(2), custodyProof });
      const d = decide([...chain, forged, boundRefresh(forged)]);
      assert.ok(d.refusals.some((r) => /mint invariant/.test(r)), `an unmintable proof must refuse: ${JSON.stringify(custodyProof)}`);
    }
  });

  it('satisfaction is store-global by the locked shape: another plan refresh binding the delta digest satisfies (cap attribution is Plan-3 scope)', () => {
    const theDelta = delta({ timestamp: TS(2) });
    const chainA = foreignChain();
    const otherAdoption = adoption({ planId: 'plan-b', owner: 'worktree:elsewhere2', timestamp: TS(1) });
    const otherOpener = opener(canonicalFlowDigest(otherAdoption), { planId: 'plan-b', owner: 'worktree:elsewhere2', timestamp: TS(2) });
    const crossRefresh = boundRefresh(theDelta, { planId: 'plan-b', owner: 'worktree:elsewhere2', timestamp: TS(3) });
    const d = decide([...chainA, otherAdoption, otherOpener, theDelta, crossRefresh]);
    assert.deepEqual(d.refusals, [], 'the locked delta shape carries no chain field — the Plan-2 predicate binds digest + fingerprint + raw order only');
  });

  it('a refresh binding a SUPERSEDED target is a checker refusal — the reference domain is the authoritative selection', () => {
    const chain = foreignChain();
    const deltaV1 = delta({ timestamp: TS(2) });
    const deltaV2 = delta({ timestamp: TS(3) });
    const d = decide([...chain, deltaV1, deltaV2, boundRefresh(deltaV1, { timestamp: TS(4) }), boundRefresh(deltaV2, { timestamp: TS(5) })]);
    assert.ok(d.refusals.some((r) => /superseded record/.test(r)));
  });
});

describe('flow-check — degrade-before-final ordering (raw core order, grouped by fingerprint)', () => {
  it('a final-start at an unrelated fingerprint never fires the degrade refusal', () => {
    const d = decide([], { core: [coreStart(F2, 'a1', 1), coreDegrade(FP, 2)] });
    assert.deepEqual(d.refusals, []);
  });

  it('a degrade between a final-start and its completion refuses', () => {
    const d = decide([], { core: [coreStart(FP, 'a1', 1), coreDegrade(FP, 2), coreFinal('a1', FP, 3)] });
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /degrade .*after .*final-start|degrade/);
    assert.match(d.refusals[0], /strictly BEFORE/);
  });

  it('a dangling final-start refuses — an uncompleted re-run never clears the degrade', () => {
    assert.equal(decide([], { core: [coreStart(FP, 'a1', 1), coreDegrade(FP, 2)] }).refusals.length, 1);
    assert.equal(decide([], { core: [coreStart(FP, 'a1', 1), coreDegrade(FP, 2), coreStart(FP, 'a2', 3)] }).refusals.length, 1);
  });

  it('a completed later re-run at the fingerprint clears it', () => {
    const d = decide([], { core: [coreStart(FP, 'a1', 1), coreDegrade(FP, 2), coreStart(FP, 'a2', 3), coreFinal('a2', FP, 4)] });
    assert.deepEqual(d.refusals, []);
  });

  it('a curing completion must close the re-run at the SAME fingerprint — an attempt-matching final elsewhere never clears', () => {
    const d = decide([], { core: [coreStart(FP, 'a1', 1), coreDegrade(FP, 2), coreStart(FP, 'a2', 3), coreFinal('a2', F2, 4)] });
    assert.equal(d.refusals.length, 1);
  });
});

describe('flow-check — consumer env discipline + the thin CLI', () => {
  const runCli = (args, cwd, env = {}) =>
    spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

  it('--check on a healthy tree exits 0', () => {
    const root = makeRepo();
    const r = runCli(['--check'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /flow-check: PASS/);
  });

  it('--help exits 0 and states the LIVE composition — the undeclared-probe clause is gone (header truth, Step 2.3)', () => {
    const r = runCli(['--help'], TMP);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /flow-check/);
    assert.match(r.stdout, /review-state|commit-guard/);
    assert.doesNotMatch(r.stdout, /DELIBERATELY UNDECLARED/);
  });

  it('a malformed argument exits 2', () => {
    const r = runCli(['--nonsense'], TMP);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown argument/);
  });

  it('a non-git cwd is a named refusal', () => {
    const dir = join(TMP, 'no-repo-cli');
    mkdirSync(dir, { recursive: true });
    const r = runCli(['--check'], dir);
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /not a git work tree/);
  });

  it('--check ignores AW_FLOW_STORE and AW_CORE_EVIDENCE — poisoned-override tests for BOTH stores', () => {
    const root = makeRepo();
    const poison = join(TMP, `poison-${seq += 1}`);
    mkdirSync(poison, { recursive: true });
    writeFileSync(join(poison, 'flow.jsonl'), 'not json\n');
    writeFileSync(join(poison, 'core.jsonl'), 'not json\n');
    const clean = runCli(['--check'], root, { AW_FLOW_STORE: join(poison, 'flow.jsonl'), AW_CORE_EVIDENCE: join(poison, 'core.jsonl') });
    assert.equal(clean.status, 0, `the producer seams must be ignored by the checking consumer: ${clean.stdout}${clean.stderr}`);
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(first)}\n${JSON.stringify(step1)}\n`);
    writeFileSync(join(poison, 'decoy.jsonl'), '');
    const real = runCli(['--check'], root, { AW_FLOW_STORE: join(poison, 'decoy.jsonl'), AW_CORE_EVIDENCE: join(poison, 'decoy.jsonl') });
    assert.equal(real.status, 1, 'the REAL git-derived store decides — a clean decoy cannot mask an own open chain');
    assert.match(real.stdout, /OPEN chain/);
  });

  it('runFlowCheck reads the fixed git-derived core store too — a poisoned real core store refuses', () => {
    const root = makeRepo();
    writeFileSync(resolveEvidencePath(root, {}), 'junk line\n');
    const r = runFlowCheck({ cwd: root });
    assert.equal(r.code, 1);
    assert.ok(r.lines.some((l) => /core evidence store/.test(l)));
  });

  it('import causes no side effects (the isDirectRun guard)', () => {
    const probe = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(TOOL)}).then(() => process.stdout.write('imported-clean'))`], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, 'imported-clean');
    assert.equal(probe.stderr, '');
  });
});

describe('flow-check — Phase-1 characterization (unarmed Plan-2 outputs pinned byte-exact)', () => {
  it('the empty-store decision is byte-exact {refusals: [], advisories: []}', () => {
    assert.deepEqual(decide([]), { refusals: [], advisories: [] });
  });

  it('the own-open-chain refusal line is pinned byte-exact', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    assert.deepEqual(decide([first, step1]), {
      refusals: [`plan "plan-a" has an OPEN chain owned by this worktree ("main"): step "step-1" is not converged — a commit closes only at a terminal. recovery (pasteable): node ${q(WRITER_TOOL)} park -- ${q('plan-a')}`],
      advisories: [],
    });
  });

  it('the foreign-advisory line is pinned byte-exact', () => {
    const first = adoption({ owner: 'worktree:elsewhere' });
    const step1 = opener(canonicalFlowDigest(first), { owner: 'worktree:elsewhere', timestamp: TS(1) });
    assert.deepEqual(decide([first, step1]), {
      refusals: [],
      advisories: ['plan "plan-a": an OPEN chain owned by "worktree:elsewhere" (a foreign worktree) — advisory visibility only, never this tree\'s refusal (#57)'],
    });
  });

  it('the delta re-attestation refusal is pinned byte-exact (no own open chain → no pasteable label)', () => {
    const theDelta = delta();
    assert.deepEqual(decide([theDelta]), {
      refusals: [`bookkeeping-delta at docs/notes.md: no satisfying re-attestation — a SUBSEQUENT chain refresh must bind {refreshedRecord: ${short(canonicalFlowDigest(theDelta))}, fingerprintBefore: ${short(theDelta.fingerprintAfter)}}; an earlier or fingerprint-mismatched record never satisfies. recovery: no own OPEN chain can carry the re-attestation yet — open the owning plan's step round, then mint the refresh binding --refreshed-record=${canonicalFlowDigest(theDelta)}`],
      advisories: [],
    });
  });

  it("a superseded same-key delta never demands re-attestation — supersession is the store's own recovery valve", () => {
    const first = delta();
    const second = delta({ timestamp: TS(9) });
    const d = decide([first, second]);
    const deltaRefusals = d.refusals.filter((r) => r.includes('no satisfying re-attestation'));
    assert.equal(deltaRefusals.length, 1, 'only the AUTHORITATIVE delta carries the obligation');
    assert.ok(deltaRefusals[0].includes(canonicalFlowDigest(second)), 'the printed recovery references the authoritative digest');
    assert.ok(!deltaRefusals[0].includes(canonicalFlowDigest(first)), 'the superseded digest is never demanded — the refresh preflight refuses it, so demanding it would be unrecoverably red');
  });

  it('with an own OPEN chain the delta recovery is a concrete pasteable refresh command naming that chain', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const theDelta = delta();
    const d = decide([first, step1, theDelta]);
    const deltaRefusal = d.refusals.find((r) => r.includes('no satisfying re-attestation'));
    assert.ok(deltaRefusal.includes(`recovery (pasteable; choose the chain whose refresh cap this consumes, #61): node ${q(WRITER_TOOL)} refresh --cause='bookkeeping delta re-attestation' --refreshed-record=${canonicalFlowDigest(theDelta)} -- ${q('plan-a')}`), `the recovery names the own open chain with the FULL digest; got: ${deltaRefusal}`);
  });

  it('the degrade-ordering refusal is pinned byte-exact', () => {
    assert.deepEqual(decide([], { core: [coreStart(FP, 'a1', 1), coreDegrade(FP, 2), coreFinal('a1', FP, 3)] }), {
      refusals: [`a core degrade (backend "agy") landed AFTER a final-start at its fingerprint (${short(FP)}) with no later completed re-run at it — degrades mint strictly BEFORE the final run (#64); re-run run-gates.mjs --final on this tree`],
      advisories: [],
    });
  });
});

describe('flow-check — delta-chain classification + cap attribution (#61, Step 1.1)', () => {
  const DECLARED = ['docs/notes.md', 'docs/summary.md'];
  const delta2 = () => delta({
    fingerprintBefore: D('ab'), fingerprintAfter: D('ac'), path: 'docs/summary.md',
    custodyProof: { ...delta().custodyProof, maskedFingerprint: D('ab') }, timestamp: TS(1),
  });
  const chainB = () => {
    const first = adoption({ planId: 'plan-b', timestamp: TS(0) });
    return [first, opener(canonicalFlowDigest(first), { planId: 'plan-b', timestamp: TS(1) })];
  };
  const reattest = (theDelta, over = {}) => refresh(canonicalFlowDigest(theDelta), {
    planId: 'plan-b', fingerprintBefore: theDelta.fingerprintAfter, fingerprintAfter: theDelta.fingerprintAfter, timestamp: TS(4), ...over,
  });
  const classify = (records, over = {}) => classifyDeltaChain({
    records, fromFingerprint: D('aa'), toFingerprint: D('ac'), declaredPaths: DECLARED, refreshCap: 3, ...over,
  });

  it('an unbroken declared-path delta chain classifies CURRENT, each link re-attested by a chain refresh', () => {
    const d1 = delta();
    const d2 = delta2();
    const c = classify(recordsOf([...chainB(), d1, d2, reattest(d1), reattest(d2, { timestamp: TS(5) })]));
    assert.equal(c.classification, 'current');
    assert.equal(c.links.length, 2);
    assert.deepEqual(c.attribution, [{ planId: 'plan-b', cycle: 1, links: 2, refreshes: 2 }]);
  });

  it('an equal from/to fingerprint classifies CURRENT with an empty chain', () => {
    const c = classify([], { toFingerprint: D('aa') });
    assert.equal(c.classification, 'current');
    assert.deepEqual(c.links, []);
    assert.deepEqual(c.attribution, []);
  });

  it('a gap in the delta chain refuses — classification never bridges a missing link (fail closed)', () => {
    const d1 = delta();
    const c = classify(recordsOf([...chainB(), d1, reattest(d1)]));
    assert.equal(c.classification, 'refused');
    assert.match(c.reason, /no bookkeeping-delta continues the chain/);
    assert.match(c.reason, new RegExp(short(D('ab'))));
  });

  it('a fork — two authoritative deltas leaving one fingerprint — refuses by name', () => {
    const d1 = delta();
    const forked = delta({ fingerprintAfter: D('ac'), path: 'docs/summary.md' });
    const c = classify(recordsOf([...chainB(), d1, forked, reattest(d1), reattest(forked, { timestamp: TS(5) })]), { toFingerprint: D('ab') });
    assert.equal(c.classification, 'refused');
    assert.match(c.reason, /fork/);
  });

  it('an undeclared-path delta never enters the chain — the refusal names the path (fail closed)', () => {
    const stray = delta({ path: 'src/code.mjs' });
    const c = classify(recordsOf([...chainB(), stray, reattest(stray)]), { toFingerprint: D('ab') });
    assert.equal(c.classification, 'refused');
    assert.match(c.reason, /src\/code\.mjs/);
    assert.match(c.reason, /DECLARED bookkeeping path/);
  });

  it('a link with no satisfying re-attestation refuses — a mismatched refresh never carries the chain', () => {
    const d1 = delta();
    const unattested = classify(recordsOf([...chainB(), d1]), { toFingerprint: D('ab') });
    assert.equal(unattested.classification, 'refused');
    assert.match(unattested.reason, /re-attestation/);
    const mismatched = classify(recordsOf([...chainB(), d1, reattest(d1, { fingerprintBefore: D('77'), fingerprintAfter: D('77') })]), { toFingerprint: D('ab') });
    assert.equal(mismatched.classification, 'refused');
  });

  it('a delta cycle refuses — the walk never loops (fail closed)', () => {
    const d1 = delta();
    const back = delta({ fingerprintBefore: D('ab'), fingerprintAfter: D('aa'), custodyProof: { ...delta().custodyProof, maskedFingerprint: D('ab') }, timestamp: TS(1) });
    const c = classify(recordsOf([...chainB(), d1, back, reattest(d1), reattest(back, { timestamp: TS(5) })]), { toFingerprint: D('ff') });
    assert.equal(c.classification, 'refused');
    assert.match(c.reason, /cycle|revisit/i);
  });

  it("cap attribution lands on the refresh record's own chain, never the delta's neighborhood", () => {
    const d1 = delta();
    const c = classify(recordsOf([adoption({ timestamp: TS(0) }), ...chainB(), d1, reattest(d1)]), { toFingerprint: D('ab') });
    assert.equal(c.classification, 'current');
    assert.deepEqual(c.attribution, [{ planId: 'plan-b', cycle: 1, links: 1, refreshes: 1 }]);
  });

  it('cap exhaustion classifies as ESCALATION, never a silent pass (#45)', () => {
    const d1 = delta();
    const c = classify(recordsOf([...chainB(), d1, reattest(d1, { timestamp: TS(3) }), reattest(d1, { timestamp: TS(4) })]), { toFingerprint: D('ab'), refreshCap: 1 });
    assert.equal(c.classification, 'escalation');
    assert.match(c.reason, /plan-b/);
    assert.match(c.reason, /cap/);
  });

  it('a non-positive-integer cap input refuses — the cap arrives as an input, never a guess (#45)', () => {
    const c = classify([], { refreshCap: 0 });
    assert.equal(c.classification, 'refused');
    assert.match(c.reason, /cap/);
  });
});

describe('flow-check — maintainer-override evaluation (#56/#38/#48, Step 1.2)', () => {
  const veto = receipt('codex', 'revise', FP);
  const tree = { base: BASE, fingerprint: FP };
  const armed = () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    return { first, step1, chainDigest: canonicalFlowDigest(step1) };
  };

  it('an unarmed flow leaves the override arm inert — the veto stands', () => {
    const o = override(veto);
    const d = evaluateVetoOverride({ records: recordsOf([o]), vetoReceipt: veto, tree });
    assert.equal(d.lifted, false);
    assert.match(d.reason, /unarmed/);
  });

  it('a standing veto with no override never lifts — degradation never lifts a veto (#48)', () => {
    const { first, step1 } = armed();
    const d = evaluateVetoOverride({ records: recordsOf([first, step1, downMark('codex')]), vetoReceipt: veto, tree });
    assert.equal(d.lifted, false);
    assert.match(d.reason, /degradation never lifts/);
  });

  it('lifting requires the FULL bound set — each field mismatch refuses by name', () => {
    const { first, step1, chainDigest } = armed();
    const strayMark = downMark('codex');
    const orphanRound = opener(D('0d'), { planId: 'plan-c', timestamp: TS(2) });
    const cases = [
      [{ backend: 'agy' }, /backend/, []],
      [{ verdict: 'rework' }, /verdict/, []],
      [{ base: BASE2 }, /base/, []],
      [{ fingerprint: F2 }, /fingerprint/, []],
      [{ chainRecord: D('99') }, /chainRecord/, []],
      [{ chainRecord: canonicalFlowDigest(strayMark) }, /chainRecord/, [strayMark]],
      [{ chainRecord: canonicalFlowDigest(orphanRound) }, /chainRecord/, [orphanRound]],
    ];
    for (const [bad, re, extra] of cases) {
      const o = override(veto, { chainRecord: chainDigest, ...bad });
      const d = evaluateVetoOverride({ records: recordsOf([first, step1, ...extra, o]), vetoReceipt: veto, tree });
      assert.equal(d.lifted, false, JSON.stringify(bad));
      assert.match(d.reason, re, JSON.stringify(bad));
    }
  });

  it('a superseded override never lifts — only the head of the veto instance is consulted', () => {
    const { first, step1, chainDigest } = armed();
    const good = override(veto, { chainRecord: chainDigest });
    const worse = override(veto, { chainRecord: chainDigest, verdict: 'rework', supersedes: canonicalFlowDigest(good), timestamp: TS(8) });
    const d = evaluateVetoOverride({ records: recordsOf([first, step1, good, worse]), vetoReceipt: veto, tree });
    assert.equal(d.lifted, false);
    assert.match(d.reason, /verdict/);
  });

  it('a matching head lifts exactly its veto instance and carries the durable label', () => {
    const { first, step1, chainDigest } = armed();
    const other = receipt('agy', 'rethink', FP);
    const o = override(veto, { chainRecord: chainDigest });
    const records = recordsOf([first, step1, o]);
    const lifted = evaluateVetoOverride({ records, vetoReceipt: veto, tree });
    assert.equal(lifted.lifted, true);
    assert.equal(lifted.label, `veto lifted by maintainer-override ${short(canonicalFlowDigest(o))} — backend "codex" verdict "revise" (checkpoint-approved, #38/#56)`);
    const stands = evaluateVetoOverride({ records, vetoReceipt: other, tree });
    assert.equal(stands.lifted, false);
  });
});

describe('flow-check — unanswered-red-on-base rung (#65, Step 1.3)', () => {
  const armedAt = (fp, over = {}) => chainRec('freeze', { fingerprint: fp, timestamp: TS(2), ...over });
  const ownChain = () => {
    const first = adoption();
    return [first, opener(canonicalFlowDigest(first), { timestamp: TS(1) })];
  };
  const rung = (flowRecords, coreRecords, currentBase = BASE, owner = 'main') =>
    collectUnansweredRedRefusals({ flowRecords, coreRecords, currentBase, owner });

  it('the rung is scoped to ARMED flows — a foreign-owner adoption never fires it for this tree', () => {
    assert.deepEqual(rung([], coreOf([coreRedFinal('a1', FP, 1)])), []);
    assert.deepEqual(rung(recordsOf([adoption({ owner: 'worktree:elsewhere' })]), coreOf([coreRedFinal('a1', FP, 1)])), []);
  });

  it('a red final buried by a scratch-file fingerprint move still refuses on the same base', () => {
    const refusals = rung(recordsOf(ownChain()), coreOf([coreRedFinal('a1', FP, 1)]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /red final \(attempt "a1"\) on the CURRENT base/);
    assert.match(refusals[0], /rerun-cause/);
    assert.match(refusals[0], /recovery \(edit the quoted cause, then paste; mint on the RETRY tree\)/, 'a command carrying a placeholder is never labeled plainly pasteable');
    assert.match(refusals[0], /--attempt='a1'/);
  });

  it('a rerun-cause clears exactly one confirmed completed retry', () => {
    const flow = recordsOf([...ownChain(), armedAt(F2), rerunCause('a1', F2)]);
    const core = coreOf([coreRedFinal('a1', FP, 1), coreStart(F2, 'a2', 2), coreFinal('a2', F2, 3)]);
    assert.deepEqual(rung(flow, core), []);
  });

  it('a second red after the cleared retry refuses', () => {
    const flow = recordsOf([...ownChain(), armedAt(F2), rerunCause('a1', F2)]);
    const core = coreOf([coreRedFinal('a1', FP, 1), coreFinal('a2', F2, 2), coreRedFinal('a3', F2, 3)]);
    const refusals = rung(flow, core);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /attempt "a3"/);
  });

  it('one rerun-cause never answers a foreign red — each red needs its own cause naming its attempt', () => {
    const flow = recordsOf([...ownChain(), armedAt(F2), rerunCause('a1', F2)]);
    const core = coreOf([coreRedFinal('a1', FP, 1), coreRedFinal('a3', FP, 2), coreFinal('a4', F2, 3)]);
    const refusals = rung(flow, core);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /attempt "a3"/);
  });

  it('an uncleared retry never answers — the red refuses without a matching rerun-cause', () => {
    const flow = recordsOf([...ownChain(), armedAt(F2)]);
    const core = coreOf([coreRedFinal('a1', FP, 1), coreFinal('a2', F2, 2)]);
    const refusals = rung(flow, core);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /attempt "a1"/);
  });

  it('the help text names the armed base-motion arm', () => {
    const probe = spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.match(probe.stdout, /base motion/);
  });

  it('a replayed retry attempt never stretches its rerun-cause — only the FIRST completion is cleared', () => {
    const flow = recordsOf([...ownChain(), armedAt(F2), rerunCause('a1', F2)]);
    const core = coreOf([coreRedFinal('a1', FP, 1), coreFinal('a2', F2, 2), coreRedFinal('a3', F2, 3), coreFinal('a2', F2, 4)]);
    const refusals = rung(flow, core);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /attempt "a3"/);
  });

  it('the zero-base correlation lane refuses by name', () => {
    const refusals = rung(recordsOf(ownChain()), coreOf([coreRedFinal('a1', F2, 1)]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /no flow record carries its tree fingerprint/);
  });

  it('the multi-base correlation lane refuses by name', () => {
    const flow = recordsOf([...ownChain(), armedAt(FP, { base: BASE2, timestamp: TS(3) })]);
    const refusals = rung(flow, coreOf([coreRedFinal('a1', FP, 1)]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /distinct bases/);
  });

  it('a red resolved to a NON-current base never fires the rung — base motion is the other lane', () => {
    assert.deepEqual(rung(recordsOf(ownChain()), coreOf([coreRedFinal('a1', FP, 1)]), BASE2), []);
  });
});

describe('flow-check — base-intersection classification + decide wiring (#62/#21, Step 1.4)', () => {
  const ok = (paths) => ({ ok: true, paths });
  const motionInput = (over = {}) => ({
    currentBase: BASE2,
    resolveBaseDelta: () => ok(['docs/queue.md']),
    resolveChangedSurface: () => ok(['tools/flow-check.mjs']),
    ...over,
  });
  const openOwn = () => {
    const first = adoption();
    return [first, opener(canonicalFlowDigest(first), { timestamp: TS(1) })];
  };

  it('a disjoint base delta classifies re-baseline-sufficient', () => {
    const c = classifyBaseMotion({ baseDelta: ok(['docs/queue.md']), changedSurface: ok(['tools/flow-check.mjs']) });
    assert.deepEqual(c, { motion: 'disjoint', requires: 're-baseline' });
  });

  it('an intersecting base delta classifies refresh-REQUIRED', () => {
    const c = classifyBaseMotion({ baseDelta: ok(['tools/flow-check.mjs', 'docs/queue.md']), changedSurface: ok(['tools/flow-check.mjs']) });
    assert.equal(c.motion, 'intersecting');
    assert.equal(c.requires, 'refresh');
    assert.equal(c.witness, 'tools/flow-check.mjs');
  });

  it('a base delta touching ONLY a test file is still an intersection — the all-path lane never excludes tests', () => {
    const c = classifyBaseMotion({ baseDelta: ok(['tools/x.test.mjs']), changedSurface: ok(['tools/x.test.mjs']) });
    assert.equal(c.motion, 'intersecting');
  });

  it('an undecidable surface fails closed — refresh is REQUIRED and the reason says why', () => {
    const c = classifyBaseMotion({ baseDelta: { ok: false, reason: 'unknown object' }, changedSurface: ok([]) });
    assert.equal(c.motion, 'undecidable');
    assert.equal(c.requires, 'refresh');
    assert.match(c.reason, /unknown object/);
    const s = classifyBaseMotion({ baseDelta: ok([]), changedSurface: { ok: false, reason: 'no surface' } });
    assert.equal(s.motion, 'undecidable');
    assert.equal(s.requires, 'refresh');
  });

  it('computeAllPathBaseDelta includes test files and fails closed on an unknown or null sha', () => {
    const root = makeRepo();
    const from = sh(['rev-parse', 'HEAD'], root).trim();
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(join(root, 'tools', 'x.test.mjs'), 'export {};\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'add a test file'], root);
    const to = sh(['rev-parse', 'HEAD'], root).trim();
    assert.deepEqual(computeAllPathBaseDelta(root, from, to), { ok: true, paths: ['tools/x.test.mjs'] });
    assert.equal(computeAllPathBaseDelta(root, 'de'.repeat(20), to).ok, false);
    assert.equal(computeAllPathBaseDelta(root, null, to).ok, false);
  });

  it('computeAllPathWorktreeSurface includes tracked changes, untracked files and test files; a non-repo fails closed', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'base.txt'), 'changed\n');
    writeFileSync(join(root, 'notes.test.mjs'), 'export {};\n');
    const s = computeAllPathWorktreeSurface(root);
    assert.equal(s.ok, true);
    assert.deepEqual([...s.paths].sort(), ['base.txt', 'notes.test.mjs']);
    const dir = join(TMP, 'no-repo-surface');
    mkdirSync(dir, { recursive: true });
    assert.equal(computeAllPathWorktreeSurface(dir).ok, false);
  });

  it('decideFlowCheck refuses an own OPEN chain on a moved base and names the missing record class', () => {
    const disjoint = decide(openOwn(), { motion: motionInput() });
    const moved = disjoint.refusals.filter((r) => /base moved under the armed chain/.test(r));
    assert.equal(moved.length, 1);
    assert.match(moved[0], /re-baseline record/);
    assert.ok(moved[0].includes(`recovery (pasteable): node ${q(WRITER_TOOL)} re-baseline -- ${q('plan-a')}`), 'the disjoint recovery is the concrete re-baseline command');
    const chain = openOwn();
    const intersecting = decide(chain, { motion: motionInput({ resolveChangedSurface: () => ok(['docs/queue.md']) }) });
    const need = intersecting.refusals.find((r) => /base moved/.test(r));
    assert.match(need, /refresh dispatch is REQUIRED/);
    assert.ok(need.includes(`--refreshed-record=${canonicalFlowDigest(chain[1])} -- ${q('plan-a')}`), `the refresh recovery binds the chain tail's FULL digest — no placeholder under a pasteable label; got: ${need}`);
    const undecidable = decide(openOwn(), { motion: motionInput({ resolveBaseDelta: () => ({ ok: false, reason: 'object missing' }) }) });
    assert.match(undecidable.refusals.find((r) => /base moved/.test(r)), /refresh dispatch is REQUIRED/);
  });

  it("a landed re-baseline record ends the refusal — the chain's recorded base reaches the current base", () => {
    const rebased = chainRec('re-baseline', { base: BASE2, baseBefore: BASE, fingerprint: F2, timestamp: TS(2) });
    const d = decide([...openOwn(), rebased], { motion: motionInput() });
    assert.equal(d.refusals.filter((r) => /base moved/.test(r)).length, 0);
    assert.equal(d.refusals.length, 1, 'the OPEN-chain refusal alone remains');
  });

  it('base motion on a PARKED or foreign chain never fires the arm', () => {
    const parked = decide([...openOwn(), chainRec('park', { stepId: null, timestamp: TS(2) })], { motion: motionInput() });
    assert.deepEqual(parked.refusals, []);
    const first = adoption({ owner: 'worktree:elsewhere' });
    const foreign = decide([first, opener(canonicalFlowDigest(first), { owner: 'worktree:elsewhere', timestamp: TS(1) })], { motion: motionInput() });
    assert.deepEqual(foreign.refusals, []);
    assert.equal(foreign.advisories.length, 1);
  });

  it('without a motion input the decision stays byte-exact — the arm is optional and inert (unarmed neutrality)', () => {
    assert.deepEqual(decide([], { motion: motionInput() }), { refusals: [], advisories: [] });
  });
});

describe('flow-check — exact-coverage rungs (#42/#25/#39, Step 1.5)', () => {
  const tree = { base: BASE, fingerprint: FP };
  const armed = () => [adoption()];
  const theDegrade = coreDegrade(FP, 3);
  const mark = downMark('agy');
  const covered = () => [...armed(), mark, justification(mark, theDegrade)];
  const degradeRung = (flowRecords, coreRecords, over = {}) =>
    collectDegradeCoverageRefusals({ flowRecords, coreRecords, tree, owner: 'main', backends: ['agy'], ...over });
  const receiptRung = (flowRecords, receipts, over = {}) =>
    collectReceiptCoverageRefusals({ flowRecords, receipts, tree, owner: 'main', backends: ['codex'], ...over });

  it('a covered degrade passes — the justification binds {downMark, degradeDigest, base} on a then-unexpired mark', () => {
    assert.deepEqual(degradeRung(recordsOf(covered()), coreOf([theDegrade])), []);
  });

  it('an uncovered degrade refuses by backend name', () => {
    const refusals = degradeRung(recordsOf(armed()), coreOf([theDegrade]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /backend "agy"/);
  });

  it('an expired-at-mint mark refuses', () => {
    const late = justification(mark, theDegrade, { timestamp: TS(31) });
    const refusals = degradeRung(recordsOf([...armed(), mark, late]), coreOf([theDegrade]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /active window|expired/);
  });

  it('an unparseable justification instant refuses by name', () => {
    const fuzzy = justification(mark, theDegrade, { timestamp: 'around noon' });
    const refusals = degradeRung(recordsOf([...armed(), mark, fuzzy]), coreOf([theDegrade]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /canonical UTC ISO instant/);
    assert.match(refusals[0], /around noon/);
  });

  it('a mark closed by up/clear before the justification minted refuses', () => {
    const closed = [...armed(), mark, markClear(canonicalFlowDigest(mark), 'agy'), justification(mark, theDegrade)];
    const refusals = degradeRung(recordsOf(closed), coreOf([theDegrade]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /closed/);
  });

  it("a justification riding another backend's mark refuses", () => {
    const foreignMark = downMark('codex');
    const refusals = degradeRung(recordsOf([...armed(), foreignMark, justification(foreignMark, theDegrade)]), coreOf([theDegrade]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /backend/);
  });

  it('a justification minted on another base refuses — the binding includes base', () => {
    const offBase = justification(mark, theDegrade, { base: BASE2 });
    const refusals = degradeRung(recordsOf([...armed(), mark, offBase]), coreOf([theDegrade]));
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /base/);
  });

  it('a relied-on receipt bound by a round dispatch-ledger entry passes; a stale receipt needs no binding', () => {
    const rec = receipt('codex', 'ship', FP);
    const entry = { backend: 'codex', dispatchBase: BASE, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: canonicalFlowDigest(rec), findingManifestDigest: D('fe') };
    const first = adoption();
    const round = opener(canonicalFlowDigest(first), { dispatches: [entry], timestamp: TS(1) });
    assert.deepEqual(receiptRung(recordsOf([first, round]), [rec]), []);
    assert.deepEqual(receiptRung(recordsOf([first, round]), [receipt('codex', 'ship', F3)]), []);
  });

  it('an uncovered receipt refuses — an unbound receipt never satisfies an armed flow', () => {
    const refusals = receiptRung(recordsOf(armed()), [receipt('codex', 'ship', FP)]);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /backend "codex"/);
    assert.match(refusals[0], /unbound receipt/);
  });

  it("a foreign worktree's round never covers this tree's receipt", () => {
    const rec = receipt('codex', 'ship', FP);
    const entry = { backend: 'codex', dispatchBase: BASE, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: canonicalFlowDigest(rec), findingManifestDigest: D('fe') };
    const foreignFirst = adoption({ planId: 'plan-b', owner: 'worktree:elsewhere' });
    const foreignRound = opener(canonicalFlowDigest(foreignFirst), { planId: 'plan-b', owner: 'worktree:elsewhere', dispatches: [entry], timestamp: TS(1) });
    const refusals = receiptRung(recordsOf([...armed(), foreignFirst, foreignRound]), [rec]);
    assert.equal(refusals.length, 1);
  });

  it('the rungs are scoped to ARMED flows — an unarmed store never fires either', () => {
    assert.deepEqual(degradeRung([], coreOf([theDegrade])), []);
    assert.deepEqual(receiptRung([], [receipt('codex', 'ship', FP)]), []);
  });

  it('wall-clock never enters either decision — Date.now is poisoned during the check (#39)', () => {
    const rec = receipt('codex', 'ship', FP);
    const entry = { backend: 'codex', dispatchBase: BASE, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: canonicalFlowDigest(rec), findingManifestDigest: D('fe') };
    const first = adoption();
    const round = opener(canonicalFlowDigest(first), { dispatches: [entry], timestamp: TS(1) });
    const flow = recordsOf([first, round, mark, justification(mark, theDegrade)]);
    const core = coreOf([theDegrade]);
    const originalNow = Date.now;
    Date.now = () => { throw new Error('wall-clock consulted at decide time'); };
    try {
      assert.deepEqual(degradeRung(flow, core), []);
      assert.deepEqual(receiptRung(flow, [rec]), []);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('flow-check — round-1 fold regressions (base-transition classes + helper hardening)', () => {
  const ok = (paths) => ({ ok: true, paths });
  const motion = (over = {}) => ({
    currentBase: BASE2,
    resolveBaseDelta: () => ok(['docs/queue.md']),
    resolveChangedSurface: () => ok(['tools/flow-check.mjs']),
    ...over,
  });
  const intersectingMotion = () => motion({ resolveBaseDelta: () => ok(['tools/flow-check.mjs']) });
  const openAt = () => {
    const first = adoption();
    return [first, opener(canonicalFlowDigest(first), { timestamp: TS(1) })];
  };
  const movedRefusals = (d) => d.refusals.filter((r) => /mid-step base transition|baseBefore/.test(r));

  it('a mid-step re-baseline answering an INTERSECTING delta refuses naming the refresh record', () => {
    const rebased = chainRec('re-baseline', { base: BASE2, baseBefore: BASE, fingerprint: F2, timestamp: TS(2) });
    const d = decide([...openAt(), rebased], { motion: intersectingMotion() });
    const moved = movedRefusals(d);
    assert.equal(moved.length, 1);
    assert.match(moved[0], /requires a refresh record/);
  });

  it('a refresh answering a PROVEN-disjoint delta refuses naming the re-baseline record', () => {
    const chain = openAt();
    const movedRefresh = refresh(canonicalFlowDigest(chain[0]), { base: BASE2, fingerprintBefore: FP, fingerprintAfter: F2, timestamp: TS(2) });
    const d = decide([...chain, movedRefresh], { motion: motion() });
    const found = movedRefusals(d);
    assert.equal(found.length, 1);
    assert.match(found[0], /requires a re-baseline record/);
  });

  it('a converged record landing a new base refuses — a terminal never hides base motion', () => {
    const d = decide([...openAt(), chainRec('converged', { base: BASE2, fingerprint: F2, timestamp: TS(2) })], { motion: intersectingMotion() });
    assert.equal(d.refusals.length, 1, 'the converged chain otherwise passes — the transition refusal stands alone');
    assert.match(d.refusals[0], /mid-step base transition/);
  });

  it('a mid-step park landing a new base refuses', () => {
    const d = decide([...openAt(), chainRec('park', { stepId: null, base: BASE2, fingerprint: F2, timestamp: TS(2) })], { motion: intersectingMotion() });
    assert.equal(d.refusals.length, 1, 'the parked chain otherwise passes');
    assert.match(d.refusals[0], /mid-step base transition/);
  });

  it("a re-baseline whose baseBefore mismatches the previous record's base refuses", () => {
    const rebased = chainRec('re-baseline', { base: BASE2, baseBefore: D('fe'), fingerprint: F2, timestamp: TS(2) });
    const d = decide([...openAt(), rebased], { motion: motion() });
    const moved = movedRefusals(d);
    assert.equal(moved.length, 1);
    assert.match(moved[0], /baseBefore/);
  });

  it('a disjoint mid-step re-baseline with the true baseBefore passes the motion arm', () => {
    const rebased = chainRec('re-baseline', { base: BASE2, baseBefore: BASE, fingerprint: F2, timestamp: TS(2) });
    const d = decide([...openAt(), rebased], { motion: motion() });
    assert.deepEqual(movedRefusals(d), []);
    assert.equal(d.refusals.length, 1, 'only the OPEN-chain refusal remains');
  });

  it('boundary and park/resume transitions stay exempt — the scan judges only the last segment', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const converged1 = chainRec('converged', { timestamp: TS(2) });
    const boundaryRebase = chainRec('re-baseline', { base: BASE2, baseBefore: BASE, fingerprint: F2, timestamp: TS(3) });
    const step2 = opener(canonicalFlowDigest(converged1), { stepId: 'step-2', base: BASE2, fingerprint: F2, commitEpoch: 1, timestamp: TS(4) });
    const d = decide([first, step1, converged1, boundaryRebase, step2], { motion: motion() });
    assert.equal(d.refusals.length, 1, 'only the OPEN-chain refusal of step-2');
    assert.match(d.refusals[0], /OPEN chain/);
  });

  it('a down-mark appended AFTER the justification never covers — resolution is prefix-scoped', () => {
    const theDegrade = coreDegrade(FP, 3);
    const mark = downMark('agy');
    const flow = recordsOf([adoption(), justification(mark, theDegrade), mark]);
    const refusals = collectDegradeCoverageRefusals({ flowRecords: flow, coreRecords: coreOf([theDegrade]), tree: { base: BASE, fingerprint: FP }, owner: 'main', backends: ['agy'] });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /does not ride a down-mark/);
  });

  it('the helpers resolve the repository toplevel — a nested cwd sees the whole tree with root-relative paths', () => {
    const root = makeRepo();
    const from = sh(['rev-parse', 'HEAD'], root).trim();
    writeFileSync(join(root, 'inner.txt'), 'inner\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'second'], root);
    const to = sh(['rev-parse', 'HEAD'], root).trim();
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, 'outside.test.mjs'), 'export {};\n');
    writeFileSync(join(root, 'base.txt'), 'changed\n');
    assert.deepEqual(computeAllPathWorktreeSurface(sub), computeAllPathWorktreeSurface(root));
    assert.deepEqual([...computeAllPathWorktreeSurface(sub).paths].sort(), ['base.txt', 'outside.test.mjs']);
    assert.deepEqual(computeAllPathBaseDelta(sub, from, to), computeAllPathBaseDelta(root, from, to));
    assert.deepEqual(computeAllPathBaseDelta(sub, from, to).paths, ['inner.txt']);
  });

  it('a suppressed submodule delta is still seen — diff.ignoreSubmodules=all never hides a gitlink', () => {
    const root = makeRepo();
    sh(['update-index', '--add', '--cacheinfo', `160000,${'a1'.repeat(20)},sub`], root);
    sh(['commit', '-q', '-m', 'gitlink'], root);
    const from = sh(['rev-parse', 'HEAD'], root).trim();
    sh(['update-index', '--add', '--cacheinfo', `160000,${'b2'.repeat(20)},sub`], root);
    sh(['commit', '-q', '-m', 'gitlink bump'], root);
    const to = sh(['rev-parse', 'HEAD'], root).trim();
    sh(['config', 'diff.ignoreSubmodules', 'all'], root);
    assert.deepEqual(computeAllPathBaseDelta(root, from, to), { ok: true, paths: ['sub'] });
    sh(['update-index', '--add', '--cacheinfo', `160000,${'c3'.repeat(20)},sub`], root);
    const surface = computeAllPathWorktreeSurface(root);
    assert.equal(surface.ok, true);
    assert.deepEqual(surface.paths, ['sub']);
  });
});

describe('flow-check — round-2 fold regressions (projection, prefix scoping, candidate coverage)', () => {
  const ok = (paths) => ({ ok: true, paths });
  const motion = (over = {}) => ({
    currentBase: BASE2,
    resolveBaseDelta: () => ok(['docs/queue.md']),
    resolveChangedSurface: () => ok(['tools/flow-check.mjs']),
    ...over,
  });
  const intersectingMotion = () => motion({ resolveBaseDelta: () => ok(['tools/flow-check.mjs']) });
  const openAt = () => {
    const first = adoption();
    return [first, opener(canonicalFlowDigest(first), { timestamp: TS(1) })];
  };
  const revisionOf = (op) => ({
    ...op,
    dispatches: [{ backend: 'codex', dispatchBase: op.base, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: null, findingManifestDigest: null }],
    timestamp: TS(9),
  });

  it('a round ledger revision never resets the motion scan — the projection keeps lifecycle order', () => {
    const [first, op] = openAt();
    const rebased = chainRec('re-baseline', { base: BASE2, baseBefore: BASE, fingerprint: F2, timestamp: TS(2) });
    const d = decide([first, op, rebased, revisionOf(op)], { motion: motion() });
    assert.equal(d.refusals.filter((r) => /mid-step base transition|base moved/.test(r)).length, 0);
    assert.equal(d.refusals.length, 1, 'only the OPEN-chain refusal remains');
  });

  it('a wrong-class transition never hides behind a same-index round revision', () => {
    const [first, op] = openAt();
    const movedRefresh = refresh(canonicalFlowDigest(first), { base: BASE2, fingerprintBefore: FP, fingerprintAfter: F2, timestamp: TS(2) });
    const d = decide([first, op, movedRefresh, revisionOf(op)], { motion: motion() });
    const classRefusal = d.refusals.find((r) => /mid-step base transition/.test(r));
    assert.ok(classRefusal, 'the class refusal must survive the revision');
    assert.match(classRefusal, /requires a re-baseline record/);
  });

  it('an override recorded before its adoption or chain record never lifts — forward references refuse', () => {
    const veto = receipt('codex', 'revise', FP);
    const tree = { base: BASE, fingerprint: FP };
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const o = override(veto, { chainRecord: canonicalFlowDigest(step1) });
    const beforeAll = evaluateVetoOverride({ records: recordsOf([o, first, step1]), vetoReceipt: veto, tree });
    assert.equal(beforeAll.lifted, false);
    assert.match(beforeAll.reason, /unarmed/);
    const beforeTarget = evaluateVetoOverride({ records: recordsOf([first, o, step1]), vetoReceipt: veto, tree });
    assert.equal(beforeTarget.lifted, false);
    assert.match(beforeTarget.reason, /chainRecord/);
  });

  it('a stale off-base justification never masks a later valid one — any full match covers', () => {
    const theDegrade = coreDegrade(FP, 3);
    const oldMark = downMark('agy');
    const oldJust = justification(oldMark, theDegrade, { base: BASE2, timestamp: TS(5) });
    const newMark = downMark('agy', { timestamp: TS(7), expiresAt: TS(50) });
    const newJust = justification(newMark, theDegrade, { timestamp: TS(8) });
    const flow = recordsOf([adoption(), oldMark, oldJust, markClear(canonicalFlowDigest(oldMark), 'agy', { timestamp: TS(6) }), newMark, newJust]);
    const refusals = collectDegradeCoverageRefusals({ flowRecords: flow, coreRecords: coreOf([theDegrade]), tree: { base: BASE, fingerprint: FP }, owner: 'main', backends: ['agy'] });
    assert.deepEqual(refusals, []);
  });

  it('an intersecting transition with a wrong-baseBefore re-baseline names the required refresh class', () => {
    const [first, op] = openAt();
    const rebased = chainRec('re-baseline', { base: BASE2, baseBefore: D('fe'), fingerprint: F2, timestamp: TS(2) });
    const d = decide([first, op, rebased], { motion: intersectingMotion() });
    const classRefusal = d.refusals.find((r) => /mid-step base transition/.test(r));
    assert.ok(classRefusal, 'the class requirement outranks the baseBefore detail');
    assert.match(classRefusal, /requires a refresh record/);
  });

  it('a justification minted at another tree never covers — the fingerprint binding is exact', () => {
    const theDegrade = coreDegrade(FP, 3);
    const mark = downMark('agy');
    const offTree = justification(mark, theDegrade, { fingerprint: F2 });
    const refusals = collectDegradeCoverageRefusals({ flowRecords: recordsOf([adoption(), mark, offTree]), coreRecords: coreOf([theDegrade]), tree: { base: BASE, fingerprint: FP }, owner: 'main', backends: ['agy'] });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /minted at another tree/);
  });

  it('a reference-broken chain never grows a secondary base-motion recovery', () => {
    const first = adoption();
    const dangling = opener(D('9f'), { timestamp: TS(1) });
    const d = decide([first, dangling], { motion: motion() });
    assert.equal(d.refusals.length, 1, 'the reference refusal stands alone');
    assert.match(d.refusals[0], /does not match the store/);
  });

  it('an assume-unchanged entry poisons the worktree surface — flagged paths refuse loudly', () => {
    const root = makeRepo();
    sh(['update-index', '--assume-unchanged', 'base.txt'], root);
    const s = computeAllPathWorktreeSurface(root);
    assert.equal(s.ok, false);
    assert.match(s.reason, /base\.txt/);
    assert.match(s.reason, /assume-unchanged/);
  });

  it('a skip-worktree entry poisons the worktree surface — flagged paths refuse loudly', () => {
    const root = makeRepo();
    sh(['update-index', '--skip-worktree', 'base.txt'], root);
    const s = computeAllPathWorktreeSurface(root);
    assert.equal(s.ok, false);
    assert.match(s.reason, /base\.txt/);
    assert.match(s.reason, /skip-worktree/);
  });

  it('a degrade for a backend outside the relied-on set never demands coverage', () => {
    const theDegrade = coreDegrade(FP, 3);
    const refusals = collectDegradeCoverageRefusals({ flowRecords: recordsOf([adoption()]), coreRecords: coreOf([theDegrade]), tree: { base: BASE, fingerprint: FP }, owner: 'main', backends: ['codex'] });
    assert.deepEqual(refusals, []);
  });

  it('a receipt from a backend outside the relied-on set never demands binding', () => {
    const refusals = collectReceiptCoverageRefusals({ flowRecords: recordsOf([adoption()]), receipts: [receipt('codex', 'ship', FP)], tree: { base: BASE, fingerprint: FP }, owner: 'main', backends: ['agy'] });
    assert.deepEqual(refusals, []);
  });
});

// ── Phase 2 (flow Plan 3): computeFlowDecision — the two-tier presence + armed answer consumers read ──
import { computeFlowDecision, selectReliedOnReceipt } from './flow-check.mjs';

describe('flow-check — the relied-on selector spans the delta lift (#42/#61, round-3 folds)', () => {
  const DECLARED = ['docs/notes.md'];
  const liftedFixtures = () => {
    const first = adoption();
    const d = delta({ timestamp: TS(1) });
    const reattest = refresh(canonicalFlowDigest(d), { fingerprintBefore: d.fingerprintAfter, fingerprintAfter: d.fingerprintAfter, timestamp: TS(3) });
    const rec = receipt('codex', 'ship', D('aa'));
    const tree = { base: BASE, fingerprint: D('ab') };
    return { first, d, reattest, rec, tree };
  };

  it('an unbound delta-LIFTED receipt refuses — the lift never escapes #42', () => {
    const { first, d, reattest, rec, tree } = liftedFixtures();
    const refusals = collectReceiptCoverageRefusals({
      flowRecords: recordsOf([first, d, reattest]), receipts: [rec], tree, owner: 'main',
      backends: ['codex'], declaredPaths: DECLARED, refreshCap: 3,
    });
    assert.equal(refusals.length, 1, `the lifted receipt is relied on and must be ledger-bound: ${refusals}`);
    assert.match(refusals[0], /unbound receipt/);
  });

  it('a ledger-bound LIFTED receipt passes at its own fingerprint', () => {
    const { first, d, reattest, rec, tree } = liftedFixtures();
    const entry = { backend: 'codex', dispatchBase: BASE, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: canonicalFlowDigest(rec), findingManifestDigest: D('fe') };
    const round = opener(canonicalFlowDigest(first), { fingerprint: D('aa'), dispatches: [entry], timestamp: TS(2) });
    const refusals = collectReceiptCoverageRefusals({
      flowRecords: recordsOf([first, round, d, reattest]), receipts: [rec], tree, owner: 'main',
      backends: ['codex'], declaredPaths: DECLARED, refreshCap: 3,
    });
    assert.deepEqual(refusals, []);
    const selected = selectReliedOnReceipt({ receipts: [rec], backend: 'codex', tree, records: recordsOf([first, d, reattest]), declaredPaths: DECLARED, refreshCap: 3 });
    assert.equal(selected.receipt.fingerprint, D('aa'));
    assert.equal(selected.lifted, 1, 'the selector carries the lift metadata the PASS labels consume');
  });

  it('a dispatchBase mismatch never covers — the ledger binds the round base', () => {
    const rec = receipt('codex', 'ship', FP);
    const entry = { backend: 'codex', dispatchBase: BASE2, receiptWatermark: 0, dispatchNonce: 'n-1', receiptDigest: canonicalFlowDigest(rec), findingManifestDigest: D('fe') };
    const first = adoption();
    const round = opener(canonicalFlowDigest(first), { dispatches: [entry], timestamp: TS(1) });
    const refusals = collectReceiptCoverageRefusals({
      flowRecords: recordsOf([first, round]), receipts: [rec], tree: { base: BASE, fingerprint: FP }, owner: 'main', backends: ['codex'],
    });
    assert.equal(refusals.length, 1, 'a foreign-base ledger entry is no binding (P16)');
    assert.match(refusals[0], /unbound receipt/);
  });
});

describe('flow-check — computeFlowDecision (the guard-facing two-tier answer)', () => {
  it('absent store: present=false and the decision still runs over the core store', () => {
    const root = makeRepo();
    const d = computeFlowDecision({ cwd: root });
    assert.equal(d.present, false);
    assert.equal(d.owner, 'main');
    assert.deepEqual(d.refusals, []);
  });

  it('present-valid-unadopted: present=true, armed=false, no refusal', () => {
    const root = makeRepo();
    writeFileSync(resolveFlowStorePath(root, {}), '');
    const d = computeFlowDecision({ cwd: root });
    assert.equal(d.present, true);
    assert.equal(d.armed, false);
    assert.deepEqual(d.refusals, []);
  });

  it('present-malformed: refuses fail-closed', () => {
    const root = makeRepo();
    writeFileSync(resolveFlowStorePath(root, {}), 'junk line\n');
    const d = computeFlowDecision({ cwd: root });
    assert.equal(d.present, true);
    assert.equal(d.armed, false);
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /malformed/);
  });

  it('the evidence input composes the three Phase-1 rungs; absent evidence stays byte-identical', () => {
    const withoutEvidence = decideFlowCheck({ flowRead: flowReadOf([adoption()]), coreRead: coreReadOf([coreRedFinal('a1', FP, 1)]), owner: 'main' });
    assert.deepEqual(withoutEvidence, { refusals: [], advisories: [] }, 'no evidence input — the decision is byte-identical to Plan 2');
    const tree = { base: BASE, fingerprint: FP };
    const red = decideFlowCheck({ flowRead: flowReadOf([adoption()]), coreRead: coreReadOf([coreRedFinal('a1', FP, 1)]), owner: 'main', evidence: { receipts: [], tree, receiptBackends: [], degradeBackends: [] } });
    assert.ok(red.refusals.some((r) => /red final/.test(r) && /#65/.test(r)), `the unanswered-red rung composes: ${red.refusals}`);
    const degrade = decideFlowCheck({ flowRead: flowReadOf([adoption()]), coreRead: coreReadOf([coreDegrade(FP, 3)]), owner: 'main', evidence: { receipts: [], tree, receiptBackends: [], degradeBackends: ['agy'] } });
    assert.ok(degrade.refusals.some((r) => /backend "agy"/.test(r)), `the degrade-coverage rung composes: ${degrade.refusals}`);
    const rec = receipt('codex', 'ship', FP);
    const unbound = decideFlowCheck({ flowRead: flowReadOf([adoption()]), coreRead: coreReadOf([]), owner: 'main', evidence: { receipts: [rec], tree, receiptBackends: ['codex'], degradeBackends: [] } });
    assert.ok(unbound.refusals.some((r) => /unbound receipt/.test(r)), `the receipt-coverage rung composes: ${unbound.refusals}`);
    const strayDegrade = decideFlowCheck({ flowRead: flowReadOf([adoption()]), coreRead: coreReadOf([coreDegrade(FP, 3)]), owner: 'main', evidence: { receipts: [], tree, receiptBackends: ['agy'], degradeBackends: [] } });
    assert.deepEqual(strayDegrade.refusals, [], 'the split sets are independent — a stray degrade outside the degrade set never blocks');
  });

  it('the composed decision resolves the config at the git TOPLEVEL — a subdirectory invocation answers identically', () => {
    const root = makeRepo();
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), 'not json');
    const first = adoption();
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(first)}\n`);
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    const atRoot = computeFlowDecision({ cwd: root });
    const atSub = computeFlowDecision({ cwd: sub });
    assert.ok(atSub.refusals.some((r) => /relied-on backend set cannot be derived/.test(r)), `the subdir invocation must see the toplevel config failure: ${atSub.refusals}`);
    assert.deepEqual(atSub.refusals, atRoot.refusals, 'root and subdirectory answers are identical');
  });

  it('the CLI scopes semantic refusals to an ADOPTED store — an unattested delta on an unadopted store passes (P3 t2)', () => {
    const root = makeRepo();
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(delta())}\n`);
    const r = spawnSync(process.execPath, [TOOL, '--check'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /flow-check: PASS/);
  });

  it('present-armed: armed=true; an own open chain is a refusal, a foreign one an advisory', () => {
    const root = makeRepo();
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(first)}\n${JSON.stringify(step1)}\n`);
    const own = computeFlowDecision({ cwd: root });
    assert.equal(own.present, true);
    assert.equal(own.armed, true);
    assert.ok(own.refusals.some((r) => /OPEN chain owned by this worktree/.test(r)));
    const foreignFirst = adoption({ owner: 'worktree:elsewhere' });
    const foreignStep = opener(canonicalFlowDigest(foreignFirst), { owner: 'worktree:elsewhere', timestamp: TS(1) });
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(foreignFirst)}\n${JSON.stringify(foreignStep)}\n`);
    const foreign = computeFlowDecision({ cwd: root });
    assert.equal(foreign.armed, true);
    assert.deepEqual(foreign.refusals, []);
    assert.equal(foreign.advisories.length, 1);
  });
});

// The D10 consumer-mode split (Plan 4 Decision 2): the flow→final comparison runs ONLY on the
// commit-guard lane — the in-matrix flow-check gate stays inert, or during a final run the
// "latest final" (by construction the PREVIOUS one) would make a new green final unreachable.
describe('flow-check — the D10 consumer-mode split (Plan 4 Decision 2)', () => {
  const seedArmedRepo = () => {
    const root = makeRepo();
    const first = adoption();
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(first)}\n`);
    const fp = computeTreeFingerprint(root);
    return { root, first, fp };
  };
  const seedGreenFinal = (root, fp, over = {}) => {
    const green = { ...coreFinal('attempt-d10', fp, 1), ...over };
    writeFileSync(resolveEvidencePath(root, {}), `${JSON.stringify(green)}\n`);
    return green;
  };

  it('armed + a green final LACKING the field: the matrix lane stays INERT, the commit-guard lane refuses', () => {
    const { root, fp } = seedArmedRepo();
    seedGreenFinal(root, fp);
    const inert = computeFlowDecision({ cwd: root });
    assert.ok(!inert.refusals.some((r) => /evidenceHashes\.flow|flow store moved after/.test(r)), `the in-matrix lane never reads the binding: ${inert.refusals}`);
    const guard = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.ok(guard.refusals.some((r) => /NO evidenceHashes\.flow/.test(r) && /re-run run-gates\.mjs --final/.test(r)), `the commit-guard lane fails closed on a pre-upgrade final: ${guard.refusals}`);
  });

  it('a MATCHING bound hash passes the commit-guard lane; a store append then refuses with the tail hypothesis', () => {
    const { root, first, fp } = seedArmedRepo();
    seedGreenFinal(root, fp, { evidenceHashes: { redProof: D('aa'), degrade: D('bb'), flow: flowProjectionHash([first], { owner: 'main', currentFingerprint: fp }) } });
    const bound = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.ok(!bound.refusals.some((r) => /evidenceHashes\.flow|flow store moved after/.test(r)), `a matching binding never refuses: ${bound.refusals}`);
    const appended = rerunCause('post-final-1', fp);
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(first)}\n${JSON.stringify(appended)}\n`);
    const moved = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    const hit = moved.refusals.find((r) => /flow store moved after the final run/.test(r));
    assert.ok(hit, `the moved projection refuses on the commit-guard lane: ${moved.refusals}`);
    assert.match(hit, /DIAGNOSTIC hypothesis/);
    assert.match(hit, /rerun-cause record/, 'the live projection tail is named as the hypothesis');
    assert.ok(!computeFlowDecision({ cwd: root }).refusals.some((r) => /flow store moved after/.test(r)), 'the matrix lane stays inert on the moved projection too');
  });

  it('a RED latest final never reaches the hash comparison — the dead-green ordering decides first', () => {
    const { root, fp } = seedArmedRepo();
    seedGreenFinal(root, fp, { status: 'red', results: [{ id: 'g', ok: false, code: 1 }] });
    const guard = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.ok(!guard.refusals.some((r) => /evidenceHashes\.flow|flow store moved after/.test(r)), `the D10 arm binds GREEN finals only (the guard's own red arm refuses the red): ${guard.refusals}`);
  });

  it('deleting or truncating the flow store after a BOUND green final refuses on the commit-guard lane — disappearance is movement', () => {
    const { root, first, fp } = seedArmedRepo();
    seedGreenFinal(root, fp, { evidenceHashes: { redProof: D('aa'), degrade: D('bb'), flow: flowProjectionHash([first], { owner: 'main', currentFingerprint: fp }) } });
    const bound = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.ok(!bound.refusals.some((r) => /flow/.test(r)), `the bound receipt passes first: ${bound.refusals}`);
    rmSync(resolveFlowStorePath(root, {}));
    const gone = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.equal(gone.present, false);
    assert.ok(gone.refusals.some((r) => /ABSENT/.test(r) && /re-run run-gates\.mjs --final/.test(r)), `an absent store never un-arms the binding: ${gone.refusals}`);
    assert.deepEqual(computeFlowDecision({ cwd: root }).refusals, [], 'the in-matrix lane stays inert on the disappearance too');
    writeFileSync(resolveFlowStorePath(root, {}), '');
    const truncated = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.ok(truncated.refusals.some((r) => /flow store moved after the final run/.test(r)), `a truncated (present-unadopted) store mismatches the bound projection: ${truncated.refusals}`);
  });

  it('an unresolvable owner or fingerprint fails CLOSED on the commit-guard lane — never a silent D10 skip', () => {
    const plain = mkdtempSync(join(tmpdir(), 'aw-flow-noowner-'));
    const gateLane = computeFlowDecision({ cwd: plain });
    assert.deepEqual(gateLane.refusals, [], 'the default consumer keeps the not-a-work-tree shape (the CLI owns that message)');
    const guardLane = computeFlowDecision({ cwd: plain, consumer: 'commit-guard' });
    assert.ok(guardLane.refusals.some((r) => /owning worktree identity is unresolvable/.test(r)), `a dead owner probe must refuse on the guard lane: ${guardLane.refusals}`);
    rmSync(plain, { recursive: true, force: true });
    const { root, first, fp } = seedArmedRepo();
    seedGreenFinal(root, fp, { evidenceHashes: { redProof: D('aa'), degrade: D('bb'), flow: flowProjectionHash([first], { owner: 'main', currentFingerprint: fp }) } });
    const blind = computeFlowDecision({ cwd: root, consumer: 'commit-guard', probes: { fingerprint: () => null } });
    assert.ok(blind.refusals.some((r) => /fingerprint is unresolvable/.test(r)), `a dead fingerprint probe must refuse, never silently skip the D10 comparison: ${blind.refusals}`);
  });

  it('a no-store final followed by a FOREIGN-ONLY adoption never stales the guard — the missing-field refusal binds owner-scoped relevance (round-8 fold)', () => {
    const root = makeRepo();
    const fp = computeTreeFingerprint(root);
    const green = coreFinal('attempt-nostore', fp, 1);
    writeFileSync(resolveEvidencePath(root, {}), `${JSON.stringify(green)}\n`);
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(adoption({ owner: 'worktree:elsewhere' }))}\n`);
    const foreignOnly = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.deepEqual(foreignOnly.refusals, [], `foreign records never stale the guard — an empty owner-scoped projection has nothing the receipt failed to bind: ${foreignOnly.refusals}`);
    const ownMark = downMark('agy', { fingerprint: fp, base: null });
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(adoption({ owner: 'worktree:elsewhere' }))}\n${JSON.stringify(ownMark)}\n`);
    const ownRelevant = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.ok(ownRelevant.refusals.some((r) => /NO evidenceHashes\.flow/.test(r)), `an owner-relevant record makes the unverifiable binding refuse: ${ownRelevant.refusals}`);
  });

  it('an UNADOPTED store with a MATCHING bound field passes — the field attests store EXISTENCE, never armed-ness', () => {
    const root = makeRepo();
    const stray = downMark('agy');
    writeFileSync(resolveFlowStorePath(root, {}), `${JSON.stringify(stray)}\n`);
    const fp = computeTreeFingerprint(root);
    const green = { ...coreFinal('attempt-d10-unadopted', fp, 1), evidenceHashes: { redProof: D('aa'), degrade: D('bb'), flow: flowProjectionHash([stray], { owner: 'main', currentFingerprint: fp }) } };
    writeFileSync(resolveEvidencePath(root, {}), `${JSON.stringify(green)}\n`);
    const d = computeFlowDecision({ cwd: root, consumer: 'commit-guard' });
    assert.equal(d.armed, false);
    assert.deepEqual(d.refusals, [], `a valid-unadopted store also mints the field at --final — a matching binding must never brick the commit: ${d.refusals}`);
  });
});

// The lens-substitution rung (#15/#3, Phase 4.3): pure over an in-memory record list — an
// internal-attestation whose lens set claims a review provider's slot needs a THEN-ACTIVE
// down-mark for that backend; the refusal quotes the fallback lens's additional-only contract.
describe('evaluateInternalAttestationLenses — substitution is recorded, never silent', () => {
  const PROVIDERS = ['codex', 'agy'];
  const mark = (backend, over = {}) => ({
    schema: FLOW_SCHEMA_VERSION, kind: 'down-mark', fingerprint: 'a1'.repeat(32), backend,
    reason: 'unreachable', timestamp: '2026-08-01T00:00:00.000Z', expiresAt: '2026-08-09T00:00:00.000Z',
    base: 'ad'.repeat(20), ...over,
  });
  const attestation = (lenses, over = {}) => ({
    schema: FLOW_SCHEMA_VERSION, kind: 'internal-attestation', fingerprint: 'a1'.repeat(32),
    planId: 'plan-a', stepId: 'step-1', cycle: 1, round: 1, lenses, degraded: [],
    posture: { model: 'm', effort: null, tier: null }, authority: 'orchestrator',
    base: 'ad'.repeat(20), timestamp: '2026-08-05T00:00:00.000Z', ...over,
  });

  it('a lens set claiming a provider slot WITHOUT any down-mark refuses, quoting the additional-only contract', () => {
    const record = attestation(['correctness', 'codex']);
    const r = evaluateInternalAttestationLenses({ record, records: [record], providerBackends: PROVIDERS });
    assert.equal(r.ok, false);
    assert.match(r.reason, /claims backend "codex"'s slot without a then-active down-mark/);
    assert.ok(r.reason.includes(FALLBACK_LENS_ADDITIONAL_ONLY), 'the refusal quotes the one-home contract sentence');
  });

  it('a THEN-ACTIVE down-mark for the claimed backend admits the substitution (recorded, not silent)', () => {
    const record = attestation(['codex']);
    const r = evaluateInternalAttestationLenses({ record, records: [mark('codex'), record], providerBackends: PROVIDERS });
    assert.deepEqual(r, { ok: true });
  });

  it('a mark CLOSED before the attestation, a LATER mark, and an out-of-window instant each refuse by name', () => {
    const record = attestation(['codex']);
    const closed = { schema: FLOW_SCHEMA_VERSION, kind: 'down-mark-clear', fingerprint: 'a1'.repeat(32), backend: 'codex', target: 'cc'.repeat(32), base: 'ad'.repeat(20), timestamp: '2026-08-02T00:00:00.000Z' };
    const closedFirst = evaluateInternalAttestationLenses({ record, records: [mark('codex'), closed, record], providerBackends: PROVIDERS });
    assert.equal(closedFirst.ok, false, 'a closed mark admits nothing');
    const laterMark = evaluateInternalAttestationLenses({ record, records: [record, mark('codex')], providerBackends: PROVIDERS });
    assert.equal(laterMark.ok, false, 'mint-time order decides — a later mark never covers (prefix scope)');
    const lateRecord = attestation(['codex'], { timestamp: '2026-08-20T00:00:00.000Z' });
    const expired = evaluateInternalAttestationLenses({
      record: lateRecord,
      records: [mark('codex'), lateRecord], providerBackends: PROVIDERS,
    });
    assert.equal(expired.ok, false);
    assert.match(expired.reason, /outside its active window/);
  });

  it('a record ABSENT from the supplied list refuses — prefix scoping is undecidable (fail closed)', () => {
    const record = attestation(['codex']);
    const r = evaluateInternalAttestationLenses({ record, records: [mark('codex')], providerBackends: PROVIDERS });
    assert.equal(r.ok, false, 'a non-member record would read the WHOLE list as its prefix — a later mark could legalize');
    assert.match(r.reason, /does not belong to the supplied record list/);
  });

  it('an unparseable attestation instant refuses by name (then-activity is undecidable — fail closed)', () => {
    const record = attestation(['agy'], { timestamp: 'yesterday-ish' });
    const r = evaluateInternalAttestationLenses({ record, records: [mark('agy'), record], providerBackends: PROVIDERS });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a canonical UTC ISO instant/);
  });

  it('a lens set naming NO provider is untouched — ordinary lenses never need a down-mark', () => {
    const record = attestation(['correctness', 'security', 'review-lens']);
    assert.deepEqual(evaluateInternalAttestationLenses({ record, records: [record], providerBackends: PROVIDERS }), { ok: true });
  });
});
