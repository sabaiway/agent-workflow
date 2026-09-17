// core-evidence-receipts.mjs — the review-receipt read path, the verdict vocabulary and the receipt classes; the contract is the header of core-evidence.mjs.

import { join } from 'node:path';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { gitLine } from './core-evidence-tree.mjs';

export const RECEIPTS_BASENAME = 'agent-workflow-review-receipts.jsonl';

export const resolveReceiptsPath = (cwd, env = process.env) => {
  if (env.AW_REVIEW_RECEIPTS) return env.AW_REVIEW_RECEIPTS;
  const gitDir = gitLine(['rev-parse', '--absolute-git-dir'], cwd);
  return gitDir == null ? null : join(gitDir, RECEIPTS_BASENAME);
};

// Parse the receipt file → { receipts, malformed, readError? }. Absent file → empty (not an
// error: no review ever ran). The read rides the fs-read-nofollow leaf (RECEIPTS-READER-NOFOLLOW):
// a symlinked/FIFO/directory receipts path surfaces as readError — never content, never an empty
// success — and any NON-ENOENT failure surfaces as readError too; an unreadable store must never
// silently read as "no receipts" (the summary withholds its verdicts section on it). A malformed
// line is counted + reported, never silently dropped. `io` is the injectable-read test seam
// (readRegularFileNoFollow's descriptor-level io).
export const readReceipts = (path, io = {}) => {
  const read = readRegularFileNoFollow(path, io);
  if (read.outcome === 'absent') return { receipts: [], malformed: 0 };
  if (read.outcome === 'foreign') {
    return { receipts: [], malformed: 0, readError: `the receipts store is a ${read.className}, not a regular file — refusing to read it (fail closed)` };
  }
  if (read.outcome === 'error') return { receipts: [], malformed: 0, readError: read.code };
  const raw = read.content;
  const receipts = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.backend === 'string') receipts.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { receipts, malformed };
};

// The closed review-verdict vocabulary (the union of both wrappers' closed grammars). Any
// RECOGNIZED verdict is review EVIDENCE (a recognized negative is an authoritative veto); ONLY
// ship-class SATISFIES the review-state gate.
const SHIP_VERDICTS = new Set(['ship', 'ship with nits']);
const NEGATIVE_VERDICTS = new Set(['revise', 'rethink', 'rework']);
// Type-strict: only a STRING can enter the closed grammar — String() coercion would admit an
// array like ["ship"] as ship-class.
const normalizeVerdict = (verdict) => (typeof verdict === 'string' ? verdict.trim().toLowerCase() : null);
export const isShipVerdict = (verdict) => {
  const v = normalizeVerdict(verdict);
  return v !== null && SHIP_VERDICTS.has(v);
};
export const isRecognizedVerdict = (verdict) => {
  const v = normalizeVerdict(verdict);
  return v !== null && (SHIP_VERDICTS.has(v) || NEGATIVE_VERDICTS.has(v));
};

export const REVIEW_RECEIPT_CLASS = Object.freeze({
  NOT_CURRENT: 'not-current',
  ATTESTING: 'attesting',
  UNGROUNDED: 'ungrounded',
  UNRECOGNIZED_VERDICT: 'unrecognized-verdict',
  PROBE: 'probe',
  UNMARKED: 'unmarked',
  MALFORMED_MARKER: 'malformed-marker',
  POSTURE_UNMARKED: 'posture-unmarked',
  MALFORMED_POSTURE: 'malformed-posture',
  DELIVERY_UNMARKED: 'delivery-unmarked',
  MALFORMED_DELIVERY: 'malformed-delivery',
});

// Backends whose `code` receipts must SELF-DECLARE how the change set reached the model (D8b).
// Scoped, not universal: agy's oversized lane was the one observed returning a confident
// fabrication, and codex's receipt semantics are deliberately untouched.
const DELIVERY_DECLARING_BACKENDS = new Set(['agy']);

// A delivery declaration is a lowercase token naming HOW delivery was established (`inline` when
// the whole change set rode one prompt, `fed` when a chunked feed proved it by echo). The gate
// requires PRESENT and WELL-FORMED, never a PARTICULAR value — which lane was used is the
// wrapper's business; that the receipt declares one at all is the gate's.
const isValidReceiptDelivery = (delivery) =>
  typeof delivery === 'string' && delivery.length > 0 && delivery.length <= 32 && /^[a-z][a-z0-9-]*$/.test(delivery);

