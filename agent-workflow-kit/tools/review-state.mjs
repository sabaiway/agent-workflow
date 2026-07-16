#!/usr/bin/env node
// review-state.mjs — the read-only review-receipt checker behind `/agent-workflow-kit review-state`
// (AD-038). It makes "reviewed ≠ shipped" mechanically detectable: the bridge review wrappers
// (codex-review / agy-review ≥2.2.0) append one receipt line per successful review; this tool
// resolves the effective `plan-execution.review` recipe (the advisor's single-source readers),
// recomputes the CURRENT canonical uncommitted-state fingerprint, and reports — per recipe-named
// backend — whether a FRESH, grounded, current-fingerprint receipt exists. `--check` turns the
// report into a gate exit code (declare it in docs/ai/gates.json — by hand OR via the
// explicit-consent seeder, tools/seed-gates.mjs — never without consent, AD-021/AD-042).
//
// Normative `--check` exit contract (the single home of this list — SKILL.md points here):
//   exit 0  when the resolved plan-execution.review recipe is solo (configured, or degraded there —
//           i.e. no reviewer backend is ready); when no plan is in flight (docs/plans/ holds no
//           top-level .md that is not queue.md and not scratch by the naming convention: prefixes
//           EXECUTE- / FEEDBACK-, or a name containing PROMPT / prompt / handoff); when the tree is
//           clean (nothing to review); when the cwd is not a git work tree (nothing to fingerprint);
//           and when EVERY recipe-named backend has a current-fingerprint receipt with acceptable
//           grounding (fresh:true, artifact "code", grounded:true) OR is degraded-exempt: the current
//           plan-execution SEGMENT's latest review-ledger round records that backend degraded:true at
//           the current tree fingerprint, with >= 1 non-degraded recipe-named backend present with a
//           current grounded receipt and the ledger reading clean (AD-050; MIRRORS review-ledger
//           decideStop's degraded handling — presence, not unanimity, never a 0/0-counts gate).
//   exit 1  when a recipe-named backend has no current-fingerprint receipt AND is not degraded-exempt —
//           including the stale-after-edit case (any tracked/untracked change after the review moves the
//           fingerprint) — or when its only current receipts carry grounded:false AND it is not
//           degraded-exempt (an ungrounded agy review under reviewed/council never satisfies the gate on
//           its own — but a recorded current-tree degrade still exempts it). An unreadable/malformed
//           review-ledger DENIES the degraded exemption (fail-closed) but NEVER fails a tree whose
//           receipts independently satisfy the gate (that stays exit 0, the ledger issue surfaced).
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
// Node >= 18. No side effects on import (the isDirectRun idiom).

