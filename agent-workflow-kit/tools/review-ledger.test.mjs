import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateRecord,
  readLedger,
  decideStop,
  decideCheck,
  isShipVerdict,
  receiptCrossCheck,
  filterLoopRecords,
  filterSegmentRecords,
  collectSizeCapLimit,
  isProcessGateCmd,
  isQualityGreenGateRun,
  roundSequenceIntact,
  buildLedgerState,
  resolveLedgerPath,
  resolveBase,
  collectOverrides,
  computeTelemetry,
  renderTelemetry,
  main,
  REVIEW_CAP,
} from './review-ledger.mjs';

// The ONE literal schema fixture (Phase 2.1; neutral labels per Decision 10) — two record kinds, one
// JSONL ledger. Counts and findings[] are internally consistent.
const FIXTURE = [
  '{"schema":1,"loop":"example-feature","activity":"plan-execution","kind":"round","round":1,"fingerprint":"fde442150a65cfc4523e3be7292329a93412ee7794bf02caef2cc3aa5d78d436","origins":{"first-draft":1,"fold-induced":0,"mechanics":0},"backends":[{"backend":"codex","degraded":false,"blockers":0,"majors":1,"minors":0,"verdict":"revise"},{"backend":"agy","degraded":true,"reason":"Issue-001 stall on large diffs","blockers":0,"majors":0,"minors":0,"verdict":"degraded"}],"findings":[{"findingKey":"prefix-rule-global-option-bypass","severity":"major","origin":"first-draft","backend":"codex"}],"timestamp":"2026-01-01T00:00:00Z"}',
  '{"schema":1,"loop":"example-feature","activity":"plan-execution","kind":"triage","round":2,"fingerprint":"fde442150a65cfc4523e3be7292329a93412ee7794bf02caef2cc3aa5d78d436","classifications":[{"findingKey":"prefix-rule-global-option-bypass","class":"inherent-layer-residual","accepted":true,"testId":null,"note":"documented as a RESIDUAL_NOTICE and raised to an acceptance criterion"}],"timestamp":"2026-01-01T00:30:00Z"}',
].join('\n');

const roundFixture = () => JSON.parse(FIXTURE.split('\n')[0]);
const triageFixture = () => JSON.parse(FIXTURE.split('\n')[1]);

// ── schema: the fixture passes; each malformed variant is REJECTED (its own named test) ──────────

