import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { GIT_MAX_BUFFER, stripGitLocationEnv } from '../git-env.mjs';
import { REPOSITORY_ROOT, keyOf, gatherOffered, runCensus } from './run-harness.test.mjs';
import { PLAIN_FIXTURES } from './fixtures-plain-harness.test.mjs';
import { GIT_FIXTURES } from './fixtures-git-harness.test.mjs';
import { FAMILY_FIXTURES } from './fixtures-family-harness.test.mjs';

const FAMILY_PACKAGES = Object.freeze([
  'agent-workflow-kit',
  'agent-workflow-memory',
  'agent-workflow-engine',
  'codex-cli-bridge',
  'antigravity-cli-bridge',
  'typesafe-jev-bridge',
]);
const FIXTURES = [...PLAIN_FIXTURES, ...GIT_FIXTURES, ...FAMILY_FIXTURES];
const TEST_CONTEXT = 'NODE_TEST_CONTEXT';
const SUCCESS_CODE = 0;

const readTrackedText = (path) => {
  try {
    return readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
  } catch (error) {
    throw new Error(`Cannot read tracked file ${path}: ${error.message}`, { cause: error });
  }
};

const gatherPackageBins = (folder) => {
  const manifestPath = posix.join(folder, 'package.json');
  const manifestText = (() => {
    try {
      return readFileSync(join(REPOSITORY_ROOT, manifestPath), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Cannot read ${manifestPath}: ${error.message}`, { cause: error });
    }
  })();
  if (manifestText === null) return [];
  const { bin } = JSON.parse(manifestText);
  const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
  return targets.map((target) => posix.join(folder, target));
};

const gatherFiles = () => {
  const environment = Object.fromEntries(
    Object.entries(stripGitLocationEnv(process.env)).filter(([name]) => name !== TEST_CONTEXT),
  );
  const result = spawnSync('git', ['ls-files', '-z', '--', ...FAMILY_PACKAGES], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  assert.ifError(result.error);
  assert.equal(result.status, SUCCESS_CODE, result.stderr);
  const bins = new Set(FAMILY_PACKAGES.flatMap(gatherPackageBins));
  return result.stdout.split('\0').filter(Boolean).map((path) => {
    const text = readTrackedText(path);
    return {
      path,
      bin: bins.has(path),
      interpreterLine: text.startsWith('#!'),
      guardName: text.includes('isDirectRun'),
    };
  });
};

const readRealRecord = async () => {
  const { readRecord } = await import('./record.mjs');
  return readRecord(readFileSync(new URL('./checkers.json', import.meta.url), 'utf8'));
};

describe('real record census (spec:checker-verdict/S10)', () => {
  it('is whole against the tracked family files and offered command lines', async () => {
    const { judgeWholeness } = await import('./record.mjs');
    const record = await readRealRecord();
    const files = gatherFiles();
    assert.deepEqual(judgeWholeness(record, { files, ...gatherOffered() }), []);
  });

  it('has exactly one fixture for every red case of every command line', async () => {
    const record = await readRealRecord();
    const fixtureKeys = FIXTURES.map(({ path, commandArguments, redCase }) =>
      keyOf(path, commandArguments, redCase));
    assert.equal(new Set(fixtureKeys).size, fixtureKeys.length, 'Fixture keys must be unique');
    const redCaseKeys = record.files.flatMap(({ path, commandLines }) =>
      (commandLines ?? []).flatMap((command) =>
        command.redCases.map((redCase) => keyOf(path, command.arguments, redCase.name))));
    assert.deepEqual(fixtureKeys.toSorted(), redCaseKeys.toSorted());
  });

  it('has misses equal to both records of exceptions', async () => {
    const record = await readRealRecord();
    assert.deepEqual(await runCensus({ record, fixtures: FIXTURES }), []);
  });
});
