import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_MD_CAP,
  reconcileSlot,
  extractSlot,
  reconcileMarkerSlot,
  extractMarkerSlot,
  ORCHESTRATION_DESCRIPTOR,
} from '../tools/inject-methodology.mjs';

// The docs cap-validator (scripts/check-docs-size.mjs) covers a DEPLOYED project's docs, not the
// kit's own package templates. The kit fallback entry-point template ships TWO empty marker slots —
// methodology (Plan 2) + orchestration (Plan 4) — which the kit fills on bootstrap. This pins the
// dual-filled result under the deployed-AGENTS.md cap so a fallback bootstrap can never bust ≤100
// (the D-CAP guard: both templates were trimmed for headroom so both pointers fit).
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK_TEMPLATE = join(KIT_ROOT, 'references', 'templates', 'AGENTS.md');
// The bounded fragments are read LIVE from the installed engine now (Plan 3D — the kit mirror is
// retired). This cap test exercises the template + representative single-line fragments (the canonical
// fragments are one line each), kept decoupled from the sibling engine's on-disk presence.
const METH_FRAGMENT =
  '> **Workflow methodology** — plan → execute → review; plans are ephemeral, every Plan ends with a mandatory Phase: Cleanup. Full vocabulary lives in the engine canon.\n';
const ORCH_FRAGMENT =
  '> **Orchestration recipes** — Solo / Reviewed / Council / Delegated; the orchestrator always commits. Pick one with `/agent-workflow-kit recipes`.\n';

const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

describe('kit fallback template — methodology + orchestration slots + line cap', () => {
  const template = readFileSync(FALLBACK_TEMPLATE, 'utf8');

  it(`ships ≤ ${AGENTS_MD_CAP} lines as authored (both slots empty)`, () => {
    assert.ok(
      lineCount(template) <= AGENTS_MD_CAP,
      `fallback template is ${lineCount(template)} lines (cap ${AGENTS_MD_CAP})`,
    );
  });

  it('carries an empty methodology slot AND an empty orchestration slot the kit can fill', () => {
    assert.equal(extractSlot(template).trim(), '', 'methodology slot ships empty');
    assert.equal(
      extractMarkerSlot(template, ORCHESTRATION_DESCRIPTOR).trim(),
      '',
      'orchestration slot ships empty',
    );
  });

  it(`stays ≤ ${AGENTS_MD_CAP} lines after the kit fills BOTH slots on bootstrap`, () => {
    const meth = reconcileSlot(template, METH_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(meth.status, 'reconciled-filled', 'methodology slot fills');
    const both = reconcileMarkerSlot(meth.text, ORCHESTRATION_DESCRIPTOR, ORCH_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(both.status, 'reconciled-filled', 'orchestration slot fills (present + empty in the template)');
    assert.ok(
      lineCount(both.text) <= AGENTS_MD_CAP,
      `dual-filled fallback entry point is ${lineCount(both.text)} lines (cap ${AGENTS_MD_CAP})`,
    );
  });
});
