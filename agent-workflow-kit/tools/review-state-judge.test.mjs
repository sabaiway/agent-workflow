import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECEIPT_FIXTURE } from './review-state-harness.test.mjs';
import { HELD_EXECUTE_WRAPPER } from './held-session.mjs';
const judge = await import('./review-state-judge.mjs').catch(() => ({}));
const absent = (name) => () => {
  throw new Error(`absent: ${name}`);
};
const backendReceiptStatus = judge.backendReceiptStatus ?? absent('backendReceiptStatus');
const degradeRecordSet = judge.degradeRecordSet ?? absent('degradeRecordSet');
const shouldReadHeldSession = judge.shouldReadHeldSession ?? absent('shouldReadHeldSession');
const buildHeldSessionState = judge.buildHeldSessionState ?? absent('buildHeldSessionState');
const selectHeldSessionDegrades = judge.selectHeldSessionDegrades ?? absent('selectHeldSessionDegrades');
const decideCheck = judge.decideCheck ?? absent('decideCheck');
  const cleanState = (overrides = {}) => ({
    obligations: { recipe: 'council', source: 'config' }, malformed: 0, evidenceUnavailable: false, receiptsReadError: null,
    plans: ['active-plan.md'], fingerprint: 'current', clean: true, ...overrides,
  });

describe('review-state judge stands alone — spec:review-state/S5', () => {
  it('prefers a grounded current receipt over an earlier ungrounded one', () => {
    const fp = 'f'.repeat(64);
    const receipts = [
      { ...RECEIPT_FIXTURE, backend: 'agy', fingerprint: fp, grounded: false, delivery: 'inline' },
      { ...RECEIPT_FIXTURE, backend: 'agy', fingerprint: fp, grounded: true, verdict: 'SHIP', delivery: 'inline' },
    ];
    const s = backendReceiptStatus(receipts, 'agy', fp);
    assert.equal(s.state, 'current');
    assert.equal(s.verdict, 'SHIP');
  });

  it('an ungrounded unrecognized verdict reports grounded:false (the receipt, never a hardcode)', () => {
    const fp = 'f'.repeat(64);
    const receipts = [{ ...RECEIPT_FIXTURE, backend: 'codex', fingerprint: fp, verdict: 'unknown', grounded: false }];
    const s = backendReceiptStatus(receipts, 'codex', fp);
    assert.equal(s.state, 'unrecognized-verdict');
    assert.equal(s.grounded, false, 'the grounded boolean comes from the receipt');
  });

  it('the REVERSE order pins selection-first: a grounded SHIP followed by a LATER ungrounded → ungrounded (the earlier SHIP never survives)', () => {
    const fp = 'f'.repeat(64);
    const receipts = [
      { ...RECEIPT_FIXTURE, backend: 'agy', fingerprint: fp, grounded: true, verdict: 'SHIP', delivery: 'inline' },
      { ...RECEIPT_FIXTURE, backend: 'agy', fingerprint: fp, grounded: false, verdict: 'SHIP', delivery: 'inline' },
    ];
    const s = backendReceiptStatus(receipts, 'agy', fp);
    assert.equal(s.state, 'ungrounded', 'the LATEST normal receipt is selected first and then judged');
  });

  it('a plan name with a C1 line break (U+0085) stays on one report line, escaped as valid JSON', () => {
    const name = 'line\u0085break.md';
    const result = decideCheck(cleanState({ plans: [name] }));
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.reason, /\u0085/u, 'U+0085 never reaches the report literally');
    assert.match(result.reason, /"line\\u0085break\.md"/, 'the plan name is escaped inside the one-line result');
    assert.match(result.reason, /arms as soon as the tree is dirty/, 'the notice remains on that same line');
    // Every emitted token is a valid JSON string (the escape round-trips) \u2014 the report stays parseable.
    const token = result.reason.match(/"line[^"]*break\.md"/)[0];
    assert.equal(JSON.parse(token), 'line\u0085break.md', 'quoteReportName emits a JSON-parseable token');
  });

  it('configured solo on a clean tree with a plan exits 0 without the latent-arm notice', () => {
    const result = decideCheck(cleanState({ obligations: { recipe: 'solo', source: 'config' } }));
    const modeDoc = readFileSync(new URL('../references/modes/review-state.md', import.meta.url), 'utf8');
    assert.equal(result.code, 0);
    assert.match(result.reason, /configured .* recipe is solo/, 'the earlier solo arm remains explicit');
    assert.doesNotMatch(result.reason, /arms as soon as the tree is dirty/, 'solo carries no latent review obligation');
    assert.match(modeDoc, /A clean-tree PASS under a NON-SOLO review obligation/, 'the documented notice is limited to the arm that can actually activate');
  });

  it('the degrade escape accepts only this tree and denies a malformed store', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'review-state-judge-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = join(dir, 'evidence.jsonl');
    const F = 'f'.repeat(64);
    const record = (backend, fingerprint) => ({
      schema: 1, kind: 'degrade', backend, reason: 'backend unavailable for this tree', fingerprint, timestamp: '2026-07-16T00:00:00Z',
    });
    const agy = JSON.stringify(record('agy', F));
    writeFileSync(store, `${agy}\n${JSON.stringify(record('codex', 'e'.repeat(64)))}\n`);
    const args = { cwd: dir, env: { AW_CORE_EVIDENCE: store }, fingerprint: F };
    const result = degradeRecordSet(args);
    assert.deepEqual([...result.set], ['agy']);
    assert.equal(result.unavailable, false);
    assert.equal(result.records.length, 2);
    assert.equal(result.storePath, store);
    assert.deepEqual([...degradeRecordSet({ ...args, fingerprint: null }).set], []);
    writeFileSync(store, `${agy}\njunk\n`);
    const malformed = degradeRecordSet(args);
    assert.deepEqual([...malformed.set], []);
    assert.equal(malformed.unavailable, true);
    assert.equal(malformed.malformed, 1);
    assert.equal(malformed.records.length, 0);
  });

  it('the held-session arm reads only a delegated dirty tree and selects its wrapper degrades', () => {
    const base = { configuredExecute: 'delegated', plans: ['p.md'], fingerprint: 'f'.repeat(64), clean: false };
    assert.equal(shouldReadHeldSession(base), true);
    assert.equal(shouldReadHeldSession({ ...base, configuredExecute: undefined }), false);
    assert.equal(shouldReadHeldSession({ ...base, configuredExecute: 'solo' }), false);
    assert.equal(shouldReadHeldSession({ ...base, plans: [] }), false);
    assert.equal(shouldReadHeldSession({ ...base, fingerprint: null }), false);
    assert.equal(shouldReadHeldSession({ ...base, clean: true }), false);
    assert.equal(shouldReadHeldSession({ ...base, clean: null }), false);
    const boom = () => {
      throw new Error('the ledger must not be read');
    };
    assert.equal(buildHeldSessionState({ cwd: '/nowhere', env: {}, ...base, configuredExecute: undefined, degrades: [], resolveStore: boom, readStore: boom, audit: boom, readHead: boom }), null);
    const records = [
      { kind: 'degrade', backend: 'codex-exec', n: 1 },
      { kind: 'degrade', backend: 'codex', n: 2 },
      { kind: 'red-proof', backend: 'codex-exec', n: 3 },
    ];
    assert.equal(HELD_EXECUTE_WRAPPER, 'codex-exec');
    assert.deepEqual(selectHeldSessionDegrades(records), [records[0]]);
  });
});
