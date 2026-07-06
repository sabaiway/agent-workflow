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
// artifact — filtered to activity==="plan-execution" AND the in-flight plan's filename stem:
//   exit 0  when the resolved plan-execution.review recipe is solo (configured, or degraded there —
//           no reviewer ready); when no plan is in flight (the review-state naming convention);
//           when the tree is clean (nothing to review); when the cwd is not a git work tree; and
//           when the in-flight plan-execution loop is `converged` or `resolved-residual` (its
//           latest round's non-degraded backends carry grounded code receipts for the recorded
//           fingerprint, and a recorded 0/0 is ship-class-consistent with those receipts).
//   exit 1  for any DIRTY in-flight plan-execution loop that is neither `converged` nor
//           `resolved-residual` — `triage-required`, `continue`, OR no round/receipt recorded at
//           all (a dirty active plan with an empty/stale ledger is a FAILURE, not a fail-open pass);
//           when MORE THAN ONE plan is in flight (ambiguous loop id); when a recorded ship-class 0/0
//           coexists with a non-ship receipt verdict, or a non-degraded recorded backend lacks a
//           grounded receipt for its fingerprint. Fail-CLOSED (unknown state, never a fail-open pass)
//           on a detector failure, an unreadable (non-ENOENT) ledger, malformed ledger lines the
//           reader dropped, or a corrupt round sequence (not 1..n) — the only detector-independent
//           green is an EXPLICIT configured solo.
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export const LEDGER_BASENAME = 'agent-workflow-review-ledger.jsonl';
const ACTIVITY = 'plan-execution';
const SLOT = 'review';
// The triage TRIGGER cap (Decision 5): reaching it with an unclassified surviving blocking finding
// forces triage. Shared with the writer (which imports it) — the writer-only hard-max ceiling lives
// there, never here (it is not a decideStop input).
export const REVIEW_CAP = 2;
export const SCHEMA_VERSION = 1;

// The record vocabulary — the single home of every enum the schema validates.
const ACTIVITIES_SET = new Set(['plan-authoring', 'plan-execution']);
const KINDS_SET = new Set(['round', 'triage']);
const SEVERITIES = new Set(['blocker', 'major', 'minor']);
export const ORIGINS = ['first-draft', 'fold-induced', 'mechanics'];
const CLASSES = new Set(['fixable-bug', 'inherent-layer-residual', 'escalate']);

// ── git-dir resolution (read-only queries; the ledger lives in the git dir, uncommittable) ──────

const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

const gitRoot = (cwd) => gitLine(['rev-parse', '--show-toplevel'], cwd);

// The ledger path: AW_REVIEW_LEDGER overrides (mirrors AW_REVIEW_RECEIPTS); else <git dir>/basename.
// null when the cwd is not a git work tree (no git dir to anchor to).
export const resolveLedgerPath = (cwd, env = process.env) => {
  if (env.AW_REVIEW_LEDGER) return env.AW_REVIEW_LEDGER;
  const gitDir = gitLine(['rev-parse', '--absolute-git-dir'], cwd);
  return gitDir == null ? null : join(gitDir, LEDGER_BASENAME);
};

// ── ship-verdict mapping (the single home; a named test pins it) ────────────────────────────────

// isShipVerdict(verdict) — which free-text review verdicts are ship-class. SHIP / SHIP WITH NITS are
// ship; revise / REWORK / unknown / anything else are not. Case-insensitive, trimmed.
export const isShipVerdict = (verdict) => {
  const v = String(verdict ?? '').trim().toLowerCase();
  return v === 'ship' || v === 'ship with nits';
};

// ── schema validation (tolerant reader counts + surfaces malformed lines, never drops silently) ──

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

