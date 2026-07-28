#!/usr/bin/env node
// Rotate FIXED issues from docs/ai/known_issues.md → docs/ai/history/issues-resolved.md.
//
// The file is read through the shared block tokenizer (markdown-blocks.mjs): section boundaries
// are column-0 level-3 heading TOKENS — a heading inside a fenced sample never starts a section,
// CRLF never changes a classification, and an unclosed fence is a loud error. An ISSUE-shaped
// heading anywhere else (wrong level, indented) refuses with file:line instead of being silently
// glued into the preceding section. A prose H3 still bounds a section but is never classified as
// an issue.
//
// Rule (Phase 2 state): an issue is archivable when
//   - its heading is wrapped in ~~strikethrough~~  AND
//   - its body contains `**Status:** ✅ FIXED (YYYY.MM.DD)` with a date older than CUTOFF_DAYS.
// The marker contract (the real-world resolution shapes) and the section model (category H2s,
// the file footer) are the next slice — until they land, unmatched markers stay untouched.
//
// Modes:
//   (default)   append matching issues to history/issues-resolved.md, remove from known_issues.md
//   --dry-run   print plan, no file changes
//   --check     exit 1 if known_issues.md still has archivable issues
//
// Every mode parses the file BEFORE any write, so a refusal fires identically for the default
// run, --dry-run and --check, and nothing is written on a refused input.
//
// CLI:
//   --cutoff-days=N (default 14)
//   --today=YYYY-MM-DD (default UTC today)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenizeMarkdown, fail } from './markdown-blocks.mjs';

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

const KNOWN_REL = 'docs/ai/known_issues.md';
const HISTORY_REL = 'docs/ai/history';
const RESOLVED_REL = 'docs/ai/history/issues-resolved.md';

const DEFAULT_CUTOFF_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ISSUE_HEADING_RE = /^### (.+?)$/;
const STRIKETHROUGH_RE = /^~~(.+)~~$/;
const FIXED_WITH_DATE_RE = /\*\*Status:\*\*\s*✅\s*FIXED\s*\((\d{4})\.(\d{2})\.(\d{2})\)/;
// The canonical issue-heading form, named in code: a column-0 level-3 heading whose title starts
// `Issue-NNN` (strikethrough optional). ISSUE-SHAPE is deliberately wider — the same prefix at any
// level or indent — so a mis-levelled or indented issue heading refuses loudly instead of being
// silently absorbed into the section above it.
const ISSUE_TITLE_RE = /^~{0,2}Issue-\d/;
const ISSUE_SHAPED_HEADING_RE = /^\s*#{1,6}[ \t]+~{0,2}Issue-\d/;
// The strict canonical placement: level 3, column 0, exactly one space. An issue-shaped heading
// that misses it by ANY whitespace (double space, a tab, an indent) refuses — `###  Issue-123`
// would otherwise slip past the level-3 boundary test and silently declassify to prose.
const ISSUE_CANONICAL_RE = /^### ~{0,2}Issue-\d/;
const SECTION_BOUNDARY_RE = /^### /;

const USAGE = 'Usage: archive-issues.mjs [--dry-run|--check] [--cutoff-days=N] [--today=YYYY-MM-DD]';

const parseArgs = (argv) => {
  const flags = { dryRun: false, check: false, help: false };
  const opts = { cutoffDays: DEFAULT_CUTOFF_DAYS, today: null };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('--cutoff-days=')) opts.cutoffDays = Number(arg.slice('--cutoff-days='.length));
    else if (arg.startsWith('--today=')) opts.today = arg.slice('--today='.length);
    else throw fail(2, `unknown argument: ${arg}\n${USAGE}`);
  }
  return { flags, opts };
};

// Parse → { frontmatter, sections }. A section's `heading` is the trailing-whitespace-free token
// text (so CRLF never leaks into classification); its `lines` stay byte-exact for re-emission.
export const parseKnownIssues = (text, label = KNOWN_REL) => {
  const { frontmatter, frontLines, lines, headings } = tokenizeMarkdown(text, label);

  const boundaryText = new Map();
  for (const heading of headings) {
    if (ISSUE_SHAPED_HEADING_RE.test(heading.text) && !ISSUE_CANONICAL_RE.test(heading.text)) {
      throw fail(
        1,
        `${label}:${frontLines + heading.index + 1}: "${heading.text}" is issue-shaped but not a ` +
          'canonical issue heading — expected `### Issue-NNN — title` (level 3, column 0, exactly ' +
          'one space, ~~strikethrough~~ optional). It would previously have been silently glued ' +
          'into the section above it or declassified to prose; fix the heading, then re-run.',
      );
    }
    if (SECTION_BOUNDARY_RE.test(heading.text)) boundaryText.set(heading.index, heading.text);
  }

  const sections = [];
  let current = { heading: null, lines: [] };
  const flush = () => {
    if (current.heading !== null || current.lines.length > 0) sections.push(current);
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (boundaryText.has(i)) {
      flush();
      current = { heading: boundaryText.get(i), lines: [lines[i]] };
    } else {
      current.lines.push(lines[i]);
    }
  }
  flush();
  return { frontmatter, sections };
};

