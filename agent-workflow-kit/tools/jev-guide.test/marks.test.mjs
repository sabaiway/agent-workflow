import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const loaded = await import('../jev-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const LF = '\n';
const KEY = 'TYPESAFE_API_KEY';
const SKILL = join('typesafe-ai', 'SKILL.md');
// The five roots of the part, in its order: [the base, the root under it].
const ROOTS = [['dir', '.claude/skills'], ['dir', '.agents/skills'], ['home', '.claude/skills'], ['home', '.codex/skills'],
  ['home', '.cursor/skills']];
const INSTALL = ['claude plugin marketplace add typesafe-ai/skills', 'claude plugin install typesafe@typesafe-ai',
  'npx skills add typesafe-ai/skills --skill typesafe-ai'];
const HOST_VARIANTS = [{}, { CLAUDECODE: '1', CODEX_HOME: '/opt/codex-home', TERM_PROGRAM: 'vscode' }];
const CANARIES = ['tsk-A1b2', 'Zq9_longer-canary-value-with-a-suffix.x'];
const HOST_FILTER = /host setting (that filters|filtering) the environment of the agent's commands also hides it/;
const KEY_STEP = 'STEP 1 — the key';
const SKILL_STEP = 'STEP 2 — the vendor skill';
const GET_KEY = 'Get a key at console.typesafe.ai and set it on every host the agent runs on.';
const EDITOR = "Set TYPESAFE_API_KEY to your key in your shell's startup file, in an editor and in that shell's own syntax, never through the chat or a project file.";
const NEVER_PASTE = 'Never paste the key into the chat or into a project file.';

const made = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

// One synthetic dir and home per cell, both under one root that also holds any link target.
const makeCell = () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-marks-'));
  made.push(root);
  const cell = { root, dir: join(root, 'project'), home: join(root, 'home'), env: {} };
  mkdirSync(cell.dir);
  mkdirSync(cell.home);
  return cell;
};
const rootOf = (cell, [base, root]) => join(cell[base], root);
const skillAt = (cell, root) => join(rootOf(cell, root), SKILL);
const writeFile = (path, text = '# the vendor skill\n') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const linkAt = (target, path) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};

const found = (build) => ({ build, seen: true });
const notSeen = (build) => ({ build, seen: false });
const SKILL_CASES = {
  ...Object.fromEntries(ROOTS.map((root, index) => [`root ${index + 1} alone: a regular file`,
    found((cell) => [writeFile(skillAt(cell, root))])])),
  'every root filled': found((cell) => ROOTS.map((root) => writeFile(skillAt(cell, root)))),
  'a linked typesafe-ai directory': found((cell) => {
    writeFile(join(cell.root, 'vendor', 'SKILL.md'));
    linkAt(join(cell.root, 'vendor'), join(rootOf(cell, ROOTS[0]), 'typesafe-ai'));
    return [skillAt(cell, ROOTS[0])];
  }),
  'a linked SKILL.md': found((cell) => {
    linkAt(writeFile(join(cell.root, 'vendor.md')), skillAt(cell, ROOTS[3]));
    return [skillAt(cell, ROOTS[3])];
  }),
  'a linked root': found((cell) => {
    writeFile(join(cell.root, 'skills', SKILL));
    linkAt(join(cell.root, 'skills'), rootOf(cell, ROOTS[2]));
    return [skillAt(cell, ROOTS[2])];
  }),
  'a mode-000 regular file': found((cell) => {
    chmodSync(writeFile(skillAt(cell, ROOTS[1])), 0o000);
    return [skillAt(cell, ROOTS[1])];
  }),
  'a --dir equal to the home names the shared path once': found((cell) => {
    cell.dir = cell.home;
    return [writeFile(skillAt(cell, ROOTS[2]))];
  }),
  'no entry': notSeen(() => []),
  'a directory named SKILL.md': notSeen((cell) => { mkdirSync(skillAt(cell, ROOTS[0]), { recursive: true }); }),
  'a dangling link': notSeen((cell) => { linkAt(join(cell.root, 'gone.md'), skillAt(cell, ROOTS[4])); }),
  'a link to /dev/null': notSeen((cell) => { linkAt('/dev/null', skillAt(cell, ROOTS[0])); }),
  'a regular file named typesafe-ai (ENOTDIR)': notSeen((cell) => {
    writeFile(join(rootOf(cell, ROOTS[2]), 'typesafe-ai'));
  }),
  'a typesafe-ai link to itself (ELOOP)': notSeen((cell) => {
    linkAt('typesafe-ai', join(rootOf(cell, ROOTS[1]), 'typesafe-ai'));
  }),
  'the plugin cache layout under the home': notSeen((cell) => {
    writeFile(join(cell.home, '.claude', 'plugins', 'cache', 'typesafe-ai', 'typesafe', '1.0.0', 'skills', SKILL));
  }),
  'a home component of 256 bytes (ENAMETOOLONG)': notSeen((cell) => { cell.home = join(cell.home, 'h'.repeat(256)); }),
  'the near-miss roots': notSeen((cell) => {
    for (const [base, root] of [['home', '.agents/skills'], ['dir', '.codex/skills'], ['dir', '.cursor/skills']]) {
      writeFile(join(cell[base], root, SKILL));
    }
  }),
};
const KEY_CASES = {
  'two canaries: the first': { [KEY]: CANARIES[0] },
  'two canaries: the second': { [KEY]: CANARIES[1] },
  'an absent variable': {},
  'an empty string': { [KEY]: '' },
  'a whitespace-only string': { [KEY]: ' \t ' },
  'a zsh SHELL, no key': { SHELL: '/bin/zsh' },
};

