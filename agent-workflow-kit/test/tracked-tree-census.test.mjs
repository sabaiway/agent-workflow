// tracked-tree-census.test.mjs — the tracked-tree census leaf (tools/tracked-tree-census.mjs).
//
// The claims pinned here:
//   • the verdict fires on STRICT DOMINANCE only — a tie or a lone shim never raises an item a
//     project cannot act on;
//   • the parse is NUL-split, so a filename carrying a tab / newline / quote / non-ASCII byte is
//     ONE path classified by its real extension — git's C-quoted form would misread every one;
//   • an unavailable census THROWS (the caller's stated-skip lane), never a silent verdict;
//   • the acknowledged FACT is stable under counts-only growth and changes exactly when a new
//     unsupported extension arrives or the verdict flips.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CENSUS_VERDICT, censusFact, takeCensus } from '../tools/tracked-tree-census.mjs';

const ROOTS = [];
after(() => { for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true }); });

// A real git tree: the census reads TRACKED files, so the fixture commits nothing but DOES add.
const mkTracked = (relPaths) => {
  const root = mkdtempSync(join(tmpdir(), 'tracked-census-'));
  ROOTS.push(root);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x\n');
  }
  const added = git('add', '-A');
  assert.equal(added.status, 0, `the fixture must really track its files: ${added.stderr}`);
  return root;
};

describe('tracked-tree-census — the strict-dominance verdict', () => {
  it('STRICTLY more unsupported than assessable is narrow', () => {
    const census = takeCensus(mkTracked(['src/a.ts', 'src/b.ts', 'src/c.tsx', 'scripts/one.mjs']));
    assert.equal(census.verdict, CENSUS_VERDICT.NARROW);
    assert.equal(census.counts.unsupported, 3);
    assert.equal(census.counts.assessable, 1);
    assert.deepEqual(census.unsupportedExtensions, ['.ts', '.tsx'], 'sorted, de-duplicated');
  });

  it('a TIE is not dominance — the verdict stays within-domain', () => {
    const census = takeCensus(mkTracked(['src/a.ts', 'src/b.ts', 'scripts/one.mjs', 'scripts/two.js']));
    assert.equal(census.counts.unsupported, census.counts.assessable);
    assert.equal(census.verdict, CENSUS_VERDICT.WITHIN_DOMAIN);
  });

  it('a lone .d.ts shim beside a real JS tree is a MINORITY — silent, though it counts as unsupported', () => {
    const census = takeCensus(mkTracked(['types/globals.d.ts', 'src/a.mjs', 'src/b.cjs', 'src/c.js']));
    assert.equal(census.counts.unsupported, 1, 'a .d.ts is unsupported like any other .ts — the classification has no exceptions');
    assert.deepEqual(census.unsupportedExtensions, ['.ts']);
    assert.equal(census.verdict, CENSUS_VERDICT.WITHIN_DOMAIN);
  });

  it('an EMPTY tracked tree is within-domain, not a narrow one (0 is not more than 0)', () => {
    const census = takeCensus(mkTracked([]));
    assert.equal(census.total, 0);
    assert.equal(census.verdict, CENSUS_VERDICT.WITHIN_DOMAIN);
  });

  it('tests are EXCLUDED from both populations, whichever language they are in', () => {
    const census = takeCensus(mkTracked(['src/a.test.ts', 'src/b.spec.ts', 'src/c.test.mjs', 'src/real.ts', 'src/real.mjs']));
    assert.equal(census.counts['excluded-test'], 3);
    assert.equal(census.counts.unsupported, 1);
    assert.equal(census.counts.assessable, 1);
    assert.equal(census.verdict, CENSUS_VERDICT.WITHIN_DOMAIN, 'a tie of the REAL sources — the excluded tests tilt nothing');
  });

  it('everything outside both sets is counted as out-of-domain and judged by neither', () => {
    const census = takeCensus(mkTracked(['README.md', 'Makefile', '.gitignore', 'main.py', 'src/a.ts', 'src/b.ts']));
    assert.equal(census.counts['out-of-domain'], 4);
    assert.equal(census.counts.assessable, 0);
    assert.equal(census.verdict, CENSUS_VERDICT.NARROW, 'dominance is unsupported vs assessable — out-of-domain never votes');
    assert.equal(census.total, 6, 'every tracked path is accounted for exactly once');
  });
});

describe('tracked-tree-census — the NUL parse survives awkward filenames', () => {
  it('a tab / newline / quote / non-ASCII name is ONE path, classified by its real extension', () => {
    // git C-QUOTES exactly these paths in its plain output (`"src/\303\251.ts"`), and a
    // newline-split of that form would both misread the extension and invent a second entry. The
    // -z form emits raw bytes; this fixture is what proves the split is on NUL, not on newline.
    const awkward = ['src/with\ttab.ts', 'src/with\nnewline.ts', 'src/with"quote.ts', 'src/h\u00e9llo.ts', 'src/plain.mjs'];
    const census = takeCensus(mkTracked(awkward));
    assert.equal(census.total, 5, 'five tracked paths, not four and not six');
    assert.equal(census.counts.unsupported, 4);
    assert.equal(census.counts.assessable, 1);
    assert.deepEqual(census.unsupportedExtensions, ['.ts'], 'no phantom extension from a split fragment');
  });
});

