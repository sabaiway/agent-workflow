import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  SCHEMA,
  countAssertCallSites,
  parseRun,
  buildCorpus,
  compareCorpus,
  runCli,
  cwdBoundGitEnv,
} from './suite-parity.mjs';
// The R1-M2 export is imported dynamically so this spec LOADS against the pre-fold tree and
// each fixture fails on its OWN assertion (the red-first authoring doctrine).
const { extractAssertionExpressions } = await import('./suite-parity.mjs');
import { formatEvent } from './suite-parity-reporter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTER = join(HERE, 'suite-parity-reporter.mjs');

const tmpDirs = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const makeTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-parity-'));
  tmpDirs.push(dir);
  return dir;
};

const point = (over = {}) =>
  JSON.stringify({
    file: '/repo/a.test.mjs',
    name: 'adds',
    nesting: 1,
    suite: false,
    skip: false,
    todo: false,
    fail: false,
    ms: 1.5,
    ...over,
  });

const ndjson = (...lines) => `${lines.join('\n')}\n`;
// A VALID completion tail for the given point lines (F4) — the same per-raw-file counts the
// reporter writes at genuine stream end.
const withTail = (runText) => {
  const counts = new Map();
  for (const line of runText.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const p = JSON.parse(line);
    counts.set(p.file, (counts.get(p.file) ?? 0) + 1);
  }
  const tail = ['# per-file wall totals (nesting-0 ms, descending)'];
  for (const [file, n] of counts) tail.push(`# file-ms 1.0 points ${n} ${file}`);
  return `${runText}${tail.join('\n')}\n`;
};
const ROOT = '/repo';

// A tiny in-memory corpus: one file, one suite + two cases, three assert sites.
const A_TEST_SOURCE = 'assert.equal(1, 1);\nassert.ok(true);\nassert(true);\n';
const basePoints = () =>
  ndjson(
    point({ name: 'suite', nesting: 0, suite: true }),
    point({ name: 'adds' }),
    point({ name: 'subtracts' }),
  );
const baseRun = () => withTail(basePoints());
const buildFrom = (runText, sources = { 'a.test.mjs': A_TEST_SOURCE }) =>
  buildCorpus(runText, { root: ROOT, readTestFile: (rel) => {
    if (!(rel in sources)) throw new Error(`ENOENT ${rel}`);
    return sources[rel];
  } });

describe('suite-parity-reporter formatEvent', () => {
  it('serializes pass/fail points and ignores other events', () => {
    const passed = JSON.parse(
      formatEvent({ type: 'test:pass', data: { file: '/f.test.mjs', name: 'n', nesting: 2, details: { duration_ms: 3, type: 'suite' }, skip: false, todo: 'later' } }),
    );
    assert.deepEqual(passed, { file: '/f.test.mjs', name: 'n', nesting: 2, suite: true, skip: false, todo: true, fail: false, ms: 3 });
    const failed = JSON.parse(formatEvent({ type: 'test:fail', data: { file: '/f.test.mjs', name: 'n', nesting: 0, details: { duration_ms: 1 } } }));
    assert.equal(failed.fail, true);
    assert.equal(failed.suite, false);
    assert.equal(formatEvent({ type: 'test:diagnostic', data: { message: 'x' } }), null);
  });
});

describe('countAssertCallSites', () => {
  it('counts assert.* and bare assert( call sites', () => {
    assert.equal(countAssertCallSites(A_TEST_SOURCE), 3);
    assert.equal(countAssertCallSites('await assert.rejects(f);\nreassert(x);\nassertion(y);\n'), 1);
    // The deterministic rule's whitespace edge: a space before the dot is NOT a call site; a
    // tab before the paren is.
    assert.equal(countAssertCallSites('assert .throws(f); assert\t(g);'), 1);
  });
  it('expect(...) call sites are counted (the expect-family blind spot, R1 M2)', () => {
    assert.equal(countAssertCallSites('expect(r.status).toBe(0);\nexpect(text).toMatch(/x/);\n'), 2);
  });
});

