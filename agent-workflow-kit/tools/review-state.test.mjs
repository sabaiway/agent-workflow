// review-state.test.mjs — the AD-038 read-only receipt checker: every branch of the normative
// --check exit contract (the tool header is the single home of that list), the stale-after-edit
// case, the fold → fresh-grounded-re-receipt → green loop (continuations do NOT restore green),
// informational receipts (plan/diff + fresh:false) never satisfying a tree check, and the
// plan-in-flight naming-convention detector against a fixture mirroring THIS repo's real
// post-tidy docs/plans directory.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  main,
  computeTreeFingerprint,
  isScratchPlanName,
  plansInFlight,
  backendReceiptStatus,
  RECEIPTS_BASENAME,
} from './review-state.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const detect = (codex, agy) => () => [
  { name: CODEX, readiness: codex },
  { name: AGY, readiness: agy },
];

// The normative receipt fixture (AD-038 plan Decisions — copied verbatim); tests override fields.
const RECEIPT_FIXTURE = JSON.parse(
  '{"schema":1,"artifact":"code","fresh":true,"fingerprint":"<sha256hex>","backend":"codex","verdict":"revise","grounded":true,"factsHash":null,"wrapperVersion":"2.2.0","timestamp":"2026-07-03T12:00:00Z"}',
);
const receiptLine = (overrides) => `${JSON.stringify({ ...RECEIPT_FIXTURE, ...overrides })}\n`;

const COUNCIL_CONFIG = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });
const SOLO_CONFIG = JSON.stringify({ 'plan-execution': { review: 'solo' } });

// A real git fixture repo: committed base, per-test config / plans / pending state.
const makeRepo = ({ config = COUNCIL_CONFIG, plan = 'active-plan.md', pending = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'review-state-'));
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(root, 'base.txt'), 'committed base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  if (config != null) {
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), config);
  }
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  if (plan) writeFileSync(join(root, 'docs', 'plans', plan), '# active plan\n');
  if (pending) writeFileSync(join(root, 'pending.txt'), 'uncommitted work\n');
  return { root, g };
};

const mint = (root, overrides) => appendFileSync(join(root, '.git', RECEIPTS_BASENAME), receiptLine(overrides));
const check = (root, { env = {}, codex = READY, agy = READY, args = ['--check'] } = {}) =>
  main(args, { cwd: root, env, detect: detect(codex, agy) });

describe('review-state --check — exit-0 branches of the normative contract', () => {
  it('resolved recipe solo (configured) → 0, no receipt required', () => {
    const { root } = makeRepo({ config: SOLO_CONFIG });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /recipe is solo/);
  });

  it('no reviewer backend ready (council degrades to solo) → 0, degradation stated', () => {
    const { root } = makeRepo();
    const r = check(root, { codex: NEEDS_SKILL, agy: NEEDS_SKILL });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /degrades to solo/);
  });

  it('no plan in flight (docs/plans holds only queue.md + scratch) → 0', () => {
    const { root } = makeRepo({ plan: null });
    writeFileSync(join(root, 'docs', 'plans', 'EXECUTE-something.md'), 'scratch\n');
    writeFileSync(join(root, 'docs', 'plans', 'old-session-handoff.md'), 'scratch\n');
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no plan in flight/);
  });

  it('clean tree → 0 (nothing to review)', () => {
    const { root, g } = makeRepo();
    g('add', '-A');
    g('commit', '-qm', 'everything committed');
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /clean/);
  });

  it('not a git work tree → 0 (nothing to fingerprint), stated', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-state-nogit-'));
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), COUNCIL_CONFIG);
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# plan\n');
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /not a git work tree/);
  });

  it('every recipe-named backend receipted current + grounded → 0', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp, verdict: 'ship' });
    mint(root, { backend: 'agy', fingerprint: fp, verdict: 'SHIP', factsHash: 'a'.repeat(64) });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /every recipe-named backend has a fresh grounded receipt/);
  });
});

