import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flowAdoption, digestOf, PLAN_WITH_ID, FLOW_TS } from './review-state-harness.test.mjs';
import { FLOW_SCHEMA_VERSION } from './flow-record.mjs';

const flow = await import('./review-state-flow.mjs').catch(() => ({}));
const absent = (name) => () => {
  throw new Error(`absent: ${name}`);
};
const computePlanAdoptionCoverage = flow.computePlanAdoptionCoverage ?? absent('computePlanAdoptionCoverage');
const attestedPlanIdsFor = flow.attestedPlanIdsFor ?? absent('attestedPlanIdsFor');

describe('review-state flow leaf (spec:review-state/S7)', () => {
  it('computePlanAdoptionCoverage names each uncovered class: no planId · no adoption · digest mismatch · foreign owner', () => {
    const records = [flowAdoption({ planDigest: digestOf(PLAN_WITH_ID) }), flowAdoption({ planId: 'plan-f', owner: 'worktree:elsewhere', planDigest: digestOf('---\nplanId: plan-f\n---\n') })];
    const files = {
      'no-id.md': '# no frontmatter\n',
      'no-adoption.md': '---\nplanId: plan-missing\n---\n',
      'edited.md': `${PLAN_WITH_ID}tail\n`,
      'foreign.md': '---\nplanId: plan-f\n---\n',
    };
    const coverage = computePlanAdoptionCoverage({
      root: '/fixture',
      plans: [...Object.keys(files), 'ghost.md'].sort(),
      records,
      owner: 'main',
      readFile: (p) => {
        const name = Object.keys(files).find((n) => String(p).endsWith(n));
        if (name === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return Buffer.from(files[name]);
      },
    });
    const byPlan = Object.fromEntries(coverage.map((c) => [c.plan, c]));
    const classes = [['no-id.md', /planId/], ['no-adoption.md', /no adoption/], ['edited.md', /edited after adoption|no longer matches/], ['foreign.md', /foreign|owned by/], ['ghost.md', /unreadable/]];
    for (const [plan, reason] of classes) {
      assert.equal(byPlan[plan].covered, false, `${plan} is uncovered, never skipped`);
      assert.match(byPlan[plan].reason, reason);
    }
  });

  it('attestedPlanIdsFor admits matching attestations and names a refused provider lens', () => {
    const B = 'b'.repeat(40);
    const F = 'f'.repeat(64);
    const att = (planId, over) => ({
      schema: FLOW_SCHEMA_VERSION,
      kind: 'internal-attestation',
      fingerprint: F,
      planId,
      stepId: 's1',
      cycle: 1,
      round: 1,
      lenses: ['correctness'],
      degraded: [],
      posture: { model: 'frontier', effort: null, tier: null },
      authority: 'orchestrator',
      base: B,
      timestamp: FLOW_TS,
      ...over,
    });
    const records = [
      att('plan-a'),
      att('plan-b', { lenses: ['codex'] }),
      att('plan-c', { fingerprint: 'e'.repeat(64) }),
      att('plan-d', { base: 'c'.repeat(40) }),
    ];
    const { attestedPlanIds, lensRefusedAttestations } = attestedPlanIdsFor({ records, base: B, fingerprint: F });
    assert.deepEqual(attestedPlanIds, ['plan-a']);
    assert.equal(lensRefusedAttestations.length, 1);
    assert.equal(lensRefusedAttestations[0].planId, 'plan-b');
    assert.match(lensRefusedAttestations[0].reason, /\bdown-mark\b/);
  });
});
