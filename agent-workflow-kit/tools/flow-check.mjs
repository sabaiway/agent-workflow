// flow-check.mjs — the checker refusal core (flow-orchestration, Phase 3): pure refusal predicates
// over the FULL read-results of BOTH stores (flow + core evidence) and the tree context, plus a
// standalone --check CLI. A malformed or unreadable store is itself a fail-closed refusal, never a
// silent empty; every refusal names its recovery — park/resume/complete print the Plan-2 INTERIM
// structured form (the named action + the record it requires), because their writer CLI is a
// Plan-3 surface; the verbatim pasteable command replaces that form in the same commit that ships
// the writer.
//
// DELIBERATELY UNDECLARED in gates.json and the catalogs: composition into review-state /
// commit-guard / the gate matrix is Plan 3 — until then this is a standalone read-only probe.
//
// Consumer env discipline: the checker resolves FIXED git-derived store paths; AW_FLOW_STORE /
// AW_CORE_EVIDENCE stay PRODUCER test seams this consumer ignores (the commit-guard sanitization
// discipline) — a poisoned override can neither redirect nor mask the real stores.

import { pathToFileURL } from 'node:url';
import { CHAIN_KIND, validateChainSequence, validateSupersessions, canonicalFlowDigest } from './flow-record.mjs';
import {
  resolveFlowStorePath, readFlowStore, deriveFlowOwner,
  walkChainState, validateOpenerReference, resolveRecordReference, isAuthoritativeReferenceTarget,
} from './flow-store.mjs';
import { resolveEvidencePath, readEvidence } from './core-evidence.mjs';

const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

const short = (digest) => `${digest.slice(0, 12)}…`;

// The Plan-2 INTERIM structured recovery (#59): the checker only refuses — park/resume/complete
// are explicit writer actions, and their CLI ships with Plan 3.
const parkRecovery = (planId, state) => {
  const requires = { kind: 'chain', purpose: 'park', planId, cycle: state.cycle, round: state.round, stepId: null, fingerprint: '<the parked tree fingerprint>' };
  return `recovery (structured, Plan-2 interim): ${JSON.stringify({ action: 'park', requires })} — the pasteable park command ships with the Plan-3 writer and replaces this structured form in the same commit`;
};

// One plan's chain, arms in dependency order — adoption, sequence legality, reference resolution,
// then worktree scoping; the first failing arm reports and the downstream arms stay silent (an
// integrity refusal already invalidates what scoping would judge).
const planRefusals = (records, chain, planId, owner, advisories) => {
  if (chain[0].purpose !== 'adoption') {
    return [`plan "${planId}": the chain has no content-digest-bound adoption record — a chain starts at adoption binding the plan content digest (#58); the store is append-only, so inspect how this chain was written`];
  }
  const seq = validateChainSequence(chain);
  if (!seq.ok) return [`plan "${planId}": illegal transition — ${seq.reason}`];
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
  if (referenceIssues.length > 0) return referenceIssues;
  const open = !state.completed && !state.parked && state.mode === 'in-step';
  if (!open) return [];
  if (chain[0].owner !== owner) {
    advisories.push(`plan "${planId}": an OPEN chain owned by "${chain[0].owner}" (a foreign worktree) — advisory visibility only, never this tree's refusal (#57)`);
    return [];
  }
  return [`plan "${planId}" has an OPEN chain owned by this worktree ("${owner}"): step "${state.stepId}" is not converged — a commit closes only at a terminal. ${parkRecovery(planId, state)}`];
};

