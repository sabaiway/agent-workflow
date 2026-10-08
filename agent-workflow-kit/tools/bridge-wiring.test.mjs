import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_HONORS_QUALIFIER } from './velocity-profile.mjs';

const wiring = await import('./bridge-wiring.mjs').catch((cause) => new Proxy({}, {
  get: (_, name) => {
    if (name === 'then') return undefined;
    throw new Error(`bridge-wiring.mjs unavailable: ${String(name)}`, { cause });
  },
}));
const QUALIFIER = 'where the host honors the settings sandbox keys';
const EXPECTED = {
  HOST_HONORS_QUALIFIER: QUALIFIER,
  WIRED: 'wired', UNWIRED: 'not wired', UNCHECKED: 'unchecked',
  WIRING_ROUTE: 'wire it on the chat yes of /agent-workflow-kit upgrade',
  WIRING_ROUTE_UNUSED: 'no slot uses it for review — once one does, the chat yes of /agent-workflow-kit upgrade wires it',
  SANDBOX_ENABLED_CONDITION: `enabled in the project settings — ready means wired ${QUALIFIER}`,
  SANDBOX_NOT_ENABLED_CONDITION: 'not enabled in the project settings — ready means installed',
};
const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const READY_STATE = 'ready';
const COVERED = 'covered';
const NOT_COVERED = 'not covered';
const COUNCIL = 'council';
const REVIEWED = 'reviewed';
const UTF8 = 'utf8';
const MANIFEST = 'capability.json';
const PROJECT_FILE = '.claude/settings.json';
const LOCAL_FILE = '.claude/settings.local.json';
const CONFIG_FILE = 'docs/ai/orchestration.json';
const BUNDLE_ROOT = fileURLToPath(new URL('../bridges', import.meta.url));
const CODEX_MANIFEST = join(BUNDLE_ROOT, CODEX, MANIFEST);
const readJson = (path) => JSON.parse(readFileSync(path, UTF8));
const CODEX_HOSTS = readJson(CODEX_MANIFEST).networkHosts;
const AGY_HOSTS = readJson(join(BUNDLE_ROOT, AGY, MANIFEST)).networkHosts;
const HOSTS = [...new Set([...AGY_HOSTS, ...CODEX_HOSTS])];
const CODEX_DIR = '~/.codex';
const AGY_DIR = '~/.gemini/antigravity-cli';
const CODEX_REVIEW = 'codex-review *';
const CODEX_EXEC = 'codex-exec *';
const AGY_REVIEW = 'agy-review *';
const REVIEW_EXCLUSIONS = [CODEX_REVIEW, AGY_REVIEW];
const ZERO = 0;
const ONE = 1;
const BAD = 'x';
const BAD_ENABLED = 'yes';
const EXECUTION = 'plan-execution';
const TEXT_TYPE = 'string';
const DENIED = 'EACCES';
const PROJECT_PATTERN = /settings\.json/;
const LOCAL_PATTERN = /settings\.local\.json/;
const ENABLED_PATTERN = /enabled/;
const CODEX_PATTERN = /codex-cli-bridge/;
const WRITE_PATTERN = /allowWrite/;
const EMPTY_TEXT = '';
const INVALID_JSON = '{ not json';
const READY = [CODEX, AGY].map((name) => ({ name, readiness: READY_STATE }));
const signedOut = () => READY.map((row) => ({
  ...row, readiness: row.name === AGY ? 'needs-credentials' : READY_STATE,
}));
const reviewConfig = (review) => Object.fromEntries(
  ['plan-authoring', EXECUTION, 'feedback-triage', 'epic'].map((key) => [key, { review }]),
);
const withExecute = (review) => ({
  ...reviewConfig(review), [EXECUTION]: { review, execute: 'delegated' },
});
const emptyDelta = () => ({ excludedCommands: [], hosts: [], dirs: [] });
const makeSandbox = (excludedCommands, hosts, dirs) => ({
  enabled: true, excludedCommands, network: { allowedDomains: hosts }, filesystem: { allowWrite: dirs },
});
const FULL = makeSandbox([...REVIEW_EXCLUSIONS, CODEX_EXEC], HOSTS, [CODEX_DIR, AGY_DIR]);
const ENABLED = { sandbox: { enabled: true } };
const DISABLED = { sandbox: { enabled: false } };
const EMPTY_SANDBOX = { sandbox: {} };
const writeData = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === TEXT_TYPE ? data : JSON.stringify(data));
};
const makeProject = (t, settings = {}, config = reviewConfig(COUNCIL), local) => {
  const base = mkdtempSync(join(tmpdir(), 'bridge-wiring-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(home);
  writeData(join(root, PROJECT_FILE), settings);
  if (local !== undefined) {
    writeData(join(root, LOCAL_FILE), local);
  }
  if (config !== undefined) {
    writeData(join(root, CONFIG_FILE), config);
  }
  return { root, home };
};
const compose = (fixture, readiness = READY, deps = {}) => wiring.composeBridgeWiring(
  { root: fixture.root, readiness }, { home: fixture.home, env: {}, bundleRoot: BUNDLE_ROOT, ...deps },
);
const NOT_REGULAR_PATTERN = /settings\.json: not a regular file/;
const CHILD_TIMEOUT_MS = 10000;
const CHILD_JUDGE = [
  "import fs from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "import { syncBuiltinESMExports } from 'node:module';",
  'const { WIRING_URL, SETTINGS_PATH, ROOT, HOME, SWAP } = process.env;',
  'const original = fs.readFileSync;',
  'fs.readFileSync = (target, ...rest) => {',
  "  if (SWAP && target === SETTINGS_PATH) { fs.rmSync(target); spawnSync('mkfifo', [target]); }",
  '  return original(target, ...rest);',
  '};',
  'syncBuiltinESMExports();',
  'const { composeBridgeWiring } = await import(WIRING_URL);',
  "const readiness = [{ name: 'codex-cli-bridge', readiness: 'ready' }];",
  'process.stdout.write(JSON.stringify(composeBridgeWiring({ root: ROOT, readiness }, { home: HOME, env: {} })));',
].join('\n');
const judgeInChild = (fixture, swap) => spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_JUDGE], {
  encoding: UTF8,
  timeout: CHILD_TIMEOUT_MS,
  env: {
    ...process.env,
    WIRING_URL: new URL('./bridge-wiring.mjs', import.meta.url).href,
    SETTINGS_PATH: join(fixture.root, PROJECT_FILE),
    ROOT: fixture.root,
    HOME: fixture.home,
    SWAP: swap ? '1' : EMPTY_TEXT,
  },
});
const assertWired = (entry) => {
  assert.equal(entry.state, EXPECTED.WIRED);
  assert.deepEqual(entry.missing, emptyDelta());
  assert.equal(entry.count, ZERO);
  assert.equal(entry.reason, null);
  assert.equal(entry.route, null);
};

