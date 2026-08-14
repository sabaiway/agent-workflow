// cross-version-axes.test.mjs — the PURE halves of the Issue-016 gate: the decided threshold,
// the axis fixtures, the three evaluators (both conditional arms each), and the receipt contract
// with its per-field refusal matrix. The CLI run and the hermetic packed-candidate case live in
// cross-version-gate.test.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_AWARE_SINCE, AXES, GATE_RECEIPT_SCHEMA, GATE_RECEIPT_BASENAME, EXECUTION_TEST_REL,
  parseSemver, isMarkerAware, markerFixtureGates, executionFixtureGates,
  evaluateSchemaAccept, evaluateExecution, evaluateProducerRecognition,
  buildGateReceipt, gateReceiptPath, readGateReceipt, crossVersionGateViolation,
} from './cross-version-axes.mjs';
import { validateDeclaration, LCOV_PRODUCER_KEY } from '../../agent-workflow-kit/tools/gates-declaration.mjs';
import { COVERAGE_PRODUCER_BODY, KNOWN_COVERAGE_FLAG_SETS } from '../../agent-workflow-kit/tools/coverage-producer.mjs';

describe('cross-version-axes — the threshold and its comparison', () => {
  it('MARKER_AWARE_SINCE is a plain semver triple — the arm is DECIDED against it, never inferred', () => {
    assert.notEqual(parseSemver(MARKER_AWARE_SINCE), null);
    assert.deepEqual(AXES, ['schema-accept', 'execution', 'producer-recognition']);
  });

  it('the comparison is NUMERIC per component — 5.10.0 is marker-aware even though it sorts below "5.7.0" as a string', () => {
    assert.equal(isMarkerAware('5.6.9'), false);
    assert.equal(isMarkerAware(MARKER_AWARE_SINCE), true, 'the shipping version itself is the FIRST marker-aware one');
    assert.equal(isMarkerAware('5.7.1'), true);
    assert.equal(isMarkerAware('6.0.0'), true);
    assert.equal(isMarkerAware('5.10.0'), true, 'lexicographic comparison would call this one unaware');
    assert.equal(parseSemver('latest'), null);
    assert.throws(() => isMarkerAware('latest'), /malformed/, 'a malformed version must never silently decide an arm');
  });
});

describe('cross-version-axes — the fixture declarations', () => {
  it('the marker fixture carries the ONE optional key over a runnable gate, and the CANDIDATE validator accepts it', () => {
    const gates = markerFixtureGates();
    assert.equal(gates[0][LCOV_PRODUCER_KEY], true);
    assert.doesNotMatch(gates[0].cmd, /[\r\n]/);
    assert.deepEqual(validateDeclaration({ gates }), gates, 'marker-aware by construction — the candidate accepts what the old kit must reject');
  });

  it('the execution fixture declares the NEW canonical producer cmd over the probe test file', () => {
    const gates = executionFixtureGates();
    assert.equal(gates.length, 1);
    assert.ok(gates[0].cmd.startsWith(COVERAGE_PRODUCER_BODY), 'the cmd IS the new emitted form — that is the axis');
    assert.ok(gates[0].cmd.endsWith(EXECUTION_TEST_REL));
    assert.deepEqual(validateDeclaration({ gates }), gates);
  });
});

describe('cross-version-axes — evaluateSchemaAccept, BOTH decided arms', () => {
  const NAMED = `docs/ai/gates.json: gates[0]: unknown key "${LCOV_PRODUCER_KEY}"`;

  it('marker-unaware arm: the loud exit-5 rejection NAMING the key is the only pass', () => {
    assert.deepEqual(evaluateSchemaAccept({ markerAware: false, exitCode: 5, output: NAMED }), []);
    assert.match(evaluateSchemaAccept({ markerAware: false, exitCode: 0, output: '' })[0], /schema-accept.*silent/i);
    assert.match(evaluateSchemaAccept({ markerAware: false, exitCode: 5, output: 'gates.json: rejected' })[0], new RegExp(`schema-accept.*${LCOV_PRODUCER_KEY}`), 'exit code alone is not a loud refusal');
    assert.match(evaluateSchemaAccept({ markerAware: false, exitCode: 3, output: '' })[0], /schema-accept.*exit 3/);
  });

  it('marker-aware arm: acceptance is the ASSERTION — a re-rejection is a regression, "retired" is only the label', () => {
    assert.deepEqual(evaluateSchemaAccept({ markerAware: true, exitCode: 0, output: 'all green' }), []);
    assert.match(evaluateSchemaAccept({ markerAware: true, exitCode: 5, output: NAMED })[0], /schema-accept.*regression/);
  });
});

