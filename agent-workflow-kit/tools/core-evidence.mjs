#!/usr/bin/env node
// core-evidence.mjs — the ONE writer of the git-dir core-evidence store (strip-the-kit, D3(b)/(c) +
// D6 + D6a + D7). It owns ONE JSONL file (<git dir>/agent-workflow-core-evidence.jsonl) holding the
// minimal hardened core's evidence records:
//   • red-proof — the D3(c) observed-red DECLARATION: { testId, explicit repo-relative test file,
//     content sha256, observed red N/N, base = HEAD sha, the PRE-FIX tree fingerprint at red
//     observation }. The verb RUNS the named test first and refuses to record anything but an
//     observed red (green / unresolvable / mixed / timed-out are DISTINGUISHED refusals, nothing
//     written — mixed/timeout is QUARANTINE: it never converts and has no override lane).
//   • degrade — the D3(b) explicit per-backend, per-tree escape: { backend, non-empty reason,
//     current tree fingerprint, timestamp }. The ONLY honest escape for an unavailable review
//     backend — review-state consumes these (never all backends).
//   • summary — the D6 observability verb: ONE lightweight end-of-loop render, STATELESS from the
//     review receipts + this store. No ledger, no rounds.
// Store integrity (D6a): records carry a versioned schema and a per-kind KEY (red-proof:
// {base, testId}; degrade: {backend, fingerprint}); the LATEST record per key is authoritative
// (supersession; canonical order = file order), so a re-observation after a test edit is a NEW
// record, never a permanent hash conflict. A `duplicate` refusal applies ONLY to a byte-identical
// replayed line. A malformed line fails CLOSED (counted + surfaced, never silently dropped). The
// D3(a) receipt hashes ride canonicalKindSerialization — the CANONICAL (key-sorted) serialization
// of the AUTHORITATIVE subset per kind; receipts themselves are excluded from the hashed domain by
// construction (serialization is per kind).
// The test-running arm MOVES the old fold-runner's safeguards intact (fold-completeness-run.mjs:
// 234-292, 501-741 — move, not re-derive): safe repo-relative path resolution, no-follow real-path
// containment, shell-free argv, per-run timeout, N/N reruns, the quarantine lane. N and the
// timeout are pinned from that runner's own constants (reruns 3, timeout 120s).
// Import posture: today this module leans on the live one-homes (review-state fingerprint/receipt
// readers, review-ledger-core testId format + base + receipt summary). Step 2.2 inverts the
// fingerprint/receipt primitives INTO this module (review-state re-exports them) so review-state
// can import the degrade reader without an import cycle; the Phase-3 deletion relocates the
// ledger-core helpers here the same way.
//
// HONEST residuals: records are forgeable (a self-discipline mechanism in the git dir, not a
// security boundary); coverage/green verification of red-proof records lives in the final-run
// checker, not here. Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname, isAbsolute, normalize, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { parsePositiveIntKnob, probeVerdict } from './changed-surface.mjs';
import { computeTreeFingerprint, resolveReceiptsPath, readReceipts } from './review-state.mjs';
import { isWellFormedTestId, splitTestId, resolveBase, summarizeReviewReceiptsForTree } from './review-ledger-core.mjs';

export const CORE_EVIDENCE_STOP = 'CORE_EVIDENCE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'CoreEvidenceStop', code: CORE_EVIDENCE_STOP });
const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });

const isoNow = () => new Date().toISOString();
const GIT_MAX_BUFFER = 256 * 1024 * 1024; // a full TAP stream can be large; never truncate

const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
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