// The D5 posture declaration (strip Phase 4): an object whose `model` is a NON-EMPTY string;
// `effort` (when present) a non-empty string; `tier` (when present) a non-empty string or null.
// Backend-agnostic — the wrapper is the writer authority on WHICH keys it declares.
const isValidReceiptPosture = (posture) => {
  if (posture === null || typeof posture !== 'object' || Array.isArray(posture)) return false;
  if (typeof posture.model !== 'string' || posture.model.length === 0) return false;
  if (Object.hasOwn(posture, 'effort') && (typeof posture.effort !== 'string' || posture.effort.length === 0)) return false;
  if (Object.hasOwn(posture, 'tier') && posture.tier !== null && (typeof posture.tier !== 'string' || posture.tier.length === 0)) return false;
  return true;
};

// Classify ONE receipt against a tree fingerprint. Order is load-bearing: identity first (is this
// even about the current tree?), then the probe marker (may it attest at all?), then the D5
// posture marker (same self-declaration doctrine — an absent/invalid posture is non-attesting,
// fail closed; pre-D5 receipts stop satisfying, the recovery is re-running the review), then the
// verdict-in-recognized-vocabulary arm BEFORE grounding — an unrecognized verdict is an
// unconditional refusal that grounding must never reclassify (an ungrounded `unknown` receipt
// otherwise reads UNGROUNDED and can be masked by another backend's SHIP), then grounding.
export const classifyReviewReceiptForTree = (receipt, fingerprint) => {
  if (!(receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)) || receipt.fresh !== true || receipt.artifact !== 'code' || receipt.fingerprint !== fingerprint) {
    return REVIEW_RECEIPT_CLASS.NOT_CURRENT;
  }
  if (!Object.hasOwn(receipt, 'probe')) return REVIEW_RECEIPT_CLASS.UNMARKED;
  if (typeof receipt.probe !== 'boolean') return REVIEW_RECEIPT_CLASS.MALFORMED_MARKER;
  if (receipt.probe === true) return REVIEW_RECEIPT_CLASS.PROBE;
  if (!Object.hasOwn(receipt, 'posture')) return REVIEW_RECEIPT_CLASS.POSTURE_UNMARKED;
  if (!isValidReceiptPosture(receipt.posture)) return REVIEW_RECEIPT_CLASS.MALFORMED_POSTURE;
  if (!isRecognizedVerdict(receipt.verdict)) return REVIEW_RECEIPT_CLASS.UNRECOGNIZED_VERDICT;
  if (receipt.grounded !== true) return REVIEW_RECEIPT_CLASS.UNGROUNDED;
  // LAST on purpose. The delivery arm may only intercept a receipt that would otherwise ATTEST:
  // placing it earlier pulled delivery-less `unrecognized-verdict` / `ungrounded` agy receipts out
  // of summarize's latest-NORMAL selection, so an EARLIER ship survived a LATER bad receipt — the
  // selection-first doctrine, broken silently. Those two classes stay byte-identical to before;
  // the ONE class this arm changes is the previously-attesting one, which is the point.
  if (DELIVERY_DECLARING_BACKENDS.has(receipt.backend)) {
    if (!Object.hasOwn(receipt, 'delivery')) return REVIEW_RECEIPT_CLASS.DELIVERY_UNMARKED;
    if (!isValidReceiptDelivery(receipt.delivery)) return REVIEW_RECEIPT_CLASS.MALFORMED_DELIVERY;
  }
  return REVIEW_RECEIPT_CLASS.ATTESTING;
};

