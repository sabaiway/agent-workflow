#!/usr/bin/env node
// review-ledger-write.mjs — the SOLE filesystem WRITER for the review-round ledger (AD-045). It is
// the write half of the family read/write split (mirrors orchestration-config.mjs /
// orchestration-write.mjs): review-ledger.mjs (schema + read + decideStop + --check) is read-only and
// NEVER imports this module; an import-split test pins that. This module imports the read core the
// OTHER direction (the schema + decideStop + the tolerant reader) and appends records through the
// shared hardened atomic-write core (tools/atomic-write.mjs — exclusive-create tmp + rename, TOCTOU
// re-check, symlink STOPs). The ledger lives in the git dir (uncommittable by construction).
//
// Record kinds, one JSONL ledger. Every verb evaluates the current SEGMENT — (activity, loop,
// base = `git rev-parse HEAD`), BUGFREE-2 / AD-048 D1: round numbering, the caps, and every tooth
// are per segment; a segment closes only through a gated commit, so a counter reset is earned:
//   recordRound   — one review round: per-backend counts + verdict + degraded, finding-origin tally,
//                   findings[]. Binds to the canonical tree fingerprint + base. THE TEETH (Decision 5
//                   + AD-048): REFUSES (typed STOP) while decideStop on the segment's records is
//                   `triage-required`; refuses ANY round beyond the per-segment hard-max ceiling
//                   unconditionally; refuses while a blocking finding of the segment's previous
//                   round VANISHED unclassified (D6 — no-repro-no-fold; `refuted` is the honest
//                   phantom lane); refuses while the changed source surface exceeds the diff cap
//                   without a recorded segment size-cap override (D4). Integrity binding (Decision 7):
//                   each NON-degraded backend needs a grounded code receipt for the current tree, so a
//                   round cannot be recorded for a tree no bridge reviewed.
//   recordTriage  — the classification that BREAKS the deadlock: each surviving blocking finding of a
//                   SEGMENT round classified fixable-bug / inherent-layer-residual / escalate /
//                   refuted (v4). No teeth (a triage is exactly what lets the next round proceed),
//                   no receipt binding (it reviews nothing).
//
// HONEST residual (stated, accepted — like review-state's): the ledger attests a review occurred; it
// does NOT prove the recorded COUNTS are truthful nor that a self-reported `degraded:true` is real.
// A self-discipline mechanism against silent process drift, not a security boundary.
//
// Dependency-free, Node >= 18. Every fs primitive is injectable (deps.*) so the guards are unit-
// testable. No side effects on import (the isDirectRun idiom).

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { buildState, computeTreeFingerprint, plansInFlight, readReceipts, resolveReceiptsPath } from './review-state.mjs';
import {
  REVIEW_CAP,
  SCHEMA_VERSION,
  resolveLedgerPath,
  resolveBase,
  readLedger,
  filterSegmentRecords,
  collectSizeCapLimit,
  isQualityGreenGateRun,
  roundSequenceIntact,
  decideStop,
  validateRecord,
} from './review-ledger.mjs';
// The NEUTRAL shared changed-surface computation (BUGFREE-2 / D4): the D4 diff-cap and the
// fold-completeness coverage gate consume ONE computation, so they can never drift. The writer
// imports the NEUTRAL module, never the runner (the sole-tree-toucher boundary, codex R2 — an
// import-split test pins that this file never imports fold-completeness-run.mjs).
import { computeChangedSurface, countCapLines, parsePositiveIntKnob } from './changed-surface.mjs';

// The absolute WRITER ceiling (Decision 5): hard-max lives ONLY here — it is NOT a decideStop input.
// Even a fully-classified resolved-residual loop cannot reach a round beyond this. Since AD-048 it
// is scoped per SEGMENT (D3 — value unchanged, scope corrected): round numbers restart when a gated
// commit moves base, so a multiphase plan records fully while round 4 within ONE segment stays
// refused — that ceiling is the point (the 2026-06-30 six-round incident class).
export const HARD_MAX = 3;
// The D4 diff-size review cap (default 400 changed source lines; AW_REVIEW_DIFF_CAP overrides
// through the shared fail-closed positive-integer parser). Counted classes are pinned in
// changed-surface.mjs: assessable + unsupported SOURCE lines count; tests and out-of-domain never
// do; pure deletions are free.
export const DEFAULT_DIFF_CAP = 400;
const DEFAULT_ACTIVITY = 'plan-execution';

// A typed STOP — a deliberate refusal we surface (the teeth / a malformed record / a missing
// receipt), distinct from a native fs error. The codebase's typed-error idiom (no classes).
export const LEDGER_WRITE_STOP = 'LEDGER_WRITE_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'LedgerWriteStop', code: LEDGER_WRITE_STOP });

// A tagged usage failure (exit 2) for the CLI parser.
const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });

const isoNow = () => new Date().toISOString();

