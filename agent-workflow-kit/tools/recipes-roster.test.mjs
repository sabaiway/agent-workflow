import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const recipes = await import('./recipes.mjs');
const posture = await import('./bridge-posture.mjs');
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'recipes.mjs');

const readiness = [
  { name: 'codex-cli-bridge', readiness: 'ready' },
  { name: 'antigravity-cli-bridge', readiness: 'needs-cli', setupHint: { url: 'https://setup.invalid/agy' } },
];
const surveyLens = (spec) => ({
  state: spec.stem === 'review-lens' ? 'placed' : 'missing', reason: null,
  rel: `.claude/agents/${spec.stem}.md`, model: spec.model ?? 'sonnet', effort: spec.effort ?? 'high',
});

describe('roster resolution and obligations (spec:review-roster/S3)', () => {
  it('resolves each member while the configured bridges alone choose the gate equivalent', () => {
    const config = { 'plan-execution': { review: ['codex-review', 'agy-review', 'review-lens'] } };
    const result = recipes.resolveActivityRecipe({
      config, readiness, activity: 'plan-execution', slot: 'review', surveyLens,
      postures: { codex: { state: 'valid', posture: 'model=gpt effort=xhigh tier=standard' } },
    });
    assert.deepEqual([result.recipe, result.source, result.degradedFrom, result.reason], ['council', 'config', null, null]);
    assert.deepEqual(result.roster.map(({ member, stem, kind, state }) => ({ member, stem, kind, state })), [
      { member: 'codex-review', stem: 'codex', kind: 'bridge', state: 'ready' },
      { member: 'agy-review', stem: 'agy', kind: 'bridge', state: 'needs-cli' },
      { member: 'review-lens', stem: 'review-lens', kind: 'lens', state: 'placed' },
    ]);
    assert.equal(result.roster[0].posture, 'model=gpt effort=xhigh tier=standard');
    assert.match(result.roster[1].reason, /https:\/\/setup\.invalid\/agy/u);
    assert.equal(readiness.some((entry) => entry.name === 'review-lens'), false, 'a lens is not a readiness provider');
  });

  it('the council degrade sentence keeps the hint-less HEAD wording although the detector carries a setupHint', () => {
    const config = { 'plan-execution': { review: 'council' } };
    const result = recipes.resolveActivityRecipe({ config, readiness, activity: 'plan-execution', slot: 'review' });
    assert.deepEqual([result.recipe, result.degradedFrom, result.reason], [
      'reviewed', 'council', 'Council needs 2 provider(s) providing review, but only 1 ready — agy: the CLI is not installed',
    ]);
  });

  it('one bridge is reviewed, no bridge is solo, regardless of readiness', () => {
    const one = { 'plan-execution': { review: ['agy-review', 'review-lens'] } };
    const none = { 'plan-execution': { review: ['review-lens'] } };
    assert.equal(recipes.resolveActivityRecipe({ config: one, readiness, activity: 'plan-execution', slot: 'review', surveyLens }).recipe, 'reviewed');
    assert.equal(recipes.resolveActivityRecipe({ config: none, readiness, activity: 'plan-execution', slot: 'review', surveyLens }).recipe, 'solo');
  });
});

describe('active roster line and posture access (spec:review-roster/S8)', () => {
  it('renders states only when the caller supplies the roster dependencies', () => {
    const loaded = { config: { 'plan-execution': { review: ['agy-review', 'review-lens:opus:high'] } }, source: 'fixture' };
    const cold = recipes.composeActiveRecipeLine(loaded, readiness);
    const live = recipes.composeActiveRecipeLine(loaded, readiness, null, { surveyLens, postures: {} });
    assert.match(cold, /plan-execution\.review = \[agy-review \+ review-lens:opus:high\] \(configured\)/u);
    assert.doesNotMatch(cold, /unsurveyed|needs-cli|missing/u);
    assert.match(live, /plan-execution\.review = \[agy-review \(needs-cli\) \+ review-lens:opus:high \(missing\)\] \(configured\)/u);
  });

  it('posturesByBackend distinguishes valid, absent and unreadable manifests in registry order', () => {
    const manifests = {
      '/bundle/codex-cli-bridge/capability.json': JSON.stringify({ posture: { model: 'gpt', effort: 'xhigh', tier: null } }),
      '/bundle/antigravity-cli-bridge/capability.json': JSON.stringify({ name: 'agy' }),
    };
    const rows = posture.posturesByBackend({ bundleRoot: '/bundle', settings: { active: [] }, readFile: (path) => manifests[path] });
    assert.deepEqual(Object.keys(rows), ['codex', 'agy']);
    assert.equal(rows.codex.state, 'valid');
    assert.equal(rows.agy.state, 'none');
    const unreadable = posture.posturesByBackend({ bundleRoot: '/bundle', readFile: () => '{' });
    assert.equal(unreadable.codex.state, 'unreadable');
  });

  it('--active-line accepts a roster config and surveys a placed lens', () => {
    const root = mkdtempSync(join(tmpdir(), 'recipes-roster-'));
    try {
      mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
      writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify({
        'plan-execution': { review: ['review-lens'] },
      }));
      mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
      writeFileSync(join(root, '.claude', 'agents', 'review-lens.md'),
        '---\nname: review-lens\nmodel: opus\neffort: high\ntools: Read\n---\ncustom\n');
      const run = spawnSync(process.execPath, [SCRIPT, '--active-line'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root },
      });
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /plan-execution\.review = \[review-lens\] \(configured; autonomy prompt\)/u);
      assert.doesNotMatch(run.stdout, /unsurveyed/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
