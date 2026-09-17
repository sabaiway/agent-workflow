// core-evidence-store-read.mjs — the read half of the evidence store: testId format, path, schema, reader and keys; the contract is the header of core-evidence.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lexicalRepoRelative } from './repo-lex.mjs';
// The coverage vocabulary leaf: run-gates RECORDS the token this validator checks, and run-gates
// imports core-evidence (the sole-writer boundary), so their shared home sits below both.
import { COVERAGE, FINAL_COVERAGE_STATES } from './coverage-state.mjs';
import { gitLine } from './core-evidence-tree.mjs';

// testId FORMAT: "<repo-relative test file>#<test-name-pattern>" — a "#" separator with BOTH halves
// non-empty. Format-only (no suffix rule); resolvability is the probe's job.
const TESTID_SEPARATOR = '#';
export const isWellFormedTestId = (v) => {
  if (typeof v !== 'string') return false;
  const at = v.indexOf(TESTID_SEPARATOR);
  return at > 0 && at < v.length - 1;
};
export const splitTestId = (v) => {
  const at = v.indexOf(TESTID_SEPARATOR);
  return { file: v.slice(0, at), pattern: v.slice(at + 1) };
};

// ── the store: ONE git-dir JSONL file (D7) ────────────────────────────────────────────────────────

export const EVIDENCE_BASENAME = 'agent-workflow-core-evidence.jsonl';
export const EVIDENCE_SCHEMA_VERSION = 1;

// AW_CORE_EVIDENCE overrides (the AW_REVIEW_RECEIPTS idiom); else <git dir>/basename; null outside
// a git work tree.
export const resolveEvidencePath = (cwd, env = process.env) => {
  if (env.AW_CORE_EVIDENCE) return env.AW_CORE_EVIDENCE;
  const gitDir = gitLine(['rev-parse', '--absolute-git-dir'], cwd);
  return gitDir == null ? null : join(gitDir, EVIDENCE_BASENAME);
};

// ── schema validation (closed kinds, per-kind arms; unknown schema/kind fail CLOSED) ──────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;


