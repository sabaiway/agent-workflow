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
//   4. probe each of the loop's fixable-bug bound testIds once (Decision 3 / 10, shell-free) for
//      resolvability + a green baseline;
//   5. append ONE machine-only result record, bound to BOTH the tree fingerprint AND the sorted
//      fixable-bug testId set (Decision 9), to <git dir>/agent-workflow-fold-completeness.jsonl.
// The researched mutation half (M3b) was SHELVED — bounded local-boundary mutation adds too little
// over coverage and is not language-independent — so the `mutation` field stays the reserved empty shape.
//
// HONEST residuals (see fold-completeness.mjs header for the full list): coverage proves execution not
// assertion; testIds/records are forgeable (a self-discipline mechanism, not a security boundary);
// TS/JSX source is out of scope v1. Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, readdirSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeContainedFileAtomic } from './atomic-write.mjs';
import { computeTreeFingerprint, plansInFlight } from './review-state.mjs';
import { resolveLedgerPath, readLedger } from './review-ledger.mjs';
import {
  RESULT_SCHEMA_VERSION,
  resolveResultsPath,
  validateRunRecord,
  collectBoundTestIds,
} from './fold-completeness.mjs';

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

// ── Decision 5: the CLOSED changed-path classification rule (no heuristics) ───────────────────────

const TEST_FILE_RE = /\.(test|spec)\.[^./]+$/; // a.test.mjs, b.spec.js, c.test.cjs, d.spec.ts
const ASSESSABLE_EXT = new Set(['.mjs', '.cjs', '.js']);
const UNSUPPORTED_EXT = new Set(['.ts', '.tsx', '.jsx', '.mts', '.cts']);

// classifyChangedPath(rel) → 'assessable' | 'unsupported' | 'out-of-domain' | 'excluded-test'.
export const classifyChangedPath = (rel) => {
  const base = rel.split('/').pop();
  if (TEST_FILE_RE.test(base)) return 'excluded-test';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot) : '';
  if (ASSESSABLE_EXT.has(ext)) return 'assessable';
  if (UNSUPPORTED_EXT.has(ext)) return 'unsupported';
  return 'out-of-domain';
};

// ── unified-diff → new-side changed line numbers (line numbers only; content lines are ignored) ───

const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// parseUnifiedDiff(diffText) → Map<rel, number[]>. Robust against a content line that happens to look
// like a `+++ ` header: a `+++ ` line is a FILE header only in the header region (right after a
// `diff --git`, before any `@@`); inside a hunk body it is ignored. New-side lines come purely from the
// `@@` headers, so no content-line disambiguation is needed for the line numbers themselves.
export const parseUnifiedDiff = (diffText) => {
  const map = new Map();
  let current = null;
  let inHeader = false;
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith('--- ')) continue;
    if (inHeader && line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? null : p.startsWith('b/') ? p.slice(2) : p;
      inHeader = false;
      continue;
    }
    const m = DIFF_HUNK_RE.exec(line);
    if (m) {
      inHeader = false;
      if (current == null) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) {
        const arr = map.get(current) ?? [];
        for (let i = 0; i < count; i += 1) arr.push(start + i);
        map.set(current, arr);
      }
    }
  }
  for (const [k, v] of map) map.set(k, [...new Set(v)].sort((a, b) => a - b));
  return map;
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

// parseProbeOutput({ stdout, code, fileArg }) → { resolvable, executed, baselineGreen }. A node:test
// run with a pattern that matches NOTHING emits only a file-wrapper result whose description is the
// file path itself (`ok N - <file>`); a real match emits the test NAME. So `resolvable` = at least one
// column-0 result whose description is not the file we passed; `baselineGreen` = resolvable AND the run
// was green (exit 0 and `# fail 0`). The wrapper is matched by BASENAME, not literally: node normalizes
// the echoed path ('./x' → 'x', or an absolute path), so a literal desc===fileArg compare would count
// the wrapper as a real match and falsely report resolvable/green (codex R1). A basename compare is
// invariant to ./ / abs / rel; a real test name colliding with the file's basename is absurd and would
// only fail CLOSED (mark unresolvable), never open.
export const parseProbeOutput = ({ stdout, code, fileArg }) => {
  let matched = 0;
  let failCount = null;
  const wanted = basename(String(fileArg).trim());
  for (const line of String(stdout).split('\n')) {
    const m = PROBE_RESULT_RE.exec(line);
    if (m && basename(m[1].trim()) !== wanted) matched += 1;
    const f = PROBE_FAIL_RE.exec(line.trim());
    if (f) failCount = Number(f[1]);
  }
  const resolvable = matched > 0;
  const fails = failCount ?? (code === 0 ? 0 : 1);
  return { resolvable, executed: matched, baselineGreen: resolvable && code === 0 && fails === 0 };
};

// defaultBoundArgv(file, pattern) → the shell-free node:test argv (testId content never reaches a shell).
export const defaultBoundArgv = (file, pattern) => ['node', '--test', '--test-reporter', 'tap', '--test-name-pattern', pattern, file];

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

// ── the changed surface (git-driven) ──────────────────────────────────────────────────────────────

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
// A changed assessable LEAF is assessed only if it is a REGULAR file. lstat (no-follow): a symlinked
// or non-regular *.mjs must NEVER be read/canonicalized — following it could read outside the work
// tree or HANG on a FIFO/device (codex R2). A non-regular leaf fails closed (routed to `unsupported`).
const isRegularLeaf = (abs) => {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
};

