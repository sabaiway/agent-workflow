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
//           and when the in-flight plan-execution loop has a CURRENT run record whose BOTH bindings
//           match — the tree fingerprint AND the sorted fixable-bug testId set recorded in the run —
//           with every bound testId resolvable + baseline-green, 0 uncovered changed lines, 0 changed
//           unsupported-source files, and 0 surviving mutants (budget-skips are STATED in the reason).
//   exit 1  for any DIRTY in-flight plan-execution loop lacking such a current run record — including
//           the stale-fingerprint case (a tree edit moves the fingerprint) and the same-fingerprint/
//           new-testId case (a triage recorded after the run moves the bound-testId set, Decision 9) —
//           or a run naming an unresolvable/red-baseline bound test, an uncovered changed line, a
//           changed unsupported-source file, or a surviving mutant; when MORE THAN ONE plan is in
//           flight (ambiguous loop id). Fail-CLOSED (unknown state, never a fail-open pass) on a
//           detector failure, an unreadable/malformed result or review ledger, or a corrupt run set —
//           the only detector-independent green is an EXPLICIT configured solo. Changed OUT-OF-DOMAIN
//           files (docs/config the suite does not execute) are LOUDLY listed but never gate-blocking
//           (Decision 5): guarding what the tool cannot assess with a red gate is a pretend-mechanism.
//
// HONEST residuals (accepted, documented — exactly like review-state's / review-ledger's): coverage
// proves execution, not assertion; the runner's mutation signal is bounded (a surviving mutant is a
// PROVEN gap, but a bounded operator set can miss mutations); the result records, testIds, and the
// ledger are forgeable (`git commit --no-verify`, file editing) — a self-discipline mechanism against
// silent process drift, NOT a security boundary. TS/JSX source is out of scope v1 (a changed
// unsupported-source file fails the gate closed rather than be vouched for).
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
import { resolveLedgerPath, readLedger, filterLoopRecords } from './review-ledger.mjs';

export const RESULTS_BASENAME = 'agent-workflow-fold-completeness.jsonl';
export const RESULT_SCHEMA_VERSION = 1;
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

