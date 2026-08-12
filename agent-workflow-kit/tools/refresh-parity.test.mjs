// refresh-parity.test.mjs — the FULL parity domain (feedback-hardening Plan 1 F3 / D3+D4).
// The scanner is ONE walk read two ways, so its buckets are pinned here directly: what an absent /
// symlinked / non-regular / unreadable placed node classifies as, for a FILE and for a DIRECTORY.
// The verdict and the composed line are pinned beside them, so "no clause without its check" is a
// property this file can fail rather than a sentence a comment claims.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, readFileSync, lstatSync,
  readdirSync, chmodSync, existsSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  PARITY, READONLY_RERUN_HINT, WRAPPER_MODE, scanBundleOwnedDrift, scanWrapperParity, parityVerdict,
  unverifiableParity, readonlySkipLine,
} from './refresh-parity.mjs';

const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'awf-parity-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// The injectable fs surface the scanner reads through; `over` replaces one primitive per case.
// `exists` is here because the symlink branch MIRRORS copyTreeRefresh's own predicate.
const fsOf = (over = {}) => ({
  lstat: lstatSync, readdir: readdirSync, readFile: readFileSync, readlink: readlinkSync,
  exists: existsSync, realpath: realpathSync, ...over,
});

// The scan's own empty result. `modes` is the seam the wrapper axis reads a source's mode from, so a
// clean tree still carries one entry per reached regular file.
const NOTHING_FOUND = (modes = []) => ({ drifted: [], unreadable: [], absent: [], conflicts: [], modes: new Map(modes) });
const EVERY_FILE = [['SKILL.md', 0o100644], ['bin/run.sh', 0o100644]];

// A two-file bundle (`SKILL.md` + `bin/run.sh`) and a placed copy of the same bytes: the byte-equal
// baseline every case below perturbs in exactly one way.
const seedPair = () => {
  const bundleDir = join(tmp, 'bundle');
  const skillDir = join(tmp, 'skill');
  for (const root of [bundleDir, skillDir]) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# bridge\n');
    writeFileSync(join(root, 'bin', 'run.sh'), '#!/bin/sh\necho hi\n');
  }
  return { bundleDir, skillDir };
};

const scan = (dirs, over) => scanBundleOwnedDrift(dirs.bundleDir, dirs.skillDir, fsOf(over));

