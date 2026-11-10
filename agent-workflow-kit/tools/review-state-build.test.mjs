import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READY, NEEDS_SKILL } from './detect-backends.mjs';
import { stripGitLocationEnv } from './git-env.mjs';
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

describe('the build leaf lists docs/plans — spec:checker-verdict/S17', () => {
  const locked = { skip: process.getuid?.() === 0 };
  const plansOf = (root) => join(root, 'docs', 'plans');
  const namesListing = (code) => (error) => error.message.includes('docs/plans') && error.message.includes(code ?? '');
  const buildOver = (t, root, fault = null) => {
    const original = fs.readdirSync;
    const listed = plansOf(realpathSync(root));
    const mocked = t.mock.method(fs, 'readdirSync', (path, ...args) => { if (fault && path === listed) throw fault; return original(path, ...args); });
    syncBuiltinESMExports();
    try {
      return buildState({ cwd: root, env: {}, detect: detect(READY, READY) });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  };
  const lockPlans = (t, root) => {
    chmodSync(plansOf(root), 0o000);
    t.after(() => { chmodSync(plansOf(root), 0o700); rmSync(root, { recursive: true, force: true }); });
  };

  it('a listing failing with EIO or no code throws naming docs/plans; an absent docs/plans is no plan in flight', (t) => {
    const { root } = makeRepo();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [code, fault] of [['EIO', Object.assign(new Error('i/o error'), { code: 'EIO' })], [null, new Error('listing failed')]]) {
      assert.throws(() => buildOver(t, root, fault), namesListing(code), code ?? 'no code');
    }
    rmSync(plansOf(root), { recursive: true });
    assert.deepEqual(buildOver(t, root).plans, []);
  });

  it('a listing failing with EACCES throws naming docs/plans and the code', locked, (t) => {
    const { root } = makeRepo();
    lockPlans(t, root);
    assert.throws(() => buildOver(t, root), namesListing('EACCES'));
  });

  it('a spawned review-state --check, --await and plain run each exit 1 naming docs/plans and EACCES', locked, (t) => {
    const { root } = makeRepo({ pending: false });
    const script = fileURLToPath(new URL('./review-state.mjs', import.meta.url));
    const env = Object.fromEntries(Object.entries(stripGitLocationEnv(process.env)).filter(([key]) => !key.startsWith('AW_') && key !== 'NODE_TEST_CONTEXT'));
    lockPlans(t, root);
    for (const args of [['--check'], ['--await', '--timeout', '1'], []]) {
      const r = spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
      assert.equal(r.status, 1, `${args.join(' ') || 'plain run'}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /docs\/plans/);
      assert.match(r.stderr, /EACCES/);
    }
  });
});