export const classifySection = (section, cutoffDate) => {
  if (section.heading === null) return { kind: 'preamble' };
  const headingMatch = ISSUE_HEADING_RE.exec(section.heading);
  if (!headingMatch) return { kind: 'other' };
  const title = headingMatch[1];
  // A prose H3 bounds a section but is never an ISSUE — it can neither archive nor rot silently.
  if (!ISSUE_TITLE_RE.test(title)) return { kind: 'other' };
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

export const runCli = (argv, deps = {}) => {
  const { root = ROOT, log = console.log, logError = console.error } = deps;
  try {
    const { flags, opts } = parseArgs(argv);
    if (flags.help) {
      log(USAGE);
      return 0;
    }
    const today = opts.today
      ? new Date(`${opts.today}T00:00:00Z`)
      : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const cutoffDate = new Date(today.getTime() - (opts.cutoffDays - 1) * MS_PER_DAY);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    const knownIssuesPath = resolve(root, KNOWN_REL);
    const historyDir = resolve(root, HISTORY_REL);
    const resolvedPath = resolve(root, RESOLVED_REL);

    if (!existsSync(knownIssuesPath)) {
      logError(`[archive-issues] ${KNOWN_REL} not found — nothing to do.`);
      return 1;
    }

    const { frontmatter, sections } = parseKnownIssues(readFileSync(knownIssuesPath, 'utf8'), KNOWN_REL);
    const classified = sections.map((s) => ({ section: s, ...classifySection(s, cutoffDate) }));
    const archivable = classified.filter((c) => c.kind === 'archivable');
    const counts = {};
    for (const c of classified) {
      if (c.kind === 'preamble') continue;
      counts[c.kind] = (counts[c.kind] ?? 0) + 1;
    }
    const issueSectionCount = classified.filter((c) => c.kind !== 'preamble').length;
    const countLine = Object.entries(counts)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(' / ');

    if (flags.check) {
      if (archivable.length > 0) {
        logError(`[archive-issues] FAIL: ${archivable.length} archivable issues found in ${KNOWN_REL}.`);
        for (const c of archivable) logError(`  - ${c.section.heading.trim()}`);
        logError('Run the issues archive script (without --check) to rotate.');
        return 1;
      }
      // The verdict names what it acted on — with the loud path in the parser, a low section
      // count can only mean the sections are genuinely absent, never a file that failed to parse.
      log(
        `[archive-issues] OK — ${KNOWN_REL}: ${issueSectionCount} issue sections (${countLine || 'none'}), ` +
          `0 archivable with a recognised date older than ${cutoffStr} (cutoff ${opts.cutoffDays} days, relative to ${todayStr}).`,
      );
      return 0;
    }

    if (flags.dryRun) {
      log('[archive-issues] DRY-RUN — no files will be changed.');
      log(`  cutoffDate: ${cutoffStr}`);
      log(`  total sections: ${sections.length}`);
      log(`  issue sections: ${issueSectionCount}${countLine ? ` (${countLine})` : ''}`);
      log(`  archivable: ${archivable.length}`);
      for (const c of archivable) log(`    - ${c.section.heading.trim()}`);
      return 0;
    }

    if (archivable.length === 0) {
      log(`[archive-issues] nothing to archive — ${issueSectionCount} issue sections (${countLine || 'none'}).`);
      return 0;
    }

    mkdirSync(historyDir, { recursive: true });
    const existing = existsSync(resolvedPath) ? readFileSync(resolvedPath, 'utf8') : '';
    const updatedResolved = buildResolvedFile(existing, archivable.map((c) => c.section), todayStr);
    writeFileSync(resolvedPath, updatedResolved, 'utf8');

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
    writeFileSync(knownIssuesPath, rebuilt, 'utf8');

    log(`[archive-issues] archived ${archivable.length} issue(s) to ${RESOLVED_REL}`);
    return 0;
  } catch (err) {
    logError(`[archive-issues] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
