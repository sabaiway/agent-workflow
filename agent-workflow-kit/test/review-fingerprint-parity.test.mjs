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
// the receipt line shape is part of the cross-wrapper contract; the never-committable filter
// family + assemble_code_diff joined with AD-044 Plan 4 — the whole review domain is lockstep).
const SHARED_FNS = [
  'is_binary',
  'sha256_stdin',
  'is_never_committable_untracked',
  'emit_untracked_paths_z',
  'has_reviewable_untracked',
  'emit_status_porcelain_filtered',
  'warn_never_committable_untracked',
  'emit_fingerprint_payload',
  'compute_tree_fingerprint',
  'receipt_json_scalar',
  'write_review_receipt',
  'assemble_code_diff',
];
const FINGERPRINT_FNS = ['is_binary', 'sha256_stdin', 'is_never_committable_untracked', 'emit_untracked_paths_z', 'emit_fingerprint_payload', 'compute_tree_fingerprint'];
const ASSEMBLE_FNS = ['is_binary', 'is_never_committable_untracked', 'emit_untracked_paths_z', 'emit_status_porcelain_filtered', 'assemble_code_diff'];
const PREFLIGHT_FNS = ['is_never_committable_untracked', 'emit_untracked_paths_z', 'has_reviewable_untracked'];

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
  const reviewPayload = () => bashEval(`${fnsFrom(CODEX_WRAPPER, ASSEMBLE_FNS)}\nassemble_code_diff`, root);

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

