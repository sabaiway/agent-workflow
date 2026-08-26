#!/usr/bin/env node
// The CLI half of the queue auditor: argv and fs, no rule (the rule is queue-audit.mjs).
//
// Split for the same reason fold-scope is split — a module you can hold whole is the unit of review,
// and the rules file had reached the source-size cap. Read-only: it reads the file it is pointed at
// and writes nothing. Dependency-free, Node >= 22.
//
// Exit codes: 0 accept; 1 refuse (a terminal/record row still listed, or a cap breach); 2 usage —
// a missing/unknown flag, a flag with no value, an unreadable path, or a section that is not there.

import { readFileSync } from 'node:fs';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { CLASSES, DEFAULTS, auditQueue, checkQueue, formatReport } from './queue-audit.mjs';

const HELP = `queue-audit — classify the backlog queue's rows (agent-workflow family).

Usage:
  node queue-audit-cli.mjs --report <queue-file> [--section "## Pending / backlog (newest)"]
  node queue-audit-cli.mjs --check  <queue-file> [--section "…"] [--max-rows N] [--max-row-lines N]

--report  one tab-separated line per row: file line, class, row length, title, the literal evidence.
          Deterministic — this is the manifest a deletion is driven by, never a regex guess.
--check   refuses when a terminal or record row is still listed, when a row over the per-row line cap
          carries work (live, parked and ambiguous alike), or when more rows than the row cap carry
          work. Ambiguous rows are reported and never refuse on their own: a row that contradicts
          itself, or names a status word outside a status position, is settled by a human.

Classes: ${CLASSES.join(' · ')}. Defaults: --max-rows ${DEFAULTS.maxRows}, --max-row-lines ${DEFAULTS.maxRowLines}.

Exit codes: 0 accept; 1 refuse; 2 usage (missing/unknown flag, unreadable path, bad section).`;

// A flag whose value is MISSING refuses. `--section` with nothing after it used to fall through to
// `null`, which means "audit the whole document" — silently widening the domain of a report a
// deletion is driven by, in exactly the direction that costs live rows.
const valueOf = (argv, index, flag) => {
  const value = argv[index + 1];
  if (value === undefined || value === '' || value.startsWith('--')) throw fail(2, `${flag} takes a value`);
  return value;
};

const parseArgv = (argv) => {
  // `--help` is answered ONLY when it is the whole invocation. A help flag that wins from anywhere
  // makes `--check <dirty-file> --help` exit 0 — the gate's refusal replaced by a help page, which
  // is the same bypass a second mode flag would be, reached by a flag nobody reads as dangerous.
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { mode: 'help' };
  const options = { mode: null, path: null, section: null };
  // Every option here is a SINGLETON. A repeat used to win silently: a second `--section` moved the
  // domain the report covers and a softer `--max-rows` moved the ratchet, both without a word — and
  // both in the direction that lets a queue keep rows a check would have refused.
  const seen = new Set();
  const once = (flag) => {
    if (seen.has(flag)) throw fail(2, `${flag} was given twice — each option is named exactly once`);
    seen.add(flag);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') throw fail(2, '--help is answered only when it is the whole invocation — it never rides another mode');
    else if (arg === '--report' || arg === '--check') {
      // The mode is set ONCE. A later flag overwriting an earlier one would let `--check <f>
      // --report <f>` answer a refusal question with an exit-0 report — the gate's verdict replaced
      // by a listing, silently. Repetition is as wrong as conflict: both mean the caller asked two
      // questions and only one was answered.
      if (options.mode) throw fail(2, `--${options.mode} was already given — name exactly one of --report or --check`);
      options.mode = arg.slice(2);
      options.path = valueOf(argv, index, arg);
      index += 1;
    } else if (arg === '--section') {
      once(arg);
      options.section = valueOf(argv, index, arg);
      index += 1;
    } else if (arg === '--max-rows' || arg === '--max-row-lines') {
      once(arg);
      const value = Number(valueOf(argv, index, arg));
      if (!Number.isInteger(value) || value <= 0) throw fail(2, `${arg} takes a positive integer, got "${argv[index + 1]}"`);
      options[arg === '--max-rows' ? 'maxRows' : 'maxRowLines'] = value;
      index += 1;
    } else throw fail(2, `unknown argument "${arg}" — run with --help`);
  }
  if (!options.mode) throw fail(2, 'one of --report or --check is required — run with --help');
  if (!options.path) throw fail(2, `${`--${options.mode}`} takes a queue file path`);
  // A cap named beside `--report` used to be accepted and then ignored, and the run still exited 0 —
  // so an operator who meant to ask a question about the caps was told nothing and read the silence
  // as an answer. The caps belong to `--check`; naming one here is a usage error, not a no-op.
  const capsInReport = ['--max-rows', '--max-row-lines'].filter((flag) => seen.has(flag));
  if (options.mode === 'report' && capsInReport.length) {
    throw fail(2, `${capsInReport.join(' and ')} ${capsInReport.length > 1 ? 'are' : 'is'} a --check option — --report lists every row and judges no cap`);
  }
  return options;
};

export const main = (argv, { log = console.log, error = console.error } = {}) => {
  let options;
  try {
    options = parseArgv(argv);
  } catch (err) {
    error(err.message);
    return err.exitCode ?? 2;
  }
  if (options.mode === 'help') {
    log(HELP);
    return 0;
  }

  let text;
  try {
    text = readFileSync(options.path, 'utf8');
  } catch (err) {
    error(`cannot read ${options.path}: ${err.message}`);
    return 2;
  }

  try {
    if (options.mode === 'report') {
      log(formatReport(auditQueue(text, { section: options.section, label: options.path }), { label: options.path }));
      return 0;
    }
    const result = checkQueue(text, { ...options, label: options.path });
    for (const note of result.notes) log(note);
    for (const problem of result.problems) error(problem);
    log(
      `${options.path}: ${result.total} rows — ` +
        CLASSES.map((klass) => `${result.counts[klass]} ${klass}`).join(' · '),
    );
    return result.ok ? 0 : 1;
  } catch (err) {
    error(err.message);
    return err.exitCode ?? 1;
  }
};

// `process.exitCode`, never `process.exit()`: stdout is a PIPE under a gate runner, and an immediate
// exit drops whatever of a large `--report` has not been flushed yet. A truncated manifest is worse
// than none — it is the document a deletion is driven by, and a short one reads as a complete one.
if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
