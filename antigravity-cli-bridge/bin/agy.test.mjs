import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'agy.sh');

// Build a sandbox HOME whose ~/.local/bin holds a STUB `agy`. The wrapper prepends
// "$HOME/.local/bin" to PATH, so it resolves our stub instead of the real binary — no network,
// no real subscription CLI, fully hermetic.
const makeSandbox = (stubBody) => {
  const home = mkdtempSync(join(tmpdir(), 'agy-wrapper-test-'));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'agy');
  writeFileSync(stub, stubBody, { mode: 0o755 });
  chmodSync(stub, 0o755);
  return home;
};

const runWrapper = (home, env, prompt = 'hello') =>
  spawnSync('bash', [WRAPPER, prompt], {
    env: { HOME: home, PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });

describe('agy.sh — hard wall-clock cap (timeout(1))', () => {
  it('kills a hung agy at AGY_HARD_TIMEOUT and reports it (non-zero + actionable guidance)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\nsleep 30\n');
    const started = Date.now();
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '2s', AGY_TIMEOUT: '2s', AGY_MODEL: '' });
    const elapsed = Date.now() - started;
    rmSync(home, { recursive: true, force: true });
    assert.ok(elapsed < 13000, `wrapper must return well under the kill-after window, took ${elapsed}ms`);
    assert.notEqual(r.status, 0, 'a timed-out run must exit non-zero');
    assert.match(r.stderr, /exceeded the hard cap/, 'must explain the hard-cap kill');
  });

  it('passes a fast agy run through unchanged (exit 0, stdout preserved)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\necho "OK reply"\nexit 0\n');
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '10s', AGY_TIMEOUT: '10s', AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /OK reply/);
  });

  it('propagates a non-timeout agy failure code verbatim (no false hard-cap message)', () => {
    const home = makeSandbox('#!/usr/bin/env bash\necho "boom" >&2\nexit 3\n');
    const r = runWrapper(home, { AGY_HARD_TIMEOUT: '10s', AGY_TIMEOUT: '10s', AGY_MODEL: '' });
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 3, 'a genuine agy failure code must pass through');
    assert.doesNotMatch(r.stderr, /exceeded the hard cap/, 'must not mislabel a non-timeout failure');
  });
});

// A stub that records (via a SENTINEL file) whether agy was actually invoked, so a
// "guard fires" test can prove the wrapper exited BEFORE spending a run. When the
// argv-byte guard trips, the sentinel must be absent.
const RECORDING_STUB = [
  '#!/usr/bin/env bash',
  'if [[ -n "${AGY_STUB_SENTINEL:-}" ]]; then printf invoked > "$AGY_STUB_SENTINEL"; fi',
  'echo "OK reply"',
  'exit 0',
  '',
].join('\n');

