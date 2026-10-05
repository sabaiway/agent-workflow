import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithoutGit } from './hostile-git-harness.test.mjs';
import { DOTTED_EPIC, EPIC, EPIC_STAND_IN, PLAN_STAND_IN, SCRATCH_EPIC, SECOND_PROMPT, makeStageRepo,
  toolLine } from './tier-guide-harness.test.mjs';
import { MODULE, PLAN, PROMPT } from '../test/tier-walk-harness.test.mjs';

const loaded = await import('./tier-guide-facts.mjs').catch(() => ({}));
const readTierFacts = loaded.readTierFacts ?? (() => { throw new Error('readTierFacts is absent'); });
const TOOLS = '/kit/tools';
const TODAY = '2026-09-22';
const E1_CAUSE = 'no epic file in docs/ai/epics';
const node = (name, ...args) => toolLine(TOOLS, name, ...args);
// A text pattern holding every literal given, in any order.
const naming = (...parts) => new RegExp(parts.map((part) => `(?=.*${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join(''));

const E1_ACTIONS = [
  ['write', 'mkdir -p docs/ai/epics', /directory/],
  ['write', `cp /kit/references/authoring/EPIC_TEMPLATE.md ${EPIC_STAND_IN}`, /epic template/],
  ['write', null, /EPIC_ID is NEW-EPIC/],
  ['run', node('epic-shape-cli.mjs', '--check', EPIC_STAND_IN), /check/],
];
const CLOSE = [['write', null, /Result line: 2026-09-22/], ['run', node('epic-shape-cli.mjs', '--close', EPIC), /close/],
  ['write', null, /commit/]];
const REMOVAL = ['write', null, naming(`remove the plan ${PLAN}`, 'prompts')];
const COMMIT = [['run', 'git diff --cached', /diff/], ['run', node('review-state.mjs', '--check'), /review/],
  ['run', "git commit -m 'Greet the reader'", /commit/], REMOVAL];
const EPIC_STAGES = [
  ['E1-absent', 'E1', E1_ACTIONS],
  ['E1-empty', 'E1', E1_ACTIONS],
  ['head-unborn', 'E1', E1_ACTIONS],
  ['E2', 'E2', [['run', node('epic-shape-cli.mjs', '--check', EPIC), /check/]]],
  ['E4', 'E4', CLOSE],
  ['E5', 'E5', []],
  ['E5-foreign', 'E5', []],
  ['E4-leftover', 'E4', COMMIT], // E4 renders its leftover before the close: the story commits, its plan leaves, then the close
  ['E5-leftover', 'E5', [REMOVAL]],
];
const PLAN_CHECK = ['run', node('plan-shape-cli.mjs', '--check', PLAN), /check/];
const copy = (path) => ['write', `cp /kit/references/authoring/TASK_TEMPLATE.md ${path}`, /task template/];
const fill = (id) => ['write', null, naming('ROW_LINE', id)];
const carry = (path) => ['write', null, naming(path, 'task.execute', 'a bridge only for new tests or code', 'contract block', 'a file you already wrote you lay down yourself')];
const runPrompt = (path) => ['run', null, naming(path, '## Run')];
const STAGE_ROW = ['run', `git --literal-pathspecs add -- ${MODULE}`, /stage/];
const LANDING = [['run', node('plan-shape-cli.mjs', '--verify', PLAN), /verify/], ['write', null, /state: landed 2026-09-22/]];
const S2_ACTIONS = [PLAN_CHECK, copy(PROMPT), fill('M1')];
const STORY_STAGES = [
  ['S1', 'S1', [['run', node('epic-shape-cli.mjs', '--review-brief', EPIC), /review brief/],
    ['write', null, new RegExp(`plan by hand at ${PLAN_STAND_IN}\\. .*not adopted.*budget n/a.*total: 0 → 0 lines when every row is a create or modify.*- bullet under Verification\\.$`)]]],
  ['S2', 'S2', S2_ACTIONS],
  ['S3', 'S3', [carry(PROMPT), runPrompt(PROMPT), STAGE_ROW, copy(SECOND_PROMPT), fill('M2')]],
  ['S4', 'S4', [carry(PROMPT), runPrompt(PROMPT), STAGE_ROW, ...LANDING]],
  ['S2-docs-row', 'S2', S2_ACTIONS],
  ['S4-docs-only', 'S4', LANDING],
  ['S4-sweep', 'S4', [carry(PROMPT), runPrompt(PROMPT), ['write', null, naming('sweep row M1 (src/*.mjs) expands to: src/greet.mjs')], ...LANDING]],
  ['plan-refused-premint', 'S2', S2_ACTIONS],
  ['plan-facts-refused', 'S2', S2_ACTIONS],
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
const entryAt = (facts, path) => facts.entries.find((entry) => entry.path === path);

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

  for (const [cell, stage, expected] of STORY_STAGES) it(`${cell} admits ${stage} alone for the story in hand`, () => {
    const facts = readCell(cell);
    assert.deepEqual(facts.states, [], cell);
    assert.equal(facts.entries.length, 1);
    const [entry] = facts.entries;
    assert.equal(entry.stage, 'E3');
    assert.deepEqual(entry.actions, [], cell);
    assert.equal(entry.stories.length, 1);
    const [story] = entry.stories;
    assert.deepEqual([story.id, story.stage, story.plan], ['S1', stage, stage === 'S1' ? null : PLAN]);
    assert.deepEqual(story.residual, []);
    assertActions(story.actions, expected, cell);
  });

  for (const [cell, expected] of [['E3-leftover', [REMOVAL]], ['E3-leftover-staged', COMMIT]]) it(`${cell}: the leftover is the epic's list and no story is in hand`, () => {
    const facts = readCell(cell);
    assert.deepEqual(facts.states, []);
    const [entry] = facts.entries;
    assert.equal(entry.stage, 'E3');
    assert.equal(entry.fact.command, node('epic-shape-cli.mjs', '--check', EPIC));
    assert.deepEqual(entry.stories, [], 'S2 depends on the landed S1 and is still not in hand');
    assertActions(entry.actions, expected, cell);
  });

  it('while a leftover stands, no other epic renders a story or its close', () => {
    const facts = readCell('leftover-barrier');
    assert.deepEqual(facts.states, []);
    const held = entryAt(facts, EPIC);
    assert.equal(held.stage, 'E4');
    assertActions(held.actions, [REMOVAL], 'the epic with the leftover');
    assert.deepEqual(['docs/ai/epics/OTHER.md', 'docs/ai/epics/THIRD.md'].map((path) => entryAt(facts, path))
      .map(({ stage, stories, actions }) => [stage, stories, actions]), [['E3', [], []], ['E4', [], []]]);
  });

  it('an info finding of the close is no step of E4', () => {
    const facts = readCell('E4-shared');
    const entry = entryAt(facts, EPIC);
    assert.equal(entry.stage, 'E4');
    assertActions(entry.actions, CLOSE, 'E4-shared');
  });

  it('reads an epic written with CRLF line ends as the epic', () => {
    const facts = readCell('epic-crlf');
    assert.deepEqual(facts.entries.map(({ path }) => path), [EPIC]);
    assert.notEqual(facts.entries[0].stage, 'E1');
  });

  for (const [cell, id] of [['standin-scratch', SCRATCH_EPIC], ['standin-dotted', DOTTED_EPIC]]) it(`${cell}: never names a plan stand-in the plans reader drops`, () => {
    const [entry] = readCell(cell).entries;
    const [story] = entry.stories;
    assert.equal(story.stage, 'S1');
    assert.match(story.actions[1].text, /ASCII letters, digits, dashes and underscores/);
    assert.ok(!story.actions[1].text.includes(`docs/plans/${id}-S1.md`), story.actions[1].text);
    assert.ok(story.actions[1].text.includes(`Story: S1 of ${id} `), story.actions[1].text);
  });

  it('prints one cause line for an absent store and for an empty one', () => {
    const [absent, empty] = ['E1-absent', 'E1-empty'].map((cell) => readCell(cell).entries[0]);
    assert.deepEqual(empty, absent);
  });
});
