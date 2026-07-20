#!/usr/bin/env node
// suite-parity.mjs — the D12 survivor-corpus freeze + parity checker (repo-only tooling, never
// shipped in any tarball). The speedup phase must keep the surviving suite's OBSERVABLE test
// surface byte-stable while the harness gets cheaper, so the exit bar is mechanical, never a
// hand-kept note:
//
//   • test points (name + nesting + suite-flag) per file — IDENTICAL on surviving files;
//   • zero NEW skip/todo anywhere (surviving or new files);
//   • per-file assert-call-site counts — PRESERVED on surviving files (the deterministic form
//     of "same assertions"; names alone would let assertions be silently dropped);
//   • a run with any failing point is refused as a parity source (never freeze/compare red);
//   • NEW files (refusal fixtures, entry-point specs) are counted separately, never a failure —
//     but a DELETED file always is.
//
//   node --test --test-reporter=./scripts/suite-parity-reporter.mjs \
//     --test-reporter-destination=<run.ndjson> <the gates.json unit-tests file matrix>
//   node scripts/suite-parity.mjs snapshot --run <run.ndjson> --out <baseline.json>
//   node scripts/suite-parity.mjs check    --run <run.ndjson> --baseline <baseline.json>
//
// Problems are reported by LOCATION (file + the exact point names that drifted), never as bare
// counts. Dependency-free, Node >= 22. No side effects on import.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

// git exports its own repository pointers into every hook and child environment (GIT_DIR,
// GIT_INDEX_FILE, GIT_WORK_TREE, …). A child `git` that inherits them resolves to the AMBIENT
// repository and silently ignores the cwd it was handed — so this tool, run from inside a git hook,
// would read another repository's bytes and report them as this one's. Strip them; let cwd decide.
export const GIT_LOCATION_ENV = Object.freeze([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
]);

export const cwdBoundGitEnv = (env = process.env) => {
  const clean = { ...env };
  for (const name of GIT_LOCATION_ENV) delete clean[name];
  return clean;
};

export const SCHEMA = 1;

// One deterministic rule, applied identically at freeze and at check (assert-family + the
// expect-family shims some suites use).
export const ASSERT_CALL_SITE_RE = /\b(?:assert(?:\.\w+)?|expect)\s*\(/g;

// A code/literal mask over the source (R2): 1 = a character that participates in code structure,
// 0 = inside a string / template text / regex body / comment. Balancing parens over the mask keeps
// an escaped `\(`, a lone paren in a string, or a commented paren from skewing an expression's
// span. Regex-vs-division is decided by the preceding significant character (operand → division);
// a closing literal acts as an operand sentinel. Deterministic; good-enough JS, not a full parser.
// Keywords after which a `/` opens a REGEX even though the previous significant character is a
// word character (`return /x/` is a regex, `total / 2` is division) — the R3 token-context arm.
const REGEX_ALLOWING_KEYWORDS = new Set([
  'return', 'throw', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void',
  'yield', 'await', 'do', 'else',
]);

const scanCodeMask = (text) => {
  const mask = new Uint8Array(text.length);
  const stack = [{ mode: 'code', brace: 0, fromTemplate: false }];
  let prevSig = '';
  let wordBuf = '';
  let wordIsProperty = false;
  for (let i = 0; i < text.length; i += 1) {
    const top = stack[stack.length - 1];
    const ch = text[i];
    const next = text[i + 1];
    if (top.mode === 'code') {
      if (ch === '/' && next === '/') { stack.push({ mode: 'lineC' }); continue; }
      if (ch === '/' && next === '*') { stack.push({ mode: 'blockC' }); continue; }
      if (ch === "'") { mask[i] = 1; stack.push({ mode: 'sq' }); continue; }
      if (ch === '"') { mask[i] = 1; stack.push({ mode: 'dq' }); continue; }
      if (ch === '`') { mask[i] = 1; stack.push({ mode: 'tpl' }); continue; }
      if (ch === '/' && (prevSig === '' || '([{,;=:!&|?+-*%<>~^'.includes(prevSig) || (REGEX_ALLOWING_KEYWORDS.has(wordBuf) && !wordIsProperty))) {
        mask[i] = 1;
        stack.push({ mode: 'regex' });
        continue;
      }
      mask[i] = 1;
      if (top.fromTemplate) {
        if (ch === '{') top.brace += 1;
        else if (ch === '}') {
          if (top.brace === 0) { stack.pop(); continue; }
          top.brace -= 1;
        }
      }
      if (/[A-Za-z0-9_$]/.test(ch)) {
        if (/[A-Za-z0-9_$]/.test(text[i - 1] ?? '')) wordBuf += ch;
        else {
          wordBuf = ch;
          // `obj.return` is a PROPERTY, not the keyword — a keyword-regex context needs a word
          // that does not follow a property accessor (R4).
          wordIsProperty = prevSig === '.';
        }
      } else if (!/\s/.test(ch)) wordBuf = '';
      if (!/\s/.test(ch)) prevSig = ch;
    } else if (top.mode === 'sq' || top.mode === 'dq') {
      if (ch === '\\') { i += 1; continue; }
      if ((top.mode === 'sq' && ch === "'") || (top.mode === 'dq' && ch === '"') || ch === '\n') {
        if (ch !== '\n') mask[i] = 1;
        stack.pop();
        prevSig = ')';
      }
    } else if (top.mode === 'tpl') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '`') { mask[i] = 1; stack.pop(); prevSig = ')'; continue; }
      if (ch === '$' && next === '{') {
        mask[i] = 1;
        mask[i + 1] = 1;
        i += 1;
        stack.push({ mode: 'code', brace: 0, fromTemplate: true });
        prevSig = '{';
      }
    } else if (top.mode === 'regex') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '[') { stack.push({ mode: 'regexClass' }); continue; }
      if (ch === '/') { mask[i] = 1; stack.pop(); prevSig = ')'; }
    } else if (top.mode === 'regexClass') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === ']') stack.pop();
    } else if (top.mode === 'lineC') {
      if (ch === '\n') stack.pop();
    } else if (top.mode === 'blockC') {
      if (ch === '*' && next === '/') { stack.pop(); i += 1; }
    }
  }
  return mask;
};

