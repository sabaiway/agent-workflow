// flow-record.mjs — the CLOSED flow-record vocabulary (flow-orchestration, Phase 1). Pure form:
// no filesystem, no git, no CLI, no side effects on import. The store IO (flow-store.mjs) and the
// checker (flow-check.mjs) consume these predicates; nothing here reads or writes a store.
//
// The vocabulary is seeded VERBATIM from the flow design §5 closed kind set and fixed BEFORE any
// reader/writer exists. Every seed member is ASSIGNED to a family (DESIGN_SEED_ASSIGNMENT — the
// drift-guard test binds the shipped vocabulary to exactly this assignment):
//   • chain family — ONE record kind ("chain") keyed {planId, cycle, stepId, round, purpose};
//     design §5's "round-chain" member is realized as the "round" purpose. stepId ENTERS the key
//     domain here (the Phase-1 fixture decision): a record of one step can then never supersede a
//     record of another step. The round purpose carries the dispatch ledger (per-dispatch
//     watermark + nonce + landed receipt/manifest digests — the #41/#42 binding) and the
//     disposition ledger (folded/queued/rejected per finding, each with its proof — #13/#33).
//   • store-global kinds — the rest, each with its own shape and supersession key; the down-mark
//     family (down-mark / down-mark-up / down-mark-clear) shares ONE key so up/clear supersede the
//     mark; maintainer-override keys on its veto instance (vetoReceiptDigest) and every override
//     after the first must supersede the CURRENT head of that instance (#56 — explicit, unforkable
//     supersession). internal-attestation carries the full #28 bound schema (lenses, degraded set,
//     posture object, authority, plan/cycle/step/round + tree identity); consult-attestation binds
//     the consult to the finding AND the proposed fix (#11/#33 — form-provable, semantics stay an
//     honest limit).
// Fail-closed in both directions: unknown schema, unknown kind, unknown purpose, a missing field,
// a malformed field, and an unknown EXTRA field are all refusals — the per-record canonical digest
// is the record's identity, so a stray key would fork it.
//
// Tree identity (#21): every record carries {base, fingerprint}; the transition-shaped records
// (chain/refresh, bookkeeping-delta) carry {fingerprintBefore, fingerprintAfter} and their singular
// identity fingerprint IS fingerprintAfter (flowTreeIdentity). The bookkeeping-delta custody proof
// persists the THREE-LAYER pre-state digest set {headDigest, indexDigest, worktreeDigest} plus the
// derived tracked-ness (#60) — the fingerprint domain distinguishes staged, unstaged, and untracked
// bytes, so a single content digest cannot represent the pre-state.
//
// Reference domain (#63): every inter-record reference is the per-record canonical digest — sha256
// over the canonical (recursively key-sorted, byte-layout-independent) serialization of ONE record.
// Newline rule: the single-record serialization carries NO trailing newline; multi-record framing
// (one line per record) belongs to stores, never to this primitive. A parity test pins these bytes
// against core-evidence's canonicalKindSerialization so the two disciplines cannot drift; the core
// module itself is frozen and stays untouched.
//
// Honest residuals: reference RESOLUTION against a real store (forged / mismatched / superseded
// targets, adoption content-digest binding) lands with flow-store/flow-check; this module resolves
// references only inside an in-memory record list (validateSupersessions) and validates form,
// per-chain sequence legality, and selection. Records remain forgeable — a self-discipline
// mechanism, not a security boundary.

import { createHash } from 'node:crypto';
import { FLOW_SCHEMA_VERSION } from './orchestration-config.mjs';
import { lexicalRepoRelative } from './core-evidence.mjs';

export { FLOW_SCHEMA_VERSION };

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

// ── the closed vocabulary ─────────────────────────────────────────────────────────────────────────

export const CHAIN_KIND = 'chain';
export const CHAIN_PURPOSES = deepFreeze(['adoption', 'round', 'refresh', 're-baseline', 'freeze', 'unfreeze', 'park', 'resume', 'converged', 'complete']);
export const STEP_SCOPED_PURPOSES = deepFreeze(['round', 'refresh', 're-baseline', 'freeze', 'unfreeze', 'converged']);
export const PLAN_LANE_PURPOSES = deepFreeze(['adoption', 'park', 'resume', 'complete']);
export const GLOBAL_KINDS = deepFreeze(['internal-attestation', 'down-mark', 'down-mark-up', 'down-mark-clear', 'degrade-justification', 'rerun-cause', 'bookkeeping-delta', 'maintainer-override', 'consult-attestation']);
export const FLOW_KINDS = deepFreeze([CHAIN_KIND, ...GLOBAL_KINDS]);