describe('scanBundleOwnedDrift — one walk, four buckets', () => {
  it('a byte-equal tree reports nothing at all (the clean baseline is not vacuous — it walked both files)', () => {
    const dirs = seedPair();
    const seen = [];
    const result = scan(dirs, { readFile: (p, e) => { seen.push(p); return readFileSync(p, e); } });
    assert.deepEqual(result, NOTHING_FOUND(EVERY_FILE));
    assert.ok(seen.includes(join(dirs.skillDir, 'SKILL.md')) && seen.includes(join(dirs.skillDir, 'bin', 'run.sh')),
      'both placed files were really compared');
  });

  it('differing placed bytes → drifted, by relative path', () => {
    const dirs = seedPair();
    writeFileSync(join(dirs.skillDir, 'bin', 'run.sh'), '#!/bin/sh\necho edited\n');
    assert.deepEqual(scan(dirs).drifted, ['bin/run.sh']);
  });

  it('an ABSENT placed file → its own bucket (an ADD to the refresh, DRIFT to the parity reading)', () => {
    const dirs = seedPair();
    rmSync(join(dirs.skillDir, 'SKILL.md'));
    const result = scan(dirs);
    assert.deepEqual(result.absent, ['SKILL.md']);
    assert.deepEqual(result.drifted, [], 'the scan itself makes no drift claim about an absent file');
  });

  it('RED-FOLD a SYMLINKED placed file → conflict (the guard refuses the leaf), and its target is never read through', () => {
    const dirs = seedPair();
    const secret = join(tmp, 'secret.txt');
    writeFileSync(secret, 'not ours\n');
    rmSync(join(dirs.skillDir, 'SKILL.md'));
    symlinkSync(secret, join(dirs.skillDir, 'SKILL.md'));
    const reads = [];
    const result = scan(dirs, { readFile: (p, e) => { reads.push(p); return readFileSync(p, e); } });
    assert.deepEqual(result.conflicts, ['SKILL.md (a symlink is in the way)']);
    assert.deepEqual(result.unreadable, [], 'unreadable is for genuine read/stat errors only');
    assert.ok(!reads.includes(secret) && !reads.includes(join(dirs.skillDir, 'SKILL.md')), 'no read-through');
  });

  // copyFile onto a directory is EISDIR; a device or FIFO may be WRITTEN INTO or block instead of
  // being replaced. Either way a rerun cannot be guaranteed to converge the node — a refusal, not an
  // unknown.
  it('RED-FOLD a NON-REGULAR placed node where the bundle ships a file → conflict', () => {
    const dirs = seedPair();
    rmSync(join(dirs.skillDir, 'SKILL.md'));
    mkdirSync(join(dirs.skillDir, 'SKILL.md'));
    const result = scan(dirs);
    assert.deepEqual(result.conflicts, ['SKILL.md (a node of the wrong kind is in the way)']);
    assert.deepEqual(result.unreadable, []);
  });

  it('an unreadable placed file (read fails after a good lstat) → unreadable, never a crash', () => {
    const dirs = seedPair();
    const target = join(dirs.skillDir, 'SKILL.md');
    assert.deepEqual(scan(dirs, { readFile: (p, e) => { if (p === target) throw eacces(); return readFileSync(p, e); } }).unreadable, ['SKILL.md']);
  });

  it('a placed-path STAT error (not ENOENT) → unreadable, never silently equal', () => {
    const dirs = seedPair();
    const target = join(dirs.skillDir, 'SKILL.md');
    assert.deepEqual(scan(dirs, { lstat: (p) => { if (p === target) throw eacces(); return lstatSync(p); } }).unreadable, ['SKILL.md']);
  });

  it('an ABSENT placed DIRECTORY → each bundled child lands in absent, named by path', () => {
    const dirs = seedPair();
    rmSync(join(dirs.skillDir, 'bin'), { recursive: true });
    const result = scan(dirs);
    assert.deepEqual(result.absent, ['bin/run.sh']);
    assert.deepEqual(result.unreadable, []);
  });

  it('RED-FOLD a SYMLINKED placed DIRECTORY → conflict, and the walk never descends through it', () => {
    const dirs = seedPair();
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'run.sh'), 'foreign\n');
    rmSync(join(dirs.skillDir, 'bin'), { recursive: true });
    symlinkSync(elsewhere, join(dirs.skillDir, 'bin'));
    const reads = [];
    const result = scan(dirs, { readFile: (p, e) => { reads.push(p); return readFileSync(p, e); } });
    assert.deepEqual(result.conflicts, ['bin (a symlink is in the way)']);
    assert.deepEqual(result.unreadable, []);
    assert.deepEqual(result.drifted, [], 'no child of a symlinked dir may be compared');
    assert.ok(!reads.some((p) => p.includes('elsewhere')), 'the link target was never read');
  });

  it('RED-FOLD a NON-DIRECTORY placed node where the bundle ships a dir → conflict (mkdir -p is EEXIST), no descent', () => {
    const dirs = seedPair();
    rmSync(join(dirs.skillDir, 'bin'), { recursive: true });
    writeFileSync(join(dirs.skillDir, 'bin'), 'a file where a dir belongs\n');
    assert.deepEqual(scan(dirs).conflicts, ['bin (a non-directory is in the way)']);
  });

  it('an ABSENT placed dir for an EMPTY bundled dir → the DIR itself is absent (nothing below it to name)', () => {
    const dirs = seedPair();
    mkdirSync(join(dirs.bundleDir, 'empty'));
    assert.deepEqual(scan(dirs).absent, ['empty'], 'a writable refresh would mkdir it — an unnamed absence is an unproven clean');
  });

  // copyTreeRefresh is ADDITIVE for a symlink src (fs-safe.mjs: `if (exists(dest)) return; symlink(...)`),
  // so the parity rule is asymmetric — the rerun would CREATE an absent one and would not touch an
  // existing node of any kind.
  it('a bundled SYMLINK whose placed node EXISTS is not drift (the refresh would never overwrite it)', () => {
    const dirs = seedPair();
    symlinkSync(join(dirs.bundleDir, 'SKILL.md'), join(dirs.bundleDir, 'alias.md'));
    writeFileSync(join(dirs.skillDir, 'alias.md'), 'anything at all\n');
    assert.deepEqual(scan(dirs), NOTHING_FOUND(EVERY_FILE),
      'left alone WITHOUT comparison — neither drift nor a finding, and never entered in modes');
  });

  // assertContainedRealPath reduces over rel.split(sep) INCLUDING the leaf, so the guard refuses ANY
  // placed symlink at a node in the reconcile-set — the writer never reaches its own exists() check.
  it('RED-FOLD a bundled SYMLINK over a placed symlink → conflict whether it dangles or resolves', () => {
    for (const target of ['gone.md', 'SKILL.md']) {
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      const dirs = seedPair();
      symlinkSync(join(dirs.bundleDir, 'SKILL.md'), join(dirs.bundleDir, 'alias.md'));
      symlinkSync(join(dirs.skillDir, target), join(dirs.skillDir, 'alias.md'));
      const result = scan(dirs);
      assert.deepEqual(result.conflicts, ['alias.md (a symlink is in the way)'], `placed symlink → ${target}`);
      assert.deepEqual(result.absent, [], 'the rerun would NOT create it');
    }
  });

  it('a bundled SYMLINK with NO placed node → absent (a writable rerun would create it)', () => {
    const dirs = seedPair();
    symlinkSync(join(dirs.bundleDir, 'SKILL.md'), join(dirs.bundleDir, 'alias.md'));
    assert.deepEqual(scan(dirs).absent, ['alias.md']);
  });

  it('a bundled symlink whose placed path cannot be stat-ed → unverifiable, never assumed present', () => {
    const dirs = seedPair();
    symlinkSync(join(dirs.bundleDir, 'SKILL.md'), join(dirs.bundleDir, 'alias.md'));
    const placedAlias = join(dirs.skillDir, 'alias.md');
    assert.deepEqual(scan(dirs, { lstat: (p) => { if (p === placedAlias) throw eacces(); return lstatSync(p); } }).unreadable, ['alias.md'],
      'a stat error is the ONE thing unreadable still means');
  });

  it('a BUNDLE read failure is NOT swallowed — a corrupt kit is a loud error upstream', () => {
    const dirs = seedPair();
    const target = join(dirs.bundleDir, 'SKILL.md');
    assert.throws(
      () => scan(dirs, { lstat: (p) => { if (p === target) throw eacces(); return lstatSync(p); } }),
      (err) => err.code === 'EACCES',
    );
  });
});

