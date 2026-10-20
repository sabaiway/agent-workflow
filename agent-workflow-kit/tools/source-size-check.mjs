#!/usr/bin/env node
// source-size-check.mjs — the source-size practice's CLI and its writer half. The pure read core
// (config, scope, counting, the canonical gate-cmd matcher) lives in source-size-core.mjs, the
// verdict in source-size-judge.mjs and its wording in source-size-report.mjs; all three are imported
// here. NOTHING in the read graph imports THIS module, so the advisor surfaces can ask about the
// practice without ever reaching a writer (D-18).
//
// What --check judges: every in-scope file against the resolved limits with their bands, layout
// where it is recorded or the config is absent, and every RECORDED size against the ratchet — a
// record may not grow, and one above the tree or gone warns until the regeneration lowers or removes
// it. Each declared root carries the same exact ratchet over its summed lines, so splitting one big
// file into six buys no headroom. An absent config is judged under the kit's values.
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
// to this one id) and owns no write of its own, but for the schema-1 move of a minted config, which
// carries both records verbatim.
//
// What --override does: once a regeneration under the current limits would raise nothing, writes or
// removes one reasoned override of a kit limit and regenerates the machine keys under the new limits
// in the same write. Every write here moves a schema-1 config to schema 2; --check stops on one.
//
// Exit codes: 0 green / 1 violation or refusal / 2 usage, config or enumeration error.
// Dependency-free, Node >= 22. No side effects on import.

import { resolve } from 'node:path';
import { assertDocsAiDeployment, writeDocsAiFileAtomic } from './atomic-write.mjs';
import { isDirectRun, sameFile } from './direct-run.mjs';
import {
  KIT_LIMITS,
  SOURCE_SIZE_CONFIG_REL,
  SOURCE_SIZE_GATE_ID,
  SOURCE_SIZE_SCHEMA,
  applyOverride,
  assertNoStoreRoot,
  loadSourceSizeConfig,
  matchesSourceSizeGate,
  materialize,
  migrateSchema1,
  planRecord,
  reasonDefect,
  scopeFail,
  serialize,
  validateSourceSizeConfig,
} from './source-size-core.mjs';
import { bandWarningsOf, judgeTree, standingWarningsOf, stopsOf } from './source-size-judge.mjs';
import { GATES_REL, loadDeclaration } from './gates-declaration.mjs';
import { applyFill } from './gates-init.mjs';
import {
  HELP,
  TEMPLATE_README,
  TEMPLATE_READMES,
  absentRefusalLines,
  adoptAbsentRefusalLines,
  checkReportLines,
  gateAlreadyDeclaredLines,
  gateDeclaredLines,
  gateRefusedLines,
  notJudgedLines,
  overrideOutgrownLines,
  overrideUnchangedLines,
  overrideWrittenLines,
  reasonRequiredLines,
  recordNoLongerHoldsLines,
  recordRecognizedLines,
  schema1MovedLines,
  schema1StopLines,
  statedLimitLines,
  unmintedRefusalLines,
  warningLines,
  writtenLines,
} from './source-size-report.mjs';

const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });
const RECORD_NOUN = 'the source-size record';

// What an absent config is judged as: schema 2 under the kit's values, layout over "." and the store.
const ABSENT = Object.freeze({ _README: TEMPLATE_README, schema: SOURCE_SIZE_SCHEMA });

// Every run returns the config it resolved, so the CLI states the limits that run judged, and the
// scope it judged, so the CLI says once what it did not.
export const runCheck = ({ cwd, deps = {} }) => {
  const { state, config: present, missingMachineKeys } = loadSourceSizeConfig(cwd, deps);
  const absent = state === 'absent';
  const config = absent ? validateSourceSizeConfig(ABSENT) : present;
  if (config.schema === 1) return { code: 1, lines: schema1StopLines(cwd), config };
  if (!absent && state !== 'minted') return { code: 1, lines: unmintedRefusalLines(cwd, { state, missing: missingMachineKeys }), config };
  const judged = { absent, layout: absent || config.layout !== null };
  const verdict = judgeTree(cwd, config, deps, judged);
  return { code: stopsOf(verdict.findings).length === 0 ? 0 : 1, lines: checkReportLines({ cwd, config, verdict, absent }), config, judged };
};

// ── the writer ────────────────────────────────────────────────────────────────────────────────────

