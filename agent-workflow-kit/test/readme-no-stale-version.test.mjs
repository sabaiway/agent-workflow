// Drift guard: a published README hero must NOT carry a hardcoded version chip like `v1.4.0`.
// The shields.io npm-version badge already shows the live version, so a pinned `vX.Y.Z` chip in
// prose can only go stale on the next release (it did once: the kit hero said `v1.4.0` at 1.5.0).
// Removing the chip + this test makes the mistake structurally unrepeatable. See decisions AD-009
// (truthfulness guardrail 1: dynamic badges only, no pinned version strings in prose).
//
// Dev-only repo test (test/ is outside the package `files` whitelist — not shipped in the tarball).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// agent-workflow-kit/test → repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The published, front-facing READMEs. A partial checkout may lack some — skipped, not failed.
const READMES = [
  'README.md', // family front door
  'agent-workflow-kit/README.md',
  'agent-workflow-memory/README.md',
];

// A backtick-wrapped semver chip with a leading `v`, e.g. `v1.4.0`. Deliberately narrow: it does
// NOT match shields.io badge URLs (versionless) nor historical prose like "New in 1.4.0".
const PINNED_VERSION_CHIP = /`v\d+\.\d+\.\d+`/g;

describe('README hero carries no pinned version chip (AD-009 guardrail 1 — drift guard)', () => {
  for (const rel of READMES) {
    it(`${rel}: uses the dynamic npm-version badge, not a hardcoded \`vX.Y.Z\` chip`, () => {
      const path = resolve(repoRoot, rel);
      if (!existsSync(path)) return; // package absent in a partial checkout — nothing to assert
      const hits = (readFileSync(path, 'utf8').match(PINNED_VERSION_CHIP)) ?? [];
      assert.deepEqual(
        hits,
        [],
        `${rel} has hardcoded version chip(s) ${JSON.stringify(hits)} that will go stale on the ` +
          `next release. Drop the chip and rely on the shields.io npm-version badge (live version).`,
      );
    });
  }
});
