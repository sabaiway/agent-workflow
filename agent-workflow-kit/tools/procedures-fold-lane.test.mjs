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
  detect: extra.detect ?? detect,
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

const LANE_HEADER = 'Fold lane (execute = delegated)';
const laneOf = (root, extra = {}) => {
  const result = run(root, ['plan-execution', '--json'], extra);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).foldLane;
};

describe('procedures fold lane — spec:held-session/S5', () => {
  it("renders one line after the execute contract block, resuming the run's session from its exec receipt", () => withRoot({}, (root) => {
    const ledger = writeFixtureLedger(root, heldRecords());
    const result = run(root, ['plan-execution'], { env: { AW_DELEGATION_STORE: ledger } });
    assert.equal(result.code, 0, result.stderr);
    const lane = laneOf(root, { env: { AW_DELEGATION_STORE: ledger } });
    assert.equal(lane.length, 1, `S5: the fold lane is not one line: ${lane.join(' | ')}`);
    const [line] = lane;
    assert.ok(line.includes(LANE_HEADER), 'S5: the line does not name the fold lane');
    assert.match(line, /codex-exec --resume <session id>/u, "S5: the line does not resume the run's session");
    assert.match(line, /\bexec receipt\b/u, "S5: the session id is not read from the run's exec receipt");
    for (const retired of ['session-held', '<held id>', '<fold-brief>', 'caveat:', 'dispatch open']) assert.ok(!line.includes(retired), `S5: the line still renders ${retired}`);
    assert.ok(result.stdout.split('\n').includes(line), 'S5: the human render is not the JSON line');
    assert.ok(result.stdout.indexOf('codex-exec — driving contract') < result.stdout.indexOf(LANE_HEADER), 'S5: the lane does not follow the execute contract block');
    assert.doesNotMatch(result.stdout, /caveat:/u, 'S5: the human render still carries a caveat');
  }));

  it('renders the same line whatever the ledger holds, the exit code untouched', () => withRoot({}, (root) => {
    const store = (name, records) => writeFixtureLedger(root, records, name);
    const baseline = laneOf(root, { env: { AW_DELEGATION_STORE: join(root, 'absent.jsonl') } });
    const malformed = join(root, 'malformed.jsonl');
    writeFileSync(malformed, 'not json\n');
    const duplicate = buildDispatch({ nonce: 'duplicate' });
    for (const [label, extra] of [
      ['a held session', { env: { AW_DELEGATION_STORE: store('held.jsonl', heldRecords()) } }],
      ['no folded code thread', { env: { AW_DELEGATION_STORE: store('open.jsonl', [buildRegistration(), buildDispatch({ nonce: 'open' })]) } }],
      ['a substitution', { env: { AW_DELEGATION_STORE: store('substituted.jsonl', substitutedRecords()) } }],
      ['a malformed store', { env: { AW_DELEGATION_STORE: malformed } }],
      ['an audit-refused store', { env: { AW_DELEGATION_STORE: store('duplicate.jsonl', [buildRegistration(), duplicate, { ...duplicate, timestamp: '2030-01-01T00:00:02.000Z' }]) } }],
      ['a thrown store resolution', { resolveDelegationStorePath: () => { throw new Error('store resolution STOP'); } }],
      ['a HEAD-read error', { env: { AW_DELEGATION_STORE: store('head.jsonl', heldRecords()) }, readHeadInstant: () => ({ state: 'error', reason: 'HEAD instant failed' }) }],
      ['an id a one-line render cannot carry', { env: { AW_DELEGATION_STORE: store('separator.jsonl', heldRecords(`session${String.fromCharCode(0x2028)}held`)) } }],
    ]) assert.deepEqual(laneOf(root, extra), baseline, `S5: ${label} changes the fold lane`);
    assert.equal(baseline.length, 1, 'S5: the fold lane is not one line');
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
});

describe("spec:story-flow/S18 the fold lane is one resume line from the run's exec receipt and reads no delegation ledger", () => {
  it('calls no delegation store reader and no HEAD read', () => withRoot({}, (root) => {
    const calls = [];
    const spy = (name) => (...args) => { calls.push(name); throw new Error(`${name} was read`); };
    const result = main(['plan-execution', '--json'], {
      cwd: root,
      env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR, AW_DELEGATION_STORE: writeFixtureLedger(root, heldRecords()) },
      detect,
      surveyVehicle: () => ({ state: 'missing', reason: null, rel: '.claude/agents/executor.md' }),
      resolveDelegationStorePath: spy('resolveDelegationStorePath'),
      readDelegationStore: spy('readDelegationStore'),
      auditDelegationStoreSemantics: spy('auditDelegationStoreSemantics'),
      readHeadInstant: spy('readHeadInstant'),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls, [], `S18: the fold lane read the delegation ledger through ${calls.join(', ')}`);
    const lane = JSON.parse(result.stdout).foldLane;
    assert.equal(lane.length, 1, 'S18: the fold lane is not one line');
    assert.match(lane[0], /codex-exec --resume <session id>[^\n]*\bexec receipt\b|\bexec receipt\b[^\n]*codex-exec --resume <session id>/u, "S18: the line does not resume the session read from the run's exec receipt");
  }));
});

describe('procedures execute slots — spec:carriers/S20', () => {
  for (const [name, activities, config, count, flags = [], unavailable = false, placement] of [
    ['cell 1: task alone supplies the plan lane', ['plan-execution'], { 'plan-execution': { execute: 'solo' }, task: { execute: 'delegated' } }, 1, [], false, /  execute: solo[^\n]*\n[\s\S]*Fold lane \(execute = delegated\)[\s\S]*  review:/u],
    ['cell 2: both slots supply one plan lane', ['plan-execution'], { 'plan-execution': { execute: 'delegated' }, task: { execute: 'delegated' } }, 1],
    ['cell 3: plan override leaves the task lane', ['plan-execution'], { 'plan-execution': { execute: 'delegated' }, task: { execute: 'delegated' } }, 1, ['--override', 'execute=solo']],
    ['cell 4: task supplies its own lane', ['task'], { task: { execute: 'delegated' } }, 1, [], false, /  execute: delegated[^\n]*\n[\s\S]*Fold lane \(execute = delegated\)/u],
    ['cell 5: both slots supply one task lane', ['task'], { 'plan-execution': { execute: 'delegated' }, task: { execute: 'delegated' } }, 1],
    ['cell 6: task override removes its lane', ['task'], { task: { execute: 'delegated' } }, 0, ['--override', 'execute=solo']],
    ['cell 7: task ignores the plan slot', ['task'], { 'plan-execution': { execute: 'delegated' }, task: { execute: 'solo' } }, 0],
    ['cell 8: author supplies no lane', ['plan-execution', 'task'], { 'plan-execution': { execute: 'solo' }, task: { author: 'delegated', execute: 'solo' } }, 0],
    ['cell 9: degraded execute supplies no lane', ['plan-execution', 'task'], { 'plan-execution': { execute: 'solo' }, task: { execute: 'delegated' } }, 0, [], true],
    ['cell 10: other activities read no execute slot', ['plan-authoring', 'routine', 'feedback-triage', 'epic'], { task: { execute: 'delegated' } }, 0],
  ]) {
    for (const activity of activities) {
      it(`${name} (${activity})`, () => withRoot({}, (root) => {
        writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify(config));
        const extra = { env: { AW_DELEGATION_STORE: writeFixtureLedger(root, heldRecords()) }, detect: unavailable ? () => [{ name: CODEX, readiness: NEEDS_SKILL }, { name: AGY, readiness: NEEDS_SKILL }] : detect };
        const result = run(root, [activity, ...flags], extra);
        const json = JSON.parse(run(root, [activity, ...flags, '--json'], extra).stdout);
        assert.equal((result.stdout.match(/Fold lane \(execute = delegated\)/gu) ?? []).length, count);
        if (count) assert.ok(json.foldLane.length > 0);
        else assert.deepEqual(json.foldLane, []);
        if (placement) assert.match(result.stdout, placement);
      }));
    }
  }
});
