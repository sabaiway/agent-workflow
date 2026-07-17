#!/usr/bin/env node
// coverage-check.mjs — the D3(c)+(d) final-run checker (strip-the-kit 2.3). ONE deterministic
// read-only check over two evidence sources:
//   • COVERAGE (D3(d)): the suite leaves an lcov file at ONE FIXED kit-owned path —
//     <git dir>/agent-workflow-lcov.info (inside the git dir it sits outside the fingerprint
//     domain and is never committable by construction). Uncovered CHANGED executable Node lines
//     are LISTED file:line and fail; a changed file ABSENT from the coverage map is a file-level
//     red (never "non-executable by silence"); changed out-of-domain files are LISTED (the claim
//     is narrowed to Node executable lines — stated, never silently widened or greened); a repo
//     with NO lcov at the path is a LOUD `skipped-no-lcov`, never a silent green; the path is
//     lstat'd no-follow — a symlink is a refusal.
//   • RED PROOF (D3(c)): every authoritative red-proof record at the CURRENT base must hold NOW —
//     the bound test file exists, its content hash is unchanged (custody), the testId resolves to
//     >=1 test and runs GREEN N/N, and the record's PRE-FIX fingerprint differs from the current
//     tree (an equal fingerprint means nothing changed since the red — reuse/forgery, refused).
//     Deleted-test and zero-match guards ride the same bound set. A malformed evidence store
//     fails CLOSED (the obligations are unknown).
// Every refusal names its locations (file:line / testId) — never a bare count.
//
// Read-only: never writes; spawns read-only git queries + the bound-test probes (node --test).
// Dependency-free, Node >= 18. No side effects on import.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeChangedSurface } from './changed-surface.mjs';
import { lcovCoveredMap, uncoveredChangedFromLcov } from './lcov.mjs';
import {
  computeTreeFingerprint,
  resolveBase,
  resolveEvidencePath,
  readEvidence,
  authoritativeOfKind,
  resolveTestFile,
  hashFileBytes,
  defaultBoundArgv,
  parseProbeOutput,
  childTestEnv,
  probeKnobsFromEnv,
  splitTestId,
} from './core-evidence.mjs';

export const COVERAGE_CHECK_STOP = 'COVERAGE_CHECK_STOP';
const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });

export const LCOV_BASENAME = 'agent-workflow-lcov.info';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8').replace(/\r?\n$/, '');
};

// AW_LCOV_FILE overrides (tests); else <git dir>/basename — resolved via the TRUE git dir (in a
// worktree `.git` is a FILE, a hardcoded path would ENOTDIR); null outside a git work tree.
export const resolveLcovPath = (cwd, env = process.env) => {
  if (env.AW_LCOV_FILE) return env.AW_LCOV_FILE;
  const gitDir = gitLine(['rev-parse', '--absolute-git-dir'], cwd);
  return gitDir == null ? null : join(gitDir, LCOV_BASENAME);
};

// ── the coverage arm (D3(d)) ──────────────────────────────────────────────────────────────────────

