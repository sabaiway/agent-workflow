// dispatch-record.mjs — the CLOSED delegation-record vocabulary (delegation Plan 1, Phase 1). Pure
// form: no filesystem, no git, no CLI, no side effects on import. The store IO (dispatch-store.mjs,
// Phase 2) and the engine (dispatch.mjs, Phase 3) consume these predicates; nothing here reads or
// writes a store.
//
// The delegation half of the funded intent. The flow family already accounts for REVIEW dispatches
// (receipts, finding manifests, deadlines); nothing today records {dispatched → returned → folded}
// for EXEC work, so the delegation metric is unmeasurable. This module is the measurement
// substrate's vocabulary: the record family, the failure-outcome enum with its allowed-successor
// table, the exec-return schema, the sub-task contract header with a FORM-only checker, and the
// per-kind byte-domain rules the metric is computed from.
//
// The record family (D3, versioned + closed): pre-registration · dispatch · return · fold ·
// observation · degrade. Fail-closed in BOTH directions — unknown schema, unknown kind, a missing
// field, a malformed field and an unknown EXTRA field are all refusals (the flow-record.mjs:22-24
// discipline): the per-record canonical digest is the record's identity, so a stray key would fork
// it.
//
// THE DESCRIPTOR DISCIPLINE, applied wherever a value is read: every field must be an OWN
// ENUMERABLE DATA property — including `schema` and `kind`, checked BEFORE their values are read —
// and every array field must be DENSE with a data property at each index. That is exactly the
// domain the canonical serialization walks, and each escape breaks record identity a different way:
// a prototype-supplied or own non-enumerable field validates but never enters the digest; an
// accessor is invoked a SECOND time at serialization and may answer differently; a sparse array
// slips a closed-set check because Array.prototype.every SKIPS holes. Producer-supplied numerator
// entries ride the same rule, and every field is read exactly ONCE into a local, so no value can
// change between two reads of the same enumeration.
//
// Reference domains, deliberately SPLIT (D3): a RECORD reference is a per-record CANONICAL digest
// (fold.returnDigest); THREAD linkage (nonce, retryOf) is by NONCE identity — a nonce is a thread
// id, never a record reference. A third domain is the metric's: a counted OBJECT is identified by a
// producer-supplied `objectId`, never by a path. Names cannot carry that identity — a rename chain
// (A→B→C) and a path re-created after a rename both make one name mean two objects or two names one
// object, and either confusion mis-counts the numerator. One identity also means one SIZE: a second
// entry claiming the same object at a different size is a producer contradiction, not a bigger
// object, and it refuses rather than inflating the total.
//
// The METRIC has two component domains that never mix, and provenance is bound to them in ONE
// direction: the ENUMERATED domain is a delegate's own account of what it read, so it REQUIRES
// `self-reported` — which means `wrapper-git` implies the EXEC domain, and `solo-construction`,
// being the SOLO baseline, describes an observation. The EXEC domain accepts BOTH `wrapper-git` and
// `self-reported`: a delegated return whose bytes the wrapper could not prove is still RECORDED,
// and its exclusion from the acceptance number happens downstream, where it belongs. An EMPTY
// component list belongs to no domain, so a legitimately ineligible record (zero numerator, named)
// is never blocked by the rule.
//
// Canonical discipline: the family has exactly ONE canonical serialization, so this module IMPORTS
// flow-record's rather than copying it — a copy is the only way the two could ever drift, and a
// parity test pins these bytes against core-evidence's canonicalKindSerialization on a single
// record (core adds only the per-line framing newline).
//
// Named grammars are taken by reference, never re-stated: the 64-hex digest, the safe nonce grammar
// SAFE_NONCE_RE (flow-record.mjs) — which also governs waveId, a name that keys a wave and rides a
// CLI flag — and the canonical UTC instant (toISOString round-trip). Every byte count is a SAFE
// integer: the metric is compared for exact equality, so a total that leaves the safe range can no
// longer be compared and refuses rather than silently agreeing.
//
// Honest limits, stated where they bite:
//   • the contract checker is FORM-only BY NAME (D-R1-FORM-ONLY). Fields present, grammars
//     respected. Boundedness, design-decidedness and acceptance adequacy stay explicit orchestrator
//     judgment fed by the retro loop — a well-formed absurdity passes here by construction.
//   • record-to-record legality (transitions, correlation, wave rules) needs a STORE snapshot and
//     lands with dispatch-store.mjs; this module exposes the allowed-successor table and the
//     terminality predicate the store consumes, and validates only ONE record at a time. The one
//     exception is metric eligibility, which a record can substantiate from its OWN fields: the
//     validator binds it, leaving only `dirty-baseline` — which needs the dispatch record — to the
//     store, and only ever as a STRICTER override on a return.
//   • the validator never throws on a DATA record: every such input path returns a refusal, and an
//     accessor field is refused by name rather than read. An in-process caller CAN still reach past
//     this — a hostile Proxy throws from its own traps, an array subclass can override `every` or
//     `Symbol.iterator` — and that surface is deliberately NOT chased: records remain forgeable,
//     and this module is a self-discipline mechanism, not a security boundary. The residual is
//     tracked as DELEGATION-DESCRIPTOR-DISCIPLINE-INCOMPLETE.
//   • the metric's byte domains are computed over STRUCTURED inputs handed in by a producer; the
//     git-side producer is Plan 2, and it owns minting a stable `objectId`.

import { createHash } from 'node:crypto';
import { SAFE_NONCE_RE, flowCanonicalSerialization } from './flow-record.mjs';

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const refuse = (reason) => ({ ok: false, reason });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isSafeName = (v) => typeof v === 'string' && SAFE_NONCE_RE.test(v);
const isCanonicalInstant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const isByteCount = (v) => Number.isSafeInteger(v) && v >= 0;

// A field must be a DATA property: reading an accessor here and again at serialization time could
// yield two different values for one record, which is the identity fork the closed key set prevents.
// The descriptor probe never invokes the accessor, so a throwing getter refuses instead of escaping.
const isDataProperty = (obj, field) => {
  const descriptor = Object.getOwnPropertyDescriptor(obj, field);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
};

// DENSE, with a data property at every index. Array.prototype.every SKIPS holes, so a sparse array
// would pass a closed-set membership check without the missing element ever being examined.
const isDenseDataArray = (v) => {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i += 1) {
    if (!isDataProperty(v, i)) return false;
  }
  return true;
};

const ACCESSOR_REFUSAL = 'is an ACCESSOR — a record field must be a data property, or the canonical serialization could read a different value than the validator did';

// Refusals quote the offending VALUE so a caller reading only the message can act on it; a long
// value is elided. The serialization is GUARDED: the store's preflight calls the validator on
// untrusted input, so a BigInt or a circular reference must come back as a refusal, never as a
// thrown TypeError from the formatter itself.
const short = (v) => {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    return `<unserializable ${typeof v}>`;
  }
  if (s === undefined) s = `<${typeof v}>`;
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};

// ── the closed vocabulary ─────────────────────────────────────────────────────────────────────────

