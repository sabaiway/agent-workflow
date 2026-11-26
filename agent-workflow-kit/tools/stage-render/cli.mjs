#!/usr/bin/env node

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeContainedFileAtomic } from '../atomic-write.mjs';
import { isDirectRun } from '../direct-run.mjs';
import { PROCEDURES_FRAGMENT_REL, readEngineFragment, resolveEngineDir } from '../engine-source.mjs';
import { readRegularFileNoFollow } from '../fs-read-nofollow.mjs';
import { resolveGitLocation, stripGitLocationEnv } from '../git-env.mjs';
import { OUTCOME_LINES as APPROVAL_LINES, getLocalDate, readApproval } from '../plan-approval/index.mjs';
import { escapeForDisplay, isRenderableLine, isSeedablePathToken, shellQuoteArg } from '../repo-lex.mjs';
import {
  RECORD_GATED_STAGES, STAGES_REL, STAGE_RECORD_BASENAME, composeDispatchPart, composeRenderCommand, composeRenderLine,
  composeSlotText, composeStageRecord, composeStartPrompt, loadStages, renderStage, validateSlots,
} from './index.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const CLI_TOKEN = isSeedablePathToken(CLI_PATH) ? CLI_PATH : shellQuoteArg(CLI_PATH);
const STAGES_PATH = resolve(dirname(CLI_PATH), '../..', STAGES_REL);
const WRITE = '--write';
const DISPATCH = '--dispatch';
const STAGE_FLAG = '--stage';
const DECISIONS_FLAG = '--decisions';
const DECISION_SEPARATOR = '#';
const VALUE_FLAGS = Object.freeze(['plan', 'queue-row']);
const WAITING_STAGE = 'waiting-on-approval';
const UPGRADE = 'upgrade the kit and its engine (/agent-workflow-kit upgrade)';
const START_HEADER = 'the start prompt, shown to the user unchanged:';
const WRITES_AUTHORING = 'authoring';
const WRITES_ANY = 'any';
const LOCATED = 'work-tree';
const NO_REPOSITORY = 'not-a-repository';
const EXIT_OK = 0;
const EXIT_REFUSE = 1;
const EXIT_USAGE = 2;
const LINE_ENDING = '\n';
const display = escapeForDisplay;

export const OUTCOME_LINES = Object.freeze({
  usage: (reason) => `Usage: node ${display(CLI_TOKEN)} <slot file> | ${WRITE} <slot file> ${STAGE_FLAG} <id> [--plan <path>] [--queue-row <id>] [${DECISIONS_FLAG} <path>#<heading>]... | ${DISPATCH} <plan> — ${display(reason)}`,
  cannotRender: (subject, reason) => `stage-render: CANNOT RENDER — ${display(subject)}: ${display(reason)}; ${UPGRADE}`,
  refused: (subject, reason) => `stage-render: REFUSE — ${display(subject)}: ${display(reason)}`,
  unapproved: (stage, plan, reason) => `stage-render: REFUSE — ${display(stage)} for ${display(plan)} waits for its approval record, so the stage is ${WAITING_STAGE}; ${APPROVAL_LINES.refused(plan, reason)}`,
  finding: (plan, finding) => APPROVAL_LINES.finding(plan, finding),
  malformed: (recordPath, line) => APPROVAL_LINES.malformed(recordPath, line),
  unlocated: (reason) => `stage-render: ERROR — cannot locate the git directory of ${STAGE_RECORD_BASENAME}: ${display(reason)}`,
  recordFailed: (recordPath, reason) => `stage-render: ERROR — cannot record the stage at ${display(recordPath)}: ${display(reason)}`,
  writeFailed: (slotFile, reason) => `stage-render: ERROR — cannot write ${display(slotFile)}: ${display(reason)}`,
  written: (slotFile) => `stage-render: WRITTEN — ${display(slotFile)}; its render line and the command that runs it here:`,
  startHeader: () => START_HEADER,
  text: (line) => display(line),
});

const halt = (exitCode, lines) => Object.assign(new Error(lines[0]), { exitCode, lines });
const isOperand = (value) => typeof value === 'string' && value !== '' && !value.startsWith('-');

