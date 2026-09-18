// review-state-build.mjs — read-only git plumbing and buildState.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectBackends } from './detect-backends.mjs';
import { resolveActivityRecipe, DISPLAY_ALIASES, requiredBackendsForConfiguredRecipe, composeReadiness } from './recipes.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { plansInFlight } from './plan-files.mjs';
import { GIT_MAX_BUFFER, resolveGitLocation, stripGitLocationEnv, withGitPath } from './git-env.mjs';
import {
  computeTreeFingerprint,
  isTreeClean,
  isNeverCommittableStat,
  resolveReceiptsPath,
  readReceipts,
  resolveBase,
} from './core-evidence.mjs';
import {
  ACTIVITY, SLOT, backendReceiptStatus, buildHeldSessionState, degradeRecordSet, selectHeldSessionDegrades,
} from './review-state-judge.mjs';
import {
  attestedPlanIdsFor, computePlanAdoptionCoverage, consumeVetoOverride, liftStaleRow, readFlowArming,
} from './review-state-flow.mjs';

// ── git plumbing (read-only queries; injectable for tests) ─────────────────────────

const gitRaw = (args, cwd, env) =>
  spawnSync('git', args, { cwd, env: withGitPath(env ?? process.env), maxBuffer: GIT_MAX_BUFFER, windowsHide: true });

// stdout Buffer of a git query, or null when git fails (not a repo / git absent).
const gitBuf = (args, cwd, env) => {
  const r = gitRaw(args, cwd, env);
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};

const gitLine = (args, cwd, env) => {
  const buf = gitBuf(args, cwd, env);
  return buf == null ? null : buf.toString('utf8').replace(/\r?\n$/, '');
};

// ── the sandbox-masks advisory (D lane, AD-044 Plan 4 Phase 1.5) ────────────────────

// Count the never-committable untracked paths the STANDARD walk still shows. The review domain
// ignores them by construction; this count only feeds ONE non-failing advisory line naming the
// cosmetic sandbox-masks apply — an applied managed block hides the paths from --exclude-standard,
// so the advisory disappears exactly when the status noise does (no standing detector).
export const countNeverCommittableUntracked = (cwd, { lstat = lstatSync, env } = {}) => {
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd, env);
  if (top == null) return 0;
  const untrackedZ = gitBuf(['ls-files', '--others', '--exclude-standard', '-z'], top, env);
  if (untrackedZ == null) return 0;
  return untrackedZ
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => {
      try {
        return isNeverCommittableStat(lstat(join(top, rel)));
      } catch {
        return false;
      }
    }).length;
};

