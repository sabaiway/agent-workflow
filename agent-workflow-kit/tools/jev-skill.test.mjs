import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The command is loaded dynamically, so the suite loads on a tree without it and each cell fails at its first call.
const loaded = await import('./jev-skill.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const TOOLS = dirname(fileURLToPath(import.meta.url));
const CLI = join(TOOLS, 'jev-skill.mjs');
const VENDOR = resolve(TOOLS, '..', 'references', 'vendor', 'typesafe-ai');
const TOOLS_DIR = '/kit tools/dir';
const LF = '\n';
const TAG = 'v0.5.7';
const PIN_LINE = `pin: ${TAG}, commit 65a39f393687675ce170e6094757de20370365b9`;
const NO_APPLY_LINE = 'the apply line cannot be printed here: a path holds a control character';
const REFUSED = (file) => `refused: the kit's own copy of ${file} is missing, unreadable or does not match the pin — nothing written`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The vendored pair is read guarded, so the suite loads on a tree without it and each cell fails on its own.
const vendorRead = (name) => { try { return readFileSync(join(VENDOR, name)); } catch { return Buffer.from(`the vendored ${name} is absent\n`); } };
const CURRENT = { 'SKILL.md': vendorRead('SKILL.md.pinned'), LICENSE: vendorRead('LICENSE') };
const OLDER = { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.6\n'), LICENSE: Buffer.from('MIT at v0.5.6\n') };
const pinOf = (tag, commit, pair) => ({ tag, commit, digests: { 'SKILL.md': digest(pair['SKILL.md']), LICENSE: digest(pair.LICENSE) } });
const PINS = [pinOf(TAG, '65a39f393687675ce170e6094757de20370365b9', CURRENT), pinOf('v0.5.6', 'older', OLDER)];

const made = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});
const tempHome = () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-skill-cmd-'));
  made.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  return home;
};
const fill = (dir, pair) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(pair)) writeFileSync(join(dir, name), bytes);
};
const targetsOf = (home, claude = join(home, '.claude')) => ({
  codex: join(home, '.agents', 'skills', 'typesafe-ai'),
  claude: join(claude, 'skills', 'typesafe-ai'),
  agy: join(home, '.gemini', 'config', 'skills', 'typesafe-ai'),
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
    else entries.push(`${head}:${digest(readFileSync(at))}`);
  };
  walk(path);
  return digest(entries.join(LF));
};
const run = (argv, io) => {
  const out = [];
  const err = [];
  const code = main(argv, { env: {}, platform: 'linux', toolsDir: TOOLS_DIR, pins: PINS, log: (text) => out.push(text),
    error: (text) => err.push(text), ...io });
  return { code, stdout: out, stderr: err };
};
// Every primitive throws and every env read is recorded: a run that reads nothing passes untouched.
const untouchable = () => {
  const reads = [];
  const no = (name) => (path) => { reads.push(`${name} ${path}`); throw new Error(`${name} read`); };
  const env = new Proxy({}, { get: (target, prop) => { reads.push(`env ${String(prop)}`); return undefined; } });
  return { reads, io: { env, lstat: no('lstat'), readdir: no('readdir'), readFile: no('readFile'), mkdir: no('mkdir'),
    mkdtemp: no('mkdtemp'), write: no('write'), rename: no('rename'), rm: no('rm'), home: '/never' } };
};