// ── the append primitive (whole-file read → add one JSONL line → atomic rewrite) ────────────────
// The ledger is a git-dir JSONL, never a docs/ai file, so the append reads the current file, adds the
// new line in memory, and rewrites through the contained-write core (root = the ledger file's dir).
const appendRecord = (ledgerPath, record, deps = {}) => {
  const readFile = deps.readFile ?? readFileSync;
  let existing = '';
  try {
    existing = readFile(ledgerPath, 'utf8');
  } catch (err) {
    // Only a truly-absent file starts from empty. A non-ENOENT read failure (EACCES/EIO) must NOT be
    // treated as "no file" — rewriting from empty would DESTROY the existing ledger (codex R1).
    if (err && err.code === 'ENOENT') existing = '';
    else throw stop(`cannot read the ledger before appending (${(err && err.code) || (err && err.message) || err}) — refusing to overwrite it (fail closed)`);
  }
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  const body = `${prefix}${JSON.stringify(record)}\n`;
  const root = dirname(ledgerPath);
  writeContainedFileAtomic(root, ledgerPath, body, deps, { stop, label: ledgerPath });
  return { writtenPath: ledgerPath, record };
};

// ── (g) record --from-receipts: draft the backends[] from the current-fingerprint receipts ────────
// (BUGFREE-3 / AD-049). The orchestrator hand-maintained each backend's { backend, verdict } beside
// the counts every round — drift-prone busywork. --from-receipts DRAFTS the backends[] instead: for
// each recipe-named backend it reads the review-state receipt status (verdict from the fresh grounded
// code receipt) and computes the counts from the orchestrator's OWN supplied findings; `origins` and
// `findings` stay explicit input. It NEVER invents a backend — a recipe-named backend with no fresh
// grounded receipt is a LOUD STOP (run its review, or supply it explicitly as a degraded backend).
// The assembled backends[] then rides the normal recordRound teeth (validateRound re-checks that
// findings-by-severity equals the drafted counts — true by construction).
export const draftBackendsFromReceipts = ({ state, findings = [], explicitBackends = [] }, deps = {}) => {
  const stopFn = deps.stop ?? stop;
  const explicitByName = new Map((Array.isArray(explicitBackends) ? explicitBackends : []).filter((b) => b && typeof b.backend === 'string').map((b) => [b.backend, b]));
  const findingsArr = Array.isArray(findings) ? findings : [];
  const countFor = (name) => {
    const own = findingsArr.filter((f) => f && f.backend === name);
    return {
      blockers: own.filter((f) => f.severity === 'blocker').length,
      majors: own.filter((f) => f.severity === 'major').length,
      minors: own.filter((f) => f.severity === 'minor').length,
    };
  };
  return state.requiredBackends.map((name) => {
    const explicit = explicitByName.get(name);
    if (explicit) {
      // An explicit row is honored verbatim ONLY for a DEGRADED backend (a bridge the operator knows
      // is down, which minted no receipt). A NON-degraded explicit row would BYPASS the
      // receipt-derived verdict --from-receipts exists to compute (a stale hand-composed row silently
      // winning) — a loud STOP, fail-closed (codex council R1). Drop --from-receipts to compose a
      // non-degraded row by hand, or mark the backend degraded.
      if (explicit.degraded !== true) {
        throw stopFn(
          `refusing --from-receipts: an explicit non-degraded backends[] row for ${name} would bypass the receipt-derived verdict this flag computes — mark it degraded (a bridge that is down), or drop --from-receipts and compose the round by hand`,
        );
      }
      return explicit;
    }
    const status = state.backends.find((b) => b.backend === name);
    if (!status || status.state !== 'current') {
      throw stopFn(
        `refusing --from-receipts: no fresh grounded code receipt for ${name} (state: ${status?.state ?? 'missing'}) — run its review wrapper (codex-review code / agy-review code --facts @f) first, or supply it explicitly as a degraded backend in the payload's backends[]`,
      );
    }
    return { backend: name, degraded: false, ...countFor(name), verdict: status.verdict };
  });
};

// ── recordRound (the teeth + the integrity binding) ─────────────────────────────────────────────