describe('scanWrapperParity — the axis the read-only degrade never reconciled', () => {
  // A managed wrapper in its repaired state: a source at WRAPPER_MODE and our symlink onto it.
  const seedWrapper = () => {
    const skillDir = join(tmp, 'skill');
    const bindir = join(tmp, 'bin');
    mkdirSync(join(skillDir, 'bin'), { recursive: true });
    mkdirSync(bindir, { recursive: true });
    const source = join(skillDir, 'bin', 'run.sh');
    writeFileSync(source, '#!/bin/sh\n');
    chmodSync(source, WRAPPER_MODE);
    const dst = join(bindir, 'run');
    symlinkSync(source, dst);
    return { links: [{ cmd: 'run', source, dst }], source, dst, skillDir, bindir };
  };

  const fresh = () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    return seedWrapper();
  };

  // What the reconcile-set walk would have recorded for this source. The wrapper axis reads the mode
  // from HERE, never from a stat of its own — that is the whole point of the seam.
  const walked = (mode = 0o100755) => new Map([['bin/run.sh', mode]]);
  const parity = (w, over, modes) => scanWrapperParity(w.links, fsOf(over), { skillDir: w.skillDir, modes: modes ?? walked() });

  const NOTHING = { drifted: [], conflicts: [], unverifiable: [] };

  it('our symlink onto a source at WRAPPER_MODE is parity (and an empty link set is trivially parity)', () => {
    assert.deepEqual(parity(seedWrapper()), NOTHING);
    assert.deepEqual(scanWrapperParity([], fsOf(), { skillDir: tmp, modes: new Map() }), NOTHING);
  });

  it('an ABSENT link → drifted, named with its axis (the link step would create it)', () => {
    const w = seedWrapper();
    rmSync(w.dst);
    assert.deepEqual(parity(w).drifted, ['wrapper run (not linked)']);
  });

  // linkManaged replaces ONLY a symlink already pointing at our source, so a rerun REFUSES either
  // conflict class rather than repairing it.
  it('a conflicting target is NOT repairable drift — its own list, labeled with the cause', () => {
    const squat = fresh();
    rmSync(squat.dst);
    writeFileSync(squat.dst, 'a real file\n');
    const nonSymlink = parity(squat);
    assert.deepEqual(nonSymlink.drifted, [], 'a rerun would not repair it');
    assert.deepEqual(nonSymlink.conflicts, ['wrapper run (a non-symlink is in the way)']);

    const w = fresh();
    const foreign = join(tmp, 'foreign.sh');
    writeFileSync(foreign, '#!/bin/sh\n');
    rmSync(w.dst);
    symlinkSync(foreign, w.dst);
    const reads = [];
    const result = parity(w, { readFile: (p, e) => { reads.push(p); return readFileSync(p, e); } });
    assert.deepEqual(result.drifted, []);
    assert.deepEqual(result.conflicts, ['wrapper run (a foreign symlink is in the way)']);
    assert.deepEqual(reads, [], 'a foreign target is never opened — the compare is on the link string');
  });

  // linkWrappers canonicalises the bindir through realpath BEFORE it links, so a relative target must
  // resolve against the PHYSICAL parent. A lexical base answers a different question and, at a
  // different nesting depth, a different answer: it would call our own link foreign.
  it('RED-FOLD a RELATIVE target under a SYMLINKED bindir resolves against the physical parent', () => {
    const w = fresh();
    const realBin = join(tmp, 'nested', 'realbin');
    mkdirSync(realBin, { recursive: true });
    rmSync(w.dst);
    rmSync(w.bindir, { recursive: true });
    symlinkSync(realBin, w.bindir);
    symlinkSync(relative(realBin, w.source), join(realBin, 'run'));
    assert.deepEqual(parity(w), NOTHING, 'our own link, read through the symlinked bindir, is still ours');
  });

  it('RED-FOLD a realpath failure on the link directory → unverifiable, never a lexical fallback', () => {
    const w = fresh();
    rmSync(w.dst);
    symlinkSync(relative(w.bindir, w.source), w.dst);
    const result = parity(w, { realpath: () => { throw eacces(); } });
    assert.deepEqual(result.unverifiable, ['wrapper run (its link directory could not be resolved)']);
    assert.deepEqual(result.conflicts, [], 'guessing lexically could call a foreign link ours');
  });

  it('a source mode other than the one the link step sets → drifted (a rerun chmods it back)', () => {
    for (const mode of [0o100644, 0o100700, 0o100777]) {
      const w = fresh();
      assert.deepEqual(parity(w, {}, walked(mode)).drifted, ['wrapper run (its source mode differs)'],
        `mode ${(mode & 0o7777).toString(8)} is a state a writable rerun changes — executable-enough is not parity`);
    }
  });

  // The source is bundle-owned, so the reconcile-set walk already classified its existence and shape
  // and already named it if anything was wrong. Reporting it again here would name one broken file
  // twice under two different names — and a second stat could traverse an ancestor the walk refused.
  it('RED-FOLD a source the WALK never reached yields NO wrapper-source entry (no double-report)', () => {
    const w = fresh();
    rmSync(w.source);
    const stats = [];
    const result = parity(w, { lstat: (p) => { stats.push(p); return lstatSync(p); } }, new Map());
    assert.deepEqual(result, NOTHING, 'the file scan owns existence and shape — this axis owns only the mode');
    assert.ok(!stats.includes(w.source), 'and the axis never stats the source itself');
  });

  it('a stat/readlink failure on the link → unverifiable, named with its axis', () => {
    const w = seedWrapper();
    const onDst = parity(w, { lstat: (p) => { if (p === w.dst) throw eacces(); return lstatSync(p); } });
    assert.deepEqual(onDst, { ...NOTHING, unverifiable: ['wrapper run (its link could not be read)'] });
    const onLink = parity(w, { readlink: () => { throw eacces(); } });
    assert.deepEqual(onLink, { ...NOTHING, unverifiable: ['wrapper run (its link target could not be read)'] });
  });

  // The two axes are INDEPENDENT: a wrapper broken on one and drifted on the other must state BOTH.
  it('RED-FOLD the link and the source are classified independently — one wrapper can ride TWO lists', () => {
    const w = fresh();
    const foreign = join(tmp, 'foreign.sh');
    writeFileSync(foreign, '#!/bin/sh\n');
    rmSync(w.dst);
    symlinkSync(foreign, w.dst);
    const both = parity(w, {}, walked(0o100700));
    assert.deepEqual(both.conflicts, ['wrapper run (a foreign symlink is in the way)']);
    assert.deepEqual(both.drifted, ['wrapper run (its source mode differs)'],
      'a proven refusal on one axis never silences a proven finding on the other');
  });

  it('WRAPPER_MODE is the ONE definition the link step and this check share', () => {
    assert.equal(WRAPPER_MODE, 0o755, 'the mode linkWrappers chmods to — two spellings could disagree silently');
  });
});