describe('review-state --check — exit-1 branches', () => {
  it('council with NO receipts → 1, both backends named', () => {
    const { root } = makeRepo();
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /codex: no receipt/);
    assert.match(r.stdout, /agy: no receipt/);
  });

  it('one backend missing under council → 1 (presence, not unanimity — BOTH must attest)', () => {
    const { root } = makeRepo();
    mint(root, { backend: 'codex', fingerprint: computeTreeFingerprint(root) });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /agy: no receipt/);
    assert.doesNotMatch(r.stdout, /codex: no receipt/);
  });

  it('stale after an edit: receipts minted, then an UNTRACKED-content edit → 1 (fingerprint moved)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp });
    assert.equal(check(root).code, 0, 'receipted tree is green');
    writeFileSync(join(root, 'pending.txt'), 'edited AFTER the review\n');
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the edit invalidates the receipts');
    assert.match(r.stdout, /edited after review/);
  });

  it('stale after an edit: a TRACKED-file edit (unstaged diff) also moves the fingerprint → 1', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp });
    assert.equal(check(root).code, 0, 'receipted tree is green');
    writeFileSync(join(root, 'base.txt'), 'committed base — EDITED after the review\n');
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a tracked edit invalidates the receipts too');
  });

  it('a subdirectory invocation reads the ROOT config/plans — a dirty unreceipted tree stays red (never a false "no plan in flight")', () => {
    const { root } = makeRepo();
    mkdirSync(join(root, 'sub'), { recursive: true });
    const fromSub = check(root, { args: ['--check'] });
    const subdir = main(['--check'], { cwd: join(root, 'sub'), env: {}, detect: detect(READY, READY) });
    assert.equal(fromSub.code, 1, 'root invocation: red (no receipts)');
    assert.equal(subdir.code, 1, 'subdir invocation anchors at the git root — same red, no false pass');
    assert.doesNotMatch(subdir.stdout, /no plan in flight/);
    // And a receipted tree is green from the subdir too (the anchor is symmetric).
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp });
    const green = main(['--check'], { cwd: join(root, 'sub'), env: {}, detect: detect(READY, READY) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(green.code, 0, green.stdout);
  });

  it('an ungrounded agy receipt under council → 1 (grounded:false never satisfies)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, grounded: false, factsHash: null });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /agy: only ungrounded receipts/);
  });

  it('reviewed (one backend) needs exactly that backend', () => {
    const { root } = makeRepo({ config: JSON.stringify({ 'plan-execution': { review: 'reviewed' } }) });
    const red = check(root);
    assert.equal(red.code, 1);
    assert.match(red.stdout, /codex: no receipt/, 'reviewed prefers codex when both are ready');
    mint(root, { backend: 'codex', fingerprint: computeTreeFingerprint(root) });
    const green = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(green.code, 0, green.stdout);
  });
});

describe('review-state --check — detector failure fails CLOSED (a gate, not an advisor)', () => {
  const throwingDetect = () => {
    throw Object.assign(new Error('corrupt bridge (EISDIR)'), { code: 'EISDIR' });
  };

  it('a throwing detector under a configured council → 1 (unknown state never disables the receipt requirement)', () => {
    const { root } = makeRepo();
    const r = main(['--check'], { cwd: root, env: {}, detect: throwingDetect });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /cannot verify receipts/);
    assert.match(r.stdout, /backend detection failed/);
  });

  it('a throwing detector under an EXPLICIT solo config → 0 (the detector is irrelevant to solo)', () => {
    const { root } = makeRepo({ config: SOLO_CONFIG });
    const r = main(['--check'], { cwd: root, env: {}, detect: throwingDetect });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });

  it('a throwing detector with NO config (computed default) → 1 (the default could have been reviewed — unknowable)', () => {
    const { root } = makeRepo({ config: null });
    const r = main(['--check'], { cwd: root, env: {}, detect: throwingDetect });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a default-config project never fails open on a broken detector');
    assert.match(r.stdout, /cannot verify receipts/);
  });
});

describe('review-state — informational receipts never satisfy the tree check', () => {
  it('plan/diff-mode receipts are ignored even with a forged current fingerprint', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', artifact: 'plan', fingerprint: fp });
    mint(root, { backend: 'agy', artifact: 'diff', fingerprint: fp });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'plan/diff receipts never attest a tree');
  });

  it('continuation receipts (fresh:false) are ignored even with artifact code + current fingerprint', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fresh: false, artifact: 'code', fingerprint: fp });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a continuation cannot attest the folded tree');
  });

  it('fold after a clean round: continuation does NOT restore green; fresh grounded re-receipts DO', () => {
    const { root } = makeRepo();
    const fp1 = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp1 });
    mint(root, { backend: 'agy', fingerprint: fp1 });
    assert.equal(check(root).code, 0, 'round-1 receipted tree is green');

    writeFileSync(join(root, 'pending.txt'), 'a fold applied after the clean round\n');
    assert.equal(check(root).code, 1, 'the fold invalidates round-1 receipts');

    // A round-2 continuation (fresh:false, no fingerprint) — informational only.
    mint(root, { backend: 'agy', fresh: false, artifact: null, fingerprint: null });
    assert.equal(check(root).code, 1, 'a continuation receipt does not restore green');

    // Fresh grounded re-reviews on the folded tree restore green.
    const fp2 = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp2 });
    mint(root, { backend: 'agy', fingerprint: fp2 });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });
});

