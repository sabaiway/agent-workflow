// Spec for the verification-profile read-core (BUGFREE-3, AD-049): schema rules, the Decision-4
// declared-path safety guard (realpath-checked), the loadProfile IO contract, and the resolvers.
// Path-safety cases run a real hermetic git fixture so check-ignore + realpath containment are
// exercised end-to-end, never mocked.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateProfile,
  loadProfile,
  resolveCoverage,
  resolveSingleTest,
  resolveSarifPath,
  declaredPathUnsafeReason,
  PROFILE_REL,
  PROFILE_SCHEMA_VERSION,
} from './verification-profile.mjs';

// The seeded default the memory bootstrap deploys — kept in sync with the template.
const DEFAULT_PROFILE = {
  schema: 1,
  coverage: { kind: 'v8' },
  singleTest: { argv: ['node', '--test', '--test-reporter', 'tap', '--test-name-pattern={pattern}', '{file}'], resultFormat: 'tap-stdout' },
  findings: {},
};

const LCOV_PROFILE = { schema: 1, coverage: { kind: 'lcov', lcovPath: '.fold/lcov.info' }, singleTest: { argv: ['node', '--test', '--test-name-pattern={pattern}', '{file}'] } };
const JUNIT_ARGV = ['vitest', 'run', '--reporter=junit', '--outputFile={resultPath}', '-t', '{pattern}', '{file}'];

describe('validateProfile — schema (pure, no cwd)', () => {
  it('accepts the seeded default profile', () => {
    assert.deepEqual(validateProfile(DEFAULT_PROFILE), { ok: true });
  });
  it('accepts a minimal { schema: 1 } — coverage/singleTest/findings all optional', () => {
    assert.deepEqual(validateProfile({ schema: 1 }), { ok: true });
  });
  it('accepts an optional _README string', () => {
    assert.deepEqual(validateProfile({ _README: 'note', schema: 1 }), { ok: true });
  });
  it('PROFILE_SCHEMA_VERSION is 1', () => assert.equal(PROFILE_SCHEMA_VERSION, 1));

  it('rejects a non-object', () => {
    for (const bad of [null, 42, 'x', [1]]) assert.equal(validateProfile(bad).ok, false);
  });
  it('rejects a wrong / missing schema', () => {
    for (const s of [2, '1', 0, undefined]) assert.equal(validateProfile({ schema: s }).ok, false);
  });
  it('rejects an unknown top-level key, naming it', () => {
    const v = validateProfile({ schema: 1, bogus: 1 });
    assert.equal(v.ok, false);
    assert.match(v.reason, /unknown key "bogus"/);
  });
  it('rejects a non-string _README', () => assert.equal(validateProfile({ schema: 1, _README: 5 }).ok, false));

  it('rejects a non-object coverage / unknown coverage key', () => {
    assert.equal(validateProfile({ schema: 1, coverage: 'v8' }).ok, false);
    assert.equal(validateProfile({ schema: 1, coverage: { kind: 'v8', extra: 1 } }).ok, false);
  });
  it('rejects an unknown coverage.kind (closed enum)', () => {
    const v = validateProfile({ schema: 1, coverage: { kind: 'clover' } });
    assert.equal(v.ok, false);
    assert.match(v.reason, /coverage\.kind must be one of v8, lcov/);
  });
  it('requires lcovPath when kind is lcov', () => {
    const v = validateProfile({ schema: 1, coverage: { kind: 'lcov' } });
    assert.equal(v.ok, false);
    assert.match(v.reason, /lcovPath.*required when coverage\.kind is "lcov"/);
  });
  it('rejects lcovPath when kind is v8 (lcovPath is lcov-only)', () => {
    assert.equal(validateProfile({ schema: 1, coverage: { kind: 'v8', lcovPath: 'x' } }).ok, false);
  });
  it('accepts kind lcov with an lcovPath (pure — path safety needs a cwd)', () => {
    assert.deepEqual(validateProfile({ schema: 1, coverage: { kind: 'lcov', lcovPath: 'out/lcov.info' } }), { ok: true });
  });

  it('rejects a non-object singleTest / unknown singleTest key', () => {
    assert.equal(validateProfile({ schema: 1, singleTest: 'x' }).ok, false);
    assert.equal(validateProfile({ schema: 1, singleTest: { argv: ['{file}', '{pattern}'], nope: 1 } }).ok, false);
  });
  it('requires a non-empty string argv', () => {
    for (const bad of [[], [1], 'x', undefined]) assert.equal(validateProfile({ schema: 1, singleTest: { argv: bad } }).ok, false);
  });
  it('requires both {file} and {pattern} placeholders in argv', () => {
    assert.equal(validateProfile({ schema: 1, singleTest: { argv: ['node', '{pattern}'] } }).ok, false);
    assert.equal(validateProfile({ schema: 1, singleTest: { argv: ['node', '{file}'] } }).ok, false);
    assert.deepEqual(validateProfile({ schema: 1, singleTest: { argv: ['node', '--n={pattern}', '{file}'] } }), { ok: true });
  });
  it('rejects an unknown resultFormat (closed enum)', () => {
    assert.equal(validateProfile({ schema: 1, singleTest: { argv: ['{file}', '{pattern}'], resultFormat: 'xml' } }).ok, false);
  });
  it('a file-based resultFormat (tap-file / junit-xml) requires {resultPath} in argv', () => {
    for (const rf of ['tap-file', 'junit-xml']) {
      const bad = validateProfile({ schema: 1, singleTest: { argv: ['{file}', '{pattern}'], resultFormat: rf } });
      assert.equal(bad.ok, false, `${rf} without {resultPath} must fail`);
      assert.match(bad.reason, /\{resultPath\}/);
    }
    assert.deepEqual(validateProfile({ schema: 1, singleTest: { argv: JUNIT_ARGV, resultFormat: 'junit-xml' } }), { ok: true });
  });
  it('tap-stdout needs no {resultPath}', () => {
    assert.deepEqual(validateProfile({ schema: 1, singleTest: { argv: ['{file}', '{pattern}'], resultFormat: 'tap-stdout' } }), { ok: true });
  });

  it('rejects a non-object findings / unknown findings key / non-string sarifPath', () => {
    assert.equal(validateProfile({ schema: 1, findings: 'x' }).ok, false);
    assert.equal(validateProfile({ schema: 1, findings: { nope: 1 } }).ok, false);
    assert.equal(validateProfile({ schema: 1, findings: { sarifPath: 5 } }).ok, false);
  });
  it('accepts an empty findings {} and a string sarifPath (pure)', () => {
    assert.deepEqual(validateProfile({ schema: 1, findings: {} }), { ok: true });
    assert.deepEqual(validateProfile({ schema: 1, findings: { sarifPath: 'out/report.sarif' } }), { ok: true });
  });
});

