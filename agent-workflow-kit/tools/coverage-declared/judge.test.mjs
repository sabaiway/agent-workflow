import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { hermeticGitEnv, resolveGitLocation, stripGitLocationEnv } from '../git-env.mjs';
import { main } from '../coverage-check.mjs';
import { isLineUnsafe } from '../source-size-refusal.mjs';

const declared = await import('./index.mjs').catch(() => ({}));
const census = await import('../tracked-tree-census.mjs').catch(() => ({}));
const LIST = 'docs/ai/coverage-declared.json';
const PREFIX = 'coverage-check: declared list — ';
const CONFIG_FAILURE = `coverage-check: FAIL — ${LIST}: `;
const SHAPE = '{ "schema": 1, "_README"?: string, "entries": [{ "path": string, "reason": string }, ...] }';
const REASON = 'Copied to a temporary directory and tested there.';
const SOURCE = 'export const first = 1;\nexport const second = 2;\nexport const third = 3;\n';
const REPO_TEMPLATE = { root: null };
after(() => { if (REPO_TEMPLATE.root) rmSync(REPO_TEMPLATE.root, { recursive: true, force: true }); });

const fixtureEnv = (home) => hermeticGitEnv(Object.fromEntries(Object.entries(stripGitLocationEnv(process.env))
  .filter(([name]) => !name.startsWith('AW_') && name !== 'NODE_TEST_CONTEXT')), home);
const runGit = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, env: fixtureEnv(root), encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trimEnd();
};
const buildTemplate = () => {
  if (REPO_TEMPLATE.root) return REPO_TEMPLATE.root;
  const root = mkdtempSync(join(tmpdir(), 'declared-judge-template-'));
  try {
    makeFixtureRepo((args) => runGit(root, args), root, ['-q']);
    runGit(root, ['config', 'user.name', 'coder-tool']);
    runGit(root, ['config', 'user.email', 'coder-tools@proton.me']);
    writeFileSync(join(root, '.gitignore'), `${LIST}\nignored.mjs\n`);
    for (const path of ['lib.mjs', 'other.mjs', 'stable.mjs']) writeFileSync(join(root, path), SOURCE);
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real/leaf.mjs'), SOURCE);
    symlinkSync('real', join(root, 'linked'));
    symlinkSync('lib.mjs', join(root, 'link.mjs'));
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'base']);
    REPO_TEMPLATE.root = root;
    return root;
  } finally {
    if (!REPO_TEMPLATE.root) rmSync(root, { recursive: true, force: true });
  }
};
const withRepo = (run) => {
  const template = buildTemplate();
  const root = mkdtempSync(join(tmpdir(), 'declared-judge-'));
  const ambient = process.env;
  try {
    cpSync(template, root, { recursive: true, verbatimSymlinks: true });
    process.env = fixtureEnv(root);
    const location = resolveGitLocation(root);
    assert.equal(location.state, 'work-tree', location.cause);
    assert.deepEqual([location.top, location.gitDir, location.commonDir], [root, join(root, '.git'), join(root, '.git')]);
    return run(root);
  } finally {
    process.env = ambient;
    rmSync(root, { recursive: true, force: true });
  }
};
const encodeList = (paths) => Buffer.from(JSON.stringify({ schema: 1,
  entries: paths.map((path) => ({ path, reason: REASON })) }));
