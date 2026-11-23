#!/usr/bin/env node

import { isDirectRun } from '../direct-run.mjs';
import { judgePlan, readPlanDocument } from '../plan-shape-facts.mjs';
import { checkPlanEntries, formatFindings, isSweep, makeFinding, parseLedger } from '../plan-shape.mjs';
import { escapeForDisplay } from '../repo-lex.mjs';
import { relateAmendments } from './index.mjs';

const USAGE = 'Usage: node plan-structure/cli.mjs <plan>';
const STRUCTURE_PREFIX = 'plan-structure: ';
const AMENDMENT_PREFIX = `${STRUCTURE_PREFIX}amendment — `;
const FIELD_SEPARATOR = ' | ';
const EMPTY_FIELD = '';
const LINE_ENDING = '\n';
const OPERAND_COUNT = 1;
const EXIT_ACCEPT = 0;
const EXIT_REFUSE = 1;
const EXIT_USAGE = 2;

const writeLine = (write, line) => write(`${line}${LINE_ENDING}`);

const judgeOperand = (cwd, operand) => {
  try {
    const document = readPlanDocument(cwd, operand);
    return judgePlan(cwd, document, { rules: checkPlanEntries });
  } catch (error) {
    return { error };
  }
};

const parseLedgerForDisplay = (text) => {
  try {
    return parseLedger(text);
  } catch {
    return null;
  }
};

const formatVerdict = (result, operand) => formatFindings({
  findings: result.findings.map(({ line, code, message, rowId }) => ({
    line: escapeForDisplay(line),
    code: escapeForDisplay(code),
    message: escapeForDisplay(message),
    rowId: rowId ? escapeForDisplay(rowId) : rowId,
  })),
  skips: result.skips.map(escapeForDisplay),
}, escapeForDisplay(operand));

const formatAmendment = ({ id, verb, path }) => {
  const fields = [id, verb, path].map((field) => escapeForDisplay(field ?? EMPTY_FIELD));
  return `${AMENDMENT_PREFIX}${fields.join(FIELD_SEPARATOR)}`;
};

export const main = (argv = process.argv.slice(2), io = {}) => {
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  if (argv.length !== OPERAND_COUNT) {
    writeLine(stderr, USAGE);
    return EXIT_USAGE;
  }

  const [operand] = argv;
  const { accepted, error, result, text } = judgeOperand(cwd, operand);
  if (error) {
    writeLine(stderr, `${STRUCTURE_PREFIX}${escapeForDisplay(error.message)}`);
    return EXIT_USAGE;
  }

  writeLine(stdout, formatVerdict(result, operand));
  const parsed = parseLedgerForDisplay(text);
  if (parsed) {
    const { entries } = relateAmendments({ parsed, makeFinding, isSweep });
    for (const entry of entries) writeLine(stdout, formatAmendment(entry));
  }
  return accepted ? EXIT_ACCEPT : EXIT_REFUSE;
};

if (isDirectRun(import.meta.url)) process.exitCode = main();
