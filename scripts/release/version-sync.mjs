#!/usr/bin/env node
// version-sync.mjs — the release-cycle version-sync verifier AND bump writer (repo-local, tracked).
//
// Each family package carries its version in up to FOUR places: package.json, capability.json,
// SKILL.md frontmatter `metadata.version`, and the newest `## X.Y.Z` heading of its CHANGELOG.md.
// A release bump used to be ~12-20 hand-edits, and the old failure mode is one source silently
// left behind. This script IS the deterministic check the release cycle runs instead of a
// frontier re-read: for every package dir it collects each source THE PACKAGE ACTUALLY CARRIES
// (a bridge has no package.json — sources are resolved per package, never assumed), compares
// them, and reports the per-package sync state.
//
//   node scripts/release/version-sync.mjs [--expect <pkg>=X.Y.Z]... [--json] [--root <dir>]
//   node scripts/release/version-sync.mjs --bump <pkg>=X.Y.Z [--bump <pkg>=X.Y.Z]... [--root <dir>]
//
// `--expect` (repeatable) asserts an INTENDED bump: the package must be in sync AND at exactly
// that version. `<pkg>` accepts the directory name or its short alias (memory / engine / kit /
// codex / agy). Exit 0 ONLY when every package is fully in sync and every expectation is met;
// exit 1 names each offending file and the value it carries; exit 2 = usage.
//
// `--bump` (repeatable) WRITES an intended bump across every source the package must carry:
// an npm package (memory / engine / kit) carries all four sources — an ABSENT one is a loud
// refusal (absence is invisible to the verify pass, so the writer must catch it); a bridge
// carries capability.json + SKILL.md only, and a bridge bump re-syncs that bridge's kit mirror
// via scripts/sync-mirrors.mjs. Discipline: preflight-then-mutate (every target source parses
// BEFORE any write), per-source idempotent apply (a source already at the target is skipped
// with a stated note — a killed half-write is repaired by re-running), never a downgrade (an
// uncommitted wrong bump is repaired by git, not by a downgrade flag). The CHANGELOG write
// inserts a loud RELEASE-STUB heading (undated-heading convention, date + marker inside the
// text) that the dispatcher's live preflight refuses to ship. `--bump` and `--expect` in ONE
// invocation is refused at parse time — the verify pass runs as a separate post-bump
// invocation, keeping it the independent check.
//
// The authoritative-source precedence (package.json first, SKILL.md fallback) is reused from the
// kit's manifest validator (readAuthoritativeVersion) as the BASE line; the other sources are
// parsed here independently — the cross-source comparison is the whole point of this script.
// Dependency-free, Node >= 18. No side effects on import.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readAuthoritativeVersion } from '../../agent-workflow-kit/tools/manifest/validate.mjs';
import { syncBridgeMirror, BRIDGE_DIRS } from '../sync-mirrors.mjs';

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

// ── the --bump writer ─────────────────────────────────────────────────────────────────

// The source set a package MUST carry for a bump (stricter than the verify pass, whose
// collectSources is existence-driven and therefore blind to an absent file): npm packages carry
// all four sources; only bridges legitimately carry just capability.json + SKILL.md.
const NPM_SOURCE_FILES = Object.freeze(['package.json', 'capability.json', 'SKILL.md', 'CHANGELOG.md']);
const BRIDGE_SOURCE_FILES = Object.freeze(['capability.json', 'SKILL.md']);
export const expectedSourceFiles = (dir) => (BRIDGE_DIRS.includes(dir) ? BRIDGE_SOURCE_FILES : NPM_SOURCE_FILES);

const compareSemver = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const STUB_MARKER = 'RELEASE-STUB';

// D4: the stub keeps the packages' UNDATED heading convention (`## X.Y.Z — Title`) and carries
// the date + the loud marker INSIDE the text; the same release session replaces it with the real
// entry (wording stays frontier), and the dispatcher's live preflight refuses to ship it.
export const makeChangelogStubHeading = (version, today) =>
  `## ${version} — ${STUB_MARKER} (bumped ${today} — replace with the real entry title)`;

