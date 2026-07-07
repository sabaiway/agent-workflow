// changed-surface.test.mjs — the NEUTRAL shared read-only core (BUGFREE-2 / AD-048, D4 + D8).
// Pins the D4 counted classes (assessable + unsupported source count; excluded-test and
// out-of-domain never do; pure deletions are free), the fail-closed knob parser home, the tolerant
// telemetry row reader, and the single-home re-exports (probeVerdict / resolveResultsPath keep ONE
// implementation across the neutral module and fold-completeness.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  classifyChangedPath,
  parseUnifiedDiff,
  unquoteDiffPath,
  computeChangedSurface,
  countCapLines,
  readFileSafe,
  isRegularLeaf,
  parsePositiveIntKnob,
  probeVerdict,
  resolveResultsPath,
  RESULTS_BASENAME,
  readJsonlRows,
} from './changed-surface.mjs';
import {
  probeVerdict as reExportedProbeVerdict,
  resolveResultsPath as reExportedResolveResultsPath,
  RESULTS_BASENAME as reExportedBasename,
} from './fold-completeness.mjs';
import {
  classifyChangedPath as runnerClassify,
  parseUnifiedDiff as runnerParse,
  unquoteDiffPath as runnerUnquote,
  computeChangedSurface as runnerSurface,
} from './fold-completeness-run.mjs';

// A dirty git fixture: one committed base, then a mixed working set covering every counted class.
const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'changed-surface-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  return { root, g };
};

