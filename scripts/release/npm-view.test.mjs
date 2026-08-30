import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runProcess } from './git-process.mjs';

const mod = await import('./npm-view.mjs').catch(() => ({}));
const { npmViewLatest, NPM_VIEW_ARGS, NPM_TRANSPORT_CODES } = mod;

const PACKAGE_NAME = '@sabaiway/agent-workflow-kit';
const DEADLINE_MS = 321;
const buildOkResult = (stdout) => ({ status: 0, stdout, stderr: '', error: null, signal: null });
const buildFailedResult = (extra = {}) => ({ status: 1, stdout: '', stderr: '', error: null, signal: null, ...extra });
const readWith = async (result, deadlineMs = DEADLINE_MS) => {
  const calls = [];
  const value = await npmViewLatest(PACKAGE_NAME, {
    deadlineMs,
    exec: async (command, argv, options) => {
      const configPath = argv.at(-1).slice('--globalconfig='.length);
      calls.push({ command, argv, options, config: readFileSync(configPath, 'utf8') });
      return result;
    },
  });
  return { value, call: calls[0] };
};

describe('npmViewLatest', () => {
  // spec:release-run/S1
  it('isolates npm view and accepts only the two version bodies', async () => {
    assert.equal(typeof npmViewLatest, 'function');
    assert.ok(Object.isFrozen(NPM_VIEW_ARGS));
    assert.deepEqual(NPM_VIEW_ARGS, ['view', 'version', '--json', '--registry=https://registry.npmjs.org/']);
    const previous = {
      proxy: process.env.HTTPS_PROXY,
      registry: process.env.NPM_CONFIG_REGISTRY,
      root: process.env.AGENT_WORKFLOW_ROOT,
      token: process.env.GH_TOKEN,
    };
    process.env.HTTPS_PROXY = 'http://proxy.test:8080';
    process.env.NPM_CONFIG_REGISTRY = 'https://redirect.invalid/';
    process.env.AGENT_WORKFLOW_ROOT = '/host/root';
    process.env.GH_TOKEN = 'secret';
    try {
      const scalar = await readWith(buildOkResult(JSON.stringify('10.5.0')));
      const array = await readWith(buildOkResult(JSON.stringify(['10.5.0'])));
      const object = await readWith(buildOkResult(JSON.stringify({ version: '10.5.0' })));
      const many = await readWith(buildOkResult(JSON.stringify(['10.5.0', '10.4.0'])));
      const malformed = await readWith(buildOkResult('<html>'));
      assert.deepEqual(scalar.value, { version: '10.5.0' });
      assert.deepEqual(array.value, { version: '10.5.0' });
      assert.ok(object.value.parseError);
      assert.ok(many.value.parseError);
      assert.ok(malformed.value.parseError);
      const { command, argv, options, config } = scalar.call;
      const emptyConfig = argv.at(-1).slice('--globalconfig='.length);
      assert.equal(command, 'npm');
      assert.deepEqual(argv, [
        'view', `${PACKAGE_NAME}@latest`, 'version', '--json',
        '--registry=https://registry.npmjs.org/',
        `--userconfig=${emptyConfig}`, `--globalconfig=${emptyConfig}`,
      ]);
      assert.equal(config, '');
      assert.equal(options.cwd, options.env.HOME);
      assert.equal(options.cwd, options.env.npm_config_cache);
      assert.equal(options.deadlineMs, DEADLINE_MS);
      assert.equal(options.env.HTTPS_PROXY, 'http://proxy.test:8080');
      assert.equal(options.env.NPM_CONFIG_REGISTRY, undefined);
      assert.equal(options.env.AGENT_WORKFLOW_ROOT, undefined);
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(existsSync(options.cwd), false);
    } finally {
      for (const [key, value] of Object.entries({
        HTTPS_PROXY: previous.proxy,
        NPM_CONFIG_REGISTRY: previous.registry,
        AGENT_WORKFLOW_ROOT: previous.root,
        GH_TOKEN: previous.token,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // spec:release-run/S2
  it('maps an npm JSON HTTP code to its numeric status', async () => {
    assert.equal(typeof npmViewLatest, 'function');
    const stdout = await readWith(buildFailedResult({ stdout: JSON.stringify({ error: { code: 'E404' } }) }));
    const stderr = await readWith(buildFailedResult({ stderr: JSON.stringify({ error: { code: 'E503' } }) }));
    assert.deepEqual(stdout.value, { httpError: 404 });
    assert.deepEqual(stderr.value, { httpError: 503 });
  });

  // spec:release-run/S3
  it('reports only deadline kills and the closed errno list as transport errors', async () => {
    assert.equal(typeof npmViewLatest, 'function');
    assert.ok(Object.isFrozen(NPM_TRANSPORT_CODES));
    assert.deepEqual(NPM_TRANSPORT_CODES, [
      'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
      'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EPROTO',
      'FETCH_ERROR', 'ERR_SOCKET_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ]);
    const timeout = await readWith(buildFailedResult({ status: null, signal: 'SIGTERM', killedByDeadline: true }), 47);
    assert.deepEqual(timeout.value, { transportError: 'timeout after 47ms' });
    for (const code of NPM_TRANSPORT_CODES) {
      const result = await readWith(buildFailedResult({ error: Object.assign(new Error(code), { code }) }));
      assert.deepEqual(result.value, { transportError: code });
    }
    for (const code of NPM_TRANSPORT_CODES) {
      const envelope = await readWith(buildFailedResult({ stdout: JSON.stringify({ error: { code } }) }));
      assert.deepEqual(envelope.value, { transportError: code });
    }
  });

  // spec:release-run/S4
  it('throws a named local npm failure for every other nonzero shape', async () => {
    assert.equal(typeof npmViewLatest, 'function');
    const cases = [
      buildFailedResult({ error: Object.assign(new Error('read only'), { code: 'EROFS' }) }),
      buildFailedResult({ error: Object.assign(new Error('denied'), { code: 'EACCES' }) }),
      buildFailedResult({ error: Object.assign(new Error('full'), { code: 'ENOSPC' }) }),
      buildFailedResult({ stderr: 'npm failed without JSON' }),
      buildFailedResult({ stdout: JSON.stringify({ error: { code: 'EUNKNOWN' } }) }),
      buildFailedResult({ status: null, signal: 'SIGTERM', killedByDeadline: false }),
      buildFailedResult({ status: null, signal: 'SIGKILL' }),
    ];
    for (const result of cases) {
      await assert.rejects(() => readWith(result), /^Error: local npm failure: /);
    }
    await assert.rejects(
      () => npmViewLatest(PACKAGE_NAME, { deadlineMs: DEADLINE_MS, exec: async () => { throw new Error('injected throw'); } }),
      /local npm failure: injected throw/,
    );
  });

  it('the default exec marks a kill as killedByDeadline only when its own deadline delivered it', async () => {
    const killed = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { deadlineMs: 50, escalationMs: 50 });
    assert.equal(killed.status, null);
    assert.equal(killed.killedByDeadline, true);
    const exited = await runProcess(process.execPath, ['-e', 'process.exit(3)'], { deadlineMs: 5000 });
    assert.deepEqual([exited.status, exited.killedByDeadline], [3, false]);
    const missing = await runProcess('/nonexistent/npm-view-probe', [], { deadlineMs: 5000 });
    assert.deepEqual([missing.status, missing.killedByDeadline], [null, false]);
    const raw = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]))'], { deadlineMs: 5000, encoding: null });
    assert.deepEqual([Buffer.isBuffer(raw.stdout), [...raw.stdout]], [true, [0xff, 0xfe, 0x0a]]);
    const isolated = await runProcess(process.execPath, ['-e', 'process.stdout.write(`${process.env.HOME} ${process.env.NPM_CONFIG_REGISTRY}`)'], { env: { PATH: process.env.PATH, HOME: '/npm-view-home' }, deadlineMs: 5000 });
    assert.equal(isolated.stdout, '/npm-view-home undefined');
  });
});
