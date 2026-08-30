import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { STAGES } from './release-stages.mjs';

const mod = await import('./release-receipt.mjs').catch(() => ({}));
const {
  RELEASE_RUN_RECEIPT_BASENAME,
  RELEASE_RUN_LOCK_BASENAME,
  RECEIPT_SCHEMA,
  FINGERPRINT_VERSION,
  receiptPath,
  lockPath,
  buildReceipt,
  readReceipt,
  fingerprint,
  startViolation,
  resumeViolation,
  stagedOnlyViolation,
  commitProofViolation,
} = mod;

const HEAD = 'a'.repeat(40);
const FOREIGN_HEAD = 'b'.repeat(40);
const EXPECT = Object.freeze({ memory: '7.1.3', engine: '4.4.1', kit: '10.5.1' });
const OTHER_EXPECT = Object.freeze({ ...EXPECT, kit: '10.5.2' });
const TOKEN_FILE = '/tmp/release token';
const SMOKE = Object.freeze([
  Object.freeze({ kind: 'line', value: 'bridge ready' }),
  Object.freeze({ kind: 'file', value: '.codex/state.json=ready' }),
]);
const makeStage = (name, status = 'pending', extra = {}) => ({
  name,
  status,
  exit: status === 'pass' ? 0 : null,
  startedAt: status === 'pending' ? null : '2026-08-30T10:00:00.000Z',
  durationS: status === 'pending' ? null : 1,
  ...extra,
});
const makeStages = (overrides = {}) => STAGES.map((name) => {
  const override = overrides[name];
  if (typeof override === 'string') return makeStage(name, override);
  return makeStage(name, override?.status ?? 'pass', override ?? {});
});
const makeReceipt = ({ head = HEAD, expect = EXPECT, stages = makeStages(), invocations = 1 } = {}) =>
  buildReceipt({ head, ref: 'main', expect, tokenFile: TOKEN_FILE, smoke: SMOKE, approved: 'f'.repeat(64), invocations, stages });
const expectDecision = (actual, expected, name) => {
  if (expected === null) assert.equal(actual, null, name);
  else assert.match(actual, expected, name);
};

