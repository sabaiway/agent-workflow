import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { hermeticGitEnv } from '../git-env.mjs';
import { makeFixtureRepo } from '../../../scripts/testing/fixture-repo.mjs';
import { main as runDispatch } from '../dispatch.mjs';
import { DELEGATION_SCHEMA_VERSION } from '../dispatch-record.mjs';
import { KIT_OVERRIDE } from './run-harness.test.mjs';

const TOOLS = 'agent-workflow-kit/tools/';
const CHECK = '--check';
const TEST_CONTEXT = 'NODE_TEST_CONTEXT';
const IDENTITY = Object.freeze(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com']);
const INIT_ARGUMENTS = Object.freeze(['-q', '-b', 'main']);
const BASE_FILES = Object.freeze({ 'base.txt': 'base\n' });
const PENDING_FILES = Object.freeze({ 'pending.txt': 'pending\n' });
const CONTROL_BYTE = String.fromCharCode(1);
const OVERSIZED_LINES = 441;
const SIZE_RECORD = JSON.stringify({
  _README: 'fixture',
  schema: 2,
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  baseline: {},
  aggregate: { src: { lines: OVERSIZED_LINES, reason: 'adoption' } },
});
const COUNCIL_CONFIG = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });
const LCOV_PATH = '.git/agent-workflow-lcov.info';
const FLOW_STORE_PATH = '.git/agent-workflow-flow.jsonl';
const FEEDBACK_RECORD_PATH = 'record.md';
const FEEDBACK_RECORD = [
  '# Feedback: Fixture report',
  '',
  'Source: field report',
  '',
  `Head: ${'a'.repeat(40)}`,
  '',
  '## Claims',
  '',
  '| # | Claim | Evidence | Verdict | Disposition |',
  '| --- | --- | --- | --- | --- |',
  '| 1 | Claim | `anchor.txt:1-3` | confirmed | queue ROW-A |',
  '',
].join('\n');
const BRIEF_PATH = 'brief.md';
const DISPATCH_NONCE = 'fixture-nonce';
const PASSED_INSTANT = '2000-01-01T00:00:00.000Z';
const DISPATCH_CONTRACT = JSON.stringify({
  schema: DELEGATION_SCHEMA_VERSION,
  nonce: DISPATCH_NONCE,
  stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'a fixture sub-task',
  inputs: 'none',
  acceptance: 'none',
  returnShape: 'a unified diff',
  producerContract: 'the wrapper mints the return record',
  deadlineS: 900,
  retry: { cap: 1, index: 0 },
}, null, 2);
const REGISTER_ARGUMENTS = Object.freeze(['register', '--wave', 'wave-a', '--step-classes', 'code',
  '--pairing-key', 'stepClass', '--min-per-class', '1', '--mean-l-threshold', '1',
  '--first-pass-num', '0', '--first-pass-den', '1']);
const OPEN_ARGUMENTS = Object.freeze(['open', '--wave', 'wave-a', '--backend', 'codex',
  '--rationale', 'a fixture sub-task', '--wrapper-cap-s', '600', '--kill-grace-s', '15', '--contract']);

const getGitEnvironment = (project) => Object.fromEntries(Object.entries(hermeticGitEnv(process.env, project))
  .filter(([key]) => key !== TEST_CONTEXT && !KIT_OVERRIDE.test(key)));

const runGit = (project, gitArguments) => {
  const result = spawnSync('git', [...IDENTITY, ...gitArguments], { cwd: project, env: getGitEnvironment(project), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${gitArguments.join(' ')} failed in ${project}: ${result.stderr}`);
  return result.stdout;
};

const writeFiles = (project, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
};

const makeRepository = (project, committed, pending = {}) => {
  makeFixtureRepo((gitArguments) => runGit(project, gitArguments), project, INIT_ARGUMENTS);
  writeFiles(project, committed);
  runGit(project, ['add', '-A']);
  runGit(project, ['commit', '-qm', 'fixture']);
  writeFiles(project, pending);
  return hermeticGitEnv({}, project);
};

const buildCouncilWithoutReceipts = (project) => makeRepository(project, {
  'docs/ai/orchestration.json': COUNCIL_CONFIG,
  'docs/plans/queue.md': '# Queue\n',
  'docs/plans/plan.md': '# Plan\n',
}, PENDING_FILES);

const buildPassedDeadline = (project) => {
  const environment = makeRepository(project, BASE_FILES);
  const contractPath = join(dirname(project), 'contract.md');
  writeFileSync(contractPath, `# A sub-task\n\n\`\`\`aw-dispatch-contract\n${DISPATCH_CONTRACT}\n\`\`\`\n`);
  for (const dispatchArguments of [REGISTER_ARGUMENTS, [...OPEN_ARGUMENTS, contractPath]]) {
    const result = runDispatch(dispatchArguments, { cwd: project, env: getGitEnvironment(project), now: () => PASSED_INSTANT });
    if (result.code !== 0) throw new Error(`dispatch ${dispatchArguments[0]} failed in ${project}: ${result.stderr}`);
  }
  return environment;
};

const makeEntry = (file, commandArguments, redCase, build) => Object.freeze({
  path: `${TOOLS}${file}`,
  commandArguments: Object.freeze(commandArguments),
  redCase,
  build,
});

export const GIT_FIXTURES = Object.freeze([
  makeEntry('control-bytes.mjs', [CHECK], 'control-byte-in-tracked-file', (project) => makeRepository(project, {
    'notes.txt': `one${CONTROL_BYTE}two\n`,
  })),
  makeEntry('source-size-check.mjs', [CHECK], 'file-past-its-cap', (project) => makeRepository(project, {
    'docs/ai/source-size.json': SIZE_RECORD,
    'src/big.mjs': 'x\n'.repeat(OVERSIZED_LINES),
  })),
  makeEntry('commit-guard.mjs', [CHECK], 'index-lags-work-tree', (project) => makeRepository(project, BASE_FILES, PENDING_FILES)),
  makeEntry('coverage-check.mjs', [CHECK], 'changed-line-uncovered', (project) => makeRepository(project, BASE_FILES, {
    'changed.mjs': 'export const value = 1;\n',
    [LCOV_PATH]: 'SF:changed.mjs\nDA:1,0\nend_of_record\n',
  })),
  makeEntry('review-state.mjs', [CHECK], 'council-without-receipts', buildCouncilWithoutReceipts),
  makeEntry('review-state.mjs', ['--await', '--timeout', '1'], 'council-without-receipts', buildCouncilWithoutReceipts),
  makeEntry('dispatch.mjs', ['await', '--nonce', DISPATCH_NONCE], 'dispatch-deadline-passed', buildPassedDeadline),
  makeEntry('flow-check.mjs', [CHECK], 'malformed-flow-store', (project) => makeRepository(project, BASE_FILES, {
    [FLOW_STORE_PATH]: 'not a record\n',
  })),
  makeEntry('feedback-record-cli.mjs', [CHECK, FEEDBACK_RECORD_PATH], 'record-head-mismatch', (project) => makeRepository(project, {
    'anchor.txt': 'one\ntwo\nthree\n',
    [FEEDBACK_RECORD_PATH]: FEEDBACK_RECORD,
  })),
  makeEntry('task-brief.mjs', ['check', BRIEF_PATH], 'brief-without-title', (project) => makeRepository(project, {
    [BRIEF_PATH]: 'A brief with no title.\n',
  })),
]);
