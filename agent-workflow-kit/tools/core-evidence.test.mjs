// core-evidence.test.mjs — the facade suite of the ONE core-evidence writer: the module loads, the
// stateless D6 summary verb through main, and the command line (verbs, usage refusals, real spawns).
// The leaf suites beside it (core-evidence-<seam>.test.mjs) hold the cases that call a leaf directly.
//
// The module under test is imported DYNAMICALLY (the D7 authoring pattern, the
// retired-runner precedent): this spec LOADS — and fails per fixture — on the
// pre-implementation tree, so every refusal fixture has an observed RED first.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeTreeFingerprint } from './review-state.mjs';
import { makeRepo, fixtureEnv, storeOf } from './core-evidence-harness.test.mjs';

const core = await import('./core-evidence.mjs').catch(() => null);
const { runRedProof, runDegrade, main } = core ?? {};

describe('evidence store path (D7: the ONE writer owns ONE git-dir JSONL file)', () => {
  it('module exists (authored red-first: this spec predates the implementation)', () => {
    assert.ok(core, 'core-evidence.mjs must exist and load');
  });
});

// ── the summary verb (D6: ONE stateless render — receipts + evidence store, no ledger) ────────────

// spec:core-evidence/S6
describe('summary — stateless D6 render (verdicts, red-proofs, degrades; loud on malformed)', () => {
  it('renders per-backend verdicts for the current tree, current-base red-proofs, current-tree degrades', () => {
    const { root } = makeRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' });
    runDegrade({ cwd: root, env, backend: 'agy', reason: 'declared degrade for this tree' });
    const fp = computeTreeFingerprint(root);
    writeFileSync(
      join(root, '.git', 'agent-workflow-review-receipts.jsonl'),
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'SHIP', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't1' })}\n` +
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: 'stale'.padEnd(64, '0'), backend: 'agy', verdict: 'revise', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't0' })}\n`,
    );
    const r = main(['summary'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /codex: SHIP/);
    assert.match(r.stdout, /agy: .*stale|agy: .*no attesting/i);
    assert.match(r.stdout, /lib\.test\.mjs#red case/);
    assert.match(r.stdout, /1\/1 red/);
    assert.match(r.stdout, /degrade/);
    assert.match(r.stdout, /declared degrade for this tree/);
    rmSync(root, { recursive: true, force: true });
  });
  // A red-proof binds the BYTES of its test file, and coverage-check refuses at --final when those
  // bytes have moved. Until this render marked it, a stale record printed byte-identically to a live
  // one, so the discovery point was the commit gate — after both council dispatches, the most
  // expensive moment in the loop. Third occurrence of the class before it was closed.
  it('marks a red-proof CURRENT while its bound test file still has the hashed bytes', () => {
    const { root } = makeRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' });
    const r = main(['summary'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /lib\.test\.mjs#red case — CURRENT/);
    assert.doesNotMatch(r.stdout, /STALE/);
    rmSync(root, { recursive: true, force: true });
  });

  it('marks a red-proof STALE once its bound test file changed, and names the recovery', () => {
    const { root } = makeRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' });
    // The edit that stales it — exactly what a fold does to every proof bound to the file it touches.
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 1); });\n",
    );
    const r = main(['summary'], { cwd: root, env });
    assert.equal(r.code, 0, 'the summary REPORTS staleness; refusing is coverage-check\'s job, not this render\'s');
    assert.match(r.stdout, /lib\.test\.mjs#red case — STALE/);
    assert.match(r.stdout, /changed after the mint/);
    assert.match(r.stdout, /re-observe/, 'a marked record must name its recovery, which was written down nowhere');
    rmSync(root, { recursive: true, force: true });
  });

  it('marks a red-proof STALE when its bound test file is GONE', () => {
    const { root } = makeRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' });
    rmSync(join(root, 'lib.test.mjs'));
    const r = main(['summary'], { cwd: root, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /lib\.test\.mjs#red case — STALE/);
    rmSync(root, { recursive: true, force: true });
  });

  it('summary renders the final gate line from the latest completed attempt at the current tree', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    const done = {
      schema: 1, kind: 'final', status: 'green', attempt: 'a1',
      fingerprintBefore: fp, fingerprintAfter: fp,
      declared: [{ id: 'noop', cmd: 'true' }],
      results: [{ id: 'noop', ok: true, code: 0 }],
      evidenceHashes: { redProof: 'a'.repeat(64), degrade: 'b'.repeat(64) },
      lcovSha256: null, integrityFailure: null, timestamp: 't-final',
    };
    writeFileSync(storeOf(root), `${JSON.stringify(done)}\n`);
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /final gate run: GREEN/);
    rmSync(root, { recursive: true, force: true });
  });

  // The withheld coverage verdict travels to the stateless render too (Decision 7): a final record
  // whose lcovSha256 is null certified NOTHING, so an unqualified GREEN here is the same false
  // reassurance the checker's own attested=no exists to close — DETAIL beside the status word,
  // never a new state (the status token itself is untouched).
  const finalRecordAt = (fp, over = {}) => ({
    schema: 1, kind: 'final', status: 'green', attempt: 'a1',
    fingerprintBefore: fp, fingerprintAfter: fp,
    declared: [{ id: 'noop', cmd: 'true' }],
    results: [{ id: 'noop', ok: true, code: 0 }],
    evidenceHashes: { redProof: 'a'.repeat(64), degrade: 'b'.repeat(64) },
    lcovSha256: null, integrityFailure: null, timestamp: 't-final', ...over,
  });

  it('a final record that consumed NO lcov renders a qualified green line', () => {
    const { root } = makeRepo();
    writeFileSync(storeOf(root), `${JSON.stringify(finalRecordAt(computeTreeFingerprint(root)))}\n`);
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /final gate run: GREEN — coverage=unknown: this legacy receipt carries no coverage token and binds no lcov digest \(1\/1 gates, t-final\)/);
  });

  it('a final record that DID consume an lcov renders the plain green line', () => {
    const { root } = makeRepo();
    writeFileSync(storeOf(root), `${JSON.stringify(finalRecordAt(computeTreeFingerprint(root), { lcovSha256: 'c'.repeat(64) }))}\n`);
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /final gate run: GREEN \(1\/1 gates, t-final\)/);
    assert.doesNotMatch(r.stdout, /coverage=/, 'a legacy receipt binding a digest is never qualified');
  });

  // The RECORDED token decides, not the digest: a receipt can bind lcov bytes and still have
  // issued no verdict (the checker's attestation context was refused), and re-deriving from
  // lcovSha256 would render that run as if it had certified.
  it('the recorded coverage token drives the qualifier, not the lcov digest', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    const withDigestNoVerdict = finalRecordAt(fp, { coverage: 'not-run', lcovSha256: 'c'.repeat(64) });
    writeFileSync(storeOf(root), `${JSON.stringify(withDigestNoVerdict)}\n`);
    const notRun = main(['summary'], { cwd: root, env: fixtureEnv() });
    writeFileSync(storeOf(root), `${JSON.stringify(finalRecordAt(fp, { coverage: 'certified', lcovSha256: 'c'.repeat(64) }))}\n`);
    const certified = main(['summary'], { cwd: root, env: fixtureEnv() });
    writeFileSync(storeOf(root), `${JSON.stringify(finalRecordAt(fp, { coverage: 'unknown' }))}\n`);
    const unknown = main(['summary'], { cwd: root, env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.match(notRun.stdout, /final gate run: GREEN — coverage=not-run: the recorded run issued no coverage verdict \(1\/1 gates, t-final\)/);
    assert.match(certified.stdout, /final gate run: GREEN \(1\/1 gates, t-final\)/);
    assert.doesNotMatch(certified.stdout, /coverage=/, 'a certified run is never qualified');
    assert.match(unknown.stdout, /final gate run: GREEN — coverage=unknown: the recorded run produced no readable coverage signal \(1\/1 gates, t-final\)/);
  });

  it('an empty world renders gracefully (no store, no receipts) and stays exit 0', () => {
    const { root } = makeRepo();
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /red-proof records \(current base\): \(none\)/);
    assert.match(r.stdout, /degrade records \(current tree\): \(none\)/);
    rmSync(root, { recursive: true, force: true });
  });
  it('summary exits non-zero over a malformed store and withholds the evidence sections', () => {
    const { root } = makeRepo();
    writeFileSync(storeOf(root), 'not json\n');
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 1, 'a malformed store must not read as a healthy summary');
    assert.match(r.stdout, /1 malformed/);
    assert.match(r.stdout, /WITHHELD/);
    rmSync(root, { recursive: true, force: true });
  });
  it('a malformed later receipt line never lets an older SHIP render as attesting', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    writeFileSync(
      join(root, '.git', 'agent-workflow-review-receipts.jsonl'),
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'SHIP', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't1' })}\n` +
      'corrupted receipt line — a NEWER verdict may hide here\n',
    );
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 1, 'a partially-corrupt receipts store must not read as a healthy summary');
    assert.doesNotMatch(r.stdout, /SHIP/, 'a possibly-outdated verdict must not render as attesting');
    assert.match(r.stdout, /review verdicts WITHHELD/);
    rmSync(root, { recursive: true, force: true });
  });
  it('an unreadable receipts store withholds the verdicts section and exits non-zero', () => {
    const { root } = makeRepo();
    const dir = mkdtempSync(join(tmpdir(), 'core-evidence-recdir-'));
    const r = main(['summary'], { cwd: root, env: fixtureEnv({ AW_REVIEW_RECEIPTS: dir }) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /review verdicts WITHHELD/);
    assert.match(r.stdout, /read error/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  it('a SYMLINKED receipts store withholds the verdicts section — content is never read through (RECEIPTS-READER-NOFOLLOW)', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    writeFileSync(
      join(root, '.git', 'real-receipts.jsonl'),
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'SHIP', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't1' })}\n`,
    );
    symlinkSync('real-receipts.jsonl', join(root, '.git', 'agent-workflow-review-receipts.jsonl'));
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.equal(r.code, 1, 'a symlinked receipts store must never render as a healthy summary');
    assert.match(r.stdout, /review verdicts WITHHELD/);
    assert.match(r.stdout, /symlink/);
    assert.doesNotMatch(r.stdout, /SHIP/, 'the linked content must never surface as attesting');
    rmSync(root, { recursive: true, force: true });
  });
  it('summary names an unrecognized verdict instead of stale or missing', () => {
    const { root } = makeRepo();
    const fp = computeTreeFingerprint(root);
    writeFileSync(
      join(root, '.git', 'agent-workflow-review-receipts.jsonl'),
      `${JSON.stringify({ schema: 1, artifact: 'code', fresh: true, fingerprint: fp, backend: 'codex', verdict: 'unknown', grounded: true, probe: false, posture: { model: 'm' }, timestamp: 't1' })}\n`,
    );
    const r = main(['summary'], { cwd: root, env: fixtureEnv() });
    assert.match(r.stdout, /codex: unrecognized verdict \("unknown"\) — never attests/);
    assert.doesNotMatch(r.stdout, /codex: no attesting receipt for the current tree \(stale or missing\)/, 'a current unknown-verdict receipt is NOT stale/missing — the render must not lie');
    rmSync(root, { recursive: true, force: true });
  });
  it('a malformed later line never resurrects a superseded record in the render (sections withheld)', () => {
    const { root } = makeRepo();
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\n",
    );
    runRedProof({ cwd: root, env, testId: 'lib.test.mjs#red case' });
    const store = readFileSync(storeOf(root), 'utf8');
    writeFileSync(storeOf(root), `${store}corrupted-superseding-line\n`);
    const r = main(['summary'], { cwd: root, env });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stdout, /lib\.test\.mjs#red case/, 'a possibly-superseded record must not render as authoritative');
    rmSync(root, { recursive: true, force: true });
  });
});

