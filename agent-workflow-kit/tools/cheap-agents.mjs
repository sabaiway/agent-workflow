#!/usr/bin/env node
// cheap-agents.mjs — the onboarding writer behind `/agent-workflow-kit agents`: places the bundled
// subagent definitions (references/agents/*.md) into a project's .claude/agents/. FOUR vehicles
// grant NO shell — three ride the cheap lane (haiku/low-effort) so mechanical work (sweeps,
// changelog skeletons, gate triage) stops running on a frontier model by default, and review-lens
// is the read-only review opinion. The fifth, `executor`, is the ONE full-tool vehicle: dispatched
// only for a bounded execution, authoring, or write-capable routine slice the orchestrator verifies, never for read-only work, and it
// never commits. `surveyExecutorVehicle` is that vehicle's readiness, for the subagent carrier.
//
// The family's second `.claude/` writer, the velocity-profile.mjs writer discipline verbatim:
//   • preview-then-mutate — `--dry-run` is the DEFAULT and writes nothing; `--apply` writes;
//   • deployment-gated — `--apply` STOPs unless docs/ai/.workflow-version equals the lineage
//     head (a dry-run stays usable whatever the stamp says; an unreadable orchestration config
//     STOPs both, since the derived lenses it names cannot be known);
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
// state, not an error); 1 precondition STOP (stamp, symlink, missing bundle, an unreadable
// orchestration config — the derived lenses it names cannot be known); 2 usage.
// Dependency-free, Node >= 22. No side effects on import.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from './direct-run.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { lensMembersOf } from './review-roster.mjs';
import { deriveLensTemplate, lensVehicleSpec } from './review-roster-resolve.mjs';
// The READ core, never a second copy: the bundle, the placement plan and the executor survey live
// there so the read-only advisor graph can reach them without reaching this writer.
import {
  AGENTS_DIR,
  CLAUDE_DIR,
  WORKFLOW_STAMP,
  EXPECTED_WORKFLOW_VERSION,
  UTF8,
  CHEAP_AGENTS_STAMP,
  CHEAP_AGENTS_BUNDLE,
  CHEAP_AGENTS_CONFIG,
  EXECUTOR_VEHICLE,
  makeCheapAgentsError,
  readFsDeps,
  readBundledAgents,
  readStamp,
  assertDirSafe,
  planPlacement,
} from './cheap-agents-read.mjs';

export {
  AGENTS_DIR,
  CLAUDE_DIR,
  WORKFLOW_STAMP,
  EXPECTED_WORKFLOW_VERSION,
  BUNDLED_AGENTS_DIR,
  CHEAP_AGENTS_STAMP,
  CHEAP_AGENTS_SYMLINK,
  CHEAP_AGENTS_BUNDLE,
  CHEAP_AGENTS_CONFIG,
  makeCheapAgentsError,
  readBundledAgents,
  planPlacement,
  surveyExecutorVehicle,
  EXECUTOR_VEHICLE,
  EXECUTOR_VEHICLE_REL,
} from './cheap-agents-read.mjs';

const EXIT_OK = 0;
const EXIT_PRECONDITION = 1;
const EXIT_USAGE = 2;

// The fallback-lens contract, formalized where it lives (flow-orchestration #15/#3, Phase 4.3):
// the internal-attestation evaluation consumes this sentence — a lens set claiming a configured
// backend's slot without a then-active down-mark REFUSES, quoting it (substitution is recorded,
// never silent).
export const FALLBACK_LENS_ADDITIONAL_ONLY = 'review-lens is an ADDITIONAL read-only review opinion, not a replacement for your configured review recipe.';

const USAGE = `usage: cheap-agents [--dry-run | --apply] [--cwd <dir>] [--help]

Places the bundled subagent definitions into the project's ${AGENTS_DIR}/. Four vehicles grant NO
shell: three ride a cheap model (haiku/low) for mechanical work — extraction sweeps, changelog
fact-skeletons, gate triage — and review-lens is a read-only REVIEW vehicle on a review-capable
model. The fifth, executor, is the ONE full-tool vehicle: dispatched only for a bounded execution,
authoring, or write-capable routine slice the orchestrator verifies, never for read-only work, and
it never commits.
Default is --dry-run (a preview; writes nothing). --apply writes.
Configured derived review lenses are planned and placed beside the bundled vehicles.
An existing file with DIFFERENT content is preserved and reported, never overwritten.`;

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const writeFsDeps = (deps = {}) => ({
  mkdir: deps.mkdir ?? mkdirSync,
  writeFile: deps.writeFile ?? writeFileSync,
});

