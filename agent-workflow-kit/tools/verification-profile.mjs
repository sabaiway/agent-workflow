#!/usr/bin/env node
// verification-profile.mjs — read-only schema/read core for the per-project VERIFICATION PROFILE
// (docs/ai/verification-profile.json), the language-independence contract (BUGFREE-3, AD-049).
// Companion read-core to the fold-completeness runner. NO writer — the runner is the sole
// tree-toucher. An ABSENT profile reproduces today's exact behaviour (V8 coverage + node:test
// TAP-on-stdout); the profile only generalizes the coverage SOURCE, the single-test RESULT FORMAT,
// and an optional SARIF path — coverage/probe INPUTS, never the suite command.
//
// The suite COMMAND is deliberately NOT a profile field: it stays the docs/ai/gates.json unit-tests
// cmd so the fold run and the unit-tests gate share command-identity (the (a) suite-evidence credit
// requires the SAME command).
//
// Path safety (Decision 4; grounding.mjs assertScratchDestination model): every profile-declared
// artifact path MUST be gitignored or outside the work tree, checked on the REALPATH (a symlink leaf
// is refused). An in-tree, not-ignored file the suite writes would move the review fingerprint the
// run binds to; a symlinked path could route the write onto a tracked file. validateProfile fails
// CLOSED on any such path.
//
// Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from './orchestration-config.mjs';

// cwd-relative so error prefixes show a path the user can open, never an absolute temp/host path.
export const PROFILE_REL = 'docs/ai/verification-profile.json';
export const PROFILE_SCHEMA_VERSION = 1;

export const COVERAGE_KINDS = new Set(['v8', 'lcov']);
export const RESULT_FORMATS = new Set(['tap-stdout', 'tap-file', 'junit-xml']);
// File-based formats must be TOLD where to write, so their argv carries {resultPath} (the runner
// substitutes a fresh out-of-tree path per probe and reads THAT back). tap-stdout reads stdout.
export const FILE_BASED_FORMATS = new Set(['tap-file', 'junit-xml']);
export const RESULT_PATH_TOKEN = '{resultPath}';
export const FILE_TOKEN = '{file}';
export const PATTERN_TOKEN = '{pattern}';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isNonEmptyStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

// Unknown-key-fails-closed. Returns a reason string or null.
const unknownKeyReason = (obj, allowed, where) => {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return `${where}: unknown key "${k}" (allowed: ${[...allowed].join(', ')})`;
  }
  return null;
};

const COVERAGE_KEYS = new Set(['kind', 'lcovPath']);
const SINGLE_TEST_KEYS = new Set(['argv', 'resultFormat']);
const FINDINGS_KEYS = new Set(['sarifPath']);
const TOP_KEYS = new Set(['_README', 'schema', 'coverage', 'singleTest', 'findings']);

const defaultGitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.error || r.status == null ? null : { status: r.status, stdout: r.stdout ?? '' };
};

// Reason string when the declared path is unsafe, else null. Unsafe = a symlink leaf, or an
// in-work-tree path that is NOT gitignored (writing there moves the review fingerprint; a tracked
// path reads as not-ignored too). Checked on the REAL destination (parent realpath-resolved) so a
// symlinked parent cannot route an "outside/ignored" path back onto a tracked file. Outside any git
// tree → safe. deps.{gitLine,lstat,realpath} are injectable for hermetic tests.
export const declaredPathUnsafeReason = (label, p, cwd, deps = {}) => {
  const gitLine = deps.gitLine ?? defaultGitLine;
  const lstat = deps.lstat ?? lstatSync;
  const realpath = deps.realpath ?? realpathSync;
  if (!isNonEmptyString(p)) return `${label} must be a non-empty string`;
  const lexical = isAbsolute(p) ? p : resolve(cwd, p);
  let leaf = null;
  try {
    leaf = lstat(lexical);
  } catch {
    leaf = null; // absent → a fresh file; the parent is realpath-checked below
  }
  if (leaf && leaf.isSymbolicLink()) {
    return `${label} "${p}" is a symlink — refused (the write would follow it onto another file; name the real path)`;
  }
  let realParent;
  try {
    realParent = realpath(dirname(lexical));
  } catch {
    return `${label} "${p}" parent directory does not exist — create the (gitignored) output dir first, or fix the path`;
  }
  const full = join(realParent, basename(lexical));
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null || top.status !== 0) return null; // not a git work tree → not fingerprint-relevant
  // Realpath the repo root too so both sides of relative() are physical — a checkout opened via a
  // symlink must not misclassify an in-tree path as OUTSIDE. Fail CLOSED if it can't resolve.
  let root;
  try {
    root = realpath(top.stdout.replace(/\r?\n$/, ''));
  } catch {
    return `${label} "${p}" — cannot resolve the repo root's real path (fail closed)`;
  }
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // outside the work tree → safe
  const ignored = gitLine(['check-ignore', '-q', '--', rel], root);
  if (ignored == null || ignored.status !== 0) {
    return `${label} "${p}" is an in-tree path that is not gitignored — the suite writing there would move the review fingerprint the run binds to; gitignore it (or place it outside the repo)`;
  }
  return null;
};

