// The ladder of the tier-guide suites: one repository per stage E1 to E5 and S1 to S4, per leftover of a landed
// story, per rendered state and per residual cell, over makeRepo. It declares no test and imports nothing under test.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { makeRepo } from './hostile-git-harness.test.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { EPIC_VALUES, LF, MODULE, MODULE_ROW, PLAN, TASK_VALUES, addResultLine, landStory, renderLines, renderPlan,
  renderTemplate } from '../test/tier-walk-harness.test.mjs';

const AUTHORING = new URL('../references/authoring/', import.meta.url);
const EPIC_TEMPLATE = readFileSync(new URL('EPIC_TEMPLATE.md', AUTHORING), 'utf8');
const TASK_TEMPLATE = readFileSync(new URL('TASK_TEMPLATE.md', AUTHORING), 'utf8');
const FENCE = String.fromCharCode(96).repeat(3);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PLAN_TITLE = '# Plan: Greet the reader';
export const EPIC = 'docs/ai/epics/WALK-EPIC.md';
export const EPIC_STAND_IN = 'docs/ai/epics/NEW-EPIC.md';
export const SCRATCH_EPIC = 'FEEDBACK-LOOP';
export const DOTTED_EPIC = 'WALK..EPIC';
export const PLAN_STAND_IN = 'docs/plans/WALK-EPIC-S1.md';
export const OTHER_PLAN = 'docs/plans/other.md';
export const UNRENDERABLE_PLAN = `docs/plans/greet${LINE_SEPARATOR}note.md`;
export const SECOND_ROW = 'M2 | create | src/farewell.mjs | Bid the reader farewell | n/a | src/greet.mjs:1';
// A contract row: a LEDGER ROW lies outside docs/ai/, so no prompt is ever owed for it.
export const DOCS_ROW = 'D1 | modify | docs/ai/specs/greet.md | State the greeting | n/a | docs/ai/specs/greet.md:1';
// A sweep row: its stage line names the paths the glob expands to on disk, never a git add of the glob.
export const SWEEP_ROW = 'M1 | modify | src/*.mjs | Greet the reader by name | n/a | src/greet.mjs:1';
// The canonical prompt name, docs/plans/EXECUTE-PROMPT-<plan stem>-<row id>.md: plan greet row x-M1 and plan
// greet-x row M1 derive the same one.
export const promptPath = (plan, id) => `docs/plans/EXECUTE-PROMPT-${posix.basename(plan, '.md')}-${id}.md`;
export const SECOND_PROMPT = promptPath(PLAN, 'M2');
export const SHARED_PROMPT = promptPath(PLAN, 'x-M1');
export const STAGE_CELLS = ['E1-absent', 'E1-empty', 'E2', 'E3', 'E4', 'E5', 'E4-shared', 'epic-crlf', 'standin-scratch',
  'standin-dotted', 'E5-foreign', 'S1', 'S2', 'S3', 'S4', 'S2-docs-row', 'S4-docs-only', 'S4-sweep', 'plan-refused-premint',
  'plan-facts-refused', 'prompt-offname', 'E3-leftover', 'E3-leftover-staged', 'E4-leftover', 'E5-leftover',
  'leftover-barrier'];
export const STATE_CELLS = ['store-refused', 'entry-unreadable', 'entry-non-regular', 'sibling-unclosed', 'sibling-field',
  'plans-unreadable', 'two-plans', 'standin-epic', 'standin-plan', 'plan-unreadable', 'plan-unparseable',
  'plan-two-stories', 'plan-no-row', 'prompt-unreadable', 'prompt-non-regular', 'prompt-shared-name', 'prompt-gap',
  'leftover-two-epics', 'leftover-unborn', 'index-unreadable', 'leftover-shared-name', 'head-unreadable'];
export const RESIDUAL_CELLS = ['residual-epic', 'residual-prompt'];
export const CELL_NAMES = [...STAGE_CELLS, ...STATE_CELLS, ...RESIDUAL_CELLS, 'head-unborn'];

export const renderEpic = (values = {}) => renderTemplate(EPIC_TEMPLATE, { ...EPIC_VALUES, ...values });
export const renderPrompt = (values = {}) => renderTemplate(TASK_TEMPLATE, { ...TASK_VALUES, ...values });
export const toolLine = (toolsDir, name, ...args) => ['node', shellQuoteArg(`${toolsDir}/${name}`), ...args].join(' ');
export const listActions = (envelope) => [
  ...envelope.states.map((item) => item.next),
  ...envelope.entries.flatMap((entry) => [entry.fact, ...entry.actions, ...entry.stories.flatMap((story) => story.actions)]),
].filter(Boolean);
const closeEpic = (text) => addResultLine(landStory(text)).replace(`state: open${LF}`, `state: landed${LF}`);
const storyRow = (dependsOn) => `- S2 | Greet twice | depends-on: ${dependsOn} | owns: src/twice.mjs | shared: none | state: planned`;
const addSecondStory = (text, dependsOn = 'S1') => text.replace(/^(- S1 \|.*)$/m, `$1${LF}${storyRow(dependsOn)}`);
const shareStory = (text) => text.replace('shared: none', 'shared: src/shared.txt');
const TWO_ROWS = [MODULE_ROW, SECOND_ROW].join(LF);
const ROW_VALUES = { M1: {}, M2: { ROW_LINE: SECOND_ROW, FILE_PATH: 'src/farewell.mjs' } };

