// fold-completeness.test.mjs — the M3 read-only checker (AD-046, DEBT-TEST-COMPLETENESS): a
// decision-table over every branch of the normative `--check` exit contract (the tool header is the
// single home of that list), the Decision-9 double binding (tree fingerprint AND the sorted
// fixable-bug testId set), and the structural import-split invariant (the checker never imports the
// runner). Fixtures are real git repos (the review-state.test.mjs makeRepo idiom); the run record is
// hand-crafted so each branch is isolated — the checker is PURE over (record, fingerprint, review
// ledger), it never runs a suite.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  main,
  decideCheck,
  validateRunRecord,
  readResults,
  isRunRecord,
  isRedProbeRecord,
  latestRunRecord,
  probeVerdict,
} from './fold-completeness.mjs';
import { computeTreeFingerprint } from './review-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COUNCIL = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });
const SOLO = JSON.stringify({ 'plan-execution': { review: 'solo' } });
const READY = 'ready';
const detect = (readiness = READY) => () => [
  { name: 'codex-cli-bridge', readiness },
  { name: 'antigravity-cli-bridge', readiness },
];

// A dirty git fixture with a single in-flight plan (council recipe by default). Sets CURRENT_BASE
// (the fixture's HEAD) so the v3/v4 record factories below stamp the SEGMENT frame without every
// call site threading root — node:test runs a file's tests serially, so the module slot is safe.
let CURRENT_BASE = null;
const makeRepo = ({ config = COUNCIL, plans = ['demo-plan.md'], pending = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'fold-check-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e');
  g('config', 'user.name', 'p');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  if (config != null) {
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), config);
  }
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  for (const p of plans) writeFileSync(join(root, 'docs', 'plans', p), `# ${p}\n`);
  g('add', '-A');
  g('commit', '-qm', 'base');
  CURRENT_BASE = g('rev-parse', 'HEAD').stdout.trim();
  if (pending) writeFileSync(join(root, 'pending.txt'), 'uncommitted\n');
  return { root, g };
};

const RESULTS = (root) => join(root, '.git', 'fc.jsonl');
const REVIEW = (root) => join(root, '.git', 'rl.jsonl');
const envFor = (root) => ({ AW_FOLD_RESULTS: RESULTS(root), AW_REVIEW_LEDGER: REVIEW(root) });

const runRecord = (over = {}) => ({
  schema: 1, loop: 'demo-plan', fingerprint: 'a'.repeat(64), boundTestIds: [], testIds: [],
  unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] },
  mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null },
  budgets: { mutantsMax: 200, hunkMutantsMax: 25, timeBudgetS: 600 }, timestamp: 't', ...over,
});
const seedResult = (root, record) => writeFileSync(RESULTS(root), `${JSON.stringify(record)}\n`);

// SEGMENT fixtures (BUGFREE-2 / AD-048, D7): a run/red-probe record carries the v2 evidence shape
// (kind + rerun counts + custody hash) PLUS the v3 segment frame (base = the fixture's HEAD).
// Explicit-legacy tests override { schema: 2, base: undefined } — JSON.stringify drops the
// undefined, so the seeded line is a faithful pre-v3 record.
const HASH_A = 'f'.repeat(64);
const v2Entry = (id, over = {}) => ({
  id, executed: 1, runs: 3, greens: 3, reds: 0, timeouts: 0, fileHash: HASH_A,
  resolvable: true, baselineGreen: true, ...over,
});
const segRun = (over = {}) => runRecord({ schema: 3, kind: 'run', tamper: { tampered: [] }, base: CURRENT_BASE, ...over });
const redProbe = (over = {}) => ({
  schema: 3, kind: 'red-probe', loop: 'demo-plan', base: CURRENT_BASE, testId: 'x.test.mjs#p', fileHash: HASH_A,
  runs: 3, reds: 3, fingerprint: 'a'.repeat(64), timestamp: 't', ...over,
});
// Review-ledger override lines — what the fold gate consumes at check time (collectOverrides stays
// LOOP-scoped, AD-047 semantics: v3 override lines keep working).
const oracleOverrideLine = (loop, files) =>
  `${JSON.stringify({ schema: 3, loop, activity: 'plan-execution', kind: 'override', round: 1, fingerprint: 'b'.repeat(64), scope: 'oracle-change', files, reason: 'deliberate oracle update', timestamp: 't' })}\n`;
const redProofOverrideLine = (loop, testId) =>
  `${JSON.stringify({ schema: 3, loop, activity: 'plan-execution', kind: 'override', round: 1, fingerprint: 'b'.repeat(64), scope: 'red-proof', testId, reason: 'red genuinely unestablishable', timestamp: 't' })}\n`;
// The bound set is SEGMENT-scoped (D7) — the triage rides the v4 frame at the fixture's base.
const fixableTriage = (loop, testId) =>
  `${JSON.stringify({ schema: 4, loop, activity: 'plan-execution', kind: 'triage', round: 1, base: CURRENT_BASE, fingerprint: 'b'.repeat(64), classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId, note: '' }], timestamp: 't' })}\n`;

