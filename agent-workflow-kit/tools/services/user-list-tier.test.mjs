import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundledSandboxRecipe } from '../bridge-sandbox-recipe.mjs';
import { main, EXPECTED_WORKFLOW_VERSION, WORKFLOW_STAMP } from '../velocity-profile.mjs';
import { ACTIVITIES } from '../recipes.mjs';
import { GROUNDING_TOOL } from '../procedures.mjs';

const USER_SERVICES = {
  acme: { hosts: ['api.acme.example'], writableDirs: [{ env: 'ACME_HOME', default: '~/.acme' }],
    excludedCommands: ['acme *'], passedVariables: ['ACME_TOKEN'], billingVariables: ['ACME_BILLING_KEY'], runReachesHosts: true },
  beta: { hosts: ['*.beta.example'], writableDirs: [], excludedCommands: [], passedVariables: [],
    billingVariables: [], runReachesHosts: false },
};
const CODEX_HOSTS = ['chatgpt.com', '*.chatgpt.com', 'api.typesafe.ai', 'docs.typesafe.ai'];
const GOOGLE_HOSTS = ['*.googleapis.com', 'accounts.google.com', 'antigravity-unleash.goog', 'lh3.googleusercontent.com'];
const createTemp = (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'awf-user-list-tier-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value));
const createProject = (context, council) => {
  const temporary = createTemp(context);
  const cwd = join(temporary, 'project');
  const home = join(temporary, 'home');
  mkdirSync(join(cwd, 'docs/ai'), { recursive: true });
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, WORKFLOW_STAMP), `${EXPECTED_WORKFLOW_VERSION}\n`);
  const config = Object.fromEntries(Object.entries(ACTIVITIES).map(([activity, definition]) => [activity,
    Object.fromEntries(Object.entries(definition.slots).map(([slot, type]) => [slot, type === 'switch' ? 'off' : council && type === 'review' ? 'council' : 'solo'])),
  ]));
  writeJson(join(cwd, 'docs/ai/orchestration.json'), config);
  const settings = join(cwd, '.claude/settings.json');
  writeJson(settings, { permissions: { allow: [] } });
  const configHome = council ? join(temporary, 'xdg') : join(home, '.config');
  const file = join(configHome, 'agent-workflow/services.json');
  mkdirSync(dirname(file), { recursive: true });
  const writes = [];
  return { cwd, file, settings, writes, deps: {
    home, env: { HOME: home, PATH: '', ...(council ? { XDG_CONFIG_HOME: configHome } : {}) },
    detect: () => ['antigravity-cli-bridge', 'codex-cli-bridge'].map((name) => ({ name, readiness: 'ready' })),
    findWrapper: () => true,
    writeFile: (path, ...args) => { writes.push(path); writeFileSync(path, ...args); },
  } };
};
const runMain = (fixture, argv) => {
  const stdout = [];
  const stderr = [];
  const code = main([...argv, '--cwd', fixture.cwd], { ...fixture.deps,
    log: (line) => stdout.push(line), errlog: (line) => stderr.push(line) });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
};