describe('review-ledger schema — the fixture validates + malformed variants rejected', () => {
  it('both fixture lines parse + validate (0 malformed, 2 records)', () => {
    const { records, malformed } = readLedger('X', () => FIXTURE);
    assert.equal(malformed, 0);
    assert.equal(records.length, 2);
    assert.equal(validateRecord(roundFixture()).ok, true);
    assert.equal(validateRecord(triageFixture()).ok, true);
  });

  it('rejects a non-object', () => assert.equal(validateRecord(42).ok, false));
  it('rejects an unsupported schema version', () => assert.equal(validateRecord({ ...roundFixture(), schema: 99 }).ok, false));
  it('rejects a missing loop', () => assert.equal(validateRecord({ ...roundFixture(), loop: '' }).ok, false));
  it('rejects a bad activity', () => assert.equal(validateRecord({ ...roundFixture(), activity: 'nope' }).ok, false));
  it('rejects a bad kind', () => assert.equal(validateRecord({ ...roundFixture(), kind: 'nope' }).ok, false));

  it('rejects a bad round on a round-framed kind (integer >= 1 required)', () => {
    for (const round of [0, -1, 1.5, 'one', undefined]) {
      const r = validateRecord({ ...roundFixture(), round });
      assert.equal(r.ok, false, `round ${JSON.stringify(round)} must fail`);
      assert.match(r.reason, /round must be an integer/);
    }
  });

  it('rejects a bad class in a triage', () => {
    const bad = triageFixture();
    bad.classifications[0].class = 'not-a-class';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a bad origin in a round finding', () => {
    const bad = roundFixture();
    bad.findings[0].origin = 'not-an-origin';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a round with missing backends', () => {
    const bad = roundFixture();
    delete bad.backends;
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a round with missing findings', () => {
    const bad = roundFixture();
    delete bad.findings;
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a degraded backend with no reason', () => {
    const bad = roundFixture();
    delete bad.backends[1].reason; // agy is the degraded one
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a findings-vs-counts mismatch', () => {
    const bad = roundFixture();
    bad.backends[0].majors = 2; // codex has one major finding, claims two
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects an origins-vs-findings mismatch', () => {
    const bad = roundFixture();
    bad.origins['first-draft'] = 0; // findings carry one first-draft origin
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a finding whose backend is not in backends[]', () => {
    const bad = roundFixture();
    bad.findings[0].backend = 'ghost';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('readLedger counts a malformed line + surfaces its reason, keeps the valid ones', () => {
    const withBad = `${FIXTURE}\n{"schema":1,"loop":"L","activity":"plan-execution","kind":"round","round":1,"fingerprint":null,"origins":{"first-draft":0,"fold-induced":0,"mechanics":0},"backends":[{"backend":"codex","degraded":false,"blockers":0,"majors":9,"minors":0,"verdict":"x"}],"findings":[],"timestamp":"t"}`;
    const { records, malformed, malformedReasons } = readLedger('X', () => withBad);
    assert.equal(records.length, 2);
    assert.equal(malformed, 1);
    assert.match(malformedReasons[0], /findings-vs-counts/);
  });

  it('readLedger counts an unparseable JSON line', () => {
    const { records, malformed } = readLedger('X', () => `${FIXTURE}\n{not json`);
    assert.equal(records.length, 2);
    assert.equal(malformed, 1);
  });

  // ── R1 folds: degraded-backend exactness (codex R1) + duplicate backends (agy R1) ──
  it('rejects a degraded backend carrying non-zero counts (a hidden-blocker hole)', () => {
    const bad = roundFixture();
    bad.backends[1].majors = 1; // agy is degraded — must be 0/0/0
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a degraded backend whose verdict is not "degraded"', () => {
    const bad = roundFixture();
    bad.backends[1].verdict = 'SHIP';
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects a finding that references a degraded backend', () => {
    const bad = roundFixture();
    bad.findings.push({ findingKey: 'x', severity: 'minor', origin: 'first-draft', backend: 'agy' });
    assert.equal(validateRecord(bad).ok, false);
  });

  it('rejects duplicate backend names in backends[]', () => {
    const bad = roundFixture();
    bad.backends.push({ ...bad.backends[0] }); // a second "codex" entry
    assert.equal(validateRecord(bad).ok, false);
  });

  it('readLedger surfaces a NON-ENOENT read error (fail closed), not "empty"', () => {
    const { readError } = readLedger('X', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    assert.equal(readError, 'EACCES');
  });

  it('readLedger treats ENOENT as an absent file (empty, no readError)', () => {
    const r = readLedger('X', () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
    assert.equal(r.records.length, 0);
    assert.equal(r.readError, undefined);
  });

  it('accepts a triage classification with an ABSENT testId (v1 tolerance defaults null — agy R3)', () => {
    const t = triageFixture();
    delete t.classifications[0].testId;
    assert.equal(validateRecord(t).ok, true);
  });
});

// ── schema v2 (M2/AD-046): fixable-bug ⟹ non-null well-formed testId; v1 stays tolerant ──────────
// The test-per-fold binding — a fold recorded as a fixable-bug MUST name the red→green test that pins
// it. Enforced only under schema 2 so historical/live v1 ledgers never retroactively become malformed
// (a malformed line cascades fail-closed refusals in the writer teeth AND the --check gate). decideStop
// never reads testId — this is validation-only (Decision 2).
describe('review-ledger schema v2 — testId enforcement (M2/AD-046)', () => {
  // A resolvable testId of the Decision-3 form "<repo-relative test file>#<test-name-pattern>".
  const WELL_FORMED_TESTID = 'agent-workflow-kit/tools/review-ledger.test.mjs#refuses a round beyond the hard-max';
  // A v2 triage carrying exactly one classification, over the v1 fixture's shared frame.
  const v2Triage = (classification) => ({ ...triageFixture(), schema: 2, classifications: [classification] });
  const cls = (over = {}) => ({ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: WELL_FORMED_TESTID, note: '', ...over });

  it('accepts a schema-2 round (rounds are version-agnostic)', () => {
    assert.equal(validateRecord({ ...roundFixture(), schema: 2 }).ok, true);
  });

  it('v2 fixable-bug + a well-formed testId → ok', () => {
    assert.equal(validateRecord(v2Triage(cls())).ok, true);
  });

  it('v2 fixable-bug + null testId → rejected, reason names testId', () => {
    const r = validateRecord(v2Triage(cls({ testId: null })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /testId/);
  });

  it('v2 fixable-bug + ABSENT testId → rejected, reason names testId', () => {
    const c = cls();
    delete c.testId;
    const r = validateRecord(v2Triage(c));
    assert.equal(r.ok, false);
    assert.match(r.reason, /testId/);
  });

  it('v2 fixable-bug + malformed testId (missing "#") → rejected, reason names the failed check', () => {
    const r = validateRecord(v2Triage(cls({ testId: 'no-separator-here' })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed/);
  });

  it('v2 fixable-bug + malformed testId (empty left half "#pattern") → rejected, reason names the failed check', () => {
    const r = validateRecord(v2Triage(cls({ testId: '#pattern' })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed/);
  });

  it('v2 fixable-bug + malformed testId (empty right half "file#") → rejected, reason names the failed check', () => {
    const r = validateRecord(v2Triage(cls({ testId: 'file#' })));
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed/);
  });

  it('v2 inherent-layer-residual + null testId → ok (a non-fixable class may omit it)', () => {
    assert.equal(validateRecord(v2Triage(cls({ class: 'inherent-layer-residual', accepted: true, testId: null }))).ok, true);
  });

  it('v2 escalate + null testId → ok (a non-fixable class may omit it)', () => {
    assert.equal(validateRecord(v2Triage(cls({ class: 'escalate', accepted: true, testId: null }))).ok, true);
  });

  it('v1 tolerance — a schema:1 triage with fixable-bug + null testId is still ok', () => {
    const v1 = { ...triageFixture(), schema: 1, classifications: [cls({ testId: null })] };
    assert.equal(validateRecord(v1).ok, true);
  });

  it('a mixed v1 + v2 ledger reads back malformed: 0', () => {
    const v1Round = FIXTURE.split('\n')[0]; // the schema-1 round line
    const v2Line = JSON.stringify(v2Triage(cls()));
    const { records, malformed } = readLedger('X', () => `${v1Round}\n${v2Line}`);
    assert.equal(malformed, 0);
    assert.equal(records.length, 2);
  });
});

// ── schema v3 — the override record kind (BUGFREE-1 / AD-047, D3): the LOUD, durable, auditable
// waiver — an oracle-change override names tampered test-surface files; a red-proof override names
// the exact testId whose red is genuinely unestablishable. Loop + payload scoped, never
// fingerprint-bound (re-affirmation churn trains rubber-stamping). ────────────────────────────────

describe('review-ledger schema v3 — the override record kind', () => {
  const oracleOverride = (over = {}) => ({
    schema: 3, loop: 'example-feature', activity: 'plan-execution', kind: 'override', round: 1,
    fingerprint: 'f'.repeat(64), scope: 'oracle-change', files: ['x.test.mjs'],
    reason: 'expectation updated deliberately', timestamp: 't', ...over,
  });
  const redProofOverride = (over = {}) => ({
    schema: 3, loop: 'example-feature', activity: 'plan-execution', kind: 'override', round: 1,
    fingerprint: 'f'.repeat(64), scope: 'red-proof', testId: 'x.test.mjs#p',
    reason: 'red genuinely unestablishable pre-fold', timestamp: 't', ...over,
  });

  it('a valid oracle-change override validates; a valid red-proof override validates', () => {
    assert.equal(validateRecord(oracleOverride()).ok, true, validateRecord(oracleOverride()).reason);
    assert.equal(validateRecord(redProofOverride()).ok, true, validateRecord(redProofOverride()).reason);
  });

  it('a schema-3 round and triage stay valid (v3 adds a kind, changes nothing else)', () => {
    assert.equal(validateRecord({ ...roundFixture(), schema: 3 }).ok, true);
  });

  it('kind "override" is valid ONLY under schema >= 3 (v1/v2 records never grow new kinds)', () => {
    for (const s of [1, 2]) {
      const r = validateRecord(oracleOverride({ schema: s }));
      assert.equal(r.ok, false, `schema ${s} must reject kind override`);
      assert.match(r.reason, /kind/);
    }
  });

  it('an unknown scope is rejected by name', () => {
    const r = validateRecord(oracleOverride({ scope: 'because-i-said-so' }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /scope/);
  });

  it('oracle-change: files[] must be a non-empty array of non-empty repo-relative paths', () => {
    for (const files of [undefined, [], 'x.test.mjs', [''], [42], ['/abs/x.test.mjs']]) {
      const r = validateRecord(oracleOverride({ files }));
      assert.equal(r.ok, false, `files ${JSON.stringify(files)} must fail`);
      assert.match(r.reason, /files/);
    }
  });

  it('oracle-change must NOT carry a testId; red-proof must NOT carry files[] (exact payloads)', () => {
    const a = validateRecord(oracleOverride({ testId: 'x.test.mjs#p' }));
    assert.equal(a.ok, false);
    assert.match(a.reason, /testId/);
    const b = validateRecord(redProofOverride({ files: ['x.test.mjs'] }));
    assert.equal(b.ok, false);
    assert.match(b.reason, /files/);
  });

  it('red-proof: the testId is REQUIRED and must be well-formed', () => {
    for (const testId of [undefined, null, '', 'no-separator', '#p', 'file#']) {
      const r = validateRecord(redProofOverride({ testId }));
      assert.equal(r.ok, false, `testId ${JSON.stringify(testId)} must fail`);
      assert.match(r.reason, /testId/);
    }
  });

  it('an override with an unknown extra key is rejected by name (exact payloads — codex R5)', () => {
    const a = validateRecord(oracleOverride({ note: 'smuggled' }));
    assert.equal(a.ok, false);
    assert.match(a.reason, /unknown key "note"/);
    const b = validateRecord(redProofOverride({ classifications: [] }));
    assert.equal(b.ok, false);
    assert.match(b.reason, /unknown key "classifications"/);
  });

  it('both scopes require a non-empty reason (never a silent waiver)', () => {
    for (const rec of [oracleOverride({ reason: '' }), redProofOverride({ reason: undefined })]) {
      const r = validateRecord(rec);
      assert.equal(r.ok, false);
      assert.match(r.reason, /reason/);
    }
  });

  it('a mixed v1 + v2 + v3 ledger reads back malformed: 0', () => {
    const lines = [FIXTURE.split('\n')[0], FIXTURE.split('\n')[1], JSON.stringify(oracleOverride()), JSON.stringify(redProofOverride())].join('\n');
    const { records, malformed } = readLedger('X', () => lines);
    assert.equal(malformed, 0);
    assert.equal(records.length, 4);
  });

  it('collectOverrides unions the loop’s override payloads (activity + loop scoped)', () => {
    const records = [
      oracleOverride(),
      oracleOverride({ files: ['y.spec.js', 'z/nonstandard-path.mjs'] }),
      redProofOverride(),
      oracleOverride({ loop: 'other-loop', files: ['ignored.test.mjs'] }),
      redProofOverride({ activity: 'plan-authoring', testId: 'ignored.test.mjs#x' }),
      { ...roundFixture() }, // non-override kinds are ignored
    ];
    const o = collectOverrides(records, { activity: 'plan-execution', loop: 'example-feature' });
    assert.deepEqual([...o.oracleChangeFiles].sort(), ['x.test.mjs', 'y.spec.js', 'z/nonstandard-path.mjs']);
    assert.deepEqual([...o.redProofTestIds], ['x.test.mjs#p']);
  });

  it('--status renders override records without crashing (the render path took every non-round record for a triage)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-status-'));
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'example-feature.md'), '# plan\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'pending.txt'), 'dirty\n');
    const ledger = join(root, '.git', 'rl.jsonl');
    writeFileSync(ledger, `${JSON.stringify(oracleOverride())}\n${JSON.stringify(redProofOverride())}\n`);
    const r = main(['--status'], { cwd: root, env: { AW_REVIEW_LEDGER: ledger }, detect: () => [{ name: 'codex-cli-bridge', readiness: 'ready' }, { name: 'antigravity-cli-bridge', readiness: 'ready' }] });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /override @round 1 \[oracle-change\]/);
    assert.match(r.stdout, /override @round 1 \[red-proof\]/);
  });
});

// ── schema v4 — the SEGMENT + the fold-boundary surface (BUGFREE-2 / AD-048): every v4 record
// carries `base` (the commit the dirty tree sits on; null on an unborn branch); new kind `gate-run`
// (the D5 green-baseline receipt), new override scope `size-cap` (D4), new triage class `refuted`
// (D6). The D2 quartet: (i) older versions reject every new surface; (ii) v4 keeps old records
// valid; (iii) a mixed v1..v4 ledger reads malformed: 0; (iv) the writer emits v4 (pinned in
// review-ledger-write.test.mjs). ────────────────────────────────────────────────────────────────

const BASE_A = '1'.repeat(40);
const BASE_B = '2'.repeat(40);

const v4Round = (over = {}) => ({ ...JSON.parse(FIXTURE.split('\n')[0]), schema: 4, base: BASE_A, ...over });
const v4Triage = (over = {}) => ({ ...JSON.parse(FIXTURE.split('\n')[1]), schema: 4, base: BASE_A, ...over });
const sizeCapOverride = (over = {}) => ({
  schema: 4, loop: 'example-feature', activity: 'plan-execution', kind: 'override', round: 1,
  base: BASE_A, fingerprint: 'f'.repeat(64), scope: 'size-cap', sanctionedLines: 612,
  reason: 'the ledger layer itself ships as one reviewed unit', timestamp: 't', ...over,
});
const gateRun = (over = {}) => ({
  schema: 4, loop: 'example-feature', activity: 'plan-execution', kind: 'gate-run', base: BASE_A,
  fingerprint: 'f'.repeat(64), fingerprintAfter: 'f'.repeat(64),
  declared: [
    { id: 'unit-tests', cmd: 'node --test pkg/*.test.mjs' },
    { id: 'review-ledger', cmd: 'node agent-workflow-kit/tools/review-ledger.mjs --check' },
  ],
  results: [{ id: 'unit-tests', ok: true, code: 0 }, { id: 'review-ledger', ok: false, code: 1 }],
  summary: { status: 'fail', gates: 2, passed: 1, failed: 1, failedIds: ['review-ledger'] },
  timestamp: 't', ...over,
});

describe('review-ledger schema v4 — the segment frame (base)', () => {
  it('a v4 round / triage with base validates; base: null (unborn branch) validates', () => {
    for (const rec of [v4Round(), v4Triage(), v4Round({ base: null })]) {
      const r = validateRecord(rec);
      assert.equal(r.ok, true, r.reason);
    }
  });

  it('a v4 record with a MISSING base is rejected, reason names base (the segment frame is required)', () => {
    const bad = v4Round();
    delete bad.base;
    const r = validateRecord(bad);
    assert.equal(r.ok, false);
    assert.match(r.reason, /base/);
  });

  it('base on a v1..v3 record is rejected — an old record never grows new surface (D2 i)', () => {
    for (const s of [1, 2, 3]) {
      const r = validateRecord({ ...roundFixture(), schema: s, base: BASE_A });
      assert.equal(r.ok, false, `schema ${s} must reject base`);
      assert.match(r.reason, /base is a v4 frame field/);
    }
  });

  it('kind gate-run is valid ONLY under schema 4 (D2 i)', () => {
    for (const s of [1, 2, 3]) {
      const g = gateRun({ schema: s });
      delete g.base; // isolate the kind check from the base check
      const r = validateRecord(g);
      assert.equal(r.ok, false, `schema ${s} must reject kind gate-run`);
      assert.match(r.reason, /kind/);
    }
  });

  it('scope size-cap is valid ONLY under schema 4 (D2 i)', () => {
    const v3 = sizeCapOverride({ schema: 3 });
    delete v3.base;
    const r = validateRecord(v3);
    assert.equal(r.ok, false);
    assert.match(r.reason, /scope/);
    assert.equal(validateRecord(sizeCapOverride()).ok, true, validateRecord(sizeCapOverride()).reason);
  });

  it('class refuted is valid ONLY under schema 4, and its note is MANDATORY (D6)', () => {
    const refuted = (schema, note) => {
      const t = { ...v4Triage(), schema, classifications: [{ findingKey: 'k', class: 'refuted', accepted: false, testId: null, note }] };
      if (schema < 4) delete t.base;
      return t;
    };
    const v3 = refuted(3, 'grounds cited');
    assert.equal(validateRecord(v3).ok, false, 'v3 must reject class refuted');
    const ok = validateRecord(refuted(4, 'the cited line already guards this — see file:42'));
    assert.equal(ok.ok, true, ok.reason);
    const noNote = validateRecord(refuted(4, ''));
    assert.equal(noNote.ok, false);
    assert.match(noNote.reason, /note/);
  });

  it('size-cap: sanctionedLines is REQUIRED, a positive integer, and the payload stays EXACT', () => {
    for (const sanctionedLines of [undefined, 0, -5, 1.5, '400']) {
      const r = validateRecord(sizeCapOverride({ sanctionedLines }));
      assert.equal(r.ok, false, `sanctionedLines ${JSON.stringify(sanctionedLines)} must fail`);
      assert.match(r.reason, /sanctionedLines/);
    }
    const stray = validateRecord(sizeCapOverride({ files: ['x.mjs'] }));
    assert.equal(stray.ok, false);
    assert.match(stray.reason, /unknown key "files"/);
  });

  it('a mixed v1 + v2 + v3 + v4 ledger reads back malformed: 0 (D2 iii)', () => {
    const v2Line = JSON.stringify({ ...triageFixture(), schema: 2, classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: 'x.test.mjs#p', note: '' }] });
    const v3Line = JSON.stringify({ schema: 3, loop: 'example-feature', activity: 'plan-execution', kind: 'override', round: 1, fingerprint: 'f'.repeat(64), scope: 'red-proof', testId: 'x.test.mjs#p', reason: 'r', timestamp: 't' });
    const lines = [FIXTURE.split('\n')[0], FIXTURE.split('\n')[1], v2Line, v3Line, JSON.stringify(v4Round()), JSON.stringify(v4Triage()), JSON.stringify(sizeCapOverride()), JSON.stringify(gateRun())].join('\n');
    const { records, malformed, malformedReasons } = readLedger('X', () => lines);
    assert.equal(malformed, 0, malformedReasons.join('; '));
    assert.equal(records.length, 8);
  });
});

