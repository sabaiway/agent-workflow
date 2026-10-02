// spec:jev-guide — docs/ai/specs/kit/jev-guide/jev-connect.md
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The command is loaded dynamically, so the suite loads on a tree without it and each cell fails at its first call.
const loaded = await import('./jev-connect.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const { RESTART_STEP } = await import('./jev-facts.mjs').catch(() => ({}));
const RETRY = 'not saved — fix the cause on the line above and run this command again';
const TOOLS = dirname(fileURLToPath(import.meta.url));
const CLI = join(TOOLS, 'jev-connect.mjs');
const KEY = 'TYPESAFE_API_KEY';
const CANARIES = ['tsk-K1a2', 'Xq7_a-longer-canary-value-with-a-tail.y'];
const OK_BODY = { answers: { department: { choice: 'billing', confidence: 0.81 } } };
const USAGE = [['--bogus'], ['--help', '--unverified'], ['-h', '-h'], ['--unverified', 'extra']];

const made = [];
const outputs = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = (tag) => {
  const dir = mkdtempSync(join(tmpdir(), `jev-connect-${tag}-`));
  made.push(dir);
  return dir;
};
// A recursive content hash that never follows a link.
const hashTree = (path) => {
  const entries = [];
  const walk = (at) => {
    let stat;
    try { stat = lstatSync(at); } catch (error) { entries.push(`${at}:${error.code}`); return; }
    if (stat.isDirectory()) { entries.push(`${at}:dir`); for (const name of readdirSync(at).sort()) walk(join(at, name)); return; }
    entries.push(`${at}:${stat.mode}:${stat.isSymbolicLink() ? 'link' : createHash('sha256').update(readFileSync(at)).digest('hex')}`);
  };
  walk(path);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
};

// A fake terminal: isTTY true, raw-mode calls recorded, data fed after main has subscribed.
class FakeStdin extends EventEmitter {
  constructor(feed, { tty = true, rawThrows = false } = {}) {
    super();
    this.isTTY = tty;
    this.raw = [];
    this.paused = false;
    this.feed = feed;
    this.rawThrows = rawThrows;
  }

  setRawMode(value) {
    if (this.rawThrows && value) throw new Error('no raw mode here');
    this.raw.push(value);
  }

  setEncoding() {}

  pause() { this.paused = true; }

  resume() { setImmediate(() => { for (const chunk of this.feed) this.emit('data', chunk); }); }
}
const run = async (argv, { feed = [], tty = true, rawThrows = false, fetchImpl, env, home, platform = 'linux' } = {}) => {
  const out = [];
  const err = [];
  const written = [];
  const stdin = new FakeStdin(feed, { tty, rawThrows });
  const calls = [];
  const fetch = fetchImpl ?? (async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => OK_BODY }; });
  const at = home ?? tmp('home');
  const code = await main(argv, { stdin, stdout: { write: (text) => written.push(text) }, log: (text) => out.push(text),
    error: (text) => err.push(text), env: env ?? { SHELL: '/bin/bash' }, home: at, platform, fetch });
  outputs.push(...out, ...err);
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), written: written.join(''), stdin, calls, home: at };
};
const spawnCli = (args, { input = '', env = {} } = {}) => {
  const clean = { ...process.env, ...env };
  delete clean.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [CLI, ...args], { env: clean, encoding: 'utf8', input });
};
const keyOf = (calls) => calls.map(({ init }) => init.headers.Authorization.replace(/^Bearer /, ''));
const noCanary = (texts, label) => {
  for (const text of texts) for (const canary of CANARIES) assert.ok(!text.includes(canary), `${label}: ${canary}`);
};

