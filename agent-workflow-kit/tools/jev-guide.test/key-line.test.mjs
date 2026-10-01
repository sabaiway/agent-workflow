import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loaded = await import('../jev-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const LF = '\n';
const KEY = 'TYPESAFE_API_KEY';
const KEY_STEP = 'STEP 1 — the key';
// The part's key line, byte for byte, with PROFILE the startup file of the SHELL table.
const KEY_LINE = `set +x; printf 'TYPESAFE_API_KEY: ' && read -rs k && echo && { echo; printf 'export TYPESAFE_API_KEY=%q' "$k"; echo; } >> PROFILE && unset k`;
const EDITOR = "Set TYPESAFE_API_KEY to your key in your shell's startup file, in an editor and in that shell's own syntax, never through the chat or a project file.";
const CANARIES = ['tsk-E5f6', 'Wr7_a-longer-canary-value-for-the-key-line.q'];
const KEYS = { 'plain alphanumeric': 'Ab12cd34Ef', 'a single quote': "ab'cd", 'an inner space, a dollar sign and a backtick': 'ab c$d`e',
  'a double quote and a semicolon': 'ab"c;d' };
// The closed table: the exact basename of io.env.SHELL → PROFILE, or null for no key line and the editor sentence.
const TABLE = [['zsh', '~/.zshrc'], ['/opt/bash/bin/zsh', '~/.zshrc'], ['bash', '~/.bashrc'], ['/opt/zsh/bin/bash', '~/.bashrc'],
  ['zshx', null], ['/usr/bin/notzsh', null], ['bashful', null], ['/usr/bin/notbash', null], ['ksh', null], ['dash', null],
  ['fish', null], ['', null], [undefined, null], ['__proto__', null], ['/bin/constructor', null], ['toString', null]];
const ZSH_ABSENT = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).status !== 0;

const made = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});
const tmp = (tag) => {
  const root = mkdtempSync(join(tmpdir(), `jev-key-line-${tag}-`));
  made.push(root);
  return root;
};
const cellOf = (env) => {
  const root = tmp('cell');
  mkdirSync(join(root, 'project'));
  mkdirSync(join(root, 'home'));
  return { dir: join(root, 'project'), home: join(root, 'home'), cwd: root, env };
};
const run = (cell, argv = []) => {
  const out = [];
  const err = [];
  const code = main(['--dir', cell.dir, ...argv], { cwd: cell.cwd, env: cell.env, home: cell.home,
    log: (text) => out.push(text), error: (text) => err.push(text) });
  return { code, stdout: out.join(LF), stderr: err.join(LF) };
};
const envelopeOf = (cell) => {
  const result = run(cell, ['--json']);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const keyStepOf = (envelope) => envelope.steps.find(([heading]) => heading === KEY_STEP);
const keyLinesOf = (step) => step.filter((line) => line.includes('read -rs'));
const shellEnv = (shell, extra = {}) => (shell === undefined ? { ...extra } : { SHELL: shell, ...extra });
const printedLine = (shell) => keyLinesOf(keyStepOf(envelopeOf(cellOf(shellEnv(shell)))))[0];

describe('spec:jev-guide/S15 the key line is chosen by the exact basename of io.env.SHELL', () => {
  for (const [shell, profile] of TABLE) {
    it(`SHELL ${shell === undefined ? 'absent' : JSON.stringify(shell)} → ${profile ?? 'no key line'}`, () => {
      const cell = cellOf(shellEnv(shell));
      const envelope = envelopeOf(cell);
      const step = keyStepOf(envelope);
      assert.equal(envelope.key.profile, profile);
      assert.deepEqual(keyLinesOf(step), profile ? [KEY_LINE.replace('PROFILE', profile)] : []);
      assert.equal(step.filter((line) => line === EDITOR).length, profile ? 0 : 1);
      for (const result of [run(cell), run(cell, ['--json'])]) {
        assert.ok(!result.stdout.includes(cell.home) && !result.stderr.includes(cell.home), 'never the expanded home');
      }
    });
  }
});

describe('spec:jev-guide/S16 the printed key line: byte for byte, no canary, and a byte-equal read-back', () => {
  for (const [shell, profile] of [['/bin/zsh', '~/.zshrc'], ['/bin/bash', '~/.bashrc']]) {
    it(`${shell}: the key line is the template with PROFILE ${profile} and no other byte changed; no canary in any output`, () => {
      const outputs = CANARIES.map((canary) => {
        const cell = cellOf(shellEnv(shell, { [KEY]: canary }));
        const lines = run(cell).stdout.split(LF);
        assert.deepEqual(lines.filter((line) => line.includes('read -rs')), [KEY_LINE.replace('PROFILE', profile)]);
        assert.equal(envelopeOf(cell).key.set, true);
        return [run(cell), run(cell, ['--json'])];
      }).flat();
      for (const { stdout, stderr } of outputs) {
        for (const canary of CANARIES) assert.ok(!stdout.includes(canary) && !stderr.includes(canary), canary);
      }
    });
  }

  const readBack = (shell, line, key) => {
    const home = tmp('home');
    const env = { PATH: process.env.PATH, HOME: home };
    const written = spawnSync(shell, ['-x', '-c', line], { encoding: 'utf8', env, input: `${key}${LF}` });
    assert.equal(written.status, 0, written.stderr);
    assert.ok(!written.stdout.includes(key) && !written.stderr.includes(key), 'the run writes none of the key');
    const profile = shell === 'zsh' ? '.zshrc' : '.bashrc';
    const fresh = spawnSync(shell, ['-c', `. "$HOME/${profile}" && printf %s "$${KEY}"`], { encoding: 'utf8', env });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.stdout, key);
  };

  for (const [name, key] of Object.entries(KEYS)) {
    it(`bash -x runs the printed bash line with a key holding ${name}; a fresh bash reads it back byte-equal`, () => {
      readBack('bash', printedLine('/bin/bash'), key);
    });
  }

  it('zsh -x runs the printed zsh line with each key; a fresh zsh reads it back byte-equal',
    { skip: ZSH_ABSENT && 'zsh is not installed on this host (command -v zsh fails): the fresh-zsh read-back is skipped' }, () => {
      for (const key of Object.values(KEYS)) readBack('zsh', printedLine('/bin/zsh'), key);
    });
});