// The LEXICAL half of the repo-relative rule — ONE home shared by the record validator (which has
// no fs to resolve against) and the fs resolver below, so the two can never drift: a forged record
// carrying an equal-but-absolute (or escaping) testId/file pair is refused at validation, not just
// at observation time.
export const lexicalRepoRelative = (rel) => {
  if (typeof rel !== 'string' || rel.length === 0) return { ok: false, reason: 'empty file path' };
  if (isAbsolute(rel)) return { ok: false, reason: `absolute path "${rel}" — the testId file half must be repo-relative` };
  const norm = normalize(rel);
  if (norm === '..' || norm.startsWith(`..${sep}`)) return { ok: false, reason: `path "${rel}" escapes the repo root` };
  return { ok: true };
};

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
  return { ok: false, reason: `unknown kind ${JSON.stringify(record.kind)} — closed set: red-proof | degrade (fail closed)` };
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

// ── the ONE append (validated, duplicate-refusing, atomic) ────────────────────────────────────────

export const appendEvidenceRecord = ({ path, record }) => {
  const v = validateEvidenceRecord(record);
  if (!v.ok) throw stop(`refusing to write a malformed evidence record: ${v.reason}`);
  const line = JSON.stringify(record);
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') existing = '';
    else throw stop(`cannot read the evidence store before appending (${(err && err.code) || (err && err.message) || err}) — refusing to overwrite it (fail closed)`);
  }
  // Write-side D6a fail-closed: never extend a store whose existing lines are unreadable — the
  // SAME captured bytes are validated here and appended below (one snapshot, no second read).
  const existingIssues = parseEvidenceText(existing).malformedReasons;
  if (existingIssues.length > 0) {
    throw stop(`refusing to append to an evidence store carrying ${existingIssues.length} malformed line(s) (${existingIssues[0]}) — inspect ${path}; nothing was written (fail closed)`);
  }
  if (existing.split('\n').some((l) => l === line)) {
    throw stop(`refusing a byte-identical replayed line (duplicate) — a genuine re-observation carries new content or timestamp; nothing was written`);
  }
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  writeContainedFileAtomic(dirname(path), path, `${prefix}${line}\n`, {}, { stop, label: path });
  return { writtenPath: path, record };
};

// ── D6a: per-kind keys, authoritative selection, canonical serialization ──────────────────────────

// Space-joined with the CLOSED (validated hex-or-null) field in the MIDDLE, the free-form field
// last — content can then never forge a separator collision (base/fingerprint carry no spaces by
// validation; the last field absorbs anything).
export const evidenceKey = (r) =>
  r.kind === 'red-proof' ? `red-proof ${r.base} ${r.testId}`
  : r.kind === 'degrade' ? `degrade ${r.fingerprint} ${r.backend}`
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

// ── the MOVED runner safeguards (fold-completeness-run.mjs — verbatim semantics) ──────────────────

// Node sets NODE_TEST_CONTEXT for any process running UNDER `node --test`; a fresh `node --test`
// that inherits it silently SKIPS running its files. The probe spawns `node --test`, so it strips
// that var (a no-op in normal invocation).
export const childTestEnv = (env, extra = {}) => {
  const out = { ...env, ...extra };
  delete out.NODE_TEST_CONTEXT;
  return out;
};

const PROBE_RESULT_RE = /^(ok|not ok) \d+ - (.*)$/;
const PROBE_FAIL_RE = /^# fail (\d+)$/;
const PROBE_DIRECTIVE_RE = /#\s*(?:skip|todo)\b/i; // a TAP SKIP/TODO directive — the test did NOT run

// parseProbeOutput({ stdout, code, fileArg }) → { resolvable, executed, baselineGreen }. The file
// wrapper is matched by BASENAME (node normalizes the echoed path); a directive-carrying result
// line never counts (node 18/20 emit pattern-filtered tests as SKIP).
export const parseProbeOutput = ({ stdout, code, fileArg }) => {
  let matched = 0;
  let notOk = 0;
  let failCount = null;
  const wanted = basename(String(fileArg).trim());
  for (const line of String(stdout).split('\n')) {
    const m = PROBE_RESULT_RE.exec(line);
    if (m && !PROBE_DIRECTIVE_RE.test(m[2]) && basename(m[2].trim()) !== wanted) {
      matched += 1;
      if (m[1] === 'not ok') notOk += 1;
    }
    const f = PROBE_FAIL_RE.exec(line.trim());
    if (f) failCount = Number(f[1]);
  }
  const resolvable = matched > 0;
  const fails = (failCount ?? 0) + notOk;
  return { resolvable, executed: matched, baselineGreen: resolvable && code === 0 && fails === 0 };
};