describe('review-ledger schema v4 — the gate-run record (D5)', () => {
  it('a valid gate-run validates; round on a gate-run is rejected (per-kind frame)', () => {
    assert.equal(validateRecord(gateRun()).ok, true, validateRecord(gateRun()).reason);
    const withRound = validateRecord(gateRun({ round: 1 }));
    assert.equal(withRound.ok, false);
    assert.match(withRound.reason, /no round/);
  });

  it('rejects a missing/invalid fingerprintAfter (pre/post binding is the tree-changed detector)', () => {
    for (const fingerprintAfter of [undefined, '', 42]) {
      const r = validateRecord(gateRun({ fingerprintAfter }));
      assert.equal(r.ok, false, `fingerprintAfter ${JSON.stringify(fingerprintAfter)} must fail`);
      assert.match(r.reason, /fingerprintAfter/);
    }
  });

  it('rejects an unknown key, a result for an undeclared gate, and duplicate ids (exact machine payload)', () => {
    const unknown = validateRecord(gateRun({ smuggled: true }));
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason, /unknown key "smuggled"/);
    const ghost = validateRecord(gateRun({ results: [{ id: 'ghost', ok: true, code: 0 }], summary: { status: 'ok', gates: 1, passed: 1, failed: 0, failedIds: [] } }));
    assert.equal(ghost.ok, false);
    assert.match(ghost.reason, /not in declared/);
    const dup = validateRecord(gateRun({ declared: [{ id: 'a', cmd: 'x' }, { id: 'a', cmd: 'y' }] }));
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /duplicate declared id/);
  });

  it('rejects a summary inconsistent with results (a forged verdict beside honest evidence)', () => {
    const badCounts = validateRecord(gateRun({ summary: { status: 'fail', gates: 2, passed: 2, failed: 1, failedIds: ['review-ledger'] } }));
    assert.equal(badCounts.ok, false);
    assert.match(badCounts.reason, /summary counts/);
    const badIds = validateRecord(gateRun({ summary: { status: 'fail', gates: 2, passed: 1, failed: 1, failedIds: ['unit-tests'] } }));
    assert.equal(badIds.ok, false);
    assert.match(badIds.reason, /failedIds/);
  });

  it('ties summary.status to the failing count — the status IS the verdict word (internal sweep)', () => {
    const lyingOk = validateRecord(gateRun({ summary: { status: 'ok', gates: 2, passed: 1, failed: 1, failedIds: ['review-ledger'] } }));
    assert.equal(lyingOk.ok, false);
    assert.match(lyingOk.reason, /status/);
    const banana = validateRecord(gateRun({
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }],
      results: [{ id: 'unit-tests', ok: true, code: 0 }],
      summary: { status: 'banana', gates: 1, passed: 1, failed: 0, failedIds: [] },
    }));
    assert.equal(banana.ok, false);
    assert.match(banana.reason, /status/);
  });

  it('gate ids are kebab-case (closes the comma-aliasing of the failedIds compare — internal sweep)', () => {
    const commaId = validateRecord(gateRun({
      declared: [{ id: 'a,b', cmd: 'node --test x' }],
      results: [{ id: 'a,b', ok: false, code: 1 }],
      summary: { status: 'fail', gates: 1, passed: 0, failed: 1, failedIds: ['a', 'b'] },
    }));
    assert.equal(commaId.ok, false);
    assert.match(commaId.reason, /kebab-case/);
  });
});

