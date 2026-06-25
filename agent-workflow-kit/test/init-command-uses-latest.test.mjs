// Drift guard: every published surface must document the install command as
// `npx @sabaiway/agent-workflow-kit@latest init`, never the bare `… init`. A bare `npx <pkg> init`
// reuses the npx cache and silently runs an OLDER cached build, so a returning user "upgrades" to
// nothing (the reported bug). `@latest` bypasses the cache. Pinning the docs here makes the bare form
// structurally unrepeatable on the recommended surfaces. See decisions AD-012.
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball;
// it also scans repo-root + bridge-source files that the kit tarball does not carry).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// agent-workflow-kit/test → repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The surfaces that PRESCRIBE the install command to a user. Historical contexts (CHANGELOG, releases/,
// migrations/) are intentionally excluded — they record what older versions said and must not be
// rewritten. A partial checkout may lack some surfaces — skipped, not failed.
const SURFACES = [
  'README.md', // family front door
  'agent-workflow-kit/README.md',
  'agent-workflow-kit/SKILL.md',
  'codex-cli-bridge/SKILL.md',
  'antigravity-cli-bridge/SKILL.md',
  'agent-workflow-kit/bridges/codex-cli-bridge/SKILL.md',
  'agent-workflow-kit/bridges/antigravity-cli-bridge/SKILL.md',
  'agent-workflow-kit/bin/install.mjs',
  // The engine's own prescribing surfaces — `npx kit init` now drives `npx engine@latest init`, so the
  // engine command falls under the same stale-cache trap (AD-012/AD-016). (memory's OWN README is the
  // memory package's concern and is intentionally NOT listed — see PACKAGES note below.)
  'agent-workflow-engine/SKILL.md',
  'agent-workflow-engine/README.md',
  'agent-workflow-engine/bin/install.mjs',
];

// The bare form: the scoped package name, then WHITESPACE, then `init` (no `@latest`). `\s+` (not a
// single literal space) so `<pkg>  init`, a tab, or a line-wrap can't slip the bare form past the
// guard. The recommended `…-<pkg>@latest init` does NOT match — `@latest` sits between name and `init`.
// All three family packages that have an `init` are guarded across the kit-controlled surfaces above
// (memory's OWN README is the memory package's concern, not in this list). The engine joins the guard
// in Plan 3D because `npx kit init` now spawns `npx engine@latest init`.
const barePattern = (pkg) => new RegExp(`@sabaiway/${pkg}\\s+init\\b`, 'g');
const PACKAGES = ['agent-workflow-kit', 'agent-workflow-memory', 'agent-workflow-engine'];

describe('install commands are documented with @latest, never bare (AD-012 — drift guard)', () => {
  for (const rel of SURFACES) {
    it(`${rel}: no bare \`npx @sabaiway/<pkg> init\` (use @latest)`, () => {
      const path = resolve(repoRoot, rel);
      if (!existsSync(path)) return; // surface absent in a partial checkout — nothing to assert
      const text = readFileSync(path, 'utf8');
      for (const pkg of PACKAGES) {
        const hits = text.match(barePattern(pkg)) ?? [];
        assert.deepEqual(
          hits,
          [],
          `${rel} prescribes the BARE install command for @sabaiway/${pkg} (${hits.length}×). A bare ` +
            `\`npx <pkg> init\` reuses the npx cache and runs a stale build — write \`@sabaiway/${pkg}@latest init\`.`,
        );
      }
    });
  }

  it('the guard flags the bare form (incl. extra whitespace) but never the @latest form', () => {
    assert.ok('npx @sabaiway/agent-workflow-kit init'.match(barePattern('agent-workflow-kit')), 'single space');
    assert.ok('npx @sabaiway/agent-workflow-kit  init'.match(barePattern('agent-workflow-kit')), 'double space');
    assert.equal('npx @sabaiway/agent-workflow-kit@latest init'.match(barePattern('agent-workflow-kit')), null, '@latest must not match');
  });
});
