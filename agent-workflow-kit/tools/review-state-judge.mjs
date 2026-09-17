// review-state-judge.mjs — the review-state decision leaf; its normative contract is review-state.mjs's header.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeForDisplay, shellQuoteArg } from './repo-lex.mjs';
import { readDelegationLedger } from './dispatch-store-read.mjs';
import {
  decideHeldSession, HELD_EXECUTE_WRAPPER, HELD_RECEIPT_BACKEND, judgeLedger,
} from './held-session.mjs';
import {
  summarizeReviewReceiptsForTree,
  isShipVerdict,
  resolveEvidencePath,
  readEvidence,
  authoritativeOfKind,
} from './core-evidence.mjs';

export const ACTIVITY = 'plan-execution';
export const SLOT = 'review';
const CORE_EVIDENCE_TOOL = shellQuoteArg(join(dirname(fileURLToPath(import.meta.url)), 'core-evidence.mjs'));
const DISPATCH_TOOL = shellQuoteArg(join(dirname(fileURLToPath(import.meta.url)), 'dispatch.mjs'));

// The clean-tree PASS wording, split so the doc-parity registry can bind the forward-looking half
// to the mode doc — the notice is the contract, not decoration.
export const CLEAN_TREE_PASS = 'the working tree is clean — nothing to review';
export const LATENT_ARM_NOTICE = 'this gate arms as soon as the tree is dirty';

const UNSAFE_INLINE_SCALARS = /[\u007f-\u009f\u2028\u2029]/gu;
// A plan FILENAME reaches a one-line gate report. JSON quoting handles the C0 control bytes; the C1
// range (DEL + U+0080..U+009F, including the U+0085 line break) and the two Unicode line separators
// survive JSON.stringify and can still break a line, so they are escaped explicitly — every escape a
// valid JSON \uXXXX, so the token round-trips through JSON.parse. The plan set stays STRING-typed for
// its consumers (procedures / worktrees / the JSON surface); a name carrying INVALID UTF-8 bytes is a
// stated residual (queue: PARALLEL-TRACK-REDESIGN — two such names could collapse in the DISPLAY only,
// never in the gate decision, which keys on the receipt fingerprint, not the name).
export const quoteReportName = (name) =>
  JSON.stringify(name).replace(
    UNSAFE_INLINE_SCALARS,
    (value) => `\\u${value.codePointAt(0).toString(16).padStart(4, '0')}`,
  );

// Per-backend receipt status for the current fingerprint, over the ONE shared attesting-receipt
// predicate — the LATEST NORMAL (probe-free, marker-valid, current-fingerprint) receipt is
// selected FIRST and THEN judged, so a later unknown/ungrounded receipt never lets an earlier
// SHIP survive:
//   current              — the latest normal receipt ATTESTS (grounded + recognized verdict);
//                          its verdict rides — ONLY ship-class satisfies, a recognized negative
//                          is an authoritative veto;
//   ungrounded           — the latest normal receipt carries grounded:false;
//   unrecognized-verdict — the latest normal receipt carries a verdict outside the closed
//                          vocabulary (an unknown verdict never attests — fail closed);
//   probe                — current receipts exist and EVERY one is a well-formed probe (D3);
//   rejected             — current receipts exist, none normal, and >=1 marker malformed/absent;
//   stale                — receipts exist, none for the current fingerprint (edited after review);
//   missing              — no receipt from this backend at all.
export const backendReceiptStatus = (receipts, backend, fingerprint) => {
  const own = receipts.filter((r) => r.backend === backend);
  const summary = summarizeReviewReceiptsForTree(own, fingerprint);
  const counts = {
    probeExcluded: summary.probeExcluded,
    markerRejected: summary.markerRejected,
    unmarkedRejected: summary.unmarkedRejected,
    postureRejected: summary.postureRejected,
    deliveryRejected: summary.deliveryRejected,
  };
  if (summary.state === 'current') {
    return { state: 'current', verdict: summary.receipt.verdict ?? 'unknown', shipClass: isShipVerdict(summary.receipt.verdict), grounded: true, timestamp: summary.receipt.timestamp ?? null, ...counts };
  }
  if (summary.state === 'ungrounded' || summary.state === 'unrecognized-verdict') {
    return { state: summary.state, verdict: summary.receipt.verdict ?? 'unknown', shipClass: false, grounded: summary.receipt.grounded === true, timestamp: summary.receipt.timestamp ?? null, ...counts };
  }
  if (summary.state === 'probe' || summary.state === 'rejected') {
    return { state: summary.state, verdict: null, shipClass: false, grounded: null, timestamp: null, ...counts };
  }
  return { state: own.length > 0 ? 'stale' : 'missing', verdict: null, shipClass: false, grounded: null, timestamp: null, ...counts };
};

