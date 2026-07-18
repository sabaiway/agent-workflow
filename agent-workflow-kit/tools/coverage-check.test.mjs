// coverage-check.test.mjs — spec-first for the D3(c)+(d) final-run checker (strip-the-kit 2.3).
// Scope: the FIXED kit-owned lcov path (git-dir, outside the fingerprint domain), the fail-closed
// lcov read (absent → LOUD skipped-no-lcov, symlink → refusal), uncovered changed Node lines
// listed file:line, out-of-domain/unsupported changed files LISTED (the claim is narrowed to Node
// executable lines — never silently green, never widened), and the D3(c) red-proof verification
// (bound test green N/N · content hash unchanged · pre-fix fingerprint ≠ current · deleted-test
// and zero-match guards).
//
// The module under test is imported DYNAMICALLY (the authoring pattern): this spec LOADS — and
// fails per fixture — on the pre-implementation tree.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, mkdirSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeTreeFingerprint, resolveBase } from './core-evidence.mjs';

const cov = await import('./coverage-check.mjs').catch(() => null);
const {
  LCOV_BASENAME,
  resolveLcovPath,
  keyFor,
  main,
} = cov ?? {};

const gitInit = (root) => {
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  return g;
};

const fixtureEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, ...extra };
};

// A repo with one committed base and one CHANGED (untracked) source file `lib.mjs` of 3 lines.
// The committed base is identical everywhere — built once, cloned per test.
const REPO_TEMPLATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-check-template-'));
  const g = gitInit(dir);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return dir;
})();
after(() => rmSync(REPO_TEMPLATE, { recursive: true, force: true }));

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'coverage-check-'));
  cpSync(REPO_TEMPLATE, root, { recursive: true });
  writeFileSync(join(root, 'lib.mjs'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  return { root, g: (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }) };
};

const lcovFor = (root, coveredLines, file = 'lib.mjs') => {
  const da = [1, 2, 3].map((n) => `DA:${n},${coveredLines.includes(n) ? 1 : 0}`).join('\n');
  return `SF:${join(root, file)}\n${da}\nend_of_record\n`;
};
const writeLcov = (root, text) => writeFileSync(join(root, '.git', 'agent-workflow-lcov.info'), text);
const storeOf = (root) => join(root, '.git', 'agent-workflow-core-evidence.jsonl');

