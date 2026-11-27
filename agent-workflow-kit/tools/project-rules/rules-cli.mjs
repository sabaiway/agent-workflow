#!/usr/bin/env node
// The command line over the read-only check and the record writer. Contract:
// docs/ai/specs/kit/project-rules/rules-cli.md. Exit codes: 0 accept; 1 a stop or a refused record; 2 usage.

import { resolve } from 'node:path';
import { isDirectRun } from '../direct-run.mjs';
import { checkRules, FATE_FORMS } from './rules-check.mjs';
import { writeRecord } from './rules-record.mjs';

const USAGE = `project-rules — the effective rule files still stand for their sources.

Usage:
  node rules-cli.mjs --check [--cwd <project>]
  node rules-cli.mjs --record --theme <name> --kit <sha256> --local <sha256|absent> --effective <sha256> [--fate <text>]... [--cwd <project>]

--check   one line per theme: current, absent, drift or record; writes nothing.
--record  the merging agent's call: records the digests of the inputs it read and of the file it wrote.
--fate    one fate per value, repeatable: ${FATE_FORMS}.

Exit codes: 0 accept; 1 a stop or a refused record; 2 usage.`;

const MODES = { '--check': [], '--record': ['--theme', '--kit', '--local', '--effective'] };
const FATE_OPTION = '--fate';
const VALUED = new Set(['--cwd', ...MODES['--record'], FATE_OPTION]);

// parseArgs(argv) → { mode, options } | { help: true } | { error }; reads nothing.
const parseArgs = (argv) => {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
  let mode = null;
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (Object.hasOwn(MODES, arg)) {
      if (mode !== null) return { error: `${mode} and ${arg} are two modes; one run takes exactly one` };
      mode = arg;
    } else if (VALUED.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === FATE_OPTION) {
        options[arg] = [...(options[arg] ?? []), value];
      } else {
        if (arg in options) return { error: `${arg} is given twice` };
        options[arg] = value;
      }
      i += 1;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  if (mode === null) return { error: 'no mode: give --check or --record' };
  const allowed = new Set(['--cwd', ...MODES[mode]]);
  if (mode === '--record') allowed.add(FATE_OPTION);
  const extra = Object.keys(options).find((name) => !allowed.has(name));
  if (extra) return { error: `${mode} does not take ${extra}` };
  const absent = MODES[mode].find((name) => !(name in options));
  if (absent) return { error: `${mode} needs ${absent}` };
  return { mode, options };
};

const lines = (list) => (list.length === 0 ? '' : `${list.join('\n')}\n`);

// main(argv, ctx?) → { code, stdout, stderr }; never exits the process.
export const main = (argv, ctx = {}) => {
  const parsed = parseArgs(argv);
  if (parsed.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
  if (parsed.error) return { code: 2, stdout: '', stderr: `project-rules: ${parsed.error}\n\n${USAGE}\n` };
  const root = resolve(ctx.cwd ?? process.cwd(), parsed.options['--cwd'] ?? '.');
  const deps = ctx.deps ?? {};
  if (parsed.mode === '--check') {
    const verdicts = checkRules(root, deps);
    const stops = verdicts.filter(({ verdict }) => verdict !== 'current' && verdict !== 'absent');
    return { code: stops.length === 0 ? 0 : 1, stdout: lines(verdicts.map(({ line }) => line)), stderr: '' };
  }
  const { '--theme': theme, '--kit': kit, '--local': local, '--effective': effective } = parsed.options;
  const result = writeRecord(root, theme, { kit, local, effective, fates: parsed.options[FATE_OPTION] ?? [] }, deps);
  if (!result.ok) {
    const prefix = `project-rules: --record refused (${result.condition})`;
    const stderr = result.condition === 'unproved-merge'
      ? `${prefix} — nothing written\n${result.message}\n`
      : `${prefix} — ${result.message}; nothing written\n`;
    return { code: 1, stdout: '', stderr };
  }
  return { code: 0, stdout: lines([`project-rules: recorded ${theme} in ${result.path}`, ...result.changes]), stderr: '' };
};

if (isDirectRun(import.meta.url)) {
  const { code, stdout, stderr } = main(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