export const DELEGATION_SCHEMA_VERSION = 1;

export const DELEGATION_KINDS = deepFreeze(['pre-registration', 'dispatch', 'return', 'fold', 'observation', 'degrade']);

// The closed key set per kind (schema + kind are implicit on every record).
export const DELEGATION_KEY_SETS = deepFreeze({
  'pre-registration': ['waveId', 'stepClasses', 'pairingKey', 'minPerClass', 'meanLThreshold', 'firstPassNum', 'firstPassDen', 'timestamp'],
  dispatch: ['waveId', 'nonce', 'stepClass', 'vehicle', 'backend', 'contractDigest', 'preTreeDigest', 'baselineClean', 'deadlineS', 'retryOf', 'retryIndex', 'retryCap', 'rationale', 'timestamp'],
  return: ['role', 'backend', 'nonce', 'contractDigest', 'preTreeDigest', 'postTreeDigest', 'diffDigest', 'diffLength', 'reportDigest', 'reportLength', 'bundleDigest', 'bundleLength', 'metric', 'outcome', 'exitStatus', 'sessionId', 'wrapperVersion', 'posture', 'timestamp'],
  fold: ['nonce', 'returnDigest', 'treeDigestAtFold', 'verdict', 'timestamp'],
  observation: ['waveId', 'stepClass', 'scope', 'metric', 'planId', 'phase', 'timestamp'],
  degrade: ['waveId', 'nonce', 'stepClass', 'rationale', 'timestamp'],
});

// The two fields that IDENTIFY a record, checked before their values are read.
const IDENTITY_FIELDS = ['schema', 'kind'];

// D4 — the closed failure-outcome enum.
export const RETURN_OUTCOMES = deepFreeze(['success', 'transport-failure', 'contract-refusal', 'store-failure', 'missing-identity', 'partial-edit', 'acceptance-failure', 'stale-return']);

// A success or acceptance-failure return leaves the thread OPEN — it closes at fold or degrade
// (the orchestrator's fold-fix judgment, §7). Every other outcome IS the thread's closure.
export const NON_TERMINAL_RETURN_OUTCOMES = deepFreeze(['success', 'acceptance-failure']);
export const TERMINAL_RETURN_OUTCOMES = deepFreeze(RETURN_OUTCOMES.filter((o) => !NON_TERMINAL_RETURN_OUTCOMES.includes(o)));

// sessionId may be null ONLY where no session ever existed to identify.
export const SESSION_ID_NULLABLE_OUTCOMES = deepFreeze(['transport-failure', 'contract-refusal', 'store-failure', 'missing-identity']);

// The allowed-successor table WITHIN one nonce thread — an exported frozen structure, never prose
// (the flow-record ALLOWED_TRANSITIONS idiom). A degrade is the legal no-fold closure of a thread,
// stale success included; it always carries its rationale.
export const ALLOWED_TRANSITIONS = deepFreeze({
  dispatch: ['return', 'degrade'],
  return: Object.fromEntries(RETURN_OUTCOMES.map((o) => [o, NON_TERMINAL_RETURN_OUTCOMES.includes(o) ? ['fold', 'degrade'] : []])),
  fold: [],
  degrade: [],
});

// D9 — the closed, versioned step-class taxonomy. The acceptance wave registers `code`: the
// wrapper/git-provable exec domain.
export const STEP_CLASSES = deepFreeze(['code', 'extraction', 'triage', 'draft', 'research', 'review-opinion', 'worktree-stream']);

// D6 — provenance lives in the metric and has exactly ONE home there. Acceptance aggregates
// wrapper-git only; self-reported is recorded, EXCLUDED, printed as observational.
export const METRIC_PROVENANCE = deepFreeze(['wrapper-git', 'self-reported', 'solo-construction']);
// An observation is hand-recorded by construction, so it can never claim the wrapper-git domain
// (delegated accounting is DERIVED from nonce threads, never hand-appended); a delegated return is
// never the SOLO baseline.
export const OBSERVATION_PROVENANCE = deepFreeze(['solo-construction', 'self-reported']);
export const RETURN_PROVENANCE = deepFreeze(['wrapper-git', 'self-reported']);

// Every ineligibility is NAMED — the fail-closed rule is "never a silent zero".
export const INELIGIBLE_REASONS = deepFreeze(['dirty-baseline', 'no-op-diff', 'empty-report', 'zero-length-bundle', 'zero-denominator', 'zero-byte-proxy']);

// D6 — the per-kind numerator rules, in TWO domains that never mix.
//   • the EXEC diff kinds count the FULL image of every object the returned diff touches (a rename
//     counts its object ONCE across both names); gate output counts only when the wrapper
//     byte-preserved it (a Plan-2 producer). None of them enumerates content ranges — partial exec
//     accounting is not expressible, by construction.
//   • the ENUMERATED domain (the extraction step class) counts the source bytes a report
//     enumerates, where overlapping ranges count once.
export const NUMERATOR_RULES = deepFreeze({
  new: 'post-image',
  deleted: 'pre-image',
  modified: 'pre-image',
  renamed: 'both-names-once',
  binary: 'size-only',
  symlink: 'size-only',
  submodule: 'size-only',
  'non-regular': 'size-only',
  'gate-output': 'byte-preserved-only',
  enumerated: 'enumerated-ranges-once',
});

export const METRIC_COMPONENT_KINDS = deepFreeze(Object.keys(NUMERATOR_RULES));
export const ENUMERATED_COMPONENT_KINDS = deepFreeze(['enumerated']);
export const EXEC_COMPONENT_KINDS = deepFreeze(METRIC_COMPONENT_KINDS.filter((k) => !ENUMERATED_COMPONENT_KINDS.includes(k)));

// An EMPTY enumeration belongs to no domain, so it never blocks a named ineligibility.
const componentDomain = (kind) => (ENUMERATED_COMPONENT_KINDS.includes(kind) ? 'enumerated' : 'exec');

// Gate output is the one kind that counts no repository object: it names neither a path nor an id.
const namesAnObject = (kind) => kind !== 'gate-output';

// ── nested closed forms ───────────────────────────────────────────────────────────────────────────

const VEHICLE_KEYS = ['requested', 'selected'];
const POSTURE_KEYS = ['model', 'effort', 'tier'];
const METRIC_KEYS = ['numeratorBytes', 'denominatorBytes', 'components', 'provenance', 'eligible', 'ineligibleReason'];
const COMPONENT_KEYS = ['kind', 'path', 'objectId', 'bytes'];

const UNSAFE_TOTAL = 'the running total leaves the safe-integer range — an exact byte comparison is no longer possible (fail closed)';

const checkClosedKeys = (at, value, keys) => {
  if (!isPlainObject(value)) return refuse(`${at} must be an object`);
  const own = Object.keys(value);
  const stray = own.find((k) => !keys.includes(k));
  if (stray !== undefined) return refuse(`${at}: unknown field "${stray}" — the nested key set is closed`);
  const missing = keys.find((k) => !own.includes(k));
  if (missing !== undefined) return refuse(`${at}: missing field "${missing}"`);
  const accessor = keys.find((k) => !isDataProperty(value, k));
  if (accessor !== undefined) return refuse(`${at}: field "${accessor}" ${ACCESSOR_REFUSAL}`);
  return { ok: true };
};

