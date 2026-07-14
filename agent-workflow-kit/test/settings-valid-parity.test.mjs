// settings-valid-parity.test.mjs — BEHAVIORAL shell↔JS integer-validation parity (Issue-012 / AD-056).
// The wrappers' shell `aw_settings_valid` and the kit's JS `settingValueValid` must agree on EVERY
// value for the two integer settings keys — a value the JS bridge-settings writer accepts is exactly a
// value a wrapper honors, and vice versa. The historical gap: the shell's `(( 10#$v … ))` arithmetic
// wraps modulo 2^64 on a 19+ digit string, so a huge value the JS safe-integer check REJECTS was
// ACCEPTED by the shell. This test executes the REAL extracted shell function against the REAL JS
// import over a fixture matrix that includes the 2^64-wrap value (the gap exposer) and leading-zero
// in-range values (which a naive raw-length guard would wrongly reject).
//
// Non-vacuous by construction: the 2^64-wrap value is asserted REJECTED by both sides; the leading-zero
// in-range value ACCEPTED by both; every fixture's shell verdict must equal the JS verdict; and every
// shell run must be clean (empty stderr, exit ∈ {0,1}) so no bash arithmetic diagnostic/abort leaks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { settingValueValid } from '../tools/manifest/validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CODEX_WRAPPER = join(REPO_ROOT, 'codex-cli-bridge', 'bin', 'codex-review.sh');
const CODEX_CAPABILITY = join(REPO_ROOT, 'codex-cli-bridge', 'capability.json');

// Extract a top-level `name() {` … column-0 `}` bash function from a wrapper, verbatim (the same
// verbatim-function extractor settings-reader-parity.test.mjs uses — the REAL shipped function).
const extractBashFn = (source, name) => {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}()`));
  assert.notEqual(start, -1, `wrapper carries a top-level ${name}()`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, `${name}() closes at column 0`);
  return lines.slice(start, end + 1).join('\n');
};

const wrapperSource = readFileSync(CODEX_WRAPPER, 'utf8');
// aw_settings_valid may call a shared helper (aw_int_in_range) — extract BOTH so the harness runs the
// real logic (a missing helper is a shell "command not found", caught by the clean-exec assertion).
const AW_INT_IN_RANGE = wrapperSource.includes('aw_int_in_range()') ? extractBashFn(wrapperSource, 'aw_int_in_range') : '';
const AW_SETTINGS_VALID = extractBashFn(wrapperSource, 'aw_settings_valid');
const SHELL_FNS = `${AW_INT_IN_RANGE}\n${AW_SETTINGS_VALID}`;

// The two integer keys' REAL min/max bounds, READ from capability.json — never re-hardcoded here.
const settingEntry = (key) => {
  const entry = JSON.parse(readFileSync(CODEX_CAPABILITY, 'utf8')).settings.find((s) => s.key === key);
  assert.ok(entry && entry.kind === 'integer', `${key} is an integer setting in codex-cli-bridge/capability.json`);
  return entry;
};

const INTEGER_KEYS = ['CODEX_HARD_TIMEOUT', 'CODEX_REVIEW_MAX_TOTAL_BYTES'];

// Execute the REAL shell aw_settings_valid KEY VALUE (args passed positionally — never interpolated
// into the script text). Returns { accepted, status, stderr } for the parity + clean-exec assertions.
const shellVerdict = (key, value) => {
  const r = spawnSync('bash', ['-c', `${SHELL_FNS}\naw_settings_valid "$1" "$2"`, 'awtest', key, value], { encoding: 'utf8' });
  return { accepted: r.status === 0, status: r.status, stderr: r.stderr ?? '' };
};

// Literal fixture matrix (Issue-012): in-range / just-over / all-zeros / leading-zero in-range /
// 2^63+ / 2^64-wrap / leading-zero huge / 1000-digit / non-numeric / signed / empty.
const THOUSAND_DIGITS = '1'.repeat(1000);
const FIXTURES = [
  '1', '86400', '86401', '100000000', '100000001', '0', '00000',
  '00000000000000000086400', '9999999999999999999', '9223372036854775810',
  '18446744073709551916', '0018446744073709551916', THOUSAND_DIGITS,
  '12a', '-5', '+5', '',
];

describe('settings integer parity — shell aw_settings_valid ⟷ JS settingValueValid (Issue-012)', () => {
  for (const key of INTEGER_KEYS) {
    const entry = settingEntry(key);
    for (const value of FIXTURES) {
      const label = value === '' ? '<empty>' : value.length > 24 ? `${value.slice(0, 8)}…(${value.length} digits)` : value;
      it(`${key}=${label}: shell verdict === JS verdict, clean shell exec`, () => {
        const shell = shellVerdict(key, value);
        const js = settingValueValid(entry, value);
        assert.equal(shell.stderr, '', `shell emitted a diagnostic for ${key}=${label}: ${shell.stderr}`);
        assert.ok(shell.status === 0 || shell.status === 1, `shell exit must be 0/1 (no arithmetic abort) for ${key}=${label}, got ${shell.status}`);
        assert.equal(shell.accepted, js, `parity break for ${key}=${label}: shell ${shell.accepted ? 'accepted' : 'rejected'}, JS ${js ? 'accepted' : 'rejected'}`);
      });
    }
  }

  it('non-vacuous: the 2^64-wrap value (2^64+300) is REJECTED by BOTH sides (the gap exposer)', () => {
    const entry = settingEntry('CODEX_HARD_TIMEOUT');
    const wrap = '18446744073709551916';
    assert.equal(settingValueValid(entry, wrap), false, 'JS rejects the non-safe-integer wrap value');
    assert.equal(shellVerdict('CODEX_HARD_TIMEOUT', wrap).accepted, false, 'the shell must NOT accept a value that only fits by 64-bit wrap');
  });

  it('non-vacuous: a leading-zero IN-RANGE value (000…086400) is ACCEPTED by BOTH sides', () => {
    const entry = settingEntry('CODEX_HARD_TIMEOUT');
    const leadingZero = '00000000000000000086400';
    assert.equal(settingValueValid(entry, leadingZero), true, 'JS parses leading zeros to the in-range value');
    assert.equal(shellVerdict('CODEX_HARD_TIMEOUT', leadingZero).accepted, true, 'a raw length-guard would wrongly reject this legitimate value');
  });

  it('the all-zeros values (0, 00000) are REJECTED by both (below min) with no shell arithmetic error', () => {
    const entry = settingEntry('CODEX_HARD_TIMEOUT');
    for (const zeros of ['0', '00000']) {
      assert.equal(settingValueValid(entry, zeros), false);
      const shell = shellVerdict('CODEX_HARD_TIMEOUT', zeros);
      assert.equal(shell.accepted, false);
      assert.equal(shell.stderr, '', 'all-zeros must never leak a bash diagnostic');
    }
  });

  // R3-A (second-round review major): an ACCEPTED leading-zero integer value must be EXPORTED in decimal —
  // else a downstream `[[ x -gt $VALUE ]]` reads 000…086400 as OCTAL ("value too great for base").
  // Run the REAL reader block against a settings file and read back the exported integer values.
  const applySettings = (conf, applied, compareGuard) => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'aw-settings-'));
    mkdirSync(join(cfgDir, 'agent-workflow'), { recursive: true });
    writeFileSync(join(cfgDir, 'agent-workflow', 'bridge-settings.conf'), conf);
    const readerBlock = ['aw_settings_file', 'aw_settings_known', 'aw_int_in_range', 'aw_settings_valid', 'aw_apply_settings']
      .map((n) => extractBashFn(wrapperSource, n)).join('\n');
    const echoes = applied.map((k) => `printf '${k}=%s\\n' "$${k}"`).join('\n');
    const script = `set -u
