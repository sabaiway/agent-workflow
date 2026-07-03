// review-fingerprint-parity.test.mjs — the AD-038 cross-implementation fingerprint proof: ONE
// fixture repo state must fingerprint byte-identically through (a) the codex wrapper's bash
// helpers, (b) the agy wrapper's bash helpers, and (c) the kit checker's node implementation
// (tools/review-state.mjs). The bash helpers are extracted from the REAL wrapper sources (never a
// re-typed copy), their text is asserted byte-identical across the two wrappers, and the whole
// comparator is proven non-vacuous by an injected serialization divergence. Domain equality (the
// fingerprint covers exactly the review-payload domain — staged + unstaged + untracked-not-ignored
// contents) is proven behaviorally: an in-domain edit moves BOTH the review payload and the
// fingerprint; an out-of-domain edit (gitignored, binary content) moves NEITHER.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeTreeFingerprint, computeFingerprintPayload } from '../tools/review-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CODEX_WRAPPER = join(REPO_ROOT, 'codex-cli-bridge', 'bin', 'codex-review.sh');
const AGY_WRAPPER = join(REPO_ROOT, 'antigravity-cli-bridge', 'bin', 'agy-review.sh');

// Extract a top-level `name() {` … column-0 `}` bash function from a wrapper source, verbatim.
const extractBashFn = (source, name) => {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}()`));
  assert.notEqual(start, -1, `wrapper carries a top-level ${name}()`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, `${name}() closes at column 0`);
  return lines.slice(start, end + 1).join('\n');
};

// The shared helper set both wrappers must carry byte-identically (write_review_receipt included —
// the receipt line shape is part of the cross-wrapper contract).
const SHARED_FNS = ['is_binary', 'sha256_stdin', 'emit_fingerprint_payload', 'compute_tree_fingerprint', 'receipt_json_scalar', 'write_review_receipt'];
const FINGERPRINT_FNS = ['is_binary', 'sha256_stdin', 'emit_fingerprint_payload', 'compute_tree_fingerprint'];

const fnsFrom = (wrapperPath, names) => {
  const source = readFileSync(wrapperPath, 'utf8');
  return names.map((n) => extractBashFn(source, n)).join('\n');
};

// Run the REAL extracted bash helpers in a repo → the fingerprint hex (or a payload dump).
const bashEval = (script, cwd) => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `bash helper run failed: ${r.stderr}`);
  return r.stdout.replace(/\n$/, '');
};
const bashFingerprint = (wrapperPath, cwd) => bashEval(`${fnsFrom(wrapperPath, FINGERPRINT_FNS)}\ncompute_tree_fingerprint`, cwd);

let root;
before(() => {
  // ONE rich fixture: staged + unstaged tracked changes, an untracked text file (subdir too), an
  // untracked binary, an untracked symlink, and a GITIGNORED file (out of domain by definition).
  root = mkdtempSync(join(tmpdir(), 'fp-parity-'));
  const g = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  g('init', '-q');
  g('config', 'user.email', 'probe@example.com');
  g('config', 'user.name', 'probe');
  writeFileSync(join(root, 'tracked-a.txt'), 'alpha v1\n');
  writeFileSync(join(root, 'tracked-b.txt'), 'beta v1\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.log\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  writeFileSync(join(root, 'tracked-a.txt'), 'alpha v2 — staged\n');
  g('add', 'tracked-a.txt');
  writeFileSync(join(root, 'tracked-b.txt'), 'beta v2 — unstaged\n');
  writeFileSync(join(root, 'untracked.txt'), 'untracked body\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'nested-untracked.txt'), 'nested body\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0x42, 0x00, 0x01, 0xff, 0x00, 0x07]));
  symlinkSync('untracked.txt', join(root, 'link-to-untracked'));
  writeFileSync(join(root, 'ignored.log'), 'gitignored — outside the review payload\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('fingerprint parity — one fixture state, three implementations, one hash', () => {
  it('the shared bash helper set is byte-identical across the two wrappers', () => {
    for (const name of SHARED_FNS) {
      const codex = extractBashFn(readFileSync(CODEX_WRAPPER, 'utf8'), name);
      const agy = extractBashFn(readFileSync(AGY_WRAPPER, 'utf8'), name);
      assert.equal(codex, agy, `${name}() has drifted between codex-review.sh and agy-review.sh — keep the block byte-identical`);
      assert.ok(codex.length > 40, `${name}() extraction is non-vacuous`);
    }
  });

  it('codex bash == agy bash == node — byte-identical fingerprint over the rich fixture', () => {
    const fromCodex = bashFingerprint(CODEX_WRAPPER, root);
    const fromAgy = bashFingerprint(AGY_WRAPPER, root);
    const fromNode = computeTreeFingerprint(root);
    assert.match(fromCodex, /^[0-9a-f]{64}$/, 'a real sha256');
    assert.equal(fromCodex, fromAgy, 'codex ⟷ agy fingerprint parity');
    assert.equal(fromCodex, fromNode, 'bash ⟷ node fingerprint parity');
  });

  it('a subdirectory invocation fingerprints the same bytes (root-anchored in all implementations)', () => {
    const sub = join(root, 'sub');
    assert.equal(bashFingerprint(CODEX_WRAPPER, sub), bashFingerprint(CODEX_WRAPPER, root));
    assert.equal(computeTreeFingerprint(sub), computeTreeFingerprint(root));
  });

  it('non-vacuous: an injected serialization divergence in the bash twin is caught', () => {
    const mutated = fnsFrom(CODEX_WRAPPER, FINGERPRINT_FNS).replace("printf 'untracked:%s\\n'", "printf 'untracked;%s\\n'");
    assert.notEqual(mutated, fnsFrom(CODEX_WRAPPER, FINGERPRINT_FNS), 'the mutation applied');
    const diverged = bashEval(`${mutated}\ncompute_tree_fingerprint`, root);
    assert.notEqual(diverged, computeTreeFingerprint(root), 'a one-byte serialization drift changes the hash — the comparator would catch it');
  });
});

describe('fingerprint domain == review-payload domain (behavioral proof)', () => {
  // The review payload as the wrappers assemble it (assemble_code_diff extracted from the source).
  const reviewPayload = () => bashEval(`${fnsFrom(CODEX_WRAPPER, ['is_binary', 'assemble_code_diff'])}\nassemble_code_diff`, root);

  it('an IN-domain edit (untracked content) moves BOTH the review payload and the fingerprint', () => {
    const payloadBefore = reviewPayload();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'untracked.txt'), 'untracked body EDITED\n');
    const payloadAfter = reviewPayload();
    const fpAfter = computeTreeFingerprint(root);
    writeFileSync(join(root, 'untracked.txt'), 'untracked body\n'); // restore
    assert.notEqual(payloadBefore, payloadAfter, 'the review payload sees the edit');
    assert.notEqual(fpBefore, fpAfter, 'the fingerprint sees the edit');
  });

  it('an OUT-of-domain edit (gitignored file) moves NEITHER', () => {
    const payloadBefore = reviewPayload();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'ignored.log'), 'gitignored EDITED — still outside both\n');
    assert.equal(reviewPayload(), payloadBefore, 'the review payload never contained it');
    assert.equal(computeTreeFingerprint(root), fpBefore, 'the fingerprint never covered it (the recorded HIDDEN-mode residual)');
  });

  it('an untracked BINARY content edit moves NEITHER (both carry the name-only note)', () => {
    const payloadBefore = reviewPayload();
    const fpBefore = computeTreeFingerprint(root);
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0x99, 0x00, 0x55, 0x00]));
    assert.equal(reviewPayload(), payloadBefore, 'binary contents are skipped in the payload');
    assert.equal(computeTreeFingerprint(root), fpBefore, 'and skipped identically in the fingerprint');
    assert.match(payloadBefore, /untracked \(binary, skipped\): binary\.bin/, 'the payload notes the binary by name');
  });

  it('the node payload equals the bash payload byte-for-byte (serialization, not just hash)', () => {
    const fromBash = bashEval(`${fnsFrom(CODEX_WRAPPER, FINGERPRINT_FNS)}\nemit_fingerprint_payload`, root);
    const fromNode = computeFingerprintPayload(root).toString('utf8').replace(/\n$/, '');
    assert.equal(fromNode, fromBash);
  });
});
