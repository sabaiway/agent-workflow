import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalDelegationDigest, DELEGATION_SCHEMA_VERSION, expectedBundleLength } from './dispatch-record.mjs';

const DIGEST_BYTES = 32;
const DIFF_LENGTH = 100;
const REPORT_LENGTH = 50;
const FIXTURE_EPOCH_LEAD_MS = 60_000;
const DEFAULT_TIMESTAMP = '2030-01-01T00:00:01.000Z';

export const digestOf = (pair) => pair.repeat(DIGEST_BYTES);

export const buildRegistration = (overrides = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION,
  kind: 'pre-registration',
  waveId: 'held-session-wave',
  stepClasses: ['code'],
  pairingKey: 'stepClass',
  minPerClass: 1,
  meanLThreshold: 2,
  firstPassNum: 1,
  firstPassDen: 1,
  timestamp: DEFAULT_TIMESTAMP,
  ...overrides,
});

export const buildDispatch = (overrides = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION,
  kind: 'dispatch',
  waveId: 'held-session-wave',
  nonce: 'held-1',
  stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  backend: 'codex',
  contractDigest: digestOf('c1'),
  preTreeDigest: digestOf('a1'),
  baselineClean: true,
  deadlineS: 900,
  retryOf: null,
  retryIndex: 0,
  retryCap: 2,
  rationale: 'bounded held-session fixture',
  timestamp: DEFAULT_TIMESTAMP,
  ...overrides,
});

export const buildReturn = (dispatch, overrides = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION,
  kind: 'return',
  role: 'execute',
  backend: dispatch.backend,
  nonce: dispatch.nonce,
  contractDigest: dispatch.contractDigest,
  preTreeDigest: dispatch.preTreeDigest,
  postTreeDigest: digestOf('b2'),
  diffDigest: digestOf('d3'),
  diffLength: DIFF_LENGTH,
  reportDigest: digestOf('e4'),
  reportLength: REPORT_LENGTH,
  bundleDigest: digestOf('f5'),
  bundleLength: expectedBundleLength(DIFF_LENGTH, REPORT_LENGTH),
  metric: {
    numeratorBytes: DIFF_LENGTH,
    denominatorBytes: expectedBundleLength(DIFF_LENGTH, REPORT_LENGTH),
    components: [{ kind: 'modified', path: 'fixture.mjs', objectId: 'fixture-object', bytes: DIFF_LENGTH }],
    provenance: 'wrapper-git',
    eligible: dispatch.baselineClean,
    ineligibleReason: dispatch.baselineClean ? null : 'dirty-baseline',
  },
  outcome: 'success',
  exitStatus: 0,
  sessionId: 'session-held',
  wrapperVersion: '3.4.1',
  posture: { model: 'fixture-runtime', effort: 'high', tier: 'priority' },
  timestamp: '2030-01-01T00:00:02.000Z',
  ...overrides,
});

export const buildFold = (returned, overrides = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION,
  kind: 'fold',
  nonce: returned.nonce,
  returnDigest: canonicalDelegationDigest(returned),
  treeDigestAtFold: returned.postTreeDigest,
  verdict: 'folded as returned',
  timestamp: '2030-01-01T00:00:03.000Z',
  ...overrides,
});

export const buildThread = ({ dispatch = {}, returned = {}, fold = {} } = {}) => {
  const dispatchRecord = buildDispatch(dispatch);
  const returnRecord = buildReturn(dispatchRecord, returned);
  return [dispatchRecord, returnRecord, buildFold(returnRecord, fold)];
};

export const createFixtureRepo = ({ execute = 'delegated', review = 'solo', dirty = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'aw-held-session-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), `${JSON.stringify({ 'plan-execution': { execute, review } }, null, 2)}\n`);
  writeFileSync(join(root, 'docs', 'plans', 'active.md'), '# Active fixture plan\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  if (dirty) writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
  return root;
};

const runFixtureGit = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
    throw new Error(`fixture git ${args[0]} failed: ${reason}`);
  }
};

export const createFixtureGitRepo = (options = {}) => {
  const root = createFixtureRepo({ ...options, dirty: false });
  try {
    runFixtureGit(root, ['init', '-q', '-b', 'main']);
    runFixtureGit(root, ['add', '-A']);
    runFixtureGit(root, [
      '-c', 'user.name=coder-tool', '-c', 'user.email=coder-tools@proton.me',
      '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture base',
    ]);
    const epochTimestamp = new Date(Date.now() + FIXTURE_EPOCH_LEAD_MS).toISOString();
    writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
    return { root, epochTimestamp };
  } catch (error) {
    removeFixtureRepo(root);
    throw error;
  }
};

export const removeFixtureRepo = (root) => rmSync(root, { recursive: true, force: true });

export const writeFixtureLedger = (root, records, name = 'delegation.jsonl') => {
  const path = join(root, name);
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return path;
};
