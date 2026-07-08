// from-receipts.test.mjs — the (g) `record --from-receipts` drafter (BUGFREE-3 / AD-049): it drafts
// backends[] from the current-fingerprint receipt statuses + the orchestrator's supplied findings, a
// missing receipt is a LOUD stop, an explicit (degraded) backend passes through verbatim, and the
// assembled record validates.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { draftBackendsFromReceipts, LEDGER_WRITE_STOP } from './review-ledger-write.mjs';
import { validateRecord, SCHEMA_VERSION } from './review-ledger.mjs';

// A synthetic buildState result — the only surface the drafter reads.
const stateOf = (backends) => ({ requiredBackends: backends.map((b) => b.backend), backends });
const current = (backend, verdict) => ({ backend, state: 'current', verdict, grounded: true });

describe('draftBackendsFromReceipts', () => {
  it('drafts { backend, verdict } from receipts with counts computed from the supplied findings', () => {
    const state = stateOf([current('codex', 'ship'), current('agy', 'revise')]);
    const findings = [
      { findingKey: 'F1', severity: 'major', origin: 'first-draft', backend: 'agy' },
      { findingKey: 'F2', severity: 'minor', origin: 'mechanics', backend: 'agy' },
    ];
    const drafted = draftBackendsFromReceipts({ state, findings });
    assert.deepEqual(drafted, [
      { backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' },
      { backend: 'agy', degraded: false, blockers: 0, majors: 1, minors: 1, verdict: 'revise' },
    ]);
  });

  it('a recipe-named backend with no fresh grounded receipt is a LOUD stop (never invented)', () => {
    const state = stateOf([current('codex', 'ship'), { backend: 'agy', state: 'stale', verdict: null }]);
    assert.throws(
      () => draftBackendsFromReceipts({ state, findings: [] }),
      (e) => { assert.equal(e.code, LEDGER_WRITE_STOP); assert.match(e.message, /no fresh grounded code receipt for agy/); return true; },
    );
  });

  // codex council R1 (major): an explicit row must be honored verbatim ONLY when degraded:true. A
  // NON-degraded explicit row would bypass the receipt-derived verdict --from-receipts exists to
  // compute (a stale hand-composed row silently winning) — a loud STOP, fail-closed.
  it('an explicit non-degraded backends[] row is a loud STOP (never bypasses the receipt-derived verdict)', () => {
    const state = stateOf([current('codex', 'ship'), current('agy', 'revise')]);
    const staleRow = { backend: 'agy', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' };
    assert.throws(
      () => draftBackendsFromReceipts({ state, findings: [], explicitBackends: [staleRow] }),
      (e) => { assert.equal(e.code, LEDGER_WRITE_STOP); assert.match(e.message, /explicit non-degraded/); return true; },
    );
  });

  it('an explicit (degraded) backend passes through verbatim — the draft never overrides it', () => {
    const state = stateOf([current('codex', 'ship'), { backend: 'agy', state: 'missing', verdict: null }]);
    const explicit = { backend: 'agy', degraded: true, blockers: 0, majors: 0, minors: 0, verdict: 'degraded', reason: 'agy bridge down' };
    const drafted = draftBackendsFromReceipts({ state, findings: [], explicitBackends: [explicit] });
    assert.deepEqual(drafted, [
      { backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' },
      explicit,
    ]);
  });

  it('the assembled round record validates (findings-by-severity == drafted counts)', () => {
    const state = stateOf([current('codex', 'ship'), current('agy', 'revise')]);
    const findings = [{ findingKey: 'F1', severity: 'major', origin: 'first-draft', backend: 'agy' }];
    const backends = draftBackendsFromReceipts({ state, findings });
    const record = {
      schema: SCHEMA_VERSION, loop: 'demo', activity: 'plan-execution', kind: 'round', round: 1,
      base: 'abc123', fingerprint: 'deadbeef',
      origins: { 'first-draft': 1, 'fold-induced': 0, mechanics: 0 },
      backends, findings, timestamp: '2026-07-08T12:00:00Z',
    };
    const v = validateRecord(record);
    assert.equal(v.ok, true, v.reason);
  });

  // The CLI wiring for `record --from-receipts` — a subprocess smoke so parseArgs' flag + the
  // buildState → draft path in main() run end-to-end. It uses an EXPLICIT solo recipe so the outcome
  // is deterministic regardless of whether the review backends are installed (a real detectBackends
  // runs in the subprocess): solo → no recipe-named backends → the draft returns [] and recordRound
  // loudly refuses the empty round. The council no-receipt STOP is covered in-process above with an
  // injected state.
  it('CLI: `record --from-receipts` reaches the draft (subprocess smoke; loud refusal, exit 1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'from-receipts-cli-'));
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 'p@e.com'); g('config', 'user.name', 'p');
    writeFileSync(join(root, 'base.txt'), 'base\n'); g('add', '-A'); g('commit', '-qm', 'base');
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'solo' } }));
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# plan\n');
    writeFileSync(join(root, 'pending.txt'), 'work\n');
    const script = fileURLToPath(new URL('./review-ledger-write.mjs', import.meta.url));
    const payload = JSON.stringify({ loop: 'active-plan', round: 1, origins: { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 }, findings: [] });
    const r = spawnSync(process.execPath, [script, 'record', '--from-receipts', '--json', payload, '--cwd', root], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /refusing/);
  });
});
