import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, lstatSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeFingerprintPayload, computeTreeFingerprint, isTreeClean } from './core-evidence.mjs';
import { HEAD_BASELINE } from './dispatch-record.mjs';
import { hermeticGitEnv } from './git-env.mjs';

const leaf = await import('./dispatch-baseline.mjs').catch(() => ({}));
const snapshotScope = leaf.snapshotScope ?? (() => ({ ok: false, reason: 'absent' }));
const computeBasePayload = leaf.computeBasePayload ?? (() => null);
const computeBaseFingerprint = leaf.computeBaseFingerprint ?? (() => null);
const isCleanAgainstBase = leaf.isCleanAgainstBase ?? (() => null);
const runBaseDiff = leaf.runBaseDiff ?? (() => null);
const resolveTreeObject = leaf.resolveTreeObject ?? (() => ({ ok: false, reason: 'absent' }));

const TMP = mkdtempSync(join(tmpdir(), 'aw-baseline-test-'));
const ENV = hermeticGitEnv(process.env, TMP);
const IO = { env: ENV };
const UNKNOWN_OID = 'f'.repeat(40);
const INDEX_PREFIX = 'aw-dispatch-baseline-';
after(() => rmSync(TMP, { recursive: true, force: true }));
const runGit = (args, cwd, input, env = ENV) => spawnSync('git', args, { cwd, input, env });
const sh = (args, cwd, env = ENV) => {
  const result = runGit(args, cwd, undefined, env);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString('utf8').trimEnd();
};
const put = (root, path, bytes) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
const makeRepo = (seed = {}, { unborn = false } = {}) => {
  const root = mkdtempSync(join(TMP, 'repo-'));
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  for (const [path, bytes] of Object.entries({ 'base.txt': 'base\n', ...seed })) put(root, path, bytes);
  if (!unborn) {
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'init'], root);
  }
  return root;
};
const baseOf = (root) => ({ kind: 'checkpoint', treeOid: sh(['rev-parse', 'HEAD^{tree}'], root) });
const scopeOf = (root, options = {}) => {
  const result = snapshotScope(root, options, IO);
  assert.equal(result.ok, true, result.reason);
  return result.paths;
};
const spyIO = (refuse = () => false) => {
  const calls = [];
  return {
    calls, env: ENV,
    runGit: (args, cwd, input, env) => {
      calls.push({ args, cwd, index: env?.GIT_INDEX_FILE });
      if (refuse(args)) throw new Error('injected git failure');
      return runGit(args, cwd, input, env);
    },
  };
};
const assertRemoved = (calls) => {
  const indexes = [...new Set(calls.map(({ index }) => index).filter(Boolean))];
  assert.ok(indexes.length > 0);
  for (const index of indexes) {
    assert.equal(existsSync(dirname(index)), false, index);
    assert.equal(dirname(dirname(index)), tmpdir());
  }
};
const fakeIO = ({ live = [], tree = [], fail = () => false } = {}) => {
  const root = mkdtempSync(join(TMP, 'injected-'));
  mkdirSync(join(root, '.git'));
  for (const path of live) put(root, path, 'live\n');
  const calls = [];
  const io = { env: ENV, runGit: (args, cwd, input, env) => {
    calls.push({ args, cwd, index: env?.GIT_INDEX_FILE });
    if (fail(args)) throw new Error('injected failure');
    const stdout = args[0] === 'rev-parse'
      ? (args[1] === '--show-toplevel' ? root : args.includes('HEAD') ? UNKNOWN_OID : join(root, '.git')) + '\n'
      : args[0] === 'cat-file' ? 'tree\n'
        : args[0] === 'ls-tree' ? tree.join('\0') + '\0'
          : args[0] === 'ls-files' ? live.filter((path) => !args.includes('--') || path.startsWith(args.at(-1))).join('\0') + '\0'
            : args[0] === 'diff' ? 'base-to-live bytes' : '';
    return { status: 0, stdout: Buffer.from(stdout) };
  } };
  return { root, io, calls, base: { kind: 'checkpoint', treeOid: UNKNOWN_OID } };
};

