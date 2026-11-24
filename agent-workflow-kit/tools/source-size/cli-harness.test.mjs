import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { AGENT_RULES, RULES_EFFECTIVE } from '../../references/scripts/shared/index.mjs';
import { main } from '../source-size-check.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-layout-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const FAIL = 'source-size: FAIL — ';
const REMEDY = 'source-size: REMEDY — ';

export const RECORDED_EXCEPTION_ENDING = 'a recorded exception holds the size it was reasoned for, not growth past it';
export const REVISION_13_README = "Source-size practice: declared scope + the recorded ratchet; the limits are the kit's, kept in its code. Authored keys: schema, roots, exclude, extensions, limits (a project's reasoned overrides of a kit limit). Machine keys: baseline, layout — each recorded entry is an exception with its own reason, never permission to grow. Strict JSON — unknown keys refused.";
export const CODE_RULE_QUESTION_LINES = [
  `for each place above, ask first whether the project's code rules were kept; consult ${AGENT_RULES} and ${RULES_EFFECTIVE} where present`,
  'a broken rule: fix the code along its own seam; the rules kept and the size justified: record it as an exception with its reason, written by whoever runs the write, never asked of the user',
  'never split or compress a file for the number',
  "an old file grown in work about something else, its rules not kept: write a debt row and record the raise with a reason that names the row, never reworking the file outside that work's scope",
];
export const HAND_RECORD_REMEDY_LINES = [
  'record each raised file by hand under "baseline", with that file\'s own reason: the entries below',
  'only where one reason fits every raise of this run, regenerate instead:',
];

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