describe('review-state — plan-in-flight detector (the queue.md naming convention)', () => {
  it('classifies every scratch marker', () => {
    for (const scratch of ['queue.md', 'EXECUTE-x.md', 'FEEDBACK-x.md', 'a-PLAN-PROMPT.md', 'item1-execution-prompt.md', 'next-session-ci-handoff.md']) {
      assert.equal(isScratchPlanName(scratch), true, scratch);
    }
    assert.equal(isScratchPlanName('review-recipe-enforcement.md'), false);
  });

  it('the fixture mirroring THIS repo\'s post-tidy docs/plans yields exactly the one active plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-state-detector-'));
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    const POST_TIDY = [
      'queue.md',
      'EXECUTE-harden-planning-canon.md',
      'EXECUTE-review-recipe-enforcement.md',
      'FEEDBACK-review-enforcement-2026-07-03.md',
      'harden-planning-canon-PLAN-PROMPT.md',
      'item1-execution-prompt.md',
      'next-session-ci-handoff.md',
      'agent-workflow-family-refactor-superseded-handoff.md',
      'orchestrate-writer-and-bridge-versions-superseded-handoff.md',
      'review-recipe-enforcement.md',
    ];
    for (const name of POST_TIDY) writeFileSync(join(root, 'docs', 'plans', name), 'x\n');
    const inFlight = plansInFlight(root);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(inFlight, ['review-recipe-enforcement.md'], 'only the real plan is in flight');
  });

  it('an absent docs/plans dir means nothing is in flight', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-state-noplans-'));
    assert.deepEqual(plansInFlight(root), []);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('review-state — receipts file + env override + report surface', () => {
  it('AW_REVIEW_RECEIPTS overrides where receipts are read from', () => {
    const { root } = makeRepo();
    // The override file must live OUTSIDE the work tree — an in-repo untracked file would itself
    // move the fingerprint it attests.
    const outside = mkdtempSync(join(tmpdir(), 'review-state-receipts-'));
    const override = join(outside, 'elsewhere.jsonl');
    const fp = computeTreeFingerprint(root);
    writeFileSync(override, receiptLine({ backend: 'codex', fingerprint: fp }) + receiptLine({ backend: 'agy', fingerprint: fp }));
    const r = check(root, { env: { AW_REVIEW_RECEIPTS: override } });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });

  it('the default report names per-backend verdicts + grounding for the current fingerprint', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp, verdict: 'revise' });
    mint(root, { backend: 'agy', fingerprint: fp, verdict: 'SHIP WITH NITS' });
    const r = check(root, { args: [] });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /codex: current \(verdict: revise, grounded/);
    assert.match(r.stdout, /agy: current \(verdict: SHIP WITH NITS, grounded/);
    assert.match(r.stdout, /plan in flight: active-plan\.md/);
  });

  it('a malformed receipt line is counted loudly, never silently dropped', () => {
    const { root } = makeRepo();
    appendFileSync(join(root, '.git', RECEIPTS_BASENAME), 'not json at all\n');
    const r = check(root, { args: [] });
    rmSync(root, { recursive: true, force: true });
    assert.match(r.stdout, /1 malformed/);
  });

  it('--check names malformed lines even when it PASSES (a partially-corrupt file is never a silent green)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp });
    appendFileSync(join(root, '.git', RECEIPTS_BASENAME), '{corrupt line\n');
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, 'valid current receipts still pass');
    assert.match(r.stdout, /1 malformed receipt line\(s\) ignored/);
  });

  it('a malformed orchestration.json is a loud error, never a silent green', () => {
    const { root } = makeRepo({ config: '{ not json' });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /malformed JSON/);
  });

  it('unknown argument → usage error (exit 2)', () => {
    const { root } = makeRepo();
    const r = check(root, { args: ['--chekc'] });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument/);
  });

  it('--json emits a parseable state object including the check decision', () => {
    const { root } = makeRepo();
    const r = check(root, { args: ['--json'] });
    rmSync(root, { recursive: true, force: true });
    const j = JSON.parse(r.stdout);
    assert.equal(j.resolved.recipe, 'council');
    assert.deepEqual(j.requiredBackends, ['codex', 'agy']);
    assert.equal(typeof j.check.code, 'number');
  });
});

describe('backendReceiptStatus — the latest grounded receipt wins', () => {
  it('prefers a grounded current receipt over an earlier ungrounded one', () => {
    const fp = 'f'.repeat(64);
    const receipts = [
      { ...RECEIPT_FIXTURE, backend: 'agy', fingerprint: fp, grounded: false },
      { ...RECEIPT_FIXTURE, backend: 'agy', fingerprint: fp, grounded: true, verdict: 'SHIP' },
    ];
    const s = backendReceiptStatus(receipts, 'agy', fp);
    assert.equal(s.state, 'current');
    assert.equal(s.verdict, 'SHIP');
  });
});
