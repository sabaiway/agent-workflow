import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticGitEnv } from '../git-env.mjs';
import { PRIOR_FILES } from '../script-priors.mjs';
import { DEPLOYED_SCRIPTS } from '../node-evidence.mjs';
import { UPGRADE_RUNLIST } from '../upgrade-runlist.mjs';
import { KIT_COMMANDS } from '../../references/scripts/run.mjs';
import { ALARM_WORDS, INTERNAL_NAMES, scannable } from '../../../scripts/testing/composed-lines-scan.mjs';

const KIT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
const FIXTURES = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
const KIT_DIRECTORY = 'scripts/agent-workflow';
const COMMAND = `node ${KIT_DIRECTORY}/run.mjs`;
const GATES_PATH = 'docs/ai/gates.json';
const USER_FILE = 'notes/run.sh';
const USER_SUITE = 'scripts/user.test.mjs';
const GREP_PREFIX = 'other files naming an old path: ';
const BOUNDARY = 'git grep lists tracked and untracked files git does not ignore; the hooks dir and ignored files are yours to check';
const SUITE_LINE = `${USER_SUITE}: a suite of your own — the kit's hook runs no suite; add node --test ${USER_SUITE} to scripts/pre-commit.local to keep it on every commit`;
const GATES = [
  { id: 'docs', title: 'Docs caps', cmd: 'node scripts/check-docs-size.mjs' },
  { id: 'index', title: 'Docs index', cmd: 'node scripts/check-docs-size.mjs --check-index' },
  { id: 'changelog', title: 'Changelog', cmd: 'node scripts/archive-changelog.mjs --check' },
];
const EXPECTED_GATES = [
  { ...GATES[0], cmd: `${COMMAND} docs-size` },
  { ...GATES[1], cmd: `${COMMAND} docs-size --check-index` },
  { ...GATES[2], cmd: `${COMMAND} archive-changelog --check` },
];
const BUNDLED_FLAT_BODIES = {
  'spec-schema.mjs': 'spec-schema/spec-schema.mjs',
  'markdown-blocks.mjs': 'shared/markdown-blocks.mjs',
};
const GIT_IDENTITY = ['-c', 'user.name=coder-tool', '-c', 'user.email=coder-tools@proton.me', '-c', 'commit.gpgsign=false'];

const writeAt = (root, path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};
const readAt = (root, path) => readFileSync(join(root, path), 'utf8');
const readJson = (root, path) => JSON.parse(readAt(root, path));
const writeJson = (root, path, value) => writeAt(root, path, `${JSON.stringify(value, null, 2)}\n`);
const readFlatBody = (name) => {
  if (Object.hasOwn(BUNDLED_FLAT_BODIES, name)) return readFileSync(join(BUNDLE, BUNDLED_FLAT_BODIES[name]));
  const versions = readdirSync(FIXTURES).filter((version) => existsSync(join(FIXTURES, version, `${name}.txt`)))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  assert.ok(versions.length > 0, `setup: the last flat release's fixture exists for ${name}`);
  return readFileSync(join(FIXTURES, versions.at(-1), `${name}.txt`));
};
const readScriptLines = (stdout) => {
  const rest = stdout.split('\n  scripts: ')[1]?.split('\n').slice(1) ?? [];
  const end = rest.findIndex((line) => !line.startsWith('      '));
  return rest.slice(0, end === -1 ? rest.length : end).map((line) => line.slice(6));
};
const judgeComposedLine = (line) => {
  for (const word of ALARM_WORDS) assert.doesNotMatch(line, new RegExp(`\\b${word}\\b`, 'i'), `step 6: ${line}`);
  for (const name of INTERNAL_NAMES) assert.doesNotMatch(scannable(line), new RegExp(`\\b${name}\\b`, 'i'), `step 6: ${line}`);
};
const findFlatMentions = (raw) => {
  const names = PRIOR_FILES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(String.raw`(?<![\w.-])(?<!references[\\/])scripts[\\/](?:${names}|<[^<>\s]*>\.mjs)(?![\w-]|\.\w)`, 'g');
  return [...raw.replace(/\s+/g, ' ').matchAll(pattern)].map(([path]) => path);
};