// Each prepare* parses one source and returns a pending write WITHOUT touching the file:
// { label, path, action: 'write' | 'skip', note, nextText? }. Any parse miss throws a loud
// refusal naming the file — and because every prepare runs before any apply, zero writes happen.

const prepareJsonVersionWrite = (path, label, target) => {
  const text = readFileSync(path, 'utf8');
  const current = readJsonVersion(path);
  if (current === null) throw fail(1, `${label}: carries no parseable version — refusing the bump (zero writes)`);
  if (current === target) return { label, path, action: 'skip', note: `already at ${target}` };
  // Line-anchored, value-exact: only the version-carrying line changes; formatting is preserved.
  const lineRe = new RegExp(`^(\\s*"version"\\s*:\\s*")${escapeRe(current)}(")`, 'm');
  if (!lineRe.test(text)) throw fail(1, `${label}: cannot locate the "version" line carrying ${current} — refusing the bump (zero writes)`);
  return { label, path, action: 'write', note: `${current} → ${target}`, nextText: text.replace(lineRe, `$1${target}$2`) };
};

// Rewrite the SKILL.md frontmatter `metadata.version` with EXACTLY the reader's scoping
// (readSkillMetadataVersion above): frontmatter block → `metadata:` → first-indent direct child.
// The replacement targets the resolved LINE INDEX, so an identically-indented decoy under a
// later top-level key (or nested deeper) is never touched. Returns null when the reader would.
export const writeSkillMetadataVersion = (text, target) => {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  const lines = frontmatter[1].split('\n');
  const metaIdx = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (metaIdx === -1) return null;
  const blockIdx = [];
  for (let i = metaIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (/^\S/.test(lines[i])) break; // dedent → left the metadata block
    blockIdx.push(i);
  }
  if (blockIdx.length === 0) return null;
  const childIndent = lines[blockIdx[0]].match(/^(\s+)/)[1];
  const directChild = new RegExp(`^(${childIndent}version:\\s*['"]?)\\d+\\.\\d+\\.\\d+(['"]?\\s*)$`);
  const hit = blockIdx.find((i) => directChild.test(lines[i]));
  if (hit === undefined) return null;
  lines[hit] = lines[hit].replace(directChild, `$1${target}$2`);
  return `---\n${lines.join('\n')}${text.slice(4 + frontmatter[1].length)}`;
};

const prepareSkillWrite = (path, label, target) => {
  const text = readFileSync(path, 'utf8');
  const current = readSkillMetadataVersion(text);
  if (current === null) throw fail(1, `${label}: carries no parseable metadata.version — refusing the bump (zero writes)`);
  if (current === target) return { label, path, action: 'skip', note: `already at ${target}` };
  const nextText = writeSkillMetadataVersion(text, target);
  if (nextText === null) throw fail(1, `${label}: cannot rewrite metadata.version — refusing the bump (zero writes)`);
  return { label, path, action: 'write', note: `${current} → ${target}`, nextText };
};

