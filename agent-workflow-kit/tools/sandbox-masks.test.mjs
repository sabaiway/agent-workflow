// sandbox-masks.test.mjs — the Phase-1.5 cosmetic exclude lane (AD-044 Plan 4, B+D). Masks are
// probe-DERIVED, never a frozen list; on a regular filesystem git never lists devices/FIFOs as
// untracked (probe-proven), so the derivation is exercised through injected walk+lstat deps — the
// same lying-dirent mechanism the sandbox exhibits — over a REAL fixture repo whose write
// mechanics (fence, info/exclude, .gitignore untouched) are asserted on disk.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  main,
  probeSandboxMasks,
  planApply,
  deriveMasks,
  toExcludePattern,
  findMasksFence,
  revalidateFence,
  needsMasksApply,
  MASKS_FENCE_START,
  MASKS_FENCE_END,
} from './sandbox-masks.mjs';

const fakeStat = (type) => ({
  isFile: () => type === 'file',
  isDirectory: () => type === 'dir',
  isSymbolicLink: () => type === 'symlink',
  isCharacterDevice: () => type === 'char',
  isBlockDevice: () => type === 'block',
  isFIFO: () => type === 'fifo',
  isSocket: () => type === 'socket',
});

// Identical committed base for every test — built once, cloned per test (a per-test
// `git init`+commit dominated the fixture cost).
const REPO_TEMPLATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-masks-template-'));
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(dir, 'base.txt'), 'committed\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return dir;
})();
after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-masks-'));
  cpSync(REPO_TEMPLATE, root, { recursive: true });
  return root;
};

// Deps that make the walk report the given paths with the given lstat classes over a real repo —
// the injected twin of the sandbox's lying dirent.
const maskDeps = (classes) => ({
  listUntracked: () => Object.keys(classes),
  lstat: (p) => {
    for (const [rel, type] of Object.entries(classes)) {
      if (p.endsWith(rel)) return fakeStat(type);
    }
    return lstatSync(p);
  },
});

describe('sandbox-masks — derivation classes (the D5 guard is the classifier)', () => {
  it('ONLY the four never-committable classes derive; file/dir/symlink/missing are refused by construction', () => {
    const root = makeRepo();
    const derived = deriveMasks({
      root,
      ...maskDeps({
        '.bashrc': 'char', '.gitconfig': 'block', 'a.fifo': 'fifo', 'b.sock': 'socket',
        'real.txt': 'file', 'somedir': 'dir', 'a-link': 'symlink',
      }),
    });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(derived.masks, ['.bashrc', '.gitconfig', 'a.fifo', 'b.sock'], 'exactly the never-committable classes, sorted');
    assert.deepEqual(derived.unrenderable, []);
  });

  it('a vanished path (lstat throws) never derives', () => {
    const root = makeRepo();
    const derived = deriveMasks({ root, listUntracked: () => ['gone.txt'], lstat: () => { throw new Error('ENOENT'); } });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(derived.masks, []);
  });

  it('a CR/LF-carrying mask name is a LOUD unrenderable skip — never written (review-sandbox-masks-r03-major-01)', () => {
    const root = makeRepo();
    const probe = probeSandboxMasks({ cwd: root, ...maskDeps({ 'evil\nname': 'char', '.bashrc': 'char' }) });
    assert.deepEqual(probe.masks, ['.bashrc'], 'the newline name never enters the writable set');
    assert.deepEqual(probe.unrenderable, ['evil\nname'], 'it is surfaced, not silently dropped');
    const report = main(['--cwd', root], { deps: maskDeps({ 'evil\nname': 'char', '.bashrc': 'char' }) });
    assert.match(report.stdout, /cannot be expressed as ONE exclude rule/);
    const applied = main(['--cwd', root, '--apply'], { deps: maskDeps({ 'evil\nname': 'char', '.bashrc': 'char' }) });
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stderr, /cannot be expressed as ONE exclude rule/, 'the skip stays LOUD on the apply path too');
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.ok(exclude.includes('/.bashrc'), 'the renderable mask still lands');
    assert.ok(!exclude.includes('evil'), 'no fragment of the newline name reaches the exclude file');
  });

  it('an UNREADABLE exclude file fails CLOSED — never treated as empty and overwritten (review-sandbox-masks-r04-major-01)', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), '# existing hand content\n'); // lstat passes; only the READ fails
    const eaccess = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
    const r = main(['--cwd', root, '--apply'], { deps: { ...maskDeps({ '.bashrc': 'char' }), readFile: eaccess } });
    const untouched = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the apply refuses');
    assert.match(r.stderr, /refusing to treat an unreadable exclude file as empty/);
    assert.equal(untouched, '# existing hand content\n', 'zero writes on the fail-closed read');
  });

  it('patterns are root-anchored with glob metacharacters and trailing spaces escaped', () => {
    assert.equal(toExcludePattern('.bashrc'), '/.bashrc');
    assert.equal(toExcludePattern('we?ird[*].txt'), '/we\\?ird\\[\\*\\].txt');
    assert.equal(toExcludePattern('trailing '), '/trailing\\ ');
  });

  it('a TRAILING-TAB mask name is unrenderable (review-sandbox-masks-r12-major-01) and the warning names the tab case (review-sandbox-masks-r13-minor-01)', () => {
    const root = makeRepo();
    const derived = deriveMasks({ root, ...maskDeps({ 'tab-ended\t': 'char', 'mid\tname': 'char' }) });
    const report = main(['--cwd', root], { deps: maskDeps({ 'tab-ended\t': 'char' }) });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(derived.masks, ['mid\tname'], 'a MID-name tab is renderable and stays');
    assert.deepEqual(derived.unrenderable, ['tab-ended\t'], 'the tab-ended name is a loud skip');
    assert.match(report.stdout, /carries a newline or ends with a tab/, 'the warning wording covers the tab case');
  });
});

