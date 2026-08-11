// source-size-ratchet.test.mjs — what a RECORDED size does and does not buy. A baseline entry is
// debt for the dimension it names and for nothing else; it may never grow, and it may never sit
// above what the tree actually measures (a stale record is headroom nobody earned). Every refusal
// here must carry a step the reader can perform — and the addressing around it must be exact in both
// directions: never accept a command the shell would read differently, never refuse one that runs
// verbatim.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './source-size-check.mjs';
import { GROWTH_REASON_PLACEHOLDER } from './source-size-report.mjs';
import { configPathFor, matchesSourceSizeGate, SOURCE_SIZE_DEFAULTS } from './source-size-core.mjs';

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
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
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
  it('baseline-entry-exempts-only-recorded-dimension: a lines-only record does not hide a new long line', () => {
    const cwd = project(
      { 'src/wide.mjs': `${'x'.repeat(1001)}\n` },
      { 'src/wide.mjs': { lines: 1, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 1, `a dimension nobody recorded must still be judged:\n${result.stdout}`);
    assert.match(result.stdout, /src\/wide\.mjs: maxLineBytes 1001 exceeds the declared default 1000/);
  });

  it('baseline-entry-exempts-only-recorded-dimension, the other way round: a maxLineBytes-only record does not hide new lines', () => {
    const cwd = project(
      { 'src/big.mjs': lines(401) },
      { 'src/big.mjs': { maxLineBytes: 1, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 1, `a dimension nobody recorded must still be judged:\n${result.stdout}`);
    assert.match(result.stdout, /src\/big\.mjs: lines 401 exceeds the declared default 400/);
  });

  it('a record covering the violating dimension still exempts it', () => {
    const cwd = project({ 'src/big.mjs': lines(401) }, { 'src/big.mjs': { lines: 401, reason: 'recorded at adoption' } });
    assert.equal(check(cwd).code, 0);
  });
});

describe('source-size — the recorded ratchet (D-3)', () => {
  it('ratchet-recorded-file-may-not-grow: recorded debt is not permission to grow', () => {
    const cwd = project({ 'src/big.mjs': lines(420) }, { 'src/big.mjs': { lines: 401, reason: 'recorded at adoption' } });
    const result = check(cwd);
    assert.equal(result.code, 1, `a recorded file that grew must refuse:\n${result.stdout}`);
    assert.match(result.stdout, /src\/big\.mjs: lines 420 exceeds its recorded baseline 401/);
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

  it('ratchet-stale-baseline-fails: a record ABOVE the tree is headroom nobody earned', () => {
    const cwd = project({ 'src/big.mjs': lines(401) }, { 'src/big.mjs': { lines: 500, reason: 'recorded at adoption' } });
    const result = check(cwd);
    assert.equal(result.code, 1, `a stale record must refuse, not pass:\n${result.stdout}`);
    assert.match(result.stdout, /src\/big\.mjs: lines 401 is under the recorded 500 — the baseline is STALE/);
  });

  it('ratchet-linebytes-tighten: a shrunk long line stales its record the same way', () => {
    const cwd = project(
      { 'src/wide.mjs': `${'x'.repeat(1001)}\n` },
      { 'src/wide.mjs': { maxLineBytes: 1200, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/wide\.mjs: maxLineBytes 1001 is under the recorded 1200 — the baseline is STALE/);
  });

  it('ratchet-record-under-the-cap-is-obsolete: a record the file no longer needs is stated, not silently kept', () => {
    // A hand-authored record may sit at or below the cap. The regenerator would DROP it, so a check
    // that passed would disagree with the writer about the very same tree.
    const cwd = project({ 'src/a.mjs': lines(350) }, { 'src/a.mjs': { lines: 350, reason: 'hand-authored' } });
    const result = check(cwd);
    assert.equal(result.code, 1, `the checker and the regenerator must read one projection:\n${result.stdout}`);
    assert.match(result.stdout, /src\/a\.mjs: lines 350 no longer exceeds the declared default 400 — the record must go/);
    assert.doesNotMatch(result.stdout, /--reason/, 'dropping a record raises nothing');
    assert.match(result.stdout, /REVIEW FOCUS — a recorded size went DOWN or disappeared/);
  });

  it('ratchet-growth-below-the-cap-is-not-a-raise: the refusal may never demand a reason the regenerator does not need', () => {
    const cwd = project({ 'src/a.mjs': lines(380) }, { 'src/a.mjs': { lines: 350, reason: 'hand-authored' } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/a\.mjs: lines 380 no longer exceeds the declared default 400 — the record must go/);
    assert.doesNotMatch(result.stdout, /--reason/, 'the regeneration REMOVES this record — asking for a reason states a requirement that is not real');
    assert.doesNotMatch(result.stdout, /exceeds its recorded baseline/);
  });

  it('refusal-hand-entry-carries-every-recorded-dimension: the printed entry is the WHOLE record, never the violating half', () => {
    // lines grew, the recorded long line did not: an entry printed from the findings alone would
    // drop maxLineBytes, and pasting it would fail the very next check.
    const cwd = project(
      { 'src/w.mjs': `${'w'.repeat(1001)}\n${lines(419)}` },
      { 'src/w.mjs': { lines: 401, maxLineBytes: 1001, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /"src\/w\.mjs": \{ "lines": 420, "maxLineBytes": 1001, "reason": "<why this size is accepted>" \}/);
  });

  it('ratchet-entry-file-gone-errors: a deleted record and a renamed one both surface, never silently', () => {
    const deleted = project({ 'src/keep.mjs': lines(10) }, { 'src/gone.mjs': { lines: 900, reason: 'recorded at adoption' } });
    const afterDelete = check(deleted);
    assert.equal(afterDelete.code, 1);
    assert.match(afterDelete.stdout, /src\/gone\.mjs: recorded in "baseline" but no longer in scope/);

    const renamed = project({ 'src/new-name.mjs': lines(401) }, { 'src/old-name.mjs': { lines: 401, reason: 'recorded at adoption' } });
    const afterRename = check(renamed);
    assert.equal(afterRename.code, 1);
    assert.match(afterRename.stdout, /src\/old-name\.mjs: recorded in "baseline" but no longer in scope/);
    assert.match(afterRename.stdout, /src\/new-name\.mjs: lines 401 exceeds the declared default 400/);
  });
});

describe('source-size — a refusal renders the step the reader can actually perform (D-3a)', () => {
  it('refusal-tighten-prints-exact-command: shrinking is progress, so the regenerator is paste-ready and needs no reason', () => {
    const cwd = project({ 'src/big.mjs': lines(401) }, { 'src/big.mjs': { lines: 500, reason: 'recorded at adoption' } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes(regenerator(cwd)), `the exact regenerator must be printed:\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /--reason/, 'a pure tighten must not ask for a reason');
  });

  it('refusal-growth-prints-reason-template: a raise renders a TEMPLATE and states that the reason is required', () => {
    const cwd = project({ 'src/big.mjs': lines(420) }, { 'src/big.mjs': { lines: 401, reason: 'recorded at adoption' } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.ok(
      result.stdout.includes(`${regenerator(cwd)} --reason "${GROWTH_REASON_PLACEHOLDER}"`),
      `the growth lane must render the command as a reason-carrying template:\n${result.stdout}`,
    );
    assert.match(result.stdout, /reason is REQUIRED/);
  });

  it('refusal-dq-unsafe-states-parameters: an unrenderable project path withholds the command and names the manual lane', () => {
    const cwd = project({ 'src/big.mjs': lines(401) }, {}, { suffix: '-$dq' });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/big\.mjs: lines 401 exceeds the declared default 400/);
    assert.doesNotMatch(result.stdout, /--write-baseline --cwd/, 'a path that does not survive quoting is never rendered into a command');
    assert.match(result.stdout, /no paste-ready command is printed/i);
    assert.match(result.stdout, /"src\/big\.mjs": \{ "lines": 401/);
  });

  it('refusal-teaches-split-quality-on-lowered-entry: a record that went DOWN carries the review focus (D-9)', () => {
    const lowered = project({ 'src/big.mjs': lines(401) }, { 'src/big.mjs': { lines: 900, reason: 'recorded at adoption' } });
    assert.match(check(lowered).stdout, /REVIEW FOCUS — a recorded size went DOWN or disappeared/);

    const grown = project({ 'src/big.mjs': lines(420) }, { 'src/big.mjs': { lines: 401, reason: 'recorded at adoption' } });
    assert.doesNotMatch(check(grown).stdout, /REVIEW FOCUS/, 'growth is not a split — the focus line must not fire');
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
