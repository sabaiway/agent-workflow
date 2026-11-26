#!/usr/bin/env node
// stage-write-guard/cli.mjs — docs/ai/specs/kit/stage-write-guard.md

import { isDirectRun } from '../direct-run.mjs';
import { escapeForDisplay } from '../repo-lex.mjs';
import { writeStageGuard } from './index.mjs';

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;
const APPLY_FLAG = '--apply';
const CWD_FLAG = '--cwd';
const FLAG_PREFIX = '-';
const LINE_ENDING = '\n';

const OUTCOME_LINES = Object.freeze({
  usage: () => `usage: stage-write-guard [${APPLY_FLAG}] ${CWD_FLAG} <root>`,
  unknownArgument: (arg) => `unknown argument: ${escapeForDisplay(arg)}`,
  cwdNeedsDirectory: () => `${CWD_FLAG} needs a directory argument`,
  cwdRequired: () => `${CWD_FLAG} <root> is required`,
  report: (line) => escapeForDisplay(line),
  refused: (message) => escapeForDisplay(message),
});

const usageError = (line) => Object.assign(new Error(line), { exitCode: EXIT_USAGE });

const parseArgs = (argv, parsed = { apply: false, cwd: undefined }) => {
  if (argv.length === 0) {
    if (parsed.cwd === undefined) throw usageError(OUTCOME_LINES.cwdRequired());
    return parsed;
  }
  const [arg, ...tail] = argv;
  if (arg === APPLY_FLAG) return parseArgs(tail, { ...parsed, apply: true });
  if (arg !== CWD_FLAG) throw usageError(OUTCOME_LINES.unknownArgument(arg));
  const [value, ...rest] = tail;
  if (value === undefined || value.startsWith(FLAG_PREFIX)) throw usageError(OUTCOME_LINES.cwdNeedsDirectory());
  return parseArgs(rest, { ...parsed, cwd: value });
};

const writeLine = (write, line) => write(`${line}${LINE_ENDING}`);

const main = (argv, io) => {
  try {
    const { apply, cwd } = parseArgs(argv);
    const { report } = writeStageGuard({ cwd, dryRun: !apply });
    for (const line of report.split(LINE_ENDING)) writeLine(io.stdout, OUTCOME_LINES.report(line));
    return EXIT_OK;
  } catch (error) {
    if (error?.exitCode === EXIT_USAGE) {
      writeLine(io.stderr, error.message);
      writeLine(io.stderr, OUTCOME_LINES.usage());
      return EXIT_USAGE;
    }
    writeLine(io.stderr, OUTCOME_LINES.refused(error?.message ?? String(error)));
    return EXIT_PRECONDITION;
  }
};

if (isDirectRun(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
