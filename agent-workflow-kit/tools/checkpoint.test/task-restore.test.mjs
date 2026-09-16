import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { hermeticGitEnv } from '../git-env.mjs';
import { main as dispatchMain } from '../dispatch.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';

const ABSENT = 'absent ../checkpoint.mjs main';
const RESTORE_ABSENT = 'absent ../checkpoint-restore.mjs restoreTaskThread';
const loaded = await import('../checkpoint.mjs').catch(() => ({}));
const restored = await import('../checkpoint-restore.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error(ABSENT); });
const restoreTaskThread = restored.restoreTaskThread ?? (() => { throw new Error(RESTORE_ABSENT); });
const TMP = mkdtempSync(join(tmpdir(), 'aw-checkpoint-task-restore-'));
const ENV = hermeticGitEnv(process.env, TMP);
const ACCEPT = 0;
const REFUSE = 1;
const HEAD_DATE = '2030-01-01T00:00:00Z';
const SECOND_MS = 1000;
const CAP_S = 600;
const GRACE_S = 15;
const WAVE = 'wave-a';
const PLAN = 'docs/plans/fixture.md';
const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const BRIEF_B = 'docs/plans/TASK-fixture-T2.md';
const FILES_A = ['src/a.mjs', 'src/a-extra.mjs'];
const FILES_B = ['src/b.mjs'];
const BASE = 'base.txt';
const SOURCE_A = FILES_A[0];
const EXTRA_A = FILES_A[1];
const SOURCE_B = FILES_B[0];
const LOOSE = 'loose.txt';
const NOTE = 'docs/plans/note.md';
const INITIAL_BASE = 'base\n';
const INITIAL_SOURCE = 'export {};\n';
const CHANGE_A = 'export const a = 1;\n';
const CHANGE_B = 'export const b = 2;\n';
const EXTRA_BYTES = 'export const extra = true;\n';
const LOOSE_BYTES = 'unrelated work\n';
const NOTE_BYTES = '# Keep this note\n';
const A = 'task-a';
const B = 'task-b';
const A1 = 'task-a1';
const A2 = 'task-a2';
const RETRY_A = 'task-a-r';
const U = 'untasked-u';
const SESSION_A = 'session-a';
const SESSION_U = 'session-u';
const REPORT = Buffer.from('the requested file was written\n');
const REGISTER = ['register', '--wave', WAVE, '--step-classes', 'code', '--pairing-key', 'stepClass',
  '--min-per-class', '1', '--mean-l-threshold', '1', '--first-pass-num', '0', '--first-pass-den', '1'];
after(() => rmSync(TMP, { recursive: true, force: true }));

const accept = (result) => { assert.equal(result.code, ACCEPT, result.stderr); return result; };
const readGit = (ws, args) => {
  const result = spawnSync('git', args, { cwd: ws.cwd, env: ws.env, encoding: 'utf8' });
  assert.equal(result.status, ACCEPT, `git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trimEnd();
};
const put = (ws, path, bytes) => {
  mkdirSync(dirname(join(ws.cwd, path)), { recursive: true });
  writeFileSync(join(ws.cwd, path), bytes);
};
const run = (ws, argv) => main(argv, { cwd: ws.cwd, env: ws.env });
const dispatch = (ws, argv) => dispatchMain(argv, { cwd: ws.cwd, env: ws.env, now: ws.now });
const writeBrief = (ws, brief, files) => put(ws, brief, [
  '# Task: fixture task', 'Story: S1 of FIXTURE-EPIC', '', '## Slice',
  `Plan: ${PLAN}`, 'Row: t1', 'Grouping: test', 'Files:',
  ...files.map((path) => `- ${path} :: test`), '', '## Reads', `- ${BASE}`, '',
  '## Acceptance', '- node --test fixture.test.mjs :: green', '', '## Negative cases', '- none', '',
  '## Budget', ...files.map((path) => `- ${path} :: 100`), '',
].join('\n'));
const makeRepo = () => {
  const cwd = mkdtempSync(join(TMP, 'repo-'));
  const dir = join(cwd, '.git');
  const store = join(dir, DELEGATION_STORE_BASENAME);
  const ws = { cwd, dir, store, clock: Date.UTC(2031, 0, 1),
    env: { ...ENV, AW_DELEGATION_STORE: store, AW_CORE_EVIDENCE: join(dir, 'evidence.jsonl'),
      GIT_AUTHOR_DATE: HEAD_DATE, GIT_COMMITTER_DATE: HEAD_DATE },
    now: () => { ws.clock += SECOND_MS; return new Date(ws.clock).toISOString(); } };
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'coder-tools@proton.me'],
    ['config', 'user.name', 'coder-tool']]) readGit(ws, args);
  put(ws, BASE, INITIAL_BASE);
  for (const path of [SOURCE_A, SOURCE_B]) put(ws, path, INITIAL_SOURCE);
  readGit(ws, ['add', '-A']);
  readGit(ws, ['commit', '-q', '-m', 'initial tree']);
  put(ws, '.git/info/exclude', '/docs/ai/\n/AGENTS.md\n');
  put(ws, PLAN, '# Synthetic plan\n');
  writeBrief(ws, BRIEF_A, FILES_A);
  writeBrief(ws, BRIEF_B, FILES_B);
  return ws;
};
const mint = (ws, sequence = 0) => {
  const result = accept(run(ws, ['mint', '--plan', PLAN]));
  const oid = readGit(ws, ['rev-parse', `refs/agent-workflow/checkpoints/fixture/${sequence}`]);
  assert.equal(result.stdout, `checkpoint fixture/${sequence} ${oid}\n`);
  return oid;
};
const makeScenario = () => {
  const ws = makeRepo();
  ws.oid = mint(ws);
  accept(dispatch(ws, REGISTER));
  return ws;
};
const readRecord = (ws, kind, nonce) => {
  const ledger = readDelegationStore(ws.store);
  assert.equal(ledger.malformed, ACCEPT, ledger.malformedReasons.join('; '));
  const record = ledger.records.find((entry) => entry.kind === kind && entry.nonce === nonce);
  assert.ok(record, `${kind} ${nonce}`);
  return record;
};
const open = (ws, nonce, brief = BRIEF_A, retryOf = null) => {
  const contract = { schema: 1, nonce, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
    returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900,
    retry: { cap: 2, index: retryOf === null ? 0 : 1 } };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  accept(dispatch(ws, ['open', '--contract', path, '--wave', WAVE, '--backend', 'codex',
    '--rationale', 'a bounded change', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S),
    '--checkpoint', ws.oid, ...(brief === null ? [] : ['--task', brief]), ...(retryOf === null ? [] : ['--retry-of', retryOf])]));
};
const returned = (ws, nonce, sessionId, outcome = 'success') => {
  const record = readRecord(ws, 'dispatch', nonce);
  writeFileSync(join(ws.dir, execReportBasename(record.backend, nonce)), REPORT);
  writeFileSync(join(ws.dir, execReceiptBasename(record.backend, nonce)), JSON.stringify({
    schema: EXEC_RECEIPT_SCHEMA_VERSION, kind: EXEC_RECEIPT_KIND, state: 'terminal', backend: record.backend,
    nonce, owner: 'owner-token-1', contractDigest: record.contractDigest, wrapperVersion: '3.4.1',
    posture: { model: 'gpt-5-codex', effort: 'high', tier: 'priority' },
    capS: CAP_S, killGraceS: GRACE_S, sessionId, exitStatus: ACCEPT, outcome: 'success',
    reportDigest: createHash('sha256').update(REPORT).digest('hex'), reportLength: REPORT.length, timestamp: ws.now(),
  }));
  accept(dispatch(ws, ['return', '--nonce', nonce, ...(outcome === 'success' ? [] : ['--outcome', outcome])]));
  assert.equal(readRecord(ws, 'return', nonce).outcome, outcome);
};
const fold = (ws, nonce) => accept(dispatch(ws, ['fold', '--nonce', nonce, '--verdict', 'accepted as returned']));
const degrade = (ws, nonce) => accept(dispatch(ws, ['degrade', '--wave', WAVE, '--nonce', nonce,
  '--step-class', 'code', '--rationale', 'withdraw this thread']));
const readNode = (path) => {
  const stat = (() => {
    try { return lstatSync(path); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  })();
  if (stat === null) return null;
  return { mode: stat.mode, value: stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? readFileSync(path)
    : stat.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map((name) => [name, readNode(join(path, name))])) : null };
};
const readPaths = (ws, paths) => Object.fromEntries(paths.map((path) => [path, readNode(join(ws.cwd, path))]));
const readWorkTree = (ws) => Object.fromEntries(readdirSync(ws.cwd).filter((name) => name !== '.git').sort()
  .map((name) => [name, readNode(join(ws.cwd, name))]));
const prove = (ws, nonce) => {
  const result = run(ws, ['restore', ws.oid, '--nonce', nonce]);
  assert.equal(result.code, ACCEPT, result.stderr);
  assert.equal(result.stdout, `checkpoint restore ${ws.oid} task ${nonce} proof clean\n`);
  assert.equal(result.stderr, '');
};
const refuse = (ws, nonce, reason, namedNonce = null, oid = ws.oid) => {
  const before = readWorkTree(ws);
  const result = run(ws, ['restore', oid, '--nonce', nonce]);
  assert.equal(result.code, REFUSE, result.stderr);
  assert.match(result.stderr, new RegExp(`\\b${reason}\\b`, 'u'));
  if (namedNonce !== null) assert.match(result.stderr, new RegExp(`\\b${namedNonce}\\b`, 'u'));
  assert.equal(result.stdout, '');
  assert.deepEqual(readWorkTree(ws), before);
};

describe('restore --nonce undoes one task — spec:task-thread/S10', () => {
  it('exports restoreTaskThread as a function', () => {
    assert.equal(typeof restored.restoreTaskThread, 'function');
    assert.equal(restoreTaskThread, restored.restoreTaskThread);
  });

  it('restores a degraded task and leaves its sibling', () => {
    const ws = makeScenario();
    const target = readPaths(ws, FILES_A);
    open(ws, A); open(ws, B, BRIEF_B);
    for (const [path, bytes] of [[SOURCE_A, CHANGE_A], [EXTRA_A, EXTRA_BYTES], [SOURCE_B, CHANGE_B],
      [LOOSE, LOOSE_BYTES], [NOTE, NOTE_BYTES]]) put(ws, path, bytes);
    degrade(ws, A);
    const keptPaths = [BASE, SOURCE_B, LOOSE, NOTE, PLAN, BRIEF_A, BRIEF_B];
    const kept = readPaths(ws, keptPaths);
    prove(ws, A);
    assert.deepEqual(readPaths(ws, FILES_A), target);
    assert.deepEqual(readPaths(ws, keptPaths), kept);
  });

  it('restores a terminal partial-edit return without a fold', () => {
    const ws = makeScenario();
    const target = readPaths(ws, FILES_A);
    open(ws, A); put(ws, SOURCE_A, CHANGE_A); put(ws, EXTRA_A, EXTRA_BYTES);
    returned(ws, A, SESSION_A, 'partial-edit');
    prove(ws, A);
    assert.deepEqual(readPaths(ws, FILES_A), target);
  });

  it('refuses open-thread for an open target and preserves every file', () => {
    const ws = makeScenario();
    open(ws, A); put(ws, SOURCE_A, CHANGE_A); put(ws, EXTRA_A, EXTRA_BYTES);
    put(ws, SOURCE_B, CHANGE_B); put(ws, LOOSE, LOOSE_BYTES); put(ws, NOTE, NOTE_BYTES);
    refuse(ws, A, 'open-thread', A);
  });

  it('refuses task-folded for a folded target', () => {
    const ws = makeScenario();
    open(ws, A); put(ws, SOURCE_A, CHANGE_A);
    returned(ws, A, SESSION_A); fold(ws, A);
    refuse(ws, A, 'task-folded', A);
  });

  it('refuses task-target for another checkpoint', () => {
    const ws = makeScenario();
    open(ws, A); put(ws, SOURCE_A, CHANGE_A); degrade(ws, A);
    put(ws, BASE, 'changed base\n');
    const oid2 = mint(ws, 1);
    assert.notEqual(oid2, ws.oid);
    refuse(ws, A, 'task-target', null, oid2);
  });

  it('refuses task-folded naming an earlier same-brief fold', () => {
    const ws = makeScenario();
    open(ws, A1); put(ws, SOURCE_A, CHANGE_A);
    returned(ws, A1, SESSION_A); fold(ws, A1);
    open(ws, A2); put(ws, SOURCE_A, 'export const a = 2;\n'); degrade(ws, A2);
    refuse(ws, A2, 'task-folded', A1);
  });

  it('refuses task-folded naming a folded retry', () => {
    const ws = makeScenario();
    open(ws, A); degrade(ws, A);
    open(ws, RETRY_A, BRIEF_A, A); put(ws, SOURCE_A, CHANGE_A);
    returned(ws, RETRY_A, SESSION_A); fold(ws, RETRY_A);
    refuse(ws, A, 'task-folded', RETRY_A);
  });

  it('refuses open-thread naming an open retry', () => {
    const ws = makeScenario();
    open(ws, A); degrade(ws, A);
    open(ws, RETRY_A, BRIEF_A, A); put(ws, SOURCE_A, CHANGE_A);
    refuse(ws, A, 'open-thread', RETRY_A);
  });

  it('refuses task-folded naming an untasked fold in the epoch', () => {
    const ws = makeScenario();
    open(ws, U, null); put(ws, LOOSE, LOOSE_BYTES);
    returned(ws, U, SESSION_U); fold(ws, U);
    open(ws, A); put(ws, SOURCE_A, CHANGE_A); degrade(ws, A);
    refuse(ws, A, 'task-folded', U);
  });

  it('refuses a proof an external diff would hide', () => {
    const ws = makeScenario();
    put(ws, '.git/info/attributes', 'src/a.mjs filter=skew\n');
    readGit(ws, ['config', 'filter.skew.smudge', 'cat; echo skew']);
    readGit(ws, ['config', 'filter.skew.clean', 'cat']);
    const script = join(mkdtempSync(join(TMP, 'ext-diff-')), 'silent.sh');
    writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    open(ws, A); put(ws, SOURCE_A, CHANGE_A); degrade(ws, A);
    const result = main(['restore', ws.oid, '--nonce', A], {
      cwd: ws.cwd, env: { ...ws.env, GIT_EXTERNAL_DIFF: script },
    });
    assert.equal(result.code, REFUSE);
    assert.match(result.stderr, /\bmismatch\b/u);
    assert.equal(result.stdout, '');
  });

  it('keeps the whole-tree restore unchanged', () => {
    const ws = makeRepo();
    const oid = mint(ws);
    const target = readPaths(ws, [BASE, SOURCE_A, SOURCE_B]);
    put(ws, SOURCE_A, CHANGE_A); put(ws, LOOSE, LOOSE_BYTES); put(ws, NOTE, NOTE_BYTES);
    const note = readNode(join(ws.cwd, NOTE));
    const result = run(ws, ['restore', oid]);
    assert.equal(result.code, ACCEPT, result.stderr);
    assert.equal(result.stdout, `checkpoint restore ${oid} proof ${oid}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(readPaths(ws, [BASE, SOURCE_A, SOURCE_B]), target);
    assert.equal(readNode(join(ws.cwd, LOOSE)), null);
    assert.deepEqual(readNode(join(ws.cwd, NOTE)), note);
  });
});
