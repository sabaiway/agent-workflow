#!/usr/bin/env node
// review-ledger-core.mjs — the NEUTRAL ledger read/schema core (AD-050). One home for the validated
// review-ledger read path — the path/base resolvers, the tolerant schema validator + reader, and the
// loop/segment filters — extracted VERBATIM from review-ledger.mjs so BOTH read-only checkers can
// share it. review-ledger.mjs already imports review-state.mjs, so review-state.mjs cannot import
// review-ledger.mjs back (the cycle) — the degraded-exemption reader in review-state.mjs imports THIS
// neutral core instead (added in AD-050 Segment 2). review-ledger.mjs consumes + re-exports every
// symbol here for external back-compat — the changed-surface.mjs precedent (AD-048).
//
// Import-graph invariant (pinned by import-split tests): this module imports NOTHING from the
// family — node built-ins only. Everyone may import it; it imports no one:
//   review-ledger.mjs → review-ledger-core.mjs ← review-state.mjs (AD-050 Segment 2)
//
// Read-only: never writes, never commits. It DOES spawn read-only `git` queries (rev-parse).
// Dependency-free, Node >= 18. No side effects on import.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const LEDGER_BASENAME = 'agent-workflow-review-ledger.jsonl';

// SCHEMA_VERSION is what the WRITER emits (M2/AD-046: a fixable-bug triage requires a non-null,
// well-formed testId — the red→green test that pins the fold; BUGFREE-1/AD-047: v3 adds the
// `override` record kind — the loud, durable waiver the fold-completeness gate consumes;
// BUGFREE-2/AD-048: v4 adds the SEGMENT — every record carries `base` = the commit the dirty tree
// sits on, and round numbering / caps / teeth / decideCheck all operate per (activity, loop, base) —
// plus the kind `gate-run` (the D5 green-baseline receipt run-gates --record mints), the override
// scope `size-cap` (the D4 diff-cap waiver), and the triage class `refuted` (the D6 honest lane for
// a phantom finding). The READER tolerates every SUPPORTED_SCHEMAS version under its own
// per-version rules, so historical/live v1..v3 ledgers never retroactively become malformed
// (Decision 2 — a malformed line cascades fail-closed refusals in the writer teeth AND the --check
// gate). v1 records keep the AD-045 rule (testId optional, unenforced); v2+ enforces the
// test-per-fold binding; ONLY v3+ may carry kind `override`; ONLY v4 may carry `base` / kind
// `gate-run` / scope `size-cap` / class `refuted` (older records never grow new surface).
// decideStop never reads testId, overrides, gate-runs, or base (not decideStop inputs — the caller
// passes ONE segment's records, exactly as it passes one loop's; D10: the truth table is untouched).
export const SCHEMA_VERSION = 4;
const SUPPORTED_SCHEMAS = new Set([1, 2, 3, 4]);

// The record vocabulary — the single home of every enum the schema validates.
const ACTIVITIES_SET = new Set(['plan-authoring', 'plan-execution']);
const KINDS_SET = new Set(['round', 'triage']);
const SEVERITIES = new Set(['blocker', 'major', 'minor']);
export const ORIGINS = ['first-draft', 'fold-induced', 'mechanics'];
const CLASSES = new Set(['fixable-bug', 'inherent-layer-residual', 'escalate']);
// v4 (BUGFREE-2 / D6): `refuted` — the honest lane for a phantom finding, refuted against code with
// a MANDATORY non-empty note citing the grounds; never silently dropped, never folded. Exported as
// the code-side vocabulary source the doc-parity lint (BUGFREE-3 / AD-049) checks the contract docs
// against — so the mode files can never drift from the schema's own class/scope lexicon.
export const V4_CLASSES = new Set([...CLASSES, 'refuted']);
const OVERRIDE_SCOPES = new Set(['oracle-change', 'red-proof']);
// v4 (BUGFREE-2 / D4): `size-cap` — the recorded waiver for a changed surface beyond the diff cap;
// exact payload carries the sanctioned magnitude, and it is SEGMENT-scoped (loop + base), unlike
// the two loop-scoped v3 scopes.
export const V4_OVERRIDE_SCOPES = new Set([...OVERRIDE_SCOPES, 'size-cap']);

