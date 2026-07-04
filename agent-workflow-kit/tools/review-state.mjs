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
//           grounding (fresh:true, artifact "code", grounded:true).
//   exit 1  when a recipe-named backend has no current-fingerprint receipt — including the
//           stale-after-edit case (any tracked/untracked change after the review moves the
//           fingerprint) — or when its only current receipts carry grounded:false (an ungrounded
//           agy review under reviewed/council never satisfies the gate).
// Informational receipts NEVER satisfy (nor fail) the tree check: plan/diff-mode receipts
// (artifact ≠ "code") and continuations (fresh:false — agy --continue/--conversation cannot attest
// a folded tree; only a fresh grounded re-run mints a gate-satisfying receipt).
//
// The fingerprint is the ONE canonical uncommitted-state identity — sha256 over: staged diff +
// unstaged diff + untracked-not-ignored file contents (binary/symlink/non-regular untracked paths
// ride as name-only notes). Domain == the review-payload domain the wrappers assemble; the prose
// definition lives in each bridge's capability.json roles.review.contract.receipt, and the bash
// twin lives in both wrappers — cross-checked by test/review-fingerprint-parity.test.mjs.
//
// HUMAN residual (accepted, documented): `git commit --no-verify` skips any pre-commit gate, and
// deleting/editing the receipt file forges state — receipts live in the git dir (never committable)
// as an honest self-discipline mechanism, not a security boundary.
//
// Read-only: never writes, never commits, never runs a subscription CLI. It DOES spawn `git`
// (read-only queries) to compute the fingerprint — stated honestly in the catalog. Dependency-free,
// Node >= 18. No side effects on import (the isDirectRun idiom).

import { readFileSync, readdirSync, lstatSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { detectBackends } from './detect-backends.mjs';
import { resolveActivityRecipe, planRecipe, DISPLAY_ALIASES } from './recipes.mjs';
import { CONFIG_REL, fail, loadConfig } from './orchestration-config.mjs';

export const RECEIPTS_BASENAME = 'agent-workflow-review-receipts.jsonl';
export const PLANS_REL = 'docs/plans';
const ACTIVITY = 'plan-execution';
const SLOT = 'review';
const GIT_MAX_BUFFER = 256 * 1024 * 1024; // a full-tree diff can be large; never truncate silently

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

// The canonical payload bytes: staged diff + unstaged diff + the untracked-not-ignored section —
// byte-identical to the wrappers' emit_fingerprint_payload (same git invocations, same headers,
// same ls-files ordering), emitted from the work-tree ROOT. Returns null outside a git work tree.
export const computeFingerprintPayload = (cwd) => {
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
      stat = lstatSync(full);
    } catch {
      stat = null;
    }
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
export const computeTreeFingerprint = (cwd) => {
  const payload = computeFingerprintPayload(cwd);
  return payload == null ? null : createHash('sha256').update(payload).digest('hex');
};

// Clean = nothing staged, nothing unstaged, no untracked-not-ignored paths (the wrappers' no-diff
// preflight). null when not decidable (not a git work tree). Anchored at the work-tree ROOT like
// the fingerprint: `git ls-files --others` is cwd-SCOPED, so a subdirectory invocation would
// otherwise miss root/sibling untracked paths and report a dirty tree as clean (codex R1 finding).
export const isTreeClean = (cwd) => {
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null) return null;
  const staged = gitRaw(['diff', '--cached', '--quiet'], top);
  const unstaged = gitRaw(['diff', '--quiet'], top);
  if (staged.error || unstaged.error || staged.status > 1 || unstaged.status > 1) return null;
  const untracked = gitBuf(['ls-files', '--others', '--exclude-standard'], top);
  if (untracked == null) return null;
  return staged.status === 0 && unstaged.status === 0 && untracked.toString('utf8').trim() === '';
};

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

