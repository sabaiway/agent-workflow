import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DELEGATION_STORE_BASENAME, DELEGATION_STORE_STOP, DELEGATION_LOCK_SUFFIX,
  resolveDelegationStorePath, resolveDelegationLockPath, parseDelegationStoreText,
  readDelegationStore, appendDelegationRecord, delegationThreadState,
  uncommittedStateFingerprint, UNCOMMITTED_STATE_FINGERPRINT,
} from './dispatch-store.mjs';
import {
  DELEGATION_SCHEMA_VERSION, canonicalDelegationDigest, expectedBundleLength,
  SESSION_ID_NULLABLE_OUTCOMES,
} from './dispatch-record.mjs';
import { computeTreeFingerprint, computeFingerprintPayload } from './core-evidence.mjs';
import { createStoreAppendLane } from './store-append.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-dispatch-store-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
const makeRepo = () => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(root, { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
};
const addWorktree = (root) => {
  const wt = join(TMP, `wt-${seq += 1}`);
  sh(['worktree', 'add', '-q', wt], root);
  return wt;
};

// A store dir OUTSIDE any git tree — the override seam carries its own lock, so the append lanes
// stay hermetic (the git-derived resolution has its own tests above them).
const makeStoreEnv = () => {
  const dir = join(TMP, `store-${seq += 1}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DELEGATION_STORE_BASENAME);
  return { env: { AW_DELEGATION_STORE: path }, path, dir };
};

const D = (pair) => pair.repeat(32);
const TS = '2026-08-09T00:00:00.000Z';
const TS2 = '2026-08-09T00:00:01.000Z';
const TS3 = '2026-08-09T00:00:02.000Z';

const preRegistration = (over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'pre-registration', waveId: 'wave-a',
  stepClasses: ['code'], pairingKey: 'stepClass', minPerClass: 3, meanLThreshold: 2,
  firstPassNum: 2, firstPassDen: 3, timestamp: TS, ...over,
});

const dispatchRecord = (over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'dispatch', waveId: 'wave-a', nonce: 'n1',
  stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' }, backend: 'codex',
  contractDigest: D('c1'), preTreeDigest: D('a1'), baselineClean: true, deadlineS: 900,
  retryOf: null, retryIndex: 0, retryCap: 2, rationale: 'the bounded sub-task', timestamp: TS,
  ...over,
});

const DIFF_LENGTH = 100;
const REPORT_LENGTH = 50;
const BUNDLE_LENGTH = expectedBundleLength(DIFF_LENGTH, REPORT_LENGTH);

const successReturn = (over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'return', role: 'execute', backend: 'codex', nonce: 'n1',
  contractDigest: D('c1'), preTreeDigest: D('a1'), postTreeDigest: D('b2'), diffDigest: D('d3'),
  diffLength: DIFF_LENGTH, reportDigest: D('e4'), reportLength: REPORT_LENGTH,
  bundleDigest: D('f5'), bundleLength: BUNDLE_LENGTH,
  metric: {
    numeratorBytes: 400, denominatorBytes: BUNDLE_LENGTH,
    components: [{ kind: 'modified', path: 'src/a.mjs', objectId: 'oid-a', bytes: 400 }],
    provenance: 'wrapper-git', eligible: true, ineligibleReason: null,
  },
  outcome: 'success', exitStatus: 0, sessionId: 'sess-1', wrapperVersion: '3.4.1',
  posture: { model: 'gpt-5', effort: 'high', tier: 'priority' }, timestamp: TS2, ...over,
});

// A failure return carries no diff and no report — its metric is ineligible by its OWN numbers.
// sessionId follows the D4 rule: null ONLY where no session ever existed to identify.
const EMPTY_BUNDLE_LENGTH = expectedBundleLength(0, 0);
const failureReturn = (outcome, over = {}) => successReturn({
  outcome,
  exitStatus: 1,
  sessionId: SESSION_ID_NULLABLE_OUTCOMES.includes(outcome) ? null : 'sess-1',
  diffLength: 0,
  reportLength: 0,
  bundleLength: EMPTY_BUNDLE_LENGTH,
  metric: {
    numeratorBytes: 0, denominatorBytes: EMPTY_BUNDLE_LENGTH, components: [],
    provenance: 'wrapper-git', eligible: false, ineligibleReason: 'no-op-diff',
  },
  ...over,
});

const foldRecord = (returnRecord, over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'fold', nonce: returnRecord.nonce,
  returnDigest: canonicalDelegationDigest(returnRecord),
  treeDigestAtFold: returnRecord.postTreeDigest, verdict: 'folded as returned', timestamp: TS3,
  ...over,
});

const degradeRecord = (over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'degrade', waveId: 'wave-a', nonce: 'n1',
  stepClass: 'code', rationale: 'the backend never answered; recorded and closed', timestamp: TS3,
  ...over,
});

const observationRecord = (over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'observation', waveId: 'wave-a', stepClass: 'code',
  scope: 'agent-workflow-kit/tools/dispatch-store.mjs',
  metric: {
    numeratorBytes: 500, denominatorBytes: 500,
    components: [{ kind: 'modified', path: 'tools/dispatch-store.mjs', objectId: 'oid-s', bytes: 500 }],
    provenance: 'solo-construction', eligible: true, ineligibleReason: null,
  },
  planId: 'delegation-1-contract-ledger-baseline', phase: 2, timestamp: TS, ...over,
});

const throwsStop = (fn, re) => assert.throws(fn, (err) => {
  assert.equal(err.code, DELEGATION_STORE_STOP, `expected a typed delegation-store stop, got: ${err.message}`);
  assert.match(err.message, re);
  return true;
});

// Appends a legal prefix so a test can start from a live thread.
const append = (env, record) => appendDelegationRecord({ cwd: TMP, record, env });
const seedWave = (env) => append(env, preRegistration());
const seedThread = (env) => {
  seedWave(env);
  append(env, dispatchRecord());
};

const storeRecords = (path) => readDelegationStore(path).records;

describe('dispatch-store — path resolution (common dir + AW_DELEGATION_STORE seam)', () => {
  it('the main tree and a linked worktree resolve ONE absolute store path in the common git dir', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    const fromMain = resolveDelegationStorePath(root, {});
    const fromLinked = resolveDelegationStorePath(wt, {});
    assert.ok(isAbsolute(fromMain), 'the resolved store path must be absolute');
    assert.ok(fromMain.endsWith(DELEGATION_STORE_BASENAME));
    assert.equal(fromLinked, fromMain, 'delegation accounting is worktree-SHARED — one common-dir store');
  });

  it('the delegation store is SEPARATE from the review receipts and flow stores', () => {
    const root = makeRepo();
    const path = resolveDelegationStorePath(root, {});
    assert.equal(path.endsWith('agent-workflow-delegation.jsonl'), true);
    assert.notEqual(path.endsWith('agent-workflow-review-receipts.jsonl'), true);
    assert.notEqual(path.endsWith('agent-workflow-flow.jsonl'), true);
  });

  it('outside a git work tree the resolved path is null (no override)', () => {
    const dir = join(TMP, 'no-repo');
    mkdirSync(dir, { recursive: true });
    assert.equal(resolveDelegationStorePath(dir, {}), null);
  });

  it('a relative AW_DELEGATION_STORE is refused loudly from ANY cwd', () => {
    const root = makeRepo();
    const wt = addWorktree(root);
    for (const cwd of [root, wt]) {
      throwsStop(() => resolveDelegationStorePath(cwd, { AW_DELEGATION_STORE: 'rel/delegation.jsonl' }), /AW_DELEGATION_STORE must be an ABSOLUTE path/);
    }
  });

  it('an AW_DELEGATION_STORE ending with a path separator is refused loudly — a store is a file', () => {
    throwsStop(() => resolveDelegationStorePath(TMP, { AW_DELEGATION_STORE: `${join(TMP, 'x')}/` }), /must not end with a path separator/);
  });

  it('the lock path is derived from the resolved store path as a sibling', () => {
    const path = join(TMP, 'x', 'delegation.jsonl');
    assert.equal(resolveDelegationLockPath(path), `${path}${DELEGATION_LOCK_SUFFIX}`);
  });
});

describe('dispatch-store — the fail-closed reader', () => {
  it('an absent store reads as empty — no records yet is not an error', () => {
    const { path } = makeStoreEnv();
    const read = readDelegationStore(path);
    assert.deepEqual(read.records, []);
    assert.equal(read.malformed, 0);
    assert.equal(read.readError, undefined);
  });

  it('a malformed line is COUNTED with its reason and never silently dropped', () => {
    const { path } = makeStoreEnv();
    writeFileSync(path, `${JSON.stringify(preRegistration())}\nnot json\n${JSON.stringify({ schema: 1, kind: 'nope' })}\n`);
    const read = readDelegationStore(path);
    assert.equal(read.records.length, 1);
    assert.equal(read.malformed, 2);
    assert.match(read.malformedReasons[0], /line 2: invalid JSON/);
    assert.match(read.malformedReasons[1], /line 3: unknown kind/);
  });

  it('a REVIEW receipt line in the delegation store refuses as an unknown kind (negative parity)', () => {
    const { path } = makeStoreEnv();
    const receipt = { schema: 1, artifact: 'code', fresh: true, fingerprint: D('a1'), backend: 'codex', verdict: 'ship', grounded: true, factsHash: null, wrapperVersion: '3.4.1', timestamp: TS };
    writeFileSync(path, `${JSON.stringify(receipt)}\n`);
    const read = readDelegationStore(path);
    assert.deepEqual(read.records, [], 'a review receipt is NOT a delegation record');
    assert.equal(read.malformed, 1);
    assert.match(read.malformedReasons[0], /line 1: missing field "kind"/);
  });

  it('parseDelegationStoreText skips blank lines only', () => {
    const parsed = parseDelegationStoreText(`\n${JSON.stringify(preRegistration())}\n\n`);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.malformed, 0);
  });

  it('a dangling symlink in place of the store is a readError, never an empty store', () => {
    const { dir } = makeStoreEnv();
    const link = join(dir, 'linked.jsonl');
    symlinkSync(join(dir, 'absent.jsonl'), link);
    assert.notEqual(readDelegationStore(link).readError, undefined);
  });
});

describe('dispatch-store — append: validate, then the semantic preflight on the LOCKED snapshot', () => {
  it('a valid record appends atomically and the lock is released — no tmp or lock file remains', () => {
    const { env, path, dir } = makeStoreEnv();
    const written = append(env, preRegistration());
    assert.equal(written.writtenPath, path);
    assert.equal(storeRecords(path).length, 1);
    assert.deepEqual(readdirSync(dir), [DELEGATION_STORE_BASENAME]);
  });

  it('a malformed record is refused before any write', () => {
    const { env, path } = makeStoreEnv();
    throwsStop(() => append(env, { ...preRegistration(), waveId: '' }), /refusing to write a malformed delegation record/);
    assert.equal(readDelegationStore(path).records.length, 0);
  });

  it('appending onto a store carrying malformed lines refuses BY NAME — fail closed in both directions', () => {
    const { env, path } = makeStoreEnv();
    writeFileSync(path, 'not json\n');
    throwsStop(() => append(env, preRegistration()), /refusing to append to a delegation store carrying 1 malformed line/);
  });

  it('a canonical-digest duplicate refuses — a key-order-permuted replay is the SAME record', () => {
    const { env } = makeStoreEnv();
    const first = preRegistration();
    append(env, first);
    const permuted = Object.fromEntries(Object.entries(first).reverse());
    assert.notEqual(JSON.stringify(permuted), JSON.stringify(first), 'the replay must differ BYTE-wise to test the canonical rule');
    throwsStop(() => append(env, permuted), /canonical duplicate/);
  });

  it('appending outside a git tree without an override is a named refusal', () => {
    const dir = join(TMP, 'no-repo-append');
    mkdirSync(dir, { recursive: true });
    throwsStop(() => appendDelegationRecord({ cwd: dir, record: preRegistration(), env: {} }), /there is no delegation store to append to/);
  });

  it('a symlinked store leaf refuses pre-write', () => {
    const { env, path, dir } = makeStoreEnv();
    writeFileSync(join(dir, 'real.jsonl'), '');
    symlinkSync(join(dir, 'real.jsonl'), path);
    throwsStop(() => append(env, preRegistration()), /is a symlink, not a regular file/);
  });
});

describe('dispatch-store — wave rules', () => {
  it('a duplicate pre-registration for a wave refuses — registration is immutable per wave', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    throwsStop(() => append(env, preRegistration({ minPerClass: 5 })), /wave "wave-a" is already registered/);
  });

  it('a SECOND wave registers freely — immutability is per wave, never global', () => {
    const { env, path } = makeStoreEnv();
    seedWave(env);
    append(env, preRegistration({ waveId: 'wave-b' }));
    assert.equal(storeRecords(path).filter((r) => r.kind === 'pre-registration').length, 2);
  });

  it('an unregistered waveId on a dispatch, an observation and a degrade each refuse by name', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    for (const record of [dispatchRecord({ waveId: 'wave-x' }), observationRecord({ waveId: 'wave-x' }), degradeRecord({ waveId: 'wave-x', nonce: null })]) {
      throwsStop(() => append(env, record), /names the UNREGISTERED wave "wave-x"/);
    }
  });

  it('a stepClass the wave never REGISTERED refuses — the registration fixes the acceptance set', () => {
    const { env } = makeStoreEnv();
    seedWave(env); // registers stepClasses: ['code']
    for (const record of [
      dispatchRecord({ stepClass: 'draft' }),
      observationRecord({ stepClass: 'triage' }),
      degradeRecord({ stepClass: 'research', nonce: null }),
    ]) {
      throwsStop(() => append(env, record), /is not among the classes wave "wave-a" registered \(code\)/);
    }
    append(env, dispatchRecord()); // the registered class still lands
  });

  it('a wave registering SEVERAL classes admits each of them', () => {
    const { env, path } = makeStoreEnv();
    append(env, preRegistration({ stepClasses: ['code', 'draft'] }));
    append(env, dispatchRecord({ stepClass: 'draft' }));
    assert.equal(storeRecords(path).filter((r) => r.kind === 'dispatch').length, 1);
  });
});

describe('dispatch-store — thread transitions, correlation and terminality', () => {
  it('a second dispatch record for a nonce refuses (duplicate nonce)', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    throwsStop(() => append(env, dispatchRecord({ timestamp: TS2 })), /nonce "n1" already carries a dispatch/);
  });

  it('a return without a dispatch refuses', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    throwsStop(() => append(env, successReturn()), /no dispatch for nonce "n1"/);
  });

  it('a second return for a nonce refuses — a stale return never lands', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    append(env, successReturn());
    throwsStop(() => append(env, successReturn({ outcome: 'stale-return', exitStatus: 1, timestamp: TS3 })), /nonce "n1" already carries a return/);
  });

  it('correlation: a return whose backend, contractDigest or preTreeDigest mismatches its dispatch refuses', () => {
    for (const [field, value] of [['backend', 'agy'], ['contractDigest', D('99')], ['preTreeDigest', D('88')]]) {
      const { env } = makeStoreEnv();
      seedThread(env);
      throwsStop(() => append(env, successReturn({ [field]: value })), new RegExp(`return: ${field} .* does not equal its dispatch`));
    }
  });

  it('a fold without a success or acceptance-failure return refuses', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    throwsStop(() => append(env, foldRecord(successReturn())), /nonce "n1" carries no return/);
  });

  it('a fold whose returnDigest is unresolved refuses', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    const landed = successReturn();
    append(env, landed);
    throwsStop(() => append(env, foldRecord(landed, { returnDigest: D('77') })), /returnDigest .* matches no record in the store/);
  });

  it('a fold whose returnDigest resolves to a NON-return record refuses', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    const landed = successReturn();
    append(env, landed);
    throwsStop(
      () => append(env, foldRecord(landed, { returnDigest: canonicalDelegationDigest(dispatchRecord()) })),
      /returnDigest resolves to a dispatch record, not a return/,
    );
  });

  it('a fold whose returnDigest resolves CROSS-THREAD refuses', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    append(env, dispatchRecord());
    append(env, dispatchRecord({ nonce: 'n2', timestamp: TS2 }));
    const other = successReturn({ nonce: 'n2', timestamp: TS3 });
    append(env, successReturn());
    append(env, other);
    throwsStop(() => append(env, foldRecord(other, { nonce: 'n1' })), /returnDigest resolves to the return of nonce "n2"/);
  });

  it('concurrent tree motion: a fold whose treeDigestAtFold differs from the return postTreeDigest refuses', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    const landed = successReturn();
    append(env, landed);
    throwsStop(() => append(env, foldRecord(landed, { treeDigestAtFold: D('66') })), /treeDigestAtFold .* does not equal the folded return's postTreeDigest/);
  });

  it('an acceptance-failure return is NON-terminal: it folds, and the fold closes the thread', () => {
    const { env, path } = makeStoreEnv();
    seedThread(env);
    const landed = successReturn({ outcome: 'acceptance-failure', exitStatus: 1 });
    append(env, landed);
    assert.equal(delegationThreadState(storeRecords(path), 'n1').terminal, false);
    append(env, foldRecord(landed));
    assert.equal(delegationThreadState(storeRecords(path), 'n1').terminal, true);
  });

  it('a degrade is the legal no-fold closure of a thread, and it closes it', () => {
    const { env, path } = makeStoreEnv();
    seedThread(env);
    append(env, successReturn());
    assert.equal(delegationThreadState(storeRecords(path), 'n1').terminal, false);
    append(env, degradeRecord());
    assert.equal(delegationThreadState(storeRecords(path), 'n1').terminal, true);
    throwsStop(() => append(env, foldRecord(successReturn(), { timestamp: '2026-08-09T00:00:09.000Z' })), /thread "n1" is already closed/);
  });

  it('a returnless thread closes with a degrade — a dispatch that never answered is recorded, not orphaned', () => {
    const { env, path } = makeStoreEnv();
    seedThread(env);
    assert.equal(delegationThreadState(storeRecords(path), 'n1').terminal, false);
    append(env, degradeRecord());
    assert.equal(delegationThreadState(storeRecords(path), 'n1').terminal, true);
  });

  it('every terminal-failure outcome closes its thread: a record after it refuses', () => {
    for (const outcome of ['transport-failure', 'contract-refusal', 'store-failure', 'missing-identity', 'partial-edit', 'stale-return']) {
      const { env, path } = makeStoreEnv();
      seedThread(env);
      const landed = failureReturn(outcome);
      append(env, landed);
      const state = delegationThreadState(storeRecords(path), 'n1');
      assert.equal(state.terminal, true, `${outcome} IS the thread's closure`);
      throwsStop(() => append(env, foldRecord(landed)), /thread "n1" is already closed/);
      throwsStop(() => append(env, degradeRecord()), /thread "n1" is already closed/);
    }
  });

  it('a degrade naming a nonce that was never dispatched refuses', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    throwsStop(() => append(env, degradeRecord({ nonce: 'ghost' })), /no dispatch for nonce "ghost"/);
  });

  it('a PRE-DISPATCH degrade (nonce null) lands on a registered wave — there is no thread to name', () => {
    const { env, path } = makeStoreEnv();
    seedWave(env);
    append(env, degradeRecord({ nonce: null }));
    assert.equal(storeRecords(path).filter((r) => r.kind === 'degrade').length, 1);
  });

  it('a threaded degrade binds BOTH waveId and stepClass to its dispatch — a foreign wave never closes a thread', () => {
    const { env } = makeStoreEnv();
    // BOTH classes are registered, so what refuses below is the dispatch binding, not the wave's
    // registered class set (which has its own test).
    append(env, preRegistration({ stepClasses: ['code', 'draft'] }));
    append(env, dispatchRecord());
    append(env, preRegistration({ waveId: 'wave-b', timestamp: TS2 }));
    throwsStop(() => append(env, degradeRecord({ waveId: 'wave-b' })), /degrade: waveId .* does not equal its dispatch/);
    throwsStop(() => append(env, degradeRecord({ stepClass: 'draft' })), /degrade: stepClass .* does not equal its dispatch/);
    append(env, degradeRecord());
  });

  it('the D5 baseline implication is enforced where it CAN be: baselineClean lives on the dispatch', () => {
    const dirty = () => {
      const { env } = makeStoreEnv();
      seedWave(env);
      append(env, dispatchRecord({ baselineClean: false }));
      return env;
    };
    // An ELIGIBLE metric over a dirty baseline refuses — the fingerprint cannot attribute bytes.
    throwsStop(() => append(dirty(), successReturn()), /dispatch recorded baselineClean:false/);
    // A STRICTER reason the return's own fields substantiate keeps its own name.
    append(dirty(), failureReturn('acceptance-failure', { sessionId: 'sess-1' }));
    // The dirty-baseline name itself lands over a dirty baseline.
    append(dirty(), successReturn({ metric: { ...successReturn().metric, eligible: false, ineligibleReason: 'dirty-baseline' } }));
    // And it is REFUSED over a clean one — an unsubstantiated override never downgrades a metric.
    const { env } = makeStoreEnv();
    seedThread(env);
    throwsStop(
      () => append(env, successReturn({ metric: { ...successReturn().metric, eligible: false, ineligibleReason: 'dirty-baseline' } })),
      /claims ineligibleReason "dirty-baseline" while its dispatch recorded baselineClean:true/,
    );
  });

  it('dirty-baseline never REPLACES a locally provable reason — the record refuses before the store sees it', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    append(env, dispatchRecord({ baselineClean: false }));
    // The return's own fields prove no-op-diff; claiming the store-side override instead would
    // record a name the producer cannot substantiate.
    throwsStop(
      () => append(env, failureReturn('acceptance-failure', {
        sessionId: 'sess-1',
        metric: { ...failureReturn('acceptance-failure').metric, ineligibleReason: 'dirty-baseline' },
      })),
      /refusing to write a malformed delegation record: return: .*dirty-baseline/,
    );
  });
});