describe('extractAssertionExpressions — balanced, normalized, chain-aware (R1 M2)', () => {
  it('captures balanced multiline arguments and expect chains as whole expressions', () => {
    const exprs = extractAssertionExpressions('await assert.rejects(\n  runScript([1,\n 2])\n);\nexpect(x).toBe(\n1);\n');
    assert.equal(exprs.length, 2);
    assert.equal(exprs[0], 'assert.rejects( runScript([1, 2]) )');
    assert.equal(exprs[1], 'expect(x).toBe( 1)');
  });
  it('a head nested inside another expression is counted separately (R2: a gutted inner check must not hide)', () => {
    const exprs = extractAssertionExpressions('assert.ok(expect(1).toBe(1));\n');
    assert.equal(exprs.length, 2);
  });
});

describe('extractAssertionExpressions — the lexer arms (R2: literals must not skew the balance)', () => {
  it('an escaped \\( inside a regex literal does not swallow the following code', () => {
    const src = 'assert.match(err, /refused \\(cap/);\nassert.equal(a, b);\nassert.ok(c);\n';
    const exprs = extractAssertionExpressions(src);
    assert.equal(exprs.length, 3);
    assert.equal(exprs[0], 'assert.match(err, /refused \\(cap/)');
  });
  it('an unbalanced paren inside a STRING argument does not skew the balance', () => {
    const src = "assert.equal(msg, 'open ( only');\nassert.ok(x);\n";
    assert.equal(extractAssertionExpressions(src).length, 2);
  });
  it('a template literal with ${} and a lone paren stays one balanced expression', () => {
    const src = 'assert.equal(t, `left ( ${name(1)} right`);\nassert.ok(y);\n';
    assert.equal(extractAssertionExpressions(src).length, 2);
  });
  it('a comment carrying ( inside an argument list does not skew the balance', () => {
    const src = 'assert.equal(a, // stray (\n b);\nassert.ok(c /* ( */);\n';
    assert.equal(extractAssertionExpressions(src).length, 2);
  });
  it('division is not misread as a regex opener', () => {
    const src = 'assert.equal(a / 2, b);\nassert.ok(c);\n';
    assert.equal(extractAssertionExpressions(src).length, 2);
  });
  it('a regex after the return keyword keeps its parens and slashes out of the balance (R3)', () => {
    const src = 'assert.ok(() => { return /[)]\\/x/ ; });\nassert.equal(a, b);\n';
    const exprs = extractAssertionExpressions(src);
    assert.equal(exprs.length, 2);
    assert.equal(exprs[0], 'assert.ok(() => { return /[)]\\/x/ ; })');
  });
  it('property-modifier chains ride the whole expression (R3: .not.toMatch is inside the hash)', () => {
    const src = 'expect(x).not.toMatch(/y/);\nassert.ok(z);\n';
    const exprs = extractAssertionExpressions(src);
    assert.equal(exprs.length, 2);
    assert.equal(exprs[0], 'expect(x).not.toMatch(/y/)');
  });
  it('a PROPERTY named like a keyword keeps division context (R4: obj.return / 2)', () => {
    const src = 'assert.equal(obj.return / 2, b);\nassert.ok(c);\n';
    const exprs = extractAssertionExpressions(src);
    assert.equal(exprs.length, 2);
    assert.equal(exprs[0], 'assert.equal(obj.return / 2, b)');
  });
  it('whitespace INSIDE string/regex literals stays byte-exact in the expression (R4)', () => {
    const wide = extractAssertionExpressions("assert.equal(s, 'a  b');\n");
    const narrow = extractAssertionExpressions("assert.equal(s, 'a b');\n");
    assert.equal(wide[0], "assert.equal(s, 'a  b')");
    assert.notEqual(wide[0], narrow[0], 'an in-literal whitespace change must move the expression (and so the hash)');
  });
});