// Whole assertion EXPRESSIONS (R1 M2 + the R2 lexer arms): each call-site head whose text sits in
// CODE (a head quoted inside a fixture string never counts), balanced over the mask through the
// arguments plus chained calls (`expect(x).toBe(y)`), whitespace-normalized. Nested heads are
// counted as their own expressions — a gutted inner check cannot hide inside an outer span.
export const extractAssertionExpressions = (text) => {
  const mask = scanCodeMask(text);
  const isCode = (from, to) => {
    for (let k = from; k < to; k += 1) if (!mask[k]) return false;
    return true;
  };
  const balanceFrom = (start) => {
    let i = start;
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (mask[i]) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') depth -= 1;
      }
      i += 1;
    }
    return i;
  };
  // Whitespace collapses in CODE only; literal interiors keep their bytes — an in-string
  // `'a  b'` → `'a b'` edit must move the expression, and so the hash (R4).
  const normalizeSpan = (start, end) => {
    let out = '';
    let pendingSpace = false;
    for (let k = start; k < end; k += 1) {
      if (mask[k] && /\s/.test(text[k])) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      out += text[k];
    }
    return out.trim();
  };
  const out = [];
  const headRe = new RegExp(ASSERT_CALL_SITE_RE.source, 'g');
  let match;
  while ((match = headRe.exec(text)) !== null) {
    const headEnd = match.index + match[0].length;
    if (!isCode(match.index, headEnd)) continue;
    let i = balanceFrom(headEnd);
    for (;;) {
      // A chain step is a run of property accessors ending in a call — `.toBe(`, `.not.toMatch(`,
      // `.resolves.toEqual(` — so a modifier can never cut the matcher out of the expression (R3).
      const chain = text.slice(i).match(/^\s*(?:\.\w+)+\s*\(/);
      if (!chain || !isCode(i, i + chain[0].length)) break;
      i = balanceFrom(i + chain[0].length);
    }
    out.push(normalizeSpan(match.index, i));
    headRe.lastIndex = headEnd;
  }
  return out;
};

export const countAssertCallSites = (text) => extractAssertionExpressions(text).length;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const encodePoint = (p) => `${p.nesting}|${p.suite ? 'suite' : 'test'}|${p.name}`;