describe('spec:jev-guide/S22 the terminal rule and the exit table', () => {
  it('exits 3 with the terminal sentence, no prompt and an unchanged home when stdin is not a terminal', async () => {
    const home = tmp('notty');
    const before = hashTree(home);
    const result = await run([], { tty: false, home, feed: ['tsk-k\r'] });
    assert.equal(result.code, 3);
    assert.equal(result.stderr, loaded.TERMINAL_SENTENCE);
    assert.deepEqual([result.stdout, result.written, result.stdin.raw, result.calls], ['', '', [], []]);
    assert.equal(hashTree(home), before);
    const piped = spawnCli([], { input: 'tsk-k\n' });
    assert.deepEqual([piped.status, piped.stdout], [3, '']);
    assert.ok(piped.stderr.includes(loaded.TERMINAL_SENTENCE), piped.stderr);
  });

  it('answers --help or -h alone with the usage at exit 0, reading nothing', async () => {
    for (const flag of ['--help', '-h']) {
      const reads = [];
      const out = [];
      const io = new Proxy({ log: (text) => out.push(text), error: (text) => out.push(text) }, { get: (target, prop) => { reads.push(String(prop)); return target[prop]; } });
      assert.equal(await main([flag], io), 0, flag);
      assert.deepEqual(reads.filter((prop) => !['log', 'error'].includes(prop)), [], flag);
      const [head, tail] = out.join('\n').split('Exit codes:');
      assert.ok(['Usage:', '--unverified', 'bash', 'zsh', 'fish', 'Windows'].every((word) => head.includes(word)), head);
      const exit4 = tail.slice(tail.indexOf('4 not saved'));
      assert.ok(exit4.startsWith('4 not saved (a refused or failed target, or a shell it does not save for) — the last line says what to do next.'), tail);
      assert.ok(!/fish|Windows/.test(exit4) && !out.join('\n').includes('by hand'), tail);
    }
    const spawned = spawnCli(['--help']);
    assert.deepEqual([spawned.status, /Usage:/.test(spawned.stdout)], [0, true], spawned.stderr);
  });

  it('exits 2 on every usage refusal, reading nothing, and returns without exiting', async () => {
    const exitCode = process.exitCode;
    for (const argv of USAGE) {
      const reads = [];
      const out = [];
      const io = new Proxy({ log: (text) => out.push(text), error: (text) => out.push(text) }, { get: (target, prop) => { reads.push(String(prop)); return target[prop]; } });
      assert.equal(await main(argv, io), 2, argv.join(' '));
      assert.deepEqual(reads.filter((prop) => !['log', 'error'].includes(prop)), [], argv.join(' '));
      assert.notEqual(out.join('\n'), '', argv.join(' '));
    }
    assert.equal(process.exitCode, exitCode);
    const spawned = spawnCli(['--bogus']);
    assert.equal(spawned.status, 2);
    assert.match(spawned.stderr, /unknown argument/);
  });
});