it('exports the fixed wiring literals and the shared host qualifier', () => {
  Object.entries(EXPECTED).forEach(([name, value]) => assert.equal(wiring[name], value));
  assert.equal(wiring.HOST_HONORS_QUALIFIER, HOST_HONORS_QUALIFIER);
});

describe('spec:velocity-profile/S13 sandboxEnabled', () => {
  it('uses the local boolean override or the project boolean, defaulting to false', () => {
    const rows = [
      [ENABLED, DISABLED, false], [DISABLED, ENABLED, true], [ENABLED, undefined, true],
      [ENABLED, {}, true], [ENABLED, EMPTY_SANDBOX, true], [DISABLED, undefined, false],
      [undefined, undefined, false], [EMPTY_SANDBOX, EMPTY_SANDBOX, false],
    ];
    rows.forEach(([project, local, expected]) => assert.equal(wiring.sandboxEnabled(project, local), expected));
  });
  it('rejects malformed sandbox objects and non-boolean enabled values naming their source', () => {
    const rows = [
      [ENABLED, { sandbox: BAD }, [LOCAL_PATTERN]],
      [{ sandbox: true }, ENABLED, [PROJECT_PATTERN]],
      [{ sandbox: { enabled: 'true' } }, undefined, [PROJECT_PATTERN, ENABLED_PATTERN]],
      [{ sandbox: { enabled: BAD_ENABLED } }, undefined, [PROJECT_PATTERN, ENABLED_PATTERN]],
      [undefined, { sandbox: { enabled: ONE } }, [LOCAL_PATTERN, ENABLED_PATTERN]],
    ];
    const sandboxEnabled = wiring.sandboxEnabled;
    for (const [project, local, patterns] of rows) {
      assert.throws(() => sandboxEnabled(project, local), (error) => {
        patterns.forEach((pattern) => assert.match(error.message, pattern));
        return true;
      });
    }
  });
});

