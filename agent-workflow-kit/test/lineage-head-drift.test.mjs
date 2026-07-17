// Cross-package drift guard for the deployment-lineage head.
//
// The lineage head is ONE shared sequence, but it is copied into two INDEPENDENT production
// constants in two packages that share no runtime dependency:
//   - the canonical `LINEAGE_HEAD`            — agent-workflow-memory/scripts/stamp-takeover.mjs
//   - the kit's `EXPECTED_WORKFLOW_VERSION`   — agent-workflow-kit/tools/velocity-profile.mjs
// The kit deliberately does NOT depend on the substrate package, so velocity-profile.mjs cannot
// import LINEAGE_HEAD — the literal is structurally forced to be duplicated, and nothing kept the
// two copies in lockstep. This dev-only acceptance test closes that gap by importing BOTH real
// constants and asserting they match. Bump the head in one place and forget the other → red gate.
//
// Lives in test/ — which the local gate and the monorepo publish CI (_publish-one.yml) both run,
// but which is OUTSIDE the package `files` whitelist, so it is never shipped in the kit tarball. The
// cross-package static import resolves because every run happens against the full monorepo checkout
// (the sibling agent-workflow-memory is present); same boundary-crossing precedent as
// family-deploy.test.mjs.
//
// Concrete failure it guards: on a 1.3.0 → 1.4.0 head bump, a forgotten EXPECTED_WORKFLOW_VERSION
// makes `/agent-workflow-kit velocity --apply` reject a correctly-upgraded project (VELOCITY_STAMP)
// — a breakage the rest of the suite cannot see, because every other velocity test seeds its own
// stamp from that same stale constant, so they all stay green together.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_WORKFLOW_VERSION } from '../tools/velocity-profile.mjs';
import { LINEAGE_HEAD } from '../../agent-workflow-memory/scripts/stamp-takeover.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('deployment-lineage head — cross-package drift guard', () => {
  it('kit EXPECTED_WORKFLOW_VERSION tracks the canonical agent-workflow-memory LINEAGE_HEAD', () => {
    assert.equal(
      EXPECTED_WORKFLOW_VERSION,
      LINEAGE_HEAD,
      `Lineage-head drift: kit tools/velocity-profile.mjs EXPECTED_WORKFLOW_VERSION (${EXPECTED_WORKFLOW_VERSION}) ` +
        `!= agent-workflow-memory scripts/stamp-takeover.mjs LINEAGE_HEAD (${LINEAGE_HEAD}). The head is one ` +
        `shared sequence copied into both packages (the kit can't import the substrate at runtime). ` +
        `Bump BOTH together — and the matching prose in both SKILL.md files — when the deployed ` +
        `docs/ai structure changes.`,
    );
  });

  // The AD-059 sweep lesson: the constants moved and the PROSE lagged. Every package-CHANGELOG
  // PREAMBLE (text before the first `## ` — historical entries are exempt) that names the lineage
  // head must name the CURRENT one; non-vacuous — the memory + engine preambles do declare it.
  it('every package-CHANGELOG preamble head declaration names the current lineage head', () => {
    let declarations = 0;
    for (const pkg of ['agent-workflow-memory', 'agent-workflow-engine', 'agent-workflow-kit']) {
      const preamble = readFileSync(join(REPO, pkg, 'CHANGELOG.md'), 'utf8').split('\n## ')[0];
      for (const [, head] of preamble.matchAll(/head `(\d+\.\d+\.\d+)`/g)) {
        declarations += 1;
        assert.equal(head, EXPECTED_WORKFLOW_VERSION, `${pkg}/CHANGELOG.md preamble declares a stale lineage head`);
      }
    }
    assert.ok(declarations >= 2, 'non-vacuous: the memory + engine preambles declare the head');
  });
});
