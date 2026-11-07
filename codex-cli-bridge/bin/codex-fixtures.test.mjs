import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const HARNESS = new URL('./codex-fixtures-harness.test.mjs', import.meta.url).href;
const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT_MS = 10_000;
const POLL_MS = 20;
const CHILDREN = new Map();
const stripGitLocationEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^[Gg][Ii][Tt]_/.test(key)));
const childEnv = (home, env = process.env) => ({
  ...Object.fromEntries(Object.entries(stripGitLocationEnv(env)).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
  HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C',
});
const isInside = (parent, path) => {
  const suffix = relative(parent, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix));
};
const makeOwnedFolder = (test, parent = tmpdir()) => {
  const folder = realpathSync(mkdtempSync(join(parent, 'codex-fixtures-')));
  CHILDREN.set(folder, []);
  test.after(async () => {
    try { await Promise.all(CHILDREN.get(folder).map((stop) => stop())); }
    finally { CHILDREN.delete(folder); rmSync(folder, { recursive: true, force: true }); }
  });
  return folder;
};
const takeSnapshot = (folder) => ['', ...readdirSync(folder, { recursive: true })].sort().map((name) => {
  const path = join(folder, name);
  const stats = lstatSync(path);
  return { name, mode: stats.mode, mtime: stats.mtimeMs,
    content: stats.isFile() ? readFileSync(path, 'base64') : stats.isSymbolicLink() ? readlinkSync(path) : null };
});
const makeCheckout = (makeFixtureRepo, folder, options = {}) => {
  const top = join(folder, 'checkout');
  for (const path of ['codex-cli-bridge/bin', 'agent-workflow-kit/bridges/codex-cli-bridge/bin', 'pkg-a/inner', 'scripts/release']) {
    mkdirSync(join(top, path), { recursive: true });
  }
  writeFileSync(join(top, 'scripts/release/version-sync.mjs'), "export const FAMILY_DIRS = Object.freeze(['pkg-a', 'codex-cli-bridge', 'agent-workflow-kit']);\n");
  if (!options.noSync) writeFileSync(join(top, 'scripts/sync-mirrors.mjs'), '');
  writeFileSync(join(top, '.gitignore'), options.unignored ? '' : '.test-repos/\n');
  const run = (args) => {
    const result = spawnSync('git', ['-c', 'user.name=coder-tool', '-c', 'user.email=coder-tools@proton.me', ...args], {
      cwd: top, env: childEnv(folder), encoding: 'utf8', timeout: WAIT_MS,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  makeFixtureRepo(run, top);
  return { top: realpathSync(top), root: join(realpathSync(top), '.test-repos'), here: join(top, 'codex-cli-bridge/bin') };
};
const startSuite = (folder, here, tmp, release = null) => {
  const suiteFolder = mkdtempSync(join(folder, 'child-'));
  const suite = join(suiteFolder, 'suite.mjs');
  writeFileSync(suite, [
    "import { it } from 'node:test'; import { existsSync } from 'node:fs'; import { setTimeout as delay } from 'node:timers/promises';",
    `import { openSuiteScopes } from ${JSON.stringify(HARNESS)};`,
    `const { repos, tmp } = await openSuiteScopes('pair', ${JSON.stringify({ here, tmp })});`,
    'console.log(JSON.stringify({ repos, tmp }));',
    `it('holds its scopes', async () => { const release = ${JSON.stringify(release)}; const deadline = Date.now() + ${WAIT_MS};`,
    `while (release && !existsSync(release)) { if (Date.now() > deadline) throw new Error('release deadline'); await delay(${POLL_MS}); } });`,
  ].join('\n'));
  const child = spawn(process.execPath, ['--test', suite], {
    cwd: folder, env: childEnv(folder), stdio: ['ignore', 'pipe', 'pipe'], timeout: WAIT_MS * 2,
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  CHILDREN.get(folder).push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  const report = async () => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const line = output.join('').split('\n').slice(0, -1).find((entry) => /^(?:# )?\{"repos":/.test(entry));
      if (line) return JSON.parse(line.replace(/^# /, ''));
      assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < deadline, output.join(''));
      await delay(POLL_MS);
    }
  };
  const finish = async () => { assert.deepEqual(await done, { code: 0, signal: null }, output.join('')); };
  return { report, finish };
};

it('spec:fixture-isolation/S1', async (test) => {
  const { makeFixtureRepo, resolveTestReposRoot } = await import('./codex-fixtures-harness.test.mjs');
  const folder = makeOwnedFolder(test);
  const fixture = makeCheckout(makeFixtureRepo, folder);
  mkdirSync(join(folder, 'tmp'));
  const tmp = realpathSync(join(folder, 'tmp'));
  assert.equal(existsSync(fixture.root), false);
  const first = startSuite(folder, fixture.here, tmp);
  const scopes = await first.report();
  assert.equal(dirname(scopes.repos), fixture.root);
  assert.ok(relative(fixture.root, scopes.repos).startsWith('pair-'));
  assert.equal(dirname(scopes.tmp), tmp);
  await first.finish();
  for (const path of [scopes.repos, scopes.tmp]) assert.equal(existsSync(path), false);
  assert.ok(existsSync(fixture.root));
  const release = join(folder, 'release');
  const children = [startSuite(folder, fixture.here, tmp, release), startSuite(folder, fixture.here, tmp, release)];
  const reports = await Promise.all(children.map((child) => child.report()));
  assert.notEqual(reports[0].repos, reports[1].repos);
  assert.notEqual(reports[0].tmp, reports[1].tmp);
  for (const report of reports) for (const path of [report.repos, report.tmp]) assert.ok(existsSync(path));
  writeFileSync(release, '');
  await Promise.all(children.map((child) => child.finish()));
  for (const report of reports) for (const path of [report.repos, report.tmp]) assert.equal(existsSync(path), false);
  const mirrorHere = join(fixture.top, 'agent-workflow-kit/bridges/codex-cli-bridge/bin');
  assert.deepEqual(await resolveTestReposRoot({ here: mirrorHere }), { top: fixture.top, root: fixture.root });
  const mirror = startSuite(folder, mirrorHere, tmp);
  const mirrorScopes = await mirror.report();
  assert.equal(dirname(mirrorScopes.repos), fixture.root);
  await mirror.finish();
  for (const path of [mirrorScopes.repos, mirrorScopes.tmp]) assert.equal(existsSync(path), false);
  assert.ok(existsSync(fixture.root));
});

it('spec:fixture-isolation/S2', async (test) => {
  const { makeFixtureRepo, openSuiteScopes, judgeTestReposRoot, resolveTestReposRoot } = await import('./codex-fixtures-harness.test.mjs');
  const messages = [];
  for (const refusal of ['symlink', 'wrong-here', 'no-git', 'unignored', 'inside-tmp', 'no-sync']) {
    const folder = makeOwnedFolder(test);
    const fixture = makeCheckout(makeFixtureRepo, folder, { unignored: refusal === 'unignored', noSync: refusal === 'no-sync' });
    const outside = join(folder, 'no-git');
    mkdirSync(outside);
    if (refusal === 'symlink') symlinkSync(join(fixture.top, 'pkg-a/inner'), fixture.root, 'dir');
    const here = refusal === 'wrong-here' ? join(fixture.top, 'pkg-a/inner') : refusal === 'no-git' ? outside : fixture.here;
    const tmp = refusal === 'inside-tmp' ? join(fixture.top, 'tmp') : join(folder, 'tmp');
    mkdirSync(tmp);
    const expected = { symlink: join(fixture.top, 'pkg-a'), 'wrong-here': here, 'no-git': here,
      unignored: fixture.root, 'inside-tmp': realpathSync(tmp), 'no-sync': join(fixture.top, 'scripts/sync-mirrors.mjs') }[refusal];
    const before = takeSnapshot(folder);
    if (refusal === 'no-git') assert.equal(await resolveTestReposRoot({ here }), null);
    await assert.rejects(() => openSuiteScopes('refused', { here, tmp }), (error) => {
      assert.ok(error.message.includes(expected), `${refusal}: ${error.message}`);
      messages.push(error.message);
      return true;
    });
    assert.deepEqual(readdirSync(tmp), []);
    assert.deepEqual(takeSnapshot(folder), before);
    if (refusal !== 'symlink') assert.equal(existsSync(fixture.root), false);
  }
  assert.equal(new Set(messages).size, messages.length);
  const folder = makeOwnedFolder(test);
  const fixture = makeCheckout(makeFixtureRepo, folder);
  const judged = await judgeTestReposRoot({ here: fixture.here, tmp: folder });
  assert.deepEqual({ ok: judged.ok, top: judged.top, root: judged.root }, { ok: true, top: fixture.top, root: fixture.root });
  const record = join(folder, 'calls');
  const preload = join(folder, 'preload.mjs');
  writeFileSync(record, '');
  writeFileSync(preload, [
    "import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; import { appendFileSync } from 'node:fs';",
    "for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {",
    `const original = childProcess[name]; childProcess[name] = (...args) => { appendFileSync(${JSON.stringify(record)}, name + '\\n'); return original(...args); }; }`,
    'syncBuiltinESMExports();',
  ].join('\n'));
  const before = takeSnapshot(folder);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '--eval', `await import(${JSON.stringify(HARNESS)});`], {
    cwd: fixture.here, env: childEnv(folder), encoding: 'utf8', timeout: WAIT_MS,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(record, 'utf8'), '');
  assert.deepEqual(takeSnapshot(folder), before);
});

it('spec:fixture-isolation/S3', async (test) => {
  const { makeFixtureRepo, resolveTestReposRoot } = await import('./codex-fixtures-harness.test.mjs');
  const folder = makeOwnedFolder(test);
  const fixture = makeCheckout(makeFixtureRepo, folder);
  const otherFolder = makeOwnedFolder(test);
  const other = makeCheckout(makeFixtureRepo, otherFolder);
  const env = childEnv(folder);
  const polluted = { ...env, GIT_DIR: join(other.top, '.git'), GIT_WORK_TREE: other.top, GIT_COMMON_DIR: join(other.top, '.git'),
    GIT_INDEX_FILE: join(other.top, '.git/index'), GIT_PREFIX: 'wrong/', GIT_CONFIG_PARAMETERS: 'invalid', GIT_EXEC_PATH: other.top,
    gIt_dIr: join(other.top, '.git') };
  const expected = { top: fixture.top, root: fixture.root };
  assert.deepEqual(await resolveTestReposRoot({ here: fixture.here, env }), expected);
  assert.deepEqual(await resolveTestReposRoot({ here: fixture.here, env: polluted }), expected);
  const real = await resolveTestReposRoot({ env });
  assert.ok(real);
  assert.deepEqual(await resolveTestReposRoot({ env: polluted }), real);
  assert.deepEqual(await resolveTestReposRoot({ here: HERE, env }), real);
});

it('spec:fixture-isolation/S4', async (test) => {
  const { makeFixtureRepo, openSuiteScopes } = await import('./codex-fixtures-harness.test.mjs');
  const slashTmp = realpathSync('/tmp');
  await test.test('checkout under /tmp', async (cell) => {
    if (!isInside(slashTmp, realpathSync(tmpdir()))) return cell.skip('os.tmpdir() is outside realpath /tmp');
    const folder = makeOwnedFolder(cell);
    const fixture = makeCheckout(makeFixtureRepo, folder);
    const scopes = await openSuiteScopes('under-tmp', { here: fixture.here, tmp: folder });
    assert.equal(typeof scopes.profileSkip, 'string');
    assert.ok(scopes.profileSkip.includes('/tmp'));
    assert.equal(isInside(scopes.tmp, fixture.top), false);
  });
  await test.test('checkout under host TMPDIR outside /tmp', async (cell) => {
    const host = await openSuiteScopes('codex-fixtures');
    if (isInside(slashTmp, realpathSync(host.repos))) return cell.skip('real checkout test-repos subroot lies under /tmp');
    const folder = makeOwnedFolder(cell, host.repos);
    const fixture = makeCheckout(makeFixtureRepo, folder);
    const scopes = await openSuiteScopes('outside-tmp', { here: fixture.here, tmp: folder });
    assert.equal(scopes.profileSkip, false);
    assert.equal(isInside(scopes.tmp, fixture.top), false);
  });
});
