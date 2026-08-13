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
// What --adopt does: mints the record and declares the gate — the whole adoption as ONE consented
// line, because the alternative is a two-step ceremony whose halves can be left half-done. It
// composes the two writers it already has (this module's mint, the fill's consented apply restricted
// to this one id) and owns no write of its own.
//
// Exit codes: 0 green / 1 violation or refusal / 2 usage, config or enumeration error.
// Dependency-free, Node >= 22. No side effects on import.

import { resolve } from 'node:path';
import { assertDocsAiDeployment, writeDocsAiFileAtomic } from './atomic-write.mjs';
import { isDirectRun, sameFile } from './direct-run.mjs';
import {
  AUTHORED_KEYS,
  SOURCE_SIZE_CONFIG_REL,
  SOURCE_SIZE_GATE_ID,
  loadSourceSizeConfig,
  matchesSourceSizeGate,
  reasonDefect,
  scopeFail,
} from './source-size-core.mjs';
import { changesFor, isRaise, judgeTree, ownEntry } from './source-size-judge.mjs';
import { GATES_REL, loadDeclaration } from './gates-declaration.mjs';
import { applyFill } from './gates-init.mjs';
import {
  absentRefusalLines,
  adoptAbsentRefusalLines,
  checkReportLines,
  gateAlreadyDeclaredLines,
  gateDeclaredLines,
  gateRefusedLines,
  reasonRequiredLines,
  recordNoLongerHoldsLines,
  recordRecognizedLines,
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

// ── the adoption verb (D-16) ──────────────────────────────────────────────────────────────────────

// Declaring the gate is delegated to the FILL's own consented apply, restricted to this one id: the
// fill owns every rule about what a written declaration may look like (placement, id collisions, the
// coverage invariant, the atomic write), and a second writer here would be a second set of those
// rules — the one that drifts. `--adopt` is therefore a composition, never a re-implementation.
//
// The already-declared arm is checked FIRST and through the practice's own matcher: an earlier
// partial run leaves a minted record and a declared gate, and re-running must converge rather than
// collide. A gate that merely CARRIES the id without being this checker does not count — it reaches
// the fill and collides there, loudly, which is the honest answer to a squatter.
// The READ is inside the try with the write, deliberately: by the time this runs the record is
// already minted, so ANY failure here — a malformed declaration the reader throws on, just as much
// as a collision the fill refuses — must still report both halves. Letting the read escape would
// surface a bare error carrying neither the mint that succeeded nor the exit contract this tool
// documents.
const declareGate = (cwd, deps) => {
  try {
    applyFill({ cwd, onlyIds: [SOURCE_SIZE_GATE_ID] }, deps);
    return { code: 0, lines: gateDeclaredLines(GATES_REL, SOURCE_SIZE_GATE_ID) };
  } catch (err) {
    return { code: 1, lines: gateRefusedLines(GATES_REL, err?.message ?? String(err)) };
  }
};

// Is the canonical gate ALREADY there? Asked through the practice's own matcher, so a gate that
// merely carries the id — running something else entirely — never reads as adopted; it reaches the
// fill and collides there, loudly, which is the honest answer to a squatter.
//
// An unreadable declaration is NOT a verdict here. This read is a shortcut, and aborting on it would
// report an outcome before the record was settled; the fill re-reads the same file and refuses
// authoritatively AFTER, so the partial report names both halves truthfully.
const gateIsDeclared = (cwd, deps) => {
  try {
    const declaration = loadDeclaration(cwd, deps);
    return (declaration.outcome === 'loaded' ? declaration.gates : []).some((gate) => matchesSourceSizeGate(gate.cmd, cwd));
  } catch {
    return false;
  }
};

// A MINTED record is RECOGNIZED, never regenerated. Adoption carries a PINNED reason — the advisor
// renders it as a fixed string, and its item keeps firing while the gate is undeclared — so a
// re-run after a partial adoption would let that one sentence raise whatever the tree grew in the
// meantime. That is exactly the laundering the reason requirement exists to prevent, so the verb
// asks the checker instead: a record that no longer holds is a ratchet question with its own
// reasoned lane, and it must be answered BEFORE a gate is declared over it — declaring one that is
// certain to red the matrix is what the offer rules refuse everywhere else.
const recognizeRecord = ({ cwd, deps }) => {
  const verdict = runCheck({ cwd, deps });
  if (verdict.code !== 0) return { code: verdict.code, lines: [...verdict.lines, ...recordNoLongerHoldsLines(GATES_REL)] };
  return { code: 0, lines: recordRecognizedLines(cwd) };
};

// --adopt = settle the record, then declare the gate. The order is not a preference: the fill offers
// the gate ONLY over a minted config (declaring it earlier would declare a gate that refuses), so
// the record is what makes the declaration offerable at all.
export const runAdopt = ({ cwd, reason, deps = {} }) => {
  const { state } = loadSourceSizeConfig(cwd, deps);
  if (state === 'absent') return { code: 1, lines: adoptAbsentRefusalLines(cwd) };
  // ADOPTED is asked FIRST, and it is a question about the GATE alone. Idempotence cannot be made
  // conditional on the record still holding: a declared gate reports its own staleness on every run,
  // with the reasoned lane, and stopping here would tell a reader the gate was not declared while it
  // plainly is — which is exactly what re-running the advisor's one-liner on a drifted tree does.
  // Once the gate is there and the record is minted, nothing is left to adopt.
  const declared = gateIsDeclared(cwd, deps);
  if (declared && state === 'minted') return { code: 0, lines: gateAlreadyDeclaredLines(GATES_REL) };
  // Either half carries its OWN self-servable refusals (a raise with no reason, a project with no
  // docs/ai, a record the tree outgrew). They are returned unchanged: re-wording them here would be
  // the second practice this module exists to avoid, and each already names the step that clears it.
  const record = state === 'minted' ? recognizeRecord({ cwd, deps }) : runWriteBaseline({ cwd, reason, deps });
  if (record.code !== 0) return record;
  if (declared) return { code: 0, lines: [...record.lines, ...gateAlreadyDeclaredLines(GATES_REL)] };
  const gate = declareGate(cwd, deps);
  return { code: gate.code, lines: [...record.lines, ...gate.lines] };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const MODES = Object.freeze(['--check', '--write-baseline', '--adopt']);

const HELP = `source-size-check — the declared source-size practice (agent-workflow family).

Usage:
  node source-size-check.mjs --check [--cwd <project-root>]
  node source-size-check.mjs --write-baseline [--reason "<text>"] [--cwd <project-root>]
  node source-size-check.mjs --adopt [--reason "<text>"] [--cwd <project-root>]

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

--adopt is the ONE-line adoption: it mints the record and declares the source-size gate (and NOTHING
else) in docs/ai/gates.json. It is idempotent on an already-adopted project. With the config absent
it refuses with the exact file to author — that authoring is the practice's single manual step, and
the refusal says so. A refused declaration exits nonzero and reports both halves: what was minted and
what was not declared.

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
    // Counted over the ARGUMENTS, not over the mode list: filtering the list collapses repeats, so
    // `--adopt --adopt` read as exactly one mode and a WRITE ran under an argument list this very
    // guard had just called invalid.
    const modes = reasonOption.rest.filter((arg) => MODES.includes(arg));
    if (modes.length === 0) throw usageFail(`nothing to do — pass one of ${MODES.join(', ')} (see --help)`);
    if (modes.length > 1) throw usageFail(`pass exactly ONE mode, got: ${modes.join(', ')}`);
    const unknown = reasonOption.rest.filter((arg) => !MODES.includes(arg));
    if (unknown.length > 0) throw usageFail(`unknown argument: ${unknown[0]}`);
    if (reasonOption.value !== undefined) {
      if (modes[0] === '--check') throw usageFail('--reason belongs to --write-baseline and --adopt — a check records nothing');
      const defect = reasonDefect(reasonOption.value);
      if (defect) throw usageFail(defect);
    }
    const deps = ctx.deps ?? {};
    const run = { '--check': runCheck, '--write-baseline': runWriteBaseline, '--adopt': runAdopt }[modes[0]];
    const { code, lines } = run({ cwd, reason: reasonOption.value, deps });
    return { code, stdout: lines.join('\n'), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `source-size-check: ${err.message}` };
  }
};

// The realpath-compare direct-run predicate now lives in tools/direct-run.mjs (the fix this file
// carried first, extracted so every module shares one implementation); `sameFile` stays exported here
// because this module's tests bind it as a seam.
export { sameFile };
if (isDirectRun(import.meta.url)) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  process.exitCode = result.code;
}
