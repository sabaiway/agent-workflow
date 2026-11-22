#!/usr/bin/env node

import { isDirectRun } from './direct-run.mjs';
import { judgePlan, readPlanDocument, readPlansInFlight } from './plan-shape-facts.mjs';
import { checkPlan, formatFindings, verifyPlan } from './plan-shape.mjs';

const USAGE = `Usage:
  node plan-shape-cli.mjs --check <plan>
  node plan-shape-cli.mjs --verify <plan>
  node plan-shape-cli.mjs --check --in-flight
  node plan-shape-cli.mjs --verify --in-flight`;

const writeLine = (write, line) => write(`${line}\n`);

const runExplicit = (cwd, arm, operand, write) => {
  const document = readPlanDocument(cwd, operand);
  const options = arm === '--check' ? { rules: checkPlan, plan: document.identity } : { rules: verifyPlan };
  const { result } = judgePlan(cwd, document, options);
  writeLine(write, formatFindings(result, operand));
  return result.findings.length === 0 ? 0 : 1;
};

const runInFlight = (cwd, write) => {
  const { plans, skipped = 0 } = readPlansInFlight(cwd);
  for (const { identity, result } of plans) writeLine(write, formatFindings(result, identity));
  writeLine(write, `plan-shape: judged plans: ${plans.length}`);
  writeLine(write, `plan-shape: skipped by shape: ${skipped}`);
  return plans.some(({ accepted }) => !accepted) ? 1 : 0;
};

export const main = (argv = process.argv.slice(2), io = {}) => {
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const [arm, operand, ...rest] = argv;
  if (!['--check', '--verify'].includes(arm) || !operand || rest.length > 0) {
    writeLine(stderr, USAGE);
    return 2;
  }
  try {
    return operand === '--in-flight' ? runInFlight(cwd, stdout) : runExplicit(cwd, arm, operand, stdout);
  } catch (error) {
    writeLine(stderr, `plan-shape: ${error.message}`);
    return 2;
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = main();
