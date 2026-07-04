#!/usr/bin/env node
// Live methodology-engine source resolution — the kit reads the bounded methodology fragment
// LIVE from the installed agent-workflow-engine (the family's one source of truth), via the same
// `detect.installed` idiom the kit already uses to find memory (detectMemory in delegation.mjs),
// NOT an npm `dependencies` edge (the family DAG: the kit DETECTS siblings, it never imports them).
//
//   resolveEngineDir({ env, home }) → { dir, source }   env override vs the ~/.claude default
//   detectEngine(dir, { source })   → { ok, reason, dir }   runs the kit's OWN validator
//   readEngineFragment(dir, { source }) → fragment string, or THROWS a loud install-me error
//
// Fail-closed: readEngineFragment never falls back to a bundled copy (there is none after the
// mirror retirement) — when the engine is needed but absent/invalid it throws with the exact
// remediation, so the reconcile STOPs loudly rather than silently dropping the slot (AGENTS.md:
// no silent failures). Pure-where-possible (fs + validator injectable for tests), Node >= 18.

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest, VALID } from './manifest/validate.mjs';

// The engine's detect.installed contract (agent-workflow-engine/capability.json): the env override,
// the ~/.claude default home, the declared skill name, and the in-skill path of the live fragment.
export const ENGINE_ENV = 'AGENT_WORKFLOW_ENGINE_DIR';
export const EXPECTED_ENGINE_NAME = 'agent-workflow-engine';
export const ENGINE_FRAGMENT_REL = 'references/methodology-slot.md';
// The orchestration-recipes slot fragment — a SECOND bounded fragment the kit injects (Plan 4). An
// engine older than 1.2.0 does not ship it; detectEngine({ rel }) lets a caller verify the specific
// fragment so `status` can caveat a too-old engine instead of failing the methodology read.
export const ORCHESTRATION_FRAGMENT_REL = 'references/orchestration-slot.md';
// The activity-procedures canon — a NEW live-read engine fragment (engine >= 1.3.0). The procedures
// CLI reads it via readEngineFragment({ rel }); detectEngine({ rel }) lets `status` caveat — and the
// CLI fail loudly on — an engine too old to ship it. readEngineFragment accepts an arbitrary `rel`
// (no whitelist), so no further plumbing is needed beyond this constant.
export const PROCEDURES_FRAGMENT_REL = 'references/procedures.md';
// The agent-rules lens pair — the canonical lens block + its append-only prior store (engine
// >= 1.13.0; an older engine ships neither). The kit's lens-region reconcile live-reads BOTH via
// readEngineFragment({ rel }); detectEngine({ rel }) lets it soft-skip a too-old engine (and
// `status` caveat it) instead of failing the whole reconcile.
export const LENS_FRAGMENT_REL = 'references/agent-rules-lens.md';
export const LENS_PRIORS_REL = 'references/agent-rules-lens-priors.md';
const ENGINE_DEFAULT_REL = '.claude/skills/agent-workflow-engine';

const defaultStatType = (path) => {
  try {
    const s = statSync(path);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
};

// Resolve the installed engine dir from the env override (if set) or the ~/.claude default,
// mirroring the engine's `detect.installed`. `source` is load-bearing: a missing dir is reported as
// `env-set-but-missing` ONLY when source === 'env' (the user pointed us somewhere that is not there),
// which cannot be derived from `dir` alone.
export const resolveEngineDir = ({ env = {}, home = '' } = {}) => {
  const fromEnv = env[ENGINE_ENV];
  if (typeof fromEnv === 'string' && fromEnv) return { dir: fromEnv, source: 'env' };
  return { dir: join(home, ENGINE_DEFAULT_REL), source: 'default' };
};

// Decide whether the resolved dir is a usable methodology engine. Runs the kit's OWN validator
// (never a candidate-shipped one), and clones detectMemory's reason ladder so each failure has a
// distinct, actionable reason. ok only on: a dir that exists + VALID manifest + kind
// methodology-engine + the right name + available + the live fragment file present.
export const detectEngine = (engineDir, { source, rel } = {}, deps = {}) => {
  const validate = deps.validate ?? validateManifest;
  const statType = deps.statType ?? defaultStatType;
  const fragmentRel = rel ?? ENGINE_FRAGMENT_REL;

  // The dir itself must exist first — this is what lets an env-pointed-but-absent dir read as the
  // distinct `env-set-but-missing` (validateManifest would only say "capability.json not found").
  if (statType(engineDir) !== 'dir') {
    const reason =
      source === 'env'
        ? `engine dir from ${ENGINE_ENV} is missing or not a directory (env-set-but-missing): ${engineDir}`
        : `engine not installed at ${engineDir}`;
    return { ok: false, reason, dir: engineDir };
  }

  // The validator does an UNGUARDED read of the candidate's SKILL.md for its version source, so a
  // corrupt engine (e.g. SKILL.md is a directory → EISDIR) makes validateManifest THROW. Treat any
  // validator throw as `invalid` so the failure still flows through readEngineFragment's stable
  // "methodology engine not found/invalid" message + install command — never a raw fs error.
  const report = (() => {
    try {
      return validate(engineDir);
    } catch (err) {
      return { result: 'invalid', errors: [`validator threw: ${err?.message ?? err}`] };
    }
  })();
  const fragmentPresent = statType(join(engineDir, fragmentRel)) === 'file';
  const ok =
    report.result === VALID &&
    report.kind === 'methodology-engine' &&
    report.name === EXPECTED_ENGINE_NAME &&
    report.available !== false &&
    fragmentPresent;
  const reason = ok
    ? 'engine manifest valid (kind: methodology-engine) and the live fragment is present'
    : report.result !== VALID
      ? `engine manifest ${report.result} at ${engineDir}`
      : report.kind !== 'methodology-engine'
        ? `engine manifest kind "${report.kind}" is not methodology-engine`
        : report.name !== EXPECTED_ENGINE_NAME
          ? `engine manifest name "${report.name}" is not "${EXPECTED_ENGINE_NAME}"`
          : report.available === false
            ? 'engine manifest is a declared stub (available:false)'
            : `engine fragment missing (${fragmentRel})`;
  return { ok, reason, dir: engineDir };
};

// Read the bounded methodology fragment LIVE from the installed engine. Returns the fragment string
// on the happy path; THROWS a loud Error naming the resolved dir + the reason + the exact
// remediation on absent/invalid/unreadable — never a fallback (fail-closed). The "methodology engine
// not found/invalid" prefix is a stable contract: the agent classifies the reconcile STOP by it
// (distinct from the cap-skip message), so do not reword it without updating the upgrade mode file
// (references/modes/upgrade.md, step 3 exit classification).
export const readEngineFragment = (engineDir, deps = {}) => {
  const detection = detectEngine(engineDir, { source: deps.source, rel: deps.rel }, deps);
  const installHint = `npx @sabaiway/agent-workflow-engine@latest init  (or set ${ENGINE_ENV})`;
  if (!detection.ok) {
    throw new Error(`methodology engine not found/invalid at ${engineDir} (${detection.reason}) — install it: ${installHint}`);
  }
  const read = deps.readFileSync ?? readFileSync;
  try {
    return read(join(engineDir, deps.rel ?? ENGINE_FRAGMENT_REL), 'utf8');
  } catch (err) {
    throw new Error(
      `methodology engine not found/invalid at ${engineDir} (fragment unreadable: ${err.message}) — install it: ${installHint}`,
    );
  }
};