// validateRound(obj) → { ok, reason }. Structural checks + the two internal-consistency invariants:
// the per-backend findings-by-severity equal that backend's counts, and the origins tally equals the
// aggregation of findings[].origin.
const validateRound = (obj) => {
  if (!isPlainObject(obj.origins)) return { ok: false, reason: 'round: missing origins object' };
  for (const k of ORIGINS) if (!isNonNegInt(obj.origins[k])) return { ok: false, reason: `round: origins.${k} must be a non-negative integer` };
  if (!Array.isArray(obj.backends) || obj.backends.length === 0) return { ok: false, reason: 'round: backends must be a non-empty array' };
  for (const b of obj.backends) {
    if (!isPlainObject(b) || !isNonEmptyString(b.backend)) return { ok: false, reason: 'round: each backend needs a backend name' };
    if (typeof b.degraded !== 'boolean') return { ok: false, reason: `round: backend ${b.backend} missing boolean degraded` };
    if (!isNonNegInt(b.blockers) || !isNonNegInt(b.majors) || !isNonNegInt(b.minors)) return { ok: false, reason: `round: backend ${b.backend} counts must be non-negative integers` };
    if (!isNonEmptyString(b.verdict)) return { ok: false, reason: `round: backend ${b.backend} missing verdict` };
    // A degraded backend ran no real review: it MUST carry a reason, record 0/0/0 counts, and its
    // verdict is exactly "degraded". Without this a degraded row could carry a blocking finding while
    // convergence (which excludes degraded backends) still passes — a hidden-blocker hole (codex R1).
    if (b.degraded === true) {
      if (!isNonEmptyString(b.reason)) return { ok: false, reason: `round: degraded backend ${b.backend} must carry a reason` };
      if (b.blockers !== 0 || b.majors !== 0 || b.minors !== 0) return { ok: false, reason: `round: degraded backend ${b.backend} must record 0/0/0 counts (it ran no real review)` };
      if (b.verdict !== 'degraded') return { ok: false, reason: `round: degraded backend ${b.backend} verdict must be "degraded"` };
    }
  }
  // Duplicate backend names would make entryFor / the per-backend consistency ambiguous (agy R1).
  if (new Set(obj.backends.map((b) => b.backend)).size !== obj.backends.length) return { ok: false, reason: 'round: duplicate backend name in backends[]' };
  if (!Array.isArray(obj.findings)) return { ok: false, reason: 'round: findings must be an array' };
  const backendSet = new Set(obj.backends.map((b) => b.backend));
  const degradedSet = new Set(obj.backends.filter((b) => b.degraded === true).map((b) => b.backend));
  for (const f of obj.findings) {
    if (!isPlainObject(f) || !isNonEmptyString(f.findingKey)) return { ok: false, reason: 'round: each finding needs a findingKey' };
    if (!SEVERITIES.has(f.severity)) return { ok: false, reason: `round: finding ${f.findingKey} bad severity "${f.severity}"` };
    if (!ORIGINS.includes(f.origin)) return { ok: false, reason: `round: finding ${f.findingKey} bad origin "${f.origin}"` };
    if (!isNonEmptyString(f.backend)) return { ok: false, reason: `round: finding ${f.findingKey} missing backend` };
    if (!backendSet.has(f.backend)) return { ok: false, reason: `round: finding ${f.findingKey} backend "${f.backend}" is not in backends[]` };
    if (degradedSet.has(f.backend)) return { ok: false, reason: `round: finding ${f.findingKey} references degraded backend ${f.backend} (a degraded backend ran no review, mints no finding)` };
  }
  // Internal consistency: per-backend findings-by-severity equal the recorded counts.
  for (const b of obj.backends) {
    const own = { blocker: 0, major: 0, minor: 0 };
    for (const f of obj.findings) if (f.backend === b.backend) own[f.severity] += 1;
    if (own.blocker !== b.blockers || own.major !== b.majors || own.minor !== b.minors) {
      return { ok: false, reason: `round: findings-vs-counts mismatch for ${b.backend} (findings ${own.blocker}/${own.major}/${own.minor} ≠ counts ${b.blockers}/${b.majors}/${b.minors})` };
    }
  }
  // Internal consistency: the origins tally equals the aggregation of findings[].origin.
  const tally = { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 };
  for (const f of obj.findings) tally[f.origin] += 1;
  for (const k of ORIGINS) if (tally[k] !== obj.origins[k]) return { ok: false, reason: `round: origins-vs-findings mismatch for "${k}" (findings ${tally[k]} ≠ origins ${obj.origins[k]})` };
  return { ok: true };
};

