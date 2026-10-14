import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runGitProcess } from './git-process.mjs';
import { makeWorld, ROOT } from './release-run-harness.test.mjs';
import { EXIT } from './release-stages.mjs';

const mod = await import('./release-run.mjs').catch(() => ({}));
const READ_ARGV = ['--no-pager', 'config', '--no-includes', '--show-scope', '-z', '--get-regexp',
  '^(http\\.(.+\\.)?proxyauthmethod|credential\\.(.+\\.)?helper)$'];
const PROXY_VARIABLES = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
const METHOD_KEY = 'http.proxyauthmethod';
const RESET_KEY = 'credential.http://localhost:3128.helper';
const PROXY_ENV = { https_proxy: 'http://u:t@localhost:3128' };
const CHANNEL_KEYS = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
const METHOD_ENTRIES = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: METHOD_KEY, GIT_CONFIG_VALUE_0: 'basic' };
const CAPTURED_ENTRIES = { ...METHOD_ENTRIES, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: RESET_KEY, GIT_CONFIG_VALUE_1: '' };
const CAPTURED_BYTES = Buffer.from('local\0credential.https://github.com/sabaiway/agent-workflow.git.helper\n/opt/local-helper.sh\0command\0http.proxyauthmethod\nbasic\0command\0credential.http://localhost:3128.helper\n\0');
const WARN_PREFIX = 'release-run: the git transport config was not carried — ';
const FIFO_DEADLINE_MS = 3000;
const makeResult = (overrides = {}) => ({ status: 0, stdout: CAPTURED_BYTES, stderr: '', error: null, signal: null, killedByDeadline: false, ...overrides });
const encodeRecord = (scope, key, value) => Buffer.from(`${scope}\0${key}${value === null ? '' : `\n${value}`}\0`);
const METHOD_BYTES = encodeRecord('command', METHOD_KEY, 'basic');
const makeRead = (result = makeResult()) => {
  const calls = [];
  const warnings = [];
  return { calls, warnings, options: { cwd: ROOT, warn: (line) => warnings.push(line),
    git: async (argv, options) => { calls.push({ argv, options }); return result; } } };
};
const createGitFixture = async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'git-transport-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: mkdtempSync(join(cwd, 'home-')),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (argv, options) => runGitProcess(argv, options);
  const init = await git(['init', '-q'], { cwd, env });
  assert.equal(init.error, null);
  assert.equal(init.status, 0, String(init.stderr));
  const warnings = [];
  return { cwd, env, git, warnings, warn: (line) => warnings.push(line) };
};
const getConfigEntries = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('GIT_CONFIG')));
const makeTransportWorld = (proxy = true) => {
  const inherited = { PATH: '/bin', GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=basic' 'credential.http://localhost:3128.helper='",
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hookspath', GIT_CONFIG_VALUE_0: '/evil',
    GIT_CONFIG: '/hostile', GIT_CONFIG_GLOBAL: '/hostile', GIT_CONFIG_NOSYSTEM: '0',
    ...Object.fromEntries(GIT_LOCATION_VARS.map((key) => [key, '/elsewhere'])), ...(proxy ? PROXY_ENV : {}) };
  const world = makeWorld({ transport: (options) => makeResult({ status:
    CHANNEL_KEYS.every((key) => options.env[key] === inherited[key])
      && GIT_LOCATION_VARS.every((key) => !Object.hasOwn(options.env, key))
      && !Object.hasOwn(options.env, 'GIT_CONFIG') && options.env.GIT_CONFIG_GLOBAL === '/dev/null'
      && options.env.GIT_CONFIG_NOSYSTEM === '1' && options.cwd === ROOT && options.encoding === null ? 0 : 1 }) });
  world.deps.env = inherited;
  return world;
};

// spec:release-run/S19
test('S19 constants match the confined read interface exactly', async () => {
  const expected = { READ_ARGV, PROXY_VARIABLES, GIT_LOCATION_VARS };
  const leaf = await import('./git-transport-config.mjs');
  for (const [name, value] of Object.entries(expected)) {
    assert.deepEqual(leaf[name], value);
    assert.equal(Object.isFrozen(leaf[name]), true);
  }
});

