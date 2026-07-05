#!/usr/bin/env node
// family-registry.mjs — the unified, kit-owned registry over EVERY agent-workflow family member.
//
// Until now "who the members are" was split across three disjoint kit-owned tables: KNOWN_BACKENDS
// (the 2 bridges, detect-backends.mjs), KIT_OWN_PATHS/KNOWN_FOOTPRINT (the hidden-mode paths,
// known-footprint.mjs), and the 5 per-member capability.json files. This module is the single
// authoritative aggregation: it answers "what is installed, what version, what kind" (the SKILL
// axis) and "what is deployed in this project" (the deploy axis). It is the substrate the read-only
// `/agent-workflow-kit status` mode and the guarded `/agent-workflow-kit uninstall` both consume.
//
// Source of truth = the in-tool FAMILY_MEMBERS table (the AD-008 KNOWN_BACKENDS precedent): a member
// that is NOT installed has no manifest on disk to read, so the enumeration + detect/install facts
// must live here. A drift-guard test (family-registry.test.mjs) pins FAMILY_MEMBERS to the 5 in-repo
// capability.json files, so the table cannot silently drift from the manifests it mirrors.
//
// Pure, dependency-injectable (fs/env/home/validator are deps), dependency-free, Node >= 18. No
// side effects on import (the isDirectRun idiom) — tests import the helpers with nothing run.

