import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildState, decideCheck } from './review-state.mjs';
import {
  buildRegistration, buildThread, createFixtureGitRepo, digestOf,
  removeFixtureRepo, writeFixtureLedger,
} from './delegation-harness.test.mjs';

const MILLISECONDS_PER_SECOND = 1000;
const TREE_OID_LENGTH = 40;
const TASK = { brief: 'docs/plans/TASK-fixture-T1.md', files: ['src/task.mjs'] };
const CHECKPOINT = { kind: 'checkpoint', treeOid: 'e'.repeat(TREE_OID_LENGTH) };
const POISONED_LEDGER = 'not json\n';

const deriveTimestamp = (base, seconds) =>
  new Date(Date.parse(base) + seconds * MILLISECONDS_PER_SECOND).toISOString();

const buildTaskChainRecords = (base) => [
  buildRegistration({ timestamp: deriveTimestamp(base, 0) }),
  ...buildThread({
    dispatch: { nonce: 'task-first', baseline: CHECKPOINT, task: TASK, timestamp: deriveTimestamp(base, 1) },
    returned: { sessionId: 'session-held', postTreeDigest: digestOf('b1'), timestamp: deriveTimestamp(base, 2) },
    fold: { timestamp: deriveTimestamp(base, 3) },
  }),
  ...buildThread({
    dispatch: {
      nonce: 'task-substituted', baseline: CHECKPOINT, task: TASK, contractDigest: digestOf('c2'),
      preTreeDigest: digestOf('a2'), timestamp: deriveTimestamp(base, 4),
    },
    returned: { sessionId: 'session-new', postTreeDigest: digestOf('b2'), timestamp: deriveTimestamp(base, 5) },
    fold: { timestamp: deriveTimestamp(base, 6) },
  }),
];

const withTempGitRoot = (run) => {
  const fixture = createFixtureGitRepo();
  try {
    return run(fixture);
  } finally {
    removeFixtureRepo(fixture.root);
  }
};

const buildConfiguredState = (root, config, ledger) => {
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), `${JSON.stringify(config, null, 2)}\n`);
  return buildState({ cwd: root, env: { AW_DELEGATION_STORE: ledger }, detect: () => [] });
};

describe('review-state configured task execute — spec:carriers/S19', () => {
  const refusalConfigs = [
    { 'plan-execution': { execute: 'solo', review: 'solo' }, task: { execute: 'delegated' } },
    { 'plan-execution': { execute: 'subagent', review: 'solo' }, task: { execute: 'delegated' } },
    { 'plan-execution': { execute: 'delegated', review: 'solo' }, task: { execute: 'solo' } },
    { 'plan-execution': { execute: 'delegated', review: 'solo' }, task: { execute: 'subagent' } },
  ];
  for (const config of refusalConfigs) {
    it(`refuses a task-chain substitution with no backend ready: ${JSON.stringify(config)}`, () =>
      withTempGitRoot(({ root, epochTimestamp }) => {
        const ledger = writeFixtureLedger(root, buildTaskChainRecords(epochTimestamp));
        const state = buildConfiguredState(root, config, ledger);
        const refusal = decideCheck(state);
        assert.equal(refusal.code, 1);
        assert.match(refusal.reason, /task-substituted.*session-held.*session-new/u);
      }));
  }

  const inertConfigs = [
    { 'plan-execution': { execute: 'solo', review: 'solo' }, task: { execute: 'solo' } },
    { 'plan-execution': { execute: 'subagent', review: 'solo' }, task: { execute: 'subagent' } },
    { 'plan-execution': { execute: 'solo', review: 'solo' }, task: { author: 'delegated', execute: 'solo' } },
  ];
  for (const config of inertConfigs) {
    it(`does not read a poisoned ledger without a delegated execute slot: ${JSON.stringify(config)}`, () =>
      withTempGitRoot(({ root }) => {
        const ledger = join(root, 'delegation.jsonl');
        writeFileSync(ledger, POISONED_LEDGER);
        const state = buildConfiguredState(root, config, ledger);
        assert.equal(state.heldSession, null);
      }));
  }

  it('does not read a poisoned ledger for delegated task.execute without a plan in flight', () =>
    withTempGitRoot(({ root }) => {
      const config = {
        'plan-execution': { execute: 'solo', review: 'solo' }, task: { execute: 'delegated' },
      };
      const ledger = join(root, 'delegation.jsonl');
      writeFileSync(ledger, POISONED_LEDGER);
      rmSync(join(root, 'docs', 'plans', 'active.md'));
      const state = buildConfiguredState(root, config, ledger);
      assert.deepEqual(state.plans, []);
      assert.equal(state.heldSession, null);
    }));
});
