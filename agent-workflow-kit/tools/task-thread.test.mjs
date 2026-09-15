import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateDelegationRecord, isThreadTerminalRecord } from './dispatch-record.mjs';
import { auditDelegationStoreSemantics } from './dispatch-store-read.mjs';
import { buildDispatch, buildRegistration, buildReturn, buildThread } from './delegation-harness.test.mjs';

const loaded = await import('./task-thread.mjs').catch(() => ({}));
const absent = (name) => () => { throw new Error(`task-thread.mjs is absent: ${name}`); };
const readsTask = loaded.readsTask ?? absent('readsTask');
const validateTask = loaded.validateTask ?? absent('validateTask');
const readsInsideEpoch = loaded.readsInsideEpoch ?? absent('readsInsideEpoch');
const claimedPaths = loaded.claimedPaths ?? absent('claimedPaths');
const epochClaims = loaded.epochClaims ?? absent('epochClaims');

const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const OID_A = 'ab'.repeat(20);
const OID_B = 'cd'.repeat(20);
const CHECKPOINT = { kind: 'checkpoint', treeOid: OID_A };
const HEAD_BASELINE = { kind: 'head', treeOid: null };
const HEAD = { state: 'ok', seconds: 1893456000 };
const makeTask = (overrides = {}) => ({ brief: BRIEF_A, files: ['src/a.mjs'], ...overrides });
const assertRefusal = (result, reason) => {
  assert.equal(result.ok, false);
  assert.match(result.reason, reason);
};

describe('task grammar — spec:task-thread/S1', () => {
  it('accepts the supported briefs and byte-ordered normalized files on a checkpoint', () => {
    for (const brief of ['docs/plans/TASK-fixture-chain-T1.md', 'docs/plans/TASK-x-T12.md']) {
      for (const files of [['src/a.mjs'], ['B.mjs', 'a.mjs'], ['a.git/b', 'docs/.github/x.yml']]) {
        assert.deepEqual(validateTask({ brief, files }, 'checkpoint'), { ok: true });
      }
    }
  });

  it('orders files by UTF-8 bytes, not UTF-16 code units', () => {
    assert.deepEqual(validateTask(makeTask({ files: ['a\u{E000}', 'a\u{10000}'] }), 'checkpoint'), { ok: true });
    assertRefusal(validateTask(makeTask({ files: ['a\u{10000}', 'a\u{E000}'] }), 'checkpoint'), /\btask-files\b/u);
  });

  it('refuses every invalid brief with task-brief', () => {
    for (const brief of [
      42, '', 'docs/plans/fixture-chain.md', 'docs/plans/TASK-x-T1.txt',
      'plans/TASK-x-T1.md', '/docs/plans/TASK-x-T1.md', 'docs/plans/sub/TASK-x-T1.md',
      'docs/plans/TASK-x.md', 'docs/plans/TASK-x-Tn.md', 'docs/plans/TASK-x-T1-a1.md',
    ]) {
      assertRefusal(validateTask(makeTask({ brief }), 'checkpoint'), /\btask-brief\b/u);
    }
  });

  it('refuses every invalid files list with task-files', () => {
    for (const files of [
      null, [], [42], ['a.mjs', 'B.mjs'], ['src/a.mjs', 'src/a.mjs'],
      [''], ['src//a.mjs'], ['src/a/'], ['src/./a.mjs'], ['src/../a.mjs'],
      ['.git/config'], ['src/.git/x'], ['/src/a.mjs'], ['lib/util', 'lib/util/x.mjs'],
    ]) {
      assertRefusal(validateTask(makeTask({ files }), 'checkpoint'), /\btask-files\b/u);
    }
  });

  it('refuses a valid task on a head base with task-base', () => {
    assertRefusal(validateTask(makeTask(), 'head'), /\btask-base\b/u);
  });

  it('accepts a dispatch carrying a valid checkpoint task', () => {
    const dispatch = buildDispatch({ baseline: CHECKPOINT, task: makeTask() });
    assert.deepEqual(validateDelegationRecord(dispatch), { ok: true });
  });

  it('refuses a stray nested task key by name', () => {
    const dispatch = buildDispatch({ baseline: CHECKPOINT, task: makeTask({ extra: true }) });
    assertRefusal(validateDelegationRecord(dispatch), /unknown field "extra"/u);
  });

  it('refuses a missing nested files key by name', () => {
    const dispatch = buildDispatch({ baseline: CHECKPOINT, task: { brief: BRIEF_A } });
    assertRefusal(validateDelegationRecord(dispatch), /missing field "files"/u);
  });

  it('refuses a missing nested brief key by name', () => {
    const dispatch = buildDispatch({ baseline: CHECKPOINT, task: { files: ['src/a.mjs'] } });
    assertRefusal(validateDelegationRecord(dispatch), /missing field "brief"/u);
  });

  it('refuses a task on an explicit head dispatch with task-base', () => {
    const dispatch = buildDispatch({ baseline: HEAD_BASELINE, task: makeTask() });
    assertRefusal(validateDelegationRecord(dispatch), /\btask-base\b/u);
  });

  it('refuses a task on a dispatch without baseline with task-base', () => {
    const dispatch = buildDispatch({ task: makeTask() });
    assert.equal(Object.hasOwn(dispatch, 'baseline'), false);
    assertRefusal(validateDelegationRecord(dispatch), /\btask-base\b/u);
  });

  it('refuses unsorted task files through the record with task-files', () => {
    const dispatch = buildDispatch({ baseline: CHECKPOINT, task: makeTask({ files: ['a.mjs', 'B.mjs'] }) });
    assertRefusal(validateDelegationRecord(dispatch), /\btask-files\b/u);
  });

  it('reads null when a dispatch has no task key', () => {
    assert.equal(readsTask(buildDispatch()), null);
  });

  it('reads null when a task is inherited through the prototype', () => {
    const dispatch = Object.assign(Object.create({ task: makeTask() }), buildDispatch());
    assert.equal(readsTask(dispatch), null);
  });

  it('reads a fresh task object and files array for an own task', () => {
    const dispatch = buildDispatch({ baseline: CHECKPOINT, task: makeTask() });
    const task = readsTask(dispatch);
    assert.deepEqual(task, dispatch.task);
    assert.notEqual(task, dispatch.task);
    assert.notEqual(task.files, dispatch.task.files);
    const next = readsTask(dispatch);
    assert.deepEqual(next, task);
    assert.notEqual(next, task);
    assert.notEqual(next.files, task.files);
  });

  it('accepts pre-field dispatches with absent, head and checkpoint baselines and reads null', () => {
    const dispatches = [buildDispatch(), buildDispatch({ baseline: HEAD_BASELINE }), buildDispatch({ baseline: CHECKPOINT })];
    for (const dispatch of dispatches) assert.deepEqual(validateDelegationRecord(dispatch), { ok: true });
    for (const dispatch of dispatches) assert.equal(readsTask(dispatch), null);
  });

  it('accepts a ledger minted before the task field and reads its dispatch as null', () => {
    const records = [buildRegistration(), ...buildThread()];
    for (const record of records) assert.deepEqual(validateDelegationRecord(record), { ok: true });
    assert.deepEqual(auditDelegationStoreSemantics({ records }), { ok: true });
    assert.equal(readsTask(records[1]), null);
  });
});