const validateVehicle = (at, vehicle) => {
  const closed = checkClosedKeys(at, vehicle, VEHICLE_KEYS);
  if (!closed.ok) return closed;
  const bad = VEHICLE_KEYS.find((k) => !isNonEmptyString(vehicle[k]));
  return bad === undefined ? { ok: true } : refuse(`${at}: ${bad} must be a non-empty vehicle name (got ${short(vehicle[bad])})`);
};

const validatePosture = (at, posture) => {
  const closed = checkClosedKeys(at, posture, POSTURE_KEYS);
  if (!closed.ok) return closed;
  if (!isNonEmptyString(posture.model)) return refuse(`${at}: model must be a non-empty model name (got ${short(posture.model)})`);
  const bad = ['effort', 'tier'].find((k) => posture[k] !== null && !isNonEmptyString(posture[k]));
  return bad === undefined ? { ok: true } : refuse(`${at}: ${bad} must be a non-empty string or null (got ${short(posture[bad])})`);
};

const validateMetric = (at, metric, allowedProvenance) => {
  const closed = checkClosedKeys(at, metric, METRIC_KEYS);
  if (!closed.ok) return closed;
  for (const k of ['numeratorBytes', 'denominatorBytes']) {
    if (!isByteCount(metric[k])) return refuse(`${at}: ${k} must be a non-negative safe-integer byte count (got ${short(metric[k])})`);
  }
  if (!allowedProvenance.includes(metric.provenance)) {
    return refuse(`${at}: provenance must be one of ${allowedProvenance.join(' | ')} (got ${short(metric.provenance)})`);
  }
  if (typeof metric.eligible !== 'boolean') return refuse(`${at}: eligible must be a boolean (got ${short(metric.eligible)})`);
  if (metric.eligible) {
    if (metric.ineligibleReason !== null) return refuse(`${at}: an ELIGIBLE metric carries ineligibleReason null (got ${short(metric.ineligibleReason)})`);
  } else if (!INELIGIBLE_REASONS.includes(metric.ineligibleReason)) {
    return refuse(`${at}: ineligibleReason must name one of ${INELIGIBLE_REASONS.join(' | ')} — an ineligible metric is never a silent zero (got ${short(metric.ineligibleReason)})`);
  }
  if (!isDenseDataArray(metric.components)) {
    return refuse(`${at}: components must be a DENSE array whose every index is an own enumerable data property`);
  }
  let sum = 0;
  let domain = null;
  for (let i = 0; i < metric.components.length; i += 1) {
    const c = metric.components[i];
    const cAt = `${at}.components[${i}]`;
    const cClosed = checkClosedKeys(cAt, c, COMPONENT_KEYS);
    if (!cClosed.ok) return cClosed;
    if (!METRIC_COMPONENT_KINDS.includes(c.kind)) {
      return refuse(`${cAt}: kind must be one of ${METRIC_COMPONENT_KINDS.join(' | ')} (got ${short(c.kind)})`);
    }
    const kindDomain = componentDomain(c.kind);
    if (domain !== null && domain !== kindDomain) {
      return refuse(`${cAt}: a metric's components all belong to ONE domain — this one is ${kindDomain}, the enumeration opened as ${domain}`);
    }
    domain = kindDomain;
    const named = namesAnObject(c.kind);
    if (named ? !isNonEmptyString(c.path) : c.path !== null) {
      return refuse(`${cAt}: path must be ${named ? 'a non-empty path' : 'null — gate output names no path'} (got ${short(c.path)})`);
    }
    if (named ? !isNonEmptyString(c.objectId) : c.objectId !== null) {
      return refuse(`${cAt}: objectId must be ${named ? 'the non-empty identity of the object counted (the dedup key)' : 'null — gate output counts no object'} (got ${short(c.objectId)})`);
    }
    if (!isByteCount(c.bytes)) return refuse(`${cAt}: bytes must be a non-negative safe-integer byte count (got ${short(c.bytes)})`);
    sum += c.bytes;
    if (!Number.isSafeInteger(sum)) return refuse(`${cAt}: ${UNSAFE_TOTAL}`);
  }
  // ONE direction only: the ENUMERATED domain is a delegate's own account, so it requires
  // self-reported (hence wrapper-git implies EXEC). The EXEC domain accepts self-reported too — a
  // return whose bytes the wrapper could not prove is still RECORDED, and excluded downstream.
  if (domain === 'enumerated' && metric.provenance !== 'self-reported') {
    return refuse(`${at}: the ENUMERATED component domain requires provenance "self-reported" (got ${short(metric.provenance)}) — enumerated bytes are never git-provable`);
  }
  if (sum !== metric.numeratorBytes) {
    return refuse(`${at}: the components sum (${sum}) must equal numeratorBytes (${metric.numeratorBytes}) — the enumeration IS the numerator`);
  }
  return { ok: true };
};

// ── per-field shapes ──────────────────────────────────────────────────────────────────────────────

