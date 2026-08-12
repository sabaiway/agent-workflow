// flow-check-cores.mjs — the checker's decision cores over the FULL read-results of BOTH stores
// (flow + core evidence) and the tree context: store health, chain adoption and transition
// legality, prior-terminal references, worktree scoping, bookkeeping-delta custody and
// re-attestation, degrade-before-final ordering, armed base motion — and `decideFlowCheck`, the
// ONE composition every consumer reads. Split out of flow-check.mjs (baseline-practices tranche 1);
// the CLI, the store reads and the report render stay there.
//
// Pure: no store IO and no git of its own — the base-motion inputs arrive as INJECTED resolvers,
// so flow-check-git-lane.mjs is never imported here. The evidence rungs live one module down
// (flow-check-rungs.mjs), which also owns the refusal vocabulary both halves share.

import {
  CHAIN_KIND, validateChainSequence, validateSupersessions, canonicalFlowDigest,
  authoritativeFlowRecords,
} from './flow-record.mjs';
import {
  walkChainState, validateOpenerReference, resolveRecordReference, isAuthoritativeReferenceTarget,
} from './flow-store.mjs';
import {
  short, shellQuote, writerCommand,
  collectUnansweredRedRefusals, collectDegradeCoverageRefusals, collectReceiptCoverageRefusals,
} from './flow-check-rungs.mjs';

// The checker only refuses — park/resume/complete are explicit writer actions (#59). Printed
// operand shapes: flag values ride the inline --flag='value' form and positionals follow a
// literal ` -- ` — one shape for EVERY id, so a leading-dash operand stays recoverable.
const parkRecovery = (planId) =>
  `recovery (pasteable): ${writerCommand(`park -- ${shellQuote(planId)}`)}`;

// Arms in dependency order; the first failing arm reports, and integrityClean gates the caller's
// dependent arms (base motion) off a broken chain.
const planRefusals = (records, chain, planId, owner, advisories) => {
  if (chain[0].purpose !== 'adoption') {
    return { integrityClean: false, refusals: [`plan "${planId}": the chain has no content-digest-bound adoption record — a chain starts at adoption binding the plan content digest (#58); the store is append-only, so inspect how this chain was written`] };
  }
  const seq = validateChainSequence(chain);
  if (!seq.ok) return { integrityClean: false, refusals: [`plan "${planId}": illegal transition — ${seq.reason}`] };
  const state = walkChainState(chain);
  const referenceIssues = [];
  for (const { record } of state.openers) {
    const check = validateOpenerReference(records.slice(0, records.indexOf(record)), record);
    if (!check.ok) referenceIssues.push(`plan "${planId}": step-opening round (step "${record.stepId}") — ${check.reason}`);
  }
  for (const r of chain) {
    if (r.purpose !== 'refresh') continue;
    const prefix = records.slice(0, records.indexOf(r));
    if (resolveRecordReference(prefix, r.refreshedRecord) === undefined) {
      referenceIssues.push(`plan "${planId}": a refresh's refreshedRecord does not match the store (no earlier record digests to ${short(r.refreshedRecord)}) — a re-attestation binds an existing record`);
    } else if (!isAuthoritativeReferenceTarget(prefix, r.refreshedRecord)) {
      referenceIssues.push(`plan "${planId}": a refresh's refreshedRecord targets a superseded record — a re-attestation binds the authoritative latest record of its key (as of the refresh's own raw position)`);
    }
  }
  if (referenceIssues.length > 0) return { integrityClean: false, refusals: referenceIssues };
  const open = !state.completed && !state.parked && state.mode === 'in-step';
  if (!open) return { integrityClean: true, refusals: [] };
  if (chain[0].owner !== owner) {
    advisories.push(`plan "${planId}": an OPEN chain owned by "${chain[0].owner}" (a foreign worktree) — advisory visibility only, never this tree's refusal (#57)`);
    return { integrityClean: true, refusals: [] };
  }
  return { integrityClean: true, refusals: [`plan "${planId}" has an OPEN chain owned by this worktree ("${owner}"): step "${state.stepId}" is not converged — a commit closes only at a terminal. ${parkRecovery(planId)}`] };
};