test('S19 readEnv confines file locations and preserves the inherited channel without mutation', async () => {
  const inherited = { PATH: '/bin', GIT_CONFIG: '/x', GIT_CONFIG_GLOBAL: '/hostile', GIT_CONFIG_NOSYSTEM: '0',
    GIT_CONFIG_SYSTEM: '/system', GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=basic'", GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hookspath', GIT_CONFIG_VALUE_0: '/evil',
    ...Object.fromEntries(GIT_LOCATION_VARS.map((key) => [key, '/elsewhere'])) };
  const before = { ...inherited };
  const expected = { PATH: inherited.PATH, GIT_CONFIG_SYSTEM: '/system', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    ...Object.fromEntries(CHANNEL_KEYS.map((key) => [key, inherited[key]])) };
  const leaf = await import('./git-transport-config.mjs');
  const actual = leaf.readEnv(inherited);
  assert.deepEqual(actual, expected);
  assert.notEqual(actual, inherited);
  assert.deepEqual(inherited, before);
});

for (const [name, inherited, expected] of [
  ['with the proxy', PROXY_ENV, CAPTURED_ENTRIES], ['without a proxy', {}, METHOD_ENTRIES],
]) test(`S19 captured sandbox records ${name}`, async () => {
  const read = makeRead();
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(await leaf.carryTransportConfig(inherited, read.options), expected);
  assert.deepEqual(read.calls, [{ argv: READ_ARGV, options: { cwd: ROOT, env: leaf.readEnv(inherited), encoding: null } }]);
  assert.deepEqual(read.warnings, []);
});

test('S19 dropped records leave the carried method intact', async () => {
  const rows = [
    ['another URL', { https_proxy: 'http://u:t@localhost:3129' }, encodeRecord('command', RESET_KEY, '')],
    ['generic reset', PROXY_ENV, encodeRecord('command', 'credential.helper', '')],
    ['non-empty helper', PROXY_ENV, encodeRecord('command', RESET_KEY, 'store')],
    ['valueless helper', PROXY_ENV, encodeRecord('command', RESET_KEY, null)],
    ['whitespace helper', PROXY_ENV, encodeRecord('command', RESET_KEY, ' ')],
    ['local method', PROXY_ENV, encodeRecord('local', METHOD_KEY, 'digest')],
    ['global method', PROXY_ENV, encodeRecord('global', METHOD_KEY, 'ntlm')],
    ['null SOCKS origin', { ALL_PROXY: 'socks5://h:1080' }, encodeRecord('command', 'credential.null.helper', '')],
    ['empty proxy', { http_proxy: '' }, encodeRecord('command', RESET_KEY, '')],
    ['unparsable proxy', { https_proxy: 'not a url' }, encodeRecord('command', RESET_KEY, '')],
    ['non-UTF-8 key', PROXY_ENV, Buffer.concat([Buffer.from('command\0http.'), Buffer.from([0xff]), Buffer.from('.proxyauthmethod\nbasic\0')])],
    ['non-UTF-8 value', PROXY_ENV, Buffer.concat([Buffer.from(`command\0${METHOD_KEY}\n`), Buffer.from([0xff, 0])])],
  ].map(([name, env, bytes]) => ({ name, env, read: makeRead(makeResult({ stdout: Buffer.concat([METHOD_BYTES, bytes]) })) }));
  const leaf = await import('./git-transport-config.mjs');
  for (const { name, env, read } of rows) {
    assert.deepEqual(await leaf.carryTransportConfig(env, read.options), METHOD_ENTRIES, name);
    assert.deepEqual(read.warnings, [], name);
  }
});

test('S19 values and subsection case are verbatim and duplicate methods retain their order', async () => {
  const rows = [
    [METHOD_KEY, 'BASIC'], [METHOD_KEY, 'basic\nx'], ['http.https://GitHub.COM/.proxyauthmethod', 'basic'],
  ].map(([key, value]) => ({ key, value, read: makeRead(makeResult({ stdout: encodeRecord('command', key, value) })) }));
  const ordered = makeRead(makeResult({ stdout: Buffer.concat([
    encodeRecord('command', METHOD_KEY, 'digest'), encodeRecord('command', METHOD_KEY, 'ntlm'),
  ]) }));
  const leaf = await import('./git-transport-config.mjs');
  for (const { key, value, read } of rows) {
    assert.deepEqual(await leaf.carryTransportConfig({}, read.options), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value });
    assert.deepEqual(read.warnings, []);
  }
  assert.deepEqual(await leaf.carryTransportConfig({}, ordered.options), { GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: METHOD_KEY, GIT_CONFIG_VALUE_0: 'digest', GIT_CONFIG_KEY_1: METHOD_KEY, GIT_CONFIG_VALUE_1: 'ntlm' });
  assert.deepEqual(ordered.warnings, []);
});

