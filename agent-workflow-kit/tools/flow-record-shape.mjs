// flow-record-shape.mjs — the CLOSED per-kind field shapes and the per-record validator: the field
// primitives beyond the five shared ones, FIELD_CHECKS, the per-purpose and per-kind shape tables,
// the Decision-8 earliest diagnosis index, checkFields, the two round-ledger arms (dispatches and
// dispositions), the bookkeeping-delta custody proof, and validateFlowRecord. Split out of
// flow-record.mjs unchanged (baseline-practices tranche 3), which now re-exports both public names
// here (SUBSET_ATTEMPT_DIAGNOSIS_FROM, validateFlowRecord).
//
// Pure form: no filesystem, no git, no CLI, no side effects on import. Imports run ONE way — the
// vocabulary leaf owns the closed kind/purpose sets and the shared form bindings this module states
// its refusals in, repo-lex.mjs owns the lexical path rule, and the legality leaf composes this
// module; nothing here reaches back up to the facade.

import { lexicalRepoRelative } from './repo-lex.mjs';
import {
  CHAIN_KIND, CHAIN_PURPOSES, FLOW_KINDS, FLOW_SCHEMA_VERSION,
  HEX64_RE, isHex64, isNonEmptyString, isPlainObject, refuse,
} from './flow-vocabulary.mjs';

// ── field shapes (closed key set per kind/purpose) ────────────────────────────────────────────────

const HEX40_RE = /^[0-9a-f]{40}$/;
const isSha = (v) => typeof v === 'string' && (HEX40_RE.test(v) || HEX64_RE.test(v));
const isCanonicalInstant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const isUniqueNonEmptyStrings = (v) => Array.isArray(v) && v.every(isNonEmptyString) && new Set(v).size === v.length;

const POSTURE_KEYS = ['model', 'effort', 'tier'];
const isClosedPosture = (v) => isPlainObject(v)
  && Object.keys(v).length === POSTURE_KEYS.length && POSTURE_KEYS.every((k) => k in v)
  && isNonEmptyString(v.model)
  && (v.effort === null || isNonEmptyString(v.effort))
  && (v.tier === null || isNonEmptyString(v.tier));

