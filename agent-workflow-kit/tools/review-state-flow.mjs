// review-state-flow.mjs - plan-adoption coverage and the armed-flow arms.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DISPLAY_ALIASES } from './recipes.mjs';
import { resolveFlowStorePath, readFlowStore, deriveFlowOwner, readPlanFrontmatterId } from './flow-store.mjs';
import { CHAIN_KIND, authoritativeFlowRecords } from './flow-record.mjs';
import { selectReliedOnReceipt, evaluateVetoOverride, evaluateInternalAttestationLenses } from './flow-check.mjs';
import { PLANS_REL } from './plan-files.mjs';
import { summarizeReviewReceiptsForTree, isShipVerdict } from './core-evidence.mjs';

// The in-flight-plan → adopted-chain coverage map (P13/P19): ONE bounded read + ONE hash per plan
// file; coverage requires the frontmatter planId, the FULL content digest, and the owner to match
// the adoption record — a mismatch on any axis refuses internal-only arming by name.
export const computePlanAdoptionCoverage = ({ root, plans, records, owner, readFile = readFileSync }) =>
  plans.map((plan) => {
    let bytes;
    try {
      bytes = readFile(join(root, PLANS_REL, plan));
    } catch (err) {
      return { plan, planId: null, covered: false, reason: `the plan file is unreadable (${(err && err.code) || (err && err.message) || err})` };
    }
    const buf = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    const planId = readPlanFrontmatterId(buf.toString('utf8'));
    if (planId == null) return { plan, planId: null, covered: false, reason: 'no frontmatter planId — plan filenames are never chain identity (#58); adopt the plan through the flow writer' };
    const adoptionRecord = records.find((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption' && r.planId === planId);
    if (adoptionRecord === undefined) return { plan, planId, covered: false, reason: `no adoption record for planId "${planId}"` };
    if (adoptionRecord.planDigest !== createHash('sha256').update(buf).digest('hex')) {
      return { plan, planId, covered: false, reason: 'the plan content no longer matches its adoption record (edited after adoption)' };
    }
    if (adoptionRecord.owner !== owner) {
      return { plan, planId, covered: false, reason: `the adoption is owned by "${adoptionRecord.owner}", not this worktree ("${owner}") — a foreign-owner adoption never arms internal-only here` };
    }
    return { plan, planId, covered: true };
  });

// Tier 1 is store-file PRESENCE: no file ⇒ every field below stays inert and the decision is
// byte-identical to the pre-flow checker (the unarmed fast path also reads NO plan file).
export const readFlowArming = ({ cwd, env, lstat }) => {
  const flowPath = resolveFlowStorePath(cwd, env);
  const flowStat = (() => {
    if (flowPath == null) return null;
    try {
      return lstat(flowPath);
    } catch (err) {
      return err && err.code === 'ENOENT' ? null : 'unstatable';
    }
  })();
  const flowPresent = flowStat !== null;
  const flowRead = flowPresent && flowStat !== 'unstatable' ? readFlowStore(flowPath) : null;
  const flowBrokenReason = !flowPresent ? null
    : flowStat === 'unstatable' ? 'the store leaf cannot be stat-ed (fail closed)'
    : flowRead.readError != null ? `read error: ${flowRead.readError}`
    : flowRead.malformed > 0 ? `${flowRead.malformed} malformed line(s) (${flowRead.malformedReasons[0]})`
    : null;
  const flowArmed = flowPresent && flowBrokenReason == null
    && flowRead.records.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption');
  const flowOwner = flowArmed ? deriveFlowOwner(cwd) : null;
  return { flowPresent, flowArmed, flowBrokenReason, flowOwner, records: flowArmed ? flowRead.records : [] };
};

// The lens-substitution rung (#15/#3): an attestation whose lens set claims a review provider's
// slot without a then-active down-mark never counts — and its refusal is NAMED, never silent
// (lensRefusedAttestations feeds the internal-only floor's failure reason).
export const attestedPlanIdsFor = ({ records, base, fingerprint }) => {
  const lensRefusedAttestations = [];
  const attestedPlanIds = [...new Set(authoritativeFlowRecords(records)
    .filter((r) => r.kind === 'internal-attestation' && r.base === base && r.fingerprint === fingerprint)
    .filter((r) => {
      const lensCheck = evaluateInternalAttestationLenses({ record: r, records, providerBackends: Object.values(DISPLAY_ALIASES) });
      if (!lensCheck.ok) {
        lensRefusedAttestations.push({ planId: r.planId, reason: lensCheck.reason });
        return false;
      }
      return true;
    })
    .map((r) => r.planId))];
  return { attestedPlanIds, lensRefusedAttestations };
};

// #61: the SHARED relied-on selector (one home with the flow-check coverage rung) — an unbroken
// declared-path bookkeeping-delta chain lifts the backend's last receipt; any break, fork, or
// cap exhaustion stays stale.
export const liftStaleRow = (row, { flowArmed, receipts, records, base, fingerprint, flowConfig }) => {
  if (!flowArmed || row.state !== 'stale') return row;
  const selected = selectReliedOnReceipt({
    receipts, backend: row.backend, tree: { base, fingerprint },
    records,
    declaredPaths: [flowConfig?.debtQueue, flowConfig?.convergenceSummary].filter((p) => typeof p === 'string'),
    refreshCap: flowConfig?.councilRounds,
  });
  if (selected.receipt == null || selected.lifted === 0) return row;
  return {
    ...row, state: 'current', verdict: selected.receipt.verdict ?? 'unknown',
    shipClass: isShipVerdict(selected.receipt.verdict), grounded: true,
    timestamp: selected.receipt.timestamp ?? null, deltaLift: selected.lifted,
  };
};

// #56/#38: a standing CURRENT-tree veto consults its override instance; a delta-lifted veto has
// no override lane here (the bound set pins the veto receipt's own tree).
export const consumeVetoOverride = (row, { flowArmed, receipts, records, base, fingerprint }) => {
  if (!flowArmed || !(row.state === 'current' && !row.shipClass) || row.deltaLift != null) return row;
  const own = receipts.filter((r) => r.backend === row.backend);
  const summary = summarizeReviewReceiptsForTree(own, fingerprint);
  if (summary.state !== 'current') return row;
  const lift = evaluateVetoOverride({ records, vetoReceipt: summary.receipt, tree: { base, fingerprint } });
  return lift.lifted ? { ...row, overrideLabel: lift.label } : row;
};
