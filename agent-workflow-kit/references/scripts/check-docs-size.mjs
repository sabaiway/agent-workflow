#!/usr/bin/env node
// Cap-validator for docs/ai/**/*.md.
//
// Reads YAML frontmatter from each file and verifies:
//   - line count ≤ maxLines                                  (blocking error)
//   - lastUpdated within staleAfter window (e.g. 7d, 30d)    (non-blocking warning)
//
// Modes:
//   (default)        run validation, print report, exit 1 if any error
//   --report          run validation, print full table, do not exit non-zero
//   --write-index     run validation AND regenerate docs/ai/index.md from frontmatter
//   --check-index     verify docs/ai/index.md is in sync with source frontmatter;
//                     exit 1 (and print how to fix) if stale. Catches the silent
//                     drift `--write-index` is supposed to prevent.
//
// CLI overrides:
//   --today=YYYY-MM-DD (default today UTC) — useful for tests / reproducible runs
//   --quiet            print only failures (and final summary)

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, relative, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DOCS_DIR = resolve(ROOT, 'docs/ai');
const INDEX_PATH = resolve(DOCS_DIR, 'index.md');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Project-name + footer links for the index are auto-discovered (no hardcoding):
//   project name  ← package.json "name" (fallback: repo dir basename)
//   hierarchical  ← every AGENTS.md / CLAUDE.md below the repo root
//   on-demand     ← .agents/skills/*-{patterns,commands}/SKILL.md
const DEFAULT_PROJECT_NAME = 'this project';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-ssr', 'coverage', 'build', '.next']);

const walkForName = async (dir, name, acc = [], depth = 0) => {
  if (depth > 6) return acc;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkForName(join(dir, entry.name), name, acc, depth + 1);
    } else if (entry.isFile() && entry.name === name) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
};

export const discoverMeta = async () => {
  let projectName = basename(ROOT);
  try {
    const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
    if (pkg.name) projectName = pkg.name;
  } catch {
    /* no package.json — keep dir basename */
  }
  const agentsFiles = await walkForName(ROOT, 'AGENTS.md');
  const claudeFiles = await walkForName(ROOT, 'CLAUDE.md');
  const rootAgents = resolve(ROOT, 'AGENTS.md');
  const rootClaude = resolve(ROOT, 'CLAUDE.md');
  // A subdir typically holds AGENTS.md plus a CLAUDE.md symlink to it — list each
  // dir once (prefer AGENTS.md, drop its sibling CLAUDE.md alias).
  const agentsDirs = new Set(agentsFiles.map((file) => dirname(resolve(file))));
  const nestedFiles = [
    ...agentsFiles.filter((file) => resolve(file) !== rootAgents),
    ...claudeFiles.filter(
      (file) => resolve(file) !== rootClaude && !agentsDirs.has(dirname(resolve(file))),
    ),
  ];
  const hierarchicalLinks = nestedFiles
    .map((file) => relative(ROOT, file))
    .sort()
    .map((rel) => `[\`${rel}\`](../../${rel})`);
  let onDemandLinks = [];
  try {
    const skillDirs = await readdir(resolve(ROOT, '.agents/skills'), { withFileTypes: true });
    onDemandLinks = skillDirs
      .filter((dirent) => dirent.isDirectory() && /-(patterns|commands)$/.test(dirent.name))
      .map((dirent) => dirent.name)
      .sort()
      .map((name) => `[\`${name}\`](../../.agents/skills/${name}/SKILL.md)`);
  } catch {
    /* no .agents/skills — omit the section */
  }
  return { projectName, hierarchicalLinks, onDemandLinks };
};

const parseArgs = (argv) => {
  const flags = { report: false, writeIndex: false, checkIndex: false, quiet: false };
  const opts = { today: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--report') flags.report = true;
    else if (arg === '--write-index') flags.writeIndex = true;
    else if (arg === '--check-index') flags.checkIndex = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg.startsWith('--today=')) opts.today = arg.slice('--today='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: check-docs-size.mjs [--report|--write-index|--check-index] [--today=YYYY-MM-DD] [--quiet]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { flags, opts };
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export const parseFrontmatter = (text) => {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return null;
  const body = match[1];
  const fields = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = m[2].trim();
  }
  return fields;
};

export const parseStaleAfter = (value) => {
  if (!value || value === 'never') return null;
  const m = value.match(/^(\d+)d$/);
  if (!m) return null;
  return Number(m[1]);
};

const walkMarkdownFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
};

