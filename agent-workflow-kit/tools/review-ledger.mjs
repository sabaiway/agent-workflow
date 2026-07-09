#!/usr/bin/env node
// review-ledger.mjs — the read-only review-round LEDGER checker behind `/agent-workflow-kit
// review-ledger` (DEBT-REVIEW-CAP / AD-045). It turns the prose review-loop crossover-stop
// (planning.md §9 "cap ≤2 / crossover-stop / fold-at-altitude"; procedures.md "{round N ·
// finding-origin tally · per-backend verdict} … computed signal, not a remembered rule") into a
// COMPUTED signal: the orchestrator records one round per review round to a git-dir JSONL, and this
// tool computes the stop decision from the recorded rounds + triage classifications, never from a
// remembered rule. It is the read-only sibling of review-state.mjs (presence vs convergence are
// distinct axes) — it NEVER imports the writer (review-ledger-write.mjs); an import-split test pins
// that structural invariant.
//
// Normative `--check` exit contract (the single home of this list — SKILL.md / the mode file point
// here). The gate enforces the plan-EXECUTION (code) loop — the loop that produces the committable
// artifact — filtered to the current SEGMENT: activity==="plan-execution" AND the in-flight plan's
// filename stem AND base===`git rev-parse HEAD` (BUGFREE-2 / AD-048, D1 — a segment is the
// uncommitted change set over one base commit; it closes only by a gated commit, so a round-counter
// reset is earned, never declared):
//   exit 0  when the resolved plan-execution.review recipe is solo (configured, or degraded there —
//           no reviewer ready); when no plan is in flight (the review-state naming convention);
//           when the tree is clean (nothing to review); when the cwd is not a git work tree; and
//           when the in-flight plan-execution SEGMENT is `converged` or `resolved-residual` (its
//           latest round's non-degraded backends carry grounded code receipts for the recorded
//           fingerprint, and a recorded 0/0 is ship-class-consistent with those receipts).
//   exit 1  for any DIRTY in-flight plan-execution segment that is neither `converged` nor
//           `resolved-residual` — `triage-required`, `continue`, OR no round/receipt recorded in
//           the CURRENT segment (a dirty active plan with an empty/stale/other-segment ledger is a
//           FAILURE, not a fail-open pass; when the loop holds only pre-v4 records the reason names
//           the schema upgrade — old records never enter a segment, D7);
//           when MORE THAN ONE plan is in flight (ambiguous loop id); when a recorded ship-class 0/0
//           coexists with a non-ship receipt verdict, or a non-degraded recorded backend lacks a
//           grounded receipt for its fingerprint. Fail-CLOSED (unknown state, never a fail-open pass)
//           on a detector failure, an unreadable (non-ENOENT) ledger, malformed ledger lines the
//           reader dropped, or a corrupt segment round sequence (not 1..n) — the only
//           detector-independent green is an EXPLICIT configured solo.
//
// The stop decision: `decideStop(records, { cap, currentFingerprint, requiredBackends })` reads the
// ordered ledger records of ONE loop (both `round` and `triage` kinds) and returns exactly one state
// ∈ {converged, resolved-residual, triage-required, continue} under the fixed precedence
// (converged > resolved-residual > triage-required > continue). It reads MACHINE fields only (counts,
// class, accepted, fingerprint), never free-text. `hardMax` is NOT an input — it is a writer-only
// ceiling (Decision 5), enforced in review-ledger-write.mjs.
//
// HUMAN residual (accepted, documented — exactly like review-state's): the ledger attests a review
// occurred and its ship-class is consistent; it does NOT prove the recorded COUNTS are truthful, nor
// that a self-reported `degraded:true` is real (`git commit --no-verify`, ledger-file editing, and
// forged counts remain possible). The ledger lives in the git dir (never committable) — an honest
// self-discipline mechanism against silent process drift, not a security boundary.
//
// Read-only: never writes, never commits, never runs a subscription CLI. It DOES spawn read-only
// `git` queries (via the reused review-state fingerprint reader + a git-dir resolver). Dependency-
// free, Node >= 18. No side effects on import (the isDirectRun idiom).

