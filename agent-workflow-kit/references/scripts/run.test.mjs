// run.test.mjs — the stable kit command (spec kit-command). Child runs use a copy of run.mjs in a temp deployment's
// kit folder whose five targets are stubs that record what they were given; in-process runs import this tree's own
// run.mjs and inject the spawn, the file check and the two streams. The first test imports run.mjs with an
// unresolvable entry path, so the direct-run guard's fail-closed arm runs in this process.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { readFamily } from './family.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGETS = {
  'docs-size': 'docs-size/check-docs-size.mjs',
  'archive-changelog': 'archives/archive-changelog.mjs',
  'archive-issues': 'archives/archive-issues.mjs',
  'archive-decisions': 'archives/archive-decisions.mjs',
  'install-git-hooks': 'git-hooks/install-git-hooks.mjs',
};
const NAMES = Object.keys(TARGETS);
const at = (dir, target) => join(dir, ...target.split('/'));

// A stub target: it records its file, node binary, arguments, cwd and probe variable, signals itself when asked,
// writes one line to each stream and exits with the code it is told.
const STUB = `import { writeFileSync } from 'node:fs';
if (process.env.KIT_RECORD) writeFileSync(process.env.KIT_RECORD, JSON.stringify({ file: import.meta.url, exec: process.execPath,
  argv: process.argv.slice(2), cwd: process.cwd(), probe: process.env.KIT_PROBE ?? null }));
if (process.env.KIT_SIGNAL) { process.kill(process.pid, process.env.KIT_SIGNAL); await new Promise(() => {}); }
console.log('stub-out');
console.error('stub-err');
process.exitCode = Number(process.env.KIT_EXIT ?? 0);
`;
const DECOY = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.KIT_DECOY, 'the decoy ran');
`;
const place = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); temps.push(dir); return dir; };

// A deployment whose kit folder holds run.mjs and the five stubs, and a cwd outside it holding a decoy at each
// target's path relative to the cwd and to the cwd's own scripts/agent-workflow/.
const deployment = () => {
  const root = tempDir('kit-command-');
  const kit = join(root, 'scripts', 'agent-workflow');
  mkdirSync(kit, { recursive: true });
  copyFileSync(join(HERE, 'run.mjs'), join(kit, 'run.mjs'));
  for (const target of Object.values(TARGETS)) place(at(kit, target), STUB);
  const outside = tempDir('kit-command-cwd-');
  for (const target of Object.values(TARGETS)) for (const base of [outside, join(outside, 'scripts', 'agent-workflow')]) place(at(base, target), DECOY);
  const [record, decoy] = [join(outside, 'record.json'), join(outside, 'decoy.txt')];
  const run = (args, env = {}, entry = join(kit, 'run.mjs')) => {
    rmSync(record, { force: true });
    const r = spawnSync(process.execPath, [entry, ...args], { cwd: outside, encoding: 'utf8', env: { ...process.env, KIT_RECORD: record, KIT_DECOY: decoy, ...env } });
    if (r.error) throw r.error;
    return r;
  };
  const recorded = () => (existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null);
  return { root, kit, outside, decoy, run, recorded };
};

const lines = (text) => text.trimEnd().split('\n');
const oneLine = (text, ...words) => {
  assert.equal(lines(text).length, 1, `one line, got ${JSON.stringify(text)}`);
  for (const word of words) assert.ok(text.includes(word), `${JSON.stringify(text)} names ${word}`);
};

// main(argv, deps) in-process: a spawn spy answering as spawnSync would, the file check and two captured streams.
const inProcess = async (argv, { answer = { status: 0, signal: null }, isFile, env } = {}) => {
  const { main } = await import('./run.mjs');
  const calls = [];
  const streams = { out: '', err: '' };
  const deps = {
    spawn: (command, args, options) => { calls.push({ command, args, options }); return answer; },
    stdout: { write: (text) => { streams.out += text; return true; } },
    stderr: { write: (text) => { streams.err += text; return true; } },
    ...(isFile ? { isFile } : {}),
    ...(env ? { env } : {}),
  };
  return { code: await main(argv, deps), calls, ...streams };
};

describe('spec:kit-command/S1 the frozen names, the command path and the direct-run guard', () => {
  it('an import in-process with an unresolvable process.argv[1] runs nothing and leaves the exit code as it was', async () => {
    const [entry, before] = [process.argv[1], process.exitCode];
    process.argv[1] = join(HERE, 'no-such-entry-point.mjs');
    try {
      const run = await import('./run.mjs');
      assert.equal(typeof run.main, 'function');
      assert.equal(process.exitCode, before, 'the guard failed closed: main did not run');
    } finally {
      process.argv[1] = entry;
      process.exitCode = before;
    }
  });

  it('KIT_COMMANDS is frozen and maps exactly the five names, in order, to deployed entries; KIT_COMMAND_PATH is the deployed path', async () => {
    const { KIT_COMMANDS, KIT_COMMAND_PATH } = await import('./run.mjs');
    assert.ok(Object.isFrozen(KIT_COMMANDS));
    assert.deepEqual(Object.entries(KIT_COMMANDS), Object.entries(TARGETS));
    assert.equal(KIT_COMMAND_PATH, 'scripts/agent-workflow/run.mjs');
    const deployed = readFamily(HERE).filter((entry) => entry.role === 'deployed').map((entry) => entry.path);
    assert.deepEqual(Object.values(KIT_COMMANDS).filter((target) => !deployed.includes(target)), [], 'every target is a deployed entry');
  });

  it('an import of run.mjs prints nothing and spawns nothing; a direct run through a symlinked entry runs main and sets the exit code', () => {
    const fx = deployment();
    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(join(fx.kit, 'run.mjs')).href)});`],
      { cwd: fx.outside, encoding: 'utf8', env: { ...process.env, KIT_RECORD: join(fx.outside, 'record.json') } });
    assert.deepEqual([imported.status, imported.stdout, imported.stderr, fx.recorded()], [0, '', '', null]);
    const link = join(fx.outside, 'linked-run.mjs');
    symlinkSync(join(fx.kit, 'run.mjs'), link);
    const linked = fx.run(['archive-changelog', '--check'], { KIT_EXIT: '5' }, link);
    assert.equal(linked.status, 5, linked.stderr);
    assert.deepEqual([fx.recorded().file, fx.recorded().argv], [pathToFileURL(at(fx.kit, TARGETS['archive-changelog'])).href, ['--check']]);
  });
});

