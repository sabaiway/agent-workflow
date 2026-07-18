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
//   --root=<dir>       run against another project root (default this deployment) — the ADR-rotation
//                      hook passes it so a rotation regenerates the right project's index
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

// Root-parameterized (BUGFREE-3 / AD-049, item (h)): the module ROOT constants are the CLI DEFAULT
// (this deployment's own root); `--root=<dir>` and the exported `regenerateIndex(root, today)`
// override them so the ADR-rotation hook (archive-decisions.mjs) and hermetic tests can regenerate
// an arbitrary root's index without ever touching the real repo tree.
const pathsFor = (root) => ({ root, docsDir: resolve(root, 'docs/ai'), indexPath: resolve(root, 'docs/ai/index.md') });

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

export const discoverMeta = async (root = ROOT) => {
  let projectName = basename(root);
  try {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    if (pkg.name) projectName = pkg.name;
  } catch {
    /* no package.json — keep dir basename */
  }
  const agentsFiles = await walkForName(root, 'AGENTS.md');
  const claudeFiles = await walkForName(root, 'CLAUDE.md');
  const rootAgents = resolve(root, 'AGENTS.md');
  const rootClaude = resolve(root, 'CLAUDE.md');
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
    .map((file) => relative(root, file))
    .sort()
    .map((rel) => `[\`${rel}\`](../../${rel})`);
  let onDemandLinks = [];
  try {
    const skillDirs = await readdir(resolve(root, '.agents/skills'), { withFileTypes: true });
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

// Pure argv parser (no I/O, no exit): `help` / `error` ride out as data for runCli to render.
const parseArgs = (argv) => {
  const flags = { report: false, writeIndex: false, checkIndex: false, quiet: false };
  const opts = { today: null, root: null };
  for (const arg of argv) {
    if (arg === '--report') flags.report = true;
    else if (arg === '--write-index') flags.writeIndex = true;
    else if (arg === '--check-index') flags.checkIndex = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg.startsWith('--today=')) opts.today = arg.slice('--today='.length);
    else if (arg.startsWith('--root=')) opts.root = arg.slice('--root='.length);
    else if (arg === '--help' || arg === '-h') return { flags, opts, help: true };
    else return { flags, opts, error: `Unknown argument: ${arg}` };
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

// Discover the docs to validate: ONLY `*.md` files (recursively). Non-`.md` files — e.g. a hand-edited
// `docs/ai/orchestration.json` config — are inherently skipped, so they are never subject to the
// frontmatter / maxLines caps. Exported so that skip is pinned by a regression test.
export const walkMarkdownFiles = async (dir) => {
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

export const inspectFile = async (filePath, today, root = ROOT) => {
  const text = await readFile(filePath, 'utf8');
  const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const fm = parseFrontmatter(text);
  const rel = relative(root, filePath);

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

const printReport = (rows, quiet, log = console.log) => {
  const widths = {
    status: 2,
    path: Math.max(4, ...rows.map((r) => r.path.length)),
    size: Math.max(9, ...rows.map((r) => r.sizeCell.length)),
    type: Math.max(4, ...rows.map((r) => (r.frontmatter?.type ?? '').length)),
    updated: 12,
  };
  const printable = quiet ? rows.filter((r) => r.errors.length || r.warnings.length) : rows;
  if (printable.length > 0) {
    log(
      `${'S'.padEnd(widths.status)}  ${'PATH'.padEnd(widths.path)}  ${'SIZE/MAX'.padEnd(widths.size)}  ${'TYPE'.padEnd(widths.type)}  ${'UPDATED'.padEnd(widths.updated)}`,
    );
    for (const row of printable) {
      log(
        `${row.status.padEnd(widths.status)}  ${row.path.padEnd(widths.path)}  ${row.sizeCell.padEnd(widths.size)}  ${(row.frontmatter?.type ?? '').padEnd(widths.type)}  ${(row.frontmatter?.lastUpdated ?? '').padEnd(widths.updated)}`,
      );
      for (const err of row.errors) log(`     - ERROR  ${err}`);
      for (const warn of row.warnings) log(`     - WARN   ${warn}`);
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

// The one-file-per-ADR store (docs/ai/adr/) grows O(n) forever, so its rows would blow the index's
// own 80-line cap. It COLLAPSES to a single aggregate row (link → the navigator adr/log.md, record
// count + numeric id range) — while walkMarkdownFiles still finds + cap-checks every individual body
// (a body over its own cap still fails in the main flow; only the index RENDERING is collapsed).
const ADR_DIR_PREFIX = 'docs/ai/adr/';
const ADR_RECORD_RE = /\/AD-(\d{3,})-[^/]*\.md$/;
const ADR_NAV_PATH = 'docs/ai/adr/log.md';

// Only genuine records + the navigator collapse into the aggregate row; an UNEXPECTED file under
// adr/ (a stray README.md, AD-foo.md) renders as its OWN visible index row — never silently hidden
// by the collapse (it also fails archive-decisions' own store-integrity check).
const isCollapsibleAdr = (path) => path.startsWith(ADR_DIR_PREFIX) && (ADR_RECORD_RE.test(path) || path === ADR_NAV_PATH);

const formatAdrCollapseRow = (adrRows) => {
  const recs = adrRows
    .map((r) => {
      const m = r.path.match(ADR_RECORD_RE);
      return m ? { idStr: m[1], idNum: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.idNum - b.idNum); // NUMERIC id ordering (AD-200 before AD-1000), never lexical
  const range = recs.length > 0 ? `AD-${recs[0].idStr} … AD-${recs[recs.length - 1].idStr}` : '—';
  return `| [\`adr/\`](./adr/log.md) | adr | ${recs.length} records | ${range} | — |`;
};

// Pure index renderer — given inspected rows + the date to stamp in the header,
// returns the exact bytes `docs/ai/index.md` should contain. Shared by
// `--write-index` (writes it) and `--check-index` (diffs against on-disk).
export const buildIndex = (rows, todayStr, meta = {}) => {
  const projectName = meta.projectName ?? DEFAULT_PROJECT_NAME;
  const onDemandLinks = meta.onDemandLinks ?? [];
  const hierarchicalLinks = meta.hierarchicalLinks ?? [];
  const header = INDEX_HEADER.replace('__TODAY__', todayStr).replace('__PROJECT__', projectName);
  const tableHeader = `| File | Type | Lines/Max | Updated | Stale after |\n|------|------|-----------|---------|-------------|`;
  const nonAdr = [];
  const adrRows = [];
  for (const r of rows) {
    if (r.path === 'docs/ai/index.md') continue;
    (isCollapsibleAdr(r.path) ? adrRows : nonAdr).push(r);
  }
  const tableEntries = nonAdr.map((r) => ({ sortPath: r.path, md: formatIndexRow(r) }));
  if (adrRows.length > 0) tableEntries.push({ sortPath: ADR_DIR_PREFIX, md: formatAdrCollapseRow(adrRows) });
  tableEntries.sort((a, b) => a.sortPath.localeCompare(b.sortPath));
  const tableRows = tableEntries.map((e) => e.md).join('\n');
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

const writeIndex = async (rows, today, meta, indexPath = INDEX_PATH) => {
  const body = buildIndex(rows, today.toISOString().slice(0, 10), meta);
  await writeFile(indexPath, body, 'utf8');
};

// regenerateIndex(root, todayStr) — the ONE reused generator, root-parameterized (item (h)). It runs
// the SAME walk → inspect → discoverMeta → writeIndex pipeline as `--write-index`, against `root`
// (default this deployment). The ADR-rotation hook reaches it via the CLI (`--write-index --root=…`);
// hermetic tests call it directly. `todayStr` is 'YYYY-MM-DD' (null → today). Returns the written
// index path + row count. No second index implementation exists.
export const regenerateIndex = async (root, todayStr = null) => {
  const { docsDir, indexPath } = pathsFor(root);
  const today = computeToday(todayStr);
  const files = (await walkMarkdownFiles(docsDir)).sort();
  const inspected = await Promise.all(files.map((f) => inspectFile(f, today, root)));
  const rows = inspected.map(formatRow);
  const meta = await discoverMeta(root);
  await writeIndex(rows, today, meta, indexPath);
  return { indexPath, files: rows.length };
};

// The return-code entry point (no process.argv / process.exit / console inside): argv[] →
// { code, stdout, stderr }. The thin shell at the bottom is the only process-coupled code.
export const runCli = async (argv, deps = {}) => {
  const stdoutLines = [];
  const stderrLines = [];
  const log = (line) => stdoutLines.push(line);
  const logError = (line) => stderrLines.push(line);
  const result = (code) => ({
    code,
    stdout: stdoutLines.length > 0 ? `${stdoutLines.join('\n')}\n` : '',
    stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
  });

  const { flags, opts, help, error } = parseArgs(argv);
  if (help) {
    log('Usage: check-docs-size.mjs [--report|--write-index|--check-index] [--today=YYYY-MM-DD] [--root=<dir>] [--quiet]');
    return result(0);
  }
  if (error) {
    logError(error);
    return result(2);
  }
  const { root, docsDir, indexPath } = pathsFor(opts.root ? resolve(opts.root) : (deps.root ?? ROOT));
  const today = computeToday(opts.today);
  const files = (await walkMarkdownFiles(docsDir)).sort();
  const inspected = await Promise.all(files.map((f) => inspectFile(f, today, root)));
  const rows = inspected.map(formatRow);

  const meta = flags.writeIndex || flags.checkIndex ? await discoverMeta(root) : null;

  if (flags.writeIndex) {
    await writeIndex(rows, today, meta, indexPath);
    log(`Wrote ${relative(root, indexPath)}`);
    const after = await stat(indexPath);
    if (after.size === 0) {
      logError('index.md was written empty');
      return result(2);
    }
  }

  if (flags.checkIndex) {
    const onDisk = existsSync(indexPath) ? await readFile(indexPath, 'utf8') : null;
    const { fresh } = checkIndexFreshness(rows, onDisk, meta);
    if (!fresh) {
      logError(
        `[check-docs-size] FAIL: ${relative(root, indexPath)} is stale (out of sync with source frontmatter). Regenerate the index (--write-index) and commit the regenerated file.`,
      );
      return result(1);
    }
    log(
      `[check-docs-size] OK — ${relative(root, indexPath)} is in sync with source frontmatter.`,
    );
    return result(0);
  }

  printReport(rows, flags.quiet, log);
  const errorCount = rows.reduce((n, r) => n + r.errors.length, 0);
  const warnCount = rows.reduce((n, r) => n + r.warnings.length, 0);
  log(
    `\n${rows.length} files inspected  —  ${errorCount} error(s), ${warnCount} warning(s)`,
  );

  return result(errorCount > 0 && !flags.report ? 1 : 0);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const { code, stdout, stderr } = await runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