describe('spec:jev-guide/S23 the no-echo read over a fake terminal', () => {
  const READS = [
    ['a CR-ended line', [`${CANARIES[0]}\r`], CANARIES[0]],
    ['an LF-ended line', [`${CANARIES[0]}\n`], CANARIES[0]],
    ['a CRLF-ended line with bytes after it', [`${CANARIES[0]}\r\n`, 'dropped\n'], CANARIES[0]],
    ['two chunks', [CANARIES[0].slice(0, 3), `${CANARIES[0].slice(3)}\r`], CANARIES[0]],
    ['a backspace and a DEL', [`${CANARIES[0]}xy\b\u007f\r`], CANARIES[0]],
    ['edge whitespace trimmed', [`  ${CANARIES[0]}\t\r`], CANARIES[0]],
    ['a control byte ignored', [`${CANARIES[0].slice(0, 2)}\u0001${CANARIES[0].slice(2)}\r`], CANARIES[0]],
  ];
  for (const [name, feed, expected] of READS) {
    it(`${name} resolves the key, raw mode set then restored, the prompt then one newline on stdout`, async () => {
      const result = await run(['--unverified'], { feed });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual([result.stdin.raw, result.stdin.paused, result.written], [[true, false], true, `${KEY}: \n`], name);
      assert.equal(readFileSync(join(result.home, '.bashrc'), 'utf8'), `${loaded.managedLine(expected)}\n`, name);
      assert.equal(keyOf(result.calls).length, 0);
      noCanary([result.stdout, result.stderr, result.written], name);
      assert.equal(result.stdout.split('\n')[0], 'not verified: skipped (--unverified)');
    });
  }

  it('reads the key the request carries: the verify header holds exactly the typed key', async () => {
    for (const canary of CANARIES) {
      const result = await run([], { feed: [`${canary}\r`] });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(keyOf(result.calls), [canary]);
      noCanary([result.stdout, result.stderr, result.written], canary);
    }
  });

  for (const [name, feed, sentence] of [['Ctrl-C', ['\u0003'], 'aborted — nothing written'], ['Ctrl-D', ['\u0004'], 'aborted — nothing written'],
    ['an empty line', ['\r'], 'no key entered — nothing written'], ['a whitespace-only line', ['  \t\r'], 'no key entered — nothing written']]) {
    it(`${name} exits 3 saying ${sentence.split(' — ')[0]}, raw mode restored, nothing called, nothing written`, async () => {
      const home = tmp('abort');
      const before = hashTree(home);
      const result = await run([], { feed, home });
      assert.deepEqual([result.code, result.stderr, result.stdin.raw, result.written, result.calls], [3, sentence, [true, false], `${KEY}: \n`, []]);
      assert.equal(hashTree(home), before);
    });
  }

  it('a setRawMode that throws exits 3 naming the failed read, with no raw mode left on', async () => {
    const home = tmp('raw');
    const before = hashTree(home);
    const result = await run([], { feed: ['tsk\r'], rawThrows: true, home });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /^the terminal read failed: no raw mode here — nothing written$/);
    assert.deepEqual([result.stdin.raw, result.calls], [[false], []]);
    assert.equal(hashTree(home), before);
  });
});