describe('spec:kit-command/S2 each name runs its target, resolved from run.mjs, with every argument unchanged', () => {
  it('from the kit folder with the cwd outside it: execPath, the target, the arguments in order, the same cwd and env, the child\'s code', () => {
    const fx = deployment();
    const args = ['a b', 'k=v', `--root=${fx.outside}`, '--check'];
    for (const [name, target] of Object.entries(TARGETS)) {
      const r = fx.run([name, ...args], { KIT_PROBE: 'seen' });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.deepEqual(fx.recorded(), { file: pathToFileURL(at(fx.kit, target)).href, exec: process.execPath, argv: args, cwd: fx.outside, probe: 'seen' }, name);
      assert.deepEqual([r.stdout, r.stderr], ['stub-out\n', 'stub-err\n'], `${name}: the child wrote to the inherited streams`);
      assert.equal(existsSync(fx.decoy), false, `${name}: a decoy under the cwd never runs`);
    }
    for (const code of [0, 3]) assert.equal(fx.run(['archive-issues'], { KIT_EXIT: String(code) }).status, code, `the command exits with the child's ${code}`);
  });
});

describe('spec:kit-command/S3 a signal, a spawn error and a missing target each exit 1 with one line', () => {
  it('a child killed by a signal exits 1 with one stderr line naming the name and the signal', async () => {
    const r = deployment().run(['docs-size'], { KIT_SIGNAL: 'SIGTERM' });
    assert.equal(r.status, 1, r.stderr);
    oneLine(r.stderr, 'docs-size', 'SIGTERM');
    const spied = await inProcess(['archive-changelog'], { answer: { status: null, signal: 'SIGKILL' } });
    assert.equal(spied.code, 1);
    oneLine(spied.err, 'archive-changelog', 'SIGKILL');
  });

  it('a spawn error exits 1 with one stderr line naming the name and the error', async () => {
    const answer = { status: null, signal: null, error: Object.assign(new Error('spawn went wrong'), { code: 'EACCES' }) };
    const r = await inProcess(['archive-decisions', '--check'], { answer });
    assert.equal(r.code, 1);
    oneLine(r.err, 'archive-decisions', 'spawn went wrong');
    assert.equal(r.out, '');
  });

  it('a target that is absent or a directory exits 1 with one stderr line naming the name and its deployed path, nothing spawned', async () => {
    const fx = deployment();
    rmSync(at(fx.kit, TARGETS['archive-issues']));
    rmSync(at(fx.kit, TARGETS['install-git-hooks']));
    mkdirSync(at(fx.kit, TARGETS['install-git-hooks']));
    for (const name of ['archive-issues', 'install-git-hooks']) {
      const r = fx.run([name, '--check']);
      assert.equal(r.status, 1, `${name}: ${r.stderr}`);
      oneLine(r.stderr, name, `scripts/agent-workflow/${TARGETS[name]}`);
      assert.deepEqual([r.stdout, fx.recorded()], ['', null], `${name}: nothing ran`);
    }
    const spied = await inProcess(['docs-size'], { isFile: () => false });
    assert.deepEqual([spied.code, spied.calls], [1, []], 'the file check comes before any spawn');
    oneLine(spied.err, 'docs-size', 'scripts/agent-workflow/docs-size/check-docs-size.mjs');
  });
});

