import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKER_CLAIM, classifyCheckerClaim } from '../checker-claim.mjs';
import { FINAL_CORE_CHECKS, KIT_CHECKER_CLAIMS, matchesCanonicalCheck } from '../gates-declaration.mjs';
import { runGates, spawnGateViaBash } from '../run-gates.mjs';
import { matchesSourceSizeGate } from '../source-size-core.mjs';
import { KIT_COMMANDS } from '../../../agent-workflow-memory/references/scripts/run.mjs';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MEMORY_SCRIPTS = 'agent-workflow-memory/references/scripts/';
const DEPLOYED_SCRIPTS = 'scripts/agent-workflow';
const SUCCESS_CODE = 0;
const RUNNER_PREFIX_LENGTH = 2;
const GATE_NAME = 'checker-verdict';
const SOURCE_SIZE_NAME = 'source-size';
const findKitCommand = (path) => Object.entries(KIT_COMMANDS).find(([, target]) => path === `${MEMORY_SCRIPTS}${target}`);
const quoteArgument = (argument) => `'${argument.replaceAll("'", "'\\''")}'`;

export const KIT_OVERRIDE = /^AW_/i;
const GIT_LOCATION = /^GIT_/i;

export const keyOf = (path, commandArguments, redCase) => JSON.stringify([path, commandArguments, redCase]);

export const gatherOffered = (root = REPOSITORY_ROOT) => ({
  offered: [
    ...KIT_CHECKER_CLAIMS.map((claim) => ({ name: claim.id, matches: (commandLine) => classifyCheckerClaim(claim.screen, commandLine, root) === CHECKER_CLAIM.CANONICAL })),
    ...FINAL_CORE_CHECKS.map((check) => ({ name: check.name, matches: (commandLine) => matchesCanonicalCheck(check, commandLine, root) })),
    { name: SOURCE_SIZE_NAME, matches: (commandLine) => matchesSourceSizeGate(commandLine, root) },
  ],
  commandTargets: Object.entries(KIT_COMMANDS).map(([name, target]) => ({ name, path: `${MEMORY_SCRIPTS}${target}` })),
});

