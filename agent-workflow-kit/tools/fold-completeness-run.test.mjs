// fold-completeness-run.test.mjs — spec-first for the M3 runner (AD-046, DEBT-TEST-COMPLETENESS).
// Phase 2 scope: changed-surface classification (Decision 5, closed rule), M3a coverage mapping
// (Decision 6, innermost-range-wins), the testId probe + baseline (Decision 3 / 10), the machine-only
// result record, the restore + no-artifacts invariants (Decision 8), and loop derivation. The
// mutation half (M3b) is shelved, not shipped — here `mutation` stays the reserved empty shape.
//
// Pure helpers are unit-tested directly; the integration cases drive the real runner over hermetic
// git fixture repos (the review-state.test.mjs makeRepo idiom) with REAL `node --test` subprocesses
// under NODE_V8_COVERAGE, so the coverage + probe signals are exercised end-to-end, never mocked.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  runFoldCompleteness,
  classifyChangedPath,
  parseUnifiedDiff,
  lineStartOffsets,
  effectiveCount,
  computeUncoveredLines,
  parseProbeOutput,
  defaultBoundArgv,
  resolveBoundArgv,
  computeChangedSurface,
  main,
  FOLD_RUN_STOP,
} from './fold-completeness-run.mjs';
import { computeFingerprintPayload, computeTreeFingerprint } from './review-state.mjs';
import { RESULT_SCHEMA_VERSION, validateRunRecord, readResults, resolveResultsPath } from './fold-completeness.mjs';

// ── Decision 5: the closed changed-path classification rule ──────────────────────────────────────

describe('classifyChangedPath — the closed extension rule (Decision 5)', () => {
  it('.mjs / .cjs / .js (non-test) → assessable', () => {
    for (const p of ['tools/a.mjs', 'x/b.cjs', 'lib/c.js']) assert.equal(classifyChangedPath(p), 'assessable');
  });
  it('*.test.* / *.spec.* → excluded-test (never assessed)', () => {
    for (const p of ['a.test.mjs', 'b.spec.js', 'deep/c.test.cjs', 'd.spec.ts']) assert.equal(classifyChangedPath(p), 'excluded-test');
  });
  it('.ts / .tsx / .jsx / .mts / .cts (non-test) → unsupported source', () => {
    for (const p of ['a.ts', 'b.tsx', 'c.jsx', 'd.mts', 'e.cts']) assert.equal(classifyChangedPath(p), 'unsupported');
  });
  it('everything else → out-of-domain', () => {
    for (const p of ['README.md', 'docs/x.json', 'ci.yml', 'run.sh', 'noext']) assert.equal(classifyChangedPath(p), 'out-of-domain');
  });
});

// ── parseUnifiedDiff: new-side changed line numbers from a -U0 diff ───────────────────────────────

describe('parseUnifiedDiff — new-side line ranges (git diff -U0)', () => {
  const DIFF = [
    'diff --git a/lib.mjs b/lib.mjs',
    'index 1111111..2222222 100644',
    '--- a/lib.mjs',
    '+++ b/lib.mjs',
    '@@ -2,0 +3,2 @@ const x = 1;',
    '+added line three',
    '+added line four',
    '@@ -10 +12 @@',
    '+changed line twelve',
    'diff --git a/gone.mjs b/gone.mjs',
    'deleted file mode 100644',
    '--- a/gone.mjs',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-a',
    '-b',
    '-c',
    'diff --git a/only-del.mjs b/only-del.mjs',
    '--- a/only-del.mjs',
    '+++ b/only-del.mjs',
    '@@ -5,2 +4,0 @@',
    '-removed a',
    '-removed b',
  ].join('\n');

  it('derives added/modified new-side lines per file, count-omitted = 1', () => {
    const m = parseUnifiedDiff(DIFF);
    assert.deepEqual(m.get('lib.mjs'), [3, 4, 12]);
  });
  it('a deleted file (+++ /dev/null) contributes nothing', () => {
    assert.equal(parseUnifiedDiff(DIFF).has('gone.mjs'), false);
  });
  it('a deletion-only hunk (+a,0) contributes no new-side lines', () => {
    assert.equal(parseUnifiedDiff(DIFF).has('only-del.mjs'), false);
  });
});

// ── Decision 6: V8 innermost-range-wins → uncovered changed lines ─────────────────────────────────
// The exact fixture whose coverage was captured empirically: classify() called with a positive arg,
// unused() never called. Offsets/ranges are the observed NODE_V8_COVERAGE output.

