// flow-check-rungs.mjs — the checker's EVIDENCE rungs (#61/#56/#65/#25/#42/#15/#3): pure
// predicates over flow records, core-evidence records, review receipts and an explicit tree —
// no store IO, no git. Split out of flow-check.mjs (baseline-practices tranche 1); the composed
// consumers (review-state, flow-writer) reach them through the flow-check facade.
//
// This is also the LOWER of the checker's pure modules, so the vocabulary its refusals share with
// flow-check-cores.mjs — the shortened digest and the verbatim pasteable flow-writer recovery
// command — is owned here: cores imports it, never the reverse, and the graph stays acyclic.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAIN_KIND, canonicalFlowDigest, authoritativeFlowRecords, flowTreeIdentity,
} from './flow-record.mjs';
import { resolveRecordReference } from './flow-store.mjs';
import { authoritativeOfKind, summarizeReviewReceiptsForTree } from './core-evidence.mjs';
import { FALLBACK_LENS_ADDITIONAL_ONLY } from './cheap-agents.mjs';

export const short = (digest) => `${digest.slice(0, 12)}…`;

// The verbatim pasteable recovery lane (Decision 3/8): every refusal that names a mintable record
// class prints the exact flow-writer command that mints it. The tool path is absolute (pasteable
// from any cwd) and POSIX single-quoted — raw path/id bytes must never execute on paste.
const FLOW_WRITER_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'flow-writer.mjs');
export const shellQuote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
export const writerCommand = (args) => `node ${shellQuote(FLOW_WRITER_TOOL)} ${args}`;

const isCanonicalInstant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

const hasOwnAdoption = (records, owner) =>
  records.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption' && r.owner === owner);

// #61: an unbroken declared-path delta chain lifts a stale receipt; each link consumes the
// refresh cap of the chain that minted its re-attestation.
export const classifyDeltaChain = ({ records, fromFingerprint, toFingerprint, declaredPaths, refreshCap }) => {
  if (!Number.isInteger(refreshCap) || refreshCap < 1) {
    return { classification: 'refused', reason: `the refresh cap must arrive as a positive-integer input (#45) — got ${JSON.stringify(refreshCap)} (fail closed)` };
  }
  const declared = Array.isArray(declaredPaths) ? declaredPaths : [];
  const deltas = authoritativeFlowRecords(records).filter((r) => r.kind === 'bookkeeping-delta');
  const links = [];
  const consumers = new Map();
  const visited = new Set([fromFingerprint]);
  let tip = fromFingerprint;
  while (tip !== toFingerprint) {
    const candidates = deltas.filter((d) => d.fingerprintBefore === tip);
    if (candidates.length === 0) {
      return { classification: 'refused', reason: `no bookkeeping-delta continues the chain at ${short(tip)} — a gap never classifies CURRENT (fail closed)` };
    }
    if (candidates.length > 1) {
      // FLOW-DELTA-FORK-NAMES-UNDECLARED: the declaredPaths restriction outranks the fork wording
      // — a mixed pair's actionable fact is the undeclared path, not the fork (both lanes refuse).
      const undeclared = candidates.filter((d) => !declared.includes(d.path));
      if (undeclared.length > 0) {
        return { classification: 'refused', reason: `bookkeeping-delta at ${undeclared.map((d) => d.path).join(', ')}: not a DECLARED bookkeeping path (declared: ${declared.join(', ') || 'none'}) — an undeclared-path delta never enters a classification chain, however valid its custody proof (fail closed)` };
      }
      return { classification: 'refused', reason: `${candidates.length} authoritative deltas fork the chain at ${short(tip)} — a fork never classifies CURRENT (fail closed)` };
    }
    const d = candidates[0];
    if (!declared.includes(d.path)) {
      return { classification: 'refused', reason: `bookkeeping-delta at ${d.path}: not a DECLARED bookkeeping path (declared: ${declared.join(', ') || 'none'}) — an undeclared-path delta never enters a classification chain, however valid its custody proof (fail closed)` };
    }
    const digest = canonicalFlowDigest(d);
    const at = records.indexOf(d);
    const attesting = records.find((s, j) => j > at && s.kind === CHAIN_KIND && s.purpose === 'refresh'
      && s.refreshedRecord === digest && s.fingerprintBefore === d.fingerprintAfter);
    if (attesting === undefined) {
      return { classification: 'refused', reason: `bookkeeping-delta at ${d.path}: no satisfying re-attestation — a mismatched or missing refresh link never carries the chain (fail closed)` };
    }
    const key = JSON.stringify([attesting.planId, attesting.cycle]);
    consumers.set(key, (consumers.get(key) ?? 0) + 1);
    links.push(d);
    tip = d.fingerprintAfter;
    if (visited.has(tip)) {
      return { classification: 'refused', reason: `the delta chain revisits ${short(tip)} — a cycle never classifies CURRENT (fail closed)` };
    }
    visited.add(tip);
  }
  const attribution = [...consumers.entries()].map(([key, count]) => {
    const [planId, cycle] = JSON.parse(key);
    const refreshes = records.filter((r) => r.kind === CHAIN_KIND && r.purpose === 'refresh' && r.planId === planId && r.cycle === cycle).length;
    return { planId, cycle, links: count, refreshes };
  });
  const exhausted = attribution.find((a) => a.refreshes > refreshCap);
  if (exhausted !== undefined) {
    return { classification: 'escalation', reason: `refresh cap exhausted for chain "${exhausted.planId}" (cycle ${exhausted.cycle}): ${exhausted.refreshes} refreshes exceed the cap ${refreshCap} (#45) — cap exhaustion escalates to a real round, never a silent pass` };
  }
  return { classification: 'current', links, attribution };
};

