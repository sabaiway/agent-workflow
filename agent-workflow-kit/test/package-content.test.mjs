import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tarball-content guard for the kit package. `files[]` whitelists whole directories, so the
// package's OWN colocated *.test.mjs (bin/, tools/, tools/manifest/) and the manifest fixtures
// used to ride into the published npm tarball. Phase-1 SCOPED negation entries in files[] strip
// them — but a blanket `!**/*.test.mjs` would silently drop the deploy/mirror PAYLOAD tests, and
// the deploy/parity gate would NOT catch it (those tests read the on-disk checkout, never the
// tarball). So this guard pins the exact shape of what ships: own tests + fixtures gone, payload
// tests + runtime files retained. This file lives in test/ (outside files[]) so it never ships;
// the local gate + publish CI run it via the `test/*.test.mjs` glob.
//
// CAUTION: never broaden the negation to `!references/**` or `!bridges/**` — references/scripts
// tests are deployed into a consumer repo and bridges/.../agy.test.mjs is part of the
// byte-identical bridge mirror the installed kit links from. Both are payload, asserted below.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const packFull = () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
  return JSON.parse(res.stdout)[0].files;
};
const pack = () => packFull().map((f) => f.path);

describe('kit package content — tarball guard (no own-test/fixture leak; payload retained)', () => {
  // Packed once in a before() hook (not at describe-body level): a failing `npm pack` is then
  // reported as a graceful hook failure rather than throwing during test collection.
  let packed;
  before(() => {
    packed = pack();
  });

  it('ships no own colocated test — every shipped *.test.mjs is deploy/mirror payload', () => {
    const leaks = packed
      .filter((p) => /\.test\.mjs$/.test(p))
      .filter((p) => !/^references\//.test(p) && !/^bridges\//.test(p));
    assert.deepEqual(leaks, [], 'own tests must not ship; only references/ & bridges/ payload tests may');
  });

  it('retains the deploy/mirror payload tests (reverse pins)', () => {
    const required = [
      'references/scripts/archive-changelog.test.mjs',
      'references/scripts/archive-issues.test.mjs',
      'references/scripts/check-docs-size.test.mjs',
      'bridges/antigravity-cli-bridge/bin/agy.test.mjs',
      'bridges/antigravity-cli-bridge/bin/agy-review.test.mjs',
      'bridges/codex-cli-bridge/bin/codex-exec.test.mjs',
      'bridges/codex-cli-bridge/bin/codex-review.test.mjs',
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a deploy/mirror payload test was dropped from the tarball');
  });

  it('retains every deployed runtime payload file and entry point', () => {
    const required = [
      'references/scripts/archive-changelog.mjs',
      'references/scripts/archive-issues.mjs',
      'references/scripts/check-docs-size.mjs',
      'references/scripts/_expect-shim.mjs',
      'references/scripts/install-git-hooks.mjs',
      'bin/install.mjs',
      'capability.json',
      'SKILL.md',
      'tools/engine-source.mjs',
      'tools/commands.mjs',
      // the pure member-table leaf (shared by family-registry + the npx installer)
      'tools/family-members.mjs',
      // the status-presenter core (Plan: One-init-freshness §4.2) — runtime modules that MUST ship
      'tools/labels.mjs',
      'tools/presentation.mjs',
      'tools/surface.mjs',
      'tools/view-model.mjs',
      'tools/renderers.mjs',
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a runtime payload file or entry point was dropped from the tarball');
  });

  it('ships no fixtures anywhere (neither `fixtures/` nor the inline-fixtures `__fixtures__/`)', () => {
    // The manifest validator's `fixtures/` dir is stripped by files[]. The presenter modules use
    // INLINE fixtures (never a tools/__fixtures__/ dir) — defense-in-depth: reject either spelling so a
    // stray fixtures dir can never leak past the gate (`!tools/**/*.test.mjs` would NOT catch a non-test
    // fixtures file).
    const leaks = packed.filter((p) => /(^|\/)fixtures\//.test(p) || /(^|\/)__fixtures__\//.test(p));
    assert.deepEqual(leaks, [], 'no fixtures (fixtures/ or __fixtures__/) may ship in the tarball');
  });

  // Exact-count pin: update this number only when intentionally adding/removing a shipped file;
  // a surprise change means over/under-exclusion (e.g. a new colocated test leaking, or a payload
  // file accidentally dropped). After an intentional change, run `npm pack ./agent-workflow-kit
  // --dry-run --json` and set the new count here in the same commit.
  it('ships exactly the expected number of files', () => {
    assert.equal(packed.length, 83, `tarball file count drifted (${packed.length} ≠ 83)`);
  });

  // The byte-equality mirror guard does NOT cover the exec bit, and a non-+x agy-review.sh would break
  // the `setup` symlink target. npm normalizes a packed file's mode to 0755 (executable) or 0644, so
  // pinning the packed mode pins the shipped exec bit.
  it('ships agy-review.sh executable (packed mode 0755)', () => {
    const full = packFull();
    const sh = full.find((f) => f.path === 'bridges/antigravity-cli-bridge/bin/agy-review.sh');
    assert.ok(sh, 'agy-review.sh must be packed');
    assert.equal(sh.mode, 0o755, `agy-review.sh must ship executable, got mode ${sh.mode?.toString(8)}`);
  });
});