const SRC = [
  'export const classify = (n) => {', // L1  off 0
  '  if (n > 0) {', //                    L2  off 33
  "    return 'positive';", //            L3  off 48
  '  }', //                               L4  off 71
  "  return 'nonpositive';", //           L5  off 75  (uncovered branch)
  '};', //                                L6  off 99
  'export const unused = () => {', //     L7  off 102
  "  return 'never';", //                 L8  off 132 (uncovered fn body)
  '};', //                                L9  off 150 (uncovered fn close)
  '', //                                  L10 off 153
].join('\n');

// One process where classify(positive) ran and unused() never ran (the captured shape).
const RANGES_P1 = [
  { startOffset: 0, endOffset: 153, count: 1 }, // module ""
  { startOffset: 24, endOffset: 100, count: 1 }, // classify
  { startOffset: 74, endOffset: 99, count: 0 }, // classify else-branch (never taken)
  { startOffset: 124, endOffset: 151, count: 0 }, // unused body
];

describe('effectiveCount — innermost (smallest) containing range wins', () => {
  it('a byte in the nested count-0 branch resolves to 0', () => assert.equal(effectiveCount(RANGES_P1, 77), 0));
  it('a byte in classify but outside the else-branch resolves to 1', () => assert.equal(effectiveCount(RANGES_P1, 52), 1));
  it('a byte only in the module range resolves to 1', () => assert.equal(effectiveCount(RANGES_P1, 5), 1));
  it('a byte in no range resolves to 0 (absent)', () => assert.equal(effectiveCount(RANGES_P1, 9999), 0));
});