export const computeToday = (todayStr) =>
  todayStr
    ? new Date(`${todayStr}T00:00:00Z`)
    : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

export const inspectFile = async (filePath, today) => {
  const text = await readFile(filePath, 'utf8');
  const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const fm = parseFrontmatter(text);
  const rel = relative(ROOT, filePath);

  if (!fm) {
    return {
      path: rel,
      lineCount,
      frontmatter: null,
      errors: [`missing YAML frontmatter`],
      warnings: [],
    };
  }

  const errors = [];
  const warnings = [];

  const maxLines = fm.maxLines ? Number(fm.maxLines) : null;
  if (maxLines === null || Number.isNaN(maxLines)) {
    errors.push(`frontmatter missing maxLines`);
  } else if (lineCount > maxLines) {
    errors.push(`${lineCount} lines > maxLines ${maxLines}`);
  }

  const staleDays = parseStaleAfter(fm.staleAfter);
  if (staleDays !== null && fm.lastUpdated) {
    const updated = new Date(`${fm.lastUpdated}T00:00:00Z`);
    if (!Number.isNaN(updated.getTime())) {
      const ageDays = Math.floor((today.getTime() - updated.getTime()) / MS_PER_DAY);
      if (ageDays > staleDays) {
        warnings.push(`lastUpdated ${fm.lastUpdated} is ${ageDays}d old (staleAfter ${staleDays}d)`);
      }
    }
  }

  return { path: rel, lineCount, frontmatter: fm, errors, warnings };
};

const formatRow = (row) => {
  const sizeCell = row.frontmatter?.maxLines
    ? `${row.lineCount}/${row.frontmatter.maxLines}`
    : `${row.lineCount}/?`;
  const status = row.errors.length > 0 ? 'X' : row.warnings.length > 0 ? '!' : 'OK';
  return { status, sizeCell, ...row };
};

const printReport = (rows, quiet) => {
  const widths = {
    status: 2,
    path: Math.max(4, ...rows.map((r) => r.path.length)),
    size: Math.max(9, ...rows.map((r) => r.sizeCell.length)),
    type: Math.max(4, ...rows.map((r) => (r.frontmatter?.type ?? '').length)),
    updated: 12,
  };
  const printable = quiet ? rows.filter((r) => r.errors.length || r.warnings.length) : rows;
  if (printable.length > 0) {
    console.log(
      `${'S'.padEnd(widths.status)}  ${'PATH'.padEnd(widths.path)}  ${'SIZE/MAX'.padEnd(widths.size)}  ${'TYPE'.padEnd(widths.type)}  ${'UPDATED'.padEnd(widths.updated)}`,
    );
    for (const row of printable) {
      console.log(
        `${row.status.padEnd(widths.status)}  ${row.path.padEnd(widths.path)}  ${row.sizeCell.padEnd(widths.size)}  ${(row.frontmatter?.type ?? '').padEnd(widths.type)}  ${(row.frontmatter?.lastUpdated ?? '').padEnd(widths.updated)}`,
      );
      for (const err of row.errors) console.log(`     - ERROR  ${err}`);
      for (const warn of row.warnings) console.log(`     - WARN   ${warn}`);
    }
  }
};

const INDEX_HEADER = `---
type: reference
lastUpdated: __TODAY__
scope: permanent
staleAfter: 30d
owner: none
maxLines: 80
---

# Memory Map — __PROJECT__ \`docs/ai/\`

> **Auto-generated** — edit the source files' frontmatter, not this file. Regenerate after changes.
> Layered context architecture:
> **Always-loaded** — root \`AGENTS.md\` + this index.
> **On-demand** — read a specific \`docs/ai/\` file when its "Read When" applies.
> **Hierarchical** — subdirectory \`AGENTS.md\` files load when working in that folder.
> **Archive** — \`history/recent.md\` (WARM) + \`history/condensed-index.md\` + per-month files.

## Files

`;