describe('dispatch-store — retry rules', () => {
  const retry = (over = {}) => dispatchRecord({
    nonce: 'n2', retryOf: 'n1', retryIndex: 1, timestamp: TS3, contractDigest: D('c2'), ...over,
  });

  it('a missing retryOf target refuses', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    throwsStop(() => append(env, retry({ retryOf: 'ghost' })), /no dispatch for nonce "ghost"/);
  });

  it('a retry of an OPEN thread refuses — a thread is retried only after it closed', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    throwsStop(() => append(env, retry()), /thread "n1" is still OPEN/);
  });

  it('a retryIndex gap refuses — a retry increments by exactly one', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    append(env, failureReturn('transport-failure'));
    throwsStop(() => append(env, retry({ retryIndex: 2 })), /retryIndex 2 must be 1/);
  });

  it('a retry past the ORIGIN dispatch cap refuses — a new contract never manufactures a fresh budget', () => {
    const { env } = makeStoreEnv();
    seedWave(env);
    append(env, dispatchRecord({ retryCap: 1 }));
    append(env, failureReturn('transport-failure'));
    append(env, retry({ retryCap: 1 }));
    append(env, failureReturn('transport-failure', { nonce: 'n2', contractDigest: D('c2'), timestamp: '2026-08-09T00:00:04.000Z' }));
    throwsStop(
      () => append(env, retry({ nonce: 'n3', retryOf: 'n2', retryIndex: 2, retryCap: 9, contractDigest: D('c3'), timestamp: '2026-08-09T00:00:05.000Z' })),
      /retryIndex 2 exceeds the retryCap 1 recorded on the thread's ORIGIN dispatch/,
    );
  });

  it('a contract-refusal retry carrying an UNCHANGED contractDigest refuses — never a retry loop on one contract', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    append(env, failureReturn('contract-refusal'));
    throwsStop(() => append(env, retry({ contractDigest: D('c1') })), /retries a contract-refusal thread and must carry a DIFFERENT contractDigest/);
    append(env, retry());
  });

  it('a cross-wave retry refuses — a retry stays in its origin wave', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    append(env, preRegistration({ waveId: 'wave-b', timestamp: TS2 }));
    append(env, failureReturn('transport-failure'));
    throwsStop(() => append(env, retry({ waveId: 'wave-b' })), /wave "wave-b" but its retry origin "n1" was dispatched in wave "wave-a"/);
  });

  it('a thread has at most ONE retry successor — the cap bounds the chain, not only its depth', () => {
    const { env } = makeStoreEnv();
    seedThread(env);
    append(env, failureReturn('transport-failure'));
    append(env, retry());
    throwsStop(
      () => append(env, retry({ nonce: 'n3', timestamp: '2026-08-09T00:00:06.000Z' })),
      /thread "n1" already has the retry successor "n2"/,
    );
  });

  it('a legal retry of a closed thread lands and starts a fresh OPEN thread', () => {
    const { env, path } = makeStoreEnv();
    seedThread(env);
    append(env, failureReturn('transport-failure'));
    append(env, retry());
    const state = delegationThreadState(storeRecords(path), 'n2');
    assert.equal(state.terminal, false);
    assert.equal(state.dispatch.retryOf, 'n1');
  });

  it('a FOLDED thread is never a retry origin — folding accepts the attempt, so there is nothing to retry', () => {
    for (const outcome of ['success', 'acceptance-failure']) {
      const { env } = makeStoreEnv();
      seedThread(env);
      const landed = outcome === 'success' ? successReturn() : successReturn({ outcome, exitStatus: 1 });
      append(env, landed);
      append(env, foldRecord(landed));
      throwsStop(() => append(env, retry()), /thread "n1" was closed by its fold/);
    }
  });

  it('a retry that CHANGES step class refuses — one thread never splits across two classes', () => {
    const { env } = makeStoreEnv();
    append(env, preRegistration({ stepClasses: ['code', 'draft'] }));
    append(env, dispatchRecord());
    append(env, failureReturn('transport-failure'));
    throwsStop(() => append(env, retry({ stepClass: 'draft' })), /its retry origin "n1" was dispatched as "code"/);
  });

  it('a DEGRADE-closed thread IS a retry origin — the attempt was recorded as never folded', () => {
    const { env, path } = makeStoreEnv();
    seedThread(env);
    append(env, degradeRecord());
    append(env, retry());
    assert.equal(delegationThreadState(storeRecords(path), 'n2').dispatch.retryOf, 'n1');
  });
});

