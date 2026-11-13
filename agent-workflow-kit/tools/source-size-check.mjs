#!/usr/bin/env node
// source-size-check.mjs — the size check's command line: it parses the arguments, runs the one mode
// they name from source-size-runs.mjs (what each mode does is told there) and composes what that run
// returned.
//
// Exit codes: 0 green / 1 violation or refusal / 2 usage, config or enumeration error, or an unexpected error.
// Dependency-free, Node >= 22. No side effects on import.

import { resolve } from 'node:path';
import { composeRedBlock, composeUsageRefusal, guardChecker } from '../references/scripts/shared/index.mjs';
import { isDirectRun, sameFile } from './direct-run.mjs';
import { KIT_LIMITS, commandReasonDefect, escapeForLine, reasonDefect } from './source-size-core.mjs';
import { HELP, escapeLeadingSpace, notJudgedLines, statedLimitLines } from './source-size-report.mjs';
import { CHECKER_NAME, ERROR_PREFIX, USAGE_REFUSAL, runAdopt, runCheck, runOverride, runWriteBaseline, usageFail } from './source-size-runs.mjs';

const HELP_LINES = HELP.split('\n');
const USAGE = HELP_LINES.slice(HELP_LINES.indexOf('Usage:')).slice(0, 6).join('\n');

const MODES = Object.freeze(['--check', '--write-baseline', '--adopt', '--override']);
const RUNS = Object.freeze({ '--check': runCheck, '--write-baseline': runWriteBaseline, '--adopt': runAdopt, '--override': runOverride });
// The modes whose run states the limits it judged; --adopt composes them and says what it did.
const STATES_LIMITS = Object.freeze(['--check', '--write-baseline', '--override']);
const KIT_DEFAULT = '--kit-default';
const LAYOUT = '--layout';

const takeOption = (argv, flag) => {
  const at = argv.indexOf(flag);
  if (at === -1) return { rest: argv, value: undefined };
  if (argv[at + 1] === undefined) throw usageFail(`${flag} needs a value`);
  return { rest: [...argv.slice(0, at), ...argv.slice(at + 2)], value: argv[at + 1] };
};

// A number on the command line is plain decimal digits, read inside its grammar or refused.
const numberOf = (flag, raw, min, max, what) => {
  if (raw === undefined) return undefined;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw usageFail(`${flag} must be ${what}, got ${JSON.stringify(raw)}`);
  return n;
};

