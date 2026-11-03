import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { refreshPlacedBridges } from '../setup-backends.mjs';
import { validateManifest } from '../manifest/validate.mjs';

const services = await import('./index.mjs').catch(() => ({}));
const BUNDLED_CODEX = fileURLToPath(new URL('../../bridges/codex-cli-bridge/', import.meta.url));
const EXPECTED_FRAGMENTS = {
  codex: {
    hosts: ['chatgpt.com', '*.chatgpt.com'],
    writableDirs: [{ env: 'CODEX_HOME', default: '~/.codex' }],
    excludedCommands: [], passedVariables: [], runReachesHosts: false,
  },
  antigravity: {
    hosts: ['*.googleapis.com', 'accounts.google.com', 'antigravity-unleash.goog', 'lh3.googleusercontent.com'],
    writableDirs: [{ env: null, default: '~/.gemini/antigravity-cli' }],
    excludedCommands: [], passedVariables: [], runReachesHosts: false,
  },
  jev: {
    hosts: ['api.typesafe.ai', 'docs.typesafe.ai'], writableDirs: [], excludedCommands: [],
    passedVariables: ['TYPESAFE_API_KEY'], runReachesHosts: true,
  },
};
const createTemp = (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'awf-services-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const denyRead = () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };

it('spec:services/S1 loads exactly the three bundled fragments', () => {
  assert.deepEqual(services.loadServiceFragments(), EXPECTED_FRAGMENTS);
});

it('spec:services/S2 refuses every unreadable or invalid fragment without returning a partial set', async (context) => {
  assert.equal(typeof services.loadServiceFragments, 'function');
  const temporary = createTemp(context);
  const valid = EXPECTED_FRAGMENTS.codex;
  const cases = [
    { name: 'absent directory', directory: 'absent' },
    { name: 'unreadable directory', directory: 'unreadable', deps: { readdir: denyRead } },
    { name: 'unreadable file', deps: { readFile: (path, encoding) => {
      if (basename(path) === 'z-bad.json') return denyRead();
      return readFileSync(path, encoding);
    } } },
    { name: 'unparsable JSON', raw: '{' },
    ...[null, [], 'x'].map((value) => ({ name: `root ${JSON.stringify(value)}`, value })),
    { name: 'unknown key', key: 'surprise', value: { ...valid, surprise: [] } },
    ...Object.keys(valid).map((key) => ({
      name: `missing ${key}`, key, value: Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key)),
    })),
    ...['hosts', 'writableDirs', 'excludedCommands', 'passedVariables'].map((key) => ({
      name: `non-array ${key}`, key, value: { ...valid, [key]: 'x' },
    })),
    { name: 'malformed host', key: 'hosts', value: { ...valid, hosts: ['bad host'] } },
    ...['~/.cache/*', '~/.cache/', '~/.cache/../other', 'relative/cache', '~/.cache/line\nbreak'].map((path) => ({
      name: `invalid directory ${JSON.stringify(path)}`, key: 'writableDirs',
      value: { ...valid, writableDirs: [{ env: null, default: path }] },
    })),
    { name: 'lowercase directory env', key: 'writableDirs',
      value: { ...valid, writableDirs: [{ env: 'lower_case', default: '~/.cache' }] } },
    ...['* *', ' *', 'a;b *', 'tool', 'tool*', 'tool  *'].map((command) => ({
      name: `invalid command ${JSON.stringify(command)}`, key: 'excludedCommands',
      value: { ...valid, excludedCommands: [command] },
    })),
    { name: 'lowercase passed variable', key: 'passedVariables', value: { ...valid, passedVariables: ['lower_case'] } },
    { name: 'proxy variable always scrubbed', key: 'passedVariables', value: { ...valid, passedVariables: ['OPENAI_BASE_URL'] } },
    { name: 'run-reachable wildcard', key: 'hosts', value: { ...valid, hosts: ['*.example.com'], runReachesHosts: true } },
    { name: 'non-boolean reachability', key: 'runReachesHosts', value: { ...valid, runReachesHosts: 'yes' } },
    { name: 'repeated host', key: 'hosts', value: { ...valid, hosts: ['x.example', 'x.example'] } },
    { name: 'repeated command', key: 'excludedCommands', value: { ...valid, excludedCommands: ['tool *', 'tool *'] } },
    { name: 'repeated variable', key: 'passedVariables', value: { ...valid, passedVariables: ['KEY', 'KEY'] } },
    { name: 'repeated directory default', key: 'writableDirs', value: { ...valid,
      writableDirs: [{ env: 'FIRST', default: '~/.cache' }, { env: 'SECOND', default: '~/.cache' }],
    } },
  ];
  for (const [index, refusal] of cases.entries()) {
    await context.test(refusal.name, () => {
      const servicesDir = join(temporary, String(index));
      if (refusal.directory !== 'absent') {
        mkdirSync(servicesDir);
        writeJson(join(servicesDir, 'codex.json'), valid);
        if (!refusal.directory) {
          writeFileSync(join(servicesDir, 'z-bad.json'), refusal.raw ?? JSON.stringify(refusal.value ?? null));
        }
      }
      const returned = [];
      assert.throws(() => returned.push(services.loadServiceFragments({ servicesDir, ...refusal.deps })), (error) => {
        assert.ok(error.message.includes(refusal.directory ? servicesDir : 'z-bad.json'), refusal.name);
        if (refusal.key) assert.ok(error.message.includes(refusal.key), refusal.name);
        return true;
      }, refusal.name);
      assert.deepEqual(returned, [], `${refusal.name}: no partial set returned`);
    });
  }
});

