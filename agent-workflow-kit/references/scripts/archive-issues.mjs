#!/usr/bin/env node
// Rotate FIXED issues from docs/ai/known_issues.md → docs/ai/history/issues-resolved.md.
//
// Rule: an issue is archivable when
//   - its heading is wrapped in ~~strikethrough~~  AND
//   - its body contains `**Status:** ✅ FIXED (YYYY.MM.DD)` with a date older than CUTOFF_DAYS.
// Issues marked FIXED without an explicit date are left untouched (conservative — agent
// can re-evaluate and archive manually).
//
// Modes:
//   (default)   append matching issues to history/issues-resolved.md, remove from known_issues.md
//   --dry-run   print plan, no file changes
//   --check     exit 1 if known_issues.md still has archivable issues
//
// CLI:
//   --cutoff-days=N (default 14)
//   --today=YYYY-MM-DD (default UTC today)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const readProjectName = () => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch {
    /* no package.json — fall back to repo dir basename */
  }
  return basename(ROOT);
};
const PROJECT_NAME = readProjectName();

const KNOWN_ISSUES_PATH = resolve(ROOT, 'docs/ai/known_issues.md');
const HISTORY_DIR = resolve(ROOT, 'docs/ai/history');
const RESOLVED_PATH = resolve(HISTORY_DIR, 'issues-resolved.md');

const DEFAULT_CUTOFF_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ISSUE_HEADING_RE = /^### (.+?)$/;
const STRIKETHROUGH_RE = /^~~(.+)~~$/;
const FIXED_WITH_DATE_RE = /\*\*Status:\*\*\s*✅\s*FIXED\s*\((\d{4})\.(\d{2})\.(\d{2})\)/;

const parseArgs = (argv) => {
  const flags = { dryRun: false, check: false };
  const opts = { cutoffDays: DEFAULT_CUTOFF_DAYS, today: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--check') flags.check = true;
    else if (arg.startsWith('--cutoff-days=')) opts.cutoffDays = Number(arg.slice('--cutoff-days='.length));
    else if (arg.startsWith('--today=')) opts.today = arg.slice('--today='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: archive-issues.mjs [--dry-run|--check] [--cutoff-days=N] [--today=YYYY-MM-DD]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { flags, opts };
};

export const parseKnownIssues = (text) => {
  const fmMatch = text.match(/^(---\n[\s\S]*?\n---\n)/);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const body = text.slice(frontmatter.length);
  const lines = body.split('\n');

  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    if (/^### /.test(line)) {
      if (current.heading !== null || current.lines.length > 0) sections.push(current);
      current = { heading: line, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading !== null || current.lines.length > 0) sections.push(current);
  return { frontmatter, sections };
};

export const classifySection = (section, cutoffDate) => {
  if (section.heading === null) return { kind: 'preamble' };
  const headingMatch = ISSUE_HEADING_RE.exec(section.heading);
  if (!headingMatch) return { kind: 'other' };
  const title = headingMatch[1];
  const stricken = STRIKETHROUGH_RE.exec(title);
  if (!stricken) return { kind: 'open' };

  const blockText = section.lines.join('\n');
  const dateMatch = FIXED_WITH_DATE_RE.exec(blockText);
  if (!dateMatch) return { kind: 'fixed-undated' };

  const fixedDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`);
  return fixedDate < cutoffDate ? { kind: 'archivable', fixedDate } : { kind: 'fixed-recent', fixedDate };
};

export const buildResolvedFile = (existing, newSections, todayStr) => {
  const header = existing
    ? existing
    : `---\ntype: history\nlastUpdated: ${todayStr}\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: 3500\n---\n\n# Resolved Issues — ${PROJECT_NAME}\n\n> Append-only archive of issues closed > 14 days ago. Sourced from \`../known_issues.md\`.\n\n---\n`;
  const newBlocks = newSections.map((s) => s.lines.join('\n').replace(/\n+$/, '')).join('\n\n---\n\n');
  if (!newBlocks) return header;
  return `${header}\n${newBlocks}\n`;
};

const main = async () => {
  const { flags, opts } = parseArgs(process.argv);
  const today = opts.today
    ? new Date(`${opts.today}T00:00:00Z`)
    : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const cutoffDate = new Date(today.getTime() - (opts.cutoffDays - 1) * MS_PER_DAY);
  const todayStr = today.toISOString().slice(0, 10);

  const text = await readFile(KNOWN_ISSUES_PATH, 'utf8');
  const { frontmatter, sections } = parseKnownIssues(text);

  const classified = sections.map((s) => ({ section: s, ...classifySection(s, cutoffDate) }));
  const archivable = classified.filter((c) => c.kind === 'archivable');

  if (flags.check) {
    if (archivable.length > 0) {
      console.error(`[archive-issues] FAIL: ${archivable.length} archivable issues found in known_issues.md.`);
      for (const c of archivable) console.error(`  - ${c.section.heading.trim()}`);
      console.error('Run the issues archive script (without --check) to rotate.');
      process.exit(1);
    }
    console.log('[archive-issues] OK — no FIXED issues older than 14 days in known_issues.md.');
    process.exit(0);
  }

  if (flags.dryRun) {
    console.log('[archive-issues] DRY-RUN — no files will be changed.');
    console.log(`  cutoffDate: ${cutoffDate.toISOString().slice(0, 10)}`);
    console.log(`  total sections: ${sections.length}`);
    console.log(`  archivable: ${archivable.length}`);
    for (const c of archivable) console.log(`    - ${c.section.heading.trim()}`);
    return;
  }

  if (archivable.length === 0) {
    console.log('[archive-issues] nothing to archive.');
    return;
  }

  await mkdir(HISTORY_DIR, { recursive: true });
  const existing = existsSync(RESOLVED_PATH) ? await readFile(RESOLVED_PATH, 'utf8') : '';
  const updatedResolved = buildResolvedFile(existing, archivable.map((c) => c.section), todayStr);
  await writeFile(RESOLVED_PATH, updatedResolved, 'utf8');

  const keptSections = classified.filter((c) => c.kind !== 'archivable').map((c) => c.section);
  // Rebuild known_issues.md
  const rebuilt = [
    frontmatter.trim(),
    '',
    ...keptSections.map((s) => s.lines.join('\n').replace(/\n+$/, '')),
    '',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
  await writeFile(KNOWN_ISSUES_PATH, rebuilt, 'utf8');

  console.log(`[archive-issues] archived ${archivable.length} issue(s) to ${relative(ROOT, RESOLVED_PATH)}`);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