const FIELD_CHECKS = {
  waveId: { ok: isSafeName, want: 'a wave id in the safe name grammar ([A-Za-z0-9._-]{1,64})' },
  nonce: { ok: isSafeName, want: 'a thread nonce in the safe nonce grammar ([A-Za-z0-9._-]{1,64})' },
  nonceOrNull: { ok: (v) => v === null || isSafeName(v), want: 'a thread nonce in the safe nonce grammar, or null for a pre-dispatch degrade' },
  retryOf: { ok: (v) => v === null || isSafeName(v), want: 'the prior thread nonce this dispatch retries, or null when it is not a retry' },
  stepClass: { ok: (v) => STEP_CLASSES.includes(v), want: `one of the D9 step classes ${STEP_CLASSES.join(' | ')}` },
  stepClasses: {
    ok: (v) => isDenseDataArray(v) && v.length > 0 && v.every((c) => STEP_CLASSES.includes(c)) && new Set(v).size === v.length,
    want: `a non-empty DENSE SET of D9 step classes ${STEP_CLASSES.join(' | ')}`,
  },
  pairingKey: { ok: isNonEmptyString, want: 'the non-empty pairing key the wave pairs observations by' },
  minPerClass: { ok: (v) => Number.isSafeInteger(v) && v >= 1, want: 'a positive integer minimum of observations per class' },
  meanLThreshold: { ok: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0, want: 'a positive finite per-class mean-L threshold' },
  firstPassNum: { ok: isByteCount, want: 'a non-negative integer first-pass numerator' },
  firstPassDen: { ok: (v) => Number.isSafeInteger(v) && v >= 1, want: 'a positive integer first-pass denominator' },
  vehicle: { ok: isPlainObject, want: 'the closed vehicle pair {requested, selected}' },
  backend: { ok: isNonEmptyString, want: 'a non-empty backend name' },
  contractDigest: { ok: isHex64, want: 'the 64-hex digest of the canonical contract header' },
  preTreeDigest: { ok: isHex64, want: 'the 64-hex uncommitted-state fingerprint at dispatch' },
  postTreeDigest: { ok: isHex64, want: 'the 64-hex uncommitted-state fingerprint after the run' },
  diffDigest: { ok: isHex64, want: 'the 64-hex digest of the returned diff' },
  reportDigest: { ok: isHex64, want: 'the 64-hex digest of the returned report' },
  bundleDigest: { ok: isHex64, want: 'the 64-hex digest of the canonical integration bundle' },
  returnDigest: { ok: isHex64, want: 'the 64-hex per-record canonical digest of the folded return' },
  treeDigestAtFold: { ok: isHex64, want: 'the 64-hex uncommitted-state fingerprint at the fold' },
  baselineClean: { ok: (v) => typeof v === 'boolean', want: 'a boolean recording whether the dispatch started from a CLEAN baseline' },
  deadlineS: { ok: (v) => Number.isSafeInteger(v) && v >= 1, want: 'a positive integer deadline in seconds' },
  retryIndex: { ok: isByteCount, want: 'a non-negative integer retry index (0 = the first attempt)' },
  retryCap: { ok: isByteCount, want: 'a non-negative integer retry cap, COPIED from the contract header at mint' },
  rationale: { ok: isNonEmptyString, want: 'a non-empty recorded rationale' },
  role: { ok: (v) => v === 'execute', want: 'exactly "execute" — this ledger records EXEC returns only' },
  diffLength: { ok: isByteCount, want: 'a non-negative safe-integer diff byte length' },
  reportLength: { ok: isByteCount, want: 'a non-negative safe-integer report byte length' },
  bundleLength: { ok: isByteCount, want: 'a non-negative safe-integer bundle byte length' },
  metric: { ok: isPlainObject, want: 'the closed metric object {numeratorBytes, denominatorBytes, components, provenance, eligible, ineligibleReason}' },
  outcome: { ok: (v) => RETURN_OUTCOMES.includes(v), want: `one of the D4 outcomes ${RETURN_OUTCOMES.join(' | ')}` },
  exitStatus: { ok: isByteCount, want: 'a non-negative integer process exit status' },
  sessionId: { ok: (v) => v === null || isNonEmptyString(v), want: 'a non-empty backend session id, or null where no session existed' },
  wrapperVersion: { ok: isNonEmptyString, want: 'the non-empty dispatching wrapper version' },
  posture: { ok: isPlainObject, want: 'the closed posture object {model, effort, tier}' },
  verdict: { ok: isNonEmptyString, want: 'the non-empty fold verdict' },
  scope: { ok: isNonEmptyString, want: 'the non-empty observed scope' },
  planId: { ok: isNonEmptyString, want: 'the non-empty owning plan id' },
  phase: { ok: (v) => Number.isSafeInteger(v) && v >= 1, want: 'a positive integer phase index' },
  timestamp: { ok: isCanonicalInstant, want: 'a canonical UTC ISO instant (toISOString round-trip)' },
};

// Kind-scoped check overrides where one field name carries a different nullability per kind: a
// degrade may precede any dispatch (a pre-dispatch degrade has no thread to name).
const KIND_FIELD_CHECK_OVERRIDES = {
  degrade: { nonce: 'nonceOrNull' },
};

const checkFields = (kind, record) => {
  const overrides = KIND_FIELD_CHECK_OVERRIDES[kind] ?? {};
  const fields = DELEGATION_KEY_SETS[kind];
  const allowed = [...IDENTITY_FIELDS, ...fields];
  const own = Object.keys(record);
  const stray = own.find((k) => !allowed.includes(k));
  if (stray !== undefined) {
    return refuse(`${kind}: unknown field "${stray}" — the key set is closed (the canonical digest is identity; a stray key would fork it)`);
  }
  for (const field of fields) {
    if (!own.includes(field)) {
      return refuse(`${kind}: missing field "${field}" — every field of the closed set is pinned as an OWN ENUMERABLE key (the digest domain)`);
    }
    if (!isDataProperty(record, field)) return refuse(`${kind}: field "${field}" ${ACCESSOR_REFUSAL}`);
    const check = FIELD_CHECKS[overrides[field] ?? field];
    if (!check.ok(record[field])) return refuse(`${kind}: ${field} must be ${check.want} (got ${short(record[field])})`);
  }
  return { ok: true };
};

// ── the record validator ──────────────────────────────────────────────────────────────────────────

const validateDispatchCrossFields = (r) => {
  if ((r.retryIndex === 0) !== (r.retryOf === null)) {
    return r.retryIndex === 0
      ? refuse(`dispatch: retryIndex 0 is the FIRST attempt and carries retryOf null (got ${short(r.retryOf)}) — a retry starts at index 1`)
      : refuse(`dispatch: retryIndex ${r.retryIndex} requires retryOf — a retry records the prior thread nonce it retries`);
  }
  if (r.retryIndex > r.retryCap) {
    return refuse(`dispatch: retryIndex ${r.retryIndex} exceeds the recorded retryCap ${r.retryCap} — a thread never retries past its cap`);
  }
  return { ok: true };
};

const validateReturnCrossFields = (r) => {
  const posture = validatePosture('return: posture', r.posture);
  if (!posture.ok) return posture;
  const metric = validateMetric('return: metric', r.metric, RETURN_PROVENANCE);
  if (!metric.ok) return metric;
  if (r.outcome === 'success' && r.exitStatus !== 0) {
    return refuse(`return: outcome "success" requires exitStatus 0 (got ${r.exitStatus}) — a nonzero exitStatus never reports success`);
  }
  if (r.sessionId === null && !SESSION_ID_NULLABLE_OUTCOMES.includes(r.outcome)) {
    return refuse(`return: sessionId may be null only for ${SESSION_ID_NULLABLE_OUTCOMES.join(' | ')} — outcome "${r.outcome}" requires a non-null sessionId`);
  }
  const framed = expectedBundleLength(r.diffLength, r.reportLength);
  if (framed === null || r.bundleLength !== framed) {
    const why = framed === null ? 'the framing arithmetic leaves the safe-integer range' : `expected ${framed}`;
    return refuse(`return: bundleLength ${r.bundleLength} must equal the D6 framing of diffLength ${r.diffLength} and reportLength ${r.reportLength} (${why})`);
  }
  if (r.metric.denominatorBytes !== r.bundleLength) {
    return refuse(`return: metric.denominatorBytes ${r.metric.denominatorBytes} must equal bundleLength ${r.bundleLength} — the denominator IS the canonical integration bundle`);
  }
  // A return substantiates its own eligibility. `baselineClean` lives on the DISPATCH (D5), so the
  // dirty-baseline arm stays the store's — and it may only ever make the verdict stricter.
  const local = evaluateMetricEligibility({
    baselineClean: true,
    numeratorBytes: r.metric.numeratorBytes,
    diffLength: r.diffLength,
    reportLength: r.reportLength,
    bundleLength: r.bundleLength,
  });
  if (local.ineligibleReason !== null) {
    if (r.metric.eligible) {
      return refuse(`return: this return's own fields make the metric INELIGIBLE (${local.ineligibleReason}) — an eligible metric is never claimed over them`);
    }
    if (r.metric.ineligibleReason !== local.ineligibleReason && r.metric.ineligibleReason !== 'dirty-baseline') {
      return refuse(`return: metric.ineligibleReason "${r.metric.ineligibleReason}" contradicts this return's own fields (locally "${local.ineligibleReason}") — only "dirty-baseline" may override`);
    }
  } else if (!r.metric.eligible && r.metric.ineligibleReason !== 'dirty-baseline') {
    return refuse(`return: metric.ineligibleReason "${r.metric.ineligibleReason}" is not substantiated by this return's own fields — when the local evaluation finds the metric eligible, only "dirty-baseline" (the store-verified override) may be recorded`);
  }
  return { ok: true };
};

