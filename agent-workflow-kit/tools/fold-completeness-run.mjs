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
import { resolveLedgerPath, resolveBase, readLedger, isWellFormedTestId, splitTestId } from './review-ledger.mjs';
import {
  RESULT_SCHEMA_VERSION,
  resolveResultsPath,
  validateRunRecord,
  collectBoundTestIds,
  probeVerdict,
} from './fold-completeness.mjs';
// The changed-surface computation lives in the NEUTRAL shared module (BUGFREE-2 / AD-048, D4): the
// review-ledger writer's diff-size cap and this runner's coverage domain consume ONE computation,
// and the writer never imports this runner (the sole-tree-toucher boundary — import-split pinned).
// Re-exported below so the runner's tests (and any consumer) keep one entry point per concern.
import { classifyChangedPath, parseUnifiedDiff, unquoteDiffPath, computeChangedSurface, DIFF_FLAGS, parsePositiveIntKnob } from './changed-surface.mjs';

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
const childTestEnv = (env, extra = {}) => {
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

const PROBE_RESULT_RE = /^(?:ok|not ok) \d+ - (.*)$/; // a column-0 TAP result line
const PROBE_FAIL_RE = /^# fail (\d+)$/;
const PROBE_DIRECTIVE_RE = /#\s*(?:skip|todo)\b/i; // a TAP SKIP/TODO directive — the test did NOT run

// parseProbeOutput({ stdout, code, fileArg }) → { resolvable, executed, baselineGreen }. A node:test
// run with a pattern that matches NOTHING emits only a file-wrapper result whose description is the
// file path itself (`ok N - <file>`) on newer node — but node 18/20 ALSO emit every pattern-FILTERED
// test as `ok N - <name> # SKIP test name does not match pattern`, so a result line carrying a TAP
// SKIP/TODO directive must never count: the test was not executed, and counting it green-vouches a
// nonexistent testId on exactly the node versions the kit supports (caught by CI's 18/20 matrix).
// So `resolvable` = at least one column-0, directive-free result whose description is not the file we
// passed; `baselineGreen` = resolvable AND the run was green (exit 0 and `# fail 0`). The wrapper is
// matched by BASENAME, not literally: node normalizes the echoed path ('./x' → 'x', or an absolute
// path), so a literal desc===fileArg compare would count the wrapper as a real match and falsely
// report resolvable/green (codex R1). A basename compare is invariant to ./ / abs / rel; a real test
// name colliding with the file's basename — or containing a literal "# skip" — is absurd and would
// only fail CLOSED (mark unresolvable), never open.
export const parseProbeOutput = ({ stdout, code, fileArg }) => {
  let matched = 0;
  let failCount = null;
  const wanted = basename(String(fileArg).trim());
  for (const line of String(stdout).split('\n')) {
    const m = PROBE_RESULT_RE.exec(line);
    if (m && !PROBE_DIRECTIVE_RE.test(m[1]) && basename(m[1].trim()) !== wanted) matched += 1;
    const f = PROBE_FAIL_RE.exec(line.trim());
    if (f) failCount = Number(f[1]);
  }
  const resolvable = matched > 0;
  const fails = failCount ?? (code === 0 ? 0 : 1);
  return { resolvable, executed: matched, baselineGreen: resolvable && code === 0 && fails === 0 };
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

// resolveBoundArgv(env) → (file, pattern) => argv[]. Default = the node:test shape; AW_FOLD_BOUND_CMD
// overrides with a JSON array of argv strings using {file}/{pattern} placeholders (the universality
// escape hatch — a consumer on another runner). A malformed override is a typed refusal, never a
// silent fallback to a shell. Substitution uses function replacers so a `$` in a testId is literal.
export const resolveBoundArgv = (env = process.env) => {
  const raw = env.AW_FOLD_BOUND_CMD;
  if (!raw) return (file, pattern) => defaultBoundArgv(file, pattern);
  let tmpl;
  try {
    tmpl = JSON.parse(raw);
  } catch (err) {
    throw stop(`AW_FOLD_BOUND_CMD is not valid JSON (${err.message}) — expected a JSON array of argv strings`);
  }
  if (!Array.isArray(tmpl) || tmpl.length === 0 || !tmpl.every((a) => typeof a === 'string')) {
    throw stop('AW_FOLD_BOUND_CMD must be a non-empty JSON array of argv strings with {file}/{pattern} placeholders');
  }
  return (file, pattern) => tmpl.map((a) => a.replace(/\{file\}/g, () => file).replace(/\{pattern\}/g, () => pattern));
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
const probeBound = ({ id, rootTop, env, boundArgv, reruns, timeoutS }) => {
  const { file, pattern } = splitTestId(id);
  const resolved = resolveTestFile(rootTop, file);
  const fileHash = resolved.ok ? hashFileBytes(resolved.abs) : null;
  let executed = 0;
  let greens = 0;
  let reds = 0;
  let timeouts = 0;
  if (resolved.ok && fileHash != null) {
    // ALWAYS spawn the resolver's canonical absolute path — the executed file must be the hashed
    // file independent of runner path semantics (codex R1+R2, BUGFREE-1 live loop): a raw
    // leading-dash filename parses as an OPTION (and a ./-prefix does not survive node's runner
    // normalization), and a raw traversal path like linkdir/../x lets an OS-resolving runner
    // execute a different filesystem target than the lexically-normalized file the hash covers.
    const argv = boundArgv(resolved.abs, pattern);
    for (let i = 0; i < reruns; i += 1) {
      const res = spawnSync(argv[0], argv.slice(1), {
        cwd: rootTop, env: childTestEnv(env), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: timeoutS * 1000,
      });
      if ((res.error && res.error.code === 'ETIMEDOUT') || res.signal != null) {
        timeouts += 1;
        continue;
      }
      const p = parseProbeOutput({ stdout: res.stdout ?? '', code: res.error ? 1 : res.status ?? 1, fileArg: file });
      executed = Math.max(executed, p.executed);
      if (!p.resolvable) continue; // an unresolved run (the pattern selected nothing)
      if (p.baselineGreen) greens += 1;
      else reds += 1;
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
  const boundArgv = resolveBoundArgv(env); // resolves BEFORE any spawn (a malformed override refuses loudly)
  const budgets = budgetsFromEnv(env);

  const { assessable, unsupported, outOfDomain } = computeChangedSurface(rootTop);

  // M3a: run the suite once under coverage in a dir OUTSIDE the work tree (Decision 8), then map.
  const covDir = mkdtempSync(join(tmpdir(), 'agent-workflow-fold-cov-'));
  let coverage;
  try {
    const suite = spawnSync('bash', ['-c', cmd], { cwd: rootTop, env: childTestEnv(env, { NODE_V8_COVERAGE: covDir }), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
    if (suite.error && suite.error.code === 'ENOENT') throw stop('bash is unavailable — the suite command is a bash command line');
    coverage = readCoverage(covDir);
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
  const uncoveredChanged = [];
  for (const [rel, lines] of assessable) {
    const perProc = coverage.get(canon(join(rootTop, rel)));
    if (!perProc || perProc.length === 0) {
      uncoveredChanged.push({ file: rel, line: null }); // absent from coverage → file-level RED (Decision 6)
      continue;
    }
    const src = readFileSafe(join(rootTop, rel));
    if (src == null) continue;
    for (const n of computeUncoveredLines({ perProcessRanges: perProc, sourceText: src, changedLines: lines })) uncoveredChanged.push({ file: rel, line: n });
  }

  // Decision 3 / 10 + D4: probe each of the SEGMENT's fixable-bug bound testIds N times
  // (shell-free, per-run timeout). Segment scope (D7): a committed phase's folds are closed
  // obligations — only triages recorded at the current base bind.
  const ledgerPath = resolveLedgerPath(cwd, env);
  const { records: reviewRecords } = ledgerPath ? readLedger(ledgerPath) : { records: [] };
  const base = resolveBase(cwd);
  const boundTestIds = collectBoundTestIds(reviewRecords, { activity: ACTIVITY, loop, base });
  const testIds = boundTestIds.map(
    (id) => probeBound({ id, rootTop, env, boundArgv, reruns: budgets.foldReruns, timeoutS: budgets.probeTimeoutS }).entry,
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

  const boundArgv = resolveBoundArgv(env);
  const budgets = budgetsFromEnv(env);
  const { entry, resolveReason } = probeBound({ id: testId, rootTop, env, boundArgv, reruns: budgets.foldReruns, timeoutS: budgets.probeTimeoutS });
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

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `fold-completeness-run — the M3 fold-completeness RUNNER (agent-workflow family, AD-046 + AD-047).

Usage:
  node fold-completeness-run.mjs [--suite "<cmd>"] [--cwd <dir>]
  node fold-completeness-run.mjs --red "<test-file>#<test-name-pattern>" [--cwd <dir>]

The default run: runs the in-flight plan-execution loop's suite ONCE under coverage, maps every
changed executable line to covered/uncovered, probes each of the SEGMENT's fixable-bug bound testIds
N times (AW_FOLD_RERUNS, default 3) for resolvability + an N/N-green baseline, records each bound test
file's content hash (custody), and appends one v3 run record — segment-framed (base = git rev-parse
HEAD; the bound set is the current segment's, AD-048 D7) — to
<git dir>/${'agent-workflow-fold-completeness.jsonl'} (AW_FOLD_RESULTS overrides).

--red observes a testId RED on the CURRENT (pre-fold) tree — the honest fold-time order is: classify
the fixable-bug with its testId → write the test → --red observes it FAIL (N/N) BEFORE the fix is
applied → fold the fix → the normal run observes green → the gate checks receipt + order + custody.
An N/N red mints a red-probe receipt (testId, counts, content hash, fingerprint, and base — the
current SEGMENT frame: a receipt never crosses a commit boundary); observed-green /
unresolvable / mixed / timed-out are DISTINGUISHED typed refusals and nothing is written
(mixed/timeout = QUARANTINE — never converts, no override lane).

Suite command: --suite "<cmd>" or AW_FOLD_SUITE_CMD, else the unit-tests gate cmd in docs/ai/gates.json.
Bound-test probes default to node --test --test-name-pattern (shell-free); AW_FOLD_BOUND_CMD overrides
with a JSON argv array using {file}/{pattern}. Probe knobs (fail-closed positive integers):
AW_FOLD_RERUNS (default 3) · AW_FOLD_PROBE_TIMEOUT_S (default 120, per probe RUN, probes only).
Inert budgets: AW_FOLD_MUTANTS_MAX / AW_FOLD_HUNK_MUTANTS_MAX / AW_FOLD_TIME_BUDGET_S (mutation shelved).

The read-only gate is a SEPARATE tool: node fold-completeness.mjs --check / --status / --json.

Exit codes: 0 written; 1 a typed STOP (loop derivation / suite discovery / a --red refusal / malformed
record / fs error); 2 usage.`;

const parseArgs = (argv) => {
  const opts = { cwd: undefined, suite: undefined, red: undefined };
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
    if (opts.red !== undefined) {
      const { writtenPath, record } = runRedProbe({ cwd, env, testId: opts.red });
      return {
        code: 0,
        stdout: `fold-completeness-run: minted a red-probe receipt for "${record.testId}" (loop "${record.loop}", ${record.reds}/${record.runs} observed red, hash ${record.fileHash.slice(0, 12)}…) → ${writtenPath}`,
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