// ── Decision 4: declared-path safety over a real git fixture ──────────────────────────────────────

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'verif-profile-'));
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@example.com');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.fold/\n.fold-lcov.info\nignored.sarif\n');
  mkdirSync(join(root, '.fold'), { recursive: true });
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root, g };
};

describe('validateProfile — declared-path safety (Decision 4)', () => {
  it('accepts a gitignored in-tree lcovPath', () => {
    const { root } = makeRepo();
    const v = validateProfile({ schema: 1, coverage: { kind: 'lcov', lcovPath: '.fold/lcov.info' } }, { cwd: root });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(v, { ok: true });
  });
  it('refuses an in-tree not-ignored lcovPath (it would move the review fingerprint)', () => {
    const { root } = makeRepo();
    const v = validateProfile({ schema: 1, coverage: { kind: 'lcov', lcovPath: 'coverage.info' } }, { cwd: root });
    rmSync(root, { recursive: true, force: true });
    assert.equal(v.ok, false);
    assert.match(v.reason, /not gitignored/);
  });
  it('refuses a symlink lcovPath outright', () => {
    const { root } = makeRepo();
    symlinkSync('/tmp/elsewhere.info', join(root, 'link.info'));
    const v = validateProfile({ schema: 1, coverage: { kind: 'lcov', lcovPath: 'link.info' } }, { cwd: root });
    rmSync(root, { recursive: true, force: true });
    assert.equal(v.ok, false);
    assert.match(v.reason, /symlink/);
  });
  it('accepts an out-of-tree absolute lcovPath (not fingerprint-relevant)', () => {
    const { root } = makeRepo();
    const outside = join(tmpdir(), 'outside-lcov.info');
    const v = validateProfile({ schema: 1, coverage: { kind: 'lcov', lcovPath: outside } }, { cwd: root });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(v, { ok: true });
  });
  it('refuses a declared path whose parent directory does not exist (fail closed)', () => {
    const { root } = makeRepo();
    const v = validateProfile({ schema: 1, coverage: { kind: 'lcov', lcovPath: 'no-such-dir/lcov.info' } }, { cwd: root });
    rmSync(root, { recursive: true, force: true });
    assert.equal(v.ok, false);
    assert.match(v.reason, /parent directory does not exist/);
  });
  it('refuses a not-ignored sarifPath, accepts a gitignored one', () => {
    const { root } = makeRepo();
    const bad = validateProfile({ schema: 1, findings: { sarifPath: 'report.sarif' } }, { cwd: root });
    const good = validateProfile({ schema: 1, findings: { sarifPath: 'ignored.sarif' } }, { cwd: root });
    rmSync(root, { recursive: true, force: true });
    assert.equal(bad.ok, false);
    assert.deepEqual(good, { ok: true });
  });
  it('declaredPathUnsafeReason returns null outside any git tree (deps injectable)', () => {
    const gitLine = () => ({ status: 128, stdout: '' });
    assert.equal(declaredPathUnsafeReason('x', 'anything.info', '/nowhere', { gitLine, lstat: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, realpath: (p) => p }), null);
  });
  it('a root realpath failure fails CLOSED with a reason, never a thrown crash', () => {
    const gitLine = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/repo\n' } : { status: 1, stdout: '' });
    const lstat = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    const realpath = (pth) => { if (pth === '/repo') throw new Error('boom'); return pth; };
    const r = declaredPathUnsafeReason('coverage.lcovPath', 'coverage/lcov.info', '/repo', { gitLine, lstat, realpath });
    assert.match(r, /cannot resolve the repo root/);
  });
});