const FIELD_CHECKS = {
  base: { ok: (v) => v === null || isSha(v), want: 'the 40- or 64-hex base sha, or null on an unborn branch' },
  baseBefore: { ok: isSha, want: 'the 40- or 64-hex pre-motion base sha' },
  timestamp: { ok: isNonEmptyString, want: 'a non-empty timestamp string' },
  fingerprint: { ok: isHex64, want: 'a 64-hex tree fingerprint' },
  fingerprintBefore: { ok: isHex64, want: 'a 64-hex tree fingerprint' },
  fingerprintAfter: { ok: isHex64, want: 'a 64-hex tree fingerprint' },
  planId: { ok: isNonEmptyString, want: 'a non-empty plan id' },
  cycle: { ok: (v) => Number.isInteger(v) && v >= 1, want: 'a positive integer cycle index' },
  round: { ok: (v) => Number.isInteger(v) && v >= 0, want: 'a non-negative integer round index' },
  commitEpoch: { ok: (v) => Number.isInteger(v) && v >= 0, want: 'a non-negative integer commit epoch' },
  owner: { ok: isNonEmptyString, want: 'the non-empty owning-worktree identity' },
  stepId: { ok: isNonEmptyString, want: 'a non-empty step id' },
  stepIdNull: { ok: (v) => v === null, want: 'null — this purpose is plan-lane, never step-scoped' },
  stepIdOrNull: { ok: (v) => v === null || isNonEmptyString(v), want: 'a non-empty step id, or null at a pre-first-step boundary' },
  opensFrom: { ok: (v) => v === null || isHex64(v), want: 'the 64-hex prior-terminal record digest, or null off the step opening' },
  dispatches: { ok: Array.isArray, want: 'the dispatch-ledger array (may be empty until dispatches land)' },
  dispositions: { ok: Array.isArray, want: 'the disposition-ledger array (may be empty until findings land)' },
  planLabel: { ok: isNonEmptyString, want: 'the non-empty plan label' },
  createdAt: { ok: isNonEmptyString, want: 'a non-empty created-at string' },
  planDigest: { ok: isHex64, want: 'the 64-hex plan content digest' },
  cause: { ok: isNonEmptyString, want: 'a non-empty declared cause' },
  refreshedRecord: { ok: isHex64, want: 'the 64-hex digest of the record this refresh re-attests' },
  backend: { ok: isNonEmptyString, want: 'a non-empty backend name' },
  reason: { ok: isNonEmptyString, want: 'a non-empty reason' },
  expiresAt: { ok: isCanonicalInstant, want: 'a canonical UTC ISO instant (toISOString round-trip)' },
  target: { ok: isHex64, want: 'the 64-hex digest of the down-mark this record supersedes' },
  downMark: { ok: isHex64, want: 'the 64-hex digest of the down-mark this justification rides on' },
  degradeDigest: { ok: isHex64, want: 'the 64-hex per-record canonical digest of the core degrade record' },
  attempt: { ok: isNonEmptyString, want: 'the non-empty red final attempt id' },
  path: { ok: (v) => isNonEmptyString(v) && lexicalRepoRelative(v).ok, want: 'a non-empty lexically repo-relative path' },
  contentDigest: { ok: (v) => v === null || isHex64(v), want: 'the 64-hex post-change content digest, or null when the path lands absent' },
  custodyProof: { ok: isPlainObject, want: 'the persisted proof object {preClass, tracked, headDigest, indexDigest, worktreeDigest, maskedFingerprint}' },
  vetoReceiptDigest: { ok: isHex64, want: 'the 64-hex digest of the vetoing receipt' },
  verdict: { ok: isNonEmptyString, want: 'the non-empty vetoing verdict' },
  chainRecord: { ok: isHex64, want: 'the 64-hex digest of the bound chain record' },
  supersedes: { ok: (v) => v === null || isHex64(v), want: 'the 64-hex digest of the superseded override, or null on the first override of a veto instance' },
  nonce: { ok: isNonEmptyString, want: 'the non-empty wrapper nonce' },
  lenses: { ok: (v) => isUniqueNonEmptyStrings(v) && v.length > 0, want: 'a non-empty array of unique non-empty lens names (the required-lens set)' },
  degraded: { ok: isUniqueNonEmptyStrings, want: 'an array of unique non-empty backend names (may be empty)' },
  posture: { ok: isClosedPosture, want: 'the closed posture object {model: non-empty, effort: non-empty|null, tier: non-empty|null}' },
  authority: { ok: isNonEmptyString, want: 'the non-empty attesting authority' },
  findingDigest: { ok: isHex64, want: 'the 64-hex digest of the consulted finding' },
  proposedFixDigest: { ok: isHex64, want: 'the 64-hex digest of the proposed fix under consult' },
  foldBatch: { ok: isHex64, want: 'the 64-hex digest of the owning round identity projection {planId, cycle, stepId, round}' },
  subsetDigest: { ok: isHex64, want: "the 64-hex digest of the derived subset's ordered gate ids" },
  attemptIndex: { ok: (v) => Number.isInteger(v) && v >= 1, want: 'a positive integer attempt index (monotonic per counting context)' },
  status: { ok: (v) => v === 'green' || v === 'red', want: 'the closed enum green | red' },
  diagnosis: { ok: isNonEmptyString, want: 'a non-empty diagnosis statement (Decision 8 — the recorded continuation past two reds)' },
};

const CHAIN_COMMON_FIELDS = ['planId', 'cycle', 'round', 'commitEpoch', 'owner', 'base', 'timestamp'];

// Per-purpose closed field sets. "stepIdNull" routes stepId through the plan-lane check; the
// transition-shaped refresh carries fingerprintBefore/After and deliberately NO singular
// fingerprint field (flowTreeIdentity supplies it). re-baseline's stepId is the prior-terminal
// anchor at a boundary (null only before the first step) or the open step inside one.
const PURPOSE_SHAPES = {
  adoption: { stepId: 'stepIdNull', fields: ['fingerprint', 'planLabel', 'createdAt', 'planDigest'] },
  round: { stepId: 'stepId', fields: ['fingerprint', 'opensFrom', 'dispatches', 'dispositions'] },
  refresh: { stepId: 'stepId', fields: ['fingerprintBefore', 'fingerprintAfter', 'cause', 'refreshedRecord'] },
  're-baseline': { stepId: 'stepIdOrNull', fields: ['fingerprint', 'baseBefore'] },
  freeze: { stepId: 'stepId', fields: ['fingerprint'] },
  unfreeze: { stepId: 'stepId', fields: ['fingerprint'] },
  park: { stepId: 'stepIdNull', fields: ['fingerprint'] },
  resume: { stepId: 'stepIdNull', fields: ['fingerprint'] },
  converged: { stepId: 'stepId', fields: ['fingerprint'] },
  complete: { stepId: 'stepIdNull', fields: ['fingerprint'] },
};