describe('dispatch-baseline scope — spec:dispatch-baseline/S2', () => {
  it('injected scope excludes glob matches from disk and trees under an empty private index', () => {
    const { root, io, calls } = fakeIO({ live: ['base.txt', '.github/copilot-live.md'], tree: ['gone.txt', '.github/copilot-gone.md'] });
    assert.deepEqual(snapshotScope(root, {}, io), { ok: true, paths: ['base.txt', 'gone.txt'] });
    assert.ok(calls.filter(({ args }) => args[0] === 'ls-files').every(({ index }) => index));
    assertRemoved(calls);
  });
  it('includes live and hidden kit files and excludes every footprint category', () => {
    const root = makeRepo();
    put(root, '.git/info/exclude', '/docs/ai/\n/AGENTS.md\n');
    const included = ['untracked.txt', 'docs/ai/x.md', 'AGENTS.md'];
    const excluded = ['docs/plans/x.md', 'docs/plans/nested/x.md', '.mcp.json', '.claude/settings.json',
      '.claude/settings.local.json', '.claude/skills/x.md', '.github/copilot-instructions.md',
      '.cursorrules', 'node_modules/x.js', 'src/node_modules/x.js'];
    for (const path of [...included, ...excluded]) put(root, path, 'content\n');
    assert.deepEqual(scopeOf(root), ['base.txt', ...included].sort());
  });
  it('derives the ignored tracked half from a tree, never a forced real-index add', () => {
    const root = makeRepo({ '.gitignore': 'ignored.txt\n' });
    put(root, 'ignored.txt', 'ignored\n');
    sh(['add', '-f', '--', 'ignored.txt'], root);
    assert.equal(scopeOf(root).includes('ignored.txt'), false);
    const treeOid = sh(['write-tree'], root);
    assert.equal(scopeOf(root, { baseTreeOid: treeOid }).includes('ignored.txt'), true);
    sh(['commit', '-q', '-m', 'tree membership'], root);
    assert.equal(scopeOf(root).includes('ignored.txt'), true);
  });
  it('staging and unstaging leave membership unchanged and scope never rewrites the real index', () => {
    const root = makeRepo();
    put(root, 'fresh.txt', 'fresh\n');
    const expected = scopeOf(root);
    for (const args of [['add', '--', 'fresh.txt'], ['rm', '--cached', '--', 'fresh.txt']]) {
      sh(args, root);
      const staged = sh(['ls-files', '--stage'], root);
      const index = readFileSync(join(root, '.git/index'));
      assert.deepEqual(scopeOf(root), expected);
      assert.equal(sh(['ls-files', '--stage'], root), staged);
      assert.deepEqual(readFileSync(join(root, '.git/index')), index);
    }
  });
  it('keeps a deleted base-tree path in the domain and measures its deletion', () => {
    const root = makeRepo({ 'gone.txt': 'gone\n' });
    const base = baseOf(root);
    rmSync(join(root, 'gone.txt'));
    assert.ok(scopeOf(root, { baseTreeOid: base.treeOid }).includes('gone.txt'));
    assert.match(computeBasePayload(root, base, IO).toString(), /deleted file mode/);
  });
  it('keeps excluded base-tree paths at their base bytes after live edits and deletions', () => {
    const root = makeRepo({ 'docs/plans/x.md': 'plan\n', '.mcp.json': '{}\n' });
    const base = baseOf(root);
    assert.deepEqual(scopeOf(root, { baseTreeOid: base.treeOid }), ['base.txt']);
    const payload = computeBasePayload(root, base, IO);
    const fingerprint = computeBaseFingerprint(root, base, IO);
    assert.deepEqual(payload, Buffer.alloc(0));
    assert.equal(typeof fingerprint, 'string');
    for (const change of [(path) => put(root, path, 'excluded edit\n'), (path) => rmSync(join(root, path))]) {
      for (const path of ['docs/plans/x.md', '.mcp.json']) change(path);
      assert.deepEqual(computeBasePayload(root, base, IO), payload);
      assert.equal(computeBaseFingerprint(root, base, IO), fingerprint);
    }
  });
  it('accepts an unborn HEAD but refuses an invalid base or a failed scope read', () => {
    const root = makeRepo({}, { unborn: true });
    assert.deepEqual(scopeOf(root), ['base.txt']);
    assert.equal(snapshotScope(root, { baseTreeOid: UNKNOWN_OID }, IO).ok, false);
    const io = spyIO((args) => args[0] === 'ls-files');
    assert.equal(snapshotScope(root, {}, io).ok, false);
    assertRemoved(io.calls);
  });
});

