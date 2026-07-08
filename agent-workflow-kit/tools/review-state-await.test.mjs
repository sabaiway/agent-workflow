// review-state-await.test.mjs — the (d) `--await` verb (BUGFREE-3 / AD-049): block until every
// recipe-named backend has a fresh grounded current-fingerprint receipt (returns 0 as soon as the
// last one lands), a loud timeout when one never does, and a stale/ungrounded receipt never
// satisfies. The clock is injected so the test spends zero wall-clock.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mainAwait, computeTreeFingerprint, RECEIPTS_BASENAME } from './review-state.mjs';
import { READY } from './detect-backends.mjs';

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const detect = (codex = READY, agy = READY) => () => [
  { name: CODEX, readiness: codex },
  { name: AGY, readiness: agy },
];

const RECEIPT_FIXTURE = JSON.parse(
  '{"schema":1,"artifact":"code","fresh":true,"fingerprint":"<sha256hex>","backend":"codex","verdict":"ship","grounded":true,"factsHash":null,"wrapperVersion":"2.2.0","timestamp":"2026-07-08T12:00:00Z"}',
);
const COUNCIL_CONFIG = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });
const SOLO_CONFIG = JSON.stringify({ 'plan-execution': { review: 'solo' } });

const makeRepo = ({ config = COUNCIL_CONFIG } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'review-await-'));
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(root, 'base.txt'), 'committed base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), config);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# active plan\n');
  writeFileSync(join(root, 'pending.txt'), 'uncommitted work\n');
  return root;
};
const mint = (root, overrides) => appendFileSync(join(root, '.git', RECEIPTS_BASENAME), `${JSON.stringify({ ...RECEIPT_FIXTURE, ...overrides })}\n`);

// A hermetic clock: now() reads a mutable tick; sleep() advances it and fires an optional side effect
// (the receipt-lands-mid-await case).
const fakeClock = (onSleep) => {
  const clock = { t: 0 };
  return {
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; if (onSleep) onSleep(); },
    pollMs: 5000,
  };
};

describe('review-state --await', () => {
  it('returns 0 on the FIRST poll when every recipe-named backend is already receipted (no sleep)', async () => {
    const root = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, factsHash: 'a'.repeat(64) });
    let slept = 0;
    const clock = fakeClock(() => { slept += 1; });
    const r = await mainAwait(['--await'], { cwd: root, env: {}, detect: detect(), ...clock });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(slept, 0, 'both receipts present → ready immediately, never sleeps');
    assert.match(r.stdout, /READY/);
  });

  it('returns 0 as soon as the LAST backend receipt lands mid-await (the file gains a line)', async () => {
    const root = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    let slept = 0;
    // agy's receipt lands on the first sleep — the next poll sees it and returns ready.
    const clock = fakeClock(() => { slept += 1; if (slept === 1) mint(root, { backend: 'agy', fingerprint: fp, factsHash: 'b'.repeat(64) }); });
    const r = await mainAwait(['--await', '--timeout', '60'], { cwd: root, env: {}, detect: detect(), ...clock });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(slept, 1, 'one poll interval elapsed before the receipt landed');
    assert.match(r.stdout, /READY/);
  });

  it('loud TIMEOUT (exit 1) when a recipe-named backend never receipts — names the missing one', async () => {
    const root = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    const r = await mainAwait(['--await', '--timeout', '10'], { cwd: root, env: {}, detect: detect(), ...fakeClock() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TIMEOUT after 10s/);
    assert.match(r.stderr, /agy/, 'the timeout reason names the still-missing backend');
  });

  it('an UNGROUNDED receipt never satisfies (times out)', async () => {
    const root = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: fp, grounded: false });
    const r = await mainAwait(['--await', '--timeout', '10'], { cwd: root, env: {}, detect: detect(), ...fakeClock() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TIMEOUT/);
  });

  it('a stale-fingerprint receipt never satisfies (times out)', async () => {
    const root = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    mint(root, { backend: 'agy', fingerprint: 'stale'.repeat(12), factsHash: 'c'.repeat(64) });
    const r = await mainAwait(['--await', '--timeout', '10'], { cwd: root, env: {}, detect: detect(), ...fakeClock() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TIMEOUT/);
  });

  // codex council R2 (major): --await must not overshoot the deadline. With --timeout shorter than
  // the poll interval, the single bounded sleep reaches the deadline and the last backend's receipt
  // lands exactly then — it must read as TIMEOUT, never a post-deadline READY (the loop checks the
  // deadline BEFORE readiness once slept, and bounds each sleep to the remaining time).
  it('does NOT flip to READY for a receipt landing at or after the declared deadline (--timeout < poll interval)', async () => {
    const root = makeRepo();
    const fp = computeTreeFingerprint(root);
    mint(root, { backend: 'codex', fingerprint: fp });
    const clock = fakeClock(() => mint(root, { backend: 'agy', fingerprint: fp, factsHash: 'e'.repeat(64) }));
    const r = await mainAwait(['--await', '--timeout', '3'], { cwd: root, env: {}, detect: detect(), now: clock.now, sleep: clock.sleep, pollMs: 5000 });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a receipt landing at/after the deadline must not flip a timed-out await to READY');
    assert.match(r.stderr, /TIMEOUT after 3s/);
  });

  it('resolves instantly (0) under a solo recipe — nothing to await', async () => {
    const root = makeRepo({ config: SOLO_CONFIG });
    let slept = 0;
    const r = await mainAwait(['--await'], { cwd: root, env: {}, detect: detect(), ...fakeClock(() => { slept += 1; }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(slept, 0);
  });

  it('rejects an unknown flag mixed with --await (usage exit 2)', async () => {
    const r = await mainAwait(['--await', '--json'], {});
    assert.equal(r.code, 2);
    assert.match(r.stderr, /only --timeout/);
  });

  it('rejects a non-integer --timeout (usage exit 2)', async () => {
    const r = await mainAwait(['--await', '--timeout', 'soon'], {});
    assert.equal(r.code, 2);
    assert.match(r.stderr, /positive integer/);
  });

  // The CLI entry (isDirectRun) dispatches --await to mainAwait and everything else to main — a
  // subprocess smoke so both dispatch arms + the shared emitResult run end-to-end.
  it('CLI entry: --await dispatches to the await path (bounded timeout → loud TIMEOUT exit 1)', () => {
    const root = makeRepo();
    const script = fileURLToPath(new URL('./review-state.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--await', '--timeout', '1'], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /TIMEOUT after 1s/);
  });

  it('CLI entry: a non-await invocation dispatches to main (--json exits 0)', () => {
    const root = makeRepo();
    const script = fileURLToPath(new URL('./review-state.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--json'], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"fingerprint"/);
  });
});