// ── git-dir resolution (read-only queries; the ledger lives in the git dir, uncommittable) ──────

const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

// The ledger path: AW_REVIEW_LEDGER overrides (mirrors AW_REVIEW_RECEIPTS); else <git dir>/basename.
// null when the cwd is not a git work tree (no git dir to anchor to).
export const resolveLedgerPath = (cwd, env = process.env) => {
  if (env.AW_REVIEW_LEDGER) return env.AW_REVIEW_LEDGER;
  const gitDir = gitLine(['rev-parse', '--absolute-git-dir'], cwd);
  return gitDir == null ? null : join(gitDir, LEDGER_BASENAME);
};

// ── the segment (BUGFREE-2 / AD-048, D1) ─────────────────────────────────────────────────────────
// A SEGMENT = (activity, loop, base) where base = the commit the dirty tree sits on. Derived, never
// declared: `git rev-parse HEAD` is computed identically at write time and check time, matches the
// review's actual domain (the working-tree diff vs HEAD), and its reset is commit-gated — so
// resetting the round counter REQUIRES shipping a green, converged unit. An amend/rebase mid-loop
// orphans the segment's rounds — correct: the reviewed tree no longer exists.

// resolveBase(cwd) → the current HEAD commit sha, or null on an unborn branch / outside a git work
// tree (a caught refusal from git, never a crash — agy R1).
export const resolveBase = (cwd) => gitLine(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);

// ── schema validation (tolerant reader counts + surfaces malformed lines, never drops silently) ──

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

// testId FORMAT (Decision 3): "<repo-relative test file>#<test-name-pattern>" — a "#" separator with
// BOTH halves non-empty. NO file-suffix rule: a suffix check would itself be a special case and would
// block a consumer's own naming (e.g. `.spec.js`; agy R1). The reader validates FORMAT only (it stays
// hermetic); the fold-completeness gate validates RESOLVABILITY via a bound-test probe run. Exported
// (with the splitter) as the single home of the format — the fold-completeness pair validates and
// splits testIds through THESE, so the format can never fork (BUGFREE-1 / AD-047).
const TESTID_SEPARATOR = '#';
export const isWellFormedTestId = (v) => {
  if (typeof v !== 'string') return false;
  const at = v.indexOf(TESTID_SEPARATOR);
  return at > 0 && at < v.length - 1; // separator present, both halves non-empty
};
export const splitTestId = (v) => {
  const at = v.indexOf(TESTID_SEPARATOR);
  return { file: v.slice(0, at), pattern: v.slice(at + 1) };
};

