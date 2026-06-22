import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drift-guard: the engine is the CANONICAL home of the methodology text (Plan 2 / AD-010); the kit
// keeps BYTE-IDENTICAL mirror copies so the live injection + fallback keep working with no new
// runtime dependency. This test pins the mirrors to the engine canon. The engine layout differs
// from the kit layout, so the mapping is explicit:
//   engine references/planning.md         === kit references/planning.md
//   engine references/methodology-slot.md === kit tools/methodology-slot.md
// Read+assert style mirrors agent-workflow-memory/scripts/package-content.test.mjs.
//
// Lives under test/ (NOT tools/): it reads agent-workflow-engine, which is a sibling package outside
// the kit's npm tarball, so it must stay a monorepo-only dev test. test/ is excluded from the
// package `files` whitelist yet still matched by the gate glob `agent-workflow-kit/test/*.test.mjs`.
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');
const FAMILY_ROOT = join(KIT_ROOT, '..');
const ENGINE_ROOT = join(FAMILY_ROOT, 'agent-workflow-engine');

const MIRRORS = [
  {
    label: 'planning.md (full methodology reference)',
    canon: join(ENGINE_ROOT, 'references', 'planning.md'),
    mirror: join(KIT_ROOT, 'references', 'planning.md'),
  },
  {
    label: 'methodology-slot.md (bounded slot fragment)',
    canon: join(ENGINE_ROOT, 'references', 'methodology-slot.md'),
    mirror: join(KIT_ROOT, 'tools', 'methodology-slot.md'),
  },
];

describe('methodology mirror — kit copies stay byte-identical to the engine canon', () => {
  for (const { label, canon, mirror } of MIRRORS) {
    it(`${label}: kit mirror === engine canon (byte-for-byte)`, () => {
      const canonText = readFileSync(canon, 'utf8');
      const mirrorText = readFileSync(mirror, 'utf8');
      assert.equal(
        mirrorText,
        canonText,
        `kit mirror has drifted from the engine canon — re-sync ${mirror} from ${canon}`,
      );
    });
  }
});
