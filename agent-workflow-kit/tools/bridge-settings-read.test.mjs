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

describe('settingsSnapshot — active = differs from the built-in default (review-bridge-settings-r01-major-01)', () => {
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

describe('settingsSnapshot — env validation mirrors the wrapper (review-bridge-settings-r01-major-02, narrowed per D3)', () => {
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

  it('a TIMEOUT env value is validated like the wrapper resolver (AD-061 — the env bypass is closed)', () => {
    // The AD-061 effective-timeout resolver validates the EFFECTIVE value env included — `2h` is
    // NOT integer-seconds, so the wrapper warns and runs the built-in default; the advisor must
    // never display a dead override as active.
    const eff = effectiveOf({ key: 'CODEX_HARD_TIMEOUT', kind: 'integer', min: 1, max: 86400, default: null }, { byKey: new Map() }, { CODEX_HARD_TIMEOUT: '2h' });
    assert.equal(eff.source, 'default');
    assert.match(eff.note, /env value "2h" is invalid for CODEX_HARD_TIMEOUT/);
    assert.deepEqual(active(settingsSnapshot(ctx({ CODEX_HARD_TIMEOUT: '2h' }))), []);
    // A VALID timeout env value stays an active env override.
    assert.deepEqual(active(settingsSnapshot(ctx({ CODEX_HARD_TIMEOUT: '7200' }))), ['CODEX_HARD_TIMEOUT=7200[env]']);
    // The resolver's overflow bound rides along for timeout keys (8-digit integer part).
    const agy = effectiveOf({ key: 'AGY_HARD_TIMEOUT', kind: 'duration', default: '30m' }, { byKey: new Map() }, { AGY_HARD_TIMEOUT: '99999999m' });
    assert.equal(agy.source, 'default');
  });

  it('a NON-timeout non-enum env value stays the operator raw override (the wrappers do not resolver-validate it)', () => {
    // CODEX_REVIEW_MAX_TOTAL_BYTES has no effective-value resolver in the wrappers — the advisor
    // mirrors wrapper behavior, so a raw env override is shown as-is.
    const eff = effectiveOf({ key: 'CODEX_REVIEW_MAX_TOTAL_BYTES', kind: 'integer', min: 1, max: 100000000, default: '1500000' }, { byKey: new Map() }, { CODEX_REVIEW_MAX_TOTAL_BYTES: 'weird' });
    assert.deepEqual(eff, { value: 'weird', source: 'env' });
  });
});

describe('effectiveOf — control bytes render a REFUSAL, never a raw byte (AD-061, review r05)', () => {
  it('a control byte in a resolver-validated timeout key reports a pre-spend REFUSAL (the wrapper exits 2)', () => {
    for (const c of ['\x01', '\x7f']) {
      const eff = effectiveOf({ key: 'CODEX_HARD_TIMEOUT', kind: 'integer', min: 1, max: 86400, default: null }, { byKey: new Map() }, { CODEX_HARD_TIMEOUT: `1800${c}` });
      assert.equal(eff.source, 'default');
      assert.match(eff.note, /REFUSES the run pre-spend/, 'a control byte is a refusal, never a benign fallback');
      assert.doesNotMatch(eff.note, /[\x01-\x1f\x7f]/, 'the note carries NO raw control byte');
    }
  });

  it('a control byte in the enum tier key ALSO reports a pre-spend REFUSAL (the wrapper screens it)', () => {
    const eff = effectiveOf({ key: 'CODEX_SERVICE_TIER', kind: 'enum', values: ['priority'], default: null }, { byKey: new Map() }, { CODEX_SERVICE_TIER: `priority\x01` });
    assert.equal(eff.source, 'default');
    assert.match(eff.note, /REFUSES the run pre-spend/);
    assert.doesNotMatch(eff.note, /[\x01-\x1f\x7f]/);
  });

  it('a plain (non-control) invalid tier stays a standard-tier fallback, value shown safely', () => {
    const eff = effectiveOf({ key: 'CODEX_SERVICE_TIER', kind: 'enum', values: ['priority'], default: null }, { byKey: new Map() }, { CODEX_SERVICE_TIER: 'turbo' });
    assert.equal(eff.source, 'default');
    assert.match(eff.note, /not a supported/);
  });

  it('an invalid FILE value carrying a control byte is escaped in the note (no raw byte from a file line)', () => {
    const parsed = { byKey: new Map([['AGY_HARD_TIMEOUT', [{ value: 'x\x01' }]]]) };
    const eff = effectiveOf({ key: 'AGY_HARD_TIMEOUT', kind: 'duration', default: '30m' }, parsed, {});
    assert.equal(eff.source, 'default');
    assert.doesNotMatch(eff.note, /[\x01-\x1f\x7f]/, 'the file-invalid note carries NO raw control byte');
  });
});

describe('settingsSnapshot — file state matches the wrappers exactly (review-bridge-settings-r02-blocker-01: no follow mismatch)', () => {
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