describe('computeUncoveredLines — Decision 6 mapping (deterministic, ascending)', () => {
  it('flags exactly the never-executed changed lines; blank lines skipped', () => {
    const uncovered = computeUncoveredLines({
      perProcessRanges: [RANGES_P1],
      sourceText: SRC,
      changedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    assert.deepEqual(uncovered, [5, 8, 9]); // L5 else-branch, L8 body, L9 close of the never-called fn
  });
  it('merges across processes — a line executed by ANY process is covered', () => {
    // A second process where unused() DID run (its body/close become covered) but classify never did.
    const RANGES_P2 = [
      { startOffset: 0, endOffset: 153, count: 1 },
      { startOffset: 24, endOffset: 100, count: 0 }, // classify never entered this process
      { startOffset: 124, endOffset: 151, count: 1 }, // unused ran
    ];
    const uncovered = computeUncoveredLines({
      perProcessRanges: [RANGES_P1, RANGES_P2],
      sourceText: SRC,
      changedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    assert.deepEqual(uncovered, [5]); // L8/L9 now covered by P2; L5 uncovered in both
  });
});

describe('lineStartOffsets — char offset of each line start', () => {
  it('matches the fixture offsets', () => {
    const offs = lineStartOffsets(SRC);
    assert.equal(offs[0], 0);
    assert.equal(offs[4], 75); // L5
    assert.equal(offs[7], 132); // L8
  });
});

// ── Decision 3 / 10: the bound-test probe parser (real TAP shapes) ────────────────────────────────

describe('parseProbeOutput — resolvable + baselineGreen from node:test TAP', () => {
  const FILE = 'lib.test.mjs';
  const matchPass = ['TAP version 13', '# Subtest: outer group', 'ok 1 - outer group', '1..1', '# tests 1', '# pass 1', '# fail 0'].join('\n');
  const matchFail = ['TAP version 13', 'not ok 1 - outer group', '1..1', '# tests 1', '# pass 0', '# fail 1'].join('\n');
  const noMatch = ['TAP version 13', '1..0', `ok 1 - ${FILE}`, '1..1', '# tests 1', '# pass 1', '# fail 0'].join('\n');

  it('a matched passing test → resolvable + baselineGreen', () => {
    assert.deepEqual(parseProbeOutput({ stdout: matchPass, code: 0, fileArg: FILE }), { resolvable: true, executed: 1, baselineGreen: true });
  });
  it('a matched FAILING test → resolvable but baseline red', () => {
    assert.deepEqual(parseProbeOutput({ stdout: matchFail, code: 1, fileArg: FILE }), { resolvable: true, executed: 1, baselineGreen: false });
  });
  it('a nomatch (only the file wrapper) → unresolvable, baseline red', () => {
    assert.deepEqual(parseProbeOutput({ stdout: noMatch, code: 0, fileArg: FILE }), { resolvable: false, executed: 0, baselineGreen: false });
  });
  // codex R1 (round 2) fold: node normalizes the wrapper path ('./x' → 'x', or an absolute path),
  // so a LITERAL desc===fileArg comparison would count the file-wrapper row as a real matched test and
  // falsely report resolvable/green. The wrapper is matched by BASENAME (invariant to ./ / abs / rel).
  it('parseProbeOutput matches the file wrapper by basename', () => {
    const nomatchDotSlash = ['TAP version 13', '1..0', 'ok 1 - lib.test.mjs', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: nomatchDotSlash, code: 0, fileArg: './lib.test.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
    const nomatchAbs = ['TAP version 13', '1..0', 'ok 1 - /tmp/x/lib.test.mjs', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: nomatchAbs, code: 0, fileArg: 'lib.test.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
    // a genuine match is still counted even when fileArg carries a ./ prefix.
    const matchDotSlash = ['TAP version 13', 'ok 1 - real case', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: matchDotSlash, code: 0, fileArg: './lib.test.mjs' }), { resolvable: true, executed: 1, baselineGreen: true });
  });
});

// ── Decision 10: bound-run argv (default node:test shape + the escape hatch) ──────────────────────

describe('bound-run argv (Decision 10)', () => {
  it('the default shape is the shell-free node --test --test-name-pattern form', () => {
    assert.deepEqual(defaultBoundArgv('a/b.test.mjs', 'my pattern'), [
      'node', '--test', '--test-reporter', 'tap', '--test-name-pattern', 'my pattern', 'a/b.test.mjs',
    ]);
  });
  it('AW_FOLD_BOUND_CMD overrides with a JSON argv template ({file}/{pattern} substitution)', () => {
    const tmpl = resolveBoundArgv({ AW_FOLD_BOUND_CMD: '["npx","mocha","-g","{pattern}","{file}"]' });
    assert.deepEqual(tmpl('x.test.js', 'p q'), ['npx', 'mocha', '-g', 'p q', 'x.test.js']);
  });
  it('a malformed AW_FOLD_BOUND_CMD is a typed refusal (never a silent fallback to a shell)', () => {
    assert.throws(() => resolveBoundArgv({ AW_FOLD_BOUND_CMD: 'not json' }), (e) => e.code === FOLD_RUN_STOP);
    assert.throws(() => resolveBoundArgv({ AW_FOLD_BOUND_CMD: '"a string"' }), (e) => e.code === FOLD_RUN_STOP);
  });
});

// ── result-ledger path + schema (owned by the read module; runner imports it) ─────────────────────

describe('resolveResultsPath + validateRunRecord', () => {
  it('AW_FOLD_RESULTS overrides the git-dir default', () => {
    assert.equal(resolveResultsPath('/x', { AW_FOLD_RESULTS: '/tmp/fc.jsonl' }), '/tmp/fc.jsonl');
  });
  it('a machine-only run record validates; a missing field is rejected with a named reason', () => {
    const rec = {
      schema: RESULT_SCHEMA_VERSION, loop: 'demo', fingerprint: 'a'.repeat(64), boundTestIds: [],
      testIds: [], unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] },
      mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null },
      budgets: { mutantsMax: 200, hunkMutantsMax: 25, timeBudgetS: 600 }, timestamp: 't',
    };
    assert.equal(validateRunRecord(rec).ok, true);
    assert.equal(validateRunRecord({ ...rec, coverage: undefined }).ok, false);
    assert.equal(validateRunRecord({ ...rec, loop: '' }).ok, false);
  });
});

// ── integration: the real runner over hermetic git fixture repos ─────────────────────────────────

const gitInit = (root) => {
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  return g;
};

// A clean env with the AW_* overrides pointed at the fixture git dir (deterministic, no host leak).
const fixtureEnv = (root, extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl'), AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl'), ...extra };
};

// A valid v2 fixable-bug triage line (the runner reads its testId; the round it references is
// irrelevant to bound-testId collection). loop must match the in-flight plan stem.
const triageLine = (loop, testId) =>
  `${JSON.stringify({ schema: 2, loop, activity: 'plan-execution', kind: 'triage', round: 1, fingerprint: 'a'.repeat(64), classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId, note: '' }], timestamp: 't' })}\n`;