// validateProfile(obj, { cwd, gitLine, lstat, realpath }?) → { ok, reason }. Strict schema first;
// then, ONLY when `cwd` is supplied, the declared-path safety check (Decision 4). A pure-schema unit
// test omits `cwd`; loadProfile passes it so malformed OR unsafe both fail closed.
export const validateProfile = (obj, ctx = {}) => {
  if (!isPlainObject(obj)) return { ok: false, reason: `${PROFILE_REL}: must be a JSON object` };
  const topUnknown = unknownKeyReason(obj, TOP_KEYS, PROFILE_REL);
  if (topUnknown) return { ok: false, reason: topUnknown };
  if (obj.schema !== PROFILE_SCHEMA_VERSION) return { ok: false, reason: `${PROFILE_REL}: schema must be ${PROFILE_SCHEMA_VERSION}` };
  if (obj._README !== undefined && typeof obj._README !== 'string') return { ok: false, reason: `${PROFILE_REL}: "_README" must be a string` };

  // coverage (optional; absent → V8). lcovPath REQUIRED iff lcov, forbidden otherwise.
  if (obj.coverage !== undefined) {
    if (!isPlainObject(obj.coverage)) return { ok: false, reason: `${PROFILE_REL}: coverage must be an object` };
    const ck = unknownKeyReason(obj.coverage, COVERAGE_KEYS, `${PROFILE_REL}: coverage`);
    if (ck) return { ok: false, reason: ck };
    if (!COVERAGE_KINDS.has(obj.coverage.kind)) return { ok: false, reason: `${PROFILE_REL}: coverage.kind must be one of ${[...COVERAGE_KINDS].join(', ')}` };
    if (obj.coverage.kind === 'lcov') {
      if (!isNonEmptyString(obj.coverage.lcovPath)) return { ok: false, reason: `${PROFILE_REL}: coverage.lcovPath (a non-empty path) is required when coverage.kind is "lcov"` };
    } else if (obj.coverage.lcovPath !== undefined) {
      return { ok: false, reason: `${PROFILE_REL}: coverage.lcovPath is only valid when coverage.kind is "lcov"` };
    }
  }

  // singleTest (optional; absent → default node:test argv + tap-stdout). argv must carry {file} +
  // {pattern}; a file-based resultFormat additionally requires {resultPath}.
  if (obj.singleTest !== undefined) {
    if (!isPlainObject(obj.singleTest)) return { ok: false, reason: `${PROFILE_REL}: singleTest must be an object` };
    const sk = unknownKeyReason(obj.singleTest, SINGLE_TEST_KEYS, `${PROFILE_REL}: singleTest`);
    if (sk) return { ok: false, reason: sk };
    if (!isNonEmptyStringArray(obj.singleTest.argv)) return { ok: false, reason: `${PROFILE_REL}: singleTest.argv must be a non-empty array of strings` };
    const argvJoined = obj.singleTest.argv.join(' ');
    if (!argvJoined.includes(FILE_TOKEN)) return { ok: false, reason: `${PROFILE_REL}: singleTest.argv must carry a ${FILE_TOKEN} placeholder (the runner substitutes the test file)` };
    if (!argvJoined.includes(PATTERN_TOKEN)) return { ok: false, reason: `${PROFILE_REL}: singleTest.argv must carry a ${PATTERN_TOKEN} placeholder (the runner substitutes the test-name pattern)` };
    const rf = obj.singleTest.resultFormat;
    if (rf !== undefined && !RESULT_FORMATS.has(rf)) return { ok: false, reason: `${PROFILE_REL}: singleTest.resultFormat must be one of ${[...RESULT_FORMATS].join(', ')}` };
    if (FILE_BASED_FORMATS.has(rf) && !argvJoined.includes(RESULT_PATH_TOKEN)) {
      return { ok: false, reason: `${PROFILE_REL}: singleTest.resultFormat "${rf}" is file-based — singleTest.argv must carry a ${RESULT_PATH_TOKEN} placeholder (the runner substitutes a fresh out-of-tree result path per probe)` };
    }
  }

  // findings (optional; an empty object is valid — no SARIF path declared).
  if (obj.findings !== undefined) {
    if (!isPlainObject(obj.findings)) return { ok: false, reason: `${PROFILE_REL}: findings must be an object` };
    const fk = unknownKeyReason(obj.findings, FINDINGS_KEYS, `${PROFILE_REL}: findings`);
    if (fk) return { ok: false, reason: fk };
    if (obj.findings.sarifPath !== undefined && !isNonEmptyString(obj.findings.sarifPath)) {
      return { ok: false, reason: `${PROFILE_REL}: findings.sarifPath must be a non-empty string when present` };
    }
  }

  // Declared-path safety — only when a cwd is supplied (Decision 4).
  if (ctx.cwd != null) {
    const deps = { gitLine: ctx.gitLine, lstat: ctx.lstat, realpath: ctx.realpath };
    if (obj.coverage?.kind === 'lcov') {
      const r = declaredPathUnsafeReason('coverage.lcovPath', obj.coverage.lcovPath, ctx.cwd, deps);
      if (r) return { ok: false, reason: `${PROFILE_REL}: ${r}` };
    }
    if (obj.findings?.sarifPath !== undefined) {
      const r = declaredPathUnsafeReason('findings.sarifPath', obj.findings.sarifPath, ctx.cwd, deps);
      if (r) return { ok: false, reason: `${PROFILE_REL}: ${r}` };
    }
  }
  return { ok: true };
};

