import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHeldSessionState, decideCheck, main as reviewMain } from './review-state.mjs';
import './commit-guard.mjs';
import { main as proceduresMain } from './procedures.mjs';
import { decideHeldSession } from './held-session.mjs';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';
import { buildRegistration, buildThread, createFixtureRepo, digestOf, removeFixtureRepo } from './delegation-harness.test.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./commit-guard.mjs', import.meta.url)), 'utf8');
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, '..', '..', 'agent-workflow-engine');
const BRIEF_A = 'docs/plans/TASK-fixture-T1.md';
const BRIEF_B = 'docs/plans/TASK-fixture-T2.md';
const BRIEF_C = 'docs/plans/TASK-fixture-T3.md';
const OID_A = 'ab'.repeat(20);
const CHECKPOINT = { kind: 'checkpoint', treeOid: OID_A };
const HEAD_BASELINE = { kind: 'head', treeOid: null };
const TASK_A = { brief: BRIEF_A, files: ['src/a.mjs'] };
const TASK_B = { brief: BRIEF_B, files: ['src/b.mjs'] };
const TASK_C = { brief: BRIEF_C, files: ['src/c.mjs'] };
const FINGERPRINT = digestOf('b2');
const FIRST_LINE = 'held sessions: 2 chain(s) — docs/plans/TASK-fixture-T1.md: session-a (1) · docs/plans/TASK-fixture-T2.md: session-b (1)';

