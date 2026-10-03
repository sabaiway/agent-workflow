import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The command is loaded dynamically, so the suite loads on a tree without it and each cell fails at its first call.
const loaded = await import('../jev-skill.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const VENDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'references', 'vendor', 'typesafe-ai');
const LF = '\n';
const TAG = 'v0.5.7';
const AFTER_INSTALL = 'After an install, quit the agent and start it again from a new terminal.';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The vendored pair is read guarded, so the suite loads on a tree without it and each cell fails on its own.
const vendorRead = (name) => { try { return readFileSync(join(VENDOR, name)); } catch { return Buffer.from(`the vendored ${name} is absent\n`); } };
const CURRENT = { 'SKILL.md': vendorRead('SKILL.md.pinned'), LICENSE: vendorRead('LICENSE') };
const OLDER = { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.6\n'), LICENSE: Buffer.from('MIT at v0.5.6\n') };
const pinOf = (tag, pair) => ({ tag, commit: tag, digests: { 'SKILL.md': digest(pair['SKILL.md']), LICENSE: digest(pair.LICENSE) } });
const PINS = [pinOf(TAG, CURRENT), pinOf('v0.5.6', OLDER)];
const KIT_DIR = /^\.typesafe-ai\.kit-(tmp|old)-/;

const made = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});
const tempHome = () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-skill-apply-'));
  made.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  return home;
};
const fill = (dir, pair) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(pair)) writeFileSync(join(dir, name), bytes);
};
const targetsOf = (home) => ({
  codex: join(home, '.agents', 'skills', 'typesafe-ai'),
  claude: join(home, '.claude', 'skills', 'typesafe-ai'),
  agy: join(home, '.gemini', 'config', 'skills', 'typesafe-ai'),
});
const PARENTS = (home) => [join(home, '.agents'), join(home, '.claude'), join(home, '.gemini', 'config')];
const kitDirsIn = (home) => PARENTS(home).flatMap((parent) => (existsSync(parent) ? readdirSync(parent) : [])
  .filter((name) => KIT_DIR.test(name)).map((name) => join(parent, name)));
const pairOf = (dir) => ({ 'SKILL.md': readFileSync(join(dir, 'SKILL.md')), LICENSE: readFileSync(join(dir, 'LICENSE')) });
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
  const code = main(argv, { env: {}, platform: 'linux', toolsDir: '/kit/tools', pins: PINS, log: (text) => out.push(text),
    error: (text) => err.push(text), ...io });
  return { code, stdout: out, stderr: err };
};
// The dry run's state per target, read from its target lines: the agreement check every cell makes before and after.
const statesOf = (home, io = {}) => run([], { home, ...io }).stdout.filter((line) => / at .* — /.test(line) && !line.startsWith('leftover'))
  .map((line) => line.split(':')[1].trim().split(' ')[0]);
// An io.lstat that runs `act` on the n-th visit of `path`, then answers as lstat does.
const lstatActing = (path, visit, act) => {
  let seen = 0;
  return (at) => {
    if (at === path) {
      seen += 1;
      if (seen === visit) act();
    }
    return lstatSync(at);
  };
};