describe('tracked-tree-census — the listing is per FILE, not per index entry', () => {
  it('paths with DIFFERENT invalid UTF-8 bytes stay different files — the de-dup reads bytes, not text', () => {
    // Decoding before de-duplicating turns every invalid sequence into U+FFFD, so `src/<ff>.ts` and
    // `src/<fe>.ts` become one string and the fix for an OVER-count silently becomes an UNDER-count.
    // The listing is bytes; identity is bytes.
    const stdout = Buffer.concat([
      Buffer.from('src/a', 'utf8'), Buffer.from([0xff]), Buffer.from('.ts\0', 'utf8'),
      Buffer.from('src/a', 'utf8'), Buffer.from([0xfe]), Buffer.from('.ts\0', 'utf8'),
      Buffer.from('scripts/one.mjs\0', 'utf8'),
    ]);
    const census = takeCensus('/anywhere', { spawn: () => ({ status: 0, stdout }) });
    assert.equal(census.total, 3, 'three distinct tracked paths, not two');
    assert.equal(census.counts.unsupported, 2);
    assert.equal(census.counts.assessable, 1);
    assert.equal(census.verdict, CENSUS_VERDICT.NARROW, 'and the dominance the real tree has is preserved');
  });

  it('a BYTE-identical duplicate is still collapsed (the de-dup did not become a no-op)', () => {
    const one = Buffer.concat([Buffer.from('src/a', 'utf8'), Buffer.from([0xff]), Buffer.from('.ts\0', 'utf8')]);
    const census = takeCensus('/anywhere', { spawn: () => ({ status: 0, stdout: Buffer.concat([one, one, one]) }) });
    assert.equal(census.total, 1);
  });

  it('a conflicted path listed once per merge stage counts ONCE — a merge never flips the verdict', () => {
    // `git ls-files` lists per INDEX ENTRY: during an unresolved content conflict one path appears
    // three times (stages 1/2/3, probed). Counting those inflates a population, and on a tie that is
    // enough to mint `domain-narrow` on nothing but a merge in progress.
    const conflicted = ['src/a.ts', 'src/a.ts', 'src/a.ts', 'src/b.mjs'];
    const spawn = () => ({ status: 0, stdout: `${conflicted.join('\0')}\0` });
    const census = takeCensus('/anywhere', { spawn });
    assert.equal(census.total, 2, 'two FILES, however many index entries');
    assert.equal(census.counts.unsupported, 1);
    assert.equal(census.counts.assessable, 1);
    assert.equal(census.verdict, CENSUS_VERDICT.WITHIN_DOMAIN, 'the tie survives the merge');
  });
});

describe('tracked-tree-census — an unavailable census throws, never guesses', () => {
  it('a NON-git directory throws the tagged unavailability (the caller states a skip)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tracked-census-nongit-'));
    ROOTS.push(root);
    assert.throws(() => takeCensus(root), (err) => err.code === 'CENSUS_UNAVAILABLE' && /unavailable/.test(err.message));
  });

  it('a git that cannot be spawned at all throws the same way (fail closed, never within-domain)', () => {
    const spawn = () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' });
    assert.throws(() => takeCensus('/anywhere', { spawn }), (err) => err.code === 'CENSUS_UNAVAILABLE' && /ENOENT/.test(err.message));
  });
});

describe('tracked-tree-census — the acknowledged FACT', () => {
  const factOf = (paths) => censusFact(takeCensus(mkTracked(paths)));

  it('is STABLE under counts-only growth — an added file of a known kind never re-fires an ack', () => {
    const before = factOf(['src/a.ts', 'src/b.ts', 'scripts/one.mjs']);
    const after = factOf(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'scripts/one.mjs']);
    assert.equal(after, before);
  });

  it('CHANGES when a new unsupported extension arrives', () => {
    const before = factOf(['src/a.ts', 'src/b.ts', 'scripts/one.mjs']);
    const after = factOf(['src/a.ts', 'src/b.ts', 'src/c.tsx', 'scripts/one.mjs']);
    assert.notEqual(after, before);
  });

  it('CHANGES when the verdict flips back to within-domain', () => {
    const narrow = factOf(['src/a.ts', 'src/b.ts', 'scripts/one.mjs']);
    const within = factOf(['src/a.ts', 'scripts/one.mjs', 'scripts/two.mjs']);
    assert.notEqual(within, narrow);
    assert.match(narrow, /^domain-narrow:/);
    assert.match(within, /^within-domain:/);
  });
});