const parseWriteFlags = (pairs) => pairs.reduce((flags, value, index) => {
  if (flags === null || index % 2 === 1) return flags;
  const flag = value;
  const operand = pairs[index + 1];
  const kind = flag.startsWith('--') ? flag.slice(2) : null;
  if (flag === DECISIONS_FLAG && operand.includes(DECISION_SEPARATOR)) {
    const cut = operand.indexOf(DECISION_SEPARATOR);
    return { ...flags, decisions: [...flags.decisions, { path: operand.slice(0, cut), heading: operand.slice(cut + 1) }] };
  }
  if (flag === STAGE_FLAG && flags.stage === undefined && isOperand(operand)) return { ...flags, stage: operand };
  if (VALUE_FLAGS.includes(kind) && !Object.hasOwn(flags.values, kind) && operand !== '') {
    return { ...flags, values: { ...flags.values, [kind]: operand } };
  }
  return null;
}, { values: {}, decisions: [] });

const parseArgs = (argv) => {
  const broken = argv.find((value) => !isRenderableLine(value));
  if (broken !== undefined) return { usage: `${broken} carries a control byte` };
  const [first, second, ...rest] = argv;
  if (first === DISPATCH) return argv.length === 2 && isOperand(second) ? { command: DISPATCH, plan: second } : { usage: `${DISPATCH} takes one plan` };
  if (first === WRITE) {
    const flags = isOperand(second) && rest.length % 2 === 0 ? parseWriteFlags(rest) : null;
    return flags?.stage === undefined ? { usage: `${WRITE} takes one slot file, ${STAGE_FLAG} once and known flags` } : { command: WRITE, slotFile: second, ...flags };
  }
  return argv.length === 1 && isOperand(first) ? { command: 'render', slotFile: first } : { usage: 'one slot file, --write or --dispatch' };
};

const locateGitDir = ({ cwd, env }) => {
  const location = resolveGitLocation(cwd, { env: stripGitLocationEnv(env) });
  if (location.state === NO_REPOSITORY) return null;
  if (location.state !== LOCATED) throw halt(EXIT_USAGE, [OUTCOME_LINES.unlocated(location.cause)]);
  return location;
};

const isMainTree = (location) => location === null || location.gitDir === location.commonDir;

const recordStage = (location, slotFile, stage, writes) => {
  if (location === null) return;
  const recordPath = join(location.gitDir, STAGE_RECORD_BASENAME);
  try {
    writeContainedFileAtomic(location.gitDir, recordPath, composeStageRecord({ stage, slotFile, writes }), {}, { label: recordPath });
  } catch (error) {
    throw halt(EXIT_USAGE, [OUTCOME_LINES.recordFailed(recordPath, error.message)]);
  }
};

const loadTable = ({ stagesPath }) => {
  const read = readRegularFileNoFollow(stagesPath);
  if (read.outcome !== 'ok' || read.closeFailure) {
    throw halt(EXIT_USAGE, [OUTCOME_LINES.cannotRender(STAGES_REL, `cannot read ${stagesPath} (${read.closeFailure ?? read.code ?? read.outcome})`)]);
  }
  try {
    return loadStages(read.content);
  } catch (error) {
    throw halt(EXIT_USAGE, [OUTCOME_LINES.cannotRender(STAGES_REL, error.message)]);
  }
};

const requireApproval = ({ cwd, env, stderr }, plan, stage) => {
  const approval = readApproval({ cwd, env, plan });
  const malformed = (approval.malformedLines ?? []).map((line) => OUTCOME_LINES.malformed(approval.recordPath, line));
  if (approval.exitCode === EXIT_OK) {
    malformed.forEach(stderr);
    return approval;
  }
  const findings = (approval.verdict?.result.findings ?? []).map((finding) => OUTCOME_LINES.finding(plan, finding));
  throw halt(EXIT_REFUSE, [OUTCOME_LINES.unapproved(stage, plan, approval.reason), ...malformed, ...findings]);
};

const readCanon = (env) => {
  try {
    const { dir, source } = resolveEngineDir({ env, home: homedir() });
    return readEngineFragment(dir, { source, rel: PROCEDURES_FRAGMENT_REL });
  } catch (error) {
    throw halt(EXIT_USAGE, [OUTCOME_LINES.cannotRender(PROCEDURES_FRAGMENT_REL, error.message)]);
  }
};

