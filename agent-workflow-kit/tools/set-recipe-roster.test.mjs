import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './set-recipe.mjs';
import { CONFIG_REL, serializeConfig } from './orchestration-config.mjs';
import { removeReviewer } from './review-roster.mjs';

const CODEX = 'codex-cli-bridge';
const AGY = 'antigravity-cli-bridge';
const ready = () => [
  { name: CODEX, readiness: 'ready' },
  { name: AGY, readiness: 'ready' },
];
const surveyLens = (spec) => spec.stem === 'review-lens'
  ? { state: 'customized', reason: null, model: 'opus', effort: 'xhigh' }
  : { state: 'missing', reason: 'no bundled template to derive it from' };
const postures = { codex: 'model=gpt effort=xhigh', agy: 'model=gemini' };

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'set-recipe-roster-'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const writeConfig = (config) => writeFileSync(join(cwd, CONFIG_REL), serializeConfig(config));
const run = (argv, extra = {}) => main(argv, {
  cwd, detect: ready, surveyLens, postures, ...extra,
});

describe('set-recipe reviewer list operations (spec:review-roster/S5)', () => {
  it('exports the pure typed list-op parser', async () => {
    const leaf = await import('./set-recipe-roster.mjs');
    assert.deepEqual(leaf.parseReviewerOp('add-reviewer', 'plan-execution.review=review-lens'), {
      kind: 'add-reviewer', activity: 'plan-execution', slot: 'review', member: 'review-lens',
    });
    assert.throws(
      () => leaf.parseReviewerOp('remove-reviewer', 'routine.carrier=review-lens'),
      /review slot/u,
    );
  });

  it('applies same-slot operations in argv order, preserves shorthands on deep no-op, and refuses lossy states', async () => {
    const { applyReviewerOps, parseReviewerOp } = await import('./set-recipe-roster.mjs');
    const current = { 'plan-execution': { review: 'council' } };
    const add = parseReviewerOp('add-reviewer', 'plan-execution.review=review-lens');
    const remove = parseReviewerOp('remove-reviewer', 'plan-execution.review=review-lens');
    const noop = applyReviewerOps(current, [add, remove], { defaults: {} });
    assert.deepEqual(noop.config, current);
    assert.equal(noop.rows[0].changed, false);
    assert.equal(noop.rows[0].to, 'council', 'the lossless no-op keeps the shorthand on disk');
    assert.throws(
      () => applyReviewerOps({ 'plan-execution': { review: 'reviewed' } }, [add], { defaults: {} }),
      /--set plan-execution\.review=council.*codex-review.*agy-review/u,
    );
    assert.throws(
      () => applyReviewerOps({ 'plan-execution': { review: ['codex-review'] } }, [
        parseReviewerOp('remove-reviewer', 'plan-execution.review=codex-review'),
      ], { defaults: {} }),
      /--set plan-execution\.review=solo/u,
    );
    assert.throws(() => removeReviewer(['codex-review'], 'codex-review'), { code: 'last-member' }, 'the remedy keys on a typed cause, never on message text');
    assert.deepEqual(current, { 'plan-execution': { review: 'council' } }, 'the input stays immutable');
  });

  it('accumulates one changed row per slot and emits the normative JSON roster on changed and unchanged rows', () => {
    writeConfig({
      'plan-authoring': { review: 'council' },
      'plan-execution': { review: 'council' },
    });
    const result = run([
      '--add-reviewer', 'plan-execution.review=review-lens',
      '--add-reviewer', 'plan-execution.review=my-lens',
      '--add-reviewer', 'plan-authoring.review=codex-review',
      '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      changed: [{
        activity: 'plan-execution', slot: 'review', from: 'council',
        to: ['codex-review', 'agy-review', 'review-lens', 'my-lens'],
        effective: 'council', degradedFrom: null, reason: null,
        roster: [
          { member: 'codex-review', stem: 'codex', kind: 'bridge', state: 'ready', reason: null, posture: 'model=gpt effort=xhigh' },
          { member: 'agy-review', stem: 'agy', kind: 'bridge', state: 'ready', reason: null, posture: 'model=gemini' },
          { member: 'review-lens', stem: 'review-lens', kind: 'lens', state: 'customized', reason: null, posture: 'model=opus effort=xhigh' },
          { member: 'my-lens', stem: 'my-lens', kind: 'lens', state: 'missing', reason: 'no bundled template to derive it from', posture: null },
        ],
      }],
      unchanged: [{
        activity: 'plan-authoring', slot: 'review', recipe: 'council',
        roster: [
          { member: 'codex-review', stem: 'codex', kind: 'bridge', state: 'ready', reason: null, posture: 'model=gpt effort=xhigh' },
          { member: 'agy-review', stem: 'agy', kind: 'bridge', state: 'ready', reason: null, posture: 'model=gemini' },
        ],
      }],
      writtenPath: null, noop: false, warnings: [], activeLine: null,
    });
    assert.equal(existsSync(join(cwd, CONFIG_REL)), true, 'the preview preserves the existing file only');
  });

  it('accepts a bare custom lens and prints readiness, HAND-APPLY, gate delta and no-template guidance', () => {
    writeConfig({ 'plan-execution': { review: 'council' } });
    const result = run(['--add-reviewer', 'plan-execution.review=my-lens']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /↳ my-lens: skipped this round — missing: no bundled template to derive it from; HAND-APPLY: create \.claude\/agents\/my-lens\.md as a read-only vehicle$/mu);
    assert.match(result.stdout, /resolved as a lens with no bundled template — a hand-written vehicle; if you meant a bridge, the review cmds are codex-review, agy-review/u);
    assert.match(result.stdout, /gate: council \[codex, agy\] → council \[codex, agy\]/u);

    const customized = run(['--add-reviewer', 'plan-execution.review=my-lens'], {
      surveyLens: () => ({ state: 'customized', reason: null, model: 'opus', effort: 'xhigh' }),
    });
    assert.match(customized.stdout, /my-lens: customized .*model=opus effort=xhigh/u);
    assert.match(customized.stdout, /resolved as a lens with no bundled template/u);
    assert.doesNotMatch(customized.stdout, /HAND-APPLY/u);
  });

  it('a missing bundled lens prints the exact agents apply line, while reviewed refuses at the CLI', () => {
    writeConfig({ 'plan-execution': { review: 'council' } });
    const missing = run(['--add-reviewer', 'plan-execution.review=review-lens'], {
      surveyLens: () => ({ state: 'missing', reason: null }),
    });
    assert.equal(missing.code, 0, missing.stderr);
    assert.match(missing.stdout, new RegExp(`↳ review-lens: skipped this round — missing: to place it, run exactly: node .*cheap-agents\\.mjs --apply --cwd ${cwd}$`, 'mu'));
    writeConfig({ 'plan-execution': { review: 'reviewed' } });
    const refused = run(['--add-reviewer', 'plan-execution.review=review-lens']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--set plan-execution\.review=council/u);
  });

  it('a not-ready bridge prints the skipped line with the leaf remedy, in the preview and in the JSON row', () => {
    writeConfig({ 'plan-execution': { review: 'council' } });
    const detect = () => [{ name: CODEX, readiness: 'needs-cli' }, { name: AGY, readiness: 'ready' }];
    const human = run(['--add-reviewer', 'plan-execution.review=review-lens'], { detect });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /↳ codex-review: skipped this round — needs-cli: the CLI is not installed \(model=gpt effort=xhigh\)$/mu);
    assert.match(human.stdout, /↳ agy-review: ready \(model=gemini\)$/mu);
    const json = JSON.parse(run(['--add-reviewer', 'plan-execution.review=review-lens', '--json'], { detect }).stdout);
    assert.deepEqual(json.changed[0].roster[0], { member: 'codex-review', stem: 'codex', kind: 'bridge', state: 'needs-cli', reason: 'the CLI is not installed', posture: 'model=gpt effort=xhigh' });
  });

  it('guidance about a hand-written lens is printed only for the member the op named', () => {
    writeConfig({ 'plan-execution': { review: ['codex-review', 'my-lens'] } });
    const result = run(['--remove-reviewer', 'plan-execution.review=codex-review']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /↳ my-lens: skipped this round — missing: no bundled template to derive it from; HAND-APPLY/u);
    assert.doesNotMatch(result.stdout, /if you meant a bridge/u);
    assert.match(result.stdout, /gate: reviewed \[codex\] → solo \[\]/u);
  });

  it('a bridge posture rides an unchanged reviewer row exactly as a changed one', () => {
    writeConfig({ 'plan-authoring': { review: 'council' } });
    const result = run(['--add-reviewer', 'plan-authoring.review=codex-review', '--json'], { postures: undefined, env: () => undefined, home: cwd });
    assert.equal(result.code, 0, result.stderr);
    const [row] = JSON.parse(result.stdout).unchanged;
    assert.equal(row.recipe, 'council');
    for (const member of row.roster) assert.ok(typeof member.posture === 'string' && member.posture.length > 0, `${member.member} posture: ${member.posture}`);
  });

  it('a reviewer op without its argument names the full form', () => {
    const result = run(['--add-reviewer']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--add-reviewer requires <activity>\.review=<member>/u);
  });

  it('a remove no-op on solo still renders the empty roster and unchanged gate obligation', () => {
    writeConfig({ 'plan-execution': { review: 'solo' } });
    const result = run(['--remove-reviewer', 'plan-execution.review=review-lens']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /plan-execution\.review: already solo \(no change\)/u);
    assert.match(result.stdout, /gate: solo \[\] → solo \[\]/u);
  });

  it('keeps every shorthand human preview byte-identical to HEAD', () => {
    for (const value of ['solo', 'reviewed', 'council']) {
      const result = run(['--set', `plan-execution.review=${value}`]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, [
        'set-recipe — preview (nothing written; re-run with --write to apply)',
        `  plan-execution.review: (computed default) → ${value}`,
        `      ↳ effective here: ${value}`,
        '',
        'would write docs/ai/orchestration.json — re-run with --write to apply.',
      ].join('\n'));
    }
  });

  it('--write lands the roster and the active-line echo surveys its lens', () => {
    writeConfig({ 'plan-execution': { review: 'council' } });
    const result = run(['--add-reviewer', 'plan-execution.review=review-lens', '--write']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, CONFIG_REL), 'utf8'))['plan-execution'].review,
      ['codex-review', 'agy-review', 'review-lens']);
    assert.match(result.stdout, /plan-execution\.review = \[codex-review \+ agy-review \+ review-lens\] \(configured/u);
    assert.doesNotMatch(result.stdout, /unsurveyed/u);
  });
});