describe('computeChangedSurface — tracked (git diff HEAD) + untracked classification', () => {
  it('derives changed lines for a modified tracked file and classifies each class', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-surface-'));
    const g = gitInit(root);
    writeFileSync(join(root, 'keep.mjs'), 'export const a = 1;\nexport const b = 2;\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    // modify the tracked file: append a third line (new-side line 3).
    writeFileSync(join(root, 'keep.mjs'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    // untracked additions across classes:
    writeFileSync(join(root, 'new.ts'), 'export const t = 1;\n'); // unsupported
    writeFileSync(join(root, 'doc.md'), '# doc\n'); // out-of-domain
    writeFileSync(join(root, 'x.test.mjs'), 'export const ignored = 1;\n'); // excluded-test
    const surface = computeChangedSurface(root);
    assert.deepEqual(surface.assessable.get('keep.mjs'), [3], 'the appended line is the changed line');
    assert.deepEqual(surface.unsupported, ['new.ts']);
    assert.deepEqual(surface.outOfDomain, ['doc.md']);
    assert.equal(surface.assessable.has('x.test.mjs'), false, 'test files are excluded');
    rmSync(root, { recursive: true, force: true });
  });

  // codex R2 (round 3) fold: a symlinked/non-regular *.mjs in the changed set must NEVER be followed
  // or read (it could read outside the tree or HANG on a FIFO/device). It is routed to `unsupported`
  // (fail closed) — the signal will not vouch for source it cannot safely assess.
  it('a symlinked assessable path is not followed', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-symlink-'));
    const g = gitInit(root);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    // an untracked symlink named like assessable source (a leaf symlink, never a regular file).
    symlinkSync('base.txt', join(root, 'evil.mjs'));
    const surface = computeChangedSurface(root);
    assert.equal(surface.assessable.has('evil.mjs'), false, 'a symlinked .mjs is never assessed/read/followed');
    assert.ok(surface.unsupported.includes('evil.mjs'), 'routed to unsupported (fail closed)');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('runFoldCompleteness — rich fixture: surface + M3a coverage + schema + restore', () => {
  it('classifies the changed surface, maps coverage, probes the bound test, writes a machine record, leaves the tree byte-identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-run-'));
    const g = gitInit(root);
    // committed base: the plan-in-flight (single loop) + queue, so they are not "changed".
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    // the dirty (untracked) changed surface across all classes:
    writeFileSync(join(root, 'lib.mjs'), SRC); // assessable, partially covered
    writeFileSync(join(root, 'orphan.mjs'), 'export const y = () => 1;\n'); // assessable, imported by nothing
    writeFileSync(join(root, 'notes.md'), '# notes\n'); // out-of-domain
    writeFileSync(join(root, 'data.json'), '{"a":1}\n'); // out-of-domain
    writeFileSync(join(root, 'typed.ts'), 'export const t: number = 1;\n'); // unsupported
    writeFileSync(
      join(root, 'lib.test.mjs'), // excluded-test — also the suite + the bound test
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { classify } from './lib.mjs';\ntest('classify positive', () => { assert.equal(classify(5), 'positive'); });\n",
    );
    // seed the review ledger with a fixable-bug testId pointing at the passing bound test.
    const boundId = 'lib.test.mjs#classify positive';
    writeFileSync(join(root, '.git', 'rl.jsonl'), triageLine('demo-plan', boundId));

    const env = fixtureEnv(root);
    const before = computeFingerprintPayload(root);
    const beforeFp = computeTreeFingerprint(root);
    const { record } = runFoldCompleteness({ cwd: root, env, suiteCmd: 'node --test --test-reporter tap lib.test.mjs' });
    const after = computeFingerprintPayload(root);
    const afterFp = computeTreeFingerprint(root);

    // surface classification (Decision 5)
    assert.deepEqual(record.unsupported, ['typed.ts']);
    assert.deepEqual(record.outOfDomain, ['data.json', 'notes.md']); // sorted, plan/queue excluded (committed)
    // M3a coverage (Decision 6): the never-executed changed lines named exactly + the file-absent file.
    const uncov = record.coverage.uncoveredChanged;
    assert.ok(uncov.some((u) => u.file === 'lib.mjs' && u.line === 5), 'L5 else-branch uncovered');
    assert.ok(uncov.some((u) => u.file === 'lib.mjs' && u.line === 8), 'L8 body uncovered');
    assert.ok(uncov.some((u) => u.file === 'orphan.mjs' && u.line === null), 'orphan.mjs absent → file-level');
    assert.equal(uncov.some((u) => u.file === 'lib.test.mjs'), false, 'the test file is never assessed');
    // testId probe + baseline (Decision 3)
    assert.deepEqual(record.boundTestIds, [boundId]);
    assert.equal(record.testIds.length, 1);
    assert.deepEqual({ ...record.testIds[0] }, { id: boundId, resolvable: true, executed: 1, baselineGreen: true });
    // machine-only schema + empty mutation (Phase 2)
    assert.equal(record.schema, RESULT_SCHEMA_VERSION);
    assert.equal(record.loop, 'demo-plan');
    assert.match(record.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.mutation, { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null });
    assert.equal(validateRunRecord(record).ok, true);
    // the record is appended to the result ledger and reads back clean.
    const { records, malformed } = readResults(join(root, '.git', 'fc.jsonl'));
    assert.equal(malformed, 0);
    assert.equal(records.length, 1);
    // no-artifacts + restore (Decision 8): the coverage dir lives outside the tree; nothing mutated.
    assert.ok(before.equals(after), 'the fingerprint payload is byte-identical after the run');
    assert.equal(beforeFp, afterFp);

    rmSync(root, { recursive: true, force: true });
  });
});

describe('runFoldCompleteness — testId probe edge cases (Decision 3)', () => {
  it('records unresolvable (missing file + nomatch pattern) and a red baseline, sorted by id', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-probe-'));
    const g = gitInit(root);
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'lib.mjs'), 'export const ok = () => 1;\n'); // a trivially-covered change
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ok } from './lib.mjs';\ntest('green one', () => { assert.equal(ok(), 1); });\ntest('red one', () => { assert.equal(1, 2); });\n",
    );
    const green = 'lib.test.mjs#green one';
    const red = 'lib.test.mjs#red one';
    const nomatch = 'lib.test.mjs#nothing matches this';
    const missing = 'ghost.test.mjs#whatever';
    writeFileSync(
      join(root, '.git', 'rl.jsonl'),
      triageLine('demo-plan', green) + triageLine('demo-plan', red) + triageLine('demo-plan', nomatch) + triageLine('demo-plan', missing),
    );
    const { record } = runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd: 'node --test --test-reporter tap lib.test.mjs' });
    const byId = Object.fromEntries(record.testIds.map((t) => [t.id, t]));
    assert.deepEqual(record.boundTestIds, [green, red, nomatch, missing].sort());
    assert.equal(byId[green].resolvable, true);
    assert.equal(byId[green].baselineGreen, true);
    assert.equal(byId[red].resolvable, true);
    assert.equal(byId[red].baselineGreen, false); // red baseline
    assert.equal(byId[nomatch].resolvable, false); // pattern selects nothing
    assert.equal(byId[missing].resolvable, false); // file does not exist
    rmSync(root, { recursive: true, force: true });
  });
});

