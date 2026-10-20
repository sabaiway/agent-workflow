// source-size-ratchet.test.mjs — what a RECORDED size does and does not buy. A baseline entry is
// debt for the dimension it names and for nothing else; it may never grow, and it may never sit
// above what the tree actually measures (a stale record is headroom nobody earned). Every refusal
// here must carry a step the reader can perform — and the addressing around it must be exact in both
// directions: never accept a command the shell would read differently, never refuse one that runs
// verbatim.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './source-size-check.mjs';
import { GROWTH_REASON_PLACEHOLDER } from './source-size-report.mjs';
import { configPathFor, matchesSourceSizeGate } from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-ratchet-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

// The aggregate a fixture records, counted from the fixture BODIES — never by asking the checker,
// which would make the fixture agree with the checker's own bugs. Every fixture in this suite keeps
// its in-scope files directly under src/ with the declared extension.
const declaredLines = (files) => Object.entries(files)
  .filter(([rel]) => rel.startsWith('src/') && rel.endsWith('.mjs'))
  .reduce((sum, [, body]) => sum + (body.match(/\n/g) ?? []).length, 0);

const CONFIG = (baseline, aggregateLines) => ({
  _README: 'fixture',
  schema: 2,
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  baseline,
  aggregate: { src: { lines: aggregateLines, reason: 'initial adoption' } },
});

let seq = 0;
const project = (files, baseline, { aggregateLines = declaredLines(files), suffix = '' } = {}) => {
  const cwd = join(TMP, `p${seq += 1}${suffix}`);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(cwd, rel), body);
  writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(CONFIG(baseline, aggregateLines), null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const check = (cwd) => main(['--check', '--cwd', cwd]);
const lines = (n) => 'x\n'.repeat(n);
const regenerator = (cwd) => `node "${TOOL}" --write-baseline --cwd "${cwd}"`;
const configOf = (cwd) => JSON.parse(readFileSync(configPathFor(cwd), 'utf8'));
const TIGHTEN = 'source-size: WARNING — a record above is lower or gone, so regenerating lowers or removes it with no reason: ';
// The NOTE that layout is not judged names the --reason that starts it; the size lines never do.
const said = (result) => result.stdout.split('\n').filter((line) => !line.startsWith('source-size: NOTE — ')).join('\n');

// A directory named `name` holding a symlink to the checker — the bare-token cases need a path that
// really resolves, or the matcher would refuse them for being unresolvable instead of for their bytes.
const linkedTool = (name) => {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'source-size-check.mjs');
  symlinkSync(TOOL, link);
  return link;
};