describe('sandbox-masks — apply mechanics (full-block replace, own fence only)', () => {
  const CLASSES = { '.bashrc': 'char', '.vscode': 'char' };

  it('apply writes the managed block to info/exclude ONLY — .gitignore and everything else untouched', () => {
    const root = makeRepo();
    rmSync(join(root, '.git', 'info', 'exclude'), { force: true }); // absent-leaf lane: both ENOENT arms run
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps(CLASSES) });
    assert.equal(r.code, 0, r.stderr);
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes(MASKS_FENCE_START) && exclude.includes(MASKS_FENCE_END), 'the fence landed');
    assert.ok(exclude.includes('/.bashrc') && exclude.includes('/.vscode'), 'root-anchored patterns inside');
    assert.equal(existsSync(join(root, '.gitignore')), false, 'no .gitignore write — ever');
    rmSync(root, { recursive: true, force: true });
  });

  it('a rerun over an existing fence is IDEMPOTENT (byte-identical file)', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps(CLASSES) });
    const first = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    main(['--cwd', root, '--apply'], { deps: maskDeps(CLASSES) });
    const second = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(second, first);
  });

  it('the replace is FULL-BLOCK: a stale mask drops when the fresh derivation no longer lists it', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps(CLASSES) });
    main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.ok(exclude.includes('/.bashrc'), 'the still-derived mask stays');
    assert.ok(!exclude.includes('/.vscode'), 'the stale mask dropped by construction');
  });

  it('pre-existing hand content OUTSIDE the fence is preserved byte-for-byte', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), '# hand header\n/hand-entry\n');
    main(['--cwd', root, '--apply'], { deps: maskDeps(CLASSES) });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.ok(exclude.startsWith('# hand header\n/hand-entry\n'), 'hand lines stay ahead of the fence');
    assert.ok(exclude.includes(MASKS_FENCE_START), 'the fence appended after them');
  });

  it('a first apply preserves TRAILING BLANK LINES of the hand content byte-exactly (review-sandbox-masks-r05-major-01)', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), '# hand header\n/hand-entry\n\n\n');
    main(['--cwd', root, '--apply'], { deps: maskDeps(CLASSES) });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.ok(exclude.startsWith('# hand header\n/hand-entry\n\n\n'), 'the blank lines are NOT collapsed — only the fenced block is ours');
    assert.ok(exclude.includes(MASKS_FENCE_START));
  });

  it('an existing-block REPLACE preserves CRLF hand bytes outside the fence exactly (review-sandbox-masks-r06-major-01)', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    const handHead = '# hand CRLF header\r\n/hand-entry\r\n';
    const handTail = '# hand CRLF tail\r\n';
    writeFileSync(join(root, '.git', 'info', 'exclude'), `${handHead}${MASKS_FENCE_START}\n/.old-mask\n${MASKS_FENCE_END}\n${handTail}`);
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    assert.equal(r.code, 0, r.stderr);
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.ok(exclude.startsWith(handHead), 'CRLF hand bytes BEFORE the fence are untouched');
    assert.ok(exclude.endsWith(handTail), 'CRLF hand bytes AFTER the fence are untouched');
    assert.ok(exclude.includes('/.bashrc'), 'the fresh block replaced the old one');
    assert.ok(!exclude.includes('/.old-mask'), 'the stale mask dropped');
  });

  it('a REFUSAL still carries the unrenderable warnings (review-sandbox-masks-r05-major-02)', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    // Rerun where the only derivable mask is unrenderable: masks=[], the block is non-empty →
    // refusal — and the newline-name warning must ride the refusal, never be discarded.
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({ 'evil\nname': 'char' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--clear/, 'the refusal itself');
    assert.match(r.stderr, /cannot be expressed as ONE exclude rule/, 'the skip stays loud on the refusal path');
  });
});

