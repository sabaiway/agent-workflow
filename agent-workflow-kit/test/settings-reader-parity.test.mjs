// settings-reader-parity.test.mjs — the shared bridge-settings reader block must be byte-identical across every bridge
// wrapper. ALL shared functions (the settings reader chain, the AD-061 effective-timeout resolver trio and the
// billing-key scrub) carry the whole host-level settings contract — the allowlist registry, typed validation,
// env>file>default precedence, the warn-once chain, and the banner-honest timeout resolution — and MUST NOT drift
// between wrappers: a drift would let one bridge honor a knob another silently rejects, or validate/render the same
// value two different ways. AW_SETTINGS_APPLIED (the per-wrapper APPLIED subset) is intentionally OUTSIDE the shared
// span — each wrapper applies only its own keys but recognizes the whole registry. The comparator is proven
// non-vacuous by an injected one-token divergence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// The wrappers are derived, never typed (spec jev-every-run): every role source of every capability.json directly
// under a top-level *-bridge/ directory whose first line is a bash shebang; a role without a source fails here. The
// kit mirrors stay sync-mirrors --check's. AW_BRIDGES_ROOT points the discovery at a fixture tree.
const BRIDGES_ROOT = process.env.AW_BRIDGES_ROOT || REPO_ROOT;
const roleSources = (root) => readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-bridge') && existsSync(join(root, entry.name, 'capability.json')))
  .flatMap(({ name }) => Object.entries(JSON.parse(readFileSync(join(root, name, 'capability.json'), 'utf8')).roles ?? {})
    .map(([role, { source }]) => {
      assert.ok(source, `${name}/capability.json role ${role} has no source`);
      return { bridge: name, path: join(root, name, source) };
    }));