// validateTriage(obj) → { ok, reason }.
const validateTriage = (obj) => {
  if (!Array.isArray(obj.classifications) || obj.classifications.length === 0) return { ok: false, reason: 'triage: classifications must be a non-empty array' };
  for (const c of obj.classifications) {
    if (!isPlainObject(c) || !isNonEmptyString(c.findingKey)) return { ok: false, reason: 'triage: each classification needs a findingKey' };
    if (!CLASSES.has(c.class)) return { ok: false, reason: `triage: classification ${c.findingKey} bad class "${c.class}"` };
    if (typeof c.accepted !== 'boolean') return { ok: false, reason: `triage: classification ${c.findingKey} missing boolean accepted` };
    // testId "defaults null" (Decision 8) — an ABSENT key is accepted (treated as null), never
    // rejected as malformed (agy R3). The writer normalizes it to null in the stored record.
    if (!(c.testId === undefined || c.testId === null || isNonEmptyString(c.testId))) return { ok: false, reason: `triage: classification ${c.findingKey} testId must be null/absent or a non-empty string` };
    if (typeof c.note !== 'string') return { ok: false, reason: `triage: classification ${c.findingKey} note must be a string` };
  }
  return { ok: true };
};

// validateRecord(obj) → { ok, reason }. The shared frame (schema/loop/activity/kind/round/
// fingerprint/timestamp) then the per-kind body. `reason` names the exact failed check so the
// malformed-line surface and the per-check named tests can assert it.
export const validateRecord = (obj) => {
  if (!isPlainObject(obj)) return { ok: false, reason: 'not an object' };
  if (obj.schema !== SCHEMA_VERSION) return { ok: false, reason: `schema must be ${SCHEMA_VERSION}` };
  if (!isNonEmptyString(obj.loop)) return { ok: false, reason: 'missing loop' };
  if (!ACTIVITIES_SET.has(obj.activity)) return { ok: false, reason: `bad activity "${obj.activity}"` };
  if (!KINDS_SET.has(obj.kind)) return { ok: false, reason: `bad kind "${obj.kind}"` };
  if (!(Number.isInteger(obj.round) && obj.round >= 1)) return { ok: false, reason: 'round must be an integer >= 1' };
  if (!(obj.fingerprint === null || isNonEmptyString(obj.fingerprint))) return { ok: false, reason: 'fingerprint must be null or a non-empty string' };
  if (!isNonEmptyString(obj.timestamp)) return { ok: false, reason: 'missing timestamp' };
  return obj.kind === 'round' ? validateRound(obj) : validateTriage(obj);
};

// readLedger(path) → { records, malformed, malformedReasons }. Absent file → empty (no review ran).
// A malformed line is counted + its reason surfaced, never silently dropped (mirrors readReceipts).
export const readLedger = (path, readFile = readFileSync) => {
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch (err) {
    // An ABSENT file → empty (no review ran). A non-ENOENT read error (EACCES/EIO) is NOT "no records":
    // treating it as empty would fail the teeth OPEN and could clobber the ledger on rewrite (codex R1).
    // Surface it as a readError so every caller (the writer, the gate) fails CLOSED.
    if (err && err.code === 'ENOENT') return { records: [], malformed: 0, malformedReasons: [] };
    return { records: [], malformed: 0, malformedReasons: [], readError: (err && err.code) || (err && err.message) || 'read failed' };
  }
  const records = [];
  const malformedReasons = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      malformedReasons.push(`unparseable JSON (${err.message})`);
      continue;
    }
    const v = validateRecord(parsed);
    if (v.ok) records.push(parsed);
    else malformedReasons.push(v.reason);
  }
  return { records, malformed: malformedReasons.length, malformedReasons };
};

// filterLoopRecords(records, { activity, loop }) → the records of ONE loop (both kinds), order
// preserved. The gate filters to activity==="plan-execution" AND loop===the in-flight plan stem;
// authoring rounds (and other plans' rounds) never enter the code gate.
export const filterLoopRecords = (records, { activity, loop }) =>
  records.filter((r) => r.activity === activity && r.loop === loop);

