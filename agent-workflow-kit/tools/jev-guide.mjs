#!/usr/bin/env node
// spec:jev-guide — docs/ai/specs/kit/jev-guide/index.md
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';

const SCHEMA = 1;
const KEY_VARIABLE = 'TYPESAFE_API_KEY';
const SKILL_FILE = join('typesafe-ai', 'SKILL.md');
const HELP = `jev — read-only: what Jev (TypeSafe) is, why it pays here, and the steps to a first request.

Usage:
  node jev-guide.mjs [--dir PROJECT] [--json]

--dir   the project to read (default: the current directory).
--json  the JSON envelope instead of the plain text.
--help  answered only when it is the whole invocation.

Exit codes: 0 rendered; 1 nothing rendered (a --dir that is not a directory); 2 usage.

Reads only: the --dir, the home directory, the key variable's presence, the SHELL variable and five skill paths; no network.`;

export const JEV_TEXT = Object.freeze([
  'WHAT: Jev is a decision model: it takes a state and typed questions (choice, score, noul) and returns typed answers with probabilities and a confidence; it does not write text.',
  'WHY HERE: a typed decision with a confidence instead of prompt-and-parse, in the user\'s own code and in the agent\'s scratch scripts.',
  'Price and latency as the vendor states them: 0.042 dollars per million input tokens, output free; sub-second.',
  'NOT: "Jev is not a drop-in replacement for the LLM behind Claude Code, Cursor, opencode, Copilot" (the vendor).',
  'Jagged edge of jev-1.13: it reads literally.',
  'Jagged edge of jev-1.13: no counting or arithmetic.',
  'Jagged edge of jev-1.13: dates are read as text.',
  'Jagged edge of jev-1.13: a large irrelevant state distracts it.',
  'Jagged edge of jev-1.13: adversarial content can move the answer.',
  'Jagged edge of jev-1.13: indirection lowers accuracy.',
  'Jagged edge of jev-1.13: no structural invariants across questions.',
  'Jagged edge of jev-1.13: no generation.',
  'A confidence is not a correctness: start with conservative thresholds and test with your own data.',
  'Retention as the vendor states it: zero data retention for enterprise customers only; a data processing agreement covers retention; a commitment not to train on user data.',
  'SOURCES: docs.typesafe.ai for every Jev claim, read 2026-09-29.',
  'The skills CLI README (github.com/vercel-labs/skills) for the skill paths, read 2026-09-29.',
  'code.claude.com for claude plugin list, read 2026-09-29.',
]);