describe('dispatch-store — the append is lock-serialized (concurrent appenders)', () => {
  const MODULE = fileURLToPath(new URL('./dispatch-store.mjs', import.meta.url));
  const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const runChild = (runner, args) => {
    const child = spawn(process.execPath, [runner, ...args]);
    const state = { exited: false, status: null, stderr: '' };
    child.stderr.on('data', (chunk) => { state.stderr += chunk; });
    state.done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status) => { state.exited = true; state.status = status; resolve(state); });
    });
    return state;
  };
  // Bounded wait for a condition a CHILD signals through the filesystem — the only channel a
  // spawned appender shares with this process.
  const waitFor = async (predicate, what) => {
    for (let i = 0; i < 400; i += 1) {
      if (predicate()) return;
      await sleepMs(25);
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  it('N concurrent appenders all land — no lost update, no torn line', async () => {
    const { path, dir } = makeStoreEnv();
    const runner = join(dir, 'appender.mjs');
    const ready = join(dir, 'ready');
    const start = join(dir, 'start');
    // Each child announces readiness and then BLOCKS on the start barrier, so the parent can
    // release all five into the critical section together: a plain launch lets the OS run them to
    // completion one at a time, and the test would pass against a broken lock.
    writeFileSync(runner, [
      `import { appendDelegationRecord } from ${JSON.stringify(MODULE)};`,
      "import { existsSync, appendFileSync } from 'node:fs';",
      'const id = process.argv[2];',
      `appendFileSync(${JSON.stringify(ready)}, id + '\\n');`,
      `while (!existsSync(${JSON.stringify(start)})) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }`,
      `const wave = ${JSON.stringify(preRegistration())};`,
      'appendDelegationRecord({',
      `  cwd: ${JSON.stringify(dir)},`,
      '  record: { ...wave, waveId: id },',
      `  env: { AW_DELEGATION_STORE: ${JSON.stringify(path)}, AW_DELEGATION_LOCK_WAIT_MS: '30000' },`,
      '});',
      '',
    ].join('\n'));
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const kids = ids.map((id) => runChild(runner, [id]));
    await waitFor(() => existsSync(ready) && readFileSync(ready, 'utf8').split('\n').filter(Boolean).length === ids.length, 'all five appenders to report ready');
    writeFileSync(start, 'go');
    for (const kid of kids) {
      const done = await kid.done;
      assert.equal(done.status, 0, `appender failed: ${done.stderr}`);
    }
    const read = readDelegationStore(path);
    assert.equal(read.malformed, 0, 'no torn line');
    assert.deepEqual(read.records.map((r) => r.waveId).sort(), ids);
    assert.equal(readdirSync(dir).includes(`${DELEGATION_STORE_BASENAME}${DELEGATION_LOCK_SUFFIX}`), false, 'the lock is released');
  });

  it('a holder read that THROWS is the typed custody stop, never a raw error', () => {
    const { env, path } = makeStoreEnv();
    // A lock already exists, so the append takes the HOLDER-read lane; the injected reader io then
    // throws before any classification, which must surface as this store's typed stop.
    writeFileSync(`${path}${DELEGATION_LOCK_SUFFIX}`, '{"pid":1,"host":"elsewhere"}');
    throwsStop(
      () => appendDelegationRecord({
        cwd: TMP,
        record: preRegistration(),
        env,
        deps: { holderIo: { constants: { get O_NONBLOCK() { throw new Error('probe failed'); } } } },
      }),
      /the read\/close custody failed/,
    );
  });

  it('a held lock provably BLOCKS a second appender — the child signals from inside the wait lane', async () => {
    const { env, path, dir } = makeStoreEnv();
    const runner = join(dir, 'waiter.mjs');
    const waiting = join(dir, 'waiting');
    // The child signals from the lane's own injected sleep, so the signal is proof it entered the
    // CONTENTION path — "the process has not exited yet" alone would prove nothing.
    writeFileSync(runner, [
      `import { appendDelegationRecord } from ${JSON.stringify(MODULE)};`,
      "import { writeFileSync } from 'node:fs';",
      'let signalled = false;',
      `const wave = ${JSON.stringify(preRegistration({ waveId: 'blocked' }))};`,
      'appendDelegationRecord({',
      `  cwd: ${JSON.stringify(dir)},`,
      '  record: wave,',
      `  env: { AW_DELEGATION_STORE: ${JSON.stringify(path)}, AW_DELEGATION_LOCK_WAIT_MS: '60000' },`,
      '  deps: { sleep: (ms) => {',
      `    if (!signalled) { writeFileSync(${JSON.stringify(waiting)}, 'waiting'); signalled = true; }`,
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      '  } },',
      '});',
      '',
    ].join('\n'));
    // The parent takes the SAME lock through the shared leaf — only its acquire/release surface is
    // used here, so the store's own validator and parser are irrelevant to this test.
    const lane = createStoreAppendLane({
      nouns: { store: 'delegation store', adj: 'delegation-store', record: 'delegation record' },
      envNames: { store: 'AW_DELEGATION_STORE', waitKnob: 'AW_DELEGATION_LOCK_WAIT_MS', pollKnob: 'AW_DELEGATION_LOCK_POLL_MS' },
      stop: (message) => new Error(message),
      resolveStorePath: resolveDelegationStorePath,
      resolveLockPath: resolveDelegationLockPath,
      validateRecord: () => ({ ok: true }),
      parseStoreText: () => ({ records: [], malformed: 0, malformedReasons: [] }),
    });
    const held = lane.acquireLock(path, env, {});
    const kid = runChild(runner, []);
    await waitFor(() => existsSync(waiting), 'the child to enter the lock wait lane');
    assert.equal(kid.exited, false, 'the appender must still be waiting while the lock is held');
    assert.equal(readDelegationStore(path).records.length, 0, 'nothing lands while the lock is held');
    assert.equal(lane.releaseLock(held.lockPath, held.lockFd, held.lockIdentity, {}), null);
    const done = await kid.done;
    assert.equal(done.status, 0, `the blocked appender failed after release: ${done.stderr}`);
    assert.deepEqual(readDelegationStore(path).records.map((r) => r.waveId), ['blocked']);
  });
});