it('spec:services/S3 merges real and injected services in id order with first-value deduplication', () => {
  const fragments = services.loadServiceFragments();
  assert.deepEqual(services.mergeServices(['codex', 'jev'], fragments), {
    hosts: ['chatgpt.com', '*.chatgpt.com', 'api.typesafe.ai', 'docs.typesafe.ai'],
    dirEntries: [{ env: 'CODEX_HOME', default: '~/.codex' }], excludedCommands: [],
    passedVariables: ['TYPESAFE_API_KEY'], runHosts: ['api.typesafe.ai', 'docs.typesafe.ai'],
  });
  assert.deepEqual(services.mergeServices(['antigravity', 'jev'], fragments), {
    hosts: ['*.googleapis.com', 'accounts.google.com', 'antigravity-unleash.goog',
      'lh3.googleusercontent.com', 'api.typesafe.ai', 'docs.typesafe.ai'],
    dirEntries: [{ env: null, default: '~/.gemini/antigravity-cli' }], excludedCommands: [],
    passedVariables: ['TYPESAFE_API_KEY'], runHosts: ['api.typesafe.ai', 'docs.typesafe.ai'],
  });
  const injected = {
    a: {
      hosts: ['a.example', 'shared.example'],
      writableDirs: [{ env: 'A_DIR', default: '~/shared' }],
      excludedCommands: ['a-tool *', 'shared-tool *'], passedVariables: ['A_KEY', 'SHARED_KEY'],
      runReachesHosts: true,
    },
    b: {
      hosts: ['b.example', 'shared.example'],
      writableDirs: [{ default: '~/shared', env: 'Z_DIR' }, { env: 'A_DIR', default: '~/shared' },
        { env: 'PAIR_DIR', default: '/srv/a' }],
      excludedCommands: ['b-tool *', 'shared-tool *'], passedVariables: ['B_KEY', 'SHARED_KEY'],
      runReachesHosts: true,
    },
    c: {
      hosts: ['z.example', 'shared.example'],
      writableDirs: [{ env: 'Z_DIR', default: '~/shared' }, { env: 'PAIR_DIR', default: '/srv/z' }],
      excludedCommands: ['z-tool *', 'shared-tool *'], passedVariables: ['Z_KEY', 'SHARED_KEY'],
      runReachesHosts: false,
    },
  };
  assert.deepEqual(services.mergeServices(['c', 'b', 'a'], injected), {
    hosts: ['z.example', 'shared.example', 'b.example', 'a.example'],
    dirEntries: [{ env: 'Z_DIR', default: '~/shared' }, { env: 'PAIR_DIR', default: '/srv/z' },
      { env: 'A_DIR', default: '~/shared' }, { env: 'PAIR_DIR', default: '/srv/a' }],
    excludedCommands: ['z-tool *', 'shared-tool *', 'b-tool *', 'a-tool *'],
    passedVariables: ['Z_KEY', 'SHARED_KEY', 'B_KEY', 'A_KEY'],
    runHosts: ['b.example', 'shared.example', 'a.example'],
  });
  assert.throws(() => services.mergeServices(['nope'], fragments), /nope/);
});