import { readFileSync, readdirSync, lstatSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { detectBackends } from './detect-backends.mjs';
import { resolveActivityRecipe, planRecipe, DISPLAY_ALIASES } from './recipes.mjs';
import { CONFIG_REL, fail, loadConfig } from './orchestration-config.mjs';
// The NEUTRAL ledger read-core (AD-050): review-state reads the review-ledger ONLY for the degraded
// exemption, through the neutral core — never review-ledger.mjs (which imports THIS module, the cycle).
import {
  resolveLedgerPath,
  resolveBase,
  readLedger,
  filterSegmentRecords,
  roundSequenceIntact,
  summarizeReviewReceiptsForTree,
} from './review-ledger-core.mjs';

export const RECEIPTS_BASENAME = 'agent-workflow-review-receipts.jsonl';
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

// ── the canonical fingerprint (node twin of the wrappers' bash implementation) ──────

// First 8 KiB contain a NUL byte → binary (git's own heuristic; mirrors the wrappers' is_binary).
const isBinaryFile = (path) => {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

// The never-committable untracked stat classes (Decision 1, AD-044 Plan 4): character/block
// devices, FIFOs, sockets — git content can never carry them, so they are excluded from the ENTIRE
// review domain (fingerprint payload, clean check; the wrappers' bash twin filters the assembled
// payload identically). lstat-keyed by design: the sandbox mask class surfaces exactly where the
// dirent LIES (readdir says file, lstat says char device). A null stat (vanished path) is NOT in
// the class — it keeps its name-only note, like directories (gitlinks) and symlinks.
export const isNeverCommittableStat = (stat) =>
  stat != null &&
  (stat.isCharacterDevice() || stat.isBlockDevice() || stat.isFIFO() || stat.isSocket());

// The canonical payload bytes: staged diff + unstaged diff + the untracked-not-ignored section —
// byte-identical to the wrappers' emit_fingerprint_payload (same git invocations, same headers,
// same ls-files ordering), emitted from the work-tree ROOT. Returns null outside a git work tree.
// The lstat is injectable ONLY so tests can prove the never-committable filter non-vacuously (a
// lying lstat over a git-visible fixture path — the sandbox mechanism itself); production callers
// never pass it.
export const computeFingerprintPayload = (cwd, { lstat = lstatSync } = {}) => {
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) return null;
  const staged = gitBuf(['diff', '--cached', '--no-ext-diff'], top);
  const unstaged = gitBuf(['diff', '--no-ext-diff'], top);
  const untrackedZ = gitBuf(['ls-files', '--others', '--exclude-standard', '-z'], top);
  if (staged == null || unstaged == null || untrackedZ == null) return null;
  const chunks = [staged, unstaged];
  for (const rel of untrackedZ.toString('utf8').split('\0').filter(Boolean)) {
    const full = join(top, rel);
    let stat = null;
    try {
      stat = lstat(full);
    } catch {
      stat = null;
    }
    if (isNeverCommittableStat(stat)) continue;
    if (stat?.isSymbolicLink()) {
      let target = '?';
      try {
        target = readlinkSync(full);
      } catch {
        target = '?';
      }
      chunks.push(Buffer.from(`untracked-symlink:${rel} -> ${target}\n`));
    } else if (!stat?.isFile()) {
      chunks.push(Buffer.from(`untracked-nonregular:${rel}\n`));
    } else if (isBinaryFile(full)) {
      chunks.push(Buffer.from(`untracked-binary:${rel}\n`));
    } else {
      chunks.push(Buffer.from(`untracked:${rel}\n`));
      chunks.push(readFileSync(full));
    }
  }
  return Buffer.concat(chunks);
};

// sha256 hex of the canonical payload, or null outside a git work tree.
export const computeTreeFingerprint = (cwd, fsx) => {
  const payload = computeFingerprintPayload(cwd, fsx);
  return payload == null ? null : createHash('sha256').update(payload).digest('hex');
};

// Clean = nothing staged, nothing unstaged, no REVIEWABLE untracked-not-ignored paths (the
// wrappers' no-diff preflight). Never-committable untracked paths (device/FIFO/socket) do not
// count as dirty — same filter as the fingerprint, so the two can never disagree about a
// masks-only tree. An lstat failure keeps the path in the domain (dirty), mirroring the
// fingerprint's null-stat note. null when not decidable (not a git work tree). Anchored at the
// work-tree ROOT like the fingerprint: `git ls-files --others` is cwd-SCOPED, so a subdirectory
// invocation would otherwise miss root/sibling untracked paths and report a dirty tree as clean
// (codex R1 finding).
export const isTreeClean = (cwd, { lstat = lstatSync } = {}) => {
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) return null;
  const staged = gitRaw(['diff', '--cached', '--quiet'], top);
  const unstaged = gitRaw(['diff', '--quiet'], top);
  if (staged.error || unstaged.error || staged.status > 1 || unstaged.status > 1) return null;
  const untrackedZ = gitBuf(['ls-files', '--others', '--exclude-standard', '-z'], top);
  if (untrackedZ == null) return null;
  const reviewable = untrackedZ
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => {
      try {
        return !isNeverCommittableStat(lstat(join(top, rel)));
      } catch {
        return true;
      }
    });
  return staged.status === 0 && unstaged.status === 0 && reviewable.length === 0;
};

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

