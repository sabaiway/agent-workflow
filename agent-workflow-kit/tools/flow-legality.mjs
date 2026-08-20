// flow-legality.mjs — the two raw-order legality walks over an in-memory record list: chain
// sequence legality (validateChainSequence, with the private round-revision rule it enforces) and
// stateful-kind supersession legality (validateSupersessions). Split out of flow-record.mjs
// unchanged (baseline-practices tranche 3), which now re-exports both names here.
//
// Pure form: no filesystem, no git, no CLI, no side effects on import. RAW order is the input — the
// authoritative latest-per-key view deliberately never reaches these walks. Reference RESOLUTION
// against a real store lands with flow-store/flow-check; this module resolves references only
// inside the list it is handed. The HIGHEST leaf of the family: it composes the vocabulary, the
// shape validator and the identity digests, and nothing here reaches back up to the facade.

import { ALLOWED_TRANSITIONS, CHAIN_KIND, PLAN_LANE_PURPOSES, refuse } from './flow-vocabulary.mjs';
import { validateFlowRecord } from './flow-record-shape.mjs';
import { canonicalFlowDigest, flowCanonicalSerialization } from './flow-record-identity.mjs';

// A same-index round REVISION re-states its round: opensFrom/base/fingerprint/commitEpoch are
// byte-equal to the previous version (the receipt attests the DISPATCHED tree, even when the live
// tree has moved on), existing ledger entries keep their order (a pending dispatch may land IN
// PLACE — both digests arrive together; a landed entry stays byte-identical), and new entries
// append only at the tail. Entry equality is canonical, never insertion-order-sensitive.
const validateRoundRevision = (prev, r) => {
  for (const field of ['opensFrom', 'base', 'fingerprint', 'commitEpoch']) {
    if (r[field] !== prev[field]) {
      return refuse(`chain sequence: a round revision re-states its round — ${field} stays unchanged (the receipt attests the DISPATCHED tree)`);
    }
  }
  if (r.dispatches.length < prev.dispatches.length) {
    return refuse('chain sequence: a round revision never regresses its dispatch ledger (an entry disappeared)');
  }
  for (let i = 0; i < prev.dispatches.length; i += 1) {
    const before = prev.dispatches[i];
    const after = r.dispatches[i];
    if (flowCanonicalSerialization(before) === flowCanonicalSerialization(after)) continue;
    const landedInPlace = before.receiptDigest === null && after.receiptDigest !== null
      && flowCanonicalSerialization({ ...after, receiptDigest: null, findingManifestDigest: null }) === flowCanonicalSerialization(before);
    if (!landedInPlace) {
      return refuse(`chain sequence: a round revision never regresses or mutates its dispatch ledger (entry ${i} — only pending → landed enriches, in place)`);
    }
  }
  if (r.dispositions.length < prev.dispositions.length) {
    return refuse('chain sequence: a round revision never regresses its disposition ledger (an entry disappeared)');
  }
  for (let i = 0; i < prev.dispositions.length; i += 1) {
    if (flowCanonicalSerialization(prev.dispositions[i]) !== flowCanonicalSerialization(r.dispositions[i])) {
      return refuse(`chain sequence: a round revision never regresses its disposition ledger (entry ${i} — existing dispositions stay byte-identical, new ones append at the tail)`);
    }
  }
  return { ok: true };
};

// ── chain sequence legality (raw order, one chain) ────────────────────────────────────────────────

