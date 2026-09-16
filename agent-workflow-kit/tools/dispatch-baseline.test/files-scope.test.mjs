import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  runBaseDiff, computeBasePayload, computeBaseFingerprint, isCleanAgainstBase,
} from '../dispatch-baseline.mjs';
import {
  uncommittedStateFingerprint, DELEGATION_STORE_BASENAME, readDelegationStore,
} from '../dispatch-store.mjs';
import { enumerateReturnedObjects, computeReturnedDiff } from '../exec-producer.mjs';
import { main } from '../dispatch.mjs';
import { hermeticGitEnv } from '../git-env.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-files-scope-'));
const ENV = hermeticGitEnv(process.env, TMP);
const IO = { env: ENV };
const FILES = ['src/a.mjs', 'src/new.mjs'];
const BRIEF = 'docs/plans/TASK-files-scope-T1.md';
const ORIGINAL_A = 'export const a = 1;\n';
const CHANGED_A = 'export const a = 2;\n';
const CHANGED_B = 'export const b = 2;\n';
const NEW_BYTES = 'export const fresh = true;\n';
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=none'];
const HEAD_DATE = '2030-01-01T00:00:00Z';
after(() => rmSync(TMP, { recursive: true, force: true }));

const runGit = (root, args, env = ENV) => {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trimEnd();
};
const put = (root, path, bytes) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
const makeRepo = ({ ignore = false } = {}) => {
  const root = mkdtempSync(join(TMP, 'repo-'));
  runGit(root, ['init', '-q', '-b', 'main']);
  runGit(root, ['config', 'user.name', 'coder-tool']);
  runGit(root, ['config', 'user.email', 'coder-tools@proton.me']);
  put(root, 'base.txt', 'base\n');
  put(root, 'src/a.mjs', ORIGINAL_A);
  put(root, 'src/b.mjs', 'export const b = 1;\n');
  if (ignore) put(root, '.gitignore', 'ignored.txt\n');
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-q', '-m', 'initial tree'], {
    ...ENV, GIT_AUTHOR_DATE: HEAD_DATE, GIT_COMMITTER_DATE: HEAD_DATE,
  });
  return root;
};
const snapshot = (root) => {
  const directory = mkdtempSync(join(TMP, 'index-'));
  const env = { ...ENV, GIT_INDEX_FILE: join(directory, 'index') };
  try {
    runGit(root, ['add', '-A'], env);
    return { kind: 'checkpoint', treeOid: runGit(root, ['write-tree'], env) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const writeTaskChanges = (root) => {
  put(root, 'src/a.mjs', CHANGED_A);
  put(root, 'src/new.mjs', NEW_BYTES);
};
const run = (ws, argv) => main(argv, { cwd: ws.cwd, env: ws.env, now: ws.now });
const makeWorkspace = () => {
  const cwd = makeRepo({ ignore: true });
  const directory = join(cwd, '.git');
  const store = join(directory, DELEGATION_STORE_BASENAME);
  const ticks = [];
  const ws = {
    cwd, store,
    env: { ...ENV, AW_DELEGATION_STORE: store, AW_CORE_EVIDENCE: join(directory, 'evidence.jsonl') },
    now: () => new Date(Date.UTC(2031, 0, 1, 0, 0, ticks.push(null))).toISOString(),
  };
  const result = run(ws, ['register', '--wave', 'wave-a', '--step-classes', 'code', '--pairing-key', 'stepClass',
    '--min-per-class', '1', '--mean-l-threshold', '1', '--first-pass-num', '0', '--first-pass-den', '1']);
  assert.equal(result.code, 0, result.stderr);
  return ws;
};
const writeBrief = (ws, brief, files) => put(ws.cwd, brief, [
  '# Task: files scope fixture', 'Story: S1 of FIXTURE-EPIC', '', '## Slice',
  'Plan: docs/plans/fixture.md', 'Row: t1', 'Grouping: test', 'Files:',
  ...files.map((path) => `- ${path} :: test`), '',
  '## Reads', '- base.txt', '', '## Acceptance', '- node --test fixture.test.mjs :: green', '',
  '## Negative cases', '- none', '', '## Budget', ...files.map((path) => `- ${path} :: 100`), '',
].join('\n'));
const open = (ws, nonce, flags) => {
  const contract = {
    schema: 1, nonce, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
    scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
    returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900,
    retry: { cap: 2, index: 0 },
  };
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(contract)}\n\`\`\`\n`);
  return run(ws, ['open', '--contract', path, '--wave', 'wave-a', '--backend', 'codex',
    '--rationale', 'a bounded change', '--wrapper-cap-s', '600', '--kill-grace-s', '15', ...flags]);
};
const refusesWithoutWrite = (ws, action, reason, path) => {
  const before = readFileSync(ws.store);
  const result = action();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, reason);
  assert.ok(result.stderr.includes(path), result.stderr);
  assert.deepEqual(readFileSync(ws.store), before);
};