import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { detectBackends } from './detect-backends.mjs';
import { resolveActivityRecipe, planRecipe, DISPLAY_ALIASES } from './recipes.mjs';
import { CONFIG_REL, fail, loadConfig } from './orchestration-config.mjs';
// Reuse the review-state readers directly (the family read/write split — review-state is read-only,
// so importing it keeps this module writer-free): the canonical fingerprint, the tolerant receipt
// parse, the tree-clean preflight, the plan-in-flight detector, and the receipt-path resolver.
import {
  computeTreeFingerprint,
  isTreeClean,
  plansInFlight,
  readReceipts,
  resolveReceiptsPath,
} from './review-state.mjs';
// The NEUTRAL shared core (D4/D8): the D8 telemetry reads the FOLD ledger through the neutral
// module — never through fold-completeness.mjs, which imports THIS module (the import-cycle
// invariant, codex R2; an import-split test pins it). probeVerdict is the one D4 algebra home.
import { probeVerdict, resolveResultsPath, readJsonlRows } from './changed-surface.mjs';
// The NEUTRAL ledger read/schema core (AD-050): the validated read path — path/base resolvers,
// schema validator + reader, loop/segment filters — extracted so review-state.mjs can read the
// ledger for its degraded exemption WITHOUT importing this module back (the cycle). Imported here
// for internal use AND re-exported below so every existing importer (grounding, fold-completeness
// [-run], review-ledger-write, doc-parity, the tests) resolves unchanged.
import {
  LEDGER_BASENAME,
  ORIGINS,
  resolveLedgerPath,
  resolveBase,
  readLedger,
  filterLoopRecords,
  filterSegmentRecords,
  roundSequenceIntact,
} from './review-ledger-core.mjs';
export {
  LEDGER_BASENAME,
  ORIGINS,
  resolveLedgerPath,
  resolveBase,
  readLedger,
  filterLoopRecords,
  filterSegmentRecords,
  roundSequenceIntact,
};
// Re-export-only (validated in the core, unused internally here): the schema/vocabulary + testId
// format the writer, doc-parity, and fold-completeness import through this module.
export { SCHEMA_VERSION, V4_CLASSES, V4_OVERRIDE_SCOPES, isWellFormedTestId, splitTestId, validateRecord } from './review-ledger-core.mjs';

const ACTIVITY = 'plan-execution';
const SLOT = 'review';
// The triage TRIGGER cap (Decision 5): reaching it with an unclassified surviving blocking finding
// forces triage. Shared with the writer (which imports it) — the writer-only hard-max ceiling lives
// there, never here (it is not a decideStop input).
export const REVIEW_CAP = 2;

// ── git-dir resolution (read-only queries) ──────────────────────────────────────────────────────

const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

const gitRoot = (cwd) => gitLine(['rev-parse', '--show-toplevel'], cwd);

// ── ship-verdict mapping (the single home; a named test pins it) ────────────────────────────────

// isShipVerdict(verdict) — which free-text review verdicts are ship-class. SHIP / SHIP WITH NITS are
// ship; revise / REWORK / unknown / anything else are not. Case-insensitive, trimmed.
export const isShipVerdict = (verdict) => {
  const v = String(verdict ?? '').trim().toLowerCase();
  return v === 'ship' || v === 'ship with nits';
};

// isProcessGateCmd(cmd) — the CLOSED, kit-owned process-gate classification (D5): the kit's own
// process-loop `--check` commands (review-state / review-ledger / fold-completeness) legitimately
// fail MID-loop, so "quality-green" excludes them — without the carve-out the D5 tooth is
// unsatisfiable by construction. Closed by the gate's cmd being EXACTLY one `--check` invocation of
// one of the three checkers (an optionally-quoted path token whose basename is the tool — never a
// substring: fold-completeness-run.mjs must NOT match). A COMPOUND line (`… && checker --check`)
// is never process: exempting it would forgive the failing quality half — fail-open against the
// D5 direction (internal sweep, live-probed). Pinned by its own named test.
// The tool BASENAME must sit at a path boundary (start-of-token or after a separator): a
// suffix-named sibling like `my-review-ledger.mjs` is a consumer's own tool, and misclassifying it
// as process would forgive its red result (codex R2, fold-induced by the R1 exact-form rewrite).
const PROCESS_GATE_RE = /^node\s+("(?:[^"]*[/\\])?(?:review-state|review-ledger|fold-completeness)\.mjs"|(?:[^\s"]*[/\\])?(?:review-state|review-ledger|fold-completeness)\.mjs)\s+--check$/;
export const isProcessGateCmd = (cmd) => PROCESS_GATE_RE.test(String(cmd).trim());

// isQualityGreenGateRun(record) → boolean (D5). Quality-green = the run covers EVERY declared
// NON-process gate with a green result (a `--only` subset is recorded honestly but never satisfies
// this — the R1 converged subset-bypass hole), AND the tree did not change under the run
// (fingerprint === fingerprintAfter, both non-null — a mutating gate attests no particular tree,
// codex R2). Process-gate failures never block.
export const isQualityGreenGateRun = (record) => {
  if (record.kind !== 'gate-run') return false;
  if (record.fingerprint == null || record.fingerprint !== record.fingerprintAfter) return false;
  const green = new Set(record.results.filter((r) => r.ok).map((r) => r.id));
  return record.declared.every((d) => isProcessGateCmd(d.cmd) || green.has(d.id));
};