describe('spec:velocity-profile/S14 sandboxSurfaceDelta', () => {
  it('compares exact surfaces in recipe order, covers dirs by segment and refuses malformed keys', (t) => {
    const recipe = { excludedCommands: [CODEX_REVIEW, CODEX_EXEC], hosts: ['a.example', 'b.example'], dirs: [AGY_DIR] };
    const fixture = makeProject(t, {}, undefined, { sandbox: makeSandbox(recipe.excludedCommands, recipe.hosts, recipe.dirs) });
    const present = makeSandbox(['codex-review', CODEX_EXEC], [recipe.hosts[ONE]], ['~/.gemini']);
    const reversed = Object.fromEntries(Object.entries(recipe).map(([key, values]) => [key, [...values].reverse()]));
    const malformed = [
      [{ excludedCommands: BAD }, /excludedCommands/], [{ network: BAD }, /network/],
      [{ network: [] }, /network/], [{ network: { allowedDomains: BAD } }, /allowedDomains/],
      [{ filesystem: BAD }, /filesystem/], [{ filesystem: { allowWrite: BAD } }, WRITE_PATTERN],
      ...[ONE, null, EMPTY_TEXT, '  '].map((entry) => [{ filesystem: { allowWrite: [entry] } }, WRITE_PATTERN]),
    ];
    const delta = wiring.sandboxSurfaceDelta;
    const missing = { excludedCommands: [CODEX_REVIEW], hosts: [recipe.hosts[ZERO]], dirs: [] };
    assert.deepEqual(delta(recipe, present, fixture), missing);
    assert.deepEqual(delta(recipe, { ...present, filesystem: { allowWrite: ['~/.gemini-old'] } }, fixture), {
      ...missing, dirs: recipe.dirs,
    });
    [undefined, {}].forEach((sandbox) => assert.deepEqual(delta(recipe, sandbox, fixture), recipe));
    assert.deepEqual(delta(reversed, undefined, fixture), reversed);
    malformed.forEach(([sandbox, pattern]) => assert.throws(() => delta(recipe, sandbox, fixture), pattern));
  });
});

