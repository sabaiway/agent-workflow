import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { main } from '../source-size-check.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-layout-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const FAIL = 'source-size: FAIL — ';
const REMEDY = 'source-size: REMEDY — ';

export const runGit = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};
export const makeLines = (count) => 'x\n'.repeat(count);
export const makeMany = (directory, count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${directory}/f${index}.txt`, 'x']));
export const configPath = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
const writeTree = (cwd, files) => {
  for (const [relativePath, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, relativePath)), { recursive: true });
    writeFileSync(join(cwd, relativePath), body);
  }
};

export const createProject = ({ files = {}, config = null, store = {} } = {}, suffix = '') => {
  const cwd = join(mkdtempSync(join(TMP, 'p')), `project${suffix}`);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  makeFixtureRepo((args) => runGit(cwd, args), cwd, ['-q', '-b', 'main']);
  writeTree(cwd, files);
  if (config !== null) writeFileSync(configPath(cwd), JSON.stringify(config, null, 2));
  runGit(cwd, ['add', '-A']);
  writeTree(cwd, store);
  return cwd;
};

export const runCli = (cwd, ...args) => main([...args, '--cwd', cwd]);
export const readBlock = (stdout) => {
  const lines = stdout.split('\n');
  const verdict = lines[0].startsWith(FAIL) ? lines[0].slice(FAIL.length) : null;
  const remedyIndex = lines.findIndex((line) => line.startsWith(REMEDY));
  const remaining = remedyIndex < 0 ? [] : lines.slice(remedyIndex);
  const afterIndex = remaining.findIndex((line) => !line.startsWith(REMEDY));
  const remedies = remaining.slice(0, afterIndex < 0 ? remaining.length : afterIndex).map((line) => line.slice(REMEDY.length));
  return {
    verdict,
    findings: verdict === null || remedyIndex < 0 ? [] : lines.slice(1, remedyIndex),
    remedies,
    after: lines.slice(remedyIndex < 0 ? 1 : remedyIndex + remedies.length),
  };
};