describe('task-thread epoch and claims', () => {
  it('includes every dispatch when the head is unborn', () => {
    for (const timestamp of ['2029-12-31T23:59:00.000Z', 'invalid']) {
      assert.equal(readsInsideEpoch(buildDispatch({ timestamp }), { state: 'unborn' }), true);
    }
  });

  it('excludes dispatches before the head instant', () => {
    assert.equal(readsInsideEpoch(buildDispatch({ timestamp: '2029-12-31T23:59:59.000Z' }), HEAD), false);
  });

  it('excludes dispatches at the head instant', () => {
    assert.equal(readsInsideEpoch(buildDispatch({ timestamp: '2030-01-01T00:00:00.000Z' }), HEAD), false);
  });

  it('excludes dispatches within the same second as the head', () => {
    assert.equal(readsInsideEpoch(buildDispatch({ timestamp: '2030-01-01T00:00:00.999Z' }), HEAD), false);
  });

  it('includes dispatches one second after the head', () => {
    assert.equal(readsInsideEpoch(buildDispatch({ timestamp: '2030-01-01T00:00:01.000Z' }), HEAD), true);
  });

  it('excludes unparseable timestamps when the head exists', () => {
    assert.equal(readsInsideEpoch(buildDispatch({ timestamp: 'invalid' }), HEAD), false);
  });

  const buildTaskDispatch = (nonce, files, overrides = {}) => buildDispatch({
    nonce, baseline: CHECKPOINT, task: makeTask({ files }), ...overrides,
  });
  const open = buildTaskDispatch('o', ['src/a.mjs']);
  const returned = buildTaskDispatch('r', ['src/r.mjs']);
  const folded = buildThread({ dispatch: {
    nonce: 'f', baseline: CHECKPOINT, task: makeTask({ files: ['src/f.mjs'] }),
  } });
  const degraded = buildTaskDispatch('d', ['src/d.mjs']);
  const terminal = buildTaskDispatch('t', ['src/t.mjs']);
  const records = [
    open,
    returned, buildReturn(returned),
    ...folded,
    degraded, {
      schema: degraded.schema, kind: 'degrade', waveId: degraded.waveId, nonce: degraded.nonce,
      stepClass: degraded.stepClass, rationale: 'withdraw this thread', timestamp: '2030-01-01T00:00:02.000Z',
    },
    terminal, buildReturn(terminal, { outcome: 'partial-edit', exitStatus: 1 }),
    buildTaskDispatch('b', ['src/b.mjs'], { baseline: { kind: 'checkpoint', treeOid: OID_B } }),
    buildDispatch({ nonce: 'u', baseline: CHECKPOINT }),
    buildTaskDispatch('old', ['src/old.mjs'], { timestamp: '2029-12-31T23:59:00.000Z' }),
    buildTaskDispatch('dup', ['src/a.mjs']),
  ];

  it('claims distinct byte-ordered paths of open and folded task threads on the first base', () => {
    assert.deepEqual(claimedPaths(records, OID_A, HEAD, isThreadTerminalRecord), ['src/a.mjs', 'src/f.mjs', 'src/r.mjs']);
  });

  it('claims only the second base paths when that base is requested', () => {
    assert.deepEqual(claimedPaths(records, OID_B, HEAD, isThreadTerminalRecord), ['src/b.mjs']);
  });

  it('lists open and folded claims across bases in dispatch order', () => {
    assert.deepEqual(epochClaims(records, HEAD, isThreadTerminalRecord), [
      { nonce: 'o', brief: BRIEF_A, files: ['src/a.mjs'], state: 'open' },
      { nonce: 'r', brief: BRIEF_A, files: ['src/r.mjs'], state: 'open' },
      { nonce: 'f', brief: BRIEF_A, files: ['src/f.mjs'], state: 'folded' },
      { nonce: 'b', brief: BRIEF_A, files: ['src/b.mjs'], state: 'open' },
      { nonce: 'dup', brief: BRIEF_A, files: ['src/a.mjs'], state: 'open' },
    ]);
  });
});