describe('parseRun', () => {
  it('groups points per repo-relative file, sorted, with cases/suites split', () => {
    const files = parseRun(baseRun(), { root: ROOT });
    assert.deepEqual(Object.keys(files), ['a.test.mjs']);
    assert.equal(files['a.test.mjs'].cases, 2);
    assert.equal(files['a.test.mjs'].suites, 1);
    assert.deepEqual(files['a.test.mjs'].points, ['0|suite|suite', '1|test|adds', '1|test|subtracts']);
  });
  it('skips the reporter # summary comments and blank lines', () => {
    const files = parseRun(`\n${baseRun()}\n`, { root: ROOT });
    assert.equal(files['a.test.mjs'].points.length, 3);
  });
  it('refuses a run with a failing point — never a parity source', () => {
    assert.throws(
      () => parseRun(withTail(ndjson(point({ name: 'boom', fail: true }))), { root: ROOT }),
      /not green.*a\.test\.mjs: boom/s,
    );
  });
  it('refuses an unattributed point and a non-JSON line loudly', () => {
    assert.throws(() => parseRun(ndjson(point({ file: null })), { root: ROOT }), /without a file attribution/);
    assert.throws(() => parseRun('not json\n', { root: ROOT }), /non-JSON line/);
  });
  it('refuses an empty run', () => {
    assert.throws(() => parseRun('\n', { root: ROOT }), /no test points/);
  });
});

describe('parseRun — completion-tail attestation (F4: a truncated run is never a parity source)', () => {
  it('refuses a run with NO completion tail (killed before the stream drained)', () => {
    assert.throws(() => parseRun(basePoints(), { root: ROOT }), /completion tail/);
  });
  it('refuses a tail whose per-file points disagree with the parsed points (partial write)', () => {
    const tampered = `${basePoints()}# per-file wall totals (nesting-0 ms, descending)\n# file-ms 1.0 points 2 /repo/a.test.mjs\n`;
    assert.throws(() => parseRun(tampered, { root: ROOT }), /completion tail/);
  });
  it('refuses a tail naming a file with no parsed points (its points were truncated away)', () => {
    const extra = `${basePoints()}# per-file wall totals (nesting-0 ms, descending)\n# file-ms 1.0 points 3 /repo/a.test.mjs\n# file-ms 1.0 points 2 /repo/gone.test.mjs\n`;
    assert.throws(() => parseRun(extra, { root: ROOT }), /completion tail/);
  });
});