// Parse the receipt file → { receipts, malformed }. Absent file → empty (not an error: no review
// ever ran). A malformed line is counted + reported, never silently dropped.
export const readReceipts = (path, readFile = readFileSync) => {
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch {
    return { receipts: [], malformed: 0 };
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

// A receipt that can satisfy the tree check: a FRESH code-mode receipt for the current fingerprint.
// Plan/diff-mode receipts and continuations are informational-only (see the header contract).
const satisfies = (receipt, fingerprint) =>
  receipt.fresh === true && receipt.artifact === 'code' && receipt.fingerprint === fingerprint;

// Per-backend receipt status for the current fingerprint:
//   current    — a satisfying receipt with grounded:true exists (its latest verdict reported);
//   ungrounded — current-fingerprint fresh receipts exist but every one carries grounded:false;
//   stale      — this backend has receipts, none for the current fingerprint (edited after review);
//   missing    — no usable receipt from this backend at all.
export const backendReceiptStatus = (receipts, backend, fingerprint) => {
  const own = receipts.filter((r) => r.backend === backend);
  const current = own.filter((r) => satisfies(r, fingerprint));
  const grounded = current.filter((r) => r.grounded === true);
  if (grounded.length > 0) {
    const latest = grounded[grounded.length - 1];
    return { state: 'current', verdict: latest.verdict ?? 'unknown', grounded: true, timestamp: latest.timestamp ?? null };
  }
  if (current.length > 0) {
    const latest = current[current.length - 1];
    return { state: 'ungrounded', verdict: latest.verdict ?? 'unknown', grounded: false, timestamp: latest.timestamp ?? null };
  }
  return { state: own.length > 0 ? 'stale' : 'missing', verdict: null, grounded: null, timestamp: null };
};

// ── the check + report core ─────────────────────────────────────────────────────────

// buildState({ cwd, env, detect }) → everything both renders need. Pure I/O at the edges.
// EVERY project-relative read (orchestration config, docs/plans, receipts) anchors at the git
// work-tree ROOT when one exists — the fingerprint is root-anchored, so a subdirectory invocation
// must read the same config/plans or a dirty unreceipted tree could false-PASS as "no plan in
// flight" (codex R1 finding). Outside a git tree the cwd is the only anchor (and --check exits 0).
export const buildState = ({ cwd, env = process.env, detect = detectBackends } = {}) => {
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
  const fingerprint = computeTreeFingerprint(cwd);
  const clean = fingerprint == null ? null : isTreeClean(cwd);
  const receiptsPath = resolveReceiptsPath(cwd, env);
  const { receipts, malformed } = receiptsPath ? readReceipts(receiptsPath) : { receipts: [], malformed: 0 };
  const backends = requiredBackends.map((b) => ({ backend: b, ...backendReceiptStatus(receipts, b, fingerprint) }));
  return {
    resolved,
    configSource,
    requiredBackends,
    backends,
    plans,
    fingerprint,
    clean,
    receiptsPath,
    receiptCount: receipts.length,
    malformed,
    detectionWarning,
  };
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
  const failing = state.backends.filter((b) => b.state !== 'current');
  if (failing.length === 0) {
    return { code: 0, reason: `every recipe-named backend has a fresh grounded receipt for the current tree (${state.requiredBackends.join(' + ')})${malformedNote}` };
  }
  const parts = failing.map((b) => {
    if (b.state === 'ungrounded') return `${b.backend}: only ungrounded receipts for the current tree — re-run grounded (--facts)`;
    if (b.state === 'stale') return `${b.backend}: receipts exist but none matches the current tree (edited after review) — run a fresh review`;
    return `${b.backend}: no receipt — run its review wrapper`;
  });
  return { code: 1, reason: `${parts.join('; ')}${malformedNote}` };
};

// ── rendering ───────────────────────────────────────────────────────────────────────

const STATE_GLYPH = { current: '✓', ungrounded: '✗', stale: '✗', missing: '✗' };

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
  for (const b of state.backends) {
    const detail =
      b.state === 'current'
        ? `current (verdict: ${b.verdict}, grounded, ${b.timestamp ?? '?'})`
        : b.state === 'ungrounded'
          ? `ungrounded for the current tree (verdict: ${b.verdict}) — a grounded fresh run is required`
          : b.state === 'stale'
            ? 'stale — no receipt matches the current tree (edited after review)'
            : 'missing — no receipt from this backend';
    lines.push(`    ${STATE_GLYPH[b.state]} ${b.backend}: ${detail}`);
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
(fresh:false) are informational-only — they never satisfy the tree check.

--check exits 0/1 per the normative contract in the tool header: 0 for solo / no plan in flight /
a clean tree / not-a-git-tree / all recipe-named backends receipted-current-and-grounded; 1 when a
recipe-named backend is missing, stale (edited after review), or grounded:false under
reviewed/council. Declare it as a project gate by hand (docs/ai/gates.json) or via the
explicit-consent seeder (tools/seed-gates.mjs) — never without consent.

Read-only: never writes, never commits, never runs a subscription CLI; spawns read-only git queries.
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
    const state = buildState({ cwd, env, detect });
    const check = decideCheck(state);
    if (argv.includes('--json')) {
      return { code: argv.includes('--check') ? check.code : 0, stdout: JSON.stringify({ ...state, check }, null, 2), stderr: '' };
    }
    if (argv.includes('--check')) {
      return { code: check.code, stdout: `review-state check: ${check.code === 0 ? 'PASS' : 'FAIL'} — ${check.reason}`, stderr: '' };
    }
    return { code: 0, stdout: formatHuman(state, check), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `review-state: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  // Exact writes + a natural exit: process.exit() can truncate unflushed piped stdio (codex R2).
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