describe('spec:jev-guide/S33 the apply on a temp home', () => {
  it('installs an absent target, creates its root 0700, replaces an earlier copy, keeps a current one and leaves no kit directory', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.claude, OLDER);
    fill(at.agy, CURRENT);
    assert.deepEqual(statesOf(home), ['absent', 'earlier', 'current']);
    const minted = [];
    const result = run(['--apply'], { home, mkdtemp: (prefix) => { const dir = mkdtempSync(prefix); minted.push(dir); return dir; } });
    assert.equal(result.code, 0, result.stdout.join(LF));
    assert.deepEqual(result.stdout, [
      `pin: ${TAG}, commit ${TAG}`,
      `installed: ${at.codex} (${TAG})`,
      `replaced: ${at.claude} (v0.5.6 → ${TAG})`,
      `kept: ${at.agy} (${TAG})`,
      'done — 1 installed, 1 replaced, 1 kept, 0 left untouched, 0 refused.',
      AFTER_INSTALL,
    ]);
    for (const dir of [join(home, '.agents'), join(home, '.agents', 'skills')]) assert.equal(lstatSync(dir).mode & 0o777, 0o700, dir);
    for (const target of Object.values(at)) assert.deepEqual(pairOf(target), CURRENT, target);
    assert.deepEqual(statesOf(home), ['current', 'current', 'current']);
    assert.deepEqual(kitDirsIn(home), []);
    assert.equal(minted.length, 3, 'a temp dir per write and one aside dir');
    for (const dir of minted) {
      assert.ok(PARENTS(home).includes(dirname(dir)), `minted in a root's parent: ${dir}`);
      assert.ok(!Object.values(at).some((target) => dir.startsWith(dirname(target))), `never inside a root: ${dir}`);
    }
  });

  it('leaves a foreign target and a linked root untouched with their reasons, writing nothing under them', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.codex, { ...CURRENT, 'notes.txt': 'mine\n' });
    const elsewhere = join(dirname(home), 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    symlinkSync(elsewhere, join(home, '.gemini', 'config', 'skills'));
    const before = [hashTree(at.codex), hashTree(elsewhere)];
    const result = run(['--apply'], { home });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      `pin: ${TAG}, commit ${TAG}`,
      `left untouched: ${at.codex} — holds LICENSE, SKILL.md, notes.txt`,
      `installed: ${at.claude} (${TAG})`,
      `left untouched: ${at.agy} — a link at ${join(home, '.gemini', 'config', 'skills')}`,
      'done — 1 installed, 0 replaced, 0 kept, 2 left untouched, 0 refused.',
      AFTER_INSTALL,
    ]);
    assert.deepEqual([hashTree(at.codex), hashTree(elsewhere)], before);
    assert.deepEqual(statesOf(home), ['foreign', 'current', 'foreign']);
  });

  it('prints no AFTER_INSTALL when nothing was installed or replaced', () => {
    const home = tempHome();
    for (const target of Object.values(targetsOf(home))) fill(target, CURRENT);
    const result = run(['--apply'], { home });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.at(-1), 'done — 0 installed, 0 replaced, 3 kept, 0 left untouched, 0 refused.');
  });

  it('a claude dir of <home>/.agents installs the merged target once and counts it once', () => {
    const home = tempHome();
    const result = run(['--apply', '--claude-dir', join(home, '.agents')], { home });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.filter((line) => line.startsWith('installed: ')), [
      `installed: ${targetsOf(home).codex} (${TAG})`, `installed: ${targetsOf(home).agy} (${TAG})`]);
    assert.equal(result.stdout.at(-2), 'done — 2 installed, 0 replaced, 0 kept, 0 left untouched, 0 refused.');
  });

  it('refuses a target that changes between the plan and the rename into place, removes its temp dir and goes on, exit 4', () => {
    const home = tempHome();
    const at = targetsOf(home);
    mkdirSync(dirname(at.codex), { recursive: true });
    assert.deepEqual(statesOf(home), ['absent', 'absent', 'absent']);
    const lstat = lstatActing(at.codex, 2, () => { mkdirSync(at.codex); writeFileSync(join(at.codex, 'raced.txt'), 'raced\n'); });
    const result = run(['--apply'], { home, lstat });
    assert.equal(result.code, 4);
    assert.deepEqual(result.stdout.slice(1, 4), [
      `refused: ${at.codex} — changed since the plan: now foreign`,
      `installed: ${at.claude} (${TAG})`,
      `installed: ${at.agy} (${TAG})`,
    ]);
    assert.equal(result.stdout[4], 'done — 2 installed, 0 replaced, 0 kept, 0 left untouched, 1 refused.');
    assert.deepEqual(readdirSync(at.codex), ['raced.txt'], 'left as it was');
    assert.deepEqual(kitDirsIn(home), []);
    assert.deepEqual(statesOf(home), ['foreign', 'current', 'current']);
  });

  it('refuses an earlier target that changes before its aside rename, leaving it and no kit directory', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.claude, OLDER);
    for (const target of [at.codex, at.agy]) fill(target, CURRENT);
    const lstat = lstatActing(at.claude, 2, () => writeFileSync(join(at.claude, 'raced.txt'), 'raced\n'));
    const result = run(['--apply'], { home, lstat });
    assert.equal(result.code, 4);
    assert.ok(result.stdout.includes(`refused: ${at.claude} — changed since the plan: now foreign`), result.stdout.join(LF));
    assert.ok(!result.stdout.some((line) => line.startsWith('kept aside')));
    assert.deepEqual(readdirSync(at.claude).sort(), ['LICENSE', 'SKILL.md', 'raced.txt']);
    assert.deepEqual(pairOf(at.claude), OLDER);
    assert.deepEqual(kitDirsIn(home), []);
  });

  it('a rename that throws EEXIST whenever its destination exists completes every install and replace', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.claude, OLDER);
    const rename = (from, to) => {
      if (existsSync(to)) throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' });
      renameSync(from, to);
    };
    const result = run(['--apply'], { home, rename });
    assert.equal(result.code, 0, result.stdout.join(LF));
    assert.equal(result.stdout.at(-2), 'done — 2 installed, 1 replaced, 0 kept, 0 left untouched, 0 refused.');
    assert.deepEqual(statesOf(home), ['current', 'current', 'current']);
  });

  it('refuses a rename that throws EXDEV with its code, the target left absent', () => {
    const home = tempHome();
    const at = targetsOf(home);
    const rename = (from, to) => {
      if (to === at.agy) throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
      renameSync(from, to);
    };
    const result = run(['--apply'], { home, rename });
    assert.equal(result.code, 4);
    assert.ok(result.stdout.includes(`refused: ${at.agy} — EXDEV`), result.stdout.join(LF));
    assert.deepEqual(statesOf(home), ['current', 'current', 'absent']);
    assert.deepEqual(kitDirsIn(home), []);
  });
});