describe('files scope — spec:task-thread/S5', () => {
  it('keeps payload and base diff inside Files after a sibling write', () => {
    const root = makeRepo();
    const base = snapshot(root);
    writeTaskChanges(root);
    const whole = computeBasePayload(root, base, IO);
    const wholeDiff = runBaseDiff(root, base, DIFF_ARGS, IO);
    put(root, 'src/b.mjs', CHANGED_B);
    const scoped = computeBasePayload(root, base, IO, FILES);
    const scopedDiff = runBaseDiff(root, base, DIFF_ARGS, IO, FILES);
    const untasked = computeBasePayload(root, base, IO);
    assert.ok(Buffer.isBuffer(whole));
    assert.deepEqual(scoped, whole);
    assert.deepEqual(scopedDiff, wholeDiff);
    assert.notDeepEqual(untasked, whole);
  });

  it('keeps leaf and store fingerprints inside Files after a sibling write', () => {
    const root = makeRepo();
    const base = snapshot(root);
    writeTaskChanges(root);
    const whole = computeBaseFingerprint(root, base, IO);
    put(root, 'src/b.mjs', CHANGED_B);
    const scoped = computeBaseFingerprint(root, base, IO, FILES);
    const stored = uncommittedStateFingerprint(root, IO, base, FILES);
    const untasked = computeBaseFingerprint(root, base, IO);
    assert.match(whole, /^[a-f0-9]{64}$/u);
    assert.deepEqual({ leaf: scoped, store: stored }, { leaf: whole, store: whole });
    assert.equal(stored, scoped);
    assert.notEqual(untasked, whole);
  });

  it('reads a clean Files scope when only a sibling changed', () => {
    const root = makeRepo();
    const base = snapshot(root);
    put(root, 'src/b.mjs', CHANGED_B);
    const scoped = isCleanAgainstBase(root, base, IO, ['src/a.mjs']);
    const untasked = isCleanAgainstBase(root, base, IO);
    assert.equal(scoped, true);
    assert.equal(untasked, false);
  });

  it('limits returned objects and returned diff to Files', () => {
    const root = makeRepo();
    const base = snapshot(root);
    writeTaskChanges(root);
    const whole = computeBasePayload(root, base, IO);
    put(root, 'src/b.mjs', CHANGED_B);
    const enumerated = enumerateReturnedObjects(root, { ...IO, base, paths: FILES });
    const returned = computeReturnedDiff(root, { ...IO, base, paths: FILES });
    assert.equal(enumerated.ok, true, enumerated.reason);
    assert.equal(returned.ok, true, returned.reason);
    assert.deepEqual(enumerated.entries, [
      { kind: 'modified', path: 'src/a.mjs', objectId: 'pre:src/a.mjs', preImageBytes: Buffer.byteLength(ORIGINAL_A) },
      { kind: 'new', path: 'src/new.mjs', objectId: 'new:src/new.mjs', postImageBytes: Buffer.byteLength(NEW_BYTES) },
    ]);
    assert.deepEqual(returned.diff, whole);
  });

  it('includes a deletion inside Files and excludes a sibling deletion', () => {
    const root = makeRepo();
    const base = snapshot(root);
    rmSync(join(root, 'src/a.mjs'));
    const whole = computeBasePayload(root, base, IO);
    rmSync(join(root, 'src/b.mjs'));
    const scoped = computeBasePayload(root, base, IO, ['src/a.mjs']);
    assert.ok(Buffer.isBuffer(whole));
    assert.match(whole.toString(), /deleted file mode/u);
    assert.deepEqual(scoped, whole);
    assert.ok(scoped.toString().includes('src/a.mjs'));
    assert.equal(scoped.toString().includes('src/b.mjs'), false);
  });

  it('keeps omitted paths and explicit null byte-identical for untasked calls', () => {
    const root = makeRepo();
    const base = snapshot(root);
    writeTaskChanges(root);
    put(root, 'src/b.mjs', CHANGED_B);
    const pairs = [
      ['runBaseDiff', runBaseDiff(root, base, DIFF_ARGS, IO), runBaseDiff(root, base, DIFF_ARGS, IO, null)],
      ['computeBasePayload', computeBasePayload(root, base, IO), computeBasePayload(root, base, IO, null)],
      ['computeBaseFingerprint', computeBaseFingerprint(root, base, IO), computeBaseFingerprint(root, base, IO, null)],
      ['isCleanAgainstBase', isCleanAgainstBase(root, base, IO), isCleanAgainstBase(root, base, IO, null)],
      ['uncommittedStateFingerprint', uncommittedStateFingerprint(root, IO, base),
        uncommittedStateFingerprint(root, IO, base, null)],
      ['enumerateReturnedObjects', enumerateReturnedObjects(root, { ...IO, base }),
        enumerateReturnedObjects(root, { ...IO, base, paths: null })],
      ['computeReturnedDiff', computeReturnedDiff(root, { ...IO, base }),
        computeReturnedDiff(root, { ...IO, base, paths: null })],
    ];
    assert.ok(Buffer.isBuffer(pairs[1][1]));
    assert.equal(pairs[3][1], false);
    assert.equal(pairs[5][1].ok, true, pairs[5][1].reason);
    assert.equal(pairs[6][1].ok, true, pairs[6][1].reason);
    for (const [name, omitted, explicitNull] of pairs) assert.deepEqual(explicitNull, omitted, name);
  });

  for (const { title, path, files = [path] } of [
    { title: 'refuses tracked .gitignore', path: '.gitignore' },
    { title: 'refuses absent sub/.gitattributes', path: 'sub/.gitattributes' },
    { title: 'refuses docs/plans/x.md', path: 'docs/plans/x.md' },
    { title: 'refuses node_modules/x.js', path: 'node_modules/x.js' },
    { title: 'refuses .claude/settings.json', path: '.claude/settings.json' },
    { title: 'refuses ignored ignored.txt', path: 'ignored.txt' },
    { title: 'refuses directory src', path: 'src' },
    { title: 'refuses base.txt/x beneath a file', path: 'base.txt/x' },
    { title: 'refuses .gitignore beside valid src/a.mjs', path: '.gitignore', files: ['.gitignore', 'src/a.mjs'] },
  ]) it(title, () => {
    const ws = makeWorkspace();
    if (path === 'ignored.txt') put(ws.cwd, path, 'ignored content\n');
    writeBrief(ws, BRIEF, files);
    const base = snapshot(ws.cwd);
    refusesWithoutWrite(ws, () => open(ws, 'scope-refusal', ['--checkpoint', base.treeOid, '--task', BRIEF]),
      /\btask-files-scope\b/u, path);
  });

  it('opens an absent src/new.test.mjs and records its Files', () => {
    const ws = makeWorkspace();
    const files = ['src/new.test.mjs'];
    writeBrief(ws, BRIEF, files);
    const base = snapshot(ws.cwd);
    const result = open(ws, 'scope-new-file', ['--checkpoint', base.treeOid, '--task', BRIEF]);
    assert.equal(result.code, 0, result.stderr);
    const ledger = readDelegationStore(ws.store);
    assert.equal(ledger.malformed, 0, ledger.malformedReasons.join('; '));
    const record = ledger.records.find((entry) => entry.kind === 'dispatch' && entry.nonce === 'scope-new-file');
    assert.deepEqual(record.task.files, files);
  });
});