describe('cross-version-axes — evaluateExecution', () => {
  it('exit 0 with the lcov under the runner-injected AW_GIT_DIR is the only pass', () => {
    assert.deepEqual(evaluateExecution({ exitCode: 0, lcovExists: true }), []);
    assert.match(evaluateExecution({ exitCode: 1, lcovExists: true })[0], /execution.*exit 1/);
    assert.match(evaluateExecution({ exitCode: 0, lcovExists: false })[0], /execution.*AW_GIT_DIR/);
  });
});

describe('cross-version-axes — evaluateProducerRecognition, BOTH decided arms', () => {
  const payload = (...variants) => JSON.stringify({ root: '/x', items: variants.map((variant) => ({ key: 'k', variant })), skips: [] });
  const allKnown = KNOWN_COVERAGE_FLAG_SETS.map((flags) => ({ flags, recognized: true }));

  it('the candidate half: a de-recognized prior form is a violation — the set is append-only', () => {
    const dropped = [{ flags: KNOWN_COVERAGE_FLAG_SETS[0], recognized: true }, { flags: 'old-flags', recognized: false }];
    assert.match(evaluateProducerRecognition({ markerAware: false, oldForms: dropped, advisorJsonText: payload('gates-inert') })[0], /producer-recognition.*append-only/);
  });

  it('the prior-form registry is INDEPENDENT literal bytes, byte-equal to the known set tail, and recognized (review F1)', async () => {
    // Dynamic import: the registry is the fold's new export — a static import would fail to LOAD
    // pre-fix and make the red unobservable (the red-proof authoring rule).
    const axes = await import('./cross-version-axes.mjs');
    assert.ok(Array.isArray(axes.PRIOR_PRODUCER_FLAG_SETS), 'a derived oldForms check is tautological — the registry must be independent literals');
    assert.deepEqual([...axes.PRIOR_PRODUCER_FLAG_SETS], KNOWN_COVERAGE_FLAG_SETS.slice(1), 'review F1 completeness check: every prior emitted form registered, none extra');
    for (const { flags, recognized } of axes.candidateOldFormRecognition()) {
      assert.equal(recognized, true, `a prior emitted form must stay recognized: ${flags}`);
    }
  });

  it('published half, old arm: the advisor MUST misread the new-form pair as inert (Issue-016 stated direction)', () => {
    assert.deepEqual(evaluateProducerRecognition({ markerAware: false, oldForms: allKnown, advisorJsonText: payload('gates-inert') }), []);
    assert.deepEqual(evaluateProducerRecognition({ markerAware: false, oldForms: allKnown, advisorJsonText: payload('gates-inert.producer-unrecognized') }), [], 'any inert-family variant is the misread');
    assert.match(evaluateProducerRecognition({ markerAware: false, oldForms: allKnown, advisorJsonText: payload('bridge-missing') })[0], /producer-recognition.*direction/);
  });

  it('published half, new arm: the pair is RECOGNIZED — any inert-family item is a regression', () => {
    assert.deepEqual(evaluateProducerRecognition({ markerAware: true, oldForms: allKnown, advisorJsonText: payload('bridge-missing') }), []);
    assert.match(evaluateProducerRecognition({ markerAware: true, oldForms: allKnown, advisorJsonText: payload('gates-inert') })[0], /producer-recognition.*inert/);
  });

  it('a payload with NO skips array BLOCKS the judgment in both arms — named, never a direction verdict (review F2)', () => {
    for (const markerAware of [false, true]) {
      const violations = evaluateProducerRecognition({ markerAware, oldForms: allKnown, advisorJsonText: JSON.stringify({ root: '/x', items: [] }) });
      assert.equal(violations.length, 1, `exactly the skips violation, markerAware=${markerAware}: ${violations.join(' | ')}`);
      assert.match(violations[0], /no skips array/);
    }
  });

  it('a SKIPPED gates probe BLOCKS the judgment in both arms, quoting the reason (review F2)', () => {
    const skipped = JSON.stringify({ root: '/x', items: [], skips: [{ key: 'gates-inert', reason: 'probe exploded' }] });
    for (const markerAware of [false, true]) {
      const violations = evaluateProducerRecognition({ markerAware, oldForms: allKnown, advisorJsonText: skipped });
      assert.equal(violations.length, 1, `exactly the skip violation, markerAware=${markerAware}: ${violations.join(' | ')}`);
      assert.match(violations[0], /SKIPPED its gates probe \(probe exploded\)/);
      assert.doesNotMatch(violations[0], /direction/);
    }
  });

  it('unparsable or item-less advisor JSON is a NAMED violation, never a thrown parse error', () => {
    assert.match(evaluateProducerRecognition({ markerAware: false, oldForms: allKnown, advisorJsonText: 'not json' })[0], /did not parse/);
    assert.match(evaluateProducerRecognition({ markerAware: false, oldForms: allKnown, advisorJsonText: '{"root":"/x"}' })[0], /no items array/);
  });

  it('a null entry in a well-formed items array never throws — it simply carries no variant (review F5)', () => {
    const withNull = JSON.stringify({ root: '/x', items: [null, { key: 'k', variant: 'gates-inert' }], skips: [] });
    assert.deepEqual(evaluateProducerRecognition({ markerAware: false, oldForms: allKnown, advisorJsonText: withNull }), [], 'the real item beside the null still decides the arm');
    const onlyNull = JSON.stringify({ root: '/x', items: [null], skips: [] });
    const violations = evaluateProducerRecognition({ markerAware: false, oldForms: allKnown, advisorJsonText: onlyNull });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /direction/, 'a variant-less item is NOT inert — the named judgment still runs');
  });
});

