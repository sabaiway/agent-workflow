#!/usr/bin/env node
// fold-completeness.mjs — the read-only FOLD-COMPLETENESS checker behind `/agent-workflow-kit
// fold-completeness` (M3, AD-046, DEBT-TEST-COMPLETENESS). It is the sibling gate of
// review-ledger.mjs: the ledger computes the review-loop crossover-stop; this tool computes whether
// the tests that the loop's folds bind to ACTUALLY pin the changed code. It reads the result ledger
// the runner writes (fold-completeness-run.mjs — the SOLE tree-toucher + result writer), recomputes
// the canonical uncommitted-state fingerprint, resolves the plan-execution.review recipe + the
// in-flight plan, and decides `--check` fail-closed. It NEVER runs tests, NEVER mutates, and NEVER
// imports the runner — an import-split test pins that structural invariant (the read half owns the
// result SCHEMA + reader; the runner imports them the other direction, mirroring review-ledger /
// review-ledger-write).
//
// Normative `--check` exit contract (the single home of this list — SKILL.md / the mode file point
// here). The gate is plan-EXECUTION-scoped, filtered to the in-flight plan's filename stem:
//   exit 0  when the resolved plan-execution.review recipe is solo (configured, or degraded there);
//           when no plan is in flight; when the tree is clean; when the cwd is not a git work tree;
//           and when the in-flight plan-execution loop has a CURRENT run record (kind-aware: the
//           latest RUN, never a later red-probe) whose BOTH bindings match — the tree fingerprint AND
//           the sorted fixable-bug testId set recorded in the run — with, per bound testId: an
//           N/N-green probe (D4), an observed-red receipt in this loop (Approach-1.i), that receipt
//           PRECEDING the latest run in ledger order (anti-post-hoc), and content CUSTODY — the run's
//           recorded test-file hash equals the latest custody-eligible red-probe hash on that file
//           (eligible = the receipt's own testId is bound AND it precedes the run, D5); plus 0
//           uncovered changed lines, 0 changed unsupported-source files, and the reserved EMPTY
//           mutation shape (no mutation ships).
//   exit 1  for any DIRTY in-flight plan-execution loop lacking such a current run record — including
//           the stale-fingerprint case (a tree edit moves the fingerprint), the same-fingerprint/
//           new-testId case (a triage recorded after the run moves the bound-testId set, Decision 9),
//           and a schema-1 record as the loop's latest run (an older runner — no rerun counts, no
//           custody hashes; D2) — or a run naming an unresolvable bound test, a QUARANTINED bound
//           test (mixed or timed-out probe runs — never an N/N verdict, never converted, no override
//           lane; D4), a red-baseline bound test, a green bound test with NO observed-red receipt /
//           a post-hoc receipt / broken custody (D5), an uncovered changed line, a changed
//           unsupported-source file, or ANY mutation data (no mutation ships — such a record was not
//           produced by this runner; fail closed); when MORE THAN ONE plan is in flight (ambiguous
//           loop id). Fail-CLOSED (unknown state, never a fail-open pass) on a detector failure, an
//           unreadable/malformed result or review ledger, or a corrupt run set — the only
//           detector-independent green is an EXPLICIT configured solo. Changed OUT-OF-DOMAIN files
//           (docs/config the suite does not execute) are LOUDLY listed but never gate-blocking
//           (Decision 5): guarding what the tool cannot assess with a red gate is a pretend-mechanism.
//
// HONEST residuals (accepted, documented — exactly like review-state's / review-ledger's): coverage
// proves execution, not assertion; NO mutation signal ships in v1 — the researched mutation half was
// shelved, the record's `mutation` field is a reserved empty shape (a record carrying ANY mutation
// data fails the check closed); the result records, testIds, and the ledger are forgeable
// (`git commit --no-verify`, file editing) — a self-discipline mechanism against silent process
// drift, NOT a security boundary. TS/JSX source is out of scope v1 (a changed unsupported-source
// file fails the gate closed rather than be vouched for).
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
import { computeTreeFingerprint, isTreeClean, plansInFlight } from './review-state.mjs';
import { resolveLedgerPath, readLedger, filterLoopRecords, isWellFormedTestId, splitTestId } from './review-ledger.mjs';

