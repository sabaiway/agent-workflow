import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../dispatch.mjs';
import * as vocabulary from '../dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-dispatch-task-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const BRIEF_B = 'docs/plans/TASK-fixture-T2.md';
const CAP_S = 600;
const GRACE_S = 15;
const HEAD_DATE = '2030-01-01T00:00:00Z';
const FILES = ['src/a.mjs', 'src/b.mjs'];

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
  for (const path of [...FILES, 'src/c.mjs']) writeFileSync(join(cwd, path), 'export {};\n');
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
const writeBrief = (ws, brief = BRIEF_A, files = FILES, { budget = true } = {}) => {
  mkdirSync(join(ws.cwd, 'docs', 'plans'), { recursive: true });
  const lines = [
    '# Task: fixture task', 'Story: S1 of FIXTURE-EPIC', '', '## Slice',
    'Plan: docs/plans/fixture.md', 'Row: t1', 'Grouping: test', 'Files:',
    ...files.map((path) => `- ${path} :: test`), '',
    '## Reads', '- base.txt', '', '## Acceptance', '- node --test fixture.test.mjs :: green', '',
    '## Negative cases', '- none',
    ...(budget ? ['', '## Budget', ...files.map((path) => `- ${path} :: 100`)] : []), '',
  ];
  writeFileSync(join(ws.cwd, brief), lines.join('\n'));
};
const open = (ws, nonce, flags = [], retryIndex = 0) => {
  const contract = { schema: 1, nonce, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
    returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900,
    retry: { cap: 2, index: retryIndex } };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  return run(ws, ['open', '--contract', path, '--wave', 'wave-a', '--backend', 'codex',
    '--rationale', 'a bounded change', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S), ...flags]);
};
const degrade = (ws, nonce) => success(run(ws, ['degrade', '--wave', 'wave-a', '--nonce', nonce,
  '--step-class', 'code', '--rationale', 'withdraw this thread']));
const refusesWithoutWrite = (ws, action, reason) => {
  const before = readFileSync(ws.store);
  const result = action();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, reason);
  assert.deepEqual(readFileSync(ws.store), before);
};
const withoutBaseline = (ws, nonce) => writeFileSync(ws.store, records(ws).map((record) => {
  if (record.kind !== 'dispatch' || record.nonce !== nonce) return JSON.stringify(record);
  const { baseline, ...legacy } = record;
  return JSON.stringify(legacy);
}).join('\n') + '\n');

