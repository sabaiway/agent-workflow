import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveTestFile, containsPath, hashFileBytes, parseProbeOutput, defaultBoundArgv } from './core-evidence-red-proof.mjs';
import { gitInit } from './core-evidence-harness.test.mjs';

// ── the probe safeguards (moved verbatim from the retired fold runner) ────────────────────────────

// spec:core-evidence/S5
describe('resolveTestFile — the safe test-file resolver (moved intact)', () => {
  const makeResolverFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'core-evidence-resolve-'));
    gitInit(root);
    writeFileSync(join(root, 'real.test.mjs'), 'export const x = 1;\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'inner.test.mjs'), 'export const y = 1;\n');
    symlinkSync('real.test.mjs', join(root, 'leaf-link.test.mjs'));
    const outside = mkdtempSync(join(tmpdir(), 'core-evidence-outside-'));
    writeFileSync(join(outside, 'escaped.test.mjs'), 'export const z = 1;\n');
    symlinkSync(outside, join(root, 'linkdir'));
    mkdirSync(join(root, 'dir.test.mjs'));
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
  it('each unsafe path is refused with a named reason (traversal, absolute, symlink leaf/parent, dir, ghost, empty)', () => {
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
  it('containsPath: segment-safe containment incl. a filesystem-root repo', () => {
    assert.equal(containsPath('/repo', '/repo/x.test.mjs'), true);
    assert.equal(containsPath('/repo', '/repository/x.test.mjs'), false);
    assert.equal(containsPath('/', '/x.test.mjs'), true);
    assert.equal(containsPath('/repo', '/repo'), false);
  });
  it('hashFileBytes: sha-256 hex over bytes; null on an unreadable path (fail closed)', () => {
    const { root, outside } = makeResolverFixture();
    const expected = createHash('sha256').update(readFileSync(join(root, 'real.test.mjs'))).digest('hex');
    assert.equal(hashFileBytes(join(root, 'real.test.mjs')), expected);
    assert.equal(hashFileBytes(join(root, 'dir.test.mjs')), null);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('parseProbeOutput — resolvable + baselineGreen from node:test TAP (moved intact)', () => {
  const FILE = 'lib.test.mjs';
  it('matched pass / matched fail / wrapper-only nomatch', () => {
    const matchPass = ['TAP version 13', 'ok 1 - outer group', '1..1', '# fail 0'].join('\n');
    const matchFail = ['TAP version 13', 'not ok 1 - outer group', '1..1', '# fail 1'].join('\n');
    const noMatch = ['TAP version 13', '1..0', `ok 1 - ${FILE}`, '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: matchPass, code: 0, fileArg: FILE }), { resolvable: true, executed: 1, baselineGreen: true });
    assert.deepEqual(parseProbeOutput({ stdout: matchFail, code: 1, fileArg: FILE }), { resolvable: true, executed: 1, baselineGreen: false });
    assert.deepEqual(parseProbeOutput({ stdout: noMatch, code: 0, fileArg: FILE }), { resolvable: false, executed: 0, baselineGreen: false });
  });
  it('the file wrapper is matched by basename (./ and absolute wrapper paths never count as tests)', () => {
    const nomatchAbs = ['TAP version 13', '1..0', 'ok 1 - /tmp/x/lib.test.mjs', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: nomatchAbs, code: 0, fileArg: 'lib.test.mjs' }), { resolvable: false, executed: 0, baselineGreen: false });
    const matchDotSlash = ['TAP version 13', 'ok 1 - real case', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: matchDotSlash, code: 0, fileArg: './lib.test.mjs' }), { resolvable: true, executed: 1, baselineGreen: true });
  });
  it('SKIP/TODO-directive result lines never count (the node pattern-filter shape)', () => {
    const skipped = ['TAP version 13', 'ok 1 - green one # SKIP test name does not match pattern', '1..1', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: skipped, code: 0, fileArg: FILE }), { resolvable: false, executed: 0, baselineGreen: false });
    const todo = ['TAP version 13', 'ok 1 - future case # TODO later', '1..1', '# fail 0'].join('\n');
    assert.deepEqual(parseProbeOutput({ stdout: todo, code: 0, fileArg: FILE }), { resolvable: false, executed: 0, baselineGreen: false });
  });
});

describe('probe argv + knobs (N and the timeout pinned from the old runner constants)', () => {
  it('the default shape is the shell-free node --test --test-name-pattern= form (a leading-dash pattern never parses as an option)', () => {
    assert.deepEqual(defaultBoundArgv('a/b.test.mjs', '--telemetry refuses'), [
      'node', '--test', '--test-reporter', 'tap', '--test-name-pattern=--telemetry refuses', 'a/b.test.mjs',
    ]);
  });
});