// validateRound(obj) → { ok, reason }. Structural checks + the two internal-consistency invariants:
// the per-backend findings-by-severity equal that backend's counts, and the origins tally equals the
// aggregation of findings[].origin.
const validateRound = (obj) => {
  if (!isPlainObject(obj.origins)) return { ok: false, reason: 'round: missing origins object' };
  for (const k of ORIGINS) if (!isNonNegInt(obj.origins[k])) return { ok: false, reason: `round: origins.${k} must be a non-negative integer` };
  if (!Array.isArray(obj.backends) || obj.backends.length === 0) return { ok: false, reason: 'round: backends must be a non-empty array' };
  for (const b of obj.backends) {
    if (!isPlainObject(b) || !isNonEmptyString(b.backend)) return { ok: false, reason: 'round: each backend needs a backend name' };
    if (typeof b.degraded !== 'boolean') return { ok: false, reason: `round: backend ${b.backend} missing boolean degraded` };
    if (!isNonNegInt(b.blockers) || !isNonNegInt(b.majors) || !isNonNegInt(b.minors)) return { ok: false, reason: `round: backend ${b.backend} counts must be non-negative integers` };
    if (!isNonEmptyString(b.verdict)) return { ok: false, reason: `round: backend ${b.backend} missing verdict` };
    // A degraded backend ran no real review: it MUST carry a reason, record 0/0/0 counts, and its
    // verdict is exactly "degraded". Without this a degraded row could carry a blocking finding while
    // convergence (which excludes degraded backends) still passes — a hidden-blocker hole (codex R1).
    if (b.degraded === true) {
      if (!isNonEmptyString(b.reason)) return { ok: false, reason: `round: degraded backend ${b.backend} must carry a reason` };
      if (b.blockers !== 0 || b.majors !== 0 || b.minors !== 0) return { ok: false, reason: `round: degraded backend ${b.backend} must record 0/0/0 counts (it ran no real review)` };
      if (b.verdict !== 'degraded') return { ok: false, reason: `round: degraded backend ${b.backend} verdict must be "degraded"` };
    }
  }
  // Duplicate backend names would make entryFor / the per-backend consistency ambiguous (agy R1).
  if (new Set(obj.backends.map((b) => b.backend)).size !== obj.backends.length) return { ok: false, reason: 'round: duplicate backend name in backends[]' };
  if (!Array.isArray(obj.findings)) return { ok: false, reason: 'round: findings must be an array' };
  const backendSet = new Set(obj.backends.map((b) => b.backend));
  const degradedSet = new Set(obj.backends.filter((b) => b.degraded === true).map((b) => b.backend));
  for (const f of obj.findings) {
    if (!isPlainObject(f) || !isNonEmptyString(f.findingKey)) return { ok: false, reason: 'round: each finding needs a findingKey' };
    if (!SEVERITIES.has(f.severity)) return { ok: false, reason: `round: finding ${f.findingKey} bad severity "${f.severity}"` };
    if (!ORIGINS.includes(f.origin)) return { ok: false, reason: `round: finding ${f.findingKey} bad origin "${f.origin}"` };
    if (!isNonEmptyString(f.backend)) return { ok: false, reason: `round: finding ${f.findingKey} missing backend` };
    if (!backendSet.has(f.backend)) return { ok: false, reason: `round: finding ${f.findingKey} backend "${f.backend}" is not in backends[]` };
    if (degradedSet.has(f.backend)) return { ok: false, reason: `round: finding ${f.findingKey} references degraded backend ${f.backend} (a degraded backend ran no review, mints no finding)` };
  }
  // Internal consistency: per-backend findings-by-severity equal the recorded counts.
  for (const b of obj.backends) {
    const own = { blocker: 0, major: 0, minor: 0 };
    for (const f of obj.findings) if (f.backend === b.backend) own[f.severity] += 1;
    if (own.blocker !== b.blockers || own.major !== b.majors || own.minor !== b.minors) {
      return { ok: false, reason: `round: findings-vs-counts mismatch for ${b.backend} (findings ${own.blocker}/${own.major}/${own.minor} ≠ counts ${b.blockers}/${b.majors}/${b.minors})` };
    }
  }
  // Internal consistency: the origins tally equals the aggregation of findings[].origin.
  const tally = { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 };
  for (const f of obj.findings) tally[f.origin] += 1;
  for (const k of ORIGINS) if (tally[k] !== obj.origins[k]) return { ok: false, reason: `round: origins-vs-findings mismatch for "${k}" (findings ${tally[k]} ≠ origins ${obj.origins[k]})` };
  return { ok: true };
};