// The shell-free node:test argv. The pattern rides `=`-joined: as a separate token a pattern
// beginning with "-" would parse as an OPTION and silently select no test.
export const defaultBoundArgv = (file, pattern) => ['node', '--test', '--test-reporter', 'tap', `--test-name-pattern=${pattern}`, file];

// containsPath(realRoot, realAbs) → strictly INSIDE. Segment-safe ('/a' never contains '/ab') and
// correct for a repo at the filesystem root.
export const containsPath = (realRoot, realAbs) => realAbs.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);

// resolveTestFile(rootTop, rel, deps?) → { ok: true, abs } | { ok: false, reason } (never throws).
// Repo-relative only; a REGULAR file under no-follow lstat; the RESOLVED real path contained under
// the REAL repo root (a leaf check alone would let a symlinked PARENT directory escape).
export const resolveTestFile = (rootTop, rel, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const realpath = deps.realpath ?? realpathSync;
  const lex = lexicalRepoRelative(rel);
  if (!lex.ok) return { ok: false, reason: lex.reason };
  const abs = join(rootTop, normalize(rel));
  let st;
  try {
    st = lstat(abs);
  } catch {
    return { ok: false, reason: `file "${rel}" does not exist` };
  }
  if (!st.isFile()) return { ok: false, reason: `"${rel}" is not a regular file (a symlink/directory/device is never followed — fail closed)` };
  let realAbs;
  let realRoot;
  try {
    realAbs = realpath(abs);
    realRoot = realpath(rootTop);
  } catch {
    return { ok: false, reason: `cannot resolve the real path of "${rel}"` };
  }
  if (!containsPath(realRoot, realAbs)) return { ok: false, reason: `"${rel}" resolves outside the repo root (a symlinked parent directory) — fail closed` };
  return { ok: true, abs: realAbs };
};

// sha-256 over the file's BYTES; null on a read failure (the caller reads that as unresolvable).
export const hashFileBytes = (abs) => {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
};

// N and the per-run timeout — pinned from the old runner's own constants (AW_FOLD_RERUNS default 3,
// AW_FOLD_PROBE_TIMEOUT_S default 120); zero/negative/fractional/non-numeric refused by name.
export const probeKnobsFromEnv = (env = process.env) => ({
  reruns: parsePositiveIntKnob(env, 'AW_CORE_EVIDENCE_RERUNS', 3, stop),
  timeoutS: parsePositiveIntKnob(env, 'AW_CORE_EVIDENCE_TIMEOUT_S', 120, stop),
});

// The N-rerun probe. The custody hash is taken BEFORE the runs (the content the observation
// attests); the spawn ALWAYS uses the resolver's canonical absolute path — the executed file must
// be the hashed file independent of runner path semantics. A timed-out or signal-killed run is
// neither red nor green — it lands in `timeouts` (quarantine fuel).
const probeBound = ({ testId, rootTop, env, reruns, timeoutS }) => {
  const { file, pattern } = splitTestId(testId);
  const resolved = resolveTestFile(rootTop, file);
  const fileHash = resolved.ok ? hashFileBytes(resolved.abs) : null;
  let executed = 0;
  let greens = 0;
  let reds = 0;
  let timeouts = 0;
  if (resolved.ok && fileHash != null) {
    for (let i = 0; i < reruns; i += 1) {
      const argv = defaultBoundArgv(resolved.abs, pattern);
      const res = spawnSync(argv[0], argv.slice(1), {
        cwd: rootTop, env: childTestEnv(env), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: timeoutS * 1000,
      });
      if ((res.error && res.error.code === 'ETIMEDOUT') || res.signal != null) {
        timeouts += 1;
        continue;
      }
      const p = parseProbeOutput({ stdout: res.stdout ?? '', code: res.error ? 1 : res.status ?? 1, fileArg: file });
      executed = Math.max(executed, p.executed);
      if (!p.resolvable) continue;
      if (p.baselineGreen) greens += 1;
      else reds += 1;
    }
  }
  const entry = { executed, runs: reruns, greens, reds, timeouts, fileHash };
  return { entry, file, resolveReason: resolved.ok ? (fileHash == null ? `cannot read "${file}"` : null) : resolved.reason };
};