const createCell = (cell, options) => {
  const repo = makeRepo(`tier-guide-${cell}`, { [MODULE]: renderLines(["export const greet = () => 'Hello';"]) });
  const paths = [];
  const write = (path, text) => {
    repo.write(path, text);
    paths.push(path);
  };
  const epicId = options.epic?.EPIC_ID ?? 'WALK-EPIC';
  const epicPath = `docs/ai/epics/${epicId}.md`;
  const plan = options.plan ?? PLAN;
  const planText = (values = {}) => {
    const text = renderPlan({ story: `Story: S1 of ${epicId}`, ...values });
    return options.title ? text.replace(PLAN_TITLE, `# Plan: ${options.title}`) : text;
  };
  return { repo, paths, write, epicPath, plan, planText,
    writeEpic: (text = renderEpic(options.epic)) => write(epicPath, text),
    writePlan: (values) => write(plan, planText(values)),
    writePrompt: (id = 'M1', values = {}) => write(promptPath(plan, id),
      renderPrompt({ PLAN_PATH: plan, ...ROW_VALUES[id], ...options.task, ...values })),
    // A staged index: a change of the module, added, so the index differs from HEAD.
    stage: () => {
      write(MODULE, renderLines(["export const greet = (name) => 'Hello, ' + name;"]));
      repo.must(['add', '--', MODULE]);
    } };
};

const STORIES = {
  S1: (c) => c.writeEpic(),
  S2: (c) => { c.writeEpic(); c.writePlan(); },
  S3: (c) => { c.writeEpic(); c.writePlan({ row: TWO_ROWS }); c.writePrompt('M1'); },
  S4: (c) => { c.writeEpic(); c.writePlan(); c.writePrompt('M1'); },
};
const onStory = (stage, after) => (c) => {
  STORIES[stage](c);
  after(c);
};
// Plan greet row x-M1 on S1 and plan greet-x row M1 on S2 derive one prompt name.
const sharedName = (c, epicOf = (text) => text) => {
  c.writeEpic(epicOf(addSecondStory(renderEpic(), 'none')));
  c.writePlan({ row: MODULE_ROW.replace('M1 |', 'x-M1 |') });
  c.write('docs/plans/greet-x.md', c.planText({ story: 'Story: S2 of WALK-EPIC',
    row: 'M1 | create | src/twice.mjs | Greet twice | n/a | src/greet.mjs:1' }));
};
const leftover = (text, after = () => {}) => (c) => {
  c.writeEpic(text);
  c.writePlan();
  after(c);
};