export XDG_CONFIG_HOME=${JSON.stringify(cfgDir)}
unset ${applied.join(' ')} AW_SETTINGS_NOTIFIED
${readerBlock}
AW_SETTINGS_APPLIED=${JSON.stringify(applied.join(' '))}
aw_apply_settings
${echoes}
# The octal trap: an un-normalized leading-zero value aborts this comparison with "value too great for base".
${compareGuard}
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    rmSync(cfgDir, { recursive: true, force: true });
    return r;
  };

  it('R3-A integer settings normalize to decimal not octal downstream', () => {
    const r = applySettings(
      'CODEX_REVIEW_MAX_TOTAL_BYTES=00000000000000000086400\nCODEX_HARD_TIMEOUT=0086400\n',
      ['CODEX_REVIEW_MAX_TOTAL_BYTES', 'CODEX_HARD_TIMEOUT'],
      'if [[ 100 -gt "$CODEX_REVIEW_MAX_TOTAL_BYTES" ]]; then :; fi',
    );
    assert.equal(r.stderr, '', `no bash arithmetic diagnostic in the downstream comparison: ${r.stderr}`);
    assert.match(r.stdout, /MAX_TOTAL_BYTES=86400\b/, 'the leading-zero integer is exported in DECIMAL form (86400), not the raw octal-tripping string');
    assert.match(r.stdout, /HARD_TIMEOUT=86400\b/, 'both integer keys normalize to decimal');
  });

  // Companion angle (also satisfies an earlier classify testId whose regex-special parens selected no
  // test): a DIFFERENT leading-zero value + a different downstream arithmetic guard, same fold.
  it('R3-A integer settings normalize to decimal no octal downstream', () => {
    const r = applySettings(
      'CODEX_HARD_TIMEOUT=000000123\n',
      ['CODEX_HARD_TIMEOUT'],
      'if [[ "$CODEX_HARD_TIMEOUT" -gt 99 ]]; then :; fi',
    );
    assert.equal(r.stderr, '', `no octal abort on the downstream comparison: ${r.stderr}`);
    assert.match(r.stdout, /HARD_TIMEOUT=123\b/, '000000123 exports as the decimal 123, safe in `-gt` arithmetic');
  });
});