describe('spec:kit-command/S4 the usage, help and an unknown name are the command\'s own answers', () => {
  const usage = (text) => { assert.ok(text.includes('scripts/agent-workflow/run.mjs'), text); for (const name of NAMES) assert.ok(text.includes(name), `the usage names ${name}`); };

  it('no name prints the usage on stderr, exit 2; --help or -h first prints it on stdout, exit 0; none spawns', async () => {
    const bare = await inProcess([]);
    assert.deepEqual([bare.code, bare.out, bare.calls], [2, '', []]);
    usage(bare.err);
    for (const flag of ['--help', '-h']) {
      const help = await inProcess([flag]);
      assert.deepEqual([help.code, help.err, help.calls], [0, '', []], flag);
      usage(help.out);
    }
  });

  it('after a name --help and -h reach the target unchanged', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await inProcess(['docs-size', flag, 'x']);
      assert.equal(r.code, 0);
      assert.deepEqual(r.calls.map(({ command, args }) => [command, args]), [[process.execPath, [at(HERE, TARGETS['docs-size']), flag, 'x']]], flag);
    }
  });

  it('an unknown name, constructor and toString included, exits 2 with one stderr line naming it and every known name, nothing spawned', async () => {
    for (const name of ['nope', 'constructor', 'toString', 'hasOwnProperty', 'docs-size/check-docs-size.mjs']) {
      const r = await inProcess([name, '--check']);
      assert.deepEqual([r.code, r.out, r.calls], [2, '', []], name);
      oneLine(r.err, name, ...NAMES);
    }
  });
});

const REPORTER = 'test-reporter/reporter.mjs';
const GIT_DIR = '/work tree/.git';
const runnerFlags = (gitDir, kit) => ['--test', '--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${gitDir}/agent-workflow-lcov.info`,
  `--test-reporter=${pathToFileURL(at(kit, REPORTER)).href}`, '--test-reporter-destination=stdout'];

