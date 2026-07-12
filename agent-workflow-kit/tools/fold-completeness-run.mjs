#!/usr/bin/env node
// fold-completeness-run.mjs — the M3 fold-completeness RUNNER (AD-046, DEBT-TEST-COMPLETENESS). It is
// the SOLE tree-toucher and the SOLE writer of the fold-completeness result ledger, the write half of
// the family read/write split (mirrors review-ledger-write.mjs): fold-completeness.mjs (the schema +
// result reader + the read-only `--check` gate) NEVER imports this module — an import-split test pins
// that. This module imports the read core the OTHER direction (the result schema + reader + the shared
// bound-testId collector) and appends records through the shared hardened atomic-write core.
//
// One run, over the in-flight plan-execution loop's dirty tree:
//   1. resolve the loop = the single in-flight plan stem (0 or >1 → typed refusal);
//   2. classify the changed surface (Decision 5, a CLOSED extension rule — assessable JS / unsupported
//      TS-JSX / out-of-domain) and derive per-file changed line ranges;
//   3. M3a — run the suite ONCE under NODE_V8_COVERAGE (a dir OUTSIDE the work tree, Decision 8) and
//      map every changed executable line to covered/uncovered via V8 innermost-range-wins (Decision 6);
//   4. probe each of the loop's fixable-bug bound testIds N times (Decision 3 / 10 + D4, shell-free,
//      per-run timeout) for resolvability + an N/N-green baseline, hashing each bound test file
//      (the D5 custody anchor);
//   5. append ONE machine-only v3 run record — segment-framed (base = git rev-parse HEAD, AD-048 D7)
//      and bound to BOTH the tree fingerprint AND the SEGMENT's sorted fixable-bug testId set
//      (Decision 9) — to <git dir>/agent-workflow-fold-completeness.jsonl.
// A SECOND verb, --red "<testId>" (BUGFREE-1 / AD-047), observes a testId RED on the current
// (pre-fold) tree and mints a red-probe receipt — the observed-red half of the honest red→green
// proof; observed-green / unresolvable / mixed / timed-out are distinguished refusals, nothing written.
// The researched mutation half (M3b) was SHELVED — bounded local-boundary mutation adds too little
// over coverage and is not language-independent — so the `mutation` field stays the reserved empty shape.
//
// HONEST residuals (see fold-completeness.mjs header for the full list): coverage proves execution not
// assertion; testIds/records are forgeable (a self-discipline mechanism, not a security boundary);
// TS/JSX source is out of scope v1. Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, readdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, normalize, posix, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { computeTreeFingerprint, plansInFlight } from './review-state.mjs';
import { resolveLedgerPath, resolveBase, readLedger, isWellFormedTestId, splitTestId, collectOverrides } from './review-ledger.mjs';
import {
  RESULT_SCHEMA_VERSION,
  REATTEST_KIND,
  resolveResultsPath,
  validateRunRecord,
  collectBoundTestIds,
  probeVerdict,
  readResults,
  filterSegmentResults,
  isRedProbeRecord,
  isReattestRecord,
} from './fold-completeness.mjs';
// The changed-surface computation lives in the NEUTRAL shared module (BUGFREE-2 / AD-048, D4): the
// review-ledger writer's diff-size cap and this runner's coverage domain consume ONE computation,
// and the writer never imports this runner (the sole-tree-toucher boundary — import-split pinned).
// Re-exported below so the runner's tests (and any consumer) keep one entry point per concern.
import { classifyChangedPath, parseUnifiedDiff, unquoteDiffPath, computeChangedSurface, DIFF_FLAGS, parsePositiveIntKnob } from './changed-surface.mjs';
// The verification PROFILE (BUGFREE-3 / AD-049): the read-core generalizes the coverage SOURCE and
// the single-test RESULT FORMAT so this runner drives the fold gate on another language/runner. An
// absent profile reproduces today's exact behaviour (V8 + node:test TAP on stdout).
import { loadProfile, resolveCoverage, resolveSingleTest, resolveSarifPath, FILE_BASED_FORMATS } from './verification-profile.mjs';
import { lcovCoveredMap, uncoveredChangedFromLcov } from './lcov.mjs';
import { parseSarif, renderSarifFindings } from './sarif.mjs';

export { classifyChangedPath, parseUnifiedDiff, unquoteDiffPath, computeChangedSurface };

const ACTIVITY = 'plan-execution';
const GIT_MAX_BUFFER = 256 * 1024 * 1024; // a full-tree diff / full-suite TAP can be large; never truncate

// A typed STOP — a deliberate refusal we surface (loop derivation / a malformed override / a malformed
// record / an fs error), distinct from a native fs error. The codebase's typed-error idiom (no classes).
export const FOLD_RUN_STOP = 'FOLD_RUN_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'FoldRunStop', code: FOLD_RUN_STOP });
const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });

const isoNow = () => new Date().toISOString();

// Node sets NODE_TEST_CONTEXT for any process running UNDER `node --test`; a fresh `node --test` that
// inherits it silently SKIPS running its files (the recursive-run guard). The runner spawns `node
// --test` for the suite + the bound-test probes, so it MUST strip that var — otherwise, whenever the
// runner is itself invoked from within a test context (e.g. this kit's own fold-completeness-run
// tests, or a consumer's), the child runs nothing and every file reads as uncovered. Unset in normal
// (non-test) invocation, so stripping is a no-op there.
export const childTestEnv = (env, extra = {}) => {
  const out = { ...env, ...extra };
  delete out.NODE_TEST_CONTEXT;
  return out;
};

// ── Decision 6: V8 coverage → uncovered changed lines (innermost-range-wins) ──────────────────────

// lineStartOffsets(sourceText) → char offset of each line start (index i == line i+1). Splitting on
// '\n' keeps any trailing '\r' inside the line length, so CRLF offsets stay correct.
export const lineStartOffsets = (sourceText) => {
  const offs = [0];
  for (let i = 0; i < sourceText.length; i += 1) if (sourceText[i] === '\n') offs.push(i + 1);
  return offs;
};

// effectiveCount(ranges, offset) → the execution count of the SMALLEST (innermost) range containing
// offset; 0 when no range contains it (absent from this process's report). This is the v8-to-istanbul
// rule reduced to Node built-ins: a nested count-0 block shadows its executed parent.
export const effectiveCount = (ranges, offset) => {
  let best = null;
  for (const r of ranges) {
    if (r.startOffset <= offset && offset < r.endOffset) {
      const width = r.endOffset - r.startOffset;
      if (best === null || width < best.width) best = { width, count: r.count };
    }
  }
  return best === null ? 0 : best.count;
};

// computeUncoveredLines({ perProcessRanges, sourceText, changedLines }) → the sorted changed lines that
// NO process executed. perProcessRanges is one flat range-list per process (process isolation); a line
// is covered iff ANY process gives its first non-whitespace char a positive effective count. Blank /
// whitespace-only lines are never executable and never flagged. Callers handle file-absent (an empty
// perProcessRanges means the file never loaded — a file-level RED decided by the caller, not here).
//
// GRANULARITY (stated residual, codex R1 → inherent-layer-residual): this is LINE-ENTRY coverage — the
// question "was this line entered by some test?", the same granularity c8 reports as line coverage. A
// same-line uncovered sub-branch (the false arm of `a ? b : c`, the RHS of `a && b()`) is NOT flagged
// when the line's leading statement executed — flagging it would need branch/AST analysis, and a naive
// "any count-0 char on the line" rule would FALSE-POSITIVE on an inline uncalled-function definition
// (`const f = () => never()`, whose body span is count-0 though the assignment ran), i.e. exactly the
// churn the plan's PRIMARY RISK warns against. Same-line branch gaps would need branch-level analysis
// (the shelved mutation half / a future parser-backed signal), not M3a line coverage. Chasing sub-line
// precision here without an AST is explicitly out of scope — a stated residual.
export const computeUncoveredLines = ({ perProcessRanges, sourceText, changedLines }) => {
  const offs = lineStartOffsets(sourceText);
  const total = sourceText.length;
  const uncovered = [];
  for (const n of changedLines) {
    const start = offs[n - 1];
    if (start === undefined) continue; // a changed line beyond EOF (defensive; should not happen)
    const end = offs[n] ?? total;
    const rel = sourceText.slice(start, end).search(/\S/);
    if (rel < 0) continue; // blank / whitespace-only → not executable
    const offset = start + rel;
    const covered = perProcessRanges.some((ranges) => effectiveCount(ranges, offset) > 0);
    if (!covered) uncovered.push(n);
  }
  return [...new Set(uncovered)].sort((a, b) => a - b);
};