// validateTriage(obj, schema) → { ok, reason }. `schema` selects the per-version rules (v1 tolerant
// testId / v2 the test-per-fold binding / v4 the `refuted` class) — the shared structural checks
// run in every version.
const validateTriage = (obj, schema = SCHEMA_VERSION) => {
  if (!Array.isArray(obj.classifications) || obj.classifications.length === 0) return { ok: false, reason: 'triage: classifications must be a non-empty array' };
  const classes = schema >= 4 ? V4_CLASSES : CLASSES;
  for (const c of obj.classifications) {
    if (!isPlainObject(c) || !isNonEmptyString(c.findingKey)) return { ok: false, reason: 'triage: each classification needs a findingKey' };
    if (!classes.has(c.class)) return { ok: false, reason: `triage: classification ${c.findingKey} bad class "${c.class}"` };
    // D6 — `refuted` is the honest phantom-finding lane: the grounds are MANDATORY (a non-empty
    // note citing what refutes it against code), never a silent drop.
    if (c.class === 'refuted' && !isNonEmptyString(c.note)) return { ok: false, reason: `triage: classification ${c.findingKey} is refuted but carries no note — cite the grounds that refute it against code (mandatory)` };
    if (typeof c.accepted !== 'boolean') return { ok: false, reason: `triage: classification ${c.findingKey} missing boolean accepted` };
    // Structural (BOTH versions): testId is null/absent or a non-empty string — an ABSENT key is
    // treated as null, never rejected here (agy R3). The writer normalizes it to null when stored.
    if (!(c.testId === undefined || c.testId === null || isNonEmptyString(c.testId))) return { ok: false, reason: `triage: classification ${c.findingKey} testId must be null/absent or a non-empty string` };
    // Schema v2 (M2/AD-046) — the test-per-fold binding: a fixable-bug MUST carry a testId (the
    // red→green test that pins the fold), and ANY present testId must be well-formed. v1 keeps the
    // AD-045 rule (testId optional, unenforced) so historical/live v1 ledgers never become malformed.
    if (schema >= 2) {
      const present = isNonEmptyString(c.testId);
      if (c.class === 'fixable-bug' && !present) return { ok: false, reason: `triage: classification ${c.findingKey} is a fixable-bug but carries no testId — record the red→green test that pins the fold (write it first)` };
      if (present && !isWellFormedTestId(c.testId)) return { ok: false, reason: `triage: classification ${c.findingKey} testId "${c.testId}" is malformed — expected "<test-file>#<test-name-pattern>" (a "#" separator, both halves non-empty)` };
    }
    if (typeof c.note !== 'string') return { ok: false, reason: `triage: classification ${c.findingKey} note must be a string` };
  }
  return { ok: true };
};

// validateOverride(obj, schema) → { ok, reason }. v3+ (BUGFREE-1 / AD-047, D3): scope `oracle-change`
// carries non-empty repo-relative files[] + reason; scope `red-proof` carries a REQUIRED
// well-formed testId + reason, no files[]. v4 (BUGFREE-2 / D4) adds scope `size-cap`: a REQUIRED
// positive-integer sanctionedLines — the exact magnitude the waiver sanctions, segment-scoped.
// Payloads are EXACT — a stray cross-scope field is a forgery smell, rejected. The fingerprint is
// recorded for audit only.
const OVERRIDE_SHARED_KEYS = new Set(['schema', 'loop', 'activity', 'kind', 'round', 'base', 'fingerprint', 'timestamp', 'scope', 'reason']);
const OVERRIDE_PAYLOAD_KEY = { 'oracle-change': 'files', 'red-proof': 'testId', 'size-cap': 'sanctionedLines' };
const validateOverride = (obj, schema = SCHEMA_VERSION) => {
  const scopes = schema >= 4 ? V4_OVERRIDE_SCOPES : OVERRIDE_SCOPES;
  if (!scopes.has(obj.scope)) return { ok: false, reason: `override: bad scope "${obj.scope}" (expected ${[...scopes].join(' | ')})` };
  // EXACT per-scope payloads via an allow-list (codex R5): a stray key — a cross-scope field or an
  // arbitrary hand-added one — is a forgery smell, rejected by name (the mutation-shape precedent).
  const payloadKey = OVERRIDE_PAYLOAD_KEY[obj.scope];
  for (const k of Object.keys(obj)) {
    if (!OVERRIDE_SHARED_KEYS.has(k) && k !== payloadKey) return { ok: false, reason: `override: unknown key "${k}" (exact per-scope payloads: shared frame + ${payloadKey})` };
  }
  if (!isNonEmptyString(obj.reason)) return { ok: false, reason: 'override: a non-empty reason is required (never a silent waiver)' };
  if (obj.scope === 'oracle-change') {
    if (!Array.isArray(obj.files) || obj.files.length === 0) return { ok: false, reason: 'override: oracle-change files[] must be a non-empty array' };
    for (const f of obj.files) {
      if (!isNonEmptyString(f) || f.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(f)) return { ok: false, reason: `override: files[] entries must be non-empty repo-relative paths (got ${JSON.stringify(f)})` };
    }
    return { ok: true };
  }
  if (obj.scope === 'size-cap') {
    if (!(Number.isInteger(obj.sanctionedLines) && obj.sanctionedLines >= 1)) return { ok: false, reason: 'override: a size-cap override requires sanctionedLines — the exact positive-integer magnitude it sanctions' };
    return { ok: true };
  }
  if (!isWellFormedTestId(obj.testId)) return { ok: false, reason: 'override: a red-proof override requires a well-formed testId "<test-file>#<test-name-pattern>"' };
  return { ok: true };
};

