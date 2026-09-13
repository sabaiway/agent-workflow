import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isScratchPlanName, plansInFlight } from './plan-files.mjs';

const TASK_NAMES = ['TASK-story-alpha-T1.md', 'TASK-story-alpha-T1-a1.md'];
const PLAN_NAME = 'story-alpha.md';
const DIRECTORY_NAMES = ['queue.md', 'EXECUTE-story-alpha-T1.md', ...TASK_NAMES, PLAN_NAME];
const ROOT = '/any';

describe('plan-files — the TASK- scratch prefix (spec:checkpoint/S9)', () => {
  it('a TASK- name is scratch', () => {
    for (const name of TASK_NAMES) assert.equal(isScratchPlanName(name), true, name);
    assert.equal(isScratchPlanName(PLAN_NAME), false);
  });

  it('a TASK- name is never in flight', () => {
    const readdir = () => DIRECTORY_NAMES.map((name) => ({ name, isFile: () => true }));
    assert.deepEqual(plansInFlight(ROOT, readdir), [PLAN_NAME]);
  });
});
