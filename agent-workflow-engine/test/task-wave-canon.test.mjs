import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const planning = readFileSync(new URL('../references/planning.md', import.meta.url), 'utf8');
const procedures = readFileSync(new URL('../references/procedures.md', import.meta.url), 'utf8');
const flatten = (text) => text.replace(/\s+/g, ' ').trim();
const getSection = (text, name, scenario) => {
  const match = text.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  assert.ok(match, `${scenario}: section ${name} is absent`);
  return match[1];
};
const getStep = (section, number, scenario) => {
  const match = section.match(new RegExp(`^${number}\\. [\\s\\S]*?(?=^${number + 1}\\. )`, 'm'));
  assert.ok(match, `${scenario}: step ${number} has no next-step boundary`);
  return match[0];
};
const getFoldGroup = (step) => {
  const opening = 'when `execute` resolved to Delegated';
  const closing = 'what the delegate cannot reach.';
  const start = step.indexOf(opening);
  assert.notEqual(start, -1, 'S10: step 5 lost the fold opening anchor');
  const end = step.indexOf(closing, start);
  assert.notEqual(end, -1, 'S10: step 5 lost the fold closing anchor');
  return flatten(step.slice(start, end + closing.length));
};
const assertTokens = (text, tokens, scenario) => {
  for (const [reason, pattern] of tokens) assert.match(text, pattern, `${scenario}: ${reason}`);
};
const RETIRED_COMMANDS = [
  ['checkpoint.mjs', /\bcheckpoint(?:\.mjs)?\b/i], ['task-brief', /\btask-brief(?:\.mjs)?\b/i],
  ['stamp', /\bstamp\b/i], ['mint', /\bmint\b/i], ['dispatch open', /\bdispatch open\b/i],
  ['dispatch return', /\bdispatch return\b/i], ['--checkpoint', /--checkpoint\b/],
  ['--dispatch', /--dispatch\b/], ['TASK-', /\bTASK-/],
];
const assertRetired = (text, tokens, scenario, surface) => {
  for (const [name, pattern] of tokens) assert.doesNotMatch(text, pattern, `${scenario}: ${surface} still names ${name}`);
};

