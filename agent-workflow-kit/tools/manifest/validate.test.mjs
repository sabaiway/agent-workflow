import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, VALID, UNSUPPORTED, INVALID } from './validate.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const at = (name) => join(FIX, name);

describe('validateManifest — result classes', () => {
  it('valid fixture → valid', () => {
    const r = validateManifest(at('valid'));
    assert.equal(r.result, VALID, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
  });

  it('available:false stub → valid (version + fs existence checks skipped)', () => {
    const r = validateManifest(at('stub'));
    assert.equal(r.result, VALID, r.errors.join('; '));
  });

  it('unknown schema → unsupported (distinct from invalid)', () => {
    const r = validateManifest(at('unknown-schema'));
    assert.equal(r.result, UNSUPPORTED);
  });

  it('a non-object root (JSON null) → invalid, not a crash', () => {
    const r = validateManifest(at('null-root'));
    assert.equal(r.result, INVALID);
    assert.ok(r.errors.some((e) => /must be a JSON object/.test(e)));
  });

  it('reads metadata.version, not a stray top-level version: → valid', () => {
    const r = validateManifest(at('metadata-version'));
    assert.equal(r.result, VALID, r.errors.join('; '));
  });

  it('reads the DIRECT metadata.version, ignoring a deeper nested version: → valid', () => {
    const r = validateManifest(at('nested-version-decoy'));
    assert.equal(r.result, VALID, r.errors.join('; '));
  });

  it('a well-formed typed `settings` block (all four kinds) → valid', () => {
    const r = validateManifest(at('settings-valid'));
    assert.equal(r.result, VALID, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
  });
});

describe('validateManifest — negative fixtures MUST fail (strict)', () => {
  const mustFail = [
    ['malformed-json', /malformed JSON/],
    ['missing-key', /`name` must be a non-empty string/],
    ['provides-roles-mismatch', /missing from `provides`/],
    ['version-mismatch', /`version` "2\.0\.0" != /],
    ['missing-source', /not found in the skill dir/],
    ['detect-array', /`detect\.installed` must be an object/],
    ['win-absolute-source', /must not be an absolute path/],
    ['traversal-source', /must not contain "\.\." traversal/],
    ['bad-available', /`available`, if present, must be a boolean/],
    // Typed `settings` block (bridges 2.3.0, D6): malformed entries FAIL --strict, never ride
    // as tolerated extras — the kit writer and the wrapper shell constants consume this block.
    ['settings-missing-key', /`settings\[0\]`\.key must be an UPPER_SNAKE_CASE string/],
    ['settings-bad-type', /`settings\[0\]`\.kind must be one of enum\|integer\|duration\|boolean/],
    ['settings-bad-default', /`settings\[0\]`\.default must be null or a string value that passes the enum validation/],
    ['settings-invalid-values', /`settings\[0\]`\.values must be a non-empty array of unique non-empty strings/],
    ['settings-duplicate-keys', /duplicate settings key "FIX_DUP"/],
    ['settings-bad-appliesto', /`settings\[0\]`\.appliesTo names "not-a-declared-cmd" which is no roles\.\*\.cmd/],
    ['settings-missing-default', /`settings\[0\]`\.default is required/],
    ['settings-zero-duration', /`settings\[0\]`\.default must be null or a string value that passes the duration validation/],
  ];
  for (const [name, pattern] of mustFail) {
    it(`${name} → invalid`, () => {
      const r = validateManifest(at(name));
      assert.equal(r.result, INVALID);
      assert.ok(
        r.errors.some((e) => pattern.test(e)),
        `expected an error matching ${pattern} in: ${r.errors.join(' | ')}`,
      );
    });
  }
});

describe('validateManifest — path-field hardening', () => {
  it('valid fixture allows a home-relative detect.installed.default (~) but rejects nothing else', () => {
    const r = validateManifest(at('valid'));
    assert.ok(!r.errors.some((e) => /default/.test(e)));
  });
});
