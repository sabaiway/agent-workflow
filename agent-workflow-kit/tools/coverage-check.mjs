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
// Dependency-free, Node >= 22. No side effects on import.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GIT_MAX_BUFFER } from './git-env.mjs';
import { computeChangedSurface } from './changed-surface.mjs';
import { isDirectRun } from './direct-run.mjs';
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

// ── the attestation handshake (the provenance precondition) ───────────────────────────────────────
// An LCOV on disk carries NO evidence of the tree it was produced from, so reading one and issuing
// a verdict certifies whatever happens to be there. The STALE-FAILURE direction was observed live
// (2026-07-27, an identical failure list and sha after tests were added); the FALSE GREEN — the
// dangerous one — was reproduced HERMETICALLY: a line appended after the suite ran has no DA entry,
// and lcov.mjs:9-13 states that reads as non-executable, i.e. "nothing to cover".
//
// Provenance is a CONSEQUENCE inside exactly one context: a `run-gates --final` run deletes the
// artifact before any gate spawns, so anything present came from that run. The runner mints a random
// nonce and writes `final-start.attempt` as a one-way COMMITMENT over {nonce, fingerprint, base};
// the raw nonce rides the environment to this child, which recomputes the commitment and requires
// the record to carry it. Neither half suffices alone: a bare nonce is unverifiable (any later value
// would do), a persisted attempt id alone is replayable (it is reconstructible from public repo
// state, which is how the first two designs certified foreign evidence). The commitment also BINDS
// THE BASE, which is persisted nowhere else — the only way a base check is possible at all.
//
// Residual, stated: an operator who runs both processes can forge the store or the code. That is the
// kit's standing posture (review-state.mjs HUMAN residual), not a new weakening. What this removes
// is the ACCIDENTAL false green — an interrupted run plus an ordinary later test run, nobody trying.
export const ATTEST_NONCE_ENV = 'AW_FINAL_ATTEST_NONCE';
export const ATTEST_FINGERPRINT_ENV = 'AW_FINAL_ATTEST_FINGERPRINT';
export const ATTEST_BASE_ENV = 'AW_FINAL_ATTEST_BASE';
const ATTEST_ENV_VARS = Object.freeze([ATTEST_NONCE_ENV, ATTEST_FINGERPRINT_ENV, ATTEST_BASE_ENV]);

// The commitment bytes: newline-joined, which is unambiguous because every field is hex or empty
// (the nonce and fingerprint by construction, the base a git object id or '' on an unborn branch).
export const commitmentFor = (nonce, fingerprint, base) =>
  createHash('sha256').update(`${nonce}\n${fingerprint}\n${base ?? ''}`).digest('hex');

// A child of this process must never inherit a LIVE capability: the red-proof arm spawns `node --test`
// probes, and a detached descendant holding the raw nonce could attest later.
export const withoutAttestEnv = (env) => {
  const out = { ...env };
  for (const key of ATTEST_ENV_VARS) delete out[key];
  return out;
};

// → { attesting: true } | { attesting: false, reason } | { refusal } — a refusal is an exit-1
// identity failure (the runner handed a context that no longer describes this tree), DISTINCT from
// the ordinary non-attesting case, which is exit 0 and merely withholds the verdict.
// Exported as a test seam (the keyFor idiom): the undecidable-identity arm below cannot be reached
// through the CLI, where a resolvable work tree is a precondition of getting this far.
export const attestationState = ({ env, records, fingerprint, base }) => {
  const nonce = env[ATTEST_NONCE_ENV];
  if (typeof nonce !== 'string' || nonce === '') {
    return { attesting: false, reason: 'no final-run attestation context — a verdict is issued only inside the run that owns the lcov (run-gates.mjs --final); findings below are informational' };
  }
  const passedFingerprint = env[ATTEST_FINGERPRINT_ENV] ?? '';
  const passedBase = env[ATTEST_BASE_ENV] ?? '';
  if (fingerprint == null) {
    return { refusal: 'the attestation context cannot be verified — this tree has no computable fingerprint' };
  }
  if (passedFingerprint !== fingerprint || passedBase !== (base ?? '')) {
    return { refusal: `the tree MOVED under the final run (the attestation context describes ${passedFingerprint.slice(0, 12)}…@${passedBase.slice(0, 12) || 'unborn'}, this tree is ${fingerprint.slice(0, 12)}…@${(base ?? '').slice(0, 12) || 'unborn'}) — a gate changed the working tree after the suite produced the lcov; re-run run-gates.mjs --final` };
  }
  const want = commitmentFor(nonce, fingerprint, base ?? '');
  if (!records.some((r) => r.kind === 'final-start' && r.attempt === want)) {
    return { refusal: 'the attestation context matches no recorded final-run attempt — the evidence store lost or never received the start record; re-run run-gates.mjs --final' };
  }
  return { attesting: true };
};