const buildCell = (name) => {
  const cell = makeCell();
  if (name in KEY_CASES) return { ...cell, env: { ...KEY_CASES[name] }, expected: [] };
  const expected = SKILL_CASES[name].build(cell) ?? [];
  return { ...cell, expected };
};
const CELL_NAMES = [...Object.keys(SKILL_CASES), ...Object.keys(KEY_CASES)];
const cells = Object.fromEntries(CELL_NAMES.map((name) => [name, buildCell(name)]));

const run = (cell, argv = [], env = cell.env) => {
  const out = [];
  const err = [];
  const code = main(['--dir', cell.dir, ...argv], { cwd: cell.root, env, home: cell.home,
    log: (text) => out.push(text), error: (text) => err.push(text) });
  return { code, stdout: out.join(LF), stderr: err.join(LF) };
};
const stepOf = (envelope, heading) => envelope.steps.find(([first]) => first === heading);
const envelopeOf = (cell, env) => {
  const result = run(cell, ['--json'], env);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const recordingEnv = (env, reads) => new Proxy(env, {
  get: (target, prop) => { reads.add(String(prop)); return target[prop]; },
  has: (target, prop) => { reads.add(String(prop)); return prop in target; },
  ownKeys: (target) => { reads.add('ownKeys'); return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor: (target, prop) => { reads.add(String(prop)); return Reflect.getOwnPropertyDescriptor(target, prop); },
});
// A recursive content hash that never follows a link: the entry's type, mode, bytes or link target.
const hashTree = (path) => {
  const entries = [];
  const walk = (at) => {
    let stat;
    try { stat = lstatSync(at); } catch (error) { entries.push(`${at}:${error.code}`); return; }
    const head = `${at}:${stat.mode}:${stat.size}`;
    if (stat.isSymbolicLink()) entries.push(`${head}:${readlinkSync(at)}`);
    else if (stat.isDirectory()) { entries.push(head); for (const name of readdirSync(at).sort()) walk(join(at, name)); }
    else {
      const bytes = (() => { try { return readFileSync(at); } catch (error) { return error.code; } })();
      entries.push(`${head}:${createHash('sha256').update(bytes).digest('hex')}`);
    }
  };
  walk(path);
  return createHash('sha256').update(entries.join(LF)).digest('hex');
};

describe('spec:jev-guide/S2 the skill table by proof', () => {
  for (const name of Object.keys(SKILL_CASES)) {
    it(name, () => {
      const cell = cells[name];
      const envelope = envelopeOf(cell);
      assert.deepEqual([...envelope.skill.found].sort(), [...cell.expected].sort());
      assert.equal(new Set(envelope.skill.found).size, envelope.skill.found.length, 'each path once');
      const step = stepOf(envelope, SKILL_STEP);
      const lines = run(cell).stdout.split(LF);
      for (const path of cell.expected) assert.equal(lines.filter((line) => line.includes(path)).length, 1, path);
      assert.equal(step.some((line) => /not seen/.test(line)), !SKILL_CASES[name].seen);
      assert.ok(!step.some((line) => /not installed/i.test(line)), 'never says not installed');
      if (SKILL_CASES[name].seen) return;
      const text = step.join(LF);
      assert.match(text, /plugin install is not visible to a file check/);
      const order = ['/typesafe:typesafe-ai', 'ask any other agent to use the TypeSafe skill', 'claude plugin list']
        .map((check) => text.indexOf(check));
      assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), String(order));
      assert.ok(step.includes('/typesafe:typesafe-ai') && step.includes('claude plugin list'), 'each command a whole line');
      assert.match(text, /\(the vendor\)/);
      assert.match(text, /Claude Code's own/);
    });
  }
});

describe('spec:jev-guide/S3 the key step and its presence mark', () => {
  it('opens on the console, then the run-it-yourself and key lines on zsh or the editor sentence, then the restart and never-paste lines', () => {
    for (const [name, zsh] of [['a zsh SHELL, no key', true], ['an absent variable', false]]) {
      const step = stepOf(envelopeOf(cells[name]), KEY_STEP);
      const run = step.findIndex((line) => /yourself in a terminal of your own, outside the agent/.test(line));
      const keyLines = step.filter((line) => line.includes('read -rs'));
      assert.deepEqual([run >= 0, keyLines.length, step.filter((line) => line === EDITOR).length], zsh ? [true, 1, 0] : [false, 0, 1], name);
      const restart = step.findIndex((line) => /quit the agent, start it again from a new terminal, and run \/agent-workflow-kit jev again/.test(line));
      const order = [step.indexOf(GET_KEY), ...(zsh ? [run, step.indexOf(keyLines[0])] : [step.indexOf(EDITOR)]), restart, step.indexOf(NEVER_PASTE)];
      assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), `${name}: ${order}`);
    }
  });

  it('renders every output byte-identical under two canaries differing in length, prefix and suffix, and set', () => {
    const [first, second] = [cells['two canaries: the first'], cells['two canaries: the second']];
    for (const argv of [[], ['--json']]) {
      const [a, b] = [run(first, argv), run({ ...first, env: second.env }, argv)];
      assert.deepEqual([b.stdout, b.stderr], [a.stdout, a.stderr], argv.join(' '));
      for (const canary of CANARIES) assert.ok(!a.stdout.includes(canary) && !a.stderr.includes(canary), canary);
    }
    for (const cell of [first, second]) {
      const envelope = envelopeOf(cell);
      assert.deepEqual(envelope.key, { set: true, profile: null });
      assert.ok(!stepOf(envelope, KEY_STEP).some((line) => HOST_FILTER.test(line)));
    }
  });

  it('renders not set, with the host-filter and the launcher sentences, for an absent, an empty and a whitespace-only variable', () => {
    for (const [name, profile] of [['an absent variable', null], ['an empty string', null], ['a whitespace-only string', null], ['a zsh SHELL, no key', '~/.zshrc']]) {
      const envelope = envelopeOf(cells[name]);
      assert.deepEqual(envelope.key, { set: false, profile }, name);
      const step = stepOf(envelope, KEY_STEP);
      assert.equal(step.filter((line) => line.startsWith(`key: ${KEY} not set`)).length, 1, name);
      const text = step.join(LF);
      assert.match(text, HOST_FILTER, name);
      assert.ok(text.includes(`still reads not set after a restart and no such setting applies, the agent may not have been started from a shell that reads ${profile ?? 'that startup file'}`), name);
      assert.match(text, /export the variable in the file the agent's launcher reads, then restart/, name);
    }
  });
});

