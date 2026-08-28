import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READY, NEEDS_CLI } from './detect-backends.mjs';

const { main, CONFIG_REL } = await import('./procedures.mjs');
const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-workflow-engine');
const detect = (codex, agy) => () => [
  { name: 'codex-cli-bridge', readiness: codex },
  { name: 'antigravity-cli-bridge', readiness: agy },
];

describe('procedures on a roster slot — no invented dispatch before the roster render lands', () => {
  it('a codex-only roster with codex not ready never dispatches agy and carries the roster in the envelope', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'procedures-roster-'));
    try {
      mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
      writeFileSync(join(cwd, CONFIG_REL), JSON.stringify({ 'plan-execution': { review: ['codex-review', 'review-lens'] } }));
      const r = main(['plan-execution', '--json'], {
        cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(NEEDS_CLI, READY),
        surveyVehicle: () => ({ state: 'missing', reason: null, rel: '.claude/agents/executor.md' }),
      });
      assert.equal(r.code, 0, r.stderr);
      const review = JSON.parse(r.stdout).slots.review;
      assert.deepEqual(
        [review.recipe, review.source, review.degradedFrom, review.backends, review.contracts],
        ['reviewed', 'config', null, [], []],
      );
      assert.deepEqual(review.roster.map(({ member, kind, state }) => ({ member, kind, state })), [
        { member: 'codex-review', kind: 'bridge', state: NEEDS_CLI },
        { member: 'review-lens', kind: 'lens', state: 'unsurveyed' },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