// Run the wrapper with an explicit argv (so a `@file` / `-` prompt form can be passed)
// and optional stdin. AGY_MODEL='' drops --model so the stub argv stays clean.
const runArgs = (home, { args, env = {}, input } = {}) =>
  spawnSync('bash', [WRAPPER, ...args], {
    env: { HOME: home, PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`, AGY_MODEL: '', ...env },
    encoding: 'utf8',
    timeout: 20000,
    input,
  });

describe('agy.sh — argv byte-ceiling guard (AGY_MAX_PROMPT_BYTES)', () => {
  const withSentinel = (home) => join(home, 'sentinel');

  it('fires for an @file prompt over a lowered cap (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const big = join(home, 'big.md');
    writeFileSync(big, 'x'.repeat(500));
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: [`@${big}`], env: { AGY_MAX_PROMPT_BYTES: '100', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /over AGY_MAX_PROMPT_BYTES=100/);
    assert.equal(invoked, false, 'agy must NOT be invoked when the size guard fires');
  });

  it('fires for a stdin (-) prompt over a lowered cap (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['-'], input: 'y'.repeat(500), env: { AGY_MAX_PROMPT_BYTES: '100', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /over AGY_MAX_PROMPT_BYTES=100/);   // same headline as the @file case
    assert.match(r.stderr, /Argument list too long/);         // plus the guidance line
    assert.equal(invoked, false, 'agy must NOT be invoked when the size guard fires');
  });

  it('passes a normal prompt through unchanged under the default ceiling', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['a short prompt'], env: { AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK reply/);
    assert.equal(invoked, true, 'a within-ceiling prompt must reach agy');
  });

  it('an AGY_MAX_PROMPT_BYTES override raises the ceiling so a large prompt passes', () => {
    const home = makeSandbox(RECORDING_STUB);
    const big = join(home, 'big.md');
    writeFileSync(big, 'z'.repeat(500));
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: [`@${big}`], env: { AGY_MAX_PROMPT_BYTES: '10000', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(invoked, true, 'the raised ceiling must let the large prompt through');
  });

  it('rejects a non-integer AGY_MAX_PROMPT_BYTES (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['hi'], env: { AGY_MAX_PROMPT_BYTES: 'abc', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /not a non-negative integer/);
    assert.equal(invoked, false, 'a malformed ceiling must fail loud before invoking agy');
  });

  it('rejects an AGY_MAX_PROMPT_BYTES raised above the OS single-argv ceiling (exit 2; agy never invoked)', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = withSentinel(home);
    const r = runArgs(home, { args: ['hi'], env: { AGY_MAX_PROMPT_BYTES: '200000', AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /exceeds the OS single-argv ceiling/);
    assert.equal(invoked, false, 'raising the ceiling past the OS limit must fail loud, not pass through to E2BIG');
  });
});

// ── --help (candidate C only — the probe role is not dispatched by any activity
// slot, so this help is authored in the wrapper, NOT manifest-pinned; the lighter
// guard pins pre-preflight reachability + the documented usage forms). ──────────

// A PATH farm mirroring the real one MINUS the named binaries — so the reachability claim
// ("--help needs no agy/git") holds even on a host that has the real CLIs installed.
// Ported from agy-review.test.mjs (inline: each bridge test file stays standalone).
const makePathWithout = (root, exclude = []) => {
  const skip = new Set(exclude);
  const dir = mkdtempSync(join(root, 'nobin-'));
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    let names;
    try { names = readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (skip.has(name)) continue;
      const link = join(dir, name);
      if (existsSync(link)) continue;
      try { symlinkSync(resolve(d, name), link); } catch { /* dup / race — ignore */ }
    }
  }
  return dir;
};

describe('agy.sh — --help (pre-preflight, candidate C)', () => {
  it('--help and -h exit 0 with NO agy on PATH and name the documented usage', () => {
    for (const arg of ['--help', '-h']) {
      // A bare HOME with no ~/.local/bin/agy stub AND a PATH farm stripped of agy/git —
      // the help must not need the CLI even when the host has a real agy installed.
      const home = mkdtempSync(join(tmpdir(), 'agy-help-'));
      const r = spawnSync('bash', [WRAPPER, arg], {
        env: { HOME: home, PATH: makePathWithout(home, ['agy', 'git']) },
        encoding: 'utf8',
        timeout: 15000,
      });
      rmSync(home, { recursive: true, force: true });
      assert.equal(r.status, 0, `${arg}: ${r.stderr}`);
      assert.equal(r.stderr, '', `${arg} prints nothing to stderr`);
      assert.match(r.stdout, /Usage:/);
      assert.match(r.stdout, /agy-run "your prompt"/);
      assert.match(r.stdout, /agy-run @path\/to\/prompt\.md/);
      assert.match(r.stdout, /agy-run <prompt\|-\|@file> -- <extra agy flags\.\.\.>/);
    }
  });

  it('--help after the -- separator is passthrough payload, never intercepted', () => {
    const home = makeSandbox(RECORDING_STUB);
    const sentinel = join(home, 'sentinel');
    const r = runArgs(home, { args: ['prompt', '--', '--help'], env: { AGY_STUB_SENTINEL: sentinel } });
    const invoked = existsSync(sentinel);
    rmSync(home, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Usage:/, 'help is keyed on the FIRST argument only');
    assert.equal(invoked, true, 'the run must proceed to agy with the payload');
  });
});
