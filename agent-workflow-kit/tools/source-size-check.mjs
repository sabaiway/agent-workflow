#!/usr/bin/env node
// source-size-check.mjs — the source-size practice's CLI and its writer half. The pure read core
// (config, scope, counting, the canonical gate-cmd matcher) lives in source-size-core.mjs, the
// verdict in source-size-judge.mjs and its wording in source-size-report.mjs; all three are imported
// here. NOTHING in the read graph imports THIS module, so the advisor surfaces can ask about the
// practice without ever reaching a writer (D-18).
//
// What --check judges: every in-scope file against the config's `defaults`, and every RECORDED size
// against the ratchet instead — a record may not grow, may not sit above what the tree measures, and
// may not outlive its file. Each declared root carries the same ratchet over its summed lines, so
// splitting one big file into six buys no headroom.
//
// What --write-baseline does: regenerates the machine keys from the tree, and ONLY the machine keys.
// The authored half is copied through with its VALUES and their ORDER preserved exactly; the file
// itself is canonically serialized, so its formatting becomes the writer's (that is what makes a
// regeneration of an unchanged tree reproduce the same bytes). A regeneration that RAISES any value takes
// --reason "<text>" — the checker cannot invent the human's reason — and that string lands verbatim
// in the entry it raises. A pure tighten needs none: shrinking is progress. The printed old→new
// delta is the durable record where docs/ai is git-hidden; it is what the commit message carries.
//
// Exit codes: 0 green / 1 violation or refusal / 2 usage, config or enumeration error.
// Dependency-free, Node >= 22. No side effects on import.

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertDocsAiDeployment, writeDocsAiFileAtomic } from './atomic-write.mjs';
import {
  AUTHORED_KEYS,
  SOURCE_SIZE_CONFIG_REL,
  loadSourceSizeConfig,
  reasonDefect,
  scopeFail,
} from './source-size-core.mjs';
import { changesFor, isRaise, judgeTree, ownEntry } from './source-size-judge.mjs';
import {
  absentRefusalLines,
  checkReportLines,
  reasonRequiredLines,
  unmintedRefusalLines,
  writtenLines,
} from './source-size-report.mjs';

const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });
const RECORD_NOUN = 'the source-size record';

export const runCheck = ({ cwd, deps = {} }) => {
  const { state, config, missingMachineKeys } = loadSourceSizeConfig(cwd, deps);
  if (state === 'absent') return { code: 1, lines: absentRefusalLines(cwd) };
  if (state !== 'minted') return { code: 1, lines: unmintedRefusalLines(cwd, { state, missing: missingMachineKeys }) };
  const verdict = judgeTree(cwd, config, deps);
  return { code: verdict.findings.length === 0 ? 0 : 1, lines: checkReportLines({ cwd, config, verdict }) };
};

// ── the writer ────────────────────────────────────────────────────────────────────────────────────

// planRecord computes what the regeneration WOULD write, before any reason is applied — so a raise
// can be refused without ever building an entry that carries no reason. It reads the JUDGE's
// projection, never its own: the checker's verdict and the file the writer produces are then two
// renderings of one computation, and neither can promise what the other would not do.
const planRecord = ({ config, verdict }) => {
  const oldBaseline = config.baseline ?? {};
  const oldAggregate = config.aggregate ?? {};
  const files = verdict.scope.files.map((rel) => {
    const next = verdict.projected.get(rel);
    const recorded = ownEntry(oldBaseline, rel);
    return { rel, next, recorded, changes: changesFor(rel, next, recorded) };
  });
  const roots = config.roots.map((root) => ({
    root,
    lines: verdict.rootLines.get(root) ?? 0,
    recorded: ownEntry(oldAggregate, root),
  }));
  const deltas = [
    ...files.flatMap(({ changes }) => changes),
    // A record whose file left scope is REMOVED, never kept: that is what makes a split or a rename
    // visible in the delta instead of silently surviving as headroom.
    ...Object.entries(oldBaseline)
      .filter(([rel]) => !verdict.measured.has(rel))
      .flatMap(([rel, recorded]) => changesFor(rel, {}, recorded)),
    ...roots
      .filter(({ lines, recorded }) => (recorded ? recorded.lines : null) !== lines)
      .map(({ root, lines, recorded }) => ({ target: root, dimension: 'aggregate lines', from: recorded ? recorded.lines : null, to: lines })),
    ...Object.entries(oldAggregate)
      .filter(([root]) => !config.roots.includes(root))
      .map(([root, recorded]) => ({ target: root, dimension: 'aggregate lines', from: recorded.lines, to: null })),
  ];
  return { files, roots, deltas, raises: deltas.filter(isRaise) };
};

// The reason of an entry the regeneration did NOT raise is the one already recorded — a tighten
// rewrites a number, never the human sentence that justified it.
const materialize = ({ files, roots }, reason) => ({
  baseline: Object.fromEntries(
    files
      .filter(({ next }) => Object.keys(next).length > 0)
      .map(({ rel, next, recorded, changes }) => [rel, {
        ...next,
        reason: changes.some(isRaise) ? reason : recorded.reason,
      }]),
  ),
  aggregate: Object.fromEntries(
    roots.map(({ root, lines, recorded }) => [root, {
      lines,
      reason: !recorded || lines > recorded.lines ? reason : recorded.reason,
    }]),
  ),
});

