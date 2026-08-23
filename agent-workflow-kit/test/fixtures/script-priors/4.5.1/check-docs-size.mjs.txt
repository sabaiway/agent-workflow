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
//   --ensure-index    the idempotent finalizer every deploy/upgrade path runs after its last
//                     docs/ai mutation: probe, write only when the navigator is missing or stale,
//                     print ONE outcome line (`ensure-index: regenerated|already-current` on
//                     stdout; `ensure-index: write-refused|probe-failed — <path>: …` on stderr).
//                     Exit 0 on either written state, 2 on a named refusal — never a stack trace.
//
// CLI overrides:
//   --today=YYYY-MM-DD (default today UTC) — useful for tests / reproducible runs
//   --root=<dir>       run against another project root (default this deployment) — the ADR-rotation
//                      hook passes it so a rotation regenerates the right project's index
//   --quiet            print only failures (and final summary)

import { readFile, writeFile, readdir, stat, rename, rm } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DOCS_DIR = resolve(ROOT, 'docs/ai');
const INDEX_PATH = resolve(DOCS_DIR, 'index.md');

// Root-parameterized (BUGFREE-3 / AD-049, item (h)): the module ROOT constants are the CLI DEFAULT
// (this deployment's own root); `--root=<dir>` and the exported `regenerateIndex(root, today)`
// override them so the ADR-rotation hook (archive-decisions.mjs) and hermetic tests can regenerate
// an arbitrary root's index without ever touching the real repo tree.
const pathsFor = (root) => {
  const base = resolve(root);
  return { root: base, docsDir: resolve(base, 'docs/ai'), indexPath: resolve(base, 'docs/ai/index.md') };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The one token every `--ensure-index` outcome line opens with — deploy/upgrade prose relays it
// verbatim and the kit's ensure op reads it, so it is a contract, not a message.
const ENSURE_INDEX_PREFIX = 'ensure-index:';

// Project-name + footer links for the index are auto-discovered (no hardcoding):
//   project name  ← package.json "name" (fallback: repo dir basename)
//   hierarchical  ← every AGENTS.md / CLAUDE.md below the repo root
//   on-demand     ← .agents/skills/*-{patterns,commands}/SKILL.md
const DEFAULT_PROJECT_NAME = 'this project';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-ssr', 'coverage', 'build', '.next']);

// `strict` is the finalizer's lens on the SAME walk: for a report, an unreadable subtree is fairly
// skipped, but a run that WRITES the navigator may not silently treat "could not read" as "nothing
// there" — it would publish an index missing whatever it could not see and call that success. Only
// a genuine ENOENT stays an absence; every other fs error propagates.
// Only a genuine ENOENT is an absence. A code-LESS throw (an injected reader, a wrapped client) is
// not evidence of absence either, so it propagates too — "unknown" must never read as "empty".
const rethrowUnlessAbsent = (err, strict) => {
  if (strict && err?.code !== 'ENOENT') throw err;
};

const walkForName = async (dir, name, acc = [], depth = 0, strict = false, deps = {}) => {
  if (depth > 6) return acc;
  const readDir = deps.readdir ?? readdir;
  let entries;
  try {
    entries = await readDir(dir, { withFileTypes: true });
  } catch (err) {
    rethrowUnlessAbsent(err, strict);
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkForName(join(dir, entry.name), name, acc, depth + 1, strict, deps);
    } else if (entry.isFile() && entry.name === name) {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
};

export const discoverMeta = async (root = ROOT, { strict = false, deps = {} } = {}) => {
  const read = deps.readFile ?? readFile;
  const readDir = deps.readdir ?? readdir;
  let projectName = basename(root);
  // The READ and the PARSE are separate on purpose: an unreadable package.json is a tree this run
  // could not see (strict propagates it), while a MALFORMED one is authored content — the basename
  // fallback, under strict too.
  let manifest = null;
  try {
    manifest = await read(resolve(root, 'package.json'), 'utf8');
  } catch (err) {
    rethrowUnlessAbsent(err, strict);
  }
  if (manifest !== null) {
    try {
      const pkg = JSON.parse(manifest);
      if (pkg.name) projectName = pkg.name;
    } catch {
      /* malformed package.json — keep the dir basename */
    }
  }
  const agentsFiles = await walkForName(root, 'AGENTS.md', [], 0, strict, deps);
  const claudeFiles = await walkForName(root, 'CLAUDE.md', [], 0, strict, deps);
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
    const skillDirs = await readDir(resolve(root, '.agents/skills'), { withFileTypes: true });
    onDemandLinks = skillDirs
      .filter((dirent) => dirent.isDirectory() && /-(patterns|commands)$/.test(dirent.name))
      .map((dirent) => dirent.name)
      .sort()
      .map((name) => `[\`${name}\`](../../.agents/skills/${name}/SKILL.md)`);
  } catch (err) {
    // No .agents/skills — omit the section (under strict, only a real absence may omit it).
    rethrowUnlessAbsent(err, strict);
  }
  return { projectName, hierarchicalLinks, onDemandLinks };
};

// Pure argv parser (no I/O, no exit): `help` / `error` ride out as data for runCli to render.
const parseArgs = (argv) => {
  const flags = { report: false, writeIndex: false, checkIndex: false, ensureIndex: false, quiet: false };
  const opts = { today: null, root: null };
  for (const arg of argv) {
    if (arg === '--report') flags.report = true;
    else if (arg === '--write-index') flags.writeIndex = true;
    else if (arg === '--check-index') flags.checkIndex = true;
    else if (arg === '--ensure-index') flags.ensureIndex = true;
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

// The navigator is a GENERATED artifact, so its write must land on the deployment's own file and
// nowhere else: every component of <root>/docs/ai/index.md is lstat'ed no-follow (a symlinked root,
// `docs`, `docs/ai` or leaf REFUSES — publishing through one would clobber whatever it points at),
// the body goes out through a unique exclusive-create temp renamed into place with the chain
// re-checked immediately before the rename, and the temp never survives a failure. The kit runs the
// same discipline in atomic-write.mjs; this deployment script ships dependency-free, so the
// semantics are REIMPLEMENTED here rather than imported.
export const INDEX_WRITE_REFUSED = 'INDEX_WRITE_REFUSED';
const refuse = (message) => Object.assign(new Error(message), { code: INDEX_WRITE_REFUSED });

const lstatNoFollow = (target, lstat) => {
  try {
    return lstat(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// The target is always DERIVED from `root` here (the navigator and its temp sibling), never handed
// in by a caller, so there is no escape arm to guard: what remains is the no-follow walk.
const assertContainedNoSymlink = (root, target, lstat) => {
  const rel = relative(root, target);
  if (lstatNoFollow(root, lstat)?.isSymbolicLink()) {
    throw refuse(`${root} is a symlink — refusing to write the navigator through it`);
  }
  rel.split(sep).filter(Boolean).reduce((walked, part) => {
    const current = join(walked, part);
    if (lstatNoFollow(current, lstat)?.isSymbolicLink()) {
      throw refuse(`${current} is a symlink — refusing to write the navigator through it`);
    }
    return current;
  }, root);
};

const writeIndex = async (rows, today, meta, { root = ROOT, indexPath = INDEX_PATH, deps = {} } = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const write = deps.writeFile ?? writeFile;
  const publish = deps.rename ?? rename;
  const remove = deps.rm ?? rm;
  const uniqueSuffix = deps.rand ?? (() => randomBytes(6).toString('hex'));
  const body = buildIndex(rows, today.toISOString().slice(0, 10), meta);
  assertContainedNoSymlink(root, indexPath, lstat);
  const tmp = `${indexPath}.${uniqueSuffix()}.tmp`;
  assertContainedNoSymlink(root, tmp, lstat);
  const discardTemp = async (err) => {
    try {
      await remove(tmp, { force: true });
    } catch (cleanupErr) {
      throw refuse(`${err.message} — and its temp file could not be removed, delete it by hand: ${tmp} (${cleanupErr.message})`);
    }
    throw err;
  };
  try {
    await write(tmp, body, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    // EEXIST means the name is SOMEONE ELSE's file: exclusive-create refused, this run wrote
    // nothing, and removing it would delete a file we never made. Every other failure can leave a
    // partial temp behind, and that one is ours to discard.
    if (err && err.code === 'EEXIST') throw err;
    await discardTemp(err);
  }
  try {
    assertContainedNoSymlink(root, indexPath, lstat);
    await publish(tmp, indexPath);
  } catch (err) {
    await discardTemp(err);
  }
};

// regenerateIndex(root, todayStr) — the ONE reused generator, root-parameterized (item (h)). It runs
// the SAME walk → inspect → discoverMeta → writeIndex pipeline as `--write-index`, against `root`
// (default this deployment). The ADR-rotation hook reaches it via the CLI (`--write-index --root=…`);
// hermetic tests call it directly. `todayStr` is 'YYYY-MM-DD' (null → today). Returns the written
// index path + row count. No second index implementation exists.
export const regenerateIndex = async (root, todayStr = null, deps = {}) => {
  const paths = pathsFor(root);
  const today = computeToday(todayStr);
  const files = (await walkMarkdownFiles(paths.docsDir)).sort();
  const inspected = await Promise.all(files.map((f) => inspectFile(f, today, paths.root)));
  const rows = inspected.map(formatRow);
  const meta = await discoverMeta(paths.root);
  await writeIndex(rows, today, meta, { root: paths.root, indexPath: paths.indexPath, deps });
  return { indexPath: paths.indexPath, files: rows.length };
};

// The finalizer promises its caller EXACTLY ONE outcome line, so every step it owns — the walk, the
// metadata discovery, the freshness read and the write — runs inside one classified error path: an
// unreadable docs/ai is a NAMED refusal, never a stack trace. The containment guard runs BEFORE the
// freshness read for the same reason `already-present` needs a kind probe: a symlinked navigator
// whose target happens to hold current bytes would otherwise report `already-current` over a file
// this mode refuses to write through — an exit 0 proving nothing about the deployment's own file.
const runEnsureIndex = async ({ root, docsDir, indexPath, today, deps }) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.readFile ?? readFile;
  const line = (token) => `${ENSURE_INDEX_PREFIX} ${token} — ${relative(root, indexPath)}`;
  // The two refusals name STAGES, not error codes: once the write has been entered, ANY failure —
  // a containment refusal, EIO, EACCES — is a write refusal, because that is what the reader has to
  // act on. A raw fs error reported as a failed PROBE would send them to the wrong half of the run.
  let writing = false;
  try {
    assertContainedNoSymlink(root, indexPath, lstat);
    const files = (await walkMarkdownFiles(docsDir)).sort();
    const inspected = await Promise.all(files.map((file) => inspectFile(file, today, root)));
    const rows = inspected.map(formatRow);
    const meta = await discoverMeta(root, { strict: true, deps });
    const onDisk = existsSync(indexPath) ? await read(indexPath, 'utf8') : null;
    if (checkIndexFreshness(rows, onDisk, meta).fresh) return { code: 0, out: line('already-current') };
    writing = true;
    await writeIndex(rows, today, meta, { root, indexPath, deps });
    return { code: 0, out: line('regenerated') };
  } catch (err) {
    const cause = writing || err?.code === INDEX_WRITE_REFUSED ? 'write-refused' : 'probe-failed';
    return { code: 2, err: `${ENSURE_INDEX_PREFIX} ${cause} — ${indexPath}: ${err.message}` };
  }
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
    log('Usage: check-docs-size.mjs [--report|--write-index|--check-index|--ensure-index] [--today=YYYY-MM-DD] [--root=<dir>] [--quiet]');
    return result(0);
  }
  if (error) {
    logError(error);
    return result(2);
  }
  const { root, docsDir, indexPath } = pathsFor(opts.root ? resolve(opts.root) : (deps.root ?? ROOT));
  const today = computeToday(opts.today);

  // The finalizer owns its whole pipeline (above), so it returns BEFORE the shared walk: a tree the
  // walk would throw on must still close with one outcome line.
  if (flags.ensureIndex) {
    const { code, out, err } = await runEnsureIndex({ root, docsDir, indexPath, today, deps });
    if (out) log(out);
    if (err) logError(err);
    return result(code);
  }

  const files = (await walkMarkdownFiles(docsDir)).sort();
  const inspected = await Promise.all(files.map((f) => inspectFile(f, today, root)));
  const rows = inspected.map(formatRow);

  const meta = flags.writeIndex || flags.checkIndex ? await discoverMeta(root) : null;

  if (flags.writeIndex) {
    try {
      await writeIndex(rows, today, meta, { root, indexPath, deps });
    } catch (err) {
      logError(`[check-docs-size] FAIL: ${indexPath}: ${err.message}`);
      return result(2);
    }
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

// Run main() only when executed directly, never on import. Compare by REAL path: an entry point
// reached through a symlink resolves to its target, so a raw string compare reads the two as
// different and the CLI never runs. realpathSync collapses the link so both sides match.
const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  const { code, stdout, stderr } = await runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
