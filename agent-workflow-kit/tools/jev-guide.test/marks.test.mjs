import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The guide and the facts leaf are loaded dynamically, so the suite loads on a tree without them and each cell fails at its first call.
const loaded = await import('../jev-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const facts = await import('../jev-facts.mjs').catch(() => ({}));
const connectLine = facts.connectLine ?? (() => { throw new Error('connectLine is absent'); });
const LF = '\n';
const KEY = 'TYPESAFE_API_KEY';
const SKILL = join('typesafe-ai', 'SKILL.md');
const TOOLS_DIR = '/kit tools/dir';
// The five roots of the part, in its order: [the base, the root under it].
const ROOTS = [['dir', '.claude/skills'], ['dir', '.agents/skills'], ['home', '.claude/skills'], ['home', '.codex/skills'],
  ['home', '.cursor/skills']];
const KIT_ROUTE = 'Optional, for your own code and prompts — the vendor skill. The kit installs it pinned, one verified copy per agent skill root (Codex, Claude Code, Antigravity CLI); after your yes in the chat, run this in a terminal of your own:';
const VENDOR_ROUTES = ['Or the vendor\'s own routes:', 'Claude Code:', 'claude plugin marketplace add typesafe-ai/skills',
  'claude plugin install typesafe@typesafe-ai', 'Other agents:', 'npx skills add typesafe-ai/skills --skill typesafe-ai'];
const NO_HOME = 'no home directory found: the kit\'s install needs one';
const NO_APPLY_LINE = 'the apply line cannot be printed here: a path holds a control character';
const MARK = /^(Codex|Claude Code|Antigravity CLI) skill root: (current|earlier|absent|foreign) at /;
const CONFIG_VARIANTS = [{}, { CLAUDE_CONFIG_DIR: 'rel/cc' }, { CLAUDE_CONFIG_DIR: '/abs/cc' }];
const VENDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'references', 'vendor', 'typesafe-ai');
const AFTER_INSTALL = 'After an install, quit the agent and start it again from a new terminal.';
const TICKETS = ['"I was charged twice this month."', '"The app crashes when I upload a file."', '"Is there a discount for a yearly plan?"'];
const SUCCESS = 'Success: three choices, each with a confidence.';
const HOST_VARIANTS = [{}, { CLAUDECODE: '1', CODEX_HOME: '/opt/codex-home', TERM_PROGRAM: 'vscode' }];
const CANARIES = ['tsk-A1b2', 'Zq9_longer-canary-value-with-a-suffix.x'];
const HOST_FILTER = /host setting (that filters|filtering) the environment of the agent's commands also hides it/;
const KEY_STEP = 'STEP 1 — the key';
const SKILL_STEP = 'STEP 2 — the vendor skill';
const GET_KEY = 'Get a key at console.typesafe.ai and set it on every host the agent runs on.';
const CONNECT = 'Connect it from a terminal of your own, never through the agent: the command asks for the key with no echo, checks it with one request and saves it for bash, zsh or fish in your shell\'s startup files, or on Windows as a user environment variable.';
// The literal jev-steps quotes in STEP 1 item 5, written here, never imported.
const RESTART_STEP = 'restart the agent so it reads the key: in VS Code or a VS Code fork, quit the editor completely (every window) and open it again; in a terminal, open a new terminal and start the agent there';
const RESTART = `Then ${RESTART_STEP}. Run /agent-workflow-kit jev again: the key mark should read set.`;
const NEVER_PASTE = 'Never paste the key into the chat or into a project file.';
const RUN_AGAIN = 'If it still reads not set after that restart and no such setting applies, run the connect line again and follow its last line.';
const PLACE_VARIABLES = ['WSL_DISTRO_NAME', 'SSH_CONNECTION', 'REMOTE_CONTAINERS', 'CODESPACES'];

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
  'an empty home drops the three home roots': notSeen((cell) => {
    writeFile(join(cell.home, '.claude', 'skills', SKILL));
    cell.home = '';
  }),
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

