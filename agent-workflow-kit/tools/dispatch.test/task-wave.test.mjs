import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main } from '../dispatch.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';
import { main as reviewMain, buildState, decideCheck } from '../review-state.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-dispatch-task-wave-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const BRIEF_B = 'docs/plans/TASK-fixture-T2.md';
const PLAN = 'docs/plans/fixture-wave.md';
const CAP_S = 600;
const GRACE_S = 15;
const SECOND_MS = 1000;
const HEAD_DATE = '2030-01-01T00:00:00Z';
const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const REPORT = Buffer.from('the requested file was written\n');
const CHANGE_A = 'export const a = 1;\n';
const CHANGE_B = 'export const b = 1;\n';
const NEXT_CHANGE_B = 'export const b = 2;\n';
const GUARD_SOURCE = readFileSync(new URL('../commit-guard.mjs', import.meta.url), 'utf8');
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
const success = (result) => {
  assert.equal(result.code, 0, result.stderr || result.reason || result.stdout);
  return result;
};
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
const writeBrief = (ws, brief, files) => {
  mkdirSync(join(ws.cwd, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(ws.cwd, brief), [
    '# Task: fixture task', 'Story: S1 of FIXTURE-EPIC', '', '## Slice',
    `Plan: ${PLAN}`, 'Row: t1', 'Grouping: test', 'Files:',
    ...files.map((path) => `- ${path} :: test`), '',
    '## Reads', '- base.txt', '', '## Acceptance', '- node --test fixture.test.mjs :: green', '',
    '## Negative cases', '- none', '', '## Budget', ...files.map((path) => `- ${path} :: 100`), '',
  ].join('\n'));
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
const makeScenario = () => {
  const ws = makeRepo();
  writeBrief(ws, BRIEF_A, ['src/a.mjs']);
  writeBrief(ws, BRIEF_B, ['src/b.mjs']);
  mkdirSync(join(ws.cwd, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(ws.cwd, 'docs/ai/orchestration.json'), JSON.stringify({
    'plan-execution': { execute: 'delegated', review: 'solo' },
  }));
  writeFileSync(join(ws.cwd, PLAN), '# Plan: fixture wave\n');
  ws.oid = snapshot(ws);
  return ws;
};
const open = (ws, nonce, flags) => {
  const contract = { schema: 1, nonce, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
    returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900,
    retry: { cap: 2, index: 0 } };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  return run(ws, ['open', '--contract', path, '--wave', 'wave-a', '--backend', 'codex',
    '--rationale', 'a bounded change', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S), ...flags]);
};
const taskOpen = (ws, nonce, brief) => success(open(ws, nonce, ['--checkpoint', ws.oid, '--task', brief]));
const returned = (ws, nonce, sessionId) => {
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
  success(run(ws, ['return', '--nonce', nonce]));
  return recordOf(ws, 'return', nonce);
};
const fold = (ws, nonce) => success(run(ws, ['fold', '--nonce', nonce, '--verdict', 'accepted as returned']));

describe('a task wave on one checkpoint — spec:task-thread/S8', () => {
  it('two file-disjoint task threads on one checkpoint fold on two sessions with no degrade', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a', BRIEF_A);
    taskOpen(ws, 'task-b', BRIEF_B);
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE_A);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), CHANGE_B);
    returned(ws, 'task-a', SESSION_A);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), NEXT_CHANGE_B);
    fold(ws, 'task-a');
    returned(ws, 'task-b', SESSION_B);
    fold(ws, 'task-b');

    for (const nonce of ['task-a', 'task-b']) assert.ok(recordOf(ws, 'fold', nonce), nonce);
    assert.equal(records(ws).some((record) => record.kind === 'degrade'), false);
    const ctx = { cwd: ws.cwd, env: { ...process.env, ...ws.env } };
    success(reviewMain(['--check'], ctx));
    const state = JSON.parse(success(reviewMain(['--json'], ctx)).stdout);
    assert.equal(state.plans.length, 1);
    assert.ok(state.heldSession);
    assert.equal(state.heldSession.chains.length, 2);
    assert.equal(state.heldSession.substitution, null);
    assert.ok(success(reviewMain([], ctx)).stdout.includes('held sessions: 2 chain(s)'));

    const reviewEnv = { ...ctx.env };
    delete reviewEnv.AW_REVIEW_RECEIPTS;
    delete reviewEnv.AW_CORE_EVIDENCE;
    delete reviewEnv.AW_FLOW_STORE;
    delete reviewEnv.AW_DELEGATION_STORE;
    assert.ok(GUARD_SOURCE.includes('decideCheck(buildState({ cwd, env: reviewEnv }))'));
    success(decideCheck(buildState({ cwd: ws.cwd, env: reviewEnv })));
  });

  it('each return counts only its own Files', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a', BRIEF_A);
    taskOpen(ws, 'task-b', BRIEF_B);
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE_A);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), CHANGE_B);
    const result = returned(ws, 'task-a', SESSION_A);
    assert.deepEqual(result.metric.components.map((c) => c.path), ['src/a.mjs']);
  });

  it('the folds may cross the returns', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a', BRIEF_A);
    taskOpen(ws, 'task-b', BRIEF_B);
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE_A);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), CHANGE_B);
    returned(ws, 'task-b', SESSION_B);
    returned(ws, 'task-a', SESSION_A);
    fold(ws, 'task-b');
    fold(ws, 'task-a');
    for (const nonce of ['task-a', 'task-b']) assert.ok(recordOf(ws, 'fold', nonce), nonce);
    success(reviewMain(['--check'], { cwd: ws.cwd, env: { ...process.env, ...ws.env } }));
  });
});