// ── the gate-run record (BUGFREE-2 / D5): the green-baseline receipt run-gates --record mints ────

// Per-kind frame rule: a gate-run carries the SEGMENT frame (loop, base, fingerprint before/after,
// timestamp) and NO round number. The body is machine-composed by recordGateRun, so the key set is
// EXACT (the override allow-list precedent): declared[] = the FULL declaration at run time (id +
// cmd — the cmd is what the process-gate classification reads); results[] = what actually ran (a
// --only subset records exactly that subset, honestly); summary mirrors the runner's machine
// summary line, consistency-checked against results[] so a forged verdict cannot ride beside
// honest-looking evidence.
const GATE_RUN_KEYS = new Set(['schema', 'loop', 'activity', 'kind', 'base', 'fingerprint', 'fingerprintAfter', 'declared', 'results', 'summary', 'timestamp']);
const SUMMARY_KEYS = ['failed', 'failedIds', 'gates', 'passed', 'status'];
// Gate ids are kebab-case — the same closed shape run-gates.mjs enforces on the declaration; it
// also kills the comma-aliasing class in the failedIds compare (internal sweep).
const GATE_RUN_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const validateGateRun = (obj) => {
  for (const k of Object.keys(obj)) {
    if (!GATE_RUN_KEYS.has(k)) return { ok: false, reason: `gate-run: unknown key "${k}" (exact machine-composed payload)` };
  }
  if (!(obj.fingerprintAfter === null || isNonEmptyString(obj.fingerprintAfter))) return { ok: false, reason: 'gate-run: fingerprintAfter must be null or a non-empty string (the post-run tree)' };
  if (!Array.isArray(obj.declared) || obj.declared.length === 0) return { ok: false, reason: 'gate-run: declared must be a non-empty array of { id, cmd }' };
  const declaredIds = new Set();
  for (const d of obj.declared) {
    if (!isPlainObject(d) || !isNonEmptyString(d.id) || !isNonEmptyString(d.cmd) || Object.keys(d).length !== 2) return { ok: false, reason: 'gate-run: each declared entry must be exactly { id, cmd } (non-empty strings)' };
    if (!GATE_RUN_ID_RE.test(d.id)) return { ok: false, reason: `gate-run: id "${d.id}" must be kebab-case (the run-gates declaration shape)` };
    if (declaredIds.has(d.id)) return { ok: false, reason: `gate-run: duplicate declared id "${d.id}"` };
    declaredIds.add(d.id);
  }
  if (!Array.isArray(obj.results) || obj.results.length === 0) return { ok: false, reason: 'gate-run: results must be a non-empty array of { id, ok, code }' };
  const resultIds = new Set();
  for (const r of obj.results) {
    if (!isPlainObject(r) || !isNonEmptyString(r.id) || typeof r.ok !== 'boolean' || !Number.isInteger(r.code) || Object.keys(r).length !== 3) return { ok: false, reason: 'gate-run: each result must be exactly { id, ok, code } (string, boolean, integer)' };
    if (!declaredIds.has(r.id)) return { ok: false, reason: `gate-run: result id "${r.id}" is not in declared[]` };
    if (resultIds.has(r.id)) return { ok: false, reason: `gate-run: duplicate result id "${r.id}"` };
    resultIds.add(r.id);
  }
  const s = obj.summary;
  if (!isPlainObject(s)) return { ok: false, reason: 'gate-run: summary must be an object' };
  if (Object.keys(s).sort().join(',') !== SUMMARY_KEYS.join(',')) return { ok: false, reason: `gate-run: summary must carry exactly { ${SUMMARY_KEYS.join(', ')} }` };
  const failing = obj.results.filter((r) => !r.ok);
  // The status IS the verdict word: a valid gate-run always carries results, so the runner's
  // vocabulary collapses to ok|fail here — tie it to the failing count (a forged "ok" beside red
  // results must not validate; internal sweep).
  const expectedStatus = failing.length === 0 ? 'ok' : 'fail';
  if (s.status !== expectedStatus) return { ok: false, reason: `gate-run: summary.status must be "${expectedStatus}" for ${failing.length} failing result(s) (got ${JSON.stringify(s.status)})` };
  if (s.gates !== obj.results.length || s.passed !== obj.results.length - failing.length || s.failed !== failing.length) {
    return { ok: false, reason: `gate-run: summary counts do not match results (${s.gates}/${s.passed}/${s.failed} vs ${obj.results.length} results, ${failing.length} failing)` };
  }
  if (!Array.isArray(s.failedIds) || s.failedIds.length !== failing.length || !s.failedIds.every((id, i) => id === failing[i].id)) return { ok: false, reason: 'gate-run: summary.failedIds must equal the failing result ids, in results order' };
  return { ok: true };
};