describe('spec:jev-guide/S26 the closing lines and the pseudo-terminal run', () => {
  it('every target saved: the verified line, one saved line per target, the all-saved line with the restart step, exit 0', async () => {
    const home = tmp('ok');
    const result = await run([], { feed: [`${CANARIES[1]}\r`], home });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(loaded.ALL_SAVED, `saved — ${RESTART_STEP}; then ask the agent to check Jev`);
    assert.deepEqual(result.stdout.split('\n'), ['verified: HTTP 200 — department billing, confidence 0.81',
      `saved: ${join(home, '.bashrc')}`, `saved: ${join(home, '.bash_profile')}`, loaded.ALL_SAVED]);
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), `${loaded.managedLine(CANARIES[1])}\n`);
    assert.equal(statSync(join(home, '.bashrc')).mode & 0o777, 0o600);
    noCanary([result.stdout, result.stderr, result.written], 'ok');
  });

  it('targets named and none saved (both bash files links): the retry sentence, exit 4, nothing written through', async () => {
    for (const argv of [[], ['--unverified']]) {
      const home = tmp('none-saved');
      writeFileSync(join(home, 'elsewhere'), 'kept\n');
      for (const name of ['.bashrc', '.bash_profile']) symlinkSync(join(home, 'elsewhere'), join(home, name));
      const result = await run(argv, { feed: ['tsk-k\r'], home });
      assert.deepEqual([result.code, result.stdout.split('\n').at(-1)], [4, `${argv.length ? '' : 'verified, '}${RETRY}`], argv.join(' '));
      assert.equal(readFileSync(join(home, 'elsewhere'), 'utf8'), 'kept\n');
    }
  });

  it('no target (ksh, dash, an absent SHELL off win32): the editor sentence, exit 4, nothing written', async () => {
    for (const env of [{ SHELL: '/bin/ksh' }, { SHELL: '/bin/dash' }, {}]) {
      const home = tmp('none');
      const result = await run([], { feed: ['tsk-k\r'], env, home });
      assert.deepEqual([result.code, result.stdout.split('\n').at(-1)], [4, loaded.EDITOR_SENTENCE], JSON.stringify(env));
      assert.deepEqual(readdirSync(home), []);
    }
  });

  it('--unverified with no target: the not-saved sentence without verified, exit 4, no line claiming a verification', async () => {
    const home = tmp('unverified');
    const result = await run(['--unverified'], { feed: ['tsk-k\r'], env: { SHELL: '/bin/dash' }, home });
    assert.ok(!result.stdout.split('\n').some((line) => line.startsWith('verified')), result.stdout);
    assert.deepEqual([result.code, result.stdout.split('\n').at(-1)], [4, loaded.NOT_SAVED_SENTENCE]);
    assert.deepEqual(readdirSync(home), []);
  });

  it('with no injected home and an empty HOME the home falls back to homedir(), and a bash SHELL saves both files there', async () => {
    const home = tmp('fallback');
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(homedir(), home);
      const out = [];
      const code = await main([], { stdin: new FakeStdin(['tsk-k\r']), stdout: { write: () => {} }, log: (text) => out.push(text), error: (text) => out.push(text),
        env: { SHELL: '/bin/bash', HOME: '' }, platform: 'linux', fetch: async () => ({ status: 200, json: async () => OK_BODY }) });
      outputs.push(...out);
      assert.deepEqual([code, out.slice(1)], [0, [`saved: ${join(home, '.bashrc')}`, `saved: ${join(home, '.bash_profile')}`, loaded.ALL_SAVED]]);
    } finally { process.env.HOME = saved; }
  });

  it('some saved: the bashrc line, a not-saved line for the linked login file, the saved-in-part line, exit 4', async () => {
    const home = tmp('part');
    writeFileSync(join(home, 'elsewhere'), '# a login file kept elsewhere\n');
    symlinkSync(join(home, 'elsewhere'), join(home, '.bash_profile'));
    const result = await run([], { feed: ['tsk-k\r'], home });
    assert.equal(result.code, 4);
    assert.deepEqual(result.stdout.split('\n').slice(1), [`saved: ${join(home, '.bashrc')}`,
      `not saved: ${join(home, '.bash_profile')} is a link — nothing written`, loaded.SAVED_IN_PART]);
    assert.equal(readFileSync(join(home, 'elsewhere'), 'utf8'), '# a login file kept elsewhere\n');
  });

  it('under a pseudo-terminal the spawned command with --unverified writes both bash files 0600 and exits 0', () => {
    // The GNU form `script -q -c <cmd> <file>` is probed first: macOS ships a `script` without -c, a stated skip.
    const probe = spawnSync('script', ['-q', '-c', 'true', '/dev/null'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) { console.log('# skip: no script command that takes -c on this host'); return; }
    const home = tmp('pty');
    const env = { ...process.env, HOME: home, SHELL: '/bin/bash' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync('script', ['-q', '-c', `${process.execPath} ${CLI} --unverified`, '/dev/null'], { encoding: 'utf8', input: `${CANARIES[0]}\n`, env });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['.bashrc', '.bash_profile']) {
      assert.equal(readFileSync(join(home, name), 'utf8'), `${loaded.managedLine(CANARIES[0])}\n`, name);
      assert.equal(statSync(join(home, name)).mode & 0o777, 0o600, name);
    }
    assert.ok(result.stdout.includes(loaded.ALL_SAVED), result.stdout);
    assert.ok(!existsSync(join(home, '.zshrc')));
  });

  it('no line of any cell says connected or by hand, and in an editor only on the editor and not-saved sentences', () => {
    assert.ok(outputs.length > 0);
    assert.deepEqual(outputs.filter((line) => /\bconnected\b|by hand/.test(line)), []);
    assert.deepEqual(outputs.filter((line) => line.includes('in an editor') && ![loaded.EDITOR_SENTENCE, loaded.NOT_SAVED_SENTENCE].includes(line)), []);
  });
});