// The custody arm verifies the PERSISTED proof against a bare declaration (#60): the masked
// recompute must equal fingerprintBefore, and every delta must be re-attested by a SUBSEQUENT
// chain refresh binding {refreshedRecord, fingerprintBefore = the delta's fingerprintAfter} (#45)
// — an earlier or fingerprint-mismatched record never satisfies (raw order decides). Satisfaction
// is STORE-GLOBAL: the locked delta shape carries no chain field, so WHICH chain's refresh cap
// the re-attestation consumes is the Plan-3 decideCheck arm (#61), not a Plan-2 refusal.
// The recovery lane needs the invoker's OWN OPEN chains: a refresh is a within-step record, so
// only such a chain can carry the re-attestation (and its refresh cap is what the mint consumes,
// #61). A command under a "pasteable" label is always CONCRETE — with no own open chain the
// recovery states the precondition instead of printing a placeholder command.
const ownOpenChainPlanIds = (records, owner) =>
  [...new Set(records.filter((r) => r.kind === CHAIN_KIND).map((r) => r.planId))].filter((planId) => {
    const chain = records.filter((r) => r.kind === CHAIN_KIND && r.planId === planId);
    if (chain[0].owner !== owner || chain[0].purpose !== 'adoption' || !validateChainSequence(chain).ok) return false;
    const state = walkChainState(chain);
    return !state.completed && !state.parked && state.mode === 'in-step';
  });

// The ONE per-record custody predicate (Plan 4 Phase 3, round-2 fold): the confinement equality
// + the mint-only invariants the record-level shape validation cannot see — shared by the
// gate-time walk below and the writer's terminal move validation, so a forged proof can neither
// pass the gates nor carry a terminal. → issue string | null.
export const deltaCustodyIssue = (r) => {
  if (r.custodyProof.maskedFingerprint !== r.fingerprintBefore) {
    return `the persisted custody proof does not prove confinement (maskedFingerprint ${short(r.custodyProof.maskedFingerprint)} ≠ fingerprintBefore ${short(r.fingerprintBefore)}) — a bare or tampered declaration never passes; re-mint through mintBookkeepingDelta`;
  }
  const proof = r.custodyProof;
  const mintInvariant = !proof.tracked ? null
    : proof.preClass !== 'present' ? 'a tracked path with an absent pre-state never mints'
    : proof.indexDigest === null ? 'a staged deletion (a HEAD entry without an index entry) never mints'
    : proof.worktreeDigest !== proof.indexDigest ? 'the clean-at-path rule (pre-change worktree bytes = the index entry) never minted this'
    : null;
  return mintInvariant === null ? null : `the persisted custody proof violates a mint invariant — ${mintInvariant}; an unmintable proof never passes (fail closed)`;
};

const deltaRefusals = (records, owner) => {
  const refusals = [];
  const openPlanIds = ownOpenChainPlanIds(records, owner);
  // The re-attestation OBLIGATION binds only AUTHORITATIVE deltas: a superseded same-key delta
  // never enters classifyDeltaChain and the refresh preflight refuses to reference it, so
  // demanding its refresh would be exactly the unrecoverable red the plan bans — supersession is
  // the store's own recovery valve. Custody and mint checks stay RAW-wide (tamper detection).
  const authoritative = new Set(authoritativeFlowRecords(records));
  records.forEach((r, i) => {
    if (r.kind !== 'bookkeeping-delta') return;
    const custody = deltaCustodyIssue(r);
    if (custody !== null) {
      refusals.push(`bookkeeping-delta at ${r.path}: ${custody}`);
      return;
    }
    if (!authoritative.has(r)) return;
    const digest = canonicalFlowDigest(r);
    const satisfied = records.some((s, j) => j > i && s.kind === CHAIN_KIND && s.purpose === 'refresh'
      && s.refreshedRecord === digest && s.fingerprintBefore === r.fingerprintAfter);
    if (!satisfied) {
      const recovery = openPlanIds.length > 0
        ? `recovery (pasteable; choose the chain whose refresh cap this consumes, #61): ${openPlanIds.map((planId) => writerCommand(`refresh --cause='bookkeeping delta re-attestation' --refreshed-record=${digest} -- ${shellQuote(planId)}`)).join('  OR  ')}`
        : `recovery: no own OPEN chain can carry the re-attestation yet — open the owning plan's step round, then mint the refresh binding --refreshed-record=${digest}`;
      refusals.push(`bookkeeping-delta at ${r.path}: no satisfying re-attestation — a SUBSEQUENT chain refresh must bind {refreshedRecord: ${short(digest)}, fingerprintBefore: ${short(r.fingerprintAfter)}}; an earlier or fingerprint-mismatched record never satisfies. ${recovery}`);
    }
  });
  return refusals;
};