// NDJSON reporter lines → { files: { <repo-rel>: { points[], skip[], todo[], cases, suites } } }.
// Refuses a red run and an unattributed point loudly — never a silent partial corpus.
export const parseRun = (ndjsonText, { root }) => {
  const files = new Map();
  const failures = [];
  const unattributed = [];
  const rawCounts = new Map();
  const tailCounts = new Map();
  let tailHeaderSeen = false;
  for (const line of ndjsonText.split('\n')) {
    if (line.trim() === '') continue;
    if (line.startsWith('#')) {
      // The reporter's end-of-stream table doubles as the completion attestation (F4).
      if (line.startsWith('# per-file wall totals')) tailHeaderSeen = true;
      const tail = line.match(/^# file-ms \S+ points (\d+) (.+)$/);
      if (tail) tailCounts.set(tail[2], Number(tail[1]));
      continue;
    }
    let point;
    try {
      point = JSON.parse(line);
    } catch {
      throw fail(1, `run file carries a non-JSON line: ${line.slice(0, 120)}`);
    }
    if (point.file == null) {
      unattributed.push(point.name);
      continue;
    }
    rawCounts.set(point.file, (rawCounts.get(point.file) ?? 0) + 1);
    const rel = isAbsolute(point.file) ? relative(root, point.file) : point.file;
    if (!files.has(rel)) files.set(rel, { points: [], skip: [], todo: [] });
    const entry = files.get(rel);
    const encoded = encodePoint(point);
    entry.points.push(encoded);
    if (point.skip) entry.skip.push(encoded);
    if (point.todo) entry.todo.push(encoded);
    if (point.fail) failures.push(`${rel}: ${point.name}`);
  }
  if (failures.length > 0) {
    throw fail(1, `run is not green — refusing it as a parity source:\n  ${failures.join('\n  ')}`);
  }
  if (unattributed.length > 0) {
    throw fail(1, `run carries ${unattributed.length} point(s) without a file attribution (first: "${unattributed[0]}") — cannot build a per-file corpus`);
  }
  if (files.size === 0) throw fail(1, 'run carries no test points — wrong file or an empty run');
  // Completion-tail attestation (F4): the table is emitted only after the event stream drains,
  // so a truncated/killed run cannot carry one that agrees with the parsed points.
  if (!tailHeaderSeen) {
    throw fail(1, 'run carries no completion tail — a truncated/killed run is never a parity source');
  }
  for (const [raw, n] of rawCounts) {
    if (tailCounts.get(raw) !== n) {
      throw fail(1, `completion tail disagrees for ${raw}: parsed ${n} point(s), tail says ${tailCounts.get(raw) ?? 'nothing'} — truncated run refused`);
    }
  }
  for (const raw of tailCounts.keys()) {
    if (!rawCounts.has(raw)) {
      throw fail(1, `completion tail names ${raw} with no parsed points — truncated run refused`);
    }
  }
  const out = {};
  for (const rel of [...files.keys()].sort()) {
    const entry = files.get(rel);
    entry.points.sort();
    entry.skip.sort();
    entry.todo.sort();
    const suites = entry.points.filter((p) => p.split('|')[1] === 'suite').length;
    out[rel] = {
      points: entry.points,
      skip: entry.skip,
      todo: entry.todo,
      cases: entry.points.length - suites,
      suites,
    };
  }
  return out;
};

// Static assert-call-site counts for every corpus file, via the injected reader (hermetic tests
// never touch the tree). A corpus file that cannot be read is a loud STOP.
export const withAssertCounts = (files, { readTestFile }) => {
  const out = {};
  for (const rel of Object.keys(files)) {
    let text;
    try {
      text = readTestFile(rel);
    } catch (err) {
      throw fail(1, `cannot read corpus file ${rel} for assert-site counting: ${err.message}`);
    }
    const expressions = extractAssertionExpressions(text);
    out[rel] = {
      ...files[rel],
      assertCallSites: expressions.length,
      assertExpressionsHash: sha256(expressions.join('\n')),
    };
  }
  return out;
};

export const buildCorpus = (ndjsonText, { root, readTestFile }) =>
  ({ schema: SCHEMA, files: withAssertCounts(parseRun(ndjsonText, { root }), { readTestFile }) });

const diffLists = (before, after) => {
  const counts = new Map();
  for (const item of before) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of after) counts.set(item, (counts.get(item) ?? 0) - 1);
  const removed = [];
  const added = [];
  for (const [item, n] of counts) {
    for (let i = 0; i < n; i += 1) removed.push(item);
    for (let i = 0; i < -n; i += 1) added.push(item);
  }
  return { removed: removed.sort(), added: added.sort() };
};

