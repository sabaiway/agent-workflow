import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditDelegationStoreSemantics, readDelegationLedger, readHeadInstant,
} from './dispatch-store-read.mjs';
import {
  buildDispatch, buildFold, buildRegistration, buildReturn, buildThread, digestOf,
} from './delegation-harness.test.mjs';

const loaded = await import('./held-session.mjs').catch(() => ({}));
const judgeHeldSession = loaded.judgeHeldSession ?? (() => ({}));
const decideHeldSession = loaded.decideHeldSession ?? (() => ({}));
const judgeLedger = loaded.judgeLedger ?? (() => ({}));

const HEAD = { state: 'ok', seconds: 1893456000 };
const LEDGER_OPTIONS = { backend: 'codex', degrades: [] };
const OPTIONS = { head: HEAD, ...LEDGER_OPTIONS };
const judge = (records, overrides = {}) => judgeHeldSession(records, { ...OPTIONS, ...overrides });

const thread = ({ nonce, sessionId, second, baselineClean = false, backend = 'codex', stepClass = 'code', retryOf = null, post = 'b2' }) => buildThread({
  dispatch: {
    nonce,
    backend,
    stepClass,
    baselineClean,
    retryOf,
    retryIndex: retryOf === null ? 0 : 1,
    timestamp: `2030-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    contractDigest: digestOf(`${second.toString(16)}c`),
    preTreeDigest: digestOf(`${second.toString(16)}a`),
  },
  returned: {
    sessionId,
    postTreeDigest: digestOf(post),
    timestamp: `2030-01-01T00:00:${String(second + 1).padStart(2, '0')}.000Z`,
  },
  fold: { timestamp: `2030-01-01T00:00:${String(second + 2).padStart(2, '0')}.000Z` },
});

describe('held-session judge — spec:held-session/S1', () => {
  it('holds nothing before the first folded code thread', () => {
    assert.equal(typeof loaded.judgeHeldSession, 'function', 'held-session.mjs must export judgeHeldSession');
    const dispatch = buildDispatch({ timestamp: '2030-01-01T00:00:01.000Z' });
    const facts = judge([dispatch, buildReturn(dispatch)]);
    assert.equal(facts.heldId, null);
    assert.equal(facts.threads[0].status, 'FIRST');
  });

  it('continues the held id and counts folds that rode the final held session', () => {
    const records = [
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      ...thread({ nonce: 'continued', sessionId: 'session-held', second: 4, post: 'b2' }),
    ];
    const facts = judge(records);
    assert.equal(facts.heldId, 'session-held');
    assert.equal(facts.folds, 2);
    assert.equal(facts.substitution, null);
    assert.equal(facts.threads.at(-1).status, 'CONTINUED');
  });

  it('keeps a degrade-covered replacement covered after a later continued fold', () => {
    const replacement = thread({ nonce: 'replacement', sessionId: 'session-new', second: 4, post: 'b2' });
    const records = [
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      ...replacement,
      ...thread({ nonce: 'continued', sessionId: 'session-new', second: 7, post: 'b3' }),
    ];
    const facts = judge(records, { degrades: [{ fingerprint: replacement[1].postTreeDigest }] });
    assert.equal(facts.heldId, 'session-new');
    assert.equal(facts.substitution, null);
    assert.equal(facts.folds, 2);
  });

  it('names a substituted dirty thread and keeps HELD through its fold', () => {
    const records = [
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      ...thread({ nonce: 'wrong', sessionId: 'session-new', second: 4, post: 'b2' }),
    ];
    const facts = judge(records);
    assert.deepEqual(facts.substitution, {
      nonce: 'wrong', expectedId: 'session-held', actualId: 'session-new',
      postTreeDigest: digestOf('b2'), folded: true,
    });
    assert.equal(facts.heldId, 'session-held');
    assert.equal(facts.folds, 1);
    const decision = decideHeldSession(facts);
    assert.equal(decision.code, 1);
    assert.match(decision.reason, /wrong.*session-held.*session-new/u);
  });

  it('treats a retryOf dispatch as an exception and moves HELD when it folds', () => {
    const failedDispatch = buildDispatch({ nonce: 'failed', baselineClean: false, timestamp: '2030-01-01T00:00:04.000Z' });
    const failedReturn = buildReturn(failedDispatch, { outcome: 'transport-failure', exitStatus: 1, sessionId: 'session-lost', timestamp: '2030-01-01T00:00:05.000Z' });
    const records = [
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      failedDispatch,
      failedReturn,
      ...thread({ nonce: 'retry', sessionId: 'session-retry', second: 7, retryOf: 'failed', post: 'b3' }),
    ];
    const facts = judge(records);
    assert.equal(facts.heldId, 'session-retry');
    assert.equal(facts.substitution, null);
    assert.equal(facts.threads.find((item) => item.nonce === 'retry').status, 'CONTINUED');
  });

  it('clears only the substitutions in its own retry chain', () => {
    const substituted = thread({ nonce: 'substituted', sessionId: 'session-x', second: 4, post: 'b2' });
    const failedDispatch = buildDispatch({
      nonce: 'failed', baselineClean: false, contractDigest: digestOf('c3'),
      preTreeDigest: digestOf('a3'), timestamp: '2030-01-01T00:00:07.000Z',
    });
    const failedReturn = buildReturn(failedDispatch, {
      sessionId: 'session-lost', postTreeDigest: digestOf('b3'),
      outcome: 'transport-failure', exitStatus: 1,
      timestamp: '2030-01-01T00:00:08.000Z',
    });
    const records = [
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      ...substituted,
      failedDispatch,
      failedReturn,
      ...thread({ nonce: 'retry', sessionId: 'session-z', second: 10, retryOf: 'failed', post: 'b4' }),
    ];
    const facts = judge(records);
    assert.equal(facts.heldId, 'session-z');
    assert.deepEqual(facts.substitution, {
      nonce: 'substituted', expectedId: 'session-held', actualId: 'session-x',
      postTreeDigest: digestOf('b2'), folded: true,
    });
    const covered = judge(records, { degrades: [{ fingerprint: substituted[1].postTreeDigest }] });
    assert.equal(covered.heldId, 'session-z');
    assert.equal(covered.substitution, null);
  });

  it('exposes an open dirty thread without calling it a substitution', () => {
    const records = [...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' })];
    records.push(buildDispatch({ nonce: 'open', baselineClean: false, timestamp: '2030-01-01T00:00:05.000Z' }));
    const facts = judge(records);
    assert.equal(facts.substitution, null);
    assert.deepEqual(facts.open, [{ nonce: 'open', expectedId: 'session-held' }]);
  });

  it('treats a null-session return as FAILED and never as a substitution', () => {
    const failedDispatch = buildDispatch({
      nonce: 'failed', baselineClean: false, contractDigest: digestOf('c2'),
      preTreeDigest: digestOf('a2'), timestamp: '2030-01-01T00:00:04.000Z',
    });
    const failedReturn = buildReturn(failedDispatch, {
      sessionId: null, outcome: 'transport-failure', exitStatus: 1,
      timestamp: '2030-01-01T00:00:05.000Z',
    });
    const facts = judge([
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      failedDispatch,
      failedReturn,
    ]);
    assert.equal(facts.threads.find((item) => item.nonce === 'failed').status, 'FAILED');
    assert.equal(facts.substitution, null);
    assert.equal(decideHeldSession(facts).code, 0);
    assert.equal(facts.heldId, 'session-held');
  });

  it('consults the replacement escape at an unfolded substituted return', () => {
    const substitutedDispatch = buildDispatch({
      nonce: 'substituted', baselineClean: false, contractDigest: digestOf('c2'),
      preTreeDigest: digestOf('a2'), timestamp: '2030-01-01T00:00:04.000Z',
    });
    const substitutedReturn = buildReturn(substitutedDispatch, {
      sessionId: 'session-new', postTreeDigest: digestOf('b2'),
      timestamp: '2030-01-01T00:00:05.000Z',
    });
    const records = [
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      substitutedDispatch,
      substitutedReturn,
    ];
    const uncovered = judge(records);
    assert.deepEqual(uncovered.substitution, {
      nonce: 'substituted', expectedId: 'session-held', actualId: 'session-new',
      postTreeDigest: substitutedReturn.postTreeDigest, folded: false,
    });
    const covered = judge(records, { degrades: [{ fingerprint: substitutedReturn.postTreeDigest }] });
    assert.equal(covered.substitution, null);
    assert.equal(covered.heldId, 'session-held');
  });

  it('ignores non-code and foreign-backend threads', () => {
    const records = [
      ...thread({ nonce: 'draft', sessionId: 'session-draft', second: 1, stepClass: 'draft', post: 'b1' }),
      ...thread({ nonce: 'foreign', sessionId: 'session-foreign', second: 4, backend: 'agy', post: 'b2' }),
    ];
    const facts = judge(records);
    assert.equal(facts.heldId, null);
    assert.deepEqual(facts.threads, []);
  });

  it('excludes records before HEAD and the same-second collision', () => {
    const before = thread({ nonce: 'before', sessionId: 'session-before', second: 1, baselineClean: true, post: 'b1' });
    const same = thread({ nonce: 'same', sessionId: 'session-same', second: 3, baselineClean: true, post: 'b2' });
    const facts = judge([...before, ...same], { head: { state: 'ok', seconds: 1893456003 } });
    assert.equal(facts.heldId, null);
    assert.deepEqual(facts.threads, []);
  });

  it('follows a moved HEAD boundary and contains clock skew in the no-hold direction', () => {
    const records = thread({ nonce: 'epoch', sessionId: 'session-epoch', second: 5, baselineClean: true, post: 'b1' });
    assert.equal(judge(records, { head: { state: 'ok', seconds: 1893456004 } }).heldId, 'session-epoch');
    assert.equal(judge(records, { head: { state: 'ok', seconds: 1893456005 } }).heldId, null);
    assert.equal(judge(records, { head: { state: 'ok', seconds: 1993456005 } }).heldId, null);
  });

  it('judges all composed ledger states and refuses an epoch error', () => {
    const records = thread({ nonce: 'unborn', sessionId: 'session-unborn', second: 1, baselineClean: true, post: 'b1' });
    assert.equal(judge(records, { head: { state: 'unborn' } }).heldId, 'session-unborn');
    const error = judge(records, { head: { state: 'error', reason: 'git probe failed' } });
    assert.equal(error.state, 'error');
    assert.match(error.reason, /git probe failed/u);
    assert.equal(decideHeldSession(error).code, 1);
    assert.equal(judgeLedger({ state: 'absent' }, LEDGER_OPTIONS).state, 'absent');
    const ledgerError = judgeLedger({ state: 'error', reason: 'ledger refused' }, LEDGER_OPTIONS);
    assert.deepEqual({ state: ledgerError.state, cause: ledgerError.cause, reason: ledgerError.reason }, {
      state: 'error', cause: 'ledger', reason: 'ledger refused',
    });
    const ledgerOk = judgeLedger({ state: 'ok', records, head: { state: 'unborn' } }, LEDGER_OPTIONS);
    assert.equal(ledgerOk.heldId, 'session-unborn');
  });

  it('distinguishes an unborn branch from a failed HEAD read', () => {
    const result = (status, stdout = '', stderr = '') => ({ status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
    const fakeSpawn = (command, args) => {
      assert.equal(command, 'git');
      if (args[0] === 'rev-parse') return result(0, 'true\n');
      if (args[0] === 'log') return result(128, '', 'fatal: no commits yet');
      return result(0, '# branch.oid (initial)\n# branch.head main\n');
    };
    assert.deepEqual(readHeadInstant('/fixture', fakeSpawn), { state: 'unborn' });
    const failedStatus = (command, args) => args[0] === 'status'
      ? result(128, '', 'fatal: corrupt ref')
      : fakeSpawn(command, args);
    assert.equal(readHeadInstant('/fixture', failedStatus).state, 'error');
    const outsideWorkTree = (command) => {
      assert.equal(command, 'git');
      return result(128);
    };
    const outside = readHeadInstant('/fixture', outsideWorkTree);
    assert.equal(outside.state, 'error');
    assert.equal(outside.reason, 'cannot resolve the git work tree (exit 128)');
    const killed = readHeadInstant('/fixture', () => ({
      status: null, signal: 'SIGKILL', stdout: Buffer.from(''), stderr: Buffer.from(''),
    }));
    assert.equal(killed.reason, 'cannot resolve the git work tree (signal SIGKILL)');
    const errored = readHeadInstant('/fixture', () => ({
      error: { code: 'ENOENT', message: 'git missing' }, status: null,
      stdout: Buffer.from(''), stderr: Buffer.from(''),
    }));
    assert.equal(errored.reason, 'cannot resolve the git work tree (ENOENT)');
    const thrown = readDelegationLedger('/fixture', {}, {
      resolveStore: () => { throw new Error('store resolution STOP'); },
    });
    assert.deepEqual(thrown, { state: 'error', reason: 'store resolution STOP' });
  });

  it('accepts a folded replacement only through the supplied degrade input', () => {
    const replacement = thread({ nonce: 'replacement', sessionId: 'session-new', second: 4, post: 'b2' });
    const records = [
      ...thread({ nonce: 'first', sessionId: 'session-held', second: 1, baselineClean: true, post: 'b1' }),
      ...replacement,
    ];
    assert.equal(judge(records).heldId, 'session-held');
    assert.equal(judge(records).substitution.actualId, 'session-new');
    const covered = judge(records, { degrades: [{ fingerprint: replacement[1].postTreeDigest }] });
    assert.equal(covered.heldId, 'session-new');
    assert.equal(covered.substitution, null);
  });

  it('keeps semantic audit refusal outside the pure judge', () => {
    const duplicate = buildDispatch({ nonce: 'duplicate', timestamp: '2030-01-01T00:00:01.000Z' });
    const audit = auditDelegationStoreSemantics({
      records: [buildRegistration(), duplicate, { ...duplicate, timestamp: '2030-01-01T00:00:02.000Z' }],
      recordLines: [1, 2, 3],
      storePath: 'fixture-ledger',
    });
    assert.equal(audit.ok, false);
    assert.equal(audit.line, 3);
    assert.match(audit.reason, /duplicate dispatch/u);
  });
});