describe('spec:jev-guide/S34 interruption and leftovers', () => {
  it('lists fixture-built leftovers in a root\'s parent, never removes or writes into them, and installs beside them', () => {
    const home = tempHome();
    const at = targetsOf(home);
    const tmp = join(home, '.agents', '.typesafe-ai.kit-tmp-k1t');
    const old = join(home, '.claude', '.typesafe-ai.kit-old-k2t');
    const user = join(home, '.gemini', 'config', '.typesafe-ai.kit-tmp-u5r');
    fill(join(tmp, 'typesafe-ai'), CURRENT);
    fill(join(old, 'typesafe-ai'), OLDER);
    fill(user, { 'mine.txt': 'the user\'s own file\n' });
    const before = [tmp, old, user].map(hashTree);
    const lines = [tmp, old, user].map((path) => `leftover: ${path} — not removed; delete it by hand`);
    const dry = run([], { home });
    assert.deepEqual(dry.stdout.filter((line) => line.startsWith('leftover: ')), lines);
    assert.deepEqual(statesOf(home), ['absent', 'absent', 'absent']);
    const applied = run(['--apply'], { home });
    assert.equal(applied.code, 0);
    assert.deepEqual(applied.stdout.filter((line) => line.startsWith('leftover: ')), lines);
    assert.deepEqual([tmp, old, user].map(hashTree), before);
    assert.deepEqual(statesOf(home), ['current', 'current', 'current']);
    assert.deepEqual(kitDirsIn(home).sort(), [tmp, old, user].sort(), 'only the fixture\'s leftovers remain');
  });

  it('a failed rename into place renames the aside copy back after a re-check reading absent', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.codex, OLDER);
    const rename = (from, to) => {
      if (to === at.codex && from.includes('.kit-tmp-')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      renameSync(from, to);
    };
    const result = run(['--apply'], { home, rename });
    assert.equal(result.code, 4);
    assert.equal(result.stdout[1], `refused: ${at.codex} — EIO`);
    assert.ok(!result.stdout.some((line) => line.startsWith('kept aside')));
    assert.deepEqual(pairOf(at.codex), OLDER);
    assert.equal(statesOf(home)[0], 'earlier');
    assert.deepEqual(kitDirsIn(home), []);
  });

  it('when the rename back fails too, the kept-aside line names the aside path and the target stays absent', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.codex, OLDER);
    const rename = (from, to) => {
      if (to === at.codex) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      renameSync(from, to);
    };
    const result = run(['--apply'], { home, rename });
    assert.equal(result.code, 4);
    assert.equal(result.stdout[1], `refused: ${at.codex} — EIO`);
    const [aside] = kitDirsIn(home);
    assert.match(aside, /\.typesafe-ai\.kit-old-/);
    assert.equal(result.stdout[2], `kept aside: ${join(aside, 'typesafe-ai')} — EIO`);
    assert.deepEqual(pairOf(join(aside, 'typesafe-ai')), OLDER);
    assert.equal(statesOf(home)[0], 'absent');
  });

  it('a file created at the target after the aside rename keeps the aside copy, leaves the file and removes only the temp dir', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.codex, OLDER);
    for (const target of [at.claude, at.agy]) fill(target, CURRENT);
    const lstat = lstatActing(at.codex, 3, () => writeFileSync(at.codex, 'raced\n'));
    const result = run(['--apply'], { home, lstat });
    assert.equal(result.code, 4);
    const [aside] = kitDirsIn(home);
    assert.match(aside, /\.typesafe-ai\.kit-old-/);
    assert.deepEqual(result.stdout.slice(1, 3), [
      `refused: ${at.codex} — changed since the plan: now foreign`,
      `kept aside: ${join(aside, 'typesafe-ai')} — the target is now foreign`,
    ]);
    assert.deepEqual(pairOf(join(aside, 'typesafe-ai')), OLDER, 'the aside copy whole');
    assert.equal(readFileSync(at.codex, 'utf8'), 'raced\n', 'the file at the target untouched');
    assert.deepEqual(kitDirsIn(home), [aside], 'only the temp dir removed');
  });

  it('an aside copy that re-verifies as other than earlier is kept with the kept-aside line', () => {
    const home = tempHome();
    const at = targetsOf(home);
    fill(at.codex, OLDER);
    const rename = (from, to) => {
      renameSync(from, to);
      if (from === at.codex) writeFileSync(join(to, 'LICENSE'), 'a byte changed\n');
    };
    const result = run(['--apply'], { home, rename });
    assert.equal(result.code, 0);
    const [aside] = kitDirsIn(home);
    assert.deepEqual(result.stdout.slice(1, 3), [
      `replaced: ${at.codex} (v0.5.6 → ${TAG})`,
      `kept aside: ${join(aside, 'typesafe-ai')} — it reads foreign`,
    ]);
    assert.deepEqual(pairOf(at.codex), CURRENT);
  });
});