// buildState({ cwd, env, detect }) → everything both renders need. Pure I/O at the edges.
// EVERY project-relative read (orchestration config, docs/plans, receipts) anchors at the git
// work-tree ROOT when one exists — the fingerprint is root-anchored, so a subdirectory invocation
// must read the same config/plans or a dirty unreceipted tree could false-PASS as "no plan in
// flight". Outside a git tree the cwd is the only anchor (and --check exits 0).
export const buildState = ({ cwd, env = process.env, detect = detectBackends, surveyVehicle, lstat = lstatSync, readFile = readFileSync } = {}) => {
  // WHICH repository, first; the config/plan anchor is the stripped discovery's top (from a subdirectory the bare cwd would miss docs/plans — decideCheck refuses on an unanchored root).
  const location = resolveGitLocation(cwd, { env });
  const anchoredTop = location.top ?? gitLine(['rev-parse', '--show-toplevel'], cwd, stripGitLocationEnv(env));
  const root = anchoredTop ?? cwd;
  const { config, source: configSource } = loadConfig(root);
  // A bridge-detector throw reaches the hook, never a catch that would also lose the surveyed
  // executor vehicle: bridge readiness goes unknown (fail closed below), the carrier stays known.
  let detectionWarning = null;
  const onDetectError = (err) => {
    detectionWarning = `backend detection failed (${(err && err.message) || err}) — bridge readiness unknown.`;
  };
  const detection = composeReadiness(root, { detect, surveyVehicle, onDetectError });
  // The resolver stays for DISPLAY only; the OBLIGATIONS come from the configured recipe (never the readiness-degraded effective one — no silent solo).
  const resolved = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity: ACTIVITY, slot: SLOT });
  const obligations = requiredBackendsForConfiguredRecipe({ config: config ?? {}, readiness: detection, detectionFailed: detectionWarning != null });
  const requiredBackends = obligations.backends;
  const plans = plansInFlight(root);
  // The injected lstat threads through EVERY stat-dependent computation (fingerprint, clean, the
  // mask count) — a partial injection would let a test observe an inconsistent state.
  const fingerprint = location.state === 'work-tree' ? computeTreeFingerprint(cwd, { lstat, env }) : null;
  const clean = fingerprint == null ? null : isTreeClean(cwd, { lstat, env });
  const receiptsPath = resolveReceiptsPath(cwd, env);
  const receiptsRead = receiptsPath ? readReceipts(receiptsPath) : { receipts: [], malformed: 0 };
  const { receipts, malformed } = receiptsRead;
  const receiptsReadError = receiptsRead.readError ?? null;
  const backends = requiredBackends.map((b) => ({ backend: b, ...backendReceiptStatus(receipts, b, fingerprint) }));
  // The D3(b) degrade escape: read the core-evidence store ONLY here, ONLY for the exemption —
  // the gate never otherwise depends on it (an unavailable store denies the exemption CLOSED,
  // never fails a tree whose receipts independently satisfy the gate).
  const base = resolveBase(cwd);
  const degrade = degradeRecordSet({ cwd, env, fingerprint });
  const degradedExempt = requiredBackends.filter((b) => degrade.set.has(b));
  const heldSession = buildHeldSessionState({
    cwd,
    env,
    configuredExecute: [config?.[ACTIVITY]?.execute, config?.task?.execute].find((recipe) => recipe === 'delegated'),
    plans,
    fingerprint,
    clean,
    degrades: selectHeldSessionDegrades(degrade.records),
  });
  // ── the Phase-2 flow arms' state (two-tier activation, P3) ──
  const flow = readFlowArming({ cwd, env, lstat });
  const planCoverage = flow.flowArmed
    ? computePlanAdoptionCoverage({ root, plans, records: flow.records, owner: flow.flowOwner, readFile })
    : [];
  const { attestedPlanIds, lensRefusedAttestations } = flow.flowArmed
    ? attestedPlanIdsFor({ records: flow.records, base, fingerprint })
    : { attestedPlanIds: [], lensRefusedAttestations: [] };
  const arms = { flowArmed: flow.flowArmed, receipts, records: flow.records, base, fingerprint, flowConfig: config?.flow ?? null };
  const armedBackends = backends.map((b) => consumeVetoOverride(liftStaleRow(b, arms), arms));
  // The solo-class veto probe (#48): under an armed solo recipe every review-capable backend's
  // CURRENT-tree receipt is still consulted, so a recipe flip to solo never buries a standing veto.
  const soloVetoRows = flow.flowArmed && obligations.recipe === 'solo'
    ? Object.values(DISPLAY_ALIASES).map((b) => consumeVetoOverride(liftStaleRow({ backend: b, ...backendReceiptStatus(receipts, b, fingerprint) }, arms), arms))
    : [];
  return {
    resolved,
    configSource,
    obligations,
    requiredBackends,
    backends: armedBackends,
    plans,
    root,
    rootAnchored: anchoredTop !== null,
    location,
    fingerprint,
    clean,
    receiptsPath,
    receiptCount: receipts.length,
    malformed,
    receiptsReadError,
    base,
    evidenceStorePath: degrade.storePath,
    evidenceMalformed: degrade.malformed,
    evidenceReadError: degrade.readError,
    evidenceUnavailable: degrade.unavailable,
    degradedExempt,
    heldSession,
    maskedUntracked: countNeverCommittableUntracked(cwd, { lstat, env }),
    detectionWarning,
    flowPresent: flow.flowPresent,
    flowArmed: flow.flowArmed,
    flowBrokenReason: flow.flowBrokenReason,
    flowOwner: flow.flowOwner,
    planCoverage,
    attestedPlanIds,
    lensRefusedAttestations,
    soloVetoRows,
  };
};