describe('coverage-check — the fixed kit-owned lcov path (D3(d))', () => {
  it('module exists (authored red-first)', () => {
    assert.ok(cov, 'coverage-check.mjs must exist and load');
  });
  it('LCOV_BASENAME is the git-dir lcov name; AW_LCOV_FILE overrides; null outside a git tree', () => {
    assert.equal(LCOV_BASENAME, 'agent-workflow-lcov.info');
    assert.equal(resolveLcovPath('/x', { AW_LCOV_FILE: '/tmp/l.info' }), '/tmp/l.info');
    const { root } = makeRepo();
    assert.equal(resolveLcovPath(root, {}), join(root, '.git', LCOV_BASENAME));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('coverage-check --check — the coverage arm', () => {
  it('an uncovered changed Node line fails WITH its location (file:line)', () => {
    const { root } = makeRepo();
    writeLcov(root, lcovFor(root, [1, 3])); // line 2 executable + 0 hits
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /lib\.mjs:2/, 'the refusal names the exact location, never a bare count');
  });

  it('a fully covered changed surface passes', () => {
    const { root } = makeRepo();
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
  });

  it('an ABSENT lcov file reports skipped-no-lcov LOUDLY (exit 0, never a silent green)', () => {
    const { root } = makeRepo();
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /skipped-no-lcov/);
    assert.match(r.stdout, /no coverage check ran/i);
  });

  it('a SYMLINKED lcov path is a refusal (lstat no-follow — never read through a link)', () => {
    const { root } = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'coverage-check-out-'));
    writeFileSync(join(outside, 'evil.info'), lcovFor(root, [1, 2, 3]));
    symlinkSync(join(outside, 'evil.info'), join(root, '.git', 'agent-workflow-lcov.info'));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(outside, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /symlink/);
  });

  it('a changed file ABSENT from the lcov map is a file-level red (never non-executable by silence)', () => {
    const { root } = makeRepo();
    writeLcov(root, 'SF:/nowhere/else.mjs\nDA:1,1\nend_of_record\n');
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /lib\.mjs.*absent from coverage/);
  });

  it('changed out-of-domain files are LISTED (the claim is narrowed to Node lines, stated)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'hook.sh'), '#!/bin/sh\necho hi\n');
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /out-of-domain.*hook\.sh/s);
  });

  it('changed unsupported-source files are LISTED (outside the narrowed Node domain, stated)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, 'x.ts'), 'export const a: number = 1;\n');
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /unsupported-source.*x\.ts/s);
  });

  it('the consumed-lcov sha is printed as a machine line (lcov-sha256=<hex>|none) — the final receipt binds it', () => {
    const { root } = makeRepo();
    const text = lcovFor(root, [1, 2, 3]);
    writeLcov(root, text);
    const read = main(['--check', '--cwd', root], { env: fixtureEnv() });
    assert.equal(read.code, 0, read.stdout);
    const want = createHash('sha256').update(text).digest('hex');
    assert.match(read.stdout, new RegExp(`lcov-sha256=${want}`), 'the sha is of the exact bytes the checker read');
    rmSync(join(root, '.git', 'agent-workflow-lcov.info'));
    const skipped = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(skipped.code, 0);
    assert.match(skipped.stdout, /lcov-sha256=none/, 'a skipped check states it consumed nothing');
  });

  it('keyFor resolves through realpath; an unresolvable path keys by its lexical abs (TOCTOU arm)', () => {
    const { root } = makeRepo();
    const real = keyFor(root, 'lib.mjs');
    assert.equal(real, realpathSync(join(root, 'lib.mjs')));
    const gone = keyFor(root, 'vanished-under-us.mjs');
    assert.equal(gone, join(root, 'vanished-under-us.mjs'), 'the fallback key reads as absent-from-map → file-level red');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('coverage-check --check — the D3(c) red-proof verification arm', () => {
  const redProofRecord = (root, over = {}) => {
    const testId = over.testId ?? 'lib.test.mjs#pinned case';
    const file = testId.slice(0, testId.indexOf('#'));
    const fileHash = over.fileHash
      ?? (() => { try { return createHash('sha256').update(readFileSync(join(root, file))).digest('hex'); } catch { return 'a'.repeat(64); } })();
    return {
      schema: 1, kind: 'red-proof', testId, file, fileHash,
      runs: 1, reds: 1,
      base: resolveBase(root),
      fingerprint: over.fingerprint ?? 'b'.repeat(64),
      timestamp: '2026-07-17T00:00:00Z',
      ...over.fields,
    };
  };
  const seedRecord = (root, record) => writeFileSync(storeOf(root), `${JSON.stringify(record)}\n`);
  const greenTest = (root) => writeFileSync(
    join(root, 'lib.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('pinned case', () => { assert.equal(1, 1); });\n",
  );

  it('a satisfied record passes: bound test green N/N, hash unchanged, pre-fix fingerprint differs', () => {
    const { root } = makeRepo();
    greenTest(root);
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    seedRecord(root, redProofRecord(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /red-proof/);
  });

  it('a DELETED bound test fails with its testId', () => {
    const { root } = makeRepo();
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    seedRecord(root, redProofRecord(root, { fileHash: 'a'.repeat(64) })); // lib.test.mjs never written
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /lib\.test\.mjs#pinned case/);
    assert.match(r.stdout, /does not exist|deleted/);
  });

  it('a zero-match testId fails (the pattern selects no test)', () => {
    const { root } = makeRepo();
    greenTest(root);
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    seedRecord(root, redProofRecord(root, { testId: 'lib.test.mjs#no such test name' }));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /selects no test|zero-match/);
  });

  it('an EQUAL pre-fix fingerprint is refused — nothing changed since the red (reuse/forgery)', () => {
    const { root } = makeRepo();
    greenTest(root);
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    seedRecord(root, redProofRecord(root, { fingerprint: computeTreeFingerprint(root) }));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /pre-fix fingerprint EQUALS the current tree|nothing changed/);
  });

  it('a bound test whose CONTENT changed since the observation fails custody (hash mismatch)', () => {
    const { root } = makeRepo();
    greenTest(root);
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    seedRecord(root, redProofRecord(root, { fileHash: 'c'.repeat(64) }));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /hash|content changed/);
  });

  it('a bound test observed RED at the final run fails (the fix never landed)', () => {
    const { root } = makeRepo();
    writeFileSync(
      join(root, 'lib.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('pinned case', () => { assert.equal(1, 2); });\n",
    );
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    seedRecord(root, redProofRecord(root));
    const r = main(['--check', '--cwd', root], { env: fixtureEnv({ AW_CORE_EVIDENCE_RERUNS: '1' }) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /red|not green/i);
  });

  it('a malformed evidence store fails CLOSED (the obligations are unknown)', () => {
    const { root } = makeRepo();
    writeLcov(root, lcovFor(root, [1, 2, 3]));
    writeFileSync(storeOf(root), 'not json at all\n');
    const r = main(['--check', '--cwd', root], { env: fixtureEnv() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /malformed/);
  });
});

describe('coverage-check CLI surface', () => {
  it('--help names the contract; an unknown argument is a usage error', () => {
    const h = main(['--help'], { env: fixtureEnv() });
    assert.equal(h.code, 0);
    assert.match(h.stdout, /skipped-no-lcov/);
    assert.equal(main(['--mystery'], { env: fixtureEnv() }).code, 2);
  });
  it('runs as a real process (argv/exit contract)', () => {
    const TOOL = new URL('./coverage-check.mjs', import.meta.url).pathname;
    const { root } = makeRepo();
    mkdirSync(join(root, 'sub'));
    const r = spawnSync('node', [TOOL, '--check', '--cwd', root], { encoding: 'utf8', env: fixtureEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skipped-no-lcov/);
    const usage = spawnSync('node', [TOOL, '--nope'], { encoding: 'utf8', env: fixtureEnv() });
    assert.equal(usage.status, 2);
    rmSync(root, { recursive: true, force: true });
  });
});