describe('isProcessGateCmd — the CLOSED process-gate classification (D5)', () => {
  const PROCESS = [
    'node agent-workflow-kit/tools/review-state.mjs --check',
    'node agent-workflow-kit/tools/review-ledger.mjs --check',
    'node agent-workflow-kit/tools/fold-completeness.mjs --check',
    'node "${CLAUDE_SKILL_DIR}/tools/review-ledger.mjs" --check',
  ];
  const NOT_PROCESS = [
    'node --test agent-workflow-kit/tools/*.test.mjs',
    'node agent-workflow-kit/tools/fold-completeness-run.mjs', // the runner is NOT the checker
    'node agent-workflow-kit/tools/review-ledger.mjs --status', // not the gate form
    'node agent-workflow-kit/tools/manifest/validate.mjs --strict pkg',
    'node scripts/check-docs-size.mjs --check-index', // --check-index is not --check
    // A COMPOUND line is never a process gate: exempting it would forgive the failing quality half
    // (fail-open against the D5 direction — internal sweep, confirmed by live probe).
    'node --test pkg/*.test.mjs && node agent-workflow-kit/tools/review-ledger.mjs --check',
    'node agent-workflow-kit/tools/review-ledger.mjs --check && node --test pkg/*.test.mjs',
    'node agent-workflow-kit/tools/review-ledger.mjs --check; true',
    'node agent-workflow-kit/tools/review-ledger.mjs --check --json', // extra flags — not the exact gate form
  ];
  for (const cmd of PROCESS) it(`process: ${cmd}`, () => assert.equal(isProcessGateCmd(cmd), true));
  for (const cmd of NOT_PROCESS) it(`not process: ${cmd}`, () => assert.equal(isProcessGateCmd(cmd), false));
});

describe('isQualityGreenGateRun — the D5 quality-green rule', () => {
  it('quality-green: every declared NON-process gate green, tree unchanged (a red PROCESS gate never blocks)', () => {
    assert.equal(isQualityGreenGateRun(gateRun()), true);
  });

  it('NOT quality-green: a --only subset missing a declared non-process gate (the R1 subset-bypass)', () => {
    const subset = gateRun({
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }, { id: 'release-scan', cmd: 'node tools/release-scan.mjs pkg' }],
      results: [{ id: 'unit-tests', ok: true, code: 0 }],
      summary: { status: 'ok', gates: 1, passed: 1, failed: 0, failedIds: [] },
    });
    assert.equal(isQualityGreenGateRun(subset), false);
  });

  it('NOT quality-green: a red non-process gate', () => {
    const red = gateRun({
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }],
      results: [{ id: 'unit-tests', ok: false, code: 1 }],
      summary: { status: 'fail', gates: 1, passed: 0, failed: 1, failedIds: ['unit-tests'] },
    });
    assert.equal(isQualityGreenGateRun(red), false);
  });

  it('NOT quality-green: the tree changed under the run (fingerprint !== fingerprintAfter) — codex R2', () => {
    assert.equal(isQualityGreenGateRun(gateRun({ fingerprintAfter: 'e'.repeat(64) })), false);
  });

  it('NOT quality-green: an unfingerprinted tree (null)', () => {
    assert.equal(isQualityGreenGateRun(gateRun({ fingerprint: null, fingerprintAfter: null })), false);
  });
});

describe('filterSegmentRecords + collectSizeCapLimit — the segment scope (D1/D4)', () => {
  it('records at baseA are invisible at baseB; pre-v4 records never enter a segment', () => {
    const records = [v4Round(), v4Round({ base: BASE_B }), roundFixture()];
    const atA = filterSegmentRecords(records, { activity: 'plan-execution', loop: 'example-feature', base: BASE_A });
    assert.equal(atA.length, 1);
    assert.equal(atA[0].base, BASE_A);
    const atB = filterSegmentRecords(records, { activity: 'plan-execution', loop: 'example-feature', base: BASE_B });
    assert.equal(atB.length, 1);
  });

  it('base null (unborn branch) matches only null — never a pre-v4 record with no base', () => {
    const records = [v4Round({ base: null }), roundFixture()];
    const seg = filterSegmentRecords(records, { activity: 'plan-execution', loop: 'example-feature', base: null });
    assert.equal(seg.length, 1);
    assert.equal(seg[0].schema, 4);
  });

  it('a pre-v4 record NEVER enters a segment, even for a defensive undefined base (codex R1 minor)', () => {
    const records = [roundFixture(), v4Round()];
    assert.deepEqual(filterSegmentRecords(records, { activity: 'plan-execution', loop: 'example-feature', base: undefined }), [], 'undefined base matches nothing — pre-v4 records carry no base and stay out');
  });

  it('the source carries no raw control bytes (a NUL byte turns the tool binary for grep — codex R1)', () => {
    for (const f of ['review-ledger.mjs', 'review-ledger-write.mjs', 'changed-surface.mjs']) {
      const bytes = readFileSync(new URL(`./${f}`, import.meta.url));
      const bad = [...bytes].filter((b) => b < 0x20 && b !== 0x0a && b !== 0x09 && b !== 0x0d).length;
      assert.equal(bad, 0, `${f} must contain no raw control bytes (found ${bad})`);
    }
  });

  it('collectSizeCapLimit returns the LARGEST sanction of the segment, null when none / other-segment only', () => {
    const records = [sizeCapOverride({ sanctionedLines: 500 }), sizeCapOverride({ sanctionedLines: 612 }), sizeCapOverride({ base: BASE_B, sanctionedLines: 9999 })];
    assert.equal(collectSizeCapLimit(records, { activity: 'plan-execution', loop: 'example-feature', base: BASE_A }), 612);
    assert.equal(collectSizeCapLimit(records, { activity: 'plan-execution', loop: 'example-feature', base: '3'.repeat(40) }), null);
    assert.equal(collectSizeCapLimit([], { activity: 'plan-execution', loop: 'example-feature', base: BASE_A }), null);
  });
});

describe('roundSequenceIntact', () => {
  const rd = (n) => ({ kind: 'round', round: n });
  it('true for 1..n in order', () => assert.equal(roundSequenceIntact([rd(1), rd(2), rd(3)]), true));
  it('true for empty', () => assert.equal(roundSequenceIntact([]), true));
  it('false for a gap / missing first (e.g. [2])', () => assert.equal(roundSequenceIntact([rd(2)]), false));
  it('false for a duplicate ([1,1])', () => assert.equal(roundSequenceIntact([rd(1), rd(1)]), false));
  it('false for out-of-order ([2,1])', () => assert.equal(roundSequenceIntact([rd(2), rd(1)]), false));
  it('ignores triage records (only rounds count)', () => assert.equal(roundSequenceIntact([rd(1), { kind: 'triage', round: 1 }, rd(2)]), true));
});

// ── decideStop truth table — helpers ─────────────────────────────────────────────────────────────

const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);
const B = (backend, blockers = 0, majors = 0, minors = 0, extra = {}) => ({ backend, degraded: false, blockers, majors, minors, verdict: 'ship', ...extra });
const F = (findingKey, severity, backend, origin = 'first-draft') => ({ findingKey, severity, origin, backend });
const round = ({ round = 1, fingerprint = FP, backends, findings = [], loop = 'L', activity = 'plan-execution' }) => {
  const origins = { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 };
  for (const f of findings) origins[f.origin] += 1;
  return { schema: 1, loop, activity, kind: 'round', round, fingerprint, origins, backends, findings, timestamp: 't' };
};
const triage = ({ round = 2, fingerprint = FP, classifications, loop = 'L', activity = 'plan-execution' }) => ({ schema: 1, loop, activity, kind: 'triage', round, fingerprint, classifications, timestamp: 't' });
const CLS = (findingKey, cls, accepted = false) => ({ findingKey, class: cls, accepted, testId: null, note: '' });
const REQ = ['codex', 'agy'];