const writeList = (root, bytes) => {
  mkdirSync(join(root, 'docs/ai'), { recursive: true });
  writeFileSync(join(root, LIST), bytes);
};
const readList = (root, bytes) => {
  writeList(root, bytes);
  const { readDeclaredList } = declared;
  return readDeclaredList(join(root, LIST));
};
const judgePaths = (root, paths, changed) => {
  const { judgeDeclaredList } = declared;
  return judgeDeclaredList({ top: root, read: readList(root, encodeList(paths)), changed });
};
const emptyResult = () => ({ configFailure: null, notJudged: [], lines: [], failures: [] });
const withLines = (lines, notJudged = [], failures = []) => ({ ...emptyResult(), lines, notJudged, failures });
const note = (path) => `${PREFIX}names no file of this tree: ${path}`;
const applied = (path) => `${PREFIX}not judged, no executed line in the coverage data: ${path} — ${REASON}`;
const executed = (path) => `${PREFIX}did not apply, the coverage data shows an executed line: ${path}`;
const treeFailure = (path) => `${path}: listed in ${LIST} but not a regular file`;
const NO_DATA = `${PREFIX}no coverage data was read, so no entry applied (1 listed)`;
const UNCHANGED = `${PREFIX}1 listed file(s) unchanged, not looked up`;
const changedAbsent = () => new Map([['lib.mjs', undefined]]);
const zeroHits = () => new Map([[1, 0], [2, 0], [3, 0]]);
const writeLcov = (root, hits, file = 'lib.mjs') => {
  const gitDirectory = runGit(root, ['rev-parse', '--absolute-git-dir']);
  const records = hits.map((count, index) => `DA:${index + 1},${count}`).join('\n');
  writeFileSync(join(gitDirectory, 'agent-workflow-lcov.info'), `SF:${join(root, file)}\n${records}\nend_of_record\n`);
};
const changeSource = (root) => writeFileSync(join(root, 'lib.mjs'), SOURCE.replaceAll(' = ', ' = 10 + '));
const runChecker = (root) => main(['--check', '--cwd', root], { env: fixtureEnv(root) });
const spawnGit = (root, observe = () => {}) => (command, args, options) => {
  assert.equal(command, 'git');
  assert.equal(options.cwd, root);
  observe(args);
  return spawnSync(command, args, { ...options, env: fixtureEnv(root) });
};

it('spec:coverage-declared/S1 judges the complete run, entry, tree and change table', async (context) => {
  const rows = [
    { name: 'absent list', absent: true, expected: emptyResult() },
    { name: 'unreadable symlink list', symlink: true, defect: /symlink/i },
    { name: 'not the list shape', bytes: Buffer.from('[]'), defect: SHAPE },
    ...[
      ['null entry', null], ['array entry', []], ['missing path', { reason: REASON }],
      ['missing reason', { path: 'other.mjs' }],
      ['unknown entry key', { path: 'other.mjs', reason: REASON, extra: true }],
    ].map(([name, entry]) => ({ name: `whole list void after ${name}`,
      bytes: Buffer.from(JSON.stringify({ schema: 1, entries: [{ path: 'lib.mjs', reason: REASON }, entry] })),
      defect: SHAPE })),
    { name: 'git lister cannot answer', gitFailure: true, defect: /(?:git|census)/i },
    { name: 'valid empty list', paths: [], expected: emptyResult() },
    { name: 'no git name equals entry', paths: ['missing.mjs'], changed: new Map([['missing.mjs', undefined]]),
      expected: withLines([note('missing.mjs')]) },
    { name: 'named path deleted unstaged', deleted: true, expected: withLines([note('lib.mjs')]) },
    { name: 'named tracked symlink', paths: ['link.mjs'], expected: withLines([], [], [treeFailure('link.mjs')]) },
    { name: 'named path replaced by directory', directory: true,
      expected: withLines([], [], [treeFailure('lib.mjs')]) },
    { name: 'named path probe errors on a non-directory parent', blockedParent: true, paths: ['real/leaf.mjs'],
      expected: withLines([], [], [treeFailure('real/leaf.mjs')]) },
    { name: 'no coverage bytes read', changed: null, expected: withLines([NO_DATA]) },
    { name: 'listed path unchanged', changed: Object.assign(new Map(), {
      get: () => assert.fail('an unchanged path must not be looked up'),
    }), expected: withLines([UNCHANGED]) },
    { name: 'changed path missing from coverage map', expected: withLines([applied('lib.mjs')], ['lib.mjs']) },
    { name: 'every line has zero hits', changed: new Map([['lib.mjs', zeroHits()]]),
      expected: withLines([applied('lib.mjs')], ['lib.mjs']) },
    { name: 'one line has executed', changed: new Map([['lib.mjs', new Map([[1, 0], [2, 1], [3, 0]])]]),
      expected: withLines([executed('lib.mjs')]) },
    { name: 'entry lines precede the unchanged count in list order',
      paths: ['missing.mjs', 'lib.mjs', 'other.mjs', 'stable.mjs'],
      changed: new Map([['lib.mjs', undefined], ['other.mjs', new Map([[1, 2]])]]),
      expected: withLines([note('missing.mjs'), applied('lib.mjs'), executed('other.mjs'), UNCHANGED], ['lib.mjs']) },
    { name: 'no-data count includes every listed entry', paths: ['missing.mjs', 'lib.mjs', 'link.mjs'], changed: null,
      expected: withLines([note('missing.mjs'), `${PREFIX}no coverage data was read, so no entry applied (3 listed)`],
        [], [treeFailure('link.mjs')]) },
  ];
  for (const row of rows) await context.test(row.name, () => withRepo((root) => {
    if (row.deleted || row.directory) rmSync(join(root, 'lib.mjs'));
    if (row.directory) mkdirSync(join(root, 'lib.mjs'));
    if (row.blockedParent) {
      rmSync(join(root, 'real'), { recursive: true });
      writeFileSync(join(root, 'real'), SOURCE);
    }
    const { judgeDeclaredList, readDeclaredList, parseDeclaredList } = declared;
    const bytes = row.bytes ?? encodeList(row.paths ?? ['lib.mjs']);
    if (row.symlink) {
      writeList(root, bytes);
      rmSync(join(root, LIST));
      symlinkSync('../../lib.mjs', join(root, LIST));
    } else if (!row.absent) writeList(root, bytes);
    const read = readDeclaredList(join(root, LIST));
    if (row.symlink) {
      assert.equal(read.state, 'unreadable');
      assert.match(read.defect, row.defect);
    }
    const spawn = row.gitFailure ? () => ({ status: 7, stdout: Buffer.alloc(0), stderr: Buffer.from('git unavailable') })
      : spawnGit(root);
    const result = judgeDeclaredList({ top: root, read,
      changed: Object.hasOwn(row, 'changed') ? row.changed : changedAbsent(), spawn });
    if (row.defect) {
      assert.equal(typeof result.configFailure, 'string');
      assert.ok(result.configFailure.startsWith(CONFIG_FAILURE), result.configFailure);
      const defect = result.configFailure.slice(CONFIG_FAILURE.length);
      assert.equal(isLineUnsafe(defect), false);
      if (typeof row.defect === 'string') assert.ok(defect.includes(row.defect), defect);
      else assert.match(defect, row.defect);
      if (row.symlink) assert.equal(defect, read.defect);
      if (row.bytes) {
        const parsed = parseDeclaredList(row.bytes);
        assert.equal(parsed.ok, false);
        assert.equal(defect, parsed.defect);
      }
      if (row.gitFailure) assert.match(defect, /7|unavailable/);
      assert.deepEqual(result, { ...emptyResult(), configFailure: `${CONFIG_FAILURE}${defect}` });
    } else assert.deepEqual(result, row.expected);
  }));
});