// #56: only the authoritative head of the veto instance lifts, exact-matching the full bound set.
export const evaluateVetoOverride = ({ records, vetoReceipt, tree }) => {
  const stands = (reason) => ({ lifted: false, reason });
  const vetoDigest = canonicalFlowDigest(vetoReceipt);
  const instance = records.filter((r) => r.kind === 'maintainer-override' && r.vetoReceiptDigest === vetoDigest);
  if (instance.length === 0) {
    if (!records.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption')) return stands('the flow is unarmed (no adoption record) — the override arm is inert and the veto stands');
    return stands(`a standing veto (backend "${vetoReceipt.backend}", verdict ${JSON.stringify(vetoReceipt.verdict)}) has no maintainer-override for its instance — degradation never lifts a veto (#48); only a checkpoint-approved override does`);
  }
  const head = instance[instance.length - 1];
  const prefix = records.slice(0, records.indexOf(head));
  if (!prefix.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption')) {
    return stands('the flow is unarmed at the override head (no adoption record precedes it) — a forward-referencing override never lifts and the veto stands');
  }
  const mismatch = (field, got, want) => stands(`the override head does not lift: bound-set mismatch on ${field} (override ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}) — the evaluation exact-matches the full #56 bound set`);
  if (head.backend !== vetoReceipt.backend) return mismatch('backend', head.backend, vetoReceipt.backend);
  if (head.verdict !== vetoReceipt.verdict) return mismatch('verdict', head.verdict, vetoReceipt.verdict);
  if (head.base !== tree.base) return mismatch('base', head.base, tree.base);
  if (head.fingerprint !== tree.fingerprint) return mismatch('fingerprint', head.fingerprint, tree.fingerprint);
  const target = resolveRecordReference(prefix, head.chainRecord);
  if (target === undefined || target.kind !== CHAIN_KIND) {
    return stands('the override head does not lift: bound-set mismatch on chainRecord — the digest does not resolve to a chain record PRECEDING the override (mint-time order decides)');
  }
  const chain = prefix.filter((r) => r.kind === CHAIN_KIND && r.planId === target.planId);
  if (chain[0].purpose !== 'adoption') {
    return stands('the override head does not lift: bound-set mismatch on chainRecord — the bound chain is not adopted');
  }
  return {
    lifted: true,
    label: `veto lifted by maintainer-override ${short(canonicalFlowDigest(head))} — backend "${head.backend}" verdict "${head.verdict}" (checkpoint-approved, #38/#56)`,
  };
};

// #65: a current-base red passes only through a rerun-cause naming ITS attempt, matched to a
// later first-of-its-attempt completed retry; base correlation is flow-side and must be unambiguous.
// Scope (the Phase-4 veteran-store dogfood catch): a red final minted strictly BEFORE this
// worktree's EARLIEST adoption instant is OUTSIDE the rung — no flow record could carry its tree
// BY CONSTRUCTION, so demanding the correlation retroactively would brick arming over any
// pre-flow evidence history. Both instants are RECORDED record fields in the CANONICAL
// UTC ISO form (#39 — check-time wall-clock never enters, and Date.parse's tolerance for
// non-canonical spellings never widens the boundary): ANY own-adoption instant that is not
// canonical disables the exemption ENTIRELY (a silently dropped broken instant would move the
// boundary to a LATER adoption — fail open), and a red final exempts only on its own canonical
// strictly-earlier instant. Stated residual: the two stores are deliberately not lock-coupled
// and their records remain forgeable (each store's own header says so) — a backdated or
// backwards-clock instant can move a red across this boundary; the cross-store arming-fence
// hardening is queued (FLOW-ARMING-FENCE-CROSS-STORE), never pretended here.
//
// The lane split (FLOW-FINAL-RED-DEADLOCK) — the same reasoning the D10 arm already applies one arm
// away (see the `consumer` paragraph in computeFlowDecision's own header; a line reference there
// would rot on the next insertion). The strict rule demands a receipt the gate's OWN run has not
// written yet: run-gates appends the final receipt only AFTER every gate has run, so an in-matrix
// flow-check can never see the completed retry that would answer the newest red, and each --final
// mints red N+1 — no number of rerun-causes converges. On the 'gate' lane a current-base red is
// therefore ALSO answered by a provable IN-PROGRESS retry: an authoritative rerun-cause naming its
// attempt AND binding the CURRENT fingerprint, plus a final-start at that fingerprint ordered
// STRICTLY AFTER that red whose attempt carries no completed final — the shape run-gates creates
// before any gate runs (run-gates.mjs:636-658), so inside a real final run the conjunction holds by
// construction while a standalone check on a quiet tree still refuses. The relaxation carries the
// SAME base correlation the strict rule demands of the retry tree: a fingerprint is not unique to a
// base (a clean tree hashes identically under every HEAD), so without it a cause minted at another
// base would answer the gate and leave a green final the commit boundary is guaranteed to reject —
// the relaxation must only ever admit a state a completed retry could actually clear. It is opt-in
// by EXACT match: any other consumer — unknown, misspelled, absent — evaluates the strict rule, and
// a tree whose fingerprint is unresolvable or ambiguously correlated never relaxes. The
// 'commit-guard' lane is unchanged; the commit boundary still demands a real completed retry.
// Stated residual: an INTERRUPTED final run leaves exactly that record shape with no live run
// behind it, so a standalone check reads PASS in that window. It authorizes nothing — commit-guard
// refuses the dangling start independently (commit-guard.mjs:213-223) and consults the STRICT lane
// (commit-guard.mjs:253) — and the window closes on the next completed final run. The real fix is a
// runner-attested capability (a one-time unpublished nonce over stdin or an inherited FD, verified
// against a one-way commitment recorded in the final-start); it needs its own IPC contract and is
// QUEUED, never pretended here.
export const collectUnansweredRedRefusals = ({ flowRecords, coreRecords, currentBase, owner, consumer = 'commit-guard', currentFingerprint = null }) => {
  if (!hasOwnAdoption(flowRecords, owner)) return [];
  const adoptionInstants = flowRecords
    .filter((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption' && r.owner === owner)
    .map((r) => (isCanonicalInstant(r.timestamp) ? Date.parse(r.timestamp) : null));
  const armingInstant = adoptionInstants.length > 0 && adoptionInstants.every((t) => t !== null)
    ? Math.min(...adoptionInstants) : null;
  const refusals = [];
  const identities = flowRecords.map(flowTreeIdentity);
  const basesAt = (fp) => [...new Set(identities.filter((t) => t.fingerprint === fp).map((t) => t.base))];
  const rerunCauses = authoritativeFlowRecords(flowRecords).filter((r) => r.kind === 'rerun-cause');
  const finals = coreRecords.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === 'final');
  const firstFinalByAttempt = new Map();
  for (const { r, i } of finals) {
    if (!firstFinalByAttempt.has(r.attempt)) firstFinalByAttempt.set(r.attempt, i);
  }
  const answeredBy = (red, redAt) => rerunCauses.some((c) => c.attempt === red.attempt
    && finals.some(({ r: g, i: gi }) => gi > redAt
      && basesAt(g.fingerprintBefore).length === 1 && basesAt(g.fingerprintBefore)[0] === currentBase
      && firstFinalByAttempt.get(g.attempt) === gi
      && c.fingerprint === g.fingerprintBefore));
  const completedAttempts = new Set(finals.map(({ r }) => r.attempt));
  const relaxes = consumer === 'gate' && typeof currentFingerprint === 'string' && currentFingerprint !== ''
    && basesAt(currentFingerprint).length === 1 && basesAt(currentFingerprint)[0] === currentBase;
  const inProgressRetryFor = (red, redAt) => rerunCauses.some((c) => c.attempt === red.attempt
    && c.fingerprint === currentFingerprint
    && coreRecords.some((s, si) => si > redAt && s.kind === 'final-start'
      && s.fingerprint === currentFingerprint && !completedAttempts.has(s.attempt)));
  for (const { r, i } of finals) {
    if (r.status !== 'red') continue;
    if (armingInstant !== null && isCanonicalInstant(r.timestamp) && Date.parse(r.timestamp) < armingInstant) continue;
    const bases = basesAt(r.fingerprintBefore);
    if (bases.length === 0) {
      refusals.push(`a red final (attempt "${r.attempt}") cannot be base-correlated: no flow record carries its tree fingerprint ${short(r.fingerprintBefore)} — the zero-base lane is a fail-closed ambiguity (#65); the rung demands exactly ONE base through the flow store`);
      continue;
    }
    if (bases.length > 1) {
      refusals.push(`a red final (attempt "${r.attempt}") resolves ${bases.length} distinct bases through the flow store — a multi-base correlation is a fail-closed ambiguity (#65); one tree fingerprint must carry exactly ONE base`);
      continue;
    }
    if (bases[0] !== currentBase) continue;
    if (!answeredBy(r, i) && !(relaxes && inProgressRetryFor(r, i))) {
      refusals.push(`a red final (attempt "${r.attempt}") on the CURRENT base (${bases[0] == null ? 'null' : short(bases[0])}) has no later completed retry cleared by a rerun-cause — an unanswered red never passes an armed flow (#65). recovery (edit the quoted cause, then paste; mint on the RETRY tree): ${writerCommand(`rerun-cause --attempt=${shellQuote(r.attempt)} --cause='<the stated cause>'`)}`);
    }
  }
  return refusals;
};

// collectDegradeCoverageRefusals (#25/#39): every authoritative core degrade at the current tree
// must be justified by a flow degrade-justification binding {downMark, degradeDigest, base} to a
// then-active mark of the same backend. All instants are RECORDED and canonical — wall-clock never
// enters the decision.
// #25/#42: every relied-on-backend degrade at the tree needs ONE fully-valid justification.
export const collectDegradeCoverageRefusals = ({ flowRecords, coreRecords, tree, owner, backends }) => {
  if (!hasOwnAdoption(flowRecords, owner)) return [];
  const refusals = [];
  const justifications = authoritativeFlowRecords(flowRecords).filter((r) => r.kind === 'degrade-justification');
  const justificationFailure = (j, degrade) => {
    if (j.base !== tree.base) {
      return `the degrade-justification for backend "${degrade.backend}" binds base ${j.base == null ? 'null' : short(j.base)}, not the current base — the {downMark, degradeDigest, base} binding is exact (#25)`;
    }
    if (j.fingerprint !== tree.fingerprint) {
      return `the degrade-justification for backend "${degrade.backend}" was minted at another tree (fingerprint ${short(j.fingerprint)}) — the per-{base, fingerprint} binding is exact (#25)`;
    }
    if (!isCanonicalInstant(j.timestamp)) {
      return `the degrade-justification for backend "${degrade.backend}" carries an unparseable instant ${JSON.stringify(j.timestamp)} — the decide layer requires a canonical UTC ISO instant (toISOString round-trip), by name (#39)`;
    }
    const jAt = flowRecords.indexOf(j);
    const mark = resolveRecordReference(flowRecords.slice(0, jAt), j.downMark);
    if (mark === undefined || mark.kind !== 'down-mark' || mark.backend !== degrade.backend) {
      return `the degrade-justification for backend "${degrade.backend}" does not ride a down-mark of that backend (${mark === undefined ? 'the downMark digest resolves to no EARLIER record — mint-time order decides' : `it targets a ${mark.kind} of backend "${mark.backend}"`}) — a mis-bound justification refuses (#25)`;
    }
    const closedBefore = flowRecords.some((c, k) => k < jAt && (c.kind === 'down-mark-up' || c.kind === 'down-mark-clear') && c.target === j.downMark);
    if (closedBefore) {
      return `the degrade-justification for backend "${degrade.backend}" rides a down-mark already closed by up/clear at mint time — a closed mark justifies nothing (#25)`;
    }
    if (!(Date.parse(j.timestamp) >= Date.parse(mark.timestamp) && Date.parse(j.timestamp) < Date.parse(mark.expiresAt))) {
      return `the degrade-justification for backend "${degrade.backend}" was minted outside its down-mark's active window (an expired-at-mint or pre-mark instant) — a then-unexpired mark is required (#25), never wall-clock at check time (#39)`;
    }
    return null;
  };
  for (const degrade of authoritativeOfKind(coreRecords, 'degrade')) {
    if (degrade.fingerprint !== tree.fingerprint || !backends.includes(degrade.backend)) continue;
    const digest = canonicalFlowDigest(degrade);
    const candidates = justifications.filter((x) => x.degradeDigest === digest);
    if (candidates.length === 0) {
      refusals.push(`a core degrade (backend "${degrade.backend}") the gate relies on at the current tree has no flow degrade-justification binding it — exact coverage refuses uncovered degrades on an armed flow (#25/#42). recovery (pasteable, needs a then-active down-mark): ${writerCommand(`degrade-justification --backend=${shellQuote(degrade.backend)}`)}`);
      continue;
    }
    const failures = candidates.map((j) => justificationFailure(j, degrade));
    if (!failures.includes(null)) refusals.push(failures[0]);
  }
  return refusals;
};

// evaluateInternalAttestationLenses (#15/#3, Phase 4.3): an internal-attestation whose lens set
// CLAIMS a review provider's slot (a lens named like a configured backend) must ride a
// THEN-ACTIVE down-mark for that backend — substitution is recorded, never silent; the refusal
// quotes the fallback lens's additional-only contract from its one home. "Then-active" is decided
// in the RAW prefix strictly before the attestation (mint-time order, the #25 discipline): the
// mark is unclosed there and its TTL window contains the attestation's instant — an unparseable
// attestation instant refuses by name, never passes.
export const evaluateInternalAttestationLenses = ({ record, records, providerBackends }) => {
  const at = records.indexOf(record);
  if (at === -1) {
    return { ok: false, reason: 'the internal-attestation record does not belong to the supplied record list — prefix scoping is undecidable (fail closed)' };
  }
  const prefix = records.slice(0, at);
  for (const lens of record.lenses) {
    if (!providerBackends.includes(lens)) continue;
    let active = null;
    for (const r of prefix) {
      if (r.kind === 'down-mark' && r.backend === lens) active = r;
      else if ((r.kind === 'down-mark-up' || r.kind === 'down-mark-clear') && r.backend === lens) active = null;
    }
    const failure = active === null
      ? `no down-mark for backend "${lens}" is open at the attestation's position`
      : !isCanonicalInstant(record.timestamp)
        ? `the attestation instant ${JSON.stringify(record.timestamp)} is not a canonical UTC ISO instant, so then-activity is undecidable`
        : !(Date.parse(record.timestamp) >= Date.parse(active.timestamp) && Date.parse(record.timestamp) < Date.parse(active.expiresAt))
          ? `the down-mark for backend "${lens}" is outside its active window at the attestation's instant`
          : null;
    if (failure !== null) {
      return { ok: false, reason: `the internal-attestation's lens set claims backend "${lens}"'s slot without a then-active down-mark (${failure}) — ${FALLBACK_LENS_ADDITIONAL_ONLY} (fail closed)` };
    }
  }
  return { ok: true };
};

// The ONE relied-on receipt selector (#42/#61): the latest normal receipt at the CURRENT tree,
// else — through an unbroken declared-path bookkeeping-delta chain — the backend's LAST receipt
// judged at its own tree, carrying the lift metadata the PASS labels consume.
export const selectReliedOnReceipt = ({ receipts, backend, tree, records, declaredPaths, refreshCap }) => {
  const own = receipts.filter((r) => r.backend === backend);
  const current = summarizeReviewReceiptsForTree(own, tree.fingerprint);
  if (current.state === 'current') return { receipt: current.receipt, lifted: 0 };
  const last = own[own.length - 1];
  const candidateFp = typeof last?.fingerprint === 'string' ? last.fingerprint : null;
  if (candidateFp == null || candidateFp === tree.fingerprint) return { receipt: null, lifted: 0 };
  const atCandidate = summarizeReviewReceiptsForTree(own, candidateFp);
  if (atCandidate.state !== 'current') return { receipt: null, lifted: 0 };
  const chain = classifyDeltaChain({ records, fromFingerprint: candidateFp, toFingerprint: tree.fingerprint, declaredPaths, refreshCap });
  if (chain.classification !== 'current') return { receipt: null, lifted: 0 };
  return { receipt: atCandidate.receipt, lifted: chain.links.length };
};

// #42: each relied-on backend's selected receipt must ride an OWN round's dispatch ledger; with
// lift inputs supplied the selection spans the delta lift, so a LIFTED receipt demands its
// binding at ITS OWN fingerprint; the entry's dispatchBase must equal the round's recorded base.
export const collectReceiptCoverageRefusals = ({ flowRecords, receipts, tree, owner, backends, declaredPaths = null, refreshCap = null }) => {
  if (!hasOwnAdoption(flowRecords, owner)) return [];
  const refusals = [];
  const rounds = authoritativeFlowRecords(flowRecords).filter((r) => r.kind === CHAIN_KIND && r.purpose === 'round' && r.owner === owner);
  for (const backend of [...new Set(backends)]) {
    const relied = declaredPaths != null
      ? selectReliedOnReceipt({ receipts, backend, tree, records: flowRecords, declaredPaths, refreshCap }).receipt
      : summarizeReviewReceiptsForTree(receipts.filter((r) => r.backend === backend), tree.fingerprint).receipt;
    if (relied == null) continue;
    const digest = canonicalFlowDigest(relied);
    const covered = rounds.some((round) => round.fingerprint === relied.fingerprint
      && round.dispatches.some((e) => e.receiptDigest === digest && e.backend === relied.backend && e.dispatchBase === round.base));
    if (!covered) {
      refusals.push(`the review receipt the decision relies on (backend "${backend}", verdict ${JSON.stringify(relied.verdict)}) is bound by NO round dispatch-ledger entry of this worktree's chains — an unbound receipt never satisfies an armed flow (#42); land the {receiptDigest, backend, dispatchBase} entry through a round revision`);
    }
  }
  return refusals;
};