// ── receipts ───────────────────────────────────────────────────────────────────────

export const resolveReceiptsPath = (cwd, env = process.env) => {
  if (env.AW_REVIEW_RECEIPTS) return env.AW_REVIEW_RECEIPTS;
  const gitDir = gitLine(['rev-parse', '--absolute-git-dir'], cwd);
  return gitDir == null ? null : join(gitDir, RECEIPTS_BASENAME);
};

// Parse the receipt file → { receipts, malformed, readError? }. Absent file → empty (not an
// error: no review ever ran). A NON-ENOENT read failure surfaces as readError — an unreadable
// store must never silently read as "no receipts" (the core-evidence summary withholds its
// verdicts section on it). A malformed line is counted + reported, never silently dropped.
export const readReceipts = (path, readFile = readFileSync) => {
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { receipts: [], malformed: 0 };
    return { receipts: [], malformed: 0, readError: (err && err.code) || (err && err.message) || 'read failed' };
  }
  const receipts = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.backend === 'string') receipts.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { receipts, malformed };
};

// Per-backend receipt status for the current fingerprint, over the ONE shared attesting-receipt
// predicate (review-ledger-core) that the round cross-check and the round writer read too — two
// gates disagreeing about what counts as an attestation is the class AD-050 closed:
//   current    — an ATTESTING receipt exists (fresh code, probe:false, grounded) — its verdict rides;
//   ungrounded — real (probe:false) current receipts exist but every one carries grounded:false;
//   probe      — current receipts exist and EVERY one is a well-formed probe (D3);
//   rejected   — current receipts exist, none attests, and >=1 marker was malformed or absent;
//   stale      — this backend has receipts, none for the current fingerprint (edited after review);
//   missing    — no receipt from this backend at all.
// The counts state what was dropped, so a PASS over a partially-excluded set still says so
// (No-silent-failures) and the --json surface can show it.
export const backendReceiptStatus = (receipts, backend, fingerprint) => {
  const own = receipts.filter((r) => r.backend === backend);
  const summary = summarizeReviewReceiptsForTree(own, fingerprint);
  const counts = {
    probeExcluded: summary.probeExcluded,
    markerRejected: summary.markerRejected,
    unmarkedRejected: summary.unmarkedRejected,
  };
  if (summary.state === 'current') {
    return { state: 'current', verdict: summary.receipt.verdict ?? 'unknown', grounded: true, timestamp: summary.receipt.timestamp ?? null, ...counts };
  }
  if (summary.state === 'ungrounded') {
    return { state: 'ungrounded', verdict: summary.receipt.verdict ?? 'unknown', grounded: false, timestamp: summary.receipt.timestamp ?? null, ...counts };
  }
  if (summary.state === 'probe' || summary.state === 'rejected') {
    return { state: summary.state, verdict: null, grounded: null, timestamp: null, ...counts };
  }
  return { state: own.length > 0 ? 'stale' : 'missing', verdict: null, grounded: null, timestamp: null, ...counts };
};

// ── the degraded exemption (AD-050): read the review-ledger for a recorded current-tree degrade ────

