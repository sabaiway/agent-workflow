// bridge-sandbox-recipe.mjs — the one reader of the bundled bridges' declared sandbox surfaces and
// the one derivation of the bridge tier (contract: bridges/velocity-profile, revision 4). The tier
// writer, the advisor's delta, the danger check and the autonomy preview read the same
// `bundledSandboxRecipe(usedBridges(...))`, so the four cannot drift.
//
// Dependency-free, Node >= 22. No side effects on import.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUNDLE_ROOT } from './bridge-settings-read.mjs';
import { ACTIVITIES, BACKEND_PRIORITY, REVIEW_CMD_ALIASES } from './carriers.mjs';
import { planRecipe, resolveActivityRecipe } from './recipes.mjs';
import { isReadyMember } from './review-roster-resolve.mjs';
import { isSeedablePathToken } from './repo-lex.mjs';

// The review wrappers, spelled bare as invoked. Only their `code` mode is auto-allowed: a bare
// `Bash(<wrapper>:*)` prefix would also cover the plan/diff file-argument modes, whose targets can
// point outside the repo, so those keep their prompt.
export const BRIDGE_REVIEW_WRAPPERS = Object.freeze(['codex-review', 'agy-review']);
export const BRIDGE_REVIEW_MODE = 'code';
// The grounding pre-step (agy's facts assembler), seeded in the EXACT quoted byte-form the
// procedures advisor renders, so seeded and rendered stay byte-equal.
export const KIT_GROUNDING_TOOL = 'tools/grounding.mjs';
const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GROUNDING_WRAPPER = 'agy-review';
// An exclusion is Bash rule syntax: a bare name matches only the argument-free command, so the
// tier writes `<wrapper> *`, which matches it with arguments.
export const exclusionOf = (wrapper) => `${wrapper} *`;

const ROLE_ORDER = Object.freeze(['review', 'execute']);
const SLOT_ROLE = Object.freeze({ review: 'review', execute: 'execute' });

// The bridges the project's recipes USE: every review slot and every execute-type slot of every
// activity, resolved to its EFFECTIVE recipe over the config and the readiness (a degraded recipe
// names what it degrades to; an absent config is the computed default). A ready provider has its
// wrapper on PATH, so used implies placed; a bridge no slot uses is absent however placed.
export const usedBridges = (config, readiness) => {
  const roles = new Map();
  const take = (bridge, role) => {
    if (!BACKEND_PRIORITY.includes(bridge)) return;
    if (!roles.has(bridge)) roles.set(bridge, new Set());
    roles.get(bridge).add(role);
  };
  for (const [activity, def] of Object.entries(ACTIVITIES)) {
    for (const [slot, type] of Object.entries(def.slots)) {
      const role = SLOT_ROLE[type];
      if (role === undefined) continue;
      const resolved = resolveActivityRecipe({ config: config ?? {}, readiness, activity, slot });
      if (resolved.roster) {
        for (const row of resolved.roster) {
          if (row.kind === 'bridge' && isReadyMember(row)) take(REVIEW_CMD_ALIASES[row.member].backend, role);
        }
        continue;
      }
      for (const step of planRecipe(resolved.recipe, readiness).dispatch) take(step.backend, role);
    }
  }
  return [...roles.keys()].sort().map((bridge) => ({
    bridge,
    roles: ROLE_ORDER.filter((role) => roles.get(bridge).has(role)),
  }));
};

// An array of review-wrapper NAMES (the sandbox-lane call) reads as review-role entries.
const rolesFor = (used, manifest) => {
  if (used.every((entry) => typeof entry === 'string')) {
    return used.includes(manifest?.roles?.review?.cmd) ? ['review'] : [];
  }
  return used.find((entry) => entry?.bridge === manifest?.name)?.roles ?? [];
};

const pushOnce = (list, value) => {
  if (!list.includes(value)) list.push(value);
};

// The surfaces of the used bridges over the bundled manifests, in manifest-name order, each list in
// its own order, a value already taken skipped.
export const bundledSandboxRecipe = (used, deps = {}) => {
  const readFile = deps.readFile ?? readFileSync;
  const readDir = deps.readdir ?? readdirSync;
  const bundleRoot = deps.bundleRoot ?? DEFAULT_BUNDLE_ROOT;
  const allow = [];
  const excludedCommands = [];
  const hosts = [];
  const dirEntries = [];
  const skips = [];
  for (const dir of [...readDir(bundleRoot)].sort()) {
    // An unreadable/unparsable bundled manifest must NOT thin the recipe silently — a partial
    // recipe rendered as complete is worse than none. The throw reaches the caller: a stated skip
    // in the advisor, a STOP with zero writes in the bridge tier.
    let manifest;
    try {
      manifest = JSON.parse(readFile(join(bundleRoot, dir, 'capability.json'), 'utf8'));
    } catch (err) {
      // ENOTDIR = the entry is a stray regular file (.DS_Store, a README), not a bridge bundle.
      if (err?.code === 'ENOTDIR') continue;
      throw new Error(`bundled manifest unreadable: ${join(dir, 'capability.json')} — ${err?.message ?? err}`);
    }
    const roles = rolesFor(used, manifest);
    if (roles.length === 0) continue;
    for (const role of roles) {
      const cmd = manifest?.roles?.[role]?.cmd;
      if (!cmd) continue;
      pushOnce(excludedCommands, exclusionOf(cmd));
      if (role !== 'review') continue;
      pushOnce(allow, `Bash(${cmd} ${BRIDGE_REVIEW_MODE}:*)`);
      if (cmd === GROUNDING_WRAPPER) {
        // groundingAbsPath binds the danger check's scope to the kit path it checks
        // (apply-danger-check.mjs) and lets a test build an unseedable path; the writer never passes it.
        const groundingAbs = deps.groundingAbsPath ?? join(KIT_ROOT, KIT_GROUNDING_TOOL);
        if (isSeedablePathToken(groundingAbs)) pushOnce(allow, `Bash(node "${groundingAbs}":*)`);
        else skips.push({
          entry: groundingAbs,
          reason: 'the kit path is not a POSIX absolute path free of spaces/metacharacters/quoting — the grounding pre-step rule is not seeded (its prompt stays); add a hand-picked entry if you accept the spelling',
        });
      }
    }
    if (Array.isArray(manifest.networkHosts)) for (const host of manifest.networkHosts) pushOnce(hosts, host);
    if (Array.isArray(manifest.writableDirs)) {
      for (const entry of manifest.writableDirs) {
        if (!dirEntries.some((taken) => JSON.stringify(taken) === JSON.stringify(entry))) dirEntries.push(entry);
      }
    }
  }
  return { allow, excludedCommands, hosts, dirEntries, skips };
};