// checkCoverage({ rootTop, lcovPath }) → { failures: ["file:line"...], notes: [...], skipped,
// lcovSha256 } — the sha is of the EXACT bytes this check consumed (read once), so the final-run
// receipt can bind what was CHECKED, not what happens to sit on disk later (M2, round 1).
const checkCoverage = ({ rootTop, lcovPath }) => {
  const notes = [];
  const failures = [];
  let st = null;
  try {
    st = lstatSync(lcovPath);
  } catch {
    st = null;
  }
  if (st == null) {
    return { failures, notes: [`skipped-no-lcov: no lcov file at ${lcovPath} — NO coverage check ran (produce it via the declared unit-tests gate cmd's lcov reporters)`], skipped: true, lcovSha256: null };
  }
  if (!st.isFile()) {
    failures.push(`${lcovPath}: not a regular file (a symlink/device is never read — fail closed)`);
    return { failures, notes, skipped: false, lcovSha256: null };
  }
  const surface = computeChangedSurface(rootTop);
  const lcovBytes = readFileSync(lcovPath);
  const lcovSha256 = createHash('sha256').update(lcovBytes).digest('hex');
  const covered = lcovCoveredMap(lcovBytes.toString('utf8'), rootTop);
  for (const [rel, lines] of surface.assessable) {
    const key = keyFor(rootTop, rel);
    const uncovered = uncoveredChangedFromLcov(covered, key, lines);
    if (uncovered === null) {
      failures.push(`${rel}: absent from coverage — the suite never executed this changed file`);
      continue;
    }
    for (const n of uncovered) failures.push(`${rel}:${n}`);
  }
  if (surface.outOfDomain.length > 0) {
    notes.push(`out-of-domain changed files (no Node-line coverage claim; covered by their own suites): ${surface.outOfDomain.join(', ')}`);
  }
  if (surface.unsupported.length > 0) {
    notes.push(`unsupported-source changed files (outside the narrowed Node domain): ${surface.unsupported.join(', ')}`);
  }
  return { failures, notes, skipped: false, lcovSha256 };
};

// lcovCoveredMap canonicalizes SF paths with realpath — the lookup key must mirror it. On an
// unresolvable path (deleted between the surface pass and here) the lexical abs stands in, which
// then reads as absent-from-map → a file-level red, never a silent skip. Exported as a test seam.
export const keyFor = (rootTop, rel) => {
  const abs = join(rootTop, rel);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
};

// ── the red-proof verification arm (D3(c)) ────────────────────────────────────────────────────────

// verifyRedProofs({ rootTop, cwd, env }) → { failures: [...], verified: n } | { storeFailure }.
const verifyRedProofs = ({ rootTop, cwd, env }) => {
  const storePath = resolveEvidencePath(cwd, env);
  const read = storePath ? readEvidence(storePath) : { records: [], malformed: 0, malformedReasons: [] };
  if ((read.malformed ?? 0) > 0 || read.readError) {
    return { storeFailure: `evidence store unavailable (${read.malformed} malformed line(s)${read.readError ? `, read error: ${read.readError}` : ''}) — the red-proof obligations are unknown (fail closed); inspect ${storePath}` };
  }
  const base = resolveBase(cwd);
  const fingerprint = computeTreeFingerprint(cwd);
  const bound = authoritativeOfKind(read.records, 'red-proof').filter((r) => r.base === base);
  const { reruns, timeoutS } = probeKnobsFromEnv(env);
  const failures = [];
  for (const record of bound) {
    const id = record.testId;
    if (record.fingerprint === fingerprint) {
      failures.push(`${id}: the record's pre-fix fingerprint EQUALS the current tree — nothing changed since the observed red (reuse/forgery); re-observe on the pre-fix tree`);
      continue;
    }
    const resolved = resolveTestFile(rootTop, record.file);
    if (!resolved.ok) {
      failures.push(`${id}: the bound test file ${resolved.reason.includes('does not exist') ? 'was deleted — ' : ''}${resolved.reason}`);
      continue;
    }
    const currentHash = hashFileBytes(resolved.abs);
    if (currentHash !== record.fileHash) {
      failures.push(`${id}: the bound test file's content changed since the observed red (hash mismatch) — re-observe red at the new expectations`);
      continue;
    }
    let greens = 0;
    let executed = 0;
    for (let i = 0; i < reruns; i += 1) {
      const argv = defaultBoundArgv(resolved.abs, splitTestId(id).pattern);
      const res = spawnSync(argv[0], argv.slice(1), { cwd: rootTop, env: childTestEnv(env), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: timeoutS * 1000 });
      const p = parseProbeOutput({ stdout: res.stdout ?? '', code: res.error ? 1 : res.status ?? 1, fileArg: record.file });
      executed = Math.max(executed, p.executed);
      if (p.resolvable && p.baselineGreen) greens += 1;
    }
    if (executed === 0) {
      failures.push(`${id}: the pattern selects no test (zero-match) — the declared red→green pin is gone`);
      continue;
    }
    if (greens !== reruns) {
      failures.push(`${id}: not green ${reruns}/${reruns} at the final run (${greens}/${reruns} green) — the declared fix is red`);
    }
  }
  return { failures, verified: bound.length };
};