// recordRound({ cwd, env, loop, activity, round, origins, backends, findings, timestamp }, deps) →
// { writtenPath, record }. THROWS a typed STOP (the teeth / a malformed record / a missing receipt)
// or a native fs error. Every fs edge + the fingerprint is injectable for hermetic tests.
export const recordRound = (params, deps = {}) => {
  const { cwd = process.cwd(), env = process.env, loop, activity = DEFAULT_ACTIVITY, round, origins, backends, findings, timestamp } = params;
  const ledgerPath = deps.ledgerPath ?? resolveLedgerPath(cwd, env);
  if (ledgerPath == null) throw stop('cannot resolve the ledger path — not a git work tree and AW_REVIEW_LEDGER is unset');
  if (!(Number.isInteger(round) && round >= 1)) throw stop(`round must be an integer >= 1 (got ${round})`);
  // The hard-max ceiling: refuse ANY round beyond it, independent of triage state (Decision 5).
  // Per SEGMENT since AD-048 (D3): the round number is the segment round number.
  if (round > HARD_MAX) {
    throw stop(`refusing to record round ${round}: beyond the hard-max ceiling of ${HARD_MAX} rounds within one segment — the segment must converge (or its surviving finding escalate) and ship through a gated commit; the counter resets only at the commit boundary, never by declaration`);
  }

  const fingerprint = deps.computeFingerprint ? deps.computeFingerprint(cwd) : computeTreeFingerprint(cwd);
  const base = deps.resolveBase ? deps.resolveBase(cwd) : resolveBase(cwd);

  // The teeth: refuse a new round WHILE decideStop on the existing records is triage-required. Once
  // the surviving blocking finding is classified (recordTriage), decideStop is no longer
  // triage-required and the next round is permitted (a fixable-bug classification permits the fix
  // round — no deadlock). triage-required is fingerprint/backend-independent, so a minimal decideStop
  // suffices here.
  const { records, malformed, malformedReasons, readError } = readLedger(ledgerPath, deps.readFile);
  // Fail CLOSED before the teeth: a ledger the reader could not fully trust (an unreadable file, or
  // malformed lines the reader dropped) could make decideStop miss a triage-required round and fail
  // the teeth OPEN (codex R1). Refuse to append until the ledger is sound.
  if (readError) throw stop(`cannot read the existing ledger (${readError}) — refusing to append (fail closed)`);
  if (malformed > 0) throw stop(`the existing ledger has ${malformed} malformed line(s) — refusing to append until they are fixed (fail closed): ${malformedReasons.join('; ')}`);
  // EVERY tooth below evaluates the current SEGMENT (activity, loop, base) — D1: records of earlier
  // segments (other bases, or pre-v4 records with no base) are closed history; the field-proven
  // 11-round / 4-base loop records completely while round 4 within ONE segment stays refused.
  const segment = filterSegmentRecords(records, { activity, loop, base });
  // Sequence integrity + sequentiality (codex R2+R3): the EXISTING segment rounds must already be
  // exactly 1..n (never trust a hand-corrupted [2]/[1,1]/[2,1] to compute "latest"), AND the
  // incoming round must be exactly the next (n+1). A duplicate, decreasing, or gapped round would
  // let a fabricated "later" round become the latest that decideStop reads, bypassing the teeth.
  const priorRounds = segment.filter((r) => r.kind === 'round').map((r) => r.round);
  if (!roundSequenceIntact(segment)) {
    throw stop(`refusing to append to loop "${loop}": its recorded round sequence for the current segment is corrupt (${priorRounds.join(',') || 'empty'}, not 1..n) — fix the ledger by hand before recording another round`);
  }
  const nextRound = priorRounds.length + 1;
  if (round !== nextRound) {
    throw stop(`refusing to record round ${round}: rounds must be sequential within the segment — the next round for loop "${loop}" at the current base is ${nextRound} (a duplicate, out-of-order, or gapped round would corrupt the crossover computation)`);
  }
  const pre = decideStop(segment, { cap: REVIEW_CAP });
  if (pre.state === 'triage-required') {
    throw stop(`refusing to record a new round while triage is required — ${pre.reason}. Classify the surviving blocking finding(s) with the "classify" command first (a fixable-bug classification permits the fix round).`);
  }

  // D6 — no-repro-no-fold: no blocking finding of the segment's previous round may VANISH
  // unclassified. Present-again is fine (still live); classified is fine (fixable-bug folded with
  // its red→green testId at the round it was folded — late binding restored; inherent-layer-residual
  // documented; escalate handed over; refuted — the honest phantom lane, grounds mandatory). A
  // silent disappearance is exactly the sycophancy hole this pillar closes. Minors stay exempt.
  const previous = segment.find((r) => r.kind === 'round' && r.round === nextRound - 1);
  if (previous) {
    // "Present" means present AS BLOCKING: a blocker/major re-reported as a minor did not survive —
    // it was softened, and the silent-soften lane is exactly the bypass D6 closes (codex R1).
    const incoming = new Set(
      Array.isArray(findings)
        ? findings.filter((f) => f && (f.severity === 'blocker' || f.severity === 'major')).map((f) => f.findingKey)
        : [],
    );
    // A classification CLEARS the vanish only when it actually resolves the finding's fate:
    // fixable-bug (folded, testId bound), inherent-layer-residual (documented), refuted (grounds
    // cited), or an ACCEPTED escalate — a pending escalate (accepted:false) is still undecided and
    // must not disappear into a clean round (codex R1).
    const clearsVanish = (c) =>
      c.class === 'fixable-bug' || c.class === 'inherent-layer-residual' || c.class === 'refuted' || (c.class === 'escalate' && c.accepted === true);
    const classified = new Set();
    for (const t of segment) {
      if (t.kind === 'triage' && t.round === previous.round) for (const c of t.classifications) if (clearsVanish(c)) classified.add(c.findingKey);
    }
    const vanished = [...new Set(
      previous.findings
        .filter((f) => f.severity === 'blocker' || f.severity === 'major')
        .map((f) => f.findingKey)
        .filter((k) => !incoming.has(k) && !classified.has(k)),
    )];
    if (vanished.length > 0) {
      throw stop(`refusing to record round ${round}: blocking finding(s) of round ${previous.round} vanished without a classification: ${vanished.join(', ')} (D6 — no blocking finding disappears silently). Classify each with the "classify" command first: fixable-bug (bind the red→green testId), inherent-layer-residual, escalate, or refuted (a phantom finding — cite the refuting grounds in note).`);
    }
  }

  // D4 — the diff-size cap over the ONE shared changed-surface computation (changed-surface.mjs):
  // a round is refused while the changed source surface exceeds the cap, unless the SEGMENT carries
  // a recorded size-cap override sanctioning at least the counted magnitude. Subtractive folds are
  // free (new-side lines only); tests and out-of-domain files never count.
  const cap = parsePositiveIntKnob(env, 'AW_REVIEW_DIFF_CAP', DEFAULT_DIFF_CAP, stop);
  const counted = deps.countChangedLines ? deps.countChangedLines(cwd) : countCapLines(computeChangedSurface(gitRoot(cwd) ?? cwd));
  if (counted > cap) {
    const sanctioned = collectSizeCapLimit(records, { activity, loop, base });
    if (sanctioned === null || counted > sanctioned) {
      throw stop(
        `refusing to record round ${round}: the changed source surface is ${counted} lines — over the ${cap}-line review cap (AW_REVIEW_DIFF_CAP)${sanctioned !== null ? ` and over the segment's recorded size-cap sanction of ${sanctioned}` : ''}. ` +
          `Split the change into reviewable units (commit a converged part first), or record the LOUD waiver: node review-ledger-write.mjs override --json '{"loop":"${loop}","round":${round},"scope":"size-cap","sanctionedLines":${counted},"reason":"<why this surface must review as one unit>"}'`,
      );
    }
  }

  const record = { schema: SCHEMA_VERSION, loop, activity, kind: 'round', round, base, fingerprint, origins, backends, findings, timestamp: timestamp ?? isoNow() };
  const v = validateRecord(record);
  if (!v.ok) throw stop(`refusing to record a malformed round: ${v.reason}`);

  // Integrity binding: each NON-degraded backend needs a grounded code receipt for this tree — a
  // round cannot be recorded for a tree no bridge reviewed. A degraded backend minted no receipt.
  const receiptsPath = deps.receiptsPath ?? resolveReceiptsPath(cwd, env);
  const { receipts } = receiptsPath ? readReceipts(receiptsPath, deps.readFile) : { receipts: [] };
  for (const b of backends) {
    if (b.degraded) continue;
    const own = receipts.filter(
      (r) => r.backend === b.backend && r.fingerprint === fingerprint && r.artifact === 'code' && r.fresh === true && r.grounded === true,
    );
    if (own.length === 0) {
      throw stop(`refusing to record a round for ${b.backend}: no grounded code receipt for the current tree — run its review wrapper (codex-review code / agy-review code --facts @f) first, or mark the backend degraded with a reason`);
    }
  }

  // D5 — the green-baseline tooth (armed at Step 2.3, AFTER run-gates --record exists — the
  // bootstrap order): a round records only over a tree whose FULL declared non-process gate set
  // was proven green by a recorded gate-run at the CURRENT fingerprint. "Gates ran before review"
  // is now computed, never remembered. A `--only` subset is recorded honestly but never satisfies
  // this (the R1 converged subset-bypass hole); a run whose tree changed under it attests no
  // particular tree (codex R2); process-gate failures never block (the closed carve-out).
  const gateRuns = segment.filter((r) => r.kind === 'gate-run');
  if (!gateRuns.some((g) => g.fingerprint === fingerprint && isQualityGreenGateRun(g))) {
    throw stop(`refusing to record round ${round}: no quality-green gate-run for the current tree in this segment (D5 — gates run before review is computed, not remembered). Run the FULL declared matrix with a recorded receipt first: node agent-workflow-kit/tools/run-gates.mjs --record (a --only subset never satisfies this; a run whose tree changed under it never counts).`);
  }

  return appendRecord(ledgerPath, record, deps);
};