it('spec:services/S14 the tier merges user services, stops on refusal, and keeps absent-list and advisory output', async (context) => {
  await context.test('execute adds the user lists after codex services', () => {
    const file = join(createTemp(context), 'services.json');
    writeJson(file, USER_SERVICES);
    const recipe = bundledSandboxRecipe([{ bridge: 'codex-cli-bridge', roles: ['execute'] }], { userServicesFile: file });
    assert.deepEqual(recipe, {
      allow: [], excludedCommands: ['codex-exec *', 'acme *'],
      hosts: [...CODEX_HOSTS, 'api.acme.example', '*.beta.example'],
      dirEntries: [{ env: 'CODEX_HOME', default: '~/.codex' }, { env: 'ACME_HOME', default: '~/.acme' }], skips: [],
    });
  });
  await context.test('review merges after the first bridge in manifest-name order and keeps each value once', () => {
    const file = join(createTemp(context), 'services.json');
    writeJson(file, USER_SERVICES);
    const recipe = bundledSandboxRecipe([
      { bridge: 'codex-cli-bridge', roles: ['review'] }, { bridge: 'antigravity-cli-bridge', roles: ['review'] },
    ], { userServicesFile: file, groundingAbsPath: '/kit/tools/grounding.mjs' });
    assert.deepEqual(recipe, {
      allow: ['Bash(agy-review code:*)', 'Bash(node "/kit/tools/grounding.mjs":*)', 'Bash(codex-review code:*)'],
      excludedCommands: ['agy-review *', 'acme *', 'codex-review *'],
      hosts: [...GOOGLE_HOSTS, 'api.typesafe.ai', 'docs.typesafe.ai', 'api.acme.example', '*.beta.example', 'chatgpt.com', '*.chatgpt.com'],
      dirEntries: [{ env: null, default: '~/.gemini/antigravity-cli' }, { env: 'ACME_HOME', default: '~/.acme' },
        { env: 'CODEX_HOME', default: '~/.codex' }], skips: [],
    });
  });
  await context.test('no used bridge adds no user value', () => {
    const file = join(createTemp(context), 'services.json');
    writeJson(file, USER_SERVICES);
    assert.deepEqual(bundledSandboxRecipe([], { userServicesFile: file }), {
      allow: [], excludedCommands: [], hosts: [], dirEntries: [], skips: [],
    });
  });
  await context.test('absent list preserves the council and delegated recipe byte for byte', () => {
    const recipe = bundledSandboxRecipe([
      { bridge: 'antigravity-cli-bridge', roles: ['review'] }, { bridge: 'codex-cli-bridge', roles: ['review', 'execute'] },
    ], { userServicesFile: join(createTemp(context), 'absent.json'), groundingAbsPath: '/kit/tools/grounding.mjs' });
    assert.equal(JSON.stringify(recipe), JSON.stringify({
      allow: ['Bash(agy-review code:*)', 'Bash(node "/kit/tools/grounding.mjs":*)', 'Bash(codex-review code:*)'],
      excludedCommands: ['agy-review *', 'codex-review *', 'codex-exec *'],
      hosts: ['*.googleapis.com', 'accounts.google.com', 'antigravity-unleash.goog', 'lh3.googleusercontent.com',
        'api.typesafe.ai', 'docs.typesafe.ai', 'chatgpt.com', '*.chatgpt.com'],
      dirEntries: [{ env: null, default: '~/.gemini/antigravity-cli' }, { env: 'CODEX_HOME', default: '~/.codex' }], skips: [],
    }));
  });
  for (const council of [true, false]) {
    for (const argv of [['--bridge-tier'], ['--apply', '--bridge-tier']]) {
      await context.test(`${council ? 'council' : 'no used bridge'} ${argv.join(' ')} refuses the list before writing`, () => {
        const fixture = createProject(context, council);
        writeFileSync(fixture.file, '{');
        const before = readFileSync(fixture.settings);
        const result = runMain(fixture, argv);
        assert.equal(result.code, 1, result.stderr);
        assert.ok(result.stderr.includes(fixture.file), result.stderr);
        assert.deepEqual(readFileSync(fixture.settings), before);
        assert.deepEqual(fixture.writes, []);
      });
    }
  }
  await context.test('flagless advisory with every wrapper placed ignores an unparsable list', () => {
    const fixture = createProject(context, true);
    writeJson(fixture.settings, { permissions: { allow: [
      'Bash(codex-review code:*)', 'Bash(agy-review code:*)', `Bash(node "${GROUNDING_TOOL}":*)`,
    ] } });
    assert.equal(existsSync(fixture.file), false);
    const absent = runMain(fixture, []);
    assert.equal(absent.code, 0, absent.stderr);
    assert.doesNotMatch(absent.stdout, /pre-existing non-read-only Bash allow entries/);
    writeFileSync(fixture.file, '{');
    assert.deepEqual(runMain(fixture, []), absent);
    assert.deepEqual(fixture.writes, []);
  });
});
