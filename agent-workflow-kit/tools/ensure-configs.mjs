#!/usr/bin/env node
// ensure-configs.mjs — ONE runnable command for the five stamp-independent upgrade ensures:
//
//   orchestration  docs/ai/orchestration.json  seed, or refresh a still-canonical onboarding note
//   gates          docs/ai/gates.json          seed-if-missing (an existing declaration is authored content)
//   autonomy       docs/ai/autonomy.json       seed-if-missing (same)
//   scripts        scripts/<ADR enforcement>   seed-if-missing, ADR-layout detect FIRST
//   index          docs/ai/index.md            regenerate-if-missing-or-stale (a GENERATED artifact)
//
// Each was prose in references/modes/upgrade.md that an agent performed by hand. One command instead
// of four is deliberate: four independent runs would be four chances to skip one, and the mode doc now
// has a single invocation point whose four outcome lines it relays.
//
// The contract (pinned by this module's tests):
//   • --reconcile is REQUIRED. A bare run is a usage error, so nothing writes by accident.
//   • --dry-run reports `would-*` tokens and writes nothing — never a write token.
//   • The ops run in a FIXED order and one op's failure NEVER skips the rest: every op reports its own
//     token, and the exit is non-zero when any of them failed.
//   • The deployment gate runs ONCE, before any op: an absent/symlinked docs/ai stops the whole run
//     with the gate's own message rather than four copies of it.
//
// Output is ENGLISH/structured (repo-artifact Hard Constraint); the agent localizes when narrating.
// Exit codes: 0 every op fine · 1 an op failed, or the deployment gate stopped the run · 2 usage.
// main(argv, ctx) → { code, stdout, stderr }; cwd + fs are injectable for host-independent tests.
//
// Dependency-free, Node >= 22. No side effects on import (the isDirectRun idiom).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDocsAiDeployment } from './atomic-write.mjs';
import { isDirectRun } from './direct-run.mjs';
import { ENSURE_IMPLEMENTATIONS, ENSURE_OPS, failedOutcome } from './ensure-ops.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const EMPTY_CWD = '--cwd needs a path argument (an empty value would silently mean the current directory)';
const EMPTY_ONLY = `--only needs one operation name (${ENSURE_OPS.join(' | ')}) — an empty value would silently widen the run`;
const REPEATED_ONLY = '--only was passed more than once — this selector names exactly ONE operation';
const unknownOp = (value) => `--only ${value}: no such operation (${ENSURE_OPS.join(' | ')}) — nothing was run`;

const HELP = `ensure-configs — the five stamp-independent upgrade ensures, as ONE command.

Usage:
  node ensure-configs.mjs --reconcile [--dry-run] [--only <op>] [--cwd <project>]

  --reconcile   required — run the five ensures (${ENSURE_OPS.join(', ')})
  --dry-run     report what each ensure WOULD do; write nothing
  --only <op>   run EXACTLY ONE of them (an unknown, missing or repeated value is a usage error)
  --cwd <dir>   the target project (default: the current directory)
  --help, -h    this help

Every SEED is CREATE-ONLY: an existing file is preserved byte-for-byte, never clobbered and never
refreshed in place. Two ops refresh instead: the orchestration onboarding note, only while it still
matches a canonical the kit shipped (your own wording is preserved verbatim), and the navigator
index — a GENERATED artifact, regenerated whenever it is missing or stale. The enforcement-script
ensure detects an older ADR-store layout FIRST and instructs the opt-in migration instead of seeding.

Exit codes: 0 every op fine; 1 an op failed (its line says so) or there is no deployment here; 2 usage.`;

