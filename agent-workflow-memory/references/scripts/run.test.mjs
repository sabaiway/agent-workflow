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
const inProcess = async (argv, { answer = { status: 0, signal: null }, isFile } = {}) => {
  const { main } = await import('./run.mjs');
  const calls = [];
  const streams = { out: '', err: '' };
  const deps = {
    spawn: (command, args, options) => { calls.push({ command, args, options }); return answer; },
    stdout: { write: (text) => { streams.out += text; return true; } },
    stderr: { write: (text) => { streams.err += text; return true; } },
    ...(isFile ? { isFile } : {}),
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
