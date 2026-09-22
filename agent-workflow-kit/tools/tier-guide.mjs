#!/usr/bin/env node
// spec:tier-guide — docs/ai/specs/kit/tier/tier-guide/index.md
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { readTierFacts } from './tier-guide-facts.mjs';

const SCHEMA = 1;
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const INDENT = '  ';
const HELP = `tier — read-only: what the epic, story and task tier is, and the next step of the walk.

Usage:
  node tier-guide.mjs [--dir PROJECT] [--json]

--dir   the project to read (default: the current directory).
--json  the JSON envelope instead of the plain text.
--help  answered only when it is the whole invocation.

Exit codes: 0 anything rendered, a rendered state included; 1 nothing rendered (a --dir that is not a
git work tree); 2 usage.

Reads only: no store, no receipt, no cache, no lock.`;

const EPIC_KEYS = [
  ['DATE', 'the day the epic was last updated, YYYY-MM-DD.'],
  ['EPIC_TITLE', 'the epic in a few plain words.'],
  ['INTENT', 'what the epic sets out to change.'],
  ['VALUE', 'what a user gains once every story has landed.'],
  ['NON_GOALS', 'what the epic will not do.'],
  ['ACCEPTANCE', 'how anyone can tell the epic is done.'],
  ['SPECS', 'the contracts the epic governs, or none.'],
  ['STORY_NAME', 'the first story in a few plain words.'],
  ['OWNED_PATHS', 'the files the first story owns, comma separated.'],
  ['EPIC_ID', 'the epic file\'s own stem; the Queue line must equal it.'],
  ['QUEUE_BUCKET', 'the queue section the epic\'s row stands in.'],
];
const TASK_KEYS = [
  ['TASK_NAME', 'the task in a few plain words; the commit title.'],
  ['STORY_ID', 'the story the task serves: S1, S2 and so on.'],
  ['EPIC_ID', 'the epic the story belongs to, its file stem.'],
  ['PLAN_PATH', 'the plan under docs/plans that carries the row.'],
  ['ROW_ID', 'the ledger row the task carries.'],
  ['TEST_PATH', 'the test file of the row, written first.'],
  ['MODULE_PATH', 'the module file of the row.'],
  ['ACCEPTANCE_COMMAND', 'a command line that proves the task done.'],
  ['EXPECTED_OUTCOME', 'what that command answers when the task is done.'],
  ['NEGATIVE_CASE', 'a case the task must not break.'],
  ['NEGATIVE_OUTCOME', 'what stays true in that case.'],
  ['TEST_MAX_LINES', 'the line budget of the test file.'],
  ['MODULE_MAX_LINES', 'the line budget of the module file.'],
];
const renderTier = (toolsDir, cwd) => [
  'An epic is one outcome too large for one plan, split into stories in its ledger under docs/ai/epics.',
  'A story is one row of an epic\'s ledger, carried by one plan under docs/plans.',
  'A task is one row of a story\'s plan, carried by one brief bound to a checkpoint.',
  'A story runs as five sessions: spec, plan, tests, code, diff review + release + record.',
  `The epic template: ${resolve(toolsDir, '../references/authoring/EPIC_TEMPLATE.md')}`,
  `The task template: ${resolve(toolsDir, '../references/authoring/TASK_TEMPLATE.md')}`,
  'Epic template keys:',
  ...EPIC_KEYS.map(([key, text]) => `${INDENT}${key}: ${text}`),
  'Task template keys:',
  ...TASK_KEYS.map(([key, text]) => `${INDENT}${key}: ${text}`),
  'What the setup still lacks against the reference profile is the Recommendations screen:',
  `node ${shellQuoteArg(`${toolsDir}/recommendations.mjs`)} --cwd ${shellQuoteArg(cwd)}`,
];

const valueAt = (argv, index, flag) => {
  const value = argv[index + 1];
  if (value === undefined || value === '' || value.startsWith('-')) throw fail(2, `${flag} takes a value`);
  return value;
};
const parseArgv = (argv) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    if (argv.length !== 1) throw fail(2, '--help is answered only when it is the whole invocation');
    return { help: true };
  }
  return argv.reduce((parsed, arg, index) => {
    if (parsed.skip) return { ...parsed, skip: false };
    if (arg === '--dir') return { ...parsed, dir: valueAt(argv, index, arg), skip: true };
    if (arg === '--json') return { ...parsed, json: true };
    throw fail(2, `unknown argument "${arg}" — run with --help`);
  }, { help: false, dir: '.', json: false, skip: false });
};

const renderActions = (actions, indent) => actions.flatMap((item, index) =>
  [`${indent}${index + 1}. ${item.text}`, ...(item.command === null ? [] : [item.command])]);
const renderResidual = (residual, indent) => residual.map(({ file, span }) => `${indent}placeholder ${span} in ${file}`);
const renderEntry = (entry) => [
  `${INDENT}epic ${entry.id ?? '-'} ${entry.path ?? '-'} - stage ${entry.stage}`,
  ...(entry.cause ? [`${INDENT}${entry.cause}`] : []),
  ...renderResidual(entry.residual, INDENT),
  ...(entry.fact ? [`${INDENT}accepted: ${entry.fact.text}`, entry.fact.command] : []),
  ...entry.stories.flatMap((story) => [`${INDENT}story ${story.id} - stage ${story.stage}`,
    ...renderResidual(story.residual, INDENT + INDENT), ...renderActions(story.actions, INDENT + INDENT)]),
  ...renderActions(entry.actions, INDENT),
];
const renderPlain = (tier, facts) => [
  'TIER', ...tier,
  ...(facts.states.length ? ['STATES', ...facts.states.flatMap((item) => [
    `${INDENT}${item.reader}${item.file === null ? '' : ` ${item.file}`}: ${item.cause}`,
    ...(item.next ? [`${INDENT}${INDENT}next: ${item.next.text}`, ...(item.next.command === null ? [] : [item.next.command])] : [])])] : []),
  `EPICS (entries skipped: ${facts.skipped})`, ...facts.entries.flatMap(renderEntry),
].join('\n');

export const main = (argv, io = {}) => {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const parsed = (() => {
    try { return parseArgv(argv); } catch (err) { error(err.message); return null; }
  })();
  if (parsed === null) return 2;
  if (parsed.help) { log(HELP); return 0; }
  const cwd = resolve(io.cwd ?? process.cwd(), parsed.dir);
  const env = { ...(io.env ?? process.env), GIT_OPTIONAL_LOCKS: '0' };
  const today = io.today ?? new Date().toISOString().slice(0, 10);
  const facts = readTierFacts({ cwd, env, toolsDir: TOOLS_DIR, today });
  if (facts.location.state !== 'work-tree') {
    error(`${cwd} is not a git work tree (${facts.location.state}: ${facts.location.cause})`);
    return 1;
  }
  const tier = renderTier(TOOLS_DIR, cwd);
  log(parsed.json ? JSON.stringify({ schema: SCHEMA, command: 'tier', dir: cwd, tier,
    states: facts.states, entries: facts.entries, skipped: facts.skipped }, null, 2) : renderPlain(tier, facts));
  return 0;
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