// ── Decision 3 / 10: the bound-test probe ─────────────────────────────────────────────────────────

const PROBE_RESULT_RE = /^(ok|not ok) \d+ - (.*)$/; // a column-0 TAP result line (verb, description)
const PROBE_FAIL_RE = /^# fail (\d+)$/;
const PROBE_DIRECTIVE_RE = /#\s*(?:skip|todo)\b/i; // a TAP SKIP/TODO directive — the test did NOT run

// parseProbeOutput({ stdout, code, fileArg }) → { resolvable, executed, baselineGreen }. The TAP
// strategy (both tap-stdout and tap-file — a tap-file is this SAME parser applied to the file's text).
// A node:test run with a pattern that matches NOTHING emits only a file-wrapper result whose
// description is the file path itself (`ok N - <file>`) on newer node — but node 18/20 ALSO emit every
// pattern-FILTERED test as `ok N - <name> # SKIP test name does not match pattern`, so a result line
// carrying a TAP SKIP/TODO directive must never count: the test was not executed, and counting it
// green-vouches a nonexistent testId on exactly the node versions the kit supports (caught by CI's
// 18/20 matrix). So `resolvable` = at least one column-0, directive-free result whose description is
// not the file we passed; `baselineGreen` = resolvable AND the run was green — exit 0, NO directive-free
// `not ok` result, and `# fail 0` (a `not ok` is counted directly, so a generic TAP producer that
// omits the `# fail N` summary yet exits 0 still reads RED — the fail-closed posture, BUGFREE-3). The
// wrapper is matched by BASENAME, not literally: node normalizes the echoed path ('./x' → 'x', or an
// absolute path), so a literal desc===fileArg compare would count the wrapper as a real match and
// falsely report resolvable/green (codex R1). A basename compare is invariant to ./ / abs / rel.
export const parseProbeOutput = ({ stdout, code, fileArg }) => {
  let matched = 0;
  let notOk = 0;
  let failCount = null;
  const wanted = basename(String(fileArg).trim());
  for (const line of String(stdout).split('\n')) {
    const m = PROBE_RESULT_RE.exec(line);
    if (m && !PROBE_DIRECTIVE_RE.test(m[2]) && basename(m[2].trim()) !== wanted) {
      matched += 1;
      if (m[1] === 'not ok') notOk += 1;
    }
    const f = PROBE_FAIL_RE.exec(line.trim());
    if (f) failCount = Number(f[1]);
  }
  const resolvable = matched > 0;
  const fails = (failCount ?? 0) + notOk; // either signal marks a fail (only the ===0 green check matters)
  return { resolvable, executed: matched, baselineGreen: resolvable && code === 0 && fails === 0 };
};

// parseJunitXml({ resultText }) → { resolvable, executed, baselineGreen }. A dependency-free JUnit-XML
// reader (regex over well-formed testcase elements — no XML lib): a <testcase> carrying <skipped> did
// NOT run (excluded, the TAP SKIP/TODO analogue); a <testcase> carrying <failure> or <error> is red.
// resolvable = at least one NON-skipped testcase (so an empty report / tests="0" reads UNRESOLVABLE,
// never green — the "0 tests never green" invariant); baselineGreen = resolvable AND no non-skipped
// failure/error. The XML report is authoritative (fail-closed: a failure element is red regardless of
// the process exit code — a reporter that exits 0 while recording failures still reads RED).
// CDATA + comment CONTENT is arbitrary text (a test's captured stdout may legally contain '<skipped',
// '<failure>', or even a literal '</testcase>'). Stripped BEFORE the regex scan so it can never
// fabricate a skip/failure match nor desync the lazy body capture (the fail-closed posture: a real
// <failure> is never dropped, a real element boundary is never truncated).
const stripXmlNoise = (xml) => String(xml).replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
export const parseJunitXml = ({ resultText }) => {
  let executed = 0;
  let failed = 0;
  const text = stripXmlNoise(resultText ?? '');
  // The /g regex is LOCAL per call: a fresh matcher owns its own lastIndex — no shared
  // module-level state to reset, no reentrancy risk under any future refactor.
  const caseRe = /<testcase\b[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = caseRe.exec(text)) !== null) {
    const body = m[2] ?? '';
    if (/<skipped\b/.test(body)) continue; // skipped → did not run
    executed += 1;
    if (/<(?:failure|error)\b/.test(body)) failed += 1;
  }
  const resolvable = executed > 0;
  return { resolvable, executed, baselineGreen: resolvable && failed === 0 };
};

// parseProbeResult({ format, stdout, code, fileArg, resultText }) → the SAME
// { resolvable, executed, baselineGreen } shape, dispatched by the profile's singleTest.resultFormat.
// A file-based format whose result file was NOT written (resultText == null — the probe crashed or the
// pattern selected nothing) reads UNRESOLVABLE (never green): the freshness invariant (a fresh
// out-of-tree path per probe run — see probeBound) means a stale file can never be re-read as green.
export const parseProbeResult = ({ format = 'tap-stdout', stdout, code, fileArg, resultText }) => {
  if (format === 'tap-file') {
    if (resultText == null) return { resolvable: false, executed: 0, baselineGreen: false };
    return parseProbeOutput({ stdout: resultText, code, fileArg });
  }
  if (format === 'junit-xml') {
    if (resultText == null) return { resolvable: false, executed: 0, baselineGreen: false };
    const r = parseJunitXml({ resultText });
    // Fail-closed + symmetric with tap-file: an all-pass report with a NONZERO process exit reads RED
    // (a report may be written before a post-test hook/crash fails the process). Internal sweep fold.
    return { ...r, baselineGreen: r.baselineGreen && code === 0 };
  }
  return parseProbeOutput({ stdout, code, fileArg }); // tap-stdout (default) — unchanged
};

// defaultBoundArgv(file, pattern) → the shell-free node:test argv (testId content never reaches a
// shell). The pattern rides in the `=`-joined form: as a SEPARATE argv token a pattern beginning
// with "-"/"--" (a test name like "--telemetry refuses …") parses as an OPTION and the probe
// silently selects no test — the pattern-half sibling of the AD-047 dash-spawn file fix (found
// live by this plan's own --red loop).
export const defaultBoundArgv = (file, pattern) => ['node', '--test', '--test-reporter', 'tap', `--test-name-pattern=${pattern}`, file];

// ── the shared safe test-file resolver (BUGFREE-1, codex R1+R2) ───────────────────────────────────
// Custody hashing and every probe spawn go through THIS one resolver — the testId format itself is
// deliberately suffix-free and format-only (review-ledger.mjs), so path safety lives here: the file
// half must be repo-relative (absolute + parent-escaping refused), a REGULAR file under the no-follow
// lstat discipline, and its RESOLVED real path must be contained under the REAL repo root — a leaf
// check alone would let a symlinked PARENT directory escape the work tree.