// collectOverrides(records, { activity, loop }) → { oracleChangeFiles: Set, redProofTestIds: Set }.
// The UNION of the loop's recorded v3-scope override payloads — loop + payload scoped, never
// fingerprint-bound (D3: re-affirmation churn on every later edit would train rubber-stamping). The
// fold-completeness checker consumes THIS (both modules are read-only — the read/write split holds).
// The v4 `size-cap` scope is deliberately NOT here: it is SEGMENT-scoped and consumed by the writer
// tooth via collectSizeCapLimit.
export const collectOverrides = (records, { activity = ACTIVITY, loop } = {}) => {
  const oracleChangeFiles = new Set();
  const redProofTestIds = new Set();
  for (const r of filterLoopRecords(records, { activity, loop })) {
    if (r.kind !== 'override') continue;
    if (r.scope === 'oracle-change') for (const f of r.files) oracleChangeFiles.add(f);
    else if (r.scope === 'red-proof') redProofTestIds.add(r.testId);
  }
  return { oracleChangeFiles, redProofTestIds };
};

// collectSizeCapLimit(records, { activity, loop, base }) → the LARGEST sanctionedLines among the
// segment's recorded size-cap overrides, or null when none exists (D4). Segment-scoped by
// construction: a magnitude sanctioned for one base never leaks into the next segment.
export const collectSizeCapLimit = (records, { activity = ACTIVITY, loop, base } = {}) => {
  let limit = null;
  for (const r of filterSegmentRecords(records, { activity, loop, base })) {
    if (r.kind !== 'override' || r.scope !== 'size-cap') continue;
    if (limit === null || r.sanctionedLines > limit) limit = r.sanctionedLines;
  }
  return limit;
};

// ── the computed crossover-stop (pure; machine fields only) ─────────────────────────────────────

const BLOCKING = new Set(['blocker', 'major']);
const isBlocking = (f) => BLOCKING.has(f.severity);

// decideStop(records, { cap, currentFingerprint, requiredBackends }) → { state, reason }.
// state ∈ {converged, resolved-residual, triage-required, continue}, fixed precedence
// converged > resolved-residual > triage-required > continue. Machine fields only.
export const decideStop = (records, { cap = REVIEW_CAP, currentFingerprint = null, requiredBackends = [] } = {}) => {
  const rounds = records.filter((r) => r.kind === 'round');
  const triages = records.filter((r) => r.kind === 'triage');
  if (rounds.length === 0) return { state: 'continue', reason: 'no review round recorded for this loop yet' };
  const latest = rounds[rounds.length - 1];

  // Classification map, BOUND to the triggering (latest) round: only a triage that targets the latest
  // round classifies its surviving findings. A triage recorded for an earlier round — or a future /
  // nonexistent round — must NOT satisfy resolved-residual by findingKey alone (codex R1): a finding
  // that recurs into a new round is re-triaged for that round. A later triage overrides an earlier one;
  // each carries the triage's own fingerprint (the tree state its resolution was decided against).
  const classOf = new Map();
  for (const t of triages) if (t.round === latest.round) for (const c of t.classifications) classOf.set(c.findingKey, { ...c, triageFingerprint: t.fingerprint });
  const isClassified = (key) => classOf.has(key);
  // `refuted` (v4, AD-048) resolves like an inherent-layer-residual: a documented, grounds-cited
  // resolution of a phantom finding. Without this arm a phantom minted at round HARD_MAX and
  // honestly refuted would WEDGE the segment (the immutable round record keeps the minting
  // backend's counts non-0/0, and no further round exists to vanish it into). Additive beside the
  // frozen truth table — every pre-existing row is untouched (D10).
  const isResolvedClass = (c) => c && (c.class === 'inherent-layer-residual' || c.class === 'refuted' || (c.class === 'escalate' && c.accepted === true));

  const survivingBlocking = latest.findings.filter(isBlocking);

  // ── converged ── every requiredBackend present + non-degraded at 0/0 (a degraded requiredBackend
  // is excluded but must be recorded), at least one real non-degraded 0/0 review, current tree.
  const entryFor = (rb) => latest.backends.find((b) => b.backend === rb);
  const allPresent = requiredBackends.every((rb) => entryFor(rb) !== undefined);
  const nonDegradedReq = requiredBackends.map(entryFor).filter((b) => b && !b.degraded);
  const convergedCounts = allPresent && nonDegradedReq.length >= 1 && nonDegradedReq.every((b) => b.blockers === 0 && b.majors === 0);
  if (convergedCounts && currentFingerprint != null && currentFingerprint === latest.fingerprint) {
    return { state: 'converged', reason: `every recipe-named backend reviewed the current tree at 0 blockers + 0 majors (${requiredBackends.join(' + ') || 'none named'})` };
  }

  // A blocking findingKey's presence across ROUND records (recurrence, Decision 5).
  const blockingRoundCount = new Map();
  for (const r of rounds) {
    const keys = new Set(r.findings.filter(isBlocking).map((f) => f.findingKey));
    for (const k of keys) blockingRoundCount.set(k, (blockingRoundCount.get(k) ?? 0) + 1);
  }
  const recurred = (key) => (blockingRoundCount.get(key) ?? 0) >= 2;
  // Recurrence is keyed on the LATEST round's SURVIVING findings ONLY. A finding that was FIXED (no
  // longer surviving) must never force triage-required — else the gate DEADLOCKS: recordTriage rightly
  // refuses to classify a vanished finding, so a historical recurring key that is gone could never be
  // cleared. This is the root simplification (council R3, confirmed by both backends).
  const triggerReached = latest.round >= cap || survivingBlocking.some((f) => recurred(f.findingKey));

  // ── resolved-residual ── trigger reached AND every recipe-named backend present (the SAME presence
  // discipline as converged — a residual accepted while a recipe-named backend never reviewed is not
  // resolved, codex R4) AND every surviving blocking finding classified inherent-layer-residual (or
  // accepted-escalate) AND the classifying triage's fingerprint equals the current tree.
  if (triggerReached && allPresent && survivingBlocking.length >= 1) {
    const allResolved = survivingBlocking.every((f) => {
      const c = classOf.get(f.findingKey);
      return isResolvedClass(c) && currentFingerprint != null && c.triageFingerprint === currentFingerprint;
    });
    if (allResolved) {
      return { state: 'resolved-residual', reason: `${survivingBlocking.length} surviving blocking finding(s) classified as an accepted residual at the current tree — never folded again` };
    }
  }

  // ── triage-required (writer HARD STOP) ── at/after the cap an UNCLASSIFIED surviving blocking
  // finding, OR a blocking findingKey recurred in >= 2 rounds and is still unclassified (even under
  // the cap). Only the UNCLASSIFIED state blocks — a classified fixable-bug lets the fix round run.
  const unclassifiedSurviving = survivingBlocking.filter((f) => !isClassified(f.findingKey));
  // Keys reference only LIVE (surviving) findings — never a vanished historical key (the deadlock).
  const hasUnclassifiedRecurrence = unclassifiedSurviving.some((f) => recurred(f.findingKey));
  if ((latest.round >= cap && unclassifiedSurviving.length >= 1) || hasUnclassifiedRecurrence) {
    const keys = [...new Set(unclassifiedSurviving.map((f) => f.findingKey))];
    const recurNote = hasUnclassifiedRecurrence ? ` (recurred in ≥2 rounds — classify whether it is an inherent-layer-residual before another fold)` : '';
    return { state: 'triage-required', reason: `classify each surviving blocking finding before another round: ${keys.join(', ')}${recurNote}` };
  }

  // ── continue (explicit catch-all) ──
  let reason;
  if (convergedCounts) reason = 'a clean review exists but the tree was edited after it — re-review the edited tree';
  else if (survivingBlocking.length >= 1) reason = 'surviving blocking findings — fold and re-review, or classify at the cap';
  else reason = 'not yet converged — record the current review round';
  return { state: 'continue', reason };
};

