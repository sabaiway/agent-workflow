// exec-receipt.mjs — the wrapper-minted EXEC RECEIPT contract (delegation Plan 2, Phase 1). Pure
// form: no filesystem, no git, no CLI, no side effects on import. The bridge wrapper MINTS these
// bytes; `dispatch return` (Phase 2) reads them and absorbs the run into the delegation ledger.
//
// Why the artifact exists at all: the bridge is dependency-free bash with NO path to the kit
// (codex-cli-bridge/capability.json detect.installed resolves the BRIDGE's own directory), so it
// cannot append to the ledger — a bash-side append would re-implement the lock/CAS leaf and could not
// run the store's cross-record preflight, a second and drifting legality door. The wrapper therefore
// mints what it can PROVE about its own run, and the kit absorbs it through the one append door.
//
// TWO STATES, one path (D1). `reserved` is written atomically and no-clobber BEFORE the run is spent
// — that write IS the nonce reservation, so a duplicate nonce refuses before any spend. `terminal`
// replaces it at exit, written by the run that owns the reservation. The state split is what makes
// the artifact a safe arrival signal: `terminal` means the report beside it is already complete.
//
// The reserved state carries everything knowable PRE-SPEND (wrapperVersion, posture, capS,
// killGraceS, contractDigest) and NULL in every terminal-only field, so a `--no-receipt` absorb can
// still source the fields a tree cannot supply. A reserved receipt filling a terminal-only field
// refuses: the two states are distinguishable by their content, not only by their label.
//
// `contractDigest` is computed by the WRAPPER from the dispatch file it was actually handed — an
// independently produced value, never a copy of what the ledger holds. Without it the store's
// return↔dispatch correlation would compare the dispatch record against values derived from itself,
// and a run that executed a DIFFERENT contract would correlate cleanly.
//
// The wrapper's outcome vocabulary is a SUBSET of the ledger's (D3): a run can prove only what it
// observed about itself. `success` = exit 0 with a session id; `missing-identity` = exit 0 without
// one; `transport-failure` = any nonzero exit, the timeout codes included. Every orchestrator
// judgment (contract-refusal, partial-edit, acceptance-failure, stale-return, store-failure) is
// recorded at absorb time, never claimed here.
//
// Named grammars are taken by reference, never re-stated: the safe token grammar SAFE_NONCE_RE and
// the 64-hex digest. Descriptor discipline follows dispatch-record.mjs — own enumerable DATA
// properties only, each read exactly once, so the bytes a validator approved are the bytes a reader
// re-reads.
//
// Honest limit: a receipt is forgeable, exactly like every other record in this family. What it
// defends against is a BUGGY or interrupted producer, not a hostile one.
//
// Second honest limit, stated where the name is built: the length prefix closes the SEPARATOR
// ambiguity, not the CASE one. `Codex` and `codex` are both safe tokens and compose different names —
// but the same FILE on a case-insensitive filesystem, where an atomic no-clobber mint could then
// refuse a legitimately different dispatch. Closing it means narrowing a grammar the FAMILY owns
// (SAFE_NONCE_RE lives in flow-record.mjs and is taken by reference here), and the review lane's
// manifest names carry the identical axis — so it is one family decision, queued as
// ARTIFACT-BASENAME-NOT-INJECTIVE, not a local fork.

import { SAFE_NONCE_RE } from './flow-record.mjs';

const refuse = (reason) => ({ ok: false, reason });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isSafeToken = (v) => typeof v === 'string' && SAFE_NONCE_RE.test(v);

// The artifact name is LENGTH-PREFIXED, and that is what makes it injective. Both tokens share the
// safe grammar, which admits `-`, so a plain `<backend>-<nonce>` join is ambiguous: {backend "a-b",
// nonce "c"} and {backend "a", nonce "b-c"} compose the SAME file, and the no-clobber reservation
// would then refuse a genuinely different dispatch. Restricting the backend instead was tried and
// rejected — the ledger's own contract (dispatch-record.mjs) admits any safe token as a backend, so
// a stricter rule here would record dispatches whose receipts could never be named. The length
// prefix keeps every character inside the safe set, keeps the name greppable, and recovers the pair:
// read digits to the first `-`, take that many characters as the backend, the remainder is the nonce.
const lengthPrefixed = (prefix, backend, nonce, suffix) =>
  (isSafeToken(backend) && isSafeToken(nonce) ? `${prefix}${backend.length}-${backend}-${nonce}${suffix}` : null);
