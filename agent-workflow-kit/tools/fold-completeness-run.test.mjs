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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  runFoldCompleteness,
  runRedProbe,
  classifyChangedPath,
  parseUnifiedDiff,
  parseDiffOldSide,
  unquoteDiffPath,
  lineStartOffsets,
  effectiveCount,
  computeUncoveredLines,
  parseProbeOutput,
  defaultBoundArgv,
  resolveBoundArgv,
  resolveTestFile,
  hashFileBytes,
  budgetsFromEnv,
  computeTamperedTests,
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

  // Node 18/20 EMIT pattern-filtered tests as `ok N - <name> # SKIP test name does not match pattern`
  // (newer node omits them entirely) — a skipped test was NOT executed, so a SKIP-directive result
  // line must never count as a match: without this filter the probe reports a nonexistent testId as
  // resolvable + baseline-green on node 18/20 and the gate green-vouches a test that never ran
  // (caught by CI's node-18/20 matrix on the 1.37.0 release commit; shipped as the 1.37.1 fix).
  it('parseProbeOutput never counts SKIP-directive result lines (the node-18/20 pattern-filter shape)', () => {
    const node18Nomatch = [
      'TAP version 13',
      '# Subtest: green one',
      'ok 1 - green one # SKIP test name does not match pattern',
      '# Subtest: red one',
      'ok 2 - red one # SKIP test name does not match pattern',
      '1..2',
      '# tests 2',
      '# pass 0',
      '# fail 0',
      '# skipped 2',
    ].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: node18Nomatch, code: 0, fileArg: 'lib.test.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
    // lowercase directive (TAP allows any case) + an explicitly skipped real test — still not a match.
    const lowercaseSkip = ['TAP version 13', 'ok 1 - some case # skip manual', '1..1', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: lowercaseSkip, code: 0, fileArg: 'lib.test.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
    // a MATCHED test on node 18/20 (no directive) still resolves — the filter only drops directives.
    const node18Match = ['TAP version 13', '# Subtest: green one', 'ok 1 - green one', 'ok 2 - red one # SKIP test name does not match pattern', '1..2', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: node18Match, code: 0, fileArg: 'lib.test.mjs' }), { resolvable: true, executed: 1, baselineGreen: true });
    // a TODO directive is equally not-executed-as-asserted — fail closed the same way.
    const todoLine = ['TAP version 13', 'ok 1 - future case # TODO later', '1..1', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: todoLine, code: 0, fileArg: 'lib.test.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
  });
});

// ── Decision 10: bound-run argv (default node:test shape + the escape hatch) ──────────────────────