// argv → { reconcile, dryRun, cwd, help }. Order-independent; an unknown flag or a missing --cwd
// value is a usage error, never a silently-ignored argument.
export const parseArgs = (argv) => {
  const out = { reconcile: false, dryRun: false, cwd: undefined, only: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      // A selector that cannot be honoured EXACTLY as asked is a usage error, never a wider run:
      // narrowing is the whole point, so a missing value, a repeat, or an op that does not exist
      // must stop the run before any op writes.
      if (out.only !== undefined) throw fail(EXIT_USAGE, REPEATED_ONLY);
      const inline = a.startsWith('--only=');
      const value = inline ? a.slice('--only='.length) : argv[i + 1];
      if (value === undefined || value === '' || (!inline && value.startsWith('-'))) throw fail(EXIT_USAGE, EMPTY_ONLY);
      if (!ENSURE_OPS.includes(value)) throw fail(EXIT_USAGE, unknownOp(value));
      out.only = value;
      if (!inline) i += 1;
    } else if (a === '--cwd') {
      // An EMPTY value resolves to the ambient cwd — a writing CLI would then act on a different
      // project than the caller named, silently. Both spellings refuse it.
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('-')) throw fail(EXIT_USAGE, EMPTY_CWD);
      out.cwd = next;
      i += 1;
    } else if (a.startsWith('--cwd=')) {
      const value = a.slice('--cwd='.length);
      if (value === '') throw fail(EXIT_USAGE, EMPTY_CWD);
      out.cwd = value;
    } else throw fail(EXIT_USAGE, `unknown argument: ${a}`);
  }
  if (!out.help && !out.reconcile) {
    throw fail(EXIT_USAGE, 'nothing to do — pass --reconcile (see --help). This tool never writes without it.');
  }
  return out;
};

// Run every op in ENSURE_OPS order. A throw from one op becomes THAT op's failed outcome — the
// remaining ops still run, because a project missing its gate declaration should not also be left
// without its autonomy seed just because the first ensure hit an unreadable file.
export const runEnsures = ({ cwd, kitRoot, dryRun, deps, only }) =>
  (only ? [only] : ENSURE_OPS).map((op) => {
    try {
      return ENSURE_IMPLEMENTATIONS[op]({ cwd, kitRoot, dryRun, deps });
    } catch (err) {
      return failedOutcome(op, err);
    }
  });

const render = (outcomes, dryRun, only) => {
  // The banner names the tool + the flag it ran under (both machine tokens the L2 rule exempts);
  // the failure footer is a user-grade sentence — the composed-lines guard scans both.
  const scope = only ? `, --only ${only}` : '';
  const lines = [dryRun ? `ensure-configs (--reconcile${scope}, dry run — nothing written)` : `ensure-configs (--reconcile${scope})`];
  for (const o of outcomes) {
    lines.push(`  ${o.op}: ${o.token}`);
    for (const detail of o.lines) lines.push(`      ${detail}`);
  }
  if (outcomes.some((o) => o.failed)) {
    // No blanket claim about what was written: an op that copies file by file can stop PARTWAY, and
    // its own lines are the only accurate account of what landed.
    lines.push('', '  part of this configuration run did NOT complete — the lines above name the cause, and what was and was not written.');
  }
  return lines.join('\n');
};

export const main = (argv = [], ctx = {}) => {
  try {
    const args = parseArgs(argv);
    if (args.help) return { code: EXIT_OK, stdout: HELP, stderr: '' };
    const cwd = resolve(args.cwd ?? ctx.cwd ?? process.cwd());
    const deps = ctx.deps ?? {};
    // ONE deployment gate for the whole run (see the header): with no docs/ai there is nothing to
    // reconcile, and four identical STOPs would read as four separate problems.
    assertDocsAiDeployment(cwd, deps, { noun: 'the project configuration', rel: 'under docs/ai' });
    const outcomes = runEnsures({ cwd, kitRoot: ctx.kitRoot ?? KIT_ROOT, dryRun: args.dryRun, deps, only: args.only });
    return {
      code: outcomes.some((o) => o.failed) ? EXIT_FAILED : EXIT_OK,
      stdout: render(outcomes, args.dryRun, args.only),
      stderr: '',
    };
  } catch (err) {
    return { code: err.exitCode ?? EXIT_FAILED, stdout: '', stderr: `ensure-configs: ${err.message}` };
  }
};

if (isDirectRun(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exitCode = r.code;
}