describe('cross-version-axes — the receipt and the refusal it feeds', () => {
  const PASSING = { kitVersion: '9.9.8', headSha: 'abc123', dirty: false, publishedVersion: '5.6.0', at: '2026-08-14T00:00:00.000Z' };
  const covering = (over = {}) => ({ ...buildGateReceipt(PASSING), ...over });

  it('the receipt carries the FULL contract — schema, outcome, the triple, dirty, and one verdict per axis', () => {
    assert.deepEqual(buildGateReceipt(PASSING), {
      schema: GATE_RECEIPT_SCHEMA, outcome: 'pass', kitVersion: '9.9.8', headSha: 'abc123',
      dirty: false, publishedVersion: '5.6.0',
      axes: { 'schema-accept': 'pass', execution: 'pass', 'producer-recognition': 'pass' },
      at: '2026-08-14T00:00:00.000Z',
    });
  });

  it('a receipt round-trips through the git dir, and an unreadable one reads as ABSENT', () => {
    const files = { [gateReceiptPath('/g')]: JSON.stringify(covering()) };
    const read = (path) => {
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[path];
    };
    assert.deepEqual(readGateReceipt('/g', read), covering());
    assert.equal(readGateReceipt('/absent', read), null);
    assert.equal(readGateReceipt('/g', () => '{ not json'), null);
    assert.equal(readGateReceipt('/g', () => '[]'), null);
    assert.ok(gateReceiptPath('/g').endsWith(GATE_RECEIPT_BASENAME));
  });

  it('a receipt covering the exact candidate is the ONE state that clears a dispatch', () => {
    assert.equal(crossVersionGateViolation({ receipt: covering(), kitVersion: '9.9.8', headSha: 'abc123' }), null);
    assert.equal(crossVersionGateViolation({ receipt: covering({ publishedVersion: '9.9.9' }), kitVersion: '9.9.8', headSha: 'abc123' }), null, 'the published version is validated for FORM — its value is the probe result, not a pin');
  });

  it('EVERY field has a refusal, each naming what it found and the command that clears it', () => {
    const rows = [
      [{ receipt: null }, /no cross-version gate receipt/],
      [{ receipt: covering({ schema: GATE_RECEIPT_SCHEMA + 1 }) }, /schema/],
      [{ receipt: covering({ outcome: 'fail' }) }, /not a pass/],
      [{ receipt: covering({ kitVersion: '1.0.0' }) }, /passed for kit 1\.0\.0/],
      [{ receipt: covering({ headSha: 'deadbee' }) }, /passed at deadbee/],
      [{ receipt: covering({ dirty: true }) }, /DIRTY tree/],
      [{ receipt: covering({ publishedVersion: 'latest' }) }, /malformed.*published/i],
      [{ receipt: covering({ publishedVersion: undefined }) }, /malformed.*published/i],
      [{ receipt: covering({ axes: undefined }) }, /schema-accept/],
      [{ receipt: covering({ axes: { 'schema-accept': 'pass', execution: 'pass' } }) }, /producer-recognition.*missing/],
      [{ receipt: covering({ axes: { 'schema-accept': 'pass', execution: 'fail', 'producer-recognition': 'pass' } }) }, /execution.*"fail"/],
    ];
    for (const [override, expected] of rows) {
      const violation = crossVersionGateViolation({ kitVersion: '9.9.8', headSha: 'abc123', ...override });
      assert.match(violation ?? '', expected);
      assert.match(violation ?? '', /cross-version-gate\.mjs/, 'every refusal carries the re-run command');
    }
  });
});
