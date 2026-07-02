import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
  INSTALL_CMD,
  INSTALL_ARGS,
  buildSanitizedEnv,
  matchExpectations,
  runCli,
} from './smoke-init.mjs';

// ── env sanitization (the isolation contract) ─────────────────────────────────────────

describe('buildSanitizedEnv — the smoke can never read or mutate host installs', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/real-user',
    AGENT_WORKFLOW_ENGINE_DIR: '/home/real-user/.claude/skills/engine',
    AGENT_WORKFLOW_KIT_CHANNEL: 'dev',
    CODEX_MODEL: 'gpt-x',
    AGY_REVIEW_TIMEOUT: '600',
    npm_config_cache: '/home/real-user/.npm',
    NPM_CONFIG_USERCONFIG: '/home/real-user/.npmrc-custom',
    NPM_CONFIG_PREFIX: '/home/real-user/.npm-global',
    npm_config_registry: 'https://host-mirror.example',
    LANG: 'en_US.UTF-8',
  };

  it('strips AGENT_WORKFLOW_* and *_MODEL / *_TIMEOUT overrides; keeps neutral vars', () => {
    const env = buildSanitizedEnv(base, { home: '/tmp/h', npmCache: '/tmp/c' });
    assert.equal(env.AGENT_WORKFLOW_ENGINE_DIR, undefined);
    assert.equal(env.AGENT_WORKFLOW_KIT_CHANNEL, undefined);
    assert.equal(env.CODEX_MODEL, undefined);
    assert.equal(env.AGY_REVIEW_TIMEOUT, undefined);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.LANG, 'en_US.UTF-8');
  });

  it('strips EVERY npm config env override, both cases — the smoke must never read host npm config', () => {
    const env = buildSanitizedEnv(base, { home: '/tmp/h', npmCache: '/tmp/c' });
    assert.equal(env.NPM_CONFIG_USERCONFIG, undefined, 'an explicit userconfig would bypass the temp HOME');
    assert.equal(env.NPM_CONFIG_PREFIX, undefined);
    assert.equal(env.npm_config_registry, undefined);
    assert.equal(env.npm_config_cache, '/tmp/c', 'the sandbox cache is set AFTER stripping, never the host one');
  });

  it('repoints HOME and the npm cache INTO the sandbox (never the real ones)', () => {
    const env = buildSanitizedEnv(base, { home: '/tmp/h', npmCache: '/tmp/c' });
    assert.equal(env.HOME, '/tmp/h');
    assert.equal(env.npm_config_cache, '/tmp/c');
  });
});

describe('matchExpectations — substring per line', () => {
  it('reports the matched line verbatim and null for a miss', () => {
    const results = matchExpectations('a\nkit 1.27.0 installed\nb', ['kit 1.27.0', 'nope']);
    assert.equal(results[0].matched, 'kit 1.27.0 installed');
    assert.equal(results[1].matched, null);
  });
});

// ── the CLI against a stubbed installer (the real npx run happens only at release) ─────

const runStubbed = (argv, { stdout = '', stderr = '', status = 0 } = {}) => {
  const out = [];
  const err = [];
  const seen = {};
  const code = runCli(argv, {
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
    baseEnv: { PATH: '/usr/bin', HOME: '/home/real-user', AGENT_WORKFLOW_X: 'leak' },
    exec: (cmd, args, { cwd, env }) => {
      Object.assign(seen, { cmd, args, cwd, env });
      return { status, stdout, stderr };
    },
  });
  return { code, out, err, seen, text: [...out, ...err].join('\n') };
};

describe('runCli — stubbed installer fixture', () => {
  it('runs the pinned npx command inside the sandbox with the sanitized env', () => {
    const { code, seen } = runStubbed(['--expect-line', 'ready'], { stdout: 'kit ready\n' });
    assert.equal(code, 0);
    assert.equal(seen.cmd, INSTALL_CMD);
    assert.deepEqual(seen.args, [...INSTALL_ARGS]);
    assert.ok(seen.cwd.startsWith(tmpdir()), 'project dir is a temp sandbox');
    assert.ok(seen.env.HOME.startsWith(tmpdir()), 'HOME is a temp sandbox, never the host HOME');
    assert.equal(seen.env.AGENT_WORKFLOW_X, undefined, 'family override stripped');
  });

  it('all expectations matched → exit 0, matched lines echoed verbatim', () => {
    const { code, text } = runStubbed(
      ['--expect-line', 'kit 1.27.0', '--expect-line', 'engine 1.10.0'],
      { stdout: 'installed kit 1.27.0 ok\ninstalled engine 1.10.0 ok\n' },
    );
    assert.equal(code, 0);
    assert.match(text, /✓ installed kit 1\.27\.0 ok/);
    assert.match(text, /PASS — all 2 expectation/);
  });

  it('a missed expectation → exit 1, MISSING named, full output dumped', () => {
    const { code, text } = runStubbed(['--expect-line', 'engine 1.10.0'], { stdout: 'only kit here\n' });
    assert.equal(code, 1);
    assert.match(text, /MISSING expected line containing: "engine 1\.10\.0"/);
    assert.match(text, /full captured output/);
    assert.match(text, /only kit here/);
  });

  it('an installer non-zero exit → exit 1 even when expectations match', () => {
    const { code, text } = runStubbed(['--expect-line', 'ready'], { stdout: 'ready\n', status: 3 });
    assert.equal(code, 1);
    assert.match(text, /installer exited 3/);
  });

  it('expectations are also matched against stderr (npx warnings land there)', () => {
    const { code } = runStubbed(['--expect-line', 'warned'], { stderr: 'npx warned about x\n' });
    assert.equal(code, 0);
  });

  it('usage: no --expect-line → exit 2 (a smoke with no expectations proves nothing)', () => {
    const { code, text } = runStubbed([]);
    assert.equal(code, 2);
    assert.match(text, /at least one --expect-line/);
  });
});