// ── recordGateRun (BUGFREE-2 / AD-048, D5 — the green-baseline receipt run-gates --record mints) ──

// recordGateRun({ cwd, env, activity, declared, results, summary, fingerprintBefore,
// fingerprintAfter, timestamp }, deps) → { writtenPath, record }. The SOLE ledger entry point for
// run-gates (`--record` DELEGATES here — the runner never opens the ledger file itself; an
// import/structure pin holds the boundary). The loop is DERIVED from the single in-flight plan
// (the recordOverride precedent — a gate-run is minted only inside its live loop, never
// retro-recorded); the record carries the segment frame and NO round number (per-kind frame, D5).
// A red run records honestly (telemetry fuel — consecutive red gate-runs are the revert-first
// visibility); quality-green is judged at read time, never stored.
export const recordGateRun = (params, deps = {}) => {
  const { cwd = process.cwd(), env = process.env, activity = DEFAULT_ACTIVITY, declared, results, summary, fingerprintBefore, fingerprintAfter, timestamp } = params;
  const ledgerPath = deps.ledgerPath ?? resolveLedgerPath(cwd, env);
  if (ledgerPath == null) throw stop('cannot resolve the ledger path — not a git work tree and AW_REVIEW_LEDGER is unset');
  const plans = deps.plansInFlight ? deps.plansInFlight() : plansInFlight(gitRoot(cwd) ?? cwd);
  if (plans.length !== 1) {
    throw stop(`refusing to record a gate-run: it is minted only inside the SINGLE in-flight loop (in flight: ${plans.length ? plans.join(', ') : 'none'})`);
  }
  const loop = plans[0].replace(/\.md$/, '');
  const base = deps.resolveBase ? deps.resolveBase(cwd) : resolveBase(cwd);
  const record = {
    schema: SCHEMA_VERSION, loop, activity, kind: 'gate-run', base,
    fingerprint: fingerprintBefore, fingerprintAfter, declared, results, summary,
    timestamp: timestamp ?? isoNow(),
  };
  const v = validateRecord(record);
  if (!v.ok) throw stop(`refusing to record a malformed gate-run: ${v.reason}`);
  const { records, malformed, malformedReasons, readError } = readLedger(ledgerPath, deps.readFile);
  if (readError) throw stop(`cannot read the existing ledger (${readError}) — refusing to append (fail closed)`);
  if (malformed > 0) throw stop(`the existing ledger has ${malformed} malformed line(s) — refusing to append until they are fixed (fail closed): ${malformedReasons.join('; ')}`);
  if (!roundSequenceIntact(filterSegmentRecords(records, { activity, loop, base }))) {
    throw stop(`refusing to record a gate-run for loop "${loop}": its recorded round sequence for the current segment is corrupt (not 1..n) — fix the ledger by hand first`);
  }
  return appendRecord(ledgerPath, record, deps);
};