// A git work tree whose path holds a space, # and %, its kit folder holding run.mjs and the reporter, and two fixtures.
const unitTestsTree = () => {
  const root = tempDir('kit unit #1 %41-');
  const kit = join(root, 'scripts', 'agent-workflow');
  mkdirSync(kit, { recursive: true });
  copyFileSync(join(HERE, 'run.mjs'), join(kit, 'run.mjs'));
  place(at(kit, REPORTER), readFileSync(at(HERE, REPORTER), 'utf8'));
  makeFixtureRepo((args) => {
    const git = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }, root, ['-q']);
  place(join(root, 'tests', 'red.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the red one', () => { assert.equal(1, 2); });\n");
  place(join(root, 'tests', 'green.test.mjs'), "import { test } from 'node:test';\ntest('the green one', () => {});\n");
  const run = (paths, env = {}) => {
    const base = { ...process.env, AW_GIT_DIR: join(root, '.git'), ...env };
    delete base.NODE_TEST_CONTEXT;
    delete base.NODE_V8_COVERAGE;
    const r = spawnSync(process.execPath, [join(kit, 'run.mjs'), 'unit-tests', ...paths], { cwd: root, encoding: 'utf8', env: base });
    if (r.error) throw r.error;
    return r;
  };
  return { root, kit, run };
};

describe('spec:kit-command/S10 unit-tests runs the Node test runner with the lcov reporter and the kit reporter', () => {
  it('UNIT_TESTS_NAME and UNIT_TESTS_REPORTER are exported, the reporter a deployed entry, while KIT_COMMANDS keeps its five names', async () => {
    const { UNIT_TESTS_NAME, UNIT_TESTS_REPORTER, KIT_COMMANDS } = await import('./run.mjs');
    assert.deepEqual([UNIT_TESTS_NAME, UNIT_TESTS_REPORTER], ['unit-tests', REPORTER]);
    assert.deepEqual(Object.keys(KIT_COMMANDS), NAMES);
    const deployed = readFamily(HERE).filter((entry) => entry.role === 'deployed').map((entry) => entry.path);
    assert.ok(deployed.includes(UNIT_TESTS_REPORTER), 'the reporter is a deployed entry of the manifest');
  });

  it('in-process with AW_GIT_DIR the git dir it spawns execPath with the six flags in order, then every argument unchanged', async () => {
    const r = await inProcess(['unit-tests', 'a b', 'tools/*.test.mjs', '--x=1'], { env: { AW_GIT_DIR: GIT_DIR } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.calls.map(({ command, args }) => [command, args]), [[process.execPath, [...runnerFlags(GIT_DIR, HERE), 'a b', 'tools/*.test.mjs', '--x=1']]]);
    const stdio = r.calls[0].options?.stdio;
    assert.deepEqual(stdio === 'inherit' ? [stdio, stdio, stdio] : stdio, ['inherit', 'inherit', 'inherit'], 'the runner inherits the three standard streams');
    assert.equal((await inProcess(['unit-tests'], { env: { AW_GIT_DIR: GIT_DIR }, answer: { status: 4, signal: null } })).code, 4, 'the command exits with the runner\'s code');
  });

  it('as a child over a failing and a passing fixture it prints the FAIL block and the totals line, writes the lcov and exits 1; the passing fixture alone exits 0', () => {
    const tree = unitTestsTree();
    const red = tree.run(['tests/red.test.mjs', 'tests/green.test.mjs']);
    assert.equal(red.status, 1, red.stderr);
    const out = lines(red.stdout);
    assert.ok(out.some((line) => line.startsWith('FAIL tests/red.test.mjs:') && line.includes('the red one')), red.stdout);
    assert.ok(!red.stdout.includes('the green one'), 'no passing-test line');
    assert.match(out.at(-1), /^tests 2 · pass 1 · fail 1 · cancelled 0 · /, 'the totals line closes the output');
    assert.ok(existsSync(join(tree.root, '.git', 'agent-workflow-lcov.info')), 'the lcov lands under AW_GIT_DIR');
    const green = tree.run(['tests/green.test.mjs']);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(lines(green.stdout).at(-1), /^tests 1 · pass 1 · fail 0 · /);
  });
});

describe('spec:kit-command/S11 unit-tests\' own refusals, and the usage naming six names', () => {
  it('AW_GIT_DIR unset or empty prints one stderr line naming it, exit 1, the runner never spawned', async () => {
    for (const env of [{}, { AW_GIT_DIR: '' }]) {
      const r = await inProcess(['unit-tests', 'tools/*.test.mjs'], { env });
      assert.deepEqual([r.code, r.out, r.calls], [1, '', []], JSON.stringify(env));
      oneLine(r.err, 'AW_GIT_DIR');
    }
    const tree = unitTestsTree();
    const child = tree.run(['tests/green.test.mjs'], { AW_GIT_DIR: '' });
    assert.equal(child.status, 1, child.stdout);
    oneLine(child.stderr, 'AW_GIT_DIR');
    assert.equal(existsSync(join(tree.root, '.git', 'agent-workflow-lcov.info')), false, 'nothing spawned, nothing written');
  });

  it('the reporter absent or a directory prints the missing-target line, exit 1, nothing spawned', async () => {
    const spied = await inProcess(['unit-tests'], { env: { AW_GIT_DIR: GIT_DIR }, isFile: () => false });
    assert.deepEqual([spied.code, spied.calls], [1, []]);
    oneLine(spied.err, 'unit-tests', `scripts/agent-workflow/${REPORTER}`);
    for (const shape of ['absent', 'directory']) {
      const tree = unitTestsTree();
      rmSync(at(tree.kit, REPORTER));
      if (shape === 'directory') mkdirSync(at(tree.kit, REPORTER));
      const r = tree.run(['tests/green.test.mjs']);
      assert.deepEqual([r.status, r.stdout], [1, ''], `${shape}: ${r.stderr}`);
      oneLine(r.stderr, 'unit-tests', `scripts/agent-workflow/${REPORTER}`);
    }
  });

  it('a signal and a spawn error answer as for a check', async () => {
    const env = { AW_GIT_DIR: GIT_DIR };
    const signalled = await inProcess(['unit-tests'], { env, answer: { status: null, signal: 'SIGKILL' } });
    assert.equal(signalled.code, 1);
    oneLine(signalled.err, 'unit-tests', 'SIGKILL');
    const failed = await inProcess(['unit-tests'], { env, answer: { status: null, signal: null, error: new Error('spawn went wrong') } });
    assert.equal(failed.code, 1);
    oneLine(failed.err, 'unit-tests', 'spawn went wrong');
  });

  it('the usage and the unknown-name line name all six names', async () => {
    const six = [...NAMES, 'unit-tests'];
    const bare = await inProcess([]);
    for (const name of six) assert.ok(bare.err.includes(name), `the usage names ${name}`);
    const unknown = await inProcess(['nope']);
    oneLine(unknown.err, 'nope', ...six);
  });
});
