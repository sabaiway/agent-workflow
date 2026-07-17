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
//   exit 0  when the CONFIGURED plan-execution.review recipe is solo (or the computed default is —
//           absent config with no reviewer backend ready); when no plan is in flight (docs/plans/
//           holds no top-level .md that is not queue.md and not scratch by the naming convention:
//           prefixes EXECUTE- / FEEDBACK-, or a name containing PROMPT / prompt / handoff); when
//           the tree is clean (nothing to review); when the cwd is not a git work tree; and when
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
// HUMAN residual (accepted, documented): `git commit --no-verify` skips any pre-commit gate, and
// deleting/editing the receipt file forges state — receipts live in the git dir (never committable)
// as an honest self-discipline mechanism, not a security boundary.
//
// Read-only: never writes, never commits, never runs a subscription CLI. It DOES spawn `git`
// (read-only queries) to compute the fingerprint — stated honestly in the catalog. Dependency-free,
// Node >= 22. No side effects on import (the isDirectRun idiom).

import { readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { detectBackends, READY } from './detect-backends.mjs';
import { resolveActivityRecipe, DISPLAY_ALIASES } from './recipes.mjs';
import { CONFIG_REL, fail, loadConfig } from './orchestration-config.mjs';
// The canonical review-domain primitives live in the core-evidence DAG bottom (ONE home for the
// fingerprint, the receipt read path, and the attesting predicate); this module RE-EXPORTS its
// historical public API from there and consumes the degrade records the same store owns.
import {
  RECEIPTS_BASENAME,
  computeFingerprintPayload,
  computeTreeFingerprint,
  isTreeClean,
  isNeverCommittableStat,
  resolveReceiptsPath,
  readReceipts,
  summarizeReviewReceiptsForTree,
  resolveBase,
  isShipVerdict,
  resolveEvidencePath,
  readEvidence,
  authoritativeOfKind,
} from './core-evidence.mjs';

export {
  RECEIPTS_BASENAME,
  computeFingerprintPayload,
  computeTreeFingerprint,
  isTreeClean,
  isNeverCommittableStat,
  resolveReceiptsPath,
  readReceipts,
};

export const PLANS_REL = 'docs/plans';
const ACTIVITY = 'plan-execution';
const SLOT = 'review';
const GIT_MAX_BUFFER = 256 * 1024 * 1024; // a full-tree diff can be large; never truncate silently
// --await (BUGFREE-3 / AD-049, item (d)) bounds + poll cadence. The default timeout is generous —
// a real grounded bridge review can take minutes — and every value is overridable (--timeout / the
// injectable clock) so hermetic tests never spend wall-clock.
export const DEFAULT_AWAIT_TIMEOUT_S = 900;
export const AWAIT_POLL_MS = 5000;

// ── git plumbing (read-only queries; injectable for tests) ─────────────────────────

const gitRaw = (args, cwd) =>
  spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });

// stdout Buffer of a git query, or null when git fails (not a repo / git absent).
const gitBuf = (args, cwd) => {
  const r = gitRaw(args, cwd);
  if (r.error || r.status !== 0) return null;
  return r.stdout;
};

const gitLine = (args, cwd) => {
  const buf = gitBuf(args, cwd);
  return buf == null ? null : buf.toString('utf8').replace(/\r?\n$/, '');
};

// The canonical fingerprint / clean check / never-committable filter live in core-evidence.mjs
// (the ONE home, re-exported above); this module keeps only its own presentation plumbing.

// ── the sandbox-masks advisory (D lane, AD-044 Plan 4 Phase 1.5) ────────────────────

// Count the never-committable untracked paths the STANDARD walk still shows. The review domain
// ignores them by construction; this count only feeds ONE non-failing advisory line naming the
// cosmetic sandbox-masks apply — an applied managed block hides the paths from --exclude-standard,
// so the advisory disappears exactly when the status noise does (no standing detector).
export const countNeverCommittableUntracked = (cwd, { lstat = lstatSync } = {}) => {
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) return 0;
  const untrackedZ = gitBuf(['ls-files', '--others', '--exclude-standard', '-z'], top);
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

