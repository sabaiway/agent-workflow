// cross-version-axes.mjs — the PURE halves of the Issue-016 cross-version gate: the decided
// threshold, the axis fixtures, the three axis evaluators, and the receipt contract with its
// per-field refusal. Split out of cross-version-gate.mjs so both files hold the 400-line
// source-size cap (review F4); the gate re-exports this surface, so historical import sites
// stay stable. No CLI, no side effects on import. Dependency-free, Node >= 22.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './smoke-candidate.mjs';
import { COVERAGE_PRODUCER_BODY, matchesCoverageProducer } from '../../agent-workflow-kit/tools/coverage-producer.mjs';
import { LCOV_PRODUCER_KEY } from '../../agent-workflow-kit/tools/gates-declaration.mjs';

// The FIRST marker-aware kit version — the version this series release ships (the L5 measurement;
// the release phase confirms it equals the version actually shipping, and it is fixed forever
// after that release).
export const MARKER_AWARE_SINCE = '5.7.0';

export const AXES = Object.freeze(['schema-accept', 'execution', 'producer-recognition']);
export const GATE_RECEIPT_BASENAME = 'agent-workflow-cross-version-gate.json';
export const GATE_RECEIPT_SCHEMA = 1;
export const GATE_COMMAND = 'node scripts/release/cross-version-gate.mjs';

// ── the decided threshold ─────────────────────────────────────────────────────────────

export const parseSemver = (value) =>
  typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;

const SINCE_TRIPLE = parseSemver(MARKER_AWARE_SINCE);

// NUMERIC per component — a string compare would call 5.10.0 marker-unaware. A malformed version
// throws: an arm must never be decided against a version nobody can compare.
export const isMarkerAware = (publishedVersion) => {
  const probed = parseSemver(publishedVersion);
  if (probed === null) throw fail(1, `published kit version "${publishedVersion}" is malformed — no conditional arm can be decided against it`);
  for (let i = 0; i < 3; i += 1) {
    if (probed[i] !== SINCE_TRIPLE[i]) return probed[i] > SINCE_TRIPLE[i];
  }
  return true;
};

// ── the axis fixtures ─────────────────────────────────────────────────────────────────

// Axis 1: the ONE optional schema key over a trivially-green gate — the probe asks only the
// schema question, so nothing else in the declaration may be able to fail.
export const markerFixtureGates = () => [{ id: 'suite', title: 'Marker-carrying suite', cmd: 'true', [LCOV_PRODUCER_KEY]: true }];

// Axis 2: the NEW canonical producer cmd over one green probe test. No checker on purpose — the
// axis is "does the cmd RUN and land its lcov", never the pairing question (that is axis 3).
export const EXECUTION_TEST_REL = 'tests/probe.test.mjs';
export const EXECUTION_TEST_BODY =
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('holds', () => { assert.equal(1, 1); });\n";
export const executionFixtureGates = () => [
  { id: 'unit-tests', title: 'New-form producer suite', cmd: `${COVERAGE_PRODUCER_BODY} ${EXECUTION_TEST_REL}` },
];

// ── the candidate's prior-form registry (axis 3, the candidate half) ──────────────────

// Every PREVIOUSLY emitted producer flag set, as INDEPENDENT literal bytes — deliberately NOT
// derived from KNOWN_COVERAGE_FLAG_SETS: a derived list is tautological (a deletion there would
// vanish here too, and the gate would pass over the very regression it exists to catch — review
// F1). The paired test pins this registry byte-equal to that set's tail, so a newly emitted
// form cannot be forgotten here either (the review's completeness rider).
export const PRIOR_PRODUCER_FLAG_SETS = Object.freeze([
  '--experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$AW_GIT_DIR/agent-workflow-lcov.info" --test-reporter=spec --test-reporter-destination=stdout',
]);

export const candidateOldFormRecognition = () =>
  PRIOR_PRODUCER_FLAG_SETS.map((flags) => ({ flags, recognized: matchesCoverageProducer(`node --test ${flags}`) }));

// ── the axis evaluators (pure — every verdict NAMES its axis) ─────────────────────────

const headOf = (output) => String(output ?? '').trim().split('\n').slice(0, 3).join(' | ');

export const evaluateSchemaAccept = ({ markerAware, exitCode, output }) => {
  if (markerAware) {
    return exitCode === 0
      ? []
      : [`schema-accept: the marker-aware published kit REJECTED the marker declaration (exit ${exitCode}) — a regression, not a retirement (${headOf(output)})`];
  }
  if (exitCode === 0) return ['schema-accept: the marker-unaware published kit accepted a marker-carrying declaration silently — indistinguishable from a marker-aware accept from outside'];
  if (exitCode !== 5) return [`schema-accept: expected the loud exit-5 schema rejection, got exit ${exitCode} (${headOf(output)})`];
  if (!String(output).includes(LCOV_PRODUCER_KEY)) {
    return [`schema-accept: the rejection never names ${LCOV_PRODUCER_KEY} — an exit code alone is not a loud refusal (${headOf(output)})`];
  }
  return [];
};

// Unconditional: the old runner also exports AW_GIT_DIR and its producer-reference regex does not
// match `${VAR:?}` (Issue-016 axis 2) — so the NEW-form cmd must both run green AND leave the
// lcov behind. A green run whose lcov landed nowhere is exactly the false comfort this refuses.
export const evaluateExecution = ({ exitCode, lcovExists }) => {
  const violations = [];
  if (exitCode !== 0) violations.push(`execution: the published run-gates ended at exit ${exitCode} over the NEW canonical producer cmd`);
  if (!lcovExists) violations.push('execution: the lcov never landed under the runner-injected AW_GIT_DIR');
  return violations;
};

