#!/usr/bin/env node

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_SCHEMA, readSpecDocument } from '../../references/scripts/spec-schema/index.mjs';
import { resolveReceiptsPath } from '../core-evidence-receipts.mjs';
import { isDirectRun } from '../direct-run.mjs';
import { canonicalFlowDigest } from '../flow-record-identity.mjs';
import { isHex64 } from '../flow-vocabulary.mjs';
import { readRegularFileNoFollow } from '../fs-read-nofollow.mjs';
import { judgePlan, readPlanDocument } from '../plan-shape-facts.mjs';
import { escapeForDisplay, isSeedablePathToken, lexicalRepoRelative, shellQuoteArg } from '../repo-lex.mjs';
import { getRevisionHomePath } from '../spec-check-ops.mjs';
import { createStoreAppendLane } from '../store-append.mjs';
import { APPROVAL_RECORD_BASENAME, approvedParts, composeEntry, digestContract, digestPlan, findMatch, parseEntries } from './index.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const CLI_TOKEN = isSeedablePathToken(CLI_PATH) ? CLI_PATH : shellQuoteArg(CLI_PATH);
const RECORD = 'record';
const CHECK = 'check';
const ESSENCE_FLAG = '--essence-file';
const DIGEST_FLAG = '--digest';
const CONTRACT_VERBS = new Set(['create', 'modify']);
const EXIT_ACCEPT = 0;
const EXIT_REFUSE = 1;
const EXIT_USAGE = 2;
const LINE_ENDING = '\n';
const LOCK_SUFFIX = '.lock';
const YEAR_WIDTH = 4;
const DAY_MONTH_WIDTH = 2;

const renderRecordCommand = (plan) => `node ${CLI_TOKEN} ${RECORD} ${shellQuoteArg(plan)} ${ESSENCE_FLAG} <file>`;
const display = escapeForDisplay;

export const OUTCOME_LINES = Object.freeze({
  usage: () => `Usage: node ${display(CLI_TOKEN)} ${RECORD} <plan> ${ESSENCE_FLAG} <file> | ${CHECK} <plan> [${DIGEST_FLAG} <approval>]`,
  accepted: (plan, approval) => `plan-approval: ACCEPT — ${display(plan)} (${display(approval)})`,
  recorded: (plan, approval, recordPath) => `plan-approval: RECORDED — ${display(plan)} (${display(approval)}) at ${display(recordPath)}`,
  refused: (plan, reason) => `plan-approval: REFUSE — ${display(plan)}: ${display(reason)}; ${display(renderRecordCommand(plan))}`,
  error: (plan, reason) => `plan-approval: ERROR — ${display(plan)}: ${display(reason)}`,
  finding: (plan, finding) => `${display(plan)}:${display(finding.line)}: ${display(finding.code)}: ${display(finding.message)}`,
  malformed: (recordPath, line) => `plan-approval: malformed entry at ${display(recordPath)}: line ${display(line)}`,
});

const refuse = (exitCode, reason, fields = {}) => ({ ...fields, exitCode, reason });
const describeReadFailure = (read) => read.closeFailure ?? read.code ?? read.className ?? read.outcome;

const readJudgedPlan = (cwd, plan) => {
  try {
    const document = readPlanDocument(cwd, plan);
    const verdict = judgePlan(cwd, document);
    const planDigest = digestPlan(verdict.text, verdict);
    const fields = { verdict, planDigest };
    return verdict.accepted && planDigest !== null
      ? { ...fields, exitCode: EXIT_ACCEPT }
      : refuse(EXIT_REFUSE, 'the plan structure does not accept', fields);
  } catch (error) {
    return refuse(EXIT_USAGE, error.message);
  }
};

const resolveRecordPath = (cwd, env) => {
  const receipts = resolveReceiptsPath(cwd, env);
  return receipts === null ? null : join(dirname(receipts), APPROVAL_RECORD_BASENAME);
};