test('S19 parser distinguishes valueless records, empty output and malformed framing', async () => {
  const valued = encodeRecord('command', METHOD_KEY, 'basic\nx');
  const valueless = encodeRecord('command', RESET_KEY, null);
  const malformed = ['command\0key', 'command\0key\0odd\0', '\0key\nvalue\0', 'command\0\0'];
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(leaf.parseRecords(Buffer.alloc(0)), []);
  assert.deepEqual(leaf.parseRecords(Buffer.concat([valued, valueless])), [
    { scope: 'command', key: METHOD_KEY, value: 'basic\nx' }, { scope: 'command', key: RESET_KEY, value: null },
  ]);
  assert.deepEqual(leaf.parseRecords(valued.toString()), [{ scope: 'command', key: METHOD_KEY, value: 'basic\nx' }]);
  for (const bytes of malformed) assert.equal(leaf.parseRecords(Buffer.from(bytes)), null);
});

test('S19 every failure carries nothing and warns once with one redacted line', async () => {
  const rows = [
    [{ error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) }, 'ENOENT'],
    [{ status: null, signal: 'SIGTERM', killedByDeadline: true }, 'signal SIGTERM'],
    [{ stdout: Buffer.from('command\0key') }, 'exit 0: the output did not parse'],
    [{ stdout: Buffer.from('command\0key\0odd\0') }, 'exit 0: the output did not parse'],
    [{ status: 128, stderr: 'error: invalid key: url.https://tok:SE@CRET@github.com/.insteadOf x\nfatal: unable to parse command-line config\n' },
      'exit 128: error: invalid key: url.https://<redacted>/.insteadOf x'],
    [{ status: 128, stderr: 'error: invalid key (newline): http.https://tok:SECRET\n@host.proxyauthmethod\n' },
      'exit 128: error: invalid key (newline): http.https://<redacted>'],
    [{ status: 128, stderr: 'fatal: bad\u2028config\nsecond line' }, 'exit 128: fatal: bad?config'],
    [{ status: 128, stderr: 'fatal: bad\u0001\u007f\u0085\u2029config' }, 'exit 128: fatal: bad????config'],
  ].map(([result, cause]) => ({ cause, read: makeRead(makeResult(result)) }));
  const leaf = await import('./git-transport-config.mjs');
  for (const { cause, read } of rows) {
    assert.deepEqual(await leaf.carryTransportConfig(PROXY_ENV, read.options), {}, cause);
    assert.deepEqual(read.warnings, [WARN_PREFIX + cause]);
    assert.doesNotMatch(read.warnings[0], /SE|CRET|\n|[\u0000-\u001f\u007f\u0085\u2028\u2029]/u);
    assert.equal(read.calls.length, 1);
  }
});

test('S19 exit one carries nothing without a warning', async () => {
  const read = makeRead(makeResult({ status: 1, stdout: Buffer.alloc(0) }));
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(await leaf.carryTransportConfig(PROXY_ENV, read.options), {});
  assert.deepEqual(read.warnings, []);
  assert.equal(read.calls.length, 1);
});

