// source-size-ratchet.test.mjs — what a RECORDED size does and does not buy. A baseline entry is
// debt for the dimension it names and for nothing else, and the addressing around it (the canonical
// matcher's alphabet, the config path a refusal prints) must be exact in both directions: never
// accept a command the shell would read differently, and never refuse one that runs verbatim.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './source-size-check.mjs';
import { configPathFor, matchesSourceSizeGate, SOURCE_SIZE_DEFAULTS } from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-ratchet-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const CONFIG = (baseline) => ({
  _README: 'fixture',
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  baseline,
  aggregate: { src: { lines: 0, reason: 'initial adoption' } },
});

let seq = 0;
const project = (files, baseline) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(cwd, rel), body);
  writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(CONFIG(baseline), null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const check = (cwd) => main(['--check', '--cwd', cwd]);

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
      { 'src/big.mjs': 'x\n'.repeat(401) },
      { 'src/big.mjs': { maxLineBytes: 1, reason: 'recorded at adoption' } },
    );
    const result = check(cwd);
    assert.equal(result.code, 1, `a dimension nobody recorded must still be judged:\n${result.stdout}`);
    assert.match(result.stdout, /src\/big\.mjs: lines 401 exceeds the declared default 400/);
  });

  it('a record covering the violating dimension still exempts it', () => {
    const cwd = project(
      { 'src/big.mjs': 'x\n'.repeat(401) },
      { 'src/big.mjs': { lines: 401, reason: 'recorded at adoption' } },
    );
    assert.equal(check(cwd).code, 0);
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