const isCanonicalInstant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const isByteCount = (v) => Number.isSafeInteger(v) && v >= 0;

const isDataProperty = (obj, field) => {
  const descriptor = Object.getOwnPropertyDescriptor(obj, field);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
};

const ACCESSOR_REFUSAL = 'is an ACCESSOR — a receipt field must be a data property, or a re-read could answer differently than the validator did';

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

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

// ── the closed vocabulary ─────────────────────────────────────────────────────────────────────────

export const EXEC_RECEIPT_SCHEMA_VERSION = 1;
export const EXEC_RECEIPT_KIND = 'exec-receipt';

export const EXEC_RECEIPT_STATES = deepFreeze(['reserved', 'terminal']);

export const EXEC_RECEIPT_KEYS = deepFreeze([
  'state', 'backend', 'nonce', 'owner', 'contractDigest', 'wrapperVersion', 'posture',
  'capS', 'killGraceS', 'sessionId', 'exitStatus', 'outcome', 'reportDigest', 'reportLength', 'timestamp',
]);

// The fields only a finished run can fill; a reservation carries null in every one of them.
export const TERMINAL_ONLY_FIELDS = deepFreeze(['sessionId', 'exitStatus', 'outcome', 'reportDigest', 'reportLength']);

// D3 — the three outcomes a wrapper can prove about its own run.
export const WRAPPER_OUTCOMES = deepFreeze(['success', 'transport-failure', 'missing-identity']);

const POSTURE_KEYS = deepFreeze(['model', 'effort', 'tier']);

const IDENTITY_FIELDS = ['schema', 'kind'];

export const EXEC_RECEIPT_BASENAME_PREFIX = 'agent-workflow-exec-receipt-';
export const EXEC_REPORT_BASENAME_PREFIX = 'agent-workflow-exec-report-';

// The {backend, nonce}-derived artifact names. Null when either token leaves the safe grammar — an
// unsafe token would compose a path, and a name that can escape its directory is never built.
export const execReceiptBasename = (backend, nonce) =>
  lengthPrefixed(EXEC_RECEIPT_BASENAME_PREFIX, backend, nonce, '.json');

export const execReportBasename = (backend, nonce) =>
  lengthPrefixed(EXEC_REPORT_BASENAME_PREFIX, backend, nonce, '.txt');

// ── per-field shapes ──────────────────────────────────────────────────────────────────────────────

const FIELD_CHECKS = {
  state: { ok: (v) => EXEC_RECEIPT_STATES.includes(v), want: `one of ${EXEC_RECEIPT_STATES.join(' | ')}` },
  backend: { ok: isSafeToken, want: 'a backend name in the safe token grammar ([A-Za-z0-9._-]{1,64})' },
  nonce: { ok: isSafeToken, want: 'a dispatch nonce in the safe token grammar ([A-Za-z0-9._-]{1,64})' },
  owner: { ok: isNonEmptyString, want: 'the non-empty opaque token identifying the run that holds the reservation' },
  contractDigest: { ok: isHex64, want: 'the 64-hex digest the WRAPPER computed from the dispatch file it ran' },
  wrapperVersion: { ok: isNonEmptyString, want: 'the non-empty minting wrapper version' },
  posture: { ok: isPlainObject, want: 'the closed posture object {model, effort, tier}' },
  capS: { ok: (v) => Number.isSafeInteger(v) && v >= 1, want: 'the positive integer wall-clock cap the run ACTUALLY applied' },
  killGraceS: { ok: isByteCount, want: 'the non-negative integer kill grace the run ACTUALLY applied' },
  sessionId: { ok: (v) => v === null || isNonEmptyString(v), want: 'a non-empty backend session id, or null where no session existed' },
  exitStatus: { ok: (v) => v === null || isByteCount(v), want: 'a non-negative integer process exit status, or null on a reservation' },
  outcome: { ok: (v) => v === null || WRAPPER_OUTCOMES.includes(v), want: `one of ${WRAPPER_OUTCOMES.join(' | ')}, or null on a reservation` },
  reportDigest: { ok: (v) => v === null || isHex64(v), want: 'the 64-hex digest of the report artifact, or null when no report was written' },
  reportLength: { ok: (v) => v === null || isByteCount(v), want: 'the non-negative byte length of the report artifact, or null on a reservation' },
  timestamp: { ok: isCanonicalInstant, want: 'a canonical UTC ISO instant (toISOString round-trip)' },
};

