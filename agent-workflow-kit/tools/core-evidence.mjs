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
// The test-running arm carries the retired fold-runner's safeguards intact (moved, not
// re-derived): safe repo-relative path resolution, no-follow real-path containment, shell-free
// argv, per-run timeout, N/N reruns, the quarantine lane (reruns 3, timeout 120s).
// Import posture: this module is the DAG BOTTOM — it imports only node built-ins + atomic-write +
// changed-surface + the pure leaves (repo-lex, fs-read-nofollow, coverage-state, git-env), and OWNS the
// canonical review-domain primitives (tree fingerprint, receipt read
// path, attesting predicate, verdict vocabulary, testId format, base resolution). review-state
// RE-EXPORTS its historical public API from here, so its consumers (and the bash-twin parity
// tests) are unchanged while review-state can import the degrade reader without an import cycle.
//
// HONEST residuals: records are forgeable (a self-discipline mechanism in the git dir, not a
// security boundary); coverage/green verification of red-proof records lives in the final-run
// checker, not here. Dependency-free. No side effects on import.

import { isDirectRun } from './direct-run.mjs';
import { EVIDENCE_BASENAME } from './core-evidence-store-read.mjs';
import { usageFail, runRedProof, runDegrade } from './core-evidence-store.mjs';
import { buildSummaryState, renderSummary } from './core-evidence-summary.mjs';

// The LEXICAL half of the repo-relative rule lives in the repo-lex.mjs LEAF (ONE home shared by
// the record validators — flow-record has no fs to resolve against — and the fs resolver in the
// red-proof leaf, so the two can never drift); re-exported here so every historical consumer keeps its import site.
export { lexicalRepoRelative } from './repo-lex.mjs';
export {
  gitBuf, resolveBase, isBinaryFile, isNeverCommittableStat, FINGERPRINT_CACHED_DIFF_ARGV, FINGERPRINT_UNSTAGED_DIFF_ARGV,
  computeFingerprintPayload, computeTreeFingerprint, CONTENT_FREE_FINGERPRINT, computeWorkingState, isTreeClean,
} from './core-evidence-tree.mjs';
export {
  RECEIPTS_BASENAME, resolveReceiptsPath, readReceipts, isShipVerdict, isRecognizedVerdict, REVIEW_RECEIPT_CLASS,
  classifyReviewReceiptForTree, summarizeReviewReceiptsForTree, describeMissingReviewAttestation,
} from './core-evidence-receipts.mjs';
export {
  isWellFormedTestId, splitTestId, EVIDENCE_BASENAME, EVIDENCE_SCHEMA_VERSION, resolveEvidencePath, validateEvidenceRecord,
  parseEvidenceText, readEvidence, evidenceKey, authoritativeEvidence, authoritativeOfKind, canonicalKindSerialization,
} from './core-evidence-store-read.mjs';
export { childTestEnv, parseProbeOutput, defaultBoundArgv, containsPath, resolveTestFile, hashFileBytes } from './core-evidence-red-proof.mjs';
export { CORE_EVIDENCE_STOP, appendEvidenceRecord, probeKnobsFromEnv, runRedProof, runDegrade } from './core-evidence-store.mjs';
export { redProofCurrency, buildSummaryState, coverageQualifierFor, renderSummary } from './core-evidence-summary.mjs';

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

if (isDirectRun(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