// ── the red-proof verb (D3(c)): observed red or nothing ───────────────────────────────────────────

// runRedProof({ cwd, env, testId }) → { writtenPath, record }. Observes `testId` on the CURRENT
// (pre-fix) tree: N/N red → appends the declaration; anything else is a DISTINGUISHED refusal and
// NOTHING is written.
export const runRedProof = ({ cwd = process.cwd(), env = process.env, testId } = {}) => {
  if (!isWellFormedTestId(testId)) {
    throw usageFail(`red-proof needs a well-formed testId "<test-file>#<test-name-pattern>" (a "#" separator, both halves non-empty; got ${JSON.stringify(testId)})`);
  }
  const rootTop = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (rootTop == null) throw stop('not a git work tree — nothing to observe');
  const { reruns, timeoutS } = probeKnobsFromEnv(env);
  // Pre-run capture: the record's base/fingerprint and the custody hash must attest ONE tree —
  // captured BEFORE the runs and re-checked after them; any drift refuses below.
  const base = resolveBase(cwd);
  const fingerprint = computeTreeFingerprint(cwd);
  const { entry, file, resolveReason } = probeBound({ testId, rootTop, env, reruns, timeoutS });
  const verdict = probeVerdict(entry);
  const counts = `${entry.greens} green / ${entry.reds} red / ${entry.timeouts} timed out / ${entry.runs - entry.greens - entry.reds - entry.timeouts} unresolved of ${entry.runs} run(s)`;
  if (verdict === 'unresolvable') {
    throw stop(
      `red-proof refused for "${testId}": unresolvable — ${resolveReason ?? 'the pattern selects no test'} (${counts}). ` +
        `If the test cannot even LOAD pre-fix (it imports an export the fix introduces), author it with a dynamic import() so it loads and FAILS pre-fix. Nothing was recorded.`,
    );
  }
  if (verdict === 'green') {
    throw stop(
      `red-proof refused for "${testId}": observed GREEN on ${entry.greens}/${entry.runs} runs — the test does not fail on the current (pre-fix) tree, so it proves nothing about the fix. ` +
        `Write a test that FAILS before the fix is applied, then record the red-proof BEFORE folding the fix. Nothing was recorded.`,
    );
  }
  if (verdict === 'quarantine') {
    const flavor = entry.timeouts > 0
      ? `${entry.timeouts} of ${entry.runs} probe run(s) timed out (AW_CORE_EVIDENCE_TIMEOUT_S=${timeoutS}) — a timed-out run is neither red nor green`
      : `mixed outcomes (${counts}) — a flaky test can launder a fake red`;
    throw stop(
      `red-proof refused for "${testId}": QUARANTINE — ${flavor}. QUARANTINE never converts and has no override lane: ` +
        `${entry.timeouts > 0 ? 'raise the timeout or make the test faster' : 'replace the flaky test'}, then re-observe. Nothing was recorded.`,
    );
  }
  if (fingerprint == null) throw stop('cannot compute the tree fingerprint — not a git work tree');
  // Post-run drift recheck: fingerprint, base, and the test-file bytes must all equal the
  // pre-run capture — a mutating test / parallel edit / commit would otherwise mint a record
  // whose fields attest different trees.
  const resolvedAfter = resolveTestFile(rootTop, file);
  const hashAfter = resolvedAfter.ok ? hashFileBytes(resolvedAfter.abs) : null;
  if (computeTreeFingerprint(cwd) !== fingerprint || resolveBase(cwd) !== base || hashAfter !== entry.fileHash) {
    throw stop(
      `red-proof refused for "${testId}": the tree moved during the observation (fingerprint, base, or test-file bytes drifted between the pre-run capture and the post-run recheck) — a record would bind fields from different trees. Re-observe on a quiescent tree. Nothing was recorded.`,
    );
  }
  const record = {
    schema: EVIDENCE_SCHEMA_VERSION,
    kind: 'red-proof',
    testId,
    file,
    fileHash: entry.fileHash,
    runs: entry.runs,
    reds: entry.reds,
    base,
    fingerprint,
    timestamp: isoNow(),
  };
  const path = resolveEvidencePath(cwd, env);
  if (path == null) throw stop('cannot resolve the evidence-store path — not a git work tree and AW_CORE_EVIDENCE is unset');
  return appendEvidenceRecord({ path, record });
};

