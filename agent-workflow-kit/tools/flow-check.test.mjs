import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decideFlowCheck, runFlowCheck } from './flow-check.mjs';
import { resolveFlowStorePath, parseFlowStoreText } from './flow-store.mjs';
import { FLOW_SCHEMA_VERSION, canonicalFlowDigest } from './flow-record.mjs';
import { EVIDENCE_SCHEMA_VERSION, resolveEvidencePath, parseEvidenceText } from './core-evidence.mjs';

const TOOL = fileURLToPath(new URL('./flow-check.mjs', import.meta.url));
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
const decide = (flowRecords, { core = [], owner = 'main', flowRead } = {}) =>
  decideFlowCheck({ flowRead: flowRead ?? flowReadOf(flowRecords), coreRead: coreReadOf(core), owner });

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

  it('the committing tree own open chain refuses, printing the Plan-2 INTERIM structured recovery', () => {
    const first = adoption();
    const step1 = opener(canonicalFlowDigest(first), { timestamp: TS(1) });
    const d = decide([first, step1], { owner: 'main' });
    assert.equal(d.refusals.length, 1);
    assert.match(d.refusals[0], /OPEN chain owned by this worktree/);
    assert.match(d.refusals[0], /"action":"park"/, 'the structured recovery names the action');
    assert.match(d.refusals[0], /"purpose":"park"/, 'the structured recovery names the record it requires');
    assert.match(d.refusals[0], /"planId":"plan-a"/);
    assert.match(d.refusals[0], /Plan-3 writer/, 'the interim form states the verbatim command arrives with the Plan-3 writer');
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

  it('--help exits 0 and states the deliberate non-wiring', () => {
    const r = runCli(['--help'], TMP);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /flow-check/);
    assert.match(r.stdout, /Plan 3|composition/i);
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