export const preflightCheapAgents = ({ cwd, derived = [] }, deps = {}) => {
  const fs = readFsDeps(deps);
  const projectDir = cwd ?? process.cwd();
  const templatesByName = new Map(readBundledAgents(deps).map((template) => [template.name, template]));
  for (const template of derived) templatesByName.set(template.name, template);
  const templates = [...templatesByName.values()];
  const stamp = readStamp(join(projectDir, WORKFLOW_STAMP), fs);
  const stampOk = stamp === EXPECTED_WORKFLOW_VERSION;
  assertDirSafe(join(projectDir, CLAUDE_DIR), CLAUDE_DIR, fs);
  assertDirSafe(join(projectDir, AGENTS_DIR), AGENTS_DIR, fs);
  const plan = planPlacement(templates, projectDir, deps);
  return { projectDir, stamp, stampOk, plan };
};

const loadConfigOrStop = (cwd, deps) => {
  try {
    return loadConfig(cwd, deps.readFile, deps.lstat).config;
  } catch (err) {
    throw makeCheapAgentsError(CHEAP_AGENTS_CONFIG, `${err?.message ?? err} — the agents writer cannot read the configured review lenses — nothing is placed`);
  }
};

const configuredDerivedTemplates = (cwd, deps) => {
  const config = loadConfigOrStop(cwd, deps);
  const bundle = readBundledAgents(deps);
  const templates = new Map();
  for (const member of lensMembersOf(config)) {
    const spec = lensVehicleSpec(member);
    if (!spec.derived) continue;
    const base = bundle.find((template) => template.name === `${spec.template}.md`);
    if (!base) throw makeCheapAgentsError(CHEAP_AGENTS_BUNDLE, `${spec.template}.md is missing from the bundle`);
    templates.set(`${spec.stem}.md`, { name: `${spec.stem}.md`, content: deriveLensTemplate(base.content, spec) });
  }
  return [...templates.values()];
};

export const applyCheapAgentsCommand = (root) =>
  `node ${shellQuoteArg(fileURLToPath(import.meta.url))} --apply --cwd ${shellQuoteArg(root)}`;

// ── the writer ────────────────────────────────────────────────────────────────────────

export const writeCheapAgents = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const fs = writeFsDeps(deps);
  const projectDir = cwd ?? process.cwd();
  const derived = configuredDerivedTemplates(projectDir, deps);
  const preflight = preflightCheapAgents({ cwd: projectDir, derived }, deps);
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
      ? 'agent-workflow subagent vehicles — DRY RUN (no changes)'
      : 'agent-workflow subagent vehicles — APPLY',
  ];
  for (const item of result.plan) {
    const verb = result.dryRun && item.action === 'place' ? 'would place' : ACTION_LABEL[item.action];
    lines.push(`  - ${item.rel}: ${verb}`);
  }
  if (!result.stampOk) {
    lines.push(`note: no current deployment stamp found (${result.stamp ?? 'none'}) — --apply will refuse until init/upgrade runs.`);
  }
  const readOnlyCount = result.plan.filter((item) => item.name !== EXECUTOR_VEHICLE).length;
  lines.push(
    `${readOnlyCount} vehicles are Claude Code subagents with READ-ONLY tools and NO shell as bundled or derived (a customized file keeps whatever it grants) — so a fan-out on the shipped templates can never turn into a wave of approval prompts.`,
    `three of those ride the cheap lane (model: haiku, effort: low) for mechanical work; ${FALLBACK_LENS_ADDITIONAL_ONLY}`,
    'executor is the one FULL-TOOL vehicle: dispatched only for a bounded execution, authoring, or write-capable routine slice the orchestrator verifies, never for read-only work, and it never commits.',
  );
  // A preview must print the EXACT command that applies it. The advisor renders this dry-run as an
  // item's one-liner, and that flow's contract is "run the printed command, no improvisation" — a
  // bare "re-run with --apply" would leave the caller to reconstruct --cwd and its quoting.
  if (result.dryRun && result.plan.some((item) => item.action === 'place')) {
    lines.push(`to apply, run exactly: ${applyCheapAgentsCommand(result.projectDir)}`);
  }
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

if (isDirectRun(import.meta.url)) process.exit(main(process.argv.slice(2)));