const validateObservationCrossFields = (r) => {
  const metric = validateMetric('observation: metric', r.metric, OBSERVATION_PROVENANCE);
  if (!metric.ok) return metric;
  // An observation has no diff, report or bundle — its own two numbers decide, and there is no
  // store-side override arm, so the record must agree with them exactly.
  const local = evaluateObservationEligibility({
    numeratorBytes: r.metric.numeratorBytes,
    denominatorBytes: r.metric.denominatorBytes,
  });
  if (local.ineligibleReason !== null) {
    if (r.metric.eligible) {
      return refuse(`observation: this observation's own numbers make the metric INELIGIBLE (${local.ineligibleReason}) — an eligible metric is never claimed over them`);
    }
    if (r.metric.ineligibleReason !== local.ineligibleReason) {
      return refuse(`observation: metric.ineligibleReason "${r.metric.ineligibleReason}" contradicts this observation's own numbers (locally "${local.ineligibleReason}")`);
    }
  } else if (!r.metric.eligible) {
    return refuse(`observation: metric.ineligibleReason "${r.metric.ineligibleReason}" is not substantiated by this observation's own numbers — an observation carries no store-side override`);
  }
  return { ok: true };
};

// validateDelegationRecord(record) → { ok: true } | { ok: false, reason }. Fail closed on an unknown
// schema/kind, a missing/accessor/malformed field, any key outside the closed per-kind set, and
// every cross-field equality the kind pins. Never throws on a DATA record.
export const validateDelegationRecord = (record) => {
  if (!isPlainObject(record)) return refuse('record is not an object');
  const own = Object.keys(record);
  const missingIdentity = IDENTITY_FIELDS.find((f) => !own.includes(f));
  if (missingIdentity !== undefined) {
    return refuse(`missing field "${missingIdentity}" — the identifying fields are pinned as OWN ENUMERABLE keys BEFORE their values are read (the digest domain)`);
  }
  const accessorIdentity = IDENTITY_FIELDS.find((f) => !isDataProperty(record, f));
  if (accessorIdentity !== undefined) return refuse(`field "${accessorIdentity}" ${ACCESSOR_REFUSAL}`);
  if (record.schema !== DELEGATION_SCHEMA_VERSION) {
    return refuse(`unknown schema ${short(record.schema)} — this reader accepts delegation schema ${DELEGATION_SCHEMA_VERSION} only (fail closed)`);
  }
  if (!DELEGATION_KINDS.includes(record.kind)) {
    return refuse(`unknown kind ${short(record.kind)} — closed set: ${DELEGATION_KINDS.join(' | ')} (fail closed)`);
  }
  const checked = checkFields(record.kind, record);
  if (!checked.ok) return checked;
  if (record.kind === 'pre-registration') {
    return record.firstPassNum <= record.firstPassDen
      ? { ok: true }
      : refuse(`pre-registration: firstPassNum ${record.firstPassNum} must not exceed firstPassDen ${record.firstPassDen} — the threshold is a rate`);
  }
  if (record.kind === 'dispatch') {
    const vehicle = validateVehicle('dispatch: vehicle', record.vehicle);
    return vehicle.ok ? validateDispatchCrossFields(record) : vehicle;
  }
  if (record.kind === 'return') return validateReturnCrossFields(record);
  if (record.kind === 'observation') return validateObservationCrossFields(record);
  return { ok: true };
};

// ── thread successors + terminality (the store consumes these) ────────────────────────────────────

export const allowedSuccessorKinds = (record) => {
  if (!isPlainObject(record)) return [];
  if (record.kind === 'return') return ALLOWED_TRANSITIONS.return[record.outcome] ?? [];
  return ALLOWED_TRANSITIONS[record.kind] ?? [];
};

export const isThreadTerminalRecord = (record) => {
  if (!isPlainObject(record)) return false;
  if (record.kind === 'fold' || record.kind === 'degrade') return true;
  return record.kind === 'return' && TERMINAL_RETURN_OUTCOMES.includes(record.outcome);
};

// ── the per-record canonical digest (the record-reference id domain) ──────────────────────────────

// The family's ONE canonical discipline, imported rather than copied: recursively key-sorted JSON,
// NO trailing newline (the newline is store framing, never record identity).
export const delegationCanonicalSerialization = flowCanonicalSerialization;

export const canonicalDelegationDigest = (record) =>
  createHash('sha256').update(delegationCanonicalSerialization(record), 'utf8').digest('hex');

// ── D8: the sub-task contract header (form only) ──────────────────────────────────────────────────

export const CONTRACT_INFO_STRING = 'aw-dispatch-contract';
export const CONTRACT_KEYS = deepFreeze(['schema', 'nonce', 'stepClass', 'vehicle', 'scope', 'inputs', 'acceptance', 'returnShape', 'producerContract', 'deadlineS', 'retry']);