const INSTALL = [
  'Claude Code:',
  'claude plugin marketplace add typesafe-ai/skills',
  'claude plugin install typesafe@typesafe-ai',
  'Other agents:',
  'npx skills add typesafe-ai/skills --skill typesafe-ai',
];
const NOT_SEEN = [
  'skill: not seen at the five skill paths. A plugin install is not visible to a file check; check it by its owners:',
  '/typesafe:typesafe-ai',
  'in a Claude Code session (the vendor); ask any other agent to use the TypeSafe skill (the vendor); or run Claude Code\'s own',
  'claude plugin list',
];
const PROFILES = Object.freeze({ zsh: '~/.zshrc', bash: '~/.bashrc' });
const KEY_LINE = 'set +x; printf \'TYPESAFE_API_KEY: \' && read -rs k && echo && { echo; printf \'export TYPESAFE_API_KEY=%q\' "$k"; echo; } >> PROFILE && unset k';
const KEY_GET = 'Get a key at console.typesafe.ai and set it on every host the agent runs on.';
const KEY_RUN = 'Run this line yourself in a terminal of your own, outside the agent: it reads the key with no echo, so the key never passes through the agent or its transcript.';
const KEY_EDITOR = 'Set TYPESAFE_API_KEY to your key in your shell\'s startup file, in an editor and in that shell\'s own syntax, never through the chat or a project file.';
const KEY_RESTART = 'Then quit the agent, start it again from a new terminal, and run /agent-workflow-kit jev again: the key mark reads set.';
const KEY_NEVER = 'Never paste the key into the chat or into a project file.';
const keyNotSet = (profile) => `key: ${KEY_VARIABLE} not set. A host setting that filters the environment of the agent's commands also hides it. If it still reads not set after a restart and no such setting applies, the agent may not have been started from a shell that reads ${profile ?? 'that startup file'}: export the variable in the file the agent's launcher reads, then restart.`;
const CURL = 'set +x; curl -q -sS -w \' HTTP %{http_code}\' -X POST https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" -d \'{"state":"Help! My payouts have been failing for 3 days.","model":"jev-latest","questions":{"department":{"type":"choice","instructions":"Which team should handle this?","criteria":{"billing":"Payments, invoicing, refunds","technical":"Bugs, outages, integrations","sales":"Pricing, upgrades, new accounts"}}}}\'';
const FIRST_USE = [
  'The vendor\'s smallest documented request, reading the key from the environment:',
  CURL,
  'The check: HTTP 200 and a response whose answers.department carries a choice and a confidence; any other code reads by the four error meanings below.',
  'Its documented response:',
  '{"model":"jev-1.13.0","answers":{"department":{"type":"choice","choice":"billing","probabilities":{"billing":0.88,"technical":0.12,"sales":0.0},"confidence":0.81}},"usage":{"input_tokens":318,"output_tokens":34}}',
  'choice: "The highest-probability option."',
  'probabilities: "Every option mapped to its probability (floats that sum to 1)."',
  'confidence: "How certain the model is, derived from probabilities."',
  '401: "Missing or invalid API key. Check the `Authorization` header."',
  '422: "The request body failed validation — for example a missing required field or a malformed question. The body details the offending field."',
  '429: "You have exceeded your rate limit. Back off and retry after a short delay."',
  '529: "TypeSafe is temporarily overloaded. Retry after a short delay."',
  'Then give the agent this prompt: using the TypeSafe skill, route these three tickets to billing, technical or sales, one request each, and print each choice and confidence — "I was charged twice this month.", "The app crashes when I upload a file.", "Is there a discount for a yearly plan?".',
  'Success: three choices, each with a confidence.',
];
const LIMITS = 'Each request stays within the vendor limits: 255 options, 64k tokens, 32k for the state plus the longest question.';
const HINT = 'The answer is a hint the agent checks, never a gate; every candidate text is sent to the vendor.';
const PROMPTS = [
  `(a) A red gate log: give each failing gate's own lines ids and ask one choice of the first real error per failing gate. ${LIMITS} ${HINT}`,
  `(b) Council findings against the decided register: for each finding, ask a choice of the register id it repeats, or none. ${LIMITS} ${HINT}`,
  `(c) Candidate paragraphs with ids: ask one noul each that the paragraph restates a named rule. ${LIMITS} ${HINT}`,
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

const statIs = (path, kind) => {
  try { return kind === 'file' ? statSync(path).isFile() : statSync(path).isDirectory(); } catch { return false; }
};
const skillPaths = (dir, home) => [...new Set([join(dir, '.claude', 'skills'), join(dir, '.agents', 'skills'),
  join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), join(home, '.cursor', 'skills')]
  .map((root) => join(root, SKILL_FILE)))];
export const keySet = (env) => typeof env[KEY_VARIABLE] === 'string' && env[KEY_VARIABLE].trim() !== '';
const profileOf = (env) => (typeof env.SHELL === 'string' && Object.hasOwn(PROFILES, basename(env.SHELL)) ? PROFILES[basename(env.SHELL)] : null);

const renderSteps = (found, set, profile) => [
  ['STEP 1 — the key', KEY_GET, ...(profile ? [KEY_RUN, KEY_LINE.replace('PROFILE', profile)] : [KEY_EDITOR]), KEY_RESTART,
    KEY_NEVER, set ? `key: ${KEY_VARIABLE} set.` : keyNotSet(profile)],
  ['STEP 2 — the vendor skill', ...INSTALL,
    ...(found.length ? found.map((path) => `skill: found at ${path}`) : NOT_SEEN)],
  ['STEP 3 — the first request', ...FIRST_USE],
];

export const main = (argv, io = {}) => {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const parsed = (() => {
    try { return parseArgv(argv); } catch (err) { error(err.message); return null; }
  })();
  if (parsed === null) return 2;
  if (parsed.help) { log(HELP); return 0; }
  const dir = resolve(io.cwd ?? process.cwd(), parsed.dir);
  if (!statIs(dir, 'directory')) { error(`${dir} is not a directory`); return 1; }
  const found = skillPaths(dir, io.home ?? homedir()).filter((path) => statIs(path, 'file'));
  const env = io.env ?? process.env;
  const set = keySet(env);
  const profile = profileOf(env);
  const steps = renderSteps(found, set, profile);
  log(parsed.json
    ? JSON.stringify({ schema: SCHEMA, command: 'jev', dir, text: JEV_TEXT, skill: { found }, key: { set, profile },
      steps, prompts: PROMPTS }, null, 2)
    : [...JEV_TEXT, ...steps.flat(), 'WHERE IT PAYS IN THIS WORKFLOW', ...PROMPTS].join('\n'));
  return 0;
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