// roundSequenceIntact(records) → true iff the round records, in file order, number exactly 1,2,…,n
// (no duplicate, gap, or out-of-order round). Checks the EXISTING sequence, not just the incoming
// round: a ledger like [2] / [1,1] / [2,1] (reachable only by hand-editing the git-dir file — the
// stated residual) must fail closed rather than be trusted to compute the "latest" round (codex R3).
export const roundSequenceIntact = (records) => {
  const nums = records.filter((r) => r.kind === 'round').map((r) => r.round);
  return nums.every((n, i) => n === i + 1);
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
  const isResolvedClass = (c) => c && (c.class === 'inherent-layer-residual' || (c.class === 'escalate' && c.accepted === true));

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
  const ledgerPath = resolveLedgerPath(cwd, env);
  const { records, malformed, malformedReasons, readError } = ledgerPath ? readLedger(ledgerPath) : { records: [], malformed: 0, malformedReasons: [] };
  const receiptsPath = resolveReceiptsPath(cwd, env);
  const { receipts } = receiptsPath ? readReceipts(receiptsPath) : { receipts: [] };
  return { resolved, requiredBackends, plans, fingerprint, clean, ledgerPath, records, malformed, malformedReasons, readError, receipts, receiptsPath, detectionWarning };
};

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
  const filtered = filterLoopRecords(state.records, { activity: ACTIVITY, loop });
  const rounds = filtered.filter((r) => r.kind === 'round');
  // A dirty active plan with NO round recorded is a FAILURE, not a fail-open pass (codex R2 hole).
  if (rounds.length === 0) {
    return { code: 1, reason: `dirty plan-execution loop "${loop}" but no review round recorded — record the current round` };
  }
  // A corrupt round sequence (not 1..n) is unknown state → fail closed rather than trust "latest" (codex R3).
  if (!roundSequenceIntact(rounds)) return { code: 1, reason: `the round sequence for "${loop}" is corrupt (not 1..n) — failing closed; inspect ${state.ledgerPath}` };
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

const formatHuman = (state, check) => {
  const lines = [
    `review-ledger — ${ACTIVITY}.${SLOT} = ${state.resolved.recipe} (${state.resolved.source === 'config' ? `from ${CONFIG_REL}` : 'computed default'})${state.requiredBackends.length ? ` → ${state.requiredBackends.join(' + ')}` : ''}`,
  ];
  if (state.detectionWarning) lines.push(`  ⚠ ${state.detectionWarning}`);
  lines.push(`  plan in flight: ${state.plans.length ? state.plans.join(', ') : '(none)'}`);
  if (state.fingerprint == null) lines.push('  tree: not a git work tree');
  else if (state.clean === true) lines.push('  tree: clean (nothing to review)');
  else lines.push(`  tree fingerprint: ${state.fingerprint}`);
  lines.push(`  ledger: ${state.ledgerPath ?? '(unresolvable — no git dir)'} (${state.records.length} record(s)${state.malformed ? `, ${state.malformed} malformed — inspect the file` : ''})`);
  if (state.plans.length === 1) {
    const loop = state.plans[0].replace(/\.md$/, '');
    const forLoop = filterLoopRecords(state.records, { activity: ACTIVITY, loop });
    for (const r of forLoop) lines.push(r.kind === 'round' ? roundLine(r) : triageLine(r));
  }
  lines.push(`  check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`);
  return lines.join('\n');
};

const HELP = `review-ledger — read-only review-round LEDGER checker (agent-workflow family, AD-045).

Usage:
  node review-ledger.mjs [--check | --status | --json]

Reads the review-round ledger the orchestrator records to (<git dir>/${LEDGER_BASENAME};
AW_REVIEW_LEDGER overrides), resolves the effective ${ACTIVITY}.${SLOT} recipe, recomputes the
canonical uncommitted-state fingerprint, and computes the crossover-stop decision for the in-flight
plan-execution loop (decideStop → converged / resolved-residual / triage-required / continue).

--status (default) → the human report: resolved recipe, plan-in-flight, per-round tally with
  findings, per-backend, the decideStop verdict.
--check → the gate exit code. The normative exit contract lives in the tool header (the single home):
  exit 0 for solo / no plan in flight / a clean tree / not-a-git-tree / a converged or
  resolved-residual in-flight loop; exit 1 for a dirty non-converged loop, triage-required, a loop
  with no round/receipt recorded, more than one plan in flight, or a receipt inconsistency.
--json → the structured state + decision.

The writer is a SEPARATE tool (review-ledger-write.mjs record/classify) — this read-only checker
never imports it. Human residual: git commit --no-verify, ledger-file editing, and forged counts
remain possible — a self-discipline mechanism, not a security boundary.

Exit codes: 0 pass (or plain report); 1 check failed or config error (loud); 2 usage.`;

const KNOWN_ARGS = new Set(['--help', '-h', '--check', '--status', '--json']);

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const detect = ctx.detect ?? detectBackends;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const unknown = argv.find((a) => !KNOWN_ARGS.has(a));
    if (unknown !== undefined) throw fail(2, `unknown argument: ${unknown}`);
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