const check = (root, { readiness = READY, args = ['--check'] } = {}) => main(args, { cwd: root, env: envFor(root), detect: detect(readiness) });
const done = (root) => rmSync(root, { recursive: true, force: true });

// Seed MANY result records in ledger order (receipts + runs — the D5 order/custody fixtures).
const seedResults = (root, ...records) => writeFileSync(RESULTS(root), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
// Bind fixable-bug testIds in the review ledger (the bound set the checker recomputes).
const bindIds = (root, ...ids) => writeFileSync(REVIEW(root), ids.map((id) => fixableTriage('demo-plan', id)).join(''));

// A v2 run record that matches the CURRENT tree + an empty review ledger (the all-green baseline).
const seedCurrentGreen = (root, over = {}) => seedResult(root, segRun({ fingerprint: computeTreeFingerprint(root), ...over }));
const currentSegRun = (root, over = {}) => segRun({ fingerprint: computeTreeFingerprint(root), ...over });

// ── exit-0 branches ───────────────────────────────────────────────────────────────────────────────

describe('fold-completeness --check — pass branches', () => {
  it('explicit configured solo → 0, no run required', () => {
    const { root } = makeRepo({ config: SOLO });
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /solo/);
  });

  it('no plan in flight → 0', () => {
    const { root } = makeRepo({ plans: [] });
    writeFileSync(join(root, 'docs', 'plans', 'EXECUTE-scratch.md'), 'scratch\n');
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no plan in flight/);
  });

  it('clean tree → 0 (nothing to assess)', () => {
    const { root, g } = makeRepo({ pending: false });
    g('add', '-A');
    g('commit', '-qm', 'all in');
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /clean/);
  });

  it('not a git work tree → 0', () => {
    // config + a plan in flight so the decision reaches the fingerprint==null branch (the no-plan
    // check precedes it) — the review-state.test.mjs non-git idiom.
    const root = mkdtempSync(join(tmpdir(), 'fold-nogit-'));
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), COUNCIL);
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# plan\n');
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /not a git work tree/);
  });

  it('a current run: bindings match, all green → 0', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root);
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stderr);
  });

  it('out-of-domain changes are listed but never block → 0', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { outOfDomain: ['notes.md', 'data.json'] });
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /out-of-domain/);
  });

});

// ── exit-1 branches ───────────────────────────────────────────────────────────────────────────────

describe('fold-completeness --check — fail branches', () => {
  it('more than one plan in flight → 1 (ambiguous loop id)', () => {
    const { root } = makeRepo({ plans: ['one.md', 'two.md'] });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /more than one plan/);
  });

  it('a detector failure (non-solo) → 1, fail closed', () => {
    const { root } = makeRepo();
    const r = main(['--check'], { cwd: root, env: envFor(root), detect: () => { throw new Error('boom'); } });
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /cannot verify/);
  });

  it('a dirty in-flight loop with NO run recorded → 1', () => {
    const { root } = makeRepo();
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /no fold-completeness run recorded/);
  });

  it('a run for a STALE fingerprint (tree edited after the run) → 1', () => {
    const { root } = makeRepo();
    seedResult(root, segRun({ fingerprint: 'c'.repeat(64) })); // not the current tree
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /edited after the run|current tree/);
  });

  it('same fingerprint but a fixable-bug testId triaged AFTER the run → 1 (STALE, Decision 9)', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { boundTestIds: [] }); // the run recorded an empty bound set
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', 'x.test.mjs#some case')); // a NEW triage
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /triaged after the run|testId set/);
  });

  it('a changed unsupported-source file → 1, fail closed (never vouched for)', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { unsupported: ['typed.ts'] });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /unsupported/);
  });

  it('an unresolvable bound testId → 1', () => {
    const { root } = makeRepo();
    bindIds(root, 'x.test.mjs#p');
    const entry = v2Entry('x.test.mjs#p', { executed: 0, greens: 0, reds: 0, timeouts: 0, fileHash: null, resolvable: false, baselineGreen: false });
    seedCurrentGreen(root, { boundTestIds: ['x.test.mjs#p'], testIds: [entry] });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /unresolvable/);
  });

  it('a red-baseline bound test → 1', () => {
    const { root } = makeRepo();
    bindIds(root, 'x.test.mjs#p');
    const entry = v2Entry('x.test.mjs#p', { greens: 0, reds: 3, resolvable: true, baselineGreen: false });
    seedCurrentGreen(root, { boundTestIds: ['x.test.mjs#p'], testIds: [entry] });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /red baseline/);
  });

  it('a run whose probe set omits a bound test fails closed', () => {
    // codex R1 (round 2) fold: boundTestIds matches the review ledger, but the run recorded NO probe
    // results for them — proving "0 red tests" over an EMPTY probe set proves nothing. Fail closed.
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', 'x.test.mjs#p'));
    seedCurrentGreen(root, { boundTestIds: ['x.test.mjs#p'], testIds: [] });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /probe set does not match/);
  });

  it('an uncovered changed line → 1, naming file:line', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { coverage: { uncoveredChanged: [{ file: 'lib.mjs', line: 5 }] } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /uncovered changed line/);
    assert.match(r.stdout, /lib\.mjs:5/);
  });

  it('a file absent from coverage → 1, named at file level', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { coverage: { uncoveredChanged: [{ file: 'orphan.mjs', line: null }] } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /orphan\.mjs/);
  });

  // v1 ships NO mutation (the mutation half was shelved): the shipped runner only ever writes the
  // reserved empty shape, so a current record carrying ANY mutation data was not produced by this
  // runner version (forged, or a version-skewed ledger) — fail closed, never vouch for a signal v1
  // cannot have computed (a survivors-only check would silently PASS killed/skipped counts).
  it('a record carrying mutation data with 0 survivors → 1 (v1 ships no mutation — fail closed)', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { mutation: { total: 10, killed: 7, survived: [], skipped: 3, killSetBasis: 'bound' } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /v1 ships no mutation/);
  });

  it('a record carrying mutation data with survivors → 1 (the same v1 empty-shape rule)', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { mutation: { total: 3, killed: 2, survived: ['lib.mjs:5:9:cmp-eq'], skipped: 0, killSetBasis: 'bound' } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /v1 ships no mutation/);
  });

  // The reserved shape is the exact key SET, not just empty known values — an extra key smuggles
  // mutation data past a fields-only check (a forged/version-skewed record must not pass).
  it('a mutation object with an extra key (known fields empty) → 1 (exact reserved shape enforced)', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null, operators: ['cmp-eq'] } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /v1 ships no mutation/);
  });

  it('a malformed result-ledger line → 1, fail closed', () => {
    const { root } = makeRepo();
    writeFileSync(RESULTS(root), '{not json\n');
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /malformed/);
  });

  it('a malformed review-ledger line → 1, fail closed', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root);
    writeFileSync(REVIEW(root), '{not json\n');
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /malformed/);
  });
});

