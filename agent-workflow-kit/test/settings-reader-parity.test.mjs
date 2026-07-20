// settings-reader-parity.test.mjs — the shared bridge-settings reader block must be byte-identical
// across all four wrappers (codex-exec, codex-review, agy, agy-review). ALL shared functions
// (the settings reader chain plus the AD-061 effective-timeout resolver trio) carry the whole
// host-level settings contract — the allowlist registry, typed validation, env>file>default
// precedence, the warn-once chain, and the banner-honest timeout resolution — and MUST NOT drift
// between wrappers: a drift would let one bridge honor a knob another silently rejects, or
// validate/render the same value two different ways.
// AW_SETTINGS_APPLIED (the per-wrapper APPLIED subset) is intentionally OUTSIDE the shared span —
// each wrapper applies only its own keys but recognizes the whole registry. The comparator is
// proven non-vacuous by an injected one-token divergence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// The four wrappers that carry the reader block (source-of-truth; the kit mirrors are pinned
// byte-identical to these by bridges-mirror.test.mjs).
const WRAPPERS = [
  join(REPO_ROOT, 'codex-cli-bridge', 'bin', 'codex-exec.sh'),
  join(REPO_ROOT, 'codex-cli-bridge', 'bin', 'codex-review.sh'),
  join(REPO_ROOT, 'antigravity-cli-bridge', 'bin', 'agy.sh'),
  join(REPO_ROOT, 'antigravity-cli-bridge', 'bin', 'agy-review.sh'),
];

// The reader functions that carry the shared settings contract, byte-identical across all wrappers.
// aw_int_in_range is the shared overflow-safe integer bound aw_settings_valid delegates to (Issue-012);
// it lives in the same byte-identical span and its behavioral shell↔JS parity is settings-valid-parity.test.mjs.
// aw_effective_timeout + aw_timeout_label + aw_resolve_timeout_bin are the AD-061
// effective-timeout resolver trio (env-bypass closure, the banner render rule, and the
// shadow-proof absolute-path binary resolution) — same byte-identical discipline, all wrappers.
const SHARED_FNS = [
  'aw_settings_file', 'aw_settings_known', 'aw_int_in_range', 'aw_settings_valid', 'aw_apply_settings',
  'aw_effective_timeout', 'aw_timeout_label', 'aw_resolve_timeout_bin',
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
const readerBlock = (wrapperPath) =>
  SHARED_FNS.map((n) => extractBashFn(readFileSync(wrapperPath, 'utf8'), n)).join('\n');

// The per-wrapper APPLIED subset declared above the reader block.
const appliedSubsetOf = (wrapperPath) => {
  const m = readFileSync(wrapperPath, 'utf8').match(/^AW_SETTINGS_APPLIED="([^"]*)"/m);
  assert.ok(m, `wrapper declares AW_SETTINGS_APPLIED: ${wrapperPath}`);
  return m[1];
};

describe('bridge-settings reader block — byte-identical across the four wrappers', () => {
  it('each reader function is byte-identical across all four wrappers', () => {
    for (const name of SHARED_FNS) {
      const fns = WRAPPERS.map((w) => extractBashFn(readFileSync(w, 'utf8'), name));
      const [first, ...rest] = fns;
      assert.ok(first.length > 40, `${name}() extraction is non-vacuous`);
      rest.forEach((fn, i) => {
        assert.equal(fn, first, `${name}() has drifted in ${WRAPPERS[i + 1]} — keep the reader block byte-identical`);
      });
    }
  });

  it('the whole reader block (all shared functions) is byte-identical across the four wrappers', () => {
    const blocks = WRAPPERS.map(readerBlock);
    const [first, ...rest] = blocks;
    rest.forEach((block, i) => {
      assert.equal(block, first, `reader block drift in ${WRAPPERS[i + 1]} — keep all four functions byte-identical`);
    });
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
    // byte-identical span (codex-exec ≠ codex-review; agy ≠ agy-review).
    assert.notEqual(applied[0], applied[1], 'codex-exec and codex-review apply different subsets');
    assert.notEqual(applied[2], applied[3], 'agy and agy-review apply different subsets');
    // Every applied key must be recognized by the shared aw_settings_known registry.
    const known = extractBashFn(readFileSync(WRAPPERS[0], 'utf8'), 'aw_settings_known');
    for (const subset of applied) {
      for (const key of subset.split(/\s+/).filter(Boolean)) {
        assert.ok(known.includes(` ${key} `), `${key} is present in the shared known-registry`);
      }
    }
  });
});