// The comparator (pure). Surviving files: points + assert-site counts strictly identical, and
// the assertion-EXPRESSION hash identical (gutting a check at an unchanged count is drift) —
// unless the file is in acceptedRewrites, the reviewed-rewrites input that exempts the hash
// dimension ONLY (points and counts always bind). Everywhere (surviving AND new): no skip/todo
// point the baseline did not carry.
export const compareCorpus = (baseline, current, { acceptedRewrites = [] } = {}) => {
  const accepted = new Set(acceptedRewrites);
  const problems = [];
  const newFiles = [];
  const acceptedReport = [];
  for (const rel of Object.keys(baseline.files)) {
    const was = baseline.files[rel];
    const now = current.files[rel];
    if (!now) {
      problems.push({ file: rel, kind: 'missing-file', detail: 'present in the baseline, absent from the run' });
      continue;
    }
    const { removed, added } = diffLists(was.points, now.points);
    if (removed.length > 0 || added.length > 0) {
      const lines = [
        ...removed.map((p) => `lost:  ${p}`),
        ...added.map((p) => `new:   ${p}`),
      ];
      problems.push({ file: rel, kind: 'points-drift', detail: lines.join('\n') });
    }
    if (was.assertCallSites !== now.assertCallSites) {
      problems.push({
        file: rel,
        kind: 'assert-drift',
        detail: `assert call sites ${was.assertCallSites} → ${now.assertCallSites} (surviving files keep their assertions byte-for-count)`,
      });
    } else if (
      was.assertExpressionsHash && now.assertExpressionsHash &&
      was.assertExpressionsHash !== now.assertExpressionsHash
    ) {
      if (accepted.has(rel)) acceptedReport.push(rel);
      else {
        problems.push({
          file: rel,
          kind: 'assert-drift',
          detail: 'assertion expressions changed at an unchanged count (a rewritten/gutted check) — pass --accept-rewrites for a REVIEWED rewrite',
        });
      }
    }
  }
  for (const rel of Object.keys(current.files)) {
    const was = baseline.files[rel];
    const now = current.files[rel];
    if (!was) newFiles.push(rel);
    const priorSkip = new Set(was ? was.skip : []);
    const priorTodo = new Set(was ? was.todo : []);
    const newSkip = now.skip.filter((p) => !priorSkip.has(p));
    const newTodo = now.todo.filter((p) => !priorTodo.has(p));
    if (newSkip.length > 0) {
      problems.push({ file: rel, kind: 'new-skip', detail: newSkip.map((p) => `skip:  ${p}`).join('\n') });
    }
    if (newTodo.length > 0) {
      problems.push({ file: rel, kind: 'new-todo', detail: newTodo.map((p) => `todo:  ${p}`).join('\n') });
    }
  }
  return { ok: problems.length === 0, problems, newFiles: newFiles.sort(), acceptedRewrites: acceptedReport.sort() };
};

