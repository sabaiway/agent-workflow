import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildState, decideCheck, main, mainAwait } from './review-state.mjs';
import { decideHeldSession } from './held-session.mjs';
import {
  buildDispatch, buildRegistration, buildThread, createFixtureGitRepo, createFixtureRepo, digestOf,
  removeFixtureRepo, writeFixtureLedger,
} from './delegation-harness.test.mjs';

const loaded = await import('./review-state.mjs');
const buildHeldSessionState = loaded.buildHeldSessionState ?? (() => ({ state: 'missing' }));
const selectHeldSessionDegrades = loaded.selectHeldSessionDegrades ?? (() => []);

const MILLISECONDS_PER_SECOND = 1000;
const FINGERPRINT = digestOf('b2');
const PRECONDITIONS = {
  configuredExecute: 'delegated', plans: ['active.md'], fingerprint: FINGERPRINT, clean: false,
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

const derivesTimestamp = (baseInstant, seconds, fallback) => baseInstant === null
  ? fallback
  : new Date(Date.parse(baseInstant) + (seconds * MILLISECONDS_PER_SECOND)).toISOString();

const buildSubstitutedRecords = (baseInstant = null) => [
  buildRegistration({ timestamp: derivesTimestamp(baseInstant, 0, '2030-01-01T00:00:01.000Z') }),
  ...buildThread({
    dispatch: { nonce: 'first', timestamp: derivesTimestamp(baseInstant, 1, '2030-01-01T00:00:01.000Z') },
    returned: {
      sessionId: 'session-held', postTreeDigest: digestOf('b1'),
      timestamp: derivesTimestamp(baseInstant, 2, '2030-01-01T00:00:02.000Z'),
    },
    fold: { timestamp: derivesTimestamp(baseInstant, 3, '2030-01-01T00:00:03.000Z') },
  }),
  ...buildThread({
    dispatch: {
      nonce: 'substituted', baselineClean: false, contractDigest: digestOf('c2'),
      preTreeDigest: digestOf('a2'), timestamp: derivesTimestamp(baseInstant, 4, '2030-01-01T00:00:04.000Z'),
    },
    returned: {
      sessionId: 'session-new', postTreeDigest: FINGERPRINT,
      timestamp: derivesTimestamp(baseInstant, 5, '2030-01-01T00:00:02.000Z'),
    },
    fold: { timestamp: derivesTimestamp(baseInstant, 6, '2030-01-01T00:00:03.000Z') },
  }),
];

const buildFromRecords = (records, overrides = {}) => buildHeldSessionState({
  cwd: '/fixture',
  env: {},
  ...PRECONDITIONS,
  degrades: [],
  resolveStore: () => '/fixture/ledger.jsonl',
  readStore: () => ({ outcome: 'ok', records, recordLines: records.map((_, index) => index + 1), malformed: 0, malformedReasons: [] }),
  readHead: () => ({ state: 'unborn' }),
  ...overrides,
});

const withTempRoot = (run) => {
  const root = createFixtureRepo();
  try {
    return run(root);
  } finally {
    removeFixtureRepo(root);
  }
};

const withTempGitRoot = (run) => {
  const fixture = createFixtureGitRepo();
  try {
    return run(fixture);
  } finally {
    removeFixtureRepo(fixture.root);
  }
};

describe('review-state held-session arm — spec:held-session/S2', () => {
  it('refuses a substitution before the solo-review early return', () => {
    const substituted = {
      state: 'ok', heldId: 'session-held', folds: 1, threads: [], open: [],
      substitution: {
        nonce: 'substituted', expectedId: 'session-held', actualId: 'session-new',
        postTreeDigest: FINGERPRINT, folded: false,
      },
    };
    const result = decideCheck(baseReviewState(substituted));
    assert.equal(result.code, 1, 'a SUBSTITUTED fixture must not pass --check under review solo');
    assert.match(result.reason, /substituted.*session-held.*session-new/u);
    assert.match(result.reason, /core-evidence\.mjs.*degrade --backend codex-exec/u);
    assert.match(result.reason, /fold the retry of that thread/u);
    const ledgerReason = 'line 2: delegation ledger refused';
    const ledgerError = {
      state: 'error', cause: 'ledger', reason: ledgerReason, heldId: null,
      folds: 0, substitution: null, threads: [], open: [],
    };
    assert.equal(decideCheck(baseReviewState(ledgerError)).reason, ledgerReason);
    const help = main(['--help']);
    assert.equal(help.code, 0);
    const firstArm = help.stdout.indexOf('FIRST, before any of the arms');
    const substitutionArm = help.stdout.indexOf('SUBSTITUTED held session');
    const remainingArms = help.stdout.indexOf('THEN: 0 for solo');
    assert.ok(firstArm !== -1 && substitutionArm !== -1 && remainingArms !== -1);
    assert.ok(firstArm < substitutionArm && substitutionArm < remainingArms);
  });

  it('shows only the recovery lanes that still apply', () => {
    const movedFingerprint = digestOf('b3');
    const substitution = {
      nonce: 'substituted', expectedId: 'session-held', actualId: 'session-new',
      postTreeDigest: FINGERPRINT, folded: true,
    };
    const movedFolded = decideCheck({
      ...baseReviewState({
        state: 'ok', heldId: 'session-held', folds: 1, threads: [], open: [], substitution,
      }),
      fingerprint: movedFingerprint,
    });
    assert.doesNotMatch(movedFolded.reason, /degrade --backend codex-exec/u);
    assert.doesNotMatch(movedFolded.reason, /fold the retry/u);
    assert.match(movedFolded.reason, /no recovery lane remains/u);

    const movedUnfolded = decideCheck({
      ...baseReviewState({
        state: 'ok', heldId: 'session-held', folds: 1, threads: [], open: [],
        substitution: { ...substitution, folded: false },
      }),
      fingerprint: movedFingerprint,
    });
    assert.doesNotMatch(movedUnfolded.reason, /degrade --backend codex-exec/u);
    assert.match(movedUnfolded.reason, /fold the retry of that thread/u);
  });

  it('defers the degrade lane while the evidence store is unavailable', () => {
    const substitution = {
      nonce: 'substituted', expectedId: 'session-held', actualId: 'session-new',
      postTreeDigest: FINGERPRINT, folded: true,
    };
    const unavailable = {
      evidenceUnavailable: true, evidenceMalformed: 1,
      evidenceStorePath: '/fixture/evidence.jsonl',
    };
    const folded = decideCheck({
      ...baseReviewState({
        state: 'ok', heldId: 'session-held', folds: 1, threads: [], open: [], substitution,
      }),
      ...unavailable,
    });
    assert.match(folded.reason, /repair it/u);
    assert.doesNotMatch(folded.reason, /degrade --backend codex-exec/u);
    assert.doesNotMatch(folded.reason, /no recovery lane remains/u);

    const unfolded = decideCheck({
      ...baseReviewState({
        state: 'ok', heldId: 'session-held', folds: 1, threads: [], open: [],
        substitution: { ...substitution, folded: false },
      }),
      ...unavailable,
    });
    assert.match(unfolded.reason, /repair it/u);
    assert.match(unfolded.reason, /fold the retry of that thread/u);
  });

  it('makes --await terminal on a substitution', async () => {
    const facts = buildFromRecords(buildSubstitutedRecords());
    const result = await mainAwait(['--await', '--timeout', '4'], {
      buildState: () => baseReviewState(facts),
      now: () => 0,
      sleep: async () => assert.fail('--await must not sleep on a held-session refusal'),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /session-held.*session-new/u);
    assert.doesNotMatch(result.stderr, /TIMEOUT/u);
  });

  it('keeps only codex-exec lifted after a later fold moves the current tree', () => {
    const movedFingerprint = digestOf('b3');
    const records = [
      ...buildSubstitutedRecords(),
      ...buildThread({
        dispatch: {
          nonce: 'continued', baselineClean: false, contractDigest: digestOf('c3'),
          preTreeDigest: FINGERPRINT, timestamp: '2030-01-01T00:00:07.000Z',
        },
        returned: { sessionId: 'session-new', postTreeDigest: movedFingerprint },
      }),
    ];
    for (const [backend, expected] of [['codex-exec', 0], ['codex', 1]]) {
      const rawDegrades = [{ schema: 1, kind: 'degrade', backend, reason: 'accepted replacement', fingerprint: FINGERPRINT, timestamp: '2030-01-01T00:00:07.000Z' }];
      const facts = buildFromRecords(records, {
        fingerprint: movedFingerprint,
        degrades: selectHeldSessionDegrades(rawDegrades),
      });
      assert.equal(decideCheck(baseReviewState(facts)).code, expected, backend);
    }
  });

  it('keeps evidence-store diagnostics on a held-session refusal', () => {
    const substituted = {
      state: 'ok', heldId: 'session-held', folds: 1, threads: [], open: [],
      substitution: { nonce: 'substituted', expectedId: 'session-held', actualId: 'session-new' },
    };
    const result = decideCheck({
      ...baseReviewState(substituted), evidenceUnavailable: true, evidenceMalformed: 1,
    });
    assert.match(result.reason, /substituted.*session-held.*session-new/u);
    assert.match(result.reason, /evidence store unavailable/u);
  });

  it('fails closed on malformed and audit-refused ledgers', () => {
    const malformed = buildHeldSessionState({
      cwd: '/fixture', env: {}, ...PRECONDITIONS, degrades: [],
      resolveStore: () => '/fixture/ledger.jsonl',
      readStore: () => ({ outcome: 'error', reason: 'line 1: invalid JSON', records: [], recordLines: [], malformed: 1, malformedReasons: ['line 1: invalid JSON'] }),
      readHead: () => ({ state: 'unborn' }),
    });
    assert.equal(decideCheck(baseReviewState(malformed)).code, 1);
    assert.match(decideCheck(baseReviewState(malformed)).reason, /line 1: invalid JSON/u);

    const duplicate = buildDispatch({ nonce: 'duplicate', timestamp: '2030-01-01T00:00:01.000Z' });
    const refused = buildFromRecords([buildRegistration(), duplicate, { ...duplicate, timestamp: '2030-01-01T00:00:02.000Z' }]);
    assert.equal(decideCheck(baseReviewState(refused)).code, 1);
    assert.match(decideCheck(baseReviewState(refused)).reason, /duplicate dispatch/u);
  });

  it('fails closed on unreadable and foreign ledger leaves', () => withTempRoot((root) => {
    const directory = join(root, 'ledger-directory');
    mkdirSync(directory);
    const unreadable = buildHeldSessionState({
      cwd: root, env: { AW_DELEGATION_STORE: directory }, ...PRECONDITIONS, degrades: [],
      readHead: () => ({ state: 'unborn' }),
    });
    assert.equal(decideCheck(baseReviewState(unreadable)).code, 1);
    assert.match(decideCheck(baseReviewState(unreadable)).reason, /directory.*regular file/u);

    const target = writeFixtureLedger(root, [buildRegistration()], 'real-ledger.jsonl');
    const link = join(root, 'linked-ledger.jsonl');
    symlinkSync(target, link);
    const foreign = buildHeldSessionState({
      cwd: root, env: { AW_DELEGATION_STORE: link }, ...PRECONDITIONS, degrades: [],
      readHead: () => ({ state: 'unborn' }),
    });
    assert.equal(decideCheck(baseReviewState(foreign)).code, 1);
    assert.match(decideCheck(baseReviewState(foreign)).reason, /symlink.*regular file/u);
  }));

  it('fails closed on an epoch error', () => {
    const facts = buildFromRecords(buildSubstitutedRecords(), { readHead: () => ({ state: 'error', reason: 'HEAD read failed' }) });
    assert.equal(decideCheck(baseReviewState(facts)).code, 1);
    assert.match(decideCheck(baseReviewState(facts)).reason, /HEAD read failed/u);
  });

  it('treats an absent ledger as inert and says so', () => {
    const absent = buildHeldSessionState({
      cwd: '/fixture', env: {}, ...PRECONDITIONS, degrades: [],
      resolveStore: () => '/fixture/ledger.jsonl',
      readStore: () => ({ outcome: 'absent', records: [], recordLines: [], malformed: 0, malformedReasons: [] }),
      readHead: () => ({ state: 'unborn' }),
    });
    assert.equal(decideCheck(baseReviewState(absent)).code, 0);
    assert.match(decideHeldSession(absent).line, /held session: none.*no delegation ledger/u);
  });

  it('never resolves a poisoned store under solo or subagent execute, no plan, no fingerprint, or a clean tree', () => {
    const cells = [
      { configuredExecute: 'solo', plans: ['active.md'], fingerprint: FINGERPRINT, clean: false },
      { configuredExecute: 'subagent', plans: ['active.md'], fingerprint: FINGERPRINT, clean: false },
      { configuredExecute: 'delegated', plans: [], fingerprint: FINGERPRINT, clean: false },
      { configuredExecute: 'delegated', plans: ['active.md'], fingerprint: null, clean: false },
      { configuredExecute: 'delegated', plans: ['active.md'], fingerprint: FINGERPRINT, clean: true },
    ];
    const rejectsRead = () => assert.fail('an inert held-session arm must not read the poisoned ledger');
    for (const cell of cells) {
      const facts = buildHeldSessionState({
        cwd: '/fixture', env: { AW_DELEGATION_STORE: '/poisoned/ledger.jsonl' },
        ...cell, degrades: [], resolveStore: rejectsRead, readStore: rejectsRead,
        readHead: rejectsRead,
      });
      assert.equal(facts, null, JSON.stringify(cell));
    }
  });

  it('arms through the real buildState only for configured delegated execute', () => withTempGitRoot(({ root, epochTimestamp }) => {
    const ledger = writeFixtureLedger(root, buildSubstitutedRecords(epochTimestamp));
    const env = { AW_DELEGATION_STORE: ledger };
    const delegated = buildState({ cwd: root, env, detect: () => [] });
    const refusal = decideCheck(delegated);
    assert.equal(refusal.code, 1);
    assert.match(refusal.reason, /substituted.*session-held.*session-new/u);

    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), `${JSON.stringify({
      'plan-execution': { execute: 'solo', review: 'solo' },
    }, null, 2)}\n`);
    const solo = buildState({ cwd: root, env, detect: () => [] });
    assert.equal(solo.heldSession, null);
  }));

  it('spec:held-session/S3 reports the held id and fold count', () => {
    const facts = buildFromRecords([buildRegistration(), ...buildThread({
      dispatch: { nonce: 'held', timestamp: '2030-01-01T00:00:01.000Z' },
      returned: { sessionId: 'session-held', postTreeDigest: FINGERPRINT },
    })]);
    assert.equal(decideHeldSession(facts).line, 'held session: session-held — 1 fold(s) rode it');
    const report = main([], { buildState: () => ({
      ...baseReviewState(facts),
      requiredBackends: [],
      plans: ['active.md'],
      fingerprint: FINGERPRINT,
      clean: false,
      detectionWarning: null,
      receiptsPath: '/fixture/receipts.jsonl',
      receiptCount: 0,
      degradedExempt: [],
      backends: [],
    }) });
    assert.equal(report.code, 0);
    assert.match(report.stdout, /held session: session-held — 1 fold\(s\) rode it/u);
    const lineBreak = String.fromCharCode(0x2028);
    const escapedId = ['session', String.fromCharCode(92), 'u2028held'].join('');
    const unsafeId = `session${lineBreak}held`;
    const unsafeReport = main([], { buildState: () => ({
      ...baseReviewState({ ...facts, heldId: unsafeId }),
      requiredBackends: [], plans: ['active.md'], fingerprint: FINGERPRINT, clean: false,
      detectionWarning: null, receiptsPath: '/fixture/receipts.jsonl', receiptCount: 0,
      degradedExempt: [], backends: [],
    }) });
    assert.ok(unsafeReport.stdout.includes(`held session: ${escapedId} — 1 fold(s) rode it`));
    assert.equal(unsafeReport.stdout.includes(unsafeId), false);
  });
});