describe('sandbox-masks — outside-sandbox / empty-derivation behavior', () => {
  it('empty derivation + NO existing block → stated no-op, exit 0, nothing written', () => {
    const root = makeRepo();
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({}) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /0 masks visible/);
  });

  it('empty derivation + a non-empty block → REFUSES loudly, names --clear, file untouched', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const before = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({}) });
    const after = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'a probably-outside-the-sandbox apply must refuse');
    assert.match(r.stderr, /--clear/, 'the cleanup flag is named');
    assert.equal(after, before, 'the file is untouched on refusal');
  });

  it('--apply --clear intentionally removes the block on an empty derivation', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const r = main(['--cwd', root, '--apply', '--clear'], { deps: maskDeps({}) });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!exclude.includes(MASKS_FENCE_START), 'the managed block is gone');
  });

  it('--apply --clear takes PRECEDENCE over a NON-EMPTY derivation: the block is removed, never re-written', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const r = main(['--cwd', root, '--apply', '--clear'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /managed block removed/, 'the requested clear happens — never a silent block re-write');
    assert.ok(!exclude.includes(MASKS_FENCE_START), 'the block is gone even though masks are visible');
  });

  it('--apply --clear with NO managed block is a stated no-op — nothing is written', () => {
    const root = makeRepo();
    const before = existsSync(join(root, '.git', 'info', 'exclude'))
      ? readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
      : null;
    const r = main(['--cwd', root, '--apply', '--clear'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const after = existsSync(join(root, '.git', 'info', 'exclude'))
      ? readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
      : null;
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /nothing to clear/);
    assert.equal(after, before, 'the exclude file is untouched');
  });

  it('--clear without --apply is a usage error', () => {
    const root = makeRepo();
    const r = main(['--cwd', root, '--clear'], { deps: maskDeps({}) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 2);
  });
});