const validatePosture = (posture) => {
  if (!isPlainObject(posture)) return refuse('posture must be an object');
  const own = Object.keys(posture);
  const stray = own.find((k) => !POSTURE_KEYS.includes(k));
  if (stray !== undefined) return refuse(`posture: unknown field "${stray}" — the posture key set is closed`);
  const missing = POSTURE_KEYS.find((k) => !own.includes(k));
  if (missing !== undefined) return refuse(`posture: missing field "${missing}"`);
  const accessor = POSTURE_KEYS.find((k) => !isDataProperty(posture, k));
  if (accessor !== undefined) return refuse(`posture: field "${accessor}" ${ACCESSOR_REFUSAL}`);
  if (!isNonEmptyString(posture.model)) return refuse(`posture: model must be a non-empty model name (got ${short(posture.model)})`);
  const bad = ['effort', 'tier'].find((k) => posture[k] !== null && !isNonEmptyString(posture[k]));
  return bad === undefined ? { ok: true } : refuse(`posture: ${bad} must be a non-empty string or null (got ${short(posture[bad])})`);
};

// The state contract, both directions: a reservation proves nothing about a run that has not
// finished, and a terminal receipt that left a terminal field null would be a reservation wearing the
// wrong label.
const validateStateFields = (receipt) => {
  if (receipt.state === 'reserved') {
    const filled = TERMINAL_ONLY_FIELDS.find((f) => receipt[f] !== null);
    return filled === undefined
      ? { ok: true }
      : refuse(`a RESERVED receipt carries null in every terminal-only field — "${filled}" is ${short(receipt[filled])}; a reservation is minted before the run is spent and can prove nothing about its outcome`);
  }
  const empty = ['exitStatus', 'outcome', 'reportLength'].find((f) => receipt[f] === null);
  if (empty !== undefined) {
    return refuse(`a TERMINAL receipt requires "${empty}" — a null there is a reservation wearing the terminal label`);
  }
  return { ok: true };
};

// D3's mapping, enforced as a TOTAL relation so no run can record an outcome its own numbers deny.
const validateOutcomeMapping = (receipt) => {
  if (receipt.state !== 'terminal') return { ok: true };
  if (receipt.outcome === 'success') {
    if (receipt.exitStatus !== 0) return refuse(`outcome "success" requires exitStatus 0 (got ${receipt.exitStatus}) — a nonzero exit never reports success`);
    if (receipt.sessionId === null) return refuse('outcome "success" requires a non-null sessionId — a run that identified no session is "missing-identity"');
    return { ok: true };
  }
  if (receipt.outcome === 'missing-identity') {
    if (receipt.exitStatus !== 0) return refuse(`outcome "missing-identity" requires exitStatus 0 (got ${receipt.exitStatus}) — a nonzero exit is "transport-failure"`);
    if (receipt.sessionId !== null) return refuse(`outcome "missing-identity" requires sessionId null (got ${short(receipt.sessionId)})`);
    return { ok: true };
  }
  return receipt.exitStatus === 0
    ? refuse('outcome "transport-failure" requires a nonzero exitStatus — a run that exited 0 is "success" or "missing-identity"')
    : { ok: true };
};