const readRecord = (cwd, env) => {
  const recordPath = resolveRecordPath(cwd, env);
  if (recordPath === null) return refuse(EXIT_USAGE, 'no git directory for the approval record');
  const read = readRegularFileNoFollow(recordPath);
  if (read.closeFailure || !['ok', 'absent'].includes(read.outcome)) {
    return refuse(EXIT_USAGE, `cannot read ${recordPath} (${describeReadFailure(read)})`, { recordPath });
  }
  return { recordPath, ...parseEntries(read.outcome === 'absent' ? '' : read.content), exitCode: EXIT_ACCEPT };
};

const readContract = (cwd, plan, path) => {
  const home = getRevisionHomePath(plan, path);
  if (home === null) return refuse(EXIT_REFUSE, `cannot resolve the revision home for ${path}`);
  const revision = readRegularFileNoFollow(resolve(cwd, home));
  const source = revision.outcome === 'absent' && !revision.closeFailure ? path : home;
  const read = source === path ? readRegularFileNoFollow(resolve(cwd, path)) : revision;
  if (read.outcome !== 'ok' || read.closeFailure) return refuse(EXIT_REFUSE, `cannot read contract ${path} at ${source} (${describeReadFailure(read)})`);
  const { kind, errors } = readSpecDocument(read.content, path.slice(SPEC_SCHEMA.storePrefix.length));
  if (errors.length) return refuse(EXIT_REFUSE, `contract ${path} at ${source}: ${errors.map(({ message }) => message).join('; ')}`);
  return { exitCode: EXIT_ACCEPT, pair: kind === 'index' ? null : [path, digestContract(read.content)] };
};

const readContracts = (cwd, plan, verdict) => {
  const paths = [...new Set(approvedParts(verdict.text, verdict).rows
    .filter(({ verb, path }) => CONTRACT_VERBS.has(verb) && path.startsWith(SPEC_SCHEMA.storePrefix))
    .map(({ path }) => path))].sort();
  const pairs = [];
  for (const path of paths) {
    try {
      const result = readContract(cwd, plan, path);
      if (result.exitCode !== EXIT_ACCEPT) return result;
      if (result.pair !== null) pairs.push(result.pair);
    } catch (error) {
      return refuse(EXIT_REFUSE, `cannot digest contract ${path}: ${error.message}`);
    }
  }
  return { exitCode: EXIT_ACCEPT, contracts: pairs.map(([path]) => path), contractsDigest: canonicalFlowDigest(pairs) };
};

export const readApproval = ({ cwd = process.cwd(), env = process.env, plan, approval, contractsCwd = cwd } = {}) => {
  if (!isOperand(plan) || (approval !== undefined && !isHex64(approval))) {
    return refuse(EXIT_USAGE, 'invalid plan operand or approval digest');
  }
  const judged = readJudgedPlan(cwd, plan);
  if (judged.exitCode !== EXIT_ACCEPT) return judged;
  const { verdict, planDigest } = judged;
  const record = readRecord(cwd, env);
  if (record.exitCode !== EXIT_ACCEPT) return { verdict, planDigest, ...record };
  const { entries, malformedLines, recordPath } = record;
  const fields = { verdict, planDigest, malformedLines, recordPath, match: null };
  const candidates = entries.filter((entry) => entry.planDigest === planDigest && (approval === undefined || entry.approval === approval));
  const contractRefusals = [];
  for (const entry of candidates) {
    const contracts = entry.from === 'provision' ? {} : readContracts(contractsCwd, entry.plan, verdict);
    if (contracts.exitCode === EXIT_REFUSE) {
      contractRefusals.push(contracts.reason);
      continue;
    }
    const match = findMatch([entry], { planDigest, contractsDigest: contracts.contractsDigest, approval });
    if (match !== null) return { ...fields, match, exitCode: EXIT_ACCEPT };
  }
  return refuse(EXIT_REFUSE, contractRefusals.length ? contractRefusals.join('; ') : 'no matching approval record', fields);
};