describe('decideStop — the four states + edge cases', () => {
  it('converged — every requiredBackend present, non-degraded, 0/0, current tree', () => {
    const r = [round({ backends: [B('codex'), B('agy')], findings: [] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });

  it('resolved-residual — cap + surviving major classified inherent-residual, matching triage fingerprint', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'inherent-layer-residual', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'resolved-residual');
  });

  it('resolved-residual — accepted-escalate counts as resolved', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 1, 0), B('agy')], findings: [F('k', 'blocker', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'escalate', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'resolved-residual');
  });

  it('resolved-residual STALE — a doc edit after triage moves the fingerprint → NOT resolved → continue', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 2, fingerprint: FP, classifications: [CLS('k', 'inherent-layer-residual', true)] }),
    ];
    // current tree moved to FP2 (edited after the triage) → the triage no longer matches
    assert.equal(decideStop(r, { currentFingerprint: FP2, requiredBackends: REQ }).state, 'continue');
  });

  it('fixable-bug does NOT deadlock — all surviving classified fixable-bug → continue (writer permits)', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'fixable-bug', false)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('resolved-residual REJECTS a pending-escalate (accepted:false) → continue', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 1, 0), B('agy')], findings: [F('k', 'blocker', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k', 'escalate', false)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('triage-required — cap + UNCLASSIFIED surviving major', () => {
    const r = [round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('triage-required — cap + UNCLASSIFIED surviving BLOCKER only (blocking = blocker ∪ major)', () => {
    const r = [round({ round: 2, backends: [B('codex', 1, 0), B('agy')], findings: [F('k', 'blocker', 'codex')] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('triage-required — recurrence auto-trip (same blocking key in 2 rounds, unclassified) UNDER the cap', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
    ];
    // cap raised to 3 so latest.round (2) < cap — isolates the recurrence trip from the cap trip
    assert.equal(decideStop(r, { cap: 3, currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('continue — under the cap with a surviving major (no recurrence)', () => {
    const r = [round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('continue — 0-blocking stale (clean review then a post-review edit moves the fingerprint)', () => {
    const r = [round({ round: 1, backends: [B('codex'), B('agy')], findings: [] })];
    const d = decideStop(r, { currentFingerprint: FP2, requiredBackends: REQ });
    assert.equal(d.state, 'continue');
    assert.match(d.reason, /re-review the edited tree/);
  });

  it('precedence — cap + 0 surviving blocking + a triage record → converged (not resolved-residual)', () => {
    const r = [
      round({ round: 2, backends: [B('codex'), B('agy')], findings: [] }),
      triage({ round: 2, classifications: [CLS('old', 'inherent-layer-residual', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });

  it('partial-classification — cap + surviving blocking, a triage covering SOME → still triage-required for the rest', () => {
    const r = [
      round({ round: 2, backends: [B('codex', 0, 2), B('agy')], findings: [F('k1', 'major', 'codex'), F('k2', 'major', 'codex')] }),
      triage({ round: 2, classifications: [CLS('k1', 'inherent-layer-residual', true)] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('continue — no round recorded yet (only a triage, or empty)', () => {
    assert.equal(decideStop([], { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });

  it('round-binding — a triage targeting an EARLIER round does not resolve the latest round (codex R1)', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      triage({ round: 1, classifications: [CLS('k', 'inherent-layer-residual', true)] }), // targets round 1, not the latest
    ];
    // the round-1 triage must NOT satisfy resolved-residual for the round-2 survivor → still triage-required
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'triage-required');
  });

  it('recurrence reason mentions "recurred" (agy R1 UX)', () => {
    const r = [
      round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
      round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }),
    ];
    const d = decideStop(r, { cap: 3, currentFingerprint: FP, requiredBackends: REQ });
    assert.equal(d.state, 'triage-required');
    assert.match(d.reason, /recurred/);
  });
});

// ── EXHAUSTIVE interaction truth table (the SPEC) ────────────────────────────────────────────────
// decideStop is a state machine over (rounds × findings × severity × classifications × fingerprint ×
// degraded × cap/recurrence). Point tests miss INTERACTIONS — this table pins the full transition
// space, including the exact cross-cases the council found (a fixed-but-recurring finding must NOT
// deadlock the gate; round-bound classifications). A row that regresses goes red BEFORE any commit.
describe('decideStop — exhaustive interaction truth table (the spec)', () => {
  const R = (...bs) => bs; // backends
  const codexOnly = ['codex'];
  const both = ['codex', 'agy'];
  const deg = { degraded: true, reason: 'stall', verdict: 'degraded' };

  const CASES = [
    // ── converged / not-converged by counts, fingerprint, degraded, presence ──
    { name: 'converged: both 0/0 at current tree', records: [round({ round: 1, backends: R(B('codex'), B('agy')) })], req: both, expect: 'converged' },
    { name: 'converged: non-degraded 0/0 with the other degraded (Decision 4 ii)', records: [round({ round: 1, backends: R(B('codex'), B('agy', 0, 0, 0, deg)) })], req: both, expect: 'converged' },
    { name: 'NOT converged: the sole required backend is degraded (Decision 4 i)', records: [round({ round: 1, backends: R(B('codex', 0, 0, 0, deg)) })], req: codexOnly, expect: 'continue' },
    { name: 'NOT converged: a required backend has no entry — missing ≠ degraded (Decision 4 iii)', records: [round({ round: 1, backends: R(B('codex')) })], req: both, expect: 'continue' },
    { name: 'continue: 0-blocking but the tree moved after the clean review (stale)', records: [round({ round: 1, backends: R(B('codex'), B('agy')) })], req: both, fp: FP2, expect: 'continue' },

    // ── resolved-residual: class × fingerprint × round-binding ──
    { name: 'resolved-residual: cap survivor classified inherent-residual, matching tree', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, expect: 'resolved-residual' },
    { name: 'resolved-residual: accepted-escalate counts', records: [round({ round: 2, backends: R(B('codex', 1, 0), B('agy')), findings: [F('k', 'blocker', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'escalate', true)] })], req: both, expect: 'resolved-residual' },
    { name: 'NOT resolved (stale): a doc edit after the triage moved the fingerprint', records: [round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, fingerprint: FP, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, fp: FP2, expect: 'continue' },
    { name: 'NOT resolved (round-binding): the triage targets an EARLIER round than the latest', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 1, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, expect: 'triage-required' },
    { name: 'NOT resolved (pending escalate): accepted:false → continue', records: [round({ round: 2, backends: R(B('codex', 1, 0), B('agy')), findings: [F('k', 'blocker', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'escalate', false)] })], req: both, expect: 'continue' },
    { name: 'partial classification at cap → triage-required for the unclassified rest', records: [round({ round: 2, backends: R(B('codex', 0, 2), B('agy')), findings: [F('k1', 'major', 'codex'), F('k2', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k1', 'inherent-layer-residual', true)] })], req: both, expect: 'triage-required' },
    // A recipe-named backend MISSING from the residual round → NOT resolved-residual: the residual was
    // accepted without full council (agy never reviewed). Same presence discipline as converged (codex R4).
    { name: 'NOT resolved (missing backend): a recipe-named backend has no entry in the residual round', records: [round({ round: 2, backends: R(B('codex', 0, 1)), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'inherent-layer-residual', true)] })], req: both, expect: 'continue' },

    // ── triage-required: cap × severity × recurrence ──
    { name: 'triage-required: cap + unclassified surviving major', records: [round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] })], req: both, expect: 'triage-required' },
    { name: 'triage-required: cap + unclassified surviving BLOCKER only', records: [round({ round: 2, backends: R(B('codex', 1, 0), B('agy')), findings: [F('k', 'blocker', 'codex')] })], req: both, expect: 'triage-required' },
    { name: 'triage-required: recurrence of a SURVIVING key under the cap', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] })], req: both, cap: 3, expect: 'triage-required' },
    { name: 'continue: cap + all survivors classified fixable-bug (no deadlock)', records: [round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), triage({ round: 2, classifications: [CLS('k', 'fixable-bug', false)] })], req: both, expect: 'continue' },

    // ── THE DEADLOCK CASES (council-found): a FIXED recurring key must not force triage ──
    // A key surviving rounds 1+2, GONE in round 3, with round 3's own surviving finding classified:
    // OLD (buggy) code force triage-required on the vanished key (recordTriage rightly refuses to
    // classify a finding that no longer survives → deadlock). The spec: continue.
    { name: 'DEADLOCK GUARD: a fixed recurring key does not force triage once the live finding is handled', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 3, backends: R(B('codex', 0, 1), B('agy')), findings: [F('m', 'major', 'codex')] }), triage({ round: 3, classifications: [CLS('m', 'fixable-bug', false)] })], req: both, cap: 3, expect: 'continue' },
    // A key surviving rounds 1+2, GONE in round 3, round 3 fully clean (0/0): must converge.
    { name: 'DEADLOCK GUARD: a fixed recurring key does not block convergence of a later clean round', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 3, backends: R(B('codex'), B('agy')) })], req: both, cap: 3, expect: 'converged' },
    // A key GONE in round 3 but a NEW live major m present + unclassified: triage-required on m ONLY.
    { name: 'DEADLOCK GUARD: triage keys reference only the LIVE finding, not the vanished recurring one', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 2, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] }), round({ round: 3, backends: R(B('codex', 0, 1), B('agy')), findings: [F('m', 'major', 'codex')] })], req: both, cap: 3, expect: 'triage-required', reasonHas: 'm', reasonHasNot: 'k' },

    // ── continue catch-all ──
    { name: 'continue: under the cap, one unclassified major, no recurrence', records: [round({ round: 1, backends: R(B('codex', 0, 1), B('agy')), findings: [F('k', 'major', 'codex')] })], req: both, expect: 'continue' },
    { name: 'continue: no round recorded yet', records: [], req: both, expect: 'continue' },
    { name: 'precedence: cap + 0 surviving + a triage → converged (not resolved-residual)', records: [round({ round: 2, backends: R(B('codex'), B('agy')) }), triage({ round: 2, classifications: [CLS('old', 'inherent-layer-residual', true)] })], req: both, expect: 'converged' },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const d = decideStop(c.records, { cap: c.cap ?? REVIEW_CAP, currentFingerprint: c.fp ?? FP, requiredBackends: c.req });
      assert.equal(d.state, c.expect, `expected ${c.expect}, got ${d.state} (${d.reason})`);
      if (c.reasonHas) assert.match(d.reason, new RegExp(c.reasonHas));
      if (c.reasonHasNot) assert.doesNotMatch(d.reason, new RegExp(`\\b${c.reasonHasNot}\\b`));
    });
  }
});

// ── ADDITIVE v4 rows (AD-048): the refuted class in decideStop — added beside the frozen truth
// table, never inside it (D10: every pre-existing row stays green unmodified). Without this arm a
// phantom blocking finding minted at round HARD_MAX and honestly refuted WEDGES the segment: the
// immutable round record carries the minting backend's non-0/0 counts (never converged), round 4 is
// refused per segment, and the only in-band exits would mislabel the phantom (internal sweep,
// confirmed by live probe). A refuted classification is a documented resolution — grounds
// mandatory — so it resolves exactly like an inherent-layer-residual.
describe('decideStop — the refuted class resolves (AD-048 additive rows)', () => {
  const REFUTED = (findingKey, note = 'refuted against code: the cited guard exists at file:42') => ({ findingKey, class: 'refuted', accepted: false, testId: null, note });

  it('resolved-residual: a REFUTED surviving phantom at the cap, classification at the current tree', () => {
    const r = [
      round({ round: 1, backends: [B('codex'), B('agy', 0, 1)], findings: [F('k', 'major', 'agy')] }),
      round({ round: 2, backends: [B('codex'), B('agy', 0, 1)], findings: [F('k', 'major', 'agy')] }),
      triage({ round: 2, classifications: [REFUTED('k')] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'resolved-residual');
  });

  it('NOT resolved: the refuting triage is STALE (the tree moved after it) → continue', () => {
    const r = [
      round({ round: 2, backends: [B('codex'), B('agy', 0, 1)], findings: [F('k', 'major', 'agy')] }),
      triage({ round: 2, fingerprint: FP, classifications: [REFUTED('k')] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP2, requiredBackends: REQ }).state, 'continue');
  });

  it('under the cap with no recurrence a refuted phantom stays continue (the normal D6 next-round lane)', () => {
    const r = [
      round({ round: 1, backends: [B('codex'), B('agy', 0, 1)], findings: [F('k', 'major', 'agy')] }),
      triage({ round: 1, classifications: [REFUTED('k')] }),
    ];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'continue');
  });
});

describe('decideStop — degraded-backend matrix (Decision 4)', () => {
  it('(i) a degraded backend with a ship-shaped record does NOT by itself produce converged', () => {
    const r = [round({ backends: [B('codex', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })] })];
    assert.notEqual(decideStop(r, { currentFingerprint: FP, requiredBackends: ['codex'] }).state, 'converged');
  });

  it('(ii) converged is reached on the non-degraded requiredBackends 0/0 with the degrade recorded', () => {
    const r = [round({ backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })] })];
    assert.equal(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });

  it('(iii) a requiredBackend with NO entry is missing (≠ degraded) → non-converged', () => {
    const r = [round({ backends: [B('codex')] })]; // agy required but absent
    assert.notEqual(decideStop(r, { currentFingerprint: FP, requiredBackends: REQ }).state, 'converged');
  });
});

// ── the --check gate (decideCheck is a pure function of state) ───────────────────────────────────

// The gate judges the SEGMENT since AD-048: the state carries the current base and only v4 records
// with that base are the segment. GATE_BASE + seg() modernize the fixtures (a pre-v4 record never
// enters a segment — pinned by its own tests below).
const GATE_BASE = 'e'.repeat(40);
const seg4 = (rec) => ({ ...rec, schema: 4, base: GATE_BASE });
const mkState = (over = {}) => ({
  resolved: { recipe: 'council', source: 'config', degradedFrom: null, reason: null },
  requiredBackends: ['codex', 'agy'],
  plans: ['L.md'],
  fingerprint: FP,
  clean: false,
  base: GATE_BASE,
  ledgerPath: '/tmp/ledger.jsonl',
  records: [],
  malformed: 0,
  malformedReasons: [],
  receipts: [],
  receiptsPath: '/tmp/receipts.jsonl',
  detectionWarning: null,
  ...over,
});

// A receipt SELF-DECLARES its probe status (D3): `probe:false` is a real review, `probe:true` a
// throwaway probe that may never attest. An unmarked receipt is rejected, so the default is explicit.
const codexReceipt = (fingerprint, verdict = 'SHIP', overrides = {}) => ({ schema: 1, artifact: 'code', fresh: true, fingerprint, backend: 'codex', verdict, grounded: true, timestamp: 't', probe: false, ...overrides });

describe('decideCheck — the --check gate exit contract', () => {
  it('exit 0 — explicitly configured solo (detector-independent)', () => {
    assert.equal(decideCheck(mkState({ resolved: { recipe: 'solo', source: 'config', degradedFrom: null } })).code, 0);
  });

  it('exit 0 — recipe degrades to solo (no reviewer ready)', () => {
    assert.equal(decideCheck(mkState({ resolved: { recipe: 'solo', source: 'config', degradedFrom: 'council', reason: 'no backend ready' } })).code, 0);
  });

  it('exit 0 — no plan in flight', () => assert.equal(decideCheck(mkState({ plans: [] })).code, 0));

  it('exit 1 — more than one plan in flight (ambiguous loop id, fail-closed)', () => {
    const c = decideCheck(mkState({ plans: ['A.md', 'B.md'] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /more than one plan/);
  });

  it('exit 0 — not a git work tree', () => assert.equal(decideCheck(mkState({ fingerprint: null })).code, 0));
  it('exit 0 — clean tree', () => assert.equal(decideCheck(mkState({ clean: true })).code, 0));

  it('exit 1 — dirty active plan with NO round recorded (fail-closed, not fail-open)', () => {
    const c = decideCheck(mkState({ records: [] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /no review round recorded/);
  });

  it('exit 0 — converged with a grounded ship-class receipt for the current tree', () => {
    const records = [seg4(round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] }))];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 0);
    assert.match(c.reason, /converged/);
  });

  it('exit 1 — triage-required loop (valid [1,2] sequence at the cap)', () => {
    const records = [seg4(round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] })), seg4(round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }))];
    const c = decideCheck(mkState({ records }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /triage-required/);
  });

  it('exit 1 — continue loop (dirty, non-converged)', () => {
    const records = [seg4(round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }))];
    const c = decideCheck(mkState({ records }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /continue/);
  });

  it('exit 1 — converged recorded but a NON-degraded backend lacks a receipt', () => {
    const records = [seg4(round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy')], findings: [] }))];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')] })); // agy receipt missing
    assert.equal(c.code, 1);
    assert.match(c.reason, /no grounded code receipt for agy/);
  });

  it('exit 1 — converged recorded 0/0 but the receipt verdict is non-ship (inconsistent)', () => {
    const records = [seg4(round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] }))];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'revise')] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /not ship-class/);
  });

  it('exit 1 — fail-closed on a detector failure (not explicit solo)', () => {
    const c = decideCheck(mkState({ detectionWarning: 'detector blew up' }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /cannot verify the ledger/);
  });

  it('exit 1 — fail-closed on an unreadable ledger (non-ENOENT readError) for a dirty active plan', () => {
    const c = decideCheck(mkState({ readError: 'EACCES' }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /cannot read the ledger/);
  });

  it('exit 0 — a readError is irrelevant to a clean tree / no plan (short-circuits before the ledger)', () => {
    assert.equal(decideCheck(mkState({ readError: 'EACCES', clean: true })).code, 0);
    assert.equal(decideCheck(mkState({ readError: 'EACCES', plans: [] })).code, 0);
  });

  it('fails CLOSED on malformed ledger lines for a dirty active loop (codex R3)', () => {
    // a dropped malformed line could hide the latest non-converged round → never a fail-open PASS
    const records = [seg4(round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] }))];
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')], malformed: 1 }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /malformed/);
  });

  it('exit 0 — malformed is irrelevant to a clean tree / no plan (short-circuits before the ledger)', () => {
    assert.equal(decideCheck(mkState({ malformed: 3, clean: true })).code, 0);
    assert.equal(decideCheck(mkState({ malformed: 3, plans: [] })).code, 0);
  });

  it('exit 1 — a corrupt round sequence (not 1..n) fails closed (codex R3)', () => {
    const records = [seg4(round({ round: 2, fingerprint: FP, backends: [B('codex'), B('agy')], findings: [] }))]; // [2], no round 1
    const c = decideCheck(mkState({ records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /corrupt/);
  });

  it('the execution gate IGNORES plan-authoring records (Decision 6)', () => {
    const authoring = seg4(round({ round: 2, activity: 'plan-authoring', backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }));
    const execConverged = seg4(round({ round: 1, activity: 'plan-execution', fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'stall', verdict: 'degraded' })], findings: [] }));
    const c = decideCheck(mkState({ records: [authoring, execConverged], receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 0, 'the plan-authoring triage-required round must not block the code gate');
  });
});

