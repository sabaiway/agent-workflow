// core-evidence-summary.mjs — the summary verb: red-proof currency, the summary state and its render; the contract is the header of core-evidence.mjs.

import { COVERAGE } from './coverage-state.mjs';
import { computeTreeFingerprint, gitLine, resolveBase } from './core-evidence-tree.mjs';
import { authoritativeOfKind, readEvidence, resolveEvidencePath } from './core-evidence-store-read.mjs';
import { readReceipts, resolveReceiptsPath, summarizeReviewReceiptsForTree } from './core-evidence-receipts.mjs';
import { hashFileBytes, resolveTestFile } from './core-evidence-red-proof.mjs';

// ── the summary verb (D6): ONE stateless render — receipts + evidence store, no ledger ────────────

// A red-proof binds the BYTES of the test file it was observed on, and the final-run checker refuses
// when those bytes have moved (coverage-check.mjs, the hash-mismatch arm). This render used to print a
// stale record byte-identically to a live one, so the only place staleness surfaced was that gate —
// after both council dispatches, at the commit boundary, which is the most expensive discovery point
// in the loop. The currency is therefore computed HERE, from the SAME two helpers the checker uses, so
// the render and the gate can never disagree about what stale means.
//
// An unresolvable or unreadable file is STALE, not unknown: a proof nobody can re-check is not a proof
// anyone should read as current.
export const redProofCurrency = (rootTop, record) => {
  if (rootTop == null) return { state: 'stale', detail: 'the work-tree root is not resolvable' };
  const resolved = resolveTestFile(rootTop, record.file);
  if (!resolved.ok) return { state: 'stale', detail: resolved.reason };
  const current = hashFileBytes(resolved.abs);
  if (current == null) return { state: 'stale', detail: `cannot read "${record.file}"` };
  return current === record.fileHash
    ? { state: 'current' }
    : { state: 'stale', detail: 'the bound test file changed after the mint' };
};

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
  const rootTop = gitLine(['rev-parse', '--show-toplevel'], cwd);
  const redProofs = authoritativeOfKind(store.records, 'red-proof')
    .filter((r) => r.base === base)
    .map((r) => ({ ...r, currency: redProofCurrency(rootTop, r) }));
  const degrades = authoritativeOfKind(store.records, 'degrade').filter((r) => r.fingerprint === fingerprint);
  const finalRun = authoritativeOfKind(store.records, 'final').find((r) => r.fingerprintBefore === fingerprint) ?? null;
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
    receiptsPath, receiptsMalformed, verdicts, redProofs, degrades, finalRun,
  };
};

const verdictLine = ({ backend, summary }) => {
  if (summary.state === 'current') return `${backend}: ${summary.receipt.verdict ?? 'unknown'} (attesting, ${summary.receipt.timestamp ?? '?'})`;
  if (summary.state === 'ungrounded') return `${backend}: ${summary.receipt.verdict ?? 'unknown'} (ungrounded — never attests)`;
  if (summary.state === 'unrecognized-verdict') return `${backend}: unrecognized verdict (${JSON.stringify(summary.receipt?.verdict ?? null)}) — never attests (fail-closed)`;
  if (summary.state === 'probe') return `${backend}: probe receipts only for the current tree (never attest)`;
  if (summary.state === 'rejected') return `${backend}: current-tree receipts rejected (untrustworthy probe marker)`;
  return `${backend}: no attesting receipt for the current tree (stale or missing)`;
};

// Why the run issued no verdict, keyed by the token IT recorded. `certified` maps to nothing —
// there is no absence to name. A legacy receipt predates the token: the only honest thing to say
// is what the RECORD carries, which is true by construction. Exported as a test seam (keyFor).
const COVERAGE_QUALIFIER = Object.freeze({
  [COVERAGE.notRun]: 'the recorded run issued no coverage verdict',
  [COVERAGE.unknown]: 'the recorded run produced no readable coverage signal',
});
const LEGACY_COVERAGE_QUALIFIER = `coverage=${COVERAGE.unknown}: this legacy receipt carries no coverage token and binds no lcov digest`;