const validate = (io, slotFile, table, text) => {
  try {
    return validateSlots({ root: io.cwd, slotFile, table, text });
  } catch (error) {
    throw halt(EXIT_REFUSE, [OUTCOME_LINES.refused(slotFile, error.message)]);
  }
};

const runRender = (io, { slotFile }) => {
  const location = locateGitDir(io);
  recordStage(location, slotFile, null, WRITES_AUTHORING);
  const table = loadTable(io);
  const slots = validate(io, slotFile, table);
  const gated = RECORD_GATED_STAGES.includes(slots.stage);
  const match = gated ? requireApproval(io, slots.plan, slots.stage) : null;
  const canon = readCanon(io.env);
  const rendering = (() => {
    try {
      return renderStage({ root: io.cwd, slotFile, slots, table, canon, match });
    } catch (error) {
      throw error.stage === WAITING_STAGE
        ? halt(EXIT_REFUSE, [OUTCOME_LINES.unapproved(slots.stage, slots.plan, error.message)])
        : halt(EXIT_USAGE, [OUTCOME_LINES.cannotRender(PROCEDURES_FRAGMENT_REL, error.message)]);
    }
  })();
  recordStage(location, slotFile, slots.stage, gated ? WRITES_ANY : WRITES_AUTHORING);
  io.stdout(rendering);
};

const runDispatch = (io, { plan }) => {
  const approval = requireApproval(io, plan, DISPATCH);
  composeDispatchPart({ plan: approval.verdict.identity, match: approval }).split(LINE_ENDING).forEach((line) => io.out(OUTCOME_LINES.text(line)));
};

const refusing = (subject, compose) => {
  try {
    return compose();
  } catch (error) {
    throw halt(EXIT_REFUSE, [OUTCOME_LINES.refused(subject, error.message)]);
  }
};

const composeText = (table, { stage, values, decisions }) => refusing(STAGE_FLAG,
  () => composeSlotText({ stage, values: { ...values, decisions }, date: getLocalDate(), table }));

const composeWrittenLines = (slotFile, slots, table, location) => refusing(slotFile, () => {
  const prompt = isMainTree(location)
    ? [OUTCOME_LINES.startHeader(), ...composeStartPrompt({ slotFile, slots, table }).split(LINE_ENDING).map(OUTCOME_LINES.text)]
    : [];
  return [OUTCOME_LINES.written(slotFile), OUTCOME_LINES.text(composeRenderLine(slotFile)), OUTCOME_LINES.text(composeRenderCommand(slotFile)), ...prompt];
});

const runWrite = (io, flags) => {
  const { slotFile, stage } = flags;
  const table = loadTable(io);
  const text = composeText(table, flags);
  const slots = validate(io, slotFile, table, text);
  const gated = RECORD_GATED_STAGES.includes(stage);
  if (gated) requireApproval(io, slots.plan, stage);
  const location = locateGitDir(io);
  const lines = composeWrittenLines(slotFile, slots, table, location);
  if (!gated) recordStage(location, slotFile, stage, WRITES_AUTHORING);
  try {
    writeContainedFileAtomic(io.cwd, join(io.cwd, slotFile), text, {}, { label: slotFile });
  } catch (error) {
    throw halt(EXIT_USAGE, [OUTCOME_LINES.writeFailed(slotFile, error.message)]);
  }
  lines.forEach(io.out);
};

const COMMANDS = Object.freeze({ render: runRender, [WRITE]: runWrite, [DISPATCH]: runDispatch });

export const main = (argv = process.argv.slice(2), io = {}) => {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const context = {
    cwd: io.cwd ?? process.cwd(), env: io.env ?? process.env, stagesPath: io.stagesPath ?? STAGES_PATH, stdout,
    out: (line) => stdout(`${line}${LINE_ENDING}`), stderr: (line) => stderr(`${line}${LINE_ENDING}`),
  };
  const args = parseArgs(argv);
  if (args.usage !== undefined) {
    context.stderr(OUTCOME_LINES.usage(args.usage));
    return EXIT_USAGE;
  }
  try {
    COMMANDS[args.command](context, args);
    return EXIT_OK;
  } catch (error) {
    if (error.exitCode === undefined) throw error;
    error.lines.forEach(context.stderr);
    return error.exitCode;
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = main();
