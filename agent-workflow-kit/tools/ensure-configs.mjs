#!/usr/bin/env node
// ensure-configs.mjs — ONE runnable command for the stamp-independent upgrade ensures:
//
//   orchestration  docs/ai/orchestration.json  seed, or the onboarding note written current (a differing one's line names its route)
//   gates          docs/ai/gates.json          seed-if-missing (an existing declaration is authored content)
//   autonomy       docs/ai/autonomy.json       seed-if-missing (same)
//   vehicles       docs/ai/vehicles.json       seed-if-missing (same)
//   executor       .claude/agents/executor.md  judged against docs/ai/vehicles.json, never written: a differing body is pending
//   scripts        scripts/<every kit script>  once a kit script outside the seed names stands there, every file not current
//                  + the installer set         written with no question and no copy kept; installer set first; on a
//                                              declined offer only the standing seed files and the modules they import;
//                                              then the project's rotator brings the ADR store current (--ensure-current)
//   specs          scripts/<spec layer>        reader + checker pairs, with no question and no copy kept:
//                  + docs/ai/specs/index.md    a shipped prior refreshed, an edited one replaced, an absent
//                                              one placed; then the store root seeded create-only
//   rules          docs/ai/rules/<theme>.md    the kit file seeded, refreshed on a shipped prior body, or any
//                  + effective/ + sources.json other body replaced, with no question and no copy kept; with no
//                                              local file the effective copy and its record rebuilt; with one
//                                              the merge an agent does is named, never done
//   index          docs/ai/index.md            regenerate-if-missing-or-stale (a GENERATED artifact); under
//                                              a project hook module that is not the bundled one, a write
//                                              the project's own checker rejects is put back
//
// Each was prose in references/modes/upgrade.md that an agent performed by hand. One command instead
// of one per ensure is deliberate: independent runs would be as many chances to skip one, and the mode
// doc now has a single invocation point whose outcome lines it relays.
//
// The contract (pinned by this module's tests):
//   • --reconcile is REQUIRED. A bare run is a usage error, so nothing writes by accident.
//   • --dry-run reports `would-*` tokens and writes nothing — never a write token.
//   • The ops run in a FIXED order and one op's failure NEVER skips the rest: every op reports its own
//     token, and the exit is non-zero when any of them failed.
//   • The deployment gate runs ONCE, before any op: an absent/symlinked docs/ai stops the whole run
//     with the gate's own message rather than one copy of it per op.
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
import { ensureExecutor } from './ensure-executor.mjs';
import { ENSURE_OPS, OWN_IMPLEMENTATIONS, failedOutcome } from './ensure-ops.mjs';
import { ensureSpecs } from './ensure-specs.mjs';
import { ensureRules } from './project-rules/index.mjs';
import { ensureScripts } from './distribution-files/index.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The op table this CLI walks — name → implementation, in ENSURE_OPS order. Composed HERE (the one
// consumer) because the executor, scripts, spec-layer and rules ensures import ensure-ops.mjs for their outcome door and probes.
export const ENSURE_IMPLEMENTATIONS = Object.freeze({ ...OWN_IMPLEMENTATIONS, executor: ensureExecutor, scripts: ensureScripts, specs: ensureSpecs, rules: ensureRules });

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const EMPTY_CWD = '--cwd needs a path argument (an empty value would silently mean the current directory)';
const EMPTY_ONLY = `--only needs one operation name (${ENSURE_OPS.join(' | ')}) — an empty value would silently widen the run`;
const REPEATED_ONLY = '--only was passed more than once — this selector names exactly ONE operation';
const unknownOp = (value) => `--only ${value}: no such operation (${ENSURE_OPS.join(' | ')}) — nothing was run`;

const HELP = `ensure-configs — the nine stamp-independent upgrade ensures, as ONE command.

Usage:
  node ensure-configs.mjs --reconcile [--dry-run] [--only <op>] [--cwd <project>]

  --reconcile   required — run the nine ensures (${ENSURE_OPS.join(', ')})
  --dry-run     report what each ensure WOULD do; write nothing
  --only <op>   run EXACTLY ONE of them (an unknown, missing or repeated value is a usage error)
  --cwd <dir>   the target project (default: the current directory)
  --help, -h    this help

Every SEED is CREATE-ONLY: an existing file is preserved byte-for-byte, never clobbered and never
refreshed in place. Four ops refresh instead: the orchestration onboarding note, written current over any other
note with no question and no copy kept, every recipe kept (a differing note's line names where a note of your
own goes); the spec-layer reader and checker pairs, with no question and no copy kept: a body a release shipped
is refreshed, an edited one replaced (its line names where an edit meant to last goes) and an absent one placed,
the reader pair, then the checker pair, then the spec store root seeded create-only; the project rules
kit file, refreshed while its bytes are a body a release shipped and any other body replaced by the template,
with no question and no copy kept, the effective file rebuilt as its copy and recorded where no local file
exists; and the navigator index — a GENERATED artifact, regenerated
whenever it is missing or stale; where a module the project's hook loads is not the bundled one,
the project's own checker judges the navigator and a write it rejects is put back byte for byte.
The executor ensure writes nothing: a placed .claude/agents/executor.md whose bytes differ from the
body derived from docs/ai/vehicles.json is pending and an absent one is not placed here — the
advisor's agents item writes the derived body.
A fifth writes too: once a kit script outside the seed names stands in scripts/, the enforcement-script
ensure writes every kit script that is not the bundled body, the hook installer and its two suites
first, with no question and no copy kept: a body a release shipped is refreshed, an edited one replaced
(its line names where an edit meant to last goes) and an absent one placed; on a project that
declined the enforcement offer, its standing seed files are kept current the same way, with an
absent module they import placed, and no other kit script is placed; after the writes the project's
scripts/archive-decisions.mjs --ensure-current brings the ADR store current, an older layout moved.

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

const runOne = (op, args) => {
  try {
    return ENSURE_IMPLEMENTATIONS[op](args);
  } catch (err) {
    return failedOutcome(op, err);
  }
};

// Run every op in ENSURE_OPS order. A throw from one op becomes THAT op's failed outcome — the
// remaining ops still run, because a project missing its gate declaration should not also be left
// without its autonomy seed just because the first ensure hit an unreadable file. → the outcomes.
export const runEnsures = ({ cwd, kitRoot, dryRun, deps, only }) =>
  (only ? [only] : ENSURE_OPS).map((op) => runOne(op, { cwd, kitRoot, dryRun, deps }));

const render = (outcomes, { dryRun, only }) => {
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
    // reconcile, and one identical STOP per op would read as that many separate problems.
    assertDocsAiDeployment(cwd, deps, { noun: 'the project configuration', rel: 'under docs/ai' });
    const kitRoot = ctx.kitRoot ?? KIT_ROOT;
    const outcomes = runEnsures({ cwd, kitRoot, dryRun: args.dryRun, deps, only: args.only });
    return {
      code: outcomes.some((o) => o.failed) ? EXIT_FAILED : EXIT_OK,
      stdout: render(outcomes, { dryRun: args.dryRun, only: args.only }),
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