// The withheld-verdict reason for the one case a VALID context cannot rescue: the run owned the
// artifact's lifetime and read NO bytes — an absent file and a refused path alike, which is why
// this states the bytes rather than the skip.
const NO_BYTES_NO_VERDICT = 'no lcov bytes were read at the checked path, so no verdict could be issued — a run that read nothing certifies nothing; if no gate produces the file, declare a coverage PRODUCER beside the checker (references/modes/gates.md names the exact form)';

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
  // The identity is read BEFORE the coverage arm and again AFTER it: a single up-front comparison
  // leaves a window in which the tree moves between the surface walk and the verdict.
  const identityBefore = { fingerprint: computeTreeFingerprint(cwd), base: resolveBase(cwd) };
  const storePath = resolveEvidencePath(cwd, env);
  const storeRecords = storePath ? readEvidence(storePath).records : [];
  const attestBefore = attestationState({ env, records: storeRecords, ...identityBefore });
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
  // The probes must never inherit a live attestation capability (a detached descendant could keep it).
  const red = verifyRedProofs({ rootTop, cwd, env: withoutAttestEnv(env) });
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
  // Re-read the identity AFTER the coverage arm and re-decide: the attestation must describe the
  // tree the verdict was actually computed over, not the one it started over.
  const identityAfter = { fingerprint: computeTreeFingerprint(cwd), base: resolveBase(cwd) };
  const attestAfter = attestationState({ env, records: storeRecords, ...identityAfter });
  const attestation = attestBefore.refusal ? attestBefore : attestAfter;
  const contextValid = attestation.attesting === true && attestBefore.attesting === true;
  // `attested=` states whether a coverage VERDICT was ISSUED — pass OR fail — never that coverage
  // passed: a valid handshake over uncovered lines still reads yes and still exits 1. What no
  // context can rescue is an EMPTY read, and the honest predicate is the BYTES CONSUMED, not the
  // skip flag: an absent lcov and a refused path (a symlink) both read nothing, and attesting over
  // either is the same false green this whole arm exists to close, one layer up.
  const attesting = contextValid && cov.lcovSha256 !== null;
  // EXACTLY ONE fully anchored machine line, the lcov-sha256 contract's sibling — the runner binds
  // it, so a missing/duplicated/injected one is an integrity failure rather than a silent green.
  lines.push(`coverage-check: attested=${attesting ? 'yes' : 'no'}`);
  if (attestation.refusal) {
    failed = true;
    lines.push(`coverage-check: REFUSED — ${attestation.refusal}`);
  } else if (!attesting) {
    lines.push(`coverage-check: NO VERDICT — ${contextValid ? NO_BYTES_NO_VERDICT : attestation.reason}`);
  }
  // The attestation gates ONLY the coverage claim. Every pre-existing fail-closed refusal above
  // (symlinked lcov, malformed evidence store, unmet red-proof obligation) keeps its own exit 1.
  if (attesting && !failed && cov.failures.length === 0) {
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

A coverage VERDICT is issued ONLY inside the run that owns the artifact's lifetime: run-gates
--final deletes the lcov before any gate spawns and hands this checker an attestation context
(a nonce whose one-way commitment over {nonce, fingerprint, base} is the final-start attempt id).
One anchored machine line rides every run: coverage-check: attested=<yes|no>. It states whether a
coverage VERDICT was ISSUED — pass OR fail — never that coverage passed.
  attested=yes → a verdict was issued over the lcov BYTES this run read (a failing one still
                 exits 1); the predicate is the consumed digest, never the skip flag.
  attested=no  → NO VERDICT: no handshake, or no lcov bytes were read at all (an absent file or a
                 refused path — nothing read, nothing certified). Withholding a verdict never
                 changes an exit code: an absent lcov stays exit 0, a refused non-regular path
                 keeps its own fail-closed exit 1, and uncovered lines still exit 1. Findings are
                 still printed; run-gates carries the withheld verdict as coverage=not-run.
  REFUSED (exit 1) → the context describes another tree, or matches no recorded attempt.
Residual, stated: ownership of the fixed path is CONVENTION, not enforcement — a concurrent writer
to it can still place foreign evidence (queued as LCOV-EXCLUSIVE-OWNERSHIP).

Sandbox-safe: no network; writes nothing; spawns read-only git queries and the bound-test
probes (node --test, shell-free) — the D4 sandbox lane. The attestation variables are consumed and
removed from this process's environment before anything spawns, so no child inherits the capability.
Read-only. Exit codes: 0 pass / no-verdict / skipped-loud; 1 fail or REFUSED; 2 usage.`;

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

if (isDirectRun(import.meta.url)) {
  // The capability is CONSUMED here: snapshot it, then remove it from this process's environment
  // before anything spawns. Every `git` query and every bound-test probe below inherits
  // process.env, so leaving it in place would hand a live attestation context to each of them —
  // and a detached descendant could then certify a foreign lcov long after this run ended.
  const attest = Object.fromEntries(
    [ATTEST_NONCE_ENV, ATTEST_FINGERPRINT_ENV, ATTEST_BASE_ENV]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]]),
  );
  for (const k of Object.keys(attest)) delete process.env[k];
  const r = main(process.argv.slice(2), { env: { ...process.env, ...attest } });
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