// validateRecord(obj) → { ok, reason }. The shared frame (schema/loop/activity/kind/round/base/
// fingerprint/timestamp) then the per-kind body. `reason` names the exact failed check so the
// malformed-line surface and the per-check named tests can assert it. Kind vocabulary is
// per-version: `override` exists only under schema >= 3, `gate-run` only under schema >= 4, and
// `base` is a v4-only frame field (older records never grow new kinds OR new fields — D2).
export const validateRecord = (obj) => {
  if (!isPlainObject(obj)) return { ok: false, reason: 'not an object' };
  if (!SUPPORTED_SCHEMAS.has(obj.schema)) return { ok: false, reason: `schema must be one of ${[...SUPPORTED_SCHEMAS].join(', ')}` };
  if (!isNonEmptyString(obj.loop)) return { ok: false, reason: 'missing loop' };
  if (!ACTIVITIES_SET.has(obj.activity)) return { ok: false, reason: `bad activity "${obj.activity}"` };
  if (!KINDS_SET.has(obj.kind) && !(obj.schema >= 3 && obj.kind === 'override') && !(obj.schema >= 4 && obj.kind === 'gate-run')) return { ok: false, reason: `bad kind "${obj.kind}"` };
  // The v4 SEGMENT frame (D1/D2): a v4 record REQUIRES base (null on an unborn branch, else the
  // HEAD sha); a v1..v3 record must NOT carry it — an old record never grows new surface.
  if (obj.schema >= 4) {
    if (!(obj.base === null || isNonEmptyString(obj.base))) return { ok: false, reason: 'a v4 record requires base — null (unborn branch) or the HEAD commit the dirty tree sits on' };
  } else if (obj.base !== undefined) {
    return { ok: false, reason: `base is a v4 frame field — a schema-${obj.schema} record never carries it` };
  }
  // Per-kind frame (D5): a gate-run carries NO round number; every other kind requires one.
  if (obj.kind === 'gate-run') {
    if (obj.round !== undefined) return { ok: false, reason: 'gate-run: a gate-run carries no round number (it is segment-framed, not round-framed)' };
  } else if (!(Number.isInteger(obj.round) && obj.round >= 1)) {
    return { ok: false, reason: 'round must be an integer >= 1' };
  }
  if (!(obj.fingerprint === null || isNonEmptyString(obj.fingerprint))) return { ok: false, reason: 'fingerprint must be null or a non-empty string' };
  if (!isNonEmptyString(obj.timestamp)) return { ok: false, reason: 'missing timestamp' };
  if (obj.kind === 'round') return validateRound(obj);
  if (obj.kind === 'override') return validateOverride(obj, obj.schema);
  if (obj.kind === 'gate-run') return validateGateRun(obj);
  return validateTriage(obj, obj.schema);
};