// degradedExemptSet(args) → the Set of recipe-named backends EXEMPT from --check because the current
// segment's LATEST round records them degraded at the current tree fingerprint. It MIRRORS review-ledger
// decideStop's degraded handling: a backend WITHOUT a current grounded code receipt is exempt IFF
// (i) exactly one plan is in flight (else the loop is ambiguous — the exempt set is empty, NO fail-closed
// exit-1 arm) AND the ledger reads clean (a readError / malformed line DENIES the exemption, fail-closed);
// (ii) the segment (activity=plan-execution, loop, base=resolveBase) has >=1 round with an intact
// sequence; (iii) its LATEST round records THAT backend degraded; (iv) that round's fingerprint equals
// the CURRENT tree (the degrade attests THIS tree); (v) >=1 NON-degraded recipe-named backend is present
// with a current grounded receipt (never everyone degraded). It is VERDICT-BLIND — it mirrors only the
// PRESENCE half of decideStop (nonDegradedReq >= 1), never its 0/0 counts (Decision 7).
export const degradedExemptSet = ({ records, readError, malformed, base, plans, currentFingerprint, requiredBackends, backends }) => {
  const empty = new Set();
  if (plans.length !== 1) return empty; // (i) ambiguous loop → exemption suppressed (no fail-closed exit-1 arm)
  if (readError || malformed > 0) return empty; // fail-closed: a corrupt ledger denies the exemption
  if (currentFingerprint == null) return empty;
  const loop = plans[0].replace(/\.md$/, '');
  const rounds = filterSegmentRecords(records, { activity: ACTIVITY, loop, base }).filter((r) => r.kind === 'round');
  if (rounds.length === 0) return empty; // (ii) empty segment → nothing recorded yet
  if (!roundSequenceIntact(rounds)) return empty; // (ii) corrupt sequence → fail closed
  const latest = rounds[rounds.length - 1];
  if (latest.fingerprint !== currentFingerprint) return empty; // (iv) the degrade must attest THIS tree
  // Mirror decideStop's PRESENCE discipline (review-ledger.mjs): EVERY recipe-named backend must be IN
  // the latest round (allPresent) — a backend absent from the round reviewed nothing there, so a stray
  // current receipt for a NON-recorded backend can never justify the exemption (codex R1: else a
  // degrade-only round `[{agy degraded}]` + any current codex receipt would exempt agy, disagreeing
  // with review-ledger, whose decideStop fails allPresent on the absent codex).
  const entryFor = (rb) => latest.backends.find((b) => b.backend === rb);
  if (!requiredBackends.every((rb) => entryFor(rb) !== undefined)) return empty;
  const receiptCurrent = new Set(backends.filter((b) => b.state === 'current').map((b) => b.backend));
  // (v) >=1 non-degraded recipe-named backend PRESENT in the latest round with a current grounded
  // receipt — never all degraded (mirrors decideStop's nonDegradedReq >= 1, plus review-state's own
  // "it really reviewed" = a current receipt).
  if (!requiredBackends.some((rb) => { const e = entryFor(rb); return e && !e.degraded && receiptCurrent.has(rb); })) return empty;
  // (iii) exempt each recipe-named backend the latest round records degraded.
  return new Set(requiredBackends.filter((rb) => { const e = entryFor(rb); return e && e.degraded === true; }));
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
    detectionWarning = `backend detection failed (${(err && err.message) || err}) — treating all backends as not ready; the review recipe floors at solo.`;
  }
  const resolved = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity: ACTIVITY, slot: SLOT });
  const { dispatch } = planRecipe(resolved.recipe, detection);
  const requiredBackends = dispatch.map((d) => DISPLAY_ALIASES[d.backend] ?? d.backend);
  const plans = plansInFlight(root);
  // The injected lstat threads through EVERY stat-dependent computation (fingerprint, clean, the
  // mask count) — a partial injection would let a test observe an inconsistent state (codex R3).
  const fingerprint = computeTreeFingerprint(cwd, { lstat });
  const clean = fingerprint == null ? null : isTreeClean(cwd, { lstat });
  const receiptsPath = resolveReceiptsPath(cwd, env);
  const { receipts, malformed } = receiptsPath ? readReceipts(receiptsPath) : { receipts: [], malformed: 0 };
  const backends = requiredBackends.map((b) => ({ backend: b, ...backendReceiptStatus(receipts, b, fingerprint) }));
  // The degraded exemption (AD-050): read the review-ledger ONLY here, ONLY for the exemption — the
  // whole gate never depends on the ledger (a corrupt ledger fails the exemption CLOSED, never a tree
  // whose receipts independently satisfy the gate; Decision 3). base/ledger locate the current segment.
  const base = resolveBase(cwd);
  const ledgerPath = resolveLedgerPath(cwd, env);
  const { records, malformed: ledgerMalformed, readError: ledgerReadError } = ledgerPath ? readLedger(ledgerPath) : { records: [], malformed: 0 };
  const degradedExempt = [...degradedExemptSet({ records, readError: ledgerReadError, malformed: ledgerMalformed, base, plans, currentFingerprint: fingerprint, requiredBackends, backends })];
  return {
    resolved,
    configSource,
    requiredBackends,
    backends,
    plans,
    root,
    fingerprint,
    clean,
    receiptsPath,
    receiptCount: receipts.length,
    malformed,
    base,
    ledgerPath,
    ledgerMalformed: ledgerMalformed ?? 0,
    ledgerReadError: ledgerReadError ?? null,
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
  return parts.join(' + ');
};

