import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_KINDS,
  DELEGATION_KEY_SETS,
  RETURN_OUTCOMES,
  TERMINAL_RETURN_OUTCOMES,
  NON_TERMINAL_RETURN_OUTCOMES,
  SESSION_ID_NULLABLE_OUTCOMES,
  ALLOWED_TRANSITIONS,
  STEP_CLASSES,
  METRIC_PROVENANCE,
  OBSERVATION_PROVENANCE,
  INELIGIBLE_REASONS,
  METRIC_COMPONENT_KINDS,
  EXEC_COMPONENT_KINDS,
  ENUMERATED_COMPONENT_KINDS,
  RETURN_PROVENANCE,
  NUMERATOR_RULES,
  CONTRACT_INFO_STRING,
  CONTRACT_KEYS,
  BUNDLE_FRAMING_HEADER,
  validateDelegationRecord,
  delegationCanonicalSerialization,
  canonicalDelegationDigest,
  allowedSuccessorKinds,
  isThreadTerminalRecord,
  extractContractBlock,
  parseDispatchContract,
  checkDispatchContractForm,
  contractDigest,
  checkDispatchMintConsistency,
  normalizeByteRanges,
  computeNumerator,
  frameIntegrationBundle,
  parseIntegrationBundle,
  expectedBundleLength,
  evaluateMetricEligibility,
  evaluateObservationEligibility,
} from './dispatch-record.mjs';
import { canonicalKindSerialization } from './core-evidence.mjs';

const TS = '2026-08-07T00:00:00.000Z';
const D = (pair) => pair.repeat(32);
const WAVE = 'delegation-series-acceptance';

// The D6 framing arithmetic for the fixture pair (diff 30 bytes, report 20 bytes) — computed here
// from the framing rule itself so the record fixture and the framing test cannot drift apart.
const DIFF_LENGTH = 30;
const REPORT_LENGTH = 20;
const FIXTURE_BUNDLE_LENGTH = BUNDLE_FRAMING_HEADER.length
  + String(DIFF_LENGTH).length + 1 + DIFF_LENGTH
  + String(REPORT_LENGTH).length + 1 + REPORT_LENGTH;

const VEHICLE = { requested: 'codex-exec', selected: 'codex-exec' };
const POSTURE = { model: 'gpt-5-codex', effort: 'high', tier: 'priority' };

const RETURN_COMPONENTS = [
  { kind: 'new', path: 'agent-workflow-kit/tools/dispatch-record.mjs', objectId: 'obj-record', bytes: 40 },
  { kind: 'modified', path: 'agent-workflow-kit/test/package-content.test.mjs', objectId: 'obj-pins', bytes: 60 },
];

const RETURN_METRIC = {
  numeratorBytes: 100,
  denominatorBytes: FIXTURE_BUNDLE_LENGTH,
  components: RETURN_COMPONENTS,
  provenance: 'wrapper-git',
  eligible: true,
  ineligibleReason: null,
};

const RECORDS = {
  'pre-registration': {
    schema: 1,
    kind: 'pre-registration',
    waveId: WAVE,
    stepClasses: ['code'],
    pairingKey: 'stepClass',
    minPerClass: 3,
    meanLThreshold: 2,
    firstPassNum: 2,
    firstPassDen: 3,
    timestamp: TS,
  },
  dispatch: {
    schema: 1,
    kind: 'dispatch',
    waveId: WAVE,
    nonce: 'n-1',
    stepClass: 'code',
    vehicle: VEHICLE,
    backend: 'codex',
    contractDigest: D('1a'),
    preTreeDigest: D('2b'),
    baselineClean: true,
    deadlineS: 1800,
    retryOf: null,
    retryIndex: 0,
    retryCap: 2,
    rationale: 'bounded vocabulary module; the diff is git-provable',
    timestamp: TS,
  },
  return: {
    schema: 1,
    kind: 'return',
    role: 'execute',
    backend: 'codex',
    nonce: 'n-1',
    contractDigest: D('1a'),
    preTreeDigest: D('2b'),
    postTreeDigest: D('3c'),
    diffDigest: D('4d'),
    diffLength: DIFF_LENGTH,
    reportDigest: D('5e'),
    reportLength: REPORT_LENGTH,
    bundleDigest: D('6f'),
    bundleLength: FIXTURE_BUNDLE_LENGTH,
    metric: RETURN_METRIC,
    outcome: 'success',
    exitStatus: 0,
    sessionId: 'sess-01',
    wrapperVersion: '3.3.0',
    posture: POSTURE,
    timestamp: TS,
  },
  fold: {
    schema: 1,
    kind: 'fold',
    nonce: 'n-1',
    returnDigest: D('7a'),
    treeDigestAtFold: D('3c'),
    verdict: 'integrated after the configured council',
    timestamp: TS,
  },
  observation: {
    schema: 1,
    kind: 'observation',
    waveId: WAVE,
    stepClass: 'code',
    scope: 'agent-workflow-kit/tools/dispatch-record.mjs',
    metric: {
      numeratorBytes: 100,
      denominatorBytes: 100,
      components: [{ kind: 'new', path: 'agent-workflow-kit/tools/dispatch-record.mjs', objectId: 'obj-record', bytes: 100 }],
      provenance: 'solo-construction',
      eligible: true,
      ineligibleReason: null,
    },
    planId: 'delegation-1-contract-ledger-baseline',
    phase: 1,
    timestamp: TS,
  },
  degrade: {
    schema: 1,
    kind: 'degrade',
    waveId: WAVE,
    nonce: 'n-1',
    stepClass: 'code',
    rationale: 'the backend never returned; the thread closes without a fold',
    timestamp: TS,
  },
};

const record = (kind, over = {}) => ({ ...RECORDS[kind], ...over });
const returnWith = (over = {}) => record('return', over);
const metricWith = (over = {}) => ({ ...RETURN_METRIC, ...over });

