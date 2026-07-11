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
  AUTONOMY_DESCRIPTOR,
} from '../tools/inject-methodology.mjs';

// The docs cap-validator (scripts/check-docs-size.mjs) covers a DEPLOYED project's docs, not the
// kit's own package templates. The kit fallback entry-point template ships THREE empty marker slots —
// methodology (Plan 2) + orchestration (Plan 4) + autonomy (AD-044 Plan 3) — which the kit fills on
// bootstrap. This pins the triple-filled result under the deployed-AGENTS.md cap so a fallback
// bootstrap can never bust ≤100 (the D-CAP guard: the templates are trimmed for headroom so all
// three pointers fit). The bound is STRICT (< cap, not ≤): a dual-filled template sat at 97 and a
// third pair + fill lands exactly AT 100, so only a genuinely-trimmed template passes — an
// exactly-at-cap template would leave zero headroom and never pin the trim.
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK_TEMPLATE = join(KIT_ROOT, 'references', 'templates', 'AGENTS.md');
// The bounded fragments are read LIVE from the installed engine now (Plan 3D — the kit mirror is
// retired). This cap test exercises the template + representative single-line fragments (the canonical
// fragments are one line each), kept decoupled from the sibling engine's on-disk presence.
const METH_FRAGMENT =
  '> **Workflow methodology** — plan → execute → review; plans are ephemeral, every Plan ends with a mandatory Phase: Cleanup. Full vocabulary lives in the engine canon.\n';
const ORCH_FRAGMENT =
  '> **Orchestration recipes** — Solo / Reviewed / Council / Delegated; the orchestrator always commits. Pick one with `/agent-workflow-kit recipes`.\n';
const AUT_FRAGMENT =
  '> **Autonomy policy** — read `docs/ai/autonomy.json` at session start; set it with `/agent-workflow-kit set-autonomy`.\n';

const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

describe('kit fallback template — methodology + orchestration + autonomy slots + line cap', () => {
  const template = readFileSync(FALLBACK_TEMPLATE, 'utf8');

  it(`ships ≤ ${AGENTS_MD_CAP} lines as authored (all slots empty)`, () => {
    assert.ok(
      lineCount(template) <= AGENTS_MD_CAP,
      `fallback template is ${lineCount(template)} lines (cap ${AGENTS_MD_CAP})`,
    );
  });

  it('carries empty methodology, orchestration AND autonomy slots the kit can fill', () => {
    assert.equal(extractSlot(template).trim(), '', 'methodology slot ships empty');
    assert.equal(
      extractMarkerSlot(template, ORCHESTRATION_DESCRIPTOR).trim(),
      '',
      'orchestration slot ships empty',
    );
    assert.equal(
      extractMarkerSlot(template, AUTONOMY_DESCRIPTOR).trim(),
      '',
      'autonomy slot ships empty',
    );
  });

  it(`stays STRICTLY under ${AGENTS_MD_CAP} lines after the kit fills ALL THREE slots on bootstrap`, () => {
    const meth = reconcileSlot(template, METH_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(meth.status, 'reconciled-filled', 'methodology slot fills');
    const both = reconcileMarkerSlot(meth.text, ORCHESTRATION_DESCRIPTOR, ORCH_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(both.status, 'reconciled-filled', 'orchestration slot fills (present + empty in the template)');
    const all = reconcileMarkerSlot(both.text, AUTONOMY_DESCRIPTOR, AUT_FRAGMENT, { maxLines: AGENTS_MD_CAP });
    assert.equal(all.status, 'reconciled-filled', 'autonomy slot fills (present + empty in the template)');
    assert.ok(
      lineCount(all.text) < AGENTS_MD_CAP,
      `triple-filled fallback entry point is ${lineCount(all.text)} lines — must stay STRICTLY under the cap ${AGENTS_MD_CAP} (the D5 trim)`,
    );
  });
});
