// source-size-aggregate.test.mjs — the per-root budget (D-4). Splitting 3000 lines into six files of
// 500 buys ZERO aggregate headroom: the per-file cap alone would reward shredding a module into
// pieces nobody reviews. The budget rides the same ratchet as a per-file record (grow → reasoned
// bump, shrink → tighten, root gone → error) and it budgets ONE dimension, because summing per-file
// longest-line bytes has no physical meaning.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './source-size-check.mjs';
import { SOURCE_SIZE_DEFAULTS, validateSourceSizeConfig } from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-aggregate-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const lines = (n) => 'x\n'.repeat(n);

const CONFIG = (over = {}) => ({
  _README: 'fixture',
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  baseline: {},
  aggregate: { src: { lines: 0, reason: 'initial adoption' } },
  ...over,
});

let seq = 0;
const project = ({ files = {}, config = CONFIG() } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const check = (cwd) => main(['--check', '--cwd', cwd]);
const writeBaseline = (cwd, reason) =>
  main(reason === undefined ? ['--write-baseline', '--cwd', cwd] : ['--write-baseline', '--cwd', cwd, '--reason', reason]);
const configOf = (cwd) => JSON.parse(readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8'));

describe('source-size — the aggregate budget (D-4)', () => {
  // spec:source-size/S4
  it('aggregate-split-buys-no-headroom: two halves under the per-file cap still exceed the recorded root budget', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(260), 'src/b.mjs': lines(260) },
      config: CONFIG({ aggregate: { src: { lines: 500, reason: 'initial adoption' } } }),
    });
    const result = check(cwd);
    assert.equal(result.code, 1, `520 lines against a 500-line budget must refuse:\n${result.stdout}`);
    assert.match(result.stdout, /src: aggregate lines 520 exceeds the recorded budget 500/);
    assert.doesNotMatch(result.stdout, /exceeds the declared default/, 'neither half violates the per-file cap — only the budget does');
  });

  // spec:source-size/S5
  it('aggregate-growth-needs-reason: the budget bump is reasoned, and the reason lands in the entry', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(260), 'src/b.mjs': lines(260) },
      config: CONFIG({ aggregate: { src: { lines: 500, reason: 'initial adoption' } } }),
    });
    const refused = writeBaseline(cwd);
    assert.equal(refused.code, 1, `a raise with no reason must refuse:\n${refused.stdout}${refused.stderr}`);
    assert.equal(configOf(cwd).aggregate.src.lines, 500, 'a refused regeneration writes nothing');

    const written = writeBaseline(cwd, 'tranche 1: the module split landed');
    assert.equal(written.code, 0, `${written.stdout}${written.stderr}`);
    assert.deepEqual(configOf(cwd).aggregate.src, { lines: 520, reason: 'tranche 1: the module split landed' });
    assert.equal(check(cwd).code, 0, 'the regenerated budget arms the ratchet again');
  });

  it('aggregate-shrink-requires-tighten: a budget above the tree is headroom nobody earned', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(100) },
      config: CONFIG({ aggregate: { src: { lines: 500, reason: 'initial adoption' } } }),
    });
    const result = check(cwd);
    assert.equal(result.code, 1, `an unearned budget must refuse:\n${result.stdout}`);
    assert.match(result.stdout, /src: aggregate lines 100 is under the recorded budget 500 — the budget is STALE/);

    assert.equal(writeBaseline(cwd).code, 0, 'tightening needs no reason');
    assert.equal(configOf(cwd).aggregate.src.lines, 100);
    assert.equal(configOf(cwd).aggregate.src.reason, 'initial adoption', 'a tighten keeps the reason already recorded');
  });

  it('aggregate-root-gone-errors: a budget for a root nobody declares any more is surfaced, never ignored', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(10) },
      config: CONFIG({ aggregate: { src: { lines: 10, reason: 'r' }, dropped: { lines: 900, reason: 'r' } } }),
    });
    const result = check(cwd);
    assert.equal(result.code, 1, `a budget for an undeclared root must refuse:\n${result.stdout}`);
    assert.match(result.stdout, /dropped: recorded in "aggregate" but no longer a declared root/);
  });

  // spec:source-size/S6
  it('aggregate-entries-mirror-roots-exactly: a missing entry can never disarm the budget, and the writer restores the exact set', () => {
    const cwd = project({
      files: { 'src/a.mjs': lines(10), 'extra/b.mjs': lines(20) },
      config: CONFIG({ roots: ['src', 'extra'], aggregate: { src: { lines: 10, reason: 'r' } } }),
    });
    const result = check(cwd);
    assert.equal(result.code, 1, `a declared root with no recorded budget must refuse:\n${result.stdout}`);
    assert.match(result.stdout, /extra: declared root carries NO recorded aggregate budget/);

    assert.equal(writeBaseline(cwd, 'record the second root').code, 0);
    assert.deepEqual(Object.keys(configOf(cwd).aggregate), ['src', 'extra'], 'the writer records exactly the declared roots');
    assert.equal(check(cwd).code, 0);
  });

  it('aggregate-lines-only: the budget has ONE dimension, and a split releases no line-length headroom', () => {
    assert.throws(
      () => validateSourceSizeConfig(CONFIG({ aggregate: { src: { lines: 10, maxLineBytes: 4000, reason: 'r' } } })),
      /the aggregate budgets LINES only/,
    );
    // Two files, each carrying one over-long line: the per-file dimension is judged per file, so
    // spreading the bytes across more files buys nothing — both are named.
    const cwd = project({ files: { 'src/a.mjs': `${'x'.repeat(1001)}\n`, 'src/b.mjs': `${'y'.repeat(1001)}\n` } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/a\.mjs: maxLineBytes 1001 exceeds the declared default 1000/);
    assert.match(result.stdout, /src\/b\.mjs: maxLineBytes 1001 exceeds the declared default 1000/);

    assert.equal(writeBaseline(cwd, 'both long lines recorded').code, 0);
    assert.deepEqual(Object.keys(configOf(cwd).aggregate.src).sort(), ['lines', 'reason'], 'a minted budget carries no byte dimension');
  });
});