describe('bound-run argv (Decision 10)', () => {
  it('the default shape is the shell-free node --test --test-name-pattern form (=-joined: a leading-dash pattern must never parse as an option)', () => {
    assert.deepEqual(defaultBoundArgv('a/b.test.mjs', 'my pattern'), [
      'node', '--test', '--test-reporter', 'tap', '--test-name-pattern=my pattern', 'a/b.test.mjs',
    ]);
    assert.deepEqual(defaultBoundArgv('a/b.test.mjs', '--telemetry refuses'), [
      'node', '--test', '--test-reporter', 'tap', '--test-name-pattern=--telemetry refuses', 'a/b.test.mjs',
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
      schema: RESULT_SCHEMA_VERSION, kind: 'run', loop: 'demo', base: 'h'.repeat(40), fingerprint: 'a'.repeat(64), boundTestIds: [],
      testIds: [], unsupported: [], outOfDomain: [], coverage: { uncoveredChanged: [] }, tamper: { tampered: [] },
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

// A valid v4 fixable-bug triage line at the fixture's SEGMENT base (D7: the runner collects the
// bound set per segment, so the triage must sit at the repo's HEAD). loop must match the in-flight
// plan stem.
const triageLine = (loop, testId, base) =>
  `${JSON.stringify({ schema: 4, loop, activity: 'plan-execution', kind: 'triage', round: 1, base, fingerprint: 'a'.repeat(64), classifications: [{ findingKey: 'k', class: 'fixable-bug', accepted: false, testId, note: '' }], timestamp: 't' })}\n`;
const headOf = (root) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

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

  it('an unborn branch (no HEAD yet) falls back to the index diff and still classifies untracked files', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-surface-unborn-'));
    gitInit(root); // no commit — HEAD is unborn
    writeFileSync(join(root, 'fresh.mjs'), 'export const a = 1;\n');
    const surface = computeChangedSurface(root);
    assert.deepEqual([...surface.assessable.keys()], ['fresh.mjs']);
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
    writeFileSync(join(root, '.git', 'rl.jsonl'), triageLine('demo-plan', boundId, headOf(root)));

    const env = fixtureEnv(root, { AW_FOLD_RERUNS: '2' }); // exercise the D4 N-rerun counts (N=2)
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
    // testId probe + baseline (Decision 3) — v2: N-rerun counts + the custody content hash (D4/D5).
    const testFileHash = createHash('sha256').update(readFileSync(join(root, 'lib.test.mjs'))).digest('hex');
    assert.deepEqual(record.boundTestIds, [boundId]);
    assert.equal(record.testIds.length, 1);
    assert.deepEqual({ ...record.testIds[0] }, {
      id: boundId, resolvable: true, executed: 1, baselineGreen: true,
      runs: 2, greens: 2, reds: 0, timeouts: 0, fileHash: testFileHash,
    });
    // machine-only schema v2 + empty mutation + the (clean) tamper surface
    assert.equal(record.schema, RESULT_SCHEMA_VERSION);
    assert.equal(record.kind, 'run');
    assert.equal(record.budgets.foldReruns, 2);
    assert.equal(record.budgets.probeTimeoutS, 120);
    assert.deepEqual(record.tamper, { tampered: [] }, 'untracked test files are additions, never tamper');
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
      triageLine('demo-plan', green, headOf(root)) + triageLine('demo-plan', red, headOf(root)) + triageLine('demo-plan', nomatch, headOf(root)) + triageLine('demo-plan', missing, headOf(root)),
    );
    const { record } = runFoldCompleteness({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '1' }), suiteCmd: 'node --test --test-reporter tap lib.test.mjs' });
    const byId = Object.fromEntries(record.testIds.map((t) => [t.id, t]));
    assert.deepEqual(record.boundTestIds, [green, red, nomatch, missing].sort());
    assert.equal(byId[green].resolvable, true);
    assert.equal(byId[green].baselineGreen, true);
    assert.equal(byId[green].greens, 1);
    assert.match(byId[green].fileHash, /^[0-9a-f]{64}$/);
    assert.equal(byId[red].resolvable, true);
    assert.equal(byId[red].baselineGreen, false); // red baseline
    assert.equal(byId[red].reds, 1);
    assert.equal(byId[nomatch].resolvable, false); // pattern selects nothing
    assert.equal(byId[nomatch].fileHash, byId[green].fileHash, 'same file → same custody hash, resolvable or not');
    assert.equal(byId[missing].resolvable, false); // file does not exist
    assert.equal(byId[missing].fileHash, null, 'an unresolvable FILE has no custody hash');
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

// ── the shared safe test-file resolver (BUGFREE-1, codex R1+R2): custody hashing and every probe
// spawn go through THIS — repo-relative only, no-follow lstat, real-path containment under the real
// repo root (a leaf check alone lets a symlinked PARENT directory escape the work tree). ───────────

describe('resolveTestFile — the shared safe test-file resolver', () => {
  const makeResolverFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-resolve-'));
    gitInit(root);
    writeFileSync(join(root, 'real.test.mjs'), 'export const x = 1;\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'inner.test.mjs'), 'export const y = 1;\n');
    symlinkSync('real.test.mjs', join(root, 'leaf-link.test.mjs')); // symlinked leaf
    const outside = mkdtempSync(join(tmpdir(), 'fold-outside-'));
    writeFileSync(join(outside, 'escaped.test.mjs'), 'export const z = 1;\n');
    symlinkSync(outside, join(root, 'linkdir')); // symlinked PARENT directory escaping the tree
    mkdirSync(join(root, 'dir.test.mjs')); // a directory named like a test file (non-regular)
    return { root, outside };
  };

  it('a valid repo-relative regular file resolves ok', () => {
    const { root, outside } = makeResolverFixture();
    const r = resolveTestFile(root, 'sub/inner.test.mjs');
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.abs.endsWith(join('sub', 'inner.test.mjs')));
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('each unsafe path is refused with a named reason', () => {
    const { root, outside } = makeResolverFixture();
    const cases = [
      ['../escape.test.mjs', /escapes the repo root/],
      [`${outside}/escaped.test.mjs`, /absolute path/],
      ['leaf-link.test.mjs', /not a regular file/],
      ['linkdir/escaped.test.mjs', /outside the repo root/],
      ['dir.test.mjs', /not a regular file/],
      ['ghost.test.mjs', /does not exist/],
      ['', /empty file path/],
    ];
    for (const [rel, re] of cases) {
      const r = resolveTestFile(root, rel);
      assert.equal(r.ok, false, `"${rel}" must be refused`);
      assert.match(r.reason, re, `"${rel}" reason: ${r.reason}`);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('a realpath failure (fs race) is a refusal, never a throw (injected deps)', () => {
    const { root, outside } = makeResolverFixture();
    const r = resolveTestFile(root, 'real.test.mjs', { realpath: () => { throw new Error('gone'); } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /cannot resolve the real path/);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('hashFileBytes: sha-256 hex over bytes; null on an unreadable path (fail closed)', () => {
    const { root, outside } = makeResolverFixture();
    const expected = createHash('sha256').update(readFileSync(join(root, 'real.test.mjs'))).digest('hex');
    assert.equal(hashFileBytes(join(root, 'real.test.mjs')), expected);
    assert.equal(hashFileBytes(join(root, 'dir.test.mjs')), null); // EISDIR → null, never a throw
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

// ── the probe env knobs (D4) — one shared fail-closed integer parser: zero / negative / fractional /
// non-numeric are refusals by name, never a silent fallback (the parseInt(...)||default idiom would
// accept bad truthy values; codex R2). ────────────────────────────────────────────────────────────

describe('budgetsFromEnv — the D4 probe knobs', () => {
  it('defaults: AW_FOLD_RERUNS=3, AW_FOLD_PROBE_TIMEOUT_S=120', () => {
    const b = budgetsFromEnv({});
    assert.equal(b.foldReruns, 3);
    assert.equal(b.probeTimeoutS, 120);
  });
  it('valid overrides parse', () => {
    const b = budgetsFromEnv({ AW_FOLD_RERUNS: '5', AW_FOLD_PROBE_TIMEOUT_S: '30' });
    assert.equal(b.foldReruns, 5);
    assert.equal(b.probeTimeoutS, 30);
  });
  it('invalid AW_FOLD_RERUNS values are refused by name', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      assert.throws(
        () => budgetsFromEnv({ AW_FOLD_RERUNS: bad }),
        (e) => e.code === FOLD_RUN_STOP && /AW_FOLD_RERUNS/.test(e.message),
        `AW_FOLD_RERUNS="${bad}" must be refused`,
      );
    }
  });
  it('invalid AW_FOLD_PROBE_TIMEOUT_S values are refused by name', () => {
    for (const bad of ['0', '-5', '2.5', 'soon']) {
      assert.throws(
        () => budgetsFromEnv({ AW_FOLD_PROBE_TIMEOUT_S: bad }),
        (e) => e.code === FOLD_RUN_STOP && /AW_FOLD_PROBE_TIMEOUT_S/.test(e.message),
        `AW_FOLD_PROBE_TIMEOUT_S="${bad}" must be refused`,
      );
    }
  });
});

// ── the oracle-tamper surface (BUGFREE-1 Phase 2.2): the union of test-classified changed paths and
// the loop's bound-testId file halves, restricted to files existing at HEAD, classified by hunk
// line polarity — any removed/modified line is tamper; pure additions and new files are clean. ────

describe('computeTamperedTests — polarity over the tracked working-vs-HEAD diff', () => {
  it('classifies modified / deleted / added / new / nonstandard-bound paths correctly', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-tamper-'));
    const g = gitInit(root);
    writeFileSync(join(root, 'a.test.mjs'), 'line one\nline two\nline three\n');
    writeFileSync(join(root, 'b.spec.js'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(root, 'del.test.mjs'), 'doomed\n');
    writeFileSync(join(root, 'grow.test.mjs'), 'first\n');
    mkdirSync(join(root, 'checks'));
    writeFileSync(join(root, 'checks/plain-oracle.mjs'), 'expected value one\n');
    writeFileSync(join(root, 'src.mjs'), 'export const a = 1;\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    // Tamper: modify a line, delete a line, delete a file, modify the nonstandard bound file.
    writeFileSync(join(root, 'a.test.mjs'), 'line one\nline TWO CHANGED\nline three\n');
    writeFileSync(join(root, 'b.spec.js'), 'alpha\ngamma\n');
    rmSync(join(root, 'del.test.mjs'));
    writeFileSync(join(root, 'checks/plain-oracle.mjs'), 'expected value TWO\n');
    // Clean: pure addition to a pre-existing test file; a brand-new untracked test file.
    writeFileSync(join(root, 'grow.test.mjs'), 'first\nsecond appended\n');
    writeFileSync(join(root, 'new.test.mjs'), 'fresh\n');
    // Out of surface: a modified non-test source file that is not bound.
    writeFileSync(join(root, 'src.mjs'), 'export const a = 2;\n');

    const { tampered } = computeTamperedTests(root, new Set(['checks/plain-oracle.mjs']));
    assert.deepEqual(tampered, ['a.test.mjs', 'b.spec.js', 'checks/plain-oracle.mjs', 'del.test.mjs']);
    rmSync(root, { recursive: true, force: true });
  });

  it('a brand-new untracked test file never trips the surface (addition, not tamper)', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-tamper-new-'));
    const g = gitInit(root);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'brand-new.test.mjs'), 'fresh\n');
    const { tampered } = computeTamperedTests(root, new Set());
    assert.deepEqual(tampered, []);
    rmSync(root, { recursive: true, force: true });
  });

  // codex R5 (BUGFREE-1 live loop): the testId file half is user-authored — './checks/x.mjs' probes
  // and hashes as 'checks/x.mjs', so the tamper surface must compare NORMALIZED halves or a
  // modified bound file escapes the guard.
  it('bound file halves are normalized into the tamper surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-tamper-norm-'));
    const g = gitInit(root);
    mkdirSync(join(root, 'checks'));
    writeFileSync(join(root, 'checks/plain-oracle.mjs'), 'expected value one\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'checks/plain-oracle.mjs'), 'expected value TWO\n');
    const dotSlash = computeTamperedTests(root, new Set(['./checks/plain-oracle.mjs']));
    assert.deepEqual(dotSlash.tampered, ['checks/plain-oracle.mjs'], './-prefixed bound half must still guard the file');
    const traversal = computeTamperedTests(root, new Set(['checks/../checks/plain-oracle.mjs']));
    assert.deepEqual(traversal.tampered, ['checks/plain-oracle.mjs'], 'a lexical-traversal bound half must still guard the file');
    rmSync(root, { recursive: true, force: true });
  });

  // agy R5 (BUGFREE-1 live loop): git C-quotes diff paths carrying quotes/control/non-ASCII bytes
  // ("a/\321\202...") — an unparsed quoted path compares unequal to its classifier/testId form and
  // silently escapes the tamper surface. Space-only paths are NOT quoted but carry a trailing TAB.
  it('quoted diff paths are unquoted (C-quoting) so they cannot escape the surface', () => {
    const quoteDiff = [
      'diff --git "a/quote\\"file.test.mjs" "b/quote\\"file.test.mjs"',
      'index 1111111..2222222 100644',
      '--- "a/quote\\"file.test.mjs"',
      '+++ "b/quote\\"file.test.mjs"',
      '@@ -1 +1 @@',
      '-one',
      '+CHANGED',
    ].join('\n');
    const q = parseDiffOldSide(quoteDiff);
    assert.deepEqual([...q.keys()], ['quote"file.test.mjs']);
    assert.equal(q.get('quote"file.test.mjs').removals, true);
    assert.deepEqual([...parseUnifiedDiff(quoteDiff).keys()], ['quote"file.test.mjs'], 'the new-side parser unquotes too');

    const octalDiff = [
      'diff --git "a/\\321\\202.test.mjs" "b/\\321\\202.test.mjs"',
      '--- "a/\\321\\202.test.mjs"',
      '+++ "b/\\321\\202.test.mjs"',
      '@@ -1 +1 @@',
      '-one',
      '+CHANGED',
    ].join('\n');
    assert.deepEqual([...parseDiffOldSide(octalDiff).keys()], ['т.test.mjs'], 'octal UTF-8 escapes decode byte-wise');

    const spaceTabDiff = [
      'diff --git a/my test file.test.mjs b/my test file.test.mjs',
      '--- a/my test file.test.mjs\t',
      '+++ b/my test file.test.mjs\t',
      '@@ -1 +1 @@',
      '-one',
      '+CHANGED',
    ].join('\n');
    assert.deepEqual([...parseDiffOldSide(spaceTabDiff).keys()], ['my test file.test.mjs'], 'the space-path trailing TAB is trimmed');

    // The helper directly: passthrough, simple escapes, and an UNKNOWN escape (kept literally —
    // never dropped, never a throw).
    assert.equal(unquoteDiffPath('plain/path.test.mjs'), 'plain/path.test.mjs');
    assert.equal(unquoteDiffPath('"a/tab\\there.test.mjs"'), 'a/tab\there.test.mjs');
    assert.equal(unquoteDiffPath('"a/weird\\qname.test.mjs"'), 'a/weirdqname.test.mjs');
    // agy R6: an UNESCAPED non-BMP char inside a quoted path (reachable under core.quotepath=false)
    // must survive — 16-bit-unit iteration would split the surrogate pair into replacement chars.
    assert.equal(unquoteDiffPath('"a/\u{1F600}\\t.test.mjs"'), 'a/\u{1F600}\t.test.mjs');
  });

  // agy R6 (non-blocking, folded): a user's global diff.noprefix=true would strip the a/ b/
  // prefixes and make the parsers eat a real directory named "a" — the invocation pins the
  // prefixes explicitly, so user git config can never bend the parse.
  it('the tamper surface survives a user diff.noprefix=true config (a real "a/" directory)', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-tamper-noprefix-'));
    const g = gitInit(root);
    g('config', 'diff.noprefix', 'true');
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'real.test.mjs'), 'one\ntwo\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(root, 'a', 'real.test.mjs'), 'one\nTWO CHANGED\n');
    assert.deepEqual(computeTamperedTests(root, new Set()).tampered, ['a/real.test.mjs'], 'a noprefix header must not eat a REAL directory named "a"');
    rmSync(root, { recursive: true, force: true });
  });

  // agy R6 (non-blocking, folded): only the git-appended trailing TAB (and a CRLF \r) is stripped —
  // never a legitimate trailing character of the filename itself.
  it('only the git-appended trailing TAB/CR is stripped from unquoted header paths', () => {
    const crlfDiff = [
      'diff --git a/sp ace.test.mjs b/sp ace.test.mjs',
      '--- a/sp ace.test.mjs\t\r',
      '+++ b/sp ace.test.mjs\t\r',
      '@@ -1 +1 @@',
      '-one',
      '+CHANGED',
    ].join('\n');
    assert.deepEqual([...parseDiffOldSide(crlfDiff).keys()], ['sp ace.test.mjs']);
  });

  it('an unborn branch (no HEAD yet) and a non-git dir both read as an empty (clean) surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-tamper-unborn-'));
    gitInit(root); // no commit — HEAD is unborn, the diff falls back
    writeFileSync(join(root, 'x.test.mjs'), 'fresh\n');
    assert.deepEqual(computeTamperedTests(root, new Set()).tampered, []);
    const plain = mkdtempSync(join(tmpdir(), 'fold-tamper-nogit-'));
    assert.deepEqual(computeTamperedTests(plain, new Set()).tampered, []);
    rmSync(root, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });
});

// ── the --red verb (D6): observe RED on the real pre-fold tree, mint the receipt; observed-green /
// unresolvable / mixed / timeout are DISTINGUISHED refusals and nothing is written (D4). ──────────

describe('runRedProbe / --red — observed-red receipts', () => {
  const redFixtureRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'fold-red-'));
    const g = gitInit(root);
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
    writeFileSync(join(root, 'docs', 'plans', 'demo-plan.md'), '# demo\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red case', () => { assert.equal(1, 2); });\ntest('green case', () => { assert.equal(1, 1); });\n",
    );
    return root;
  };
  const ledgerOf = (root) => join(root, '.git', 'fc.jsonl');

  it('an N/N observed red mints a custody receipt (kind red-probe, hash, counts, fingerprint)', () => {
    const root = redFixtureRepo();
    const { record } = runRedProbe({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '2' }), testId: 'lib.test.mjs#red case' });
    assert.equal(record.schema, RESULT_SCHEMA_VERSION);
    assert.equal(record.kind, 'red-probe');
    assert.equal(record.loop, 'demo-plan');
    assert.equal(record.testId, 'lib.test.mjs#red case');
    assert.equal(record.runs, 2);
    assert.equal(record.reds, 2);
    assert.equal(record.fileHash, createHash('sha256').update(readFileSync(join(root, 'lib.test.mjs'))).digest('hex'));
    assert.match(record.fingerprint, /^[0-9a-f]{64}$/);
    const { records, malformed } = readResults(ledgerOf(root));
    assert.equal(malformed, 0);
    assert.equal(records.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it('an observed GREEN refuses by name and writes nothing (the fix-theater guard)', () => {
    const root = redFixtureRepo();
    assert.throws(
      () => runRedProbe({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '2' }), testId: 'lib.test.mjs#green case' }),
      (e) => e.code === FOLD_RUN_STOP && /observed GREEN/.test(e.message),
    );
    assert.equal(existsSync(ledgerOf(root)), false, 'a refusal writes nothing');
    rmSync(root, { recursive: true, force: true });
  });

  it('an unresolvable FILE refuses, naming the dynamic-import authoring pattern (D7), and writes nothing', () => {
    const root = redFixtureRepo();
    assert.throws(
      () => runRedProbe({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '1' }), testId: 'ghost.test.mjs#whatever' }),
      (e) => e.code === FOLD_RUN_STOP && /unresolvable/.test(e.message) && /dynamic import/.test(e.message),
    );
    assert.equal(existsSync(ledgerOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a pattern selecting no test refuses as unresolvable and writes nothing', () => {
    const root = redFixtureRepo();
    assert.throws(
      () => runRedProbe({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '1' }), testId: 'lib.test.mjs#no such test here' }),
      (e) => e.code === FOLD_RUN_STOP && /unresolvable/.test(e.message),
    );
    assert.equal(existsSync(ledgerOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a MIXED outcome (deterministic state-file alternator) refuses as QUARANTINE and writes nothing', () => {
    const root = redFixtureRepo();
    writeFileSync(
      join(root, 'flaky.test.mjs'),
      [
        "import { test } from 'node:test';",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "let n = 0; try { n = Number(readFileSync(new URL('./flaky-state.txt', import.meta.url), 'utf8')); } catch {}",
        "writeFileSync(new URL('./flaky-state.txt', import.meta.url), String(n + 1));",
        "test('flaky case', () => { if (n % 2 === 0) throw new Error('even run'); });",
      ].join('\n'),
    );
    assert.throws(
      () => runRedProbe({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '2' }), testId: 'flaky.test.mjs#flaky case' }),
      (e) => e.code === FOLD_RUN_STOP && /QUARANTINE/.test(e.message) && /1 green \/ 1 red/.test(e.message),
    );
    assert.equal(existsSync(ledgerOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('a TIMED-OUT probe run refuses as QUARANTINE naming the timeout and writes nothing', () => {
    const root = redFixtureRepo();
    writeFileSync(
      join(root, 'slow.test.mjs'),
      "import { test } from 'node:test';\ntest('slow case', async () => { await new Promise((r) => setTimeout(r, 30000)); });\n",
    );
    assert.throws(
      () => runRedProbe({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '1', AW_FOLD_PROBE_TIMEOUT_S: '1' }), testId: 'slow.test.mjs#slow case' }),
      (e) => e.code === FOLD_RUN_STOP && /timed out/.test(e.message),
    );
    assert.equal(existsSync(ledgerOf(root)), false);
    rmSync(root, { recursive: true, force: true });
  });

  // codex R1 (BUGFREE-1 live loop): the resolver validates+hashes the file, but the spawn passed the
  // RAW file half — node parses a leading-dash filename as an option and runs different tests than
  // the hashed file (a custody forgery vector). The spawn must use a ./-prefixed relpath.
  it('a leading-dash test file is spawned safely (node must not parse it as an option)', () => {
    const root = redFixtureRepo();
    writeFileSync(
      join(root, '-dash.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('dash red case', () => { assert.equal(1, 2); });\n",
    );
    const { record } = runRedProbe({ cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '1' }), testId: '-dash.test.mjs#dash red case' });
    assert.equal(record.reds, 1, 'the dash file itself was executed and observed red');
    assert.equal(record.fileHash, createHash('sha256').update(readFileSync(join(root, '-dash.test.mjs'))).digest('hex'), 'the executed file IS the hashed file');
    rmSync(root, { recursive: true, force: true });
  });

  // codex R2 (BUGFREE-1 live loop, blocker): the resolver normalizes LEXICALLY ('linkdir/../x' →
  // 'x') and hashes the in-repo target, but a raw spawn lets the RUNNER resolve the path its own
  // way — node's built-in runner happens to normalize lexically too (safe by accident), while a
  // custom AW_FOLD_BOUND_CMD runner (or plain `node file`) OS-resolves THROUGH the symlinked dir to
  // a DIFFERENT filesystem file. The executed file must always be the hashed file, independent of
  // runner path semantics — so the spawn uses the resolver's canonical path for every input.
  it('a traversal path is spawned as its normalized in-repo target', () => {
    // Node-based runners resolve paths LEXICALLY (URL dot-segment collapse), so the divergence
    // needs an OS-resolving runner — the probe contract is runner-agnostic (TAP + exit code), so
    // the minimal one is `cat` over TAP-text "test files": what `cat` prints IS the probe result.
    const root = redFixtureRepo();
    // In-repo target (what the resolver hashes): RED TAP.
    writeFileSync(join(root, 'trap.test.mjs'), 'TAP version 13\nnot ok 1 - trap red case\n1..1\n# tests 1\n# pass 0\n# fail 1\n');
    // OS-level target of the raw path linkdir/../trap.test.mjs: a GREEN impostor OUTSIDE the repo
    // (hermetic: linkdir → base/sub, so linkdir/../trap.test.mjs OS-resolves to base/trap.test.mjs).
    const base = mkdtempSync(join(tmpdir(), 'fold-trap-outside-'));
    mkdirSync(join(base, 'sub'));
    writeFileSync(join(base, 'trap.test.mjs'), 'TAP version 13\nok 1 - trap red case\n1..1\n# tests 1\n# pass 1\n# fail 0\n');
    symlinkSync(join(base, 'sub'), join(root, 'linkdir'));
    const env = fixtureEnv(root, { AW_FOLD_RERUNS: '1', AW_FOLD_BOUND_CMD: '["cat","{file}"]' });
    const { record } = runRedProbe({ cwd: root, env, testId: 'linkdir/../trap.test.mjs#trap red case' });
    assert.equal(record.reds, 1, 'the executed file is the hashed IN-REPO target (red), not the impostor the OS-resolved raw path names');
    assert.equal(record.fileHash, createHash('sha256').update(readFileSync(join(root, 'trap.test.mjs'))).digest('hex'));
    rmSync(base, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  // agy R1 (BUGFREE-1 live loop): containment via realRoot+sep breaks for a repo at the filesystem
  // root ('/'+sep === '//'), and prefix containment must stay segment-safe ('/a' vs '/ab'). The
  // helper is imported DYNAMICALLY — the D7 authoring pattern: this test must LOAD (and fail) on the
  // pre-fold tree even though the export it tests does not exist yet.
  it('containsPath: segment-safe containment incl. a filesystem-root repo', async () => {
    const mod = await import('./fold-completeness-run.mjs');
    assert.equal(typeof mod.containsPath, 'function', 'containsPath must be exported');
    assert.equal(mod.containsPath('/repo', '/repo/x.test.mjs'), true);
    assert.equal(mod.containsPath('/repo', '/repository/x.test.mjs'), false); // '/a' never contains '/ab'
    assert.equal(mod.containsPath('/', '/x.test.mjs'), true); // a repo at the fs root
    assert.equal(mod.containsPath('/repo', '/repo'), false); // the root itself is not inside
  });

  it('CLI: --red mints and reports; a malformed testId or a missing value is a usage error', () => {
    const root = redFixtureRepo();
    const ok = main(['--red', 'lib.test.mjs#red case'], { cwd: root, env: fixtureEnv(root, { AW_FOLD_RERUNS: '1' }) });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /red-probe receipt/);
    const malformed = main(['--red', 'no-separator'], { cwd: root, env: fixtureEnv(root) });
    assert.equal(malformed.code, 2);
    const missing = main(['--red'], { cwd: root, env: fixtureEnv(root) });
    assert.equal(missing.code, 2);
    rmSync(root, { recursive: true, force: true });
  });
});