// ── decideCheck under SEGMENT scope (AD-048 D1): the gate judges (activity, loop, base) ─────────

describe('decideCheck — segment scope (AD-048)', () => {
  const segRec = (rec, base = BASE_B) => ({ ...rec, schema: 4, base });
  const deg = { degraded: true, reason: 'stall', verdict: 'degraded' };

  it('converged at baseB while baseA holds an UNCONVERGED history (the multiphase fix)', () => {
    const records = [
      segRec(round({ round: 1, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }), BASE_A),
      segRec(round({ round: 2, backends: [B('codex', 0, 1), B('agy')], findings: [F('k', 'major', 'codex')] }), BASE_A),
      segRec(round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, deg)], findings: [] }), BASE_B),
    ];
    const c = decideCheck(mkState({ base: BASE_B, records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 0, c.reason);
    assert.match(c.reason, /converged/);
  });

  it('a dirty tree whose SEGMENT has no round fails with the record-round remedy (other bases do not count)', () => {
    const records = [segRec(round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, deg)], findings: [] }), BASE_A)];
    const c = decideCheck(mkState({ base: BASE_B, records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /no review round recorded for the current segment/);
  });

  it('a loop holding ONLY pre-v4 records fails with a reason naming the schema upgrade (D7 legacy)', () => {
    const records = [round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, deg)], findings: [] })]; // schema 1, no base
    const c = decideCheck(mkState({ base: BASE_B, records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 1);
    assert.match(c.reason, /pre-v4 records/);
  });

  it('per-segment round numbering: a fresh segment starting at round 1 is a VALID sequence beside old segments', () => {
    const records = [
      segRec(round({ round: 1, backends: [B('codex'), B('agy', 0, 0, 0, deg)], findings: [] }), BASE_A),
      segRec(round({ round: 2, backends: [B('codex'), B('agy', 0, 0, 0, deg)], findings: [] }), BASE_A),
      segRec(round({ round: 1, fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, deg)], findings: [] }), BASE_B),
    ];
    const c = decideCheck(mkState({ base: BASE_B, records, receipts: [codexReceipt(FP, 'SHIP')] }));
    assert.equal(c.code, 0, `loop-wide [1,2,1] must read as segment [1] — ${c.reason}`);
  });
});

