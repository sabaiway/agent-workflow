import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuoteArg } from './repo-lex.mjs';

const render = await import('./review-state-render.mjs').catch(() => ({}));
const absent = (name) => () => {
  throw new Error(`absent: ${name}`);
};
const formatHuman = render.formatHuman ?? absent('formatHuman');
const maskAdvisoryLine = render.maskAdvisoryLine ?? absent('maskAdvisoryLine');
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

describe('render leaf — spec:review-state/S8', () => {
  it('renders the human report from a hand-built council state', () => {
    const codexRow = {
      backend: 'codex', state: 'current', verdict: 'ship', shipClass: true, grounded: true,
      timestamp: '2026-07-03T12:00:00Z', probeExcluded: 0, markerRejected: 0, unmarkedRejected: 0,
    };
    const agyRow = {
      backend: 'agy', state: 'missing', verdict: null, shipClass: false, grounded: null,
      timestamp: null, probeExcluded: 0, markerRejected: 0, unmarkedRejected: 0,
    };
    const state = {
      obligations: { recipe: 'council', source: 'config', perBackend: true },
      requiredBackends: ['codex', 'agy'], detectionWarning: null, plans: ['active-plan.md'],
      location: { state: 'work-tree' }, fingerprint: 'f'.repeat(64), clean: false, heldSession: null,
      receiptsPath: '/repo/.git/receipts.jsonl', receiptCount: 1, malformed: 0, receiptsReadError: null,
      evidenceUnavailable: false, degradedExempt: [], backends: [codexRow, agyRow],
      maskedUntracked: 0, root: '/repo',
    };
    const check = { code: 1, reason: 'agy: no receipt' };
    assert.deepEqual(formatHuman(state, check).split('\n'), [
      'review-state — plan-execution.review = council (from docs/ai/orchestration.json) → codex + agy',
      '  plan in flight: "active-plan.md"',
      '  tree fingerprint: ' + 'f'.repeat(64),
      '  receipts: /repo/.git/receipts.jsonl (1 line(s))',
      '    ✓ codex: current (verdict: "ship", ship-class, grounded, 2026-07-03T12:00:00Z)',
      '    ✗ agy: missing — no receipt from this backend',
      '  check: FAIL — agy: no receipt',
    ]);
  });

  it('renders the mask advisory only for masked paths and quotes the root', () => {
    assert.equal(maskAdvisoryLine({ maskedUntracked: 0, root: '/repo' }), '');
    assert.equal(
      maskAdvisoryLine({ maskedUntracked: 2, root: '/r oot' }),
      `notice: 2 never-committable untracked path(s) (device/FIFO/socket) are ignored by the review domain — hide them from git status: node ${shellQuoteArg(join(TOOLS_DIR, 'sandbox-masks.mjs'))} --cwd '/r oot' --apply`,
    );
  });
});