// ── the red-proof chain (BUGFREE-1: receipt → order → N/N green → custody, D5/D6) ────────────────

describe('fold-completeness --check — red-proof enforcement', () => {
  const ID = 'x.test.mjs#p';
  const H1 = '1'.repeat(64);
  const H2 = '2'.repeat(64);
  // A green v2 entry whose hash is the CURRENT file content (the run is fingerprint-bound).
  const greenEntry = (id, hash) => v2Entry(id, { fileHash: hash });
  const boundGreenRun = (root, id, hash, over = {}) =>
    currentSegRun(root, { boundTestIds: [id], testIds: [greenEntry(id, hash)], ...over });

  it('a loop holding ONLY pre-v3 records → 1 naming the schema upgrade (D7 legacy: v1 never enters a segment)', () => {
    const { root } = makeRepo();
    seedResult(root, runRecord({ fingerprint: computeTreeFingerprint(root) }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /pre-v3 records/);
    assert.match(r.stdout, /run fold-completeness-run/);
  });

  it('a green bound test with NO observed-red receipt → 1, naming the exact --red command', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    seedResults(root, boundGreenRun(root, ID, H1));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /no observed-red receipt/);
    assert.match(r.stdout, new RegExp(`--red "${ID.replace('.', '\\.')}"`));
  });

  it('a receipt minted AFTER the loop’s latest run → 1 (anti-post-hoc), naming the fresh-run recovery', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    seedResults(root, boundGreenRun(root, ID, H1), redProbe({ testId: ID, fileHash: H1 }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /AFTER the loop's latest run|post-hoc/);
    assert.match(r.stdout, /fold-completeness-run/);
  });

  it('receipt before the run + matching custody hash → 0 (the honest red→fix→green order)', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    seedResults(root, redProbe({ testId: ID, fileHash: H1 }), boundGreenRun(root, ID, H1));
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stdout);
  });

  it('a mixed green-side (not N/N) → 1 QUARANTINE naming the testId and the counts', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    const mixed = v2Entry(ID, { greens: 2, reds: 1, resolvable: true, baselineGreen: false });
    seedResults(root, redProbe({ testId: ID, fileHash: H1 }), currentSegRun(root, { boundTestIds: [ID], testIds: [mixed] }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /QUARANTINE/);
    assert.match(r.stdout, /2 green \/ 1 red/);
    assert.match(r.stdout, new RegExp(ID.replace('.', '\\.')));
  });

  it('a timed-out probe run on the green side → 1 QUARANTINE', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    const timed = v2Entry(ID, { greens: 2, reds: 0, timeouts: 1, resolvable: false, baselineGreen: false });
    seedResults(root, redProbe({ testId: ID, fileHash: H1 }), currentSegRun(root, { boundTestIds: [ID], testIds: [timed] }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /QUARANTINE/);
  });

  it('custody mismatch (test edited after its observed red) → 1, naming re-observe vs override recovery', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    seedResults(root, redProbe({ testId: ID, fileHash: H1 }), boundGreenRun(root, ID, H2));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /custody broken/);
    assert.match(r.stdout, /re-observe red/);
    assert.match(r.stdout, /red-proof override/);
  });

  it('the append-second-test flow passes WITHOUT an override (the second red re-attests the file)', () => {
    const { root } = makeRepo();
    const A = 'x.test.mjs#first case';
    const B = 'x.test.mjs#second case';
    bindIds(root, A, B);
    seedResults(
      root,
      redProbe({ testId: A, fileHash: H1 }), // A observed red at H1
      redProbe({ testId: B, fileHash: H2 }), // B appended to the same file → observed red at H2
      currentSegRun(root, { boundTestIds: [A, B].sort(), testIds: [greenEntry(A, H2), greenEntry(B, H2)] }),
    );
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stdout);
  });

  it('an UNBOUND same-file receipt does NOT restore custody (D5 eligibility, codex R3)', () => {
    const { root } = makeRepo();
    bindIds(root, ID); // only ID is bound
    seedResults(
      root,
      redProbe({ testId: ID, fileHash: H1 }),
      redProbe({ testId: 'x.test.mjs#throwaway', fileHash: H2 }), // NOT in the bound set
      boundGreenRun(root, ID, H2),
    );
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /custody broken/);
  });

  it('a POST-RUN same-file receipt does NOT restore custody (D5 eligibility, codex R3)', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    seedResults(
      root,
      redProbe({ testId: ID, fileHash: H1 }),
      boundGreenRun(root, ID, H2),
      redProbe({ testId: ID, fileHash: H2 }), // minted after the run — a fresh run must follow
    );
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /custody broken/);
  });

  // The D5 same-file residual, CHARACTERIZED (codex R2 triage): weakening an ALREADY-GREEN test
  // behind a newer same-file receipt passes through — post-green tamper is the self-discipline
  // boundary AD-045/AD-046 already state. This test documents exactly that pass-through.
  it('characterization: a weakened already-green test behind a newer same-file receipt passes (stated residual)', () => {
    const { root } = makeRepo();
    const A = 'x.test.mjs#first case';
    const B = 'x.test.mjs#second case';
    bindIds(root, A, B);
    seedResults(
      root,
      redProbe({ testId: A, fileHash: H1 }), // A honestly red at H1
      redProbe({ testId: B, fileHash: H2 }), // file edited (A weakened + B added) → B red at H2
      currentSegRun(root, { boundTestIds: [A, B].sort(), testIds: [greenEntry(A, H2), greenEntry(B, H2)] }),
    );
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, 'the pass-through IS the documented residual');
  });

  it('interaction truth-table over {receipt, order, green-N/N, custody} → verdict', () => {
    const rows = [
      // [receipt?, orderOk?, greenNN?, custodyOk?] → [exitCode, reasonRe]
      [[false, null, true, null], [1, /no observed-red receipt/]],
      [[true, false, true, null], [1, /AFTER the loop's latest run/]],
      [[true, true, false, null], [1, /QUARANTINE/]],
      [[true, true, true, false], [1, /custody broken/]],
      [[true, true, true, true], [0, /PASS|fold-completeness verified/]],
    ];
    for (const [[receipt, orderOk, greenNN, custodyOk], [code, re]] of rows) {
      const { root } = makeRepo();
      bindIds(root, ID);
      const entry = greenNN
        ? greenEntry(ID, custodyOk === false ? H2 : H1)
        : v2Entry(ID, { greens: 1, reds: 2, resolvable: true, baselineGreen: false, fileHash: H1 });
      const run = currentSegRun(root, { boundTestIds: [ID], testIds: [entry] });
      const records = [];
      if (receipt && orderOk !== false) records.push(redProbe({ testId: ID, fileHash: H1 }));
      records.push(run);
      if (receipt && orderOk === false) records.push(redProbe({ testId: ID, fileHash: H1 }));
      seedResults(root, ...records);
      const r = check(root);
      done(root);
      assert.equal(r.code, code, `row ${JSON.stringify([receipt, orderOk, greenNN, custodyOk])}: ${r.stdout}`);
      assert.match(r.stdout, re, `row ${JSON.stringify([receipt, orderOk, greenNN, custodyOk])}`);
    }
  });

  it('a pre-tamper v2 run as the loop’s only record → 1 naming the schema upgrade (it never enters a segment)', () => {
    const { root } = makeRepo();
    const rec = segRun({ schema: 2, base: undefined, fingerprint: computeTreeFingerprint(root) });
    delete rec.tamper; // the pre-tamper v2 runner shape — readable, never a segment member
    seedResult(root, rec);
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /pre-v3 records/);
    assert.match(r.stdout, /run fold-completeness-run/);
  });

  it('a tampered test-surface file with NO override → 1 naming the file and the override recovery', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { tamper: { tampered: ['x.test.mjs'] } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /tampered test-surface file/);
    assert.match(r.stdout, /x\.test\.mjs/);
    assert.match(r.stdout, /oracle-change/);
  });

  it('a recorded oracle-change override lifts EXACTLY the named files → 0', () => {
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), oracleOverrideLine('demo-plan', ['x.test.mjs']));
    seedCurrentGreen(root, { tamper: { tampered: ['x.test.mjs'] } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stdout);
  });

  it('a tampered file OUTSIDE the override set still fails, naming only the uncovered file', () => {
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), oracleOverrideLine('demo-plan', ['x.test.mjs']));
    seedCurrentGreen(root, { tamper: { tampered: ['x.test.mjs', 'y.spec.js'] } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /y\.spec\.js/);
    assert.doesNotMatch(r.stdout, /x\.test\.mjs,|: x\.test\.mjs/);
  });

  it('a red-proof override waives receipt + custody for EXACTLY the named testId (D7) → 0', () => {
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', ID) + redProofOverrideLine('demo-plan', ID));
    // green N/N, NO red-probe receipt anywhere — the override replaces the proof.
    seedResults(root, boundGreenRun(root, ID, H1));
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stdout);
  });

  it('a red-proof override never converts QUARANTINE (no override lane for flaky probes)', () => {
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', ID) + redProofOverrideLine('demo-plan', ID));
    const mixed = v2Entry(ID, { greens: 2, reds: 1, resolvable: true, baselineGreen: false });
    seedResults(root, currentSegRun(root, { boundTestIds: [ID], testIds: [mixed] }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /QUARANTINE/);
  });

  it('a red-proof override for a DIFFERENT testId waives nothing', () => {
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', ID) + redProofOverrideLine('demo-plan', 'other.test.mjs#q'));
    seedResults(root, boundGreenRun(root, ID, H1));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /no observed-red receipt/);
  });

  it('--status renders the v2 per-testId dimensions (verdict + counts + receipts)', () => {
    const { root } = makeRepo();
    bindIds(root, ID);
    seedResults(root, redProbe({ testId: ID, fileHash: H1 }), boundGreenRun(root, ID, H1));
    const r = main(['--status'], { cwd: root, env: envFor(root), detect: detect() });
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /3\/3|✓/);
    assert.match(r.stdout, /red-probe receipt/);
    assert.match(r.stdout, /PASS/);
  });
});