// Two halves. The CANDIDATE half is unconditional: every prior emitted form must still be
// recognized. The PUBLISHED half rides the SAME threshold as axis 1; "inert" is read off the
// machine variant family, never prose. A payload whose gates probe never SPOKE — no parseable
// items, no skips array, or a recorded `gates-inert` skip — BLOCKS the direction judgment in
// BOTH arms (early return; review F2): absence of an inert item would otherwise read as
// recognition (the marker-aware false PASS) or as "direction changed" (the marker-unaware
// misdiagnosis). A non-object entry in `items` carries no variant and never throws (review F5).
// "Inert" is read GENERATION-AWARE (review F6, observed live against published 5.6.0): the
// variant field decides when present, and a variant-less older-generation item decides by its
// KEY — the one field every payload generation carries. A variant-only read called the live
// misread absent and red-flagged the wrong direction.
export const evaluateProducerRecognition = ({ markerAware, oldForms, advisorJsonText }) => {
  const violations = [];
  for (const { flags, recognized } of oldForms) {
    if (!recognized) violations.push(`producer-recognition: the CANDIDATE no longer recognizes a prior emitted form — the set is append-only (${flags})`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(advisorJsonText);
  } catch (err) {
    violations.push(`producer-recognition: the published advisor's --json output did not parse (${err.message})`);
    return violations;
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    violations.push("producer-recognition: the published advisor's --json payload carries no items array");
    return violations;
  }
  if (!Array.isArray(parsed.skips)) {
    violations.push("producer-recognition: the published advisor's --json payload carries no skips array — a skipped gates probe would be indistinguishable from a recognized pair");
    return violations;
  }
  const gatesSkip = parsed.skips.find((entry) => entry !== null && typeof entry === 'object' && entry.key === 'gates-inert');
  if (gatesSkip !== undefined) {
    violations.push(`producer-recognition: the published advisor SKIPPED its gates probe (${gatesSkip.reason ?? 'no reason recorded'}) — no inert judgment was made, so this run proves neither recognition nor the misread`);
    return violations;
  }
  const inert = parsed.items.some((item) => {
    const marker = typeof item?.variant === 'string' ? item.variant : item?.key;
    return typeof marker === 'string' && (marker === 'gates-inert' || marker.startsWith('gates-inert.'));
  });
  if (markerAware && inert) violations.push('producer-recognition: the marker-aware published advisor still reads the NEW-form pair as inert — a recognition regression');
  if (!markerAware && !inert) {
    violations.push("producer-recognition: the marker-unaware published advisor did NOT misread the NEW-form pair as inert — Issue-016's stated direction no longer holds; re-decide MARKER_AWARE_SINCE before shipping");
  }
  return violations;
};

// ── the receipt and the refusal it feeds ──────────────────────────────────────────────

export const buildGateReceipt = ({ kitVersion, headSha, dirty, publishedVersion, at }) => ({
  schema: GATE_RECEIPT_SCHEMA,
  outcome: 'pass',
  kitVersion,
  headSha,
  dirty,
  publishedVersion,
  axes: Object.fromEntries(AXES.map((axis) => [axis, 'pass'])),
  at,
});

export const gateReceiptPath = (gitDir) => join(gitDir, GATE_RECEIPT_BASENAME);

// Unreadable and unparsable both read as ABSENT (the smoke-candidate rule): a receipt nobody can
// read is not evidence of anything, and the refusal is identical either way.
export const readGateReceipt = (gitDir, readFile = readFileSync) => {
  try {
    const parsed = JSON.parse(String(readFile(gateReceiptPath(gitDir), 'utf8')));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// EVERY field validated — each is a DIFFERENT way for a passing receipt to be about other bytes
// (or about arms nobody decided), so each refusal states what it actually found.
export const crossVersionGateViolation = ({ receipt, kitVersion, headSha }) => {
  const rerun = `run \`${GATE_COMMAND}\` and re-dispatch`;
  if (receipt === null) return `no cross-version gate receipt for this tree — ${rerun}`;
  if (receipt.schema !== GATE_RECEIPT_SCHEMA) return `the cross-version gate receipt is schema ${receipt.schema}, this dispatcher reads ${GATE_RECEIPT_SCHEMA} — ${rerun}`;
  if (receipt.outcome !== 'pass') return `the cross-version gate receipt records "${receipt.outcome}", not a pass — ${rerun}`;
  if (receipt.kitVersion !== kitVersion) return `the cross-version gate passed for kit ${receipt.kitVersion}, but ${kitVersion} is being published — ${rerun}`;
  if (receipt.headSha !== headSha) return `the cross-version gate passed at ${receipt.headSha}, but HEAD is ${headSha} — ${rerun}`;
  if (receipt.dirty !== false) return `the cross-version gate ran over a DIRTY tree, so what it probed is not what ${headSha} names — commit, then ${rerun}`;
  if (parseSemver(receipt.publishedVersion) === null) {
    return `the cross-version gate receipt carries a malformed probed published version ("${receipt.publishedVersion}") — no conditional arm can have been decided against it; ${rerun}`;
  }
  for (const axis of AXES) {
    const verdict = receipt.axes !== null && typeof receipt.axes === 'object' && !Array.isArray(receipt.axes) ? receipt.axes[axis] : undefined;
    if (verdict !== 'pass') return `the cross-version gate receipt does not record a PASS for the ${axis} axis (${verdict === undefined ? 'missing' : `"${verdict}"`}) — ${rerun}`;
  }
  return null;
};