describe('dispatch-store — the D5 uncommitted-state fingerprint helper', () => {
  const fakeStat = (kind) => ({
    isSymbolicLink: () => kind === 'symlink',
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isCharacterDevice: () => kind === 'char',
    isBlockDevice: () => kind === 'block',
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
  });
  // Classifies ONE named path as `kind` and lets every other path answer honestly.
  const classify = (rel, kind) => (full) => {
    if (full.endsWith(`/${rel}`)) {
      if (kind === 'unstatable') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return fakeStat(kind);
    }
    return fakeStat('file');
  };

  it('the helper DELEGATES to the frozen core — same tree, same digest, no re-derivation', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'unstaged.txt'), 'moved\n');
    assert.equal(uncommittedStateFingerprint(root), computeTreeFingerprint(root));
  });

  it('the contract has ONE name, and the helper states it', () => {
    assert.equal(UNCOMMITTED_STATE_FINGERPRINT, 'the uncommitted-state fingerprint');
  });

  it('outside a git work tree the helper REFUSES — never a null digest silently carried into a record', () => {
    const dir = join(TMP, 'no-repo-fp');
    mkdirSync(dir, { recursive: true });
    throwsStop(() => uncommittedStateFingerprint(dir), /cannot compute the uncommitted-state fingerprint/);
  });

  it('parity per special-path class: symlink carries name+target, binary and unstatable carry a marker', () => {
    const root = makeRepo();
    symlinkSync('base.txt', join(root, 'link'));
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    const payload = computeFingerprintPayload(root).toString('utf8');
    assert.match(payload, /untracked-symlink:link -> base\.txt\n/);
    assert.match(payload, /untracked-binary:bin\.dat\n/);
    assert.equal(uncommittedStateFingerprint(root), computeTreeFingerprint(root));
  });

  it('parity per special-path class: a directory or unstatable path is name-only', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'oddity'), 'plain\n');
    for (const kind of ['directory', 'unstatable']) {
      const fsx = { lstat: classify('oddity', kind) };
      const payload = computeFingerprintPayload(root, fsx).toString('utf8');
      assert.match(payload, /untracked-nonregular:oddity\n/, `${kind} is name-only`);
      assert.equal(payload.includes('plain\n'), false, 'the bytes are never read');
      assert.equal(uncommittedStateFingerprint(root, fsx), computeTreeFingerprint(root, fsx));
    }
  });

  it('parity per special-path class: char, block, FIFO and socket are EXCLUDED — no marker at all', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'nevercommit'), 'plain\n');
    for (const kind of ['char', 'block', 'fifo', 'socket']) {
      const fsx = { lstat: classify('nevercommit', kind) };
      const payload = computeFingerprintPayload(root, fsx).toString('utf8');
      assert.equal(payload.includes('nevercommit'), false, `${kind} carries NO marker — it is outside the domain entirely`);
      assert.equal(uncommittedStateFingerprint(root, fsx), computeTreeFingerprint(root, fsx));
    }
  });
});