// ── the degrade verb (D3(b)): the explicit per-backend, per-tree escape ───────────────────────────

export const runDegrade = ({ cwd = process.cwd(), env = process.env, backend, reason } = {}) => {
  if (typeof backend !== 'string' || backend.trim() === '') throw usageFail('degrade needs --backend <name> — a missing or whitespace-only backend is refused (the gate matches records by backend name)');
  if (typeof reason !== 'string' || reason.trim() === '') throw usageFail('degrade needs a non-empty --reason "<why this backend cannot review this tree>" — a reasonless degrade is refused');
  const fingerprint = computeTreeFingerprint(cwd);
  if (fingerprint == null) throw stop('not a git work tree — a degrade attests a specific tree fingerprint');
  const record = {
    schema: EVIDENCE_SCHEMA_VERSION,
    kind: 'degrade',
    backend: backend.trim(),
    reason: reason.trim(),
    fingerprint,
    timestamp: isoNow(),
  };
  const path = resolveEvidencePath(cwd, env);
  if (path == null) throw stop('cannot resolve the evidence-store path — not a git work tree and AW_CORE_EVIDENCE is unset');
  return appendEvidenceRecord({ path, record });
};

// ── the summary verb (D6): ONE stateless render — receipts + evidence store, no ledger ────────────

export const buildSummaryState = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const fingerprint = computeTreeFingerprint(cwd);
  const base = resolveBase(cwd);
  const storePath = resolveEvidencePath(cwd, env);
  const store = storePath ? readEvidence(storePath) : { records: [], malformed: 0, malformedReasons: [] };
  const receiptsPath = resolveReceiptsPath(cwd, env);
  const receiptsRead = receiptsPath ? readReceipts(receiptsPath) : { receipts: [], malformed: 0 };
  const { receipts, malformed: receiptsMalformed } = receiptsRead;
  const receiptsReadError = receiptsRead.readError ?? null;
  const backends = [...new Set(receipts.map((r) => r.backend))].sort();
  const verdicts = backends.map((b) => ({
    backend: b,
    summary: summarizeReviewReceiptsForTree(receipts.filter((r) => r.backend === b), fingerprint),
  }));
  const redProofs = authoritativeOfKind(store.records, 'red-proof').filter((r) => r.base === base);
  const degrades = authoritativeOfKind(store.records, 'degrade').filter((r) => r.fingerprint === fingerprint);
  // A malformed/unreadable store makes the AUTHORITATIVE selection untrustworthy (a dropped later
  // line could resurrect a superseded record — or hide a newer verdict) — the summary WITHHOLDS
  // the affected sections and exits non-zero instead of rendering a lie. Both stores get the same
  // posture: the evidence store and the receipts store.
  const evidenceUnavailable = store.malformed > 0 || store.readError != null;
  const receiptsUnavailable = receiptsMalformed > 0 || receiptsReadError != null;
  return {
    fingerprint, base, storePath,
    storeRecords: store.records.length, storeMalformed: store.malformed, storeReadError: store.readError ?? null,
    evidenceUnavailable, receiptsUnavailable, receiptsReadError,
    receiptsPath, receiptsMalformed, verdicts, redProofs, degrades,
  };
};

