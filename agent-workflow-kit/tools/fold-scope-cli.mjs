#!/usr/bin/env node
// The CLI half of the finding-scope checker: argv and fs, no rule (the rule is fold-scope.mjs).
//
// `--plan` and `--queue` are REQUIRED and never defaulted. A project has two registers that can both
// look like "the queue" - the planning lifecycle's docs/plans/queue.md and a declared
// flow.debtQueue - and a checker that guessed would attest a deferral against the wrong file. The
// procedures advisor renders this command already populated, and NAMES which register it chose.
//
// Read-only: reads the two files it is pointed at, writes nothing, records nothing (advisory).
// Dependency-free, Node >= 22.
//
// Exit codes: 0 ACCEPT; 1 a matrix REFUSE; 2 usage - a missing/unknown flag, an unreadable path, or
// a refusal about the arguments themselves (an unknown or absent --class, an absent --claim).

import { readFileSync } from 'node:fs';
import { isDirectRun } from './direct-run.mjs';
import { CLASSES, ROW_FIELDS, decideFoldScope } from './fold-scope.mjs';

const HELP = `fold-scope — declare a finding's SCOPE before the edit (agent-workflow family).

Usage:
  node fold-scope-cli.mjs --class <${CLASSES.join('|')}> --claim "<the invariant>" \\
                          --plan <plan-file> --queue <queue-file>

Every finding NAMES the invariant its fix enforces, BEFORE the edit. Where that invariant already
lives decides the arm, and this checker refuses a claim whose reference does not resolve:

  in-scope       the claim matches WITHIN ONE \`- \` bullet under the plan's ## Verification
                 (those bullets ARE the acceptance criteria) -> fold here.
  new-invariant  the claim matches NO acceptance bullet AND exactly one queue row carries all five
                 fields (${ROW_FIELDS.join(', ')}), its residual exposure
                 declared "not live" -> the narrow fix ships now, only the generalization defers.
  blocking       no correct narrow fix exists -> the phase does not close. There is no queue arm.

--plan and --queue are required and never defaulted: guessing the register would attest a deferral
against the wrong file. The check is advisory — nothing records that it ran, so a skipped or late
call is indistinguishable from a pre-edit declaration.

Exit codes: 0 ACCEPT; 1 REFUSE; 2 usage (missing/unknown flag, unreadable path, bad --class/--claim).`;

const FLAGS = ['class', 'claim', 'plan', 'queue'];

const parseArgs = (argv) => {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : null;
    if (!name || !FLAGS.includes(name)) throw new Error(`unexpected argument "${arg}" (flags: ${FLAGS.map((f) => `--${f}`).join(', ')})`);
    if (eq !== -1) {
      opts[name] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    opts[name] = value;
    i += 1;
  }
  for (const name of ['plan', 'queue']) {
    if (!opts[name]) throw new Error(`--${name} is required and is never defaulted — name the file this claim is checked against`);
  }
  return opts;
};

// main(argv, deps) -> { code, stdout, stderr }. Never calls process.exit itself (the direct-run
// guard does), and never reads anything the caller did not point it at.
export const main = (argv, deps = {}) => {
  const read = deps.readFileSync ?? readFileSync;
  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `fold-scope: ${err.message}` };
  }
  const text = {};
  for (const name of ['plan', 'queue']) {
    try {
      text[name] = read(opts[name], 'utf8');
    } catch (err) {
      return { code: 2, stdout: '', stderr: `fold-scope: --${name} "${opts[name]}" is unreadable — ${(err && err.message) || err}` };
    }
  }
  const decided = decideFoldScope({ cls: opts.class, claim: opts.claim, planText: text.plan, queueText: text.queue });
  return { code: decided.exit, stdout: decided.lines.join('\n'), stderr: '' };
};

if (isDirectRun(import.meta.url)) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
