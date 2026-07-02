#!/usr/bin/env node
// version-sync.mjs — the release-cycle version-sync verifier (repo-local, tracked).
//
// Each family package carries its version in up to FOUR places: package.json, capability.json,
// SKILL.md frontmatter `metadata.version`, and the newest `## X.Y.Z` heading of its CHANGELOG.md.
// A release bump edits several of them by hand, and the old failure mode is one source silently
// left behind. This script IS the deterministic check the release cycle runs instead of a
// frontier re-read: for every package dir it collects each source THE PACKAGE ACTUALLY CARRIES
// (a bridge has no package.json — sources are resolved per package, never assumed), compares
// them, and reports the per-package sync state.
//
//   node scripts/release/version-sync.mjs [--expect <pkg>=X.Y.Z]... [--json] [--root <dir>]
//
// `--expect` (repeatable) asserts an INTENDED bump: the package must be in sync AND at exactly
// that version. `<pkg>` accepts the directory name or its short alias (memory / engine / kit /
// codex / agy). Exit 0 ONLY when every package is fully in sync and every expectation is met;
// exit 1 names each offending file and the value it carries; exit 2 = usage.
//
// The authoritative-source precedence (package.json first, SKILL.md fallback) is reused from the
// kit's manifest validator (readAuthoritativeVersion) as the BASE line; the other sources are
// parsed here independently — the cross-source comparison is the whole point of this script.
// Read-only, dependency-free, Node >= 18. No side effects on import.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readAuthoritativeVersion } from '../../agent-workflow-kit/tools/manifest/validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

// Every family package dir this repo carries, in the canonical order. Sources are resolved per
// package against the real files — a dir that lacks a source simply contributes fewer entries.
export const FAMILY_DIRS = Object.freeze([
  'agent-workflow-memory',
  'agent-workflow-engine',
  'agent-workflow-kit',
  'codex-cli-bridge',
  'antigravity-cli-bridge',
]);

// Short aliases (the publish.yml package vocabulary + the bridge shorthands) → package dir.
export const PACKAGE_ALIASES = Object.freeze({
  memory: 'agent-workflow-memory',
  engine: 'agent-workflow-engine',
  kit: 'agent-workflow-kit',
  codex: 'codex-cli-bridge',
  agy: 'antigravity-cli-bridge',
  antigravity: 'antigravity-cli-bridge',
});

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

export const resolvePackageDir = (token) => {
  if (FAMILY_DIRS.includes(token)) return token;
  const aliased = PACKAGE_ALIASES[token];
  if (aliased) return aliased;
  throw fail(2, `unknown package "${token}" (dirs: ${FAMILY_DIRS.join(', ')}; aliases: ${Object.keys(PACKAGE_ALIASES).join(', ')})`);
};

// ── the four independent source parsers ───────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const readJsonVersion = (path) => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
};

// SKILL.md frontmatter `metadata: version:` — parsed independently of the kit helper (quoted or
// bare), scoped to the frontmatter block so a version in the body never matches. Indent-aware
// DIRECT-CHILD parse (the manifest validator's behavior): only a `version:` at the first indent
// level under `metadata:` counts — a decoy nested deeper (or under another sub-key) never does.
export const readSkillMetadataVersion = (text) => {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  const lines = frontmatter[1].split('\n');
  const metaIdx = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (metaIdx === -1) return null;
  const block = [];
  for (const line of lines.slice(metaIdx + 1)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // dedent → left the metadata block
    block.push(line);
  }
  if (block.length === 0) return null;
  const childIndent = block[0].match(/^(\s+)/)[1];
  const directChild = new RegExp(`^${childIndent}version:\\s*['"]?(\\d+\\.\\d+\\.\\d+)['"]?\\s*$`);
  const match = block.map((line) => line.match(directChild)).find(Boolean);
  return match ? match[1] : null;
};

