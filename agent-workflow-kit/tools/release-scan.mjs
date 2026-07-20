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

export const scanPaths = (paths, opts = {}) => {
  const report = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const file of walk(resolve(p))) {
      const findings = scanText(readFileSync(file, 'utf8'), opts);
      for (const f of findings) report.push({ file, ...f });
    }
  }
  return report;
};

export const main = (argv) => {
  const reportOnly = argv.includes('--report');
  const paths = argv.filter((a) => a !== '--report');
  if (paths.length === 0) {
    console.error('usage: release-scan.mjs [--report] <path>...');
    process.exit(2);
  }
  const report = scanPaths(paths);
  for (const r of report) console.log(`[${r.kind}] ${r.file}:${r.line} — ${r.detail}`);
  if (report.length === 0) {
    console.log('[release-scan] clean — no AI attribution or reviewer-round identity found.');
    return;
  }
  console.log(`\n[release-scan] ${report.length} finding(s).`);
  if (!reportOnly) process.exit(1);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));