// ── loadProfile IO ────────────────────────────────────────────────────────────────────────────────

describe('loadProfile — IO contract', () => {
  it('an absent file → { profile: null, source: "none" } (defaults path, not an error)', () => {
    const { root } = makeRepo();
    const r = loadProfile(root);
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(r, { profile: null, source: 'none' });
  });
  it('a present valid profile → { profile, source: PROFILE_REL }', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, PROFILE_REL), JSON.stringify(DEFAULT_PROFILE));
    const r = loadProfile(root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.source, PROFILE_REL);
    assert.equal(r.profile.schema, 1);
  });
  it('malformed JSON → loud fail(1)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, PROFILE_REL), '{ not json');
    assert.throws(() => loadProfile(root), (e) => e.exitCode === 1 && /malformed JSON/.test(e.message));
    rmSync(root, { recursive: true, force: true });
  });
  it('a schema-invalid profile → loud fail(1)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, PROFILE_REL), JSON.stringify({ schema: 1, coverage: { kind: 'clover' } }));
    assert.throws(() => loadProfile(root), (e) => e.exitCode === 1 && /coverage\.kind/.test(e.message));
    rmSync(root, { recursive: true, force: true });
  });
  it('an unsafe declared path in the file → loud fail(1) (Decision 4 through loadProfile)', () => {
    const { root } = makeRepo();
    writeFileSync(join(root, PROFILE_REL), JSON.stringify({ schema: 1, coverage: { kind: 'lcov', lcovPath: 'not-ignored.info' } }));
    assert.throws(() => loadProfile(root), (e) => e.exitCode === 1 && /not gitignored/.test(e.message));
    rmSync(root, { recursive: true, force: true });
  });
  it('a present-but-unreadable path (a directory) → loud fail(1), never silently absent', () => {
    const { root } = makeRepo();
    mkdirSync(join(root, PROFILE_REL));
    assert.throws(() => loadProfile(root), (e) => e.exitCode === 1 && /unreadable/.test(e.message));
    rmSync(root, { recursive: true, force: true });
  });
  it('a non-ENOENT lstat error → loud fail(1), never silently absent', () => {
    const lstat = () => { throw Object.assign(new Error('perm'), { code: 'EACCES' }); };
    assert.throws(() => loadProfile('/x', { lstat }), (e) => e.exitCode === 1 && /unreadable/.test(e.message));
  });
});

// ── resolvers ──────────────────────────────────────────────────────────────────────────────────────

describe('resolvers — absent profile reproduces today\'s defaults', () => {
  it('resolveCoverage: null / v8 → v8; lcov → the declared path', () => {
    assert.deepEqual(resolveCoverage(null), { kind: 'v8', lcovPath: null });
    assert.deepEqual(resolveCoverage(DEFAULT_PROFILE), { kind: 'v8', lcovPath: null });
    assert.deepEqual(resolveCoverage(LCOV_PROFILE), { kind: 'lcov', lcovPath: '.fold/lcov.info' });
  });
  it('resolveSingleTest: null → { argv: null, resultFormat: "tap-stdout" }; profile → its argv + format', () => {
    assert.deepEqual(resolveSingleTest(null), { argv: null, resultFormat: 'tap-stdout' });
    assert.deepEqual(resolveSingleTest(DEFAULT_PROFILE), { argv: DEFAULT_PROFILE.singleTest.argv, resultFormat: 'tap-stdout' });
    assert.equal(resolveSingleTest(LCOV_PROFILE).resultFormat, 'tap-stdout');
  });
  it('resolveSarifPath: null when absent; the declared path when present', () => {
    assert.equal(resolveSarifPath(null), null);
    assert.equal(resolveSarifPath(DEFAULT_PROFILE), null);
    assert.equal(resolveSarifPath({ schema: 1, findings: { sarifPath: 'x.sarif' } }), 'x.sarif');
  });
});
