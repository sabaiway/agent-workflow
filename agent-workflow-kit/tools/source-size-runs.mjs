// source-size-runs.mjs — what each mode of the size check does: the check, the writer half
// (--write-baseline, --override) and the adoption verb. The command line in source-size-check.mjs parses
// the arguments and composes what a run returns. NOTHING in the read graph imports this module, so the
// advisor surfaces can ask about the practice without ever reaching a writer (D-18).
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
//
// Dependency-free, Node >= 22. No side effects on import.

import { composeRedBlock } from '../references/scripts/shared/index.mjs';
import { assertDocsAiDeployment, writeDocsAiFileAtomic } from './atomic-write.mjs';
import {
  KIT_LIMITS,
  SOURCE_SIZE_CONFIG_REL,
  SOURCE_SIZE_GATE_ID,
  SOURCE_SIZE_SCHEMA,
  applyOverride,
  assertNoStoreRoot,
  checkTargetOf,
  isRaise,
  loadSourceSizeConfig,
  matchesSourceSizeGate,
  materialize,
  migrateSchema1,
  planRecord,
  refusedRaises,
  scopeFail,
  serialize,
  validateSourceSizeConfig,
} from './source-size-core.mjs';
import { bandWarningsOf, judgeTree, standingWarningsOf, stopsOf } from './source-size-judge.mjs';
import { GATES_REL, loadDeclaration } from './gates-declaration.mjs';
import { applyFill } from './gates-init.mjs';
import {
  TEMPLATE_README,
  TEMPLATE_READMES,
  absentRefusalLines,
  adoptAbsentRefusalLines,
  checkReportLines, checkStopBlock,
  gateAlreadyDeclaredLines,
  gateDeclaredLines,
  gateRefusedLines,
  kitSentenceRefusedLines,
  overrideOutgrownLines,
  overrideUnchangedLines,
  overrideWrittenLines,
  reasonRequiredLines,
  recordNoLongerHoldsLines,
  recordRecognizedLines,
  schema1MovedLines, schema1StopBlock,
  unmintedRefusalLines, unmintedStopBlock,
  warningLines,
  writtenLines,
} from './source-size-report.mjs';

export const ERROR_PREFIX = '[agent-workflow-kit] ';
export const CHECKER_NAME = 'source-size';
export const USAGE_REFUSAL = Symbol('usage refusal');
export const usageFail = (message) => Object.assign(new Error(`${ERROR_PREFIX}${message}`), { exitCode: 2, [USAGE_REFUSAL]: true });
const RECORD_NOUN = 'the source-size record';
const LAYOUT_GROWTH_LEAD = 'source-size: --layout REFUSED — it starts the layout record and raises nothing else, but the record no longer holds for this tree, so that growth takes --write-baseline --reason first; no record was regenerated.';

// What an absent config is judged as: schema 2 under the kit's values, layout over "." and the store.
const ABSENT = Object.freeze({ _README: TEMPLATE_README, schema: SOURCE_SIZE_SCHEMA });

// Every run returns the config it resolved, so the CLI states the limits that run judged, and the
// scope it judged, so the CLI says once what it did not.
export const runCheck = ({ cwd, deps = {} }) => {
  const target = checkTargetOf({ loaded: loadSourceSizeConfig(cwd, deps), absentConfig: validateSourceSizeConfig(ABSENT) });
  const { config, judged } = target;
  if (target.stop === 'schema-1') return { code: 1, block: schema1StopBlock(cwd), config };
  if (target.stop === 'unminted') return { code: 1, block: unmintedStopBlock(cwd, { state: target.state, missing: target.missing, config }), config };
  const verdict = judgeTree(cwd, config, deps, judged);
  const report = { cwd, config, verdict, absent: judged.absent };
  return stopsOf(verdict.findings).length > 0 ? { code: 1, block: checkStopBlock(report), config, judged, scope: verdict.scope }
    : { code: 0, lines: checkReportLines(report), config, judged, scope: verdict.scope };
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

const writeRefusalOf = ({ cwd, plan, reason, config, minted, starts }) => {
  const plain = starts && minted ? plan.deltas.filter((delta) => !plan.layout.deltas.includes(delta)) : [];
  if (plain.some(isRaise)) return [LAYOUT_GROWTH_LEAD, ...reasonRequiredLines(cwd, plain)];
  if (plan.raises.length > 0 && reason === undefined) return reasonRequiredLines(cwd, plan.deltas, { layout: starts });
  const refused = refusedRaises({ plan, config, reason });
  return refused.length > 0 ? kitSentenceRefusedLines(cwd, plan.deltas, refused.length, { layout: starts }) : null;
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
  const { verdict, plan, bandWarnings, warnings } = judgeForWrite(cwd, config, deps, judged);
  const scope = verdict.scope;
  const minted = loaded.state === 'minted';
  const refused = writeRefusalOf({ cwd, plan, reason, config, minted, starts: layout && !absent && config.layout === null });
  if (refused !== null) {
    const moved = minted && config.schema === 1 ? moveMinted(cwd, parsed, deps) : [];
    return { code: 1, lines: [...bandWarnings, ...moved, ...refused], config, judged, scope };
  }
  const body = serialize(schema2Of(parsed), materialize(plan, reason));
  // Whether anything was written is decided by the BYTES, not by the delta count: completing a
  // hand-edited half record changes the file while raising nothing at all.
  const changed = body !== loaded.text;
  if (changed) writeRecord(cwd, body, deps);
  const written = writtenLines({ cwd, deltas: plan.deltas, reason: plan.raises.length > 0 ? reason : undefined, changed });
  return { code: 0, lines: [...warnings, ...movedLines(cwd, parsed), ...written], config, judged, scope };
};

// --override: the projection under the CURRENT limits comes first, so an override's reason never
// lands on drift it did not cause; only then is the override applied and the record regenerated
// under the new limits, in the same atomic write.
export const runOverride = ({ cwd, id, value, tolerance, kitDefault, reason, deps = {} }) => {
  assertDocsAiDeployment(cwd, deps, { stop: scopeFail, rel: SOURCE_SIZE_CONFIG_REL, noun: RECORD_NOUN });
  const { state, config, parsed, text, missingMachineKeys } = loadSourceSizeConfig(cwd, deps);
  if (state === 'absent') return { code: 1, lines: absentRefusalLines(cwd) };
  if (state !== 'minted') return { code: 1, lines: unmintedRefusalLines(cwd, { state, missing: missingMachineKeys, config }), config };
  const judged = { absent: false, layout: config.layout !== null };
  const current = judgeForWrite(cwd, config, deps, judged);
  const scope = current.verdict.scope;
  if (current.plan.raises.length > 0) return { code: 1, lines: [...current.bandWarnings, ...overrideOutgrownLines(cwd, current.plan.deltas)], config, judged, scope };
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
  if (body === text) return { code: 0, lines: [...warnings, ...overrideUnchangedLines(cwd, id)], config: nextConfig, judged, scope };
  writeRecord(cwd, body, deps);
  return {
    code: 0,
    judged,
    scope,
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
  if (verdict.code !== 0) return { code: verdict.code, lines: [...composeRedBlock({ name: CHECKER_NAME, ...verdict.block }), ...recordNoLongerHoldsLines(GATES_REL)] };
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
