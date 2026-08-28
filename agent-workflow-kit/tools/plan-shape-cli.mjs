#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tokenizeMarkdown } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { plansInFlight, PLANS_REL } from './plan-files.mjs';
import { buildFacts, openRepo } from './plan-shape-facts.mjs';
import { checkPlan, checkPlanStructure, formatFindings, parseLedger, PLAN_TITLE_PREFIX, verifyPlan } from './plan-shape.mjs';

const USAGE = `Usage:
  node plan-shape-cli.mjs --check <plan>
  node plan-shape-cli.mjs --verify <plan>
  node plan-shape-cli.mjs --check --in-flight
  node plan-shape-cli.mjs --verify --in-flight`;

const readPlan = (path) => {
  const result = readRegularFileNoFollow(path);
  if (result.outcome !== 'ok') throw new Error(`${path} must be a readable regular plan file (${result.className ?? result.code ?? result.outcome})`);
  return result.content;
};

const readPlanEntries = (cwd) => {
  try {
    return readdirSync(join(cwd, PLANS_REL), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`${PLANS_REL} could not be read (${error?.code ?? 'fs error'})`);
  }
};

const getPaths = (text) => {
  try {
    const rows = parseLedger(text).rows.filter((row) => row.valid);
    return [...rows.map((row) => row.path), ...rows.map((row) => row.anchorPath).filter(Boolean)];
  } catch {
    return [];
  }
};

const isPlanShape = (text) => {
  try {
    const first = tokenizeMarkdown(text, 'the in-flight document').headings[0];
    return Boolean(first && first.level === 1 && first.text.startsWith(PLAN_TITLE_PREFIX));
  } catch {
    return true;
  }
};

const writeLine = (write, line) => write(`${line}\n`);

// A facts failure scoped to the plan's own paths is that plan's listed finding, so the other plans
// are still judged; a repository-level refusal (the practice, a package, its pins) keeps its usage class.
const buildPlanFacts = (cwd, repo, text) => {
  try {
    return { facts: buildFacts(cwd, { paths: getPaths(text), repo }) };
  } catch (error) {
    if (error?.scope !== 'plan') throw error;
    return { findings: [{ line: 1, code: 'facts', message: error.message, rowId: null }], skips: [] };
  }
};

const judgeWith = (cwd, repo, text, rules) => {
  const built = buildPlanFacts(cwd, repo, text);
  return built.facts ? rules(text, built.facts) : built;
};

const runExplicit = (cwd, arm, operand, write) => {
  const text = readPlan(resolve(cwd, operand));
  const result = judgeWith(cwd, openRepo(cwd), text, arm === '--check' ? checkPlan : verifyPlan);
  writeLine(write, formatFindings(result, operand));
  return result.findings.length === 0 ? 0 : 1;
};

const runInFlight = (cwd, write) => {
  const entries = readPlanEntries(cwd);
  const names = plansInFlight(cwd, () => entries);
  const documents = names.map((name) => {
    const label = `${PLANS_REL}/${name}`;
    return { label, text: readPlan(resolve(cwd, label)) };
  });
  const judged = documents.filter((document) => isPlanShape(document.text));
  const repo = openRepo(cwd);
  const results = judged.map((document) => {
    const result = judgeWith(cwd, repo, document.text, checkPlanStructure);
    writeLine(write, formatFindings(result, document.label));
    return result;
  });
  writeLine(write, `plan-shape: judged plans: ${judged.length}`);
  writeLine(write, `plan-shape: skipped by shape: ${documents.length - judged.length}`);
  return results.some((result) => result.findings.length > 0) ? 1 : 0;
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
