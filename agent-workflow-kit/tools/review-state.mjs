#!/usr/bin/env node
// review-state.mjs — the read-only review-receipt checker behind `/agent-workflow-kit review-state`
// (AD-038; HARDENED by the strip-the-kit core, D3(b)). It makes "reviewed ≠ shipped" mechanically
// detectable: the bridge review wrappers append one receipt line per successful review; this tool
// derives the review OBLIGATIONS from the CONFIGURED `plan-execution.review` recipe (the raw
// orchestration.json value — never the readiness-degraded effective recipe: a computed
// readiness-degrade NEVER silently becomes solo), recomputes the CURRENT canonical
// uncommitted-state fingerprint, and judges — per configured backend — the LATEST NORMAL receipt.
// `--check` turns the report into a gate exit code (declare it in docs/ai/gates.json).
//
// Normative `--check` exit contract (the single home of this list — SKILL.md points here):
// Before the review-recipe exits, a configured plan-execution.execute or task.execute of delegated
// (each read on its own) with a plan and a dirty, fingerprintable tree audits the delegation ledger.
// An absent ledger is inert; an unavailable ledger or a HEAD error refuses. A SUBSTITUTED held session
// refuses: for a head-base thread, a codex-exec degrade at the substituted return's tree, standing after
// every later fold, accepts it, or the fold of that thread's retry lifts it (codex never grants it); a
// checkpoint-based thread's substitution closes only by its own ledger degrade.
//   exit 0  when the CONFIGURED plan-execution.review recipe is solo (or the computed default is —
//           absent config with no reviewer backend ready); when no plan is in flight (docs/plans/
//           holds no top-level .md that is not queue.md and not scratch by the naming convention:
//           prefixes EXECUTE- / FEEDBACK- / TASK-, or a name containing PROMPT / prompt / handoff); when
//           the tree is clean (nothing to review — under a non-solo review obligation the PASS
//           still NAMES every plan in flight and states that the gate arms as soon as the tree
//           turns dirty, so a latent arm is discoverable before it blocks a pending commit); when
//           git ITSELF answers not-a-repository under both discoveries (the ONLY non-work-tree
//           location that passes; the five other states refuse by name); and when
//           the obligations are SATISFIED: under `reviewed`, >=1 backend's latest normal receipt
//           attests SHIP-CLASS (ship / ship with nits) for the current tree; under `council`,
//           EVERY review-capable backend attests ship-class OR carries an explicit current-tree
//           degrade record in the core-evidence store — and NEVER all backends (>=1 non-degraded
//           ship-class attestation is required whenever >=1 backend is configured).
//   exit 1  on an authoritative VETO (any configured backend's latest normal receipt carries a
//           recognized NEGATIVE verdict — revise / rethink / rework — for the current tree; a
//           degrade record never lifts a veto); on an UNRECOGNIZED verdict on the latest normal
//           receipt (an `unknown` verdict never attests — fail closed, so a later unknown never
//           lets an earlier SHIP survive); on a missing/stale/ungrounded/probe-only backend under
//           council without a current-tree degrade record; when every configured backend is
//           degrade-recorded (all-degraded refused); and, with NO configured recipe, when the
//           backend detector is down (the computed default is unknowable — fail closed). An
//           unreadable/malformed evidence store DENIES the degrade escape (fail-closed) but NEVER
//           fails a tree whose receipts independently satisfy the gate (surfaced either way).
// Selection is LATEST-NORMAL-FIRST: among current-fingerprint, marker-valid, probe-free receipts
// the LATEST is selected and THEN judged (the verdict-vocabulary arm first, then grounding — an
// unrecognized verdict is an unconditional refusal that grounding never reclassifies) — so a
// revise-class latest VETOES an earlier ship-class one, and a probe/forged-marker receipt written
// after a real review never becomes the authoritative verdict.
// Informational receipts NEVER satisfy (nor fail) the tree check: plan/diff-mode receipts
// (artifact ≠ "code") and continuations (fresh:false — agy --continue/--conversation cannot attest
// a folded tree; only a fresh grounded re-run mints a gate-satisfying receipt).
// PROBE receipts never satisfy either (BRIDGE-MODES-CATALOG, D3): a CODEX_PROBE=1 / AGY_PROBE=1
// review runs with the frontier-model/max-effort guard OFF, so the wrappers stamp `probe:true` and
// this checker drops those receipts — PER RECEIPT, so a normal receipt at the same fingerprint still
// satisfies, and a backend whose ONLY current receipts are probes fails with its own stated reason
// (never the stale one). Every receipt from a marker-aware wrapper SELF-DECLARES — `probe` is written
// on every successful review, true or false — so a NON-BOOLEAN or ABSENT marker is rejected
// fail-closed: silence is not a declaration, and the probe status of an unmarked receipt is
// untrustworthy whoever wrote it (the pre-D3 wrappers honoured the probe env vars while writing no
// marker; a hand-written line is no better evidence). Deliberately NOT keyed on wrapperVersion: the
// version bumps in a different release phase than the marker lands, so a version floor would reject
// the very receipts the current wrappers write. Accepted cost (maintainer, 2026-07-15): a pre-D3
// receipt stops satisfying — re-run the review with a marker-aware bridge.
//
// The fingerprint is the ONE canonical uncommitted-state identity — sha256 over: staged diff +
// unstaged diff + untracked-not-ignored file contents (binary untracked files, symlinks, and
// directories/gitlinks ride as name-only notes). NEVER-COMMITTABLE untracked stat classes —
// character/block devices, FIFOs, sockets — are EXCLUDED from the domain entirely (no note): a
// sandbox that injects device masks into the work tree can no longer move the fingerprint or dirty
// the clean check (AD-044 Plan 4; the class is lstat-keyed because a lying dirent is exactly how
// the masks surface). Untracked SYMLINKS and DIRECTORIES stay in the domain — both are committable
// (a directory listed by `git ls-files --others` as `dir/` is an embedded repo, i.e. a gitlink).
// Domain == the review-payload domain the wrappers assemble; the prose definition lives in each
// bridge's capability.json roles.review.contract.receipt, and the bash twin lives in both
// wrappers — cross-checked by test/review-fingerprint-parity.test.mjs.
//
// Phase-2 flow arms (flow-orchestration Plan 3, #43/#61/#68/#48 — two-tier activation, P3): with
// NO flow store file the decision is byte-identical to the pre-flow checker; a present-but-
// malformed store FAILS the dirty-tree check closed; a valid store with no adoption changes
// nothing. Under an ARMED store (an adoption record exists): (a) a STALE receipt lifts to CURRENT
// through an unbroken declared-path bookkeeping-delta chain (#61, labeled in the PASS reason);
// (b) a standing veto lifted by a valid maintainer-override PASSES with the durable label in the
// check reason and the human report (#38/#56); (c) the SOLO obligations class (no reviewers
// configured — configured solo or the computed solo default) gains the reduced internal-only
// floor as an OBLIGATION (#34/#43): every in-flight plan must be covered by an adopted chain
// (planId + content digest + owner, P13/P19) AND carry an internal-attestation at the current
// tree; an uncovered plan REFUSES, never relaxes (#68), and a standing current-tree veto still
// blocks the floor (#48). A configured reviewed/council NEVER takes the reduced floor — its
// missing backends keep the degrade-record bar (the full degraded-council set arms in Phase 4).
//
// HUMAN residual (accepted, documented): `git commit --no-verify` skips any pre-commit gate, and
// deleting/editing the receipt file forges state — receipts live in the git dir (never committable)
// as an honest self-discipline mechanism, not a security boundary.
//
// Read-only: never writes, never commits, never runs a subscription CLI. It DOES spawn `git`
// (read-only queries) to compute the fingerprint — stated honestly in the catalog. Dependency-free,
// Node >= 22. No side effects on import (the isDirectRun idiom).