// validateChainSequence(records) → { ok } | { ok: false, reason }. Input: the RAW-order chain
// records of ONE plan's chain. Enforces: starts at adoption and adoption never recurs (#44/#58);
// serial-monotonic step grouping with closure scoped per {cycle, stepId} (a stepId reopens in a
// LATER cycle through an ordinary opener — the redesign valve); the within-step successor table;
// a step opens with "round" carrying the prior-terminal reference (structural half — digest
// resolution against the store lands with flow-check); a boundary re-baseline records disjoint
// base motion anchored to the prior terminal without reopening anything; park admits only resume
// and both preserve the pre-park {cycle, round}; complete admits no successor. Park/resume/complete
// are explicit writer actions — this validator only refuses (#59).
export const validateChainSequence = (records) => {
  if (!Array.isArray(records)) return refuse('chain sequence: records must be an array');
  if (records.length === 0) return { ok: true };
  for (const r of records) {
    if (r?.kind !== CHAIN_KIND) return refuse(`chain sequence: the validator accepts chain records only (got kind ${JSON.stringify(r?.kind)})`);
    const v = validateFlowRecord(r);
    if (!v.ok) return refuse(`chain sequence: malformed member — ${v.reason}`);
    if (r.planId !== records[0].planId) return refuse(`chain sequence: one validator run covers one plan's chain (got "${records[0].planId}" and "${r.planId}")`);
    if (r.owner !== records[0].owner) return refuse(`chain sequence: chain records never migrate owners — every record carries the adoption owner ("${records[0].owner}", got "${r.owner}"); an ownership transfer needs an explicit protocol, never a silent field change`);
  }
  if (records[0].purpose !== 'adoption') {
    return refuse(`chain sequence: the chain starts at adoption — first record is "${records[0].purpose}"`);
  }
  const closureKey = (cycle, stepId) => JSON.stringify([cycle, stepId]);
  const state = {
    mode: 'boundary',
    parked: null,
    completed: false,
    currentStep: null,
    stepCycle: null,
    currentRound: null,
    lastPurpose: null,
    lastTerminated: null,
    boundaryRound: records[0].round,
    closedSteps: new Set(),
    lastCycle: records[0].cycle,
    lastEpoch: records[0].commitEpoch,
    roundLedgers: new Map(),
  };
  const contextCycle = () => (state.mode === 'in-step' ? state.stepCycle : state.lastCycle);
  const contextRound = () => (state.mode === 'in-step' ? state.currentRound : state.boundaryRound);
  const ledgerKey = (r) => JSON.stringify([r.cycle, r.stepId, r.round]);
  for (const r of records.slice(1)) {
    const p = r.purpose;
    if (state.completed) return refuse('chain sequence: complete admits no successor');
    if (r.cycle < state.lastCycle) return refuse(`chain sequence: the cycle index is monotonic (${state.lastCycle} → ${r.cycle})`);
    // A same-index round record is a LEDGER REVISION — a non-lifecycle enrichment that repeats the
    // DISPATCHED tree's epoch and never enters the lifecycle epoch cursor.
    const isRevision = p === 'round' && state.mode === 'in-step' && state.parked === null
      && r.stepId === state.currentStep && r.round === state.currentRound;
    if (!isRevision) {
      if (r.commitEpoch < state.lastEpoch) return refuse(`chain sequence: commitEpoch never regresses (${state.lastEpoch} → ${r.commitEpoch})`);
      state.lastEpoch = r.commitEpoch;
    }
    if (state.parked !== null) {
      if (p !== 'resume') return refuse(`chain sequence: park admits only resume (got "${p}")`);
      if (r.cycle !== state.parked.cycle || r.round !== state.parked.round) {
        return refuse(`chain sequence: resume must carry the pre-park cycle and round (${state.parked.cycle}/${state.parked.round}, got ${r.cycle}/${r.round}) — a new cycle starts by an explicit transition after resume`);
      }
      state.parked = null;
      continue;
    }
    if (p === 'adoption') return refuse("chain sequence: adoption is only ever the chain's first record");
    if (PLAN_LANE_PURPOSES.includes(p)) {
      if (p === 'park') {
        if (r.cycle !== contextCycle() || r.round !== contextRound()) {
          return refuse(`chain sequence: park must carry the pre-park cycle and round (${contextCycle()}/${contextRound()}, got ${r.cycle}/${r.round})`);
        }
        state.parked = { cycle: r.cycle, round: r.round };
      } else if (p === 'resume') {
        return refuse('chain sequence: resume without a preceding park');
      } else {
        if (state.mode === 'in-step') return refuse('chain sequence: complete may not interrupt an open step — the step ends at converged');
        state.completed = true;
        state.lastCycle = r.cycle;
      }
      continue;
    }
    if (state.mode === 'in-step') {
      if (r.stepId !== state.currentStep) {
        return refuse(`chain sequence: step sequences are serial — a record of step "${r.stepId}" interleaves open step "${state.currentStep}"`);
      }
      if (r.cycle !== state.stepCycle) return refuse('chain sequence: the cycle changes only at a step boundary');
      if (!ALLOWED_TRANSITIONS.withinStep[state.lastPurpose].includes(p)) {
        return refuse(`chain sequence: illegal within-step transition ${state.lastPurpose} → ${p} (allowed: ${ALLOWED_TRANSITIONS.withinStep[state.lastPurpose].join(', ')})`);
      }
      if (p === 'round') {
        if (r.round === state.currentRound) {
          const revised = validateRoundRevision(state.roundLedgers.get(ledgerKey(r)), r);
          if (!revised.ok) return revised;
          state.roundLedgers.set(ledgerKey(r), r);
          continue;
        }
        if (r.round < state.currentRound) return refuse(`chain sequence: the round index must increase within a step (${state.currentRound} → ${r.round})`);
        if (r.opensFrom !== null) return refuse('chain sequence: only a step-opening round carries a prior-terminal reference');
        state.currentRound = r.round;
        state.roundLedgers.set(ledgerKey(r), r);
      } else if (r.round !== state.currentRound) {
        return refuse(`chain sequence: a non-round record carries its step's current round index (${state.currentRound}, got ${r.round})`);
      }
      state.lastPurpose = p;
      if (p === 'converged') {
        state.mode = 'boundary';
        state.closedSteps.add(closureKey(state.stepCycle, state.currentStep));
        state.lastTerminated = { step: state.currentStep, round: state.currentRound, cycle: state.stepCycle };
        state.boundaryRound = state.currentRound;
      }
    } else if (p === 'unfreeze') {
      if (state.lastTerminated === null) return refuse('chain sequence: unfreeze requires a prior converged terminal');
      if (r.stepId !== state.lastTerminated.step) {
        return refuse(`chain sequence: unfreeze reopens only the step that just converged ("${state.lastTerminated.step}", got "${r.stepId}")`);
      }
      if (r.round !== state.lastTerminated.round) return refuse('chain sequence: unfreeze carries the converged round index');
      if (r.cycle !== state.lastTerminated.cycle) {
        return refuse("chain sequence: unfreeze reopens only in its terminal's cycle — a later cycle reopens the stepId through an ordinary opening round");
      }
      state.mode = 'in-step';
      state.currentStep = r.stepId;
      state.stepCycle = r.cycle;
      state.currentRound = r.round;
      state.lastPurpose = 'unfreeze';
      state.closedSteps.delete(closureKey(r.cycle, r.stepId));
    } else if (p === 're-baseline') {
      const anchorStep = state.lastTerminated === null ? null : state.lastTerminated.step;
      if (r.stepId !== anchorStep) {
        return refuse(`chain sequence: a boundary re-baseline anchors to the prior terminal's stepId (${JSON.stringify(anchorStep)}, got ${JSON.stringify(r.stepId)}) — it reopens nothing`);
      }
      if (r.round !== state.boundaryRound) return refuse(`chain sequence: a boundary re-baseline carries the boundary round index (${state.boundaryRound}, got ${r.round})`);
      if (r.cycle !== state.lastCycle) return refuse('chain sequence: a re-baseline never moves the cycle — base motion is not a redesign');
    } else if (p === ALLOWED_TRANSITIONS.stepOpening) {
      if (state.closedSteps.has(closureKey(r.cycle, r.stepId))) {
        return refuse(`chain sequence: step "${r.stepId}" already converged in cycle ${r.cycle} — a converged step reopens only through the unfreeze lane`);
      }
      if (r.opensFrom === null) {
        return refuse("chain sequence: a step-opening round must carry the prior-terminal reference (opensFrom) — the plan's first step references the adoption record itself");
      }
      if (r.round < 1) return refuse('chain sequence: a step opens at round 1 or later');
      state.mode = 'in-step';
      state.currentStep = r.stepId;
      state.stepCycle = r.cycle;
      state.currentRound = r.round;
      state.lastPurpose = 'round';
      state.roundLedgers.set(ledgerKey(r), r);
    } else {
      return refuse(`chain sequence: a step sequence opens with "${ALLOWED_TRANSITIONS.stepOpening}" (got "${p}")`);
    }
    state.lastCycle = r.cycle;
  }
  return { ok: true };
};