export const coverageQualifierFor = (finalRun) => {
  if (!finalRun) return '';
  if (typeof finalRun.coverage === 'string') {
    const why = COVERAGE_QUALIFIER[finalRun.coverage];
    return why ? ` — coverage=${finalRun.coverage}: ${why}` : '';
  }
  return finalRun.lcovSha256 == null ? ` — ${LEGACY_COVERAGE_QUALIFIER}` : '';
};

export const renderSummary = (s) => {
  const short = (hex) => (typeof hex === 'string' ? `${hex.slice(0, 12)}…` : String(hex));
  const evidenceSections = s.evidenceUnavailable
    ? [`  evidence sections WITHHELD — the store is unavailable (${s.storeMalformed} malformed line(s)${s.storeReadError ? `, read error: ${s.storeReadError}` : ''}); a dropped line could resurrect a superseded record — inspect ${s.storePath}`]
    : [
        `  red-proof records (current base): ${s.redProofs.length ? '' : '(none)'}`,
        ...s.redProofs.map((r) => {
          const stale = r.currency?.state === 'stale';
          const mark = stale ? `STALE (${r.currency.detail})` : 'CURRENT';
          return `    ${r.testId} — ${mark} · ${r.reds}/${r.runs} red, hash ${short(r.fileHash)}, pre-fix fingerprint ${short(r.fingerprint)}`;
        }),
        // The recovery, printed once and only when it is needed — it was written down nowhere, and
        // the loop paid for that three times.
        ...(s.redProofs.some((r) => r.currency?.state === 'stale')
          ? ['    ↳ a STALE proof is refused by run-gates --final: park the fix so the bound test fails again, re-observe it with `core-evidence red-proof "<testId>"`, then restore the fix. Edit test files FIRST and re-observe ONCE per park — every proof bound to an edited file goes stale together.']
          : []),
        `  degrade records (current tree): ${s.degrades.length ? '' : '(none)'}`,
        ...s.degrades.map((d) => `    ${d.backend} — ${d.reason} (${d.timestamp})`),
      ];
  const verdictsSection = s.receiptsUnavailable
    ? [`  review verdicts WITHHELD — the receipts store is unavailable (${s.receiptsMalformed} malformed line(s)${s.receiptsReadError ? `, read error: ${s.receiptsReadError}` : ''}); a dropped line could hide a newer verdict — inspect ${s.receiptsPath}`]
    : [
        '  review verdicts (current tree):',
        ...(s.verdicts.length ? s.verdicts.map((v) => `    ${verdictLine(v)}`) : ['    (no receipts)']),
      ];
  // The withheld coverage verdict travels here too: an unqualified GREEN repeats, one surface
  // further on, the false reassurance the checker's own attested=no exists to close. It is read
  // from the token the RUN recorded — `lcovSha256` says what the receipt binds, never whether a
  // verdict was issued — and it rides RED as well: an absent verdict is a property of the run, not
  // of its colour. A LEGACY receipt (no token) is named as exactly that, never as a claim about
  // what it read. DETAIL beside an unchanged status word.
  const coverageQualifier = coverageQualifierFor(s.finalRun);
  const finalLine = s.evidenceUnavailable
    ? null
    : s.finalRun
      ? `  final gate run: ${s.finalRun.status === 'green' ? 'GREEN' : 'RED'}${coverageQualifier} (${s.finalRun.results.filter((r) => r.ok).length}/${s.finalRun.results.length} gates, ${s.finalRun.timestamp})`
      : '  final gate run: (none recorded for the current tree)';
  const lines = [
    'core-evidence summary — stateless render (review receipts + evidence store; no ledger, no rounds)',
    `  tree fingerprint: ${s.fingerprint ?? '(not a git work tree)'}`,
    `  base: ${s.base ?? '(unborn branch)'}`,
    ...(finalLine ? [finalLine] : []),
    ...verdictsSection,
    ...evidenceSections,
    `  evidence store: ${s.storePath ?? '(unresolvable — no git dir)'} (${s.storeRecords} record(s)${s.storeMalformed ? `, ${s.storeMalformed} malformed — inspect the file` : ''}${s.storeReadError ? `, read error: ${s.storeReadError}` : ''})`,
  ];
  return lines.join('\n');
};
