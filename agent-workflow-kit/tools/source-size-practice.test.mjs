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
import { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_WHY, measureFile } from './source-size-core.mjs';

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
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
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

describe('source-size — the standing echo on a GREEN run (D-17 U4)', () => {
  it('gate-green-line-names-practice: a PASS states the caps, the record and the exact-budget rule in one line', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(401), 'src/ok.mjs': lines(10) },
      config: {
        ...AUTHORED,
        baseline: { 'src/big.mjs': { lines: 401, reason: 'initial adoption' } },
        aggregate: { src: { lines: 411, reason: 'initial adoption' } },
      },
    });
    const result = check(cwd);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      lastLine(result),
      'source-size: practice — caps 400 lines · 1000 bytes per line over 1 declared root(s) · 1 file(s) carry a recorded size (debt, not permission) · aggregate 411 line(s), EXACT: growth takes a reasoned bump, never free headroom.',
    );
    assert.match(result.stdout, /source-size: PASS — 2 in-scope file\(s\)/, 'the pass line itself is unchanged');
  });

  it('the standing line reads the CONFIG, not a constant: a tightened project states its own caps', () => {
    const cwd = project({
      files: { 'src/ok.mjs': lines(10) },
      config: { ...AUTHORED, defaults: { maxLines: 50, maxLineBytes: 120 }, baseline: {}, aggregate: { src: { lines: 10, reason: 'initial adoption' } } },
    });
    const result = check(cwd);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(lastLine(result), /caps 50 lines · 120 bytes per line over 1 declared root\(s\) · 0 file\(s\) carry a recorded size/);
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

describe('source-size — every rendered refusal states WHY (D-17 U4)', () => {
  it('refusal-states-why: the absent, unminted, violating and reason-required renders all close with the ONE sentence', () => {
    assert.equal(SOURCE_SIZE_WHY, CANONICAL_WHY, 'the practice exports the canonical sentence');
    const violating = project({
      files: { 'src/big.mjs': lines(401) },
      config: { ...AUTHORED, baseline: {}, aggregate: { src: { lines: 401, reason: 'initial adoption' } } },
    });
    const refusals = [
      ['config absent', check(project({ files: { 'src/ok.mjs': lines(10) }, config: null }))],
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
