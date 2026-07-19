#!/usr/bin/env node
// changed-surface.mjs — the NEUTRAL shared read-only core: ONE home for the changed-surface
// computation the coverage checker consumes (the closed classification + new-side line numbering),
// plus the shared fail-closed knob parser and the strict N/N probe-verdict algebra the
// core-evidence red-proof observer reads.
//
// Import-graph invariant (pinned by import-split tests): this module imports NOTHING from the
// family — node built-ins only. Everyone may import it; it imports no one.
//
// Read-only: never writes, never commits. It DOES spawn read-only `git` queries (diff/ls-files/
// rev-parse). Dependency-free. No side effects on import.

import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_MAX_BUFFER = 256 * 1024 * 1024; // a full-tree diff can be large; never truncate

// ── the CLOSED changed-path classification rule (AD-046 Decision 5; no heuristics) ───────────────

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

// ── diff-header path unquoting (git C-quotes paths carrying quotes/control/non-ASCII bytes) ──────

// Strip the quotes and decode escapes BYTE-wise (octal escapes are UTF-8 bytes) — an unparsed
// quoted path compares unequal to its classifier/testId form and would silently escape the
// coverage/cap surface (AD-047).
const CQUOTE_SIMPLE = { n: 10, t: 9, r: 13, f: 12, v: 11, b: 8, a: 7, '"': 34, '\\': 92 };
export const unquoteDiffPath = (p) => {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const inner = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c !== '\\') {
      // Consume a full CODE POINT — 16-bit-unit iteration would split a surrogate pair (an
      // unescaped non-BMP char, reachable under core.quotepath=false) into replacement bytes.
      const ch = String.fromCodePoint(inner.codePointAt(i));
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      i += ch.length - 1;
      continue;
    }
    const rest = inner.slice(i + 1);
    const oct = /^[0-7]{1,3}/.exec(rest);
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8) & 0xff);
      i += oct[0].length;
    } else if (rest[0] in CQUOTE_SIMPLE) {
      bytes.push(CQUOTE_SIMPLE[rest[0]]);
      i += 1;
    } else if (rest[0] !== undefined) {
      for (const b of Buffer.from(rest[0], 'utf8')) bytes.push(b);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
};

// ── unified-diff → new-side changed line numbers (line numbers only; content lines ignored) ──────

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
      const p = unquoteDiffPath(line.slice(4).replace(/[\t\r]+$/, '')); // TAB/CR are git artifacts, never filename bytes
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

// ── the changed surface (git-driven; the ONE computation both consumers read) ─────────────────────

// The one diff-invocation shape every surface pass uses. The a/ b/ prefixes are pinned EXPLICITLY
// A user's global diff.noprefix=true would otherwise drop them and the parsers would eat
// a real directory named "a" — user git config must never bend the parse.
export const DIFF_FLAGS = ['--unified=0', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];

const runGit = (args, cwd) => spawnSync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', windowsHide: true });
const gitStdout = (args, cwd) => {
  const r = runGit(args, cwd);
  return r.error || r.status > 1 ? null : r.stdout;
};
// Both leaf guards are exported for the unit tests of exactly their fail-closed edges (the
// hashFileBytes precedent, AD-047) — internal consumers stay this module's own passes.
export const readFileSafe = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
// A changed LEAF is read only if it is a REGULAR file. lstat (no-follow): a symlinked or non-regular
// leaf must NEVER be read/followed — following it could read outside the work tree or HANG on a
// FIFO/device (AD-046). A non-regular leaf fails closed (routed to `unsupported`).
export const isRegularLeaf = (abs) => {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
};

