import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipWithoutGit } from '../hostile-git-harness.test.mjs';
import { shellQuoteArg } from '../repo-lex.mjs';
import { CELL_NAMES, EPIC, EPIC_STAND_IN, OTHER_PLAN, PLAN_STAND_IN, SHARED_PROMPT, UNRENDERABLE_PLAN, listActions,
  makeStageRepo, toolLine } from '../tier-guide-harness.test.mjs';
import { LF, PLAN, PROMPT } from '../../test/tier-walk-harness.test.mjs';

const loaded = await import('../tier-guide.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const TOOLS = dirname(dirname(fileURLToPath(import.meta.url)));
const TODAY = '2026-09-22';
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const SKIP_UNREADABLE = process.getuid?.() === 0 ? 'root reads a mode 000 file' : false;
const UNREADABLE = new Set(['entry-unreadable', 'prompt-unreadable']);
const ANY = Symbol('a cell of the table the contract leaves to the code: any non-empty name or path');
const node = (name, ...args) => toolLine(TOOLS, name, ...args);
const check = node('epic-shape-cli.mjs', '--check', EPIC);
const planCheck = node('plan-shape-cli.mjs', '--check', PLAN);

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
const storyOf = (envelope) => storiesOf(envelope)[0] ?? assert.fail(`no story in hand: ${JSON.stringify(envelope.states)}`);
const commandsOf = (envelope) => listActions(envelope).map(({ command }) => command).filter(Boolean);
const assertField = (actual, expected, label) => (expected === ANY
  ? assert.ok(typeof actual === 'string' && actual !== '', `${label}: ${actual}`) : assert.deepEqual(actual, expected, label));

const STATES = [
  ['store-refused', 'readEpicStore', 'docs/ai/epics', /regular file/, null, []],
  ['entry-unreadable', 'readEpicStore', 'docs/ai/epics/LOCKED.md', /unreadable/, null, ['E2'], SKIP_UNREADABLE],
  ['entry-non-regular', 'readEpicStore', 'docs/ai/epics/LINK.md', /non-regular/, null, ['E2']],
  ['sibling-unclosed', 'sweepSiblings', 'docs/ai/epics/NOTES.md', /never closes/, check, ['E2']],
  ['sibling-field', 'sweepSiblings', 'docs/ai/epics/NOTES.md', /repeated field/, check, ['E2']],
  ['plans-unreadable', 'readPlanEntries', 'docs/plans', /^docs\/plans could not be read \(ENOTDIR\)$/, null, []],
  ['two-plans', 'plansInFlight', 'docs/plans/greet-copy.md', /greet-copy\.md.*docs\/plans\/greet\.md/, null, ['E3']],
  ['standin-epic', 'readEpicStore', EPIC_STAND_IN, /stand-in/, null, []],
  ['standin-plan', 'plansInFlight', PLAN_STAND_IN, /stand-in/, null, ['E3']],
  ['plan-unreadable', 'plansInFlight', PLAN, /UTF-8/, null, ['E3']],
  ['plan-unparseable', 'parseLedger', PLAN, /fence/, planCheck, ['E3']],
  ['plan-two-stories', 'readStoryLine', PLAN, /names its story with one line/, planCheck, ['E3']],
  ['plan-no-row', 'parseLedger', PLAN, /valid row/, planCheck, ['E3']],
  ['prompt-unreadable', 'readRegularFileNoFollow', PROMPT, /EACCES/, null, ['E3'], SKIP_UNREADABLE],
  ['prompt-non-regular', 'readRegularFileNoFollow', PROMPT, /symlink/, null, ['E3']],
  ['prompt-shared-name', ANY, SHARED_PROMPT, /(?=.*docs\/plans\/greet\.md)(?=.*docs\/plans\/greet-x\.md)/, null, ['E3']],
  ['prompt-gap', ANY, ANY, /(?=.*\bM1\b)(?=.*\bM2\b)/, ANY, ['E3']],
  ['leftover-two-epics', ANY, ANY, new RegExp(`(?=.*${PLAN})(?=.*${OTHER_PLAN})`), null, ANY],
  ['leftover-unborn', ANY, ANY, /unborn/, null, ANY],
  ['index-unreadable', ANY, ANY, /index file/, null, ANY],
  ['leftover-shared-name', ANY, SHARED_PROMPT, /(?=.*docs\/plans\/greet\.md)(?=.*docs\/plans\/greet-x\.md)/, null, ['E3']],
  ['head-unreadable', 'readGit', null, /corrupt/, null, []],
];

describe('spec:tier-guide/S3 every rendered state names its reader, file and cause', { skip: skipWithoutGit }, () => {
  for (const [cell, reader, file, cause, next, stages, skip = false] of STATES) it(cell, { skip }, () => {
    const envelope = runCell(cell);
    assert.equal(envelope.states.length, 1, `rendered states: ${JSON.stringify(envelope.states)}`);
    const [item] = envelope.states;
    assertField(item.reader, reader, 'reader');
    assertField(item.file, file, 'file');
    assert.match(item.cause, cause);
    assert.ok(!item.cause.includes(LF));
    if (next === ANY) assert.match(item.next?.text ?? '', /remove/, 'remove the prompts after the gap, then copy and fill the first');
    else assert.equal(item.next?.command ?? null, next);
    if (typeof next === 'string') assert.equal(item.next.kind, 'run');
    if (cell === 'plan-no-row') assert.match(item.next.text, /ledger row/, 'add a ledger row, then the plan check');
    if (stages !== ANY) assert.deepEqual(envelope.entries.map((entry) => entry.stage), stages);
    else assert.ok(!commandsOf(envelope).some((command) => /^git (commit|diff) /.test(command)), 'no diff or commit line');
    assert.deepEqual(storiesOf(envelope), [], 'no story stage renders beside the state');
    for (const entry of envelope.entries.filter(({ stage }) => stage === 'E2')) assert.deepEqual(entry.actions.map(({ command }) => command), [check]);
    if (cell === 'plan-two-stories') assert.deepEqual(envelope.entries[0].actions, [], 'no leftover for a plan whose story is unread');
    if (cell === 'leftover-shared-name') assert.deepEqual(envelope.entries[0].actions, [], 'no leftover removes a prompt another plan derives');
  });
});

describe('spec:tier-guide/S4 a placeholder left in an accepted epic or a prompt of the plan comes first', { skip: skipWithoutGit }, () => {
  it('names the epic span before the fact and the story list', () => {
    const envelope = runCell('residual-epic');
    assert.deepEqual(envelope.entries[0].residual, [{ file: EPIC, span: 'INTENT' }]);
    const lines = runCell('residual-epic', {}, []).split(LF);
    const residual = lines.indexOf(`  placeholder INTENT in ${EPIC}`);
    assert.ok(residual > 0 && residual < lines.indexOf(check), 'the residual precedes the fact line');
  });

  it('names the prompt span before the stage list and never scans the plan', () => {
    const envelope = runCell('residual-prompt');
    const story = storyOf(envelope);
    assert.equal(story.stage, 'S4', 'the stage is unchanged by the span');
    assert.deepEqual(story.residual, [{ file: PROMPT, span: 'SCENARIO_LINE' }]);
    assert.ok(!JSON.stringify(envelope).includes('PLAN_NOTE'));
    const lines = runCell('residual-prompt', {}, []).split(LF);
    const residual = lines.indexOf(`    placeholder SCENARIO_LINE in ${PROMPT}`);
    assert.ok(residual > 0 && residual < lines.findIndex((line) => line.startsWith('    1. ')), 'the residual precedes the first action');
  });

  it('names no span of a filled prompt or of an epic the check refuses', () => {
    assert.deepEqual(storyOf(runCell('S4')).residual, []);
    assert.deepEqual(runCell('E2').entries[0].residual, []);
  });
});

describe('spec:tier-guide/S5 every printed command is runnable as printed', { skip: skipWithoutGit }, () => {
  const storyActions = (envelope) => storyOf(envelope).actions;
  it('quotes a path with a space as one shell word', () => {
    const path = 'docs/plans/greet copy.md';
    const [planCheckLine, copy] = storyActions(runCell('S2', { plan: path }));
    assert.equal(planCheckLine.command, node('plan-shape-cli.mjs', '--check', `'${path}'`));
    assert.ok(copy.command.endsWith(" 'docs/plans/EXECUTE-PROMPT-greet copy-M1.md'"), copy.command);
  });

  it('quotes the plan title after -m as one shell word', () => {
    const commands = commandsOf(runCell('E4-leftover', { title: "Greet the reader's name" }));
    assert.deepEqual(commands.filter((command) => command.startsWith('git commit')), ["git commit -m 'Greet the reader'\\''s name'"]);
  });

  it('prints no line of a prompt: its Run commands are named in a run action with no command', () => {
    const task = { RUN_COMMAND: "node --test 'src/greet.test.mjs' && echo done", FORBIDDEN_COMMAND: 'git push --force' };
    const [envelope, plain] = [runCell('S4', { task }), runCell('S4', { task }, [])];
    for (const line of Object.values(task)) assert.ok(!plain.includes(line) && !JSON.stringify(envelope).includes(line), line);
    assert.deepEqual(storyActions(envelope).filter(({ kind, command }) => kind === 'run' && command === null)
      .map(({ text }) => text.includes(PROMPT)), [true], 'one run action, naming the prompt');
  });

  it('names a value no line can carry and prints no command for it', () => {
    const [planCheckLine] = storyActions(runCell('S2', { plan: UNRENDERABLE_PLAN }));
    assert.equal(planCheckLine.command, null);
    assert.ok(planCheckLine.text.includes('\\u2028') && !planCheckLine.text.includes(LINE_SEPARATOR), planCheckLine.text);
  });

  it('prints no angle-bracket placeholder and the tools directory as given, in every cell', () => {
    for (const cell of CELL_NAMES.filter((name) => !UNREADABLE.has(name) || !SKIP_UNREADABLE)) {
      assert.doesNotMatch(runCell(cell, {}, []), /<[A-Za-z_-]+>/, cell);
      for (const command of commandsOf(runCell(cell)).filter((line) => line.startsWith('node '))) {
        assert.ok(command.startsWith(`node ${shellQuoteArg(`${TOOLS}/`)}`), `${cell}: ${command}`);
      }
    }
  });

  it('derives the plan stand-in from the epic id and the prompt name from the plan stem on disk', () => {
    const plan = storyActions(runCell('S1', { epic: { EPIC_ID: 'OTHER-EPIC' } }))[1];
    assert.match(plan.text, /docs\/plans\/OTHER-EPIC-S1\.md/);
    const [, copy] = storyActions(runCell('S2', { plan: 'docs/plans/renamed.md' }));
    assert.ok(copy.command.endsWith(' docs/plans/EXECUTE-PROMPT-renamed-M1.md'), copy.command);
  });

  it('finds the plan by its Story line under another name', () => {
    const story = storyOf(runCell('S2', { plan: 'docs/plans/renamed.md' }));
    assert.deepEqual([story.stage, story.plan], ['S2', 'docs/plans/renamed.md']);
    assert.equal(story.actions[0].command, node('plan-shape-cli.mjs', '--check', 'docs/plans/renamed.md'));
  });

  it('finds a prompt by its canonical name and never by its content', () => {
    const story = storyOf(runCell('prompt-offname'));
    assert.equal(story.stage, 'S2', 'a TASK brief and a prompt under another plan\'s name carry no row');
    assert.ok(story.actions[1].command.endsWith(` ${PROMPT}`), story.actions[1].command);
  });
});