// ── telemetry (D8): deterministic counts over a fixture spanning v1..v4 + fold rows ─────────────

describe('computeTelemetry + renderTelemetry — counts only, pinned render (D8)', () => {
  const reviewFixture = [
    // v1 history (legacy — counted, never segmented)
    roundFixture(),
    triageFixture(),
    // v4 segment A: one divergent round (codex clean, agy not), a triage with refuted, an override
    v4Round({
      base: BASE_A,
      backends: [
        { backend: 'codex', degraded: false, blockers: 0, majors: 0, minors: 0, verdict: 'ship' },
        { backend: 'agy', degraded: false, blockers: 0, majors: 1, minors: 0, verdict: 'revise' },
      ],
      origins: { 'first-draft': 1, 'fold-induced': 0, mechanics: 0 },
      findings: [{ findingKey: 'phantom', severity: 'major', origin: 'first-draft', backend: 'agy' }],
    }),
    v4Triage({ base: BASE_A, classifications: [{ findingKey: 'phantom', class: 'refuted', accepted: false, testId: null, note: 'refuted against file:42' }] }),
    sizeCapOverride({ base: BASE_A }),
    gateRun({ base: BASE_A }), // quality-green (the red gate is a process gate) with 1 red result
    // v4 segment B: a clean round
    v4Round({ base: BASE_B, round: 1 }),
  ];
  const foldRows = [
    { schema: 3, kind: 'run', loop: 'example-feature', testIds: [{ id: 'a.test.mjs#x', runs: 3, greens: 2, reds: 0, timeouts: 1 }] }, // quarantined entry
    { schema: 3, kind: 'red-probe', loop: 'example-feature', testId: 'a.test.mjs#x' },
    { schema: 1, loop: 'example-feature', testIds: [{ id: 'b.test.mjs#y', resolvable: true, baselineGreen: true, executed: 1 }] }, // v1 kindless run — no rerun counts, never quarantine-counted
    { loop: 42 }, // a half-shaped row: no usable loop → skipped
  ];

  it('the pinned telemetry render (fixture spanning v1..v4 + fold rows)', () => {
    const t = computeTelemetry(reviewFixture, foldRows);
    const out = renderTelemetry(t, { records: reviewFixture.length, malformed: 0, rows: foldRows.length, badLines: 0 });
    const expected = [
      'review-ledger telemetry — counts only, no judgment (D8). review ledger: 7 record(s); fold ledger: 4 row(s).',
      '  plan-execution / example-feature:',
      '    rounds 3 across 2 segment(s) (+2 pre-v4 record(s)) · divergence rounds 1',
      '    finding origins — first-draft:3 fold-induced:0 mechanics:0',
      '    classifications — inherent-layer-residual:1 refuted:1',
      '    backend verdicts — agy{degraded:2 revise:1} · codex{revise:2 ship:1}',
      '    overrides — size-cap:1',
      '    gate-runs 1 (quality-green 1) · red results by gate — review-ledger:1',
      '    fold runs 2 · observed-red receipts 1 · quarantined probe entries 1',
    ].join('\n');
    assert.equal(out, expected);
  });

  it('renderTelemetry surfaces read errors + malformed counts without judging', () => {
    const out = renderTelemetry(computeTelemetry([], []), { records: 0, malformed: 2, rows: 0, badLines: 1, readError: 'EACCES', foldReadError: 'EIO' });
    assert.match(out, /2 malformed/);
    assert.match(out, /1 unparseable/);
    assert.match(out, /review ledger unreadable \(EACCES\)/);
    assert.match(out, /fold ledger unreadable \(EIO\)/);
    assert.match(out, /no loops recorded/);
  });

  it('--telemetry refuses to combine with --check / --status / --json (a mixed-mode gate cmd must never silently pass — codex R2)', () => {
    for (const combo of [['--check', '--telemetry'], ['--telemetry', '--check'], ['--telemetry', '--status'], ['--telemetry', '--json']]) {
      const r = main(combo, { cwd: '/tmp', env: {}, detect: () => [] });
      assert.equal(r.code, 2, `${combo.join(' ')} must be a usage error, got ${r.code}`);
      assert.match(r.stderr, /--telemetry/);
    }
  });

  it('a suffix-named tool is not a process gate (path boundary required — codex R2, fold-induced)', () => {
    for (const cmd of [
      'node tools/my-review-ledger.mjs --check',
      'node fake-review-state.mjs --check',
      'node "x/evil-fold-completeness.mjs" --check',
    ]) {
      assert.equal(isProcessGateCmd(cmd), false, `${cmd} must NOT classify as a process gate`);
    }
    // The boundary keeps the real forms: bare basename, ./-relative, deep path, quoted path.
    for (const cmd of [
      'node review-ledger.mjs --check',
      'node ./tools/review-state.mjs --check',
      'node "${CLAUDE_SKILL_DIR}/tools/fold-completeness.mjs" --check',
    ]) {
      assert.equal(isProcessGateCmd(cmd), true, `${cmd} must classify as a process gate`);
    }
  });

  it('main --telemetry reads both ledgers and exits 0 (report, not a gate)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-telemetry-'));
    const ledger = join(root, 'rl.jsonl');
    const fold = join(root, 'fold.jsonl');
    writeFileSync(ledger, reviewFixture.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(fold, foldRows.map((r) => JSON.stringify(r)).join('\n'));
    const r = main(['--telemetry'], { cwd: root, env: { AW_REVIEW_LEDGER: ledger, AW_FOLD_RESULTS: fold }, detect: () => [] });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /rounds 3 across 2 segment/);
    assert.match(r.stdout, /observed-red receipts 1/);
  });
});