const prepareChangelogWrite = (path, label, target, today) => {
  const text = readFileSync(path, 'utf8');
  const current = readChangelogHeadingVersion(text);
  if (current === null) throw fail(1, `${label}: carries no parseable version heading — refusing the bump (zero writes)`);
  if (current === target) return { label, path, action: 'skip', note: `newest heading already at ${target} (no duplicate stub)` };
  const headingMatch = text.match(/^##\s+\d+\.\d+\.\d+\b.*$/m);
  const stub = `${makeChangelogStubHeading(target, today)}\n\n`;
  return {
    label,
    path,
    action: 'write',
    note: `${STUB_MARKER} heading inserted above ${current}`,
    nextText: text.slice(0, headingMatch.index) + stub + text.slice(headingMatch.index),
  };
};

// Preflight ONE bump target: existence of every required source, downgrade refusal, and a
// prepared (parsed, not yet applied) write per source. Throws loud, exit-1 refusals; the CLI
// runs every plan's preflight before applying ANY of them.
export const buildBumpPlan = (root, dir, targetVersion, today) => {
  const pkgDir = join(root, dir);
  if (!existsSync(pkgDir)) throw fail(1, `${dir}: package dir is absent under ${root} — refusing the bump`);
  const requiredFiles = expectedSourceFiles(dir);
  for (const file of requiredFiles) {
    if (!existsSync(join(pkgDir, file))) {
      throw fail(1, `${dir}/${file}: expected source is ABSENT — refusing the bump (zero writes; the verify pass cannot see an absent source, so the writer must)`);
    }
  }
  const authoritative = readAuthoritativeVersion(pkgDir);
  if (authoritative.version === null || !SEMVER_RE.test(authoritative.version)) {
    throw fail(1, `${dir}: authoritative version unreadable (${authoritative.from}) — refusing the bump`);
  }
  if (compareSemver(targetVersion, authoritative.version) < 0) {
    throw fail(1, `${dir}: --bump ${targetVersion} is BELOW the current ${authoritative.version} — downgrade refused (repair an uncommitted wrong bump with git, never with a downgrade)`);
  }
  const writes = requiredFiles.map((file) => {
    const path = join(pkgDir, file);
    const label = `${dir}/${file}`;
    if (file === 'SKILL.md') return prepareSkillWrite(path, label, targetVersion);
    if (file === 'CHANGELOG.md') return prepareChangelogWrite(path, label, targetVersion, today);
    return prepareJsonVersionWrite(path, label, targetVersion);
  });
  return { dir, targetVersion, writes };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: version-sync.mjs [--expect <pkg>=X.Y.Z]... [--json] [--root <dir>]\n' +
  '       version-sync.mjs --bump <pkg>=X.Y.Z [--bump <pkg>=X.Y.Z]... [--root <dir>]';

const parsePkgVersionToken = (flag, token) => {
  if (token === undefined) throw fail(2, `${flag} requires <pkg>=X.Y.Z`);
  const eq = token.indexOf('=');
  if (eq <= 0 || eq === token.length - 1) throw fail(2, `${flag} must be <pkg>=X.Y.Z (got "${token}")`);
  const version = token.slice(eq + 1);
  if (!SEMVER_RE.test(version)) throw fail(2, `${flag} version must be X.Y.Z (got "${version}")`);
  return { dir: resolvePackageDir(token.slice(0, eq)), version };
};

const parseArgs = (argv) => {
  const opts = { expect: [], bump: [], json: false, root: null, help: false };
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
      opts.expect.push(parsePkgVersionToken('--expect', argv[i]));
    } else if (arg === '--bump') {
      i += 1;
      const bump = parsePkgVersionToken('--bump', argv[i]);
      if (opts.bump.some((entry) => entry.dir === bump.dir)) {
        throw fail(2, `--bump lists "${bump.dir}" twice — one target version per package`);
      }
      opts.bump.push(bump);
    } else {
      throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
    }
  }
  if (opts.bump.length > 0 && opts.expect.length > 0) {
    throw fail(2, '--bump and --expect cannot share one invocation — run the verify pass (--expect) as a SEPARATE post-bump invocation so it stays the independent check');
  }
  return opts;
};

export const runCli = (argv, deps = {}) => {
  const {
    log = console.log,
    logError = console.error,
    root: defaultRoot = REPO_ROOT,
    today = new Date().toISOString().slice(0, 10),
  } = deps;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    const root = opts.root ?? defaultRoot;

    if (opts.bump.length > 0) {
      // Preflight EVERY plan before applying ANY write — a refusal on the last target must
      // leave the first target's files untouched too.
      const plans = opts.bump.map(({ dir, version }) => buildBumpPlan(root, dir, version, today));
      for (const plan of plans) {
        for (const write of plan.writes) {
          if (write.action === 'skip') {
            log(`[version-sync] ${write.label}: skipped — ${write.note}`);
            continue;
          }
          writeFileSync(write.path, write.nextText);
          log(`[version-sync] ${write.label}: ${write.note}`);
        }
        if (BRIDGE_DIRS.includes(plan.dir)) {
          const changes = syncBridgeMirror(root, plan.dir);
          log(`[version-sync] ${plan.dir}: kit bridge mirror re-synced (${changes.length} file(s) changed)`);
        }
        log(`[version-sync] ${plan.dir}: bumped to ${plan.targetVersion}.`);
      }
      log('[version-sync] done — run the no-flag / --expect verify pass as the separate, independent check.');
      return 0;
    }

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
