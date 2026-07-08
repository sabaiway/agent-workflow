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
// The NEUTRAL shared core (D4/D8): the D8 telemetry reads the FOLD ledger through the neutral
// module — never through fold-completeness.mjs, which imports THIS module (the import-cycle
// invariant, codex R2; an import-split test pins it). probeVerdict is the one D4 algebra home.
import { probeVerdict, resolveResultsPath, readJsonlRows } from './changed-surface.mjs';

export const LEDGER_BASENAME = 'agent-workflow-review-ledger.jsonl';
const ACTIVITY = 'plan-execution';
const SLOT = 'review';
// The triage TRIGGER cap (Decision 5): reaching it with an unclassified surviving blocking finding
// forces triage. Shared with the writer (which imports it) — the writer-only hard-max ceiling lives
// there, never here (it is not a decideStop input).
export const REVIEW_CAP = 2;
// SCHEMA_VERSION is what the WRITER emits (M2/AD-046: a fixable-bug triage requires a non-null,
// well-formed testId — the red→green test that pins the fold; BUGFREE-1/AD-047: v3 adds the
// `override` record kind — the loud, durable waiver the fold-completeness gate consumes;
// BUGFREE-2/AD-048: v4 adds the SEGMENT — every record carries `base` = the commit the dirty tree
// sits on, and round numbering / caps / teeth / decideCheck all operate per (activity, loop, base) —
// plus the kind `gate-run` (the D5 green-baseline receipt run-gates --record mints), the override
// scope `size-cap` (the D4 diff-cap waiver), and the triage class `refuted` (the D6 honest lane for
// a phantom finding). The READER tolerates every SUPPORTED_SCHEMAS version under its own
// per-version rules, so historical/live v1..v3 ledgers never retroactively become malformed
// (Decision 2 — a malformed line cascades fail-closed refusals in the writer teeth AND the --check
// gate). v1 records keep the AD-045 rule (testId optional, unenforced); v2+ enforces the
// test-per-fold binding; ONLY v3+ may carry kind `override`; ONLY v4 may carry `base` / kind
// `gate-run` / scope `size-cap` / class `refuted` (older records never grow new surface).
// decideStop never reads testId, overrides, gate-runs, or base (not decideStop inputs — the caller
// passes ONE segment's records, exactly as it passes one loop's; D10: the truth table is untouched).
export const SCHEMA_VERSION = 4;
const SUPPORTED_SCHEMAS = new Set([1, 2, 3, 4]);

// The record vocabulary — the single home of every enum the schema validates.
const ACTIVITIES_SET = new Set(['plan-authoring', 'plan-execution']);
const KINDS_SET = new Set(['round', 'triage']);
const SEVERITIES = new Set(['blocker', 'major', 'minor']);
export const ORIGINS = ['first-draft', 'fold-induced', 'mechanics'];
const CLASSES = new Set(['fixable-bug', 'inherent-layer-residual', 'escalate']);
// v4 (BUGFREE-2 / D6): `refuted` — the honest lane for a phantom finding, refuted against code with
// a MANDATORY non-empty note citing the grounds; never silently dropped, never folded. Exported as
// the code-side vocabulary source the doc-parity lint (BUGFREE-3 / AD-049) checks the contract docs
// against — so the mode files can never drift from the schema's own class/scope lexicon.
export const V4_CLASSES = new Set([...CLASSES, 'refuted']);
const OVERRIDE_SCOPES = new Set(['oracle-change', 'red-proof']);
// v4 (BUGFREE-2 / D4): `size-cap` — the recorded waiver for a changed surface beyond the diff cap;
// exact payload carries the sanctioned magnitude, and it is SEGMENT-scoped (loop + base), unlike
// the two loop-scoped v3 scopes.
export const V4_OVERRIDE_SCOPES = new Set([...OVERRIDE_SCOPES, 'size-cap']);

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