describe('sandbox-masks — the apply never writes through a symlink or a non-regular leaf (review-sandbox-masks-r02-major-01)', () => {
  it('a SYMLINKED exclude file refuses at the PROBE — never read through, target untouched (review-sandbox-masks-r07-major-01)', () => {
    const root = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'sandbox-masks-outside-'));
    const target = join(outside, 'victim.txt');
    writeFileSync(target, 'must stay intact\n');
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    rmSync(join(root, '.git', 'info', 'exclude'), { force: true }); // git init may pre-seed it
    symlinkSync(target, join(root, '.git', 'info', 'exclude'));
    const probe = main(['--cwd', root], { deps: maskDeps({ '.bashrc': 'char' }) });
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const victim = readFileSync(target, 'utf8');
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.equal(probe.code, 1, 'the read-only probe already refuses (never reads through)');
    assert.match(probe.stderr, /refusing to (read through a symlinked exclude|touch .*symlink)/i);
    assert.equal(r.code, 1, 'the apply refuses');
    assert.equal(victim, 'must stay intact\n', 'the symlink target is never clobbered');
  });

  it('a SYMLINKED .git/info PARENT refuses at the flagless probe — never followed (review-sandbox-masks-r08-major-01)', () => {
    const root = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'sandbox-masks-parent-'));
    writeFileSync(join(outside, 'exclude'), '# reachable only through the symlinked parent\n');
    rmSync(join(root, '.git', 'info'), { recursive: true, force: true });
    symlinkSync(outside, join(root, '.git', 'info'));
    const probe = main(['--cwd', root], { deps: maskDeps({ '.bashrc': 'char' }) });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.equal(probe.code, 1, 'the flagless probe refuses before any read');
    assert.match(probe.stderr, /refusing to touch .*symlink/i);
  });

  it('--apply --clear removes an EMPTY managed block too (review-sandbox-masks-r08-major-02)', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), `# hand\n${MASKS_FENCE_START}\n${MASKS_FENCE_END}\n`);
    const r = main(['--cwd', root, '--apply', '--clear'], { deps: maskDeps({}) });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!exclude.includes(MASKS_FENCE_START), 'the empty fence is gone');
    assert.ok(exclude.startsWith('# hand\n'), 'hand content stays');
  });

  it('a FIFO exclude leaf refuses FAST at the probe — the read that would hang never starts (review-sandbox-masks-r07-major-02)', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    rmSync(join(root, '.git', 'info', 'exclude'), { force: true });
    const mk = spawnSync('mkfifo', [join(root, '.git', 'info', 'exclude')], { encoding: 'utf8' });
    assert.equal(mk.status, 0, mk.stderr);
    const started = Date.now();
    const r = main(['--cwd', root], { deps: maskDeps({ '.bashrc': 'char' }) });
    const elapsed = Date.now() - started;
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /would hang/);
    assert.ok(elapsed < 2000, `the probe returned fast (${elapsed}ms), no FIFO read hang`);
  });

  it('a SYMLINKED info directory refuses', () => {
    const root = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'sandbox-masks-outdir-'));
    rmSync(join(root, '.git', 'info'), { recursive: true, force: true }); // git init pre-seeds it
    symlinkSync(outside, join(root, '.git', 'info'));
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const leaked = existsSync(join(outside, 'exclude'));
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the apply refuses');
    assert.equal(leaked, false, 'nothing lands behind the symlinked directory');
  });

  it('an exclude path that exists as a DIRECTORY refuses (non-regular leaf)', () => {
    const root = makeRepo();
    rmSync(join(root, '.git', 'info', 'exclude'), { force: true }); // git init may pre-seed it
    mkdirSync(join(root, '.git', 'info', 'exclude'), { recursive: true });
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    // The dir-leaf refuses at the fail-closed READ (EISDIR) — before the leaf-shape guard even runs.
    assert.match(r.stderr, /refusing to treat an unreadable exclude file as empty|not a regular file/);
  });
});

describe('sandbox-masks — coverage of the defensive arms', () => {
  it('the REAL unfiltered git walk runs by default (no injected deps) and a plain repo derives zero masks', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'untracked.txt'), 'plain\n');
    const probe = probeSandboxMasks({ cwd: root });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(probe.masks, [], 'a regular untracked file is never a candidate');
    assert.equal(probe.fence.state, 'absent');
  });

  it('an lstat that FAILS on the exclude leaf (not ENOENT) is a fail-closed probe refusal', () => {
    const root = makeRepo();
    const excl = join(root, '.git', 'info', 'exclude');
    const eaccesOn = (p) => {
      if (p === excl) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
      return lstatSync(p);
    };
    const r = main(['--cwd', root], { deps: { listUntracked: () => [], lstat: eaccesOn } });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /refusing to touch|fail-closed/, 'the EACCES propagates as a loud refusal, never an empty read');
  });

  it('--json renders the probe without the raw content/lines fields', () => {
    const root = makeRepo();
    const r = main(['--cwd', root, '--json'], { deps: maskDeps({ '.bashrc': 'char' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.masks, ['.bashrc']);
    assert.equal(parsed.content, undefined, 'raw bytes never leak into the JSON view');
    assert.equal(parsed.lines, undefined);
  });

  it('the APPLY-time duplicate containment guard fires when the chain degrades between probe and write', () => {
    const root = makeRepo();
    const excl = join(root, '.git', 'info', 'exclude');
    const base = maskDeps({ '.bashrc': 'char' });
    let leafHits = 0;
    // The probe walks the chain clean (hits 1-2); from the 3rd leaf-lstat (the apply-time
    // re-check) the mock reports a symlink — modeling a mid-run degrade; the duplicate guard must
    // refuse the WRITE. Non-leaf paths keep the mask-classifying base lstat.
    const flipping = (p) => {
      if (p === excl && ++leafHits >= 3) return fakeStat('symlink');
      return base.lstat(p);
    };
    const r = main(['--cwd', root, '--apply'], { deps: { listUntracked: base.listUntracked, lstat: flipping } });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'the write is refused by the apply-time re-check');
    assert.match(r.stderr, /refusing to (write|touch|read)/);
  });

  it('the direct CLI run (isDirectRun) prints the probe and exits 0', () => {
    const root = makeRepo();
    const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'sandbox-masks.mjs'), '--cwd', root], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sandbox-masks — never-committable untracked masks/);
  });
});