describe('spec:distribution-files/S38 one plain upgrade of a 1af99af deployment through real commits', () => {
  it('moves the flat release through the hook, gates, prepare and printed search', { timeout: 120_000 }, () => {
    const base = mkdtempSync(join(tmpdir(), 'flat-upgrade-'));
    const project = join(base, 'project');
    const home = join(base, 'home');
    mkdirSync(project);
    mkdirSync(home);
    const env = {
      ...Object.fromEntries(Object.entries(hermeticGitEnv(process.env, home))
        .filter(([key]) => !['NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE', 'CLAUDE_CONFIG_DIR'].includes(key))),
      npm_config_cache: join(home, 'npm-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false',
      npm_config_audit: 'false', npm_config_fund: 'false',
    };
    const run = (step, command, ...args) => {
      const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8' });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      assert.equal(result.error, undefined, `${step}: ${command} could not start: ${result.error?.message}`);
      assert.equal(result.signal, null, `${step}: ${command} was killed: ${output}`);
      assert.equal(result.status, 0, `${step}: ${command} ${args.join(' ')}\n${output}`);
      return result.stdout;
    };
    const git = (step, ...args) => run(step, 'git', ...GIT_IDENTITY, ...args);
    const commit = (step, message, ...flags) => {
      git(step, 'add', '-A');
      git(step, 'commit', '-q', '-m', message, ...flags);
    };
    try {
      git('setup', 'init', '-q', '-b', 'main');
      writeJson(project, 'package.json', { name: 'flat-upgrade-fixture', scripts: { prepare: 'node scripts/install-git-hooks.mjs' } });
      for (const name of PRIOR_FILES) writeAt(project, `scripts/${name}`, readFlatBody(name));
      for (const [name, type] of [['changelog', 'log'], ['known_issues', 'issues']]) {
        writeAt(project, `docs/ai/${name}.md`, `---\ntype: ${type}\nmaxLines: 200\n---\n\n# ${name}\n`);
      }
      writeJson(project, GATES_PATH, { gates: GATES });
      writeAt(project, USER_FILE, 'node scripts/check-docs-size.mjs\n');
      writeAt(project, USER_SUITE, "import { test } from 'node:test';\ntest('user suite', () => {});\n");
      run('setup', process.execPath, 'scripts/check-docs-size.mjs', '--write-index');
      run('setup', process.execPath, 'scripts/install-git-hooks.mjs');
      const hookPath = '.git/hooks/pre-commit';
      const flatHook = readAt(project, hookPath);
      assert.match(flatHook, /:install-git-hooks\.mjs$/m, 'setup: the flat installer wrote a managed hook');
      assert.ok(flatHook.includes(GATES[0].cmd), 'setup: the hook runs the flat checker');
      commit('setup', 'test: seed flat deployment', '--no-verify');

      const upgrade = run('step 1: plain upgrade', process.execPath, join(KIT_ROOT, 'tools', 'ensure-configs.mjs'), '--reconcile', '--cwd', project);
      assert.deepEqual(PRIOR_FILES.filter((name) => existsSync(join(project, 'scripts', name))), [],
        'step 1: one plain upgrade removes all 25 flat kit files');
      for (const { path, deployed } of DEPLOYED_SCRIPTS) {
        assert.ok(lstatSync(join(project, deployed), { throwIfNoEntry: false })?.isFile(), `step 1: ${deployed} stands as a regular file`);
        assert.ok(readFileSync(join(project, deployed)).equals(readFileSync(join(BUNDLE, path))), `step 1: ${deployed} is bundled`);
      }
      assert.equal(readAt(project, hookPath), flatHook, 'step 1: the upgrade leaves the hook to its advisor item');
      const moveLines = readScriptLines(upgrade);
      const removedLines = PRIOR_FILES.map((name) => `scripts/${name}: removed — the kit's scripts live in ${KIT_DIRECTORY}/`);
      for (const line of [...removedLines, SUITE_LINE, BOUNDARY]) {
        assert.equal(moveLines.filter((printed) => printed === line).length, 1, `step 1: the move prints once: ${line}`);
      }
      const grepLines = moveLines.filter((line) => line.startsWith(GREP_PREFIX));
      assert.equal(grepLines.length, 1, 'step 1: the move prints one grep line');
      const grepCommand = grepLines[0].slice(GREP_PREFIX.length);
      assert.ok(grepCommand.startsWith('git grep -n -F --untracked '), 'step 1: the grep includes untracked files');
      assert.ok(grepCommand.endsWith(" -- . ':!scripts/agent-workflow'"), 'step 1: the grep excludes the kit folder');
      for (const name of PRIOR_FILES) assert.ok(grepCommand.includes(name), `step 1: the grep searches ${name}`);
      const commitLines = moveLines.filter((line) => /\bcommit\b/i.test(line) && line.includes(`${KIT_DIRECTORY}/`));
      assert.equal(commitLines.length, 1, 'step 1: the visible deployment gets one commit-together line');
      for (const fact of [GATES_PATH, 'package.json', 'removed', 'one change', 'merge', 'branch']) {
        assert.ok(commitLines[0].includes(fact), `step 1: the commit-together line names ${fact}`);
      }

      const advisor = JSON.parse(run('step 2: advisor', process.execPath, join(KIT_ROOT, 'tools', 'recommendations.mjs'), '--cwd', project, '--json'));
      const item = advisor.items.find(({ key }) => key === 'hook-checks');
      assert.ok(item, `step 2: hook-checks renders over the managed flat hook: ${JSON.stringify(advisor.skips)}`);
      assert.equal(item.variant, 'hook-checks', 'step 2: the item selects the hook-checks writer');
      assert.ok(item.check && item.apply, 'step 2: the item carries its check and apply');
      const check = run('step 2: item check', 'bash', '-c', item.check);
      const digest = check.match(/^digest: ([0-9a-f]{64})$/m)?.[1];
      assert.ok(digest, `step 2: the item check returns the expected digest: ${check}`);
      assert.ok(item.apply.includes('<digest>'), 'step 2: the apply binds the checked digest');
      run('step 2: item apply', 'bash', '-c', item.apply.replace('<digest>', digest));
      const hookLines = readAt(project, hookPath).split('\n');
      const expectedHookLines = [`${COMMAND} docs-size`, `${COMMAND} docs-size --check-index`,
        ...['changelog', 'issues', 'decisions'].map((name) => `${COMMAND} archive-${name} --check`)];
      for (const line of expectedHookLines) assert.ok(hookLines.includes(line), `step 2: the applied hook runs ${line}`);
      assert.deepEqual(hookLines.filter((line) => /--test\b|\.test\.mjs/.test(line)), [], 'step 2: the hook runs no suite');
      const beforeCommit = git('step 2', 'rev-parse', 'HEAD');
      commit('step 2: next commit through the applied hook', 'test: upgrade flat deployment');
      assert.notEqual(git('step 2', 'rev-parse', 'HEAD'), beforeCommit, 'step 2: a real commit passes the applied hook');

      const migration = UPGRADE_RUNLIST.find(({ id }) => id === 'gates-migration');
      assert.ok(migration, 'step 3: row 4 supplies the gates-migration command');
      const migrationCommand = migration.command.replaceAll('${CLAUDE_SKILL_DIR}', KIT_ROOT).replace('<project>', project);
      const gatesBefore = readAt(project, GATES_PATH);
      const preview = run('step 3: migration preview', 'bash', '-c', migrationCommand);
      assert.equal(readAt(project, GATES_PATH), gatesBefore, 'step 3: the preview writes nothing');
      for (const { id, cmd } of EXPECTED_GATES) {
        assert.ok(preview.split('\n').some((line) => /\bSWITCH\b/.test(line) && line.includes(id) && line.includes(cmd)),
          `step 3: row 4 switches ${id} without a flag naming a flat file\n${preview}`);
      }
      run('step 3: migration apply', 'bash', '-c', `${migrationCommand} --apply`);
      assert.deepEqual(readJson(project, GATES_PATH).gates, EXPECTED_GATES, 'step 3: each flat gate switches in place');

      const packageJson = readJson(project, 'package.json');
      assert.equal(packageJson.scripts.prepare, 'node scripts/install-git-hooks.mjs', 'step 4: package scripts are the caller\'s edit');
      writeJson(project, 'package.json', { ...packageJson, scripts: { ...packageJson.scripts, prepare: `${COMMAND} install-git-hooks` } });
      run('step 4: edited prepare', 'npm', 'run', 'prepare');

      const grepOutput = run('step 5: printed grep run as printed', 'bash', '-c', grepCommand);
      assert.ok(grepOutput.split('\n').some((line) => line.startsWith(`${USER_FILE}:1:`) && line.includes(GATES[0].cmd)),
        `step 5: the printed grep lists the planted user file\n${grepOutput}`);
      for (const line of [...removedLines, SUITE_LINE, ...grepLines, BOUNDARY, ...commitLines]) judgeComposedLine(line);
      assert.deepEqual(findFlatMentions(readFileSync(join(KIT_ROOT, 'references', 'modes', 'upgrade.md'), 'utf8')), [],
        'step 7: upgrade.md names no flat kit file');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
