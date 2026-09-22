// The ladder of the tier-guide suites: one repository per stage E1 to E5 and S1 to S8, per rendered state and per
// residual cell, over makeRepo. It declares no test and imports nothing under test.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from './hostile-git-harness.test.mjs';
import { mintCheckpoint, pruneCheckpoints } from './checkpoint.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { stampBrief } from './task-brief.mjs';
import { EPIC_VALUES, LF, MODULE, MODULE_ROW, PLAN, TASK_VALUES, TEST, addResultLine, landStory, removeSection,
  renderLines, renderPlan, renderTemplate } from '../test/tier-walk-harness.test.mjs';

const AUTHORING = new URL('../references/authoring/', import.meta.url);
const EPIC_TEMPLATE = readFileSync(new URL('EPIC_TEMPLATE.md', AUTHORING), 'utf8');
const TASK_TEMPLATE = readFileSync(new URL('TASK_TEMPLATE.md', AUTHORING), 'utf8');
const FENCE = String.fromCharCode(96).repeat(3);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
export const EPIC = 'docs/ai/epics/WALK-EPIC.md';
export const BRIEF = 'docs/plans/TASK-greet-T1.md';
export const EPIC_STAND_IN = 'docs/ai/epics/NEW-EPIC.md';
export const SCRATCH_EPIC = 'FEEDBACK-LOOP';
export const DOTTED_EPIC = 'WALK..EPIC';
export const PLAN_STAND_IN = 'docs/plans/WALK-EPIC-S1.md';
export const UNRENDERABLE_BRIEF = `docs/plans/TASK-greet${LINE_SEPARATOR}note-T1.md`;
export const STAGE_CELLS = ['E1-absent', 'E1-empty', 'E2', 'E3', 'E4', 'E5', 'E4-cleanup', 'E5-cleanup', 'E3-cleanup', 'E4-shared', 'epic-crlf',
  'standin-scratch', 'standin-dotted', 'E5-foreign', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
export const STATE_CELLS = ['store-refused', 'entry-unreadable', 'entry-non-regular', 'sibling-unclosed', 'sibling-field',
  'plans-unreadable', 'two-plans', 'plan-refused-premint', 'standin-epic', 'standin-plan', 'standin-brief',
  'task-file-refused', 'two-briefs', 'pruned-early', 'checkpoint-stem', 'checkpoint-sequence', 'checkpoint-tree',
  'binding-malformed', 'plan-unparseable', 'plan-unreadable', 'brief-template',
  'plan-facts-refused', 'brief-offstem-refused', 'plan-two-stories', 'brief-crlf',
  'binding-array'];
export const RESIDUAL_CELLS = ['residual-epic', 'residual-brief'];
export const CELL_NAMES = [...STAGE_CELLS, ...STATE_CELLS, ...RESIDUAL_CELLS, 'head-unborn'];

export const renderEpic = (values = {}) => renderTemplate(EPIC_TEMPLATE, { ...EPIC_VALUES, ...values });
export const renderBrief = (values = {}) => renderTemplate(TASK_TEMPLATE, { ...TASK_VALUES, ...values });
export const toolLine = (toolsDir, name, ...args) => ['node', shellQuoteArg(`${toolsDir}/${name}`), ...args].join(' ');
export const listActions = (envelope) => [
  ...envelope.states.map((item) => item.next),
  ...envelope.entries.flatMap((entry) => [entry.fact, ...entry.actions, ...entry.stories.flatMap((story) => story.actions)]),
].filter(Boolean);
const closeEpic = (text) => addResultLine(landStory(text)).replace(`state: open${LF}`, `state: landed${LF}`);
const SECOND_ROW = '- S2 | Greet twice | depends-on: S1 | owns: src/twice.mjs | shared: none | state: planned';
const addSecondStory = (text) => text.replace(/^(- S1 \|.*)$/m, `$1${LF}${SECOND_ROW}`);
const shareStory = (text) => text.replace('shared: none', 'shared: src/shared.txt');
const bindingBlock = (source) => renderLines([FENCE + 'aw-task-binding', source, FENCE]);

const createCell = (cell, options) => {
  const repo = makeRepo(`tier-guide-${cell}`, { [MODULE]: renderLines(["export const greet = () => 'Hello';"]) });
  const paths = [];
  const io = { env: repo.env };
  const write = (path, text) => {
    repo.write(path, text);
    paths.push(path);
  };
  const must = (result, step) => {
    if (!result.ok) throw new Error(`${cell}: ${step} refused: ${result.reason}`);
    return result;
  };
  const epicPath = options.epic?.EPIC_ID ? `docs/ai/epics/${options.epic.EPIC_ID}.md` : EPIC;
  const plan = options.plan ?? PLAN;
  const brief = options.brief ?? BRIEF;
  return { repo, paths, write, epicPath, plan, brief,
    writeEpic: (text = renderEpic(options.epic)) => write(epicPath, text),
    writePlan: (text = renderPlan({ story: `Story: S1 of ${options.epic?.EPIC_ID ?? 'WALK-EPIC'}` })) => write(plan, text),
    writeBrief: (text = renderBrief({ PLAN_PATH: plan, ...options.task })) => write(brief, text),
    mint: () => must(mintCheckpoint(repo.dir, plan, io), 'mint'),
    stamp: (path = brief) => must(stampBrief(repo.dir, path, io), 'stamp'),
    prune: () => must(pruneCheckpoints(repo.dir, plan, io), 'prune') };
};

const STORY_STEPS = [
  (c) => c.writePlan(),
  (c) => c.mint(),
  (c) => c.writeBrief(),
  (c) => { c.stamp(); c.write('notes.txt', renderLines(['a change after the first stamp'])); c.mint(); },
  (c) => c.stamp(),
  (c) => {
    c.write(MODULE, renderLines(["export const greet = (name) => 'Hello, ' + name;"]));
    c.write(TEST, renderLines(["import assert from 'node:assert/strict';", "import { greet } from './greet.mjs';",
      "assert.equal(greet('reader'), 'Hello, reader');"]));
    c.repo.must(['add', TEST, MODULE]);
    c.repo.must(['commit', '-qm', 'Greet the reader by name']);
  },
  (c) => c.prune(),
];
const buildStory = (stage) => (c) => {
  c.writeEpic();
  STORY_STEPS.slice(0, Number(stage.slice(1)) - 1).forEach((step) => step(c));
};
const onStory = (stage, after) => (c) => {
  buildStory(stage)(c);
  after(c);
};

const BUILDERS = {
  'E1-absent': () => {},
  'E1-empty': (c) => mkdirSync(join(c.repo.dir, 'docs/ai/epics'), { recursive: true }),
  E2: (c) => c.writeEpic(EPIC_TEMPLATE),
  E3: buildStory('S1'),
  E4: (c) => c.writeEpic(landStory(renderEpic())),
  E5: (c) => c.writeEpic(closeEpic(renderEpic())),
  'E4-cleanup': (c) => {
    c.writeEpic(landStory(renderEpic()));
    c.writePlan();
  },
  'E3-cleanup': (c) => {
    c.writeEpic(landStory(addSecondStory(renderEpic())));
    c.writePlan();
    c.mint();
  },
  'E4-shared': (c) => {
    c.write('src/shared.txt', renderLines(['shared']));
    c.writeEpic(landStory(renderEpic()));
    for (const id of ['OTHER', 'THIRD']) c.write(`docs/ai/epics/${id}.md`, shareStory(renderEpic({ EPIC_ID: id, OWNED_PATHS: `src/${id}.mjs` })));
  },
  'epic-crlf': (c) => c.writeEpic(renderEpic().replaceAll(LF, `\r${LF}`)),
  'standin-scratch': (c) => c.write(`docs/ai/epics/${SCRATCH_EPIC}.md`, renderEpic({ EPIC_ID: SCRATCH_EPIC })),
  'standin-dotted': (c) => c.write(`docs/ai/epics/${DOTTED_EPIC}.md`, renderEpic({ EPIC_ID: DOTTED_EPIC })),
  'E5-foreign': (c) => {
    c.writeEpic(closeEpic(renderEpic()));
    c.writePlan(renderPlan({ story: 'Scope: the greeting.', next: 'Story: S1 of WALK-EPIC' }));
  },
  'E5-cleanup': (c) => {
    c.writeEpic(closeEpic(renderEpic()));
    c.writePlan();
    c.mint();
  },
  ...Object.fromEntries(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].map((stage) => [stage, buildStory(stage)])),
  'store-refused': (c) => c.write('docs/ai/epics', renderLines(['not a directory'])),
  'entry-unreadable': (c) => {
    c.writeEpic();
    c.write('docs/ai/epics/LOCKED.md', renderEpic({ EPIC_ID: 'LOCKED' }));
    chmodSync(join(c.repo.dir, 'docs/ai/epics/LOCKED.md'), 0o000);
  },
  'entry-non-regular': (c) => {
    c.writeEpic();
    symlinkSync('../../../src/greet.mjs', join(c.repo.dir, 'docs/ai/epics/LINK.md'));
    c.paths.push('docs/ai/epics/LINK.md');
  },
  'sibling-unclosed': (c) => {
    c.writeEpic();
    c.write('docs/ai/epics/NOTES.md', renderLines(['---', 'type: note']));
  },
  'sibling-field': (c) => {
    c.writeEpic();
    c.write('docs/ai/epics/NOTES.md', renderLines(['---', 'type: note', 'type: note', '---', '', '# Notes']));
  },
  'plans-unreadable': (c) => {
    c.writeEpic();
    c.write('docs/plans', renderLines(['not a directory']));
  },
  'two-plans': onStory('S2', (c) => c.write('docs/plans/greet-copy.md', renderPlan())),
  'plan-refused-premint': (c) => {
    c.writeEpic();
    c.writePlan(renderPlan({ row: MODULE_ROW.replace('| modify |', '| create |') }));
  },
  'standin-epic': (c) => c.write(EPIC_STAND_IN, renderLines(['# Notes'])),
  'standin-plan': (c) => {
    c.writeEpic();
    c.write(PLAN_STAND_IN, renderLines(['# Notes']));
  },
  'standin-brief': onStory('S3', (c) => c.writeBrief(renderBrief({ PLAN_PATH: 'docs/plans/other.md' }))),
  'task-file-refused': onStory('S3', (c) => c.writeBrief(removeSection(renderBrief(), '## Negative cases'))),
  'two-briefs': onStory('S4', (c) => c.write('docs/plans/TASK-greet-copy-T1.md', renderBrief())),
  'pruned-early': onStory('S6', (c) => c.prune()),
  'checkpoint-stem': (c) => {
    c.writeEpic();
    c.write('docs/plans/greet.lock.md', renderPlan());
  },
  'checkpoint-sequence': onStory('S2', (c) => c.repo.must(['update-ref', 'refs/agent-workflow/checkpoints/greet/1',
    c.repo.must(['rev-parse', 'HEAD^{tree}'])])),
  'checkpoint-tree': onStory('S2', (c) => c.repo.must(['update-ref', 'refs/agent-workflow/checkpoints/greet/0',
    c.repo.must(['rev-parse', 'HEAD'])])),
  'binding-malformed': onStory('S4', (c) => c.writeBrief(renderBrief() + LF + bindingBlock('{"schema":1}'))),
  'plan-unparseable': onStory('S2', (c) => c.writePlan(renderPlan().replace('## Phase: Cleanup', `${FENCE}${LF}## Phase: Cleanup`))),
  'plan-unreadable': (c) => {
    c.writeEpic();
    c.writePlan();
    writeFileSync(join(c.repo.dir, c.plan), Buffer.from([0x23, 0x20, 0xff, 0x0a]));
  },
  'plan-facts-refused': onStory('S2', (c) => c.write('docs/ai/source-size.json', renderLines(['not json']))),
  'brief-offstem-refused': onStory('S3', (c) => c.write('docs/plans/TASK-greeting-T1.md', removeSection(renderBrief(), '## Negative cases'))),
  'plan-two-stories': (c) => {
    c.writeEpic(landStory(addSecondStory(renderEpic())));
    c.writePlan(renderPlan({ story: `Story: S1 of WALK-EPIC${LF}Story: S2 of WALK-EPIC` }));
  },
  'brief-crlf': onStory('S3', (c) => c.write('docs/plans/TASK-greet-first.md', renderBrief().replaceAll(LF, `\r${LF}`))),
  'brief-template': onStory('S3', (c) => c.writeBrief(TASK_TEMPLATE)),
  'binding-array': onStory('S4', (c) => c.writeBrief(renderBrief() + LF + bindingBlock(JSON.stringify({ checkpoint: ['0'.repeat(40)], head: ['0'.repeat(40)] })))),
  'residual-epic': (c) => c.writeEpic(renderEpic({ INTENT: '{{INTENT}}' })),
  'residual-brief': (c) => {
    c.writeEpic();
    c.writePlan(renderPlan({ next: '- None {{PLAN_NOTE}}.' }));
    c.mint();
    c.writeBrief(renderBrief({ NEGATIVE_CASE: '{{NEGATIVE_CASE}}' }));
    c.stamp();
  },
  'head-unborn': (c) => c.repo.must(['update-ref', '-d', 'HEAD']),
};

// makeStageRepo(cell, { epic, task, plan, brief }) — the values override the rendered epic and brief and the two paths.
export const makeStageRepo = (cell, options = {}) => {
  const build = BUILDERS[cell];
  if (!build) throw new Error(`unknown tier-guide cell: ${cell}`);
  const c = createCell(cell, options);
  try {
    build(c);
  } catch (error) {
    c.repo.cleanup();
    throw error;
  }
  return { ...c.repo, paths: c.paths, epic: c.epicPath, plan: c.plan, brief: c.brief };
};