// ── the segment (BUGFREE-2 / AD-048, D1) ─────────────────────────────────────────────────────────
// A SEGMENT = (activity, loop, base) where base = the commit the dirty tree sits on. Derived, never
// declared: `git rev-parse HEAD` is computed identically at write time and check time, matches the
// review's actual domain (the working-tree diff vs HEAD), and its reset is commit-gated — so
// resetting the round counter REQUIRES shipping a green, converged unit. An amend/rebase mid-loop
// orphans the segment's rounds — correct: the reviewed tree no longer exists.

// resolveBase(cwd) → the current HEAD commit sha, or null on an unborn branch / outside a git work
// tree (a caught refusal from git, never a crash — agy R1).
export const resolveBase = (cwd) => gitLine(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);

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

// testId FORMAT (Decision 3): "<repo-relative test file>#<test-name-pattern>" — a "#" separator with
// BOTH halves non-empty. NO file-suffix rule: a suffix check would itself be a special case and would
// block a consumer's own naming (e.g. `.spec.js`; agy R1). The reader validates FORMAT only (it stays
// hermetic); the fold-completeness gate validates RESOLVABILITY via a bound-test probe run. Exported
// (with the splitter) as the single home of the format — the fold-completeness pair validates and
// splits testIds through THESE, so the format can never fork (BUGFREE-1 / AD-047).
const TESTID_SEPARATOR = '#';
export const isWellFormedTestId = (v) => {
  if (typeof v !== 'string') return false;
  const at = v.indexOf(TESTID_SEPARATOR);
  return at > 0 && at < v.length - 1; // separator present, both halves non-empty
};
export const splitTestId = (v) => {
  const at = v.indexOf(TESTID_SEPARATOR);
  return { file: v.slice(0, at), pattern: v.slice(at + 1) };
};

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

// validateTriage(obj, schema) → { ok, reason }. `schema` selects the per-version rules (v1 tolerant
// testId / v2 the test-per-fold binding / v4 the `refuted` class) — the shared structural checks
// run in every version.
const validateTriage = (obj, schema = SCHEMA_VERSION) => {
  if (!Array.isArray(obj.classifications) || obj.classifications.length === 0) return { ok: false, reason: 'triage: classifications must be a non-empty array' };
  const classes = schema >= 4 ? V4_CLASSES : CLASSES;
  for (const c of obj.classifications) {
    if (!isPlainObject(c) || !isNonEmptyString(c.findingKey)) return { ok: false, reason: 'triage: each classification needs a findingKey' };
    if (!classes.has(c.class)) return { ok: false, reason: `triage: classification ${c.findingKey} bad class "${c.class}"` };
    // D6 — `refuted` is the honest phantom-finding lane: the grounds are MANDATORY (a non-empty
    // note citing what refutes it against code), never a silent drop.
    if (c.class === 'refuted' && !isNonEmptyString(c.note)) return { ok: false, reason: `triage: classification ${c.findingKey} is refuted but carries no note — cite the grounds that refute it against code (mandatory)` };
    if (typeof c.accepted !== 'boolean') return { ok: false, reason: `triage: classification ${c.findingKey} missing boolean accepted` };
    // Structural (BOTH versions): testId is null/absent or a non-empty string — an ABSENT key is
    // treated as null, never rejected here (agy R3). The writer normalizes it to null when stored.
    if (!(c.testId === undefined || c.testId === null || isNonEmptyString(c.testId))) return { ok: false, reason: `triage: classification ${c.findingKey} testId must be null/absent or a non-empty string` };
    // Schema v2 (M2/AD-046) — the test-per-fold binding: a fixable-bug MUST carry a testId (the
    // red→green test that pins the fold), and ANY present testId must be well-formed. v1 keeps the
    // AD-045 rule (testId optional, unenforced) so historical/live v1 ledgers never become malformed.
    if (schema >= 2) {
      const present = isNonEmptyString(c.testId);
      if (c.class === 'fixable-bug' && !present) return { ok: false, reason: `triage: classification ${c.findingKey} is a fixable-bug but carries no testId — record the red→green test that pins the fold (write it first)` };
      if (present && !isWellFormedTestId(c.testId)) return { ok: false, reason: `triage: classification ${c.findingKey} testId "${c.testId}" is malformed — expected "<test-file>#<test-name-pattern>" (a "#" separator, both halves non-empty)` };
    }
    if (typeof c.note !== 'string') return { ok: false, reason: `triage: classification ${c.findingKey} note must be a string` };
  }
  return { ok: true };
};