export const validateEvidenceRecord = (record) => {
  if (!isPlainObject(record)) return { ok: false, reason: 'record is not an object' };
  if (record.schema !== EVIDENCE_SCHEMA_VERSION) {
    return { ok: false, reason: `unknown schema ${JSON.stringify(record.schema)} — this reader accepts schema ${EVIDENCE_SCHEMA_VERSION} only (fail closed)` };
  }
  if (record.kind === 'red-proof') {
    if (!isWellFormedTestId(record.testId)) return { ok: false, reason: 'red-proof: testId must be "<test-file>#<test-name-pattern>" (a "#" separator, both halves non-empty)' };
    if (!isNonEmptyString(record.file)) return { ok: false, reason: 'red-proof: file must be the non-empty repo-relative test-file path' };
    const lex = lexicalRepoRelative(record.file);
    if (!lex.ok) return { ok: false, reason: `red-proof: file must be lexically repo-relative — ${lex.reason}` };
    if (record.file !== splitTestId(record.testId).file) return { ok: false, reason: 'red-proof: file must equal the testId file half — one path source of truth (a mismatched declaration is refused)' };
    if (typeof record.fileHash !== 'string' || !HEX64_RE.test(record.fileHash)) return { ok: false, reason: 'red-proof: fileHash must be a 64-hex sha256 of the test-file bytes' };
    if (!Number.isInteger(record.runs) || record.runs < 1) return { ok: false, reason: 'red-proof: runs must be a positive integer' };
    if (record.reds !== record.runs) return { ok: false, reason: 'red-proof: reds must equal runs — an observed-red declaration is N/N by construction' };
    if (record.base !== null && (typeof record.base !== 'string' || !(HEX40_RE.test(record.base) || HEX64_RE.test(record.base)))) return { ok: false, reason: 'red-proof: base must be the 40- or 64-hex HEAD sha (git sha1/sha256 object formats), or null on an unborn branch' };
    if (typeof record.fingerprint !== 'string' || !HEX64_RE.test(record.fingerprint)) return { ok: false, reason: 'red-proof: fingerprint must be the 64-hex PRE-FIX tree fingerprint' };
    if (!isNonEmptyString(record.timestamp)) return { ok: false, reason: 'red-proof: timestamp must be a non-empty string' };
    return { ok: true };
  }
  if (record.kind === 'degrade') {
    if (typeof record.backend !== 'string' || record.backend.trim() === '') return { ok: false, reason: 'degrade: backend must be a non-empty string (whitespace-only is refused)' };
    if (typeof record.reason !== 'string' || record.reason.trim() === '') return { ok: false, reason: 'degrade: reason must be a non-empty string — a degrade without a stated reason is refused (fail closed)' };
    if (typeof record.fingerprint !== 'string' || !HEX64_RE.test(record.fingerprint)) return { ok: false, reason: 'degrade: fingerprint must be the 64-hex tree fingerprint the degrade attests' };
    if (!isNonEmptyString(record.timestamp)) return { ok: false, reason: 'degrade: timestamp must be a non-empty string' };
    return { ok: true };
  }
  if (record.kind === 'final-start') {
    if (typeof record.fingerprint !== 'string' || !HEX64_RE.test(record.fingerprint)) return { ok: false, reason: 'final-start: fingerprint must be the 64-hex tree fingerprint the attempt targets' };
    if (!isNonEmptyString(record.attempt)) return { ok: false, reason: 'final-start: attempt must be a non-empty id — the completion closes exactly THIS start (linkage)' };
    if (!isNonEmptyString(record.timestamp)) return { ok: false, reason: 'final-start: timestamp must be a non-empty string' };
    return { ok: true };
  }
  if (record.kind === 'final') {
    if (record.status !== 'green' && record.status !== 'red') return { ok: false, reason: `final: status must be "green" or "red" (got ${JSON.stringify(record.status)})` };
    if (!isNonEmptyString(record.attempt)) return { ok: false, reason: 'final: attempt must be the non-empty id of the start this completion closes' };
    for (const field of ['fingerprintBefore', 'fingerprintAfter']) {
      if (typeof record[field] !== 'string' || !HEX64_RE.test(record[field])) return { ok: false, reason: `final: ${field} must be a 64-hex tree fingerprint` };
    }
    if (!Array.isArray(record.declared) || record.declared.length === 0 || !record.declared.every((d) => isPlainObject(d) && isNonEmptyString(d.id) && isNonEmptyString(d.cmd))) {
      return { ok: false, reason: 'final: declared must be the non-empty ordered {id, cmd} array the run executed — an empty declaration never attests' };
    }
    if (!Array.isArray(record.results) || !record.results.every((r) => isPlainObject(r) && isNonEmptyString(r.id) && typeof r.ok === 'boolean' && (r.code === null || Number.isInteger(r.code)))) {
      return { ok: false, reason: 'final: results must be the per-gate {id, ok, code} array (code integer, or null on a spawn failure)' };
    }
    if (record.results.length !== record.declared.length || !record.results.every((r, i) => r.id === record.declared[i].id)) {
      return { ok: false, reason: 'final: results must mirror the declared gates 1:1 IN ORDER — a partial or shuffled attribution never attests' };
    }
    if (record.integrityFailure !== null && !isNonEmptyString(record.integrityFailure)) {
      return { ok: false, reason: 'final: integrityFailure must be null or a non-empty reason (an artifact moved under the run)' };
    }
    const derived = record.results.every((r) => r.ok) && record.integrityFailure === null ? 'green' : 'red';
    if (record.status !== derived) {
      return { ok: false, reason: `final: status ${JSON.stringify(record.status)} contradicts the results/integrity content (derived ${JSON.stringify(derived)}) — status is DERIVED, never asserted` };
    }
    if (!isPlainObject(record.evidenceHashes)
      || typeof record.evidenceHashes.redProof !== 'string' || !HEX64_RE.test(record.evidenceHashes.redProof)
      || typeof record.evidenceHashes.degrade !== 'string' || !HEX64_RE.test(record.evidenceHashes.degrade)) {
      return { ok: false, reason: 'final: evidenceHashes must carry 64-hex sha256 of the canonical red-proof and degrade serializations' };
    }
    // The D10 flow binding (Plan 4 Decision 2) is ADDITIVE: absent = a pre-flow-binding final
    // (still valid); present must be the 64-hex owner-scoped projection hash.
    if ('flow' in record.evidenceHashes && (typeof record.evidenceHashes.flow !== 'string' || !HEX64_RE.test(record.evidenceHashes.flow))) {
      return { ok: false, reason: 'final: evidenceHashes.flow, when present, must be a 64-hex sha256 of the owner-scoped flow projection' };
    }
    if (record.lcovSha256 !== null && (typeof record.lcovSha256 !== 'string' || !HEX64_RE.test(record.lcovSha256))) {
      return { ok: false, reason: 'final: lcovSha256 must be a 64-hex sha256 of the consumed lcov file, or null when none was produced' };
    }
    // The run's coverage token is ADDITIVE (absent = a pre-token receipt, still valid) and CLOSED.
    // `certified` is cross-checked against the bound digest — a run that certified a verdict read
    // bytes, so the two fields can never disagree in the store.
    if ('coverage' in record) {
      if (!FINAL_COVERAGE_STATES.includes(record.coverage)) {
        return { ok: false, reason: `final: coverage, when present, must be one of ${FINAL_COVERAGE_STATES.join(' | ')} (got ${JSON.stringify(record.coverage)}; a final run always selects the canonical checker, so "none" never rides a final receipt)` };
      }
      if (record.coverage === COVERAGE.certified && record.lcovSha256 === null) {
        return { ok: false, reason: 'final: coverage "certified" requires a bound lcovSha256 — a certified verdict was issued over lcov bytes that were read' };
      }
    }
    if (!isNonEmptyString(record.timestamp)) return { ok: false, reason: 'final: timestamp must be a non-empty string' };
    return { ok: true };
  }
  return { ok: false, reason: `unknown kind ${JSON.stringify(record.kind)} — closed set: red-proof | degrade | final-start | final (fail closed)` };
};