// computeChangedSurface(root) → { assessable: Map<rel, number[]>, unsupported: [rel],
// outOfDomain: [rel], unsupportedLines: Map<rel, number[]> }.
// Domain = the review-payload domain (tracked working-vs-HEAD changes + untracked-not-ignored files),
// classified by the CLOSED rule. Tracked changed lines come from `git diff HEAD -U0` (new-side only —
// pure deletions cost nothing, subtractive folds stay free); an untracked file is wholly new, so all
// its lines are "changed". `unsupportedLines` is the D4 cap's view of the SAME pass: unsupported
// SOURCE files carry their new-side lines too (excluding them would gift a large-TS-fold bypass,
// BUGFREE-2 D4); an unreadable/non-regular leaf counts 0 lines but stays LISTED (the
// coverage gate still fails closed on it). excluded-test and out-of-domain never carry lines.
export const computeChangedSurface = (root) => {
  // Unborn branch (no HEAD yet): the plain diff alone misses files STAGED for the initial commit —
  // they sit in the index, so they are neither worktree-vs-index changes nor untracked. Merge the
  // --cached diff (index vs the empty tree) with the plain one; parseUnifiedDiff unions per-file
  // lines across concatenated diffs.
  const trackedDiff = gitStdout(['diff', 'HEAD', ...DIFF_FLAGS], root)
    ?? `${gitStdout(['diff', '--cached', ...DIFF_FLAGS], root) ?? ''}\n${gitStdout(['diff', ...DIFF_FLAGS], root) ?? ''}`;
  const trackedLines = parseUnifiedDiff(trackedDiff);
  const untrackedZ = gitStdout(['ls-files', '--others', '--exclude-standard', '-z'], root) ?? '';
  const untracked = untrackedZ.split('\0').filter(Boolean);

  const assessable = new Map();
  const unsupportedLines = new Map();
  const outOfDomain = [];
  const markUnsupported = (rel, lines) => {
    if (!unsupportedLines.has(rel)) unsupportedLines.set(rel, lines);
  };
  const place = (rel, cls, lines) => {
    if (cls === 'excluded-test') return;
    if (cls === 'assessable') {
      if (isRegularLeaf(join(root, rel))) assessable.set(rel, lines);
      else markUnsupported(rel, lines); // a symlinked / non-regular source → fail closed, never followed
      return;
    }
    if (cls === 'unsupported') markUnsupported(rel, lines);
    else outOfDomain.push(rel);
  };
  for (const [rel, lines] of trackedLines) place(rel, classifyChangedPath(rel), lines);
  for (const rel of untracked) {
    const cls = classifyChangedPath(rel);
    if (cls === 'excluded-test' || cls === 'out-of-domain') {
      place(rel, cls, []);
      continue;
    }
    // Guard the leaf BEFORE reading — never follow a symlink to count an untracked file's lines.
    const abs = join(root, rel);
    if (!isRegularLeaf(abs)) {
      markUnsupported(rel, []);
      continue;
    }
    const src = readFileSafe(abs);
    // Content lines only: a trailing newline terminates the last line, it does not open a phantom
    // empty one — the cap must count real lines (git's new-side numbering does the same).
    const parts = src == null ? [] : src.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    const all = Array.from({ length: parts.length }, (_, i) => i + 1);
    if (cls === 'assessable') assessable.set(rel, all);
    else markUnsupported(rel, all);
  }
  return { assessable, unsupported: [...unsupportedLines.keys()].sort(), outOfDomain: outOfDomain.sort(), unsupportedLines };
};

// ── the shared fail-closed positive-integer knob parser (AD-047 precedent) ───────────────────────

// Zero / negative / fractional / non-numeric values are refusals by name — the parseInt(...)||default
// idiom would silently accept bad truthy values (AD-046). Unset → the default; set → a
// positive integer, exactly. `makeError` lets each caller throw its OWN typed STOP.
export const parsePositiveIntKnob = (env, name, fallback, makeError = (m) => new Error(m)) => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw).trim()) || Number.parseInt(raw, 10) < 1) {
    throw makeError(`${name} must be a positive integer (got "${raw}") — refusing to guess (fail closed)`);
  }
  return Number.parseInt(raw, 10);
};

// ── the probe-verdict algebra (AD-047; the SINGLE home — the core-evidence red-proof observer
// consumes it) ────────────────────────────────────────────────────────────────────────────────────

// probeVerdict(entry) → 'green' | 'red' | 'quarantine' | 'unresolvable'. RED/GREEN are strict N/N
// verdicts; any timeout, mixed outcome, or partial resolution is QUARANTINE — it never converts and
// has no override lane (a flaky pin proves nothing — replace the test). Zero resolved runs (or a
// defensive runs=0) reads unresolvable.
export const probeVerdict = (t) => {
  const unresolved = t.runs - t.greens - t.reds - t.timeouts;
  if (unresolved >= t.runs) return 'unresolvable';
  if (t.timeouts > 0 || unresolved > 0 || (t.greens > 0 && t.reds > 0)) return 'quarantine';
  return t.greens === t.runs ? 'green' : 'red';
};