// The normative --check decision (the header contract, in order). → { code, reason }.
export const decideCheck = (state) => {
  // A DETECTOR FAILURE is unknown state, not "no reviewer ready" — the advisory tools warn and
  // floor at solo, but a GATE must fail closed (codex R2+R3 findings): a broken detector would
  // otherwise disable the receipt requirement both for a configured non-solo recipe AND for a
  // default-config project (whose computed default would be `reviewed` had a backend been ready —
  // unknowable while the detector is down). The ONLY detector-independent green is an EXPLICIT
  // configured solo (that project asked for no reviewer, readiness is irrelevant to it).
  const explicitSolo = state.resolved.recipe === 'solo' && state.resolved.source === 'config' && !state.resolved.degradedFrom;
  if (state.detectionWarning && !explicitSolo) {
    return { code: 1, reason: `cannot verify receipts — ${state.detectionWarning}` };
  }
  if (state.resolved.recipe === 'solo') {
    const why = state.resolved.degradedFrom
      ? `resolved ${ACTIVITY}.${SLOT} recipe degrades to solo here (${state.resolved.reason})`
      : `resolved ${ACTIVITY}.${SLOT} recipe is solo`;
    return { code: 0, reason: `${why} — no receipt required` };
  }
  if (state.plans.length === 0) return { code: 0, reason: 'no plan in flight (docs/plans/ holds no active plan) — no receipt required' };
  if (state.fingerprint == null) return { code: 0, reason: 'not a git work tree — nothing to fingerprint' };
  if (state.clean === true) return { code: 0, reason: 'the working tree is clean — nothing to review' };
  // A malformed receipt line is never silently ignored (No-silent-failures Hard Constraint): it
  // cannot fail the gate by itself (a forged/corrupt line must not brick commits), but the check
  // line always names it so a PASS over a partially-corrupt file is visible.
  const malformedNote = state.malformed > 0 ? ` — ${state.malformed} malformed receipt line(s) ignored; inspect ${state.receiptsPath}` : '';
  // The review-ledger is consulted ONLY for the degraded exemption; a corrupt ledger DENIES it
  // (fail-closed) but never fails a tree the receipts independently satisfy — surfaced either way
  // (No-silent-failures; Decision 3).
  const ledgerNote = state.ledgerReadError
    ? ` — review ledger unreadable (${state.ledgerReadError}); degraded exemption unavailable (fail-closed) — inspect ${state.ledgerPath}`
    : state.ledgerMalformed > 0
      ? ` — review ledger has ${state.ledgerMalformed} malformed line(s); degraded exemption unavailable (fail-closed) — inspect ${state.ledgerPath}`
      : '';
  // The degraded exemption (AD-050): a backend recorded degraded for the current tree is excluded from
  // `failing` (it reviewed nothing to receipt — MIRRORS decideStop excluding a degraded backend). It
  // stays verdict-blind: the exemption proves the degrade was RECORDED, never that the tree converged.
  const exempt = new Set(state.degradedExempt);
  const failing = state.backends.filter((b) => b.state !== 'current' && !exempt.has(b.backend));
  // A receipt dropped for an untrustworthy probe marker is never silently dropped either (D3): it
  // cannot fail a tree that other receipts satisfy, but a report over a partially-rejected set says
  // so. It counts only the exclusions NOT already named per backend — a FAILING `rejected` backend
  // prints its own cause below, and repeating it in the summary is noise. Every other exclusion (a
  // partial one on a satisfied backend, or one on a degraded-exempt backend) still needs a voice.
  const namedPerBackend = new Set(failing.filter((b) => b.state === 'rejected').map((b) => b.backend));
  const untrustedTotal = state.backends
    .filter((b) => !namedPerBackend.has(b.backend))
    .reduce((n, b) => n + (b.markerRejected ?? 0) + (b.unmarkedRejected ?? 0), 0);
  const markerNote = untrustedTotal > 0
    ? ` — ${untrustedTotal} receipt(s) rejected: an untrustworthy probe marker (malformed, or absent — silence is not a declaration) — fail-closed; inspect ${state.receiptsPath}`
    : '';
  if (failing.length === 0) {
    if (exempt.size === 0) {
      return { code: 0, reason: `every recipe-named backend has a fresh grounded receipt for the current tree (${state.requiredBackends.join(' + ')})${markerNote}${malformedNote}${ledgerNote}` };
    }
    return { code: 0, reason: `every recipe-named backend reviewed the current tree (${state.requiredBackends.join(' + ')}) — degraded-exempt (recorded degraded for the current tree in the review ledger): ${[...exempt].join(', ')}${markerNote}${malformedNote}${ledgerNote}` };
  }
  const parts = failing.map((b) => {
    if (b.state === 'ungrounded') return `${b.backend}: only ungrounded receipts for the current tree — re-run grounded (--facts)`;
    if (b.state === 'probe') return `${b.backend}: only probe receipts for the current tree (CODEX_PROBE=1 / AGY_PROBE=1 relaxes the quality guards) — a probe review never attests; re-run a real one`;
    if (b.state === 'rejected') return `${b.backend}: current-tree receipts rejected — ${rejectionCause(b)} (fail-closed); inspect ${state.receiptsPath}`;
    if (b.state === 'stale') return `${b.backend}: receipts exist but none matches the current tree (edited after review) — run a fresh review`;
    return `${b.backend}: no receipt — run its review wrapper`;
  });
  return { code: 1, reason: `${parts.join('; ')}${markerNote}${malformedNote}${ledgerNote}` };
};