describe('compareCorpus — the red drift classes', () => {
  it('identical corpora PASS', () => {
    const result = compareCorpus(buildFrom(baseRun()), buildFrom(baseRun()));
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.newFiles, []);
  });
  it('a renamed test is points-drift naming both the lost and the new point', () => {
    const renamed = withTail(ndjson(
      point({ name: 'suite', nesting: 0, suite: true }),
      point({ name: 'adds correctly' }),
      point({ name: 'subtracts' }),
    ));
    const { ok, problems } = compareCorpus(buildFrom(baseRun()), buildFrom(renamed));
    assert.equal(ok, false);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].kind, 'points-drift');
    assert.match(problems[0].detail, /lost: {2}1\|test\|adds/);
    assert.match(problems[0].detail, /new: {3}1\|test\|adds correctly/);
  });
  it('a dropped case is points-drift', () => {
    const dropped = withTail(ndjson(point({ name: 'suite', nesting: 0, suite: true }), point({ name: 'adds' })));
    const { ok, problems } = compareCorpus(buildFrom(baseRun()), buildFrom(dropped));
    assert.equal(ok, false);
    assert.match(problems[0].detail, /lost: {2}1\|test\|subtracts/);
  });
  it('a NEW skip fails even when the point set is unchanged', () => {
    const skipped = withTail(ndjson(
      point({ name: 'suite', nesting: 0, suite: true }),
      point({ name: 'adds', skip: true }),
      point({ name: 'subtracts' }),
    ));
    const { ok, problems } = compareCorpus(buildFrom(baseRun()), buildFrom(skipped));
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.kind === 'new-skip' && /1\|test\|adds/.test(p.detail)));
  });
  it('a baseline skip that stays skipped is NOT new', () => {
    const run = withTail(ndjson(point({ name: 'suite', nesting: 0, suite: true }), point({ name: 'adds', skip: true }), point({ name: 'subtracts' })));
    assert.equal(compareCorpus(buildFrom(run), buildFrom(run)).ok, true);
  });
  it('a NEW todo fails', () => {
    const todo = withTail(ndjson(
      point({ name: 'suite', nesting: 0, suite: true }),
      point({ name: 'adds', todo: true }),
      point({ name: 'subtracts' }),
    ));
    const { ok, problems } = compareCorpus(buildFrom(baseRun()), buildFrom(todo));
    assert.equal(ok, false);
    assert.equal(problems[0].kind, 'new-todo');
  });
  it('a changed assert-call-site count fails on the surviving file', () => {
    const current = buildFrom(baseRun(), { 'a.test.mjs': 'assert.equal(1, 1);\nassert.ok(true);\n' });
    const { ok, problems } = compareCorpus(buildFrom(baseRun()), current);
    assert.equal(ok, false);
    assert.equal(problems[0].kind, 'assert-drift');
    assert.match(problems[0].detail, /3 → 2/);
  });
  it('argument-gutting at an UNCHANGED count is assert-drift on the surviving file (F2)', () => {
    const gutted = buildFrom(baseRun(), { 'a.test.mjs': 'assert.equal(9, 9);\nassert.ok(false);\nassert(0);\n' });
    const { ok, problems } = compareCorpus(buildFrom(baseRun()), gutted);
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.kind === 'assert-drift' && /unchanged count/.test(p.detail)));
  });
  it('an accepted-rewrites file exempts the expression hash ONLY — points and counts still bind (F2)', () => {
    const gutted = buildFrom(baseRun(), { 'a.test.mjs': 'assert.equal(9, 9);\nassert.ok(false);\nassert(0);\n' });
    const accepted = compareCorpus(buildFrom(baseRun()), gutted, { acceptedRewrites: ['a.test.mjs'] });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.acceptedRewrites, ['a.test.mjs']);
    const counted = buildFrom(baseRun(), { 'a.test.mjs': 'assert.equal(1, 1);\nassert.ok(true);\n' });
    const stillCounts = compareCorpus(buildFrom(baseRun()), counted, { acceptedRewrites: ['a.test.mjs'] });
    assert.equal(stillCounts.ok, false, 'a COUNT change is never covered by an accepted rewrite');
  });
  it('a deleted file fails; a NEW file is counted separately, not a failure', () => {
    const twoFiles = withTail(ndjson(
      point({ name: 'suite', nesting: 0, suite: true }),
      point({ name: 'adds' }),
      point({ name: 'subtracts' }),
      point({ file: '/repo/b.test.mjs', name: 'extra', nesting: 0 }),
    ));
    const sources = { 'a.test.mjs': A_TEST_SOURCE, 'b.test.mjs': 'assert.ok(1);\n' };
    const grown = compareCorpus(buildFrom(baseRun()), buildFrom(twoFiles, sources));
    assert.equal(grown.ok, true);
    assert.deepEqual(grown.newFiles, ['b.test.mjs']);
    const shrunk = compareCorpus(buildFrom(twoFiles, sources), buildFrom(baseRun()));
    assert.equal(shrunk.ok, false);
    assert.ok(shrunk.problems.some((p) => p.file === 'b.test.mjs' && p.kind === 'missing-file'));
  });
  it('a skip in a NEW file is still a new skip', () => {
    const withSkippingNewFile = withTail(ndjson(
      point({ name: 'suite', nesting: 0, suite: true }),
      point({ name: 'adds' }),
      point({ name: 'subtracts' }),
      point({ file: '/repo/b.test.mjs', name: 'later', nesting: 0, skip: true }),
    ));
    const current = buildFrom(withSkippingNewFile, { 'a.test.mjs': A_TEST_SOURCE, 'b.test.mjs': '' });
    const { ok, problems } = compareCorpus(buildFrom(baseRun()), current);
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.file === 'b.test.mjs' && p.kind === 'new-skip'));
  });
});