export const RESULTS_BASENAME = 'agent-workflow-fold-completeness.jsonl';
// SCHEMA v2 (BUGFREE-1 / AD-047): records gain a kind discriminator — `run` (the fold-completeness
// run, now with per-testId rerun counts + the test file's content hash) | `red-probe` (the
// observed-red receipt --red mints). RESULT_SCHEMA_VERSION is what the WRITER emits; the reader
// tolerates every SUPPORTED version under its own per-version rules (the review-ledger v1→v2
// precedent), so v1 ledgers never retroactively become malformed — but a v1 record as the loop's
// LATEST run fails the gate with a named re-run reason (D2).
export const RESULT_SCHEMA_VERSION = 2;
export const SUPPORTED_RESULT_SCHEMAS = new Set([1, 2]);
const ACTIVITY = 'plan-execution';
const SLOT = 'review';

// ── git-dir resolution (read-only queries; the ledger lives in the git dir, uncommittable) ──────

const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

const gitRoot = (cwd) => gitLine(['rev-parse', '--show-toplevel'], cwd);

// The result-ledger path: AW_FOLD_RESULTS overrides (mirrors AW_REVIEW_LEDGER); else <git dir>/basename.
export const resolveResultsPath = (cwd, env = process.env) => {
  if (env.AW_FOLD_RESULTS) return env.AW_FOLD_RESULTS;
  const gitDir = gitLine(['rev-parse', '--absolute-git-dir'], cwd);
  return gitDir == null ? null : join(gitDir, RESULTS_BASENAME);
};

// ── the bound fixable-bug testId set (the SINGLE source of truth — runner + checker share it) ────

// collectBoundTestIds(reviewRecords, { activity, loop }) → the sorted, de-duplicated testIds of the
// loop's fixable-bug classifications. Pure over review-ledger records. Both the runner (which records
// the set as a binding) and the checker (which recomputes it for the staleness check) call THIS, so
// the two can never drift (Decision 9: same-fingerprint/new-testId is stale).
export const collectBoundTestIds = (reviewRecords, { activity = ACTIVITY, loop } = {}) => {
  const ids = new Set();
  for (const r of filterLoopRecords(reviewRecords, { activity, loop })) {
    if (r.kind !== 'triage') continue;
    for (const c of r.classifications) if (c.class === 'fixable-bug' && typeof c.testId === 'string' && c.testId.length > 0) ids.add(c.testId);
  }
  return [...ids].sort();
};

// ── result-record schema (machine fields only; the runner refuses to write a malformed record) ───

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

const HASH_RE = /^[0-9a-f]{64}$/; // sha-256 hex — the content-custody hash shape

// The shared record frame (both versions, both kinds).
const validateFrame = (obj) => {
  if (!isNonEmptyString(obj.loop)) return 'missing loop';
  if (!(obj.fingerprint === null || isNonEmptyString(obj.fingerprint))) return 'fingerprint must be null or a non-empty string';
  if (!isNonEmptyString(obj.timestamp)) return 'missing timestamp';
  return null;
};

// A v1 per-testId probe entry (single-run booleans — the AD-046 shape, tolerated read-only).
const validateV1Entry = (t) => {
  if (!isPlainObject(t) || !isNonEmptyString(t.id)) return 'each testId entry needs an id';
  if (typeof t.resolvable !== 'boolean' || typeof t.baselineGreen !== 'boolean') return `testId ${t.id} needs boolean resolvable + baselineGreen`;
  if (!isNonNegInt(t.executed)) return `testId ${t.id} executed must be a non-negative integer`;
  return null;
};