// ── the fail-closed reader ────────────────────────────────────────────────────────────────────────

// parseEvidenceText(raw) → { records, malformed, malformedReasons } — the ONE per-line parse +
// validation pass. readEvidence AND the append preflight consume it over the SAME captured bytes
// (a second read between check and write would be a TOCTOU gap).
export const parseEvidenceText = (raw) => {
  const records = [];
  const malformedReasons = [];
  const lines = String(raw).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      malformedReasons.push(`line ${i + 1}: invalid JSON`);
      continue;
    }
    const v = validateEvidenceRecord(parsed);
    if (v.ok) records.push(parsed);
    else malformedReasons.push(`line ${i + 1}: ${v.reason}`);
  }
  return { records, malformed: malformedReasons.length, malformedReasons };
};

// readEvidence(path) → { records, malformed, malformedReasons, readError? }. Absent file → empty
// (no evidence yet is not an error). Every non-parsing / non-validating line is COUNTED with its
// reason — consumers fail closed on malformed > 0, never silently drop.
export const readEvidence = (path, readFile = readFileSync) => {
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { records: [], malformed: 0, malformedReasons: [] };
    return { records: [], malformed: 0, malformedReasons: [], readError: (err && err.code) || (err && err.message) || 'read failed' };
  }
  return parseEvidenceText(raw);
};

// ── D6a: per-kind keys, authoritative selection, canonical serialization ──────────────────────────

// Space-joined with the CLOSED (validated hex-or-null) field in the MIDDLE, the free-form field
// last — content can then never forge a separator collision (base/fingerprint carry no spaces by
// validation; the last field absorbs anything).
export const evidenceKey = (r) =>
  r.kind === 'red-proof' ? `red-proof ${r.base} ${r.testId}`
  : r.kind === 'degrade' ? `degrade ${r.fingerprint} ${r.backend}`
  : r.kind === 'final' ? `final ${r.fingerprintBefore}`
  : r.kind === 'final-start' ? `final-start ${r.fingerprint}`
  : null;

// The authoritative subset: the LATEST record per key, in file order of that latest appearance.
export const authoritativeEvidence = (records) => {
  const lastByKey = new Map();
  records.forEach((r, i) => {
    const k = evidenceKey(r);
    if (k != null) lastByKey.set(k, i);
  });
  const keep = new Set(lastByKey.values());
  return records.filter((_, i) => keep.has(i));
};

export const authoritativeOfKind = (records, kind) => authoritativeEvidence(records).filter((r) => r.kind === kind);

// Canonical bytes: key-sorted JSON per record, one line each, newline-terminated ('' when empty) —
// independent of the byte layout the record was originally written with. The D3(a) receipt hashes
// EXACTLY these bytes per kind, so receipts (a different kind/file) are outside the domain by
// construction.
const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

export const canonicalKindSerialization = (records, kind) => {
  const lines = authoritativeOfKind(records, kind).map(stableStringify);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};