// ── rendering ───────────────────────────────────────────────────────────────────────

const STATE_GLYPH = { current: '✓', ungrounded: '✗', probe: '✗', rejected: '✗', stale: '✗', missing: '✗' };

const formatHuman = (state, check) => {
  const src = state.resolved.source === 'config' ? `from ${CONFIG_REL}` : 'computed default';
  const lines = [
    `review-state — ${ACTIVITY}.${SLOT} = ${state.resolved.recipe} (${src})${state.requiredBackends.length ? ` → ${state.requiredBackends.join(' + ')}` : ''}`,
  ];
  if (state.detectionWarning) lines.push(`  ⚠ ${state.detectionWarning}`);
  lines.push(`  plan in flight: ${state.plans.length ? state.plans.join(', ') : '(none)'}`);
  if (state.fingerprint == null) lines.push('  tree: not a git work tree');
  else if (state.clean === true) lines.push('  tree: clean (nothing to review)');
  else lines.push(`  tree fingerprint: ${state.fingerprint}`);
  lines.push(`  receipts: ${state.receiptsPath ?? '(unresolvable — no git dir)'} (${state.receiptCount} line(s)${state.malformed ? `, ${state.malformed} malformed — inspect the file` : ''})`);
  if (state.ledgerReadError) lines.push(`  ⚠ review ledger unreadable (${state.ledgerReadError}) — degraded exemption unavailable`);
  else if (state.ledgerMalformed) lines.push(`  ⚠ review ledger: ${state.ledgerMalformed} malformed line(s) — degraded exemption unavailable`);
  const exempt = new Set(state.degradedExempt);
  for (const b of state.backends) {
    const exemptTag = exempt.has(b.backend) ? ' — degraded-exempt (recorded degraded in the review ledger for the current tree)' : '';
    const detail =
      b.state === 'current'
        ? `current (verdict: ${b.verdict}, grounded, ${b.timestamp ?? '?'})`
        : b.state === 'ungrounded'
          ? `ungrounded for the current tree (verdict: ${b.verdict}) — a grounded fresh run is required`
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
    lines.push(`    ${exempt.has(b.backend) ? '⊘' : STATE_GLYPH[b.state]} ${b.backend}: ${detail}${excludedTag}${exemptTag}`);
  }
  lines.push(`  check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`);
  return lines.join('\n');
};