describe('dispatch-baseline measurement — spec:dispatch-baseline/S3', () => {
  for (const [basePath, livePath] of [['x/node_modules/a.js', 'x'], ['.mcp.json', '.mcp.json/k']]) {
    it(`refuses a live ${livePath} conflicting with excluded base path ${basePath} before forced add`, () => {
      const root = makeRepo();
      put(root, basePath, 'excluded base bytes\n');
      sh(['add', '-f', '--', basePath], root);
      sh(['commit', '-q', '-m', 'excluded base entry'], root);
      const base = baseOf(root);
      rmSync(join(root, basePath.split('/')[0]), { recursive: true });
      put(root, livePath, 'replacement bytes\n');
      const io = spyIO();
      assert.equal(computeBasePayload(root, base, io), null);
      assert.equal(computeBaseFingerprint(root, base, io), null);
      assert.equal(isCleanAgainstBase(root, base, io), null);
      assert.equal(io.calls.some(({ args }) => args[0] === 'add'), false);
    });
  }
  it('injected file-to-directory replacement removes the file and adds only scoped children', () => {
    const { root, io, calls, base } = fakeIO({ live: ['x/keep.txt', 'x/node_modules/a.js'], tree: ['x'] });
    assert.equal(computeBasePayload(root, base, io)?.toString(), 'base-to-live bytes');
    assert.deepEqual(calls.filter(({ args }) => args[0] === 'add').map(({ args }) => args), [
      ['add', '-f', '--', 'x/keep.txt'],
    ]);
    assert.deepEqual(calls.find(({ args }) => args[0] === 'update-index')?.args, ['update-index', '--remove', '--', 'x']);
    assertRemoved(calls);
  });
  it('injected directory named only by HEAD is neither added nor removed from the base index', () => {
    const { root, io, calls, base } = fakeIO({ live: ['x/keep.txt'] });
    const headOnly = { ...io, runGit: (args, cwd, input, env) => {
      const result = io.runGit(args, cwd, input, env);
      return args[0] === 'ls-tree' && args.at(-1) === 'HEAD' ? { ...result, stdout: Buffer.from('x\0') } : result;
    } };
    assert.equal(computeBasePayload(root, base, headOnly)?.toString(), 'base-to-live bytes');
    assert.deepEqual(calls.filter(({ args }) => args[0] === 'add').map(({ args }) => args), [
      ['add', '-f', '--', 'x/keep.txt'],
    ]);
    assert.equal(calls.some(({ args }) => args[0] === 'update-index'), false);
    assertRemoved(calls);
  });
  it('measures a file replaced by a directory without recursively adding excluded children', () => {
    const root = makeRepo({ x: 'original file\n' });
    const base = baseOf(root);
    rmSync(join(root, 'x'));
    put(root, 'x/keep.txt', 'kept child\n');
    put(root, 'x/node_modules/a.js', 'excluded child\n');
    const io = spyIO();
    const payload = computeBasePayload(root, base, io);
    assert.match(payload.toString(), /diff --git a\/x b\/x\ndeleted file mode/u);
    assert.match(payload.toString(), /diff --git a\/x\/keep\.txt b\/x\/keep\.txt\nnew file mode/u);
    assert.doesNotMatch(payload.toString(), /node_modules|excluded child/u);
    const adds = io.calls.filter(({ args }) => args[0] === 'add');
    assert.ok(adds.length > 0);
    assert.ok(adds.every(({ args }) => !args.includes('x')));
    const fingerprint = computeBaseFingerprint(root, base, IO);
    assert.equal(typeof fingerprint, 'string');
    put(root, 'x/node_modules/a.js', 'changed excluded child\n');
    assert.deepEqual(computeBasePayload(root, base, IO), payload);
    assert.equal(computeBaseFingerprint(root, base, IO), fingerprint);
  });
  it('injected measurement stages and removes scope paths only, leaving excluded base entries untouched', () => {
    const { root, io, calls, base } = fakeIO({
      live: ['live.txt', '.mcp.json'], tree: ['gone.txt', '.mcp.json', 'docs/plans/x.md'],
    });
    assert.equal(computeBasePayload(root, base, io)?.toString(), 'base-to-live bytes');
    assert.deepEqual(calls.find(({ args }) => args[0] === 'add').args, ['add', '-f', '--', 'live.txt']);
    assert.deepEqual(calls.find(({ args }) => args[0] === 'update-index').args, ['update-index', '--remove', '--', 'gone.txt']);
    assert.deepEqual(calls.filter(({ args }) => args[0] === 'diff').map(({ args }) => args), [
      ['diff', '--cached', base.treeOid, '--no-ext-diff', '--no-textconv', '--ignore-submodules=none'],
    ]);
    assertRemoved(calls);
  });
  it('injected failures return null and remove every temporary index directory', () => {
    for (const command of ['ls-files', 'ls-tree', 'add', 'update-index', 'diff']) {
      const { root, io, calls, base } = fakeIO({ live: ['live.txt'], tree: ['gone.txt'], fail: (args) => args[0] === command });
      assert.equal(computeBasePayload(root, base, io), null);
      assertRemoved(calls);
      assert.equal(isCleanAgainstBase(root, base, io), null);
    }
  });
  it('delegates head byte for byte without a temporary index', () => {
    const root = makeRepo();
    put(root, 'base.txt', 'changed\n');
    put(root, 'new.txt', 'new\n');
    const io = spyIO();
    assert.deepEqual(computeBasePayload(root, HEAD_BASELINE, io), computeFingerprintPayload(root, IO));
    assert.equal(computeBaseFingerprint(root, HEAD_BASELINE, io), computeTreeFingerprint(root, IO));
    assert.equal(isCleanAgainstBase(root, HEAD_BASELINE, io), isTreeClean(root, IO));
    assert.equal(runBaseDiff(root, HEAD_BASELINE, [], io), null);
    assert.ok(io.calls.every(({ index }) => index === undefined));
  });
  it('measures clean and dirty checkpoint states with one sha256 payload computation', () => {
    const root = makeRepo();
    const base = baseOf(root);
    assert.deepEqual(computeBasePayload(root, base, IO), Buffer.alloc(0));
    assert.equal(isCleanAgainstBase(root, base, IO), true);
    put(root, 'base.txt', 'edited bytes\n');
    const payload = computeBasePayload(root, base, IO);
    assert.match(payload.toString(), /base\.txt/);
    assert.match(payload.toString(), /\+edited bytes/);
    assert.equal(isCleanAgainstBase(root, base, IO), false);
    const io = spyIO();
    assert.equal(computeBaseFingerprint(root, base, io), createHash('sha256').update(payload).digest('hex'));
    assert.equal(io.calls.filter(({ args }) => args[0] === 'diff').length, 1);
  });
  it('measures a file untracked at snapshot from its snapshot bytes', () => {
    const root = makeRepo();
    put(root, 'new.txt', 'snapshot bytes\n');
    const env = { ...ENV, GIT_INDEX_FILE: join(TMP, 'snapshot-index') };
    sh(['read-tree', 'HEAD'], root, env);
    sh(['add', '-f', '--', 'new.txt'], root, env);
    const base = { kind: 'checkpoint', treeOid: sh(['write-tree'], root, env) };
    assert.equal(sh(['ls-files', '--', 'new.txt'], root), '');
    assert.equal(isCleanAgainstBase(root, base, IO), true);
    put(root, 'new.txt', 'after snapshot\n');
    assert.match(computeBasePayload(root, base, IO).toString(), /-snapshot bytes\n\+after snapshot/);
  });
  it('ignores index-only changes and preserves the real index byte for byte', () => {
    const root = makeRepo();
    const base = baseOf(root);
    const payload = computeBasePayload(root, base, IO);
    const fingerprint = computeBaseFingerprint(root, base, IO);
    put(root, 'base.txt', 'staged only\n');
    sh(['add', '--', 'base.txt'], root);
    put(root, 'base.txt', 'base\n');
    const index = readFileSync(join(root, '.git/index'));
    assert.deepEqual(computeBasePayload(root, base, IO), payload);
    assert.equal(computeBaseFingerprint(root, base, IO), fingerprint);
    assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  });
  it('pins forced add and explicit removal under private indexes and cleans up on success or refusal', () => {
    const root = makeRepo({ 'gone.txt': 'gone\n' });
    const base = baseOf(root);
    rmSync(join(root, 'gone.txt'));
    put(root, 'new.txt', 'new\n');
    for (const refuse of [() => false, (args) => args[0] === 'diff', (args) => args[0] === 'add', (args) => args[0] === 'read-tree']) {
      const io = spyIO(refuse);
      const payload = computeBasePayload(root, base, io);
      assert.equal(payload === null, refuse(['diff']) || refuse(['add']) || refuse(['read-tree']));
      assertRemoved(io.calls);
      assert.ok(io.calls.every(({ args, index }) => !['add', 'update-index', 'read-tree'].includes(args[0]) || index));
      assert.ok(io.calls.every(({ args }) => !['status', 'write-tree', 'commit', 'update-ref'].includes(args[0])));
      if (payload !== null) {
        assert.ok(io.calls.some(({ args }) => args[0] === 'add' && args[1] === '-f' && args[2] === '--'));
        assert.ok(io.calls.some(({ args }) => args[0] === 'update-index' && args[1] === '--remove' && args[2] === '--'));
      }
    }
  });
  it('returns raw and numstat diffs from the same base-to-live index', () => {
    const root = makeRepo();
    const base = baseOf(root);
    put(root, 'base.txt', 'new content\n');
    const raw = runBaseDiff(root, base, ['--raw', '-z', '-M', '--no-abbrev', '--no-ext-diff'], IO);
    assert.match(raw.toString(), / M\0base\.txt\0/);
    assert.equal(runBaseDiff(root, base, ['--numstat', '-z', '-M', '--no-ext-diff'], IO).toString(), '1\t1\tbase.txt\0');
  });
  it('refuses a thrown runner, failed tree read, unreadable path, or non-repository', () => {
    const root = makeRepo();
    const base = baseOf(root);
    for (const io of [
      { ...IO, runGit: () => { throw new Error('spawn failed'); } },
      spyIO((args) => args[0] === 'ls-tree'),
      { ...IO, lstat: () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); } },
    ]) {
      assert.equal(computeBasePayload(root, base, io), null);
      assert.equal(isCleanAgainstBase(root, base, io), null);
    }
    assert.equal(computeBasePayload(TMP, base, IO), null);
    assert.equal(isCleanAgainstBase(TMP, base, IO), null);
  });
  it('refuses when a temporary index directory cannot be created', () => {
    const root = makeRepo();
    const base = baseOf(root);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(TMP, 'absent', 'tmp');
    try {
      assert.equal(computeBasePayload(root, base, IO), null);
      assert.equal(isCleanAgainstBase(root, base, IO), null);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
  it('names each non-tree type and an unresolvable id, never deciding them clean', () => {
    const root = makeRepo();
    sh(['tag', '-a', 'v1', '-m', 'tag'], root);
    assert.deepEqual(resolveTreeObject(root, baseOf(root).treeOid, IO), { ok: true });
    for (const [oid, name] of [
      [sh(['rev-parse', 'HEAD'], root), 'commit'], [sh(['rev-parse', 'HEAD:base.txt'], root), 'blob'],
      [sh(['rev-parse', 'v1'], root), 'tag'], [UNKNOWN_OID, 'unresolvable'],
    ]) {
      const proof = resolveTreeObject(root, oid, IO);
      assert.equal(proof.ok, false);
      assert.match(proof.reason, new RegExp(name));
      const base = { kind: 'checkpoint', treeOid: oid };
      assert.equal(computeBasePayload(root, base, IO), null);
      assert.equal(isCleanAgainstBase(root, base, IO), null);
    }
  });
  it('injected FIFO replacing a base file is undecidable, never clean', () => {
    const { root, io, base } = fakeIO({ live: ['pipe'], tree: ['pipe'] });
    const fifo = { ...io, lstat: (path) => path.endsWith('/pipe')
      ? { isCharacterDevice: () => false, isBlockDevice: () => false, isFIFO: () => true, isSocket: () => false }
      : lstatSync(path) };
    assert.equal(computeBasePayload(root, base, fifo), null);
    assert.equal(isCleanAgainstBase(root, base, fifo), null);
  });
  it('skips never-committable untracked stat classes and preserves literal paths and symlinks', () => {
    const root = makeRepo();
    const base = baseOf(root);
    put(root, 'pipe', 'placeholder\n');
    const io = { ...IO, lstat: (path) => path.endsWith('/pipe')
      ? { isCharacterDevice: () => false, isBlockDevice: () => false, isFIFO: () => true, isSocket: () => false }
      : lstatSync(path) };
    assert.equal(isCleanAgainstBase(root, base, io), true);
    rmSync(join(root, 'pipe'));
    put(root, ':(glob)*', 'literal bytes\n');
    symlinkSync('missing-target', join(root, 'link'));
    const payload = computeBasePayload(root, base, IO).toString();
    assert.match(payload, /literal bytes/);
    assert.match(payload, /missing-target/);
  });
});
