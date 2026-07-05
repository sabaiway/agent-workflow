import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './bridge-settings.mjs';

// Real temp XDG_CONFIG_HOME → the tool resolves + writes the real host path, exercising the real
// out-of-tree atomic writer and the real bundled-manifest registry (CODEX_*/AGY_* knobs).
let tmp;
let confPath;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'awf-bs-'));
  confPath = join(tmp, 'agent-workflow', 'bridge-settings.conf');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ctx = (getenv = {}) => ({ getenv: { XDG_CONFIG_HOME: tmp, ...getenv }, home: tmp });
const seedConf = (body) => {
  mkdirSync(join(tmp, 'agent-workflow'), { recursive: true });
  writeFileSync(confPath, body);
};

// ── reader ────────────────────────────────────────────────────────────────────────

describe('bridge-settings — reader', () => {
  it('no file → every knob at its built-in default, exit 0, all five knobs listed', () => {
    const r = main([], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no settings file yet/);
    for (const k of ['CODEX_SERVICE_TIER', 'CODEX_HARD_TIMEOUT', 'CODEX_REVIEW_MAX_TOTAL_BYTES', 'AGY_HARD_TIMEOUT', 'AGY_REVIEW_ALLOW_ADDDIR']) {
      assert.match(r.stdout, new RegExp(k));
    }
    // The tier row always carries the credit-rate caveat (D4), fact-only, from the manifest effect.
    assert.match(r.stdout, /2\.5x credit rate/);
  });

  it('a file-set knob → effective value with [file] source', () => {
    seedConf('CODEX_SERVICE_TIER=priority\n');
    const r = main([], ctx());
    assert.match(r.stdout, /CODEX_SERVICE_TIER = priority\s+\[file\]/);
  });

  it('an INVALID file value falls back to the built-in default (matching the wrappers), with a note', () => {
    seedConf('CODEX_SERVICE_TIER=fast\n'); // 'fast' is not an allowed tier
    const r = main([], ctx());
    assert.match(r.stdout, /CODEX_SERVICE_TIER = \(unset[^\n]*\[default\]/);
    assert.match(r.stdout, /file value "fast" is invalid/);
  });

  it('env override wins over file; an explicitly-empty env (KEY=) suppresses the file → the wrapper built-in applies', () => {
    seedConf('CODEX_SERVICE_TIER=priority\nCODEX_REVIEW_MAX_TOTAL_BYTES=2000000\n');
    const won = main([], ctx({ CODEX_SERVICE_TIER: 'priority' }));
    assert.match(won.stdout, /CODEX_SERVICE_TIER = priority\s+\[env\]/);
    // KEY= suppresses the FILE override, so the effective value falls to the built-in DEFAULT — not
    // "absent". For the tier (default null) that renders "(unset — wrapper built-in)"; for the byte cap
    // (default "1500000") it renders the real default, never the suppressed file value.
    const suppressed = main([], ctx({ CODEX_SERVICE_TIER: '', CODEX_REVIEW_MAX_TOTAL_BYTES: '' }));
    assert.match(suppressed.stdout, /CODEX_SERVICE_TIER = \(unset[^\n]*\[default\]/);
    assert.match(suppressed.stdout, /the env KEY= suppresses the file override/);
    assert.match(suppressed.stdout, /CODEX_REVIEW_MAX_TOTAL_BYTES = 1500000\s+\[default\]/);
    assert.doesNotMatch(suppressed.stdout, /CODEX_REVIEW_MAX_TOTAL_BYTES = 2000000/);
  });

  it('flags unknown keys, duplicate keys, and malformed lines (fact-only warnings)', () => {
    seedConf('CODEX_SERVICE_TIER=priority\nCODEX_SERVICE_TIER=priority\nWAT_IS_THIS=1\nnot a valid line\n# a comment\n');
    const r = main([], ctx());
    assert.match(r.stdout, /duplicate keys[^\n]*CODEX_SERVICE_TIER/);
    assert.match(r.stdout, /unknown keys[^\n]*WAT_IS_THIS/);
    assert.match(r.stdout, /malformed lines/);
  });

  it('--json → structured knob/source/duplicate/unknown facts', () => {
    seedConf('CODEX_HARD_TIMEOUT=1200\nBOGUS=x\n');
    const r = main(['--json'], ctx());
    const out = JSON.parse(r.stdout);
    assert.equal(out.fileState, 'present');
    const knob = out.knobs.find((k) => k.key === 'CODEX_HARD_TIMEOUT');
    assert.equal(knob.effective, '1200');
    assert.equal(knob.source, 'file');
    assert.deepEqual(out.unknownKeys, ['BOGUS']);
  });
});

// ── writer: preview / apply ─────────────────────────────────────────────────────────

describe('bridge-settings — writer preview/apply', () => {
  it('a --set preview writes NOTHING (no file created)', () => {
    const r = main(['--set', 'CODEX_SERVICE_TIER=priority'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /preview \(nothing written/);
    assert.equal(existsSync(confPath), false, 'a preview never creates the file');
  });

  it('--apply creates the dir + file atomically with exactly the KEY=VALUE line', () => {
    const r = main(['--set', 'CODEX_SERVICE_TIER=priority', '--apply'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^wrote /);
    assert.equal(readFileSync(confPath, 'utf8'), 'CODEX_SERVICE_TIER=priority\n');
  });

  it('a set carries the credit-rate caveat on the tier (D4)', () => {
    const r = main(['--set', 'CODEX_SERVICE_TIER=priority'], ctx());
    assert.match(r.stdout, /2\.5x credit rate/);
  });

  it('--apply preserves comments + other keys, replacing ONLY the owned line', () => {
    seedConf('# my notes\nAGY_HARD_TIMEOUT=5m\nCODEX_HARD_TIMEOUT=1200\n');
    const r = main(['--set', 'CODEX_HARD_TIMEOUT=1800', '--apply'], ctx());
    assert.equal(r.code, 0);
    assert.equal(readFileSync(confPath, 'utf8'), '# my notes\nAGY_HARD_TIMEOUT=5m\nCODEX_HARD_TIMEOUT=1800\n');
  });

  it('--apply appends a new line when the key is absent', () => {
    seedConf('AGY_HARD_TIMEOUT=5m\n');
    main(['--set', 'CODEX_SERVICE_TIER=priority', '--apply'], ctx());
    assert.equal(readFileSync(confPath, 'utf8'), 'AGY_HARD_TIMEOUT=5m\nCODEX_SERVICE_TIER=priority\n');
  });

  it('--unset removes the owned line, preserving the rest', () => {
    seedConf('CODEX_SERVICE_TIER=priority\nAGY_HARD_TIMEOUT=5m\n');
    const r = main(['--unset', 'CODEX_SERVICE_TIER', '--apply'], ctx());
    assert.equal(r.code, 0);
    assert.equal(readFileSync(confPath, 'utf8'), 'AGY_HARD_TIMEOUT=5m\n');
  });

  it('a no-op set (already that value) writes nothing', () => {
    seedConf('CODEX_SERVICE_TIER=priority\n');
    const r = main(['--set', 'CODEX_SERVICE_TIER=priority', '--apply'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no change/);
  });

  it('multiple ops apply in one atomic write', () => {
    const r = main(['--set', 'CODEX_SERVICE_TIER=priority', '--set', 'AGY_REVIEW_ALLOW_ADDDIR=1', '--apply'], ctx());
    assert.equal(r.code, 0);
    assert.equal(readFileSync(confPath, 'utf8'), 'CODEX_SERVICE_TIER=priority\nAGY_REVIEW_ALLOW_ADDDIR=1\n');
  });

  it('warns when an env var currently shadows the key being set', () => {
    const r = main(['--set', 'CODEX_SERVICE_TIER=priority'], ctx({ CODEX_SERVICE_TIER: 'priority' }));
    assert.match(r.stdout, /CODEX_SERVICE_TIER is currently set in the environment/);
  });

  it('--json carries the spend caveat too (a machine consumer must not miss the credit-rate warning)', () => {
    const preview = JSON.parse(main(['--set', 'CODEX_SERVICE_TIER=priority', '--json'], ctx()).stdout);
    assert.ok(preview.caveats.some((c) => /credit rate|SPEND KNOB/i.test(c)), 'the tier spend caveat rides in --json preview');
    const applied = JSON.parse(main(['--set', 'CODEX_SERVICE_TIER=priority', '--apply', '--json'], ctx()).stdout);
    assert.equal(applied.wrote, true);
    assert.ok(applied.caveats.some((c) => /credit rate|SPEND KNOB/i.test(c)), 'and in --json apply');
  });
});

// ── writer: refusals (the guarded contract) ─────────────────────────────────────────

describe('bridge-settings — writer refusals', () => {
  it('an unknown key → exit 2, nothing written', () => {
    const r = main(['--set', 'NOT_A_KNOB=1', '--apply'], ctx());
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown key "NOT_A_KNOB"/);
    assert.equal(existsSync(confPath), false);
  });

  it('an invalid enum value → exit 2', () => {
    const r = main(['--set', 'CODEX_SERVICE_TIER=turbo', '--apply'], ctx());
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid value "turbo"/);
  });

  it('an out-of-range integer → exit 2 (matches the manifest min/max)', () => {
    assert.equal(main(['--set', 'CODEX_HARD_TIMEOUT=0', '--apply'], ctx()).code, 2);
    assert.equal(main(['--set', 'CODEX_HARD_TIMEOUT=99999999', '--apply'], ctx()).code, 2); // > 86400
    assert.equal(main(['--set', 'CODEX_HARD_TIMEOUT=3600', '--apply'], ctx()).code, 0);
  });

  it('a bare-integer or zero duration → exit 2; a unit duration is accepted', () => {
    assert.equal(main(['--set', 'AGY_HARD_TIMEOUT=300', '--apply'], ctx()).code, 2, 'a unit is required');
    assert.equal(main(['--set', 'AGY_HARD_TIMEOUT=0s', '--apply'], ctx()).code, 2, 'zero disables timeout — refused');
    assert.equal(main(['--set', 'AGY_HARD_TIMEOUT=30m', '--apply'], ctx()).code, 0);
  });

  it('a non-boolean → exit 2; "0"/"1" accepted', () => {
    assert.equal(main(['--set', 'AGY_REVIEW_ALLOW_ADDDIR=2', '--apply'], ctx()).code, 2);
    assert.equal(main(['--set', 'AGY_REVIEW_ALLOW_ADDDIR=1', '--apply'], ctx()).code, 0);
  });

  it('a duplicate-carrying file → exit 1, file byte-untouched (never edits blindly around dups)', () => {
    seedConf('CODEX_SERVICE_TIER=priority\nCODEX_SERVICE_TIER=priority\n');
    const before = readFileSync(confPath, 'utf8');
    const r = main(['--set', 'AGY_HARD_TIMEOUT=30m', '--apply'], ctx());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /duplicate keys[^\n]*CODEX_SERVICE_TIER/);
    assert.equal(readFileSync(confPath, 'utf8'), before, 'the file is left exactly as it was');
  });

  it('a symlinked settings file is READ like the wrappers do, but a WRITE through it is refused (exit 1)', () => {
    mkdirSync(join(tmp, 'agent-workflow'), { recursive: true });
    const real = join(tmp, 'elsewhere.conf');
    writeFileSync(real, 'CODEX_SERVICE_TIER=priority\n');
    symlinkSync(real, confPath);
    // The reader follows the symlink (matches the wrappers): the target's knob is effective.
    assert.match(main([], ctx()).stdout, /CODEX_SERVICE_TIER = priority\s+\[file\]/);
    // A write that CHANGES the file is refused at the atomic layer — a rename would clobber the target.
    const r = main(['--set', 'CODEX_HARD_TIMEOUT=1800', '--apply'], ctx());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /symlink/i);
    assert.equal(readFileSync(real, 'utf8'), 'CODEX_SERVICE_TIER=priority\n', 'the link target is untouched');
  });

  it('--apply combined with --dry-run → usage exit 2', () => {
    assert.equal(main(['--set', 'CODEX_SERVICE_TIER=priority', '--apply', '--dry-run'], ctx()).code, 2);
  });

  it('a duplicate op for the same key → usage exit 2', () => {
    const r = main(['--set', 'CODEX_HARD_TIMEOUT=1200', '--set', 'CODEX_HARD_TIMEOUT=1800'], ctx());
    assert.equal(r.code, 2);
    assert.match(r.stderr, /duplicate op/);
  });

  it('--set without KEY=VALUE → usage exit 2', () => {
    assert.equal(main(['--set', 'CODEX_SERVICE_TIER'], ctx()).code, 2);
  });
});

// ── reconcile (init/upgrade survival check) ─────────────────────────────────────────

describe('bridge-settings — reconcile', () => {
  it('no settings file → a stated skip, exit 0', () => {
    const r = main(['--reconcile'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no settings file — skipped/);
  });

  it('all-current keys → a clean "recognized, all current" line, file byte-unchanged', () => {
    seedConf('CODEX_SERVICE_TIER=priority\nAGY_HARD_TIMEOUT=30m\n');
    const before = readFileSync(confPath, 'utf8');
    const r = main(['--reconcile'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /2 key\(s\) recognized, all current/);
    assert.equal(readFileSync(confPath, 'utf8'), before, 'reconcile never writes the file');
  });

  it('an unknown/retired key → flagged + PRESERVED verbatim (the file is never edited)', () => {
    const body = 'CODEX_SERVICE_TIER=priority\nRETIRED_KNOB=1\n# my note\n';
    seedConf(body);
    const r = main(['--reconcile'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 unknown\/retired key\(s\) preserved verbatim/);
    assert.match(r.stdout, /RETIRED_KNOB/);
    assert.equal(readFileSync(confPath, 'utf8'), body, 'the reconcile flags but never edits — the key stays');
  });

  it('a duplicate-carrying file → flagged, still exit 0, never edited', () => {
    const body = 'CODEX_SERVICE_TIER=priority\nCODEX_SERVICE_TIER=priority\n';
    seedConf(body);
    const r = main(['--reconcile'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /duplicate key\(s\)/);
    assert.equal(readFileSync(confPath, 'utf8'), body);
  });

  it('--reconcile combined with ANY other argument → usage exit 2 (never silently ignored)', () => {
    // A consent-gated writer must not let --reconcile mask a --set/--apply into a no-op the caller
    // thinks wrote, nor silently swallow an unknown flag (codex R1 minor + R2 minor).
    assert.equal(main(['--reconcile', '--set', 'CODEX_SERVICE_TIER=priority', '--apply'], ctx()).code, 2);
    assert.equal(main(['--reconcile', '--apply'], ctx()).code, 2);
    assert.equal(main(['--reconcile', '--bogus'], ctx()).code, 2, 'an unknown flag is rejected, never ignored');
    assert.equal(main(['--reconcile'], ctx()).code, 0, 'bare --reconcile still works');
  });
});

describe('bridge-settings — reader env honesty (codex R1)', () => {
  it('an invalid enum env value (the tier) shows as the built-in default with a note, never as active', () => {
    const r = main([], ctx({ CODEX_SERVICE_TIER: 'turbo' }));
    assert.match(r.stdout, /CODEX_SERVICE_TIER = \(unset[^\n]*\[default\]/);
    assert.match(r.stdout, /env value "turbo" is not a supported CODEX_SERVICE_TIER/);
  });

  it('a non-enum env override is shown as-is (a documented raw override — never dropped)', () => {
    const r = main([], ctx({ CODEX_HARD_TIMEOUT: '2h' }));
    assert.match(r.stdout, /CODEX_HARD_TIMEOUT = 2h\s+\[env\]/);
  });
});

describe('bridge-settings — help', () => {
  it('--help → exit 0 with the settings path + precedence', () => {
    const r = main(['--help'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /bridge-settings\.conf/);
    assert.match(r.stdout, /explicit env[\s\S]*> this file >/);
  });
});
