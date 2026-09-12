import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main, DISPATCH_CONTRACT } from '../dispatch.mjs';
import * as vocabulary from '../dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-dispatch-checkpoint-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CAP_S = 600;
const GRACE_S = 15;
const HEAD_DATE = '2030-01-01T00:00:00Z';
const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const REPORT = Buffer.from('the requested file was written\n');
const FIRST = 'first delegated change\n';
const SECOND = 'second delegated change\n';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sh = (cwd, args, env = {}) => {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};
const records = (ws) => {
  const result = readDelegationStore(ws.store);
  assert.equal(result.malformed, 0, result.malformedReasons.join('; '));
  return result.records;
};
const recordOf = (ws, kind, nonce) => records(ws).find((record) => record.kind === kind && record.nonce === nonce);
const run = (ws, argv) => main(argv, { cwd: ws.cwd, env: ws.env, now: ws.now });
const success = (result) => { assert.equal(result.code, 0, result.stderr); return result; };
const makeRepo = () => {
  const cwd = mkdtempSync(join(TMP, 'repo-'));
  sh(cwd, ['init', '-q', '-b', 'main']);
  sh(cwd, ['config', 'user.email', 'coder-tools@proton.me']);
  sh(cwd, ['config', 'user.name', 'coder-tool']);
  writeFileSync(join(cwd, 'base.txt'), 'base\n');
  sh(cwd, ['add', '-A']);
  sh(cwd, ['commit', '-q', '-m', 'initial tree'], { GIT_AUTHOR_DATE: HEAD_DATE, GIT_COMMITTER_DATE: HEAD_DATE });
  const dir = join(cwd, '.git');
  const store = join(dir, DELEGATION_STORE_BASENAME);
  const ticks = [];
  const ws = { cwd, dir, store, env: { AW_DELEGATION_STORE: store, AW_CORE_EVIDENCE: join(dir, 'evidence.jsonl') },
    now: () => new Date(Date.UTC(2031, 0, 1, 0, 0, ticks.push(null))).toISOString() };
  success(run(ws, ['register', '--wave', 'wave-a', '--step-classes', 'code', '--pairing-key', 'stepClass',
    '--min-per-class', '1', '--mean-l-threshold', '1', '--first-pass-num', '0', '--first-pass-den', '1']));
  return ws;
};
const snapshot = (ws) => {
  const dir = mkdtempSync(join(TMP, 'index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    sh(ws.cwd, ['read-tree', 'HEAD'], env);
    sh(ws.cwd, ['add', '-A', '-f'], env);
    return sh(ws.cwd, ['write-tree'], env);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const open = (ws, nonce, flags = [], retryIndex = 0, backend = 'codex') => {
  const contract = { schema: 1, nonce, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
    returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900,
    retry: { cap: 2, index: retryIndex } };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  const result = run(ws, ['open', '--contract', path, '--wave', 'wave-a', '--backend', backend,
    '--rationale', 'a bounded change', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S), ...flags]);
  return { contract, result };
};
const checkpointOpen = (ws, nonce, oid = snapshot(ws)) => {
  const opened = open(ws, nonce, ['--checkpoint', oid]);
  success(opened.result);
  return opened.contract;
};
const returned = (ws, contract, sessionId = SESSION_A) => {
  const dispatch = recordOf(ws, 'dispatch', contract.nonce);
  const backend = dispatch.backend;
  writeFileSync(join(ws.dir, execReportBasename(backend, contract.nonce)), REPORT);
  writeFileSync(join(ws.dir, execReceiptBasename(backend, contract.nonce)), JSON.stringify({
    schema: EXEC_RECEIPT_SCHEMA_VERSION, kind: EXEC_RECEIPT_KIND, state: 'terminal', backend,
    nonce: contract.nonce, owner: 'owner-token-1', contractDigest: vocabulary.contractDigest(contract),
    wrapperVersion: '3.4.1', posture: { model: 'gpt-5-codex', effort: 'high', tier: 'priority' },
    capS: CAP_S, killGraceS: GRACE_S, sessionId, exitStatus: 0, outcome: 'success',
    reportDigest: sha256(REPORT), reportLength: REPORT.length, timestamp: ws.now(),
  }));
  success(run(ws, ['return', '--nonce', contract.nonce]));
  return recordOf(ws, 'return', contract.nonce);
};
const fold = (ws, nonce) => run(ws, ['fold', '--nonce', nonce, '--verdict', 'accepted as returned']);
const degrade = (ws, nonce) => success(run(ws, ['degrade', '--wave', 'wave-a', '--nonce', nonce,
  '--step-class', 'code', '--rationale', 'withdraw this thread']));
const firstCycle = (ws) => {
  const opened = open(ws, 'first');
  success(opened.result);
  writeFileSync(join(ws.cwd, 'first.txt'), FIRST);
  const result = returned(ws, opened.contract);
  success(fold(ws, 'first'));
  return result;
};
const withoutBaseline = (ws, nonce) => writeFileSync(ws.store, records(ws).map((record) => {
  if (record.kind !== 'dispatch' || record.nonce !== nonce) return JSON.stringify(record);
  const { baseline, ...legacy } = record;
  return JSON.stringify(legacy);
}).join('\n') + '\n');
const refusesWithoutWrite = (ws, action, reason) => {
  const before = readFileSync(ws.store);
  const result = action();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, reason);
  assert.deepEqual(readFileSync(ws.store), before);
  return result;
};

describe('dispatch checkpoint verbs — spec:dispatch-baseline/S5', () => {
  it('exports the same strict tree-oid grammar used by open', () => {
    assert.equal(typeof vocabulary.isTreeOid, 'function');
    for (const oid of ['a'.repeat(40), 'b'.repeat(64)]) assert.equal(vocabulary.isTreeOid(oid), true);
    for (const oid of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), null]) assert.equal(vocabulary.isTreeOid(oid), false);
  });
  it('records a checkpoint pair and names the CLEAN base; a plain open records head', () => {
    const ws = makeRepo();
    const oid = snapshot(ws);
    const result = open(ws, 'checkpoint', ['--checkpoint', oid]).result;
    success(result);
    assert.match(result.stdout, new RegExp(`baseline CLEAN against checkpoint ${oid}`, 'u'));
    assert.deepEqual(recordOf(ws, 'dispatch', 'checkpoint').baseline, { kind: 'checkpoint', treeOid: oid });
    degrade(ws, 'checkpoint');
    success(open(ws, 'head').result);
    assert.deepEqual(recordOf(ws, 'dispatch', 'head').baseline, { kind: 'head', treeOid: null });
  });
  it('keeps both cycles eligible without a commit and measures only the second change', () => {
    const ws = makeRepo();
    const first = firstCycle(ws);
    const contract = checkpointOpen(ws, 'second');
    writeFileSync(join(ws.cwd, 'second.txt'), SECOND);
    const second = returned(ws, contract);
    success(fold(ws, 'second'));
    for (const nonce of ['first', 'second']) assert.equal(recordOf(ws, 'dispatch', nonce).baselineClean, true);
    assert.equal(first.metric.eligible, true);
    assert.equal(second.metric.eligible, true);
    assert.equal(second.metric.numeratorBytes, Buffer.byteLength(SECOND));
    assert.deepEqual(second.metric.components.map((entry) => entry.path), ['second.txt']);
  });
  it('retains the head dirty-baseline control', () => {
    const ws = makeRepo();
    firstCycle(ws);
    const opened = open(ws, 'dirty');
    success(opened.result);
    assert.equal(recordOf(ws, 'dispatch', 'dirty').baselineClean, false);
    assert.equal(returned(ws, opened.contract).metric.ineligibleReason, 'dirty-baseline');
  });
  it('ignores an index-only change for checkpoint cleanliness while head remains DIRTY', () => {
    const ws = makeRepo();
    const oid = snapshot(ws);
    writeFileSync(join(ws.cwd, 'base.txt'), 'index only\n');
    sh(ws.cwd, ['add', 'base.txt']);
    writeFileSync(join(ws.cwd, 'base.txt'), 'base\n');
    checkpointOpen(ws, 'checkpoint', oid);
    assert.equal(recordOf(ws, 'dispatch', 'checkpoint').baselineClean, true);
    degrade(ws, 'checkpoint');
    success(open(ws, 'head').result);
    assert.equal(recordOf(ws, 'dispatch', 'head').baselineClean, false);
  });
  it('refuses malformed oids and each non-tree object by name without writing', () => {
    const ws = makeRepo();
    sh(ws.cwd, ['tag', '-a', 'snapshot-tag', '-m', 'annotated tag']);
    const cells = [
      ...['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)].map((oid) => [oid, /40 or 64 lowercase hex/u]),
      [sh(ws.cwd, ['rev-parse', 'HEAD']), /names a commit, not a tree/u],
      [sh(ws.cwd, ['rev-parse', 'HEAD:base.txt']), /names a blob, not a tree/u],
      [sh(ws.cwd, ['rev-parse', 'snapshot-tag']), /names a tag, not a tree/u],
      ['f'.repeat(40), /unresolvable/u],
    ];
    for (const [oid, reason] of cells) refusesWithoutWrite(ws, () => open(ws, 'invalid', ['--checkpoint', oid]).result, reason);
  });
  it('refuses a head retry of a checkpoint origin', () => {
    const ws = makeRepo();
    checkpointOpen(ws, 'origin');
    degrade(ws, 'origin');
    refusesWithoutWrite(ws, () => open(ws, 'retry', ['--retry-of', 'origin'], 1).result, /refusing a retry: its base.*differs/u);
  });
  it('admits a head retry of an origin minted before baseline existed', () => {
    const ws = makeRepo();
    success(open(ws, 'origin').result);
    withoutBaseline(ws, 'origin');
    degrade(ws, 'origin');
    success(open(ws, 'retry', ['--retry-of', 'origin'], 1).result);
    assert.deepEqual(recordOf(ws, 'dispatch', 'retry').baseline, { kind: 'head', treeOid: null });
  });
  it('refuses a substituted fold, then a ledger degrade allows a new held-session fold', () => {
    const ws = makeRepo();
    firstCycle(ws);
    const foreign = checkpointOpen(ws, 'foreign');
    writeFileSync(join(ws.cwd, 'foreign.txt'), SECOND);
    returned(ws, foreign, SESSION_B);
    const refusal = refusesWithoutWrite(ws, () => fold(ws, 'foreign'), /dispatch degrade --wave wave-a --nonce foreign/u);
    assert.match(refusal.stderr, /then retry it/u);
    assert.match(refusal.stderr, /session "session-b".*held session it was opened against was "session-a"/u);
    degrade(ws, 'foreign');
    const continued = checkpointOpen(ws, 'continued');
    writeFileSync(join(ws.cwd, 'continued.txt'), FIRST);
    returned(ws, continued);
    success(fold(ws, 'continued'));
  });
  it('reads evidence-covered head replacement when judging a later checkpoint continuation', () => {
    const ws = makeRepo();
    firstCycle(ws);
    const replacement = open(ws, 'replacement');
    success(replacement.result);
    writeFileSync(join(ws.cwd, 'replacement.txt'), SECOND);
    const result = returned(ws, replacement.contract, SESSION_B);
    writeFileSync(ws.env.AW_CORE_EVIDENCE, JSON.stringify({ schema: 1, kind: 'degrade', backend: 'codex-exec',
      reason: 'accepted replacement', fingerprint: result.postTreeDigest, timestamp: ws.now() }) + '\n');
    success(fold(ws, 'replacement'));
    const continued = checkpointOpen(ws, 'continued');
    writeFileSync(join(ws.cwd, 'continued.txt'), FIRST);
    returned(ws, continued, SESSION_B);
    success(fold(ws, 'continued'));
  });
  it('ignores agy checkpoint sessions even when that backend has a prior folded session', () => {
    const ws = makeRepo();
    firstCycle(ws);
    const first = open(ws, 'agy-first', [], 0, 'agy');
    success(first.result);
    writeFileSync(join(ws.cwd, 'agy-first.txt'), FIRST);
    returned(ws, first.contract, SESSION_A);
    success(fold(ws, 'agy-first'));
    const checkpoint = open(ws, 'agy-checkpoint', ['--checkpoint', snapshot(ws)], 0, 'agy');
    success(checkpoint.result);
    writeFileSync(join(ws.cwd, 'agy-second.txt'), SECOND);
    returned(ws, checkpoint.contract, SESSION_B);
    success(fold(ws, 'agy-checkpoint'));
  });
  it('names unavailable evidence when a substituted checkpoint fold refuses', () => {
    const ws = makeRepo();
    firstCycle(ws);
    const contract = checkpointOpen(ws, 'foreign');
    writeFileSync(join(ws.cwd, 'foreign.txt'), SECOND);
    returned(ws, contract, SESSION_B);
    writeFileSync(ws.env.AW_CORE_EVIDENCE, 'malformed\n');
    refusesWithoutWrite(ws, () => fold(ws, 'foreign'), /evidence store is unavailable: judged with no degrade record/u);
  });
  it('fails closed on a malformed delegation ledger at fold', () => {
    const ws = makeRepo();
    const contract = checkpointOpen(ws, 'checkpoint');
    writeFileSync(join(ws.cwd, 'second.txt'), SECOND);
    returned(ws, contract);
    appendFileSync(ws.store, 'malformed\n');
    refusesWithoutWrite(ws, () => fold(ws, 'checkpoint'), /malformed|JSON|line/iu);
  });
  it('does not refuse an unchanged content-blind object already in the base tree', () => {
    const ws = makeRepo();
    writeFileSync(join(ws.cwd, 'opaque.bin'), Buffer.from([0, 1, 2]));
    const contract = checkpointOpen(ws, 'checkpoint');
    writeFileSync(join(ws.cwd, 'second.txt'), SECOND);
    returned(ws, contract);
    success(fold(ws, 'checkpoint'));
  });
});

describe('dispatch pre-field ledger compatibility — spec:dispatch-baseline/S6', () => {
  it('returns and folds a hand-written dispatch without the baseline key', () => {
    const ws = makeRepo();
    const opened = open(ws, 'legacy');
    success(opened.result);
    withoutBaseline(ws, 'legacy');
    writeFileSync(join(ws.cwd, 'first.txt'), FIRST);
    assert.equal(returned(ws, opened.contract).metric.eligible, true);
    success(fold(ws, 'legacy'));
  });
  it('names the recorded base in the contract sentence', () => {
    assert.ok(DISPATCH_CONTRACT.includes("`open` records the thread's BASE"));
  });
});