// readLedger(path) → { records, malformed, malformedReasons }. Absent file → empty (no review ran).
// A malformed line is counted + its reason surfaced, never silently dropped (mirrors readReceipts).
export const readLedger = (path, readFile = readFileSync) => {
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch (err) {
    // An ABSENT file → empty (no review ran). A non-ENOENT read error (EACCES/EIO) is NOT "no records":
    // treating it as empty would fail the teeth OPEN and could clobber the ledger on rewrite (codex R1).
    // Surface it as a readError so every caller (the writer, the gate) fails CLOSED.
    if (err && err.code === 'ENOENT') return { records: [], malformed: 0, malformedReasons: [] };
    return { records: [], malformed: 0, malformedReasons: [], readError: (err && err.code) || (err && err.message) || 'read failed' };
  }
  const records = [];
  const malformedReasons = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      malformedReasons.push(`unparseable JSON (${err.message})`);
      continue;
    }
    const v = validateRecord(parsed);
    if (v.ok) records.push(parsed);
    else malformedReasons.push(v.reason);
  }
  return { records, malformed: malformedReasons.length, malformedReasons };
};

// filterLoopRecords(records, { activity, loop }) → the records of ONE loop (all kinds), order
// preserved. The gate filters to activity==="plan-execution" AND loop===the in-flight plan stem;
// authoring rounds (and other plans' rounds) never enter the code gate.
export const filterLoopRecords = (records, { activity, loop }) =>
  records.filter((r) => r.activity === activity && r.loop === loop);

// filterSegmentRecords(records, { activity, loop, base }) → the records of ONE segment (D1), order
// preserved. STRICT: only a v4+ record can be a segment member (a v1..v3 record carries no base and
// never enters one — the D7 legacy rule; the schema guard also keeps a defensive undefined base
// from matching a pre-v4 record's absent field, codex R1); records at baseA are invisible at baseB;
// base === null matches only null (an unborn-branch segment).
export const filterSegmentRecords = (records, { activity, loop, base }) =>
  filterLoopRecords(records, { activity, loop }).filter((r) => r.schema >= 4 && r.base === base);

// roundSequenceIntact(records) → true iff the round records, in file order, number exactly 1,2,…,n
// (no duplicate, gap, or out-of-order round). Checks the EXISTING sequence, not just the incoming
// round: a ledger like [2] / [1,1] / [2,1] (reachable only by hand-editing the git-dir file — the
// stated residual) must fail closed rather than be trusted to compute the "latest" round (codex R3).
export const roundSequenceIntact = (records) => {
  const nums = records.filter((r) => r.kind === 'round').map((r) => r.round);
  return nums.every((n, i) => n === i + 1);
};
