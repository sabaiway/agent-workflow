import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { buildState } = await import('./review-state.mjs');
const READY = 'ready';
const detection = () => [
  { name: 'codex-cli-bridge', readiness: READY },
  { name: 'antigravity-cli-bridge', readiness: READY },
];

describe('review-state consumes bridge-only roster obligations (spec:review-roster/S10)', () => {
  it('pins named bridge, lens-only and reviewed obligations without surveying a lens', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-state-roster-'));
    try {
      mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
      const configPath = join(root, 'docs', 'ai', 'orchestration.json');
      const cases = [
        {
          value: ['codex-review'],
          expected: ['reviewed', ['codex'], true],
          roster: [{ member: 'codex-review', stem: 'codex', kind: 'bridge', state: 'ready', reason: null, posture: null }],
        },
        {
          value: ['review-lens'],
          expected: ['solo', [], false],
          roster: [{ member: 'review-lens', stem: 'review-lens', kind: 'lens', state: 'unsurveyed', reason: null, posture: null }],
        },
        { value: 'reviewed', expected: ['reviewed', ['codex', 'agy'], false], roster: null },
      ];
      for (const row of cases) {
        writeFileSync(configPath, JSON.stringify({ 'plan-execution': { review: row.value } }));
        const calls = { executor: 0 };
        const state = buildState({
          cwd: root, env: {}, detect: detection,
          surveyVehicle: () => { calls.executor += 1; return { state: 'placed', reason: null, rel: '.claude/agents/executor.md' }; },
        });
        assert.deepEqual(
          [state.obligations.recipe, state.obligations.backends, state.obligations.perBackend],
          row.expected,
        );
        assert.equal(calls.executor, 1);
        assert.deepEqual(state.resolved.roster ?? null, row.roster, JSON.stringify(row.value));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
