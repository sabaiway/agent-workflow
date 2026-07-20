#!/usr/bin/env node
// Release-diff scanner — a CI/authoring gate that FAILS on AI/reviewer attribution that must never
// ship in a release:
//   - co-author trailers, "Generated with <AI>" footers, "Reviewed by <AI>" / authorship metadata.
//
// Mentioning a model as a *product* (codex, Gemini, GPT-OSS) is fine; only an *attribution*
// construction is flagged. An ALLOWLIST of legitimate component names keeps real product names from
// tripping the (narrow) attribution rules. Only the TEST is self-excluded (it holds attribution
// fixtures); the scanner source contains no attribution construction, so it is scanned normally.
//
// Pure `scanText` for unit fixtures; `scanPaths`/CLI for the release tree. Dependency-free, Node >= 22.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWLIST = [
  'codex-cli-bridge',
  'codex-exec',
  'codex-review',
  'antigravity-cli-bridge',
  'agy-run',
  'agy-review',
  'agent-workflow-kit',
  'agent-workflow-memory',
  'agent-workflow-engine',
];

// Narrow, high-signal attribution patterns. Mentioning a model as a *product* (codex, Gemini,
// GPT-OSS) is fine; these match only an *attribution* construction.
const ATTRIBUTION = [
  { re: /co-?authored-by:/i, label: 'co-author trailer' },
  { re: /🤖\s*generated with/i, label: 'AI "Generated with" footer' },
  { re: /generated with \[?(claude|codex|chatgpt|gpt|gemini|copilot|cursor)\b/i, label: 'AI "Generated with" footer' },
  { re: /reviewed by (claude|codex|chatgpt|gpt|gemini|copilot|cursor|the (ai|model|agent))/i, label: 'AI review attribution' },
  { re: /authored[- ]by[: ][^\n]{0,40}\b(claude|chatgpt|gemini|copilot)\b/i, label: 'AI authorship attribution' },
];
const REVIEWER_IDENTITY = [
  // backend-then-round: a bridge name, a separator, then r<N> (with optional +/round suffixes).
  { re: /\b(?:agy|codex)(?:\s+|-)r\d+(?:(?:\+|\/)r?\d+)*(?:-[a-z0-9]+)*\b/i, label: 'reviewer-round identity' },
  // round-then-backend (reverse order): r<N>, a separator, then a bridge name — the release-review gap.
  { re: /\br\d+(?:\s+|-)(?:agy|codex)\b/i, label: 'reviewer-round identity' },
];

const allowlistCovers = (matched, allowlist) =>
  allowlist.some((term) => matched.toLowerCase().includes(term.toLowerCase()));

// PURE: classify one text blob. Flags AI/reviewer attribution constructions.
export const scanText = (text, { allowlist = ALLOWLIST } = {}) => {
  const findings = [];
  text.split('\n').forEach((line, idx) => {
    for (const { re, label } of ATTRIBUTION) {
      const m = line.match(re);
      if (m && !allowlistCovers(m[0], allowlist)) {
        findings.push({ line: idx + 1, kind: 'attribution', detail: `${label}: "${m[0]}"` });
      }
    }
    for (const { re, label } of REVIEWER_IDENTITY) {
      const m = line.match(re);
      if (m) findings.push({ line: idx + 1, kind: 'reviewer-identity', detail: `${label}: "${m[0]}"` });
    }
  });
  return findings;
};

const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.sh', '.yml', '.yaml', '.txt', '']);
const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'plans', 'scan-fixtures']);
// Only the TEST is self-excluded — it necessarily contains attribution fixtures. The scanner source
// carries no attribution construction (its regex literals don't self-match), so it is scanned normally.
const EXCLUDE_FILE_NAMES = new Set(['release-scan.test.mjs']);

const walk = (path, acc = []) => {
  const st = statSync(path);
  if (st.isDirectory()) {
    if (EXCLUDE_DIR_NAMES.has(basename(path))) return acc;
    for (const entry of readdirSync(path)) walk(join(path, entry), acc);
  } else if (st.isFile()) {
    if (EXCLUDE_FILE_NAMES.has(basename(path))) return acc;
    if (TEXT_EXT.has(extname(path)) && !path.endsWith('.tgz')) acc.push(path);
  }
  return acc;
};

