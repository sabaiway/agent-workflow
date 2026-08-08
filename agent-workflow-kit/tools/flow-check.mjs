// flow-check.mjs — the checker refusal core (flow-orchestration, Phase 3): pure refusal predicates
// over the FULL read-results of BOTH stores (flow + core evidence) and the tree context, plus a
// standalone --check CLI. A malformed or unreadable store is itself a fail-closed refusal, never a
// silent empty; every refusal names its recovery as a VERBATIM pasteable flow-writer command
// (Decision 3/8 — the writer CLI ships beside this checker, so a refusal is never a dead end).
//
// Phase 1 adds the pure decision cores (#61/#56/#65/#62/#42/#25); each keys on an ARMED flow, so
// an unarmed tree sees byte-identical behavior.
//
// COMPOSED (Plan 3 Phase 2): review-state's decideCheck consumes the decision cores as gated
// arms, commit-guard consults computeFlowDecision as its flow arm, and gates-init offers this
// CLI as a declarable gate whenever the orchestration config carries a flow block.
//
// Consumer env discipline: the checker resolves FIXED git-derived store paths; AW_FLOW_STORE /
// AW_CORE_EVIDENCE stay PRODUCER test seams this consumer ignores (the commit-guard sanitization
// discipline) — a poisoned override can neither redirect nor mask the real stores.

import { lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CHAIN_KIND, validateChainSequence, validateSupersessions, canonicalFlowDigest,
  authoritativeFlowRecords, flowTreeIdentity, ownerScopedFlowProjection, flowProjectionHash,
} from './flow-record.mjs';
import {
  resolveFlowStorePath, readFlowStore, deriveFlowOwner,
  walkChainState, validateOpenerReference, resolveRecordReference, isAuthoritativeReferenceTarget,
} from './flow-store.mjs';
import {
  resolveEvidencePath, readEvidence, resolveBase, authoritativeOfKind, summarizeReviewReceiptsForTree,
  resolveReceiptsPath, readReceipts, computeTreeFingerprint,
} from './core-evidence.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { requiredBackendsForConfiguredRecipe, DISPLAY_ALIASES } from './recipes.mjs';
import { detectBackends } from './detect-backends.mjs';
import { FALLBACK_LENS_ADDITIONAL_ONLY } from './cheap-agents.mjs';

const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

const short = (digest) => `${digest.slice(0, 12)}…`;

// The verbatim pasteable recovery lane (Decision 3/8): every refusal that names a mintable record
// class prints the exact flow-writer command that mints it. The tool path is absolute (pasteable
// from any cwd) and POSIX single-quoted — raw path/id bytes must never execute on paste.
const FLOW_WRITER_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'flow-writer.mjs');
const shellQuote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const writerCommand = (args) => `node ${shellQuote(FLOW_WRITER_TOOL)} ${args}`;

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

// ── Plan-3 Phase-1 decision cores — pure over read-results + explicit inputs ─────────────────────

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

// ── the all-path git lane for base-motion inputs (#62) ───────────────────────────────────────────

// computeChangedSurface exists for COVERAGE and excludes test files by design — the base-
// intersection inputs come from these helpers instead: every changed path counts, tests included.
const gitPathList = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
};

// All-path git lane (#62/P22): toplevel-rooted, submodules never ignored, test files included.
const resolveGitToplevel = (cwd) => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const top = r.stdout.toString('utf8').replace(/\r?\n$/, '');
  return top === '' ? null : top;
};

export const computeAllPathBaseDelta = (cwd, fromBase, toBase) => {
  const isSha = (v) => typeof v === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
  if (!isSha(fromBase) || !isSha(toBase)) {
    return { ok: false, reason: `a base delta needs two shas (got ${JSON.stringify(fromBase)} → ${JSON.stringify(toBase)})` };
  }
  const root = resolveGitToplevel(cwd);
  if (root == null) return { ok: false, reason: 'not inside a git work tree — the base delta is unresolvable (fail closed)' };
  const paths = gitPathList(['diff', '--name-only', '--no-renames', '--ignore-submodules=none', '-z', fromBase, toBase], root);
  if (paths == null) return { ok: false, reason: `git diff ${short(fromBase)} ${short(toBase)} failed — an unresolvable base delta fails closed` };
  return { ok: true, paths };
};