// validateOverride(obj, schema) → { ok, reason }. v3+ (BUGFREE-1 / AD-047, D3): scope `oracle-change`
// carries non-empty repo-relative files[] + reason; scope `red-proof` carries a REQUIRED
// well-formed testId + reason, no files[]. v4 (BUGFREE-2 / D4) adds scope `size-cap`: a REQUIRED
// positive-integer sanctionedLines — the exact magnitude the waiver sanctions, segment-scoped.
// Payloads are EXACT — a stray cross-scope field is a forgery smell, rejected. The fingerprint is
// recorded for audit only.
const OVERRIDE_SHARED_KEYS = new Set(['schema', 'loop', 'activity', 'kind', 'round', 'base', 'fingerprint', 'timestamp', 'scope', 'reason']);
const OVERRIDE_PAYLOAD_KEY = { 'oracle-change': 'files', 'red-proof': 'testId', 'size-cap': 'sanctionedLines' };
const validateOverride = (obj, schema = SCHEMA_VERSION) => {
  const scopes = schema >= 4 ? V4_OVERRIDE_SCOPES : OVERRIDE_SCOPES;
  if (!scopes.has(obj.scope)) return { ok: false, reason: `override: bad scope "${obj.scope}" (expected ${[...scopes].join(' | ')})` };
  // EXACT per-scope payloads via an allow-list (codex R5): a stray key — a cross-scope field or an
  // arbitrary hand-added one — is a forgery smell, rejected by name (the mutation-shape precedent).
  const payloadKey = OVERRIDE_PAYLOAD_KEY[obj.scope];
  for (const k of Object.keys(obj)) {
    if (!OVERRIDE_SHARED_KEYS.has(k) && k !== payloadKey) return { ok: false, reason: `override: unknown key "${k}" (exact per-scope payloads: shared frame + ${payloadKey})` };
  }
  if (!isNonEmptyString(obj.reason)) return { ok: false, reason: 'override: a non-empty reason is required (never a silent waiver)' };
  if (obj.scope === 'oracle-change') {
    if (!Array.isArray(obj.files) || obj.files.length === 0) return { ok: false, reason: 'override: oracle-change files[] must be a non-empty array' };
    for (const f of obj.files) {
      if (!isNonEmptyString(f) || f.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(f)) return { ok: false, reason: `override: files[] entries must be non-empty repo-relative paths (got ${JSON.stringify(f)})` };
    }
    return { ok: true };
  }
  if (obj.scope === 'size-cap') {
    if (!(Number.isInteger(obj.sanctionedLines) && obj.sanctionedLines >= 1)) return { ok: false, reason: 'override: a size-cap override requires sanctionedLines — the exact positive-integer magnitude it sanctions' };
    return { ok: true };
  }
  if (!isWellFormedTestId(obj.testId)) return { ok: false, reason: 'override: a red-proof override requires a well-formed testId "<test-file>#<test-name-pattern>"' };
  return { ok: true };
};

// ── the gate-run record (BUGFREE-2 / D5): the green-baseline receipt run-gates --record mints ────

