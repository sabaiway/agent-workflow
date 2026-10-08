import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecommendations, main as advisorMain, probeJevConnect } from '../recommendations.mjs';

// The place rule and the guide are loaded dynamically, so the suite loads on a tree without them and each cell fails at its first call.
const facts = await import('../jev-facts.mjs').catch(() => ({}));
const placeOf = facts.placeOf ?? (() => { throw new Error('placeOf is absent'); });
const connectLine = facts.connectLine ?? (() => { throw new Error('connectLine is absent'); });
const guideMain = (await import('../jev-guide.mjs').catch(() => ({}))).main ?? (() => { throw new Error('main is absent'); });
const lanes = await import('../write-lanes.mjs').catch(() => ({}));
const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_TOOLS = '/kit tools/dir';
const userStep = () => `your own step — it asks for the key in your terminal and the key never goes into the chat — run in a terminal of your own: node ${facts.quoteArg(join(TOOLS, 'jev-connect.mjs'))}`;
const BS = '\\';
const CONTAINER = 'a terminal inside this container';
const SSH = 'a terminal on SSH host build-7';
const PLACE_WORDS = /#|PowerShell|WSL|SSH|container|terminal/;
// HOME and CLAUDE_CONFIG_DIR ride the same save-and-restore, so a default route never reads the real skill roots.
const PLACE_ENV = ['WSL_DISTRO_NAME', 'SSH_CONNECTION', 'REMOTE_CONTAINERS', 'CODESPACES', 'TYPESAFE_API_KEY', 'HOME', 'CLAUDE_CONFIG_DIR'];
// [name, env, platform, hostname, container, the place]
const CELLS = [
  ['win32 whatever else is set', { WSL_DISTRO_NAME: 'Ubuntu', SSH_CONNECTION: '1 2 3 4', CODESPACES: 'true' }, 'win32', 'build-7', true, 'a PowerShell terminal'],
  ['a WSL distro wins over a set SSH_CONNECTION', { WSL_DISTRO_NAME: 'Ubuntu', SSH_CONNECTION: '1 2 3 4' }, 'linux', 'build-7', false, 'the WSL distro Ubuntu terminal'],
  ['SSH_CONNECTION with a hostname', { SSH_CONNECTION: '1 2 3 4' }, 'linux', 'build-7', false, SSH],
  ['REMOTE_CONTAINERS set', { REMOTE_CONTAINERS: 'true' }, 'linux', 'build-7', false, CONTAINER],
  ['CODESPACES set', { CODESPACES: 'true' }, 'linux', 'build-7', false, CONTAINER],
  ['container true', {}, 'linux', 'build-7', true, CONTAINER],
  ['nothing set', {}, 'linux', 'build-7', false, ''],
  ['a WSL name with a space falls through to SSH', { WSL_DISTRO_NAME: 'Ubuntu 22', SSH_CONNECTION: '1 2 3 4' }, 'linux', 'build-7', false, SSH],
  ['a WSL name with a slash falls through to the container', { WSL_DISTRO_NAME: 'a/b' }, 'linux', 'build-7', true, CONTAINER],
  ['an empty WSL name falls through to SSH', { WSL_DISTRO_NAME: '', SSH_CONNECTION: '1 2 3 4' }, 'darwin', 'build-7', false, SSH],
  ['an SSH hostname with a space falls through to the container', { SSH_CONNECTION: '1 2 3 4', REMOTE_CONTAINERS: '1' }, 'linux', 'build 7', false, CONTAINER],
];

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-place-'));
  made.push(dir);
  mkdirSync(join(dir, 'docs', 'ai'), { recursive: true });
  return dir;
};
const guideEnvelope = (io) => {
  const out = [];
  const err = [];
  const dir = tmp();
  const code = guideMain(['--dir', dir, '--json'], { cwd: dir, home: tmp(), toolsDir: GUIDE_TOOLS, log: (text) => out.push(text),
    error: (text) => err.push(text), ...io });
  assert.equal(code, 0, err.join('\n'));
  return JSON.parse(out.join('\n'));
};
const prefixOf = (place) => (place ? `run the apply in ${place}; ` : '');
const dockerenv = () => { try { return statSync('/.dockerenv').isFile(); } catch { return false; } };
const withEnv = (values, fn) => {
  const saved = Object.fromEntries(PLACE_ENV.map((name) => [name, process.env[name]]));
  for (const name of PLACE_ENV) delete process.env[name];
  Object.assign(process.env, values);
  try { return fn(); } finally {
    for (const name of PLACE_ENV) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
};

describe('spec:jev-guide/S27 the place by proof: one ordered rule, a line of its own, never inside the command', () => {
  it('quotes the win32 connect line for PowerShell: one backslash, always single-quoted, a quote doubled', () => {
    assert.equal(connectLine(`C:${BS}Users${BS}O'Brien${BS}kit tools`, 'win32'), `node 'C:${BS}Users${BS}O''Brien${BS}kit tools${BS}jev-connect.mjs'`);
  });

  for (const [name, env, platform, host, container, place] of CELLS) {
    it(`placeOf, ${name}: ${JSON.stringify(place)}`, () => {
      assert.equal(placeOf({ env, platform, hostname: host, container }), place);
    });
  }

  for (const [name, env, platform, host, container, place] of CELLS) {
    it(`the guide, ${name}: the Run it in line directly before a pure connect line, and where`, () => {
      const envelope = guideEnvelope({ env, platform, hostname: host, container });
      const step = envelope.steps[0];
      const connect = connectLine(GUIDE_TOOLS, platform);
      assert.deepEqual([envelope.where, envelope.connect], [place, connect]);
      assert.equal(step.filter((line) => line.startsWith('Run it in ')).length, place ? 1 : 0, step.join('\n'));
      if (place) assert.equal(step[step.indexOf(connect) - 1], `Run it in ${place}:`);
      assert.doesNotMatch(connect, PLACE_WORDS, connect);
      if (platform === 'win32') assert.equal(connect, `node '${GUIDE_TOOLS}${BS}jev-connect.mjs'`);
    });
  }

  for (const [name, env, platform, host, container, place] of CELLS) {
    it(`the advisor, ${name}: the detail prefix, the user step and unquoted console argv whatever the platform`, () => {
      const { items } = buildRecommendations({ cwd: tmp(), deps: { probes: [probeJevConnect], getenv: env, jevHost: { platform, hostname: host, container } } });
      assert.equal(items.length, 1);
      const slot = need(lanes, 'applySlot')('jev-connect', { toolsDir: TOOLS, platform });
      assert.deepEqual(slot, { check: null, apply: userStep() });
      assert.equal(items[0].lane, 'user');
      assert.equal(items[0].check, null);
      assert.equal(items[0].apply, userStep());
      assert.doesNotMatch(items[0].apply, /applies at your next|restart the agent/);
      assert.deepEqual(need(lanes, 'consoleArgv')('jev-connect', { toolsDir: TOOLS, platform }).apply,
        ['node', join(TOOLS, 'jev-connect.mjs')]);
      assert.ok(items[0].detail.startsWith(`${prefixOf(place)}HAND-APPLY alternative`), items[0].detail);
    });
  }

  it('the guide\'s default route: io.env { SSH_CONNECTION } and no injected host fact renders where by the host\'s own facts', () => {
    const env = { SSH_CONNECTION: 'x' };
    const envelope = guideEnvelope({ env });
    assert.equal(envelope.where, placeOf({ env, platform: process.platform, hostname: hostname(), container: dockerenv() }));
  });

  it('the advisor\'s default route: main with no ctx.deps and SSH_CONNECTION set renders the detail prefix by the host\'s own facts', () => {
    withEnv({ SSH_CONNECTION: 'x', HOME: tmp() }, () => {
      const result = advisorMain(['--cwd', tmp(), '--json']);
      assert.equal(result.code, 0, result.stderr);
      const [item] = JSON.parse(result.stdout).items.filter(({ key }) => key === 'jev-connect');
      const place = placeOf({ env: process.env, platform: process.platform, hostname: hostname(), container: dockerenv() });
      assert.ok(item.detail.startsWith(`${prefixOf(place)}HAND-APPLY alternative`), `${place} | ${item.detail}`);
    });
  });
});
