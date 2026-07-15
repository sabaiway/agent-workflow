import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, VALID, UNSUPPORTED, INVALID, CATALOG_LINE_MAX } from './validate.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const at = (name) => join(FIX, name);
const manifestOf = (name) => JSON.parse(readFileSync(join(at(name), 'capability.json'), 'utf8'));

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

  it('a well-formed `networkHosts` list (wildcard family + exact hosts) → valid', () => {
    const r = validateManifest(at('network-hosts-valid'));
    assert.equal(r.result, VALID, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
  });

  it('a well-formed `writableDirs` list (env-overridable tilde default + env-less absolute) → valid', () => {
    const r = validateManifest(at('writable-dirs-valid'));
    assert.equal(r.result, VALID, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
  });

  // BRIDGE-MODES-CATALOG (D1/D2/D4/D6): `modeCatalog` is the additive-optional, typed, top-level
  // user-facing mode catalog. This fixture IS the binding shape — every entry kind, plural
  // composition-by-reference, the contract-free literal descriptor, typed operands, structured
  // guardrails, and the customHooks ⟷ parents linkage.
  it('a well-formed typed `modeCatalog` block (every entry kind, refs + literal descriptor) → valid', () => {
    const r = validateManifest(at('mode-catalog-valid'));
    assert.equal(r.result, VALID, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
  });

  it('an ABSENT `modeCatalog` → valid (additive-optional: a bridge predating the catalog stays valid)', () => {
    assert.ok(!Object.hasOwn(manifestOf('valid'), 'modeCatalog'), 'the valid fixture must carry no catalog — else this is vacuous');
    assert.equal(validateManifest(at('valid')).result, VALID);
  });

  it('the binding fixture really exercises every entry kind (non-vacuity)', () => {
    const kinds = manifestOf('mode-catalog-valid').modeCatalog.map((e) => e.kind);
    assert.deepEqual([...new Set(kinds)].sort(), ['continuation', 'env-hook', 'primary']);
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
    // `networkHosts` (AD-044 Plan 4): entries are pasted verbatim into hand-applied allowlist
    // lines, so a malformed list fails --strict like `settings` — never a tolerated extra.
    ['network-hosts-bad-entry', /`networkHosts\[0\]` must be a bare hostname or a \*\.family wildcard/],
    ['network-hosts-duplicate', /duplicate networkHosts entry "\*\.chatgpt\.com"/],
    ['network-hosts-empty', /`networkHosts` must be a non-empty array of host strings/],
    // `writableDirs` (REC-UX-REWORK, D6): {env, default} entries the advisor RESOLVES and renders
    // into the sandbox-lane recipe — malformed entries fail --strict like networkHosts.
    ['writable-dirs-bad-entry', /`writableDirs\[0\]`\.default must be a `~\/`-anchored or absolute POSIX path/],
    ['writable-dirs-bad-entry', /`writableDirs\[0\]`\.env must be null or an UPPER_SNAKE_CASE env-var name/],
    ['writable-dirs-bad-path', /`writableDirs\[0\]`\.default must not carry glob characters/],
    ['writable-dirs-bad-path', /`writableDirs\[1\]`\.default must not end with a trailing slash/],
    ['writable-dirs-bad-path', /`writableDirs\[2\]`\.default must not contain "\.\." traversal/],
    ['writable-dirs-bad-path', /`writableDirs\[3\]` must be an \{env, default\} object/],
    ['writable-dirs-bad-path', /`writableDirs\[4\]`\.default must not carry control characters/],
    ['writable-dirs-duplicate', /duplicate writableDirs default "~\/\.fixture"/],
    ['writable-dirs-empty', /`writableDirs` must be a non-empty array of \{env, default\} entries/],
    // `modeCatalog` (BRIDGE-MODES-CATALOG, D1): the block is rendered as a user-facing discovery
    // surface, so a malformed entry FAILS --strict like `settings` — never a tolerated extra. One
    // red rule per line: this matrix IS the executable schema spec.
    ['mode-catalog-bad-shape', /`modeCatalog` must be an array of mode entries/],
    // Presence is keyed on the KEY, not on non-null — an explicit null is a PRESENT malformed
    // block, and an empty array is the silent empty list D1 forbids.
    ['mode-catalog-null', /`modeCatalog` must be an array of mode entries/],
    ['mode-catalog-empty', /`modeCatalog` must not be empty/],
    ['mode-catalog-bad-entries', /`modeCatalog\[0\]` must be an object/],
    ['mode-catalog-bad-entries', /`modeCatalog\[1\]`\.key must be a bare token/],
    ['mode-catalog-bad-entries', /duplicate modeCatalog key "review\.code" \(`modeCatalog\[3\]`\)/],
    ['mode-catalog-bad-entries', /`modeCatalog\[4\]`\.kind must be one of primary\|continuation\|env-hook/],
    ['mode-catalog-bad-entries', /`modeCatalog\[5\]`\.key must be an UPPER_SNAKE_CASE env-var name/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[1\]`\.role is required for a primary entry/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[2\]`\.role "synthesize" is no role of this manifest/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[3\]`\.role is not allowed on an env-hook/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[4\]`\.parents is required for an env-hook/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[5\]`\.parents names "nope" which is no modeCatalog key/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[6\]`\.parents is only allowed on an env-hook/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[7\]`\.submode is required/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[8\]`\.submode "nope" is no declared mode of role "review"/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[9\]`\.submode is only allowed when the entry's role declares modes\[\]/],
    ['mode-catalog-bad-linkage', /`modeCatalog\[10\]`\.submode is only allowed on a primary entry/],
    ['mode-catalog-bad-invocations', /duplicate modeCatalog invocation reference review\.invocations\[0\] \(`modeCatalog\[1\]`\)/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[2\]`\.invocationRefs\[0\] does not resolve \(roles\.review\.contract\.continue\[7\]\)/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[3\]`\.invocationRefs\[0\]\.contractField must be one of invocations\|continue/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[4\]`\.invocationRefs is required \(non-empty\) for a contract-backed entry/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[5\]`\.descriptor is only allowed on a contract-free primary or an env-hook/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[6\]`\.descriptor is required/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[7\]`\.invocationRefs\[0\] must be a \{contractField, index\} object/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[8\]`\.invocationRefs\[0\]\.index must be a non-negative integer/],
    // The kind BINDS the contract field, and the literal-descriptor exception (D6) covers
    // contract-free PRIMARIES and env-hooks only — never a continuation.
    ['mode-catalog-bad-invocations', /`modeCatalog\[9\]`\.invocationRefs\[0\]\.contractField must be "invocations" for a primary entry/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[10\]`\.invocationRefs\[0\]\.contractField must be "continue" for a continuation entry/],
    ['mode-catalog-bad-invocations', /`modeCatalog\[11\]`: a continuation must be contract-backed/],
    ['mode-catalog-bad-operands', /`modeCatalog\[0\]`\.operands\[0\]\.slot must be a non-empty string/],
    ['mode-catalog-bad-operands', /duplicate operand slot "<prompt>" \(`modeCatalog\[1\]`\.operands\[1\]\)/],
    ['mode-catalog-bad-operands', /`modeCatalog\[2\]`\.operands\[0\]\.required must be a boolean/],
    ['mode-catalog-bad-operands', /`modeCatalog\[3\]`\.operands\[0\]\.slot "<nowhere>" is not a rendered placeholder/],
    // The rule is TWO-WAY: an undeclared placeholder is as dishonest as an invented slot — either
    // way the render claims a form is ready to run while the reader cannot fill it.
    ['mode-catalog-bad-operands', /`modeCatalog\[7\]`\.operands is required because its invocation forms contain rendered operand slots/],
    ['mode-catalog-bad-operands', /`modeCatalog\[8\]`\.operands is missing rendered slot "<model>"/],
    ['mode-catalog-bad-operands', /`modeCatalog\[9\]`\.operands\[1\]\.slot "fixture-run" is not a rendered placeholder/],
    ['mode-catalog-bad-operands', /`modeCatalog\[4\]`\.operands must be an array of typed operand slots/],
    ['mode-catalog-bad-operands', /`modeCatalog\[5\]`\.operands\[0\]\.description must be a non-empty string/],
    ['mode-catalog-bad-operands', /`modeCatalog\[6\]`\.operands\[0\] must be a \{slot, required, description\} object/],
    ['mode-catalog-bad-guardrails', /`modeCatalog\[0\]`\.guardrails\[0\]\.enforcement must be one of enforced\|advisory/],
    ['mode-catalog-bad-guardrails', /`modeCatalog\[1\]`\.guardrails\[0\]\.value must be a non-empty string/],
    ['mode-catalog-bad-guardrails', /`modeCatalog\[2\]`\.guardrails\[0\]\.source must be a non-empty string/],
    ['mode-catalog-bad-guardrails', /`modeCatalog\[3\]`\.guardrails must be an array of typed guardrail entries/],
    ['mode-catalog-bad-guardrails', /`modeCatalog\[4\]`\.guardrails\[0\]\.condition must be a non-empty string/],
    ['mode-catalog-bad-guardrails', /`modeCatalog\[5\]`\.guardrails\[0\] must be a \{value, enforcement, condition\?, source\} object/],
    ['mode-catalog-bad-hooks', /`modeCatalog\[1\]`\.customHooks names "NOPE" which is no modeCatalog key/],
    ['mode-catalog-bad-hooks', /`modeCatalog\[2\]`\.customHooks may name this entry itself only on a contract-free primary/],
    ['mode-catalog-bad-hooks', /`modeCatalog\[3\]`\.customHooks names "ok-raw", which is neither an env-hook nor this entry itself/],
    ['mode-catalog-bad-hooks', /`modeCatalog\[4\]`\.customHooks names env-hook "HOOK_X", which does not list "lying-hook" in its parents\[\]/],
    ['mode-catalog-bad-hooks', /duplicate customHook "HOOK_X" \(`modeCatalog\[5\]`\)/],
    ['mode-catalog-bad-hooks', /`modeCatalog\[7\]`\.customHooks must be a non-empty array of modeCatalog keys/],
    // The parents ⟷ customHooks linkage is SYMMETRIC: a hook that claims a mode must be declared by
    // that mode, or the discovery surface silently omits a hook that really modifies it.
    ['mode-catalog-bad-hooks', /`modeCatalog\[9\]`\.parents names "orphan-parent", which does not list "HOOK_ORPHAN" in its customHooks\[\]/],
    ['mode-catalog-bad-hooks', /duplicate parent "orphan-parent" \(`modeCatalog\[9\]`\)/],
    ['mode-catalog-bad-hooks', /`modeCatalog\[10\]`\.parents names "HOOK_ORPHAN", which is an env-hook — a hook modifies a mode, never another hook/],
    ['mode-catalog-bad-hooks', /`modeCatalog\[11\]`\.parents must not name the env-hook itself/],
    ['mode-catalog-bad-strings', /`modeCatalog\[0\]`\.purpose must be one line of at most 200 characters/],
    ['mode-catalog-bad-strings', /`modeCatalog\[1\]`\.purpose must not carry control characters/],
    ['mode-catalog-bad-strings', /`modeCatalog\[2\]`\.whenToUse must be a non-empty array of one-line strings/],
    ['mode-catalog-bad-strings', /`modeCatalog\[3\]`\.whenToUse must be a non-empty array of one-line strings/],
    ['mode-catalog-bad-strings', /`modeCatalog\[4\]`\.guardrails\[0\]\.value must be one line of at most 200 characters/],
    ['mode-catalog-bad-strings', /`modeCatalog\[5\]`\.descriptor must not carry control characters/],
    // Every identifier and every form the renderer PRINTS obeys the same one-line contract — a form
    // reached through invocationRefs is printed exactly like a literal descriptor.
    ['mode-catalog-bad-strings', /`modeCatalog\[6\]`\.key must be one line of at most 200 characters/],
    ['mode-catalog-bad-strings', /`modeCatalog\[7\]`\.submode must be a non-empty string/],
    ['mode-catalog-bad-strings', /`modeCatalog\[8\]`\.invocationRefs\[0\] → roles\.review\.contract\.invocations\[0\] must not carry control characters/],
    ['mode-catalog-bad-strings', /`modeCatalog\[9\]`\.invocationRefs\[0\] → roles\.review\.contract\.invocations\[1\] must be one line of at most 200 characters/],
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

describe('validateManifest — modeCatalog string caps', () => {
  it('the over-cap fixture sits exactly one character over the EXPORTED cap (non-vacuity)', () => {
    const catalog = manifestOf('mode-catalog-bad-strings').modeCatalog;
    assert.equal(catalog[0].purpose.length, CATALOG_LINE_MAX + 1);
    assert.equal(catalog[4].guardrails[0].value.length, CATALOG_LINE_MAX + 1);
  });

  it('every string the binding fixture renders is within the cap (the cap is livable)', () => {
    for (const entry of manifestOf('mode-catalog-valid').modeCatalog) {
      for (const s of [entry.purpose, entry.descriptor, ...(entry.whenToUse ?? []), ...(entry.whenNotTo ?? [])]) {
        if (typeof s === 'string') assert.ok(s.length <= CATALOG_LINE_MAX, `over cap: ${s}`);
      }
    }
  });
});

describe('validateManifest — path-field hardening', () => {
  it('valid fixture allows a home-relative detect.installed.default (~) but rejects nothing else', () => {
    const r = validateManifest(at('valid'));
    assert.ok(!r.errors.some((e) => /default/.test(e)));
  });
});