// Per-target outcomes. A caller-NAMED target that contributes no file must never fold into the
// clean verdict — an empty file list and a clean one print identically, so a mis-aimed scan would
// read as proof of cleanliness. `unmatchedGlob` is the one benign zero: the gate declaration lists
// shell globs, and bash passes an unmatched glob through literally, so a path that still carries a
// glob metacharacter is an optional target the shell found nothing for, not a mis-aim.
export const TARGET = Object.freeze({
  scanned: 'scanned',
  missing: 'missing',
  unmatchedGlob: 'unmatched-glob',
  excluded: 'excluded',
  empty: 'empty',
});

const GLOB_META_RE = /[*?[\]]/;

// PURE-ish (one fs read): classify ONE caller-named target and collect the files it contributes.
// Every zero-contribution status names its own cause, so the refusal can state the remedy rather
// than a bare count (a count without a location is the defect class this family bans).
export const classifyTarget = (path) => {
  if (!existsSync(path)) {
    return GLOB_META_RE.test(path)
      ? { path, status: TARGET.unmatchedGlob, files: [] }
      : { path, status: TARGET.missing, files: [] };
  }
  const st = statSync(path);
  const name = basename(path);
  if (st.isDirectory() && EXCLUDE_DIR_NAMES.has(name)) return { path, status: TARGET.excluded, files: [] };
  if (st.isFile() && (EXCLUDE_FILE_NAMES.has(name) || !TEXT_EXT.has(extname(path)) || path.endsWith('.tgz'))) {
    return { path, status: TARGET.excluded, files: [] };
  }
  const files = walk(path);
  return { path, status: files.length > 0 ? TARGET.scanned : TARGET.empty, files };
};

// Why each zero-contribution status refuses, and the one legal remedy for it.
const TARGET_REMEDY = Object.freeze({
  [TARGET.missing]: 'the path does not exist — fix the target, or drop it from the target list',
  [TARGET.excluded]: `the target itself is excluded (directory names: ${[...EXCLUDE_DIR_NAMES].join(', ')}; non-text or self-excluded files) — name the FILES to scan instead of the directory`,
  [TARGET.empty]: 'the target exists but holds no scannable text file — fix the target, or drop it from the target list',
});

const findingsIn = (targets, opts) => {
  const report = [];
  for (const target of targets) {
    for (const file of target.files) {
      for (const finding of scanText(readFileSync(file, 'utf8'), opts)) report.push({ file, ...finding });
    }
  }
  return report;
};

export const scanPaths = (paths, opts = {}) => findingsIn(paths.map((p) => classifyTarget(resolve(p))), opts);

export const main = (argv) => {
  const reportOnly = argv.includes('--report');
  const paths = argv.filter((a) => a !== '--report');
  if (paths.length === 0) {
    console.error('usage: release-scan.mjs [--report] <path>...');
    return 2;
  }
  const targets = paths.map((p) => classifyTarget(resolve(p)));
  for (const target of targets) {
    if (target.status === TARGET.unmatchedGlob) {
      console.log(`[release-scan] skipped ${target.path} — no file matched this glob (an optional target, stated not silent).`);
    }
  }
  const misaimed = targets.filter((target) => TARGET_REMEDY[target.status] !== undefined);
  for (const target of misaimed) {
    console.log(`[release-scan] target ${target.path} contributed NO file (${target.status}) — ${TARGET_REMEDY[target.status]}`);
  }
  const report = findingsIn(targets);
  for (const r of report) console.log(`[${r.kind}] ${r.file}:${r.line} — ${r.detail}`);
  if (misaimed.length > 0) {
    console.log(`\n[release-scan] ${misaimed.length} mis-aimed target(s) — this run proves nothing about them, so the clean verdict is refused.`);
  }
  if (report.length > 0) console.log(`\n[release-scan] ${report.length} finding(s).`);
  if (report.length === 0 && misaimed.length === 0) {
    console.log('[release-scan] clean — no AI attribution or reviewer-round identity found.');
    return 0;
  }
  return reportOnly ? 0 : 1;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = main(process.argv.slice(2));