const formatIndexRow = (row) => {
  const fm = row.frontmatter ?? {};
  const name = row.path.replace(/^docs\/ai\//, '');
  const link = `[\`${name}\`](./${name})`;
  return `| ${link} | ${fm.type ?? '—'} | ${row.lineCount}/${fm.maxLines ?? '—'} | ${fm.lastUpdated ?? '—'} | ${fm.staleAfter ?? '—'} |`;
};

// Pure index renderer — given inspected rows + the date to stamp in the header,
// returns the exact bytes `docs/ai/index.md` should contain. Shared by
// `--write-index` (writes it) and `--check-index` (diffs against on-disk).
export const buildIndex = (rows, todayStr, meta = {}) => {
  const projectName = meta.projectName ?? DEFAULT_PROJECT_NAME;
  const onDemandLinks = meta.onDemandLinks ?? [];
  const hierarchicalLinks = meta.hierarchicalLinks ?? [];
  const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path));
  const header = INDEX_HEADER.replace('__TODAY__', todayStr).replace('__PROJECT__', projectName);
  const tableHeader = `| File | Type | Lines/Max | Updated | Stale after |\n|------|------|-----------|---------|-------------|`;
  const tableRows = sorted
    .filter((r) => r.path !== 'docs/ai/index.md')
    .map(formatIndexRow)
    .join('\n');
  const onDemandSection =
    onDemandLinks.length > 0
      ? `\n\n## Skills (on-demand)\n\n${onDemandLinks.map((link) => `- ${link}`).join('\n')}`
      : '';
  const hierarchicalSection =
    hierarchicalLinks.length > 0
      ? `\n\n## Subdirectory \`AGENTS.md\` (hierarchical)\n\n${hierarchicalLinks.map((link) => `- ${link}`).join('\n')}`
      : '';
  return `${header}${tableHeader}\n${tableRows}${onDemandSection}${hierarchicalSection}\n`;
};

// Decides whether an on-disk index is in sync with the source frontmatter.
// The index is regenerated in memory using the on-disk index's OWN `lastUpdated`
// for the header, so a mere day-rollover (no content change) is NOT flagged —
// only genuine drift in the file table (added/removed files, changed
// type/cap/lastUpdated/staleAfter, or a changed line count) makes it stale.
export const checkIndexFreshness = (rows, onDiskText, meta = {}) => {
  if (onDiskText === null || onDiskText === undefined || onDiskText === '') {
    return { fresh: false, expected: buildIndex(rows, 'unknown', meta) };
  }
  const fm = parseFrontmatter(onDiskText);
  const headerDate = fm?.lastUpdated ?? 'unknown';
  const expected = buildIndex(rows, headerDate, meta);
  return { fresh: expected === onDiskText, expected };
};

const writeIndex = async (rows, today, meta) => {
  const body = buildIndex(rows, today.toISOString().slice(0, 10), meta);
  await writeFile(INDEX_PATH, body, 'utf8');
};

const main = async () => {
  const { flags, opts } = parseArgs(process.argv);
  const today = computeToday(opts.today);
  const files = (await walkMarkdownFiles(DOCS_DIR)).sort();
  const inspected = await Promise.all(files.map((f) => inspectFile(f, today)));
  const rows = inspected.map(formatRow);

  const meta = flags.writeIndex || flags.checkIndex ? await discoverMeta() : null;

  if (flags.writeIndex) {
    await writeIndex(rows, today, meta);
    console.log(`Wrote ${relative(ROOT, INDEX_PATH)}`);
    const after = await stat(INDEX_PATH);
    if (after.size === 0) {
      console.error('index.md was written empty');
      process.exit(2);
    }
  }

  if (flags.checkIndex) {
    const onDisk = existsSync(INDEX_PATH) ? await readFile(INDEX_PATH, 'utf8') : null;
    const { fresh } = checkIndexFreshness(rows, onDisk, meta);
    if (!fresh) {
      console.error(
        `[check-docs-size] FAIL: ${relative(ROOT, INDEX_PATH)} is stale (out of sync with source frontmatter). Regenerate the index (--write-index) and commit the regenerated file.`,
      );
      process.exit(1);
    }
    console.log(
      `[check-docs-size] OK — ${relative(ROOT, INDEX_PATH)} is in sync with source frontmatter.`,
    );
    return;
  }

  printReport(rows, flags.quiet);
  const errorCount = rows.reduce((n, r) => n + r.errors.length, 0);
  const warnCount = rows.reduce((n, r) => n + r.warnings.length, 0);
  console.log(
    `\n${rows.length} files inspected  —  ${errorCount} error(s), ${warnCount} warning(s)`,
  );

  if (errorCount > 0 && !flags.report) process.exit(1);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
