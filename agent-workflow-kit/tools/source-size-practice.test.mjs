// source-size-practice.test.mjs — the standing echo (D-17 U4): what the checker itself says about
// the practice when it is not refusing anything, and the one sentence its RENDERED refusals close
// with. The gate is the LAST surface a reader meets, so it is the one that must never leave the caps
// or their reason to be looked up elsewhere.
//
// Three stop classes, only the first of which carries the WHY: the report-RENDERED refusals (absent /
// unminted / check-FAIL / reason-required), the thrown exit-1 scope refusals (an unverifiable
// in-scope source file, a non-UTF-8 path, an unmerged index, an empty declared scope) and the exit-2
// config, usage and enumeration errors.
//
// The canonical sentence is pinned here as a LITERAL: a test comparing the render against the
// module's own constant would follow any rewording of it, and this sentence is canon precisely
// because it never varies.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './source-size-check.mjs';
import { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_WHY, measureFile, practiceFacts, validateSourceSizeConfig } from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-practice-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const CANONICAL_WHY = 'A module you can hold whole is the unit of review, test pairing and safe edit; the caps turn size drift into recorded, reasoned debt instead of invisible growth.';
const WHY_LINE = `source-size: WHY — ${CANONICAL_WHY}`;

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const lines = (n) => 'x\n'.repeat(n);

const AUTHORED = {
  _README: 'fixture',
  schema: 2,
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
};

let seq = 0;
// A real git work tree with a deployed docs/ai; nothing is committed — the index alone is what the
// scope rule reads.
const project = ({ files = {}, config = AUTHORED } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(cwd, rel), body);
  if (config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const check = (cwd) => main(['--check', '--cwd', cwd]);
const lastLine = (result) => result.stdout.split('\n').at(-1);
const configPath = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
const RATCHET_RULE = ': growth past a record takes a reasoned bump, and a record above the tree or gone warns until the regeneration lowers or removes it.';

describe('source-size — the standing echo on a GREEN run (D-17 U4)', () => {
  it('gate-green-line-names-practice: a PASS states the caps, the record and the ratchet rule in one line', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(441), 'src/ok.mjs': lines(10) },
      config: {
        ...AUTHORED,
        baseline: { 'src/big.mjs': { lines: 441, reason: 'initial adoption' } },
        aggregate: { src: { lines: 451, reason: 'initial adoption' } },
      },
    });
    const result = check(cwd);
    assert.equal(
      lastLine(result),
      `source-size: practice — caps 400 lines · 1000 bytes per line over 1 declared root(s) · 1 file(s) carry a recorded size (debt, not permission) · aggregate 451 line(s)${RATCHET_RULE}`,
      `${result.stdout}\n${result.stderr}`,
    );
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /source-size: PASS — 2 in-scope file\(s\) within the declared caps/, 'with no warning the pass line itself is unchanged');
  });

  it('a GREEN run stays terse — the WHY rides refusals, not the passing path', () => {
    const cwd = project({
      files: { 'src/ok.mjs': lines(10) },
      config: { ...AUTHORED, baseline: {}, aggregate: { src: { lines: 10, reason: 'initial adoption' } } },
    });
    const result = check(cwd);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    // The SENTENCE, not the line it usually rides: a prefix-bound check would stay green if the
    // canonical text reached a passing run under any other wording.
    assert.ok(!result.stdout.includes(CANONICAL_WHY), 'a green gate reports; it does not lecture');
  });
});

const mintedAt = (total, over = {}) => ({ ...AUTHORED, ...over, baseline: {}, aggregate: { src: { lines: total, reason: 'initial adoption' } } });
const TIGHT = { 'lines-per-file': { value: 50, tolerance: 10, reason: 'tight modules' }, 'bytes-per-line': { value: 120, tolerance: 0, reason: 'narrow lines' } };
const KIT_LINES = [
  'source-size: limit lines-per-file 400, tolerance 10% — from kit',
  'source-size: limit bytes-per-line 1000, tolerance 0% — from kit',
  'source-size: limit entries-per-directory 20, tolerance 10% — from kit',
  'source-size: limit depth 5, tolerance 0% — from kit',
  'source-size: limit files-per-root none recorded, tolerance 10% — from kit',
];
const RECORDED_ROOTS = "source-size: limit files-per-root each declared root's recorded count, tolerance 10% — from kit";
const NO_LAYOUT = (cwd) => `source-size: NOTE — ${configPath(cwd)} records no "layout", so entries per directory, depth and files per root are not judged; --write-baseline --layout --reason "<text>" starts it`;
// The five limits open the output in the table's order; no other line states a limit.
const assertLimitLines = (result, code, expected) => {
  const stated = result.stdout.split('\n');
  assert.deepEqual([stated.slice(0, 5), stated.filter((line) => line.startsWith('source-size: limit '))], [expected, expected], `${result.stdout}${result.stderr}`);
  assert.equal(result.code, code, `${result.stdout}${result.stderr}`);
};