// degradeRecordSet — the D3(b) escape: an EXPLICIT per-backend, per-tree degrade RECORD in the
// core-evidence store is the ONLY exemption lane. Fail-closed: an unreadable/malformed store
// DENIES every exemption (surfaced), but never fails a tree whose receipts independently satisfy
// the gate. A stale-fingerprint record never exempts (the authoritative record per {backend,
// fingerprint} must attest THIS tree).
export const degradeRecordSet = ({ cwd, env = process.env, fingerprint }) => {
  const storePath = resolveEvidencePath(cwd, env);
  const read = storePath ? readEvidence(storePath) : { records: [], malformed: 0, malformedReasons: [] };
  const unavailable = (read.malformed ?? 0) > 0 || read.readError != null;
  const records = unavailable ? [] : authoritativeOfKind(read.records, 'degrade');
  const set = unavailable || fingerprint == null
    ? new Set()
    : new Set(records.filter((r) => r.fingerprint === fingerprint).map((r) => r.backend));
  return { set, records, storePath, malformed: read.malformed ?? 0, readError: read.readError ?? null, unavailable };
};

export const selectHeldSessionDegrades = (records) =>
  records.filter((record) => record.kind === 'degrade' && record.backend === HELD_EXECUTE_WRAPPER);

export const shouldReadHeldSession = ({ configuredExecute, plans, fingerprint, clean }) =>
  configuredExecute === 'delegated' && plans.length > 0 && fingerprint !== null && clean === false;

export const buildHeldSessionState = ({
  cwd,
  env,
  configuredExecute,
  plans,
  fingerprint,
  clean,
  degrades,
  resolveStore,
  readStore,
  audit,
  readHead,
}) => {
  if (!shouldReadHeldSession({ configuredExecute, plans, fingerprint, clean })) return null;
  const ledger = readDelegationLedger(cwd, env, { resolveStore, readStore, audit, readHead });
  return judgeLedger(ledger, { backend: HELD_RECEIPT_BACKEND, degrades });
};

// Why a backend's current-tree receipts were all rejected — the causes read differently and
// have different recoveries (fix the file vs refresh the bridge), so they are never collapsed.
export const rejectionCause = (b) => {
  const parts = [];
  if (b.markerRejected > 0) parts.push(`${b.markerRejected} with a malformed probe marker`);
  if (b.unmarkedRejected > 0) {
    parts.push(`${b.unmarkedRejected} with no probe marker — silence is not a declaration, so the probe status is untrustworthy; re-run the review with a bridge that marks its runs`);
  }
  if ((b.postureRejected ?? 0) > 0) {
    parts.push(`${b.postureRejected} with an absent/invalid run posture (D5) — a pre-posture wrapper minted it; re-run the review on the current bridge`);
  }
  if ((b.deliveryRejected ?? 0) > 0) {
    parts.push(`${b.deliveryRejected} with an absent/invalid delivery declaration (D8b) — the receipt never declared HOW the change set reached the model, so delivery was not proven; re-run the review on the current bridge`);
  }
  return parts.join(' + ');
};