const GLOBAL_SHAPES = {
  'internal-attestation': ['fingerprint', 'planId', 'stepId', 'cycle', 'round', 'lenses', 'degraded', 'posture', 'authority', 'base', 'timestamp'],
  'down-mark': ['fingerprint', 'backend', 'reason', 'expiresAt', 'base', 'timestamp'],
  'down-mark-up': ['fingerprint', 'backend', 'target', 'base', 'timestamp'],
  'down-mark-clear': ['fingerprint', 'backend', 'target', 'base', 'timestamp'],
  'degrade-justification': ['fingerprint', 'downMark', 'degradeDigest', 'base', 'timestamp'],
  'rerun-cause': ['fingerprint', 'cause', 'attempt', 'base', 'timestamp'],
  'bookkeeping-delta': ['fingerprintBefore', 'fingerprintAfter', 'path', 'contentDigest', 'custodyProof', 'base', 'timestamp'],
  'maintainer-override': ['fingerprint', 'vetoReceiptDigest', 'backend', 'verdict', 'chainRecord', 'supersedes', 'base', 'timestamp'],
  'consult-attestation': ['fingerprint', 'backend', 'nonce', 'planId', 'cycle', 'stepId', 'round', 'findingDigest', 'proposedFixDigest', 'base', 'timestamp'],
  'subset-attempt': ['planId', 'cycle', 'stepId', 'foldBatch', 'subsetDigest', 'attemptIndex', 'status', 'base', 'fingerprint', 'timestamp'],
};

// Kind-scoped check overrides where a field name collides across kinds (Decision 7): the
// subset-attempt stepId is nullable — attempts before any round key the ADOPTION context.
const GLOBAL_FIELD_CHECK_OVERRIDES = {
  'subset-attempt': { stepId: 'stepIdOrNull' },
};

// Decision 8: attempts 1-2 are the blind budget and never carry a diagnosis — this is the
// earliest index one MAY ride. REQUIRED-ness keys on the key's red count (>= 2, past the second
// red) and lives in the store gate + the locked factory: a record-local validator cannot see
// the key history, and a green history never owes a diagnosis.
export const SUBSET_ATTEMPT_DIAGNOSIS_FROM = 3;

const checkFields = (label, record, fieldToCheck) => {
  const allowed = ['schema', 'kind', ...(record.kind === CHAIN_KIND ? ['purpose'] : []), ...Object.keys(fieldToCheck)];
  const stray = Object.keys(record).find((k) => !allowed.includes(k));
  if (stray !== undefined) return refuse(`${label}: unknown field "${stray}" — the key set is closed (the digest is identity; a stray key would fork it)`);
  for (const [field, checkId] of Object.entries(fieldToCheck)) {
    if (!(field in record)) return refuse(`${label}: missing field "${field}" — every required field is pinned`);
    const check = FIELD_CHECKS[checkId];
    if (!check.ok(record[field])) return refuse(`${label}: ${field} must be ${check.want}`);
  }
  return { ok: true };
};

// The per-dispatch ledger entry (#41/#42): watermark + nonce minted BEFORE dispatch; the receipt
// digest and the finding-manifest digest land TOGETHER once the receipt arrives.
const DISPATCH_KEYS = ['backend', 'dispatchBase', 'receiptWatermark', 'dispatchNonce', 'receiptDigest', 'findingManifestDigest'];

const validateDispatches = (label, list) => {
  const seenIdentities = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const d = list[i];
    const at = `${label}: dispatches[${i}]`;
    if (!isPlainObject(d)) return refuse(`${at} must be an object`);
    const stray = Object.keys(d).find((k) => !DISPATCH_KEYS.includes(k));
    if (stray !== undefined) return refuse(`${at}: unknown field "${stray}" — the dispatch key set is closed`);
    const missing = DISPATCH_KEYS.find((k) => !(k in d));
    if (missing !== undefined) return refuse(`${at}: missing field "${missing}"`);
    const identity = JSON.stringify([d.backend, d.dispatchNonce]);
    if (seenIdentities.has(identity)) return refuse(`${at}: duplicate dispatch identity {backend, dispatchNonce} — one ledger entry per dispatch (the watermark is payload, never identity)`);
    seenIdentities.add(identity);
    if (!isNonEmptyString(d.backend)) return refuse(`${at}: backend must be a non-empty backend name`);
    if (d.dispatchBase !== null && !isSha(d.dispatchBase)) return refuse(`${at}: dispatchBase must be the 40- or 64-hex base at dispatch, or null on an unborn branch`);
    if (!Number.isInteger(d.receiptWatermark) || d.receiptWatermark < 0) return refuse(`${at}: receiptWatermark must be a non-negative integer (the receipts-file position minted before dispatch)`);
    if (!isNonEmptyString(d.dispatchNonce)) return refuse(`${at}: dispatchNonce must be a non-empty string`);
    for (const field of ['receiptDigest', 'findingManifestDigest']) {
      if (d[field] !== null && !isHex64(d[field])) return refuse(`${at}: ${field} must be a 64-hex digest, or null while the dispatch is pending`);
    }
    if ((d.receiptDigest === null) !== (d.findingManifestDigest === null)) {
      return refuse(`${at}: receiptDigest and findingManifestDigest land together — both null while pending, both 64-hex once the receipt landed`);
    }
  }
  return { ok: true };
};