import { detectBackends } from './detect-backends.mjs';
import { isDirectRun } from './direct-run.mjs';
import { CONFIG_REL, fail } from './orchestration-config.mjs';
import { RECEIPTS_BASENAME } from './core-evidence.mjs';
import { ACTIVITY, SLOT, decideCheck } from './review-state-judge.mjs';
import { buildState } from './review-state-build.mjs';
import { formatHuman, maskAdvisoryLine } from './review-state-render.mjs';
import { mainAwait } from './review-state-await.mjs';

// Pure leaves (FLOW-READ-GRAPH-PURITY): the plan-file convention and the lexical shell quote live
// in leaf modules so the procedures read surface reaches them without this module's write-API
// graph; re-exported here so every historical consumer keeps its import site.
export { PLANS_REL, isScratchPlanName, plansInFlight } from './plan-files.mjs';
export { shellQuoteArg } from './repo-lex.mjs';
export { requiredBackendsForConfiguredRecipe } from './recipes.mjs';
export {
  RECEIPTS_BASENAME,
  computeFingerprintPayload,
  computeTreeFingerprint,
  isTreeClean,
  isNeverCommittableStat,
  resolveReceiptsPath,
  readReceipts,
} from './core-evidence.mjs';
export {
  CLEAN_TREE_PASS,
  LATENT_ARM_NOTICE,
  quoteReportName,
  backendReceiptStatus,
  degradeRecordSet,
  selectHeldSessionDegrades,
  shouldReadHeldSession,
  buildHeldSessionState,
  decideCheck,
} from './review-state-judge.mjs';
export { countNeverCommittableUntracked, buildState } from './review-state-build.mjs';
export { computePlanAdoptionCoverage } from './review-state-flow.mjs';
export { DEFAULT_AWAIT_TIMEOUT_S, AWAIT_POLL_MS, mainAwait } from './review-state-await.mjs';