// ── receipt cross-check (integrity binding, Decision 7) ──────────────────────────────────────────

// receiptCrossCheck(round, receipts, fingerprint) → { ok, reason }. For each NON-degraded backend of
// `round`: a grounded code receipt must exist for (backend, fingerprint) — a round cannot pass for a
// tree no bridge reviewed — AND a recorded ship-class 0/0 must not coexist with a non-ship receipt
// verdict. A degraded backend minted no receipt (it ran no real review) and is exempt.
export const receiptCrossCheck = (round, receipts, fingerprint) => {
  for (const b of round.backends) {
    if (b.degraded) continue;
    const own = receipts.filter(
      (r) => r.backend === b.backend && r.fingerprint === fingerprint && r.artifact === 'code' && r.fresh === true && r.grounded === true,
    );
    if (own.length === 0) {
      return { ok: false, reason: `no grounded code receipt for ${b.backend} at the recorded fingerprint (a recorded round must bind to a real review)` };
    }
    if (b.blockers === 0 && b.majors === 0) {
      const latest = own[own.length - 1];
      if (!isShipVerdict(latest.verdict)) {
        return { ok: false, reason: `${b.backend} recorded 0 blockers/0 majors but its receipt verdict "${latest.verdict}" is not ship-class` };
      }
    }
  }
  return { ok: true };
};

// ── the check + report core ─────────────────────────────────────────────────────────────────────