describe('fold-completeness-run — CLI main (the plan-execution invocation surface)', () => {
  const oneChangeRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-cli-'));
    const g = gitInit(root);
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'change.mjs'), 'export const z = 1;\n');
    return root;
  };
  it('--help prints usage (exit 0)', () => {
    const r = main(['--help'], { cwd: '/', env: {} });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /fold-completeness-run/);
  });
  it('an unknown argument is a usage error (exit 2)', () => {
    const r = main(['--bogus'], { cwd: '/', env: {} });
    assert.equal(r.code, 2);
  });
  it('records a run and prints the summary line (exit 0)', () => {
    const root = oneChangeRepo();
    const r = main(['--suite', 'true'], { cwd: root, env: fixtureEnv(root) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /recorded a run for loop "demo-plan"/);
  });
  it('surfaces a typed refusal (no plan in flight) as exit 1 on stderr', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-cli-noplan-'));
    const g = gitInit(root);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'change.mjs'), 'export const z = 1;\n');
    const r = main([], { cwd: root, env: fixtureEnv(root, { AW_FOLD_SUITE_CMD: 'true' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no plan in flight/);
  });
});

describe('runFoldCompleteness — loop derivation (Decision: single in-flight plan)', () => {
  const bareRepo = (plans) => {
    const root = mkdtempSync(join(tmpdir(), 'fold-loop-'));
    const g = gitInit(root);
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
    for (const p of plans) writeFileSync(join(root, 'docs', 'plans', p), `# ${p}\n`);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'change.mjs'), 'export const z = 1;\n');
    return root;
  };
  it('0 plans in flight → typed refusal', () => {
    const root = bareRepo([]);
    assert.throws(
      () => runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd: 'true' }),
      (e) => e.code === FOLD_RUN_STOP && /no plan in flight/.test(e.message),
    );
    rmSync(root, { recursive: true, force: true });
  });
  it('>1 plans in flight → typed refusal (ambiguous loop id)', () => {
    const root = bareRepo(['one.md', 'two.md']);
    assert.throws(
      () => runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd: 'true' }),
      (e) => e.code === FOLD_RUN_STOP && /more than one plan/.test(e.message),
    );
    rmSync(root, { recursive: true, force: true });
  });
});