// Every cell injects the three host facts of the place: linux, no hostname, no container unless a cell says otherwise.
const run = (cell, argv = [], env = cell.env, host = {}) => {
  const out = [];
  const err = [];
  const code = main(['--dir', cell.dir, ...argv], { cwd: cell.root, env, home: cell.home, toolsDir: TOOLS_DIR,
    platform: 'linux', hostname: '', container: false, ...host, log: (text) => out.push(text), error: (text) => err.push(text) });
  return { code, stdout: out.join(LF), stderr: err.join(LF) };
};
const stepOf = (envelope, heading) => envelope.steps.find(([first]) => first === heading);
const envelopeOf = (cell, env, host) => {
  const result = run(cell, ['--json'], env, host);
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

describe('spec:jev-guide/S3 the key step: the connect line and the presence mark', () => {
  it('prints the console line, the connect sentence, the place line exactly when there is a place, the connect line, the restart and never-paste lines, then the mark, whatever the SHELL', () => {
    const HOSTS =[[{}, []], [{ container: true }, ['Run it in a terminal inside this container:']], [{ platform: 'win32' }, ['Run it in a PowerShell terminal:']]];
    for (const name of ['a zsh SHELL, no key', 'an absent variable', 'two canaries: the first']) {
      for (const [host, place] of HOSTS) {
        const step = stepOf(envelopeOf(cells[name], undefined, host), KEY_STEP);
        const connect = connectLine(TOOLS_DIR, host.platform ?? 'linux');
        assert.deepEqual(step.slice(0, -1), [KEY_STEP, GET_KEY, CONNECT, ...place, connect, RESTART, NEVER_PASTE], `${name} ${JSON.stringify(host)}`);
        assert.match(step.at(-1), /^key: TYPESAFE_API_KEY (set\.|not set\.)/, name);
        assert.equal(step.filter((line) => line.includes('read -rs') || line.includes('curl')).length, 0, name);
      }
    }
    assert.equal(connectLine(TOOLS_DIR, 'linux'), "node '/kit tools/dir/jev-connect.mjs'", 'a path with a space is quoted');
    assert.equal(connectLine('/kit/tools', 'linux'), 'node /kit/tools/jev-connect.mjs', 'a safe path is bare');
    assert.equal(facts.RESTART_STEP, RESTART_STEP, 'the facts leaf holds the literal the part quotes');
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
      assert.deepEqual(envelope.key, { set: true });
      assert.ok(!stepOf(envelope, KEY_STEP).some((line) => HOST_FILTER.test(line)));
    }
  });

  it('renders not set, with the host-filter and the run-again sentences, for an absent, an empty and a whitespace-only variable; no step line says launcher or export', () => {
    for (const name of ['an absent variable', 'an empty string', 'a whitespace-only string', 'a zsh SHELL, no key']) {
      const envelope = envelopeOf(cells[name]);
      assert.deepEqual(envelope.key, { set: false }, name);
      const step = stepOf(envelope, KEY_STEP);
      assert.equal(step.filter((line) => line.startsWith(`key: ${KEY} not set`)).length, 1, name);
      const text = step.join(LF);
      assert.match(text, HOST_FILTER, name);
      assert.ok(step.at(-1).endsWith(RUN_AGAIN), name);
      assert.deepEqual(step.filter((line) => /launcher|export/.test(line)), [], name);
    }
  });

  it('reads io.env for no name outside the key variable, CLAUDE_CONFIG_DIR and the four place variables', () => {
    for (const name of CELL_NAMES) {
      const reads = new Set();
      envelopeOf(cells[name], recordingEnv({ ...cells[name].env }, reads));
      assert.ok(reads.has(KEY), name);
      assert.deepEqual([...reads].filter((read) => ![KEY, 'CLAUDE_CONFIG_DIR', ...PLACE_VARIABLES].includes(read)), [], name);
    }
  });
});