describe('isShipVerdict — the single home of the ship-class mapping', () => {
  for (const v of ['ship', 'SHIP', 'SHIP WITH NITS', 'Ship With Nits']) it(`"${v}" is ship-class`, () => assert.equal(isShipVerdict(v), true));
  for (const v of ['revise', 'REWORK', 'unknown', '', null, undefined]) it(`${JSON.stringify(v)} is NOT ship-class`, () => assert.equal(isShipVerdict(v), false));
});

describe('receiptCrossCheck — presence + ship-class consistency', () => {
  it('ok when each non-degraded backend has a grounded ship-class receipt', () => {
    const r = round({ fingerprint: FP, backends: [B('codex'), B('agy', 0, 0, 0, { degraded: true, reason: 'x', verdict: 'degraded' })], findings: [] });
    assert.equal(receiptCrossCheck(r, [codexReceipt(FP, 'SHIP')], FP).ok, true);
  });
  it('a non-0/0 backend needs presence but no ship-class consistency', () => {
    const r = round({ fingerprint: FP, backends: [B('codex', 0, 1)], findings: [F('k', 'major', 'codex')] });
    assert.equal(receiptCrossCheck(r, [codexReceipt(FP, 'revise')], FP).ok, true);
  });

  // The ORDER is the whole finding (D3): the cross-check used to take the LAST current receipt, so a
  // probe written after a real review became the authoritative verdict — a probe SHIP could bury a
  // real REWORK and let this gate AND review-state both report convergence.
  it('a later probe SHIP never overrides an earlier real REWORK receipt', () => {
    const r = round({ fingerprint: FP, backends: [B('codex')], findings: [] });
    const receipts = [codexReceipt(FP, 'revise'), codexReceipt(FP, 'SHIP', { probe: true })];
    const out = receiptCrossCheck(r, receipts, FP);
    assert.equal(out.ok, false, 'the real verdict is the attesting one, whatever lands after it');
    assert.match(out.reason, /attesting receipt verdict "revise"/);
  });

  it('a later probe REWORK never poisons an earlier real SHIP receipt', () => {
    const r = round({ fingerprint: FP, backends: [B('codex')], findings: [] });
    const receipts = [codexReceipt(FP, 'SHIP'), codexReceipt(FP, 'revise', { probe: true })];
    assert.equal(receiptCrossCheck(r, receipts, FP).ok, true, 'a probe cannot fail a round either — it simply never attests');
  });

  it('probe-only receipts cannot attest a round, with a probe-specific reason', () => {
    const r = round({ fingerprint: FP, backends: [B('codex')], findings: [] });
    const out = receiptCrossCheck(r, [codexReceipt(FP, 'SHIP', { probe: true })], FP);
    assert.equal(out.ok, false);
    assert.match(out.reason, /only probe receipts exist for the current tree/);
  });

  it('an UNMARKED receipt cannot attest a round (silence is not a declaration)', () => {
    const r = round({ fingerprint: FP, backends: [B('codex')], findings: [] });
    const unmarked = codexReceipt(FP, 'SHIP');
    delete unmarked.probe;
    const out = receiptCrossCheck(r, [unmarked], FP);
    assert.equal(out.ok, false);
    assert.match(out.reason, /1 receipt\(s\) with no probe marker/);
  });

  it('a MALFORMED marker cannot attest a round (fail-closed)', () => {
    const r = round({ fingerprint: FP, backends: [B('codex')], findings: [] });
    const out = receiptCrossCheck(r, [codexReceipt(FP, 'SHIP', { probe: 'no' })], FP);
    assert.equal(out.ok, false);
    assert.match(out.reason, /malformed probe marker/);
  });
});

describe('filterLoopRecords', () => {
  it('keeps only the named activity + loop', () => {
    const recs = [
      round({ loop: 'A', activity: 'plan-execution', backends: [B('codex')] }),
      round({ loop: 'B', activity: 'plan-execution', backends: [B('codex')] }),
      round({ loop: 'A', activity: 'plan-authoring', backends: [B('codex')] }),
    ];
    assert.equal(filterLoopRecords(recs, { activity: 'plan-execution', loop: 'A' }).length, 1);
  });
});

// ── integration: buildLedgerState over a real git tree + AW_REVIEW_LEDGER override ──────────────

describe('review-ledger — integration over a scratch git tree', () => {
  let cwd;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'review-ledger-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('resolveLedgerPath honors AW_REVIEW_LEDGER', () => {
    assert.equal(resolveLedgerPath(cwd, { AW_REVIEW_LEDGER: '/x/y.jsonl' }), '/x/y.jsonl');
  });

  it('buildLedgerState reads a ledger file + surfaces malformed lines (detector stubbed)', () => {
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    const ledger = join(cwd, 'ledger.jsonl');
    writeFileSync(ledger, `${FIXTURE}\n{bad`);
    const state = buildLedgerState({ cwd, env: { AW_REVIEW_LEDGER: ledger }, detect: () => [] });
    assert.equal(state.records.length, 2);
    assert.equal(state.malformed, 1);
    assert.equal(REVIEW_CAP, 2);
  });

  it('resolveBase: null outside a git tree AND on an unborn branch (a caught refusal, never a crash); the HEAD sha after a commit', () => {
    assert.equal(resolveBase(cwd), null, 'not a git tree → null');
    const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    g('init', '-q');
    assert.equal(resolveBase(cwd), null, 'an unborn branch has no HEAD commit → null');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const head = g('rev-parse', 'HEAD').stdout.trim();
    assert.equal(resolveBase(cwd), head, 'base = the commit the dirty tree sits on');
  });

  it('--status groups the loop records by SEGMENT and renders gate-run lines (v4)', () => {
    const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'p@e');
    g('config', 'user.name', 'p');
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'ai', 'orchestration.json'), JSON.stringify({ 'plan-execution': { review: 'council' } }));
    mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'plans', 'example-feature.md'), '# plan\n');
    writeFileSync(join(cwd, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    const head = g('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(cwd, 'pending.txt'), 'dirty\n');
    const ledger = join(cwd, '.git', 'rl.jsonl');
    const treeChanged = gateRun({ base: head, fingerprintAfter: 'e'.repeat(64) });
    const subset = gateRun({
      base: head,
      declared: [{ id: 'unit-tests', cmd: 'node --test x' }, { id: 'release-scan', cmd: 'node tools/release-scan.mjs pkg' }],
      results: [{ id: 'unit-tests', ok: true, code: 0 }],
      summary: { status: 'ok', gates: 1, passed: 1, failed: 0, failedIds: [] },
    });
    const lines = [
      JSON.stringify(roundFixture()), // pre-v4 history → the legacy group
      JSON.stringify(v4Round({ base: BASE_A })), // a CLOSED segment (not the current head)
      JSON.stringify(v4Round({ base: head })), // the CURRENT segment
      JSON.stringify(gateRun({ base: head })),
      JSON.stringify(treeChanged),
      JSON.stringify(subset),
    ];
    writeFileSync(ledger, `${lines.join('\n')}\n`);
    const r = main(['--status'], { cwd, env: { AW_REVIEW_LEDGER: ledger }, detect: () => [{ name: 'codex-cli-bridge', readiness: 'ready' }, { name: 'antigravity-cli-bridge', readiness: 'ready' }] });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /segment base: /, 'the state header names the current base');
    assert.match(r.stdout, /pre-v4 records \(no segment — readable history\):/);
    assert.match(r.stdout, new RegExp(`segment @ base ${BASE_A.slice(0, 12)}:`), 'a closed segment renders unmarked');
    assert.match(r.stdout, new RegExp(`segment @ base ${head.slice(0, 12)} \\(current\\):`), 'the current segment is marked');
    assert.match(r.stdout, /gate-run — status=fail 1\/2 green of 2 declared — quality-green/, 'a gate-run renders its posture (red process gate never blocks quality-green)');
    assert.match(r.stdout, /NOT quality-green \(the tree changed under the run\)/, 'a tree-changed run renders its posture');
    assert.match(r.stdout, /NOT quality-green \(a subset, a red gate, or an unfingerprinted tree\)/, 'a subset run renders its posture');
  });
});