// ── recordOverride (BUGFREE-1 / AD-047, D3/D7 — the loud, recorded waiver) ──────────────────────

// A read-only git-root probe for the in-flight tooth (the writer's only other git query is inside
// computeTreeFingerprint).
const gitRoot = (cwd) => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

// recordOverride({ cwd, env, loop, activity, round, scope, files, testId, reason, timestamp }, deps)
// → { writtenPath, record }. Standard teeth: field validation via the schema (exact per-scope
// payloads), fail-closed ledger read, and the IN-FLIGHT tooth — an override is a waiver, minted only
// inside its live loop, never retro-recorded for a finished or foreign one. The fold-completeness
// gate matches on loop + payload, never on the (audit-only) fingerprint.
export const recordOverride = (params, deps = {}) => {
  const { cwd = process.cwd(), env = process.env, loop, activity = DEFAULT_ACTIVITY, round, scope, files, testId, sanctionedLines, reason, timestamp } = params;
  const ledgerPath = deps.ledgerPath ?? resolveLedgerPath(cwd, env);
  if (ledgerPath == null) throw stop('cannot resolve the ledger path — not a git work tree and AW_REVIEW_LEDGER is unset');
  if (!(Number.isInteger(round) && round >= 1)) throw stop(`round must be an integer >= 1 (got ${round})`);
  // Exactly ONE in-flight plan, and it must be the named loop (codex+agy R5): a waiver minted while
  // multiple plans are active could later cover a now-single loop — the ambiguity the rest of the
  // family refuses everywhere (the single-plan rule).
  const plans = deps.plansInFlight ? deps.plansInFlight() : plansInFlight(gitRoot(cwd) ?? cwd);
  if (plans.length !== 1 || plans[0] !== `${loop}.md`) {
    throw stop(`refusing to record an override for loop "${loop}": an override is minted only inside its SINGLE in-flight loop (in flight: ${plans.length ? plans.join(', ') : 'none'})`);
  }
  const fingerprint = deps.computeFingerprint ? deps.computeFingerprint(cwd) : computeTreeFingerprint(cwd);
  const base = deps.resolveBase ? deps.resolveBase(cwd) : resolveBase(cwd);
  const record = {
    schema: SCHEMA_VERSION, loop, activity, kind: 'override', round, base, fingerprint, scope,
    ...(files !== undefined ? { files } : {}), ...(testId !== undefined ? { testId } : {}),
    ...(sanctionedLines !== undefined ? { sanctionedLines } : {}),
    reason, timestamp: timestamp ?? isoNow(),
  };
  const v = validateRecord(record);
  if (!v.ok) throw stop(`refusing to record a malformed override: ${v.reason}`);
  const { records, malformed, malformedReasons, readError } = readLedger(ledgerPath, deps.readFile);
  if (readError) throw stop(`cannot read the existing ledger (${readError}) — refusing to append (fail closed)`);
  if (malformed > 0) throw stop(`the existing ledger has ${malformed} malformed line(s) — refusing to append until they are fixed (fail closed): ${malformedReasons.join('; ')}`);
  if (!roundSequenceIntact(filterSegmentRecords(records, { activity, loop, base }))) {
    throw stop(`refusing to record an override for loop "${loop}": its recorded round sequence for the current segment is corrupt (not 1..n) — fix the ledger by hand first`);
  }
  return appendRecord(ledgerPath, record, deps);
};

// ── recordTriage (the deadlock-breaker — no teeth, no receipt binding) ──────────────────────────