for (const [name, channel, expected] of [
  ['old PARAMETERS', { GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=digest'" }, { ...METHOD_ENTRIES, GIT_CONFIG_VALUE_0: 'digest' }],
  ['new PARAMETERS', { GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod'='digest'" }, { ...METHOD_ENTRIES, GIT_CONFIG_VALUE_0: 'digest' }],
  ['COUNT', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxyAuthMethod', GIT_CONFIG_VALUE_0: 'ntlm' }, { ...METHOD_ENTRIES, GIT_CONFIG_VALUE_0: 'ntlm' }],
  ['conflicting channels', { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.proxyAuthMethod', GIT_CONFIG_VALUE_0: 'digest',
    GIT_CONFIG_KEY_1: 'http.proxyAuthMethod', GIT_CONFIG_VALUE_1: 'ntlm', GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=basic'" },
    { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: METHOD_KEY, GIT_CONFIG_VALUE_0: 'digest',
      GIT_CONFIG_KEY_1: METHOD_KEY, GIT_CONFIG_VALUE_1: 'ntlm', GIT_CONFIG_KEY_2: METHOD_KEY, GIT_CONFIG_VALUE_2: 'basic' }],
]) test(`S19 real git reads ${name}`, async (t) => {
  const fixture = await createGitFixture(t);
  const inherited = { ...fixture.env, ...channel };
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(await leaf.carryTransportConfig(inherited, fixture), expected);
  assert.deepEqual(fixture.warnings, []);
});

for (const kind of ['regular file', 'FIFO']) test(`S19 real git ignores a channel include of a ${kind}`, async (t) => {
  const fixture = await createGitFixture(t);
  const include = join(fixture.cwd, 'included-config');
  if (kind === 'FIFO') execFileSync('mkfifo', [include], { cwd: fixture.cwd, env: fixture.env });
  else writeFileSync(include, '[http]\n\tproxyAuthMethod = negotiate\n');
  const inherited = { ...fixture.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: include,
    GIT_CONFIG_KEY_1: 'http.proxyAuthMethod', GIT_CONFIG_VALUE_1: 'basic' };
  const git = (argv, options) => runGitProcess(argv, { ...options, deadlineMs: FIFO_DEADLINE_MS });
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(await leaf.carryTransportConfig(inherited, { ...fixture, git }), METHOD_ENTRIES);
  assert.deepEqual(fixture.warnings, []);
});

test('S19 real git ignores malformed global and system files beside the channel', async (t) => {
  const fixture = await createGitFixture(t);
  const global = join(fixture.cwd, 'bad-global');
  const system = join(fixture.cwd, 'bad-system');
  writeFileSync(global, '[invalid\n');
  writeFileSync(system, '[invalid\n');
  const inherited = { ...fixture.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: system, GIT_CONFIG_NOSYSTEM: '0',
    GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=basic'" };
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(await leaf.carryTransportConfig(inherited, fixture), METHOD_ENTRIES);
  assert.deepEqual(fixture.warnings, []);
});

test('S19 real git round-trips a special subsection and the proxy reset in order', async (t) => {
  const fixture = await createGitFixture(t);
  const key = "http.https://GitHub.COM/a= b'\\c.proxyauthmethod";
  const inherited = { ...fixture.env, ...PROXY_ENV, GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: 'BASIC', GIT_CONFIG_KEY_1: RESET_KEY, GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'core.hookspath', GIT_CONFIG_VALUE_2: '/evil' };
  const expected = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: 'BASIC',
    GIT_CONFIG_KEY_1: RESET_KEY, GIT_CONFIG_VALUE_1: '' };
  const leaf = await import('./git-transport-config.mjs');
  const carried = await leaf.carryTransportConfig(inherited, fixture);
  assert.deepEqual(carried, expected);
  assert.deepEqual(fixture.warnings, []);
  const reread = await fixture.git(READ_ARGV, { cwd: fixture.cwd, env: { ...fixture.env, ...carried }, encoding: null });
  assert.equal(reread.error, null);
  assert.equal(reread.status, 0, String(reread.stderr));
  assert.deepEqual(leaf.parseRecords(reread.stdout), [
    { scope: 'command', key, value: 'BASIC' }, { scope: 'command', key: RESET_KEY, value: '' },
  ]);
});

// spec:release-run/S20
for (const proxy of [true, false]) test(`S20 START carries exactly the transport records ${proxy ? 'with' : 'without'} a proxy`, async () => {
  const world = makeTransportWorld(proxy);
  assert.equal(await mod.runRelease(world.args(), world.deps), EXIT.ok);
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(world.calls.git[0], leaf.READ_ARGV);
  assert.equal(world.calls.git.filter((argv) => argv[0] === '--no-pager' && argv[1] === 'config').length, 1);
  assert.equal(world.calls.order.filter((entry) => entry.startsWith('git:'))[0], `git:${READ_ARGV.join(' ')}`);
  for (const stage of ['preflight-remote', 'push', 'live']) {
    const child = world.calls.exec.find((call) => call.stage === stage);
    assert.deepEqual(getConfigEntries(child.options.env), proxy ? CAPTURED_ENTRIES : METHOD_ENTRIES, stage);
  }
  assert.deepEqual(world.errors, []);
});

test('S20 plan reads the inherited transport channel exactly once', async () => {
  const world = makeTransportWorld();
  assert.equal(await mod.runRelease(world.args({ plan: true, approved: null }), world.deps), EXIT.ok);
  const leaf = await import('./git-transport-config.mjs');
  assert.deepEqual(world.calls.git[0], leaf.READ_ARGV);
  assert.equal(world.calls.git.filter((argv) => argv[0] === '--no-pager' && argv[1] === 'config').length, 1);
  assert.deepEqual(world.calls.exec, []);
  assert.deepEqual(world.errors, []);
});

test('S20 usage errors never read transport config and print only the usage line', async () => {
  const world = makeTransportWorld();
  const exit = await mod.runRelease(['--bogus'], world.deps);
  const leaf = await import('./git-transport-config.mjs');
  assert.equal(exit, EXIT.usage);
  assert.deepEqual(world.errors, [mod.USAGE]);
  assert.deepEqual(world.logs, []);
  assert.deepEqual(world.calls.git, []);
  assert.equal(world.calls.git.some((argv) => argv[0] === leaf.READ_ARGV[0]), false);
  assert.deepEqual(world.calls.exec, []);
});