describe('spec:jev-guide/S4 STEP 2: the kit route, the vendor routes, the marks and the first use, in every case', () => {
  it('prints the label, the place line, the apply line and the note, the vendor routes, the three target marks, the presence mark and the close', () => {
    for (const name of CELL_NAMES) {
      for (const variant of [...HOST_VARIANTS, ...CONFIG_VARIANTS]) {
        for (const host of [{}, { container: true }]) {
          const cell = cells[name];
          const env = { ...cell.env, ...variant };
          const label = `${name} ${JSON.stringify(variant)} ${JSON.stringify(host)}`;
          const step = stepOf(envelopeOf(cell, env, host), SKILL_STEP);
          const { dir, note } = facts.claudeDirOf(env, cell.home, 'linux');
          const line = facts.skillLine(TOOLS_DIR, 'linux', dir);
          assert.match(line, / --apply --claude-dir /, label);
          const head = cell.home === '' ? [NO_HOME]
            : [...(host.container ? ['Run it in a terminal inside this container:'] : []), line, ...(note ? [note] : [])];
          assert.equal(note !== '' && cell.home !== '', variant.CLAUDE_CONFIG_DIR === 'rel/cc' && cell.home !== '', label);
          const routes = 2 + head.length;
          assert.deepEqual(step.slice(0, routes + VENDOR_ROUTES.length), [SKILL_STEP, KIT_ROUTE, ...head, ...VENDOR_ROUTES], label);
          const marks = step.slice(routes + VENDOR_ROUTES.length).filter((item) => MARK.test(item));
          assert.equal(marks.length, cell.home === '' ? 0 : 3, label);
          assert.deepEqual(step.slice(routes + VENDOR_ROUTES.length, routes + VENDOR_ROUTES.length + marks.length), marks, label);
          assert.match(step[routes + VENDOR_ROUTES.length + marks.length], /^skill: /, label);
          const tail = step.slice(-3);
          assert.equal(tail[0], AFTER_INSTALL, label);
          assert.ok(['using the TypeSafe skill', 'billing, technical or sales', 'one request each', 'choice and confidence', ...TICKETS]
            .every((part) => tail[1].includes(part)), `${label}: ${tail[1]}`);
          assert.equal(tail[2], SUCCESS, label);
          const plain = run(cell, [], env, host).stdout.split(LF);
          assert.ok(step.every((item) => plain.includes(item)), label);
        }
      }
    }
  });

  it('prints NO_APPLY_LINE in the apply line\'s place for a claude dir holding a control byte', () => {
    const cell = cells['no entry'];
    const step = stepOf(envelopeOf(cell, { CLAUDE_CONFIG_DIR: `/c${String.fromCharCode(9)}c` }), SKILL_STEP);
    assert.equal(step[2], NO_APPLY_LINE);
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

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The vendored pair is read guarded, so the suite loads on a tree without it and each cell fails on its own.
const vendorRead = (name) => { try { return readFileSync(join(VENDOR, name)); } catch { return Buffer.from(`the vendored ${name} is absent\n`); } };
const PAIRS = {
  current: { 'SKILL.md': vendorRead('SKILL.md.pinned'), LICENSE: vendorRead('LICENSE') },
  older: { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.6\n'), LICENSE: Buffer.from('MIT at v0.5.6\n') },
};
const pinOf = (tag, pair) => ({ tag, commit: tag, digests: { 'SKILL.md': digestOf(pair['SKILL.md']), LICENSE: digestOf(pair.LICENSE) } });
const PINS = [pinOf('v0.5.7', PAIRS.current), pinOf('v0.5.6', PAIRS.older)];
const fillPair = (dir, pair) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(pair)) writeFileSync(join(dir, name), bytes);
};
const TARGETS = (home, claude = join(home, '.claude')) => [['Codex', join(home, '.agents', 'skills', 'typesafe-ai')],
  ['Claude Code', join(claude, 'skills', 'typesafe-ai')], ['Antigravity CLI', join(home, '.gemini', 'config', 'skills', 'typesafe-ai')]];
const marksOf = (step) => step.filter((line) => / skill root: /.test(line));

describe('spec:jev-guide/S36 the STEP 2 target marks over a temp home', () => {
  it('reads current, earlier and absent with their tags, in the order Codex, Claude Code, Antigravity CLI, envelope and plain alike', () => {
    const cell = makeCell();
    const [codex, claude, agy] = TARGETS(cell.home);
    fillPair(codex[1], PAIRS.current);
    fillPair(claude[1], PAIRS.older);
    const before = [hashTree(cell.dir), hashTree(cell.home)];
    const envelope = envelopeOf(cell, {}, { pins: PINS });
    assert.deepEqual(envelope.skill.targets, [
      { agent: 'Codex', path: codex[1], state: 'current', tag: 'v0.5.7', reason: null },
      { agent: 'Claude Code', path: claude[1], state: 'earlier', tag: 'v0.5.6', reason: null },
      { agent: 'Antigravity CLI', path: agy[1], state: 'absent', tag: null, reason: null },
    ]);
    const marks = [`Codex skill root: current at ${codex[1]} (v0.5.7)`, `Claude Code skill root: earlier at ${claude[1]} (v0.5.6)`,
      `Antigravity CLI skill root: absent at ${agy[1]}`];
    assert.deepEqual(marksOf(stepOf(envelope, SKILL_STEP)), marks);
    assert.deepEqual(marksOf(run(cell, [], {}, { pins: PINS }).stdout.split(LF)), marks);
    assert.equal(envelope.skill.install, facts.skillLine(TOOLS_DIR, 'linux', join(cell.home, '.claude')));
    assert.deepEqual(envelope.skill.found, [join(claude[1], 'SKILL.md')], 'the S2 five-path table is unchanged: it finds the Claude Code copy at its own path');
    assert.deepEqual([hashTree(cell.dir), hashTree(cell.home)], before, 'read-only');
  });

  it('reads a foreign target with its reason and a merged record with both agents', () => {
    const cell = makeCell();
    const [codex] = TARGETS(cell.home);
    fillPair(codex[1], { ...PAIRS.current, '.DS_Store': 'meta\n' });
    assert.deepEqual(marksOf(stepOf(envelopeOf(cell), SKILL_STEP))[0], `Codex skill root: foreign at ${codex[1]} — holds .DS_Store, LICENSE, SKILL.md`);
    const merged = marksOf(stepOf(envelopeOf(cell, { CLAUDE_CONFIG_DIR: join(cell.home, '.agents') }), SKILL_STEP));
    assert.equal(merged.length, 2);
    assert.match(merged[0], /^Codex and Claude Code skill root: foreign at /);
  });

  it('an absolute CLAUDE_CONFIG_DIR moves the Claude Code target and the install; a relative one prints the note', () => {
    const cell = makeCell();
    const cc = join(cell.root, 'cc');
    const moved = envelopeOf(cell, { CLAUDE_CONFIG_DIR: cc });
    assert.equal(moved.skill.targets[1].path, join(cc, 'skills', 'typesafe-ai'));
    assert.equal(moved.skill.install, facts.skillLine(TOOLS_DIR, 'linux', cc));
    assert.ok(moved.skill.install.endsWith(` --apply --claude-dir ${cc}`), moved.skill.install);
    const relative = stepOf(envelopeOf(cell, { CLAUDE_CONFIG_DIR: 'rel/cc' }), SKILL_STEP);
    const note = `CLAUDE_CONFIG_DIR is set to rel/cc, not an absolute path: the Claude Code target is ${join(cell.home, '.claude')}`;
    assert.equal(relative[relative.indexOf(facts.skillLine(TOOLS_DIR, 'linux', join(cell.home, '.claude'))) + 1], note);
  });

  it('an empty home prints the no-home line and no mark, with empty targets and install', () => {
    const cell = makeCell();
    cell.home = '';
    const envelope = envelopeOf(cell, { CLAUDE_CONFIG_DIR: '/abs/cc' });
    assert.deepEqual([envelope.skill.targets, envelope.skill.install], [[], '']);
    const step = stepOf(envelope, SKILL_STEP);
    assert.equal(step[2], NO_HOME);
    assert.deepEqual(marksOf(step), []);
    assert.ok(!step.some((line) => line.includes('jev-skill.mjs')));
  });
});