describe('parityVerdict — the calm claim is withheld, never inverted', () => {
  const noWrappers = { drifted: [], conflicts: [], unverifiable: [] };
  const noScan = { drifted: [], unreadable: [], absent: [], conflicts: [] };

  it('both axes empty → clean-parity', () => {
    assert.deepEqual(parityVerdict({ scan: noScan, wrappers: noWrappers }), { state: PARITY.clean, drifted: [], conflicts: [], unverifiable: [] });
  });

  it('a conflict ALONE still breaks parity — it rides its own list, never the repairable one', () => {
    const v = parityVerdict({ scan: noScan, wrappers: { ...noWrappers, conflicts: ['wrapper run (a foreign symlink is in the way)'] } });
    assert.equal(v.state, PARITY.drifted, 'something is provably wrong, so the calm claim is withheld');
    assert.deepEqual(v.drifted, [], 'and it is NOT promised as repairable');
    assert.deepEqual(v.conflicts, ['wrapper run (a foreign symlink is in the way)']);
  });

  it('the scan\'s ABSENT bucket is DRIFT in this reading (the two readings differ by exactly this)', () => {
    const v = parityVerdict({ scan: { ...noScan, absent: ['NEW.md'] }, wrappers: noWrappers });
    assert.equal(v.state, PARITY.drifted);
    assert.deepEqual(v.drifted, ['NEW.md']);
  });

  it('an unreadable node alone → unverifiable (never counted as equal)', () => {
    const v = parityVerdict({ scan: { ...noScan, unreadable: ['SKILL.md'] }, wrappers: noWrappers });
    assert.equal(v.state, PARITY.unverifiable);
    assert.deepEqual(v.unverifiable, ['SKILL.md']);
  });

  it('wrapper AND file findings join, each on the list that matches its recovery', () => {
    const v = parityVerdict({
      scan: { drifted: ['SKILL.md'], unreadable: ['bin'], absent: ['NEW.md'], conflicts: ['alias.md (a dangling symlink is in the way)'] },
      wrappers: { drifted: ['wrapper run (not linked)'], conflicts: ['wrapper probe (a non-symlink is in the way)'], unverifiable: ['wrapper doc (its source could not be read)'] },
    });
    assert.equal(v.state, PARITY.drifted, 'a proven break outranks an unknown for the headline');
    assert.deepEqual(v.drifted, ['NEW.md', 'SKILL.md', 'wrapper run (not linked)']);
    assert.deepEqual(v.conflicts, ['alias.md (a dangling symlink is in the way)', 'wrapper probe (a non-symlink is in the way)'],
      'the scanner has a refusal class of its own now — it must reach the same list');
    assert.deepEqual(v.unverifiable, ['bin', 'wrapper doc (its source could not be read)']);
  });
});

