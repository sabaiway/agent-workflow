// flow-check.mjs — the checker refusal core (flow-orchestration, Phase 3): pure refusal predicates
// over the FULL read-results of BOTH stores (flow + core evidence) and the tree context, plus a
// standalone --check CLI. A malformed or unreadable store is itself a fail-closed refusal, never a
// silent empty; every refusal names its recovery as a VERBATIM pasteable flow-writer command
// (Decision 3/8 — the writer CLI ships beside this checker, so a refusal is never a dead end).
//
// COMPOSED (Plan 3 Phase 2): review-state's decideCheck consumes the decision cores as gated
// arms, commit-guard consults computeFlowDecision as its flow arm, and gates-init offers this
// CLI as a declarable gate whenever the orchestration config carries a flow block.
//
// LAYOUT (baseline-practices tranche 1): this module is the CLI entry, the store-reading
// composition computeFlowDecision, the report render and the public surface every consumer
// imports. The pure halves live one module down — flow-check-cores.mjs (the decision cores +
// decideFlowCheck), flow-check-rungs.mjs (the evidence rungs + the shared refusal vocabulary) and
// flow-check-git-lane.mjs (the all-path git lane). Imports run ONE way, facade → cores → rungs.
//
// Consumer env discipline: the checker resolves FIXED git-derived store paths; AW_FLOW_STORE /
// AW_CORE_EVIDENCE stay PRODUCER test seams this consumer ignores (the commit-guard sanitization
// discipline) — a poisoned override can neither redirect nor mask the real stores.

import { lstatSync } from 'node:fs';
import {
  CHAIN_KIND, canonicalFlowDigest, ownerScopedFlowProjection, flowProjectionHash,
} from './flow-record.mjs';
import { isDirectRun } from './direct-run.mjs';
import { resolveFlowStorePath, readFlowStore, deriveFlowOwner } from './flow-store.mjs';
import {
  resolveEvidencePath, readEvidence, resolveBase, authoritativeOfKind,
  resolveReceiptsPath, readReceipts, computeTreeFingerprint,
} from './core-evidence.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { requiredBackendsForConfiguredRecipe, DISPLAY_ALIASES, composeReadiness } from './recipes.mjs';
import { decideFlowCheck } from './flow-check-cores.mjs';
import { short } from './flow-check-rungs.mjs';
import {
  resolveGitToplevel, computeAllPathBaseDelta, computeAllPathWorktreeSurface,
} from './flow-check-git-lane.mjs';

export { deltaCustodyIssue, classifyBaseMotion, decideFlowCheck } from './flow-check-cores.mjs';
export {
  classifyDeltaChain, evaluateVetoOverride, collectUnansweredRedRefusals,
  collectDegradeCoverageRefusals, evaluateInternalAttestationLenses, selectReliedOnReceipt,
  collectReceiptCoverageRefusals,
} from './flow-check-rungs.mjs';
export { computeAllPathBaseDelta, computeAllPathWorktreeSurface } from './flow-check-git-lane.mjs';

const usageFail = (message) => Object.assign(new Error(message), { exitCode: 2 });

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
export const computeFlowDecision = ({ cwd = process.cwd(), consumer = 'gate', probes = {}, treeCarriesBytes = true } = {}) => {
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
      readiness = composeReadiness(top, { ...probes, onDetectError: () => { detectionFailed = true; } });
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
  // …and NOT when the CALLER states the tree carries no bytes: the receipt it would bind was then
  // found at the one fingerprint every clean moment of every repository shares, so it was minted by
  // some other moment and its projection hash describes that moment's store, not this one.
  // Correlating it would make the outcome depend on which stray clean moment the store recorded
  // last — the same fact the #65 rung and commit-guard's own content-free lanes apply.
  // The probe stays INSIDE this lane: an armed decision already paid for the tree (evidence.tree),
  // and every other lane — the gate consumer, a broken store, an unarmed flow — must stay inert.
  // A hoisted probe would make those lanes read the whole tree and let an unreadable untracked
  // file throw where the answer is otherwise a quiet, healthy no-op.
  const bindingRefusals = [];
  const completedFinals = consumer === 'commit-guard' && !healthBroken && treeCarriesBytes
    ? authoritativeOfKind(coreRead.records, 'final')
    : [];
  // …and only when a final record EXISTS to bind: with none in the store there is no binding to
  // verify, so reading the tree would answer a question nobody asked.
  if (completedFinals.length > 0) {
    const currentFingerprint = evidence?.tree.fingerprint ?? fingerprintProbe(cwd);
    if (currentFingerprint == null) {
      bindingRefusals.push('the current tree fingerprint is unresolvable — the D10 flow binding cannot be verified (fail closed); re-run run-gates.mjs --final on a healthy tree');
    }
    const currentFinal = currentFingerprint == null
      ? undefined
      : completedFinals.find((r) => r.fingerprintBefore === currentFingerprint);
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
  const { refusals, advisories } = decideFlowCheck({ flowRead, coreRead, owner, flowPath, corePath, motion, evidence, consumer, treeCarriesBytes });
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

if (isDirectRun(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