describe('source-size — a recorded size is debt for exactly what it records', () => {
  // spec:source-size/S3
  it('baseline-entry-exempts-only-recorded-dimension: a lines-only record does not hide a new long line', () => {
    const cwd = project(
      { 'src/wide.mjs': `${'x'.repeat(1001)}\n` },
      { 'src/wide.mjs': { lines: 1, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 1, `a dimension nobody recorded must still be judged:\n${result.stdout}`);
    assert.match(result.stdout, /src\/wide\.mjs: maxLineBytes 1001 exceeds the declared default 1000/);
  });

  it('baseline-entry-exempts-only-recorded-dimension, the other way round: a maxLineBytes-only record does not hide new lines, a lines record does', () => {
    const cwd = project(
      { 'src/big.mjs': lines(441) },
      { 'src/big.mjs': { maxLineBytes: 1, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.match(result.stdout, /src\/big\.mjs: lines 441 exceeds the declared default 400 beyond its band \(up to 440\)/, result.stdout);
    assert.equal(result.code, 1, `a dimension nobody recorded must still be judged:\n${result.stdout}`);
    const covered = project({ 'src/big.mjs': lines(441) }, { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } });
    assert.equal(check(covered).code, 0, 'a record covering the violating dimension still exempts it');
  });
});

describe('source-size — the recorded ratchet (D-3)', () => {
  // spec:source-size/S1
  it('ratchet-recorded-file-may-not-grow: recorded debt is not permission to grow, and the growth alone stops', () => {
    const cwd = project(
      { 'src/big.mjs': lines(460), 'src/near.mjs': lines(420) },
      { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.match(result.stdout, /^source-size: FAIL — 1 finding\(s\)/m, `a file within its band beside the growth only warns:\n${result.stdout}`);
    assert.equal(result.code, 1, `a recorded file that grew must refuse:\n${result.stdout}`);
    assert.match(result.stdout, /src\/big\.mjs: lines 460 exceeds its recorded baseline 441/);
  });

  it('ratchet-linebytes-may-not-grow: the second dimension rides the same rule', () => {
    const cwd = project(
      { 'src/wide.mjs': `${'x'.repeat(1200)}\n` },
      { 'src/wide.mjs': { maxLineBytes: 1001, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/wide\.mjs: maxLineBytes 1200 exceeds its recorded baseline 1001/);
  });

  // spec:source-size/S2
  it('ratchet-stale-baseline-warns: a record ABOVE the tree is headroom nobody earned, warned on every run until the regeneration lowers it', () => {
    const cwd = project({ 'src/big.mjs': lines(441) }, { 'src/big.mjs': { lines: 500, reason: 'recorded at adoption' } });
    const runs = [check(cwd), check(cwd)];
    for (const result of runs) {
      assert.equal(result.code, 0, `a stale record warns, exit 0:\n${result.stdout}`);
      assert.match(result.stdout, /^source-size: WARNING — src\/big\.mjs: lines 441 is under the recorded 500 — the regeneration lowers it$/m);
    }
    assert.equal(runs[1].stdout, runs[0].stdout, 'the warning repeats on every run');
    assert.ok(runs[0].stdout.includes(`${TIGHTEN}${regenerator(cwd)}`), runs[0].stdout);
    assert.doesNotMatch(said(runs[0]), /--reason/, 'lowering a record takes no reason');
    const lowered = main(['--write-baseline', '--cwd', cwd]);
    assert.equal(lowered.code, 0, `${lowered.stdout}${lowered.stderr}`);
    assert.deepEqual(configOf(cwd).baseline, { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } });
    assert.doesNotMatch(check(cwd).stdout, /WARNING/, 'the lowered record settles the warning');
  });

  it('ratchet-linebytes-tighten: a shrunk long line warns on its record the same way', () => {
    const cwd = project(
      { 'src/wide.mjs': `${'x'.repeat(1001)}\n` },
      { 'src/wide.mjs': { maxLineBytes: 1200, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 0, `a stale record warns, exit 0:\n${result.stdout}`);
    assert.match(result.stdout, /^source-size: WARNING — src\/wide\.mjs: maxLineBytes 1001 is under the recorded 1200 — the regeneration lowers it$/m);
  });

  it('ratchet-record-under-the-cap-is-obsolete: a record the file no longer needs is stated on every run, not silently kept', () => {
    // A hand-authored record may sit at or below the cap. The regenerator would DROP it, so a check
    // that said nothing would disagree with the writer about the very same tree.
    const cwd = project({ 'src/a.mjs': lines(350) }, { 'src/a.mjs': { lines: 350, reason: 'hand-authored' } });
    const result = check(cwd);
    assert.equal(result.code, 0, `an obsolete record warns, exit 0:\n${result.stdout}`);
    assert.match(result.stdout, /^source-size: WARNING — src\/a\.mjs: lines 350 is within its band \(up to 440\), so its record is obsolete — the regeneration removes it$/m);
    assert.doesNotMatch(said(result), /--reason/, 'dropping a record raises nothing');
    assert.match(result.stdout, /REVIEW FOCUS — a recorded size went DOWN or disappeared/);
  });

  it('ratchet-growth-below-the-cap-is-not-a-raise: the warning may never demand a reason the regenerator does not need', () => {
    const cwd = project({ 'src/a.mjs': lines(380) }, { 'src/a.mjs': { lines: 350, reason: 'hand-authored' } });
    const result = check(cwd);
    assert.equal(result.code, 0, `a record the regeneration removes warns, exit 0:\n${result.stdout}`);
    assert.match(result.stdout, /src\/a\.mjs: lines 380 is within its band \(up to 440\), so its record is obsolete — the regeneration removes it/);
    assert.doesNotMatch(said(result), /--reason/, 'the regeneration REMOVES this record — asking for a reason states a requirement that is not real');
    assert.doesNotMatch(result.stdout, /exceeds its recorded baseline/);
  });

  it('refusal-hand-entry-carries-every-recorded-dimension: the printed entry is the WHOLE projected record, never the violating half nor a dimension within its band', () => {
    // w: lines grew, the recorded long line did not — an entry printed from the findings alone would
    // drop maxLineBytes. x: its long line grew while its 420 lines sit within their band, unrecorded.
    const cwd = project(
      { 'src/w.mjs': `${'w'.repeat(1001)}\n${lines(460)}`, 'src/x.mjs': `${'x'.repeat(1100)}\n${lines(419)}` },
      {
        'src/w.mjs': { lines: 441, maxLineBytes: 1001, reason: 'recorded at adoption' },
        'src/x.mjs': { lines: 420, maxLineBytes: 1001, reason: 'recorded at adoption' },
      },
    );
    const result = check(cwd);
    assert.match(result.stdout, /"src\/x\.mjs": \{ "maxLineBytes": 1100, "reason": "<why this size is accepted>" \}/, result.stdout);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /"src\/w\.mjs": \{ "lines": 461, "maxLineBytes": 1001, "reason": "<why this size is accepted>" \}/);
  });

  // spec:source-size/S7
  it('ratchet-entry-file-gone-warns: a deleted record and a renamed one both surface on every run, never silently, until the regeneration removes them', () => {
    const deleted = project({ 'src/keep.mjs': lines(10) }, { 'src/gone.mjs': { lines: 900, reason: 'recorded at adoption' } });
    const runs = [check(deleted), check(deleted)];
    for (const result of runs) {
      assert.equal(result.code, 0, `a gone record warns, exit 0:\n${result.stdout}`);
      assert.match(result.stdout, /^source-size: WARNING — src\/gone\.mjs: recorded in "baseline" but no longer in scope — split, renamed or deleted; the regeneration removes it$/m);
    }
    assert.ok(runs[0].stdout.includes(`${TIGHTEN}${regenerator(deleted)}`), runs[0].stdout);
    assert.equal(main(['--write-baseline', '--cwd', deleted]).code, 0, 'removing a record takes no reason');
    assert.deepEqual(configOf(deleted).baseline, {});
    assert.doesNotMatch(check(deleted).stdout, /gone\.mjs/, 'the regeneration settled it');

    const renamed = project({ 'src/new-name.mjs': lines(441) }, { 'src/old-name.mjs': { lines: 441, reason: 'recorded at adoption' } });
    const afterRename = check(renamed);
    assert.equal(afterRename.code, 1, 'the new name beyond its band stops');
    assert.match(afterRename.stdout, /^source-size: WARNING — src\/old-name\.mjs: recorded in "baseline" but no longer in scope/m);
    assert.match(afterRename.stdout, /src\/new-name\.mjs: lines 441 exceeds the declared default 400 beyond its band/);
  });
});

describe('source-size — a refusal renders the step the reader can actually perform (D-3a)', () => {
  it('a tighten warns with the exact regenerator and no reason; a growth stops with a TEMPLATE stating the reason is required', () => {
    const cwd = project({ 'src/big.mjs': lines(441) }, { 'src/big.mjs': { lines: 500, reason: 'recorded at adoption' } });
    const result = check(cwd);
    assert.equal(result.code, 0, `shrinking is progress, so it warns:\n${result.stdout}`);
    assert.ok(result.stdout.includes(regenerator(cwd)), `the exact regenerator must be printed:\n${result.stdout}`);
    assert.doesNotMatch(said(result), /--reason/, 'a pure tighten must not ask for a reason');

    const grown = project({ 'src/big.mjs': lines(460) }, { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } });
    const growth = check(grown);
    assert.equal(growth.code, 1);
    assert.ok(
      growth.stdout.includes(`${regenerator(grown)} --reason "${GROWTH_REASON_PLACEHOLDER}"`),
      `the growth lane must render the command as a reason-carrying template:\n${growth.stdout}`,
    );
    assert.match(growth.stdout, /reason is REQUIRED/);
  });

  it('refusal-dq-unsafe-states-parameters: an unrenderable project path withholds the command and names the manual lane', () => {
    const cwd = project({ 'src/big.mjs': lines(441) }, {}, { suffix: '-$dq' });
    const result = check(cwd);
    assert.match(result.stdout, /src\/big\.mjs: lines 441 exceeds the declared default 400 beyond its band \(up to 440\)/, result.stdout);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /--write-baseline --cwd/, 'a path that does not survive quoting is never rendered into a command');
    assert.match(result.stdout, /no paste-ready command is printed/i);
    assert.match(result.stdout, /"src\/big\.mjs": \{ "lines": 441/);
  });

  it('refusal-teaches-split-quality-on-lowered-entry: a record that went DOWN warns with the review focus (D-9)', () => {
    const lowered = check(project({ 'src/big.mjs': lines(441) }, { 'src/big.mjs': { lines: 900, reason: 'recorded at adoption' } }));
    assert.equal(lowered.code, 0, `a lowered record warns, exit 0:\n${lowered.stdout}`);
    assert.match(lowered.stdout, /REVIEW FOCUS — a recorded size went DOWN or disappeared/);

    const grown = project({ 'src/big.mjs': lines(460) }, { 'src/big.mjs': { lines: 441, reason: 'recorded at adoption' } });
    assert.doesNotMatch(check(grown).stdout, /REVIEW FOCUS/, 'growth is not a split — the focus line must not fire');
  });
});

const AUTHORED = { _README: 'fixture', schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'] };
const WITHIN = /^source-size: WARNING — src\/a\.mjs: lines 440 is over the limit 400 but within its band \(up to 440\) — no record is kept; past 440 it stops$/m;

describe('spec:source-size/S26 a file within its line band warns on every run and carries no record; beyond the band it stops unless a record holds it', () => {
  it('440 lines warn on every run, exit 0, and the mint records nothing for the file', () => {
    const cwd = project({ 'src/a.mjs': lines(440) }, {});
    const runs = [check(cwd), check(cwd)];
    for (const result of runs) {
      assert.equal(result.code, 0, `a file within its band warns, exit 0:\n${result.stdout}`);
      assert.match(result.stdout, WITHIN);
    }
    assert.equal(runs[1].stdout, runs[0].stdout, 'the warning repeats on every run');
    writeFileSync(configPathFor(cwd), JSON.stringify(AUTHORED, null, 2));
    const minted = main(['--write-baseline', '--cwd', cwd, '--reason', 'initial adoption']);
    assert.equal(minted.code, 0, `${minted.stdout}${minted.stderr}`);
    assert.deepEqual(configOf(cwd).baseline, {}, 'a warning never raises a record');
    assert.deepEqual(configOf(cwd).aggregate, { src: { lines: 440, reason: 'initial adoption' } });
  });

  it('441 lines stop with no record, and a record of them holds them', () => {
    const result = check(project({ 'src/a.mjs': lines(441) }, {}));
    assert.match(result.stdout, /^ {2}src\/a\.mjs: lines 441 exceeds the declared default 400 beyond its band \(up to 440\)$/m, result.stdout);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /"src\/a\.mjs": \{ "lines": 441, "reason": "<why this size is accepted>" \}/);
    const held = check(project({ 'src/a.mjs': lines(441) }, { 'src/a.mjs': { lines: 441, reason: 'recorded' } }));
    assert.equal(held.code, 0, held.stdout);
    assert.doesNotMatch(held.stdout, /WARNING/);
  });

  it('a file recorded at 450 that drops to 430 holds an obsolete record that warns until the regeneration removes it with no reason', () => {
    const cwd = project({ 'src/a.mjs': lines(430) }, { 'src/a.mjs': { lines: 450, reason: 'recorded' } });
    const runs = [check(cwd), check(cwd)];
    for (const result of runs) {
      assert.equal(result.code, 0, `an obsolete record warns, exit 0:\n${result.stdout}`);
      assert.match(result.stdout, /^source-size: WARNING — src\/a\.mjs: lines 430 is within its band \(up to 440\), so its record is obsolete — the regeneration removes it$/m);
    }
    assert.ok(runs[0].stdout.includes(`${TIGHTEN}${regenerator(cwd)}`), runs[0].stdout);
    const write = main(['--write-baseline', '--cwd', cwd]);
    assert.equal(write.code, 0, 'removing the record takes no reason');
    assert.match(write.stdout, /^source-size: WARNING — src\/a\.mjs: lines 430 is over the limit 400 but within its band \(up to 440\) — no record is kept/m, 'the write states the warning it leaves standing');
    assert.deepEqual(configOf(cwd).baseline, {});
    const settled = check(cwd);
    assert.equal(settled.code, 0);
    assert.match(settled.stdout, /src\/a\.mjs: lines 430 is over the limit 400 but within its band \(up to 440\) — no record is kept/);
    assert.doesNotMatch(settled.stdout, /obsolete/);
  });

  it('the projection records a dimension only beyond its band: 441 lines and 1001 bytes, never 440 lines or 1000 bytes', () => {
    const cwd = project({
      'src/a.mjs': lines(440), 'src/b.mjs': lines(441), 'src/c.mjs': `${'x'.repeat(1000)}\n`, 'src/d.mjs': `${'x'.repeat(1001)}\n`,
    }, {});
    const written = main(['--write-baseline', '--cwd', cwd, '--reason', 'beyond the band']);
    assert.deepEqual(configOf(cwd).baseline, {
      'src/b.mjs': { lines: 441, reason: 'beyond the band' },
      'src/d.mjs': { maxLineBytes: 1001, reason: 'beyond the band' },
    }, `${written.stdout}${written.stderr}`);
    assert.equal(written.code, 0);
  });
});

describe('source-size — the matcher refuses what the shell would reread, and nothing else', () => {
  it('matcher-accepts-inert-characters-in-a-bare-token: a bare path the shell passes through verbatim stays canonical', () => {
    for (const name of ['at@dir', 'plus+dir', 'comma,dir', 'percent%dir', 'equals=dir', 'unicode-\u00e9-dir']) {
      const link = linkedTool(name);
      assert.equal(
        matchesSourceSizeGate(`node ${link} --check`, REPO_ROOT),
        true,
        `a bare token containing only inert bytes must stay canonical: ${link}`,
      );
    }
  });

  it('the shell-active bytes stay refused in a bare token', () => {
    for (const name of ['semi;dir', 'amp&dir', 'pipe|dir', 'star*dir', 'quest?dir']) {
      const link = linkedTool(name);
      assert.equal(matchesSourceSizeGate(`node ${link} --check`, REPO_ROOT), false, `must stay refused: ${link}`);
    }
  });
});

describe('source-size — a printed path is absolute wherever it was computed', () => {
  it('config-path-is-absolute-from-a-relative-cwd: the helper resolves, it does not merely join', () => {
    assert.equal(isAbsolute(configPathFor('.')), true, 'configPathFor promises an absolute path');
    assert.equal(isAbsolute(configPathFor('some/relative/dir')), true);
    assert.equal(configPathFor(REPO_ROOT), join(REPO_ROOT, 'docs/ai/source-size.json'));
  });
});
