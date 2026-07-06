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
import { main, decideCheck, validateRunRecord } from './fold-completeness.mjs';
import { computeTreeFingerprint } from './review-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COUNCIL = JSON.stringify({ 'plan-execution': { execute: 'solo', review: 'council' } });
const SOLO = JSON.stringify({ 'plan-execution': { review: 'solo' } });
const READY = 'ready';
const detect = (readiness = READY) => () => [
  { name: 'codex-cli-bridge', readiness },
  { name: 'antigravity-cli-bridge', readiness },
];

// A dirty git fixture with a single in-flight plan (council recipe by default).
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
const fixableTriage = (loop, testId) =>
  `${JSON.stringify({ schema: 2, loop, activity: 'plan-execution', kind: 'triage', round: 1, fingerprint: 'b'.repeat(64), classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId, note: '' }], timestamp: 't' })}\n`;

const check = (root, { readiness = READY, args = ['--check'] } = {}) => main(args, { cwd: root, env: envFor(root), detect: detect(readiness) });
const done = (root) => rmSync(root, { recursive: true, force: true });

// A record that matches the CURRENT tree + an empty review ledger (the all-green baseline).
const seedCurrentGreen = (root, over = {}) => seedResult(root, runRecord({ fingerprint: computeTreeFingerprint(root), ...over }));

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

  it('all green with budget-skipped mutants → 0, the skip STATED', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { mutation: { total: 10, killed: 7, survived: [], skipped: 3, killSetBasis: 'bound' } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skip/i);
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
    seedResult(root, runRecord({ fingerprint: 'c'.repeat(64) })); // not the current tree
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
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', 'x.test.mjs#p'));
    seedCurrentGreen(root, { boundTestIds: ['x.test.mjs#p'], testIds: [{ id: 'x.test.mjs#p', resolvable: false, executed: 0, baselineGreen: false }] });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /unresolvable/);
  });

  it('a red-baseline bound test → 1', () => {
    const { root } = makeRepo();
    writeFileSync(REVIEW(root), fixableTriage('demo-plan', 'x.test.mjs#p'));
    seedCurrentGreen(root, { boundTestIds: ['x.test.mjs#p'], testIds: [{ id: 'x.test.mjs#p', resolvable: true, executed: 1, baselineGreen: false }] });
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

  it('a surviving mutant → 1, naming the stable mutant id', () => {
    const { root } = makeRepo();
    seedCurrentGreen(root, { mutation: { total: 3, killed: 2, survived: ['lib.mjs:5:9:cmp-eq'], skipped: 0, killSetBasis: 'bound' } });
    const r = check(root);
    done(root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /surviving mutant/);
    assert.match(r.stdout, /lib\.mjs:5:9:cmp-eq/);
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
