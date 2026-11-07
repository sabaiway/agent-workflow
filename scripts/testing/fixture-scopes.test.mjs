import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GIT_MAX_BUFFER, hermeticGitEnv } from '../../agent-workflow-kit/tools/git-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDENTITY = ['-c', 'user.name=coder-tool', '-c', 'user.email=coder-tools@proton.me'];
const TIMEOUT = 60_000;
const makeScope = (test) => {
  const home = mkdtempSync(join(tmpdir(), 'fixture-scopes-'));
  test.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: hermeticGitEnv(process.env, home) };
};
const runGit = (cwd, env, args) => {
  const result = spawnSync('git', [...IDENTITY, ...args], { cwd, env, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: GIT_MAX_BUFFER });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result;
};
const listTracked = (env) => runGit(ROOT, env, ['ls-files', '-z']).stdout.split('\0').filter(Boolean);
const tokenize = (text) => {
  const tokens = [];
  const stack = [];
  const grammar = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[dgimsuvy]*|[\w$]+|\.\.\.|===|!==|==|!=|[^\s]/g;
  for (const match of text.matchAll(grammar)) {
    const raw = match[0];
    if (raw.startsWith('//') || raw.startsWith('/*')) continue;
    const literal = /^["'`]/.test(raw);
    const token = { raw, value: literal ? raw.slice(1, -1) : raw, literal, index: tokens.length, offset: match.index, parent: stack.at(-1) };
    tokens.push(token);
    if (['[', '(', '{'].includes(raw)) stack.push(token);
    if ([']', ')', '}'].includes(raw)) { const opening = stack.pop(); if (opening) opening.end = token.index; }
  }
  return tokens;
};
const classifyLiteral = (tokens, token) => {
  const parent = token.parent;
  const previous = tokens[token.index - 1];
  if ((previous?.raw === ':' && parent?.raw === '{') || previous?.raw === 'return' || ['===', '!==', '==', '!='].includes(previous?.raw)
    || ['===', '!==', '==', '!='].includes(tokens[token.index + 1]?.raw)) return 'passing';
  if (!parent || !['[', '('].includes(parent.raw)) return 'unclassified';
  const separators = tokens.slice(parent.index + 1, parent.end).filter((item) => item.parent === parent && item.raw === ',');
  const bounds = [parent.index, ...separators.map((item) => item.index), parent.end];
  const parts = bounds.slice(0, -1).map((start, index) => tokens.slice(start + 1, bounds[index + 1])).filter((part) => part.length);
  const position = parts.findIndex((part) => part.length === 1 && part[0] === token);
  if (position < 0) return 'unclassified';
  const values = parts.map((part) => part.length === 1 ? part[0].value : part.map((item) => item.raw).join(' '));
  const callee = tokens[parent.index - 1]?.raw;
  const assertion = parent.raw === '(' && tokens[parent.index - 3]?.raw === 'assert';
  const assertionList = parent.raw === '[' && tokens.slice(0, parent.index).some((item) =>
    item.raw === '(' && item.end > parent.index && tokens[item.index - 3]?.raw === 'assert' && tokens[item.index - 1]?.raw === 'deepEqual');
  const flags = values[position + 1]?.startsWith('-') || position === parts.length - 1;
  const command = token.value === 'submodule' ? ['add', 'update'].includes(values[position + 1])
    : token.value === 'clone' ? parts.length - position >= 3 : flags;
  const prefix = parts.slice(0, position);
  const globalOptions = (items) => items.length === 0 || (items.length === 1 && /^\.\.\. [\w$]+$/.test(items[0].map((item) => item.raw).join(' ')))
    || (items.length === 2 && items[0][0]?.value === '-c' && items[1].length === 1);
  const runnerOffsets = ({ g: [0, 1], gs: [0], git: [0, 1], gitIn: [1, 2] })[callee] ?? [];
  const runnerPrefix = runnerOffsets.some((offset) => prefix.length >= offset && globalOptions(prefix.slice(offset))
    && prefix.slice(0, offset).every((part) => part.length === 1 && /^[\w$]/.test(part[0].value)));
  const states = [
    ['passing', assertion || (assertionList && parts.length === 1)],
    ['passing', ['-m', '-qm'].includes(values[position - 1])],
    ['passing', parent.raw === '(' && /^make\w*Repo$/.test(callee ?? '')],
    ['passing', parent.raw === '(' && callee === 'git' && position === 0 && parts[1]?.[0]?.raw === '['],
    ['invoking', parent.raw === '[' && command && globalOptions(prefix) && !(assertionList && parts.length === 1)],
    ['invoking', parent.raw === '(' && command && (runnerPrefix
      || prefix.some((part, index) => part.length === 1 && part[0].value === 'git' && globalOptions(prefix.slice(index + 1))))],
    ['passing', parent.raw === '[' && values.slice(0, position).some((value) => /^@[^/]+\//.test(value))],
    ['passing', parent.raw === '[' && parts.every((part) => part.length === 1 && part[0].literal)
      && ((position > 0 && !['init', 'clone', 'submodule'].includes(values[0]) && !values[0].startsWith('-'))
        || (token.value === 'init' && parts.length > 1 && !flags))],
  ];
  return states.find(([, proven]) => proven)?.[0] ?? 'unclassified';
};
const census = (sources) => {
  const answer = { invoking: [], unclassified: [] };
  for (const { path, text } of sources) {
    const tokens = tokenize(text);
    for (const token of tokens.filter((item) => item.literal && ['init', 'clone', 'submodule'].includes(item.value))) {
      const state = classifyLiteral(tokens, token);
      if (state !== 'passing') answer[state].push({ path, line: text.slice(0, token.offset).split('\n').length });
    }
  }
  return answer;
};

describe('spec:fixture-isolation/S5 the invocation census', () => {
  it('classifies the shape table and reports the one unclassified literal', () => {
    const invoking = [
      "['init', '-q']", '[`init`]', '["clone", bare, other]', "g('init', '-q')",
      "git('setup', 'init', '-q')", "git(cwd, 'init', '-q')", "gitIn(root, env, 'init', '-q')",
      "sh(dir, 'git', 'init', '-q')", "[['init', '-q'], ['config', 'user.name', 'x']]",
      "git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add')", "[...IDENTITY, 'init', '-q', '--bare', cwd]",
    ];
    const passing = [
      "['commit', '-m', 'init']", "['commit', '-qm', 'submodule']", "['init', 'email', 'name']",
      "['binary', 'submodule', 'non-regular']", "assert.deepEqual([...(hit ? [] : ['init'])], [])",
      "({ event: 'init' })", "assert.equal(x.kind, 'submodule')", "return 'submodule'",
      "makeRepo('submodule')", "// 'init'\n/* 'clone' */", "assert.ok(ok, 'git init for the move lines')",
      "spawnSync('npx', ['@sabaiway/agent-workflow-kit@latest', 'init'])", '/git init .* failed/',
    ];
    const sources = [...invoking.map((text, index) => ({ path: `invoking-${index}.mjs`, text })),
      ...passing.map((text, index) => ({ path: `passing-${index}.mjs`, text })), { path: 'unknown.mjs', text: "\nconst word = 'init';" }];
    assert.deepEqual(census(sources), { invoking: invoking.map((_, index) => ({ path: `invoking-${index}.mjs`, line: 1 })),
      unclassified: [{ path: 'unknown.mjs', line: 2 }] });
  });
  it('finds no invoking source or unclassified literal in the tracked canonical tree', (test) => {
    const { env } = makeScope(test);
    const exempt = new Set(['scripts/testing/fixture-repo.mjs', 'codex-cli-bridge/bin/codex-fixtures-harness.test.mjs',
      'antigravity-cli-bridge/bin/agy-review-harness.test.mjs', 'scripts/testing/fixture-scopes.test.mjs']);
    const sources = listTracked(env).filter((path) => path.endsWith('.mjs') && !exempt.has(path)
      && !path.startsWith('agent-workflow-kit/bridges/') && !path.startsWith('agent-workflow-kit/references/scripts/')
      && path !== 'agent-workflow-kit/tools/payload-prune.mjs').map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
    const answer = census(sources);
    const message = Object.entries(answer).flatMap(([state, sites]) => sites.map(({ path, line }) => `${state} ${path}:${line}`)).join('\n');
    assert.deepEqual(answer, { invoking: [], unclassified: [] }, message);
  });
});

const commit = (run, directory) => run(['-C', directory, 'commit', '--allow-empty', '-qm', 'fixture']);
const readTrace = (path, command) => {
  const events = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const start = events.find((event) => event.event === 'start' && event.argv?.includes(command) && !event.argv.includes('maintenance'));
  assert.ok(start, `${path}: no ${command} start event`);
  return { events, start };
};
const checkQuietTrace = (path, command) => {
  const { events } = readTrace(path, command);
  assert.deepEqual(events.filter((event) => event.event === 'child_start' && event.argv?.includes('maintenance')), [], path);
};
describe('spec:fixture-isolation/S6 fixture commands start no maintenance child', () => {
  for (const module of ['./fixture-repo.mjs', '../../codex-cli-bridge/bin/codex-fixtures-harness.test.mjs',
    '../../antigravity-cli-bridge/bin/agy-review-harness.test.mjs']) it(`commits quietly with ${module}`, async (test) => {
    const { makeFixtureRepo } = await import(module);
    const { home, env } = makeScope(test);
    const trace = join(home, 'commit.trace');
    const run = (args) => runGit(home, env, args);
    const directory = makeFixtureRepo(run, join(home, 'repo'));
    commit((args) => runGit(home, { ...env, GIT_TRACE2_EVENT: trace }, args), directory);
    checkQuietTrace(trace, 'commit');
  });
  for (const mode of ['clone', 'add', 'update', 'push']) it(`${mode} repositories keep maintenance disabled`, async (test) => {
    const { makeFixtureRepo, cloneFixtureRepo, addFixtureSubmodule, updateFixtureSubmodules } = await import('./fixture-repo.mjs');
    const { home, env } = makeScope(test);
    const run = (args) => runGit(home, env, ['-c', 'protocol.file.allow=always', ...args]);
    const source = makeFixtureRepo(run, join(home, 'source'));
    commit(run, source);
    const trace = join(home, `${mode}.trace`);
    const traced = (args) => runGit(home, { ...env, GIT_TRACE2_EVENT: trace }, args);
    if (mode === 'push') {
      const bare = makeFixtureRepo(run, join(home, 'bare'), ['--bare']);
      traced(['-C', source, 'push', bare, 'HEAD:refs/heads/main']);
    } else if (mode === 'clone') {
      commit(traced, cloneFixtureRepo(run, source, join(home, 'clone')));
    } else {
      const superproject = makeFixtureRepo(run, join(home, 'super'));
      commit(run, superproject);
      const added = addFixtureSubmodule(run, superproject, source, 'vendor');
      run(['-C', superproject, 'commit', '-qam', 'gitlink']);
      const updated = mode === 'update' ? cloneFixtureRepo(run, superproject, join(home, 'copy')) : superproject;
      const submodule = mode === 'update' ? updateFixtureSubmodules(run, updated, ['--init'])[0] : added;
      assert.equal(run(['-C', submodule, 'config', '--local', 'maintenance.auto']).stdout.trim(), 'false');
      commit(traced, submodule);
    }
    checkQuietTrace(trace, mode === 'push' ? 'push' : 'commit');
  });
  it('control waits for its maintenance child before the commit exits', (test) => {
    const { home, env } = makeScope(test);
    const probe = spawnSync('git', ['maintenance', '-h'], { cwd: home, env, encoding: 'utf8', timeout: TIMEOUT });
    assert.ifError(probe.error);
    assert.equal(probe.signal, null);
    if (/is not a git command/.test(probe.stderr)) { test.skip('git maintenance is not a git command'); return; }
    assert.match(`${probe.stdout}${probe.stderr}`, /git maintenance/);
    const run = (args) => runGit(home, env, args);
    const directory = join(home, 'control');
    run(['init', '-q', directory]);
    run(['-C', directory, 'config', 'maintenance.auto', 'true']);
    run(['-C', directory, 'config', 'maintenance.autoDetach', 'false']);
    const trace = join(home, 'control.trace');
    commit((args) => runGit(home, { ...env, GIT_TRACE2_EVENT: trace }, args), directory);
    const { events, start } = readTrace(trace, 'commit');
    const child = events.find((event) => event.event === 'child_start' && event.sid === start.sid && event.argv?.includes('maintenance'));
    assert.ok(child, 'control: no maintenance child');
    const childExit = events.findIndex((event) => event.event === 'child_exit' && event.sid === child.sid && event.child_id === child.child_id);
    const exit = events.findIndex((event) => event.event === 'exit' && event.sid === start.sid);
    assert.ok(childExit >= 0 && exit > childExit, 'maintenance child ends before commit exits');
  });
});

it('spec:fixture-isolation/S11 the family walk ignores fixture scopes and reads untracked sources', async (test) => {
  const { makeFixtureRepo } = await import('./fixture-repo.mjs');
  const { home, env } = makeScope(test);
  const copy = makeFixtureRepo((args) => runGit(home, env, args), join(home, 'checkout'));
  for (const path of listTracked(env)) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    cpSync(join(ROOT, path), join(copy, path), { verbatimSymlinks: true });
  }
  runGit(copy, env, ['add', '--force', '.']);
  const ignore = readFileSync(join(ROOT, '.gitignore'));
  assert.deepEqual(readFileSync(join(copy, '.gitignore')), ignore);
  const ignored = join(copy, '.test-repos', 'without-git');
  mkdirSync(ignored, { recursive: true });
  assert.equal(existsSync(join(ignored, '.git')), false);
  const poison = join(ignored, 'stray-import.mjs');
  writeFileSync(poison, "import { fixtureScopeMissingExport } from '../../agent-workflow-memory/references/scripts/test-support/index.mjs';\n");
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  const runFamily = () => spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'agent-workflow-memory/references/scripts/family.test.mjs'],
    { cwd: copy, env: childEnv, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: GIT_MAX_BUFFER });
  const first = runFamily();
  assert.ifError(first.error);
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  assert.match(first.stdout, /# pass [1-9]\d*/);
  assert.match(first.stdout, /# fail 0\b/);
  mkdirSync(join(copy, 'scripts'), { recursive: true });
  renameSync(poison, join(copy, 'scripts/stray-import.mjs'));
  const stray = join(copy, 'scripts/stray-import.mjs');
  writeFileSync(stray, readFileSync(stray, 'utf8').replace('../../agent-workflow-memory/', '../agent-workflow-memory/'));
  assert.equal(runGit(copy, env, ['ls-files', '--others', '--exclude-standard', '--', 'scripts/stray-import.mjs']).stdout.trim(), 'scripts/stray-import.mjs');
  const second = runFamily();
  assert.ifError(second.error);
  assert.equal(second.signal, null);
  assert.equal(second.status, 1, `${second.stdout}${second.stderr}`);
  assert.match(`${second.stdout}${second.stderr}`, /test-support\/index\.mjs/);
  assert.deepEqual(readFileSync(join(copy, '.gitignore')), ignore);
});
