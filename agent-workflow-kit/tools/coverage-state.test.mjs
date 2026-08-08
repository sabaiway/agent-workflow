// coverage-state.test.mjs — the coverage vocabulary leaf (kit-inert-gate Phase 2, Decision 8).
// The leaf exists so the reporter (run-gates) and the validator (core-evidence) read ONE closed
// set; these pins are what make "closed" mean something.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE, FINAL_COVERAGE_STATES } from './coverage-state.mjs';

describe('coverage-state — the closed vocabulary leaf', () => {
  it('carries exactly the four run outcomes, frozen', () => {
    assert.deepEqual(Object.values(COVERAGE), ['certified', 'not-run', 'none', 'unknown']);
    assert.ok(Object.isFrozen(COVERAGE));
  });

  it('the final-receipt subset excludes none and stays inside the vocabulary', () => {
    assert.deepEqual([...FINAL_COVERAGE_STATES], ['certified', 'not-run', 'unknown']);
    assert.ok(Object.isFrozen(FINAL_COVERAGE_STATES));
    assert.ok(!FINAL_COVERAGE_STATES.includes(COVERAGE.none), 'a final run always selects the checker');
    for (const state of FINAL_COVERAGE_STATES) {
      assert.ok(Object.values(COVERAGE).includes(state), `${state} must be a vocabulary member`);
    }
  });

  it('importing the leaf runs nothing and pulls nothing in (a leaf below both consumers)', async () => {
    const text = await import('node:fs').then((fs) => fs.readFileSync(new URL('./coverage-state.mjs', import.meta.url), 'utf8'));
    assert.doesNotMatch(text, /^import /m, 'the leaf must import nothing — that is what makes it a leaf');
  });
});