const verdictLine = ({ backend, summary }) => {
  if (summary.state === 'current') return `${backend}: ${summary.receipt.verdict ?? 'unknown'} (attesting, ${summary.receipt.timestamp ?? '?'})`;
  if (summary.state === 'ungrounded') return `${backend}: ${summary.receipt.verdict ?? 'unknown'} (ungrounded — never attests)`;
  if (summary.state === 'probe') return `${backend}: probe receipts only for the current tree (never attest)`;
  if (summary.state === 'rejected') return `${backend}: current-tree receipts rejected (untrustworthy probe marker)`;
  return `${backend}: no attesting receipt for the current tree (stale or missing)`;
};

export const renderSummary = (s) => {
  const short = (hex) => (typeof hex === 'string' ? `${hex.slice(0, 12)}…` : String(hex));
  const evidenceSections = s.evidenceUnavailable
    ? [`  evidence sections WITHHELD — the store is unavailable (${s.storeMalformed} malformed line(s)${s.storeReadError ? `, read error: ${s.storeReadError}` : ''}); a dropped line could resurrect a superseded record — inspect ${s.storePath}`]
    : [
        `  red-proof records (current base): ${s.redProofs.length ? '' : '(none)'}`,
        ...s.redProofs.map((r) => `    ${r.testId} — ${r.reds}/${r.runs} red, hash ${short(r.fileHash)}, pre-fix fingerprint ${short(r.fingerprint)}`),
        `  degrade records (current tree): ${s.degrades.length ? '' : '(none)'}`,
        ...s.degrades.map((d) => `    ${d.backend} — ${d.reason} (${d.timestamp})`),
      ];
  const verdictsSection = s.receiptsUnavailable
    ? [`  review verdicts WITHHELD — the receipts store is unavailable (${s.receiptsMalformed} malformed line(s)${s.receiptsReadError ? `, read error: ${s.receiptsReadError}` : ''}); a dropped line could hide a newer verdict — inspect ${s.receiptsPath}`]
    : [
        '  review verdicts (current tree):',
        ...(s.verdicts.length ? s.verdicts.map((v) => `    ${verdictLine(v)}`) : ['    (no receipts)']),
      ];
  const lines = [
    'core-evidence summary — stateless render (review receipts + evidence store; no ledger, no rounds)',
    `  tree fingerprint: ${s.fingerprint ?? '(not a git work tree)'}`,
    `  base: ${s.base ?? '(unborn branch)'}`,
    ...verdictsSection,
    ...evidenceSections,
    `  evidence store: ${s.storePath ?? '(unresolvable — no git dir)'} (${s.storeRecords} record(s)${s.storeMalformed ? `, ${s.storeMalformed} malformed — inspect the file` : ''}${s.storeReadError ? `, read error: ${s.storeReadError}` : ''})`,
  ];
  return lines.join('\n');
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `core-evidence — the ONE writer of the git-dir core-evidence store (agent-workflow family).

Usage:
  node core-evidence.mjs red-proof "<test-file>#<test-name-pattern>" [--cwd <dir>]
  node core-evidence.mjs degrade --backend <name> --reason "<why>" [--cwd <dir>]
  node core-evidence.mjs summary [--cwd <dir>]

red-proof observes the named test RED on the CURRENT (pre-fix) tree — N runs (AW_CORE_EVIDENCE_RERUNS,
default 3; per-run timeout AW_CORE_EVIDENCE_TIMEOUT_S, default 120s), shell-free spawn of the safely
resolved repo-relative file — and appends the D3(c) declaration { testId, file, content sha256,
observed red N/N, base = HEAD sha, PRE-FIX tree fingerprint }. Observed green / unresolvable /
mixed / timed-out are DISTINGUISHED refusals and nothing is written (mixed/timeout = QUARANTINE —
never converts, no override lane). A new record for the same {base, testId} SUPERSEDES the earlier
one (re-observation after a test edit is a new record, not a hash conflict).

degrade records the EXPLICIT per-backend, per-tree escape { backend, non-empty reason, current tree
fingerprint } — the only honest lane for an unavailable review backend; the review-state gate
consumes these (and never accepts all backends degraded).

summary renders ONE stateless end-of-loop view from the review receipts + this store: per-backend
verdicts for the current tree, current-base red-proof records, current-tree degrade records.

Store: <git dir>/${EVIDENCE_BASENAME} (AW_CORE_EVIDENCE overrides) — one JSONL file, versioned
schema, LATEST record per key authoritative (red-proof: {base, testId}; degrade: {backend,
fingerprint}); a byte-identical replayed line is refused as a duplicate; malformed lines fail
closed. Records live in the git dir as a self-discipline mechanism, not a security boundary.

Sandbox-safe: no network; writes only the git-dir store; spawns read-only git queries and the
bound-test probe (node --test).

Exit codes: 0 written / rendered healthy; 1 a typed refusal (observed green / quarantine /
unresolvable / tree drift during observation / malformed store / duplicate / fs error — and a
summary over a malformed/unreadable store); 2 usage.`;

const parseFlag = (rest, name) => {
  const i = rest.indexOf(name);
  if (i === -1) return { value: undefined, rest };
  const value = rest[i + 1];
  if (value === undefined) throw usageFail(`${name} needs a value`);
  return { value, rest: [...rest.slice(0, i), ...rest.slice(i + 2)] };
};

export const main = (argv, ctx = {}) => {
  const env = ctx.env ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const [verb, ...restRaw] = argv;
    const { value: cwdFlag, rest } = parseFlag(restRaw, '--cwd');
    const cwd = cwdFlag ?? ctx.cwd ?? process.cwd();
    if (verb === 'red-proof') {
      const [testId, ...extra] = rest;
      if (testId === undefined) throw usageFail('red-proof needs a testId ("<test-file>#<test-name-pattern>")');
      if (extra.length > 0) throw usageFail(`unknown argument: ${extra[0]}`);
      const { writtenPath, record } = runRedProof({ cwd, env, testId });
      return { code: 0, stdout: `core-evidence: recorded a red-proof for "${record.testId}" (${record.reds}/${record.runs} observed red, hash ${record.fileHash.slice(0, 12)}…) → ${writtenPath}`, stderr: '' };
    }
    if (verb === 'degrade') {
      const { value: backend, rest: r1 } = parseFlag(rest, '--backend');
      const { value: reason, rest: r2 } = parseFlag(r1, '--reason');
      if (r2.length > 0) throw usageFail(`unknown argument: ${r2[0]}`);
      const { writtenPath, record } = runDegrade({ cwd, env, backend, reason });
      return { code: 0, stdout: `core-evidence: recorded a degrade for backend "${record.backend}" at fingerprint ${record.fingerprint.slice(0, 12)}… → ${writtenPath}`, stderr: '' };
    }
    if (verb === 'summary') {
      if (rest.length > 0) throw usageFail(`unknown argument: ${rest[0]}`);
      const state = buildSummaryState({ cwd, env });
      return { code: state.evidenceUnavailable || state.receiptsUnavailable ? 1 : 0, stdout: renderSummary(state), stderr: '' };
    }
    throw usageFail(`unknown verb: ${verb ?? '(none)'} — expected red-proof | degrade | summary (see --help)`);
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `core-evidence: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
