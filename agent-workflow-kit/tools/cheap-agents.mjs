#!/usr/bin/env node
// cheap-agents.mjs — the onboarding writer behind `/agent-workflow-kit agents`: places the
// bundled CHEAP-LANE subagent definitions (references/agents/*.md — haiku/low-effort, bounded
// read-only tools) into a project's .claude/agents/ so mechanical work (sweeps, changelog
// skeletons, gate triage) stops running on a frontier model by default.
//
// The family's second `.claude/` writer, the velocity-profile.mjs writer discipline verbatim:
//   • preview-then-mutate — `--dry-run` is the DEFAULT and writes nothing; `--apply` writes;
//   • deployment-gated — `--apply` STOPs unless docs/ai/.workflow-version equals the lineage
//     head (a dry-run stays usable on any project);
//   • symlink-safe — a symlinked `.claude` / `.claude/agents` / target file is a STOP, never a
//     write-through;
//   • NEVER overwrites an existing .claude/agents/ file whose content differs from the bundled
//     template — a customization is REPORTED (`customized — preserved`), never clobbered;
//     an identical file is `already current` (idempotent re-run);
//   • writes ONLY under .claude/agents/ — never settings.json / settings.local.json, never
//     commits.
//
// Claude-Code-specific (like velocity): .claude/agents/ is a Claude Code surface; other agent
// hosts ignore it. In a HIDDEN-mode deployment, run the hide-footprint reconcile after apply so
// the placed files stay out of `git status` (the registry already carries /.claude/agents/); the
// apply report reminds you.
//
// Exit codes: 0 done / dry-run (incl. preserved customizations — a user's file is a legitimate
// state, not an error); 1 precondition STOP (stamp, symlink, missing bundle); 2 usage.
// Dependency-free, Node >= 22. No side effects on import.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const AGENTS_DIR = '.claude/agents';
export const CLAUDE_DIR = '.claude';
export const WORKFLOW_STAMP = 'docs/ai/.workflow-version';
export const EXPECTED_WORKFLOW_VERSION = '2.0.0';
export const BUNDLED_AGENTS_DIR = resolve(HERE, '..', 'references', 'agents');

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;
const UTF8 = 'utf8';
const ERROR_PREFIX = '[agent-workflow-kit]';

export const CHEAP_AGENTS_STAMP = 'CHEAP_AGENTS_STAMP';
export const CHEAP_AGENTS_SYMLINK = 'CHEAP_AGENTS_SYMLINK';
export const CHEAP_AGENTS_BUNDLE = 'CHEAP_AGENTS_BUNDLE';

const USAGE = `usage: cheap-agents [--dry-run | --apply] [--cwd <dir>] [--help]

Places the bundled cheap-lane subagent definitions (haiku/low, read-only tools) into the
project's ${AGENTS_DIR}/. Default is --dry-run (a preview; writes nothing). --apply writes.
An existing file with DIFFERENT content is preserved and reported, never overwritten.`;

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

export const makeCheapAgentsError = (code, message) =>
  Object.assign(new Error(`${ERROR_PREFIX} ${message}`), { name: 'CheapAgentsError', code, exitCode: EXIT_PRECONDITION });

const fsDeps = (deps = {}) => ({
  exists: deps.exists ?? existsSync,
  lstat: deps.lstat ?? lstatSync,
  mkdir: deps.mkdir ?? mkdirSync,
  readFile: deps.readFile ?? readFileSync,
  writeFile: deps.writeFile ?? writeFileSync,
  readdir: deps.readdir ?? readdirSync,
});

const lstatNoFollow = (absPath, fs) => {
  try {
    return fs.lstat(absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// ── the bundle (the kit's own references/agents/) ─────────────────────────────────────

export const readBundledAgents = (deps = {}) => {
  const fs = fsDeps(deps);
  const bundleDir = deps.bundleDir ?? BUNDLED_AGENTS_DIR;
  let names;
  try {
    names = fs.readdir(bundleDir);
  } catch (err) {
    throw makeCheapAgentsError(CHEAP_AGENTS_BUNDLE, `bundled agents dir unreadable (${err.code ?? err.message}): ${bundleDir}`);
  }
  const templates = names
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ name, content: fs.readFile(join(bundleDir, name), UTF8) }));
  if (templates.length === 0) {
    throw makeCheapAgentsError(CHEAP_AGENTS_BUNDLE, `no bundled agent templates found in ${bundleDir} — the kit install is incomplete`);
  }
  return templates;
};

// ── preflight (velocity discipline: symlink-safe, stamp read, no writes) ──────────────

const readStamp = (absPath, fs) => {
  try {
    if (!fs.exists(absPath)) return null;
    const stamp = String(fs.readFile(absPath, UTF8)).trim();
    return stamp.length ? stamp : null;
  } catch {
    return null; // unreadable stamp == not a valid deployment stamp (apply STOPs; dry-run reports)
  }
};