// recordTriage({ cwd, env, loop, activity, round, classifications, timestamp }, deps) →
// { writtenPath, record }. Appends the classification of the round's surviving blocking findings.
export const recordTriage = (params, deps = {}) => {
  const { cwd = process.cwd(), env = process.env, loop, activity = DEFAULT_ACTIVITY, round, classifications, timestamp } = params;
  const ledgerPath = deps.ledgerPath ?? resolveLedgerPath(cwd, env);
  if (ledgerPath == null) throw stop('cannot resolve the ledger path — not a git work tree and AW_REVIEW_LEDGER is unset');
  if (!(Number.isInteger(round) && round >= 1)) throw stop(`round must be an integer >= 1 (got ${round})`);
  const fingerprint = deps.computeFingerprint ? deps.computeFingerprint(cwd) : computeTreeFingerprint(cwd);
  const base = deps.resolveBase ? deps.resolveBase(cwd) : resolveBase(cwd);
  // Normalize each classification: an absent testId → null, an absent note → '' — an absent optional
  // field is FILLED, never rejected as malformed (agy R3). Under schema v2 (M2/AD-046) a fixable-bug
  // normalized to a null testId then FAILS validateRecord below (a typed STOP naming the rule + the
  // red-test-first fix) — the test-per-fold binding rides the existing validate path; a `refuted`
  // classification normalized to an empty note fails the same way (D6 — the grounds are mandatory).
  // A non-array is left as-is for validateRecord to reject with a typed STOP (never a raw .map TypeError).
  const normalized = Array.isArray(classifications) ? classifications.map((c) => ({ ...c, testId: c?.testId ?? null, note: c?.note ?? '' })) : classifications;
  const record = { schema: SCHEMA_VERSION, loop, activity, kind: 'triage', round, base, fingerprint, classifications: normalized, timestamp: timestamp ?? isoNow() };
  const v = validateRecord(record);
  if (!v.ok) throw stop(`refusing to record a malformed triage: ${v.reason}`);

  // Bind the triage to a REAL round of the current SEGMENT: the referenced round must exist there
  // and every classified findingKey must be a surviving blocking finding (blocker or major) of THAT
  // round — a classification for a nonexistent/future/other-segment round, or for a key the round
  // never raised, must not satisfy resolved-residual downstream (codex R1; D1 — a committed
  // segment's rounds are closed, the cross-segment lane is the D7 red-proof override). Fail CLOSED
  // on an unreadable / malformed ledger.
  const { records, malformed, malformedReasons, readError } = readLedger(ledgerPath, deps.readFile);
  if (readError) throw stop(`cannot read the existing ledger (${readError}) — refusing to append (fail closed)`);
  if (malformed > 0) throw stop(`the existing ledger has ${malformed} malformed line(s) — refusing to append until they are fixed (fail closed): ${malformedReasons.join('; ')}`);
  const segment = filterSegmentRecords(records, { activity, loop, base });
  if (!roundSequenceIntact(segment)) throw stop(`refusing to classify loop "${loop}": its recorded round sequence for the current segment is corrupt (not 1..n) — fix the ledger by hand first`);
  const targetRound = segment.find((r) => r.kind === 'round' && r.round === round);
  if (!targetRound) throw stop(`refusing to classify round ${round} of loop "${loop}": no such recorded round in the current segment — classify a round that exists at the current base`);
  const survivingKeys = new Set(targetRound.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major').map((f) => f.findingKey));
  for (const c of classifications) {
    if (!survivingKeys.has(c.findingKey)) throw stop(`refusing to classify "${c.findingKey}": it is not a surviving blocking finding of round ${round} (classify only that round's blockers/majors)`);
  }

  return appendRecord(ledgerPath, record, deps);
};

// ── batch (D4/D5 — one invocation applies an ordered list of record/classify/override ops) ────────
// The prompt-economy lane (WRITER-BURST-BATCH): the ledger triad a records stage would otherwise
// fire one writer call at a time — records, classifications, overrides — rides ONE `batch`
// invocation. Every op runs the SAME single-verb code path (no forked validator, D4), so a batch of
// N ops is record-equivalent to the same N single-verb invocations. TWO passes (D5): pass 1
// validates the WHOLE envelope structurally with ZERO writes (a bad envelope stops before any op
// runs); pass 2 applies the ops sequentially — a DOMAIN failure (a tooth, a missing receipt, a
// malformed record) stops the batch with an honest report, and the ops already applied stay recorded
// (the ledger is append-only — no rollback pretense).

// The verbs a batch operation may carry — the SAME functions the single verbs dispatch.
const BATCH_VERBS = new Set(['record', 'classify', 'override']);

// Pass 1 — structural envelope validation, ZERO writes (a usage failure, exit 2). Deep per-op payload
// validity is NOT checked here (that is pass 2's single-verb code path — checking it here would fork
// the validator); pass 1 proves only the envelope shape + a known verb per op, so no raw TypeError
// and no silent success reaches pass 2.
export const validateBatchEnvelope = (payload) => {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw usageFail('batch payload must be an object of the form { "operations": [ … ] }');
  }
  const operations = payload.operations;
  if (!Array.isArray(operations)) throw usageFail('batch payload.operations must be an array of operations');
  if (operations.length === 0) throw usageFail('batch payload.operations is empty — nothing to record');
  operations.forEach((op, i) => {
    if (op == null || typeof op !== 'object' || Array.isArray(op)) {
      throw usageFail(`batch operation [${i}] must be an object of the form { "verb": …, … }`);
    }
    if (!BATCH_VERBS.has(op.verb)) {
      throw usageFail(`batch operation [${i}] names an unknown verb "${op.verb}" (expected: record | classify | override)`);
    }
    // The batch resolves cwd/env from the INVOCATION, never per operation — a per-op override could
    // read one project's state and write another's ledger. Reject it loudly.
    for (const forbidden of ['cwd', 'env']) {
      if (forbidden in op) {
        throw usageFail(`batch operation [${i}] carries a "${forbidden}" field — the batch resolves cwd/env from the invocation, never per operation`);
      }
    }
    // fromReceipts must be a real boolean: a string "false" is truthy and would silently enable the
    // draft. Reject any non-boolean when the field is present.
    if ('fromReceipts' in op && typeof op.fromReceipts !== 'boolean') {
      throw usageFail(`batch operation [${i}] has a non-boolean fromReceipts (${JSON.stringify(op.fromReceipts)}) — it must be the literal true or false`);
    }
    if ('fromReceipts' in op && op.verb !== 'record') {
      throw usageFail(`batch operation [${i}] sets fromReceipts on "${op.verb}" — it applies only to record (even the literal false does not belong here)`);
    }
  });
  return operations;
};

