import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_MAX_BUFFER, hermeticGitEnv } from '../../agent-workflow-kit/tools/git-env.mjs';
import { PRIOR_FILES, SCRIPT_PRIORS } from '../../agent-workflow-kit/tools/script-priors.mjs';
import { NODE_EVIDENCE_PROBES } from '../../agent-workflow-kit/tools/node-evidence.mjs';
import { readFamily } from '../../agent-workflow-memory/references/scripts/family.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MEMORY_ROOT = join(REPO, 'agent-workflow-memory');
const BUNDLE = join(MEMORY_ROOT, 'references', 'scripts');
const FIXTURES = join(REPO, 'agent-workflow-kit', 'test', 'fixtures', 'script-priors');
const FLAT_RELEASE = '9.0.0';
const KIT_DIRECTORY = 'scripts/agent-workflow';
const COMMAND = `node ${KIT_DIRECTORY}/run.mjs`;
const SWITCH_COMMAND = `${COMMAND} install-git-hooks`;
const USER_SUITE = 'scripts/user.test.mjs';
const USER_SUITE_BODY = "import { test } from 'node:test';\ntest('user suite', () => {});\n";
const HOOK_PATH = '.git/hooks/pre-commit';
const GIT_IDENTITY = ['-c', 'user.name=coder-tool', '-c', 'user.email=coder-tools@proton.me', '-c', 'commit.gpgsign=false'];
const INTEGRATION_TIMEOUT = 120_000;
const BUNDLED_FLAT_BODIES = {
  'spec-schema.mjs': 'spec-schema/spec-schema.mjs',
  'markdown-blocks.mjs': 'shared/markdown-blocks.mjs',
};
const GIT_LOCATION_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS', 'GIT_EXEC_PATH', 'gIt_location',
];

const compareVersions = (left, right) => {
  const rightParts = right.split('.').map(Number);
  return left.split('.').map(Number).map((part, index) => part - rightParts[index]).find((part) => part !== 0) ?? 0;
};
const coversFlatRelease = ({ firstShipped, lastShipped }) =>
  compareVersions(firstShipped, FLAT_RELEASE) <= 0 && compareVersions(FLAT_RELEASE, lastShipped) <= 0;
const writeAt = (root, path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};
const readAt = (root, path) => readFileSync(join(root, path), 'utf8');
const readFlatBody = (name) => {
  if (Object.hasOwn(BUNDLED_FLAT_BODIES, name)) return readFileSync(join(BUNDLE, BUNDLED_FLAT_BODIES[name]));
  const versions = readdirSync(FIXTURES).filter((version) => existsSync(join(FIXTURES, version, `${name}.txt`)))
    .sort(compareVersions);
  assert.ok(versions.length > 0, `setup: the last flat release's fixture exists for ${name}`);
  return readFileSync(join(FIXTURES, versions.at(-1), `${name}.txt`));
};

it('spec:standalone-scripts/S13 flat names, bodies covering 9.0.0 and Node probes equal the kit', async () => {
  const { FLAT_NAMES, FLAT_BODIES } = await import('../../agent-workflow-memory/scripts/flat-scripts.mjs').catch(() => ({}));
  const { NODE_EVIDENCE_PROBES: memoryProbes } = await import('../../agent-workflow-memory/scripts/kit-folder.mjs').catch(() => ({}));
  assert.deepEqual(FLAT_NAMES, PRIOR_FILES, 'memory exports the same 25 flat names as the kit');
  assert.ok(Array.isArray(FLAT_BODIES), 'memory exports its flat body catalog');
  const expectedPairs = new Set(SCRIPT_PRIORS.filter(coversFlatRelease).map(({ file, digest }) => `${file} ${digest}`));
  const actualPairs = FLAT_BODIES.map(({ file, digest }) => `${file} ${digest}`);
  assert.equal(new Set(actualPairs).size, actualPairs.length, 'memory has no duplicate file/digest pair');
  assert.deepEqual(new Set(actualPairs), expectedPairs, 'memory pins exactly the catalog rows covering 9.0.0');
  assert.deepEqual(memoryProbes, NODE_EVIDENCE_PROBES, 'memory probes the same paths in the same order');
  assert.ok(Object.isFrozen(FLAT_NAMES));
  assert.ok(Object.isFrozen(FLAT_BODIES) && FLAT_BODIES.every(Object.isFrozen));
  assert.ok(Object.isFrozen(memoryProbes));
});