describe('spec:source-size/S23 — an override reaches every reader', () => {
  it('the standing line reads the CONFIG, not a constant: an overriding project states its own caps and is judged by them, band included', () => {
    const result = check(project({ files: { 'src/ok.mjs': lines(10) }, config: mintedAt(10, { limits: TIGHT }) }));
    assert.equal(
      lastLine(result),
      `source-size: practice — caps 50 lines · 120 bytes per line over 1 declared root(s) · 0 file(s) carry a recorded size (debt, not permission) · aggregate 10 line(s)${RATCHET_RULE}`,
      `${result.stdout}\n${result.stderr}`,
    );
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(practiceFacts(validateSourceSizeConfig(mintedAt(10, { limits: TIGHT }))), { maxLines: 50, maxLineBytes: 120, roots: 1, recordedFiles: 0, aggregateLines: 10 });
    const files = { 'src/big.mjs': lines(56), 'src/near.mjs': lines(55), 'src/wide.mjs': `${'x'.repeat(121)}\n` };
    const over = check(project({ files, config: mintedAt(112, { limits: TIGHT }) }));
    assert.equal(over.code, 1);
    assert.match(over.stdout, /^source-size: WARNING — src\/near\.mjs: lines 55 is over the limit 50 but within its band \(up to 55\)/m);
    assert.match(over.stdout, /src\/big\.mjs: lines 56 exceeds the declared default 50 beyond its band \(up to 55\)/);
    assert.match(over.stdout, /src\/wide\.mjs: maxLineBytes 121 exceeds the declared default 120 beyond its band \(up to 120\)/);
  });
});

describe('spec:source-size/S20 — every run that resolves a config states the limits it judges', () => {
  it('--check and --write-baseline under the kit limits open with the five kit lines, files-per-root none recorded or each root recorded', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) } });
    assertLimitLines(check(cwd), 1, KIT_LINES);
    assertLimitLines(main(['--write-baseline', '--cwd', cwd, '--reason', 'initial adoption']), 0, KIT_LINES);
    assertLimitLines(check(cwd), 0, KIT_LINES);
    assert.equal(main(['--write-baseline', '--layout', '--cwd', cwd, '--reason', 'layout starts']).code, 0);
    const recorded = check(cwd);
    assertLimitLines(recorded, 0, [...KIT_LINES.slice(0, 4), RECORDED_ROOTS]);
    assert.doesNotMatch(recorded.stdout, /NOTE/, 'a config that records layout is judged on every dimension');
  });

  it('then a line per dimension not judged, then the warnings, then the stops; warnings and no stop end in a green line that counts them', () => {
    const near = project({ files: { 'src/near.mjs': lines(420) }, config: mintedAt(420) });
    const warned = check(near);
    assert.deepEqual(warned.stdout.split('\n').slice(5), [
      NO_LAYOUT(near),
      'source-size: WARNING — src/near.mjs: lines 420 is over the limit 400 but within its band (up to 440) — no record is kept; past 440 it stops',
      'source-size: PASS with 1 warning(s) — 1 in-scope file(s) judged and nothing beyond a band or a record; each warning above repeats on every run until it is settled',
      `source-size: practice — caps 400 lines · 1000 bytes per line over 1 declared root(s) · 0 file(s) carry a recorded size (debt, not permission) · aggregate 420 line(s)${RATCHET_RULE}`,
    ], warned.stdout);
    assert.equal(warned.code, 0);
    assert.doesNotMatch(warned.stdout, /within the declared caps/, 'a run with warnings never says every file is within its limits');

    const bare = project({ files: { 'src/a.txt': lines(1) }, config: { _README: 'fixture', schema: 2, roots: ['src'], exclude: [], baseline: {}, aggregate: { src: { lines: 0, reason: 'r' } } } });
    const notes = check(bare).stdout.split('\n');
    assert.deepEqual(notes.slice(5, 7), [`source-size: NOTE — ${configPath(bare)} declares no extension, so no file is judged on lines or bytes`, NO_LAYOUT(bare)]);

    const stopped = project({ files: { 'src/near.mjs': lines(420), 'src/big.mjs': lines(441) }, config: mintedAt(861) });
    const failed = check(stopped);
    const said = failed.stdout.split('\n');
    assert.deepEqual(said.slice(5, 9), [
      NO_LAYOUT(stopped),
      'source-size: WARNING — src/near.mjs: lines 420 is over the limit 400 but within its band (up to 440) — no record is kept; past 440 it stops',
      `source-size: FAIL — 1 finding(s) against ${configPath(stopped)}:`,
      '  src/big.mjs: lines 441 exceeds the declared default 400 beyond its band (up to 440)',
    ], failed.stdout);
    assert.equal(failed.code, 1);
  });

  it('--override and the check after it state the override with its reason; a usage, config, enumeration or scope error prints no limit line', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) }, config: mintedAt(10) });
    const expected = ['source-size: limit lines-per-file 50, tolerance 10% — from override: tight modules', ...KIT_LINES.slice(1)];
    assertLimitLines(main(['--override', 'lines-per-file', '--value', '50', '--reason', 'tight modules', '--cwd', cwd]), 0, expected);
    assertLimitLines(check(cwd), 0, expected);
    const nogit = join(TMP, `nogit${seq += 1}`);
    mkdirSync(join(nogit, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(nogit, 'docs', 'ai', 'source-size.json'), JSON.stringify(mintedAt(0), null, 2));
    const errors = [
      ['usage', 2, main(['--override', 'lines-per-file', '--reason', 'r', '--cwd', cwd])],
      ['config', 2, check(project({ config: mintedAt(0, { limits: { depth: { value: 0, tolerance: 0, reason: 'r' } } }) }))],
      ['enumeration', 2, check(nogit)],
      ['scope', 1, check(project({ files: { 'src/bin.mjs': Buffer.from([0x61, 0xff, 0x0a]) }, config: mintedAt(1) }))],
    ];
    for (const [label, code, result] of errors) {
      assert.equal(result.code, code, `${label}: ${result.stdout}${result.stderr}`);
      assert.doesNotMatch(result.stdout, /^source-size: limit /m, `${label}: no limit line`);
    }
  });
});