// The file is CANONICALLY serialized: the authored VALUES and the ORDER the human wrote them in are
// preserved exactly, their formatting is not — this file is machine-maintained and the writer owns
// half of it, so one deterministic rendering is what makes "regenerate an unchanged tree and get the
// same bytes" true at all.
const serialize = (parsed, machineKeys) => {
  const authored = Object.fromEntries(Object.keys(parsed).filter((key) => AUTHORED_KEYS.includes(key)).map((key) => [key, parsed[key]]));
  return `${JSON.stringify({ ...authored, ...machineKeys }, null, 2)}\n`;
};

export const runWriteBaseline = ({ cwd, reason, deps = {} }) => {
  // Checked BEFORE the config is read, so a project that was never deployed hears about the
  // deployment rather than about a file it has no place to put.
  assertDocsAiDeployment(cwd, deps, { stop: scopeFail, rel: SOURCE_SIZE_CONFIG_REL, noun: RECORD_NOUN });
  const { state, config, parsed, text } = loadSourceSizeConfig(cwd, deps);
  if (state === 'absent') return { code: 1, lines: absentRefusalLines(cwd) };
  const verdict = judgeTree(cwd, config, deps);
  const plan = planRecord({ config, verdict });
  if (plan.raises.length > 0 && reason === undefined) return { code: 1, lines: reasonRequiredLines(cwd, plan.deltas) };
  const body = serialize(parsed, materialize(plan, reason));
  // Whether anything was written is decided by the BYTES, not by the delta count: completing a
  // hand-edited half record changes the file while raising nothing at all.
  const changed = body !== text;
  if (changed) writeDocsAiFileAtomic(cwd, SOURCE_SIZE_CONFIG_REL, body, deps, { stop: scopeFail, noun: RECORD_NOUN });
  return { code: 0, lines: writtenLines({ cwd, deltas: plan.deltas, reason: plan.raises.length > 0 ? reason : undefined, changed }) };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const MODES = Object.freeze(['--check', '--write-baseline']);

const HELP = `source-size-check — the declared source-size practice (agent-workflow family).

Usage:
  node source-size-check.mjs --check [--cwd <project-root>]
  node source-size-check.mjs --write-baseline [--reason "<text>"] [--cwd <project-root>]

Judges every in-scope file against ${SOURCE_SIZE_CONFIG_REL}: git-tracked files under a declared
root carrying a declared extension, minus the excluded path-segment prefixes. Scope is DECLARED,
never guessed — with the config absent the check REFUSES and prints the exact file to author.
Symlinks and submodule gitlinks are skipped by kind; an unmerged index, a non-UTF-8 in-scope path,
an unverifiable in-scope file and an empty declared scope are refusals, never silent greens.

Counting: lines, and the longest line in BYTES. A terminator never counts (the CR of a CRLF
included); a last line with no final newline still counts; an empty file is 0 lines.

A file carrying a recorded baseline entry is recorded DEBT: it is judged against the record, which
may not grow, may not sit above the measured size, and may not outlive its file. Each declared root
carries the same ratchet over its summed lines.

--write-baseline regenerates the machine keys (baseline, aggregate) from the tree. The authored keys
keep their values and their order; the file is canonically serialized, so its formatting is the
writer's. A regeneration that RAISES any recorded value needs --reason; the string is recorded in
the entry it raised. A pure tighten needs none.

Exit codes: 0 green; 1 violation or refusal; 2 usage, config or enumeration error.`;

const takeOption = (argv, flag) => {
  const at = argv.indexOf(flag);
  if (at === -1) return { rest: argv, value: undefined };
  if (argv[at + 1] === undefined) throw usageFail(`${flag} needs a value`);
  return { rest: [...argv.slice(0, at), ...argv.slice(at + 2)], value: argv[at + 1] };
};

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const cwdOption = takeOption(argv, '--cwd');
    const reasonOption = takeOption(cwdOption.rest, '--reason');
    // Resolved BEFORE the run and before anything is rendered: every path this run names is then
    // meaningful from any directory, not only from the one that invoked it.
    const cwd = resolve(ctx.cwd ?? process.cwd(), cwdOption.value ?? '.');
    const modes = MODES.filter((mode) => reasonOption.rest.includes(mode));
    if (modes.length === 0) throw usageFail('nothing to do — pass --check or --write-baseline (see --help)');
    if (modes.length > 1) throw usageFail(`pass exactly ONE mode, got: ${modes.join(' and ')}`);
    const unknown = reasonOption.rest.filter((arg) => !MODES.includes(arg));
    if (unknown.length > 0) throw usageFail(`unknown argument: ${unknown[0]}`);
    if (reasonOption.value !== undefined) {
      if (modes[0] === '--check') throw usageFail('--reason belongs to --write-baseline — a check records nothing');
      const defect = reasonDefect(reasonOption.value);
      if (defect) throw usageFail(defect);
    }
    const deps = ctx.deps ?? {};
    const { code, lines } = modes[0] === '--check'
      ? runCheck({ cwd, deps })
      : runWriteBaseline({ cwd, reason: reasonOption.value, deps });
    return { code, stdout: lines.join('\n'), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `source-size-check: ${err.message}` };
  }
};

// Compared by REAL path, not lexically: ESM resolves a symlinked entry point to its target, so a
// lexical comparison is false whenever the tool is invoked through a link — and a gate whose cmd
// names a link would then exit 0 having run nothing, which reads as PASS.
// Exported as a test seam (the coverage-check keyFor idiom): the unresolvable arm cannot be reached
// through the CLI, where an existing entry point is a precondition of getting this far.
export const sameFile = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};
const isDirectRun = Boolean(process.argv[1]) && sameFile(fileURLToPath(import.meta.url), process.argv[1]);
if (isDirectRun) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  process.exitCode = result.code;
}