// The per-finding disposition ledger (#13/#33): every council finding lands as exactly one of the
// three closed arms, each carrying its proof (a consult-attestation/red-proof digest, a debt entry,
// or a stated rejection reason).
const DISPOSITION_KEYS = {
  folded: ['findingDigest', 'action', 'proofKind', 'proofDigest'],
  queued: ['findingDigest', 'action', 'debtId', 'debtDigest'],
  rejected: ['findingDigest', 'action', 'reason'],
};

const validateDispositions = (label, list) => {
  const seenFindings = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const d = list[i];
    const at = `${label}: dispositions[${i}]`;
    if (!isPlainObject(d)) return refuse(`${at} must be an object`);
    const armKeys = Object.hasOwn(DISPOSITION_KEYS, d.action) ? DISPOSITION_KEYS[d.action] : undefined;
    if (armKeys === undefined) return refuse(`${at}: action must be one of ${Object.keys(DISPOSITION_KEYS).join(' | ')} (got ${JSON.stringify(d.action)}) — an inherited prototype key never resolves an arm (fail closed)`);
    const stray = Object.keys(d).find((k) => !armKeys.includes(k));
    if (stray !== undefined) return refuse(`${at}: unknown field "${stray}" — the ${d.action} arm's key set is closed`);
    const missing = armKeys.find((k) => !(k in d));
    if (missing !== undefined) return refuse(`${at}: missing field "${missing}"`);
    if (!isHex64(d.findingDigest)) return refuse(`${at}: findingDigest must be the 64-hex digest of the finding`);
    if (seenFindings.has(d.findingDigest)) return refuse(`${at}: duplicate findingDigest — every finding gets exactly one disposition, whichever the arm`);
    seenFindings.add(d.findingDigest);
    if (d.action === 'folded') {
      if (d.proofKind !== 'consult-attestation' && d.proofKind !== 'red-proof') return refuse(`${at}: proofKind must be consult-attestation | red-proof (the fold's proof record class)`);
      if (!isHex64(d.proofDigest)) return refuse(`${at}: proofDigest must be the 64-hex digest of the proof record`);
    } else if (d.action === 'queued') {
      if (!isNonEmptyString(d.debtId)) return refuse(`${at}: debtId must be the non-empty stable debt-queue id`);
      if (!isHex64(d.debtDigest)) return refuse(`${at}: debtDigest must be the 64-hex digest of the debt entry`);
    } else if (!isNonEmptyString(d.reason)) {
      return refuse(`${at}: reason must be a non-empty statement of why the finding is rejected`);
    }
  }
  return { ok: true };
};

// The three-layer pre-state digest set (#60): HEAD entry, index entry, worktree bytes — null means
// "no entry in that layer". tracked-ness is derived (a HEAD or index entry exists); the presence
// class is the WORKTREE layer. The fingerprint domain (staged + unstaged + untracked) is exactly
// what these three layers reconstruct for the masked recompute.
const CUSTODY_PROOF_KEYS = ['preClass', 'tracked', 'headDigest', 'indexDigest', 'worktreeDigest', 'maskedFingerprint'];
const PRE_STATE_CLASSES = ['present', 'absent'];