describe('computeChangedSurface + countCapLines — the D4 counted classes', () => {
  it('counts assessable AND unsupported source lines; never tests or out-of-domain; deletions are free', () => {
    const { root, g } = makeRepo();
    // Base commit: a source file, a TS file, a test file, a doc, and a file to be deleted.
    writeFileSync(join(root, 'src.mjs'), 'line1\nline2\nline3\n');
    writeFileSync(join(root, 'lib.ts'), 'ts1\nts2\n');
    writeFileSync(join(root, 'src.test.mjs'), 't1\n');
    writeFileSync(join(root, 'README.md'), 'doc\n');
    writeFileSync(join(root, 'gone.mjs'), 'g1\ng2\ng3\ng4\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    // Working set: +2 new-side lines in src.mjs; +1 in lib.ts (unsupported COUNTS — the TS-fold
    // bypass guard); test + doc edits (never counted); gone.mjs fully deleted (free); one untracked
    // source file (3 lines) + one untracked test (never counted).
    writeFileSync(join(root, 'src.mjs'), 'line1 edited\nline2\nline3\nline4 added\n');
    writeFileSync(join(root, 'lib.ts'), 'ts1\nts2 edited\n');
    writeFileSync(join(root, 'src.test.mjs'), 't1\nt2\nt3\n');
    writeFileSync(join(root, 'README.md'), 'doc\nmore\nmore\n');
    rmSync(join(root, 'gone.mjs'));
    writeFileSync(join(root, 'new.mjs'), 'n1\nn2\nn3');
    writeFileSync(join(root, 'new.spec.js'), 's1\ns2\n');
    const surface = computeChangedSurface(root);
    // Assessable: src.mjs new-side lines 1 + 4 (edit + add), new.mjs all 3 → 5.
    assert.deepEqual([...surface.assessable.keys()].sort(), ['new.mjs', 'src.mjs']);
    assert.deepEqual(surface.assessable.get('src.mjs'), [1, 4]);
    assert.equal(surface.assessable.get('new.mjs').length, 3);
    // Unsupported source carries its lines too (counted).
    assert.deepEqual(surface.unsupported, ['lib.ts']);
    assert.deepEqual(surface.unsupportedLines.get('lib.ts'), [2]);
    // Out-of-domain listed, never counted; the deleted file contributes nothing.
    assert.deepEqual(surface.outOfDomain, ['README.md']);
    assert.equal(countCapLines(surface), 2 + 3 + 1, 'assessable (2+3) + unsupported (1); tests/docs/deletions free');
    rmSync(root, { recursive: true, force: true });
  });

  it('a PURE deletion working set counts 0 (subtractive folds stay free)', () => {
    const { root, g } = makeRepo();
    writeFileSync(join(root, 'a.mjs'), 'a1\na2\na3\n');
    writeFileSync(join(root, 'keep.mjs'), 'k\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    rmSync(join(root, 'a.mjs'));
    const surface = computeChangedSurface(root);
    assert.equal(countCapLines(surface), 0);
    rmSync(root, { recursive: true, force: true });
  });

  it('an untracked unsupported source file counts ALL its lines (whole-file new)', () => {
    const { root, g } = makeRepo();
    writeFileSync(join(root, 'keep.mjs'), 'k\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'brand-new.tsx'), 'x1\nx2\nx3\nx4\n');
    const surface = computeChangedSurface(root);
    assert.deepEqual(surface.unsupported, ['brand-new.tsx']);
    assert.equal(countCapLines(surface), 4);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('computeChangedSurface — fail-closed edges', () => {
  it('an UNBORN branch (no HEAD yet) falls back to the plain diff and still counts untracked files', () => {
    const { root } = makeRepo(); // git init only — no commit, HEAD unborn
    writeFileSync(join(root, 'fresh.mjs'), 'f1\nf2\n');
    const surface = computeChangedSurface(root);
    assert.deepEqual(surface.assessable.get('fresh.mjs'), [1, 2]);
    assert.equal(countCapLines(surface), 2);
    rmSync(root, { recursive: true, force: true });
  });

  it('a TRACKED assessable leaf that became a symlink routes to unsupported (never read/followed)', () => {
    const { root, g } = makeRepo();
    writeFileSync(join(root, 'real.mjs'), 'r1\n');
    writeFileSync(join(root, 'target.txt'), 'elsewhere\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    rmSync(join(root, 'real.mjs'));
    spawnSync('ln', ['-s', 'target.txt', join(root, 'real.mjs')]);
    const surface = computeChangedSurface(root);
    assert.ok(!surface.assessable.has('real.mjs'), 'a symlinked leaf is never assessable');
    assert.deepEqual(surface.unsupported, ['real.mjs']);
    rmSync(root, { recursive: true, force: true });
  });

  it('staged initial files on an UNBORN branch are counted (neither in the plain diff nor untracked — codex R1)', () => {
    const { root, g } = makeRepo(); // no commit — HEAD unborn
    writeFileSync(join(root, 'staged.mjs'), 's1\ns2\n');
    g('add', 'staged.mjs');
    const surface = computeChangedSurface(root);
    assert.deepEqual(surface.assessable.get('staged.mjs'), [1, 2], 'a staged initial source file is changed surface');
    assert.equal(countCapLines(surface), 2);
    rmSync(root, { recursive: true, force: true });
  });

  it('NOT a git tree at all → an empty surface (both diff probes refused, nothing counted)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'changed-surface-nogit-'));
    writeFileSync(join(bare, 'loose.mjs'), 'l1\n');
    const surface = computeChangedSurface(bare);
    assert.equal(surface.assessable.size, 0, 'without git there is no change domain');
    assert.equal(countCapLines(surface), 0);
    rmSync(bare, { recursive: true, force: true });
  });

  it('readFileSafe / isRegularLeaf fail CLOSED (null / false), never throw — the exported edges', () => {
    assert.equal(readFileSafe(tmpdir()), null, 'a directory read fails to null (EISDIR)');
    assert.equal(readFileSafe(join(tmpdir(), 'no-such-file-xyz')), null);
    assert.equal(isRegularLeaf(join(tmpdir(), 'no-such-dir-xyz', 'x.mjs')), false, 'a missing parent fails to false (ENOENT)');
  });
});

describe('parsePositiveIntKnob — the shared fail-closed knob home', () => {
  it('unset → fallback; a positive integer parses; garbage fails through the caller error factory', () => {
    assert.equal(parsePositiveIntKnob({}, 'K', 42), 42);
    assert.equal(parsePositiveIntKnob({ K: '7' }, 'K', 42), 7);
    for (const bad of ['0', '-1', '1.5', 'many', '']) {
      assert.throws(
        () => parsePositiveIntKnob({ K: bad }, 'K', 42, (m) => Object.assign(new Error(m), { code: 'CUSTOM' })),
        (e) => e.code === 'CUSTOM' && /K must be a positive integer/.test(e.message),
        `"${bad}" must fail closed`,
      );
    }
  });
});

describe('readJsonlRows — the tolerant D8 telemetry reader', () => {
  it('parses object rows, counts bad lines, never drops silently', () => {
    const { rows, badLines } = readJsonlRows('X', () => '{"a":1}\n{not json\n[1,2]\n\n{"b":2}\n');
    assert.equal(rows.length, 2);
    assert.equal(badLines, 2, 'unparseable + non-object both count');
  });

  it('ENOENT → empty; a non-ENOENT read error surfaces as readError', () => {
    const absent = readJsonlRows('X', () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
    assert.deepEqual(absent, { rows: [], badLines: 0 });
    const denied = readJsonlRows('X', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    assert.equal(denied.readError, 'EACCES');
  });
});

describe('single-home re-exports — one implementation, every consumer', () => {
  it('fold-completeness.mjs re-exports the SAME probeVerdict / resolveResultsPath / basename', () => {
    assert.equal(reExportedProbeVerdict, probeVerdict);
    assert.equal(reExportedResolveResultsPath, resolveResultsPath);
    assert.equal(reExportedBasename, RESULTS_BASENAME);
  });

  it('fold-completeness-run.mjs re-exports the SAME surface functions (one entry point per concern)', () => {
    assert.equal(runnerClassify, classifyChangedPath);
    assert.equal(runnerParse, parseUnifiedDiff);
    assert.equal(runnerUnquote, unquoteDiffPath);
    assert.equal(runnerSurface, computeChangedSurface);
  });

  it('resolveResultsPath honors AW_FOLD_RESULTS and anchors at the git dir otherwise', () => {
    assert.equal(resolveResultsPath('/nowhere', { AW_FOLD_RESULTS: '/x/f.jsonl' }), '/x/f.jsonl');
    const { root, g } = makeRepo();
    writeFileSync(join(root, 'a.txt'), 'a\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const resolved = resolveResultsPath(root, {});
    assert.ok(resolved.endsWith(RESULTS_BASENAME), resolved);
    assert.equal(dirname(resolved), join(root, '.git'));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('probeVerdict — the D4 algebra (home smoke; the full matrix lives in fold-completeness.test.mjs)', () => {
  it('N/N green / N/N red / mixed / timeout / unresolved', () => {
    assert.equal(probeVerdict({ runs: 3, greens: 3, reds: 0, timeouts: 0 }), 'green');
    assert.equal(probeVerdict({ runs: 3, greens: 0, reds: 3, timeouts: 0 }), 'red');
    assert.equal(probeVerdict({ runs: 3, greens: 2, reds: 1, timeouts: 0 }), 'quarantine');
    assert.equal(probeVerdict({ runs: 3, greens: 2, reds: 0, timeouts: 1 }), 'quarantine');
    assert.equal(probeVerdict({ runs: 3, greens: 0, reds: 0, timeouts: 0 }), 'unresolvable');
  });
});

describe('classifyChangedPath / parseUnifiedDiff / unquoteDiffPath — home smoke (full suites ride the runner tests)', () => {
  it('classification stays the CLOSED rule', () => {
    assert.equal(classifyChangedPath('tools/a.mjs'), 'assessable');
    assert.equal(classifyChangedPath('a.test.mjs'), 'excluded-test');
    assert.equal(classifyChangedPath('b.ts'), 'unsupported');
    assert.equal(classifyChangedPath('README.md'), 'out-of-domain');
  });

  it('parseUnifiedDiff reads new-side lines; unquoteDiffPath decodes a C-quoted path', () => {
    const diff = ['diff --git a/x.mjs b/x.mjs', '--- a/x.mjs', '+++ b/x.mjs', '@@ -1,0 +2,2 @@', '+a', '+b'].join('\n');
    assert.deepEqual(parseUnifiedDiff(diff).get('x.mjs'), [2, 3]);
    assert.equal(unquoteDiffPath('"a/\\321\\202.mjs"'), 'a/т.mjs');
  });
});