const corpusTotals = (corpus) => {
  const files = Object.values(corpus.files);
  const sum = (pick) => files.reduce((n, f) => n + pick(f), 0);
  return {
    files: files.length,
    points: sum((f) => f.points.length),
    cases: sum((f) => f.cases),
    skip: sum((f) => f.skip.length),
    todo: sum((f) => f.todo.length),
    assertCallSites: sum((f) => f.assertCallSites),
  };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: suite-parity.mjs snapshot --run <run.ndjson> --out <baseline.json> [--root <dir>] [--git-rev <rev>]\n' +
  '       suite-parity.mjs check    --run <run.ndjson> --baseline <baseline.json> [--root <dir>] [--accept-rewrites <rel,rel,…>]';

const parseArgs = (argv) => {
  const [verb, ...rest] = argv;
  if (verb !== 'snapshot' && verb !== 'check') throw fail(2, `unknown verb "${verb ?? ''}"\n${USAGE}`);
  const opts = { verb, run: null, out: null, baseline: null, root: null, gitRev: null, acceptRewrites: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      i += 1;
      if (rest[i] === undefined) throw fail(2, `${arg} requires a value\n${USAGE}`);
      return rest[i];
    };
    if (arg === '--run') opts.run = value();
    else if (arg === '--out') opts.out = value();
    else if (arg === '--baseline') opts.baseline = value();
    else if (arg === '--root') opts.root = value();
    else if (arg === '--git-rev') opts.gitRev = value();
    else if (arg === '--accept-rewrites') opts.acceptRewrites = value().split(',').map((s) => s.trim()).filter(Boolean);
    else throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
  }
  if (!opts.run) throw fail(2, `--run is required\n${USAGE}`);
  if (opts.verb === 'snapshot' && !opts.out) throw fail(2, `snapshot requires --out\n${USAGE}`);
  if (opts.verb === 'check' && !opts.baseline) throw fail(2, `check requires --baseline\n${USAGE}`);
  // The check always measures the CURRENT tree; a rev-read only makes sense when freezing.
  if (opts.verb === 'check' && opts.gitRev) throw fail(2, `--git-rev is snapshot-only\n${USAGE}`);
  // The reviewed-rewrites exemption is a CHECK-time input; a freeze must never carry one.
  if (opts.verb === 'snapshot' && opts.acceptRewrites.length > 0) throw fail(2, `--accept-rewrites is check-only\n${USAGE}`);
  return opts;
};

export const runCli = (argv, deps = {}) => {
  const {
    log = console.log,
    logError = console.error,
    root: defaultRoot = process.cwd(),
    readFile = (path) => readFileSync(path, 'utf8'),
    writeFile = (path, text) => writeFileSync(path, text, 'utf8'),
  } = deps;
  try {
    const opts = parseArgs(argv);
    const root = resolve(opts.root ?? defaultRoot);
    // A freeze taken AFTER edits have landed must still count the PRE-state assert sites, or the
    // "assertions preserved" dimension compares post to post and proves nothing — --git-rev reads
    // every corpus file's bytes at that revision instead of the worktree.
    const readTestFile = opts.gitRev
      ? (rel) => execFileSync('git', ['show', `${opts.gitRev}:${rel}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: cwdBoundGitEnv() })
      : (rel) => readFile(resolve(root, rel));
    const corpus = buildCorpus(readFile(resolve(root, opts.run)), { root, readTestFile });
    const totals = corpusTotals(corpus);
    if (opts.verb === 'snapshot') {
      writeFile(resolve(root, opts.out), `${JSON.stringify(corpus, null, 2)}\n`);
      log(`[suite-parity] snapshot: ${totals.files} files, ${totals.cases} cases (${totals.points} points), ${totals.assertCallSites} assert sites, skip ${totals.skip} / todo ${totals.todo} → ${opts.out}`);
      return 0;
    }
    let baseline;
    try {
      baseline = JSON.parse(readFile(resolve(root, opts.baseline)));
    } catch (err) {
      throw fail(1, `cannot read baseline ${opts.baseline}: ${err.message}`);
    }
    if (baseline?.schema !== SCHEMA || typeof baseline?.files !== 'object' || baseline.files === null) {
      throw fail(1, `baseline ${opts.baseline} is not a schema-${SCHEMA} suite-parity snapshot`);
    }
    const { ok, problems, newFiles, acceptedRewrites } = compareCorpus(baseline, corpus, { acceptedRewrites: opts.acceptRewrites });
    for (const rel of newFiles) {
      log(`[suite-parity] new file (counted separately): ${rel} — ${corpus.files[rel].cases} cases, ${corpus.files[rel].assertCallSites} assert sites`);
    }
    for (const rel of acceptedRewrites) {
      log(`[suite-parity] accepted rewrite (reviewed): ${rel} — expression hash exempted; points + counts still bind`);
    }
    if (ok) {
      log(`[suite-parity] PASS — survivor corpus identical: ${Object.keys(baseline.files).length} baseline files, ${totals.cases} current cases, ${newFiles.length} new file(s) counted separately.`);
      return 0;
    }
    logError(`[suite-parity] FAIL — ${problems.length} problem(s):`);
    for (const problem of problems) {
      logError(`  ${problem.file} [${problem.kind}]`);
      for (const line of problem.detail.split('\n')) logError(`    ${line}`);
    }
    return 1;
  } catch (err) {
    logError(`[suite-parity] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