// A schema-1 config is moved by the one transform, the kit's old template `_README` replaced by the
// new one; every write of this module goes through it, so no writer ever writes schema 1 back.
const schema2Of = (parsed) => (parsed.schema === 1 ? migrateSchema1(parsed, TEMPLATE_READMES) : parsed);

// What a move says it did, read off the moved config itself.
const movedLines = (cwd, parsed) => (parsed.schema === 1 ? schema1MovedLines(cwd) : []);

const writeRecord = (cwd, body, deps) =>
  writeDocsAiFileAtomic(cwd, SOURCE_SIZE_CONFIG_REL, body, deps, { stop: scopeFail, noun: RECORD_NOUN });

// A run that writes prints every warning its write leaves standing; a refused write prints only
// those standing today.
const judgeForWrite = (cwd, config, deps, judged) => {
  const verdict = judgeTree(cwd, config, deps, judged);
  const { findings } = verdict;
  return { verdict, plan: planRecord({ config, verdict }), bandWarnings: warningLines(bandWarningsOf(findings)), warnings: warningLines(standingWarningsOf(findings)) };
};

// Layout is regenerated wherever it is judged; --layout starts it on a present config with none, and
// changes nothing on one that records layout or is absent.
export const runWriteBaseline = ({ cwd, reason, layout = false, deps = {} }) => {
  // Checked BEFORE the config is read, so a project that was never deployed hears about the
  // deployment rather than about a file it has no place to put.
  assertDocsAiDeployment(cwd, deps, { stop: scopeFail, rel: SOURCE_SIZE_CONFIG_REL, noun: RECORD_NOUN });
  const loaded = loadSourceSizeConfig(cwd, deps);
  const absent = loaded.state === 'absent';
  const parsed = absent ? ABSENT : loaded.parsed;
  const config = absent ? validateSourceSizeConfig(parsed) : loaded.config;
  if (layout && !absent && config.layout === null) assertNoStoreRoot(config.roots);
  const judged = { absent, layout: absent || layout || config.layout !== null };
  const { plan, bandWarnings, warnings } = judgeForWrite(cwd, config, deps, judged);
  const starts = layout && !absent && config.layout === null;
  if (plan.raises.length > 0 && reason === undefined) return { code: 1, lines: [...bandWarnings, ...reasonRequiredLines(cwd, plan.deltas, { layout: starts })], config, judged };
  const body = serialize(schema2Of(parsed), materialize(plan, reason));
  // Whether anything was written is decided by the BYTES, not by the delta count: completing a
  // hand-edited half record changes the file while raising nothing at all.
  const changed = body !== loaded.text;
  if (changed) writeRecord(cwd, body, deps);
  const written = writtenLines({ cwd, deltas: plan.deltas, reason: plan.raises.length > 0 ? reason : undefined, changed });
  return { code: 0, lines: [...warnings, ...movedLines(cwd, parsed), ...written], config, judged };
};