// Reserved lane-typed terminals (#16): converged terminates a CYCLE (its step's sequence), complete
// terminates the PLAN. Park is a resumable suspension, never a terminal (#59).
export const TERMINAL_LANES = deepFreeze({ converged: 'cycle', complete: 'plan' });

// Design §5 seed member → family assignment; the drift-guard test binds this map to the verbatim
// seed list on one side and to the shipped CHAIN_PURPOSES/GLOBAL_KINDS on the other.
export const DESIGN_SEED_ASSIGNMENT = deepFreeze({
  adoption: { family: 'chain', purpose: 'adoption' },
  'round-chain': { family: 'chain', purpose: 'round' },
  refresh: { family: 'chain', purpose: 'refresh' },
  're-baseline': { family: 'chain', purpose: 're-baseline' },
  unfreeze: { family: 'chain', purpose: 'unfreeze' },
  freeze: { family: 'chain', purpose: 'freeze' },
  converged: { family: 'chain', purpose: 'converged' },
  park: { family: 'chain', purpose: 'park' },
  resume: { family: 'chain', purpose: 'resume' },
  complete: { family: 'chain', purpose: 'complete' },
  'internal-attestation': { family: 'global', kind: 'internal-attestation' },
  'down-mark': { family: 'global', kind: 'down-mark' },
  'down-mark up': { family: 'global', kind: 'down-mark-up' },
  'down-mark clear': { family: 'global', kind: 'down-mark-clear' },
  'degrade-justification': { family: 'global', kind: 'degrade-justification' },
  'rerun-cause': { family: 'global', kind: 'rerun-cause' },
  'bookkeeping-delta': { family: 'global', kind: 'bookkeeping-delta' },
  'maintainer-override': { family: 'global', kind: 'maintainer-override' },
  'consult-attestation': { family: 'global', kind: 'consult-attestation' },
});

// The allowed-transition table — an exported frozen structure, never prose. Within a step:
// converged ends the sequence (only the unfreeze lane reopens it, and only in its own cycle);
// freeze admits only unfreeze/converged. Plan lane: park admits only resume (and both preserve the
// pre-park cycle/round); complete admits nothing; adoption is only ever the chain's first record.
// The boundary lane (between steps): the opener round, the unfreeze reopen, and a re-baseline for
// disjoint base motion that reopens nothing. The cross-step edge (the opener's prior-terminal
// reference) is enforced by validateChainSequence, distinct from the within-step successor rule.
export const ALLOWED_TRANSITIONS = deepFreeze({
  stepOpening: 'round',
  withinStep: {
    round: ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    refresh: ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    're-baseline': ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    freeze: ['unfreeze', 'converged'],
    unfreeze: ['round', 'refresh', 're-baseline', 'freeze', 'converged'],
    converged: ['unfreeze'],
  },
  planLane: {
    adoption: ['round', 'park', 'complete'],
    park: ['resume'],
    resume: ['round', 'park', 'complete'],
    complete: [],
  },
  boundary: ['round', 'unfreeze', 're-baseline'],
});

// ── field shapes (closed key set per kind/purpose) ────────────────────────────────────────────────

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isHex64 = (v) => typeof v === 'string' && HEX64_RE.test(v);
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
};

const refuse = (reason) => ({ ok: false, reason });

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
  const fieldToCheck = Object.fromEntries(GLOBAL_SHAPES[record.kind].map((f) => [f, f]));
  const checked = checkFields(record.kind, record, fieldToCheck);
  if (!checked.ok) return checked;
  if (record.kind === 'down-mark') {
    if (!isCanonicalInstant(record.timestamp)) return refuse('down-mark: timestamp must be a canonical UTC ISO instant (toISOString round-trip) — the TTL window needs comparable instants');
    if (Date.parse(record.expiresAt) <= Date.parse(record.timestamp)) return refuse('down-mark: expiresAt must be strictly after timestamp — an already-expired mark is refused at the record level');
    return { ok: true };
  }
  return record.kind === 'bookkeeping-delta' ? validateCustodyProof(record.kind, record) : { ok: true };
};

// ── per-kind keys + the authoritative latest-per-key selection ────────────────────────────────────