// Apply ONE operation through the SAME single-verb code path main() dispatches (including the
// --from-receipts backends[] draft for a record op). deps is threaded so a batch is as hermetic as
// the single verbs.
const applyOperation = (op, { cwd, env }, deps = {}) => {
  const { verb, fromReceipts, ...payload } = op;
  // The invocation's cwd/env WIN (spread last) — validateBatchEnvelope already forbids them in the
  // payload, so this is defense-in-depth against a direct runBatch call bypassing the preflight.
  if (verb === 'classify') return recordTriage({ ...payload, cwd, env }, deps);
  if (verb === 'override') return recordOverride({ ...payload, cwd, env }, deps);
  const params = { ...payload };
  if (fromReceipts) {
    const state = deps.buildState ? deps.buildState({ cwd, env }) : buildState({ cwd, env });
    params.backends = draftBackendsFromReceipts({ state, findings: params.findings, explicitBackends: params.backends ?? [] }, deps);
  }
  return recordRound({ ...params, cwd, env }, deps);
};

// runBatch({ cwd, env, operations }, deps) → { applied: [ per-op results ], count }. Pass 2: apply
// sequentially, fail-fast on the first typed STOP; the ops already appended stay recorded.
export const runBatch = ({ cwd = process.cwd(), env = process.env, operations }, deps = {}) => {
  const applied = [];
  for (const [i, operation] of operations.entries()) {
    try {
      applied.push(applyOperation(operation, { cwd, env }, deps));
    } catch (err) {
      // Honest partial-success (D5): the STOP itself names the failing op index + the applied count.
      // The ledger is append-only, so those ops are durable — resume by re-running the REMAINING ops.
      err.message = `${err.message} [batch stopped at operation [${i}]: ${applied.length} of ${operations.length} operation(s) recorded before the stop and durable (append-only ledger); re-run the remaining operations]`;
      throw err;
    }
  }
  return { applied, count: applied.length };
};

// ── CLI (record / classify / override / batch) ─────────────────────────────────────────────────────

const HELP = `review-ledger-write — the review-round ledger WRITER (agent-workflow family, AD-045 + AD-047 + AD-048).

Usage:
  node review-ledger-write.mjs record   --json '<round-payload>' [--from-receipts] [--cwd <dir>]
  node review-ledger-write.mjs classify --json '<triage-payload>'   [--cwd <dir>]
  node review-ledger-write.mjs override --json '<override-payload>' [--cwd <dir>]
  node review-ledger-write.mjs batch    --json '<{ "operations": [ … ] }>' [--cwd <dir>]
  (every verb also accepts --json @<file> — the payload read from a file, keeping the command
   line PLAIN: an inline JSON argv falls outside plain-invocation allow heuristics and prompts)

Every verb operates on the current SEGMENT — (loop, base = git rev-parse HEAD): round numbers,
caps, and teeth reset only when a gated commit moves base (schema 4; records carry base).

record   appends one review round. The JSON payload carries { loop, round, origins, backends,
         findings } (activity defaults to plan-execution; timestamp defaults to now). With
         --from-receipts the backends[] is DRAFTED from the current-fingerprint grounded code
         receipts (verdict per backend) with counts computed from the supplied findings — origins /
         findings stay explicit; a recipe-named backend with no receipt is a LOUD stop (run its
         review, or supply it explicitly as a degraded backend). REFUSES while
         triage is required; beyond the hard-max ceiling of ${HARD_MAX} rounds within one segment;
         while a blocking finding of the segment's previous round VANISHED unclassified (D6 —
         classify it first, "refuted" is the honest phantom lane); while the changed source surface
         exceeds the ${DEFAULT_DIFF_CAP}-line diff cap (AW_REVIEW_DIFF_CAP) without a recorded
         segment size-cap override (D4); while the segment lacks a quality-green gate-run at the
         current fingerprint (D5 — run the FULL matrix first: run-gates.mjs --record; a --only
         subset or a tree-changed run never satisfies; red PROCESS gates never block); or when a
         non-degraded backend lacks a grounded code receipt for the current tree.
classify appends one triage record. The JSON payload carries { loop, round, classifications } (each
         { findingKey, class, accepted, testId, note }). A fixable-bug REQUIRES a testId — the
         red→green test that pins the fold, formatted "<test-file>#<test-name-pattern>" (write it
         first); refuted REQUIRES a non-empty note citing the refuting grounds;
         inherent-layer-residual / escalate may omit the testId. This is what permits the next round.
override appends one override record — the LOUD, durable waiver the gates consume. The JSON payload
         carries { loop, round, scope, reason } plus, per scope:
         scope "oracle-change" → files[] (non-empty repo-relative paths whose tamper flag it lifts);
         scope "red-proof" → testId (the exact bound testId whose observed-red receipt + custody it
         waives — for a red that is GENUINELY unestablishable pre-fold, D7);
         scope "size-cap" → sanctionedLines (the exact changed-surface magnitude the waiver
         sanctions, SEGMENT-scoped — it dies at the next commit, D4).
         REFUSES for a loop that is not the in-flight plan. QUARANTINE (a flaky/timed-out probe)
         has NO override lane.
batch    applies an ordered list of record / classify / override operations in ONE invocation — the
         prompt-economy lane for a records stage (one writer call, not one per op). The payload is
         { "operations": [ { "verb": "record"|"classify"|"override", …that verb's payload } ] }; a
         record op may carry "fromReceipts": true (the SAME draft as --from-receipts). Each op runs
         the SAME per-verb code path (no forked validator), so a batch of N ops is record-equivalent
         to the same N single invocations. TWO passes: the WHOLE envelope is validated structurally
         first with ZERO writes (a bad envelope stops before any op runs); then ops apply sequentially
         and fail-fast on the first typed STOP — the ops already applied stay recorded (the ledger is
         append-only, no rollback), and the STOP names the failing op index + the applied count.
         Resume by re-running the REMAINING operations.

The read-only checker is a SEPARATE tool: node review-ledger.mjs --check / --status / --json / --telemetry.
Exit codes: 0 written; 1 a typed STOP (teeth / malformed / missing receipt / fs error); 2 usage.`;