// computeChangedSurface(root) → { assessable: Map<rel, number[]>, unsupported: [rel], outOfDomain: [rel] }.
// Domain = the review-payload domain (tracked working-vs-HEAD changes + untracked-not-ignored files),
// classified by the CLOSED rule. Tracked changed lines come from `git diff HEAD -U0`; an untracked file
// is wholly new, so all its lines are "changed".
export const computeChangedSurface = (root) => {
  const trackedDiff = gitStdout(['diff', 'HEAD', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames'], root)
    ?? gitStdout(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames'], root) // no HEAD yet (unborn branch)
    ?? '';
  const trackedLines = parseUnifiedDiff(trackedDiff);
  const untrackedZ = gitStdout(['ls-files', '--others', '--exclude-standard', '-z'], root) ?? '';
  const untracked = untrackedZ.split('\0').filter(Boolean);

  const assessable = new Map();
  const unsupported = [];
  const outOfDomain = [];
  const place = (rel, cls, lines) => {
    if (cls === 'excluded-test') return;
    if (cls === 'assessable') {
      if (isRegularLeaf(join(root, rel))) assessable.set(rel, lines);
      else unsupported.push(rel); // a symlinked / non-regular source → fail closed, never followed
      return;
    }
    if (cls === 'unsupported') unsupported.push(rel);
    else outOfDomain.push(rel);
  };
  for (const [rel, lines] of trackedLines) place(rel, classifyChangedPath(rel), lines);
  for (const rel of untracked) {
    const cls = classifyChangedPath(rel);
    if (cls !== 'assessable') {
      place(rel, cls, []);
      continue;
    }
    // Guard the leaf BEFORE reading — never follow a symlink to count an untracked file's lines.
    const abs = join(root, rel);
    if (!isRegularLeaf(abs)) {
      unsupported.push(rel);
      continue;
    }
    const src = readFileSafe(abs);
    const count = src == null || src.length === 0 ? 0 : src.split('\n').length;
    assessable.set(rel, Array.from({ length: count }, (_, i) => i + 1));
  }
  return { assessable, unsupported: unsupported.sort(), outOfDomain: outOfDomain.sort() };
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

const budgetsFromEnv = (env) => ({
  mutantsMax: Number.parseInt(env.AW_FOLD_MUTANTS_MAX ?? '200', 10) || 200,
  hunkMutantsMax: Number.parseInt(env.AW_FOLD_HUNK_MUTANTS_MAX ?? '25', 10) || 25,
  timeBudgetS: Number.parseInt(env.AW_FOLD_TIME_BUDGET_S ?? '600', 10) || 600,
});

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

  // Decision 3 / 10: probe each fixable-bug bound testId once (shell-free).
  const ledgerPath = resolveLedgerPath(cwd, env);
  const { records: reviewRecords } = ledgerPath ? readLedger(ledgerPath) : { records: [] };
  const boundTestIds = collectBoundTestIds(reviewRecords, { activity: ACTIVITY, loop });
  const testIds = boundTestIds.map((id) => {
    const at = id.indexOf('#');
    const file = id.slice(0, at);
    const pattern = id.slice(at + 1);
    const argv = boundArgv(file, pattern);
    const res = spawnSync(argv[0], argv.slice(1), { cwd: rootTop, env: childTestEnv(env), encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
    return { id, ...parseProbeOutput({ stdout: res.stdout ?? '', code: res.error ? 1 : res.status ?? 1, fileArg: file }) };
  });

  const record = {
    schema: RESULT_SCHEMA_VERSION,
    loop,
    fingerprint,
    boundTestIds,
    testIds,
    unsupported,
    outOfDomain,
    coverage: { uncoveredChanged },
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

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `fold-completeness-run — the M3 fold-completeness RUNNER (agent-workflow family, AD-046).

Usage:
  node fold-completeness-run.mjs [--suite "<cmd>"] [--cwd <dir>]

Runs the in-flight plan-execution loop's suite ONCE under coverage, maps every changed executable line
to covered/uncovered, probes each fixable-bug bound testId for resolvability + a green baseline, and
appends one result record to <git dir>/${'agent-workflow-fold-completeness.jsonl'} (AW_FOLD_RESULTS
overrides). The read-only gate is a SEPARATE tool: node fold-completeness.mjs --check / --status / --json.

Suite command: --suite "<cmd>" or AW_FOLD_SUITE_CMD, else the unit-tests gate cmd in docs/ai/gates.json.
Bound-test runs default to node --test --test-name-pattern (shell-free); AW_FOLD_BOUND_CMD overrides
with a JSON argv array using {file}/{pattern}. Budgets: AW_FOLD_MUTANTS_MAX / AW_FOLD_HUNK_MUTANTS_MAX /
AW_FOLD_TIME_BUDGET_S (recorded but inert — the mutation half is not shipped).

Exit codes: 0 written; 1 a typed STOP (loop derivation / suite discovery / malformed record / fs error);
2 usage.`;

const parseArgs = (argv) => {
  const opts = { cwd: undefined, suite: undefined };
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
    const { writtenPath, record } = runFoldCompleteness({ cwd: opts.cwd ?? cwd0, env, suiteCmd: opts.suite });
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