it('spec:coverage-declared/S5 does not judge a never-loaded listed file with zero-hit DA records', () => withRepo((root) => {
  changeSource(root);
  writeList(root, encodeList(['lib.mjs']));
  writeLcov(root, [0, 0, 0]);
  const result = runChecker(root);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0, result.stdout);
  assert.ok(result.stdout.split('\n').includes(applied('lib.mjs')), result.stdout);
  assert.doesNotMatch(result.stdout, /lib\.mjs: absent from coverage|lib\.mjs:\d+/);
}));

it('spec:coverage-declared/S6 judges zero-hit changed lines when another line executed', () => withRepo((root) => {
  changeSource(root);
  writeList(root, encodeList(['lib.mjs']));
  writeLcov(root, [1, 0, 0]);
  const result = runChecker(root);
  const lines = result.stdout.split('\n');
  assert.equal(result.stderr, '');
  assert.equal(result.code, 1, result.stdout);
  assert.ok(lines.includes(executed('lib.mjs')), result.stdout);
  assert.ok(lines.includes('  lib.mjs:2'), result.stdout);
  assert.ok(lines.includes('  lib.mjs:3'), result.stdout);
  assert.ok(!lines.includes('  lib.mjs:1'), result.stdout);
  assert.ok(lines.indexOf(executed('lib.mjs')) < lines.indexOf('coverage-check: FAIL — uncovered/unattributed changed Node lines:'));
  assert.doesNotMatch(result.stdout, /not judged, no executed line/);
}));