// A v2 per-testId probe entry: rerun counts (the D4 evidence) + the test file's content hash (the
// D5 custody anchor) + the derived booleans, VALIDATED consistent with the counts so a forged
// verdict cannot ride beside honest-looking evidence.
const validateV2Entry = (t) => {
  if (!isPlainObject(t) || !isNonEmptyString(t.id)) return 'each testId entry needs an id';
  if (!isNonNegInt(t.executed)) return `testId ${t.id} executed must be a non-negative integer`;
  if (!(Number.isInteger(t.runs) && t.runs >= 1)) return `testId ${t.id} runs must be a positive integer`;
  if (!isNonNegInt(t.greens) || !isNonNegInt(t.reds) || !isNonNegInt(t.timeouts)) return `testId ${t.id} rerun counts (greens/reds/timeouts) must be non-negative integers`;
  if (t.greens + t.reds + t.timeouts > t.runs) return `testId ${t.id} rerun counts exceed runs`;
  // A resolved run means at least one matched (executed) test result — greens/reds with executed=0
  // is a forged N/N verdict carrying zero-match evidence (codex R1, BUGFREE-1 live loop).
  if (t.greens + t.reds > 0 && t.executed < 1) return `testId ${t.id} executed must be positive when a run resolved (greens+reds > 0)`;
  if (!(t.fileHash === null || (typeof t.fileHash === 'string' && HASH_RE.test(t.fileHash)))) return `testId ${t.id} fileHash must be null or a 64-hex content hash`;
  if (t.resolvable !== (t.greens + t.reds === t.runs)) return `testId ${t.id} resolvable must equal (greens + reds === runs)`;
  if (t.baselineGreen !== (t.greens === t.runs)) return `testId ${t.id} baselineGreen must equal (greens === runs)`;
  return null;
};

// The run-record body shared by v1 and v2 (surface classes, coverage, reserved mutation, budgets);
// the per-testId entry rule is the per-version part.
const validateRunBody = (obj, validateEntry) => {
  if (!isStringArray(obj.boundTestIds)) return 'boundTestIds must be an array of strings';
  if (!Array.isArray(obj.testIds)) return 'testIds must be an array';
  for (const t of obj.testIds) {
    const r = validateEntry(t);
    if (r) return r;
  }
  if (!isStringArray(obj.unsupported)) return 'unsupported must be an array of strings';
  if (!isStringArray(obj.outOfDomain)) return 'outOfDomain must be an array of strings';
  if (!isPlainObject(obj.coverage) || !Array.isArray(obj.coverage.uncoveredChanged)) return 'coverage.uncoveredChanged must be an array';
  for (const u of obj.coverage.uncoveredChanged) {
    if (!isPlainObject(u) || !isNonEmptyString(u.file)) return 'each uncoveredChanged entry needs a file';
    if (!(u.line === null || (Number.isInteger(u.line) && u.line >= 1))) return `uncoveredChanged ${u.file} line must be null or an integer >= 1`;
  }
  const m = obj.mutation;
  if (!isPlainObject(m) || !isNonNegInt(m.total) || !isNonNegInt(m.killed) || !Array.isArray(m.survived) || !isNonNegInt(m.skipped)) {
    return 'mutation must be { total, killed, survived[], skipped, killSetBasis }';
  }
  if (!(m.killSetBasis === null || isNonEmptyString(m.killSetBasis))) return 'mutation.killSetBasis must be null or a non-empty string';
  if (!isPlainObject(obj.budgets)) return 'budgets must be an object';
  return null;
};

// The red-probe receipt (v2 only): the machine attestation that testId FAILED on N/N runs at the
// recorded content hash. Minted only by the runner's --red verb; reds must equal runs — a receipt
// never records anything but an honest N/N red (refusals write nothing).
const validateRedProbe = (obj) => {
  if (!isWellFormedTestId(obj.testId)) return 'red-probe testId must be "<test-file>#<test-name-pattern>" (a "#" separator, both halves non-empty)';
  if (!(typeof obj.fileHash === 'string' && HASH_RE.test(obj.fileHash))) return 'red-probe fileHash must be a 64-hex content hash';
  if (!(Number.isInteger(obj.runs) && obj.runs >= 1)) return 'red-probe runs must be a positive integer';
  if (obj.reds !== obj.runs) return 'red-probe reds must equal runs (a receipt attests N/N observed red)';
  return null;
};