const HELP = `review-state — read-only review-receipt checker (agent-workflow family, AD-038).

Usage:
  node review-state.mjs [--check] [--json]

Derives the review OBLIGATIONS from the CONFIGURED ${ACTIVITY}.${SLOT} recipe (${CONFIG_REL} raw
value — never the readiness-degraded effective recipe), recomputes the canonical uncommitted-state
fingerprint (staged + unstaged + untracked-not-ignored — the review-payload domain), reads the
receipt file the review wrappers append to (<git dir>/${RECEIPTS_BASENAME}; AW_REVIEW_RECEIPTS
overrides), and judges each configured backend's LATEST NORMAL receipt: only SHIP-CLASS verdicts
(ship / ship with nits) satisfy; a recognized negative (revise / rethink / rework) is an
authoritative VETO; an unrecognized verdict never attests (fail closed). Plan/diff-mode receipts
and continuations (fresh:false) are informational-only, and a PROBE receipt (probe:true) never
attests; a malformed OR absent probe marker is rejected fail-closed — silence is not a declaration.
The ONLY escape for an unavailable backend under council is an explicit current-tree degrade
record (node core-evidence.mjs degrade) — and never all backends.

--check exits 0/1 per the normative contract in the tool header. FIRST, before any of the arms
below, a configured plan-execution.execute or task.execute of delegated (each read on its own)
with a plan in flight and a dirty, fingerprintable tree audits the delegation ledger: an absent
ledger is inert; an unreadable, malformed, foreign or audit-refused ledger, a failed HEAD read,
or a SUBSTITUTED held session exits 1. THEN: 0 for solo / no plan in flight /
a clean tree (under a non-solo review obligation the PASS names every plan in flight and its arm) /
a cwd where git ITSELF answers not-a-repository (the only passing non-work-tree state; the four others exit 1 by name) / obligations satisfied (reviewed: >=1 ship-class attestation;
council: every backend ship-class or degrade-recorded, >=1 real ship); 1 on a veto, an
unrecognized verdict, a missing/stale/ungrounded/probe-only backend without a degrade record,
an all-degraded tree, or a down detector with no configured recipe.
Under an ARMED flow store (flow-orchestration Plan 3): a stale receipt can lift to CURRENT
through an unbroken bookkeeping-delta chain (#61), a maintainer-override can lift a standing
veto (#38/#56), and the SOLO obligations class gains the reduced internal-only floor as an
OBLIGATION (covered + internally attested plans; a standing veto still blocks, #43/#68/#48) —
each labeled in the check reason; a present-but-malformed flow store fails the dirty-tree
check closed; no store file means byte-identical pre-flow behavior.
Declare it as a project gate by hand (docs/ai/gates.json) or via the
explicit-consent init preview (tools/gates-init.mjs) — never without consent.

Read-only: never writes, never commits, never runs a subscription CLI; spawns read-only git queries.
Sandbox-safe: runs fully inside an OS sandbox (fs + git reads, no network) — the D4 sandbox lane.
Human residual: git commit --no-verify and receipt-file deletion remain possible — this is a
self-discipline mechanism, not a security boundary.

Exit codes: 0 pass (or plain report); 1 check failed or config error (loud); 2 usage.`;

const KNOWN_ARGS = new Set(['--help', '-h', '--check', '--json']);

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const detect = ctx.detect ?? detectBackends;
  const build = ctx.buildState ?? buildState;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const unknown = argv.find((a) => !KNOWN_ARGS.has(a));
    if (unknown !== undefined) throw fail(2, `unknown argument: ${unknown}`);
    const state = build({ cwd, env, detect, surveyVehicle: ctx.surveyVehicle, lstat: ctx.lstat, readFile: ctx.readFile });
    const check = decideCheck(state);
    // The mask advisory is NON-FAILING by contract: one notice line, never an exit-code arm.
    const advisory = maskAdvisoryLine(state);
    if (argv.includes('--json')) {
      return { code: argv.includes('--check') ? check.code : 0, stdout: JSON.stringify({ ...state, check }, null, 2), stderr: '' };
    }
    if (argv.includes('--check')) {
      const line = `review-state check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`;
      return { code: check.code, stdout: advisory ? `${line}\n${advisory}` : line, stderr: '' };
    }
    return { code: 0, stdout: advisory ? `${formatHuman(state, check)}\n${advisory}` : formatHuman(state, check), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `review-state: ${err.message}` };
  }
};

const emitResult = (r) => {
  // Exact writes + a natural exit: process.exit() can truncate unflushed piped stdio.
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
};

if (isDirectRun(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--await')) mainAwait(argv).then(emitResult);
  else emitResult(main(argv));
}
