// review-state.test.mjs — the AD-038 read-only receipt checker: every branch of the normative
// --check exit contract (the tool header is the single home of that list), the stale-after-edit
// case, the fold → fresh-grounded-re-receipt → green loop (continuations do NOT restore green),
// informational receipts (plan/diff + fresh:false) never satisfying a tree check, and the
// plan-in-flight naming-convention detector against a fixture mirroring THIS repo's real
// post-tidy docs/plans directory.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  main,
  computeTreeFingerprint,
  computeFingerprintPayload,
  countNeverCommittableUntracked,
  isNeverCommittableStat,
  isTreeClean,
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

// The normative receipt fixture (AD-038 shape + the D3 self-declaring probe marker); tests override
// fields. wrapperVersion stays at its historical 2.2.0 ON PURPOSE: the probe verdict must depend on
// the MARKER alone, so a suite about anything else must not be able to pass because of a version.
const RECEIPT_FIXTURE = JSON.parse(
  '{"schema":1,"artifact":"code","fresh":true,"fingerprint":"<sha256hex>","backend":"codex","verdict":"revise","grounded":true,"factsHash":null,"wrapperVersion":"2.2.0","timestamp":"2026-07-03T12:00:00Z","probe":false}',
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

// ── the probe-receipt filter (BRIDGE-MODES-CATALOG, D3) ──────────────────────────────
// A probe-relaxed review (CODEX_PROBE=1 / AGY_PROBE=1) runs with the frontier-model/max-effort
// guard OFF, so its findings must never attest a tree — but the wrappers used to write receipts
// UNCONDITIONALLY, so a probe review minted a receipt this gate accepted. The wrappers now SELF-
// DECLARE on every review (probe:true or probe:false); the filter runs PER RECEIPT, so a probe line
// never poisons a real one at the same fingerprint, and a marker that is malformed OR ABSENT is
// rejected fail-closed — silence is not a declaration, so a pre-marker receipt no longer passes.
describe('review-state — probe receipts never attest the tree (D3)', () => {
  it('probe-only receipts for a backend → FAIL, with a probe reason DISTINCT from stale', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: true });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a probe review never attests the tree');
    assert.match(r.stdout, /agy: only probe receipts/);
    assert.doesNotMatch(r.stdout, /agy: receipts exist but none matches/, 'the probe reason is its own, never the stale one');
  });

  it('a probe receipt beside a NORMAL current one (same backend) → satisfied (per-receipt, not per-backend)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: true });
    mint(root, { backend: 'agy', fingerprint: fp });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });

  // B1 (the maintainer's decision to close the hole; the first mechanism proved release-order-coupled
  // and was replaced by this one). A marker-aware wrapper ALWAYS self-declares
  // (`probe:true`/`probe:false`), so the receipt states the fact directly and no version proxy is
  // needed. An ABSENT marker means the probe status is UNTRUSTWORTHY — whatever wrote it: the pre-D3
  // wrappers honoured the probe env vars while writing nothing, and a hand-written/third-party line
  // says nothing either. Claim untrustworthiness, never provenance. Either way: rejected fail-closed.
  it('a self-declared probe:false receipt satisfies — the wrapper states the fact, not a version', () => {
    const { root } = makeRepo();
    assert.equal(RECEIPT_FIXTURE.probe, false, 'the fixture must self-declare — else this is vacuous');
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });

  it('an UNMARKED receipt is rejected — its probe status is untrustworthy, whatever wrote it', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: undefined });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'an unmarked receipt could have been a probe and nothing would show it');
    assert.match(r.stdout, /agy: current-tree receipts rejected/);
    assert.match(r.stdout, /no probe marker/);
  });

  it('the verdict does NOT depend on wrapperVersion — the marker is the whole story (both directions)', () => {
    // An ancient version string with an honest marker SATISFIES; a future one without a marker does NOT.
    const honest = makeRepo();
    const fpH = computeTreeFingerprint(honest.root);
    mint(honest.root, { backend: 'codex', fingerprint: fpH, wrapperVersion: '0.0.1' });
    mint(honest.root, { backend: 'agy', fingerprint: fpH, wrapperVersion: '0.0.1' });
    const marked = check(honest.root);
    rmSync(honest.root, { recursive: true, force: true });
    assert.equal(marked.code, 0, 'a self-declaring receipt is trusted at any version — no release-order coupling');

    const silent = makeRepo();
    const fpS = computeTreeFingerprint(silent.root);
    mint(silent.root, { backend: 'codex', fingerprint: fpS, probe: undefined, wrapperVersion: '99.0.0' });
    mint(silent.root, { backend: 'agy', fingerprint: fpS, probe: undefined, wrapperVersion: '99.0.0' });
    const unmarked = check(silent.root);
    rmSync(silent.root, { recursive: true, force: true });
    assert.equal(unmarked.code, 1, 'a high version number is not a self-declaration');
  });

  it('probe:false is an explicit NORMAL receipt (the marker is a boolean, not a presence flag)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp, probe: false });
    mint(root, { backend: 'agy', fingerprint: fp, probe: false });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });

  it('a MALFORMED marker is rejected fail-closed PER RECEIPT — a normal current receipt still satisfies, exclusion STATED', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: 'yes' });
    mint(root, { backend: 'agy', fingerprint: fp });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /1 receipt\(s\) rejected: an untrustworthy probe marker/, 'a silently-dropped receipt would violate No-silent-failures');
  });

  it('a MALFORMED marker with no normal receipt → FAIL closed (never read as a normal receipt)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: 'yes' });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /agy: current-tree receipts rejected/);
    // The per-backend cause is the whole story here — the generic summary must not repeat it.
    assert.doesNotMatch(r.stdout, /receipt\(s\) rejected: an untrustworthy probe marker/, 'a failing backend states its own cause once');
  });

  it('null is a malformed marker too (JSON null is not a boolean)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: null });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'fail-closed: an unparseable marker is never assumed normal');
  });

  it('the probe reason renders ONLY when every candidate is probe-marked (probe + malformed → the malformed reason)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: true });
    mint(root, { backend: 'agy', fingerprint: fp, probe: 'yes' });
    const r = check(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /agy: current-tree receipts rejected/, 'a malformed marker in the set is the louder fact');
    assert.doesNotMatch(r.stdout, /agy: only probe receipts/);
  });

  it('the human report renders the rejected-marker and stale states in their own words', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: 'yes' });
    const rejected = check(root, { args: [] });
    assert.match(rejected.stdout, /agy: current-tree receipts rejected — 1 with a malformed probe marker \(fail-closed\)/);
    assert.match(rejected.stdout, /\[excluded: 0 probe, 1 malformed-marker, 0 unmarked\]/, 'the report counts what it dropped');

    // Edit the tree AFTER the reviews: every receipt goes stale — the distinct pre-existing arm.
    writeFileSync(join(root, 'pending.txt'), 'an edit after both reviews\n');
    const stale = check(root, { args: [] });
    rmSync(root, { recursive: true, force: true });
    assert.match(stale.stdout, /codex: stale — no receipt matches the current tree \(edited after review\)/);
  });

  it('the default report and --json carry the probe state too (every surface, not just --check)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, probe: true });

    const human = check(root, { args: [] });
    assert.equal(human.code, 0, 'the plain report is informational — it never carries the gate code');
    assert.match(human.stdout, /agy: only probe receipts for the current tree/);

    const json = check(root, { args: ['--check', '--json'] });
    rmSync(root, { recursive: true, force: true });
    assert.equal(json.code, 1);
    const state = JSON.parse(json.stdout);
    const agy = state.backends.find((b) => b.backend === 'agy');
    assert.equal(agy.state, 'probe');
    assert.equal(agy.probeExcluded, 1, 'the machine surface counts what it excluded');
  });
});

