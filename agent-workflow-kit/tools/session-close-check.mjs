#!/usr/bin/env node
// session-close-check.mjs — the read-only checker of a session close: judges the `## For the user`
// section of docs/ai/handover.md and its two labels. Governing contract:
// docs/ai/specs/kit/tier/session-rules/ (part session-close-check). Not a gate: a session close is
// not a commit boundary. main(argv, deps) returns, never exits, never asks; every read goes through deps.
import { resolve } from 'node:path';
import { safeLine } from './carriers.mjs';
import { isDeployed } from './checker-gates-read.mjs';
import { isDirectRun } from './direct-run.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BOM_CHAR = String.fromCharCode(65279);
const ARGV_OFFSET = 2;
const EXIT_ACCEPT = 0;
const EXIT_REFUSAL = 1;
const EXIT_CANNOT_JUDGE = 2;
const CHECK_FLAG = '--check';
const CWD_FLAG = '--cwd';
const HELP_FLAG = '--help';
const HANDOVER_REL = 'docs/ai/handover.md';
const SECTION_HEADING = '## For the user';
const SECTION_BOUNDARY = '## ';
const LABELS = Object.freeze(['**What was done, and for what:**', '**What is next, and why:**']);
const SINGLE = 1;
const SYMLINK_CLASS = 'symlink';

const STATES = Object.freeze({
  noDeployment: 'no-deployment',
  handoverSymlink: 'handover-symlink',
  handoverNotRegular: 'handover-not-regular',
  handoverUnreadable: 'handover-unreadable',
  handoverAbsent: 'handover-absent',
  sectionAbsent: 'section-absent',
  sectionTwice: 'section-twice',
  labelAbsent: 'label-absent',
  labelTwice: 'label-twice',
  labelOrder: 'label-order',
  labelEmpty: 'label-empty',
});

export const OUTCOME_LINES = Object.freeze({
  accept: () => 'session-close-check: accept — the handover carries the For the user section with both labels and their text',
  state: (name) => safeLine(name),
  labelState: (name, label) => `${safeLine(name)}: ${safeLine(label)}`,
  usage: (problem) => `usage: session-close-check.mjs --check [--cwd DIR] — ${safeLine(problem)}`,
  help: () => [
    'session-close-check.mjs --check [--cwd DIR]',
    'Judges the For the user section of docs/ai/handover.md in DIR (default: the current directory); writes nothing.',
    'Exit codes: 0 accept, 1 one refusal per line, 2 usage or cannot judge.',
  ].join(LF),
});

const result = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
const cannotJudge = (name) => result(EXIT_CANNOT_JUDGE, '', OUTCOME_LINES.state(name));

const parseArgs = (argv) => {
  if (argv.length === 1 && argv[0] === HELP_FLAG) return { help: true };
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === HELP_FLAG) return { problem: `${HELP_FLAG} takes no other argument` };
    if (flag === CHECK_FLAG) {
      if (options.check) return { problem: `${CHECK_FLAG} given twice` };
      options.check = true;
    } else if (flag === CWD_FLAG) {
      if (options.cwd !== undefined) return { problem: `${CWD_FLAG} given twice` };
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) return { problem: `${CWD_FLAG} needs a directory` };
      options.cwd = value;
      index += 1;
    } else {
      return { problem: `unknown argument ${flag}` };
    }
  }
  if (!options.check) return { problem: `${CHECK_FLAG} is required` };
  return { cwd: options.cwd ?? '.' };
};

const stripCr = (line) => (line.endsWith(CR) ? line.slice(0, -1) : line);
const isBlank = (text) => text.trim() === '';

const sectionLines = (text) => {
  const lines = text.split(LF).map(stripCr);
  if (lines[0].startsWith(BOM_CHAR)) lines[0] = lines[0].slice(BOM_CHAR.length);
  const starts = lines.flatMap((line, index) => (line === SECTION_HEADING ? [index] : []));
  if (starts.length !== SINGLE) return { state: starts.length === 0 ? STATES.sectionAbsent : STATES.sectionTwice };
  const body = lines.slice(starts[0] + 1);
  const end = body.findIndex((line) => line.startsWith(SECTION_BOUNDARY));
  return { lines: end === -1 ? body : body.slice(0, end) };
};

const isLabelLine = (line) => LABELS.some((label) => line.startsWith(label));

const hasText = (lines, index, label) => {
  if (!isBlank(lines[index].slice(label.length))) return true;
  const after = lines.slice(index + 1);
  const next = after.findIndex(isLabelLine);
  return (next === -1 ? after : after.slice(0, next)).some((line) => !isBlank(line));
};

const judgeLabels = (lines) => {
  const found = LABELS.map((label) => ({
    label,
    at: lines.flatMap((line, index) => (line.startsWith(label) ? [index] : [])),
  }));
  const once = found.filter(({ at }) => at.length === SINGLE);
  const refusals = [
    ...found.filter(({ at }) => at.length === 0).map(({ label }) => OUTCOME_LINES.labelState(STATES.labelAbsent, label)),
    ...found.filter(({ at }) => at.length > SINGLE).map(({ label }) => OUTCOME_LINES.labelState(STATES.labelTwice, label)),
  ];
  if (once.length === LABELS.length && once[1].at[0] < once[0].at[0]) refusals.push(OUTCOME_LINES.state(STATES.labelOrder));
  for (const { label, at } of once) {
    if (!hasText(lines, at[0], label)) refusals.push(OUTCOME_LINES.labelState(STATES.labelEmpty, label));
  }
  return refusals;
};

const judgeHandover = (content) => {
  const section = sectionLines(content);
  if (section.state) return [OUTCOME_LINES.state(section.state)];
  return judgeLabels(section.lines);
};

const runCheck = (options, deps) => {
  const root = resolve(options.cwd);
  if (!isDeployed(root, deps)) return cannotJudge(STATES.noDeployment);
  const read = readRegularFileNoFollow(resolve(root, HANDOVER_REL), deps);
  if (read.outcome === 'absent') return result(EXIT_REFUSAL, '', OUTCOME_LINES.state(STATES.handoverAbsent));
  if (read.outcome === 'foreign') {
    return cannotJudge(read.className === SYMLINK_CLASS ? STATES.handoverSymlink : STATES.handoverNotRegular);
  }
  if (read.outcome !== 'ok') return cannotJudge(STATES.handoverUnreadable);
  const refusals = judgeHandover(read.content);
  if (refusals.length > 0) return result(EXIT_REFUSAL, '', refusals.join(LF));
  return result(EXIT_ACCEPT, OUTCOME_LINES.accept());
};

export const main = (argv, deps = {}) => {
  const parsed = parseArgs(argv);
  if (parsed.help) return result(EXIT_ACCEPT, OUTCOME_LINES.help());
  if (parsed.problem) return result(EXIT_CANNOT_JUDGE, '', OUTCOME_LINES.usage(parsed.problem));
  return runCheck(parsed, deps);
};

if (isDirectRun(import.meta.url)) {
  const outcome = main(process.argv.slice(ARGV_OFFSET));
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exitCode = outcome.code;
}