// Per-kind frame rule: a gate-run carries the SEGMENT frame (loop, base, fingerprint before/after,
// timestamp) and NO round number. The body is machine-composed by recordGateRun, so the key set is
// EXACT (the override allow-list precedent): declared[] = the FULL declaration at run time (id +
// cmd — the cmd is what the process-gate classification reads); results[] = what actually ran (a
// --only subset records exactly that subset, honestly); summary mirrors the runner's machine
// summary line, consistency-checked against results[] so a forged verdict cannot ride beside
// honest-looking evidence.
const GATE_RUN_KEYS = new Set(['schema', 'loop', 'activity', 'kind', 'base', 'fingerprint', 'fingerprintAfter', 'declared', 'results', 'summary', 'timestamp']);
const SUMMARY_KEYS = ['failed', 'failedIds', 'gates', 'passed', 'status'];
// Gate ids are kebab-case — the same closed shape run-gates.mjs enforces on the declaration; it
// also kills the comma-aliasing class in the failedIds compare (internal sweep).
const GATE_RUN_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const validateGateRun = (obj) => {
  for (const k of Object.keys(obj)) {
    if (!GATE_RUN_KEYS.has(k)) return { ok: false, reason: `gate-run: unknown key "${k}" (exact machine-composed payload)` };
  }
  if (!(obj.fingerprintAfter === null || isNonEmptyString(obj.fingerprintAfter))) return { ok: false, reason: 'gate-run: fingerprintAfter must be null or a non-empty string (the post-run tree)' };
  if (!Array.isArray(obj.declared) || obj.declared.length === 0) return { ok: false, reason: 'gate-run: declared must be a non-empty array of { id, cmd }' };
  const declaredIds = new Set();
  for (const d of obj.declared) {
    if (!isPlainObject(d) || !isNonEmptyString(d.id) || !isNonEmptyString(d.cmd) || Object.keys(d).length !== 2) return { ok: false, reason: 'gate-run: each declared entry must be exactly { id, cmd } (non-empty strings)' };
    if (!GATE_RUN_ID_RE.test(d.id)) return { ok: false, reason: `gate-run: id "${d.id}" must be kebab-case (the run-gates declaration shape)` };
    if (declaredIds.has(d.id)) return { ok: false, reason: `gate-run: duplicate declared id "${d.id}"` };
    declaredIds.add(d.id);
  }
  if (!Array.isArray(obj.results) || obj.results.length === 0) return { ok: false, reason: 'gate-run: results must be a non-empty array of { id, ok, code }' };
  const resultIds = new Set();
  for (const r of obj.results) {
    if (!isPlainObject(r) || !isNonEmptyString(r.id) || typeof r.ok !== 'boolean' || !Number.isInteger(r.code) || Object.keys(r).length !== 3) return { ok: false, reason: 'gate-run: each result must be exactly { id, ok, code } (string, boolean, integer)' };
    if (!declaredIds.has(r.id)) return { ok: false, reason: `gate-run: result id "${r.id}" is not in declared[]` };
    if (resultIds.has(r.id)) return { ok: false, reason: `gate-run: duplicate result id "${r.id}"` };
    resultIds.add(r.id);
  }
  const s = obj.summary;
  if (!isPlainObject(s)) return { ok: false, reason: 'gate-run: summary must be an object' };
  if (Object.keys(s).sort().join(',') !== SUMMARY_KEYS.join(',')) return { ok: false, reason: `gate-run: summary must carry exactly { ${SUMMARY_KEYS.join(', ')} }` };
  const failing = obj.results.filter((r) => !r.ok);
  // The status IS the verdict word: a valid gate-run always carries results, so the runner's
  // vocabulary collapses to ok|fail here — tie it to the failing count (a forged "ok" beside red
  // results must not validate; internal sweep).
  const expectedStatus = failing.length === 0 ? 'ok' : 'fail';
  if (s.status !== expectedStatus) return { ok: false, reason: `gate-run: summary.status must be "${expectedStatus}" for ${failing.length} failing result(s) (got ${JSON.stringify(s.status)})` };
  if (s.gates !== obj.results.length || s.passed !== obj.results.length - failing.length || s.failed !== failing.length) {
    return { ok: false, reason: `gate-run: summary counts do not match results (${s.gates}/${s.passed}/${s.failed} vs ${obj.results.length} results, ${failing.length} failing)` };
  }
  if (!Array.isArray(s.failedIds) || s.failedIds.length !== failing.length || !s.failedIds.every((id, i) => id === failing[i].id)) return { ok: false, reason: 'gate-run: summary.failedIds must equal the failing result ids, in results order' };
  return { ok: true };
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

// validateRecord(obj) → { ok, reason }. The shared frame (schema/loop/activity/kind/round/base/
// fingerprint/timestamp) then the per-kind body. `reason` names the exact failed check so the
// malformed-line surface and the per-check named tests can assert it. Kind vocabulary is
// per-version: `override` exists only under schema >= 3, `gate-run` only under schema >= 4, and
// `base` is a v4-only frame field (older records never grow new kinds OR new fields — D2).
export const validateRecord = (obj) => {
  if (!isPlainObject(obj)) return { ok: false, reason: 'not an object' };
  if (!SUPPORTED_SCHEMAS.has(obj.schema)) return { ok: false, reason: `schema must be one of ${[...SUPPORTED_SCHEMAS].join(', ')}` };
  if (!isNonEmptyString(obj.loop)) return { ok: false, reason: 'missing loop' };
  if (!ACTIVITIES_SET.has(obj.activity)) return { ok: false, reason: `bad activity "${obj.activity}"` };
  if (!KINDS_SET.has(obj.kind) && !(obj.schema >= 3 && obj.kind === 'override') && !(obj.schema >= 4 && obj.kind === 'gate-run')) return { ok: false, reason: `bad kind "${obj.kind}"` };
  // The v4 SEGMENT frame (D1/D2): a v4 record REQUIRES base (null on an unborn branch, else the
  // HEAD sha); a v1..v3 record must NOT carry it — an old record never grows new surface.
  if (obj.schema >= 4) {
    if (!(obj.base === null || isNonEmptyString(obj.base))) return { ok: false, reason: 'a v4 record requires base — null (unborn branch) or the HEAD commit the dirty tree sits on' };
  } else if (obj.base !== undefined) {
    return { ok: false, reason: `base is a v4 frame field — a schema-${obj.schema} record never carries it` };
  }
  // Per-kind frame (D5): a gate-run carries NO round number; every other kind requires one.
  if (obj.kind === 'gate-run') {
    if (obj.round !== undefined) return { ok: false, reason: 'gate-run: a gate-run carries no round number (it is segment-framed, not round-framed)' };
  } else if (!(Number.isInteger(obj.round) && obj.round >= 1)) {
    return { ok: false, reason: 'round must be an integer >= 1' };
  }
  if (!(obj.fingerprint === null || isNonEmptyString(obj.fingerprint))) return { ok: false, reason: 'fingerprint must be null or a non-empty string' };
  if (!isNonEmptyString(obj.timestamp)) return { ok: false, reason: 'missing timestamp' };
  if (obj.kind === 'round') return validateRound(obj);
  if (obj.kind === 'override') return validateOverride(obj, obj.schema);
  if (obj.kind === 'gate-run') return validateGateRun(obj);
  return validateTriage(obj, obj.schema);
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

// filterLoopRecords(records, { activity, loop }) → the records of ONE loop (all kinds), order
// preserved. The gate filters to activity==="plan-execution" AND loop===the in-flight plan stem;
// authoring rounds (and other plans' rounds) never enter the code gate.
export const filterLoopRecords = (records, { activity, loop }) =>
  records.filter((r) => r.activity === activity && r.loop === loop);

// filterSegmentRecords(records, { activity, loop, base }) → the records of ONE segment (D1), order
// preserved. STRICT: only a v4+ record can be a segment member (a v1..v3 record carries no base and
// never enters one — the D7 legacy rule; the schema guard also keeps a defensive undefined base
// from matching a pre-v4 record's absent field, codex R1); records at baseA are invisible at baseB;
// base === null matches only null (an unborn-branch segment).
export const filterSegmentRecords = (records, { activity, loop, base }) =>
  filterLoopRecords(records, { activity, loop }).filter((r) => r.schema >= 4 && r.base === base);

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
