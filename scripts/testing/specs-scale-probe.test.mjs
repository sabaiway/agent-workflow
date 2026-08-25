import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
// Dynamic import: the suite LOADS without the probe (red-proof observes it failing pre-fix).
const probe = await import('./specs-scale-probe.mjs').catch(() => ({}));
const { planTree, buildTree, runProbe, main, FAN_OUT, STORE_REL } = probe;
const { readSpecDocument } = await import(join(REPO_ROOT, 'agent-workflow-memory/references/scripts/spec-schema.mjs'));

const made = [];
const mkTemp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-probe-test-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});
const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const childCount = (text) => text.split('\n').filter((line) => line.startsWith('- [')).length;

describe('specs-scale-probe — the synthetic 30/folder tree', () => {
  it('plans N specs under leaves of <= FAN_OUT children at every level, every document VALID per the reader', () => {
    const files = planTree(61);
    const indexes = files.filter((f) => f.rel.endsWith('index.md'));
    assert.equal(files.length - indexes.length, 61, '61 specs');
    assert.equal(indexes.length, 1 + 1 + 3, 'root + 1 group + 3 leaves');
    for (const f of indexes) assert.ok(childCount(f.text) <= FAN_OUT, `${f.rel} lists ${childCount(f.text)} children (<= ${FAN_OUT})`);
    assert.equal(childCount(files.find((f) => f.rel === 'index.md').text), 1, 'the root lists its one group');
    for (const f of files) {
      const verdict = readSpecDocument(f.text, f.rel);
      assert.deepEqual(verdict.errors, [], `${f.rel} reads clean`);
    }
  });

  it('1000 specs = 34 leaves under 2 groups (1037 documents); an out-of-range N refuses with exit 2', () => {
    const files = planTree(1000);
    assert.equal(files.length, 1037);
    assert.equal(files.filter((f) => /^group-\d+\/index\.md$/.test(f.rel)).length, 2);
    assert.throws(() => planTree(0), (e) => e.exitCode === 2);
    assert.throws(() => planTree(FAN_OUT ** 3 + 1), (e) => e.exitCode === 2);
  });

  it('buildTree writes the plan under <root>/docs/ai/specs/ byte-for-byte', () => {
    const root = mkTemp();
    const written = buildTree(root, 31);
    const store = join(root, STORE_REL);
    const onDisk = walk(store).map((p) => relative(store, p)).sort();
    const planned = planTree(31).map((f) => f.rel).sort();
    assert.equal(written, planned.length);
    assert.deepEqual(onDisk, planned);
    assert.equal(readFileSync(join(store, 'index.md'), 'utf8'), planTree(31).find((f) => f.rel === 'index.md').text);
  });
});

describe('specs-scale-probe — arguments and exit polarity', () => {
  const capture = () => {
    const out = [];
    const err = [];
    return { out, err, deps: { log: (l) => out.push(l), logError: (l) => err.push(l) } };
  };

  it('usage errors exit 2 (missing --n / --budget-ms, a non-numeric value, an unknown flag)', () => {
    for (const argv of [[], ['--n', '3'], ['--n', 'x', '--budget-ms', '10'], ['--n', '3', '--budget-ms', '10', '--bogus']]) {
      const { err, deps } = capture();
      assert.equal(main(argv, deps), 2, JSON.stringify(argv));
      assert.match(err[0], /specs-scale-probe/);
    }
  });

  it('a tiny tree within a generous budget exits 0 and prints the one summary line; a zero budget exits 1', () => {
    const ok = capture();
    assert.equal(main(['--n', '3', '--budget-ms', '60000', '--trials', '1'], ok.deps), 0);
    assert.match(ok.out[0], /^specs-scale-probe: n=3 files=6 hook=\d+ms median=\d+ms spec-check=\d+ms median=\d+ms budget=60000ms -> OK$/);
    const over = capture();
    assert.equal(main(['--n', '3', '--budget-ms', '0', '--trials', '1'], over.deps), 1);
    assert.match(over.out[0], /-> OVER BUDGET$/);
  });

  it('a child run that does not exit 0 measures nothing: exit 2 naming the failing run', () => {
    const calls = [];
    const spawn = (_node, args) => {
      calls.push(args);
      return { status: args.includes('--check-index') ? 1 : 0, stderr: 'simulated stale index' };
    };
    const { err, deps } = capture();
    assert.equal(main(['--n', '2', '--budget-ms', '60000'], { ...deps, spawn }), 2);
    assert.match(err[0], /--check-index exited 1/);
    assert.match(err[0], /simulated stale index/);
    assert.equal(calls.length, 3, 'write-index, the cap run, then the failing freshness run — no further trial');
  });

  it('runProbe medians the two measurements SEPARATELY and cleans its temp root', () => {
    // per trial: hook start/end, then checker start/end — four ticks, two independent spans.
    const ticks = [0, 100, 0, 10, 0, 300, 0, 30, 0, 200, 0, 20];
    const now = () => ticks.shift();
    const spawn = () => ({ status: 0, stderr: '' });
    const result = runProbe({ n: 2, budgetMs: 250, trials: 3, spawn, now });
    assert.deepEqual(result.trialsMs, [{ hook: 100, checker: 10 }, { hook: 300, checker: 30 }, { hook: 200, checker: 20 }]);
    assert.equal(result.hookMedianMs, 200);
    assert.equal(result.checkerMedianMs, 20);
    assert.equal(result.medianMs, result.hookMedianMs, 'the frozen 1a measurement keeps its name');
    assert.equal(result.withinBudget, true);
    assert.equal(result.files, 5, 'the ground files are scaffolding, never counted as documents');
  });

  it('EITHER median over budget fails the probe — the checker can never hide inside the hook budget', () => {
    const spans = (hook, checker) => [0, hook, 0, checker];
    const probeWith = (hook, checker) => {
      const ticks = spans(hook, checker);
      return runProbe({ n: 2, budgetMs: 250, trials: 1, spawn: () => ({ status: 0, stderr: '' }), now: () => ticks.shift() });
    };
    assert.equal(probeWith(100, 10).withinBudget, true);
    assert.equal(probeWith(900, 10).withinBudget, false, 'a slow hook fails');
    assert.equal(probeWith(100, 900).withinBudget, false, 'and so does a slow checker, on its own median');
  });

  it('a spec-check run that does not exit 0 measures nothing: exit 2 naming THAT run', () => {
    const spawn = (_node, args) => ({ status: args.includes('--all') ? 1 : 0, stderr: 'simulated finding' });
    const { err, deps } = capture();
    assert.equal(main(['--n', '2', '--budget-ms', '60000'], { ...deps, spawn }), 2);
    assert.match(err[0], /spec-check --all exited 1/);
    assert.match(err[0], /simulated finding/);
  });

  // spec-check prints its findings on STDOUT and exits 1. A diagnostic that quoted stderr alone
  // would report the refusal without the one thing that says WHY the tree was refused.
  it('a failing child is diagnosed from BOTH streams, so a stdout-only refusal is not silent', () => {
    const spawn = (_node, args) => (args.includes('--all')
      ? { status: 1, stdout: 'spec-check: REFUSE — 1 finding(s)\n  docs/ai/specs/x.md: orphan — no index reaches it', stderr: '' }
      : { status: 0, stdout: '', stderr: '' });
    const { err, deps } = capture();
    assert.equal(main(['--n', '2', '--budget-ms', '60000'], { ...deps, spawn }), 2);
    assert.match(err[0], /orphan/, 'the reason the child refused rides the diagnostic');
  });
});