// The NEWEST `## X.Y.Z` heading — the first one in the file (CHANGELOGs here are newest-first).
export const readChangelogHeadingVersion = (text) => {
  const match = text.match(/^##\s+(\d+\.\d+\.\d+)\b/m);
  return match ? match[1] : null;
};

// ── per-package collection + comparison ───────────────────────────────────────────────

// Collect every version source the package dir actually carries. Each entry: { file, version }
// (version null = the file exists but no version could be parsed — reported as a defect, never
// silently skipped).
export const collectSources = (root, dir) => {
  const sources = [];
  const push = (rel, version) => sources.push({ file: `${dir}/${rel}`, version });
  const pkgPath = join(root, dir, 'package.json');
  if (existsSync(pkgPath)) push('package.json', readJsonVersion(pkgPath));
  const capPath = join(root, dir, 'capability.json');
  if (existsSync(capPath)) push('capability.json', readJsonVersion(capPath));
  const skillPath = join(root, dir, 'SKILL.md');
  if (existsSync(skillPath)) push('SKILL.md', readSkillMetadataVersion(readFileSync(skillPath, 'utf8')));
  const changelogPath = join(root, dir, 'CHANGELOG.md');
  if (existsSync(changelogPath)) push('CHANGELOG.md', readChangelogHeadingVersion(readFileSync(changelogPath, 'utf8')));
  return sources;
};

// Compare one package's sources → { dir, base, sources, inSync, problems[] }. The kit's
// readAuthoritativeVersion supplies the BASE (package.json first, SKILL.md fallback); every
// other source must equal it exactly.
export const checkPackage = (root, dir) => {
  const sources = collectSources(root, dir);
  const problems = [];
  if (sources.length === 0) {
    return { dir, base: null, sources, inSync: false, problems: [`${dir}: no version source found (no package.json / capability.json / SKILL.md / CHANGELOG.md)`] };
  }
  const authoritative = readAuthoritativeVersion(join(root, dir));
  const base = authoritative.version;
  if (base === null || !SEMVER_RE.test(base)) {
    problems.push(`${dir}: authoritative version unreadable (${authoritative.from})`);
  }
  for (const source of sources) {
    if (source.version === null) {
      problems.push(`${source.file}: carries no parseable version`);
    } else if (base !== null && source.version !== base) {
      problems.push(`${source.file}: ${source.version} ≠ ${base} (authoritative ${authoritative.from})`);
    }
  }
  return { dir, base, sources, inSync: problems.length === 0, problems };
};

// Assert an intended bump on an already-checked package report.
export const checkExpectation = (report, expectedVersion) => {
  const problems = [];
  if (!report.inSync) {
    problems.push(`${report.dir}: expected ${expectedVersion} but the package is not in sync`);
  } else if (report.base !== expectedVersion) {
    problems.push(`${report.dir}: expected ${expectedVersion}, found ${report.base}`);
  }
  return problems;
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: version-sync.mjs [--expect <pkg>=X.Y.Z]... [--json] [--root <dir>]';

const parseArgs = (argv) => {
  const opts = { expect: [], json: false, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--root') {
      i += 1;
      if (argv[i] === undefined) throw fail(2, '--root requires a directory argument');
      opts.root = argv[i];
    } else if (arg === '--expect') {
      i += 1;
      const token = argv[i];
      if (token === undefined) throw fail(2, '--expect requires <pkg>=X.Y.Z');
      const eq = token.indexOf('=');
      if (eq <= 0 || eq === token.length - 1) throw fail(2, `--expect must be <pkg>=X.Y.Z (got "${token}")`);
      const version = token.slice(eq + 1);
      if (!SEMVER_RE.test(version)) throw fail(2, `--expect version must be X.Y.Z (got "${version}")`);
      opts.expect.push({ dir: resolvePackageDir(token.slice(0, eq)), version });
    } else {
      throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  return opts;
};

export const runCli = (argv, deps = {}) => {
  const { log = console.log, logError = console.error, root: defaultRoot = REPO_ROOT } = deps;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    const root = opts.root ?? defaultRoot;
    const reports = FAMILY_DIRS.filter((dir) => existsSync(join(root, dir))).map((dir) => checkPackage(root, dir));
    if (reports.length === 0) throw fail(2, `no family package dir found under ${root}`);
    const problems = reports.flatMap((report) => report.problems);
    for (const { dir, version } of opts.expect) {
      const report = reports.find((entry) => entry.dir === dir);
      if (!report) problems.push(`${dir}: expected ${version} but the package dir is absent`);
      else problems.push(...checkExpectation(report, version));
    }
    if (opts.json) {
      log(JSON.stringify({ inSync: problems.length === 0, packages: reports, problems }, null, 2));
    } else {
      for (const report of reports) {
        const state = report.inSync ? 'in sync' : 'OUT OF SYNC';
        log(`${report.dir}: ${report.base ?? '?'} — ${state} (${report.sources.length} sources)`);
      }
      for (const problem of problems) logError(`[version-sync] ${problem}`);
      log(problems.length === 0 ? '[version-sync] all sources in sync.' : `[version-sync] ${problems.length} problem(s).`);
    }
    return problems.length === 0 ? 0 : 1;
  } catch (err) {
    logError(`[version-sync] ${err.message}`);
    return err.exitCode ?? 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = runCli(process.argv.slice(2));
