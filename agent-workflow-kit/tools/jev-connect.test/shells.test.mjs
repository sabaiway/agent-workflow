// spec:jev-guide — docs/ai/specs/kit/jev-guide/jev-connect.md
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// The command is loaded dynamically, so the suite loads on a tree without it and each cell fails at its first call.
const loaded = await import('../jev-connect.mjs').catch(() => ({}));
const absent = (name) => () => { throw new Error(`${name} is absent`); };
const main = loaded.main ?? absent('main');
const saveKey = loaded.saveKey ?? absent('saveKey');
const targetsFor = loaded.targetsFor ?? absent('targetsFor');
const fishLine = loaded.fishLine ?? absent('fishLine');
const KEY = 'TYPESAFE_API_KEY';
const BS = '\\';
// S25's five hostile keys and a key ending in a backslash, each with its fish-quoted body: a backslash doubled, a quote escaped.
const FISH_KEYS = [['tsk-plain123', 'tsk-plain123'], ["it's got a quote", `it${BS}'s got a quote`],
  ['sp ace $dollar `tick`', 'sp ace $dollar `tick`'], ['dq"semi;', 'dq"semi;'], [`back${BS}slash`, `back${BS}${BS}slash`],
  [`ends${BS}`, `ends${BS}${BS}`]];
const fishFileLine = (quoted) => `set -gx ${KEY} '${quoted}'  # agent-workflow jev`;
const CONF = join('fish', 'conf.d', 'typesafe-api-key.fish');
const WINDOWS = `the Windows user environment variable ${KEY}`;
const SCRIPT = `$ErrorActionPreference='Stop'; [Environment]::SetEnvironmentVariable('${KEY}', [Console]::In.ReadLine(), 'User')`;
const RETRY = 'not saved — fix the cause on the line above and run this command again';
const CANARY = 'tsk-W1n_canary-value.z';
const OK_BODY = { answers: { department: { choice: 'billing', confidence: 0.81 } } };

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-shells-'));
  made.push(dir);
  return dir;
};
const modeOf = (path) => statSync(path).mode & 0o777;
const fishAt = (config) => ({ form: 'fish', path: join(config, CONF) });
// A fake terminal that types one line once main has subscribed.
const terminal = (line) => Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, pause() {},
  resume() { setImmediate(() => this.emit('data', `${line}\r`)); } });
const run = async (argv, io) => {
  const out = [];
  const code = await main(argv, { stdin: terminal(CANARY), stdout: { write: () => {} }, log: (text) => out.push(text),
    error: (text) => out.push(text), fetch: async () => ({ status: 200, json: async () => OK_BODY }), ...io });
  return { code, lines: out };
};

describe('spec:jev-guide/S28 the fish save: the kit\'s own file, written whole', () => {
  it('writes exactly the fish line and a newline for each hostile key, fish-quoted, over any prior bytes', () => {
    for (const [key, quoted] of FISH_KEYS) {
      const home = tmp();
      const target = fishAt(join(home, '.config'));
      mkdirSync(join(home, '.config', 'fish', 'conf.d'), { recursive: true });
      writeFileSync(target.path, `set -gx ${KEY} 'stale'\nset -gx OTHER 1\n`);
      assert.equal(fishLine(key), fishFileLine(quoted), key);
      assert.deepEqual(saveKey(key, [target], home).map(({ saved, line }) => [saved, line]), [[true, `saved: ${target.path}`]], key);
      assert.equal(readFileSync(target.path, 'utf8'), `${fishFileLine(quoted)}\n`, key);
    }
  });

  it('creates a missing .config, fish and conf.d 0700, keeps an existing directory\'s mode, a new file 0600 and an existing file\'s mode', () => {
    const fresh = tmp();
    const [target] = targetsFor({ shell: '/usr/bin/fish', home: fresh });
    assert.deepEqual(target, fishAt(join(fresh, '.config')));
    assert.ok(saveKey('k', [target], fresh)[0].saved);
    for (const dir of ['.config', join('.config', 'fish'), join('.config', 'fish', 'conf.d')]) assert.equal(modeOf(join(fresh, dir)), 0o700, dir);
    assert.equal(modeOf(target.path), 0o600);
    const kept = tmp();
    mkdirSync(join(kept, '.config'));
    chmodSync(join(kept, '.config'), 0o755);
    const again = fishAt(join(kept, '.config'));
    assert.ok(saveKey('k', [again], kept)[0].saved);
    assert.deepEqual([modeOf(join(kept, '.config')), modeOf(join(kept, '.config', 'fish'))], [0o755, 0o700]);
    chmodSync(again.path, 0o640);
    assert.ok(saveKey('k2', [again], kept)[0].saved);
    assert.deepEqual([modeOf(again.path), readFileSync(again.path, 'utf8')], [0o640, `${fishFileLine('k2')}\n`]);
  });

  it('refuses a linked directory on the way, a linked file and a file outside the home, writing nothing through them', () => {
    const home = tmp();
    mkdirSync(join(home, 'dotfiles'));
    symlinkSync(join(home, 'dotfiles'), join(home, '.config'));
    const viaLink = fishAt(join(home, '.config'));
    const other = tmp();
    mkdirSync(join(other, 'fish', 'conf.d'), { recursive: true });
    writeFileSync(join(other, 'real.fish'), 'kept\n');
    symlinkSync(join(other, 'real.fish'), join(other, CONF));
    const linkedFile = fishAt(other);
    const outside = fishAt(join(tmp(), 'xdg'));
    assert.deepEqual(saveKey('k', [viaLink], home).map(({ saved, line }) => [saved, line]),
      [[false, `not saved: ${viaLink.path} — ${join(home, '.config')} is a link — nothing written`]]);
    assert.deepEqual(saveKey('k', [linkedFile], other).map(({ saved, line }) => [saved, line]),
      [[false, `not saved: ${linkedFile.path} is a link — nothing written`]]);
    assert.deepEqual(saveKey('k', [outside], home).map(({ saved, line }) => [saved, line]),
      [[false, `not saved: ${outside.path} is outside the home — nothing written`]]);
    assert.deepEqual([readdirSync(join(home, 'dotfiles')), readFileSync(join(other, 'real.fish'), 'utf8'), existsSync(outside.path)], [[], 'kept\n', false]);
    assert.ok(lstatSync(join(other, CONF)).isSymbolicLink());
  });

  it('five hostile keys read back byte-equal through fish sourcing the file', () => {
    const which = spawnSync('sh', ['-c', 'command -v fish'], { encoding: 'utf8' });
    if (which.status !== 0) { console.log('# skip: fish is not installed'); return; }
    for (const [key] of FISH_KEYS.slice(0, 5)) {
      const home = tmp();
      const target = fishAt(join(home, '.config'));
      assert.ok(saveKey(key, [target], home)[0].saved, key);
      const back = spawnSync('fish', ['--no-config', '-c', `source $argv[1]; printf %s "$${KEY}"`, target.path], { encoding: 'utf8' });
      assert.deepEqual([back.status, back.stdout], [0, key], `${key} ${back.stderr}`);
    }
  });

  it('main under a fish SHELL with XDG_CONFIG_HOME=<home>/xdg saves there, prints the all-saved line, exits 0 and writes nothing under .config', async () => {
    const home = tmp();
    const path = join(home, 'xdg', CONF);
    const result = await run([], { env: { SHELL: '/usr/bin/fish', XDG_CONFIG_HOME: join(home, 'xdg') }, home, platform: 'linux' });
    assert.deepEqual([result.code, result.lines.slice(1)], [0, [`saved: ${path}`, loaded.ALL_SAVED]]);
    assert.equal(readFileSync(path, 'utf8'), `${fishFileLine(CANARY)}\n`);
    assert.equal(existsSync(join(home, '.config')), false);
  });
});