describe('runCli (hermetic, injected I/O)', () => {
  const cli = (argv, files, writes = {}) => {
    const out = [];
    const err = [];
    const code = runCli(argv, {
      log: (s) => out.push(s),
      logError: (s) => err.push(s),
      root: ROOT,
      readFile: (path) => {
        if (!(path in files)) throw new Error(`ENOENT ${path}`);
        return files[path];
      },
      writeFile: (path, text) => {
        writes[path] = text;
      },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const RUN = '/repo/run.ndjson';
  const BASE = '/repo/base.json';
  const fsFiles = (over = {}) => ({
    [RUN]: baseRun(),
    '/repo/a.test.mjs': A_TEST_SOURCE,
    ...over,
  });

  it('snapshot writes a schema-stamped baseline and reports totals', () => {
    const writes = {};
    const { code, out } = cli(['snapshot', '--run', 'run.ndjson', '--out', 'base.json'], fsFiles(), writes);
    assert.equal(code, 0);
    const written = JSON.parse(writes[BASE]);
    assert.equal(written.schema, SCHEMA);
    assert.equal(written.files['a.test.mjs'].assertCallSites, 3);
    assert.match(written.files['a.test.mjs'].assertExpressionsHash, /^[0-9a-f]{64}$/);
    assert.match(out, /snapshot: 1 files, 2 cases \(3 points\), 3 assert sites/);
  });
  it('check PASSes an identical run (exit 0, verdict line first)', () => {
    const writes = {};
    cli(['snapshot', '--run', 'run.ndjson', '--out', 'base.json'], fsFiles(), writes);
    const { code, out } = cli(['check', '--run', 'run.ndjson', '--baseline', 'base.json'], fsFiles({ [BASE]: writes[BASE] }));
    assert.equal(code, 0);
    assert.match(out, /PASS — survivor corpus identical/);
  });
  it('check FAILs a drifted run (exit 1) and prints the exact location', () => {
    const writes = {};
    cli(['snapshot', '--run', 'run.ndjson', '--out', 'base.json'], fsFiles(), writes);
    const drifted = withTail(ndjson(point({ name: 'suite', nesting: 0, suite: true }), point({ name: 'adds' })));
    const { code, err } = cli(['check', '--run', 'run.ndjson', '--baseline', 'base.json'], fsFiles({ [RUN]: drifted, [BASE]: writes[BASE] }));
    assert.equal(code, 1);
    assert.match(err, /FAIL — 1 problem/);
    assert.match(err, /a\.test\.mjs \[points-drift]/);
    assert.match(err, /lost: {2}1\|test\|subtracts/);
  });
  it('check --accept-rewrites exempts the named file from expression-hash drift and reports it (F2)', () => {
    const writes = {};
    cli(['snapshot', '--run', 'run.ndjson', '--out', 'base.json'], fsFiles(), writes);
    const gutted = 'assert.equal(9, 9);\nassert.ok(false);\nassert(0);\n';
    const refused = cli(['check', '--run', 'run.ndjson', '--baseline', 'base.json'], fsFiles({ [BASE]: writes[BASE], '/repo/a.test.mjs': gutted }));
    assert.equal(refused.code, 1, 'without the flag the rewrite is drift');
    const accepted = cli(
      ['check', '--run', 'run.ndjson', '--baseline', 'base.json', '--accept-rewrites', 'a.test.mjs'],
      fsFiles({ [BASE]: writes[BASE], '/repo/a.test.mjs': gutted }),
    );
    assert.equal(accepted.code, 0);
    assert.match(accepted.out, /accepted rewrite \(reviewed\): a\.test\.mjs/);
  });
  it('check refuses a malformed baseline (wrong schema) loudly', () => {
    const { code, err } = cli(
      ['check', '--run', 'run.ndjson', '--baseline', 'base.json'],
      fsFiles({ [BASE]: JSON.stringify({ schema: 99, files: {} }) }),
    );
    assert.equal(code, 1);
    assert.match(err, /not a schema-1 suite-parity snapshot/);
  });
  it('usage errors exit 2: unknown verb, missing --run/--out/--baseline, unknown flag', () => {
    assert.equal(cli(['freeze'], fsFiles()).code, 2);
    assert.equal(cli(['snapshot', '--out', 'x'], fsFiles()).code, 2);
    assert.equal(cli(['snapshot', '--run', 'run.ndjson'], fsFiles()).code, 2);
    assert.equal(cli(['check', '--run', 'run.ndjson'], fsFiles()).code, 2);
    assert.equal(cli(['check', '--run', 'run.ndjson', '--baseline', 'b', '--bogus'], fsFiles()).code, 2);
    assert.equal(cli(['check', '--run', 'run.ndjson', '--baseline', 'b', '--git-rev', 'HEAD'], fsFiles()).code, 2);
    assert.equal(cli(['snapshot', '--run', 'run.ndjson', '--out', 'x', '--accept-rewrites', 'a'], fsFiles()).code, 2);
  });
});

describe('snapshot --git-rev — a post-edit freeze still counts the PRE-state assert sites', () => {
  // git exports its repository pointers into every hook child. A git spawn that inherits them
  // resolves to the AMBIENT repository and ignores the cwd it was handed — so the fixture repo must
  // be built with those pointers stripped, or this spec silently drives the developer's own repo.
  const seedRepo = () => {
    const root = makeTmp();
    const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: cwdBoundGitEnv() });
    g('init', '-q');
    g('config', 'user.email', 'probe@example.com');
    g('config', 'user.name', 'probe');
    writeFileSync(join(root, 'a.test.mjs'), 'assert.ok(1);\nassert.ok(2);\nassert.ok(3);\n');
    g('add', '-A');
    g('commit', '-qm', 'pre');
    writeFileSync(join(root, 'a.test.mjs'), 'assert.ok(1);\n'); // the worktree has drifted
    writeFileSync(
      join(root, 'run.ndjson'),
      withTail(`${JSON.stringify({ file: join(root, 'a.test.mjs'), name: 'adds', nesting: 0, suite: false, skip: false, todo: false, fail: false, ms: 1 })}\n`),
    );
    return root;
  };
  const freeze = (root) =>
    runCli(['snapshot', '--run', 'run.ndjson', '--out', 'base.json', '--root', root, '--git-rev', 'HEAD'], { log: () => {}, logError: () => {} });
  const frozenCount = (root) => JSON.parse(readFileSync(join(root, 'base.json'), 'utf8')).files['a.test.mjs'].assertCallSites;

  it('reads corpus file bytes at the revision, not the worktree', () => {
    const root = seedRepo();
    assert.equal(freeze(root), 0);
    assert.equal(frozenCount(root), 3, 'the freeze carries the HEAD count, not the drifted worktree count');
  });

  it('stays bound to the --root repository under an ambient GIT_DIR (the git-hook environment)', () => {
    const root = seedRepo();
    const prior = process.env.GIT_DIR;
    process.env.GIT_DIR = join(makeTmp(), 'somewhere-else.git');
    try {
      assert.equal(freeze(root), 0, 'an inherited GIT_DIR must not redirect the read');
      assert.equal(frozenCount(root), 3, 'the bytes came from the --root repository at HEAD');
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior;
    }
  });
});

describe('end-to-end: real runner → reporter → snapshot → check', () => {
  it('freezes a real node --test run and flags a rename (the one process-spawn contract pin)', () => {
    const root = makeTmp();
    const fixture = join(root, 'sample.test.mjs');
    const run1 = join(root, 'run1.ndjson');
    const run2 = join(root, 'run2.ndjson');
    const baseline = join(root, 'base.json');
    writeFileSync(fixture, "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('first', () => assert.ok(true));\nit('second', () => assert.equal(1, 1));\n");
    const runSuite = (dest) => {
      // Strip the runner's own child marker — an inherited NODE_TEST_CONTEXT makes the spawned
      // `node --test` treat itself as recursive and silently skip every file. NODE_V8_COVERAGE
      // goes too: this child's coverage is meaningless to the parent gate and only adds dumps.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_V8_COVERAGE;
      execFileSync(process.execPath, ['--test', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${dest}`, fixture], { encoding: 'utf8', env });
    };
    runSuite(run1);
    assert.match(readFileSync(run1, 'utf8'), /# file-ms /);
    const snap = runCli(['snapshot', '--run', run1, '--out', baseline, '--root', root], { log: () => {}, logError: () => {} });
    assert.equal(snap.code ?? snap, 0);
    writeFileSync(fixture, "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('first renamed', () => assert.ok(true));\nit('second', () => assert.equal(1, 1));\n");
    runSuite(run2);
    const err = [];
    const code = runCli(['check', '--run', run2, '--baseline', baseline, '--root', root], { log: () => {}, logError: (s) => err.push(s) });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /points-drift/);
    assert.match(err.join('\n'), /lost: {2}0\|test\|first/);
  });
});