// resolveTestFile(rootTop, rel, deps?) → { ok: true, abs } | { ok: false, reason } (never throws).
// deps.{lstat,realpath} are injectable so the defensive fs-race catch is unit-testable (the family
// deps idiom — review-ledger-write.mjs).
export const resolveTestFile = (rootTop, rel, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const realpath = deps.realpath ?? realpathSync;
  if (typeof rel !== 'string' || rel.length === 0) return { ok: false, reason: 'empty file path' };
  if (isAbsolute(rel)) return { ok: false, reason: `absolute path "${rel}" — the testId file half must be repo-relative` };
  const norm = normalize(rel);
  if (norm === '..' || norm.startsWith(`..${sep}`)) return { ok: false, reason: `path "${rel}" escapes the repo root` };
  const abs = join(rootTop, norm);
  let st;
  try {
    st = lstat(abs);
  } catch {
    return { ok: false, reason: `file "${rel}" does not exist` };
  }
  if (!st.isFile()) return { ok: false, reason: `"${rel}" is not a regular file (a symlink/directory/device is never followed — fail closed)` };
  let realAbs;
  let realRoot;
  try {
    realAbs = realpath(abs);
    realRoot = realpath(rootTop);
  } catch {
    return { ok: false, reason: `cannot resolve the real path of "${rel}"` };
  }
  if (!containsPath(realRoot, realAbs)) return { ok: false, reason: `"${rel}" resolves outside the repo root (a symlinked parent directory) — fail closed` };
  return { ok: true, abs: realAbs };
};

// containsPath(realRoot, realAbs) → realAbs is strictly INSIDE realRoot. Segment-safe ('/a' never
// contains '/ab') and correct for a repo at the filesystem root, where realRoot already ends with
// the separator ('/'+sep would be '//' and reject every valid path — agy R1).
export const containsPath = (realRoot, realAbs) => realAbs.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);

// The D5 custody hash: sha-256 over the file's BYTES (no encoding normalization). null on a read
// failure — the caller reads that as an unresolvable file (exported for the unit test of exactly
// that fail-closed edge).
export const hashFileBytes = (abs) => {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
};

// resolveBoundArgv(env, profile?) → (file, pattern, resultPath?) => argv[]. PRECEDENCE (env WINS,
// Decision 3): AW_FOLD_BOUND_CMD (a JSON argv array — the universality escape hatch) beats the
// profile's singleTest.argv template, which beats the built-in node:test shape. Placeholders
// {file}/{pattern} are always substituted; {resultPath} is the FILE-BASED-format placeholder (the
// runner substitutes a fresh out-of-tree path per probe — see probeBound; validateProfile requires it
// for a file-based profile argv). A malformed override is a typed refusal, never a silent fall to a
// shell. Substitution uses function replacers so a `$` in a testId/path is literal.
export const resolveBoundArgv = (env = process.env, profile = null) => {
  const raw = env.AW_FOLD_BOUND_CMD;
  let tmpl = null;
  if (raw) {
    try {
      tmpl = JSON.parse(raw);
    } catch (err) {
      throw stop(`AW_FOLD_BOUND_CMD is not valid JSON (${err.message}) — expected a JSON array of argv strings`);
    }
    if (!Array.isArray(tmpl) || tmpl.length === 0 || !tmpl.every((a) => typeof a === 'string')) {
      throw stop('AW_FOLD_BOUND_CMD must be a non-empty JSON array of argv strings with {file}/{pattern} placeholders');
    }
  } else if (Array.isArray(profile?.singleTest?.argv) && profile.singleTest.argv.length > 0) {
    tmpl = profile.singleTest.argv;
  }
  if (!tmpl) return (file, pattern) => defaultBoundArgv(file, pattern);
  return (file, pattern, resultPath) =>
    tmpl.map((a) =>
      a
        .replace(/\{file\}/g, () => file)
        .replace(/\{pattern\}/g, () => pattern)
        .replace(/\{resultPath\}/g, () => resultPath ?? ''),
    );
};

// ── read-only git plumbing (the changed-surface computation itself lives in changed-surface.mjs) ──

const runGit = (args, cwd) => spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', windowsHide: true });
const gitStdout = (args, cwd) => {
  const r = runGit(args, cwd);
  return r.error || r.status > 1 ? null : r.stdout;
};
const readFileSafe = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const canon = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
// ── the oracle-tamper surface (BUGFREE-1 Phase 2.2, Approach-3) ───────────────────────────────────

const DIFF_HUNK_OLD_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,\d+)? @@/;

// parseDiffOldSide(diffText) → Map<oldRel, { removals: boolean }> — the OLD-side view of a -U0
// tracked diff: which pre-existing (HEAD) files carry any removed/modified line (a hunk whose
// old-count > 0). A file ADDED by the diff (--- /dev/null) has no old side and never appears; a
// DELETED file's hunks remove every line, so it reads removals: true. Renames under --no-renames
// read as delete+add — the delete side lands here (stated).
export const parseDiffOldSide = (diffText) => {
  const map = new Map();
  let current = null;
  let inHeader = false;
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith('--- ')) {
      // Strip ONLY the git-appended trailing TAB (space-carrying paths) and a CRLF \r — never a
      // legitimate trailing character of the filename itself (agy R6; a raw TAB in a name is
      // C-quoted anyway, so [\t\r]+$ can only match git artifacts).
      const p = unquoteDiffPath(line.slice(4).replace(/[\t\r]+$/, ''));
      current = p === '/dev/null' ? null : p.startsWith('a/') ? p.slice(2) : p;
      if (current != null && !map.has(current)) map.set(current, { removals: false });
      continue;
    }
    if (inHeader && line.startsWith('+++ ')) {
      inHeader = false;
      continue;
    }
    const m = DIFF_HUNK_OLD_RE.exec(line);
    if (m) {
      inHeader = false;
      if (current == null) continue;
      const oldCount = m[1] === undefined ? 1 : Number(m[1]);
      if (oldCount > 0) map.get(current).removals = true;
    }
  }
  return map;
};

// computeTamperedTests(root, boundFiles) → { tampered: [rel...] } — the tamper surface is the union
// of test-classified paths (TEST_FILE_RE) and the loop's bound-testId file halves (the testId format
// carries no suffix rule, so a bound test at a nonstandard path must not escape the guard),
// restricted to files that exist at HEAD (having an old side in the tracked diff IS existing at
// HEAD). Tampered = any removed/modified line; pure additions and new/untracked files never trip it
// (widening to any-change-is-tamper would flag the standard append-a-new-test flow — the FP churn
// this series exists to kill).
export const computeTamperedTests = (root, boundFiles = new Set()) => {
  const trackedDiff = gitStdout(['diff', 'HEAD', ...DIFF_FLAGS], root)
    ?? gitStdout(['diff', ...DIFF_FLAGS], root) // no HEAD yet (unborn branch)
    ?? '';
  // The file halves are user-authored — './checks/x.mjs' probes and hashes as 'checks/x.mjs', so
  // the surface compares NORMALIZED halves or a modified bound file escapes the guard (codex R5).
  // Normalization happens in GIT/POSIX path space (codex+agy R6): node's OS-local normalize emits
  // backslashes on Windows while git diff paths stay slash-separated — the compare must never
  // depend on the host separator.
  const boundSet = new Set([...boundFiles].map((f) => posix.normalize(f)));
  const tampered = [];
  for (const [rel, info] of parseDiffOldSide(trackedDiff)) {
    if (!info.removals) continue;
    if (classifyChangedPath(rel) === 'excluded-test' || boundSet.has(rel)) tampered.push(rel);
  }
  return { tampered: tampered.sort() };
};

// ── coverage (run the suite once under NODE_V8_COVERAGE, outside the tree) ─────────────────────────

// readCoverage(covDir) → Map<canonicalAbsPath, Array<Array<range>>> — one flat range-list per process.
const readCoverage = (covDir) => {
  const byPath = new Map();
  let files;
  try {
    files = readdirSync(covDir);
  } catch {
    return byPath;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(covDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.result)) continue;
    for (const entry of parsed.result) {
      if (typeof entry.url !== 'string' || !entry.url.startsWith('file:')) continue;
      let abs;
      try {
        abs = canon(fileURLToPath(entry.url));
      } catch {
        continue;
      }
      const ranges = [];
      for (const fn of entry.functions ?? []) for (const r of fn.ranges ?? []) ranges.push({ startOffset: r.startOffset, endOffset: r.endOffset, count: r.count });
      if (!byPath.has(abs)) byPath.set(abs, []);
      byPath.get(abs).push(ranges);
    }
  }
  return byPath;
};

// ── suite command discovery (Decision 10) ─────────────────────────────────────────────────────────