it('spec:standalone-scripts/S14 one plain run moves a 1af99af deployment through real git, the real rotator and a hook commit',
  { timeout: INTEGRATION_TIMEOUT }, () => {
    const base = mkdtempSync(join(tmpdir(), 'standalone-flat-move-'));
    const project = join(base, 'project');
    const home = join(base, 'home');
    try {
      mkdirSync(project);
      mkdirSync(home);
      const inherited = { ...process.env, ...Object.fromEntries(GIT_LOCATION_KEYS.map((key) => [key, 'foreign-location'])) };
      const env = {
        ...Object.fromEntries(Object.entries(hermeticGitEnv(inherited, home))
          .filter(([key]) => !['NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE', 'CLAUDE_CONFIG_DIR'].includes(key))),
        npm_config_cache: join(home, 'npm-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false',
        npm_config_audit: 'false', npm_config_fund: 'false',
      };
      for (const key of [...GIT_LOCATION_KEYS, 'NODE_TEST_CONTEXT']) assert.equal(env[key], undefined, `${key} is not inherited`);
      for (const [key, value] of Object.entries({
        HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C', PATH: process.env.PATH,
      })) assert.equal(env[key], value, `${key} is hermetic`);
      const run = (step, command, ...args) => {
        const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        assert.equal(result.error, undefined, `${step}: ${command} could not start: ${result.error?.code ?? result.error?.message}`);
        assert.equal(result.signal, null, `${step}: ${command} was killed: ${output}`);
        assert.equal(result.status, 0, `${step}: ${command} ${args.join(' ')}\n${output}`);
        return result.stdout;
      };
      const git = (step, ...args) => run(step, 'git', ...GIT_IDENTITY, ...args);
      const commit = (step, message, ...flags) => {
        git(step, 'add', '-A');
        git(step, 'commit', '-q', '-m', message, ...flags);
      };
      git('setup', 'init', '-q', '-b', 'main');
      for (const [question, expected] of [
        ['--absolute-git-dir', join(project, '.git')], ['--git-common-dir', join(project, '.git')],
        ['--show-toplevel', project],
      ]) {
        const answer = git('setup: repository identity', 'rev-parse', question).trim();
        assert.notEqual(answer, '', `${question} answers an identity`);
        assert.equal(resolve(project, answer), expected, `${question} reaches only the temp project`);
      }
      writeAt(project, 'package.json', `${JSON.stringify({
        name: 'standalone-flat-move-fixture', scripts: { prepare: 'node scripts/install-git-hooks.mjs' },
      }, null, 2)}\n`);
      for (const name of PRIOR_FILES) writeAt(project, `scripts/${name}`, readFlatBody(name));
      for (const [name, type] of [['changelog', 'log'], ['known_issues', 'issues']]) {
        writeAt(project, `docs/ai/${name}.md`, `---\ntype: ${type}\nmaxLines: 200\n---\n\n# ${name}\n`);
      }
      run('setup', process.execPath, 'scripts/check-docs-size.mjs', '--write-index');
      run('setup', process.execPath, 'scripts/install-git-hooks.mjs');
      const flatHook = readAt(project, HOOK_PATH);
      assert.match(flatHook, /:install-git-hooks\.mjs$/m, 'setup: the flat installer wrote a managed hook');
      assert.ok(flatHook.includes('node scripts/check-docs-size.mjs'), 'setup: the hook runs the flat checker');
      writeAt(project, USER_SUITE, USER_SUITE_BODY);
      commit('setup', 'test: seed flat deployment', '--no-verify');

      const stdout = run('plain standalone move', process.execPath, join(MEMORY_ROOT, 'scripts', 'kit-folder.mjs'), '--project', project);
      const deployed = readFamily(BUNDLE).filter(({ role }) => role === 'deployed');
      for (const { path } of deployed) {
        const target = join(project, KIT_DIRECTORY, path);
        assert.ok(lstatSync(target, { throwIfNoEntry: false })?.isFile(), `${path} stands as a regular file`);
        assert.ok(readFileSync(target).equals(readFileSync(join(BUNDLE, path))), `${path} equals memory's bundled bytes`);
      }
      assert.deepEqual(PRIOR_FILES.filter((name) => lstatSync(join(project, 'scripts', name), { throwIfNoEntry: false })), [],
        'one plain run removes every flat name, including links or directories');
      assert.equal(readAt(project, HOOK_PATH), flatHook, 'the script leaves the hook switch for the caller');
      const lines = stdout.split('\n').filter(Boolean);
      const suiteLines = lines.filter((line) => line.includes(`node --test ${USER_SUITE}`));
      assert.equal(suiteLines.length, 1, 'the user suite command is printed once');
      assert.ok(suiteLines[0].startsWith(USER_SUITE));
      assert.ok(suiteLines[0].includes('scripts/pre-commit.local'));
      assert.equal(readAt(project, USER_SUITE), USER_SUITE_BODY);
      assert.ok(lines.some((line) => line.startsWith('ADR store: ')), 'the real rotator is reported only by its prefix');
      const switchLines = lines.filter((line) => line.includes(SWITCH_COMMAND));
      assert.equal(switchLines.length, 1, 'the switch command is printed once');
      run('switch line command', process.execPath, ...SWITCH_COMMAND.split(' ').slice(1));
      const hookLines = readAt(project, HOOK_PATH).split('\n');
      const expectedHookLines = [`${COMMAND} docs-size`, `${COMMAND} docs-size --check-index`,
        ...['changelog', 'issues', 'decisions'].map((name) => `${COMMAND} archive-${name} --check`)];
      assert.deepEqual(hookLines.filter((line) => /^\s*node\s/.test(line)), expectedHookLines,
        'every hook check is invoked only through the stable command');
      const hook = hookLines.join('\n');
      for (const name of PRIOR_FILES) assert.ok(!hook.includes(`scripts/${name}`), `the hook no longer names scripts/${name}`);
      assert.deepEqual(hookLines.filter((line) => /--test\b|\.test\.mjs/.test(line)), [], 'the hook runs no suite');
      const beforeCommit = git('before hook commit', 'rev-parse', 'HEAD').trim();
      assert.match(beforeCommit, /^[0-9a-f]+$/);
      commit('commit through the switched hook', 'test: move standalone flat deployment');
      const afterCommit = git('after hook commit', 'rev-parse', 'HEAD').trim();
      assert.match(afterCommit, /^[0-9a-f]+$/);
      assert.notEqual(afterCommit, beforeCommit, 'a real commit passes through the switched hook and moves HEAD');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