// validateRunRecord(obj) → { ok, reason }. Per-version, per-kind (D2): v1 records (no kind) keep the
// AD-046 single-run rules; v2 records carry the kind discriminator. The `reason` names the exact
// failed check so the malformed-line surface and the per-check named tests can assert it. Mutation
// stays the reserved empty shape (the mutation half is shelved); the schema carries the fields so a
// record validates uniformly and decideCheck enforces the exact reserved shape.
export const validateRunRecord = (obj) => {
  if (!isPlainObject(obj)) return { ok: false, reason: 'not an object' };
  if (!SUPPORTED_RESULT_SCHEMAS.has(obj.schema)) return { ok: false, reason: `schema must be one of ${[...SUPPORTED_RESULT_SCHEMAS].join(', ')}` };
  const frame = validateFrame(obj);
  if (frame) return { ok: false, reason: frame };
  if (obj.schema === 1) {
    if (obj.kind !== undefined) return { ok: false, reason: 'a v1 record must not carry kind (kind is a v2 discriminator)' };
    const r = validateRunBody(obj, validateV1Entry);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  if (obj.kind === 'run') {
    const r = validateRunBody(obj, validateV2Entry);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  if (obj.kind === 'red-probe') {
    const r = validateRedProbe(obj);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  return { ok: false, reason: `kind must be "run" or "red-probe" (got ${JSON.stringify(obj.kind)})` };
};

// readResults(path) → { records, malformed, malformedReasons, readError }. Absent file → empty (no run
// yet). A non-ENOENT read error surfaces as readError so callers fail CLOSED (mirrors readLedger).
export const readResults = (path, readFile = readFileSync) => {
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch (err) {
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
    const v = validateRunRecord(parsed);
    if (v.ok) records.push(parsed);
    else malformedReasons.push(v.reason);
  }
  return { records, malformed: malformedReasons.length, malformedReasons };
};

// filterLoopResults(records, loop) → the result records of ONE loop (both kinds), order preserved
// (latest is last).
export const filterLoopResults = (records, loop) => records.filter((r) => r.loop === loop);

// ── kind-aware selectors (shared: the runner and the checker read the ledger through THESE) ──────

// A v1 record IS a run (the kindless AD-046 shape); a v2 record is a run only under kind:"run".
export const isRunRecord = (r) => r.schema === 1 || r.kind === 'run';
export const isRedProbeRecord = (r) => r.schema >= 2 && r.kind === 'red-probe';

// latestRunRecord(loopRecords) → { record, index } | null over ONE loop's ordered records. Kind-aware
// (codex R2): a red-probe appended after a run must never be read as the loop's "latest run" — the
// index anchors the D5/order checks (a custody-eligible receipt PRECEDES the latest run).
export const latestRunRecord = (loopRecords) => {
  for (let i = loopRecords.length - 1; i >= 0; i -= 1) {
    if (isRunRecord(loopRecords[i])) return { record: loopRecords[i], index: i };
  }
  return null;
};

// probeVerdict(entry) → 'green' | 'red' | 'quarantine' | 'unresolvable' — the D4 verdict algebra,
// the SINGLE home shared by the runner (--red mints only on 'red') and the checker (the gate passes
// only on 'green'). RED/GREEN are strict N/N verdicts; any timeout, mixed outcome, or partial
// resolution is QUARANTINE — it never converts and has no override lane (a flaky pin proves
// nothing — replace the test). Zero resolved runs (or a defensive runs=0) reads unresolvable.
export const probeVerdict = (t) => {
  const unresolved = t.runs - t.greens - t.reds - t.timeouts;
  if (unresolved >= t.runs) return 'unresolvable';
  if (t.timeouts > 0 || unresolved > 0 || (t.greens > 0 && t.reds > 0)) return 'quarantine';
  return t.greens === t.runs ? 'green' : 'red';
};

// ── the check + report core ─────────────────────────────────────────────────────────────────────

// buildFoldState({ cwd, env, detect }) → everything both renders need. Pure I/O at the edges; every
// project-relative read anchors at the git work-tree ROOT when one exists (the fingerprint is
// root-anchored — the same discipline review-state / review-ledger use).
export const buildFoldState = ({ cwd, env = process.env, detect = detectBackends } = {}) => {
  const root = gitRoot(cwd) ?? cwd;
  const { config, source: configSource } = loadConfig(root);
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
  const resultsPath = resolveResultsPath(cwd, env);
  const resultRead = resultsPath ? readResults(resultsPath) : { records: [], malformed: 0, malformedReasons: [] };
  const reviewPath = resolveLedgerPath(cwd, env);
  const reviewRead = reviewPath ? readLedger(reviewPath) : { records: [], malformed: 0, malformedReasons: [] };
  return {
    resolved,
    configSource,
    requiredBackends,
    plans,
    fingerprint,
    clean,
    resultsPath,
    resultRecords: resultRead.records,
    resultMalformed: resultRead.malformed,
    resultReadError: resultRead.readError,
    reviewPath,
    reviewRecords: reviewRead.records,
    reviewMalformed: reviewRead.malformed,
    reviewReadError: reviewRead.readError,
    detectionWarning,
  };
};

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// The reserved (and, in v1, only legal) mutation key set — sorted for the sameSet comparison.
const RESERVED_MUTATION_KEYS = ['killSetBasis', 'killed', 'skipped', 'survived', 'total'];
const renderUncovered = (u) => (u.line === null ? `${u.file} (absent from coverage)` : `${u.file}:${u.line}`);

// The normative --check decision (the header contract, in order) → { code, reason }. The checker is
// PURE over (record, current fingerprint, review ledger) — it recomputes NO coverage/mutation.
export const decideCheck = (state) => {
  // A detector failure is UNKNOWN state, not "no reviewer ready" — fail closed (like review-ledger).
  const explicitSolo = state.resolved.recipe === 'solo' && state.resolved.source === 'config' && !state.resolved.degradedFrom;
  if (state.detectionWarning && !explicitSolo) return { code: 1, reason: `cannot verify fold-completeness — ${state.detectionWarning}` };
  if (state.resolved.recipe === 'solo') {
    const why = state.resolved.degradedFrom ? `resolved ${ACTIVITY}.${SLOT} recipe degrades to solo here (${state.resolved.reason})` : `resolved ${ACTIVITY}.${SLOT} recipe is solo`;
    return { code: 0, reason: `${why} — no fold-completeness run required` };
  }
  if (state.plans.length === 0) return { code: 0, reason: 'no plan in flight (docs/plans/ holds no active plan) — no fold-completeness run required' };
  if (state.plans.length > 1) return { code: 1, reason: `more than one plan in flight (${state.plans.join(', ')}) — ambiguous loop id; resolve to one active plan` };
  if (state.fingerprint == null) return { code: 0, reason: 'not a git work tree — nothing to assess' };
  if (state.clean === true) return { code: 0, reason: 'the working tree is clean — nothing to assess' };
  // Fail CLOSED on any ledger the reader could not fully trust (a dropped line could hide a defect).
  if (state.resultReadError) return { code: 1, reason: `cannot read the result ledger (${state.resultReadError}) — failing closed; inspect ${state.resultsPath}` };
  if (state.resultMalformed > 0) return { code: 1, reason: `the result ledger has ${state.resultMalformed} malformed line(s) — failing closed; inspect ${state.resultsPath}` };
  if (state.reviewReadError) return { code: 1, reason: `cannot read the review ledger (${state.reviewReadError}) — failing closed; inspect ${state.reviewPath}` };
  if (state.reviewMalformed > 0) return { code: 1, reason: `the review ledger has ${state.reviewMalformed} malformed line(s) — failing closed; inspect ${state.reviewPath}` };

  const loop = state.plans[0].replace(/\.md$/, '');
  const loopResults = filterLoopResults(state.resultRecords, loop);
  const sel = latestRunRecord(loopResults);
  if (sel == null) return { code: 1, reason: `dirty plan-execution loop "${loop}" but no fold-completeness run recorded — run fold-completeness-run.mjs` };
  const latest = sel.record;
  // D2 — a v1 record as the loop's latest run: the gate now needs the v2 evidence (rerun counts +
  // custody hashes), which an older runner never recorded. Fail with a named re-run reason.
  if (latest.schema === 1) return { code: 1, reason: `the loop's latest run is a schema-1 record (an older runner — no rerun counts, no custody hashes) — re-run fold-completeness-run.mjs` };

  // Decision 9 — the double binding. A tree edit moves the fingerprint; a new fixable-bug triage moves
  // the bound-testId set. Either mismatch is STALE (the run no longer describes the committable tree).
  if (latest.fingerprint !== state.fingerprint) return { code: 1, reason: `no fold-completeness run for the current tree (the tree was edited after the run) — re-run fold-completeness-run.mjs after the last edit` };
  const currentBound = collectBoundTestIds(state.reviewRecords, { activity: ACTIVITY, loop });
  if (!sameSet(latest.boundTestIds, currentBound)) return { code: 1, reason: `a fixable-bug testId was triaged after the run (the bound-testId set changed) — re-run fold-completeness-run.mjs` };
  // Fail CLOSED if the run's probe set does not cover its bound-testId set EXACTLY. A well-formed
  // runner record always probes every bound testId (one testIds[] entry per boundTestId), but a record
  // with missing/extra/duplicate probes is untrustworthy — proving "0 unresolvable, 0 red" over an
  // EMPTY (or partial) probe set proves nothing about the bound tests (codex R1).
  const probedIds = latest.testIds.map((t) => t.id).sort();
  if (!sameSet(probedIds, latest.boundTestIds)) return { code: 1, reason: `the run's probe set does not match its bound-testId set (${probedIds.length} probe(s) for ${latest.boundTestIds.length} bound testId(s)) — failing closed; re-run fold-completeness-run.mjs` };

  // A changed unsupported-source file → fail closed: the signal never vouches for JS-family source it
  // cannot assess (TS/JSX out of scope v1, Decision 5).
  if (latest.unsupported.length > 0) return { code: 1, reason: `changed unsupported-source file(s) the signal cannot assess (TS/JSX out of scope v1): ${latest.unsupported.join(', ')}` };

  // Per-testId enforcement, in bound (sorted) order: the D4 verdict algebra first — QUARANTINE and
  // red/unresolvable are probe-outcome failures regardless of receipts — then, for a green test, the
  // red-proof chain: receipt exists (Approach-1.i) → the receipt PRECEDES the loop's latest run
  // (anti-post-hoc, codex R2) → content custody (D5). The checker stays PURE: the current file hash
  // IS the latest run's recorded hash (the run is fingerprint-bound to the current tree).
  const probes = new Map(latest.testIds.map((t) => [t.id, t]));
  const boundSet = new Set(latest.boundTestIds);
  const receipts = loopResults.map((r, i) => ({ r, i })).filter(({ r }) => isRedProbeRecord(r));
  for (const id of latest.boundTestIds) {
    const t = probes.get(id);
    const verdict = probeVerdict(t);
    if (verdict === 'unresolvable') return { code: 1, reason: `unresolvable bound testId(s) — the pattern selects no test: ${id}` };
    if (verdict === 'quarantine') return { code: 1, reason: `bound test in QUARANTINE — not an N/N verdict (${t.greens} green / ${t.reds} red / ${t.timeouts} timed out of ${t.runs} runs): ${id}. A flaky/timed-out probe proves nothing and has no override lane — replace or speed up the test, then re-run` };
    if (verdict === 'red') return { code: 1, reason: `bound test(s) with a red baseline (the fold is not complete): ${id}` };
    // verdict green — the red-proof chain.
    const own = receipts.filter(({ r }) => r.testId === id);
    if (own.length === 0) return { code: 1, reason: `no observed-red receipt for ${id} — a test never seen failing proves nothing about the fix. BEFORE folding a fix, run: node fold-completeness-run.mjs --red "${id}"` };
    if (!own.some(({ i }) => i < sel.index)) return { code: 1, reason: `the observed-red receipt for ${id} was minted AFTER the loop's latest run — a post-hoc red proves nothing; run fold-completeness-run.mjs once more (a fresh run after the receipt)` };
    const { file } = splitTestId(id);
    // Custody eligibility (D5, codex R3): the anchor is the LATEST receipt on that FILE whose own
    // testId is in the bound set AND which precedes the latest run — an unbound throwaway receipt,
    // or one minted post-run, never re-attests a file.
    const eligible = receipts.filter(({ r, i }) => i < sel.index && boundSet.has(r.testId) && splitTestId(r.testId).file === file);
    const anchor = eligible[eligible.length - 1];
    if (!anchor || t.fileHash == null || anchor.r.fileHash !== t.fileHash) {
      return { code: 1, reason: `custody broken for ${id}: the test file ${file} no longer matches its last observed-red content — re-observe red after the edit (node fold-completeness-run.mjs --red "<the file's newest testId>"), or record a red-proof override if the red is genuinely unestablishable` };
    }
  }
  if (latest.coverage.uncoveredChanged.length > 0) return { code: 1, reason: `uncovered changed line(s) — changed code no test executed: ${latest.coverage.uncoveredChanged.map(renderUncovered).join(', ')}` };
  // v1 ships NO mutation (the mutation half was shelved): the shipped runner only ever writes the
  // reserved empty shape, so a record carrying ANY mutation data was not produced by this runner
  // version (forged, or a version-skewed ledger — e.g. an older placed checker reading a newer
  // runner's ledger) — fail closed rather than vouch for a signal v1 cannot have computed. The rule
  // is the EXACT reserved shape (key set + empty values): an extra key would smuggle mutation data
  // past a known-fields-only check.
  const m = latest.mutation;
  const emptyReservedShape =
    sameSet(Object.keys(m).sort(), RESERVED_MUTATION_KEYS) &&
    m.total === 0 && m.killed === 0 && m.skipped === 0 && m.survived.length === 0 && m.killSetBasis === null;
  if (!emptyReservedShape) {
    return { code: 1, reason: `the run record's mutation field is not the reserved empty shape (${m.total} total / ${m.killed} killed / ${m.survived?.length ?? '?'} survived / ${m.skipped} skipped) but v1 ships no mutation — not a record this runner version produced; re-run fold-completeness-run.mjs` };
  }

  const notes = [];
  if (latest.outOfDomain.length > 0) notes.push(`out-of-domain changes not assessed (non-blocking): ${latest.outOfDomain.join(', ')}`);
  return { code: 0, reason: `fold-completeness verified for loop "${loop}" (fingerprint + bound-testId set current, coverage + baseline green)${notes.length ? ` — ${notes.join('; ')}` : ''}` };
};

// ── rendering ─────────────────────────────────────────────────────────────────────────────────

const testLine = (r, t) => {
  if (r.schema === 1) return `${t.id}${t.resolvable ? (t.baselineGreen ? '✓' : ' red-baseline') : ' unresolvable'}`;
  const v = probeVerdict(t);
  return v === 'green' ? `${t.id} ✓ ${t.greens}/${t.runs}` : `${t.id} ${v} (${t.greens}g/${t.reds}r/${t.timeouts}t of ${t.runs})`;
};

const runLine = (r, receipts) => {
  const tests = r.testIds.length ? r.testIds.map((t) => testLine(r, t)).join(', ') : '(no bound tests)';
  const uncov = r.coverage.uncoveredChanged.length ? r.coverage.uncoveredChanged.map(renderUncovered).join(', ') : 'none';
  return [
    `  latest run — fingerprint ${r.fingerprint}`,
    `    bound testIds: ${tests}`,
    `    red-probe receipts: ${receipts.length ? receipts.map((p) => `${p.testId} (${p.reds}/${p.runs} red @${p.fileHash.slice(0, 8)})`).join(', ') : 'none'}`,
    `    uncovered changed: ${uncov}`,
    `    unsupported: ${r.unsupported.length ? r.unsupported.join(', ') : 'none'} · out-of-domain: ${r.outOfDomain.length ? r.outOfDomain.join(', ') : 'none'}`,
    `    mutation: ${r.mutation.total} total / ${r.mutation.killed} killed / ${r.mutation.survived.length} survived / ${r.mutation.skipped} skipped`,
  ].join('\n');
};

const formatHuman = (state, check) => {
  const src = state.configSource === 'config' ? `from ${CONFIG_REL}` : 'computed default';
  const lines = [
    `fold-completeness — ${ACTIVITY}.${SLOT} = ${state.resolved.recipe} (${src})${state.requiredBackends.length ? ` → ${state.requiredBackends.join(' + ')}` : ''}`,
  ];
  if (state.detectionWarning) lines.push(`  ⚠ ${state.detectionWarning}`);
  lines.push(`  plan in flight: ${state.plans.length ? state.plans.join(', ') : '(none)'}`);
  if (state.fingerprint == null) lines.push('  tree: not a git work tree');
  else if (state.clean === true) lines.push('  tree: clean (nothing to assess)');
  else lines.push(`  tree fingerprint: ${state.fingerprint}`);
  lines.push(`  result ledger: ${state.resultsPath ?? '(unresolvable — no git dir)'} (${state.resultRecords.length} record(s)${state.resultMalformed ? `, ${state.resultMalformed} malformed — inspect the file` : ''})`);
  if (state.plans.length === 1) {
    const loop = state.plans[0].replace(/\.md$/, '');
    const loopResults = filterLoopResults(state.resultRecords, loop);
    const sel = latestRunRecord(loopResults); // kind-aware: never render a red-probe as "the run"
    if (sel) lines.push(runLine(sel.record, loopResults.filter(isRedProbeRecord)));
  }
  lines.push(`  check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`);
  return lines.join('\n');
};

const HELP = `fold-completeness — read-only FOLD-COMPLETENESS checker (agent-workflow family, AD-046).

Usage:
  node fold-completeness.mjs [--check | --status | --json]

Reads the result ledger the runner writes (<git dir>/${RESULTS_BASENAME}; AW_FOLD_RESULTS overrides),
resolves the effective ${ACTIVITY}.${SLOT} recipe, recomputes the canonical uncommitted-state
fingerprint, and decides whether the in-flight plan-execution loop's changed code is pinned by tests.

--status (default) → the human report: resolved recipe, plan-in-flight, the latest run summary
  (per-testId D4 verdicts + rerun counts), the loop's red-probe receipts, verdict.
--check → the gate exit code. The normative exit contract lives in the tool header (the single home):
  exit 0 for solo / no plan in flight / a clean tree / not-a-git-tree / a CURRENT run whose fingerprint
  AND bound-testId set both match, with — per bound testId — an N/N-green probe, an observed-red
  receipt that PRECEDES the run, and content custody (run hash == the latest custody-eligible receipt
  hash on that file); plus 0 uncovered changed lines, 0 changed unsupported source, and the reserved
  empty mutation shape; exit 1 otherwise (stale/missing/v1-latest run, an unresolvable bound test, a
  QUARANTINED bound test — mixed/timeout, never converted, no override lane — a red baseline, a
  missing/post-hoc receipt, broken custody, an uncovered line, changed TS/JSX, any mutation data,
  >1 plan, an unreadable/malformed ledger, or a detector failure). Out-of-domain changes are listed,
  never blocking. The honest fold-time order: classify the fixable-bug with its testId → write the
  test → fold-completeness-run.mjs --red "<testId>" observes red BEFORE the fix → fold the fix → the
  normal run observes green → --check.
--json → the structured state + decision.

The runner is a SEPARATE tool (fold-completeness-run.mjs) — this read-only checker never imports it.
Human residual: git commit --no-verify and ledger editing remain possible — a self-discipline mechanism.

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
    const state = buildFoldState({ cwd, env, detect });
    const check = decideCheck(state);
    if (argv.includes('--json')) {
      return { code: argv.includes('--check') ? check.code : 0, stdout: JSON.stringify({ ...state, check }, null, 2), stderr: '' };
    }
    if (argv.includes('--check')) {
      return { code: check.code, stdout: `fold-completeness check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`, stderr: '' };
    }
    return { code: 0, stdout: formatHuman(state, check), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `fold-completeness: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
