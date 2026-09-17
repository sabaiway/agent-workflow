// core-evidence-store.mjs — the append half of the evidence store: the one append and the two verbs that append; the contract is the header of core-evidence.mjs.

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { parsePositiveIntKnob, probeVerdict } from './changed-surface.mjs';
import { computeTreeFingerprint, gitLine, resolveBase } from './core-evidence-tree.mjs';
import { EVIDENCE_SCHEMA_VERSION, isWellFormedTestId, parseEvidenceText, resolveEvidencePath, validateEvidenceRecord } from './core-evidence-store-read.mjs';
import { hashFileBytes, probeBound, resolveTestFile } from './core-evidence-red-proof.mjs';

export const CORE_EVIDENCE_STOP = 'CORE_EVIDENCE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'CoreEvidenceStop', code: CORE_EVIDENCE_STOP });
export const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });

const isoNow = () => new Date().toISOString();

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

// N and the per-run timeout — pinned from the old runner's own constants (AW_FOLD_RERUNS default 3,
// AW_FOLD_PROBE_TIMEOUT_S default 120); zero/negative/fractional/non-numeric refused by name.
export const probeKnobsFromEnv = (env = process.env) => ({
  reruns: parsePositiveIntKnob(env, 'AW_CORE_EVIDENCE_RERUNS', 3, stop),
  timeoutS: parsePositiveIntKnob(env, 'AW_CORE_EVIDENCE_TIMEOUT_S', 120, stop),
});

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
  if (fingerprint == null) throw stop('cannot compute the tree fingerprint — the git location is not a work tree; nothing was observed, no runs were spent');
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