const GATES_REL = 'docs/ai/gates.json';
const resolveSuiteCmd = (root, env, explicit) => {
  if (explicit) return explicit;
  if (env.AW_FOLD_SUITE_CMD) return env.AW_FOLD_SUITE_CMD;
  const raw = readFileSafe(join(root, GATES_REL));
  if (raw) {
    try {
      const gate = (JSON.parse(raw).gates ?? []).find((g) => g && g.id === 'unit-tests');
      if (gate && typeof gate.cmd === 'string') return gate.cmd;
    } catch {
      /* fall through to the loud refusal */
    }
  }
  throw stop(`cannot resolve the suite command — no unit-tests gate in ${GATES_REL}; pass --suite "<cmd>" or set AW_FOLD_SUITE_CMD`);
};

// ── the append primitive (whole-file read → add one JSONL line → atomic rewrite) ─────────────────

const appendRecord = (resultsPath, record) => {
  let existing = '';
  try {
    existing = readFileSync(resultsPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') existing = '';
    else throw stop(`cannot read the result ledger before appending (${(err && err.code) || (err && err.message) || err}) — refusing to overwrite it (fail closed)`);
  }
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  const body = `${prefix}${JSON.stringify(record)}\n`;
  writeContainedFileAtomic(dirname(resultsPath), resultsPath, body, {}, { stop, label: resultsPath });
  return { writtenPath: resultsPath, record };
};

// ── the run ───────────────────────────────────────────────────────────────────────────────────────

export const budgetsFromEnv = (env) => ({
  mutantsMax: Number.parseInt(env.AW_FOLD_MUTANTS_MAX ?? '200', 10) || 200,
  hunkMutantsMax: Number.parseInt(env.AW_FOLD_HUNK_MUTANTS_MAX ?? '25', 10) || 25,
  timeBudgetS: Number.parseInt(env.AW_FOLD_TIME_BUDGET_S ?? '600', 10) || 600,
  // D4: N reruns per probe side; the per-RUN probe timeout (each of the N runs gets its own budget,
  // never one shared series budget — agy R1). Probes only: the suite run keeps the no-timeout status
  // quo. The fail-closed parser is the shared one (changed-surface.mjs), thrown as THIS tool's STOP.
  foldReruns: parsePositiveIntKnob(env, 'AW_FOLD_RERUNS', 3, stop),
  probeTimeoutS: parsePositiveIntKnob(env, 'AW_FOLD_PROBE_TIMEOUT_S', 120, stop),
});

// ── the shared N-rerun probe (D4) — ONE helper for both the run's green side and the --red verb ───

// probeBound({ id, rootTop, env, boundArgv, reruns, timeoutS }) → { entry, resolveReason }. The entry
// is the v2 per-testId record shape: rerun counts (evidence) + the custody content hash + the derived
// booleans. The custody hash is taken BEFORE the runs (the content the observation attests). A
// timed-out or signal-killed run is neither red nor green — it lands in `timeouts` (quarantine fuel).
const probeBound = ({ id, rootTop, env, boundArgv, resultFormat = 'tap-stdout', reruns, timeoutS }) => {
  const { file, pattern } = splitTestId(id);
  const resolved = resolveTestFile(rootTop, file);
  const fileHash = resolved.ok ? hashFileBytes(resolved.abs) : null;
  const fileBased = FILE_BASED_FORMATS.has(resultFormat);
  let executed = 0;
  let greens = 0;
  let reds = 0;
  let timeouts = 0;
  if (resolved.ok && fileHash != null) {
    for (let i = 0; i < reruns; i += 1) {
      // FILE-BASED formats (tap-file / junit-xml): a FRESH out-of-tree result path PER probe run (the
      // mkdtempSync-outside-tree precedent) — this realizes the freshness invariant: a stale green
      // file from a previous run / a crashed or zero-match probe can never be re-read as green.
      let resultDir = null;
      let resultPath = null;
      if (fileBased) {
        resultDir = mkdtempSync(join(tmpdir(), 'agent-workflow-fold-probe-'));
        resultPath = join(resultDir, resultFormat === 'junit-xml' ? 'result.xml' : 'result.tap');
      }
      try {
        // ALWAYS spawn the resolver's canonical absolute path — the executed file must be the hashed
        // file independent of runner path semantics (codex R1+R2, BUGFREE-1 live loop): a raw
        // leading-dash filename parses as an OPTION (and a ./-prefix does not survive node's runner
        // normalization), and a raw traversal path like linkdir/../x lets an OS-resolving runner
        // execute a different filesystem target than the lexically-normalized file the hash covers.
        const argv = boundArgv(resolved.abs, pattern, resultPath);
        const res = spawnSync(argv[0], argv.slice(1), {
          cwd: rootTop, env: childTestEnv(env), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: timeoutS * 1000,
        });
        if ((res.error && res.error.code === 'ETIMEDOUT') || res.signal != null) {
          timeouts += 1;
          continue;
        }
        const resultText = fileBased ? readFileSafe(resultPath) : null;
        const p = parseProbeResult({ format: resultFormat, stdout: res.stdout ?? '', code: res.error ? 1 : res.status ?? 1, fileArg: file, resultText });
        executed = Math.max(executed, p.executed);
        if (!p.resolvable) continue; // an unresolved run (the pattern selected nothing / no result file)
        if (p.baselineGreen) greens += 1;
        else reds += 1;
      } finally {
        if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      }
    }
  }
  const entry = {
    id, executed, runs: reruns, greens, reds, timeouts, fileHash,
    resolvable: greens + reds === reruns, baselineGreen: greens === reruns,
  };
  return { entry, resolveReason: resolved.ok ? (fileHash == null ? `cannot read "${file}"` : null) : resolved.reason };
};

// runFoldCompleteness({ cwd, env, suiteCmd }) → { writtenPath, record }. THROWS a typed STOP (loop
// derivation / suite discovery / a malformed record / an fs error) or a native fs error.
export const runFoldCompleteness = ({ cwd = process.cwd(), env = process.env, suiteCmd } = {}) => {
  const root = gitStdout(['rev-parse', '--show-toplevel'], cwd);
  if (root == null) throw stop('not a git work tree — nothing to assess');
  const rootTop = root.replace(/\r?\n$/, '');

  // Decision: the loop = the single in-flight plan stem; 0 or >1 → refuse (ambiguous).
  const plans = plansInFlight(rootTop);
  if (plans.length === 0) throw stop('no plan in flight (docs/plans/ holds no active plan) — nothing to assess');
  if (plans.length > 1) throw stop(`more than one plan in flight (${plans.join(', ')}) — ambiguous loop id; resolve to one active plan`);
  const loop = plans[0].replace(/\.md$/, '');

  const fingerprint = computeTreeFingerprint(cwd);
  const cmd = resolveSuiteCmd(rootTop, env, suiteCmd);
  // The verification profile (BUGFREE-3 / AD-049) decides the coverage SOURCE and the single-test
  // RESULT FORMAT + argv template. Absent → today's V8 + node:test-TAP-on-stdout. Loaded BEFORE any
  // spawn so a malformed profile / unsafe declared path (Decision 4) — and a malformed
  // AW_FOLD_BOUND_CMD — both refuse loudly before the suite runs.
  const { profile } = loadProfile(rootTop);
  const boundArgv = resolveBoundArgv(env, profile);
  const { resultFormat } = resolveSingleTest(profile);
  const budgets = budgetsFromEnv(env);

  const { assessable, unsupported, outOfDomain } = computeChangedSurface(rootTop);

  // Coverage SOURCE: absent / kind "v8" → today's V8 path; kind "lcov" → the consumer's suite leaves
  // an LCOV file at the declared path (validated gitignored/out-of-tree by loadProfile — Decision 4).
  const { kind: coverageKind, lcovPath } = resolveCoverage(profile);
  const lcovAbs = coverageKind === 'lcov' ? (isAbsolute(lcovPath) ? lcovPath : join(rootTop, lcovPath)) : null;
  // FRESHNESS: remove any STALE LCOV before the suite runs — symmetric with
  // the V8 fresh mkdtemp covDir. A suite that fails/is misconfigured and does NOT re-emit LCOV then reads
  // ABSENT (a loud STOP below), never a leftover file that could mask an uncovered changed line as green.
  if (coverageKind === 'lcov') rmSync(lcovAbs, { force: true });

  // M3a: run the suite ONCE, then map every changed executable line to covered/uncovered. V8 injects
  // NODE_V8_COVERAGE into a dir OUTSIDE the work tree (Decision 8); LCOV runs the suite clean and
  // reads the file the suite itself wrote (the env stays untouched). Either source resolves to the
  // SAME canonical-abs key space, so the ONE per-file loop below consumes both.
  const covDir = coverageKind === 'v8' ? mkdtempSync(join(tmpdir(), 'agent-workflow-fold-cov-')) : null;
  let coverage; // v8 → Map<absKey, Array<Array<range>>>; lcov → Map<absKey, Map<line, hits>>
  let suiteExit = null; // (a) v4: the suite exit code — the credit fires only on exit 0
  try {
    const suiteEnv = coverageKind === 'v8' ? childTestEnv(env, { NODE_V8_COVERAGE: covDir }) : childTestEnv(env);
    const suite = spawnSync('bash', ['-c', cmd], { cwd: rootTop, env: suiteEnv, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
    if (suite.error && suite.error.code === 'ENOENT') throw stop('bash is unavailable — the suite command is a bash command line');
    suiteExit = suite.status; // number, or null when signal-killed (a null exit never credits — like nonzero)
    if (coverageKind === 'lcov') {
      const lcovText = readFileSafe(lcovAbs);
      if (lcovText == null) {
        throw stop(`coverage.kind is "lcov" but no LCOV file was found at "${lcovPath}" after the suite ran — ensure the suite writes LCOV there (see docs/ai/verification-profile.json)`);
      }
      coverage = lcovCoveredMap(lcovText, rootTop, { canon });
    } else {
      coverage = readCoverage(covDir);
    }
  } finally {
    if (covDir) rmSync(covDir, { recursive: true, force: true });
  }
  // (a) v4 suite-execution evidence: the ONE suite spawn per fingerprint, recorded so run-gates
  // --record can CREDIT the unit-tests gate from it (fingerprint-bound + tree-unchanged + cmd-identity
  // + exit-0 — the ledger writer enforces that). The POST fingerprint proves the suite left the tree
  // unchanged (coverage went out-of-tree / to a gitignored LCOV path).
  const fingerprintAfter = computeTreeFingerprint(cwd);
  const suite = { cmd, exit: suiteExit ?? null, fingerprintBefore: fingerprint, fingerprintAfter };
  const uncoveredChanged = [];
  for (const [rel, lines] of assessable) {
    const key = canon(join(rootTop, rel));
    if (coverageKind === 'lcov') {
      // LCOV supplies the per-file uncovered set directly (computeUncoveredLines stays the V8-only
      // path — D10); a file absent from the LCOV → a file-level RED, exactly like the V8 case.
      const uncov = uncoveredChangedFromLcov(coverage, key, lines);
      if (uncov === null) {
        uncoveredChanged.push({ file: rel, line: null });
        continue;
      }
      for (const n of uncov) uncoveredChanged.push({ file: rel, line: n });
    } else {
      const perProc = coverage.get(key);
      if (!perProc || perProc.length === 0) {
        uncoveredChanged.push({ file: rel, line: null }); // absent from coverage → file-level RED (Decision 6)
        continue;
      }
      const src = readFileSafe(join(rootTop, rel));
      if (src == null) continue;
      for (const n of computeUncoveredLines({ perProcessRanges: perProc, sourceText: src, changedLines: lines })) uncoveredChanged.push({ file: rel, line: n });
    }
  }

  // Decision 3 / 10 + D4: probe each of the SEGMENT's fixable-bug bound testIds N times
  // (shell-free, per-run timeout). Segment scope (D7): a committed phase's folds are closed
  // obligations — only triages recorded at the current base bind.
  const ledgerPath = resolveLedgerPath(cwd, env);
  const { records: reviewRecords } = ledgerPath ? readLedger(ledgerPath) : { records: [] };
  const base = resolveBase(cwd);
  const boundTestIds = collectBoundTestIds(reviewRecords, { activity: ACTIVITY, loop, base });
  const testIds = boundTestIds.map(
    (id) => probeBound({ id, rootTop, env, boundArgv, resultFormat, reruns: budgets.foldReruns, timeoutS: budgets.probeTimeoutS }).entry,
  );

  // Approach-3: the oracle-tamper pass over the tracked working-vs-HEAD diff, restricted to the
  // test surface ∪ the bound-testId file halves. Recorded; the checker enforces overrides.
  const tamper = computeTamperedTests(rootTop, new Set(boundTestIds.map((id) => splitTestId(id).file)));

  const record = {
    schema: RESULT_SCHEMA_VERSION,
    kind: 'run',
    loop,
    base,
    fingerprint,
    boundTestIds,
    testIds,
    unsupported,
    outOfDomain,
    coverage: { uncoveredChanged },
    tamper,
    suite, // (a) v4 suite-execution evidence
    mutation: { total: 0, killed: 0, survived: [], skipped: 0, killSetBasis: null }, // reserved — mutation not shipped (shelved)
    budgets,
    timestamp: isoNow(),
  };
  const v = validateRunRecord(record);
  if (!v.ok) throw stop(`refusing to write a malformed result record: ${v.reason}`);

  const resultsPath = resolveResultsPath(cwd, env);
  if (resultsPath == null) throw stop('cannot resolve the result-ledger path — not a git work tree and AW_FOLD_RESULTS is unset');
  return appendRecord(resultsPath, record);
};

// ── the --red verb (D6): observe RED when it actually happens, mint the custody receipt ──────────

// runRedProbe({ cwd, env, testId }) → { writtenPath, record }. Observes `testId` on the CURRENT
// (pre-fold) tree: resolvable + failing on N/N runs → appends a red-probe receipt (testId, counts,
// the test file's content hash, fingerprint, timestamp) to the fold results ledger. Observed green,
// unresolvable, mixed, or timed out → a typed refusal DISTINGUISHED by name, and NOTHING is written
// (D4: mixed/timeout is QUARANTINE — it never converts and has no override lane). No triage-order
// requirement: the checker joins receipts to the bound set at gate time (D6).
export const runRedProbe = ({ cwd = process.cwd(), env = process.env, testId } = {}) => {
  if (!isWellFormedTestId(testId)) {
    throw usageFail(`--red needs a well-formed testId "<test-file>#<test-name-pattern>" (a "#" separator, both halves non-empty; got ${JSON.stringify(testId)})`);
  }
  const root = gitStdout(['rev-parse', '--show-toplevel'], cwd);
  if (root == null) throw stop('not a git work tree — nothing to observe');
  const rootTop = root.replace(/\r?\n$/, '');
  const plans = plansInFlight(rootTop);
  if (plans.length === 0) throw stop('no plan in flight (docs/plans/ holds no active plan) — nothing to observe');
  if (plans.length > 1) throw stop(`more than one plan in flight (${plans.join(', ')}) — ambiguous loop id; resolve to one active plan`);
  const loop = plans[0].replace(/\.md$/, '');

  const { profile } = loadProfile(rootTop);
  const boundArgv = resolveBoundArgv(env, profile);
  const { resultFormat } = resolveSingleTest(profile);
  const budgets = budgetsFromEnv(env);
  const { entry, resolveReason } = probeBound({ id: testId, rootTop, env, boundArgv, resultFormat, reruns: budgets.foldReruns, timeoutS: budgets.probeTimeoutS });
  const verdict = probeVerdict(entry);
  const counts = `${entry.greens} green / ${entry.reds} red / ${entry.timeouts} timed out / ${entry.runs - entry.greens - entry.reds - entry.timeouts} unresolved of ${entry.runs} run(s)`;
  if (verdict === 'unresolvable') {
    throw stop(
      `--red refused for "${testId}": unresolvable — ${resolveReason ?? 'the pattern selects no test'} (${counts}). ` +
        `If the test cannot even LOAD pre-fold (it imports an export the fix introduces), author it with a dynamic import() so it loads and FAILS pre-fold; ` +
        `if the red is genuinely unestablishable, the loud escape is a recorded red-proof override (review-ledger-write override). Nothing was recorded.`,
    );
  }
  if (verdict === 'green') {
    throw stop(
      `--red refused for "${testId}": observed GREEN on ${entry.greens}/${entry.runs} runs — the test does not fail on the current (pre-fold) tree, so it proves nothing about the fix. ` +
        `Write a test that FAILS before the fix is applied, then re-run --red BEFORE folding the fix. Nothing was recorded.`,
    );
  }
  if (verdict === 'quarantine') {
    const flavor = entry.timeouts > 0
      ? `${entry.timeouts} of ${entry.runs} probe run(s) timed out (AW_FOLD_PROBE_TIMEOUT_S=${budgets.probeTimeoutS}) — a timed-out run is neither red nor green`
      : `mixed outcomes (${counts}) — a flaky test can launder a fake red`;
    throw stop(
      `--red refused for "${testId}": QUARANTINE — ${flavor}. QUARANTINE never converts and has no override lane: ` +
        `${entry.timeouts > 0 ? 'raise the timeout or make the test faster' : 'replace the flaky test'}, then re-observe. Nothing was recorded.`,
    );
  }

  const record = {
    schema: RESULT_SCHEMA_VERSION,
    kind: 'red-probe',
    loop,
    base: resolveBase(cwd), // the SEGMENT frame (D7): a receipt attests red within its segment
    testId,
    fileHash: entry.fileHash,
    runs: entry.runs,
    reds: entry.reds,
    fingerprint: computeTreeFingerprint(cwd),
    timestamp: isoNow(),
  };
  const v = validateRunRecord(record);
  if (!v.ok) throw stop(`refusing to write a malformed red-probe record: ${v.reason}`);
  const resultsPath = resolveResultsPath(cwd, env);
  if (resultsPath == null) throw stop('cannot resolve the result-ledger path — not a git work tree and AW_FOLD_RESULTS is unset');
  return appendRecord(resultsPath, record);
};

// ── the --reattest verb (c): re-anchor custody at a bound test file's CURRENT bytes ────────────────

// runReattest({ cwd, env, testId }) → { writtenPath, record }. Records the test file's CURRENT hash as
// a custody anchor after a green-only append — the honest replacement for mis-using a red-proof waiver
// (a green append has no red to observe). Operator-ASSERTED, never auto-detected: "additions-only" is
// unsafe to auto-relax (an in-body `return;` is additions-only yet weakening). Re-attest ONLY re-anchors
// custody — the N/N-green probe and observed-red receipt requirements are unchanged, so a red test
// still fails the gate, and the custody guard still fails closed on any un-reattested change.
export const runReattest = ({ cwd = process.cwd(), env = process.env, testId } = {}) => {
  if (!isWellFormedTestId(testId)) {
    throw usageFail(`--reattest needs a well-formed testId "<test-file>#<test-name-pattern>" (a "#" separator, both halves non-empty; got ${JSON.stringify(testId)})`);
  }
  const root = gitStdout(['rev-parse', '--show-toplevel'], cwd);
  if (root == null) throw stop('not a git work tree — nothing to re-attest');
  const rootTop = root.replace(/\r?\n$/, '');
  const plans = plansInFlight(rootTop);
  if (plans.length === 0) throw stop('no plan in flight (docs/plans/ holds no active plan) — nothing to re-attest');
  if (plans.length > 1) throw stop(`more than one plan in flight (${plans.join(', ')}) — ambiguous loop id; resolve to one active plan`);
  const loop = plans[0].replace(/\.md$/, '');

  const { file } = splitTestId(testId);
  const resolved = resolveTestFile(rootTop, file);
  if (!resolved.ok) throw stop(`--reattest refused for "${testId}": ${resolved.reason} — cannot anchor custody to a file that does not resolve safely`);
  const fileHash = hashFileBytes(resolved.abs);
  if (fileHash == null) throw stop(`--reattest refused for "${testId}": cannot read "${file}" — nothing to anchor`);

  const record = {
    schema: RESULT_SCHEMA_VERSION,
    kind: REATTEST_KIND,
    loop,
    base: resolveBase(cwd), // the SEGMENT frame (D7): a re-attest never crosses a commit boundary
    testId,
    fileHash,
    fingerprint: computeTreeFingerprint(cwd),
    timestamp: isoNow(),
  };
  const v = validateRunRecord(record);
  if (!v.ok) throw stop(`refusing to write a malformed re-attest record: ${v.reason}`);
  const resultsPath = resolveResultsPath(cwd, env);
  if (resultsPath == null) throw stop('cannot resolve the result-ledger path — not a git work tree and AW_FOLD_RESULTS is unset');
  return appendRecord(resultsPath, record);
};

// ── the --preflight verb (f): the CHEAP half — the overrides/re-attests to record BEFORE coverage ──

// runPreflight({ cwd, env }) → { loop, base, fingerprint, boundTestIds, tamper, actions }. Read-only:
// runs only the cheap set (ledger reads + tamper + per-bound-file custody hashing) and returns the
// actions to RECORD before the expensive coverage/probe pass, routed by kind — `oracle-change` for a
// tampered test file, `reattest` for a green-only custody delta, `red` for a bound testId with no
// observed-red receipt. Coverage is never predicted, the suite is never spawned, nothing is written.
export const runPreflight = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const root = gitStdout(['rev-parse', '--show-toplevel'], cwd);
  if (root == null) throw stop('not a git work tree — nothing to preflight');
  const rootTop = root.replace(/\r?\n$/, '');
  const plans = plansInFlight(rootTop);
  if (plans.length === 0) throw stop('no plan in flight (docs/plans/ holds no active plan) — nothing to preflight');
  if (plans.length > 1) throw stop(`more than one plan in flight (${plans.join(', ')}) — ambiguous loop id; resolve to one active plan`);
  const loop = plans[0].replace(/\.md$/, '');
  const base = resolveBase(cwd);
  const fingerprint = computeTreeFingerprint(cwd);

  // Cheap reads only — the ledgers + the git diff. No suite, no probes, no coverage (the reorder note:
  // these live AFTER the coverage block in runFoldCompleteness; the preflight pulls them forward).
  const ledgerPath = resolveLedgerPath(cwd, env);
  // Fail CLOSED on an unreadable/malformed review ledger — the SAME posture decideCheck takes (a
  // dropped line could hide a bound testId / an override); never a false all-clear.
  const reviewRead = ledgerPath ? readLedger(ledgerPath) : { records: [], malformed: 0 };
  if (reviewRead.readError) throw stop(`cannot read the review ledger (${reviewRead.readError}) — failing closed; inspect ${ledgerPath}`);
  if (reviewRead.malformed > 0) throw stop(`the review ledger has ${reviewRead.malformed} malformed line(s) — failing closed; inspect ${ledgerPath}`);
  const reviewRecords = reviewRead.records;
  const boundTestIds = collectBoundTestIds(reviewRecords, { activity: ACTIVITY, loop, base });
  const boundSet = new Set(boundTestIds);
  const boundFiles = new Set(boundTestIds.map((id) => splitTestId(id).file));
  const tamper = computeTamperedTests(rootTop, boundFiles); // the SAME tamper surface the run records
  const tamperedSet = new Set(tamper.tampered);
  const overrides = collectOverrides(reviewRecords, { activity: ACTIVITY, loop });

  const resultsPath = resolveResultsPath(cwd, env);
  const resultRead = resultsPath ? readResults(resultsPath) : { records: [], malformed: 0 };
  if (resultRead.readError) throw stop(`cannot read the result ledger (${resultRead.readError}) — failing closed; inspect ${resultsPath}`);
  if (resultRead.malformed > 0) throw stop(`the result ledger has ${resultRead.malformed} malformed line(s) — failing closed; inspect ${resultsPath}`);
  const segRecords = filterSegmentResults(resultRead.records, loop, base);
  const anchors = segRecords.filter((r) => isRedProbeRecord(r) || isReattestRecord(r)); // custody anchors
  const receipts = segRecords.filter((r) => isRedProbeRecord(r)); // observed-red receipts only

  const actions = [];
  // 1. tampered test-surface files → oracle-change (unless already covered). ORTHOGONAL to the
  //    per-testId chain below: decideCheck's tamper guard and its per-testId observed-red + custody
  //    chain are independent guards — a tampered bound file needs BOTH an oracle-change AND a
  //    current-bytes custody anchor for each of its bound testIds.
  for (const f of tamper.tampered) {
    if (overrides.oracleChangeFiles.has(f)) continue;
    actions.push({
      kind: 'oracle-change',
      file: f,
      command: `node review-ledger-write.mjs override --json '{"loop":"${loop}","round":<n>,"scope":"oracle-change","files":${JSON.stringify([f])},"reason":"<why the expectation legitimately changed>"}'`,
    });
  }
  // 2. per bound testId — mirror decideCheck's per-testId requirements. There is NO tamper skip: a
  //    tampered file's bound testIds STILL face the receipt + custody chain, so skipping them read as a
  //    false all-clear. Ordered as decideCheck evaluates: unresolvable (a hard fail before any override
  //    lane) → missing receipt → custody delta.
  const reattestedFiles = new Set(); // one re-attest re-anchors the whole file (decideCheck keys custody by file) — dedup
  const unresolvableFiles = new Set(); // recovery is file-level (restore / re-triage) — dedup
  for (const id of boundTestIds) {
    const { file } = splitTestId(id);
    const resolved = resolveTestFile(rootTop, file);
    const currentHash = resolved.ok ? hashFileBytes(resolved.abs) : null;
    if (currentHash == null) {
      // the bound file does not resolve → decideCheck fails `unresolvable` UNCONDITIONALLY, BEFORE the
      // red-proof / oracle-change lanes (probeVerdict `unresolvable` precedes the red-proof `continue`) —
      // no override lifts it. This check MUST precede the red-proof skip below, else a red-proof'd deleted
      // bound file reads clear here yet fails decideCheck. A deleted file is also tampered (the
      // oracle-change above fires), but that does NOT rescue a deletion; surface the blocker.
      if (!unresolvableFiles.has(file)) {
        unresolvableFiles.add(file);
        actions.push({
          kind: 'unresolvable',
          testId: id,
          file,
          note: `the bound test file ${file} does not resolve — the probe reads unresolvable and no override (oracle-change / red-proof / re-attest) lifts it; restore the file or re-triage the fixable-bug binding`,
        });
      }
      continue;
    }
    if (overrides.redProofTestIds.has(id)) continue; // red-proof waives the receipt + custody proof — but ONLY for a resolvable file (the unresolvable guard above runs first, per decideCheck)
    const own = receipts.filter((r) => r.testId === id);
    if (own.length === 0) {
      // no observed-red receipt — strictly per-testId (never deduped by file).
      actions.push({
        kind: 'red',
        testId: id,
        command: `node fold-completeness-run.mjs --red ${JSON.stringify(id)}`,
        note: tamperedSet.has(file)
          ? 'the test file was modified (tampered) — observe red at the modified expectations before folding; if the red is genuinely unestablishable, record a red-proof override instead'
          : 'observe red BEFORE folding the fix; if the red is genuinely unestablishable, record a red-proof override instead',
      });
      continue;
    }
    const fileAnchors = anchors.filter((r) => boundSet.has(r.testId) && splitTestId(r.testId).file === file);
    const latestAnchor = fileAnchors[fileAnchors.length - 1];
    if (latestAnchor && latestAnchor.fileHash === currentHash) continue; // custody intact → no action
    if (tamperedSet.has(file)) {
      // a tampered (modified/removed old-side) file → re-observe red: the prior red-probe proved the OLD
      // oracle and is now stale; --reattest is scoped to a green-only append and cannot honestly anchor a
      // real edit (decideCheck's own recovery for a real edit is to re-observe red).
      actions.push({
        kind: 'red',
        testId: id,
        command: `node fold-completeness-run.mjs --red ${JSON.stringify(id)}`,
        note: 're-observe red at the modified (tampered) expectations — --reattest is scoped to a green-only append and cannot anchor a real edit',
      });
    } else if (!reattestedFiles.has(file)) {
      // an additions-only custody delta (NOT tampered — no old-side removal) → CANDIDATE for re-attest.
      // The tamper flag catches removed/modified old-side lines, but an additions-only edit can still
      // WEAKEN a bound test (an inserted early `return;` before the assertions) — undetectable without
      // AST (the AD-047 residual). So preflight only SUGGESTS re-attest, with a caveat: re-attest is
      // honest for a genuine green-only APPEND (a new sibling test); for an in-body insertion, re-observe
      // red (--red) instead. The custody guard stays fail-closed until the operator records one or other.
      reattestedFiles.add(file);
      actions.push({
        kind: 'reattest',
        testId: id,
        file,
        command: `node fold-completeness-run.mjs --reattest ${JSON.stringify(id)}`,
        note: 'valid only for a genuine green-only APPEND (a new sibling test); if the change INSERTS into an existing bound test body (an additions-only edit can still weaken it), re-observe red instead: node fold-completeness-run.mjs --red ' + JSON.stringify(id),
      });
    }
  }
  return { loop, base, fingerprint, boundTestIds, tamper, actions };
};

// renderPreflight(state) → a human block: the loop/base + the routed actions (or an all-clear note).
export const renderPreflight = ({ loop, boundTestIds, tamper, actions }) => {
  const lines = [
    `fold-completeness preflight — loop "${loop}" (cheap half; the suite was NOT run, nothing was written)`,
    `  bound testIds: ${boundTestIds.length ? boundTestIds.join(', ') : '(none)'}`,
    `  tampered test-surface files: ${tamper.tampered.length ? tamper.tampered.join(', ') : 'none'}`,
  ];
  if (actions.length === 0) {
    lines.push('  ✓ no overrides / re-attests needed before the coverage pass — run: node fold-completeness-run.mjs');
    return lines.join('\n');
  }
  lines.push(`  ${actions.length} action(s) to resolve BEFORE the coverage pass:`);
  const head = (a) => {
    if (a.kind === 'oracle-change') return `oracle-change for ${a.file}`;
    if (a.kind === 'reattest') return `re-attest ${a.testId} (green-only custody delta)`;
    if (a.kind === 'unresolvable') return `unresolvable bound file ${a.file} — restore or re-triage`;
    return `observe red for ${a.testId}`;
  };
  for (const a of actions) {
    lines.push(`    [${a.kind}] ${head(a)}`);
    if (a.command) lines.push(`      ${a.command}`);
    if (a.note) lines.push(`      (${a.note})`);
  }
  return lines.join('\n');
};

// ── the --findings verb (1.4): OPTIONAL SARIF advisory intake — print-only, NEVER recorded ────────

// runFindings({ cwd, env }) → { findings, note }. Reads the profile's findings.sarifPath, ADVISORY
// ONLY: nothing is written and the fold gate never reads SARIF, so it can never block a fold. Absent
// path / missing file → a no-op note; a malformed SARIF throws (a loud advisory failure), --check
// unaffected.
export const runFindings = ({ cwd = process.cwd(), env = process.env } = {}) => {
  const root = gitStdout(['rev-parse', '--show-toplevel'], cwd);
  const rootTop = root == null ? cwd : root.replace(/\r?\n$/, '');
  const { profile } = loadProfile(rootTop);
  const sarifPath = resolveSarifPath(profile);
  if (!sarifPath) return { findings: [], note: 'no findings.sarifPath declared in the verification profile — nothing to read (SARIF advisory is opt-in)' };
  const abs = isAbsolute(sarifPath) ? sarifPath : join(rootTop, sarifPath);
  const text = readFileSafe(abs);
  if (text == null) return { findings: [], note: `no SARIF file at "${sarifPath}" — the suite may not have written it yet (advisory, non-blocking)` };
  const { findings } = parseSarif(text); // throws on malformed → the CLI exits nonzero (advisory-loud)
  return { findings, note: null };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `fold-completeness-run — the M3 fold-completeness RUNNER (agent-workflow family, AD-046 + AD-047).

Usage:
  node fold-completeness-run.mjs [--suite "<cmd>"] [--cwd <dir>]
  node fold-completeness-run.mjs --red "<test-file>#<test-name-pattern>" [--cwd <dir>]
  node fold-completeness-run.mjs --reattest "<test-file>#<test-name-pattern>" [--cwd <dir>]
  node fold-completeness-run.mjs --preflight [--cwd <dir>]
  node fold-completeness-run.mjs --findings [--cwd <dir>]

The default run: runs the in-flight plan-execution loop's suite ONCE under coverage, maps every
changed executable line to covered/uncovered, probes each of the SEGMENT's fixable-bug bound testIds
N times (AW_FOLD_RERUNS, default 3) for resolvability + an N/N-green baseline, records each bound test
file's content hash (custody), the suite-execution evidence (cmd + exit + pre/post fingerprints), and
appends one v4 run record — segment-framed (base = git rev-parse
HEAD; the bound set is the current segment's, AD-048 D7) — to
<git dir>/${'agent-workflow-fold-completeness.jsonl'} (AW_FOLD_RESULTS overrides).

--red observes a testId RED on the CURRENT (pre-fold) tree — the honest fold-time order is: classify
the fixable-bug with its testId → write the test → --red observes it FAIL (N/N) BEFORE the fix is
applied → fold the fix → the normal run observes green → the gate checks receipt + order + custody.
An N/N red mints a red-probe receipt (testId, counts, content hash, fingerprint, and base — the
current SEGMENT frame: a receipt never crosses a commit boundary); observed-green /
unresolvable / mixed / timed-out are DISTINGUISHED typed refusals and nothing is written
(mixed/timeout = QUARANTINE — never converts, no override lane).

--reattest re-anchors a bound test FILE's custody at its CURRENT bytes WITHOUT observing red — the
honest replacement for a red-proof waiver after a GREEN-ONLY test-file append (there is no red to
observe). It mints a fold-v4 re-attest receipt (testId + the current file hash). It is
operator-asserted (self-discipline, the same trust model as the recorded overrides), NOT auto-detected:
the custody guard still fails CLOSED on any un-reattested change, and re-attest never converts a red
baseline or waives the observed-red proof (a weakened/red test still fails the gate).

Suite command: --suite "<cmd>" or AW_FOLD_SUITE_CMD, else the unit-tests gate cmd in docs/ai/gates.json.
Bound-test probes default to node --test --test-name-pattern (shell-free); AW_FOLD_BOUND_CMD overrides
with a JSON argv array using {file}/{pattern}. Probe knobs (fail-closed positive integers):
AW_FOLD_RERUNS (default 3) · AW_FOLD_PROBE_TIMEOUT_S (default 120, per probe RUN, probes only).
Inert budgets: AW_FOLD_MUTANTS_MAX / AW_FOLD_HUNK_MUTANTS_MAX / AW_FOLD_TIME_BUDGET_S (mutation shelved).

The VERIFICATION PROFILE (docs/ai/verification-profile.json, BUGFREE-3) generalizes the coverage
SOURCE (coverage.kind v8|lcov + lcovPath) and the single-test RESULT FORMAT (singleTest.argv +
resultFormat tap-stdout|tap-file|junit-xml; a file-based format's argv carries {resultPath}). Absent →
today's exact behaviour (V8 + node:test TAP on stdout). Env knobs still override (AW_FOLD_SUITE_CMD /
AW_FOLD_BOUND_CMD win over the profile).

--preflight runs ONLY the cheap half (the tamper surface + custody deltas from the git diff + the
ledgers, seconds) WITHOUT the coverage suite run: it prints the overrides / re-attests to RECORD
BEFORE the expensive pass — routed by kind: oracle-change for a tampered test file, --reattest for a
green-only custody delta, --red (or a red-proof override if the red is unestablishable) for a bound
testId with no observed-red receipt yet. It spawns no suite, runs no probe, predicts no coverage, and
writes nothing.

--findings reads the profile's OPTIONAL findings.sarifPath and PRINTS the SARIF findings — ADVISORY
ONLY: nothing is recorded, and the fold gate (fold-completeness --check) never reads SARIF, so it can
never block a fold. Absent path / missing file → a stated no-op; a malformed SARIF exits nonzero (a
loud advisory failure) but leaves --check unaffected.

The read-only gate is a SEPARATE tool: node fold-completeness.mjs --check / --status / --json.

Sandbox-safe: the RUNNER itself needs no network and writes only repo-local state (the D4 sandbox
lane). The spawned suite/bound commands are COMMAND-SHAPE dependent — --suite / AW_FOLD_SUITE_CMD /
AW_FOLD_BOUND_CMD / the verification profile can name project-defined commands; the default
(node --test on stdout TAP) is plain and no-network — keep overrides sandbox-safe by shape.

Exit codes: 0 written / advisory printed; 1 a typed STOP (loop derivation / suite discovery / a --red
or --reattest refusal / a malformed SARIF on --findings / malformed record / fs error); 2 usage.`;

const parseArgs = (argv) => {
  const opts = { cwd: undefined, suite: undefined, red: undefined, reattest: undefined, findings: false, preflight: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cwd') {
      opts.cwd = argv[i + 1];
      if (opts.cwd === undefined) throw usageFail('--cwd needs a directory');
      i += 1;
    } else if (a === '--suite') {
      opts.suite = argv[i + 1];
      if (opts.suite === undefined) throw usageFail('--suite needs a command');
      i += 1;
    } else if (a === '--red') {
      opts.red = argv[i + 1];
      if (opts.red === undefined) throw usageFail('--red needs a testId ("<test-file>#<test-name-pattern>")');
      i += 1;
    } else if (a === '--reattest') {
      opts.reattest = argv[i + 1];
      if (opts.reattest === undefined) throw usageFail('--reattest needs a testId ("<test-file>#<test-name-pattern>")');
      i += 1;
    } else if (a === '--findings') {
      opts.findings = true;
    } else if (a === '--preflight') {
      opts.preflight = true;
    } else {
      throw usageFail(`unknown argument: ${a}`);
    }
  }
  return opts;
};

export const main = (argv, ctx = {}) => {
  const cwd0 = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const opts = parseArgs(argv);
    const cwd = opts.cwd ?? cwd0;
    if (opts.preflight) {
      return { code: 0, stdout: renderPreflight(runPreflight({ cwd, env })), stderr: '' };
    }
    if (opts.findings) {
      const { findings, note } = runFindings({ cwd, env });
      return { code: 0, stdout: note ?? renderSarifFindings(findings), stderr: '' };
    }
    if (opts.red !== undefined) {
      const { writtenPath, record } = runRedProbe({ cwd, env, testId: opts.red });
      return {
        code: 0,
        stdout: `fold-completeness-run: minted a red-probe receipt for "${record.testId}" (loop "${record.loop}", ${record.reds}/${record.runs} observed red, hash ${record.fileHash.slice(0, 12)}…) → ${writtenPath}`,
        stderr: '',
      };
    }
    if (opts.reattest !== undefined) {
      const { writtenPath, record } = runReattest({ cwd, env, testId: opts.reattest });
      return {
        code: 0,
        stdout: `fold-completeness-run: minted a custody re-attest for "${record.testId}" (loop "${record.loop}", hash ${record.fileHash.slice(0, 12)}…) → ${writtenPath}`,
        stderr: '',
      };
    }
    const { writtenPath, record } = runFoldCompleteness({ cwd, env, suiteCmd: opts.suite });
    const uncovered = record.coverage.uncoveredChanged.length;
    const unresolved = record.testIds.filter((t) => !t.resolvable || !t.baselineGreen).length;
    return {
      code: 0,
      stdout: `fold-completeness-run: recorded a run for loop "${record.loop}" (${record.boundTestIds.length} bound testId(s), ${unresolved} unresolved/red, ${uncovered} uncovered changed line(s), ${record.unsupported.length} unsupported, ${record.outOfDomain.length} out-of-domain) → ${writtenPath}`,
      stderr: '',
    };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `fold-completeness-run: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}
