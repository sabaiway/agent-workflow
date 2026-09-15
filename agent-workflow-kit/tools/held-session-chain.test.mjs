import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { judgeHeldSession, threadVerdict } from './held-session.mjs';
import { buildThread, digestOf } from './delegation-harness.test.mjs';

const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const BRIEF_B = 'docs/plans/TASK-fixture-T2.md';
const OID_A = 'ab'.repeat(20);
const CHECKPOINT = { kind: 'checkpoint', treeOid: OID_A };
const HEAD_BASELINE = { kind: 'head', treeOid: null };
const HEAD = { state: 'ok', seconds: 1893456000 };
const TASK_A = { brief: BRIEF_A, files: ['src/a.mjs'] };
const TASK_B = { brief: BRIEF_B, files: ['src/b.mjs'] };
const judge = (records) => judgeHeldSession(records, { head: HEAD, backend: 'codex', degrades: [] });

const thread = ({ nonce, sessionId, second, task, baselineClean = false, retryOf = null,
  post = 'b2', baseline = task === undefined ? HEAD_BASELINE : CHECKPOINT, outcome = 'success', exitStatus = 0 }) => buildThread({
  dispatch: {
    ...(task === undefined ? {} : { task }),
    baseline,
    nonce,
    backend: 'codex',
    stepClass: 'code',
    baselineClean,
    retryOf,
    retryIndex: retryOf === null ? 0 : 1,
    timestamp: `2030-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    contractDigest: digestOf(`${second.toString(16)}c`),
    preTreeDigest: digestOf(`${second.toString(16)}a`),
  },
  returned: {
    sessionId, outcome, exitStatus,
    postTreeDigest: digestOf(post),
    timestamp: `2030-01-01T00:00:${String(second + 1).padStart(2, '0')}.000Z`,
  },
  fold: { timestamp: `2030-01-01T00:00:${String(second + 2).padStart(2, '0')}.000Z` },
});
const degrade = (dispatch) => ({
  schema: 1, kind: 'degrade', waveId: dispatch.waveId, nonce: dispatch.nonce,
  stepClass: dispatch.stepClass, rationale: 'withdraw the substituted attempt', timestamp: '2030-01-01T00:00:12.000Z',
});

describe('task chain judge — spec:task-thread/S3', () => {
  const a1 = thread({ nonce: 'a1', sessionId: 'session-a', second: 4, task: TASK_A });
  const b1 = thread({ nonce: 'b1', sessionId: 'session-b', second: 7, task: TASK_B });
  const u1 = thread({ nonce: 'u1', sessionId: 'session-u', second: 1, baselineClean: false });
  const u2 = thread({ nonce: 'u2', sessionId: 'session-u', second: 10, baselineClean: false });

  it('establishes a FIRST held session for each brief and leaves the untasked fields empty', () => {
    const facts = judge([...a1, ...b1]);
    assert.deepEqual(facts.chains, [
      { key: BRIEF_A, heldId: 'session-a', folds: 1, open: [] },
      { key: BRIEF_B, heldId: 'session-b', folds: 1, open: [] },
    ]);
    assert.equal(facts.heldId, null);
    assert.equal(facts.folds, 0);
    assert.deepEqual(facts.open, []);
    assert.equal(facts.substitution, null);
    assert.deepEqual(facts.threads, [
      { nonce: 'a1', expectedId: null, actualId: 'session-a', status: 'FIRST', baseKind: 'checkpoint', substituted: false, chainKey: BRIEF_A },
      { nonce: 'b1', expectedId: null, actualId: 'session-b', status: 'FIRST', baseKind: 'checkpoint', substituted: false, chainKey: BRIEF_B },
    ]);
  });

  it('lists an open task thread only inside its own chain', () => {
    const [dispatch] = thread({ nonce: 'a2', sessionId: 'session-a', second: 10, task: TASK_A });
    const facts = judge([...a1, ...b1, dispatch]);
    assert.deepEqual(facts.chains, [
      { key: BRIEF_A, heldId: 'session-a', folds: 1, open: [{ nonce: 'a2', expectedId: 'session-a' }] },
      { key: BRIEF_B, heldId: 'session-b', folds: 1, open: [] },
    ]);
    assert.deepEqual(facts.open, []);
    assert.deepEqual(threadVerdict(facts, 'a2'), {
      nonce: 'a2', expectedId: 'session-a', actualId: null, status: 'OPEN', baseKind: 'checkpoint', substituted: false, chainKey: BRIEF_A,
    });
  });

  it('reports an unfolded substitution in A without changing B', () => {
    const a2 = thread({ nonce: 'a2', sessionId: 'session-x', second: 10, task: TASK_A });
    const facts = judge([...a1, ...b1, ...a2.slice(0, 2)]);
    assert.deepEqual(facts.substitution, {
      nonce: 'a2', expectedId: 'session-a', actualId: 'session-x', postTreeDigest: digestOf('b2'), folded: false, baseKind: 'checkpoint',
    });
    assert.equal(threadVerdict(facts, 'b1').status, 'FIRST');
    assert.equal(threadVerdict(facts, 'b1').substituted, false);
    assert.deepEqual(facts.chains, [
      { key: BRIEF_A, heldId: 'session-a', folds: 1, open: [] },
      { key: BRIEF_B, heldId: 'session-b', folds: 1, open: [] },
    ]);
  });

  it('withdraws only A held session when its substituted checkpoint thread is degraded', () => {
    const a2 = thread({ nonce: 'a2', sessionId: 'session-x', second: 10, task: TASK_A });
    const facts = judge([...a1, ...b1, ...a2.slice(0, 2), degrade(a2[0])]);
    assert.deepEqual(facts.chains, [
      { key: BRIEF_A, heldId: null, folds: 0, open: [] },
      { key: BRIEF_B, heldId: 'session-b', folds: 1, open: [] },
    ]);
    assert.equal(facts.substitution, null);
    assert.equal(threadVerdict(facts, 'a2').substituted, false);
    assert.equal(threadVerdict(facts, 'b1').substituted, false);
  });

  it('continues a terminal attempt through its retry and replaces only A held session', () => {
    const a2 = thread({ nonce: 'a2', sessionId: 'session-x', second: 10, task: TASK_A, outcome: 'partial-edit', exitStatus: 1 });
    const a3 = thread({ nonce: 'a3', sessionId: 'session-y', second: 13, task: TASK_A, retryOf: 'a2' });
    const facts = judge([...a1, ...b1, ...a2.slice(0, 2), ...a3]);
    assert.deepEqual(facts.chains, [
      { key: BRIEF_A, heldId: 'session-y', folds: 1, open: [] },
      { key: BRIEF_B, heldId: 'session-b', folds: 1, open: [] },
    ]);
    assert.deepEqual(threadVerdict(facts, 'a3'), {
      nonce: 'a3', expectedId: 'session-a', actualId: 'session-y', status: 'CONTINUED', baseKind: 'checkpoint', substituted: false, chainKey: BRIEF_A,
    });
    assert.equal(facts.substitution, null);
  });

  it('counts folds against each chain held session independently', () => {
    const a2 = thread({ nonce: 'a2', sessionId: 'session-a', second: 10, task: TASK_A });
    const facts = judge([...a1, ...b1, ...a2]);
    assert.deepEqual(facts.chains, [
      { key: BRIEF_A, heldId: 'session-a', folds: 2, open: [] },
      { key: BRIEF_B, heldId: 'session-b', folds: 1, open: [] },
    ]);
    assert.equal(threadVerdict(facts, 'a2').status, 'CONTINUED');
  });

  it('keeps the top-level held session and fold count on the untasked chain', () => {
    const facts = judge([...u1, ...a1, ...u2]);
    assert.deepEqual(facts.chains, [
      { key: null, heldId: 'session-u', folds: 2, open: [] },
      { key: BRIEF_A, heldId: 'session-a', folds: 1, open: [] },
    ]);
    assert.equal(facts.heldId, 'session-u');
    assert.equal(facts.folds, 2);
    assert.deepEqual(facts.open, []);
    assert.equal(facts.substitution, null);
    assert.equal(threadVerdict(facts, 'u2').status, 'CONTINUED');
    for (const nonce of ['u1', 'u2']) assert.equal(threadVerdict(facts, nonce).chainKey, null);
  });

  it('finds a FIRST thread of the second chain through threadVerdict', () => {
    const facts = judge([...a1, ...b1]);
    assert.deepEqual(threadVerdict(facts, 'b1'), {
      nonce: 'b1', expectedId: null, actualId: 'session-b', status: 'FIRST', baseKind: 'checkpoint', substituted: false, chainKey: BRIEF_B,
    });
  });

  it('allows two task chains to hold the same session id without substitution', () => {
    const facts = judge([
      ...thread({ nonce: 'a1', sessionId: 'session-s', second: 4, task: TASK_A }),
      ...thread({ nonce: 'b1', sessionId: 'session-s', second: 7, task: TASK_B }),
    ]);
    assert.deepEqual(facts.chains, [
      { key: BRIEF_A, heldId: 'session-s', folds: 1, open: [] },
      { key: BRIEF_B, heldId: 'session-s', folds: 1, open: [] },
    ]);
    assert.equal(facts.substitution, null);
  });

  it('preserves the complete report shape when no task thread exists', () => {
    const facts = judge([...u1, ...u2]);
    assert.equal(Object.hasOwn(facts, 'chains'), false);
    for (const entry of facts.threads) assert.equal(Object.hasOwn(entry, 'chainKey'), false);
    assert.deepEqual(facts, {
      state: 'ok', heldId: 'session-u', folds: 2, substitution: null, open: [],
      threads: [
        { nonce: 'u1', expectedId: null, actualId: 'session-u', status: 'FIRST', baseKind: 'head', substituted: false },
        { nonce: 'u2', expectedId: 'session-u', actualId: 'session-u', status: 'CONTINUED', baseKind: 'head', substituted: false },
      ],
    });
  });
});
