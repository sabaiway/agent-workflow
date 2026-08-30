import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './procedures.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';
import {
  buildDispatch, buildRegistration, buildThread, createFixtureRepo, digestOf,
  removeFixtureRepo, writeFixtureLedger,
} from './delegation-harness.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, '..', '..', 'agent-workflow-engine');
const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const detect = () => [
  { name: CODEX, readiness: READY },
  { name: AGY, readiness: NEEDS_SKILL },
];

const run = (root, argv, extra = {}) => main(argv, {
  cwd: root,
  env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR, ...extra.env },
  detect,
  surveyVehicle: extra.surveyVehicle ?? (() => ({ state: 'missing', reason: null, rel: '.claude/agents/executor.md' })),
  readHeadInstant: extra.readHeadInstant ?? (() => ({ state: 'unborn' })),
  resolveDelegationStorePath: extra.resolveDelegationStorePath,
});

const withRoot = (options, body) => {
  const root = createFixtureRepo(options);
  try {
    return body(root);
  } finally {
    removeFixtureRepo(root);
  }
};

const heldRecords = (sessionId = 'session-held') => [
  buildRegistration(),
  ...buildThread({
    dispatch: { nonce: 'held', timestamp: '2030-01-01T00:00:01.000Z' },
    returned: { sessionId, postTreeDigest: digestOf('b1') },
  }),
];

const substitutedRecords = () => [
  ...heldRecords(),
  ...buildThread({
    dispatch: {
      nonce: 'substituted', baselineClean: false, contractDigest: digestOf('c2'),
      preTreeDigest: digestOf('a2'), timestamp: '2030-01-01T00:00:04.000Z',
    },
    returned: { sessionId: 'session-new', postTreeDigest: digestOf('b2') },
  }),
];

const expectOneCaveat = (stdout, pattern) => {
  assert.equal(stdout.match(/caveat:/gu)?.length, 1, stdout);
  assert.match(stdout, pattern);
  assert.match(stdout, /run:  codex-exec --resume <held id> --nonce <nonce> <fold-brief>/u);
};

describe('procedures fold lane — spec:held-session/S5', () => {
  it('renders the populated held id after the execute contract block', () => withRoot({}, (root) => {
    const ledger = writeFixtureLedger(root, heldRecords());
    const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Fold lane \(execute = delegated\)/u);
    assert.match(result.stdout, /run:  codex-exec --resume session-held --nonce <nonce> <fold-brief>/u);
    assert.ok(result.stdout.indexOf('codex-exec — driving contract') < result.stdout.indexOf('Fold lane (execute = delegated)'));
    assert.doesNotMatch(result.stdout, /caveat:/u);
  }));

  it('renders one caveat for an absent ledger', () => withRoot({}, (root) => {
    const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: join(root, 'absent.jsonl') } });
    assert.equal(result.code, 0, result.stderr);
    expectOneCaveat(result.stdout, /no delegation ledger/u);
  }));

  it('renders one caveat before any folded code session', () => withRoot({}, (root) => {
    const ledger = writeFixtureLedger(root, [buildRegistration(), buildDispatch({ nonce: 'open' })]);
    const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
    assert.equal(result.code, 0, result.stderr);
    expectOneCaveat(result.stdout, /no folded code thread/u);
  }));

  it('always renders a substitution caveat and never the substituted id', () => withRoot({}, (root) => {
    const ledger = writeFixtureLedger(root, substitutedRecords());
    const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
    assert.equal(result.code, 0, result.stderr);
    expectOneCaveat(result.stdout, /substituted.*session-held.*session-new/u);
    assert.doesNotMatch(result.stdout, /--resume session-new/u);
  }));

  it('renders one reader caveat for malformed, audit-refused and thrown-store cases', () => {
    withRoot({}, (root) => {
      const ledger = join(root, 'malformed.jsonl');
      writeFileSync(ledger, 'not json\n');
      const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
      assert.equal(result.code, 0, result.stderr);
      expectOneCaveat(result.stdout, /line 1: invalid JSON/u);
    });
    withRoot({}, (root) => {
      const duplicate = buildDispatch({ nonce: 'duplicate' });
      const ledger = writeFixtureLedger(root, [buildRegistration(), duplicate, { ...duplicate, timestamp: '2030-01-01T00:00:02.000Z' }]);
      const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
      assert.equal(result.code, 0, result.stderr);
      expectOneCaveat(result.stdout, /duplicate dispatch/u);
    });
    withRoot({}, (root) => {
      const result = run(root, ['plan-execution'], {
        resolveDelegationStorePath: () => { throw new Error('store resolution STOP'); },
      });
      assert.equal(result.code, 0, result.stderr);
      expectOneCaveat(result.stdout, /store resolution STOP/u);
    });
  });

  it('renders one HEAD-read caveat and keeps exit zero', () => withRoot({}, (root) => {
    const ledger = writeFixtureLedger(root, heldRecords());
    const result = run(root, ['plan-execution'], {
      env: { AW_DELEGATION_STORE: ledger },
      readHeadInstant: () => ({ state: 'error', reason: 'HEAD instant failed' }),
    });
    assert.equal(result.code, 0, result.stderr);
    expectOneCaveat(result.stdout, /HEAD instant failed/u);
  }));

  it('renders one caveat for an id a one-line render cannot carry', () => withRoot({}, (root) => {
    const sessionId = `session${String.fromCharCode(0x2028)}held`;
    const ledger = writeFixtureLedger(root, heldRecords(sessionId));
    const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
    assert.equal(result.code, 0, result.stderr);
    expectOneCaveat(result.stdout, /cannot be rendered on one command line/u);
    const runLine = result.stdout.split('\n').find((line) => line.includes('run:  codex-exec --resume'));
    assert.equal(runLine.includes(sessionId), false);
  }));

  it('runs the judge without a caveat on an unborn branch', () => withRoot({}, (root) => {
    const ledger = writeFixtureLedger(root, heldRecords('session-unborn'));
    const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
    assert.match(result.stdout, /--resume session-unborn/u);
    assert.doesNotMatch(result.stdout, /caveat:/u);
  }));

  it('omits the lane for solo, subagent and every other activity', () => {
    withRoot({ execute: 'solo' }, (root) => {
      const json = JSON.parse(run(root, ['plan-execution', '--json']).stdout);
      assert.deepEqual(json.foldLane, []);
    });
    withRoot({ execute: 'subagent' }, (root) => {
      const surveyVehicle = () => ({ state: 'placed', reason: null, rel: '.claude/agents/executor.md' });
      const json = JSON.parse(run(root, ['plan-execution', '--json'], { surveyVehicle }).stdout);
      assert.equal(json.slots.execute.recipe, 'subagent');
      assert.deepEqual(json.foldLane, []);
    });
    withRoot({}, (root) => {
      const json = JSON.parse(run(root, ['plan-authoring', '--json']).stdout);
      assert.deepEqual(json.foldLane, []);
    });
  });

  it('carries the same populated block under foldLane in JSON', () => withRoot({}, (root) => {
    const ledger = writeFixtureLedger(root, heldRecords());
    const result = run(root, ['plan-execution', '--json'], { env: { AW_DELEGATION_STORE: ledger } });
    const json = JSON.parse(result.stdout);
    assert.ok(json.foldLane.some((line) => line.includes('Fold lane (execute = delegated)')));
    assert.ok(json.foldLane.some((line) => line.includes('--resume session-held --nonce <nonce>')));
  }));
});