describe('spec:story-flow/S8 The task hands out one prompt and reads the returned tree', () => {
  const task = flatten(getSection(planning, 'The task', 'S8'));
  it('S8: names one row, a prompt file, Files, Reads and a fresh bridge contract nonce', () => {
    assertTokens(task, [
      ['The task omits the prompt', /\bprompt\b/i], ['The task omits one row', /\bone\b[^.]*\brow\b/i],
      ['the prompt omits its file', /\bfile\b/i], ['the bridge omits a fresh nonce per invocation', /`aw-dispatch-contract` block holding a fresh nonce for every bridge invocation/],
      ['the prompt omits its Files and Reads', /its Files, the paths the carrier may write, none ignored or excluded by git; its Reads, the governing scenario lines verbatim and every other file it must read/],
    ], 'S8');
  });
  it('S8: stages the story and leaves prior unstaged or untracked paths with no other writer', () => {
    assertTokens(task, [
      ['the hand-out omits staged changes', /\bA hand-out starts with the story's changes staged\b/], ['the hand-out omits the other-writer precondition', /\bno other\b[^.]*\bwrit(?:e|es|er|ers)\b/i],
      ['prior paths are not left as they are', /shows unstaged or untracked is not the story's, is never staged, sits in no row's Files, and the read leaves it as it is/],
      ['the read does not exempt prior paths', /other than one it showed unstaged or untracked before the hand-out/],
    ], 'S8');
  });
  it('S8: restores outside-Files writes from the index before the rows tests', () => {
    assertTokens(task, [
      ['the read omits the index', /\bindex\b/i], ['the read omits outside Files', /\boutside\b[^.]*\bFiles\b/],
      ['the read omits restoration', /\brestor(?:e|es|ed)\b/i],
      ['restoration does not precede the row tests', /restored from the index[^.]*only then does the orchestrator run each row's tests/],
    ], 'S8');
  });
  it('S8: accepts a run by the task-run rule and calls the tests its one check', () => assertTokens(task, [
    ['the tests are not its one check', /the row's tests are its one check/], ['red omits the absent name', /fails for the reason its scenario states, or on the absence of a name the plan adds/],
    ['an interrupted run or one with no edit is accepted', /was interrupted or returned no edit/],
  ], 'S8'));
  it('S8: retries vehicle quota refusal once and names the model in the session record', () => {
    assertTokens(task, [
      ['the retry omits quota refusal', /\bquota\b/i], ['the retry omits its once limit', /\bonce\b/i],
      ['the retry omits the fallback model', /\bfallback\b/i], ['the retry omits its session record', /\bsession record\b/i],
      ['the retry omits the model that ran', /\bmodel\b/i],
    ], 'S8');
    assert.doesNotMatch(task, /\bas a recorded dispatch\b/i, 'S8: the retry still rides a recorded dispatch');
  });
  it('S8: retires the task commands', () => assertRetired(task, RETIRED_COMMANDS, 'S8', 'The task'));
});

describe('spec:story-flow/S9 the orchestrator writes the task prompt and verifies the hand-out', () => {
  const task = flatten(getSection(procedures, 'task', 'S9'));
  const step2 = flatten(getStep(getSection(procedures, 'plan-execution', 'S9'), 2, 'S9'));
  it('S9: task ignores the author carrier for writing and verifies execute by read and tests', () => {
    assertTokens(task, [
      ['task omits the prompt', /\bprompt\b/i], ['task omits the orchestrator writer', /\borchestrator\b[^.]*\bwrites?\b/i],
      ['task does not cover every author resolution', /\bwhatever\b.*?\bauthor\b/i],
      ['task omits the execute carrier', /\bexecute\b/i], ['task omits the hand-out read', /\bread\b[^.]*\bhand-out\b/i],
      ['task omits the row tests', /\brow\b[^.]*\btests\b/i], ['the quota retry omits the executor vehicle', /a run of the executor vehicle refused for its model's quota/], ['Return omits that run session', /resumes that run's session/],
    ], 'S9');
  });
  it('S9: step 2 task sentence hands the orchestrators prompt to execute and keeps the read and tests', () => {
    const sentence = step2.split(/(?<=[.!?])\s+/).find((text) => /\btask(?:s)?\b/i.test(text));
    assert.ok(sentence, 'S9: step 2 omits its task sentence');
    assertTokens(sentence, [
      ['step 2 task sentence omits the prompt', /\bprompt\b/i], ['step 2 task sentence omits its writer', /\borchestrator\b/i],
      ['step 2 task sentence omits the author resolution', /\bwhatever\b.*?\bauthor\b/i],
      ['step 2 task sentence omits execute', /\bexecute\b/i], ['step 2 task sentence omits the read', /\bread\b/i],
      ['step 2 task sentence omits row tests', /\btests\b/i],
    ], 'S9');
    assertRetired(sentence, [...RETIRED_COMMANDS, ['a brief', /\bbrief\b/i]], 'S9', 'step 2 task sentence');
  });
  it('S9: retires the brief and dispatch commands from task', () => assertRetired(task, [...RETIRED_COMMANDS, ['a brief', /\bbrief\b/i]], 'S9', 'task'));
});

describe('spec:story-flow/S10 step 5 folds into the bridge runs receipt session', () => {
  const execution = getSection(procedures, 'plan-execution', 'S10');
  const step5 = flatten(getStep(execution, 5, 'S10'));
  it('S10: reads the run session id from the exec receipt and resumes it for the fold', () => {
    assertTokens(getFoldGroup(getStep(execution, 5, 'S10')), [
      ['the fold omits the receipt session id', /\bsessionId\b|\bsession id\b/i],
      ['the fold omits the exec receipt', /\bexec receipt\b/i], ['the fold omits resume', /--resume\b/],
      ['the fold omits the bridge code', /\bcode\b/i], ['the fold omits its run', /\brun\b/i],
      ['the fold omits reading the receipt', /\bread\b/i], ['the fold omits that run session', /back to that run's session/], ['the fold omits that run receipt', /the `sessionId` of the run's exec receipt/],
    ], 'S10');
  });
  it('S10: removes held ids, task chains and the forbidden-substitution rule', () => {
    assertRetired(step5, [
      ['held id', /<?\bheld id\b>?/i], ["task's chain", /\btask's chain\b/i],
      ['untasked', /\buntasked\b/i], ['forbidden substitution', /\bforbidden substitution\b/i],
    ], 'S10', 'step 5');
  });
  it('S10: preserves the execution Slots line and steps 1 through 8', () => {
    assert.equal(execution.trim().split('\n')[0], 'Slots: execute, review', 'S10: execution Slots changed');
    assert.deepEqual([...execution.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])),
      [1, 2, 3, 4, 5, 6, 7, 8], 'S10: execution step numbers changed');
  });
});

describe('spec:task-thread/S11 retires the wave canon and its task chain', () => {
  it('S11: The task names no wave, task flag, dispatch open or nonced restore', () => {
    assertRetired(flatten(getSection(planning, 'The task', 'S11')), [
      ['wave', /\bwave\b/i], ['--task', /--task\b/], ['dispatch open', /\bdispatch open\b/i],
      ['restore <oid> --nonce', /\brestore <oid> --nonce\b/],
    ], 'S11', 'The task');
  });
  it('S11: step 5 names no task chain', () => {
    assertRetired(flatten(getStep(getSection(procedures, 'plan-execution', 'S11'), 5, 'S11')),
      [["task's chain", /\btask's chain\b/i], ['untasked', /\buntasked\b/i]], 'S11', 'step 5');
  });
});
