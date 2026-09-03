import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const recipes = await import('./recipes.mjs');
const READY = 'ready';
const readiness = [
  { name: 'codex-cli-bridge', readiness: READY },
  { name: 'antigravity-cli-bridge', readiness: READY },
];

describe('legacy review shorthands remain byte-compatible', () => {
  const expected = {
    solo: {
      resolved: { recipe: 'solo', source: 'config', degradedFrom: null, reason: null, overrideUnsatisfied: false },
      obligations: { recipe: 'solo', source: 'config', backends: [], minShip: 0, perBackend: false, unknowable: false },
    },
    reviewed: {
      resolved: { recipe: 'reviewed', source: 'config', degradedFrom: null, reason: null, overrideUnsatisfied: false },
      obligations: { recipe: 'reviewed', source: 'config', backends: ['codex', 'agy'], minShip: 1, perBackend: false, unknowable: false },
    },
    council: {
      resolved: { recipe: 'council', source: 'config', degradedFrom: null, reason: null, overrideUnsatisfied: false },
      obligations: { recipe: 'council', source: 'config', backends: ['codex', 'agy'], minShip: 1, perBackend: true, unknowable: false },
    },
  };

  const headLine = (cell) => `active recipes (from fixture): plan-authoring.author = solo (computed default) \u00b7 plan-authoring.fold = solo (computed default) \u00b7 plan-authoring.review = reviewed (computed default) \u2192 codex-review \u00b7 plan-execution.execute = solo (computed default) \u00b7 plan-execution.review = ${cell} \u00b7 routine.carrier = solo (computed default) \u00b7 routine.parallel = on (computed default; switch) \u00b7 feedback-triage.review = reviewed (computed default) \u2192 codex-review \u2014 the configured orchestration values above are what runs; readiness-recommended here: council (informational)`;
  const headCells = {
    solo: 'solo (configured)',
    reviewed: 'reviewed (configured) → codex-review',
    council: 'council (configured) → every backend every round: codex-review + agy-review',
  };

  for (const [value, pinned] of Object.entries(expected)) {
    it(`${value} resolves, obliges and renders the active line exactly as at HEAD 0d2eaee plus the fold slot`, () => {
      const config = { 'plan-execution': { review: value } };
      assert.deepEqual(recipes.resolveActivityRecipe({ config, readiness, activity: 'plan-execution', slot: 'review' }), pinned.resolved);
      assert.deepEqual(recipes.requiredBackendsForConfiguredRecipe({ config, readiness }), pinned.obligations);
      const loaded = { config, source: 'fixture' };
      assert.equal(recipes.composeActiveRecipeLine(loaded, readiness), headLine(headCells[value]));
      assert.equal(recipes.composeActiveRecipeLine(loaded, readiness, null, {}), headLine(headCells[value]));
    });
  }

  it('legacy posture silence remains null on a missing bundle', () => {
    assert.equal(recipes.composeConfiguredPosture({ bundleRoot: '/missing' }), null);
  });
});