describe('spec:coverage-declared/S9 compares git names byte for byte before probing the tree', () => {
  it('notes a case mismatch while judging the real changed file', () => withRepo((root) => {
    changeSource(root);
    writeList(root, encodeList(['Lib.mjs']));
    writeLcov(root, [0, 0, 0]);
    const result = runChecker(root);
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.stdout.split('\n').includes(note('Lib.mjs')), result.stdout);
    for (const line of [1, 2, 3]) assert.ok(result.stdout.split('\n').includes(`  lib.mjs:${line}`), result.stdout);
    assert.doesNotMatch(result.stdout, /not judged, no executed line/);
  }));

  it('notes an unstaged deletion', () => withRepo((root) => {
    rmSync(join(root, 'lib.mjs'));
    assert.deepEqual(judgePaths(root, ['lib.mjs'], changedAbsent()), withLines([note('lib.mjs')]));
  }));

  it('notes a path through a linked folder', () => withRepo((root) => {
    const path = 'linked/leaf.mjs';
    assert.deepEqual(judgePaths(root, [path], new Map([[path, undefined]])), withLines([note(path)]));
  }));

  it('fails a tracked link leaf without narrowing other entries', () => withRepo((root) => {
    assert.deepEqual(judgePaths(root, ['link.mjs', 'lib.mjs'], changedAbsent()),
      withLines([applied('lib.mjs')], ['lib.mjs'], [treeFailure('link.mjs')]));
  }));

  it('keeps invalid UTF-8 git names as exact Buffers equal to no entry', () => withRepo((root) => {
    const { listGitNamedPaths } = census;
    const names = [0xfe, 0xff].map((byte) => Buffer.concat([Buffer.from('bad-'), Buffer.from([byte]), Buffer.from('.mjs')]));
    for (const name of names) writeFileSync(Buffer.concat([Buffer.from(`${root}/`), name]), SOURCE);
    runGit(root, ['add', '-A']);
    const paths = listGitNamedPaths(root, { spawn: spawnGit(root) });
    assert.ok(paths.every(Buffer.isBuffer));
    for (const name of names) assert.equal(paths.filter((path) => path.equals(name)).length, 1);
    const path = 'bad-\ufffd.mjs';
    assert.ok(!paths.some((name) => name.equals(Buffer.from(path))));
    assert.deepEqual(judgePaths(root, [path], new Map([[path, undefined]])), withLines([note(path)]));
  }));

  it('names an untracked listed file only on request and never names an ignored file', () => withRepo((root) => {
    const { listGitNamedPaths } = census;
    writeFileSync(join(root, 'untracked.mjs'), SOURCE);
    writeFileSync(join(root, 'ignored.mjs'), SOURCE);
    runGit(root, ['config', 'status.showUntrackedFiles', 'no']);
    runGit(root, ['config', 'core.quotePath', 'true']);
    const queries = [];
    const spawn = spawnGit(root, (args) => queries.push(args));
    const tracked = listGitNamedPaths(root, { spawn });
    const all = listGitNamedPaths(root, { untracked: true, spawn });
    assert.ok([...tracked, ...all].every(Buffer.isBuffer));
    assert.ok(tracked.some((path) => path.equals(Buffer.from('lib.mjs'))));
    assert.ok(!tracked.some((path) => path.equals(Buffer.from('untracked.mjs'))));
    assert.ok(all.some((path) => path.equals(Buffer.from('untracked.mjs'))));
    assert.ok(!all.some((path) => path.equals(Buffer.from('ignored.mjs'))));
    assert.ok(queries.every((args) => args.includes('-z')));
    assert.ok(queries.some((args) => args.includes('--exclude-standard')));
    assert.deepEqual(judgePaths(root, ['untracked.mjs'], new Map([['untracked.mjs', undefined]])),
      withLines([applied('untracked.mjs')], ['untracked.mjs']));
  }));

  it('deduplicates raw git names before decoding', () => withRepo((root) => {
    const { listGitNamedPaths } = census;
    const spawn = spawnGit(root);
    const duplicate = (command, args, options) => {
      const result = spawn(command, args, options);
      return { ...result, stdout: Buffer.concat([result.stdout, result.stdout]) };
    };
    const paths = listGitNamedPaths(root, { spawn: duplicate });
    assert.ok(paths.every(Buffer.isBuffer));
    assert.equal(paths.filter((path) => path.equals(Buffer.from('lib.mjs'))).length, 1);
    assert.equal(new Set(paths.map((path) => path.toString('hex'))).size, paths.length);
  }));

  it('refuses a failed git answer with CENSUS_UNAVAILABLE', () => withRepo((root) => {
    const { listGitNamedPaths } = census;
    assert.throws(() => listGitNamedPaths(root, { spawn: () => ({ status: 7,
      stdout: Buffer.alloc(0), stderr: Buffer.from('git unavailable') }) }),
    (error) => error instanceof Error && error.code === 'CENSUS_UNAVAILABLE');
  }));
});