describe('spec:jev-guide/S4 the install block is fixed in every case and under every host variable', () => {
  it('prints the Claude Code label and its two commands, then the other-agents label and its command', () => {
    let reference = null;
    for (const name of CELL_NAMES) {
      for (const variant of HOST_VARIANTS) {
        const reads = new Set();
        const env = recordingEnv({ ...cells[name].env, ...variant }, reads);
        const step = stepOf(envelopeOf(cells[name], env), SKILL_STEP);
        const plain = run(cells[name], [], env).stdout.split(LF);
        const at = INSTALL.map((command) => step.indexOf(command));
        for (const command of INSTALL) assert.equal(step.filter((line) => line === command).length, 1, `${name}: ${command}`);
        assert.deepEqual([at[1] - at[0], at[2] - at[1]], [1, 2], `${name}: ${at}`);
        assert.match(step[at[0] - 1], /^Claude Code\b/, name);
        assert.match(step[at[2] - 1], /other agents/i, name);
        const block = step.slice(at[0] - 1, at[2] + 1);
        reference ??= block;
        assert.deepEqual(block, reference, name);
        for (const line of block) assert.ok(plain.includes(line), `${name}: ${line}`);
        assert.deepEqual([...reads].sort(), ['SHELL', KEY], `${name}: io.env reads`);
      }
    }
  });
});

describe('spec:jev-guide/S8 read-only: the dir and the home hash alike before and after', () => {
  it('leaves both trees byte-equal and renders each case alike twice', () => {
    for (const name of CELL_NAMES) {
      const cell = cells[name];
      const before = [hashTree(cell.dir), hashTree(cell.home)];
      const plain = [run(cell), run(cell)];
      const json = [run(cell, ['--json']), run(cell, ['--json'])];
      assert.deepEqual([hashTree(cell.dir), hashTree(cell.home)], before, name);
      assert.deepEqual([plain[1].stdout, plain[1].stderr], [plain[0].stdout, plain[0].stderr], name);
      assert.deepEqual([json[1].stdout, json[1].stderr], [json[0].stdout, json[0].stderr], name);
    }
  });
});