const findTwin = (entries, entry) => entries.find(({ approval, plan }) => approval === entry.approval && plan === entry.plan);
const stop = (message) => new Error(message);
const appendLane = createStoreAppendLane({
  nouns: { store: 'plan approval store', adj: 'plan-approval', record: 'plan approval entry' },
  envNames: { store: 'AW_REVIEW_RECEIPTS', waitKnob: 'AW_PLAN_APPROVAL_LOCK_WAIT_MS', pollKnob: 'AW_PLAN_APPROVAL_LOCK_POLL_MS' },
  stop,
  resolveStorePath: resolveRecordPath,
  resolveLockPath: (path) => `${path}${LOCK_SUFFIX}`,
  validateRecord: (entry) => {
    const { malformedReasons } = parseEntries(JSON.stringify(entry));
    return malformedReasons.length ? { ok: false, reason: malformedReasons[0] } : { ok: true };
  },
  parseStoreText: (text) => {
    const { entries, malformedLines, malformedReasons } = parseEntries(text);
    return { records: entries, malformed: malformedLines.length, malformedReasons };
  },
});

export const appendApproval = ({ cwd = process.cwd(), env = process.env, entry } = {}) => {
  const record = readRecord(cwd, env);
  if (record.exitCode !== EXIT_ACCEPT) return record;
  const { recordPath, malformedLines } = record;
  const fields = { recordPath, malformedLines };
  const captured = (() => {
    try {
      return appendLane.captureRecordSnapshot(entry);
    } catch (error) {
      return { error };
    }
  })();
  if (captured.error) return refuse(EXIT_USAGE, captured.error.message, fields);
  const { line, snapshot } = captured;
  const twin = findTwin(record.entries, snapshot);
  if (twin) return { ...fields, exitCode: EXIT_ACCEPT, entry: twin, written: false };
  try {
    const result = appendLane.appendResolvedRecord({
      cwd, env, deps: {}, makeRecord: () => ({ line, snapshot }),
      preflight: ({ records }) => {
        if (findTwin(records, snapshot)) throw stop('approval already recorded for this plan');
      },
    });
    return { ...fields, recordPath: result.writtenPath, exitCode: EXIT_ACCEPT, entry: result.record, written: true };
  } catch (error) {
    const reread = readRecord(cwd, env);
    const twin = reread.exitCode === EXIT_ACCEPT ? findTwin(reread.entries, snapshot) : null;
    if (twin) return { recordPath: reread.recordPath, malformedLines: reread.malformedLines, exitCode: EXIT_ACCEPT, entry: twin, written: false };
    const reason = reread.exitCode === EXIT_ACCEPT ? error.message : `${error.message}; ${reread.reason}`;
    return refuse(EXIT_USAGE, reason, { ...fields, malformedLines: reread.malformedLines ?? malformedLines });
  }
};

export const getLocalDate = (date = new Date()) => [String(date.getFullYear()).padStart(YEAR_WIDTH, '0'),
  ...[date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(DAY_MONTH_WIDTH, '0'))].join('-');

const recordApproval = (cwd, env, plan, essenceFile) => {
  const judged = readJudgedPlan(cwd, plan);
  if (judged.exitCode !== EXIT_ACCEPT) return judged;
  const { verdict, planDigest } = judged;
  if (!lexicalRepoRelative(verdict.identity).ok) return refuse(EXIT_USAGE, `plan ${plan} is not repository-relative`);
  const read = readRegularFileNoFollow(resolve(cwd, essenceFile));
  if (read.outcome !== 'ok' || read.closeFailure) return refuse(EXIT_USAGE, `cannot read essence file ${essenceFile} (${describeReadFailure(read)})`);
  if (!read.content.trim()) return refuse(EXIT_USAGE, `essence file ${essenceFile} has no non-blank line`);
  const contracts = readContracts(cwd, verdict.identity, verdict);
  if (contracts.exitCode !== EXIT_ACCEPT) return contracts;
  const entry = composeEntry({ plan: verdict.identity, date: getLocalDate(), planDigest, ...contracts, essence: read.content });
  return appendApproval({ cwd, env, entry });
};

const isOperand = (value) => typeof value === 'string' && value.length > 0 && !value.startsWith('-');
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