// ── the check ─────────────────────────────────────────────────────────────────────────────────────

export const runCheck = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const rootTop = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (rootTop == null) return { code: 0, lines: ['coverage-check: not a git work tree — nothing to check'] };
  const lcovPath = resolveLcovPath(cwd, env);
  const lines = [];
  let failed = false;
  const cov = checkCoverage({ rootTop, lcovPath });
  // The machine line the final-run receipt binds (M2): the sha of the exact bytes THIS check
  // consumed — `none` states loudly that no lcov was read.
  lines.push(`coverage-check: lcov-sha256=${cov.lcovSha256 ?? 'none'}`);
  if (cov.skipped) {
    lines.push(`coverage-check: ${cov.notes[0]}`);
  } else {
    for (const note of cov.notes) lines.push(`coverage-check: ${note}`);
    if (cov.failures.length > 0) {
      failed = true;
      lines.push('coverage-check: FAIL — uncovered/unattributed changed Node lines:');
      for (const f of cov.failures) lines.push(`  ${f}`);
    }
  }
  const red = verifyRedProofs({ rootTop, cwd, env });
  if (red.storeFailure) {
    failed = true;
    lines.push(`coverage-check: FAIL — ${red.storeFailure}`);
  } else {
    if (red.failures.length > 0) {
      failed = true;
      lines.push('coverage-check: FAIL — red-proof obligations not satisfied:');
      for (const f of red.failures) lines.push(`  ${f}`);
    } else if (red.verified > 0) {
      lines.push(`coverage-check: ${red.verified} red-proof record(s) verified green N/N with custody intact`);
    }
  }
  if (!failed && !cov.skipped && cov.failures.length === 0) {
    lines.push('coverage-check: PASS — every changed Node line is covered');
  }
  return { code: failed ? 1 : 0, lines };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `coverage-check — the D3(c)+(d) final-run checker (agent-workflow family).

Usage:
  node coverage-check.mjs --check [--cwd <dir>]

Reads the FIXED kit-owned lcov file (<git dir>/${LCOV_BASENAME}; AW_LCOV_FILE overrides —
produced by the declared unit-tests gate cmd's --experimental-test-coverage lcov reporters and
deleted fresh by run-gates --final), lists uncovered CHANGED executable Node lines file:line,
lists changed out-of-domain files (the coverage claim is narrowed to Node lines), and VERIFIES
every current-base red-proof record: bound test present, content hash unchanged, green N/N
(AW_CORE_EVIDENCE_RERUNS, default 3), pre-fix fingerprint differing from the current tree.
An absent lcov file is a LOUD skipped-no-lcov (exit 0 — NO coverage check ran, stated); a
symlinked lcov path, an uncovered line, a broken red-proof obligation, or a malformed evidence
store fails (exit 1).

Read-only. Exit codes: 0 pass/skipped-loud; 1 fail; 2 usage.`;

export const main = (argv, ctx = {}) => {
  const env = ctx.env ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    let cwd = ctx.cwd ?? process.cwd();
    const rest = [...argv];
    const cwdAt = rest.indexOf('--cwd');
    if (cwdAt !== -1) {
      cwd = rest[cwdAt + 1];
      if (cwd === undefined) throw usageFail('--cwd needs a directory');
      rest.splice(cwdAt, 2);
    }
    const checkAt = rest.indexOf('--check');
    if (checkAt !== -1) rest.splice(checkAt, 1);
    if (rest.length > 0) throw usageFail(`unknown argument: ${rest[0]}`);
    const { code, lines } = runCheck({ cwd, env });
    return { code, stdout: lines.join('\n'), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `coverage-check: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