describe('release receipt', () => {
  // spec:release-run/S7
  it('builds and reads only the frozen ordered receipt shape', () => {
    assert.equal(typeof buildReceipt, 'function');
    assert.equal(RELEASE_RUN_RECEIPT_BASENAME, 'agent-workflow-release-run.json');
    assert.equal(RELEASE_RUN_LOCK_BASENAME, 'agent-workflow-release-run.lock');
    assert.equal(RECEIPT_SCHEMA, 1);
    assert.equal(receiptPath('/repo/.git'), join('/repo/.git', RELEASE_RUN_RECEIPT_BASENAME));
    assert.equal(lockPath('/repo/.git'), join('/repo/.git', RELEASE_RUN_LOCK_BASENAME));
    const stages = makeStages({ live: { status: 'pass', provenBy: 'verify' } }).reverse();
    const receipt = makeReceipt({ stages, invocations: 3 });
    assert.deepEqual(Object.keys(receipt), [
      'schema', 'head', 'ref', 'expect', 'tokenFile', 'smoke', 'approved', 'invocations', 'stages',
    ]);
    assert.deepEqual(receipt.stages.map(({ name }) => name), STAGES);
    assert.equal(receipt.stages.find(({ name }) => name === 'live').provenBy, 'verify');
    assert.equal(receipt.invocations, 3);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.expect));
    assert.ok(Object.isFrozen(receipt.smoke));
    assert.ok(receipt.stages.every(Object.isFrozen));
    const path = '/repo/.git/receipt.json';
    assert.deepEqual(readReceipt(path, () => JSON.stringify(receipt)), { receipt });
    assert.deepEqual(readReceipt(path, () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }), { receipt: null });
    const pendingAfter = (name) => Object.fromEntries(STAGES.slice(STAGES.indexOf(name) + 1).map((later) => [later, 'pending']));
    const interruptedPush = makeReceipt({ stages: makeStages({ push: 'running', ...pendingAfter('push') }) });
    assert.deepEqual(readReceipt(path, () => JSON.stringify(interruptedPush)).receipt.stages.find(({ name }) => name === 'push'), {
      ...makeStage('push', 'running'), status: 'fail', resumable: true,
    });
    const interrupted = makeReceipt({ stages: makeStages({ live: 'running', ...pendingAfter('live') }) });
    const normalized = readReceipt(path, () => JSON.stringify(interrupted)).receipt;
    assert.deepEqual(normalized.stages.find(({ name }) => name === 'live'), {
      ...makeStage('live', 'running'), status: 'fail', dispatched: 'unknown',
    });
    const malformed = [
      ['invalid JSON', '{'],
      ['schema mismatch', JSON.stringify({ ...receipt, schema: 2 })],
      ['missing field', JSON.stringify({ ...receipt, tokenFile: undefined })],
      ['unknown stage', JSON.stringify({ ...receipt, stages: receipt.stages.map((stage, index) => index === 2 ? { ...stage, name: 'other' } : stage) })],
      ['wrong order', JSON.stringify({ ...receipt, stages: [...receipt.stages].reverse() })],
    ];
    for (const [name, body] of malformed) {
      const result = readReceipt(path, () => body);
      assert.match(result.refusal, /\/repo\/\.git\/receipt\.json/, name);
    }
    assert.equal(readReceipt(path, () => JSON.stringify(normalized)).refusal, undefined, 'a normalized receipt reads back clean');
    const withStage = (name, patch) => {
      const cut = STAGES.indexOf(name);
      const halts = patch.status !== undefined && patch.status !== 'pass';
      return JSON.stringify({ ...receipt, stages: receipt.stages.map((stage, index) => index === cut ? { ...makeStage(name, 'pass'), ...patch } : (halts && index > cut ? makeStage(stage.name, 'pending') : stage)) });
    };
    const liveRows = [
      [{ status: 'fail', exit: null, resumable: true }, true], [{ status: 'fail', exit: 1, resumable: true }, true],
      [{ status: 'fail', exit: 1, dispatched: 'unknown' }, true], [{ status: 'fail', exit: 2, resumable: true }, true],
      [{ status: 'fail', exit: 3, resumable: true }, true], [{ status: 'fail', exit: 8, dispatched: 'unknown' }, true],
      [{ status: 'fail', exit: 8 }, false], [{ status: 'fail', exit: 8, dispatched: 'unknown', resumable: true }, false],
      [{ status: 'fail', exit: null }, false], [{ status: 'pass', exit: 0 }, true], [{ status: 'pass', exit: 9 }, true],
      [{ status: 'pass', exit: 8, provenBy: 'verify' }, true], [{ status: 'pass', exit: 8 }, false],
    ];
    assert.equal(readReceipt(path, () => withStage('smoke-candidate', { status: 'pass', exit: 1 })).refusal === undefined, false, 'a pass with a nonzero exit');
    for (const [name, patch] of [['ref', { ref: 'refs/heads/main' }], ['ref newline', { ref: 'main\nx' }], ['ref dots', { ref: 'foo..bar' }], ['head', { head: 'abc' }], ['approved', { approved: 'not-hex' }], ['expect', { expect: { ...EXPECT, kit: '1.0' } }], ['expect array', { expect: { ...EXPECT, kit: ['1.0.0'] } }], ['tokenFile', { tokenFile: 'a\nb' }], ['smoke', { smoke: [{ kind: 'line', value: `x${String.fromCharCode(0)}` }] }]]) {
      assert.match(readReceipt(path, () => JSON.stringify({ ...receipt, ...patch })).refusal ?? '', /malformed/u, name);
    }
    for (const [live, valid] of liveRows) assert.equal(readReceipt(path, () => withStage('live', live)).refusal === undefined, valid, JSON.stringify(live));
    const verifyRows = [
      [{ exit: 0 }, true], [{ exit: 9, inconclusive: true }, true], [{ exit: 9 }, false], [{ exit: 0, inconclusive: true }, false],
      [{ exit: 8, inconclusive: true }, false], [{ status: 'fail', exit: 8 }, true], [{ status: 'fail', exit: 9 }, true],
    ];
    for (const [verify, valid] of verifyRows) assert.equal(readReceipt(path, () => withStage('verify', verify)).refusal === undefined, valid, JSON.stringify(verify));
    const sequenceRows = [
      [{ live: 'pending' }, false], [{ push: 'fail' }, false], [{ push: 'fail', ...pendingAfter('push') }, true],
      [{ live: { status: 'fail', dispatched: 'unknown' }, verify: 'fail', 'smoke-init': 'pending' }, true],
      [{ live: { status: 'fail', dispatched: 'unknown' }, 'smoke-init': 'pending' }, false],
      [{ live: { status: 'fail', resumable: true }, verify: 'fail', 'smoke-init': 'pending' }, false],
      [{ commit: 'pass', 'preflight-remote': 'pending', push: 'pending', 'smoke-candidate': 'pending', 'cross-version-gate': 'pending', live: 'pending', verify: 'pending', 'smoke-init': 'pending' }, true],
    ];
    for (const [overrides, valid] of sequenceRows) {
      const body = JSON.stringify(makeReceipt({ stages: makeStages(overrides) }));
      assert.equal(readReceipt(path, () => body).refusal === undefined, valid, JSON.stringify(overrides));
    }
    const io = readReceipt(path, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    assert.match(io.refusal, /receipt\.json.*EACCES/);
  });

  // spec:release-run/S8
  it('admits or refuses every START state-table cell', () => {
    assert.equal(typeof startViolation, 'function');
    const unresolved = makeReceipt({ stages: makeStages({ live: { status: 'fail', dispatched: 'unknown' }, verify: 'fail' }) });
    const running = makeReceipt({ head: FOREIGN_HEAD, stages: makeStages({ live: 'running' }) });
    const complete = makeReceipt();
    const incomplete = makeReceipt({ stages: makeStages({ verify: 'fail', 'smoke-init': 'pending' }) });
    const foreignIncomplete = makeReceipt({ head: FOREIGN_HEAD, stages: makeStages({ live: { status: 'fail', resumable: true }, verify: 'fail' }) });
    const rows = [
      ['unresolved commit', { receipt: unresolved, head: HEAD, dirty: true, expect: OTHER_EXPECT, form: 'commit' }, /--from verify.*aaaaaaaa/i],
      ['unresolved receipt-free', { receipt: running, head: HEAD, dirty: false, expect: OTHER_EXPECT, form: 'preflight-remote' }, /--from verify.*bbbbbbbb/i],
      ['dirty commit without receipt', { receipt: null, head: HEAD, dirty: true, expect: EXPECT, form: 'commit' }, null],
      ['dirty commit supersedes incomplete', { receipt: foreignIncomplete, head: HEAD, dirty: true, expect: EXPECT, form: 'commit' }, null],
      ['dirty commit keeps equal published receipt', { receipt: complete, head: HEAD, dirty: true, expect: EXPECT, form: 'commit' }, /recorded at.*aaaaaaaa/i],
      ['dirty commit with new expectation', { receipt: complete, head: HEAD, dirty: true, expect: OTHER_EXPECT, form: 'commit' }, null],
      ['dirty receipt-free start', { receipt: null, head: HEAD, dirty: true, expect: EXPECT, form: 'preflight-remote' }, /clean tree/i],
      ['clean completed head', { receipt: complete, head: HEAD, dirty: false, expect: EXPECT, form: 'commit' }, /already released at HEAD/i],
      ['clean incomplete head', { receipt: incomplete, head: HEAD, dirty: false, expect: EXPECT, form: 'commit' }, /--from verify/],
      ['clean commit without receipt', { receipt: null, head: HEAD, dirty: false, expect: EXPECT, form: 'commit' }, /nothing to commit.*--from preflight-remote/i],
      ['clean commit with stale receipt', { receipt: foreignIncomplete, head: HEAD, dirty: false, expect: EXPECT, form: 'commit' }, /stale.*bbbbbbbb.*--from preflight-remote/i],
      ['clean receipt-free start', { receipt: null, head: HEAD, dirty: false, expect: EXPECT, form: 'preflight-remote' }, null],
      ['clean receipt-free supersedes stale incomplete', { receipt: foreignIncomplete, head: HEAD, dirty: false, expect: EXPECT, form: 'preflight-remote' }, null],
      ['clean receipt-free keeps equal published receipt', { receipt: makeReceipt({ head: FOREIGN_HEAD }), head: HEAD, dirty: false, expect: EXPECT, form: 'preflight-remote' }, /recorded at.*bbbbbbbb/i],
      ['receipt-free with receipt at head', { receipt: incomplete, head: HEAD, dirty: false, expect: EXPECT, form: 'preflight-remote' }, /receipt already exists at HEAD/i],
    ];
    for (const [name, input, expected] of rows) expectDecision(startViolation(input), expected, name);
    assert.equal(typeof stagedOnlyViolation, 'function');
    const porcelainRows = [
      ['staged modify', 'M  a\n', null],
      ['staged add and rename', 'A  a\nR  b -> c\n', null],
      ['staged typechange', 'T  a\n', null],
      ['unstaged modify', ' M a\n', / M a$/u],
      ['half staged', 'M  a\nMM b\n', /MM b$/u],
      ['untracked', '?? n\n', /\?\? n$/u],
      ['unmerged', 'UU c\n', /UU c$/u],
      ['empty', '', /nothing is staged/u],
    ];
    for (const [name, porcelain, expected] of porcelainRows) expectDecision(stagedOnlyViolation(porcelain), expected, name);
    assert.equal(commitProofViolation({ parents: [HEAD], tree: 'tree', expectedParent: HEAD, expectedTree: 'tree' }), null);
    assert.match(commitProofViolation({ parents: [FOREIGN_HEAD], tree: 'tree', expectedParent: HEAD, expectedTree: 'tree' }), /approved index/u);
    assert.match(commitProofViolation({ parents: [HEAD, FOREIGN_HEAD], tree: 'tree', expectedParent: HEAD, expectedTree: 'tree' }), /approved index/u);
    assert.match(commitProofViolation({ parents: [HEAD], tree: 'other', expectedParent: HEAD, expectedTree: 'tree' }), /approved index/u);
  });

  // spec:release-run/S9
  it('admits exactly the proven RESUME conjunction', () => {
    assert.equal(typeof resumeViolation, 'function');
    const buildValidAt = (from, live = 'pass') => {
      const cut = STAGES.indexOf(from);
      const stages = STAGES.map((name, index) => makeStage(name, index < cut ? 'pass' : 'pending'));
      const liveIndex = STAGES.indexOf('live');
      const withLive = stages.map((stage, index) => index === liveIndex && live === 'unknown'
        ? makeStage('live', 'fail', { dispatched: 'unknown' })
        : index === liveIndex && index < cut ? makeStage('live', live) : stage);
      return makeReceipt({ stages: withLive });
    };
    const rows = [
      ['preflight', buildValidAt('preflight-remote'), 'preflight-remote', HEAD, null],
      ['push', buildValidAt('push'), 'push', HEAD, null],
      ['candidate', buildValidAt('smoke-candidate'), 'smoke-candidate', HEAD, null],
      ['cross version', buildValidAt('cross-version-gate'), 'cross-version-gate', HEAD, null],
      ['live not yet dispatched', buildValidAt('live'), 'live', HEAD, null],
      ['verify after live pass', buildValidAt('verify'), 'verify', HEAD, null],
      ['verify after unknown live', buildValidAt('verify', 'unknown'), 'verify', HEAD, null],
      ['smoke init', buildValidAt('smoke-init'), 'smoke-init', HEAD, null],
      ['foreign head', buildValidAt('verify'), 'verify', FOREIGN_HEAD, /another HEAD/i],
      ['failed prior stage', makeReceipt({ stages: makeStages({ push: 'fail', live: 'pending', verify: 'pending', 'smoke-init': 'pending' }) }), 'live', HEAD, /push.*not pass/i],
      ['live pass from live', buildValidAt('verify'), 'live', HEAD, /publish.*already dispatched/i],
      ['live pass from earlier', buildValidAt('verify'), 'push', HEAD, /publish.*already dispatched/i],
      ['unknown live from live', buildValidAt('verify', 'unknown'), 'live', HEAD, /--from verify/i],
      ['unknown live from later', buildValidAt('smoke-init', 'unknown'), 'smoke-init', HEAD, /--from verify/i],
    ];
    for (const [name, receipt, from, head, expected] of rows) {
      expectDecision(resumeViolation({ receipt, head, from }), expected, name);
    }
  });

  // spec:release-run/S17
  it('pins the versioned byte-framed fingerprint vectors', () => {
    assert.equal(typeof fingerprint, 'function');
    assert.equal(FINGERPRINT_VERSION, 'v1');
    const empty = { head: '', porcelain: '', cachedDiff: '', messageBytes: '', ref: 'main', expect: { memory: '', engine: '', kit: '' }, smoke: [], tokenFile: '' };
    const full = {
      head: 'abc', porcelain: ' M x\n', cachedDiff: Buffer.from([0, 1, 255]), messageBytes: 'Release 1\n', ref: 'release/test',
      expect: { memory: '7.1.3', engine: '4.4.1', kit: '10.5.1' }, smoke: SMOKE, tokenFile: TOKEN_FILE,
    };
    assert.equal(fingerprint(empty), '382d5885d39dc01391bce37c557cb7be88032f6e5dca69f5898c3ba0fc3c8347');
    assert.equal(fingerprint(full), '941f467c7e4e32b026b439090b2736252c6359406cbc90b38ac71a145a4f9f95');
    assert.equal(fingerprint({ ...full, messageBytes: 'Release 2\n' }), '3e69760121a1307a9686812969b314a507fb041951cb959c72caa1006dff5c88');
    assert.notEqual(fingerprint(full), fingerprint({ ...full, messageBytes: 'Release 2\n' }));
    assert.notEqual(fingerprint({ ...full, cachedDiff: Buffer.from([0xff]) }), fingerprint({ ...full, cachedDiff: Buffer.from([0xfe]) }));
  });
});
