import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drift-guard: the two execution-backend bridges (codex-cli-bridge → `codex`, antigravity-cli-bridge
// → `agy`) are CANONICAL at the repo root; the kit ships BYTE-IDENTICAL mirror copies under
// agent-workflow-kit/bridges/<name>/ so the published npm tarball can place a bridge skill (Plan B /
// AD-011). This test pins each mirror to its canon — every file byte-for-byte AND set-equality of the
// file lists (a canon file added/deleted without re-syncing the mirror fails here). Same pattern as
// test/methodology-mirror.test.mjs (AD-010).
//
// Lives under test/ (NOT tools/): it reads the repo-root bridge dirs, which are sibling packages
// outside the kit's npm tarball, so it must stay a monorepo-only dev test. test/ is excluded from the
// package `files` whitelist yet still matched by the gate glob `agent-workflow-kit/test/*.test.mjs`.
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');
const FAMILY_ROOT = join(KIT_ROOT, '..');

const BRIDGES = ['codex-cli-bridge', 'antigravity-cli-bridge'];

// Recursive list of relative file paths under `root`, sorted, excluding VCS/dependency noise.
// The bridge dirs are git-tracked skill files only (no node_modules/.git), but guard anyway so a
// stray dir can never silently enter the comparison.
const walkFiles = (root) => {
  const out = [];
  const recurse = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) recurse(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  recurse('');
  return out.sort();
};

describe('bridges mirror — kit copies stay byte-identical to the repo-root canon', () => {
  for (const name of BRIDGES) {
    const canonRoot = join(FAMILY_ROOT, name);
    const mirrorRoot = join(KIT_ROOT, 'bridges', name);

    it(`${name}: file list set-equality (canon === mirror)`, () => {
      assert.deepEqual(
        walkFiles(mirrorRoot),
        walkFiles(canonRoot),
        `bridge mirror file list drifted — re-sync ${mirrorRoot} from ${canonRoot}`,
      );
    });

    it(`${name}: every file byte-for-byte (canon === mirror)`, () => {
      for (const rel of walkFiles(canonRoot)) {
        const canonBytes = readFileSync(join(canonRoot, rel));
        const mirrorBytes = readFileSync(join(mirrorRoot, rel));
        assert.ok(
          canonBytes.equals(mirrorBytes),
          `bridge mirror has drifted at ${rel} — re-sync ${mirrorRoot}/${rel} from ${canonRoot}/${rel}`,
        );
      }
    });
  }
});