const SOURCES = roleSources(BRIDGES_ROOT).filter(({ path }) => /^#!\s*(\/usr\/bin\/env\s+bash|\/bin\/bash)\b/.test(readFileSync(path, 'utf8').split('\n')[0]));
const WRAPPERS = SOURCES.map(({ path }) => path);

// The reader functions that carry the shared settings contract, byte-identical across all wrappers.
// aw_int_in_range is the shared overflow-safe integer bound aw_settings_valid delegates to (Issue-012);
// it lives in the same byte-identical span and its behavioral shell↔JS parity is settings-valid-parity.test.mjs.
// aw_effective_timeout + aw_timeout_label + aw_resolve_timeout_bin are the AD-061
// effective-timeout resolver trio (env-bypass closure, the banner render rule, and the
// shadow-proof absolute-path binary resolution) — same byte-identical discipline, all wrappers.
// aw_read_posture is the host-posture reader (spec bridge-model): one model-key read, all wrappers. aw_scrub_billing_keys
// is the one key rule (spec jev-every-run): every *_API_KEY and OPENAI_BASE_URL unset, TYPESAFE_API_KEY untouched.
const SHARED_FNS = [
  'aw_settings_file', 'aw_settings_known', 'aw_int_in_range', 'aw_settings_valid', 'aw_apply_settings',
  'aw_read_posture', 'aw_effective_timeout', 'aw_timeout_label', 'aw_resolve_timeout_bin', 'aw_scrub_billing_keys',
];

// Extract a top-level `name() {` … column-0 `}` bash function from a wrapper source, verbatim.
const extractBashFn = (source, name) => {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}()`));
  assert.notEqual(start, -1, `wrapper carries a top-level ${name}()`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, `${name}() closes at column 0`);
  return lines.slice(start, end + 1).join('\n');
};

// The whole reader block for one wrapper: all its shared functions joined verbatim.
const readerBlock = (wrapperPath) => SHARED_FNS.map((n) => extractBashFn(readFileSync(wrapperPath, 'utf8'), n)).join('\n');

// The per-wrapper APPLIED subset declared above the reader block.
const appliedSubsetOf = (wrapperPath) => {
  const m = readFileSync(wrapperPath, 'utf8').match(/^AW_SETTINGS_APPLIED="([^"]*)"/m);
  assert.ok(m, `wrapper declares AW_SETTINGS_APPLIED: ${wrapperPath}`);
  return m[1];
};

describe('bridge-settings reader block — byte-identical across every bridge wrapper', () => {
  it('each reader function is byte-identical across every wrapper', () => {
    for (const name of SHARED_FNS) {
      const fns = WRAPPERS.map((w) => extractBashFn(readFileSync(w, 'utf8'), name));
      const [first, ...rest] = fns;
      assert.ok(first.length > 40, `${name}() extraction is non-vacuous`);
      rest.forEach((fn, i) => {
        assert.equal(fn, first, `${name}() has drifted in ${WRAPPERS[i + 1]} — keep the reader block byte-identical`);
      });
    }
  });

  it('the whole reader block (all shared functions) is byte-identical across every bridge wrapper', () => {
    const blocks = WRAPPERS.map(readerBlock);
    const [first, ...rest] = blocks;
    rest.forEach((block, i) => {
      assert.equal(block, first, `reader block drift in ${WRAPPERS[i + 1]} — keep every shared function byte-identical`);
    });
  });

  it('every wrapper calls aw_scrub_billing_keys once, outside its definition', () => {
    assert.ok(WRAPPERS.length >= 2, `the manifests name the wrappers: ${WRAPPERS.join(', ')}`);
    for (const wrapper of WRAPPERS) {
      assert.equal(readFileSync(wrapper, 'utf8').split('\n').filter((line) => /^\s*aw_scrub_billing_keys\b(?!\s*\(\))/.test(line)).length, 1, `${wrapper} calls the key rule once`);
    }
  });

  it('non-vacuous: an injected one-token divergence in the reader block is caught', () => {
    const first = readerBlock(WRAPPERS[0]);
    // A real drift a reviewer must catch: one bridge recognizing a differently-named key.
    const mutated = first.replace('AGY_REVIEW_ALLOW_ADDDIR ', 'AGY_REVIEW_ALLOW_ADDDIR2 ');
    assert.notEqual(mutated, first, 'the mutation applied to the extracted block');
    assert.notEqual(mutated, readerBlock(WRAPPERS[1]), 'a one-token registry drift would fail cross-wrapper parity');
  });

  it('non-vacuous: an injected divergence in the timeout-resolver pair is caught (AD-061)', () => {
    const first = readerBlock(WRAPPERS[0]);
    // A real drift a reviewer must catch: one bridge rendering the missing-binary case differently.
    const mutated = first.replace("printf 'uncapped'", "printf 'nocap'");
    assert.notEqual(mutated, first, 'the mutation applied to aw_timeout_label in the extracted block');
    assert.notEqual(mutated, readerBlock(WRAPPERS[1]), 'a resolver-render drift would fail cross-wrapper parity');
  });

  it('AW_SETTINGS_APPLIED is per-wrapper (intentionally outside the shared span) yet subset of the shared registry', () => {
    const applied = WRAPPERS.map(appliedSubsetOf);
    // The APPLIED subset genuinely varies per wrapper — that is exactly why it is excluded from the
    // byte-identical span (codex-exec ≠ codex-review; agy ≠ agy-review): no two wrappers of one bridge share it.
    for (const bridge of new Set(SOURCES.map((source) => source.bridge))) {
      const subsets = SOURCES.filter((source) => source.bridge === bridge).map(({ path }) => appliedSubsetOf(path));
      assert.equal(new Set(subsets).size, subsets.length, `the wrappers of ${bridge} apply different subsets`);
    }
    // Every applied key must be recognized by the shared aw_settings_known registry.
    const known = extractBashFn(readFileSync(WRAPPERS[0], 'utf8'), 'aw_settings_known');
    for (const subset of applied) {
      for (const key of subset.split(/\s+/).filter(Boolean)) {
        assert.ok(known.includes(` ${key} `), `${key} is present in the shared known-registry`);
      }
    }
  });
});
