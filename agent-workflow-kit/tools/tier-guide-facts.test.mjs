import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutGit } from './hostile-git-harness.test.mjs';
import { BRIEF, DOTTED_EPIC, EPIC, EPIC_STAND_IN, PLAN_STAND_IN, SCRATCH_EPIC, makeStageRepo, toolLine } from './tier-guide-harness.test.mjs';
import { MODULE, PLAN, TEST } from '../test/tier-walk-harness.test.mjs';

const loaded = await import('./tier-guide-facts.mjs').catch(() => ({}));
const readTierFacts = loaded.readTierFacts ?? (() => { throw new Error('readTierFacts is absent'); });
const TOOLS = '/kit/tools';
const TODAY = '2026-09-22';
const E1_CAUSE = 'no epic file in docs/ai/epics';
const node = (name, ...args) => toolLine(TOOLS, name, ...args);

const E1_ACTIONS = [
  ['write', 'mkdir -p docs/ai/epics', /directory/],
  ['write', `cp /kit/references/authoring/EPIC_TEMPLATE.md ${EPIC_STAND_IN}`, /epic template/],
  ['write', null, /EPIC_ID is NEW-EPIC/],
  ['run', node('epic-shape-cli.mjs', '--check', EPIC_STAND_IN), /check/],
];
const EPIC_STAGES = [
  ['E1-absent', 'E1', E1_ACTIONS],
  ['E1-empty', 'E1', E1_ACTIONS],
  ['head-unborn', 'E1', E1_ACTIONS],
  ['E2', 'E2', [['run', node('epic-shape-cli.mjs', '--check', EPIC), /check/]]],
  ['E4', 'E4', [['write', null, /Result line: 2026-09-22/], ['run', node('epic-shape-cli.mjs', '--close', EPIC), /close/]]],
  ['E5', 'E5', []],
  ['E5-foreign', 'E5', []],
  ['E4-cleanup', 'E4', [['write', null, /Result line: 2026-09-22/], ['run', node('epic-shape-cli.mjs', '--close', EPIC), /close/],
    ['write', null, new RegExp(`remove the plan ${PLAN}`)]]],
  ['E5-cleanup', 'E5', [['run', node('checkpoint.mjs', 'prune', '--plan', PLAN), /prune/], ['write', null, new RegExp(`remove the plan ${PLAN}`)]]],
];
const CLEANUP = [['run', node('checkpoint.mjs', 'prune', '--plan', PLAN), /prune/], ['write', null, new RegExp(`remove the plan ${PLAN}`)]];
const STORY_STAGES = [
  ['S1', [['run', node('epic-shape-cli.mjs', '--review-brief', EPIC), /review brief/],
    ['write', null, new RegExp(`plan by hand at ${PLAN_STAND_IN}\\. .*not adopted.*budget n/a.*total: 0 → 0 lines when every row is a create or modify.*- bullet under Verification\\.$`)]]],
  ['S2', [['run', node('plan-shape-cli.mjs', '--check', PLAN), /check/], ['run', node('checkpoint.mjs', 'mint', '--plan', PLAN), /mint/]]],
  ['S3', [['write', `cp /kit/references/authoring/TASK_TEMPLATE.md ${BRIEF}`, /task template/],
    ['write', null, /Row: M1/], ['run', node('task-brief.mjs', 'stamp', BRIEF), /stamp/]]],
  ['S4', [['run', node('task-brief.mjs', 'stamp', BRIEF), /stamp/]]],
  ['S5', [['run', node('task-brief.mjs', 'stamp', BRIEF), /stamp/]]],
  ['S6', [['run', node('task-brief.mjs', 'check', BRIEF), /check/], ['write', null, /Files/],
    ['run', `node --test ${TEST}`, /Acceptance/], ['run', node('review-state.mjs', '--check'), /review/],
    ['run', `git --literal-pathspecs add -- ${TEST} ${MODULE}`, /stage/],
    ['run', "git commit -m 'Greet the reader'", /commit/]]],
  ['S7', [['run', node('plan-shape-cli.mjs', '--verify', PLAN), /verify/], ['run', node('checkpoint.mjs', 'prune', '--plan', PLAN), /prune/]]],
  ['S8', [['write', null, /state: landed 2026-09-22/]]],
];

const readCell = (cell) => {
  const repo = makeStageRepo(cell);
  try {
    return readTierFacts({ cwd: repo.dir, env: { ...repo.env, GIT_OPTIONAL_LOCKS: '0' }, toolsDir: TOOLS, today: TODAY });
  } finally {
    repo.cleanup();
  }
};
const assertActions = (actions, expected, label) => {
  assert.deepEqual(actions.map(({ kind, command }) => ({ kind, command })),
    expected.map(([kind, command]) => ({ kind, command })), label);
  expected.forEach(([, , pattern], index) => assert.match(actions[index].text, pattern, `${label}: action ${index + 1}`));
};

