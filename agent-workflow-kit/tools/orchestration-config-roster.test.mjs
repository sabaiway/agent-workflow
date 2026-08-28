import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const configModule = await import('./orchestration-config.mjs');

describe('orchestration config review roster (spec:review-roster/S2)', () => {
  it('accepts roster arrays only on review slots', () => {
    const config = {
      'plan-authoring': { review: ['codex-review', 'review-lens:opus:high'] },
      'plan-execution': { review: ['agy-review'] },
    };
    assert.equal(configModule.validateConfig(config), config);
    assert.throws(
      () => configModule.validateConfig({ 'plan-execution': { execute: ['codex-review'] } }),
      (error) => error.exitCode === 1 && /execute/u.test(error.message),
    );
  });

  it('maps every roster refusal to a config error and keeps set operations ordered', () => {
    for (const review of [[], ['codex-review:opus:high'], ['review-lens:opus'],
      ['other-lens:opus:high'], ['review-lens:opus:high', 'review-lens-opus-high']]) {
      assert.throws(
        () => configModule.validateConfig({ 'plan-execution': { review } }),
        (error) => error.exitCode === 1,
      );
    }
    const next = configModule.applySetOps({}, [
      { kind: 'set', activity: 'plan-execution', slot: 'review', recipe: ['codex-review'] },
      { kind: 'set', activity: 'plan-execution', slot: 'review', recipe: ['agy-review', 'review-lens'] },
    ]);
    assert.deepEqual(next, { 'plan-execution': { review: ['agy-review', 'review-lens'] } });
  });

  it('refreshes the outgoing README and names only the hand-edit roster form in this plan', () => {
    assert.match(configModule.CANON_README, /explicit roster array/u);
    assert.match(configModule.CANON_README, /hand-edit/u);
    assert.doesNotMatch(configModule.CANON_README, /add-reviewer|remove-reviewer/u);
    const outgoing = configModule.KNOWN_PRIOR_README.at(-1);
    const refreshed = configModule.refreshReadme({ _README: outgoing });
    assert.deepEqual([refreshed.changed, refreshed.config._README], [true, configModule.CANON_README]);
  });
});
