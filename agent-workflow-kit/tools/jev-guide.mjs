#!/usr/bin/env node
// spec:jev-guide — docs/ai/specs/kit/jev-guide/index.md
import { statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { KEY_VARIABLE, RESTART_STEP, connectLine, keySet, placeOf } from './jev-facts.mjs';

const SCHEMA = 1;
const TOOLS = dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = join('typesafe-ai', 'SKILL.md');
const HELP = `jev — read-only: what Jev (TypeSafe) is, why it pays here, and the two steps to a set key.

Usage:
  node jev-guide.mjs [--dir PROJECT] [--json]

--dir   the project to read (default: the current directory).
--json  the JSON envelope instead of the plain text.
--help  answered only when it is the whole invocation.

Exit codes: 0 rendered; 1 nothing rendered (a --dir that is not a directory); 2 usage.

Reads only: the --dir, the home directory, the key variable's presence, five skill paths, and for the place WSL_DISTRO_NAME, SSH_CONNECTION, REMOTE_CONTAINERS, CODESPACES, the platform, the hostname and /.dockerenv; no network.`;

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

const KEY_GET = 'Get a key at console.typesafe.ai and set it on every host the agent runs on.';
const KEY_CONNECT = 'Connect it from a terminal of your own, never through the agent: the command asks for the key with no echo, checks it with one request and saves it for bash, zsh or fish in your shell\'s startup files, or on Windows as a user environment variable.';
const KEY_RESTART = `Then ${RESTART_STEP}. Run /agent-workflow-kit jev again: the key mark should read set.`;
const KEY_NEVER = 'Never paste the key into the chat or into a project file.';
const KEY_NOT_SET = `key: ${KEY_VARIABLE} not set. A host setting that filters the environment of the agent's commands also hides it. If it still reads not set after that restart and no such setting applies, run the connect line again and follow its last line.`;
const INSTALL = [
  'Optional, for your own code and prompts — the vendor skill:',
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
const AFTER_INSTALL = [
  'After an install, quit the agent and start it again from a new terminal.',
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
const homeOf = (io) => {
  if (io.home !== undefined) return io.home;
  try { return homedir(); } catch { return ''; }
};
// The place's host facts: each injected, else read once from the host, a failing read reading as none.
const placeFor = (io, env, platform) => placeOf({ env, platform,
  hostname: io.hostname ?? (() => { try { return hostname(); } catch { return ''; } })(),
  container: io.container ?? statIs('/.dockerenv', 'file') });
const skillPaths = (dir, home) => [...new Set([join(dir, '.claude', 'skills'), join(dir, '.agents', 'skills'),
  ...(home === '' ? [] : [join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), join(home, '.cursor', 'skills')])]
  .map((root) => join(root, SKILL_FILE)))];

const renderSteps = (found, set, connect, where) => [
  ['STEP 1 — the key', KEY_GET, KEY_CONNECT, ...(where ? [`Run it in ${where}:`] : []), connect, KEY_RESTART, KEY_NEVER,
    set ? `key: ${KEY_VARIABLE} set.` : KEY_NOT_SET],
  ['STEP 2 — the vendor skill', ...INSTALL,
    ...(found.length ? found.map((path) => `skill: found at ${path}`) : NOT_SEEN), ...AFTER_INSTALL],
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
  const found = skillPaths(dir, homeOf(io)).filter((path) => statIs(path, 'file'));
  const env = io.env ?? process.env;
  const set = keySet(env);
  const platform = io.platform ?? process.platform;
  const connect = connectLine(io.toolsDir ?? TOOLS, platform);
  const where = placeFor(io, env, platform);
  const steps = renderSteps(found, set, connect, where);
  log(parsed.json
    ? JSON.stringify({ schema: SCHEMA, command: 'jev', dir, text: JEV_TEXT, skill: { found }, key: { set }, connect, where, steps, prompts: PROMPTS }, null, 2)
    : [...JEV_TEXT, ...steps.flat(), 'WHERE IT PAYS IN THIS WORKFLOW', ...PROMPTS].join('\n'));
  return 0;
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