it('spec:services/S4 renders exact facts text recoverable by bash without node', (context) => {
  const merged = {
    hosts: ['z.example', 'a.example'], runHosts: ['z.example', 'a.example'],
    dirEntries: [{ env: 'Z_DIR', default: '~/z-cache' }, { env: null, default: '/srv/a=cache' }],
    excludedCommands: ['z-tool *', 'a-tool *'], passedVariables: ['Z_KEY', 'A_KEY'],
  };
  const text = services.renderServiceFacts(merged);
  assert.equal(services.SERVICE_FACTS_FILE, 'service-facts.txt');
  assert.equal(text, [
    "# generated from the kit's service fragments (agent-workflow-kit/tools/services/); do not edit",
    'HOST=z.example', 'HOST=a.example', 'RUN_HOST=z.example', 'RUN_HOST=a.example',
    'WRITABLE_DIR=Z_DIR:~/z-cache', 'WRITABLE_DIR=:/srv/a=cache',
    'EXCLUDED_COMMAND=z-tool *', 'EXCLUDED_COMMAND=a-tool *',
    'PASSED_VARIABLE=Z_KEY', 'PASSED_VARIABLE=A_KEY', '',
  ].join('\n'));
  const factsPath = join(createTemp(context), 'service-facts.txt');
  writeFileSync(factsPath, text);
  const bash = ['/bin/bash', '/usr/bin/bash'].find((path) => existsSync(path));
  assert.ok(bash, 'an absolute bash executable exists');
  const script = [
    'while IFS= read -r line; do',
    '  case "$line" in "#"*|"") continue ;; esac',
    '  key=${line%%=*}',
    '  value=${line#*=}',
    '  printf "%s\\t%s\\n" "$key" "$value"',
    'done < "$1"',
  ].join('\n');
  const result = spawnSync(bash, ['-c', script, 'read-facts', factsPath], { env: { PATH: '' }, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const recovered = { hosts: [], runHosts: [], dirEntries: [], excludedCommands: [], passedVariables: [] };
  const keys = { HOST: 'hosts', RUN_HOST: 'runHosts', WRITABLE_DIR: 'dirEntries',
    EXCLUDED_COMMAND: 'excludedCommands', PASSED_VARIABLE: 'passedVariables' };
  for (const line of result.stdout.trimEnd().split('\n')) {
    const separator = line.indexOf('\t');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    assert.ok(Object.hasOwn(keys, key), key);
    if (key === 'WRITABLE_DIR') {
      const colon = value.indexOf(':');
      recovered.dirEntries.push({ env: value.slice(0, colon) || null, default: value.slice(colon + 1) });
    } else recovered[keys[key]].push(value);
  }
  assert.deepEqual(recovered, merged);
});

it('spec:services/S7 refreshes a placed pre-services bridge to the bundle services and facts', (context) => {
  const temporary = createTemp(context);
  const bundleRoot = join(temporary, 'bundles');
  const bundleDir = join(bundleRoot, 'codex-cli-bridge');
  const skillDir = join(temporary, 'skill');
  const copyOptions = { recursive: true, filter: (path) => basename(path) !== 'node_modules' };
  cpSync(BUNDLED_CODEX, bundleDir, copyOptions);
  cpSync(BUNDLED_CODEX, skillDir, copyOptions);
  const manifestPath = join(skillDir, 'capability.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const olderVersion = '0.9.0';
  writeFileSync(join(skillDir, 'SKILL.md'), readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    .replace(/^(\s+version:)\s*[^\n]+/m, `$1 '${olderVersion}'`));
  manifest.version = olderVersion;
  manifest.networkHosts = ['chatgpt.com', '*.chatgpt.com', 'api.typesafe.ai', 'docs.typesafe.ai'];
  manifest.writableDirs = [{ env: 'CODEX_HOME', default: '~/.codex' }];
  delete manifest.services;
  writeJson(manifestPath, manifest);
  rmSync(join(skillDir, 'service-facts.txt'), { force: true });
  const deps = {
    home: join(temporary, 'home'), getenv: { CODEX_CLI_BRIDGE_DIR: skillDir, PATH: '' },
    bundleRoot, bindir: join(temporary, 'bin'), platform: 'linux',
    detect: () => ({
      name: 'codex-cli-bridge', manifestState: 'ok',
      cli: { bin: 'codex', state: 'present', path: '/usr/bin/codex' },
      credentials: { state: 'present', path: '/c/auth.json' },
      wrappers: [], readiness: 'ready', setupHint: { url: 'u' }, skillDir,
    }),
  };
  const [result] = refreshPlacedBridges(deps, ['codex-cli-bridge']);
  assert.equal(result.outcome, 'refreshed', result.line);
  const report = validateManifest(skillDir);
  assert.equal(report.result, 'valid');
  assert.deepEqual(report.errors, []);
  const placed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(placed.services, ['codex', 'jev']);
  assert.equal(Object.hasOwn(placed, 'networkHosts'), false);
  assert.equal(Object.hasOwn(placed, 'writableDirs'), false);
  assert.deepEqual(readFileSync(join(skillDir, 'service-facts.txt')), readFileSync(join(bundleDir, 'service-facts.txt')));
});
