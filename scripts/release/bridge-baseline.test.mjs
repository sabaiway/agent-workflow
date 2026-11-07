import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { FAMILY_DIRS, PACKAGE_ALIASES, resolvePackageDir, runCli } from './version-sync.mjs';
import { syncBridgeMirror } from '../sync-mirrors.mjs';
import { cwdBoundGitEnv } from '../suite-parity.mjs';

const KIT = 'agent-workflow-kit';
const BRIDGE = 'codex-cli-bridge';
const JUDGE = 'typesafe-jev-bridge';
const VERSION = '1.2.0';
const EXPECT = ['--expect', `kit=${VERSION}`];
const CLI = fileURLToPath(new URL('./version-sync.mjs', import.meta.url));
const temporaryDirectories = [];
const makeRoot = () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-baseline-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'root'));
  mkdirSync(join(directory, 'home'));
  return join(directory, 'root');
};
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const write = (root, relative, bytes) => {
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), bytes);
};
const makeGitEnv = (root, environment = process.env) => cwdBoundGitEnv({
  ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_'))),
  HOME: join(dirname(root), 'home'), XDG_CONFIG_HOME: join(dirname(root), 'home'),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'coder-tool', GIT_COMMITTER_NAME: 'coder-tool',
  GIT_AUTHOR_EMAIL: 'coder-tools@proton.me', GIT_COMMITTER_EMAIL: 'coder-tools@proton.me',
});
const git = (root, args, environment = makeGitEnv(root)) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
  cwd: root, env: cwdBoundGitEnv(environment), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const initializeRepository = (root) => {
  git(root, ['init']);
  const environment = makeGitEnv(root);
  const stripped = makeGitEnv(root, Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_'))));
  for (const flag of ['--show-toplevel', '--absolute-git-dir', '--git-common-dir']) {
    assert.equal(git(root, ['rev-parse', '--path-format=absolute', flag], environment),
      git(root, ['rev-parse', '--path-format=absolute', flag], stripped));
  }
  assert.equal(realpathSync(git(root, ['rev-parse', '--show-toplevel'])), realpathSync(root));
};
const commit = (root, message) => {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
};
const seedPackage = (root, directory, version = VERSION, bridge = false) => {
  if (!bridge) write(root, `${directory}/package.json`, JSON.stringify({ name: directory, version }, null, 2));
  write(root, `${directory}/capability.json`, JSON.stringify({ schema: 1, name: directory, version }, null, 2));
  write(root, `${directory}/SKILL.md`, `---\nname: ${directory}\ndescription: fixture\nmetadata:\n  version: '${version}'\n---\n`);
  if (!bridge) write(root, `${directory}/CHANGELOG.md`, `# Changelog\n\n## ${version}\n\n- fixture\n`);
};
const seedBridge = (root, directory = BRIDGE, version = VERSION) => {
  seedPackage(root, directory, version, true);
  write(root, `${directory}/bin/run.sh`, `#!/usr/bin/env bash\nAW_BRIDGE_VERSION="${version}"  # aw-version-anchor\necho "$AW_BRIDGE_VERSION"\n`);
  write(root, `${directory}/payload.bin`, Buffer.from([0, 1, 255]));
  syncBridgeMirror(root, directory);
};
const makeRepository = ({ rootBaseline = false, bridge = BRIDGE } = {}) => {
  const root = makeRoot();
  initializeRepository(root);
  seedPackage(root, KIT, rootBaseline ? VERSION : '1.1.0');
  if (bridge) seedBridge(root, bridge);
  const initial = commit(root, 'Initial fixture');
  if (rootBaseline) return { root, baseline: initial };
  seedPackage(root, KIT);
  return { root, baseline: commit(root, 'Set kit version') };
};
const run = (root, args = EXPECT) => {
  const output = [], errors = [];
  const environment = process.env;
  try {
    process.env = makeGitEnv(root);
    const code = runCli([...args, '--root', root], { log: (line) => output.push(line), logError: (line) => errors.push(line) });
    return { code, errors, text: [...output, ...errors].join('\n') };
  } finally { process.env = environment; }
};
const runChild = (root, args = EXPECT, overrides = {}) => {
  const result = spawnSync(process.execPath, [CLI, ...args, '--root', root], {
    cwd: root, env: { ...makeGitEnv(root), ...overrides }, encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { code: result.status, errors: result.stderr.trim().split('\n').filter(Boolean), text: result.stdout + result.stderr };
};
const withoutGit = () => {
  const directory = makeRoot();
  symlinkSync(process.execPath, join(directory, 'node'));
  return { PATH: directory };
};
const assertProblem = (result, cause) => {
  assert.equal(result.code, 1, result.text);
  assert.equal(result.errors.length, 1, result.text);
  assert.match(result.errors[0], cause);
};
const assertBaselineProblem = (result, baseline, bridge = BRIDGE) => {
  assertProblem(result, /--bump/);
  for (const fact of [bridge, VERSION]) assert.ok(result.errors[0].includes(fact), result.text);
  assert.ok(result.errors[0].includes(baseline) || result.errors[0].includes(baseline.slice(0, 7)), result.text);
};
const changePayload = (root, kind = 'bytes') => {
  if (kind === 'removed') rmSync(join(root, BRIDGE, 'payload.bin'));
  else write(root, `${BRIDGE}/${kind === 'added' ? 'added.bin' : 'payload.bin'}`, Buffer.from([0, 2, 255]));
  syncBridgeMirror(root, BRIDGE);
};

it('spec:version-sync/S1 judge family order, alias, expectation and wrapper drift', () => {
  assert.deepEqual(FAMILY_DIRS, ['agent-workflow-memory', 'agent-workflow-engine', KIT, BRIDGE, 'antigravity-cli-bridge', JUDGE]);
  assert.equal(PACKAGE_ALIASES.jev, JUDGE);
  assert.equal(resolvePackageDir('jev'), JUDGE);
  const { root } = makeRepository({ bridge: JUDGE });
  assert.equal(run(root, ['--expect', `jev=${VERSION}`]).code, 0);
  write(root, `${JUDGE}/bin/run.sh`, '#!/usr/bin/env bash\nAW_BRIDGE_VERSION="1.1.0"  # aw-version-anchor\n');
  const result = run(root, []);
  assert.equal(result.code, 1, result.text);
  assert.ok(result.errors.some((line) => line.includes(`${JUDGE}/bin/run.sh`) && line.includes('1.1.0')), result.text);
});

it('spec:version-sync/S2 kit-only expectation compares bridge bytes, added and removed paths, and permits a raised version', () => {
  for (const kind of ['bytes', 'added', 'removed']) {
    const { root, baseline } = makeRepository();
    changePayload(root, kind);
    assertBaselineProblem(run(root), baseline);
    assert.equal(run(root, ['--bump', 'codex=1.3.0']).code, 0);
    assert.equal(run(root).code, 0);
  }
});

it('spec:version-sync/S3 baseline follows committed kit transitions, including root and uncommitted bump, and skips absent mirrors', () => {
  for (const state of ['later commit', 'HEAD transition', 'root transition', 'uncommitted bump']) {
    const { root, baseline } = makeRepository({ rootBaseline: state === 'root transition' });
    changePayload(root);
    if (state === 'later commit') assert.notEqual(commit(root, 'Changed bridge without kit version'), baseline);
    if (state === 'uncommitted bump') seedPackage(root, KIT, '1.3.0');
    assertBaselineProblem(run(root, state === 'uncommitted bump' ? ['--expect', 'kit=1.3.0'] : EXPECT), baseline);
  }
  const { root } = makeRepository({ bridge: null });
  seedBridge(root);
  assert.equal(run(root).code, 0);
});

describe('spec:version-sync/S4 unreadable history is one problem; roots and inherited git locations are bounded', () => {
  it('no git on PATH names git', () => {
    const root = makeRoot();
    seedPackage(root, KIT); seedBridge(root);
    const result = runChild(root, EXPECT, withoutGit());
    assertProblem(result, /\bgit\b/i);
    assert.match(result.errors[0], /\bPATH\b/, result.text);
  });
  it('a root outside a repository names repository', () => {
    const root = makeRoot();
    seedPackage(root, KIT); seedBridge(root);
    assertProblem(run(root), /repository/i);
  });
  it('no commit setting the kit version names version', () => {
    const root = makeRoot();
    initializeRepository(root);
    write(root, 'unrelated.txt', 'unrelated\n'); commit(root, 'No kit version');
    seedPackage(root, KIT); seedBridge(root);
    assertProblem(run(root), /version/i);
  });
  it('an unreadable committed kit version names version', () => {
    const root = makeRoot();
    initializeRepository(root);
    seedPackage(root, KIT, '1.2'); seedBridge(root); commit(root, 'Unreadable kit version');
    seedPackage(root, KIT);
    assertProblem(run(root), /unreadable version/);
  });
  it('a foreign ancestor repository is outside the root repository', () => {
    const { root: parent } = makeRepository();
    const root = join(parent, 'nested');
    seedPackage(root, KIT); seedBridge(root);
    assert.notEqual(realpathSync(git(root, ['rev-parse', '--show-toplevel'])), realpathSync(root));
    assertProblem(run(root), /repository/i);
  });
  it('inherited GIT_DIR and companion overrides do not redirect history', () => {
    const { root, baseline } = makeRepository();
    const { root: foreign } = makeRepository({ rootBaseline: true });
    changePayload(root);
    assertBaselineProblem(runChild(root, EXPECT, {
      GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign,
      GIT_COMMON_DIR: join(foreign, '.git'), GIT_INDEX_FILE: join(foreign, '.git', 'index'),
    }), baseline);
  });
  it('a shallow file clone cut above the baseline names history or shallow', () => {
    const { root } = makeRepository();
    write(root, 'later.txt', 'later\n'); commit(root, 'After release');
    const destination = makeRoot();
    git(destination, ['clone', '--depth', '1', pathToFileURL(root).href, destination]);
    assert.equal(git(destination, ['rev-parse', '--is-shallow-repository']), 'true');
    assertProblem(run(destination), /history|shallow/i);
  });
  it('no bridge folder and no repository needs no history', () => {
    const root = makeRoot();
    seedPackage(root, KIT);
    assert.equal(runChild(root, EXPECT, withoutGit()).code, 0);
  });
});

describe('spec:version-sync/S5 history-free passes and mirror walk exclusions', () => {
  it('bump and bare pass need no git even when equal-version bytes moved', () => {
    const root = makeRoot();
    seedPackage(root, KIT); seedBridge(root); changePayload(root);
    const environment = withoutGit();
    assert.equal(runChild(root, [], environment).code, 0);
    assert.equal(runChild(root, ['--bump', 'codex=1.3.0'], environment).code, 0);
    assert.equal(runChild(root, [], environment).code, 0);
  });
  it('node_modules and .git at any canon depth are excluded from comparison', () => {
    const { root } = makeRepository();
    for (const relative of ['node_modules/cache.bin', '.git/local', 'nested/node_modules/cache.bin', 'nested/.git/local']) {
      write(root, `${BRIDGE}/${relative}`, 'excluded\n');
      syncBridgeMirror(root, BRIDGE);
      assert.equal(existsSync(join(root, KIT, 'bridges', BRIDGE, relative)), false);
    }
    assert.equal(run(root).code, 0);
  });
});