// buildLedgerState({ cwd, env, detect }) → everything both renders need. Pure I/O at the edges;
// every project-relative read anchors at the git work-tree ROOT when one exists (the fingerprint is
// root-anchored — the same discipline review-state uses).
export const buildLedgerState = ({ cwd, env = process.env, detect = detectBackends } = {}) => {
  const root = gitRoot(cwd) ?? cwd;
  const { config } = loadConfig(root);
  let detection = [];
  let detectionWarning = null;
  try {
    detection = detect();
  } catch (err) {
    detectionWarning = `backend detection failed (${(err && err.message) || err}) — treating all backends as not ready; the review recipe floors at solo.`;
  }
  const resolved = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity: ACTIVITY, slot: SLOT });
  const { dispatch } = planRecipe(resolved.recipe, detection);
  const requiredBackends = dispatch.map((d) => DISPLAY_ALIASES[d.backend] ?? d.backend);
  const plans = plansInFlight(root);
  const fingerprint = computeTreeFingerprint(cwd);
  const clean = fingerprint == null ? null : isTreeClean(cwd);
  const base = resolveBase(cwd);
  const ledgerPath = resolveLedgerPath(cwd, env);
  const { records, malformed, malformedReasons, readError } = ledgerPath ? readLedger(ledgerPath) : { records: [], malformed: 0, malformedReasons: [] };
  const receiptsPath = resolveReceiptsPath(cwd, env);
  const { receipts } = receiptsPath ? readReceipts(receiptsPath) : { receipts: [] };
  return { resolved, requiredBackends, plans, fingerprint, clean, base, ledgerPath, records, malformed, malformedReasons, readError, receipts, receiptsPath, detectionWarning };
};

// The human label of a segment base (null = an unborn branch; undefined never occurs in a real
// state — resolveBase returns string | null).
const baseLabel = (base) => (base === null ? '(unborn branch)' : String(base).slice(0, 12));

// The normative --check decision (the header contract, in order) → { code, reason }.
export const decideCheck = (state) => {
  // A detector failure is UNKNOWN state, not "no reviewer ready" — fail closed (like review-state).
  // The only detector-independent green is an EXPLICIT configured solo.
  const explicitSolo = state.resolved.recipe === 'solo' && state.resolved.source === 'config' && !state.resolved.degradedFrom;
  if (state.detectionWarning && !explicitSolo) return { code: 1, reason: `cannot verify the ledger — ${state.detectionWarning}` };
  if (state.resolved.recipe === 'solo') {
    const why = state.resolved.degradedFrom
      ? `resolved ${ACTIVITY}.${SLOT} recipe degrades to solo here (${state.resolved.reason})`
      : `resolved ${ACTIVITY}.${SLOT} recipe is solo`;
    return { code: 0, reason: `${why} — no ledger required` };
  }
  if (state.plans.length === 0) return { code: 0, reason: 'no plan in flight (docs/plans/ holds no active plan) — no ledger required' };
  // More than one plan in flight → ambiguous loop id: fail CLOSED (Decision 6), never guess.
  if (state.plans.length > 1) return { code: 1, reason: `more than one plan in flight (${state.plans.join(', ')}) — ambiguous loop id; resolve to one active plan` };
  if (state.fingerprint == null) return { code: 0, reason: 'not a git work tree — nothing to fingerprint' };
  if (state.clean === true) return { code: 0, reason: 'the working tree is clean — nothing to review' };
  // Two unknown-state conditions on a dirty active plan → fail CLOSED, never a fail-open pass. A
  // non-ENOENT read error (codex R1); AND malformed lines the tolerant reader dropped, which could
  // silently remove the latest/non-converged round and let a stale converged one PASS (codex R3).
  if (state.readError) return { code: 1, reason: `cannot read the ledger (${state.readError}) — failing closed; inspect ${state.ledgerPath}` };
  if (state.malformed > 0) return { code: 1, reason: `the ledger has ${state.malformed} malformed line(s) — failing closed (a dropped line could hide a non-converged round); inspect ${state.ledgerPath}` };

  const loop = state.plans[0].replace(/\.md$/, '');
  // SEGMENT scope (D1): the gate judges the current segment — (plan-execution, loop, base = the
  // HEAD the dirty tree sits on). Records of earlier segments (other bases) and pre-v4 records
  // (no base — they can never enter a segment) are history, not the current loop state.
  const filtered = filterSegmentRecords(state.records, { activity: ACTIVITY, loop, base: state.base });
  const rounds = filtered.filter((r) => r.kind === 'round');
  // A dirty active plan whose SEGMENT has no round is a FAILURE, not a fail-open pass (codex R2
  // hole) — same failure direction as AD-045, per-segment remedy. When the loop holds only
  // older-schema records, the reason names the schema upgrade (D7 legacy rule).
  if (rounds.length === 0) {
    const loopAll = filterLoopRecords(state.records, { activity: ACTIVITY, loop });
    const legacy = loopAll.length > 0 && loopAll.every((r) => !(r.schema >= 4))
      ? ' (the loop has only pre-v4 records, which never enter a segment — the schema upgrade requires a fresh v4 round)'
      : '';
    return { code: 1, reason: `dirty plan-execution loop "${loop}" but no review round recorded for the current segment (base ${baseLabel(state.base)}) — record the current round${legacy}` };
  }
  // A corrupt round sequence (not 1..n) is unknown state → fail closed rather than trust "latest" (codex R3).
  if (!roundSequenceIntact(rounds)) return { code: 1, reason: `the round sequence for "${loop}" (base ${baseLabel(state.base)}) is corrupt (not 1..n) — failing closed; inspect ${state.ledgerPath}` };
  const decision = decideStop(filtered, { cap: REVIEW_CAP, currentFingerprint: state.fingerprint, requiredBackends: state.requiredBackends });
  if (decision.state === 'converged' || decision.state === 'resolved-residual') {
    // Integrity binding: cross-check the latest round's non-degraded backends against their receipts
    // at the RECORDED fingerprint (where the review happened). For converged that fingerprint equals
    // the current tree by construction; for resolved-residual it is the reviewed round's tree.
    const latest = rounds[rounds.length - 1];
    const cc = receiptCrossCheck(latest, state.receipts, latest.fingerprint);
    if (!cc.ok) return { code: 1, reason: `${decision.state} recorded but ${cc.reason}` };
    return { code: 0, reason: `${decision.state} — ${decision.reason}` };
  }
  return { code: 1, reason: `${decision.state} — ${decision.reason}` };
};