// The CLI subcommand set — the SINGLE source the dispatch and the doc-contract pin both read, so a
// documented verb list can never lag the dispatch (Phase 2.3 — the contract-test class).
export const SUBCOMMANDS = ['record', 'classify', 'override', 'batch'];

const parseArgs = (argv) => {
  const opts = { cwd: undefined, json: undefined, fromReceipts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cwd') {
      opts.cwd = argv[i + 1];
      if (opts.cwd === undefined) throw usageFail('--cwd needs a directory');
      i += 1;
    } else if (a === '--json') {
      opts.json = argv[i + 1];
      if (opts.json === undefined) throw usageFail('--json needs a JSON payload');
      // `--json @<file>` reads the payload from a file: a large inline JSON argv (quotes, braces)
      // falls outside every plain-invocation allow heuristic and prompts, and hand-composing it on
      // a command line is exactly the error-prone class --from-receipts exists to shrink — the
      // file form keeps the COMMAND plain while the payload stays explicit (AD-044 Plan 4).
      if (opts.json.startsWith('@')) {
        const payloadPath = opts.json.slice(1);
        try {
          opts.json = readFileSync(payloadPath, 'utf8');
        } catch (err) {
          throw usageFail(`--json @${payloadPath}: unreadable payload file (${err.code ?? err.message})`);
        }
      }
      i += 1;
    } else if (a === '--from-receipts') {
      opts.fromReceipts = true;
    } else {
      throw usageFail(`unknown argument: ${a}`);
    }
  }
  return opts;
};

const parsePayload = (json) => {
  if (json === undefined) throw usageFail('a --json payload is required');
  try {
    return JSON.parse(json);
  } catch (err) {
    throw usageFail(`--json is not valid JSON (${err.message})`);
  }
};

export const main = (argv, ctx = {}) => {
  const cwd0 = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) return { code: argv.length === 0 ? 2 : 0, stdout: HELP, stderr: '' };
    const sub = argv[0];
    if (!SUBCOMMANDS.includes(sub)) throw usageFail(`unknown subcommand "${sub}" (expected: ${SUBCOMMANDS.join(' | ')})`);
    const opts = parseArgs(argv.slice(1));
    if (opts.fromReceipts && sub !== 'record') throw usageFail('--from-receipts applies only to `record` (a batch carries fromReceipts per operation)');
    const payload = parsePayload(opts.json);
    const cwd = opts.cwd ?? cwd0;
    if (sub === 'batch') {
      // Pass 1 (structural, ZERO writes) → pass 2 (sequential apply, fail-fast — prior ops durable).
      const operations = validateBatchEnvelope(payload);
      const { applied, count } = runBatch({ cwd, env, operations });
      const writtenPath = applied.length ? applied[applied.length - 1].writtenPath : '(none)';
      return { code: 0, stdout: `review-ledger-write: recorded ${count} operation(s) in one batch → ${writtenPath}`, stderr: '' };
    }
    if (opts.fromReceipts) {
      // Draft backends[] from the current-fingerprint receipts + the supplied findings; origins /
      // findings stay explicit. The drafted array then rides the normal recordRound teeth.
      const state = buildState({ cwd, env });
      payload.backends = draftBackendsFromReceipts({ state, findings: payload.findings, explicitBackends: payload.backends ?? [] });
    }
    const result =
      sub === 'record'
        ? recordRound({ ...payload, cwd, env })
        : sub === 'classify'
          ? recordTriage({ ...payload, cwd, env })
          : recordOverride({ ...payload, cwd, env });
    return { code: 0, stdout: `review-ledger-write: recorded a ${result.record.kind} for loop "${result.record.loop}" round ${result.record.round} → ${result.writtenPath}`, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `review-ledger-write: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
