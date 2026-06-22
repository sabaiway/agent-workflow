import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
