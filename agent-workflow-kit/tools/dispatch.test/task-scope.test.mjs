import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main, DISPATCH_CONTRACT } from '../dispatch.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-dispatch-task-scope-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const BRIEF_B = 'docs/plans/TASK-fixture-T2.md';
const CAP_S = 600;
const GRACE_S = 15;
const SECOND_MS = 1000;
const HEAD_DATE = '2030-01-01T00:00:00Z';
const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const REPORT = Buffer.from('the requested file was written\n');
const CHANGE = 'export const value = 1;\n';
const NEXT_CHANGE = 'export const value = 2;\n';
const TASK_CLAUSE = '`open --task` records the task, a task thread is measured over its Files and '
  + '`open`, `return` and `fold` refuse `files-overlap`, `mixed-open` and `out-of-files`';
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
  mkdirSync(join(cwd, 'src'));
  for (const path of ['src/a.mjs', 'src/b.mjs']) writeFileSync(join(cwd, path), 'export {};\n');
  sh(cwd, ['add', '-A']);
  sh(cwd, ['commit', '-q', '-m', 'initial tree'], { GIT_AUTHOR_DATE: HEAD_DATE, GIT_COMMITTER_DATE: HEAD_DATE });
  const dir = join(cwd, '.git');
  const store = join(dir, DELEGATION_STORE_BASENAME);
  const ws = { cwd, dir, store, clock: Date.UTC(2031, 0, 1),
    env: { AW_DELEGATION_STORE: store, AW_CORE_EVIDENCE: join(dir, 'evidence.jsonl') },
    now: () => { ws.clock += SECOND_MS; return new Date(ws.clock).toISOString(); } };
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
const makeScenario = () => {
  const ws = makeRepo();
  writeBrief(ws, BRIEF_A, ['src/a.mjs']);
  writeBrief(ws, BRIEF_B, ['src/b.mjs']);
  ws.oid = snapshot(ws);
  return ws;
};
const open = (ws, nonce, flags = []) => {
  const contract = { schema: 1, nonce, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
    returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900,
    retry: { cap: 2, index: 0 } };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  return run(ws, ['open', '--contract', path, '--wave', 'wave-a', '--backend', 'codex',
    '--rationale', 'a bounded change', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S), ...flags]);
};
const taskOpen = (ws, nonce, brief = BRIEF_A, oid = ws.oid) =>
  success(open(ws, nonce, ['--checkpoint', oid, '--task', brief]));
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
  return run(ws, ['return', '--nonce', nonce, ...(outcome === 'success' ? [] : ['--outcome', outcome])]);
};
const fold = (ws, nonce) => run(ws, ['fold', '--nonce', nonce, '--verdict', 'accepted as returned']);
const degrade = (ws, nonce) => success(run(ws, ['degrade', '--wave', 'wave-a', '--nonce', nonce,
  '--step-class', 'code', '--rationale', 'withdraw this thread']));
const refusesWithoutWrite = (ws, action, reason, nonce, paths = []) => {
  const before = readFileSync(ws.store);
  const result = action();
  const context = `${nonce}: ${result.stderr}`;
  assert.equal(result.code, 1, context);
  assert.match(result.stderr, reason, context);
  for (const path of paths) assert.ok(result.stderr.includes(path), context);
  assert.deepEqual(readFileSync(ws.store), before, context);
  return result;
};

describe('out-of-files at return and fold — spec:task-thread/S7', () => {
  it('refuses return naming every unclaimed path and no claimed path without writing', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a');
    for (const path of ['src/a.mjs', 'stray-1.txt', 'stray-2.txt']) writeFileSync(join(ws.cwd, path), CHANGE);
    const result = refusesWithoutWrite(ws, () => returned(ws, 'task-a', SESSION_A),
      /\bout-of-files\b/u, 'task-a', ['stray-1.txt', 'stray-2.txt']);
    assert.ok(!result.stderr.includes('src/a.mjs'), result.stderr);
  });

  it('allows an open sibling on the same base to write between return and fold', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a');
    taskOpen(ws, 'task-b', BRIEF_B);
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), CHANGE);
    success(returned(ws, 'task-a', SESSION_A));
    writeFileSync(join(ws.cwd, 'src/b.mjs'), NEXT_CHANGE);
    success(fold(ws, 'task-a'));
    success(returned(ws, 'task-b', SESSION_B));
    success(fold(ws, 'task-b'));
  });

  it('allows a folded sibling claim on the same base while its bytes remain', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a');
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
    success(returned(ws, 'task-a', SESSION_A));
    success(fold(ws, 'task-a'));
    taskOpen(ws, 'task-b', BRIEF_B);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), NEXT_CHANGE);
    success(returned(ws, 'task-b', SESSION_B));
    success(fold(ws, 'task-b'));
    assert.equal(readFileSync(join(ws.cwd, 'src/a.mjs'), 'utf8'), CHANGE);
  });

  it('refuses return for a degraded sibling whose Files no longer claim its write', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-b', BRIEF_B);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), CHANGE);
    degrade(ws, 'task-b');
    taskOpen(ws, 'task-a');
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
    refusesWithoutWrite(ws, () => returned(ws, 'task-a', SESSION_A),
      /\bout-of-files\b/u, 'task-a', ['src/b.mjs']);
  });

  it('refuses return when the sibling claim was recorded on another base', () => {
    const ws = makeScenario();
    const oid1 = ws.oid;
    taskOpen(ws, 'task-b', BRIEF_B, oid1);
    writeFileSync(join(ws.cwd, 'src/c.mjs'), CHANGE);
    const oid2 = snapshot(ws);
    assert.notEqual(oid2, oid1);
    taskOpen(ws, 'task-a', BRIEF_A, oid2);
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
    writeFileSync(join(ws.cwd, 'src/b.mjs'), NEXT_CHANGE);
    refusesWithoutWrite(ws, () => returned(ws, 'task-a', SESSION_A),
      /\bout-of-files\b/u, 'task-a', ['src/b.mjs']);
  });

  it('refuses fold naming an unclaimed write after return without writing', () => {
    const ws = makeScenario();
    taskOpen(ws, 'task-a');
    writeFileSync(join(ws.cwd, 'src/a.mjs'), CHANGE);
    success(returned(ws, 'task-a', SESSION_A));
    writeFileSync(join(ws.cwd, 'late.txt'), NEXT_CHANGE);
    refusesWithoutWrite(ws, () => fold(ws, 'task-a'), /\bout-of-files\b/u, 'task-a', ['late.txt']);
  });

  it('keeps untasked checkpoint return and fold free of out-of-files refusals', () => {
    const ws = makeRepo();
    const oid = snapshot(ws);
    const opened = success(open(ws, 'untasked', ['--checkpoint', oid]));
    writeFileSync(join(ws.cwd, 'stray.txt'), CHANGE);
    const result = success(returned(ws, 'untasked', SESSION_A));
    const folded = success(fold(ws, 'untasked'));
    for (const step of [opened, result, folded]) assert.doesNotMatch(step.stderr, /\bout-of-files\b/u);
  });

  it('carries the task clause in DISPATCH_CONTRACT and the full contract in the mode doc', () => {
    const mode = readFileSync(new URL('../../references/modes/dispatch.md', import.meta.url), 'utf8');
    assert.ok(DISPATCH_CONTRACT.includes(TASK_CLAUSE));
    assert.ok(mode.includes(DISPATCH_CONTRACT));
  });
});