// Shell-quote one argument for a COPY-PASTE advisory command: plain safe tokens stay bare; anything
// else rides single quotes (a space/metacharacter path must never render a dead or unsafe paste —
// codex R1). Exported for the sandbox-masks probe, which renders the same apply one-liner.
export const shellQuoteArg = (s) => (/^[A-Za-z0-9_/.\-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const maskAdvisoryLine = (state) =>
  state.maskedUntracked > 0
    ? `notice: ${state.maskedUntracked} never-committable untracked path(s) (device/FIFO/socket) are ignored by the review domain — hide them from git status: node ${shellQuoteArg(join(dirname(fileURLToPath(import.meta.url)), 'sandbox-masks.mjs'))} --cwd ${shellQuoteArg(state.root)} --apply`
    : '';

// ── plan-in-flight detector (the AD-038 naming convention; documented in queue.md) ─────

// Scratch by the naming convention: EXECUTE-/FEEDBACK- prefixes, or a name carrying PROMPT/prompt/
// handoff. queue.md is the series index, never a plan.
export const isScratchPlanName = (name) =>
  name === 'queue.md' ||
  name.startsWith('EXECUTE-') ||
  name.startsWith('FEEDBACK-') ||
  name.includes('PROMPT') ||
  name.includes('prompt') ||
  name.includes('handoff');

// The in-flight plan files: top-level docs/plans/*.md minus queue.md minus scratch. [] when the
// directory is absent (no plans → nothing in flight).
export const plansInFlight = (cwd, readdir = readdirSync) => {
  let entries;
  try {
    entries = readdir(join(cwd, PLANS_REL), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !isScratchPlanName(e.name))
    .map((e) => e.name)
    .sort();
};

// ── receipts (path + reader re-exported from the core-evidence one-home above) ──────

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

// ── obligations from the CONFIGURED recipe + the D3(b) degrade-record escape ────────

// Obligations derive from the CONFIGURED recipe — the RAW orchestration.json value — never the
// readiness-degraded effective recipe: the resolver degrades council→reviewed→solo BEFORE any
// check would see the missing backend, which would silently drop an obligation (a computed
// readiness-degrade NEVER silently becomes solo). The resolver stays for display/diagnostics
// only. The computed DEFAULT (absent config) is readiness-aware by design — a default never
// mints an unsatisfiable obligation; an EXPLICIT configured recipe never degrades here.
//   solo     → no obligation (the existing honest exit-0 contract);
//   reviewed → ONE ship-class attestation from ANY review-capable backend (minShip 1);
//   council  → EVERY review-capable backend attests ship-class OR carries a current-tree degrade
//              record — and NEVER all degraded (minShip 1 stands whenever >=1 backend is configured).
export const requiredBackendsForConfiguredRecipe = ({ config, readiness = [], detectionFailed = false } = {}) => {
  const configured = config?.[ACTIVITY]?.[SLOT];
  const providers = Object.values(DISPLAY_ALIASES); // every review-capable backend, codex first
  if (configured == null && detectionFailed) {
    // No config + no readiness signal: the computed default is UNKNOWABLE — fail closed upstream.
    return { recipe: null, source: 'default', backends: [], minShip: 0, perBackend: false, unknowable: true };
  }
  const anyReady = readiness.some((b) => b.readiness === READY);
  const recipe = configured ?? (anyReady ? 'reviewed' : 'solo');
  const source = configured != null ? 'config' : 'default';
  if (recipe === 'solo') return { recipe, source, backends: [], minShip: 0, perBackend: false, unknowable: false };
  if (recipe === 'council') return { recipe, source, backends: providers, minShip: 1, perBackend: true, unknowable: false };
  return { recipe, source, backends: providers, minShip: 1, perBackend: false, unknowable: false };
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
  const set = unavailable || fingerprint == null
    ? new Set()
    : new Set(authoritativeOfKind(read.records, 'degrade').filter((r) => r.fingerprint === fingerprint).map((r) => r.backend));
  return { set, storePath, malformed: read.malformed ?? 0, readError: read.readError ?? null, unavailable };
};

// ── the check + report core ─────────────────────────────────────────────────────────

// buildState({ cwd, env, detect }) → everything both renders need. Pure I/O at the edges.
// EVERY project-relative read (orchestration config, docs/plans, receipts) anchors at the git
// work-tree ROOT when one exists — the fingerprint is root-anchored, so a subdirectory invocation
// must read the same config/plans or a dirty unreceipted tree could false-PASS as "no plan in
// flight" (codex R1 finding). Outside a git tree the cwd is the only anchor (and --check exits 0).
export const buildState = ({ cwd, env = process.env, detect = detectBackends, lstat = lstatSync } = {}) => {
  const root = gitLine(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const { config, source: configSource } = loadConfig(root);
  let detection = [];
  let detectionWarning = null;
  try {
    detection = detect();
  } catch (err) {
    detectionWarning = `backend detection failed (${(err && err.message) || err}) — readiness unknown.`;
  }
  // The resolver stays for DISPLAY/diagnostics only; the OBLIGATIONS come from the configured
  // recipe (never the readiness-degraded effective one — no silent solo).
  const resolved = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity: ACTIVITY, slot: SLOT });
  const obligations = requiredBackendsForConfiguredRecipe({ config: config ?? {}, readiness: detection, detectionFailed: detectionWarning != null });
  const requiredBackends = obligations.backends;
  const plans = plansInFlight(root);
  // The injected lstat threads through EVERY stat-dependent computation (fingerprint, clean, the
  // mask count) — a partial injection would let a test observe an inconsistent state.
  const fingerprint = computeTreeFingerprint(cwd, { lstat });
  const clean = fingerprint == null ? null : isTreeClean(cwd, { lstat });
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
  return {
    resolved,
    configSource,
    obligations,
    requiredBackends,
    backends,
    plans,
    root,
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
    maskedUntracked: countNeverCommittableUntracked(cwd, { lstat }),
    detectionWarning,
  };
};

// Why a backend's current-tree receipts were all rejected — the two causes read differently and
// have different recoveries (fix the file vs refresh the bridge), so they are never collapsed.
const rejectionCause = (b) => {
  const parts = [];
  if (b.markerRejected > 0) parts.push(`${b.markerRejected} with a malformed probe marker`);
  if (b.unmarkedRejected > 0) {
    parts.push(`${b.unmarkedRejected} with no probe marker — silence is not a declaration, so the probe status is untrustworthy; re-run the review with a bridge that marks its runs`);
  }
  if ((b.postureRejected ?? 0) > 0) {
    parts.push(`${b.postureRejected} with an absent/invalid run posture (D5) — a pre-posture wrapper minted it; re-run the review on the current bridge`);
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
  if (b.state === 'rejected') return `${b.backend}: current-tree receipts rejected — ${rejectionCause(b)} (fail-closed); inspect ${state.receiptsPath}`;
  if (b.state === 'stale') return `${b.backend}: receipts exist but none matches the current tree (edited after review) — run a fresh review`;
  return `${b.backend}: no receipt — run its review wrapper, or record an explicit degrade (node ${shellQuoteArg(join(dirname(fileURLToPath(import.meta.url)), 'core-evidence.mjs'))} degrade --backend ${b.backend} --reason "...")`;
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
  const malformedNote = state.malformed > 0 ? ` — ${state.malformed} malformed receipt line(s) ignored; inspect ${state.receiptsPath}` : '';
  const evidenceNote = state.evidenceUnavailable
    ? ` — evidence store unavailable (${state.evidenceMalformed} malformed line(s)${state.evidenceReadError ? `, read error: ${state.evidenceReadError}` : ''}); the degrade escape is denied (fail-closed) — inspect ${state.evidenceStorePath}`
    : '';
  const earlyNotes = `${malformedNote}${evidenceNote}${state.receiptsReadError ? ` — receipts store unreadable (${state.receiptsReadError}); inspect ${state.receiptsPath}` : ''}`;
  // Detector failure with NO configured recipe: the computed default is unknowable → fail closed.
  // An EXPLICIT configured recipe needs no detector — its obligations are readiness-independent.
  if (state.obligations.unknowable) {
    return { code: 1, reason: `cannot verify receipts — ${state.detectionWarning} No configured ${ACTIVITY}.${SLOT} recipe: the computed default is unknowable while the detector is down (fail closed).${earlyNotes}` };
  }
  if (state.obligations.recipe === 'solo') {
    const why = state.obligations.source === 'config'
      ? `configured ${ACTIVITY}.${SLOT} recipe is solo`
      : `no reviewer backend is ready — the computed ${ACTIVITY}.${SLOT} default is solo`;
    return { code: 0, reason: `${why} — no receipt required${earlyNotes}` };
  }
  if (state.plans.length === 0) return { code: 0, reason: `no plan in flight (docs/plans/ holds no active plan) — no receipt required${earlyNotes}` };
  if (state.fingerprint == null) return { code: 0, reason: `not a git work tree — nothing to fingerprint${earlyNotes}` };
  if (state.clean === true) return { code: 0, reason: `the working tree is clean — nothing to review${earlyNotes}` };
  const exempt = new Set(state.degradedExempt);
  const satisfied = state.backends.filter((b) => b.state === 'current' && b.shipClass);
  const vetoed = state.backends.filter((b) => b.state === 'current' && !b.shipClass);
  // The marker note is PATH-AWARE (no silent rejections on any exit): it counts every backend's
  // untrusted-marker exclusions EXCEPT those whose printed part already names them — i.e. only a
  // PRINTED `rejected` row (backendFailurePart's rejectionCause) suppresses its own counts; a
  // printed veto/unrecognized/ungrounded row does not, and success paths suppress nothing.
  const notesFor = (printed) => {
    const total = state.backends
      .filter((b) => !(printed.has(b.backend) && b.state === 'rejected'))
      .reduce((n, b) => n + (b.markerRejected ?? 0) + (b.unmarkedRejected ?? 0), 0);
    const markerNote = total > 0
      ? ` — ${total} receipt(s) rejected: an untrustworthy probe marker (malformed, or absent — silence is not a declaration) — fail-closed; inspect ${state.receiptsPath}`
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
    return { code: 1, reason: `${unconditional.map((b) => backendFailurePart(b, state)).join('; ')}${notesFor(new Set(unconditional.map((b) => b.backend)))}` };
  }
  // Never all degraded: >=1 ship-class attestation whenever >=1 backend is configured. An
  // already-exempt backend renders its own honest part — never the "record an explicit degrade"
  // recovery it has already taken.
  if (satisfied.length < state.obligations.minShip) {
    const failing = state.backends.filter((b) => !(b.state === 'current' && b.shipClass));
    const allExempt = failing.length > 0 && failing.every((b) => exempt.has(b.backend));
    const head = allExempt
      ? `every configured backend is degrade-recorded for this tree — never all degraded: >=1 non-degraded ship-class attestation is required; run at least one real review`
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
    // Council: EVERY configured backend must attest ship-class OR carry a current-tree degrade record.
    const failing = state.backends.filter((b) => !(b.state === 'current' && b.shipClass) && !exempt.has(b.backend));
    if (failing.length > 0) {
      return { code: 1, reason: `${failing.map((b) => backendFailurePart(b, state)).join('; ')}${notesFor(new Set(failing.map((b) => b.backend)))}` };
    }
    if (exempt.size === 0) {
      return { code: 0, reason: `every configured backend attests ship-class for the current tree (${state.requiredBackends.join(' + ')})${notesFor(NONE_PRINTED)}` };
    }
    return { code: 0, reason: `council satisfied: ship-class attestation(s) from ${satisfied.map((b) => b.backend).join(' + ')}; degrade-recorded for this tree: ${[...exempt].join(', ')}${notesFor(NONE_PRINTED)}` };
  }
  // Reviewed: >=1 ship-class attestation from any review-capable backend satisfies.
  return { code: 0, reason: `reviewed satisfied: ship-class attestation from ${satisfied.map((b) => b.backend).join(' + ')} for the current tree${notesFor(NONE_PRINTED)}` };
};

// ── rendering ───────────────────────────────────────────────────────────────────────

// The glyph reflects SATISFACTION, not bare state: a `current` row carrying a recognized
// NEGATIVE is an authoritative veto and renders ✗.
const STATE_GLYPH = { 'unrecognized-verdict': '✗', ungrounded: '✗', probe: '✗', rejected: '✗', stale: '✗', missing: '✗' };
const glyphFor = (b) => (b.state === 'current' ? (b.shipClass ? '✓' : '✗') : STATE_GLYPH[b.state]);

const formatHuman = (state, check) => {
  const src = state.obligations.source === 'config' ? `from ${CONFIG_REL}` : 'computed default';
  const lines = [
    `review-state — ${ACTIVITY}.${SLOT} = ${state.obligations.recipe ?? '(unknowable)'} (${src})${state.requiredBackends.length ? ` → ${state.requiredBackends.join(' + ')}${state.obligations.perBackend ? '' : ' (any one, ship-class)'}` : ''}`,
  ];
  if (state.detectionWarning) lines.push(`  ⚠ ${state.detectionWarning}`);
  lines.push(`  plan in flight: ${state.plans.length ? state.plans.join(', ') : '(none)'}`);
  if (state.fingerprint == null) lines.push('  tree: not a git work tree');
  else if (state.clean === true) lines.push('  tree: clean (nothing to review)');
  else lines.push(`  tree fingerprint: ${state.fingerprint}`);
  lines.push(`  receipts: ${state.receiptsPath ?? '(unresolvable — no git dir)'} (${state.receiptCount} line(s)${state.malformed ? `, ${state.malformed} malformed — inspect the file` : ''})`);
  if (state.receiptsReadError) lines.push(`  ⚠ receipts store unreadable (${state.receiptsReadError}) — inspect ${state.receiptsPath}`);
  if (state.evidenceUnavailable) lines.push(`  ⚠ evidence store unavailable (${state.evidenceMalformed} malformed line(s)${state.evidenceReadError ? `, read error: ${state.evidenceReadError}` : ''}) — the degrade escape is denied (fail-closed)`);
  const exempt = new Set(state.degradedExempt);
  for (const b of state.backends) {
    const exemptTag = exempt.has(b.backend) ? ' — degrade-recorded for the current tree (core-evidence store)' : '';
    const detail =
      b.state === 'current'
        ? `current (verdict: ${JSON.stringify(b.verdict)}${b.shipClass ? ', ship-class' : ' — a recognized negative, an authoritative VETO'}, grounded, ${b.timestamp ?? '?'})`
        : b.state === 'unrecognized-verdict'
          ? `latest normal receipt carries an unrecognized verdict (${JSON.stringify(b.verdict)}) — never attests (fail-closed)`
          : b.state === 'ungrounded'
            ? `ungrounded latest normal receipt (verdict: ${JSON.stringify(b.verdict)}) — a grounded fresh run is required`
            : b.state === 'probe'
              ? 'only probe receipts for the current tree (quality guards relaxed) — a probe review never attests'
              : b.state === 'rejected'
                ? `current-tree receipts rejected — ${rejectionCause(b)} (fail-closed)`
                : b.state === 'stale'
                  ? 'stale — no receipt matches the current tree (edited after review)'
                  : 'missing — no receipt from this backend';
    const excludedTag = b.probeExcluded || b.markerRejected || b.unmarkedRejected
      ? ` [excluded: ${b.probeExcluded} probe, ${b.markerRejected} malformed-marker, ${b.unmarkedRejected} unmarked]`
      : '';
    // ⊘ only where the escape actually applies: a PRODUCED receipt outranks the record — a
    // negative/unknown verdict keeps its ✗ (the degrade lifts neither).
    const escapeApplies = exempt.has(b.backend) && b.state !== 'current' && b.state !== 'unrecognized-verdict';
    lines.push(`    ${escapeApplies ? '⊘' : glyphFor(b)} ${b.backend}: ${detail}${excludedTag}${exemptTag}`);
  }
  lines.push(`  check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`);
  return lines.join('\n');
};

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

--check exits 0/1 per the normative contract in the tool header: 0 for solo / no plan in flight /
a clean tree / not-a-git-tree / obligations satisfied (reviewed: >=1 ship-class attestation;
council: every backend ship-class or degrade-recorded, >=1 real ship); 1 on a veto, an
unrecognized verdict, a missing/stale/ungrounded/probe-only backend without a degrade record,
an all-degraded tree, or a down detector with no configured recipe.
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
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const unknown = argv.find((a) => !KNOWN_ARGS.has(a));
    if (unknown !== undefined) throw fail(2, `unknown argument: ${unknown}`);
    const state = buildState({ cwd, env, detect, lstat: ctx.lstat });
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

// ── --await: block until the configured review obligations are SATISFIED ───────────────
// It waits until `--check` would pass: under `reviewed`, a ship-class attestation from any
// review-capable backend; under `council`, every configured backend ship-class OR carrying a
// current-tree degrade RECORD in the core-evidence store (never all backends) — once such a
// record lands, --await stops waiting for that backend and returns READY (before, it waited
// forever for a receipt that never comes). It inherits everything for FREE — it polls the SAME
// decideCheck(buildState()) `--check` computes. The completion signal is the RECEIPT/RECORD
// (i.e. `--check` would PASS), NEVER a process event — a harness "completed" notification fires
// early and a bridge's output late-flushes, so polling state is the durable mechanization of
// receipts-not-pgrep. Stays read-only (it only re-reads state — now the evidence store too, a
// few KB per tick); the clock is injectable (ctx.now / ctx.sleep / ctx.pollMs) so hermetic tests
// never spend wall-clock.

const AWAIT_ALLOWED_ARGS = new Set(['--await', '--timeout']);

const parseAwaitTimeoutS = (argv) => {
  const i = argv.indexOf('--timeout');
  if (i === -1) return DEFAULT_AWAIT_TIMEOUT_S;
  const raw = argv[i + 1];
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) throw fail(2, '--timeout requires a positive integer number of seconds');
  return Number(raw);
};

export const mainAwait = async (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const detect = ctx.detect ?? detectBackends;
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = ctx.pollMs ?? AWAIT_POLL_MS;
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === '--timeout') { i += 1; continue; } // its value is consumed by parseAwaitTimeoutS
      if (!AWAIT_ALLOWED_ARGS.has(a)) throw fail(2, `--await accepts only --timeout <s> (got ${a})`);
    }
    const timeoutS = parseAwaitTimeoutS(argv);
    const timeoutMs = timeoutS * 1000;
    const start = now();
    // Poll the SAME normative decision --check computes: ready == `--check` would pass (solo / no
    // plan / a clean tree / not-a-git-tree all resolve instantly — nothing to await). Re-read state
    // every poll so a landed receipt (or a tree edit that re-staled one) is seen fresh. The DEADLINE
    // is checked BEFORE readiness (codex council R2): once elapsed reaches the timeout the await is
    // over, so a receipt that only lands AT/after the deadline never flips it to READY; and each
    // sleep is BOUNDED to the remaining time so a full poll interval can never overshoot the timeout.
    let lastReason = 'no poll completed before the deadline';
    for (;;) {
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) return { code: 1, stdout: '', stderr: `review-state --await: TIMEOUT after ${timeoutS}s — ${lastReason}` };
      const check = decideCheck(buildState({ cwd, env, detect }));
      lastReason = check.reason;
      if (check.code === 0) return { code: 0, stdout: `review-state --await: READY — ${check.reason}`, stderr: '' };
      await sleep(Math.min(pollMs, timeoutMs - elapsed));
    }
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `review-state: ${err.message}` };
  }
};

const emitResult = (r) => {
  // Exact writes + a natural exit: process.exit() can truncate unflushed piped stdio (codex R2).
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const argv = process.argv.slice(2);
  if (argv.includes('--await')) mainAwait(argv).then(emitResult);
  else emitResult(main(argv));
}