describe('dispatch open --task — spec:task-thread/S2', () => {
  it('records the brief and byte-ordered files beside the checkpoint baseline', () => {
    const ws = makeRepo();
    writeBrief(ws, BRIEF_A, ['src/b.mjs', 'src/a.mjs']);
    const oid = snapshot(ws);
    success(open(ws, 'task-open', ['--checkpoint', oid, '--task', BRIEF_A]));
    const dispatch = recordOf(ws, 'dispatch', 'task-open');
    assert.deepEqual(dispatch.task, { brief: BRIEF_A, files: ['src/a.mjs', 'src/b.mjs'] });
    assert.deepEqual(dispatch.baseline, { kind: 'checkpoint', treeOid: oid });
  });

  it('reads the brief at the git top-level when open runs from a subdirectory', () => {
    const ws = makeRepo();
    writeBrief(ws);
    const nested = { ...ws, cwd: join(ws.cwd, 'src') };
    writeBrief(nested, BRIEF_A, ['src/c.mjs']);
    const oid = snapshot(ws);
    success(open(nested, 'task-subdirectory', ['--checkpoint', oid, '--task', BRIEF_A]));
    assert.deepEqual(recordOf(ws, 'dispatch', 'task-subdirectory').task, { brief: BRIEF_A, files: FILES });
  });

  it('records the files in UTF-8 byte order', () => {
    const ws = makeRepo();
    writeBrief(ws, BRIEF_A, ['src/a\u{10000}.mjs', 'src/a\u{E000}.mjs']);
    const oid = snapshot(ws);
    success(open(ws, 'task-byte-order', ['--checkpoint', oid, '--task', BRIEF_A]));
    assert.deepEqual(recordOf(ws, 'dispatch', 'task-byte-order').task.files, ['src/a\u{E000}.mjs', 'src/a\u{10000}.mjs']);
  });

  it('refuses task without checkpoint as task-base and leaves the store unchanged', () => {
    const ws = makeRepo();
    writeBrief(ws);
    refusesWithoutWrite(ws, () => open(ws, 'no-checkpoint', ['--task', BRIEF_A]), /\btask-base\b/u);
  });

  it('refuses a brief without Budget as shape and leaves the store unchanged', () => {
    const ws = makeRepo();
    writeBrief(ws, BRIEF_A, FILES, { budget: false });
    const oid = snapshot(ws);
    refusesWithoutWrite(ws, () => open(ws, 'no-budget', ['--checkpoint', oid, '--task', BRIEF_A]), /\bshape\b/u);
  });

  it('refuses a brief outside the TASK name form as task-brief without writing', () => {
    const ws = makeRepo();
    const brief = 'docs/plans/fixture-brief.md';
    writeBrief(ws, brief);
    const oid = snapshot(ws);
    refusesWithoutWrite(ws, () => open(ws, 'wrong-name', ['--checkpoint', oid, '--task', brief]), /\btask-brief\b/u);
  });

  it('refuses a parent segment in Files as task-files without writing', () => {
    const ws = makeRepo();
    writeBrief(ws, BRIEF_A, ['src/../x.mjs']);
    const oid = snapshot(ws);
    refusesWithoutWrite(ws, () => open(ws, 'parent-path', ['--checkpoint', oid, '--task', BRIEF_A]), /\btask-files\b/u);
  });

  it('preserves the untasked checkpoint record and CLEAN baseline output', () => {
    const ws = makeRepo();
    const oid = snapshot(ws);
    const result = success(open(ws, 'untasked', ['--checkpoint', oid]));
    const dispatch = recordOf(ws, 'dispatch', 'untasked');
    assert.equal(Object.hasOwn(dispatch, 'task'), false);
    assert.deepEqual(Object.keys(dispatch).sort(),
      ['schema', 'kind', ...vocabulary.DELEGATION_KEY_SETS.dispatch.filter((field) => field !== 'task')].sort());
    assert.deepEqual(dispatch.baseline, { kind: 'checkpoint', treeOid: oid });
    assert.match(result.stdout, new RegExp(`baseline CLEAN against checkpoint ${oid}`, 'u'));
  });

  it('refuses retries with a changed or absent task and accepts the restored task', () => {
    const ws = makeRepo();
    writeBrief(ws, BRIEF_A);
    writeBrief(ws, BRIEF_B);
    const oid = snapshot(ws);
    success(open(ws, 'origin', ['--checkpoint', oid, '--task', BRIEF_A]));
    const origin = recordOf(ws, 'dispatch', 'origin');
    degrade(ws, 'origin');
    const flags = ['--checkpoint', oid, '--retry-of', 'origin'];
    const reason = /refusing a retry: its task\b/u;
    refusesWithoutWrite(ws, () => open(ws, 'retry-brief', [...flags, '--task', BRIEF_B], 1), reason);
    writeBrief(ws, BRIEF_A, [...FILES, 'src/c.mjs']);
    refusesWithoutWrite(ws, () => open(ws, 'retry-files', [...flags, '--task', BRIEF_A], 1), reason);
    refusesWithoutWrite(ws, () => open(ws, 'retry-untasked', flags, 1), reason);
    writeBrief(ws, BRIEF_A);
    success(open(ws, 'retry-same', [...flags, '--task', BRIEF_A], 1));
    const retried = recordOf(ws, 'dispatch', 'retry-same');
    assert.deepEqual(retried.task, origin.task);
    assert.equal(retried.retryOf, 'origin');
    assert.equal(retried.retryIndex, 1);
  });

  it('opens a task after a pre-field dispatch was degraded and keeps the ledger readable', () => {
    const ws = makeRepo();
    success(open(ws, 'legacy'));
    degrade(ws, 'legacy');
    withoutBaseline(ws, 'legacy');
    const legacy = recordOf(ws, 'dispatch', 'legacy');
    assert.equal(Object.hasOwn(legacy, 'baseline'), false);
    assert.equal(Object.hasOwn(legacy, 'task'), false);
    writeBrief(ws);
    const oid = snapshot(ws);
    success(open(ws, 'after-legacy', ['--checkpoint', oid, '--task', BRIEF_A]));
    const ledger = readDelegationStore(ws.store);
    assert.equal(ledger.malformed, 0, ledger.malformedReasons.join('; '));
    const dispatch = ledger.records.find((record) => record.kind === 'dispatch' && record.nonce === 'after-legacy');
    assert.deepEqual(dispatch.task, { brief: BRIEF_A, files: ['src/a.mjs', 'src/b.mjs'] });
  });
});