describe('spec:jev-guide/S29 the Windows save by a stub spawn', () => {
  // A recording spawn answering with the given result; every cell but the default-route one injects it.
  const stub = (result) => {
    const calls = [];
    return { calls, spawn: (command, args, options) => { calls.push({ command, args, options }); return result; } };
  };
  const winRun = async (argv, result, timeoutMs = 2000) => {
    const home = tmp();
    const { calls, spawn } = stub(result);
    const outcome = await run(argv, { env: { SHELL: '/bin/bash' }, home, platform: 'win32', spawn, timeoutMs });
    assert.deepEqual(readdirSync(home), [], 'no file under the home');
    assert.ok(outcome.lines.every((line) => !line.includes(CANARY)), 'no key byte in any output');
    return { ...outcome, calls };
  };

  it('makes one powershell.exe call: the fixed arguments and script, the key only on stdin, the timeout from io', async () => {
    const { calls, code, lines } = await winRun([], { status: 0 }, 1234);
    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT]]]);
    assert.ok(calls[0].args.every((arg) => !arg.includes(CANARY)));
    assert.deepEqual([calls[0].options.input, calls[0].options.timeout], [`${CANARY}\n`, 1234]);
    assert.deepEqual([code, lines.slice(1)], [0, [`saved: ${WINDOWS}`, loaded.ALL_SAVED]]);
  });

  for (const [name, result, cause] of [['a non-zero status', { status: 1 }, 'powershell.exe exited 1'],
    ['a spawn error', { status: null, error: Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) }, 'ENOENT'],
    ['a timeout', { status: null, error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, 'no answer within 2 s']]) {
    it(`${name}: one not saved line naming the variable and the cause, the retry sentence, exit 4`, async () => {
      const { code, lines } = await winRun([], result);
      assert.deepEqual([code, lines.slice(1)], [4, [`not saved: ${WINDOWS} — ${cause}`, `verified, ${RETRY}`]]);
      assert.ok(!lines.some((line) => line.includes('in an editor')), lines.join('\n'));
    });
  }

  it('under --unverified a failed spawn prints the retry sentence without verified', async () => {
    const { code, lines } = await winRun(['--unverified'], { status: 1 });
    assert.deepEqual([code, lines.at(-1)], [4, RETRY]);
  });

  it('with no spawn injected off win32 the default starts nothing: a powershell.exe first on PATH is never started', async () => {
    if (process.platform === 'win32') { console.log('# skip: the default route starts powershell.exe on Windows'); return; }
    const bin = tmp();
    const marker = join(bin, 'started');
    writeFileSync(join(bin, 'powershell.exe'), `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const { code, lines } = await run([], { env: { SHELL: '/bin/bash' }, home: tmp(), platform: 'win32' });
      assert.deepEqual([code, lines.slice(1)], [4, [`not saved: ${WINDOWS} — not on Windows`, `verified, ${RETRY}`]]);
    } finally { process.env.PATH = path; }
    assert.equal(existsSync(marker), false);
  });
});