describe('spec:velocity-profile/S15 composeBridgeWiring', () => {
  it('without sandbox enabled wires only ready bridges without manifest reads or preflight', (t) => {
    const fixture = makeProject(t);
    const reads = [];
    const directories = [];
    const preflights = [];
    const deps = {
      readFile: (path, ...args) => {
        reads.push(path);
        return readFileSync(path, ...args);
      },
      readdir: (path, ...args) => {
        directories.push(path);
        return readdirSync(path, ...args);
      },
      preflight: () => preflights.push(true),
    };
    const result = compose(fixture, READY, deps);
    assert.equal(result.enabled, false);
    assert.equal(result.condition, EXPECTED.SANDBOX_NOT_ENABLED_CONDITION);
    assert.equal(result.reason, null);
    assert.deepEqual(result.bridges.map((entry) => entry.bridge), [CODEX, AGY]);
    for (const entry of result.bridges) {
      assertWired(entry);
      assert.equal(entry.review, COVERED);
      assert.equal(entry.reviewRoute, null);
    }
    assert.deepEqual(compose(fixture, signedOut(), deps).bridges.map((entry) => entry.bridge), [CODEX]);
    assert.equal(reads.some((path) => path.endsWith(MANIFEST)), false);
    assert.equal(directories.includes(BUNDLE_ROOT), false);
    assert.equal(preflights.length, ZERO);
  });
  it('with every enabled surface wires both bridges and calls preflight once', (t) => {
    const fixture = makeProject(t, { sandbox: FULL });
    const calls = [];
    const result = compose(fixture, READY, { preflight: () => calls.push(true) });
    assert.equal(result.enabled, true);
    assert.equal(result.condition, EXPECTED.SANDBOX_ENABLED_CONDITION);
    assert.equal(result.reason, null);
    assert.deepEqual(result.bridges.map((entry) => entry.bridge), [CODEX, AGY]);
    for (const entry of result.bridges) {
      assertWired(entry);
      assert.equal(entry.review, COVERED);
      assert.equal(entry.reviewRoute, null);
    }
    assert.equal(calls.length, ONE);
  });
  it('lists three missing codex execute surfaces while agy stays wired', (t) => {
    const absentHost = 'chatgpt.com';
    const sandbox = makeSandbox(REVIEW_EXCLUSIONS, HOSTS.filter((host) => host !== absentHost), [AGY_DIR]);
    const fixture = makeProject(t, { sandbox }, withExecute(COUNCIL));
    const [codex, agy] = compose(fixture).bridges;
    assert.equal(codex.bridge, CODEX);
    assert.equal(codex.state, EXPECTED.UNWIRED);
    assert.deepEqual(codex.missing, { excludedCommands: [CODEX_EXEC], hosts: [absentHost], dirs: [CODEX_DIR] });
    assert.equal(codex.count, 3);
    assert.equal(codex.used, true);
    assert.equal(codex.route, EXPECTED.WIRING_ROUTE);
    assert.equal(agy.bridge, AGY);
    assertWired(agy);
  });
  it('wires execute alone while the unused codex review remains uncovered', (t) => {
    const sandbox = makeSandbox([CODEX_EXEC], CODEX_HOSTS, [CODEX_DIR]);
    const fixture = makeProject(t, { sandbox }, withExecute('solo'));
    const result = compose(fixture, signedOut());
    assert.equal(result.bridges.length, ONE);
    const [codex] = result.bridges;
    assertWired(codex);
    assert.equal(codex.review, NOT_COVERED);
    assert.equal(codex.reviewRoute, EXPECTED.WIRING_ROUTE_UNUSED);
  });
  it('judges a ready unused agy on review and gives both unused routes', (t) => {
    const sandbox = makeSandbox([CODEX_REVIEW], CODEX_HOSTS, [CODEX_DIR]);
    const fixture = makeProject(t, { sandbox }, reviewConfig(REVIEWED));
    const [codex, agy] = compose(fixture).bridges;
    assertWired(codex);
    assert.equal(agy.bridge, AGY);
    assert.equal(agy.state, EXPECTED.UNWIRED);
    assert.equal(agy.used, false);
    assert.equal(agy.route, EXPECTED.WIRING_ROUTE_UNUSED);
    assert.equal(agy.review, NOT_COVERED);
    assert.equal(agy.reviewRoute, EXPECTED.WIRING_ROUTE_UNUSED);
  });
  it('does not count a state dir or exclusion supplied only by the local settings', (t) => {
    const sandbox = makeSandbox([], CODEX_HOSTS, []);
    const local = { sandbox: makeSandbox([CODEX_REVIEW], [], [CODEX_DIR]) };
    const fixture = makeProject(t, { sandbox }, reviewConfig(REVIEWED), local);
    const [codex] = compose(fixture).bridges;
    assert.equal(codex.state, EXPECTED.UNWIRED);
    assert.deepEqual(codex.missing, { excludedCommands: [CODEX_REVIEW], hosts: [], dirs: [CODEX_DIR] });
    assert.equal(codex.route, EXPECTED.WIRING_ROUTE);
    assert.equal(codex.reviewRoute, EXPECTED.WIRING_ROUTE);
  });
  it('leaves every ready bridge and review unchecked for all eight derivation refusals', (t) => {
    const rows = [
      { patterns: [/bypassPermissions/], deps: { preflight: () => {
        throw new Error('bypassPermissions appears in Claude settings - refusing because it auto-approves Bash');
      } } },
      { patterns: [/orchestration\.json/], config: INVALID_JSON },
      { patterns: [CODEX_PATTERN], deps: { readdir: (path) => path === BUNDLE_ROOT ? [AGY] : readdirSync(path) } },
      { patterns: [CODEX_PATTERN, /review/], deps: { readFile: (path, ...args) =>
        path === CODEX_MANIFEST ? '{}' : readFileSync(path, ...args) } },
      { patterns: [CODEX_PATTERN, /capability\.json/], deps: { readFile: (path, ...args) => {
        if (path === CODEX_MANIFEST) {
          throw Object.assign(new Error(`${DENIED}: fixture`), { code: DENIED });
        }
        return readFileSync(path, ...args);
      } } },
      { patterns: [/CODEX_HOME/], homeOverride: true },
      { patterns: [PROJECT_PATTERN], settings: INVALID_JSON },
      { patterns: [PROJECT_PATTERN, ENABLED_PATTERN], settings: { sandbox: { enabled: BAD_ENABLED } } },
    ].map((row) => ({ ...row, fixture: makeProject(t, row.settings ?? ENABLED, row.config ?? reviewConfig(REVIEWED)) }));
    for (const { fixture, deps, homeOverride, patterns } of rows) {
      const result = compose(fixture, READY, { ...deps, env: homeOverride ? { CODEX_HOME: fixture.home } : {} });
      assert.equal(result.enabled, null);
      assert.match(result.condition, /^unchecked — /);
      assert.equal(typeof result.reason, TEXT_TYPE);
      assert.doesNotMatch(result.reason, /[\r\n]/);
      patterns.forEach((pattern) => assert.match(result.reason, pattern));
      assert.deepEqual(result.bridges.map((entry) => entry.bridge), [CODEX, AGY]);
      for (const entry of result.bridges) {
        assert.equal(entry.state, EXPECTED.UNCHECKED);
        assert.equal(entry.review, EXPECTED.UNCHECKED);
        assert.equal(entry.route, null);
        assert.equal(entry.reviewRoute, null);
        assert.equal(entry.reason, result.reason);
      }
    }
  });
  it('a settings path that is no regular file renders unchecked naming the file', (t) => {
    const fixture = makeProject(t, ENABLED);
    rmSync(join(fixture.root, PROJECT_FILE));
    mkdirSync(join(fixture.root, PROJECT_FILE));
    const result = compose(fixture);
    assert.equal(result.enabled, null);
    assert.match(result.reason, NOT_REGULAR_PATTERN);
    assert.deepEqual(result.bridges.map((entry) => entry.state), [EXPECTED.UNCHECKED, EXPECTED.UNCHECKED]);
  });
  it('a FIFO settings file, present or swapped in at the read, never blocks the judgement', (t) => {
    const probe = spawnSync('mkfifo', [join(tmpdir(), `bridge-wiring-probe-${process.pid}`)]);
    if (probe.status !== ZERO) return t.skip('mkfifo is unavailable on this host');
    rmSync(join(tmpdir(), `bridge-wiring-probe-${process.pid}`), { force: true });
    const present = makeProject(t, ENABLED);
    rmSync(join(present.root, PROJECT_FILE));
    assert.equal(spawnSync('mkfifo', [join(present.root, PROJECT_FILE)]).status, ZERO);
    const fifo = judgeInChild(present, false);
    assert.equal(fifo.signal, null, 'the judgement blocked on the FIFO');
    assert.match(JSON.parse(fifo.stdout).reason, NOT_REGULAR_PATTERN);
    const swapped = judgeInChild(makeProject(t, ENABLED), true);
    assert.equal(swapped.signal, null, 'the judgement blocked on a FIFO swapped in before a path read');
    assert.equal(JSON.parse(swapped.stdout).enabled, true);
  });
});