import { existsSync, statSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';
import { resolveDir, detectBackends, findOnPath } from './detect-backends.mjs';
// The ONE dependency-free semver (shared with bin/install.mjs) — the bridge freshness probe compares
// the placed version against the kit-bundled mirror; null-on-unparseable maps to 'unknown' (INV-B).
import { parseSemver, compareSemver } from './semver-lite.mjs';
import { validateManifest, readAuthoritativeVersion, UNSUPPORTED, INVALID } from './manifest/validate.mjs';
import { START_MARKER, excludePath, inferVisibility } from './hide-footprint.mjs';
import { readEngineFragment, ORCHESTRATION_FRAGMENT_REL, PROCEDURES_FRAGMENT_REL, LENS_FRAGMENT_REL, LENS_PRIORS_REL } from './engine-source.mjs';
import { ACTIVITIES, resolveActivityRecipe } from './recipes.mjs';
// The config reader lives in orchestration-config.mjs (the single config contract). The read-only status
// settings-survey reuses THIS reader (one strict-JSON + loud-on-malformed contract), not a second copy.
import { loadConfig } from './orchestration-config.mjs';
// The deployment-lineage head + the shared settings readers are reused from velocity-profile so the
// `--json` envelope/settings-survey has ONE implementation each, never a drifting copy:
//   EXPECTED_WORKFLOW_VERSION — the head literal (drift-guarded vs memory LINEAGE_HEAD)
//   readSettingsFile / resolveEffectiveMode — the loud `.claude/settings.*` reader + mode precedence
// (No import cycle: velocity-profile / recipes / procedures import only node builtins + siblings, none
// import family-registry, and none has a side effect on import — every CLI is isDirectRun-guarded.)
import {
  EXPECTED_WORKFLOW_VERSION,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  readSettingsFile,
  resolveEffectiveMode,
} from './velocity-profile.mjs';
// The gate-hook writer's own wired-detection + placed path — reused by the settings survey (one
// implementation; gate-hook imports only node builtins + velocity-profile, so no cycle).
import { HOOK_FILE_REL as GATE_HOOK_FILE_REL, isHookWired } from './gate-hook.mjs';
// The host-level bridge-settings snapshot (fact-only, best-effort). The READ-ONLY core (never the
// writer, which pulls in the atomic-write core) so the status survey stays a pure reader.
import { settingsSnapshot } from './bridge-settings-read.mjs';
import { GATES_REL, loadDeclaration } from './run-gates.mjs';
// The cheap-agents writer's own bundle reader + placement planner — reused by the settings survey
// (one implementation, never a drifting copy; cheap-agents imports only node builtins, no cycle).
import { readBundledAgents, planPlacement } from './cheap-agents.mjs';
// The status vocabulary (manifestState constants, internal→public maps, display names, the no-leak
// forbidden set) lives in the frozen labels.mjs LEAF (Plan §4.2 B1) so the import graph is acyclic —
// nothing imports family-registry for vocabulary. Imported here for internal use; the public subset is
// re-exported below.
import {
  NOT_INSTALLED,
  UNSUPPORTED_SCHEMA,
  INVALID_MANIFEST,
  STUB,
  FOREIGN,
  OK,
  UNKNOWN,
  STATE_PUBLIC,
  VISIBILITY_PUBLIC,
  DISPLAY_NAMES,
  displayOf,
  FRESH_CURRENT,
  FRESH_BEHIND,
  FRESH_UNKNOWN,
  FRESH_NOT_CHECKED,
} from './labels.mjs';
// The capability-adaptive direct-CLI presenter (Plan §4.2/§4.5): the surface detector, the
// envelope→ViewModel transform, and the plain/ansi renderers. main() composes them; the agent-mediated
// `status` surface ignores them (it consumes --json). These are leaves — no import cycle.
import { detectSurface } from './surface.mjs';
import { toViewModel } from './view-model.mjs';
import { render } from './renderers.mjs';

// ── manifestState values — re-export the EXACT public subset family-registry exported before B1 ─────
// (the 7 state constants + DISPLAY_NAMES) so every existing importer (uninstall.mjs, the test suites)
// stays green. STATE_PUBLIC / VISIBILITY_PUBLIC / displayOf were private here and are NOT re-exported.
export {
  NOT_INSTALLED,
  UNSUPPORTED_SCHEMA,
  INVALID_MANIFEST,
  STUB,
  FOREIGN,
  OK,
  UNKNOWN,
  DISPLAY_NAMES,
};

// ── the unified registry ───────────────────────────────────────────────────────
// FAMILY_MEMBERS (+ isGlobalSkill) is the one authoritative member table. It moved to the
// dependency-free DATA LEAF family-members.mjs so the npx installer can derive its init-refresh cascade
// from the table WITHOUT importing this whole status/presenter graph (a leaner npx cold-start path).
// Re-exported here so every existing importer (uninstall.mjs, the test suites) stays green, and the
// drift-guard (family-registry.test.mjs) still pins the table to the 5 in-repo capability.json.
export { FAMILY_MEMBERS, isGlobalSkill } from './family-members.mjs';
import { FAMILY_MEMBERS } from './family-members.mjs';

// ── pure probes ──────────────────────────────────────────────────────────────────
// Wrapped marker probe → 'present' (a regular file) | 'absent' (ENOENT / not a regular file) |
// 'unknown' (a non-ENOENT fs error, e.g. EACCES). STAT-FIRST on purpose: `existsSync()` SWALLOWS an
// EACCES into a bare `false`, which would mask a permission error as 'absent' (a silent failure);
// `statSync` THROWS the EACCES so it surfaces as 'unknown'. 'unknown' is never collapsed to 'absent' —
// classifyMember reports it (uninstall then leaves the dir alone) and the memory caveat skips it.
const probeMarker = (path, deps = {}) => {
  const stat = deps.stat ?? statSync;
  try {
    return stat(path).isFile() ? 'present' : 'absent';
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : 'unknown';
  }
};

// Pure manifestState classifier — the detect-backends precedence, generalized to a member's own
// expected name + kind: not-installed → unsupported-schema → invalid-manifest → stub → foreign → ok.
const classifyState = (markerPresent, report, member) => {
  if (!markerPresent) return NOT_INSTALLED;
  if (report.result === UNSUPPORTED) return UNSUPPORTED_SCHEMA;
  if (report.result === INVALID) return INVALID_MANIFEST;
  if (report.available === false) return STUB;
  if (report.kind !== member.kind || report.name !== member.name) return FOREIGN;
  return OK;
};

// ── the SKILL axis ─────────────────────────────────────────────────────────────
// classifyMember → { name, kind, installed, skillDir, manifestState, version }. Reuses resolveDir
// (detect-backends), validateManifest + readAuthoritativeVersion (the manifest validator) — one
// authoritative version reader, no second drifting source. `version` is set only for an `ok` member.
export const classifyMember = (member, deps = {}) => {
  const validate = deps.validate ?? validateManifest;
  const readVersion = deps.readVersion ?? readAuthoritativeVersion;
  const getenv = deps.getenv ?? process.env;
  const home = deps.home ?? os.homedir();

  const skillDir = resolveDir({ env: member.installed.env, default: member.installed.default }, getenv, home);
  const marker = probeMarker(join(skillDir, member.installed.file), deps);
  // A marker we cannot probe (EACCES/EIO) → 'unknown': reported, but NOT installed (so uninstall never
  // removes a dir whose ownership it could not verify). Distinct from 'not-installed' (genuinely absent).
  if (marker === 'unknown') {
    return { name: member.name, kind: member.kind, installed: false, skillDir, manifestState: UNKNOWN, version: null };
  }
  const markerPresent = marker === 'present';
  const report = markerPresent ? validate(skillDir) : { result: NOT_INSTALLED };
  const manifestState = classifyState(markerPresent, report, member);
  const installed = manifestState !== NOT_INSTALLED;
  // Crash-safe version read: readAuthoritativeVersion THROWS on a present-but-unreadable SKILL.md
  // (stat needs no read permission, readFileSync does — a TOCTOU/EACCES window after validate).
  // The read-only survey must never crash on it: degrade to null, which the bridge freshness probe
  // then reports as 'unknown' (INV-B), never as a throw and never as a silent claim.
  const version = (() => {
    if (manifestState !== OK) return null;
    try {
      return readVersion(skillDir).version ?? null;
    } catch {
      return null;
    }
  })();

  return { name: member.name, kind: member.kind, installed, skillDir: installed ? skillDir : null, manifestState, version };
};

// An installed engine may be a VALID methodology-engine yet too old (or incomplete) to ship one of the
// kit's live-read fragments: `references/orchestration-slot.md` (the recipes pointer, engine >= 1.2.0)
// and `references/procedures.md` (the activity-procedures canon, engine >= 1.3.0). Each missing
// fragment is a DISTINCT, plain-language caveat. They are collected into `row.caveats` (an ARRAY) so an
// engine missing BOTH surfaces both — a single `row.caveat` would overwrite one with the other. The
// check mirrors what each consumer actually does — `readEngineFragment(..., { rel })` validates
// the manifest AND reads the fragment — so an absent, non-file, OR present-but-unreadable fragment all
// surface (status never claims "ok" for a fragment a reconcile / the procedures CLI would STOP on), and
// a current, readable fragment never gets the caveat. Read-only, best-effort.
// Each caveat names the rel(s) its consumer actually needs: the lens reconcile requires the
// fragment AND its prior store as a PAIR (lens-region soft-skips when either is missing), so its
// caveat keys on both — an engine missing only the prior store must never report healthy.
const ENGINE_FRAGMENT_CAVEATS = [
  { rels: [ORCHESTRATION_FRAGMENT_REL], caveat: 'engine present but does not supply the recipes pointer (too old / incomplete) — run `npx @sabaiway/agent-workflow-engine@latest init`' },
  { rels: [PROCEDURES_FRAGMENT_REL], caveat: 'engine present but does not ship the activity-procedures canon (too old / incomplete) — run `npx @sabaiway/agent-workflow-engine@latest init`' },
  { rels: [LENS_FRAGMENT_REL, LENS_PRIORS_REL], caveat: 'engine present but does not ship the agent-rules lens canon (the fragment + its prior store; too old / incomplete — engine >= 1.13.0) — run `npx @sabaiway/agent-workflow-engine@latest init`' },
];

// The orchestration-config TEMPLATE a current memory ships (added in memory 1.2.0; absent in older
// installs such as v1.0.0). It is the SAME asset Step 2.4 adds to delegation.mjs's
// REQUIRED_MEMORY_ASSETS: the read-only note here INFORMS, the delegation gate ACTS. Step 2.4 also
// adds a parity drift-guard tying this path to that required-asset set, so the note and the gate can
// never key on different files (until then they are kept in lockstep by review).
export const MEMORY_ORCH_TEMPLATE_REL = 'references/templates/orchestration.json';
// Worded as an honest OBSERVATION, not a diagnosis (absence can mean old OR incomplete), and it makes
// NO claim about an orchestration.json seeding outcome (that depends on delegate-vs-fallback).
const MEMORY_BEHIND_NOTE =
  "the memory installed here doesn't include the current orchestration template — refresh it with `npx @sabaiway/agent-workflow-memory@latest init`, then restart the session.";

// ── the bridge freshness probe (deterministic-first — INV-A / INV-B) ─────────────
// The bridges are not npm packages: their ONLY delivery channel is the copy bundled inside this kit
// (`bridges/<name>/`, placed by `/agent-workflow-kit setup`). A placed bridge therefore has exactly
// one authoritative freshness comparison — its installed version (readAuthoritativeVersion, already
// on the row) vs the kit-bundled mirror's capability.json. BOTH are local files, so the "never
// checks npm" invariant holds. The probe sets the internal row field `freshness`
// ('behind' | 'current' | 'unknown'); refreshOf derives the public refresh block STRUCTURALLY from
// that field (INV-2 — never parsed from caveat text). INV-B: an unreadable/unparseable version on
// EITHER side degrades to 'unknown' + a plain-language note — never a false claim in either direction.
const __dirname = dirname(fileURLToPath(import.meta.url));
// bridges/ ships beside tools/ in both the repo and the installed kit (the setup-backends.mjs
// resolution), so this resolves in both. Injectable via deps.bundleRoot for tests.
const BUNDLE_ROOT = resolve(__dirname, '..', 'bridges');

// Crash-safe on the bundled side: an absent / unreadable / malformed bundle manifest → null (INV-B
// 'unknown'), never a throw — the read-only survey must survive a broken kit install.
const readBundledBridgeVersion = (name, deps = {}) => {
  const read = deps.readFile ?? readFileSync;
  const root = deps.bundleRoot ?? BUNDLE_ROOT;
  try {
    const manifest = JSON.parse(String(read(join(root, name, 'capability.json'), 'utf8')));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
};

const bridgeBehindNote = (display, placed, bundled) =>
  `the ${display} installed here (v${placed}) is older than the copy bundled with this kit (v${bundled}) — refresh it with \`/agent-workflow-kit setup\`.`;
// The recovery differs per failing SIDE: `setup` re-places FROM the bundle, so it can repair an
// unreadable INSTALLED copy but can never repair an unreadable BUNDLED copy — that needs a kit
// refresh first (the npx installer), then `setup`.
const bridgeUnknownNote = (display, side, recovery) =>
  `couldn't compare the ${display} installed here with the copy bundled with this kit (${side}), so its freshness is unknown — ${recovery}.`;
const UNKNOWN_SIDES = Object.freeze({
  placed: {
    side: 'the installed copy has no readable version',
    recovery: '`/agent-workflow-kit setup` re-places the bundled copy',
  },
  bundled: {
    side: "the kit's bundled copy has no readable version",
    recovery: 'refresh the kit first (`npx @sabaiway/agent-workflow-kit@latest init`), then `/agent-workflow-kit setup`',
  },
});

export const surveyFamily = (deps = {}) =>
  FAMILY_MEMBERS.map((member) => {
    const row = classifyMember(member, deps);
    if (row.kind === 'methodology-engine' && row.manifestState === OK && row.skillDir) {
      const fragmentUsable = (rel) => {
        try {
          readEngineFragment(row.skillDir, { source: 'default', rel, ...deps });
          return true;
        } catch {
          return false; // absent / non-file / unreadable fragment → the engine can't supply it
        }
      };
      const caveats = ENGINE_FRAGMENT_CAVEATS.filter((f) => !f.rels.every(fragmentUsable)).map((f) => f.caveat);
      if (caveats.length) row.caveats = caveats;
    }
    // Memory offline caveat (Step 2.2): a distinct probe — the orchestration TEMPLATE file's existence.
    // Only attach when it is provably ABSENT (a non-ENOENT probe error → 'unknown' → skip, never a
    // false "missing" claim). Mirrors the engine-caveat SHAPE; keyed on the Step-2.4 required asset.
    if (row.kind === 'memory-substrate' && row.manifestState === OK && row.skillDir) {
      const templateProbe = probeMarker(join(row.skillDir, MEMORY_ORCH_TEMPLATE_REL), deps);
      if (templateProbe === 'absent') {
        row.caveats = [...(row.caveats ?? []), MEMORY_BEHIND_NOTE];
      } else if (templateProbe === 'unknown') {
        // Could not verify → this row must not be counted "checked, current" by the verdict (INV-B).
        row.freshness = FRESH_UNKNOWN;
      }
    }
    // Bridge freshness probe (INV-A / INV-B): only for a provably-OURS placed bridge (manifestState
    // OK). Compares two LOCAL files; a non-OK / absent bridge is out of scope ('not-checked').
    if (row.kind === 'execution-backend' && row.manifestState === OK && row.skillDir) {
      const bundled = readBundledBridgeVersion(row.name, deps);
      const cmp = compareSemver(row.version, bundled);
      if (cmp === null) {
        const { side, recovery } = parseSemver(row.version) === null ? UNKNOWN_SIDES.placed : UNKNOWN_SIDES.bundled;
        row.freshness = FRESH_UNKNOWN;
        row.caveats = [...(row.caveats ?? []), bridgeUnknownNote(displayOf(row.name), side, recovery)];
      } else if (cmp < 0) {
        row.freshness = FRESH_BEHIND;
        row.caveats = [...(row.caveats ?? []), bridgeBehindNote(displayOf(row.name), row.version, bundled)];
      } else {
        // Equal OR newer-than-bundled → not behind. A newer placed bridge is a Phase-2 concern for
        // the refresh DRIVER (INV-D never-downgrade skip); the read-only status axis never flags it.
        row.freshness = FRESH_CURRENT;
      }
    }
    return row;
  });

// ── the DEPLOY axis ──────────────────────────────────────────────────────────────
// Read a one-line semver stamp (docs/ai/.workflow-version etc.). Returns the trimmed version or null.
const readStamp = (path, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const read = deps.readFile ?? readFileSync;
  try {
    if (!exists(path)) return null;
    const v = String(read(path, 'utf8')).trim();
    return v.length ? v : null;
  } catch {
    return null;
  }
};

// Is our hidden-mode managed fence present? Resolve the exclude file via the SAME git-path-aware path
// hide-footprint uses (`git rev-parse --git-path info/exclude`), so a linked worktree / submodule is
// handled correctly (not the hardcoded `.git/info/exclude`). If git is unavailable or this is not a
// repo, fall back to the conventional path; any read error → not present (best-effort, read-only).
const hasHiddenFence = (projectDir, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const read = deps.readFile ?? readFileSync;
  const ep = (() => {
    try {
      return excludePath(deps, projectDir);
    } catch {
      return join(projectDir, '.git', 'info', 'exclude');
    }
  })();
  try {
    return exists(ep) && String(read(ep, 'utf8')).includes(START_MARKER);
  } catch {
    return false;
  }
};

// surveyProject → the deploy axis for a target project dir: the per-member deployment stamps, whether
// docs/ai/ exists, and whether the hidden-mode fence is present. Pure (fs reads only, all injectable),
// no git subprocess — the read-only `status` view must never mutate or spawn anything.
export const surveyProject = (projectDir, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const dir = resolve(projectDir);
  const stamps = FAMILY_MEMBERS
    .filter((m) => m.deployed)
    .map((m) => ({ name: m.name, file: m.deployed.file, version: readStamp(join(dir, m.deployed.file), deps) }));
  const docsAiPresent = (() => {
    try {
      return exists(join(dir, 'docs', 'ai'));
    } catch {
      return false;
    }
  })();
  const deployed = stamps.some((s) => s.version != null) || docsAiPresent;
  return { dir, deployed, docsAiPresent, hiddenFence: hasHiddenFence(dir, deps), stamps };
};

// ── report ───────────────────────────────────────────────────────────────────────
// The direct-CLI human render (formatStatus + formatSettings) was REPLACED by the capability-adaptive
// presenter pipeline (surface → view-model → renderers, Plan §4.2/§4.5): main() builds the no-leak
// envelope once, then renders it via toViewModel + render (plain/ansi) or prints it as JSON. ONE data
// source for both surfaces — the agent-mediated `status` consumes `--json`, the direct CLI renders it.

// ── the no-leak --json envelope ──────────────────────────────────────────────────
// A machine-readable view with USER-SAFE field names only — NEVER the internal manifestState /
// hiddenFence terms or the raw stamp FILENAMES. The render (SKILL.md version block + Mode: status)
// consumes THIS, never the human table verbatim. An envelope-shape test pins its shape so later phases
// (the settings/visibility block) can't silently break the Phase-2 version consumer.

// STATE_PUBLIC (internal→public token map) + DISPLAY_NAMES + displayOf now live in labels.mjs (B1) —
// imported at the top of this file. They are used below exactly as before.

// ── the settings survey (Phase 3) — read-only, honest, localized-on-error ──────────
// Each sub-survey returns a small user-safe object OR a single `{ error }` field (a localized message,
// never a crash): a malformed/unreadable file in ONE area must not break the rest of `status`. The
// readers are REUSED (one implementation each): loadConfig (procedures.mjs), readSettingsFile /
// resolveEffectiveMode (velocity-profile.mjs), resolveActivityRecipe (recipes.mjs), inferVisibility
// (hide-footprint.mjs). Engine-free throughout (the effective-recipe view never reads the engine).

// A localized, user-safe error string. The reused readers already build cwd-relative `path: reason`
// messages (loadConfig / velocity), so this just normalizes to a string — never a raw stack/abs path.
const localizeError = (err) => (err && err.message ? String(err.message) : String(err));

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// The backend detector is a SECONDARY input to the survey — a corrupt bridge must never break the
// read-only view, but the failure must NOT be silent (Hard Constraint). Run it defensively: a throw →
// { detection: [], error: <localized> } so callers floor gracefully (recipes → solo, bridges →
// 'unknown') AND can surface the concrete reason. Returns a value so callers stay `const`.
const detectSafe = (deps) => {
  try {
    return { detection: (deps.detect ?? detectBackends)(deps), error: null };
  } catch (err) {
    return { detection: [], error: localizeError(err) };
  }
};

// visibility: the THREE honest states from inferVisibility (NOT the single hiddenFence bit) → user-safe
// words (VISIBILITY_PUBLIC, from labels.mjs). Never the internal "hidden fence" / marker terms. A
// git/probe error → a localized error field.
export const surveyVisibility = (dir, deps = {}) => {
  try {
    const vis = inferVisibility(deps, resolve(dir));
    return { state: VISIBILITY_PUBLIC[vis.visibility] ?? 'unclear' };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// orchestration recipes: the EFFECTIVE recipe per slot (config · default · effective), engine-free —
// shared loadConfig + resolveActivityRecipe + the read-only backend detector. A malformed config → a
// localized error field; a detection failure floors at solo (a corrupt bridge must not break the view).
export const surveyRecipes = (dir, deps = {}) => {
  // A detector failure floors recipes at solo (mirrors procedures) but is surfaced as `detectError`, so
  // the render says "couldn't check backends" instead of letting a real solo-default look identical.
  const { detection, error: detectError } = detectSafe(deps);
  try {
    const { config, source } = loadConfig(resolve(dir), deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const activities = {};
    for (const [activity, def] of Object.entries(ACTIVITIES)) {
      activities[activity] = {};
      for (const slot of Object.keys(def.slots)) {
        const r = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity, slot });
        activities[activity][slot] = { recipe: r.recipe, source: r.source, degradedFrom: r.degradedFrom ?? null };
      }
    }
    return { configSource: source, activities, ...(detectError ? { detectError } : {}) };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// attribution: includeCoAuthoredBy across .claude/settings.json + settings.local.json as
// project · local override · effective (local WINS only when it actually sets the key — presence-based,
// mirroring resolveEffectiveMode). Reuses the loud readSettingsFile; the precedence read is new code.
export const surveyAttribution = (dir, deps = {}) => {
  try {
    const d = resolve(dir);
    const project = readSettingsFile(join(d, SETTINGS_FILE), { ...deps, cwd: d });
    const local = readSettingsFile(join(d, SETTINGS_LOCAL_FILE), { ...deps, cwd: d });
    const projVal = project.present && hasOwn(project.data, 'includeCoAuthoredBy') ? project.data.includeCoAuthoredBy : null;
    const localHasKey = local.present && hasOwn(local.data, 'includeCoAuthoredBy');
    const localVal = localHasKey ? local.data.includeCoAuthoredBy : null;
    return { project: projVal, local: localVal, effective: localHasKey ? localVal : projVal };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// velocity: the effective permissions.defaultMode (local > project, via resolveEffectiveMode) + the
// per-source count of allowlist entries — a read-only view of what the velocity profile may have seeded.
export const surveyVelocity = (dir, deps = {}) => {
  try {
    const d = resolve(dir);
    const project = readSettingsFile(join(d, SETTINGS_FILE), { ...deps, cwd: d });
    const local = readSettingsFile(join(d, SETTINGS_LOCAL_FILE), { ...deps, cwd: d });
    const { effectiveMode } = resolveEffectiveMode(project.data, local.data);
    const allowOf = (s) => (s.present && Array.isArray(s.data?.permissions?.allow) ? s.data.permissions.allow.length : 0);
    return { defaultMode: effectiveMode ?? null, allowEntries: { project: allowOf(project), local: allowOf(local) } };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// gate hook: the opt-in PreToolUse gate-approval hook (Mode: hook) — wired (the settings entry, in
// EITHER settings file: the hooks contract merges both), the placed hook file, and the gate
// declaration it consumes. Read-only; the wired-detection is REUSED from the writer (gate-hook.mjs
// isHookWired — one implementation, never a drifting copy).
export const surveyGateHook = (dir, deps = {}) => {
  try {
    const d = resolve(dir);
    const exists = deps.exists ?? existsSync;
    const project = readSettingsFile(join(d, SETTINGS_FILE), { ...deps, cwd: d });
    const local = readSettingsFile(join(d, SETTINGS_LOCAL_FILE), { ...deps, cwd: d });
    // How many gates are actually DECLARED — the welcome-mat hook rung keys on a non-empty
    // declaration (a fresh bootstrap seeds gates.json EMPTY, so file presence alone would misfire).
    // 0 = absent or empty list; null = present but unreadable/malformed (unknown — never a false
    // count, and never an area-wide error: the wired/placed probes still report; the validation
    // REASON is preserved beside the null so status never renders a bare question mark).
    const declaration = (() => {
      try {
        const res = loadDeclaration(d, deps);
        return { declaredGates: res.outcome === 'loaded' ? res.gates.length : 0 };
      } catch (err) {
        return { declaredGates: null, declarationError: localizeError(err) };
      }
    })();
    return {
      wired: isHookWired(project.data) || isHookWired(local.data),
      filePlaced: Boolean(exists(join(d, GATE_HOOK_FILE_REL))),
      declarationPresent: Boolean(exists(join(d, GATES_REL))),
      ...declaration,
    };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// cheap agents: the kit-placed .claude/agents/ vehicles (Mode: agents) — how many of the bundled
// cheap-lane definitions are present in the project. A customized copy counts as PLACED (it exists;
// the writer preserves it) — the welcome-mat agents rung keys on zero placed. Read-only; REUSES the
// writer's own bundle reader + placement planner (cheap-agents.mjs — one implementation).
export const surveyCheapAgents = (dir, deps = {}) => {
  try {
    const templates = readBundledAgents(deps);
    const plan = planPlacement(templates, resolve(dir), deps);
    return { bundled: templates.length, placed: plan.filter((p) => p.action !== 'place').length };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// the project-scoped settings survey (needs a project dir). Each area is independently localized-on-error.
export const surveySettings = (dir, deps = {}) => ({
  recipes: surveyRecipes(dir, deps),
  attribution: surveyAttribution(dir, deps),
  velocity: surveyVelocity(dir, deps),
  agents: surveyCheapAgents(dir, deps),
  hook: surveyGateHook(dir, deps),
});

// bridges: HOST-scoped (no project needed). Wrapper command NAMES come from FAMILY_MEMBERS[].wrapperCmds
// (static, always present), their PATH-presence is probed DIRECTLY via findOnPath over those names (NOT
// detect-backends' wrappers[], which is [] when the bridge isn't ok — the onboarding case), and the
// readiness summary comes from the detector. NO default-model claim (a negative drift-guard asserts it).
export const surveyBridges = (deps = {}) => {
  const { detection } = detectSafe(deps); // a detector failure → every readiness reads 'unknown' (honest)
  const probe = deps.findOnPath ?? findOnPath;
  // Host-level bridge settings, read ONCE (best-effort — never throws; a corrupt bundle/fs error → error).
  const snapshot = settingsSnapshot(deps);
  return FAMILY_MEMBERS.filter((m) => m.kind === 'execution-backend').map((m) => {
    const det = detection.find((d) => d.name === m.name);
    // Preserve findOnPath's THREE-state result (present | missing | unknown): an `unknown` (EACCES,
    // "cannot confirm") must stay distinct from a real `missing` — never flattened to a false boolean.
    const wrappers = m.wrapperCmds.map((cmd) => ({ cmd, state: probe(cmd, deps).state }));
    // Fact-only: the settings knobs ACTIVE (env/file, non-default) for THIS bridge. Model/effort are
    // structurally absent from the registry, so this can NEVER carry a model claim (the survey's
    // no-default-model-claim invariant). Localized-on-error like every other survey.
    const settings = snapshot.error
      ? { error: snapshot.error }
      : { active: snapshot.active.filter((a) => a.bridge === m.name) };
    return { member: m.name, display: displayOf(m.name), readiness: det?.readiness ?? 'unknown', wrappers, settings };
  });
};

// INV-2 (structural refresh — additive, derived, never parsed from a caveat string), per KIND:
//   • memory / engine (REFRESHABLE_KINDS): `behind` ⟷ an OK row carrying a refresh-recommending
//     caveat (surveyFamily attaches caveats to those kinds only then, and every such caveat is
//     refresh-recommending); `recommend` is composed from FAMILY_MEMBERS[].npm — never the caveat text.
//   • execution-backend: `behind` ⟷ the bridge freshness probe's row field (freshness === 'behind');
//     `recommend` is composed PER-KIND — bridges have npm:null (placed by `setup`, never npx), so the
//     runnable recovery is `/agent-workflow-kit setup`, never an npx composition.
//   • composition-root (the kit): no freshness probe exists on this surface (the two-axes doctrine —
//     kit freshness is the npx installer's axis) → never behind, 'not-checked'.
// `freshness` is the checked-vs-unknown signal the zero-behind verdict scopes itself with (INV-C):
// behind:false alone cannot distinguish "checked, current" from "could not be checked".
const REFRESHABLE_KINDS = new Set(['memory-substrate', 'methodology-engine']);
const npmOf = (name) => FAMILY_MEMBERS.find((m) => m.name === name)?.npm ?? null;
export const BRIDGE_REFRESH_RECOMMEND = '/agent-workflow-kit setup';
const refreshOf = (m) => {
  if (m.kind === 'execution-backend') {
    const freshness = m.freshness ?? FRESH_NOT_CHECKED;
    const behind = freshness === FRESH_BEHIND;
    return { behind, recommend: behind ? BRIDGE_REFRESH_RECOMMEND : null, freshness };
  }
  const behind = REFRESHABLE_KINDS.has(m.kind) && Boolean(m.caveats?.length);
  const freshness = REFRESHABLE_KINDS.has(m.kind) && m.manifestState === OK
    ? m.freshness ?? (behind ? FRESH_BEHIND : FRESH_CURRENT)
    : FRESH_NOT_CHECKED;
  return { behind, recommend: behind ? `npx ${npmOf(m.name)}@latest init` : null, freshness };
};

export const buildEnvelope = (family, project = null, extras = {}) => {
  const installed = family.map((m) => {
    const entry = {
      member: m.name,
      display: displayOf(m.name),
      version: m.version ?? null,
      state: STATE_PUBLIC[m.manifestState] ?? STATE_PUBLIC[UNKNOWN],
    };
    if (m.caveats?.length) entry.notes = m.caveats; // plain-language observations (Steps 2.2 / engine)
    entry.refresh = refreshOf(m); // additive (INV-1): always present; { behind, recommend, freshness } (INV-2)
    return entry;
  });
  const envelope = { deploymentHead: EXPECTED_WORKFLOW_VERSION, installed };
  if (extras.bridges) envelope.bridges = extras.bridges; // HOST-scoped (no project needed)
  if (project) {
    envelope.project = {
      dir: project.dir,
      deployed: project.deployed,
      docsAi: project.docsAiPresent,
      // member + display + version only — never the internal stamp FILENAME (s.file).
      deployStamps: project.stamps.map((s) => ({ member: s.name, display: displayOf(s.name), version: s.version ?? null })),
    };
    // project-scoped Phase-3 additions (visibility from inferVisibility, not the hiddenFence bit).
    if (extras.visibility) envelope.project.visibility = extras.visibility;
    if (extras.settings) envelope.project.settings = extras.settings;
  }
  return envelope;
};

// ── CLI ────────────────────────────────────────────────────────────────────────
// Parse contract (Plan §4.5, grounded): the old parseArgs SILENTLY ignored unknown args + a missing
// --dir value. With the explicit format surface added, the parse now rejects LOUDLY (no silent
// failure): an unknown flag, a `--dir` with no value, and an invalid `--format` (validated by
// resolveFormat) all throw. `--json` vs `--format=*` precedence is deterministic (last-wins, in
// surface.mjs). Returns only { dir } — help is handled first, the format/mode comes from the surface.
const HELP_FLAGS = new Set(['--help', '-h']);
// --dir and --format carry/consume a value, so they are handled explicitly below — only the valueless
// flags live in KNOWN_FLAGS.
const KNOWN_FLAGS = new Set(['--help', '-h', '--json']);
// Single left-to-right pass (functional reduce, no `let`): EVERY `--dir` must carry a value — a
// trailing or REPEATED `--dir` with no value rejects loudly, never silently (a first-occurrence-only
// check let `--dir /p --dir` slip through as a "known flag"). The token right after a `--dir` is its
// value (skipped), so a path is never mistaken for an unknown flag; the last `--dir` wins.
export const parseArgs = (argv) => {
  const { dir } = argv.reduce(
    (state, a, i) => {
      if (state.skip) return { dir: state.dir, skip: false }; // this token was the preceding --dir value
      if (a === '--dir') {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) {
          throw new Error('[agent-workflow-kit] --dir needs a value: --dir <project>');
        }
        return { dir: value, skip: true }; // consume the value; last --dir wins
      }
      if (KNOWN_FLAGS.has(a) || a === '--format' || a.startsWith('--format=')) return state;
      throw new Error(`[agent-workflow-kit] unknown argument: ${a}`);
    },
    { dir: undefined, skip: false },
  );
  return { dir };
};

const HELP = `family-registry — read-only view of the agent-workflow family.

Usage:
  node family-registry.mjs [--dir <project>] [--format=<auto|plain|ansi|json>] [--json]
    # skill axis always; deploy axis when --dir is given.
    # --format: auto (default — ansi on a TTY, plain otherwise) | plain | ansi | json.
    #   --json is sugar for --format=json (the no-leak machine envelope). AGENT_WORKFLOW_FORMAT
    #   sets the default; a flag beats it. Width/color follow the terminal (NO_COLOR / FORCE_COLOR).

Detection only — never writes, never commits, never runs a subscription CLI.`;

const main = (argv) => {
  if (argv.some((a) => HELP_FLAGS.has(a))) {
    console.log(HELP);
    return;
  }
  // Validate args + resolve the output surface BEFORE any survey work; a bad flag/format → loud exit 1.
  const args = (() => {
    try {
      const parsed = parseArgs(argv);
      const surface = detectSurface({
        argv,
        env: process.env,
        isTTY: Boolean(process.stdout.isTTY),
        columns: process.stdout.columns,
        platform: process.platform,
      });
      return { ...parsed, surface };
    } catch (err) {
      console.error(err?.message ?? String(err));
      process.exit(1);
    }
  })();

  const family = surveyFamily();
  const bridges = surveyBridges();
  const project = args.dir ? surveyProject(args.dir) : null;
  const extras = { bridges };
  if (args.dir) {
    extras.visibility = surveyVisibility(args.dir);
    extras.settings = surveySettings(args.dir);
  }
  const envelope = buildEnvelope(family, project, extras);
  // Two surfaces, one data source: JSON prints the envelope verbatim; plain/ansi render it through the
  // capability-adaptive presenter pipeline (view-model → renderers). No-leak inherited from the envelope.
  console.log(args.surface.mode === 'json' ? JSON.stringify(envelope, null, 2) : render(toViewModel(envelope), args.surface));
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));