describe('source-size — every rendered refusal states WHY (D-17 U4)', () => {
  // spec:source-size/S8
  it('refusal-states-why: the absent (at --override and --adopt), unminted, violating and reason-required renders all close with the ONE sentence', () => {
    const absent = project({ files: { 'src/ok.mjs': lines(10) }, config: null });
    const judged = check(absent);
    assert.equal(judged.code, 0, `--check judges an absent config instead of refusing it:\n${judged.stdout}`);
    assert.ok(!judged.stdout.includes(CANONICAL_WHY), 'a green judgement is no refusal');
    assert.equal(SOURCE_SIZE_WHY, CANONICAL_WHY, 'the practice exports the canonical sentence');
    const violating = project({
      files: { 'src/big.mjs': lines(441) },
      config: { ...AUTHORED, baseline: {}, aggregate: { src: { lines: 441, reason: 'initial adoption' } } },
    });
    const refusals = [
      ['config absent, at --override', main(['--override', 'depth', '--value', '7', '--reason', 'r', '--cwd', absent])],
      ['config absent, at --adopt', main(['--adopt', '--cwd', absent])],
      ['config authored, not yet minted', check(project({ files: { 'src/ok.mjs': lines(10) } }))],
      ['a file over the declared cap', check(violating)],
      ['a regeneration that raises without a reason', main(['--write-baseline', '--cwd', violating])],
    ];
    for (const [label, result] of refusals) {
      assert.equal(result.code, 1, `${label}: a refusal exits 1 — ${result.stdout}${result.stderr}`);
      assert.equal(lastLine(result), WHY_LINE, `${label}: the refusal closes with the canonical WHY`);
    }
  });

  it('an input the practice could not judge at all is NOT dressed as a size lesson', () => {
    // A tree with no git index cannot be enumerated: the reason a module should stay small explains
    // nothing about it, so the WHY stays off the input-error lane (exit 2, a different class).
    const cwd = join(TMP, `nogit${seq += 1}`);
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify({ ...AUTHORED, baseline: {}, aggregate: {} }, null, 2));
    const result = check(cwd);
    assert.equal(result.code, 2);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(CANONICAL_WHY));
  });
});

describe('source-size — the plan keeps its own rule', () => {
  it('phase3-plan-files-within-defaults: every file this plan has created through Phase 3 is within the declared defaults', () => {
    // Cumulative and EXPLICIT (never derived from git state), so an earlier phase's file growing under
    // a later phase's edits is caught here. Phase 3 added no runtime module — only this test file.
    const created = [
      'agent-workflow-kit/tools/source-size-core.mjs',
      'agent-workflow-kit/tools/source-size-check.mjs',
      'agent-workflow-kit/tools/source-size-check.test.mjs',
      'agent-workflow-kit/tools/source-size-core.test.mjs',
      'agent-workflow-kit/tools/source-size-config.test.mjs',
      'agent-workflow-kit/tools/source-size-ratchet.test.mjs',
      'agent-workflow-kit/tools/source-size-refusal.mjs',
      'agent-workflow-kit/tools/source-size-config.mjs',
      'agent-workflow-kit/tools/source-size-scope.mjs',
      'agent-workflow-kit/tools/source-size-gate-cmd.mjs',
      'agent-workflow-kit/tools/source-size-judge.mjs',
      'agent-workflow-kit/tools/source-size-report.mjs',
      'agent-workflow-kit/tools/source-size-aggregate.test.mjs',
      'agent-workflow-kit/tools/source-size-writer.test.mjs',
      'agent-workflow-kit/tools/source-size-practice.test.mjs',
      'agent-workflow-kit/tools/source-size-stop-rendering.test.mjs',
    ];
    for (const rel of created) {
      const { lines: count, maxLineBytes } = measureFile(REPO_ROOT, rel);
      assert.ok(count <= SOURCE_SIZE_DEFAULTS.maxLines, `${rel}: ${count} lines exceeds ${SOURCE_SIZE_DEFAULTS.maxLines}`);
      assert.ok(maxLineBytes <= SOURCE_SIZE_DEFAULTS.maxLineBytes, `${rel}: longest line ${maxLineBytes} bytes exceeds ${SOURCE_SIZE_DEFAULTS.maxLineBytes}`);
    }
  });
});