// validateRunRecord(obj) → { ok, reason }. The `reason` names the exact failed check so the
// malformed-line surface and the per-check named tests can assert it. Mutation stays the empty shape
// until Phase 3 populates it; the schema already carries the fields so v1 records stay valid.
export const validateRunRecord = (obj) => {
  if (!isPlainObject(obj)) return { ok: false, reason: 'not an object' };
  if (obj.schema !== RESULT_SCHEMA_VERSION) return { ok: false, reason: `schema must be ${RESULT_SCHEMA_VERSION}` };
  if (!isNonEmptyString(obj.loop)) return { ok: false, reason: 'missing loop' };
  if (!(obj.fingerprint === null || isNonEmptyString(obj.fingerprint))) return { ok: false, reason: 'fingerprint must be null or a non-empty string' };
  if (!isStringArray(obj.boundTestIds)) return { ok: false, reason: 'boundTestIds must be an array of strings' };
  if (!Array.isArray(obj.testIds)) return { ok: false, reason: 'testIds must be an array' };
  for (const t of obj.testIds) {
    if (!isPlainObject(t) || !isNonEmptyString(t.id)) return { ok: false, reason: 'each testId entry needs an id' };
    if (typeof t.resolvable !== 'boolean' || typeof t.baselineGreen !== 'boolean') return { ok: false, reason: `testId ${t.id} needs boolean resolvable + baselineGreen` };
    if (!isNonNegInt(t.executed)) return { ok: false, reason: `testId ${t.id} executed must be a non-negative integer` };
  }
  if (!isStringArray(obj.unsupported)) return { ok: false, reason: 'unsupported must be an array of strings' };
  if (!isStringArray(obj.outOfDomain)) return { ok: false, reason: 'outOfDomain must be an array of strings' };
  if (!isPlainObject(obj.coverage) || !Array.isArray(obj.coverage.uncoveredChanged)) return { ok: false, reason: 'coverage.uncoveredChanged must be an array' };
  for (const u of obj.coverage.uncoveredChanged) {
    if (!isPlainObject(u) || !isNonEmptyString(u.file)) return { ok: false, reason: 'each uncoveredChanged entry needs a file' };
    if (!(u.line === null || (Number.isInteger(u.line) && u.line >= 1))) return { ok: false, reason: `uncoveredChanged ${u.file} line must be null or an integer >= 1` };
  }
  const m = obj.mutation;
  if (!isPlainObject(m) || !isNonNegInt(m.total) || !isNonNegInt(m.killed) || !Array.isArray(m.survived) || !isNonNegInt(m.skipped)) {
    return { ok: false, reason: 'mutation must be { total, killed, survived[], skipped, killSetBasis }' };
  }
  if (!(m.killSetBasis === null || isNonEmptyString(m.killSetBasis))) return { ok: false, reason: 'mutation.killSetBasis must be null or a non-empty string' };
  if (!isPlainObject(obj.budgets)) return { ok: false, reason: 'budgets must be an object' };
  if (!isNonEmptyString(obj.timestamp)) return { ok: false, reason: 'missing timestamp' };
  return { ok: true };
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

// filterLoopResults(records, loop) → the run records of ONE loop, order preserved (latest is last).
export const filterLoopResults = (records, loop) => records.filter((r) => r.loop === loop);

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
  const runs = filterLoopResults(state.resultRecords, loop);
  if (runs.length === 0) return { code: 1, reason: `dirty plan-execution loop "${loop}" but no fold-completeness run recorded — run fold-completeness-run.mjs` };
  const latest = runs[runs.length - 1];

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
  const unresolvable = latest.testIds.filter((t) => !t.resolvable).map((t) => t.id);
  if (unresolvable.length > 0) return { code: 1, reason: `unresolvable bound testId(s) — the pattern selects no test: ${unresolvable.join(', ')}` };
  const redBaseline = latest.testIds.filter((t) => t.resolvable && !t.baselineGreen).map((t) => t.id);
  if (redBaseline.length > 0) return { code: 1, reason: `bound test(s) with a red baseline (the fold is not complete): ${redBaseline.join(', ')}` };
  if (latest.coverage.uncoveredChanged.length > 0) return { code: 1, reason: `uncovered changed line(s) — changed code no test executed: ${latest.coverage.uncoveredChanged.map(renderUncovered).join(', ')}` };
  if (latest.mutation.survived.length > 0) return { code: 1, reason: `surviving mutant(s) — a proven test gap: ${latest.mutation.survived.join(', ')}` };

  const notes = [];
  if (latest.mutation.skipped > 0) notes.push(`${latest.mutation.skipped} mutant(s) skipped by budget`);
  if (latest.outOfDomain.length > 0) notes.push(`out-of-domain changes not assessed (non-blocking): ${latest.outOfDomain.join(', ')}`);
  return { code: 0, reason: `fold-completeness verified for loop "${loop}" (fingerprint + bound-testId set current, coverage + baseline green)${notes.length ? ` — ${notes.join('; ')}` : ''}` };
};

// ── rendering ─────────────────────────────────────────────────────────────────────────────────

const runLine = (r) => {
  const tests = r.testIds.length ? r.testIds.map((t) => `${t.id}${t.resolvable ? (t.baselineGreen ? '✓' : ' red-baseline') : ' unresolvable'}`).join(', ') : '(no bound tests)';
  const uncov = r.coverage.uncoveredChanged.length ? r.coverage.uncoveredChanged.map(renderUncovered).join(', ') : 'none';
  return [
    `  latest run — fingerprint ${r.fingerprint}`,
    `    bound testIds: ${tests}`,
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
    const runs = filterLoopResults(state.resultRecords, loop);
    if (runs.length > 0) lines.push(runLine(runs[runs.length - 1]));
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

--status (default) → the human report: resolved recipe, plan-in-flight, the latest run summary, verdict.
--check → the gate exit code. The normative exit contract lives in the tool header (the single home):
  exit 0 for solo / no plan in flight / a clean tree / not-a-git-tree / a CURRENT run whose fingerprint
  AND bound-testId set both match, with resolvable+green bound tests, 0 uncovered changed lines, 0
  changed unsupported source, and 0 surviving mutants; exit 1 otherwise (stale/missing run, an
  unresolvable/red bound test, an uncovered line, changed TS/JSX, a surviving mutant, >1 plan, an
  unreadable/malformed ledger, or a detector failure). Out-of-domain changes are listed, never blocking.
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