describe('sandbox-masks — unsafe fence fails CLOSED', () => {
  it('a start marker without an end refuses to write and warns loudly on probe', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), `${MASKS_FENCE_START}\n/.bashrc\n`);
    const probe = main(['--cwd', root], { deps: maskDeps({ '.bashrc': 'char' }) });
    assert.equal(probe.code, 0, 'the probe itself stays read-only and reports');
    assert.match(probe.stdout, /MALFORMED/i);
    const before = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    const r = main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const after = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'apply over a malformed fence fails closed');
    assert.match(r.stderr, /malformed/i);
    assert.equal(after, before, 'the file is left unchanged');
  });

  it('duplicated fence markers are malformed', () => {
    const lines = [MASKS_FENCE_START, '/.a', MASKS_FENCE_END, MASKS_FENCE_START, '/.b', MASKS_FENCE_END];
    assert.equal(findMasksFence(lines).state, 'malformed');
  });
});

describe('sandbox-masks — needsMasksApply (the Recommendations advisor fire condition)', () => {
  it('fires on visible masks with NO managed block; quiet when the fenced set matches; fires again on divergence', () => {
    const root = makeRepo();
    const deps = maskDeps({ '.bashrc': 'char' });
    assert.equal(needsMasksApply(probeSandboxMasks({ cwd: root, ...deps })), true, 'absent block + visible masks → apply');
    main(['--cwd', root, '--apply'], { deps });
    assert.equal(needsMasksApply(probeSandboxMasks({ cwd: root, ...deps })), false, 'fenced set == derived set → quiet');
    const grown = maskDeps({ '.bashrc': 'char', '.gitconfig': 'char' });
    assert.equal(needsMasksApply(probeSandboxMasks({ cwd: root, ...grown })), true, 'a NEW mask diverges the sets → apply');
    rmSync(root, { recursive: true, force: true });
  });

  it('fires on a stale-real fenced entry even with zero visible masks; null probe and malformed fence stay quiet', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ 'was-a-mask.txt': 'char' }) });
    writeFileSync(join(root, 'was-a-mask.txt'), 'now a real file\n');
    assert.equal(needsMasksApply(probeSandboxMasks({ cwd: root, listUntracked: () => ['was-a-mask.txt'] })), true, 'stale-real → apply (the fresh derivation drops it)');
    writeFileSync(join(root, '.git', 'info', 'exclude'), `${MASKS_FENCE_START}\n${MASKS_FENCE_START}\n${MASKS_FENCE_END}\n`);
    assert.equal(needsMasksApply(probeSandboxMasks({ cwd: root, ...maskDeps({ '.bashrc': 'char' }) })), false, 'a malformed fence needs a hand fix, not an apply item');
    rmSync(root, { recursive: true, force: true });
    assert.equal(needsMasksApply(null), false, 'off-git (null probe) is N/A, never an item');
  });
});