// ── rendering ─────────────────────────────────────────────────────────────────────────────────

const roundLine = (r) => {
  const backends = r.backends
    .map((b) => `${b.backend} ${b.degraded ? `degraded(${b.reason})` : `${b.blockers}/${b.majors}/${b.minors} ${b.verdict}`}`)
    .join(', ');
  const origins = ORIGINS.map((k) => `${k}:${r.origins[k]}`).join(' ');
  const findings = r.findings.length ? ` [${r.findings.map((f) => `${f.findingKey}(${f.severity})`).join(', ')}]` : '';
  return `  round ${r.round} (${origins}) — ${backends}${findings}`;
};

const triageLine = (t) =>
  `  triage @round ${t.round} — ${t.classifications.map((c) => `${c.findingKey}=${c.class}${c.class === 'escalate' ? `(accepted:${c.accepted})` : ''}`).join(', ')}`;

const overridePayload = (o) => {
  if (o.scope === 'oracle-change') return o.files.join(', ');
  if (o.scope === 'size-cap') return `sanctioned ${o.sanctionedLines} lines`;
  return o.testId;
};
const overrideLine = (o) => `  override @round ${o.round} [${o.scope}] — ${overridePayload(o)}: ${o.reason}`;

const gateRunLine = (g) => {
  const posture = isQualityGreenGateRun(g)
    ? 'quality-green'
    : g.fingerprint !== g.fingerprintAfter
      ? 'NOT quality-green (the tree changed under the run)'
      : 'NOT quality-green (a subset, a red gate, or an unfingerprinted tree)';
  return `  gate-run — status=${g.summary.status} ${g.summary.passed}/${g.summary.gates} green of ${g.declared.length} declared — ${posture}`;
};

const recordLine = (r) =>
  r.kind === 'round' ? roundLine(r) : r.kind === 'override' ? overrideLine(r) : r.kind === 'gate-run' ? gateRunLine(r) : triageLine(r);

