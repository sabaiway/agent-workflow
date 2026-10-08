import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

const project = await import('./init-project.mjs').catch(() => ({}));
const lanes = await import('./write-lanes.mjs').catch(() => ({}));
const TOOLS = dirname(fileURLToPath(import.meta.url));
const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent`);
  return mod[name];
};
const term = (answers) => {
  const asked = [];
  const printed = [];
  return {
    isTTY: true,
    asked,
    printed,
    ask: async (p) => {
      asked.push(p);
      return answers.shift() ?? '';
    },
    print: (l) => printed.push(l),
  };
};
const item = (variant, what = variant) => ({
  key: variant.split('.')[0],
  variant,
  severity: 'optional',
  what,
  benefit: 'b',
  apply: 'a',
  detail: null,
});
const deploy = (dir, stamp = EXPECTED_WORKFLOW_VERSION) => {
  mkdirSync(join(dir, 'docs/ai'), { recursive: true });
  writeFileSync(join(dir, 'docs/ai/.workflow-version'), stamp);
};
const treeHash = (dir) => {
  const hash = createHash('sha256');
  const visit = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const stat = lstatSync(path);
      hash.update(JSON.stringify([relative(dir, path), stat.isDirectory() ? 'dir' : 'file']));
      if (stat.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(dir);
  return hash.digest('hex');
};
const fixture = (t, { answers = [], env = {}, items = () => [], outcomes = {} } = {}) => {
  const base = mkdtempSync(join(tmpdir(), 'init-project-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'outer');
  const home = join(base, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const terminal = term([...answers]);
  const spawned = [];
  const recommended = [];
  const lstat = (path) => {
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw Object.assign(new Error('outside fixture'), { code: 'ENOENT' });
    }
    return lstatSync(path);
  };
  const deps = {
    cwd: root,
    home,
    toolsDir: TOOLS,
    platform: 'linux',
    env,
    terminal,
    spawn: (argv, opts) => {
      spawned.push({ argv, opts });
      return outcomes[basename(argv[1])] ?? { status: 0, stdout: '', stderr: '' };
    },
    recommend: (at, facts) => {
      recommended.push({ root: at, facts });
      return { items: items(at, facts) };
    },
    io: { lstat, readFile: readFileSync, readdir: readdirSync, openSync, closeSync, geteuid: () => 0 },
  };
  return { root, home, terminal, spawned, recommended, deps };
};

describe('spec:init-project/S9 finding the project and offering its console items', () => {
  it('finds the nearest stamped ancestor and the pre-versioned shape, including a non-git folder', async (t) => {
    const f = fixture(t);
    deploy(f.root);
    f.deps.cwd = join(f.root, 'a/b');
    mkdirSync(f.deps.cwd, { recursive: true });
    const pre = join(f.root, 'pre');
    mkdirSync(join(pre, 'docs/ai'), { recursive: true });
    const findProject = need(project, 'findProject');
    assert.deepEqual(findProject({ cwd: f.deps.cwd, lstat: f.deps.io.lstat }), {
      candidates: [{ root: f.root, shape: 'stamped' }],
    });
    assert.deepEqual(findProject({ cwd: pre, lstat: f.deps.io.lstat }).candidates[0], {
      root: pre, shape: 'pre-versioned',
    });
    await need(project, 'runInitProject')(f.deps);
    assert.deepEqual(f.recommended, [{ root: f.root, facts: { keySet: false } }]);
  });

  it('stops at a git top-level carrying neither deployment shape and still finds a non-git folder', async (t) => {
    const f = fixture(t);
    deploy(f.root);
    const repo = join(f.root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    f.deps.cwd = join(repo, 'x');
    mkdirSync(f.deps.cwd);
    const findProject = need(project, 'findProject');
    assert.deepEqual(findProject({ cwd: f.deps.cwd, lstat: f.deps.io.lstat }), { candidates: [] });
    assert.deepEqual(findProject({ cwd: f.root, lstat: f.deps.io.lstat }), {
      candidates: [{ root: f.root, shape: 'stamped' }],
    });
    await need(project, 'runInitProject')(f.deps);
    assert.ok(f.terminal.printed.includes('no agent-workflow project here — run /agent-workflow-kit upgrade in your agent from that project, or deploy it there first: its yes applies the project items'));
    assert.deepEqual(f.recommended, [{ root: null, facts: { keySet: false } }]);
  });

  it('asks which project when two deployments are on the walk and Enter skips the step', async (t) => {
    const f = fixture(t, { answers: ['2'] });
    deploy(f.root);
    const inner = join(f.root, 'inner');
    deploy(inner);
    f.deps.cwd = join(inner, 'x');
    mkdirSync(f.deps.cwd);
    assert.deepEqual(need(project, 'findProject')({ cwd: f.deps.cwd, lstat: f.deps.io.lstat }), {
      candidates: [{ root: inner, shape: 'stamped' }, { root: f.root, shape: 'stamped' }],
    });
    const runInitProject = need(project, 'runInitProject');
    await runInitProject(f.deps);
    assert.deepEqual(f.terminal.printed.slice(0, 2), [`  1. ${inner}`, `  2. ${f.root}`]);
    assert.deepEqual(f.terminal.asked, ['which project? 1-2, Enter skips: ']);
    assert.deepEqual(f.recommended, [{ root: f.root, facts: { keySet: false } }]);
    const skipped = term(['']);
    f.recommended.length = 0;
    assert.deepEqual(await runInitProject({ ...f.deps, terminal: skipped }), { code: 0 });
    assert.deepEqual(skipped.asked, ['which project? 1-2, Enter skips: ']);
    assert.deepEqual(f.recommended, []);
    assert.deepEqual(f.spawned, []);
  });

  it('runs a spawned writer with cwd the found root and without GIT_DIR and GIT_WORK_TREE', async (t) => {
    const f = fixture(t, {
      answers: ['n'],
      env: { GIT_DIR: '/x', GIT_WORK_TREE: '/y', KEEP: '1' },
      items: () => [item('velocity-core')],
    });
    deploy(f.root);
    f.deps.cwd = join(f.root, 'sub');
    mkdirSync(f.deps.cwd);
    await need(project, 'runInitProject')(f.deps);
    assert.equal(f.spawned.length, 1);
    assert.deepEqual(f.spawned[0].argv, ['node', join(TOOLS, 'velocity-profile.mjs'), '--cwd', f.root]);
    assert.equal(f.spawned[0].opts.cwd, f.root);
    assert.deepEqual(f.spawned[0].opts.env, { KEEP: '1' });
    assert.equal(f.spawned[0].opts.stdio, 'pipe');
    assert.deepEqual(f.deps.env, { GIT_DIR: '/x', GIT_WORK_TREE: '/y', KEEP: '1' });
  });

  it('previews sandbox-provision.installable from a subfolder when the doctor reports missing binaries', async (t) => {
    const f = fixture(t, {
      answers: ['n'],
      items: () => [item('sandbox-provision.installable')],
      outcomes: {
        'autonomy-doctor.mjs': {
          status: 3,
          stdout: '  consent: re-run with  --apply apt-get:bubblewrap   (…)\n[autonomy-doctor] status=missing-binaries platform=linux missing=bwrap pm=apt-get\n',
          stderr: '',
        },
      },
    });
    deploy(f.root);
    f.deps.cwd = join(f.root, 'sub');
    mkdirSync(f.deps.cwd);
    await need(project, 'runInitProject')(f.deps);
    assert.equal(f.spawned.length, 1);
    assert.deepEqual(f.spawned[0].argv, ['node', join(TOOLS, 'autonomy-doctor.mjs')]);
    assert.equal(f.spawned[0].opts.cwd, f.root);
    assert.equal(f.terminal.printed.some((line) => line.includes('preview refused')), false);
    assert.deepEqual(f.terminal.asked, ['apply? y/N: ']);
  });

  it('an lstat failure other than absence stops the find, and a spawn that throws is a refused preview naming its code', async (t) => {
    const f = fixture(t, { items: () => [item('velocity-core')] });
    deploy(f.root);
    const fail = (code) => Object.assign(new Error(code), { code });
    const denied = () => {
      throw fail('EACCES');
    };
    assert.throws(() => need(project, 'findProject')({ cwd: f.root, lstat: denied }), { code: 'EACCES' });
    f.deps.spawn = () => {
      throw fail('ENOENT');
    };
    assert.deepEqual(await need(project, 'runInitProject')(f.deps), { code: 0 });
    assert.ok(f.terminal.printed.includes('preview refused (exit null): velocity-core'));
    assert.ok(f.terminal.printed.includes('ENOENT'));
    assert.deepEqual(f.terminal.asked, []);
  });

  it('offers only the host-scoped items outside a project and asks only the key question', async (t) => {
    const f = fixture(t, { env: { SHELL: '/bin/zsh' }, items: () => [item('jev-connect', 'W')] });
    await need(project, 'runInitProject')(f.deps);
    assert.deepEqual(f.recommended, [{ root: null, facts: { keySet: false } }]);
    assert.ok(f.terminal.printed.includes('no agent-workflow project here — run /agent-workflow-kit upgrade in your agent from that project, or deploy it there first: its yes applies the project items'));
    assert.ok(f.terminal.printed.includes('W'));
    assert.deepEqual(f.terminal.asked, ['y runs its command on this terminal, Enter skips: ']);
    assert.deepEqual(f.spawned, []);
  });
});

describe('spec:init-project/S10 the deployment stamp gate', () => {
  it('lists no project item for a behind, absent, unreadable or malformed stamp and prints the upgrade line', async (t) => {
    const cases = ['3.0.0', null, 'directory', 'not-a-version'].map((stamp) => {
      const f = fixture(t, { items: () => [item('velocity-core')] });
      mkdirSync(join(f.root, 'docs/ai'), { recursive: true });
      if (stamp === 'directory') mkdirSync(join(f.root, 'docs/ai/.workflow-version'));
      else if (stamp !== null) deploy(f.root, stamp);
      return f;
    });
    const runInitProject = need(project, 'runInitProject');
    for (const f of cases) {
      await runInitProject(f.deps);
      assert.ok(f.terminal.printed.includes('run /agent-workflow-kit upgrade in your agent: its yes applies the items'));
      assert.equal(f.terminal.printed.some((line) => line.includes('init again')), false);
      assert.deepEqual(f.recommended, [{ root: null, facts: { keySet: false } }]);
      assert.deepEqual(f.spawned, []);
      assert.equal(f.terminal.printed.some((line) => line.includes('velocity-core')), false);
      assert.deepEqual(f.terminal.asked, []);
    }
  });

  it('lists no project item for a stamp ahead and prints its own message', async (t) => {
    const f = fixture(t, { items: () => [item('velocity-core')] });
    deploy(f.root, '9.0.0');
    await need(project, 'runInitProject')(f.deps);
    assert.ok(f.terminal.printed.includes(`this project's stamp 9.0.0 is ahead of this kit's lineage ${EXPECTED_WORKFLOW_VERSION} — update the kit, then init again`));
    assert.deepEqual(f.recommended, [{ root: null, facts: { keySet: false } }]);
    assert.deepEqual(f.spawned, []);
    assert.equal(f.terminal.printed.some((line) => line.includes('velocity-core')), false);
    assert.deepEqual(f.terminal.asked, []);
  });
});

describe('spec:init-project/S12 skipping the project step without a terminal', () => {
  it('prints the no-terminal line, runs nothing else and leaves the project tree unchanged without a TTY', async (t) => {
    const f = fixture(t, { items: () => [item('velocity-core')] });
    deploy(f.root);
    f.terminal.isTTY = false;
    const before = treeHash(f.root);
    assert.deepEqual(await need(project, 'runInitProject')(f.deps), { code: 0 });
    assert.deepEqual(f.terminal.printed, ['project step skipped: no terminal — run init in a console from the project\'s folder']);
    assert.deepEqual(f.recommended, []);
    assert.deepEqual(f.spawned, []);
    assert.deepEqual(f.terminal.asked, []);
    assert.equal(treeHash(f.root), before);
  });

  it('the entry point without a terminal prints the no-terminal line and exits 0, and an argument is a usage error', (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'init-project-cli-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const run = (args) => spawnSync(process.execPath, [join(TOOLS, 'init-project.mjs'), ...args], {
      cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
    const plain = run([]);
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, 'project step skipped: no terminal — run init in a console from the project\'s folder\n');
    const usage = run(['--x']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage: node init-project\.mjs/u);
  });
});

describe('spec:init-project/S16 the key line and the console environment', () => {
  const queue = () => [item('jev-connect', 'WHAT-OF-THE-KEY-ITEM'), item('velocity-core')];

  it('puts the key line first, names its startup files and asks before any spawn', async (t) => {
    const f = fixture(t, { answers: ['', 'n'], env: { SHELL: '/bin/zsh' }, items: queue });
    deploy(f.root);
    const ask = f.terminal.ask;
    f.terminal.ask = async (prompt) => {
      if (f.terminal.asked.length === 0) assert.deepEqual(f.spawned, []);
      return ask(prompt);
    };
    await need(project, 'runInitProject')(f.deps);
    assert.deepEqual(f.terminal.printed.slice(0, 2), ['WHAT-OF-THE-KEY-ITEM', `it writes: ${f.home}/.zshrc`]);
    assert.equal(f.terminal.asked[0], 'y runs its command on this terminal, Enter skips: ');
    assert.deepEqual(need(lanes, 'writesOf')('jev-connect', { ...f.deps, root: f.root }), [join(f.home, '.zshrc')]);
  });

  it('spawns no key command and writes nothing on Enter, keeping only the false keySet fact', async (t) => {
    const f = fixture(t, { answers: ['', 'n'], env: { SHELL: '/bin/zsh' }, items: queue });
    deploy(f.root);
    writeFileSync(join(f.home, '.zshrc'), '# keep startup text\n');
    const before = treeHash(f.home);
    await need(project, 'runInitProject')(f.deps);
    assert.equal(f.spawned.some(({ argv }) => basename(argv[1]) === 'jev-connect.mjs'), false);
    assert.equal(treeHash(f.home), before);
    assert.deepEqual(f.recommended, [{ root: f.root, facts: { keySet: false } }]);
  });

  it('spawns jev-connect with the terminal inherited on y and passes only keySet after exit zero', async (t) => {
    const cases = [0, 3].map((status) => {
      const f = fixture(t, {
        answers: ['y', 'n'],
        env: { SHELL: '/bin/zsh' },
        items: (_root, facts) => facts.keySet ? [item('velocity-core')] : queue(),
        outcomes: { 'jev-connect.mjs': { status, stdout: '', stderr: '' } },
      });
      deploy(f.root);
      return { f, status };
    });
    const runInitProject = need(project, 'runInitProject');
    for (const { f, status } of cases) {
      await runInitProject(f.deps);
      assert.deepEqual(f.spawned[0].argv, ['node', join(TOOLS, 'jev-connect.mjs')]);
      assert.equal(f.spawned[0].opts.stdio, 'inherit');
      assert.equal(f.spawned[0].opts.cwd, f.root);
      const expected = [{ root: f.root, facts: { keySet: false } }];
      if (status === 0) expected.push({ root: f.root, facts: { keySet: true } });
      assert.deepEqual(f.recommended, expected);
      for (const call of f.spawned) assert.deepEqual(call.opts.env, f.deps.env);
      assert.deepEqual(f.deps.env, { SHELL: '/bin/zsh' });
    }
  });

  it('prints not pending for bridge-tier and Jev items and names the console CLAUDE_CONFIG_DIR judged', async (t) => {
    const cases = [{}, { CLAUDE_CONFIG_DIR: '/cc' }].map((env) => {
      const f = fixture(t, { env, items: () => [] });
      deploy(f.root);
      return f;
    });
    const runInitProject = need(project, 'runInitProject');
    for (const f of cases) {
      await runInitProject(f.deps);
      assert.ok(f.terminal.printed.includes('not pending in this console: bridge-tier'));
      assert.ok(f.terminal.printed.includes('not pending in this console: jev-connect'));
      assert.deepEqual(f.terminal.asked, []);
      assert.deepEqual(f.spawned, []);
      assert.deepEqual(f.recommended, [{ root: f.root, facts: { keySet: false } }]);
    }
    assert.ok(cases[1].terminal.printed.includes('not pending in this console: jev-skill (judged /cc)'));
  });

  it('the key line prints its posture note before the question, and the not-pending line names only keys the advisor lacks', async (t) => {
    const note = readFileSync(join(TOOLS, '..', 'references/modes/recommendations.md'), 'utf8').split('\n').find((line) => line.startsWith('- `jev-connect` — '));
    assert.ok(note);
    const f = fixture(t, { answers: ['', 'n'], env: { SHELL: '/bin/zsh' }, items: queue });
    deploy(f.root);
    const ask = f.terminal.ask;
    f.terminal.ask = async (prompt) => {
      if (f.terminal.asked.length === 0) assert.ok(f.terminal.printed.includes(note));
      return ask(prompt);
    };
    await need(project, 'runInitProject')(f.deps);
    assert.equal(f.terminal.asked.length, 2);
    assert.ok(!f.terminal.printed.includes('not pending in this console: jev-connect'));
    const outside = fixture(t, { env: { SHELL: '/bin/zsh' } });
    await need(project, 'runInitProject')(outside.deps);
    assert.ok(!outside.terminal.printed.some((line) => /not pending in this console: (bridge-tier|sandbox-provision)/u.test(line)));
  });

  it('the default advisor wiring hands the advisor the key-set fact and the host, so the skill item follows the key', async (t) => {
    const f = fixture(t, { answers: ['y', 'n'], env: { SHELL: '/bin/zsh', PATH: '/nonexistent-path-for-tests' } });
    deploy(f.root);
    delete f.deps.recommend;
    await need(project, 'runInitProject')(f.deps);
    assert.deepEqual(f.spawned[0].argv, ['node', join(TOOLS, 'jev-connect.mjs')]);
    const skill = f.spawned.find(({ argv }) => basename(argv[1]) === 'jev-skill.mjs');
    assert.ok(skill, 'the skill item is previewed after the key command exits 0');
    assert.deepEqual(skill.argv, ['node', join(TOOLS, 'jev-skill.mjs'), '--claude-dir', join(f.home, '.claude')]);
  });
});
