import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';
import {
  makeRepo,
  makeMaskRepo,
  throwing,
  detect,
  planPath,
  PLAN_WITH_ID,
  writeFlowStore,
  flowAdoption,
  digestOf,
} from './review-state-harness.test.mjs';

const build = await import('./review-state-build.mjs').catch(() => ({}));
const absent = (name) => () => {
  throw new Error(`absent: ${name}`);
};
const countNeverCommittableUntracked = build.countNeverCommittableUntracked ?? absent('countNeverCommittableUntracked');
const buildState = build.buildState ?? absent('buildState');

describe('review-state build leaf — spec:review-state/S6', () => {
  it('countNeverCommittableUntracked: non-git cwd → 0; a throwing lstat counts nothing (fail-safe arms)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'rs-nongit-'));
    assert.equal(countNeverCommittableUntracked(outside), 0, 'not a git tree — nothing to count');
    rmSync(outside, { recursive: true, force: true });
    const { root } = makeMaskRepo();
    assert.equal(countNeverCommittableUntracked(root, { lstat: throwing }), 0, 'an unverifiable path never inflates the advisory count');
    rmSync(root, { recursive: true, force: true });
  });

  it('the readiness carries the executor vehicle, surveyed at the work-tree root, and it never reviews', () => {
    const { root } = makeRepo({ config: null });
    const asked = [];
    const stateFor = (state) => buildState({ cwd: root, env: {}, detect: detect(NEEDS_SKILL, NEEDS_SKILL), surveyVehicle: (dir) => { asked.push(dir); return { state, reason: null, rel: '.claude/agents/executor.md' }; } });
    const [placed, missing] = [stateFor('placed'), stateFor('missing')];
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(asked, [placed.root, placed.root], 'the survey is composed at the anchor the config is read from');
    assert.deepEqual([placed.obligations.recipe, placed.obligations.backends], ['solo', []], 'a placed executor is no ready reviewer');
    assert.equal(missing.obligations.recipe, 'solo');
  });

  it('the coverage map reads each plan file ONCE and never on the unarmed fast path (P13/P19)', () => {
    const { root } = makeRepo();
    writeFileSync(planPath(root), PLAN_WITH_ID);
    const reads = [];
    const readFile = (p, ...rest) => {
      reads.push(String(p));
      return readFileSync(p, ...rest);
    };
    buildState({ cwd: root, env: {}, detect: detect(READY, READY), readFile });
    assert.deepEqual(reads.filter((p) => p.includes('active-plan')), [], 'no store — the fast path reads no plan file');
    writeFlowStore(root, [flowAdoption({ planDigest: digestOf(PLAN_WITH_ID) })]);
    const armed = buildState({ cwd: root, env: {}, detect: detect(READY, READY), readFile });
    rmSync(root, { recursive: true, force: true });
    assert.equal(reads.filter((p) => p.includes('active-plan')).length, 1, 'armed — exactly one bounded read per plan');
    assert.deepEqual(armed.planCoverage.map((c) => [c.covered, c.planId]), [[true, 'plan-x']]);
  });
});