export const computeAllPathWorktreeSurface = (cwd) => {
  const root = resolveGitToplevel(cwd);
  if (root == null) return { ok: false, reason: 'not inside a git work tree — the worktree surface is unresolvable (fail closed)' };
  // assume-unchanged/skip-worktree lie to git diff — any flagged entry fails the surface closed.
  const flagged = gitPathList(['ls-files', '-v', '-z'], root);
  if (flagged == null) return { ok: false, reason: 'the worktree surface is unresolvable (git ls-files -v failed) — fail closed' };
  for (const entry of flagged) {
    if (entry.length < 3 || entry[1] !== ' ') return { ok: false, reason: `the worktree surface is unresolvable (unparseable ls-files -v entry ${JSON.stringify(entry)}) — fail closed` };
    const assumeUnchanged = /[a-z]/.test(entry[0]);
    const skipWorktree = entry[0].toUpperCase() === 'S';
    if (assumeUnchanged || skipWorktree) {
      const flags = [assumeUnchanged ? 'assume-unchanged' : null, skipWorktree ? 'skip-worktree' : null].filter(Boolean).join(' + ');
      return { ok: false, reason: `index-flagged entry ${entry.slice(2)} (${flags}) hides changes from git diff — the worktree surface is undecidable (fail closed)` };
    }
  }
  const tracked = gitPathList(['diff', 'HEAD', '--name-only', '--no-renames', '--ignore-submodules=none', '-z'], root);
  const untracked = gitPathList(['ls-files', '--others', '--exclude-standard', '-z'], root);
  if (tracked == null || untracked == null) return { ok: false, reason: 'the worktree surface is unresolvable (git diff/ls-files failed) — fail closed' };
  return { ok: true, paths: [...new Set([...tracked, ...untracked])] };
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

// computeFlowDecision({ cwd, consumer }) → { present, owner, armed, broken, refusals, advisories }
// — the two-tier answer EVERY composed consumer reads (P3): `present` is tier 1 (store-file
// existence; an unstatable leaf reads as a fail-closed health failure), `armed` is tier 2 (>=1
// adoption on a clean read). Store HEALTH (flow or core) always refuses; SEMANTIC refusals bind
// only an ARMED store — a valid store with no adoption changes nothing. Under an armed store the
// decision also carries the three evidence rungs, with `backends` = the SAME consumed set
// review-state derives (the configured recipe; the computed default consults offline readiness —
// #42 never falls open). `consumer` (Plan 4 Decision 2): the D10 flow→final comparison runs ONLY
// on the 'commit-guard' lane — the default 'gate' lane (the in-matrix flow-check --check gate)
// stays inert on it, because during a final run the "latest final" is by construction the
// PREVIOUS one and an in-matrix comparison would make a new green final unreachable. The SAME
// distinction reaches the #65 unanswered-red rung (its own header states the split): the 'gate'
// lane also answers a red under a provable in-progress retry, for the same reason.
export const computeFlowDecision = ({ cwd = process.cwd(), consumer = 'gate', probes = {} } = {}) => {
  const fingerprintProbe = probes.fingerprint ?? computeTreeFingerprint;
  const owner = deriveFlowOwner(cwd);
  if (owner == null) {
    // The guard reaches this arm only INSIDE a work tree, so a dead owner probe there must
    // refuse — a silent empty answer would skip the D10 comparison (round-3 disposition). The
    // default 'gate' consumer keeps the empty shape (the CLI owns the not-a-work-tree message).
    return {
      present: false, owner: null, armed: false, broken: null,
      refusals: consumer === 'commit-guard'
        ? ['the owning worktree identity is unresolvable — the D10 flow binding cannot be verified (fail closed); re-run inside the git work tree']
        : [],
      advisories: [],
    };
  }
  const flowPath = resolveFlowStorePath(cwd, {});
  const corePath = resolveEvidencePath(cwd, {});
  const flowStat = (() => {
    if (flowPath == null) return null;
    try {
      return lstatSync(flowPath);
    } catch (err) {
      return err && err.code === 'ENOENT' ? null : 'unstatable';
    }
  })();
  const present = flowStat !== null;
  const flowRead = !present ? { records: [], authoritative: [], malformed: 0, malformedReasons: [] }
    : flowStat === 'unstatable' ? { records: [], authoritative: [], malformed: 0, malformedReasons: [], readError: 'the store leaf cannot be stat-ed (fail closed)' }
    : readFlowStore(flowPath);
  const coreRead = readEvidence(corePath);
  const healthBroken = flowRead.readError != null || flowRead.malformed > 0
    || coreRead.readError != null || (coreRead.malformed ?? 0) > 0;
  const armed = !healthBroken && flowRead.records.some((r) => r.kind === CHAIN_KIND && r.purpose === 'adoption');
  const motion = {
    currentBase: resolveBase(cwd),
    resolveBaseDelta: (from, to) => computeAllPathBaseDelta(cwd, from, to),
    resolveChangedSurface: () => computeAllPathWorktreeSurface(cwd),
  };
  const evidenceRefusals = [];
  let evidence = null;
  if (armed) {
    // The config anchors at the git TOPLEVEL — the same anchor review-state's buildState uses —
    // so a subdirectory invocation can never derive a different recipe.
    const top = resolveGitToplevel(cwd);
    let config = null;
    let configFailure = top == null ? 'the git toplevel is unresolvable' : null;
    if (configFailure == null) {
      try {
        config = loadConfig(top).config;
      } catch (err) {
        configFailure = (err && err.message) || String(err);
      }
    }
    let readiness = [];
    let detectionFailed = false;
    if (configFailure == null && config?.['plan-execution']?.review == null) {
      try {
        readiness = detectBackends();
      } catch {
        detectionFailed = true;
      }
    }
    const obligations = configFailure == null
      ? requiredBackendsForConfiguredRecipe({ config, readiness, detectionFailed })
      : null;
    if (configFailure != null) {
      evidenceRefusals.push(`the relied-on backend set cannot be derived (${configFailure}) — exact coverage is undecidable on an armed flow (fail closed)`);
    } else if (obligations.unknowable) {
      evidenceRefusals.push('the relied-on backend set cannot be derived (no configured recipe and the backend detector is down) — exact coverage is undecidable on an armed flow (fail closed)');
    } else {
      // Split sets (P2 council ruling): the solo floor consults EVERY provider's latest receipt,
      // so receipt coverage binds all providers under solo; the degrade escape is never consulted
      // under solo, so a stray degrade must not demand coverage there.
      const receiptsPath = resolveReceiptsPath(cwd, {});
      const receiptsRead = receiptsPath ? readReceipts(receiptsPath) : { receipts: [], malformed: 0 };
      if (receiptsRead.readError != null || receiptsRead.malformed > 0) {
        // RECEIPTS-READER-NOFOLLOW: the decision consults receipts, so a store that cannot be
        // read clean (symlinked/foreign leaf, I/O failure, malformed lines) refuses — an empty
        // success here would wave every receipt-consuming arm through.
        evidenceRefusals.push(`the review-receipts store is unreadable or malformed (${receiptsRead.readError ?? `${receiptsRead.malformed} malformed line(s)`}) — the flow decision consults receipts, so it fails closed; inspect ${receiptsPath}`);
      } else {
        evidence = {
          receipts: receiptsRead.receipts,
          tree: { base: motion.currentBase, fingerprint: fingerprintProbe(cwd) },
          receiptBackends: obligations.recipe === 'solo' ? Object.values(DISPLAY_ALIASES) : obligations.backends,
          degradeBackends: obligations.backends,
          declaredPaths: [config?.flow?.debtQueue, config?.flow?.convergenceSummary].filter((p) => typeof p === 'string'),
          refreshCap: config?.flow?.councilRounds ?? null,
        };
      }
    }
  }
  // The D10 arm (Plan 4 Decision 2 + the round-2 sharpening) — commit-guard lane ONLY, and NOT
  // gated on `armed`: evidenceHashes.flow attests "a flow store EXISTED at final time" (a
  // valid-unadopted store also mints it), so a receipt carrying the field demands a LIVE store
  // and a matching projection whatever the current armed state — deletion or truncation after
  // the final is movement. The MISSING-field refusal stays armed-gated (a pre-upgrade final
  // under an unarmed flow passes unchanged). Ordering respects the dead-green contract: the
  // authoritative completed final at the CURRENT fingerprint, status green FIRST (a newer red
  // is never bypassed by an older green's matching hash — the guard's own red arm refuses it),
  // then the hash comparison.
  const bindingRefusals = [];
  if (consumer === 'commit-guard' && !healthBroken) {
    const currentFingerprint = evidence?.tree.fingerprint ?? fingerprintProbe(cwd);
    if (currentFingerprint == null) {
      bindingRefusals.push('the current tree fingerprint is unresolvable — the D10 flow binding cannot be verified (fail closed); re-run run-gates.mjs --final on a healthy tree');
    }
    const currentFinal = currentFingerprint == null ? undefined : authoritativeOfKind(coreRead.records, 'final')
      .find((r) => r.fingerprintBefore === currentFingerprint);
    if (currentFinal !== undefined && currentFinal.status === 'green') {
      const bound = currentFinal.evidenceHashes?.flow;
      if (typeof bound === 'string') {
        if (!present) {
          bindingRefusals.push('the green final receipt carries evidenceHashes.flow but the flow store is ABSENT — the store the receipt attested vanished after the final run (disappearance is movement; fail closed); restore the flow store or re-run run-gates.mjs --final');
        } else {
          const projectionCtx = { owner, currentFingerprint };
          const live = flowProjectionHash(flowRead.records, projectionCtx);
          if (live !== bound) {
            const projection = ownerScopedFlowProjection(flowRead.records, projectionCtx);
            const tail = projection[projection.length - 1];
            const tailShown = tail === undefined
              ? 'the live projection is EMPTY'
              : `the live projection tail is a ${tail.kind === CHAIN_KIND ? `chain/${tail.purpose}` : tail.kind} record (${short(canonicalFlowDigest(tail))})`;
            bindingRefusals.push(`the flow store moved after the final run — the live owner-scoped projection (${short(live)}) no longer matches the receipt's evidenceHashes.flow (${short(bound)}). DIAGNOSTIC hypothesis only (an aggregate hash cannot prove WHICH record appended): ${tailShown}; re-run run-gates.mjs --final`);
          }
        }
      } else if (armed && ownerScopedFlowProjection(flowRead.records, { owner, currentFingerprint }).length > 0) {
        // Owner-scoped relevance (round-8 fold): an EMPTY projection has nothing the receipt
        // failed to bind — a foreign-only store stays advisory and never stales the guard.
        bindingRefusals.push('the green final receipt at this tree carries NO evidenceHashes.flow (a pre-upgrade final) — the flow→final binding cannot be verified on an armed flow (fail closed); re-run run-gates.mjs --final');
      }
    }
  }
  const { refusals, advisories } = decideFlowCheck({ flowRead, coreRead, owner, flowPath, corePath, motion, evidence, consumer });
  // Semantic refusals bind only an ARMED store; the D10 binding refusals ride the commit-guard
  // lane UNCONDITIONALLY — a deleted or truncated store must never un-arm the binding.
  const effectiveRefusals = healthBroken ? refusals : [...(armed ? [...refusals, ...evidenceRefusals] : []), ...bindingRefusals];
  return { present, owner, armed, broken: healthBroken ? refusals[0] ?? 'store health failed closed' : null, refusals: effectiveRefusals, advisories: armed ? advisories : [] };
};

// runFlowCheck({ cwd }) → { code, lines }. Resolution runs on an EMPTY env by construction — see
// the consumer env discipline in the header.
export const runFlowCheck = ({ cwd = process.cwd() } = {}) => {
  const d = computeFlowDecision({ cwd });
  if (d.owner == null) return { code: 1, lines: ['flow-check: not a git work tree — there is no flow store to check'] };
  const lines = [
    ...d.advisories.map((a) => `flow-check: advisory — ${a}`),
    ...d.refusals.map((r) => `flow-check: REFUSED — ${r}`),
  ];
  if (d.refusals.length === 0) lines.push(`flow-check: PASS — no flow refusal for this tree (owner ${d.owner})`);
  return { code: d.refusals.length === 0 ? 0 : 1, lines };
};

const HELP = `flow-check — the standalone flow-store checker (flow-orchestration).

Usage:
  node flow-check.mjs --check

Pure refusal predicates over the FULL read-results of BOTH stores (flow + core evidence) and the
tree context: store health (malformed/unreadable = fail-closed refusal), chain adoption and
transition legality, prior-terminal references, worktree scoping (an own OPEN chain refuses; a
foreign one is advisory only), bookkeeping-delta custody + re-attestation, the
degrade-before-final ordering (raw order, grouped by fingerprint), and armed base motion
(in-step transitions must land the class the delta requires: re-baseline or refresh). Reads FIXED
git-derived store paths — the AW_* overrides stay producer test seams this consumer ignores.

COMPOSED (Plan 3 Phase 2): the same decision feeds review-state's gated arms and the
commit-guard flow arm; declare this CLI as a gates.json gate (the gates-init candidate offers
it whenever the orchestration config carries a flow block).

Exit codes: 0 pass (advisories may print); 1 refused (reason + recovery named); 2 usage.`;

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const rest = argv.filter((a) => a !== '--check');
    if (rest.length > 0) throw usageFail(`unknown argument: ${rest[0]} (usage: node flow-check.mjs --check)`);
    if (!argv.includes('--check')) throw usageFail('nothing to do — pass --check (or --help)');
    const { code, lines } = runFlowCheck({ cwd: ctx.cwd ?? process.cwd() });
    return { code, stdout: lines.join('\n'), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `flow-check: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