const assertDirSafe = (absPath, relPath, fs) => {
  const stat = lstatNoFollow(absPath, fs);
  if (stat === null) return { absent: true };
  if (stat.isSymbolicLink()) throw makeCheapAgentsError(CHEAP_AGENTS_SYMLINK, `${relPath} is a symlink — refusing to write through it`);
  if (!stat.isDirectory()) throw makeCheapAgentsError(CHEAP_AGENTS_SYMLINK, `${relPath} exists but is not a directory — refusing to write through it`);
  return { absent: false };
};

// Per-template placement plan: place | already-current | customized-preserved (never clobbered).
export const planPlacement = (templates, projectDir, deps = {}) => {
  const fs = fsDeps(deps);
  return templates.map((template) => {
    const rel = `${AGENTS_DIR}/${template.name}`;
    const abs = join(projectDir, AGENTS_DIR, template.name);
    const stat = lstatNoFollow(abs, fs);
    if (stat === null) return { ...template, rel, abs, action: 'place' };
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw makeCheapAgentsError(CHEAP_AGENTS_SYMLINK, `${rel} exists but is not a regular file — refusing to touch it`);
    }
    const existing = fs.readFile(abs, UTF8);
    if (existing === template.content) return { ...template, rel, abs, action: 'already-current' };
    return { ...template, rel, abs, action: 'customized-preserved' };
  });
};

export const preflightCheapAgents = ({ cwd }, deps = {}) => {
  const fs = fsDeps(deps);
  const projectDir = cwd ?? process.cwd();
  const templates = readBundledAgents(deps);
  const stamp = readStamp(join(projectDir, WORKFLOW_STAMP), fs);
  const stampOk = stamp === EXPECTED_WORKFLOW_VERSION;
  assertDirSafe(join(projectDir, CLAUDE_DIR), CLAUDE_DIR, fs);
  assertDirSafe(join(projectDir, AGENTS_DIR), AGENTS_DIR, fs);
  const plan = planPlacement(templates, projectDir, deps);
  return { projectDir, stamp, stampOk, plan };
};

// ── the writer ────────────────────────────────────────────────────────────────────────

export const writeCheapAgents = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const fs = fsDeps(deps);
  const preflight = preflightCheapAgents({ cwd }, deps);
  if (dryRun) return { wrote: false, dryRun: true, ...preflight };

  if (!preflight.stampOk) {
    throw makeCheapAgentsError(
      CHEAP_AGENTS_STAMP,
      `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION} (found ${preflight.stamp ?? 'none'}) — run init/upgrade first`,
    );
  }
  const toPlace = preflight.plan.filter((item) => item.action === 'place');
  if (toPlace.length > 0) fs.mkdir(join(preflight.projectDir, AGENTS_DIR), { recursive: true });
  for (const item of toPlace) fs.writeFile(item.abs, item.content, UTF8);
  return { wrote: toPlace.length > 0, dryRun: false, ...preflight };
};

// ── report ────────────────────────────────────────────────────────────────────────────

const ACTION_LABEL = {
  place: 'place',
  'already-current': 'already current',
  'customized-preserved': 'customized — preserved (delete the file to reseed from the bundle)',
};

export const formatResult = (result) => {
  const lines = [
    result.dryRun
      ? 'agent-workflow cheap-lane agents — DRY RUN (no changes; re-run with --apply)'
      : 'agent-workflow cheap-lane agents — APPLY',
  ];
  for (const item of result.plan) {
    const verb = result.dryRun && item.action === 'place' ? 'would place' : ACTION_LABEL[item.action];
    lines.push(`  - ${item.rel}: ${verb}`);
  }
  if (!result.stampOk) {
    lines.push(`note: no current deployment stamp found (${result.stamp ?? 'none'}) — --apply will refuse until init/upgrade runs.`);
  }
  lines.push(
    'the vehicles are Claude Code subagents (model: haiku, effort: low, read-only tools) for mechanical work only — judgment, review, and real code stay on your main lane.',
  );
  if (!result.dryRun && result.wrote) {
    lines.push('hidden-mode note: if this deployment is hidden, run the hide-footprint reconcile so the placed files stay out of `git status`.');
  }
  return lines.join('\n');
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const opts = { dryRunFlag: false, apply: false, cwd: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRunFlag = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--cwd') {
      i += 1;
      if (argv[i] === undefined || argv[i].startsWith('-')) throw fail(EXIT_USAGE, '--cwd needs a directory argument');
      opts.cwd = argv[i];
    } else {
      throw fail(EXIT_USAGE, `unknown argument: ${arg}`);
    }
  }
  if (opts.dryRunFlag && opts.apply) throw fail(EXIT_USAGE, '--dry-run and --apply cannot be used together');
  return { help: opts.help, dryRun: !opts.apply, cwd: opts.cwd };
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const errlog = deps.errlog ?? console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return EXIT_OK;
    }
    const result = writeCheapAgents({ cwd: args.cwd ?? process.cwd(), dryRun: args.dryRun }, deps);
    log(formatResult(result));
    return EXIT_OK;
  } catch (err) {
    errlog(err?.message ?? String(err));
    if (err?.exitCode === EXIT_USAGE) errlog(USAGE);
    return err?.exitCode ?? EXIT_PRECONDITION;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