const BUILDERS = {
  'E1-absent': () => {},
  'E1-empty': (c) => mkdirSync(join(c.repo.dir, 'docs/ai/epics'), { recursive: true }),
  E2: (c) => c.writeEpic(EPIC_TEMPLATE),
  E3: STORIES.S1,
  E4: (c) => c.writeEpic(landStory(renderEpic())),
  E5: (c) => c.writeEpic(closeEpic(renderEpic())),
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
    c.writePlan({ story: 'Scope: the greeting.', next: 'Story: S1 of WALK-EPIC' });
  },
  ...STORIES,
  'S2-docs-row': (c) => { c.writeEpic(); c.writePlan({ row: [DOCS_ROW, MODULE_ROW].join(LF) }); },
  'S4-docs-only': (c) => { c.writeEpic(); c.writePlan({ row: DOCS_ROW }); },
  'S4-sweep': (c) => { c.writeEpic(); c.writePlan({ row: SWEEP_ROW }); c.writePrompt('M1', { ROW_LINE: SWEEP_ROW }); },
  // Plans the plan check refuses — a create row whose file exists, an unreadable source-size record: the guide
  // judges no plan, so each stands at S2.
  'plan-refused-premint': (c) => { c.writeEpic(); c.writePlan({ row: MODULE_ROW.replace('| modify |', '| create |') }); },
  'plan-facts-refused': onStory('S2', (c) => c.write('docs/ai/source-size.json', renderLines(['not json']))),
  // A brief an earlier kit left and a prompt under another plan's name: neither is the row's prompt.
  'prompt-offname': onStory('S2', (c) => {
    c.write('docs/plans/TASK-greet-T1.md', renderPrompt());
    c.write(promptPath(OTHER_PLAN, 'M1'), renderPrompt());
  }),
  'E3-leftover': leftover(landStory(addSecondStory(renderEpic()))),
  'E3-leftover-staged': leftover(landStory(addSecondStory(renderEpic())), (c) => c.stage()),
  'E4-leftover': leftover(landStory(renderEpic()), (c) => { c.writePrompt('M1'); c.stage(); }),
  'E5-leftover': leftover(closeEpic(renderEpic()), (c) => c.writePrompt('M1')),
  'leftover-barrier': leftover(landStory(renderEpic()), (c) => {
    c.write('docs/ai/epics/OTHER.md', renderEpic({ EPIC_ID: 'OTHER', OWNED_PATHS: 'src/other.mjs' }));
    c.write('docs/ai/epics/THIRD.md', landStory(renderEpic({ EPIC_ID: 'THIRD', OWNED_PATHS: 'src/third.mjs' })));
  }),
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
  'two-plans': onStory('S2', (c) => c.write('docs/plans/greet-copy.md', c.planText())),
  'standin-epic': (c) => c.write(EPIC_STAND_IN, renderLines(['# Notes'])),
  'standin-plan': (c) => {
    c.writeEpic();
    c.write(PLAN_STAND_IN, renderLines(['# Notes']));
  },
  'plan-unreadable': (c) => {
    c.writeEpic();
    c.writePlan();
    writeFileSync(join(c.repo.dir, c.plan), Buffer.from([0x23, 0x20, 0xff, 0x0a]));
  },
  'plan-unparseable': onStory('S2', (c) => c.write(c.plan, c.planText().replace('## Phase: Cleanup', `${FENCE}${LF}## Phase: Cleanup`))),
  'plan-two-stories': (c) => {
    c.writeEpic(landStory(addSecondStory(renderEpic())));
    c.writePlan({ story: `Story: S1 of WALK-EPIC${LF}Story: S2 of WALK-EPIC` });
  },
  'plan-no-row': (c) => {
    c.writeEpic();
    c.writePlan({ row: MODULE_ROW.slice(0, MODULE_ROW.lastIndexOf(' | ')) });
  },
  'prompt-unreadable': onStory('S2', (c) => {
    c.writePrompt('M1');
    chmodSync(join(c.repo.dir, promptPath(c.plan, 'M1')), 0o000);
  }),
  'prompt-non-regular': onStory('S2', (c) => {
    symlinkSync('../../src/greet.mjs', join(c.repo.dir, promptPath(c.plan, 'M1')));
    c.paths.push(promptPath(c.plan, 'M1'));
  }),
  'prompt-shared-name': (c) => sharedName(c),
  'prompt-gap': (c) => {
    c.writeEpic();
    c.writePlan({ row: TWO_ROWS });
    c.writePrompt('M2');
  },
  'leftover-two-epics': leftover(landStory(renderEpic()), (c) => {
    c.write('docs/ai/epics/OTHER.md', landStory(renderEpic({ EPIC_ID: 'OTHER', OWNED_PATHS: 'src/other.mjs' })));
    c.write(OTHER_PLAN, c.planText({ story: 'Story: S1 of OTHER' }));
    c.stage();
  }),
  'leftover-unborn': leftover(landStory(renderEpic()), (c) => c.repo.must(['update-ref', '-d', 'HEAD'])),
  'index-unreadable': leftover(landStory(renderEpic()),
    (c) => writeFileSync(join(c.repo.dir, '.git/index'), 'not an index')),
  // A landed plan whose prompt name another plan derives: its leftover would remove the other plan's prompt.
  'leftover-shared-name': (c) => {
    sharedName(c, landStory);
    c.write(SHARED_PROMPT, renderPrompt());
  },
  'residual-epic': (c) => c.writeEpic(renderEpic({ INTENT: '{{INTENT}}' })),
  'residual-prompt': (c) => {
    c.writeEpic();
    c.writePlan({ next: '- None {{PLAN_NOTE}}.' });
    c.writePrompt('M1', { SCENARIO_LINE: '{{SCENARIO_LINE}}' });
  },
  'head-unborn': (c) => c.repo.must(['update-ref', '-d', 'HEAD']),
  // HEAD's commit object corrupt: rev-parse exits 128, a refusal, never the unborn HEAD's absent answer.
  'head-unreadable': (c) => {
    c.writeEpic();
    const oid = c.repo.must(['rev-parse', 'HEAD']);
    const object = join(c.repo.dir, '.git/objects', oid.slice(0, 2), oid.slice(2));
    chmodSync(object, 0o644);
    writeFileSync(object, 'not a zlib stream');
  },
};

// makeStageRepo(cell, { epic, task, plan, title }) — the values override the rendered epic and prompts, the plan's
// path and the plan's title.
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
  return { ...c.repo, paths: c.paths, epic: c.epicPath, plan: c.plan, prompt: promptPath(c.plan, 'M1') };
};