// Markdown fence grammar: three or more backticks, then an optional info string. A block opened
// with N backticks closes only on a bare fence of at least N — which is exactly how documentation
// nests one fenced block inside another.
const FENCE_RE = /^(`{3,})(.*)$/;

const RETRY_KEYS = ['cap', 'index'];

const validateRetryPolicy = (at, retry) => {
  const closed = checkClosedKeys(at, retry, RETRY_KEYS);
  if (!closed.ok) return closed;
  const bad = RETRY_KEYS.find((k) => !isByteCount(retry[k]));
  if (bad !== undefined) return refuse(`${at}: ${bad} must be a non-negative integer (got ${short(retry[bad])})`);
  return retry.index <= retry.cap ? { ok: true } : refuse(`${at}: index ${retry.index} exceeds cap ${retry.cap}`);
};

const CONTRACT_FIELD_CHECKS = {
  schema: { ok: (v) => v === DELEGATION_SCHEMA_VERSION, want: `exactly ${DELEGATION_SCHEMA_VERSION}` },
  nonce: { ok: isSafeName, want: 'a nonce in the safe grammar ([A-Za-z0-9._-]{1,64})' },
  stepClass: { ok: (v) => STEP_CLASSES.includes(v), want: `one of the D9 step classes ${STEP_CLASSES.join(' | ')}` },
  vehicle: { ok: (v) => validateVehicle('vehicle', v).ok, want: 'the closed vehicle pair {requested, selected} of non-empty names' },
  scope: { ok: isNonEmptyString, want: 'a non-empty scope statement' },
  inputs: { ok: isNonEmptyString, want: 'a non-empty inputs statement' },
  acceptance: { ok: isNonEmptyString, want: 'a non-empty acceptance statement' },
  returnShape: { ok: isNonEmptyString, want: 'a non-empty return-shape statement' },
  producerContract: { ok: isNonEmptyString, want: 'a non-empty producer-contract statement' },
  deadlineS: { ok: (v) => Number.isSafeInteger(v) && v >= 1, want: 'a positive integer deadline in seconds' },
  retry: { ok: (v) => validateRetryPolicy('retry', v).ok, want: 'the closed retry policy {cap, index} of non-negative integers with index <= cap' },
};

// extractContractBlock(text) → { ok: true, source } | { ok: false, reason }. Exactly ONE fenced
// block carrying the aw-dispatch-contract info string, AT TOP LEVEL; absent, unclosed and
// duplicated all refuse. The walk tracks fence nesting, so a contract marker appearing INSIDE
// another fenced block is example text — a documentation block showing the shape must never be
// mistaken for the contract the dispatch file actually carries. Both line endings are accepted: a
// CRLF-authored dispatch file is an ordinary case, and dropping the carriage return cannot move
// contractDigest, which is taken over the PARSED object.
export const extractContractBlock = (text) => {
  if (typeof text !== 'string') return refuse('dispatch contract: the dispatch file must be text');
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let openTicks = 0;
  let openInfo = '';
  let openAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence === null) continue;
    const ticks = fence[1].length;
    const info = fence[2].trim();
    if (openTicks === 0) {
      openTicks = ticks;
      openInfo = info;
      openAt = i;
      continue;
    }
    // Inside an open block, only a BARE fence of at least the opening length closes it; an
    // info-bearing or shorter fence is content.
    if (info === '' && ticks >= openTicks) {
      if (openInfo === CONTRACT_INFO_STRING) blocks.push(lines.slice(openAt + 1, i).join('\n'));
      openTicks = 0;
      openInfo = '';
      openAt = -1;
    }
  }
  if (openTicks !== 0 && openInfo === CONTRACT_INFO_STRING) {
    return refuse(`dispatch contract: the \`\`\`${CONTRACT_INFO_STRING} block is never closed`);
  }
  if (blocks.length === 0) return refuse(`dispatch contract: no top-level \`\`\`${CONTRACT_INFO_STRING} block found — the header is absent (fail closed)`);
  if (blocks.length > 1) return refuse(`dispatch contract: ${blocks.length} \`\`\`${CONTRACT_INFO_STRING} blocks found — a dispatch file carries exactly one`);
  return { ok: true, source: blocks[0] };
};

export const parseDispatchContract = (text) => {
  const block = extractContractBlock(text);
  if (!block.ok) return block;
  let contract;
  try {
    contract = JSON.parse(block.source);
  } catch {
    return refuse('dispatch contract: the block body is not valid JSON (fail closed)');
  }
  if (!isPlainObject(contract)) return refuse(`dispatch contract: the block body must be ONE JSON object (got ${short(contract)})`);
  return { ok: true, contract };
};

// The FORM-only check over an already-parsed header. Names the FIRST violated field and stops —
// form only, by name: a well-formed absurdity passes here (D-R1-FORM-ONLY).
const checkContractObjectForm = (contract) => {
  if (!isPlainObject(contract)) return refuse('dispatch contract: the header must be ONE JSON object');
  const own = Object.keys(contract);
  const stray = own.find((k) => !CONTRACT_KEYS.includes(k));
  if (stray !== undefined) return refuse(`dispatch contract: unknown field "${stray}" — the header key set is closed`);
  for (const field of CONTRACT_KEYS) {
    if (!own.includes(field)) return refuse(`dispatch contract: missing field "${field}"`);
    if (!isDataProperty(contract, field)) return refuse(`dispatch contract: field "${field}" ${ACCESSOR_REFUSAL}`);
    const check = CONTRACT_FIELD_CHECKS[field];
    if (!check.ok(contract[field])) return refuse(`dispatch contract: "${field}" must be ${check.want} (got ${short(contract[field])})`);
  }
  return { ok: true, contract };
};

export const checkDispatchContractForm = (text) => {
  const parsed = parseDispatchContract(text);
  return parsed.ok ? checkContractObjectForm(parsed.contract) : parsed;
};

// D6 — contractDigest is sha256 over the CANONICAL serialization of the PARSED header, so neither
// key order nor whitespace layout can move it.
export const contractDigest = (contract) =>
  createHash('sha256').update(delegationCanonicalSerialization(contract), 'utf8').digest('hex');

// D3 — retryCap (and the rest of the mint-time copy) is COPIED from the contract header at dispatch
// mint, and contractDigest binds the copy. A dispatch that disagrees with the header it claims to
// carry is refused by NAME.
export const checkDispatchMintConsistency = (contract, dispatch) => {
  const form = checkContractObjectForm(contract);
  if (!form.ok) return form;
  if (!isPlainObject(dispatch) || dispatch.kind !== 'dispatch') {
    return refuse(`dispatch mint: the minted record must be a dispatch record (got kind ${short(dispatch?.kind)})`);
  }
  const expected = contractDigest(contract);
  if (dispatch.contractDigest !== expected) {
    return refuse(`dispatch mint: contractDigest ${short(dispatch.contractDigest)} does not bind this header (expected ${expected})`);
  }
  const copies = [
    ['nonce', contract.nonce, dispatch.nonce],
    ['stepClass', contract.stepClass, dispatch.stepClass],
    ['deadlineS', contract.deadlineS, dispatch.deadlineS],
    ['retryCap', contract.retry.cap, dispatch.retryCap],
    ['retryIndex', contract.retry.index, dispatch.retryIndex],
    ['vehicle.requested', contract.vehicle.requested, dispatch.vehicle?.requested],
    ['vehicle.selected', contract.vehicle.selected, dispatch.vehicle?.selected],
  ];
  for (const [name, header, minted] of copies) {
    if (header !== minted) {
      return refuse(`dispatch mint: ${name} is COPIED from the contract header at mint (header ${short(header)}, dispatch ${short(minted)})`);
    }
  }
  return { ok: true };
};

// ── D6: byte domains ──────────────────────────────────────────────────────────────────────────────

// normalizeByteRanges(ranges) → merged, ordered, non-overlapping [start, end) pairs, or null when
// any pair is malformed (non-integer, negative, or empty). Adjacent ranges merge: [0,10) and
// [10,20) describe one contiguous run.
export const normalizeByteRanges = (ranges) => {
  if (!Array.isArray(ranges)) return null;
  const pairs = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const [start, end] = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
    pairs.push([start, end]);
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of pairs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
};

