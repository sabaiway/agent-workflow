#!/usr/bin/env node

import { isDirectRun } from '../direct-run.mjs';
import { isHex64 } from '../flow-vocabulary.mjs';
import { RECORD, CHECK, ESSENCE_FLAG, DIGEST_FLAG, EXIT_ACCEPT, EXIT_REFUSE, EXIT_USAGE, LINE_ENDING,
  OUTCOME_LINES, isOperand, readApproval, recordApproval } from './record.mjs';

export { OUTCOME_LINES, readApproval };

const parseArgs = (argv) => {
  const [command, plan, flag, value, ...extra] = argv;
  if (!isOperand(plan) || extra.length) return null;
  if (command === RECORD && flag === ESSENCE_FLAG && isOperand(value)) return { command, plan, essenceFile: value };
  if (command === CHECK && (argv.length === 2 || (flag === DIGEST_FLAG && isHex64(value)))) {
    return { command, plan, approval: value };
  }
  return null;
};

const writeLine = (write, line) => write(`${line}${LINE_ENDING}`);

export const main = (argv = process.argv.slice(2), io = {}) => {
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const args = parseArgs(argv);
  if (args === null) {
    writeLine(stderr, OUTCOME_LINES.usage());
    return EXIT_USAGE;
  }
  const { command, plan, approval, essenceFile } = args;
  const result = command === RECORD ? recordApproval(cwd, env, plan, essenceFile) : readApproval({ cwd, env, plan, approval });
  for (const line of result.malformedLines ?? []) writeLine(stderr, OUTCOME_LINES.malformed(result.recordPath, line));
  if (result.exitCode === EXIT_ACCEPT) {
    writeLine(stdout, result.written ? OUTCOME_LINES.recorded(plan, result.entry.approval, result.recordPath)
      : OUTCOME_LINES.accepted(plan, (result.match ?? result.entry).approval));
  } else {
    writeLine(stderr, result.exitCode === EXIT_REFUSE ? OUTCOME_LINES.refused(plan, result.reason) : OUTCOME_LINES.error(plan, result.reason));
    for (const finding of result.verdict?.result.findings ?? []) writeLine(stderr, OUTCOME_LINES.finding(plan, finding));
  }
  return result.exitCode;
};

if (isDirectRun(import.meta.url)) process.exitCode = main();
