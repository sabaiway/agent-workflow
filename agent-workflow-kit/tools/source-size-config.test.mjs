// source-size-config.test.mjs — the config validator's REFUSALS, one test per rule. A malformed or
// unknown-keyed config is a loud STOP rather than a guess, because every one of these rules can
// otherwise be disarmed silently: a typo'd key, an empty scope array, an overlapping root or a
// placeholder left in place would each turn the practice into an empty green.
//
// The fail-closed arms of the addressing helpers ride here too: an unresolvable path is never
// canonical, and an empty declared root is a loud NOTE rather than either a refusal or a silence.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, sameFile } from './source-size-check.mjs';
import { validateSourceSizeConfig, matchesSourceSizeGate, SOURCE_SIZE_DEFAULTS } from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-config-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

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

const refuses = (over, pattern) =>
  assert.throws(() => validateSourceSizeConfig(CONFIG(over)), pattern);

let seq = 0;
const project = (files, rawConfig) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), rawConfig);
  const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  return cwd;
};

describe('source-size — the config validator refuses what it cannot judge', () => {
  it('config-unknown-key-refused: a typo would otherwise disarm the rule it meant to set', () => {
    refuses({ rooots: ['src'] }, /carries unknown key\(s\): rooots/);
  });

  it('config-schema-mismatch-refused: an unknown schema is never read on a guess', () => {
    refuses({ schema: 2 }, /"schema" must be 1, got 2/);
  });

  it('config-empty-roots-refused: an empty scope array is a misdeclaration, never an empty green', () => {
    refuses({ roots: [] }, /"roots" must be a non-empty array/);
  });

  it('config-empty-extensions-refused: the kit ships no default file-type list, so an empty one is refused', () => {
    refuses({ extensions: [] }, /"extensions" must be a non-empty array/);
  });

  it('config-extension-placeholder-refused: the printed template stays INERT until a human replaces it', () => {
    refuses({ extensions: ['<.an-extension-this-practice-covers>'] }, /still carries the authoring placeholder/);
  });

  it('config-extension-malformed-refused: an extension must look like an extension', () => {
    refuses({ extensions: ['mjs'] }, /must look like "\.mjs"/);
    refuses({ extensions: ['.'] }, /must look like "\.mjs"/);
    refuses({ extensions: ['.a/b'] }, /must look like "\.mjs"/);
  });

  it('config-overlapping-roots-refused: an overlapping root would double-count its files', () => {
    refuses({ roots: ['src', 'src/inner'], aggregate: undefined }, /"roots" entries overlap/);
  });

  it('config-duplicate-roots-refused: the overlap rule compares DISTINCT values, so a repeat needs its own refusal', () => {
    refuses({ roots: ['src', 'src'] }, /"roots" declares "src" twice/);
  });

  it('config-aggregate-rejects-line-bytes: the root budget has one dimension and says so', () => {
    refuses(
      { aggregate: { src: { lines: 10, maxLineBytes: 80, reason: 'r' } } },
      /the aggregate budgets LINES only/,
    );
  });

  it('reason-multiline-refused: a reason is copied verbatim into JSON, a commit message and a CHANGELOG', () => {
    refuses(
      { baseline: { 'src/a.mjs': { lines: 401, reason: 'first line\nsecond line' } } },
      /must be ONE line with no control bytes/,
    );
  });

  it('config-value-ranges-validated: a cap that is not a positive integer would silently exempt or refuse everything', () => {
    for (const bad of [0, -1, 1.5, '400', null]) {
      refuses({ defaults: { maxLines: bad, maxLineBytes: 1000 } }, /"defaults"\.maxLines must be a positive integer/);
      refuses({ defaults: { maxLines: 400, maxLineBytes: bad } }, /"defaults"\.maxLineBytes must be a positive integer/);
    }
    refuses({ defaults: { maxLines: 400, maxLineBytes: 1000, maxWhatever: 1 } }, /"defaults" carries unknown key\(s\): maxWhatever/);
    // A RECORDED size may be zero (an empty file), but never negative and never fractional.
    refuses({ baseline: { 'src/a.mjs': { lines: -1, reason: 'r' } } }, /"baseline"\."src\/a\.mjs"\.lines must be a non-negative integer/);
    assert.doesNotThrow(() => validateSourceSizeConfig(CONFIG({ baseline: { 'src/a.mjs': { lines: 0, reason: 'r' } } })));
  });

  it('config-root-containment: a declared path escapes nothing — no absolute root, no traversal, no bare dot', () => {
    for (const bad of ['/etc', '../sibling', 'src/../../out', './src', 'src//nested']) {
      refuses({ roots: [bad], aggregate: undefined }, /a "roots" entry/);
      refuses({ exclude: [bad] }, /an "exclude" entry/);
    }
    refuses({ baseline: { '../outside.mjs': { lines: 401, reason: 'r' } } }, /a "baseline" key/);
  });

  it('config-malformed-stops-exit-2: a config that cannot be parsed is a STOP, never a guess', () => {
    const cwd = project({ 'src/a.mjs': 'x\n' }, '{ this is not json');
    const result = main(['--check', '--cwd', cwd]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is not valid JSON/);
    assert.ok(result.stderr.includes(join(cwd, 'docs/ai/source-size.json')), `the STOP names the file to fix:\n${result.stderr}`);
  });
});

describe('source-size — the fail-closed arms of the addressing helpers', () => {
  it('matcher-unresolvable-token-fails-closed: a path that resolves to nothing is never canonical', () => {
    assert.equal(matchesSourceSizeGate(`node ${join(TMP, 'no-such-dir/source-size-check.mjs')} --check`, REPO_ROOT), false);
    assert.equal(matchesSourceSizeGate(`node "${join(TMP, 'no-such-dir/source-size-check.mjs')}" --check`, REPO_ROOT), false);
  });

  it('same-file-seam-fails-closed-on-an-unresolvable-path: the direct-run guard never throws', () => {
    assert.equal(sameFile(TOOL, TOOL), true);
    assert.equal(sameFile(TOOL, join(TMP, 'no-such-entry-point.mjs')), false);
  });

  it('empty-root-is-a-loud-note-not-a-refusal: a declared root matching nothing is stated, and the run still passes', () => {
    const cwd = project(
      { 'src/a.mjs': 'x\n' },
      JSON.stringify({
        ...CONFIG({ roots: ['src', 'extra'], aggregate: { src: { lines: 1, reason: 'r' }, extra: { lines: 0, reason: 'r' } } }),
      }, null, 2),
    );
    mkdirSync(join(cwd, 'extra'), { recursive: true });
    const result = main(['--check', '--cwd', cwd]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /NOTE — the declared root "extra" matches no tracked file/);
  });
});