// Summarize one backend's receipts for a tree → { state, receipt, counts… }. The LATEST NORMAL
// (probe-free, marker-valid, current-fingerprint) receipt is selected FIRST and THEN judged — a
// later unknown-verdict or ungrounded receipt never lets an earlier SHIP survive, and a probe (or
// forged marker) written after a real review never becomes the authoritative verdict.
export const summarizeReviewReceiptsForTree = (receipts, fingerprint) => {
  const classified = receipts
    .map((receipt) => ({ receipt, classification: classifyReviewReceiptForTree(receipt, fingerprint) }))
    .filter(({ classification }) => classification !== REVIEW_RECEIPT_CLASS.NOT_CURRENT);
  const rowsFor = (classification) => classified.filter((row) => row.classification === classification);
  const normal = classified.filter(({ classification }) =>
    classification === REVIEW_RECEIPT_CLASS.ATTESTING ||
    classification === REVIEW_RECEIPT_CLASS.UNGROUNDED ||
    classification === REVIEW_RECEIPT_CLASS.UNRECOGNIZED_VERDICT);
  const probe = rowsFor(REVIEW_RECEIPT_CLASS.PROBE);
  const unmarked = rowsFor(REVIEW_RECEIPT_CLASS.UNMARKED);
  const malformedMarker = rowsFor(REVIEW_RECEIPT_CLASS.MALFORMED_MARKER);
  const postureUnmarked = rowsFor(REVIEW_RECEIPT_CLASS.POSTURE_UNMARKED);
  const malformedPosture = rowsFor(REVIEW_RECEIPT_CLASS.MALFORMED_POSTURE);
  const deliveryUnmarked = rowsFor(REVIEW_RECEIPT_CLASS.DELIVERY_UNMARKED);
  const malformedDelivery = rowsFor(REVIEW_RECEIPT_CLASS.MALFORMED_DELIVERY);
  const counts = {
    currentCount: classified.length,
    ungroundedCount: rowsFor(REVIEW_RECEIPT_CLASS.UNGROUNDED).length,
    unrecognizedVerdictCount: rowsFor(REVIEW_RECEIPT_CLASS.UNRECOGNIZED_VERDICT).length,
    probeExcluded: probe.length,
    markerRejected: malformedMarker.length,
    unmarkedRejected: unmarked.length,
    postureRejected: postureUnmarked.length + malformedPosture.length,
    deliveryRejected: deliveryUnmarked.length + malformedDelivery.length,
  };
  if (normal.length > 0) {
    const latest = normal[normal.length - 1];
    if (latest.classification === REVIEW_RECEIPT_CLASS.ATTESTING) return { state: 'current', receipt: latest.receipt, ...counts };
    if (latest.classification === REVIEW_RECEIPT_CLASS.UNGROUNDED) return { state: 'ungrounded', receipt: latest.receipt, ...counts };
    return { state: 'unrecognized-verdict', receipt: latest.receipt, ...counts };
  }
  if (classified.length > 0) {
    return {
      state: malformedMarker.length > 0 || unmarked.length > 0 || counts.postureRejected > 0 || counts.deliveryRejected > 0 ? 'rejected' : 'probe',
      receipt: null,
      ...counts,
    };
  }
  return { state: 'none', receipt: null, ...counts };
};

// Why this backend has no attestation — one stated sentence per distinct recovery.
export const describeMissingReviewAttestation = (summary) => {
  if (summary.state === 'current') return null;
  const exclusions = [
    summary.probeExcluded > 0 ? `${summary.probeExcluded} probe receipt(s)` : null,
    summary.markerRejected > 0 ? `${summary.markerRejected} receipt(s) with a malformed probe marker` : null,
    summary.unmarkedRejected > 0 ? `${summary.unmarkedRejected} receipt(s) with no probe marker` : null,
    (summary.postureRejected ?? 0) > 0 ? `${summary.postureRejected} receipt(s) with an absent/invalid run posture (a pre-D5 wrapper — re-run the review on the current bridge)` : null,
    (summary.deliveryRejected ?? 0) > 0 ? `${summary.deliveryRejected} agy receipt(s) with an absent/invalid delivery declaration (minted before the change set was PROVEN delivered — re-run the review on the current bridge)` : null,
  ].filter(Boolean);
  const exclusionSuffix = exclusions.length > 0 ? `; excluded ${exclusions.join(', ')}` : '';
  if (summary.state === 'ungrounded') return `the latest normal receipt for the current tree is ungrounded${exclusionSuffix}`;
  if (summary.state === 'unrecognized-verdict') return `the latest normal receipt carries an unrecognized verdict (${JSON.stringify(summary.receipt?.verdict ?? null)}) — an unknown verdict never attests${exclusionSuffix}`;
  if (summary.state === 'probe') return 'only probe receipts exist for the current tree — a probe review never attests';
  if (summary.state === 'rejected') return `current-tree receipts have an untrustworthy probe marker, run posture or delivery declaration${exclusionSuffix}`;
  return 'no fresh code receipt exists for the current tree';
};