// Null when the total leaves the safe-integer range — every caller refuses on it by name.
const rangeTotal = (ranges) => {
  let total = 0;
  for (const [start, end] of ranges) {
    total += end - start;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
};

// Per-kind entry shapes: which field carries the byte count, the extra REQUIRED fields, and whether
// the kind names an object. Only the enumerated domain carries `ranges` — the exec diff kinds count
// full images, so a partial claim is not expressible there at all.
const ENTRY_SHAPES = {
  new: { size: 'postImageBytes' },
  deleted: { size: 'preImageBytes' },
  modified: { size: 'preImageBytes' },
  renamed: { size: 'preImageBytes', extra: ['fromPath'] },
  binary: { size: 'sizeBytes' },
  symlink: { size: 'sizeBytes' },
  submodule: { size: 'sizeBytes' },
  'non-regular': { size: 'sizeBytes' },
  'gate-output': { size: 'bytes', extra: ['bytePreserved'] },
  enumerated: { size: 'sourceBytes', extra: ['ranges'] },
};

// computeNumerator(entries) → { ok: true, components, numeratorBytes } | { ok: false, reason }.
// Dedup keys on the producer-supplied OBJECT IDENTITY, never on a path: a rename chain (A→B→C) and a
// path re-created after a rename are indistinguishable by name, and either confusion mis-counts. One
// identity also means one SIZE — a second entry claiming that object at a different size refuses.
// Every entry field rides the same descriptor discipline as a record field and is read exactly ONCE
// into a local, so no value can differ between the dedup lookup and the store that follows it.
// The per-entry component records that entry's OWN non-overlapping contribution, so the component
// sum IS the numerator — an object enumerated twice (a rename's two names, a repeated entry, two
// overlapping enumerated ranges) is counted ONCE and the second enumeration records an honest zero.
// One enumeration stays inside ONE domain: mixing git-provable and self-reported bytes into a single
// numerator is what the domain split exists to prevent.
export const computeNumerator = (entries) => {
  if (!isDenseDataArray(entries)) {
    return refuse('numerator: the enumeration must be a DENSE array whose every index is an own enumerable data property');
  }
  const claimed = new Map();
  const components = [];
  let numeratorBytes = 0;
  let domain = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const at = `numerator: entry[${i}]`;
    if (!isPlainObject(entry)) return refuse(`${at} must be an object`);
    if (!isDataProperty(entry, 'kind')) return refuse(`${at}: field "kind" ${ACCESSOR_REFUSAL}`);
    const kind = entry.kind;
    const shape = ENTRY_SHAPES[kind];
    if (shape === undefined) {
      return refuse(`${at}: unknown component kind ${short(kind)} — closed set: ${METRIC_COMPONENT_KINDS.join(' | ')}`);
    }
    const entryDomain = componentDomain(kind);
    if (domain !== null && domain !== entryDomain) {
      return refuse(`${at}: one enumeration never mixes the ${domain} and ${entryDomain} component domains`);
    }
    domain = entryDomain;
    const named = namesAnObject(kind);
    const required = ['kind', shape.size, ...(named ? ['path', 'objectId'] : []), ...(shape.extra ?? [])];
    const own = Object.keys(entry);
    const missing = required.find((k) => !own.includes(k));
    if (missing !== undefined) return refuse(`${at}: missing field "${missing}"`);
    const stray = own.find((k) => !required.includes(k));
    if (stray !== undefined) {
      return refuse(stray === 'ranges'
        ? `${at}: a ${kind} entry never enumerates content ranges — it counts the FULL image; ranges belong to the "enumerated" kind`
        : `${at}: unknown field "${stray}" — the entry key set is closed (${required.join(', ')})`);
    }
    const accessor = required.find((k) => !isDataProperty(entry, k));
    if (accessor !== undefined) return refuse(`${at}: field "${accessor}" ${ACCESSOR_REFUSAL}`);
    // Every field below is read EXACTLY ONCE, into a local.
    const size = entry[shape.size];
    const path = named ? entry.path : null;
    const objectId = named ? entry.objectId : null;
    if (!isByteCount(size)) return refuse(`${at}: ${shape.size} must be a non-negative safe-integer byte count (got ${short(size)})`);
    if (named) {
      if (!isNonEmptyString(path)) return refuse(`${at}: path must be a non-empty path (got ${short(path)})`);
      if (!isNonEmptyString(objectId)) {
        return refuse(`${at}: objectId must be the non-empty stable identity of the object counted — dedup keys on it, never on a path (got ${short(objectId)})`);
      }
      if (kind === 'renamed' && !isNonEmptyString(entry.fromPath)) {
        return refuse(`${at}: fromPath must be a non-empty path (got ${short(entry.fromPath)})`);
      }
    }
    if (kind === 'gate-output') {
      const bytePreserved = entry.bytePreserved;
      if (typeof bytePreserved !== 'boolean') return refuse(`${at}: bytePreserved must be a boolean (got ${short(bytePreserved)})`);
      // Gate output counts ONLY when the wrapper preserved its bytes; a non-preserved run records
      // an explicit zero rather than vanishing from the enumeration.
      const bytes = bytePreserved ? size : 0;
      components.push({ kind, path: null, objectId: null, bytes });
      numeratorBytes += bytes;
      if (!Number.isSafeInteger(numeratorBytes)) return refuse(`${at}: ${UNSAFE_TOTAL}`);
      continue;
    }
    const prior = claimed.get(objectId);
    if (prior !== undefined && prior.size !== size) {
      return refuse(`${at}: objectId ${short(objectId)} was already counted at ${prior.size} bytes but this entry claims ${size} — one identity means one size, so a second size is a producer contradiction, not a bigger object`);
    }
    let ranges;
    if (kind === 'enumerated') {
      ranges = normalizeByteRanges(entry.ranges);
      if (ranges === null) return refuse(`${at}: ranges must be [start, end) pairs of non-negative safe integers with end > start`);
      const beyond = ranges.find(([, end]) => end > size);
      if (beyond !== undefined) return refuse(`${at}: range [${beyond[0]}, ${beyond[1]}) extends beyond the object's ${size} bytes`);
    } else {
      ranges = size === 0 ? [] : [[0, size]];
    }
    const before = prior?.ranges ?? [];
    const merged = normalizeByteRanges([...before, ...ranges]);
    const mergedTotal = rangeTotal(merged);
    const beforeTotal = rangeTotal(before);
    if (mergedTotal === null || beforeTotal === null) return refuse(`${at}: ${UNSAFE_TOTAL}`);
    claimed.set(objectId, { size, ranges: merged });
    const bytes = mergedTotal - beforeTotal;
    components.push({ kind, path, objectId, bytes });
    numeratorBytes += bytes;
    if (!Number.isSafeInteger(numeratorBytes)) return refuse(`${at}: ${UNSAFE_TOTAL}`);
  }
  return { ok: true, components, numeratorBytes };
};

// ── D6: the canonical integration bundle (the denominator) ────────────────────────────────────────