// resolvers — env WINS over the profile (ad-hoc override precedence, Decision 3)

export const resolveCoverage = (profile) => {
  const kind = profile?.coverage?.kind ?? 'v8';
  return { kind, lcovPath: kind === 'lcov' ? profile.coverage.lcovPath : null };
};

// argv precedence: AW_FOLD_BOUND_CMD (applied in the runner's resolveBoundArgv, keeping the
// malformed-override refusal one home) > profile.singleTest.argv > built-in default. This resolver
// returns the PROFILE view only: argv = the profile template or null → runner default.
export const resolveSingleTest = (profile) => ({
  argv: profile?.singleTest?.argv ?? null,
  resultFormat: profile?.singleTest?.resultFormat ?? 'tap-stdout',
});

export const resolveSarifPath = (profile) => profile?.findings?.sarifPath ?? null;

// IO — config errors → loud fail(1); an absent FILE → defaults path, NOT an error

// loadProfile(cwd, deps?) → { profile, source }. Absent FILE → { profile: null, source: 'none' }.
// A directory / dangling symlink / permission error is PRESENT-but-unreadable → loud fail(1), never
// silently treated as absent. Malformed JSON, schema-invalid, or an unsafe declared path → fail(1).
export const loadProfile = (cwd, deps = {}) => {
  const readFile = deps.readFile ?? readFileSync;
  const lstat = deps.lstat ?? lstatSync;
  const full = join(cwd, PROFILE_REL);
  try {
    lstat(full);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { profile: null, source: 'none' };
    throw fail(1, `${PROFILE_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let raw;
  try {
    raw = readFile(full, 'utf8');
  } catch (err) {
    throw fail(1, `${PROFILE_REL}: unreadable (${(err && err.code) || (err && err.message) || err})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(1, `${PROFILE_REL}: malformed JSON (${err.message})`);
  }
  const v = validateProfile(parsed, { cwd, gitLine: deps.gitLine, lstat: deps.lstat, realpath: deps.realpath });
  if (!v.ok) throw fail(1, v.reason);
  return { profile: parsed, source: PROFILE_REL };
};