describe('review-state — plan-in-flight detector (the queue.md naming convention)', () => {
  it('classifies every scratch marker', () => {
    for (const scratch of ['queue.md', 'EXECUTE-x.md', 'FEEDBACK-x.md', 'a-PLAN-PROMPT.md', 'item1-execution-prompt.md', 'next-session-ci-handoff.md']) {
      assert.equal(isScratchPlanName(scratch), true, scratch);
    }
    assert.equal(isScratchPlanName('active-feature.md'), false);
  });

  it('a fixture mirroring a real mid-execution docs/plans directory yields exactly the one active plan', () => {
    // The SHAPE of this repo's own docs/plans during a plan execution: the queue index, every
    // scratch marker class the convention names (EXECUTE- / FEEDBACK- prefixes; PLAN-PROMPT /
    // prompt / handoff carriers; superseded-plan renames), and exactly ONE bare active plan.
    const root = mkdtempSync(join(tmpdir(), 'review-state-detector-'));
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    const POST_TIDY = [
      'queue.md',
      'EXECUTE-harden-planning-canon.md',
      'EXECUTE-active-feature.md',
      'FEEDBACK-triage-2026-07-03.md',
      'harden-planning-canon-PLAN-PROMPT.md',
      'item1-execution-prompt.md',
      'next-session-ci-handoff.md',
      'agent-workflow-family-refactor-superseded-handoff.md',
      'orchestrate-writer-and-bridge-versions-superseded-handoff.md',
      'active-feature.md',
    ];
    for (const name of POST_TIDY) writeFileSync(join(root, 'docs', 'plans', name), 'x\n');
    const inFlight = plansInFlight(root);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(inFlight, ['active-feature.md'], 'only the real plan is in flight');
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

// ── the degraded exemption (AD-050 Segment 2) — MIRRORS review-ledger decideStop's degraded handling:
// a recipe-named backend WITHOUT a current grounded code receipt is EXEMPT from --check IFF the current
// segment's LATEST round records THAT backend degraded at the CURRENT tree fingerprint, ≥1 non-degraded
// recipe-named backend is present with a current grounded receipt, and the ledger reads clean. It stays
// VERDICT-BLIND (presence, not unanimity — Decision 7). Fail-closed (exemption denied) on an ambiguous
// loop, an unreadable/malformed ledger, an empty segment, or a corrupt round sequence. ────────────────

// Seed a v4 review-ledger via the AW_REVIEW_LEDGER override (out of the work tree so it never moves the
// fingerprint). Each line is a record object; a raw string rides verbatim (the malformed-line case).
const seedLedger = (lines) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-state-ledger-'));
  const path = join(dir, 'ledger.jsonl');
  writeFileSync(path, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  return { path, dir };
};
const v4Round = ({ loop = 'active-plan', base, fingerprint, round = 1, backends, findings = [], origins = { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 } }) =>
  ({ schema: 4, loop, activity: 'plan-execution', kind: 'round', round, base, fingerprint, origins, backends, findings, timestamp: '2026-07-09T00:00:00Z' });
const CODEX_SHIP = { backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' };
const CODEX_REVISE = { backend: 'codex', degraded: false, blockers: 1, majors: 0, minors: 0, verdict: 'revise' };
const AGY_DEGRADED = { backend: 'agy', degraded: true, blockers: 0, majors: 0, minors: 0, verdict: 'degraded', reason: 'Issue-001 stall on a large diff' };
const headOf = (g) => g('rev-parse', 'HEAD').stdout.trim();

describe('review-state --check — the degraded exemption (AD-050)', () => {
  it('no receipt but a current-fp degraded round → 0 (exempt; the reason names the degraded backend)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp, verdict: 'ship' });
    const { path, dir } = seedLedger([v4Round({ base: headOf(g), fingerprint: fp, backends: [CODEX_SHIP, AGY_DEGRADED] })]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /degraded-exempt/);
    assert.match(r.stdout, /agy/);
  });

  it('a STALE prior receipt AND a current-fp degraded round → 0 (the exemption is receipt-state-independent)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: 'stale'.repeat(12) }); // agy has a receipt, none current → 'stale'
    const { path, dir } = seedLedger([v4Round({ base: headOf(g), fingerprint: fp, backends: [CODEX_SHIP, AGY_DEGRADED] })]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });

  it('VERDICT-BLIND: the non-degraded backend receipted "revise" (blockers>0 in the round) + the other degraded at the current fp → 0 (presence, not unanimity)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp, verdict: 'revise' });
    const round = v4Round({
      base: headOf(g), fingerprint: fp,
      backends: [CODEX_REVISE, AGY_DEGRADED],
      findings: [{ findingKey: 'x', severity: 'blocker', origin: 'first-draft', backend: 'codex' }],
      origins: { 'first-draft': 1, 'fold-induced': 0, mechanics: 0 },
    });
    const { path, dir } = seedLedger([round]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout); // review-state does not adjudicate ship/revise — the backend reviewed + the other is degraded-exempt
  });

  it('the same degrade at an OLD/other fingerprint → 1 (stale, not exempt)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    const { path, dir } = seedLedger([v4Round({ base: headOf(g), fingerprint: 'old'.repeat(21) + 'x', backends: [CODEX_SHIP, AGY_DEGRADED] })]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /agy: no receipt|agy: /);
  });

  it('a two-round segment where an EARLIER round records the backend degraded but the LATEST does not → 1 (the latest governs)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    const base = headOf(g);
    mint(root, { backend: 'codex', fingerprint: fp });
    const r1 = v4Round({ base, fingerprint: fp, round: 1, backends: [CODEX_SHIP, AGY_DEGRADED] });
    const r2 = v4Round({ base, fingerprint: fp, round: 2, backends: [CODEX_SHIP, { backend: 'agy', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' }] });
    const { path, dir } = seedLedger([r1, r2]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the latest round has agy non-degraded → not exempt → agy missing');
  });

  it('a missing backend with NO degrade record → 1 (unchanged)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    // a round exists but records BOTH backends non-degraded (agy just has no receipt) → no exemption
    const round = v4Round({ base: headOf(g), fingerprint: fp, backends: [CODEX_SHIP, { backend: 'agy', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' }] });
    const { path, dir } = seedLedger([round]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
  });

  it('all degraded / no non-degraded current receipt → 1 (condition v — ≥1 real review required)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    // NO codex receipt; both backends recorded degraded
    const round = v4Round({ base: headOf(g), fingerprint: fp, backends: [
      { backend: 'codex', degraded: true, blockers: 0, majors: 0, minors: 0, verdict: 'degraded', reason: 'codex unreachable' },
      AGY_DEGRADED,
    ] });
    const { path, dir } = seedLedger([round]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'never everyone degraded — at least one real grounded review is required');
  });

  it('the non-degraded backend is ABSENT from the latest round (only the degraded one recorded) + a stray current receipt → 1 (mirrors decideStop allPresent)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp }); // codex has a current receipt...
    // ...but the latest round records ONLY agy degraded (codex absent) — not a valid council round; a
    // stray receipt for a NON-recorded backend must never justify the exemption (else the two gates
    // disagree: review-ledger fails allPresent on the absent codex).
    const { path, dir } = seedLedger([v4Round({ base: headOf(g), fingerprint: fp, backends: [AGY_DEGRADED] })]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a degrade-only round with the non-degraded backend absent never exempts');
  });

  it('a degrade recorded under a DIFFERENT base than the in-flight one → 1 (segment isolation)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    const { path, dir } = seedLedger([v4Round({ base: 'a'.repeat(40), fingerprint: fp, backends: [CODEX_SHIP, AGY_DEGRADED] })]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
  });

  it('a degrade recorded under a DIFFERENT loop than the in-flight one → 1 (segment isolation)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    const { path, dir } = seedLedger([v4Round({ loop: 'some-other-plan', base: headOf(g), fingerprint: fp, backends: [CODEX_SHIP, AGY_DEGRADED] })]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
  });

  it('>1 plan in flight + a degraded backend → 1 (ambiguous loop → exemption suppressed)', () => {
    const { root, g } = makeRepo();
    writeFileSync(join(root, 'docs', 'plans', 'second-plan.md'), '# second\n');
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    const { path, dir } = seedLedger([v4Round({ base: headOf(g), fingerprint: fp, backends: [CODEX_SHIP, AGY_DEGRADED] })]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'two plans in flight → the loop is ambiguous → no exemption');
  });

  it('>1 plan in flight + all backends receipt-current + no degrade → 0 (REGRESSION: multi-plan suppresses ONLY the exemption, adds no fail-closed arm)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'docs', 'plans', 'second-plan.md'), '# second\n');
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp });
    const r = check(root); // no ledger at all
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, 'an all-current >1-plan tree must stay exit 0 — the exemption suppression must not add an exit-1 arm');
  });

  it('a corrupt round sequence in the current segment + a current-fp degrade + a backend needing the exemption → 1 (fail-closed)', () => {
    const { root, g } = makeRepo();
    const fp = computeTreeFingerprint(root);
    const base = headOf(g);
    mint(root, { backend: 'codex', fingerprint: fp });
    // rounds numbered [1,1] — a corrupt sequence (reachable only by hand-editing the git-dir file)
    const r1 = v4Round({ base, fingerprint: fp, round: 1, backends: [CODEX_SHIP, AGY_DEGRADED] });
    const r1dup = v4Round({ base, fingerprint: fp, round: 1, backends: [CODEX_SHIP, AGY_DEGRADED] });
    const { path, dir } = seedLedger([r1, r1dup]);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a corrupt round sequence is unknown state → the exemption is denied');
  });

  it('an unreadable / malformed ledger while a backend NEEDS the exemption → 1 (fail-closed, exemption denied, surfaced)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    const { path, dir } = seedLedger(['{ this is not valid json']);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /malformed|ledger/);
  });

  it('an unreadable / malformed ledger + ALL backends receipt-current → 0 with the ledger corruption SURFACED (exemption-scoped fail-closed)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp });
    const { path, dir } = seedLedger(['{ not valid json at all']);
    const r = check(root, { env: { AW_REVIEW_LEDGER: path } });
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 0, 'a corrupt ledger must never fail a tree whose receipts independently satisfy the gate');
    assert.match(r.stdout, /ledger/, 'the ledger corruption is surfaced even on the exit-0 path');
  });
});

// ── the never-committable review-domain filter (AD-044 Plan 4, Decision 1) ──────────────────────
// Test strategy (probe-proven): on a regular filesystem git's dir walk does NOT list FIFOs/devices
// as untracked at all — the real mask class surfaces only where the sandbox's dirent LIES (readdir
// says file, lstat says char device). So these tests assert through the FILTER PREDICATE with a
// LYING injected lstat over a git-visible regular fixture file — the sandbox mechanism itself —
// plus a true-lstat control proving non-vacuity. char/block devices are not creatable
// unprivileged; injected stats cover all four classes.

// A fake lstat result: exactly one type flag true, every other false (a real lstat has one type).
const fakeStat = (type) => ({
  isFile: () => type === 'file',
  isDirectory: () => type === 'dir',
  isSymbolicLink: () => type === 'symlink',
  isCharacterDevice: () => type === 'char',
  isBlockDevice: () => type === 'block',
  isFIFO: () => type === 'fifo',
  isSocket: () => type === 'socket',
});

describe('isNeverCommittableStat — the filtered class is EXACTLY char/block/FIFO/socket', () => {
  it('all four never-committable classes are in', () => {
    for (const type of ['char', 'block', 'fifo', 'socket']) {
      assert.equal(isNeverCommittableStat(fakeStat(type)), true, `${type} is filtered`);
    }
  });

  it('regular files, directories (gitlinks), symlinks, and a null stat stay IN the domain', () => {
    for (const type of ['file', 'dir', 'symlink']) {
      assert.equal(isNeverCommittableStat(fakeStat(type)), false, `${type} is never filtered`);
    }
    assert.equal(isNeverCommittableStat(null), false, 'a vanished path keeps its name-only note');
  });
});

describe('review-domain filter — fingerprint + isTreeClean over a lying lstat (the sandbox mechanism)', () => {
  // A repo whose ONLY untracked path is the git-visible mask fixture; the lying lstat reports it
  // as the given class while git (dirent) lists it — exactly the in-sandbox divergence.
  const makeMaskRepo = () => {
    const { root, g } = makeRepo({ config: null, plan: null, pending: false });
    g('add', '-A');
    g('commit', '-qm', 'docs committed');
    const baselinePayload = computeFingerprintPayload(root).toString('latin1');
    const baselineFp = computeTreeFingerprint(root);
    writeFileSync(join(root, 'mask.txt'), 'sandbox mask body\n');
    const liar = (p) => (p.endsWith('mask.txt') ? fakeStat('char') : lstatSync(p));
    return { root, baselinePayload, baselineFp, liar };
  };

  it('(i) the payload and fingerprint are byte-identical WITH and WITHOUT a filtered-class untracked path', () => {
    const { root, baselinePayload, baselineFp, liar } = makeMaskRepo();
    const maskedPayload = computeFingerprintPayload(root, { lstat: liar }).toString('latin1');
    const maskedFp = computeTreeFingerprint(root, { lstat: liar });
    const controlFp = computeTreeFingerprint(root); // true lstat: mask.txt is a regular file
    rmSync(root, { recursive: true, force: true });
    assert.equal(maskedPayload, baselinePayload, 'a filtered-class path leaves NO trace in the payload');
    assert.equal(maskedFp, baselineFp, 'the fingerprint cannot move');
    assert.notEqual(controlFp, baselineFp, 'NON-VACUOUS: the fixture path IS seen pre-filter (true lstat moves the fingerprint)');
  });

  it('(ii) isTreeClean is true when the ONLY untracked path is filtered-class (and false under the true lstat)', () => {
    const { root, liar } = makeMaskRepo();
    const cleanMasked = isTreeClean(root, { lstat: liar });
    const cleanControl = isTreeClean(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(cleanMasked, true, 'a masks-only tree reads clean');
    assert.equal(cleanControl, false, 'NON-VACUOUS: the same tree under the true lstat is dirty');
  });

  it('every one of the four classes filters identically (payload level)', () => {
    const { root, baselineFp } = makeMaskRepo();
    for (const type of ['char', 'block', 'fifo', 'socket']) {
      const liar = (p) => (p.endsWith('mask.txt') ? fakeStat(type) : lstatSync(p));
      assert.equal(computeTreeFingerprint(root, { lstat: liar }), baselineFp, `${type} filtered from the fingerprint`);
      assert.equal(isTreeClean(root, { lstat: liar }), true, `${type} filtered from the clean check`);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('(iv) an untracked SYMLINK still moves the fingerprint (committable — stays in the domain)', () => {
    const { root, baselineFp } = makeMaskRepo();
    rmSync(join(root, 'mask.txt'));
    symlinkSync('base.txt', join(root, 'a-link'));
    const fp = computeTreeFingerprint(root);
    const clean = isTreeClean(root);
    rmSync(root, { recursive: true, force: true });
    assert.notEqual(fp, baselineFp, 'the symlink note moves the fingerprint');
    assert.equal(clean, false, 'a symlink-only tree is reviewable, never clean');
  });

  it('isTreeClean: a THROWING lstat keeps the path in the domain (dirty — fail-safe)', () => {
    const { root } = makeMaskRepo();
    const throwing = () => { throw new Error('EACCES'); };
    const clean = isTreeClean(root, { lstat: throwing });
    rmSync(root, { recursive: true, force: true });
    assert.equal(clean, false, 'an unverifiable untracked path can never read clean');
  });

  it('countNeverCommittableUntracked: non-git cwd → 0; a throwing lstat counts nothing (fail-safe arms)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'rs-nongit-'));
    assert.equal(countNeverCommittableUntracked(outside), 0, 'not a git tree — nothing to count');
    rmSync(outside, { recursive: true, force: true });
    const { root } = makeMaskRepo();
    const throwing = () => { throw new Error('EACCES'); };
    assert.equal(countNeverCommittableUntracked(root, { lstat: throwing }), 0, 'an unverifiable path never inflates the advisory count');
    rmSync(root, { recursive: true, force: true });
  });

  it('the D-lane advisory: ONE non-failing notice line names the exact sandbox-masks apply when masks are visible', () => {
    const { root, liar } = makeMaskRepo();
    const withMasks = main(['--check'], { cwd: root, env: {}, detect: detect(READY, READY), lstat: liar });
    const withoutMasks = main(['--check'], { cwd: root, env: {}, detect: detect(READY, READY) });
    rmSync(root, { recursive: true, force: true });
    assert.match(withMasks.stdout, /notice: 1 never-committable untracked path/, 'the advisory names the count');
    assert.match(withMasks.stdout, /sandbox-masks\.mjs --cwd .* --apply/, 'the exact apply one-liner rides the line');
    assert.equal((withMasks.stdout.match(/notice:/g) ?? []).length, 1, 'exactly ONE advisory line');
    assert.equal(withMasks.code, 0, 'non-failing: a masks-only tree is CLEAN and the advisory never arms an exit code');
    assert.doesNotMatch(withoutMasks.stdout, /sandbox-masks/, 'no masks → no advisory');
  });

  it('buildState threads the injected lstat into fingerprint + clean + mask count — one consistent state (codex R3)', () => {
    const { root, baselineFp, liar } = makeMaskRepo();
    const r = main(['--json'], { cwd: root, env: {}, detect: detect(READY, READY), lstat: liar });
    const state = JSON.parse(r.stdout);
    rmSync(root, { recursive: true, force: true });
    assert.equal(state.clean, true, 'clean sees the lying lstat');
    assert.equal(state.fingerprint, baselineFp, 'the fingerprint sees the SAME lying lstat');
    assert.equal(state.maskedUntracked, 1, 'and the mask count agrees');
  });

  it('(vi) an untracked DIRECTORY (embedded git repo — a gitlink) still moves the fingerprint AND reads dirty', () => {
    const { root, baselineFp } = makeMaskRepo();
    rmSync(join(root, 'mask.txt'));
    mkdirSync(join(root, 'embedded'));
    spawnSync('git', ['init', '-q'], { cwd: join(root, 'embedded'), encoding: 'utf8' });
    const fp = computeTreeFingerprint(root);
    const clean = isTreeClean(root);
    rmSync(root, { recursive: true, force: true });
    assert.notEqual(fp, baselineFp, 'the embedded-repo `dir/` note moves the fingerprint (codex R1 gitlink pin)');
    assert.equal(clean, false, 'a new embedded repo can never read clean');
  });
});
