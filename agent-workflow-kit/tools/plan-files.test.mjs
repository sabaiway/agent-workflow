import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isScratchPlanName, plansInFlight } from './plan-files.mjs';

const loaded = await import('./plan-files.mjs').catch(() => ({}));
const readPlanEntries = loaded.readPlanEntries ?? (() => { throw new Error('readPlanEntries is absent'); });

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

describe('plan-files — readPlanEntries, the plans directory read', () => {
  const withRoot = (body) => {
    const root = mkdtempSync(join(tmpdir(), 'plan-files-'));
    try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
  it('reads an absent plans directory as an empty list', () => withRoot((root) => assert.deepEqual(readPlanEntries(root), [])));
  it('throws any other read error with its code in the CLI message', () => withRoot((root) => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/plans'), 'not a directory');
    assert.throws(() => readPlanEntries(root), { message: 'docs/plans could not be read (ENOTDIR)' });
  }));
});