// A LENGTH-PREFIXED two-part framing of (diff, report): boundary-unambiguous BY CONSTRUCTION — the
// reader takes exactly the declared byte count, so no payload can forge a boundary, whatever bytes
// it carries. The framing is also CANONICAL: the length prefix is a bare decimal without padding,
// so one payload pair has exactly one byte sequence and therefore exactly one bundleDigest.
export const BUNDLE_FRAMING_HEADER = 'aw-dispatch-bundle/1\n';
const BUNDLE_HEADER_BYTES = Buffer.from(BUNDLE_FRAMING_HEADER, 'utf8');
const CANONICAL_DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const NEWLINE = 0x0a;

const asBytes = (v) => (Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v, 'utf8') : null);

// Null when either length is not a byte count or the framed total leaves the safe-integer range.
export const expectedBundleLength = (diffLength, reportLength) => {
  if (!isByteCount(diffLength) || !isByteCount(reportLength)) return null;
  const total = BUNDLE_HEADER_BYTES.length
    + String(diffLength).length + 1 + diffLength
    + String(reportLength).length + 1 + reportLength;
  return Number.isSafeInteger(total) ? total : null;
};

export const frameIntegrationBundle = (diff, report) => {
  const diffBytes = asBytes(diff);
  const reportBytes = asBytes(report);
  if (diffBytes === null || reportBytes === null) {
    throw new TypeError('frameIntegrationBundle: both parts must be a Buffer or a string');
  }
  return Buffer.concat([
    BUNDLE_HEADER_BYTES,
    Buffer.from(`${diffBytes.length}\n`, 'utf8'),
    diffBytes,
    Buffer.from(`${reportBytes.length}\n`, 'utf8'),
    reportBytes,
  ]);
};

export const parseIntegrationBundle = (bundle) => {
  const bytes = asBytes(bundle);
  if (bytes === null) return refuse('integration bundle: the input must be a Buffer or a string');
  if (bytes.length < BUNDLE_HEADER_BYTES.length || !bytes.subarray(0, BUNDLE_HEADER_BYTES.length).equals(BUNDLE_HEADER_BYTES)) {
    return refuse(`integration bundle: the framing header ${short(BUNDLE_FRAMING_HEADER)} is absent (fail closed)`);
  }
  let at = BUNDLE_HEADER_BYTES.length;
  const parts = [];
  for (const part of ['diff', 'report']) {
    const newlineAt = bytes.indexOf(NEWLINE, at);
    if (newlineAt === -1) return refuse(`integration bundle: the ${part} length prefix is unterminated`);
    const token = bytes.subarray(at, newlineAt).toString('utf8');
    if (!CANONICAL_DECIMAL_RE.test(token)) {
      return refuse(`integration bundle: the ${part} length prefix ${short(token)} is not a CANONICAL decimal byte count — padding would give one payload pair two framings, and two digests`);
    }
    const length = Number(token);
    if (!Number.isSafeInteger(length)) return refuse(`integration bundle: the ${part} length ${token} leaves the safe-integer range (fail closed)`);
    at = newlineAt + 1;
    if (at + length > bytes.length) return refuse(`integration bundle: the ${part} part is truncated (${bytes.length - at} of ${length} bytes)`);
    parts.push(bytes.subarray(at, at + length));
    at += length;
  }
  if (at !== bytes.length) return refuse(`integration bundle: ${bytes.length - at} trailing byte(s) after the report part`);
  return { ok: true, diff: parts[0], report: parts[1] };
};

// ── D5/D6: metric eligibility ─────────────────────────────────────────────────────────────────────

const ELIGIBILITY_INPUT_KEYS = ['baselineClean', 'numeratorBytes', 'diffLength', 'reportLength', 'bundleLength'];
const OBSERVATION_ELIGIBILITY_INPUT_KEYS = ['numeratorBytes', 'denominatorBytes'];

const checkEligibilityInput = (at, input, keys) => {
  if (!isPlainObject(input)) return refuse(`${at}: the input must be an object`);
  const own = Object.keys(input);
  const stray = own.find((k) => !keys.includes(k));
  if (stray !== undefined) return refuse(`${at}: unknown input "${stray}" — the input key set is closed`);
  const missing = keys.find((k) => !own.includes(k));
  if (missing !== undefined) return refuse(`${at}: missing input "${missing}"`);
  return { ok: true };
};

// The baseline implication is DIRECTIONAL: baselineClean:false FORCES ineligibility (the
// uncommitted-state fingerprint is blind to the index↔worktree split, so a dirty baseline cannot
// attribute bytes to the dispatch); baselineClean:true implies NOTHING — a no-op diff, an empty
// report or a zero-length bundle still make the metric ineligible, each by its own NAME.
//
// This is also the PRODUCER's predicate, evaluated BEFORE framing — which is the only place
// `zero-length-bundle` can arise, since a framed bundle always carries a header and two prefixes.
// A framed return therefore never substantiates that reason, and the return validator refuses one
// that claims it.
export const evaluateMetricEligibility = (input) => {
  const closed = checkEligibilityInput('metric eligibility', input, ELIGIBILITY_INPUT_KEYS);
  if (!closed.ok) return closed;
  if (typeof input.baselineClean !== 'boolean') return refuse(`metric eligibility: baselineClean must be a boolean (got ${short(input.baselineClean)})`);
  const badCount = ELIGIBILITY_INPUT_KEYS.filter((k) => k !== 'baselineClean').find((k) => !isByteCount(input[k]));
  if (badCount !== undefined) return refuse(`metric eligibility: ${badCount} must be a non-negative safe-integer byte count (got ${short(input[badCount])})`);
  const ineligibleReason = input.baselineClean === false ? 'dirty-baseline'
    : input.diffLength === 0 ? 'no-op-diff'
      : input.reportLength === 0 ? 'empty-report'
        : input.bundleLength === 0 ? 'zero-length-bundle'
          : input.numeratorBytes === 0 ? 'zero-byte-proxy'
            : null;
  return { ok: true, eligible: ineligibleReason === null, ineligibleReason };
};

// An observation has no diff, report or bundle — its own two numbers are the whole domain. When
// BOTH are zero the denominator is named FIRST, deterministically: a ratio with no denominator is
// undefined before it is small, and one record must never carry two possible names.
export const evaluateObservationEligibility = (input) => {
  const closed = checkEligibilityInput('observation eligibility', input, OBSERVATION_ELIGIBILITY_INPUT_KEYS);
  if (!closed.ok) return closed;
  const badCount = OBSERVATION_ELIGIBILITY_INPUT_KEYS.find((k) => !isByteCount(input[k]));
  if (badCount !== undefined) return refuse(`observation eligibility: ${badCount} must be a non-negative safe-integer byte count (got ${short(input[badCount])})`);
  const ineligibleReason = input.denominatorBytes === 0 ? 'zero-denominator'
    : input.numeratorBytes === 0 ? 'zero-byte-proxy'
      : null;
  return { ok: true, eligible: ineligibleReason === null, ineligibleReason };
};