// --override: the projection under the CURRENT limits comes first, so an override's reason never
// lands on drift it did not cause; only then is the override applied and the record regenerated
// under the new limits, in the same atomic write.
export const runOverride = ({ cwd, id, value, tolerance, kitDefault, reason, deps = {} }) => {
  assertDocsAiDeployment(cwd, deps, { stop: scopeFail, rel: SOURCE_SIZE_CONFIG_REL, noun: RECORD_NOUN });
  const { state, config, parsed, text, missingMachineKeys } = loadSourceSizeConfig(cwd, deps);
  if (state === 'absent') return { code: 1, lines: absentRefusalLines(cwd) };
  if (state !== 'minted') return { code: 1, lines: unmintedRefusalLines(cwd, { state, missing: missingMachineKeys }), config };
  const judged = { absent: false, layout: config.layout !== null };
  const current = planRecord({ config, verdict: judgeTree(cwd, config, deps, judged) });
  if (current.raises.length > 0) return { code: 1, lines: overrideOutgrownLines(cwd, current.deltas), config, judged };
  const resolved = config.limits[id];
  const filled = kitDefault ? null : { value: value ?? resolved.value, tolerance: tolerance ?? resolved.tolerance, reason };
  const kit = KIT_LIMITS[id];
  if (filled !== null && filled.tolerance === kit.tolerance && (kit.value === null || filled.value === kit.value)) {
    throw usageFail(`--override ${id} equals the kit's own numbers — pass --kit-default to return to them; the writer never writes an override equal to the kit's`);
  }
  const next = applyOverride(schema2Of(parsed), id, filled);
  const nextConfig = validateSourceSizeConfig(next);
  const { plan, warnings } = judgeForWrite(cwd, nextConfig, deps, judged);
  const body = serialize(next, materialize(plan, reason));
  if (body === text) return { code: 0, lines: [...warnings, ...overrideUnchangedLines(cwd, id)], config: nextConfig, judged };
  writeRecord(cwd, body, deps);
  return {
    code: 0,
    judged,
    lines: [
      ...warnings,
      ...overrideWrittenLines({ cwd, id, removed: kitDefault, reason }),
      ...movedLines(cwd, parsed),
      ...(plan.deltas.length === 0 ? [] : writtenLines({ cwd, deltas: plan.deltas, reason: plan.raises.length > 0 ? reason : undefined, changed: true })),
    ],
    config: nextConfig,
  };
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

// A MINTED schema-1 config is moved in its own write before adoption reads it as schema 2: the
// authored half transformed, both machine records carried verbatim, nothing regenerated — so the
// adoption reason can never ride a raise. An authored or incomplete one is moved by the mint itself.
const moveMinted = (cwd, parsed, deps) => {
  writeRecord(cwd, serialize(schema2Of(parsed), { baseline: parsed.baseline, aggregate: parsed.aggregate }), deps);
  return movedLines(cwd, parsed);
};

// A stop after the move still prints the move: the write happened, and no stop may hide it.
const reportingMove = (moved, run) => {
  try {
    return run();
  } catch (err) {
    throw Object.assign(err, { lines: [...moved, ...(err.lines ?? [])] });
  }
};

// --adopt = settle the record, then declare the gate. The order is not a preference: the fill offers
// the gate ONLY over a minted config (declaring it earlier would declare a gate that refuses), so
// the record is what makes the declaration offerable at all.
export const runAdopt = ({ cwd, reason, deps = {} }) => {
  const { state, config, parsed } = loadSourceSizeConfig(cwd, deps);
  if (state === 'absent') return { code: 1, lines: adoptAbsentRefusalLines(cwd) };
  const moved = state === 'minted' && config.schema === 1 ? moveMinted(cwd, parsed, deps) : [];
  // ADOPTED is asked FIRST, and it is a question about the GATE alone. Idempotence cannot be made
  // conditional on the record still holding: a declared gate reports its own staleness on every run,
  // with the reasoned lane, and stopping here would tell a reader the gate was not declared while it
  // plainly is — which is exactly what re-running the advisor's one-liner on a drifted tree does.
  // Once the gate is there and the record is minted, nothing is left to adopt.
  const declared = gateIsDeclared(cwd, deps);
  if (declared && state === 'minted') return { code: 0, lines: [...moved, ...gateAlreadyDeclaredLines(GATES_REL)] };
  // Either half carries its OWN self-servable refusals (a raise with no reason, a project with no
  // docs/ai, a record the tree outgrew). They are returned unchanged: re-wording them here would be
  // the second practice this module exists to avoid, and each already names the step that clears it.
  const record = state === 'minted' ? reportingMove(moved, () => recognizeRecord({ cwd, deps })) : runWriteBaseline({ cwd, reason, deps });
  if (record.code !== 0) return { code: record.code, lines: [...moved, ...record.lines] };
  if (declared) return { code: 0, lines: [...moved, ...record.lines, ...gateAlreadyDeclaredLines(GATES_REL)] };
  const gate = declareGate(cwd, deps);
  return { code: gate.code, lines: [...moved, ...record.lines, ...gate.lines] };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

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
      const defect = reasonDefect(reasonOption.value);
      if (defect) throw usageFail(defect);
    } else if (mode === '--override') {
      throw usageFail('--override needs --reason "<text>" — an override is a reasoned change of a kit number');
    }
    const override = mode === '--override'
      ? overrideOptions({ id: idOption.value, value: valueOption.value, tolerance: toleranceOption.value, kitDefault })
      : {};
    const deps = ctx.deps ?? {};
    const { code, lines, config, judged } = RUNS[mode]({ cwd, reason: reasonOption.value, layout, deps, ...override });
    const states = STATES_LIMITS.includes(mode) && config;
    const limits = states ? statedLimitLines(config) : [];
    const notJudged = states && judged ? notJudgedLines(cwd, { ...judged, config }) : [];
    return { code, stdout: [...limits, ...notJudged, ...lines].join('\n'), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: (err.lines ?? []).join('\n'), stderr: `source-size-check: ${err.message}` };
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