// One failing backend row → its stated recovery. Shared by the council per-backend arm and the
// reviewed closest-recovery listing.
const backendFailurePart = (b, state) => {
  if (b.state === 'current') return `${b.backend}: latest recognized verdict is ${JSON.stringify(b.verdict)} — a recognized negative is an authoritative veto; fold and re-review`;
  if (b.state === 'unrecognized-verdict') return `${b.backend}: the latest normal receipt carries an unrecognized verdict (${JSON.stringify(b.verdict)}) — an unknown verdict never attests (fail-closed); re-run the review`;
  if (b.state === 'ungrounded') return `${b.backend}: the latest normal receipt is ungrounded — re-run grounded (--facts)`;
  if (b.state === 'probe') return `${b.backend}: only probe receipts for the current tree (CODEX_PROBE=1 / AGY_PROBE=1 relaxes the quality guards) — a probe review never attests; re-run a real one`;
  if (b.state === 'rejected') return `${b.backend}: current-tree receipts rejected — ${rejectionCause(b)} (fail-closed); inspect ${escapeForDisplay(state.receiptsPath)}`;
  if (b.state === 'stale') return `${b.backend}: receipts exist but none matches the current tree (edited after review) — run a fresh review`;
  return `${b.backend}: no receipt — run its review wrapper, or record an explicit degrade (node ${CORE_EVIDENCE_TOOL} degrade --backend ${b.backend} --reason "...")`;
};

const describesHeldRecovery = (state) => {
  const substitution = state.heldSession.substitution;
  if (substitution === null) return '';
  if (substitution.baseKind === 'checkpoint') {
    return ` — a checkpoint-based thread: no core-evidence degrade lifts it; record its ledger degrade (node ${DISPATCH_TOOL} degrade --wave <wave> --nonce ${shellQuoteArg(substitution.nonce)} --step-class code --rationale "...") then retry it (cap permitting) or open a new thread on the held session, and fold that`;
  }
  const canRetry = substitution.folded === false;
  if (state.evidenceUnavailable === true) {
    const retry = canRetry ? '; or fold the retry of that thread' : '';
    return ` — the evidence store is unavailable, so the degrade lane cannot be judged: repair it (inspect ${escapeForDisplay(state.evidenceStorePath)}) and re-check${retry}`;
  }
  const canDegrade = typeof substitution.postTreeDigest === 'string'
    && state.fingerprint === substitution.postTreeDigest;
  if (!canDegrade && !canRetry) {
    return ' — no recovery lane remains: the tree moved after the substituted return and that thread is folded; re-dispatch the work under the held session';
  }
  const degrade = canDegrade
    ? ` — mint the accepted-replacement record now, before the next edit: node ${CORE_EVIDENCE_TOOL} degrade --backend ${HELD_EXECUTE_WRAPPER} --reason "..."`
    : '';
  const retry = canRetry ? `${canDegrade ? '; or' : ' —'} fold the retry of that thread` : '';
  return `${degrade}${retry}`;
};