// The custody arm verifies the PERSISTED proof against a bare declaration (#60): the masked
// recompute must equal fingerprintBefore, and every delta must be re-attested by a SUBSEQUENT
// chain refresh binding {refreshedRecord, fingerprintBefore = the delta's fingerprintAfter} (#45)
// — an earlier or fingerprint-mismatched record never satisfies (raw order decides). Satisfaction
// is STORE-GLOBAL: the locked delta shape carries no chain field, so WHICH chain's refresh cap
// the re-attestation consumes is the Plan-3 decideCheck arm (#61), not a Plan-2 refusal.
const deltaRefusals = (records) => {
  const refusals = [];
  records.forEach((r, i) => {
    if (r.kind !== 'bookkeeping-delta') return;
    if (r.custodyProof.maskedFingerprint !== r.fingerprintBefore) {
      refusals.push(`bookkeeping-delta at ${r.path}: the persisted custody proof does not prove confinement (maskedFingerprint ${short(r.custodyProof.maskedFingerprint)} ≠ fingerprintBefore ${short(r.fingerprintBefore)}) — a bare or tampered declaration never passes; re-mint through mintBookkeepingDelta`);
      return;
    }
    // The MINT-only invariants the record-level shape validation cannot see — an unmintable proof
    // (hand-built around the shape rules) never passes the checker.
    const proof = r.custodyProof;
    const mintInvariant = !proof.tracked ? null
      : proof.preClass !== 'present' ? 'a tracked path with an absent pre-state never mints'
      : proof.indexDigest === null ? 'a staged deletion (a HEAD entry without an index entry) never mints'
      : proof.worktreeDigest !== proof.indexDigest ? 'the clean-at-path rule (pre-change worktree bytes = the index entry) never minted this'
      : null;
    if (mintInvariant !== null) {
      refusals.push(`bookkeeping-delta at ${r.path}: the persisted custody proof violates a mint invariant — ${mintInvariant}; an unmintable proof never passes (fail closed)`);
      return;
    }
    const digest = canonicalFlowDigest(r);
    const satisfied = records.some((s, j) => j > i && s.kind === CHAIN_KIND && s.purpose === 'refresh'
      && s.refreshedRecord === digest && s.fingerprintBefore === r.fingerprintAfter);
    if (!satisfied) {
      refusals.push(`bookkeeping-delta at ${r.path}: no satisfying re-attestation — a SUBSEQUENT chain refresh must bind {refreshedRecord: ${short(digest)}, fingerprintBefore: ${short(r.fingerprintAfter)}}; an earlier or fingerprint-mismatched record never satisfies. recovery (structured, Plan-2 interim): mint that refresh record — the pasteable command ships with the Plan-3 writer`);
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

// decideFlowCheck({ flowRead, coreRead, owner }) → { refusals, advisories }. Pure — consumes the
// FULL read-results of both stores; store health fails closed BEFORE any content judgment.
export const decideFlowCheck = ({ flowRead, coreRead, owner, flowPath = 'the flow store', corePath = 'the core evidence store' }) => {
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
    refusals.push(...planRefusals(records, chain, planId, owner, advisories));
  }
  refusals.push(...deltaRefusals(records));
  refusals.push(...degradeOrderingRefusals(coreRead.records));
  return { refusals, advisories };
};

// runFlowCheck({ cwd }) → { code, lines }. Resolution runs on an EMPTY env by construction — see
// the consumer env discipline in the header.
export const runFlowCheck = ({ cwd = process.cwd() } = {}) => {
  const owner = deriveFlowOwner(cwd);
  if (owner == null) return { code: 1, lines: ['flow-check: not a git work tree — there is no flow store to check'] };
  const flowPath = resolveFlowStorePath(cwd, {});
  const corePath = resolveEvidencePath(cwd, {});
  const flowRead = readFlowStore(flowPath);
  const coreRead = readEvidence(corePath);
  const { refusals, advisories } = decideFlowCheck({ flowRead, coreRead, owner, flowPath, corePath });
  const lines = [
    ...advisories.map((a) => `flow-check: advisory — ${a}`),
    ...refusals.map((r) => `flow-check: REFUSED — ${r}`),
  ];
  if (refusals.length === 0) lines.push(`flow-check: PASS — no flow refusal for this tree (owner ${owner})`);
  return { code: refusals.length === 0 ? 0 : 1, lines };
};

const HELP = `flow-check — the standalone flow-store checker (flow-orchestration, Plan 2).

Usage:
  node flow-check.mjs --check

Pure refusal predicates over the FULL read-results of BOTH stores (flow + core evidence) and the
tree context: store health (malformed/unreadable = fail-closed refusal), chain adoption and
transition legality, prior-terminal references, worktree scoping (an own OPEN chain refuses; a
foreign one is advisory only), bookkeeping-delta custody + re-attestation, and the
degrade-before-final ordering (raw order, grouped by fingerprint). Reads FIXED git-derived store
paths — the AW_* overrides stay producer test seams this consumer ignores.

DELIBERATELY UNDECLARED in gates.json and the catalogs: composition into review-state /
commit-guard / the gate matrix is Plan 3 — until then this CLI is a standalone read-only probe.

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
