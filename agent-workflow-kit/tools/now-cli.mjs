#!/usr/bin/env node
// The CLI half of `now`: argv, the io seam and the pipeline. The rules live in now-status.mjs, the
// facts in now-facts.mjs, the phrases in now-render.mjs.

import { resolve } from 'node:path';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { FORMATS, detectSurface } from './surface.mjs';
import { gatherNowFacts } from './now-facts.mjs';
import { isWithheld } from './now-status.mjs';
import { renderNow, toNowViewModel } from './now-render.mjs';

const BLOCKS = Object.freeze(['now', 'steps', 'queue', 'campaign']);
const SCHEMA = 1;
const FORMAT_FLAG = '--format=';
const HELP = `now — read-only: where the work stands, in four blocks.

Usage:
  node now-cli.mjs [--dir <project>] [--format=<${FORMATS.join('|')}>] [--json]

--dir     the project to read (default: the current directory).
--format  the output surface; --json is strict sugar for --format=json, and naming both with
          different values is usage.
--help    answered only when it is the whole invocation.

Blocks: NOW (the plans in flight, the phase, the current and the next step, the tree), STEPS (the
ledger rows, one status each), QUEUE (the backlog folded under each row's heading path), CAMPAIGN
(the size practice). A block that cannot be derived is WITHHELD with its cause on one line.

A status is a function of the row's (path, verb) pair and the evidence at that path; the row's prose
is printed as a claim beside a status it never moves.

Exit codes: 0 anything rendered, a withheld block included; 1 nothing rendered at all (a --dir that
is not a git work tree); 2 usage.

Reads only: no store, no receipt, no cache, no lock.`;

const valueAt = (argv, index, flag) => {
  const value = argv[index + 1];
  if (value === undefined || value === '' || value.startsWith('-')) throw fail(2, `${flag} takes a value`);
  return value;
};

export const parseArgv = (argv) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    if (argv.length !== 1) throw fail(2, '--help is answered only when it is the whole invocation');
    return { help: true, dir: null, formats: [] };
  }
  const parsed = argv.reduce((state, arg, index) => {
    if (state.skip) return { ...state, skip: false };
    if (arg === '--dir') return { ...state, dir: valueAt(argv, index, arg), skip: true };
    if (arg === '--format') return { ...state, formats: [...state.formats, valueAt(argv, index, arg)], skip: true };
    if (arg.startsWith(FORMAT_FLAG)) return { ...state, formats: [...state.formats, arg.slice(FORMAT_FLAG.length)] };
    if (arg === '--json') return { ...state, formats: [...state.formats, 'json'], json: true };
    throw fail(2, `unknown argument "${arg}" — run with --help`);
  }, { help: false, dir: null, formats: [], json: false, skip: false });
  if (parsed.json && parsed.formats.some((format) => format !== 'json')) {
    throw fail(2, '--json is strict sugar for --format=json — naming both with different values is usage');
  }
  return parsed;
};

const resolveSurface = (formats, env, io) => detectSurface({
  argv: formats.map((format) => `${FORMAT_FLAG}${format}`),
  env,
  isTTY: io.isTTY ?? Boolean(process.stdout.isTTY),
  columns: io.columns ?? process.stdout.columns,
  platform: io.platform ?? process.platform,
});

const toEnvelope = (dir, vm) => ({ schema: SCHEMA, command: 'now', dir, ...vm });

export const main = (argv, io = {}) => {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const env = io.env ?? process.env;
  const start = (() => {
    try {
      const options = parseArgv(argv);
      return options.help ? { help: true } : { options, surface: resolveSurface(options.formats, env, io) };
    } catch (err) {
      error(err?.message ?? String(err));
      return { code: err?.exitCode ?? 2 };
    }
  })();
  if (start.code !== undefined) return start.code;
  if (start.help) {
    log(HELP);
    return 0;
  }
  const cwd = resolve(io.cwd ?? process.cwd(), start.options.dir ?? '.');
  // The composed readers spawn git under process.env alone, so the flag must reach them there too.
  process.env.GIT_OPTIONAL_LOCKS = '0';
  const vm = toNowViewModel(gatherNowFacts({ cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } }));
  const blocks = BLOCKS.map((name) => vm[name]);
  if (blocks.every(isWithheld)) {
    for (const cause of new Set(blocks.map(({ withheld }) => withheld))) error(cause);
    return 1;
  }
  log(start.surface.mode === 'json' ? JSON.stringify(toEnvelope(cwd, vm), null, 2) : renderNow(vm, start.surface));
  return 0;
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
