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

const pack = () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
  return JSON.parse(res.stdout)[0].files.map((f) => f.path);
};

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
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a runtime payload file or entry point was dropped from the tarball');
  });

  it('ships no fixtures anywhere', () => {
    const leaks = packed.filter((p) => /(^|\/)fixtures\//.test(p));
    assert.deepEqual(leaks, [], 'no fixtures may ship in the tarball');
  });

  // Exact-count pin: update this number only when intentionally adding/removing a shipped file;
  // a surprise change means over/under-exclusion (e.g. a new colocated test leaking, or a payload
  // file accidentally dropped). After an intentional change, run `npm pack ./agent-workflow-kit
  // --dry-run --json` and set the new count here in the same commit.
  it('ships exactly the expected number of files', () => {
    assert.equal(packed.length, 70, `tarball file count drifted (${packed.length} ≠ 70)`);
  });
});