// Everything the argument list alone decides about --override: the id, the options' grammar and
// their combination. The state refusals and the equality stop come later, in the run.
const overrideOptions = ({ id, value, tolerance, kitDefault }) => {
  if (!Object.hasOwn(KIT_LIMITS, id)) throw usageFail(`--override ${JSON.stringify(id)} names no kit limit — the kit's limits are ${Object.keys(KIT_LIMITS).join(', ')}`);
  if (kitDefault && (value !== undefined || tolerance !== undefined)) throw usageFail(`${KIT_DEFAULT} returns to the kit's numbers, so it takes no --value or --tolerance`);
  if (!kitDefault && value === undefined && tolerance === undefined) throw usageFail(`--override ${id} needs --value, --tolerance or ${KIT_DEFAULT}`);
  if (value !== undefined && KIT_LIMITS[id].value === null) throw usageFail(`--override ${id} takes --tolerance only — its count is the one a project records`);
  return {
    id,
    kitDefault,
    value: numberOf('--value', value, 1, Number.MAX_SAFE_INTEGER, 'a positive integer'),
    tolerance: numberOf('--tolerance', tolerance, 0, 100, 'an integer percent from 0 to 100'),
  };
};

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const cwdOption = takeOption(argv, '--cwd');
    const reasonOption = takeOption(cwdOption.rest, '--reason');
    const valueOption = takeOption(reasonOption.rest, '--value');
    const toleranceOption = takeOption(valueOption.rest, '--tolerance');
    const kitDefault = toleranceOption.rest.includes(KIT_DEFAULT);
    const layout = toleranceOption.rest.includes(LAYOUT);
    const rest = toleranceOption.rest.filter((arg) => arg !== KIT_DEFAULT && arg !== LAYOUT);
    // Resolved BEFORE the run and before anything is rendered: every path this run names is then
    // meaningful from any directory, not only from the one that invoked it.
    const cwd = resolve(ctx.cwd ?? process.cwd(), cwdOption.value ?? '.');
    // Counted over the ARGUMENTS, not over the mode list: filtering the list collapses repeats, so
    // `--adopt --adopt` read as exactly one mode and a WRITE ran under an argument list this very
    // guard had just called invalid.
    const modes = rest.filter((arg) => MODES.includes(arg));
    if (modes.length === 0) throw usageFail(`nothing to do — pass one of ${MODES.join(', ')} (see --help)`);
    if (modes.length > 1) throw usageFail(`pass exactly ONE mode, got: ${modes.join(', ')}`);
    const [mode] = modes;
    const idOption = mode === '--override' ? takeOption(rest, '--override') : { rest, value: undefined };
    const unknown = idOption.rest.filter((arg) => !MODES.includes(arg));
    if (unknown.length > 0) throw usageFail(`unknown argument: ${unknown[0]}`);
    if (mode !== '--override') {
      const stray = [['--value', valueOption.value], ['--tolerance', toleranceOption.value], [KIT_DEFAULT, kitDefault || undefined]]
        .find(([, given]) => given !== undefined);
      if (stray) throw usageFail(`${stray[0]} belongs to --override`);
    }
    if (layout && mode !== '--write-baseline') throw usageFail(`${LAYOUT} belongs to --write-baseline — it starts the layout record`);
    if (reasonOption.value !== undefined) {
      if (mode === '--check') throw usageFail('--reason belongs to --write-baseline, --adopt and --override — a check records nothing');
      const defect = reasonDefect(reasonOption.value) ?? commandReasonDefect(reasonOption.value, { override: mode === '--override' });
      if (defect) throw usageFail(defect);
    } else if (mode === '--override') {
      throw usageFail('--override needs --reason "<text>" — an override is a reasoned change of a kit number');
    }
    const override = mode === '--override'
      ? overrideOptions({ id: idOption.value, value: valueOption.value, tolerance: toleranceOption.value, kitDefault })
      : {};
    const deps = ctx.deps ?? {};
    const { code, lines, block, config, judged, scope } = RUNS[mode]({ cwd, reason: reasonOption.value, layout, deps, ...override });
    const states = STATES_LIMITS.includes(mode) && config;
    const limits = states ? statedLimitLines(config) : [];
    const notJudged = states && judged ? notJudgedLines(cwd, { ...judged, config, excluded: scope?.excluded }) : [];
    const output = block ? composeRedBlock({ name: CHECKER_NAME, ...block, after: [...limits, ...notJudged, ...block.after] }) : [...limits, ...notJudged, ...lines];
    return { code, stdout: output.join('\n'), stderr: '' };
  } catch (err) {
    if (err?.exitCode === undefined) throw err;
    const message = err.message.startsWith(ERROR_PREFIX) ? err.message.slice(ERROR_PREFIX.length) : err.message;
    const failed = escapeLeadingSpace(err[USAGE_REFUSAL] ? escapeForLine(message) : message);
    const output = err[USAGE_REFUSAL] ? composeUsageRefusal({ name: CHECKER_NAME, failed, usage: USAGE })
      : composeRedBlock({ name: CHECKER_NAME, failed, remedies: [err.exitCode === 2 ? 'fix the size config or the git index error the verdict line names, then re-run' : 'fix the tree condition the verdict line names, then re-run'], after: err.lines ?? [] });
    return { code: err.exitCode, stdout: output.join('\n'), stderr: '' };
  }
};

export const guardedMain = (argv, ctx = {}) => {
  const carried = [];
  const result = guardChecker({ name: CHECKER_NAME, exitCode: 2, remedy: 'fix the cause the stack below names, then re-run' }, () => {
    try { return main(argv, ctx); }
    catch (err) { carried.push(...(err?.lines ?? [])); throw err; }
  });
  return result.lines ? { code: result.exitCode, stdout: [...result.lines, ...carried].join('\n'), stderr: '' } : result;
};

// The realpath-compare direct-run predicate now lives in tools/direct-run.mjs (the fix this file
// carried first, extracted so every module shares one implementation); `sameFile` stays exported here
// because this module's tests bind it as a seam.
export { sameFile };
if (isDirectRun(import.meta.url)) {
  const result = guardedMain(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  process.exitCode = result.code;
}