describe('spec:tier-guide/S2 the stage table over synthetic projects', { skip: skipWithoutGit }, () => {
  for (const [cell, stage, expected] of EPIC_STAGES) it(`${cell} admits ${stage} alone`, () => {
    const facts = readCell(cell);
    assert.equal(facts.location.state, 'work-tree');
    assert.deepEqual(facts.states, [], cell);
    assert.equal(facts.entries.length, 1, cell);
    const [entry] = facts.entries;
    assert.equal(entry.stage, stage);
    assert.deepEqual(entry.stories, []);
    assert.equal(entry.fact, null);
    assertActions(entry.actions, expected, cell);
    if (stage === 'E1') assert.deepEqual([entry.id, entry.path, entry.cause], [null, null, E1_CAUSE]);
    else assert.deepEqual([entry.id, entry.path, entry.cause], ['WALK-EPIC', EPIC, null]);
  });

  it('E3 states the accepted check as a fact and renders the story in hand below it', () => {
    const facts = readCell('E3');
    assert.deepEqual(facts.states, []);
    const [entry] = facts.entries;
    assert.equal(entry.stage, 'E3');
    assert.deepEqual(entry.fact, { kind: 'fact', text: entry.fact.text, command: node('epic-shape-cli.mjs', '--check', EPIC) });
    assert.match(entry.fact.text, /check/);
    assert.deepEqual(entry.actions, []);
    assert.deepEqual(entry.stories.map(({ id, stage }) => ({ id, stage })), [{ id: 'S1', stage: 'S1' }]);
  });

  for (const [stage, expected] of STORY_STAGES) it(`${stage} admits ${stage} alone for the story in hand`, () => {
    const facts = readCell(stage);
    assert.deepEqual(facts.states, [], stage);
    assert.equal(facts.entries.length, 1);
    const [entry] = facts.entries;
    assert.equal(entry.stage, 'E3');
    assert.equal(entry.stories.length, 1);
    const [story] = entry.stories;
    assert.deepEqual([story.id, story.stage, story.plan], ['S1', stage, stage === 'S1' ? null : PLAN]);
    assert.deepEqual(story.residual, []);
    assertActions(story.actions, expected, stage);
  });

  it('E3 lists the Cleanup left over by a landed story after the story in hand', () => {
    const facts = readCell('E3-cleanup');
    assert.deepEqual(facts.states, []);
    const [entry] = facts.entries;
    assert.equal(entry.stage, 'E3');
    assert.deepEqual(entry.stories.map(({ id, stage }) => ({ id, stage })), [{ id: 'S2', stage: 'S1' }]);
    assertActions(entry.actions, CLEANUP, 'E3-cleanup');
  });

  it('an info finding of the close is no step of E4', () => {
    const facts = readCell('E4-shared');
    const entry = facts.entries.find(({ path }) => path === EPIC);
    assert.equal(entry.stage, 'E4');
    assertActions(entry.actions, EPIC_STAGES.find(([cell]) => cell === 'E4')[2], 'E4-shared');
  });

  it('reads an epic written with CRLF line ends as the epic', () => {
    const facts = readCell('epic-crlf');
    assert.deepEqual(facts.entries.map(({ path }) => path), [EPIC]);
    assert.notEqual(facts.entries[0].stage, 'E1');
  });

  for (const [cell, id] of [['standin-scratch', SCRATCH_EPIC], ['standin-dotted', DOTTED_EPIC]]) it(`${cell}: never names a plan stand-in a checkpoint refuses`, () => {
    const [entry] = readCell(cell).entries;
    const [story] = entry.stories;
    assert.equal(story.stage, 'S1');
    assert.match(story.actions[1].text, /ASCII letters, digits, dashes and underscores/);
    assert.ok(!story.actions[1].text.includes(`docs/plans/${id}-S1.md`), story.actions[1].text);
    assert.ok(story.actions[1].text.includes(`Story: S1 of ${id} `), story.actions[1].text);
  });

  it('reads the Plan field of a CRLF brief away from a stand-in name', () => {
    const [story] = readCell('brief-crlf').entries[0].stories;
    assert.equal(story.stage, 'S4');
    assertActions(story.actions, [['run', node('task-brief.mjs', 'stamp', 'docs/plans/TASK-greet-first.md'), /stamp/]], 'brief-crlf');
  });

  it('prints one cause line for an absent store and for an empty one', () => {
    const [absent, empty] = ['E1-absent', 'E1-empty'].map((cell) => readCell(cell).entries[0]);
    assert.deepEqual(empty, absent);
  });
});