// A TERMINAL receipt always has a report behind it — that is the publication ORDER, not a courtesy:
// the report is written atomically FIRST and the reservation is replaced by the terminal receipt
// LAST, and a wrapper that cannot complete either write exits nonzero having published no terminal
// receipt at all. So on `terminal` the digest is REQUIRED, and an empty report stays perfectly
// expressible as the sha256 of no bytes with reportLength 0. The absent form belongs to the
// reservation (both fields null), which is exactly what the `--no-receipt` absorb lane reads.
const validateReportPair = (receipt) => {
  if (receipt.state !== 'terminal') return { ok: true };
  if (receipt.reportDigest !== null) return { ok: true };
  return refuse(`a TERMINAL receipt requires a reportDigest (reportLength ${receipt.reportLength}) — the report is published BEFORE the terminal receipt replaces the reservation, so a terminal artifact with no report behind it is a state no completed run mints; an EMPTY report is the sha256 of no bytes with length 0`);
};

// validateExecReceipt(receipt) → { ok: true } | { ok: false, reason }. Fail closed on an unknown
// schema/kind/state, a missing, accessor or malformed field, any key outside the closed set, and every
// cross-field relation the state pins. Never throws on a DATA record.
export const validateExecReceipt = (receipt) => {
  if (!isPlainObject(receipt)) return refuse('exec receipt is not an object');
  const own = Object.keys(receipt);
  const missingIdentity = IDENTITY_FIELDS.find((f) => !own.includes(f));
  if (missingIdentity !== undefined) return refuse(`missing field "${missingIdentity}" — the identifying fields are read before any value is`);
  const accessorIdentity = IDENTITY_FIELDS.find((f) => !isDataProperty(receipt, f));
  if (accessorIdentity !== undefined) return refuse(`field "${accessorIdentity}" ${ACCESSOR_REFUSAL}`);
  if (receipt.schema !== EXEC_RECEIPT_SCHEMA_VERSION) {
    return refuse(`unknown schema ${short(receipt.schema)} — this reader accepts exec-receipt schema ${EXEC_RECEIPT_SCHEMA_VERSION} only (fail closed)`);
  }
  if (receipt.kind !== EXEC_RECEIPT_KIND) {
    return refuse(`unknown kind ${short(receipt.kind)} — this reader accepts "${EXEC_RECEIPT_KIND}" only (fail closed)`);
  }
  const allowed = [...IDENTITY_FIELDS, ...EXEC_RECEIPT_KEYS];
  const stray = own.find((k) => !allowed.includes(k));
  if (stray !== undefined) return refuse(`unknown field "${stray}" — the exec-receipt key set is closed`);
  for (const field of EXEC_RECEIPT_KEYS) {
    if (!own.includes(field)) return refuse(`missing field "${field}"`);
    if (!isDataProperty(receipt, field)) return refuse(`field "${field}" ${ACCESSOR_REFUSAL}`);
    if (!FIELD_CHECKS[field].ok(receipt[field])) {
      return refuse(`${field} must be ${FIELD_CHECKS[field].want} (got ${short(receipt[field])})`);
    }
  }
  const posture = validatePosture(receipt.posture);
  if (!posture.ok) return posture;
  const state = validateStateFields(receipt);
  if (!state.ok) return state;
  const mapping = validateOutcomeMapping(receipt);
  if (!mapping.ok) return mapping;
  return validateReportPair(receipt);
};

// parseExecReceipt(text) → { ok: true, receipt } | { ok: false, reason }.
export const parseExecReceipt = (text) => {
  if (typeof text !== 'string') return refuse('exec receipt: the artifact must be text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('exec receipt: the artifact is not valid JSON (fail closed)');
  }
  const valid = validateExecReceipt(parsed);
  return valid.ok ? { ok: true, receipt: parsed } : valid;
};

// The wrapper's own mapping, exported so the bridge's minted bytes and the kit's expectation come from
// ONE rule rather than two implementations that agree today (D3).
export const wrapperOutcomeFor = (exitStatus, sessionId) => {
  if (!isByteCount(exitStatus)) return null;
  if (exitStatus !== 0) return 'transport-failure';
  return isNonEmptyString(sessionId) ? 'success' : 'missing-identity';
};