// JSON-array keys (collision-proof across free-form fields — space-joining would let a planId forge
// a separator). The down-mark family shares ONE key per backend so up/clear supersede the mark;
// maintainer-override keys on its veto instance; internal-attestation keys on
// {plan, cycle, step, round, tree}.
export const flowRecordKey = (record) =>
  record.kind === CHAIN_KIND ? JSON.stringify([CHAIN_KIND, record.planId, record.cycle, record.stepId, record.round, record.purpose])
  : record.kind === 'internal-attestation' ? JSON.stringify([record.kind, record.planId, record.cycle, record.stepId, record.round, record.base, record.fingerprint])
  : record.kind === 'down-mark' || record.kind === 'down-mark-up' || record.kind === 'down-mark-clear' ? JSON.stringify(['down-mark', record.backend])
  : record.kind === 'degrade-justification' ? JSON.stringify([record.kind, record.downMark])
  : record.kind === 'rerun-cause' ? JSON.stringify([record.kind, record.attempt])
  : record.kind === 'bookkeeping-delta' ? JSON.stringify([record.kind, record.fingerprintBefore, record.fingerprintAfter, record.path])
  : record.kind === 'maintainer-override' ? JSON.stringify([record.kind, record.vetoReceiptDigest])
  : record.kind === 'consult-attestation' ? JSON.stringify([record.kind, record.backend, record.nonce])
  : null;

// The authoritative subset: the LATEST record per key, in file order of that latest appearance.
// Raw file order is a separate, surviving view — the transition/ordering checks consume ONLY raw.
export const authoritativeFlowRecords = (records) => {
  const lastByKey = new Map();
  records.forEach((r, i) => {
    const k = flowRecordKey(r);
    if (k != null) lastByKey.set(k, i);
  });
  const keep = new Set(lastByKey.values());
  return records.filter((_, i) => keep.has(i));
};

// ── tree identity (#21) ───────────────────────────────────────────────────────────────────────────

export const isTransitionShaped = (record) =>
  record.kind === 'bookkeeping-delta' || (record.kind === CHAIN_KIND && record.purpose === 'refresh');

// The compound tree identity every flow record carries; for transition-shaped records the singular
// fingerprint IS fingerprintAfter.
export const flowTreeIdentity = (record) => ({
  base: record.base,
  fingerprint: isTransitionShaped(record) ? record.fingerprintAfter : record.fingerprint,
});

// ── per-record canonical digest (#63) — the record-reference id domain ────────────────────────────

const serializeCanonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(serializeCanonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${serializeCanonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

// Canonical bytes of ONE record: recursively key-sorted JSON, NO trailing newline (the newline is
// store framing, not record identity). A parity test pins these bytes against core-evidence's
// canonicalKindSerialization on single-record fixtures.
export const flowCanonicalSerialization = (record) => serializeCanonical(record);

export const canonicalFlowDigest = (record) => createHash('sha256').update(flowCanonicalSerialization(record), 'utf8').digest('hex');

// A same-index round REVISION re-states its round: opensFrom/base/fingerprint/commitEpoch are
// byte-equal to the previous version (the receipt attests the DISPATCHED tree, even when the live
// tree has moved on), existing ledger entries keep their order (a pending dispatch may land IN
// PLACE — both digests arrive together; a landed entry stays byte-identical), and new entries
// append only at the tail. Entry equality is canonical, never insertion-order-sensitive.
const validateRoundRevision = (prev, r) => {
  for (const field of ['opensFrom', 'base', 'fingerprint', 'commitEpoch']) {
    if (r[field] !== prev[field]) {
      return refuse(`chain sequence: a round revision re-states its round — ${field} stays unchanged (the receipt attests the DISPATCHED tree)`);
    }
  }
  if (r.dispatches.length < prev.dispatches.length) {
    return refuse('chain sequence: a round revision never regresses its dispatch ledger (an entry disappeared)');
  }
  for (let i = 0; i < prev.dispatches.length; i += 1) {
    const before = prev.dispatches[i];
    const after = r.dispatches[i];
    if (flowCanonicalSerialization(before) === flowCanonicalSerialization(after)) continue;
    const landedInPlace = before.receiptDigest === null && after.receiptDigest !== null
      && flowCanonicalSerialization({ ...after, receiptDigest: null, findingManifestDigest: null }) === flowCanonicalSerialization(before);
    if (!landedInPlace) {
      return refuse(`chain sequence: a round revision never regresses or mutates its dispatch ledger (entry ${i} — only pending → landed enriches, in place)`);
    }
  }
  if (r.dispositions.length < prev.dispositions.length) {
    return refuse('chain sequence: a round revision never regresses its disposition ledger (an entry disappeared)');
  }
  for (let i = 0; i < prev.dispositions.length; i += 1) {
    if (flowCanonicalSerialization(prev.dispositions[i]) !== flowCanonicalSerialization(r.dispositions[i])) {
      return refuse(`chain sequence: a round revision never regresses its disposition ledger (entry ${i} — existing dispositions stay byte-identical, new ones append at the tail)`);
    }
  }
  return { ok: true };
};

// ── chain sequence legality (raw order, one chain) ────────────────────────────────────────────────

// validateChainSequence(records) → { ok } | { ok: false, reason }. Input: the RAW-order chain
// records of ONE plan's chain. Enforces: starts at adoption and adoption never recurs (#44/#58);
// serial-monotonic step grouping with closure scoped per {cycle, stepId} (a stepId reopens in a
// LATER cycle through an ordinary opener — the redesign valve); the within-step successor table;
// a step opens with "round" carrying the prior-terminal reference (structural half — digest
// resolution against the store lands with flow-check); a boundary re-baseline records disjoint
// base motion anchored to the prior terminal without reopening anything; park admits only resume
// and both preserve the pre-park {cycle, round}; complete admits no successor. Park/resume/complete
// are explicit writer actions — this validator only refuses (#59).
export const validateChainSequence = (records) => {
  if (!Array.isArray(records)) return refuse('chain sequence: records must be an array');
  if (records.length === 0) return { ok: true };
  for (const r of records) {
    if (r?.kind !== CHAIN_KIND) return refuse(`chain sequence: the validator accepts chain records only (got kind ${JSON.stringify(r?.kind)})`);
    const v = validateFlowRecord(r);
    if (!v.ok) return refuse(`chain sequence: malformed member — ${v.reason}`);
    if (r.planId !== records[0].planId) return refuse(`chain sequence: one validator run covers one plan's chain (got "${records[0].planId}" and "${r.planId}")`);
    if (r.owner !== records[0].owner) return refuse(`chain sequence: chain records never migrate owners — every record carries the adoption owner ("${records[0].owner}", got "${r.owner}"); an ownership transfer needs an explicit protocol, never a silent field change`);
  }
  if (records[0].purpose !== 'adoption') {
    return refuse(`chain sequence: the chain starts at adoption — first record is "${records[0].purpose}"`);
  }
  const closureKey = (cycle, stepId) => JSON.stringify([cycle, stepId]);
  const state = {
    mode: 'boundary',
    parked: null,
    completed: false,
    currentStep: null,
    stepCycle: null,
    currentRound: null,
    lastPurpose: null,
    lastTerminated: null,
    boundaryRound: records[0].round,
    closedSteps: new Set(),
    lastCycle: records[0].cycle,
    lastEpoch: records[0].commitEpoch,
    roundLedgers: new Map(),
  };
  const contextCycle = () => (state.mode === 'in-step' ? state.stepCycle : state.lastCycle);
  const contextRound = () => (state.mode === 'in-step' ? state.currentRound : state.boundaryRound);
  const ledgerKey = (r) => JSON.stringify([r.cycle, r.stepId, r.round]);
  for (const r of records.slice(1)) {
    const p = r.purpose;
    if (state.completed) return refuse('chain sequence: complete admits no successor');
    if (r.cycle < state.lastCycle) return refuse(`chain sequence: the cycle index is monotonic (${state.lastCycle} → ${r.cycle})`);
    // A same-index round record is a LEDGER REVISION — a non-lifecycle enrichment that repeats the
    // DISPATCHED tree's epoch and never enters the lifecycle epoch cursor.
    const isRevision = p === 'round' && state.mode === 'in-step' && state.parked === null
      && r.stepId === state.currentStep && r.round === state.currentRound;
    if (!isRevision) {
      if (r.commitEpoch < state.lastEpoch) return refuse(`chain sequence: commitEpoch never regresses (${state.lastEpoch} → ${r.commitEpoch})`);
      state.lastEpoch = r.commitEpoch;
    }
    if (state.parked !== null) {
      if (p !== 'resume') return refuse(`chain sequence: park admits only resume (got "${p}")`);
      if (r.cycle !== state.parked.cycle || r.round !== state.parked.round) {
        return refuse(`chain sequence: resume must carry the pre-park cycle and round (${state.parked.cycle}/${state.parked.round}, got ${r.cycle}/${r.round}) — a new cycle starts by an explicit transition after resume`);
      }
      state.parked = null;
      continue;
    }
    if (p === 'adoption') return refuse("chain sequence: adoption is only ever the chain's first record");
    if (PLAN_LANE_PURPOSES.includes(p)) {
      if (p === 'park') {
        if (r.cycle !== contextCycle() || r.round !== contextRound()) {
          return refuse(`chain sequence: park must carry the pre-park cycle and round (${contextCycle()}/${contextRound()}, got ${r.cycle}/${r.round})`);
        }
        state.parked = { cycle: r.cycle, round: r.round };
      } else if (p === 'resume') {
        return refuse('chain sequence: resume without a preceding park');
      } else {
        if (state.mode === 'in-step') return refuse('chain sequence: complete may not interrupt an open step — the step ends at converged');
        state.completed = true;
        state.lastCycle = r.cycle;
      }
      continue;
    }
    if (state.mode === 'in-step') {
      if (r.stepId !== state.currentStep) {
        return refuse(`chain sequence: step sequences are serial — a record of step "${r.stepId}" interleaves open step "${state.currentStep}"`);
      }
      if (r.cycle !== state.stepCycle) return refuse('chain sequence: the cycle changes only at a step boundary');
      if (!ALLOWED_TRANSITIONS.withinStep[state.lastPurpose].includes(p)) {
        return refuse(`chain sequence: illegal within-step transition ${state.lastPurpose} → ${p} (allowed: ${ALLOWED_TRANSITIONS.withinStep[state.lastPurpose].join(', ')})`);
      }
      if (p === 'round') {
        if (r.round === state.currentRound) {
          const revised = validateRoundRevision(state.roundLedgers.get(ledgerKey(r)), r);
          if (!revised.ok) return revised;
          state.roundLedgers.set(ledgerKey(r), r);
          continue;
        }
        if (r.round < state.currentRound) return refuse(`chain sequence: the round index must increase within a step (${state.currentRound} → ${r.round})`);
        if (r.opensFrom !== null) return refuse('chain sequence: only a step-opening round carries a prior-terminal reference');
        state.currentRound = r.round;
        state.roundLedgers.set(ledgerKey(r), r);
      } else if (r.round !== state.currentRound) {
        return refuse(`chain sequence: a non-round record carries its step's current round index (${state.currentRound}, got ${r.round})`);
      }
      state.lastPurpose = p;
      if (p === 'converged') {
        state.mode = 'boundary';
        state.closedSteps.add(closureKey(state.stepCycle, state.currentStep));
        state.lastTerminated = { step: state.currentStep, round: state.currentRound, cycle: state.stepCycle };
        state.boundaryRound = state.currentRound;
      }
    } else if (p === 'unfreeze') {
      if (state.lastTerminated === null) return refuse('chain sequence: unfreeze requires a prior converged terminal');
      if (r.stepId !== state.lastTerminated.step) {
        return refuse(`chain sequence: unfreeze reopens only the step that just converged ("${state.lastTerminated.step}", got "${r.stepId}")`);
      }
      if (r.round !== state.lastTerminated.round) return refuse('chain sequence: unfreeze carries the converged round index');
      if (r.cycle !== state.lastTerminated.cycle) {
        return refuse("chain sequence: unfreeze reopens only in its terminal's cycle — a later cycle reopens the stepId through an ordinary opening round");
      }
      state.mode = 'in-step';
      state.currentStep = r.stepId;
      state.stepCycle = r.cycle;
      state.currentRound = r.round;
      state.lastPurpose = 'unfreeze';
      state.closedSteps.delete(closureKey(r.cycle, r.stepId));
    } else if (p === 're-baseline') {
      const anchorStep = state.lastTerminated === null ? null : state.lastTerminated.step;
      if (r.stepId !== anchorStep) {
        return refuse(`chain sequence: a boundary re-baseline anchors to the prior terminal's stepId (${JSON.stringify(anchorStep)}, got ${JSON.stringify(r.stepId)}) — it reopens nothing`);
      }
      if (r.round !== state.boundaryRound) return refuse(`chain sequence: a boundary re-baseline carries the boundary round index (${state.boundaryRound}, got ${r.round})`);
      if (r.cycle !== state.lastCycle) return refuse('chain sequence: a re-baseline never moves the cycle — base motion is not a redesign');
    } else if (p === ALLOWED_TRANSITIONS.stepOpening) {
      if (state.closedSteps.has(closureKey(r.cycle, r.stepId))) {
        return refuse(`chain sequence: step "${r.stepId}" already converged in cycle ${r.cycle} — a converged step reopens only through the unfreeze lane`);
      }
      if (r.opensFrom === null) {
        return refuse("chain sequence: a step-opening round must carry the prior-terminal reference (opensFrom) — the plan's first step references the adoption record itself");
      }
      if (r.round < 1) return refuse('chain sequence: a step opens at round 1 or later');
      state.mode = 'in-step';
      state.currentStep = r.stepId;
      state.stepCycle = r.cycle;
      state.currentRound = r.round;
      state.lastPurpose = 'round';
      state.roundLedgers.set(ledgerKey(r), r);
    } else {
      return refuse(`chain sequence: a step sequence opens with "${ALLOWED_TRANSITIONS.stepOpening}" (got "${p}")`);
    }
    state.lastCycle = r.cycle;
  }
  return { ok: true };
};

// ── stateful-kind supersession legality (raw order, in-memory list) ───────────────────────────────

// validateSupersessions(records) → { ok } | { ok: false, reason }. Walks RAW order and resolves
// supersession targets among EARLIER records by per-record canonical digest: down-mark-up/clear
// must target an earlier down-mark of the SAME backend; a maintainer-override chain is linear per
// veto instance — the first override carries supersedes: null, every later one must supersede the
// CURRENT head (a stale target would fork the chain and let latest-per-key bury a live override
// without explicit supersession, #56). Out-of-order and mis-targeted supersessions refuse by name.
export const validateSupersessions = (records, digestOf = canonicalFlowDigest) => {
  const seen = new Map();
  const overrideHeads = new Map();
  const activeMarks = new Map();
  for (const r of records) {
    if (r.kind === 'down-mark') {
      if (activeMarks.has(r.backend)) {
        return refuse(`down-mark: backend "${r.backend}" already carries an ACTIVE down-mark — it must be explicitly closed by up/clear before a new mark lands (supersession is explicit, never silent)`);
      }
      activeMarks.set(r.backend, digestOf(r));
    }
    if (r.kind === 'down-mark-up' || r.kind === 'down-mark-clear') {
      const target = seen.get(r.target);
      if (target === undefined) return refuse(`${r.kind}: the supersession target does not resolve to an EARLIER record (out-of-order or unknown) — a supersession lands only after its down-mark`);
      if (target.kind !== 'down-mark') return refuse(`${r.kind}: the supersession target is a ${target.kind}, not a down-mark (mis-targeted)`);
      if (target.backend !== r.backend) return refuse(`${r.kind}: the supersession target belongs to backend "${target.backend}", not "${r.backend}" (mis-targeted)`);
      const active = activeMarks.get(r.backend);
      if (active === undefined) return refuse(`${r.kind}: no active down-mark for backend "${r.backend}" — the family is closed (or never opened); a new down-mark opens a new instance`);
      if (r.target !== active) return refuse(`${r.kind}: the supersession targets a stale down-mark — up/clear must target the backend's ACTIVE mark`);
      activeMarks.delete(r.backend);
    }
    if (r.kind === 'maintainer-override') {
      const head = overrideHeads.get(r.vetoReceiptDigest);
      if (r.supersedes === null) {
        if (head !== undefined) return refuse('maintainer-override: only the first override of a veto instance carries supersedes: null — a later override must supersede the CURRENT head');
      } else {
        const target = seen.get(r.supersedes);
        if (target === undefined) return refuse('maintainer-override: supersedes does not resolve to an EARLIER record (out-of-order or unknown)');
        if (target.kind !== 'maintainer-override') return refuse(`maintainer-override: supersedes must target a maintainer-override record, not a ${target.kind} (mis-targeted)`);
        if (target.vetoReceiptDigest !== r.vetoReceiptDigest) return refuse('maintainer-override: the supersession crosses veto instances — one override binds exactly one veto instance (mis-targeted)');
        if (r.supersedes !== head) return refuse('maintainer-override: supersedes targets a STALE override — a later override must supersede the CURRENT head of its veto instance');
      }
      overrideHeads.set(r.vetoReceiptDigest, digestOf(r));
    }
    seen.set(digestOf(r), r);
  }
  return { ok: true };
};