// The normative --check decision (the header contract, in order). → { code, reason }.
// Obligations come from the CONFIGURED recipe; satisfaction is SHIP-CLASS ONLY; a recognized
// negative on the latest normal receipt VETOES; an explicit current-tree degrade record is the
// only escape for an unavailable backend under council — and never all backends (>=1 ship-class
// attestation is required whenever >=1 backend is configured).
export const decideCheck = (state) => {
  // Store diagnostics ride EVERY check line, early exits (and the unknowable arm) included — a
  // malformed receipt line, an unavailable evidence store, or an unreadable receipts store is
  // never hidden behind any exit.
  const malformedNote = state.malformed > 0 ? ` — ${state.malformed} malformed receipt line(s) ignored; inspect ${escapeForDisplay(state.receiptsPath)}` : '';
  const evidenceNote = state.evidenceUnavailable
    ? ` — evidence store unavailable (${state.evidenceMalformed} malformed line(s)${state.evidenceReadError ? `, read error: ${state.evidenceReadError}` : ''}); the degrade escape is denied (fail-closed) — inspect ${escapeForDisplay(state.evidenceStorePath)}`
    : '';
  const earlyNotes = `${malformedNote}${evidenceNote}${state.receiptsReadError ? ` — receipts store unreadable (${state.receiptsReadError}); inspect ${escapeForDisplay(state.receiptsPath)}` : ''}`;
  // The git LOCATION (hand-built states carry none; the fingerprint decides there) rules below the solo arm: not-a-repository passes, the four other non-work-tree states refuse by name.
  const location = state.location ?? { state: state.fingerprint == null ? 'not-a-repository' : 'work-tree', cause: 'no location was resolved for a hand-built state' };
  if (state.heldSession !== null && state.heldSession !== undefined) {
    const held = decideHeldSession(state.heldSession);
    const heldRecovery = describesHeldRecovery(state);
    if (held.code !== 0) return { ...held, reason: `${held.reason}${heldRecovery}${earlyNotes}`, terminal: true, heldSession: true };
  }
  // Detector failure with NO configured recipe: the computed default is unknowable → fail closed.
  // An EXPLICIT configured recipe needs no detector — its obligations are readiness-independent.
  if (state.obligations.unknowable) {
    return { code: 1, reason: `cannot verify receipts — ${state.detectionWarning} No configured ${ACTIVITY}.${SLOT} recipe: the computed default is unknowable while the detector is down (fail closed).${earlyNotes}` };
  }
  if (state.obligations.recipe === 'solo' && !state.flowArmed && state.flowBrokenReason == null) {
    const why = state.obligations.source === 'config'
      ? `configured ${ACTIVITY}.${SLOT} recipe is solo`
      : `no reviewer backend is ready — the computed ${ACTIVITY}.${SLOT} default is solo`;
    return { code: 0, reason: `${why} — no receipt required${earlyNotes}` };
  }
  // An UNANCHORED root (git dead everywhere): the bare-cwd plan inventory cannot say "no plan".
  if (location.state !== 'work-tree' && location.state !== 'not-a-repository' && state.rootAnchored === false) return { code: 1, reason: `the git location is ${location.state} — ${escapeForDisplay(location.cause)} — and the project root cannot be anchored, so the plan arm cannot decide (fail closed)${earlyNotes}` };
  if (state.plans.length === 0) return { code: 0, reason: `no plan in flight (docs/plans/ holds no active plan) — no receipt required${earlyNotes}` };
  if (location.state !== 'work-tree' && location.state !== 'not-a-repository') return { code: 1, reason: `the git location is ${location.state} — ${escapeForDisplay(location.cause)} — refusing to judge receipts for a tree git cannot name (fail closed)${earlyNotes}` };
  if (location.state === 'not-a-repository') return { code: 0, reason: `not a git repository (git's own answer: ${escapeForDisplay(location.cause)}) — nothing to fingerprint${earlyNotes}` };
  if (state.fingerprint == null || state.clean === null) return { code: 1, reason: `the tree ${state.fingerprint == null ? 'fingerprint' : 'clean check'} is undecidable in a work tree (a git query failed or was killed) — refusing to judge receipts (fail closed)${earlyNotes}` };
  // A clean tree PASSES, but never silently: >=1 plan IS in flight here, and this gate arms the
  // moment the tree turns dirty — naming each file makes the arm discoverable BEFORE it blocks.
  if (state.clean === true) {
    // Each name is byte-preserving and quoted because this reason is one gate-report line.
    const named = state.plans.map((p) => quoteReportName(p)).join(', ');
    return { code: 0, reason: `${CLEAN_TREE_PASS} — ${state.plans.length} plan(s) in flight: ${named} — ${LATENT_ARM_NOTICE}${earlyNotes}` };
  }
  // Tier-1 fail-closed (P3): a PRESENT flow store must read clean before the decision leans on
  // receipts — the flow arms cannot be evaluated over a store of unknown content.
  if (state.flowBrokenReason != null) {
    return { code: 1, reason: `the flow store is unavailable (${state.flowBrokenReason}) — the flow arms fail closed; inspect the store${earlyNotes}` };
  }
  // The no-reviewers-configured floor (#34/#43): an ARMED flow makes the reduced record set an
  // OBLIGATION for the solo class — every in-flight plan covered by an adopted chain AND
  // internally attested at the current tree; a standing current-tree veto still blocks (#48),
  // whatever the recipe consults, so a recipe flip to solo can never bury one.
  if (state.obligations.recipe === 'solo') {
    if (state.receiptsReadError != null) {
      return { code: 1, reason: `the receipts store is unreadable (${state.receiptsReadError}) — "no standing veto" cannot be established, so the internal-only floor fails closed; inspect ${escapeForDisplay(state.receiptsPath)}${earlyNotes}` };
    }
    const standing = state.soloVetoRows.filter((b) => (b.state === 'current' && !b.shipClass && !b.overrideLabel) || b.state === 'unrecognized-verdict');
    if (standing.length > 0) {
      // `veto` marks the AUTHORITATIVE-veto class only (a recognized negative) — the Decision-4
      // --await early exit keys on it; an unrecognized verdict stays a plain fail-closed refusal.
      const authoritative = standing.some((b) => b.state === 'current' && !b.shipClass);
      return { code: 1, reason: `${standing.map((b) => backendFailurePart(b, state)).join('; ')} — a standing veto blocks the internal-only floor (#48)${earlyNotes}`, ...(authoritative ? { veto: true } : {}) };
    }
    const uncovered = state.planCoverage.filter((p) => !p.covered);
    if (uncovered.length > 0) {
      return { code: 1, reason: `internal-only arming refused (#68): ${uncovered.map((p) => `plan ${quoteReportName(p.plan)} — ${p.reason}`).join('; ')} — an uncovered in-flight plan is a refusal, never a relaxation${earlyNotes}` };
    }
    const missing = state.planCoverage.filter((p) => !state.attestedPlanIds.includes(p.planId));
    if (missing.length > 0) {
      // A lens-refused attestation is a NAMED cause, never a silent gap — the refusal rides the
      // floor's failure reason for exactly the plans it starved.
      const lensNotes = (state.lensRefusedAttestations ?? []).filter((x) => missing.some((p) => p.planId === x.planId));
      const lensSuffix = lensNotes.length > 0 ? `; ${lensNotes.map((x) => x.reason).join('; ')}` : '';
      return { code: 1, reason: `internal-only floor: no internal-attestation record at the current tree for plan(s) ${missing.map((p) => quoteReportName(p.plan)).join(', ')} — the reduced record set (#34/#43) requires one per covered plan (minting rides the Plan-4 round machinery)${lensSuffix}${earlyNotes}` };
    }
    const floorLabels = [
      ...state.soloVetoRows.filter((b) => b.deltaLift != null).map((b) => `${b.backend}: receipt lifted to CURRENT through an unbroken bookkeeping-delta chain (${b.deltaLift} link(s), #61)`),
      ...state.soloVetoRows.filter((b) => b.overrideLabel).map((b) => b.overrideLabel),
      'internal-only (downgraded class)',
    ];
    const liftedTail = floorLabels.length > 1 ? ` — ${floorLabels.slice(0, -1).join('; ')}` : '';
    return {
      code: 0,
      reason: `internal-only floor satisfied (DOWNGRADED class, #28/#43): the solo recipe under an ARMED flow consumes the reduced record set — every in-flight plan (${state.planCoverage.map((p) => quoteReportName(p.plan)).join(', ')}) is covered by an adopted chain and internally attested at the current tree; self-authored review, disclosed${liftedTail}${earlyNotes}`,
      flowLabels: floorLabels,
    };
  }
  const exempt = new Set(state.degradedExempt);
  const satisfied = state.backends.filter((b) => b.state === 'current' && b.shipClass);
  const vetoed = state.backends.filter((b) => b.state === 'current' && !b.shipClass && !b.overrideLabel);
  const overridden = state.backends.filter((b) => b.state === 'current' && !b.shipClass && b.overrideLabel);
  // The marker note is PATH-AWARE (no silent rejections on any exit): it counts every backend's
  // untrusted-marker exclusions EXCEPT those whose printed part already names them — i.e. only a
  // PRINTED `rejected` row (backendFailurePart's rejectionCause) suppresses its own counts; a
  // printed veto/unrecognized/ungrounded row does not, and success paths suppress nothing.
  const notesFor = (printed) => {
    const total = state.backends
      .filter((b) => !(printed.has(b.backend) && b.state === 'rejected'))
      .reduce((n, b) => n + (b.markerRejected ?? 0) + (b.unmarkedRejected ?? 0), 0);
    const markerNote = total > 0
      ? ` — ${total} receipt(s) rejected: an untrustworthy probe marker (malformed, or absent — silence is not a declaration) — fail-closed; inspect ${escapeForDisplay(state.receiptsPath)}`
      : '';
    return `${markerNote}${earlyNotes}`;
  };
  const NONE_PRINTED = new Set();
  // UNCONDITIONAL refusals, checked BEFORE minShip/exemptions: a recognized NEGATIVE (the
  // authoritative veto) and an UNRECOGNIZED verdict (fail closed) — another backend's SHIP never
  // masks them and a degrade record never lifts them (the backend demonstrably ran).
  const unrecognized = state.backends.filter((b) => b.state === 'unrecognized-verdict');
  const unconditional = [...vetoed, ...unrecognized];
  if (unconditional.length > 0) {
    // `veto` marks the AUTHORITATIVE-veto class only (Decision 4): --await ends the wait loudly on
    // it — a landed negative is the dispatched review's ANSWER, never a condition to out-wait.
    return { code: 1, reason: `${unconditional.map((b) => backendFailurePart(b, state)).join('; ')}${notesFor(new Set(unconditional.map((b) => b.backend)))}`, ...(vetoed.length > 0 ? { veto: true } : {}) };
  }
  // The armed-flow PASS labels (#61/#38): the delta-lift and override facts ride every PASS reason
  // and the flowLabels field the commit-guard PASS line consumes. Empty (and absent) unarmed.
  const flowNotes = [
    ...state.backends.filter((b) => b.deltaLift != null)
      .map((b) => `${b.backend}: receipt lifted to CURRENT through an unbroken bookkeeping-delta chain (${b.deltaLift} link(s), #61)`),
    ...overridden.map((b) => b.overrideLabel),
  ];
  const flowSuffix = flowNotes.length > 0 ? ` — ${flowNotes.join('; ')}` : '';
  const pass = (reason) => (state.flowArmed ? { code: 0, reason, flowLabels: flowNotes } : { code: 0, reason });
  const perBackendFailing = state.backends.filter((b) => !(b.state === 'current' && b.shipClass) && !exempt.has(b.backend) && !b.overrideLabel);
  // Never all degraded: >=1 ship-class attestation whenever >=1 backend is configured. An
  // already-exempt backend renders its own honest part — never the "record an explicit degrade"
  // recovery it has already taken.
  if (satisfied.length < state.obligations.minShip) {
    const failing = state.backends.filter((b) => !(b.state === 'current' && b.shipClass) && !b.overrideLabel);
    const allExempt = failing.length > 0 && failing.every((b) => exempt.has(b.backend));
    const head = failing.length === 0
      ? 'every configured backend is veto-overridden for this tree — >=1 non-overridden ship-class attestation is required; run at least one real review'
      : allExempt
        ? `every configured backend is ${overridden.length > 0 ? 'degrade-recorded or veto-overridden' : 'degrade-recorded'} for this tree — never all degraded: >=1 ${overridden.length > 0 ? 'non-degraded, non-overridden' : 'non-degraded'} ship-class attestation is required; run at least one real review`
        : failing
            .map((b) => (exempt.has(b.backend)
              ? `${b.backend}: degrade-recorded for this tree — a degrade never counts toward the >=1 ship-class floor; run a real review on another backend`
              : backendFailurePart(b, state)))
            .join('; ');
    // Only backends that actually rendered their backendFailurePart suppress their counts — an
    // exempt row prints the degrade string (no rejectionCause), so its exclusions stay named.
    return { code: 1, reason: `${head}${notesFor(new Set(failing.filter((b) => !exempt.has(b.backend)).map((b) => b.backend)))}` };
  }
  if (state.obligations.perBackend) {
    // Council: EVERY configured backend must attest ship-class OR carry a current-tree degrade
    // record OR a lifted maintainer-override.
    if (perBackendFailing.length > 0) {
      return { code: 1, reason: `${perBackendFailing.map((b) => backendFailurePart(b, state)).join('; ')}${notesFor(new Set(perBackendFailing.map((b) => b.backend)))}` };
    }
    if (exempt.size === 0 && overridden.length === 0) {
      return pass(`every configured backend attests ship-class for the current tree (${state.requiredBackends.join(' + ')})${flowSuffix}${notesFor(NONE_PRINTED)}`);
    }
    const clauses = [`council satisfied: ship-class attestation(s) from ${satisfied.map((b) => b.backend).join(' + ')}`];
    if (exempt.size > 0) clauses.push(`degrade-recorded for this tree: ${[...exempt].join(', ')}`);
    return pass(`${clauses.join('; ')}${flowSuffix}${notesFor(NONE_PRINTED)}`);
  }
  // Reviewed: >=1 ship-class attestation from any review-capable backend satisfies.
  return pass(`reviewed satisfied: ship-class attestation from ${satisfied.map((b) => b.backend).join(' + ')} for the current tree${flowSuffix}${notesFor(NONE_PRINTED)}`);
};
