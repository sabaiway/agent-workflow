import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS_MD_CAP, reconcileSlot, extractSlot } from '../tools/inject-methodology.mjs';

// The docs cap-validator (scripts/check-docs-size.mjs) covers a DEPLOYED project's docs, not the
// kit's own package templates. The kit fallback entry-point template now ships the EMPTY methodology
// slot (Plan 2) which the kit fills on bootstrap; this pins it under the deployed-AGENTS.md cap so a
// fallback bootstrap (template + injected fragment) can never bust the ≤100-line budget.
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK_TEMPLATE = join(KIT_ROOT, 'references', 'templates', 'AGENTS.md');
// The bounded fragment is read LIVE from the installed engine now (Plan 3D — the kit mirror is
// retired). This cap test exercises the template + a representative single-line bounded fragment
// (the canonical fragment is one line), kept decoupled from the sibling engine's on-disk presence.
const FRAGMENT =
  '> **Workflow methodology** — plan → execute → review; plans are ephemeral, every Plan ends with a mandatory Phase: Cleanup. Full vocabulary lives in the engine canon.\n';

const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

describe('kit fallback template — methodology slot + line cap', () => {
  const template = readFileSync(FALLBACK_TEMPLATE, 'utf8');

  it(`ships ≤ ${AGENTS_MD_CAP} lines as authored (empty slot)`, () => {
    assert.ok(
      lineCount(template) <= AGENTS_MD_CAP,
      `fallback template is ${lineCount(template)} lines (cap ${AGENTS_MD_CAP})`,
    );
  });

  it('carries an empty methodology slot the kit can fill', () => {
    assert.equal(extractSlot(template).trim(), '', 'template slot ships empty');
  });

  it(`stays ≤ ${AGENTS_MD_CAP} lines after the kit fills the slot on bootstrap`, () => {
    const out = reconcileSlot(template, FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(out.status, 'reconciled-filled');
    assert.ok(
      lineCount(out.text) <= AGENTS_MD_CAP,
      `filled fallback entry point is ${lineCount(out.text)} lines (cap ${AGENTS_MD_CAP})`,
    );
  });
});