const HELP = `review-state — read-only review-receipt checker (agent-workflow family, AD-038).

Usage:
  node review-state.mjs [--check] [--json]

Resolves the effective ${ACTIVITY}.${SLOT} recipe (${CONFIG_REL} + the read-only backend detector),
recomputes the canonical uncommitted-state fingerprint (staged + unstaged + untracked-not-ignored —
the review-payload domain), reads the receipt file the review wrappers append to
(<git dir>/${RECEIPTS_BASENAME}; AW_REVIEW_RECEIPTS overrides), and reports per-backend receipt
presence + verdict + grounding for the CURRENT tree. Plan/diff-mode receipts and continuations
(fresh:false) are informational-only — they never satisfy the tree check, and neither does a PROBE
receipt (probe:true — a CODEX_PROBE=1 / AGY_PROBE=1 run has the quality guards off). The probe
filter is per receipt, so a real receipt at the same fingerprint still satisfies. Every marker-aware
wrapper writes the probe field on EVERY review (true or false), so a malformed OR absent marker is
rejected fail-closed — silence is not a declaration.

--check exits 0/1 per the normative contract in the tool header: 0 for solo / no plan in flight /
a clean tree / not-a-git-tree / all recipe-named backends receipted-current-and-grounded OR
degraded-exempt (a recorded current-tree degrade in the review-ledger for that backend; AD-050); 1 when
a recipe-named backend is missing, stale (edited after review), or grounded:false under reviewed/council
AND is not degraded-exempt. Declare it as a project gate by hand (docs/ai/gates.json) or via the
explicit-consent seeder (tools/seed-gates.mjs) — never without consent.

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

// ── --await: block until every recipe-named backend has receipted the current tree ─────
// (BUGFREE-3 / AD-049, item (d)). It waits for every recipe-named backend to be SATISFIED — a fresh
// grounded current-tree receipt, OR (AD-050) the degraded exemption: once a current-tree degrade is
// RECORDED in the review-ledger, --await stops waiting for that backend and returns READY (before,
// it waited forever for a receipt that never comes). It inherits the exemption for FREE — it polls
// the SAME decideCheck(buildState()) `--check` computes. The completion signal is the RECEIPT (i.e.
// `--check` would PASS), NEVER a process event — a harness "completed" notification fires early and a
// bridge's output late-flushes, so polling a pid/receipt-file is the durable mechanization of
// receipts-not-pgrep. Stays read-only (it only re-reads state — now the ledger too, a few KB per
// tick); the clock is injectable (ctx.now / ctx.sleep / ctx.pollMs) so hermetic tests never spend
// wall-clock.

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
