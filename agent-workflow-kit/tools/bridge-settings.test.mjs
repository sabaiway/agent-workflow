import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './bridge-settings.mjs';
import { settingValueValid } from './manifest/validate.mjs';

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

  // D3: recognition alone is not enough. A retired key stays in the registry (so an existing line
  // never warns as unknown) but carries RETIRED metadata, and every reader surface must SAY so —
  // "render as retired" is a different thing from "keep offering".
  it('a RETIRED knob renders as retired wherever the reader shows it', () => {
    seedConf('AGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = main([], ctx());
    assert.equal(r.code, 0);
    const row = r.stdout.split('\n').find((l) => l.includes('AGY_REVIEW_ALLOW_ADDDIR'));
    assert.ok(row, 'the retired key is still listed — recognition is preserved');
    assert.match(r.stdout, /AGY_REVIEW_ALLOW_ADDDIR[\s\S]{0,400}?RETIRED/, 'the row states the retirement');
    assert.doesNotMatch(r.stdout, /unknown keys[^\n]*AGY_REVIEW_ALLOW_ADDDIR/, 'a retired key is never "unknown"');
    const json = main(['--json'], ctx());
    const knob = JSON.parse(json.stdout).knobs.find((k) => k.key === 'AGY_REVIEW_ALLOW_ADDDIR');
    assert.equal(knob.retired !== null && knob.retired !== undefined, true, 'the machine surface carries the stated retirement reason');
    assert.ok(String(knob.retired).length >= 20, 'the reason is stated, not a bare flag');
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
    const r = main(['--set', 'CODEX_SERVICE_TIER=priority', '--set', 'AGY_HARD_TIMEOUT=30m', '--apply'], ctx());
    assert.equal(r.code, 0);
    assert.equal(readFileSync(confPath, 'utf8'), 'CODEX_SERVICE_TIER=priority\nAGY_HARD_TIMEOUT=30m\n');
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
  // D3: the retirement is REGISTRY-DRIVEN, so the writer refuses a NEW --set of a retired key while
  // still letting a user CLEAR an existing line. Both directions matter: refusing --unset would trap
  // the very line the retirement asks the user to remove.
  it('--set refuses the retired key, naming the replacement lane; nothing written', () => {
    const r = main(['--set', 'AGY_REVIEW_ALLOW_ADDDIR=1', '--apply'], ctx());
    assert.equal(r.code, 2);
    assert.match(r.stderr, /AGY_REVIEW_ALLOW_ADDDIR/);
    assert.match(r.stderr, /retired/i);
    assert.equal(existsSync(confPath), false, 'a refused set never writes');
  });

  it('--set refuses the retired key even at its default value (retirement is about the KEY, not the value)', () => {
    const r = main(['--set', 'AGY_REVIEW_ALLOW_ADDDIR=0', '--apply'], ctx());
    assert.equal(r.code, 2);
    assert.match(r.stderr, /retired/i);
  });

  it('--unset still clears the retired key (the stated recovery must work)', () => {
    seedConf('AGY_HARD_TIMEOUT=5m\nAGY_REVIEW_ALLOW_ADDDIR=1\n');
    const r = main(['--unset', 'AGY_REVIEW_ALLOW_ADDDIR', '--apply'], ctx());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(confPath, 'utf8'), 'AGY_HARD_TIMEOUT=5m\n');
  });

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

  // The registry's ONLY boolean key is now RETIRED, so the writer refuses it before the value rule is
  // even reached (proven above). The boolean rule itself is asserted against the shared predicate the
  // writer, the validator and the wrappers' aw_settings_valid all share — the rule outlives the key.
  it('the boolean value rule still holds where it is reachable ("0"/"1" only)', () => {
    assert.equal(main(['--set', 'AGY_REVIEW_ALLOW_ADDDIR=2', '--apply'], ctx()).code, 2);
    assert.equal(main(['--set', 'AGY_REVIEW_ALLOW_ADDDIR=1', '--apply'], ctx()).code, 2, 'retired: refused whatever the value');
    const boolEntry = { key: 'PROBE_BOOL', kind: 'boolean' };
    assert.equal(settingValueValid(boolEntry, '0'), true);
    assert.equal(settingValueValid(boolEntry, '1'), true);
    assert.equal(settingValueValid(boolEntry, '2'), false);
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

  // A key NO bundled manifest declares at all — distinct from a manifest-RETIRED one, which has its
  // own line below (the two have different recoveries: delete a stale line vs clear a dead knob).
  it('an UNKNOWN key → flagged + PRESERVED verbatim (the file is never edited)', () => {
    const body = 'CODEX_SERVICE_TIER=priority\nNO_SUCH_KNOB=1\n# my note\n';
    seedConf(body);
    const r = main(['--reconcile'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 unknown key\(s\) preserved verbatim/);
    assert.match(r.stdout, /NO_SUCH_KNOB/);
    assert.equal(readFileSync(confPath, 'utf8'), body, 'the reconcile flags but never edits — the key stays');
  });

  // A key the manifest RETIRED is still `registry.has(key)`, so the survival check used to file it
  // under "recognized, all current" — the opposite of what the retirement contract promises. A dead
  // knob must read as a dead knob on the one surface init/upgrade shows the user.
  it('a manifest-RETIRED key is flagged as retired, never "all current"', () => {
    const body = 'CODEX_SERVICE_TIER=priority\nAGY_REVIEW_ALLOW_ADDDIR=1\n';
    seedConf(body);
    const r = main(['--reconcile'], ctx());
    assert.equal(r.code, 0);
    assert.match(r.stdout, /AGY_REVIEW_ALLOW_ADDDIR/, 'the dead knob is named');
    assert.match(r.stdout, /retired/i, 'and called retired');
    assert.doesNotMatch(r.stdout, /2 key\(s\) recognized, all current/, 'never filed as current');
    assert.equal(readFileSync(confPath, 'utf8'), body, 'reconcile still never edits the file');
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
    // thinks wrote, nor silently swallow an unknown flag.
    assert.equal(main(['--reconcile', '--set', 'CODEX_SERVICE_TIER=priority', '--apply'], ctx()).code, 2);
    assert.equal(main(['--reconcile', '--apply'], ctx()).code, 2);
    assert.equal(main(['--reconcile', '--bogus'], ctx()).code, 2, 'an unknown flag is rejected, never ignored');
    assert.equal(main(['--reconcile'], ctx()).code, 0, 'bare --reconcile still works');
  });
});

describe('bridge-settings — reader env honesty (review-bridge-settings-r01-major-03)', () => {
  it('an invalid enum env value (the tier) shows as the built-in default with a note, never as active', () => {
    const r = main([], ctx({ CODEX_SERVICE_TIER: 'turbo' }));
    assert.match(r.stdout, /CODEX_SERVICE_TIER = \(unset[^\n]*\[default\]/);
    assert.match(r.stdout, /env value "turbo" is not a supported CODEX_SERVICE_TIER/);
  });

  it('an INVALID timeout env value shows as the built-in default with a note (AD-061 — the resolver validates env)', () => {
    const r = main([], ctx({ CODEX_HARD_TIMEOUT: '2h' }));
    assert.match(r.stdout, /CODEX_HARD_TIMEOUT = \(unset[^\n]*\[default\]/);
    assert.match(r.stdout, /env value "2h" is invalid for CODEX_HARD_TIMEOUT/);
  });

  it('a VALID timeout env value and a non-resolver-validated raw override both show as env', () => {
    const r = main([], ctx({ CODEX_HARD_TIMEOUT: '7200', CODEX_REVIEW_MAX_TOTAL_BYTES: 'weird' }));
    assert.match(r.stdout, /CODEX_HARD_TIMEOUT = 7200\s+\[env\]/);
    assert.match(r.stdout, /CODEX_REVIEW_MAX_TOTAL_BYTES = weird\s+\[env\]/);
  });

  it('a control byte in an env knob renders a REFUSAL note with NO raw byte + no forged posture line (review r05)', () => {
    const r = main([], ctx({ CODEX_HARD_TIMEOUT: '1800\x01\nreview posture: model=FORGED' }));
    assert.match(r.stdout, /REFUSES the run pre-spend/, 'the advisor states the wrapper refusal');
    assert.doesNotMatch(r.stdout, /[\x01\x7f]/, 'no raw control byte reaches the rendered report');
    assert.doesNotMatch(r.stdout, /^review posture: model=FORGED/m, 'an embedded newline cannot forge a posture line');
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