// ── stateful-kind supersession legality (raw order, in-memory list) ───────────────────────────────

// validateSupersessions(records) → { ok } | { ok: false, reason }. Walks RAW order and resolves
// supersession targets among EARLIER records by per-record canonical digest: down-mark-up/clear
// must target an earlier down-mark of the SAME backend; a maintainer-override chain is linear per
// veto instance — the first override carries supersedes: null, every later one must supersede the
// CURRENT head (a stale target would fork the chain and let latest-per-key bury a live override
// without explicit supersession, #56). Out-of-order and mis-targeted supersessions refuse by name.
export const validateSupersessions = (records, digestOf = canonicalFlowDigest) => {
  const seen = new Map();
  const overrideHeads = new Map();
  const activeMarks = new Map();
  for (const r of records) {
    if (r.kind === 'down-mark') {
      if (activeMarks.has(r.backend)) {
        return refuse(`down-mark: backend "${r.backend}" already carries an ACTIVE down-mark — it must be explicitly closed by up/clear before a new mark lands (supersession is explicit, never silent)`);
      }
      activeMarks.set(r.backend, digestOf(r));
    }
    if (r.kind === 'down-mark-up' || r.kind === 'down-mark-clear') {
      const target = seen.get(r.target);
      if (target === undefined) return refuse(`${r.kind}: the supersession target does not resolve to an EARLIER record (out-of-order or unknown) — a supersession lands only after its down-mark`);
      if (target.kind !== 'down-mark') return refuse(`${r.kind}: the supersession target is a ${target.kind}, not a down-mark (mis-targeted)`);
      if (target.backend !== r.backend) return refuse(`${r.kind}: the supersession target belongs to backend "${target.backend}", not "${r.backend}" (mis-targeted)`);
      const active = activeMarks.get(r.backend);
      if (active === undefined) return refuse(`${r.kind}: no active down-mark for backend "${r.backend}" — the family is closed (or never opened); a new down-mark opens a new instance`);
      if (r.target !== active) return refuse(`${r.kind}: the supersession targets a stale down-mark — up/clear must target the backend's ACTIVE mark`);
      activeMarks.delete(r.backend);
    }
    if (r.kind === 'maintainer-override') {
      const head = overrideHeads.get(r.vetoReceiptDigest);
      if (r.supersedes === null) {
        if (head !== undefined) return refuse('maintainer-override: only the first override of a veto instance carries supersedes: null — a later override must supersede the CURRENT head');
      } else {
        const target = seen.get(r.supersedes);
        if (target === undefined) return refuse('maintainer-override: supersedes does not resolve to an EARLIER record (out-of-order or unknown)');
        if (target.kind !== 'maintainer-override') return refuse(`maintainer-override: supersedes must target a maintainer-override record, not a ${target.kind} (mis-targeted)`);
        if (target.vetoReceiptDigest !== r.vetoReceiptDigest) return refuse('maintainer-override: the supersession crosses veto instances — one override binds exactly one veto instance (mis-targeted)');
        if (r.supersedes !== head) return refuse('maintainer-override: supersedes targets a STALE override — a later override must supersede the CURRENT head of its veto instance');
      }
      overrideHeads.set(r.vetoReceiptDigest, digestOf(r));
    }
    seen.set(digestOf(r), r);
  }
  return { ok: true };
};