describe('readonlySkipLine — every clause maps to the verdict that proved it', () => {
  const clean = { state: PARITY.clean, drifted: [], conflicts: [], unverifiable: [] };

  it('clean-parity → the calm claim, and NO alarm clause', () => {
    const line = readonlySkipLine('codex-cli-bridge', '1.0.0', clean);
    assert.match(line, /already current \(v1\.0\.0\)/);
    assert.match(line, /read-only this session/);
    assert.match(line, /no refresh-managed difference to repair/);
    assert.match(line, /every file the refresh would overwrite already matches/, 'a rerun DOES rewrite byte-equal files — the claim is about managed DIFFERENCE, not about changing nothing');
    assert.match(line, /every node it would add is present/);
    assert.match(line, /every wrapper link and source mode is in place/, 'each checked axis is named, not generalised');
    assert.match(line, /difference to repair/);
    for (const alarm of [/incomplete/i, /PARTIALLY/, /failed/i, /persists/i, /may be/i]) {
      assert.ok(!alarm.test(line), `the calm line carries no ${alarm} clause`);
    }
    assert.ok(!line.includes(READONLY_RERUN_HINT), 'nothing to repair ⇒ no repair instruction');
  });

  it('an unknown version renders no version clause at all (never "vnull")', () => {
    assert.match(readonlySkipLine('codex-cli-bridge', null, clean), /^ {2}codex-cli-bridge: already current — /);
  });

  it('drifted → the count, EVERY name, and the writable-rerun recovery', () => {
    const line = readonlySkipLine('codex-cli-bridge', '1.0.0', { state: PARITY.drifted, drifted: ['SKILL.md', 'wrapper run'], conflicts: [], unverifiable: [] });
    assert.match(line, /2 item\(s\) still differing from the bundled copy: SKILL\.md, wrapper run/);
    assert.ok(line.includes(`${READONLY_RERUN_HINT} to repair`));
    assert.ok(!/no drift|nothing to repair/.test(line));
  });

  it('a CONFLICT never rides the rerun-repairs-it promise — it gets the resolve-by-hand recovery', () => {
    const only = readonlySkipLine('codex-cli-bridge', '1.0.0', { state: PARITY.drifted, drifted: [], conflicts: ['wrapper run (a foreign symlink is in the way)'], unverifiable: [] });
    assert.match(only, /REFUSE rather than repair: wrapper run \(a foreign symlink is in the way\)/);
    assert.match(only, /resolve each by hand, then re-run/);
    assert.ok(!only.includes(`${READONLY_RERUN_HINT} to repair`), 'a refusal is never promised as a rerun repair');

    const both = readonlySkipLine('codex-cli-bridge', '1.0.0', { state: PARITY.drifted, drifted: ['SKILL.md'], conflicts: ['wrapper run (a non-symlink is in the way)'], unverifiable: [] });
    assert.match(both, /1 item\(s\) still differing from the bundled copy: SKILL\.md/, 'the repairable half keeps its own recovery');
    assert.ok(both.includes(`${READONLY_RERUN_HINT} to repair`));
    assert.match(both, /REFUSE rather than repair: wrapper run \(a non-symlink is in the way\)/);
  });

  it('drifted AND unverifiable → BOTH proven facts are stated, neither collapsed into the other', () => {
    const line = readonlySkipLine('codex-cli-bridge', '1.0.0', { state: PARITY.drifted, drifted: ['SKILL.md'], conflicts: [], unverifiable: ['bin'] });
    assert.match(line, /1 item\(s\) still differing from the bundled copy: SKILL\.md/);
    assert.match(line, /could not verify a further 1 item\(s\): bin/);
  });

  it('the unknown clause NEVER loses its meaning or its recovery to a preceding sentence', () => {
    const withConflict = readonlySkipLine('codex-cli-bridge', '1.0.0', { state: PARITY.drifted, drifted: [], conflicts: ['wrapper run (a non-symlink is in the way)'], unverifiable: ['bin'] });
    assert.match(withConflict, /REFUSE rather than repair: wrapper run \(a non-symlink is in the way\)/);
    assert.match(withConflict, /could not verify a further 1 item\(s\): bin — whether those still need repair is unknown/,
      'a list of names with no statement of what is unknown about them is not a clause');
    assert.ok(withConflict.includes(READONLY_RERUN_HINT));

    const allThree = readonlySkipLine('codex-cli-bridge', '1.0.0', {
      state: PARITY.drifted, drifted: ['SKILL.md'], conflicts: ['wrapper run (a foreign symlink is in the way)'], unverifiable: ['bin'],
    });
    assert.match(allThree, /1 item\(s\) still differing from the bundled copy: SKILL\.md/);
    assert.match(allThree, /It also found 1 item\(s\) a writable rerun would REFUSE rather than repair/);
    assert.match(allThree, /It could not verify a further 1 item\(s\): bin — whether those still need repair is unknown/);
    assert.match(allThree, /resolve each by hand, then re-run the refresh\./, 'the refusal keeps its own recovery');
  });

  it('unverifiable → says so by name, claims neither clean nor broken', () => {
    const line = readonlySkipLine('codex-cli-bridge', '1.0.0', { state: PARITY.unverifiable, drifted: [], conflicts: [], unverifiable: ['SKILL.md'] });
    assert.match(line, /could NOT verify 1 item\(s\): SKILL\.md/);
    assert.match(line, /unknown/);
    assert.ok(!/no drift|nothing to repair|still differing/.test(line));
    assert.ok(line.includes(READONLY_RERUN_HINT));
  });

  it('unverifiableParity is the honest floor a caller reaches for when the re-scan itself fails', () => {
    const v = unverifiableParity('the placed tree (EACCES)');
    assert.equal(v.state, PARITY.unverifiable);
    assert.match(readonlySkipLine('codex-cli-bridge', '1.0.0', v), /could NOT verify 1 item\(s\): the placed tree \(EACCES\)/);
  });
});