// An INDEPENDENT canonical serializer (recursively key-sorted JSON, no trailing newline). The
// module's digest is cross-checked against sha256 over THESE bytes, so the pin is not circular.
const independentCanonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(independentCanonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${independentCanonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const independentDigest = (v) => createHash('sha256').update(independentCanonical(v), 'utf8').digest('hex');

const CONTRACT = {
  schema: 1,
  nonce: 'n-1',
  stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'agent-workflow-kit/tools/dispatch-record.mjs',
  inputs: 'the plan D3 key sets and the D4 outcome enum',
  acceptance: 'node --test agent-workflow-kit/tools/dispatch-record.test.mjs green',
  returnShape: 'a unified diff plus a prose report',
  producerContract: 'codex-exec 3.3.0',
  deadlineS: 1800,
  retry: { cap: 2, index: 0 },
};

const contractFile = (body, { fence = CONTRACT_INFO_STRING } = {}) =>
  ['# Sub-task brief', '', `\`\`\`${fence}`, body, '```', '', 'Prose after the block.', ''].join('\n');
const CONTRACT_FILE = contractFile(JSON.stringify(CONTRACT, null, 2));

describe('dispatch-record — the closed delegation vocabulary (Plan 1 Phase 1)', () => {
  it('AC01 closed vocabulary: unknown schema, kind, field, and missing field each refuse by name, for every kind', () => {
    assert.equal(DELEGATION_SCHEMA_VERSION, 1);
    assert.deepEqual(
      [...DELEGATION_KINDS],
      ['pre-registration', 'dispatch', 'return', 'fold', 'observation', 'degrade'],
      'the D3 kind set is closed and ordered as the plan fixture states',
    );
    assert.deepEqual(Object.keys(DELEGATION_KEY_SETS).sort(), [...DELEGATION_KINDS].sort(), 'every kind carries a closed key set');

    const unknownKind = validateDelegationRecord({ ...RECORDS.fold, kind: 'exec-receipt' });
    assert.equal(unknownKind.ok, false);
    assert.match(unknownKind.reason, /unknown kind/);
    assert.match(unknownKind.reason, /"exec-receipt"/);

    for (const kind of DELEGATION_KINDS) {
      const full = record(kind);
      assert.deepEqual(validateDelegationRecord(full), { ok: true }, `${kind}: the full fixture validates`);
      assert.deepEqual(
        Object.keys(full).sort(),
        ['schema', 'kind', ...DELEGATION_KEY_SETS[kind]].sort(),
        `${kind}: the fixture carries exactly the closed key set`,
      );

      const badSchema = validateDelegationRecord({ ...full, schema: 2 });
      assert.equal(badSchema.ok, false, `${kind}: an unknown schema refuses`);
      assert.match(badSchema.reason, /unknown schema/);

      const extra = validateDelegationRecord({ ...full, sessionCost: 3 });
      assert.equal(extra.ok, false, `${kind}: an unknown extra field refuses`);
      assert.match(extra.reason, /"sessionCost"/);

      for (const field of DELEGATION_KEY_SETS[kind]) {
        const missing = { ...full };
        delete missing[field];
        const res = validateDelegationRecord(missing);
        assert.equal(res.ok, false, `${kind}: a missing "${field}" refuses`);
        assert.match(res.reason, new RegExp(`"${field}"`), `${kind}: the refusal names the missing field`);
      }
    }

    // Presence is own-ENUMERABLE only: the canonical serialization walks Object.keys, so a field
    // reachable any other way would validate while never entering the digest that IS identity.
    const viaPrototype = { ...RECORDS.fold };
    delete viaPrototype.timestamp;
    const inherited = validateDelegationRecord(Object.assign(Object.create({ timestamp: TS }), viaPrototype));
    assert.equal(inherited.ok, false, 'a required field reachable only through the prototype refuses');
    assert.match(inherited.reason, /"timestamp"/);

    const hidden = { ...RECORDS.fold };
    delete hidden.verdict;
    Object.defineProperty(hidden, 'verdict', { value: 'hidden', enumerable: false, configurable: true });
    const nonEnumerable = validateDelegationRecord(hidden);
    assert.equal(nonEnumerable.ok, false, 'a NON-ENUMERABLE own field refuses — the digest would omit it');
    assert.match(nonEnumerable.reason, /"verdict"/);

    // The rule binds the two IDENTIFYING fields too, and before their values are read — otherwise
    // the record that names the schema and the kind is not the record the digest covers.
    for (const field of ['schema', 'kind']) {
      const viaProto = { ...RECORDS.fold };
      const inheritedValue = viaProto[field];
      delete viaProto[field];
      const throughPrototype = validateDelegationRecord(Object.assign(Object.create({ [field]: inheritedValue }), viaProto));
      assert.equal(throughPrototype.ok, false, `${field} reachable only through the prototype refuses`);
      assert.match(throughPrototype.reason, new RegExp(`"${field}"`));

      const hiddenIdentity = { ...RECORDS.fold };
      delete hiddenIdentity[field];
      Object.defineProperty(hiddenIdentity, field, { value: inheritedValue, enumerable: false, configurable: true });
      const nonEnumerableIdentity = validateDelegationRecord(hiddenIdentity);
      assert.equal(nonEnumerableIdentity.ok, false, `a non-enumerable own ${field} refuses`);
      assert.match(nonEnumerableIdentity.reason, new RegExp(`"${field}"`));
    }

    // An accessor is an identity fork waiting to happen: the canonical serialization reads the
    // property a SECOND time, so a getter can answer the validator one way and the digest another.
    const accessor = { ...RECORDS.fold };
    delete accessor.verdict;
    Object.defineProperty(accessor, 'verdict', { get: () => 'computed', enumerable: true, configurable: true });
    const viaAccessor = validateDelegationRecord(accessor);
    assert.equal(viaAccessor.ok, false, 'an accessor field refuses — the digest could read a different value');
    assert.match(viaAccessor.reason, /"verdict"/);

    const throwing = { ...RECORDS.fold };
    delete throwing.verdict;
    Object.defineProperty(throwing, 'verdict', {
      get: () => { throw new Error('hostile'); },
      enumerable: true,
      configurable: true,
    });
    const viaThrowing = validateDelegationRecord(throwing);
    assert.equal(viaThrowing.ok, false, 'a THROWING getter refuses rather than propagating out of the validator');
    assert.match(viaThrowing.reason, /"verdict"/);

    const accessorIdentity = { ...RECORDS.fold };
    delete accessorIdentity.kind;
    Object.defineProperty(accessorIdentity, 'kind', { get: () => 'fold', enumerable: true, configurable: true });
    const viaAccessorIdentity = validateDelegationRecord(accessorIdentity);
    assert.equal(viaAccessorIdentity.ok, false, 'the identifying fields are data properties too');
    assert.match(viaAccessorIdentity.reason, /"kind"/);

    // The refusal formatter must never THROW: the store preflight calls the validator on untrusted
    // input, so a value JSON cannot serialize has to come back as a refusal, not an exception.
    const withBigInt = validateDelegationRecord({ ...RECORDS.fold, verdict: 1n });
    assert.equal(withBigInt.ok, false, 'a BigInt field refuses instead of throwing');
    assert.match(withBigInt.reason, /verdict/);
    const circular = { ...RECORDS.fold, verdict: {} };
    circular.verdict.self = circular.verdict;
    const withCircular = validateDelegationRecord(circular);
    assert.equal(withCircular.ok, false, 'a circular field refuses instead of throwing');
    assert.match(withCircular.reason, /verdict/);

    assert.equal(validateDelegationRecord(null).ok, false, 'a non-object refuses');
    assert.equal(validateDelegationRecord([RECORDS.fold]).ok, false, 'an array refuses');
  });

  it('AC02 outcome enum is closed and the shipped successor table equals the D4 fixture, terminality included', () => {
    assert.deepEqual(
      [...RETURN_OUTCOMES],
      ['success', 'transport-failure', 'contract-refusal', 'store-failure', 'missing-identity', 'partial-edit', 'acceptance-failure', 'stale-return'],
      'the D4 outcome enum is closed',
    );
    assert.deepEqual([...NON_TERMINAL_RETURN_OUTCOMES], ['success', 'acceptance-failure']);
    assert.deepEqual(
      [...TERMINAL_RETURN_OUTCOMES].sort(),
      ['contract-refusal', 'missing-identity', 'partial-edit', 'stale-return', 'store-failure', 'transport-failure'],
      'every non-{success, acceptance-failure} outcome is thread-terminal',
    );
    assert.deepEqual(
      [...TERMINAL_RETURN_OUTCOMES, ...NON_TERMINAL_RETURN_OUTCOMES].sort(),
      [...RETURN_OUTCOMES].sort(),
      'the terminality split partitions the enum exactly',
    );

    assert.deepEqual(JSON.parse(JSON.stringify(ALLOWED_TRANSITIONS)), {
      dispatch: ['return', 'degrade'],
      return: {
        success: ['fold', 'degrade'],
        'acceptance-failure': ['fold', 'degrade'],
        'transport-failure': [],
        'contract-refusal': [],
        'store-failure': [],
        'missing-identity': [],
        'partial-edit': [],
        'stale-return': [],
      },
      fold: [],
      degrade: [],
    }, 'the shipped table equals the D4 literal fixture');
    assert.ok(Object.isFrozen(ALLOWED_TRANSITIONS), 'the table is an exported FROZEN structure');
    assert.ok(Object.isFrozen(ALLOWED_TRANSITIONS.return), 'the nested outcome map is frozen too');

    assert.deepEqual(allowedSuccessorKinds(RECORDS.dispatch), ['return', 'degrade']);
    assert.deepEqual(allowedSuccessorKinds(returnWith()), ['fold', 'degrade']);
    assert.deepEqual(allowedSuccessorKinds(returnWith({ outcome: 'acceptance-failure' })), ['fold', 'degrade']);
    assert.deepEqual(allowedSuccessorKinds(returnWith({ outcome: 'transport-failure', sessionId: null })), []);
    assert.deepEqual(allowedSuccessorKinds(RECORDS.fold), []);
    assert.deepEqual(allowedSuccessorKinds(RECORDS.degrade), []);

    assert.equal(isThreadTerminalRecord(RECORDS.dispatch), false);
    assert.equal(isThreadTerminalRecord(returnWith()), false, 'a success return is NON-terminal until fold or degrade');
    assert.equal(isThreadTerminalRecord(returnWith({ outcome: 'acceptance-failure' })), false);
    assert.equal(isThreadTerminalRecord(returnWith({ outcome: 'stale-return', sessionId: null })), true);
    assert.equal(isThreadTerminalRecord(returnWith({ outcome: 'partial-edit' })), true);
    assert.equal(isThreadTerminalRecord(RECORDS.fold), true);
    assert.equal(isThreadTerminalRecord(RECORDS.degrade), true);

    const badOutcome = validateDelegationRecord(returnWith({ outcome: 'timeout' }));
    assert.equal(badOutcome.ok, false);
    assert.match(badOutcome.reason, /outcome/);
    assert.match(badOutcome.reason, /"timeout"/);
  });

  it('AC03 a return with nonzero exitStatus and outcome success refuses', () => {
    const res = validateDelegationRecord(returnWith({ exitStatus: 1 }));
    assert.equal(res.ok, false);
    assert.match(res.reason, /exitStatus/);
    assert.match(res.reason, /success/);
    assert.deepEqual(validateDelegationRecord(returnWith({ exitStatus: 0 })), { ok: true });
    assert.deepEqual(
      validateDelegationRecord(returnWith({ exitStatus: 1, outcome: 'acceptance-failure' })),
      { ok: true },
      'a nonzero exit on a non-success outcome is ordinary',
    );
    assert.equal(validateDelegationRecord(returnWith({ exitStatus: -1 })).ok, false, 'a negative exit status refuses');
  });

  it('AC04 sessionId nullability follows the D4 outcome set and a success return with null sessionId refuses', () => {
    assert.deepEqual(
      [...SESSION_ID_NULLABLE_OUTCOMES].sort(),
      ['contract-refusal', 'missing-identity', 'store-failure', 'transport-failure'],
      'the nullable-outcome set is exactly the D4 four',
    );
    const nullSuccess = validateDelegationRecord(returnWith({ sessionId: null }));
    assert.equal(nullSuccess.ok, false);
    assert.match(nullSuccess.reason, /sessionId/);
    for (const outcome of RETURN_OUTCOMES) {
      const exitStatus = outcome === 'success' ? 0 : 1;
      const withNull = validateDelegationRecord(returnWith({ outcome, exitStatus, sessionId: null }));
      assert.equal(
        withNull.ok,
        SESSION_ID_NULLABLE_OUTCOMES.includes(outcome),
        `${outcome}: a null sessionId is legal exactly for the D4 nullable set`,
      );
      assert.deepEqual(
        validateDelegationRecord(returnWith({ outcome, exitStatus, sessionId: 'sess-01' })),
        { ok: true },
        `${outcome}: a non-null sessionId is always legal`,
      );
    }
  });

  it('AC05 canonical serialization parity with core: single-record bytes equal, core adds only the framing newline', () => {
    const coreDegrade = { schema: 1, kind: 'degrade', backend: 'backend-a', reason: 'offline for the run', fingerprint: D('a1'), timestamp: TS };
    const coreBytes = canonicalKindSerialization([coreDegrade], 'degrade');
    const ourBytes = delegationCanonicalSerialization(coreDegrade);
    assert.notEqual(coreBytes, '', 'the core side is non-vacuous');
    assert.notEqual(ourBytes, '', 'the delegation side is non-vacuous');
    assert.ok(!ourBytes.endsWith('\n'), 'the single-record serialization carries NO trailing newline');
    assert.equal(coreBytes, `${ourBytes}\n`, 'core adds only the per-line framing newline');

    const rec = record('return');
    const permuted = Object.fromEntries(Object.entries(rec).reverse());
    permuted.metric = Object.fromEntries(Object.entries(rec.metric).reverse());
    assert.notDeepEqual(Object.keys(permuted), Object.keys(rec), 'the fixture genuinely reorders keys');
    assert.equal(canonicalDelegationDigest(permuted), canonicalDelegationDigest(rec), 'the digest is byte-layout independent');
    assert.match(canonicalDelegationDigest(rec), /^[0-9a-f]{64}$/);
    assert.equal(canonicalDelegationDigest(rec), independentDigest(rec), 'the digest is sha256 over exactly the canonical bytes');
    assert.notEqual(
      canonicalDelegationDigest(rec),
      canonicalDelegationDigest({ ...rec, nonce: 'n-2' }),
      'a differing record digests differently',
    );
  });

  it('AC06 exec-return: the full fixture validates and each removed or extra field refuses by name', () => {
    assert.deepEqual(validateDelegationRecord(record('return')), { ok: true });
    assert.deepEqual(
      [...DELEGATION_KEY_SETS.return].sort(),
      ['role', 'backend', 'nonce', 'contractDigest', 'preTreeDigest', 'postTreeDigest', 'diffDigest', 'diffLength',
        'reportDigest', 'reportLength', 'bundleDigest', 'bundleLength', 'metric', 'outcome', 'exitStatus',
        'sessionId', 'wrapperVersion', 'posture', 'timestamp'].sort(),
      'the return key set is the D3 literal fixture',
    );
    for (const field of DELEGATION_KEY_SETS.return) {
      const missing = record('return');
      delete missing[field];
      const res = validateDelegationRecord(missing);
      assert.equal(res.ok, false, `a return missing "${field}" refuses`);
      assert.match(res.reason, new RegExp(`"${field}"`));
    }
    const extra = validateDelegationRecord(returnWith({ tokensSpent: 12 }));
    assert.equal(extra.ok, false);
    assert.match(extra.reason, /"tokensSpent"/);

    for (const field of ['contractDigest', 'preTreeDigest', 'postTreeDigest', 'diffDigest', 'reportDigest', 'bundleDigest']) {
      const res = validateDelegationRecord(returnWith({ [field]: 'not-a-digest' }));
      assert.equal(res.ok, false, `${field} must be a 64-hex digest`);
      assert.match(res.reason, new RegExp(field));
    }
    assert.equal(validateDelegationRecord(returnWith({ nonce: 'a nonce with spaces' })).ok, false, 'the nonce rides the safe grammar');
    assert.equal(validateDelegationRecord(returnWith({ timestamp: '2026-08-07' })).ok, false, 'the timestamp must be a canonical instant');
  });

  it('AC07 nested forms are closed and the cross-field equalities hold', () => {
    assert.deepEqual([...METRIC_COMPONENT_KINDS].sort(), Object.keys(NUMERATOR_RULES).sort(), 'the component kinds and the D6 rule table agree');

    const roleRes = validateDelegationRecord(returnWith({ role: 'review' }));
    assert.equal(roleRes.ok, false, 'role is fixed to execute');
    assert.match(roleRes.reason, /role/);

    for (const [field, value] of [['posture', POSTURE], ['vehicle', VEHICLE]]) {
      const host = field === 'posture' ? returnWith.bind(null) : (over) => record('dispatch', over);
      const strayed = host({ [field]: { ...value, lane: 'x' } });
      const res = validateDelegationRecord(strayed);
      assert.equal(res.ok, false, `${field} is a CLOSED nested form`);
      assert.match(res.reason, /"lane"/);
      const shortened = { ...value };
      delete shortened[Object.keys(value)[0]];
      assert.equal(validateDelegationRecord(host({ [field]: shortened })).ok, false, `${field} refuses a missing member`);
    }

    const strayComponent = validateDelegationRecord(returnWith({
      metric: metricWith({ components: [{ ...RETURN_COMPONENTS[0], note: 'x' }, RETURN_COMPONENTS[1]] }),
    }));
    assert.equal(strayComponent.ok, false, 'a metric component is a CLOSED nested form');
    assert.match(strayComponent.reason, /"note"/);
    const badComponentKind = validateDelegationRecord(returnWith({
      metric: metricWith({ components: [{ kind: 'moved', path: 'a', objectId: 'obj-a', bytes: 100 }] }),
    }));
    assert.equal(badComponentKind.ok, false, 'a component kind outside the D6 table refuses');
    assert.match(badComponentKind.reason, /"moved"/);

    // A component names the OBJECT whose bytes it counted — the identity the numerator deduped by,
    // so the record carries the key rather than leaving it to be re-derived from names.
    const withoutIdentity = { ...RETURN_COMPONENTS[0] };
    delete withoutIdentity.objectId;
    const missingIdentity = validateDelegationRecord(returnWith({
      metric: metricWith({ components: [withoutIdentity, RETURN_COMPONENTS[1]] }),
    }));
    assert.equal(missingIdentity.ok, false, 'a component without its object identity refuses');
    assert.match(missingIdentity.reason, /"objectId"/);
    assert.equal(
      validateDelegationRecord(returnWith({
        metric: metricWith({ numeratorBytes: 40, components: [{ kind: 'gate-output', path: null, objectId: 'obj-x', bytes: 40 }] }),
      })).ok,
      false,
      'gate output names no object, so its objectId is null',
    );
    assert.deepEqual(
      validateDelegationRecord(returnWith({
        metric: metricWith({ numeratorBytes: 40, components: [{ kind: 'gate-output', path: null, objectId: null, bytes: 40 }] }),
      })),
      { ok: true },
      'a gate-output component with a null objectId validates',
    );
    assert.equal(
      validateDelegationRecord(returnWith({
        metric: metricWith({ numeratorBytes: 40, components: [{ kind: 'gate-output', path: 'x', objectId: null, bytes: 40 }] }),
      })).ok,
      false,
      'gate output names no path either',
    );

    // A SPARSE array is not a closed set: Array.prototype.every SKIPS holes, so the membership
    // check would never see the missing element.
    const sparseComponents = [];
    sparseComponents[1] = RETURN_COMPONENTS[1];
    assert.equal(
      validateDelegationRecord(returnWith({ metric: metricWith({ numeratorBytes: 60, components: sparseComponents }) })).ok,
      false,
      'a sparse component array refuses',
    );

    const strayObservationMetric = validateDelegationRecord(record('observation', {
      metric: { ...RECORDS.observation.metric, lane: 'x' },
    }));
    assert.equal(strayObservationMetric.ok, false, 'observation.metric is the same CLOSED nested form');
    assert.match(strayObservationMetric.reason, /"lane"/);

    const sumMismatch = validateDelegationRecord(returnWith({ metric: metricWith({ numeratorBytes: 101 }) }));
    assert.equal(sumMismatch.ok, false, 'the components sum must equal numeratorBytes');
    assert.match(sumMismatch.reason, /numeratorBytes/);

    const bundleMismatch = validateDelegationRecord(returnWith({ bundleLength: FIXTURE_BUNDLE_LENGTH + 1 }));
    assert.equal(bundleMismatch.ok, false, 'bundleLength must equal the framing of diffLength and reportLength');
    assert.match(bundleMismatch.reason, /bundleLength/);
    assert.equal(expectedBundleLength(DIFF_LENGTH, REPORT_LENGTH), FIXTURE_BUNDLE_LENGTH);

    const denominatorMismatch = validateDelegationRecord(returnWith({ metric: metricWith({ denominatorBytes: FIXTURE_BUNDLE_LENGTH - 1 }) }));
    assert.equal(denominatorMismatch.ok, false, 'the denominator IS the integration bundle');
    assert.match(denominatorMismatch.reason, /denominatorBytes/);

    const eligibleWithReason = validateDelegationRecord(returnWith({ metric: metricWith({ ineligibleReason: 'no-op-diff' }) }));
    assert.equal(eligibleWithReason.ok, false, 'an eligible metric carries no reason');
    const ineligibleWithoutReason = validateDelegationRecord(returnWith({ metric: metricWith({ eligible: false }) }));
    assert.equal(ineligibleWithoutReason.ok, false, 'an ineligible metric names its reason');
    assert.match(ineligibleWithoutReason.reason, /ineligibleReason/);

    // Byte counts are compared for EXACT equality, so a total leaving the safe-integer range can no
    // longer be compared at all — it refuses instead of silently agreeing.
    const half = 2 ** 52;
    const unsafeSum = validateDelegationRecord(returnWith({
      metric: metricWith({
        numeratorBytes: half,
        components: [{ kind: 'new', path: 'a.mjs', objectId: 'obj-a', bytes: half }, { kind: 'new', path: 'b.mjs', objectId: 'obj-b', bytes: half }],
      }),
    }));
    assert.equal(unsafeSum.ok, false, 'a component sum leaving the safe-integer range refuses');
    assert.match(unsafeSum.reason, /safe/);

    // A return's OWN fields decide its eligibility; the store's dirty-baseline is the one admissible
    // override, and it may only ever make the verdict stricter.
    const noOpBundle = expectedBundleLength(0, REPORT_LENGTH);
    const claimsEligible = validateDelegationRecord(returnWith({
      diffLength: 0,
      bundleLength: noOpBundle,
      metric: metricWith({ denominatorBytes: noOpBundle }),
    }));
    assert.equal(claimsEligible.ok, false, 'a no-op diff can never claim an eligible metric');
    assert.match(claimsEligible.reason, /no-op-diff/);
    assert.deepEqual(
      validateDelegationRecord(returnWith({
        diffLength: 0,
        bundleLength: noOpBundle,
        metric: metricWith({ denominatorBytes: noOpBundle, eligible: false, ineligibleReason: 'no-op-diff' }),
      })),
      { ok: true },
      'the locally computed reason validates',
    );
    assert.deepEqual(
      validateDelegationRecord(returnWith({ metric: metricWith({ eligible: false, ineligibleReason: 'dirty-baseline' }) })),
      { ok: true },
      'dirty-baseline is the one admissible store-side override',
    );
    const wrongReason = validateDelegationRecord(returnWith({ metric: metricWith({ eligible: false, ineligibleReason: 'empty-report' }) }));
    assert.equal(wrongReason.ok, false, 'an ineligibility this return cannot substantiate refuses');
    const contradictoryReason = validateDelegationRecord(returnWith({
      diffLength: 0,
      bundleLength: noOpBundle,
      metric: metricWith({ denominatorBytes: noOpBundle, eligible: false, ineligibleReason: 'empty-report' }),
    }));
    assert.equal(contradictoryReason.ok, false, 'a reason that CONTRADICTS the locally computed one refuses');
    assert.deepEqual(
      validateDelegationRecord(returnWith({
        diffLength: 0,
        bundleLength: noOpBundle,
        metric: metricWith({ denominatorBytes: noOpBundle, eligible: false, ineligibleReason: 'dirty-baseline' }),
      })),
      { ok: true },
      'dirty-baseline may stand in for a locally named reason — it is the stricter store verdict',
    );
  });

  it('AC08 contract form: the D8 fixture passes and each violation refuses by name while a well-formed absurdity passes', () => {
    assert.equal(CONTRACT_INFO_STRING, 'aw-dispatch-contract');
    assert.deepEqual(
      [...CONTRACT_KEYS].sort(),
      ['schema', 'nonce', 'stepClass', 'vehicle', 'scope', 'inputs', 'acceptance', 'returnShape', 'producerContract', 'deadlineS', 'retry'].sort(),
      'the D8 header key set is closed',
    );

    const parsed = parseDispatchContract(CONTRACT_FILE);
    assert.equal(parsed.ok, true, parsed.reason);
    assert.deepEqual(parsed.contract, CONTRACT);
    assert.deepEqual(checkDispatchContractForm(CONTRACT_FILE).ok, true);

    const absent = checkDispatchContractForm('# Sub-task brief\n\nNo fenced block here.\n');
    assert.equal(absent.ok, false);
    assert.match(absent.reason, /aw-dispatch-contract/);
    assert.match(absent.reason, /no|absent|missing/i);

    const duplicated = checkDispatchContractForm(`${CONTRACT_FILE}\n${CONTRACT_FILE}`);
    assert.equal(duplicated.ok, false);
    assert.match(duplicated.reason, /one|single|duplicate/i);

    assert.equal(checkDispatchContractForm(contractFile('{ not json')).ok, false, 'a non-JSON body refuses');
    assert.equal(checkDispatchContractForm(contractFile('[1, 2]')).ok, false, 'a non-object body refuses');
    assert.equal(
      checkDispatchContractForm(contractFile(JSON.stringify(CONTRACT), { fence: 'json' })).ok,
      false,
      'only the aw-dispatch-contract info string carries the header',
    );

    for (const field of CONTRACT_KEYS) {
      const missing = { ...CONTRACT };
      delete missing[field];
      const res = checkDispatchContractForm(contractFile(JSON.stringify(missing)));
      assert.equal(res.ok, false, `a header missing "${field}" refuses`);
      assert.match(res.reason, new RegExp(`"${field}"`), 'the refusal names the first violated field');
    }
    const strayField = checkDispatchContractForm(contractFile(JSON.stringify({ ...CONTRACT, owner: 'me' })));
    assert.equal(strayField.ok, false);
    assert.match(strayField.reason, /"owner"/);

    const badNonce = checkDispatchContractForm(contractFile(JSON.stringify({ ...CONTRACT, nonce: 'nonce with spaces' })));
    assert.equal(badNonce.ok, false);
    assert.match(badNonce.reason, /"nonce"/);
    const badClass = checkDispatchContractForm(contractFile(JSON.stringify({ ...CONTRACT, stepClass: 'refactor' })));
    assert.equal(badClass.ok, false);
    assert.match(badClass.reason, /"stepClass"/);
    const badRetry = checkDispatchContractForm(contractFile(JSON.stringify({ ...CONTRACT, retry: { cap: 2 } })));
    assert.equal(badRetry.ok, false);
    assert.match(badRetry.reason, /retry/);

    const absurd = { ...CONTRACT, scope: 'x', inputs: 'x', acceptance: 'x', returnShape: 'x', producerContract: 'x' };
    assert.equal(
      checkDispatchContractForm(contractFile(JSON.stringify(absurd))).ok,
      true,
      'the checker is FORM-only: a semantically absurd but well-formed header passes',
    );

    // A contract marker INSIDE another fenced block is example text, not this file's header — a doc
    // block showing the shape must never be mistaken for the contract the dispatch actually carries.
    const fence = '```';
    const outerFence = '````';
    const nested = [
      '# Sub-task brief',
      '',
      `${outerFence}markdown`,
      `${fence}${CONTRACT_INFO_STRING}`,
      JSON.stringify(CONTRACT),
      fence,
      outerFence,
      '',
    ].join('\n');
    const viaNested = checkDispatchContractForm(nested);
    assert.equal(viaNested.ok, false, 'a contract marker nested inside another fence is example text');
    assert.match(viaNested.reason, /absent/);

    const unclosed = checkDispatchContractForm(['# Sub-task brief', '', `${fence}${CONTRACT_INFO_STRING}`, JSON.stringify(CONTRACT), ''].join('\n'));
    assert.equal(unclosed.ok, false, 'an UNCLOSED contract block refuses — it is not silently taken to the end of the file');
    assert.match(unclosed.reason, /closed/);

    const extracted = extractContractBlock(CONTRACT_FILE);
    assert.equal(extracted.ok, true);
    assert.equal(JSON.parse(extracted.source).nonce, 'n-1');

    // A CRLF-authored dispatch file is an ordinary case, not an exotic one: the fence must be
    // recognised, and the digest is taken over the PARSED object so line endings cannot move it.
    const crlf = CONTRACT_FILE.split('\n').join('\r\n');
    assert.equal(checkDispatchContractForm(crlf).ok, true, 'a CRLF-authored dispatch file carries the same contract');
    assert.equal(contractDigest(parseDispatchContract(crlf).contract), contractDigest(CONTRACT), 'line endings never move the contract digest');
  });

  it('AC09 contractDigest is sha256 over the canonical serialization of the parsed header', () => {
    const parsed = parseDispatchContract(CONTRACT_FILE);
    assert.equal(parsed.ok, true, parsed.reason);
    const digest = contractDigest(parsed.contract);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, independentDigest(CONTRACT), 'the domain is the canonical bytes of the PARSED header');
    assert.equal(digest, createHash('sha256').update(delegationCanonicalSerialization(CONTRACT), 'utf8').digest('hex'));

    const permutedFile = contractFile(JSON.stringify(Object.fromEntries(Object.entries(CONTRACT).reverse())));
    const permuted = parseDispatchContract(permutedFile);
    assert.equal(permuted.ok, true, permuted.reason);
    assert.equal(contractDigest(permuted.contract), digest, 'a key-permuted header digests identically');

    const reflowed = contractFile(JSON.stringify(CONTRACT, null, 4));
    assert.equal(contractDigest(parseDispatchContract(reflowed).contract), digest, 'whitespace layout never moves the digest');
    assert.notEqual(contractDigest({ ...CONTRACT, deadlineS: 1801 }), digest, 'a differing header digests differently');
  });

  it('AC10 byte domains: new, deleted, renamed counted once, binary, symlink, submodule, non-regular', () => {
    assert.deepEqual(NUMERATOR_RULES.new, 'post-image');
    assert.deepEqual(NUMERATOR_RULES.deleted, 'pre-image');
    assert.deepEqual(NUMERATOR_RULES.renamed, 'both-names-once');
    for (const kind of ['binary', 'symlink', 'submodule', 'non-regular']) {
      assert.equal(NUMERATOR_RULES[kind], 'size-only', `${kind} counts size only`);
    }
    assert.equal(NUMERATOR_RULES.enumerated, 'enumerated-ranges-once', 'the enumerated domain is SEPARATE from the exec diff kinds');

    // The exec diff kinds count the FULL image of every object the returned diff touches; partial
    // accounting is not expressible there, so a ranges key refuses outright.
    for (const entry of [
      { kind: 'new', path: 'a.mjs', objectId: 'obj-a', postImageBytes: 40, ranges: [[0, 40]] },
      { kind: 'deleted', path: 'a.mjs', objectId: 'obj-a', preImageBytes: 40, ranges: [[0, 40]] },
      { kind: 'modified', path: 'a.mjs', objectId: 'obj-a', preImageBytes: 40, ranges: [[0, 20]] },
      { kind: 'renamed', path: 'b.mjs', fromPath: 'a.mjs', objectId: 'obj-a', preImageBytes: 40, ranges: [[0, 40]] },
    ]) {
      assert.equal(computeNumerator([entry]).ok, false, `${entry.kind}: an exec diff kind never enumerates content ranges`);
    }

    const created = computeNumerator([{ kind: 'new', path: 'a.mjs', objectId: 'obj-a', postImageBytes: 40 }]);
    assert.equal(created.ok, true, created.reason);
    assert.equal(created.numeratorBytes, 40);
    assert.deepEqual(created.components, [{ kind: 'new', path: 'a.mjs', objectId: 'obj-a', bytes: 40 }]);

    const deleted = computeNumerator([{ kind: 'deleted', path: 'b.mjs', objectId: 'obj-b', preImageBytes: 55 }]);
    assert.equal(deleted.numeratorBytes, 55, 'a deletion counts its PRE-image bytes');

    // Dedup keys on the OBJECT, never on a name: the producer states which entries describe one
    // object, so a rename chain and a re-created path can no longer be confused with each other.
    const renamed = computeNumerator([
      { kind: 'renamed', path: 'new-name.mjs', fromPath: 'old-name.mjs', objectId: 'obj-1', preImageBytes: 70 },
      { kind: 'modified', path: 'old-name.mjs', objectId: 'obj-1', preImageBytes: 70 },
    ]);
    assert.equal(renamed.ok, true, renamed.reason);
    assert.equal(renamed.numeratorBytes, 70, "a rename's two names are counted ONCE");
    assert.equal(renamed.components[1].bytes, 0, 'the second enumeration of the same object contributes nothing');

    // The two legs a name-keyed map could not tell apart, both now correct by construction.
    const chain = computeNumerator([
      { kind: 'renamed', path: 'b.mjs', fromPath: 'a.mjs', objectId: 'obj-1', preImageBytes: 70 },
      { kind: 'renamed', path: 'c.mjs', fromPath: 'b.mjs', objectId: 'obj-1', preImageBytes: 70 },
    ]);
    assert.equal(chain.ok, true, chain.reason);
    assert.equal(chain.numeratorBytes, 70, 'a rename CHAIN is one object, counted once');
    const recreated = computeNumerator([
      { kind: 'renamed', path: 'b.mjs', fromPath: 'a.mjs', objectId: 'obj-1', preImageBytes: 70 },
      { kind: 'new', path: 'a.mjs', objectId: 'obj-2', postImageBytes: 30 },
    ]);
    assert.equal(recreated.ok, true, recreated.reason);
    assert.equal(recreated.numeratorBytes, 100, 'a path RE-CREATED after a rename is a different object and counts in full');

    // One identity means one SIZE. A second entry claiming the same object with a different size is
    // a producer contradiction, not a bigger object, so it refuses instead of INFLATING the total.
    const sizeConflict = computeNumerator([
      { kind: 'modified', path: 'a.mjs', objectId: 'obj-1', preImageBytes: 100 },
      { kind: 'modified', path: 'a.mjs', objectId: 'obj-1', preImageBytes: 150 },
    ]);
    assert.equal(sizeConflict.ok, false, 'one objectId with two sizes refuses instead of inflating the numerator');
    assert.match(sizeConflict.reason, /objectId/);
    assert.equal(
      computeNumerator([{ kind: 'renamed', path: 'b.mjs', fromPath: '', objectId: 'obj-1', preImageBytes: 70 }]).ok,
      false,
      'a rename records the name it came FROM',
    );

    // An entry field the enumeration reads more than once must be a DATA property: a shifting
    // accessor could answer one identity to the dedup lookup and another to the store.
    const shifting = { kind: 'modified', path: 'a.mjs', preImageBytes: 100 };
    let reads = 0;
    Object.defineProperty(shifting, 'objectId', {
      get: () => { reads += 1; return `obj-${reads}`; },
      enumerable: true,
      configurable: true,
    });
    const viaShiftingId = computeNumerator([shifting]);
    assert.equal(viaShiftingId.ok, false, 'an accessor entry field refuses — it could answer two different identities');
    assert.match(viaShiftingId.reason, /"objectId"/);
    const throwingEntry = { kind: 'modified', path: 'a.mjs', preImageBytes: 100 };
    Object.defineProperty(throwingEntry, 'objectId', {
      get: () => { throw new Error('hostile'); },
      enumerable: true,
      configurable: true,
    });
    assert.equal(computeNumerator([throwingEntry]).ok, false, 'a throwing entry getter refuses rather than propagating');

    for (const kind of ['binary', 'symlink', 'submodule', 'non-regular']) {
      const sized = computeNumerator([{ kind, path: `s-${kind}`, objectId: `obj-${kind}`, sizeBytes: 12 }]);
      assert.equal(sized.ok, true, sized.reason);
      assert.equal(sized.numeratorBytes, 12, `${kind}: size only`);
      const withRanges = computeNumerator([{ kind, path: `s-${kind}`, objectId: `obj-${kind}`, sizeBytes: 12, ranges: [[0, 4]] }]);
      assert.equal(withRanges.ok, false, `${kind}: a size-only class never enumerates content ranges`);
    }

    const gatePreserved = computeNumerator([{ kind: 'gate-output', bytes: 500, bytePreserved: true }]);
    assert.equal(gatePreserved.numeratorBytes, 500, 'byte-preserved gate output counts');
    const gateNotPreserved = computeNumerator([{ kind: 'gate-output', bytes: 500, bytePreserved: false }]);
    assert.equal(gateNotPreserved.ok, true, gateNotPreserved.reason);
    assert.equal(gateNotPreserved.numeratorBytes, 0, 'gate output counts only when the wrapper byte-preserved it');
    assert.deepEqual(
      gateNotPreserved.components,
      [{ kind: 'gate-output', path: null, objectId: null, bytes: 0 }],
      'the zero is RECORDED, never silent; gate output names no object',
    );

    const mixed = computeNumerator([
      { kind: 'new', path: 'a.mjs', objectId: 'obj-a', postImageBytes: 40 },
      { kind: 'modified', path: 'b.mjs', objectId: 'obj-b', preImageBytes: 60 },
    ]);
    assert.equal(mixed.numeratorBytes, 100);
    assert.equal(mixed.components.reduce((n, c) => n + c.bytes, 0), mixed.numeratorBytes, 'the components sum IS the numerator');

    assert.equal(computeNumerator([{ kind: 'moved', path: 'a', bytes: 1 }]).ok, false, 'an unknown component kind refuses');
    assert.equal(computeNumerator([{ kind: 'new', path: 'a.mjs', postImageBytes: 40 }]).ok, false, 'a missing objectId refuses — dedup has no key without it');
    assert.equal(computeNumerator([{ kind: 'new', path: 'a.mjs', objectId: '', postImageBytes: 40 }]).ok, false, 'an empty objectId refuses');
    assert.equal(computeNumerator([{ kind: 'new', path: 'a.mjs', objectId: 'obj-a' }]).ok, false, 'a missing byte count refuses');
    assert.equal(computeNumerator([{ kind: 'new', path: 'a.mjs', objectId: 'obj-a', postImageBytes: -1 }]).ok, false, 'a negative byte count refuses');
    assert.equal(computeNumerator([{ kind: 'new', path: '', objectId: 'obj-a', postImageBytes: 1 }]).ok, false, 'an empty path refuses');
    assert.equal(computeNumerator([{ kind: 'new', path: 'a.mjs', objectId: 'obj-a', postImageBytes: 2 ** 53 }]).ok, false, 'an unsafe integer byte count refuses');
    const overflow = computeNumerator([
      { kind: 'new', path: 'a.mjs', objectId: 'obj-a', postImageBytes: 2 ** 52 },
      { kind: 'new', path: 'b.mjs', objectId: 'obj-b', postImageBytes: 2 ** 52 },
    ]);
    assert.equal(overflow.ok, false, 'a running total leaving the safe-integer range refuses');
    assert.match(overflow.reason, /safe/);
    assert.equal(
      computeNumerator([
        { kind: 'new', path: 'a.mjs', objectId: 'obj-a', postImageBytes: 40 },
        { kind: 'enumerated', path: 'b.md', objectId: 'obj-b', sourceBytes: 100, ranges: [[0, 10]] },
      ]).ok,
      false,
      'one enumeration never mixes the EXEC and ENUMERATED domains',
    );
    assert.equal(computeNumerator('not-a-list').ok, false, 'a non-array input refuses');
    assert.deepEqual(computeNumerator([]), { ok: true, components: [], numeratorBytes: 0 }, 'an empty enumeration is zero, not a refusal');
  });

  it('AC11 bundle framing is boundary-unambiguous under length-prefixed literal vectors', () => {
    assert.equal(BUNDLE_FRAMING_HEADER, 'aw-dispatch-bundle/1\n');

    const diff = Buffer.from('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n');
    const report = Buffer.from('done: 1 file\n');
    const framed = frameIntegrationBundle(diff, report);
    assert.ok(Buffer.isBuffer(framed));
    assert.equal(
      framed.toString('utf8'),
      `${BUNDLE_FRAMING_HEADER}${diff.length}\n${diff.toString('utf8')}${report.length}\n${report.toString('utf8')}`,
      'the literal framing vector',
    );
    assert.equal(framed.length, expectedBundleLength(diff.length, report.length));

    const round = parseIntegrationBundle(framed);
    assert.equal(round.ok, true, round.reason);
    assert.equal(round.diff.toString('utf8'), diff.toString('utf8'));
    assert.equal(round.report.toString('utf8'), report.toString('utf8'));

    // The adversarial vector: each payload itself carries the framing's own bytes.
    const hostile = Buffer.from(`${BUNDLE_FRAMING_HEADER}9\nnot-a-diff`);
    const hostileFramed = frameIntegrationBundle(hostile, hostile);
    const hostileRound = parseIntegrationBundle(hostileFramed);
    assert.equal(hostileRound.ok, true, hostileRound.reason);
    assert.equal(hostileRound.diff.toString('utf8'), hostile.toString('utf8'), 'a payload that mimics the framing survives verbatim');
    assert.equal(hostileRound.report.toString('utf8'), hostile.toString('utf8'));

    const empty = frameIntegrationBundle(Buffer.alloc(0), Buffer.alloc(0));
    assert.equal(empty.toString('utf8'), `${BUNDLE_FRAMING_HEADER}0\n0\n`);
    assert.equal(empty.length, expectedBundleLength(0, 0));
    const emptyRound = parseIntegrationBundle(empty);
    assert.equal(emptyRound.ok, true, emptyRound.reason);
    assert.equal(emptyRound.diff.length, 0);
    assert.equal(emptyRound.report.length, 0);

    const digest = createHash('sha256').update(framed).digest('hex');
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(
      digest,
      createHash('sha256').update(frameIntegrationBundle(report, diff)).digest('hex'),
      'swapping the two parts is a DIFFERENT bundle — the framing is ordered',
    );

    assert.equal(parseIntegrationBundle(Buffer.from('nope')).ok, false, 'a missing header refuses');
    assert.equal(parseIntegrationBundle(Buffer.from(`${BUNDLE_FRAMING_HEADER}5\nabc`)).ok, false, 'a truncated part refuses');
    assert.equal(parseIntegrationBundle(Buffer.concat([framed, Buffer.from('x')])).ok, false, 'trailing bytes refuse');
    assert.equal(parseIntegrationBundle(Buffer.from(`${BUNDLE_FRAMING_HEADER}0x\n`)).ok, false, 'a non-decimal length refuses');

    // The framing is CANONICAL: one payload pair has exactly one byte sequence, so a padded prefix
    // (which would carry a second, differing bundleDigest for the same pair) refuses.
    assert.equal(parseIntegrationBundle(Buffer.from(`${BUNDLE_FRAMING_HEADER}00\n0\n`)).ok, false, 'a leading-zero length prefix refuses');
    assert.equal(parseIntegrationBundle(Buffer.from(`${BUNDLE_FRAMING_HEADER}0\n0\n`)).ok, true, 'a bare zero IS the canonical zero prefix');
    assert.equal(parseIntegrationBundle(Buffer.from(`${BUNDLE_FRAMING_HEADER}9007199254740993\n`)).ok, false, 'a length outside the safe-integer range refuses');
    assert.equal(expectedBundleLength(2 ** 53, 0), null, 'the framing arithmetic refuses an unsafe length rather than returning a lossy one');
    assert.throws(
      () => frameIntegrationBundle(42, Buffer.alloc(0)),
      TypeError,
      'framing a non-buffer part is a PROGRAMMING error, not a record refusal — it throws',
    );
  });

  it('AC12 zero-byte proxy, no-op diff, empty report, zero-length bundle and dirty baseline each name their reason', () => {
    assert.deepEqual(
      [...INELIGIBLE_REASONS].sort(),
      ['dirty-baseline', 'empty-report', 'no-op-diff', 'zero-byte-proxy', 'zero-denominator', 'zero-length-bundle'],
      'the named-reason set is closed',
    );
    const healthy = { baselineClean: true, numeratorBytes: 100, diffLength: 30, reportLength: 20, bundleLength: FIXTURE_BUNDLE_LENGTH };
    assert.deepEqual(evaluateMetricEligibility(healthy), { ok: true, eligible: true, ineligibleReason: null });

    const cases = [
      [{ ...healthy, baselineClean: false }, 'dirty-baseline'],
      [{ ...healthy, diffLength: 0 }, 'no-op-diff'],
      [{ ...healthy, reportLength: 0 }, 'empty-report'],
      [{ ...healthy, bundleLength: 0 }, 'zero-length-bundle'],
      [{ ...healthy, numeratorBytes: 0 }, 'zero-byte-proxy'],
    ];
    for (const [input, reason] of cases) {
      const res = evaluateMetricEligibility(input);
      assert.deepEqual(res, { ok: true, eligible: false, ineligibleReason: reason }, `${reason}: ineligible by NAME, never a silent zero`);
      assert.ok(INELIGIBLE_REASONS.includes(res.ineligibleReason));
    }

    // zero-length-bundle is a PRODUCER-side reason, evaluated before framing. A framed return can
    // never substantiate it (the framing has a header and two prefixes), so one that carries it
    // refuses — the producer and the framed record are two different evaluation points.
    const framedZeroBundle = validateDelegationRecord(returnWith({
      metric: metricWith({ eligible: false, ineligibleReason: 'zero-length-bundle' }),
    }));
    assert.equal(framedZeroBundle.ok, false, 'a framed return never carries zero-length-bundle');
    assert.match(framedZeroBundle.reason, /zero-length-bundle/);

    // An observation has no diff, report or bundle — its own two numbers decide. Both zero picks
    // zero-denominator deterministically, so L = 0/0 can never be recorded as an eligible metric.
    assert.deepEqual(evaluateObservationEligibility({ numeratorBytes: 100, denominatorBytes: 100 }), { ok: true, eligible: true, ineligibleReason: null });
    assert.deepEqual(evaluateObservationEligibility({ numeratorBytes: 0, denominatorBytes: 100 }), { ok: true, eligible: false, ineligibleReason: 'zero-byte-proxy' });
    assert.deepEqual(evaluateObservationEligibility({ numeratorBytes: 100, denominatorBytes: 0 }), { ok: true, eligible: false, ineligibleReason: 'zero-denominator' });
    assert.deepEqual(
      evaluateObservationEligibility({ numeratorBytes: 0, denominatorBytes: 0 }),
      { ok: true, eligible: false, ineligibleReason: 'zero-denominator' },
      'both zero picks zero-denominator deterministically',
    );
    assert.equal(evaluateObservationEligibility({ numeratorBytes: 0, denominatorBytes: 0, lane: 'x' }).ok, false, 'an unknown input key refuses');

    const zeroObservation = validateDelegationRecord(record('observation', {
      metric: { ...RECORDS.observation.metric, numeratorBytes: 0, denominatorBytes: 0, components: [] },
    }));
    assert.equal(zeroObservation.ok, false, 'an observation can never record L = 0/0 as eligible');
    assert.match(zeroObservation.reason, /zero-denominator/);
    assert.deepEqual(
      validateDelegationRecord(record('observation', {
        metric: {
          ...RECORDS.observation.metric,
          numeratorBytes: 0,
          denominatorBytes: 0,
          components: [],
          eligible: false,
          ineligibleReason: 'zero-denominator',
        },
      })),
      { ok: true },
      'the NAMED zero-denominator observation validates',
    );
    assert.equal(
      validateDelegationRecord(record('observation', {
        metric: {
          ...RECORDS.observation.metric,
          numeratorBytes: 0,
          denominatorBytes: 0,
          components: [],
          eligible: false,
          ineligibleReason: 'zero-byte-proxy',
        },
      })).ok,
      false,
      'an observation reason that contradicts its own numbers refuses',
    );
    assert.equal(
      validateDelegationRecord(record('observation', {
        metric: { ...RECORDS.observation.metric, eligible: false, ineligibleReason: 'dirty-baseline' },
      })).ok,
      false,
      'an observation carries NO store-side override — dirty-baseline has no meaning here',
    );

    assert.equal(evaluateMetricEligibility({ ...healthy, lane: 'x' }).ok, false, 'an unknown input key refuses');
    const short = { ...healthy };
    delete short.bundleLength;
    assert.equal(evaluateMetricEligibility(short).ok, false, 'a missing input key refuses');
    assert.equal(evaluateMetricEligibility({ ...healthy, numeratorBytes: -1 }).ok, false, 'a negative byte count refuses');
  });

  it('AC13 the baseline implication is directional', () => {
    const dirty = evaluateMetricEligibility({ baselineClean: false, numeratorBytes: 100, diffLength: 30, reportLength: 20, bundleLength: FIXTURE_BUNDLE_LENGTH });
    assert.deepEqual(dirty, { ok: true, eligible: false, ineligibleReason: 'dirty-baseline' }, 'baselineClean:false FORCES dirty-baseline ineligibility');

    const dirtyAndEmpty = evaluateMetricEligibility({ baselineClean: false, numeratorBytes: 0, diffLength: 0, reportLength: 0, bundleLength: 0 });
    assert.equal(dirtyAndEmpty.ineligibleReason, 'dirty-baseline', 'the dirty baseline is the FIRST-named reason when several hold');

    for (const over of [{ diffLength: 0 }, { reportLength: 0 }, { bundleLength: 0 }, { numeratorBytes: 0 }]) {
      const res = evaluateMetricEligibility({ baselineClean: true, numeratorBytes: 100, diffLength: 30, reportLength: 20, bundleLength: FIXTURE_BUNDLE_LENGTH, ...over });
      assert.equal(res.eligible, false, `baselineClean:true implies NOTHING — ${Object.keys(over)[0]} still makes the metric ineligible`);
    }
  });

  it('AC14 overlapping ranges count once and provenance is closed and lives only in metric', () => {
    assert.deepEqual(normalizeByteRanges([[0, 10], [5, 20]]), [[0, 20]], 'overlapping ranges merge');
    assert.deepEqual(normalizeByteRanges([[10, 20], [0, 10]]), [[0, 20]], 'adjacent ranges merge and the result is ordered');
    assert.deepEqual(normalizeByteRanges([[0, 5], [10, 15]]), [[0, 5], [10, 15]], 'disjoint ranges stay separate');
    assert.deepEqual(normalizeByteRanges([]), []);
    assert.equal(normalizeByteRanges([[5, 5]]), null, 'an empty range refuses');
    assert.equal(normalizeByteRanges([[-1, 5]]), null, 'a negative offset refuses');
    assert.equal(normalizeByteRanges([[0, 1.5]]), null, 'a fractional offset refuses');
    assert.equal(normalizeByteRanges('x'), null, 'a non-array refuses');

    // Ranges live ONLY in the enumerated domain (the extraction step class, where the numerator is
    // the source bytes a report enumerates). The exec diff kinds count full images and are covered
    // in AC10.
    const overlapping = computeNumerator([
      { kind: 'enumerated', path: 'a.mjs', objectId: 'obj-a', sourceBytes: 100, ranges: [[0, 60]] },
      { kind: 'enumerated', path: 'a.mjs', objectId: 'obj-a', sourceBytes: 100, ranges: [[40, 90]] },
    ]);
    assert.equal(overlapping.ok, true, overlapping.reason);
    assert.equal(overlapping.numeratorBytes, 90, 'the overlap [40,60) is counted ONCE');
    assert.deepEqual(overlapping.components.map((c) => c.bytes), [60, 30], 'each component reports its own NON-overlapping contribution');
    assert.equal(overlapping.components.reduce((n, c) => n + c.bytes, 0), overlapping.numeratorBytes);
    assert.equal(
      computeNumerator([{ kind: 'enumerated', path: 'a.mjs', objectId: 'obj-a', sourceBytes: 10, ranges: [[0, 11]] }]).ok,
      false,
      'a range beyond the object refuses',
    );
    assert.equal(
      computeNumerator([{ kind: 'enumerated', path: 'a.mjs', objectId: 'obj-a', sourceBytes: 10 }]).ok,
      false,
      'the enumerated domain REQUIRES its ranges — it is the enumeration',
    );

    const duplicated = computeNumerator([
      { kind: 'modified', path: 'a.mjs', objectId: 'obj-a', preImageBytes: 100 },
      { kind: 'modified', path: 'a.mjs', objectId: 'obj-a', preImageBytes: 100 },
    ]);
    assert.equal(duplicated.ok, true, duplicated.reason);
    assert.equal(duplicated.numeratorBytes, 100, 'one object enumerated twice counts ONCE');
    assert.deepEqual(duplicated.components.map((c) => c.bytes), [100, 0]);

    assert.deepEqual([...METRIC_PROVENANCE].sort(), ['self-reported', 'solo-construction', 'wrapper-git']);
    assert.deepEqual([...OBSERVATION_PROVENANCE].sort(), ['self-reported', 'solo-construction']);
    assert.deepEqual([...RETURN_PROVENANCE].sort(), ['self-reported', 'wrapper-git']);

    // The two component domains never mix, and the ENUMERATED domain is self-reported by
    // construction — that is what keeps extraction bytes out of a git-provable metric.
    assert.deepEqual(
      [...EXEC_COMPONENT_KINDS, ...ENUMERATED_COMPONENT_KINDS].sort(),
      [...METRIC_COMPONENT_KINDS].sort(),
      'the two domains partition the component kinds',
    );
    const mixedMetric = validateDelegationRecord(returnWith({
      metric: metricWith({ components: [RETURN_COMPONENTS[0], { kind: 'enumerated', path: 'x.md', objectId: 'obj-x', bytes: 60 }] }),
    }));
    assert.equal(mixedMetric.ok, false, 'a metric never mixes the two component domains');
    assert.match(mixedMetric.reason, /domain/);
    assert.equal(
      validateDelegationRecord(returnWith({ metric: metricWith({ components: [{ kind: 'enumerated', path: 'x.md', objectId: 'obj-x', bytes: 100 }] }) })).ok,
      false,
      'enumerated bytes never land in a wrapper-git metric',
    );
    assert.deepEqual(
      validateDelegationRecord(returnWith({
        metric: metricWith({ provenance: 'self-reported', components: [{ kind: 'enumerated', path: 'x.md', objectId: 'obj-x', bytes: 100 }] }),
      })),
      { ok: true },
      'the enumerated domain rides self-reported provenance',
    );
    const soloReturn = validateDelegationRecord(returnWith({ metric: metricWith({ provenance: 'solo-construction' }) }));
    assert.equal(soloReturn.ok, false, 'solo-construction is the SOLO baseline and never describes a delegated return');
    assert.match(soloReturn.reason, /provenance/);

    // An empty enumeration belongs to NO domain, so a legitimately ineligible record survives.
    assert.deepEqual(
      validateDelegationRecord(returnWith({
        metric: metricWith({ numeratorBytes: 0, components: [], eligible: false, ineligibleReason: 'zero-byte-proxy' }),
      })),
      { ok: true },
      'an empty component list is domain-NEUTRAL and never blocks a named ineligibility',
    );
    const badProvenance = validateDelegationRecord(returnWith({ metric: metricWith({ provenance: 'guessed' }) }));
    assert.equal(badProvenance.ok, false);
    assert.match(badProvenance.reason, /provenance/);
    const topLevel = validateDelegationRecord(returnWith({ provenance: 'wrapper-git' }));
    assert.equal(topLevel.ok, false, 'provenance has ONE home: the metric');
    assert.match(topLevel.reason, /"provenance"/);
    const wrapperOnObservation = validateDelegationRecord(record('observation', {
      metric: { ...RECORDS.observation.metric, provenance: 'wrapper-git' },
    }));
    assert.equal(wrapperOnObservation.ok, false, 'an observation carries solo-construction or self-reported only');
    assert.match(wrapperOnObservation.reason, /provenance/);
  });

  it('AC15 dispatch mint: the contract copy is bound by contractDigest and a mint-time inconsistency refuses', () => {
    const minted = record('dispatch', { contractDigest: contractDigest(CONTRACT) });
    assert.deepEqual(checkDispatchMintConsistency(CONTRACT, minted), { ok: true });

    const staleDigest = checkDispatchMintConsistency(CONTRACT, record('dispatch', { contractDigest: D('99') }));
    assert.equal(staleDigest.ok, false, 'contractDigest must bind the header it copies');
    assert.match(staleDigest.reason, /contractDigest/);

    for (const [field, value] of [['retryCap', 5], ['retryIndex', 1], ['nonce', 'n-2'], ['stepClass', 'triage'], ['deadlineS', 60]]) {
      const res = checkDispatchMintConsistency(CONTRACT, { ...minted, [field]: value });
      assert.equal(res.ok, false, `a dispatch disagreeing with the header on ${field} refuses`);
      assert.match(res.reason, new RegExp(field));
    }
    const vehicleDrift = checkDispatchMintConsistency(CONTRACT, { ...minted, vehicle: { requested: 'agy', selected: 'codex-exec' } });
    assert.equal(vehicleDrift.ok, false, 'the vehicle pair is copied verbatim');
    assert.match(vehicleDrift.reason, /vehicle/);

    assert.equal(checkDispatchMintConsistency(CONTRACT, record('fold')).ok, false, 'only a dispatch record mints from a header');
    assert.equal(checkDispatchMintConsistency({ ...CONTRACT, nonce: 'bad nonce' }, minted).ok, false, 'a malformed header refuses before the comparison');

    const retryOfMismatch = validateDelegationRecord(record('dispatch', { retryIndex: 1 }));
    assert.equal(retryOfMismatch.ok, false, 'a retry carries its origin nonce');
    assert.match(retryOfMismatch.reason, /retryOf/);
    assert.deepEqual(validateDelegationRecord(record('dispatch', { retryIndex: 1, retryOf: 'n-0' })), { ok: true });
    const overCap = validateDelegationRecord(record('dispatch', { retryIndex: 3, retryOf: 'n-0', retryCap: 2 }));
    assert.equal(overCap.ok, false, 'retryIndex never exceeds the recorded cap');
    assert.match(overCap.reason, /retryCap/);
    const originOnFirst = validateDelegationRecord(record('dispatch', { retryOf: 'n-0' }));
    assert.equal(originOnFirst.ok, false, 'a retryIndex-0 dispatch is not a retry');
  });

  it('AC16 the D9 step-class taxonomy is closed and versioned', () => {
    assert.deepEqual(
      [...STEP_CLASSES],
      ['code', 'extraction', 'triage', 'draft', 'research', 'review-opinion', 'worktree-stream'],
      'the D9 taxonomy is the plan fixture, in order',
    );
    assert.ok(Object.isFrozen(STEP_CLASSES));
    for (const stepClass of STEP_CLASSES) {
      assert.deepEqual(validateDelegationRecord(record('dispatch', { stepClass })), { ok: true }, `${stepClass} is a legal class`);
    }
    const unknown = validateDelegationRecord(record('dispatch', { stepClass: 'refactor' }));
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason, /stepClass/);
    assert.match(unknown.reason, /"refactor"/);
    const unknownInWave = validateDelegationRecord(record('pre-registration', { stepClasses: ['code', 'refactor'] }));
    assert.equal(unknownInWave.ok, false, 'a pre-registration registers D9 classes only');
    const duplicateClasses = validateDelegationRecord(record('pre-registration', { stepClasses: ['code', 'code'] }));
    assert.equal(duplicateClasses.ok, false, 'the registered class list is a SET');
    const emptyClasses = validateDelegationRecord(record('pre-registration', { stepClasses: [] }));
    assert.equal(emptyClasses.ok, false, 'a wave registers at least one class');

    // A SPARSE array is not a closed set — Array.prototype.every SKIPS holes, so the membership
    // check would never see the missing element and a hole would register as a legal class.
    const sparseClasses = [];
    sparseClasses[1] = 'code';
    assert.equal(sparseClasses.length, 2, 'the fixture genuinely carries a hole at index 0');
    assert.equal(
      validateDelegationRecord(record('pre-registration', { stepClasses: sparseClasses })).ok,
      false,
      'a sparse class array refuses',
    );
  });
});