// Degrade-before-final (#64), decidable from RAW core-store order and grouped BY FINGERPRINT: a
// degrade after a final-start at the same fingerprint refuses unless a LATER final-start at that
// fingerprint completed (its `final` record landed after it). The checker reads raw records,
// never the authoritative selection (#65).
const degradeOrderingRefusals = (coreRecords) => {
  const refusals = [];
  coreRecords.forEach((r, i) => {
    if (r.kind !== 'degrade') return;
    const startedBefore = coreRecords.some((s, j) => j < i && s.kind === 'final-start' && s.fingerprint === r.fingerprint);
    if (!startedBefore) return;
    const cured = coreRecords.some((s, j) => j > i && s.kind === 'final-start' && s.fingerprint === r.fingerprint
      && coreRecords.some((c, k) => k > j && c.kind === 'final' && c.attempt === s.attempt && c.fingerprintBefore === s.fingerprint));
    if (!cured) {
      refusals.push(`a core degrade (backend "${r.backend}") landed AFTER a final-start at its fingerprint (${short(r.fingerprint)}) with no later completed re-run at it — degrades mint strictly BEFORE the final run (#64); re-run run-gates.mjs --final on this tree`);
    }
  });
  return refusals;
};

// #62: base delta ∩ plan surface — disjoint ⇒ re-baseline, intersecting/undecidable ⇒ refresh.
export const classifyBaseMotion = ({ baseDelta, changedSurface }) => {
  if (!baseDelta?.ok) {
    return { motion: 'undecidable', requires: 'refresh', reason: `the base delta is undecidable (${baseDelta?.reason ?? 'no delta supplied'}) — fail closed: a refresh dispatch is REQUIRED (#62)` };
  }
  if (!changedSurface?.ok) {
    return { motion: 'undecidable', requires: 'refresh', reason: `the changed surface is undecidable (${changedSurface?.reason ?? 'no surface supplied'}) — fail closed: a refresh dispatch is REQUIRED (#62)` };
  }
  const surface = new Set(changedSurface.paths);
  const witness = baseDelta.paths.find((p) => surface.has(p));
  if (witness !== undefined) return { motion: 'intersecting', requires: 'refresh', witness };
  return { motion: 'disjoint', requires: 're-baseline' };
};

// In-step base transitions of the LAST segment (lifecycle projection — round revisions collapsed)
// must land the class the delta requires; boundary and park→resume are exempt (every commit moves
// HEAD); the tail binds only a live in-step chain.
const baseMotionRefusals = (chain, planId, owner, motion) => {
  if (chain[0].owner !== owner) return [];
  const display = (b) => (b == null ? 'null' : short(b));
  const refusals = [];
  const classify = (fromBase, toBase) => classifyBaseMotion({
    baseDelta: motion.resolveBaseDelta(fromBase, toBase),
    changedSurface: motion.resolveChangedSurface(),
  });
  const requirement = (cls) => (cls.motion === 'disjoint' ? 'the delta is disjoint from the plan surface — re-baseline only, never a dispatch (#40)'
    : cls.motion === 'intersecting' ? `the delta intersects the plan surface at ${cls.witness}`
    : cls.reason);
  const seenRounds = new Set();
  const lifecycle = chain.filter((r) => {
    if (r.purpose !== 'round') return true;
    const key = JSON.stringify([r.cycle, r.stepId, r.round]);
    if (seenRounds.has(key)) return false;
    seenRounds.add(key);
    return true;
  });
  const isSegmentStart = (r) => r.purpose === 'resume' || r.purpose === 'unfreeze' || (r.purpose === 'round' && r.opensFrom !== null);
  const states = [];
  const walk = { mode: 'boundary', parked: false };
  for (const r of lifecycle) {
    states.push({ ...walk });
    if (r.purpose === 'park') walk.parked = true;
    else if (r.purpose === 'resume') walk.parked = false;
    else if (r.purpose === 'converged' || r.purpose === 'complete') walk.mode = 'boundary';
    else if (r.purpose === 'unfreeze' || (r.purpose === 'round' && walk.mode === 'boundary')) walk.mode = 'in-step';
  }
  const segStart = lifecycle.reduce((last, r, i) => (isSegmentStart(r) ? i : last), 0);
  for (let i = segStart + 1; i < lifecycle.length; i += 1) {
    const prev = lifecycle[i - 1];
    const r = lifecycle[i];
    if (states[i].mode !== 'in-step' || states[i].parked || r.base === prev.base) continue;
    const cls = classify(prev.base, r.base);
    if (r.purpose !== cls.requires) {
      refusals.push(`plan "${planId}": a mid-step base transition (${display(prev.base)} → ${display(r.base)}) landed a "${r.purpose}" record but requires a ${cls.requires} record — ${requirement(cls)}; final gates must re-run after base motion (#62)`);
      continue;
    }
    if (r.purpose === 're-baseline' && r.baseBefore !== prev.base) {
      refusals.push(`plan "${planId}": the mid-step re-baseline's baseBefore (${display(r.baseBefore)}) does not match the previous record's base (${display(prev.base)}) — a re-baseline binds the actual pre-motion base (#62)`);
    }
  }
  const state = walkChainState(chain);
  if (state.completed || state.parked || state.mode !== 'in-step') return refusals;
  const recorded = lifecycle[lifecycle.length - 1].base;
  if (recorded === motion.currentBase) return refusals;
  const cls = classify(recorded, motion.currentBase);
  const recovery = cls.requires === 're-baseline'
    ? writerCommand(`re-baseline -- ${shellQuote(planId)}`)
    : writerCommand(`refresh --cause='base motion' --refreshed-record=${canonicalFlowDigest(chain[chain.length - 1])} -- ${shellQuote(planId)}`);
  const tailRequirement = cls.requires === 're-baseline'
    ? 'a re-baseline record suffices (the delta is disjoint from the plan surface)'
    : `a refresh dispatch is REQUIRED (${cls.motion === 'intersecting' ? `the delta intersects the plan surface at ${cls.witness}` : cls.reason})`;
  refusals.push(`plan "${planId}": the base moved under the armed chain (recorded ${display(recorded)} → current ${display(motion.currentBase)}) and no ${cls.requires} record landed — ${tailRequirement}; final gates must re-run after base motion (#62). recovery (pasteable): ${recovery}`);
  return refusals;
};