export const commandLineOf = ({ root, project, path, commandArguments, ownPackage }) => {
  const command = findKitCommand(path);
  const absolutePath = resolve(ownPackage ? project : root, path).replace(/["\\$`]/g, '\\$&');
  const invocation = command ? `node ${DEPLOYED_SCRIPTS}/run.mjs ${command[0]}` : `node "${absolutePath}"`;
  return [invocation, ...commandArguments.map(quoteArgument)].join(' ');
};

export const entryOf = ({ root, project, path, ownPackage }) => {
  const command = findKitCommand(path);
  return command ? resolve(project, DEPLOYED_SCRIPTS, command[1]) : resolve(ownPackage ? project : root, path);
};

export const runCase = ({ project, commandLine, environment }) => {
  const printed = [];
  for (const name of Object.keys(process.env).filter((key) => GIT_LOCATION.test(key) || KIT_OVERRIDE.test(key))) delete process.env[name];
  const [result] = runGates([{ id: GATE_NAME, title: GATE_NAME, cmd: commandLine }], {
    cwd: project,
    spawn: (command, cwd) => spawnGateViaBash(command, cwd, environment),
    log: (text) => printed.push(text),
  });
  return { code: result.code, block: printed.slice(RUNNER_PREFIX_LENGTH).join('\n') };
};

export const runCensus = async ({ record, fixtures, root = REPOSITORY_ROOT }) => {
  const { judgeBlock, judgeVerdictLine, judgePlace, judgeRemedyLine } = await import('./form.mjs');
  const { FAULT_POINTS } = await import('./record.mjs');
  const { faultEnvironment, readFaultMarks, faultPhrase } = await import('./fault-harness.test.mjs');
  const problems = [];
  const indexKeyOf = (entry) => keyOf(entry.path, entry.commandArguments ?? entry.arguments, entry.redCase ?? entry.faultPoint);
  const fixturesByKey = new Map(fixtures.map((fixture) => [indexKeyOf(fixture), fixture]));
  const redExceptions = new Map(record.redExceptions.map((entry) => [indexKeyOf(entry), entry.missKinds]));
  const faultExceptions = new Set(record.faultExceptions.map(indexKeyOf));
  const observedRedMisses = new Map();
  const observedFaultMisses = new Set();
  const readHead = (lines, name) => {
    const head = [lines[0]];
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(': ');
      const finding = separator > 0 && !line.startsWith(' ') && !judgeRemedyLine(line, name) && judgePlace(line.slice(0, separator));
      const continuation = /^ {2}/.test(line) && head.length > 1;
      if (!finding && !continuation) break;
      head.push(line);
    }
    return head;
  };
  const runFixture = async (fixture, point) => {
    const directory = mkdtempSync(join(tmpdir(), 'checker-verdict-'));
    try {
      const project = join(directory, 'project');
      mkdirSync(project);
      const environment = await fixture.build(project) ?? {};
      const { path, commandArguments, ownPackage } = fixture;
      const entry = entryOf({ root, project, path, ownPackage });
      const marks = join(directory, 'marks');
      const fault = point === undefined ? {} : faultEnvironment({ point, entry, marks });
      const commandLine = commandLineOf({ root, project, path, commandArguments, ownPackage });
      const result = runCase({ project, commandLine, environment: { ...environment, ...fault } });
      return { ...result, counted: point !== undefined && readFaultMarks(marks).includes(entry) };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  for (const file of record.files) {
    for (const command of file.commandLines ?? []) {
      const path = file.path;
      const commandArguments = command.arguments;
      const identity = { path, commandArguments };
      for (const redCase of command.redCases) {
        const key = keyOf(path, commandArguments, redCase.name);
        const fixture = fixturesByKey.get(key);
        const caseIdentity = { ...identity, redCase: redCase.name };
        if (!fixture) {
          problems.push({ problem: 'no-fixture', ...caseIdentity });
          continue;
        }
        const result = await runFixture(fixture);
        if (result.code === SUCCESS_CODE) problems.push({ problem: 'exit-0', ...caseIdentity });
        const missKinds = result.code === SUCCESS_CODE ? [] : judgeBlock(result.block, { name: command.name, places: redCase.places });
        observedRedMisses.set(key, missKinds);
        const expected = redExceptions.get(key) ?? [];
        if (missKinds.some((kind) => !expected.includes(kind))) {
          problems.push({ problem: 'unlisted-miss', ...caseIdentity, missKinds });
        }
      }
      const firstFixture = fixturesByKey.get(keyOf(path, commandArguments, command.redCases[0].name));
      const countedPoints = [];
      for (const point of FAULT_POINTS) {
        if (!firstFixture) continue;
        const result = await runFixture(firstFixture, point);
        if (!result.counted) continue;
        countedPoints.push(point);
        const lines = result.block.split('\n');
        const followsForm = result.code !== SUCCESS_CODE && judgeVerdictLine(lines[0], command.name)
          && readHead(lines, command.name).some((line) => line.includes(faultPhrase(point)));
        if (followsForm) continue;
        const key = keyOf(path, commandArguments, point);
        observedFaultMisses.add(key);
        if (!faultExceptions.has(key)) {
          problems.push({ problem: 'unlisted-fault-miss', ...identity, faultPoint: point });
        }
      }
      if (countedPoints.length === 0) problems.push({ problem: 'no-fault-fired', ...identity });
    }
  }
  for (const exception of record.redExceptions) {
    const key = indexKeyOf(exception);
    const missKinds = observedRedMisses.get(key);
    if (missKinds && (missKinds.length !== exception.missKinds.length || missKinds.some((kind) => !exception.missKinds.includes(kind)))) {
      problems.push({ problem: 'stale-miss', path: exception.path, commandArguments: exception.arguments, redCase: exception.redCase, missKinds });
    }
  }
  for (const exception of record.faultExceptions) {
    if (!observedFaultMisses.has(indexKeyOf(exception))) {
      problems.push({ problem: 'stale-fault-miss', path: exception.path, commandArguments: exception.arguments, faultPoint: exception.faultPoint });
    }
  }
  return problems;
};