// The loop's records grouped by SEGMENT (D1): v4 records group by base in order of first
// appearance; pre-v4 records (no base) group under a legacy header — readable history that never
// enters a segment.
const segmentGroups = (forLoop, currentBase) => {
  const lines = [];
  const seen = new Set();
  const legacy = forLoop.filter((r) => !(r.schema >= 4));
  if (legacy.length > 0) {
    lines.push('  pre-v4 records (no segment — readable history):');
    for (const r of legacy) lines.push(`  ${recordLine(r)}`);
  }
  for (const r of forLoop) {
    if (!(r.schema >= 4)) continue;
    const key = JSON.stringify(r.base);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  segment @ base ${baseLabel(r.base)}${r.base === currentBase ? ' (current)' : ''}:`);
    for (const s of forLoop) if (s.schema >= 4 && s.base === r.base) lines.push(`  ${recordLine(s)}`);
  }
  return lines;
};

const formatHuman = (state, check) => {
  const lines = [
    `review-ledger — ${ACTIVITY}.${SLOT} = ${state.resolved.recipe} (${state.resolved.source === 'config' ? `from ${CONFIG_REL}` : 'computed default'})${state.requiredBackends.length ? ` → ${state.requiredBackends.join(' + ')}` : ''}`,
  ];
  if (state.detectionWarning) lines.push(`  ⚠ ${state.detectionWarning}`);
  lines.push(`  plan in flight: ${state.plans.length ? state.plans.join(', ') : '(none)'}`);
  if (state.fingerprint == null) lines.push('  tree: not a git work tree');
  else if (state.clean === true) lines.push('  tree: clean (nothing to review)');
  else lines.push(`  tree fingerprint: ${state.fingerprint}`);
  if (state.fingerprint != null) lines.push(`  segment base: ${baseLabel(state.base)}`);
  lines.push(`  ledger: ${state.ledgerPath ?? '(unresolvable — no git dir)'} (${state.records.length} record(s)${state.malformed ? `, ${state.malformed} malformed — inspect the file` : ''})`);
  if (state.plans.length === 1) {
    const loop = state.plans[0].replace(/\.md$/, '');
    lines.push(...segmentGroups(filterLoopRecords(state.records, { activity: ACTIVITY, loop }), state.base));
  }
  lines.push(`  check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`);
  return lines.join('\n');
};

// ── telemetry (D8): read-only counts across ALL loops and BOTH ledgers — no judgment ─────────────

// computeTelemetry(reviewRecords, foldRows) → { loops: [...] } — deterministic counts with named
// fields, pinned by a named test. Interpretation (which gates earn their keep) stays with the
// maintainer. Fold rows come through the TOLERANT reader (readJsonlRows): fields are guarded, a
// half-shaped row counts only what it provably carries.
export const computeTelemetry = (reviewRecords, foldRows) => {
  const loops = new Map();
  const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
  const forLoop = (activity, loop) => {
    const key = JSON.stringify([activity, loop]);
    if (!loops.has(key)) {
      loops.set(key, {
        activity, loop, rounds: 0, segments: new Set(), legacyRecords: 0,
        origins: { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 },
        classifications: {}, backendVerdicts: {}, divergenceRounds: 0, overrides: {},
        gateRuns: 0, qualityGreenGateRuns: 0, redByGateId: {},
        foldRuns: 0, redProbes: 0, quarantinedProbes: 0,
      });
    }
    return loops.get(key);
  };
  for (const r of reviewRecords) {
    const t = forLoop(r.activity, r.loop);
    if (r.schema >= 4) t.segments.add(JSON.stringify(r.base));
    else t.legacyRecords += 1;
    if (r.kind === 'round') {
      t.rounds += 1;
      for (const k of ORIGINS) t.origins[k] += r.origins[k];
      const nonDegraded = r.backends.filter((b) => !b.degraded);
      for (const b of r.backends) {
        const verdicts = (t.backendVerdicts[b.backend] ??= {});
        bump(verdicts, b.degraded ? 'degraded' : b.verdict);
      }
      // Divergence = a round where the non-degraded backends SPLIT on clean (0 blockers + 0 majors)
      // vs not — the computed crossover signal, counted, never judged.
      const clean = nonDegraded.filter((b) => b.blockers === 0 && b.majors === 0).length;
      if (nonDegraded.length >= 2 && clean > 0 && clean < nonDegraded.length) t.divergenceRounds += 1;
    } else if (r.kind === 'triage') {
      for (const c of r.classifications) bump(t.classifications, c.class);
    } else if (r.kind === 'override') {
      bump(t.overrides, r.scope);
    } else if (r.kind === 'gate-run') {
      t.gateRuns += 1;
      if (isQualityGreenGateRun(r)) t.qualityGreenGateRuns += 1;
      for (const res of r.results) if (!res.ok) bump(t.redByGateId, res.id);
    }
  }
  for (const row of foldRows) {
    if (typeof row.loop !== 'string' || row.loop.length === 0) continue;
    const t = forLoop('plan-execution', row.loop); // the fold ledger is plan-execution-scoped
    if (row.kind === 'red-probe') t.redProbes += 1;
    else if (row.kind === 'run' || (row.schema === 1 && row.kind === undefined)) {
      t.foldRuns += 1;
      if (Array.isArray(row.testIds)) {
        for (const e of row.testIds) {
          const counted = e && [e.runs, e.greens, e.reds, e.timeouts].every(Number.isInteger);
          if (counted && probeVerdict(e) === 'quarantine') t.quarantinedProbes += 1;
        }
      }
    }
  }
  const sorted = [...loops.values()].sort((a, b) => (a.activity + a.loop < b.activity + b.loop ? -1 : 1));
  return { loops: sorted.map((t) => ({ ...t, segments: t.segments.size })) };
};

const countsOf = (obj) => {
  const keys = Object.keys(obj).sort();
  return keys.length === 0 ? '(none)' : keys.map((k) => `${k}:${obj[k]}`).join(' ');
};

export const renderTelemetry = (telemetry, meta) => {
  const lines = [
    `review-ledger telemetry — counts only, no judgment (D8). review ledger: ${meta.records} record(s)${meta.malformed ? `, ${meta.malformed} malformed` : ''}; fold ledger: ${meta.rows} row(s)${meta.badLines ? `, ${meta.badLines} unparseable` : ''}.`,
  ];
  if (meta.readError) lines.push(`  ⚠ review ledger unreadable (${meta.readError}) — counts exclude it`);
  if (meta.foldReadError) lines.push(`  ⚠ fold ledger unreadable (${meta.foldReadError}) — counts exclude it`);
  if (telemetry.loops.length === 0) lines.push('  (no loops recorded)');
  for (const t of telemetry.loops) {
    lines.push(`  ${t.activity} / ${t.loop}:`);
    lines.push(`    rounds ${t.rounds} across ${t.segments} segment(s)${t.legacyRecords ? ` (+${t.legacyRecords} pre-v4 record(s))` : ''} · divergence rounds ${t.divergenceRounds}`);
    lines.push(`    finding origins — ${ORIGINS.map((k) => `${k}:${t.origins[k]}`).join(' ')}`);
    lines.push(`    classifications — ${countsOf(t.classifications)}`);
    lines.push(`    backend verdicts — ${Object.keys(t.backendVerdicts).sort().map((b) => `${b}{${countsOf(t.backendVerdicts[b])}}`).join(' · ') || '(none)'}`);
    lines.push(`    overrides — ${countsOf(t.overrides)}`);
    lines.push(`    gate-runs ${t.gateRuns} (quality-green ${t.qualityGreenGateRuns}) · red results by gate — ${countsOf(t.redByGateId)}`);
    lines.push(`    fold runs ${t.foldRuns} · observed-red receipts ${t.redProbes} · quarantined probe entries ${t.quarantinedProbes}`);
  }
  return lines.join('\n');
};

const HELP = `review-ledger — read-only review-round LEDGER checker (agent-workflow family, AD-045 + AD-048).

Usage:
  node review-ledger.mjs [--check | --status | --json | --telemetry]

Reads the review-round ledger the orchestrator records to (<git dir>/${LEDGER_BASENAME};
AW_REVIEW_LEDGER overrides), resolves the effective ${ACTIVITY}.${SLOT} recipe, recomputes the
canonical uncommitted-state fingerprint, and computes the crossover-stop decision for the in-flight
plan-execution loop's current SEGMENT — (activity, loop, base = the HEAD commit the dirty tree sits
on; schema v4). Round numbering, caps, and the teeth are per segment; a segment closes only by a
gated commit, so the round-counter reset is earned, never declared.

--status (default) → the human report: resolved recipe, plan-in-flight, per-round tally with
  findings, grouped by segment, the decideStop verdict.
--check → the gate exit code. The normative exit contract lives in the tool header (the single home):
  exit 0 for solo / no plan in flight / a clean tree / not-a-git-tree / a converged or
  resolved-residual in-flight SEGMENT; exit 1 for a dirty non-converged segment, triage-required, a
  segment with no round/receipt recorded, more than one plan in flight, or a receipt inconsistency.
--json → the structured state + decision.
--telemetry → read-only counts across ALL loops and BOTH ledgers (D8): rounds/segments per loop,
  finding origins, classification distribution (incl. refuted), per-backend verdicts + divergence
  rounds, override usage by scope, gate-run counts (quality-green / red-by-gate), fold runs,
  observed-red receipts, quarantined probes. Counts only — interpretation stays with you.

The writer is a SEPARATE tool (review-ledger-write.mjs record/classify/override) — this read-only
checker never imports it. Human residual: git commit --no-verify, ledger-file editing, and forged
counts remain possible — a self-discipline mechanism, not a security boundary.

Exit codes: 0 pass (or plain report); 1 check failed or config error (loud); 2 usage.`;

const KNOWN_ARGS = new Set(['--help', '-h', '--check', '--status', '--json', '--telemetry']);

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const detect = ctx.detect ?? detectBackends;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const unknown = argv.find((a) => !KNOWN_ARGS.has(a));
    if (unknown !== undefined) throw fail(2, `unknown argument: ${unknown}`);
    // --telemetry is a standalone report: combined with --check it would WIN the dispatch and exit
    // 0 without running decideCheck — a silently passing gate cmd (codex R2). Reject mixed modes.
    if (argv.includes('--telemetry') && ['--check', '--status', '--json'].some((a) => argv.includes(a))) {
      throw fail(2, '--telemetry never combines with --check/--status/--json — a mixed-mode invocation would bypass the gate; run them separately');
    }
    if (argv.includes('--telemetry')) {
      const ledgerPath = resolveLedgerPath(cwd, env);
      const { records, malformed, readError } = ledgerPath ? readLedger(ledgerPath) : { records: [], malformed: 0 };
      const foldPath = resolveResultsPath(cwd, env);
      const { rows, badLines, readError: foldReadError } = foldPath ? readJsonlRows(foldPath) : { rows: [], badLines: 0 };
      const telemetry = computeTelemetry(records, rows);
      return { code: 0, stdout: renderTelemetry(telemetry, { records: records.length, malformed, rows: rows.length, badLines, readError, foldReadError }), stderr: '' };
    }
    const state = buildLedgerState({ cwd, env, detect });
    const check = decideCheck(state);
    if (argv.includes('--json')) {
      return { code: argv.includes('--check') ? check.code : 0, stdout: JSON.stringify({ ...state, check }, null, 2), stderr: '' };
    }
    if (argv.includes('--check')) {
      return { code: check.code, stdout: `review-ledger check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`, stderr: '' };
    }
    return { code: 0, stdout: formatHuman(state, check), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `review-ledger: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
