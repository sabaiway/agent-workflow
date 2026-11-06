import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');
const FAMILY_ROOT = join(KIT_ROOT, '..');

const BRIDGES = ['codex-cli-bridge', 'antigravity-cli-bridge', 'typesafe-jev-bridge'];
const FACTS_FILE = 'service-facts.txt';

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

describe('spec:jev-judge/S2 every kit bridge mirror holds its canon file for file, byte for byte and bit for bit, and both hold service-facts.txt', () => {
  for (const name of BRIDGES) {
    const canonRoot = join(FAMILY_ROOT, name);
    const mirrorRoot = join(KIT_ROOT, 'bridges', name);

    it(`${name}: canon and mirror both hold service-facts.txt`, () => {
      for (const root of [canonRoot, mirrorRoot]) assert.ok(existsSync(join(root, FACTS_FILE)), `${root}/${FACTS_FILE} is absent`);
    });

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

    // The tarball ships the MIRROR bytes AND the mirror mode: a canon-executable wrapper whose
    // mirror copy lost the executable bit would install a non-runnable bin. Exec-bit-only (the
    // git-tracked axis) — full-mode equality would churn on umask differences.
    it(`${name}: executable-bit parity on every file (canon === mirror)`, () => {
      for (const rel of walkFiles(canonRoot)) {
        const canonExec = (statSync(join(canonRoot, rel)).mode & 0o111) !== 0;
        const mirrorExec = (statSync(join(mirrorRoot, rel)).mode & 0o111) !== 0;
        assert.equal(
          mirrorExec,
          canonExec,
          `executable bit drifted at ${rel} (canon ${canonExec ? 'executable' : 'plain'}, mirror ${mirrorExec ? 'executable' : 'plain'}) — re-sync with scripts/sync-mirrors.mjs`,
        );
      }
    });
  }
});