// ── the never-committable review-domain filter, wrapper level (AD-044 Plan 4, Decision 1) ────────
// Probe-proven constraint: on a regular filesystem git's own dir walk does NOT list FIFOs/devices
// as untracked — the mask class exists only where the sandbox's dirent LIES to git. So these tests
// SHADOW `git` with a bash function that injects a crafted path into the walk (and the porcelain
// status) while the path on disk is a REAL FIFO — the real predicate (`-p`) classifies it, the real
// filter drops it. Non-vacuity: the same shadow injecting a REGULAR file MOVES the fingerprint, so
// the injection demonstrably reaches the domain. The true end-to-end mask proof is the in-sandbox
// behavioral verify after release (the plan's Verification).
describe('never-committable filter — both wrappers, shadowed git walk, real FIFO on disk', () => {
  let mroot;
  const FIFO_NAME = 'ctl-mask.fifo';
  const FIFO_SPACES = 'ctl-mask with spaces';
  const REG_NAME = 'ctl-regular.txt';
  const QUOTED_NAME = 'wei"rd name.txt';

  // A `git` shadow: the real git PLUS the injected path in the untracked walk + the status output +
  // the per-path status probe — exactly what the sandbox's lying dirent makes real git do.
  const shadow = (injectPath) => `INJECT_PATH=${JSON.stringify(injectPath)}
git() {
  case "$*" in
    'ls-files --others --exclude-standard -z')
      command git "$@"
      printf '%s\\0' "$INJECT_PATH"
      ;;
    'status --porcelain=v1')
      command git "$@"
      printf '?? %s\\n' "$INJECT_PATH"
      ;;
    "status --porcelain=v1 -- :(literal)$INJECT_PATH")
      printf '?? %s\\n' "$INJECT_PATH"
      ;;
    *) command git "$@" ;;
  esac
}`;

  before(() => {
    mroot = mkdtempSync(join(tmpdir(), 'fp-mask-'));
    const g = (...args) => {
      const r = spawnSync('git', args, { cwd: mroot, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    };
    g('init', '-q');
    g('config', 'user.email', 'probe@example.com');
    g('config', 'user.name', 'probe');
    writeFileSync(join(mroot, 'tracked.txt'), 'tracked v1\n');
    writeFileSync(join(mroot, '.gitignore'), 'ctl-*\n'); // ctl-* stays OUT of the real walk — only the shadow injects it
    g('add', '-A');
    g('commit', '-qm', 'base');
    writeFileSync(join(mroot, 'tracked.txt'), 'tracked v2 — a real tracked change\n');
    writeFileSync(join(mroot, 'plain.txt'), 'plain untracked\n');
    writeFileSync(join(mroot, QUOTED_NAME), 'a real untracked file with a quoted+spaced name\n');
    writeFileSync(join(mroot, REG_NAME), 'regular control body — must move the domain when injected\n');
    for (const fifo of [FIFO_NAME, FIFO_SPACES]) {
      const r = spawnSync('mkfifo', [join(mroot, fifo)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `mkfifo ${fifo}: ${r.stderr}`);
    }
  });
  after(() => rmSync(mroot, { recursive: true, force: true }));

  const fingerprintShadowed = (wrapper, injectPath) =>
    bashEval(`${shadow(injectPath)}\n${fnsFrom(wrapper, FINGERPRINT_FNS)}\ncompute_tree_fingerprint`, mroot);
  const assembleShadowed = (wrapper, injectPath) =>
    bashEval(`${shadow(injectPath)}\n${fnsFrom(wrapper, ASSEMBLE_FNS)}\nassemble_code_diff`, mroot);

  it('(i) the fingerprint is byte-identical with and without an injected FIFO — both wrappers (+ node agrees)', () => {
    for (const wrapper of [CODEX_WRAPPER, AGY_WRAPPER]) {
      const baseline = bashFingerprint(wrapper, mroot);
      assert.equal(fingerprintShadowed(wrapper, FIFO_NAME), baseline, 'a walk-visible FIFO leaves the fingerprint unmoved');
      assert.equal(fingerprintShadowed(wrapper, FIFO_SPACES), baseline, 'spaces in the mask name change nothing');
      assert.notEqual(fingerprintShadowed(wrapper, REG_NAME), baseline, 'NON-VACUOUS: the same shadow injecting a REGULAR file moves the fingerprint');
      assert.equal(baseline, computeTreeFingerprint(mroot), 'bash ⟷ node parity holds on this fixture');
    }
  });

  it('(iii) a tree whose ONLY untracked path is filtered-class reads clean/no-diff in BOTH wrappers', () => {
    const clean = mkdtempSync(join(tmpdir(), 'fp-clean-'));
    const g = (...args) => spawnSync('git', args, { cwd: clean, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'probe@example.com');
    g('config', 'user.name', 'probe');
    writeFileSync(join(clean, 'a.txt'), 'committed\n');
    writeFileSync(join(clean, '.gitignore'), 'ctl-*\n');
    g('add', '-A');
    g('commit', '-qm', 'base');
    spawnSync('mkfifo', [join(clean, FIFO_NAME)], { encoding: 'utf8' });
    writeFileSync(join(clean, REG_NAME), 'regular control\n');
    const preflight = (wrapper, injectPath) =>
      bashEval(
        `${shadow(injectPath)}\n${fnsFrom(wrapper, PREFLIGHT_FNS)}\nif git diff --quiet && git diff --cached --quiet && ! has_reviewable_untracked; then echo CLEAN; else echo DIRTY; fi`,
        clean,
      );
    for (const wrapper of [CODEX_WRAPPER, AGY_WRAPPER]) {
      assert.equal(preflight(wrapper, FIFO_NAME), 'CLEAN', 'the masks-only tree reads clean (no subscription run spent)');
      assert.equal(preflight(wrapper, REG_NAME), 'DIRTY', 'NON-VACUOUS: an injected regular file keeps the tree reviewable');
    }
    rmSync(clean, { recursive: true, force: true });
  });

  it('(vii) the ASSEMBLED payload (porcelain section included) is byte-identical with and without a mask — both wrappers', () => {
    for (const wrapper of [CODEX_WRAPPER, AGY_WRAPPER]) {
      const baseline = bashEval(`${fnsFrom(wrapper, ASSEMBLE_FNS)}\nassemble_code_diff`, mroot);
      assert.equal(assembleShadowed(wrapper, FIFO_NAME), baseline, 'the mask leaves NO trace anywhere in the assembled payload');
      assert.equal(assembleShadowed(wrapper, FIFO_SPACES), baseline, 'a spaced mask name filters quote/space-safely');
      assert.notEqual(assembleShadowed(wrapper, REG_NAME), baseline, 'NON-VACUOUS: an injected regular file changes the payload');
    }
  });

  it('the status filter touches ONLY the filtered ?? records — tracked changes and quoted-name untracked files survive', () => {
    const masked = assembleShadowed(CODEX_WRAPPER, FIFO_NAME);
    assert.match(masked, / M tracked\.txt/, 'the tracked-change record survives the filter');
    assert.match(masked, /\?\? plain\.txt/, 'a plain untracked record survives');
    assert.match(masked, /\?\? "wei\\"rd name\.txt"/, 'the C-quoted untracked record survives byte-exactly');
    assert.doesNotMatch(masked, /ctl-mask/, 'no filtered-class record leaks into the payload');
  });
});