describe('sandbox-masks — probe (read-only) + revalidation (the D5 watch)', () => {
  it('the flagless probe never writes', () => {
    const root = makeRepo();
    const r = main(['--cwd', root], { deps: maskDeps({ '.bashrc': 'char' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\.bashrc/);
    assert.match(r.stdout, /--apply/, 'the exact apply one-liner is offered');
  });

  it('a fenced entry that became a REAL path is loudly flagged (delete before git add)', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ 'was-a-mask.txt': 'char' }) });
    writeFileSync(join(root, 'was-a-mask.txt'), 'now a real file\n');
    const r = main(['--cwd', root], { deps: { listUntracked: () => ['was-a-mask.txt'] } });
    rmSync(root, { recursive: true, force: true });
    assert.match(r.stdout, /became a REAL path: was-a-mask\.txt/);
    assert.match(r.stdout, /silently skipped by bulk staging/, 'the watch note states the REAL danger — bulk git add skips excluded paths');
  });

  it('a CRLF-saved fence body still revalidates (review-sandbox-masks-r05-major-03)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'was-a-mask.txt'), 'now a real file\n');
    const stale = revalidateFence(['/was-a-mask.txt\r'], { root });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(stale, ['was-a-mask.txt'], 'the CR is stripped before the lstat — the real path IS flagged');
  });

  it('revalidateFence: a vanished mask is NOT flagged (the next apply drops it silently)', () => {
    const root = makeRepo();
    const stale = revalidateFence(['/gone-mask'], { root });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(stale, []);
  });

  it('a TRAILING-SPACE mask round-trips: derived, escaped, re-parsed, revalidated — never corrupted (review-sandbox-masks-r01-major-01)', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ 'trailing ': 'char' }) });
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes('/trailing\\ '), 'the escaped trailing-space pattern is written');
    const again = probeSandboxMasks({ cwd: root, ...maskDeps({ 'trailing ': 'char' }) });
    assert.deepEqual(again.staleReal, [], 'the fenced trailing-space entry revalidates against its real path (round-trip)');
    assert.equal(planApply(again).content, readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').replace(/\n$/, '\n'), 'a rerun is byte-stable');
    writeFileSync(join(root, 'trailing '), 'now a real file\n');
    const flagged = probeSandboxMasks({ cwd: root, deps: undefined, listUntracked: () => ['trailing '] });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(flagged.staleReal, ['trailing '], 'a real file at the trailing-space path IS flagged (the parse sees the true name)');
  });

  it('the FLAGLESS probe renders the --clear form for a stale-real-only fence (the plain apply would refuse)', () => {
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ 'was-mask': 'char' }) });
    writeFileSync(join(root, 'was-mask'), 'now a real file\n');
    const r = main(['--cwd', root], { deps: { listUntracked: () => [] } });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /became a REAL path: was-mask/, 'the stale-real warning renders');
    assert.ok(r.stdout.includes('--apply --clear'), 'the rendered one-liner is the form planApply actually accepts here');
  });

  it('the rendered apply one-liner shell-quotes a root with spaces/metacharacters (review-sandbox-masks-r01-major-02)', () => {
    const base = mkdtempSync(join(tmpdir(), 'sandbox masks '));
    const root = join(base, 'repo');
    mkdirSync(root);
    const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    const probe = probeSandboxMasks({ cwd: root, ...maskDeps({ '.bashrc': 'char' }) });
    rmSync(base, { recursive: true, force: true });
    assert.match(probe.applyCmd, /--cwd '.*sandbox masks .*'/, 'the spaced cwd rides single quotes — a dead/unsafe paste is impossible');
  });

  it('an already-excluded mask stays visible to a rerun (the walk runs WITHOUT standard excludes)', () => {
    // The dep-injected walk models `git ls-files --others` (no --exclude-standard): a mask hidden
    // by an earlier apply is still listed, so the full-block replace re-derives it — pinned here
    // as apply→apply idempotence WITH the fence already hiding the path from status.
    const root = makeRepo();
    main(['--cwd', root, '--apply'], { deps: maskDeps({ '.bashrc': 'char' }) });
    const probe = probeSandboxMasks({ cwd: root, ...maskDeps({ '.bashrc': 'char' }) });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(probe.masks, ['.bashrc'], 'the fenced mask is still derived on the rerun');
    assert.equal(planApply(probe).action, 'replaced');
  });
});