// decideFlowCheck({ flowRead, coreRead, owner, motion?, evidence?, consumer? }) → { refusals,
// advisories }. Pure — consumes the FULL read-results of both stores; store health fails closed
// BEFORE any content judgment. `motion` ({ currentBase, resolveBaseDelta, resolveChangedSurface })
// arms the Step-1.4 base-motion refusals; `evidence` ({ receipts, tree, backends }) arms the three
// Phase-1 rungs (#65/#25/#42 — each self-gates on an OWN adoption). Absent inputs keep the decision
// byte-identical to the Plan-2 checker. `consumer` rides through to the #65 lane split and defaults
// to the STRICT lane, so a caller that forgets to thread it inherits strictness.
export const decideFlowCheck = ({ flowRead, coreRead, owner, flowPath = 'the flow store', corePath = 'the core evidence store', motion = null, evidence = null, consumer = 'commit-guard' }) => {
  const refusals = [];
  const advisories = [];
  if (flowRead.readError) refusals.push(`the flow store is unreadable (${flowRead.readError}) — the checker consumes the FULL read-result; inspect ${flowPath} (fail closed)`);
  else if (flowRead.malformed > 0) refusals.push(`the flow store carries ${flowRead.malformed} malformed line(s) (${flowRead.malformedReasons[0]}) — unknown kinds and broken records fail closed; inspect ${flowPath}`);
  if (coreRead.readError) refusals.push(`the core evidence store is unreadable (${coreRead.readError}) — inspect ${corePath} (fail closed)`);
  else if ((coreRead.malformed ?? 0) > 0) refusals.push(`the core evidence store carries ${coreRead.malformed} malformed line(s) (${coreRead.malformedReasons[0]}) — inspect ${corePath} (fail closed)`);
  if (refusals.length > 0) return { refusals, advisories };
  const records = flowRead.records;
  const sup = validateSupersessions(records);
  if (!sup.ok) refusals.push(`supersession legality: ${sup.reason} — inspect ${flowPath}`);
  for (const planId of [...new Set(records.filter((r) => r.kind === CHAIN_KIND).map((r) => r.planId))]) {
    const chain = records.filter((r) => r.kind === CHAIN_KIND && r.planId === planId);
    const plan = planRefusals(records, chain, planId, owner, advisories);
    refusals.push(...plan.refusals);
    if (motion != null && plan.integrityClean) refusals.push(...baseMotionRefusals(chain, planId, owner, motion));
  }
  refusals.push(...deltaRefusals(records, owner));
  refusals.push(...degradeOrderingRefusals(coreRead.records));
  if (evidence != null) {
    refusals.push(...collectUnansweredRedRefusals({ flowRecords: records, coreRecords: coreRead.records, currentBase: evidence.tree.base, owner, consumer, currentFingerprint: evidence.tree.fingerprint }));
    refusals.push(...collectDegradeCoverageRefusals({ flowRecords: records, coreRecords: coreRead.records, tree: evidence.tree, owner, backends: evidence.degradeBackends }));
    refusals.push(...collectReceiptCoverageRefusals({ flowRecords: records, receipts: evidence.receipts, tree: evidence.tree, owner, backends: evidence.receiptBackends, declaredPaths: evidence.declaredPaths, refreshCap: evidence.refreshCap }));
  }
  return { refusals, advisories };
};