// ── the process contract (representative E2E spawns — argv + exit code + stdio) ──────────────────

describe('core-evidence CLI — real process spawns (argv/exit-code contract)', () => {
  const TOOL = fileURLToPath(new URL('./core-evidence.mjs', import.meta.url));
  it('summary runs as a real process (exit 0, report on stdout)', () => {
    const { root } = makeRepo();
    const r = spawnSync('node', [TOOL, 'summary', '--cwd', root], { encoding: 'utf8', env: fixtureEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /core-evidence summary/);
    rmSync(root, { recursive: true, force: true });
  });
  it('an unknown verb exits 2 with the refusal on stderr', () => {
    const r = spawnSync('node', [TOOL, 'mystery'], { encoding: 'utf8', env: fixtureEnv() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown verb/);
  });
});

// ── CLI surface ───────────────────────────────────────────────────────────────────────────────────

describe('core-evidence CLI — verbs red-proof / degrade / summary', () => {
  it('--help prints usage naming the three verbs (exit 0)', () => {
    const r = main(['--help'], {});
    assert.equal(r.code, 0);
    for (const verb of ['red-proof', 'degrade', 'summary']) assert.match(r.stdout, new RegExp(verb));
  });
  it('an unknown verb / missing arguments are usage errors (exit 2)', () => {
    assert.equal(main(['mystery'], {}).code, 2);
    assert.equal(main([], {}).code, 2);
    assert.equal(main(['red-proof'], {}).code, 2);
    assert.equal(main(['degrade', '--backend', 'agy'], {}).code, 2, 'degrade without --reason is a usage refusal');
    assert.equal(main(['degrade', '--reason', 'why'], {}).code, 2, 'degrade without --backend is a usage refusal');
  });
  it('red-proof + degrade mint and report through the CLI (exit 0); refusals surface on stderr (exit 1)', () => {
    const { root } = makeRepo();
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\ntest('green case', () => { assert.equal(1, 1); });\n",
    );
    const env = fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' });
    const ok = main(['red-proof', 'lib.test.mjs#red case'], { cwd: root, env });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /red-proof/);
    const green = main(['red-proof', 'lib.test.mjs#green case'], { cwd: root, env });
    assert.equal(green.code, 1);
    assert.match(green.stderr, /observed GREEN/);
    const dg = main(['degrade', '--backend', 'agy', '--reason', 'declared'], { cwd: root, env });
    assert.equal(dg.code, 0, dg.stderr);
    assert.match(dg.stdout, /degrade/);
    rmSync(root, { recursive: true, force: true });
  });
});