// ── the SEGMENT scope (BUGFREE-2 / AD-048, D7): custody obligations close with the commit ────────

describe('fold-completeness --check — segment scope (D7)', () => {
  const ID = 'x.test.mjs#p';
  const H1 = '1'.repeat(64);
  const H2 = '2'.repeat(64);
  const greenEntry = (id, hash) => v2Entry(id, { fileHash: hash });

  it('the custody-churn regression: a custody file edited in a LATER segment no longer fails the CLOSED earlier segment — no override needed', () => {
    const { root, g } = makeRepo({ pending: false });
    const baseA = CURRENT_BASE;
    // Segment A: the fold happened honestly — triage binds ID, red observed, the run green.
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', ID));
    const segARecords = [
      redProbe({ testId: ID, fileHash: H1, base: baseA }),
      segRun({ base: baseA, fingerprint: 'a'.repeat(64), boundTestIds: [ID], testIds: [greenEntry(ID, H1)] }),
    ];
    seedResults(root, ...segARecords);
    // The phase COMMITS — the segment closes; the loop continues on a new base.
    writeFileSync(join(root, 'phase-a.txt'), 'shipped\n');
    g('add', '-A');
    g('commit', '-qm', 'phase A shipped');
    const baseB = g('rev-parse', 'HEAD').stdout.trim();
    // The NEXT phase edits the custody file — pre-AD-048 this forced a red-proof waiver (4 of
    // BUGFREE-1's 5 overrides were exactly this class).
    writeFileSync(join(root, 'x.test.mjs'), 'extended by the later phase\n');
    // A fresh segment-B run over the new surface: the bound set at baseB is EMPTY (the fold closed).
    seedResults(root, ...segARecords, segRun({ base: baseB, fingerprint: computeTreeFingerprint(root), boundTestIds: [], testIds: [] }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, `the closed segment's custody must not bite: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /custody|red-proof/, 'no waiver ceremony for a closed segment');
  });

  it('the SAME edit within ONE segment still demands custody (the intra-segment half stays honest)', () => {
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', ID));
    // The receipt attests H1; the file then changed (the run re-hashed it as H2) — same base.
    seedResults(root, redProbe({ testId: ID, fileHash: H1 }), currentSegRun(root, { boundTestIds: [ID], testIds: [greenEntry(ID, H2)] }));
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /custody broken/);
  });

  it('a cross-segment fold still demands red-proof: a receipt from the PREVIOUS segment never satisfies the current one (the D7 residual, pinned)', () => {
    const { root, g } = makeRepo({ pending: false });
    const baseA = CURRENT_BASE;
    const receiptA = redProbe({ testId: ID, fileHash: H1, base: baseA }); // red observed in segment A
    writeFileSync(join(root, 'phase-a.txt'), 'shipped\n');
    g('add', '-A');
    g('commit', '-qm', 'phase A shipped');
    const baseB = g('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(root, 'pending.txt'), 'dirty at B\n');
    // The fix lands in segment B: the triage binds ID HERE, but the red was observed in A.
    writeFileSync(REVIEW(root), `${JSON.stringify({ schema: 4, loop: 'demo-plan', activity: 'plan-execution', kind: 'triage', round: 1, base: baseB, fingerprint: 'b'.repeat(64), classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId: ID, note: '' }], timestamp: 't' })}\n`);
    seedResults(root, receiptA, segRun({ base: baseB, fingerprint: computeTreeFingerprint(root), boundTestIds: [ID], testIds: [greenEntry(ID, H1)] }));
    const noOverride = check(root);
    assert.equal(noOverride.code, 1);
    assert.match(noOverride.stdout, /no observed-red receipt/, 'the other segment’s receipt is closed history');
    // The loud escape stays the recorded red-proof override (loop-scoped, AD-047 semantics).
    writeFileSync(REVIEW(root), readFileSync(REVIEW(root), 'utf8') + redProofOverrideLine('demo-plan', ID));
    const withOverride = check(root);
    done(root);
    assert.equal(withOverride.code, 0, withOverride.stdout);
  });

  it('runs of ANOTHER segment are invisible: a current-fingerprint run at the WRONG base never satisfies the gate', () => {
    const { root } = makeRepo();
    seedResult(root, segRun({ base: 'f'.repeat(40), fingerprint: computeTreeFingerprint(root) })); // right tree, wrong segment
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /no fold-completeness run recorded for the current segment/);
  });
});

// ── result schema v3 — the D2 quartet for the segment frame ──────────────────────────────────────

describe('result schema v3 — the segment frame (D2 quartet)', () => {
  it('a v3 run/red-probe with base validates; base: null (unborn branch) validates', () => {
    for (const rec of [segRun({ base: 'h'.repeat(40) }), redProbe({ base: 'h'.repeat(40) }), segRun({ base: null })]) {
      const v = validateRunRecord(rec);
      assert.equal(v.ok, true, v.reason);
    }
  });

  it('a v3 record with a MISSING base is rejected naming base (i: the new surface is required on v3)', () => {
    const rec = segRun({ base: 'h'.repeat(40) });
    delete rec.base;
    const v = validateRunRecord(rec);
    assert.equal(v.ok, false);
    assert.match(v.reason, /base/);
  });

  it('base on a v1/v2 record is rejected — an old record never grows new surface (i)', () => {
    for (const rec of [runRecord({ base: 'h'.repeat(40) }), segRun({ schema: 2, base: 'h'.repeat(40) })]) {
      const v = validateRunRecord(rec);
      assert.equal(v.ok, false, `schema ${rec.schema} must reject base`);
      assert.match(v.reason, /base is a v3 frame field/);
    }
  });

  it('a mixed v1 + v2 + v3 ledger reads back malformed: 0 (ii + iii: old records stay valid)', () => {
    const v1 = runRecord();
    const v2 = segRun({ schema: 2, base: undefined });
    const v3run = segRun({ base: 'h'.repeat(40) });
    const v3probe = redProbe({ base: 'h'.repeat(40) });
    const lines = [v1, v2, v3run, v3probe].map((r) => JSON.stringify(r)).join('\n');
    const { records, malformed, malformedReasons } = readResults('X', () => lines);
    assert.equal(malformed, 0, malformedReasons.join('; '));
    assert.equal(records.length, 4);
  });
});

describe('the checker HELP states the segment contract (codex Phase-3 R1 — no doc-vs-code drift)', () => {
  it('the checker HELP states the segment contract', () => {
    const r = main(['--help'], { cwd: '/tmp', env: {}, detect: detect() });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /segment/i, 'the HELP must name the segment scope');
    assert.match(r.stdout, /base/, 'the HELP must name the base frame');
    assert.doesNotMatch(r.stdout, /receipt in this loop/, 'the loop-scoped receipt wording is the pre-v3 contract');
  });
});

// ── --status render + decideCheck purity ─────────────────────────────────────────────────────────

describe('fold-completeness --status', () => {
  it('renders the resolved recipe, plan-in-flight, and the check verdict', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root);
    const r = main(['--status'], { cwd: root, env: envFor(root), detect: detect() });
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /fold-completeness/);
    assert.match(r.stdout, /demo-plan/);
    assert.match(r.stdout, /PASS/);
  });
});

// ── structural import-split (mirrors the review-ledger read/write split) ─────────────────────────

describe('import-split guard — the checker never imports the runner', () => {
  it('fold-completeness.mjs source contains no import of fold-completeness-run', () => {
    const src = readFileSync(join(HERE, 'fold-completeness.mjs'), 'utf8');
    const importsRunner = /from\s+['"][^'"]*fold-completeness-run/.test(src) || /import\(\s*['"][^'"]*fold-completeness-run/.test(src);
    assert.ok(!importsRunner, 'the read-only checker must not import the runner');
  });
  it('procedures.mjs + review-state.mjs import neither fold-completeness tool', () => {
    for (const f of ['procedures.mjs', 'review-state.mjs']) {
      const src = readFileSync(join(HERE, f), 'utf8');
      assert.ok(!/from\s+['"][^'"]*fold-completeness/.test(src), `${f} must not import a fold-completeness tool`);
    }
  });
  it('validateRunRecord + decideCheck are exported (the schema + decision are the read module’s API)', () => {
    assert.equal(typeof validateRunRecord, 'function');
    assert.equal(typeof decideCheck, 'function');
  });
});

// ── result schema v2 — per-version validation (D2: kind discriminator, v1 tolerated) ─────────────

describe('result schema v2 — per-version validation (D2)', () => {
  it('a v1 record (no kind, single-run fields) stays valid — tolerance', () => {
    assert.equal(validateRunRecord(runRecord()).ok, true);
    // …including a populated v1 testIds entry (the AD-046 single-run shape).
    const v1Entry = { id: 'x.test.mjs#p', resolvable: true, executed: 1, baselineGreen: true };
    assert.equal(validateRunRecord(runRecord({ testIds: [v1Entry] })).ok, true);
    // …and each malformed v1-entry field still fails by name under the v1 rules.
    const cases = [
      [{ ...v1Entry, id: '' }, /needs an id/],
      [{ ...v1Entry, resolvable: 'yes' }, /boolean resolvable/],
      [{ ...v1Entry, executed: -1 }, /executed must be a non-negative integer/],
    ];
    for (const [entry, re] of cases) {
      const v = validateRunRecord(runRecord({ testIds: [entry] }));
      assert.equal(v.ok, false);
      assert.match(v.reason, re);
    }
  });

  it('a malformed mutation shape fails by name in both versions', () => {
    for (const rec of [runRecord({ mutation: { total: 'x' } }), segRun({ mutation: { total: 'x' } })]) {
      const v = validateRunRecord(rec);
      assert.equal(v.ok, false);
      assert.match(v.reason, /mutation must be/);
    }
    const bad = validateRunRecord(segRun({ mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: 42 } }));
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /killSetBasis/);
  });

  it('a v1 record carrying kind fails closed by name (kind is a v2 discriminator)', () => {
    const v = validateRunRecord(runRecord({ kind: 'run' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /v1 record must not carry kind/);
  });

  it('an unknown/forged schema fails closed by name', () => {
    for (const s of [0, 5, '2', null]) {
      const v = validateRunRecord(runRecord({ schema: s }));
      assert.equal(v.ok, false, `schema ${JSON.stringify(s)} must fail`);
      assert.match(v.reason, /schema must be one of 1, 2, 3, 4/);
    }
  });

  it('a v2 record needs the kind discriminator ("run" | "red-probe" | "reattest")', () => {
    const missing = validateRunRecord(runRecord({ schema: 2 }));
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /kind must be "run", "red-probe", or "reattest"/);
    const bogus = validateRunRecord(runRecord({ schema: 2, kind: 'probe' }));
    assert.equal(bogus.ok, false);
    assert.match(bogus.reason, /kind must be "run", "red-probe", or "reattest"/);
  });

  it('a v2 run with per-testId rerun counts + content hash validates', () => {
    const v = validateRunRecord(segRun({ boundTestIds: ['x.test.mjs#p'], testIds: [v2Entry('x.test.mjs#p')] }));
    assert.equal(v.ok, true, v.reason);
  });

  it('a v2 run entry with a null fileHash (unresolvable file) validates', () => {
    const entry = v2Entry('x.test.mjs#p', { executed: 0, greens: 0, reds: 0, timeouts: 0, fileHash: null, resolvable: false, baselineGreen: false });
    assert.equal(validateRunRecord(segRun({ testIds: [entry] })).ok, true);
  });

  it('v2 run entries: each malformed field fails by name', () => {
    const cases = [
      [{ runs: 0 }, /runs must be a positive integer/],
      [{ runs: 2.5 }, /runs must be a positive integer/],
      [{ greens: 'x' }, /rerun counts/],
      [{ greens: -1 }, /rerun counts/],
      [{ greens: 2, reds: 2 }, /exceed runs/],
      [{ fileHash: 'nothex' }, /fileHash must be null or a 64-hex/],
      [{ resolvable: false }, /resolvable must equal/],
      [{ greens: 0, reds: 3, baselineGreen: true, resolvable: true }, /baselineGreen must equal/],
    ];
    for (const [over, re] of cases) {
      const v = validateRunRecord(segRun({ testIds: [v2Entry('x.test.mjs#p', over)] }));
      assert.equal(v.ok, false, `entry ${JSON.stringify(over)} must fail`);
      assert.match(v.reason, re);
    }
  });

  // codex R1 (BUGFREE-1 live loop): a forged N/N verdict with zero-match evidence must not validate —
  // greens/reds imply at least one matched (executed) test result.
  it('executed must be positive when any run resolved', () => {
    const forged = v2Entry('x.test.mjs#p', { executed: 0 });
    const v = validateRunRecord(segRun({ testIds: [forged] }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /executed must be positive when a run resolved/);
  });

  it('a valid red-probe receipt validates', () => {
    assert.equal(validateRunRecord(redProbe()).ok, true);
  });

  it('the tamper field: absent stays readable on a v2 record ONLY (a v3 run always records it); a bad shape fails by name', () => {
    assert.equal(validateRunRecord(segRun({ base: 'h'.repeat(40) })).ok, true); // the fixture carries a valid empty surface
    const absentV2 = segRun({ schema: 2, base: undefined });
    delete absentV2.tamper;
    assert.equal(validateRunRecord(absentV2).ok, true, 'a pre-tamper v2 record stays readable (never retroactively malformed)');
    const absentV3 = segRun({ base: 'h'.repeat(40) });
    delete absentV3.tamper;
    const v3 = validateRunRecord(absentV3);
    assert.equal(v3.ok, false, 'a v3 run without a tamper surface is not this runner’s output');
    assert.match(v3.reason, /tamper/);
    const bad = validateRunRecord(segRun({ base: 'h'.repeat(40), tamper: { tampered: 'x' } }));
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /tamper/);
  });

  it('red-probe records: each malformed field fails by name', () => {
    const cases = [
      [{ testId: 'no-separator' }, /red-probe testId/],
      [{ testId: '#nofile' }, /red-probe testId/],
      [{ fileHash: null }, /red-probe fileHash must be a 64-hex/],
      [{ fileHash: 'short' }, /red-probe fileHash must be a 64-hex/],
      [{ runs: 0 }, /red-probe runs must be a positive integer/],
      [{ reds: 2 }, /reds must equal runs/],
      [{ loop: '' }, /missing loop/],
      [{ fingerprint: 42 }, /fingerprint/],
      [{ timestamp: '' }, /missing timestamp/],
    ];
    for (const [over, re] of cases) {
      const v = validateRunRecord(redProbe(over));
      assert.equal(v.ok, false, `red-probe ${JSON.stringify(over)} must fail`);
      assert.match(v.reason, re);
    }
  });
});

// ── kind-aware selectors (codex R2: a red-probe appended after a run is never the "latest run") ──

describe('kind-aware result selectors', () => {
  it('isRunRecord: v1 records and v2 kind:"run" are runs; red-probes are not', () => {
    assert.equal(isRunRecord(runRecord()), true);
    assert.equal(isRunRecord(segRun()), true);
    assert.equal(isRunRecord(redProbe()), false);
  });

  it('isRedProbeRecord requires schema >= 2 AND kind red-probe', () => {
    assert.equal(isRedProbeRecord(redProbe()), true);
    assert.equal(isRedProbeRecord(segRun()), false);
    assert.equal(isRedProbeRecord(runRecord()), false);
  });

  it('latestRunRecord over [run, red-probe] picks the run (not the appended probe)', () => {
    const run = segRun();
    const sel = latestRunRecord([run, redProbe()]);
    assert.equal(sel.index, 0);
    assert.equal(sel.record, run);
  });

  it('latestRunRecord over [red-probe, run] picks the run', () => {
    const run = segRun();
    const sel = latestRunRecord([redProbe(), run]);
    assert.equal(sel.index, 1);
    assert.equal(sel.record, run);
  });

  it('latestRunRecord treats a v1 record as a run', () => {
    const v1 = runRecord();
    const sel = latestRunRecord([v1, redProbe()]);
    assert.equal(sel.index, 0);
    assert.equal(sel.record, v1);
  });

  it('latestRunRecord over probes only (no run yet) is null', () => {
    assert.equal(latestRunRecord([redProbe()]), null);
    assert.equal(latestRunRecord([]), null);
  });
});

// ── the D4 verdict algebra: RED/GREEN are N/N verdicts; mixed/timeout = QUARANTINE ────────────────

describe('probeVerdict — the D4 verdict-algebra truth table', () => {
  const V = (greens, reds, timeouts, runs = 3) => probeVerdict({ runs, greens, reds, timeouts });

  it('GREEN and RED are N/N verdicts only', () => {
    assert.equal(V(3, 0, 0), 'green');
    assert.equal(V(0, 3, 0), 'red');
    assert.equal(probeVerdict({ runs: 1, greens: 1, reds: 0, timeouts: 0 }), 'green');
    assert.equal(probeVerdict({ runs: 1, greens: 0, reds: 1, timeouts: 0 }), 'red');
  });

  it('any mixed green/red outcome is QUARANTINE (never converts)', () => {
    assert.equal(V(2, 1, 0), 'quarantine');
    assert.equal(V(1, 2, 0), 'quarantine');
    assert.equal(V(1, 1, 0), 'quarantine'); // 1 run unresolved + mixed — still quarantine
  });

  it('any timeout taints the verdict — QUARANTINE, even beside N-1 greens or reds', () => {
    assert.equal(V(2, 0, 1), 'quarantine');
    assert.equal(V(0, 2, 1), 'quarantine');
    assert.equal(V(0, 0, 3), 'quarantine'); // all-timeout: neither red nor green
  });

  it('nothing resolved on any run → unresolvable; a PARTIAL resolution is quarantine', () => {
    assert.equal(V(0, 0, 0), 'unresolvable');
    assert.equal(V(1, 0, 0), 'quarantine'); // resolved once, unresolved twice — flaky resolution
    assert.equal(V(0, 1, 0), 'quarantine'); // a partial red is NOT an honest N/N red
  });

  it('runs=0 is defensively unresolvable, never green (a forged zero-run record proves nothing)', () => {
    assert.equal(probeVerdict({ runs: 0, greens: 0, reds: 0, timeouts: 0 }), 'unresolvable');
  });
});
