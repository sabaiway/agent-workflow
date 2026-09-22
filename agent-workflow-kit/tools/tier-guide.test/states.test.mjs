import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipWithoutGit } from '../hostile-git-harness.test.mjs';
import { shellQuoteArg } from '../repo-lex.mjs';
import { BRIEF, CELL_NAMES, EPIC, EPIC_STAND_IN, PLAN_STAND_IN, UNRENDERABLE_BRIEF, listActions,
  makeStageRepo, toolLine } from '../tier-guide-harness.test.mjs';
import { LF, PLAN } from '../../test/tier-walk-harness.test.mjs';

const loaded = await import('../tier-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const TOOLS = dirname(dirname(fileURLToPath(import.meta.url)));
const TODAY = '2026-09-22';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const SKIP_UNREADABLE = process.getuid?.() === 0 ? 'root reads a mode 000 file' : false;
const node = (name, ...args) => toolLine(TOOLS, name, ...args);
const check = node('epic-shape-cli.mjs', '--check', EPIC);

const runCell = (cell, options, argv = ['--json']) => {
  const repo = makeStageRepo(cell, options);
  const out = [];
  try {
    const code = main(['--dir', repo.dir, ...argv], { log: (text) => out.push(text), error: (text) => out.push(text), env: repo.env, today: TODAY });
    assert.equal(code, 0, `${cell}: ${out.join(LF)}`);
    return argv.includes('--json') ? JSON.parse(out.join(LF)) : out.join(LF);
  } finally {
    repo.cleanup();
  }
};
const storiesOf = (envelope) => envelope.entries.flatMap((entry) => entry.stories);

const STATES = [
  ['store-refused', 'readEpicStore', 'docs/ai/epics', /regular file/, null, []],
  ['entry-unreadable', 'readEpicStore', 'docs/ai/epics/LOCKED.md', /unreadable/, null, ['E2'], SKIP_UNREADABLE],
  ['entry-non-regular', 'readEpicStore', 'docs/ai/epics/LINK.md', /non-regular/, null, ['E2']],
  ['sibling-unclosed', 'sweepSiblings', 'docs/ai/epics/NOTES.md', /never closes/, check, ['E2']],
  ['sibling-field', 'sweepSiblings', 'docs/ai/epics/NOTES.md', /repeated field/, check, ['E2']],
  ['plans-unreadable', 'readPlanEntries', 'docs/plans', /^docs\/plans could not be read \(ENOTDIR\)$/, null, []],
  ['two-plans', 'plansInFlight', 'docs/plans/greet-copy.md', /greet-copy\.md.*docs\/plans\/greet\.md/, null, ['E3']],
  ['plan-refused-premint', 'checkPlan', PLAN, /expects absent/, node('plan-shape-cli.mjs', '--check', PLAN), ['E3']],
  ['standin-epic', 'readEpicStore', EPIC_STAND_IN, /stand-in/, null, []],
  ['standin-plan', 'plansInFlight', PLAN_STAND_IN, /stand-in/, null, ['E3']],
  ['standin-brief', 'parseBrief', BRIEF, /docs\/plans\/other\.md/, null, ['E3']],
  ['task-file-refused', 'parseBrief', BRIEF, /^shape: .*## Negative cases/, node('task-brief.mjs', 'stamp', BRIEF), ['E3']],
  ['two-briefs', 'parseBrief', BRIEF, /TASK-greet-copy-T1\.md/, null, ['E3']],
  ['pruned-early', 'newestCheckpoint', PLAN, /pruned/, node('checkpoint.mjs', 'mint', '--plan', PLAN), ['E3']],
  ['checkpoint-stem', 'newestCheckpoint', 'docs/plans/greet.lock.md', /^stem: /, null, ['E3']],
  ['checkpoint-sequence', 'newestCheckpoint', PLAN, /^sequence: /, null, ['E3']],
  ['checkpoint-tree', 'newestCheckpoint', PLAN, /not a tree/, null, ['E3']],
  ['binding-malformed', 'parseBrief', BRIEF, /^binding: /, node('task-brief.mjs', 'check', BRIEF), ['E3']],
  ['plan-unparseable', 'checkPlan', PLAN, /fence/, node('plan-shape-cli.mjs', '--check', PLAN), ['E3']],
  ['plan-unreadable', 'plansInFlight', PLAN, /UTF-8/, null, ['E3']],
  ['brief-template', 'parseBrief', BRIEF, /^shape: /, node('task-brief.mjs', 'stamp', BRIEF), ['E3']],
  ['brief-offstem-refused', 'parseBrief', 'docs/plans/TASK-greeting-T1.md', /^shape: .*## Negative cases/, node('task-brief.mjs', 'stamp', 'docs/plans/TASK-greeting-T1.md'), ['E3']],
  ['binding-array', 'parseBrief', BRIEF, /^binding: /, node('task-brief.mjs', 'check', BRIEF), ['E3']],
  ['plan-two-stories', 'checkPlan', PLAN, /names its story with one line/, node('plan-shape-cli.mjs', '--check', PLAN), ['E3']],
  ['plan-facts-refused', 'checkPlan', PLAN, /source-size\.json is not valid JSON/, node('plan-shape-cli.mjs', '--check', PLAN), ['E3']],
];

describe('spec:tier-guide/S3 every rendered state names its reader, file and cause', { skip: skipWithoutGit }, () => {
  for (const [cell, reader, file, cause, next, stages, skip = false] of STATES) it(cell, { skip }, () => {
    const envelope = runCell(cell);
    assert.equal(envelope.states.length, 1, JSON.stringify(envelope.states));
    const [item] = envelope.states;
    assert.deepEqual([item.reader, item.file], [reader, file]);
    assert.match(item.cause, cause);
    assert.ok(!item.cause.includes(LF));
    assert.equal(item.next?.command ?? null, next);
    if (next) assert.equal(item.next.kind, 'run');
    assert.deepEqual(envelope.entries.map((entry) => entry.stage), stages);
    assert.deepEqual(storiesOf(envelope), []);
    for (const entry of envelope.entries.filter(({ stage }) => stage === 'E2')) assert.deepEqual(entry.actions.map(({ command }) => command), [check]);
    if (cell === 'plan-two-stories') assert.deepEqual(envelope.entries[0].actions, [], 'no Cleanup for a plan whose story is unread');
  });
});

describe('spec:tier-guide/S4 a placeholder left in an accepted epic or a stamped brief comes first', { skip: skipWithoutGit }, () => {
  it('names the epic span before the fact and the story list', () => {
    const envelope = runCell('residual-epic');
    assert.deepEqual(envelope.entries[0].residual, [{ file: EPIC, span: 'INTENT' }]);
    const lines = runCell('residual-epic', {}, []).split(LF);
    const residual = lines.indexOf(`  placeholder INTENT in ${EPIC}`);
    assert.ok(residual > 0 && residual < lines.indexOf(check), 'the residual precedes the fact line');
  });

  it('names the stamped brief span before the actions and never scans the plan', () => {
    const envelope = runCell('residual-brief');
    const [story] = storiesOf(envelope);
    assert.equal(story.stage, 'S6');
    assert.deepEqual(story.residual, [{ file: BRIEF, span: 'NEGATIVE_CASE' }]);
    assert.ok(!JSON.stringify(envelope).includes('PLAN_NOTE'));
    const lines = runCell('residual-brief', {}, []).split(LF);
    const residual = lines.indexOf(`    placeholder NEGATIVE_CASE in ${BRIEF}`);
    assert.ok(residual > 0 && residual < lines.indexOf(node('task-brief.mjs', 'check', BRIEF)));
  });

  it('names no span of an unstamped brief or of an epic the check refuses', () => {
    const unstamped = runCell('S4', { task: { NEGATIVE_CASE: '{{NEGATIVE_CASE}}' } });
    assert.deepEqual(storiesOf(unstamped)[0].residual, []);
    assert.deepEqual(runCell('E2').entries[0].residual, []);
  });
});

describe('spec:tier-guide/S5 every printed command is runnable as printed', { skip: skipWithoutGit }, () => {
  const storyActions = (envelope) => storiesOf(envelope)[0].actions;

  it('quotes a path with a space as one shell word', () => {
    const path = 'docs/plans/TASK-greet copy-T1.md';
    assert.equal(storyActions(runCell('S4', { brief: path }))[0].command, node('task-brief.mjs', 'stamp', `'${path}'`));
  });

  it('quotes the brief title after -m as one shell word', () => {
    const actions = storyActions(runCell('S6', { task: { TASK_NAME: "Greet the reader's name" } }));
    assert.equal(actions.at(-1).command, "git commit -m 'Greet the reader'\\''s name'");
  });

  it('prints an Acceptance command line unchanged', () => {
    const command = "node --test 'src/greet.test.mjs' && echo done";
    const actions = storyActions(runCell('S6', { task: { ACCEPTANCE_COMMAND: command } }));
    assert.deepEqual(actions.filter((item) => item.command === command).map(({ kind }) => kind), ['run']);
  });

  it('names a value no line can carry and prints no command for it', () => {
    const [stamp] = storyActions(runCell('S4', { brief: UNRENDERABLE_BRIEF }));
    assert.equal(stamp.command, null);
    assert.ok(stamp.text.includes('\\u2028'));
    assert.ok(!stamp.text.includes(LINE_SEPARATOR));
  });

  it('prints no angle-bracket placeholder and the tools directory as given, in every cell', () => {
    for (const cell of CELL_NAMES.filter((name) => name !== 'entry-unreadable' || !SKIP_UNREADABLE)) {
      assert.doesNotMatch(runCell(cell, {}, []), /<[A-Za-z_-]+>/, cell);
      for (const { command } of listActions(runCell(cell)).filter((item) => item.command?.startsWith('node ') && !item.command.startsWith('node --test'))) {
        assert.ok(command.startsWith(`node ${shellQuoteArg(`${TOOLS}/`)}`), `${cell}: ${command}`);
      }
    }
  });

  it('derives the stand-in names from the epic id and the plan stem on disk', () => {
    const plan = storyActions(runCell('S1', { epic: { EPIC_ID: 'OTHER-EPIC' } }))[1];
    assert.match(plan.text, /docs\/plans\/OTHER-EPIC-S1\.md/);
    const [copy] = storyActions(runCell('S3', { plan: 'docs/plans/renamed.md' }));
    assert.ok(copy.command.endsWith(' docs/plans/TASK-renamed-T1.md'), copy.command);
  });

  it('finds the plan by its Story line under another name', () => {
    const [story] = storiesOf(runCell('S2', { plan: 'docs/plans/renamed.md' }));
    assert.deepEqual([story.stage, story.plan], ['S2', 'docs/plans/renamed.md']);
    assert.equal(story.actions[1].command, node('checkpoint.mjs', 'mint', '--plan', 'docs/plans/renamed.md'));
  });
});