const thread = ({ nonce, sessionId, second, task, baselineClean = false,
  baseline = task === undefined ? HEAD_BASELINE : CHECKPOINT }) => buildThread({
  dispatch: {
    ...(task === undefined ? {} : { task }),
    baseline, nonce, backend: 'codex', stepClass: 'code', baselineClean,
    timestamp: `2030-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    contractDigest: digestOf(`${second.toString(16)}c`),
    preTreeDigest: digestOf(`${second.toString(16)}a`),
  },
  returned: {
    sessionId, postTreeDigest: FINGERPRINT,
    timestamp: `2030-01-01T00:00:${String(second + 1).padStart(2, '0')}.000Z`,
  },
  fold: { timestamp: `2030-01-01T00:00:${String(second + 2).padStart(2, '0')}.000Z` },
});
const buildPair = (sessionA = 'session-a') => [
  buildRegistration(),
  ...thread({ nonce: 'a1', sessionId: sessionA, second: 4, task: TASK_A }),
  ...thread({ nonce: 'b1', sessionId: 'session-b', second: 7, task: TASK_B }),
];
const buildSubstitutedRecords = () => [
  ...buildPair(),
  ...thread({ nonce: 'b2', sessionId: 'session-x', second: 10, task: TASK_B }).slice(0, 2),
];
const readSnapshot = (records) => ({
  outcome: 'ok', records, recordLines: records.map((_, index) => index + 1), malformed: 0, malformedReasons: [],
});
const buildFromRecords = (records) => {
  const facts = buildHeldSessionState({
    cwd: '/fixture', env: {}, configuredExecute: 'delegated', plans: ['active.md'],
    fingerprint: FINGERPRINT, clean: false, degrades: [],
    resolveStore: () => '/fixture/ledger.jsonl',
    readStore: () => readSnapshot(records),
    readHead: () => ({ state: 'unborn' }),
  });
  assert.equal(facts?.state, 'ok', facts?.reason);
  return facts;
};
const baseReviewState = (heldSession) => ({
  heldSession,
  fingerprint: FINGERPRINT,
  obligations: { recipe: 'solo', source: 'config', unknowable: false },
  flowArmed: false,
  flowBrokenReason: null,
  malformed: 0,
  evidenceUnavailable: false,
  evidenceMalformed: 0,
  evidenceReadError: null,
  receiptsReadError: null,
});
const renderReview = (facts) => reviewMain([], { buildState: () => ({
  ...baseReviewState(facts),
  requiredBackends: [], plans: ['active.md'], fingerprint: FINGERPRINT, clean: false,
  detectionWarning: null, receiptsPath: '/fixture/receipts.jsonl', receiptCount: 0,
  degradedExempt: [], backends: [],
}) });
const renderLane = (records) => {
  const root = createFixtureRepo({});
  try {
    return proceduresMain(['plan-execution'], {
      cwd: root,
      env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR },
      detect: () => [
        { name: 'codex-cli-bridge', readiness: READY },
        { name: 'antigravity-cli-bridge', readiness: NEEDS_SKILL },
      ],
      surveyVehicle: () => ({ state: 'missing', reason: null, rel: '.claude/agents/executor.md' }),
      readHeadInstant: () => ({ state: 'unborn' }),
      readDelegationStore: () => readSnapshot(records),
      resolveDelegationStorePath: () => '/fixture/ledger.jsonl',
    });
  } finally {
    removeFixtureRepo(root);
  }
};

describe('task chains in review-state, commit-guard and the fold lane — spec:task-thread/S4', () => {
  it('prints the exact two-chain line and includes it indented in review-state', () => {
    const facts = buildFromRecords(buildPair());
    const decision = decideHeldSession(facts);
    assert.equal(decision.code, 0);
    assert.equal(decision.line, FIRST_LINE);
    const report = renderReview(facts);
    assert.equal(report.code, 0, report.stderr);
    assert.ok(report.stdout.split('\n').includes(`  ${FIRST_LINE}`), report.stdout);
  });

  it('labels the untasked chain and a task chain with no held session', () => {
    const records = [
      buildRegistration(),
      ...thread({ nonce: 'u1', sessionId: 'session-u', second: 1 }),
      ...thread({ nonce: 'a1', sessionId: 'session-a', second: 4, task: TASK_A }),
      thread({ nonce: 'c1', sessionId: 'session-c', second: 10, task: TASK_C })[0],
    ];
    const decision = decideHeldSession(buildFromRecords(records));
    assert.equal(decision.code, 0);
    assert.equal(decision.line,
      'held sessions: 3 chain(s) — untasked: session-u (1) · docs/plans/TASK-fixture-T1.md: session-a (1) · docs/plans/TASK-fixture-T3.md: none (0)');
  });

  it('escapes a U+2028 held id in the chain line and review-state stdout', () => {
    const lineBreak = String.fromCharCode(0x2028);
    const escapedId = ['session', String.fromCharCode(92), 'u2028held'].join('');
    const unsafeId = `session${lineBreak}held`;
    const facts = buildFromRecords(buildPair(unsafeId));
    const expected = `held sessions: 2 chain(s) — ${BRIEF_A}: ${escapedId} (1) · ${BRIEF_B}: session-b (1)`;
    assert.equal(decideHeldSession(facts).line, expected);
    const report = renderReview(facts);
    assert.equal(report.code, 0, report.stderr);
    assert.ok(report.stdout.split('\n').includes(`  ${expected}`), report.stdout);
    assert.equal(report.stdout.includes(unsafeId), false);
  });

  it('accepts independent chains and refuses a substitution of the second chain held id', () => {
    const accepted = decideCheck(baseReviewState(buildFromRecords(buildPair())));
    assert.equal(accepted.code, 0, accepted.reason);
    const refused = decideCheck(baseReviewState(buildFromRecords(buildSubstitutedRecords())));
    assert.equal(refused.code, 1);
    assert.match(refused.reason, /substituted held session "session-b" with "session-x"/u);
    assert.ok(refused.reason.includes('"b2"'), refused.reason);
  });

  it('preserves the guard interpolation of the reason naming b2 and its chain sessions', () => {
    assert.ok(SOURCE.includes('the review obligations are not satisfied: ${review.reason}'));
    const review = decideCheck(baseReviewState(buildFromRecords(buildSubstitutedRecords())));
    assert.equal(review.code, 1);
    assert.match(review.reason, /substituted held session "session-b" with "session-x"/u);
    assert.ok(review.reason.includes('"b2"'), review.reason);
  });

  it('renders one populated fold command per task chain with its brief and no caveat', () => {
    const result = renderLane(buildPair());
    assert.equal(result.code, 0, result.stderr);
    assert.equal((result.stdout.match(/Fold lane \(execute = delegated\)/gu) ?? []).length, 1, result.stdout);
    assert.equal((result.stdout.match(/run:  codex-exec --resume /gu) ?? []).length, 2, result.stdout);
    assert.match(result.stdout, /run:  codex-exec --resume session-a --nonce <nonce> <fold-brief>\s+\(task docs\/plans\/TASK-fixture-T1\.md\)/u);
    assert.match(result.stdout, /run:  codex-exec --resume session-b --nonce <nonce> <fold-brief>\s+\(task docs\/plans\/TASK-fixture-T2\.md\)/u);
    assert.doesNotMatch(result.stdout, /caveat:/u);
  });

  it('renders an untasked fold command without a task marker beside a marked task command', () => {
    const result = renderLane([
      buildRegistration(),
      ...thread({ nonce: 'u1', sessionId: 'session-u', second: 1 }),
      ...thread({ nonce: 'a1', sessionId: 'session-a', second: 4, task: TASK_A }),
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((result.stdout.match(/run:  codex-exec --resume /gu) ?? []).length, 2, result.stdout);
    assert.match(result.stdout, /run:  codex-exec --resume session-u --nonce <nonce> <fold-brief>(?!\s+\(task)/u);
    assert.match(result.stdout, /run:  codex-exec --resume session-a --nonce <nonce> <fold-brief>\s+\(task docs\/plans\/TASK-fixture-T1\.md\)/u);
    assert.doesNotMatch(result.stdout, /caveat:/u);
  });
});
