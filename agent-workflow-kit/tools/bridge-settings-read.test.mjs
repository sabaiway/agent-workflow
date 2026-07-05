import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsSnapshot, effectiveOf } from './bridge-settings-read.mjs';

// Real temp XDG_CONFIG_HOME → the read core resolves + reads the real host path against the real
// bundled-manifest registry (CODEX_*/AGY_* knobs).
let tmp;
let confPath;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'awf-bsr-'));
  confPath = join(tmp, 'agent-workflow', 'bridge-settings.conf');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ctx = (getenv = {}) => ({ getenv: { XDG_CONFIG_HOME: tmp, ...getenv }, home: tmp });
const seedConf = (body) => {
  mkdirSync(join(tmp, 'agent-workflow'), { recursive: true });
  writeFileSync(confPath, body);
};
const active = (snap) => snap.active.map((a) => `${a.key}=${a.value}[${a.source}]`).sort();

describe('settingsSnapshot — active = differs from the built-in default (codex R1 major)', () => {
  it('no file, no env → nothing active (the surfaces stay as before any knob)', () => {
    assert.deepEqual(settingsSnapshot(ctx()).active, []);
  });

  it('a file value that EQUALS the built-in default is NOT active', () => {
    // AGY_REVIEW_ALLOW_ADDDIR default "0"; CODEX_REVIEW_MAX_TOTAL_BYTES default "1500000".
    seedConf('AGY_REVIEW_ALLOW_ADDDIR=0\nCODEX_REVIEW_MAX_TOTAL_BYTES=1500000\n');
    assert.deepEqual(settingsSnapshot(ctx()).active, [], 'default-valued knobs are not "active"');
  });

  it('a value that DIFFERS from the default is active', () => {
    seedConf('AGY_REVIEW_ALLOW_ADDDIR=1\nCODEX_SERVICE_TIER=priority\n');
    assert.deepEqual(active(settingsSnapshot(ctx())), ['AGY_REVIEW_ALLOW_ADDDIR=1[file]', 'CODEX_SERVICE_TIER=priority[file]']);
  });
});

describe('settingsSnapshot — env validation mirrors the wrapper (codex R1 major, narrowed per D3)', () => {
  it('an INVALID enum env value (the service tier) is NOT active — the wrapper drops it to standard', () => {
    // codex validates the tier env (accepts any -c service_tier string silently, so the wrapper guards).
    assert.deepEqual(settingsSnapshot(ctx({ CODEX_SERVICE_TIER: 'turbo' })).active, []);
    const eff = effectiveOf({ key: 'CODEX_SERVICE_TIER', kind: 'enum', values: ['priority'], default: null }, { byKey: new Map() }, { CODEX_SERVICE_TIER: 'turbo' });
    assert.equal(eff.source, 'default');
    assert.match(eff.note, /not a supported CODEX_SERVICE_TIER/);
  });

  it('a valid enum env value IS active', () => {
    assert.deepEqual(active(settingsSnapshot(ctx({ CODEX_SERVICE_TIER: 'priority' }))), ['CODEX_SERVICE_TIER=priority[env]']);
  });

  it('a NON-enum env value is the operator raw override, shown as-is (D3: no typed validation of env)', () => {
    // CODEX_HARD_TIMEOUT env is documented timeout(1) usage — `2h` is valid env even though the FILE
    // grammar is integer-seconds. The reader must NOT drop it (the Phase-1 refutation).
    const eff = effectiveOf({ key: 'CODEX_HARD_TIMEOUT', kind: 'integer', min: 1, max: 86400, default: null }, { byKey: new Map() }, { CODEX_HARD_TIMEOUT: '2h' });
    assert.deepEqual(eff, { value: '2h', source: 'env' });
    assert.deepEqual(active(settingsSnapshot(ctx({ CODEX_HARD_TIMEOUT: '2h' }))), ['CODEX_HARD_TIMEOUT=2h[env]']);
  });
});

describe('settingsSnapshot — file state matches the wrappers exactly (codex R2 blocker: no follow mismatch)', () => {
  it('a symlink → regular file is FOLLOWED and read, exactly as the wrappers do (never falsely "ignored")', () => {
    // The wrappers use -e/-f/-r (follow) — a symlinked config IS honored, so the reader must reflect it.
    mkdirSync(join(tmp, 'agent-workflow'), { recursive: true });
    const real = join(tmp, 'real.conf');
    writeFileSync(real, 'CODEX_SERVICE_TIER=priority\n');
    symlinkSync(real, confPath);
    const snap = settingsSnapshot(ctx());
    assert.equal(snap.error, undefined, 'a symlink-to-regular is not an error — the wrappers read it');
    assert.deepEqual(active(snap), ['CODEX_SERVICE_TIER=priority[file]']);
  });

  it('a directory / non-regular node at the settings path → a localized error (the wrapper -f is false)', () => {
    mkdirSync(confPath, { recursive: true }); // a directory where the file should be
    const snap = settingsSnapshot(ctx());
    assert.match(snap.error, /symlink|not a regular file/);
    assert.deepEqual(snap.active, []);
  });
});