describe('spec:jev-guide/S32 the dry run and the exit table', () => {
  it('a dry run over one absent, one current and one earlier target writes nothing and prints the plan, the counts and the apply line', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.claude, CURRENT);
    fill(at.agy, OLDER);
    const before = hashTree(home);
    const result = run([], { home });
    assert.equal(result.code, 0, result.stderr.join(LF));
    assert.equal(hashTree(home), before);
    assert.deepEqual(result.stdout, [
      PIN_LINE,
      `Codex: absent at ${at.codex} — install`,
      `Claude Code: current at ${at.claude} — ${TAG}, keep`,
      `Antigravity CLI: earlier at ${at.agy} — v0.5.6, replace with ${TAG}`,
      'dry run — nothing written. Planned: 1 to install, 1 to replace, 1 kept, 0 left untouched.',
      'To install, run in a terminal of your own:',
      `node '${TOOLS_DIR}/jev-skill.mjs' --apply --claude-dir ${join(home, '.claude')}`,
    ]);
  });

  it('a foreign target is left untouched with its reason, and with nothing to install no apply line is printed', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.codex, { ...CURRENT, '.DS_Store': 'meta\n' });
    fill(at.claude, CURRENT);
    fill(at.agy, CURRENT);
    const result = run([], { home });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      PIN_LINE,
      `Codex: foreign at ${at.codex} — holds .DS_Store, LICENSE, SKILL.md, left untouched`,
      `Claude Code: current at ${at.claude} — ${TAG}, keep`,
      `Antigravity CLI: current at ${at.agy} — ${TAG}, keep`,
      'dry run — nothing written. Planned: 0 to install, 0 to replace, 2 kept, 1 left untouched.',
    ]);
  });

  it('lists a kit-tmp and a kit-old directory in a root\'s parent as leftovers, never removing them', () => {
    const home = tempHome();
    const tmp = join(home, '.agents', '.typesafe-ai.kit-tmp-AbC123');
    const old = join(home, '.gemini', 'config', '.typesafe-ai.kit-old-XyZ789');
    fill(join(tmp, 'typesafe-ai'), CURRENT);
    fill(join(old, 'typesafe-ai'), OLDER);
    const before = hashTree(home);
    const result = run([], { home });
    assert.equal(hashTree(home), before);
    const leftovers = result.stdout.filter((line) => line.startsWith('leftover: '));
    assert.deepEqual(leftovers, [`leftover: ${tmp} — not removed; delete it by hand`, `leftover: ${old} — not removed; delete it by hand`]);
    assert.ok(result.stdout.indexOf(leftovers[0]) > result.stdout.findIndex((line) => line.startsWith('Antigravity CLI: ')));
    assert.ok(result.stdout.indexOf(leftovers[1]) < result.stdout.findIndex((line) => line.startsWith('dry run — ')));
  });

  it('prints the note exactly for a relative CLAUDE_CONFIG_DIR without --claude-dir, and the apply line carries the effective dir', () => {
    const home = tempHome();
    const note = `CLAUDE_CONFIG_DIR is set to rel/cc, not an absolute path: the Claude Code target is ${join(home, '.claude')}`;
    const relative = run([], { home, env: { CLAUDE_CONFIG_DIR: 'rel/cc' } });
    assert.deepEqual(relative.stdout.slice(0, 2), [PIN_LINE, note]);
    assert.equal(relative.stdout.at(-1), `node '${TOOLS_DIR}/jev-skill.mjs' --apply --claude-dir ${join(home, '.claude')}`);
    const given = join(dirname(home), 'cc');
    const overridden = run(['--claude-dir', given], { home, env: { CLAUDE_CONFIG_DIR: 'rel/cc' } });
    assert.ok(!overridden.stdout.includes(note), 'no note under --claude-dir');
    assert.ok(overridden.stdout.includes(`Claude Code: absent at ${join(given, 'skills', 'typesafe-ai')} — install`));
    assert.equal(overridden.stdout.at(-1), `node '${TOOLS_DIR}/jev-skill.mjs' --apply --claude-dir ${given}`);
    const fromEnv = run([], { home, env: { CLAUDE_CONFIG_DIR: given } });
    assert.ok(!fromEnv.stdout.some((line) => line.startsWith('CLAUDE_CONFIG_DIR')));
    assert.equal(fromEnv.stdout.at(-1), `node '${TOOLS_DIR}/jev-skill.mjs' --apply --claude-dir ${given}`);
  });

  it('prints NO_APPLY_LINE in the apply line\'s place for a --claude-dir holding a tab', () => {
    const home = tempHome();
    const result = run(['--claude-dir', join(dirname(home), `c${String.fromCharCode(9)}c`)], { home });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.slice(-2), ['To install, run in a terminal of your own:', NO_APPLY_LINE]);
    assert.ok(result.stdout.some((line) => line.includes('c?c')), 'the path prints through printable');
  });

  it('--help and -h alone print the usage at exit 0 and read nothing', () => {
    for (const flag of ['--help', '-h']) {
      const { reads, io } = untouchable();
      const result = run([flag], io);
      assert.equal(result.code, 0);
      assert.match(result.stdout.join(LF), /^jev-skill — /);
      assert.match(result.stdout.join(LF), /Exit codes:/);
      assert.deepEqual(reads, [], flag);
    }
  });

  it('exits 2 with nothing read for an unknown argument, --claude-dir without a value or not absolute, and help with anything', () => {
    for (const argv of [['--bogus'], ['--claude-dir'], ['--claude-dir', '--apply'], ['--claude-dir', 'rel/cc'], ['--claude-dir', 'C:\\cc'],
      ['--help', '--apply'], ['-h', '-h'], ['--apply', '--help']]) {
      const { reads, io } = untouchable();
      const result = run(argv, io);
      assert.equal(result.code, 2, argv.join(' '));
      assert.equal(result.stderr.length, 1, argv.join(' '));
      assert.deepEqual(result.stdout, [], argv.join(' '));
      assert.deepEqual(reads, [], argv.join(' '));
    }
    const win = run(['--claude-dir', 'C:\\cc', '--help'], { platform: 'win32' });
    assert.equal(win.code, 2);
  });

  it('exits 1 with the kit-copy refusal and nothing written when the kit\'s own pair fails its check, with and without --apply', () => {
    const vendorOf = (change) => {
      const dir = join(dirname(tempHome()), 'vendor');
      mkdirSync(dir);
      copyFileSync(join(VENDOR, 'SKILL.md.pinned'), join(dir, 'SKILL.md.pinned'));
      copyFileSync(join(VENDOR, 'LICENSE'), join(dir, 'LICENSE'));
      return change(dir);
    };
    const CASES = {
      'a SKILL.md.pinned that differs': () => vendorOf((dir) => { writeFileSync(join(dir, 'SKILL.md.pinned'), 'changed\n'); return [dir, 'SKILL.md.pinned']; }),
      'a LICENSE that differs': () => vendorOf((dir) => { writeFileSync(join(dir, 'LICENSE'), 'changed\n'); return [dir, 'LICENSE']; }),
      'a missing file': () => vendorOf((dir) => { rmSync(join(dir, 'LICENSE')); return [dir, 'LICENSE']; }),
      'a file that cannot be read': () => vendorOf((dir) => [dir, 'SKILL.md.pinned', (path) => {
        if (path === join(dir, 'SKILL.md.pinned')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return readFileSync(path);
      }]),
    };
    for (const [name, build] of Object.entries(CASES)) {
      for (const argv of [[], ['--apply']]) {
        const home = tempHome();
        const [vendorDir, file, readFile] = build();
        const before = hashTree(home);
        const result = run(argv, { home, vendorDir, ...(readFile ? { readFile } : {}) });
        assert.equal(result.code, 1, `${name} ${argv}`);
        assert.deepEqual([...result.stdout, ...result.stderr], [REFUSED(file)], `${name} ${argv}`);
        assert.equal(hashTree(home), before, `${name} ${argv}`);
      }
    }
  });

  it('exits 1 with nothing written for an empty home', () => {
    for (const argv of [[], ['--apply']]) {
      const root = dirname(tempHome());
      const before = hashTree(root);
      const result = run(argv, { home: '' });
      assert.equal(result.code, 1);
      assert.deepEqual([...result.stdout, ...result.stderr], ['refused: no home directory found — nothing written']);
      assert.equal(hashTree(root), before);
    }
  });

  it('with no injected home the dry run reads the host home: HOME at a temp dir, its targets planned, nothing written', () => {
    const home = tempHome();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(homedir(), home);
      const before = hashTree(home);
      const result = run([], {});
      assert.equal(result.code, 0, result.stderr.join(LF));
      assert.equal(result.stdout[1], `Codex: absent at ${targetsOf(home).codex} — install`);
      assert.equal(hashTree(home), before);
    } finally {
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
  });

  it('main returns its code and never exits; the direct run answers --help at exit 0', () => {
    const exitCode = process.exitCode;
    assert.equal(run(['--bogus'], {}).code, 2);
    assert.equal(process.exitCode, exitCode);
    const home = tempHome();
    const env = { ...process.env, HOME: home };
    delete env.NODE_TEST_CONTEXT;
    delete env.CLAUDE_CONFIG_DIR;
    const spawned = spawnSync(process.execPath, [CLI, '--help'], { env, encoding: 'utf8' });
    assert.equal(spawned.status, 0, spawned.stderr);
    assert.match(spawned.stdout, /^jev-skill — /);
    const usage = spawnSync(process.execPath, [CLI, '--bogus'], { env, encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.deepEqual(readdirSync(home), [], 'the spawned runs wrote nothing');
  });
});
