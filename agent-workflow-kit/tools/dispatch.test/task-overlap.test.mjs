import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main } from '../dispatch.mjs';
import * as vocabulary from '../dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';
import { readDelegationLedger, auditDelegationStoreSemantics } from '../dispatch-store-read.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-dispatch-task-overlap-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const BRIEF_B = 'docs/plans/TASK-fixture-T2.md';
const CAP_S = 600;
const GRACE_S = 15;
const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const HEAD_DATE = '2030-01-01T00:00:00Z';
const SESSION_A = 'session-a';
const REPORT = Buffer.from('the requested file was written\n');
const CHANGE = 'export const value = 1;\n';
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
const run = (ws, argv, cwd = ws.cwd) => main(argv, { cwd, env: ws.env, now: ws.now });
const success = (result) => { assert.equal(result.code, 0, result.stderr); return result; };
const makeRepo = () => {
  const cwd = mkdtempSync(join(TMP, 'repo-'));
  sh(cwd, ['init', '-q', '-b', 'main']);
  sh(cwd, ['config', 'user.email', 'coder-tools@proton.me']);
  sh(cwd, ['config', 'user.name', 'coder-tool']);
  writeFileSync(join(cwd, 'base.txt'), 'base\n');
  mkdirSync(join(cwd, 'src'));
  for (const path of ['src/a.mjs', 'src/b.mjs']) writeFileSync(join(cwd, path), 'export {};\n');
  sh(cwd, ['add', '-A']);
  sh(cwd, ['commit', '-q', '-m', 'initial tree'], { GIT_AUTHOR_DATE: HEAD_DATE, GIT_COMMITTER_DATE: HEAD_DATE });
  const dir = join(cwd, '.git');
  const store = join(dir, DELEGATION_STORE_BASENAME);
  const ws = { cwd, dir, store, clock: Date.UTC(2031, 0, 1),
    env: { AW_DELEGATION_STORE: store, AW_CORE_EVIDENCE: join(dir, 'evidence.jsonl') },
    now: () => { ws.clock += SECOND_MS; return new Date(ws.clock).toISOString(); } };
  success(run(ws, ['register', '--wave', 'wave-a', '--step-classes', 'code,triage', '--pairing-key', 'stepClass',
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
const writeBrief = (ws, brief, files) => {
  mkdirSync(join(ws.cwd, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(ws.cwd, brief), [
    '# Task: fixture task', 'Story: S1 of FIXTURE-EPIC', '', '## Slice',
    'Plan: docs/plans/fixture.md', 'Row: t1', 'Grouping: test', 'Files:',
    ...files.map((path) => `- ${path} :: test`), '',
    '## Reads', '- base.txt', '', '## Acceptance', '- node --test fixture.test.mjs :: green', '',
    '## Negative cases', '- none', '', '## Budget', ...files.map((path) => `- ${path} :: 100`), '',
  ].join('\n'));
};
const makeScenario = (filesA = ['src/a.mjs'], filesB = ['src/a.mjs']) => {
  const ws = makeRepo();
  writeBrief(ws, BRIEF_A, filesA);
  writeBrief(ws, BRIEF_B, filesB);
  ws.oid = snapshot(ws);
  return ws;
};
const open = (ws, nonce, flags = [], stepClass = 'code', cwd = ws.cwd) => {
  const contract = { schema: 1, nonce, stepClass, vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
    returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900,
    retry: { cap: 2, index: 0 } };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  return run(ws, ['open', '--contract', path, '--wave', 'wave-a', '--backend', 'codex',
    '--rationale', 'a bounded change', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S), ...flags], cwd);
};
const taskOpen = (ws, nonce, brief = BRIEF_A) => success(open(ws, nonce, ['--checkpoint', ws.oid, '--task', brief]));
const returned = (ws, nonce, sessionId, outcome = 'success') => {
  const dispatch = recordOf(ws, 'dispatch', nonce);
  const backend = dispatch.backend;
  writeFileSync(join(ws.dir, execReportBasename(backend, nonce)), REPORT);
  writeFileSync(join(ws.dir, execReceiptBasename(backend, nonce)), JSON.stringify({
    schema: EXEC_RECEIPT_SCHEMA_VERSION, kind: EXEC_RECEIPT_KIND, state: 'terminal', backend,
    nonce, owner: 'owner-token-1', contractDigest: dispatch.contractDigest,
    wrapperVersion: '3.4.1', posture: { model: 'gpt-5-codex', effort: 'high', tier: 'priority' },
    capS: CAP_S, killGraceS: GRACE_S, sessionId, exitStatus: 0, outcome: 'success',
    reportDigest: sha256(REPORT), reportLength: REPORT.length, timestamp: ws.now(),
  }));
  success(run(ws, ['return', '--nonce', nonce, ...(outcome === 'success' ? [] : ['--outcome', outcome])]));
  return recordOf(ws, 'return', nonce);
};
const fold = (ws, nonce) => success(run(ws, ['fold', '--nonce', nonce, '--verdict', 'accepted as returned']));
const degrade = (ws, nonce) => success(run(ws, ['degrade', '--wave', 'wave-a', '--nonce', nonce,
  '--step-class', 'code', '--rationale', 'withdraw this thread']));
const refusesWithoutWrite = (ws, action, reason, nonce, paths = []) => {
  const before = readFileSync(ws.store);
  const result = action();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, reason);
  for (const text of [nonce, ...paths]) assert.ok(result.stderr.includes(text), result.stderr);
  assert.deepEqual(readFileSync(ws.store), before);
};
const foldTaskA = (ws) => {
  taskOpen(ws, 'task-a');
  writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
  returned(ws, 'task-a', SESSION_A);
  fold(ws, 'task-a');
};

describe('files-overlap and mixed-open at append time — spec:task-thread/S6', () => {
  it('refuses the later open whose Files overlap an open task by prefix', () => {
    const ws = makeScenario(['src/lib'], ['src/lib/x.mjs']);
    assert.equal(existsSync(join(ws.cwd, 'src/lib')), false);
    taskOpen(ws, 'task-a');
    refusesWithoutWrite(ws, () => open(ws, 'task-b', ['--checkpoint', ws.oid, '--task', BRIEF_B]),
      /\bfiles-overlap\b/u, 'task-a', ['src/lib']);
    assert.equal(existsSync(join(ws.cwd, 'src/lib')), false);
  });

  it('keeps the Files claimed after a success return without a fold', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a');
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
    assert.equal(returned(ws, 'task-a', SESSION_A).outcome, 'success');
    refusesWithoutWrite(ws, () => open(ws, 'task-b', ['--checkpoint', ws.oid, '--task', BRIEF_B]),
      /\bfiles-overlap\b/u, 'task-a', ['src/a.mjs']);
  });

  it('keeps folded Files for their brief and allows another thread of that same brief', () => {
    const ws = makeScenario(['src/a.mjs'], ['src/a.mjs', 'src/b.mjs']);
    foldTaskA(ws);
    refusesWithoutWrite(ws, () => open(ws, 'task-b', ['--checkpoint', ws.oid, '--task', BRIEF_B]),
      /\bfiles-overlap\b/u, 'task-a', ['src/a.mjs']);
    taskOpen(ws, 'task-a-again');
    assert.equal(recordOf(ws, 'dispatch', 'task-a-again').task.brief, BRIEF_A);
  });

  it('frees the Files after degrade or a terminal partial-edit return without a fold', () => {
    for (const closure of ['degrade', 'partial-edit']) {
      const ws = makeScenario();
      taskOpen(ws, 'task-a');
      if (closure === 'degrade') degrade(ws, 'task-a');
      else {
        writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
        const terminal = returned(ws, 'task-a', SESSION_A, 'partial-edit');
        assert.equal(terminal.outcome, 'partial-edit');
        assert.equal(vocabulary.isThreadTerminalRecord(terminal), true);
      }
      taskOpen(ws, 'task-b', BRIEF_B);
      assert.equal(recordOf(ws, 'dispatch', 'task-b').task.brief, BRIEF_B);
    }
  });

  it('ends claims at a commit, honors cwd, and keeps the ledger readable after HEAD moves back', () => {
    const ws = makeScenario();
    foldTaskA(ws);
    const commitMs = ws.clock + HOUR_MS;
    const commitDate = new Date(commitMs).toISOString();
    assert.ok(Date.parse(recordOf(ws, 'fold', 'task-a').timestamp) < commitMs);
    sh(ws.cwd, ['add', '-A']);
    sh(ws.cwd, ['commit', '-q', '-m', 'accept first task'], { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate });
    ws.clock = commitMs + HOUR_MS;
    const oid = snapshot(ws);
    const outside = mkdtempSync(join(TMP, 'outside-'));
    success(open(ws, 'task-b', ['--cwd', ws.cwd, '--checkpoint', oid, '--task', BRIEF_B], 'code', outside));
    const dispatch = recordOf(ws, 'dispatch', 'task-b');
    assert.deepEqual(dispatch.task, { brief: BRIEF_B, files: ['src/a.mjs'] });
    assert.deepEqual(dispatch.baseline, { kind: 'checkpoint', treeOid: oid });
    assert.ok(Date.parse(dispatch.timestamp) > commitMs);
    sh(ws.cwd, ['reset', '-q', '--soft', 'HEAD~1']);
    const ledger = readDelegationLedger(ws.cwd, ws.env);
    assert.equal(ledger.state, 'ok', ledger.reason);
    assert.deepEqual(auditDelegationStoreSemantics({ records: records(ws) }), { ok: true });
  });

  it('refuses untasked code and triage opens while a task thread is open', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a');
    refusesWithoutWrite(ws, () => open(ws, 'untasked-code', ['--checkpoint', ws.oid]), /\bmixed-open\b/u, 'task-a');
    refusesWithoutWrite(ws, () => open(ws, 'untasked-triage', [], 'triage'), /\bmixed-open\b/u, 'task-a');
  });

  it('refuses a task open while an untasked checkpoint code thread is open', () => {
    const ws = makeScenario();
    success(open(ws, 'untasked-code', ['--checkpoint', ws.oid]));
    refusesWithoutWrite(ws, () => open(ws, 'task-a', ['--checkpoint', ws.oid, '--task', BRIEF_A]),
      /\bmixed-open\b/u, 'untasked-code');
  });

  it('refuses untasked codex code after a task fold but permits untasked triage', () => {
    const ws = makeScenario();
    foldTaskA(ws);
    refusesWithoutWrite(ws, () => open(ws, 'untasked-code', ['--checkpoint', ws.oid]), /\bmixed-open\b/u, 'task-a');
    success(open(ws, 'untasked-triage', [], 'triage'));
    const dispatch = recordOf(ws, 'dispatch', 'untasked-triage');
    assert.equal(dispatch.stepClass, 'triage');
    assert.equal(Object.hasOwn(dispatch, 'task'), false);
  });
});