const validateCustodyProof = (label, record) => {
  const proof = record.custodyProof;
  const stray = Object.keys(proof).find((k) => !CUSTODY_PROOF_KEYS.includes(k));
  if (stray !== undefined) return refuse(`${label}: custodyProof carries unknown field "${stray}" — the proof key set is closed`);
  const missing = CUSTODY_PROOF_KEYS.find((k) => !(k in proof));
  if (missing !== undefined) return refuse(`${label}: custodyProof is missing field "${missing}"`);
  if (!PRE_STATE_CLASSES.includes(proof.preClass)) return refuse(`${label}: custodyProof.preClass must be one of ${PRE_STATE_CLASSES.join(' | ')} — any other pre-state class refuses to mint by name (fail closed)`);
  if (typeof proof.tracked !== 'boolean') return refuse(`${label}: custodyProof.tracked must be a boolean`);
  for (const field of ['headDigest', 'indexDigest', 'worktreeDigest']) {
    if (proof[field] !== null && !isHex64(proof[field])) return refuse(`${label}: custodyProof.${field} must be a 64-hex content digest, or null when that layer has no entry`);
  }
  if (!isHex64(proof.maskedFingerprint)) return refuse(`${label}: custodyProof.maskedFingerprint must be the 64-hex masked-recompute fingerprint`);
  if ((proof.preClass === 'absent') !== (proof.worktreeDigest === null)) {
    return refuse(`${label}: custodyProof.worktreeDigest must be null exactly when preClass is "absent" — the worktree layer IS the presence class`);
  }
  if (proof.tracked !== (proof.headDigest !== null || proof.indexDigest !== null)) {
    return refuse(`${label}: custodyProof.tracked must equal the presence of a HEAD or index entry — a mismatched tracked-ness is a forged pre-state`);
  }
  if (proof.preClass === 'absent' && record.contentDigest === null) {
    return refuse(`${label}: the absent→absent pre-state transition is unsupported — supported: present→present, present→absent, absent→present (fail closed)`);
  }
  return { ok: true };
};

// validateFlowRecord(record) → { ok: true } | { ok: false, reason }. Fail closed on unknown
// schema/kind/purpose, a missing/malformed field, or any key outside the closed per-kind set.
export const validateFlowRecord = (record) => {
  if (!isPlainObject(record)) return refuse('record is not an object');
  if (record.schema !== FLOW_SCHEMA_VERSION) {
    return refuse(`unknown schema ${JSON.stringify(record.schema)} — this reader accepts flow schema ${FLOW_SCHEMA_VERSION} only (fail closed)`);
  }
  if (!FLOW_KINDS.includes(record.kind)) {
    return refuse(`unknown kind ${JSON.stringify(record.kind)} — closed set: ${FLOW_KINDS.join(' | ')} (fail closed)`);
  }
  if (record.kind === CHAIN_KIND) {
    if (!CHAIN_PURPOSES.includes(record.purpose)) {
      return refuse(`chain: unknown purpose ${JSON.stringify(record.purpose)} — closed set: ${CHAIN_PURPOSES.join(' | ')} (fail closed)`);
    }
    const shape = PURPOSE_SHAPES[record.purpose];
    const label = `chain/${record.purpose}`;
    const fieldToCheck = Object.fromEntries([
      ...CHAIN_COMMON_FIELDS.map((f) => [f, f]),
      ['stepId', shape.stepId],
      ...shape.fields.map((f) => [f, f]),
    ]);
    const checked = checkFields(label, record, fieldToCheck);
    if (!checked.ok) return checked;
    if (record.purpose !== 'round') return { ok: true };
    const dispatches = validateDispatches(label, record.dispatches);
    if (!dispatches.ok) return dispatches;
    return validateDispositions(label, record.dispositions);
  }
  const overrides = GLOBAL_FIELD_CHECK_OVERRIDES[record.kind] ?? {};
  const fieldToCheck = Object.fromEntries(GLOBAL_SHAPES[record.kind].map((f) => [f, overrides[f] ?? f]));
  if (record.kind === 'subset-attempt' && 'diagnosis' in record) {
    if (!(Number.isInteger(record.attemptIndex) && record.attemptIndex >= SUBSET_ATTEMPT_DIAGNOSIS_FROM)) {
      return refuse(`subset-attempt: diagnosis rides only attemptIndex ${SUBSET_ATTEMPT_DIAGNOSIS_FROM} and later (Decision 8) — attempts 1-2 are the blind budget and never carry one`);
    }
    fieldToCheck.diagnosis = 'diagnosis';
  }
  const checked = checkFields(record.kind, record, fieldToCheck);
  if (!checked.ok) return checked;
  if (record.kind === 'down-mark') {
    if (!isCanonicalInstant(record.timestamp)) return refuse('down-mark: timestamp must be a canonical UTC ISO instant (toISOString round-trip) — the TTL window needs comparable instants');
    if (Date.parse(record.expiresAt) <= Date.parse(record.timestamp)) return refuse('down-mark: expiresAt must be strictly after timestamp — an already-expired mark is refused at the record level');
    return { ok: true };
  }
  return record.kind === 'bookkeeping-delta' ? validateCustodyProof(record.kind, record) : { ok: true };
};
